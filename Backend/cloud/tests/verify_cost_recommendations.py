"""The recommendations engine: structure, confidence, priority, savings
honesty and lifecycle. Pure logic plus one DB round trip for the workflow.

Run: venv\\Scripts\\python.exe tests\\verify_cost_recommendations.py

The load-bearing sections are 4 and 5. Section 4 pins that savings in different
currencies are never summed and that an unpriceable opportunity is COUNTED but
never VALUED. Section 5 pins that the fingerprint survives re-derivation — if
it did not, a user's dismissal would silently stop applying the next time
discovery ran, and the same finding would nag forever.
"""
import asyncio
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.cost_recommendation import (  # noqa: E402
    CLOSED_STATES, SETTABLE_STATES, STATE_DISMISSED, STATE_NEW, WORKFLOW_STATES,
    CloudCostRecommendationDecision, recommendation_fingerprint,
)
from app.services import cost_recommendation_service as reco  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/cost"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


ACCOUNT = uuid.uuid4()


def opt(rule, *, savings=None, currency=None, severity="MEDIUM", effort="LOW",
        resource_id=None, basis=None):
    return {
        "id": str(uuid.uuid4()),
        "rule": rule,
        "description": f"{rule} description",
        "potential_savings": savings,
        "savings_currency": currency,
        "savings_basis": basis,
        "affected_resource": "res-1",
        "resource_id": resource_id or str(uuid.uuid4()),
        "severity": severity,
        "effort": effort,
        "sub_resources": [],
    }


PRICE_LIST = ("OCI public Price List API — PAY_AS_YOU_GO list price.")


async def main():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    print("1. Every emitted rule has metadata -- gaps are reported, not hidden")
    # The real rule names the engine emits, kept in sync by this assertion.
    real_rules = [
        "Terminate Stopped EC2 Instance", "Upgrade Legacy EC2 Generation",
        "Enable S3 Bucket Versioning", "Missing S3 Lifecycle Policies",
        "Convert DynamoDB to On-Demand Billing", "Review Lambda Memory Size",
        "Upgrade Deprecated Runtime", "Review Stopped RDS Database",
        "Disable Multi-AZ on Non-Prod RDS", "Review EKS Control Plane Utilization",
        "Stopped OCI Compute Instance", "Stopped Autonomous Database",
        "Enable Autonomous Database Auto-Scaling", "Idle OKE Cluster (No Node Pools)",
        "Idle OCI Load Balancer (No Backend Sets)",
        "Idle OCI API Gateway (No Deployments)", "Idle AKS Cluster (No Nodes)",
    ]
    missing = [r for r in real_rules if r not in reco.RULES]
    check("all 17 engine rules are described", not missing, str(missing))
    check("unclassified_rules() reports a genuinely new rule",
          reco.unclassified_rules([opt("Brand New Rule")]) == ["Brand New Rule"])
    check("...and reports nothing when all are known",
          reco.unclassified_rules([opt("Stopped OCI Compute Instance")]) == [])

    print("\n2. Enrichment adds the structured fields section 35 requires")
    rows = reco.enrich([opt("Stopped OCI Compute Instance", savings=2233.37,
                            currency="INR", severity="HIGH", basis=PRICE_LIST)],
                       account_id=ACCOUNT)
    r = rows[0]
    for field in ("recommendation_id", "title", "category", "confidence",
                  "risk", "effort", "actionability", "priority_score",
                  "last_verified", "state", "utilization"):
        check(f"has {field}", field in r)
    check("category is stopped-resources", r["category"] == reco.STOPPED_RESOURCES,
          r["category"])
    check("confidence HIGH (provider proves the state and the billing)",
          r["confidence"] == reco.HIGH, r["confidence"])
    check("state defaults to NEW when nobody has decided", r["state"] == STATE_NEW)
    check("original savings untouched", r["potential_savings"] == 2233.37)

    print("\n3. Actionability answers why / what / impact / risk / how")
    act = r["actionability"]
    for key in ("why", "action", "expected_impact", "risk", "how"):
        check(f"actionability.{key} present", bool(act.get(key)), str(act.get(key))[:40])
    check("risk names the irreversible part",
          "boot volume" in act["risk"].lower(), act["risk"][:60])

    print("\n4. UTILIZATION IS NEVER CLAIMED (41)")
    check("utilization.available is False", r["utilization"]["available"] is False)
    check("reason says it is state-based, not usage-based",
          "not on utilization metrics" in r["utilization"]["reason"])
    idle = reco.enrich([opt("Idle OCI Load Balancer (No Backend Sets)")],
                       account_id=ACCOUNT)[0]
    check("even an 'Idle' rule does not claim measured idleness",
          idle["utilization"]["available"] is False)

    print("\n5. SAVINGS HONESTY -- currencies never summed, unpriced never valued")
    mixed = reco.enrich([
        opt("Stopped OCI Compute Instance", savings=2233.37, currency="INR",
            basis=PRICE_LIST),
        opt("Stopped Autonomous Database", savings=5000.0, currency="INR",
            basis=PRICE_LIST),
        opt("Terminate Stopped EC2 Instance", savings=120.0, currency="USD",
            basis=PRICE_LIST),
        opt("Review Lambda Memory Size"),              # unpriceable
        opt("Enable Autonomous Database Auto-Scaling"),  # deliberately NA
    ], account_id=ACCOUNT)
    summary = reco.savings_summary(mixed)
    check("INR verified totalled within its own currency",
          abs(summary["verified_by_currency"]["INR"] - 7233.37) < 1e-6,
          str(summary["verified_by_currency"].get("INR")))
    check("USD kept separate",
          abs(summary["verified_by_currency"]["USD"] - 120.0) < 1e-6)
    check("no bucket holds the meaningless cross-currency sum",
          not any(abs(v - 7353.37) < 1e-6
                  for v in summary["verified_by_currency"].values()))
    check("unpriceable opportunities are COUNTED", summary["unquantified_count"] == 2,
          str(summary["unquantified_count"]))
    check("...and never given a value",
          "UNKNOWN" not in summary["verified_by_currency"])
    check("the note states the rule", "never summed across them" in summary["note"])

    print("\n6. A price-list basis is 'verified'; anything else is not")
    est = reco.savings_summary(reco.enrich(
        [opt("Stopped OCI Compute Instance", savings=10.0, currency="INR",
             basis="internal heuristic")], account_id=ACCOUNT))
    check("a non-price-list basis is NOT counted as verified",
          est["verified_by_currency"] == {}, str(est["verified_by_currency"]))
    check("it lands in estimated instead",
          est["estimated_by_currency"].get("INR") == 10.0,
          str(est["estimated_by_currency"]))

    print("\n7. Priority ranks value, not just severity")
    ranked = reco.enrich([
        # A CRITICAL finding worth nothing, high effort, high risk.
        opt("Upgrade Deprecated Runtime", severity="CRITICAL", effort="HIGH"),
        # A MEDIUM finding worth a lot, low effort.
        opt("Stopped Autonomous Database", savings=50000.0, currency="INR",
            severity="MEDIUM", effort="LOW", basis=PRICE_LIST),
    ], account_id=ACCOUNT)
    check("the valuable MEDIUM outranks the worthless CRITICAL",
          ranked[0]["title"] == "Stopped Autonomous Database", ranked[0]["title"])
    check("scores are bounded at 100", all(x["priority_score"] <= 100 for x in ranked),
          str([x["priority_score"] for x in ranked]))
    check("the formula is published, not hidden",
          "impact(0-40)" in ranked[0]["priority_formula"])

    print("\n8. Impact is ranked WITHIN a currency, not across")
    # A large INR figure must not crush a USD recommendation to minimum impact.
    cross = reco.enrich([
        opt("Stopped Autonomous Database", savings=5_000_000.0, currency="INR",
            basis=PRICE_LIST),
        opt("Terminate Stopped EC2 Instance", savings=500.0, currency="USD",
            basis=PRICE_LIST),
    ], account_id=ACCOUNT)
    usd = next(x for x in cross if x["savings_currency"] == "USD")
    check("the largest USD saving still scores full impact for its currency",
          usd["priority_score"] >= 60, str(usd["priority_score"]))

    print("\n9. An unpriced recommendation is 'unknown', not 'worthless'")
    solo = reco.enrich([opt("Review Lambda Memory Size")], account_id=ACCOUNT)[0]
    check("savings_priced False", solo["savings_priced"] is False)
    check("still scores above zero impact", solo["priority_score"] > 10,
          str(solo["priority_score"]))

    print("\n10. THE FINGERPRINT SURVIVES RE-DERIVATION")
    rid = str(uuid.uuid4())
    a = recommendation_fingerprint(account_id=ACCOUNT, rule="Stopped OCI Compute Instance",
                                   resource_id=rid)
    b = recommendation_fingerprint(account_id=ACCOUNT, rule="Stopped OCI Compute Instance",
                                   resource_id=rid)
    check("same inputs -> same fingerprint", a == b)
    check("a different resource -> different fingerprint",
          a != recommendation_fingerprint(account_id=ACCOUNT,
                                          rule="Stopped OCI Compute Instance",
                                          resource_id=str(uuid.uuid4())))
    check("a different rule -> different fingerprint",
          a != recommendation_fingerprint(account_id=ACCOUNT,
                                          rule="Stopped Autonomous Database",
                                          resource_id=rid))
    # The point of the whole design: re-pricing must NOT create a new identity.
    first = reco.enrich([opt("Stopped OCI Compute Instance", savings=100.0,
                             currency="INR", resource_id=rid, basis=PRICE_LIST)],
                        account_id=ACCOUNT)[0]
    repriced = reco.enrich([opt("Stopped OCI Compute Instance", savings=999.0,
                                currency="INR", resource_id=rid, severity="LOW",
                                basis=PRICE_LIST)], account_id=ACCOUNT)[0]
    check("a REPRICED recommendation keeps its identity",
          first["fingerprint"] == repriced["fingerprint"])
    check("...so a dismissal would still apply to it",
          first["recommendation_id"] == repriced["recommendation_id"])

    print("\n11. A decision joins back onto the derived recommendation")
    decided = reco.enrich(
        [opt("Stopped OCI Compute Instance", savings=100.0, currency="INR",
             resource_id=rid, basis=PRICE_LIST)],
        account_id=ACCOUNT,
        decisions={first["fingerprint"]: {"state": STATE_DISMISSED,
                                          "reason": "keeps a warm failover"}},
    )[0]
    check("state reflects the decision", decided["state"] == STATE_DISMISSED)
    check("the reason travels with it",
          decided["decision"]["reason"] == "keeps a warm failover")

    print("\n12. Dismissed and implemented savings leave the open total")
    with_closed = reco.enrich(
        [opt("Stopped OCI Compute Instance", savings=100.0, currency="INR",
             resource_id=rid, basis=PRICE_LIST),
         opt("Stopped Autonomous Database", savings=250.0, currency="INR",
             basis=PRICE_LIST)],
        account_id=ACCOUNT,
        decisions={first["fingerprint"]: {"state": STATE_DISMISSED}},
    )
    s = reco.savings_summary(with_closed)
    check("the dismissed 100 is excluded from verified savings",
          abs(s["verified_by_currency"]["INR"] - 250.0) < 1e-6,
          str(s["verified_by_currency"]))
    check("it is counted as closed", s["closed_count"] == 1)
    check("open count excludes it", s["open_count"] == 1)

    print("\n13. Category rollup for the savings-by-category chart")
    cats = reco.by_category(mixed)
    names = {c["category"] for c in cats}
    check("stopped resources present", reco.STOPPED_RESOURCES in names, str(names))
    check("each category keeps savings per currency",
          all(isinstance(c["savings_by_currency"], dict) for c in cats))
    stopped = next(c for c in cats if c["category"] == reco.STOPPED_RESOURCES)
    check("category totals stay within a currency",
          abs(stopped["savings_by_currency"]["INR"] - 7233.37) < 1e-6,
          str(stopped["savings_by_currency"]))

    print("\n14. Workflow vocabulary")
    check("NEW is not settable -- it is the absence of a decision",
          STATE_NEW not in SETTABLE_STATES)
    check("all six states exist", len(WORKFLOW_STATES) == 6, str(WORKFLOW_STATES))
    check("implemented and dismissed are the closed states",
          CLOSED_STATES == {"IMPLEMENTED", "DISMISSED"}, str(CLOSED_STATES))

    print("\n15. HTTP surface + permissions")
    async with AsyncSessionLocal() as db:
        acc = CloudAccount(
            account_name="zz-test-reco", provider="ORACLE",
            environment="Development", tenant_or_region="test",
            auth_mode="API_Keys", credentials_enc="nope", auto_discovery=False,
        )
        db.add(acc)
        await db.commit()
        await db.refresh(acc)
        account_id = acc.id

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        fp = recommendation_fingerprint(account_id=account_id, rule="test", resource_id="r1")

        r = await c.post(f"{BASE}/recommendations/{fp}/state",
                         json={"state": "NOT_A_STATE"})
        check("unknown state -> 400", r.status_code == 400, str(r.status_code))

        r = await c.post(f"{BASE}/recommendations/{fp}/state", json={"state": "NEW"})
        check("setting NEW -> 400 (it is not a decision)", r.status_code == 400,
              str(r.status_code))

        r = await c.post(f"{BASE}/recommendations/{fp}/state",
                         json={"state": "DISMISSED"})
        check("dismissing without a reason -> 400", r.status_code == 400,
              str(r.status_code))

        r = await c.post(f"{BASE}/recommendations/{fp}/state",
                         json={"state": "DISMISSED", "reason": "warm failover",
                               "account_id": str(account_id)})
        check("dismissing WITH a reason -> 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("previous state recorded as NEW", body["previous_state"] == STATE_NEW,
              str(body["previous_state"]))
        check("actor recorded", body["decided_by"] is not None)

        r = await c.post(f"{BASE}/recommendations/{fp}/state",
                         json={"state": "ACCEPTED", "account_id": str(account_id)})
        check("changing the decision -> 200", r.status_code == 200)
        check("previous state is now DISMISSED", r.json()["previous_state"] == STATE_DISMISSED,
              str(r.json()["previous_state"]))

        r = await c.get(f"{BASE}/recommendations/decisions/{account_id}")
        check("decision history readable", r.status_code == 200)
        check("exactly one current decision (not a row per change)",
              r.json()["count"] == 1, str(r.json()["count"]))

    print("\n16. Permission split")
    from app.api import rbac
    check("viewer cannot dismiss a recommendation",
          rbac.COST_MANAGE_RECOMMENDATIONS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("analyst cannot either",
          rbac.COST_MANAGE_RECOMMENDATIONS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
    check("administrator can",
          rbac.COST_MANAGE_RECOMMENDATIONS in rbac.ROLE_PERMISSIONS[rbac.ROLE_ADMIN])

    print("\n17. Cleanup")
    async with AsyncSessionLocal() as db:
        await db.execute(delete(CloudCostRecommendationDecision).where(
            CloudCostRecommendationDecision.account_id == account_id))
        target = await db.get(CloudAccount, account_id)
        if target:
            await db.delete(target)
        await db.commit()
        left = (await db.execute(select(CloudAccount).where(
            CloudAccount.account_name.like("zz-test-reco%")))).scalars().all()
    check("fixture removed", not left, str(len(left)))

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
