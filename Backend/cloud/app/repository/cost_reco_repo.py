"""Persistence for recommendation decisions."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cost_recommendation import (
    STATE_NEW, CloudCostRecommendationDecision,
)


class CostRecommendationRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def decisions_for(
        self, account_ids: Sequence[uuid.UUID],
    ) -> Dict[str, Dict[str, Any]]:
        """Current decisions in scope, keyed by fingerprint.

        Returns a dict rather than a list because the caller joins it against
        freshly-derived recommendations one at a time; a list would make that
        an O(n*m) scan on every analytics request.
        """
        if not account_ids:
            return {}
        rows = (await self.db.execute(
            select(CloudCostRecommendationDecision).where(
                CloudCostRecommendationDecision.account_id.in_(list(account_ids))
            )
        )).scalars().all()
        return {r.fingerprint: r.to_dict() for r in rows}

    async def get(self, fingerprint: str) -> Optional[CloudCostRecommendationDecision]:
        return (await self.db.execute(
            select(CloudCostRecommendationDecision).where(
                CloudCostRecommendationDecision.fingerprint == fingerprint
            )
        )).scalars().first()

    async def set_state(
        self,
        *,
        fingerprint: str,
        account_id: Optional[uuid.UUID],
        state: str,
        reason: Optional[str],
        actor: Optional[str],
        snapshot: Optional[Dict[str, Any]] = None,
    ) -> CloudCostRecommendationDecision:
        """Record a decision, preserving what it replaced.

        `previous_state` is kept so the audit answers "what changed", not just
        "what is it now" — a recommendation moved from ACCEPTED to DISMISSED is
        a different event from one dismissed on sight.
        """
        existing = await self.get(fingerprint)
        now = datetime.now(timezone.utc)

        if existing is None:
            row = CloudCostRecommendationDecision(
                fingerprint=fingerprint,
                account_id=account_id,
                state=state,
                previous_state=STATE_NEW,
                reason=reason,
                decided_by=actor,
                decided_at=now,
                snapshot=snapshot,
            )
            self.db.add(row)
        else:
            existing.previous_state = existing.state
            existing.state = state
            existing.reason = reason
            existing.decided_by = actor
            existing.decided_at = now
            if snapshot:
                existing.snapshot = snapshot
            row = existing

        await self.db.commit()
        await self.db.refresh(row)
        return row

    async def list_for_account(
        self, account_id: uuid.UUID,
    ) -> List[CloudCostRecommendationDecision]:
        return (await self.db.execute(
            select(CloudCostRecommendationDecision)
            .where(CloudCostRecommendationDecision.account_id == account_id)
            .order_by(CloudCostRecommendationDecision.decided_at.desc())
        )).scalars().all()
