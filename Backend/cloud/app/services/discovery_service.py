"""Service layer for triggering and tracking discovery jobs."""
from __future__ import annotations

import asyncio
import uuid

from fastapi import BackgroundTasks, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.discovery_repo import DiscoveryRepository
from app.repository.cloud_account_repo import CloudAccountRepository
from app.schemas.discovery import DiscoveryTriggerResponse, DiscoveryStatusResponse

# Keep strong references to fire-and-forget scan tasks so the event loop does
# not garbage-collect them mid-run.
_running_tasks: set[asyncio.Task] = set()


def _launch_scan(job_id: uuid.UUID, account_id: uuid.UUID) -> None:
    """Start a discovery scan as an independent concurrent task.

    We use asyncio.create_task (not Starlette BackgroundTasks) so that a
    scan-all fan-out runs all accounts concurrently — BackgroundTasks added to
    one response run sequentially. run_discovery_scan opens its own DB session,
    so it is safe to detach from the request lifecycle.
    """
    from app.workers.discovery_worker import run_discovery_scan

    task = asyncio.create_task(run_discovery_scan(job_id, account_id))
    _running_tasks.add(task)
    task.add_done_callback(_running_tasks.discard)


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

        # If a scan is already in flight for this account, return it instead of
        # starting a second one (two concurrent scans would race delete_stale).
        existing = await self.disco_repo.get_active_for_account(account_id)
        if existing:
            return DiscoveryTriggerResponse.model_validate(existing)

        # Create job record
        job = await self.disco_repo.create_job(account_id)
        await self.db.commit()
        await self.db.refresh(job)

        _launch_scan(job.id, account_id)

        return DiscoveryTriggerResponse.model_validate(job)

    async def trigger_scan_all(self) -> list[DiscoveryTriggerResponse]:
        """Trigger discovery for every cloud account concurrently.

        Each account that is not already scanning gets a fresh job; all jobs run
        in parallel on the event loop (bounded by the shared scan thread pool).
        """
        accounts = await self.account_repo.list_all()
        responses: list[DiscoveryTriggerResponse] = []
        for account in accounts:
            existing = await self.disco_repo.get_active_for_account(account.id)
            if existing:
                responses.append(DiscoveryTriggerResponse.model_validate(existing))
                continue
            job = await self.disco_repo.create_job(account.id)
            await self.db.commit()
            await self.db.refresh(job)
            _launch_scan(job.id, account.id)
            responses.append(DiscoveryTriggerResponse.model_validate(job))
        return responses

    async def get_job_status(self, job_id: uuid.UUID) -> DiscoveryStatusResponse | None:
        job = await self.disco_repo.get_by_id(job_id)
        if not job:
            return None
        return DiscoveryStatusResponse.model_validate(job)
