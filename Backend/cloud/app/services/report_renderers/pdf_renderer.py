"""PDF rendering: dataset in, bytes out. Same ReportLab approach as
`client_report_pdf.py` (standard fonts only, cp1252-safe `_t()`, a numbered
header/footer canvas) so a report generated here looks like it belongs next
to the monthly client report, not like a second product.

`detail_level` controls actual content, not just the title: "executive"
shows the summary and nothing else; "standard" and above show every
enabled section's full row table.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Dict, List, Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
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

SEV_COLOR = {"CRITICAL": DANGER, "HIGH": DANGER, "MEDIUM": WARN, "LOW": MUTED, "INFO": MUTED}

_FOLD = {"->": "->", "→": "->", "←": "<-", "≤": "<=", "≥": ">=",
         "≠": "!=", "✓": "yes", "✗": "no"}

_SECTION_LABELS = {
    "inventory": "Resource Inventory", "security": "Security Assessment",
    "utilization": "Resource Utilization", "performance": "Performance Analysis",
    "recommendations": "Recommendations", "cost": "Cost", "anomalies": "Detected Anomalies",
}


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
        "h1": ParagraphStyle("h1", parent=body, fontName="Helvetica-Bold", fontSize=22,
                             leading=26, textColor=INK, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=body, fontName="Helvetica-Bold", fontSize=13,
                             leading=16, textColor=INK, spaceBefore=10, spaceAfter=6),
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


def _row_table(rows: List[Dict[str, Any]], s: Dict[str, ParagraphStyle]) -> Table:
    header = ["Resource", "Title", "Severity", "Detail", "Status", "Detected At"]
    body = [[Paragraph(h, s["cell"]) for h in header]]
    for row in rows:
        body.append([
            Paragraph(_t(_clip(str(row.get("resource_name") or row.get("provider_resource_id") or "-"))), s["cell"]),
            Paragraph(_t(_clip(str(row.get("title") or "-"))), s["cell"]),
            _severity_cell(row.get("severity"), s),
            Paragraph(_t(_clip(str(row.get("detail") or row.get("metric_value") or "-"))), s["cell"]),
            Paragraph(_t(row.get("status") or "-"), s["cell"]),
            Paragraph(_t(row.get("detected_at") or "-"), s["small"]),
        ])
    widths = [32 * mm, 38 * mm, 18 * mm, 55 * mm, 20 * mm, 24 * mm]
    return _table(body, widths)


def build_pdf(dataset: Dict[str, Any], *, metadata: Optional[Dict[str, Any]] = None,
              detail_level: str = "standard") -> bytes:
    metadata = metadata or {}
    s = _styles()
    account = dataset["account"]
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
    story += [
        Spacer(1, 2 * mm),
        Paragraph(_t(f"{account['provider']} account: {account['name']}. "
                     f"{dataset['resources_resolved']} of {dataset['resources_requested']} "
                     f"resource(s) resolved. Generated {generated_at}."), s["small"]),
    ]
    if metadata.get("prepared_by") or metadata.get("confidentiality") or metadata.get("reference"):
        bits = [x for x in (
            f"Prepared by {metadata['prepared_by']}" if metadata.get("prepared_by") else None,
            metadata.get("confidentiality"),
            f"Ref {metadata['reference']}" if metadata.get("reference") else None,
        ) if x]
        story.append(Paragraph(_t(" - ".join(bits)), s["small"]))
    story.append(Spacer(1, 6 * mm))

    for note in dataset.get("notes", []):
        story.append(Paragraph(f"<i>{_t(note)}</i>", s["small"]))
    if dataset.get("notes"):
        story.append(Spacer(1, 4 * mm))

    summary = dataset["sections"].get("executive_summary")
    if summary:
        story.append(Paragraph("Executive Summary", s["h2"]))
        rows = [["Resources in scope", str(summary["resources_in_scope"])],
                ["Critical/High findings", str(summary["critical_or_high"])]]
        for sev, count in sorted(summary.get("security_findings_by_severity", {}).items()):
            rows.append([f"  {sev}", str(count)])
        story.append(_table([["Metric", "Value"]] + rows, [90 * mm, 90 * mm]))
        story.append(Spacer(1, 6 * mm))

    if detail_level != "executive":
        for section, rows in dataset["sections"].items():
            if section in ("executive_summary", "data_quality") or not isinstance(rows, list):
                continue
            label = _SECTION_LABELS.get(section, section.title())
            if not rows:
                story.append(KeepTogether([
                    Paragraph(label, s["h2"]),
                    Paragraph("No data for this section.", s["small"]),
                ]))
            else:
                # NOT wrapped in KeepTogether: a section can run to hundreds of
                # rows, and KeepTogether forces the whole block onto one page,
                # which raises reportlab.platypus.doctemplate.LayoutError the
                # moment a table is taller than a page -- exactly the case a
                # 200+ resource report hits. The heading can float to the next
                # page on its own; the table (repeatRows=1) splits normally.
                story.append(Paragraph(label, s["h2"]))
                story.append(_row_table(rows, s))
            story.append(Spacer(1, 4 * mm))

    quality = dataset["sections"].get("data_quality")
    if quality:
        story.append(PageBreak())
        story.append(Paragraph("Data Quality and Assessment Coverage", s["h2"]))
        rows = [["Available", str(quality["available"])],
                ["Unavailable (error)", str(quality["unavailable"])],
                ["No data / not checked", str(quality["no_data"])],
                ["Resources not found", str(quality["resources_not_found"])]]
        story.append(_table([["Measure", "Count"]] + rows, [90 * mm, 90 * mm]))
        for note in quality.get("notes", []):
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(f"<i>{_t(note)}</i>", s["small"]))

    doc.build(story, canvasmaker=_decorations(title, generated_at))
    return buf.getvalue()
