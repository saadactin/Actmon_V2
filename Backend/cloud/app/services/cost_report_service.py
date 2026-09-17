"""The report centre: executive summary, CSV assembly and data quality.

Two rules govern everything here.

**A report's total must equal the sum of the rows it contains.** Not
approximately, not before filtering. If the header says one figure and the rows
add to another, the report is worse than useless: somebody will reconcile it
against an invoice, find the discrepancy, and stop trusting every number this
product produces. `verify_totals` exists to make that checkable, and the test
suite runs it over real filter combinations.

**A report states its own completeness.** Every export carries how many billing
records it covers, how many matched inventory, what was excluded and why. A
report that silently omits rows it could not price is a report that understates
spend without saying so.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger("cloud_svc.cost.report")

# The report types offered. Each names the endpoint/shape that backs it, so a
# type cannot be offered in the UI without something actually producing it.
REPORT_TYPES = {
    "executive": {
        "label": "Executive Cost Report",
        "description": "One page: spend, change, top drivers, savings, data quality.",
        "row_level": False,
    },
    "detailed_billing": {
        "label": "Detailed Billing Report",
        "description": "Every billing row for the period, per day and service.",
        "row_level": True,
    },
    "resource": {
        "label": "Resource Cost Report",
        "description": "One row per billed resource, joined to inventory where possible.",
        "row_level": True,
        "requires": "resource",
    },
    "service": {
        "label": "Service Cost Report",
        "description": "Spend per service with share and change.",
        "row_level": True,
    },
    "daily": {
        "label": "Daily Cost Report",
        "description": "Spend per day for the period.",
        "row_level": True,
    },
    "provider": {
        "label": "Provider Cost Report",
        "description": "Spend per provider, each in its own currency.",
        "row_level": True,
    },
    "optimization": {
        "label": "Optimization Report",
        "description": "Ranked opportunities with savings basis and assumptions.",
        "row_level": True,
    },
    "unallocated": {
        "label": "Unallocated Cost Report",
        "description": "Billed rows with no inventory match or no owner tag.",
        "row_level": True,
        "requires": "resource",
    },
    "allocation": {
        "label": "Cost Allocation Report",
        "description": "Spend per business dimension, with the unallocated remainder.",
        "row_level": True,
        "requires": "resource",
    },
}

# The CSV column order. Fixed so a downstream spreadsheet or pipeline can rely
# on it, and complete enough that a row is self-describing without the header
# context — `in_inventory` in particular must travel with the row, or an
# unmatched billing record looks like a resource whose name we forgot.
CSV_COLUMNS = (
    "provider", "account", "billing_date", "service", "region",
    "resource_id", "resource_name", "resource_type",
    "usage_type", "cost_component",
    "resource_group", "compartment", "status",
    "currency", "cost", "in_inventory",
)


def available_types(capabilities: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Report types, each marked with whether this scope can actually produce it.

    A resource-level report is impossible for an AWS-only scope, so it is
    returned DISABLED with the reason rather than omitted — a missing option
    looks like a product limitation, a disabled one explains itself.
    """
    effective = (capabilities or {}).get("effective") or {}
    blocked = (capabilities or {}).get("blocked_by") or {}

    out = []
    for key, meta in REPORT_TYPES.items():
        needs = meta.get("requires")
        ok = True if not needs else bool(effective.get(needs))
        reasons = blocked.get(needs, {}) if needs and not ok else {}
        out.append({
            "id": key,
            **{k: v for k, v in meta.items() if k != "requires"},
            "available": ok,
            "requires": needs,
            "blocked_by": reasons,
        })
    return out


def _money(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def totals_by_currency(rows: Sequence[Dict[str, Any]],
                       amount_key: str = "cost") -> Dict[str, float]:
    """Per-currency sums over exactly the rows given. The one function the
    header figure and the CSV footer must both call."""
    totals: Dict[str, float] = {}
    for row in rows:
        amount = _money(row.get(amount_key))
        if amount is None:
            continue
        code = (row.get("currency") or "UNKNOWN").upper()
        totals[code] = round(totals.get(code, 0.0) + amount, 6)
    return totals


def verify_totals(
    rows: Sequence[Dict[str, Any]],
    claimed: Dict[str, float],
    *,
    tolerance: float = 0.01,
) -> Dict[str, Any]:
    """Check a claimed header total against the rows it claims to summarise.

    Returns a structured verdict rather than raising: a mismatch must be
    reported in the export's own metadata, so whoever reads the file can see
    that it disagreed with itself rather than discovering it during an audit.
    """
    actual = totals_by_currency(rows)
    mismatches = []
    for code in set(actual) | set(claimed or {}):
        a, c = actual.get(code, 0.0), (claimed or {}).get(code, 0.0)
        if abs(a - c) > tolerance:
            mismatches.append({
                "currency": code, "rows_sum": round(a, 4),
                "claimed": round(c, 4), "difference": round(a - c, 4),
            })
    return {
        "consistent": not mismatches,
        "rows_total_by_currency": {k: round(v, 4) for k, v in actual.items()},
        "claimed_total_by_currency": dict(claimed or {}),
        "mismatches": mismatches,
        "row_count": len(rows),
    }


def data_quality(rows: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The data-quality block every report carries (61)."""
    total = len(rows)
    matched = sum(1 for r in rows if r.get("in_inventory"))
    unmatched = sum(1 for r in rows if r.get("in_inventory") is False)
    unknown_match = total - matched - unmatched
    no_amount = sum(1 for r in rows if _money(r.get("cost")) is None)
    currencies = sorted({(r.get("currency") or "UNKNOWN").upper() for r in rows})

    return {
        "billing_records": total,
        "matched_to_inventory": matched,
        "unmatched": unmatched,
        # Rows from a report shape that carries no inventory join at all
        # (per-service rows). Counted separately so a service report does not
        # look like a resource report with 100% unmatched rows.
        "inventory_join_not_applicable": unknown_match,
        "attribution_percent": (
            round(matched / (matched + unmatched) * 100, 2)
            if (matched + unmatched) else None
        ),
        "records_without_amount": no_amount,
        "currencies": currencies,
        "mixed_currency": len(currencies) > 1,
        "reason_unmatched": (
            "A billing record is unmatched when its provider resource ID has no "
            "row in our inventory — usually a resource type discovery does not "
            "scan, or a resource deleted part-way through the period. Its cost "
            "is still counted; it is never dropped."
            if unmatched else None
        ),
    }


def build_csv(
    rows: Sequence[Dict[str, Any]],
    *,
    metadata: Dict[str, Any],
) -> str:
    """Assemble the CSV, metadata header first.

    Every filtered row is written — there is no row cap. A silently truncated
    export is the worst possible failure here, because the file looks complete
    and reconciles to nothing.
    """
    buffer = io.StringIO()

    # Metadata as leading comment lines. A reader who opens this in six months
    # must be able to tell what it covers without the conversation that
    # produced it.
    buffer.write(f"# Generated at,{metadata.get('generated_at')}\n")
    buffer.write(f"# Report type,{metadata.get('report_type')}\n")
    buffer.write(f"# Period,{metadata.get('period_start')} to {metadata.get('period_end')}\n")
    buffer.write(f"# Scope,{metadata.get('scope')}\n")
    buffer.write(f"# Filters,\"{metadata.get('filters')}\"\n")
    buffer.write(f"# Data source,{metadata.get('data_source')}\n")
    buffer.write(f"# Completeness,{metadata.get('completeness')}\n")
    buffer.write(f"# Row count,{len(rows)}\n")
    for code, value in (metadata.get("totals_by_currency") or {}).items():
        buffer.write(f"# Total {code},{value}\n")
    if metadata.get("totals_verified") is False:
        buffer.write("# WARNING,Header total does not match the sum of rows\n")
    buffer.write("#\n")

    writer = csv.DictWriter(buffer, fieldnames=list(CSV_COLUMNS),
                            extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({col: row.get(col) for col in CSV_COLUMNS})

    return buffer.getvalue()


def executive_summary(
    *,
    totals: Dict[str, Any],
    change: Optional[Dict[str, Any]],
    top_drivers: Sequence[Dict[str, Any]],
    savings: Optional[Dict[str, Any]],
    anomaly_count: int,
    forecast: Optional[Dict[str, Any]],
    quality: Optional[Dict[str, Any]],
    allocation: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """The one-page executive view (34).

    Every field may be NA, and the summary says which are and why. An executive
    report that quietly omits the figures it could not compute is how a board
    pack ends up asserting something nobody verified.
    """
    unavailable: List[str] = []

    total_amount = (totals or {}).get("amount")
    if total_amount is None:
        unavailable.append(
            (totals or {}).get("na_reason") or "Total spend is not available."
        )

    forecast_value = None
    if forecast and forecast.get("by_currency"):
        currency = (totals or {}).get("currency")
        block = forecast["by_currency"].get(currency) if currency else None
        if block and block.get("available"):
            forecast_value = block["current_month"]["projected_total"]
        else:
            unavailable.append(
                (block or {}).get("reason") or "Forecast is not available."
            )

    verified = (savings or {}).get("verified_by_currency") or {}
    unquantified = (savings or {}).get("unquantified_count", 0)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_spend": {
            "amount": total_amount,
            "currency": (totals or {}).get("currency"),
            "by_currency": (totals or {}).get("by_currency") or {},
            "na_reason": (totals or {}).get("na_reason"),
        },
        "change": change,
        "top_drivers": list(top_drivers)[:5],
        "savings": {
            "verified_by_currency": verified,
            "unquantified_count": unquantified,
            "note": "Verified savings are priced from a provider price list. "
                    "Unquantified opportunities are counted, not valued.",
        },
        "forecast": {
            "projected_month": forecast_value,
            "method": "run_rate_projection",
        },
        "unallocated": (allocation or {}).get("unallocated_by_currency"),
        "anomalies": anomaly_count,
        "data_quality": quality,
        # Stated, not hidden. This is the difference between a summary and a
        # selective one.
        "unavailable": unavailable,
        "disclosure": (
            "This summary contains no row-level data. Figures marked NA could "
            "not be computed from available provider data — the reason is given "
            "for each. For the complete itemised dataset, export the CSV."
        ),
    }
