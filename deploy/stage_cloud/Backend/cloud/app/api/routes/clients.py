"""Clients, the portfolio view, organisation onboarding and client reports.

Route order matters here the same way it does in main.py: the literal paths
(`/portfolio`, `/options`, `/onboarding/...`) are declared before `/{client_id}`
so a literal segment is never parsed as a UUID.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.rbac import Principal
from app.core.database import get_db
from app.schemas.client import (
    AssignAccountsIn, ClientIn, ClientPatch, GenerateReportIn, OnboardIn,
    OrgCredentialsIn, ReportScheduleIn,
)
from app.services.client_service import ClientError, ClientService
from app.services.onboarding_service import OnboardingError, OnboardingService

router = APIRouter(prefix="/cloud/clients", tags=["Clients"])


def _raise(exc: Exception) -> None:
    status = getattr(exc, "status", 400)
    raise HTTPException(status_code=status, detail=str(exc)) from exc


# ── Literal paths first ─────────────────────────────────────────────────────
@router.get("/portfolio")
async def portfolio(db: AsyncSession = Depends(get_db),
                    _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))) -> Dict[str, Any]:
    """Every client side by side, plus the unassigned accounts."""
    return await ClientService(db).portfolio()


@router.get("/options")
async def client_options(db: AsyncSession = Depends(get_db),
                         _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    """Id, name and code of every client — for pickers."""
    return {"clients": await ClientService(db).list_simple()}


@router.post("/onboarding/discover")
async def onboarding_discover(
    payload: OrgCredentialsIn,
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(rbac.require(rbac.CLIENT_ONBOARD)),
) -> Dict[str, Any]:
    """List an AWS organisation's accounts or an Azure tenant's subscriptions,
    each probed for access. Stores nothing."""
    try:
        return await OnboardingService(db).discover(payload)
    except OnboardingError as exc:
        _raise(exc)


@router.post("/onboarding/onboard")
async def onboarding_onboard(
    payload: OnboardIn,
    db: AsyncSession = Depends(get_db),
    principal: Principal = Depends(rbac.require(rbac.CLIENT_ONBOARD)),
) -> Dict[str, Any]:
    """Create one cloud account per chosen member."""
    try:
        return await OnboardingService(db).onboard(payload, actor=principal.name)
    except OnboardingError as exc:
        _raise(exc)


@router.get("")
async def list_clients(db: AsyncSession = Depends(get_db),
                       _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    return {"clients": await ClientService(db).list_simple()}


@router.post("", status_code=201)
async def create_client(payload: ClientIn, db: AsyncSession = Depends(get_db),
                        principal: Principal = Depends(rbac.require(rbac.CLIENT_MANAGE))):
    try:
        client = await ClientService(db).create(payload.model_dump(), actor=principal.name)
    except ClientError as exc:
        _raise(exc)
    return client.to_dict()


# ── One client ──────────────────────────────────────────────────────────────
@router.get("/{client_id}")
async def get_client(client_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                     _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    try:
        return await ClientService(db).detail(client_id)
    except ClientError as exc:
        _raise(exc)


@router.patch("/{client_id}")
async def update_client(client_id: uuid.UUID, payload: ClientPatch,
                        db: AsyncSession = Depends(get_db),
                        _: Principal = Depends(rbac.require(rbac.CLIENT_MANAGE))):
    try:
        client = await ClientService(db).update(
            client_id, payload.model_dump(exclude_unset=True))
    except ClientError as exc:
        _raise(exc)
    return client.to_dict()


@router.delete("/{client_id}")
async def delete_client(client_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                        _: Principal = Depends(rbac.require(rbac.CLIENT_MANAGE))):
    """Deletes the client, its report schedule and report history. Its accounts
    are unassigned, never deleted."""
    try:
        return await ClientService(db).delete(client_id)
    except ClientError as exc:
        _raise(exc)


@router.put("/{client_id}/accounts")
async def assign_accounts(client_id: uuid.UUID, payload: AssignAccountsIn,
                          db: AsyncSession = Depends(get_db),
                          _: Principal = Depends(rbac.require(rbac.CLIENT_MANAGE))):
    """Assign accounts to this client. An account already assigned elsewhere
    is MOVED, and the response lists each move."""
    try:
        return await ClientService(db).assign_accounts(client_id, payload.account_ids)
    except ClientError as exc:
        _raise(exc)


@router.delete("/{client_id}/accounts/{account_id}")
async def unassign_account(client_id: uuid.UUID, account_id: uuid.UUID,
                           db: AsyncSession = Depends(get_db),
                           _: Principal = Depends(rbac.require(rbac.CLIENT_MANAGE))):
    try:
        return await ClientService(db).unassign_account(client_id, account_id)
    except ClientError as exc:
        _raise(exc)


# ── Reports ─────────────────────────────────────────────────────────────────
@router.get("/{client_id}/report-schedule")
async def get_report_schedule(client_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                              _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    from app.services.client_report_service import ClientReportService

    try:
        return await ClientReportService(db).get_schedule(client_id)
    except ClientError as exc:
        _raise(exc)


@router.put("/{client_id}/report-schedule")
async def put_report_schedule(client_id: uuid.UUID, payload: ReportScheduleIn,
                              db: AsyncSession = Depends(get_db),
                              principal: Principal = Depends(
                                  rbac.require(rbac.REPORT_MANAGE))):
    from app.services.client_report_service import ClientReportService

    try:
        return await ClientReportService(db).save_schedule(
            client_id, payload.model_dump(), actor=principal.name)
    except ClientError as exc:
        _raise(exc)


@router.get("/{client_id}/reports")
async def list_reports(client_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                       limit: int = Query(24, ge=1, le=100),
                       _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    from app.services.client_report_service import ClientReportService

    try:
        return await ClientReportService(db).list_reports(client_id, limit=limit)
    except ClientError as exc:
        _raise(exc)


@router.get("/{client_id}/report-preview")
async def report_preview(client_id: uuid.UUID,
                         period: Optional[str] = Query(None),
                         db: AsyncSession = Depends(get_db),
                         _: Principal = Depends(rbac.require(rbac.REPORT_EXPORT))):
    """The numbers a report for `period` would be built from, as JSON."""
    from app.services.client_report_service import ClientReportService

    try:
        return await ClientReportService(db).preview(client_id, period)
    except ClientError as exc:
        _raise(exc)


@router.post("/{client_id}/reports", status_code=201)
async def generate_report(client_id: uuid.UUID, payload: GenerateReportIn, request: Request,
                          db: AsyncSession = Depends(get_db),
                          principal: Principal = Depends(rbac.require(rbac.REPORT_EXPORT))):
    from app.services.client_report_service import ClientReportService

    if payload.send and not principal.can(rbac.REPORT_MANAGE):
        # Sending decides whose inbox this writes to, so it needs the manage
        # permission. Checked in the handler because it depends on a body
        # field, and refused through rbac.deny so the refusal is audited.
        await rbac.deny(principal, rbac.REPORT_MANAGE, request)
    try:
        return await ClientReportService(db).generate(
            client_id, payload.period, send=payload.send, actor=principal.name)
    except ClientError as exc:
        _raise(exc)


@router.get("/{client_id}/reports/{report_id}/pdf")
async def download_report(client_id: uuid.UUID, report_id: uuid.UUID,
                          db: AsyncSession = Depends(get_db),
                          _: Principal = Depends(rbac.require(rbac.REPORT_EXPORT))):
    from app.services.client_report_service import ClientReportService

    try:
        filename, pdf = await ClientReportService(db).pdf(client_id, report_id)
    except ClientError as exc:
        _raise(exc)
    return Response(content=pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "no-store",
    })


@router.post("/{client_id}/reports/{report_id}/send")
async def send_report(client_id: uuid.UUID, report_id: uuid.UUID,
                      db: AsyncSession = Depends(get_db),
                      principal: Principal = Depends(rbac.require(rbac.REPORT_MANAGE))):
    from app.services.client_report_service import ClientReportService

    try:
        return await ClientReportService(db).send(client_id, report_id, actor=principal.name)
    except ClientError as exc:
        _raise(exc)


@router.get("/{client_id}/scorecard")
async def client_scorecard(client_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                           _: Principal = Depends(rbac.require(rbac.CLIENT_VIEW))):
    """The FinOps maturity scorecard for every account under one client.

    A domain-grouped, Crawl/Walk/Run read of `finops_health` (see
    cost_allocation_service), scoped to this client rather than one account
    or every account -- the natural unit for an MSP handing a customer their
    own report. Also records (at most once per day) and returns the trend.
    """
    from app.services.cost_service import CostService

    try:
        return await CostService(db).get_client_governance(client_id)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise(exc)
