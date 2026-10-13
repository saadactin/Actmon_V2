"""Render a client report's data as a PDF. Pure: data in, bytes out.

Built with ReportLab's standard fonts so it renders identically on Windows and
on the Linux servers this product is installed on, with no font files to ship.
The cost of that is the character set (Windows-1252), which is why money is
printed with its ISO code ("INR 1,23,456.00") rather than a symbol the font
does not have, and why every string passes through `_t()`.
"""
from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

from app.services.client_report_service import fmt_money

INK = colors.HexColor("#0e2a47")
TEXT = colors.HexColor("#2c4257")
MUTED = colors.HexColor("#64798d")
LINE = colors.HexColor("#d7e4ee")
SOFT = colors.HexColor("#f2f6fa")
ACCENT = colors.HexColor("#1e6fb8")
DANGER = colors.HexColor("#b42318")
WARN = colors.HexColor("#b54708")
OK = colors.HexColor("#067647")

SEV_COLOR = {"CRITICAL": DANGER, "HIGH": DANGER, "MEDIUM": WARN, "LOW": MUTED, "INFO": MUTED}


def _hex(colour) -> str:
    """'#rrggbb' for Paragraph <font color> — ReportLab's own hexval() is 0x-form."""
    return "#" + colour.hexval()[2:]


# Characters the standard fonts (cp1252) cannot draw but the data does use —
# finding titles say "principal → Owner". Without a fallback they print as "?".
_FOLD = {"→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
         "≤": "<=", "≥": ">=", "≠": "!=", "−": "-", "‑": "-",
         "✓": "yes", "✔": "yes", "✗": "no", "✘": "no",
         "₹": "INR "}


def _t(value: Any) -> str:
    """Escape for Paragraph markup and fold to the fonts' character set."""
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
        "small": ParagraphStyle("small", parent=body, fontSize=7.8, leading=10.5,
                                textColor=MUTED),
        "cell": ParagraphStyle("cell", parent=body, fontSize=8.2, leading=10.5),
        "cellb": ParagraphStyle("cellb", parent=body, fontSize=8.2, leading=10.5,
                                fontName="Helvetica-Bold", textColor=INK),
        "h1": ParagraphStyle("h1", parent=body, fontName="Helvetica-Bold", fontSize=22,
                             leading=26, textColor=INK, spaceAfter=4),
        "h2": ParagraphStyle("h2", parent=body, fontName="Helvetica-Bold", fontSize=13,
                             leading=16, textColor=INK, spaceBefore=10, spaceAfter=6),
        "h3": ParagraphStyle("h3", parent=body, fontName="Helvetica-Bold", fontSize=10,
                             leading=13, textColor=INK, spaceBefore=6, spaceAfter=3),
        "lede": ParagraphStyle("lede", parent=body, fontSize=11, leading=15,
                               textColor=MUTED, alignment=TA_LEFT),
    }


def _table(rows: List[List[Any]], widths: Sequence[float], *, header: bool = True,
           zebra: bool = True) -> Table:
    t = Table(rows, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    style = [
        ("FONT", (0, 0), (-1, -1), "Helvetica", 8.2),
        ("TEXTCOLOR", (0, 0), (-1, -1), TEXT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), INK),
                  ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                  ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8)]
    if zebra:
        for i in range(1 if header else 0, len(rows)):
            if i % 2 == 0:
                style.append(("BACKGROUND", (0, i), (-1, i), SOFT))
    t.setStyle(TableStyle(style))
    return t


def _money_list(values: Dict[str, float]) -> str:
    if not values:
        return "NA"
    return "<br/>".join(_t(fmt_money(v, k)) for k, v in sorted(values.items()))


def _change_text(change: Dict[str, Any]) -> str:
    if not change:
        return "NA"
    out = []
    for code, ch in sorted(change.items()):
        pct = ch.get("percent")
        if pct is None:
            out.append(f"{code}: {ch.get('label') or 'NA'}")
        else:
            out.append(f"{code}: {'+' if pct > 0 else ''}{pct:.1f}%")
    return "<br/>".join(_t(x) for x in out)


def _spend_glance(totals: Dict[str, Any]) -> str:
    """The headline spend: per-currency totals, the like-for-like change with
    how many accounts it covers, and every account it had to leave out."""
    lines = [_money_list(totals.get("spend") or {})]
    change = totals.get("spend_change") or {}
    basis = totals.get("spend_change_basis") or {}
    if change:
        parts = []
        for code, ch in sorted(change.items()):
            pct = ch.get("percent")
            value = f"{'+' if pct > 0 else ''}{pct:.1f}%" if pct is not None \
                else (ch.get("label") or "NA")
            b = basis.get(code) or {}
            counted = len(b.get("included") or [])
            of = counted + len(b.get("excluded") or [])
            parts.append(f"{code}: {value}" + (f" ({counted} of {of} account(s))" if b else ""))
        lines.append(f"<font color='{_hex(MUTED)}'>{_t('vs previous month, like for like: ' + '; '.join(parts))}</font>")
    left_out = list(dict.fromkeys(
        f"{e['account']} ({e['reason']})"
        for b in basis.values() for e in (b.get("excluded") or [])))
    if left_out:
        lines.append(f"<font color='{_hex(MUTED)}'>{_t('Not compared: ' + '; '.join(left_out))}</font>")
    partial = totals.get("spend_incomplete") or []
    if partial:
        text = "Incomplete billing: " + "; ".join(
            f"{p['account']} ({p['days_covered']} of {p['days_in_period']} days)" for p in partial)
        lines.append(f"<font color='{_hex(WARN)}'>{_t(text)}</font>")
    return "<br/>".join(lines)


def _catalog_assessed(row: Dict[str, Any]) -> str:
    """"5 of 9 (2 n/a)": assessed of the controls that APPLY. Counting
    not-applicable controls in the denominator made "5 of 11" disagree with
    the 55.6% the Security Center prints for the same framework."""
    if "not_evaluated" not in row:        # a report stored before the split
        return f"{row['assessed']} of {row['declared']}"
    applicable = row["assessed"] + row["not_evaluated"]
    na = row.get("not_applicable") or 0
    return f"{row['assessed']} of {applicable}" + (f" ({na} n/a)" if na else "")


def _in_use(value: Optional[bool]) -> str:
    return "Yes" if value is True else "No" if value is False else "Unknown"


def _when(iso: Optional[str], fmt: str = "%d %b %Y") -> str:
    if not iso:
        return "never"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime(fmt)
    except ValueError:
        return iso


def _posture(sec: Optional[Dict[str, Any]]) -> str:
    if not sec:
        return "Not assessed"
    if sec.get("score") is None:
        return _t(sec.get("grade") or "Score withheld")
    mark = "" if sec.get("score_reliable") else " (low coverage)"
    return _t(f"{sec['score']}/100, grade {sec.get('grade')}{mark}")


def _decorations(data: Dict[str, Any]):
    client = data["client"]["name"]
    period = data["period_label"]
    generated = _when(data["generated_at"], "%d %b %Y %H:%M UTC")

    class NumberedCanvas(rl_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._pages: List[Dict[str, Any]] = []

        def showPage(self):  # noqa: N802 — ReportLab's name
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
            self.drawString(16 * mm, h - 11 * mm, _t(f"ACTMON  |  {client}"))
            self.setFont("Helvetica", 7.5)
            self.setFillColor(MUTED)
            self.drawRightString(w - 16 * mm, h - 11 * mm, _t(f"Cloud report - {period}"))
            self.setStrokeColor(LINE)
            self.setLineWidth(0.5)
            self.line(16 * mm, 12 * mm, w - 16 * mm, 12 * mm)
            self.drawString(16 * mm, 8 * mm, _t(f"Generated by Actmon on {generated}"))
            self.drawRightString(w - 16 * mm, 8 * mm,
                                 f"Page {self._pageNumber} of {total}")
            self.restoreState()

    return NumberedCanvas


def render(data: Dict[str, Any]) -> bytes:
    s = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=20 * mm,
        bottomMargin=18 * mm, title=_t(f"{data['client']['name']} - cloud report "
                                        f"{data['period_label']}"),
        author="Actmon", subject="Monthly cloud report")
    width = A4[0] - 32 * mm
    sections = set(data.get("sections") or [])
    accounts: List[Dict[str, Any]] = data.get("accounts") or []
    totals = data.get("totals") or {}
    story: List[Any] = []

    # ── Cover and at-a-glance ───────────────────────────────────────────────
    story += [
        Spacer(1, 6 * mm),
        Paragraph("Cloud report", s["h1"]),
        Paragraph(_t(f"{data['client']['name']} - {data['period_label']}"), s["lede"]),
        Spacer(1, 2 * mm),
        Paragraph(_t(f"{len(accounts)} cloud account(s). Period {data['period_start']} to "
                     f"{data['period_end']} (end exclusive). Generated "
                     f"{_when(data['generated_at'], '%d %b %Y %H:%M UTC')}."), s["small"]),
        Spacer(1, 6 * mm),
    ]
    if not accounts:
        story.append(Paragraph("No cloud accounts are assigned to this client, so there is "
                               "nothing to report for the period.", s["body"]))
        doc.build(story, canvasmaker=_decorations(data))
        return buf.getvalue()

    f = totals.get("findings") or {}
    glance = [["", "For the period"]]
    if "cost" in sections:
        glance.append([Paragraph("Spend", s["cellb"]),
                       Paragraph(_spend_glance(totals), s["cell"])])
    if "security" in sections:
        glance.append([Paragraph("Open confirmed findings", s["cellb"]),
                       Paragraph(_t(f"{f.get('CRITICAL', 0)} critical, {f.get('HIGH', 0)} "
                                    f"high, {f.get('MEDIUM', 0)} medium, {f.get('LOW', 0)} "
                                    "low (at generation)"), s["cell"])])
    if "certificates" in sections:
        glance.append([Paragraph("Certificates and secrets", s["cellb"]),
                       Paragraph(_t(f"{totals.get('certificates', 0)} expired or expiring "
                                    "within 60 days (at generation)"), s["cell"])])
    if "changes" in sections:
        glance.append([Paragraph("Configuration changes", s["cellb"]),
                       Paragraph(_t(f"{totals.get('changes', 0)} recorded in the period"),
                                 s["cell"])])
    if "alerts" in sections:
        glance.append([Paragraph("Alerts", s["cellb"]),
                       Paragraph(_t(f"{totals.get('alerts_opened', 0)} opened, "
                                    f"{totals.get('alerts_resolved', 0)} resolved in the "
                                    "period"), s["cell"])])
    glance.append([Paragraph("Data gaps", s["cellb"]),
                   Paragraph(_t(f"{totals.get('accounts_with_gaps', 0)} of {len(accounts)} "
                                "account(s) have a gap listed at the end of this report"),
                             s["cell"])])
    story += [Paragraph("At a glance", s["h2"]), _table(glance, [48 * mm, width - 48 * mm])]

    rows = [["Account", "Cloud", "Environment", "Posture", "Spend"]]
    for a in accounts:
        rows.append([Paragraph(_t(a["account_name"]), s["cellb"]), _t(a["provider"]),
                     _t(a.get("environment")), Paragraph(_posture(a.get("security")),
                                                          s["cell"]),
                     Paragraph(_money_list((a.get("cost") or {}).get("period") or {}),
                               s["cell"])])
    story += [Paragraph("Accounts", s["h2"]),
              _table(rows, [52 * mm, 16 * mm, 24 * mm, 42 * mm, width - 134 * mm])]

    # ── Cost ────────────────────────────────────────────────────────────────
    if "cost" in sections:
        story += [PageBreak(), Paragraph("Spend", s["h2"]),
                  Paragraph("What each provider billed for the period, per currency. A "
                            "total is shown only within one currency; nothing is "
                            "converted.", s["small"]), Spacer(1, 2 * mm)]
        rows = [["Account", "Period", "Previous month", "Change", "Days billed"]]
        for a in accounts:
            c = a.get("cost") or {}
            rows.append([Paragraph(_t(a["account_name"]), s["cellb"]),
                         Paragraph(_money_list(c.get("period") or {}), s["cell"]),
                         Paragraph(_money_list(c.get("previous") or {}), s["cell"]),
                         Paragraph(_change_text(c.get("change") or {}), s["cell"]),
                         _t(f"{c.get('days_covered', 0)} of {c.get('days_in_period', 0)}")])
        story.append(_table(rows, [50 * mm, 34 * mm, 34 * mm, 30 * mm, width - 148 * mm]))
        for a in accounts:
            services = (a.get("cost") or {}).get("top_services") or []
            if not services:
                continue
            svc_rows = [["Largest services", "Spend"]] + [
                [Paragraph(_t(x["service"]), s["cell"]),
                 _t(fmt_money(x["amount"], x["currency"]))] for x in services]
            story.append(KeepTogether([
                Paragraph(_t(a["account_name"]), s["h3"]),
                _table(svc_rows, [width - 50 * mm, 50 * mm])]))

    # ── Security ────────────────────────────────────────────────────────────
    if "security" in sections:
        story += [PageBreak(), Paragraph("Security posture", s["h2"]),
                  Paragraph("Posture is the assessment published closest to the end of the "
                            "period. Findings are those open and confirmed when this report "
                            "was generated.", s["small"]), Spacer(1, 2 * mm)]
        rows = [["Account", "Posture", "Coverage", "Critical", "High", "Medium", "Low"]]
        for a in accounts:
            sec = a.get("security") or {}
            fnd = a.get("findings") or {}
            rows.append([Paragraph(_t(a["account_name"]), s["cellb"]),
                         Paragraph(_posture(a.get("security")), s["cell"]),
                         _t(f"{sec['coverage_pct']:.0f}%" if sec.get("coverage_pct")
                            is not None else "NA"),
                         str(fnd.get("CRITICAL", 0)), str(fnd.get("HIGH", 0)),
                         str(fnd.get("MEDIUM", 0)), str(fnd.get("LOW", 0))])
        story.append(_table(rows, [50 * mm, 46 * mm, 20 * mm] + [(width - 116 * mm) / 4] * 4))
        for a in accounts:
            top = a.get("top_findings") or []
            if not top:
                continue
            trows = [["Severity", "Finding", "Resource"]]
            for x in top:
                trows.append([Paragraph(f"<font color='{_hex(SEV_COLOR.get(x['severity'], MUTED))}'>"
                                        f"<b>{_t(x['severity'])}</b></font>", s["cell"]),
                              Paragraph(_t(x["title"]), s["cell"]),
                              Paragraph(_t(x["resource"]
                                           + (f" (+{x['affected'] - 1} more)"
                                              if (x.get("affected") or 1) > 1 else "")),
                                        s["cell"])])
            story.append(KeepTogether([Paragraph(_t(f"{a['account_name']} - most severe open "
                                                    "findings"), s["h3"]),
                                       _table(trows, [20 * mm, width - 80 * mm, 60 * mm])]))

    # ── Compliance ──────────────────────────────────────────────────────────
    if "compliance" in sections:
        story += [PageBreak(), Paragraph("Compliance cross-walk", s["h2"]),
                  Paragraph("Controls assessed from cloud configuration evidence. 'Pass rate' "
                            "is the share of ASSESSED controls that passed; 'catalog "
                            "assessed' is how many of the controls that apply could be "
                            "assessed at all (controls that do not apply are counted "
                            "separately). Neither is a certification.", s["small"]),
                  Spacer(1, 2 * mm)]
        for a in accounts:
            comp = a.get("compliance")
            if comp is None:
                continue
            crows = [["Framework", "Passed", "Failed", "Partial / no evidence", "Pass rate",
                      "Catalog assessed"]]
            for x in comp:
                crows.append([Paragraph(_t(x.get("label") or x["framework"]), s["cellb"]),
                              str(x["passed"]), str(x["failed"]),
                              str(x["partial"] + x["unknown"]),
                              _t(f"{x['pass_rate']:.0f}%" if x.get("pass_rate") is not None
                                 else "None assessed"),
                              _t(_catalog_assessed(x))])
            story.append(KeepTogether([
                Paragraph(_t(a["account_name"]), s["h3"]),
                _table(crows, [44 * mm, 18 * mm, 18 * mm, 36 * mm, 24 * mm,
                               width - 140 * mm])]))

    # ── Certificates ────────────────────────────────────────────────────────
    if "certificates" in sections:
        story += [Paragraph("Certificates, secrets and keys", s["h2"]),
                  Paragraph("Expired, or expiring within 60 days, when this report was "
                            "generated. Read from each provider's own stores; secret values "
                            "are never read.", s["small"]), Spacer(1, 2 * mm)]
        # "In use" matters most to whoever reads this: an expired certificate
        # still bound to a listener is an outage, one nobody uses is clutter.
        # Unknown (the store does not say, or its usage was not collected yet)
        # is printed as Unknown — never folded into either.
        crows = [["Account", "Name", "Type", "Store", "Expires", "In use", "Days"]]
        for a in accounts:
            for c in a.get("certificates") or []:
                days = c.get("days_left")
                colour = DANGER if days is not None and days < 0 else \
                    WARN if days is not None and days <= 7 else TEXT
                crows.append([Paragraph(_t(a["account_name"]), s["cell"]),
                              Paragraph(_t(c["name"]), s["cell"]),
                              _t(str(c["kind"]).title()),
                              Paragraph(_t(c.get("container") or c.get("region") or ""),
                                        s["cell"]),
                              _t(_when(c["expires_at"])),
                              _t(_in_use(c.get("in_use"))),
                              Paragraph(f"<font color='{_hex(colour)}'><b>"
                                        f"{_t('expired' if days is not None and days < 0 else int(days or 0))}"
                                        "</b></font>", s["cell"])])
        if len(crows) == 1:
            story.append(Paragraph("None expired or expiring within 60 days in the stores "
                                   "that could be read (see Data gaps for any that could "
                                   "not).", s["body"]))
        else:
            story.append(_table(crows, [32 * mm, width - 144 * mm, 20 * mm, 34 * mm,
                                        22 * mm, 18 * mm, 18 * mm]))

    # ── Changes and alerts ──────────────────────────────────────────────────
    if "changes" in sections or "alerts" in sections:
        story += [Paragraph("Changes and alerts in the period", s["h2"])]
        rows = [["Account", "Changes", "Changes by severity", "Alerts opened",
                 "Alerts resolved"]]
        for a in accounts:
            ch = a.get("changes") or {}
            al = a.get("alerts") or {}
            sev = ", ".join(f"{k.title()} {v}" for k, v in sorted(
                (ch.get("by_severity") or {}).items())) or "-"
            rows.append([Paragraph(_t(a["account_name"]), s["cellb"]),
                         str(ch.get("total", 0)), Paragraph(_t(sev), s["cell"]),
                         str(al.get("opened", 0)), str(al.get("resolved", 0))])
        story.append(_table(rows, [50 * mm, 30 * mm, width - 130 * mm, 25 * mm, 25 * mm]))

    # ── Data gaps and notes ─────────────────────────────────────────────────
    story += [Paragraph("Data gaps", s["h2"]),
              Paragraph("Anything that could make a figure in this report incomplete or "
                        "out of date.", s["small"]), Spacer(1, 2 * mm)]
    any_gap = False
    for a in accounts:
        gaps = a.get("gaps") or []
        if not gaps:
            continue
        any_gap = True
        items = "".join(f"&bull; {_t(g)}<br/>" for g in gaps)
        story.append(KeepTogether([Paragraph(_t(a["account_name"]), s["h3"]),
                                   Paragraph(items, s["body"])]))
    if not any_gap:
        story.append(Paragraph("No gaps were detected for any account in this period.",
                               s["body"]))
    story += [Spacer(1, 4 * mm), Paragraph("Notes", s["h3"])]
    for note in data.get("notes") or []:
        story.append(Paragraph(f"&bull; {_t(note)}", s["small"]))

    doc.build(story, canvasmaker=_decorations(data))
    return buf.getvalue()
