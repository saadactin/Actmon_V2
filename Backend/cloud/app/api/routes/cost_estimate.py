"""Cost estimate routes — config-based cost approximation."""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.services.cost_service import estimate_costs

router = APIRouter(prefix="/cloud/cost-estimate", tags=["Cost Estimate"])


@router.get("/{account_id}")
async def get_cost_estimate(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Return config-based monthly cost estimates for all resources in an account."""
    return await estimate_costs(account_id, db)
