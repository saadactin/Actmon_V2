"""Compliance as a view over canonical findings — never its own assessment.

The old service called `run_security_scan()` and re-derived its own
interpretation of the result, which is how the two views came to disagree: a
finding could be CRITICAL on the Security tab and absent from Compliance
because the control map happened to have no key for its category, with no
diagnostic anywhere saying so.

Here, nothing is evaluated. `build()` takes findings the engine already
produced and the rule statistics from the same run, and resolves each control
in the catalog to a state. A finding appears once, carrying its control
citations as metadata.

**The arithmetic is the point.** Two numbers, always reported together:

    control_pass_rate    = PASS / (PASS + FAIL + PARTIAL + UNKNOWN)
    assessment_coverage  = rated / (rated + NOT_EVALUATED)

The second is what stops the first from lying. "8 of 9 assessed controls
passing, covering 30% of the catalog" is a true and useful statement. "89%
compliant" from the same data would not be.

Three states are never counted as PASS, and each for a different reason:

* `NOT_EVALUATED` — no rule in this build covers the control. Excluded from the
  pass rate entirely and reported as its own figure, because a control nobody
  checked is the one most likely to be failing.
* `UNKNOWN` — rules ran but the provider data was missing. Counted in the
  denominator, never the numerator.
* `NOT_APPLICABLE` — no resource in scope. Excluded from both, since there is
  nothing to pass or fail.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.security import controls as ctl
from app.security.model import (
    ACTIVE_FINDING_STATUSES, CRITICAL, HIGH, MEDIUM, NOT_APPLICABLE, NOT_SCANNED,
    SAFE, UNKNOWN, VULNERABLE, severity_rank, worst_severity,
)

# Severities that constitute a control failure. LOW and INFO findings are real
# and worth fixing and are not control violations — calling a 128 MB Lambda a
# PCI failure devalues the word for the findings that are.
FAILING_SEVERITIES = frozenset({CRITICAL, HIGH, MEDIUM})


def _f(finding, name, default=None):
    if isinstance(finding, dict):
        return finding.get(name, default)
    return getattr(finding, name, default)


def _rule_stats_for(control: ctl.Control, rid: str,
                    rule_stats: Dict[str, Dict[str, int]]) -> Dict[str, int]:
    """A rule's statistics as this control sees them — narrowed to the
    control's resource types when it declares any."""
    if not control.resource_types:
        return rule_stats.get(rid) or {}
    merged: Dict[str, int] = {}
    for rtype in control.resource_types:
        for verdict, n in (rule_stats.get(ctl.stat_key(rid, rtype)) or {}).items():
            merged[verdict] = merged.get(verdict, 0) + n
    return merged


def _control_state(
    control: ctl.Control,
    findings_by_rule: Dict[str, List[Any]],
    rule_stats: Dict[str, Dict[str, int]],
) -> Tuple[str, List[Any], Dict[str, Any]]:
    """Resolve one control to a state, with the findings that decided it."""
    if not control.rules:
        return ctl.NOT_EVALUATED, [], {
            "reason": "No check in this build assesses this control.",
            "rules": [],
        }

    relevant: List[Any] = []
    ran_any = False
    saw_safe = False
    saw_undetermined = False
    saw_applicable = False
    stat_undetermined = 0

    for rid in control.rules:
        stats = _rule_stats_for(control, rid, rule_stats)
        if stats:
            ran_any = True
        if stats.get(SAFE):
            saw_safe = True
            saw_applicable = True
        if stats.get(VULNERABLE):
            saw_applicable = True
        if stats.get(UNKNOWN) or stats.get(NOT_SCANNED):
            saw_undetermined = True
            saw_applicable = True
            stat_undetermined += (stats.get(UNKNOWN) or 0) + (stats.get(NOT_SCANNED) or 0)
        found = findings_by_rule.get(rid, [])
        if control.resource_types:
            found = [f for f in found if _f(f, "resource_type") in control.resource_types]
        relevant.extend(found)

    failing = [
        f for f in relevant
        if _f(f, "verdict") == VULNERABLE
        # A strict (benchmark) control is failed by ANY confirmed finding: its
        # rules test the recommendation itself, and the recommendation has no
        # severity threshold.
        and (control.strict
             or (_f(f, "severity") or "").upper() in FAILING_SEVERITIES)
        and _f(f, "status") in ACTIVE_FINDING_STATUSES
    ]
    undetermined = [
        f for f in relevant
        if _f(f, "verdict") in (UNKNOWN, NOT_SCANNED)
        and _f(f, "status") in ACTIVE_FINDING_STATUSES
    ]

    detail = {
        "rules": list(control.rules),
        "rules_that_ran": [r for r in control.rules
                           if _rule_stats_for(control, r, rule_stats)],
        "failing_findings": len(failing),
        "undetermined_findings": len(undetermined),
        "strict": control.strict,
        "resource_types": list(control.resource_types),
    }

    if not ran_any:
        detail["reason"] = (
            "The checks covering this control exist but produced no result for this "
            "account — usually because no resource of the relevant type is present."
        )
        return ctl.NOT_APPLICABLE, relevant, detail

    if not saw_applicable:
        detail["reason"] = "No resource in this account is in scope for these checks."
        return ctl.NOT_APPLICABLE, relevant, detail

    if failing:
        detail["reason"] = (
            f"{len(failing)} confirmed violation(s) of the checks covering this control."
        )
        return ctl.FAIL, relevant, detail

    # A check can be undetermined without a finding of its own — a certificate
    # rule whose vault refused the listing carries NOT_SCANNED in its
    # statistics, and the store-level gap finding is not cited by the control.
    # That is still "could not tell", and must not fall through to PASS.
    if not undetermined and stat_undetermined:
        detail["undetermined_checks"] = stat_undetermined
        if saw_safe:
            detail["reason"] = (
                "No violation found, but some of the data these checks need could not be "
                "read (for example a certificate store that refused the listing), so the "
                "control cannot be confirmed as passing.")
            return ctl.PARTIAL, relevant, detail
        detail["reason"] = (
            "The data these checks need could not be read, so the control could not be "
            "assessed. This is not a pass.")
        return ctl.UNKNOWN, relevant, detail

    if undetermined and saw_safe:
        # Some evidence, not all of it. PARTIAL is the honest middle: the
        # alternative would be PASS (overstating) or FAIL (inventing a
        # violation).
        detail["reason"] = (
            f"No violation found, but {len(undetermined)} check result(s) could not be "
            "determined, so the control cannot be confirmed as passing."
        )
        return ctl.PARTIAL, relevant, detail

    if undetermined:
        detail["reason"] = (
            "Every check covering this control returned 'could not determine' — the "
            "provider data needed to assess it was unavailable. This is not a pass."
        )
        return ctl.UNKNOWN, relevant, detail

    detail["reason"] = "Every check covering this control ran and found no violation."
    return ctl.PASS, relevant, detail


def build(
    *,
    findings: Sequence[Any],
    rule_stats: Optional[Dict[str, Dict[str, int]]] = None,
    account_id: Optional[str] = None,
    framework: Optional[str] = None,
    provider: Optional[str] = None,
) -> Dict[str, Any]:
    """The compliance view. Pure function of findings + rule statistics.

    `framework` narrows to one framework's controls; omitted, every framework
    that applies to `provider` is returned with a per-framework summary. A
    provider benchmark (CIS AWS, CIS Azure, CIS OCI) is included only for its
    own cloud, and not at all when the provider is unknown.
    """
    rule_stats = rule_stats or {}
    findings_by_rule: Dict[str, List[Any]] = {}
    for f in findings:
        findings_by_rule.setdefault(_f(f, "rule_id"), []).append(f)

    frameworks = [framework] if framework else list(ctl.FRAMEWORKS)
    frameworks = [fw for fw in frameworks
                  if fw in ctl.FRAMEWORKS and ctl.applies_to(fw, provider)]

    control_rows: List[Dict[str, Any]] = []
    summary: Dict[str, Dict[str, Any]] = {}

    for fw in frameworks:
        counts = {s: 0 for s in ctl.CONTROL_STATES}
        rows_for_fw: List[Dict[str, Any]] = []

        for control in ctl.BY_FRAMEWORK[fw]:
            state, relevant, detail = _control_state(control, findings_by_rule, rule_stats)
            counts[state] += 1
            active = [f for f in relevant if _f(f, "status") in ACTIVE_FINDING_STATUSES]
            affected = {
                _f(f, "resource_key") or _f(f, "resource_id") or _f(f, "fingerprint")
                for f in active if _f(f, "verdict") == VULNERABLE
            }
            rows_for_fw.append({
                "framework": fw,
                "control_id": control.control_id,
                "title": control.title,
                "requirement": control.requirement,
                "state": state,
                "state_label": ctl.CONTROL_STATE_LABEL[state],
                "state_meaning": ctl.CONTROL_STATE_MEANING[state],
                "reason": detail.get("reason"),
                "rules": detail["rules"],
                "rules_that_ran": detail.get("rules_that_ran", []),
                "finding_count": len(active),
                "failing_findings": detail.get("failing_findings", 0),
                "undetermined_findings": detail.get("undetermined_findings", 0),
                "affected_resources": len(affected),
                "worst_severity": worst_severity(
                    [_f(f, "severity") for f in active if _f(f, "verdict") == VULNERABLE]
                ),
                # Fingerprints, not embedded findings: the UI fetches the
                # findings it needs, and embedding them would repeat one
                # finding under every control that cites it — the duplication
                # this design exists to avoid.
                "finding_fingerprints": [_f(f, "fingerprint") for f in active][:200],
            })

        rated = sum(counts[s] for s in ctl.RATED_STATES)
        not_evaluated = counts[ctl.NOT_EVALUATED]
        declared = len(ctl.BY_FRAMEWORK[fw])

        summary[fw] = {
            "framework": fw,
            **ctl.framework_meta(fw),
            "controls_declared": declared,
            "controls_assessed": rated,
            "controls_passed": counts[ctl.PASS],
            "controls_failed": counts[ctl.FAIL],
            "controls_partial": counts[ctl.PARTIAL],
            "controls_unknown": counts[ctl.UNKNOWN],
            "controls_not_applicable": counts[ctl.NOT_APPLICABLE],
            "controls_not_evaluated": not_evaluated,
            # None, not 0 or 100, when nothing was rated. A percentage with an
            # empty denominator is not a small number, it is not a number.
            "control_pass_rate": (round(100.0 * counts[ctl.PASS] / rated, 1)
                                  if rated else None),
            "assessment_coverage": (round(100.0 * rated / (rated + not_evaluated), 1)
                                    if (rated + not_evaluated) else None),
            "by_severity": _severity_counts(rows_for_fw, findings_by_rule),
            # The framework's own caveat ("Not a CIS certification", "technical
            # safeguards only"). The metadata spread above carries it as
            # `note`, which the generic note below replaces — so it is kept
            # under its own key rather than lost.
            "framework_note": ctl.FRAMEWORK_META[fw].get("note"),
            "note": (
                "control_pass_rate is the share of ASSESSED controls that passed; "
                "assessment_coverage is the share of this catalog that was assessed at "
                "all. Both are needed to read either. Neither is a compliance "
                "certification, and controls not evaluated are never counted as passed."
            ),
        }
        control_rows.extend(rows_for_fw)

    # Worst first, then by framework and control id, so the list opens on what
    # needs attention.
    control_rows.sort(key=lambda r: (
        ctl.CONTROL_STATE_RANK.get(r["state"], 9), r["framework"], r["control_id"],
    ))

    # The deduplicated violation list: one row per finding that breaches at
    # least one control, with all its citations.
    violations = _violations(findings, provider)

    return {
        "account_id": account_id,
        "frameworks": summary,
        "controls": control_rows,
        "violations": violations,
        "total_violations": len(violations),
        "severity_totals": {
            sev: sum(1 for v in violations if v["severity"] == sev)
            for sev in (CRITICAL, HIGH, MEDIUM)
        },
        "advisory_findings": sum(
            1 for f in findings
            if _f(f, "status") in ACTIVE_FINDING_STATUSES
            and _f(f, "verdict") == VULNERABLE
            and (_f(f, "severity") or "").upper() not in FAILING_SEVERITIES
        ),
        "undetermined_findings": sum(
            1 for f in findings
            if _f(f, "status") in ACTIVE_FINDING_STATUSES
            and _f(f, "verdict") in (UNKNOWN, NOT_SCANNED)
        ),
        "catalog": ctl.catalog_summary(provider),
        "provider": provider,
        "note": (
            "Control references are informative cross-walks to published control text, "
            "useful for pointing an auditor at the right clause. They are not a certified "
            "assessment: no QSA, SOC 2 auditor or HIPAA assessor is involved, and the "
            "catalog covers only the controls this build has evidence for. Wording is "
            "deliberately 'control passed' and 'control failed', never any "
            "certification language."
        ),
    }


def _severity_counts(rows: List[Dict[str, Any]],
                     findings_by_rule: Dict[str, List[Any]]) -> Dict[str, int]:
    seen = set()
    counts = {CRITICAL: 0, HIGH: 0, MEDIUM: 0}
    for row in rows:
        if row["state"] != ctl.FAIL:
            continue
        for rid in row["rules"]:
            for f in findings_by_rule.get(rid, []):
                fp = _f(f, "fingerprint")
                if fp in seen:
                    continue
                sev = (_f(f, "severity") or "").upper()
                if (_f(f, "verdict") == VULNERABLE and sev in counts
                        and _f(f, "status") in ACTIVE_FINDING_STATUSES):
                    seen.add(fp)
                    counts[sev] += 1
    return counts


def _violations(findings: Sequence[Any],
                provider: Optional[str] = None) -> List[Dict[str, Any]]:
    """One row per finding that breaches at least one control.

    Deliberately not per (finding, framework): that was the original bug, which
    rendered the same finding three times and made all three framework tiles
    show identical counts. A LOW or INFO finding is a violation only where a
    strict (benchmark) control cites it.
    """
    out: List[Dict[str, Any]] = []
    for f in findings:
        if _f(f, "status") not in ACTIVE_FINDING_STATUSES:
            continue
        if _f(f, "verdict") != VULNERABLE:
            continue
        sev = (_f(f, "severity") or "").upper()
        if sev not in FAILING_SEVERITIES and not ctl.strict_for_rule(
                _f(f, "rule_id"), provider):
            continue
        mappings = _f(f, "compliance") or {}
        if provider:
            mappings = {fw: refs for fw, refs in mappings.items()
                        if ctl.applies_to(fw, provider)}
        if sev not in FAILING_SEVERITIES:
            # Below the principle-based bar, only a benchmark (strict) control
            # was actually failed — so only benchmark citations are listed.
            # Showing SOC 2 beside an INFO finding would claim a failure SOC 2
            # never recorded.
            mappings = {fw: refs for fw, refs in mappings.items()
                        if ctl.FRAMEWORK_META.get(fw, {}).get("kind") == ctl.KIND_BENCHMARK}
        if not mappings:
            continue
        out.append({
            "fingerprint": _f(f, "fingerprint"),
            "rule_id": _f(f, "rule_id"),
            "rule_version": _f(f, "rule_version"),
            "title": _f(f, "title"),
            "description": _f(f, "description"),
            "remediation": _f(f, "remediation"),
            "severity": sev,
            "category": _f(f, "category"),
            "confidence": _f(f, "confidence"),
            "resource_name": _f(f, "resource_name"),
            "resource_type": _f(f, "resource_type"),
            "resource_id": (str(_f(f, "resource_id")) if _f(f, "resource_id") else None),
            "affected_count": _f(f, "affected_count") or 1,
            "affected_resource": (
                f"{_f(f, 'resource_type') or 'Account'}: "
                f"{_f(f, 'resource_name') or 'multiple resources'}"
            ),
            "controls": mappings,
            "frameworks": sorted(mappings.keys()),
            "first_detected_at": _iso(_f(f, "first_detected_at")),
        })
    out.sort(key=lambda v: (severity_rank(v["severity"]), v["title"]))
    return out


def _iso(dt):
    return dt.isoformat() if hasattr(dt, "isoformat") else dt


def diff(current: Dict[str, Any], previous: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Improved / regressed / unchanged, per framework (§48).

    Phrased as control counts rather than a percentage delta, because a pass
    rate can move for two very different reasons — a control was fixed, or a
    control stopped being assessable — and conflating them would let a
    regression in coverage read as an improvement in posture.
    """
    if not previous:
        return {"available": False,
                "reason": "No earlier assessment is stored for this account yet."}

    out: Dict[str, Any] = {"available": True, "frameworks": {}}
    for fw, cur in (current.get("frameworks") or {}).items():
        prev = (previous.get("frameworks") or {}).get(fw)
        if not prev:
            continue
        d_failed = cur["controls_failed"] - prev["controls_failed"]
        d_passed = cur["controls_passed"] - prev["controls_passed"]
        d_assessed = cur["controls_assessed"] - prev["controls_assessed"]
        if d_failed < 0:
            direction = "improved"
        elif d_failed > 0:
            direction = "regressed"
        else:
            direction = "unchanged"
        out["frameworks"][fw] = {
            "direction": direction,
            "controls_failed_before": prev["controls_failed"],
            "controls_failed_now": cur["controls_failed"],
            "controls_passed_before": prev["controls_passed"],
            "controls_passed_now": cur["controls_passed"],
            "controls_assessed_delta": d_assessed,
            "note": (
                "Assessment coverage also changed, so part of this movement is a change "
                "in what could be assessed rather than in the estate itself."
                if d_assessed else None
            ),
        }
    return out
