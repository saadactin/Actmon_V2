"""Cost HTTP endpoints: the capability and quality surface, plus the RBAC that
now guards every cost route.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one -- the same approach as the security,
topology, drift and Event Log suites.

Throwaway accounts (one per provider) are created so the assertions actually
run against real scope resolution; they are removed at the end and the real
account count is measured before and after, because a fixture that leaks or
over-deletes is worse than no fixture.

No provider credentials are ever exercised: /capabilities and /quality read the
capability registry and the in-process cache only, and never issue a billing
call. That is itself a property worth pinning (section 3) -- a data-quality
badge that has to wait 50s on Azure is not a badge.

Run: venv\\Scripts\\python.exe tests\\verify_cost_api.py
"""
import asyncio
import logging
import os
import pathlib
import sys
import time
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.api import rbac  # noqa: E402
from app.core.database import AsyncSessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.services import cost_service  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/cost"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


FIXTURES = [
    ("zz-test-aws", "AWS"),
    ("zz-test-azure", "AZURE"),
    ("zz-test-oci", "ORACLE"),
]


async def create_accounts():
    created = []
    async with AsyncSessionLocal() as db:
        for name, provider in FIXTURES:
            acc = CloudAccount(
                account_name=name,
                provider=provider,
                environment="Development",
                tenant_or_region="test-region",
                auth_mode="API_Keys",
                # Never decrypted by the routes under test.
                credentials_enc="not-a-real-credential",
                auto_discovery=False,
            )
            db.add(acc)
            created.append(acc)
        await db.commit()
        for a in created:
            await db.refresh(a)
    return [(str(a.id), a.account_name, a.provider) for a in created]


async def delete_accounts(ids):
    async with AsyncSessionLocal() as db:
        for aid in ids:
            acc = await db.get(CloudAccount, uuid.UUID(aid))
            if acc is not None:
                await db.delete(acc)
        await db.commit()


async def count_accounts():
    async with AsyncSessionLocal() as db:
        return (await db.execute(select(func.count()).select_from(CloudAccount))).scalar()


async def main():
    before = await count_accounts()
    accounts = await create_accounts()
    ids = [a[0] for a in accounts]
    aws_id = next(i for i, n, p in accounts if p == "AWS")
    oci_id = next(i for i, n, p in accounts if p == "ORACLE")

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:

            print("1. /capabilities reports what each provider can really answer")
            r = await c.get(f"{BASE}/capabilities/{aws_id}")
            check("AWS capabilities 200", r.status_code == 200, str(r.status_code))
            body = r.json()
            check("AWS resource cost is NOT offered",
                  body["effective"]["resource"] is False)
            check("AWS service cost IS offered", body["effective"]["service"] is True)
            check("the blocker is named as AWS",
                  "AWS" in body["blocked_by"]["resource"], str(body["blocked_by"]["resource"].keys()))
            check("the reason names CUR",
                  "CUR" in body["blocked_by"]["resource"]["AWS"])
            check("per-provider detail present", "AWS" in body["per_provider"])
            check("max_lookback_days exposed",
                  body["per_provider"]["AWS"]["max_lookback_days"] == 365)

            print("\n2. OCI DOES offer resource cost -- no cross-provider leakage")
            r = await c.get(f"{BASE}/capabilities/{oci_id}")
            body = r.json()
            check("OCI resource cost offered", body["effective"]["resource"] is True)
            check("OCI reports the OCID as its native ID",
                  body["per_provider"]["OCI"]["native_resource_id"] == "OCID")
            check("no AWS entry leaked into an OCI-only scope",
                  "AWS" not in body["per_provider"], str(sorted(body["per_provider"])))
            check("nothing blocks resource in an OCI-only scope",
                  body["blocked_by"].get("resource") in (None, {}),
                  str(body["blocked_by"].get("resource")))

            print("\n3. /capabilities is instant -- it never calls a billing API")
            started = time.monotonic()
            r = await c.get(f"{BASE}/capabilities/ALL")
            elapsed = time.monotonic() - started
            check("ALL capabilities 200", r.status_code == 200, str(r.status_code))
            check("answered in well under a provider round trip", elapsed < 2.0,
                  f"{elapsed:.3f}s")

            print("\n4. An ALL scope only offers what EVERY provider can do")
            body = r.json()
            check("resource cost withdrawn once AWS is in scope",
                  body["effective"]["resource"] is False)
            check("service cost survives the intersection",
                  body["effective"]["service"] is True)
            check("daily_region withdrawn (AWS daily rows carry no region)",
                  body["effective"]["daily_region"] is False)
            check("AWS named as the blocker for daily_region",
                  "AWS" in body["blocked_by"]["daily_region"])

            print("\n5. /quality reports freshness per dataset, not one fused number")
            r = await c.get(f"{BASE}/quality/{oci_id}")
            check("quality 200", r.status_code == 200, str(r.status_code))
            q = r.json()
            check("has a page-level quality badge",
                  q["quality"] in ("good", "partial", "limited", "unavailable"), q["quality"])
            fresh = q["freshness"][oci_id]
            for dataset in ("billing", "daily_trend", "resource_cost", "inventory"):
                check(f"{dataset} has its own freshness entry", dataset in fresh)
            check("an unfetched dataset reports retrieved_at=None, not 'now'",
                  fresh["billing"]["retrieved_at"] is None,
                  str(fresh["billing"]["retrieved_at"]))
            check("unfetched is not reported as stale",
                  fresh["billing"]["stale"] is False)

            print("\n6. A never-fetched scope is not accused of being broken")
            check("no accounts failing", q["accounts_failing"] == 0, str(q["accounts_failing"]))
            check("no human action demanded", q["needs_human_action"] is False)
            check("errors list empty", q["errors"] == [])

            print("\n7. An AWS scope is LIMITED (capability gap), not FAILED")
            r = await c.get(f"{BASE}/quality/{aws_id}")
            q = r.json()
            check("quality == limited", q["quality"] == "limited", q["quality"])
            check("status is still complete -- nothing is broken",
                  q["status"] == "complete", q["status"])
            check("resource is listed as a limited dimension",
                  "resource" in q["limited_dimensions"], str(q["limited_dimensions"]))

            print("\n8. A recorded provider failure degrades quality and explains itself")
            # Simulate what _cached_fetch does when Azure throttles.
            azure_id = next(i for i, n, p in accounts if p == "AZURE")

            class FakeAcc:
                pass
            fa = FakeAcc()
            fa.id = uuid.UUID(azure_id)
            fa.provider = "AZURE"

            class Throttled(Exception):
                def __init__(self):
                    super().__init__("(429) Too many requests")
                    self.status_code = 429
            cost_service._record_error(fa, Throttled())

            r = await c.get(f"{BASE}/quality/{azure_id}")
            q = r.json()
            check("quality drops to unavailable (its only account failed)",
                  q["quality"] == "unavailable", q["quality"])
            check("the error is surfaced, not swallowed", len(q["errors"]) == 1,
                  str(len(q["errors"])))
            err = q["errors"][0]
            check("category is rate_limited, NOT unknown",
                  err["category"] == "rate_limited", err["category"])
            check("marked retryable", err["retryable"] is True)
            check("NOT flagged as needing human action",
                  q["needs_human_action"] is False)
            check("the failing account is named", err["account_name"] == "zz-test-azure")

            print("\n9. A permission failure names the exact permission to grant")
            class Denied(Exception):
                def __init__(self):
                    super().__init__("(AuthorizationFailed) no access")
                    self.status_code = 403
            cost_service._record_error(fa, Denied())
            r = await c.get(f"{BASE}/quality/{azure_id}")
            err = r.json()["errors"][0]
            check("category == permission", err["category"] == "permission", err["category"])
            check("required_permission is the real ARM action",
                  err["required_permission"] == "Microsoft.CostManagement/Query/read",
                  str(err.get("required_permission")))
            check("terminal -- waiting will not fix it", err["terminal"] is True)
            check("quality reports human action needed",
                  r.json()["needs_human_action"] is True)
            cost_service._cost_error_reason.pop(azure_id, None)

            print("\n10. Unknown / malformed account IDs are rejected cleanly")
            r = await c.get(f"{BASE}/capabilities/not-a-uuid")
            check("malformed id -> 400", r.status_code == 400, str(r.status_code))
            r = await c.get(f"{BASE}/quality/{uuid.uuid4()}")
            check("unknown account -> 404", r.status_code == 404, str(r.status_code))

            print("\n11. RBAC is declared on every cost route")
            r = await c.get(f"{BASE}/capabilities/{aws_id}")
            check("reachable while enforcement is off (service-wide posture)",
                  r.status_code == 200, str(r.status_code))

            os.environ["CLOUD_RBAC_ENFORCE"] = "true"
            try:
                for path in (f"{BASE}/capabilities/{aws_id}",
                             f"{BASE}/quality/{aws_id}",
                             f"{BASE}/analytics/{aws_id}",
                             f"{BASE}/report/{aws_id}",
                             f"{BASE}/{aws_id}"):
                    rr = await c.get(path)
                    check(f"{path.split('/cost')[1]} refuses an anonymous caller when enforced",
                          rr.status_code == 401, str(rr.status_code))
            finally:
                os.environ.pop("CLOUD_RBAC_ENFORCE", None)

            r = await c.get(f"{BASE}/capabilities/{aws_id}")
            check("reachable again once enforcement is off",
                  r.status_code == 200, str(r.status_code))

    finally:
        await delete_accounts(ids)

    print("\n12. The permission matrix separates reading from exporting")
    check("viewer can read cost", rbac.COST_VIEW in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("viewer CANNOT export the ledger",
          rbac.COST_EXPORT not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("viewer cannot manage budgets",
          rbac.COST_MANAGE_BUDGETS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
    check("analyst can export", rbac.COST_EXPORT in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
    check("analyst cannot manage budgets",
          rbac.COST_MANAGE_BUDGETS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
    check("analyst cannot dismiss recommendations",
          rbac.COST_MANAGE_RECOMMENDATIONS not in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
    check("administrator has the full cost set",
          {rbac.COST_VIEW, rbac.COST_EXPORT, rbac.COST_MANAGE_BUDGETS,
           rbac.COST_MANAGE_ALERTS, rbac.COST_MANAGE_RECOMMENDATIONS, rbac.COST_ADMIN}
          <= rbac.ROLE_PERMISSIONS[rbac.ROLE_ADMIN])
    check("cost permissions appear in the advertised RBAC summary",
          any(p.startswith("cost:") for p in rbac.rbac_summary()["roles"]["administrator"]))

    print("\n12b. The Cost tab's own refresh expires the cache without discarding it")
    from app.services import cost_service as cs

    aid, other = "zz-expire-a", "zz-expire-b"
    good = [{"service": "Compute", "cost": 10.0}]
    now = time.time()
    cs._real_cost_cache[aid] = (now, good, False, now)
    cs._real_cost_cache[other] = (now, good, False, now)
    cs._cost_report_cache[(aid, 30)] = (now, good, False, now)
    try:
        n = cs.expire_account_cost_cache(aid)
        check("expires the account's plain and (id, days)-keyed slots", n == 2, str(n))
        check("an expired slot is a cache miss", cs._cache_get(cs._real_cost_cache, aid) is None)
        check("another account's slot is untouched",
              cs._cache_get(cs._real_cost_cache, other) == good)
        check("the last-good time survives expiry",
              cs._real_cost_cache[aid][3] == now)

        async def _refuses():
            raise RuntimeError("403 AccessDenied")

        served = await cs._cached_fetch(cs._real_cost_cache, aid, "test", _refuses, [])
        check("a refused re-read after expiry serves the last good numbers, not NA",
              served == good, repr(served))
        check("…and marks them stale", cs._real_cost_cache[aid][2] is True)

        fresh = [{"service": "Compute", "cost": 12.5}]

        async def _answers():
            return fresh

        cs.expire_account_cost_cache(aid)
        served = await cs._cached_fetch(cs._real_cost_cache, aid, "test", _answers, [])
        check("a successful re-read after expiry replaces the value", served == fresh)
        check("expiring an account with nothing cached is a no-op",
              cs.expire_account_cost_cache("zz-never-cached") == 0)
    finally:
        cs._real_cost_cache.pop(aid, None)
        cs._real_cost_cache.pop(other, None)
        cs._cost_report_cache.pop((aid, 30), None)
        cs._cost_error_reason.pop(aid, None)

    from app.api.routes import cost as cost_routes
    route = next((r for r in cost_routes.router.routes
                  if r.path == "/cloud/cost/refresh/{account_id}"), None)
    check("POST /cost/refresh/{account_id} is registered",
          route is not None and "POST" in route.methods)

    print("\n13. The fixture left no residue")
    after = await count_accounts()
    check("account count restored exactly", after == before, f"{before} -> {after}")

    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
