"""One snapshot per day, per scope, of the FinOps health score.

`cost_allocation_service.finops_health()` is a pure function: it is computed
fresh on every request from live inventory, facts and budgets, and nothing
about it is stored. That is correct for "what is my score right now", but it
cannot answer "is our FinOps practice getting better" -- a maturity grade with
no history is a single data point pretending to be a trend.

This table is that history, and nothing else. It does not replace the live
computation; `finops_health()` is still called on every read, and this table
is written ALONGSIDE that read, at most once per calendar day per scope, so
that:

* repeatedly opening the scorecard page does not fill the table with
  identical rows -- `record_if_new` only inserts when today has no row yet
  for this scope;
* a scope that is never viewed simply has no history, which is honest (no
  background job invents a score for an estate nobody asked about);
* the live score shown right now and the latest stored point can disagree by
  at most a few hours -- whatever changed between the last view and this one.

**Scope identity avoids the NULL-uniqueness trap this codebase has already
been burned by once** (see `cost_fact.build_fact_key`'s docstring: NULL is
never equal to NULL in a SQL UNIQUE index, so a composite unique constraint
over a nullable column silently admits duplicates). Rather than letting
`scope_id` be NULL for the organisation-wide scope, the estate-wide scope uses
a fixed sentinel UUID (`ESTATE_SCOPE_ID`), so `scope_id` is NEVER NULL and the
three-column unique constraint below needs no NULL-handling of its own.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import Date, DateTime, Float, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_NULLABLE_JSONB = JSONB(none_as_null=True)

# ── Scope ─────────────────────────────────────────────────────────────────────
SCOPE_ACCOUNT = "ACCOUNT"
SCOPE_CLIENT = "CLIENT"
SCOPE_ESTATE = "ESTATE"
SCOPE_TYPES = (SCOPE_ACCOUNT, SCOPE_CLIENT, SCOPE_ESTATE)

# The sentinel for SCOPE_ESTATE -- see the module docstring. Never a real
# account or client id; chosen to be visibly a placeholder in a query result.
ESTATE_SCOPE_ID = uuid.UUID("00000000-0000-0000-0000-000000000000")


class CloudFinopsScorecard(Base):
    """One day's FinOps health snapshot for one account, client or the estate."""

    __tablename__ = "cloud_finops_scorecards"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    # Real account_id / client_id for ACCOUNT / CLIENT scope, ESTATE_SCOPE_ID
    # for ESTATE. Deliberately no FK: a client or account can be deleted
    # without silently rewriting its own history.
    scope_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    as_of: Mapped[date] = mapped_column(Date, nullable=False)

    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    accounts_in_scope: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # The full finops_health() payload (components, domains, maturity) at the
    # time of this snapshot -- so a past point can be inspected in as much
    # detail as today's, not just its headline number.
    health: Mapped[Dict[str, Any]] = mapped_column(_NULLABLE_JSONB, nullable=False)

    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        UniqueConstraint("scope_type", "scope_id", "as_of", name="uq_finops_scorecard_scope_day"),
        Index("ix_finops_scorecard_scope", "scope_type", "scope_id", "as_of"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "scope_type": self.scope_type,
            "scope_id": str(self.scope_id),
            "as_of": self.as_of.isoformat() if self.as_of else None,
            "score": self.score,
            "accounts_in_scope": self.accounts_in_scope,
            "maturity": (self.health or {}).get("maturity"),
            "computed_at": self.computed_at.isoformat() if self.computed_at else None,
        }
