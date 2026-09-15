"""Persistence and aggregation for `cloud_cost_facts`.

The one method that matters most is `upsert_facts`. Everything the analytics
phases will build -- forecasts, anomaly baselines, month-over-month, budget
burn -- is only as trustworthy as the guarantee that re-fetching a window
corrects history rather than doubling it.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import Float, and_, case, cast, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cost_fact import (
    BACKFILL_RUNNING,
    PROVISIONAL,
    STABLE,
    CloudCostBackfillJob,
    CloudCostFact,
)

logger = logging.getLogger("cloud_svc.cost.facts")

# Postgres caps a statement at 65535 bound parameters. Each fact row binds ~20
# columns, so 2000 rows/statement leaves comfortable headroom. OCI alone
# returns ~11k rows for a 7-day per-resource window, so chunking is not
# theoretical.
_CHUNK = 2000

# How long a fact must sit unchanged, across at least two reads, before it is
# called STABLE. Three days is past the window in which all three providers do
# the bulk of their restating, and the second read is what makes it evidence
# rather than an assumption about elapsed time.
_STABLE_AFTER_DAYS = 3
_STABLE_MIN_REVISIONS = 2


class CostFactRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Write ────────────────────────────────────────────────────────────────

    async def upsert_facts(self, rows: Sequence[Dict[str, Any]]) -> Tuple[int, int]:
        """Insert or correct billing facts. Returns (inserted, updated).

        Idempotent on `fact_key`: the same window fetched twice produces one
        row, and a restated amount overwrites the old value in place.

        Two details that are easy to get wrong and expensive if you do:

        *   `last_changed_at` advances ONLY when the amount actually differs.
            Touching it on every ingestion would make every fact look
            permanently in-flux and nothing would ever become STABLE.
        *   A row whose amount changed drops back to PROVISIONAL. A value that
            has just moved is, by definition, not settled -- letting it keep a
            STABLE label earned by its previous value would be a lie that
            forecasting would then consume.

        `inserted` vs `updated` is told apart by `revision_count`, which the
        column default sets to 1 on insert and the conflict branch increments.
        A returned value above 1 therefore means the row already existed. ON
        CONFLICT DO UPDATE reports both cases as affected rows, so the counter
        is the distinguishing signal rather than the row count.
        """
        if not rows:
            return 0, 0

        inserted = updated = 0
        now = datetime.now(timezone.utc)

        for start in range(0, len(rows), _CHUNK):
            chunk = list(rows[start:start + _CHUNK])
            stmt = pg_insert(CloudCostFact).values(chunk)
            amount_changed = CloudCostFact.amount.is_distinct_from(stmt.excluded.amount)

            stmt = stmt.on_conflict_do_update(
                index_elements=["fact_key"],
                set_={
                    "amount": stmt.excluded.amount,
                    "currency": stmt.excluded.currency,
                    # Inventory attribution can improve between scans: a
                    # resource discovered after its first billing row should
                    # stop being reported as unmatched.
                    "resource_name": func.coalesce(
                        stmt.excluded.resource_name, CloudCostFact.resource_name
                    ),
                    "resource_type": func.coalesce(
                        stmt.excluded.resource_type, CloudCostFact.resource_type
                    ),
                    "in_inventory": stmt.excluded.in_inventory,
                    "cost_component": stmt.excluded.cost_component,
                    "resource_group": func.coalesce(
                        stmt.excluded.resource_group, CloudCostFact.resource_group
                    ),
                    "compartment": func.coalesce(
                        stmt.excluded.compartment, CloudCostFact.compartment
                    ),
                    "dimensions": stmt.excluded.dimensions,
                    "retrieved_at": stmt.excluded.retrieved_at,
                    "revision_count": CloudCostFact.revision_count + 1,
                    "last_changed_at": case(
                        (amount_changed, now),
                        else_=CloudCostFact.last_changed_at,
                    ),
                    "finality": case(
                        (amount_changed, PROVISIONAL),
                        else_=CloudCostFact.finality,
                    ),
                },
            )

            result = await self.db.execute(
                stmt.returning(CloudCostFact.revision_count)
            )
            for (revision,) in result.all():
                if revision and revision > 1:
                    updated += 1
                else:
                    inserted += 1

        await self.db.commit()
        return inserted, updated

    async def promote_stable(self, account_id: Optional[uuid.UUID] = None) -> int:
        """Mark settled facts STABLE. Returns how many were promoted.

        A fact qualifies when it has been read at least twice and its amount
        has not moved for `_STABLE_AFTER_DAYS`. Note what this deliberately
        does NOT do: it never sets `final`. No provider in this integration
        tells us a period is closed, so that state stays reserved.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=_STABLE_AFTER_DAYS)
        settled = func.coalesce(CloudCostFact.last_changed_at, CloudCostFact.first_seen_at)

        clauses = [
            CloudCostFact.finality == PROVISIONAL,
            CloudCostFact.revision_count >= _STABLE_MIN_REVISIONS,
            settled < cutoff,
        ]
        if account_id is not None:
            clauses.append(CloudCostFact.account_id == account_id)

        result = await self.db.execute(
            update(CloudCostFact).where(and_(*clauses)).values(finality=STABLE)
        )
        await self.db.commit()
        return result.rowcount or 0

    # ── Read ─────────────────────────────────────────────────────────────────

    def _scope(self, account_ids: Sequence[uuid.UUID], start: date, end: date):
        return and_(
            CloudCostFact.account_id.in_(list(account_ids)),
            CloudCostFact.billing_date >= start,
            CloudCostFact.billing_date < end,
        )

    async def daily_series(
        self, account_ids: Sequence[uuid.UUID], start: date, end: date,
    ) -> List[Dict[str, Any]]:
        """Per-day totals, split by currency.

        Grouped by currency rather than summed across it: a multi-cloud
        account set genuinely bills in more than one, and one number spanning
        USD and INR would be meaningless.
        """
        if not account_ids:
            return []
        stmt = (
            select(
                CloudCostFact.billing_date,
                CloudCostFact.currency,
                func.sum(CloudCostFact.amount).label("amount"),
                func.count().label("records"),
            )
            .where(self._scope(account_ids, start, end))
            .group_by(CloudCostFact.billing_date, CloudCostFact.currency)
            .order_by(CloudCostFact.billing_date)
        )
        rows = (await self.db.execute(stmt)).all()
        return [
            {"date": d.isoformat(), "currency": c,
             "amount": (round(float(a), 6) if a is not None else None),
             "records": n}
            for d, c, a, n in rows
        ]

    async def totals_by(
        self,
        account_ids: Sequence[uuid.UUID],
        start: date,
        end: date,
        dimension: str = "service",
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Window totals grouped by one dimension, per currency."""
        column = {
            "service": CloudCostFact.service,
            "region": CloudCostFact.region,
            "resource_id": CloudCostFact.resource_id,
            "resource_type": CloudCostFact.resource_type,
            "cost_component": CloudCostFact.cost_component,
            "provider": CloudCostFact.provider,
            "compartment": CloudCostFact.compartment,
            "resource_group": CloudCostFact.resource_group,
        }.get(dimension)
        if column is None:
            raise ValueError(f"Unsupported grouping dimension: {dimension!r}")
        if not account_ids:
            return []

        stmt = (
            select(
                column.label("key"),
                CloudCostFact.currency,
                func.sum(CloudCostFact.amount).label("amount"),
                func.count().label("records"),
            )
            .where(self._scope(account_ids, start, end))
            .group_by(column, CloudCostFact.currency)
            .order_by(func.sum(CloudCostFact.amount).desc().nullslast())
            .limit(limit)
        )
        rows = (await self.db.execute(stmt)).all()
        return [
            {dimension: k, "currency": c,
             "amount": (round(float(a), 6) if a is not None else None),
             "records": n}
            for k, c, a, n in rows
        ]

    async def monthly_totals(
        self, account_ids: Sequence[uuid.UUID], months: int = 12,
    ) -> List[Dict[str, Any]]:
        """Calendar-month totals per currency — the basis for month-over-month.

        Derived from the facts rather than stored as a separate snapshot table
        on purpose: a materialized snapshot that disagrees with the underlying
        facts is worse than no snapshot, and there is no volume here that
        justifies the risk.
        """
        if not account_ids:
            return []
        start = (date.today().replace(day=1) - timedelta(days=31 * months)).replace(day=1)
        stmt = (
            select(
                func.to_char(CloudCostFact.billing_date, "YYYY-MM").label("month"),
                CloudCostFact.currency,
                func.sum(CloudCostFact.amount).label("amount"),
                func.count().label("records"),
                func.count(case((CloudCostFact.finality == PROVISIONAL, 1))).label("provisional"),
            )
            .where(
                and_(
                    CloudCostFact.account_id.in_(list(account_ids)),
                    CloudCostFact.billing_date >= start,
                )
            )
            .group_by("month", CloudCostFact.currency)
            .order_by("month")
        )
        rows = (await self.db.execute(stmt)).all()
        return [
            {"month": m, "currency": c,
             "amount": (round(float(a), 6) if a is not None else None),
             "records": n,
             # A month still carrying provisional rows must not be presented
             # as a settled figure next to closed months.
             "provisional_records": p,
             "settled": p == 0}
            for m, c, a, n, p in rows
        ]

    async def coverage(self, account_ids: Sequence[uuid.UUID]) -> Dict[str, Any]:
        """What history actually exists, so callers can refuse to forecast on
        two days of data instead of producing a confident straight line."""
        if not account_ids:
            return {"has_history": False, "days_covered": 0, "earliest": None,
                    "latest": None, "records": 0, "provisional_records": 0,
                    "currencies": []}

        stmt = select(
            func.min(CloudCostFact.billing_date),
            func.max(CloudCostFact.billing_date),
            func.count(),
            func.count(func.distinct(CloudCostFact.billing_date)),
            func.count(case((CloudCostFact.finality == PROVISIONAL, 1))),
        ).where(CloudCostFact.account_id.in_(list(account_ids)))
        earliest, latest, records, distinct_days, provisional = (
            await self.db.execute(stmt)
        ).one()

        currencies = (await self.db.execute(
            select(func.distinct(CloudCostFact.currency))
            .where(CloudCostFact.account_id.in_(list(account_ids)))
        )).scalars().all()

        return {
            "has_history": bool(records),
            "earliest": earliest.isoformat() if earliest else None,
            "latest": latest.isoformat() if latest else None,
            # Distinct billed days, not (latest - earliest): a gap in the
            # middle must not be counted as covered.
            "days_covered": int(distinct_days or 0),
            "records": int(records or 0),
            "provisional_records": int(provisional or 0),
            "currencies": sorted(c for c in currencies if c),
        }

    async def count_for_account(self, account_id: uuid.UUID) -> int:
        return (await self.db.execute(
            select(func.count()).select_from(CloudCostFact)
            .where(CloudCostFact.account_id == account_id)
        )).scalar() or 0

    async def delete_for_account(self, account_id: uuid.UUID) -> int:
        """Only used by tests and account removal. There is no user-facing
        delete path: billing history is evidence."""
        from sqlalchemy import delete
        result = await self.db.execute(
            delete(CloudCostFact).where(CloudCostFact.account_id == account_id)
        )
        await self.db.commit()
        return result.rowcount or 0

    # ── Backfill jobs ────────────────────────────────────────────────────────

    async def create_job(self, account_id: uuid.UUID, days: int) -> CloudCostBackfillJob:
        job = CloudCostBackfillJob(
            account_id=account_id, requested_days=days, status=BACKFILL_RUNNING,
        )
        self.db.add(job)
        await self.db.commit()
        await self.db.refresh(job)
        return job

    async def update_job(self, job_id: uuid.UUID, **fields) -> Optional[CloudCostBackfillJob]:
        job = await self.db.get(CloudCostBackfillJob, job_id)
        if job is None:
            return None
        for key, value in fields.items():
            setattr(job, key, value)
        await self.db.commit()
        await self.db.refresh(job)
        return job

    async def get_job(self, job_id: uuid.UUID) -> Optional[CloudCostBackfillJob]:
        return await self.db.get(CloudCostBackfillJob, job_id)

    async def latest_job(self, account_id: uuid.UUID) -> Optional[CloudCostBackfillJob]:
        return (await self.db.execute(
            select(CloudCostBackfillJob)
            .where(CloudCostBackfillJob.account_id == account_id)
            .order_by(CloudCostBackfillJob.started_at.desc())
            .limit(1)
        )).scalars().first()
