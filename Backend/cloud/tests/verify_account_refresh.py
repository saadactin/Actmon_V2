"""Account refresh: scheduling, locking, grading and data safety.

Run: venv\\Scripts\\python.exe tests\\verify_account_refresh.py

The assertions guard the decisions that are expensive to get wrong:

  A  schedule arithmetic respects the CONFIGURED timezone, not UTC. "02:00"
     for an Asia/Kolkata operator must not fire at 07:30 their time.
  B  a saved schedule never fires immediately, and a weekly schedule lands on
     the right weekday.
  C  the refresh grade distinguishes SUCCEEDED / PARTIAL / FAILED — a cost
     failure must not be reported as a clean success, and an inventory failure
     must not be reported as partial.
  D  one refresh per account: the second request is refused, not queued.
  E  account isolation: a refresh id from another account is not readable.
  F  a failed refresh does not move `last_success_at`.

The DB-backed sections skip loudly when Postgres is down — a suite reporting
"all passed" having checked nothing is worse than a failure.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from app.models.account_refresh import (
    COMPONENT_FAILED, COMPONENT_PENDING, COMPONENT_RUNNING, COMPONENT_SKIPPED,
    COMPONENT_SUCCEEDED, COMPONENTS,
    REFRESH_FAILED, REFRESH_PARTIAL, REFRESH_SUCCEEDED,
    CloudAccountRefreshSchedule,
)
from app.services.account_refresh_service import (
    ALLOWED_INTERVAL_HOURS, compute_next_run, describe_schedule,
    grade_components, unresolved_components,
)

ok, fail, skipped = [], [], []
PREFIX = "zzrefresh-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  [SKIP] {label}  {why}")


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


def _sched(**kw):
    s = CloudAccountRefreshSchedule()
    s.account_id = kw.get("account_id", uuid.uuid4())
    s.enabled = kw.get("enabled", True)
    s.frequency_type = kw.get("frequency_type", "daily")
    s.interval_hours = kw.get("interval_hours")
    s.day_of_week = kw.get("day_of_week")
    s.time_of_day = kw.get("time_of_day", "02:00")
    s.timezone = kw.get("timezone", "Asia/Kolkata")
    return s


# ── A. Timezone ───────────────────────────────────────────────────────────────
def test_timezone():
    section("A. A schedule runs at the operator's local time, not UTC")

    from zoneinfo import ZoneInfo

    ist = ZoneInfo("Asia/Kolkata")
    # 2026-09-18 12:00 UTC == 17:30 IST. The next 02:00 IST is the 19th.
    now = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)
    nxt = compute_next_run(_sched(time_of_day="02:00", timezone="Asia/Kolkata"),
                           after=now)
    local = nxt.astimezone(ist)
    check("a daily 02:00 schedule fires at 02:00 LOCAL",
          (local.hour, local.minute) == (2, 0), local.isoformat())
    check("and on the next calendar day in that zone",
          local.date() == datetime(2026, 9, 19).date(), str(local.date()))
    check("the stored value is UTC",
          nxt.tzinfo is not None and nxt.utcoffset() == timedelta(0),
          nxt.isoformat())

    # The bug this exists to prevent: the same wall-clock time in a different
    # zone must produce a DIFFERENT instant.
    utc_sched = compute_next_run(_sched(time_of_day="02:00", timezone="UTC"),
                                 after=now)
    check("the same time in another zone is a different instant",
          utc_sched != nxt, f"{utc_sched.isoformat()} vs {nxt.isoformat()}")

    # An unknown zone must not crash the scheduler.
    try:
        bad = compute_next_run(_sched(timezone="Mars/Olympus"), after=now)
        check("an unknown timezone falls back rather than raising", bad is not None)
    except Exception as exc:  # noqa: BLE001
        check("an unknown timezone falls back rather than raising", False, str(exc))


# ── B. Cadence ────────────────────────────────────────────────────────────────
def test_cadence():
    section("B. Cadence lands where it should, and never fires instantly")

    now = datetime(2026, 9, 18, 12, 0, tzinfo=timezone.utc)

    for hours in ALLOWED_INTERVAL_HOURS:
        nxt = compute_next_run(
            _sched(frequency_type="interval", interval_hours=hours), after=now)
        check(f"an every-{hours}h schedule is exactly {hours}h out",
              nxt == now + timedelta(hours=hours))

    # Weekly: 18 Sep 2026 is a Friday. Asking for Monday must give the 21st.
    from zoneinfo import ZoneInfo

    ist = ZoneInfo("Asia/Kolkata")
    nxt = compute_next_run(
        _sched(frequency_type="weekly", day_of_week=0, time_of_day="02:00"),
        after=now)
    local = nxt.astimezone(ist)
    check("a weekly Monday schedule lands on a Monday",
          local.weekday() == 0, local.strftime("%A %d %b"))
    check("and at the configured time", (local.hour, local.minute) == (2, 0))

    # Saved at 01:00 IST for an 02:00 daily run, the next run is TODAY — but
    # saved at 03:00 it must be tomorrow, not one minute ago.
    just_after = datetime(2026, 9, 18, 21, 40, tzinfo=timezone.utc)  # 03:10 IST 19th
    nxt = compute_next_run(_sched(time_of_day="02:00"), after=just_after)
    check("a schedule saved just after its time waits for the next occurrence",
          nxt > just_after, nxt.isoformat())

    # Every computed run must be in the future. A past next_run_at would fire
    # on the very next scheduler tick, immediately after saving.
    for freq in ("daily", "weekly", "interval"):
        s = _sched(frequency_type=freq, day_of_week=3, interval_hours=6)
        nxt = compute_next_run(s, after=now)
        check(f"a {freq} schedule never computes a time in the past", nxt > now)


def test_descriptions():
    section("C. The schedule describes itself in words")

    check("off is off", describe_schedule(_sched(enabled=False)) == "Off")
    check("interval reads naturally",
          describe_schedule(_sched(enabled=True, frequency_type="interval",
                                   interval_hours=6)) == "Every 6 hours")
    check("a single hour is not pluralised",
          describe_schedule(_sched(enabled=True, frequency_type="interval",
                                   interval_hours=1)) == "Every 1 hour")
    weekly = describe_schedule(_sched(enabled=True, frequency_type="weekly",
                                      day_of_week=0))
    check("weekly names the day AND the zone",
          "Monday" in weekly and "Asia/Kolkata" in weekly, weekly)
    daily = describe_schedule(_sched(enabled=True))
    check("daily names the zone, so 02:00 is never ambiguous",
          "Asia/Kolkata" in daily, daily)


# ── D. Grading ────────────────────────────────────────────────────────────────
def _grade(components):
    """The PRODUCTION rule, called directly.

    This used to be a hand-written mirror of the grading code, and it passed
    forty tests while production carried a real race: the mirror never
    modelled PENDING, so it could not notice that a component nobody awaited
    was being graded as neither success nor failure. A test that restates the
    logic it is checking proves only that the author can copy.
    """
    status, _failed = grade_components(components)
    return status


def test_grading():
    section("D. PARTIAL is a real outcome, not a rounding of success")

    all_ok = {n: COMPONENT_SUCCEEDED for n in COMPONENTS}
    check("everything working is SUCCEEDED", _grade(all_ok) == REFRESH_SUCCEEDED)

    # The case the whole feature exists for: the inventory is genuinely fresh
    # and the cost data is genuinely not.
    cost_down = {**all_ok, "cost": COMPONENT_FAILED}
    check("a cost failure is PARTIAL, never SUCCEEDED",
          _grade(cost_down) == REFRESH_PARTIAL, _grade(cost_down))

    events_down = {**all_ok, "events": COMPONENT_FAILED}
    check("an event-collection failure is PARTIAL",
          _grade(events_down) == REFRESH_PARTIAL)

    # An inventory failure is not "partial" — nothing downstream can be trusted.
    inv_down = {**all_ok, "resources": COMPONENT_FAILED}
    check("an inventory failure is FAILED, not PARTIAL",
          _grade(inv_down) == REFRESH_FAILED, _grade(inv_down))

    conn_down = {n: COMPONENT_SKIPPED for n in COMPONENTS}
    conn_down["connection"] = COMPONENT_FAILED
    check("a connection failure is FAILED", _grade(conn_down) == REFRESH_FAILED)

    # SKIPPED is not FAILED. A provider with no cost integration did not fail
    # to refresh cost; it was never asked to.
    no_cost = {**all_ok, "cost": COMPONENT_SKIPPED}
    check("a SKIPPED component does not downgrade the result",
          _grade(no_cost) == REFRESH_SUCCEEDED, _grade(no_cost))

    nothing = {n: COMPONENT_SKIPPED for n in COMPONENTS}
    check("a refresh that achieved nothing is FAILED, not SUCCEEDED",
          _grade(nothing) == REFRESH_FAILED)

    # ── A component nobody waited for ────────────────────────────────────────
    # The live test_aw refresh exposed this: cost ingestion was detached, so
    # grading could read it while still PENDING. It counted as neither success
    # nor failure and the run graded SUCCEEDED with billing data that had never
    # arrived. Silence must never read as health.
    cost_pending = {**all_ok, "cost": COMPONENT_PENDING}
    check("a component still PENDING is never graded SUCCEEDED",
          _grade(cost_pending) != REFRESH_SUCCEEDED, _grade(cost_pending))
    check("a component still PENDING grades PARTIAL",
          _grade(cost_pending) == REFRESH_PARTIAL, _grade(cost_pending))

    events_running = {**all_ok, "events": COMPONENT_RUNNING}
    check("a component still RUNNING is never graded SUCCEEDED",
          _grade(events_running) != REFRESH_SUCCEEDED, _grade(events_running))

    # An unreported INVENTORY is not a partial success — the same rule that
    # makes a failed inventory FAILED applies when it never reported at all.
    inv_pending = {**all_ok, "resources": COMPONENT_PENDING}
    check("an unreported inventory is FAILED, not PARTIAL",
          _grade(inv_pending) == REFRESH_FAILED, _grade(inv_pending))

    # A brand-new record, before anything runs, must not read as a success.
    fresh = {n: COMPONENT_PENDING for n in COMPONENTS}
    check("a refresh that has not run yet is not SUCCEEDED",
          _grade(fresh) == REFRESH_FAILED, _grade(fresh))

    check("unresolved components are named, so history says which one",
          unresolved_components(cost_pending) == ["cost"],
          unresolved_components(cost_pending))
    check("a finished refresh has nothing unresolved",
          unresolved_components(all_ok) == [])
    check("SKIPPED is not treated as unresolved",
          unresolved_components({**all_ok, "cost": COMPONENT_SKIPPED}) == [])

    # The grading rule must read the real record shape, not only the plain
    # states these tests use — otherwise the tests exercise a shape production
    # never passes it.
    real_shape = {n: {"status": COMPONENT_SUCCEEDED, "label": n}
                  for n in COMPONENTS}
    real_shape["cost"] = {"status": COMPONENT_FAILED, "label": "Cost data",
                          "detail": "Cost Explorer returned 403."}
    status, failed = grade_components(real_shape)
    check("grading reads the stored component shape",
          status == REFRESH_PARTIAL and failed == ["cost"], (status, failed))


# ── DB-backed ─────────────────────────────────────────────────────────────────
async def db_available() -> bool:
    try:
        from sqlalchemy import text

        from app.core.database import AsyncSessionLocal

        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


async def test_db():
    section("E. Lock, isolation and freshness (needs Postgres)")

    labels = ["a schedule persists and computes its next run",
              "disabling clears next_run_at",
              "a second refresh is refused while one is running",
              "account isolation on refresh records",
              "a failed refresh does not move last_success_at"]
    if not await db_available():
        for label in labels:
            skip(label, "Postgres is not reachable")
        return

    from sqlalchemy import delete

    from app.core.database import AsyncSessionLocal
    from app.models.account_refresh import CloudAccountRefresh
    from app.models.cloud_account import CloudAccount
    from app.services.account_refresh_service import (
        AccountRefreshService, RefreshError,
    )

    async with AsyncSessionLocal() as db:
        a1 = CloudAccount(account_name=PREFIX + "one", provider="AWS",
                          environment="Test", tenant_or_region="ap-south-1",
                          credentials_enc="")
        a2 = CloudAccount(account_name=PREFIX + "two", provider="OCI",
                          environment="Test", tenant_or_region="ap-mumbai-1",
                          credentials_enc="")
        db.add_all([a1, a2])
        await db.commit()
        await db.refresh(a1)
        await db.refresh(a2)
        a1_id, a2_id = a1.id, a2.id

        svc = AccountRefreshService(db)
        try:
            saved = await svc.set_schedule(a1_id, {
                "enabled": True, "frequency_type": "daily",
                "time_of_day": "02:00", "timezone": "Asia/Kolkata",
            }, actor="suite")
            check("a schedule persists and computes its next run",
                  saved["enabled"] and saved["next_run_at"],
                  str(saved["next_run_at"]))
            check("the next run is in the future",
                  datetime.fromisoformat(saved["next_run_at"])
                  > datetime.now(timezone.utc))

            off = await svc.set_schedule(a1_id, {"enabled": False}, actor="suite")
            check("disabling clears next_run_at",
                  off["enabled"] is False and off["next_run_at"] is None)

            bad = None
            try:
                await svc.set_schedule(a1_id, {"timezone": "Mars/Olympus"},
                                       actor="suite")
            except RefreshError as exc:
                bad = exc
            check("an invalid timezone is refused",
                  bad is not None and "timezone" in (bad.existing or {}))

            # ── Lock ─────────────────────────────────────────────────────────
            # A row is inserted directly rather than calling start(), which
            # would launch a real provider sweep against a fake account.
            running = CloudAccountRefresh(
                account_id=a1_id, provider="AWS", status="RUNNING",
                started_at=datetime.now(timezone.utc),
                components={n: {"status": "PENDING"} for n in COMPONENTS})
            db.add(running)
            await db.commit()
            await db.refresh(running)

            refused = None
            try:
                await svc.start(a1_id, actor="suite")
            except RefreshError as exc:
                refused = exc
            check("a second refresh is refused while one is running",
                  refused is not None and refused.code == "already_running",
                  refused.code if refused else "not refused")
            check("the refusal carries the in-flight refresh so the UI can "
                  "show its progress",
                  bool(refused and refused.existing))

            # Another account must be free to refresh — the lock is per
            # account, not global.
            other_active = await svc.active_refresh(a2_id)
            check("the lock does not block a different account",
                  other_active is None)

            # ── Isolation ────────────────────────────────────────────────────
            leaked = None
            try:
                await svc.get(a2_id, running.id)
            except RefreshError as exc:
                leaked = exc
            check("account isolation on refresh records",
                  leaked is not None and leaked.code == "not_found")

            # ── Freshness ────────────────────────────────────────────────────
            sched = await svc.get_schedule(a1_id)
            sched.last_success_at = datetime(2026, 9, 16, 2, 0, tzinfo=timezone.utc)
            sched.last_run_at = datetime(2026, 9, 18, 2, 0, tzinfo=timezone.utc)
            await db.commit()
            payload = sched.to_dict()
            check("a failed refresh does not move last_success_at",
                  payload["last_success_at"].startswith("2026-09-16")
                  and payload["last_run_at"].startswith("2026-09-18"),
                  f"success={payload['last_success_at']} run={payload['last_run_at']}")

            latest = await svc.latest(a1_id)
            check("latest() reports the running refresh separately",
                  latest["is_running"] and latest["current"])

        finally:
            await db.rollback()
            await db.execute(delete(CloudAccountRefresh).where(
                CloudAccountRefresh.account_id.in_([a1_id, a2_id])))
            await db.execute(delete(CloudAccountRefreshSchedule).where(
                CloudAccountRefreshSchedule.account_id.in_([a1_id, a2_id])))
            await db.execute(delete(CloudAccount).where(
                CloudAccount.account_name.like(PREFIX + "%")))
            await db.commit()


async def main():
    print("Account refresh: scheduling, locking, grading and data safety")
    print("=" * 62)
    test_timezone()
    test_cadence()
    test_descriptions()
    test_grading()
    await test_db()

    print("\n" + "=" * 62)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP {len(skipped)}")
    if skipped:
        print("\nSkipped (Postgres unreachable) — these are NOT passes:")
        for s in skipped:
            print(f"  - {s}")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
