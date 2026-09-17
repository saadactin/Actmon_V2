"""The Overview's acceptance criteria, against the real database and the real
frontend source.

Run: venv\\Scripts\\python.exe tests\\verify_overview.py

The Overview is an aggregation layer over seven subsystems, so its failure mode
is not "it crashes" — it is "it quietly disagrees with the page it links to".
That is what this suite is for.

The load-bearing sections:

  1  - the Overview's inventory number is the SAME number the Resources page
       serves, because both come from the one query layer. These disagreed
       before: the Overview counted a client-side filter of every resource in
       the estate.
  2  - there is exactly ONE security source. This is checked against the
       frontend source itself, not just the API, because the defect was a
       second engine being called from the dashboard: /cloud/security/{id}
       scored oci_test 0/F while the Security Center scored it 35/F.
  4  - the summary request stays small no matter how large the account is. The
       page this replaces downloaded 1.7 MB to render six numbers.
"""
import asyncio
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging
for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from sqlalchemy import func, select

from app.core.database import AsyncSessionLocal, engine
engine.echo = False

from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.services.resource_query_service import ResourceQueryService

ok, fail = [], []
FRONTEND = pathlib.Path(__file__).resolve().parents[3] / "frontend" / "src" / "features" / "cloud"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def read(*parts) -> str:
    path = FRONTEND.joinpath(*parts)
    return path.read_text(encoding="utf-8") if path.exists() else ""


async def main():
    async with AsyncSessionLocal() as db:
        accounts = list((await db.execute(select(CloudAccount))).scalars().all())
        if not accounts:
            print("No cloud accounts configured; nothing to verify.")
            return
        svc = ResourceQueryService(db)

        print("\n1. The Overview's inventory count IS the Resources count")
        for account in accounts:
            # What the Overview asks for: aggregates only, one row.
            overview = await svc.query(
                str(account.id), include_facets=True, include_summary=True, page_size=1
            )
            # What the Resources page reports as the account total.
            resources = await svc.query(
                str(account.id), include_facets=False, include_summary=False, page_size=1
            )
            # And the raw truth in the table.
            actual = int((await db.execute(
                select(func.count()).select_from(CloudResource)
                .where(CloudResource.account_id == account.id)
            )).scalar() or 0)

            name = account.account_name[:22]
            check(f"{name}: summary == table count",
                  overview["summary"]["resource_count"] == actual,
                  f"{overview['summary']['resource_count']} vs {actual}")
            check(f"{name}: summary == Resources total",
                  overview["summary"]["resource_count"] == resources["total"])

            print(f"\n   {name}: every facet reconciles with the total")
            total = overview["summary"]["resource_count"]
            for dimension in ("categories", "statuses", "regions"):
                rows = overview["facets"].get(dimension) or []
                # Regions are capped at the facet limit, so only assert the sum
                # when the dimension fits inside it.
                summed = sum(r["count"] for r in rows)
                if len(rows) < 40:
                    check(f"   {dimension} sum == total", summed == total,
                          f"{summed} vs {total}")

        print("\n2. There is exactly ONE security source in the Overview")
        overview_src = read("pages", "CloudOverview.jsx")
        dashboard_src = read("pages", "CloudDashboard.jsx")
        api_src = read("api", "overview.api.js")
        check("the Overview page exists", bool(overview_src))
        check("it does NOT call the legacy /cloud/security/{id} engine",
              "security.api" not in overview_src and "getSecurityPosture'" not in overview_src)
        check("the dashboard shell no longer calls it either",
              "getSecurityPosture" not in dashboard_src and "security.api" not in dashboard_src)
        check("the Overview's API layer reads security-center",
              "security-center" in api_src)
        check("...and reads it from nowhere else",
              len(re.findall(r"/security/\$\{", api_src)) == 0)
        # The second scoring IMPLEMENTATION, not merely the second data source.
        # Matched on a definition or a call rather than the bare identifier, so
        # the comment recording why the helper was deleted survives the check —
        # that comment is the reason the next person does not re-add it.
        derives_grade = re.compile(
            r"(?:const|function|let)\s+getSecurityGrade|getSecurityGrade\s*\("
        )
        check("no grade is derived in the dashboard",
              not derives_grade.search(dashboard_src),
              "a grade helper is defined or called")
        check("no grade is derived in the Overview",
              not derives_grade.search(overview_src))
        check("no score arithmetic in the Overview",
              "score >= 90" not in overview_src)

        print("\n3. The Overview does not download the estate")
        check("it never calls the unpaged resource list",
              "getAllResources" not in overview_src and "useAllResources" not in overview_src,
              "")
        check("the dashboard shell does not either",
              "useAllResources" not in dashboard_src)
        check("its inventory call asks for aggregates, not rows",
              "page_size: 1" in api_src)
        check("recent resources are ordered and limited server-side",
              "sort: 'discovered_at'" in api_src and "dir: 'desc'" in api_src)

        print("\n3b. Neither does any account-listing page")
        # These four render integers -- "AWS - 227 resources" -- and used to get
        # them by downloading all 1,530 resources in the estate and calling
        # .filter().length. The provider chooser is the FIRST page of the cloud
        # module, so that download happened before you had even picked a cloud.
        for page in (
            ("pages", "CloudProviderChooser.jsx"),
            ("pages", "CloudAccountsPage.jsx"),
            ("pages", "CloudProviderAccountsPage.jsx"),
            ("components", "CloudAccountList.jsx"),
        ):
            src = read(*page)
            check(f"{page[-1]} does not fetch the estate",
                  bool(src) and "useAllResources" not in src)
            check(f"{page[-1]} uses server-side counts",
                  "useAccountResourceCounts" in src)

        print("\n4. The summary payload stays small regardless of account size")
        biggest = max(accounts, key=lambda a: 0)  # replaced below
        counts = {}
        for account in accounts:
            counts[account.id] = int((await db.execute(
                select(func.count()).select_from(CloudResource)
                .where(CloudResource.account_id == account.id)
            )).scalar() or 0)
        biggest = max(accounts, key=lambda a: counts[a.id])
        payload = await svc.query(
            str(biggest.id), include_facets=True, include_summary=True, page_size=1
        )
        size = len(json.dumps(payload, default=str))
        check(f"{biggest.account_name[:20]} ({counts[biggest.id]} resources): one row returned",
              len(payload["rows"]) <= 1, str(len(payload["rows"])))
        # Generous bound: the point is that it is bounded by the number of
        # DISTINCT types/regions/statuses, not by the resource count.
        check("summary payload is under 64 KB", size < 64_000, f"{size} bytes")

        print("\n5. Absent stays absent")
        for account in accounts:
            payload = await svc.query(
                str(account.id), include_facets=False, include_summary=True, page_size=1
            )
            summary = payload["summary"]
            # An account with no priced resources must report no currency rows
            # rather than a zero total in an assumed currency.
            if summary["cost_resource_count"] == 0:
                check(f"{account.account_name[:20]}: no cost -> no currency total",
                      summary["cost_by_currency"] == [],
                      str(summary["cost_by_currency"]))
            quality = payload["data_quality"]["coverage"]
            if quality["resources"] == 0:
                check(f"{account.account_name[:20]}: empty account -> null coverage, not 0%",
                      quality["status"] is None, str(quality["status"]))

    await engine.dispose()


asyncio.run(main())

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
