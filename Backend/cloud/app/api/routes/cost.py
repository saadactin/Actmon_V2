"""Cost data routes.

Every route here now carries an explicit authorization dependency. Cost was
previously the largest unauthenticated read surface in the service: an
itemized, per-resource, per-day ledger of the entire estate was reachable with
no token at all. That is unchanged in practice while `CLOUD_RBAC_ENFORCE` is
off — the default principal still gets everything, exactly as the Event Log,
Topology and Security Center routes behave — but the permissions are now
declared, refusals are audited, and turning enforcement on is a one-line
change rather than a code change.

`account_id` is `"ALL"` or a UUID on every route except `/{account_id}`, which
predates the multi-account views and remains UUID-only.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api import rbac
from app.api.deps import get_cost_service
from app.schemas.cost import CostSummaryResponse
from app.services.cost_service import CostService

router = APIRouter(prefix="/cloud/cost", tags=["Cost"])


@router.get("/capabilities/{account_id}")
async def get_cost_capabilities(
    account_id: str,
    svc: CostService = Depends(get_cost_service),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """What the providers in scope can and cannot answer about cost.

    This is what lets the UI DISABLE a control with a real explanation instead
    of rendering an unanswerable question as a confident zero. The canonical
    case: grouping by resource is genuinely impossible for AWS through Cost
    Explorer, so selecting it must be blocked and the tooltip must say CUR is
    required — not return an empty table that reads as "AWS costs nothing".
    """
    return await svc.get_capabilities(account_id)


@router.get("/quality/{account_id}")
async def get_cost_quality(
    account_id: str,
    svc: CostService = Depends(get_cost_service),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """Data-quality and freshness for the scope: which accounts are failing and
    why, how old each dataset is, and whether any figure shown is stale.

    Backs the page-level quality badge and the diagnostics modal. Kept separate
    from the cost payloads so the badge can render immediately without waiting
    on a billing round trip.
    """
    return await svc.get_quality(account_id)


@router.get("/{account_id}", response_model=CostSummaryResponse)
async def get_cost_summary(
    account_id: uuid.UUID,
    svc: CostService = Depends(get_cost_service),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
):
    """Retrieve the last 30-day cost breakdown for a cloud account."""
    return await svc.get_cost_summary(account_id)


@router.get("/analytics/{account_id}")
async def get_cost_analytics(
    account_id: str,
    svc: CostService = Depends(get_cost_service),
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
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
    _: rbac.Principal = Depends(rbac.require(rbac.COST_VIEW)),
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

