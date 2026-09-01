"""Repository for the configuration-change log (cloud_resource_changes)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import Select, Text, and_, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drift import CloudResourceChange
from app.utils.drift_rules import ALL_PILLARS


class DriftRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # -- writes ---------------------------------------------------------------

    async def record(
        self,
        account_id: uuid.UUID,
        job_id: Optional[uuid.UUID],
        resource: Dict[str, Any],
        changes: Sequence[Dict[str, Any]],
    ) -> int:
        """Append classified changes for one resource. Returns rows added.

        `resource` supplies the identity columns (provider_resource_id,
        resource_type, resource_name, region_or_zone, resource_id); `changes`
        comes straight from app.utils.drift_rules.
        """
        if not changes:
            return 0
        # One timestamp for the whole resource, so a scan's field changes sort
        # together instead of interleaving with another resource's.
        detected_at = datetime.now(timezone.utc)
        for change in changes:
            self.db.add(
                CloudResourceChange(
                    account_id=account_id,
                    job_id=job_id,
                    resource_id=resource.get("resource_id"),
                    provider_resource_id=(resource.get("provider_resource_id") or "")[:512],
                    resource_type=(resource.get("resource_type") or "Unknown")[:100],
                    resource_name=(resource.get("resource_name") or None),
                    region_or_zone=(resource.get("region_or_zone") or None),
                    change_type=change["change_type"],
                    field_path=change.get("field_path"),
                    old_value=change.get("old_value"),
                    new_value=change.get("new_value"),
                    impact=change.get("impact") or [],
                    severity=change["severity"],
                    direction=change.get("direction"),
                    value_vanished=bool(change.get("value_vanished")),
                    summary=change["summary"],
                    detected_at=detected_at,
                )
            )
        return len(changes)

    async def delete_for_job(self, job_id: uuid.UUID) -> int:
        """Discard everything one scan recorded.

        For a scan that CRASHED. How far it got and whether its writes were
        coherent are both unknown, so none of its output is trusted. A sweep
        that merely could not reach every scope is a weaker failure and gets the
        narrower treatment below.
        """
        result = await self.db.execute(
            delete(CloudResourceChange).where(CloudResourceChange.job_id == job_id)
        )
        await self.db.flush()
        return result.rowcount or 0

    async def delete_unreliable_for_job(self, job_id: uuid.UUID) -> int:
        """Discard only the rows an INCOMPLETE sweep could have invented.

        A scope that fails to enumerate yields missing data, never wrong data:
        anything the sweep did report, it genuinely read from the provider. So a
        field that changed to a new value is trustworthy even from a partial
        sweep, while a field that went empty may simply not have been readable.

        Dropping only the latter is what keeps this feature useful on accounts
        that routinely report a few unreachable scopes out of several hundred —
        discarding the whole sweep there means never showing any drift at all.
        """
        result = await self.db.execute(
            delete(CloudResourceChange).where(
                CloudResourceChange.job_id == job_id,
                CloudResourceChange.value_vanished.is_(True),
            )
        )
        await self.db.flush()
        return result.rowcount or 0

    # -- reads ----------------------------------------------------------------

    def _filtered(
        self,
        *,
        account_id: Optional[uuid.UUID] = None,
        days: Optional[int] = None,
        change_type: Optional[str] = None,
        impact: Optional[str] = None,
        severity: Optional[str] = None,
        resource_type: Optional[str] = None,
        provider_resource_id: Optional[str] = None,
        direction: Optional[str] = None,
        search: Optional[str] = None,
    ) -> list:
        clauses = []
        if account_id:
            clauses.append(CloudResourceChange.account_id == account_id)
        if days:
            since = datetime.now(timezone.utc) - timedelta(days=days)
            clauses.append(CloudResourceChange.detected_at >= since)
        if change_type:
            clauses.append(CloudResourceChange.change_type == change_type)
        if impact:
            # JSONB containment: the row's impact array holds this pillar.
            clauses.append(CloudResourceChange.impact.contains([impact]))
        if severity:
            clauses.append(CloudResourceChange.severity == severity)
        if resource_type:
            clauses.append(CloudResourceChange.resource_type == resource_type)
        if provider_resource_id:
            clauses.append(CloudResourceChange.provider_resource_id == provider_resource_id)
        if direction:
            clauses.append(CloudResourceChange.direction == direction)
        if search:
            like = f"%{search.lower()}%"
            clauses.append(
                func.lower(CloudResourceChange.resource_name).like(like)
                | func.lower(CloudResourceChange.provider_resource_id).like(like)
                | func.lower(CloudResourceChange.field_path).like(like)
                | func.lower(CloudResourceChange.summary).like(like)
            )
        return clauses

    async def count(self, **filters) -> int:
        clauses = self._filtered(**filters)
        stmt = select(func.count()).select_from(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        return (await self.db.execute(stmt)).scalar_one()

    async def list(
        self, *, page: int = 1, page_size: int = 50, **filters
    ) -> List[CloudResourceChange]:
        clauses = self._filtered(**filters)
        stmt: Select = select(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        # Newest first, then grouped by resource so one scan's changes to the
        # same resource stay adjacent and the UI can fold them into one event.
        stmt = stmt.order_by(
            CloudResourceChange.detected_at.desc(),
            CloudResourceChange.provider_resource_id,
            CloudResourceChange.field_path,
        )
        offset = max(0, (page - 1) * page_size)
        stmt = stmt.offset(offset).limit(page_size)
        return list((await self.db.execute(stmt)).scalars().all())

    async def counts_by(self, column, *, limit: Optional[int] = None, **filters) -> List[tuple]:
        """(value, count) for one column, biggest first."""
        clauses = self._filtered(**filters)
        stmt = select(column, func.count().label("n")).select_from(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.group_by(column).order_by(func.count().desc())
        if limit:
            stmt = stmt.limit(limit)
        return [(row[0], row[1]) for row in (await self.db.execute(stmt)).all()]

    async def counts_by_impact(self, **filters) -> Dict[str, int]:
        """Per-pillar totals. A change touching two pillars counts in both, so
        these deliberately do not sum to the total."""
        clauses = self._filtered(**filters)
        cols = [
            func.count()
            .filter(CloudResourceChange.impact.contains([pillar]))
            .label(pillar)
            for pillar in ALL_PILLARS
        ]
        stmt = select(*cols).select_from(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        row = (await self.db.execute(stmt)).one()
        return {pillar: int(row[i] or 0) for i, pillar in enumerate(ALL_PILLARS)}

    async def counts_by_day(self, **filters) -> List[Dict[str, Any]]:
        clauses = self._filtered(**filters)
        day = func.date_trunc("day", CloudResourceChange.detected_at).label("day")
        stmt = select(day, func.count().label("n")).select_from(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.group_by(day).order_by(day)
        return [
            {"date": row[0].date().isoformat(), "count": int(row[1])}
            for row in (await self.db.execute(stmt)).all()
        ]

    async def top_resources(self, *, limit: int = 10, **filters) -> List[Dict[str, Any]]:
        """The resources that changed most in the window - where to look first."""
        clauses = self._filtered(**filters)
        stmt = select(
            CloudResourceChange.provider_resource_id,
            func.max(CloudResourceChange.resource_name).label("resource_name"),
            func.max(CloudResourceChange.resource_type).label("resource_type"),
            # Postgres has no max() for uuid, and every row in this group carries
            # the same resource_id anyway, so cast to text to carry it through.
            func.max(cast(CloudResourceChange.resource_id, Text)).label("resource_id"),
            func.count().label("changes"),
            func.max(CloudResourceChange.detected_at).label("last_change"),
        ).select_from(CloudResourceChange)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = (
            stmt.group_by(CloudResourceChange.provider_resource_id)
            .order_by(func.count().desc(), func.max(CloudResourceChange.detected_at).desc())
            .limit(limit)
        )
        return [
            {
                "provider_resource_id": row[0],
                "resource_name": row[1],
                "resource_type": row[2],
                "resource_id": row[3],
                "changes": int(row[4]),
                "last_change": row[5].isoformat() if row[5] else None,
            }
            for row in (await self.db.execute(stmt)).all()
        ]

    async def timeline_for_resource(
        self, provider_resource_id: str, *, limit: int = 200
    ) -> List[CloudResourceChange]:
        stmt = (
            select(CloudResourceChange)
            .where(CloudResourceChange.provider_resource_id == provider_resource_id)
            .order_by(CloudResourceChange.detected_at.desc(), CloudResourceChange.field_path)
            .limit(limit)
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def distinct_resource_types(self, **filters) -> List[str]:
        clauses = self._filtered(**filters)
        stmt = select(CloudResourceChange.resource_type).distinct()
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.order_by(CloudResourceChange.resource_type)
        return [r[0] for r in (await self.db.execute(stmt)).all() if r[0]]

    async def account_has_history(self, account_id: uuid.UUID) -> bool:
        stmt = (
            select(CloudResourceChange.id)
            .where(CloudResourceChange.account_id == account_id)
            .limit(1)
        )
        return (await self.db.execute(stmt)).first() is not None
