"""Pydantic schemas for Cloud Resource responses."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel


class CloudResourceResponse(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    provider_resource_id: str
    resource_type: str
    resource_name: str
    region_or_zone: str
    status: Optional[str] = None
    ip_address: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    metadata_: Optional[Dict[str, Any]] = None
    cost_monthly: Optional[float] = None
    tags: Optional[Dict[str, Any]] = None
    discovered_at: datetime

    model_config = {"from_attributes": True}


class CloudResourceDetail(CloudResourceResponse):
    raw_data: Optional[Dict[str, Any]] = None
