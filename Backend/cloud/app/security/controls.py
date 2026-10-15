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
* **No certification language.** The framework references are informative
  cross-walks to published control text, which is genuinely useful for
  pointing an auditor at a clause — and is not an assessment against the
  framework's own catalog.

**Two kinds of framework, two failure rules.**

* Principle-based frameworks (SOC 2, HIPAA, PCI-DSS, ISO 27001, GDPR, RBI,
  SEBI) are failed only by a CRITICAL, HIGH or MEDIUM finding. A LOW or INFO
  finding is real hygiene and not a control violation.
* CIS Benchmarks are different: each recommendation is a pass/fail test, and a
  rule mapped to one tests exactly that recommendation. Those controls are
  `strict` — ANY confirmed finding fails them, whatever its severity. Without
  this, Oracle-managed volume encryption (an INFO finding here, because it is
  still encryption) would "pass" CIS OCI 5.2.1, whose whole content is that a
  customer-managed key is required.

**Provider scope.** A CIS benchmark applies to one cloud. It is offered only
for that cloud's accounts, and a cross-cloud rule's finding on an OCI account
never carries CIS AWS citations.

**Where the IDs came from.** Every control id and title in the CIS, ISO, SEBI
and RBI sections was verified on 2026-09-28 against public sources: Prowler's
compliance mappings and Tenable's audit files (CIS), Oracle's own reference
checker cis_reports.py (CIS OCI), a published ISO 27001:2022 Statement of
Applicability (ISO titles, verbatim), the SEBI circulars of 20 Aug 2024 and
their amendments, and rbi.org.in. Where a source could not verify a number,
the control is not listed.
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

# ── Frameworks ───────────────────────────────────────────────────────────────
SOC2 = "SOC2"
HIPAA = "HIPAA"
PCI = "PCI-DSS"
ISO27001 = "ISO27001"
CIS_AWS = "CIS-AWS"
CIS_AZURE = "CIS-AZURE"
CIS_OCI = "CIS-OCI"
GDPR = "GDPR"
RBI = "RBI"
SEBI = "SEBI-CSCRF"

FRAMEWORKS: Tuple[str, ...] = (SOC2, HIPAA, PCI, ISO27001, GDPR, CIS_AWS, CIS_AZURE, CIS_OCI,
                               RBI, SEBI)

KIND_STANDARD = "standard"
KIND_BENCHMARK = "benchmark"
KIND_REGULATION = "regulation"

FRAMEWORK_META: Dict[str, Dict[str, object]] = {
    SOC2: {
        "label": "SOC 2",
        "full_name": "SOC 2 Trust Services Criteria (2017)",
        "kind": KIND_STANDARD, "providers": None,
        "note": "Cross-walk to the published TSC. Not an audit and not an opinion.",
    },
    HIPAA: {
        "label": "HIPAA",
        "full_name": "HIPAA Security Rule, 45 CFR §164 Subpart C",
        "kind": KIND_REGULATION, "providers": None,
        "note": "Cross-walk to the published safeguards. Technical safeguards only.",
    },
    PCI: {
        "label": "PCI-DSS",
        "full_name": "PCI-DSS v4.0",
        "kind": KIND_STANDARD, "providers": None,
        "note": "Cross-walk to the published requirements. Not a QSA assessment.",
    },
    ISO27001: {
        "label": "ISO 27001",
        "full_name": "ISO/IEC 27001:2022 Annex A",
        "kind": KIND_STANDARD, "providers": None,
        "note": ("Annex A controls are objectives, so configuration findings are partial "
                 "evidence for them by nature. Control titles are the standard's own; the "
                 "requirement text is a paraphrase. Not a certification audit."),
    },
    GDPR: {
        "label": "GDPR",
        "full_name": "EU General Data Protection Regulation (Regulation (EU) 2016/679)",
        "kind": KIND_REGULATION, "providers": None,
        "note": ("Cross-walk to the published Articles, covering only the technical "
                 "security-of-processing measures a cloud configuration scan can observe "
                 "(Art. 32). The organisational and legal obligations that make up most of "
                 "the Regulation — lawful basis, records of processing (Art. 30), breach "
                 "notification (Art. 33), DPIAs (Art. 35), international transfers "
                 "(Chapter V) — are listed as NOT_EVALUATED on purpose rather than omitted, "
                 "because a control nobody checked is the one most likely to be failing. "
                 "Not a legal opinion and not a substitute for a DPO's assessment."),
    },
    CIS_AWS: {
        "label": "CIS AWS",
        "full_name": "CIS Amazon Web Services Foundations Benchmark v7.0.0",
        "kind": KIND_BENCHMARK, "providers": ("AWS",),
        "note": ("Each recommendation is a pass/fail test: any confirmed finding fails it, "
                 "whatever its severity. v7.0.0 renumbered the sections (IAM is now 2, "
                 "Storage 3, Logging 4, Monitoring 5, Networking 6). Not a CIS "
                 "certification."),
    },
    CIS_AZURE: {
        "label": "CIS Azure",
        "full_name": "CIS Microsoft Azure Foundations Benchmark v6.0.0",
        "kind": KIND_BENCHMARK, "providers": ("AZURE",),
        "note": ("Each recommendation is a pass/fail test. Database guidance moved out of "
                 "the Foundations benchmark into the separate CIS Azure Database Services "
                 "benchmark, so database checks are not cited here. Not a CIS "
                 "certification."),
    },
    CIS_OCI: {
        "label": "CIS OCI",
        "full_name": "CIS Oracle Cloud Infrastructure Foundations Benchmark v3.1.1",
        "kind": KIND_BENCHMARK, "providers": ("OCI",),
        "note": ("Each recommendation is a pass/fail test. Where a check mirrors Oracle's "
                 "own reference checker (cis_reports.py) it follows that implementation. "
                 "Not a CIS certification."),
    },
    RBI: {
        "label": "RBI",
        "full_name": ("RBI (Commercial Banks – Cybersecurity, Technology: Risk, Resilience "
                      "and Assurance Framework) Directions, 2026, and (Commercial Banks – "
                      "Managing Risks in Outsourcing) Directions, 2025"),
        "kind": KIND_REGULATION, "providers": None,
        "note": ("Paragraph numbers are those of the Commercial Banks Directions. Small "
                 "finance banks, payments banks, UCBs, NBFCs and other regulated entities "
                 "have sibling Directions with different numbering — cite theirs. These "
                 "replace the 2016 Cyber Security Framework and the 2023 IT Governance "
                 "Master Direction, both repealed on 31 Jul 2026. A configuration scan is "
                 "evidence for the technical clauses only; it is not VA/PT and not an "
                 "RBI inspection."),
    },
    SEBI: {
        "label": "SEBI CSCRF",
        "full_name": ("SEBI Cybersecurity and Cyber Resilience Framework (CSCRF) v1.0, "
                      "20 Aug 2024 as amended, with the SEBI Cloud Framework (6 Mar 2023)"),
        "kind": KIND_REGULATION, "providers": None,
        "note": ("Standard codes (PR.AA.S3, …) are SEBI's own. SEBI's standards are "
                 "sentences with no official short titles, so the titles shown are "
                 "Actmon's paraphrase — quote the circular's text to an auditor. The data "
                 "localisation provisions of PR.DS.S2 are in abeyance (circular of 31 Dec "
                 "2024). 'CF' controls are sections of the Cloud Framework."),
    },
}


def applies_to(framework: str, provider: Optional[str]) -> bool:
    """Whether a framework is offered for an account on `provider`.

    Provider-agnostic frameworks apply everywhere. A provider benchmark
    applies only to its own cloud — and to nothing when the provider is not
    known, because a benchmark cannot be applied to an unidentified estate.
    """
    meta = FRAMEWORK_META.get(framework) or {}
    providers = meta.get("providers")
    if not providers:
        return True
    if not provider:
        return False
    from app.security.model import normalize_provider

    return (normalize_provider(provider) or str(provider).upper()) in providers


def frameworks_for(provider: Optional[str]) -> List[str]:
    return [fw for fw in FRAMEWORKS if applies_to(fw, provider)]


class Control(NamedTuple):
    """One control we claim to assess, and exactly what assesses it."""

    framework: str
    control_id: str
    title: str
    # What the control requires, in the framework's own terms (paraphrased for
    # ISO and SEBI, whose text is not reproduced).
    requirement: str
    # The rule_ids whose findings decide this control's state. A control with
    # an empty tuple is declared but NOT_EVALUATED — listed on purpose, so the
    # catalog shows what is missing instead of hiding it.
    rules: Tuple[str, ...] = ()
    # Any confirmed finding fails the control, whatever its severity. Set on
    # CIS recommendations, which are pass/fail tests (see module docstring).
    strict: bool = False
    # Only findings on these resource types count. Used where one rule covers
    # several kinds that a framework numbers separately (CIS OCI 5.2.1 block
    # volumes vs 5.2.2 boot volumes, both OCI_VOLUME_ENCRYPTION_...).
    resource_types: Tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.framework}:{self.control_id}"


def stat_key(rule_id: str, resource_type: str) -> str:
    """The rule-statistics key for one rule on one resource type, read by
    controls that declare `resource_types`."""
    return f"{rule_id}|{resource_type}"


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
_PUBLIC_STORAGE_RULES = (
    "AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED",
    "AZURE_STORAGE_BLOB_PUBLIC_ACCESS",
    "OCI_BUCKET_PUBLIC_ACCESS",
)
_EXPOSURE_RULES = (
    "EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",
    "EXPOSURE_DATA_PORT_WORLD_OPEN",
    "EXPOSURE_PORT_WORLD_OPEN",
    "EXPOSURE_ALL_PORTS_WORLD_OPEN",
    "EXPOSURE_UNDETERMINED",
)
_WORLD_OPEN_ADMIN_PORT_RULES = (
    "AWS_SG_SSH_WORLD_OPEN",
    "AWS_SG_RDP_WORLD_OPEN",
    "AZURE_NSG_SSH_WORLD_OPEN",
    "AZURE_NSG_RDP_WORLD_OPEN",
    "OCI_NSG_SSH_WORLD_OPEN",
    "OCI_NSG_RDP_WORLD_OPEN",
    "OCI_SECLIST_SSH_WORLD_OPEN",
    "OCI_SECLIST_RDP_WORLD_OPEN",
)
_SG_RULES = _WORLD_OPEN_ADMIN_PORT_RULES + (
    # The world-open checks are the authoritative ones; the rule-count checks
    # are low-confidence indicators that ride along on the same controls.
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
# Protection of data in transit, including the validity of the certificates
# that protect it (PCI-DSS 4.2.1 names certificate validity explicitly).
_TRANSIT_RULES = (
    "AWS_ELB_INSECURE_LISTENER",
    "AZURE_STORAGE_SECURE_TRANSFER_DISABLED",
    "AZURE_STORAGE_MIN_TLS_BELOW_1_2",
    "CERT_EXPIRED",
    "AWS_IAM_SERVER_CERT_EXPIRED",
)
_KEY_NO_EXPIRY_RULES = (
    "AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY",
    "AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY",
)
_SECRET_NO_EXPIRY_RULES = (
    "AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY",
    "AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY",
)
# Credentials and secrets as authentication information.
_SECRET_HYGIENE_RULES = _SECRET_NO_EXPIRY_RULES + (
    "SECRET_EXPIRED",
    "AWS_SECRETSMANAGER_ROTATION_DISABLED",
    "SECRET_ROTATION_OVERDUE",
)
# Cryptographic key management.
_KEY_MANAGEMENT_RULES = _KEY_NO_EXPIRY_RULES + (
    "AZURE_KEYVAULT_NOT_RECOVERABLE",
    "SECRET_EXPIRED",
)
_PRIVILEGED_RULES = (
    "AWS_IAM_ROLE_FULL_ADMIN",
    "AWS_IAM_ROLE_ESCALATION",
    "AWS_IAM_ROLE_WILDCARD_FULL",
    "OCI_IAM_POLICY_TENANCY_ADMIN",
    "OCI_IAM_POLICY_ESCALATION",
    "AZURE_RBAC_SUBSCRIPTION_OWNER",
    "AZURE_RBAC_ESCALATION",
    "AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED",
)
_IAM_RULES = _PRIVILEGED_RULES + (
    "AWS_IAM_ROLE_WILDCARD_WRITE",
    "AWS_IAM_ROLE_LONG_SESSION",
    "OCI_IAM_POLICY_BROAD_MANAGE",
    "AZURE_RBAC_BROAD_WRITE",
    "AZURE_RBAC_NOT_COLLECTED",
)
_BROAD_WRITE_RULES = (
    "AWS_IAM_ROLE_WILDCARD_WRITE",
    "AZURE_RBAC_BROAD_WRITE",
    "OCI_IAM_POLICY_BROAD_MANAGE",
)
_ENDPOINT_RULES = (
    "OCI_OKE_PUBLIC_ENDPOINT",
    "OCI_APIGW_PUBLIC_ENDPOINT",
)
_SECURE_CONFIG_RULES = (
    "AWS_SG_DEFAULT_IN_USE",
    "AWS_SG_DEFAULT_ALLOWS_TRAFFIC",
    "AWS_SG_PERMISSIVE_RULE_COUNT",
    "AZURE_NSG_PERMISSIVE_RULE_COUNT",
    "OCI_NSG_PERMISSIVE_RULE_COUNT",
    "OCI_SECURITY_LIST_PERMISSIVE_RULE_COUNT",
    "OCI_DEFAULT_SECLIST_WORLD_OPEN",
    "AWS_SUBNET_AUTO_PUBLIC_IP",
    "AWS_EC2_IMDSV2_NOT_REQUIRED",
    "OCI_COMPUTE_LEGACY_IMDS_ENABLED",
)
_SEGREGATION_RULES = (
    "OCI_SUBNET_PUBLIC",
    "AWS_SUBNET_AUTO_PUBLIC_IP",
)
_BACKUP_RULES = (
    "AWS_S3_VERSIONING_DISABLED",
    "AZURE_DB_NO_GEO_REDUNDANT_BACKUP",
)
_VULN_RULES = ("AWS_LAMBDA_DEPRECATED_RUNTIME",)
_GOVERNANCE_RULES = ("GOVERNANCE_MISSING_OWNERSHIP_TAGS",)


# ── The catalog ──────────────────────────────────────────────────────────────
# Scoped honestly: these are the controls this build has evidence for, plus a
# deliberate handful of declared-but-unassessed ones (empty `rules`) that a
# cloud posture tool is expected to cover. Those render as NOT_EVALUATED and
# drag assessment_coverage down, which is the intended behaviour — the gap is
# the useful information.

def _cis(framework: str, control_id: str, title: str, rules: Tuple[str, ...] = (),
         note: str = "", resource_types: Tuple[str, ...] = ()) -> Control:
    requirement = title.replace("Ensure ", "", 1)
    requirement = requirement[:1].upper() + requirement[1:]
    if note:
        requirement = f"{requirement}. {note}"
    return Control(framework, control_id, title, requirement, rules, strict=True,
                   resource_types=resource_types)


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
            _TRANSIT_RULES),
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
            _TRANSIT_RULES),

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
            ("AWS_SG_DEFAULT_IN_USE", "AWS_LAMBDA_DEPRECATED_RUNTIME",
             "AWS_EC2_IMDSV2_NOT_REQUIRED", "OCI_COMPUTE_LEGACY_IMDS_ENABLED")),
    Control(PCI, "3.5.1", "Protection of stored account data",
            "Primary account number is rendered unreadable wherever it is stored.",
            _ENCRYPTION_RULES),
    Control(PCI, "3.7.4", "Cryptographic key changes at end of cryptoperiod",
            "Keys that have reached the end of their defined cryptoperiod are changed.",
            _KEY_NO_EXPIRY_RULES + ("SECRET_EXPIRED",)),
    Control(PCI, "4.2.1", "Strong cryptography in transit",
            "Strong cryptography and security protocols protect account data during "
            "transmission over open public networks, and certificates used for it are "
            "confirmed valid and not expired.",
            _TRANSIT_RULES),
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

    # ── ISO/IEC 27001:2022 Annex A ──────────────────────────────────────────
    # Titles verbatim; requirement text paraphrased.
    Control(ISO27001, "5.9", "Inventory of information and other associated assets",
            "An inventory of information and associated assets, including owners, is "
            "developed and maintained.", _GOVERNANCE_RULES),
    Control(ISO27001, "5.15", "Access control",
            "Rules controlling physical and logical access to information are "
            "established and implemented.", _PUBLIC_ACCESS_RULES + _IAM_RULES),
    Control(ISO27001, "5.16", "Identity management",
            "The full life cycle of identities is managed.", ()),
    Control(ISO27001, "5.17", "Authentication information",
            "Allocation and management of authentication information (passwords, keys, "
            "secrets) is controlled.", _SECRET_HYGIENE_RULES),
    Control(ISO27001, "5.18", "Access rights",
            "Access rights are provisioned, reviewed, modified and removed according to "
            "policy.", _BROAD_WRITE_RULES),
    Control(ISO27001, "5.23", "Information security for use of cloud services",
            "Processes for acquiring, using, managing and exiting cloud services are "
            "established. An umbrella control: listed, not scored.", ()),
    Control(ISO27001, "5.30", "ICT readiness for business continuity",
            "ICT readiness is planned, implemented, maintained and tested.", ()),
    Control(ISO27001, "8.2", "Privileged access rights",
            "The allocation and use of privileged access rights is restricted and "
            "managed.", _PRIVILEGED_RULES),
    Control(ISO27001, "8.3", "Information access restriction",
            "Access to information and assets is restricted according to the access "
            "control policy.", _PUBLIC_ACCESS_RULES),
    Control(ISO27001, "8.7", "Protection against malware",
            "Protection against malware is implemented.", ()),
    Control(ISO27001, "8.8", "Management of technical vulnerabilities",
            "Information about technical vulnerabilities is obtained and exposure is "
            "evaluated and addressed.", _VULN_RULES),
    Control(ISO27001, "8.9", "Configuration management",
            "Configurations, including security configurations, are established, "
            "documented, implemented, monitored and reviewed.", _SECURE_CONFIG_RULES),
    Control(ISO27001, "8.12", "Data leakage prevention",
            "Data leakage prevention measures are applied to systems that process "
            "sensitive information.", _PUBLIC_STORAGE_RULES),
    Control(ISO27001, "8.13", "Information backup",
            "Backup copies of information and systems are maintained and tested.",
            _BACKUP_RULES),
    Control(ISO27001, "8.14", "Redundancy of information processing facilities",
            "Information processing facilities have sufficient redundancy.",
            ("AZURE_DB_NO_GEO_REDUNDANT_BACKUP",)),
    Control(ISO27001, "8.15", "Logging",
            "Logs recording activities, exceptions and faults are produced, stored, "
            "protected and analysed.", ()),
    Control(ISO27001, "8.16", "Monitoring activities",
            "Networks, systems and applications are monitored for anomalous behaviour.",
            ()),
    Control(ISO27001, "8.20", "Networks security",
            "Networks and network devices are secured, managed and controlled.",
            _WORLD_OPEN_ADMIN_PORT_RULES + _EXPOSURE_RULES),
    Control(ISO27001, "8.21", "Security of network services",
            "Security mechanisms and service levels of network services are identified "
            "and implemented.",
            _ENDPOINT_RULES + ("AWS_ELB_INSECURE_LISTENER",)),
    Control(ISO27001, "8.22", "Segregation of networks",
            "Groups of services, users and systems are segregated in networks.",
            _SEGREGATION_RULES),
    Control(ISO27001, "8.24", "Use of cryptography",
            "Rules for the effective use of cryptography, including key management, are "
            "defined and implemented.",
            _ENCRYPTION_RULES + _TRANSIT_RULES + _KEY_MANAGEMENT_RULES),
    Control(ISO27001, "8.32", "Change management",
            "Changes to information processing facilities and systems are subject to "
            "change management.", ()),

    # ── CIS AWS Foundations v7.0.0 (strict) ─────────────────────────────────
    _cis(CIS_AWS, "2.4", "Ensure no 'root' user account access key exists"),
    _cis(CIS_AWS, "2.5", "Ensure MFA is enabled for the 'root' user account"),
    _cis(CIS_AWS, "2.8", "Ensure IAM password policy requires minimum length of 14 or "
                         "greater"),
    _cis(CIS_AWS, "2.10", "Ensure multi-factor authentication (MFA) is enabled for all IAM "
                          "users that have a console password"),
    _cis(CIS_AWS, "2.12", "Ensure access keys are rotated every 90 days or less"),
    _cis(CIS_AWS, "2.14", "Ensure IAM policies that allow full \"*:*\" administrative "
                          "privileges are not attached",
         ("AWS_IAM_ROLE_FULL_ADMIN",),
         "Assessed for IAM roles; policies attached to IAM users and groups are not "
         "collected"),
    _cis(CIS_AWS, "2.17", "Ensure that all the expired SSL/TLS certificates stored in AWS "
                          "IAM are removed",
         ("AWS_IAM_SERVER_CERT_EXPIRED",)),
    _cis(CIS_AWS, "3.1.4", "Ensure that S3 is configured with 'Block Public Access' "
                           "enabled",
         ("AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED",),
         "Assessed per bucket. The account-level Block Public Access setting is not "
         "collected, so a bucket protected only at account level is reported as failing"),
    _cis(CIS_AWS, "3.2.1", "Ensure that encryption-at-rest is enabled for RDS instances",
         ("AWS_RDS_ENCRYPTION_DISABLED",)),
    _cis(CIS_AWS, "3.2.3", "Ensure that RDS instances are not publicly accessible",
         ("AWS_RDS_PUBLICLY_ACCESSIBLE",)),
    _cis(CIS_AWS, "4.1", "Ensure CloudTrail is enabled in all regions"),
    _cis(CIS_AWS, "4.3", "Ensure AWS Config is enabled in all regions"),
    _cis(CIS_AWS, "4.6", "Ensure rotation for customer-created symmetric CMKs is enabled"),
    _cis(CIS_AWS, "4.7", "Ensure VPC flow logging is enabled in all VPCs"),
    _cis(CIS_AWS, "5.16", "Ensure AWS Security Hub is enabled"),
    _cis(CIS_AWS, "6.1.1", "Ensure EBS volume encryption is enabled in all regions"),
    _cis(CIS_AWS, "6.3", "Ensure no security groups allow ingress from 0.0.0.0/0 to remote "
                         "server administration ports",
         ("AWS_SG_SSH_WORLD_OPEN", "AWS_SG_RDP_WORLD_OPEN"),
         "Checked for ports 22 and 3389. The check treats 0.0.0.0/0 and ::/0 together, so "
         "a group open on either is cited under both 6.3 and 6.4"),
    _cis(CIS_AWS, "6.4", "Ensure no security groups allow ingress from ::/0 to remote "
                         "server administration ports",
         ("AWS_SG_SSH_WORLD_OPEN", "AWS_SG_RDP_WORLD_OPEN"),
         "Checked for ports 22 and 3389, together with 0.0.0.0/0 (see 6.3)"),
    _cis(CIS_AWS, "6.5", "Ensure the default security group of every VPC restricts all "
                         "traffic",
         ("AWS_SG_DEFAULT_ALLOWS_TRAFFIC",)),
    _cis(CIS_AWS, "6.7", "Ensure that the EC2 Metadata Service only allows IMDSv2",
         ("AWS_EC2_IMDSV2_NOT_REQUIRED",)),

    # ── CIS Azure Foundations v6.0.0 (strict) ───────────────────────────────
    _cis(CIS_AZURE, "5.1.1", "Ensure that 'security defaults' is Enabled in Microsoft "
                             "Entra ID"),
    _cis(CIS_AZURE, "5.1.3", "Ensure that 'multifactor authentication' is 'enabled' For "
                             "All Users"),
    _cis(CIS_AZURE, "5.3.3", "Ensure That Use of the 'User Access Administrator' Role is "
                             "Restricted"),
    _cis(CIS_AZURE, "6.1.1.1", "Ensure that a 'Diagnostic Setting' Exists for Subscription "
                               "Activity Logs"),
    _cis(CIS_AZURE, "6.1.1.4", "Ensure that Logging for Azure Key Vault is 'Enabled'"),
    _cis(CIS_AZURE, "6.1.1.6", "Ensure that Virtual Network Flow Logs are Captured and Sent "
                               "to Log Analytics"),
    _cis(CIS_AZURE, "7.1", "Ensure that RDP Access from the Internet is Evaluated and "
                           "Restricted", ("AZURE_NSG_RDP_WORLD_OPEN",)),
    _cis(CIS_AZURE, "7.2", "Ensure that SSH Access from the Internet is Evaluated and "
                           "Restricted", ("AZURE_NSG_SSH_WORLD_OPEN",)),
    _cis(CIS_AZURE, "8.1.1.1", "Ensure Microsoft Defender CSPM is Set to 'On'"),
    _cis(CIS_AZURE, "8.1.3.1", "Ensure that Defender for Servers is Set to 'On'"),
    _cis(CIS_AZURE, "8.3.1", "Ensure that the Expiration Date is Set for all Keys in Key "
                             "Vaults using RBAC", ("AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY",)),
    _cis(CIS_AZURE, "8.3.2", "Ensure that the Expiration Date is set for All Keys in Key "
                             "Vaults using access policies (legacy)",
         ("AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY",)),
    _cis(CIS_AZURE, "8.3.3", "Ensure that the Expiration Date is set for All Secrets in Key "
                             "Vaults using RBAC", ("AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY",)),
    _cis(CIS_AZURE, "8.3.4", "Ensure that the Expiration Date is set for All Secrets in Key "
                             "Vaults using access policies (legacy)",
         ("AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY",)),
    _cis(CIS_AZURE, "8.3.5", "Ensure 'Purge protection' is Set to 'Enabled'",
         ("AZURE_KEYVAULT_NOT_RECOVERABLE",)),
    _cis(CIS_AZURE, "8.3.9", "Ensure Automatic Key Rotation is Enabled within Azure Key "
                             "Vault"),
    _cis(CIS_AZURE, "9.3.4", "Ensure that 'Secure transfer required' is Set to 'Enabled'",
         ("AZURE_STORAGE_SECURE_TRANSFER_DISABLED",)),
    _cis(CIS_AZURE, "9.3.6", "Ensure the 'Minimum TLS version' for Storage Accounts is Set "
                             "to 'Version 1.2'", ("AZURE_STORAGE_MIN_TLS_BELOW_1_2",)),
    _cis(CIS_AZURE, "9.3.8", "Ensure that 'Allow Blob Anonymous Access' is Set to "
                             "'Disabled'", ("AZURE_STORAGE_BLOB_PUBLIC_ACCESS",)),

    # ── CIS OCI Foundations v3.1.1 (strict) ─────────────────────────────────
    _cis(CIS_OCI, "1.1", "Ensure service level admins are created to manage resources of "
                         "particular service"),
    _cis(CIS_OCI, "1.2", "Ensure permissions on all resources are given only to the "
                         "tenancy administrator group", ("OCI_IAM_POLICY_TENANCY_ADMIN",)),
    _cis(CIS_OCI, "1.3", "Ensure IAM administrators cannot update tenancy Administrators "
                         "group"),
    _cis(CIS_OCI, "1.4", "Ensure IAM password policy requires minimum length of 14 or "
                         "greater"),
    _cis(CIS_OCI, "1.7", "Ensure MFA is enabled for all users with a console password"),
    _cis(CIS_OCI, "1.12", "Ensure API keys are not created for tenancy administrator users"),
    _cis(CIS_OCI, "2.1", "Ensure no security lists allow ingress from 0.0.0.0/0 to port 22",
         ("OCI_SECLIST_SSH_WORLD_OPEN",)),
    _cis(CIS_OCI, "2.2", "Ensure no security lists allow ingress from 0.0.0.0/0 to port "
                         "3389", ("OCI_SECLIST_RDP_WORLD_OPEN",)),
    _cis(CIS_OCI, "2.3", "Ensure no network security groups allow ingress from 0.0.0.0/0 "
                         "to port 22", ("OCI_NSG_SSH_WORLD_OPEN",)),
    _cis(CIS_OCI, "2.4", "Ensure no network security groups allow ingress from 0.0.0.0/0 "
                         "to port 3389", ("OCI_NSG_RDP_WORLD_OPEN",)),
    _cis(CIS_OCI, "2.5", "Ensure the default security list of every VCN restricts all "
                         "traffic except ICMP", ("OCI_DEFAULT_SECLIST_WORLD_OPEN",),
         "Checked as: no non-ICMP ingress rule from 0.0.0.0/0 on a VCN's default list"),
    _cis(CIS_OCI, "3.1", "Ensure Compute Instance Legacy Metadata service endpoint is "
                         "disabled", ("OCI_COMPUTE_LEGACY_IMDS_ENABLED",)),
    _cis(CIS_OCI, "4.13", "Ensure VCN flow logging is enabled for all subnets"),
    _cis(CIS_OCI, "4.14", "Ensure Cloud Guard is enabled in the root compartment of the "
                          "tenancy"),
    _cis(CIS_OCI, "4.16", "Ensure customer created Customer Managed Key (CMK) is rotated at "
                          "least annually"),
    _cis(CIS_OCI, "4.17", "Ensure write level Object Storage logging is enabled for all "
                          "buckets"),
    _cis(CIS_OCI, "5.1.1", "Ensure no Object Storage buckets are publicly visible",
         ("OCI_BUCKET_PUBLIC_ACCESS",)),
    _cis(CIS_OCI, "5.2.1", "Ensure Block Volumes are encrypted with Customer Managed Keys "
                           "(CMK)", ("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",),
         resource_types=("BlockVolume",)),
    _cis(CIS_OCI, "5.2.2", "Ensure boot volumes are encrypted with Customer Managed Key "
                           "(CMK)", ("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",),
         resource_types=("BootVolume",)),
    _cis(CIS_OCI, "5.3.1", "Ensure File Storage Systems are encrypted with Customer Managed "
                           "Keys (CMK)", ("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",),
         resource_types=("FileSystem",)),
    _cis(CIS_OCI, "6.2", "Ensure no resources are created in the root compartment",
         ("OCI_RESOURCE_IN_ROOT_COMPARTMENT",),
         "Counted for networks, compute, storage and databases, as Oracle's reference "
         "checker does; IAM objects live in the root by design"),

    # ── RBI — Commercial Banks Directions (2026) and Outsourcing (2025) ─────
    Control(RBI, "Para 37", "III.J IT Services Management — end-of-support software",
            "Outdated and unsupported software is avoided, and software end-of-support "
            "dates are monitored.", _VULN_RULES),
    Control(RBI, "Para 47", "V.A Inventory Management of Information Assets",
            "An inventory of information assets is maintained.", _GOVERNANCE_RULES),
    Control(RBI, "Para 51", "V.B Data Leak Prevention Strategy",
            "Measures prevent data from leaking out of the bank's systems.",
            _PUBLIC_STORAGE_RULES),
    Control(RBI, "Paras 66-67", "V.G Secure Configuration",
            "Systems are configured securely against a documented baseline.",
            _SECURE_CONFIG_RULES),
    Control(RBI, "Paras 68, 71, 77", "V.H Network Management and Security",
            "Only authorised network access is permitted, network devices are configured "
            "appropriately, and boundary defences are layered.",
            _WORLD_OPEN_ADMIN_PORT_RULES + _EXPOSURE_RULES + _ENDPOINT_RULES
            + _SEGREGATION_RULES + ("AWS_RDS_PUBLICLY_ACCESSIBLE",
                                    "AZURE_DB_PUBLIC_NETWORK_ACCESS")),
    Control(RBI, "Paras 93-97", "V.J Maintenance, Monitoring, and Analysis of Audit Logs",
            "Audit logs are maintained, monitored and analysed.", ()),
    Control(RBI, "Paras 104, 109", "V.L User Access Control — need and least privilege",
            "Access is granted for a valid business need and on least privilege.",
            _IAM_RULES),
    Control(RBI, "Paras 105, 111", "V.L User Access Control — privileged access",
            "Elevated and privileged access is supervised and logged.", _PRIVILEGED_RULES),
    Control(RBI, "Paras 107-108", "V.L User Access Control — credentials and duration",
            "Credentials are protected, and access is granted for a specific duration.",
            _SECRET_HYGIENE_RULES + ("AWS_IAM_ROLE_LONG_SESSION",)),
    Control(RBI, "Para 110", "V.L User Access Control — multi-factor authentication",
            "Privileged users authenticate with more than one factor.", ()),
    Control(RBI, "Paras 106, 140", "V.L data protection; V.R Cryptographic Controls",
            "Data is protected at rest and in transit, with cryptographic controls.",
            _ENCRYPTION_RULES + _TRANSIT_RULES + _KEY_MANAGEMENT_RULES),
    Control(RBI, "Paras 149-161", "V.W Vulnerability Assessment and Penetration Testing",
            "VA/PT is conducted. A configuration scan is not VA/PT.", ()),
    Control(RBI, "Para 169", "V.Y Business Continuity and Disaster Recovery — backups",
            "Data is backed up and restores are tested.", _BACKUP_RULES),
    Control(RBI, "Outsourcing 92(vii)(b)", "F.4 Cloud — encryption keys under the bank's "
                                           "control",
            "Encryption keys and HSMs used for cloud services remain under the bank's "
            "control.",
            ("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED", "AWS_DYNAMODB_AWS_OWNED_KEY")),
    Control(RBI, "Outsourcing 92(viii)", "F.4 Cloud — identity and access management",
            "Cloud IAM enforces least privilege, segregation of duties and MFA.",
            _IAM_RULES),
    Control(RBI, "Outsourcing 92(ix)", "F.4 Cloud — secure configuration and monitoring",
            "Cloud assets are securely configured and monitored.",
            _SECURE_CONFIG_RULES + _WORLD_OPEN_ADMIN_PORT_RULES + _EXPOSURE_RULES
            + _PUBLIC_ACCESS_RULES),

    # ── SEBI CSCRF (titles paraphrased — see FRAMEWORK_META) ────────────────
    Control(SEBI, "ID.AM.S1", "Inventory of digital assets, including cloud assets",
            "Devices, digital assets and shared resources, including cloud assets, are "
            "inventoried.", _GOVERNANCE_RULES),
    Control(SEBI, "PR.AA.S1", "Identities and credentials managed through their life cycle",
            "Identities and credentials are issued, managed, verified, revoked and "
            "audited.", _SECRET_HYGIENE_RULES),
    Control(SEBI, "PR.AA.S2", "Network integrity, segregation and segmentation",
            "Network integrity is protected, including through segregation and "
            "segmentation.",
            _WORLD_OPEN_ADMIN_PORT_RULES + _EXPOSURE_RULES + _SEGREGATION_RULES),
    Control(SEBI, "PR.AA.S3", "Least privilege and segregation of duties",
            "Access follows least privilege and segregation of duties, on premises and "
            "in the cloud.", _IAM_RULES),
    Control(SEBI, "PR.AA.S7", "Multi-factor authentication from untrusted networks",
            "MFA protects access to critical systems from untrusted networks.", ()),
    Control(SEBI, "PR.AA.S12", "Remote access tracked and administered",
            "Remote access is strictly tracked and administered.",
            _WORLD_OPEN_ADMIN_PORT_RULES + ("EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",)),
    Control(SEBI, "PR.DS.S1", "Data at rest and in transit protected",
            "Data at rest and data in transit are protected.",
            _ENCRYPTION_RULES + _TRANSIT_RULES),
    Control(SEBI, "PR.DS.S4", "Protection against data leaks",
            "Measures protect against data leaks.", _PUBLIC_ACCESS_RULES),
    Control(SEBI, "PR.IP.S1", "Baseline configuration with least functionality",
            "A baseline configuration incorporating least functionality is maintained.",
            _SECURE_CONFIG_RULES),
    Control(SEBI, "PR.IP.S3", "Configuration change control",
            "Configuration changes are controlled.", ()),
    Control(SEBI, "PR.IP.S8", "Backups implemented, maintained and tested",
            "Backups are implemented, tested and maintained.", _BACKUP_RULES),
    Control(SEBI, "PR.MA.S3", "Patches handled according to severity",
            "Patches are applied according to their severity.", _VULN_RULES),
    Control(SEBI, "DE.CM.S1", "Continuous security monitoring",
            "Systems are continuously monitored (a 24x7 SOC for applicable entities).",
            ()),
    Control(SEBI, "CF 6.2.1", "Cloud Framework — vulnerability and patch management",
            "Vulnerabilities in cloud workloads are managed and patched.", _VULN_RULES),
    Control(SEBI, "CF 6.2.5", "Cloud Framework — secure user management",
            "Least privilege, access review, time-bound access and MFA for "
            "administration.", _IAM_RULES),
    Control(SEBI, "CF 6.2.6", "Cloud Framework — security of interfaces",
            "Management and internet-facing interfaces are secured.",
            _EXPOSURE_RULES + _ENDPOINT_RULES),
    Control(SEBI, "CF 6.2.9", "Cloud Framework — encryption and key management",
            "Data is encrypted and cryptographic keys are managed (BYOK/BYOE, HSM where "
            "required).", _ENCRYPTION_RULES + _KEY_MANAGEMENT_RULES),
    Control(SEBI, "CF 6.2.11", "Cloud Framework — network security",
            "Networks are secured, including micro-segmentation.", _SG_RULES),
    Control(SEBI, "CF 6.2.12", "Cloud Framework — backup and recovery",
            "A backup and recovery solution is in place.", _BACKUP_RULES),

    # ── GDPR — Regulation (EU) 2016/679 ──────────────────────────────────────
    # Titles are Actmon's paraphrase of the Article; quote the Regulation's own
    # text to a DPO or regulator. Most of GDPR is a lawful-basis and process
    # question a configuration scan cannot answer — those Articles are listed
    # with empty rules on purpose (see FRAMEWORK_META[GDPR]).
    Control(GDPR, "Art. 5(1)(f)", "Integrity and confidentiality principle",
            "Personal data is processed in a manner that ensures appropriate security, "
            "including protection against unauthorised or unlawful processing and "
            "against accidental loss, destruction or damage.",
            _ENCRYPTION_RULES + _PUBLIC_ACCESS_RULES),
    Control(GDPR, "Art. 5(1)(c)", "Data minimisation",
            "Personal data is adequate, relevant and limited to what is necessary for "
            "the purposes for which it is processed.", ()),  # needs data classification
    Control(GDPR, "Art. 25", "Data protection by design and by default",
            "Technical and organisational measures implement data-protection principles "
            "effectively, by design and by default.", ()),  # a design review, not a scan
    Control(GDPR, "Art. 32(1)(a)", "Pseudonymisation and encryption",
            "Appropriate technical measures include the pseudonymisation and encryption "
            "of personal data.", _ENCRYPTION_RULES),
    Control(GDPR, "Art. 32(1)(b)", "Confidentiality, integrity, availability and resilience",
            "The ongoing confidentiality, integrity, availability and resilience of "
            "processing systems and services is ensured.",
            _EXPOSURE_RULES + _SG_RULES + _SECURE_CONFIG_RULES),
    Control(GDPR, "Art. 32(1)(c)", "Timely restoration after an incident",
            "The ability to restore the availability and access to personal data in a "
            "timely manner in the event of a physical or technical incident.",
            _BACKUP_RULES),
    Control(GDPR, "Art. 32(1)(d)", "Regular testing and evaluation",
            "A process for regularly testing, assessing and evaluating the effectiveness "
            "of technical and organisational measures. A configuration scan is not VA/PT.",
            ()),
    Control(GDPR, "Art. 32(2)", "Risks of accidental or unlawful processing",
            "Measures account for the risks of accidental or unlawful destruction, loss, "
            "alteration, unauthorised disclosure of, or access to, personal data "
            "transmitted, stored or otherwise processed.",
            _PUBLIC_ACCESS_RULES + _PUBLIC_STORAGE_RULES + _TRANSIT_RULES),
    Control(GDPR, "Art. 32(4)", "Access limited to authorised persons",
            "Any person acting under the authority of the controller or processor who "
            "has access to personal data processes it only on instructions.",
            _IAM_RULES),
    Control(GDPR, "Art. 30", "Records of processing activities",
            "A record of processing activities is maintained.", ()),
    Control(GDPR, "Art. 33", "Notification of a personal data breach",
            "A personal data breach is notified to the supervisory authority, and where "
            "required to the data subject, without undue delay.", ()),
    Control(GDPR, "Art. 35", "Data protection impact assessment",
            "A DPIA is carried out where processing is likely to result in a high risk "
            "to natural persons.", ()),
    Control(GDPR, "Art. 44", "General principle for transfers",
            "Any transfer of personal data to a third country takes place only in "
            "compliance with the conditions of Chapter V.", ()),
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


def controls_for_rule(rule_id: str, provider: Optional[str] = None) -> List[Control]:
    """The controls a rule assesses — only those of frameworks that apply to
    `provider` when one is given."""
    controls = _RULE_TO_CONTROLS.get(rule_id, [])
    if provider is None:
        return controls
    return [c for c in controls if applies_to(c.framework, provider)]


def mappings_for_rule(rule_id: str, provider: Optional[str] = None) -> Dict[str, List[str]]:
    """`{framework: [control refs]}` for stamping onto a finding.

    Shape kept identical to the old service's `controls` field so the existing
    Compliance UI renders it unchanged. With `provider`, a cross-cloud rule's
    finding carries only its own cloud's benchmark citations.
    """
    out: Dict[str, List[str]] = {}
    for c in controls_for_rule(rule_id, provider):
        out.setdefault(c.framework, []).append(f"{c.control_id} {c.title}")
    return {fw: sorted(refs) for fw, refs in out.items()}


def strict_for_rule(rule_id: str, provider: Optional[str] = None) -> bool:
    """Whether any applicable control this rule assesses is strict — i.e.
    whether ANY confirmed finding of it is a control violation."""
    return any(c.strict for c in controls_for_rule(rule_id, provider))


def all_assessing_rule_ids() -> frozenset:
    return frozenset(_RULE_TO_CONTROLS)


def catalog_summary(provider: Optional[str] = None) -> Dict[str, Dict[str, int]]:
    """How many controls each framework declares, and how many any rule
    covers. Lets the UI state the scope of the catalog up front rather than
    implying it is the whole framework. With `provider`, only frameworks that
    apply to it."""
    out = {}
    for fw in (frameworks_for(provider) if provider else FRAMEWORKS):
        declared = BY_FRAMEWORK[fw]
        out[fw] = {
            "declared": len(declared),
            "with_checks": sum(1 for c in declared if c.rules),
            "without_checks": sum(1 for c in declared if not c.rules),
        }
    return out


def framework_meta(framework: str) -> Dict[str, object]:
    """Serializable metadata, providers as a list."""
    meta = dict(FRAMEWORK_META[framework])
    providers = meta.get("providers")
    meta["providers"] = list(providers) if providers else None
    return meta
