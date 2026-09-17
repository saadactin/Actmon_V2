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
    # The provider's own word is `status`; this is what we make of it. Both
    # travel, because the detail page was tinting the raw value on a guess --
    # anything it did not recognise as running went red, which painted every
    # Azure resource reporting "Succeeded" as failed. Additive, so the legacy
    # array consumers (topology, drift, the account dashboard) are unaffected.
    normalized_status: Optional[str] = None
    status_reason: Optional[str] = None
    ip_address: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    metadata_: Optional[Dict[str, Any]] = None
    cost_monthly: Optional[float] = None
    tags: Optional[Dict[str, Any]] = None
    discovered_at: datetime

    model_config = {"from_attributes": True}


class CloudResourceDetail(CloudResourceResponse):
    raw_data: Optional[Dict[str, Any]] = None
