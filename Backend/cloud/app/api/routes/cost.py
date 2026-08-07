"""Cost data routes."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends

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
    svc: CostService = Depends(get_cost_service),
):
    """Real day-by-day, per-service cost ledger for the given lookback window
    (clamped to 365 days) — the data source for the downloadable cost report."""
    return await svc.get_cost_report(account_id, days)

