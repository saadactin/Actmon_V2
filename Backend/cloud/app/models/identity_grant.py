"""Identity grants, and the health of collecting them.

Why a table of its own rather than rows in `cloud_resources`: a role
assignment is not a piece of infrastructure. It has no region, no cost, no
status, and it is not a thing you can stop or resize. Storing 280 Azure role
assignments as "resources" would put them in the Resources tab, the inventory
count, the topology and the drift log, where every one of those features would
have to learn to exclude them again.

`CloudIdentityCollectionState` is the more important of the two tables. It is
the difference between these two situations, which are indistinguishable if you
only look at the grants table:

    "This subscription has no over-privileged identities."
    "We were refused permission to look."

The live estate has both. Two of the three Azure subscriptions return role
assignments; the third answers `AuthorizationFailed` on
`Microsoft.Authorization/roleAssignments/read`. Recording the refusal, with the
provider's own error text and the exact action that was denied, is what lets
the identity review say "not assessed, and here is the permission to grant"
instead of showing a reassuring empty list.

The same pattern is already load-bearing for the Event Log
(`CloudEventSyncState`) and for the same reason.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target must be registered)

# ── Collection outcomes ──────────────────────────────────────────────────────
COLLECT_OK = "Collected"
COLLECT_PERMISSION_DENIED = "PermissionDenied"
COLLECT_AUTH_FAILED = "AuthenticationFailed"
COLLECT_UNAVAILABLE = "Unavailable"
COLLECT_NOT_SUPPORTED = "NotSupported"   # provider has no such API in this build
COLLECT_NEVER_RUN = "NeverRun"

COLLECTION_STATES = (
    COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_AUTH_FAILED,
    COLLECT_UNAVAILABLE, COLLECT_NOT_SUPPORTED, COLLECT_NEVER_RUN,
)

# Only this one means "the absence of a grant is real information".
COLLECTION_TRUSTWORTHY = frozenset({COLLECT_OK})

# ── Scope levels, coarsest first ─────────────────────────────────────────────
# Breadth of a grant is mostly a function of where it is attached, so this is
# ranked and used directly by the identity analyser's severity decision.
SCOPE_ROOT = "root"                  # Azure management group / AWS org / OCI tenancy
SCOPE_SUBSCRIPTION = "subscription"  # Azure subscription / AWS account / OCI tenancy
SCOPE_GROUP = "group"                # Azure resource group / OCI compartment
SCOPE_RESOURCE = "resource"

SCOPE_RANK = {SCOPE_ROOT: 0, SCOPE_SUBSCRIPTION: 1, SCOPE_GROUP: 2, SCOPE_RESOURCE: 3}

SCOPE_LABEL = {
    SCOPE_ROOT: "Management group / tenancy root",
    SCOPE_SUBSCRIPTION: "Whole subscription / account",
    SCOPE_GROUP: "Resource group / compartment",
    SCOPE_RESOURCE: "Single resource",
}


class CloudIdentityGrant(Base):
    """One "principal P holds role R at scope S" statement, normalised across
    providers so the analyser has one shape to read."""

    __tablename__ = "cloud_identity_grants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # The provider's own id for the assignment. Unique per account so a
    # re-collection updates rather than duplicates.
    grant_key: Mapped[str] = mapped_column(String(1024), nullable=False)

    # Who
    principal_id: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    principal_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Azure does not return a display name on the assignment (that needs Graph,
    # a separate permission), so this is frequently None. Left null rather than
    # filled with the object id pretending to be a name.
    principal_name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # What
    role_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    role_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    role_type: Mapped[str | None] = mapped_column(String(64), nullable=True)  # BuiltInRole/CustomRole

    # Where
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    scope_level: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)

    # The role's actual permission surface — actions / notActions / dataActions.
    # This is what makes escalation analysis evidence-based rather than a
    # hard-coded list of role GUIDs that goes stale.
    permissions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

    __table_args__ = (
        UniqueConstraint("account_id", "grant_key", name="uq_identity_grant_account_key"),
        Index("ix_identity_grants_account_role", "account_id", "role_name"),
        Index("ix_identity_grants_account_scope", "account_id", "scope_level"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "grant_key": self.grant_key,
            "principal_id": self.principal_id,
            "principal_type": self.principal_type,
            "principal_name": self.principal_name,
            "role_key": self.role_key,
            "role_name": self.role_name,
            "role_type": self.role_type,
            "scope": self.scope,
            "scope_level": self.scope_level,
            "scope_label": SCOPE_LABEL.get(self.scope_level or "", self.scope_level),
            "permissions": self.permissions,
            "first_seen_at": self.first_seen_at.isoformat() if self.first_seen_at else None,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
        }


class CloudIdentityCollectionState(Base):
    """Whether identity data for an account is trustworthy, and if not, why.

    One row per account. Without it, "no findings" is ambiguous — and the
    ambiguous reading is the dangerous one.
    """

    __tablename__ = "cloud_identity_collection_state"

    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default=COLLECT_NEVER_RUN)

    # The provider's own error text, verbatim. Paraphrasing it loses the part an
    # operator needs — which action, at which scope, for which client id.
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The specific permission to grant, parsed out of the error when the
    # provider names it. This is the actionable half.
    missing_permission: Mapped[str | None] = mapped_column(String(256), nullable=True)

    grant_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)

    @property
    def trustworthy(self) -> bool:
        return self.status in COLLECTION_TRUSTWORTHY

    def to_dict(self) -> dict:
        return {
            "account_id": str(self.account_id),
            "provider": self.provider,
            "status": self.status,
            "trustworthy": self.trustworthy,
            "error_detail": self.error_detail,
            "missing_permission": self.missing_permission,
            "grant_count": self.grant_count,
            "last_attempt_at": self.last_attempt_at.isoformat() if self.last_attempt_at else None,
            "last_success_at": self.last_success_at.isoformat() if self.last_success_at else None,
        }
