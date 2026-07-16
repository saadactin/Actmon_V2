"""Pydantic schemas for Discovery Job lifecycle."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class DiscoveryTriggerResponse(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    celery_task_id: Optional[str] = None
    status: str
    started_at: datetime

    model_config = {"from_attributes": True}


class DiscoveryStatusResponse(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    status: str
    resources_found: Optional[int] = None
    error_message: Optional[str] = Field(None, validation_alias="error_detail")
    started_at: datetime
    completed_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
