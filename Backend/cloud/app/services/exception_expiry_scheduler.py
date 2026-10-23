"""The loop that ends risk acceptances when their review date arrives.

A review date only means something if something enforces it. `persist_findings`
reopens a lapsed acceptance when an assessment re-detects the finding, but that
alone would make expiry depend on scans succeeding — and the account this was
built against had not completed a sweep in six weeks. So this loop reopens
every lapsed decision on a timer, then re-assesses each affected account so its
score and alerts reflect the reopened findings without waiting for a scan.

**It runs by default**, for the same reason as the JIT expiry loop: its job is
to take an exception AWAY, and the safe default for that is on. An operator who
disables it is choosing to let accepted risks outlive their approval.
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("cloud_svc.security.exceptions")

_stop = asyncio.Event()

DEFAULT_INTERVAL_S = 3600
MIN_INTERVAL_S = 60


def scheduler_enabled() -> bool:
    raw = os.getenv("SECURITY_EXCEPTION_EXPIRY_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() in ("true", "1", "yes", "on")


def interval_seconds() -> int:
    try:
        value = int(os.getenv("SECURITY_EXCEPTION_EXPIRY_INTERVAL_S") or DEFAULT_INTERVAL_S)
    except ValueError:
        return DEFAULT_INTERVAL_S
    return max(MIN_INTERVAL_S, value)


def stop_scheduler() -> None:
    _stop.set()


async def scheduler_loop() -> None:
    _stop.clear()
    interval = interval_seconds()
    logger.info("Security exception expiry scheduler started (every %ds).", interval)

    while not _stop.is_set():
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a bad tick must not end the loop
            logger.exception("Security exception expiry sweep failed: %s", exc)
        try:
            await asyncio.wait_for(_stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
    logger.info("Security exception expiry scheduler stopped.")


async def run_once(account_id=None) -> dict:
    """One sweep. Returns {lapsed, accounts, reassessed} for tests and logs.

    `account_id` confines the sweep to one account; the loop never passes it.
    It exists so a test can drive this exact code against its own fixture
    without lapsing anything on a real account.
    """
    from app.core.database import AsyncSessionLocal
    from app.repository.security_repo import SecurityRepository
    from app.services.security_center_service import SecurityCenterService

    async with AsyncSessionLocal() as db:
        rows = await SecurityRepository(db).lapse_expired_exceptions(account_id=account_id)
        accounts = sorted({r.account_id for r in rows}, key=str)
        await db.commit()

    reassessed = 0
    for account_id in accounts:
        # Separate session per account: one account's failure must not roll
        # back another's re-assessment. A PARTIAL inventory still produces a
        # PARTIAL assessment here, which resolves nothing — the reopened
        # findings simply count again.
        async with AsyncSessionLocal() as db:
            try:
                await SecurityCenterService(db).assess(
                    account_id, triggered_by="exception-review")
                reassessed += 1
            except Exception:  # noqa: BLE001
                logger.exception("Re-assessment after exception expiry failed for %s",
                                 account_id)

    if rows:
        logger.info("Exception expiry: %d decision(s) lapsed across %d account(s); "
                    "%d re-assessed.", len(rows), len(accounts), reassessed)
    return {"lapsed": len(rows), "accounts": len(accounts), "reassessed": reassessed}
