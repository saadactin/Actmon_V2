"""Clients, the portfolio, and monthly client reports — over HTTP and the DB.

Driven through the ASGI app (no bound port), against throwaway `zzclients-test-`
fixtures that are purged on the way in and on the way out.

What this suite exists to pin:

* **Names are unique case-insensitively**, and moving an account between
  clients is reported as a move.
* **Deleting a client never deletes an account.**
* **The portfolio never averages posture and never adds currencies.**
* **A report's numbers are the stored ones** for the period — billing,
  changes and alerts inside the month only — and it lists its own gaps.
* **Scheduled reports cannot repeat.** A second scheduled report for the same
  client and month is refused by the database itself; a late scheduler runs
  once and names the months it skipped; a failed build still advances.
* **An e-mailed report carries the PDF as an attachment** — checked inside a
  transaction that is then rolled back, so this suite can never leave a mail
  in the real queue.
"""
import asyncio
import base64
import logging
import os
import pathlib
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import delete, func, select, text, update  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app.core import schema_patches  # noqa: E402
from app.core.database import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.alert import CloudAlert  # noqa: E402
from app.models.client import (  # noqa: E402
    TRIGGER_SCHEDULE, CloudClient, CloudClientReport, CloudClientReportSchedule,
)
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_fact import STABLE, CloudCostFact, build_fact_key  # noqa: E402
from app.models.credential_inventory import (  # noqa: E402
    COLLECT_OK, KIND_CERTIFICATE, CloudCredentialObject, CloudCredentialSource,
)
from app.models.drift import CloudResourceChange  # noqa: E402
from app.models.security_finding import CloudSecurityAssessment  # noqa: E402

BASE = "/api/v1/cloud/clients"
PREFIX = "zzclients-test-"
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


def hdr(role):
    return {"Authorization": f"Bearer {token_for(role)}"}


NOW = datetime.now(timezone.utc)
THIS_MONTH = NOW.date().replace(day=1)
PERIOD_START = (THIS_MONTH - timedelta(days=1)).replace(day=1)
PERIOD = PERIOD_START.strftime("%Y-%m")


# ── Fixtures ─────────────────────────────────────────────────────────────────
async def purge() -> int:
    async with AsyncSessionLocal() as db:
        ids = (await db.execute(select(CloudAccount.id).where(
            CloudAccount.account_name.like(f"{PREFIX}%")))).scalars().all()
        if ids:
            for model in (CloudCostFact, CloudResourceChange, CloudAlert,
                          CloudSecurityAssessment, CloudCredentialObject,
                          CloudCredentialSource):
                await db.execute(delete(model).where(model.account_id.in_(ids)))
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        n = (await db.execute(delete(CloudClient).where(
            CloudClient.name.like(f"{PREFIX}%")))).rowcount
        await db.commit()
        return len(ids) + (n or 0)


async def make_account(name, provider, client_id=None, score=None, finished=None):
    async with AsyncSessionLocal() as db:
        a = CloudAccount(account_name=f"{PREFIX}{name}", provider=provider,
                         environment="Test", tenant_or_region="r1", auth_mode="API_Keys",
                         auto_discovery=False, credentials_enc="junk", client_id=client_id,
                         last_discovery=NOW - timedelta(days=1))
        db.add(a)
        await db.flush()
        if score is not None:
            db.add(CloudSecurityAssessment(
                account_id=a.id, provider=provider.upper(), outcome="COMPLETE",
                score=score, grade="F" if score < 60 else "C", score_reliable=True,
                coverage_pct=80.0, resources_evaluated=5, rules_evaluated=10,
                started_at=finished, finished_at=finished))
        await db.commit()
        return a.id


async def add_costs(account_id, provider, currency, days_amounts):
    async with AsyncSessionLocal() as db:
        for d, amt in days_amounts:
            db.add(CloudCostFact(
                account_id=account_id, provider=provider, billing_date=d, service="Compute",
                amount=amt, currency=currency, source="test", finality=STABLE,
                fact_key=build_fact_key(account_id=account_id, provider=provider,
                                        billing_date=d, service="Compute", region=None,
                                        resource_id=None, usage_type=None,
                                        currency=currency)))
        await db.commit()


async def main() -> int:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [SKIP] Postgres is not reachable ({exc}); these are NOT passes")
        return 1
    await schema_patches.apply_standalone()
    left = await purge()
    if left:
        print(f"  (purged {left} fixture row(s) left by an earlier run)")

    # Delivery is forced NOT ready unless a section says otherwise, so no path
    # in this suite can queue a real e-mail.
    import app.services.alerts.notifier as notifier
    real_delivery = notifier.delivery_status

    async def _not_ready(db):
        return {"ready": False, "blockers": [{"code": "test", "message": "test: not ready"}]}
    notifier.delivery_status = _not_ready

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            await run(c)
    finally:
        notifier.delivery_status = real_delivery
        await purge()
        async with AsyncSessionLocal() as db:
            leaked = (await db.execute(text(
                "SELECT count(*) FROM notification_queue "
                "WHERE payload->>'source' = 'cloud_client_report' "
                "AND payload->>'subject' LIKE :p"), {"p": f"%{PREFIX}%"})).scalar()
        eq("no e-mail from this suite was left in the notification queue", leaked, 0)
        await engine.dispose()

    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        print("\nFAILURES:")
        for f in fail:
            print(f"  ! {f}")
    return 1 if fail else 0


async def run(c: httpx.AsyncClient) -> None:
    print("\n=== A. Creating clients ===")
    r = await c.post(BASE, json={"name": f"{PREFIX}Acme", "code": "ZZACME",
                                 "contact_emails": ["ops@example.com"]})
    eq("create -> 201", r.status_code, 201)
    acme = r.json()
    eq("...returns the stored name", acme.get("name"), f"{PREFIX}Acme")
    r = await c.post(BASE, json={"name": f"{PREFIX}ACME"})
    eq("the same name in another case -> 409", r.status_code, 409)
    r = await c.post(BASE, json={"name": f"{PREFIX}Other", "code": "zzacme"})
    eq("a code already used (any case) -> 409", r.status_code, 409)
    r = await c.post(BASE, json={"name": "  "})
    eq("a blank name -> 400", r.status_code, 400)
    r = await c.post(BASE, json={"name": f"{PREFIX}Bad", "contact_emails": ["not-an-email"]})
    eq("an invalid contact e-mail -> 400", r.status_code, 400)
    r = await c.post(BASE, json={"name": f"{PREFIX}Bad", "code": "has spaces!"})
    eq("an invalid code -> 400", r.status_code, 400)
    r = await c.post(BASE, json={"name": f"{PREFIX}Globex", "code": "ZZGLOBEX"})
    globex = r.json()
    r = await c.patch(f"{BASE}/{globex['id']}", json={"description": "Second client"})
    eq("PATCH changes only what was sent", (r.status_code, r.json().get("name")),
       (200, f"{PREFIX}Globex"))

    acme_id, globex_id = uuid.UUID(acme["id"]), uuid.UUID(globex["id"])
    in_period = datetime.combine(PERIOD_START + timedelta(days=20), datetime.min.time(),
                                 tzinfo=timezone.utc)
    a_aws = await make_account("aws", "AWS", score=72, finished=in_period)
    a_oci = await make_account("oci", "OCI", score=41, finished=in_period)
    a_free = await make_account("azure", "Azure")

    print("\n=== B. Assigning accounts ===")
    r = await c.put(f"{BASE}/{acme['id']}/accounts",
                    json={"account_ids": [str(a_aws), str(a_oci), str(uuid.uuid4())]})
    body = r.json()
    eq("assign -> 200", r.status_code, 200)
    eq("...both real accounts assigned", sorted(body.get("assigned", [])),
       sorted([str(a_aws), str(a_oci)]))
    eq("...an unknown id is reported, not silently ignored", len(body.get("not_found", [])), 1)
    r = await c.put(f"{BASE}/{globex['id']}/accounts", json={"account_ids": [str(a_oci)]})
    moved = r.json().get("moved") or []
    check("moving an account to another client is reported as a move, with its origin",
          len(moved) == 1 and moved[0].get("from_client_name") == f"{PREFIX}Acme", str(moved))
    r = await c.put(f"{BASE}/{acme['id']}/accounts", json={"account_ids": [str(a_oci)]})
    r = await c.delete(f"{BASE}/{globex['id']}/accounts/{a_oci}")
    eq("unassigning an account the client does not have -> 404", r.status_code, 404)
    r = await c.get("/api/v1/cloud/accounts")
    names = {x["id"]: x.get("client_name") for x in r.json()}
    eq("the account list carries the client name", names.get(str(a_aws)), f"{PREFIX}Acme")

    # Spend: this month + last month; AWS in USD, OCI in INR.
    await add_costs(a_aws, "AWS", "USD", [(PERIOD_START + timedelta(days=i), 10.0)
                                          for i in range(3)])
    await add_costs(a_aws, "AWS", "USD", [(THIS_MONTH, 7.5)])
    await add_costs(a_oci, "OCI", "INR", [(PERIOD_START + timedelta(days=4), 1500.0)])
    await add_costs(a_oci, "OCI", "INR", [(THIS_MONTH, 250.0)])
    async with AsyncSessionLocal() as db:
        db.add(CloudResourceChange(
            account_id=a_aws, provider_resource_id="sg-1", resource_type="SecurityGroup",
            change_type="MODIFIED", severity="HIGH", summary="opened 22",
            detected_at=in_period))
        db.add(CloudResourceChange(
            account_id=a_aws, provider_resource_id="sg-2", resource_type="SecurityGroup",
            change_type="MODIFIED", severity="LOW", summary="outside the period",
            detected_at=NOW))
        db.add(CloudAlert(account_id=a_aws, anomaly_type="test", severity="HIGH",
                          details="in period", created_at=in_period, last_seen_at=in_period))
        db.add(CloudCredentialSource(account_id=a_oci, provider="OCI",
                                     source="oci:certificates", scope="r1", status=COLLECT_OK,
                                     last_attempt_at=NOW, last_success_at=NOW))
        db.add(CloudCredentialObject(account_id=a_oci, provider="OCI",
                                     source="oci:certificates", source_scope="r1",
                                     kind=KIND_CERTIFICATE, object_key=f"{PREFIX}cert-1",
                                     name="shop.example.test",
                                     expires_at=NOW + timedelta(days=10)))
        await db.commit()

    print("\n=== C. The portfolio ===")
    r = await c.get(f"{BASE}/portfolio")
    eq("portfolio -> 200", r.status_code, 200)
    p = r.json()
    row = next((x for x in p["clients"] if x["client"]["id"] == acme["id"]), None)
    s = (row or {}).get("summary") or {}
    eq("the client has both accounts", s.get("accounts"), 2)
    eq("...one per cloud", s.get("by_provider"), {"AWS": 1, "OCI": 1})
    eq("month-to-date spend is per currency — USD and INR never added",
       s.get("cost", {}).get("month_to_date"), {"USD": 7.5, "INR": 250.0})
    eq("previous month too", s.get("cost", {}).get("previous_month"),
       {"USD": 30.0, "INR": 1500.0})
    eq("posture is the WORST score, not the average of 72 and 41",
       (s.get("worst_posture") or {}).get("score"), 41)
    eq("the expiring certificate is counted", s.get("certificates", {}).get("expiring_soon"), 1)
    unassigned = [a["account_id"] for a in p["unassigned"]["accounts"]]
    check("the unassigned account is listed as unassigned", str(a_free) in unassigned)
    check("the note says posture is not averaged",
          "never averaged" in (p.get("note") or ""), p.get("note"))
    r = await c.get(f"{BASE}/{acme['id']}")
    eq("client detail lists its accounts", len(r.json().get("accounts") or []), 2)

    print("\n=== D. The report's numbers are the period's ===")
    r = await c.get(f"{BASE}/{acme['id']}/report-preview", params={"period": PERIOD})
    eq("preview -> 200", r.status_code, 200)
    data = r.json()
    by_name = {a["account_name"]: a for a in data["accounts"]}
    aws = by_name.get(f"{PREFIX}aws") or {}
    oci = by_name.get(f"{PREFIX}oci") or {}
    eq("AWS spend for the period is the period's facts only", aws.get("cost", {}).get("period"),
       {"USD": 30.0})
    eq("...compared with the month before (none stored)",
       aws.get("cost", {}).get("change", {}).get("USD", {}).get("percent"), None)
    eq("OCI spend in INR", oci.get("cost", {}).get("period"), {"INR": 1500.0})
    check("a period billed on 3 of its days says so under gaps",
          any("3 of" in g for g in aws.get("gaps", [])), str(aws.get("gaps")))
    eq("posture is the assessment published inside the period",
       (aws.get("security") or {}).get("basis"), "end_of_period")
    eq("only changes detected inside the period are counted", aws.get("changes", {}).get("total"), 1)
    eq("alerts opened inside the period", aws.get("alerts", {}).get("opened"), 1)
    eq("the certificate expiring within 60 days is listed",
       [x["name"] for x in oci.get("certificates", [])], ["shop.example.test"])
    eq("totals are per currency", data["totals"]["spend"], {"USD": 30.0, "INR": 1500.0})
    r = await c.get(f"{BASE}/{acme['id']}/report-preview",
                    params={"period": THIS_MONTH.strftime("%Y-%m")})
    eq("the current month is refused (it has not finished)", r.status_code, 400)

    print("\n=== E. Generate, download, list ===")
    r = await c.post(f"{BASE}/{acme['id']}/reports", json={"period": PERIOD})
    eq("generate -> 201", r.status_code, 201)
    rep = r.json()
    eq("...GENERATED", rep.get("status"), "GENERATED")
    check("...with a PDF", (rep.get("pdf_bytes") or 0) > 1000, str(rep.get("pdf_bytes")))
    eq("...and no e-mail requested", rep.get("delivery_status"), "NOT_REQUESTED")
    r = await c.get(f"{BASE}/{acme['id']}/reports/{rep['id']}/pdf")
    eq("download -> 200 application/pdf",
       (r.status_code, r.headers.get("content-type")), (200, "application/pdf"))
    check("...a real PDF", r.content.startswith(b"%PDF"))
    check("...named after the client code and period",
          f"ZZACME-{PERIOD}.pdf" in (r.headers.get("content-disposition") or ""),
          r.headers.get("content-disposition"))
    r = await c.get(f"{BASE}/{globex['id']}/reports/{rep['id']}/pdf")
    eq("another client cannot fetch this client's report", r.status_code, 404)
    r = await c.post(f"{BASE}/{acme['id']}/reports/{rep['id']}/send")
    eq("sending without a schedule's recipients records NO_RECIPIENTS",
       r.json().get("delivery_status"), "NO_RECIPIENTS")
    r = await c.get(f"{BASE}/{acme['id']}/reports")
    eq("the report is listed", len(r.json().get("reports") or []), 1)

    print("\n=== F. The schedule ===")
    r = await c.get(f"{BASE}/{acme['id']}/report-schedule")
    check("an unsaved schedule is shown disabled", r.json().get("enabled") is False
          and r.json().get("saved") is False, str(r.json().get("saved")))
    r = await c.put(f"{BASE}/{acme['id']}/report-schedule",
                    json={"enabled": True, "day_of_month": 31})
    eq("day 31 is refused (not every month has one)", r.status_code, 422)
    r = await c.put(f"{BASE}/{acme['id']}/report-schedule",
                    json={"enabled": True, "day_of_month": 3, "send_time": "25:00"})
    eq("a bad time is refused", r.status_code, 400)
    r = await c.put(f"{BASE}/{acme['id']}/report-schedule",
                    json={"enabled": True, "day_of_month": 3, "recipients": {"to": []}})
    eq("an enabled schedule with nobody to send to is refused", r.status_code, 400)
    r = await c.put(f"{BASE}/{acme['id']}/report-schedule",
                    json={"enabled": True, "day_of_month": 3, "send_time": "09:00",
                          "timezone": "Asia/Kolkata",
                          "recipients": {"to": ["zz-report@example.com"]}})
    eq("a valid schedule saves", r.status_code, 200)
    sched = r.json()
    check("...with its next run in the future", sched.get("next_run_at")
          and datetime.fromisoformat(sched["next_run_at"]) > NOW, sched.get("next_run_at"))
    check("...and says whether e-mail can actually be delivered",
          "ready" in (sched.get("delivery") or {}), str(sched.get("delivery")))

    print("\n=== G. The scheduler cannot repeat itself ===")
    from app.services import client_report_scheduler as scheduler

    due = datetime.combine(THIS_MONTH + timedelta(days=2), datetime.min.time(),
                           tzinfo=timezone.utc) + timedelta(hours=3, minutes=30)
    if due > NOW:  # early in the month: use last month's run instead
        due = due - timedelta(days=31)
    async with AsyncSessionLocal() as db:
        await db.execute(update(CloudClientReportSchedule).where(
            CloudClientReportSchedule.client_id == acme_id).values(next_run_at=due))
        await db.commit()
    out = [o for o in await scheduler.run_due() if o["client_id"] == acme["id"]]
    eq("a due schedule produces its report once", [o["outcome"] for o in out], ["produced"])
    async with AsyncSessionLocal() as db:
        s_row = await db.get(CloudClientReportSchedule, acme_id)
        n_sched = (await db.execute(select(func.count()).select_from(CloudClientReport).where(
            CloudClientReport.client_id == acme_id,
            CloudClientReport.trigger == TRIGGER_SCHEDULE))).scalar()
    eq("...exactly one scheduled report row", n_sched, 1)
    check("...and the schedule advanced into the future",
          s_row.next_run_at and s_row.next_run_at > NOW, str(s_row.next_run_at))
    eq("...recording why nothing was e-mailed", s_row.last_status, "DELIVERY_NOT_READY")
    out = [o for o in await scheduler.run_due() if o["client_id"] == acme["id"]]
    eq("running the scheduler again does nothing", out, [])
    async with AsyncSessionLocal() as db:
        await db.execute(update(CloudClientReportSchedule).where(
            CloudClientReportSchedule.client_id == acme_id).values(next_run_at=due))
        await db.commit()
    out = [o for o in await scheduler.run_due() if o["client_id"] == acme["id"]]
    eq("forcing the same run again is refused as already produced",
       [o["outcome"] for o in out], ["already_produced"])
    async with AsyncSessionLocal() as db:
        n_sched = (await db.execute(select(func.count()).select_from(CloudClientReport).where(
            CloudClientReport.client_id == acme_id,
            CloudClientReport.trigger == TRIGGER_SCHEDULE))).scalar()
    eq("...still exactly one scheduled report", n_sched, 1)
    async with AsyncSessionLocal() as db:
        db.add(CloudClientReport(client_id=acme_id, period=s_row.last_period,
                                 period_start=PERIOD_START, period_end=THIS_MONTH,
                                 trigger=TRIGGER_SCHEDULE))
        try:
            await db.flush()
            refused = False
        except IntegrityError:
            refused = True
        await db.rollback()
    check("the DATABASE refuses a second scheduled report for the same period", refused)

    # Catch-up: a schedule months overdue produces ONE report.
    async with AsyncSessionLocal() as db:
        db.add(CloudClientReportSchedule(
            client_id=globex_id, enabled=True, day_of_month=3, send_time="09:00",
            timezone="Asia/Kolkata", recipients={"to": ["zz-report@example.com"]},
            next_run_at=due - timedelta(days=92)))
        await db.commit()
    out = [o for o in await scheduler.run_due() if o["client_id"] == globex["id"]]
    eq("a schedule three months overdue runs ONCE", len(out), 1)
    async with AsyncSessionLocal() as db:
        g = await db.get(CloudClientReportSchedule, globex_id)
    check("...and names the months it skipped instead of mailing them",
          "Skipped" in (g.last_message or ""), g.last_message)

    # A build failure still advances (and is recorded as a failure).
    from app.services.client_report_service import ClientReportService
    real_build = ClientReportService.build_data

    async def _boom(self, *a, **kw):
        raise RuntimeError("synthetic build failure")
    ClientReportService.build_data = _boom
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(update(CloudClientReportSchedule).where(
                CloudClientReportSchedule.client_id == globex_id).values(
                next_run_at=due + timedelta(days=31) if due + timedelta(days=31) < NOW
                else due, last_period=None))
            await db.execute(delete(CloudClientReport).where(
                CloudClientReport.client_id == globex_id))
            await db.commit()
        await scheduler.run_due()
    finally:
        ClientReportService.build_data = real_build
    async with AsyncSessionLocal() as db:
        g = await db.get(CloudClientReportSchedule, globex_id)
    eq("a failed build is recorded as FAILED", g.last_status, "FAILED")
    check("...and the schedule still moved forward (no retry loop)",
          g.next_run_at and g.next_run_at > NOW, str(g.next_run_at))

    print("\n=== H. An e-mailed report carries its PDF (rolled back) ===")
    import app.services.alerts.notifier as notifier

    async def _ready(db):
        return {"ready": True, "blockers": []}
    saved = notifier.delivery_status
    notifier.delivery_status = _ready
    try:
        async with AsyncSessionLocal() as db:
            rep = await ClientReportService(db).generate(acme_id, PERIOD, send=True,
                                                         actor="test", commit=False)
            eq("delivery is QUEUED when e-mail is ready", rep.get("delivery_status"), "QUEUED")
            row = (await db.execute(text(
                "SELECT payload FROM notification_queue "
                "WHERE payload->>'source' = 'cloud_client_report' "
                "ORDER BY id DESC LIMIT 1"))).scalar()
            att = ((row or {}).get("attachments") or [{}])[0]
            check("the queued mail has one PDF attachment",
                  att.get("content_type") == "application/pdf"
                  and att.get("filename", "").endswith(f"{PERIOD}.pdf"), str(att.get("filename")))
            check("...whose bytes are the report",
                  base64.b64decode(att.get("content_b64") or "").startswith(b"%PDF"))
            eq("...addressed to the schedule's recipient",
               (row or {}).get("recipients_override"), ["zz-report@example.com"])
            await db.rollback()
    finally:
        notifier.delivery_status = saved

    print("\n=== I. RBAC ===")
    os.environ["CLOUD_RBAC_ENFORCE"] = "true"
    try:
        r = await c.get(f"{BASE}/portfolio")
        eq("anonymous -> 401 when enforced", r.status_code, 401)
        r = await c.get(f"{BASE}/portfolio", headers=hdr("viewer"))
        eq("a viewer can read the portfolio", r.status_code, 200)
        r = await c.post(BASE, json={"name": f"{PREFIX}V"}, headers=hdr("viewer"))
        eq("a viewer cannot create a client", r.status_code, 403)
        r = await c.put(f"{BASE}/{acme['id']}/accounts", json={"account_ids": []},
                        headers=hdr("viewer"))
        eq("a viewer cannot assign accounts", r.status_code, 403)
        r = await c.get(f"{BASE}/{acme['id']}/report-preview", params={"period": PERIOD},
                        headers=hdr("viewer"))
        eq("a viewer cannot export a report", r.status_code, 403)
        r = await c.post(f"{BASE}/onboarding/discover", json={"provider": "AWS"},
                         headers=hdr("security_analyst"))
        eq("an analyst cannot onboard an organisation", r.status_code, 403)
        r = await c.post(f"{BASE}/{acme['id']}/reports", json={"period": PERIOD},
                         headers=hdr("security_analyst"))
        eq("an analyst CAN generate a report", r.status_code, 201)
        r = await c.post(f"{BASE}/{acme['id']}/reports", json={"period": PERIOD, "send": True},
                         headers=hdr("security_analyst"))
        eq("...but cannot e-mail one", r.status_code, 403)
        r = await c.put(f"{BASE}/{acme['id']}/report-schedule", json={"enabled": False},
                        headers=hdr("security_analyst"))
        eq("...nor change who receives it", r.status_code, 403)
        r = await c.put(f"{BASE}/{acme['id']}/report-schedule", json={"enabled": False},
                        headers=hdr("administrator"))
        eq("an administrator can", r.status_code, 200)
    finally:
        os.environ.pop("CLOUD_RBAC_ENFORCE", None)

    print("\n=== J. Deleting a client never deletes an account ===")
    r = await c.delete(f"{BASE}/{acme['id']}")
    body = r.json()
    eq("delete -> 200", r.status_code, 200)
    eq("...its accounts were unassigned", body.get("accounts_unassigned"), 2)
    check("...its reports went with it", (body.get("reports_deleted") or 0) >= 2,
          str(body.get("reports_deleted")))
    async with AsyncSessionLocal() as db:
        still = (await db.execute(select(func.count()).select_from(CloudAccount).where(
            CloudAccount.id.in_([a_aws, a_oci]), CloudAccount.client_id.is_(None)))).scalar()
    eq("...and both accounts still exist, unassigned", still, 2)

    print("\n=== K. Adding one account straight into a client ===")
    # The Azure service principal's application id is also called `client_id`.
    # When the Actmon client was added to the create schema under that same
    # name, the second declaration silently replaced the first, so every Azure
    # account's app id was looked up as a client and the add was refused.
    # Driven through the real route; only the provider sign-in is stubbed.
    from app.services.cloud_account_service import CloudAccountService
    from app.utils.encryption import decrypt_credentials

    real_validate = CloudAccountService._validate_credentials

    async def _no_network(provider, credentials):
        return None

    CloudAccountService._validate_credentials = staticmethod(_no_network)
    try:
        sp_app_id = str(uuid.uuid4())
        azure = {"provider": "Azure", "tenant_or_region": "t", "tenant_id": "tenant-x",
                 "client_id": sp_app_id, "client_secret": "not-a-real-secret",
                 "auto_discovery": False}
        r = await c.post("/api/v1/cloud/accounts", json={
            **azure, "account_name": f"{PREFIX}azure-into-client",
            "subscription_id": str(uuid.uuid4()), "target_client_id": globex["id"]})
        eq("an Azure account (app id is a GUID) can be added straight into a client -> 201",
           r.status_code, 201)
        body = r.json() if r.status_code == 201 else {}
        eq("...and lands in that client", body.get("client_id"), globex["id"])
        if body.get("id"):
            async with AsyncSessionLocal() as db:
                row = await db.get(CloudAccount, uuid.UUID(body["id"]))
                stored = decrypt_credentials(row.credentials_enc)
            eq("...with the service principal's app id kept as its credential, not "
               "mistaken for the client", stored.get("client_id"), sp_app_id)
        r = await c.post("/api/v1/cloud/accounts", json={
            **azure, "account_name": f"{PREFIX}azure-no-client",
            "subscription_id": str(uuid.uuid4())})
        eq("an Azure account with no client is still added -> 201", r.status_code, 201)
        eq("...unassigned", (r.json() if r.status_code == 201 else {}).get("client_id"), None)
        r = await c.post("/api/v1/cloud/accounts", json={
            "account_name": f"{PREFIX}aws-bad-client", "provider": "AWS",
            "tenant_or_region": "us-east-1", "access_key_id": "AKIAEXAMPLE",
            "secret_access_key": "not-a-real-secret", "auto_discovery": False,
            "target_client_id": str(uuid.uuid4())})
        eq("a client that does not exist is refused -> 400", r.status_code, 400)
    finally:
        CloudAccountService._validate_credentials = real_validate


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
