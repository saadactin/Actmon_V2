"""Service layer for triggering and tracking discovery jobs."""
from __future__ import annotations

import asyncio
import uuid

from fastapi import BackgroundTasks, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.discovery_repo import DiscoveryRepository
from app.repository.cloud_account_repo import CloudAccountRepository
from app.schemas.discovery import DiscoveryTriggerResponse, DiscoveryStatusResponse


class DiscoveryService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.disco_repo = DiscoveryRepository(db)
        self.account_repo = CloudAccountRepository(db)

    async def trigger_scan(
        self, account_id: uuid.UUID, background_tasks: BackgroundTasks
    ) -> DiscoveryTriggerResponse:
        account = await self.account_repo.get_by_id(account_id)
        if not account:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Cloud account {account_id} not found",
            )

        # Create job record
        job = await self.disco_repo.create_job(account_id)
        await self.db.commit()
        await self.db.refresh(job)

        # Dispatch as a FastAPI background task (runs in the same event loop)
        from app.workers.discovery_worker import run_discovery_scan
        background_tasks.add_task(run_discovery_scan, job.id, account_id)

        return DiscoveryTriggerResponse.model_validate(job)

    async def get_job_status(self, job_id: uuid.UUID) -> DiscoveryStatusResponse | None:
        job = await self.disco_repo.get_by_id(job_id)
        if not job:
            return None
        return DiscoveryStatusResponse.model_validate(job)
