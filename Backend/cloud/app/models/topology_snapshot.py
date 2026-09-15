"""A point-in-time capture of a topology, for comparison later.

A topology is derived on demand from the current inventory, and the inventory
holds current state only — so the moment a scan lands, yesterday's graph is
gone and "what changed in my infrastructure's shape?" becomes unanswerable.
This table is the missing half, the same gap `cloud_resource_changes` fills for
individual fields.

## Identity is the provider's, not ours

Nodes and edges are stored keyed by `provider_resource_id`, never by the
`cloud_resources.id` UUID. A resource that is deleted and recreated gets a new
row and a new UUID while remaining, to anyone looking at the cloud, the same
resource at the same address; and a resource whose row is rebuilt by a scan
would otherwise read as "removed, and something new added". The provider's own
identifier is the only identity stable enough to diff against.

## Stored compactly

Only what a diff needs: identity, type, name and region per node; the two
endpoints and the relationship kind per edge. Evidence, config and raw payloads
are not stored — they belong to the live graph, and duplicating them per
snapshot would grow this table by two orders of magnitude for data that is
already reproducible from the inventory.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Same reasoning as app/models/drift.py: importing the parent makes this model
# self-sufficient rather than dependent on import order.
from app.models.cloud_account import CloudAccount  # noqa: F401


class CloudTopologySnapshot(Base):
    __tablename__ = "cloud_topology_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # The scope this snapshot covers: a cloud_accounts.id as text, or the
    # literal "ALL". Deliberately NOT a foreign key — an "ALL" snapshot spans
    # every account, and a snapshot of one account should outlive that account
    # being removed, which is exactly when you want to look at what it held.
    scope: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    # What the user called it. Optional; the timestamp is the real identity.
    label: Mapped[str | None] = mapped_column(String(200), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    taken_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )
    taken_by: Mapped[str | None] = mapped_column(String(200), nullable=True)

    node_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    edge_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unresolved_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # [{ "key": provider_resource_id, "name", "type", "provider", "region",
    #    "account_name", "category" }]
    nodes: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # [{ "source": provider_resource_id, "target": provider_resource_id,
    #    "type", "label" }]
    edges: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # The coverage block as it stood, so a diff can also show coverage moving.
    coverage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    __table_args__ = (
        Index("ix_cloud_topology_snapshots_scope_taken", "scope", "taken_at"),
    )

    def summary(self) -> dict:
        """The list-view shape — never carries the node/edge arrays."""
        return {
            "id": str(self.id),
            "scope": self.scope,
            "label": self.label,
            "note": self.note,
            "taken_at": self.taken_at.isoformat() if self.taken_at else None,
            "taken_by": self.taken_by,
            "node_count": self.node_count,
            "edge_count": self.edge_count,
            "unresolved_count": self.unresolved_count,
            "coverage": self.coverage,
        }
