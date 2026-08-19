"""Security posture analysis routes."""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository
from app.services.security_service import run_security_scan
from app.services.exposure_service import compute_exposure
from app.services.iam_review_service import compute_iam_review

router = APIRouter(prefix="/cloud/security", tags=["Security"])


@router.get("/{account_id}")
async def get_security_posture(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Run security posture scan against stored resources for an account."""
    return await run_security_scan(account_id, db)


@router.get("/{account_id}/exposure")
async def get_internet_exposure(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Which compute resources are actually reachable from the public internet,
    on which ports, and through which security rule — not just "has a public
    IP" (nearly every account has some) or "a rule looks permissive" (meaningless
    if nothing is behind it). See app/services/exposure_service.py for the exact
    per-provider evaluation and its stated limitations."""
    repo = ResourceRepository(db)
    resources = await repo.list_by_account(account_id)
    report = compute_exposure(resources)
    return {"account_id": str(account_id), **report}


@router.get("/{account_id}/iam-review")
async def get_iam_review(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Identities ranked by how much they can reach on how little justification
    — wildcard IAM grants (AWS) and tenancy-wide policy statements (OCI), plus
    which ones could modify identity/policy themselves (privilege escalation).
    Azure is reported with not_scanned=true: RBAC assignments aren't collected
    yet, so this never fabricates an "Azure looks fine" verdict."""
    account_repo = CloudAccountRepository(db)
    account = await account_repo.get_by_id(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    resource_repo = ResourceRepository(db)
    resources = await resource_repo.list_by_account(account_id)
    report = compute_iam_review(resources, account.provider)
    return {"account_id": str(account_id), "account_name": account.account_name, **report}
