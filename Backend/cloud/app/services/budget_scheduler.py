"""The loop that evaluates budgets and alert policies without a human asking.

Before this existed, `evaluate_and_alert` and `evaluate_policies` had exactly
one caller each in the whole codebase: `POST /cloud/cost/budgets/evaluate` and
`POST /cloud/cost/alert-policies/evaluate`, both requiring `cost:manage_alerts`
from a human. Every other piece of the budget subsystem was real — the
thresholds, the dedupe ledger, the escalation rule, even the run-rate forecast
— but none of it could fire on its own. A budget could sit at 150% of its
amount for a month and nobody would be told, because telling them was a button
nobody had pressed.

Same shape as this service's other background loops (the event collector, the
refresh scheduler, JIT expiry): one `asyncio` task started in the app
lifespan, waking on a fixed tick, reading what is enabled, doing the work. No
second scheduler framework.

**Why this is safe to default ON.** Unlike a schedule row (refresh, client
report) which is created disabled and only acts once an operator opts in, a
*budget* already defaults `enabled=True` the moment someone creates it — the
whole point of configuring thresholds is to be told when they are crossed.
Leaving the scheduler off by default would mean every budget in this product
silently does nothing until an operator separately discovers this switch,
which is the exact failure this feature exists to close. The dedupe ledger
(`cloud_cost_budget_notifications`, unique on budget+period+threshold+kind)
and each policy's own cooldown are what keep this from being noisy.

**No per-budget claiming.** Unlike the refresh scheduler, nothing here has a
`next_run_at` to race over — every enabled budget and policy is evaluated on
every tick, and `evaluate_and_alert`/`evaluate_policies` are themselves
idempotent per tick (the unique index is the actual race guard if two workers
ever run this loop at once; a conflicting insert simply loses the race and
that worker's notification is not recorded, which is correct — the other
worker's already was).

**A failed tick does not stop the loop**, for the same reason a failed refresh
cycle does not stop the refresh scheduler: a schedule that silently gives up
after one bad tick is worse than one that keeps trying and logs where someone
can see it.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict

logger = logging.getLogger("cloud_svc.cost.budget_scheduler")

_stop = asyncio.Event()

DEFAULT_INTERVAL_S = 3600
MIN_INTERVAL_S = 300

_last_tick: Dict[str, Any] = {
    "at": None, "budgets_evaluated": 0, "alerts_raised": 0,
    "policies_evaluated": 0, "policy_alerts_raised": 0, "error": None,
}


def scheduler_enabled() -> bool:
    """Whether the budget/policy evaluation loop runs.

    Defaults to ON — see the module docstring for why that is the safe
    default here, unlike a report schedule. An operator who turns this off is
    choosing to go back to evaluating budgets only by hand.
    """
    raw = os.getenv("COST_BUDGET_SCHEDULER_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() not in ("false", "0", "no", "off")


def interval_seconds() -> int:
    try:
        value = int(os.getenv("COST_BUDGET_SCHEDULER_INTERVAL_S") or DEFAULT_INTERVAL_S)
    except ValueError:
        return DEFAULT_INTERVAL_S
    return max(MIN_INTERVAL_S, value)


def scheduler_status() -> Dict[str, Any]:
    """Only what is actually measured — no invented health."""
    return {
        "enabled": scheduler_enabled(),
        "running": not _stop.is_set(),
        "interval_seconds": interval_seconds(),
        "last_tick": dict(_last_tick),
    }


def stop_scheduler() -> None:
    _stop.set()


async def scheduler_loop() -> None:
    """Evaluate every enabled budget and alert policy until cancelled."""
    _stop.clear()
    interval = interval_seconds()
    logger.info("Cost budget scheduler started (every %ds).", interval)

    while not _stop.is_set():
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a bad tick must not end the loop
            logger.exception("Cost budget evaluation tick failed: %s", exc)
            _last_tick["error"] = str(exc)
        try:
            await asyncio.wait_for(_stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
    logger.info("Cost budget scheduler stopped.")


async def _tick() -> None:
    from sqlalchemy import select

    from app.core.database import AsyncSessionLocal
    from app.models.cost_budget import CloudCostAlertPolicy, CloudCostBudget
    from app.services import cost_budget_service

    async with AsyncSessionLocal() as db:
        budgets = (await db.execute(
            select(CloudCostBudget).where(CloudCostBudget.enabled.is_(True))
        )).scalars().all()
        budget_result = (
            await cost_budget_service.evaluate_and_alert(db, budgets, dry_run=False)
            if budgets else
            {"evaluated": [], "alerts_raised": [], "alerts_suppressed": []}
        )

        policies = (await db.execute(
            select(CloudCostAlertPolicy).where(CloudCostAlertPolicy.enabled.is_(True))
        )).scalars().all()
        policy_result = (
            await cost_budget_service.evaluate_policies(db, policies, dry_run=False)
            if policies else
            {"alerts_raised": [], "skipped": []}
        )

    _last_tick.update({
        "at": datetime.now(timezone.utc).isoformat(),
        "budgets_evaluated": len(budget_result["evaluated"]),
        "alerts_raised": len(budget_result["alerts_raised"]),
        "policies_evaluated": len(policies),
        "policy_alerts_raised": len(policy_result["alerts_raised"]),
        "error": None,
    })

    if budget_result["alerts_raised"] or policy_result["alerts_raised"]:
        logger.info(
            "Cost budget sweep: %d budget alert(s), %d policy alert(s) raised.",
            len(budget_result["alerts_raised"]), len(policy_result["alerts_raised"]),
        )
