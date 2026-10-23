"""PDF rendering: dataset in, bytes out. Same ReportLab approach as
`client_report_pdf.py` (standard fonts only, cp1252-safe `_t()`, a numbered
header/footer canvas) so a report generated here looks like it belongs next
to the monthly client report, not like a second product.

Content per detail level is decided once, in
`report_service.apply_detail_level`, so the PDF shows what the CSV/Excel/JSON
of the same request contain. Each section has its own columns: the first
version pushed every section through one findings-shaped table, so the Cost
section printed no amounts and Inventory printed no type or region.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

INK = colors.HexColor("#0e2a47")
TEXT = colors.HexColor("#2c4257")
MUTED = colors.HexColor("#64798d")
LINE = colors.HexColor("#d7e4ee")
SOFT = colors.HexColor("#f2f6fa")
DANGER = colors.HexColor("#b42318")
WARN = colors.HexColor("#b54708")
WARN_SOFT = colors.HexColor("#fff6ed")

SEV_COLOR = {"CRITICAL": DANGER, "HIGH": DANGER, "MEDIUM": WARN, "LOW": MUTED, "INFO": MUTED}

_FOLD = {"->": "->", "→": "->", "←": "<-", "≤": "<=", "≥": ">=",
         "≠": "!=", "✓": "yes", "✗": "no", "—": "-", "–": "-", "₹": "INR "}

_SECTION_LABELS = {
    "inventory": "Resource Inventory", "security": "Security Assessment",
    "utilization": "Resource Utilization", "performance": "Performance Analysis",
    "recommendations": "Recommendations", "cost": "Cost per Resource",
    "anomalies": "Spend Anomalies (Account-Wide)",
    "certificates": "Expired and Expiring Certificates & Secrets",
    "changes": "Configuration Changes in the Period",
}
_ROW_SECTIONS = ("inventory", "security", "utilization", "performance",
                 "recommendations", "cost", "anomalies", "certificates", "changes")
_GROUP_LABELS = {"region": "Region", "resource_type": "Type", "severity": "Severity"}

# Usable width on A4 with 16 mm margins.
_WIDTH = 178 * mm


def _t(value: Any) -> str:
    s = "" if value is None else str(value)
    for char, ascii_ in _FOLD.items():
        s = s.replace(char, ascii_)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.encode("cp1252", "replace").decode("cp1252")


def _styles() -> Dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=base["Normal"], fontName="Helvetica", fontSize=9,
                          leading=12.5, textColor=TEXT)
    return {
        "body": body,
        "small": ParagraphStyle("small", parent=body, fontSize=7.8, leading=10.5, textColor=MUTED),
        "cell": ParagraphStyle("cell", parent=body, fontSize=8, leading=10.2),
        "cell_right": ParagraphStyle("cell_right", parent=body, fontSize=8, leading=10.2,
                                     alignment=2),
        # A Paragraph carries its own colour, so a header cell built from one
        # ignores the table's white header TEXTCOLOR -- dark text on the dark
        # header band, i.e. invisible. Header cells use this instead.
        "th": ParagraphStyle("th", parent=body, fontName="Helvetica-Bold", fontSize=7.8,
                             leading=10, textColor=colors.white),
        "warn": ParagraphStyle("warn", parent=body, fontSize=8.5, leading=11.5, textColor=WARN),
        "h1": ParagraphStyle("h1", parent=body, fontName="Helvetica-Bold", fontSize=22,
                             leading=26, textColor=INK, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=body, fontName="Helvetica-Bold", fontSize=13,
                             leading=16, textColor=INK, spaceBefore=10, spaceAfter=6),
        "h3": ParagraphStyle("h3", parent=body, fontName="Helvetica-Bold", fontSize=9.5,
                             leading=12, textColor=INK, spaceBefore=6, spaceAfter=3),
        "lede": ParagraphStyle("lede", parent=body, fontSize=11, leading=15, textColor=MUTED),
    }


def _table(rows: List[List[Any]], widths, *, header: bool = True) -> Table:
    t = Table(rows, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    style = [
        ("FONT", (0, 0), (-1, -1), "Helvetica", 7.8),
        ("TEXTCOLOR", (0, 0), (-1, -1), TEXT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), INK),
                  ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                  ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7.8)]
    for i in range(1 if header else 0, len(rows)):
        if (i - (1 if header else 0)) % 2 == 1:
            style.append(("BACKGROUND", (0, i), (-1, i), SOFT))
    t.setStyle(TableStyle(style))
    return t


def _decorations(title: str, generated_at: str):
    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._pages: List[Dict[str, Any]] = []

        def showPage(self):  # noqa: N802
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self._chrome(total)
                super().showPage()
            super().save()

        def _chrome(self, total: int):
            w, h = A4
            self.saveState()
            self.setStrokeColor(INK)
            self.setLineWidth(1.2)
            self.line(16 * mm, h - 13 * mm, w - 16 * mm, h - 13 * mm)
            self.setFont("Helvetica-Bold", 7.5)
            self.setFillColor(INK)
            self.drawString(16 * mm, h - 11 * mm, _t(f"ACTMON  |  {title}"))
            self.setStrokeColor(LINE)
            self.setLineWidth(0.5)
            self.line(16 * mm, 12 * mm, w - 16 * mm, 12 * mm)
            self.setFont("Helvetica", 7.5)
            self.setFillColor(MUTED)
            self.drawString(16 * mm, 8 * mm, _t(f"Generated {generated_at}"))
            self.drawRightString(w - 16 * mm, 8 * mm, f"Page {self._pageNumber} of {total}")
            self.restoreState()

    return NumberedCanvas


def _severity_cell(sev: Optional[str], s: Dict[str, ParagraphStyle]) -> Paragraph:
    colour = SEV_COLOR.get(sev or "", MUTED)
    return Paragraph(f"<font color='#{colour.hexval()[2:]}'><b>{_t(sev or '-')}</b></font>", s["cell"])


_MAX_CELL_CHARS = 400


def _clip(text: str) -> str:
    """Cap a cell's length for the PDF page only -- CSV/JSON/XLSX keep the
    full text. Without this, a single finding whose detail lists hundreds of
    affected services (seen: 5,845 characters) renders as a table row over
    1700pt tall, which reportlab refuses to lay out on any page at all."""
    if len(text) <= _MAX_CELL_CHARS:
        return text
    return text[:_MAX_CELL_CHARS] + "... (truncated for PDF -- see CSV/JSON/Excel for the full text)"


def _money(amount: Any, currency: Any) -> str:
    if amount is None:
        return "Not available"
    return f"{float(amount):,.2f} {currency or ''}".strip()


def _day(value: Any) -> str:
    return str(value)[:10] if value else "-"


def _when(value: Any) -> str:
    """An ISO timestamp as 'YYYY-MM-DD HH:MM UTC', or 'never'."""
    if not value:
        return "never"
    try:
        return datetime.fromisoformat(str(value)).strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return str(value)


# ── Per-section tables ───────────────────────────────────────────────────────
# (header, width in mm, cell builder). The builder gets (row, styles, detailed).

Column = Tuple[str, float, Callable[[Dict[str, Any], Dict[str, ParagraphStyle], bool], Any]]


def _p(text: Any, s, style: str = "cell") -> Paragraph:
    return Paragraph(_t(_clip(str(text if text not in (None, "") else "-"))), s[style])


def _resource_cell(row, s, detailed) -> Paragraph:
    name = _t(_clip(str(row.get("resource_name") or row.get("provider_resource_id") or "-")))
    extra = []
    if row.get("attribution") == "Account-level":
        extra.append("account-level")
    if detailed and row.get("provider_resource_id") and row.get("provider_resource_id") != row.get("resource_name"):
        extra.append(_t(_clip(str(row["provider_resource_id"]))))
    if extra:
        name += "<br/><font size='6.5' color='#64798d'>" + " | ".join(extra) + "</font>"
    return Paragraph(name, s["cell"])


def _detail_cell(row, s, detailed) -> Paragraph:
    """The finding's description; at the Detailed level also its fix, which
    is the rule's own multi-line remediation (line breaks kept)."""
    text = _t(_clip(str(row.get("detail") or row.get("metric_value") or "-")))
    if row.get("estimated_monthly_savings") is not None and "Est. savings" not in text:
        text += _t(f" Est. savings {_money(row['estimated_monthly_savings'], row.get('savings_currency'))}/month.")
    if detailed and row.get("remediation"):
        fix = _t(_clip(str(row["remediation"]))).replace("\n", "<br/>")
        text += f"<br/><font color='#64798d'><b>How to fix:</b><br/>{fix}</font>"
    return Paragraph(text, s["cell"])


_FINDING_COLUMNS: Sequence[Column] = (
    ("Resource", 36, _resource_cell),
    ("Title", 40, lambda r, s, d: _p(r.get("title"), s)),
    ("Severity", 17, lambda r, s, d: _severity_cell(r.get("severity"), s)),
    ("Detail", 51, lambda r, s, d: _detail_cell(r, s, d)),
    ("Status", 16, lambda r, s, d: _p(r.get("status"), s)),
    ("Detected", 18, lambda r, s, d: _p(_day(r.get("detected_at")), s, "small")),
)

_SECTION_COLUMNS: Dict[str, Sequence[Column]] = {
    "inventory": (
        ("Resource", 46, _resource_cell),
        ("Type", 30, lambda r, s, d: _p(r.get("resource_type"), s)),
        ("Region", 26, lambda r, s, d: _p(r.get("region"), s)),
        ("Status", 20, lambda r, s, d: _p(r.get("status"), s)),
        ("Environment / Owner", 32, lambda r, s, d: _p(
            " / ".join(x for x in (r.get("environment"), r.get("owner")) if x) or "-", s)),
        ("Last seen", 24, lambda r, s, d: _p(_day(r.get("last_seen_at")), s, "small")),
    ),
    "utilization": (
        ("Resource", 38, _resource_cell),
        ("Metric", 34, lambda r, s, d: _p(r.get("title"), s)),
        ("Measurement", 62, lambda r, s, d: _p(r.get("detail") or r.get("metric_value"), s)),
        ("Status", 24, lambda r, s, d: _p(r.get("status"), s)),
        ("Collected", 20, lambda r, s, d: _p(_day(r.get("detected_at")), s, "small")),
    ),
    "cost": (
        ("Resource", 50, _resource_cell),
        ("Type", 30, lambda r, s, d: _p(r.get("resource_type"), s)),
        ("Billed service", 34, lambda r, s, d: _p(r.get("billed_service"), s)),
        ("Region", 22, lambda r, s, d: _p(r.get("region"), s)),
        ("Billed cost", 28, lambda r, s, d: _p(_money(r.get("cost_amount"), r.get("currency")), s, "cell_right")),
        ("Days", 14, lambda r, s, d: _p(r.get("cost_period_days"), s, "cell_right")),
    ),
    "certificates": (
        ("Name", 46, _resource_cell),
        ("Kind", 22, lambda r, s, d: _p(r.get("resource_type"), s)),
        ("Expires", 22, lambda r, s, d: _p(_day(r.get("expires_at")), s, "small")),
        ("Days left", 18, lambda r, s, d: _days_left_cell(r.get("days_left"), s)),
        ("Where", 46, lambda r, s, d: _p(r.get("detail") or r.get("store"), s)),
        ("In use", 24, lambda r, s, d: _p({True: "yes", False: "no"}.get(r.get("in_use"), "unknown"), s)),
    ),
    "changes": (
        ("Resource", 36, _resource_cell),
        ("Change", 34, lambda r, s, d: _p(r.get("title"), s)),
        ("Severity", 17, lambda r, s, d: _severity_cell(r.get("severity"), s)),
        ("What changed", 69, lambda r, s, d: _p(
            r.get("detail") if not d or not r.get("metric_value")
            else f"{r.get('detail')} ({r.get('metric_value')})", s)),
        ("Detected", 22, lambda r, s, d: _p(_day(r.get("detected_at")), s, "small")),
    ),
}


def _days_left_cell(days: Any, s) -> Paragraph:
    if days is None:
        return Paragraph("-", s["cell_right"])
    colour = DANGER if days < 0 else WARN if days <= 7 else TEXT
    text = f"{abs(days):.0f} ago" if days < 0 else f"{days:.0f}"
    return Paragraph(f"<font color='#{colour.hexval()[2:]}'>{_t(text)}</font>", s["cell_right"])


def _rows_table(section: str, rows: List[Dict[str, Any]], s, detailed: bool) -> Table:
    columns = _SECTION_COLUMNS.get(section, _FINDING_COLUMNS)
    body = [[Paragraph(h, s["th"]) for h, _, _ in columns]]
    for row in rows:
        body.append([build(row, s, detailed) for _, _, build in columns])
    return _table(body, [w * mm for _, w, _ in columns])


def _groups(rows: List[Dict[str, Any]], group_by: Optional[str]) -> List[Tuple[Optional[str], List[Dict[str, Any]]]]:
    """Consecutive runs of the same group value -- the service already sorted
    rows group-first, so this only has to split them."""
    if not group_by or not any(group_by in r for r in rows):
        return [(None, rows)]
    out: List[Tuple[Optional[str], List[Dict[str, Any]]]] = []
    for row in rows:
        value = row.get(group_by) or None
        if not out or out[-1][0] != value:
            out.append((value, []))
        out[-1][1].append(row)
    return out


def _coverage_line(section: str, dataset: Dict[str, Any]) -> Optional[str]:
    cov = (dataset.get("coverage") or {}).get(section)
    if not cov:
        return None
    if cov.get("status") == "unavailable":
        return f"This section could not be read: {cov.get('error')}"
    without = cov.get("resources_without_data") or 0
    checked = cov.get("resources_checked") or 0
    noun = {"security": "no open security findings", "utilization": "no telemetry collected",
            "performance": "no open performance findings", "recommendations": "no open recommendations",
            "cost": "no billed cost reported (unknown, not zero)"}.get(section, "nothing to report")
    parts = []
    if without:
        parts.append(f"{without} of {checked} resource(s) in scope have {noun}"
                     + ("; they are listed after this section's table." if cov.get("without") else "."))
    if section == "certificates":
        failing = cov.get("resources_without_data") or 0
        return (f"{failing} of {cov.get('resources_checked') or 0} credential store(s) could not be "
                f"read -- anything in them is missing from this list." if failing else None)
    if section == "changes":
        by_type = cov.get("by_change_type") or {}
        return ", ".join(f"{n} {k.lower()}" for k, n in sorted(by_type.items())) or None
    if section == "security" and cov.get("account_level_findings"):
        n = cov["account_level_findings"]
        parts.append(f"{n} finding(s) are account-level (not tied to one resource) and are "
                     + ("included below." if cov.get("account_level_included")
                        else "excluded from this scoped report."))
    return " ".join(parts) or None


# ── Charts ───────────────────────────────────────────────────────────────────
# Horizontal bars only: every chart here is "how much, per named thing", and
# the names (services, severities) are long. One series per chart, so no
# legend -- the heading names it. Every bar carries its label and value in
# text ink, so colour never carries the meaning alone (print, colour-blind),
# and the table beside each chart is the exact-figure view.

# Status hues are reserved for severity; a measured amount uses one plain hue.
STATUS_HUE = {"CRITICAL": colors.HexColor("#d03b3b"), "HIGH": colors.HexColor("#ec835a"),
              "MEDIUM": colors.HexColor("#fab219")}
NEUTRAL_HUE = colors.HexColor("#a3adb8")
SERIES_HUE = colors.HexColor("#2a78d6")


def _bar_chart(items: List[Tuple[str, float, Any, str]], *, width: float = _WIDTH,
               peak: Optional[float] = None):
    """items: (label, value, colour, value text). Bars share one zero-based
    scale; a zero value draws no bar but keeps its row and its "0". `peak`
    fixes the scale (100 for percentages) instead of the largest value."""
    from reportlab.graphics.shapes import Drawing, Rect, String

    row_h, bar_h, label_w, value_w = 15, 8, 58 * mm, 34 * mm
    track = width - label_w - value_w
    peak = peak or max((v for _, v, _, _ in items), default=0) or 1
    d = Drawing(width, row_h * len(items) + 4)
    for i, (label, value, hue, text) in enumerate(items):
        y = d.height - (i + 1) * row_h + (row_h - bar_h) / 2
        d.add(String(0, y + 1.5, _t(label)[:48], fontName="Helvetica", fontSize=7.8, fillColor=TEXT))
        length = track * (value / peak) if value > 0 else 0
        if length:
            # Anchored to the baseline, rounded only by a hair: a thin mark.
            d.add(Rect(label_w, y, max(length, 1.5), bar_h, rx=2, ry=2,
                       fillColor=hue, strokeColor=None))
        d.add(String(label_w + length + 4, y + 1.5, _t(text), fontName="Helvetica",
                     fontSize=7.8, fillColor=TEXT))
    return d


def _severity_chart(by_severity: Dict[str, int]):
    order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
    items = [(sev.title(), by_severity.get(sev, 0), STATUS_HUE.get(sev, NEUTRAL_HUE),
              str(by_severity.get(sev, 0))) for sev in order]
    return _bar_chart(items) if any(v for _, v, _, _ in items) else None


def _spend_chart(rows: List[Dict[str, Any]], label_key: str):
    """Spend per service/resource. One chart per currency -- bars on one scale
    must be in one currency."""
    by_currency: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        if r.get("amount") is not None:
            by_currency.setdefault(r.get("currency") or "?", []).append(r)
    charts = []
    for currency, items in sorted(by_currency.items()):
        items = sorted(items, key=lambda r: r["amount"], reverse=True)[:8]
        charts.append(_bar_chart([(str(r.get(label_key) or "-"), float(r["amount"]), SERIES_HUE,
                                   _money(r["amount"], currency)) for r in items]))
    return charts


# ── Blocks ───────────────────────────────────────────────────────────────────

def _kv_table(rows: List[Tuple[str, str]], s, header=("Metric", "Value")) -> Table:
    body = [[Paragraph(_t(header[0]), s["th"]), Paragraph(_t(header[1]), s["th"])]]
    body += [[Paragraph(_t(k), s["cell"]), Paragraph(_t(v), s["cell"])] for k, v in rows]
    return _table(body, [70 * mm, 108 * mm])


def _freshness_block(dataset: Dict[str, Any], s) -> List[Any]:
    fresh = dataset.get("freshness") or {}
    status = fresh.get("refresh_status")
    lines = [
        f"Last refreshed {_when(fresh.get('last_refreshed_at'))}"
        + (f" ({status})" if status else ""),
        f"Security assessed {_when(fresh.get('security_assessed_at'))}",
        f"Billing data through {fresh.get('billing_data_through') or 'none stored'}",
    ]
    story: List[Any] = [Paragraph(_t("Data as of: " + " - ".join(lines)), s["small"])]
    warnings = fresh.get("warnings") or []
    if warnings:
        box = Table([[Paragraph(_t("Data completeness: " + " ".join(warnings)), s["warn"])]],
                    colWidths=[_WIDTH], hAlign="LEFT")
        box.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), WARN_SOFT),
            ("BOX", (0, 0), (-1, -1), 0.6, WARN),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story += [Spacer(1, 2 * mm), box]
    return story


# Paragraph collapses ordinary spaces; non-breaking ones survive (and are cp1252).
_INDENT = "\u00a0" * 4


def _summary_rows(summary: Dict[str, Any]) -> List[Tuple[str, str]]:
    rows = [("Resources in scope", str(summary.get("resources_in_scope", "-"))),
            ("Reporting period", str(summary.get("reporting_period", "-")))]
    posture = summary.get("posture")
    if posture:
        rows.append(("Security posture", _posture_text(posture)))
    rows.append(("Critical/High security findings", str(summary.get("critical_or_high", "-"))))
    for sev, count in summary.get("security_findings_by_severity", {}).items():
        rows.append((f"{_INDENT}{sev}", str(count)))
    if "account_level_findings" in summary:
        rows.append((f"{_INDENT}of which account-level", str(summary["account_level_findings"])))
    for name, label in (("performance_findings", "Performance findings"),
                        ("recommendations_findings", "Recommendations")):
        if name in summary:
            rows.append((label, str(summary[name])))
    if "billed_cost_of_resources_in_scope" in summary:
        billed = summary["billed_cost_of_resources_in_scope"]
        rows.append(("Billed cost of resources in scope",
                     ", ".join(_money(v, c) for c, v in billed.items()) or "Not available"))
        if summary.get("resources_with_billed_cost") is not None:
            rows.append(("Resources with a billed cost", str(summary["resources_with_billed_cost"])))
    if "account_spend_in_period" in summary:
        spend = summary["account_spend_in_period"]
        rows.append(("Account spend in period",
                     ", ".join(_money(v, c) for c, v in spend.items()) or "No billing data"))
    change = summary.get("spend_change")
    if change and change.get("by_currency"):
        rows.append(("Spend change vs the previous equal period",
                     "; ".join(_change_text(c, v) for c, v in change["by_currency"].items())))
        rows.append((f"{_INDENT}compared", str(change.get("basis") or "-")))
    if "spend_anomalies_in_period" in summary:
        rows.append(("Spend anomalies in period", str(summary["spend_anomalies_in_period"])))
    if "potential_monthly_savings" in summary:
        saving = summary["potential_monthly_savings"]
        text = ", ".join(_money(v, c) for c, v in saving.items()) or "None quantified"
        if summary.get("savings_unpriced_findings"):
            text += f" (+{summary['savings_unpriced_findings']} recommendation(s) not quantified)"
        rows.append(("Potential savings per month", text))
    if "credentials_expired" in summary:
        rows.append(("Certificates/secrets expired", str(summary["credentials_expired"])))
        rows.append(("Certificates/secrets expiring within 30 days", str(summary["credentials_expiring_30_days"])))
    if "config_changes_in_period" in summary:
        sev = summary.get("config_changes_by_severity") or {}
        detail = ", ".join(f"{n} {k.lower()}" for k, n in sev.items())
        rows.append(("Configuration changes in period",
                     f"{summary['config_changes_in_period']}" + (f" ({detail})" if detail else "")))
    if "audit_events_in_period" in summary:
        rows.append(("Audit events in period",
                     f"{summary['audit_events_in_period'] or 0} ({summary.get('high_risk_events_in_period') or 0} high-risk)"))
    return rows


def _posture_text(p: Dict[str, Any]) -> str:
    if p.get("status") == "unavailable":
        return "Could not be read"
    if p.get("status") == "not_assessed":
        return "Not assessed"
    if not p.get("reliable"):
        return f"Withheld (grade {p.get('grade') or '-'}): too little of the account was assessable"
    when = _day(p.get("assessed_at"))
    return f"{p.get('score')}/100, grade {p.get('grade')} ({p.get('coverage_pct')}% assessed, {when})"


def _change_text(code: str, c: Dict[str, Any]) -> str:
    if c.get("percent") is not None:
        sign = "+" if c["percent"] > 0 else ""
        return (f"{sign}{c['percent']:.1f}% ({_money(c.get('previous'), code)} -> "
                f"{_money(c.get('current'), code)})")
    return f"{c.get('label') or 'NA'}: {c.get('reason') or ''}".strip()


def _since_block(since: Dict[str, Any], s) -> List[Any]:
    when = _day(since.get("previous_generated_at"))
    head = Paragraph(_t(f"Since the last report ({when})"), s["h3"])
    if not since.get("comparable") or not since.get("changes"):
        return [KeepTogether([head, Paragraph(_t(since.get("reason") or "Nothing to compare."), s["small"])])]
    body = [[Paragraph(h, s["th"]) for h in ("Measure", "Then", "Now", "Change")]]
    for c in since["changes"]:
        def fmt(v, code=c.get("currency")):
            return _money(v, code) if code else (f"{v:,.0f}" if isinstance(v, (int, float)) else str(v))
        arrow = {"better": "better", "worse": "worse", "unchanged": "no change"}.get(c["trend"], "")
        colour = {"better": "#1a7f37", "worse": "#b42318"}.get(c["trend"], "#64798d")
        sign = "+" if c["change"] > 0 else ""
        change_text = (f"{sign}{fmt(c['change'])}" if c["change"] else "0")
        body.append([_p(c["metric"], s), _p(fmt(c["previous"]), s, "cell_right"),
                     _p(fmt(c["current"]), s, "cell_right"),
                     Paragraph(f"{_t(change_text)} <font color='{colour}'>{_t(arrow)}</font>", s["cell_right"])])
    return [KeepTogether([head, _table(body, [70 * mm, 36 * mm, 36 * mm, 36 * mm])])]


def _top_lists(summary: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = []
    if summary.get("since_last_report"):
        story += _since_block(summary["since_last_report"], s)
    risks = summary.get("top_risks") or []
    if risks:
        body = [[Paragraph(h, s["th"]) for h in ("Risk", "Severity", "Resources", "What to do")]]
        for r in risks:
            where = (f"{r['resources']}" if r["resources"] != 1
                     else _t(_clip(str(r.get("example_resource") or "1"))))
            fix = _t(_clip(str(r.get("remediation") or "See the finding in the Security Center.")))
            body.append([_p(r["title"], s), _severity_cell(r["severity"], s), Paragraph(where, s["cell"]),
                         # Remediation is multi-line (commands with continuations).
                         Paragraph(fix.replace("\n", "<br/>"), s["cell"])])
        story.append(KeepTogether([Paragraph("Top risks", s["h3"]),
                                   _table(body, [52 * mm, 18 * mm, 26 * mm, 82 * mm])]))
    top_cost = summary.get("top_cost_resources") or []
    if top_cost:
        story.append(KeepTogether([Paragraph("Most expensive resources", s["h3"])] + _spend_chart(
            [{"label": f"{x['resource_name']} ({x.get('resource_type') or '-'})",
              "amount": x["amount"], "currency": x["currency"]} for x in top_cost], "label")))
    return story


def _posture_block(p: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = [Paragraph("Security Posture and Compliance", s["h2"])]
    score = p.get("score") or {}
    story.append(Paragraph(_t(f"Security Center score: {_posture_text(score)}."), s["body"]))
    if score.get("note"):
        story.append(Paragraph(_t(score["note"]), s["small"]))
    if p.get("frameworks_status") == "unavailable":
        return story + [Paragraph(_t(p.get("frameworks_error")), s["warn"])]
    frameworks = p.get("frameworks") or []
    if not frameworks:
        return story
    story.append(KeepTogether([Paragraph("Control pass rate by framework", s["h3"]), _bar_chart([
        (f["framework"], f["pass_rate"] or 0.0, SERIES_HUE,
         f"{f['pass_rate']:.0f}%" if f["pass_rate"] is not None else "not rated")
        for f in frameworks], peak=100)]))
    body = [[Paragraph(h, s["th"]) for h in ("Framework", "Assessed", "Passed", "Failed", "Partial",
                                             "Unknown", "Pass rate")]]
    for f in frameworks:
        body.append([_p(f["framework"], s)] + [_p(f.get(k), s, "cell_right") for k in (
            "controls_assessed", "passed", "failed", "partial", "unknown")]
            + [_p(f"{f['pass_rate']:.1f}%" if f["pass_rate"] is not None else "not rated", s, "cell_right")])
    story += [Spacer(1, 2 * mm), _table(body, [46 * mm, 22 * mm, 20 * mm, 20 * mm, 20 * mm, 22 * mm, 28 * mm])]
    if p.get("basis"):
        story += [Spacer(1, 1.5 * mm), Paragraph(_t(p["basis"]), s["small"])]
    return story


_IDENTITY_LABELS = (
    ("identities", "Identities"), ("assessed", "Permissions evaluated"),
    ("not_assessed", "Could not be evaluated"), ("admin", "Administrators"),
    ("standing_admin", "Standing (always-on) administrators"), ("privileged", "Privileged"),
    ("mfa_gaps", "Without MFA"), ("mfa_unknown", "MFA state unknown"),
    ("external", "External / guest"), ("stale_credentials", "Stale credentials"),
    ("dormant_90_days", "Unused for 90+ days (where last use is known)"),
    ("high_blast_radius", "High blast radius"),
)


def _identity_block(idn: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = [Paragraph("Identity and Access", s["h2"])]
    if idn.get("status") == "unavailable":
        return story + [Paragraph(_t(idn.get("error")), s["warn"])]
    if idn.get("note"):
        story.append(Paragraph(_t(idn["note"]), s["warn" if idn.get("status") == "no_data" else "small"]))
    counts = idn.get("counts") or {}
    if counts.get("identities"):
        rows = [(label, "-" if counts.get(k) is None else str(counts[k])) for k, label in _IDENTITY_LABELS]
        story += [Spacer(1, 2 * mm), _kv_table(rows, s, header=("Measure", "Identities"))]
    top = idn.get("top_identities") or []
    if top:
        body = [[Paragraph(h, s["th"]) for h in ("Identity", "Blast radius", "Resources", "Sensitive",
                                                 "High-impact capabilities")]]
        for t in top:
            body.append([_p(t["identity"], s), _p(t["blast_radius_score"], s, "cell_right"),
                         _p(t["direct_resources"], s, "cell_right"), _p(t["sensitive_resources"], s, "cell_right"),
                         _p(t["high_impact_capabilities"], s)])
        story += [Paragraph("Widest blast radius", s["h3"]),
                  _table(body, [56 * mm, 22 * mm, 22 * mm, 20 * mm, 58 * mm])]
    return story


def _activity_block(a: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = [Paragraph("Account Activity in the Period", s["h2"])]
    if a.get("status") == "unavailable":
        return story + [Paragraph(_t(a.get("error")), s["warn"])]
    if a.get("basis"):
        story.append(Paragraph(_t(a["basis"]), s["small"]))
    if a.get("note"):
        story.append(Paragraph(_t(a["note"]), s["warn"]))
    rows = [(label, "-" if a.get(k) is None else str(a[k])) for k, label in (
        ("total_events", "Audit events"), ("failed_events", "Failed"), ("denied_events", "Denied"),
        ("administrative_changes", "Administrative changes"), ("delete_operations", "Deletions"),
        ("critical_events", "Critical-risk events"), ("high_risk_events", "High-risk events"),
        ("distinct_actors", "Distinct actors"))]
    story += [Spacer(1, 2 * mm), _kv_table(rows, s, header=("Measure", "Count"))]
    cats = a.get("top_categories") or []
    if cats:
        story.append(KeepTogether([
            Paragraph("Events by category", s["h3"]),
            _bar_chart([(c["category"] or "-", float(c["events"]), SERIES_HUE, str(c["events"]))
                        for c in cats])]))
    actors = a.get("top_actors") or []
    if actors:
        body = [[Paragraph(h, s["th"]) for h in ("Actor", "Type", "Events", "High-risk", "Failed")]]
        for x in actors:
            body.append([_p(x["actor"], s), _p(x["type"], s), _p(x["events"], s, "cell_right"),
                         _p(x["high_risk"], s, "cell_right"), _p(x["failed"], s, "cell_right")])
        story += [Paragraph("Most active actors", s["h3"]),
                  _table(body, [70 * mm, 34 * mm, 24 * mm, 26 * mm, 24 * mm])]
    return story


def _cost_summary_block(cs: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = [Paragraph("Account Spend in the Reporting Period", s["h2"])]
    if cs.get("status") == "unavailable":
        return story + [Paragraph(_t(cs.get("error")), s["warn"])]
    if cs.get("basis"):
        story.append(Paragraph(_t(cs["basis"]), s["small"]))
    spend = cs.get("spend_by_currency") or {}
    if spend:
        story.append(Spacer(1, 2 * mm))
        story.append(_kv_table([(f"Total ({c})", f"{_money(v['amount'], c)} over {v['days_billed']} billed day(s)")
                                for c, v in spend.items()], s, header=("Currency", "Spend")))
    services = cs.get("top_services") or []
    if services:
        # The exact amount is printed on every bar, so the chart is also the
        # table -- printing both would say the same numbers twice.
        story.append(KeepTogether([Paragraph("Top services by spend", s["h3"])]
                                  + _spend_chart(services, "service")))
    if cs.get("gap_note"):
        story += [Spacer(1, 2 * mm), Paragraph(_t(cs["gap_note"]), s["warn"])]
    return story


def _data_quality_block(dataset: Dict[str, Any], quality: Dict[str, Any], s) -> List[Any]:
    story: List[Any] = [PageBreak(), Paragraph("Data Quality and Coverage", s["h2"])]
    for warning in quality.get("warnings") or []:
        story.append(Paragraph(_t(warning), s["warn"]))
    coverage = quality.get("coverage") or {}
    if coverage:
        body = [[Paragraph(h, s["th"]) for h in ("Section", "Checked", "With data", "Nothing to report", "Status")]]
        for label, cov in coverage.items():
            body.append([Paragraph(_t(label), s["cell"]),
                         _p(cov.get("resources_checked"), s, "cell_right"),
                         _p(cov.get("resources_with_data"), s, "cell_right"),
                         _p(cov.get("resources_without_data"), s, "cell_right"),
                         _p("Could not be read: " + str(cov.get("error")) if cov.get("status") == "unavailable"
                            else "OK", s)])
        story += [Spacer(1, 2 * mm), _table(body, [52 * mm, 22 * mm, 22 * mm, 30 * mm, 52 * mm])]
    rows = [("Resources not found", str(quality.get("resources_not_found", 0))),
            ("Unavailable sections", ", ".join(quality.get("unavailable_sections") or []) or "None")]
    fresh = quality.get("freshness") or {}
    rows += [
        ("Last refreshed", _when(fresh.get("last_refreshed_at"))),
        ("Refresh status", str(fresh.get("refresh_status") or "-")),
        ("Scopes read", f"{fresh['scopes_read']} of {fresh['scopes_attempted']}"
         if fresh.get("scopes_attempted") else "Not reported by this provider"),
        ("Security assessed", _when(fresh.get("security_assessed_at"))),
        ("Resource intelligence analysed", _when(fresh.get("intelligence_analysed_at"))),
        ("Per-resource cost fetched", _when(fresh.get("resource_costs_fetched_at"))),
        ("Billing data through", str(fresh.get("billing_data_through") or "none stored")),
    ]
    story += [Spacer(1, 4 * mm), _kv_table(rows, s, header=("Measure", "Value"))]
    for note in quality.get("notes", []):
        story += [Spacer(1, 2 * mm), Paragraph(f"<i>{_t(note)}</i>", s["small"])]
    return story


def _without_block(section: str, dataset: Dict[str, Any], s) -> List[Any]:
    """Detailed level only: the resources a section had nothing to say about,
    and why. `apply_detail_level` empties these lists at the other levels."""
    entries = ((dataset.get("coverage") or {}).get(section) or {}).get("without") or []
    if not entries:
        return []
    body = [[Paragraph(h, s["th"]) for h in ("Resource", "Type", "Region", "Reason")]]
    for e in entries:
        body.append([_p(e.get("resource_name") or e.get("provider_resource_id"), s),
                     _p(e.get("resource_type"), s), _p(e.get("region"), s), _p(e.get("reason"), s)])
    return [Paragraph(_t(f"Nothing to report ({len(entries)})"), s["h3"]),
            _table(body, [52 * mm, 34 * mm, 28 * mm, 64 * mm])]


def build_pdf(dataset: Dict[str, Any], *, metadata: Optional[Dict[str, Any]] = None,
              detail_level: str = "standard") -> bytes:
    metadata = metadata or {}
    s = _styles()
    account = dataset["account"]
    layout = dataset.get("layout") or {}
    detailed = (layout.get("detail_level") or detail_level) == "detailed"
    group_by = layout.get("group_by")
    title = metadata.get("title") or f"Resource Assessment Report - {account['name']}"
    generated_at = datetime.utcnow().strftime("%d %b %Y %H:%M UTC")

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=20 * mm,
        bottomMargin=18 * mm, title=_t(title), author="Actmon",
        subject="Cloud resource assessment")
    story: List[Any] = [
        Spacer(1, 6 * mm),
        Paragraph(_t(title), s["h1"]),
    ]
    if metadata.get("subtitle"):
        story.append(Paragraph(_t(metadata["subtitle"]), s["lede"]))
    period = dataset.get("period") or {}
    scope_mode = (dataset.get("scope") or {}).get("mode")
    scope_text = {"account": "whole account", "filtered": "filtered subset",
                  "resources": "selected resources"}.get(scope_mode, scope_mode or "-")
    story += [
        Spacer(1, 2 * mm),
        Paragraph(_t(f"{account['provider']} account: {account['name']}. Scope: {scope_text}, "
                     f"{dataset['resources_resolved']} of {dataset['resources_requested']} "
                     f"resource(s) resolved. Generated {generated_at}."), s["small"]),
    ]
    if period:
        story.append(Paragraph(_t(f"Reporting period: {period.get('label')}, {period.get('start')} "
                                  f"to {period.get('end')} ({period.get('timezone')})."), s["small"]))
    if metadata.get("organization") or metadata.get("prepared_by") \
            or metadata.get("confidentiality") or metadata.get("reference"):
        bits = [x for x in (
            metadata.get("organization"),
            f"Prepared by {metadata['prepared_by']}" if metadata.get("prepared_by") else None,
            metadata.get("confidentiality"),
            f"Ref {metadata['reference']}" if metadata.get("reference") else None,
        ) if x]
        story.append(Paragraph(_t(" - ".join(bits)), s["small"]))
    story.append(Spacer(1, 3 * mm))
    story += _freshness_block(dataset, s)
    story.append(Spacer(1, 5 * mm))

    for note in dataset.get("notes", []):
        story.append(Paragraph(f"<i>{_t(note)}</i>", s["small"]))
    if dataset.get("notes"):
        story.append(Spacer(1, 4 * mm))

    sections = dataset["sections"]
    summary = sections.get("executive_summary")
    if summary:
        story.append(Paragraph("Executive Summary", s["h2"]))
        story.append(_kv_table(_summary_rows(summary), s))
        chart = _severity_chart(summary.get("security_findings_by_severity") or {})
        if chart is not None:
            story.append(KeepTogether([Paragraph("Open security findings by severity", s["h3"]), chart]))
        story += _top_lists(summary, s)
        story.append(Spacer(1, 6 * mm))

    for key, block in (("cost_summary", _cost_summary_block), ("posture", _posture_block),
                       ("identity", _identity_block), ("activity", _activity_block)):
        if isinstance(sections.get(key), dict):
            # Heading + its first element travel together, so a heading never
            # ends a page with its content on the next one.
            parts = block(sections[key], s)
            story += [KeepTogether(parts[:2])] + parts[2:]
            story.append(Spacer(1, 4 * mm))

    for section in _ROW_SECTIONS:
        rows = sections.get(section)
        if not isinstance(rows, list):
            continue
        label = _SECTION_LABELS.get(section, section.title())
        line = _coverage_line(section, dataset)
        if not rows:
            # An empty list only means "nothing found" when everything was
            # read; `line` says what was not, and wins when present.
            empty = {"certificates": "No certificate, secret or key is expired or expires within 30 days.",
                     "changes": "No configuration change was detected in the period."}.get(
                         section, "No data for this section.")
            story.append(KeepTogether([
                Paragraph(label, s["h2"]),
                Paragraph(_t(line or empty), s["small"]),
            ]))
            story += _without_block(section, dataset, s)
            story.append(Spacer(1, 4 * mm))
            continue
        # NOT wrapped in KeepTogether: a section can run to hundreds of
        # rows, and KeepTogether forces the whole block onto one page,
        # which raises reportlab.platypus.doctemplate.LayoutError the
        # moment a table is taller than a page -- exactly the case a
        # 200+ resource report hits. The heading can float to the next
        # page on its own; the table (repeatRows=1) splits normally.
        story.append(Paragraph(f"{label} ({len(rows)})", s["h2"]))
        if line:
            story.append(Paragraph(_t(line), s["small"]))
            story.append(Spacer(1, 2 * mm))
        for value, group_rows in _groups(rows, group_by):
            if group_by and any(group_by in r for r in rows):
                story.append(Paragraph(_t(f"{_GROUP_LABELS.get(group_by, group_by)}: "
                                          f"{value or 'Not set'} ({len(group_rows)})"), s["h3"]))
            story.append(_rows_table(section, group_rows, s, detailed))
        story += _without_block(section, dataset, s)
        story.append(Spacer(1, 4 * mm))

    quality = sections.get("data_quality")
    if quality:
        story += _data_quality_block(dataset, quality, s)

    doc.build(story, canvasmaker=_decorations(title, generated_at))
    return buf.getvalue()
