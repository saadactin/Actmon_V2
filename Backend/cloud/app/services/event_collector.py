"""Audit-event ingestion: the checkpointed collector.

This is the write side of the Event Log. It runs in three ways, all of which
funnel into `collect_account`:

*   **Periodically**, from a background task started in app/main.py's lifespan.
*   **After a discovery scan**, fire-and-forget, so opening the Event Log right
    after a scan shows the activity that scan just observed the results of.
*   **On demand**, from `POST /cloud/events/collect`.

The rules it exists to enforce, each of which was a real failure mode in this
codebase's history or is one the specification calls out explicitly:

1.  **A checkpoint advances only for a scope that completed.** A partial read
    leaves it where it was. Re-reading a window costs duplicate inserts that
    the unique constraint discards; skipping one loses audit events with no
    trace, which is the single outcome an audit system may not have. Same
    lesson as the partial-scan prune bug: never treat "absent from this sweep"
    as "absent from reality".

2.  **A failure is recorded, never swallowed.** Every scope's outcome lands in
    `cloud_event_sync_state` with its error and kind. This is the fix the cost
    cache needed: a provider error that returns an empty list and is cached as
    a successful empty result is indistinguishable, to the user, from "nothing
    happened".

3.  **The checkpoint is set from the newest event actually seen, not from
    `now()`.** Providers deliver events late — Azure's submission timestamp
    routinely trails its event timestamp — and a `now()` checkpoint silently
    skips whatever arrives after it passes.

4.  **One account at a time per account.** Two overlapping collections of the
    same scope would both read the same window; the dedup constraint makes
    that safe but not free, so a lock keeps it from happening.
"""
from __future__ import annotations

import asyncio
import logging
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.core.database import AsyncSessionLocal
from app.events.adapters import adapter_for, provider_label
from app.events.adapters.base import (
    ERROR_AUTH,
    ERROR_DENIED,
    ERROR_UNAVAILABLE,
    EventAdapter,
    ScopeResult,
    classify_error,
)
from app.models.event_admin import (
    ACCESS_RETENTION_PRUNE,
    SYNC_AUTH_FAILED,
    SYNC_CONNECTED,
    SYNC_DELAYED,
    SYNC_PERMISSION_DENIED,
    SYNC_UNAVAILABLE,
)
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.event_repo import EventRepository

logger = logging.getLogger("cloud_svc.events.collector")

# One collection at a time per account. In-process, which is correct for this
# service — discovery uses the same pattern (a module-level task set) because
# there is one process, no Celery and no Redis.
_locks: Dict[uuid.UUID, asyncio.Lock] = {}
_running: set = set()

# How many scopes one run will touch per (account, provider). OCI can present
# hundreds of region×compartment scopes; sweeping all of them every run turns a
# 15-minute interval into a much longer one and starves the next. Scopes are
# taken least-recently-attempted-first (see EventRepository.stale_scopes), so
# every scope comes round — bounded progress that always advances beats an
# unbounded run that gets cut off.
_MAX_SCOPES_PER_RUN = {
    "AWS": 20,      # ~the full enabled-region list, which is cheap enough
    "Azure": 4,     # one subscription scope; the headroom is for future ones
    "OCI": 12,      # region × compartment fan-out, rotated
}

# The widest window a single request will ask a provider for. A scope that has
# not been collected for a fortnight would otherwise ask for a fortnight at
# once — which OCI rejects outright, and which on AWS is thousands of pages.
# Successive runs walk forward instead.
_MAX_CATCHUP = timedelta(days=7)

# Overlap re-read on every incremental run. Providers index events by their own
# event time and can make one visible slightly after that time has passed, so
# resuming exactly at the checkpoint can miss a late arrival. The overlap costs
# a handful of duplicate inserts, which the unique constraint discards.
_OVERLAP = timedelta(minutes=5)


def _lock_for(account_id: uuid.UUID) -> asyncio.Lock:
    lock = _locks.get(account_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[account_id] = lock
    return lock


class CollectionOutcome(dict):
    """A plain dict, named so the return shape is findable from a call site."""


async def collect_account(
    account_id: uuid.UUID,
    *,
    lookback_hours: Optional[int] = None,
    scopes: Optional[List[str]] = None,
) -> CollectionOutcome:
    """Collect one account's audit events. Never raises for a provider failure.

    `lookback_hours` forces a window instead of using the checkpoint — used by
    a manual "collect now" that wants a known window, and by the very first
    collection where there is no checkpoint yet.
    """
    lock = _lock_for(account_id)
    if lock.locked():
        return CollectionOutcome(
            account_id=str(account_id),
            skipped=True,
            reason="A collection for this account is already running.",
        )

    async with lock:
        async with AsyncSessionLocal() as db:
            repo = EventRepository(db)
            accounts = CloudAccountRepository(db)

            account = await accounts.get_by_id(account_id)
            if account is None:
                return CollectionOutcome(
                    account_id=str(account_id), error="Account not found."
                )

            settings = await repo.get_settings()
            collect_read_only = settings.collect_read_only
            initial_lookback = lookback_hours or settings.initial_lookback_hours
            await db.commit()

            provider = provider_label(account.provider)

            # ── Build the adapter ────────────────────────────────────────────
            try:
                from app.utils.encryption import decrypt_credentials

                credentials = decrypt_credentials(account.credentials_enc)
            except Exception as exc:
                # A key mismatch is a real, recurring condition in this project
                # (each clone has its own ACTMON_ENCRYPTION_KEY), and it is an
                # auth failure rather than an outage — saying so sends the
                # reader to the right fix.
                await _mark_provider_failure(
                    repo, db, account_id, provider,
                    f"Could not decrypt stored credentials: {exc}", ERROR_AUTH,
                )
                return CollectionOutcome(
                    account_id=str(account_id), provider=provider,
                    error=f"Credential decryption failed: {exc}",
                )

            adapter = adapter_for(
                account.provider, credentials, collect_read_only=collect_read_only
            )
            if adapter is None:
                return CollectionOutcome(
                    account_id=str(account_id),
                    error=f"No audit adapter for provider {account.provider!r}.",
                )

            try:
                await adapter.authenticate()
            except Exception as exc:
                kind = classify_error(exc)
                await _mark_provider_failure(
                    repo, db, account_id, provider, f"{type(exc).__name__}: {exc}", kind
                )
                return CollectionOutcome(
                    account_id=str(account_id), provider=provider,
                    error=f"Authentication failed: {exc}", error_kind=kind,
                )

            # ── Decide which scopes to read ──────────────────────────────────
            try:
                all_scopes = await adapter.scopes()
            except Exception as exc:
                kind = classify_error(exc)
                await _mark_provider_failure(
                    repo, db, account_id, provider,
                    f"Scope enumeration failed: {exc}", kind,
                )
                return CollectionOutcome(
                    account_id=str(account_id), provider=provider,
                    error=f"Could not enumerate collection scopes: {exc}",
                    error_kind=kind,
                )

            # Register every scope so the rotation and the health view know the
            # full set, even the ones this run will not reach.
            for scope in all_scopes:
                await repo.upsert_sync_state(account_id, provider, scope)
            await db.commit()

            if scopes:
                target = [s for s in scopes if s in all_scopes]
            else:
                budget = _MAX_SCOPES_PER_RUN.get(provider, 10)
                rotated = await repo.stale_scopes(account_id, provider, limit=budget)
                # Preserve the adapter's own ordering within the slice: AWS puts
                # us-east-1 first and OCI puts the root compartment first
                # because those carry the IAM activity, and losing that ordering
                # would mean a cut-short run misses the most important scope.
                target = [s for s in all_scopes if s in set(rotated)] or all_scopes[:budget]

            # ── Read them ────────────────────────────────────────────────────
            now = datetime.now(timezone.utc)
            totals = {
                "received": 0, "stored": 0, "duplicates": 0, "malformed": 0,
                "api_calls": 0, "api_errors": 0, "rate_limits": 0,
                "scopes_ok": 0, "scopes_failed": 0,
            }
            errors: List[Dict[str, str]] = []

            for scope in target:
                state = await repo.upsert_sync_state(account_id, provider, scope)
                start, end = _window_for(
                    state.checkpoint, now, initial_lookback,
                    adapter.provider_retention_days,
                    force_lookback_hours=lookback_hours,
                )

                state.last_attempt_at = now
                await db.commit()

                started = asyncio.get_event_loop().time()
                try:
                    result = await adapter.collect_scope(scope, start, end)
                except Exception as exc:
                    # collect_scope is documented not to raise for an expected
                    # failure, so reaching here is a bug in an adapter. It must
                    # still not lose the other scopes.
                    logger.error(
                        "Adapter %s raised for scope %s: %s",
                        provider, scope, exc, exc_info=True,
                    )
                    result = ScopeResult(
                        scope=scope, events=[], complete=False,
                        error=f"{type(exc).__name__}: {exc}",
                        error_kind=classify_error(exc), api_errors=1,
                    )
                elapsed = asyncio.get_event_loop().time() - started

                stored, duplicates = await repo.insert_events(account_id, result.events)

                totals["received"] += len(result.events)
                totals["stored"] += stored
                totals["duplicates"] += duplicates
                totals["malformed"] += result.malformed
                totals["api_calls"] += result.api_calls
                totals["api_errors"] += result.api_errors
                totals["rate_limits"] += result.rate_limit_hits

                _apply_result(
                    state, result, now=now, elapsed=elapsed, window_end=end,
                    stored=stored, duplicates=duplicates,
                    backfill=bool(lookback_hours),
                )

                if result.complete:
                    totals["scopes_ok"] += 1
                else:
                    totals["scopes_failed"] += 1
                    if result.error:
                        errors.append({"scope": scope, "error": result.error})

                await db.commit()

            # ── Retention ────────────────────────────────────────────────────
            pruned = 0
            try:
                pruned = await prune_retention(repo, db, actor="collector")
                await db.commit()
            except Exception as exc:
                # Retention housekeeping must never fail a collection: the
                # events are already stored and that is the part that matters.
                await db.rollback()
                logger.warning("Event retention prune failed: %s", exc)

            logger.info(
                "Event collection %s account=%s: %d stored, %d duplicate, "
                "%d scope(s) ok, %d scope(s) failed, %d pruned",
                provider, account_id, totals["stored"], totals["duplicates"],
                totals["scopes_ok"], totals["scopes_failed"], pruned,
            )

            return CollectionOutcome(
                account_id=str(account_id),
                provider=provider,
                scopes_attempted=len(target),
                scopes_total=len(all_scopes),
                events_received=totals["received"],
                events_stored=totals["stored"],
                events_duplicate=totals["duplicates"],
                events_malformed=totals["malformed"],
                api_calls=totals["api_calls"],
                api_errors=totals["api_errors"],
                rate_limit_hits=totals["rate_limits"],
                scopes_ok=totals["scopes_ok"],
                scopes_failed=totals["scopes_failed"],
                events_pruned=pruned,
                # Capped: a hundred failing OCI compartments would otherwise
                # return a hundred near-identical strings.
                errors=errors[:10],
            )


def _window_for(
    checkpoint: Optional[datetime],
    now: datetime,
    initial_lookback_hours: int,
    provider_retention_days: int,
    force_lookback_hours: Optional[int] = None,
) -> tuple:
    """The [start, end] to ask the provider for.

    Two modes:

    **Incremental** (the background collector). Resume from the checkpoint,
    with three clamps, each for a concrete failure:

    *   No checkpoint → the configured initial lookback, not "everything the
        provider has". A cold start over 90 days of a busy account is tens of
        thousands of API calls, and paying that should be a choice.
    *   A checkpoint older than the provider's retention → clamped to
        retention. Asking for older returns nothing, so the request would be
        pure waste and the checkpoint would never move.
    *   A gap wider than the catch-up cap → one cap-width slice. The rest is
        collected by the following runs, so a service that was down for a month
        walks forward instead of failing on an over-wide request forever.

    **Forced backfill** (`force_lookback_hours`, from an explicit "collect this
    window" request). Reads [now - lookback, now] and *ignores the checkpoint
    entirely* — which is the whole point, since a checkpoint at the present is
    exactly what prevents reaching into the past.

    That mode did not previously exist. `lookback_hours` was accepted by the
    collect endpoint and documented as "force a window instead of resuming from
    the checkpoint", but it was only ever read on the `checkpoint is None`
    branch, so once a scope had run once the parameter silently did nothing.
    The visible symptom: selecting a 7-day range and pressing "Collect now"
    fetched only new events, never the older ones, and there was no way at all
    to back-fill history.

    The catch-up cap is also skipped here: the caller has asked for this window
    and the per-scope page budget still bounds the work. Retention is still a
    hard clamp — no provider will serve older than that.
    """
    retention_floor = now - timedelta(days=provider_retention_days)

    if force_lookback_hours:
        start = now - timedelta(hours=max(1, force_lookback_hours))
        if start < retention_floor:
            start = retention_floor
        return start, now

    if checkpoint is None:
        start = now - timedelta(hours=max(1, initial_lookback_hours))
    else:
        start = checkpoint - _OVERLAP

    if start < retention_floor:
        start = retention_floor

    end = min(now, start + _MAX_CATCHUP)
    if end <= start:
        end = now
    return start, end


def _apply_result(
    state,
    result: ScopeResult,
    *,
    now: datetime,
    elapsed: float,
    window_end: datetime,
    stored: int = 0,
    duplicates: int = 0,
    backfill: bool = False,
) -> None:
    """Fold one scope's outcome into its sync-state row.

    The checkpoint decision is the whole point of this function, so it is worth
    being explicit about all three branches:

    *   Complete, with events  → advance to the newest event seen. Not to
        `window_end`: an event whose provider-side visibility lags could still
        appear before that instant, and the overlap on the next run is what
        catches it.
    *   Complete, no events    → advance to `window_end`. The window was fully
        read and genuinely held nothing, so re-reading it forever would mean the
        checkpoint never moves on a quiet account.
    *   Incomplete             → do not advance at all, whatever was collected.
        The unread remainder is inside this window.

    A checkpoint also never moves BACKWARDS. A forced backfill reads an old
    window, so its watermark is older than where incremental collection has
    already reached; writing that back would make the next scheduled run
    re-read everything in between. Harmless in terms of data (the unique
    constraint discards the duplicates) but it would throw away real progress
    and spend the provider's API budget on it.
    """

    def advance(to: Optional[datetime]) -> None:
        if to is None:
            return
        if state.checkpoint is None or to > state.checkpoint:
            state.checkpoint = to
        elif not backfill:
            # Incremental collection reporting an older watermark than the
            # checkpoint would be a bug worth seeing rather than silently
            # ignoring; a backfill doing it is expected and needs no note.
            logger.debug(
                "Scope %s: watermark %s is not newer than checkpoint %s — held.",
                result.scope, to, state.checkpoint,
            )

    state.events_received = (state.events_received or 0) + len(result.events)
    # `received` is what the provider handed over; `stored` is what survived
    # deduplication and `duplicate` is the rest. All three come from the insert,
    # not from the adapter, which is why they are passed in — an earlier version
    # only recorded `received`, so the collection-health panel reported
    # "0 stored" beside 154 rows that were demonstrably on disk.
    state.events_stored = (state.events_stored or 0) + max(0, stored)
    state.events_duplicate = (state.events_duplicate or 0) + max(0, duplicates)
    state.api_calls = (state.api_calls or 0) + result.api_calls
    state.api_errors = (state.api_errors or 0) + result.api_errors
    state.rate_limit_hits = (state.rate_limit_hits or 0) + result.rate_limit_hits
    state.events_failed = (state.events_failed or 0) + result.malformed
    state.last_latency_s = elapsed
    if state.max_latency_s is None or elapsed > state.max_latency_s:
        state.max_latency_s = elapsed

    if result.complete:
        advance(result.watermark or window_end)
        state.last_success_at = now
        state.consecutive_failures = 0
        state.last_error = None
        state.status = SYNC_CONNECTED
        return

    # Incomplete. The checkpoint stands.
    state.consecutive_failures = (state.consecutive_failures or 0) + 1
    state.last_error = (result.error or "Incomplete read")[:4000]

    if result.error_kind == ERROR_DENIED:
        state.status = SYNC_PERMISSION_DENIED
    elif result.error_kind == ERROR_AUTH:
        state.status = SYNC_AUTH_FAILED
    elif result.error_kind == ERROR_UNAVAILABLE:
        state.status = SYNC_UNAVAILABLE
    else:
        # A page-budget stop is not a fault: the read was bounded on purpose
        # and will continue next run. "Delayed" says exactly that, and keeps it
        # out of the failing-scope count the UI paints red.
        state.status = SYNC_DELAYED
        state.consecutive_failures = 0
        state.last_success_at = now
        if result.watermark:
            # A bounded stop DID read everything up to its watermark, in order,
            # so advancing to it is safe and is what lets a large backlog drain
            # across successive runs instead of restarting each time.
            advance(result.watermark)


async def _mark_provider_failure(
    repo: EventRepository,
    db,
    account_id: uuid.UUID,
    provider: str,
    error: str,
    kind: str,
) -> None:
    """Record a failure that happened before any scope could be read.

    Without this an auth or credential failure leaves every scope showing its
    last good state and the UI reports the source as healthy while nothing is
    being collected — the exact "empty table reads as no activity" trap.
    """
    status = {
        ERROR_DENIED: SYNC_PERMISSION_DENIED,
        ERROR_AUTH: SYNC_AUTH_FAILED,
        ERROR_UNAVAILABLE: SYNC_UNAVAILABLE,
    }.get(kind, SYNC_UNAVAILABLE)

    now = datetime.now(timezone.utc)
    states = await repo.list_sync_states(account_id)
    scoped = [s for s in states if s.provider == provider]
    if not scoped:
        # Nothing registered yet (first-ever run failed at auth). Register a
        # placeholder so the account still appears in the health view.
        scoped = [await repo.upsert_sync_state(account_id, provider, "account")]

    for state in scoped:
        state.status = status
        state.last_attempt_at = now
        state.last_error = error[:4000]
        state.consecutive_failures = (state.consecutive_failures or 0) + 1
    await db.commit()


async def prune_retention(repo: EventRepository, db, *, actor: str) -> int:
    """Delete events older than the configured application retention.

    The one sanctioned delete path. It is audited in the access log because
    removing audit data is itself a privileged act, and an unaudited pruner is
    a way to make evidence disappear without a trace.
    """
    settings = await repo.get_settings()
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.retention_days)
    removed = await repo.prune_older_than(cutoff)
    if removed:
        await repo.record_access(
            ACCESS_RETENTION_PRUNE,
            actor=actor,
            target="cloud_events",
            detail={
                "retention_days": settings.retention_days,
                "cutoff": cutoff.isoformat(),
                "rows_deleted": removed,
            },
        )
        logger.info(
            "Pruned %d event(s) older than %d days (cutoff %s).",
            removed, settings.retention_days, cutoff.isoformat(),
        )
    return removed


async def collect_all_accounts(*, only_auto: bool = True) -> List[CollectionOutcome]:
    """Collect for every registered account, one after another.

    Sequential across accounts as well as within one. Two accounts collecting
    at once share the scan thread pool with any running discovery sweep, and
    all three providers' audit APIs are quota-limited per account but the
    network is shared — the same reasoning that keeps the OCI scanner at
    concurrency 8.
    """
    async with AsyncSessionLocal() as db:
        accounts = await CloudAccountRepository(db).list_all()

    outcomes: List[CollectionOutcome] = []
    for account in accounts:
        if only_auto and not account.auto_discovery:
            continue
        try:
            outcomes.append(await collect_account(account.id))
        except Exception as exc:
            logger.error(
                "Event collection crashed for account %s: %s",
                account.id, exc, exc_info=True,
            )
            outcomes.append(
                CollectionOutcome(account_id=str(account.id), error=str(exc))
            )
    return outcomes


# ── The background loop ───────────────────────────────────────────────────────


async def collector_loop() -> None:
    """Periodic collection, started from app/main.py's lifespan.

    Reads its interval from the settings row on every pass, so changing the
    interval in the UI takes effect on the next cycle rather than needing a
    restart. Jittered, so a fleet of these does not synchronise onto the same
    second.

    Every exception is caught and logged. A collector that dies silently is
    worse than one that logs a failure each cycle: the first looks like a quiet
    account forever.
    """
    # An initial delay so a service still opening database connections and
    # creating tables is not also making provider API calls.
    await asyncio.sleep(30 + random.uniform(0, 15))

    while True:
        interval_minutes = 15
        enabled = True
        try:
            async with AsyncSessionLocal() as db:
                settings = await EventRepository(db).get_settings()
                interval_minutes = max(1, settings.collection_interval_minutes)
                enabled = settings.collection_enabled
                await db.commit()
        except Exception as exc:
            logger.warning(
                "Event collector could not read its settings (%s) — retrying with "
                "the default interval.", exc,
            )

        if enabled:
            try:
                await collect_all_accounts(only_auto=True)
            except Exception as exc:
                logger.error("Event collector cycle failed: %s", exc, exc_info=True)
        else:
            logger.debug("Automatic event collection is disabled in settings.")

        await asyncio.sleep(interval_minutes * 60 + random.uniform(0, 20))


def schedule_after_discovery(account_id: uuid.UUID) -> None:
    """Fire-and-forget collection after a discovery scan.

    Same pattern as the cost-cache prewarm the discovery worker already uses: a
    strong reference is kept so the event loop does not garbage-collect the
    task mid-run, and it is never awaited, so a slow audit read cannot delay
    the scan reporting itself complete.
    """
    try:
        task = asyncio.create_task(collect_account(account_id))
    except RuntimeError:
        # No running loop — nothing to schedule onto. Only reachable from a
        # synchronous context, which the discovery worker is not.
        logger.debug("No event loop available to schedule event collection.")
        return
    _running.add(task)
    task.add_done_callback(_running.discard)
