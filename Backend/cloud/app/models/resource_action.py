"""Append-only record of every resource action this platform attempted.

WRITTEN BEFORE THE ACTION, NOT AFTER
------------------------------------
A row is inserted when an action is accepted and updated when it finishes. The
order matters: if the process dies mid-call, the row survives as RUNNING with a
request and no result, which is an accurate account of what happened. Writing
the audit row only on success would leave the one case anybody investigates —
the action that did not complete — with no trace at all.

WHAT IS DELIBERATELY NOT STORED
-------------------------------
Credentials, tokens, key material, and anything the provider echoes back that
matches the masking rule. The request and result are provider payloads, and
those payloads contain secrets often enough that storing them verbatim is how a
secret ends up in a database nobody thinks of as sensitive.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Lifecycle. PARTIAL exists for bulk operations, where "it worked" and "it
# failed" are both wrong answers.
QUEUED = "QUEUED"
RUNNING = "RUNNING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"
PARTIAL = "PARTIAL"
CANCELLED = "CANCELLED"
REFUSED = "REFUSED"          # never reached the provider: unsupported/denied/unsafe

TERMINAL = (SUCCEEDED, FAILED, PARTIAL, CANCELLED, REFUSED)


class CloudResourceAction(Base):
    __tablename__ = "cloud_resource_actions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # The caller's idempotency key. Two requests carrying the same one are the
    # same intent, not two — which is what stops a double-clicked Stop button
    # issuing a second provider call.
    operation_id: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)

    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # Not an FK: the audit trail has to outlive the resource. A delete that
    # succeeds removes the row it refers to, and cascading that deletion would
    # erase the evidence of the very action most worth keeping.
    resource_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True)
    provider_resource_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    resource_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=QUEUED)
    dry_run: Mapped[bool] = mapped_column(nullable=False, default=False)

    actor: Mapped[str | None] = mapped_column(String(256), nullable=True)
    actor_role: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Masked before they get here. See app/services/resource_action_service.py.
    request: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Why an action never ran. Kept separate from `error`, which means the
    # provider was reached and failed: "you may not do this" and "the provider
    # said no" are different facts about a system.
    refusal_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # What the resource looked like on either side. Populated only from data
    # this platform already holds — never by inventing a "before" from the
    # values the request happened to carry.
    before_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Groups the rows written by one bulk operation.
    correlation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_cloud_resource_actions_account_started", "account_id", "started_at"),
        Index("ix_cloud_resource_actions_resource_started", "resource_id", "started_at"),
    )
