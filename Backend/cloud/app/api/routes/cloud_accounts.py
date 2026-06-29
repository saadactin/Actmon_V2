"""Cloud Account CRUD routes."""
from __future__ import annotations

import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_account_service
from app.schemas.cloud_account import CloudAccountCreate, CloudAccountResponse
from app.services.cloud_account_service import CloudAccountService

router = APIRouter(prefix="/cloud/accounts", tags=["Cloud Accounts"])


@router.post("", response_model=CloudAccountResponse, status_code=status.HTTP_201_CREATED)
async def create_cloud_account(
    payload: CloudAccountCreate,
    svc: CloudAccountService = Depends(get_account_service),
):
    """Register a new cloud provider account with encrypted credentials."""
    return await svc.create_account(payload)


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


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cloud_account(
    account_id: uuid.UUID,
    svc: CloudAccountService = Depends(get_account_service),
):
    deleted = await svc.delete_account(account_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Account not found")
