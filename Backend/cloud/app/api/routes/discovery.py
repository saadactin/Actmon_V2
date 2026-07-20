"""Discovery trigger and status routes."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status

from app.api.deps import get_discovery_service
from app.schemas.discovery import DiscoveryStatusResponse, DiscoveryTriggerResponse
from app.services.discovery_service import DiscoveryService

router = APIRouter(prefix="/cloud/discovery", tags=["Discovery"])


# Declared before "/{account_id}" so the literal path is not swallowed by the
# UUID path parameter.
@router.post("/scan-all", response_model=list[DiscoveryTriggerResponse], status_code=202)
async def trigger_discovery_all(
    svc: DiscoveryService = Depends(get_discovery_service),
):
    """Trigger a discovery scan for every cloud account, running concurrently."""
    return await svc.trigger_scan_all()


@router.post("/{account_id}", response_model=DiscoveryTriggerResponse, status_code=202)
async def trigger_discovery(
    account_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    svc: DiscoveryService = Depends(get_discovery_service),
):
    """Trigger a background resource discovery scan for the given cloud account."""
    return await svc.trigger_scan(account_id, background_tasks)


@router.get("/status/{job_id}", response_model=DiscoveryStatusResponse)
async def get_discovery_status(
    job_id: uuid.UUID,
    svc: DiscoveryService = Depends(get_discovery_service),
):
    """Poll the status of a discovery job."""
    job = await svc.get_job_status(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    return job
