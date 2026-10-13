"""Certificates, secrets and keys.

Reads are `security:view`, like the rest of the Security Center: the inventory
is metadata (names, dates, rotation settings), never a secret value.
Collecting on demand calls every provider store again, so it is gated like
discovery (`resources:discover`).
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.rbac import Principal
from app.core.database import get_db
from app.models.cloud_account import CloudAccount
from app.models.credential_inventory import KINDS
from app.services.credential_service import CredentialService

router = APIRouter(prefix="/cloud/certificates", tags=["Certificates & Secrets"])


def _kinds(raw: Optional[str]) -> Optional[List[str]]:
    if not raw:
        return None
    wanted = [k.strip().upper() for k in raw.split(",") if k.strip()]
    bad = [k for k in wanted if k not in KINDS]
    if bad:
        raise HTTPException(status_code=400,
                            detail=f"Unknown kind(s) {bad}. Known: {', '.join(KINDS)}")
    return wanted


@router.get("")
async def estate(
    client_id: Optional[uuid.UUID] = Query(None, description="Only this client's accounts"),
    unassigned: bool = Query(False, description="Only accounts with no client"),
    within_days: int = Query(90, ge=0, le=730),
    kind: Optional[str] = Query(None, description="CERTIFICATE,SECRET,KEY"),
    include_no_expiry: bool = Query(False),
    include_replaced: bool = Query(False, description="Also list expired certificates "
                                   "already replaced by a renewal and no longer used"),
    db: AsyncSession = Depends(get_db),
    _: Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """What expires across the estate — or one client's — soonest first."""
    account_ids = None
    if client_id or unassigned:
        stmt = select(CloudAccount.id)
        stmt = (stmt.where(CloudAccount.client_id == client_id) if client_id
                else stmt.where(CloudAccount.client_id.is_(None)))
        account_ids = list((await db.execute(stmt)).scalars().all())
    out = await CredentialService(db).estate_view(
        account_ids=account_ids, within_days=within_days, kinds=_kinds(kind),
        include_no_expiry=include_no_expiry, include_replaced=include_replaced)
    out["client_id"] = str(client_id) if client_id else None
    return out


@router.get("/{account_id}")
async def account_certificates(account_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                               _: Principal = Depends(rbac.require(rbac.SECURITY_VIEW))):
    try:
        return await CredentialService(db).account_view(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{account_id}/collect")
async def collect_now(account_id: uuid.UUID, db: AsyncSession = Depends(get_db),
                      _: Principal = Depends(rbac.require(rbac.RESOURCE_DISCOVER))):
    """Re-read every certificate / secret / key store, then re-run the security
    assessment so findings and compliance reflect it immediately.

    The assessment is told the inventory sweep was complete only if the last
    discovery was — collecting certificates says nothing about the rest.
    """
    svc = CredentialService(db)
    try:
        out = await svc.collect(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    from app.services.security_center_service import SecurityCenterService

    # The sweep's completeness (and what it read) comes from the latest
    # finished discovery job, which assess() reads when not told.
    try:
        result = await SecurityCenterService(db).assess(
            account_id, triggered_by="certificates:collect")
        out["assessment"] = {"outcome": result["outcome"], "score": result["score"],
                             "findings": result["findings"]}
    except Exception as exc:  # noqa: BLE001 — the collection itself succeeded
        out["assessment"] = {"error": str(exc)[:400]}
    return out
