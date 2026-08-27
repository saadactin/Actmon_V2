"""Repository for cloud alerts."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import (
    STATE_ACKNOWLEDGED,
    STATE_OPEN,
    STATE_RESOLVED,
    CloudAlert,
)


class AlertRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_alerts(
        self,
        account_id: Optional[uuid.UUID] = None,
        states: Optional[List[str]] = None,
        include_simulated: bool = True,
        limit: int = 500,
    ) -> List[CloudAlert]:
        """Newest first. Bounded by `limit` because an alert feed grows without
        end and the UI only ever renders a page of it."""
        stmt = select(CloudAlert)
        if account_id is not None:
            stmt = stmt.where(CloudAlert.account_id == account_id)
        if states:
            stmt = stmt.where(CloudAlert.state.in_(states))
        if not include_simulated:
            stmt = stmt.where(CloudAlert.simulated.is_(False))
        stmt = stmt.order_by(CloudAlert.created_at.desc()).limit(limit)
        return list((await self.db.execute(stmt)).scalars().all())

    async def get_by_id(self, alert_id: uuid.UUID) -> Optional[CloudAlert]:
        return await self.db.get(CloudAlert, alert_id)

    async def get_by_dedupe_key(self, dedupe_key: str) -> Optional[CloudAlert]:
        stmt = select(CloudAlert).where(CloudAlert.dedupe_key == dedupe_key)
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def upsert(
        self,
        anomaly_type: str,
        details: str,
        severity: str = "HIGH",
        dedupe_key: Optional[str] = None,
        account_id: Optional[uuid.UUID] = None,
        resource_id: Optional[uuid.UUID] = None,
        resource_name: Optional[str] = None,
        resource_type: Optional[str] = None,
        context: Optional[dict] = None,
        simulated: bool = False,
    ) -> CloudAlert:
        """Record a condition. With a dedupe_key, a recurrence updates the
        existing alert rather than adding a row — otherwise a condition seen on
        every discovery cycle would bury the feed in identical entries.

        A recurrence of something already RESOLVED re-opens it: the problem came
        back, and silently leaving it resolved would hide that.
        """
        now = datetime.now(timezone.utc)

        if dedupe_key:
            existing = await self.get_by_dedupe_key(dedupe_key)
            if existing is not None:
                existing.last_seen_at = now
                existing.occurrence_count = (existing.occurrence_count or 1) + 1
                existing.details = details
                existing.severity = severity
                if existing.state == STATE_RESOLVED:
                    existing.state = STATE_OPEN
                    existing.is_read = False
                    existing.resolved_at = None
                await self.db.flush()
                return existing

        alert = CloudAlert(
            account_id=account_id,
            anomaly_type=anomaly_type,
            severity=severity,
            details=details,
            dedupe_key=dedupe_key,
            state=STATE_OPEN,
            is_read=False,
            simulated=simulated,
            resource_id=resource_id,
            resource_name=resource_name,
            resource_type=resource_type,
            context=context,
            created_at=now,
            last_seen_at=now,
            occurrence_count=1,
        )
        self.db.add(alert)
        await self.db.flush()
        await self.db.refresh(alert)
        return alert

    async def acknowledge(self, alert_id: uuid.UUID) -> Optional[CloudAlert]:
        alert = await self.get_by_id(alert_id)
        if alert is None:
            return None
        alert.state = STATE_ACKNOWLEDGED
        alert.is_read = True
        alert.acknowledged_at = datetime.now(timezone.utc)
        await self.db.flush()
        return alert

    async def resolve(self, alert_id: uuid.UUID) -> Optional[CloudAlert]:
        alert = await self.get_by_id(alert_id)
        if alert is None:
            return None
        alert.state = STATE_RESOLVED
        alert.is_read = True
        alert.resolved_at = datetime.now(timezone.utc)
        await self.db.flush()
        return alert

    async def mark_read(self, alert_id: uuid.UUID) -> Optional[CloudAlert]:
        """Kept for the existing UI's "Mark as read" action, which is really an
        acknowledgement."""
        return await self.acknowledge(alert_id)

    async def auto_resolve_missing(
        self,
        dedupe_keys_seen: List[str],
        prefix: str,
        account_id: Optional[uuid.UUID] = None,
    ) -> int:
        """Close alerts whose condition no longer appears.

        A rule that fires per resource should also stop firing when the resource
        is fixed. Passing the keys observed this run, plus the rule's key prefix,
        resolves anything previously open under that prefix that wasn't seen —
        so a fixed problem clears itself instead of needing a manual dismiss.

        `account_id` is required in practice: a scan covers ONE account, so
        without it the "not seen this run" test would also match every other
        account's alerts and silently resolve real, unfixed problems.
        """
        stmt = select(CloudAlert).where(
            CloudAlert.state.in_([STATE_OPEN, STATE_ACKNOWLEDGED]),
            CloudAlert.dedupe_key.like(f"{prefix}%"),
        )
        if account_id is not None:
            stmt = stmt.where(CloudAlert.account_id == account_id)
        rows = list((await self.db.execute(stmt)).scalars().all())
        seen = set(dedupe_keys_seen)
        now = datetime.now(timezone.utc)
        closed = 0
        for alert in rows:
            if alert.dedupe_key not in seen:
                alert.state = STATE_RESOLVED
                alert.resolved_at = now
                closed += 1
        if closed:
            await self.db.flush()
        return closed

    async def counts_by_state(self, account_id: Optional[uuid.UUID] = None) -> dict:
        alerts = await self.list_alerts(account_id=account_id, limit=10_000)
        out = {STATE_OPEN: 0, STATE_ACKNOWLEDGED: 0, STATE_RESOLVED: 0}
        for a in alerts:
            if a.state in out:
                out[a.state] += 1
        return out
