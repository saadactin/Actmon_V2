"""Account refresh: what ran, what it achieved, and when it runs next.

**The architectural decision this feature turns on.**

`workers/discovery_worker.run_discovery_scan` is already a near-complete
account refresh. One invocation does: provider authentication, resource
enumeration, inventory upsert, configuration-drift capture, the
stopped-storage alert check, cost ingestion over 30 days, topology cache
invalidation, identity collection and a full security assessment.

So this module does NOT re-run any of that. A second orchestrator calling
discovery, then security, then cost would double every provider API call for
no new information — and on a rate-limited Azure subscription that is the
difference between a refresh and a throttling incident.

What was genuinely missing is twofold, and that is all this adds:

1.  **Event collection.** It runs on its own background loop and is never
    triggered by a scan, so a refreshed account still had a stale Event Log.
2.  **A per-component record.** The worker deliberately swallows security and
    cost failures so they cannot turn a good inventory sweep into a failed one
    — correct behaviour, but it meant a refresh that silently lost its cost
    data reported as a clean success. Nothing recorded WHICH parts worked.

`CloudAccountRefresh` is that record. The worker stamps each component onto it
as it goes, which is why a refresh can honestly report PARTIAL.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Index, Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target)

_NULLABLE_JSONB = JSONB(none_as_null=True)


# ── Overall refresh state ─────────────────────────────────────────────────────
# Seven states, not a boolean. A refresh genuinely can half-work: the inventory
# sweep succeeds and Cost Explorer throttles. Collapsing that into true/false
# forces a choice between calling it a success (and letting stale cost data
# look fresh) or a failure (and hiding a perfectly good inventory refresh).
REFRESH_QUEUED = "QUEUED"
REFRESH_RUNNING = "RUNNING"
REFRESH_SUCCEEDED = "SUCCEEDED"
REFRESH_PARTIAL = "PARTIAL"
REFRESH_FAILED = "FAILED"
REFRESH_CANCELLED = "CANCELLED"
REFRESH_STATES = (
    REFRESH_QUEUED, REFRESH_RUNNING, REFRESH_SUCCEEDED, REFRESH_PARTIAL,
    REFRESH_FAILED, REFRESH_CANCELLED,
)
# The states in which a refresh is still holding the account's lock.
REFRESH_ACTIVE = (REFRESH_QUEUED, REFRESH_RUNNING)
REFRESH_TERMINAL = (REFRESH_SUCCEEDED, REFRESH_PARTIAL, REFRESH_FAILED,
                    REFRESH_CANCELLED)

# ── Per-component state ───────────────────────────────────────────────────────
# SKIPPED is distinct from FAILED on purpose: a provider that has no cost
# integration did not fail to refresh cost, it was never asked to. Reporting
# those the same way would make a working account look broken.
COMPONENT_PENDING = "PENDING"
COMPONENT_RUNNING = "RUNNING"
COMPONENT_SUCCEEDED = "SUCCEEDED"
COMPONENT_FAILED = "FAILED"
COMPONENT_SKIPPED = "SKIPPED"
COMPONENT_STATES = (
    COMPONENT_PENDING, COMPONENT_RUNNING, COMPONENT_SUCCEEDED,
    COMPONENT_FAILED, COMPONENT_SKIPPED,
)

# The components a refresh reports on, in the order they actually execute
# inside the discovery worker. The UI renders this order, so it matches what
# is really happening rather than an arbitrary list.
COMPONENTS = ("connection", "resources", "drift", "cost", "security", "events")
COMPONENT_LABELS = {
    "connection": "Account connection",
    "resources": "Resource discovery",
    "drift": "Configuration drift",
    "cost": "Cost data",
    "security": "Security assessment",
    "events": "Event collection",
}

TRIGGER_MANUAL = "manual"
TRIGGER_SCHEDULED = "scheduled"
TRIGGER_TEST = "test"


class CloudAccountRefresh(Base):
    """One refresh execution, manual or scheduled.

    Append-only in practice: rows are created and then updated in place as the
    run progresses, and nothing deletes them except retention. The history is
    what makes "when did cost last actually work" answerable.
    """

    __tablename__ = "cloud_account_refreshes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    trigger_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default=TRIGGER_MANUAL, index=True)
    triggered_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=REFRESH_QUEUED, index=True)

    # The discovery job this refresh drove. The inventory, drift and cost work
    # all happen inside it, so its id is how a refresh row is traced back to
    # what actually ran.
    discovery_job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True)

    # {component: {status, detail, started_at, completed_at}}. JSONB rather
    # than six column pairs because the component list is expected to grow and
    # a migration per component is not worth it.
    components: Mapped[Optional[dict]] = mapped_column(
        _NULLABLE_JSONB, nullable=True, default=dict)

    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Set only when the refresh as a whole could not proceed — a credential
    # rejection, an unknown provider. A component failure lives on the
    # component, not here, so "the account is unreachable" and "cost was
    # throttled" never read the same.
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    resources_found: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc), index=True)

    __table_args__ = (
        Index("ix_account_refresh_account_created", "account_id", "created_at"),
        # The lock query: is anything active for this account right now.
        Index("ix_account_refresh_account_status", "account_id", "status"),
    )

    @property
    def is_active(self) -> bool:
        return self.status in REFRESH_ACTIVE

    def component(self, name: str) -> Dict[str, Any]:
        return (self.components or {}).get(name) or {"status": COMPONENT_PENDING}

    def to_dict(self) -> Dict[str, Any]:
        comps = self.components or {}
        return {
            "refresh_id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "trigger_type": self.trigger_type,
            "triggered_by": self.triggered_by,
            "status": self.status,
            "discovery_job_id": (str(self.discovery_job_id)
                                 if self.discovery_job_id else None),
            "components": {
                name: {
                    "label": COMPONENT_LABELS.get(name, name),
                    **(comps.get(name) or {"status": COMPONENT_PENDING}),
                }
                for name in COMPONENTS
            },
            "started_at": _iso(self.started_at),
            "completed_at": _iso(self.completed_at),
            "duration_ms": self.duration_ms,
            "error": self.error,
            "error_code": self.error_code,
            "resources_found": self.resources_found,
            "created_at": _iso(self.created_at),
        }


class CloudAccountRefreshSchedule(Base):
    """When an account refreshes itself, in the operator's own timezone.

    One row per account — `account_id` is UNIQUE. Scheduling is deliberately
    per account rather than global: a production estate wants a nightly sweep
    and a sandbox does not, and a single global interval forces the busiest
    account's cadence onto every other one.

    `next_run_at` is stored in UTC and computed from `time_of_day` in
    `timezone`. Storing "02:00" without a zone is the bug this column pair
    exists to prevent — the scheduler would run at 02:00 UTC, which is 07:30
    for an operator in Asia/Kolkata who asked for a quiet-hours refresh.
    """

    __tablename__ = "cloud_account_refresh_schedules"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, unique=True, index=True,
    )

    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, index=True)

    # "interval" → every `interval_hours`. "daily" → at `time_of_day`.
    # "weekly" → on `day_of_week` at `time_of_day`.
    frequency_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="daily")
    interval_hours: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # 0 = Monday, matching Python's weekday().
    day_of_week: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # "HH:MM" local to `timezone`.
    time_of_day: Mapped[str] = mapped_column(
        String(5), nullable=False, default="02:00")
    timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, default="Asia/Kolkata")

    next_run_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    # The last run that actually SUCCEEDED (or partially did). Separate from
    # last_run_at because a failed attempt must never overwrite the timestamp
    # people read as "when was this account last actually refreshed".
    last_success_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)

    updated_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "account_id": str(self.account_id),
            "enabled": self.enabled,
            "frequency_type": self.frequency_type,
            "interval_hours": self.interval_hours,
            "day_of_week": self.day_of_week,
            "time_of_day": self.time_of_day,
            "timezone": self.timezone,
            "next_run_at": _iso(self.next_run_at),
            "last_run_at": _iso(self.last_run_at),
            "last_success_at": _iso(self.last_success_at),
            "updated_by": self.updated_by,
            "updated_at": _iso(self.updated_at),
        }


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None
