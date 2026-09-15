"""Turn provider billing responses into persisted `cloud_cost_facts`.

This is the ingestion half of the persistence phase: normalize -> upsert ->
report honestly what landed.

**What is ingested, and what deliberately is not.**

Only the *dated* per-service ledger (`provider.get_cost_report`) is stored, and
that is a correctness decision rather than an omission. The per-resource query
(`get_cost_by_resource`) returns one figure per resource for the WHOLE window,
with no date breakdown -- so writing it into a table whose grain is one row per
day would mean stamping a 30-day total onto a single date. That figure would
then be summed into daily trends, month-over-month comparisons and anomaly
baselines as though it were one day's spend. Storing nothing is recoverable;
storing a 30x overstatement is not.

Per-resource *history* needs the providers to group by resource AND date in the
same query (Azure and OCI can; AWS cannot without CUR). That is a scoped
follow-up, and `cloud_cost_facts.resource_id` already exists to receive it.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.models.cost_fact import (
    BACKFILL_FAILED,
    BACKFILL_PARTIAL,
    BACKFILL_SUCCEEDED,
    PROVISIONAL,
    build_fact_key,
)
from app.repository.cost_fact_repo import CostFactRepository
from app.services import cost_errors

logger = logging.getLogger("cloud_svc.cost.ingest")

# How much history one provider call asks for during a backfill. Small enough
# that progress moves visibly and one failure loses only its own window;
# large enough not to make 365 days into 365 round trips. OCI splits further
# internally at 90 days, which is its own API's constraint, not ours.
BACKFILL_WINDOW_DAYS = 30

# Hard ceiling, matching cost_service.MAX_REPORT_DAYS.
MAX_BACKFILL_DAYS = 365


def _parse_date(value: Any) -> Optional[date]:
    """A provider's date field as a real date, or None.

    None rather than a fallback to today: a row we cannot place in time is a
    row we must not store, because it would land on the wrong day and corrupt
    every trend built on top of it.
    """
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def normalize_report_rows(
    account,
    rows: Sequence[Dict[str, Any]],
    *,
    retrieved_at: Optional[datetime] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Provider `get_cost_report` rows -> fact dicts ready for upsert.

    Returns (facts, rejected) where `rejected` counts what was dropped and why,
    so ingestion can report "wrote 2,741, skipped 3 undated" instead of quietly
    losing rows.
    """
    from app.services.cost_service import _normalize_cost_component

    retrieved_at = retrieved_at or datetime.now(timezone.utc)
    provider = (account.provider or "").upper()
    facts: List[Dict[str, Any]] = []
    rejected = {"undated": 0, "no_amount": 0}

    for row in rows:
        billing_date = _parse_date(row.get("date"))
        if billing_date is None:
            rejected["undated"] += 1
            continue

        amount = row.get("cost")
        if amount is None:
            # Kept, not dropped: a billed line with no value is "unknown", and
            # the NULL is the honest record of that. Counted so it is visible.
            rejected["no_amount"] += 1

        service = row.get("service")
        region = row.get("region")
        currency = row.get("currency")

        facts.append({
            "id": uuid.uuid4(),
            "account_id": account.id,
            "provider": provider,
            "billing_date": billing_date,
            "service": service,
            "region": region,
            "resource_id": None,
            "resource_name": None,
            "resource_type": None,
            "usage_type": None,
            "cost_component": _normalize_cost_component(provider, service),
            "resource_group": None,
            "compartment": None,
            "amount": (float(amount) if amount is not None else None),
            "currency": currency,
            "source": "provider_billing",
            "in_inventory": False,
            "finality": PROVISIONAL,
            "revision_count": 1,
            "first_seen_at": retrieved_at,
            "retrieved_at": retrieved_at,
            "last_changed_at": None,
            "dimensions": None,
            "fact_key": build_fact_key(
                account_id=account.id,
                provider=provider,
                billing_date=billing_date,
                service=service,
                region=region,
                resource_id=None,
                usage_type=None,
                currency=currency,
            ),
        })

    return facts, rejected


def _dedupe(facts: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse rows sharing a fact_key WITHIN one batch.

    Postgres refuses an ON CONFLICT statement that touches the same target row
    twice ("cannot affect row a second time"), and a single provider response
    can legitimately contain duplicates -- Azure's window-splitting returns the
    same service/day from two halves, and OCI returns one usage item per
    compartment for the same service and day. Summing them here reproduces
    exactly what a single unsplit query would have reported.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    for fact in facts:
        key = fact["fact_key"]
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(fact)
            continue
        a, b = existing.get("amount"), fact.get("amount")
        # None + value = value; None + None stays None. Never 0.
        existing["amount"] = b if a is None else (a if b is None else a + b)
    return list(merged.values())


async def ingest_window(
    db,
    account,
    *,
    start: date,
    end: date,
) -> Dict[str, Any]:
    """Fetch and persist one dated window for one account.

    Raises on provider failure so the caller can classify and record it --
    swallowing the error here is what made a failed fetch indistinguishable
    from an account with no spend.
    """
    from app.services.cost_service import _require_provider

    provider = _require_provider(account)
    if not hasattr(provider, "get_cost_report"):
        raise cost_errors.NotSupportedError(
            f"{account.provider} has no dated cost report, so its history "
            "cannot be persisted.",
            provider=account.provider, dimension="daily_service",
        )

    rows = await provider.get_cost_report(
        days=(end - start).days, start_date=start, end_date=end
    ) or []

    facts, rejected = normalize_report_rows(account, rows)
    facts = _dedupe(facts)

    inserted, updated = await CostFactRepository(db).upsert_facts(facts)
    return {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "rows_returned": len(rows),
        "facts": len(facts),
        "inserted": inserted,
        "updated": updated,
        "rejected": rejected,
    }


def plan_windows(days: int, *, today: Optional[date] = None) -> List[Tuple[date, date]]:
    """Split a lookback into concrete [start, end) windows, oldest first.

    Oldest first so that if a long backfill is interrupted, what survives is a
    contiguous block of older history with a gap at the recent end -- which the
    live billing APIs can still answer for -- rather than a hole in the middle
    that nothing can fill.
    """
    today = today or date.today()
    days = max(1, min(int(days), MAX_BACKFILL_DAYS))
    start = today - timedelta(days=days)

    windows: List[Tuple[date, date]] = []
    cursor = start
    while cursor < today:
        window_end = min(cursor + timedelta(days=BACKFILL_WINDOW_DAYS), today)
        windows.append((cursor, window_end))
        cursor = window_end
    return windows


async def run_backfill(db, account, days: int, *, job_id: Optional[uuid.UUID] = None) -> Dict[str, Any]:
    """Walk history in windows, persisting each, reporting progress as it goes.

    One window failing does not abandon the run: the rest are still attempted
    and the job ends PARTIAL, naming how many windows are missing. A backfill
    that gives up on the first 429 would never complete against Azure at all.
    """
    repo = CostFactRepository(db)
    windows = plan_windows(days)

    job = (await repo.get_job(job_id)) if job_id else None
    if job is None:
        job = await repo.create_job(account.id, days)
    await repo.update_job(job.id, windows_total=len(windows))

    done = failed = 0
    written = changed = 0
    last_error: Optional[cost_errors.CostError] = None
    results: List[Dict[str, Any]] = []

    for start, end in windows:
        try:
            outcome = await ingest_window(db, account, start=start, end=end)
            results.append(outcome)
            written += outcome["inserted"]
            changed += outcome["updated"]
            done += 1
        except Exception as exc:
            failed += 1
            last_error = cost_errors.classify(exc, provider=account.provider)
            logger.warning(
                "Backfill window %s..%s failed for %s: %s",
                start, end, account.account_name, last_error.message[:160],
            )
            # A throttled provider will refuse the next window too. Waiting the
            # interval it asked for is the difference between finishing slowly
            # and failing fast on every remaining window.
            if last_error.category == cost_errors.RATE_LIMITED:
                await asyncio.sleep(min(last_error.retry_after_seconds or 5, 60))

        await repo.update_job(
            job.id, windows_done=done, windows_failed=failed,
            records_written=written, records_updated=changed,
        )

    if failed == 0:
        status = BACKFILL_SUCCEEDED
    elif done > 0:
        status = BACKFILL_PARTIAL
    else:
        status = BACKFILL_FAILED

    job = await repo.update_job(
        job.id,
        status=status,
        finished_at=datetime.now(timezone.utc),
        error_category=(last_error.category if last_error else None),
        error_message=(last_error.message[:2000] if last_error else None),
    )

    # Newly-landed history is provisional by definition; this only promotes
    # facts that have already proven settled across earlier runs.
    await repo.promote_stable(account.id)

    return {**job.to_dict(), "windows": results}


async def ingest_recent(db, account, days: int = 30) -> Dict[str, Any]:
    """Persist the recent window — the routine top-up after a discovery scan.

    Idempotent, so running it on every scan re-reads and CORRECTS the last few
    days rather than duplicating them. That re-reading is what eventually earns
    a fact its STABLE label.
    """
    today = date.today()
    start = today - timedelta(days=max(1, min(days, MAX_BACKFILL_DAYS)))
    try:
        outcome = await ingest_window(db, account, start=start, end=today)
    except Exception as exc:
        err = cost_errors.classify(exc, provider=account.provider)
        logger.warning(
            "Cost ingestion failed for %s: %s", account.account_name, err.message[:200]
        )
        return {"ok": False, "error": err.to_dict()}

    await CostFactRepository(db).promote_stable(account.id)
    return {"ok": True, **outcome}
