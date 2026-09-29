"""The closed set of conditions this product can actually evaluate.

Every entry here has a real evaluator in `evaluators.py` reading a real source.
Nothing is listed speculatively: if a condition appears in this catalog, the UI
offers it, and if the UI offers it, the engine can answer it. That is the whole
point of keeping the list in one place instead of spreading it across a form
component and a dispatch table that drift apart.

Three things live here and nowhere else:

1.  **The schema of each condition's config**, and the validation of it. A rule
    is validated against this before it is saved, so a rule that cannot be
    evaluated cannot be stored — as opposed to being stored and then failing
    silently every five minutes forever.

2.  **The human sentence.** `describe()` turns the structured config into the
    sentence shown on the rule list, in the review step and in the email
    ("Trigger when open CRITICAL security findings in <account> is greater
    than 0"). Generated from the config rather than typed by the user, so it
    cannot disagree with what the engine will actually do.

3.  **Support, derived rather than declared.** `account_support()` asks the
    real subsystems whether a condition can be evaluated for a specific
    account right now — does its billing API work, is there enough cost
    history for a baseline, has any event scope ever collected. A hardcoded
    {"aws": {"cost": true}} matrix would be a claim about the product; this is
    an observation about the account.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from app.models.alert_rule import (
    CAT_COST, CAT_DISCOVERY, CAT_DRIFT, CAT_EVENT, CAT_PLATFORM,
    CAT_RESOURCE, CAT_SECURITY, SEVERITIES,
)

logger = logging.getLogger("cloud_svc.alerts.catalog")

# ── Operators ─────────────────────────────────────────────────────────────────
OP_GT = "greater_than"
OP_GTE = "greater_or_equal"
OP_LT = "less_than"
OP_LTE = "less_or_equal"
OP_EQ = "equals"

_OPERATOR_FN: Dict[str, Callable[[float, float], bool]] = {
    OP_GT: lambda a, b: a > b,
    OP_GTE: lambda a, b: a >= b,
    OP_LT: lambda a, b: a < b,
    OP_LTE: lambda a, b: a <= b,
    OP_EQ: lambda a, b: a == b,
}
_OPERATOR_WORDS = {
    OP_GT: "is greater than",
    OP_GTE: "is at least",
    OP_LT: "is less than",
    OP_LTE: "is at most",
    OP_EQ: "equals",
}
OPERATORS = tuple(_OPERATOR_FN)

# A comparison operator is not a matter of taste: "cost > 1000" and
# "cost < 1000" are opposite alerts, and offering both for a condition where
# only one is meaningful invites a rule that can never fire. Each condition
# declares the operators that make sense for it.
_COUNT_OPERATORS = (OP_GT, OP_GTE, OP_EQ, OP_LT)
_AMOUNT_OPERATORS = (OP_GT, OP_GTE)


def compare(observed: float, operator: str, threshold: float) -> bool:
    fn = _OPERATOR_FN.get(operator)
    if fn is None:
        raise ValueError(f"Unknown operator: {operator!r}")
    return fn(observed, threshold)


def operator_words(operator: str) -> str:
    return _OPERATOR_WORDS.get(operator, operator)


# ── Field kinds the rule builder renders ──────────────────────────────────────
@dataclass(frozen=True)
class Field:
    """One configurable input on a condition.

    `choices` is a list of {value, label}. `required` fields must be present and
    non-null; an optional field left out means "do not narrow by this", never a
    default value invented on the user's behalf.
    """

    key: str
    kind: str                      # "number" | "choice" | "operator" | "text" | "money"
    label: str
    required: bool = True
    default: Any = None
    choices: Optional[Sequence[Dict[str, str]]] = None
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    help: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key, "kind": self.kind, "label": self.label,
            "required": self.required, "default": self.default,
            "choices": list(self.choices) if self.choices else None,
            "minimum": self.minimum, "maximum": self.maximum, "help": self.help,
        }


def _op_field(allowed: Sequence[str], default: str) -> Field:
    return Field(
        "operator", "operator", "Comparison", default=default,
        choices=[{"value": o, "label": _OPERATOR_WORDS[o]} for o in allowed],
    )


_SEVERITY_CHOICES = [{"value": "ANY", "label": "Any severity"}] + [
    {"value": s, "label": s.title()} for s in SEVERITIES
]

# Normalized statuses, from services/resource_model.py. Only statuses the
# inventory genuinely records — "unhealthy" is not among them, because no
# provider reports health and inferring it from existence is the fabrication
# this feature exists to avoid.
_STATUS_CHOICES = [
    {"value": "STOPPED", "label": "Stopped"},
    {"value": "RUNNING", "label": "Running"},
    {"value": "AVAILABLE", "label": "Available"},
    {"value": "PROVISIONING", "label": "Provisioning"},
    {"value": "DEGRADED", "label": "Degraded"},
    {"value": "FAILED", "label": "Failed"},
    {"value": "UNATTACHED", "label": "Unattached"},
    {"value": "UNKNOWN", "label": "Status not reported"},
]

_ATTRIBUTE_CHOICES = [
    {"value": "total", "label": "Total resources"},
    {"value": "stopped", "label": "Stopped resources"},
    {"value": "unattached", "label": "Unattached resources"},
    {"value": "untagged", "label": "Untagged resources"},
    {"value": "stale", "label": "Resources not seen recently"},
    {"value": "high_risk", "label": "Resources with a HIGH or CRITICAL finding"},
    {"value": "status_unknown", "label": "Resources whose status is not reported"},
]

_PERIOD_CHOICES = [
    {"value": "yesterday", "label": "Yesterday (last complete day)"},
    {"value": "last_7_days", "label": "Last 7 days"},
    {"value": "month_to_date", "label": "Month to date"},
    {"value": "last_30_days", "label": "Last 30 days"},
]

_RISK_CHOICES = [
    {"value": "CRITICAL", "label": "Critical only"},
    {"value": "HIGH", "label": "High and above"},
    {"value": "MEDIUM", "label": "Medium and above"},
    {"value": "ANY", "label": "Any risk level"},
]

_EVENT_STATUS_CHOICES = [
    {"value": "ANY", "label": "Any outcome"},
    {"value": "Failed", "label": "Failed operations"},
    {"value": "Denied", "label": "Denied operations"},
]


@dataclass(frozen=True)
class Condition:
    key: str
    category: str
    label: str
    summary: str
    fields: Sequence[Field]
    # The source this reads, named so the UI can say where a number came from
    # and so §90 (one source of truth per domain) is checkable by reading this
    # file rather than by auditing every evaluator.
    source: str
    # Filled in per-account by account_support(); the static default is True
    # for conditions that read our own database and therefore always work.
    version: int = 1
    # True when the condition is about something being BROKEN rather than a
    # measurement. Those have no threshold and their "observed value" is a
    # state, not a number.
    stateful: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key, "category": self.category, "label": self.label,
            "summary": self.summary, "source": self.source,
            "version": self.version, "stateful": self.stateful,
            "fields": [f.to_dict() for f in self.fields],
        }


# ── The catalog ───────────────────────────────────────────────────────────────
SECURITY_FINDING_COUNT = "security_finding_count"
SECURITY_SCORE_BELOW = "security_score_below"
COST_THRESHOLD = "cost_threshold"
COST_INCREASE_PERCENT = "cost_increase_percent"
RESOURCE_STATUS_COUNT = "resource_status_count"
RESOURCE_ATTRIBUTE_COUNT = "resource_attribute_count"
DRIFT_COUNT = "drift_count"
EVENT_COUNT = "event_count"
DISCOVERY_FAILED = "discovery_failed"
DISCOVERY_STALE = "discovery_stale"
COST_DATA_UNAVAILABLE = "cost_data_unavailable"
EVENT_COLLECTION_UNHEALTHY = "event_collection_unhealthy"
CREDENTIAL_EXPIRY = "credential_expiry"

_CREDENTIAL_KIND_CHOICES = [
    {"value": "CERTIFICATE", "label": "Certificates"},
    {"value": "SECRET_OR_KEY", "label": "Secrets and keys"},
    {"value": "ANY", "label": "Certificates, secrets and keys"},
]
_YES_NO = [{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}]

CONDITIONS: Dict[str, Condition] = {c.key: c for c in (
    Condition(
        key=SECURITY_FINDING_COUNT,
        category=CAT_SECURITY,
        label="Open security findings",
        summary="Trigger on the number of open, confirmed security findings.",
        source="security_center",
        fields=(
            Field("severity_filter", "choice", "Severity", default="CRITICAL",
                  choices=_SEVERITY_CHOICES,
                  help="Counts confirmed findings only. Findings the scanner "
                       "could not determine are reported separately and are "
                       "never counted as safe."),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Findings", default=0, minimum=0),
        ),
    ),
    Condition(
        key=SECURITY_SCORE_BELOW,
        category=CAT_SECURITY,
        label="Security score",
        summary="Trigger when the Security Center's posture score drops below a bar.",
        source="security_center",
        fields=(
            Field("threshold", "number", "Score below", default=70,
                  minimum=0, maximum=100,
                  help="The score published by the Security Center assessment. "
                       "No score is calculated here — an account that has never "
                       "been assessed reports UNKNOWN, not 0."),
        ),
    ),
    Condition(
        key=COST_THRESHOLD,
        category=CAT_COST,
        label="Cost over a threshold",
        summary="Trigger when billed spend in a period exceeds an amount.",
        source="cost_intelligence",
        fields=(
            Field("period", "choice", "Period", default="month_to_date",
                  choices=_PERIOD_CHOICES),
            _op_field(_AMOUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Amount", minimum=0),
            Field("currency", "money", "Currency",
                  help="The threshold is compared only against spend billed in "
                       "this currency. Amounts in other currencies are never "
                       "converted or added in."),
        ),
    ),
    Condition(
        key=COST_INCREASE_PERCENT,
        category=CAT_COST,
        label="Cost increase against a baseline",
        summary="Trigger when spend rises by more than a percentage versus the "
                "immediately preceding period of equal length.",
        source="cost_intelligence",
        fields=(
            Field("window_days", "choice", "Compare", default="7",
                  choices=[{"value": "1", "label": "Yesterday vs the day before"},
                           {"value": "7", "label": "Last 7 days vs the 7 before"},
                           {"value": "30", "label": "Last 30 days vs the 30 before"}]),
            Field("threshold_percent", "number", "Increase of at least (%)",
                  default=20, minimum=0),
            Field("min_absolute", "number", "…and at least (amount)",
                  required=False, minimum=0,
                  help="Optional floor, so a 300% rise on a trivial amount stays "
                       "quiet. Left empty, any percentage rise qualifies."),
            Field("currency", "money", "Currency"),
        ),
    ),
    Condition(
        key=RESOURCE_STATUS_COUNT,
        category=CAT_RESOURCE,
        label="Resources in a state",
        summary="Trigger on how many resources are in a particular state.",
        source="resource_inventory",
        fields=(
            Field("status", "choice", "State", default="STOPPED",
                  choices=_STATUS_CHOICES),
            Field("resource_type", "text", "Resource type", required=False,
                  help="Optional. Leave empty for every type in the account."),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Resources", default=0, minimum=0),
        ),
    ),
    Condition(
        key=RESOURCE_ATTRIBUTE_COUNT,
        category=CAT_RESOURCE,
        label="Inventory hygiene",
        summary="Trigger on untagged, unattached, stale or high-risk resource counts.",
        source="resource_inventory",
        fields=(
            Field("attribute", "choice", "Count of", default="unattached",
                  choices=_ATTRIBUTE_CHOICES),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Resources", default=0, minimum=0),
        ),
    ),
    Condition(
        key=DRIFT_COUNT,
        category=CAT_DRIFT,
        label="Configuration drift",
        summary="Trigger on recorded configuration changes in a time window.",
        source="config_drift",
        fields=(
            Field("window_hours", "choice", "Window", default="24",
                  choices=[{"value": "1", "label": "Last hour"},
                           {"value": "24", "label": "Last 24 hours"},
                           {"value": "168", "label": "Last 7 days"}]),
            Field("severity_filter", "choice", "Severity", default="ANY",
                  choices=_SEVERITY_CHOICES),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Changes", default=0, minimum=0),
        ),
    ),
    Condition(
        key=EVENT_COUNT,
        category=CAT_EVENT,
        label="Cloud audit events",
        summary="Trigger on control-plane events collected from the provider's "
                "own audit trail.",
        source="event_log",
        fields=(
            Field("window_hours", "choice", "Window", default="24",
                  choices=[{"value": "1", "label": "Last hour"},
                           {"value": "24", "label": "Last 24 hours"},
                           {"value": "168", "label": "Last 7 days"}]),
            Field("risk_at_least", "choice", "Risk level", default="CRITICAL",
                  choices=_RISK_CHOICES),
            Field("status_filter", "choice", "Outcome", default="ANY",
                  choices=_EVENT_STATUS_CHOICES),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Events", default=0, minimum=0),
        ),
    ),
    Condition(
        key=DISCOVERY_FAILED,
        category=CAT_DISCOVERY,
        label="Discovery failed",
        summary="Trigger when the most recent inventory scan failed.",
        source="discovery",
        stateful=True,
        fields=(),
    ),
    Condition(
        key=DISCOVERY_STALE,
        category=CAT_DISCOVERY,
        label="Inventory is stale",
        summary="Trigger when no scan has succeeded for longer than a set time.",
        source="discovery",
        fields=(
            Field("threshold_hours", "number", "Hours without a successful scan",
                  default=24, minimum=1),
        ),
    ),
    Condition(
        key=COST_DATA_UNAVAILABLE,
        category=CAT_PLATFORM,
        label="Billing data unavailable",
        summary="Trigger when Actmon cannot read this account's billing API — "
                "permission denied, throttled, or credentials rejected.",
        source="cost_intelligence",
        stateful=True,
        fields=(),
    ),
    Condition(
        key=EVENT_COLLECTION_UNHEALTHY,
        category=CAT_PLATFORM,
        label="Audit-event collection unhealthy",
        summary="Trigger when one or more audit-log collection scopes cannot be "
                "read, so the Event Log has a gap.",
        source="event_log",
        stateful=True,
        fields=(),
    ),
    Condition(
        key=CREDENTIAL_EXPIRY,
        category=CAT_SECURITY,
        label="Certificate or secret expiry",
        summary="Trigger when certificates, secrets or keys expire within a window "
                "you choose — read from each provider's own certificate and secret "
                "stores.",
        source="credential_inventory",
        fields=(
            Field("kind", "choice", "Watch", default="CERTIFICATE",
                  choices=_CREDENTIAL_KIND_CHOICES),
            Field("within_days", "number", "Expiring within (days)", default=30,
                  minimum=0, maximum=365,
                  help="0 watches only objects that have already expired."),
            Field("include_expired", "choice", "Count already-expired objects",
                  default="yes", choices=_YES_NO),
            _op_field(_COUNT_OPERATORS, OP_GT),
            Field("threshold", "number", "Objects", default=0, minimum=0),
        ),
    ),
)}

CATEGORY_LABELS = {
    CAT_SECURITY: "Security",
    CAT_COST: "Cost",
    CAT_RESOURCE: "Resources",
    CAT_DRIFT: "Configuration Drift",
    CAT_EVENT: "Events",
    CAT_DISCOVERY: "Discovery",
    CAT_PLATFORM: "Platform Health",
}

# Which scope narrowings each condition honours. Declared rather than inferred
# so the builder cannot offer a filter the evaluator silently ignores — an
# alert scoped to one region that actually watches the whole account is worse
# than one that refuses the scope outright.
SCOPE_SUPPORT: Dict[str, Tuple[str, ...]] = {
    SECURITY_FINDING_COUNT: (),
    SECURITY_SCORE_BELOW: (),
    COST_THRESHOLD: ("service", "region"),
    COST_INCREASE_PERCENT: ("service", "region"),
    RESOURCE_STATUS_COUNT: ("region", "resource_type"),
    RESOURCE_ATTRIBUTE_COUNT: ("region", "resource_type"),
    DRIFT_COUNT: (),
    EVENT_COUNT: ("region",),
    DISCOVERY_FAILED: (),
    DISCOVERY_STALE: (),
    COST_DATA_UNAVAILABLE: (),
    EVENT_COLLECTION_UNHEALTHY: (),
    CREDENTIAL_EXPIRY: (),
}


class ValidationError(ValueError):
    """Field-level validation failure. `errors` maps field key → message."""

    def __init__(self, errors: Dict[str, str]) -> None:
        self.errors = errors
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))


def get(condition_type: str) -> Condition:
    cond = CONDITIONS.get(condition_type)
    if cond is None:
        raise ValidationError({
            "condition_type": (
                f"{condition_type!r} is not a condition this system can "
                f"evaluate. Known conditions: {', '.join(sorted(CONDITIONS))}."
            )
        })
    return cond


def validate(condition_type: str, config: Optional[dict],
             scope: Optional[dict] = None) -> Dict[str, Any]:
    """Return the cleaned config, or raise ValidationError.

    Unknown keys are dropped rather than stored: a config carrying a key no
    evaluator reads looks like a configured constraint and is not one.
    """
    cond = get(condition_type)
    raw = dict(config or {})
    errors: Dict[str, str] = {}
    clean: Dict[str, Any] = {}

    for f in cond.fields:
        present = f.key in raw and raw[f.key] not in (None, "")
        if not present:
            if f.required and f.default is None:
                errors[f.key] = f"{f.label} is required."
            elif f.default is not None:
                clean[f.key] = f.default
            continue

        value = raw[f.key]
        if f.kind == "number":
            try:
                value = float(value)
            except (TypeError, ValueError):
                errors[f.key] = f"{f.label} must be a number."
                continue
            if f.minimum is not None and value < f.minimum:
                errors[f.key] = f"{f.label} cannot be below {_num(f.minimum)}."
                continue
            if f.maximum is not None and value > f.maximum:
                errors[f.key] = f"{f.label} cannot be above {_num(f.maximum)}."
                continue
            # Counts are integers; storing 5.0 then rendering "5.0 resources"
            # is a small ugliness that shows up in every email.
            if float(value).is_integer():
                value = int(value)
        elif f.kind in ("choice", "operator"):
            allowed = {c["value"] for c in (f.choices or ())}
            value = str(value)
            if value not in allowed:
                errors[f.key] = (
                    f"{f.label} must be one of: {', '.join(sorted(allowed))}."
                )
                continue
        elif f.kind == "money":
            value = str(value).strip().upper()
            if not value.isalpha() or not (3 <= len(value) <= 8):
                errors[f.key] = (
                    "Currency must be a currency code such as USD or INR. "
                    "Amounts are never converted between currencies."
                )
                continue
        else:
            value = str(value).strip()
            if not value:
                if f.required:
                    errors[f.key] = f"{f.label} is required."
                continue

        clean[f.key] = value

    if scope:
        allowed_scope = set(SCOPE_SUPPORT.get(condition_type, ()))
        for key in scope:
            if scope[key] in (None, "") or key in allowed_scope:
                continue
            errors[f"scope.{key}"] = (
                f"{cond.label} cannot be narrowed by {key}. "
                + (f"Supported: {', '.join(sorted(allowed_scope))}."
                   if allowed_scope
                   else "This condition is evaluated for the whole account.")
            )

    if errors:
        raise ValidationError(errors)
    return clean


def clean_scope(condition_type: str, scope: Optional[dict]) -> Dict[str, Any]:
    allowed = set(SCOPE_SUPPORT.get(condition_type, ()))
    return {
        k: str(v).strip() for k, v in (scope or {}).items()
        if k in allowed and v not in (None, "") and str(v).strip()
    }


# ── Human-readable rendering ──────────────────────────────────────────────────
def describe(condition_type: str, config: Optional[dict],
             scope: Optional[dict] = None,
             account_name: Optional[str] = None) -> str:
    """The sentence shown on the rule list, the review step and the email.

    Built from the same config the evaluator reads, so the two cannot disagree.
    """
    cfg = dict(config or {})
    where = _scope_phrase(scope, account_name)
    op = operator_words(cfg.get("operator", OP_GT))
    n = cfg.get("threshold")

    if condition_type == SECURITY_FINDING_COUNT:
        sev = cfg.get("severity_filter", "ANY")
        what = "open security findings" if sev == "ANY" else f"open {sev} security findings"
        return f"Trigger when the number of confirmed {what}{where} {op} {_num(n)}."

    if condition_type == SECURITY_SCORE_BELOW:
        return (f"Trigger when the Security Center posture score{where} is below "
                f"{_num(cfg.get('threshold'))}.")

    if condition_type == COST_THRESHOLD:
        return (f"Trigger when {_period_words(cfg.get('period'))} spend{where} "
                f"billed in {cfg.get('currency', '—')} {op} "
                f"{_num(n)} {cfg.get('currency', '')}".rstrip() + ".")

    if condition_type == COST_INCREASE_PERCENT:
        days = int(cfg.get("window_days", 7) or 7)
        floor = cfg.get("min_absolute")
        tail = ""
        if floor not in (None, ""):
            tail = (f", and the increase is at least {_num(floor)} "
                    f"{cfg.get('currency', '')}".rstrip())
        return (f"Trigger when spend{where} billed in {cfg.get('currency', '—')} "
                f"over the last {days} day(s) is at least "
                f"{_num(cfg.get('threshold_percent'))}% above the preceding "
                f"{days} day(s){tail}.")

    if condition_type == RESOURCE_STATUS_COUNT:
        rt = cfg.get("resource_type")
        noun = f"{rt} resources" if rt else "resources"
        label = _choice_label(_STATUS_CHOICES, cfg.get("status", "STOPPED"))
        return (f"Trigger when the number of {noun} whose state is "
                f"“{label}”{where} {op} {_num(n)}.")

    if condition_type == RESOURCE_ATTRIBUTE_COUNT:
        label = _choice_label(_ATTRIBUTE_CHOICES, cfg.get("attribute", "unattached"))
        return f"Trigger when {label.lower()}{where} {op} {_num(n)}."

    if condition_type == DRIFT_COUNT:
        sev = cfg.get("severity_filter", "ANY")
        what = "configuration changes" if sev == "ANY" else f"{sev} configuration changes"
        return (f"Trigger when the number of recorded {what}{where} in the last "
                f"{_hours_words(cfg.get('window_hours'))} {op} {_num(n)}.")

    if condition_type == EVENT_COUNT:
        risk = cfg.get("risk_at_least", "CRITICAL")
        status = cfg.get("status_filter", "ANY")
        # Spelled out rather than reusing the dropdown label: "Critical only"
        # and "High and above" read as options in a list and as gibberish in a
        # sentence ("the number of critical only audit events").
        what = {
            "ANY": "audit events",
            "CRITICAL": "CRITICAL audit events",
            "HIGH": "audit events at HIGH risk or above",
            "MEDIUM": "audit events at MEDIUM risk or above",
        }.get(risk, "audit events")
        if status != "ANY":
            what = f"{status.lower()} {what}"
        return (f"Trigger when the number of {what}{where} in the last "
                f"{_hours_words(cfg.get('window_hours'))} {op} {_num(n)}.")

    if condition_type == DISCOVERY_FAILED:
        return f"Trigger when the most recent resource discovery{where} failed."

    if condition_type == DISCOVERY_STALE:
        return (f"Trigger when no resource discovery{where} has succeeded for "
                f"{_hours_words(cfg.get('threshold_hours'))}.")

    if condition_type == COST_DATA_UNAVAILABLE:
        return (f"Trigger when Actmon cannot read the billing API{where} — "
                "for example a permission error, throttling, or rejected "
                "credentials.")

    if condition_type == EVENT_COLLECTION_UNHEALTHY:
        return (f"Trigger when one or more audit-log collection scopes{where} "
                "cannot be read, leaving a gap in the Event Log.")

    if condition_type == CREDENTIAL_EXPIRY:
        noun = {"CERTIFICATE": "certificates", "SECRET_OR_KEY": "secrets and keys"}.get(
            cfg.get("kind", "CERTIFICATE"), "certificates, secrets and keys")
        days = cfg.get("within_days", 30)
        expired = cfg.get("include_expired", "yes") == "yes"
        window = (f"that have expired" if str(days) in ("0", "0.0") else
                  f"expiring within {_num(days)} day(s)"
                  + (" or already expired" if expired else ""))
        return f"Trigger when the number of {noun} {window}{where} {op} {_num(n)}."

    return get(condition_type).summary


def _scope_phrase(scope: Optional[dict], account_name: Optional[str]) -> str:
    bits = []
    if account_name:
        bits.append(f"in {account_name}")
    for key, label in (("service", "service"), ("region", "region"),
                       ("resource_type", "type")):
        value = (scope or {}).get(key)
        if value:
            bits.append(f"{label} {value}")
    return (" " + ", ".join(bits)) if bits else ""


def _period_words(period: Optional[str]) -> str:
    return {
        "yesterday": "yesterday's",
        "last_7_days": "the last 7 days'",
        "month_to_date": "month-to-date",
        "last_30_days": "the last 30 days'",
    }.get(period or "month_to_date", "month-to-date")


def _hours_words(hours: Any) -> str:
    try:
        h = int(float(hours))
    except (TypeError, ValueError):
        return "the configured window"
    if h == 1:
        return "1 hour"
    if h % 24 == 0 and h >= 24:
        d = h // 24
        return "1 day" if d == 1 else f"{d} days"
    return f"{h} hours"


def _choice_label(choices: Sequence[Dict[str, str]], value: Any) -> str:
    for c in choices:
        if c["value"] == str(value):
            return c["label"]
    return str(value)


def fmt_number(value: Any) -> str:
    """Render a number for a human sentence. None is an em dash, never 0."""
    if value is None:
        return "—"
    try:
        f = float(value)
    except (TypeError, ValueError):
        return str(value)
    if f.is_integer():
        return f"{int(f):,}"
    return f"{f:,.2f}"


# Short alias used throughout describe(); exported as fmt_number for callers
# outside this module so they are not reaching into a private name.
_num = fmt_number


# ── Per-account support, observed rather than declared ────────────────────────
@dataclass
class Support:
    supported: bool
    reason: Optional[str] = None
    # True when the condition will work but is currently degraded — e.g. the
    # account has never been assessed, so the rule is valid but will report
    # UNKNOWN until an assessment runs.
    warning: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"supported": self.supported, "reason": self.reason,
                "warning": self.warning}


async def account_support(db, account) -> Dict[str, Dict[str, Any]]:
    """Ask the real subsystems what can be evaluated for this account.

    Every probe here is cheap (a COUNT or a cached capability read) and every
    one is wrapped: a probe that itself fails must report "could not determine"
    rather than either enabling a condition that will fail or disabling one
    that would have worked.
    """
    out: Dict[str, Support] = {k: Support(True) for k in CONDITIONS}
    account_id = account.id

    # ── Cost ─────────────────────────────────────────────────────────────────
    try:
        from app.providers import capabilities as provider_caps

        cap = provider_caps.for_provider(account.provider)
        if cap is None:
            # Not "this provider has no billing API" — we have no cost adapter
            # for it at all, which is a different and more honest statement.
            reason = (
                f"Actmon has no cost integration for provider "
                f"{account.provider!r}, so billed spend cannot be read for this "
                "account."
            )
            for key in (COST_THRESHOLD, COST_INCREASE_PERCENT, COST_DATA_UNAVAILABLE):
                out[key] = Support(False, reason)
        elif getattr(cap, "rate_limit_sensitive", False):
            note = (
                "This provider's billing API is rate-limited. A throttled query "
                "reports UNKNOWN and never zero, so a cost rule may occasionally "
                "skip an evaluation rather than fire or resolve incorrectly."
            )
            out[COST_THRESHOLD].warning = note
            out[COST_INCREASE_PERCENT].warning = note
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not probe cost capability for %s: %s", account_id, exc)
        for key in (COST_THRESHOLD, COST_INCREASE_PERCENT):
            out[key].warning = (
                "Billing capability could not be checked just now; this rule can "
                "be saved but may report UNKNOWN.")

    # A baseline comparison needs two full windows of real billed history. One
    # window of data cannot produce a "versus the previous period" number, and
    # inventing one is precisely the fabricated baseline this forbids.
    if out[COST_INCREASE_PERCENT].supported:
        try:
            from app.repository.cost_fact_repo import CostFactRepository

            coverage = await CostFactRepository(db).coverage([account_id])
            days = int(coverage.get("days_covered") or 0)
            if days < 2:
                out[COST_INCREASE_PERCENT] = Support(
                    False,
                    "Historical billing data is insufficient for a baseline: "
                    f"{days} day(s) of billed history are stored for this "
                    "account, and comparing a period against the one before it "
                    "needs at least two. Use a cost threshold instead, or "
                    "backfill cost history from the Cost tab.",
                )
            elif days < 14:
                out[COST_INCREASE_PERCENT].warning = (
                    f"Only {days} day(s) of billed history are stored. A 7- or "
                    "30-day comparison will report UNKNOWN until the baseline "
                    "window is fully covered."
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not probe cost history for %s: %s", account_id, exc)
            out[COST_INCREASE_PERCENT].warning = (
                "Billing history could not be checked just now.")

    # ── Security ─────────────────────────────────────────────────────────────
    try:
        from app.repository.security_repo import SecurityRepository

        latest = await SecurityRepository(db).latest_assessment(account_id)
        if latest is None:
            note = ("This account has never been assessed, so these rules will "
                    "report UNKNOWN — never zero findings — until an assessment "
                    "runs from the Security Center.")
            out[SECURITY_FINDING_COUNT].warning = note
            out[SECURITY_SCORE_BELOW].warning = note
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not probe security state for %s: %s", account_id, exc)

    # ── Events ───────────────────────────────────────────────────────────────
    try:
        from sqlalchemy import func, select

        from app.models.event_admin import (
            SYNC_DISABLED, SYNC_NEVER_RUN, CloudEventSyncState,
        )

        total, live = (await db.execute(
            select(
                func.count(),
                func.count().filter(
                    CloudEventSyncState.status.notin_([SYNC_NEVER_RUN, SYNC_DISABLED])
                ),
            ).where(CloudEventSyncState.account_id == account_id)
        )).one()
        if not total:
            reason = ("Audit-event collection has never run for this account, so "
                      "there is nothing to evaluate. Collect events once from the "
                      "Event Log tab and this condition becomes available.")
            out[EVENT_COUNT] = Support(False, reason)
            out[EVENT_COLLECTION_UNHEALTHY] = Support(False, reason)
        elif not live:
            out[EVENT_COUNT].warning = (
                "Every collection scope for this account is disabled or has "
                "never run, so this rule will report UNKNOWN rather than zero.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not probe event collection for %s: %s", account_id, exc)

    # ── Certificates and secrets ─────────────────────────────────────────────
    try:
        from sqlalchemy import func, select

        from app.models.credential_inventory import CloudCredentialSource

        sources = (await db.execute(
            select(func.count()).select_from(CloudCredentialSource)
            .where(CloudCredentialSource.account_id == account_id)
        )).scalar_one()
        if not sources:
            out[CREDENTIAL_EXPIRY].warning = (
                "Certificates and secrets have not been collected for this account yet. "
                "They are read during every discovery scan; until the next one, this "
                "rule reports that it cannot be evaluated rather than zero.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not probe credential collection for %s: %s", account_id, exc)

    # ── Drift ────────────────────────────────────────────────────────────────
    try:
        from sqlalchemy import func, select

        from app.models.drift import CloudResourceChange

        seen = (await db.execute(
            select(func.count()).select_from(CloudResourceChange)
            .where(CloudResourceChange.account_id == account_id)
        )).scalar_one()
        if not seen:
            out[DRIFT_COUNT].warning = (
                "No configuration changes have been recorded for this account "
                "yet. Drift is captured by comparing successive discovery scans, "
                "so this rule stays quiet until at least two scans have run.")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not probe drift history for %s: %s", account_id, exc)

    return {k: v.to_dict() for k, v in out.items()}


def catalog_payload() -> Dict[str, Any]:
    """The static half of the capabilities response — no account needed."""
    by_category: Dict[str, List[Dict[str, Any]]] = {}
    for cond in CONDITIONS.values():
        by_category.setdefault(cond.category, []).append(cond.to_dict())
    return {
        "categories": [
            {"key": key, "label": CATEGORY_LABELS[key],
             "conditions": by_category.get(key, [])}
            for key in CATEGORY_LABELS
        ],
        "operators": [{"value": o, "label": _OPERATOR_WORDS[o]} for o in OPERATORS],
        "severities": list(SEVERITIES),
        "scope_support": {k: list(v) for k, v in SCOPE_SUPPORT.items()},
    }
