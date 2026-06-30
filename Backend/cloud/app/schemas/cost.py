"""Pydantic schemas for Cost data."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class CostEntry(BaseModel):
    resource_type: str
    resource_name: str
    region: str
    monthly_cost: float
    currency: str = "USD"
    extra: Optional[Dict[str, Any]] = None


class CostSummaryResponse(BaseModel):
    account_id: str
    provider: str
    total_monthly_cost: float
    currency: str = "USD"
    breakdown: List[CostEntry] = []
