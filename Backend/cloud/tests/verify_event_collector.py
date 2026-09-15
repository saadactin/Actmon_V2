"""The collector's reliability contract: checkpointing, failure isolation, retries.

This is where the properties that keep an audit trail complete are decided, and
none of them can be observed from the outside — a lost event looks exactly like
an event that never happened. So they are asserted directly against the
collector, with a fake adapter standing in for the providers.

The invariant everything else serves: **a checkpoint advances only for a scope
that was fully read.** Re-reading a window costs duplicate inserts the unique
constraint discards; skipping one loses audit events permanently.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

from sqlalchemy import text  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.events.adapters.base import (  # noqa: E402
    ERROR_AUTH,
    ERROR_DENIED,
    ERROR_UNAVAILABLE,
    CollectedEvent,
    EventAdapter,
    ScopeResult,
)
from app.events.schema import ensure_append_only  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.event_admin import (  # noqa: E402
    SYNC_CONNECTED,
    SYNC_DELAYED,
    SYNC_NEVER_RUN,
    SYNC_PERMISSION_DENIED,
    SYNC_UNAVAILABLE,
)
from app.repository.event_repo import EventRepository  # noqa: E402
from app.services.event_collector import _apply_result, _window_for  # noqa: E402

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

ok, fail = [], []
NOW = datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


class FlakyAdapter(EventAdapter):
    """A provider that fails in a scripted way, so retries can be counted."""

    provider = "AWS"
    provider_retention_days = 90
    _TRANSIENT_ATTEMPTS = 4

    def __init__(self, failures):
        super().__init__({})
        self.failures = list(failures)
        self.attempts = 0

    async def authenticate(self):
        return True

    async def scopes(self):
        return ["region:test"]

    async def collect_scope(self, scope, start, end):
        return ScopeResult(scope=scope, events=[], complete=True)

    async def try_call(self, counters):
        def _work():
            self.attempts += 1
            if self.failures:
                raise self.failures.pop(0)
            return "done"

        return await self._call(_work, label="test", counters=counters)


async def main() -> int:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await ensure_append_only(conn)

    # ── 1. Window selection ──────────────────────────────────────────────────
    print("1. window selection")

    start, end = _window_for(None, NOW, 24, 90)
    eq("a first-ever collection uses the configured lookback, not all history",
       start, NOW - timedelta(hours=24))
    eq("and ends now", end, NOW)

    checkpoint = NOW - timedelta(hours=1)
    start, end = _window_for(checkpoint, NOW, 24, 90)
    check("an incremental run resumes slightly BEFORE the checkpoint, so a "
          "late-arriving event is not skipped", start < checkpoint,
          f"{start} vs {checkpoint}")
    check("and the overlap is small (minutes, not hours)",
          (checkpoint - start) <= timedelta(minutes=10), checkpoint - start)

    # A checkpoint older than the provider will serve: asking for it is pure
    # waste, and clamping is what lets the checkpoint move again.
    ancient = NOW - timedelta(days=400)
    start, end = _window_for(ancient, NOW, 24, 90)
    check("a checkpoint older than provider retention is clamped to retention",
          start >= NOW - timedelta(days=90, minutes=1), start)

    # A long outage must not produce one enormous request forever.
    stale = NOW - timedelta(days=30)
    start, end = _window_for(stale, NOW, 24, 90)
    check("a 30-day gap is walked forward in bounded slices, not asked for at once",
          (end - start) <= timedelta(days=7, minutes=10), end - start)
    check("and the slice starts at the checkpoint, so nothing is skipped",
          start <= stale, f"{start} vs {stale}")

    # ── Forced backfill ──────────────────────────────────────────────────────
    # The reason this exists: `lookback_hours` was accepted by the collect
    # endpoint and documented as "force a window instead of resuming from the
    # checkpoint", but it was only read on the `checkpoint is None` branch. Once
    # a scope had run once it silently did nothing, so selecting a 7-day range
    # and pressing "Collect now" fetched only new events and there was no way to
    # back-fill history at all.
    print("\n1b. forced backfill ignores the checkpoint")

    current = NOW - timedelta(minutes=5)   # a checkpoint at effectively "now"
    start, end = _window_for(current, NOW, 24, 90, force_lookback_hours=168)
    eq("a forced 7-day lookback starts 7 days ago, not at the checkpoint",
       start, NOW - timedelta(hours=168))
    eq("and runs to now", end, NOW)
    check("so it genuinely reaches behind a present-day checkpoint",
          start < current, f"{start} vs {current}")

    # The catch-up cap must not truncate an explicitly requested window.
    start, end = _window_for(current, NOW, 24, 90, force_lookback_hours=720)
    eq("a forced 30-day lookback is not clipped to the 7-day catch-up cap",
       start, NOW - timedelta(hours=720))

    # Retention is still a hard ceiling — no provider serves older.
    start, end = _window_for(current, NOW, 24, 90, force_lookback_hours=8760)
    check("a forced year on a 90-day provider is clamped to provider retention",
          start >= NOW - timedelta(days=90, minutes=1), start)
    start, end = _window_for(current, NOW, 24, 365, force_lookback_hours=8760)
    check("but OCI's 365 days allows the full year",
          start <= NOW - timedelta(days=364), start)

    # Zero/None must not be treated as a forced window.
    start, end = _window_for(current, NOW, 24, 90, force_lookback_hours=None)
    check("no forced lookback falls back to incremental resume",
          start > current - timedelta(minutes=10), start)
    start, end = _window_for(current, NOW, 24, 90, force_lookback_hours=0)
    check("a zero lookback is not a forced window either",
          start > current - timedelta(minutes=10), start)

    # ── 2. Checkpoint advancement ────────────────────────────────────────────
    print("\n2. checkpoint advancement — the core invariant")

    class FakeState:
        def __init__(self, checkpoint=None):
            self.checkpoint = checkpoint
            self.status = SYNC_NEVER_RUN
            self.last_success_at = None
            self.last_error = None
            self.consecutive_failures = 0
            self.events_received = 0
            self.events_stored = 0
            self.events_duplicate = 0
            self.events_failed = 0
            self.api_calls = 0
            self.api_errors = 0
            self.rate_limit_hits = 0
            self.last_latency_s = None
            self.max_latency_s = None

    window_end = NOW
    newest = NOW - timedelta(minutes=3)

    # (a) complete, with events -> advance to the newest event seen
    state = FakeState(checkpoint=NOW - timedelta(hours=1))
    result = ScopeResult(
        scope="region:test",
        events=[CollectedEvent(provider="AWS", provider_event_id="a",
                               timestamp=newest, event_name="X")],
        complete=True, watermark=newest,
    )
    _apply_result(state, result, now=NOW, elapsed=1.0, window_end=window_end)
    eq("a complete scope advances the checkpoint to the newest event seen",
       state.checkpoint, newest)
    check("NOT to the window end, so a late-visible event is still reachable",
          state.checkpoint != window_end)
    eq("and the scope is Connected", state.status, SYNC_CONNECTED)
    eq("failures reset", state.consecutive_failures, 0)
    check("and the error is cleared", state.last_error is None)

    # (b) complete, no events -> advance to the window end
    state = FakeState(checkpoint=NOW - timedelta(hours=1))
    result = ScopeResult(scope="region:test", events=[], complete=True, watermark=None)
    _apply_result(state, result, now=NOW, elapsed=1.0, window_end=window_end)
    eq("a complete but empty window advances to the window end, so a quiet "
       "account's checkpoint does not stall", state.checkpoint, window_end)
    eq("and it is Connected, not an error", state.status, SYNC_CONNECTED)

    # (c) INCOMPLETE -> the checkpoint must NOT move
    before = NOW - timedelta(hours=1)
    state = FakeState(checkpoint=before)
    result = ScopeResult(
        scope="region:test",
        events=[CollectedEvent(provider="AWS", provider_event_id="b",
                               timestamp=newest, event_name="X")],
        complete=False, watermark=newest,
        error="AccessDenied: not authorized to LookupEvents",
        error_kind=ERROR_DENIED,
    )
    _apply_result(state, result, now=NOW, elapsed=1.0, window_end=window_end)
    eq("a FAILED scope does NOT advance the checkpoint, even though it "
       "collected some events", state.checkpoint, before)
    eq("and its status names the actual cause", state.status, SYNC_PERMISSION_DENIED)
    eq("the failure is counted", state.consecutive_failures, 1)
    check("and the error text is kept for the UI", bool(state.last_error))

    # (d) The three failure kinds map to three distinguishable statuses.
    for kind, want in [
        (ERROR_DENIED, SYNC_PERMISSION_DENIED),
        (ERROR_AUTH, "AuthenticationFailed"),
        (ERROR_UNAVAILABLE, SYNC_UNAVAILABLE),
    ]:
        state = FakeState(checkpoint=before)
        _apply_result(
            state,
            ScopeResult(scope="s", events=[], complete=False, error="e", error_kind=kind),
            now=NOW, elapsed=1.0, window_end=window_end,
        )
        eq(f"{kind} is reported as {want}, not a generic red light",
           state.status, want)
        eq(f"  and {kind} still holds the checkpoint", state.checkpoint, before)

    # (e) A bounded page-budget stop is NOT a fault, and DOES advance — to
    #     what it actually read, so a large backlog drains across runs.
    state = FakeState(checkpoint=before)
    result = ScopeResult(
        scope="region:test", events=[], complete=False, watermark=newest,
        error="Stopped after 40 pages to stay within the API budget",
        error_kind=None,
    )
    _apply_result(state, result, now=NOW, elapsed=1.0, window_end=window_end)
    eq("a page-budget stop is Delayed, not a failure", state.status, SYNC_DELAYED)
    eq("it does not count as a failure", state.consecutive_failures, 0)
    eq("and it advances to what it genuinely read, so the backlog drains",
       state.checkpoint, newest)
    check("but not to the window end — the remainder is still unread",
          state.checkpoint != window_end)

    # (f) Counters accumulate rather than overwrite.
    state = FakeState()
    state.api_calls = 10
    state.events_received = 5
    _apply_result(
        state,
        ScopeResult(scope="s", events=[
            CollectedEvent(provider="AWS", provider_event_id="c",
                           timestamp=newest, event_name="X")],
            complete=True, watermark=newest, api_calls=3, api_errors=1,
            rate_limit_hits=2, malformed=1),
        now=NOW, elapsed=2.5, window_end=window_end,
        stored=1, duplicates=0,
    )
    eq("api_calls accumulate", state.api_calls, 13)
    eq("events_received accumulate", state.events_received, 6)
    eq("rate-limit hits are recorded", state.rate_limit_hits, 2)
    eq("malformed events are counted, not silently dropped", state.events_failed, 1)
    eq("latency recorded", state.last_latency_s, 2.5)
    eq("and the worst-ever latency kept", state.max_latency_s, 2.5)

    # received / stored / duplicate are three different numbers and all three
    # have to move. An earlier version incremented only `received`, so the
    # collection-health panel reported "0 stored" next to 154 rows that were
    # demonstrably in the table — found on live data, not in a test.
    eq("events_stored is recorded, not left at zero", state.events_stored, 1)
    _apply_result(
        state,
        ScopeResult(scope="s", events=[
            CollectedEvent(provider="AWS", provider_event_id="c",
                           timestamp=newest, event_name="X")],
            complete=True, watermark=newest),
        now=NOW, elapsed=1.0, window_end=window_end,
        stored=0, duplicates=1,
    )
    eq("a re-polled duplicate is counted as duplicate", state.events_duplicate, 1)
    eq("and does not inflate the stored count", state.events_stored, 1)
    eq("while received counts everything the provider handed over",
       state.events_received, 7)

    _apply_result(
        state,
        ScopeResult(scope="s", events=[], complete=True, watermark=None),
        now=NOW, elapsed=0.5, window_end=window_end,
    )
    eq("a faster run does not lower the recorded maximum", state.max_latency_s, 2.5)

    # (g) A checkpoint never moves backwards. A backfill reads an OLD window,
    #     so its watermark is behind where incremental collection has reached;
    #     writing it back would make the next scheduled run re-read everything
    #     in between and spend the provider's API budget re-fetching duplicates.
    ahead = NOW - timedelta(minutes=1)
    behind = NOW - timedelta(days=6)
    state = FakeState(checkpoint=ahead)
    _apply_result(
        state,
        ScopeResult(scope="s", events=[
            CollectedEvent(provider="AWS", provider_event_id="old",
                           timestamp=behind, event_name="X")],
            complete=True, watermark=behind),
        now=NOW, elapsed=1.0, window_end=NOW, stored=1, backfill=True,
    )
    eq("a backfill's older watermark does NOT regress the checkpoint",
       state.checkpoint, ahead)
    eq("and the backfilled event is still counted as stored", state.events_stored, 1)
    eq("the scope is still healthy", state.status, SYNC_CONNECTED)

    # Forwards still works, backfill or not.
    newer = NOW
    _apply_result(
        state,
        ScopeResult(scope="s", events=[], complete=True, watermark=newer),
        now=NOW, elapsed=1.0, window_end=NOW, backfill=True,
    )
    eq("a newer watermark still advances it", state.checkpoint, newer)

    # ── 3. Retry behaviour ───────────────────────────────────────────────────
    print("\n3. retries")

    class Transient(Exception):
        pass

    class Denied(Exception):
        pass

    counters = ScopeResult(scope="s", events=[], complete=True)
    adapter = FlakyAdapter([
        Transient("Connection aborted"),
        Transient("SSL: UNEXPECTED_EOF_WHILE_READING"),
    ])
    result = await adapter.try_call(counters)
    eq("a dropped connection is retried until it succeeds", result, "done")
    eq("which took three attempts", adapter.attempts, 3)
    eq("and every attempt was counted as an API call", counters.api_calls, 3)
    eq("with the two failures counted", counters.api_errors, 2)

    counters = ScopeResult(scope="s", events=[], complete=True)
    adapter = FlakyAdapter([Exception("ThrottlingException: Rate exceeded")])
    result = await adapter.try_call(counters)
    eq("throttling is retried too", result, "done")
    eq("and recorded as a rate-limit hit", counters.rate_limit_hits, 1)

    counters = ScopeResult(scope="s", events=[], complete=True)
    adapter = FlakyAdapter([Denied("User is not authorized to perform this operation")])
    try:
        await adapter.try_call(counters)
        check("a denial is NOT retried", False, "it was retried or swallowed")
    except Exception:
        eq("a denial is NOT retried — it is a real answer", adapter.attempts, 1)

    counters = ScopeResult(scope="s", events=[], complete=True)
    adapter = FlakyAdapter([Transient("connection reset")] * 10)
    try:
        await adapter.try_call(counters)
        check("retries are bounded", False, "it never gave up")
    except Exception:
        eq("retries are bounded at the configured attempt count",
           adapter.attempts, adapter._TRANSIENT_ATTEMPTS)

    # ── 4. Failure isolation across scopes ───────────────────────────────────
    print("\n4. one bad scope must not lose the others")

    class PartlyBrokenAdapter(EventAdapter):
        provider = "OCI"
        provider_retention_days = 365

        async def authenticate(self):
            return True

        async def scopes(self):
            return ["region:a|compartment:1", "region:a|compartment:2",
                    "region:a|compartment:3"]

        async def collect_scope(self, scope, start, end):
            if scope.endswith("compartment:2"):
                # A bug in an adapter, not a handled failure — the harshest case.
                raise RuntimeError("adapter bug")
            return ScopeResult(
                scope=scope,
                events=[CollectedEvent(provider="OCI", provider_event_id=f"e-{scope}",
                                       timestamp=NOW, event_name="X")],
                complete=True, watermark=NOW,
            )

    adapter = PartlyBrokenAdapter({})
    results = []
    async for res in adapter.collect(NOW - timedelta(hours=1), NOW):
        results.append(res)

    eq("all three scopes still yielded a result", len(results), 3)
    eq("the two healthy scopes collected their events",
       sum(len(r.events) for r in results), 2)
    broken = [r for r in results if not r.complete]
    eq("the broken scope is reported as incomplete", len(broken), 1)
    check("with its error captured rather than raised out of the loop",
          "adapter bug" in (broken[0].error or ""), broken[0].error)

    # ── 5. Persistence of sync state ─────────────────────────────────────────
    print("\n5. sync state round-trip")

    account_id = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            id=account_id, account_name=f"__collector_{account_id.hex[:8]}",
            provider="OCI", environment="Test", tenant_or_region="ap-mumbai-1",
            auth_mode="API_Keys", auto_discovery=False, credentials_enc="x",
        ))
        await db.commit()

    try:
        async with AsyncSessionLocal() as db:
            repo = EventRepository(db)
            # Register scopes the way collect_account does.
            for scope in ("region:a|compartment:1", "region:a|compartment:2",
                          "region:b|compartment:1"):
                await repo.upsert_sync_state(account_id, "OCI", scope)
            await db.commit()

            states = await repo.list_sync_states(account_id)
            eq("three scopes registered", len(states), 3)
            check("all start with no checkpoint",
                  all(s.checkpoint is None for s in states))

            # Rotation: least-recently-attempted first, never-attempted first of all.
            rotated = await repo.stale_scopes(account_id, "OCI", limit=2)
            eq("rotation takes a bounded slice", len(rotated), 2)

            # Mark one attempted; it should then sort last.
            first = states[0]
            first.last_attempt_at = NOW
            await db.commit()
            rotated = await repo.stale_scopes(account_id, "OCI", limit=3)
            check("an already-attempted scope sorts last, so every scope comes round",
                  rotated[-1] == first.scope, rotated)

            # Health rollup.
            states = await repo.list_sync_states(account_id)
            states[0].status = SYNC_CONNECTED
            states[0].events_stored = 10
            states[1].status = SYNC_PERMISSION_DENIED
            states[1].last_error = "AccessDenied on compartment 2"
            states[2].status = SYNC_CONNECTED
            states[2].events_stored = 5
            await db.commit()

            totals = await repo.sync_totals(account_id)
            eq("one provider rolled up", len(totals), 1)
            eq("scope count", totals[0]["scopes"], 3)
            eq("stored events summed", totals[0]["events_stored"], 15)

            from app.services.event_service import EventService

            status = await EventService(db).source_status(account_id)
            oci = [p for p in status["providers"] if p["provider"] == "OCI"][0]
            eq("two scopes healthy", oci["scopes_healthy"], 2)
            eq("one scope failing", oci["scopes_failing"], 1)
            eq("so the provider is Partial — neither Connected nor down",
               oci["status"], "Partial")
            check("the actual error is surfaced, not hidden",
                  "AccessDenied" in (oci["last_error"] or ""), oci["last_error"])
            check("and the whole feed is flagged degraded, so an empty table "
                  "cannot be read as 'nothing happened'", status["degraded"] is True)
            check("with a note saying exactly that",
                  "may be missing" in (status["note"] or ""), status["note"])

        # An account that has never collected must look different from a
        # healthy-but-quiet one.
        fresh = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            db.add(CloudAccount(
                id=fresh, account_name=f"__collector_fresh_{fresh.hex[:8]}",
                provider="AWS", environment="Test", tenant_or_region="ap-south-1",
                auth_mode="API_Keys", auto_discovery=False, credentials_enc="x",
            ))
            await db.commit()
            from app.services.event_service import EventService

            status = await EventService(db).source_status(fresh)
            aws = [p for p in status["providers"] if p["provider"] == "AWS"][0]
            eq("a never-collected provider is NeverRun, not Connected",
               aws["status"], SYNC_NEVER_RUN)
            check("and the feed is flagged degraded", status["degraded"] is True)
            eq("its provider retention is reported", aws["provider_retention_days"], 90)

        async with AsyncSessionLocal() as db:
            await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                             {"a": str(fresh)})
            await db.commit()

    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                             {"a": str(account_id)})
            await db.commit()
        await engine.dispose()

    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        for name in fail:
            print(f"  ! {name}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
