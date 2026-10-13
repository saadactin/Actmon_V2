"""The canonical vocabulary of Identity & Access (CIEM).

Everything downstream — the three provider evaluators, the usage correlator,
the blast-radius engine, the trust mapper, the finding rules, the API and the
UI — reads its constants from here, for the reason `security/model.py` exists:
when each analyser invents its own strings, two of them eventually disagree
about the same principal and nobody can tell which is right.

Five ideas carry most of the weight.

**An identity is not a resource.** `identity_grant.py` already made this
argument for role assignments and it holds harder for principals: a user has
no region, no cost and no power state, and filing 10,000 of them into
`cloud_resources` would put them in the Resources tab, the inventory count,
the drift log and the topology, each of which would then need to learn to
exclude them again. Identities get their own tables and their own tab.

**A decision is not a boolean, and "we did not look" is not "allowed".** The
whole point of an effective-permissions engine is to answer "can this
principal do this?" — but every provider has inputs this platform may not
hold. AWS service-control policies need Organizations access the member
credential usually lacks; Azure deny assignments need a permission the
subscription reader does not have. An evaluator that silently treats an
uncollected input as permissive will confidently report ALLOWED on access
that is in fact blocked, and — far worse — report an absence of grants as
though it had been verified. So a `Decision` carries the stages that were NOT
evaluated, every read path shows them, and a decision with unevaluated stages
is never presented as certain.

**Usage evidence is a window, never a fact about all time.** "This permission
is unused" is unprovable from an audit log that starts 90 days ago and omits
data-plane calls. The engine therefore never says *unused*; it says
NOT_OBSERVED, always beside the window that was searched and the number of
events in it. §35 of the brief is the rule and this is the mechanism.

**MFA does not apply to a workload.** Treating a service principal as an
"MFA gap" generates thousands of findings nobody can act on and trains people
to ignore the real one — a human admin without MFA. `actor_class` exists to
keep that distinction, and `MFA_NOT_APPLICABLE` is a first-class answer.

**The normalized capability is an index, not a replacement.** §32 asks for a
cross-cloud vocabulary; the trap is letting it become the only thing stored,
at which point `s3:DeleteObject` and `s3:DeleteBucket` are both STORAGE_DELETE
and the operator can no longer tell which one the role actually has. Every
normalized capability on every record is carried beside the provider's own
action string, never instead of it.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Providers are the Security Center's, imported rather than re-declared so a
# new provider cannot be half-added to the product.
from app.security.model import AWS, AZURE, OCI, PROVIDERS, normalize_provider  # noqa: F401


# ── Identity type: the provider's own shape, normalized in spelling only ─────
# Deliberately NOT collapsed into one cross-cloud enum. An AWS IAM role and an
# Azure managed identity behave differently enough — one is assumed, the other
# is attached to a resource — that merging them would lose the distinction the
# analyst needs. What IS normalized is the spelling, so the table can filter.
AWS_IAM_USER = "AWS_IAM_USER"
AWS_IAM_ROLE = "AWS_IAM_ROLE"
AWS_IAM_GROUP = "AWS_IAM_GROUP"
AWS_ROOT = "AWS_ROOT"
AWS_STS_SESSION = "AWS_STS_SESSION"

AZURE_USER = "AZURE_USER"
AZURE_SERVICE_PRINCIPAL = "AZURE_SERVICE_PRINCIPAL"
AZURE_MANAGED_IDENTITY = "AZURE_MANAGED_IDENTITY"
AZURE_GROUP = "AZURE_GROUP"
AZURE_FOREIGN_PRINCIPAL = "AZURE_FOREIGN_PRINCIPAL"

OCI_USER = "OCI_USER"
OCI_GROUP = "OCI_GROUP"
OCI_DYNAMIC_GROUP = "OCI_DYNAMIC_GROUP"
OCI_FEDERATED_USER = "OCI_FEDERATED_USER"

# The provider named a principal we could not resolve to a type. Distinct from
# a type we chose not to model: this one means "we saw it and do not know".
IDENTITY_TYPE_UNKNOWN = "UNKNOWN"

IDENTITY_TYPES: Tuple[str, ...] = (
    AWS_IAM_USER, AWS_IAM_ROLE, AWS_IAM_GROUP, AWS_ROOT, AWS_STS_SESSION,
    AZURE_USER, AZURE_SERVICE_PRINCIPAL, AZURE_MANAGED_IDENTITY, AZURE_GROUP,
    AZURE_FOREIGN_PRINCIPAL,
    OCI_USER, OCI_GROUP, OCI_DYNAMIC_GROUP, OCI_FEDERATED_USER,
    IDENTITY_TYPE_UNKNOWN,
)

IDENTITY_TYPE_LABEL: Dict[str, str] = {
    AWS_IAM_USER: "IAM user",
    AWS_IAM_ROLE: "IAM role",
    AWS_IAM_GROUP: "IAM group",
    AWS_ROOT: "Root account",
    AWS_STS_SESSION: "Assumed-role session",
    AZURE_USER: "Entra user",
    AZURE_SERVICE_PRINCIPAL: "Service principal",
    AZURE_MANAGED_IDENTITY: "Managed identity",
    AZURE_GROUP: "Entra group",
    AZURE_FOREIGN_PRINCIPAL: "External / foreign principal",
    OCI_USER: "OCI user",
    OCI_GROUP: "OCI group",
    OCI_DYNAMIC_GROUP: "Dynamic group",
    OCI_FEDERATED_USER: "Federated user",
    IDENTITY_TYPE_UNKNOWN: "Unrecognised principal type",
}

IDENTITY_TYPES_BY_PROVIDER: Dict[str, Tuple[str, ...]] = {
    AWS: (AWS_IAM_USER, AWS_IAM_ROLE, AWS_IAM_GROUP, AWS_ROOT, AWS_STS_SESSION),
    AZURE: (AZURE_USER, AZURE_SERVICE_PRINCIPAL, AZURE_MANAGED_IDENTITY,
            AZURE_GROUP, AZURE_FOREIGN_PRINCIPAL),
    OCI: (OCI_USER, OCI_GROUP, OCI_DYNAMIC_GROUP, OCI_FEDERATED_USER),
}


# ── Actor class: human, workload, or a container for either ──────────────────
# This is the field that decides whether an MFA question is even meaningful,
# whether "last interactive sign-in" is a sensible column, and whether a
# dormancy finding should read "offboard this leaver" or "retire this service".
ACTOR_HUMAN = "HUMAN"
ACTOR_WORKLOAD = "WORKLOAD"
ACTOR_GROUP = "GROUP"          # a container; its own MFA/last-used are meaningless
ACTOR_UNKNOWN = "UNKNOWN"

ACTOR_CLASSES: Tuple[str, ...] = (ACTOR_HUMAN, ACTOR_WORKLOAD, ACTOR_GROUP, ACTOR_UNKNOWN)

ACTOR_CLASS_LABEL: Dict[str, str] = {
    ACTOR_HUMAN: "Human",
    ACTOR_WORKLOAD: "Workload",
    ACTOR_GROUP: "Group (container)",
    ACTOR_UNKNOWN: "Unclassified",
}

# The default class per identity type. An AWS IAM role is the interesting case:
# it is overwhelmingly a workload identity, but an SSO permission-set role is
# assumed by people. The collector refines this from the trust policy; the
# table here is only the starting point, and ACTOR_UNKNOWN is used wherever
# the shape genuinely does not say.
DEFAULT_ACTOR_CLASS: Dict[str, str] = {
    AWS_IAM_USER: ACTOR_HUMAN,
    AWS_IAM_ROLE: ACTOR_WORKLOAD,
    AWS_IAM_GROUP: ACTOR_GROUP,
    AWS_ROOT: ACTOR_HUMAN,
    AWS_STS_SESSION: ACTOR_UNKNOWN,
    AZURE_USER: ACTOR_HUMAN,
    AZURE_SERVICE_PRINCIPAL: ACTOR_WORKLOAD,
    AZURE_MANAGED_IDENTITY: ACTOR_WORKLOAD,
    AZURE_GROUP: ACTOR_GROUP,
    AZURE_FOREIGN_PRINCIPAL: ACTOR_UNKNOWN,
    OCI_USER: ACTOR_HUMAN,
    OCI_GROUP: ACTOR_GROUP,
    OCI_DYNAMIC_GROUP: ACTOR_WORKLOAD,   # matches compute resources, never people
    OCI_FEDERATED_USER: ACTOR_HUMAN,
    IDENTITY_TYPE_UNKNOWN: ACTOR_UNKNOWN,
}


# ── Lifecycle status ─────────────────────────────────────────────────────────
STATUS_ACTIVE = "ACTIVE"
STATUS_DISABLED = "DISABLED"
STATUS_DELETED = "DELETED"      # seen previously, absent from the latest sweep
STATUS_UNKNOWN = "UNKNOWN"

IDENTITY_STATUSES: Tuple[str, ...] = (STATUS_ACTIVE, STATUS_DISABLED, STATUS_DELETED,
                                      STATUS_UNKNOWN)


# ── MFA ──────────────────────────────────────────────────────────────────────
# Four states, and the fourth is the one that keeps the feature usable.
MFA_ENABLED = "ENABLED"
MFA_DISABLED = "DISABLED"
MFA_UNKNOWN = "UNKNOWN"                # applies, but the provider did not tell us
MFA_NOT_APPLICABLE = "NOT_APPLICABLE"  # workload identity: no interactive sign-in

MFA_STATES: Tuple[str, ...] = (MFA_ENABLED, MFA_DISABLED, MFA_UNKNOWN, MFA_NOT_APPLICABLE)

MFA_LABEL: Dict[str, str] = {
    MFA_ENABLED: "Enabled",
    MFA_DISABLED: "Not enabled",
    MFA_UNKNOWN: "Unknown — provider did not report it",
    MFA_NOT_APPLICABLE: "N/A — workload identity",
}

# Only this one is a finding. MFA_UNKNOWN is a COVERAGE gap and is reported as
# one; turning it into "MFA disabled" would be exactly the §35 failure of
# converting missing data into a risk verdict.
MFA_STATES_AT_RISK = frozenset({MFA_DISABLED})


# ── Access decision ──────────────────────────────────────────────────────────
# What an evaluation concluded about one (principal, action, resource) triple.
ALLOWED = "ALLOWED"
DENIED = "DENIED"
# Allowed by the policies we could read, but at least one input in the
# provider's own evaluation chain was unavailable. This is NOT "allowed"; it is
# "nothing we can see stops it". The distinction is the whole reason the value
# exists — see `Decision.unevaluated`.
ALLOWED_UNVERIFIED = "ALLOWED_UNVERIFIED"
# No statement matched. Every provider's default, and still a real answer.
IMPLICIT_DENY = "IMPLICIT_DENY"
# We could not evaluate at all: the identity's policies were never collected.
NOT_DETERMINED = "NOT_DETERMINED"

DECISIONS: Tuple[str, ...] = (ALLOWED, ALLOWED_UNVERIFIED, DENIED, IMPLICIT_DENY,
                              NOT_DETERMINED)

DECISION_LABEL: Dict[str, str] = {
    ALLOWED: "Allowed",
    ALLOWED_UNVERIFIED: "Allowed by the policies we can read",
    DENIED: "Denied — explicit",
    IMPLICIT_DENY: "Denied — no statement grants it",
    NOT_DETERMINED: "Could not be determined",
}

# Decisions that mean the principal can probably do the thing. Used by blast
# radius and by the reverse "who can access this?" query, both of which must
# include ALLOWED_UNVERIFIED — excluding it would under-report reachability on
# every account where SCPs are not collected, which is most of them.
DECISIONS_PERMISSIVE = frozenset({ALLOWED, ALLOWED_UNVERIFIED})


# ── Evaluation stages ────────────────────────────────────────────────────────
# The provider's own decision chain, named so a result can say which link was
# missing. Order within a provider matters and is enforced by the evaluators.
STAGE_IDENTITY_POLICY = "identity_policy"
STAGE_GROUP_POLICY = "group_policy"
STAGE_RESOURCE_POLICY = "resource_policy"
STAGE_PERMISSION_BOUNDARY = "permission_boundary"
STAGE_SESSION_POLICY = "session_policy"
STAGE_SCP = "service_control_policy"
STAGE_RBAC_ASSIGNMENT = "rbac_assignment"
STAGE_DENY_ASSIGNMENT = "deny_assignment"
STAGE_OCI_POLICY = "oci_policy_statement"
STAGE_TRUST_POLICY = "trust_policy"

STAGE_LABEL: Dict[str, str] = {
    STAGE_IDENTITY_POLICY: "Identity policy",
    STAGE_GROUP_POLICY: "Group policy",
    STAGE_RESOURCE_POLICY: "Resource policy",
    STAGE_PERMISSION_BOUNDARY: "Permissions boundary",
    STAGE_SESSION_POLICY: "Session policy",
    STAGE_SCP: "Service control policy (Organizations)",
    STAGE_RBAC_ASSIGNMENT: "RBAC role assignment",
    STAGE_DENY_ASSIGNMENT: "Deny assignment",
    STAGE_OCI_POLICY: "IAM policy statement",
    STAGE_TRUST_POLICY: "Trust / assume-role policy",
}

# Why a stage was not evaluated. Shown verbatim to the operator, because
# "we lack organizations:ListPolicies" is actionable and "unknown" is not.
UNEVAL_NOT_COLLECTED = "NOT_COLLECTED"
UNEVAL_PERMISSION_DENIED = "PERMISSION_DENIED"
UNEVAL_NOT_SUPPORTED = "NOT_SUPPORTED"
UNEVAL_NOT_APPLICABLE = "NOT_APPLICABLE"


@dataclass(frozen=True)
class Unevaluated:
    """One link of the provider's decision chain that was not checked."""

    stage: str
    reason: str
    detail: Optional[str] = None
    # The provider permission that would let us evaluate it next time.
    missing_permission: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stage": self.stage,
            "stage_label": STAGE_LABEL.get(self.stage, self.stage),
            "reason": self.reason,
            "detail": self.detail,
            "missing_permission": self.missing_permission,
        }


@dataclass
class DecisionStep:
    """One statement that participated in a decision, and what it did.

    This is what makes §3's "make permission evaluation explainable" real: the
    UI renders these in order, so an operator reads the same chain the
    evaluator walked rather than trusting its conclusion.
    """

    stage: str
    effect: str                       # "Allow" / "Deny" / "NoMatch"
    source_name: str                  # policy / role / statement name
    source_key: Optional[str] = None  # ARN, role definition id, policy OCID
    statement_id: Optional[str] = None
    matched_action: Optional[str] = None     # the pattern that matched
    matched_resource: Optional[str] = None
    conditions: Optional[Dict[str, Any]] = None
    inherited_from: Optional[str] = None     # scope or group the grant came from
    note: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stage": self.stage,
            "stage_label": STAGE_LABEL.get(self.stage, self.stage),
            "effect": self.effect,
            "source_name": self.source_name,
            "source_key": self.source_key,
            "statement_id": self.statement_id,
            "matched_action": self.matched_action,
            "matched_resource": self.matched_resource,
            "conditions": self.conditions,
            "inherited_from": self.inherited_from,
            "note": self.note,
        }


@dataclass
class Decision:
    """The answer to "can this principal do this action on this resource?".

    `unevaluated` is not decoration. A Decision of ALLOWED_UNVERIFIED with an
    entry saying the SCP stage was not collected is a materially different
    claim from ALLOWED, and every surface that renders a decision must show it.
    """

    decision: str
    action: str
    resource: Optional[str] = None
    steps: List[DecisionStep] = field(default_factory=list)
    unevaluated: List[Unevaluated] = field(default_factory=list)
    # Set when a matched grant carries provider conditions we do not evaluate
    # (IP ranges, MFA-present, tag matches). The access may not hold at runtime.
    conditional: bool = False

    @property
    def certain(self) -> bool:
        """Whether every link in the provider's chain was actually checked."""
        return not self.unevaluated

    @property
    def permissive(self) -> bool:
        return self.decision in DECISIONS_PERMISSIVE

    def to_dict(self) -> Dict[str, Any]:
        return {
            "decision": self.decision,
            "decision_label": DECISION_LABEL.get(self.decision, self.decision),
            "certain": self.certain,
            "conditional": self.conditional,
            "action": self.action,
            "resource": self.resource,
            "steps": [s.to_dict() for s in self.steps],
            "unevaluated": [u.to_dict() for u in self.unevaluated],
        }


# ── Normalized capability vocabulary (§32) ───────────────────────────────────
# An index over provider actions for cross-cloud questions ("who can delete
# storage anywhere?"). Always carried BESIDE the provider's own action string.
CAP_IAM_ADMINISTRATION = "IAM_ADMINISTRATION"
CAP_IDENTITY_ADMINISTRATION = "IDENTITY_ADMINISTRATION"
CAP_CREDENTIAL_CREATION = "CREDENTIAL_CREATION"
CAP_ROLE_ASSUMPTION = "ROLE_ASSUMPTION"
CAP_NETWORK_ADMINISTRATION = "NETWORK_ADMINISTRATION"
CAP_COMPUTE_ADMINISTRATION = "COMPUTE_ADMINISTRATION"
CAP_STORAGE_READ = "STORAGE_READ"
CAP_STORAGE_WRITE = "STORAGE_WRITE"
CAP_STORAGE_DELETE = "STORAGE_DELETE"
CAP_DATABASE_READ = "DATABASE_READ"
CAP_DATABASE_WRITE = "DATABASE_WRITE"
CAP_DATABASE_ADMINISTRATION = "DATABASE_ADMINISTRATION"
CAP_SECURITY_CONFIGURATION = "SECURITY_CONFIGURATION"
CAP_LOGGING_CONFIGURATION = "LOGGING_CONFIGURATION"
CAP_KEY_MANAGEMENT = "KEY_MANAGEMENT"
CAP_BACKUP_DELETE = "BACKUP_DELETE"
CAP_RESOURCE_DELETE = "RESOURCE_DELETE"
CAP_OTHER = "OTHER"

CAPABILITIES: Tuple[str, ...] = (
    CAP_IAM_ADMINISTRATION, CAP_IDENTITY_ADMINISTRATION, CAP_CREDENTIAL_CREATION,
    CAP_ROLE_ASSUMPTION, CAP_NETWORK_ADMINISTRATION, CAP_COMPUTE_ADMINISTRATION,
    CAP_STORAGE_READ, CAP_STORAGE_WRITE, CAP_STORAGE_DELETE,
    CAP_DATABASE_READ, CAP_DATABASE_WRITE, CAP_DATABASE_ADMINISTRATION,
    CAP_SECURITY_CONFIGURATION, CAP_LOGGING_CONFIGURATION, CAP_KEY_MANAGEMENT,
    CAP_BACKUP_DELETE, CAP_RESOURCE_DELETE, CAP_OTHER,
)

CAPABILITY_LABEL: Dict[str, str] = {
    CAP_IAM_ADMINISTRATION: "IAM administration",
    CAP_IDENTITY_ADMINISTRATION: "Identity administration",
    CAP_CREDENTIAL_CREATION: "Credential creation",
    CAP_ROLE_ASSUMPTION: "Role assumption",
    CAP_NETWORK_ADMINISTRATION: "Network administration",
    CAP_COMPUTE_ADMINISTRATION: "Compute administration",
    CAP_STORAGE_READ: "Storage read",
    CAP_STORAGE_WRITE: "Storage write",
    CAP_STORAGE_DELETE: "Storage delete",
    CAP_DATABASE_READ: "Database read",
    CAP_DATABASE_WRITE: "Database write",
    CAP_DATABASE_ADMINISTRATION: "Database administration",
    CAP_SECURITY_CONFIGURATION: "Security configuration",
    CAP_LOGGING_CONFIGURATION: "Logging configuration",
    CAP_KEY_MANAGEMENT: "Key management",
    CAP_BACKUP_DELETE: "Backup deletion",
    CAP_RESOURCE_DELETE: "Resource deletion",
    CAP_OTHER: "Other",
}

# §25's dangerous-capability catalog: the ones whose presence on an identity is
# worth stating on its own, because each is a step in a real attack path
# (take over an identity, mint credentials, disable the logging that would
# show it, delete the backups that would undo it).
HIGH_IMPACT_CAPABILITIES: Tuple[str, ...] = (
    CAP_IAM_ADMINISTRATION, CAP_IDENTITY_ADMINISTRATION, CAP_CREDENTIAL_CREATION,
    CAP_ROLE_ASSUMPTION, CAP_NETWORK_ADMINISTRATION, CAP_SECURITY_CONFIGURATION,
    CAP_LOGGING_CONFIGURATION, CAP_KEY_MANAGEMENT, CAP_BACKUP_DELETE,
    CAP_STORAGE_DELETE, CAP_DATABASE_ADMINISTRATION, CAP_RESOURCE_DELETE,
)

HIGH_IMPACT_WHY: Dict[str, str] = {
    CAP_IAM_ADMINISTRATION:
        "Can change who is allowed to do what, including granting itself more.",
    CAP_IDENTITY_ADMINISTRATION:
        "Can create, modify or delete principals in the directory.",
    CAP_CREDENTIAL_CREATION:
        "Can mint a new long-lived credential, which survives the identity being disabled.",
    CAP_ROLE_ASSUMPTION:
        "Can become another principal, inheriting permissions it was not granted directly.",
    CAP_NETWORK_ADMINISTRATION:
        "Can open network paths, including exposing a private resource to the internet.",
    CAP_SECURITY_CONFIGURATION:
        "Can weaken or disable the controls that detect everything else on this list.",
    CAP_LOGGING_CONFIGURATION:
        "Can stop the audit trail, removing the evidence of any subsequent action.",
    CAP_KEY_MANAGEMENT:
        "Can read, rotate or destroy encryption keys, making data readable or permanently lost.",
    CAP_BACKUP_DELETE:
        "Can destroy the copies that make a destructive action recoverable.",
    CAP_STORAGE_DELETE:
        "Can permanently delete stored data.",
    CAP_DATABASE_ADMINISTRATION:
        "Full control of a database, including dropping it and reading everything in it.",
    CAP_RESOURCE_DELETE:
        "Can destroy infrastructure.",
}


# ── Privilege level ──────────────────────────────────────────────────────────
# Derived from evaluated capability, never from a role's NAME. The lesson is
# already recorded in security/identity.py: a custom role carrying
# roleAssignments/write is the most dangerous thing in a subscription and no
# name-based list will contain it.
PRIV_ADMIN = "ADMIN"            # unconstrained, or can grant itself anything
PRIV_PRIVILEGED = "PRIVILEGED"  # holds at least one high-impact capability
PRIV_STANDARD = "STANDARD"
PRIV_READ_ONLY = "READ_ONLY"
PRIV_UNKNOWN = "UNKNOWN"        # policies not collected — NOT "read only"

PRIVILEGE_LEVELS: Tuple[str, ...] = (PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_STANDARD,
                                     PRIV_READ_ONLY, PRIV_UNKNOWN)

PRIVILEGE_RANK: Dict[str, int] = {p: i for i, p in enumerate(PRIVILEGE_LEVELS)}

PRIVILEGE_LABEL: Dict[str, str] = {
    PRIV_ADMIN: "Administrative",
    PRIV_PRIVILEGED: "Privileged",
    PRIV_STANDARD: "Standard",
    PRIV_READ_ONLY: "Read-only",
    PRIV_UNKNOWN: "Not assessed",
}


# ── Usage observation (§5) ───────────────────────────────────────────────────
# The engine never emits "unused". These are the only four answers, and three
# of them are flavours of "we did not see it", separated by how much that is
# worth acting on.
USAGE_OBSERVED = "OBSERVED"
# Granted, and no event for it in the window. Confidence splits on whether the
# provider's audit log is capable of recording that action at all.
USAGE_NOT_OBSERVED_HIGH = "NOT_OBSERVED_HIGH_CONFIDENCE"
USAGE_NOT_OBSERVED_LOW = "NOT_OBSERVED_LOW_CONFIDENCE"
# The audit source for this action class is not collected for this account, so
# absence of an event says nothing whatsoever.
USAGE_UNKNOWN = "UNKNOWN"

USAGE_STATES: Tuple[str, ...] = (USAGE_OBSERVED, USAGE_NOT_OBSERVED_HIGH,
                                 USAGE_NOT_OBSERVED_LOW, USAGE_UNKNOWN)

USAGE_LABEL: Dict[str, str] = {
    USAGE_OBSERVED: "Observed in the window",
    USAGE_NOT_OBSERVED_HIGH: "Not observed — high confidence",
    USAGE_NOT_OBSERVED_LOW: "Not observed — low confidence",
    USAGE_UNKNOWN: "Unknown — no usable audit data",
}

USAGE_MEANING: Dict[str, str] = {
    USAGE_OBSERVED:
        "At least one event for this action appears in the window.",
    USAGE_NOT_OBSERVED_HIGH:
        "The audit log covers this action type and the window is long enough; "
        "no event for it was found. This is the strongest evidence available "
        "that the permission is unnecessary — it is still not proof.",
    USAGE_NOT_OBSERVED_LOW:
        "No event found, but the window is short, the log has gaps, or this "
        "action class is only partially recorded. Treat as a lead, not a verdict.",
    USAGE_UNKNOWN:
        "No audit data covers this action for this account. Absence of an "
        "event is not evidence of anything.",
}

# Only this one may be offered as a removal candidate by the right-sizing
# workflow. The others are shown and explained but never pre-selected.
USAGE_SAFE_TO_PROPOSE = frozenset({USAGE_NOT_OBSERVED_HIGH})

# Provider data-plane blind spots, stated once. These are the reason
# USAGE_NOT_OBSERVED_LOW exists: S3 object-level calls need a data-event trail
# that is off by default, so "no s3:GetObject seen" usually means "not logged",
# and proposing its removal on that basis would break the application.
DATA_PLANE_BLIND: Dict[str, Tuple[str, ...]] = {
    AWS: ("s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket",
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan",
          "lambda:InvokeFunction", "kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey",
          "sqs:ReceiveMessage", "sqs:SendMessage", "sns:Publish"),
    AZURE: ("Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read",
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/delete",
            "Microsoft.KeyVault/vaults/secrets/getSecret/action"),
    OCI: ("object-family:read", "object-family:write", "objects:read", "objects:write"),
}


# ── Dormancy ─────────────────────────────────────────────────────────────────
DORMANT_THRESHOLD_DAYS: Tuple[int, ...] = (30, 60, 90, 180, 365)
DEFAULT_DORMANT_DAYS = 90

DORMANCY_DORMANT = "DORMANT"
DORMANCY_ACTIVE = "ACTIVE"
DORMANCY_NEVER_USED = "NEVER_USED"      # provider states it has never been used
DORMANCY_UNKNOWN = "UNKNOWN"            # no last-used data exists for this type

DORMANCY_STATES: Tuple[str, ...] = (DORMANCY_DORMANT, DORMANCY_ACTIVE,
                                    DORMANCY_NEVER_USED, DORMANCY_UNKNOWN)

DORMANCY_LABEL: Dict[str, str] = {
    DORMANCY_DORMANT: "Dormant",
    DORMANCY_ACTIVE: "Active",
    DORMANCY_NEVER_USED: "Never used",
    DORMANCY_UNKNOWN: "Unknown — no last-used data",
}


# ── Credential kinds and rotation posture (§9) ───────────────────────────────
CRED_AWS_ACCESS_KEY = "AWS_ACCESS_KEY"
CRED_AWS_LOGIN_PROFILE = "AWS_LOGIN_PROFILE"
CRED_OCI_API_KEY = "OCI_API_KEY"
CRED_OCI_AUTH_TOKEN = "OCI_AUTH_TOKEN"
CRED_OCI_SECRET_KEY = "OCI_CUSTOMER_SECRET_KEY"
CRED_AZURE_SP_SECRET = "AZURE_CLIENT_SECRET"
CRED_AZURE_SP_CERT = "AZURE_CLIENT_CERTIFICATE"

CREDENTIAL_KINDS: Tuple[str, ...] = (
    CRED_AWS_ACCESS_KEY, CRED_AWS_LOGIN_PROFILE, CRED_OCI_API_KEY,
    CRED_OCI_AUTH_TOKEN, CRED_OCI_SECRET_KEY, CRED_AZURE_SP_SECRET,
    CRED_AZURE_SP_CERT,
)

CREDENTIAL_KIND_LABEL: Dict[str, str] = {
    CRED_AWS_ACCESS_KEY: "Access key",
    CRED_AWS_LOGIN_PROFILE: "Console password",
    CRED_OCI_API_KEY: "API signing key",
    CRED_OCI_AUTH_TOKEN: "Auth token",
    CRED_OCI_SECRET_KEY: "Customer secret key",
    CRED_AZURE_SP_SECRET: "Client secret",
    CRED_AZURE_SP_CERT: "Client certificate",
}

CRED_ACTIVE = "ACTIVE"
CRED_INACTIVE = "INACTIVE"
CRED_EXPIRED = "EXPIRED"
CRED_STATUS_UNKNOWN = "UNKNOWN"

# Recommended dispositions. Never executed without approval (§9, §30).
RECO_ROTATE = "ROTATE"
RECO_DISABLE = "DISABLE"
RECO_DELETE = "DELETE"
RECO_NONE = "NONE"
RECO_INVESTIGATE = "INVESTIGATE"


# ── Access-request / right-sizing lifecycle (§7, §15) ────────────────────────
PROPOSED = "PROPOSED"
APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
APPROVED = "APPROVED"
REJECTED = "REJECTED"
APPLIED = "APPLIED"
FAILED = "FAILED"
ROLLED_BACK = "ROLLED_BACK"
EXPIRED = "EXPIRED"
CANCELLED = "CANCELLED"
ACTIVE = "ACTIVE"
REVOKED = "REVOKED"

PROPOSAL_STATUSES: Tuple[str, ...] = (PROPOSED, APPROVAL_REQUIRED, APPROVED, REJECTED,
                                      APPLIED, FAILED, ROLLED_BACK, CANCELLED)
JIT_STATUSES: Tuple[str, ...] = (APPROVAL_REQUIRED, APPROVED, ACTIVE, EXPIRED,
                                 REJECTED, FAILED, REVOKED, CANCELLED)

TERMINAL_PROPOSAL_STATUSES = frozenset({REJECTED, APPLIED, FAILED, ROLLED_BACK, CANCELLED})
TERMINAL_JIT_STATUSES = frozenset({EXPIRED, REJECTED, FAILED, REVOKED, CANCELLED})

STATUS_LABEL: Dict[str, str] = {
    PROPOSED: "Proposed",
    APPROVAL_REQUIRED: "Awaiting approval",
    APPROVED: "Approved",
    REJECTED: "Rejected",
    APPLIED: "Applied",
    FAILED: "Failed",
    ROLLED_BACK: "Rolled back",
    EXPIRED: "Expired",
    CANCELLED: "Cancelled",
    ACTIVE: "Active",
    REVOKED: "Revoked",
}


# ── External principals (§14) ────────────────────────────────────────────────
EXTERNAL_NO = "INTERNAL"
EXTERNAL_YES = "EXTERNAL"
EXTERNAL_UNKNOWN = "UNKNOWN"
# A wildcard principal: anyone, anywhere. Its own value because it is not
# merely external, and collapsing it into EXTERNAL loses the worst case.
EXTERNAL_ANONYMOUS = "ANONYMOUS"

EXTERNAL_STATES: Tuple[str, ...] = (EXTERNAL_NO, EXTERNAL_YES, EXTERNAL_UNKNOWN,
                                    EXTERNAL_ANONYMOUS)

EXTERNAL_LABEL: Dict[str, str] = {
    EXTERNAL_NO: "Internal",
    EXTERNAL_YES: "External principal",
    EXTERNAL_UNKNOWN: "Could not determine",
    EXTERNAL_ANONYMOUS: "Anonymous / any principal",
}


# ── Identity fingerprint ─────────────────────────────────────────────────────
def identity_key(*, provider: str, account_id: str, identity_type: str,
                 provider_id: str) -> str:
    """Deterministic identity for a principal across scans.

    Built from the PROVIDER's own id (ARN / object id / OCID), never the
    display name: names are mutable and, for Azure service principals, often
    absent entirely. The same reasoning as `security.model.fingerprint`.
    """
    raw = "|".join([
        (normalize_provider(provider) or provider or "?").upper(),
        str(account_id or "?"),
        identity_type or "?",
        provider_id or "?",
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def worst_privilege(levels: Sequence[Optional[str]]) -> str:
    """The highest privilege among several, or UNKNOWN when there are none.

    UNKNOWN deliberately ranks LAST in PRIVILEGE_LEVELS but is what an empty
    input returns, so "we assessed nothing" never reads as READ_ONLY.
    """
    known = [lvl for lvl in levels if lvl in PRIVILEGE_RANK]
    if not known:
        return PRIV_UNKNOWN
    return min(known, key=lambda lvl: PRIVILEGE_RANK[lvl])


def days_between(earlier: Optional[datetime], later: Optional[datetime]) -> Optional[int]:
    """Whole days between two instants, or None if either is missing.

    Returning None rather than 0 is the point: callers must render "unknown",
    and a 0 here would read as "used today".
    """
    if earlier is None or later is None:
        return None
    return max(0, int((later - earlier).total_seconds() // 86400))


def meta() -> Dict[str, Any]:
    """The whole vocabulary, served to the UI so legend and engine agree."""
    return {
        "identity_types": [
            {"value": t, "label": IDENTITY_TYPE_LABEL[t],
             "default_actor_class": DEFAULT_ACTOR_CLASS.get(t, ACTOR_UNKNOWN)}
            for t in IDENTITY_TYPES
        ],
        "identity_types_by_provider": {k: list(v) for k, v in IDENTITY_TYPES_BY_PROVIDER.items()},
        "actor_classes": [{"value": c, "label": ACTOR_CLASS_LABEL[c]} for c in ACTOR_CLASSES],
        "statuses": list(IDENTITY_STATUSES),
        "mfa_states": [{"value": m, "label": MFA_LABEL[m]} for m in MFA_STATES],
        "decisions": [{"value": d, "label": DECISION_LABEL[d]} for d in DECISIONS],
        "stages": [{"value": s, "label": lbl} for s, lbl in STAGE_LABEL.items()],
        "capabilities": [
            {"value": c, "label": CAPABILITY_LABEL[c],
             "high_impact": c in HIGH_IMPACT_CAPABILITIES,
             "why": HIGH_IMPACT_WHY.get(c)}
            for c in CAPABILITIES
        ],
        "privilege_levels": [{"value": p, "label": PRIVILEGE_LABEL[p]} for p in PRIVILEGE_LEVELS],
        "usage_states": [
            {"value": u, "label": USAGE_LABEL[u], "meaning": USAGE_MEANING[u],
             "may_propose_removal": u in USAGE_SAFE_TO_PROPOSE}
            for u in USAGE_STATES
        ],
        "dormancy_states": [{"value": d, "label": DORMANCY_LABEL[d]} for d in DORMANCY_STATES],
        "dormancy_thresholds": list(DORMANT_THRESHOLD_DAYS),
        "default_dormant_days": DEFAULT_DORMANT_DAYS,
        "credential_kinds": [
            {"value": k, "label": CREDENTIAL_KIND_LABEL[k]} for k in CREDENTIAL_KINDS
        ],
        "external_states": [{"value": e, "label": EXTERNAL_LABEL[e]} for e in EXTERNAL_STATES],
        "proposal_statuses": list(PROPOSAL_STATUSES),
        "jit_statuses": list(JIT_STATUSES),
        "status_labels": dict(STATUS_LABEL),
        "data_plane_blind_spots": {k: list(v) for k, v in DATA_PLANE_BLIND.items()},
    }
