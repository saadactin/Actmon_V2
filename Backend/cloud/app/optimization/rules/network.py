"""Network rules: public IPs, load balancers, NAT gateways, interfaces, gateways.

The public-IP rule is the reason `nat_gateway_id` was added to the Azure
scanner. On TOR, two public IPs had no NIC ip-configuration; one of them is the
egress address of a NAT gateway serving a live subnet. Reading "no
ip-configuration" as "unused" would have recommended releasing it. The rule now
needs BOTH associations recorded as empty, and says "not enough data" for
inventory collected before the field existed.
"""
from __future__ import annotations

from app.optimization.model import (
    AWS, AZURE, CHECK_PASS, CHECK_UNKNOWN, CLEANUP, CONF_HIGH, CONF_MEDIUM, CONFIRM_FIRST,
    EV_CONFIGURATION, FINDING, LOW, MEDIUM, NETWORK, OCI, RISK_HIGH, RISK_LOW, RISK_MEDIUM,
    SAFE, WITH_CARE, check, data_source, evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_UNUSED, Ctx, Outcome, Rule, billed_evidence, billed_savings, billing_source, clear,
    insufficient, metric_evidence, metric_source, not_applicable, telemetry_gate,
)


def _public_ip(ctx: Ctx):
    cfg = ctx.config
    if "attached_to_id" not in cfg or "nat_gateway_id" not in cfg:
        return insufficient(
            "Which resource this address is bound to was not fully recorded: a NAT gateway holds "
            "its IPs outside the NIC ip-configuration, and the scan that produced this inventory "
            "did not record that association. The next Refresh all collects it.",
            data_sources=[data_source("association", "NIC / load balancer / gateway association",
                                      "attached_to_id" in cfg),
                          data_source("nat_gateway", "NAT gateway association", False,
                                      "not in this inventory")])
    if cfg.get("attached_to_id") or cfg.get("nat_gateway_id"):
        return clear("The address is associated with a resource.")
    ip = getattr(ctx.resource, "ip_address", None)
    sav = billed_savings(ctx, what="this public IP")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNUSED,
        detail=f"{ip or 'The address'} ({cfg.get('allocation_method') or 'allocation not reported'}, "
               f"{cfg.get('sku') or 'SKU not reported'}) is associated with nothing.",
        recommendation=("Release the address if nothing needs it. If a DNS record or an allow-list "
                        "elsewhere still refers to it, update that first — a released static "
                        "address cannot be reclaimed."),
        evidence=[evidence("Address", ip, kind=EV_CONFIGURATION, source="Azure Network API"),
                  evidence("NIC / load balancer / gateway", "None", kind=EV_CONFIGURATION),
                  evidence("NAT gateway", "None", kind=EV_CONFIGURATION),
                  evidence("Allocation", cfg.get("allocation_method"), kind=EV_CONFIGURATION),
                  evidence("DNS name", cfg.get("fqdn"), kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Address": ip, "Allocation": cfg.get("allocation_method"), "SKU": cfg.get("sku"),
                 "Associated with": "Nothing"},
        recommended={"Action": "Release"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["Both associations are recorded empty."],
        risk=RISK_MEDIUM,
        risk_notes=["A released static IP is gone; anything configured with it breaks."],
        impact={"cost": "Ends the hourly public IP charge.", "performance": "None.",
                "availability": "Clients that still use the address lose it."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("Not bound to a NIC, load balancer or gateway", CHECK_PASS),
            check("Not bound to a NAT gateway", CHECK_PASS),
            check("No DNS record or allow-list elsewhere uses it", CHECK_UNKNOWN,
                  "External references are not visible to ACTMON."),
        ], "preconditions": ["Search DNS and firewall allow-lists for the address first."]},
        data_sources=[data_source("association", "Associations", True, "Azure Network API"),
                      billing_source(ctx)],
    )


def _lb_no_backends(ctx: Ctx):
    cfg = ctx.config
    if cfg.get("lb_type") != "LoadBalancer":
        return not_applicable("Not an OCI load balancer record.")
    sets, ips = cfg.get("backend_sets"), cfg.get("backend_ips")
    if sets is None and ips is None:
        return insufficient("The load balancer's backends were not collected.")
    if sets and ips:
        return clear("The load balancer has backends.")
    what = "no backend sets" if not sets else "backend sets with no backend servers"
    sav = billed_savings(ctx, what="this load balancer")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail=f"The load balancer has {what}, so it can serve no traffic.",
        recommendation="Delete the load balancer if it is unused. Check DNS first: its public "
                       "address is released with it.",
        evidence=[evidence("Backend sets", len(sets or []), kind=EV_CONFIGURATION,
                           source="OCI Load Balancer API"),
                  evidence("Backend servers", len(ips or []), kind=EV_CONFIGURATION),
                  evidence("Listeners", ", ".join(cfg.get("listeners") or []) or "None",
                           kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Backend sets": str(len(sets or [])), "Backend servers": str(len(ips or [])),
                 "Shape": cfg.get("shape_name")},
        recommended={"Action": "Delete"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["Backends are reported by the provider."],
        risk=RISK_MEDIUM, risk_notes=["The load balancer's IP address is released and cannot be reclaimed."],
        impact={"cost": "Ends the load balancer's hourly charge.", "performance": "None.",
                "availability": "Clients resolving its address lose it."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No backends to route to", CHECK_PASS),
            check("No DNS record points at it", CHECK_UNKNOWN, "DNS is not visible to ACTMON.")],
            "preconditions": ["Remove DNS records that point at it."]},
        data_sources=[data_source("backends", "Backend configuration", True), billing_source(ctx)],
    )


def _lb_idle(ctx: Ctx):
    cfg = ctx.config
    if ctx.provider == OCI and cfg.get("lb_type") != "LoadBalancer":
        return not_applicable("Not an OCI load balancer record.")
    if not (cfg.get("backend_sets") and cfg.get("backend_ips")):
        return not_applicable("No backends — the no-backends finding covers it.")
    sources = [metric_source(ctx, "lb_connections", "30-day accepted connections"),
               metric_source(ctx, "lb_requests", "30-day HTTP requests", required=False),
               billing_source(ctx)]
    ok, why = telemetry_gate(ctx, "lb_connections")
    if not ok:
        return insufficient(why, data_sources=sources)
    conns = ctx.telemetry.stat("lb_connections", "total") or 0.0
    reqs = ctx.telemetry.stat("lb_requests", "total") if ctx.telemetry.ok("lb_requests") else None
    if conns > 0 or (reqs or 0) > 0:
        return clear(f"{conns:,.0f} connections accepted in the window.")
    sav = billed_savings(ctx, what="this load balancer")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail="The load balancer accepted no connections in the last 30 days.",
        recommendation="Confirm nothing still routes through it, then delete it.",
        evidence=[metric_evidence(ctx, "lb_connections", "total", "Accepted connections, 30 days"),
                  metric_evidence(ctx, "lb_requests", "total", "HTTP requests, 30 days"),
                  evidence("Backend servers", len(cfg.get("backend_ips") or []), kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Listeners": ", ".join(cfg.get("listeners") or []) or None,
                 "Backend servers": str(len(cfg.get("backend_ips") or []))},
        recommended={"Action": "Delete"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["Zero connections were measured for 30 days."],
        risk=RISK_MEDIUM, risk_notes=["Its IP address is released with it."],
        impact={"cost": "Ends the load balancer's hourly and bandwidth charge.",
                "performance": "None measured.", "availability": "A standby path would disappear."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No connections for 30 days", CHECK_PASS),
            check("Not a disaster-recovery standby", CHECK_UNKNOWN,
                  "A DR load balancer is idle by design.")],
            "preconditions": ["Check whether it is a DR standby before deleting."]},
        data_sources=sources,
    )


def _nat_idle(ctx: Ctx):
    sources = [metric_source(ctx, "nat_bytes", "30-day NAT gateway traffic"), billing_source(ctx)]
    ok, why = telemetry_gate(ctx, "nat_bytes")
    if not ok:
        return insufficient(why, data_sources=sources)
    total = ctx.telemetry.stat("nat_bytes", "total") or 0.0
    if total > 0:
        return clear("The NAT gateway carried traffic in the window.")
    sav = billed_savings(ctx, what="this NAT gateway")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail="The NAT gateway processed no traffic in the last 30 days.",
        recommendation="Detach it from its subnets and delete it if no workload needs outbound access through it.",
        evidence=[metric_evidence(ctx, "nat_bytes", "total", "Bytes processed, 30 days"),
                  billed_evidence(ctx)],
        current={"Traffic, 30 days": "0 bytes"},
        recommended={"Action": "Delete"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["Zero bytes were measured by Azure Monitor."],
        risk=RISK_MEDIUM, risk_notes=["Subnets that rely on it lose outbound connectivity."],
        impact={"cost": "Ends the NAT gateway's hourly charge.", "performance": "None measured.",
                "availability": "Outbound traffic from its subnets stops if anything starts using it."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No traffic for 30 days", CHECK_PASS)],
            "preconditions": ["Check which subnets are associated with it."]},
        data_sources=sources,
    )


def _nic_unattached(ctx: Ctx):
    cfg = ctx.config
    status = cfg.get("attachment_status")
    if not status:
        return insufficient("Whether the interface is attached was not recorded.")
    if status != "Unattached":
        return clear("The interface is attached to a VM.")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNUSED,
        detail=f"Attached to no VM; holds private IP {cfg.get('private_ip') or 'unknown'}.",
        recommendation="Delete the interface if nothing will re-attach it. It releases its private IP "
                       "and any public IP association.",
        evidence=[evidence("Attached VM", "None", kind=EV_CONFIGURATION, source="Azure Network API"),
                  evidence("Private IP", cfg.get("private_ip"), kind=EV_CONFIGURATION),
                  evidence("Public IPs", len(cfg.get("public_ip_ids") or []), kind=EV_CONFIGURATION)],
        current={"Attached VM": "None", "Private IP": cfg.get("private_ip")},
        recommended={"Action": "Delete"},
        savings=no_savings("A network interface carries no charge of its own; the benefit is "
                           "hygiene — it holds an IP and can carry an NSG and a public address."),
        confidence=CONF_HIGH, confidence_reasons=["Azure reports no VM association."],
        risk=RISK_LOW, risk_notes=["Its private IP returns to the subnet pool."],
        impact={"cost": "None directly.", "performance": "None.", "availability": "None."},
        safety={"verdict": SAFE, "reversible": False, "checks": [
            check("Not attached to a VM", CHECK_PASS)], "preconditions": []},
        data_sources=[data_source("association", "VM association", True)],
    )


def _apigw_no_deployments(ctx: Ctx):
    cfg = ctx.config
    if "endpoint_type" not in cfg:
        return not_applicable("Not an OCI API gateway record.")
    if cfg.get("deployment_count") is None:
        return insufficient("The gateway's deployment count was not collected.")
    if cfg["deployment_count"] > 0:
        return clear(f"{cfg['deployment_count']} deployment(s).")
    sav = billed_savings(ctx, what="this API gateway")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        detail="The gateway has no deployments, so it routes no APIs.",
        recommendation="Delete the gateway if it is no longer used.",
        evidence=[evidence("Deployments", 0, kind=EV_CONFIGURATION, source="OCI API Gateway API"),
                  billed_evidence(ctx)],
        current={"Deployments": "0"}, recommended={"Action": "Delete"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["The provider reports zero deployments."],
        risk=RISK_MEDIUM, risk_notes=["Its hostname is released."],
        impact={"cost": "Ends the gateway charge.", "performance": "None.",
                "availability": "Clients targeting its hostname lose it."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No deployments", CHECK_PASS)], "preconditions": ["Confirm no client targets it."]},
        data_sources=[data_source("deployments", "Deployment count", True), billing_source(ctx)],
    )


RULES = [
    Rule(rule_id="PUBLIC_IP_UNUSED", version="1.0", providers=(AZURE,), resource_types=("PublicIP",),
         category=NETWORK, severity=LOW, signal=SIG_UNUSED,
         title="Public IP address is not associated with anything",
         description="A public IP bound to no NIC, load balancer, gateway or NAT gateway.",
         rationale="Standard public IPs bill by the hour whether or not anything uses them.",
         remediation={AZURE: "Azure portal → Public IP addresses → select → Delete."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_public_ip),
    Rule(rule_id="LB_NO_BACKENDS", version="1.0", providers=(OCI,), resource_types=("LoadBalancer",),
         category=NETWORK, severity=MEDIUM, signal=SIG_UNUSED,
         title="Load balancer has no backends",
         description="A load balancer with no backend sets, or backend sets with no servers.",
         rationale="A load balancer bills for its provisioned shape per hour whether or not it can "
                   "route anything.",
         remediation={OCI: "OCI console → Networking → Load Balancers → select → Delete."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_lb_no_backends,
         supersedes=("Idle OCI Load Balancer (No Backend Sets)",)),
    Rule(rule_id="LB_IDLE", version="1.0", providers=(OCI,), resource_types=("LoadBalancer",),
         category=NETWORK, severity=MEDIUM, signal=SIG_UNUSED,
         title="Load balancer accepted no connections for 30 days",
         description="A load balancer with backends but zero accepted connections measured.",
         rationale="An unused load balancer still bills its hourly shape charge.",
         remediation={OCI: "OCI console → Networking → Load Balancers → select → Delete."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_lb_idle,
         metrics=("lb_connections", "lb_requests")),
    Rule(rule_id="NAT_GATEWAY_IDLE", version="1.0", providers=(AZURE,), resource_types=("NATGateway",),
         category=NETWORK, severity=MEDIUM, signal=SIG_UNUSED,
         title="NAT gateway carried no traffic for 30 days",
         description="A NAT gateway with zero bytes processed, measured by Azure Monitor.",
         rationale="A NAT gateway bills per hour it exists, plus per GB processed.",
         remediation={AZURE: "Dissociate it from its subnets, then delete it."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_nat_idle, metrics=("nat_bytes",)),
    Rule(rule_id="NIC_UNATTACHED", version="1.0", providers=(AZURE,), resource_types=("NetworkInterface",),
         category=CLEANUP, severity=LOW, signal=SIG_UNUSED,
         title="Network interface is not attached to a VM",
         description="A network interface with no VM association.",
         rationale="Orphaned interfaces hold private IPs and can carry NSG rules and public "
                   "addresses that nobody reviews.",
         remediation={AZURE: "Azure portal → Network interfaces → select → Delete."},
         risk=RISK_LOW, effort="LOW", evaluate=_nic_unattached),
    Rule(rule_id="API_GATEWAY_NO_DEPLOYMENTS", version="1.0", providers=(OCI,),
         resource_types=("APIGateway",), category=NETWORK, severity=MEDIUM, signal=SIG_UNUSED,
         title="API gateway has no deployments",
         description="An OCI API gateway with zero deployments.",
         rationale="A gateway with no deployments routes nothing but is billed while it exists.",
         remediation={OCI: "OCI console → Developer Services → API Gateway → select → Delete."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_apigw_no_deployments,
         supersedes=("Idle OCI API Gateway (No Deployments)",)),
]
