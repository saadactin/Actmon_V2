"""SQLAlchemy ORM models for `cloud_cost_facts` — persisted billing history.

The live billing APIs answer "what is spend now". They cannot answer "what was
it in July", which is what forecasting, anomaly baselines, month-over-month and
budget tracking all require. This table is that memory.

Four properties are load-bearing:

1.  **Idempotent by construction.** Re-fetching a window must never duplicate
    it. Deduplication is a uniqueness constraint on `fact_key`, not a scan.

    `fact_key` is a hash rather than a plain composite UNIQUE over the
    dimension columns, and that is deliberate: in SQL, NULL is not equal to
    NULL, so a composite unique index over nullable columns does NOT dedupe
    rows whose dimensions contain NULLs. Most billing rows have at least one
    NULL dimension -- AWS never supplies a resource_id, OCI often omits region
    -- so a naive UNIQUE(account, date, service, region, resource_id, ...)
    would have silently admitted a duplicate on every single re-ingestion and
    doubled the reported spend. Hashing normalizes NULL to a sentinel first,
    so absent-and-absent collides exactly as it should.

2.  **Provisional until proven otherwise.** Providers restate billing data for
    days after the fact. None of the three APIs this product uses exposes a
    finality flag, so nothing here is ever labelled `final` merely because it
    was fetched -- see `finality` below.

3.  **Normalized without lossy translation.** Flat columns are the common
    schema; `dimensions` (JSONB) carries what only one provider has -- an AWS
    usage type and operation, an Azure meter, an OCI SKU and compartment --
    so nothing is dropped just because the other two have no equivalent.

4.  **Absent means absent.** A NULL column is a value the provider did not
    supply. `amount` in particular is never defaulted to 0: a row that exists
    with a NULL amount means "billed, value unknown", which is not free.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import (
    Boolean,
    Date,
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

# Importing the parent makes this model self-sufficient rather than dependent
# on import order; cloud_account does not import this module, so no cycle.
from app.models.cloud_account import CloudAccount  # noqa: F401

_NULLABLE_JSONB = JSONB(none_as_null=True)

# ── Finality ──────────────────────────────────────────────────────────────────
# AWS Cost Explorer, Azure Cost Management and the OCI Usage API all restate
# recent data (late-arriving usage, credits, tax, refunds) and NONE of them
# exposes a "this period is closed" flag on the queries this product issues.
#
# So `final` is a state this code will not assert on its own. What it CAN
# observe honestly is whether a value has stopped moving: every re-ingestion
# bumps `revision_count`, and `last_changed_at` only advances when the amount
# actually differs. A fact that has been re-read several times without changing
# is STABLE -- a useful, earned signal -- but it is still not "final", because
# the provider never said so. The vocabulary keeps that distinction visible
# instead of letting an inference harden into a claim.
PROVISIONAL = "provisional"   # recently fetched, may still be restated
STABLE = "stable"             # re-read without changing; safe for trends
FINAL = "final"               # reserved: only if a provider ever tells us
FINALITY_STATES = (PROVISIONAL, STABLE, FINAL)

# A dimension value that is absent. Hashed in place of NULL so that
# absent-and-absent collide (see the fact_key note above). Chosen to be
# something no provider can legitimately return.
_NULL_SENTINEL = "\x00<none>"


def build_fact_key(
    *,
    account_id: uuid.UUID | str,
    provider: Optional[str],
    billing_date: Optional[date],
    service: Optional[str],
    region: Optional[str],
    resource_id: Optional[str],
    usage_type: Optional[str],
    currency: Optional[str],
) -> str:
    """The deterministic identity of one billing fact.

    Same window re-fetched -> same key -> UPDATE, not a second row. This is the
    whole of the idempotency guarantee, so the inputs are exactly the dimensions
    that make a billing line distinct, and nothing that varies between fetches
    (never `amount`, never `retrieved_at` -- including either would mean a
    restated figure inserted a duplicate instead of correcting the original).

    Values are lower-cased and stripped because providers are inconsistent about
    case across queries: Azure Cost Management returns a ResourceId in different
    case than ARM's resources.list(), and that alone would fork one resource's
    history into two.
    """
    def norm(v: Any) -> str:
        if v is None:
            return _NULL_SENTINEL
        s = str(v).strip()
        return s.lower() if s else _NULL_SENTINEL

    parts = [
        str(account_id),
        norm(provider),
        billing_date.isoformat() if billing_date else _NULL_SENTINEL,
        norm(service),
        norm(region),
        norm(resource_id),
        norm(usage_type),
        norm(currency),
    ]
    # \x1f (unit separator) cannot appear in any provider value, so it is a
    # safe delimiter: without one, ("ab","c") and ("a","bc") would collide.
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


class CloudCostFact(Base):
    """One normalized billing line, for one day, from one provider."""

    __tablename__ = "cloud_cost_facts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    # ── When ─────────────────────────────────────────────────────────────────
    # Date, not datetime: every provider here bills at day granularity, and a
    # timestamp would imply a precision the source does not have.
    billing_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)

    # ── What ─────────────────────────────────────────────────────────────────
    service: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    region: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, index=True)

    # Provider-native identifier: ARN / ARM resource ID / OCID. NULL when the
    # provider bills at service level only (AWS, via Cost Explorer).
    resource_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    # Resolved from our own inventory at ingestion time, when a match exists.
    resource_name: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    resource_type: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    usage_type: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    cost_component: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)

    resource_group: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    compartment: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # ── How much ─────────────────────────────────────────────────────────────
    # Nullable on purpose. NULL = the provider returned a line with no cost
    # value; it is NOT zero, and must never be summed as zero.
    amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    currency: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)

    # ── Provenance ───────────────────────────────────────────────────────────
    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="provider_billing"
    )
    # True when resource_id matched a row in cloud_resources at ingestion.
    # False means billed-but-unattributed, which stays visible rather than
    # being dropped: unallocated spend is still spend.
    in_inventory: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    finality: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PROVISIONAL, index=True
    )
    # Bumped on every re-ingestion; `last_changed_at` only moves when the
    # amount actually differs. Together they are the evidence behind STABLE.
    revision_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    retrieved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    last_changed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Provider-native dimensions that have no common-schema column.
    dimensions: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        _NULLABLE_JSONB, nullable=True
    )

    # The idempotency key. See the module docstring on why this is a hash.
    fact_key: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        UniqueConstraint("fact_key", name="uq_cost_fact_key"),
        # The three shapes every analytic query takes: a window for an account,
        # a service trend, and per-resource attribution.
        Index("ix_cost_fact_account_date", "account_id", "billing_date"),
        Index("ix_cost_fact_account_service_date", "account_id", "service", "billing_date"),
        Index("ix_cost_fact_account_resource", "account_id", "resource_id"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"<CloudCostFact {self.provider} {self.billing_date} "
            f"{self.service!r} {self.amount} {self.currency}>"
        )


# ── Backfill jobs ─────────────────────────────────────────────────────────────

BACKFILL_PENDING = "PENDING"
BACKFILL_RUNNING = "RUNNING"
BACKFILL_SUCCEEDED = "SUCCEEDED"
BACKFILL_PARTIAL = "PARTIAL"     # some windows landed, some failed
BACKFILL_FAILED = "FAILED"
BACKFILL_STATES = (
    BACKFILL_PENDING, BACKFILL_RUNNING, BACKFILL_SUCCEEDED,
    BACKFILL_PARTIAL, BACKFILL_FAILED,
)


class CloudCostBackfillJob(Base):
    """One historical-backfill run, with enough state to report real progress.

    Progress is persisted rather than held in memory because a backfill of 365
    days across three providers outlives any single HTTP request, and a
    progress bar that resets when the page reloads is worse than none.

    `windows_failed` is tracked separately from `windows_done` so a run that
    partially succeeded reports PARTIAL and names what is missing, instead of
    presenting an incomplete history as a complete one.
    """

    __tablename__ = "cloud_cost_backfill_jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    requested_days: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=BACKFILL_PENDING, index=True
    )

    windows_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    windows_done: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    windows_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    records_written: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    records_updated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    finished_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Classified via app.services.cost_errors, so a failed backfill explains
    # itself in the same vocabulary as a failed live query.
    error_category: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    @property
    def progress_percent(self) -> int:
        """Integer 0-100. Returns 0 rather than dividing by zero before the
        window plan is known."""
        if not self.windows_total:
            return 0
        attempted = self.windows_done + self.windows_failed
        return min(100, int(round(attempted * 100 / self.windows_total)))

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "requested_days": self.requested_days,
            "status": self.status,
            "progress_percent": self.progress_percent,
            "windows_total": self.windows_total,
            "windows_done": self.windows_done,
            "windows_failed": self.windows_failed,
            "records_written": self.records_written,
            "records_updated": self.records_updated,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "error": (
                {"category": self.error_category, "message": self.error_message}
                if self.error_category else None
            ),
        }
