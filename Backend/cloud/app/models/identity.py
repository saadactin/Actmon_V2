"""The identity inventory: principals, their credentials, and what is attached.

`identity_grant.py` already argued why a role assignment is not a resource.
The same argument applies with more force to a principal — no region, no cost,
no power state, nothing to stop or resize — so principals get their own tables
rather than 10,000 more rows in `cloud_resources`.

What is NOT here, deliberately:

*   **Effective permissions**, which are derived and expensive and live in
    `identity_analysis.py` so they can be recomputed without touching the
    inventory.
*   **Secret material.** Not the secret half of an access key, not a client
    secret, not a private key, not a password hash. §36 is absolute about this
    and the schema is the enforcement point: there is no column to put it in.
    Credentials are identified by the provider's own id and, where one is
    available, a fingerprint.

Three modelling decisions worth stating:

**`provider_detail` is mandatory, not a dumping ground.** §1 asks that
normalization never discard provider specifics, so every row carries the
provider's own view beside the normalized columns. An Azure service principal's
`servicePrincipalType`, an AWS role's `MaxSessionDuration`, an OCI user's
`capabilities` block — all of it stays reachable from the detail page, because
the normalized columns cannot anticipate the question an investigator will ask.

**Absence is recorded, never inferred.** `last_used_at` nullable and
`last_used_source` beside it: a null means the provider did not tell us, which
is a different fact from "never used" (`DORMANCY_NEVER_USED`, which only the
provider may assert). Writing 1970 or "never" into a null would be the §35
failure the whole brief is built around avoiding.

**Groups are identities too.** An AWS IAM group and an Entra group get rows,
because "who can access this bucket?" has to be answerable through group
membership, and because a group holding AdministratorAccess is a finding in its
own right even when it currently has no members.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target must be registered)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class CloudIdentity(Base):
    """One principal: a user, role, group, service principal or managed identity."""

    __tablename__ = "cloud_identities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # Stable identity across scans — app.identity.model.identity_key().
    identity_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # The provider's own id: ARN, Entra object id, OCID. The durable pointer.
    provider_id: Mapped[str] = mapped_column(Text, nullable=False)

    identity_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    actor_class: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # Display name. Nullable on purpose: an Azure role assignment names a
    # principal by object id only, and Graph (a separate permission) is what
    # resolves it. Null means "not resolved", never the id pretending to be one.
    name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    # The sign-in / principal string where one exists: UPN, user name, email.
    principal_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    path: Mapped[str | None] = mapped_column(String(512), nullable=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="UNKNOWN",
                                        index=True)
    created_at_provider: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                 nullable=True)

    # Activity. Null means the provider did not report it — see the module
    # docstring. `last_used_source` says which signal produced the value, so a
    # date derived from our own event log is never confused with one the
    # provider asserted.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                          nullable=True, index=True)
    last_used_source: Mapped[str | None] = mapped_column(String(60), nullable=True)
    last_used_service: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_used_region: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # MFA: one of the four states, including NOT_APPLICABLE for workloads.
    mfa_state: Mapped[str] = mapped_column(String(20), nullable=False, default="UNKNOWN",
                                           index=True)
    mfa_detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Is this principal from outside the account/tenant we are looking at?
    external: Mapped[str] = mapped_column(String(20), nullable=False, default="INTERNAL",
                                          index=True)
    external_detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Set by the analyser from evaluated capability, never from a name.
    privilege_level: Mapped[str] = mapped_column(String(20), nullable=False,
                                                 default="UNKNOWN", index=True)
    # A principal whose permissions reach the whole account/tenancy/subscription.
    standing_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                                 index=True)
    # §11: we can detect the SHAPE of a break-glass account but never its
    # designation, so this is "potential" and the column name says so.
    potential_break_glass: Mapped[bool] = mapped_column(Boolean, nullable=False,
                                                        default=False)
    break_glass_signals: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Counts kept on the row because the identity table is read far more often
    # than it is written, and a COUNT(*) per row per page would dominate the
    # list query at 10,000 identities (§34).
    credential_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active_credential_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    policy_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    group_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Everything the provider said that the normalized columns do not carry.
    provider_detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Where this principal lives, for multi-scope providers.
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    compartment_id: Mapped[str | None] = mapped_column(String(256), nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now,
                                                   index=True)

    __table_args__ = (
        UniqueConstraint("account_id", "identity_key", name="uq_identity_account_key"),
        Index("ix_identities_account_type", "account_id", "identity_type"),
        Index("ix_identities_account_priv", "account_id", "privilege_level"),
        Index("ix_identities_account_actor", "account_id", "actor_class"),
        Index("ix_identities_account_lastused", "account_id", "last_used_at"),
    )

    def to_dict(self, *, include_detail: bool = False) -> dict:
        out = {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "identity_key": self.identity_key,
            "provider_id": self.provider_id,
            "identity_type": self.identity_type,
            "actor_class": self.actor_class,
            "name": self.name,
            "principal_name": self.principal_name,
            "description": self.description,
            "path": self.path,
            "status": self.status,
            "created_at_provider": _iso(self.created_at_provider),
            "last_used_at": _iso(self.last_used_at),
            "last_used_source": self.last_used_source,
            "last_used_service": self.last_used_service,
            "last_used_region": self.last_used_region,
            "mfa_state": self.mfa_state,
            "external": self.external,
            "privilege_level": self.privilege_level,
            "standing_admin": self.standing_admin,
            "potential_break_glass": self.potential_break_glass,
            "break_glass_signals": self.break_glass_signals,
            "credential_count": self.credential_count,
            "active_credential_count": self.active_credential_count,
            "policy_count": self.policy_count,
            "group_count": self.group_count,
            "scope": self.scope,
            "compartment_id": self.compartment_id,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
        }
        if include_detail:
            out["provider_detail"] = self.provider_detail
            out["mfa_detail"] = self.mfa_detail
            out["external_detail"] = self.external_detail
        return out


class CloudIdentityCredential(Base):
    """An access key, API key, client secret or console password.

    NO SECRET MATERIAL. The provider's id, the dates, the state — that is all,
    and the table has nowhere to put anything else.
    """

    __tablename__ = "cloud_identity_credentials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # The provider's identifier for the credential. For an AWS access key this
    # is AKIA… — the PUBLIC half, which is designed to be shown and appears in
    # CloudTrail. The secret half is never retrievable after creation and is
    # not stored here under any circumstances.
    credential_ref: Mapped[str] = mapped_column(String(256), nullable=False)
    credential_kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # A non-reversible fingerprint where the provider gives one (OCI publishes
    # an API key's MD5 fingerprint; a certificate has a thumbprint).
    fingerprint: Mapped[str | None] = mapped_column(String(128), nullable=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="UNKNOWN",
                                        index=True)
    created_at_provider: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                 nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                        nullable=True, index=True)

    # Null means unreported. AWS distinguishes "never used" explicitly, and
    # that is recorded in `never_used` rather than by inventing a date.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                          nullable=True, index=True)
    never_used: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_used_service: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_used_region: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # Set by the analyser: ROTATE / DISABLE / DELETE / INVESTIGATE / NONE.
    # Advisory only. Nothing in this platform acts on it without an approval.
    recommendation: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    recommendation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    provider_detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("account_id", "credential_ref", "credential_kind",
                         name="uq_identity_credential_ref"),
        Index("ix_identity_credentials_identity", "identity_id", "status"),
        Index("ix_identity_credentials_account_kind", "account_id", "credential_kind"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "identity_id": str(self.identity_id),
            "provider": self.provider,
            "credential_ref": self.credential_ref,
            "credential_kind": self.credential_kind,
            "fingerprint": self.fingerprint,
            "status": self.status,
            "created_at_provider": _iso(self.created_at_provider),
            "expires_at": _iso(self.expires_at),
            "last_used_at": _iso(self.last_used_at),
            "never_used": self.never_used,
            "last_used_service": self.last_used_service,
            "last_used_region": self.last_used_region,
            "recommendation": self.recommendation,
            "recommendation_reason": self.recommendation_reason,
            "provider_detail": self.provider_detail,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
        }


class CloudIdentityPolicy(Base):
    """A policy document attached to, or inline on, a principal.

    One row per (principal, policy) pair rather than one per policy: the same
    managed policy attached to 40 roles is 40 rows, which is what makes "which
    principals does this policy reach?" a single indexed query instead of a
    scan of every principal's attachment list.

    `document` is the provider's own policy JSON (AWS), the role definition's
    permission block (Azure) or the parsed statements (OCI). It is evidence and
    is shown verbatim behind `security:view_raw`, because an operator checking
    the engine's conclusion needs the source, not a paraphrase of it.
    """

    __tablename__ = "cloud_identity_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    identity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    policy_key: Mapped[str] = mapped_column(Text, nullable=False)
    policy_name: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    # identity_policy / group_policy / resource_policy / permission_boundary /
    # service_control_policy / rbac_assignment / deny_assignment /
    # oci_policy_statement / trust_policy — the STAGE_* values.
    policy_stage: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # AWS managed vs inline vs customer-managed; Azure BuiltInRole vs CustomRole.
    policy_type: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Where it applies. For Azure this is the assignment scope and decides
    # inheritance; for OCI the compartment; for AWS usually null.
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    scope_level: Mapped[str | None] = mapped_column(String(32), nullable=True)

    document: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Flattened for querying: every action string the document grants or denies.
    # Denormalized on purpose — "which identities can call iam:PassRole?" must
    # not require parsing every document on every request (§34).
    allow_actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    deny_actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Normalized capabilities this document confers, for cross-cloud queries.
    capabilities: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # True when the document could not be parsed. The analyser must then treat
    # this principal's permissions as NOT_DETERMINED rather than as empty.
    parse_failed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("account_id", "identity_id", "policy_key", "policy_stage",
                         name="uq_identity_policy"),
        Index("ix_identity_policies_account_stage", "account_id", "policy_stage"),
        Index("ix_identity_policies_name", "account_id", "policy_name"),
    )

    def to_dict(self, *, include_document: bool = False) -> dict:
        out = {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "identity_id": str(self.identity_id) if self.identity_id else None,
            "provider": self.provider,
            "policy_key": self.policy_key,
            "policy_name": self.policy_name,
            "policy_stage": self.policy_stage,
            "policy_type": self.policy_type,
            "scope": self.scope,
            "scope_level": self.scope_level,
            "allow_actions": self.allow_actions,
            "deny_actions": self.deny_actions,
            "capabilities": self.capabilities,
            "parse_failed": self.parse_failed,
            "parse_error": self.parse_error,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
        }
        if include_document:
            out["document"] = self.document
        return out


class CloudIdentityMembership(Base):
    """`member_identity` belongs to `container_identity`.

    Group membership, role attachment and OCI dynamic-group matching all have
    the same shape — one principal inherits another's permissions — so they
    share a table and are told apart by `membership_kind`. That is what lets
    the effective-permissions engine walk inheritance with one query instead of
    three provider-specific ones.
    """

    __tablename__ = "cloud_identity_memberships"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    member_identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    container_identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # GROUP_MEMBER / ROLE_ATTACHED / DYNAMIC_MATCH / FEDERATED_MAP
    membership_kind: Mapped[str] = mapped_column(String(40), nullable=False)
    # For OCI dynamic groups: the matching rule that put this member in.
    # Evidence, so "why is this instance in this group?" has an answer.
    match_rule: Mapped[str | None] = mapped_column(Text, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("member_identity_id", "container_identity_id", "membership_kind",
                         name="uq_identity_membership"),
        Index("ix_identity_membership_container", "container_identity_id"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "member_identity_id": str(self.member_identity_id),
            "container_identity_id": str(self.container_identity_id),
            "membership_kind": self.membership_kind,
            "match_rule": self.match_rule,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
        }


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None
