"""Access requests, JIT sessions, permission proposals — and their audit trail.

Everything in this module exists to make a privilege change *reversible and
attributable*. §31 states the requirement bluntly — "do not allow invisible
privilege changes from the application" — and the schema is where that is
enforced rather than hoped for:

**The audit row is written before the provider is called, never after.** The
same rule `resource_action.py` already follows, for the same reason: if the
process dies mid-apply, a row that says ACTIVE with a request and no result is
an accurate account of what happened, whereas writing only on success leaves
the one case anybody ever investigates with no trace at all.

**Approval is a row, not a boolean.** `approved_by` on the request would record
that someone approved it; it would not record who, when, on what evidence, or
whether they had seen the blast radius at the time. A separate
`CloudAccessApproval` row per decision keeps the sequence — including a
rejection followed by a re-request, which a boolean silently overwrites.

**An expiry is a fact about the provider, not a timer in our process.** A JIT
session carries `expires_at` AND the provider-side state, because a session
this platform believes has expired while the role assignment is still live in
Azure is the worst possible outcome: standing admin access that nothing is
watching. `revoke_attempted_at` / `revoke_confirmed_at` are separate columns so
"we tried" and "it is gone" can never be conflated.

**A proposal stores both sides of the diff.** `current_document` and
`proposed_document` are captured at proposal time, and the applier re-reads the
live policy and refuses if it has drifted — otherwise an approval granted
against one policy could be applied to a different one.
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
from app.models.cloud_account import CloudAccount  # noqa: F401
from app.models.identity import CloudIdentity      # noqa: F401


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


class CloudAccessRequest(Base):
    """A request for elevated access, or to right-size an identity's permissions.

    One table for both because the lifecycle is identical — proposed, reviewed,
    approved, applied, verified, reversed — and because an approver wants one
    queue, not two. `request_kind` tells them apart.
    """

    __tablename__ = "cloud_access_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # JIT_ELEVATION / PERMISSION_RIGHTSIZE / CREDENTIAL_ROTATION / CREDENTIAL_DISABLE
    request_kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False,
                                        default="APPROVAL_REQUIRED", index=True)

    # Who the access is for. Nullable because a right-sizing request may target
    # an identity that this platform knows only by provider id.
    identity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    identity_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    identity_name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # What is being asked for.
    target_scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_resource: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_role: Mapped[str | None] = mapped_column(String(512), nullable=True)
    requested_actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Why. A written reason is mandatory for every request kind — the same
    # rule the Security Center applies to suppressing a finding, and for the
    # same reason: it has to be defensible six months later.
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    ticket_ref: Mapped[str | None] = mapped_column(String(256), nullable=True)

    requested_by: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    requested_by_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now,
                                                   index=True)
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # The risk picture AS IT WAS when the approver looked at it. Snapshotted
    # rather than recomputed on render, so the record shows what the decision
    # was actually made on — a blast radius that has since changed does not
    # retroactively alter what the approver saw.
    risk_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    current_privilege: Mapped[str | None] = mapped_column(String(20), nullable=True)
    requested_privilege: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Proposal payload for a right-sizing request — the diff, both documents.
    current_document: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    proposed_document: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    diff: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # The evidence the proposal rests on: window, events analysed, which
    # actions were observed. §29 — a recommendation without its evidence is an
    # assertion.
    evidence: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                        nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                        nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Why a request never reached the provider, kept apart from `error` for the
    # reason resource_action.py keeps them apart.
    refusal_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    __table_args__ = (
        Index("ix_access_request_account_status", "account_id", "status"),
        Index("ix_access_request_identity", "identity_id", "status"),
    )

    def to_dict(self, *, include_documents: bool = False) -> dict:
        out = {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "request_kind": self.request_kind,
            "status": self.status,
            "identity_id": str(self.identity_id) if self.identity_id else None,
            "identity_key": self.identity_key,
            "identity_name": self.identity_name,
            "target_scope": self.target_scope,
            "target_resource": self.target_resource,
            "requested_role": self.requested_role,
            "requested_actions": self.requested_actions,
            "duration_minutes": self.duration_minutes,
            "reason": self.reason,
            "ticket_ref": self.ticket_ref,
            "requested_by": self.requested_by,
            "requested_by_role": self.requested_by_role,
            "requested_at": _iso(self.requested_at),
            "risk_snapshot": self.risk_snapshot,
            "current_privilege": self.current_privilege,
            "requested_privilege": self.requested_privilege,
            "diff": self.diff,
            "evidence": self.evidence,
            "decided_at": _iso(self.decided_at),
            "applied_at": _iso(self.applied_at),
            "error": self.error,
            "refusal_reason": self.refusal_reason,
            "result": self.result,
        }
        if include_documents:
            out["current_document"] = self.current_document
            out["proposed_document"] = self.proposed_document
        return out


class CloudAccessApproval(Base):
    """One approval decision on one request. Append-only.

    Several rows per request are normal and meaningful: a rejection, a
    re-submission, a second approver. Collapsing this into columns on the
    request would lose the sequence, which is the part an auditor reads.
    """

    __tablename__ = "cloud_access_approvals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_access_requests.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # APPROVED / REJECTED
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    decided_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    decided_by_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    # What the approver was shown. Proof the decision was informed.
    risk_shown: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "request_id": str(self.request_id),
            "decision": self.decision,
            "decided_by": self.decided_by,
            "decided_by_role": self.decided_by_role,
            "decided_at": _iso(self.decided_at),
            "comment": self.comment,
            "risk_shown": self.risk_shown,
        }


class CloudJitSession(Base):
    """A time-boxed elevation that is live on the provider right now.

    The columns that matter most are the ones about taking it away again.
    `expires_at` is when it SHOULD end; `revoke_confirmed_at` is when the
    provider confirmed it had. A session where the first has passed and the
    second is null is the dangerous state — standing privilege nobody is
    tracking — and it is queryable precisely because the two are separate.
    """

    __tablename__ = "cloud_jit_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_access_requests.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    identity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ACTIVE",
                                        index=True)
    granted_role: Mapped[str | None] = mapped_column(String(512), nullable=True)
    granted_scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The provider's id for the thing we created, so revocation targets exactly
    # what was granted rather than guessing from role + scope.
    provider_grant_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    activated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                 index=True)
    revoke_attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                 nullable=True)
    revoke_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                 nullable=True)
    revoke_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    revoke_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    activated_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Events observed from this principal during the session — §15's "Used"
    # step on the timeline, and the answer to "was the access actually needed?"
    observed_event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    observed_actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    __table_args__ = (
        Index("ix_jit_session_live", "status", "expires_at"),
        Index("ix_jit_session_account", "account_id", "status"),
    )

    @property
    def overdue(self) -> bool:
        """Expired by the clock but not confirmed revoked on the provider."""
        return (
            self.revoke_confirmed_at is None
            and self.expires_at is not None
            and self.expires_at < datetime.now(timezone.utc)
        )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "request_id": str(self.request_id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "identity_id": str(self.identity_id) if self.identity_id else None,
            "status": self.status,
            "granted_role": self.granted_role,
            "granted_scope": self.granted_scope,
            "provider_grant_id": self.provider_grant_id,
            "activated_at": _iso(self.activated_at),
            "expires_at": _iso(self.expires_at),
            "revoke_attempted_at": _iso(self.revoke_attempted_at),
            "revoke_confirmed_at": _iso(self.revoke_confirmed_at),
            "revoke_error": self.revoke_error,
            "revoke_attempts": self.revoke_attempts,
            "activated_by": self.activated_by,
            "observed_event_count": self.observed_event_count,
            "observed_actions": self.observed_actions,
            "overdue": self.overdue,
        }


class CloudIdentityAuditLog(Base):
    """Append-only record of every CIEM operation that changed, or tried to
    change, anything — §31's list, one row per attempt.

    Separate from `cloud_resource_actions` because the subject is a principal
    rather than a resource, and separate from the Event Log because this
    records what THIS PLATFORM did, not what the provider reported. The two are
    correlated by timestamp and actor in the identity detail page.
    """

    __tablename__ = "cloud_identity_audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    provider: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # REQUEST_CREATED / APPROVED / REJECTED / APPLIED / FAILED / REVOKED /
    # EXPIRED / ROLLED_BACK / PROPOSAL_GENERATED / CREDENTIAL_DISABLED …
    operation: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True,
                                                         index=True)
    # Not an FK: the audit trail has to outlive the identity it refers to. A
    # successful "delete this dormant user" removes the row it points at, and
    # cascading that deletion would erase the evidence of the very action most
    # worth keeping.
    identity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True,
                                                          index=True)
    identity_name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    actor: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    actor_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Masked before they get here, exactly as resource_action_service does it.
    before: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    succeeded: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)

    __table_args__ = (
        Index("ix_identity_audit_account_at", "account_id", "at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id) if self.account_id else None,
            "provider": self.provider,
            "operation": self.operation,
            "request_id": str(self.request_id) if self.request_id else None,
            "identity_id": str(self.identity_id) if self.identity_id else None,
            "identity_name": self.identity_name,
            "actor": self.actor,
            "actor_role": self.actor_role,
            "source_ip": self.source_ip,
            "before": self.before,
            "after": self.after,
            "detail": self.detail,
            "reason": self.reason,
            "succeeded": self.succeeded,
            "error": self.error,
            "at": _iso(self.at),
        }
