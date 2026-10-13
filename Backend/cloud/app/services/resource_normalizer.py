"""Writes the normalized projections that the resource query layer reads.

The pure logic lives in `resource_model`. This module is only the part that
touches the database: it runs those functions over stored rows and persists
their output into the normalized columns, so SQL can filter, sort and count on
them without Python loading the whole account first.

Run after every discovery sweep, and once at startup for any account whose rows
predate the columns.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource
from app.models.resource_cost import SOURCE_PROVIDER_BILLING, CloudResourceCost
from app.services import resource_capabilities as caps
from app.services import resource_model as rm
from app.services import resource_services as svc

logger = logging.getLogger("cloud_svc.resource_normalizer")

# Rows per UPDATE batch. Kept well inside asyncpg's 32,767 bind-parameter
# ceiling: this statement binds one parameter per id plus a handful of values,
# so 5,000 ids is roughly a sixth of the limit even in the worst case. The
# arithmetic is written down because the last time a chunk size was chosen by
# feel in this codebase (2,000 rows x 24 columns = 48,000 parameters) it
# silently exceeded the ceiling.
_ID_CHUNK = 5_000


def normalized_values(resource: CloudResource, *,
                      provider: Optional[str] = None) -> Dict[str, Any]:
    """The normalized projection of one resource row. Pure.

    `provider` is the account's cloud. Without it the service is inferred from
    the resource ID, which is unambiguous for Azure (ARM ids) and OCI (OCIDs)
    but not for every AWS id — so callers that know the account pass it.
    """
    verdict = rm.normalize_status(
        resource.resource_type, resource.status, resource.config
    )
    type_info = rm.normalize_type(resource.resource_type)
    place = rm.placement(resource.metadata_, resource.config)
    tags = resource.tags if isinstance(resource.tags, dict) else None

    return {
        "normalized_status": verdict.normalized,
        "status_reason": verdict.reason,
        "normalized_type": type_info.category,
        "service": svc.service_of(resource.resource_type, resource.provider_resource_id,
                                  provider).key,
        "environment": rm.environment_of(tags),
        "owner": rm.owner_of(tags),
        "attachment_state": rm.attachment_state(resource.resource_type, resource.config),
        "resource_group": place["resource_group"],
        "compartment": place["compartment"],
        "availability_zone": place["availability_zone"],
        "is_default": rm.is_default_resource(resource.resource_name, resource.config),
        "tag_count": rm.tag_count(tags),
    }


async def renormalize_account(
    db: AsyncSession,
    account_id: uuid.UUID,
    *,
    only_missing: bool = False,
) -> int:
    """Recompute and store the normalized columns for one account.

    `only_missing` restricts the pass to rows that have never been normalized,
    which is what the startup backfill wants. A full pass is what a discovery
    sweep wants, and what anyone wants after the normalization rules change.

    Returns the number of rows whose projection actually moved. Rows already
    holding the right values are left untouched so the pass does not churn
    `updated_at` — a re-normalization is not a configuration change and must
    not look like one in the drift log.

    WHY THIS DOES NOT ASSIGN ORM ATTRIBUTES
    ---------------------------------------
    Setting them on the mapped object makes SQLAlchemy emit an UPDATE, which
    fires `updated_at`'s onupdate default and stamps the resource as freshly
    CHANGED. It is not: recomputing a projection from fields that did not move
    is our bookkeeping, not the provider's. Run that way over a whole estate it
    rewrites every row's "last changed" to the moment of the backfill and the
    original values are gone -- which is exactly what happened here the first
    time this ran, across 1,526 rows.

    So each row is written with an explicit Core UPDATE that pins `updated_at`
    to its own current value. A column present in the SET clause does not get
    its onupdate default applied, so the timestamp survives untouched.
    """
    from app.models.cloud_account import CloudAccount

    provider = (await db.execute(
        select(CloudAccount.provider).where(CloudAccount.id == account_id)
    )).scalar()
    stmt = select(CloudResource).where(CloudResource.account_id == account_id)
    if only_missing:
        stmt = stmt.where(or_(CloudResource.normalized_status.is_(None),
                              CloudResource.service.is_(None)))

    rows = list((await db.execute(stmt)).scalars().all())
    changed = 0
    for row in rows:
        values = normalized_values(row, provider=provider)
        if all(getattr(row, key) == value for key, value in values.items()):
            continue
        await db.execute(
            update(CloudResource)
            .where(CloudResource.id == row.id)
            .values(**values, updated_at=CloudResource.updated_at)
            .execution_options(synchronize_session=False)
        )
        changed += 1
    if changed:
        await db.flush()
        # The identity map still holds the pre-update objects; drop them so a
        # caller reading a resource back in this session sees the new
        # projection rather than the stale one.
        db.expire_all()
    return changed


async def mark_seen(
    db: AsyncSession,
    account_id: uuid.UUID,
    provider_resource_ids: Sequence[str],
    *,
    now: Optional[datetime] = None,
) -> int:
    """Record that this sweep observed these resources.

    Freshness has to be "when did we last look at it", not "when did it last
    change" — a resource that has been stable for a month is not stale
    inventory, it is stable inventory, and the two must not render the same.

    `updated_at` is pinned to its own current value in the SET clause. Without
    that, SQLAlchemy's onupdate default fires and every sweep would stamp every
    row as freshly modified, destroying the change log's meaning to fix the
    freshness column's. Assigning a column to itself is how a bulk UPDATE opts
    out of an onupdate default.
    """
    ids = [pid for pid in provider_resource_ids if pid]
    if not ids:
        return 0
    stamp = now or datetime.now(timezone.utc)
    total = 0
    for start in range(0, len(ids), _ID_CHUNK):
        chunk = ids[start:start + _ID_CHUNK]
        result = await db.execute(
            update(CloudResource)
            .where(
                CloudResource.account_id == account_id,
                CloudResource.provider_resource_id.in_(chunk),
            )
            .values(last_seen_at=stamp, updated_at=CloudResource.updated_at)
        )
        total += result.rowcount or 0
    await db.flush()
    return total


async def accounts_needing_backfill(db: AsyncSession) -> List[uuid.UUID]:
    """Accounts with at least one row that has never been normalized — or
    predates a projection column added later (service)."""
    rows = (await db.execute(
        select(CloudResource.account_id)
        .where(or_(CloudResource.normalized_status.is_(None),
                   CloudResource.service.is_(None)))
        .group_by(CloudResource.account_id)
    )).all()
    return [row[0] for row in rows]


# ── Per-resource cost materialization ────────────────────────────────────────
async def sync_resource_costs(
    db: AsyncSession,
    account: Any,
    *,
    days: int = 30,
    wait: bool = False,
) -> Dict[str, Any]:
    """Materialize the provider's per-resource billing map into the DB.

    Returns a report rather than raising, because this is decoration: a billing
    API that is throttled or down must never stop an inventory from rendering.
    Every outcome is named so the UI can say which one happened.

    `wait=False` (the default) reads whatever the cost cache already holds and
    triggers a background refresh. `wait=True` issues the billing query and
    waits for it, which is what an explicit "refresh cost" action wants.
    """
    from app.services.cost_service import (
        ensure_costs_by_resource_warm,
        fetch_real_costs_by_resource,
        peek_costs_by_resource,
    )

    provider = (account.provider or "").upper()
    caps_for = caps.for_provider(provider)
    if not caps_for.can(caps.RESOURCE_COST):
        return {
            "supported": False,
            "provider": provider,
            "reason": caps_for.reason(caps.RESOURCE_COST),
            "written": 0,
            "matched": 0,
            "unmatched": 0,
        }

    if wait:
        try:
            cost_map = await fetch_real_costs_by_resource(account, days)
        except Exception as exc:
            logger.warning(
                "Per-resource cost refresh failed for account %s: %s", account.id, exc
            )
            return {
                "supported": True, "provider": provider, "written": 0,
                "matched": 0, "unmatched": 0,
                "error": "The billing query failed; previously stored costs were "
                         "left untouched rather than cleared.",
            }
    else:
        cost_map = peek_costs_by_resource(account)
        ensure_costs_by_resource_warm(account)

    if not cost_map:
        # Ambiguous on its own: a cold cache and an account with no billed
        # resources look identical here. Deleting stored costs on this path
        # would blank the column every time the process restarts, so nothing is
        # written and the caller is told why.
        return {
            "supported": True, "provider": provider, "written": 0,
            "matched": 0, "unmatched": 0,
            "reason": "No per-resource billing data is cached yet for this "
                      "account. A refresh is running; costs appear once it "
                      "returns. Stored costs were left as they were.",
        }

    resources = list((await db.execute(
        select(
            CloudResource.id,
            CloudResource.provider_resource_id,
        ).where(CloudResource.account_id == account.id)
    )).all())

    # Azure's Cost Management API returns ResourceId in a different case than
    # ARM's resources.list(), so an exact-match join misses every Azure row.
    # Match exactly first, then fold case — same rule the existing decoration
    # path uses, kept identical on purpose.
    existing = {
        row.resource_id: row
        for row in (await db.execute(
            select(CloudResourceCost).where(
                CloudResourceCost.account_id == account.id
            )
        )).scalars().all()
    }

    now = datetime.now(timezone.utc)
    matched = 0
    seen_resource_ids: set = set()
    for res_id, provider_rid in resources:
        entry = cost_map.get(provider_rid)
        if entry is None and provider_rid:
            entry = cost_map.get(provider_rid.lower())
        if entry is None:
            continue
        matched += 1
        seen_resource_ids.add(res_id)
        amount = entry.get("monthly_cost")
        values = {
            "account_id": account.id,
            "provider": provider,
            "provider_resource_id": provider_rid,
            "amount": float(amount) if amount is not None else None,
            "currency": entry.get("currency"),
            "period_days": days,
            "source": SOURCE_PROVIDER_BILLING,
            "billed_service": entry.get("service"),
            "billed_region": entry.get("region"),
            "fetched_at": now,
        }
        row = existing.get(res_id)
        if row is None:
            db.add(CloudResourceCost(resource_id=res_id, **values))
        else:
            for key, value in values.items():
                setattr(row, key, value)

    # A resource that has dropped out of the billing response no longer has a
    # known cost. Keeping the old figure would show a stale number as current,
    # which is worse than NA — so the row goes and the UI says "not reported".
    removed = 0
    for res_id, row in existing.items():
        if res_id not in seen_resource_ids:
            await db.delete(row)
            removed += 1

    await db.flush()
    return {
        "supported": True,
        "provider": provider,
        "period_days": days,
        "written": matched,
        "matched": matched,
        "removed_stale": removed,
        # Billed IDs with no inventory row: deleted resources still billed for
        # part of the window, or billing-internal IDs that were never real
        # resources. Reported, not hidden — they are a genuine gap between what
        # is billed and what is known.
        "unmatched": max(0, len(cost_map) - matched),
        "billed_ids": len(cost_map),
        "fetched_at": now.isoformat(),
    }


async def cost_coverage(db: AsyncSession, account_ids: Sequence[uuid.UUID]) -> Dict[str, Any]:
    """How much of the inventory has a known cost, for the data-quality panel."""
    if not account_ids:
        return {"resources": 0, "with_cost": 0, "percent": None}
    total = int((await db.execute(
        select(func.count()).select_from(CloudResource)
        .where(CloudResource.account_id.in_(list(account_ids)))
    )).scalar() or 0)
    with_cost = int((await db.execute(
        select(func.count()).select_from(CloudResourceCost)
        .where(
            CloudResourceCost.account_id.in_(list(account_ids)),
            CloudResourceCost.amount.isnot(None),
        )
    )).scalar() or 0)
    return {
        "resources": total,
        "with_cost": with_cost,
        # None, not 0, when there is nothing to divide by. "0% of nothing" is a
        # claim about a set that does not exist.
        "percent": round(with_cost * 100.0 / total, 1) if total else None,
    }
