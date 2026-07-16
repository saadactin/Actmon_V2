"""Repository for Cloud Account CRUD operations."""
from __future__ import annotations

import uuid
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_account import CloudAccount


class CloudAccountRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(self, **kwargs) -> CloudAccount:
        account = CloudAccount(**kwargs)
        self.db.add(account)
        await self.db.flush()
        await self.db.refresh(account)
        return account

    async def get_by_id(self, account_id: uuid.UUID) -> Optional[CloudAccount]:
        result = await self.db.execute(
            select(CloudAccount).where(CloudAccount.id == account_id)
        )
        return result.scalar_one_or_none()

    async def list_all(self) -> List[CloudAccount]:
        result = await self.db.execute(
            select(CloudAccount).order_by(CloudAccount.created_at.desc())
        )
        return list(result.scalars().all())

    async def update_last_discovery(self, account_id: uuid.UUID) -> None:
        from datetime import datetime, timezone

        account = await self.get_by_id(account_id)
        if account:
            account.last_discovery = datetime.now(timezone.utc)
            await self.db.flush()

    async def delete(self, account_id: uuid.UUID) -> bool:
        account = await self.get_by_id(account_id)
        if account:
            await self.db.delete(account)
            await self.db.flush()
            return True
        return False
