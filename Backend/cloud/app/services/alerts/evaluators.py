"""One function per condition type, each reading its domain's canonical source.

Two rules govern everything in this file.

**Read the source, do not re-derive it.** The security score comes from the
assessment the Security Center published; it is not recomputed here, because a
second scoring implementation is how the Overview and the Security Center ended
up reporting 0/F and 35/F for the same account. Cost comes from
`cloud_cost_facts`, the store the Cost Intelligence ingestion writes. Resource
counts come from `ResourceQueryService.summary()`, which is a single
`COUNT(*) FILTER (...)` over one scan — not 1,500 rows fetched and counted in
Python.

**A number you could not read is not zero.** Every evaluator distinguishes
three cases: the source answered and the value is N; the source answered and
there is genuinely nothing (still a real N, which is 0); the source could not
be read at all (UNKNOWN, with the reason). The third case never resolves an
alert and never fires one. This is why, for example, the cost evaluators check
window coverage before totalling: an empty sum over an uncovered window is
indistinguishable from zero spend, and reporting it as ₹0 would both silence a
real overspend alert and falsely resolve an open one.

Efficiency: these are narrow aggregates against tables this service already
owns. `EvalContext` memoizes each distinct fetch for the duration of one engine
tick, so twenty security rules on one account read the findings table once.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from sqlalchemy import and_, func, select

from app.services.alerts import catalog, result
from app.services.alerts.result import Evaluation

logger = logging.getLogger("cloud_svc.alerts.eval")

# Never put more than this many example rows in an alert. An email is a
# notification, not a report; the link into Actmon is how you see all of them.
MAX_SAMPLES = 5


class EvalContext:
    """Per-tick shared state for one account.

    Every loader is memoized and every one is fail-soft in the same way: a
    loader that raises stores the exception, and each evaluator turns that into
    an UNKNOWN naming the real cause. Nothing here ever substitutes a default.
    """

    def __init__(self, db, account) -> None:
        self.db = db
        self.account = account
        self.account_id: uuid.UUID = account.id
        self.now = datetime.now(timezone.utc)
        self._cache: Dict[Any, Any] = {}

    async def _memo(self, key, loader: Callable):
        if key in self._cache:
            value = self._cache[key]
            if isinstance(value, Exception):
                raise value
            return value
        try:
            value = await loader()
        except Exception as exc:  # noqa: BLE001 — recorded, re-raised to caller
            self._cache[key] = exc
            raise
        self._cache[key] = value
        return value

    # ── Security ─────────────────────────────────────────────────────────────
    async def security_assessment(self):
        from app.repository.security_repo import SecurityRepository

        return await self._memo(
            "security_assessment",
            lambda: SecurityRepository(self.db).latest_assessment(self.account_id),
        )

    async def security_findings(self):
        from app.repository.security_repo import SecurityRepository

        return await self._memo(
            "security_findings",
            lambda: SecurityRepository(self.db).findings_for_account(self.account_id),
        )

    # ── Resources ────────────────────────────────────────────────────────────
    async def resource_summary(self, **filters) -> Dict[str, Any]:
        from app.services.resource_query_service import ResourceQueryService

        key = ("resources", tuple(sorted((k, str(v)) for k, v in filters.items())))

        async def _load():
            svc = ResourceQueryService(self.db)
            payload = await svc.summary(str(self.account_id), **filters)
            return payload.get("summary") or {}

        return await self._memo(key, _load)

    # ── Cost ─────────────────────────────────────────────────────────────────
    async def cost_coverage(self) -> Dict[str, Any]:
        from app.repository.cost_fact_repo import CostFactRepository

        return await self._memo(
            "cost_coverage",
            lambda: CostFactRepository(self.db).coverage([self.account_id]),
        )

    async def cost_total(self, start: date, end: date, currency: str,
                         scope: Optional[dict] = None) -> Tuple[Optional[float], int]:
        """(amount, day_count) for one currency over an inclusive date range.

        Returns the DISTINCT billed days actually present alongside the amount,
        because that is what tells a caller whether a small number means low
        spend or a half-covered window.
        """
        from app.models.cost_fact import CloudCostFact

        scope = scope or {}
        key = ("cost_total", start, end, currency,
               scope.get("service"), scope.get("region"))

        async def _load():
            clauses = [
                CloudCostFact.account_id == self.account_id,
                CloudCostFact.billing_date >= start,
                CloudCostFact.billing_date <= end,
                CloudCostFact.currency == currency,
            ]
            if scope.get("service"):
                clauses.append(CloudCostFact.service == scope["service"])
            if scope.get("region"):
                clauses.append(CloudCostFact.region == scope["region"])
            amount, days = (await self.db.execute(
                select(func.sum(CloudCostFact.amount),
                       func.count(func.distinct(CloudCostFact.billing_date)))
                .where(and_(*clauses))
            )).one()
            return (float(amount) if amount is not None else None, int(days or 0))

        return await self._memo(key, _load)

    async def cost_currencies(self) -> List[str]:
        coverage = await self.cost_coverage()
        return list(coverage.get("currencies") or [])

    def cost_diagnostic(self) -> Optional[Dict[str, Any]]:
        from app.services import cost_service

        return cost_service.get_cost_diagnostic(self.account_id)

    # ── Drift ────────────────────────────────────────────────────────────────
    async def drift_count(self, since: datetime, severity: Optional[str]) -> int:
        from app.models.drift import CloudResourceChange

        key = ("drift", since.isoformat(), severity)

        async def _load():
            clauses = [
                CloudResourceChange.account_id == self.account_id,
                CloudResourceChange.detected_at >= since,
            ]
            if severity and severity != "ANY":
                clauses.append(CloudResourceChange.severity == severity)
            return (await self.db.execute(
                select(func.count()).select_from(CloudResourceChange)
                .where(and_(*clauses))
            )).scalar_one()

        return await self._memo(key, _load)

    async def drift_has_history(self) -> bool:
        from app.models.drift import CloudResourceChange

        async def _load():
            found = (await self.db.execute(
                select(CloudResourceChange.id)
                .where(CloudResourceChange.account_id == self.account_id).limit(1)
            )).first()
            return found is not None

        return await self._memo("drift_history", _load)

    async def drift_samples(self, since: datetime, severity: Optional[str]) -> List[dict]:
        from app.models.drift import CloudResourceChange

        clauses = [
            CloudResourceChange.account_id == self.account_id,
            CloudResourceChange.detected_at >= since,
        ]
        if severity and severity != "ANY":
            clauses.append(CloudResourceChange.severity == severity)
        rows = (await self.db.execute(
            select(CloudResourceChange).where(and_(*clauses))
            .order_by(CloudResourceChange.detected_at.desc()).limit(MAX_SAMPLES)
        )).scalars().all()
        return [
            {"name": r.resource_name or r.provider_resource_id,
             "type": r.resource_type, "severity": r.severity,
             "detail": r.summary,
             "at": r.detected_at.isoformat() if r.detected_at else None}
            for r in rows
        ]

    # ── Events ───────────────────────────────────────────────────────────────
    async def event_scopes(self) -> List[Any]:
        from app.models.event_admin import CloudEventSyncState

        async def _load():
            return list((await self.db.execute(
                select(CloudEventSyncState)
                .where(CloudEventSyncState.account_id == self.account_id)
            )).scalars().all())

        return await self._memo("event_scopes", _load)

    async def event_count(self, since: datetime, risk_at_least: str,
                          status_filter: str, region: Optional[str]) -> int:
        from app.models.cloud_event import RISK_LEVELS, RISK_ORDER, CloudEvent

        key = ("events", since.isoformat(), risk_at_least, status_filter, region)

        async def _load():
            clauses = [
                CloudEvent.account_id == self.account_id,
                CloudEvent.timestamp >= since,
            ]
            if risk_at_least and risk_at_least != "ANY":
                floor = RISK_ORDER.get(risk_at_least)
                if floor is not None:
                    # Expressed as an IN over the ranking, because a varchar
                    # column cannot be ordered by our semantics — same approach
                    # the Event Log's own risk filter uses.
                    clauses.append(CloudEvent.risk_level.in_([
                        lvl for lvl in RISK_LEVELS if RISK_ORDER[lvl] >= floor
                    ]))
            if status_filter and status_filter != "ANY":
                clauses.append(CloudEvent.status == status_filter)
            if region:
                clauses.append(CloudEvent.region == region)
            return (await self.db.execute(
                select(func.count()).select_from(CloudEvent).where(and_(*clauses))
            )).scalar_one()

        return await self._memo(key, _load)

    async def event_samples(self, since: datetime, risk_at_least: str,
                            status_filter: str, region: Optional[str]) -> List[dict]:
        from app.models.cloud_event import RISK_LEVELS, RISK_ORDER, CloudEvent

        clauses = [CloudEvent.account_id == self.account_id,
                   CloudEvent.timestamp >= since]
        if risk_at_least and risk_at_least != "ANY":
            floor = RISK_ORDER.get(risk_at_least)
            if floor is not None:
                clauses.append(CloudEvent.risk_level.in_([
                    lvl for lvl in RISK_LEVELS if RISK_ORDER[lvl] >= floor
                ]))
        if status_filter and status_filter != "ANY":
            clauses.append(CloudEvent.status == status_filter)
        if region:
            clauses.append(CloudEvent.region == region)
        rows = (await self.db.execute(
            select(CloudEvent).where(and_(*clauses))
            .order_by(CloudEvent.timestamp.desc()).limit(MAX_SAMPLES)
        )).scalars().all()
        return [
            {"name": r.event_name, "type": r.resource_type,
             "severity": r.risk_level,
             "detail": (f"{r.actor_name or r.actor_id or 'Unknown actor'} · "
                        f"{r.status}"),
             "at": r.timestamp.isoformat() if r.timestamp else None}
            for r in rows
        ]

    # ── Discovery ────────────────────────────────────────────────────────────
    async def discovery(self) -> Dict[str, Any]:
        from app.services.discovery_service import DiscoveryService

        return await self._memo(
            "discovery",
            lambda: DiscoveryService(self.db).latest_for_account(self.account_id),
        )

    # ── Certificates and secrets ─────────────────────────────────────────────
    async def credential_inventory(self) -> Tuple[List[Any], List[Any]]:
        from app.repository.credential_repo import CredentialRepository

        async def _load():
            repo = CredentialRepository(self.db)
            return (await repo.objects([self.account_id]),
                    await repo.sources([self.account_id]))

        return await self._memo("credential_inventory", _load)


# ── Security ──────────────────────────────────────────────────────────────────
# The statuses that mean a finding is still a live problem, and the verdict that
# means we PROVED it. Imported from the Security Center so "open finding" means
# exactly the same thing in an alert as it does on the Security page.
async def _eval_security_finding_count(ctx: EvalContext, cfg: dict,
                                       scope: dict) -> Evaluation:
    from app.services.security_center_service import ACTIVE_FINDING_STATUSES

    assessment = await ctx.security_assessment()
    if assessment is None:
        return result.unknown(
            "This account has never been security-assessed, so the number of "
            "open findings is unknown. It is NOT zero. Run an assessment from "
            "the Security Center and this rule starts evaluating."
        )

    findings = await ctx.security_findings()
    severity = cfg.get("severity_filter", "ANY")
    # Confirmed only. A finding the scanner could not determine is counted
    # separately and reported in the detail — never folded in as safe, and
    # never counted as a confirmed problem either.
    active = [f for f in findings if f.status in ACTIVE_FINDING_STATUSES]
    confirmed = [f for f in active if f.verdict == "VULNERABLE"]
    undetermined = [f for f in active if f.verdict in ("UNKNOWN", "NOT_SCANNED")]
    if severity != "ANY":
        confirmed = [f for f in confirmed if f.severity == severity]
        undetermined = [f for f in undetermined if f.severity == severity]

    observed = len(confirmed)
    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(observed, operator, threshold)

    detail = f"{observed} confirmed finding(s) match this rule."
    if undetermined:
        detail += (f" A further {len(undetermined)} could not be determined by "
                   "the scanner and are excluded from this count rather than "
                   "assumed safe.")

    return result.compared(
        fired, observed, threshold, operator,
        detail=detail,
        as_of=(assessment.finished_at.isoformat()
               if getattr(assessment, "finished_at", None) else None),
        samples=[
            {"name": f.resource_name or f.resource_key or f.title,
             "type": f.resource_type, "severity": f.severity, "detail": f.title}
            for f in sorted(
                confirmed,
                key=lambda x: (_sev_rank(x.severity), -(x.affected_count or 1)),
            )[:MAX_SAMPLES]
        ],
        context={"undetermined": len(undetermined),
                 "severity_filter": severity},
    )


async def _eval_security_score(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    assessment = await ctx.security_assessment()
    if assessment is None:
        return result.unknown(
            "This account has never been security-assessed, so it has no posture "
            "score. An unassessed account is not a zero-scoring account."
        )
    as_of = (assessment.finished_at.isoformat()
             if getattr(assessment, "finished_at", None) else None)
    score = assessment.score
    if score is None:
        return result.unknown(
            "The latest assessment did not publish a posture score, so there is "
            "nothing to compare against the threshold.",
            as_of=as_of,
        )

    # The Security Center marks a score unreliable when it was computed over
    # partial coverage. Firing — or clearing — a posture alert on a number the
    # engine that produced it does not stand behind would be borrowing its
    # authority without its caveat.
    if not getattr(assessment, "score_reliable", True):
        return result.unknown(
            f"The Security Center published a score of {score} but marked it "
            "unreliable, because the assessment covered only "
            f"{_pct(assessment.coverage_pct)} of the estate. This rule will not "
            "fire or clear on a score its own source does not stand behind.",
            as_of=as_of,
            context={"score": score, "grade": assessment.grade,
                     "coverage_pct": assessment.coverage_pct,
                     "score_reliable": False},
        )

    threshold = float(cfg.get("threshold", 70))
    observed = float(score)
    # This condition is "below the bar" by definition; the operator is not
    # configurable because "score greater than 70" is not an alert anyone means.
    fired = observed < threshold
    return result.compared(
        fired, observed, threshold, catalog.OP_LT,
        detail=(f"The Security Center's published score is {observed:g} "
                f"(grade {assessment.grade or 'NA'}). This rule reads that "
                "score; it does not recalculate one."),
        as_of=as_of,
        context={"grade": assessment.grade,
                 "coverage_pct": assessment.coverage_pct,
                 "score_reliable": True},
    )


def _pct(value: Optional[float]) -> str:
    return "an unreported share of" if value is None else f"{float(value):.0f}%"


def _sev_rank(severity: Optional[str]) -> int:
    from app.models.alert_rule import SEVERITY_ORDER

    return SEVERITY_ORDER.get((severity or "").upper(), 9)


# ── Cost ──────────────────────────────────────────────────────────────────────
def _period_range(period: str, today: date) -> Tuple[date, date, int]:
    """(start, end, expected_days). End is always a COMPLETE day.

    Today is deliberately excluded from every window. Provider billing for the
    current day is partial and arrives late, so including it makes spend look
    like it collapsed every morning — and a "cost dropped" resolution fired off
    a half-written day is a false all-clear.
    """
    yesterday = today - timedelta(days=1)
    if period == "yesterday":
        return yesterday, yesterday, 1
    if period == "last_7_days":
        return yesterday - timedelta(days=6), yesterday, 7
    if period == "last_30_days":
        return yesterday - timedelta(days=29), yesterday, 30
    # month_to_date: the 1st through yesterday. In the first day of a month
    # that window is empty, which is reported as uncovered, not as zero spend.
    start = today.replace(day=1)
    if yesterday < start:
        return start, start, 0
    return start, yesterday, (yesterday - start).days + 1


async def _eval_cost_threshold(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    currency = str(cfg.get("currency", "")).upper()
    period = cfg.get("period", "month_to_date")
    today = ctx.now.date()
    start, end, expected = _period_range(period, today)

    if expected == 0:
        return result.unknown(
            "The month-to-date window contains no complete billing day yet "
            "(today is the 1st). Spend for a partial day is not comparable "
            "against a monthly threshold.", unit=currency,
        )

    coverage = await ctx.cost_coverage()
    if not coverage.get("has_history"):
        diag = ctx.cost_diagnostic()
        return result.unknown(
            _no_cost_reason(diag), unit=currency,
            context={"diagnostic": diag},
        )

    known = coverage.get("currencies") or []
    if currency not in known:
        return result.unknown(
            f"No spend billed in {currency} is stored for this account. "
            f"Stored billing currencies: {', '.join(known) or 'none'}. "
            "Amounts are never converted between currencies, so this threshold "
            "cannot be evaluated.",
            unit=currency, context={"available_currencies": known},
        )

    amount, days_present = await ctx.cost_total(start, end, currency, scope)

    # The distinction this whole feature turns on. An empty sum over a window
    # with no billed days is "we have no data for this window", not "spend was
    # zero" — and resolving a cost alert on it would be a false all-clear.
    if days_present == 0:
        diag = ctx.cost_diagnostic()
        return result.unknown(
            f"No billing records are stored for {start.isoformat()} to "
            f"{end.isoformat()}. " + _no_cost_reason(diag),
            unit=currency, as_of=coverage.get("latest"),
            context={"diagnostic": diag, "window_start": start.isoformat(),
                     "window_end": end.isoformat()},
        )

    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    observed = float(amount or 0.0)
    fired = catalog.compare(observed, operator, threshold)

    detail = (f"{catalog.fmt_number(observed)} {currency} billed between "
              f"{start.isoformat()} and {end.isoformat()}.")
    if days_present < expected:
        # Report a partial window rather than pretending it is whole. The
        # number is real; it just covers fewer days than the rule asked for.
        detail += (f" Only {days_present} of {expected} day(s) in this window "
                   "have billing records stored, so the true total is at least "
                   "this much.")

    return result.compared(
        fired, observed, threshold, operator, unit=currency, detail=detail,
        as_of=coverage.get("latest"),
        context={"window_start": start.isoformat(), "window_end": end.isoformat(),
                 "days_present": days_present, "days_expected": expected,
                 "partial_window": days_present < expected},
    )


async def _eval_cost_increase(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    currency = str(cfg.get("currency", "")).upper()
    try:
        window = int(float(cfg.get("window_days", 7)))
    except (TypeError, ValueError):
        window = 7
    today = ctx.now.date()
    cur_end = today - timedelta(days=1)
    cur_start = cur_end - timedelta(days=window - 1)
    prev_end = cur_start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=window - 1)

    coverage = await ctx.cost_coverage()
    if not coverage.get("has_history"):
        return result.unknown(
            _no_cost_reason(ctx.cost_diagnostic()), unit=currency)
    if currency not in (coverage.get("currencies") or []):
        return result.unknown(
            f"No spend billed in {currency} is stored for this account, so "
            "there is no baseline to compare against.", unit=currency)

    cur_amount, cur_days = await ctx.cost_total(cur_start, cur_end, currency, scope)
    prev_amount, prev_days = await ctx.cost_total(prev_start, prev_end, currency, scope)

    # Both windows must be fully covered. A 7-day window holding 3 days
    # compared against one holding 7 is not a 57% drop — it is a gap in the
    # data wearing the costume of a trend.
    if cur_days < window or prev_days < window:
        return result.unknown(
            f"A {window}-day comparison needs {window} billed day(s) in each "
            f"window. The current window has {cur_days} and the baseline "
            f"({prev_start.isoformat()} to {prev_end.isoformat()}) has "
            f"{prev_days}. Comparing partial windows would report a data gap "
            "as a cost change.",
            unit=currency, as_of=coverage.get("latest"),
            context={"current_days": cur_days, "baseline_days": prev_days,
                     "window_days": window},
        )

    from app.services import cost_money

    change = cost_money.percent_change(
        cur_amount, prev_amount,
        current_currency=currency, previous_currency=currency,
    )
    if change.percent is None:
        # NEW / ENDED / NOT_COMPARABLE — a jump from zero is new spend, not an
        # infinite percentage, and this refuses to render it as one.
        return result.unknown(
            change.reason or "A percentage change could not be calculated for "
                             "these two periods.",
            unit=currency,
            context={"change_kind": change.kind,
                     "current": cur_amount, "baseline": prev_amount},
        )

    threshold = float(cfg.get("threshold_percent", 20))
    floor = cfg.get("min_absolute")
    observed = float(change.percent)
    fired = observed >= threshold
    floor_note = ""
    if fired and floor not in (None, ""):
        if (change.absolute or 0) < float(floor):
            fired = False
            floor_note = (f" The rise of {catalog.fmt_number(change.absolute)} "
                          f"{currency} is below the {catalog.fmt_number(floor)} "
                          f"{currency} floor set on this rule, so it is not "
                          "reported.")

    return result.compared(
        fired, observed, threshold, catalog.OP_GTE, unit="%",
        detail=(f"{catalog.fmt_number(cur_amount)} {currency} over "
                f"{cur_start.isoformat()}–{cur_end.isoformat()} against "
                f"{catalog.fmt_number(prev_amount)} {currency} over "
                f"{prev_start.isoformat()}–{prev_end.isoformat()}: a change of "
                f"{observed:+.1f}%.") + floor_note,
        as_of=coverage.get("latest"),
        context={"current": cur_amount, "baseline": prev_amount,
                 "absolute_change": change.absolute, "currency": currency,
                 "current_window": [cur_start.isoformat(), cur_end.isoformat()],
                 "baseline_window": [prev_start.isoformat(), prev_end.isoformat()]},
    )


def _no_cost_reason(diagnostic: Optional[Dict[str, Any]]) -> str:
    """Why there is no cost data — the provider's reason when we have one.

    Never asserts a cause this code cannot observe. If the diagnostic is empty
    we say the data is absent and that we do not know why, rather than claiming
    the provider reported no spend.
    """
    if diagnostic and diagnostic.get("message"):
        category = diagnostic.get("category")
        prefix = f"{category}: " if category else ""
        return (f"Billing data could not be retrieved. {prefix}"
                f"{diagnostic['message']}")
    return ("No billing records are stored for this account and no provider "
            "error was recorded. This can mean billing ingestion has not run "
            "yet, or that the provider genuinely reported no spend — those are "
            "different facts, and this rule will not guess between them.")


# ── Resources ─────────────────────────────────────────────────────────────────
_ATTRIBUTE_KEYS = {
    "total": "resource_count",
    "stopped": "stopped_count",
    "unattached": "unattached_count",
    "untagged": "untagged_count",
    "stale": "stale_count",
    "high_risk": "high_risk_count",
    "status_unknown": "status_unknown_count",
}


async def _resource_filters(scope: dict) -> Dict[str, Any]:
    filters: Dict[str, Any] = {}
    if scope.get("region"):
        filters["region"] = scope["region"]
    if scope.get("resource_type"):
        filters["type"] = scope["resource_type"]
    return filters


async def _eval_resource_status_count(ctx: EvalContext, cfg: dict,
                                      scope: dict) -> Evaluation:
    filters = await _resource_filters(scope)
    status = str(cfg.get("status", "STOPPED")).upper()
    if cfg.get("resource_type"):
        filters["type"] = cfg["resource_type"]
    filters["status"] = status

    summary = await ctx.resource_summary(**filters)
    observed = summary.get("resource_count")
    if observed is None:
        return result.unknown(
            "The inventory query returned no count for this filter, so the "
            "number of matching resources is unknown.")

    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(float(observed), operator, threshold)

    detail = f"{observed} resource(s) currently have the state {status}."
    if status != "UNKNOWN":
        # An estate where many resources report no status at all is one where
        # a "0 stopped" answer deserves a caveat rather than confidence.
        unknown_n = summary.get("status_unknown_count")
        if unknown_n:
            detail += (f" A further {unknown_n} resource(s) in this account "
                       "report no status at all and are counted in neither "
                       "direction.")

    return result.compared(
        fired, float(observed), threshold, operator, detail=detail,
        as_of=summary.get("newest_seen_at"),
        context={"status": status, "filters": filters,
                 "status_unknown_count": summary.get("status_unknown_count"),
                 "stale_count": summary.get("stale_count")},
    )


async def _eval_resource_attribute_count(ctx: EvalContext, cfg: dict,
                                         scope: dict) -> Evaluation:
    filters = await _resource_filters(scope)
    attribute = str(cfg.get("attribute", "unattached"))
    key = _ATTRIBUTE_KEYS.get(attribute)
    if key is None:
        return result.unsupported(
            f"{attribute!r} is not an inventory attribute this system records.")

    summary = await ctx.resource_summary(**filters)
    observed = summary.get(key)
    if observed is None:
        return result.unknown(
            f"The inventory summary did not report {attribute}, so the count "
            "is unknown.")

    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(float(observed), operator, threshold)

    detail = f"{observed} resource(s) match."
    if attribute == "high_risk":
        # The count of resources that were never assessed is the difference
        # between "nothing is risky" and "we have not looked".
        never = summary.get("risk_unknown_count")
        if never:
            detail += (f" {never} resource(s) have never been security-assessed "
                       "and are excluded rather than counted as safe.")

    return result.compared(
        fired, float(observed), threshold, operator, detail=detail,
        as_of=summary.get("newest_seen_at"),
        context={"attribute": attribute, "filters": filters,
                 "resource_count": summary.get("resource_count")},
    )


# ── Drift ─────────────────────────────────────────────────────────────────────
async def _eval_drift_count(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    hours = _int(cfg.get("window_hours"), 24)
    since = ctx.now - timedelta(hours=hours)
    severity = cfg.get("severity_filter", "ANY")

    if not await ctx.drift_has_history():
        return result.unknown(
            "No configuration changes have ever been recorded for this account. "
            "Drift is derived by comparing successive discovery scans, so until "
            "two scans have completed there is no baseline — which is not the "
            "same as nothing having changed."
        )

    observed = await ctx.drift_count(since, severity)
    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(float(observed), operator, threshold)

    return result.compared(
        fired, float(observed), threshold, operator,
        detail=(f"{observed} configuration change(s) recorded in the last "
                f"{hours} hour(s)"
                + ("" if severity == "ANY" else f" at severity {severity}") + "."),
        samples=(await ctx.drift_samples(since, severity)) if fired else [],
        as_of=ctx.now.isoformat(),
        context={"window_hours": hours, "severity_filter": severity},
    )


# ── Events ────────────────────────────────────────────────────────────────────
async def _eval_event_count(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    from app.models.event_admin import SYNC_DISABLED, SYNC_NEVER_RUN, SYNC_UNHEALTHY

    scopes = await ctx.event_scopes()
    if not scopes:
        return result.unknown(
            "Audit-event collection has never run for this account, so the "
            "event count is unknown rather than zero. Collect events once from "
            "the Event Log tab.")

    live = [s for s in scopes if s.status not in (SYNC_NEVER_RUN, SYNC_DISABLED)]
    if not live:
        return result.unknown(
            "Every audit-event collection scope for this account is disabled or "
            "has never run, so an empty result would mean 'not collected', not "
            "'nothing happened'.")

    broken = [s for s in live if s.status in SYNC_UNHEALTHY]
    hours = _int(cfg.get("window_hours"), 24)
    since = ctx.now - timedelta(hours=hours)
    risk = cfg.get("risk_at_least", "CRITICAL")
    status_filter = cfg.get("status_filter", "ANY")
    region = scope.get("region")

    observed = await ctx.event_count(since, risk, status_filter, region)
    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(float(observed), operator, threshold)

    # A count taken while some scopes are unreadable is a floor, not a total.
    # Reporting it as a total would let a broken collector resolve a real alert.
    if broken and not fired:
        return result.unknown(
            f"{observed} matching event(s) were counted, but "
            f"{len(broken)} of {len(live)} collection scope(s) cannot currently "
            "be read ("
            + ", ".join(sorted({s.status for s in broken}))
            + "). The true count is at least this much, so this rule will not "
              "report the condition as clear.",
            unit=None, as_of=ctx.now.isoformat(),
            context={"partial": True, "counted": observed,
                     "broken_scopes": len(broken), "live_scopes": len(live)},
        )

    detail = (f"{observed} matching audit event(s) in the last {hours} hour(s).")
    if broken:
        detail += (f" Note: {len(broken)} collection scope(s) are unreadable, so "
                   "the real number may be higher.")

    return result.compared(
        fired, float(observed), threshold, operator, detail=detail,
        samples=(await ctx.event_samples(since, risk, status_filter, region))
        if fired else [],
        as_of=ctx.now.isoformat(),
        context={"window_hours": hours, "risk_at_least": risk,
                 "status_filter": status_filter, "region": region,
                 "broken_scopes": len(broken)},
    )


async def _eval_event_collection_unhealthy(ctx: EvalContext, cfg: dict,
                                           scope: dict) -> Evaluation:
    from app.models.event_admin import SYNC_DISABLED, SYNC_NEVER_RUN, SYNC_UNHEALTHY

    scopes = await ctx.event_scopes()
    if not scopes:
        return result.unsupported(
            "Audit-event collection has never been set up for this account, so "
            "there is no collection health to report.")

    considered = [s for s in scopes if s.status not in (SYNC_NEVER_RUN, SYNC_DISABLED)]
    broken = [s for s in considered if s.status in SYNC_UNHEALTHY]
    observed = float(len(broken))
    fired = bool(broken)

    return result.compared(
        fired, observed, 0.0, catalog.OP_GT,
        detail=(f"{len(broken)} of {len(considered)} active collection scope(s) "
                "cannot be read." if broken
                else f"All {len(considered)} active collection scope(s) are "
                     "readable."),
        samples=[
            {"name": getattr(s, "scope", None) or "scope",
             "type": getattr(s, "provider", None), "severity": "HIGH",
             "detail": (f"{s.status}: "
                        f"{getattr(s, 'last_error', None) or 'no detail reported'}")}
            for s in broken[:MAX_SAMPLES]
        ],
        as_of=ctx.now.isoformat(),
        context={"broken": len(broken), "active": len(considered)},
    )


# ── Discovery ─────────────────────────────────────────────────────────────────
async def _eval_discovery_failed(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    state = await ctx.discovery()
    latest = state.get("latest")
    if latest is None:
        return result.unknown(
            "No discovery has ever been attempted for this account, so there is "
            "no last run to judge. That is not the same as a successful run.")

    if latest.get("status") in ("PENDING", "RUNNING"):
        return result.unknown(
            f"A discovery scan is currently {latest['status'].lower()}. Its "
            "outcome is not yet known.",
            as_of=latest.get("started_at"))

    failed = latest.get("status") == "FAILED"
    last_ok = state.get("last_successful") or {}
    return result.compared(
        failed, 1.0 if failed else 0.0, 0.0, catalog.OP_GT,
        detail=(f"The most recent scan {'FAILED' if failed else 'completed'}"
                + (f": {latest.get('error_detail')}" if failed and latest.get("error_detail")
                   else ".")
                + (f" The last successful scan was "
                   f"{last_ok.get('completed_at') or 'never'}."
                   if failed else "")),
        as_of=latest.get("completed_at") or latest.get("started_at"),
        context={"job_id": latest.get("id"), "status": latest.get("status"),
                 "resources_found": latest.get("resources_found"),
                 "last_successful_at": last_ok.get("completed_at")},
    )


async def _eval_discovery_stale(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    state = await ctx.discovery()
    last_ok = state.get("last_successful")
    threshold_hours = float(cfg.get("threshold_hours", 24))

    if last_ok is None or not last_ok.get("completed_at"):
        return result.triggered(
            None, threshold_hours, catalog.OP_GT, unit="hours",
            detail=("No discovery scan has ever completed successfully for this "
                    "account, so the inventory has never been populated. The age "
                    "is unbounded rather than a number."),
            context={"never_succeeded": True},
        )

    completed = _parse_iso(last_ok["completed_at"])
    if completed is None:
        return result.unknown(
            "The last successful scan's completion time could not be read, so "
            "its age cannot be measured.")

    age_hours = (ctx.now - completed).total_seconds() / 3600.0
    fired = age_hours > threshold_hours
    return result.compared(
        fired, round(age_hours, 2), threshold_hours, catalog.OP_GT, unit="hours",
        detail=(f"The last successful scan completed {age_hours:.1f} hour(s) ago "
                f"({last_ok['completed_at']})."),
        as_of=last_ok.get("completed_at"),
        context={"last_successful_at": last_ok.get("completed_at"),
                 "last_attempt_failed": state.get("last_attempt_failed")},
    )


# ── Platform ──────────────────────────────────────────────────────────────────
async def _eval_cost_data_unavailable(ctx: EvalContext, cfg: dict,
                                      scope: dict) -> Evaluation:
    diagnostic = ctx.cost_diagnostic()
    fired = bool(diagnostic)
    if not fired:
        return result.not_triggered(
            0.0, 0.0, catalog.OP_GT,
            detail=("No billing API error has been recorded for this account "
                    "since the service last started."),
            as_of=ctx.now.isoformat(),
        )
    occurred = diagnostic.get("occurred_at")
    return result.triggered(
        1.0, 0.0, catalog.OP_GT,
        detail=(f"{diagnostic.get('category') or 'Error'}: "
                f"{diagnostic.get('message') or 'the billing API could not be read.'}"
                + (f" Retry after {diagnostic['retry_after_seconds']}s."
                   if diagnostic.get("retry_after_seconds") else "")
                + (" This will not clear without a configuration change."
                   if diagnostic.get("terminal") else "")),
        as_of=(datetime.fromtimestamp(occurred, tz=timezone.utc).isoformat()
               if isinstance(occurred, (int, float)) else ctx.now.isoformat()),
        context={"category": diagnostic.get("category"),
                 "terminal": diagnostic.get("terminal"),
                 "retryable": diagnostic.get("retryable"),
                 "http_status": diagnostic.get("http_status"),
                 "required_permission": diagnostic.get("required_permission"),
                 "provider": ctx.account.provider},
    )


# ── Certificates and secrets ─────────────────────────────────────────────────
async def _eval_credential_expiry(ctx: EvalContext, cfg: dict, scope: dict) -> Evaluation:
    from app.models.credential_inventory import (
        COLLECT_NOT_SUPPORTED, COLLECT_OK, KIND_CERTIFICATE, KIND_KEY, KIND_SECRET,
    )
    from app.security import credentials as credx

    objects, sources = await ctx.credential_inventory()
    kind = cfg.get("kind", "CERTIFICATE")
    kinds = {"CERTIFICATE": {KIND_CERTIFICATE},
             "SECRET_OR_KEY": {KIND_SECRET, KIND_KEY}}.get(
        kind, {KIND_CERTIFICATE, KIND_SECRET, KIND_KEY})
    relevant_sources = set()
    if KIND_CERTIFICATE in kinds:
        relevant_sources |= credx.CERT_SOURCES | credx.IAM_CERT_SOURCES
    if kinds & {KIND_SECRET, KIND_KEY}:
        relevant_sources |= credx.SECRET_SOURCES
    noun = {"CERTIFICATE": "certificate(s)", "SECRET_OR_KEY": "secret(s) or key(s)"}.get(
        kind, "certificate(s), secret(s) or key(s)")

    mine = [s for s in sources if s.source in relevant_sources]
    if not mine:
        return result.unsupported(
            "Certificates and secrets have not been collected for this account yet. They "
            "are read during every discovery scan; after the next one this rule can be "
            "evaluated. Until then there is no count — which is not the same as none.")
    ok = [s for s in mine if s.status == COLLECT_OK]
    failed = [s for s in mine if s.status not in (COLLECT_OK, COLLECT_NOT_SUPPORTED)]
    # A store refused NOW but read successfully before still holds the objects
    # it returned then (a refusal never deletes them), and the Security Center
    # keeps counting them — so this does too. Only a store that has NEVER been
    # read leaves nothing to count, which is UNKNOWN, not zero.
    ever_read = [s for s in mine if s.status == COLLECT_OK or s.last_success_at]
    if not ever_read:
        return result.unknown(
            f"None of the {len(failed) or len(mine)} store(s) holding {noun} has ever "
            f"been read ({', '.join(sorted({s.status for s in mine}))}), so there is "
            "nothing to count — which is not the same as nothing expiring.")

    days = max(0, _int(cfg.get("within_days"), 30))
    include_expired = cfg.get("include_expired", "yes") == "yes"
    horizon = ctx.now + timedelta(days=days)
    hits = []
    for o in objects:
        if o.kind not in kinds or o.enabled is False or o.expires_at is None:
            continue
        if o.expires_at > horizon:
            continue
        if o.expires_at < ctx.now and not include_expired:
            continue
        hits.append(o)
    hits.sort(key=lambda o: o.expires_at)

    observed = float(len(hits))
    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(observed, operator, threshold)

    def _sample(o) -> Dict[str, Any]:
        left = (o.expires_at - ctx.now).total_seconds() / 86400.0
        return {
            "name": o.name or o.object_key,
            "type": o.kind.title(),
            "severity": "HIGH" if left < 0 else "MEDIUM" if left <= credx.URGENT_DAYS else "LOW",
            "detail": ((f"expired {int(-left)} day(s) ago" if left < 0
                        else f"expires in {int(left)} day(s)")
                       + f" — {o.expires_at.strftime('%d %b %Y')}"
                       + (f", {o.container_name}" if o.container_name else "")),
        }

    gap = (f" {len(failed)} store(s) could not be read this time; objects from them "
           "are counted as last seen." if failed else "")
    return result.compared(
        fired, observed, threshold, operator,
        detail=(f"{len(hits)} {noun} "
                + ("expired" if days == 0 else f"expire within {days} day(s)"
                   + (" or have already expired" if include_expired else ""))
                + f".{gap}"),
        samples=[_sample(o) for o in hits[:MAX_SAMPLES]] if fired else [],
        as_of=ctx.now.isoformat(),
        context={"within_days": days, "kind": kind, "include_expired": include_expired,
                 "stores_read": len(ok), "stores_unreadable": len(failed)},
    )


async def _eval_intelligence_finding_count(ctx: EvalContext, cfg: dict,
                                           scope: dict) -> Evaluation:
    """Open optimization findings, from the table the analysis writes. An
    account never analysed is UNKNOWN — its finding count is not zero."""
    from app.repository.optimization_repo import OptimizationRepository

    repo = OptimizationRepository(ctx.db)
    run = await repo.latest_run(ctx.account_id)
    if run is None:
        return result.unknown(
            "This account has not been analysed by Resource Intelligence yet, so the "
            "number of open findings is unknown. It is NOT zero. Refresh intelligence "
            "(or Refresh all) runs the analysis.")
    rows = await repo.for_accounts([ctx.account_id], statuses=["OPEN", "ACKNOWLEDGED"])
    category = cfg.get("category_filter", "ANY")
    severity = cfg.get("severity_filter", "ANY")
    if category != "ANY":
        rows = [r for r in rows if r.category == category]
    if severity != "ANY":
        rows = [r for r in rows if r.severity == severity]
    observed = len(rows)
    threshold = float(cfg.get("threshold", 0))
    operator = cfg.get("operator", catalog.OP_GT)
    fired = catalog.compare(observed, operator, threshold)
    detail = f"{observed} open finding(s) match this rule."
    if run.outcome != "COMPLETE":
        detail += (" The latest analysis was partial: findings it could not re-check "
                   "stay open, so this count may include some it could not re-verify.")
    return result.compared(
        fired, observed, threshold, operator, detail=detail,
        as_of=run.finished_at.isoformat() if run.finished_at else None,
        samples=[{"name": r.resource_name or r.resource_key, "type": r.resource_type,
                  "severity": r.severity, "detail": r.title}
                 for r in sorted(rows, key=lambda x: (_sev_rank(x.severity),
                                                      -(x.estimated_savings or 0)))[:MAX_SAMPLES]],
        context={"category_filter": category, "severity_filter": severity,
                 "analysis_outcome": run.outcome},
    )


def _int(value: Any, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


# ── Dispatch ──────────────────────────────────────────────────────────────────
# Every catalog key must appear here. The assertion below is what stops the two
# from drifting: adding a condition to the catalog without an evaluator would
# otherwise ship a rule the UI offers and the engine cannot answer.
EVALUATORS: Dict[str, Callable] = {
    catalog.SECURITY_FINDING_COUNT: _eval_security_finding_count,
    catalog.SECURITY_SCORE_BELOW: _eval_security_score,
    catalog.COST_THRESHOLD: _eval_cost_threshold,
    catalog.COST_INCREASE_PERCENT: _eval_cost_increase,
    catalog.RESOURCE_STATUS_COUNT: _eval_resource_status_count,
    catalog.RESOURCE_ATTRIBUTE_COUNT: _eval_resource_attribute_count,
    catalog.DRIFT_COUNT: _eval_drift_count,
    catalog.EVENT_COUNT: _eval_event_count,
    catalog.DISCOVERY_FAILED: _eval_discovery_failed,
    catalog.DISCOVERY_STALE: _eval_discovery_stale,
    catalog.COST_DATA_UNAVAILABLE: _eval_cost_data_unavailable,
    catalog.EVENT_COLLECTION_UNHEALTHY: _eval_event_collection_unhealthy,
    catalog.CREDENTIAL_EXPIRY: _eval_credential_expiry,
    catalog.INTELLIGENCE_FINDING_COUNT: _eval_intelligence_finding_count,
}

_MISSING = set(catalog.CONDITIONS) - set(EVALUATORS)
_EXTRA = set(EVALUATORS) - set(catalog.CONDITIONS)
assert not _MISSING, f"Catalog conditions with no evaluator: {sorted(_MISSING)}"
assert not _EXTRA, f"Evaluators with no catalog entry: {sorted(_EXTRA)}"


async def evaluate(ctx: EvalContext, condition_type: str, config: dict,
                   scope: Optional[dict] = None) -> Evaluation:
    """Run one condition. Never raises — an evaluator that blows up becomes an
    ERROR result carrying the exception text, because a crashed evaluation must
    be visible in the rule's status rather than silently skipped."""
    fn = EVALUATORS.get(condition_type)
    if fn is None:
        return result.unsupported(
            f"{condition_type!r} has no evaluator in this build.")
    try:
        return await fn(ctx, dict(config or {}), dict(scope or {}))
    except Exception as exc:  # noqa: BLE001
        logger.exception("Alert evaluator %s failed for account %s",
                         condition_type, ctx.account_id)
        return result.errored(f"{type(exc).__name__}: {exc}")
