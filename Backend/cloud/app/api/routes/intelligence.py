"""Cloud Resource Intelligence HTTP surface.

One router over one service. Split by question, like the Security Center's:
the summary does not pay for the list, and the list is filtered, faceted and
paged in SQL.

`POST /{account_id}/analyze` is the Intelligence tab's own "Refresh
intelligence". It reads telemetry from the provider's monitoring API, so it
needs `resources:discover` — the same permission as "Refresh all", which runs
the same analysis as its last stage — and it answers 409 while a refresh or a
discovery scan is running, because that sweep's analysis is already coming.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.optimization.model import SUPPRESSED
from app.services.intelligence_service import (
    SOURCE_OPT, SOURCE_SEC, AnalysisRunning, IntelligenceService, meta,
)

router = APIRouter(prefix="/cloud/intelligence", tags=["Resource Intelligence"])


async def get_service(db: AsyncSession = Depends(get_db)) -> IntelligenceService:
    return IntelligenceService(db)


def _csv(value: Optional[str]) -> Optional[List[str]]:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def _actor(principal: rbac.Principal) -> str:
    return principal.name or f"unauthenticated:{principal.role}"


@router.get("/meta")
async def get_meta(_: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW))) -> Dict[str, Any]:
    """Categories, statuses, thresholds, the rule catalog and what cannot be
    measured — served from the backend so the legend and the engine agree."""
    out = meta()
    out["rbac"] = rbac.rbac_summary()
    return out


@router.get("/{account_id}/summary")
async def get_summary(
    account_id: uuid.UUID,
    svc: IntelligenceService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    try:
        return await svc.summary(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{account_id}/findings")
async def list_findings(
    account_id: uuid.UUID,
    category: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    provider: Optional[str] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    source: Optional[str] = Query(None),
    signal: Optional[str] = Query(None),
    resource_id: Optional[uuid.UUID] = Query(None),
    resource_type: Optional[str] = Query(None),
    rule_id: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    has_savings: bool = Query(False),
    include_undetermined: bool = Query(False),
    sort: str = Query("severity"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    svc: IntelligenceService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    """Security and optimization findings in one list. Comma-separated values
    on every list filter. Status defaults to the active ones (Open and
    Acknowledged); pass status=RESOLVED or SUPPRESSED to see those."""
    filters = {
        "category": _csv(category), "severity": _csv(severity), "provider": _csv(provider),
        "status": _csv(status_filter) or ["OPEN", "ACKNOWLEDGED"], "source": _csv(source),
        "signal": _csv(signal), "resource_id": resource_id, "resource_type": _csv(resource_type),
        "rule_id": _csv(rule_id), "search": search, "has_savings": has_savings,
        "include_undetermined": include_undetermined,
    }
    return await svc.findings(account_id, filters, limit=limit, offset=offset, sort=sort,
                              can_view_raw=principal.can(rbac.SECURITY_VIEW_RAW))


@router.get("/{account_id}/findings/{source}/{key}")
async def get_finding(
    account_id: uuid.UUID, source: str, key: str,
    svc: IntelligenceService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    out = await svc.finding_detail(account_id, source, key,
                                   can_view_raw=principal.can(rbac.SECURITY_VIEW_RAW))
    if out is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    return out


class StatusPayload(BaseModel):
    status: str
    reason: Optional[str] = None


@router.post("/{account_id}/findings/{source}/{key}/status")
async def set_finding_status(
    account_id: uuid.UUID, source: str, key: str, payload: StatusPayload, request: Request,
    svc: IntelligenceService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.get_principal),
) -> Dict[str, Any]:
    """Acknowledge, suppress, mark resolved, or reopen.

    Permission follows the finding's engine: an optimization finding needs
    intelligence:triage (intelligence:suppress to suppress); a security finding
    keeps the Security Center's security:triage / security:suppress, so the
    unified list is not a side door around them.
    """
    if source == SOURCE_OPT:
        needed = rbac.INTELLIGENCE_SUPPRESS if payload.status == SUPPRESSED else rbac.INTELLIGENCE_TRIAGE
    elif source == SOURCE_SEC:
        needed = rbac.SECURITY_SUPPRESS if payload.status == SUPPRESSED else rbac.SECURITY_TRIAGE
    else:
        raise HTTPException(status_code=400, detail=f"Unknown source {source!r}")
    if not principal.can(needed):
        await rbac.deny(principal, needed, request)
    row, err = await svc.set_status(account_id, source, key, payload.status,
                                    payload.reason, _actor(principal))
    if err:
        raise HTTPException(status_code=404 if err == "Finding not found" else 400, detail=err)
    return row


@router.post("/{account_id}/analyze")
async def analyze(
    account_id: uuid.UUID,
    svc: IntelligenceService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_DISCOVER)),
) -> Dict[str, Any]:
    from app.repository.discovery_repo import DiscoveryRepository
    from app.services.account_refresh_service import AccountRefreshService

    if (await AccountRefreshService(svc.db).active_refresh(account_id)
            or await DiscoveryRepository(svc.db).get_active_for_account(account_id)):
        raise HTTPException(status_code=409, detail={
            "code": "account_busy",
            "message": ("A refresh or discovery scan is running for this account; it analyses "
                        "the account as its last step, and this tab updates when it finishes."),
        })
    try:
        return await svc.analyze(account_id, triggered_by=f"manual:{_actor(principal)}"[:64])
    except AnalysisRunning:
        raise HTTPException(status_code=409, detail={
            "code": "analysis_running",
            "message": "An analysis of this account is already running.",
        })
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{account_id}/resources/{resource_id}/health")
async def resource_health(
    account_id: uuid.UUID, resource_id: uuid.UUID,
    svc: IntelligenceService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    try:
        return await svc.resource_health(account_id, resource_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{account_id}/resources/{resource_id}/telemetry")
async def resource_telemetry(
    account_id: uuid.UUID, resource_id: uuid.UUID,
    svc: IntelligenceService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    try:
        return await svc.telemetry(account_id, resource_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{account_id}/coverage")
async def coverage(
    account_id: uuid.UUID,
    svc: IntelligenceService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    return await svc.coverage(account_id)


@router.get("/{account_id}/runs")
async def runs(
    account_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=100),
    svc: IntelligenceService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.INTELLIGENCE_VIEW)),
) -> Dict[str, Any]:
    return await svc.runs(account_id, limit=limit)
