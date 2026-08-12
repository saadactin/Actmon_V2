"""Repository for Discovery Job lifecycle."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
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

    async def fail_job(self, job_id: uuid.UUID, error: str) -> None:
        job = await self.db.get(DiscoveryJob, job_id)
        if job:
            job.status = "FAILED"
            job.error_detail = error[:2000]  # truncate
            job.completed_at = datetime.now(timezone.utc)
            await self.db.flush()

    async def get_by_id(self, job_id: uuid.UUID) -> Optional[DiscoveryJob]:
        return await self.db.get(DiscoveryJob, job_id)

    async def get_latest_for_account(self, account_id: uuid.UUID) -> Optional[DiscoveryJob]:
        result = await self.db.execute(
            select(DiscoveryJob)
            .where(DiscoveryJob.account_id == account_id)
            .order_by(DiscoveryJob.started_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

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
