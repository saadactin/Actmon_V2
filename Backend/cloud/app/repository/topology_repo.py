"""Queries the topology needs beyond the inventory itself.

Three kinds of thing live here:

*   the cheap aggregates that turn a resource node into an investigable one —
    how many configuration changes it has, how many audit events touched it;
*   the fingerprint that tells the service whether its cached graph is still
    current;
*   snapshot persistence.

Kept out of the service so the SQL is in one place and the service reads as
orchestration, matching how drift and events are already split in this
codebase.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import Text, and_, cast, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_account import CloudAccount
from app.models.cloud_event import CloudEvent
from app.models.discovery_job import DiscoveryJob
from app.models.drift import CloudResourceChange
from app.models.resource import CloudResource
from app.models.topology_snapshot import CloudTopologySnapshot


class TopologyRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── cache fingerprint ────────────────────────────────────────────────────

    async def fingerprint(self, account_ids: Optional[Sequence[uuid.UUID]]) -> tuple:
        """A value that changes exactly when the graph's inputs change.

        Used instead of a time-to-live. A TTL either serves a graph that is
        known to be out of date (the scan landed 20 seconds ago) or rebuilds
        one that is known to be current, and both are avoidable: everything the
        graph is built from has a monotonic high-water mark, so comparing those
        answers "is my cached graph still correct?" exactly rather than
        approximately.

        Includes the drift and event high-water marks because nodes carry
        change and activity counts, so a graph built before the latest
        collection would show stale badges even though its edges are fine.
        """
        def scoped(stmt, column):
            if account_ids:
                return stmt.where(column.in_(list(account_ids)))
            return stmt

        resource_stats = (
            await self.db.execute(scoped(
                select(func.count(), func.max(CloudResource.updated_at))
                .select_from(CloudResource),
                CloudResource.account_id,
            ))
        ).one()

        drift_mark = (
            await self.db.execute(scoped(
                select(func.max(CloudResourceChange.detected_at))
                .select_from(CloudResourceChange),
                CloudResourceChange.account_id,
            ))
        ).scalar_one_or_none()

        event_mark = (
            await self.db.execute(scoped(
                select(func.max(CloudEvent.timestamp)).select_from(CloudEvent),
                CloudEvent.account_id,
            ))
        ).scalar_one_or_none()

        account_stats = (
            await self.db.execute(scoped(
                select(func.count(), func.max(CloudAccount.last_discovery),
                       func.max(CloudAccount.updated_at))
                .select_from(CloudAccount),
                CloudAccount.id,
            ))
        ).one()

        return (
            int(resource_stats[0] or 0),
            resource_stats[1].isoformat() if resource_stats[1] else None,
            drift_mark.isoformat() if drift_mark else None,
            event_mark.isoformat() if event_mark else None,
            int(account_stats[0] or 0),
            account_stats[1].isoformat() if account_stats[1] else None,
            account_stats[2].isoformat() if account_stats[2] else None,
        )

    # ── per-resource annotations ─────────────────────────────────────────────

    async def drift_by_resource(
        self, account_ids: Optional[Sequence[uuid.UUID]]
    ) -> Dict[str, Dict[str, Any]]:
        """Configuration changes per resource, keyed by provider_resource_id.

        Keyed on the provider identifier rather than our UUID because the drift
        log deliberately records changes for resources whose inventory row has
        since been deleted — that is how a deletion survives the sweep that
        detected it — and those rows still belong to the resource's history.
        """
        stmt = select(
            CloudResourceChange.provider_resource_id,
            func.count().label("total"),
            func.max(CloudResourceChange.detected_at).label("last_change"),
            func.count()
            .filter(CloudResourceChange.severity.in_(("CRITICAL", "HIGH")))
            .label("significant"),
        ).select_from(CloudResourceChange)
        if account_ids:
            stmt = stmt.where(CloudResourceChange.account_id.in_(list(account_ids)))
        stmt = stmt.group_by(CloudResourceChange.provider_resource_id)

        return {
            row[0]: {
                "drift_count": int(row[1]),
                "last_drift_at": row[2].isoformat() if row[2] else None,
                "significant_drift_count": int(row[3] or 0),
            }
            for row in (await self.db.execute(stmt)).all()
            if row[0]
        }

    async def events_by_resource(
        self,
        account_ids: Optional[Sequence[uuid.UUID]],
        *,
        window_days: int = 30,
    ) -> Dict[str, Dict[str, Any]]:
        """Audit events per resource over a bounded window.

        Bounded because the point of the badge is "has anyone touched this
        lately", and an unbounded count over an append-only table only grows.
        The window is stated in the response so the number is never a mystery.

        `resource_id` on an event is the provider's identifier — the same string
        the inventory stores — which is what makes this join exact rather than
        a name match.
        """
        since = datetime.now(timezone.utc) - timedelta(days=window_days)
        stmt = select(
            CloudEvent.resource_id,
            func.count().label("total"),
            func.max(CloudEvent.timestamp).label("last_event"),
            func.count()
            .filter(CloudEvent.risk_level.in_(("CRITICAL", "HIGH")))
            .label("high_risk"),
        ).select_from(CloudEvent).where(
            and_(
                CloudEvent.timestamp >= since,
                CloudEvent.resource_id.isnot(None),
            )
        )
        if account_ids:
            stmt = stmt.where(CloudEvent.account_id.in_(list(account_ids)))
        stmt = stmt.group_by(CloudEvent.resource_id)

        return {
            row[0]: {
                "event_count": int(row[1]),
                "last_event_at": row[2].isoformat() if row[2] else None,
                "high_risk_event_count": int(row[3] or 0),
                "event_window_days": window_days,
            }
            for row in (await self.db.execute(stmt)).all()
            if row[0]
        }

    # ── provider / account status ────────────────────────────────────────────

    async def accounts(self) -> List[CloudAccount]:
        result = await self.db.execute(
            select(CloudAccount).order_by(CloudAccount.provider, CloudAccount.account_name)
        )
        return list(result.scalars().all())

    async def resource_counts_by_account(self) -> Dict[str, int]:
        stmt = (
            select(CloudResource.account_id, func.count())
            .select_from(CloudResource)
            .group_by(CloudResource.account_id)
        )
        return {
            str(row[0]): int(row[1]) for row in (await self.db.execute(stmt)).all()
        }

    async def latest_discovery_jobs(self) -> Dict[str, Dict[str, Any]]:
        """The most recent discovery job per account.

        This is what separates "no resources" from "we could not read them"
        (section 87): an account whose latest job FAILED with a permission
        error has an empty topology for a completely different reason than an
        account that genuinely holds nothing.
        """
        newest = (
            select(
                DiscoveryJob.account_id,
                func.max(DiscoveryJob.started_at).label("started_at"),
            )
            .group_by(DiscoveryJob.account_id)
            .subquery()
        )
        stmt = select(DiscoveryJob).join(
            newest,
            and_(
                DiscoveryJob.account_id == newest.c.account_id,
                DiscoveryJob.started_at == newest.c.started_at,
            ),
        )
        rows = list((await self.db.execute(stmt)).scalars().all())
        return {
            str(job.account_id): {
                "status": job.status,
                "resources_found": job.resources_found,
                "error_detail": job.error_detail,
                "started_at": job.started_at.isoformat() if job.started_at else None,
                "completed_at": (
                    job.completed_at.isoformat() if job.completed_at else None
                ),
            }
            for job in rows
        }

    # ── resource lookup ──────────────────────────────────────────────────────

    async def resource(self, resource_id: uuid.UUID) -> Optional[CloudResource]:
        return await self.db.get(CloudResource, resource_id)

    async def resource_by_provider_id(
        self, provider_resource_id: str
    ) -> Optional[CloudResource]:
        stmt = (
            select(CloudResource)
            .where(CloudResource.provider_resource_id == provider_resource_id)
            .limit(1)
        )
        return (await self.db.execute(stmt)).scalars().first()

    # ── snapshots ────────────────────────────────────────────────────────────

    async def save_snapshot(
        self,
        *,
        scope: str,
        label: Optional[str],
        note: Optional[str],
        taken_by: Optional[str],
        node_count: int,
        edge_count: int,
        unresolved_count: int,
        nodes: List[Dict[str, Any]],
        edges: List[Dict[str, Any]],
        coverage: Dict[str, Any],
    ) -> CloudTopologySnapshot:
        snapshot = CloudTopologySnapshot(
            id=uuid.uuid4(),
            scope=scope,
            label=label,
            note=note,
            taken_by=taken_by,
            node_count=node_count,
            edge_count=edge_count,
            unresolved_count=unresolved_count,
            nodes=nodes,
            edges=edges,
            coverage=coverage,
        )
        self.db.add(snapshot)
        await self.db.flush()
        return snapshot

    async def list_snapshots(
        self, *, scope: Optional[str] = None, limit: int = 50
    ) -> List[CloudTopologySnapshot]:
        stmt = select(CloudTopologySnapshot)
        if scope:
            stmt = stmt.where(CloudTopologySnapshot.scope == scope)
        stmt = stmt.order_by(CloudTopologySnapshot.taken_at.desc()).limit(limit)
        return list((await self.db.execute(stmt)).scalars().all())

    async def get_snapshot(
        self, snapshot_id: uuid.UUID
    ) -> Optional[CloudTopologySnapshot]:
        return await self.db.get(CloudTopologySnapshot, snapshot_id)

    async def delete_snapshot(self, snapshot_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            delete(CloudTopologySnapshot).where(
                CloudTopologySnapshot.id == snapshot_id
            )
        )
        await self.db.flush()
        return bool(result.rowcount)

    async def count_snapshots(self, *, scope: Optional[str] = None) -> int:
        stmt = select(func.count()).select_from(CloudTopologySnapshot)
        if scope:
            stmt = stmt.where(CloudTopologySnapshot.scope == scope)
        return (await self.db.execute(stmt)).scalar_one()
