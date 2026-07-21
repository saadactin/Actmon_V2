"""Service layer for resource retrieval and inventory queries."""
from __future__ import annotations

import uuid
from typing import List

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.resource_repo import ResourceRepository
from app.schemas.resource import CloudResourceDetail, CloudResourceResponse


class ResourceService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = ResourceRepository(db)

    async def list_resources(self, account_id: uuid.UUID) -> List[CloudResourceResponse]:
        resources = await self.repo.list_by_account(account_id)
        return [CloudResourceResponse.model_validate(r) for r in resources]

    async def list_all_resources(self) -> List[CloudResourceResponse]:
        resources = await self.repo.list_all()
        return [CloudResourceResponse.model_validate(r) for r in resources]

    async def get_resource_detail(self, resource_id: uuid.UUID) -> CloudResourceDetail | None:
        resource = await self.repo.get_by_id(resource_id)
        if not resource:
            return None
        return CloudResourceDetail.model_validate(resource)

