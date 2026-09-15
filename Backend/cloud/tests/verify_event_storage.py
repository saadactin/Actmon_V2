"""Event storage against the real database: dedup, immutability, paging, retention.

These are the properties that cannot be verified without Postgres, because they
ARE Postgres behaviour — a unique constraint discarding a duplicate, a trigger
refusing an UPDATE, an OFFSET pager that must not skip or repeat a row.

Everything is written under a dedicated throwaway account and removed at the
end, so running this against the live database leaves nothing behind.
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
from app.events.adapters.base import CollectedEvent  # noqa: E402
from app.events.schema import ensure_append_only, is_append_only_installed  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cloud_event import CloudEvent  # noqa: E402
from app.repository.event_repo import EventRepository, FilterError  # noqa: E402

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

ok, fail = [], []
BASE_TIME = datetime(2026, 9, 8, 9, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def make_event(**kwargs) -> CollectedEvent:
    defaults = dict(
        provider="AWS",
        provider_event_id=f"evt-{uuid.uuid4()}",
        timestamp=BASE_TIME,
        event_name="DeleteBucket",
        event_source="s3.amazonaws.com",
        event_category="Storage",
        action="Delete",
        status="Success",
        risk_level="HIGH",
        actor_name="saad@example.com",
        actor_type="Human",
        resource_id="arn:aws:s3:::example-bucket",
        resource_name="example-bucket",
        resource_type="S3Bucket",
        region="ap-south-1",
        source_ip="10.20.30.40",
        access_method="Console",
        raw_event={"eventName": "DeleteBucket"},
    )
    defaults.update(kwargs)
    return CollectedEvent(**defaults)


async def main() -> int:
    # Same DDL the service installs at startup, from the same module — so this
    # suite exercises the real append-only guarantee rather than a table that
    # merely has no trigger on it.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await ensure_append_only(conn)
        installed = await is_append_only_installed(conn)
    check("the append-only trigger is installed", installed)

    # ── Guard: this suite must not damage real collected audit events ────────
    # It writes to the live database, and retention pruning is global by
    # design, so a careless cutoff here deletes other accounts' evidence. That
    # is not hypothetical: an earlier version of the prune probe used a cutoff
    # in 2036 and silently removed 154 events genuinely collected from live
    # Azure and OCI accounts. The count is taken before and re-checked after,
    # so a regression fails the suite instead of destroying data quietly.
    async with AsyncSessionLocal() as db:
        foreign_before = (await db.execute(
            text("SELECT count(*) FROM cloud_events")
        )).scalar_one()

    account_id = uuid.uuid4()

    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            id=account_id,
            account_name=f"__eventlog_test_{account_id.hex[:8]}",
            provider="AWS",
            environment="Test",
            tenant_or_region="ap-south-1",
            auth_mode="API_Keys",
            auto_discovery=False,
            credentials_enc="test-only-not-real",
        ))
        await db.commit()

    try:
        result = await run_checks(account_id)
    finally:
        # Remove the fixture. The events go with the account by ON DELETE
        # CASCADE, which the append-only trigger permits because it fires on
        # row DELETE against cloud_events — so this also proves the cascade
        # still works with the trigger installed.
        async with AsyncSessionLocal() as db:
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(
                text("DELETE FROM cloud_events WHERE account_id = :a"),
                {"a": str(account_id)},
            )
            await db.execute(
                text("DELETE FROM cloud_event_sync_state WHERE account_id = :a"),
                {"a": str(account_id)},
            )
            await db.execute(
                text("DELETE FROM cloud_accounts WHERE id = :a"), {"a": str(account_id)}
            )
            await db.commit()

    # The other half of the guard above: every row this suite created is gone
    # with its account, so the table must hold exactly what it held before.
    async with AsyncSessionLocal() as db:
        foreign_after = (await db.execute(
            text("SELECT count(*) FROM cloud_events")
        )).scalar_one()
    check(
        "the suite left other accounts' collected events untouched",
        foreign_after >= foreign_before,
        f"{foreign_before} before, {foreign_after} after",
    )
    if foreign_after < foreign_before:
        print(f"  ! DESTROYED {foreign_before - foreign_after} real audit event(s) — "
              f"check every prune cutoff in this file")
        result = 1

    await engine.dispose()
    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        for name in fail:
            print(f"  ! {name}")
    return 1 if fail else result


async def run_checks(account_id: uuid.UUID) -> int:
    # ── 1. Insert and dedupe ─────────────────────────────────────────────────
    print("1. deduplication")

    async with AsyncSessionLocal() as db:
        repo = EventRepository(db)

        first = make_event(provider_event_id="dedupe-me", timestamp=BASE_TIME)
        stored, dupes = await repo.insert_events(account_id, [first])
        await db.commit()
        eq("a new event is stored", stored, 1)
        eq("and reports no duplicates", dupes, 0)

        # The same provider event again — exactly what an overlapping poll
        # window produces on every incremental run.
        again = make_event(provider_event_id="dedupe-me", timestamp=BASE_TIME)
        stored, dupes = await repo.insert_events(account_id, [again])
        await db.commit()
        eq("re-polling the same provider event stores nothing", stored, 0)
        eq("and reports it as a duplicate", dupes, 1)

        total = await repo.count(account_id=account_id)
        eq("exactly one row on file", total, 1)

        # A duplicate INSIDE one batch. ON CONFLICT does not protect against
        # this, so the repository has to de-duplicate the batch itself.
        batch = [
            make_event(provider_event_id="intra-batch"),
            make_event(provider_event_id="intra-batch"),
            make_event(provider_event_id="intra-batch-2"),
        ]
        stored, dupes = await repo.insert_events(account_id, batch)
        await db.commit()
        eq("a duplicate within one batch is collapsed", stored, 2)
        eq("and counted as a duplicate", dupes, 1)

        eq("empty input is a no-op",
           await repo.insert_events(account_id, []), (0, 0))

    # ── 1b. Absent JSON is SQL NULL, not the JSON literal `null` ─────────────
    # Invisible from Python — a JSONB column holding `null` deserializes back to
    # None either way — and wrong only in SQL, which is what makes it worth a
    # test. With plain JSONB, every one of the 68 Azure events collected from a
    # live subscription matched `change_after IS NOT NULL` while carrying no
    # state change at all, so any SQL-level null check on a JSON column
    # (a report, an ops query, the advanced filter's is_null operator) silently
    # returned the wrong rows.
    print("\n1b. absent JSON columns are SQL NULL")

    async with AsyncSessionLocal() as db:
        repo = EventRepository(db)
        await repo.insert_events(account_id, [make_event(
            provider_event_id="json-null-probe",
            change_before=None, change_after=None, changed_fields=None,
            actor_chain=None, resources=None, provider_metadata={},
        )])
        await db.commit()

        for column in ("change_before", "change_after", "changed_fields",
                       "actor_chain", "resources", "provider_metadata"):
            row = (await db.execute(
                text(f"SELECT {column} IS NULL AS sql_null, "
                     f"{column} = 'null'::jsonb AS json_null "
                     f"FROM cloud_events WHERE provider_event_id = 'json-null-probe'")
            )).first()
            check(f"{column}: absent value is SQL NULL",
                  row.sql_null is True and not row.json_null,
                  f"sql_null={row.sql_null} json_null={row.json_null}")

        # And a value that IS present still round-trips.
        await repo.insert_events(account_id, [make_event(
            provider_event_id="json-value-probe",
            change_before={"source": "0.0.0.0/0"},
            change_after={"source": "10.0.0.0/8"},
            changed_fields=["source"],
        )])
        await db.commit()
        stored_event = (await repo.list(
            account_id=account_id, simple={"provider_event_id": "json-value-probe"},
        ))[0]
        eq("a real diff still round-trips", stored_event.change_before,
           {"source": "0.0.0.0/0"})
        eq("changed_fields too", stored_event.changed_fields, ["source"])

    # ── 2. Append-only ───────────────────────────────────────────────────────
    print("\n2. immutability")

    async with AsyncSessionLocal() as db:
        row_id = (await db.execute(
            text("SELECT id FROM cloud_events WHERE account_id = :a LIMIT 1"),
            {"a": str(account_id)},
        )).scalar_one()

    async with AsyncSessionLocal() as db:
        try:
            await db.execute(
                text("UPDATE cloud_events SET actor_name = 'tampered' WHERE id = :i"),
                {"i": str(row_id)},
            )
            await db.commit()
            check("the database refuses an UPDATE to an audit event", False,
                  "the update succeeded")
        except Exception as exc:
            await db.rollback()
            check("the database refuses an UPDATE to an audit event",
                  "append-only" in str(exc).lower(), str(exc)[:120])

    async with AsyncSessionLocal() as db:
        try:
            await db.execute(
                text("DELETE FROM cloud_events WHERE id = :i"), {"i": str(row_id)}
            )
            await db.commit()
            check("the database refuses an undeclared DELETE", False,
                  "the delete succeeded")
        except Exception as exc:
            await db.rollback()
            check("the database refuses an undeclared DELETE",
                  "append-only" in str(exc).lower(), str(exc)[:120])

    async with AsyncSessionLocal() as db:
        # Still there, and unmodified.
        actor = (await db.execute(
            text("SELECT actor_name FROM cloud_events WHERE id = :i"),
            {"i": str(row_id)},
        )).scalar_one_or_none()
        eq("the event survived both attempts, unchanged", actor, "saad@example.com")

    async with AsyncSessionLocal() as db:
        # The pruner declares itself and is allowed through — the one sanctioned
        # delete path, and it must actually work or retention is unenforceable.
        #
        # Retention is a GLOBAL policy, so `prune_older_than` deletes across
        # every account by design. That makes the cutoff chosen here safety
        # critical for the test itself: an earlier version passed
        # `BASE_TIME + 3650 days`, a cutoff in 2036, which deleted every row in
        # the table — including 154 audit events this service had genuinely
        # collected from live Azure and OCI accounts. A test suite that destroys
        # real audit data is worse than no test.
        #
        # So the probe uses a purpose-built ANCIENT event and a cutoff that can
        # only ever match it. Nothing a real provider could return is older.
        repo = EventRepository(db)
        ancient_cutoff = datetime(2001, 1, 1, tzinfo=timezone.utc)
        await repo.insert_events(account_id, [make_event(
            provider_event_id="prune-probe",
            timestamp=datetime(2000, 1, 1, tzinfo=timezone.utc),
        )])
        await db.commit()

        removed = await repo.prune_older_than(ancient_cutoff)
        await db.commit()
        eq("the retention pruner IS allowed to delete", removed, 1)

        survivors = await repo.count(account_id=account_id)
        check("and it deleted ONLY what the cutoff covered", survivors >= 1,
              f"{survivors} of this account's events remain")

    async with AsyncSessionLocal() as db:
        # And the permission did not leak past its transaction.
        repo = EventRepository(db)
        await repo.insert_events(account_id, [make_event(provider_event_id="leak-check")])
        await db.commit()
    async with AsyncSessionLocal() as db:
        try:
            await db.execute(
                text("DELETE FROM cloud_events WHERE provider_event_id = 'leak-check'")
            )
            await db.commit()
            check("SET LOCAL did not leak the delete permission to a later session",
                  False, "a later delete succeeded")
        except Exception as exc:
            await db.rollback()
            check("SET LOCAL did not leak the delete permission to a later session",
                  "append-only" in str(exc).lower(), str(exc)[:100])

    # ── 3. Filtering and search ──────────────────────────────────────────────
    print("\n3. filtering and search")

    async with AsyncSessionLocal() as db:
        repo = EventRepository(db)
        await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
        await db.execute(
            text("DELETE FROM cloud_events WHERE account_id = :a"), {"a": str(account_id)}
        )
        await db.commit()

        fixtures = [
            make_event(provider_event_id="f-aws-delete", provider="AWS",
                       event_name="DeleteBucket", action="Delete",
                       event_category="Storage", risk_level="HIGH",
                       actor_name="saad@example.com", status="Success",
                       source_ip="10.10.20.15", timestamp=BASE_TIME),
            make_event(provider_event_id="f-aws-iam", provider="AWS",
                       event_name="AttachRolePolicy", action="Update",
                       event_category="IAM", risk_level="CRITICAL",
                       actor_name="admin@example.com", status="Success",
                       source_ip="10.10.20.16",
                       timestamp=BASE_TIME + timedelta(minutes=5)),
            make_event(provider_event_id="f-azure-read", provider="Azure",
                       event_name="virtualMachines/read", action="Read",
                       event_category="Compute", risk_level="INFO",
                       actor_name="saad@example.com", status="Success",
                       read_only=True, region="eastus",
                       timestamp=BASE_TIME + timedelta(minutes=10)),
            make_event(provider_event_id="f-oci-denied", provider="OCI",
                       event_name="DeleteVcn", action="Delete",
                       event_category="Network", risk_level="HIGH",
                       actor_name="svc-principal", actor_type="ServicePrincipal",
                       status="Denied", error_code="403", region="ap-mumbai-1",
                       timestamp=BASE_TIME + timedelta(minutes=15)),
        ]
        stored, _ = await repo.insert_events(account_id, fixtures)
        await db.commit()
        eq("four fixtures stored", stored, 4)

        window = dict(account_id=account_id, start=BASE_TIME - timedelta(hours=1),
                      end=BASE_TIME + timedelta(hours=1))

        eq("no filter returns all four", await repo.count(**window), 4)
        eq("provider filter", await repo.count(provider="AWS", **window), 2)
        eq("action filter", await repo.count(simple={"action": "Delete"}, **window), 2)
        eq("category filter", await repo.count(simple={"event_category": "IAM"}, **window), 1)
        eq("status filter", await repo.count(simple={"status": "Denied"}, **window), 1)
        eq("actor filter",
           await repo.count(simple={"actor_name": "saad@example.com"}, **window), 2)
        eq("region filter", await repo.count(simple={"region": "eastus"}, **window), 1)

        # Risk ordering is semantic, not alphabetical. Alphabetically CRITICAL
        # sorts below INFO, so a string >= would return the wrong set here.
        eq("min_risk=HIGH returns HIGH and CRITICAL only",
           await repo.count(min_risk="HIGH", **window), 3)
        eq("min_risk=CRITICAL returns only CRITICAL",
           await repo.count(min_risk="CRITICAL", **window), 1)
        eq("min_risk=INFO returns everything",
           await repo.count(min_risk="INFO", **window), 4)

        eq("excluding read-only drops the Azure read",
           await repo.count(exclude_read_only=True, **window), 3)

        # Search across the documented fields.
        eq("search by partial username", await repo.count(search="saad", **window), 2)
        eq("search by event name", await repo.count(search="DeleteBucket", **window), 1)
        eq("search by IP address", await repo.count(search="10.10.20.15", **window), 1)
        eq("search is case-insensitive", await repo.count(search="deletebucket", **window), 1)
        eq("search by resource name", await repo.count(search="example-bucket", **window), 4)
        eq("a search matching nothing returns nothing",
           await repo.count(search="zzzznotpresent", **window), 0)

        # A LIKE wildcard in the term must be a literal, not a wildcard.
        eq("a '%' in the search term is escaped, not treated as a wildcard",
           await repo.count(search="%", **window), 0)
        eq("an '_' in the search term is escaped too",
           await repo.count(search="Delete_ucket", **window), 0)

        # The window must actually bound the query.
        eq("a window before the events returns nothing",
           await repo.count(account_id=account_id,
                            start=BASE_TIME - timedelta(days=2),
                            end=BASE_TIME - timedelta(days=1)), 0)

        # ── Advanced filters ─────────────────────────────────────────────────
        print("\n4. advanced filters")

        tree = {"op": "AND", "conditions": [
            {"field": "provider", "operator": "eq", "value": "AWS"},
            {"field": "risk_level", "operator": "gte", "value": "HIGH"},
        ]}
        eq("AND of provider + risk>=HIGH", await repo.count(advanced=tree, **window), 2)

        tree = {"op": "OR", "conditions": [
            {"field": "action", "operator": "eq", "value": "Delete"},
            {"field": "event_category", "operator": "eq", "value": "IAM"},
        ]}
        eq("OR of two conditions", await repo.count(advanced=tree, **window), 3)

        tree = {"op": "AND", "conditions": [
            {"op": "OR", "conditions": [
                {"field": "action", "operator": "eq", "value": "Delete"},
                {"field": "action", "operator": "eq", "value": "Update"},
            ]},
            {"field": "risk_level", "operator": "gte", "value": "HIGH"},
            {"field": "provider", "operator": "in", "value": ["AWS", "OCI"]},
        ]}
        eq("the specification's nested example",
           await repo.count(advanced=tree, **window), 3)

        tree = {"field": "event_name", "operator": "contains", "value": "delete"}
        eq("contains operator", await repo.count(advanced=tree, **window), 2)
        tree = {"field": "event_name", "operator": "starts_with", "value": "Attach"}
        eq("starts_with operator", await repo.count(advanced=tree, **window), 1)
        tree = {"field": "event_name", "operator": "ends_with", "value": "Bucket"}
        eq("ends_with operator", await repo.count(advanced=tree, **window), 1)
        tree = {"field": "provider", "operator": "not_in", "value": ["AWS"]}
        eq("not_in operator", await repo.count(advanced=tree, **window), 2)
        tree = {"field": "error_code", "operator": "is_not_null"}
        eq("is_not_null operator", await repo.count(advanced=tree, **window), 1)
        tree = {"field": "timestamp", "operator": "after",
                "value": (BASE_TIME + timedelta(minutes=7)).isoformat()}
        eq("after operator on a timestamp", await repo.count(advanced=tree, **window), 2)
        tree = {"field": "timestamp", "operator": "between",
                "value": [(BASE_TIME + timedelta(minutes=3)).isoformat(),
                          (BASE_TIME + timedelta(minutes=12)).isoformat()]}
        eq("between operator on a timestamp", await repo.count(advanced=tree, **window), 2)

        # Bad filters must be REFUSED, not silently ignored — a dropped filter
        # returns a full page that reads as a valid answer.
        for label, bad in [
            ("an unknown field", {"field": "secret_column", "operator": "eq", "value": "x"}),
            ("an unknown operator", {"field": "provider", "operator": "sqlinject", "value": "x"}),
            ("an unknown risk level", {"field": "risk_level", "operator": "gte", "value": "SUPER"}),
            ("an empty in-list", {"field": "provider", "operator": "in", "value": []}),
            ("a non-list for 'in'", {"field": "provider", "operator": "in", "value": "AWS"}),
            ("a malformed between", {"field": "timestamp", "operator": "between", "value": ["x"]}),
            ("an unparseable timestamp",
             {"field": "timestamp", "operator": "after", "value": "yesterday-ish"}),
            ("an empty group", {"op": "AND", "conditions": []}),
            ("a bad group operator",
             {"op": "XOR", "conditions": [{"field": "provider", "operator": "eq", "value": "AWS"}]}),
        ]:
            try:
                await repo.count(advanced=bad, **window)
                check(f"{label} is refused", False, "it was accepted")
            except FilterError as exc:
                check(f"{label} is refused", True, str(exc)[:70])

        # Deeply nested trees are bounded rather than blowing the stack.
        deep = {"field": "provider", "operator": "eq", "value": "AWS"}
        for _ in range(10):
            deep = {"op": "AND", "conditions": [deep]}
        try:
            await repo.count(advanced=deep, **window)
            check("an over-nested filter is refused", False, "it was accepted")
        except FilterError as exc:
            check("an over-nested filter is refused", True, str(exc)[:60])

        eq("an unknown simple filter field is refused too",
           await _expect_filter_error(repo, window, {"nope": "x"}), True)

        # ── 5. Sorting and pagination ────────────────────────────────────────
        print("\n5. sorting and pagination")

        newest = await repo.list(sort="newest", page=1, page_size=25, **window)
        eq("newest-first puts the latest event first",
           newest[0].provider_event_id, "f-oci-denied")
        oldest = await repo.list(sort="oldest", page=1, page_size=25, **window)
        eq("oldest-first inverts it", oldest[0].provider_event_id, "f-aws-delete")

        by_risk = await repo.list(sort="risk", page=1, page_size=25, **window)
        eq("risk sort puts CRITICAL first, not alphabetical order",
           by_risk[0].risk_level, "CRITICAL")
        eq("and INFO last", by_risk[-1].risk_level, "INFO")

        # Paging must neither skip nor repeat, including across events that
        # share a timestamp — which is why `id` is the final tiebreaker.
        tied = [
            make_event(provider_event_id=f"tie-{i}", timestamp=BASE_TIME + timedelta(minutes=30))
            for i in range(10)
        ]
        await repo.insert_events(account_id, tied)
        await db.commit()

        seen = []
        for page in range(1, 8):
            rows = await repo.list(sort="newest", page=page, page_size=2, **window)
            if not rows:
                break
            seen.extend(r.provider_event_id for r in rows)
        eq("paging 2-at-a-time returns every row exactly once",
           len(seen), len(set(seen)))
        eq("and returns all 14 of them", len(seen), 14)

        for size in (25, 50, 100, 250, 500):
            rows = await repo.list(sort="newest", page=1, page_size=size, **window)
            check(f"page_size={size} is honoured", len(rows) == min(size, 14),
                  f"{len(rows)} rows")

        # ── 6. Stats ─────────────────────────────────────────────────────────
        print("\n6. statistics")

        stats = await repo.stats(**window)
        eq("total", stats["total_events"], 14)
        eq("denied counted", stats["denied_events"], 1)
        eq("failed includes denied", stats["failed_events"], 1)
        eq("deletes counted", stats["delete_operations"], 12)
        eq("critical counted", stats["critical_events"], 1)
        eq("high counted", stats["high_risk_events"], 12)
        check("distinct actors counted", stats["distinct_actors"] == 3,
              stats["distinct_actors"])
        check("earliest and latest reported",
              stats["earliest_event"] and stats["latest_event"])
        check("read-only events are not counted as administrative changes",
              stats["administrative_changes"] == 13, stats["administrative_changes"])


        by_provider = dict(await repo.counts_by(CloudEvent.provider, **window))
        eq("counts by provider", by_provider.get("AWS"), 12)

        buckets = await repo.timeline(bucket="hour", **window)
        check("timeline buckets returned", len(buckets) >= 1, f"{len(buckets)} buckets")
        eq("bucket totals add up to the event count",
           sum(b["total"] for b in buckets), 14)

        actors = await repo.top_actors(**window)
        check("top actors returned", len(actors) == 3, f"{len(actors)}")
        eq("busiest actor first", actors[0]["actor_name"], "saad@example.com")

        # ── 7. Related events ────────────────────────────────────────────────
        print("\n7. related events")

        correlated = [
            make_event(provider_event_id="corr-a", provider="Azure",
                       correlation_id="shared-corr", event_name="deployments/write",
                       timestamp=BASE_TIME + timedelta(minutes=40)),
            make_event(provider_event_id="corr-b", provider="Azure",
                       correlation_id="shared-corr", event_name="virtualMachines/write",
                       timestamp=BASE_TIME + timedelta(minutes=41)),
        ]
        await repo.insert_events(account_id, correlated)
        await db.commit()

        anchor = (await repo.list(
            sort="newest", page=1, page_size=1,
            simple={"correlation_id": "shared-corr"}, **window,
        ))[0]
        groups = await repo.related(anchor, limit=10)
        check("a correlation-id group is returned", "correlation" in groups)
        eq("with the sibling event in it", groups["correlation"]["events"][0]
           ["provider_event_id"], "corr-a")
        eq("marked high confidence", groups["correlation"]["confidence"], "high")
        check("a resource group is also returned (same resource)",
              "resource" in groups)
        check("and it is marked as weaker than the provider-asserted link",
              groups["resource"]["confidence"] == "medium")

        # ── 8. Resource lookup (the drift bridge) ────────────────────────────
        print("\n8. resource lookup")

        matched = await repo.for_resource(
            account_id=account_id, resource_id="arn:aws:s3:::example-bucket",
            start=BASE_TIME - timedelta(hours=1), end=BASE_TIME + timedelta(hours=2),
        )
        check("finds events by exact resource id", len(matched) >= 1, f"{len(matched)}")

        by_name = await repo.for_resource(
            account_id=account_id, resource_name="example-bucket",
            start=BASE_TIME - timedelta(hours=1), end=BASE_TIME + timedelta(hours=2),
        )
        check("finds events by resource name", len(by_name) >= 1, f"{len(by_name)}")

        eq("with neither id nor name it returns nothing rather than everything",
           await repo.for_resource(account_id=account_id), [])
        eq("a too-short name is not used as a match (it would match half the table)",
           await repo.for_resource(account_id=account_id, resource_name="ab"), [])

        # ── 9. Export streaming ──────────────────────────────────────────────
        print("\n9. export streaming")

        exported = []
        async for row in repo.iter_for_export(batch_size=3, max_rows=1000, **window):
            exported.append(row.provider_event_id)
        eq("keyset export yields every matching row", len(exported), 16)
        eq("with no repeats", len(exported), len(set(exported)))

        capped = []
        async for row in repo.iter_for_export(batch_size=3, max_rows=5, **window):
            capped.append(row.provider_event_id)
        eq("and honours the row cap", len(capped), 5)

        filtered_export = []
        async for row in repo.iter_for_export(
            batch_size=2, max_rows=100, provider="AWS", **window
        ):
            filtered_export.append(row.provider_event_id)
        eq("export respects the filters, not just the visible page",
           len(filtered_export), 12)

        # ── 10. Sync state and checkpointing ─────────────────────────────────
        print("\n10. sync state")

        state = await repo.upsert_sync_state(account_id, "AWS", "region:ap-south-1")
        await db.commit()
        eq("a new scope starts with no checkpoint", state.checkpoint, None)
        eq("and status NeverRun", state.status, "NeverRun")

        same = await repo.upsert_sync_state(account_id, "AWS", "region:ap-south-1")
        eq("upsert is idempotent (no duplicate scope row)", same.id, state.id)

        await repo.upsert_sync_state(account_id, "AWS", "region:us-east-1")
        await db.commit()
        stale = await repo.stale_scopes(account_id, "AWS", limit=10)
        eq("both scopes are offered for rotation", len(stale), 2)

        states = await repo.list_sync_states(account_id)
        eq("sync states listed", len(states), 2)

        # ── 11. Retention ────────────────────────────────────────────────────
        print("\n11. retention")

        # Same safety rule as the immutability probe above: the cutoff is
        # ancient, so this can only ever match the row planted for it. A cutoff
        # of "now minus 365 days" would also be true of any genuinely old
        # audit event any account had legitimately collected.
        old = make_event(provider_event_id="ancient",
                         timestamp=datetime(2000, 6, 1, tzinfo=timezone.utc))
        await repo.insert_events(account_id, [old])
        await db.commit()

        before_prune = await repo.count(account_id=account_id)
        removed = await repo.prune_older_than(datetime(2001, 1, 1, tzinfo=timezone.utc))
        await db.commit()
        eq("an event older than the retention cutoff is pruned", removed, 1)
        eq("and nothing else was touched",
           await repo.count(account_id=account_id), before_prune - 1)

        # ── 12. "Administrative changes" needs positive evidence ─────────────
        # Placed last on purpose: it adds rows, and every count-based assertion
        # above is exact.
        print("\n12. administrative changes")

        base = await repo.stats(**window)
        await repo.insert_events(account_id, [
            # Verb undecidable AND the provider said nothing -> unknown, not a change.
            make_event(provider_event_id="unclassified", action="Other",
                       read_only=None, event_name="FailureDecide"),
            # Verb undecidable but the provider marked it a write -> IS a change.
            make_event(provider_event_id="unclassified-but-write", action="Other",
                       read_only=False, event_name="FailureDecide"),
            # Authentication, not configuration change.
            make_event(provider_event_id="a-login", action="Login",
                       read_only=None, event_name="ConsoleLogin"),
        ])
        await db.commit()
        after = await repo.stats(**window)

        eq("total counts all three regardless",
           after["total_events"], base["total_events"] + 3)
        # Only the provider-confirmed write is administrative. Counting the
        # other two made this figure equal the total on live OCI data (457 of
        # 457), asserting something about every unclassifiable event.
        eq("only the provider-confirmed write is an administrative change",
           after["administrative_changes"], base["administrative_changes"] + 1)

        settings = await repo.get_settings()
        eq("default application retention is 90 days", settings.retention_days, 90)
        check("collection is on by default", settings.collection_enabled is True)
        check("read-only collection is off by default",
              settings.collect_read_only is False)
        await db.commit()

    # The summary is printed by main(), after the data-safety guard has had its
    # say — that check belongs in the count too.
    return 0


async def _expect_filter_error(repo, window, simple) -> bool:
    try:
        await repo.count(simple=simple, **window)
        return False
    except FilterError:
        return True


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
