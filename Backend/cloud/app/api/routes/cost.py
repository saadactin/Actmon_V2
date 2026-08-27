"""Cost data routes."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

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
    region: Optional[str] = None,
    service: Optional[str] = None,
    resource_type: Optional[str] = None,
    cost_component: Optional[str] = None,
    status: Optional[str] = None,
    min_cost: Optional[float] = None,
    max_cost: Optional[float] = None,
    dimensions: Optional[str] = Query(default=None, description="Comma-separated, only used when group_by=summary"),
    page: Optional[int] = None,
    page_size: Optional[int] = None,
    svc: CostService = Depends(get_cost_service),
):
    """Real cost ledger for the given lookback window (clamped to 365 days) —
    the data source for the downloadable cost report and the Cost Explorer.

    group_by=service  → one row per day per service.
    group_by=resource → one row per billed resource, totalled over the window,
                        with its name, type, size, cost component, and
                        attachment from inventory.
    group_by=summary  → the resource rows reduced to one row per unique
                        combination of `dimensions` (e.g. "service" or
                        "service,resource_type"), each with resource_count and
                        a cost total per component.

    The region/service/resource_type/cost_component/status/min_cost/max_cost
    filters apply to every group_by mode. page/page_size are opt-in — omit
    both to get every matching row, unchanged from before pagination existed.
    """
    if group_by not in ("service", "resource", "summary"):
        raise HTTPException(status_code=400, detail="group_by must be 'service', 'resource', or 'summary'")
    return await svc.get_cost_report(
        account_id, days, group_by,
        region=region, service=service, resource_type=resource_type,
        cost_component=cost_component, status=status,
        min_cost=min_cost, max_cost=max_cost,
        dimensions=dimensions, page=page, page_size=page_size,
    )

