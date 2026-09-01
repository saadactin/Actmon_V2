"""Repository for Cloud Resource CRUD operations."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource
from app.repository.drift_repo import DriftRepository
from app.utils.drift_rules import describe_creation, describe_deletion, diff_resource


class ResourceRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def upsert_resources(
        self,
        account_id: uuid.UUID,
        resources: List[Dict[str, Any]],
        *,
        drift_job_id: Optional[uuid.UUID] = None,
    ) -> int:
        """Insert or update resources for an account. Returns count saved.

        When `drift_job_id` is given, every tracked field that moved is appended
        to the configuration-change log before the row is overwritten - this is
        the only moment the previous value still exists, since the inventory
        table holds current state only.

        Callers pass None to skip that, which is what establishes an account's
        baseline: the first sweep of a brand-new account is not 1,500 "created"
        events, it is simply what was already there.
        """
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

        drift_repo = DriftRepository(self.db) if drift_job_id else None

        count = 0
        for r in resources:
            provider_rid = r.get("provider_resource_id", "")
            if provider_rid in existing:
                # Update
                resource = await self.db.get(CloudResource, existing[provider_rid])
                if resource:
                    # Diff BEFORE the assignments below overwrite the old values.
                    if drift_repo is not None:
                        changes = diff_resource(resource, r)
                        if changes:
                            await drift_repo.record(
                                account_id,
                                drift_job_id,
                                {
                                    "resource_id": resource.id,
                                    "provider_resource_id": provider_rid,
                                    "resource_type": r.get("resource_type") or resource.resource_type,
                                    "resource_name": r.get("resource_name") or resource.resource_name,
                                    "region_or_zone": r.get("region_or_zone") or resource.region_or_zone,
                                },
                                changes,
                            )
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
                # Insert. The primary key is generated here rather than left to
                # the column default, which only fires at INSERT time - the
                # change-log row below needs the id now.
                obj = CloudResource(
                    id=uuid.uuid4(),
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
                if drift_repo is not None:
                    await drift_repo.record(
                        account_id,
                        drift_job_id,
                        {
                            "resource_id": obj.id,
                            "provider_resource_id": provider_rid,
                            "resource_type": obj.resource_type,
                            "resource_name": obj.resource_name,
                            "region_or_zone": obj.region_or_zone,
                        },
                        [describe_creation(obj.resource_type, obj.resource_name, obj.region_or_zone)],
                    )
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
        self,
        account_id: uuid.UUID,
        keep_provider_ids: List[str],
        *,
        drift_job_id: Optional[uuid.UUID] = None,
    ) -> int:
        """Delete this account's resources whose provider_resource_id is NOT in
        keep_provider_ids — i.e. rows from a previous scan that no longer exist.
        Used after an incremental scan to prune what wasn't re-seen. Returns rows deleted.

        With `drift_job_id`, each doomed row is logged as a DELETED change first,
        so the disappearance is still on record after the row is gone. Callers
        only reach this method after a COMPLETE sweep, which is what makes the
        deletion trustworthy: a partial sweep cannot tell "gone" from
        "not enumerated", which is why it is not allowed to prune either.
        """
        if drift_job_id:
            doomed_stmt = select(CloudResource).where(CloudResource.account_id == account_id)
            if keep_provider_ids:
                doomed_stmt = doomed_stmt.where(
                    CloudResource.provider_resource_id.notin_(list(keep_provider_ids))
                )
            doomed = list((await self.db.execute(doomed_stmt)).scalars().all())
            if doomed:
                drift_repo = DriftRepository(self.db)
                for res in doomed:
                    await drift_repo.record(
                        account_id,
                        drift_job_id,
                        {
                            # resource_id is recorded but intentionally not a
                            # foreign key, so this row survives the delete below.
                            "resource_id": res.id,
                            "provider_resource_id": res.provider_resource_id,
                            "resource_type": res.resource_type,
                            "resource_name": res.resource_name,
                            "region_or_zone": res.region_or_zone,
                        },
                        [describe_deletion(res.resource_type, res.resource_name)],
                    )
                await self.db.flush()

        stmt = delete(CloudResource).where(CloudResource.account_id == account_id)
        if keep_provider_ids:
            stmt = stmt.where(
                CloudResource.provider_resource_id.notin_(list(keep_provider_ids))
            )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.rowcount or 0

