"""Produce and e-mail scheduled account reports.

The client-report scheduler's design, unchanged in substance, because it is
the one that survived the 2026-09-17 e-mail storm:

* **One transaction.** The report row, the queued e-mail and the schedule's
  advance commit together or not at all.
* **One report per schedule per run, enforced by the database** -- the
  partial unique index uq_account_report_schedule_run.
* **No catch-up floods.** After downtime only the most recent due run is
  produced; the skipped runs are named on the schedule.
* **A failure advances the schedule anyway**, with the error recorded, and
  its failed row takes the run's slot -- retried next period or by hand,
  never in a loop.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger("cloud_svc.account_reports.scheduler")

TICK_SECONDS = 300
_stop = asyncio.Event()


def scheduler_enabled() -> bool:
    return os.getenv("ACCOUNT_REPORT_SCHEDULER_ENABLED", "true").strip().lower() not in (
        "false", "0", "no", "off")


def stop_scheduler() -> None:
    _stop.set()


async def run_due(now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Run every due schedule. Returns one outcome per schedule."""
    from app.core.database import AsyncSessionLocal
    from app.models.account_report import (
        TRIGGER_SCHEDULE, CloudAccountReport, CloudAccountReportSchedule,
    )

    now = now or datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        due_ids = (await db.execute(
            select(CloudAccountReportSchedule.id).where(
                CloudAccountReportSchedule.enabled.is_(True),
                CloudAccountReportSchedule.next_run_at.is_not(None),
                CloudAccountReportSchedule.next_run_at <= now,
            ))).scalars().all()

    outcomes: List[Dict[str, Any]] = []
    for schedule_id in due_ids:
        async with AsyncSessionLocal() as db:
            sched = await db.get(CloudAccountReportSchedule, schedule_id)
            if sched is None or not sched.enabled or sched.next_run_at is None \
                    or sched.next_run_at > now:
                continue
            outcome = await _run_one(db, sched, now, CloudAccountReport, TRIGGER_SCHEDULE)
            outcomes.append(outcome)
    return outcomes


async def _run_one(db, sched, now: datetime, CloudAccountReport, TRIGGER_SCHEDULE) -> Dict[str, Any]:
    from app.services import account_report_service as ars

    # Read before anything can fail: a rollback expires every ORM object, and
    # touching `sched.id` in the except handlers below would then itself raise
    # (MissingGreenlet), losing the failure record and the advance.
    schedule_id = sched.id
    plan = ars.plan_run(sched, now)
    run_key = plan["run_key"]
    skipped_note = (f" Skipped {len(plan['skipped'])} earlier run(s) while the service was not "
                    f"running ({', '.join(plan['skipped'][:6])}); produce them by hand if needed."
                    if plan["skipped"] else "")
    base = {"schedule_id": str(sched.id), "account_id": str(sched.account_id), "run_key": run_key}

    already = (await db.execute(select(CloudAccountReport.id).where(
        CloudAccountReport.schedule_id == sched.id, CloudAccountReport.run_key == run_key,
        CloudAccountReport.trigger == TRIGGER_SCHEDULE))).first()
    if already:
        _advance(sched, plan, now, "ALREADY_PRODUCED",
                 f"The {run_key} run was already produced; not produced again." + skipped_note)
        await db.commit()
        return {**base, "outcome": "already_produced"}

    try:
        request = ars.request_from_config(sched.account_id, sched.config)
        row, content, info = await ars.produce(
            db, request, trigger=TRIGGER_SCHEDULE, actor="schedule",
            template_name=sched.template_name or sched.name, schedule=sched,
            run_key=run_key, commit=False)
        account_name = await ars._account_name(db, sched.account_id)
        period = {"start": row.period_start.isoformat() if row.period_start else None,
                  "end": row.period_end.isoformat() if row.period_end else None}
        since = await _since(db, row)
        await ars.queue_report_email(db, row, content, sched=sched, account_name=account_name,
                                     since=since, period=period)
        sched.last_report_id = row.id
        _advance(sched, plan, now, row.delivery_status or "GENERATED",
                 (row.delivery_message or "") + skipped_note)
        await db.commit()       # report + e-mail + advance, together
        logger.info("Scheduled account report %s (%s): %s", sched.name, run_key, sched.last_status)
        return {**base, "outcome": "produced", "report_id": str(row.id),
                "delivery_status": row.delivery_status}
    except IntegrityError:
        await db.rollback()
        await _advance_fresh(schedule_id, plan, now, "ALREADY_PRODUCED",
                             f"The {run_key} run already exists." + skipped_note)
        return {**base, "outcome": "duplicate_refused"}
    except Exception as exc:  # noqa: BLE001 -- recorded, the schedule still advances
        await db.rollback()
        logger.exception("Scheduled account report failed: %s", schedule_id)
        message = f"Could not produce the {run_key} report: {getattr(exc, 'message', None) or exc}"
        await _record_failure(schedule_id, plan, now, run_key, message[:1500] + skipped_note)
        return {**base, "outcome": "failed", "error": str(exc)[:300]}


async def _since(db, row) -> Optional[Dict[str, Any]]:
    from app.services import account_report_service as ars

    prev = await ars.previous_report(db, row.account_id, exclude_id=row.id)
    if prev is None:
        return None
    return ars.compare_snapshots(prev.summary, row.summary or {},
                                 same_scope=prev.scope_key == row.scope_key)


def _advance(sched, plan: Dict[str, Any], now: datetime, status: str, message: str) -> None:
    sched.next_run_at = plan["next_run_at"]
    sched.last_run_at = now
    sched.last_status = status
    sched.last_message = message[:2000]


async def _advance_fresh(schedule_id, plan, now, status, message) -> None:
    from app.core.database import AsyncSessionLocal
    from app.models.account_report import CloudAccountReportSchedule

    async with AsyncSessionLocal() as db:
        sched = await db.get(CloudAccountReportSchedule, schedule_id)
        if sched is not None:
            _advance(sched, plan, now, status, message)
            await db.commit()


async def _record_failure(schedule_id, plan, now, run_key: str, message: str) -> None:
    """Advance the schedule AND take the run's slot with a FAILED row, in one
    transaction, so a broken report is neither retried in a loop nor lost."""
    from app.core.database import AsyncSessionLocal
    from app.models.account_report import CloudAccountReportSchedule
    from app.services import account_report_service as ars

    async with AsyncSessionLocal() as db:
        sched = await db.get(CloudAccountReportSchedule, schedule_id)
        if sched is None:
            return
        try:
            fmt = (sched.config or {}).get("layout", {}).get("format") or "pdf"
            row = await ars.record_failure(db, sched.account_id, fmt=fmt, schedule=sched,
                                           run_key=run_key, error=message,
                                           template_name=sched.template_name)
            sched.last_report_id = row.id
        except Exception:  # noqa: BLE001 -- the advance below must still happen
            await db.rollback()
            sched = await db.get(CloudAccountReportSchedule, schedule_id)
        _advance(sched, plan, now, "FAILED", message)
        await db.commit()


async def scheduler_loop() -> None:
    _stop.clear()
    logger.info("Account report scheduler running (tick %ss).", TICK_SECONDS)
    while not _stop.is_set():
        try:
            outcomes = await run_due()
            if outcomes:
                logger.info("Account report scheduler: %s", outcomes)
        except Exception:  # noqa: BLE001 -- the loop must survive any one tick
            logger.exception("Account report scheduler tick failed")
        try:
            await asyncio.wait_for(_stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
