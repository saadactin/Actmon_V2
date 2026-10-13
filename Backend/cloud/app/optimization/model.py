"""The vocabulary of Resource Intelligence — the optimization engine's closed sets.

This sits beside `app/security/model.py`, not inside it, and that separation is
the point. The Security Center answers "where is this estate exposed?"; this
engine answers "what is this estate wasting, straining or neglecting?". Folding
the second into the first is how the security engine ended up carrying six
rules that were never about security at all (stopped instances, Lambda memory,
a large OCI shape), which then had to be excluded from its own score by a
special case. Here they have a home of their own, with evidence of their own.

Four ideas carry the weight:

**A verdict is not a boolean.** A rule concludes FINDING, CLEAR,
INSUFFICIENT_DATA or NOT_APPLICABLE. INSUFFICIENT_DATA is the one that matters:
"CPU telemetry was not available" is emphatically not "this instance is well
sized", and it never produces a recommendation. The spec's rule is that a
recommendation is never manufactured to populate a screen — this is where that
rule is enforced.

**Savings have a method.** A figure is either the resource's own BILLED cost
(from the provider's billing API — deleting an orphaned volume ends exactly
that charge), a LIST_PRICE calculation (from the provider's public price list,
shown line by line), or it is absent with a reason. There is no fourth way to
arrive at a number, so there is no way to arrive at an invented one.

**Identity is deterministic.** A fingerprint is built from provider + account +
rule + the provider's own resource id, never the resource name, so the same
condition on the next analysis is the same finding. That is what gives a
finding an age, a history, and an outcome after it is fixed.

**Categories are a closed set.** A rule declaring a category outside
`OPTIMIZATION_CATEGORIES` is refused at import time. SECURITY and COMPLIANCE
are deliberately outside it: those belong to the security engine, and the
unified view reads them from there rather than re-deriving them.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# ── Severity ─────────────────────────────────────────────────────────────────
# The same five strings the Security Center uses, so one filter serves both.
CRITICAL = "CRITICAL"
HIGH = "HIGH"
MEDIUM = "MEDIUM"
LOW = "LOW"
INFO = "INFO"
SEVERITIES: Tuple[str, ...] = (CRITICAL, HIGH, MEDIUM, LOW, INFO)
SEVERITY_RANK: Dict[str, int] = {s: i for i, s in enumerate(SEVERITIES)}


def severity_rank(severity: Optional[str]) -> int:
    """Worst first; an unrecognised severity sorts last, never first."""
    return SEVERITY_RANK.get((severity or "").upper(), len(SEVERITIES))


# ── Categories ───────────────────────────────────────────────────────────────
SECURITY = "SECURITY"
COST = "COST"
RIGHTSIZING = "RIGHTSIZING"
PERFORMANCE = "PERFORMANCE"
STORAGE = "STORAGE"
NETWORK = "NETWORK"
DATABASE = "DATABASE"
RELIABILITY = "RELIABILITY"
AVAILABILITY = "AVAILABILITY"
CONFIGURATION = "CONFIGURATION"
COMPLIANCE = "COMPLIANCE"
CLEANUP = "CLEANUP"
TAGGING = "TAGGING"

CATEGORIES: Tuple[str, ...] = (
    SECURITY, COST, RIGHTSIZING, PERFORMANCE, STORAGE, NETWORK, DATABASE,
    RELIABILITY, AVAILABILITY, CONFIGURATION, COMPLIANCE, CLEANUP, TAGGING,
)

# What the optimization engine may emit. SECURITY and COMPLIANCE come from the
# security engine only: re-deriving them here is how two engines end up
# disagreeing about the same resource in front of the user.
OPTIMIZATION_CATEGORIES = frozenset(set(CATEGORIES) - {SECURITY, COMPLIANCE})

CATEGORY_LABEL: Dict[str, str] = {
    SECURITY: "Security",
    COST: "Cost",
    RIGHTSIZING: "Rightsizing",
    PERFORMANCE: "Performance",
    STORAGE: "Storage",
    NETWORK: "Network",
    DATABASE: "Database",
    RELIABILITY: "Reliability",
    AVAILABILITY: "Availability",
    CONFIGURATION: "Configuration",
    COMPLIANCE: "Compliance",
    CLEANUP: "Cleanup",
    TAGGING: "Tagging",
}

CATEGORY_MEANING: Dict[str, str] = {
    SECURITY: "Exposure, identity, encryption and data-protection findings from the "
              "Security Center's engine.",
    COST: "Spend that a configuration change would end or reduce.",
    RIGHTSIZING: "Capacity measured against real utilization telemetry.",
    PERFORMANCE: "Resources measured as constrained — CPU, memory, duration, throttling.",
    STORAGE: "Volumes, disks and buckets: attachment, performance tier, lifecycle.",
    NETWORK: "Public IPs, load balancers and gateways, and whether anything uses them.",
    DATABASE: "Database capacity, activity and licensing.",
    RELIABILITY: "Backups, error rates and recoverability.",
    AVAILABILITY: "Redundancy of production resources.",
    CONFIGURATION: "Previous-generation sizes, runtimes and settings with a newer equivalent.",
    COMPLIANCE: "Security findings that breach a mapped compliance control. A lens over "
                "Security findings, so these also count there.",
    CLEANUP: "Resources that appear unused: unattached, stopped, never invoked.",
    TAGGING: "Ownership and allocation tags.",
}

# ── How security-engine findings appear in the unified view ──────────────────
# The security engine's categories are its own vocabulary. Most of them are
# security in any reading; three describe something else and are shown under
# the category an engineer would look for them in. Nothing is re-evaluated —
# the finding is the Security Center's row, displayed under this heading.
SECURITY_CATEGORY_MAP: Dict[str, str] = {
    "Governance": TAGGING,          # the ownership-tag rule
    "Resilience": RELIABILITY,      # geo-redundant backup, ADB auto-scaling
    "Maintenance": CONFIGURATION,   # deprecated runtimes
}

# Security-engine categories NOT shown in the unified view. The security model
# itself calls these "not security risk at all" and keeps them out of its
# score. Every condition they cover (stopped instances, Lambda memory, a large
# OCI shape, a long function timeout) is evaluated here with telemetry and
# billing evidence, so showing both would list the same instance twice with
# two different recommendations.
SUPERSEDED_SECURITY_CATEGORIES = frozenset({"Performance", "Cost"})


def unified_security_category(category: Optional[str]) -> str:
    return SECURITY_CATEGORY_MAP.get(category or "", SECURITY)


# ── Verdicts ─────────────────────────────────────────────────────────────────
FINDING = "FINDING"                     # the condition is present, on evidence
CLEAR = "CLEAR"                         # checked, and the condition is absent
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"  # the evidence needed was not available
NOT_APPLICABLE = "NOT_APPLICABLE"       # the rule does not apply to this resource

VERDICTS: Tuple[str, ...] = (FINDING, CLEAR, INSUFFICIENT_DATA, NOT_APPLICABLE)

VERDICT_LABEL: Dict[str, str] = {
    FINDING: "Condition confirmed",
    CLEAR: "Checked — condition absent",
    INSUFFICIENT_DATA: "Not enough data to decide",
    NOT_APPLICABLE: "Not applicable",
}

# ── Status: what a person has decided ────────────────────────────────────────
OPEN = "OPEN"
ACKNOWLEDGED = "ACKNOWLEDGED"
RESOLVED = "RESOLVED"
SUPPRESSED = "SUPPRESSED"

STATUSES: Tuple[str, ...] = (OPEN, ACKNOWLEDGED, RESOLVED, SUPPRESSED)
ACTIVE_STATUSES = frozenset({OPEN, ACKNOWLEDGED})
STATUS_REQUIRES_REASON = frozenset({SUPPRESSED})

STATUS_LABEL: Dict[str, str] = {
    OPEN: "Open",
    ACKNOWLEDGED: "Acknowledged",
    RESOLVED: "Resolved",
    SUPPRESSED: "Suppressed",
}

# The Security Center has five statuses; the unified filter has four. Each
# security status is shown under the group that means the same thing to the
# person triaging — and the card still prints the security status's own label,
# so "Risk accepted" is never relabelled as something it is not.
SECURITY_STATUS_GROUP: Dict[str, str] = {
    "OPEN": OPEN,
    "IN_PROGRESS": ACKNOWLEDGED,
    "RESOLVED": RESOLVED,
    "SUPPRESSED": SUPPRESSED,
    "ACCEPTED_RISK": SUPPRESSED,
}
# The reverse, for turning a unified filter into the security engine's terms.
STATUS_GROUP_TO_SECURITY: Dict[str, Tuple[str, ...]] = {
    OPEN: ("OPEN",),
    ACKNOWLEDGED: ("IN_PROGRESS",),
    RESOLVED: ("RESOLVED",),
    SUPPRESSED: ("SUPPRESSED", "ACCEPTED_RISK"),
}

# ── Confidence: how much the finding can be relied on ────────────────────────
CONF_HIGH = "HIGH"
CONF_MEDIUM = "MEDIUM"
CONF_LOW = "LOW"
CONFIDENCES: Tuple[str, ...] = (CONF_HIGH, CONF_MEDIUM, CONF_LOW)
CONFIDENCE_LABEL: Dict[str, str] = {
    CONF_HIGH: "High — every input the rule needs was measured",
    CONF_MEDIUM: "Medium — the condition is measured; part of the picture is not",
    CONF_LOW: "Low — indicative only; confirm before acting",
}

# ── Risk of applying the recommendation ──────────────────────────────────────
RISK_LOW = "LOW"
RISK_MEDIUM = "MEDIUM"
RISK_HIGH = "HIGH"
RISKS: Tuple[str, ...] = (RISK_LOW, RISK_MEDIUM, RISK_HIGH)

# ── "Can I safely apply this?" ───────────────────────────────────────────────
SAFE = "SAFE"                  # reversible, and every precondition was verified
WITH_CARE = "WITH_CARE"        # reversible, but needs validation or a window
CONFIRM_FIRST = "CONFIRM_FIRST"  # irreversible, or depends on something unmeasured
SAFETY_UNKNOWN = "UNKNOWN"
SAFETY_LABEL: Dict[str, str] = {
    SAFE: "Safe to apply",
    WITH_CARE: "Apply with care",
    CONFIRM_FIRST: "Confirm before applying",
    SAFETY_UNKNOWN: "Cannot be determined",
}
CHECK_PASS = "PASS"
CHECK_FAIL = "FAIL"
CHECK_UNKNOWN = "UNKNOWN"

# ── How a savings figure was arrived at ──────────────────────────────────────
SAVINGS_BILLED = "BILLED"          # the resource's own billed cost, which the action ends
SAVINGS_LIST_PRICE = "LIST_PRICE"  # arithmetic over the provider's public price list
SAVINGS_NONE = "NONE"              # not quantified; `reason` says why
SAVINGS_METHODS: Tuple[str, ...] = (SAVINGS_BILLED, SAVINGS_LIST_PRICE, SAVINGS_NONE)

# ── Analysis run outcome ─────────────────────────────────────────────────────
RUN_COMPLETE = "COMPLETE"
RUN_PARTIAL = "PARTIAL"
RUN_FAILED = "FAILED"

# ── Evidence kinds, so the UI can say where each value came from ─────────────
EV_TELEMETRY = "telemetry"
EV_CONFIGURATION = "configuration"
EV_BILLING = "billing"
EV_PRICE = "price"
EV_INVENTORY = "inventory"
EV_DERIVED = "derived"

# ── Providers ────────────────────────────────────────────────────────────────
AWS = "AWS"
AZURE = "AZURE"
OCI = "OCI"
PROVIDERS: Tuple[str, ...] = (AWS, AZURE, OCI)
_PROVIDER_ALIASES = {
    "AWS": AWS, "AMAZON": AWS,
    "AZURE": AZURE, "MICROSOFT": AZURE,
    "OCI": OCI, "ORACLE": OCI, "ORACLECLOUD": OCI,
}


def normalize_provider(provider: Optional[str]) -> Optional[str]:
    """Canonical provider token, or None — never a guess."""
    if not provider:
        return None
    return _PROVIDER_ALIASES.get(provider.strip().upper().replace(" ", "").replace("_", ""))


def fingerprint(*, provider: str, account_id: str, rule_id: str,
                resource_key: Optional[str] = None,
                discriminator: Optional[str] = None) -> str:
    """Deterministic identity for one optimization finding.

    Prefixed so it can never collide with a security fingerprint in the unified
    list, which keys on (source, fingerprint) anyway — belt and braces, because
    a collision there would silently merge two unrelated findings' histories.
    """
    raw = "|".join([
        "OPT", (provider or "?").upper(), str(account_id or "?"), rule_id or "?",
        resource_key or "-", discriminator or "-",
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


# ── Small constructors, so every rule builds the same shapes ─────────────────

def evidence(label: str, value: Any, *, unit: Optional[str] = None,
             display: Optional[str] = None, kind: str = EV_CONFIGURATION,
             source: Optional[str] = None, detail: Optional[str] = None) -> Dict[str, Any]:
    """One value a conclusion rests on, with where it came from."""
    if display is None and value is not None:
        display = f"{value:,.2f}" if isinstance(value, float) else str(value)
    return {"label": label, "value": value, "unit": unit, "display": display,
            "kind": kind, "source": source, "detail": detail}


def data_source(key: str, label: str, available: bool, detail: Optional[str] = None,
                *, required: bool = True) -> Dict[str, Any]:
    """One input the rule wanted, and whether it had it — the ✓/✗ list."""
    return {"key": key, "label": label, "available": bool(available),
            "detail": detail, "required": required}


def check(label: str, state: str, detail: Optional[str] = None) -> Dict[str, Any]:
    return {"label": label, "state": state, "detail": detail}


@dataclass
class Savings:
    """A savings figure and how it was arrived at — or why there is none."""

    method: str = SAVINGS_NONE
    amount: Optional[float] = None       # per month
    currency: Optional[str] = None
    basis: Optional[str] = None          # one sentence: where the number came from
    breakdown: List[Dict[str, Any]] = field(default_factory=list)
    assumptions: List[str] = field(default_factory=list)
    reason: Optional[str] = None         # why there is no figure

    @property
    def priced(self) -> bool:
        return self.method != SAVINGS_NONE and self.amount is not None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method if self.priced else SAVINGS_NONE,
            "amount": round(self.amount, 2) if self.priced else None,
            "currency": self.currency if self.priced else None,
            "basis": self.basis if self.priced else None,
            "breakdown": self.breakdown if self.priced else [],
            "assumptions": self.assumptions,
            "reason": None if self.priced else (
                self.reason or "No provider billing or price-list figure supports a "
                               "saving for this recommendation."),
            "priced": self.priced,
        }


def no_savings(reason: str, *, assumptions: Optional[List[str]] = None) -> Savings:
    return Savings(method=SAVINGS_NONE, reason=reason, assumptions=list(assumptions or []))


@dataclass
class OptimizationFinding:
    """One canonical optimization finding. Built by the engine, persisted by
    the repository, and read back for every view."""

    rule_id: str
    rule_version: str
    provider: str
    account_id: str
    fingerprint: str
    category: str
    severity: str
    title: str
    description: str
    rationale: str
    recommendation: str
    resource_key: Optional[str] = None
    resource_id: Optional[str] = None
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None
    region: Optional[str] = None
    confidence: str = CONF_MEDIUM
    confidence_reasons: List[str] = field(default_factory=list)
    evidence: List[Dict[str, Any]] = field(default_factory=list)
    current_configuration: Dict[str, Any] = field(default_factory=dict)
    recommended_configuration: Optional[Dict[str, Any]] = None
    savings: Savings = field(default_factory=Savings)
    risk: str = RISK_MEDIUM
    risk_notes: List[str] = field(default_factory=list)
    impact: Dict[str, str] = field(default_factory=dict)
    safety: Dict[str, Any] = field(default_factory=dict)
    data_sources: List[Dict[str, Any]] = field(default_factory=list)
    remediation: Optional[str] = None
    metrics_used: List[str] = field(default_factory=list)
    detected_at: Optional[datetime] = None
    # UNUSED / UNDERUTILIZED / CONSTRAINED / CONFIGURATION / RISK — what kind of
    # opportunity this is, independent of category. The summary cards count it.
    signal: Optional[str] = None
    effort: Optional[str] = None
    # A saving that needs an async price lookup, resolved after the pure run.
    pricing_request: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fingerprint": self.fingerprint,
            "rule_id": self.rule_id,
            "rule_version": self.rule_version,
            "provider": self.provider,
            "account_id": self.account_id,
            "resource_key": self.resource_key,
            "resource_id": self.resource_id,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "region": self.region,
            "category": self.category,
            "severity": self.severity,
            "title": self.title,
            "description": self.description,
            "rationale": self.rationale,
            "recommendation": self.recommendation,
            "remediation": self.remediation,
            "confidence": self.confidence,
            "confidence_reasons": self.confidence_reasons,
            "evidence": self.evidence,
            "current_configuration": self.current_configuration,
            "recommended_configuration": self.recommended_configuration,
            "savings": self.savings.to_dict(),
            "risk": self.risk,
            "risk_notes": self.risk_notes,
            "impact": self.impact,
            "safety": self.safety,
            "data_sources": self.data_sources,
            "metrics_used": self.metrics_used,
            "signal": self.signal,
            "effort": self.effort,
        }
