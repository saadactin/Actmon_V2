"""CSV rendering: one wide, stable-header table across every section.

Generalizes the column set `resources.py`'s original `/assessment-export`
used (Section/Account/.../Detected At) with the fields the newer sections
(Inventory, Cost) need, rather than inventing a second CSV shape. Same
formula-injection guard and UTF-8 BOM that export already used.

Rows come first so the file opens as a table; the report's own facts
(period, scope, freshness) and the summary sections follow as key/value
blocks after a blank line.
"""
from __future__ import annotations

from typing import Any, Dict, List

COLUMNS = (
    ("report_section", "Section"),
    ("account_name", "Account"),
    ("provider", "Provider"),
    ("region", "Region"),
    ("resource_name", "Resource"),
    ("resource_type", "Type"),
    ("provider_resource_id", "Provider Resource ID"),
    ("attribution", "Attribution"),
    ("title", "Title"),
    ("severity", "Severity"),
    ("detail", "Detail"),
    ("metric_value", "Metric/Value"),
    ("status", "Status"),
    ("detected_at", "Detected At"),
    ("remediation", "Remediation"),
    ("estimated_monthly_savings", "Est. Monthly Savings"),
    ("savings_currency", "Savings Currency"),
    ("expires_at", "Expires At"),
    ("days_left", "Days Left"),
    ("store", "Store"),
    ("cost_amount", "Billed Cost"),
    ("currency", "Currency"),
    ("cost_period_days", "Cost Window (days)"),
    ("billed_service", "Billed Service"),
    ("environment", "Environment"),
    ("owner", "Owner"),
    ("resource_group", "Resource Group"),
    ("compartment", "Compartment"),
    ("discovered_at", "Discovered At"),
    ("last_seen_at", "Last Seen At"),
)

_LABELS = {
    "inventory": "Inventory", "security": "Security", "utilization": "Utilization",
    "performance": "Performance", "recommendations": "Recommendations",
    "cost": "Cost", "anomalies": "Anomalies (Account-Wide)",
    "certificates": "Expiring Certificates & Secrets", "changes": "Configuration Changes",
    "executive_summary": "Executive Summary", "cost_summary": "Account Spend",
    "posture": "Security Posture & Compliance", "identity": "Identity & Access",
    "activity": "Account Activity (Event Log)",
    "data_quality": "Data Quality & Coverage",
}

_SUMMARY_SECTIONS = ("executive_summary", "cost_summary", "posture", "identity", "activity",
                     "data_quality")


def _cell(value: Any) -> str:
    """Neutralise a value a spreadsheet would evaluate as a formula."""
    if value is None:
        return ""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # A real number is never a formula. Guarding it turned "-907.2" days
        # left (an expired certificate) into the text "'-907.2" in Excel.
        return str(value)
    text = str(value)
    if text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def report_facts(dataset: Dict[str, Any]) -> List[tuple]:
    """The report's own header facts, shared with the Excel Summary sheet."""
    period = dataset.get("period") or {}
    fresh = dataset.get("freshness") or {}
    meta = dataset.get("metadata") or {}
    facts = [
        ("Title", meta.get("title")),
        ("Subtitle", meta.get("subtitle")),
        ("Organization", meta.get("organization")),
        ("Prepared by", meta.get("prepared_by")),
        ("Confidentiality", meta.get("confidentiality")),
        ("Reference", meta.get("reference")),
        ("Account", dataset["account"]["name"]),
        ("Provider", dataset["account"]["provider"]),
        ("Generated at", dataset.get("generated_at")),
        ("Reporting period", f"{period.get('label')}: {period.get('start')} to {period.get('end')} "
                             f"({period.get('timezone')})" if period else None),
        ("Scope", (dataset.get("scope") or {}).get("mode")),
        ("Resources requested", dataset.get("resources_requested")),
        ("Resources resolved", dataset.get("resources_resolved")),
        ("Detail level", (dataset.get("layout") or {}).get("detail_level")),
        ("Last refreshed", fresh.get("last_refreshed_at")),
        ("Refresh status", fresh.get("refresh_status")),
    ]
    for warning in fresh.get("warnings") or []:
        facts.append(("Warning", warning))
    return [(k, v) for k, v in facts if v not in (None, "")]


def coverage_rows(dataset: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Resources with nothing to report, per section -- only present at the
    Detailed level (`apply_detail_level` empties the lists otherwise)."""
    out = []
    for section, cov in (dataset.get("coverage") or {}).items():
        for entry in cov.get("without") or []:
            out.append({**entry, "account_name": dataset["account"]["name"],
                        "provider": dataset["account"]["provider"],
                        "report_section": f"Coverage: {_LABELS.get(section, section)}",
                        "title": "Nothing to report", "detail": entry.get("reason")})
    return out


def build_csv(dataset: Dict[str, Any]) -> str:
    import csv
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([label for _, label in COLUMNS])

    for section, rows in dataset.get("sections", {}).items():
        if section in _SUMMARY_SECTIONS or not isinstance(rows, list):
            continue
        label = _LABELS.get(section, section)
        for row in rows:
            merged = {**row, "report_section": label}
            writer.writerow([_cell(merged.get(key)) for key, _ in COLUMNS])
    for row in coverage_rows(dataset):
        writer.writerow([_cell(row.get(key)) for key, _ in COLUMNS])

    # Summary sections are key/value, not the wide row shape above -- append
    # them as their own small blocks rather than forcing them into columns
    # that do not fit them, so nothing from these sections is lost.
    writer.writerow([])
    writer.writerow(["Report"])
    for key, value in report_facts(dataset):
        writer.writerow([key, _cell(value)])
    for section in _SUMMARY_SECTIONS:
        data = dataset.get("sections", {}).get(section)
        if not isinstance(data, dict):
            continue
        writer.writerow([])
        writer.writerow([_LABELS.get(section, section)])
        for key, value in _flatten(data):
            writer.writerow([key, _cell(value)])

    # A leading BOM so Excel reads this as UTF-8 rather than mojibake-ing any
    # non-ASCII resource name or finding text.
    return "﻿" + buffer.getvalue()


def _flatten(data: Dict[str, Any], prefix: str = "") -> List[tuple]:
    out: List[tuple] = []
    for key, value in data.items():
        full = f"{prefix}{key}" if not prefix else f"{prefix}.{key}"
        if isinstance(value, dict):
            out.extend(_flatten(value, full))
        elif isinstance(value, list) and any(isinstance(v, dict) for v in value):
            for i, item in enumerate(value, 1):
                out.extend(_flatten(item, f"{full}.{i}") if isinstance(item, dict)
                           else [(f"{full}.{i}", item)])
        elif isinstance(value, list):
            out.append((full, "; ".join(str(v) for v in value)))
        else:
            out.append((full, value))
    return out
