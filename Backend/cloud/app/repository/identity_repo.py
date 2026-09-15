"""Persistence for identity grants and their collection health."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity_grant import (
    COLLECT_NEVER_RUN, COLLECT_OK, CloudIdentityCollectionState, CloudIdentityGrant,
)


class IdentityRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def grants(self, account_id: uuid.UUID) -> List[CloudIdentityGrant]:
        return list((await self.db.execute(
            select(CloudIdentityGrant)
            .where(CloudIdentityGrant.account_id == account_id)
            .order_by(CloudIdentityGrant.scope_level, CloudIdentityGrant.role_name)
        )).scalars().all())

    async def state(self, account_id: uuid.UUID) -> Optional[CloudIdentityCollectionState]:
        return await self.db.get(CloudIdentityCollectionState, account_id)

    async def replace_grants(
        self, *, account_id: uuid.UUID, provider: str,
        grants: Sequence[Dict[str, Any]],
    ) -> int:
        """Replace the account's grants with a freshly collected set.

        Replace rather than merge, because a role assignment that no longer
        appears has genuinely been removed — this is a full listing of the
        subscription, not a page of it. `first_seen_at` is carried over for
        grants that persist, so "this principal has held Owner since March"
        survives a re-collection.

        Only called on a SUCCESSFUL collection. A refused collection must never
        reach here: replacing a real set with an empty one would turn a
        permission error into "all privileged access was removed".
        """
        now = datetime.now(timezone.utc)
        existing = {g.grant_key: g for g in await self.grants(account_id)}
        seen = set()

        for spec in grants:
            key = spec["grant_key"]
            seen.add(key)
            row = existing.get(key)
            if row is None:
                self.db.add(CloudIdentityGrant(
                    account_id=account_id, provider=provider, grant_key=key,
                    first_seen_at=now, last_seen_at=now,
                    **{k: spec.get(k) for k in (
                        "principal_id", "principal_type", "principal_name",
                        "role_key", "role_name", "role_type", "scope", "scope_level",
                        "permissions")},
                ))
            else:
                for k in ("principal_id", "principal_type", "principal_name",
                          "role_key", "role_name", "role_type", "scope",
                          "scope_level", "permissions"):
                    setattr(row, k, spec.get(k))
                row.last_seen_at = now

        stale = [k for k in existing if k not in seen]
        if stale:
            await self.db.execute(delete(CloudIdentityGrant).where(
                CloudIdentityGrant.account_id == account_id,
                CloudIdentityGrant.grant_key.in_(stale),
            ))
        await self.db.flush()
        return len(seen)

    async def record_state(
        self, *, account_id: uuid.UUID, provider: str, status: str,
        error_detail: Optional[str] = None, missing_permission: Optional[str] = None,
        grant_count: int = 0,
    ) -> CloudIdentityCollectionState:
        now = datetime.now(timezone.utc)
        row = await self.state(account_id)
        if row is None:
            row = CloudIdentityCollectionState(account_id=account_id, provider=provider)
            self.db.add(row)
        row.provider = provider
        row.status = status
        row.error_detail = error_detail
        row.missing_permission = missing_permission
        row.last_attempt_at = now
        if status == COLLECT_OK:
            row.grant_count = grant_count
            row.last_success_at = now
        # A failed attempt leaves grant_count and last_success_at alone, so the
        # UI can say "24 assignments, collected 3 days ago, last attempt failed"
        # instead of "0 assignments".
        await self.db.flush()
        return row
