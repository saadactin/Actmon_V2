"""Repository for Discovery Job lifecycle."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.discovery_job import DiscoveryJob


class DiscoveryRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create_job(self, account_id: uuid.UUID) -> DiscoveryJob:
        job = DiscoveryJob(account_id=account_id, status="PENDING")
        self.db.add(job)
        await self.db.flush()
        await self.db.refresh(job)
        return job

    async def set_running(self, job_id: uuid.UUID, task_id: str = "") -> None:
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.status = "RUNNING"
            job.celery_task_id = task_id
            await self.db.flush()

    async def set_progress(self, job_id: uuid.UUID, resources_found: int) -> None:
        """Update the live resource count while a scan is still RUNNING."""
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.resources_found = resources_found
            await self.db.flush()

    async def complete_job(self, job_id: uuid.UUID, resources_found: int) -> None:
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.status = "COMPLETED"
            job.resources_found = resources_found
            job.completed_at = datetime.now(timezone.utc)
            await self.db.flush()

    async def set_partial(self, job_id: uuid.UUID, detail: str) -> None:
        """Record that the sweep completed but was incomplete, so nothing was
        pruned. The job still COMPLETEs (the resources it did find are valid) —
        this note explains why stale rows may linger, and surfaces in the
        Resources "why is this empty/stale" diagnostic."""
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.error_detail = detail[:2000]
            await self.db.flush()

    async def set_scope_summary(self, job_id: uuid.UUID, summary) -> None:
        """What the sweep read, per scope (None when the scanner does not say)."""
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.scope_summary = summary
            await self.db.flush()

    async def fail_job(self, job_id: uuid.UUID, error: str) -> None:
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.status = "FAILED"
            job.error_detail = error[:2000]  # truncate
            job.completed_at = datetime.now(timezone.utc)
            await self.db.flush()

    async def get_by_id(self, job_id: uuid.UUID) -> Optional[DiscoveryJob]:
        return await self.db.get(DiscoveryJob, job_id)

    async def get_latest_for_account(
        self, account_id: uuid.UUID, status: Optional[str] = None
    ) -> Optional[DiscoveryJob]:
        """The account's most recent job, optionally the most recent in one
        state. `status="COMPLETED"` answers "how old is the inventory really",
        which is a different question from "what happened last" whenever the
        last attempt failed."""
        stmt = select(DiscoveryJob).where(DiscoveryJob.account_id == account_id)
        if status:
            stmt = stmt.where(DiscoveryJob.status == status)
        result = await self.db.execute(
            stmt.order_by(DiscoveryJob.started_at.desc()).limit(1)
        )
        return result.scalar_one_or_none()

    async def change_counts_for_job(self, job_id: uuid.UUID) -> dict:
        """What one sweep changed, counted from the drift log it wrote.

        Read from `cloud_resource_changes` rather than recomputed: the drift
        engine already decided what counts as a change, and a second opinion
        here would eventually disagree with the Config Drift page about the
        same sweep.
        """
        from app.models.drift import CloudResourceChange

        rows = (await self.db.execute(
            select(CloudResourceChange.change_type, func.count())
            .where(CloudResourceChange.job_id == job_id)
            .group_by(CloudResourceChange.change_type)
        )).all()
        return {str(change_type): int(count) for change_type, count in rows}

    async def get_active_for_account(self, account_id: uuid.UUID) -> Optional[DiscoveryJob]:
        """The account's currently PENDING/RUNNING job, if any. Used to avoid
        launching a second concurrent scan that would race the stale-prune."""
        result = await self.db.execute(
            select(DiscoveryJob)
            .where(DiscoveryJob.account_id == account_id)
            .where(DiscoveryJob.status.in_(("PENDING", "RUNNING")))
            .order_by(DiscoveryJob.started_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()
