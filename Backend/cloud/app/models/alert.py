"""SQLAlchemy ORM model for cloud_alerts.

Alerts used to live in a plain Python list on a module-level service instance,
so every restart silently erased the entire alert history — and a monitoring
tool that forgets what it told you is not one anyone can act on. This table
gives them a lifecycle (open → acknowledged → resolved) and a durable record.

`dedupe_key` is what keeps a recurring condition from producing a new row on
every discovery cycle: the same key re-opens or updates the existing alert
instead of appending a duplicate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# The account_id foreign key can only resolve if cloud_accounts is registered in
# the same metadata. Importing it here makes this model self-sufficient instead
# of silently depending on import order — without it, any entry point that
# reaches alerts without going through main.py fails on first flush with
# NoReferencedTableError. cloud_account does not import this module, so there is
# no cycle.
from app.models.cloud_account import CloudAccount  # noqa: F401

# Lifecycle states. OPEN is the only state that should page anyone.
STATE_OPEN = "OPEN"
STATE_ACKNOWLEDGED = "ACKNOWLEDGED"
STATE_RESOLVED = "RESOLVED"


class CloudAlert(Base):
    __tablename__ = "cloud_alerts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Nullable so a tenancy-wide alert that isn't tied to one account can exist;
    # SET NULL rather than CASCADE so deleting an account keeps its alert history.
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    anomaly_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    details: Mapped[str] = mapped_column(Text, nullable=False)

    # Stable identity for a recurring condition, e.g.
    # "STOPPED_INSTANCE_ATTACHED_STORAGE:<provider_resource_id>". Unique so the
    # database itself refuses duplicates even if two scans race.
    dedupe_key: Mapped[str | None] = mapped_column(String(600), nullable=True, unique=True)

    state: Mapped[str] = mapped_column(
        String(20), nullable=False, default=STATE_OPEN, index=True
    )
    # Kept for the existing UI, which reads is_read. Acknowledging sets both.
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Test alerts from the DEBUG-only simulate hook, so they can never be
    # mistaken for a real finding.
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # What the alert is about, when it points at a specific resource.
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    resource_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Anything rule-specific worth keeping without a schema change.
    context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    # Bumped each time the condition is seen again, so "first seen" and "still
    # happening" are distinguishable — a one-off blip reads differently from a
    # fault that has persisted for a week.
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    occurrence_count: Mapped[int] = mapped_column(default=1)
    acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # The alert feed is always "newest open first", per account.
        Index("ix_cloud_alerts_state_created", "state", "created_at"),
        Index("ix_cloud_alerts_account_state", "account_id", "state"),
    )

    def to_dict(self) -> dict:
        """Response shape. Keeps the keys the existing AlertsPage already reads
        (id / anomaly_type / details / severity / created_at / is_read /
        simulated / account_id) so the UI needs no change, and adds the
        lifecycle fields alongside them."""
        return {
            "id": str(self.id),
            "account_id": str(self.account_id) if self.account_id else None,
            "anomaly_type": self.anomaly_type,
            "severity": self.severity,
            "details": self.details,
            "is_read": self.is_read,
            "simulated": self.simulated,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            # New lifecycle detail
            "state": self.state,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "occurrence_count": self.occurrence_count,
            "acknowledged_at": self.acknowledged_at.isoformat() if self.acknowledged_at else None,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
            "resource_id": str(self.resource_id) if self.resource_id else None,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "context": self.context,
        }
