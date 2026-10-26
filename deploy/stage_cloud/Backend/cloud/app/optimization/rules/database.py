"""Database rules: capacity, activity, storage headroom, licensing, HA.

Two restraints matter here more than anywhere:

* **No exact database size is named.** A database's memory, I/O and licence
  terms move with its compute size in provider-specific ways (an OCI DB
  system's memory follows its OCPUs; an Azure SQL database may sit in a
  pool). The rules report what the measured load would fit as an indication,
  and say "evaluate", never "resize to".
* **High availability is never recommended off on inference.** The old Cost-tab
  rule flagged Multi-AZ on any RDS database WITHOUT a production tag — so a
  missing tag read as "non-production". Here only a database explicitly
  tagged as non-production is considered, and the finding leads with what
  failover it would lose.
"""
from __future__ import annotations

import math

from app.optimization.model import (
    AVAILABILITY, AWS, AZURE, CHECK_PASS, CHECK_UNKNOWN, CLEANUP, CONF_HIGH, CONF_LOW,
    CONF_MEDIUM, CONFIRM_FIRST, COST, DATABASE, EV_CONFIGURATION, EV_DERIVED, FINDING, HIGH,
    LOW, MEDIUM, OCI, RISK_HIGH, RISK_LOW, RISK_MEDIUM, SAVINGS_LIST_PRICE, WITH_CARE,
    Savings, check, data_source, evidence, no_savings,
)
from app.optimization.rules.base import (
    SIG_CONFIGURATION, SIG_CONSTRAINED, SIG_RISK, SIG_UNDERUTILIZED, SIG_UNUSED, Ctx,
    Outcome, Rule, billed_evidence, billed_savings, billing_source, cfg_num, clear,
    insufficient, metric_evidence, metric_source, not_applicable, since_change,
    telemetry_gate,
)
from app.pricing import oci_pricing

DB_TYPES = ("PostgreSQLServer", "SQLDatabase", "DbSystem", "AutonomousDatabase", "RDSInstance")
_NON_PROD = ("dev", "development", "test", "testing", "qa", "staging", "stage", "uat",
             "sandbox", "nonprod", "non-prod", "non-production")


def _db_capacity(ctx: Ctx):
    cfg = ctx.config
    t = ctx.resource.resource_type
    if t == "DbSystem":
        cores = cfg_num(cfg, "cpu_core_count")
        return {"label": f"{cores:g} OCPU across {cfg.get('node_count') or '?'} node(s)" if cores else None,
                "cpu": cores, "unit": "OCPU", "shape": cfg.get("shape")}
    if t == "AutonomousDatabase":
        ecpu = cfg.get("compute_model") == "ECPU"
        n = cfg_num(cfg, "compute_count") if ecpu else cfg_num(cfg, "cpu_core_count")
        return {"label": f"{n:g} {'ECPU' if ecpu else 'OCPU'}" if n else None, "cpu": n,
                "unit": "ECPU" if ecpu else "OCPU", "minimum": 2.0 if ecpu else 1.0}
    if t == "PostgreSQLServer":
        return {"label": f"{cfg.get('sku')} ({cfg.get('tier')})" if cfg.get("sku") else None}
    if t == "SQLDatabase":
        return {"label": cfg.get("sku")}
    return {"label": cfg.get("instance_class") or cfg.get("db_instance_class")}


def _cpu_metric(ctx: Ctx) -> str:
    # A DTU-model Azure SQL database is sized in DTUs, and dtu_consumption_percent
    # is the utilization of what it pays for. vCore databases do not publish it.
    if ctx.resource.resource_type == "SQLDatabase" and ctx.telemetry.ok("dtu_percent"):
        return "dtu_percent"
    return "cpu_percent"


def _underutilized(ctx: Ctx):
    cfg = ctx.config
    t = ctx.resource.resource_type
    if t == "SQLDatabase" and (cfg.get("sku") or "").lower() == "elasticpool":
        return not_applicable("The database draws on an elastic pool; its capacity is the pool's.")
    if (getattr(ctx.resource, "normalized_status", "") or "").upper() == "STOPPED":
        return not_applicable("The database is stopped.")
    metric = _cpu_metric(ctx)
    sources = [metric_source(ctx, metric, "30-day CPU telemetry"),
               metric_source(ctx, "memory_percent", "30-day memory telemetry", required=False),
               metric_source(ctx, "connections", "30-day connections", required=False),
               billing_source(ctx)]
    ok, why = telemetry_gate(ctx, metric)
    if not ok:
        return insufficient(why, data_sources=sources)
    th = ctx.thresholds
    p95 = ctx.telemetry.stat(metric, "p95")
    p99 = ctx.telemetry.stat(metric, "p99")
    if p95 > th["db_underutilized_cpu_p95"]:
        return clear(f"CPU P95 {p95:.1f}% is above the {th['db_underutilized_cpu_p95']:g}% bar.")
    mem_ok, _ = telemetry_gate(ctx, "memory_percent")
    mem_p95 = ctx.telemetry.stat("memory_percent", "p95") if mem_ok else None
    if mem_ok and mem_p95 > th["db_underutilized_memory_p95"]:
        return clear(f"CPU is low but memory P95 is {mem_p95:.1f}%.")
    cap = _db_capacity(ctx)
    if cap.get("minimum") and cap.get("cpu") is not None and cap["cpu"] <= cap["minimum"]:
        return clear(f"Already at the minimum of {cap['minimum']:g} {cap.get('unit')}.")

    indication = None
    ev = [metric_evidence(ctx, metric, "avg", "CPU average"),
          metric_evidence(ctx, metric, "p95", "CPU P95"),
          metric_evidence(ctx, metric, "peak", "CPU peak"),
          metric_evidence(ctx, "memory_percent", "p95", "Memory P95"),
          metric_evidence(ctx, "connections", "peak", "Connections, peak"),
          billed_evidence(ctx)]
    if cap.get("cpu"):
        need = max(cap["cpu"] * p95 / th["sizing_target_cpu_p95"],
                   cap["cpu"] * (p99 or p95) / th["sizing_target_cpu_p99"])
        fit = max(cap.get("minimum") or 1.0, math.ceil(need - 1e-9))
        if fit < cap["cpu"]:
            indication = (f"the measured load would fit about {fit:g} {cap['unit']} at a "
                          f"{th['sizing_target_cpu_p95']:g}% P95")
            ev.append(evidence("Indicated capacity", fit, display=f"≈ {fit:g} {cap['unit']}",
                               kind=EV_DERIVED,
                               source=f"current × P95 / {th['sizing_target_cpu_p95']:g}%, and × P99 / "
                                      f"{th['sizing_target_cpu_p99']:g}%",
                               detail="An indication, not a size: memory, I/O and licensing move "
                                      "with a database's compute in service-specific ways."))
    why_na = {
        "DbSystem": "OCI does not publish Base Database OCPU rates (license-included or BYOL) in "
                    "its public price list, so the reduction is not priced.",
        "AutonomousDatabase": "The ECPU rate for this workload type is not verified against OCI's "
                              "public price list in this build.",
    }.get(t, "Database compute prices are not read from a price list for this service, so the "
             "reduction is not priced; the billed cost is shown for scale.")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNDERUTILIZED,
        title="Database appears underutilized",
        detail=f"CPU P95 {p95:.1f}%" + (f", memory P95 {mem_p95:.1f}%" if mem_p95 is not None else "")
               + " over the last 30 days.",
        recommendation=("Evaluate a smaller compute size" + (f": {indication}." if indication else ".")
                        + " Check peak batch windows (month-end, reporting) before resizing."),
        evidence=ev,
        current={"Compute": cap.get("label"), "Engine/type": t},
        recommended={"Indication": indication} if indication else None,
        # A smaller size saves part of the bill, not all of it, and which part
        # is not published — so the billed cost is evidence, never the saving.
        savings=no_savings(why_na),
        confidence=CONF_MEDIUM if mem_ok else CONF_LOW,
        confidence_reasons=["CPU was measured by the provider for 30 days."]
                           + ([] if mem_ok else ["Memory was not measured for this database."]),
        risk=RISK_MEDIUM,
        risk_notes=["Changing a database's compute is disruptive on most services (a restart, "
                    "rolling across nodes where there are two). Schedule a window."],
        impact={"cost": "Lower compute charge.",
                "performance": "Requires validation at peak business periods.",
                "availability": "A restart during the change unless the service scales online.",
                "recovery": "No change to backups."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [
            check("CPU measured for at least 14 days", CHECK_PASS),
            check("Month-end or batch peaks included in the window", CHECK_UNKNOWN,
                  "The 30-day window may not include the heaviest cycle.")],
            "preconditions": ["Resize in a maintenance window and watch query latency afterwards."]},
        data_sources=sources,
    )


def _idle(ctx: Ctx):
    t = ctx.resource.resource_type
    metric = "connections_opened" if t == "SQLDatabase" else "connections"
    sources = [metric_source(ctx, metric, "30-day connections"), billing_source(ctx)]
    if (getattr(ctx.resource, "normalized_status", "") or "").upper() == "STOPPED":
        return not_applicable("The database is stopped.")
    ok, why = telemetry_gate(ctx, metric)
    if not ok:
        return insufficient(why, data_sources=sources)
    value = (ctx.telemetry.stat(metric, "total") if metric == "connections_opened"
             else ctx.telemetry.stat(metric, "peak"))
    if value and value > 0:
        return clear("Connections were measured in the window.")
    sav = billed_savings(ctx, what="this database")
    return Outcome(
        verdict=FINDING, severity=HIGH, signal=SIG_UNUSED,
        title="Database had no connections for 30 days",
        detail="No client connection was measured in the last 30 days.",
        recommendation=("Confirm with its owner, take a final backup, and delete it — or stop it "
                        "if the service allows and it is needed occasionally."),
        evidence=[metric_evidence(ctx, metric, "total" if metric == "connections_opened" else "peak",
                                  "Connections, 30 days"), billed_evidence(ctx)],
        current={"Connections, 30 days": "0"},
        recommended={"Action": "Final backup, then delete (or stop)"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["Connections are counted by the service itself."],
        risk=RISK_HIGH, risk_notes=["Deleting a database is irreversible without its final backup."],
        impact={"cost": "Ends the database's charges.", "performance": "None measured.",
                "availability": "A rarely-used application (quarterly, DR) would lose it.",
                "recovery": "Only the final backup remains."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("No connections for 30 days", CHECK_PASS),
            check("Used by a quarterly or DR process", CHECK_UNKNOWN,
                  "Usage outside the 30-day window is not visible.")],
            "preconditions": ["Take and verify a final backup.", "Confirm with the owner."]},
        data_sources=sources,
    )


def _storage_nearly_full(ctx: Ctx):
    sources = [metric_source(ctx, "storage_percent", "30-day storage utilization")]
    ok, why = telemetry_gate(ctx, "storage_percent")
    if not ok:
        return insufficient(why, data_sources=sources)
    peak = ctx.telemetry.stat("storage_percent", "peak")
    bar = ctx.thresholds["storage_nearly_full_pct"]
    if peak is None or peak < bar:
        return clear(f"Storage peaked at {peak:.1f}%, under {bar:g}%.")
    return Outcome(
        verdict=FINDING, severity=HIGH if peak >= 95 else MEDIUM, signal=SIG_CONSTRAINED,
        title="Database storage is nearly full",
        detail=f"Storage utilization reached {peak:.1f}% in the last 30 days.",
        recommendation="Add storage or enable auto-grow, and review what is growing (archive "
                       "logs, audit tables, backups kept in the database).",
        evidence=[metric_evidence(ctx, "storage_percent", "avg", "Storage average"),
                  metric_evidence(ctx, "storage_percent", "peak", "Storage peak")],
        current={"Storage peak": f"{peak:.1f}%"},
        savings=no_savings("This recommendation adds storage; it is not a saving."),
        confidence=CONF_HIGH, confidence_reasons=["Reported by the database service."],
        risk=RISK_LOW, risk_notes=["Most services grow storage online; shrinking is rarely possible."],
        impact={"cost": "Higher storage charge.", "performance": "Avoids write failures at 100%.",
                "availability": "A full database stops accepting writes."},
        safety={"verdict": WITH_CARE, "reversible": False, "checks": [], "preconditions": []},
        data_sources=sources,
    )


def _license_included(ctx: Ctx):
    cfg = ctx.config
    lm = cfg.get("license_model")
    if not lm:
        return insufficient("The DB system's licence model was not collected.")
    if lm != "LICENSE_INCLUDED":
        return clear(f"Licence model {lm}.")
    cores = cfg_num(cfg, "cpu_core_count")
    nodes = int(cfg_num(cfg, "node_count") or 1)
    edition = (cfg.get("database_edition") or "").replace("_", " ").title()
    needs = [f"{edition} processor licences for {cores:g} OCPU" if cores else f"{edition} licences"]
    if nodes > 1:
        needs.append("Real Application Clusters option licences for the same processors")
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_CONFIGURATION,
        title="DB system pays for its Oracle licence by the hour",
        detail=f"License Included, {edition}, {cores:g} OCPU across {nodes} node(s).",
        recommendation=("If the organisation already owns Oracle Database licences with support, "
                        "switch this DB system to Bring Your Own License. BYOL bills a far lower "
                        "per-OCPU rate because the licence is not rented with the hardware."),
        evidence=[evidence("Licence model", "License Included", kind=EV_CONFIGURATION,
                           source="OCI Database API"),
                  evidence("Edition", edition, kind=EV_CONFIGURATION),
                  evidence("OCPUs (all nodes)", cores, display=f"{cores:g}", kind=EV_CONFIGURATION),
                  evidence("Nodes", nodes, kind=EV_CONFIGURATION),
                  billed_evidence(ctx)],
        current={"Licence model": "License Included", "Edition": edition,
                 "OCPUs": f"{cores:g}" if cores else None, "Nodes": str(nodes)},
        recommended={"Licence model": "Bring Your Own License"},
        savings=no_savings("OCI does not publish the license-included and BYOL Base Database OCPU "
                           "rates in its public price list — they appear only in the account's "
                           "billing SKUs — so the difference is not priced here."),
        confidence=CONF_MEDIUM,
        confidence_reasons=["The licence model is reported by OCI.",
                            "Whether the organisation holds licences is not visible to ACTMON."],
        risk=RISK_HIGH,
        risk_notes=["Running BYOL without enough licences is a licence-compliance breach.",
                    "Oracle requires Data Guard standbys to be fully licensed."],
        impact={"cost": "A lower per-OCPU rate for every hour the system runs.",
                "performance": "None.",
                "availability": "Oracle does not document the switch as online; plan a window.",
                "compliance": "Licence entitlement must cover every OCPU and option in use."},
        safety={"verdict": CONFIRM_FIRST, "reversible": True, "checks": [
            check("Licence entitlement covers it", CHECK_UNKNOWN, "; ".join(needs)),
            check("Options in use are licensed (e.g. Active Data Guard)", CHECK_UNKNOWN,
                  "Database options in use are not collected.")],
            "preconditions": ["Confirm entitlement with the licence owner: " + "; ".join(needs) + ".",
                              "Change a standby before its primary."]},
        data_sources=[data_source("licence", "Licence model", True, "OCI Database API"),
                      data_source("entitlement", "Licence entitlement", False,
                              "held by the organisation, not by the cloud")],
    )


def _stopped(ctx: Ctx):
    t = ctx.resource.resource_type
    stopped = ((ctx.resource.status or "").upper() == "STOPPED"
               or (getattr(ctx.resource, "normalized_status", "") or "").upper() == "STOPPED")
    if not stopped:
        return not_applicable("The database is not stopped.")
    since = since_change(ctx, ("status", "normalized_status"), ("stopped",))
    sav = billed_savings(ctx, what="this database's storage", include_self=True)
    note = None
    if sav is None and t == "AutonomousDatabase":
        tbs = cfg_num(ctx.config, "data_storage_size_tbs")
        amt, lines = oci_pricing.adb_storage_breakdown(tbs, ctx.prices.oci_block)
        if amt is not None:
            sav = Savings(method=SAVINGS_LIST_PRICE, amount=amt, currency=ctx.prices.currency,
                          basis="OCI public price list: Autonomous Database storage per GB-month.",
                          breakdown=lines, assumptions=["1 TB billed as 1,024 GB."])
    if t == "RDSInstance":
        note = "RDS starts a stopped instance again automatically after 7 days."
    return Outcome(
        verdict=FINDING, severity=MEDIUM, signal=SIG_UNUSED,
        title="Stopped database still bills its storage",
        detail="Stopped; its provisioned storage keeps billing." + (f" {note}" if note else ""),
        recommendation="If it is no longer needed, take a final backup and delete it.",
        evidence=[evidence("State", ctx.resource.status, kind=EV_CONFIGURATION),
                  evidence("Stopped since", (since or {}).get("at"), kind=EV_CONFIGURATION,
                           source="Config Drift log" if since else None,
                           detail=None if since else "Not recorded in the change log."),
                  billed_evidence(ctx)],
        current={"State": ctx.resource.status}, recommended={"Action": "Final backup, then delete"},
        savings=sav or no_savings(ctx.prices.billing_gap(ctx.provider)),
        confidence=CONF_HIGH, confidence_reasons=["The provider reports the stopped state."],
        risk=RISK_HIGH, risk_notes=["Deletion is irreversible; automatic backups go with the database."],
        impact={"cost": "Ends the storage charge.", "performance": "None.",
                "availability": "Anything expecting to start it again will fail.",
                "recovery": "Only the manual final backup remains."},
        safety={"verdict": CONFIRM_FIRST, "reversible": False, "checks": [
            check("Database is stopped", CHECK_PASS),
            check("A manual backup exists", CHECK_UNKNOWN, "Backups are not collected.")],
            "preconditions": ["Take and verify a manual backup first."]},
        data_sources=[data_source("state", "Database state", True), billing_source(ctx)],
    )


def _multi_az_non_prod(ctx: Ctx):
    if ctx.config.get("multi_az") is not True:
        return not_applicable("Multi-AZ is not enabled.")
    env = (getattr(ctx.resource, "environment", None) or "").strip().lower()
    if not env:
        return insufficient("The database carries no environment tag. A missing tag is not "
                            "evidence that it is non-production, so high availability is not "
                            "questioned.")
    if env not in _NON_PROD:
        return clear(f"Tagged environment '{env}'.")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_CONFIGURATION,
        title="Non-production database runs Multi-AZ",
        detail=f"Tagged '{env}' and configured Multi-AZ.",
        recommendation=("If this environment does not need automatic failover, convert it to "
                        "Single-AZ. Keep Multi-AZ if the environment is used to rehearse failover."),
        evidence=[evidence("Multi-AZ", "Enabled", kind=EV_CONFIGURATION, source="RDS API"),
                  evidence("Environment tag", env, kind=EV_CONFIGURATION)],
        current={"Multi-AZ": "Enabled", "Environment": env},
        recommended={"Multi-AZ": "Disabled"},
        savings=no_savings("Not priced: AWS per-resource billing and the AWS price list are not "
                           "available to this account's integration."),
        confidence=CONF_MEDIUM, confidence_reasons=["Based on the environment tag."],
        risk=RISK_MEDIUM,
        risk_notes=["Removes automatic failover: an AZ outage takes the database down until "
                    "it is restored."],
        impact={"cost": "Roughly halves the instance and storage charge.",
                "performance": "None.",
                "availability": "No standby — an AZ failure means downtime.",
                "recovery": "Recovery becomes a restore, not a failover."},
        safety={"verdict": CONFIRM_FIRST, "reversible": True, "checks": [
            check("Tagged non-production", CHECK_PASS, env)],
            "preconditions": ["Confirm the environment is not used for failover testing."]},
        data_sources=[data_source("tags", "Environment tag", True)],
    )


def _dynamo_provisioned(ctx: Ctx):
    cfg = ctx.config
    if cfg.get("billing_mode") != "PROVISIONED":
        return not_applicable("On-demand billing.")
    rcu, wcu = cfg_num(cfg, "read_capacity"), cfg_num(cfg, "write_capacity")
    sources = [metric_source(ctx, "consumed_rcu", "30-day consumed reads"),
               metric_source(ctx, "consumed_wcu", "30-day consumed writes")]
    for m in ("consumed_rcu", "consumed_wcu"):
        ok, why = telemetry_gate(ctx, m)
        if not ok:
            return insufficient(why, data_sources=sources)
    used_r = (ctx.telemetry.stat("consumed_rcu", "p95") or 0.0) / 3600.0
    used_w = (ctx.telemetry.stat("consumed_wcu", "p95") or 0.0) / 3600.0
    share_r = used_r / rcu * 100 if rcu else None
    share_w = used_w / wcu * 100 if wcu else None
    if (share_r is not None and share_r > 20) or (share_w is not None and share_w > 20):
        return clear("Provisioned capacity is meaningfully used.")
    return Outcome(
        verdict=FINDING, severity=LOW, signal=SIG_UNDERUTILIZED,
        title="Provisioned DynamoDB capacity is mostly unused",
        detail=f"P95 use is {share_r or 0:.1f}% of provisioned reads and {share_w or 0:.1f}% of writes.",
        recommendation="Lower the provisioned capacity (or enable auto scaling), or switch the "
                       "table to on-demand if its traffic is spiky.",
        evidence=[evidence("Provisioned RCU / WCU", f"{rcu:g} / {wcu:g}", kind=EV_CONFIGURATION),
                  evidence("Consumed RCU/s, P95", round(used_r, 3), kind=EV_DERIVED,
                           source="ConsumedReadCapacityUnits hourly sum / 3600"),
                  evidence("Consumed WCU/s, P95", round(used_w, 3), kind=EV_DERIVED,
                           source="ConsumedWriteCapacityUnits hourly sum / 3600")],
        current={"Billing mode": "Provisioned", "RCU": f"{rcu:g}", "WCU": f"{wcu:g}"},
        recommended={"Billing mode": "Lower provisioned capacity, or on-demand"},
        savings=no_savings("Not priced: AWS per-resource billing and the AWS price list are not "
                           "available to this account's integration."),
        confidence=CONF_HIGH, confidence_reasons=["Consumption is measured by DynamoDB itself."],
        risk=RISK_LOW, risk_notes=["AWS limits how often billing mode can change (once per 24 h)."],
        impact={"cost": "Pay for capacity actually consumed.", "performance": "Throttling if set too low.",
                "availability": "None."},
        safety={"verdict": WITH_CARE, "reversible": True, "checks": [], "preconditions": []},
        data_sources=sources,
    )


RULES = [
    Rule(rule_id="DATABASE_UNDERUTILIZED", version="1.0", providers=(AWS, AZURE, OCI),
         resource_types=DB_TYPES, category=DATABASE, severity=MEDIUM, signal=SIG_UNDERUTILIZED,
         title="Database appears underutilized",
         description="Database CPU (and memory, where published) well below capacity for 30 days.",
         rationale="Database compute is usually the largest line on a bill and is paid for at "
                   "its provisioned size around the clock.",
         remediation={OCI: "OCI console → DB system / Autonomous Database → Scale.",
                      AZURE: "Azure portal → the server or database → Compute + storage.",
                      AWS: "RDS console → Modify → DB instance class."},
         risk=RISK_MEDIUM, effort="MEDIUM", evaluate=_underutilized,
         metrics=("cpu_percent", "dtu_percent", "memory_percent", "connections")),
    Rule(rule_id="DATABASE_IDLE", version="1.0", providers=(AWS, AZURE, OCI),
         resource_types=("PostgreSQLServer", "SQLDatabase", "AutonomousDatabase", "RDSInstance"),
         category=CLEANUP, severity=HIGH, signal=SIG_UNUSED,
         title="Database had no connections for 30 days",
         description="Zero client connections measured by the database service.",
         rationale="A database nothing connects to still bills its compute and storage.",
         remediation={"*": "Take a final backup, confirm with the owner, then delete or stop it."},
         risk=RISK_HIGH, effort="LOW", evaluate=_idle,
         metrics=("connections", "connections_opened")),
    Rule(rule_id="DATABASE_STORAGE_NEARLY_FULL", version="1.0", providers=(AZURE, OCI),
         resource_types=("PostgreSQLServer", "SQLDatabase", "DbSystem", "AutonomousDatabase"),
         category=DATABASE, severity=MEDIUM, signal=SIG_CONSTRAINED,
         title="Database storage is nearly full",
         description="Storage utilization at or above 85% in the last 30 days.",
         rationale="A database that runs out of storage stops accepting writes.",
         remediation={"*": "Grow the storage (or enable auto-grow) and find what is growing."},
         risk=RISK_LOW, effort="LOW", evaluate=_storage_nearly_full, metrics=("storage_percent",)),
    Rule(rule_id="DATABASE_LICENSE_INCLUDED", version="1.0", providers=(OCI,),
         resource_types=("DbSystem",), category=COST, severity=MEDIUM, signal=SIG_CONFIGURATION,
         title="DB system pays for its Oracle licence by the hour",
         description="An OCI DB system on the License Included model.",
         rationale="License Included rents the Oracle licence with the hardware. An organisation "
                   "that already owns licences pays for them twice.",
         remediation={OCI: "OCI console → DB system → Update license type → Bring Your Own License."},
         risk=RISK_HIGH, effort="MEDIUM", evaluate=_license_included),
    Rule(rule_id="DATABASE_STOPPED_STILL_BILLING", version="1.0", providers=(AWS, OCI),
         resource_types=("RDSInstance", "AutonomousDatabase"), category=CLEANUP, severity=MEDIUM,
         signal=SIG_UNUSED, title="Stopped database still bills its storage",
         description="A stopped database whose provisioned storage keeps billing.",
         rationale="Stopping ends compute billing, not storage billing.",
         remediation={"*": "Take a final manual backup, then delete the database."},
         risk=RISK_HIGH, effort="MEDIUM", evaluate=_stopped,
         supersedes=("Review Stopped RDS Database", "Stopped Autonomous Database")),
    Rule(rule_id="DATABASE_MULTI_AZ_NON_PROD", version="1.0", providers=(AWS,),
         resource_types=("RDSInstance",), category=AVAILABILITY, severity=LOW,
         signal=SIG_CONFIGURATION, title="Non-production database runs Multi-AZ",
         description="Multi-AZ on a database explicitly tagged as non-production.",
         rationale="Multi-AZ roughly doubles instance and storage charges; a non-production "
                   "environment may not need automatic failover.",
         remediation={AWS: "RDS console → Modify → Multi-AZ deployment → No."},
         risk=RISK_MEDIUM, effort="LOW", evaluate=_multi_az_non_prod,
         supersedes=("Disable Multi-AZ on Non-Prod RDS",)),
    Rule(rule_id="DYNAMODB_PROVISIONED_UNUSED", version="1.0", providers=(AWS,),
         resource_types=("DynamoDBTable",), category=DATABASE, severity=LOW,
         signal=SIG_UNDERUTILIZED, title="Provisioned DynamoDB capacity is mostly unused",
         description="Consumed capacity P95 under 20% of what is provisioned.",
         rationale="Provisioned capacity is billed per hour whether or not it is consumed.",
         remediation={AWS: "DynamoDB console → table → Additional settings → Read/write capacity."},
         risk=RISK_LOW, effort="LOW", evaluate=_dynamo_provisioned,
         metrics=("consumed_rcu", "consumed_wcu"),
         supersedes=("Convert DynamoDB to On-Demand Billing",)),
]
