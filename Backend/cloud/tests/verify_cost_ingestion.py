"""Cost persistence: idempotent ingestion, finality, window planning and the
history/coverage surface.

Run: venv\\Scripts\\python.exe tests\\verify_cost_ingestion.py

Section 3 is the load-bearing one. Re-ingesting a window MUST correct history,
not double it — everything later phases build (forecasts, anomaly baselines,
budget burn) is only as good as that guarantee. Section 2 pins the reason the
idempotency key is a hash: a composite UNIQUE over nullable dimension columns
does not dedupe in SQL, because NULL != NULL.

Creates and removes its own account, and asserts the fact count returns to
where it started.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_fact import (  # noqa: E402
    PROVISIONAL, STABLE, CloudCostFact, build_fact_key,
)
from app.repository.cost_fact_repo import CostFactRepository  # noqa: E402
from app.services import cost_ingestion  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/cost"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class FakeAccount:
    """Stand-in for the ORM CloudAccount, for the pure-normalization tests."""
    def __init__(self, provider="ORACLE"):
        self.id = uuid.uuid4()
        self.provider = provider
        self.account_name = "fake"


async def make_account(name="zz-test-ingest", provider="ORACLE"):
    async with AsyncSessionLocal() as db:
        acc = CloudAccount(
            account_name=name, provider=provider, environment="Development",
            tenant_or_region="test", auth_mode="API_Keys",
            credentials_enc="not-a-real-credential", auto_discovery=False,
        )
        db.add(acc)
        await db.commit()
        await db.refresh(acc)
        return acc.id


async def drop_account(account_id):
    async with AsyncSessionLocal() as db:
        acc = await db.get(CloudAccount, account_id)
        if acc:
            await db.delete(acc)
            await db.commit()


async def fact_count():
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(func.count()).select_from(CloudCostFact))).scalar()


def rows(*triples):
    """(date, service, cost) -> provider get_cost_report row shape."""
    return [{"date": d, "service": s, "region": "ap-mumbai-1",
             "cost": c, "currency": "INR"} for d, s, c in triples]


async def main():
    # create_all normally runs in the app lifespan, which an ASGI-transport
    # test never triggers. Creates missing tables only; never alters existing.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    facts_before = await fact_count()

    print("1. Window planning covers the range, oldest first, without gaps")
    today = date(2026, 9, 15)
    windows = cost_ingestion.plan_windows(90, today=today)
    check("windows returned", len(windows) == 3, str(len(windows)))
    check("oldest first", windows[0][0] < windows[-1][0])
    check("starts exactly `days` back", windows[0][0] == today - timedelta(days=90),
          str(windows[0][0]))
    check("ends today", windows[-1][1] == today, str(windows[-1][1]))
    check("contiguous, no gaps",
          all(windows[i][1] == windows[i + 1][0] for i in range(len(windows) - 1)))
    check("no window exceeds the chunk size",
          all((e - s).days <= cost_ingestion.BACKFILL_WINDOW_DAYS for s, e in windows))
    check("a 1-day request still yields one window",
          len(cost_ingestion.plan_windows(1, today=today)) == 1)
    check("over-long request is clamped to 365",
          cost_ingestion.plan_windows(9999, today=today)[0][0]
          == today - timedelta(days=365))

    print("\n2. THE KEY IS A HASH -- NULL dimensions must still collide")
    aid = uuid.uuid4()
    base = dict(account_id=aid, provider="AWS", billing_date=date(2026, 9, 1),
                service="EC2", region=None, resource_id=None,
                usage_type=None, currency="USD")
    check("identical input -> identical key",
          build_fact_key(**base) == build_fact_key(**base))
    check("two NULL-dimension rows collide (a composite UNIQUE would not)",
          build_fact_key(**base) == build_fact_key(**{**base, "region": None}))
    check("differing service -> different key",
          build_fact_key(**base) != build_fact_key(**{**base, "service": "S3"}))
    check("differing date -> different key",
          build_fact_key(**base) != build_fact_key(**{**base, "billing_date": date(2026, 9, 2)}))
    check("differing currency -> different key",
          build_fact_key(**base) != build_fact_key(**{**base, "currency": "INR"}))
    check("case differences normalize to ONE key (Azure returns mixed case)",
          build_fact_key(**{**base, "resource_id": "/SUBS/A/RG/B"})
          == build_fact_key(**{**base, "resource_id": "/subs/a/rg/b"}))
    check("empty string and None are the same absence",
          build_fact_key(**{**base, "region": ""}) == build_fact_key(**base))
    # Delimiter check: without one, ("ab","c") and ("a","bc") would collide.
    check("field boundaries cannot be forged",
          build_fact_key(**{**base, "service": "ab", "region": "c"})
          != build_fact_key(**{**base, "service": "a", "region": "bc"}))

    account_id = await make_account()
    async with AsyncSessionLocal() as db:
        account = await db.get(CloudAccount, account_id)
        repo = CostFactRepository(db)

        print("\n3. THE INVARIANT -- re-ingesting corrects history, never doubles it")
        batch = rows(("2026-09-01", "Compute", 100.0), ("2026-09-02", "Compute", 120.0))
        facts, _ = cost_ingestion.normalize_report_rows(account, batch)
        ins, upd = await repo.upsert_facts(facts)
        check("first ingest inserts both", (ins, upd) == (2, 0), f"{ins} inserted, {upd} updated")
        check("2 facts stored", await repo.count_for_account(account_id) == 2)

        facts2, _ = cost_ingestion.normalize_report_rows(account, batch)
        ins2, upd2 = await repo.upsert_facts(facts2)
        check("SECOND ingest of the SAME window inserts nothing",
              ins2 == 0, f"{ins2} inserted")
        check("it updates in place instead", upd2 == 2, f"{upd2} updated")
        check("still exactly 2 facts -- no duplication",
              await repo.count_for_account(account_id) == 2)

        series = await repo.daily_series([account_id], date(2026, 8, 1), date(2026, 10, 1))
        total = sum(s["amount"] for s in series)
        check("total is 220, not 440 (the doubling bug)", abs(total - 220.0) < 1e-6,
              str(total))

        print("\n4. A restated amount overwrites, and drops back to provisional")
        restated = rows(("2026-09-01", "Compute", 175.0))
        facts3, _ = cost_ingestion.normalize_report_rows(account, restated)
        await repo.upsert_facts(facts3)
        series = await repo.daily_series([account_id], date(2026, 8, 1), date(2026, 10, 1))
        day1 = next(s for s in series if s["date"] == "2026-09-01")
        check("amount corrected in place", abs(day1["amount"] - 175.0) < 1e-6,
              str(day1["amount"]))
        check("still one row for that day", day1["records"] == 1, str(day1["records"]))

        async with AsyncSessionLocal() as probe:
            row = (await probe.execute(
                select(CloudCostFact).where(
                    CloudCostFact.account_id == account_id,
                    CloudCostFact.billing_date == date(2026, 9, 1),
                )
            )).scalars().one()
            check("revision_count incremented", row.revision_count == 3,
                  str(row.revision_count))
            check("last_changed_at set when the amount moved",
                  row.last_changed_at is not None)
            check("finality is provisional after a change", row.finality == PROVISIONAL,
                  row.finality)

        print("\n5. NULL amount is stored as NULL, never as zero")
        nullrow = [{"date": "2026-09-03", "service": "Mystery", "region": None,
                    "cost": None, "currency": "INR"}]
        facts4, rejected = cost_ingestion.normalize_report_rows(account, nullrow)
        check("row is kept, not dropped", len(facts4) == 1)
        check("counted as no_amount", rejected["no_amount"] == 1)
        check("amount is None, not 0.0", facts4[0]["amount"] is None,
              str(facts4[0]["amount"]))
        await repo.upsert_facts(facts4)

        print("\n6. An undated row is REJECTED -- it would land on the wrong day")
        bad = [{"date": None, "service": "X", "cost": 5.0, "currency": "INR"},
               {"date": "not-a-date", "service": "Y", "cost": 5.0, "currency": "INR"}]
        facts5, rejected5 = cost_ingestion.normalize_report_rows(account, bad)
        check("neither row becomes a fact", facts5 == [], str(len(facts5)))
        check("both counted as undated", rejected5["undated"] == 2, str(rejected5["undated"]))

        print("\n7. Duplicates WITHIN one batch are merged, not rejected by Postgres")
        # Azure's window-splitting and OCI's per-compartment rows both do this.
        dupes = rows(("2026-09-05", "Storage", 10.0), ("2026-09-05", "Storage", 15.0))
        facts6, _ = cost_ingestion.normalize_report_rows(account, dupes)
        merged = cost_ingestion._dedupe(facts6)
        check("two rows collapse to one", len(merged) == 1, str(len(merged)))
        check("amounts are summed, matching an unsplit query",
              abs(merged[0]["amount"] - 25.0) < 1e-9, str(merged[0]["amount"]))
        ins7, _ = await repo.upsert_facts(merged)
        check("the merged row inserts cleanly", ins7 == 1, str(ins7))

        none_pair, _ = cost_ingestion.normalize_report_rows(
            account, [{"date": "2026-09-06", "service": "Z", "region": None,
                       "cost": None, "currency": "INR"},
                      {"date": "2026-09-06", "service": "Z", "region": None,
                       "cost": None, "currency": "INR"}])
        check("None + None stays None when merging, never 0",
              cost_ingestion._dedupe(none_pair)[0]["amount"] is None)

        print("\n8. Finality: STABLE must be earned, and `final` is never asserted")
        promoted = await repo.promote_stable(account_id)
        check("nothing just-written is promoted", promoted == 0, str(promoted))

        # Age a settled fact past the threshold to earn STABLE.
        async with AsyncSessionLocal() as probe:
            row = (await probe.execute(
                select(CloudCostFact).where(
                    CloudCostFact.account_id == account_id,
                    CloudCostFact.billing_date == date(2026, 9, 2),
                )
            )).scalars().one()
            row.last_changed_at = datetime.now(timezone.utc) - timedelta(days=10)
            row.revision_count = 4
            await probe.commit()

        promoted = await repo.promote_stable(account_id)
        check("a settled, twice-read, aged fact IS promoted", promoted == 1, str(promoted))
        async with AsyncSessionLocal() as probe:
            row = (await probe.execute(
                select(CloudCostFact).where(
                    CloudCostFact.account_id == account_id,
                    CloudCostFact.billing_date == date(2026, 9, 2),
                )
            )).scalars().one()
            check("it is STABLE", row.finality == STABLE, row.finality)
            check("it is NOT 'final' -- no provider said so", row.finality != "final")

        print("\n9. Coverage counts distinct billed days, not the span")
        coverage = await repo.coverage([account_id])
        check("has_history true", coverage["has_history"] is True)
        check("earliest is the first stored day", coverage["earliest"] == "2026-09-01",
              str(coverage["earliest"]))
        # Stored days are 09-01, 09-02, 09-03, 09-05 -- the 09-06 pair above was
        # only merged, never upserted. So 4 distinct days across a 5-day span:
        # 09-04 is a real gap and must NOT be counted as covered.
        check("distinct days counted (a mid-range gap is not 'covered')",
              coverage["days_covered"] == 4, str(coverage["days_covered"]))
        check("span is longer than the days actually covered",
              (date.fromisoformat(coverage["latest"])
               - date.fromisoformat(coverage["earliest"])).days + 1 > coverage["days_covered"])
        check("currency reported", coverage["currencies"] == ["INR"],
              str(coverage["currencies"]))

        print("\n10. Aggregations never sum across currencies")
        usd, _ = cost_ingestion.normalize_report_rows(
            account, [{"date": "2026-09-01", "service": "Compute",
                       "region": "us-east-1", "cost": 50.0, "currency": "USD"}])
        await repo.upsert_facts(usd)
        series = await repo.daily_series([account_id], date(2026, 8, 1), date(2026, 10, 1))
        sept1 = [s for s in series if s["date"] == "2026-09-01"]
        check("09-01 splits into two currency rows", len(sept1) == 2, str(len(sept1)))
        check("INR kept separate",
              any(abs(s["amount"] - 175.0) < 1e-6 and s["currency"] == "INR" for s in sept1))
        check("USD kept separate",
              any(abs(s["amount"] - 50.0) < 1e-6 and s["currency"] == "USD" for s in sept1))
        check("no row equals the meaningless cross-currency sum",
              not any(abs(s["amount"] - 225.0) < 1e-6 for s in sept1))

        by_service = await repo.totals_by([account_id], date(2026, 8, 1), date(2026, 10, 1))
        check("totals_by groups per currency too",
              all("currency" in r for r in by_service))
        try:
            await repo.totals_by([account_id], date(2026, 8, 1), date(2026, 10, 1), "nonsense")
            check("unknown dimension rejected", False)
        except ValueError:
            check("unknown dimension rejected", True)

        print("\n11. Monthly totals flag months that are still provisional")
        monthly = await repo.monthly_totals([account_id])
        sept = [m for m in monthly if m["month"] == "2026-09"]
        check("September present", len(sept) >= 1)
        check("provisional records counted",
              any(m["provisional_records"] > 0 for m in sept), str(sept))
        check("a month with provisional rows is NOT marked settled",
              all(m["settled"] is False for m in sept if m["provisional_records"]))

    print("\n12. HTTP surface")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get(f"{BASE}/coverage/{account_id}")
        check("coverage 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("reports what history supports", "supports" in body)
        check("5 days is not enough to forecast",
              body["supports"]["run_rate_forecast"] is False)
        check("5 days is not enough for an anomaly baseline",
              body["supports"]["anomaly_baseline"] is False)
        check("but is enough for a daily trend", body["supports"]["daily_trend"] is True)

        r = await c.get(f"{BASE}/history/{account_id}?days=90&group_by=service")
        check("history 200", r.status_code == 200, str(r.status_code))
        h = r.json()
        check("series returned", len(h["series"]) > 0)
        check("grouped returned", "grouped" in h)
        check("coverage travels with the series", "coverage" in h)
        check("source is named", h["source"] == "cloud_cost_facts")

        r = await c.get(f"{BASE}/history/{account_id}?group_by=nonsense")
        check("bad grouping -> 400", r.status_code == 400, str(r.status_code))

        r = await c.get(f"{BASE}/backfill/status/{account_id}")
        check("backfill status 200", r.status_code == 200, str(r.status_code))
        check("no job yet -> null, not a fabricated one", r.json()["job"] is None)

    print("\n13. Cleanup leaves no residue")
    async with AsyncSessionLocal() as db:
        removed = await CostFactRepository(db).delete_for_account(account_id)
    check("facts removed", removed > 0, str(removed))
    await drop_account(account_id)
    check("fact table back to its starting size", await fact_count() == facts_before,
          f"{facts_before} -> {await fact_count()}")

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
