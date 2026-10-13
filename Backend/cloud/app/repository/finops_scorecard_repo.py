"""Reads and writes for `cloud_finops_scorecards` -- the FinOps health trend.

`record_if_new` is the only write path, and it is a single `INSERT ...
ON CONFLICT DO NOTHING` against the (scope_type, scope_id, as_of) unique
index, not a SELECT-then-INSERT. Two requests computing today's score for the
same scope a moment apart (two browser tabs, a user double-clicking refresh)
both call this; the database decides which one's row survives, so there is no
window where both believe they are first and both insert.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.finops_scorecard import CloudFinopsScorecard


class FinopsScorecardRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def record_if_new(
        self, *, scope_type: str, scope_id: uuid.UUID, as_of: date,
        score: Optional[float], accounts_in_scope: int, health: Dict[str, Any],
    ) -> bool:
        """Write today's snapshot, unless this scope already has one. Returns
        whether a row was actually written."""
        stmt = (
            pg_insert(CloudFinopsScorecard)
            .values(
                scope_type=scope_type, scope_id=scope_id, as_of=as_of,
                score=score, accounts_in_scope=accounts_in_scope, health=health,
            )
            .on_conflict_do_nothing(constraint="uq_finops_scorecard_scope_day")
            .returning(CloudFinopsScorecard.id)
        )
        result = await self.db.execute(stmt)
        written = result.first() is not None
        await self.db.commit()
        return written

    async def history_for(
        self, *, scope_type: str, scope_id: uuid.UUID, limit: int = 90,
    ) -> List[CloudFinopsScorecard]:
        """Oldest first, capped to the most recent `limit` days -- a trend
        chart reads left-to-right as time passing, not newest-first."""
        rows = (await self.db.execute(
            select(CloudFinopsScorecard)
            .where(
                CloudFinopsScorecard.scope_type == scope_type,
                CloudFinopsScorecard.scope_id == scope_id,
            )
            .order_by(CloudFinopsScorecard.as_of.desc())
            .limit(limit)
        )).scalars().all()
        return list(reversed(rows))

    async def count_for_scope(self, *, scope_type: str, scope_id: uuid.UUID) -> int:
        from sqlalchemy import func

        return (await self.db.execute(
            select(func.count()).select_from(CloudFinopsScorecard).where(
                CloudFinopsScorecard.scope_type == scope_type,
                CloudFinopsScorecard.scope_id == scope_id,
            )
        )).scalar() or 0

    async def delete_for_scope(self, *, scope_type: str, scope_id: uuid.UUID) -> int:
        from sqlalchemy import delete

        result = await self.db.execute(
            delete(CloudFinopsScorecard).where(
                CloudFinopsScorecard.scope_type == scope_type,
                CloudFinopsScorecard.scope_id == scope_id,
            )
        )
        await self.db.commit()
        return result.rowcount or 0
