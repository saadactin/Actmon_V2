"""Security posture analysis routes."""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.services.security_service import run_security_scan

router = APIRouter(prefix="/cloud/security", tags=["Security"])


@router.get("/{account_id}")
async def get_security_posture(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """Run security posture scan against stored resources for an account."""
    return await run_security_scan(account_id, db)
