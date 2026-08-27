"""Does the storage rule flag only what it should? The main test's
running-instance check queried a key that was never submitted, so it passed
without exercising the filter. This feeds each case in and checks the outcome.
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
from app.services.alerting_service import (
    RULE_STOPPED_INSTANCE_STORAGE,
    check_storage_attachment_alerts,
)
from app.repository.alert_repo import AlertRepository

PREFIX = f"{RULE_STOPPED_INSTANCE_STORAGE}:"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


CASES = [
    # (id, resource_type, attachment_status, attached_to_status, should_alert, why)
    ("f-stopped-oci",  "BlockVolume", "Attached",   "Stopped",     True,  "OCI stopped"),
    ("f-dealloc-az",   "ManagedDisk", "Attached",   "Deallocated", True,  "Azure deallocated"),
    ("f-stopping",     "EBSMDisk-x",  "Attached",   "Stopping",    False, "unknown type"),
    ("f-running",      "BlockVolume", "Attached",   "Running",     False, "instance running"),
    ("f-unattached",   "BlockVolume", "Unattached", None,          False, "not attached"),
    ("f-nostatus",     "BlockVolume", "Attached",   None,          False, "status unknown"),
    ("f-vm-type",      "VirtualMachine", "Attached", "Stopped",    False, "not storage"),
    ("f-ebs-stopped",  "EBSVolume",   "Attached",   "stopped",     True,  "AWS lowercase"),
]


async def main():
    async with engine.begin() as c:
        accts = (await c.execute(text(
            "select id from cloud_accounts order by created_at limit 1"))).all()
    aid = accts[0][0]

    async def clean():
        async with engine.begin() as c:
            await c.execute(text("delete from cloud_alerts where dedupe_key like :p"),
                            {"p": f"{PREFIX}f-%"})

    await clean()

    resources = [{
        "resource_type": rt,
        "resource_name": rid,
        "provider_resource_id": rid,
        "config": {"attachment_status": att, "attached_to_status": st,
                   "attached_to_name": "srv"},
    } for rid, rt, att, st, _, _ in CASES]

    async with AsyncSessionLocal() as db:
        n = await check_storage_attachment_alerts(db, "filter-test", resources,
                                                  account_id=aid)

    expected = sum(1 for c in CASES if c[4])
    print(f"submitted {len(CASES)} resources, expected {expected} alerts, got {n}\n")

    async with AsyncSessionLocal() as db:
        repo = AlertRepository(db)
        for rid, _, _, _, should, why in CASES:
            got = await repo.get_by_dedupe_key(f"{PREFIX}{rid}")
            check(f"{'alerts' if should else 'ignores':7} {rid:15} ({why})",
                  (got is not None) == should,
                  "" if (got is not None) == should
                  else f"expected alert={should}, got={got is not None}")
        check("total matches expectation", n == expected, f"{n} vs {expected}")

    await clean()
    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        sys.exit(1)


asyncio.run(main())
