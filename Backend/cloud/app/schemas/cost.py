"""Pydantic schemas for Cost data."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class CostEntry(BaseModel):
    resource_type: str
    resource_name: str
    region: Optional[str] = None
    monthly_cost: float
    # Currency comes from the provider billing API; None means unknown (UI shows NA)
    currency: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


class CostSummaryResponse(BaseModel):
    account_id: str
    provider: Optional[str] = None
    # None means no billing data is available for this account (UI shows NA)
    total_monthly_cost: Optional[float] = None
    currency: Optional[str] = None
    cost_source: Optional[str] = None
    breakdown: List[CostEntry] = []
