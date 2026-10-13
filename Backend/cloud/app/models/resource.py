"""SQLAlchemy ORM model for cloud_resources table."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CloudResource(Base):
    __tablename__ = "cloud_resources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_resource_id: Mapped[str] = mapped_column(
        String(512), nullable=False, index=True
    )
    resource_type: Mapped[str] = mapped_column(
        String(100), nullable=False, index=True
    )  # e.g. EC2, VirtualMachine, Compute
    resource_name: Mapped[str] = mapped_column(String(512), nullable=False)
    region_or_zone: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(100), nullable=True)
    config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_: Mapped[dict | None] = mapped_column(
        "metadata", JSONB, nullable=True
    )
    cost_monthly: Mapped[float | None] = mapped_column(Float, nullable=True)
    tags: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    discovered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # -- When discovery last SAW this resource --------------------------------
    # Distinct from updated_at, which SQLAlchemy only moves when a field
    # actually changes: a resource nobody touched keeps an old updated_at even
    # though the sweep confirmed it five minutes ago. Reading freshness off
    # updated_at therefore reports stable resources as stale. This estate shows
    # it plainly - the OCI account's last discovery finished at 18:03 while its
    # newest updated_at is 12:12, nearly six hours earlier.
    #
    # Nullable because rows that predate this column were genuinely never
    # recorded as seen, and inventing a timestamp for them would be inventing
    # evidence. They read as "never observed" until the next sweep.
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )

    # -- Normalized projections -----------------------------------------------
    # Written by app/services/resource_normalizer.py from the pure functions in
    # resource_model.py. They exist so the database can filter, sort, facet and
    # paginate on them: the alternative is loading the whole account into
    # Python to normalize it, which is exactly the architecture this work
    # replaces. There is still ONE implementation of the logic; these columns
    # are its output, not a second copy of it.
    normalized_status: Mapped[str | None] = mapped_column(
        String(20), nullable=True, index=True
    )
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    normalized_type: Mapped[str | None] = mapped_column(
        String(32), nullable=True, index=True
    )
    # The provider's product ("aws.lambda", "azure.app-service", "oci.compute"),
    # from services/resource_services.py. Finer than normalized_type.
    service: Mapped[str | None] = mapped_column(String(64), nullable=True)
    environment: Mapped[str | None] = mapped_column(String(128), nullable=True)
    owner: Mapped[str | None] = mapped_column(String(256), nullable=True)
    attachment_state: Mapped[str | None] = mapped_column(String(20), nullable=True)
    resource_group: Mapped[str | None] = mapped_column(String(255), nullable=True)
    compartment: Mapped[str | None] = mapped_column(String(255), nullable=True)
    availability_zone: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_default: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    tag_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        # The list query's own shape: scope by account, then order. Every
        # composite here starts with account_id because no query in the product
        # reads resources without one.
        Index("ix_cloud_resources_account_type", "account_id", "resource_type"),
        Index("ix_cloud_resources_account_region", "account_id", "region_or_zone"),
        Index("ix_cloud_resources_account_nstatus", "account_id", "normalized_status"),
        Index("ix_cloud_resources_account_ntype", "account_id", "normalized_type"),
        Index("ix_cloud_resources_account_service", "account_id", "service"),
        Index("ix_cloud_resources_account_name", "account_id", "resource_name"),
        Index("ix_cloud_resources_account_seen", "account_id", "last_seen_at"),
        Index("ix_cloud_resources_updated_at", "updated_at"),
    )
