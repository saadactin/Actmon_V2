"""The compliance control catalog, and the honest arithmetic over it.

The old compliance service returned `score: None` for every framework, which
was the right call at the time for the right reason — it had no control catalog,
so any percentage would have been invented. But `NA` on every tile is not a
destination, and the fix is not to start dividing findings by findings and
calling it compliance.

What makes a real number possible is declaring the catalog explicitly: each
control below names the `rule_id`s that assess it. That gives every control a
computable state, and the states give arithmetic that is actually defensible:

    ASSESSED = PASS + FAIL + PARTIAL + UNKNOWN     (a rule ran)
    NOT_EVALUATED                                   (no rule in this build covers it)
    NOT_APPLICABLE                                  (no resource of the relevant kind exists)

    control_pass_rate = PASS / (PASS + FAIL + PARTIAL)
    assessment_coverage = ASSESSED / (ASSESSED + NOT_EVALUATED)

Both numbers are reported, always together, and the second is what stops the
first from lying. A tenancy where we assess 9 of 60 controls and pass 8 of 9
is **89% of assessed controls passing, with 15% assessment coverage** — which
is a true statement, and nothing like "89% SOC 2 compliant".

Three rules this module exists to enforce:

* **NOT_EVALUATED is never counted as PASS.** It is excluded from the pass rate
  entirely and reported as its own number, because a control nobody checked is
  the one most likely to be failing.
* **UNKNOWN is never counted as PASS.** A control whose evidence could not be
  collected counts against the pass rate, not for it.
* **No certification language.** The word "compliant" does not appear in any
  output of this module. The framework references are informative cross-walks
  to published control text, which is genuinely useful for pointing an auditor
  at a clause — and is not an assessment against the framework's own catalog.
"""
from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional, Tuple

# ── Control states (§24) ─────────────────────────────────────────────────────
PASS = "PASS"
FAIL = "FAIL"
PARTIAL = "PARTIAL"
NOT_EVALUATED = "NOT_EVALUATED"
NOT_APPLICABLE = "NOT_APPLICABLE"
UNKNOWN = "UNKNOWN"

CONTROL_STATES: Tuple[str, ...] = (
    FAIL, PARTIAL, UNKNOWN, PASS, NOT_APPLICABLE, NOT_EVALUATED,
)
# Worst first, so a FAIL never sorts below a PASS.
CONTROL_STATE_RANK: Dict[str, int] = {s: i for i, s in enumerate(CONTROL_STATES)}

CONTROL_STATE_LABEL: Dict[str, str] = {
    PASS: "Passed",
    FAIL: "Failed",
    PARTIAL: "Partially failed",
    UNKNOWN: "Evidence unavailable",
    NOT_APPLICABLE: "Not applicable",
    NOT_EVALUATED: "Not evaluated by this build",
}

CONTROL_STATE_MEANING: Dict[str, str] = {
    PASS: "Every check covering this control ran and found no violation.",
    FAIL: "At least one check covering this control found a confirmed violation.",
    PARTIAL: "Some checks passed; at least one could not be evaluated.",
    UNKNOWN: "Checks ran but the provider data needed to decide was unavailable.",
    NOT_APPLICABLE: "No resource in this account is in scope for this control.",
    NOT_EVALUATED: "No check in this build assesses this control.",
}

# States that go into the pass-rate denominator. UNKNOWN is in; NOT_EVALUATED
# and NOT_APPLICABLE are out. That single line is the difference between an
# honest metric and a flattering one.
RATED_STATES = frozenset({PASS, FAIL, PARTIAL, UNKNOWN})

SOC2 = "SOC2"
HIPAA = "HIPAA"
PCI = "PCI-DSS"
FRAMEWORKS: Tuple[str, ...] = (SOC2, HIPAA, PCI)

FRAMEWORK_META: Dict[str, Dict[str, str]] = {
    SOC2: {
        "label": "SOC 2",
        "full_name": "SOC 2 Trust Services Criteria (2017)",
        "note": "Cross-walk to the published TSC. Not an audit and not an opinion.",
    },
    HIPAA: {
        "label": "HIPAA",
        "full_name": "HIPAA Security Rule, 45 CFR §164 Subpart C",
        "note": "Cross-walk to the published safeguards. Technical safeguards only.",
    },
    PCI: {
        "label": "PCI-DSS",
        "full_name": "PCI-DSS v4.0",
        "note": "Cross-walk to the published requirements. Not a QSA assessment.",
    },
}


class Control(NamedTuple):
    """One control we claim to assess, and exactly what assesses it."""

    framework: str
    control_id: str
    title: str
    # What the control requires, in the framework's own terms.
    requirement: str
    # The rule_ids whose findings decide this control's state. A control with
    # an empty tuple is declared but NOT_EVALUATED — listed on purpose, so the
    # catalog shows what is missing instead of hiding it.
    rules: Tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.framework}:{self.control_id}"


# ── Rule groups ──────────────────────────────────────────────────────────────
# Named here so a control cites a concept, not a list that drifts when a rule
# is added. Every id must exist in registry.RULES — verified at import time by
# registry.py's self-check, so a typo fails fast rather than silently producing
# a NOT_EVALUATED control.

_PUBLIC_ACCESS_RULES = (
    "AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED",
    "AZURE_STORAGE_BLOB_PUBLIC_ACCESS",
    "OCI_BUCKET_PUBLIC_ACCESS",
    "AWS_RDS_PUBLICLY_ACCESSIBLE",
    "AZURE_DB_PUBLIC_NETWORK_ACCESS",
)
_EXPOSURE_RULES = (
    "EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",
    "EXPOSURE_DATA_PORT_WORLD_OPEN",
    "EXPOSURE_PORT_WORLD_OPEN",
    "EXPOSURE_ALL_PORTS_WORLD_OPEN",
    "EXPOSURE_UNDETERMINED",
)
_SG_RULES = (
    # The world-open checks are the authoritative ones; the rule-count checks
    # are low-confidence indicators that ride along on the same controls.
    "AWS_SG_SSH_WORLD_OPEN",
    "AWS_SG_RDP_WORLD_OPEN",
    "AZURE_NSG_SSH_WORLD_OPEN",
    "AZURE_NSG_RDP_WORLD_OPEN",
    "OCI_NSG_SSH_WORLD_OPEN",
    "OCI_NSG_RDP_WORLD_OPEN",
    "OCI_SECLIST_SSH_WORLD_OPEN",
    "OCI_SECLIST_RDP_WORLD_OPEN",
    "AWS_SG_DEFAULT_IN_USE",
    "AWS_SG_PERMISSIVE_RULE_COUNT",
    "AZURE_NSG_PERMISSIVE_RULE_COUNT",
    "OCI_NSG_PERMISSIVE_RULE_COUNT",
    "OCI_SECURITY_LIST_PERMISSIVE_RULE_COUNT",
)
_ENCRYPTION_RULES = (
    "AWS_RDS_ENCRYPTION_DISABLED",
    "AWS_S3_ENCRYPTION_DISABLED",
    "AWS_DYNAMODB_AWS_OWNED_KEY",
    "AZURE_SQL_TDE_NOT_COLLECTED",
    "OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",
)
_IAM_RULES = (
    "AWS_IAM_ROLE_WILDCARD_FULL",
    "AWS_IAM_ROLE_WILDCARD_WRITE",
    "AWS_IAM_ROLE_ESCALATION",
    "AWS_IAM_ROLE_LONG_SESSION",
    "OCI_IAM_POLICY_TENANCY_ADMIN",
    "OCI_IAM_POLICY_ESCALATION",
    "OCI_IAM_POLICY_BROAD_MANAGE",
    "AZURE_RBAC_SUBSCRIPTION_OWNER",
    "AZURE_RBAC_ESCALATION",
    "AZURE_RBAC_BROAD_WRITE",
    "AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED",
    "AZURE_RBAC_NOT_COLLECTED",
)
_ENDPOINT_RULES = (
    "OCI_OKE_PUBLIC_ENDPOINT",
    "OCI_APIGW_PUBLIC_ENDPOINT",
)
_GOVERNANCE_RULES = ("GOVERNANCE_MISSING_OWNERSHIP_TAGS",)


# ── The catalog ──────────────────────────────────────────────────────────────
# Scoped honestly: these are the controls this build has evidence for, plus a
# deliberate handful of declared-but-unassessed ones (empty `rules`) that a
# cloud posture tool is expected to cover. Those render as NOT_EVALUATED and
# drag assessment_coverage down, which is the intended behaviour — the gap is
# the useful information.

CONTROLS: Tuple[Control, ...] = (
    # ── SOC 2 ────────────────────────────────────────────────────────────────
    Control(SOC2, "CC6.1", "Logical access security",
            "Logical access security software, infrastructure, and architectures are "
            "implemented to protect information assets.",
            _ENCRYPTION_RULES + _PUBLIC_ACCESS_RULES),
    Control(SOC2, "CC6.2", "Access provisioning and removal",
            "Prior to issuing credentials, users are registered and authorised; access "
            "is removed when no longer required.",
            ()),  # needs user/credential inventory — not collected
    Control(SOC2, "CC6.3", "Least privilege",
            "Access to information assets is authorised and modified based on roles and "
            "the principle of least privilege.",
            _IAM_RULES),
    Control(SOC2, "CC6.6", "Boundary protection",
            "Logical access security measures protect against threats from sources "
            "outside the system boundary.",
            _EXPOSURE_RULES + _SG_RULES + _ENDPOINT_RULES),
    Control(SOC2, "CC6.7", "Transmission and movement of information",
            "Information in transit is protected during transmission and movement.",
            ("AWS_ELB_INSECURE_LISTENER",)),
    Control(SOC2, "CC6.8", "Malicious software prevention",
            "Controls prevent or detect the introduction of unauthorised or malicious "
            "software.", ()),  # endpoint protection state is not collected
    Control(SOC2, "CC7.1", "Configuration and vulnerability monitoring",
            "Detection and monitoring procedures identify configuration changes and "
            "vulnerabilities.",
            ("AWS_LAMBDA_DEPRECATED_RUNTIME",)),
    Control(SOC2, "CC7.2", "Security event monitoring",
            "The system is monitored for anomalies indicative of a security event.",
            ()),  # provider audit-log configuration state is not collected
    Control(SOC2, "CC8.1", "Change management",
            "Changes to infrastructure and configuration are authorised, designed, "
            "tested and approved.", ()),
    Control(SOC2, "C1.1", "Confidentiality — data retention and disposal",
            "Confidential information is protected during retention and identified for "
            "disposal when no longer needed.",
            ("AWS_S3_VERSIONING_DISABLED",)),
    Control(SOC2, "A1.2", "Availability — recovery",
            "Environmental protections, backup and recovery infrastructure are "
            "authorised, designed and maintained.",
            ("OCI_ADB_AUTOSCALING_DISABLED", "AZURE_DB_NO_GEO_REDUNDANT_BACKUP")),

    # ── HIPAA Security Rule (technical safeguards) ──────────────────────────
    Control(HIPAA, "164.308(a)(4)", "Information access management",
            "Policies and procedures for authorising access to electronic protected "
            "health information.",
            _IAM_RULES),
    Control(HIPAA, "164.308(a)(1)(ii)(A)", "Risk analysis",
            "Conduct an accurate and thorough assessment of potential risks and "
            "vulnerabilities to ePHI.",
            _EXPOSURE_RULES),
    Control(HIPAA, "164.312(a)(1)", "Access control",
            "Implement technical policies and procedures that allow access only to "
            "those persons or software programs granted access rights.",
            _IAM_RULES + _PUBLIC_ACCESS_RULES),
    Control(HIPAA, "164.312(a)(2)(iv)", "Encryption and decryption",
            "Implement a mechanism to encrypt and decrypt electronic protected health "
            "information at rest.",
            _ENCRYPTION_RULES),
    Control(HIPAA, "164.312(b)", "Audit controls",
            "Implement hardware, software and procedural mechanisms that record and "
            "examine activity in systems containing ePHI.", ()),
    Control(HIPAA, "164.312(e)(1)", "Transmission security",
            "Implement technical security measures to guard against unauthorised "
            "access to ePHI transmitted over an electronic network.",
            _EXPOSURE_RULES + _SG_RULES),
    Control(HIPAA, "164.312(e)(2)(ii)", "Encryption in transit",
            "Implement a mechanism to encrypt ePHI whenever deemed appropriate during "
            "transmission.",
            ("AWS_ELB_INSECURE_LISTENER",)),

    # ── PCI-DSS v4.0 ─────────────────────────────────────────────────────────
    Control(PCI, "1.2.7", "Network control configuration review",
            "Configurations of network security controls are reviewed to confirm they "
            "remain effective and appropriate.",
            ("AWS_SUBNET_AUTO_PUBLIC_IP", "OCI_SUBNET_PUBLIC")),
    Control(PCI, "1.2.1", "Network security control configuration",
            "Configuration standards for network security controls are defined and "
            "applied.",
            _SG_RULES),
    Control(PCI, "1.3.1", "Inbound traffic restriction",
            "Inbound traffic to the cardholder data environment is restricted to only "
            "that which is necessary.",
            _EXPOSURE_RULES),
    Control(PCI, "1.4.2", "Public network exposure",
            "Inbound traffic from untrusted networks to the trusted network is "
            "restricted.",
            _EXPOSURE_RULES + _ENDPOINT_RULES),
    Control(PCI, "2.2.1", "Secure configuration standards",
            "Configuration standards are developed, implemented and maintained to "
            "cover all system components.",
            ("AWS_SG_DEFAULT_IN_USE", "AWS_LAMBDA_DEPRECATED_RUNTIME")),
    Control(PCI, "3.5.1", "Protection of stored account data",
            "Primary account number is rendered unreadable wherever it is stored.",
            _ENCRYPTION_RULES),
    Control(PCI, "4.2.1", "Strong cryptography in transit",
            "Strong cryptography and security protocols protect account data during "
            "transmission over open public networks.",
            ("AWS_ELB_INSECURE_LISTENER",)),
    Control(PCI, "7.2.1", "Least privilege access",
            "An access control model is defined that grants access based on job "
            "classification and least privilege.",
            _IAM_RULES),
    Control(PCI, "7.2.2", "Privilege assignment",
            "Access is assigned based on least privilege and business need to know.",
            _IAM_RULES),
    Control(PCI, "8.3.1", "Strong authentication",
            "All access is authenticated with strong authentication factors.", ()),
    Control(PCI, "10.2.1", "Audit logs",
            "Audit logs are enabled and active for all system components.", ()),
    Control(PCI, "12.5.1", "Asset inventory",
            "An inventory of system components in scope is maintained and kept "
            "current.",
            _GOVERNANCE_RULES),
)

BY_KEY: Dict[str, Control] = {c.key: c for c in CONTROLS}
BY_FRAMEWORK: Dict[str, List[Control]] = {
    fw: [c for c in CONTROLS if c.framework == fw] for fw in FRAMEWORKS
}

# rule_id -> the controls it assesses. This is the reverse index the engine
# uses to stamp `compliance` onto each finding, so a finding carries its
# citations as metadata and appears exactly once (§22).
_RULE_TO_CONTROLS: Dict[str, List[Control]] = {}
for _c in CONTROLS:
    for _rid in _c.rules:
        _RULE_TO_CONTROLS.setdefault(_rid, []).append(_c)


def controls_for_rule(rule_id: str) -> List[Control]:
    return _RULE_TO_CONTROLS.get(rule_id, [])


def mappings_for_rule(rule_id: str) -> Dict[str, List[str]]:
    """`{framework: [control refs]}` for stamping onto a finding.

    Shape kept identical to the old service's `controls` field so the existing
    Compliance UI renders it unchanged.
    """
    out: Dict[str, List[str]] = {}
    for c in controls_for_rule(rule_id):
        out.setdefault(c.framework, []).append(f"{c.control_id} {c.title}")
    return {fw: sorted(refs) for fw, refs in out.items()}


def all_assessing_rule_ids() -> frozenset:
    return frozenset(_RULE_TO_CONTROLS)


def catalog_summary() -> Dict[str, Dict[str, int]]:
    """How many controls each framework declares, and how many any rule
    covers. Lets the UI state the scope of the catalog up front rather than
    implying it is the whole framework."""
    out = {}
    for fw in FRAMEWORKS:
        declared = BY_FRAMEWORK[fw]
        out[fw] = {
            "declared": len(declared),
            "with_checks": sum(1 for c in declared if c.rules),
            "without_checks": sum(1 for c in declared if not c.rules),
        }
    return out
