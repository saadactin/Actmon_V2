"""The canonical vocabulary of the Security & Compliance Center.

Everything downstream — the rule registry, the exposure and IAM analysers, the
compliance mapper, the alert-policy engine, the score and the UI — reads its
constants from here. That is the point: the previous design had three services
each inventing its own severity strings, its own category names and its own
notion of "this resource is fine", so Security, Compliance and Alerts could
disagree about the same resource and nobody could tell which was right.

Four ideas in this module carry most of the weight:

**VERDICT is not a boolean.** A rule evaluates to one of five outcomes, and the
three that are not SAFE/VULNERABLE are the ones that matter. `UNKNOWN` means
the data needed to decide was absent — which is emphatically not `SAFE`. The
old engine had no way to say this, so `config.get("endpoint_type", "PUBLIC")`
turned an absent field into a CRITICAL-adjacent finding on three AWS gateways,
and an Azure VM whose NICs were never collected silently vanished from
exposure analysis and rendered as "No internet exposure found".

**Identity is deterministic and provider-scoped.** `fingerprint()` is built
from provider + account + rule + the provider's own resource id — never the
resource NAME, which is not unique inside one account let alone across three
clouds. This is what lets a finding persist across scans, accumulate history,
and be pointed at by an alert.

**Severity is what the rule declares; score impact is negotiated separately.**
A LOW governance finding is still worth showing 550 times. It is not worth
550 score deductions. Those are different questions and `scoring.py` answers
the second one.

**A category is a closed set.** Free-text categories are how the old
compliance mapper ended up silently dropping half the findings: a rule wrote
`category="Maintenance"`, the control map had no key for it, and the finding
disappeared from Compliance with no diagnostic anywhere.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# ── Severity ─────────────────────────────────────────────────────────────────
# Deliberately the same five strings the old services used, so existing
# alerts, drift records and notification routing keep working unchanged.
CRITICAL = "CRITICAL"
HIGH = "HIGH"
MEDIUM = "MEDIUM"
LOW = "LOW"
INFO = "INFO"

SEVERITIES: Tuple[str, ...] = (CRITICAL, HIGH, MEDIUM, LOW, INFO)

# Sort order for "worst first" everywhere. A CRITICAL must never sort below a
# MEDIUM, which is a bug the old compliance service had to fix after shipping.
SEVERITY_RANK: Dict[str, int] = {s: i for i, s in enumerate(SEVERITIES)}


def severity_rank(severity: Optional[str]) -> int:
    """Rank for sorting; an unrecognised severity sorts last, never first."""
    return SEVERITY_RANK.get((severity or "").upper(), len(SEVERITIES))


def worst_severity(severities) -> Optional[str]:
    """The most severe of a collection, or None if empty."""
    known = [s for s in severities if (s or "").upper() in SEVERITY_RANK]
    if not known:
        return None
    return min(known, key=severity_rank)


# ── Verdict: what a rule concluded ───────────────────────────────────────────
# The heart of the "never turn missing data into a vulnerability" rule (§10).
VULNERABLE = "VULNERABLE"      # the condition is present and confirmed
SAFE = "SAFE"                  # the condition was checked and is absent
UNKNOWN = "UNKNOWN"            # the field(s) needed to decide were not available
NOT_APPLICABLE = "NOT_APPLICABLE"  # this rule does not apply to this resource
NOT_SCANNED = "NOT_SCANNED"    # nothing collects the data this rule needs

VERDICTS: Tuple[str, ...] = (VULNERABLE, SAFE, UNKNOWN, NOT_APPLICABLE, NOT_SCANNED)

# Only these two produce a persisted finding. SAFE and NOT_APPLICABLE are the
# silent majority; NOT_SCANNED is recorded once per rule as a coverage gap
# rather than once per resource, which is why it is in this set but handled
# specially by the engine.
VERDICTS_WITH_FINDING = frozenset({VULNERABLE, UNKNOWN})

# Human labels. The UI must never print the raw token — "NOT_APPLICABLE" tells
# an analyst nothing about whether they need to act.
VERDICT_LABEL: Dict[str, str] = {
    VULNERABLE: "Condition confirmed",
    SAFE: "Checked — condition absent",
    UNKNOWN: "Could not be determined",
    NOT_APPLICABLE: "Not applicable to this resource",
    NOT_SCANNED: "Not collected by the scanner",
}


# ── Confidence: how much the verdict can be relied on ────────────────────────
CONF_HIGH = "HIGH"        # exact match on data the provider itself reported
CONF_MEDIUM = "MEDIUM"    # correct modelling, known approximation in the edges
CONF_LOW = "LOW"          # heuristic — indicative, needs human confirmation
CONF_UNKNOWN = "UNKNOWN"  # required inputs missing; the verdict is a guess

CONFIDENCES: Tuple[str, ...] = (CONF_HIGH, CONF_MEDIUM, CONF_LOW, CONF_UNKNOWN)

CONFIDENCE_LABEL: Dict[str, str] = {
    CONF_HIGH: "High — provider-reported configuration matched exactly",
    CONF_MEDIUM: "Medium — modelled correctly, with a stated approximation",
    CONF_LOW: "Low — heuristic indicator, confirm before acting",
    CONF_UNKNOWN: "Unknown — required data was not available",
}

# A finding whose confidence is below this does not contribute to the security
# score. It is still shown, still filterable, still mappable to a control — it
# just cannot silently move a number an operator is judged on.
SCORING_CONFIDENCE_FLOOR = CONF_MEDIUM
_CONF_RANK = {c: i for i, c in enumerate(CONFIDENCES)}


def scores_toward_total(confidence: Optional[str]) -> bool:
    return _CONF_RANK.get((confidence or "").upper(), 99) <= _CONF_RANK[SCORING_CONFIDENCE_FLOOR]


# ── Finding status: the remediation lifecycle ────────────────────────────────
OPEN = "OPEN"
RESOLVED = "RESOLVED"
SUPPRESSED = "SUPPRESSED"
ACCEPTED_RISK = "ACCEPTED_RISK"
IN_PROGRESS = "IN_PROGRESS"

FINDING_STATUSES: Tuple[str, ...] = (OPEN, IN_PROGRESS, RESOLVED, SUPPRESSED, ACCEPTED_RISK)

# States that mean "this is still a live problem someone must deal with".
# SUPPRESSED and ACCEPTED_RISK are deliberate human decisions and are excluded
# from the score and from alert evaluation — but never deleted, and always
# carrying who decided and why.
ACTIVE_FINDING_STATUSES = frozenset({OPEN, IN_PROGRESS})
# A decision was made about it; it is not evidence of an unmanaged risk.
MUTED_FINDING_STATUSES = frozenset({SUPPRESSED, ACCEPTED_RISK})

STATUS_LABEL: Dict[str, str] = {
    OPEN: "Open",
    IN_PROGRESS: "In progress",
    RESOLVED: "Resolved",
    SUPPRESSED: "Suppressed",
    ACCEPTED_RISK: "Risk accepted",
}

# Transitions a user may request, and whether a written reason is mandatory.
# Suppressing a CRITICAL exposure finding without saying why is exactly the
# kind of act that needs to be defensible six months later.
STATUS_REQUIRES_REASON = frozenset({SUPPRESSED, ACCEPTED_RISK})


# ── Categories ───────────────────────────────────────────────────────────────
# Closed set. A rule declaring a category outside this tuple is rejected at
# import time by registry.py rather than silently dropping out of Compliance.
CAT_IAM = "Identity & Access"
CAT_NETWORKING = "Networking"
CAT_EXPOSURE = "Exposure"
CAT_ENCRYPTION = "Encryption"
CAT_DATA_PROTECTION = "Data Protection"
CAT_CONFIGURATION = "Configuration"
CAT_LOGGING = "Logging & Monitoring"
CAT_RESILIENCE = "Resilience"
CAT_GOVERNANCE = "Governance"
CAT_PERFORMANCE = "Performance"
CAT_MAINTENANCE = "Maintenance"
CAT_COST = "Cost"

CATEGORIES: Tuple[str, ...] = (
    CAT_IAM, CAT_NETWORKING, CAT_EXPOSURE, CAT_ENCRYPTION, CAT_DATA_PROTECTION,
    CAT_CONFIGURATION, CAT_LOGGING, CAT_RESILIENCE, CAT_GOVERNANCE,
    CAT_PERFORMANCE, CAT_MAINTENANCE, CAT_COST,
)

# Categories that are not security risk at all. They stay visible — an idle
# instance still costs money and a deprecated runtime still needs upgrading —
# but they are excluded from the security score and from compliance control
# mapping, because calling a 128 MB Lambda a control violation devalues the
# word. This is the explicit, reviewable version of what the old compliance
# service achieved by leaving keys out of a dict.
NON_SECURITY_CATEGORIES = frozenset({CAT_PERFORMANCE, CAT_COST})

# Hygiene: real, worth fixing, and dominated by volume. Its total score
# contribution is capped hard (see scoring.py) so 550 missing Owner tags can
# never outweigh one publicly-reachable database.
HYGIENE_CATEGORIES = frozenset({CAT_GOVERNANCE, CAT_MAINTENANCE})


# ── Providers ────────────────────────────────────────────────────────────────
AWS = "AWS"
AZURE = "AZURE"
OCI = "OCI"
PROVIDERS: Tuple[str, ...] = (AWS, AZURE, OCI)

# The provider column on cloud_accounts is not normalised ("Azure", "OCI",
# "AWS", and "ORACLE" appears in the older IAM service). One place decides.
_PROVIDER_ALIASES = {
    "AWS": AWS, "AMAZON": AWS,
    "AZURE": AZURE, "MICROSOFT": AZURE, "MSAZURE": AZURE,
    "OCI": OCI, "ORACLE": OCI, "ORACLECLOUD": OCI,
}


def normalize_provider(provider: Optional[str]) -> Optional[str]:
    """Canonical provider token, or None when unrecognised.

    Returning None rather than guessing matters: a rule registry keyed by
    provider must not run AWS rules against an unknown provider's resources,
    which is the class of bug that had OCI's API-Gateway rule firing on AWS.
    """
    if not provider:
        return None
    return _PROVIDER_ALIASES.get(provider.strip().upper().replace(" ", "").replace("_", ""))


# ── Exposure verdicts ────────────────────────────────────────────────────────
# Separate from rule verdicts because exposure answers a different question
# ("can the internet reach this?") and has its own resolution failure modes.
EXPOSED = "EXPOSED"
PROTECTED = "PROTECTED"
EXPOSURE_UNKNOWN = "UNKNOWN"
EXPOSURE_NOT_APPLICABLE = "NOT_APPLICABLE"

EXPOSURE_VERDICTS: Tuple[str, ...] = (EXPOSED, PROTECTED, EXPOSURE_UNKNOWN, EXPOSURE_NOT_APPLICABLE)

EXPOSURE_VERDICT_LABEL: Dict[str, str] = {
    EXPOSED: "Reachable from the internet",
    PROTECTED: "Not reachable — every path checked and closed",
    EXPOSURE_UNKNOWN: "Reachability could not be determined",
    EXPOSURE_NOT_APPLICABLE: "No internet-facing address",
}


# ── Coverage dimensions ──────────────────────────────────────────────────────
# What data the assessment needed, and how much of it was actually there. This
# is a data-availability metric, NOT a security score — the same distinction
# the topology coverage score makes, for the same reason: without it, "we could
# not evaluate this" is indistinguishable from "this is fine".
COV_INVENTORY = "inventory"
COV_NETWORK = "network"
COV_IAM = "iam"
COV_EXPOSURE = "exposure"
COV_ENCRYPTION = "encryption"

COVERAGE_DIMENSIONS: Tuple[str, ...] = (
    COV_INVENTORY, COV_NETWORK, COV_IAM, COV_EXPOSURE, COV_ENCRYPTION,
)

COVERAGE_LABEL: Dict[str, str] = {
    COV_INVENTORY: "Resource inventory",
    COV_NETWORK: "Network relationships",
    COV_IAM: "Identity & access",
    COV_EXPOSURE: "Internet exposure",
    COV_ENCRYPTION: "Encryption state",
}

COVERAGE_MEANING: Dict[str, str] = {
    COV_INVENTORY: "Whether the last sweep enumerated every scope it tried.",
    COV_NETWORK: "Whether NIC / subnet / security-group relationships resolved.",
    COV_IAM: "Whether identity policy documents were collected and parseable.",
    COV_EXPOSURE: "Whether every public-facing resource resolved to a rule set.",
    COV_ENCRYPTION: "Whether encryption state was reported for encryptable resources.",
}


# ── Assessment run outcome ───────────────────────────────────────────────────
ASSESS_COMPLETE = "COMPLETE"
ASSESS_PARTIAL = "PARTIAL"
ASSESS_FAILED = "FAILED"

# An assessment built on an incomplete sweep must never resolve findings: an
# absent resource then means "failed to enumerate", not "fixed". Same rule the
# inventory prune and the storage-alert auto-resolve already follow.
ASSESS_MAY_RESOLVE = frozenset({ASSESS_COMPLETE})


def fingerprint(*, provider: str, account_id: str, rule_id: str,
                resource_key: Optional[str] = None,
                discriminator: Optional[str] = None) -> str:
    """Deterministic identity for a finding.

    Built from provider + account + rule + the PROVIDER's own resource id.
    Deliberately not from resource_name (not unique within an account) and not
    from our own UUID primary key (re-created resources get a new one, which
    would read as "old finding resolved, new finding appeared" for what is the
    same unfixed problem on the same instance).

    `discriminator` separates several findings of one rule on one resource —
    e.g. one exposure finding per open port — so they resolve independently.

    A rule with no resource (an account-wide finding such as a score threshold)
    passes resource_key=None and gets a stable account-scoped identity.
    """
    parts = [
        (provider or "?").upper(),
        str(account_id or "?"),
        rule_id or "?",
        resource_key or "-",
        discriminator or "-",
    ]
    raw = "|".join(parts)
    # Hashed rather than stored raw: an ARN or OCID plus a rule id can exceed
    # a sane index width, and the fingerprint is only ever compared for
    # equality. The readable parts are all stored as columns beside it.
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


@dataclass
class SecurityFinding:
    """One canonical finding. The single unit Security, Compliance and Alerts
    all read — none of them may invent their own.

    Constructed by the engine, persisted by FindingRepository, and re-hydrated
    from the table for every read path. The API shape is `to_dict()`.
    """

    # Identity
    rule_id: str
    rule_version: str
    provider: str
    account_id: str
    fingerprint: str

    # What it is about. resource_key is the PROVIDER's id (ARN / ARM id / OCID)
    # and is the durable pointer; resource_id is our UUID, useful for joining
    # to the local tables but not for identity.
    resource_key: Optional[str] = None
    resource_id: Optional[str] = None
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None
    region: Optional[str] = None

    # Presentation
    title: str = ""
    description: str = ""
    rationale: str = ""          # why it matters — never "improve security"
    remediation: str = ""        # provider-specific, actionable

    # Assessment
    severity: str = MEDIUM
    category: str = CAT_CONFIGURATION
    verdict: str = VULNERABLE
    confidence: str = CONF_HIGH
    status: str = OPEN

    # The provider-reported values the verdict was derived from. This is what
    # makes a finding defensible: an analyst can read the evidence and check
    # the conclusion without trusting the engine.
    evidence: Dict[str, Any] = field(default_factory=dict)

    # Compliance control references, resolved by compliance.py from the rule's
    # declared control ids. Metadata on one finding — never a duplicate finding
    # per framework.
    compliance: Dict[str, List[str]] = field(default_factory=dict)

    # Freshness. All three are distinct and the UI must not conflate them.
    first_detected_at: Optional[datetime] = None
    last_detected_at: Optional[datetime] = None
    last_verified_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    resource_last_discovered_at: Optional[datetime] = None
    discovery_scan_id: Optional[str] = None

    # Remediation workflow
    assigned_to: Optional[str] = None
    status_reason: Optional[str] = None
    status_changed_by: Optional[str] = None
    status_changed_at: Optional[datetime] = None

    # Set by the engine when a rule aggregates (§53): one finding standing for
    # N resources, with the full list available for drill-down.
    affected_count: int = 1
    affected_sample: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        def iso(dt):
            return dt.isoformat() if dt else None

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
            "title": self.title,
            "description": self.description,
            "rationale": self.rationale,
            "remediation": self.remediation,
            "severity": self.severity,
            "category": self.category,
            "verdict": self.verdict,
            "verdict_label": VERDICT_LABEL.get(self.verdict, self.verdict),
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABEL.get(self.confidence, self.confidence),
            "status": self.status,
            "status_label": STATUS_LABEL.get(self.status, self.status),
            "evidence": self.evidence,
            "compliance": self.compliance,
            "first_detected_at": iso(self.first_detected_at),
            "last_detected_at": iso(self.last_detected_at),
            "last_verified_at": iso(self.last_verified_at),
            "resolved_at": iso(self.resolved_at),
            "resource_last_discovered_at": iso(self.resource_last_discovered_at),
            "discovery_scan_id": self.discovery_scan_id,
            "assigned_to": self.assigned_to,
            "status_reason": self.status_reason,
            "status_changed_by": self.status_changed_by,
            "status_changed_at": iso(self.status_changed_at),
            "affected_count": self.affected_count,
            "affected_sample": self.affected_sample,
            "scores": scores_toward_total(self.confidence)
            and self.category not in NON_SECURITY_CATEGORIES,
        }
