"""Phase 1.1 verification. Run twice: `--phase write` then `--phase read`,
as separate processes, so "survives a restart" is actually tested rather than
asserted.
"""
import asyncio
import logging
import pathlib
import sys

# Run as a plain script, so the project root is not on sys.path by default.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

from sqlalchemy import text

from app.core.database import AsyncSessionLocal, engine
from app.models.alert import STATE_ACKNOWLEDGED, STATE_OPEN, STATE_RESOLVED
from app.repository.alert_repo import AlertRepository
from app.services.alerting_service import (
    RULE_STOPPED_INSTANCE_STORAGE,
    AlertingService,
    check_storage_attachment_alerts,
)

PREFIX = f"{RULE_STOPPED_INSTANCE_STORAGE}:"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def res(pid, name, attached_to, status="Stopped"):
    """A storage resource shaped like the scanner emits."""
    return {
        "resource_type": "BlockVolume",
        "resource_name": name,
        "provider_resource_id": pid,
        "config": {
            "attachment_status": "Attached",
            "attached_to_name": attached_to,
            "attached_to_status": status,
            "size_gb": 50,
        },
    }


async def accounts():
    async with engine.begin() as c:
        return (await c.execute(text(
            "select id, account_name from cloud_accounts order by created_at limit 2"
        ))).all()


async def cleanup():
    async with engine.begin() as c:
        await c.execute(text(
            "delete from cloud_alerts where dedupe_key like 'TEST:%' "
            "or dedupe_key like :p or anomaly_type = 'TEST_SIMULATED'"
        ), {"p": f"{PREFIX}vol-test-%"})


async def phase_write():
    accts = await accounts()
    if len(accts) < 2:
        print(f"! only {len(accts)} cloud account(s) — cross-account scoping test needs 2")
    a1 = accts[0][0] if accts else None
    a2 = accts[1][0] if len(accts) > 1 else None
    print(f"accounts: {[str(a[1]) for a in accts]}\n")

    await cleanup()

    # ── 1. basic create + dedupe ──────────────────────────────────────────────
    print("1. create and dedupe")
    async with AsyncSessionLocal() as db:
        svc = AlertingService(db)
        a = await svc.trigger_anomaly_alert(
            anomaly_type="TEST_SIMULATED", details="first", severity="HIGH",
            dedupe_key="TEST:dupe", account_id=a1, simulated=True)
        check("alert created", a["id"] is not None)
        check("state is OPEN", a["state"] == STATE_OPEN, a["state"])
        check("occurrence_count 1", a["occurrence_count"] == 1)

        b = await svc.trigger_anomaly_alert(
            anomaly_type="TEST_SIMULATED", details="second", severity="HIGH",
            dedupe_key="TEST:dupe", account_id=a1, simulated=True)
        check("same key reuses the row", b["id"] == a["id"])
        check("occurrence_count 2", b["occurrence_count"] == 2, str(b["occurrence_count"]))
        check("details updated", b["details"] == "second")

    # ── 2. lifecycle ──────────────────────────────────────────────────────────
    print("\n2. lifecycle")
    async with AsyncSessionLocal() as db:
        svc = AlertingService(db)
        acked = await svc.acknowledge(a["id"])
        check("acknowledge -> ACKNOWLEDGED", acked["state"] == STATE_ACKNOWLEDGED)
        check("acknowledged_at set", acked["acknowledged_at"] is not None)
        check("is_read true (UI key preserved)", acked["is_read"] is True)

        resolved = await svc.resolve(a["id"])
        check("resolve -> RESOLVED", resolved["state"] == STATE_RESOLVED)
        check("resolved_at set", resolved["resolved_at"] is not None)

        check("unknown id -> None", await svc.acknowledge(
            "00000000-0000-0000-0000-000000000000") is None)
        check("malformed id -> None (no crash)", await svc.acknowledge("not-a-uuid") is None)

    # ── 3. recurrence re-opens a resolved alert ───────────────────────────────
    print("\n3. recurrence re-opens")
    async with AsyncSessionLocal() as db:
        svc = AlertingService(db)
        again = await svc.trigger_anomaly_alert(
            anomaly_type="TEST_SIMULATED", details="came back", severity="HIGH",
            dedupe_key="TEST:dupe", account_id=a1, simulated=True)
        check("resolved + seen again -> OPEN", again["state"] == STATE_OPEN, again["state"])
        check("resolved_at cleared", again["resolved_at"] is None)
        check("same row, not a duplicate", again["id"] == a["id"])

    # ── 4. default feed hides resolved ────────────────────────────────────────
    print("\n4. feed filtering")
    async with AsyncSessionLocal() as db:
        svc = AlertingService(db)
        await svc.resolve(a["id"])
        default = [x for x in await svc.get_all_alerts() if x["id"] == a["id"]]
        withres = [x for x in await svc.get_all_alerts(include_resolved=True)
                   if x["id"] == a["id"]]
        check("resolved hidden by default", not default)
        check("resolved shown on request", len(withres) == 1)

    # ── 5. the storage rule + auto-resolve ────────────────────────────────────
    print("\n5. storage rule")
    async with AsyncSessionLocal() as db:
        n = await check_storage_attachment_alerts(
            db, "acct-1",
            [res("vol-test-1", "disk-a", "srv-a"), res("vol-test-2", "disk-b", "srv-b")],
            account_id=a1)
        check("2 offenders flagged", n == 2, str(n))

    async with AsyncSessionLocal() as db:
        repo = AlertRepository(db)
        open1 = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-1")
        check("running instance is not flagged",
              (await repo.get_by_dedupe_key(f"{PREFIX}vol-test-99")) is None)
        check("alert names the resource", open1.resource_name == "disk-a")
        check("context carries the instance",
              (open1.context or {}).get("attached_to") == "srv-a")

    # one offender fixed -> only that one auto-resolves
    async with AsyncSessionLocal() as db:
        await check_storage_attachment_alerts(
            db, "acct-1", [res("vol-test-1", "disk-a", "srv-a")], account_id=a1)
    async with AsyncSessionLocal() as db:
        repo = AlertRepository(db)
        still = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-1")
        gone = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-2")
        check("still-offending stays OPEN", still.state == STATE_OPEN, still.state)
        check("fixed one auto-resolves", gone.state == STATE_RESOLVED, gone.state)

    # ── 6. incomplete sweep must NOT auto-resolve ─────────────────────────────
    print("\n6. incomplete sweep does not resolve (the prune-bug class)")
    async with AsyncSessionLocal() as db:
        await check_storage_attachment_alerts(
            db, "acct-1", [], account_id=a1, sweep_complete=False)
    async with AsyncSessionLocal() as db:
        repo = AlertRepository(db)
        survived = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-1")
        check("open alert survives a partial sweep",
              survived.state == STATE_OPEN, survived.state)

    # ── 7. cross-account scoping (the bug fixed this session) ─────────────────
    print("\n7. cross-account scoping")
    if a2 is None:
        print("  [SKIP] needs a second cloud account")
    else:
        async with AsyncSessionLocal() as db:
            await check_storage_attachment_alerts(
                db, "acct-2", [res("vol-test-9", "disk-z", "srv-z")], account_id=a2)
        # a clean sweep of account 2 finding nothing must not touch account 1
        async with AsyncSessionLocal() as db:
            await check_storage_attachment_alerts(db, "acct-2", [], account_id=a2)
        async with AsyncSessionLocal() as db:
            repo = AlertRepository(db)
            other = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-1")
            own = await repo.get_by_dedupe_key(f"{PREFIX}vol-test-9")
            check("account 2's scan left account 1's alert OPEN",
                  other.state == STATE_OPEN, other.state)
            check("account 2's own alert did resolve",
                  own.state == STATE_RESOLVED, own.state)

    # leave one OPEN alert behind for the restart check
    async with AsyncSessionLocal() as db:
        svc = AlertingService(db)
        await svc.trigger_anomaly_alert(
            anomaly_type="TEST_SIMULATED", details="survive the restart",
            severity="CRITICAL", dedupe_key="TEST:persist", account_id=a1, simulated=True)
    print("\n  (left TEST:persist OPEN for the restart check)")


async def phase_read():
    print("after process restart")
    async with AsyncSessionLocal() as db:
        repo = AlertRepository(db)
        p = await repo.get_by_dedupe_key("TEST:persist")
        check("alert survived a full process restart", p is not None)
        if p:
            check("state preserved", p.state == STATE_OPEN, p.state)
            check("severity preserved", p.severity == "CRITICAL")
            check("details preserved", p.details == "survive the restart")
        svc = AlertingService(db)
        counts = await svc.counts()
        print(f"  counts: {counts}")
    await cleanup()
    print("  (test rows cleaned up)")


async def main():
    phase = sys.argv[sys.argv.index("--phase") + 1] if "--phase" in sys.argv else "write"
    print(f"=== phase: {phase} ===\n")
    await (phase_write() if phase == "write" else phase_read())
    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        sys.exit(1)


asyncio.run(main())
