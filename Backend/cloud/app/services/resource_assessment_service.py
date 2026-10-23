"""Resource-wise assessment export: security, utilization, performance and
cost anomalies, combined per resource into one tidy (long-format) table.

Every section here already exists and is already resource-scoped in the
database — this module is the aggregation, not new domain logic:

  Security      -- CloudSecurityFinding, filtered by resource_key
                   (SecurityRepository.list_findings).
  Utilization   -- CloudResourceTelemetry, one row per metric
                   (optimization.collector.load_series).
  Performance   -- CloudOptimizationFinding, the PERFORMANCE/CONSTRAINED slice
                   (OptimizationRepository.for_resource).
  Anomalies     -- there is no resource-scoped anomaly concept in this
                   product. The only "anomaly" detector that exists is
                   account-level daily cost-spend anomaly detection
                   (cost_analytics.detect_anomalies, the same call
                   cost_service.get_resource_context makes). It is included
                   here labelled "Anomaly (Account-Wide)" rather than
                   presented as something specific to the resource, which
                   would be a claim this product cannot back.

One row per (resource, finding/metric/anomaly) rather than one row per
resource: a fixed-width row cannot hold a variable number of findings, and
the point of an export is further analysis, which "tidy" tabular data serves
and a squashed summary count does not. A resource with nothing in a category
still gets one row for it reading "No findings" / "No data" -- never silently
absent, the same NA-vs-missing rule the rest of this product follows.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource
from app.optimization import collector
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.cost_fact_repo import CostFactRepository
from app.repository.optimization_repo import OptimizationRepository
from app.repository.resource_repo import ResourceRepository
from app.repository.security_repo import SecurityRepository
from app.services import cost_analytics

logger = logging.getLogger("cloud_svc.resources.assessment")

# A per-resource fan-out across four data sources is cheap per resource but
# not free at scale; this caps one export request the same way EXPORT_MAX_ROWS
# / MAX_PDF_ROWS cap the other exports in this product.
MAX_RESOURCES_PER_EXPORT = 200

CATEGORY_SECURITY = "Security"
CATEGORY_UTILIZATION = "Utilization"
CATEGORY_PERFORMANCE = "Performance"
CATEGORY_OTHER_OPT = "Other Optimization Finding"
CATEGORY_ANOMALY = "Anomaly (Account-Wide)"

# CloudOptimizationFinding.signal values -- see optimization/model.py's own
# comment ("UNUSED / UNDERUTILIZED / CONSTRAINED / CONFIGURATION / RISK"),
# which does not export these as named constants.
_UTILIZATION_SIGNALS = {"UNUSED", "UNDERUTILIZED"}
_PERFORMANCE_SIGNALS = {"CONSTRAINED"}


class TooManyResourcesError(Exception):
    def __init__(self, requested: int, limit: int = MAX_RESOURCES_PER_EXPORT,
                 what: str = "the assessment export"):
        self.requested = requested
        self.limit = limit
        super().__init__(
            f"{requested} resources were requested; {what} is "
            f"capped at {limit} per request."
        )


def _base_row(resource: CloudResource, account_name: str, provider: str) -> Dict[str, Any]:
    return {
        "account_name": account_name,
        "provider": provider,
        "region": resource.region_or_zone,
        "resource_name": resource.resource_name,
        "resource_type": resource.resource_type,
        "provider_resource_id": resource.provider_resource_id,
    }


async def _security_rows(
    db: AsyncSession, account_id: uuid.UUID, resource: CloudResource,
    base: Dict[str, Any],
) -> List[Dict[str, Any]]:
    try:
        findings, _total = await SecurityRepository(db).list_findings(
            account_ids=[account_id],
            resource_key=resource.provider_resource_id,
            statuses=["OPEN", "IN_PROGRESS"],
            limit=200,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Security findings unavailable for %s: %s", resource.id, exc)
        return [{**base, "assessment_category": CATEGORY_SECURITY, "severity": None,
                 "title": "Unavailable", "detail": f"Security findings could not be read: {exc}",
                 "metric_value": None, "status": None, "detected_at": None}]
    if not findings:
        return [{**base, "assessment_category": CATEGORY_SECURITY, "severity": None,
                 "title": "No findings", "detail": "No open security findings for this resource.",
                 "metric_value": None, "status": None, "detected_at": None}]
    return [security_finding_row(base, f) for f in findings]


def security_finding_row(base: Dict[str, Any], f) -> Dict[str, Any]:
    """One CloudSecurityFinding as an assessment row. Shared with the report
    builder, which loads findings in one batch instead of per resource."""
    return {**base, "assessment_category": CATEGORY_SECURITY, "severity": f.severity,
            "title": f.title, "detail": f.description, "metric_value": None,
            "status": f.status, "detected_at": _iso(f.first_detected_at),
            # The rule's own "how to fix it" text, multi-line -- the same text
            # the Security Center shows under the finding.
            "remediation": getattr(f, "remediation", None)}


def optimization_finding_row(base: Dict[str, Any], category: str, f) -> Dict[str, Any]:
    savings = (f"Est. savings: {f.estimated_savings} {f.savings_currency}"
               if f.estimated_savings is not None else "")
    detail = f.description + (f" {savings}" if savings else "")
    return {**base, "assessment_category": category, "severity": f.severity,
            "title": f.title, "detail": detail,
            "metric_value": f.signal, "status": f.status,
            "detected_at": _iso(f.last_detected_at),
            # Per month. None means "not quantified" and is never summed as 0.
            "estimated_monthly_savings": f.estimated_savings,
            "savings_currency": f.savings_currency if f.estimated_savings is not None else None}


def telemetry_metric_row(base: Dict[str, Any], m: Dict[str, Any]) -> Dict[str, Any]:
    """One CloudResourceTelemetry.to_dict() as an assessment row."""
    stats = m.get("stats") or {}
    stat_text = ", ".join(f"{k}={v}" for k, v in stats.items()) or "no stats"
    return {
        **base, "assessment_category": CATEGORY_UTILIZATION, "severity": None,
        "title": m.get("label") or m.get("metric"),
        "detail": f"{m.get('window_days', '?')}d window, {m.get('unit') or ''} ({stat_text})".strip(),
        "metric_value": stat_text, "status": m.get("status"),
        "detected_at": m.get("collected_at"),
    }


def optimization_category(finding) -> str:
    return _optimization_category(finding)


def _optimization_category(finding) -> str:
    if finding.signal in _UTILIZATION_SIGNALS:
        return CATEGORY_UTILIZATION
    if finding.category == "PERFORMANCE" or finding.signal in _PERFORMANCE_SIGNALS:
        return CATEGORY_PERFORMANCE
    return CATEGORY_OTHER_OPT


async def _optimization_rows(
    db: AsyncSession, account_id: uuid.UUID, resource: CloudResource,
    base: Dict[str, Any],
) -> List[Dict[str, Any]]:
    try:
        findings = await OptimizationRepository(db).for_resource(account_id, resource.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Optimization findings unavailable for %s: %s", resource.id, exc)
        rows = []
        for cat in (CATEGORY_UTILIZATION, CATEGORY_PERFORMANCE):
            rows.append({**base, "assessment_category": cat, "severity": None,
                         "title": "Unavailable",
                         "detail": f"Resource Intelligence findings could not be read: {exc}",
                         "metric_value": None, "status": None, "detected_at": None})
        return rows

    by_category: Dict[str, List[Any]] = {
        CATEGORY_UTILIZATION: [], CATEGORY_PERFORMANCE: [], CATEGORY_OTHER_OPT: [],
    }
    for f in findings:
        by_category[_optimization_category(f)].append(f)

    rows: List[Dict[str, Any]] = []
    for cat in (CATEGORY_UTILIZATION, CATEGORY_PERFORMANCE, CATEGORY_OTHER_OPT):
        items = by_category[cat]
        if not items:
            # "Other Optimization Finding" is a catch-all, not a guaranteed
            # category every resource has an opinion on -- an empty row for
            # it would just be noise on every resource with no COST/STORAGE/
            # NETWORK/DATABASE/RELIABILITY finding, so it is the one category
            # skipped when empty rather than padded.
            if cat != CATEGORY_OTHER_OPT:
                rows.append({**base, "assessment_category": cat, "severity": None,
                             "title": "No findings",
                             "detail": "No open Resource Intelligence finding in this category.",
                             "metric_value": None, "status": None, "detected_at": None})
            continue
        for f in items:
            rows.append(optimization_finding_row(base, cat, f))
    return rows


async def _utilization_telemetry_rows(
    db: AsyncSession, resource: CloudResource, base: Dict[str, Any],
) -> List[Dict[str, Any]]:
    try:
        metrics = await collector.load_series(db, resource.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Telemetry unavailable for %s: %s", resource.id, exc)
        return [{**base, "assessment_category": CATEGORY_UTILIZATION, "severity": None,
                 "title": "Unavailable", "detail": f"Telemetry could not be read: {exc}",
                 "metric_value": None, "status": None, "detected_at": None}]
    if not metrics:
        return [{**base, "assessment_category": CATEGORY_UTILIZATION, "severity": None,
                 "title": "No data", "detail": "No utilization telemetry collected for this resource.",
                 "metric_value": None, "status": None, "detected_at": None}]
    return [telemetry_metric_row(base, m) for m in metrics]


# Anomaly detection compares each day with the 14 days before it, so a window
# is analysed with this much extra history in front of it -- otherwise the
# first two weeks of a short reporting period could never be checked at all.
_ANOMALY_BASELINE_LEAD_DAYS = 14


async def _account_anomaly_rows(
    db: AsyncSession, account_id: uuid.UUID,
    period: Optional[Tuple[date, date]] = None,
) -> List[Dict[str, Any]]:
    """Computed once per account, not per resource -- see module docstring.

    `period` is (first_day, last_day), inclusive. Without it, the last 90
    days -- the original export's fixed window.
    """
    if period is None:
        last_day = date.today()
        first_day = last_day - timedelta(days=90)
    else:
        first_day, last_day = period
    window_text = (f"between {first_day.isoformat()} and {last_day.isoformat()}"
                   if period is not None else "in the last 90 days")
    try:
        series = await CostFactRepository(db).daily_series(
            [account_id], first_day - timedelta(days=_ANOMALY_BASELINE_LEAD_DAYS),
            last_day + timedelta(days=1))
        anomalies = cost_analytics.detect_anomalies(series)
        buckets = anomalies.get("by_currency") or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Cost anomaly detection unavailable for account %s: %s", account_id, exc)
        return [{"assessment_category": CATEGORY_ANOMALY, "severity": None,
                 "title": "Unavailable", "detail": f"Anomaly detection could not run: {exc}",
                 "metric_value": None, "status": None, "detected_at": None}]

    # `detect_anomalies` is explicit that insufficient history is NA, not a
    # checked zero (cost_analytics.py's own rule 2) -- an empty `flagged` list
    # means "no anomalies" ONLY for a currency that actually had enough history
    # to run the detector on. Conflating "never checked" with "checked, clean"
    # is exactly the kind of false all-clear this product's cost module goes
    # out of its way to avoid elsewhere (see cost_money.py).
    if not buckets:
        return [{"assessment_category": CATEGORY_ANOMALY, "severity": None,
                 "title": "Not checked",
                 "detail": "No stored billing history for this account, so anomaly "
                           "detection has not run.",
                 "metric_value": None, "status": None, "detected_at": None}]

    rows: List[Dict[str, Any]] = []
    any_available = False
    for currency, bucket in buckets.items():
        if not bucket.get("available"):
            rows.append({"assessment_category": CATEGORY_ANOMALY, "severity": None,
                         "title": f"Not checked ({currency})",
                         "detail": bucket.get("reason") or "Insufficient billing history.",
                         "metric_value": None, "status": None, "detected_at": None})
            continue
        any_available = True
        for a in bucket.get("anomalies", []):
            # The lead-in days exist only to give the first days of the
            # window a baseline; an anomaly ON one of them is outside the
            # period that was asked about.
            if not (first_day.isoformat() <= str(a["date"])[:10] <= last_day.isoformat()):
                continue
            rows.append({"assessment_category": CATEGORY_ANOMALY, "severity": a["severity"],
                         "title": f"Spend anomaly on {a['date']}", "detail": a["basis"],
                         "metric_value": f"{a['delta']} {a['currency']}", "status": None,
                         "detected_at": a["date"]})

    if any_available and not any(r["title"].startswith("Spend anomaly") for r in rows):
        rows.append({"assessment_category": CATEGORY_ANOMALY, "severity": None,
                     "title": "No anomalies",
                     "detail": f"No account-wide daily spend anomaly {window_text}.",
                     "metric_value": None, "status": None, "detected_at": None})
    return rows


def _iso(value) -> Optional[str]:
    return value.isoformat() if value is not None else None


async def build_assessment_rows(
    db: AsyncSession, account_id: uuid.UUID, resource_ids: List[uuid.UUID],
) -> List[Dict[str, Any]]:
    """One row per (resource, finding/metric/anomaly). See module docstring."""
    if len(resource_ids) > MAX_RESOURCES_PER_EXPORT:
        raise TooManyResourcesError(len(resource_ids))

    account = await CloudAccountRepository(db).get_by_id(account_id)
    account_name = account.account_name if account else str(account_id)
    provider = account.provider if account else "Unknown"

    resource_repo = ResourceRepository(db)
    # Account-wide, so computed once and reused for every resource in the
    # batch rather than re-run per resource.
    anomaly_rows = await _account_anomaly_rows(db, account_id)

    rows: List[Dict[str, Any]] = []
    for resource_id in resource_ids:
        resource = await resource_repo.get_by_id(resource_id)
        if resource is None or resource.account_id != account_id:
            rows.append({
                "account_name": account_name, "provider": provider, "region": None,
                "resource_name": None, "resource_type": None,
                "provider_resource_id": str(resource_id),
                "assessment_category": "Error", "severity": None,
                "title": "Resource not found",
                "detail": "This resource id does not belong to the requested account, "
                          "or no longer exists.",
                "metric_value": None, "status": None, "detected_at": None,
            })
            continue

        base = _base_row(resource, account_name, provider)
        rows.extend(await _security_rows(db, account_id, resource, base))
        rows.extend(await _optimization_rows(db, account_id, resource, base))
        rows.extend(await _utilization_telemetry_rows(db, resource, base))
        rows.extend({**base, **a} for a in anomaly_rows)

    return rows
