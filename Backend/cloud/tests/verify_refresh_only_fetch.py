"""AWS is read only during a refresh: page views never call it.

Run: venv\\Scripts\\python.exe tests\\verify_refresh_only_fetch.py

AWS bills per call (Cost Explorer $0.01 a request, CloudWatch GetMetricData per
metric), so app/services/fetch_policy.py makes it refresh-only: Refresh all, a
tab's Refresh, Run Discovery, a backfill or the scheduled refresh read AWS, and
nothing else does. This suite drives the PRODUCTION functions — the cost
fetchers, prewarm, the event collector loop and the Monitoring-tab metrics —
with a fake provider that counts calls, and a botocore guard that fails the run
if any real AWS request leaves the process.

The load-bearing checks are the "0 provider calls" ones in sections 2, 4, 5, 7
and 10. Section 8 pins the other half: Azure and OCI, which are free to read,
keep reading live exactly as before.

Creates and removes its own accounts (zz-test-refreshonly-*).
"""
import asyncio
import logging
import pathlib
import sys
import time
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import botocore.endpoint  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402,F401  (registers every model for create_all)
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_fact import CloudCostFact, CloudCostSnapshot, build_fact_key  # noqa: E402
from app.models.optimization import CloudResourceTelemetry  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402
from app.services import cost_service, event_collector, fetch_policy, metrics_service  # noqa: E402

ok, fail = [], []
PREFIX = "zz-test-refreshonly-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


# ── Guards and fakes ─────────────────────────────────────────────────────────

REAL_AWS_SENDS = []
_orig_send = botocore.endpoint.Endpoint._send


def _guarded_send(self, request):
    # Any real AWS request from this process is a failure of the rule under test.
    REAL_AWS_SENDS.append(request.url)
    raise AssertionError(f"real AWS request attempted: {request.url}")


botocore.endpoint.Endpoint._send = _guarded_send


class FakeProvider:
    """Counts every billing call; returns provider-shaped rows."""
    calls = {"get_cost_data": 0, "get_daily_costs": 0, "get_cost_report": 0}

    async def get_cost_data(self):
        FakeProvider.calls["get_cost_data"] += 1
        return [{"resource_type": "Amazon EC2", "resource_name": "Amazon EC2",
                 "region": "ap-south-1", "monthly_cost": 12.5, "currency": "USD"}]

    async def get_daily_costs(self):
        FakeProvider.calls["get_daily_costs"] += 1
        return [{"date": "2026-10-01", "cost": 0.42, "currency": "USD"}]

    async def get_cost_report(self, days):
        FakeProvider.calls["get_cost_report"] += 1
        return [{"date": "2026-10-01", "service": "LIVE", "resource_type": None,
                 "region": None, "cost": 1.0, "currency": "USD"}]


def total_calls():
    return sum(FakeProvider.calls.values())


cost_service._require_provider = lambda account: FakeProvider()


def clear_memory_caches():
    """What a service restart does to the in-process state."""
    for cache in (cost_service._real_cost_cache, cost_service._daily_cost_cache,
                  cost_service._real_cost_by_resource_cache, cost_service._cost_report_cache):
        cache.clear()
    cost_service._cost_error_reason.clear()


# ── Fixtures ─────────────────────────────────────────────────────────────────

async def purge():
    async with AsyncSessionLocal() as db:
        ids = (await db.execute(select(CloudAccount.id)
                                .where(CloudAccount.account_name.like(PREFIX + "%")))).scalars().all()
        for aid in ids:
            await db.execute(delete(CloudCostSnapshot).where(CloudCostSnapshot.account_id == aid))
            await db.execute(delete(CloudCostFact).where(CloudCostFact.account_id == aid))
            await db.execute(delete(CloudResourceTelemetry).where(CloudResourceTelemetry.account_id == aid))
            await db.execute(delete(CloudResource).where(CloudResource.account_id == aid))
            await db.execute(delete(CloudAccount).where(CloudAccount.id == aid))
        await db.commit()
    return len(ids)


async def make_account(suffix, provider):
    async with AsyncSessionLocal() as db:
        acc = CloudAccount(
            account_name=PREFIX + suffix, provider=provider, environment="Development",
            tenant_or_region="test", auth_mode="API_Keys",
            credentials_enc="not-a-real-credential", auto_discovery=True,
        )
        db.add(acc)
        await db.commit()
        await db.refresh(acc)
        return acc


async def snapshot_rows(account_id):
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(CloudCostSnapshot)
                                 .where(CloudCostSnapshot.account_id == account_id))).scalars().all()


async def add_fact(account_id, billing_date, service, usage_type, amount):
    fact = {
        "id": uuid.uuid4(), "account_id": account_id, "provider": "AWS",
        "billing_date": billing_date, "service": service, "region": None,
        "resource_id": None, "resource_name": None, "resource_type": None,
        "usage_type": usage_type, "cost_component": None, "resource_group": None,
        "compartment": None, "amount": amount, "currency": "USD",
        "source": "provider_billing", "in_inventory": False,
    }
    fact["fact_key"] = build_fact_key(**{k: fact[k] for k in (
        "account_id", "provider", "billing_date", "service", "region",
        "resource_id", "usage_type", "currency")})
    async with AsyncSessionLocal() as db:
        db.add(CloudCostFact(**fact))
        await db.commit()


# ── The suite ────────────────────────────────────────────────────────────────

async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    stale = await purge()
    if stale:
        print(f"(purged {stale} leftover test account(s) from a crashed run)")

    aws = await make_account("aws", "AWS")
    azure = await make_account("azure", "Azure")
    clear_memory_caches()

    print("\n1. The policy itself")
    check("AWS is refresh-only", fetch_policy.refresh_only("AWS") and fetch_policy.refresh_only("aws"))
    check("Azure and OCI are not", not fetch_policy.refresh_only("Azure")
          and not fetch_policy.refresh_only("OCI") and not fetch_policy.refresh_only(None))
    check("outside a refresh, AWS may not be called", not fetch_policy.may_call_provider("AWS"))
    check("Azure may always be called", fetch_policy.may_call_provider("Azure"))
    with fetch_policy.refresh_activity():
        inside = fetch_policy.may_call_provider("AWS")

        async def child():
            return fetch_policy.in_refresh()
        in_task = await asyncio.create_task(child())
    check("inside refresh_activity, AWS may be called", inside)
    check("the refresh follows the work into tasks it spawns", in_task)
    check("and ends when the refresh does", not fetch_policy.in_refresh())

    async def unrelated():
        return fetch_policy.in_refresh()
    outside_task = asyncio.create_task(unrelated())
    with fetch_policy.refresh_activity():
        leaked = await outside_task
    check("a request started outside a refresh is not swept into one", leaked is False)

    print("\n2. Page view, nothing saved yet -> no AWS call, an honest reason")
    before = total_calls()
    rows = await cost_service.fetch_real_costs(aws)
    daily = await cost_service.fetch_daily_costs(aws)
    check("summary empty", rows == [], str(rows))
    check("daily empty", daily == [], str(daily))
    check("0 provider calls", total_calls() == before, f"{total_calls() - before} made")
    diag = cost_service.get_cost_diagnostic(aws.id) or {}
    check("diagnostic says 'awaiting_refresh', not an error",
          diag.get("category") == cost_service.AWAITING_REFRESH, str(diag.get("category")))
    check("and it is not marked retryable (no spinner)", diag.get("retryable") is False)

    print("\n3. A refresh (prewarm) reads AWS once per query and saves the answer")
    before = dict(FakeProvider.calls)
    await cost_service.prewarm_cost_cache(aws)
    check("get_cost_data called once",
          FakeProvider.calls["get_cost_data"] == before["get_cost_data"] + 1)
    check("get_daily_costs called once",
          FakeProvider.calls["get_daily_costs"] == before["get_daily_costs"] + 1)
    snaps = {s.kind: s for s in await snapshot_rows(aws.id)}
    check("summary snapshot saved", "summary" in snaps, str(sorted(snaps)))
    check("daily snapshot saved", "daily" in snaps)
    check("saved payload is exactly what the provider returned",
          snaps.get("summary") is not None and snaps["summary"].payload[0]["monthly_cost"] == 12.5)
    check("diagnostic cleared by the successful refresh",
          cost_service.get_cost_diagnostic(aws.id) is None)

    print("\n4. Page views after the 15-minute TTL -> still the saved data, no AWS call")
    key = str(aws.id)
    entry = cost_service._real_cost_cache[key]
    aged = time.time() - 6 * 3600
    cost_service._real_cost_cache[key] = (aged,) + tuple(entry[1:])
    before = total_calls()
    rows = await cost_service.fetch_real_costs(aws)
    check("served the refresh's rows", len(rows) == 1 and rows[0]["monthly_cost"] == 12.5)
    check("0 provider calls 6 hours later", total_calls() == before)
    check("_cache_get keeps a pinned entry past the TTL (deadline fallback path)",
          cost_service._cache_get(cost_service._real_cost_cache, key) is not None)

    print("\n5. Service restart -> saved data comes back from the database, no AWS call")
    clear_memory_caches()
    before = total_calls()
    rows = await cost_service.fetch_real_costs(aws)
    daily = await cost_service.fetch_daily_costs(aws)
    check("summary restored", len(rows) == 1 and rows[0]["region"] == "ap-south-1", str(rows)[:120])
    check("daily restored", len(daily) == 1 and daily[0]["cost"] == 0.42)
    check("0 provider calls", total_calls() == before)
    meta = cost_service._cache_meta(cost_service._real_cost_cache, key)
    saved_at = snaps["summary"].fetched_at.timestamp()
    check("freshness shows when the refresh ran, not when it was restored",
          abs(meta["retrieved_at"] - saved_at) < 1, f"{meta['retrieved_at']} vs {saved_at}")
    check("no diagnostic when saved data exists", cost_service.get_cost_diagnostic(aws.id) is None)

    print("\n6. A second refresh minutes later still re-reads AWS (refresh = latest)")
    before = FakeProvider.calls["get_cost_data"]
    await cost_service.prewarm_cost_cache(aws)
    check("get_cost_data called again", FakeProvider.calls["get_cost_data"] == before + 1)
    snaps2 = {s.kind: s for s in await snapshot_rows(aws.id)}
    check("snapshot updated in place (one row per query, not a new one)",
          len([s for s in await snapshot_rows(aws.id) if s.kind == "summary"]) == 1)
    check("fetched_at moved forward", snaps2["summary"].fetched_at >= snaps["summary"].fetched_at)

    print("\n7. Report windows come from stored billing facts, no AWS call")
    today = date.today()
    await add_fact(aws.id, today - timedelta(days=2), "Amazon EC2", "BoxUsage:t3.micro", 1.25)
    await add_fact(aws.id, today - timedelta(days=1), "Amazon S3", "TimedStorage-ByteHrs", 0.5)
    await add_fact(aws.id, today - timedelta(days=45), "Amazon EC2", "BoxUsage:t3.micro", 9.0)
    await add_fact(aws.id, today, "Amazon EC2", "BoxUsage:t3.micro", 7.0)
    before = total_calls()
    rep30 = await cost_service.fetch_cost_report(aws, 30)
    rep90 = await cost_service.fetch_cost_report(aws, 90)
    check("0 provider calls", total_calls() == before and FakeProvider.calls["get_cost_report"] == 0)
    check("30-day window: the two in-range facts", len(rep30) == 2, str(rep30))
    check("today excluded (Cost Explorer's End is exclusive)",
          all(r["date"] != today.isoformat() for r in rep30))
    check("90-day window also reaches the 45-day-old fact", len(rep90) == 3, str(len(rep90)))
    first = rep30[0] if rep30 else {}
    check("row shape matches get_cost_report",
          first.get("service") == "Amazon EC2" and first.get("resource_type") == "BoxUsage:t3.micro"
          and first.get("cost") == 1.25 and first.get("currency") == "USD"
          and first.get("date") == (today - timedelta(days=2)).isoformat(), str(first))

    print("\n8. Azure is unchanged: an expired cache still reads live")
    cost_service._real_cost_cache[str(azure.id)] = (time.time() - 3600, [{"stale": True}], False, time.time() - 3600)
    before = FakeProvider.calls["get_cost_data"]
    rows = await cost_service.fetch_real_costs(azure)
    check("Azure read live", FakeProvider.calls["get_cost_data"] == before + 1)
    check("and returned the fresh rows", rows and rows[0].get("monthly_cost") == 12.5)
    check("no snapshot written for Azure (it is not refresh-only)", await snapshot_rows(azure.id) == [])

    print("\n9. A real failure from the last refresh is not papered over")
    async with AsyncSessionLocal() as db:
        await db.execute(delete(CloudCostSnapshot).where(CloudCostSnapshot.account_id == aws.id))
        await db.commit()
    clear_memory_caches()
    cost_service._cost_error_reason[str(aws.id)] = {"category": "permission", "message": "denied"}
    await cost_service.fetch_real_costs(aws)
    check("permission diagnostic kept",
          (cost_service.get_cost_diagnostic(aws.id) or {}).get("category") == "permission")
    clear_memory_caches()

    print("\n10. The 15-minute event collector skips AWS; explicit collection does not")
    collected = []

    async def fake_collect(account_id, **_):
        collected.append(account_id)
        return {"stored": 0}

    class FakeRepo:
        def __init__(self, db):
            pass

        async def list_all(self):
            return [aws, azure]

    real_collect, real_repo = event_collector.collect_account, event_collector.CloudAccountRepository
    event_collector.collect_account, event_collector.CloudAccountRepository = fake_collect, FakeRepo
    try:
        await event_collector.collect_all_accounts(only_auto=True)
        auto = list(collected)
        collected.clear()
        await event_collector.collect_all_accounts(only_auto=False)
        manual = list(collected)
    finally:
        event_collector.collect_account, event_collector.CloudAccountRepository = real_collect, real_repo
    check("background loop: Azure collected, AWS skipped", auto == [azure.id], str(auto))
    check("Collect-all button: both collected", set(manual) == {aws.id, azure.id}, str(manual))

    print("\n11. Monitoring tab for AWS serves saved telemetry and never builds a CloudWatch client")
    import app.providers.aws.aws_auth as aws_auth_mod
    built = []
    real_auth = aws_auth_mod.AWSAuth

    class ExplodingAuth:
        def __init__(self, *a, **k):
            built.append(1)
            raise AssertionError("AWSAuth constructed for a page view")

    aws_auth_mod.AWSAuth = ExplodingAuth
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    try:
        async with AsyncSessionLocal() as db:
            ec2 = CloudResource(account_id=aws.id, provider_resource_id="i-zztest",
                                resource_type="EC2Instance", resource_name="zz-ec2",
                                region_or_zone="ap-south-1")
            stopped = CloudResource(account_id=aws.id, provider_resource_id="i-zzstopped",
                                    resource_type="EC2Instance", resource_name="zz-ec2-stopped",
                                    region_or_zone="ap-south-1")
            db.add_all([ec2, stopped])
            await db.flush()
            hourly = [[int((now - timedelta(hours=h)).timestamp()), 10.0 + h] for h in reversed(range(30))]
            db.add_all([
                CloudResourceTelemetry(account_id=aws.id, resource_id=ec2.id, provider="AWS",
                                       metric="cpu_percent", status="OK", granularity_seconds=3600,
                                       series=hourly, collected_at=now),
                CloudResourceTelemetry(account_id=aws.id, resource_id=ec2.id, provider="AWS",
                                       metric="network_in", status="OK", granularity_seconds=3600,
                                       series=[[hourly[-1][0], 2048.0]], collected_at=now),
                CloudResourceTelemetry(account_id=aws.id, resource_id=stopped.id, provider="AWS",
                                       metric="cpu_percent", status="SKIPPED",
                                       reason="Not queried: the instance was stopped when telemetry was collected.",
                                       collected_at=now),
            ])
            await db.commit()
            ec2_id, stopped_id = ec2.id, stopped.id

        async with AsyncSessionLocal() as db:
            out = await metrics_service.get_resource_metrics(ec2_id, db)
        async with AsyncSessionLocal() as db:
            out_stopped = await metrics_service.get_resource_metrics(stopped_id, db)
    finally:
        aws_auth_mod.AWSAuth = real_auth

    cpu = out.get("metrics", {}).get("CPU Utilization (%)", [])
    check("no CloudWatch client built", built == [])
    check("labelled as saved, not live", out.get("saved") is True and out.get("realtime") is False)
    check("as_of is the refresh time", out.get("as_of") == now.isoformat(), str(out.get("as_of")))
    check("CPU uses the live path's label", bool(cpu))
    check("last 24 hourly points only", len(cpu) == 24, str(len(cpu)))
    check("values are the stored ones", cpu and cpu[-1]["value"] == 10.0, str(cpu[-1] if cpu else None))
    net = out.get("metrics", {}).get("Network In (KB)", [])
    check("network bytes shown in KB like the live path", net and net[0]["value"] == 2.0, str(net))
    check("CPU charted before network", list(out.get("metrics", {}))[:2] ==
          ["CPU Utilization (%)", "Network In (KB)"], str(list(out.get("metrics", {}))))
    d = out_stopped.get("diagnostic") or {}
    check("stopped instance: says what the refresh recorded",
          d.get("category") == "awaiting_refresh" and "stopped" in d.get("message", ""), str(d)[:140])

    print("\n12. Not one real AWS request left this process")
    check("botocore guard saw 0 requests", REAL_AWS_SENDS == [], str(REAL_AWS_SENDS[:3]))

    print("\n13. Cleanup leaves no residue")
    removed = await purge()
    check("test accounts removed", removed == 2, str(removed))
    check("their snapshots went with them", await snapshot_rows(aws.id) == [])

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
