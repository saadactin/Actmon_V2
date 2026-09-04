"""SQLAlchemy ORM model for cloud_resource_changes.

The inventory table only ever holds the *current* state of a resource: each
discovery scan overwrites it, so the previous value is gone the moment a new
sweep lands. That makes the most common real question unanswerable - "this
bucket is public / this database got bigger, when did that happen and what was
it before?" This table is the missing half: an append-only record of every
tracked field that moved between two scans.

One row per changed field, not per resource, so a single scan that changes a
VM's size and its NSG produces two independently filterable entries. Rows
sharing (job_id, provider_resource_id) are one scan's worth of change to one
resource, which is how the UI groups them back into an event.

`impact` is the cross-pillar link: it names which of security / cost /
topology / availability / governance the changed field belongs to, derived from
the field itself in app/utils/drift_rules.py. That is what lets the Cost or
Security view of a resource be joined to "what changed just before it".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Same reasoning as app/models/alert.py: importing the parent makes this model
# self-sufficient rather than dependent on import order, and cloud_account does
# not import this module, so there is no cycle.
from app.models.cloud_account import CloudAccount  # noqa: F401


class CloudResourceChange(Base):
    __tablename__ = "cloud_resource_changes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Which scan detected it. Groups a resource's field changes into one event,
    # and makes a bad scan's output identifiable after the fact.
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )

    # Nullable, and NOT a foreign key on purpose: a DELETED row has to outlive
    # the cloud_resources row it describes, otherwise the deletion record would
    # be pruned by the same sweep that detected the deletion.
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # The stable provider-side identity, which survives the row being deleted
    # and re-created, so a resource's history stays joined across its lifetime.
    provider_resource_id: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    resource_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    region_or_zone: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # CREATED | MODIFIED | DELETED
    change_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # Dotted path of what moved: "status", "config.shape", "tags.env".
    # Null for CREATED / DELETED, which are about the resource, not a field.
    field_path: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    # Rendered, truncated forms - readable in the UI without re-parsing JSON,
    # and bounded so a 4,000-rule security list cannot bloat the table.
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Which pillars this change touches, e.g. ["security", "topology"].
    impact: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # MORE_OPEN | MORE_RESTRICTIVE | SCALE_UP | SCALE_DOWN, only when the
    # transition is unambiguous. Null is the honest answer the rest of the time.
    direction: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)

    # The new value is empty — the field went away rather than changed to
    # something else. Flagged at write time because it is the one diff an
    # incomplete sweep can manufacture: a scope that failed to enumerate
    # produces MISSING data, never wrong data. So when a sweep turns out to have
    # been incomplete, these rows are dropped and the rest are kept, instead of
    # throwing away a whole sweep's real findings. Without this, the main OCI
    # account (which routinely reports a handful of unreachable scopes out of
    # several hundred) would almost never show any drift at all.
    value_vanished: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True
    )

    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    __table_args__ = (
        # The feed is always "newest first, for this account".
        Index("ix_cloud_changes_account_detected", "account_id", "detected_at"),
        # One resource's history over time - the resource-detail timeline.
        Index("ix_cloud_changes_resource_detected", "provider_resource_id", "detected_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id) if self.account_id else None,
            "job_id": str(self.job_id) if self.job_id else None,
            "resource_id": str(self.resource_id) if self.resource_id else None,
            "provider_resource_id": self.provider_resource_id,
            "resource_type": self.resource_type,
            "resource_name": self.resource_name,
            "region_or_zone": self.region_or_zone,
            "change_type": self.change_type,
            "field_path": self.field_path,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "impact": self.impact or [],
            "severity": self.severity,
            "direction": self.direction,
            "value_vanished": self.value_vanished,
            "summary": self.summary,
            "detected_at": self.detected_at.isoformat() if self.detected_at else None,
        }
