"""Render a compliance audit pack as an Excel workbook. Pure: pack in, bytes out.

The auditor's working papers. Where the PDF summarises (twenty evidence rows
per control, then "N more"), the workbook holds everything, one row per
fact, so it can be filtered, pivoted and sampled:

    Summary · Controls · Checks · Evidence · Exceptions · Remediation ·
    Not Evaluated · Not Applicable · Assessment · Method

Every sheet has a frozen header and an autofilter. Text that came from a
cloud provider — resource names, tags, policy text — is written as a string
even when it starts with "=", so a resource named like a formula is shown,
never evaluated.
"""
from __future__ import annotations

import io
import json
from datetime import datetime
from typing import Any, Dict, Iterable, List, Sequence, Tuple

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

from app.security import controls as ctl

_HEADER_FONT = Font(bold=True, color="FFFFFF")
_HEADER_FILL = PatternFill(start_color="1E6FB8", end_color="1E6FB8", fill_type="solid")
_KEY_FONT = Font(bold=True, color="0E2A47")
_WRAP = Alignment(wrap_text=True, vertical="top")

_STATE_FILL = {
    ctl.FAIL: "FDE7E5", ctl.PARTIAL: "FEF0E1", ctl.UNKNOWN: "FEF0E1", ctl.PASS: "E3F4EA",
    ctl.NOT_APPLICABLE: "F2F6FA", ctl.NOT_EVALUATED: "F2F6FA",
}
_EXCEPTION_FILL = "FEF0E1"

_ROLE_LABEL = {"breaching": "Violation", "undetermined": "Could not determine",
               "exception": "Exception (suppressed / accepted)"}

# Excel caps a cell at 32,767 characters; raw evidence can exceed it.
_CELL_MAX = 32000


def _date(value: Any):
    if not isinstance(value, str):
        return value
    try:
        # Excel cells hold no tzinfo. Every timestamp in the pack is UTC, and
        # the column headers say so.
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return value


def _put(ws: Worksheet, row: int, col: int, value: Any):
    if isinstance(value, (list, tuple)):
        value = "; ".join(str(v) for v in value)
    elif isinstance(value, dict):
        value = json.dumps(value, sort_keys=True, ensure_ascii=False)
    if isinstance(value, str) and len(value) > _CELL_MAX:
        value = value[:_CELL_MAX] + " ... (truncated; see the JSON export)"
    cell = ws.cell(row=row, column=col, value=value)
    if isinstance(value, str) and value.startswith("="):
        # openpyxl reads a leading "=" as a formula. Provider text is data.
        cell.data_type = "s"
    if isinstance(value, datetime):
        cell.number_format = "yyyy-mm-dd hh:mm"
    return cell


def _sheet(wb: Workbook, title: str, columns: Sequence[Tuple[str, int]],
           rows: Iterable[Sequence[Any]], *, wrap: Sequence[int] = ()) -> Worksheet:
    ws = wb.create_sheet(title)
    for i, (label, width) in enumerate(columns, 1):
        c = ws.cell(row=1, column=i, value=label)
        c.font, c.fill = _HEADER_FONT, _HEADER_FILL
        ws.column_dimensions[get_column_letter(i)].width = width
    n = 1
    for n, values in enumerate(rows, 2):
        for i, v in enumerate(values, 1):
            cell = _put(ws, n, i, v)
            if i in wrap:
                cell.alignment = _WRAP
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{max(n, 1)}"
    return ws


def _fill_states(ws: Worksheet, state_col: int, exc_col: int = 0) -> None:
    for r in range(2, ws.max_row + 1):
        state = ws.cell(row=r, column=state_col).value
        colour = _STATE_FILL.get(state)
        if exc_col and ws.cell(row=r, column=exc_col).value == "Yes":
            colour = _EXCEPTION_FILL
        if colour:
            ws.cell(row=r, column=state_col).fill = PatternFill(
                start_color=colour, end_color=colour, fill_type="solid")


def _summary(wb: Workbook, pack: Dict[str, Any]) -> None:
    ws = wb.active
    ws.title = "Summary"
    acc, asm, integ, t = pack["account"], pack["assessment"], pack["integrity"], pack["totals"]
    facts: List[Tuple[str, Any]] = [
        ("Compliance audit pack", None),
        ("Account", acc.get("name")),
        ("Cloud provider", acc.get("provider")),
        ("Provider account / tenancy ID", acc.get("provider_account_id")),
        ("Client", acc.get("client")),
        ("Environment", acc.get("environment")),
        ("Scope", pack["scope"]["label"]),
        ("Inventory collected (UTC)", _date(asm.get("inventory_collected_at"))),
        ("Assessed (UTC)", _date(asm.get("assessed_at"))),
        ("Assessment outcome", asm.get("outcome")),
        ("Data coverage %", asm.get("coverage_pct")),
        ("Assessment stale", "Yes" if asm.get("assessment_stale") else "No"),
        ("Inventory stale", "Yes" if asm.get("inventory_stale") else "No"),
        ("Generated (UTC)", _date(pack["generated_at"])),
        ("Prepared by", pack.get("prepared_by")),
        ("Pack ID", integ["pack_id"]),
        ("Pack SHA-256", integ["sha256"]),
        ("Integrity scope", integ["scope"]),
        (None, None),
        ("Controls failed", t["failed"]),
        ("Controls partially failed", t["partial"]),
        ("Controls without evidence", t["unknown"]),
        ("Controls passed", t["passed"]),
        ("  of which passed only with exceptions", t["passed_with_exceptions"]),
        ("Controls not evaluated (manual evidence needed)", t["not_evaluated"]),
        ("Controls not applicable", t["not_applicable"]),
        ("Exceptions recorded", t["exceptions"]),
        ("  of which with no reason", t["exceptions_without_reason"]),
        ("Disclaimer", pack["methodology"][0]["text"]),
    ]
    ws.column_dimensions["A"].width = 46
    ws.column_dimensions["B"].width = 90
    for r, (k, v) in enumerate(facts, 1):
        if k is None:
            continue
        key = ws.cell(row=r, column=1, value=k)
        key.font = Font(bold=True, size=14, color="0E2A47") if r == 1 else _KEY_FONT
        cell = _put(ws, r, 2, v)
        cell.alignment = _WRAP

    start = len(facts) + 2
    head = ["Framework", "Full name", "Kind", "Pass rate %", "Coverage %", "Assessed",
            "Applicable", "Passed", "Failed", "Partial", "No evidence", "Not evaluated",
            "Not applicable", "Passed with exceptions", "Framework note"]
    for i, h in enumerate(head, 1):
        c = ws.cell(row=start, column=i, value=h)
        c.font, c.fill = _HEADER_FONT, _HEADER_FILL
    for r, fw in enumerate(pack["frameworks"], start + 1):
        sm = fw["summary"]
        for i, v in enumerate([fw["label"], fw.get("full_name"), fw.get("kind"),
                               sm["pass_rate"], sm["coverage"], sm["assessed"],
                               sm["applicable"], sm["passed"], sm["failed"], sm["partial"],
                               sm["unknown"], sm["not_evaluated"], sm["not_applicable"],
                               sm["passed_with_exceptions"], fw.get("framework_note")], 1):
            _put(ws, r, i, v)


def render(pack: Dict[str, Any]) -> bytes:
    wb = Workbook()
    _summary(wb, pack)
    findings = pack["findings"]
    include_raw = pack["scope"].get("include_raw_evidence")

    # ── Controls ─────────────────────────────────────────────────────────────
    control_rows = []
    check_rows = []
    evidence_rows = []
    for fw in pack["frameworks"]:
        for c in fw["controls"]:
            totals = {k: sum(ch[k] for ch in c["checks"])
                      for k in ("evaluated", "conforming", "breaching", "advisory",
                                "undetermined", "exceptions")}
            control_rows.append([
                fw["label"], c["control_id"], c["title"], c["state"],
                "Yes" if c["passed_with_exceptions"] else "No",
                c.get("reason"), c["requirement"], "Yes" if c["strict"] else "No",
                len(c["checks"]), totals["evaluated"], totals["conforming"],
                totals["breaching"], totals["advisory"], totals["undetermined"],
                c["exception_count"], c.get("affected_resources"), c.get("worst_severity"),
                c.get("resource_types"),
            ])
            for ch in c["checks"]:
                check_rows.append([
                    fw["label"], c["control_id"], ch["rule_id"], ch["title"],
                    "Yes" if ch["ran"] else "No", ch["evaluated"], ch["conforming"],
                    ch["breaching"], ch["advisory"], ch["undetermined"], ch["exceptions"],
                    ch["not_applicable"],
                ])
            for role, fps in (("breaching", c["evidence"]["breaching"]),
                              ("undetermined", c["evidence"]["undetermined"]),
                              ("exception", c["evidence"]["exceptions"])):
                for fp in fps:
                    f = findings[fp]
                    row = [
                        fw["label"], c["control_id"], _ROLE_LABEL[role], f["severity"],
                        f["title"], f["resource_name"], f["resource_type"], f["region"],
                        f["resource_key"], f["affected_count"], f["status_label"],
                        f.get("assigned_to"), _date(f.get("first_detected_at")),
                        _date(f.get("last_detected_at")), f.get("detection_count"),
                        f.get("status_reason"), f.get("status_changed_by"),
                        _date(f.get("status_changed_at")), f["rule_id"], f["rule_version"],
                        f["description"], f["remediation"], fp,
                    ]
                    if include_raw:
                        row.append(f.get("evidence"))
                    evidence_rows.append(row)

    ws = _sheet(wb, "Controls", [
        ("Framework", 14), ("Control", 14), ("Title", 40), ("State", 16),
        ("Passed only with exceptions", 14), ("Why this state", 60), ("Requirement", 60),
        ("Benchmark (strict)", 10), ("Checks", 8), ("Evaluated", 10), ("Conforming", 11),
        ("Breaching", 10), ("Advisory", 10), ("Undetermined", 12), ("Exceptions", 11),
        ("Affected resources", 11), ("Worst severity", 12), ("Resource types", 24),
    ], control_rows, wrap=(3, 6, 7))
    _fill_states(ws, 4, exc_col=5)

    _sheet(wb, "Checks", [
        ("Framework", 14), ("Control", 14), ("Rule ID", 34), ("Check", 46), ("Ran", 6),
        ("Evaluated", 10), ("Conforming", 11), ("Breaching", 10), ("Advisory", 10),
        ("Undetermined", 12), ("Exceptions", 11), ("Not applicable", 12),
    ], check_rows, wrap=(4,))

    ev_cols = [
        ("Framework", 14), ("Control", 14), ("Role", 18), ("Severity", 10),
        ("Finding", 46), ("Resource", 30), ("Resource type", 22), ("Region", 16),
        ("Provider resource ID", 50), ("Affected count", 9), ("Status", 14),
        ("Assigned to", 18), ("First detected (UTC)", 17), ("Last detected (UTC)", 17),
        ("Detections", 10), ("Decision reason", 40), ("Decided by", 20),
        ("Decided at (UTC)", 17), ("Rule ID", 32), ("Rule version", 9),
        ("Description", 60), ("Remediation", 60), ("Fingerprint", 20),
    ]
    if include_raw:
        ev_cols.append(("Raw provider evidence (JSON)", 60))
    _sheet(wb, "Evidence", ev_cols, evidence_rows, wrap=(5, 16, 21, 22))

    _sheet(wb, "Exceptions", [
        ("Severity", 10), ("Finding", 46), ("Resource", 30), ("Resource type", 22),
        ("Provider resource ID", 50), ("Decision", 16), ("Reason", 50),
        ("No reason recorded", 10), ("Decided by", 20), ("Decided at (UTC)", 17),
        ("Controls affected", 50), ("Fingerprint", 20),
    ], ([e["severity"], e["title"], e.get("resource_name"), e.get("resource_type"),
         e.get("resource_key"), e["status_label"], e.get("reason"),
         "Yes" if e["reason_missing"] else "No", e.get("decided_by"),
         _date(e.get("decided_at")), e["controls"], e["fingerprint"]]
        for e in pack["exceptions"]), wrap=(2, 7, 11))

    _sheet(wb, "Remediation", [
        ("Severity", 10), ("Rule ID", 34), ("Issue", 46), ("Findings", 9), ("Resources", 10),
        ("Controls it fails", 50), ("Fix", 80),
    ], ([p["severity"], p["rule_id"], p["title"], p["findings"], p["resources"],
         p["controls"], p.get("remediation")] for p in pack["remediation_priorities"]),
        wrap=(3, 6, 7))

    _sheet(wb, "Not Evaluated", [
        ("Framework", 14), ("Control", 14), ("Title", 46), ("Requirement", 80),
        ("Manual evidence reference", 40),
    ], ([c["framework_label"], c["control_id"], c["title"], c["requirement"], None]
        for c in pack["not_evaluated"]), wrap=(3, 4))

    _sheet(wb, "Not Applicable", [
        ("Framework", 14), ("Control", 14), ("Title", 46), ("Why", 80),
    ], ([c["framework_label"], c["control_id"], c["title"], c.get("reason")]
        for c in pack["not_applicable"]), wrap=(3, 4))

    asm = pack["assessment"]
    asm_rows: List[List[Any]] = [
        ["Assessed (UTC)", _date(asm.get("assessed_at"))],
        ["Outcome", asm.get("outcome")],
        ["Triggered by", asm.get("triggered_by")],
        ["Resources evaluated", asm.get("resources_evaluated")],
        ["Checks evaluated", asm.get("rules_evaluated")],
        ["Data coverage %", asm.get("coverage_pct")],
        ["Inventory collected (UTC)", _date(asm.get("inventory_collected_at"))],
    ]
    asm_rows += [[f"Coverage - {dim} %", pct]
                 for dim, pct in sorted((asm.get("coverage") or {}).items())]
    asm_rows += [["Could not be read", r] for r in asm.get("incomplete_reasons") or []]
    asm_rows.append(["Note", asm["note"]])
    _sheet(wb, "Assessment", [("Item", 34), ("Value", 100)], asm_rows, wrap=(2,))

    _sheet(wb, "Method", [("Topic", 40), ("Explanation", 120)],
           ([m["title"], m["text"]] for m in pack["methodology"]), wrap=(2,))

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
