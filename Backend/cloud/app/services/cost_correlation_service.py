"""Cost in context: what else happened to a resource around the time its
spend moved.

This module exists to answer "why does this cost what it does" by putting
three existing datasets next to each other — the resource's cost history, the
configuration changes recorded by drift, and its security findings — for one
resource, over one window.

**It never claims causation, and the wording is enforced here rather than left
to the UI.** Every correlated item is returned under `related_observations`,
each carrying an explicit `relationship: "temporal_proximity"` and a
`disclaimer`. Two things happening within a day of each other is a coincidence
worth a human's attention; it is not evidence that one produced the other, and
a cost tool that says "this change caused +40%" will be believed and will
eventually be wrong.

**Cost impact of a configuration change is only stated when it can be
measured.** A resize from t3.medium to m5.4xlarge has an obvious direction, but
this product has no AWS price list integration, so the honest output is the
OBSERVED spend before and after the change — not a computed price delta. Where
there is not enough history on both sides, the impact is NA with the reason.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger("cloud_svc.cost.correlation")

# How close in time two events must be to be worth showing together. A day
# either side of a cost movement: wide enough to catch a change that took
# effect overnight, narrow enough that the list stays about this resource
# rather than about the whole week.
PROXIMITY_DAYS = 1

DISCLAIMER = (
    "These events occurred near this cost movement in time. Temporal proximity "
    "is not causation — nothing here establishes that one produced the other."
)


def _as_date(value: Any) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def observed_impact(
    series: Sequence[Dict[str, Any]],
    change_date: date,
    *,
    window_days: int = 7,
) -> Dict[str, Any]:
    """Observed daily spend before and after a date — measured, not priced.

    Returns NA with a reason when either side has too little data, rather than
    comparing a full week against two days and reporting the difference as an
    impact. That comparison is the single easiest way to manufacture a dramatic
    and meaningless percentage.
    """
    before = [
        float(p["amount"]) for p in series
        if p.get("amount") is not None
        and (d := _as_date(p.get("date"))) is not None
        and change_date - timedelta(days=window_days) <= d < change_date
    ]
    after = [
        float(p["amount"]) for p in series
        if p.get("amount") is not None
        and (d := _as_date(p.get("date"))) is not None
        and change_date <= d < change_date + timedelta(days=window_days)
    ]

    # Both sides need a comparable number of days, or the comparison is between
    # different-sized things.
    minimum = max(2, window_days // 2)
    if len(before) < minimum or len(after) < minimum:
        return {
            "available": False,
            "daily_before": None,
            "daily_after": None,
            "reason": (
                f"Needs at least {minimum} billed days either side of "
                f"{change_date.isoformat()}; found {len(before)} before and "
                f"{len(after)} after."
            ),
        }

    mean_before = sum(before) / len(before)
    mean_after = sum(after) / len(after)
    delta = mean_after - mean_before
    return {
        "available": True,
        "daily_before": round(mean_before, 4),
        "daily_after": round(mean_after, 4),
        "days_before": len(before),
        "days_after": len(after),
        "delta_per_day": round(delta, 4),
        "percent": (round(delta / mean_before * 100, 2) if mean_before else None),
        "basis": (
            f"Mean observed daily spend over the {len(before)} billed days before "
            f"and {len(after)} after {change_date.isoformat()}. This is measured "
            "spend, not a computed price difference."
        ),
    }


def correlate(
    *,
    resource: Any,
    series: Sequence[Dict[str, Any]],
    changes: Sequence[Any] = (),
    findings: Sequence[Any] = (),
    anomalies: Sequence[Dict[str, Any]] = (),
) -> Dict[str, Any]:
    """Put a resource's cost, config changes and security findings side by side.

    Each correlated item names what it is near and how near, and carries the
    disclaimer. Nothing is filtered out for being "uninteresting" — a human
    deciding what matters needs to see what is there.
    """
    anomaly_dates = {
        d for a in anomalies if (d := _as_date(a.get("date"))) is not None
    }

    observations: List[Dict[str, Any]] = []

    for change in changes:
        changed_at = _as_date(getattr(change, "detected_at", None))
        if changed_at is None:
            continue
        near = sorted(
            (abs((changed_at - d).days), d) for d in anomaly_dates
        )
        nearest = near[0] if near and near[0][0] <= PROXIMITY_DAYS else None

        observations.append({
            "kind": "configuration_change",
            "date": changed_at.isoformat(),
            "field": getattr(change, "field_path", None),
            "old_value": getattr(change, "old_value", None),
            "new_value": getattr(change, "new_value", None),
            "summary": getattr(change, "summary", None),
            "impact_pillars": getattr(change, "impact", None),
            "severity": getattr(change, "severity", None),
            # Measured, never priced.
            "observed_cost_impact": observed_impact(series, changed_at),
            "near_cost_anomaly": (
                {"date": nearest[1].isoformat(), "days_apart": nearest[0]}
                if nearest else None
            ),
            "relationship": "temporal_proximity",
            "disclaimer": DISCLAIMER,
        })

    for finding in findings:
        found_at = _as_date(
            getattr(finding, "first_seen_at", None)
            or getattr(finding, "created_at", None)
        )
        observations.append({
            "kind": "security_finding",
            "date": found_at.isoformat() if found_at else None,
            "title": getattr(finding, "title", None),
            "severity": getattr(finding, "severity", None),
            "category": getattr(finding, "category", None),
            "observed_cost_impact": (
                observed_impact(series, found_at) if found_at else
                {"available": False, "reason": "The finding carries no date."}
            ),
            "relationship": "temporal_proximity",
            "disclaimer": DISCLAIMER,
        })

    observations.sort(key=lambda o: (o.get("date") or ""), reverse=True)

    return {
        "resource": {
            "id": str(getattr(resource, "id", "")) or None,
            "provider_resource_id": getattr(resource, "provider_resource_id", None),
            "name": getattr(resource, "resource_name", None),
            "type": getattr(resource, "resource_type", None),
            "region": getattr(resource, "region_or_zone", None),
            "status": getattr(resource, "status", None),
        },
        "cost_series": list(series),
        "anomaly_dates": sorted(d.isoformat() for d in anomaly_dates),
        "related_observations": observations,
        "counts": {
            "configuration_changes": sum(
                1 for o in observations if o["kind"] == "configuration_change"
            ),
            "security_findings": sum(
                1 for o in observations if o["kind"] == "security_finding"
            ),
            "near_an_anomaly": sum(
                1 for o in observations if o.get("near_cost_anomaly")
            ),
        },
        "interpretation": DISCLAIMER,
    }
