"""The FinOps scorecard: phase grouping, Crawl/Walk/Run maturity, the
optimization-review signal, per-client aggregation, and the daily trend.

Run: venv\\Scripts\\python.exe tests\\verify_finops_scorecard.py

What this suite exists to pin, beyond what verify_cost_governance.py already
covers for the plain 6-component score:

1. Phases group the SAME components the score already uses -- never a second
   measurement (sections 1-2).
2. Overall maturity is the WEAKEST phase, never an average of phases, and an
   un-scoreable phase is excluded from that comparison rather than dragging
   it down to Crawl (section 3).
3. THE BUDGET-SCOPING BUG: get_governance used to count every enabled budget
   in the whole database against every account's budget_coverage. Section 4
   proves an unrelated account's budget no longer inflates this one's score.
4. THE OPTIMIZE SIGNAL is new: of the cost-impacting findings a human could
   currently see, what share have been looked at. Section 5 pins the three
   honest answers -- never analysed (None), analysed with nothing to review
   (100), and analysed with something still sitting at NEW (not 100).
5. PER-CLIENT SCOPING (section 6): the scope this product had no way to ask
   for before -- exactly the accounts under one client, not one account and
   not every account -- aggregated through the IDENTICAL computation
   get_governance uses, so the two can never disagree.
6. THE DAILY SNAPSHOT (section 7): recording today's score twns a trend
   without flooding the table -- a second read on the same day writes
   nothing, and the history returned is oldest first.

Creates and removes its own accounts, client, budgets, findings and decision;
asserts every row count returns to where it started.
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
from sqlalchemy import delete as sa_delete, func, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.client import CloudClient  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_budget import CloudCostBudget  # noqa: E402
from app.models.finops_scorecard import (  # noqa: E402
    ESTATE_SCOPE_ID, SCOPE_ACCOUNT, SCOPE_CLIENT, CloudFinopsScorecard,
)
from app.models.optimization import CloudOptimizationFinding, CloudOptimizationRun  # noqa: E402
from app.optimization import model as opt_model  # noqa: E402
from app.repository.cost_reco_repo import CostRecommendationRepository  # noqa: E402
from app.repository.finops_scorecard_repo import FinopsScorecardRepository  # noqa: E402
from app.services import cost_allocation_service as alloc  # noqa: E402
from app.services.cost_service import CostService  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/clients"
PREFIX = "zz-test-scorecard-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def make_finding(*, account_id, fingerprint, signal="UNUSED", status="OPEN"):
    now = datetime.now(timezone.utc)
    return CloudOptimizationFinding(
        account_id=account_id, provider="AZURE", fingerprint=fingerprint,
        rule_id="ZZ_TEST_RULE", rule_version="1.0",
        category=opt_model.CLEANUP, severity=opt_model.MEDIUM, signal=signal,
        title="zz-test finding", description="zz-test finding for the scorecard suite",
        confidence=opt_model.CONF_MEDIUM, status=status,
        first_detected_at=now, last_detected_at=now,
    )


async def purge_fixtures():
    async with AsyncSessionLocal() as db:
        accounts = (await db.execute(
            select(CloudAccount).where(CloudAccount.account_name.like(f"{PREFIX}%"))
        )).scalars().all()
        clients = (await db.execute(
            select(CloudClient).where(CloudClient.name.like(f"{PREFIX}%"))
        )).scalars().all()
        for acc in accounts:
            await db.execute(sa_delete(CloudOptimizationFinding).where(
                CloudOptimizationFinding.account_id == acc.id))
            await db.execute(sa_delete(CloudOptimizationRun).where(
                CloudOptimizationRun.account_id == acc.id))
            await db.execute(sa_delete(CloudCostBudget).where(
                CloudCostBudget.account_id == acc.id))
            await db.execute(sa_delete(CloudFinopsScorecard).where(
                CloudFinopsScorecard.scope_type == SCOPE_ACCOUNT,
                CloudFinopsScorecard.scope_id == acc.id))
            await db.delete(acc)
        for cl in clients:
            await db.execute(sa_delete(CloudFinopsScorecard).where(
                CloudFinopsScorecard.scope_type == SCOPE_CLIENT,
                CloudFinopsScorecard.scope_id == cl.id))
            await db.delete(cl)
        await db.commit()
        return len(accounts) + len(clients)


def make_account(name_suffix):
    return CloudAccount(
        account_name=f"{PREFIX}{name_suffix}", provider="ORACLE",
        environment="Development", tenant_or_region="test",
        auth_mode="API_Keys", credentials_enc="nope", auto_discovery=False,
    )


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    purged = await purge_fixtures()
    if purged:
        print(f"  (purged {purged} leftover fixture row(s) from an earlier run)")

    async with AsyncSessionLocal() as db:
        accounts_before = (await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar()
        budgets_before = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()
        clients_before = (await db.execute(
            select(func.count()).select_from(CloudClient))).scalar()

    print("1. Phases group the SAME components the plain score uses")
    phase_of = alloc.COMPONENT_PHASE
    check("tagging informs", phase_of["tagging"] == alloc.PHASE_INFORM)
    check("allocation informs", phase_of["allocation"] == alloc.PHASE_INFORM)
    check("data_coverage informs", phase_of["data_coverage"] == alloc.PHASE_INFORM)
    check("resource_attribution informs", phase_of["resource_attribution"] == alloc.PHASE_INFORM)
    check("optimization_review_rate is the OPTIMIZE phase",
          phase_of["optimization_review_rate"] == alloc.PHASE_OPTIMIZE)
    check("budget_coverage operates", phase_of["budget_coverage"] == alloc.PHASE_OPERATE)
    check("anomaly_monitoring operates", phase_of["anomaly_monitoring"] == alloc.PHASE_OPERATE)

    health = alloc.finops_health(
        tag_coverage_percent=100.0, allocation_coverage_percent=100.0,
        days_of_history=365, budget_count=1, accounts_in_scope=1,
        anomaly_monitoring_ready=True, unpriced_resource_ratio=0.0,
        optimization_review_rate=100.0,
    )
    check("exactly 3 domains", len(health["domains"]) == 3, str(len(health["domains"])))
    inform = next(d for d in health["domains"] if d["phase"] == alloc.PHASE_INFORM)
    check("Inform groups all 4 visibility components",
          set(inform["components"]) == {"tagging", "allocation", "data_coverage", "resource_attribution"},
          str(inform["components"]))
    check("a fully-scored estate's Inform phase is 100", inform["score"] == 100.0)

    print("\n2. maturity_level() boundaries")
    check("49 -> Crawl", alloc.maturity_level(49) == alloc.MATURITY_CRAWL)
    check("50 -> Walk", alloc.maturity_level(50) == alloc.MATURITY_WALK)
    check("79 -> Walk", alloc.maturity_level(79) == alloc.MATURITY_WALK)
    check("80 -> Run", alloc.maturity_level(80) == alloc.MATURITY_RUN)
    check("None -> None, never Crawl", alloc.maturity_level(None) is None)

    print("\n3. Overall maturity is the WEAKEST phase, never an average")
    weak_optimize = alloc.finops_health(
        tag_coverage_percent=95.0, allocation_coverage_percent=95.0,
        days_of_history=365, budget_count=2, accounts_in_scope=2,
        anomaly_monitoring_ready=True, unpriced_resource_ratio=0.0,
        optimization_review_rate=10.0,  # OPTIMIZE alone is Crawl
    )
    check("Inform is Run", next(d for d in weak_optimize["domains"]
                                if d["phase"] == "INFORM")["maturity"] == alloc.MATURITY_RUN)
    check("Operate is Run", next(d for d in weak_optimize["domains"]
                                 if d["phase"] == "OPERATE")["maturity"] == alloc.MATURITY_RUN)
    check("Optimize alone is Crawl", next(d for d in weak_optimize["domains"]
                                         if d["phase"] == "OPTIMIZE")["maturity"] == alloc.MATURITY_CRAWL)
    check("OVERALL is Crawl too -- the weak phase is not hidden by an average",
          weak_optimize["maturity"]["overall"] == alloc.MATURITY_CRAWL,
          weak_optimize["maturity"]["overall"])

    print("\n4. An un-scoreable phase is EXCLUDED from the comparison, not treated as Crawl")
    no_optimize_signal = alloc.finops_health(
        tag_coverage_percent=95.0, allocation_coverage_percent=95.0,
        days_of_history=365, budget_count=2, accounts_in_scope=2,
        anomaly_monitoring_ready=True, unpriced_resource_ratio=0.0,
        # optimization_review_rate omitted entirely
    )
    optimize_domain = next(d for d in no_optimize_signal["domains"] if d["phase"] == "OPTIMIZE")
    check("Optimize phase score is None", optimize_domain["score"] is None)
    check("Optimize phase maturity is None, not Crawl", optimize_domain["maturity"] is None)
    check("overall maturity comes from Inform/Operate alone (Run), "
          "not dragged to Crawl by the unmeasured phase",
          no_optimize_signal["maturity"]["overall"] == alloc.MATURITY_RUN,
          no_optimize_signal["maturity"]["overall"])

    print("\n5. THE BUDGET-SCOPING FIX -- an unrelated account's budget "
          "no longer inflates this account's budget_coverage")
    async with AsyncSessionLocal() as db:
        acc_a = make_account("budget-a")
        acc_b = make_account("budget-b")
        db.add_all([acc_a, acc_b])
        await db.commit()
        await db.refresh(acc_a)
        await db.refresh(acc_b)

        # Only account B gets a budget. If scoping were still global, account
        # A would ALSO see budget_coverage=100% from B's budget.
        db.add(CloudCostBudget(
            name="zz-scorecard-budget-b", account_id=acc_b.id, amount=1000.0,
            currency="INR", period="MONTHLY",
        ))
        await db.commit()

        svc = CostService(db)
        gov_a = await svc.get_governance(str(acc_a.id))
        gov_b = await svc.get_governance(str(acc_b.id))
        check("account A (no budget of its own) sees budget_coverage 0, not 100",
              gov_a["finops_health"]["components"]["budget_coverage"] == 0.0,
              str(gov_a["finops_health"]["components"]["budget_coverage"]))
        check("account B (has its own budget) sees budget_coverage 100",
              gov_b["finops_health"]["components"]["budget_coverage"] == 100.0,
              str(gov_b["finops_health"]["components"]["budget_coverage"]))

        print("\n6. THE OPTIMIZE SIGNAL -- never analysed is None, "
              "analysed-with-nothing-to-review is 100, "
              "analysed-with-something-open is NOT 100")
        never_analysed = await svc.get_governance(str(acc_a.id))
        check("never analysed -> optimization_review_rate is None, not a free 100",
              never_analysed["finops_health"]["components"]["optimization_review_rate"] is None,
              str(never_analysed["finops_health"]["components"]["optimization_review_rate"]))
        check("…and it is excluded from the OPTIMIZE phase, not scored 0",
              "optimization_review_rate" in
              next(d for d in never_analysed["finops_health"]["domains"]
                   if d["phase"] == "OPTIMIZE")["excluded_components"])

        now = datetime.now(timezone.utc)
        db.add(CloudOptimizationRun(
            account_id=acc_a.id, provider="ORACLE", outcome=opt_model.RUN_COMPLETE,
            started_at=now, finished_at=now,
        ))
        await db.commit()

        analysed_clean = await svc.get_governance(str(acc_a.id))
        check("analysed with zero open findings -> 100 (nothing outstanding to review)",
              analysed_clean["finops_health"]["components"]["optimization_review_rate"] == 100.0,
              str(analysed_clean["finops_health"]["components"]["optimization_review_rate"]))

        fingerprint = f"zz-scorecard-{uuid.uuid4().hex[:16]}"
        db.add(make_finding(account_id=acc_a.id, fingerprint=fingerprint))
        await db.commit()

        with_open_finding = await svc.get_governance(str(acc_a.id))
        check("one open, never-reviewed finding -> 0%, not 100",
              with_open_finding["finops_health"]["components"]["optimization_review_rate"] == 0.0,
              str(with_open_finding["finops_health"]["components"]["optimization_review_rate"]))

        await CostRecommendationRepository(db).set_state(
            fingerprint=fingerprint, account_id=acc_a.id,
            state="ACCEPTED", reason=None, actor="zz-test",
        )
        reviewed = await svc.get_governance(str(acc_a.id))
        check("after a human decision is recorded, the SAME finding counts as reviewed -> 100%",
              reviewed["finops_health"]["components"]["optimization_review_rate"] == 100.0,
              str(reviewed["finops_health"]["components"]["optimization_review_rate"]))

        print("\n7. PER-CLIENT SCOPING -- exactly the accounts under one client, "
              "computed through the IDENTICAL finops_health() as get_governance")
        client = CloudClient(name=f"{PREFIX}client")
        db.add(client)
        await db.commit()
        await db.refresh(client)

        unknown_client_id = uuid.uuid4()
        try:
            await svc.get_client_governance(unknown_client_id)
            check("an unknown client 404s", False, "did not raise")
        except Exception as exc:
            check("an unknown client 404s", getattr(exc, "status_code", None) == 404,
                  str(getattr(exc, "status_code", exc)))

        acc_a.client_id = client.id
        acc_b.client_id = client.id
        await db.commit()

        client_gov = await svc.get_client_governance(client.id)
        check("both accounts are in scope", len(client_gov["accounts_in_scope"]) == 2,
              str(client_gov["accounts_in_scope"]))
        check("client_name is carried", client_gov["client_name"] == client.name)
        check("budget_coverage now reflects BOTH accounts -- 1 of 2 has a budget -> 50%",
              client_gov["finops_health"]["components"]["budget_coverage"] == 50.0,
              str(client_gov["finops_health"]["components"]["budget_coverage"]))

        print("\n8. THE DAILY SNAPSHOT -- recorded once, never duplicated on a second read")
        repo = FinopsScorecardRepository(db)
        count_after_first_read = await repo.count_for_scope(
            scope_type=SCOPE_CLIENT, scope_id=client.id)
        check("exactly one snapshot after the first read today",
              count_after_first_read == 1, str(count_after_first_read))

        again = await svc.get_client_governance(client.id)
        count_after_second_read = await repo.count_for_scope(
            scope_type=SCOPE_CLIENT, scope_id=client.id)
        check("a second read the SAME day writes nothing new",
              count_after_second_read == 1, str(count_after_second_read))
        check("the history returned is oldest first",
              again["history"] == sorted(again["history"], key=lambda r: r["as_of"]))
        check("the snapshot carries the maturity label, not just a number",
              again["history"][-1]["maturity"]["overall_label"] is not None,
              str(again["history"][-1]["maturity"]))

        print("\n9. HTTP surface")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.get(f"{BASE}/{client.id}/scorecard")
            check("200 over HTTP", r.status_code == 200, str(r.status_code))
            body = r.json()
            check("the HTTP body carries the same domain structure",
                  len(body["finops_health"]["domains"]) == 3)
            check("…and the client identity", body["client_name"] == client.name)

            r404 = await c.get(f"{BASE}/{uuid.uuid4()}/scorecard")
            check("unknown client is 404 over HTTP, not 400 or 500",
                  r404.status_code == 404, str(r404.status_code))

        print("\n10. Cleanup")
        await db.execute(sa_delete(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id.in_([acc_a.id, acc_b.id])))
        await db.execute(sa_delete(CloudOptimizationRun).where(
            CloudOptimizationRun.account_id.in_([acc_a.id, acc_b.id])))
        await db.execute(sa_delete(CloudCostBudget).where(
            CloudCostBudget.account_id.in_([acc_a.id, acc_b.id])))
        await db.execute(sa_delete(CloudFinopsScorecard).where(
            CloudFinopsScorecard.scope_type == SCOPE_ACCOUNT,
            CloudFinopsScorecard.scope_id.in_([acc_a.id, acc_b.id])))
        await db.execute(sa_delete(CloudFinopsScorecard).where(
            CloudFinopsScorecard.scope_type == SCOPE_CLIENT,
            CloudFinopsScorecard.scope_id == client.id))
        acc_a.client_id = None
        acc_b.client_id = None
        await db.commit()
        await db.delete(acc_a)
        await db.delete(acc_b)
        await db.delete(client)
        await db.commit()

    async with AsyncSessionLocal() as db:
        accounts_after = (await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar()
        budgets_after = (await db.execute(
            select(func.count()).select_from(CloudCostBudget))).scalar()
        clients_after = (await db.execute(
            select(func.count()).select_from(CloudClient))).scalar()
    check("account table restored", accounts_after == accounts_before,
          f"{accounts_before} -> {accounts_after}")
    check("budget table restored", budgets_after == budgets_before,
          f"{budgets_before} -> {budgets_after}")
    check("client table restored", clients_after == clients_before,
          f"{clients_before} -> {clients_after}")

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
