from typing import Any, Dict
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.services.compliance_service import generate_compliance_report

router = APIRouter(prefix="/cloud/compliance", tags=["Compliance"])

@router.get("/{account_id}", response_model=Dict[str, Any])
async def get_compliance(account_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Get the compliance mapping (SOC2/HIPAA/PCI) for an account."""
    try:
        report = await generate_compliance_report(account_id, db)
        return report
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate compliance report: {e}"
        )
