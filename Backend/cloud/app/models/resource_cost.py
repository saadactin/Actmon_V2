"""Per-resource billed cost, materialized so the database can sort and filter on it.

WHY A TABLE AND NOT THE EXISTING CACHE
--------------------------------------
Per-resource cost already exists in this product: `fetch_real_costs_by_resource`
returns a map keyed by provider resource ID, held in an in-process cache, and
the resource list decorates its rows from it at request time. That works for
decoration and cannot work for anything else the Resources spec asks for:
`cost_min`, `cost_max`, `sort=cost` and "most expensive resources" all need the
value inside the query, not applied to its output. Sorting 1,500 rows by a
number the database cannot see means fetching all 1,500 rows — the exact
behaviour this rebuild removes.

So the map is materialized here. This is not a second billing integration: the
numbers come from the same provider call as before, through the same cache and
the same capability checks. Only their resting place is new.

WHY IT IS NOT A COLUMN ON cloud_resources
-----------------------------------------
Because a cost is not a property of a resource, it is an observation about one:
it has a currency, a window, a source and a time it was fetched, and all of
those have to travel with the number for the number to mean anything (spec
§18). A bare float column would strip every one of them, which is how a figure
ends up on screen with no way to say where it came from.

WHAT IS DELIBERATELY ABSENT
---------------------------
There is no row for a resource the provider did not bill for, and no zero. AWS
resources never get rows at all — Cost Explorer cannot answer per-resource
questions. Absent means unknown, and the API reports it as NA with the
capability registry's reason attached. It never means free.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime, Float, ForeignKey, Index, Integer, String, Text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Where a figure came from. Mirrors the vocabulary the cost feature already
# uses, so the two features cannot describe the same provenance differently.
SOURCE_PROVIDER_BILLING = "PROVIDER_BILLING"


class CloudResourceCost(Base):
    """The most recent billed cost observed for one resource.

    One row per resource, replaced wholesale when a successful billing query
    returns. History lives in `cloud_cost_facts`; this table is only ever
    "what does this cost now", which is the question the inventory asks.
    """

    __tablename__ = "cloud_resource_costs"

    # The resource itself is the key. A resource cannot have two current costs,
    # and CASCADE means a pruned resource cannot leave an orphaned figure
    # behind to be summed into a total later.
    resource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_resources.id", ondelete="CASCADE"),
        primary_key=True,
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    # Kept alongside the FK so a row is still interpretable in isolation, and
    # so a re-materialization can match on what the provider actually returned.
    provider_resource_id: Mapped[str] = mapped_column(Text, nullable=False)

    # Nullable on purpose. A resource can appear in a billing response with no
    # amount for the window; that is unknown, and NULL is how unknown is
    # spelled. Callers must not read it as zero.
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # The window the amount covers, in days. Without it the number is unreadable:
    # 12,400 over 30 days and 12,400 over 90 days are different facts.
    period_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)

    source: Mapped[str] = mapped_column(
        String(32), nullable=False, default=SOURCE_PROVIDER_BILLING
    )
    # What the billing API called it, which is frequently not what the
    # inventory calls it — useful when a figure looks wrong and someone needs
    # to see the provider's own labelling.
    billed_service: Mapped[str | None] = mapped_column(String(255), nullable=True)
    billed_region: Mapped[str | None] = mapped_column(String(128), nullable=True)

    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        # "Most expensive resources in this account", which is the only sort
        # this table exists to serve.
        Index("ix_resource_cost_account_amount", "account_id", "amount"),
    )
