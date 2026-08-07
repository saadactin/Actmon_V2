"""Cloud Account CRUD routes."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_account_service, get_resource_service
from app.schemas.cloud_account import CloudAccountCreate, CloudAccountResponse
from app.services.cloud_account_service import CloudAccountService
from app.services.resource_service import ResourceService

router = APIRouter(prefix="/cloud/accounts", tags=["Cloud Accounts"])


@router.post("", response_model=CloudAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_cloud_account(
    payload: CloudAccountCreate,
    svc: CloudAccountService = Depends(get_account_service),
):
    """Register a new cloud provider account with encrypted credentials.

    Credentials are verified against the provider first; invalid keys are
    rejected with 400 instead of being stored.
    """
    try:
        return await svc.create_account(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("", response_model=List[CloudAccountResponse])
async def list_cloud_accounts(
    svc: CloudAccountService = Depends(get_account_service),
):
    """List all registered cloud accounts (credentials are never returned)."""
    return await svc.list_accounts()


@router.get("/{account_id}", response_model=CloudAccountResponse)
async def get_cloud_account(
    account_id: uuid.UUID,
    svc: CloudAccountService = Depends(get_account_service),
):
    account = await svc.get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")
    return account


@router.get("/{account_id}/diagnostics")
async def get_account_diagnostics(
    account_id: uuid.UUID,
    svc: CloudAccountService = Depends(get_account_service),
    res_svc: ResourceService = Depends(get_resource_service),
) -> Dict[str, Any]:
    """Why this account's cost and/or resources look the way they do — real
    reasons (credentials, permissions, network, no data, scan status), never
    a guess. Backs the "why is this NA/empty" popup on Cost and Resources."""
    account = await svc.get_account(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    from app.services.cost_service import get_cost_diagnostic

    return {
        "account_id": str(account_id),
        "account_name": account.account_name,
        "provider": account.provider,
        "cost": get_cost_diagnostic(account_id),
        "resources": await res_svc.get_scan_diagnostic(account_id),
    }


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cloud_account(
    account_id: uuid.UUID,
    svc: CloudAccountService = Depends(get_account_service),
):
    deleted = await svc.delete_account(account_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Account not found")
