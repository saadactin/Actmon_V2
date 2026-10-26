"""SQLAlchemy ORM model for cloud_accounts table."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models import client as _client  # noqa: F401  (FK target must be registered)


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
    # The client this account is run for. SET NULL, never CASCADE: removing a
    # client label must not delete an account or anything collected for it.
    client_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_clients.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # The provider's own identity for this account — AWS account id, Azure
    # subscription id, OCI tenancy OCID. Stored in the clear (it is an
    # identifier, not a credential) so organisation onboarding can tell which
    # members are already connected without decrypting every stored secret.
    provider_account_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True
    )
    # How the account was added, when it came from an organisation listing:
    # {"kind": "aws_organization", "organization_id": ..., "role_name": ...}.
    # NULL for an account added by hand.
    onboarding_source: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
