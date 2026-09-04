"""Configuration drift / change-history endpoints."""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import get_drift_service
from app.services.drift_service import CHANGE_TYPES, SEVERITIES, DriftService
from app.utils.drift_rules import ALL_PILLARS

router = APIRouter(prefix="/cloud/drift", tags=["Configuration Drift"])

# Anything outside these sets is a client bug, and silently ignoring it would
# return a full unfiltered page that looks like a valid answer.
_DIRECTIONS = ("MORE_OPEN", "MORE_RESTRICTIVE", "SCALE_UP", "SCALE_DOWN")


def _validate(name: str, value: Optional[str], allowed) -> None:
    if value is not None and value not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {name}={value!r}. Expected one of: {', '.join(allowed)}",
        )


@router.get("", response_model=Dict[str, Any])
async def list_changes(
    account_id: Optional[str] = Query(None, description="Limit to one cloud account."),
    days: int = Query(30, ge=1, le=365, description="Look-back window in days."),
    change_type: Optional[str] = Query(None, description="CREATED | MODIFIED | DELETED"),
    impact: Optional[str] = Query(
        None, description="Pillar the changed field belongs to, e.g. security, cost."
    ),
    severity: Optional[str] = Query(None, description="CRITICAL | HIGH | MEDIUM | LOW"),
    resource_type: Optional[str] = Query(None),
    provider_resource_id: Optional[str] = Query(
        None, description="One resource's history, by its provider-side id."
    ),
    direction: Optional[str] = Query(
        None, description="MORE_OPEN | MORE_RESTRICTIVE | SCALE_UP | SCALE_DOWN"
    ),
    search: Optional[str] = Query(None, description="Substring match on name, field or summary."),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    svc: DriftService = Depends(get_drift_service),
):
    """Field-level change log, newest first.

    Rows sharing a job and a resource are one scan's worth of change to that
    resource; they are returned adjacent so the caller can fold them into a
    single event without a second request.
    """
    _validate("change_type", change_type, CHANGE_TYPES)
    _validate("impact", impact, ALL_PILLARS)
    _validate("severity", severity, SEVERITIES)
    _validate("direction", direction, _DIRECTIONS)
    return await svc.list_changes(
        account_id=account_id,
        days=days,
        change_type=change_type,
        impact=impact,
        severity=severity,
        resource_type=resource_type,
        provider_resource_id=provider_resource_id,
        direction=direction,
        search=search,
        page=page,
        page_size=page_size,
    )


@router.get("/summary", response_model=Dict[str, Any])
async def drift_summary(
    account_id: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    svc: DriftService = Depends(get_drift_service),
):
    """Totals by change type, severity, pillar, resource type and day, plus the
    resources that changed most and how the window's drift overlaps with open
    alerts.

    `has_history=false` means this account has never had a second scan to
    compare against — not that nothing has changed.
    """
    return await svc.summary(account_id=account_id, days=days)


@router.get("/facets", response_model=Dict[str, Any])
async def drift_facets(
    account_id: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365),
    svc: DriftService = Depends(get_drift_service),
):
    """Filter options actually present in the log for this account and window."""
    return await svc.facets(account_id=account_id, days=days)


@router.get("/history", response_model=Dict[str, Any])
async def inventory_history(
    account_id: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    sort: str = Query("created", description="created | first_seen"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    svc: DriftService = Depends(get_drift_service),
):
    """When each resource was created, from the provider's own timestamp.

    The change log can only start from the day drift capture was switched on —
    every earlier value was overwritten by the next scan. This reaches further
    back using what is still on file: the provider's creation timestamp
    (authoritative, years of it, but not offered by every provider) alongside
    `first_seen`, which is when this system first recorded the row.

    The two are reported separately on purpose. `first_seen` shifts whenever
    scanner coverage improves, so treating it as a creation date would invent
    history that never happened.
    """
    _validate("sort", sort, ("created", "first_seen"))
    return await svc.inventory_history(
        account_id=account_id,
        resource_type=resource_type,
        search=search,
        sort=sort,
        page=page,
        page_size=page_size,
    )


@router.get("/resource/{resource_id}", response_model=Dict[str, Any])
async def resource_timeline(
    resource_id: str,
    limit: int = Query(200, ge=1, le=1000),
    svc: DriftService = Depends(get_drift_service),
):
    """One resource's full change history, its current state, and any active
    alerts against it — the cross-pillar view for a single resource."""
    result = await svc.resource_timeline(resource_id, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    return result
