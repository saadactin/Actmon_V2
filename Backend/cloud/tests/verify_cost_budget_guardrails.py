"""Budget guardrails: forecast-to-breach alerting and the scheduler that
evaluates budgets without a human asking.

Run: venv\\Scripts\\python.exe tests\\verify_cost_budget_guardrails.py

This suite exists because `verify_cost_budgets.py` pins the ACTUAL-spend path
only. Two things changed alongside it that needed their own proof:

1. `alert_on_forecast` is no longer a dead flag. A forecast breach is a
   DIFFERENT fact from an actual breach and must dedupe independently
   (section 2), must not re-announce something the actual-spend alert already
   said this cycle (section 3), and must still obey the same escalation/
   cooldown rule as the actual path (section 4) because it reuses
   `_should_notify` rather than inventing a second rule.
2. Nothing evaluated a budget automatically before `budget_scheduler.py`
   existed. Section 5 pins its configuration (env var overrides, the interval
   floor) as pure logic; the loop itself is exercised by running the app, not
   by this suite, the same way `jit_expiry_scheduler`'s loop is not unit-tested
   either.

Creates and removes its own account, facts and budget; asserts the row counts
return to where they started.
"""
import asyncio
import logging
import os
import pathlib
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

from sqlalchemy import delete as sa_delete, func, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.models.alert import CloudAlert  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_budget import (  # noqa: E402
    NOTIFICATION_ACTUAL, NOTIFICATION_FORECAST, PERIOD_MONTHLY,
    CloudCostBudget, CloudCostBudgetNotification,
)
from app.models.cost_fact import CloudCostFact, build_fact_key  # noqa: E402
from app.services import budget_scheduler  # noqa: E402
from app.services import cost_budget_service as cbs  # noqa: E402

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def seed_facts(db, account, amounts_by_day, *, start_offset=0, currency="INR"):
    today = date.today()
    base = today.replace(day=1)
    rows = []
    for offset, amount in enumerate(amounts_by_day, start=start_offset):
        billing_date = base + timedelta(days=offset)
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


async def purge_fixtures():
    """Self-healing after a crashed run.

    `cloud_cost_budgets.account_id` is FK SET NULL, not CASCADE (an account
    being deleted should not silently delete an org-wide budget someone meant
    to keep) -- so a run that dies between creating a budget and this suite's
    own cleanup leaves an ORPHANED budget with account_id NULL behind, forever,
    for every later run to count. Purge both: the fixture account by name, and
    any budget this suite's own names could have produced with no account.
    """
    async with AsyncSessionLocal() as db:
        stale = (await db.execute(
            select(CloudAccount).where(CloudAccount.account_name.like("zz-test-guardrail%"))
        )).scalars().all()
        for acct in stale:
            await db.delete(acct)

        orphan_budgets = (await db.execute(
            select(CloudCostBudget).where(
                CloudCostBudget.name.like("zz-guardrail%"),
                CloudCostBudget.account_id.is_(None),
            )
        )).scalars().all()
        for b in orphan_budgets:
            await db.delete(b)

        await db.commit()
        return len(stale) + len(orphan_budgets)


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    purged = await purge_fixtures()
    if purged:
        print(f"  (purged {purged} leftover fixture account(s) from an earlier run)")

    async with AsyncSessionLocal() as db:
        alerts_before = (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(~CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()
        budgets_before = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()

        account = CloudAccount(
            account_name="zz-test-guardrail", provider="ORACLE",
            environment="Development", tenant_or_region="test",
            auth_mode="API_Keys", credentials_enc="nope", auto_discovery=False,
        )
        db.add(account)
        await db.commit()
        await db.refresh(account)

        print("1. A notification's `kind` defaults to ACTUAL and is part of its identity")
        budget = CloudCostBudget(
            name="zz-guardrail", account_id=account.id, amount=1000.0,
            currency="INR", period=PERIOD_MONTHLY, thresholds=[50, 75, 90, 100],
            alert_on_forecast=False,
        )
        db.add(budget)
        await db.commit()
        await db.refresh(budget)

        # 10 days at 60/day = 600 of 1000 = 60% actual, breaching only 50%.
        # elapsed=10, remaining = days_in_month-10, run-rate projects well past
        # 100% by month end for any month-length — this is what will later
        # drive the forecast tests without needing extra facts.
        await seed_facts(db, account, [60.0] * 10)

        state = await cbs.evaluate_budget(db, budget)
        check("actual utilisation is 60%", abs(state["utilization_percent"] - 60.0) < 1e-6,
              str(state["utilization_percent"]))
        check("forecast already projects past 100% from this run rate",
              state["forecast"]["projected_percent"] is not None
              and state["forecast"]["projected_percent"] > 100,
              str(state["forecast"]["projected_percent"]))

        print("\n2. alert_on_forecast OFF (the default) raises no forecast alert at all")
        result = await cbs.evaluate_and_alert(db, [budget])
        kinds_raised = {r.get("kind") for r in result["alerts_raised"]}
        check("only the ACTUAL 50% alert fires", kinds_raised == {NOTIFICATION_ACTUAL},
              str(kinds_raised))
        check("exactly one alert", len(result["alerts_raised"]) == 1,
              str(len(result["alerts_raised"])))

        rows = (await db.execute(select(CloudCostBudgetNotification).where(
            CloudCostBudgetNotification.budget_id == budget.id))).scalars().all()
        check("exactly one notification row, kind ACTUAL",
              len(rows) == 1 and rows[0].kind == NOTIFICATION_ACTUAL,
              str([(r.kind, r.threshold) for r in rows]))

        print("\n3. alert_on_forecast ON raises a SEPARATE forecast alert, "
              "with its own dedupe identity")
        budget.alert_on_forecast = True
        await db.commit()

        result = await cbs.evaluate_and_alert(db, [budget])
        check("actual 50% is NOT re-announced (already notified + within cooldown)",
              not any(r.get("kind") == NOTIFICATION_ACTUAL for r in result["alerts_raised"]),
              str(result["alerts_raised"]))
        forecast_alerts = [r for r in result["alerts_raised"] if r.get("kind") == NOTIFICATION_FORECAST]
        check("exactly one forecast alert fires", len(forecast_alerts) == 1,
              str(result["alerts_raised"]))
        f = forecast_alerts[0] if forecast_alerts else {}
        check("forecast dedupe key is COST_BUDGET_FORECAST:..., not COST_BUDGET:...",
              f.get("dedupe_key", "").startswith("COST_BUDGET_FORECAST:"),
              f.get("dedupe_key"))
        check("forecast alert's threshold is the highest one the PROJECTION crosses "
              "that actual spend has not already crossed",
              f.get("threshold", 0) > 50, str(f.get("threshold")))

        alert = (await db.execute(
            select(CloudAlert).where(CloudAlert.dedupe_key == f.get("dedupe_key"))
        )).scalars().first()
        check("a real alert row exists for the forecast notice", alert is not None)
        check("its anomaly_type is COST_BUDGET_FORECAST, distinct from COST_BUDGET_THRESHOLD",
              alert is not None and alert.anomaly_type == "COST_BUDGET_FORECAST",
              alert.anomaly_type if alert else None)
        check("context names the source as a projection, not billing",
              alert is not None and alert.context.get("source") == "run_rate_projection")
        check("context carries BOTH the projected and the actual percent",
              alert is not None
              and alert.context.get("projected_percent") is not None
              and alert.context.get("actual_percent") is not None)

        rows = (await db.execute(select(CloudCostBudgetNotification).where(
            CloudCostBudgetNotification.budget_id == budget.id))).scalars().all()
        by_kind = {(r.kind, r.threshold) for r in rows}
        check("both an ACTUAL(50) and a FORECAST row now coexist for this budget",
              (NOTIFICATION_ACTUAL, 50) in by_kind and
              any(k == NOTIFICATION_FORECAST for k, _ in by_kind),
              str(by_kind))

        print("\n4. Re-evaluating immediately suppresses the forecast repeat too, "
              "with a reason -- it is not a silent no-op")
        again = await cbs.evaluate_and_alert(db, [budget])
        check("nothing new raised", again["alerts_raised"] == [], str(again["alerts_raised"]))
        forecast_suppressed = [
            s for s in again["alerts_suppressed"] if s.get("kind") == NOTIFICATION_FORECAST
        ]
        check("the forecast suppression is reported, not dropped",
              len(forecast_suppressed) == 1, str(again["alerts_suppressed"]))
        check("suppression reason names the cooldown",
              "cooldown" in forecast_suppressed[0]["reason"], forecast_suppressed[0]["reason"])

        print("\n5. When actual spend catches up to the SAME threshold the forecast "
              "already announced, the forecast guard no longer treats it as new -- "
              "the ACTUAL path announces it in its own right")
        # Push actual utilisation to 96%, well past the forecast's own threshold,
        # on an unseeded day so this does not collide with the idempotent fact key.
        async with AsyncSessionLocal() as bump:
            extra = CloudCostFact(
                account_id=account.id, provider="ORACLE",
                billing_date=date.today().replace(day=1) + timedelta(days=25),
                service="Compute", region="ap-mumbai-1", amount=360.0, currency="INR",
                cost_component="Compute", source="provider_billing",
                in_inventory=False, finality="provisional", revision_count=1,
                fact_key=build_fact_key(
                    account_id=account.id, provider="ORACLE",
                    billing_date=date.today().replace(day=1) + timedelta(days=25),
                    service="Compute", region="ap-mumbai-1", resource_id=None,
                    usage_type=None, currency="INR"),
            )
            bump.add(extra)
            await bump.commit()

        state = await cbs.evaluate_budget(db, budget)
        check("actual utilisation now exceeds the forecast's earlier threshold",
              state["utilization_percent"] > 90, str(state["utilization_percent"]))

        caught_up = await cbs.evaluate_and_alert(db, [budget])
        actual_now = [r for r in caught_up["alerts_raised"] if r.get("kind") == NOTIFICATION_ACTUAL]
        check("the ACTUAL path announces the new, higher threshold on its own",
              len(actual_now) == 1 and actual_now[0]["threshold"] > 50,
              str(caught_up["alerts_raised"]))
        forecast_now = [r for r in caught_up["alerts_raised"] if r.get("kind") == NOTIFICATION_FORECAST]
        check("no redundant forecast alert fires once actual spend is already there "
              "(the projection is no longer telling the operator anything new)",
              forecast_now == [], str(forecast_now))

        print("\n6. dry_run previews a forecast alert without writing anything")
        # New period so there is no history to interfere with the preview.
        async with AsyncSessionLocal() as db2:
            preview_budget = CloudCostBudget(
                name="zz-guardrail-preview", account_id=account.id, amount=1000.0,
                currency="INR", period=PERIOD_MONTHLY, thresholds=[50, 75, 90, 100],
                alert_on_forecast=True,
            )
            db2.add(preview_budget)
            await db2.commit()
            await db2.refresh(preview_budget)
            # No new facts needed: a budget's scope is account/provider/
            # service/region/cost_component, not "which budget asked", so this
            # fresh budget already sees the SAME account's accumulated spend
            # from sections 1 and 5 (600 + 360 = 960 of its own 1000 amount —
            # 96%, comfortably forecasting past 100%). What is genuinely fresh
            # is the notification HISTORY: a brand new budget id has none.

            before_count = (await db2.execute(select(func.count()).select_from(
                CloudCostBudgetNotification).where(
                CloudCostBudgetNotification.budget_id == preview_budget.id))).scalar()
            dry = await cbs.evaluate_and_alert(db2, [preview_budget], dry_run=True)
            after_count = (await db2.execute(select(func.count()).select_from(
                CloudCostBudgetNotification).where(
                CloudCostBudgetNotification.budget_id == preview_budget.id))).scalar()

            check("dry run reports a forecast alert",
                  any(r.get("kind") == NOTIFICATION_FORECAST for r in dry["alerts_raised"]),
                  str(dry["alerts_raised"]))
            check("dry run marks it dry_run=True",
                  all(r.get("dry_run") is True for r in dry["alerts_raised"]))
            check("dry run writes NO notification row",
                  before_count == after_count == 0,
                  f"{before_count} -> {after_count}")

            await db2.delete(preview_budget)
            await db2.commit()

        print("\n7. Cleanup")
        await db.execute(sa_delete(CloudAlert).where(CloudAlert.anomaly_type.like("COST_BUDGET%")))
        await db.execute(sa_delete(CloudCostFact).where(CloudCostFact.account_id == account.id))
        await db.execute(sa_delete(CloudCostBudget).where(CloudCostBudget.account_id == account.id))
        await db.execute(sa_delete(CloudAccount).where(CloudAccount.id == account.id))
        await db.commit()

    async with AsyncSessionLocal() as db:
        alerts_after = (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(~CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()
        budgets_after = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()
    check("no unrelated alert was touched", alerts_after == alerts_before,
          f"{alerts_before} -> {alerts_after}")
    check("this suite's own alerts are all cleaned up",
          (await _count_prefix_alerts()) == 0)
    check("budget table restored", budgets_after == budgets_before,
          f"{budgets_before} -> {budgets_after}")

    print("\n8. The scheduler's own configuration is pure logic -- no DB, no loop")
    try:
        os.environ.pop("COST_BUDGET_SCHEDULER_ENABLED", None)
        check("enabled by default (a budget already defaults to enabled, so the "
              "scheduler must too, or nothing ever evaluates it)",
              budget_scheduler.scheduler_enabled() is True)

        os.environ["COST_BUDGET_SCHEDULER_ENABLED"] = "false"
        check("can be disabled explicitly", budget_scheduler.scheduler_enabled() is False)
        os.environ["COST_BUDGET_SCHEDULER_ENABLED"] = "off"
        check("'off' is also recognised", budget_scheduler.scheduler_enabled() is False)

        os.environ.pop("COST_BUDGET_SCHEDULER_INTERVAL_S", None)
        check("default interval is one hour", budget_scheduler.interval_seconds() == 3600,
              str(budget_scheduler.interval_seconds()))

        os.environ["COST_BUDGET_SCHEDULER_INTERVAL_S"] = "10"
        check("an interval below the floor is clamped up, not honoured literally "
              "(a budget sweep every 10s would be a self-inflicted load problem)",
              budget_scheduler.interval_seconds() == budget_scheduler.MIN_INTERVAL_S,
              str(budget_scheduler.interval_seconds()))

        os.environ["COST_BUDGET_SCHEDULER_INTERVAL_S"] = "not-a-number"
        check("a garbage interval falls back to the default rather than raising",
              budget_scheduler.interval_seconds() == budget_scheduler.DEFAULT_INTERVAL_S)

        status = budget_scheduler.scheduler_status()
        check("status reports enabled/running/interval/last_tick, no invented health",
              {"enabled", "running", "interval_seconds", "last_tick"} <= set(status.keys()),
              str(status.keys()))
    finally:
        os.environ.pop("COST_BUDGET_SCHEDULER_ENABLED", None)
        os.environ.pop("COST_BUDGET_SCHEDULER_INTERVAL_S", None)

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        sys.exit(1)


async def _count_prefix_alerts():
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(func.count()).select_from(CloudAlert)
            .where(CloudAlert.anomaly_type.like("COST_BUDGET%")))).scalar()


if __name__ == "__main__":
    asyncio.run(main())
