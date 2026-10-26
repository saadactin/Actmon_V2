"""Kubernetes and App Service rules.

No cluster exists in the connected accounts today, so these are exercised by
the test suite's fixtures; they are declared so a cluster that appears is
analysed on its first sweep. The node-utilization rule reads the AKS platform
metrics (node CPU and memory percentage), which need no agent. EKS node
metrics need Container Insights and are not collected — the cluster is shown
as not analysable rather than as healthy.
"""
from __future__ import annotations

from app.optimization.model import (
    AWS, AZURE, CHECK_PASS, CHECK_UNKNOWN, CLEANUP, CONF_HIGH, CONF_MEDIUM, CONFIRM_FIRST,
    EV_CONFIGURATION, FINDING, LOW, MEDIUM, OCI, RIGHTSIZING, RISK_LOW, RISK_MEDIUM,
    WITH_CARE, check, data_source, evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_UNDERUTILIZED, SIG_UNUSED, Ctx, Outcome, Rule, billed_evidence, billed_savings,
    billing_source, cfg_num, clear, insufficient, metric_evidence, metric_source,
    not_applicable, telemetry_gate,
)


def _empty_cluster(ctx: Ctx):
    t = ctx.resource.resource_type
    key = "node_pool_count" if t == "OKECluster" else "node_count"
    n = cfg_num(ctx.config, key)
    if n is None:
        return insufficient(f"The cluster's {key.replace('_', ' ')} was not collected.")
    if n > 0:
        return clear(f"{n:g} {'node pools' if t == 'OKECluster' else 'nodes'}.")
    sav = billed_savings(ctx, what="this cluster")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        title="Kubernetes cluster has no nodes",
        detail=f"{'No node pools' if t == 'OKECluster' else 'Zero nodes'}, so it runs no workloads.",
        recommendation="Delete the cluster if it was left over from testing.",
        evidence=[evidence("Node pools" if t == "OKECluster" else "Nodes", 0, kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Nodes": "0"}, recommended={"Action": "Delete"},
        savings=sav or no_savings(
            "The control-plane charge depends on the cluster's tier (AKS Free and OKE Basic "
            "clusters have none) and is not priced here."),
        confidence=CONF_HIGH, confidence_reasons=["Reported by the container service."],
        risk=RISK_LOW, risk_notes=["The cluster's configuration is lost; there are no workloads to lose."],
        impact={"cost": "Ends any control-plane charge.", "performance": "None.", "availability": "None."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [
            check("No nodes", CHECK_PASS)], "preconditions": ["Export any configuration worth keeping."]},
        data_sources=[data_source("nodes", "Node count", True), billing_source(ctx)],
    )


def _nodes_underutilized(ctx: Ctx):
    sources = [metric_source(ctx, "cpu_percent", "30-day node CPU"),
               metric_source(ctx, "memory_percent", "30-day node memory")]
    for m in ("cpu_percent", "memory_percent"):
        ok, why = telemetry_gate(ctx, m)
        if not ok:
            return insufficient(why, data_sources=sources)
    cpu = ctx.telemetry.stat("cpu_percent", "p95")
    mem = ctx.telemetry.stat("memory_percent", "p95")
    th = ctx.thresholds
    if cpu > th["underutilized_cpu_p95"] or mem > th["underutilized_memory_p95"]:
        return clear(f"Node CPU P95 {cpu:.1f}%, memory P95 {mem:.1f}%.")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNDERUTILIZED,
        title="Kubernetes nodes are underutilized",
        detail=f"Node CPU P95 {cpu:.1f}% and memory P95 {mem:.1f}% over 30 days.",
        recommendation=("Evaluate reducing node pool capacity, or enable the cluster autoscaler "
                        "so the pool shrinks when demand does."),
        evidence=[metric_evidence(ctx, "cpu_percent", "p95", "Node CPU P95"),
                  metric_evidence(ctx, "memory_percent", "p95", "Node memory P95"),
                  evidence("Nodes", cfg_num(ctx.config, "node_count"), kind=EV_CONFIGURATION)],
        current={"Nodes": str(ctx.config.get("node_count"))},
        savings=no_savings("Pod requests and limits are not collected, so how many nodes the "
                           "scheduler could release is not known."),
        confidence=CONF_MEDIUM,
        confidence_reasons=["Node utilization is measured; pod requests are not, and they decide "
                            "what can be scheduled."],
        risk=RISK_MEDIUM, risk_notes=["Removing nodes evicts pods; PodDisruptionBudgets apply."],
        impact={"cost": "Fewer node hours.", "performance": "Less headroom for bursts.",
                "availability": "Pods reschedule during scale-in."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [
            check("Pod requests fit on fewer nodes", CHECK_UNKNOWN, "Pod requests are not collected.")],
            "preconditions": ["Check pod requests against the remaining capacity first."]},
        data_sources=sources,
    )


def _app_service_plan(ctx: Ctx):
    sku = (ctx.config.get("sku") or "")
    if sku.upper().startswith(("F", "D")) and len(sku) <= 2:
        return not_applicable("Free or Shared tier.")
    sources = [metric_source(ctx, "cpu_percent", "30-day plan CPU"),
               metric_source(ctx, "memory_percent", "30-day plan memory"), billing_source(ctx)]
    for m in ("cpu_percent", "memory_percent"):
        ok, why = telemetry_gate(ctx, m)
        if not ok:
            return insufficient(why, data_sources=sources)
    cpu = ctx.telemetry.stat("cpu_percent", "p95")
    mem = ctx.telemetry.stat("memory_percent", "p95")
    th = ctx.thresholds
    if cpu > th["underutilized_cpu_p95"] or mem > th["underutilized_memory_p95"]:
        return clear(f"Plan CPU P95 {cpu:.1f}%, memory P95 {mem:.1f}%.")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNDERUTILIZED,
        title="App Service plan appears underutilized",
        detail=f"Plan CPU P95 {cpu:.1f}%, memory P95 {mem:.1f}% over 30 days ({sku}).",
        recommendation=("Evaluate a smaller pricing tier or fewer instances, or consolidate the "
                        "plan's apps onto another plan."),
        evidence=[metric_evidence(ctx, "cpu_percent", "avg", "CPU average"),
                  metric_evidence(ctx, "cpu_percent", "p95", "CPU P95"),
                  metric_evidence(ctx, "memory_percent", "p95", "Memory P95"),
                  evidence("Pricing tier", sku, kind=EV_CONFIGURATION), billed_evidence(ctx)],
        current={"Pricing tier": sku},
        savings=no_savings("App Service tier prices are not read from the Azure price list in "
                           "this build; the plan's billed cost is shown for scale."),
        confidence=CONF_MEDIUM,
        confidence_reasons=["Plan-level CPU and memory are measured; per-app peaks are not."],
        risk=RISK_MEDIUM, risk_notes=["A smaller tier can remove features (slots, VNet integration)."],
        impact={"cost": "Lower plan charge.", "performance": "Requires validation.",
                "availability": "Scaling a plan restarts its apps."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [], "preconditions": [
            "Check the target tier keeps the features the apps use."]},
        data_sources=sources,
    )


RULES = [
    Rule(rule_id="K8S_CLUSTER_EMPTY", version="1.0", providers=(AZURE, OCI),
         resource_types=("OKECluster", "AKSCluster"), category=CLEANUP, severity=MEDIUM,
         signal=SIG_UNUSED, title="Kubernetes cluster has no nodes",
         description="A cluster with zero nodes or node pools.",
         rationale="An empty cluster runs nothing but may still bill a control plane.",
         remediation={OCI: "OCI console → Kubernetes Clusters → select → Delete.",
                      AZURE: "Azure portal → Kubernetes services → select → Delete."},
         risk=RISK_LOW, effort="LOW", evaluate=_empty_cluster,
         supersedes=("Idle OKE Cluster (No Node Pools)", "Idle AKS Cluster (No Nodes)")),
    Rule(rule_id="K8S_NODES_UNDERUTILIZED", version="1.0", providers=(AZURE,),
         resource_types=("AKSCluster",), category=RIGHTSIZING, severity=MEDIUM,
         signal=SIG_UNDERUTILIZED, title="Kubernetes nodes are underutilized",
         description="Node CPU and memory P95 well below capacity for 30 days.",
         rationale="Node pools bill per node-hour whether or not pods use the capacity.",
         remediation={AZURE: "az aks nodepool update --enable-cluster-autoscaler, or scale the pool."},
         risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_nodes_underutilized,
         metrics=("cpu_percent", "memory_percent")),
    Rule(rule_id="APP_SERVICE_PLAN_UNDERUTILIZED", version="1.0", providers=(AZURE,),
         resource_types=("AppServicePlan",), category=RIGHTSIZING, severity=MEDIUM,
         signal=SIG_UNDERUTILIZED, title="App Service plan appears underutilized",
         description="Plan CPU and memory P95 well below capacity for 30 days.",
         rationale="A plan bills for its tier and instance count, not for what its apps use.",
         remediation={AZURE: "Azure portal → App Service plan → Scale up / Scale out."},
         risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_app_service_plan,
         metrics=("cpu_percent", "memory_percent")),
]
