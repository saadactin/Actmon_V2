"""Resource Intelligence: persistence, resolution, the unified list, the API.

Postgres fixtures (`zzintel-test-`), driven through the ASGI app. No provider
is contacted: fixture accounts carry undecryptable credentials, so the full
analyze path runs and records every telemetry metric as an ERROR — which is
itself one of the things checked.

What must hold:

* **Resolution needs evidence.** A finding closes when its own rule re-checked
  the resource and found the condition gone, or when a COMPLETE sweep no longer
  has the resource. An INSUFFICIENT_DATA re-check, or a resource missing from
  a PARTIAL sweep, leaves it open — with `last_check` saying why.
* **A person's decision stands.** Suppressed stays suppressed on re-detection;
  resolved-by-person reopens if the condition is still there.
* **One list, two engines, no mixing.** Security findings come from the
  Security Center's table under a mapped category; its Cost/Performance
  categories and undetermined checks are not listed; nothing is re-evaluated.
* **Every summary card equals the list it filters to.**
* **Permissions follow the finding's engine.**
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
# The labels use arrows and ellipses; a cp1252 console would crash on them.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)
logging.getLogger("cloud_svc").setLevel(logging.CRITICAL)

import httpx  # noqa: E402
from sqlalchemy import delete, select, text  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
engine.echo = False
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.discovery_job import DiscoveryJob  # noqa: E402
from app.models.optimization import (  # noqa: E402
    CloudOptimizationFinding, CloudOptimizationRun, CloudResourceTelemetry,
)
from app.models.resource import CloudResource  # noqa: E402
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding  # noqa: E402
from app.optimization import engine as opt_engine  # noqa: E402
from app.optimization.telemetry import ST_ERROR, MetricResult, ResourceTelemetry  # noqa: E402
from app.repository.optimization_repo import OptimizationRepository  # noqa: E402

BASE = "/api/v1/cloud/intelligence"
PREFIX = "zzintel-test-"
NOW = datetime.now(timezone.utc)
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def token_for(role):
    import jwt as _jwt
    from app.core.config import settings as _settings
    return _jwt.encode({"sub": f"{role}@example.com", "role": role,
                        "exp": datetime.now(timezone.utc) + timedelta(minutes=10)},
                       _settings.JWT_SECRET, algorithm=_settings.JWT_ALGORITHM)


async def purge():
    async with AsyncSessionLocal() as db:
        ids = (await db.execute(select(CloudAccount.id).where(
            CloudAccount.account_name.like(f"{PREFIX}%")))).scalars().all()
        if ids:
            for model in (CloudOptimizationFinding, CloudOptimizationRun, CloudResourceTelemetry,
                          CloudSecurityFinding, CloudSecurityAssessment, DiscoveryJob):
                await db.execute(delete(model).where(model.account_id.in_(ids)))
            await db.execute(delete(CloudResource).where(CloudResource.account_id.in_(ids)))
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.commit()
        return len(ids)


async def make_account(name, provider):
    async with AsyncSessionLocal() as db:
        a = CloudAccount(account_name=f"{PREFIX}{name}", provider=provider, environment="Test",
                         tenant_or_region="r1", auth_mode="API_Keys", auto_discovery=False,
                         credentials_enc="junk", last_discovery=NOW)
        db.add(a)
        await db.commit()
        return a


async def add_resource(account_id, rtype, pid, name, *, config=None, status=None, nstatus=None,
                       region="centralindia", attachment_state=None):
    async with AsyncSessionLocal() as db:
        r = CloudResource(account_id=account_id, provider_resource_id=pid, resource_type=rtype,
                          resource_name=name, region_or_zone=region, status=status,
                          normalized_status=nstatus, attachment_state=attachment_state,
                          config=config or {}, metadata_={}, tags={}, last_seen_at=NOW)
        db.add(r)
        await db.commit()
        return r


async def set_config(resource_id, config):
    async with AsyncSessionLocal() as db:
        r = await db.get(CloudResource, resource_id)
        r.config = config
        await db.commit()


async def delete_resource(resource_id):
    async with AsyncSessionLocal() as db:
        await db.execute(delete(CloudResource).where(CloudResource.id == resource_id))
        await db.commit()


async def add_security(account_id, fp, *, category, severity="HIGH", verdict="VULNERABLE",
                       status="OPEN", compliance=None, resource=None):
    async with AsyncSessionLocal() as db:
        db.add(CloudSecurityFinding(
            account_id=account_id, provider="AZURE", fingerprint=fp, rule_id=f"TEST_{fp}",
            rule_version="1.0", resource_key=resource.provider_resource_id if resource else None,
            resource_id=resource.id if resource else None,
            resource_name=resource.resource_name if resource else None,
            resource_type=resource.resource_type if resource else None, region="centralindia",
            title=f"Security {fp}", description=f"desc {fp}", remediation="fix it",
            severity=severity, category=category, verdict=verdict, confidence="HIGH",
            status=status, evidence={"quote": "provider payload"}, compliance=compliance or {},
            first_detected_at=NOW, last_detected_at=NOW))
        await db.commit()


async def analyse_and_persist(account_id, *, sweep_complete=True, telemetry=None):
    """The engine + the repository — the two production pieces the analyze
    path uses for reconciliation — over whatever is in the inventory now."""
    async with AsyncSessionLocal() as db:
        resources = (await db.execute(select(CloudResource).where(
            CloudResource.account_id == account_id))).scalars().all()
        analysis = opt_engine.analyze(account_id=str(account_id), provider="Azure",
                                      resources=resources, telemetry=telemetry or {},
                                      sweep_complete=sweep_complete)
        repo = OptimizationRepository(db)
        run_id = uuid.uuid4()
        stats = await repo.persist(account_id=account_id, analysis=analysis, run_id=run_id,
                                   sweep_complete=sweep_complete)
        await repo.record_run(run_id=run_id, account_id=account_id, analysis=analysis,
                              persist_stats=stats, triggered_by="test", discovery_scan_id=None,
                              telemetry={}, inputs={}, savings_by_currency={}, findings_open=0)
        await db.commit()
        return stats


async def finding_row(account_id, rule_id, resource_key):
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id == account_id,
            CloudOptimizationFinding.rule_id == rule_id,
            CloudOptimizationFinding.resource_key == resource_key))).scalar_one_or_none()


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[
            CloudOptimizationFinding.__table__, CloudOptimizationRun.__table__,
            CloudResourceTelemetry.__table__]))
    print(f"(purged {await purge()} leftover fixture accounts)")
    acc = await make_account("azure", "Azure")
    aid = acc.id
    free_ip = await add_resource(aid, "PublicIP", "/pip/free", "free-ip",
                                 config={"attached_to_id": None, "nat_gateway_id": None,
                                         "sku": "Standard", "allocation_method": "Static"})
    used_ip = await add_resource(aid, "PublicIP", "/pip/used", "used-ip",
                                 config={"attached_to_id": "/nic/1", "nat_gateway_id": None})
    nic = await add_resource(aid, "NetworkInterface", "/nic/orphan", "orphan-nic",
                             config={"attachment_status": "Unattached", "private_ip": "10.0.0.9"})
    vm = await add_resource(aid, "VirtualMachine", "/vm/stopped", "stopped-vm", nstatus="STOPPED",
                            config={"power_state": "VM stopped", "vm_size": "Standard_D2s_v3"})

    await add_security(aid, "sec-exposure", category="Exposure", severity="CRITICAL",
                       compliance={"CIS Azure": ["6.1"]}, resource=vm)
    await add_security(aid, "sec-tags", category="Governance", severity="LOW")
    await add_security(aid, "sec-cost", category="Cost", severity="MEDIUM")
    await add_security(aid, "sec-unknown", category="Encryption", verdict="UNKNOWN")

    # ── 1. First analysis ───────────────────────────────────────────────────
    print("\n1. First analysis: findings are created with history")
    stats = await analyse_and_persist(aid)
    eq("four optimization findings: free IP, orphan NIC, and the stopped D2s_v3 VM (still billing; previous generation)", stats["new"], 4)
    row = await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/free")
    check("the free IP's finding exists and is OPEN", row is not None and row.status == "OPEN")
    eq("its history starts with 'detected'", row.history[0]["event"], "detected")
    eq("the associated IP produced no finding", await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/used"), None)

    tr = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=tr, base_url="http://t") as c:
        # ── 2. The unified list ─────────────────────────────────────────────
        print("\n2. One list over two engines")
        r = await c.get(f"{BASE}/{aid}/findings")
        eq("the list answers 200", r.status_code, 200)
        body = r.json()
        keys = {(f["source"], f["key"]) for f in body["findings"]}
        check("security findings from the Security Center's table are listed",
              ("security", "sec-exposure") in keys and ("security", "sec-tags") in keys)
        check("the security engine's Cost category is NOT listed (superseded here)",
              ("security", "sec-cost") not in keys)
        check("an undetermined security check is not listed by default",
              ("security", "sec-unknown") not in keys)
        eq("total = 4 optimization + 2 security", body["total"], 6)
        tags = next(f for f in body["findings"] if f["key"] == "sec-tags")
        eq("the security Governance finding is shown under TAGGING", tags["category"], "TAGGING")
        eq("…keeping its own category as the subcategory", tags["subcategory"], "Governance")
        r = await c.get(f"{BASE}/{aid}/findings", params={"include_undetermined": "true"})
        eq("include_undetermined brings the UNKNOWN check back", r.json()["total"], 7)
        r = await c.get(f"{BASE}/{aid}/findings", params={"category": "COMPLIANCE"})
        eq("COMPLIANCE is a lens: security findings that cite a control",
           [f["key"] for f in r.json()["findings"]], ["sec-exposure"])
        r = await c.get(f"{BASE}/{aid}/findings", params={"category": "SECURITY"})
        eq("SECURITY excludes the one mapped to TAGGING", [f["key"] for f in r.json()["findings"]],
           ["sec-exposure"])
        r = await c.get(f"{BASE}/{aid}/findings", params={"source": "optimization", "limit": 2})
        p1 = r.json()
        r = await c.get(f"{BASE}/{aid}/findings", params={"source": "optimization", "limit": 2, "offset": 2})
        p2 = r.json()
        page_keys = [f["key"] for f in p1["findings"] + p2["findings"]]
        eq("paging covers every row exactly once", (len(page_keys), len(set(page_keys))), (4, 4))
        facets = body["facets"]
        eq("the category facet counts what the list holds",
           sum(f["count"] for f in facets["category"] if f["value"] != "COMPLIANCE"), body["total"])
        first = body["findings"][0]
        eq("worst first: the CRITICAL security finding leads", first["key"], "sec-exposure")
        r = await c.get(f"{BASE}/{aid}/findings", params={"search": "orphan"})
        eq("search matches the resource name", [f["resource"]["name"] for f in r.json()["findings"]],
           ["orphan-nic"])

        # ── 3. Summary cards equal their lists ──────────────────────────────
        print("\n3. Every summary card equals the list it filters to")
        s = (await c.get(f"{BASE}/{aid}/summary")).json()
        cards = {x["id"]: x for x in s["cards"]}
        for cid in ("critical", "high", "optimization", "security"):
            params = {k: ",".join(v) if isinstance(v, list) else v
                      for k, v in (cards[cid]["filter"] or {}).items()}
            total = (await c.get(f"{BASE}/{aid}/findings", params=params)).json()["total"]
            eq(f"card '{cid}' = its list's total", cards[cid]["value"], total)
        unused = (await c.get(f"{BASE}/{aid}/findings", params={"signal": "UNUSED"})).json()
        eq("'Unused resources' counts distinct resources behind UNUSED findings",
           cards["unused"]["value"], len({f["resource"]["id"] for f in unused["findings"]}))
        eq("undetermined security checks are reported beside the card, not in it",
           cards["security"]["undetermined"], 1)
        eq("no priced saving → the savings card carries no invented total",
           cards["savings"]["by_currency"], {})
        eq("the latest analysis is in the header", s["last_analysis"]["resources_total"], 4)

        # ── 4. Detail ───────────────────────────────────────────────────────
        print("\n4. One finding, everything connected to it")
        fp_ip = row.fingerprint
        d = (await c.get(f"{BASE}/{aid}/findings/optimization/{fp_ip}")).json()
        for section in ("evidence", "safety", "data_sources", "impact", "links", "health",
                        "rule", "telemetry", "cost", "history"):
            check(f"detail carries '{section}'", section in d)
        check("safety says whether it can be applied, with checks",
              d["safety"].get("verdict") and d["safety"].get("checks"))
        eq("cost with no billing row is NA with a reason", d["cost"]["billed"], None)
        check("…and the per-resource daily series is honestly absent", d["cost"]["daily"] is None
              and d["cost"]["daily_reason"])
        eq("'Create alert' offers the intelligence condition", d["links"]["alert"]["condition"],
           "intelligence_finding_count")
        viewer = {"Authorization": f"Bearer {token_for('viewer')}"}
        sd = (await c.get(f"{BASE}/{aid}/findings/security/sec-exposure", headers=viewer)).json()
        eq("a viewer sees a security finding with its evidence withheld",
           list(sd["evidence_raw"].keys()), ["_withheld"])
        eq("unknown finding → 404", (await c.get(f"{BASE}/{aid}/findings/optimization/nope")).status_code, 404)
        eq("unknown source → 404", (await c.get(f"{BASE}/{aid}/findings/bogus/x")).status_code, 404)

        # ── 5. Status: permissions follow the engine ────────────────────────
        print("\n5. Status changes and who may make them")
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{fp_ip}/status",
                         json={"status": "ACKNOWLEDGED"}, headers=viewer)
        eq("a viewer may not triage", r.status_code, 403)
        analyst = {"Authorization": f"Bearer {token_for('security_analyst')}"}
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{fp_ip}/status",
                         json={"status": "ACKNOWLEDGED"}, headers=analyst)
        eq("an analyst may acknowledge", (r.status_code, r.json().get("status")), (200, "ACKNOWLEDGED"))
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{fp_ip}/status",
                         json={"status": "SUPPRESSED", "reason": "kept for DR"}, headers=analyst)
        eq("…but not suppress", r.status_code, 403)
        admin = {"Authorization": f"Bearer {token_for('administrator')}"}
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{fp_ip}/status",
                         json={"status": "SUPPRESSED"}, headers=admin)
        eq("suppressing without a reason is refused", r.status_code, 400)
        nic_row = await finding_row(aid, "NIC_UNATTACHED", "/nic/orphan")
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{nic_row.fingerprint}/status",
                         json={"status": "SUPPRESSED", "reason": "reserved for a rebuild"}, headers=admin)
        eq("an admin may suppress with a reason", r.json().get("status"), "SUPPRESSED")
        r = await c.post(f"{BASE}/{aid}/findings/security/sec-exposure/status",
                         json={"status": "ACKNOWLEDGED"}, headers=analyst)
        eq("acknowledging a SECURITY finding sets the Security Center's IN_PROGRESS",
           (r.status_code, r.json().get("status"), r.json().get("status_group")),
           (200, "IN_PROGRESS", "ACKNOWLEDGED"))

        # ── 6. Resolution needs evidence ────────────────────────────────────
        print("\n6. Resolution, reopening, and decisions that stand")
        await set_config(free_ip.id, {"attached_to_id": "/nic/2", "nat_gateway_id": None})
        stats = await analyse_and_persist(aid)
        row = await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/free")
        eq("re-checked and now associated → RESOLVED as condition_cleared",
           (row.status, (row.resolution or {}).get("kind")), ("RESOLVED", "condition_cleared"))
        check("the resolution keeps a snapshot of what the finding said before",
              bool((row.resolution or {}).get("before", {}).get("evidence")))
        d = (await c.get(f"{BASE}/{aid}/findings/optimization/{row.fingerprint}")).json()
        eq("the detail's 'what happened after' reads the resolution", d["outcome"]["kind"], "condition_cleared")

        await set_config(free_ip.id, {"attached_to_id": None, "nat_gateway_id": None})
        await analyse_and_persist(aid)
        row = await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/free")
        eq("detected again → REOPENED", row.status, "OPEN")
        check("…and the history says so", any(h["event"] == "reopened" for h in row.history))
        nic_row = await finding_row(aid, "NIC_UNATTACHED", "/nic/orphan")
        eq("a suppressed finding re-detected stays SUPPRESSED", nic_row.status, "SUPPRESSED")

        await delete_resource(vm.id)
        await analyse_and_persist(aid, sweep_complete=False)
        vrow = await finding_row(aid, "COMPUTE_STOPPED_STILL_BILLING", "/vm/stopped")
        eq("a resource missing from a PARTIAL sweep is NOT resolved", vrow.status, "OPEN")
        eq("…and last_check says it was not evaluated", (vrow.last_check or {}).get("verdict"),
           "NOT_EVALUATED")
        await analyse_and_persist(aid, sweep_complete=True)
        vrow = await finding_row(aid, "COMPUTE_STOPPED_STILL_BILLING", "/vm/stopped")
        eq("missing from a COMPLETE sweep → RESOLVED as resource_removed",
           (vrow.status, (vrow.resolution or {}).get("kind")), ("RESOLVED", "resource_removed"))

        # A running VM whose CPU telemetry failed: its rightsizing rule cannot
        # decide, and a stored finding for it must stay open.
        busy_vm = await add_resource(aid, "VirtualMachine", "/vm/running", "running-vm",
                                     nstatus="RUNNING",
                                     config={"vm_size": "Standard_D4as_v5", "power_state": "VM running"})
        async with AsyncSessionLocal() as db:
            db.add(CloudOptimizationFinding(
                account_id=aid, provider="AZURE", fingerprint="zz-manual-vm", rule_id="COMPUTE_UNDERUTILIZED",
                rule_version="1.0", resource_key="/vm/running", resource_id=busy_vm.id,
                resource_name="running-vm", resource_type="VirtualMachine", category="RIGHTSIZING",
                severity="MEDIUM", title="t", description="d", confidence="MEDIUM", status="OPEN",
                history=[]))
            await db.commit()
        failed_tm = ResourceTelemetry()
        failed_tm.metrics["cpu_percent"] = MetricResult("cpu_percent", ST_ERROR, reason="timeout")
        await analyse_and_persist(aid, telemetry={str(busy_vm.id): failed_tm})
        async with AsyncSessionLocal() as db:
            frow = (await db.execute(select(CloudOptimizationFinding).where(
                CloudOptimizationFinding.fingerprint == "zz-manual-vm"))).scalar_one()
        eq("a re-check that could not decide (telemetry ERROR) leaves the finding OPEN", frow.status, "OPEN")
        eq("…with last_check INSUFFICIENT_DATA", (frow.last_check or {}).get("verdict"), "INSUFFICIENT_DATA")

        row = await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/free")
        r = await c.post(f"{BASE}/{aid}/findings/optimization/{row.fingerprint}/status",
                         json={"status": "RESOLVED", "reason": "released it"}, headers=analyst)
        eq("a person may mark it resolved", r.json().get("status"), "RESOLVED")
        await analyse_and_persist(aid)
        row = await finding_row(aid, "PUBLIC_IP_UNUSED", "/pip/free")
        eq("…and the next analysis reopens it when the condition is still there", row.status, "OPEN")
        eq("…stamping the reopening as the analysis's, so an older Cost-tab decision gives way",
           row.status_changed_by, "analysis")

        # A severity change is counted by its direction.
        async with AsyncSessionLocal() as db:
            nrow = (await db.execute(select(CloudOptimizationFinding).where(
                CloudOptimizationFinding.fingerprint == nic_row.fingerprint))).scalar_one()
            nrow.severity = "CRITICAL"
            await db.commit()
        stats = await analyse_and_persist(aid)
        eq("a finding re-checked at a LOWER severity is de-escalated, not 'escalated'",
           (stats.get("deescalated"), stats.get("escalated")), (1, 0))

        # ── 7. Health, coverage, runs, data_version ─────────────────────────
        print("\n7. Health, coverage, runs, tab sync")
        h = (await c.get(f"{BASE}/{aid}/resources/{nic.id}/health")).json()
        check("health lists every dimension", set(h["dimensions"]) >= {"security", "cost", "performance"})
        eq("performance was never measured for a NIC → N/A", h["dimensions"]["performance"]["score"], None)
        check("…and says 'based on available data'", h["basis"] == "Score based on available data")
        cov = (await c.get(f"{BASE}/{aid}/coverage")).json()
        pip = next(x for x in cov["rules"] if x["rule_id"] == "PUBLIC_IP_UNUSED")
        eq("coverage counts what the rule evaluated in the latest run", pip["evaluated"], 2)
        check("the coverage panel lists what cannot be measured", len(cov["not_measurable"]) >= 5)
        runs = (await c.get(f"{BASE}/{aid}/runs")).json()["runs"]
        check("each analysis is recorded as a run", len(runs) >= 6)
        from app.services.account_refresh_service import AccountRefreshService
        async with AsyncSessionLocal() as db:
            latest = await AccountRefreshService(db).latest(aid)
        check("an analysis moves data_version, so every tab re-reads",
              latest.get("data_version") and latest["data_version"] >= runs[0]["at"][:19],
              f"{latest.get('data_version')} vs {runs[0]['at']}")

        # ── 8. The analyze endpoint ─────────────────────────────────────────
        print("\n8. POST /analyze: busy refusal, and a full run with no provider reachable")
        async with AsyncSessionLocal() as db:
            job = DiscoveryJob(account_id=aid, status="RUNNING", started_at=NOW)
            db.add(job)
            await db.commit()
            job_id = job.id
        r = await c.post(f"{BASE}/{aid}/analyze", headers=admin)
        eq("409 while a discovery scan runs (its own analysis is coming)", r.status_code, 409)
        async with AsyncSessionLocal() as db:
            await db.execute(delete(DiscoveryJob).where(DiscoveryJob.id == job_id))
            await db.commit()
        r = await c.post(f"{BASE}/{aid}/analyze", headers=viewer)
        eq("a viewer may not run an analysis (it contacts the provider)", r.status_code, 403)
        r = await c.post(f"{BASE}/{aid}/analyze", headers=admin)
        eq("the full analyze path runs", r.status_code, 200, )
        out = r.json()
        eq("undecryptable credentials make the run PARTIAL, never COMPLETE", out.get("outcome"), "PARTIAL")
        check("…and the reason names the credentials",
              any("decrypt" in x.lower() or "credential" in x.lower() for x in out.get("incomplete_reasons", [])),
              out.get("incomplete_reasons"))
        async with AsyncSessionLocal() as db:
            statuses = {r.status for r in (await db.execute(select(CloudResourceTelemetry).where(
                CloudResourceTelemetry.account_id == aid))).scalars().all()}
        check("every telemetry row it wrote is an ERROR — none pretends to be data",
              statuses <= {ST_ERROR, "SKIPPED", "NOT_COLLECTED"} and bool(statuses), statuses)

    print(f"\n(purged {await purge()} fixture accounts)")
    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    sys.exit(1 if fail else 0)


asyncio.run(main())
