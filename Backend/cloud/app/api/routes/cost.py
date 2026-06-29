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

