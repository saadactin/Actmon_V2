"""The automatic-refresh scheduler.

Same shape as the two background loops this service already runs (the audit
event collector and the alert engine): one asyncio task started in the app
lifespan, waking on a fixed tick and asking the database what is due. No second
scheduler framework, no cron, no `setInterval` pretending to be one.

Three behaviours worth stating, because each has a wrong version that looks
identical until it bites:

**Claiming is atomic.** A due schedule is claimed with a conditional UPDATE
that both advances `next_run_at` and checks nobody else already did. Two
workers racing the same account therefore produce one winner and one no-op,
without a distributed lock. The account's refresh lock in
`account_refresh_service` is the second line of defence, not the first.

**A missed window runs once, not N times.** If the process was down from 02:00
to 08:00, a daily schedule does NOT fire six times catching up. `next_run_at`
is recomputed forward from now, so the account refreshes once on recovery and
then resumes its normal cadence. Replaying missed runs against a provider API
is how a restart becomes a throttling incident.

**A failed run does not stop the schedule.** The next run is computed whatever
the outcome. A schedule that silently stopped after one bad night is worse than
one that keeps trying and keeps recording failures where somebody can see them.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update

from app.models.account_refresh import (
    REFRESH_ACTIVE, TRIGGER_SCHEDULED, CloudAccountRefresh,
    CloudAccountRefreshSchedule,
)
from app.services.account_refresh_service import (
    AccountRefreshService, RefreshError, compute_next_run,
)

logger = logging.getLogger("cloud_svc.refresh.scheduler")

# How often to ask "is anything due". One minute is fine — schedules are
# hourly at their most frequent, so this is never the limiting factor, and a
# tick that finds nothing is a single indexed query.
TICK_SECONDS = 60

# How many accounts may refresh concurrently from ONE scheduler pass. Without
# this, a hundred accounts all set to 02:00 would launch a hundred simultaneous
# provider sweeps — a self-inflicted denial of service against both this
# backend and the providers' rate limits.
MAX_CONCURRENT = int(os.getenv("REFRESH_SCHEDULER_CONCURRENCY", "3"))

_stop = asyncio.Event()
_last_pass: Dict[str, Any] = {"at": None, "started": 0, "skipped": 0, "error": None}


def scheduler_enabled() -> bool:
    return (os.getenv("REFRESH_SCHEDULER_ENABLED", "true").strip().lower()
            not in ("false", "0", "no", "off"))


def scheduler_status() -> Dict[str, Any]:
    """Only what is actually measured — no invented health."""
    return {
        "enabled": scheduler_enabled(),
        "running": not _stop.is_set(),
        "tick_seconds": TICK_SECONDS,
        "max_concurrent": MAX_CONCURRENT,
        "last_pass_at": _last_pass["at"],
        "last_pass_started": _last_pass["started"],
        "last_pass_skipped": _last_pass["skipped"],
        "last_error": _last_pass["error"],
    }


async def _claim(db, schedule: CloudAccountRefreshSchedule,
                 now: datetime) -> bool:
    """Atomically take ownership of a due schedule.

    The WHERE clause repeats `next_run_at <= now`, so a second worker that read
    the same row a moment earlier updates zero rows and walks away. Advancing
    the time here — before the refresh runs — is deliberate: it means a crash
    mid-refresh loses one cycle rather than re-firing on every tick forever.
    """
    following = compute_next_run(schedule, after=now)
    result = await db.execute(
        update(CloudAccountRefreshSchedule)
        .where(CloudAccountRefreshSchedule.id == schedule.id,
               CloudAccountRefreshSchedule.enabled.is_(True),
               CloudAccountRefreshSchedule.next_run_at.isnot(None),
               CloudAccountRefreshSchedule.next_run_at <= now)
        .values(next_run_at=following)
    )
    await db.commit()
    return bool(result.rowcount)


async def run_due(*, limit: int = 50) -> Dict[str, int]:
    """One pass: find due schedules, claim them, refresh them."""
    from app.core.database import AsyncSessionLocal

    now = datetime.now(timezone.utc)
    started = skipped = 0

    async with AsyncSessionLocal() as db:
        due: List[CloudAccountRefreshSchedule] = list((await db.execute(
            select(CloudAccountRefreshSchedule)
            .where(CloudAccountRefreshSchedule.enabled.is_(True),
                   CloudAccountRefreshSchedule.next_run_at.isnot(None),
                   CloudAccountRefreshSchedule.next_run_at <= now)
            .order_by(CloudAccountRefreshSchedule.next_run_at)
            .limit(limit)
        )).scalars().all())

        if not due:
            return {"started": 0, "skipped": 0}

        semaphore = asyncio.Semaphore(MAX_CONCURRENT)

        async def one(schedule: CloudAccountRefreshSchedule) -> str:
            async with AsyncSessionLocal() as own:
                if not await _claim(own, schedule, now):
                    return "skipped"
                try:
                    await AccountRefreshService(own).start(
                        schedule.account_id,
                        trigger_type=TRIGGER_SCHEDULED,
                        actor="scheduler")
                    return "started"
                except RefreshError as exc:
                    # Almost always "already running" — a manual refresh the
                    # user kicked off a minute earlier. Not an error: the
                    # account IS being refreshed, just not by us.
                    logger.info(
                        "Scheduled refresh for account %s skipped: %s",
                        schedule.account_id, exc.message)
                    return "skipped"
                except Exception:  # noqa: BLE001 — one account must not stop the rest
                    logger.exception(
                        "Scheduled refresh failed to start for account %s",
                        schedule.account_id)
                    return "skipped"

        async def guarded(schedule):
            async with semaphore:
                return await one(schedule)

        for outcome in await asyncio.gather(*(guarded(s) for s in due),
                                            return_exceptions=True):
            if outcome == "started":
                started += 1
            else:
                skipped += 1

    return {"started": started, "skipped": skipped}


async def scheduler_loop() -> None:
    _stop.clear()
    logger.info("Account refresh scheduler started (tick=%ss, concurrency=%s).",
                TICK_SECONDS, MAX_CONCURRENT)
    while not _stop.is_set():
        try:
            result = await run_due()
            _last_pass.update({
                "at": datetime.now(timezone.utc).isoformat(),
                "started": result["started"], "skipped": result["skipped"],
                "error": None,
            })
            if result["started"]:
                logger.info("Refresh scheduler started %d account refresh(es).",
                            result["started"])
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a bad pass must not kill the loop
            logger.exception("Refresh scheduler pass failed")
            _last_pass.update({
                "at": datetime.now(timezone.utc).isoformat(),
                "error": f"{type(exc).__name__}: {exc}",
            })
        try:
            await asyncio.wait_for(_stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
    logger.info("Account refresh scheduler stopped.")


def stop_scheduler() -> None:
    _stop.set()


async def release_orphaned_refreshes() -> int:
    """Fail refreshes left RUNNING by a process that died.

    Called once at startup, for the same reason discovery releases orphaned
    scan jobs: a refresh row stuck in RUNNING holds its account's lock forever,
    so every later refresh — manual or scheduled — is refused with "already
    running" by a job nobody is running.
    """
    from app.core.database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            update(CloudAccountRefresh)
            .where(CloudAccountRefresh.status.in_(REFRESH_ACTIVE))
            .values(
                status="FAILED",
                completed_at=datetime.now(timezone.utc),
                error=("Interrupted: the service restarted while this refresh "
                       "was running, so its outcome is unknown."),
                error_code="interrupted",
            )
        )
        await db.commit()
        return result.rowcount or 0
