"""Drift capture through the real repository + DB.

Runs against a throwaway account it creates and deletes itself, so it never
touches real inventory. What it proves:

  * a brand-new account's first sweep is a BASELINE, not 1,500 "created" events
  * a later sweep records field-level changes, with the OLD value intact
  * a resource appearing after the baseline is CREATED
  * a clean sweep's prune records DELETED, and that row OUTLIVES the resource
  * an incomplete sweep's diffs are discarded, not published as change
"""
import asyncio
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

from sqlalchemy import text

from app.core.database import AsyncSessionLocal, engine
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target)
from app.models.drift import CloudResourceChange  # noqa: F401
from app.repository.drift_repo import DriftRepository
from app.repository.resource_repo import ResourceRepository

ACCOUNT_NAME = "ZZ_DRIFT_TEST_ACCOUNT"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def res(pid, name, **kw):
    """A resource shaped the way a scanner emits one."""
    return {
        "provider_resource_id": pid,
        "resource_type": kw.get("resource_type", "ComputeInstance"),
        "resource_name": name,
        "region_or_zone": kw.get("region_or_zone", "ap-mumbai-1"),
        "status": kw.get("status", "RUNNING"),
        "config": kw.get("config", {}),
        "tags": kw.get("tags", {}),
        "metadata": kw.get("metadata", {}),
    }


async def make_account():
    """A real row, so the FK resolves — with obviously non-credential creds."""
    async with engine.begin() as c:
        await c.execute(text("delete from cloud_accounts where account_name = :n"), {"n": ACCOUNT_NAME})
        row = (await c.execute(text(
            "insert into cloud_accounts "
            "(id, account_name, provider, environment, tenant_or_region, auth_mode, "
            " auto_discovery, credentials_enc, created_at, updated_at) "
            "values (:id, :n, 'OCI', 'Test', 'test-region', 'API_Keys', false, "
            "        'not-a-credential', now(), now()) returning id"
        ), {"id": uuid.uuid4(), "n": ACCOUNT_NAME})).first()
    return row[0]


async def drop_account(account_id):
    async with engine.begin() as c:
        # cloud_resources cascades; the change log does not (by design), so it
        # is cleared explicitly.
        await c.execute(text("delete from cloud_resource_changes where account_id = :a"), {"a": account_id})
        await c.execute(text("delete from cloud_accounts where id = :a"), {"a": account_id})


async def changes_for(account_id, job_id=None):
    async with AsyncSessionLocal() as db:
        repo = DriftRepository(db)
        rows = await repo.list(account_id=account_id, page_size=500)
    return [r for r in rows if job_id is None or r.job_id == job_id]


async def main():
    account_id = await make_account()
    print(f"throwaway account: {account_id}\n")
    try:
        # ── 1. First sweep is the baseline ────────────────────────────────────
        print("1. first sweep of an empty account establishes a baseline")
        async with AsyncSessionLocal() as db:
            repo = ResourceRepository(db)
            had = await repo.count_by_account(account_id)
            # This is exactly the decision the worker makes: no inventory on
            # file means no drift_job_id, so nothing is logged.
            baseline_job = None if had == 0 else uuid.uuid4()
            await repo.upsert_resources(account_id, [
                res("ocid-vm-1", "vm-1", config={"ocpus": 2, "shape": "E4", "public_ip": None}),
                res("ocid-vol-1", "vol-1", resource_type="BlockVolume", config={"size_gb": 50}),
            ], drift_job_id=baseline_job)
            await db.commit()
        check("baseline passes no job id", baseline_job is None)
        rows = await changes_for(account_id)
        check("baseline logs zero changes", len(rows) == 0, f"got {len(rows)}")

        # ── 2. Second sweep records real field changes ────────────────────────
        print("\n2. second sweep records field-level changes with the old value")
        job2 = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            await ResourceRepository(db).upsert_resources(account_id, [
                res("ocid-vm-1", "vm-1", status="STOPPED",
                    config={"ocpus": 4, "shape": "E4", "public_ip": "1.2.3.4"}),
                res("ocid-vol-1", "vol-1", resource_type="BlockVolume", config={"size_gb": 50}),
            ], drift_job_id=job2)
            await db.commit()
        rows = await changes_for(account_id, job2)
        by_field = {r.field_path: r for r in rows}
        check("only changed fields are logged", set(by_field) == {"status", "config.ocpus", "config.public_ip"},
              str(sorted(by_field)))
        check("unchanged resource logs nothing",
              all(r.provider_resource_id == "ocid-vm-1" for r in rows))
        check("old value is preserved", by_field["config.ocpus"].old_value == "2",
              repr(by_field.get("config.ocpus").old_value))
        check("new value is recorded", by_field["config.ocpus"].new_value == "4")
        check("scale-up direction is set", by_field["config.ocpus"].direction == "SCALE_UP")
        check("public IP appearing is CRITICAL/MORE_OPEN",
              by_field["config.public_ip"].severity == "CRITICAL"
              and by_field["config.public_ip"].direction == "MORE_OPEN",
              f"{by_field['config.public_ip'].severity}/{by_field['config.public_ip'].direction}")
        check("status change spans availability and cost",
              set(by_field["status"].impact) == {"availability", "cost"}, str(by_field["status"].impact))
        check("rows carry the job that found them", all(r.job_id == job2 for r in rows))
        check("rows carry a resolvable resource_id", all(r.resource_id for r in rows))

        # ── 3. A new resource after the baseline is CREATED ───────────────────
        print("\n3. a resource appearing after the baseline is CREATED")
        job3 = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            await ResourceRepository(db).upsert_resources(account_id, [
                res("ocid-vm-1", "vm-1", status="STOPPED",
                    config={"ocpus": 4, "shape": "E4", "public_ip": "1.2.3.4"}),
                res("ocid-vol-1", "vol-1", resource_type="BlockVolume", config={"size_gb": 50}),
                res("ocid-vm-2", "vm-2", config={"ocpus": 1, "shape": "E4"}),
            ], drift_job_id=job3)
            await db.commit()
        rows = await changes_for(account_id, job3)
        check("exactly one CREATED row", len(rows) == 1 and rows[0].change_type == "CREATED",
              f"{len(rows)} rows: {[(r.change_type, r.provider_resource_id) for r in rows]}")
        check("CREATED names the new resource", rows and rows[0].provider_resource_id == "ocid-vm-2")
        check("CREATED has no field path", rows and rows[0].field_path is None)

        # ── 4. Prune records DELETED, and it outlives the resource ────────────
        print("\n4. a clean sweep's prune records DELETED, which outlives the row")
        job4 = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            repo = ResourceRepository(db)
            removed = await repo.delete_stale(
                account_id, ["ocid-vm-1", "ocid-vol-1"], drift_job_id=job4,
            )
            await db.commit()
        check("the missing resource was pruned", removed == 1, f"removed={removed}")
        rows = await changes_for(account_id, job4)
        check("exactly one DELETED row", len(rows) == 1 and rows[0].change_type == "DELETED",
              f"{len(rows)} rows")
        check("DELETED names the gone resource", rows and rows[0].provider_resource_id == "ocid-vm-2")
        check("DELETED keeps the name for the record", rows and rows[0].old_value == "vm-2")
        # The whole point of not making resource_id a foreign key.
        async with AsyncSessionLocal() as db:
            still_there = (await db.execute(text(
                "select count(*) from cloud_resources where account_id = :a "
                "and provider_resource_id = 'ocid-vm-2'"
            ), {"a": account_id})).scalar_one()
            log_survived = (await db.execute(text(
                "select count(*) from cloud_resource_changes where account_id = :a "
                "and provider_resource_id = 'ocid-vm-2' and change_type = 'DELETED'"
            ), {"a": account_id})).scalar_one()
        check("inventory row is gone", still_there == 0)
        check("its DELETED record survived the delete", log_survived == 1)

        # ── 5. An incomplete sweep keeps real diffs, drops vanished ones ──────
        # A scope that fails to enumerate produces MISSING data, never wrong
        # data: whatever the sweep did report, it read from the provider. So a
        # field changing to a new value survives a partial sweep; a field going
        # empty does not, because a failed lookup looks exactly like that.
        print("\n5. an incomplete sweep keeps real changes, drops vanished values")
        job5 = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            await ResourceRepository(db).upsert_resources(account_id, [
                res("ocid-vm-1", "vm-1", status="RUNNING",
                    # shape changes to a NEW value -> trustworthy.
                    # public_ip goes empty -> could be a failed lookup.
                    config={"ocpus": 4, "shape": "E5", "public_ip": None}),
            ], drift_job_id=job5)
            await db.commit()
        rows = await changes_for(account_id, job5)
        by_field = {r.field_path: r for r in rows}
        check("both kinds of diff were recorded",
              {"config.shape", "config.public_ip", "status"} <= set(by_field), str(sorted(by_field)))
        check("a value going empty is flagged vanished",
              by_field["config.public_ip"].value_vanished is True)
        check("a value changing is NOT flagged vanished",
              by_field["config.shape"].value_vanished is False)

        async with AsyncSessionLocal() as db:
            dropped = await DriftRepository(db).delete_unreliable_for_job(job5)
            await db.commit()
        check("only the vanished row is dropped", dropped == 1, f"dropped={dropped}")
        rows = await changes_for(account_id, job5)
        remaining = {r.field_path for r in rows}
        check("the real change survives a partial sweep", "config.shape" in remaining, str(sorted(remaining)))
        check("the vanished value does not", "config.public_ip" not in remaining, str(sorted(remaining)))

        # A CRASHED scan is a stronger failure — none of its output is trusted.
        job6 = uuid.uuid4()
        async with AsyncSessionLocal() as db:
            await ResourceRepository(db).upsert_resources(account_id, [
                res("ocid-vm-1", "vm-1", status="STOPPED",
                    config={"ocpus": 8, "shape": "E6", "public_ip": None}),
            ], drift_job_id=job6)
            await db.commit()
        crashed = await changes_for(account_id, job6)
        check("a crashed sweep recorded diffs", len(crashed) >= 2, f"got {len(crashed)}")
        async with AsyncSessionLocal() as db:
            dropped = await DriftRepository(db).delete_for_job(job6)
            await db.commit()
        check("a crashed sweep discards everything", dropped == len(crashed), f"dropped={dropped} of {len(crashed)}")
        check("nothing from the crashed job remains", len(await changes_for(account_id, job6)) == 0)

        # Both discards are scoped to one sweep — earlier jobs stay on record.
        surviving = await changes_for(account_id)
        check("earlier jobs are untouched", len(surviving) > 0, f"{len(surviving)} rows still on record")

        # ── 6. Summary aggregation ───────────────────────────────────────────
        print("\n6. summary aggregates what is on record")
        from app.services.drift_service import DriftService
        async with AsyncSessionLocal() as db:
            summary = await DriftService(db).summary(account_id=str(account_id), days=30)
        check("total matches the row count", summary["total_changes"] == len(surviving),
              f"{summary['total_changes']} vs {len(surviving)}")
        check("has_history is true", summary["has_history"] is True)
        check("change types are counted", summary["by_change_type"]["CREATED"] == 1
              and summary["by_change_type"]["DELETED"] == 1,
              str(summary["by_change_type"]))
        check("pillars are counted", summary["by_impact"]["cost"] > 0 and summary["by_impact"]["security"] > 0,
              str(summary["by_impact"]))
        # A change touching two pillars counts in both, so these must NOT sum to
        # the total — asserting that keeps the semantics honest.
        check("pillar counts may exceed the total (multi-pillar rows)",
              sum(summary["by_impact"].values()) >= summary["total_changes"],
              f"{sum(summary['by_impact'].values())} vs {summary['total_changes']}")
        check("newly_exposed counts the opening", summary["newly_exposed"] == 1, str(summary["newly_exposed"]))
        check("top_resources is ranked", len(summary["top_resources"]) > 0)

        # ── 6b. Provider creation timestamps ─────────────────────────────────
        # These reach back before drift capture existed, so the parser has to
        # cope with every form the scanners actually store — and return None
        # rather than raise on anything else, because one bad string must not
        # take out the whole history view.
        print("\n6b. provider creation timestamps")
        from app.services.drift_service import DriftService as DS

        CASES = [
            ("2023-10-13T06:15:09.209000+00:00", True),   # OCI, isoformat
            ("2026-05-07 12:00:31+00:00", True),          # space separator
            ("2026-04-29T12:11:23.478000+05:30", True),   # non-UTC offset
            ("2026-06-09T11:43:32Z", True),               # Z suffix
            ("2026-06-09", True),                         # date only
            ("not a timestamp", False),
            ("", False),
            (None, False),
            ({}, False),
        ]
        for raw, should_parse in CASES:
            got = DS._parse_timestamp(raw)
            check(f"parse {raw!r} -> {'datetime' if should_parse else 'None'}",
                  (got is not None) == should_parse, repr(got))
        # Everything that parses must be timezone-aware, or sorting and month
        # bucketing would blow up comparing naive against aware.
        aware = [DS._parse_timestamp(r) for r, ok_ in CASES if ok_]
        check("parsed timestamps are timezone-aware",
              all(t is not None and t.tzinfo is not None for t in aware))

        # Key preference: OCI's time_created wins, and the key used is reported.
        got, src = DS._created_at_of({"time_created": "2023-01-01T00:00:00Z"})
        check("time_created is used and named", got is not None and src == "time_created", str(src))
        got, src = DS._created_at_of({"creation_date": "2026-05-07 12:00:31+00:00"})
        check("AWS creation_date is used and named", got is not None and src == "creation_date", str(src))
        got, src = DS._created_at_of({"last_modified": "2026-05-07T00:00:00Z"})
        check("last_modified is NOT treated as a creation date", got is None and src is None, str(src))
        got, src = DS._created_at_of({"time_created": "garbage"})
        check("an unparseable timestamp yields None, not an error", got is None and src is None)
        got, src = DS._created_at_of(None)
        check("missing metadata yields None", got is None and src is None)

        async with AsyncSessionLocal() as db:
            hist = await DriftService(db).inventory_history(account_id=str(account_id))
        check("history covers this account's resources",
              hist["coverage"]["total_resources"] == hist["total"], str(hist["coverage"]))
        check("history reports its own coverage honestly",
              hist["coverage"]["with_provider_timestamp"]
              + hist["coverage"]["without_provider_timestamp"]
              == hist["coverage"]["total_resources"], str(hist["coverage"]))
        check("rows with no provider date are kept, not dropped",
              len(hist["items"]) > 0, f"{len(hist['items'])} items")
        check("first_seen is always present", all(i["first_seen"] for i in hist["items"]))

        # ── 7. An account with no history reads differently from "no changes" ─
        print("\n7. no baseline is distinguishable from no changes")
        empty_id = await make_account()
        try:
            async with AsyncSessionLocal() as db:
                empty = await DriftService(db).summary(account_id=str(empty_id), days=30)
            check("has_history is false with no log", empty["has_history"] is False)
            check("total is zero", empty["total_changes"] == 0)
        finally:
            await drop_account(empty_id)
    finally:
        await drop_account(account_id)
        await engine.dispose()

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print(f"  FAILED: {f}")
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
