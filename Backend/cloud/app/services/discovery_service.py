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

    task = asyncio.create_task(run_discovery_scan(job_id, account_id),
                               name=f"discovery:{job_id}")
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

    async def latest_for_account(self, account_id: uuid.UUID) -> dict:
        """The last run, the last SUCCESSFUL run, and what that run changed.

        The change counts come from the drift log, joined on the job id that
        wrote them — they are not recomputed here and not estimated. A run that
        predates drift capture has no rows, which is reported as "not recorded"
        rather than as three zeros: a sweep that genuinely changed nothing and a
        sweep nobody was recording look identical in a count, and only one of
        them means the estate was stable.
        """
        latest = await self.disco_repo.get_latest_for_account(account_id)
        last_ok = await self.disco_repo.get_latest_for_account(
            account_id, status="COMPLETED"
        )

        def describe(job) -> dict | None:
            if job is None:
                return None
            duration_ms = None
            if job.started_at and job.completed_at:
                duration_ms = int(
                    (job.completed_at - job.started_at).total_seconds() * 1000
                )
            return {
                "id": str(job.id),
                "status": job.status,
                "resources_found": job.resources_found,
                "error_detail": job.error_detail,
                "started_at": job.started_at.isoformat() if job.started_at else None,
                "completed_at": (
                    job.completed_at.isoformat() if job.completed_at else None
                ),
                "duration_ms": duration_ms,
            }

        changes = None
        if last_ok is not None:
            counted = await self.disco_repo.change_counts_for_job(last_ok.id)
            # None, not {}, when the run recorded nothing at all — see above.
            changes = counted or None

        return {
            "account_id": str(account_id),
            "latest": describe(latest),
            "last_successful": describe(last_ok),
            # True when the most recent attempt failed but an older one
            # succeeded: the inventory is real, it is just older than it looks.
            "last_attempt_failed": bool(
                latest is not None
                and latest.status == "FAILED"
                and (last_ok is None or last_ok.id != latest.id)
            ),
            "changes": changes,
        }
