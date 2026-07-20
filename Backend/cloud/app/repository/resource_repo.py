"""Repository for Cloud Resource CRUD operations."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource


class ResourceRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def upsert_resources(
        self, account_id: uuid.UUID, resources: List[Dict[str, Any]]
    ) -> int:
        """Insert or update resources for an account. Returns count saved."""
        def clean_json(val: Any) -> Any:
            import datetime
            if isinstance(val, dict):
                return {k: clean_json(v) for k, v in val.items()}
            elif isinstance(val, list):
                return [clean_json(v) for v in val]
            elif isinstance(val, (datetime.datetime, datetime.date)):
                return val.isoformat()
            elif isinstance(val, uuid.UUID):
                return str(val)
            return val

        # Fetch existing resource IDs to detect updates vs inserts
        existing_result = await self.db.execute(
            select(CloudResource.provider_resource_id, CloudResource.id).where(
                CloudResource.account_id == account_id
            )
        )
        existing = {row[0]: row[1] for row in existing_result}

        count = 0
        for r in resources:
            provider_rid = r.get("provider_resource_id", "")
            if provider_rid in existing:
                # Update
                resource = await self.db.get(CloudResource, existing[provider_rid])
                if resource:
                    resource.resource_type = r.get("resource_type", resource.resource_type)
                    resource.resource_name = r.get("resource_name", resource.resource_name)
                    resource.region_or_zone = r.get("region_or_zone", resource.region_or_zone)
                    resource.status = r.get("status")
                    resource.ip_address = r.get("ip_address")
                    resource.config = clean_json(r.get("config"))
                    resource.metadata_ = clean_json(r.get("metadata"))
                    resource.cost_monthly = r.get("cost_monthly")
                    resource.tags = clean_json(r.get("tags"))
                    resource.raw_data = clean_json(r.get("raw_data"))
            else:
                # Insert
                obj = CloudResource(
                    account_id=account_id,
                    provider_resource_id=provider_rid,
                    resource_type=r.get("resource_type", "Unknown"),
                    resource_name=r.get("resource_name", ""),
                    region_or_zone=r.get("region_or_zone", ""),
                    status=r.get("status"),
                    ip_address=r.get("ip_address"),
                    config=clean_json(r.get("config")),
                    metadata_=clean_json(r.get("metadata")),
                    cost_monthly=r.get("cost_monthly"),
                    tags=clean_json(r.get("tags")),
                    raw_data=clean_json(r.get("raw_data")),
                )
                self.db.add(obj)
            count += 1

        await self.db.flush()
        return count

    async def list_by_account(self, account_id: uuid.UUID) -> List[CloudResource]:
        result = await self.db.execute(
            select(CloudResource)
            .where(CloudResource.account_id == account_id)
            .order_by(CloudResource.resource_type, CloudResource.resource_name)
        )
        return list(result.scalars().all())

    async def get_by_id(self, resource_id: uuid.UUID) -> Optional[CloudResource]:
        return await self.db.get(CloudResource, resource_id)

    async def list_all(self) -> List[CloudResource]:
        result = await self.db.execute(
            select(CloudResource)
            .order_by(CloudResource.resource_type, CloudResource.resource_name)
        )
        return list(result.scalars().all())

    async def delete_by_account(self, account_id: uuid.UUID) -> None:
        await self.db.execute(
            delete(CloudResource).where(CloudResource.account_id == account_id)
        )
        await self.db.flush()

    async def count_by_account(self, account_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(CloudResource).where(
                CloudResource.account_id == account_id
            )
        )
        return result.scalar_one()

    async def delete_stale(
        self, account_id: uuid.UUID, keep_provider_ids: List[str]
    ) -> int:
        """Delete this account's resources whose provider_resource_id is NOT in
        keep_provider_ids — i.e. rows from a previous scan that no longer exist.
        Used after an incremental scan to prune what wasn't re-seen. Returns rows deleted."""
        stmt = delete(CloudResource).where(CloudResource.account_id == account_id)
        if keep_provider_ids:
            stmt = stmt.where(
                CloudResource.provider_resource_id.notin_(list(keep_provider_ids))
            )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.rowcount or 0

