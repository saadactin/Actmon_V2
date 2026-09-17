"""A named, reusable set of Resources-workspace filters.

WHY THIS IS A TABLE AND NOT BROWSER STORAGE
-------------------------------------------
"Unattached storage", "untagged production", "stale inventory" are questions a
team asks repeatedly and answers the same way each time. Kept in localStorage
they belong to one browser: they vanish on a new machine, cannot be handed to a
colleague, and cannot be quoted in a ticket. The column layout beside them is a
per-person convenience and does stay in localStorage; the query does not.

The filter set is stored as JSON rather than as columns because it is the query
layer's vocabulary, not this table's — every filter added to
`resource_query_repo` would otherwise need a migration here to be saveable.
It is validated on the way back out, so a stored filter that no longer exists
is dropped rather than failing the whole view.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Owner when RBAC is not enforcing and the caller is anonymous. An empty string
# rather than NULL so the uniqueness constraint below actually bites: Postgres
# treats NULLs as distinct, so two anonymous views could otherwise share a name.
UNATTRIBUTED = ""


class SavedResourceView(Base):
    __tablename__ = "cloud_resource_views"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Who saved it. Not an FK: this service has no user table of its own, and
    # inventing one to hold a name the RBAC layer already knows would be a
    # second source of truth about identity.
    owner: Mapped[str] = mapped_column(String(256), nullable=False, default=UNATTRIBUTED)

    # "ALL" for the cross-account inventory, otherwise an account id. A view
    # saved against one account is offered there and in the global view, never
    # silently applied to a different account's inventory.
    scope: Mapped[str] = mapped_column(String(64), nullable=False, default="ALL")

    filters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    columns: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    sort: Mapped[str | None] = mapped_column(String(64), nullable=True)
    direction: Mapped[str | None] = mapped_column(String(4), nullable=True)
    group_by: Mapped[str | None] = mapped_column(String(32), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        # One name per owner. Saving over an existing name updates it rather
        # than quietly creating a second view that looks identical in the menu.
        UniqueConstraint("owner", "name", name="uq_cloud_resource_views_owner_name"),
        Index("ix_cloud_resource_views_scope", "scope"),
    )
