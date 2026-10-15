"""CSV rendering: one wide, stable-header table across every section.

Generalizes the column set `resources.py`'s original `/assessment-export`
used (Section/Account/.../Detected At) with the fields the newer sections
(Inventory, Cost) need, rather than inventing a second CSV shape. Same
formula-injection guard and UTF-8 BOM that export already used.
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
    ("title", "Title"),
    ("severity", "Severity"),
    ("detail", "Detail"),
    ("metric_value", "Metric/Value"),
    ("status", "Status"),
    ("detected_at", "Detected At"),
    ("cost_monthly", "Cost (Monthly)"),
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
}

_SUMMARY_SECTIONS = ("executive_summary", "data_quality")


def _cell(value: Any) -> str:
    """Neutralise a value a spreadsheet would evaluate as a formula."""
    if value is None:
        return ""
    text = str(value)
    if text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


def build_csv(dataset: Dict[str, Any]) -> str:
    import csv
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([label for _, label in COLUMNS])

    row_count = 0
    for section, rows in dataset.get("sections", {}).items():
        if section in _SUMMARY_SECTIONS or not isinstance(rows, list):
            continue
        label = _LABELS.get(section, section)
        for row in rows:
            merged = {**row, "report_section": label}
            writer.writerow([_cell(merged.get(key)) for key, _ in COLUMNS])
            row_count += 1

    # Summary sections are key/value, not the wide row shape above -- append
    # them as their own small block rather than forcing them into columns
    # that do not fit them, so nothing from these sections is lost.
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
        else:
            out.append((full, value))
    return out
