"""Analytics over persisted billing history: forecast, anomalies, change
analysis, month-over-month and the spend calendar.

Everything here reads `cloud_cost_facts`. Nothing calls a provider.

Three rules govern every function in this module, and they are why most of it
is arithmetic rather than modelling:

1.  **Per currency, always.** A forecast, a baseline, a percentage change --
    none of them mean anything across USD and INR. Every calculation here is
    performed within one currency and returned keyed by currency. There is no
    code path that adds two currencies together.

2.  **Insufficient data returns NA, not a number.** A run-rate projected from
    four days is a confident straight line drawn through noise. Each function
    states its own minimum and refuses below it, with the reason attached.

3.  **Correlation is never labelled cause.** Change analysis reports which
    services moved and by how much. It does not claim one caused another,
    because nothing in billing data can establish that.
"""
from __future__ import annotations

import logging
import statistics
from calendar import monthrange
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

logger = logging.getLogger("cloud_svc.cost.analytics")

# ── Minimum history each analysis needs before it will answer ────────────────
# Stated as constants rather than buried in conditionals so the API can report
# exactly what is missing and how much more is needed.
MIN_DAYS_TREND = 2
MIN_DAYS_FORECAST = 14
MIN_DAYS_ANOMALY = 30
MIN_DAYS_MOM = 60

# Anomaly defaults. BOTH must be exceeded: a percentage alone fires on
# Rs.1 -> Rs.2 (a 100% rise that matters to nobody), and an absolute alone
# fires on normal variance in a large account.
DEFAULT_PERCENT_THRESHOLD = 20.0
DEFAULT_MIN_ABSOLUTE = 1.0
# Standard deviations above the mean before a day is called anomalous on
# distribution grounds. 2 sigma is ~5% of days in a normal distribution;
# spend is not normally distributed, so this is a heuristic and is labelled as
# one in the output rather than presented as statistical significance.
DEFAULT_SIGMA = 2.0


def _by_currency(series: Sequence[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Split a daily series into one series per currency, each date-sorted.

    The entry point for rule 1: every analysis below operates on the output of
    this function, so there is no way to accidentally mix currencies.
    """
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for point in series:
        currency = point.get("currency") or "UNKNOWN"
        buckets.setdefault(currency, []).append(point)
    for rows in buckets.values():
        rows.sort(key=lambda r: r["date"])
    return buckets


def _amounts(series: Iterable[Dict[str, Any]]) -> List[float]:
    """Real amounts only. A None is unknown, not zero, and must not drag a
    mean or a run rate downwards."""
    return [float(p["amount"]) for p in series if p.get("amount") is not None]


def _insufficient(reason: str, have: int, need: int) -> Dict[str, Any]:
    return {
        "available": False,
        "value": None,          # NA. Never 0.
        "reason": reason,
        "days_available": have,
        "days_required": need,
    }


# ── Forecast ──────────────────────────────────────────────────────────────────

def forecast(
    series: Sequence[Dict[str, Any]],
    *,
    today: Optional[date] = None,
    horizons: Sequence[int] = (7, 30, 90),
) -> Dict[str, Any]:
    """Run-rate projection per currency.

    Deliberately NOT a model. The method is: take the mean of observed daily
    spend over the trailing window, multiply by the number of days ahead. It is
    labelled `run_rate_projection` everywhere it surfaces, because calling a
    multiplication an AI prediction would be a lie about the product.

    Month-to-date projection is handled separately from the rolling horizons:
    projecting the calendar month needs the days REMAINING in that month, not
    a fixed horizon, and conflating the two is how a month-end figure ends up
    covering 30 days from today instead of the days left.
    """
    today = today or date.today()
    out: Dict[str, Any] = {"method": "run_rate_projection", "by_currency": {}}

    for currency, points in _by_currency(series).items():
        amounts = _amounts(points)
        days = len(amounts)

        if days < MIN_DAYS_FORECAST:
            out["by_currency"][currency] = _insufficient(
                f"A run-rate projection needs at least {MIN_DAYS_FORECAST} days of "
                f"billing history; only {days} day(s) are stored. Run a backfill to "
                "extend the history.",
                days, MIN_DAYS_FORECAST,
            )
            continue

        daily_average = sum(amounts) / days
        # Volatility drives confidence: a steady spend projects well, a spiky
        # one does not, and the caller deserves to know which it is looking at.
        stdev = statistics.pstdev(amounts) if days > 1 else 0.0
        variation = (stdev / daily_average) if daily_average else 0.0

        if variation < 0.15:
            confidence, basis = "high", "Daily spend is steady (variation under 15%)."
        elif variation < 0.40:
            confidence, basis = "medium", "Daily spend varies moderately (15-40%)."
        else:
            confidence, basis = "low", (
                "Daily spend is highly variable (over 40% variation), so a flat "
                "run rate is a weak predictor."
            )

        days_in_month = monthrange(today.year, today.month)[1]
        days_remaining = days_in_month - today.day
        mtd = sum(
            float(p["amount"]) for p in points
            if p.get("amount") is not None
            and date.fromisoformat(p["date"]).year == today.year
            and date.fromisoformat(p["date"]).month == today.month
        )

        out["by_currency"][currency] = {
            "available": True,
            "currency": currency,
            "daily_average": round(daily_average, 4),
            "observed_days": days,
            "volatility": round(variation, 4),
            "confidence": confidence,
            "basis": f"Mean of {days} observed days. {basis}",
            "horizons": {
                f"next_{h}_days": round(daily_average * h, 2) for h in horizons
            },
            "current_month": {
                # Actual and projected are separate keys on purpose: presenting
                # their sum alone would blur measured spend into an estimate.
                "month_to_date_actual": round(mtd, 2),
                "days_elapsed": today.day,
                "days_remaining": days_remaining,
                "projected_remainder": round(daily_average * days_remaining, 2),
                "projected_total": round(mtd + daily_average * days_remaining, 2),
                "label": "Run-rate projection, not a measured total.",
            },
        }

    if not out["by_currency"]:
        out["available"] = False
        out["reason"] = "No billing history is stored for this scope."
    else:
        out["available"] = any(
            v.get("available") for v in out["by_currency"].values()
        )
    return out


# ── Anomalies ─────────────────────────────────────────────────────────────────

def detect_anomalies(
    series: Sequence[Dict[str, Any]],
    *,
    percent_threshold: float = DEFAULT_PERCENT_THRESHOLD,
    min_absolute: float = DEFAULT_MIN_ABSOLUTE,
    sigma: float = DEFAULT_SIGMA,
    baseline_days: int = 14,
) -> Dict[str, Any]:
    """Days whose spend departs from the preceding baseline, per currency.

    A day must clear BOTH a relative and an absolute bar. Either alone produces
    noise: percentage alone fires on 1 -> 2, absolute alone fires on ordinary
    variance in a large account.

    The baseline is the trailing `baseline_days` BEFORE the day under test --
    never a window that includes the day itself, which would let a large spike
    raise its own baseline and hide.
    """
    out: Dict[str, Any] = {
        "method": "trailing_baseline_deviation",
        "thresholds": {
            "percent": percent_threshold,
            "min_absolute": min_absolute,
            "sigma": sigma,
            "baseline_days": baseline_days,
        },
        "by_currency": {},
    }

    for currency, points in _by_currency(series).items():
        dated = [p for p in points if p.get("amount") is not None]
        if len(dated) < MIN_DAYS_ANOMALY:
            out["by_currency"][currency] = _insufficient(
                f"Anomaly detection needs at least {MIN_DAYS_ANOMALY} days of history "
                f"to establish a baseline; only {len(dated)} day(s) are stored.",
                len(dated), MIN_DAYS_ANOMALY,
            )
            continue

        found: List[Dict[str, Any]] = []
        for index in range(baseline_days, len(dated)):
            window = [float(p["amount"]) for p in dated[index - baseline_days:index]]
            if not window:
                continue
            baseline = sum(window) / len(window)
            stdev = statistics.pstdev(window) if len(window) > 1 else 0.0
            actual = float(dated[index]["amount"])
            delta = actual - baseline

            if delta <= 0:
                continue  # Only increases are anomalies worth paging on.
            percent = (delta / baseline * 100.0) if baseline else None
            if percent is None or percent < percent_threshold or delta < min_absolute:
                continue

            sigma_distance = (delta / stdev) if stdev else None
            # Severity ladders on how far past the bar it went, so a 25% blip
            # and a 400% runaway do not arrive looking identical.
            if percent >= 200:
                severity = "CRITICAL"
            elif percent >= 100:
                severity = "HIGH"
            elif percent >= 50:
                severity = "MEDIUM"
            else:
                severity = "INFO"

            found.append({
                "date": dated[index]["date"],
                "currency": currency,
                "actual": round(actual, 4),
                "baseline": round(baseline, 4),
                "delta": round(delta, 4),
                "percent_increase": round(percent, 2),
                "sigma": (round(sigma_distance, 2) if sigma_distance is not None else None),
                "beyond_sigma": (
                    sigma_distance is not None and sigma_distance >= sigma
                ),
                "severity": severity,
                "basis": (
                    f"Spend was {round(percent, 1)}% above the mean of the preceding "
                    f"{baseline_days} days ({round(baseline, 2)} {currency})."
                ),
            })

        out["by_currency"][currency] = {
            "available": True,
            "currency": currency,
            "days_analyzed": len(dated) - baseline_days,
            "anomalies": found,
            "count": len(found),
        }

    out["available"] = any(
        v.get("available") for v in out["by_currency"].values()
    )
    out["total"] = sum(
        v.get("count", 0) for v in out["by_currency"].values() if v.get("available")
    )
    return out


# ── Change analysis (waterfall) ───────────────────────────────────────────────

def change_analysis(
    current: Sequence[Dict[str, Any]],
    previous: Sequence[Dict[str, Any]],
    *,
    dimension: str = "service",
    limit: int = 10,
) -> Dict[str, Any]:
    """Which dimensions moved between two periods, and by how much.

    This is the data behind both "why did cost change" and the waterfall chart.

    The wording matters and is enforced here rather than left to the UI: the
    output key is `movements`, and the summary says "associated changes". Two
    services moving in the same window is correlation. Billing data cannot
    establish that one caused the other, so this module never says it did.
    """
    def fold(rows: Sequence[Dict[str, Any]]) -> Dict[Tuple[str, str], float]:
        totals: Dict[Tuple[str, str], float] = {}
        for row in rows:
            if row.get("amount") is None:
                continue
            key = (row.get(dimension) or "Unknown", row.get("currency") or "UNKNOWN")
            totals[key] = totals.get(key, 0.0) + float(row["amount"])
        return totals

    now, before = fold(current), fold(previous)
    by_currency: Dict[str, Dict[str, Any]] = {}

    for key in set(now) | set(before):
        name, currency = key
        after_amount = now.get(key, 0.0)
        before_amount = before.get(key, 0.0)
        delta = after_amount - before_amount
        if abs(delta) < 1e-9:
            continue

        bucket = by_currency.setdefault(currency, {
            "currency": currency, "movements": [],
            "total_before": 0.0, "total_after": 0.0,
        })
        bucket["movements"].append({
            dimension: name,
            "before": round(before_amount, 4),
            "after": round(after_amount, 4),
            "delta": round(delta, 4),
            "percent": (
                round(delta / before_amount * 100.0, 2) if before_amount else None
            ),
            # A dimension absent from the earlier period is new spend, not an
            # infinite percentage increase.
            "kind": (
                "new" if before_amount == 0 else
                "ended" if after_amount == 0 else
                "increase" if delta > 0 else "decrease"
            ),
        })

    for currency, bucket in by_currency.items():
        bucket["total_before"] = round(
            sum(v for (n, c), v in before.items() if c == currency), 4
        )
        bucket["total_after"] = round(
            sum(v for (n, c), v in now.items() if c == currency), 4
        )
        bucket["net_change"] = round(bucket["total_after"] - bucket["total_before"], 4)
        # Largest absolute movers first: a big decrease is as interesting as a
        # big increase when explaining a total.
        bucket["movements"].sort(key=lambda m: -abs(m["delta"]))
        bucket["movements"] = bucket["movements"][:limit]
        bucket["increases"] = [m for m in bucket["movements"] if m["delta"] > 0]
        bucket["decreases"] = [m for m in bucket["movements"] if m["delta"] < 0]

    return {
        "dimension": dimension,
        "by_currency": by_currency,
        "available": bool(by_currency),
        "interpretation": (
            "These are associated cost changes over the same period, ranked by "
            "absolute movement. They are not causes: billing data shows that "
            "figures moved together, not that one produced the other."
        ),
    }


# ── Month over month ──────────────────────────────────────────────────────────

def month_over_month(
    monthly: Sequence[Dict[str, Any]],
    *,
    today: Optional[date] = None,
    forecast_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Calendar-month comparison, keeping actual and projected distinct.

    The current month is incomplete by definition, so comparing it raw against
    a finished month always shows a fake decline. Each entry is therefore
    labelled `partial`, and the current month additionally carries its run-rate
    projection so the comparison can be made against a like-for-like figure --
    clearly marked as a projection, never merged into the actual.
    """
    today = today or date.today()
    current_key = f"{today.year:04d}-{today.month:02d}"
    by_currency: Dict[str, Dict[str, Any]] = {}

    for row in monthly:
        currency = row.get("currency") or "UNKNOWN"
        bucket = by_currency.setdefault(currency, {"currency": currency, "months": []})
        is_current = row["month"] == current_key
        entry = {
            "month": row["month"],
            "amount": row.get("amount"),
            "records": row.get("records"),
            "partial": is_current,
            "settled": row.get("settled", False),
            "provisional_records": row.get("provisional_records", 0),
        }
        if is_current and forecast_result:
            projection = (forecast_result.get("by_currency", {})
                          .get(currency, {}) or {})
            month_block = projection.get("current_month") or {}
            entry["projected_total"] = month_block.get("projected_total")
            entry["projection_label"] = "Run-rate projection"
        bucket["months"].append(entry)

    for bucket in by_currency.values():
        bucket["months"].sort(key=lambda m: m["month"])
        months = bucket["months"]
        if len(months) >= 2:
            latest, prior = months[-1], months[-2]
            # Compare the projection against the prior month when the current
            # one is still running; comparing a half month to a whole one is
            # how a healthy account appears to have halved its spend.
            comparable = (
                latest.get("projected_total")
                if latest.get("partial") and latest.get("projected_total") is not None
                else latest.get("amount")
            )
            if comparable is not None and prior.get("amount"):
                delta = comparable - prior["amount"]
                bucket["change"] = {
                    "from_month": prior["month"],
                    "to_month": latest["month"],
                    "from_amount": prior["amount"],
                    "to_amount": round(comparable, 2),
                    "delta": round(delta, 2),
                    "percent": round(delta / prior["amount"] * 100.0, 2),
                    "to_is_projection": bool(
                        latest.get("partial")
                        and latest.get("projected_total") is not None
                    ),
                }
    return {"by_currency": by_currency, "available": bool(by_currency)}


# ── Spend calendar / heatmap ──────────────────────────────────────────────────

def spend_calendar(
    series: Sequence[Dict[str, Any]],
    *,
    anomalies: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Per-day spend with a 0-1 intensity, for the calendar heatmap.

    Intensity is scaled against the maximum within that currency, so a heatmap
    is never shaded using a value from a different currency. Days with no
    stored fact are omitted rather than emitted as zero -- an absent day is
    missing data, and colouring it as "no spend" would invent a fact.
    """
    anomalous_dates = set()
    if anomalies:
        for bucket in (anomalies.get("by_currency") or {}).values():
            for item in (bucket.get("anomalies") or []):
                anomalous_dates.add((item["date"], item["currency"]))

    out: Dict[str, Any] = {"by_currency": {}}
    for currency, points in _by_currency(series).items():
        amounts = _amounts(points)
        peak = max(amounts) if amounts else 0.0
        days = []
        for point in points:
            amount = point.get("amount")
            days.append({
                "date": point["date"],
                "amount": amount,
                "intensity": (
                    round(float(amount) / peak, 4)
                    if amount is not None and peak > 0 else None
                ),
                "anomalous": (point["date"], currency) in anomalous_dates,
            })
        out["by_currency"][currency] = {
            "currency": currency, "days": days,
            "peak": round(peak, 4) if peak else None,
            "note": "Days with no stored billing fact are omitted, not shown as zero.",
        }
    out["available"] = bool(out["by_currency"])
    return out
