"""SQLAlchemy ORM model for cloud_accounts table."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class CloudAccount(Base):
    __tablename__ = "cloud_accounts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(
        String(50), nullable=False, index=True
    )  # AWS | Azure | Oracle
    environment: Mapped[str] = mapped_column(
        String(50), nullable=False, default="Production"
    )
    tenant_or_region: Mapped[str] = mapped_column(String(255), nullable=False)
    auth_mode: Mapped[str] = mapped_column(String(50), nullable=False, default="API_Keys")
    auto_discovery: Mapped[bool] = mapped_column(Boolean, default=True)
    credentials_enc: Mapped[str] = mapped_column(
        Text, nullable=False
    )  # Fernet-encrypted JSON
    last_discovery: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
