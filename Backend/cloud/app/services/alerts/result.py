"""What one evaluation of one rule produced.

The reason this is a typed object rather than a bool is the whole safety
argument of the feature. A boolean has two values, and this domain has six
outcomes that must not be collapsed:

    TRIGGERED       the condition is true, on data we actually read
    NOT_TRIGGERED   the condition is false, on data we actually read
    RESOLVED        it was true, it is now false — close the open alert
    UNKNOWN         we could not read the data (throttled, no assessment yet,
                    window not covered). NOT "false". NOT zero.
    ERROR           the evaluator itself failed
    UNSUPPORTED     this condition cannot be evaluated for this account

Only NOT_TRIGGERED resolves an open alert. UNKNOWN, ERROR and UNSUPPORTED
deliberately leave it open, because "I could not check" is not evidence that a
problem went away — auto-resolving on a failed read is how a monitoring system
tells you everything is fine while the estate burns.

`observed` is None whenever the value could not be determined, and every
consumer treats None as NA. There is no code path in this module that turns
None into 0.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.models.alert_rule import (
    EVAL_ERROR, EVAL_INCONCLUSIVE, EVAL_NOT_TRIGGERED, EVAL_RESOLVED,
    EVAL_TRIGGERED, EVAL_UNKNOWN, EVAL_UNSUPPORTED,
)


@dataclass
class Evaluation:
    """One rule, one moment, one answer — with the arithmetic attached.

    `explain()` is what the UI's "Why did this fire?" panel and the alert email
    both render, and it is assembled from the same numbers the decision used,
    so it cannot describe a different comparison than the one that happened.
    """

    state: str
    # The measured value. None means NA and is never rendered as 0.
    observed: Optional[float] = None
    threshold: Optional[float] = None
    operator: Optional[str] = None
    # Unit / currency, for rendering. A currency here is never converted.
    unit: Optional[str] = None
    # A human sentence: for UNKNOWN, why we could not tell; for TRIGGERED,
    # what was measured.
    detail: Optional[str] = None
    # Stable identity of the thing that is wrong, appended to the rule's
    # fingerprint. None for an account-wide condition.
    subject: Optional[str] = None
    subject_name: Optional[str] = None
    # Resources / findings / events behind the number, for the alert body.
    # Bounded by the caller — an alert email is not a report.
    samples: List[Dict[str, Any]] = field(default_factory=list)
    # As-of time of the underlying data, when it differs from "now". A count
    # over a 24h window and a billing figure two days behind are both honest
    # only if they say when they are from.
    as_of: Optional[str] = None
    # Extra facts worth keeping on the alert row and in the audit event.
    context: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_conclusive(self) -> bool:
        return self.state not in EVAL_INCONCLUSIVE

    @property
    def fired(self) -> bool:
        return self.state == EVAL_TRIGGERED

    def explain(self, condition_human: Optional[str] = None) -> Dict[str, Any]:
        """The structured 'why', for the drawer and the email."""
        return {
            "condition": condition_human,
            "result": self.state,
            "observed": self.observed,
            "observed_label": self.observed_label,
            "threshold": self.threshold,
            "threshold_label": self.threshold_label,
            "operator": self.operator,
            "unit": self.unit,
            "detail": self.detail,
            "as_of": self.as_of,
            "samples": self.samples,
        }

    @property
    def observed_label(self) -> str:
        return _label(self.observed, self.unit)

    @property
    def threshold_label(self) -> str:
        return _label(self.threshold, self.unit)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "observed": self.observed,
            "observed_label": self.observed_label,
            "threshold": self.threshold,
            "threshold_label": self.threshold_label,
            "operator": self.operator,
            "unit": self.unit,
            "detail": self.detail,
            "subject": self.subject,
            "subject_name": self.subject_name,
            "samples": self.samples,
            "as_of": self.as_of,
            "context": self.context,
        }


def _label(value: Optional[float], unit: Optional[str]) -> str:
    """Render a value for a human. None is 'NA' — never 0, never '—0'."""
    if value is None:
        return "NA"
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value)
    text = f"{int(f):,}" if f.is_integer() else f"{f:,.2f}"
    if not unit:
        return text
    if unit == "%":
        return f"{text}%"
    # A currency code is a suffix, not a symbol: this system never guesses that
    # 1,200 INR should be written with a dollar sign.
    return f"{text} {unit}"


# ── Constructors, so every evaluator spells the six states the same way ───────
def triggered(observed, threshold, operator, **kw) -> Evaluation:
    return Evaluation(EVAL_TRIGGERED, observed=observed, threshold=threshold,
                      operator=operator, **kw)


def not_triggered(observed, threshold, operator, **kw) -> Evaluation:
    return Evaluation(EVAL_NOT_TRIGGERED, observed=observed, threshold=threshold,
                      operator=operator, **kw)


def compared(fired: bool, observed, threshold, operator, **kw) -> Evaluation:
    """The common case: a real number compared against a real threshold."""
    return (triggered if fired else not_triggered)(observed, threshold, operator, **kw)


def unknown(detail: str, **kw) -> Evaluation:
    """The source could not be read. Deliberately carries observed=None."""
    kw.pop("observed", None)
    return Evaluation(EVAL_UNKNOWN, detail=detail, **kw)


def unsupported(detail: str, **kw) -> Evaluation:
    kw.pop("observed", None)
    return Evaluation(EVAL_UNSUPPORTED, detail=detail, **kw)


def errored(detail: str, **kw) -> Evaluation:
    kw.pop("observed", None)
    return Evaluation(EVAL_ERROR, detail=detail, **kw)


def resolved(observed, threshold, operator, **kw) -> Evaluation:
    return Evaluation(EVAL_RESOLVED, observed=observed, threshold=threshold,
                      operator=operator, **kw)
