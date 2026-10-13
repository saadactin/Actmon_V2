"""The loop that takes elevated access away again.

A just-in-time elevation is only as good as its expiry, and an expiry is only
real if something enforces it. Without this loop, "30 minutes of Owner" is
"Owner, and a note in a database saying it should have ended".

**It runs even when execution is disabled**, and that is deliberate. With
`CIEM_ENABLE_WRITE` unset the loop cannot remove the grant from the provider —
but it CAN mark the session overdue and record that the elevation is still
live, which is what puts it on the Identity & Access tab's overdue list and in
the audit log. A deployment that cannot revoke must at least be able to say so;
silently letting the row sit as ACTIVE forever would make the feature a liar.

**Failure is retried, not swallowed.** `due_sessions` selects on
`revoke_confirmed_at IS NULL`, so a session whose revocation failed comes back
on the next tick with its attempt counter incremented. The alternative — mark
it EXPIRED and move on — leaves standing admin access behind a row that claims
it has gone.

The interval is short on purpose. A 5-minute sweep means the worst case for a
30-minute grant is 35 minutes, which is a different thing from a grant that
never ends.
"""
from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger("cloud_svc.identity.jit")

_stop = asyncio.Event()

DEFAULT_INTERVAL_S = 300
MIN_INTERVAL_S = 30


def scheduler_enabled() -> bool:
    """Whether the expiry loop runs.

    Defaults to ON — unlike the report scheduler, which can email people, this
    loop's job is to REMOVE access, and the safe default for that is to run.
    An operator who turns it off is choosing to leave elevations in place.
    """
    raw = os.getenv("CIEM_JIT_EXPIRY_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() in ("true", "1", "yes", "on")


def interval_seconds() -> int:
    try:
        value = int(os.getenv("CIEM_JIT_EXPIRY_INTERVAL_S") or DEFAULT_INTERVAL_S)
    except ValueError:
        return DEFAULT_INTERVAL_S
    return max(MIN_INTERVAL_S, value)


def stop_scheduler() -> None:
    _stop.set()


async def scheduler_loop() -> None:
    """Sweep for due sessions until cancelled."""
    _stop.clear()
    interval = interval_seconds()
    logger.info("JIT expiry scheduler started (every %ds).", interval)

    while not _stop.is_set():
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a bad tick must not end the loop
            logger.exception("JIT expiry sweep failed: %s", exc)
        try:
            await asyncio.wait_for(_stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
    logger.info("JIT expiry scheduler stopped.")


async def _tick() -> None:
    from app.core.database import AsyncSessionLocal
    from app.services.identity_workflow_service import IdentityWorkflowService

    async with AsyncSessionLocal() as db:
        service = IdentityWorkflowService(db)
        result = await service.expire_due_sessions()

    if result.get("due"):
        logger.info("JIT expiry: %d due, %d revoked, %d failed.",
                    result["due"], result["revoked"], result["failed"])
    if result.get("failed"):
        # The dangerous state deserves a warning in its own right, not a line
        # buried in an info message.
        logger.warning(
            "%d JIT session(s) are past expiry and NOT confirmed revoked on the "
            "provider. They may still grant access.%s",
            result["failed"],
            "" if result.get("write_enabled") else
            " Execution is disabled (CIEM_ENABLE_WRITE is not set), so this platform "
            "cannot remove them; they must be revoked by hand.",
        )
