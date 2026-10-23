"""Resource assessment report builder: scope resolution + dataset assembly.

This is the generalization of `resource_assessment_service.py` (which still
exists and still backs the simpler "Export Assessment" button) into a real
report pipeline with section toggles, three scope modes, and a reporting
period. It does not re-implement Security, Utilization, Performance or
cost-anomaly detection -- it formats rows with the same row builders that
module has, and a disabled section never even queries its table.

**Every source is read in one batch, not per resource.** The first version
called the per-resource helpers in a loop: three or four queries per
resource, so a 1,000-resource account cost ~4,000 round trips -- for the
Preview step too, which then threw most of it away.

**What each section actually is, honestly stated:**

  Executive summary -- arithmetic over the rows this request already built.
  Inventory          -- `cloud_resources` as of now; a snapshot, not history.
  Security           -- OPEN/IN_PROGRESS CloudSecurityFinding rows. Matched to
                        resources by provider id, case-insensitively (Azure's
                        IDs differ in case between APIs). Findings that belong
                        to no inventoried resource -- subscription-wide role
                        assignments, tenancy policies, account checks -- are
                        "Account-level". A whole-account report includes them;
                        a filtered or hand-picked one cannot attribute them to
                        its resources, so it says how many it left out.
  Utilization        -- CloudResourceTelemetry plus the UNUSED/UNDERUTILIZED
                        optimization findings. Each metric carries its own
                        collection window, which is NOT the report period.
  Performance        -- the PERFORMANCE/CONSTRAINED optimization findings.
  Recommendations    -- the remaining optimization findings (advisory).
  Anomalies          -- account-wide daily spend anomalies within the report
                        period. There is no per-resource anomaly engine.
  Cost               -- per resource: `cloud_resource_costs`, the latest
                        billed amount with its own currency and window (the
                        old `CloudResource.cost_monthly` column is never
                        populated, which made this section empty for every
                        account). Plus `cost_summary`: account spend within the
                        report period, from `cloud_cost_facts`.
  Data quality       -- per-section coverage (how many resources had something
                        to report, how many did not and why, which sections
                        could not be read) and when each source last refreshed.

**No filler rows.** A resource with nothing to report in a section used to
get a "No findings" row there -- three filler rows per resource on a whole-
account report, burying the real findings. Now it is counted in `coverage`
(and named, with the reason, at the Detailed level).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.optimization import CloudOptimizationFinding, CloudOptimizationRun, CloudResourceTelemetry
from app.models.resource import CloudResource
from app.models.resource_cost import CloudResourceCost
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding
from app.optimization.model import ACTIVE_STATUSES
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.cost_fact_repo import CostFactRepository
from app.schemas.reports import (
    DETAIL_DETAILED, DETAIL_EXECUTIVE, SCOPE_ACCOUNT, SCOPE_FILTERED, SCOPE_RESOURCES,
    ReportDateRange, ReportScope, ReportSections,
)
from app.services import resource_assessment_service as ras
from app.services import resource_capabilities as caps
from app.services.resource_assessment_service import TooManyResourcesError

REPORT_MAX_RESOURCES = 1000

# Sections whose value is a list of rows, in report order.
ROW_SECTIONS = ("inventory", "security", "utilization", "performance",
                "recommendations", "cost", "anomalies", "certificates", "changes")
# Sections whose value is a dict of figures.
SUMMARY_SECTIONS = ("executive_summary", "cost_summary", "posture", "identity", "activity",
                    "data_quality")

SECTION_LABELS = {
    "executive_summary": "Executive Summary", "inventory": "Resource Inventory",
    "security": "Security Assessment", "utilization": "Resource Utilization",
    "performance": "Performance Analysis", "recommendations": "Recommendations",
    "cost": "Cost", "cost_summary": "Account Spend", "anomalies": "Spend Anomalies (Account-Wide)",
    "posture": "Security Posture & Compliance", "identity": "Identity & Access",
    "certificates": "Expiring Certificates & Secrets", "changes": "Configuration Changes",
    "activity": "Account Activity (Event Log)",
    "data_quality": "Data Quality & Coverage",
}

SEVERITY_RANK = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}
OPEN_SECURITY_STATUSES = ("OPEN", "IN_PROGRESS")

ATTRIBUTION_RESOURCE = "Resource"
ATTRIBUTION_ACCOUNT = "Account-level"

# A refresh older than this is called out on the report's first page.
STALE_AFTER_DAYS = 7

_INVENTORY_NOTE = (
    "Resource inventory, security findings, optimization findings and "
    "per-resource billed cost are the current state as of the last refresh, "
    "not a history of the reporting period."
)
_UTILIZATION_NOTE = (
    "Utilization metrics cover each metric's own collection window (shown per "
    "row), not the reporting period -- the telemetry store keeps one window "
    "per metric."
)


# The Resources-table filters a report scope may carry -- build_query's own
# keyword names. Anything else is dropped: build_query takes keywords only, so
# one stray key from a stale draft or a hand-written template was a TypeError
# (HTTP 500) rather than a narrower report.
FILTER_KEYS = ("q", "provider", "type", "category", "service", "region", "status", "risk",
               "environment", "owner", "resource_group", "compartment", "has_tags",
               "has_cost", "has_findings")


def clean_filters(filters: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key in FILTER_KEYS:
        value = (filters or {}).get(key)
        if value in (None, "", []):
            continue
        out[key] = value
    return out


def summary_snapshot(dataset: Dict[str, Any]) -> Dict[str, Any]:
    """The figures kept with a report in history, for "since the last report".

    Only what this report actually measured: a report without the security
    section has no finding count -- storing 0 would make the next report
    announce a fall that never happened.
    """
    secs = dataset["sections"]
    snap: Dict[str, Any] = {"resources_in_scope": dataset["resources_resolved"],
                            "period_start": (dataset.get("period") or {}).get("start"),
                            "period_end": (dataset.get("period") or {}).get("end")}
    sec_rows = secs.get("security")
    if isinstance(sec_rows, list) and not any(r.get("title") == "Unavailable" for r in sec_rows):
        by_sev: Dict[str, int] = {}
        for r in sec_rows:
            if r.get("severity"):
                by_sev[r["severity"]] = by_sev.get(r["severity"], 0) + 1
        snap["findings_by_severity"] = by_sev
        snap["findings_total"] = sum(by_sev.values())
        snap["critical_or_high"] = by_sev.get("CRITICAL", 0) + by_sev.get("HIGH", 0)
        snap["account_level_findings"] = sum(
            1 for r in sec_rows if r.get("attribution") == ATTRIBUTION_ACCOUNT)
    posture = dataset.get("posture_score") or {}
    if posture.get("status") == "ok" and posture.get("reliable"):
        snap["posture_score"] = posture.get("score")
        snap["posture_grade"] = posture.get("grade")
    if "savings" in dataset:
        snap["potential_monthly_savings"] = dataset["savings"]["monthly_by_currency"]
    cost_rows = secs.get("cost")
    if isinstance(cost_rows, list) and (dataset["coverage"].get("cost") or {}).get("status") == "ok":
        billed: Dict[str, float] = {}
        for r in cost_rows:
            if r.get("cost_amount") is not None:
                code = r.get("currency") or "?"
                billed[code] = round(billed.get(code, 0.0) + r["cost_amount"], 2)
        snap["billed_cost_in_scope"] = billed
    certs = secs.get("certificates")
    if isinstance(certs, list) and (dataset["coverage"].get("certificates") or {}).get("status") == "ok":
        snap["credentials_expired"] = sum(1 for r in certs if (r.get("days_left") or 0) < 0)
    if isinstance(secs.get("changes"), list):
        snap["config_changes"] = len(secs["changes"])
    return snap


async def build_for_request(db: AsyncSession, request) -> Tuple[List[uuid.UUID], int, Dict[str, Any], Dict[str, Any]]:
    """The one path from a request to a laid-out dataset, shared by Preview,
    Generate and the scheduler: (resource_ids, total, dataset, snapshot).
    The snapshot is taken before the detail level strips rows."""
    resource_ids, total = await resolve_report_scope(db, request.account_id, request.scope)
    dataset = await build_report_dataset(
        db, request.account_id, resource_ids, request.sections, request.date_range,
        scope_mode=request.scope.mode,
    )
    snapshot = summary_snapshot(dataset)
    order_rows(dataset, request.layout.group_by, request.layout.sort_by)
    apply_detail_level(dataset, request.layout.detail_level)
    dataset["scope"]["filters"] = (clean_filters(request.scope.filters)
                                   if request.scope.mode == SCOPE_FILTERED else {})
    return resource_ids, total, dataset, snapshot


async def resolve_report_scope(
    db: AsyncSession, account_id: uuid.UUID, scope: ReportScope,
) -> Tuple[List[uuid.UUID], int]:
    """(resource_ids, total_matching). Raises TooManyResourcesError rather
    than silently truncating -- the caller must narrow the scope."""
    if scope.mode == SCOPE_RESOURCES:
        ids = list(dict.fromkeys(scope.resource_ids))
        if len(ids) > REPORT_MAX_RESOURCES:
            raise TooManyResourcesError(len(ids), REPORT_MAX_RESOURCES, "a report")
        return ids, len(ids)

    from app.repository.resource_query_repo import build_query
    from app.services.resource_query_service import ResourceQueryService

    svc = ResourceQueryService(db)
    accounts, _is_global = await svc.resolve_scope(str(account_id))
    account_ids = [a.id for a in accounts]
    params: Dict[str, Any] = clean_filters(scope.filters) if scope.mode == SCOPE_FILTERED else {}
    # `ResourceQueryService.query()` always paginates (DEFAULT_PAGE_SIZE=50,
    # capped at MAX_PAGE_SIZE=250) -- it is built for the on-screen page, not
    # "every matching row". `export_csv` reaches for `repo.iter_all(query)`
    # instead for exactly that reason, so the report does the same rather
    # than silently capping "whole account" scope at 50 resources.
    query = build_query(
        account_ids=account_ids,
        assessed_account_ids=await svc.assessed_account_ids(account_ids),
        **params,
    )
    total = await svc.repo.count(query)
    if total > REPORT_MAX_RESOURCES:
        raise TooManyResourcesError(total, REPORT_MAX_RESOURCES, "a report")
    ids = [row[0].id async for row in svc.repo.iter_all(query)]
    return ids, total


# ── Row shapes ───────────────────────────────────────────────────────────────

def _inventory_row(resource) -> Dict[str, Any]:
    return {
        "resource_name": resource.resource_name,
        "provider_resource_id": resource.provider_resource_id,
        "resource_type": resource.resource_type,
        "region": resource.region_or_zone,
        "status": resource.normalized_status or resource.status,
        "environment": resource.environment,
        "owner": resource.owner,
        "resource_group": resource.resource_group,
        "compartment": resource.compartment,
        "tags": resource.tags or {},
        "discovered_at": ras._iso(resource.discovered_at),
        "last_seen_at": ras._iso(resource.last_seen_at),
    }


def _cost_row(base: Dict[str, Any], cost: CloudResourceCost) -> Dict[str, Any]:
    """A stored billing observation. `cost_amount` None means the provider
    listed the resource without an amount -- unknown, never zero."""
    known = cost.amount is not None
    return {
        **base,
        "cost_amount": float(cost.amount) if known else None,
        "currency": cost.currency,
        "cost_period_days": cost.period_days,
        "billed_service": cost.billed_service,
        "cost_fetched_at": ras._iso(cost.fetched_at),
        "status": "Billed (provider billing)" if known else "Billed, amount not reported",
    }


def _account_level_base(account_name: str, provider: str, f) -> Dict[str, Any]:
    return {
        "account_name": account_name,
        "provider": provider,
        "region": f.region,
        "resource_name": f.resource_name or ATTRIBUTION_ACCOUNT,
        "resource_type": f.resource_type,
        "provider_resource_id": f.resource_key,
        "attribution": ATTRIBUTION_ACCOUNT,
    }


def _missing_entry(resource, reason: str) -> Dict[str, Any]:
    return {
        "resource_name": resource.resource_name,
        "provider_resource_id": resource.provider_resource_id,
        "resource_type": resource.resource_type,
        "region": resource.region_or_zone,
        "reason": reason,
    }


def _coverage(checked: int, with_data: int, without: List[Dict[str, Any]],
              *, error: Optional[str] = None) -> Dict[str, Any]:
    return {
        "status": "unavailable" if error else "ok",
        "error": error,
        "resources_checked": checked,
        "resources_with_data": None if error else with_data,
        "resources_without_data": None if error else len(without),
        "without": [] if error else without,
    }


def _unavailable_row(category: str, what: str, exc: Exception) -> Dict[str, Any]:
    return {"assessment_category": category, "severity": None, "title": "Unavailable",
            "detail": f"{what} could not be read: {exc}", "metric_value": None,
            "status": None, "detected_at": None}


# ── Batched loaders ──────────────────────────────────────────────────────────

async def _load_resources(db: AsyncSession, account_id: uuid.UUID,
                          resource_ids: Sequence[uuid.UUID]) -> List[CloudResource]:
    if not resource_ids:
        return []
    rows = (await db.execute(
        select(CloudResource).where(CloudResource.id.in_(list(resource_ids)),
                                    CloudResource.account_id == account_id)
    )).scalars().all()
    by_id = {r.id: r for r in rows}
    # Request order, so a hand-picked list keeps the order it was picked in
    # until the layout's sort applies.
    return [by_id[rid] for rid in resource_ids if rid in by_id]


async def _inventory(db: AsyncSession, account_id: uuid.UUID) -> Tuple[set, set]:
    """(lower-cased provider ids, resource UUIDs) of every inventoried
    resource in the account -- what decides whether a finding is about a
    resource at all."""
    rows = (await db.execute(
        select(CloudResource.id, CloudResource.provider_resource_id)
        .where(CloudResource.account_id == account_id)
    )).all()
    return {k.lower() for _, k in rows if k}, {i for i, _ in rows}


async def _freshness(db: AsyncSession, account_id: uuid.UUID,
                     now: datetime) -> Dict[str, Any]:
    from app.services.account_refresh_service import AccountRefreshService

    out: Dict[str, Any] = {"warnings": []}
    try:
        last = await AccountRefreshService(db).last_refreshed(account_id)
    except Exception as exc:  # noqa: BLE001
        last = None
        out["warnings"].append(f"When this account last refreshed could not be read: {exc}")
    out.update({
        "last_refreshed_at": (last or {}).get("at"),
        "refresh_status": (last or {}).get("status"),
        "refresh_source": (last or {}).get("source"),
        "scopes_read": (last or {}).get("scopes_read"),
        "scopes_attempted": (last or {}).get("scopes_attempted"),
        "refresh_note": (last or {}).get("note"),
    })

    async def _max(column, *where):
        try:
            value = (await db.execute(select(func.max(column)).where(*where))).scalar()
        except Exception:  # noqa: BLE001
            return None
        if isinstance(value, datetime):
            return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()
        return value.isoformat() if value is not None else None

    from app.models.cost_fact import CloudCostFact

    out["security_assessed_at"] = await _max(
        CloudSecurityAssessment.finished_at, CloudSecurityAssessment.account_id == account_id)
    out["intelligence_analysed_at"] = await _max(
        CloudOptimizationRun.finished_at, CloudOptimizationRun.account_id == account_id)
    out["billing_data_through"] = await _max(
        CloudCostFact.billing_date, CloudCostFact.account_id == account_id)
    out["resource_costs_fetched_at"] = await _max(
        CloudResourceCost.fetched_at, CloudResourceCost.account_id == account_id)

    if last is None:
        out["warnings"].append(
            "This account has no completed refresh or discovery scan on record, so "
            "everything in this report may be incomplete.")
    else:
        status = last.get("status")
        if status and status != "SUCCEEDED":
            # The note of a partial refresh already names the unread scopes.
            detail = f": {last['note']}" if last.get("note") else "."
            out["warnings"].append(f"The last refresh finished {status}{detail}")
        elif last.get("scopes_attempted") and last.get("scopes_read") is not None \
                and last["scopes_read"] < last["scopes_attempted"]:
            out["warnings"].append(
                f"The last sweep read {last['scopes_read']} of {last['scopes_attempted']} "
                f"scopes, so some resources and findings may be missing.")
        try:
            at = datetime.fromisoformat(last["at"])
            age_days = (now - at).days
            if age_days >= STALE_AFTER_DAYS:
                out["warnings"].append(
                    f"The data is {age_days} days old (last refreshed {at.date().isoformat()}).")
        except (KeyError, TypeError, ValueError):
            pass
    return out


def spend_change(series: Sequence[Dict[str, Any]], period: Tuple[Any, Any],
                 billing_through: Optional[str]) -> Optional[Dict[str, Any]]:
    """Spend in the period against the equal-length window just before it.

    Like for like, or not at all. Billing lags by days, so "the last 30 days"
    almost always ends with unbilled days, and comparing a 23-day total with a
    30-day one would report a fall that never happened. So the current window
    is cut at the last billed day, the previous window gets the same length,
    and a currency is compared only when BOTH windows have a billed amount on
    every day. Anything else is not comparable, with the reason.

    `series` is daily_series() output covering both windows.
    """
    from datetime import date as _date

    from app.services.cost_money import NOT_COMPARABLE, Change, percent_change

    first_day, last_day = period
    if not billing_through:
        return None
    through = _date.fromisoformat(str(billing_through)[:10])
    current_end = min(last_day, through)
    if current_end < first_day:
        return None
    length = (current_end - first_day).days + 1
    prev_start, prev_end = first_day - timedelta(days=length), first_day - timedelta(days=1)

    days: Dict[str, Dict[str, Dict[str, float]]] = {}
    for p in series:
        if p.get("amount") is None:
            continue
        d = _date.fromisoformat(str(p["date"])[:10])
        side = ("current" if first_day <= d <= current_end
                else "previous" if prev_start <= d <= prev_end else None)
        if side:
            bucket = days.setdefault(p.get("currency") or "?", {"current": {}, "previous": {}})
            bucket[side][d.isoformat()] = bucket[side].get(d.isoformat(), 0.0) + float(p["amount"])

    by_currency: Dict[str, Any] = {}
    for code, sides in sorted(days.items()):
        cur_days, prev_days = len(sides["current"]), len(sides["previous"])
        cur, prev = round(sum(sides["current"].values()), 2), round(sum(sides["previous"].values()), 2)
        if cur_days < length or prev_days < length:
            change = Change(NOT_COMPARABLE, currency=code, reason=(
                f"Not like for like: {cur_days} of {length} days billed in the current window and "
                f"{prev_days} of {length} in the previous one."))
        else:
            change = percent_change(cur, prev, current_currency=code, previous_currency=code)
        by_currency[code] = {"current": cur, "previous": prev, **change.to_dict()}
    return {
        "basis": (f"{first_day.isoformat()} to {current_end.isoformat()} ({length} billed day(s)) "
                  f"against {prev_start.isoformat()} to {prev_end.isoformat()}."),
        "current_window": [first_day.isoformat(), current_end.isoformat()],
        "previous_window": [prev_start.isoformat(), prev_end.isoformat()],
        "by_currency": by_currency,
    }


async def _cost_summary(db: AsyncSession, account_id: uuid.UUID,
                        period: Tuple[Any, Any], scope_mode: str,
                        freshness: Dict[str, Any]) -> Dict[str, Any]:
    first_day, last_day = period
    repo = CostFactRepository(db)
    try:
        series = await repo.daily_series([account_id], first_day, last_day + timedelta(days=1))
        services = await repo.totals_by([account_id], first_day, last_day + timedelta(days=1),
                                        dimension="service", limit=10)
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "error": f"Billing history could not be read: {exc}"}

    totals: Dict[str, Dict[str, Any]] = {}
    for point in series:
        bucket = totals.setdefault(point["currency"] or "?", {"amount": 0.0, "days_billed": 0})
        if point["amount"] is not None:
            bucket["amount"] += point["amount"]
            bucket["days_billed"] += 1
    out: Dict[str, Any] = {
        "status": "ok" if totals else "no_data",
        "basis": ("Account-wide spend from stored provider billing within the reporting "
                  "period" + ("" if scope_mode == SCOPE_ACCOUNT
                              else " -- the whole account, not only the resources in this "
                                   "report's scope") + "."),
        "spend_by_currency": {c: {"amount": round(v["amount"], 2), "days_billed": v["days_billed"]}
                              for c, v in sorted(totals.items())},
        "top_services": [
            {"service": s.get("service") or "(unlabelled)", "currency": s.get("currency"),
             "amount": round(s["amount"], 2) if s.get("amount") is not None else None}
            for s in services
        ],
        "billing_data_through": freshness.get("billing_data_through"),
    }
    through = freshness.get("billing_data_through")
    try:
        span = (last_day - first_day).days + 1
        both = await repo.daily_series([account_id], first_day - timedelta(days=span),
                                       last_day + timedelta(days=1))
        out["change"] = spend_change(both, period, through)
    except Exception as exc:  # noqa: BLE001
        out["change"] = {"basis": None, "by_currency": {}, "error": f"Comparison unavailable: {exc}"}
    if through and through < last_day.isoformat():
        out["gap_note"] = (f"Billing data is only available through {through}; spend after "
                           f"that date in the period is not included yet.")
    if not totals:
        out["gap_note"] = "No billing data is stored for this account within the reporting period."
    return out


def _period_bounds_utc(period: Tuple[Any, Any], tz_name: str) -> Tuple[datetime, datetime]:
    """[first day 00:00, day after last day 00:00) in the period's own zone,
    as UTC instants -- the window timestamped tables are filtered on."""
    from zoneinfo import ZoneInfo

    zone = ZoneInfo(tz_name)
    first_day, last_day = period
    start = datetime(first_day.year, first_day.month, first_day.day, tzinfo=zone)
    end_day = last_day + timedelta(days=1)
    end = datetime(end_day.year, end_day.month, end_day.day, tzinfo=zone)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


async def _posture_score(db: AsyncSession, account_id: uuid.UUID) -> Dict[str, Any]:
    """The Security Center's published score, exactly as the Security Center
    shows it -- including when it is withheld. A withheld score is reported
    as withheld, never as 0 and never as the raw number it refused to vouch for."""
    from app.repository.security_repo import SecurityRepository

    try:
        latest = await SecurityRepository(db).latest_assessment(account_id)
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "error": f"Security assessment could not be read: {exc}"}
    if latest is None:
        return {"status": "not_assessed", "grade": "Not assessed",
                "note": "No security assessment has run for this account."}
    breakdown = latest.score_breakdown or {}
    reliable = bool(latest.score_reliable)
    return {
        "status": "ok",
        "score": latest.score if reliable else None,
        "grade": latest.grade,
        "reliable": reliable,
        "coverage_pct": latest.coverage_pct,
        "assessed_at": ras._iso(latest.finished_at),
        "grade_capped_by": breakdown.get("grade_capped_by"),
        "note": None if reliable else (
            "The Security Center withholds this account's score: too little of the "
            "account could be assessed for a number to be meaningful."),
    }


async def _posture_section(db: AsyncSession, account_id: uuid.UUID,
                           score: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.security_center_service import SecurityCenterService

    out: Dict[str, Any] = {"score": score, "frameworks": []}
    try:
        # include_diff=False: the trend reads a key no assessment writes, so it
        # would only ever say "unavailable" at the cost of an extra query.
        comp = await SecurityCenterService(db).compliance(account_id, include_diff=False)
    except Exception as exc:  # noqa: BLE001
        out["frameworks_status"] = "unavailable"
        out["frameworks_error"] = f"Compliance could not be evaluated: {exc}"
        return out
    out["frameworks_status"] = "ok"
    for key, fw in sorted((comp.get("frameworks") or {}).items()):
        out["frameworks"].append({
            "framework": fw.get("label") or key,
            "controls_assessed": fw.get("controls_assessed"),
            "passed": fw.get("controls_passed"),
            "failed": fw.get("controls_failed"),
            "partial": fw.get("controls_partial"),
            "unknown": fw.get("controls_unknown"),
            "not_applicable": fw.get("controls_not_applicable"),
            # None when nothing could be rated -- never a 0% pass rate.
            "pass_rate": fw.get("control_pass_rate"),
            "coverage": fw.get("assessment_coverage"),
            "note": fw.get("framework_note") or fw.get("note"),
        })
    out["basis"] = ("Control results are evaluated from the stored security findings. A control "
                    "that could not be evaluated is counted as unknown, never as passed.")
    return out


async def _identity_labels(db: AsyncSession, ids: Sequence[Any]) -> Dict[str, str]:
    """A readable label per identity. Azure names principals by object id only
    until Graph resolves them, and Graph is denied on every live tenant -- so
    the display name is often NULL. Falls back to the sign-in name, then to the
    type and provider id, stated as unresolved rather than left blank."""
    from app.models.identity import CloudIdentity

    wanted = [uuid.UUID(str(i)) for i in ids if i]
    if not wanted:
        return {}
    try:
        rows = (await db.execute(
            select(CloudIdentity.id, CloudIdentity.name, CloudIdentity.principal_name,
                   CloudIdentity.identity_type, CloudIdentity.provider_id)
            .where(CloudIdentity.id.in_(wanted))
        )).all()
    except Exception:  # noqa: BLE001
        return {}
    return {str(i): (name or principal or f"{itype} {pid} (name not resolved)")
            for i, name, principal, itype, pid in rows}


async def _identity_section(db: AsyncSession, account_id: uuid.UUID) -> Dict[str, Any]:
    from app.services.identity_query_service import IdentityQueryService

    svc = IdentityQueryService(db)
    try:
        ov = await svc.overview(account_id)
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "error": f"Identity & Access could not be read: {exc}"}
    analysis = ov.get("analysis") or {}
    counts = ov.get("counts") or {}
    out: Dict[str, Any] = {
        "status": "ok" if counts.get("identities") else "no_data",
        "analysis_status": analysis.get("status"),
        "analysed_at": analysis.get("finished_at") or analysis.get("completed_at"),
        "trustworthy": analysis.get("trustworthy"),
        "counts": {k: counts.get(k) for k in (
            "identities", "assessed", "not_assessed", "admin", "standing_admin", "privileged",
            "mfa_gaps", "mfa_unknown", "external", "stale_credentials", "high_blast_radius")},
        "coverage_percent": (ov.get("coverage") or {}).get("percent"),
    }
    try:
        # A null last_used_at is "unknown", not dormant -- the query only
        # counts identities with a recorded last use older than the cutoff.
        out["counts"]["dormant_90_days"] = (await svc.list_identities(
            account_id, dormant_days=90, page_size=1)).get("total")
    except Exception:  # noqa: BLE001
        out["counts"]["dormant_90_days"] = None
    top = (ov.get("top_blast_radius") or [])[:TOP_N]
    labels = await _identity_labels(db, [b.get("identity_id") for b in top])
    out["top_identities"] = [
        {"identity": labels.get(str(b.get("identity_id"))) or b.get("identity_name"),
         "blast_radius_score": b.get("score"),
         "band": b.get("score_band"), "direct_resources": b.get("direct_resources"),
         "sensitive_resources": b.get("sensitive_resources"),
         "high_impact_capabilities": ", ".join(
             k for k, v in sorted((b.get("capabilities") or {}).items()) if v) or None}
        for b in top
    ]
    if analysis.get("note"):
        out["note"] = analysis["note"]
    elif not counts.get("identities"):
        out["note"] = "No identities have been collected for this account yet."
    return out


CERT_WINDOW_DAYS = 30


async def _certificates_section(db: AsyncSession, out: Dict[str, Any], account_id: uuid.UUID) -> None:
    from app.services.credential_service import CredentialService

    try:
        view = await CredentialService(db).estate_view(account_ids=[account_id],
                                                       within_days=CERT_WINDOW_DAYS)
    except Exception as exc:  # noqa: BLE001
        out["sections"]["certificates"] = [_unavailable_row("Certificates", "The credential inventory", exc)]
        out["coverage"]["certificates"] = _coverage(0, 0, [], error=str(exc))
        return
    rows = []
    for o in view.get("objects") or []:
        rows.append({
            "resource_name": o.get("name"), "resource_type": o.get("kind"),
            "title": o.get("status") or o.get("bucket"), "status": o.get("bucket"),
            "expires_at": o.get("expires_at"), "days_left": o.get("days_left"),
            "detail": " | ".join(str(x) for x in (o.get("container_name"), o.get("subject")) if x) or None,
            "in_use": o.get("in_use"), "store": o.get("source_label"),
        })
    out["sections"]["certificates"] = rows
    summary = view.get("summary") or {}
    failing = summary.get("sources_failing") or 0
    out["coverage"]["certificates"] = {
        "status": "ok", "error": None, "resources_checked": summary.get("sources_total"),
        "resources_with_data": summary.get("sources_ok"), "resources_without_data": failing,
        "without": [], "unit": "stores",
    }
    out["notes"].append(
        f"Certificates, secrets and keys listed are expired or expire within {CERT_WINDOW_DAYS} days "
        f"of generation -- measured from today, not from the reporting period.")
    if failing:
        out["freshness"]["warnings"].append(
            f"{failing} credential store(s) could not be read, so certificates or secrets in them "
            f"are missing from this report -- an empty list is not an all-clear.")
    if view.get("truncated"):
        out["notes"].append("The credential list was cut at the inventory's own 2,000-row limit.")


async def _changes_section(db: AsyncSession, out: Dict[str, Any], account_id: uuid.UUID,
                           resources, scope_mode: str, window: Tuple[datetime, datetime]) -> None:
    from app.models.drift import CloudResourceChange

    start, end = window
    try:
        changes = (await db.execute(
            select(CloudResourceChange).where(
                CloudResourceChange.account_id == account_id,
                CloudResourceChange.detected_at >= start,
                CloudResourceChange.detected_at < end,
            ).order_by(CloudResourceChange.detected_at.desc())
        )).scalars().all()
    except Exception as exc:  # noqa: BLE001
        out["sections"]["changes"] = [_unavailable_row("Configuration change", "Config drift", exc)]
        out["coverage"]["changes"] = _coverage(len(resources), 0, [], error=str(exc))
        return
    if scope_mode != SCOPE_ACCOUNT:
        # A deleted resource is not in the scoped inventory any more, so a
        # scoped report cannot claim its deletion; the whole-account one does.
        keys = {(r.provider_resource_id or "").lower() for r in resources}
        changes = [c for c in changes if (c.provider_resource_id or "").lower() in keys]
    rows = []
    for c in changes:
        moved = (f"{c.old_value if c.old_value not in (None, '') else '-'} -> "
                 f"{c.new_value if c.new_value not in (None, '') else '-'}") if c.field_path else None
        rows.append({
            "resource_name": c.resource_name or c.provider_resource_id, "resource_type": c.resource_type,
            "region": c.region_or_zone, "provider_resource_id": c.provider_resource_id,
            "title": f"{c.change_type.title()}{f': {c.field_path}' if c.field_path else ''}",
            "severity": c.severity, "detail": c.summary, "metric_value": moved,
            "status": c.direction, "detected_at": ras._iso(c.detected_at),
            "change_type": c.change_type,
        })
    out["sections"]["changes"] = rows
    by_type: Dict[str, int] = {}
    by_sev: Dict[str, int] = {}
    for r in rows:
        by_type[r["change_type"]] = by_type.get(r["change_type"], 0) + 1
        by_sev[r["severity"]] = by_sev.get(r["severity"], 0) + 1
    out["coverage"]["changes"] = {
        "status": "ok", "error": None, "resources_checked": len(resources),
        "resources_with_data": len({r["provider_resource_id"] for r in rows}),
        "resources_without_data": None, "without": [],
        "by_change_type": by_type,
        "by_severity": dict(sorted(by_sev.items(), key=lambda kv: SEVERITY_RANK.get(kv[0], 9))),
    }


async def _activity_section(db: AsyncSession, account_id: uuid.UUID,
                            window: Tuple[datetime, datetime]) -> Dict[str, Any]:
    from app.services.event_service import EventService

    start, end = window
    try:
        st = await EventService(db).stats(account_id=str(account_id),
                                          start=start.isoformat(), end=end.isoformat())
    except Exception as exc:  # noqa: BLE001
        return {"status": "unavailable", "error": f"The Event Log could not be read: {exc}"}
    keys = ("total_events", "successful_events", "failed_events", "denied_events",
            "administrative_changes", "delete_operations", "critical_events", "high_risk_events",
            "distinct_actors", "distinct_resources", "earliest_event", "latest_event")
    by_category = sorted((st.get("by_category") or {}).items(), key=lambda kv: -kv[1])[:8]
    sources = st.get("sources") or {}
    out = {
        "status": "ok" if st.get("total_events") else "no_data",
        "basis": "Audit events collected from the provider for the whole account within the reporting period.",
        **{k: st.get(k) for k in keys},
        "by_risk": st.get("by_risk"),
        "top_categories": [{"category": k, "events": v} for k, v in by_category],
        "top_actors": [{"actor": a.get("actor_name"), "type": a.get("actor_type"), "events": a.get("events"),
                        "high_risk": a.get("high_risk"), "failed": a.get("failed")}
                       for a in (st.get("top_actors") or [])[:8]],
    }
    if isinstance(sources, dict) and sources.get("degraded"):
        out["note"] = ("Event collection is degraded for at least one source, so this activity "
                       "summary may be missing events.")
    elif not st.get("total_events"):
        out["note"] = ("No audit events are stored for this period -- either nothing happened or "
                       "events were not collected; check the Event Log's collection health.")
    return out


# ── The dataset ──────────────────────────────────────────────────────────────

async def build_report_dataset(
    db: AsyncSession,
    account_id: uuid.UUID,
    resource_ids: List[uuid.UUID],
    sections: ReportSections,
    date_range: ReportDateRange,
    *,
    scope_mode: str = SCOPE_RESOURCES,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """The single normalized dataset every renderer (CSV/JSON/PDF/XLSX)
    consumes. Only queries what `sections` actually asks for."""
    now = now or datetime.now(timezone.utc)
    account = await CloudAccountRepository(db).get_by_id(account_id)
    account_name = account.account_name if account else str(account_id)
    provider = account.provider if account else "Unknown"
    period = date_range.resolve(now)

    resources = await _load_resources(db, account_id, resource_ids)
    found_ids = {r.id for r in resources}
    missing_ids = [rid for rid in resource_ids if rid not in found_ids]
    bases = {r.id: ras._base_row(r, account_name, provider) for r in resources}

    out: Dict[str, Any] = {
        "schema_version": 2,
        "account": {"id": str(account_id), "name": account_name, "provider": provider},
        "scope": {"mode": scope_mode},
        "period": date_range.describe(now),
        "resources_requested": len(resource_ids),
        "resources_resolved": len(resources),
        "resources_missing": [str(i) for i in missing_ids],
        "sections": {},
        "coverage": {},
        "notes": [],
    }
    out["freshness"] = await _freshness(db, account_id, now)

    if sections.inventory or sections.security or sections.cost \
            or sections.utilization or sections.performance or sections.recommendations:
        out["notes"].append(_INVENTORY_NOTE)

    if sections.inventory:
        out["sections"]["inventory"] = [_inventory_row(r) for r in resources]

    if sections.security:
        await _security_section(db, out, account_id, account_name, provider,
                                resources, bases, scope_mode)

    if sections.utilization or sections.performance or sections.recommendations:
        await _optimization_sections(db, out, account_id, resources, bases, sections)

    if sections.cost:
        await _cost_section(db, out, account_id, provider, resources, bases, period, scope_mode)

    if sections.anomalies:
        out["sections"]["anomalies"] = await ras._account_anomaly_rows(db, account_id, period)

    window = _period_bounds_utc(period, date_range.timezone)
    if sections.executive_summary or sections.posture:
        out["posture_score"] = await _posture_score(db, account_id)
    if sections.posture:
        out["sections"]["posture"] = await _posture_section(db, account_id, out["posture_score"])
    if sections.identity:
        out["sections"]["identity"] = await _identity_section(db, account_id)
    if sections.certificates:
        await _certificates_section(db, out, account_id)
    if sections.changes:
        await _changes_section(db, out, account_id, resources, scope_mode, window)
    if sections.activity:
        out["sections"]["activity"] = await _activity_section(db, account_id, window)

    if sections.executive_summary:
        out["sections"]["executive_summary"] = _executive_summary(out)
    if sections.data_quality:
        out["sections"]["data_quality"] = _data_quality(out, missing_ids)

    return out


async def _security_section(db, out, account_id, account_name, provider,
                            resources, bases, scope_mode) -> None:
    try:
        findings = (await db.execute(
            select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id,
                CloudSecurityFinding.status.in_(OPEN_SECURITY_STATUSES))
        )).scalars().all()
        inventory_keys, inventory_ids = await _inventory(db, account_id)
    except Exception as exc:  # noqa: BLE001
        out["sections"]["security"] = [_unavailable_row(ras.CATEGORY_SECURITY, "Security findings", exc)]
        out["coverage"]["security"] = _coverage(len(resources), 0, [], error=str(exc))
        return

    # Case-insensitive: Azure returns the same ARM id in different case from
    # different APIs, and an exact match dropped 3 live TOR findings.
    by_key = {(r.provider_resource_id or "").lower(): r for r in resources if r.provider_resource_id}
    by_id = {r.id: r for r in resources}
    rows: List[Dict[str, Any]] = []
    with_findings: set = set()
    account_level = 0
    for f in findings:
        key = (f.resource_key or "").lower()
        resource = by_id.get(f.resource_id) or (by_key.get(key) if key else None)
        if resource is not None:
            with_findings.add(resource.id)
            rows.append({**ras.security_finding_row(bases[resource.id], f),
                         "attribution": ATTRIBUTION_RESOURCE})
        elif (not key or key not in inventory_keys) and f.resource_id not in inventory_ids:
            account_level += 1
            if scope_mode == SCOPE_ACCOUNT:
                rows.append({**ras.security_finding_row(
                    _account_level_base(account_name, provider, f), f)})
        # else: a finding on an inventoried resource outside this scope.

    out["sections"]["security"] = rows
    cov = _coverage(len(resources), len(with_findings), [
        _missing_entry(r, "No open security findings.") for r in resources if r.id not in with_findings
    ])
    cov["account_level_findings"] = account_level
    cov["account_level_included"] = scope_mode == SCOPE_ACCOUNT
    out["coverage"]["security"] = cov
    if account_level and scope_mode != SCOPE_ACCOUNT:
        out["notes"].append(
            f"{account_level} open account-level security finding(s) -- e.g. subscription- or "
            f"tenancy-wide access grants -- are not tied to any one resource, so this scoped "
            f"report leaves them out. A whole-account report includes them.")


def savings_summary(findings: Sequence[Any]) -> Dict[str, Any]:
    """Potential monthly savings, the Intelligence tab's rule: summed per
    currency, never across currencies, and a finding with no quantified
    saving is counted as unpriced -- never added in as 0."""
    by_currency: Dict[str, float] = {}
    priced = unpriced = 0
    for f in findings:
        if f.estimated_savings is None:
            unpriced += 1
            continue
        priced += 1
        code = f.savings_currency or "?"
        by_currency[code] = by_currency.get(code, 0.0) + float(f.estimated_savings)
    return {"monthly_by_currency": {c: round(v, 2) for c, v in sorted(by_currency.items())},
            "priced_findings": priced, "unpriced_findings": unpriced}


async def _optimization_sections(db, out, account_id, resources, bases, sections) -> None:
    ids = [r.id for r in resources]
    opt_error = tel_error = None
    findings: List[Any] = []
    metrics: Dict[uuid.UUID, List[Dict[str, Any]]] = {}
    if ids:
        try:
            findings = (await db.execute(
                select(CloudOptimizationFinding).where(
                    CloudOptimizationFinding.account_id == account_id,
                    CloudOptimizationFinding.resource_id.in_(ids),
                    CloudOptimizationFinding.status.in_(list(ACTIVE_STATUSES)))
            )).scalars().all()
        except Exception as exc:  # noqa: BLE001
            opt_error = exc
        if sections.utilization:
            try:
                for t in (await db.execute(
                    select(CloudResourceTelemetry).where(CloudResourceTelemetry.resource_id.in_(ids))
                )).scalars().all():
                    metrics.setdefault(t.resource_id, []).append(t.to_dict())
            except Exception as exc:  # noqa: BLE001
                tel_error = exc

    by_cat: Dict[str, Dict[uuid.UUID, List[Any]]] = {
        ras.CATEGORY_UTILIZATION: {}, ras.CATEGORY_PERFORMANCE: {}, ras.CATEGORY_OTHER_OPT: {},
    }
    for f in findings:
        by_cat[ras.optimization_category(f)].setdefault(f.resource_id, []).append(f)
    if not opt_error:
        out["savings"] = savings_summary(findings)

    def finding_rows(cat):
        rows = []
        for r in resources:
            for f in by_cat[cat].get(r.id, []):
                rows.append(ras.optimization_finding_row(bases[r.id], cat, f))
        return rows

    if sections.utilization:
        if opt_error or tel_error:
            exc = opt_error or tel_error
            what = "Resource Intelligence findings" if opt_error else "Telemetry"
            out["sections"]["utilization"] = [_unavailable_row(ras.CATEGORY_UTILIZATION, what, exc)]
            out["coverage"]["utilization"] = _coverage(len(resources), 0, [], error=f"{what}: {exc}")
        else:
            rows = finding_rows(ras.CATEGORY_UTILIZATION)
            for r in resources:
                rows.extend(ras.telemetry_metric_row(bases[r.id], m) for m in metrics.get(r.id, []))
            covered = {r.id for r in resources
                       if metrics.get(r.id) or by_cat[ras.CATEGORY_UTILIZATION].get(r.id)}
            out["sections"]["utilization"] = rows
            out["coverage"]["utilization"] = _coverage(len(resources), len(covered), [
                _missing_entry(r, "No utilization telemetry collected for this resource.")
                for r in resources if r.id not in covered])
            out["notes"].append(_UTILIZATION_NOTE)

    for flag, section, cat, reason in (
        (sections.performance, "performance", ras.CATEGORY_PERFORMANCE,
         "No open performance finding."),
        (sections.recommendations, "recommendations", ras.CATEGORY_OTHER_OPT,
         "No open recommendation."),
    ):
        if not flag:
            continue
        if opt_error:
            out["sections"][section] = [_unavailable_row(cat, "Resource Intelligence findings", opt_error)]
            out["coverage"][section] = _coverage(len(resources), 0, [], error=str(opt_error))
            continue
        out["sections"][section] = finding_rows(cat)
        covered = set(by_cat[cat])
        out["coverage"][section] = _coverage(
            len(resources), len(covered & {r.id for r in resources}),
            [_missing_entry(r, reason) for r in resources if r.id not in covered])


async def _cost_section(db, out, account_id, provider, resources, bases, period, scope_mode) -> None:
    capability = caps.for_provider(provider)
    supported = capability.can(caps.RESOURCE_COST)
    ids = [r.id for r in resources]
    try:
        costs = {c.resource_id: c for c in (await db.execute(
            select(CloudResourceCost).where(CloudResourceCost.resource_id.in_(ids))
        )).scalars().all()} if ids and supported else {}
    except Exception as exc:  # noqa: BLE001
        out["sections"]["cost"] = [_unavailable_row("Cost", "Per-resource billed cost", exc)]
        out["coverage"]["cost"] = _coverage(len(resources), 0, [], error=str(exc))
        costs = None

    if costs is not None:
        out["sections"]["cost"] = [_cost_row(bases[r.id], costs[r.id]) for r in resources if r.id in costs]
        if supported:
            reason = ("Not in the provider's latest per-resource billing -- unbilled or not "
                      "attributable to this resource. Unknown, not zero.")
        else:
            reason = capability.reason(caps.RESOURCE_COST) or "Per-resource cost is not available for this provider."
        out["coverage"]["cost"] = _coverage(len(resources), len(costs), [
            _missing_entry(r, reason) for r in resources if r.id not in costs])
        windows = sorted({c.period_days for c in costs.values()})
        if windows:
            out["notes"].append(
                "Per-resource cost is the latest billed amount over the last "
                + "/".join(str(w) for w in windows)
                + " days as reported by the provider -- it does not follow the reporting period.")
        elif not supported:
            out["notes"].append(reason)

    out["sections"]["cost_summary"] = await _cost_summary(
        db, account_id, period, scope_mode, out["freshness"])


TOP_N = 5


def _top_risks(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The most severe open findings, one per (title, severity): a rule that
    fires on 40 security lists is one risk to fix, not five slots of the
    top five. Ties go to the rule affecting the most resources."""
    grouped: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        sev = r.get("severity")
        if not sev or r.get("title") == "Unavailable":
            continue
        g = grouped.setdefault((r.get("title"), sev), {
            "title": r.get("title"), "severity": sev, "resources": 0,
            "example_resource": r.get("resource_name"), "remediation": r.get("remediation"),
        })
        g["resources"] += 1
    ranked = sorted(grouped.values(),
                    key=lambda g: (SEVERITY_RANK.get(g["severity"], 9), -g["resources"], g["title"] or ""))
    return ranked[:TOP_N]


def _executive_summary(dataset: Dict[str, Any]) -> Dict[str, Any]:
    secs = dataset["sections"]
    by_severity: Dict[str, int] = {}
    account_level = 0
    for row in secs.get("security", []):
        sev = row.get("severity")
        if sev and row.get("title") != "Unavailable":
            by_severity[sev] = by_severity.get(sev, 0) + 1
            if row.get("attribution") == ATTRIBUTION_ACCOUNT:
                account_level += 1
    summary: Dict[str, Any] = {
        "resources_in_scope": dataset["resources_resolved"],
        "reporting_period": f"{dataset['period']['start']} to {dataset['period']['end']}",
        "security_findings_by_severity": dict(sorted(
            by_severity.items(), key=lambda kv: SEVERITY_RANK.get(kv[0], 9))),
        "critical_or_high": by_severity.get("CRITICAL", 0) + by_severity.get("HIGH", 0),
    }
    if "security" in secs:
        summary["account_level_findings"] = account_level
    for name in ("performance", "recommendations"):
        if name in secs:
            summary[f"{name}_findings"] = sum(1 for r in secs[name] if r.get("title") != "Unavailable")
    if "cost" in secs:
        billed: Dict[str, float] = {}
        for row in secs["cost"]:
            if row.get("cost_amount") is not None:
                billed[row.get("currency") or "?"] = billed.get(row.get("currency") or "?", 0.0) + row["cost_amount"]
        summary["billed_cost_of_resources_in_scope"] = {c: round(v, 2) for c, v in sorted(billed.items())}
        cov = dataset["coverage"].get("cost") or {}
        summary["resources_with_billed_cost"] = cov.get("resources_with_data")
        spend = (secs.get("cost_summary") or {}).get("spend_by_currency") or {}
        summary["account_spend_in_period"] = {c: v["amount"] for c, v in spend.items()}
    if "anomalies" in secs:
        summary["spend_anomalies_in_period"] = sum(
            1 for r in secs["anomalies"] if str(r.get("title", "")).startswith("Spend anomaly"))
    posture = dataset.get("posture_score")
    if posture:
        summary["posture"] = {k: posture.get(k) for k in ("status", "score", "grade", "reliable",
                                                          "coverage_pct", "assessed_at", "note")}
    if "savings" in dataset:
        summary["potential_monthly_savings"] = dataset["savings"]["monthly_by_currency"]
        summary["savings_unpriced_findings"] = dataset["savings"]["unpriced_findings"]
    if (secs.get("cost_summary") or {}).get("change"):
        summary["spend_change"] = secs["cost_summary"]["change"]
    if "certificates" in secs:
        rows = [r for r in secs["certificates"] if r.get("title") != "Unavailable"]
        summary["credentials_expired"] = sum(1 for r in rows if (r.get("days_left") or 0) < 0)
        summary["credentials_expiring_30_days"] = sum(1 for r in rows if (r.get("days_left") or 0) >= 0)
    if "changes" in secs:
        cov = dataset["coverage"].get("changes") or {}
        summary["config_changes_in_period"] = len(secs["changes"])
        summary["config_changes_by_severity"] = cov.get("by_severity")
    if isinstance(secs.get("activity"), dict) and secs["activity"].get("status") != "unavailable":
        summary["audit_events_in_period"] = secs["activity"].get("total_events")
        summary["high_risk_events_in_period"] = secs["activity"].get("high_risk_events")
    if secs.get("security"):
        summary["top_risks"] = _top_risks(secs["security"])
    if secs.get("cost"):
        priced = [r for r in secs["cost"] if r.get("cost_amount") is not None]
        priced.sort(key=lambda r: r["cost_amount"], reverse=True)
        summary["top_cost_resources"] = [
            {"resource_name": r.get("resource_name"), "resource_type": r.get("resource_type"),
             "amount": round(r["cost_amount"], 2), "currency": r.get("currency"),
             "period_days": r.get("cost_period_days")}
            for r in priced[:TOP_N]
        ]
    summary["sections_included"] = [k for k in (*ROW_SECTIONS, *SUMMARY_SECTIONS)
                                    if k in secs and k not in ("executive_summary", "data_quality")]
    return summary


def _data_quality(dataset: Dict[str, Any], missing_ids: List[uuid.UUID]) -> Dict[str, Any]:
    coverage = {
        SECTION_LABELS.get(name, name): {k: v for k, v in cov.items() if k != "without"}
        for name, cov in dataset["coverage"].items()
    }
    unavailable = [SECTION_LABELS.get(n, n) for n, c in dataset["coverage"].items()
                   if c.get("status") == "unavailable"]
    for name in ("anomalies",):
        rows = dataset["sections"].get(name) or []
        if any(r.get("title") == "Unavailable" for r in rows):
            unavailable.append(SECTION_LABELS[name])
    for name in ("cost_summary", "identity", "activity"):
        if (dataset["sections"].get(name) or {}).get("status") == "unavailable":
            unavailable.append(SECTION_LABELS[name])
    posture = dataset["sections"].get("posture") or {}
    if posture.get("frameworks_status") == "unavailable" \
            or (posture.get("score") or {}).get("status") == "unavailable":
        unavailable.append(SECTION_LABELS["posture"])
    return {
        "coverage": coverage,
        "unavailable_sections": unavailable,
        "resources_not_found": len(missing_ids),
        "freshness": {k: v for k, v in dataset.get("freshness", {}).items() if k != "warnings"},
        "warnings": list(dataset.get("freshness", {}).get("warnings", [])),
        "notes": list(dataset.get("notes", [])),
    }


# ── Layout: ordering, grouping, detail level ─────────────────────────────────

_DEFAULT_SORT = {
    "inventory": "resource_name", "security": "severity", "utilization": "resource_name",
    "performance": "severity", "recommendations": "severity", "cost": "cost",
    "anomalies": "detected_at", "certificates": "days_left", "changes": "detected_at",
}
_SORT_FIELD = {"severity": "severity", "resource_name": "resource_name",
               "cost": "cost_amount", "detected_at": "detected_at"}


def _by_name(r: Dict[str, Any]):
    return (str(r.get("resource_name") or "").lower(), str(r.get("provider_resource_id") or ""))


def _sort(rows: List[Dict[str, Any]], sort_by: str) -> None:
    """Python's sort is stable, also with reverse=True, so sorting by name
    first leaves ties in the primary key in name order."""
    rows.sort(key=_by_name)
    if sort_by == "severity":
        rows.sort(key=lambda r: SEVERITY_RANK.get(r.get("severity") or "", 9))
    elif sort_by == "cost":
        # Highest first. A row with no amount goes last -- never sorted as zero.
        rows.sort(key=lambda r: (r.get("cost_amount") is not None, r.get("cost_amount") or 0.0),
                  reverse=True)
    elif sort_by == "detected_at":
        # Newest first; ISO 8601 strings sort chronologically, undated ("") last.
        rows.sort(key=lambda r: str(r.get("detected_at") or ""), reverse=True)
    elif sort_by == "days_left":
        # Soonest (most expired) first; no expiry date last.
        rows.sort(key=lambda r: (r.get("days_left") is None, r.get("days_left") or 0.0))


def group_value(row: Dict[str, Any], group_by: Optional[str]) -> Optional[str]:
    if not group_by:
        return None
    value = row.get(group_by)
    return str(value) if value not in (None, "") else None


def _group_rank(group_by: str):
    if group_by == "severity":
        return lambda v: (SEVERITY_RANK.get(v or "", 9), v or "")
    return lambda v: (v is None, (v or "").lower())


def order_rows(dataset: Dict[str, Any], group_by: Optional[str], sort_by: Optional[str]) -> None:
    """Sort every row section in place: by group first (when grouping), then
    by `sort_by`, or by the section's natural order when `sort_by` is unset or
    names a field the section does not have (inventory has no severity)."""
    for name in ROW_SECTIONS:
        rows = dataset["sections"].get(name)
        if not isinstance(rows, list) or not rows:
            continue
        field = _SORT_FIELD.get(sort_by or "")
        chosen = sort_by if field and any(field in r for r in rows) else _DEFAULT_SORT[name]
        _sort(rows, chosen)
        if group_by and any(group_by in r for r in rows):
            rank = _group_rank(group_by)
            rows.sort(key=lambda r: rank(group_value(r, group_by)))  # stable: keeps the sort within a group
    dataset["layout"] = {**dataset.get("layout", {}), "group_by": group_by, "sort_by": sort_by}


def apply_detail_level(dataset: Dict[str, Any], level: str) -> None:
    """What each level contains, in every format alike.

    executive -- summaries only: executive summary, account spend, data
                 quality. No per-resource rows.
    standard  -- plus every finding, measurement and billed-cost row.
                 Resources with nothing to report are counted, not listed.
    detailed  -- plus, per section, each resource with nothing to report and
                 why (no open findings, telemetry not collected, not billed).
    """
    if level == DETAIL_EXECUTIVE:
        for name in ROW_SECTIONS:
            dataset["sections"].pop(name, None)
    if level != DETAIL_DETAILED:
        for cov in dataset.get("coverage", {}).values():
            cov["without"] = []
    dataset["layout"] = {**dataset.get("layout", {}), "detail_level": level}
