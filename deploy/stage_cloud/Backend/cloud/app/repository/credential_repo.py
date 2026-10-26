"""Persistence for the certificate / secret / key inventory and its sources."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.credential_inventory import (
    COLLECT_OK, CloudCredentialObject, CloudCredentialSource,
)


class CredentialRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def objects(self, account_ids: Sequence[uuid.UUID]) -> List[CloudCredentialObject]:
        if not account_ids:
            return []
        return list((await self.db.execute(
            select(CloudCredentialObject)
            .where(CloudCredentialObject.account_id.in_(list(account_ids)))
            .order_by(CloudCredentialObject.expires_at.asc().nullslast(),
                      CloudCredentialObject.name)
        )).scalars().all())

    async def sources(self, account_ids: Sequence[uuid.UUID]) -> List[CloudCredentialSource]:
        if not account_ids:
            return []
        return list((await self.db.execute(
            select(CloudCredentialSource)
            .where(CloudCredentialSource.account_id.in_(list(account_ids)))
            .order_by(CloudCredentialSource.source, CloudCredentialSource.scope)
        )).scalars().all())

    async def replace_scope(self, *, account_id: uuid.UUID, provider: str, source: str,
                            scope: str, specs: Sequence[Dict[str, Any]]) -> int:
        """Make the stored objects of ONE scope exactly `specs`.

        Only ever called for a scope that was read in full. A failed scope must
        never reach here: replacing real objects with an empty list would turn
        "the vault refused us" into "every certificate was removed".
        `first_seen_at` survives for objects that persist.
        """
        now = datetime.now(timezone.utc)
        keys = [s["object_key"] for s in specs if s.get("object_key")]
        existing: Dict[str, CloudCredentialObject] = {}
        if keys:
            existing = {o.object_key: o for o in (await self.db.execute(
                select(CloudCredentialObject).where(
                    CloudCredentialObject.account_id == account_id,
                    CloudCredentialObject.object_key.in_(keys),
                ))).scalars().all()}

        seen = set()
        for spec in specs:
            key = spec.get("object_key")
            if not key or key in seen:
                continue
            seen.add(key)
            values = {f: spec.get(f) for f in CloudCredentialObject.SPEC_FIELDS
                      if f != "object_key"}
            row = existing.get(key)
            if row is None:
                self.db.add(CloudCredentialObject(
                    account_id=account_id, provider=provider, source=source,
                    source_scope=scope, object_key=key, first_seen_at=now,
                    last_seen_at=now, **values))
            else:
                for f, v in values.items():
                    setattr(row, f, v)
                row.provider, row.source, row.source_scope = provider, source, scope
                row.last_seen_at = now

        stale = and_(CloudCredentialObject.account_id == account_id,
                     CloudCredentialObject.source == source,
                     CloudCredentialObject.source_scope == scope)
        if seen:
            stale = and_(stale, CloudCredentialObject.object_key.notin_(list(seen)))
        await self.db.execute(delete(CloudCredentialObject).where(stale))
        await self.db.flush()
        return len(seen)

    async def record_source(self, *, account_id: uuid.UUID, provider: str,
                            result: Dict[str, Any], item_count: int) -> CloudCredentialSource:
        now = datetime.now(timezone.utc)
        row = (await self.db.execute(select(CloudCredentialSource).where(
            CloudCredentialSource.account_id == account_id,
            CloudCredentialSource.source == result["source"],
            CloudCredentialSource.scope == result["scope"],
        ))).scalar_one_or_none()
        if row is None:
            row = CloudCredentialSource(account_id=account_id, provider=provider,
                                        source=result["source"], scope=result["scope"])
            self.db.add(row)
        row.provider = provider
        row.scope_label = result.get("scope_label")
        row.status = result["status"]
        row.error_detail = result.get("error_detail")
        row.missing_permission = result.get("missing_permission")
        row.remediation = result.get("remediation")
        if result.get("container") is not None:
            row.container = result["container"]
        row.last_attempt_at = now
        if result["status"] == COLLECT_OK:
            row.item_count = item_count
            row.last_success_at = now
        # A failed attempt leaves item_count and last_success_at alone, so the
        # view can say "12 certificates, confirmed 3 days ago, last attempt
        # refused" instead of "0 certificates".
        await self.db.flush()
        return row

    async def forget_scopes(self, *, account_id: uuid.UUID, source_prefix: str,
                            keep_scopes: Sequence[str]) -> int:
        """Drop sources (and their objects) for containers that no longer exist —
        e.g. a Key Vault that a successful vault listing no longer returns."""
        stmt = select(CloudCredentialSource).where(
            CloudCredentialSource.account_id == account_id,
            CloudCredentialSource.source.like(f"{source_prefix}%"))
        keep = list(keep_scopes)
        if keep:
            stmt = stmt.where(CloudCredentialSource.scope.notin_(keep))
        # With nothing to keep (a successful listing that returned no vaults)
        # every scope under the prefix is stale. That case used to pass a
        # "\x00" sentinel to NOT IN, which Postgres refuses outright ("invalid
        # byte sequence for encoding UTF8"), failing the whole collection for
        # any subscription with no Key Vault.
        stale_sources = (await self.db.execute(stmt)).scalars().all()
        for s in stale_sources:
            await self.db.execute(delete(CloudCredentialObject).where(
                CloudCredentialObject.account_id == account_id,
                CloudCredentialObject.source == s.source,
                CloudCredentialObject.source_scope == s.scope))
            await self.db.delete(s)
        await self.db.flush()
        return len(stale_sources)

    async def forget_placeholder(self, *, account_id: uuid.UUID, source: str) -> None:
        """Remove the "*" scope a failed region listing recorded, once real
        regional scopes for the same source exist."""
        await self.db.execute(delete(CloudCredentialSource).where(
            CloudCredentialSource.account_id == account_id,
            CloudCredentialSource.source == source,
            CloudCredentialSource.scope == "*"))
