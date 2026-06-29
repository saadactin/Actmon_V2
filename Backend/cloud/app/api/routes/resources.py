"""Resource inventory routes — list and drill-down."""
from __future__ import annotations

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_resource_service, get_db
from app.schemas.resource import CloudResourceDetail, CloudResourceResponse
from app.services.resource_service import ResourceService

router = APIRouter(prefix="/cloud/resources", tags=["Resources"])



# NOTE: /detail/{resource_id} MUST be declared before /{account_id}
# to prevent FastAPI matching "detail" as an account_id UUID (which fails)
@router.get("/detail/{resource_id}", response_model=CloudResourceDetail)
async def get_resource_detail(
    resource_id: uuid.UUID,
    svc: ResourceService = Depends(get_resource_service),
):
    """Return full configuration, metadata, and raw data for a single resource."""
    resource = await svc.get_resource_detail(resource_id)
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")
    return resource


@router.get("/detail/{resource_id}/metrics")
async def get_resource_metrics(
    resource_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Return historical performance metrics for a single resource."""
    from app.services.metrics_service import get_resource_metrics as fetch_metrics
    metrics = await fetch_metrics(resource_id, db)
    if "error" in metrics:
        raise HTTPException(status_code=404, detail=metrics["error"])
    return metrics




@router.get("/", response_model=List[CloudResourceResponse])
async def list_all_resources(
    svc: ResourceService = Depends(get_resource_service),
):
    """Return the full resource inventory across all cloud accounts."""
    return await svc.list_all_resources()


@router.get("/{account_id}", response_model=List[CloudResourceResponse])
async def list_resources(
    account_id: uuid.UUID,
    svc: ResourceService = Depends(get_resource_service),
):
    """Return the full resource inventory for a cloud account."""
    return await svc.list_resources(account_id)

