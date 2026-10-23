"""The audit-ready compliance export: one evidence pack, four formats.

An auditor asked for "the compliance report" wants something specific, and
the Compliance tab is not it: a tab shows the state of each control, an audit
pack has to show *why* — what was checked, how many subjects each check
evaluated, which findings decided a failure, what could not be determined,
and which violations were set aside as accepted risks. This module builds
that pack once, as plain JSON-native data, and every format renders the same
pack:

* PDF  — the document a reviewer reads and signs (sign-off block included);
* XLSX — the working papers: every control, every evidence row, filterable;
* JSON — the same pack, machine-readable, for an evidence archive;
* ZIP  — all three plus SHA256SUMS.txt and a README, one download per audit.

Three properties are the point, and the tests pin each:

**It cannot disagree with the Compliance tab.** The control states are the
ones `compliance.build` resolved from the same findings and rule statistics
(`SecurityCenterService.compliance_dataset`), and the evidence comes from
`compliance.control_evidence`, which uses the same definition of a violation.

**Exceptions are never hidden.** A suppressed or accepted finding does not
count toward a control's state, so a control can read "passed" only because
its violation was accepted. Every such control is flagged
(`passed_with_exceptions`) and every exception is listed with who accepted
it, when, and why — and an exception with no recorded reason says so.

**It is tamper-evident.** The pack carries a SHA-256 over its own canonical
JSON (everything except the `integrity` block), printed on every PDF page
and on the workbook's Summary sheet. Anyone holding the JSON can recompute
it: `verify_pack()` is the reference implementation.

Nothing here claims certification. The wording is the Compliance tab's own:
"control passed" and "control failed", with each framework's caveat printed
next to its results.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.security import compliance as comp
from app.security import controls as ctl
from app.security import registry as reg
from app.security.model import (
    ACTIVE_FINDING_STATUSES, MUTED_FINDING_STATUSES, STATUS_LABEL, severity_rank,
    worst_severity,
)

PACK_SCHEMA = "actmon.compliance-audit-pack/1"

# format -> (media type, file extension)
FORMATS: Dict[str, Tuple[str, str]] = {
    "pdf": ("application/pdf", "pdf"),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
    "json": ("application/json", "json"),
    "zip": ("application/zip", "zip"),
}

# A PDF is read, not filtered: past this many evidence rows per control it
# says how many more there are and points at the workbook, which has them all.
PDF_EVIDENCE_ROWS = 20

INTEGRITY_SCOPE = (
    "SHA-256 of this pack without its 'integrity' block, serialised as JSON with "
    "keys sorted, separators (',', ':') and ASCII escaping — Python's "
    "json.dumps(pack, sort_keys=True, separators=(',', ':'), ensure_ascii=True), "
    "encoded as UTF-8."
)


# ═════════════════════════════════════════════════════════════════════════════
# Small helpers
# ═════════════════════════════════════════════════════════════════════════════


def _f(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        d = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).isoformat()
    return str(value)


def _plain(value: Any) -> Any:
    """Coerce provider payloads (raw evidence) to JSON-native values, so the
    pack hashes the same before and after a JSON round trip."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _age_seconds(iso: Optional[str], now: datetime) -> Optional[int]:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    return int((now - d).total_seconds())


def _rule_meta(rule_id: str) -> Dict[str, Optional[str]]:
    rule = reg.by_id(rule_id)
    if rule is None:
        # A rule retired since the finding was stored still has a finding
        # that names it; the export says the id rather than inventing a title.
        return {"title": rule_id, "description": None, "remediation": None,
                "severity": None}
    return {"title": rule.title, "description": rule.description,
            "remediation": rule.remediation, "severity": rule.severity}


def _check_applies(check: Dict[str, Any], provider: Optional[str]) -> bool:
    """Whether a check belongs in this account's evidence.

    Cross-cloud controls name every cloud's checks — SOC 2 CC6.1 cites the S3,
    RDS, Azure SQL and OCI bucket rules alike — and the other clouds' rules
    can never run on this account. Listing them as "did not run" under every
    control buried the checks that matter; a check that did run always stays.
    """
    if check.get("ran") or not provider:
        return True
    rule = reg.by_id(check["rule_id"])
    return rule is None or rule.provider in ("*", provider.upper())


def _reason_text(reason: Any) -> str:
    if isinstance(reason, dict):
        return str(reason.get("reason") or reason.get("message") or reason.get("detail")
                   or json.dumps(_plain(reason), sort_keys=True))
    return str(reason)


def slug(value: Optional[str], fallback: str = "account") -> str:
    out = re.sub(r"[^A-Za-z0-9._-]+", "-", value or "").strip("-.")[:60]
    return out or fallback


# ═════════════════════════════════════════════════════════════════════════════
# The pack — a pure function of the compliance dataset
# ═════════════════════════════════════════════════════════════════════════════


def _finding_row(f: Any, *, include_raw: bool) -> Dict[str, Any]:
    row = {
        "fingerprint": _f(f, "fingerprint"),
        "rule_id": _f(f, "rule_id"),
        "rule_version": _f(f, "rule_version"),
        "title": _f(f, "title"),
        "description": _f(f, "description"),
        "remediation": _f(f, "remediation"),
        "severity": (_f(f, "severity") or "").upper() or None,
        "category": _f(f, "category"),
        "verdict": _f(f, "verdict"),
        "confidence": _f(f, "confidence"),
        "status": _f(f, "status"),
        "status_label": STATUS_LABEL.get(_f(f, "status"), _f(f, "status")),
        "resource_name": _f(f, "resource_name"),
        "resource_type": _f(f, "resource_type"),
        # The provider's own id — what an auditor looks the resource up by.
        "resource_key": _f(f, "resource_key"),
        "region": _f(f, "region"),
        "affected_count": max(1, int(_f(f, "affected_count") or 1)),
        "first_detected_at": _iso(_f(f, "first_detected_at")),
        "last_detected_at": _iso(_f(f, "last_detected_at")),
        "detection_count": _f(f, "detection_count"),
        "assigned_to": _f(f, "assigned_to"),
        "status_reason": _f(f, "status_reason"),
        "status_changed_by": _f(f, "status_changed_by"),
        "status_changed_at": _iso(_f(f, "status_changed_at")),
        "controls": [],          # filled from the control evaluation below
    }
    if include_raw:
        row["evidence"] = _plain(_f(f, "evidence"))
    return row


def assemble_pack(
    *,
    account: Dict[str, Any],
    view: Dict[str, Any],
    findings: Sequence[Any],
    rule_stats: Dict[str, Dict[str, int]],
    assessment: Optional[Any],
    framework: Optional[str],
    generated_at: datetime,
    prepared_by: Optional[str],
    include_raw: bool = False,
    assessment_stale_after_s: Optional[float] = None,
    inventory_stale_after_s: Optional[float] = None,
) -> Dict[str, Any]:
    """Build the pack from what `SecurityCenterService.compliance_dataset`
    returns. Pure: no I/O, and `generated_at` is passed in so the same inputs
    produce the same pack (and the same hash)."""
    findings_by_rule: Dict[str, List[Any]] = {}
    for f in findings:
        findings_by_rule.setdefault(_f(f, "rule_id"), []).append(f)

    rows_by_key = {(r["framework"], r["control_id"]): r for r in view.get("controls") or []}
    fw_keys = [fw for fw in ctl.FRAMEWORKS if fw in (view.get("frameworks") or {})]

    registry: Dict[str, Dict[str, Any]] = {}

    def cite(f: Any, fw: str, control_id: str, role: str) -> str:
        fp = _f(f, "fingerprint")
        row = registry.get(fp)
        if row is None:
            row = registry[fp] = _finding_row(f, include_raw=include_raw)
        ref = {"framework": fw, "control_id": control_id, "role": role}
        if ref not in row["controls"]:
            row["controls"].append(ref)
        return fp

    frameworks_out: List[Dict[str, Any]] = []
    not_evaluated: List[Dict[str, Any]] = []
    not_applicable: List[Dict[str, Any]] = []
    rule_rollup: Dict[str, Dict[str, Any]] = {}

    for fw in fw_keys:
        summary = view["frameworks"][fw]
        controls_out: List[Dict[str, Any]] = []
        for control in ctl.BY_FRAMEWORK[fw]:
            row = rows_by_key.get((fw, control.control_id))
            if row is None:
                continue
            ev = comp.control_evidence(control, findings_by_rule, rule_stats)
            breaching = [cite(f, fw, control.control_id, "breaching") for f in ev["breaching"]]
            undetermined = [cite(f, fw, control.control_id, "undetermined")
                            for f in ev["undetermined"]]
            exceptions = [cite(f, fw, control.control_id, "exception") for f in ev["exceptions"]]

            for f in ev["breaching"]:
                rid = _f(f, "rule_id")
                agg = rule_rollup.setdefault(rid, {
                    "rule_id": rid, **{k: v for k, v in _rule_meta(rid).items()
                                       if k in ("title", "remediation")},
                    "severities": [], "fingerprints": set(), "controls": set(),
                })
                agg["severities"].append(_f(f, "severity"))
                agg["fingerprints"].add(_f(f, "fingerprint"))
                agg["controls"].add(f"{fw} {control.control_id}")
                if not agg.get("remediation"):
                    agg["remediation"] = _f(f, "remediation")

            entry = {
                "control_id": control.control_id,
                "title": control.title,
                "requirement": control.requirement,
                "state": row["state"],
                "state_label": row["state_label"],
                "state_meaning": row["state_meaning"],
                "reason": row.get("reason"),
                "strict": control.strict,
                "resource_types": list(control.resource_types),
                "worst_severity": row.get("worst_severity"),
                "affected_resources": row.get("affected_resources", 0),
                "checks": [{**c, "title": _rule_meta(c["rule_id"])["title"]}
                           for c in ev["checks"] if _check_applies(c, account.get("provider"))],
                "evidence": {"breaching": breaching, "undetermined": undetermined,
                             "exceptions": exceptions},
                "exception_count": len(exceptions),
                # The flag the whole exceptions design exists for: this control
                # reads "passed" only because a violation was set aside.
                "passed_with_exceptions": row["state"] == ctl.PASS and bool(exceptions),
            }
            controls_out.append(entry)
            if row["state"] == ctl.NOT_EVALUATED:
                not_evaluated.append({"framework": fw, "framework_label": summary.get("label"),
                                      "control_id": control.control_id,
                                      "title": control.title,
                                      "requirement": control.requirement})
            elif row["state"] == ctl.NOT_APPLICABLE:
                not_applicable.append({"framework": fw, "framework_label": summary.get("label"),
                                       "control_id": control.control_id,
                                       "title": control.title, "reason": row.get("reason")})

        assessed = summary.get("controls_assessed") or 0
        frameworks_out.append({
            "key": fw,
            "label": summary.get("label") or fw,
            "full_name": summary.get("full_name"),
            "kind": summary.get("kind"),
            "framework_note": summary.get("framework_note"),
            "summary": {
                "declared": summary.get("controls_declared"),
                "applicable": assessed + (summary.get("controls_not_evaluated") or 0),
                "assessed": assessed,
                "passed": summary.get("controls_passed"),
                "failed": summary.get("controls_failed"),
                "partial": summary.get("controls_partial"),
                "unknown": summary.get("controls_unknown"),
                "not_applicable": summary.get("controls_not_applicable"),
                "not_evaluated": summary.get("controls_not_evaluated"),
                "pass_rate": summary.get("control_pass_rate"),
                "coverage": summary.get("assessment_coverage"),
                "passed_with_exceptions": sum(1 for c in controls_out
                                              if c["passed_with_exceptions"]),
                "controls_with_exceptions": sum(1 for c in controls_out
                                                if c["exception_count"]),
                "by_severity": summary.get("by_severity"),
            },
            "controls": controls_out,
        })

    # ── Exceptions register ──────────────────────────────────────────────────
    exceptions_out = []
    for fp, row in registry.items():
        if row["status"] not in MUTED_FINDING_STATUSES:
            continue
        refs = sorted({f"{r['framework']} {r['control_id']}" for r in row["controls"]
                       if r["role"] == "exception"})
        if not refs:
            continue
        exceptions_out.append({
            "fingerprint": fp,
            "title": row["title"], "severity": row["severity"],
            "resource_name": row["resource_name"], "resource_type": row["resource_type"],
            "resource_key": row["resource_key"],
            "status": row["status"], "status_label": row["status_label"],
            "reason": row["status_reason"],
            # Accepting a risk without saying why is the first thing an auditor
            # flags; the pack flags it before they have to.
            "reason_missing": not (row["status_reason"] or "").strip(),
            "decided_by": row["status_changed_by"],
            "decided_at": row["status_changed_at"],
            "controls": refs,
        })
    exceptions_out.sort(key=lambda e: (severity_rank(e["severity"]), e["title"] or ""))

    # ── Remediation priorities: one row per rule, worst first ───────────────
    priorities = []
    for agg in rule_rollup.values():
        priorities.append({
            "rule_id": agg["rule_id"],
            "title": agg.get("title") or agg["rule_id"],
            "severity": worst_severity(agg["severities"]),
            "findings": len(agg["fingerprints"]),
            "resources": sum(registry[fp]["affected_count"] for fp in agg["fingerprints"]),
            "controls": sorted(agg["controls"]),
            "remediation": agg.get("remediation"),
        })
    priorities.sort(key=lambda p: (severity_rank(p["severity"]), -len(p["controls"]),
                                   -p["resources"], p["rule_id"]))

    # ── Assessment and freshness ─────────────────────────────────────────────
    assessed_at = _iso(_f(assessment, "finished_at")) if assessment is not None else None
    inventory_at = account.get("last_discovery")
    asm_age = _age_seconds(assessed_at, generated_at)
    inv_age = _age_seconds(inventory_at, generated_at)
    assessment_out = {
        "assessed_at": assessed_at,
        "outcome": _f(assessment, "outcome") if assessment is not None else None,
        "triggered_by": _f(assessment, "triggered_by") if assessment is not None else None,
        "coverage_pct": _f(assessment, "coverage_pct") if assessment is not None else None,
        "coverage": _plain(_f(assessment, "coverage")) if assessment is not None else None,
        "resources_evaluated": (_f(assessment, "resources_evaluated")
                                if assessment is not None else None),
        "rules_evaluated": (_f(assessment, "rules_evaluated")
                            if assessment is not None else None),
        "incomplete_reasons": [_reason_text(r) for r in
                               ((_f(assessment, "incomplete_reasons") or [])
                                if assessment is not None else [])],
        "inventory_collected_at": inventory_at,
        "assessment_age_seconds": asm_age,
        "inventory_age_seconds": inv_age,
        "assessment_stale": (asm_age is None or (assessment_stale_after_s is not None
                                                 and asm_age > assessment_stale_after_s)),
        "inventory_stale": (inv_age is None or (inventory_stale_after_s is not None
                                                and inv_age > inventory_stale_after_s)),
        "note": ("The assessment evaluates stored inventory; it does not re-contact the "
                 "provider. Findings can therefore be no fresher than the inventory they "
                 "were derived from, whatever the assessment timestamp says."),
    }

    all_controls = [c for fw in frameworks_out for c in fw["controls"]]
    pack: Dict[str, Any] = {
        "schema": PACK_SCHEMA,
        "generated_at": _iso(generated_at),
        "prepared_by": prepared_by,
        "account": account,
        "scope": {
            "framework": framework,
            "frameworks": fw_keys,
            "label": (frameworks_out[0]["label"] if framework and frameworks_out
                      else f"All applicable frameworks ({len(fw_keys)})"),
            "include_raw_evidence": include_raw,
        },
        "assessment": assessment_out,
        "totals": {
            "frameworks": len(frameworks_out),
            "controls": len(all_controls),
            "failed": sum(1 for c in all_controls if c["state"] == ctl.FAIL),
            "partial": sum(1 for c in all_controls if c["state"] == ctl.PARTIAL),
            "unknown": sum(1 for c in all_controls if c["state"] == ctl.UNKNOWN),
            "passed": sum(1 for c in all_controls if c["state"] == ctl.PASS),
            "passed_with_exceptions": sum(1 for c in all_controls
                                          if c["passed_with_exceptions"]),
            "not_evaluated": len(not_evaluated),
            "not_applicable": len(not_applicable),
            "exceptions": len(exceptions_out),
            "exceptions_without_reason": sum(1 for e in exceptions_out if e["reason_missing"]),
            "evidence_findings": len(registry),
            "open_breaching_findings": sum(
                1 for r in registry.values()
                if r["status"] in ACTIVE_FINDING_STATUSES
                and any(c["role"] == "breaching" for c in r["controls"])),
        },
        "frameworks": frameworks_out,
        "findings": dict(sorted(registry.items())),
        "exceptions": exceptions_out,
        "remediation_priorities": priorities,
        "not_evaluated": not_evaluated,
        "not_applicable": not_applicable,
        "methodology": methodology(view),
    }
    pack["integrity"] = integrity_block(pack)
    return pack


def methodology(view: Dict[str, Any]) -> List[Dict[str, str]]:
    """The method statement printed in every format — the pack has to explain
    its own numbers to someone who never saw the product."""
    states = "; ".join(f"{ctl.CONTROL_STATE_LABEL[s]}: {ctl.CONTROL_STATE_MEANING[s]}"
                       for s in ctl.CONTROL_STATES)
    return [
        {"title": "What this document is",
         "text": view.get("note") or ""},
        {"title": "How each control's state is decided",
         "text": ("Each control in the catalog names the automated checks that assess it. "
                  "A check evaluates the account's stored cloud inventory and records, per "
                  "resource, a confirmed violation, a pass, or 'could not determine'. The "
                  "control's state follows from those results. " + states)},
        {"title": "The two numbers per framework",
         "text": ("Pass rate = controls passed / controls assessed (failed, partially "
                  "failed and evidence-unavailable controls all count against it). "
                  "Coverage = controls assessed / applicable controls. Controls with no "
                  "automated check are reported as 'not evaluated' and never counted as "
                  "passed; controls with nothing in scope are 'not applicable' and excluded "
                  "from both numbers.")},
        {"title": "Benchmarks versus standards and regulations",
         "text": ("CIS benchmark recommendations are pass/fail tests: any confirmed finding "
                  "fails one, whatever its severity. Standards and regulations (SOC 2, ISO "
                  "27001, PCI-DSS, HIPAA, GDPR, RBI, SEBI) are failed only by a CRITICAL, "
                  "HIGH or MEDIUM finding; LOW and INFO findings are hygiene, listed as "
                  "advisory, not as violations.")},
        {"title": "Exceptions (suppressed findings and accepted risks)",
         "text": ("A finding a user suppressed or accepted as a risk no longer counts toward "
                  "a control's state. Every control whose result depends on such a decision "
                  "is flagged, and every exception is listed with who made it, when, and "
                  "the recorded reason. An exception with no recorded reason is flagged.")},
        {"title": "Evidence per check",
         "text": ("Evaluated = subjects the check concluded on. Conforming = evaluated "
                  "subjects with no violation (accepted exceptions are subtracted, not "
                  "counted as passes). Breaching = open violations of this control. "
                  "Advisory = open findings below this control's severity bar. "
                  "Undetermined = subjects whose data could not be read. A check that did "
                  "not run produced no result for this account, usually because no resource "
                  "of its type exists.")},
        {"title": "Data freshness",
         "text": ("Findings are derived from the inventory collected at the time shown. An "
                  "assessment re-evaluates stored inventory and does not re-contact the "
                  "cloud provider, so no result is fresher than the inventory beneath it.")},
        {"title": "Integrity",
         "text": ("The pack ID and SHA-256 identify this exact pack. " + INTEGRITY_SCOPE
                  + " A changed value anywhere in the pack changes the hash.")},
    ]


def _canonical(pack: Dict[str, Any]) -> bytes:
    body = {k: v for k, v in pack.items() if k != "integrity"}
    return json.dumps(body, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def integrity_block(pack: Dict[str, Any]) -> Dict[str, str]:
    digest = hashlib.sha256(_canonical(pack)).hexdigest()
    return {"algorithm": "SHA-256", "sha256": digest,
            "pack_id": digest[:12].upper(), "scope": INTEGRITY_SCOPE}


def verify_pack(pack: Dict[str, Any]) -> bool:
    """True when the pack's stored hash matches its content. The reference
    implementation an auditor can run against the JSON export."""
    stored = (pack.get("integrity") or {}).get("sha256")
    return bool(stored) and hashlib.sha256(_canonical(pack)).hexdigest() == stored


# ═════════════════════════════════════════════════════════════════════════════
# Rendering
# ═════════════════════════════════════════════════════════════════════════════


def filename(pack: Dict[str, Any], fmt: str) -> str:
    scope = pack["scope"]
    which = slug(scope["framework"], "") if scope.get("framework") else "all-frameworks"
    stamp = datetime.fromisoformat(pack["generated_at"]).strftime("%Y%m%d-%H%MZ")
    return (f"compliance-audit-{slug(pack['account'].get('name'))}-{which}-{stamp}."
            f"{FORMATS[fmt][1]}")


def render_json(pack: Dict[str, Any]) -> bytes:
    return json.dumps(pack, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def render_zip(pack: Dict[str, Any]) -> bytes:
    from app.services.compliance_export_pdf import render as render_pdf
    from app.services.compliance_export_xlsx import render as render_xlsx

    parts = {
        filename(pack, "pdf"): render_pdf(pack),
        filename(pack, "xlsx"): render_xlsx(pack),
        filename(pack, "json"): render_json(pack),
    }
    sums = "".join(f"{_sha256(body)}  {name}\n" for name, body in parts.items())
    integ = pack["integrity"]
    readme = "\n".join([
        "Actmon compliance audit pack",
        "",
        f"Account:      {pack['account'].get('name')} ({pack['account'].get('provider')})",
        f"Scope:        {pack['scope']['label']}",
        f"Generated:    {pack['generated_at']}",
        f"Prepared by:  {pack.get('prepared_by') or 'not recorded'}",
        f"Pack ID:      {integ['pack_id']}",
        f"Pack SHA-256: {integ['sha256']}",
        "",
        "Contents",
        "  *.pdf   The report to read and sign off.",
        "  *.xlsx  Working papers: every control, check and evidence row.",
        "  *.json  The same pack, machine-readable. Its 'integrity' block holds the",
        "          pack hash above; " + INTEGRITY_SCOPE,
        "  SHA256SUMS.txt  File checksums (verify with: sha256sum -c SHA256SUMS.txt).",
        "",
        "This pack is an informative cross-walk to published control text. It is not",
        "a certification, an audit opinion or a QSA/assessor report.",
        "",
    ])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, body in parts.items():
            z.writestr(name, body)
        z.writestr("SHA256SUMS.txt", sums)
        z.writestr("README.txt", readme)
    return buf.getvalue()


def render(pack: Dict[str, Any], fmt: str) -> Tuple[str, str, bytes]:
    """(filename, media type, body) for one format."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format {fmt!r}. Known: {', '.join(FORMATS)}")
    if fmt == "pdf":
        from app.services.compliance_export_pdf import render as render_pdf
        body = render_pdf(pack)
    elif fmt == "xlsx":
        from app.services.compliance_export_xlsx import render as render_xlsx
        body = render_xlsx(pack)
    elif fmt == "json":
        body = render_json(pack)
    else:
        body = render_zip(pack)
    return filename(pack, fmt), FORMATS[fmt][0], body


# ═════════════════════════════════════════════════════════════════════════════
# Service
# ═════════════════════════════════════════════════════════════════════════════


class ComplianceExportService:
    def __init__(self, db: AsyncSession) -> None:
        from app.services.security_center_service import SecurityCenterService

        self.db = db
        self.security = SecurityCenterService(db)

    async def build(
        self, account_id: uuid.UUID, *, framework: Optional[str] = None,
        prepared_by: Optional[str] = None, include_raw: bool = False,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        from app.models.client import CloudClient
        from app.services.security_center_service import (
            ASSESSMENT_STALE_AFTER, INVENTORY_STALE_AFTER,
        )

        if framework and framework not in ctl.FRAMEWORKS:
            # An unknown key would narrow the view to nothing and render a
            # tidy, empty pack — which reads as "no controls failed".
            raise ValueError(f"Unknown framework {framework!r}")
        data = await self.security.compliance_dataset(account_id, framework=framework)
        acc = data["account"]
        if acc is None:
            raise ValueError("Account not found")
        if framework and not data["view"].get("frameworks"):
            raise ValueError(f"{framework} does not apply to this {acc.provider} account")
        client_name = None
        if acc.client_id:
            client = await self.db.get(CloudClient, acc.client_id)
            client_name = client.name if client else None
        latest = await self.security.repo.latest_assessment(account_id)

        account = {
            "id": str(acc.id),
            "name": acc.account_name,
            "provider": data["provider"] or acc.provider,
            "environment": acc.environment,
            "provider_account_id": acc.provider_account_id,
            "tenant_or_region": acc.tenant_or_region,
            "client": client_name,
            "last_discovery": _iso(acc.last_discovery),
        }
        return assemble_pack(
            account=account, view=data["view"], findings=data["findings"],
            rule_stats=data["rule_stats"], assessment=latest, framework=framework,
            generated_at=(now or datetime.now(timezone.utc)).replace(microsecond=0),
            prepared_by=prepared_by, include_raw=include_raw,
            assessment_stale_after_s=ASSESSMENT_STALE_AFTER.total_seconds(),
            inventory_stale_after_s=INVENTORY_STALE_AFTER.total_seconds(),
        )
