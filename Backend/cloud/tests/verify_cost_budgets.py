"""Budgets and cost alert policies: period arithmetic, utilisation, the
dedupe/escalation rules, and the HTTP surface with its permissions.

Run: venv\\Scripts\\python.exe tests\\verify_cost_budgets.py

Section 5 is the load-bearing one. A budget is re-evaluated every cycle, so
getting dedupe wrong produces one of two failures, and the second is far worse:
either it re-announces 75% forever, or a blanket cooldown silences it exactly
when spend crosses 100%. Both are pinned here.

Creates and removes its own account, facts and budgets; asserts the row counts
return to where they started.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import delete, func, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.alert import CloudAlert  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_budget import (  # noqa: E402
    PERIOD_ANNUAL, PERIOD_MONTHLY, PERIOD_QUARTERLY,
    CloudCostBudget, CloudCostBudgetNotification, severity_for_threshold,
)
from app.models.cost_fact import CloudCostFact, build_fact_key  # noqa: E402
from app.services import cost_budget_service as cbs  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/cost"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class FakeNotification:
    """Stand-in for a persisted notification row, for the pure dedupe tests."""
    def __init__(self, threshold, minutes_ago=0):
        self.threshold = threshold
        self.notified_at = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)


async def seed_facts(db, account, amounts_by_day, currency="INR"):
    """One fact per day, starting at the first of the current month."""
    today = date.today()
    start = today.replace(day=1)
    rows = []
    for offset, amount in enumerate(amounts_by_day):
        billing_date = start + timedelta(days=offset)
        rows.append(CloudCostFact(
            account_id=account.id, provider="ORACLE", billing_date=billing_date,
            service="Compute", region="ap-mumbai-1", amount=amount, currency=currency,
            cost_component="Compute", source="provider_billing", in_inventory=False,
            finality="provisional", revision_count=1,
            fact_key=build_fact_key(
                account_id=account.id, provider="ORACLE", billing_date=billing_date,
                service="Compute", region="ap-mumbai-1", resource_id=None,
                usage_type=None, currency=currency,
            ),
        ))
    db.add_all(rows)
    await db.commit()


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        # Counted EXCLUDING this suite's own alert type. Counting everything
        # would make the baseline depend on whether a previous run of this
        # suite crashed before its cleanup — the assertion would then fail for
        # the previous run's mess rather than for anything this run did.
        alerts_before = (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(~CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()
        budgets_before = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()

    print("1. Period arithmetic covers the WHOLE period, not up to today")
    start, end, key = cbs.period_bounds(PERIOD_MONTHLY, date(2026, 9, 15))
    check("monthly start is the 1st", start == date(2026, 9, 1), str(start))
    check("monthly end is the next 1st (exclusive)", end == date(2026, 10, 1), str(end))
    check("period key is YYYY-MM", key == "2026-09", key)
    check("end is NOT clipped to today -- the denominator is the whole month",
          end > date(2026, 9, 15))

    start, end, key = cbs.period_bounds(PERIOD_QUARTERLY, date(2026, 9, 15))
    check("Q3 starts in July", start == date(2026, 7, 1), str(start))
    check("Q3 ends in October", end == date(2026, 10, 1), str(end))
    check("quarter key", key == "2026-Q3", key)

    start, end, key = cbs.period_bounds(PERIOD_QUARTERLY, date(2026, 11, 2))
    check("Q4 rolls into the next year", end == date(2027, 1, 1), str(end))

    start, end, key = cbs.period_bounds(PERIOD_ANNUAL, date(2026, 9, 15))
    check("annual spans the calendar year",
          start == date(2026, 1, 1) and end == date(2027, 1, 1))
    check("annual key is the year", key == "2026", key)

    start, end, _ = cbs.period_bounds("NONSENSE", date(2026, 2, 10))
    check("an unparseable period falls back to monthly (the safest assumption)",
          start == date(2026, 2, 1) and end == date(2026, 3, 1), f"{start}..{end}")
    check("February's length is real, not assumed 30",
          (end - start).days == 28, str((end - start).days))

    print("\n2. Severity ladders with utilisation")
    check("49% -> INFO", severity_for_threshold(49) == "INFO")
    check("75% -> MEDIUM", severity_for_threshold(75) == "MEDIUM")
    check("90% -> HIGH", severity_for_threshold(90) == "HIGH")
    check("100% -> CRITICAL", severity_for_threshold(100) == "CRITICAL")
    check("150% -> CRITICAL", severity_for_threshold(150) == "CRITICAL")

    print("\n3. THE DEDUPE RULE -- a threshold is announced once per period")
    now = datetime.now(timezone.utc)
    allowed, reason = cbs._should_notify(50, {}, cooldown_hours=6, now=now)
    check("first breach announces", allowed is True)
    check("reason says first", "first" in reason, reason)

    history = {50: FakeNotification(50, minutes_ago=5)}
    allowed, reason = cbs._should_notify(50, history, cooldown_hours=6, now=now)
    check("the SAME threshold within cooldown is suppressed", allowed is False)
    check("reason names the cooldown", "cooldown" in reason, reason)

    history = {50: FakeNotification(50, minutes_ago=7 * 60)}
    allowed, reason = cbs._should_notify(50, history, cooldown_hours=6, now=now)
    check("the same threshold after cooldown may repeat", allowed is True, reason)

    print("\n4. ESCALATION always wins over the cooldown")
    history = {75: FakeNotification(75, minutes_ago=1)}
    allowed, reason = cbs._should_notify(100, history, cooldown_hours=6, now=now)
    check("75% -> 100% announces even 1 minute into a 6h cooldown", allowed is True)
    check("reason names it as escalation", "escalation" in reason, reason)

    print("\n5. A LOWER threshold after a higher one is noise, not news")
    history = {100: FakeNotification(100, minutes_ago=1)}
    allowed, reason = cbs._should_notify(50, history, cooldown_hours=6, now=now)
    check("50% is not announced after 100% already was", allowed is False)
    check("reason explains why", "below" in reason, reason)

    print("\n6. Utilisation is computed from real facts, and NA when there are none")
    async with AsyncSessionLocal() as db:
        account = CloudAccount(
            account_name="zz-test-budget", provider="ORACLE",
            environment="Development", tenant_or_region="test",
            auth_mode="API_Keys", credentials_enc="nope", auto_discovery=False,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)
        account_id = account.id

        empty_budget = CloudCostBudget(
            name="zz-empty", account_id=account_id, amount=1000.0,
            currency="INR", period=PERIOD_MONTHLY, thresholds=[50, 75, 90, 100],
        )
        db.add(empty_budget)
        await db.commit()
        await db.refresh(empty_budget)

        state = await cbs.evaluate_budget(db, empty_budget)
        check("no facts -> utilization is None (NA), not 0",
              state["utilization_percent"] is None, str(state["utilization_percent"]))
        check("status is unknown, not on_track",
              state["status"] == "unknown", state["status"])
        check("spend amount is None, not 0.0", state["spend"]["amount"] is None)

        # 10 days at 60/day = 600 of a 1000 budget = 60%.
        await seed_facts(db, account, [60.0] * 10)
        state = await cbs.evaluate_budget(db, empty_budget)
        check("spend totalled from facts", abs(state["spend"]["amount"] - 600.0) < 1e-6,
              str(state["spend"]["amount"]))
        check("utilisation is 60%", abs(state["utilization_percent"] - 60.0) < 1e-6,
              str(state["utilization_percent"]))
        check("status on_track below 90%", state["status"] == "on_track", state["status"])
        check("only the 50 threshold is breached",
              state["thresholds_breached"] == [50], str(state["thresholds_breached"]))
        check("remaining amount reported", abs(state["remaining_amount"] - 400.0) < 1e-6)
        check("forecast is labelled a run rate",
              state["forecast"]["method"] == "run_rate_projection")

        print("\n7. Other currencies in scope are DISCLOSED, never converted")
        await seed_facts(db, account, [7.0] * 3, currency="USD")
        state = await cbs.evaluate_budget(db, empty_budget)
        check("INR total unchanged by the USD rows",
              abs(state["spend"]["amount"] - 600.0) < 1e-6, str(state["spend"]["amount"]))
        check("USD reported as out of scope",
              "USD" in state["spend"]["out_of_scope_currencies"],
              str(state["spend"]["out_of_scope_currencies"]))
        check("no converted total appears anywhere",
              abs(state["spend"]["amount"] - 621.0) > 1e-6)

        print("\n8. Evaluation raises one alert for the HIGHEST breached threshold")
        # Push utilisation to 96%: 50, 75 and 90 are all breached. Added on a
        # day not already seeded — re-seeding day 1 would collide on
        # uq_cost_fact_key, which is the idempotency constraint doing its job.
        async with AsyncSessionLocal() as bump:
            extra = CloudCostFact(
                account_id=account_id, provider="ORACLE",
                billing_date=date.today().replace(day=1) + timedelta(days=20),
                service="Compute", region="ap-mumbai-1", amount=360.0, currency="INR",
                cost_component="Compute", source="provider_billing",
                in_inventory=False, finality="provisional", revision_count=1,
                fact_key=build_fact_key(
                    account_id=account_id, provider="ORACLE",
                    billing_date=date.today().replace(day=1) + timedelta(days=20),
                    service="Compute", region="ap-mumbai-1", resource_id=None,
                    usage_type=None, currency="INR"),
            )
            bump.add(extra)
            await bump.commit()

        state = await cbs.evaluate_budget(db, empty_budget)
        check("three thresholds are breached",
              state["thresholds_breached"] == [50, 75, 90],
              str(state["thresholds_breached"]))

        result = await cbs.evaluate_and_alert(db, [empty_budget], dry_run=True)
        check("dry run reports exactly ONE alert, not three",
              len(result["alerts_raised"]) == 1, str(len(result["alerts_raised"])))
        check("and it is the highest threshold",
              result["alerts_raised"][0]["threshold"] == 90,
              str(result["alerts_raised"][0]["threshold"]))
        check("dry run wrote no notification record",
              (await db.execute(select(func.count()).select_from(
                  CloudCostBudgetNotification).where(
                  CloudCostBudgetNotification.budget_id == empty_budget.id))).scalar() == 0)

        print("\n9. A real evaluation records the alert and the dedupe row")
        result = await cbs.evaluate_and_alert(db, [empty_budget])
        check("one alert raised", len(result["alerts_raised"]) == 1)
        raised = result["alerts_raised"][0]
        check("severity HIGH at 90%+", raised["severity"] == "HIGH", raised["severity"])
        check("dedupe key carries budget, period and threshold",
              raised["dedupe_key"].startswith("COST_BUDGET:")
              and raised["dedupe_key"].endswith(":90"), raised["dedupe_key"])

        alert = (await db.execute(
            select(CloudAlert).where(CloudAlert.dedupe_key == raised["dedupe_key"])
        )).scalars().first()
        check("an alert row exists", alert is not None)
        check("it went through the existing cloud_alerts table",
              alert.anomaly_type == "COST_BUDGET_THRESHOLD", alert.anomaly_type)
        check("context carries the evidence",
              alert.context.get("utilization_percent") is not None)
        check("context names the data source",
              alert.context.get("source") == "cloud_cost_facts")

        print("\n10. Re-evaluating immediately does NOT re-alert")
        again = await cbs.evaluate_and_alert(db, [empty_budget])
        check("nothing new raised", len(again["alerts_raised"]) == 0,
              str(len(again["alerts_raised"])))
        check("it is reported as suppressed, not silently dropped",
              len(again["alerts_suppressed"]) == 1)
        check("with a reason", "cooldown" in again["alerts_suppressed"][0]["reason"],
              again["alerts_suppressed"][0]["reason"])
        check("still exactly one notification row",
              (await db.execute(select(func.count()).select_from(
                  CloudCostBudgetNotification).where(
                  CloudCostBudgetNotification.budget_id == empty_budget.id))).scalar() == 1)

        print("\n11. THE CRITICAL CASE -- crossing 100% breaks through the cooldown")
        async with AsyncSessionLocal() as bump:
            over = CloudCostFact(
                account_id=account_id, provider="ORACLE",
                billing_date=date.today().replace(day=1) + timedelta(days=21),
                service="Compute", region="ap-mumbai-1", amount=200.0, currency="INR",
                cost_component="Compute", source="provider_billing",
                in_inventory=False, finality="provisional", revision_count=1,
                fact_key=build_fact_key(
                    account_id=account_id, provider="ORACLE",
                    billing_date=date.today().replace(day=1) + timedelta(days=21),
                    service="Compute", region="ap-mumbai-1", resource_id=None,
                    usage_type=None, currency="INR"),
            )
            bump.add(over)
            await bump.commit()

        breach = await cbs.evaluate_and_alert(db, [empty_budget])
        check("the 100% breach DOES alert, seconds after the 90% one",
              len(breach["alerts_raised"]) == 1, str(len(breach["alerts_raised"])))
        check("at threshold 100", breach["alerts_raised"][0]["threshold"] == 100)
        check("severity CRITICAL", breach["alerts_raised"][0]["severity"] == "CRITICAL")
        check("reason names escalation",
              "escalation" in breach["alerts_raised"][0]["reason"],
              breach["alerts_raised"][0]["reason"])

        print("\n12. A new period starts clean")
        # The period key is part of the identity, so last month's breach does
        # not carry forward.
        history_now = await cbs._already_notified(db, empty_budget.id, "1999-01")
        check("a different period sees no history", history_now == {}, str(history_now))

        print("\n13. A disabled budget is never evaluated")
        empty_budget.enabled = False
        await db.commit()
        quiet = await cbs.evaluate_and_alert(db, [empty_budget])
        check("nothing evaluated", quiet["evaluated"] == [])
        check("nothing raised", quiet["alerts_raised"] == [])
        empty_budget.enabled = True
        await db.commit()

    print("\n14. HTTP surface and permissions")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post(f"{BASE}/budgets", json={
            "name": "zz-http-budget", "amount": 5000, "currency": "usd",
            "period": "MONTHLY", "account_id": str(account_id),
        })
        check("create 201", r.status_code == 201, str(r.status_code))
        created = r.json()
        check("currency normalized to upper", created["currency"] == "USD",
              created["currency"])
        check("default thresholds applied", created["thresholds"] == [50, 75, 90, 100],
              str(created["thresholds"]))
        check("created_by recorded", created["created_by"] is not None)
        http_budget_id = created["id"]

        r = await c.post(f"{BASE}/budgets", json={
            "name": "bad", "amount": 10, "currency": "USD", "period": "WEEKLY"})
        check("unknown period -> 400", r.status_code == 400, str(r.status_code))

        r = await c.post(f"{BASE}/budgets", json={
            "name": "bad", "amount": 10, "currency": "USD", "thresholds": []})
        check("empty thresholds -> 400 (it could never alert)",
              r.status_code == 400, str(r.status_code))

        r = await c.post(f"{BASE}/budgets", json={"name": "bad", "amount": -5,
                                                  "currency": "USD"})
        check("negative amount -> 422", r.status_code == 422, str(r.status_code))

        r = await c.get(f"{BASE}/budgets?account_id={account_id}")
        check("list 200", r.status_code == 200)
        check("includes the new budget",
              any(b["id"] == http_budget_id for b in r.json()["budgets"]))

        r = await c.get(f"{BASE}/budgets/status?account_id={account_id}")
        check("status 200", r.status_code == 200, str(r.status_code))
        check("evaluates each budget", r.json()["count"] >= 1)

        r = await c.put(f"{BASE}/budgets/{http_budget_id}", json={
            "name": "zz-http-budget", "amount": 9000, "currency": "USD",
            "period": "MONTHLY", "account_id": str(account_id)})
        check("update 200", r.status_code == 200, str(r.status_code))
        check("previous values returned for the audit trail",
              r.json()["previous"]["amount"] == 5000.0,
              str(r.json()["previous"]["amount"]))

        r = await c.post(f"{BASE}/alert-policies", json={
            "name": "zz-daily", "kind": "DAILY_SPEND_THRESHOLD",
            "threshold_amount": 100, "threshold_currency": "INR"})
        check("policy create 201", r.status_code == 201, str(r.status_code))
        policy_id = r.json()["id"]

        r = await c.post(f"{BASE}/alert-policies", json={
            "name": "bad", "kind": "DAILY_SPEND_THRESHOLD", "threshold_amount": 100})
        check("amount without currency -> 400", r.status_code == 400, str(r.status_code))

        r = await c.post(f"{BASE}/alert-policies", json={
            "name": "bad", "kind": "NOT_A_KIND"})
        check("unknown kind -> 400", r.status_code == 400, str(r.status_code))

        r = await c.get(f"{BASE}/alert-policies")
        check("policy list 200", r.status_code == 200)
        body = r.json()
        check("evaluable policies flagged",
              any(p["id"] == policy_id and p["evaluable"] for p in body["policies"]))
        check("unsupported kinds are named with reasons",
              "RESOURCE_COST_THRESHOLD" in body["unsupported_kinds"])
        check("the AWS/date limitation is the stated reason",
              "date" in body["unsupported_kinds"]["RESOURCE_COST_THRESHOLD"])

        r = await c.post(f"{BASE}/alert-policies/evaluate?dry_run=true")
        check("policy evaluate 200", r.status_code == 200, str(r.status_code))

        r = await c.delete(f"{BASE}/alert-policies/{policy_id}")
        check("policy delete 204", r.status_code == 204, str(r.status_code))
        r = await c.delete(f"{BASE}/budgets/{http_budget_id}")
        check("budget delete 204", r.status_code == 204, str(r.status_code))
        r = await c.delete(f"{BASE}/budgets/{uuid.uuid4()}")
        check("deleting an unknown budget -> 404", r.status_code == 404, str(r.status_code))

    print("\n15. Permission split: viewing is not managing")
    from app.api import rbac
    check("viewer can read budgets",
          rbac.COST_VIEW in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("viewer CANNOT create budgets",
          rbac.COST_MANAGE_BUDGETS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("analyst CANNOT change what pages people",
          rbac.COST_MANAGE_ALERTS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
    check("administrator can do both",
          {rbac.COST_MANAGE_BUDGETS, rbac.COST_MANAGE_ALERTS}
          <= rbac.ROLE_PERMISSIONS[rbac.ROLE_ADMIN])

    print("\n16. Cleanup")
    async with AsyncSessionLocal() as db:
        await db.execute(delete(CloudAlert).where(
            CloudAlert.anomaly_type.like("COST_BUDGET%")))
        await db.execute(delete(CloudCostFact).where(
            CloudCostFact.account_id == account_id))
        await db.execute(delete(CloudCostBudget).where(
            CloudCostBudget.account_id == account_id))
        acc = await db.get(CloudAccount, account_id)
        if acc:
            await db.delete(acc)
        await db.commit()

        alerts_after = (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(~CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()
        leftover = (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()
        budgets_after = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()
    check("no unrelated alert was touched", alerts_after == alerts_before,
          f"{alerts_before} -> {alerts_after}")
    check("this suite's own alerts are all cleaned up", leftover == 0, str(leftover))
    check("budget table restored", budgets_after == budgets_before,
          f"{budgets_before} -> {budgets_after}")

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
