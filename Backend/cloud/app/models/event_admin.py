"""The four tables that make the Event Log operable rather than merely present.

`cloud_events` holds the audit trail. These hold everything needed to trust it:

*   **CloudEventSyncState** — one row per collection scope (account × provider ×
    region/compartment) with its checkpoint, health and counters. This is what
    separates the two conditions that look identical in a UI and mean opposite
    things: *nothing happened* and *collection is broken*. Without it an
    AccessDenied on CloudTrail renders as a reassuring empty table.

*   **CloudEventSettings** — retention and collection policy, one row, editable
    by an administrator. Retention has to be data rather than a constant
    because the provider's own window (90 days for AWS/Azure, 365 for OCI) is
    the hard ceiling and the operator's chosen window sits under it.

*   **CloudEventSavedQuery** — named filter sets. Cheap to store, and the
    difference between an investigation tool someone uses twice and one they
    keep.

*   **CloudEventAccessLog** — the audit of the audit system. Reading, exporting
    and reconfiguring an audit trail are themselves privileged acts; if they
    are not recorded, the Event Log becomes the one administrative surface in
    the product that nobody is watching.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401


# ── Collection health ─────────────────────────────────────────────────────────
SYNC_CONNECTED = "Connected"
SYNC_SYNCING = "Syncing"
SYNC_DELAYED = "Delayed"
SYNC_AUTH_FAILED = "AuthenticationFailed"
SYNC_PERMISSION_DENIED = "PermissionDenied"
SYNC_UNAVAILABLE = "Unavailable"
SYNC_DISABLED = "Disabled"
SYNC_NEVER_RUN = "NeverRun"
SYNC_STATES = (
    SYNC_CONNECTED, SYNC_SYNCING, SYNC_DELAYED, SYNC_AUTH_FAILED,
    SYNC_PERMISSION_DENIED, SYNC_UNAVAILABLE, SYNC_DISABLED, SYNC_NEVER_RUN,
)

# States that mean this scope is not currently producing events. Kept as a set
# so the API's "is the feed trustworthy" answer is defined once.
SYNC_UNHEALTHY = (
    SYNC_AUTH_FAILED, SYNC_PERMISSION_DENIED, SYNC_UNAVAILABLE,
)


class CloudEventSyncState(Base):
    """Per-scope checkpoint and health.

    A "scope" is the smallest unit a provider will let us poll independently:
    an AWS region, an Azure subscription, an OCI region+compartment. Scoping
    the checkpoint that finely is what stops one unreadable compartment from
    either stalling the whole account or — much worse — being skipped over
    while its checkpoint advances, which loses its events for good.
    """

    __tablename__ = "cloud_event_sync_state"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # "region:ap-south-1", "subscription", "region:ap-mumbai-1|compartment:ocid1…"
    scope: Mapped[str] = mapped_column(String(512), nullable=False)

    # The high-water mark: every event at or before this instant has been
    # collected for this scope. Only advanced after a scope completes without
    # error — a failed page leaves it untouched, so the next run re-reads that
    # window rather than skipping it. Overlap is harmless (the unique
    # constraint on cloud_events discards the repeats); a gap is permanent.
    checkpoint: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    status: Mapped[str] = mapped_column(
        String(30), nullable=False, default=SYNC_NEVER_RUN, index=True
    )
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    consecutive_failures: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── Observability counters (cumulative) ──────────────────────────────────
    events_received: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    events_stored: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    events_duplicate: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    events_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    api_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    api_errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rate_limit_hits: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Latency of the most recent run, and the worst ever seen for this scope.
    last_latency_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_latency_s: Mapped[float | None] = mapped_column(Float, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("account_id", "provider", "scope", name="uq_event_sync_scope"),
        Index("ix_event_sync_account_provider", "account_id", "provider"),
    )

    def to_dict(self) -> dict:
        from app.models.cloud_event import iso_utc

        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "scope": self.scope,
            "checkpoint": iso_utc(self.checkpoint),
            "status": self.status,
            "last_attempt_at": iso_utc(self.last_attempt_at),
            "last_success_at": iso_utc(self.last_success_at),
            "last_error": self.last_error,
            "consecutive_failures": self.consecutive_failures,
            "events_received": self.events_received,
            "events_stored": self.events_stored,
            "events_duplicate": self.events_duplicate,
            "events_failed": self.events_failed,
            "api_calls": self.api_calls,
            "api_errors": self.api_errors,
            "rate_limit_hits": self.rate_limit_hits,
            "last_latency_s": self.last_latency_s,
            "max_latency_s": self.max_latency_s,
            "updated_at": iso_utc(self.updated_at),
        }


class CloudEventSettings(Base):
    """Collection and retention policy. Exactly one row, id fixed at SINGLETON.

    A fixed primary key rather than "the newest row" so a concurrent write
    cannot leave two competing policies on file, with the reader silently
    picking one.
    """

    __tablename__ = "cloud_event_settings"

    id: Mapped[str] = mapped_column(String(20), primary_key=True, default="SINGLETON")

    # How long THIS application keeps events. Distinct from the provider's own
    # retention, which is a hard ceiling we cannot exceed and do not control:
    # asking AWS for a 200-day-old management event returns nothing, however
    # generous this number is. The API reports both figures side by side so
    # that limit is never implied away.
    retention_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90)

    # Automatic background collection.
    collection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    collection_interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    # How far back a first-ever collection reaches. Bounded because a cold
    # start over a provider's full retention window is tens of thousands of
    # API calls, and the operator should choose to pay that.
    initial_lookback_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=24)
    # Read-only calls are 80-95% of CloudTrail volume and almost never what an
    # investigation is looking for. Off by default so the table stays legible
    # and the API budget goes on management activity.
    collect_read_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    def to_dict(self) -> dict:
        from app.models.cloud_event import iso_utc

        return {
            "retention_days": self.retention_days,
            "collection_enabled": self.collection_enabled,
            "collection_interval_minutes": self.collection_interval_minutes,
            "initial_lookback_hours": self.initial_lookback_hours,
            "collect_read_only": self.collect_read_only,
            "updated_at": iso_utc(self.updated_at),
            "updated_by": self.updated_by,
        }


class CloudEventSavedQuery(Base):
    """A named filter set. `filters` is the same dict the list endpoint accepts,
    so running a saved query is replaying its parameters, not interpreting a
    second query language."""

    __tablename__ = "cloud_event_saved_queries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Whose it is. Nullable because this service currently receives no
    # authenticated identity for most calls (see app/api/rbac.py); a NULL owner
    # means "shared", which is the honest description of a query saved by an
    # unidentified caller rather than a fabricated attribution.
    owner: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    account_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    filters: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        # One name per owner. A second "Critical IAM changes" that quietly
        # shadows the first is a support call waiting to happen.
        UniqueConstraint("owner", "name", name="uq_event_saved_query_name"),
    )

    def to_dict(self) -> dict:
        from app.models.cloud_event import iso_utc

        return {
            "id": str(self.id),
            "name": self.name,
            "description": self.description,
            "owner": self.owner,
            "account_id": str(self.account_id) if self.account_id else None,
            "filters": self.filters or {},
            "created_at": iso_utc(self.created_at),
            "updated_at": iso_utc(self.updated_at),
        }


# ── Audit of the audit system ─────────────────────────────────────────────────
ACCESS_VIEW_EVENT = "VIEW_EVENT"
ACCESS_VIEW_RAW = "VIEW_RAW_EVENT"
ACCESS_EXPORT = "EXPORT"
ACCESS_SETTINGS_CHANGED = "SETTINGS_CHANGED"
ACCESS_RETENTION_PRUNE = "RETENTION_PRUNE"
ACCESS_QUERY_SAVED = "QUERY_SAVED"
ACCESS_QUERY_DELETED = "QUERY_DELETED"
ACCESS_COLLECTION_TRIGGERED = "COLLECTION_TRIGGERED"
ACCESS_DENIED = "ACCESS_DENIED"


class CloudEventAccessLog(Base):
    """Who did what *inside* the Event Log.

    Only privileged or high-signal acts are recorded — opening a raw payload,
    exporting, changing retention, being refused. Logging every table page
    would bury those under pagination noise and make this table larger than
    the trail it protects.
    """

    __tablename__ = "cloud_event_access_log"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    # NULL when the request carried no token. Recorded as NULL rather than
    # "admin" or "system": an unattributable action must look unattributable.
    actor: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    role: Mapped[str | None] = mapped_column(String(40), nullable=True)
    action: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # What it was done to: an event id, a saved-query name, "settings".
    target: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # none_as_null: see app/models/cloud_event.py — plain JSONB writes Python
    # None as the JSON literal `null`, which breaks every SQL null check.
    detail: Mapped[dict | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)

    __table_args__ = (Index("ix_event_access_at_action", "at", "action"),)

    def to_dict(self) -> dict:
        from app.models.cloud_event import iso_utc

        return {
            "id": str(self.id),
            "at": iso_utc(self.at),
            "actor": self.actor,
            "role": self.role,
            "action": self.action,
            "target": self.target,
            "detail": self.detail or {},
            "source_ip": self.source_ip,
        }
