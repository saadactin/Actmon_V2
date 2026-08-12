"""Cost data routes."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_cost_service
from app.schemas.cost import CostSummaryResponse
from app.services.cost_service import CostService

router = APIRouter(prefix="/cloud/cost", tags=["Cost"])


@router.get("/{account_id}", response_model=CostSummaryResponse)
async def get_cost_summary(
    account_id: uuid.UUID,
    svc: CostService = Depends(get_cost_service),
):
    """Retrieve the last 30-day cost breakdown for a cloud account."""
    return await svc.get_cost_summary(account_id)


@router.get("/analytics/{account_id}")
async def get_cost_analytics(
    account_id: str,
    svc: CostService = Depends(get_cost_service),
):
    """Retrieve the 30-day growth, cost trends, and optimization suggestions."""
    return await svc.get_cost_analytics(account_id)


@router.get("/report/{account_id}")
async def get_cost_report(
    account_id: str,
    days: int = 30,
    group_by: str = "service",
    svc: CostService = Depends(get_cost_service),
):
    """Real cost ledger for the given lookback window (clamped to 365 days) —
    the data source for the downloadable cost report.

    group_by=service  → one row per day per service.
    group_by=resource → one row per billed resource, totalled over the window,
                        with its name, type, size and attachment from inventory.
    """
    if group_by not in ("service", "resource"):
        raise HTTPException(status_code=400, detail="group_by must be 'service' or 'resource'")
    return await svc.get_cost_report(account_id, days, group_by)

