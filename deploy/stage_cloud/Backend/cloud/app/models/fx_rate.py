"""SQLAlchemy model for `cloud_fx_rates` — the cache behind FX conversion.

This dashboard reports costs in whatever currency each provider's billing API
natively returns (see `app.services.cost_money`'s design note). Making every
figure readable in one currency (INR) requires converting the non-INR ones,
which requires a real exchange rate. This table is that rate's cache: one row
per (day, source currency), so a given day's rate is fetched from the FX
provider at most once and survives a restart.

A rate is looked up by the calendar day it applies to, never "now" — a cost
record billed in July should convert at July's rate, not today's. See
`app.services.fx_rate_service`.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, Float, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CloudFxRate(Base):
    """One cached exchange rate: 1 unit of `base_currency` in INR, on `rate_date`."""

    __tablename__ = "cloud_fx_rates"
    __table_args__ = (
        UniqueConstraint("rate_date", "base_currency", name="uq_cloud_fx_rate_day_currency"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    rate_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    base_currency: Mapped[str] = mapped_column(String(8), nullable=False)

    # 1 unit of base_currency, expressed in INR.
    rate_to_inr: Mapped[float] = mapped_column(Float, nullable=False)

    # Where the rate came from, e.g. "frankfurter.app". Kept so a bad/odd rate
    # found later can be traced to its source rather than guessed at.
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="frankfurter.app")

    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
