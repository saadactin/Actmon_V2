"""Per-resource health scores — computed only where evidence exists.

A score is a claim that something was checked. So a dimension is scored for a
resource only when a rule actually reached a decision about it (FINDING or
CLEAR) in the latest analysis or assessment. "Performance 100" for an instance
whose CPU was never measured would be the most misleading number on the page,
so it is N/A with the reason instead.

Scoring is deliberately simple and published: 100 minus a fixed penalty per
open finding in the dimension (CRITICAL 40, HIGH 25, MEDIUM 12, LOW 5, INFO 0),
floored at 0. Overall is the mean of the dimensions that could be scored, and
only when at least two could — one dimension is not an overall picture.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from app.optimization.model import (
    AVAILABILITY, CLEAR, CONFIGURATION, COST, FINDING, RELIABILITY, SECURITY, TAGGING,
)
from app.optimization.rules import by_id

DIMENSIONS = ("security", "cost", "performance", "reliability", "configuration")
DIMENSION_LABEL = {
    "security": "Security", "cost": "Cost", "performance": "Performance",
    "reliability": "Reliability", "configuration": "Configuration",
}
PENALTY = {"CRITICAL": 40, "HIGH": 25, "MEDIUM": 12, "LOW": 5, "INFO": 0}
METHODOLOGY = (
    "Each dimension starts at 100 and loses a fixed amount per open finding in it "
    "(CRITICAL 40, HIGH 25, MEDIUM 12, LOW 5, INFO 0), floored at 0. A dimension is "
    "scored only when a check actually reached a decision about this resource; "
    "otherwise it is N/A. Overall is the mean of the scored dimensions, shown only "
    "when at least two could be scored."
)


def dimension_of(*, source: str, category: str, signal: Optional[str] = None) -> str:
    """Which health dimension a finding counts against."""
    if source == "security":
        if category in (TAGGING, CONFIGURATION):
            return "configuration"
        if category in (RELIABILITY, AVAILABILITY):
            return "reliability"
        return "security"
    if signal == "CONSTRAINED":
        return "performance"
    if category in (RELIABILITY, AVAILABILITY) or signal == "RISK":
        return "reliability"
    if signal == "CONFIGURATION" and category != COST:
        return "configuration"
    return "cost"


def rule_dimension(rule_id: str) -> Optional[str]:
    rule = by_id(rule_id)
    if rule is None:
        return None
    return dimension_of(source="optimization", category=rule.category, signal=rule.signal)


def score_resource(
    *,
    optimization_findings: Iterable[Dict[str, Any]],
    security_findings: Iterable[Dict[str, Any]],
    evaluations: Optional[Dict[str, str]],
    security_assessed: bool,
    security_reason: Optional[str] = None,
) -> Dict[str, Any]:
    """`evaluations` is {rule_id: verdict} for this resource from the latest
    optimization run; `security_assessed` says whether the security engine
    has rules for this resource type and an assessment ran."""
    decided: Dict[str, List[str]] = {d: [] for d in DIMENSIONS}
    for rule_id, verdict in (evaluations or {}).items():
        dim = rule_dimension(rule_id)
        if dim and verdict in (FINDING, CLEAR):
            decided[dim].append(rule_id)
    if security_assessed:
        decided["security"].append("security-assessment")

    penalties: Dict[str, int] = {d: 0 for d in DIMENSIONS}
    counts: Dict[str, int] = {d: 0 for d in DIMENSIONS}
    for f in optimization_findings:
        dim = dimension_of(source="optimization", category=f.get("category"), signal=f.get("signal"))
        penalties[dim] += PENALTY.get(f.get("severity"), 0)
        counts[dim] += 1
        if f.get("rule_id"):
            decided[dim].append(f["rule_id"])
    for f in security_findings:
        if f.get("verdict") not in (None, "VULNERABLE"):
            continue
        dim = dimension_of(source="security", category=f.get("unified_category") or SECURITY)
        penalties[dim] += PENALTY.get(f.get("severity"), 0)
        counts[dim] += 1
        if dim != "security":
            decided[dim].append(f.get("rule_id") or "security")

    out: Dict[str, Any] = {}
    scored: List[int] = []
    for d in DIMENSIONS:
        if decided[d]:
            s = max(0, 100 - penalties[d])
            out[d] = {"label": DIMENSION_LABEL[d], "score": s, "open_findings": counts[d],
                      "checks": len(set(decided[d])), "reason": None}
            scored.append(s)
        else:
            reason = {
                "security": security_reason or "The security engine has no checks for this "
                                                "resource type, or no assessment has run.",
                "performance": "No utilization telemetry reached a decision for this resource.",
            }.get(d, "No check in this dimension reached a decision for this resource.")
            out[d] = {"label": DIMENSION_LABEL[d], "score": None, "open_findings": counts[d],
                      "checks": 0, "reason": reason}
    if len(scored) >= 2:
        overall, overall_reason = round(sum(scored) / len(scored)), None
    else:
        overall = None
        overall_reason = ("Insufficient evidence: " + (
            f"only {', '.join(DIMENSION_LABEL[d] for d in DIMENSIONS if out[d]['score'] is not None)} "
            "could be scored." if scored else "no dimension could be scored."))
    return {
        "dimensions": out,
        "overall": overall,
        "overall_reason": overall_reason,
        "scored_dimensions": [d for d in DIMENSIONS if out[d]["score"] is not None],
        "basis": "Score based on available data",
        "methodology": METHODOLOGY,
    }
