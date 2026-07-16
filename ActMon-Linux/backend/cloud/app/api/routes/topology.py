"""Topology API routes."""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.services.topology_service import get_topology

router = APIRouter(prefix="/cloud/topology", tags=["Topology"])


@router.get("/{account_id}")
async def get_account_topology(
    account_id: str,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """
    Return nodes and edges representing the dependency graph of cloud resources.
    Pass account_id = 'ALL' to retrieve a unified graph of all cloud accounts.
    """
    return await get_topology(account_id, db)
