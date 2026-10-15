"""Excel rendering: one worksheet per enabled section plus a Summary sheet.

Only a worksheet for a section the user actually enabled -- an empty
"Performance" tab on a report nobody asked to include it would be exactly
the silent padding this product's export code avoids elsewhere.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Dict

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from .csv_renderer import _flatten

_SHEET_TITLES = {
    "executive_summary": "Summary",
    "inventory": "Inventory",
    "security": "Security Findings",
    "utilization": "Utilization",
    "performance": "Performance",
    "recommendations": "Recommendations",
    "cost": "Cost",
    "anomalies": "Anomalies (Acct-Wide)",
    "data_quality": "Data Quality",
}

_ROW_COLUMNS = (
    ("resource_name", "Resource"), ("provider_resource_id", "Provider Resource ID"),
    ("resource_type", "Type"), ("region", "Region"),
    ("title", "Title"), ("severity", "Severity"), ("detail", "Detail"),
    ("metric_value", "Metric/Value"), ("status", "Status"),
    ("detected_at", "Detected At"), ("cost_monthly", "Cost (Monthly)"),
    ("environment", "Environment"), ("owner", "Owner"),
    ("resource_group", "Resource Group"), ("compartment", "Compartment"),
    ("discovered_at", "Discovered At"), ("last_seen_at", "Last Seen At"),
)

_DATE_FIELDS = {"detected_at", "discovered_at", "last_seen_at"}
_NUMERIC_FIELDS = {"cost_monthly"}

_HEADER_FONT = Font(bold=True, color="FFFFFF")
_HEADER_FILL = PatternFill(start_color="1E6FB8", end_color="1E6FB8", fill_type="solid")


def _parse_date(value: Any):
    if not isinstance(value, str):
        return value
    try:
        # Excel's datetime cell type cannot hold a tzinfo -- stripped here,
        # not dropped silently: every timestamp this product stores is UTC.
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return value


def _style_header(ws: Worksheet, ncols: int) -> None:
    for col in range(1, ncols + 1):
        cell = ws.cell(row=1, column=col)
        cell.font = _HEADER_FONT
        cell.fill = _HEADER_FILL
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(ncols)}1"


def _write_row_sheet(wb: Workbook, title: str, rows) -> None:
    ws = wb.create_sheet(title[:31])
    ws.append([label for _, label in _ROW_COLUMNS])
    for row in rows:
        values = []
        for key, _ in _ROW_COLUMNS:
            value = row.get(key)
            if key in _DATE_FIELDS:
                value = _parse_date(value)
            elif key in _NUMERIC_FIELDS and value is not None:
                value = float(value)
            values.append(value)
        ws.append(values)
    _style_header(ws, len(_ROW_COLUMNS))
    for col in range(1, len(_ROW_COLUMNS) + 1):
        ws.column_dimensions[get_column_letter(col)].width = 20


def _write_summary_sheet(wb: Workbook, dataset: Dict[str, Any]) -> None:
    ws = wb.create_sheet("Summary")
    ws.append(["Field", "Value"])
    ws.append(["Account", dataset["account"]["name"]])
    ws.append(["Provider", dataset["account"]["provider"]])
    ws.append(["Resources requested", dataset["resources_requested"]])
    ws.append(["Resources resolved", dataset["resources_resolved"]])
    for section in ("executive_summary", "data_quality"):
        data = dataset.get("sections", {}).get(section)
        if not isinstance(data, dict):
            continue
        ws.append([])
        ws.append([_SHEET_TITLES.get(section, section)])
        for key, value in _flatten(data):
            ws.append([key, str(value) if isinstance(value, (dict, list)) else value])
    _style_header(ws, 2)
    ws.column_dimensions["A"].width = 32
    ws.column_dimensions["B"].width = 48


def build_xlsx(dataset: Dict[str, Any]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)  # default blank sheet

    _write_summary_sheet(wb, dataset)

    for section, rows in dataset.get("sections", {}).items():
        if section in ("executive_summary", "data_quality") or not isinstance(rows, list):
            continue
        _write_row_sheet(wb, _SHEET_TITLES.get(section, section), rows)

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()
