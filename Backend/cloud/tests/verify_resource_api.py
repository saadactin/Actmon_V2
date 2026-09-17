"""Resource HTTP endpoints: route ordering, the error envelope, RBAC, CSV.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one -- the same approach as the cost, security,
topology, drift and Event Log suites.

Section 1 is the reason this file leads with route ordering. `/{account_id}` is
a single-segment path that will match ANY literal not already claimed above it.
The identical shape in the cost routes swallowed `/cloud/cost/budgets` and
turned it into a 422 trying to parse "budgets" as a UUID. Every static resource
path is asserted here to still resolve to its own handler.

Run: venv\\Scripts\\python.exe tests\\verify_resource_api.py
"""
import asyncio
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

import httpx  # noqa: E402
from sqlalchemy import delete, func, select  # noqa: E402

from app.api import rbac  # noqa: E402
from app.core.database import AsyncSessionLocal, engine  # noqa: E402

engine.echo = False

from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402
from app.models.resource_cost import CloudResourceCost  # noqa: E402
from app.repository.resource_query_repo import MAX_PAGE_SIZE  # noqa: E402
from app.services import resource_normalizer as normalizer  # noqa: E402

ok, fail = [], []
BASE = "/api/v1/cloud/resources"
PREFIX = "zzapi-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def purge():
    async with AsyncSessionLocal() as db:
        ids = [r[0] for r in (await db.execute(
            select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%"))
        )).all()]
        if ids:
            await db.execute(delete(CloudResourceCost).where(
                CloudResourceCost.account_id.in_(ids)))
            await db.execute(delete(CloudResource).where(
                CloudResource.account_id.in_(ids)))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
            await db.commit()
        return len(ids)


async def seed():
    async with AsyncSessionLocal() as db:
        account = CloudAccount(
            id=uuid.uuid4(), provider="OCI", account_name=f"{PREFIX}oci",
            credentials_enc="x", tenant_or_region="ap-mumbai-1", environment="test",
        )
        db.add(account)
        await db.flush()
        for i in range(5):
            r = CloudResource(
                id=uuid.uuid4(), account_id=account.id,
                provider_resource_id=f"{PREFIX}r{i}",
                resource_type="ComputeInstance" if i < 3 else "BlockVolume",
                resource_name=f"{PREFIX}res-{i}",
                region_or_zone="ap-mumbai-1",
                status="RUNNING" if i < 3 else None,
                tags={"Environment": "prod"} if i == 0 else None,
            )
            for key, value in normalizer.normalized_values(r).items():
                setattr(r, key, value)
            db.add(r)
        await db.commit()
        return str(account.id)


async def main():
    leaked = await purge()
    if leaked:
        print(f"  (cleaned up {leaked} leaked fixture account(s))")

    async with AsyncSessionLocal() as db:
        before = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)

    account_id = await seed()
    transport = httpx.ASGITransport(app=app)

    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://t",
                                     timeout=60) as c:
            print("1. STATIC PATHS ARE NOT SWALLOWED BY /{account_id}")
            for path, why in [
                (f"{BASE}/query/{account_id}", "query"),
                (f"{BASE}/summary/{account_id}", "summary"),
                (f"{BASE}/facets/{account_id}", "facets"),
                (f"{BASE}/reference/{account_id}", "reference"),
                (f"{BASE}/export/{account_id}", "export"),
                (f"{BASE}/groups/{account_id}?group_by=provider", "groups"),
            ]:
                r = await c.get(path)
                check(f"/{why} resolves to its own handler", r.status_code == 200,
                      f"{r.status_code} {r.text[:120]}")

            r = await c.get(f"{BASE}/{account_id}")
            check("the legacy per-account list still works", r.status_code == 200)
            check("...and still returns a bare array, not an envelope",
                  isinstance(r.json(), list), type(r.json()).__name__)
            check("...with the fixture's rows", len(r.json()) == 5, str(len(r.json())))

            r = await c.get(f"{BASE}/")
            check("the legacy all-accounts list still works", r.status_code == 200)
            check("...and is still an array", isinstance(r.json(), list))

            print("\n2. The query envelope carries what the page needs")
            r = await c.get(f"{BASE}/query/{account_id}")
            body = r.json()
            for key in ("rows", "total", "page", "page_size", "page_count", "sort",
                        "dir", "scope", "summary", "facets", "capabilities",
                        "data_quality"):
                check(f"payload has {key}", key in body)
            check("total matches the fixture", body["total"] == 5, str(body["total"]))
            check("summary agrees with total",
                  body["summary"]["resource_count"] == body["total"])
            check("the default page size is applied", body["page_size"] == 50)

            print("\n3. ALL is a real scope, not a parse failure")
            r = await c.get(f"{BASE}/query/ALL?page_size=1")
            check("ALL resolves", r.status_code == 200, r.text[:120])
            check("...and is flagged global", r.json()["scope"]["is_global"] is True)
            check("...covering more than the fixture account",
                  r.json()["total"] >= 5)

            print("\n4. Refusals use the standard error envelope")
            r = await c.get(f"{BASE}/query/{account_id}?sort=nonsense")
            check("a bad sort is a 400, not a 500", r.status_code == 400,
                  str(r.status_code))
            err = r.json()["detail"]["error"]
            check("...category is validation", err["category"] == "validation")
            check("...it names the field", err["field"] == "sort")
            check("...lists what is allowed", "resource_name" in err["allowed"])
            check("...and says retrying will not help", err["retryable"] is False)

            r = await c.get(f"{BASE}/query/{uuid.uuid4()}")
            check("an unknown account is a 404", r.status_code == 404)
            check("...with category not_found",
                  r.json()["detail"]["error"]["category"] == "not_found")

            r = await c.get(f"{BASE}/query/not-a-uuid")
            check("a malformed scope is a 404, not a 500", r.status_code == 404,
                  str(r.status_code))

            r = await c.get(f"{BASE}/groups/{account_id}?group_by=passwords")
            check("an unknown group_by is refused", r.status_code == 400)

            print("\n5. Page size is capped at the API boundary")
            r = await c.get(f"{BASE}/query/{account_id}?page_size=999999")
            check("an absurd page size is clamped, not honoured",
                  r.json()["page_size"] == MAX_PAGE_SIZE, str(r.json()["page_size"]))
            r = await c.get(f"{BASE}/query/{account_id}?page_size=0")
            check("page_size=0 is rejected by validation", r.status_code == 422,
                  str(r.status_code))

            print("\n6. Filters reach the query")
            r = await c.get(f"{BASE}/query/{account_id}?type=ComputeInstance")
            check("a type filter narrows the total", r.json()["total"] == 3,
                  str(r.json()["total"]))
            r = await c.get(f"{BASE}/query/{account_id}?type=ComputeInstance&type=BlockVolume")
            check("repeated params union", r.json()["total"] == 5)
            r = await c.get(f"{BASE}/query/{account_id}?status=UNKNOWN")
            check("a normalized status filter works", r.json()["total"] == 2,
                  str(r.json()["total"]))
            r = await c.get(f"{BASE}/query/{account_id}?has_tags=false")
            check("untagged filter works", r.json()["total"] == 4,
                  str(r.json()["total"]))

            print("\n7. A row never presents a missing value as a good one")
            r = await c.get(f"{BASE}/query/{account_id}?status=UNKNOWN&page_size=1")
            row = r.json()["rows"][0]
            check("status is UNKNOWN", row["status"] == "UNKNOWN")
            check("...the provider's own value is null, not invented",
                  row["raw_status"] is None)
            check("...and a reason is given", bool(row["status_reason"]))
            check("cost is unavailable rather than 0",
                  row["cost"]["available"] is False and row["cost"]["amount"] is None)
            check("...with a reason", bool(row["cost"]["reason"]))
            check("raw_data is NOT in the list payload", "raw_data" not in row)

            print("\n8. Reference data is served, not hardcoded in the client")
            r = await c.get(f"{BASE}/reference/{account_id}")
            ref = r.json()
            for key in ("statuses", "categories", "risk_levels", "types",
                        "sort_fields", "group_fields", "max_page_size",
                        "capabilities", "freshness_levels"):
                check(f"reference has {key}", key in ref)
            check("the type registry is substantial", len(ref["types"]) > 80,
                  str(len(ref["types"])))
            check("statuses arrive in logical order, worst first",
                  [s["value"] for s in ref["statuses"]][:3] == ["FAILED", "DEGRADED", "RUNNING"],
                  str([s["value"] for s in ref["statuses"]][:3]))
            check("'Not assessed' is spelled out for the unknown risk level",
                  any(r_["label"] == "Not assessed" for r_ in ref["risk_levels"]))

            print("\n9. Export is a CSV file, filtered exactly as asked")
            r = await c.get(f"{BASE}/export/{account_id}?type=ComputeInstance")
            check("export returns 200", r.status_code == 200)
            check("...as text/csv", r.headers["content-type"].startswith("text/csv"))
            check("...as an attachment",
                  "attachment" in r.headers.get("content-disposition", ""))
            check("...declaring its row count", r.headers.get("x-resource-rows") == "3",
                  r.headers.get("x-resource-rows"))
            lines = [ln for ln in r.text.splitlines() if ln.strip()]
            preamble = [ln for ln in lines if ln.startswith("#")]
            check("the preamble survives CSV quoting", len(preamble) == 7,
                  str(len(preamble)))
            check("...and names the filter",
                  any("type=ComputeInstance" in ln for ln in preamble))
            data = [ln for ln in lines if not ln.startswith("#")]
            check("header plus exactly the filtered rows", len(data) == 4,
                  str(len(data)))

            print("\n10. Every route declares a permission")
            import app.api.routes.resources as routes

            undeclared = []
            for route in routes.router.routes:
                deps = getattr(route, "dependencies", []) or []
                endpoint = getattr(route, "endpoint", None)
                has_rbac = any("require" in repr(d) for d in deps)
                if not has_rbac and endpoint is not None:
                    import inspect

                    sig = inspect.signature(endpoint)
                    has_rbac = any(
                        "Principal" in str(p.annotation) for p in sig.parameters.values()
                    )
                if not has_rbac:
                    undeclared.append(getattr(route, "path", "?"))
            check("no resource route is left unauthorized", not undeclared,
                  str(undeclared))

            print("\n11. Export needs its own permission")
            check("export requires resources:export",
                  rbac.RESOURCE_EXPORT in rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST])
            check("a plain viewer can read the inventory",
                  rbac.RESOURCE_VIEW in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
            check("...but cannot export it",
                  rbac.RESOURCE_EXPORT not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
            check("...nor read the raw provider payload",
                  rbac.RESOURCE_VIEW_RAW not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
            check("...nor act on a resource",
                  rbac.RESOURCE_ACTION not in rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER])
            check("only an administrator may act",
                  rbac.RESOURCE_ACTION in rbac.ROLE_PERMISSIONS[rbac.ROLE_ADMIN])

            print("\n12. The summary endpoint answers without a row page")
            r = await c.get(f"{BASE}/summary/{account_id}")
            body = r.json()
            check("summary is present", "summary" in body)
            check("data quality is present", "data_quality" in body)
            check("...and no rows are shipped", "rows" not in body)

            print("\n13. Facets can be skipped when only rows are wanted")
            r = await c.get(f"{BASE}/query/{account_id}?include_facets=false")
            check("facets are omitted on request", "facets" not in r.json())
            r = await c.get(f"{BASE}/query/{account_id}?include_summary=false")
            check("summary is omitted on request", "summary" not in r.json())

    finally:
        removed = await purge()
        print(f"\n(removed {removed} fixture account(s))")

    async with AsyncSessionLocal() as db:
        after = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)
    check("the account list is left exactly as it was found", after == before,
          f"{before} -> {after}")
    await engine.dispose()


asyncio.run(main())

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
