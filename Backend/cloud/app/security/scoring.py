"""The security score: bounded, category-capped, and fully explainable.

The previous model was `100 - Σ(severity weight)` with no cap of any kind. On
the live estate that produced this:

    OCI          476 resources   11 CRITICAL, 10 HIGH   → 0 / F
    AWS          224 resources    3 CRITICAL,  3 HIGH   → 0 / F
    Azure TOR    550 resources    2 CRITICAL, 49 HIGH   → 0 / F
    Azure Prod   275 resources    0 CRITICAL, 25 HIGH   → 0 / F
    Azure TOR2     0 resources    nothing scanned       → 100 / A

Every populated account scored zero and the only A was the account with no
data. The number could not distinguish 11 CRITICAL findings from none, and the
single worst input was the untagged-resource check, which fired 476-550 times
per account — enough to floor the score on its own, twenty times over.

Three properties fix that, and all three are enforced by tests:

**1. Bounded, always.** The score is built up from category subscores rather
than subtracted without limit, so it cannot go negative and cannot be driven to
zero by volume alone.

**2. Per-category caps.** Each category can only ever remove up to its own
budget. Governance's budget is 5 points, so 550 missing tags cost 5 — visible,
worth fixing, and incapable of outweighing one publicly-reachable database.
Exposure and identity carry the largest budgets because they describe what an
attacker can actually do.

**3. Diminishing returns within a category.** The tenth CRITICAL exposure is
genuinely worse than the ninth, but not by another full increment — and an
operator who fixes half of them should see the number move. A square-root
progression gives both: real movement on the first few, no cliff at the tenth.

Two things are deliberately excluded from the score entirely:

* **Cost and Performance findings.** A 128 MB Lambda is not a security matter.
  They stay visible on their own merits and score nothing.
* **Low-confidence and UNKNOWN findings.** A heuristic indicator must not move
  a number people are judged on. They are shown, filterable and counted — see
  `unscored_findings` in the breakdown, which reports exactly how many findings
  were excluded and why, so the exclusion is never silent.

Coverage is reported next to the score, never folded into it. An account we
could barely scan should not score well *or* badly on that account; it should
say so. `confidence` on the returned score is what the UI uses to caveat the
number when coverage is poor.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, NamedTuple, Optional, Sequence

from app.security.model import (
    ACTIVE_FINDING_STATUSES, CAT_CONFIGURATION, CAT_COST, CAT_DATA_PROTECTION,
    CAT_ENCRYPTION, CAT_EXPOSURE, CAT_GOVERNANCE, CAT_IAM, CAT_LOGGING,
    CAT_MAINTENANCE, CAT_NETWORKING, CAT_PERFORMANCE, CAT_RESILIENCE, CATEGORIES,
    CRITICAL, HIGH, INFO, LOW, MEDIUM, NON_SECURITY_CATEGORIES, UNKNOWN,
    VULNERABLE, scores_toward_total,
)

# ── Category budgets ─────────────────────────────────────────────────────────
# Points a category may remove, at most. They sum to 100 so a maximally-bad
# account scores exactly 0 rather than an arbitrary negative number, and the
# relative sizes are the product's opinion about what matters:
#
#   Exposure + Identity = 55 of the 100 available. Between them they describe
#   the two ways an estate is actually breached: something reachable that
#   should not be, and someone able to do more than they should.
#
#   Governance = 5. It fires per resource, so without a small budget it
#   dominates by arithmetic rather than by importance.
CATEGORY_BUDGET: Dict[str, float] = {
    CAT_EXPOSURE: 30.0,
    CAT_IAM: 25.0,
    CAT_DATA_PROTECTION: 12.0,
    CAT_ENCRYPTION: 10.0,
    CAT_NETWORKING: 8.0,
    CAT_CONFIGURATION: 5.0,
    CAT_GOVERNANCE: 5.0,
    CAT_LOGGING: 2.0,
    CAT_RESILIENCE: 2.0,
    CAT_MAINTENANCE: 1.0,
    # Not security. Present with a zero budget so the table is exhaustive and
    # a reader can see the exclusion is intentional rather than an omission.
    CAT_COST: 0.0,
    CAT_PERFORMANCE: 0.0,
}

# Per-finding weight inside its category, before diminishing returns.
SEVERITY_WEIGHT: Dict[str, float] = {
    CRITICAL: 10.0,
    HIGH: 5.0,
    MEDIUM: 2.0,
    LOW: 0.5,
    INFO: 0.0,     # informational findings never move the score
}

# How much of a category's budget a single CRITICAL finding consumes. Without
# this a lone CRITICAL exposure would cost the entire 30-point budget and the
# second one would be free — so an operator with one critical problem and an
# operator with fifteen would see the same number.
FIRST_FINDING_SHARE = 0.45

# Grade thresholds. Deliberately not a curve: an account with a
# publicly-reachable database should not be able to reach a B because everything
# else is tidy, and the CRITICAL_GRADE_CEILING below enforces that directly.
GRADE_BANDS = ((90, "A"), (80, "B"), (70, "C"), (60, "D"), (0, "F"))

# An unresolved CRITICAL finding caps the grade regardless of the numeric score.
# A letter grade is read as a verdict, and "A" next to a world-open Postgres
# port is not a verdict anyone should be able to quote.
CRITICAL_GRADE_CEILING = "C"
HIGH_GRADE_CEILING = "B"


class CategoryImpact(NamedTuple):
    category: str
    budget: float
    deduction: float
    finding_count: int
    counted_count: int
    worst_severity: Optional[str]
    capped: bool

    def to_dict(self) -> dict:
        return {
            "category": self.category,
            "budget": round(self.budget, 1),
            "deduction": round(self.deduction, 1),
            "finding_count": self.finding_count,
            "counted_count": self.counted_count,
            "worst_severity": self.worst_severity,
            "capped": self.capped,
        }


# Coverage ceilings. A score is a statement about an estate, and it can only be
# as strong as the data behind it — so poor coverage caps the grade, and very
# poor coverage withholds it entirely.
#
# This exists because of a specific live result. On the first run of this engine
# the Azure Production Account scored **100 / A** with **26.8% coverage**: 49
# VMs whose NICs were never collected, 31 NSGs with no rule list, and every
# scan since the last successful one failing `AuthorizationFailed`. Every one of
# its 154 findings was UNKNOWN, and UNKNOWN correctly scores nothing — so the
# absence of confirmed problems produced a perfect grade for the account we can
# see least. That is the precise failure mode of "missing data reads as safe",
# arriving through the score instead of through a rule.
COVERAGE_GRADE_CEILING = ((90.0, None), (70.0, "B"), (40.0, "C"))
COVERAGE_WITHHOLD_BELOW = 40.0

GRADE_NOT_ASSESSED = "Not assessed"
GRADE_INSUFFICIENT = "Insufficient data"


class Score(NamedTuple):
    # None when there was nothing to assess, or when coverage is too poor for a
    # number to mean anything. A nullable score is inconvenient for the UI and
    # correct: the alternative is printing a figure that misleads.
    score: Optional[int]
    grade: str
    breakdown: List[CategoryImpact]
    total_deduction: float
    # Findings deliberately not counted, and why — so the exclusion is auditable
    # rather than something a reader has to infer from a discrepancy.
    unscored: Dict[str, int]
    grade_capped_by: Optional[str]
    confidence: str
    methodology: str
    # True when the score must not be presented as a verdict. The UI shows the
    # coverage figure and the reason in its place.
    reliable: bool = True
    coverage_pct: Optional[float] = None

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "grade": self.grade,
            "reliable": self.reliable,
            "coverage_pct": self.coverage_pct,
            "total_deduction": round(self.total_deduction, 1),
            "breakdown": [c.to_dict() for c in self.breakdown],
            "unscored": self.unscored,
            "grade_capped_by": self.grade_capped_by,
            "confidence": self.confidence,
            "methodology": self.methodology,
        }


METHODOLOGY = (
    "Each security category has a fixed budget of points it may remove (sum 100). "
    "Within a category, findings are weighted by severity and combined with "
    "diminishing returns, so the first finding costs the most and volume cannot "
    "dominate. A category can never exceed its budget, so 550 missing tags cost at "
    "most 5 points while one internet-reachable database costs up to 13. Cost and "
    "performance findings, informational findings, and low-confidence or "
    "undetermined findings score nothing and are reported separately. An "
    "unresolved CRITICAL finding caps the letter grade at C regardless of the "
    "number. This is an internal heuristic over provider-confirmed conditions, "
    "not a certified benchmark."
)


def _category_deduction(budget: float, weights: Sequence[float]) -> float:
    """Combine several findings' weights into one bounded deduction.

    The curve: the first finding takes FIRST_FINDING_SHARE of the budget scaled
    by its severity, and each subsequent finding adds a share that shrinks with
    the square root of the count. Formally the deduction approaches the budget
    asymptotically and never exceeds it, which is what makes the whole score
    bounded without a clamp doing the work.
    """
    if budget <= 0 or not weights:
        return 0.0
    ordered = sorted(weights, reverse=True)
    top = ordered[0]
    max_w = SEVERITY_WEIGHT[CRITICAL]

    # Severity of the worst finding sets how much of the budget is in play.
    first = budget * FIRST_FINDING_SHARE * (top / max_w)

    # Everything after it contributes on a sqrt curve, so ten findings cost
    # meaningfully more than one but not ten times more.
    rest = sum(ordered[1:])
    if rest > 0:
        remaining = budget - first
        # Normalise by the max weight so the units match, then compress.
        scaled = math.sqrt(rest / max_w)
        rest_deduction = remaining * (1.0 - math.exp(-scaled))
    else:
        rest_deduction = 0.0

    return min(budget, first + rest_deduction)


def compute(findings: Sequence[Any], *, coverage_pct: Optional[float] = None,
            resources_evaluated: Optional[int] = None) -> Score:
    """Score one account from its canonical findings.

    `findings` are the canonical objects (or dicts) — this function derives
    everything from them and holds no other state, which is what makes the
    breakdown reproducible from the same finding list.

    `coverage_pct` and `resources_evaluated` do not change the arithmetic; they
    decide whether the result may be presented as a verdict at all.
    """
    def attr(f, name, default=None):
        return getattr(f, name, None) if not isinstance(f, dict) else f.get(name, default)

    # Nothing to assess is not a good result — it is no result. The old model
    # gave the never-scanned TOR2 subscription 100/A, its highest score, for
    # having zero resources.
    #
    # The test is on the resource count alone, not "and no findings": that
    # subscription does produce one finding (its role assignments were never
    # collected either), and an earlier version of this guard checked both and
    # so let it through to score 100/C. An account with no inventory has not
    # been assessed, whatever else is true about it.
    if resources_evaluated == 0:
        return Score(
            score=None, grade=GRADE_NOT_ASSESSED, breakdown=[], total_deduction=0.0,
            unscored={}, confidence="unknown", methodology=METHODOLOGY,
            reliable=False, coverage_pct=coverage_pct,
            grade_capped_by=("No resources have been collected for this account, so "
                             "nothing was assessed. This is not a passing result — run a "
                             "discovery scan."),
        )

    active = [
        f for f in findings
        if attr(f, "status") in ACTIVE_FINDING_STATUSES
    ]

    by_category: Dict[str, List[Any]] = {}
    unscored = {
        "informational": 0,
        "low_confidence": 0,
        "undetermined": 0,
        "non_security_category": 0,
        "suppressed_or_accepted": len(findings) - len(active),
    }

    for f in active:
        cat = attr(f, "category") or CAT_CONFIGURATION
        sev = (attr(f, "severity") or MEDIUM).upper()
        verdict = attr(f, "verdict") or VULNERABLE
        conf = attr(f, "confidence")

        if cat in NON_SECURITY_CATEGORIES:
            unscored["non_security_category"] += 1
            continue
        if verdict != VULNERABLE:
            # UNKNOWN and NOT_SCANNED describe a gap in our data, not a
            # confirmed problem with the estate. Counting them would make a
            # scanner permission failure look like a security regression.
            unscored["undetermined"] += 1
            continue
        if sev == INFO:
            unscored["informational"] += 1
            continue
        if not scores_toward_total(conf):
            unscored["low_confidence"] += 1
            continue
        by_category.setdefault(cat, []).append(f)

    breakdown: List[CategoryImpact] = []
    total = 0.0
    from app.security.model import worst_severity

    for cat in CATEGORIES:
        budget = CATEGORY_BUDGET.get(cat, 0.0)
        group = by_category.get(cat, [])
        # Report every category with findings, and every category with a budget
        # even at zero deduction — a reader comparing two accounts needs the
        # same rows in both.
        if not group and budget <= 0:
            continue
        weights = [SEVERITY_WEIGHT.get((attr(f, "severity") or MEDIUM).upper(), 0.0)
                   for f in group]
        # A finding's affected_count (the aggregated tag rule) does NOT multiply
        # its weight. That is the entire point of the cap: 550 untagged
        # resources are one governance problem, not 550 score events.
        deduction = _category_deduction(budget, [w for w in weights if w > 0])
        total += deduction
        breakdown.append(CategoryImpact(
            category=cat,
            budget=budget,
            deduction=deduction,
            finding_count=len(group),
            counted_count=sum(1 for w in weights if w > 0),
            worst_severity=worst_severity([attr(f, "severity") for f in group]),
            capped=bool(group) and deduction >= budget - 0.05,
        ))

    score = max(0, min(100, int(round(100.0 - total))))

    # Grade, with the CRITICAL/HIGH ceilings applied after the arithmetic.
    grade = next(g for threshold, g in GRADE_BANDS if score >= threshold)
    capped_by = None
    scored_findings = [f for group in by_category.values() for f in group]
    has_critical = any((attr(f, "severity") or "").upper() == CRITICAL
                       for f in scored_findings)
    has_high = any((attr(f, "severity") or "").upper() == HIGH for f in scored_findings)
    if has_critical and _grade_worse_than(grade, CRITICAL_GRADE_CEILING):
        grade, capped_by = CRITICAL_GRADE_CEILING, (
            "An unresolved CRITICAL finding caps the grade at C, whatever the numeric "
            "score. A letter grade reads as a verdict, and one that says A next to a "
            "publicly-reachable database is a verdict nobody should be able to quote."
        )
    elif has_high and _grade_worse_than(grade, HIGH_GRADE_CEILING):
        grade, capped_by = HIGH_GRADE_CEILING, (
            "An unresolved HIGH finding caps the grade at B."
        )

    # Coverage does not change the arithmetic. It decides whether the result may
    # be presented as a verdict — because a high score earned by not being able
    # to see anything is the most misleading output this system can produce.
    if coverage_pct is None:
        confidence = "unknown"
    elif coverage_pct >= 90:
        confidence = "high"
    elif coverage_pct >= 70:
        confidence = "medium"
    else:
        confidence = "low"

    reliable = True
    if coverage_pct is not None:
        if coverage_pct < COVERAGE_WITHHOLD_BELOW:
            # Withheld, not capped. At this coverage the number is dominated by
            # what we could not see, and any letter would be read as a judgement
            # of the estate rather than of the scan.
            return Score(
                score=None, grade=GRADE_INSUFFICIENT, breakdown=breakdown,
                total_deduction=total, unscored=unscored, confidence=confidence,
                methodology=METHODOLOGY, reliable=False, coverage_pct=coverage_pct,
                grade_capped_by=(
                    f"Only {coverage_pct:g}% of the data these checks need was available, "
                    "so no score is shown. Almost every check returned "
                    "'could not determine' rather than 'no problem found', and a grade "
                    "built on that would describe the scan, not the estate. Fix the "
                    "collection gaps listed under Coverage first."
                ),
            )
        for threshold, ceiling in COVERAGE_GRADE_CEILING:
            if coverage_pct >= threshold:
                if ceiling and _grade_worse_than(grade, ceiling):
                    grade = ceiling
                    capped_by = (
                        f"Grade capped at {ceiling}: only {coverage_pct:g}% of the data "
                        "these checks need was available, so the absence of findings is "
                        "partly an absence of evidence."
                    )
                    reliable = False
                break

    return Score(
        score=score, grade=grade, breakdown=breakdown, total_deduction=total,
        unscored=unscored, grade_capped_by=capped_by, confidence=confidence,
        methodology=METHODOLOGY, reliable=reliable, coverage_pct=coverage_pct,
    )


_GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "D": 3, "F": 4}


def _grade_worse_than(grade: str, ceiling: str) -> bool:
    """True when `grade` is BETTER than the ceiling and therefore needs capping."""
    return _GRADE_ORDER.get(grade, 9) < _GRADE_ORDER.get(ceiling, 9)


def explain(score: Score) -> Dict[str, Any]:
    """The "why is my score 72?" payload (§6).

    Returns the arithmetic in the order it was applied, so the displayed lines
    sum to the displayed total. A breakdown that does not add up is worse than
    no breakdown.
    """
    lines = [
        {
            "label": c.category,
            "deduction": round(c.deduction, 1),
            "budget": round(c.budget, 1),
            "findings": c.finding_count,
            "worst": c.worst_severity,
            "capped": c.capped,
            "note": (f"Capped at this category's {c.budget:g}-point budget — "
                     f"{c.finding_count} finding(s) could not remove more."
                     if c.capped else None),
        }
        for c in score.breakdown if c.deduction > 0
    ]
    return {
        "starting_score": 100,
        "lines": lines,
        "total_deduction": round(score.total_deduction, 1),
        "final_score": score.score,
        "grade": score.grade,
        "grade_capped_by": score.grade_capped_by,
        "excluded": score.unscored,
        "excluded_explanation": {
            "informational": "INFO-severity findings never affect the score.",
            "low_confidence": "Heuristic indicators are shown but do not move the score.",
            "undetermined": "Findings whose verdict is UNKNOWN or NOT_SCANNED describe a "
                            "gap in our data, not a confirmed problem — counting them "
                            "would make a permission failure look like a regression.",
            "non_security_category": "Cost and performance findings are not security "
                                     "matters and score nothing.",
            "suppressed_or_accepted": "Findings a user has suppressed or accepted as risk, "
                                      "with a recorded reason.",
        },
        "methodology": score.methodology,
        "confidence": score.confidence,
    }
