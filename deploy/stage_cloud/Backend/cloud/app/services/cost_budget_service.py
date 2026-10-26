"""Evaluate budgets and cost alert policies against persisted billing facts.

Everything here answers from `cloud_cost_facts`, and every alert is raised
through the EXISTING alerting service and notification bridge. No second alert
table, no second scheduler, no second idea of whether you have already been
told.

**The dedupe rule, which is the whole design.**

A budget is re-evaluated on every cycle, so a naive implementation either
re-announces 75% forever or, if a blanket cooldown suppresses it, stays silent
when spend later crosses 100% -- the one moment that actually matters. So:

*   A threshold is announced at most once per (budget, period, threshold).
    Recorded in `cloud_cost_budget_notifications`, which has a unique
    constraint so two racing evaluations cannot both announce.
*   Crossing a HIGHER threshold always announces, regardless of cooldown.
    Going 75% -> 100% is new information.
*   A cooldown only ever suppresses a REPEAT of the same threshold.
*   A new period starts clean: the period key is part of the identity, so
    October does not inherit September's breach.

**Currency is never crossed.** A budget names one currency and is compared only
against spend in that currency. Facts in other currencies are reported in
`out_of_scope_currencies` rather than converted -- this product has no FX
source, and converting without one would invent the number the budget is
judged against.
"""
from __future__ import annotations

import logging
import uuid
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import and_, select

from app.models.cost_budget import (
    NOTIFICATION_ACTUAL,
    NOTIFICATION_FORECAST,
    PERIOD_ANNUAL,
    PERIOD_MONTHLY,
    PERIOD_QUARTERLY,
    POLICY_COST_SPIKE,
    POLICY_DAILY_SPEND,
    POLICY_MONTHLY_SPEND,
    POLICY_SERVICE_COST,
    CloudCostAlertPolicy,
    CloudCostBudget,
    CloudCostBudgetNotification,
    severity_for_threshold,
)
from app.models.cost_fact import CloudCostFact

logger = logging.getLogger("cloud_svc.cost.budget")


# ── Period arithmetic ─────────────────────────────────────────────────────────

def period_bounds(period: str, today: Optional[date] = None) -> Tuple[date, date, str]:
    """(start, end_exclusive, period_key) for the period containing `today`.

    end is exclusive and is the period's true end, not today -- utilisation is
    "spend so far against the whole period's budget", and clipping the window
    to today would make the denominator shrink with it.
    """
    today = today or date.today()

    if period == PERIOD_ANNUAL:
        start = date(today.year, 1, 1)
        end = date(today.year + 1, 1, 1)
        return start, end, f"{today.year:04d}"

    if period == PERIOD_QUARTERLY:
        quarter = (today.month - 1) // 3
        start_month = quarter * 3 + 1
        start = date(today.year, start_month, 1)
        end = (date(today.year + 1, 1, 1) if start_month + 3 > 12
               else date(today.year, start_month + 3, 1))
        return start, end, f"{today.year:04d}-Q{quarter + 1}"

    # Monthly is the default for anything unrecognized: a budget whose period
    # cannot be parsed must still be evaluated, and a month is the shortest,
    # most conservative assumption.
    start = date(today.year, today.month, 1)
    days_in_month = monthrange(today.year, today.month)[1]
    end = start + timedelta(days=days_in_month)
    return start, end, f"{today.year:04d}-{today.month:02d}"


# ── Spend lookup ──────────────────────────────────────────────────────────────

async def spend_for_budget(
    db, budget: CloudCostBudget, start: date, end: date,
) -> Dict[str, Any]:
    """Actual spend inside a budget's scope, split by currency.

    Returns the matching-currency total AND whatever was found in other
    currencies, so the caller can disclose that some spend in scope is not
    being counted rather than silently ignoring it.
    """
    from sqlalchemy import func

    clauses = [
        CloudCostFact.billing_date >= start,
        CloudCostFact.billing_date < end,
    ]
    if budget.account_id is not None:
        clauses.append(CloudCostFact.account_id == budget.account_id)
    if budget.provider:
        clauses.append(CloudCostFact.provider == budget.provider.upper())
    if budget.service:
        clauses.append(CloudCostFact.service == budget.service)
    if budget.region:
        clauses.append(CloudCostFact.region == budget.region)
    if budget.cost_component:
        clauses.append(CloudCostFact.cost_component == budget.cost_component)

    rows = (await db.execute(
        select(
            CloudCostFact.currency,
            func.sum(CloudCostFact.amount),
            func.count(),
        ).where(and_(*clauses)).group_by(CloudCostFact.currency)
    )).all()

    target = (budget.currency or "").upper()
    matched, records = None, 0
    others: Dict[str, float] = {}
    for currency, total, count in rows:
        code = (currency or "UNKNOWN").upper()
        value = float(total) if total is not None else None
        if code == target:
            matched = value
            records = count
        elif value is not None:
            others[code] = round(value, 4)

    return {
        "amount": (round(matched, 4) if matched is not None else None),
        "currency": target,
        "records": records,
        "out_of_scope_currencies": others,
    }


# ── Budget evaluation ─────────────────────────────────────────────────────────

async def evaluate_budget(
    db, budget: CloudCostBudget, *, today: Optional[date] = None,
) -> Dict[str, Any]:
    """Current utilisation of one budget. Reads only; raises no alerts."""
    today = today or date.today()
    start, end, period_key = period_bounds(budget.period, today)
    spend = await spend_for_budget(db, budget, start, end)

    amount = spend["amount"]
    # None is NA, not zero: no stored facts means we do not know what has been
    # spent, which is different from knowing nothing has.
    percent = (
        (amount / budget.amount * 100.0)
        if amount is not None and budget.amount else None
    )

    elapsed = (today - start).days + 1
    total_days = (end - start).days
    remaining = max(0, total_days - elapsed)
    daily_rate = (amount / elapsed) if amount is not None and elapsed > 0 else None
    projected = (
        round(amount + daily_rate * remaining, 4)
        if amount is not None and daily_rate is not None else None
    )

    return {
        "budget": budget.to_dict(),
        "period": {
            "key": period_key,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "days_total": total_days,
            "days_elapsed": elapsed,
            "days_remaining": remaining,
        },
        "spend": spend,
        "utilization_percent": (round(percent, 2) if percent is not None else None),
        "remaining_amount": (
            round(budget.amount - amount, 4) if amount is not None else None
        ),
        "forecast": {
            "projected_period_total": projected,
            "projected_percent": (
                round(projected / budget.amount * 100.0, 2)
                if projected is not None and budget.amount else None
            ),
            "method": "run_rate_projection",
            "basis": (
                f"Mean of {elapsed} elapsed day(s) extended over {remaining} "
                "remaining day(s)." if daily_rate is not None else None
            ),
        },
        # Which configured thresholds the CURRENT utilisation has passed.
        "thresholds_breached": (
            sorted(t for t in (budget.thresholds or []) if percent is not None and percent >= t)
            if percent is not None else []
        ),
        "status": (
            "unknown" if percent is None
            else "exceeded" if percent >= 100
            else "at_risk" if percent >= 90
            else "on_track"
        ),
    }


async def _already_notified(
    db, budget_id: uuid.UUID, period_key: str, *,
    kind: str = NOTIFICATION_ACTUAL,
) -> Dict[int, CloudCostBudgetNotification]:
    """What has already been announced this period, for one notification KIND.

    ACTUAL and FORECAST are deliberately separate histories: a forecast notice
    must not count as "already notified" for the real breach, or the real
    breach would go unannounced the one time it actually matters.
    """
    rows = (await db.execute(
        select(CloudCostBudgetNotification).where(
            and_(
                CloudCostBudgetNotification.budget_id == budget_id,
                CloudCostBudgetNotification.period_key == period_key,
                CloudCostBudgetNotification.kind == kind,
            )
        )
    )).scalars().all()
    return {row.threshold: row for row in rows}


def _should_notify(
    threshold: int,
    history: Dict[int, CloudCostBudgetNotification],
    *,
    cooldown_hours: int,
    now: datetime,
) -> Tuple[bool, str]:
    """Whether to announce `threshold`, and why.

    The escalation rule lives here: a threshold higher than anything announced
    this period is ALWAYS announced, because it is new information that the
    cooldown started at a lower threshold must not suppress.
    """
    highest_announced = max(history) if history else None

    if highest_announced is None:
        return True, "first threshold breached this period"

    if threshold > highest_announced:
        return True, (
            f"escalation from {highest_announced}% to {threshold}% — a higher "
            "threshold is new information and ignores the cooldown"
        )

    previous = history.get(threshold)
    if previous is None:
        # Lower than something already announced: saying "you passed 50%" after
        # having already said "you passed 100%" is noise, not news.
        return False, (
            f"{threshold}% is below the {highest_announced}% already announced "
            "this period"
        )

    age = now - previous.notified_at
    if age >= timedelta(hours=cooldown_hours):
        return True, f"cooldown of {cooldown_hours}h has elapsed since the last notice"
    return False, (
        f"within the {cooldown_hours}h cooldown "
        f"({int(age.total_seconds() // 60)} minutes since the last notice)"
    )


async def evaluate_and_alert(
    db, budgets: Sequence[CloudCostBudget], *, today: Optional[date] = None,
    now: Optional[datetime] = None, dry_run: bool = False,
) -> Dict[str, Any]:
    """Evaluate budgets and raise alerts for newly-crossed thresholds.

    `dry_run` evaluates and reports exactly what WOULD be announced without
    writing an alert or a notification record — which is what makes the dedupe
    logic testable and what lets an operator preview a noisy budget before
    switching it on.
    """
    from app.services.alerting_service import AlertingService

    today = today or date.today()
    now = now or datetime.now(timezone.utc)
    alerting = AlertingService(db)

    evaluated: List[Dict[str, Any]] = []
    raised: List[Dict[str, Any]] = []
    suppressed: List[Dict[str, Any]] = []

    for budget in budgets:
        if not budget.enabled:
            continue

        state = await evaluate_budget(db, budget, today=today)
        evaluated.append(state)

        percent = state["utilization_percent"]
        if percent is None:
            continue

        period_key = state["period"]["key"]
        breached = state["thresholds_breached"]

        if breached:
            # Only the HIGHEST breached threshold is a candidate. Announcing
            # 50, 75 and 90 in one cycle is three notifications about one fact.
            threshold = max(breached)
            history = await _already_notified(
                db, budget.id, period_key, kind=NOTIFICATION_ACTUAL,
            )
            allowed, reason = _should_notify(
                threshold, history,
                cooldown_hours=budget.cooldown_hours, now=now,
            )

            record = {
                "budget_id": str(budget.id),
                "budget_name": budget.name,
                "threshold": threshold,
                "utilization_percent": percent,
                "period_key": period_key,
                "kind": NOTIFICATION_ACTUAL,
                "reason": reason,
            }

            if not allowed:
                suppressed.append(record)
            else:
                severity = severity_for_threshold(percent)
                spend = state["spend"]
                details = (
                    f"Budget '{budget.name}' has reached {percent:.1f}% of its "
                    f"{budget.amount:,.2f} {budget.currency} {budget.period.lower()} "
                    f"budget ({spend['amount']:,.2f} {budget.currency} spent in "
                    f"{state['period']['start']}..{state['period']['end']})."
                )
                if spend["out_of_scope_currencies"]:
                    details += (
                        " Note: spend in other currencies exists in this scope "
                        "and is NOT counted against this budget: "
                        + ", ".join(f"{v:,.2f} {c}" for c, v in
                                    spend["out_of_scope_currencies"].items())
                        + "."
                    )

                # The dedupe key carries budget, period and threshold, so a
                # recurrence updates one alert row rather than appending a new
                # one, and a new period or a higher threshold is correctly a
                # different alert.
                dedupe_key = f"COST_BUDGET:{budget.id}:{period_key}:{threshold}"
                record["dedupe_key"] = dedupe_key
                record["severity"] = severity

                if dry_run:
                    raised.append({**record, "dry_run": True})
                else:
                    await alerting.trigger_anomaly_alert(
                        anomaly_type="COST_BUDGET_THRESHOLD",
                        details=details,
                        severity=severity,
                        account_id=budget.account_id,
                        dedupe_key=dedupe_key,
                        context={
                            "budget_id": str(budget.id),
                            "budget_name": budget.name,
                            "threshold_percent": threshold,
                            "utilization_percent": percent,
                            "budget_amount": budget.amount,
                            "currency": budget.currency,
                            "period": state["period"],
                            "spend": spend,
                            "forecast": state["forecast"],
                            "source": "cloud_cost_facts",
                        },
                    )
                    db.add(CloudCostBudgetNotification(
                        budget_id=budget.id, period_key=period_key,
                        threshold=threshold, kind=NOTIFICATION_ACTUAL,
                        notified_at=now, observed_percent=percent,
                        observed_amount=spend["amount"],
                    ))
                    await db.commit()
                    raised.append(record)

        # ── Forecast-to-breach ───────────────────────────────────────────────
        # `alert_on_forecast` is off by default: a projection is not a fact,
        # and paging on one should be a deliberate choice (see the model's
        # docstring). A forecast breach is only announced when it is telling
        # the operator something the ACTUAL alert above has not already said
        # this cycle — i.e. the forecast threshold is STRICTLY above the
        # highest threshold actual spend has itself crossed. Without that
        # guard, a budget already at 100% would also get a "forecast says
        # 100%" notice every cycle, which is not new information.
        if budget.alert_on_forecast:
            projected_percent = state["forecast"]["projected_percent"]
            forecast_breached = (
                sorted(t for t in (budget.thresholds or []) if projected_percent >= t)
                if projected_percent is not None else []
            )
            highest_actual = max(breached) if breached else None
            forecast_breached = [
                t for t in forecast_breached
                if highest_actual is None or t > highest_actual
            ]

            if forecast_breached:
                f_threshold = max(forecast_breached)
                f_history = await _already_notified(
                    db, budget.id, period_key, kind=NOTIFICATION_FORECAST,
                )
                f_allowed, f_reason = _should_notify(
                    f_threshold, f_history,
                    cooldown_hours=budget.cooldown_hours, now=now,
                )

                f_record = {
                    "budget_id": str(budget.id),
                    "budget_name": budget.name,
                    "threshold": f_threshold,
                    "utilization_percent": projected_percent,
                    "period_key": period_key,
                    "kind": NOTIFICATION_FORECAST,
                    "reason": f_reason,
                }

                if not f_allowed:
                    suppressed.append(f_record)
                else:
                    f_severity = severity_for_threshold(projected_percent)
                    forecast = state["forecast"]
                    f_details = (
                        f"Budget '{budget.name}' is PROJECTED to reach "
                        f"{projected_percent:.1f}% of its {budget.amount:,.2f} "
                        f"{budget.currency} {budget.period.lower()} budget by "
                        f"{state['period']['end']} ({forecast['basis']}). Actual "
                        f"spend so far is {percent:.1f}%."
                    )

                    # A distinct dedupe identity from the actual-breach alert
                    # above — see the model docstring for why reusing
                    # COST_BUDGET:... here would be wrong.
                    f_dedupe_key = (
                        f"COST_BUDGET_FORECAST:{budget.id}:{period_key}:{f_threshold}"
                    )
                    f_record["dedupe_key"] = f_dedupe_key
                    f_record["severity"] = f_severity

                    if dry_run:
                        raised.append({**f_record, "dry_run": True})
                    else:
                        await alerting.trigger_anomaly_alert(
                            anomaly_type="COST_BUDGET_FORECAST",
                            details=f_details,
                            severity=f_severity,
                            account_id=budget.account_id,
                            dedupe_key=f_dedupe_key,
                            context={
                                "budget_id": str(budget.id),
                                "budget_name": budget.name,
                                "threshold_percent": f_threshold,
                                "projected_percent": projected_percent,
                                "actual_percent": percent,
                                "budget_amount": budget.amount,
                                "currency": budget.currency,
                                "period": state["period"],
                                "forecast": forecast,
                                "source": "run_rate_projection",
                            },
                        )
                        db.add(CloudCostBudgetNotification(
                            budget_id=budget.id, period_key=period_key,
                            threshold=f_threshold, kind=NOTIFICATION_FORECAST,
                            notified_at=now, observed_percent=projected_percent,
                            observed_amount=forecast["projected_period_total"],
                        ))
                        await db.commit()
                        raised.append(f_record)

    return {
        "evaluated": evaluated,
        "alerts_raised": raised,
        "alerts_suppressed": suppressed,
        "evaluated_at": now.isoformat(),
        "dry_run": dry_run,
    }


# ── Generic alert policies ────────────────────────────────────────────────────

# Which policy kinds can actually be evaluated from the data this product
# stores today. A policy whose data does not exist reports not_supported with a
# reason rather than silently never firing — a rule that quietly never
# triggers is worse than no rule, because it reads as "all clear".
SUPPORTED_POLICY_KINDS = {
    POLICY_DAILY_SPEND, POLICY_MONTHLY_SPEND, POLICY_SERVICE_COST, POLICY_COST_SPIKE,
}
UNSUPPORTED_REASONS = {
    "RESOURCE_COST_THRESHOLD": (
        "Per-resource spend is not stored with a date, so a resource-level "
        "threshold cannot be evaluated over a period. It needs the providers to "
        "group by resource AND date in one query (Azure and OCI can; AWS cannot "
        "without a CUR pipeline)."
    ),
    "UNALLOCATED_COST_THRESHOLD": (
        "Unallocated cost requires the inventory join to be persisted alongside "
        "the facts, which the allocation phase adds."
    ),
    "BUDGET_EXCEEDED": (
        "Handled by the budget evaluator itself rather than as a generic policy; "
        "create a budget with thresholds instead."
    ),
    "FORECAST_EXCEEDS_BUDGET": (
        "Handled by a budget's alert_on_forecast flag rather than as a generic "
        "policy."
    ),
}


async def evaluate_policies(
    db, policies: Sequence[CloudCostAlertPolicy], *,
    today: Optional[date] = None, now: Optional[datetime] = None,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Evaluate generic cost alert policies against stored facts."""
    from sqlalchemy import func

    from app.services.alerting_service import AlertingService
    from app.services import cost_analytics

    today = today or date.today()
    now = now or datetime.now(timezone.utc)
    alerting = AlertingService(db)

    raised: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for policy in policies:
        if not policy.enabled:
            continue
        if policy.kind not in SUPPORTED_POLICY_KINDS:
            skipped.append({
                "policy_id": str(policy.id), "name": policy.name, "kind": policy.kind,
                "status": "not_supported",
                "reason": UNSUPPORTED_REASONS.get(
                    policy.kind, "This policy kind is not evaluated yet."
                ),
            })
            continue

        clauses = []
        if policy.account_id is not None:
            clauses.append(CloudCostFact.account_id == policy.account_id)
        if policy.provider:
            clauses.append(CloudCostFact.provider == policy.provider.upper())
        if policy.service:
            clauses.append(CloudCostFact.service == policy.service)

        if policy.kind == POLICY_DAILY_SPEND:
            window_start, window_end = today - timedelta(days=1), today
            label, period_key = "daily", window_start.isoformat()
        elif policy.kind in (POLICY_MONTHLY_SPEND, POLICY_SERVICE_COST):
            window_start, window_end, period_key = period_bounds(PERIOD_MONTHLY, today)
            label = "monthly"
        else:  # POLICY_COST_SPIKE
            window_start, window_end = today - timedelta(days=90), today
            label, period_key = "spike", today.isoformat()

        scope = clauses + [
            CloudCostFact.billing_date >= window_start,
            CloudCostFact.billing_date < window_end,
        ]

        if policy.kind == POLICY_COST_SPIKE:
            series = (await db.execute(
                select(
                    CloudCostFact.billing_date, CloudCostFact.currency,
                    func.sum(CloudCostFact.amount),
                ).where(and_(*scope))
                .group_by(CloudCostFact.billing_date, CloudCostFact.currency)
                .order_by(CloudCostFact.billing_date)
            )).all()
            points = [
                {"date": d.isoformat(), "currency": c,
                 "amount": (float(a) if a is not None else None)}
                for d, c, a in series
            ]
            result = cost_analytics.detect_anomalies(
                points,
                percent_threshold=(policy.threshold_percent
                                   or cost_analytics.DEFAULT_PERCENT_THRESHOLD),
                min_absolute=(policy.min_absolute
                              or cost_analytics.DEFAULT_MIN_ABSOLUTE),
            )
            hits = [
                item
                for bucket in (result.get("by_currency") or {}).values()
                if bucket.get("available")
                for item in bucket.get("anomalies", [])
                # Only the most recent day: a policy fires on what is happening
                # now, not on every historical spike every cycle.
                if item["date"] == (today - timedelta(days=1)).isoformat()
            ]
            if not hits:
                skipped.append({"policy_id": str(policy.id), "name": policy.name,
                                "kind": policy.kind, "status": "no_breach"})
                continue
            hit = hits[0]
            observed, currency = hit["actual"], hit["currency"]
            details = (
                f"Cost spike: spend on {hit['date']} was {observed:,.2f} {currency}, "
                f"{hit['percent_increase']:.1f}% above the preceding baseline of "
                f"{hit['baseline']:,.2f} {currency}."
            )
            context = {"anomaly": hit, "source": "cloud_cost_facts"}
        else:
            if not policy.threshold_amount or not policy.threshold_currency:
                skipped.append({
                    "policy_id": str(policy.id), "name": policy.name,
                    "kind": policy.kind, "status": "misconfigured",
                    "reason": "A spend threshold needs both an amount and a currency.",
                })
                continue
            currency = policy.threshold_currency.upper()
            total = (await db.execute(
                select(func.sum(CloudCostFact.amount)).where(
                    and_(*scope, CloudCostFact.currency == currency)
                )
            )).scalar()
            observed = float(total) if total is not None else None
            if observed is None or observed < policy.threshold_amount:
                skipped.append({"policy_id": str(policy.id), "name": policy.name,
                                "kind": policy.kind, "status": "no_breach",
                                "observed": observed})
                continue
            details = (
                f"{policy.name}: {label} spend of {observed:,.2f} {currency} "
                f"exceeded the configured threshold of "
                f"{policy.threshold_amount:,.2f} {currency}"
                + (f" for service '{policy.service}'." if policy.service else ".")
            )
            context = {
                "observed": observed, "threshold": policy.threshold_amount,
                "currency": currency, "window": [window_start.isoformat(),
                                                 window_end.isoformat()],
                "source": "cloud_cost_facts",
            }

        dedupe_key = f"COST_POLICY:{policy.id}:{period_key}"
        record = {
            "policy_id": str(policy.id), "name": policy.name, "kind": policy.kind,
            "severity": policy.severity, "dedupe_key": dedupe_key,
            "observed": observed, "currency": currency,
        }
        if dry_run:
            raised.append({**record, "dry_run": True})
            continue

        await alerting.trigger_anomaly_alert(
            anomaly_type=f"COST_POLICY_{policy.kind}",
            details=details,
            severity=policy.severity,
            account_id=policy.account_id,
            dedupe_key=dedupe_key,
            context={**context, "policy_id": str(policy.id),
                     "policy_name": policy.name},
        )
        raised.append(record)

    return {
        "alerts_raised": raised,
        "skipped": skipped,
        "evaluated_at": now.isoformat(),
        "dry_run": dry_run,
    }
