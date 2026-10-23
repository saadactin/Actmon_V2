"""Account report templates, history and schedules, against the real database.

Run: venv\\Scripts\\python.exe tests\\verify_account_reports.py

What must never quietly flip:

  1 - templates: a saved request cannot carry hand-picked resources, a stray
      filter key is dropped (it used to be a TypeError / HTTP 500), names are
      unique ignoring case and cannot shadow a built-in.
  2 - history keeps the file, its request and a summary snapshot, and only
      the last KEEP_REPORTS_PER_ACCOUNT reports per account.
  3 - "since the last report" compares only figures both reports measured,
      and refuses a different scope.
  4 - schedules: created disabled; enabling needs a To address; ONE report
      per schedule per run (the database refuses a second); after downtime
      only the latest run is produced; a failure advances the schedule and
      takes the run's slot instead of retrying in a loop.
  5 - no e-mail is ever really queued by this suite: the notifier is replaced
      by a recorder before anything can reach it.

Creates and removes its own account, resources, findings, templates,
schedules and reports.
"""
import asyncio
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True
logging.getLogger("cloud_svc").setLevel(logging.CRITICAL)

from sqlalchemy import delete, func, select, text  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402

engine.echo = False

from app.models.account_report import (  # noqa: E402
    CloudAccountReport, CloudAccountReportSchedule, CloudReportTemplate,
)
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402
from app.models.security_finding import CloudSecurityFinding  # noqa: E402
from app.services import account_report_scheduler as sched_mod  # noqa: E402
from app.services import account_report_service as ars  # noqa: E402
from app.services.alerts import notifier  # noqa: E402

ok, fail = [], []
PREFIX = "zzacctrep-test-"
QUEUED = []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


async def _fake_queue_email(db, **kwargs):
    QUEUED.append(kwargs)
    return True, "Queued (test recorder)."


DELIVERY = {"ready": True, "blockers": []}


async def _fake_delivery(db):
    return dict(DELIVERY)


# The real notifier is never reachable from this suite.
notifier.queue_email = _fake_queue_email
notifier.delivery_status = _fake_delivery


async def ensure_tables():
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[
            CloudReportTemplate.__table__, CloudAccountReportSchedule.__table__,
            CloudAccountReport.__table__]))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_account_report_schedule_run "
            "ON cloud_account_reports (schedule_id, run_key) WHERE trigger = 'schedule'"))


async def purge(db):
    await db.execute(delete(CloudReportTemplate).where(CloudReportTemplate.name.like(f"{PREFIX}%")))
    ids = [r[0] for r in (await db.execute(
        select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%")))).all()]
    if ids:
        await db.execute(delete(CloudAccountReport).where(CloudAccountReport.account_id.in_(ids)))
        await db.execute(delete(CloudAccountReportSchedule).where(
            CloudAccountReportSchedule.account_id.in_(ids)))
        await db.execute(delete(CloudSecurityFinding).where(CloudSecurityFinding.account_id.in_(ids)))
        await db.execute(delete(CloudResource).where(CloudResource.account_id.in_(ids)))
        await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
    await db.commit()


def finding(account, resource, n, severity="HIGH"):
    return CloudSecurityFinding(
        id=uuid.uuid4(), account_id=account.id, provider="OCI",
        fingerprint=f"{PREFIX}sec-{n}", rule_id=f"test.rule.{n}", rule_version="1",
        resource_key=resource.provider_resource_id, resource_id=resource.id,
        resource_name=resource.resource_name, resource_type=resource.resource_type,
        title=f"Finding {n}", description="d", severity=severity, remediation="Fix it:\n  step 1",
        category="Exposure", verdict="VULNERABLE", confidence="HIGH", status="OPEN")


CONFIG = {"scope": {"mode": "account"}, "sections": {"security": True, "inventory": True},
          "date_range": {"preset": "7d", "timezone": "Asia/Kolkata"},
          "layout": {"format": "pdf", "detail_level": "standard"}}


async def main():
    await ensure_tables()
    async with AsyncSessionLocal() as db:
        await purge(db)
        try:
            await run(db)
        finally:
            await db.rollback()
            await purge(db)
            left = int((await db.execute(select(func.count()).select_from(CloudAccount).where(
                CloudAccount.account_name.like(f"{PREFIX}%")))).scalar() or 0)
            check("fixtures removed", left == 0)


async def run(db):
    account = CloudAccount(id=uuid.uuid4(), account_name=f"{PREFIX}oci", provider="OCI",
                           credentials_enc="x", tenant_or_region="ap-mumbai-1", environment="test")
    db.add(account)
    await db.flush()
    aid = account.id   # survives the rollbacks below, which expire ORM objects
    vm = CloudResource(id=uuid.uuid4(), account_id=account.id, provider_resource_id="ocid1.vm.zz",
                       resource_type="ComputeInstance", resource_name="zz-vm",
                       region_or_zone="ap-mumbai-1", status="RUNNING",
                       discovered_at=datetime.now(timezone.utc))
    db.add(vm)
    await db.flush()
    db.add(finding(account, vm, 1))
    await db.commit()

    print("\n1. Templates")
    t = await ars.save_template(db, {"name": f"{PREFIX}Weekly", "config": {
        **CONFIG, "scope": {"mode": "filtered", "filters": {"region": ["ap-mumbai-1"], "bogus": 1}}}},
        actor="test")
    eq("a stray filter key is dropped, the real one kept", t["config"]["scope"]["filters"],
       {"region": ["ap-mumbai-1"]})
    for bad, label, field in (
        ({"name": f"{PREFIX}weekly", "config": CONFIG}, "a duplicate name (any case) is refused", "name"),
        ({"name": "Security audit", "config": CONFIG}, "a built-in's name is refused", "name"),
        ({"name": f"{PREFIX}picked", "config": {**CONFIG, "scope": {"mode": "resources",
                                                                    "resource_ids": [str(vm.id)]}}},
         "hand-picked resources are refused", "scope"),
        ({"name": f"{PREFIX}empty", "config": {**CONFIG, "sections": {k: False for k in (
            "executive_summary", "inventory", "security", "data_quality")}}},
         "a template with no section is refused", "sections"),
    ):
        try:
            await ars.save_template(db, bad, actor="test")
            check(label, False)
        except ars.ReportError as exc:
            check(label, exc.field == field, exc.message)
    listed = await ars.list_templates(db)
    check("the list carries built-ins first, then saved ones",
          listed[0]["builtin"] and any(x["name"] == f"{PREFIX}Weekly" for x in listed))
    updated = await ars.save_template(db, {"name": f"{PREFIX}Weekly", "description": "d",
                                           "config": CONFIG}, actor="test",
                                      template_id=uuid.UUID(t["id"]))
    eq("an update keeps its own name without clashing with itself", updated["description"], "d")
    check("every built-in validates", all(ars.normalize_config(b["config"]) for b in ars.builtin_templates()))

    print("\n2. History")
    req = ars.request_from_config(account.id, CONFIG)
    row1, content1, info1 = await ars.produce(db, req, actor="test", template_name="Weekly")
    check("a generated report is kept with its file", row1 is not None and row1.size_bytes == len(content1)
          and content1[:4] == b"%PDF")
    check("the filename carries the account and template", info1["filename"].startswith(
        "zzacctrep-test-oci-weekly-assessment-"), info1["filename"])
    eq("its snapshot counts what it measured", (row1.summary["critical_or_high"], row1.summary["findings_total"]), (1, 1))
    check("...and not what it did not (no cost section, no cost figure)",
          "billed_cost_in_scope" not in row1.summary)
    fetched = await ars.get_with_content(db, account.id, row1.id)
    check("the stored file is the downloaded file", bytes(fetched.content) == content1)
    before = int((await db.execute(select(func.count()).select_from(CloudAccountReport).where(
        CloudAccountReport.account_id == account.id))).scalar())
    nokeep_row, nokeep_content, info_nokeep = await ars.produce(db, req, keep=False)
    after = int((await db.execute(select(func.count()).select_from(CloudAccountReport).where(
        CloudAccountReport.account_id == account.id))).scalar())
    check("keep=False produces the file but no history row",
          nokeep_row is None and nokeep_content[:4] == b"%PDF" and before == after
          and "report_id" not in info_nokeep)

    print("\n3. Since the last report")
    db.add(finding(account, vm, 2, "CRITICAL"))
    await db.commit()
    from app.services import report_service as rs
    _ids, _t, dataset, snapshot = await rs.build_for_request(db, req.model_copy(update={
        "sections": req.sections.model_copy(update={"executive_summary": True})}))
    await ars.attach_comparison(db, req, dataset, snapshot)
    since = dataset["sections"]["executive_summary"].get("since_last_report")
    check("the executive summary says what moved since the last report", since is not None and since["comparable"])
    ch = {c["metric"]: c for c in (since or {}).get("changes", [])}
    eq("one more critical finding is 'worse'", (ch["Critical/high findings"]["previous"],
                                                 ch["Critical/high findings"]["current"],
                                                 ch["Critical/high findings"]["trend"]), (1, 2, "worse"))
    check("a figure neither report measured is not compared", "Billed cost of resources in scope" not in ch)
    filtered = req.model_copy(update={"scope": req.scope.model_copy(update={
        "mode": "filtered", "filters": {"q": "zz-vm"}})})
    _i, _t2, ds2, snap2 = await rs.build_for_request(db, filtered.model_copy(update={
        "sections": req.sections.model_copy(update={"executive_summary": True})}))
    await ars.attach_comparison(db, filtered, ds2, snap2)
    since2 = ds2["sections"]["executive_summary"].get("since_last_report")
    check("a different scope is refused, with the reason", since2 and not since2["comparable"]
          and "different scope" in since2["reason"])

    print("\n4. Retention")
    for _ in range(ars.KEEP_REPORTS_PER_ACCOUNT + 2):
        await ars.produce(db, req.model_copy(update={"layout": req.layout.model_copy(update={"format": "json"})}))
    kept = int((await db.execute(select(func.count()).select_from(CloudAccountReport).where(
        CloudAccountReport.account_id == account.id))).scalar())
    eq(f"only the last {ars.KEEP_REPORTS_PER_ACCOUNT} are kept", kept, ars.KEEP_REPORTS_PER_ACCOUNT)

    print("\n5. Schedules")
    try:
        await ars.save_schedule(db, account.id, {"name": "x", "enabled": True, "config": CONFIG,
                                                 "recipients": {"to": []}}, actor="test")
        check("enabling without a To address is refused", False)
    except ars.ReportError as exc:
        check("enabling without a To address is refused", exc.field == "recipients")
    try:
        await ars.save_schedule(db, account.id, {"name": "x", "config": CONFIG,
                                                 "recipients": {"to": ["not-an-address"]}}, actor="test")
        check("an invalid address is refused", False)
    except ars.ReportError as exc:
        check("an invalid address is refused", exc.field == "recipients")
    off = await ars.save_schedule(db, account.id, {"name": "Off", "config": CONFIG}, actor="test")
    check("a schedule is disabled unless turned on, with no next run", not off["enabled"] and off["next_run_at"] is None)

    now = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)   # 11:30 IST, a Thursday
    weekly = await ars.save_schedule(db, account.id, {
        "name": "Weekly security", "enabled": True, "frequency": "weekly", "day_of_week": 0,
        "send_time": "09:00", "timezone": "Asia/Kolkata", "config": CONFIG,
        "recipients": {"to": ["ops@example.com"], "cc": "audit@example.com"}}, actor="test", now=now)
    eq("weekly Monday 09:00 IST is due Monday 03:30 UTC", weekly["next_run_at"], "2026-10-26T03:30:00+00:00")
    eq("a comma/space-separated CC is accepted", weekly["recipients"]["cc"], ["audit@example.com"])

    sched = await db.get(CloudAccountReportSchedule, uuid.UUID(weekly["id"]))
    # Pretend the service was down for three weeks.
    sched.next_run_at = datetime(2026, 10, 5, 3, 30, tzinfo=timezone.utc)
    await db.commit()
    plan = ars.plan_run(sched, now)
    eq("after downtime only the latest due run is produced", plan["run_key"], "2026-10-19")
    eq("...and the skipped runs are named", plan["skipped"], ["2026-10-05", "2026-10-12"])

    QUEUED.clear()
    outcomes = await sched_mod.run_due(now)
    mine = [o for o in outcomes if o["schedule_id"] == weekly["id"]]
    eq("one due schedule, one report", [o["outcome"] for o in mine], ["produced"])
    await db.refresh(sched)
    eq("the schedule moved to its next run", sched.next_run_at.isoformat(), "2026-10-26T03:30:00+00:00")
    check("...and says which runs it skipped", "Skipped 2 earlier run(s)" in (sched.last_message or ""))
    eq("the e-mail was queued once, to the schedule's recipients",
       [(q["to"], q["cc"]) for q in QUEUED], [(["ops@example.com"], ["audit@example.com"])])
    check("...with the report attached", QUEUED and QUEUED[0]["attachments"][0]["filename"].endswith(".pdf"))
    produced = (await db.execute(select(CloudAccountReport).where(
        CloudAccountReport.schedule_id == sched.id))).scalars().all()
    eq("the report row is marked queued (not 'sent')", [r.delivery_status for r in produced], ["QUEUED"])

    again = await sched_mod.run_due(now)
    check("running the tick again produces nothing (not due any more)",
          not [o for o in again if o["schedule_id"] == weekly["id"]])
    QUEUED.clear()
    sched.next_run_at = datetime(2026, 10, 19, 3, 30, tzinfo=timezone.utc)   # bookkeeping "lost"
    await db.commit()
    lost = await sched_mod.run_due(now)
    eq("a run whose bookkeeping was lost is not produced twice",
       [o["outcome"] for o in lost if o["schedule_id"] == weekly["id"]], ["already_produced"])
    eq("...and nothing was e-mailed", QUEUED, [])
    try:
        db.add(CloudAccountReport(account_id=account.id, schedule_id=sched.id, run_key="2026-10-19",
                                  trigger="schedule", format="pdf"))
        await db.commit()
        check("the database itself refuses a second report for one run", False)
    except IntegrityError:
        await db.rollback()
        check("the database itself refuses a second report for one run", True)

    DELIVERY.update(ready=False, blockers=[{"message": "SMTP is not configured."}])
    QUEUED.clear()
    sched_id = uuid.UUID(weekly["id"])   # the rollback above expired `sched`
    row = await ars.run_schedule_now(db, aid, sched_id, actor="test", send=True)
    sched = await db.get(CloudAccountReportSchedule, sched_id)
    eq("when delivery is not set up the report is kept and says why",
       (row["delivery_status"], QUEUED), ("DELIVERY_NOT_READY", []))
    DELIVERY.update(ready=True, blockers=[])
    await db.refresh(sched)
    eq("'run now' does not move the schedule", sched.next_run_at.isoformat(), "2026-10-26T03:30:00+00:00")

    broken = await ars.save_schedule(db, aid, {
        "name": "Broken", "enabled": True, "frequency": "monthly", "day_of_month": 1,
        "config": {**CONFIG, "scope": {"mode": "filtered", "filters": {"q": "matches-nothing-zz"}}},
        "recipients": {"to": ["ops@example.com"]}}, actor="test", now=now)
    bsched = await db.get(CloudAccountReportSchedule, uuid.UUID(broken["id"]))
    bsched.next_run_at = datetime(2026, 10, 1, 3, 30, tzinfo=timezone.utc)
    await db.commit()
    QUEUED.clear()
    bout = [o for o in await sched_mod.run_due(now) if o["schedule_id"] == broken["id"]]
    eq("a report that cannot be built is recorded as failed", [o["outcome"] for o in bout], ["failed"])
    await db.refresh(bsched)
    check("...the schedule still advances, with the reason",
          bsched.next_run_at > now and bsched.last_status == "FAILED"
          and "matches no resources" in (bsched.last_message or ""), bsched.last_message)
    failed_rows = (await db.execute(select(CloudAccountReport).where(
        CloudAccountReport.schedule_id == bsched.id))).scalars().all()
    eq("...and its failed row takes the run's slot", [(r.status, r.run_key) for r in failed_rows],
       [("FAILED", "2026-10-01")])
    eq("nothing was e-mailed for it", QUEUED, [])


asyncio.run(main())
print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print(f"  - {f}")
sys.exit(1 if fail else 0)
