"""Server-side resource querying, against the real database.

Run: venv\\Scripts\\python.exe tests\\verify_resource_query.py

Creates its own accounts and resources, exercises them, removes them, and
asserts the account count is restored. It never asserts anything about the
user's real accounts, because those change.

The load-bearing sections:

  2  - pagination is STABLE. Without a tiebreaker, rows with equal sort keys
       swap between pages and the same resource appears twice, or never, in a
       full walk. That is silent and it corrupts exports.
  5  - unknown sorts last in BOTH directions. Postgres puts NULLs first on
       DESC, so "most expensive" would otherwise open with every resource
       whose cost nobody knows.
  6  - "no findings" and "never assessed" are different answers. Collapsing
       them renders a brand-new account as an estate with perfect posture.
  9  - every count reconciles with every other count, which is the whole
       reason the filtering moved to the server.
"""
import asyncio
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging
for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from sqlalchemy import delete, func, select

from app.core.database import AsyncSessionLocal, engine
engine.echo = False

from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.models.resource_cost import CloudResourceCost
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding
from app.repository.resource_query_repo import (
    MAX_PAGE_SIZE, QueryValidationError, ResourceQueryRepository, build_query,
)
from app.security.model import ASSESS_COMPLETE, OPEN, SUPPRESSED
from app.services import resource_model as rm
from app.services import resource_normalizer as normalizer
from app.services.resource_query_service import ResourceQueryService, ScopeError

ok, fail = [], []

# Every fixture row is prefixed so a crashed run leaves something findable, and
# so purge_fixtures cannot touch a real account.
PREFIX = "zzq-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def purge_fixtures(db):
    """Remove anything a previous crashed run left behind.

    A test that leaks an account into the user's real account list is worse
    than a test that fails.
    """
    rows = (await db.execute(
        select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%"))
    )).all()
    ids = [r[0] for r in rows]
    if ids:
        await db.execute(delete(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id.in_(ids)))
        await db.execute(delete(CloudSecurityAssessment).where(
            CloudSecurityAssessment.account_id.in_(ids)))
        await db.execute(delete(CloudResourceCost).where(
            CloudResourceCost.account_id.in_(ids)))
        await db.execute(delete(CloudResource).where(
            CloudResource.account_id.in_(ids)))
        await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.commit()
    return len(ids)


NOW = datetime.now(timezone.utc)


def res(account_id, name, rtype, region, status, **kw):
    r = CloudResource(
        id=uuid.uuid4(),
        account_id=account_id,
        provider_resource_id=kw.pop("pid", f"{PREFIX}{name}"),
        resource_type=rtype,
        resource_name=name,
        region_or_zone=region,
        status=status,
        ip_address=kw.pop("ip", None),
        config=kw.pop("config", None),
        metadata_=kw.pop("metadata_", None),
        tags=kw.pop("tags", None),
        discovered_at=kw.pop("discovered_at", NOW - timedelta(days=30)),
        updated_at=kw.pop("updated_at", NOW - timedelta(days=30)),
        last_seen_at=kw.pop("last_seen_at", NOW),
    )
    for key, value in normalizer.normalized_values(r).items():
        setattr(r, key, value)
    return r


async def main():
    async with AsyncSessionLocal() as db:
        leaked = await purge_fixtures(db)
        if leaked:
            print(f"  (cleaned up {leaked} leaked fixture account(s) from a prior run)")

        accounts_before = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)

        # ── Fixtures ──────────────────────────────────────────────────────────
        # Account A is assessed. Account B is NOT, which is the whole point of
        # section 6.
        acc_a = CloudAccount(
            id=uuid.uuid4(), provider="OCI", account_name=f"{PREFIX}assessed",
            credentials_enc="x", tenant_or_region="ap-mumbai-1", environment="test",
            last_discovery=NOW - timedelta(hours=1),
        )
        acc_b = CloudAccount(
            id=uuid.uuid4(), provider="AWS", account_name=f"{PREFIX}unassessed",
            credentials_enc="x", tenant_or_region="us-east-1", environment="test",
            last_discovery=NOW - timedelta(days=45),
        )
        db.add_all([acc_a, acc_b])
        await db.flush()

        db.add(CloudSecurityAssessment(
            id=uuid.uuid4(), account_id=acc_a.id, provider="OCI",
            outcome=ASSESS_COMPLETE, score=70, resources_evaluated=5,
            rules_evaluated=10, started_at=NOW - timedelta(hours=2),
        ))

        rows = [
            res(acc_a.id, "web-1", "ComputeInstance", "ap-mumbai-1", "RUNNING",
                tags={"Environment": "prod", "Owner": "platform"},
                ip="10.0.0.5", pid="ocid1.instance.oc1..web1"),
            res(acc_a.id, "web-2", "ComputeInstance", "ap-mumbai-1", "STOPPED",
                tags={"Environment": "prod"}),
            res(acc_a.id, "disk-orphan", "BlockVolume", "ap-mumbai-1", "AVAILABLE",
                config={"attachment_status": "Unattached"}),
            res(acc_a.id, "disk-attached", "BlockVolume", "ap-mumbai-1", "ATTACHED",
                config={"attachment_status": "Attached",
                        "attached_to_id": "ocid1.instance.oc1..web1",
                        "attached_to_name": "web-1",
                        "attached_to_status": "STOPPED"}),
            res(acc_a.id, "vcn-main", "VCN", "ap-mumbai-1", "ACTIVE"),
            res(acc_a.id, "no-state", "NoSQLTable", "ap-hyderabad-1", None),
            # Never observed, and its account was swept 1h ago -> the fallback
            # makes it FRESH, which section 8 pins.
            res(acc_a.id, "never-seen", "SecurityList", "ap-mumbai-1", "AVAILABLE",
                last_seen_at=None),
        ]
        # Account B is stale throughout: its last sweep was 45 days ago and
        # nothing in it has been observed since.
        stale_seen = NOW - timedelta(days=45)
        rows += [
            res(acc_b.id, "aws-role", "IAMRole", "global", None,
                last_seen_at=stale_seen),
            res(acc_b.id, "aws-bucket", "S3Bucket", "us-east-1", None,
                tags={"Team": "data"}, last_seen_at=stale_seen),
            res(acc_b.id, "aws-old", "EC2Instance", "us-east-1", "stopped",
                last_seen_at=stale_seen),
        ]
        db.add_all(rows)
        await db.flush()

        by_name = {r.resource_name: r for r in rows}

        # Costs: only three resources have one. The rest are genuinely unknown.
        db.add_all([
            CloudResourceCost(
                resource_id=by_name["web-1"].id, account_id=acc_a.id, provider="OCI",
                provider_resource_id=by_name["web-1"].provider_resource_id,
                amount=12400.0, currency="INR", period_days=30,
                billed_service="Compute", fetched_at=NOW,
            ),
            CloudResourceCost(
                resource_id=by_name["web-2"].id, account_id=acc_a.id, provider="OCI",
                provider_resource_id=by_name["web-2"].provider_resource_id,
                amount=310.5, currency="INR", period_days=30,
                billed_service="Compute", fetched_at=NOW,
            ),
            CloudResourceCost(
                resource_id=by_name["disk-attached"].id, account_id=acc_a.id,
                provider="OCI",
                provider_resource_id=by_name["disk-attached"].provider_resource_id,
                amount=None, currency="INR", period_days=30, fetched_at=NOW,
            ),
        ])

        def finding(resource, severity, status=OPEN, n=1):
            out = []
            for i in range(n):
                out.append(CloudSecurityFinding(
                    id=uuid.uuid4(), account_id=resource.account_id, provider="OCI",
                    fingerprint=f"{PREFIX}{resource.resource_name}-{severity}-{i}",
                    rule_id="test.rule", rule_version="1",
                    resource_id=resource.id, resource_name=resource.resource_name,
                    resource_type=resource.resource_type,
                    title="t", description="d", severity=severity,
                    category="Configuration", verdict="VULNERABLE",
                    confidence="HIGH", status=status,
                ))
            return out

        db.add_all(
            finding(by_name["web-1"], "CRITICAL")
            + finding(by_name["web-1"], "LOW", n=2)
            + finding(by_name["vcn-main"], "MEDIUM")
            # A suppressed finding is a decision someone made. It must not keep
            # colouring the row red.
            + finding(by_name["disk-orphan"], "CRITICAL", status=SUPPRESSED)
        )
        await db.commit()

        svc = ResourceQueryService(db)
        repo = ResourceQueryRepository(db)
        acc_a_id, acc_b_id = acc_a.id, acc_b.id
        A, B = str(acc_a_id), str(acc_b_id)
        target_id = by_name["web-1"].id
        target_pid = by_name["web-1"].provider_resource_id

        try:
            # ── 1 ────────────────────────────────────────────────────────────
            print("1. Scope resolution")
            r = await svc.query(A, page_size=50)
            check("account scope returns only its own rows", r["total"] == 7, str(r["total"]))
            check("it is not marked global", r["scope"]["is_global"] is False)

            accs, is_global = await svc.resolve_scope("ALL")
            check("ALL resolves to every account", len(accs) >= 2)
            check("...and is marked global", is_global is True)

            try:
                await svc.resolve_scope("not-a-uuid")
                check("a junk scope is refused", False)
            except ScopeError as exc:
                check("a junk scope is refused", True)
                check("...naming what it would accept", "ALL" in str(exc), str(exc))

            try:
                await svc.resolve_scope(str(uuid.uuid4()))
                check("an unknown account id is refused", False)
            except ScopeError:
                check("an unknown account id is refused", True)

            # ── 2 ────────────────────────────────────────────────────────────
            print("\n2. Pagination is stable across a full walk")
            seen, pages = [], 0
            page = 1
            while True:
                r = await svc.query(A, page=page, page_size=2,
                                    include_facets=False, include_summary=False)
                if not r["rows"]:
                    break
                seen.extend(x["id"] for x in r["rows"])
                pages += 1
                page += 1
                if page > 20:
                    break
            check("every row is returned exactly once", len(seen) == len(set(seen)) == 7,
                  f"{len(seen)} rows, {len(set(seen))} unique")
            check("page_count matches the walk", pages == 4, str(pages))

            r = await svc.query(A, page=1, page_size=2, include_facets=False)
            check("page_count is reported", r["page_count"] == 4, str(r["page_count"]))
            r = await svc.query(A, page=99, page_size=2, include_facets=False)
            check("a page past the end is empty, not an error", r["rows"] == [])
            check("...and still reports the true total", r["total"] == 7)

            # ── 3 ────────────────────────────────────────────────────────────
            print("\n3. Page size is clamped, not rejected")
            r = await svc.query(A, page_size=1_000_000, include_facets=False)
            check("an absurd page size is clamped", r["page_size"] == MAX_PAGE_SIZE,
                  str(r["page_size"]))
            check("...and the clamped value is echoed back so paging stays sane",
                  r["page_size"] <= MAX_PAGE_SIZE)

            # ── 4 ────────────────────────────────────────────────────────────
            print("\n4. Filters are validated, never guessed")
            for field, kwargs in [
                ("sort", {"sort": "cst"}),
                ("dir", {"dir": "sideways"}),
                ("status", {"status": "HEALTHY"}),
                ("risk", {"risk": "SCARY"}),
                ("category", {"category": "WIDGETS"}),
                ("attachment", {"attachment": "GLUED"}),
            ]:
                try:
                    build_query(**kwargs)
                    check(f"{field} rejects an unknown value", False)
                except QueryValidationError as exc:
                    check(f"{field} rejects an unknown value", True)
                    check(f"...{field} error names the allowed set", bool(exc.allowed))

            try:
                build_query(cost_min=500, cost_max=10)
                check("an inverted cost range is refused", False)
            except QueryValidationError:
                check("an inverted cost range is refused", True)

            q = build_query(type="A,B", region=["x", "y,z"])
            check("comma lists and repeats both parse", q.types == ("A", "B"))
            check("...and are de-duplicated and flattened",
                  q.regions == ("x", "y", "z"), str(q.regions))

            # ── 5 ────────────────────────────────────────────────────────────
            print("\n5. Unknown never sorts as good")
            r = await svc.query(A, sort="cost", dir="desc", page_size=50,
                                include_facets=False)
            amounts = [x["cost"]["amount"] for x in r["rows"]]
            check("cost desc starts with the most expensive", amounts[0] == 12400.0,
                  str(amounts[:3]))
            check("...and every unknown cost is at the END",
                  amounts.index(None) > amounts.index(310.5), str(amounts))

            r = await svc.query(A, sort="cost", dir="asc", page_size=50,
                                include_facets=False)
            amounts = [x["cost"]["amount"] for x in r["rows"]]
            check("cost asc starts with the cheapest KNOWN cost", amounts[0] == 310.5,
                  str(amounts[:3]))
            check("...and unknown is STILL last, not first",
                  amounts[-1] is None, str(amounts))

            r = await svc.query(A, sort="risk", page_size=50, include_facets=False)
            levels = [x["risk"]["level"] for x in r["rows"]]
            check("risk sorts CRITICAL first", levels[0] == "CRITICAL", str(levels))
            check("...MEDIUM before NONE",
                  levels.index("MEDIUM") < levels.index("NONE"), str(levels))

            r = await svc.query(A, sort="status", page_size=50, include_facets=False)
            statuses = [x["status"] for x in r["rows"]]
            check("status sorts logically: RUNNING before STOPPED",
                  statuses.index(rm.RUNNING) < statuses.index(rm.STOPPED), str(statuses))
            check("...and UNKNOWN last",
                  statuses[-1] == rm.UNKNOWN, str(statuses))

            # ── 6 ────────────────────────────────────────────────────────────
            print("\n6. 'No findings' and 'never assessed' are different answers")
            r = await svc.query(A, page_size=50, include_facets=False)
            by_id = {x["resource_name"]: x for x in r["rows"]}
            check("an assessed, clean resource is NONE",
                  by_id["web-2"]["risk"]["level"] == "NONE",
                  by_id["web-2"]["risk"]["level"])
            check("...and is marked assessed", by_id["web-2"]["risk"]["assessed"] is True)

            r = await svc.query(B, page_size=50, include_facets=False)
            by_id_b = {x["resource_name"]: x for x in r["rows"]}
            check("an UNASSESSED account's resources are UNKNOWN, not NONE",
                  by_id_b["aws-role"]["risk"]["level"] == "UNKNOWN",
                  by_id_b["aws-role"]["risk"]["level"])
            check("...marked not assessed", by_id_b["aws-role"]["risk"]["assessed"] is False)
            check("...and carrying the reason",
                  "not zero" in (by_id_b["aws-role"]["risk"]["reason"] or ""))

            r = await svc.query(B, risk="NONE", page_size=50, include_facets=False)
            check("filtering an unassessed account by risk=NONE matches nothing",
                  r["total"] == 0, str(r["total"]))
            r = await svc.query(B, risk="UNKNOWN", page_size=50, include_facets=False)
            check("...and risk=UNKNOWN matches all of it", r["total"] == 3, str(r["total"]))

            check("a SUPPRESSED finding does not keep the row red",
                  by_id["disk-orphan"]["risk"]["level"] == "NONE",
                  by_id["disk-orphan"]["risk"]["level"])
            check("...and is not counted",
                  by_id["disk-orphan"]["risk"]["finding_count"] == 0)

            check("severity counts are broken out",
                  by_id["web-1"]["risk"]["severity_counts"]["critical"] == 1
                  and by_id["web-1"]["risk"]["severity_counts"]["low"] == 2,
                  str(by_id["web-1"]["risk"]["severity_counts"]))

            # ── 7 ────────────────────────────────────────────────────────────
            print("\n7. Missing cost is NA with a reason, never zero")
            check("a known cost is reported", by_id["web-1"]["cost"]["available"] is True)
            check("...with its currency", by_id["web-1"]["cost"]["currency"] == "INR")
            check("...its window", by_id["web-1"]["cost"]["period_days"] == 30)
            check("...and its source", by_id["web-1"]["cost"]["source"] == "PROVIDER_BILLING")

            check("an unbilled resource is not available",
                  by_id["vcn-main"]["cost"]["available"] is False)
            check("...its amount is None, not 0",
                  by_id["vcn-main"]["cost"]["amount"] is None)
            check("...and it explains why", bool(by_id["vcn-main"]["cost"]["reason"]))

            check("a cost row with a NULL amount is still not available",
                  by_id["disk-attached"]["cost"]["available"] is False)
            check("...and reports None", by_id["disk-attached"]["cost"]["amount"] is None)

            check("an AWS resource's reason names Cost Explorer's limitation",
                  "Cost Explorer" in (by_id_b["aws-role"]["cost"]["reason"] or ""),
                  by_id_b["aws-role"]["cost"]["reason"] or "")
            check("...and names what would fix it",
                  "Cost and Usage Report" in (by_id_b["aws-role"]["cost"]["reason"] or ""))

            r = await svc.query(A, has_cost=True, page_size=50, include_facets=False)
            check("has_cost=true counts only KNOWN costs", r["total"] == 2, str(r["total"]))
            r = await svc.query(A, has_cost=False, page_size=50, include_facets=False)
            check("has_cost=false includes the NULL-amount row",
                  r["total"] == 5, str(r["total"]))
            r = await svc.query(A, cost_min=1000, page_size=50, include_facets=False)
            check("a cost floor excludes unknown costs rather than treating them as 0",
                  r["total"] == 1, str(r["total"]))

            # ── 8 ────────────────────────────────────────────────────────────
            print("\n8. Freshness falls back to the account, and says so")
            check("a row observed directly is sourced to the resource",
                  by_id["web-1"]["freshness"]["source"] == "resource")
            check("...with no caveat", by_id["web-1"]["freshness"]["note"] is None)
            check("a never-observed row borrows its account's last discovery",
                  by_id["never-seen"]["freshness"]["source"] == "account_discovery",
                  str(by_id["never-seen"]["freshness"]))
            check("...and says where the date came from",
                  "last successful discovery" in (by_id["never-seen"]["freshness"]["note"] or ""))
            check("...so it reads FRESH, not stale, when the sweep was an hour ago",
                  by_id["never-seen"]["freshness"]["stale"] is False)

            check("a row last seen 45 days ago is critically stale",
                  by_id_b["aws-old"]["freshness"]["severity"] == rm.CRITICALLY_STALE,
                  by_id_b["aws-old"]["freshness"]["severity"])

            r = await svc.query(B, stale=True, page_size=50, include_facets=False)
            check("stale=true finds the stale account's rows", r["total"] == 3, str(r["total"]))
            r = await svc.query(A, stale=True, page_size=50, include_facets=False)
            check("...and none of the fresh account's", r["total"] == 0, str(r["total"]))

            # ── 9 ────────────────────────────────────────────────────────────
            print("\n9. Every count reconciles with every other count")
            r = await svc.query(A, page_size=3)
            s = r["summary"]
            check("summary.resource_count == total",
                  s["resource_count"] == r["total"] == 7, str(s["resource_count"]))
            for dim in ("providers", "accounts", "statuses", "risk", "categories",
                        "types", "regions"):
                total = sum(f["count"] for f in r["facets"][dim])
                check(f"sum(facet {dim}) == total", total == r["total"], str(total))

            check("stopped_count is right", s["stopped_count"] == 1, str(s["stopped_count"]))
            check("unattached_count counts only attachable types",
                  s["unattached_count"] == 1, str(s["unattached_count"]))
            check("untagged_count is right", s["untagged_count"] == 5,
                  str(s["untagged_count"]))
            check("cost totals are per currency, never one merged number",
                  s["cost_by_currency"] == [
                      {"currency": "INR", "amount": 12710.5, "resource_count": 2}],
                  str(s["cost_by_currency"]))

            # Filtering must move the summary WITH the rows.
            r = await svc.query(A, type="ComputeInstance", page_size=50)
            check("a filtered summary matches the filtered total",
                  r["summary"]["resource_count"] == r["total"] == 2, str(r["total"]))

            # ── 10 ───────────────────────────────────────────────────────────
            print("\n10. A facet does not zero out its own dimension")
            r = await svc.query(A, type="ComputeInstance", page_size=50)
            types = {f["value"]: f["count"] for f in r["facets"]["types"]}
            check("the selected type still shows its count",
                  types.get("ComputeInstance") == 2, str(types))
            check("...and the OTHER types are still offered",
                  types.get("BlockVolume") == 2, str(types))
            statuses = {f["value"]: f["count"] for f in r["facets"]["statuses"]}
            check("a different dimension IS narrowed by the type filter",
                  sum(statuses.values()) == 2, str(statuses))

            # ── 11 ───────────────────────────────────────────────────────────
            print("\n11. Search reaches the fields people actually type")
            for term, expected, why in [
                ("web-", 2, "name fragment"),
                ("ocid1.instance.oc1..web1", 1, "exact provider id"),
                ("10.0.0.5", 1, "IP address"),
                ("BlockVolume", 2, "resource type"),
                ("ap-hyderabad", 1, "region"),
                ("platform", 1, "tag value"),
                ("ap-mumbai-1", 6, "region across types"),
            ]:
                r = await svc.query(A, q=term, page_size=50, include_facets=False)
                check(f"search by {why} ({term!r})", r["total"] == expected,
                      f"got {r['total']}, expected {expected}")

            r = await svc.query(A, q="w", page_size=50, include_facets=False)
            check("a one-character search is ignored rather than scanning everything",
                  r["total"] == 7, str(r["total"]))

            # ── 12 ───────────────────────────────────────────────────────────
            print("\n12. Grouping aggregates on the server")
            g = await svc.groups(A, "normalized_type")
            by_cat = {x["value"]: x for x in g["groups"]}
            check("compute is grouped", by_cat["COMPUTE"]["resource_count"] == 2)
            check("...with its own cost total",
                  by_cat["COMPUTE"]["cost_by_currency"] ==
                  [{"currency": "INR", "amount": 12710.5}],
                  str(by_cat["COMPUTE"]["cost_by_currency"]))
            check("...and its risky count", by_cat["COMPUTE"]["risky_count"] == 1)
            check("group counts sum to the total",
                  sum(x["resource_count"] for x in g["groups"]) == 7)
            check("a category with no cost reports an empty list, not 0",
                  by_cat["NETWORK"]["cost_by_currency"] == [])

            try:
                await svc.groups(A, "; DROP TABLE cloud_resources")
                check("group_by is allowlisted", False)
            except QueryValidationError:
                check("group_by is allowlisted", True)

            # ── 13 ───────────────────────────────────────────────────────────
            print("\n13. Export contains exactly the filtered set")
            body, meta = await svc.export_csv(A, type="ComputeInstance")
            lines = [ln for ln in body.splitlines() if ln and not ln.startswith("#")]
            data_lines = lines[1:]  # drop the header row
            check("the export has 2 data rows", len(data_lines) == 2, str(len(data_lines)))
            check("...matching the reported count", meta["rows"] == 2)
            check("the preamble names the filter", "type=ComputeInstance" in body)
            check("the preamble names the row count", "# Rows,2" in body)
            check("an unknown cost exports as BLANK, never 0",
                  ",0," not in data_lines[1] or "12400.0" in data_lines[0])

            body, _ = await svc.export_csv(B)
            check("an unassessed account exports risk as 'Not assessed'",
                  "Not assessed" in body)
            check("...not as a blank that reads like 'none'",
                  body.count("Not assessed") == 3, str(body.count("Not assessed")))

            body, meta = await svc.export_csv(A, page=1, page_size=1)
            lines = [ln for ln in body.splitlines() if ln and not ln.startswith("#")]
            check("export ignores the on-screen page and returns everything",
                  len(lines) - 1 == 7, str(len(lines) - 1))

            # ── 14 ───────────────────────────────────────────────────────────
            print("\n14. Data quality is computed, never assumed")
            q = await svc.summary(B)
            cov = q["data_quality"]["coverage"]
            check("status coverage counts only reported states",
                  cov["status"] == 33.3, str(cov["status"]))
            check("...and names how many are missing",
                  cov["without_status"] == 2, str(cov["without_status"]))
            check("cost coverage is 0.0 when the provider cannot answer",
                  cov["cost"] == 0.0, str(cov["cost"]))
            check("tag coverage is real", cov["tags"] == 33.3, str(cov["tags"]))

            empty = CloudAccount(
                id=uuid.uuid4(), provider="Azure", account_name=f"{PREFIX}empty",
                credentials_enc="x", tenant_or_region="eastus", environment="test",
            )
            db.add(empty)
            await db.commit()
            q = await svc.summary(str(empty.id))
            acc = q["data_quality"]["accounts"][0]
            check("an empty account reports None coverage, not 0%",
                  acc["status_coverage"] is None, str(acc["status_coverage"]))
            check("...and 'never scanned' rather than 'stale'",
                  acc["freshness"]["label"] == "Never scanned",
                  acc["freshness"]["label"])
            check("...with a note distinguishing it from 'scanned, found nothing'",
                  "never run" in (acc["freshness"]["note"] or ""))

            # ── 15 ───────────────────────────────────────────────────────────
            print("\n15. Capabilities travel with the payload")
            r = await svc.query(B, page_size=1, include_facets=False)
            shared = {c["key"]: c for c in r["capabilities"]["shared"]}
            check("AWS scope reports no per-resource cost",
                  shared["resource_cost"]["supported"] is False)
            check("...and names AWS as the blocker",
                  shared["resource_cost"]["blocked_by"][0]["provider"] == "AWS")
            check("no provider offers power actions",
                  shared["power_actions"]["supported"] is False)
            check("...because there is no action layer at all",
                  "action layer" in shared["power_actions"]["blocked_by"][0]["reason"])

            r = await svc.query("ALL", page_size=1, include_facets=False)
            shared = {c["key"]: c for c in r["capabilities"]["shared"]}
            check("a mixed scope intersects to the weakest provider",
                  shared["resource_cost"]["supported"] is False)

            # ── 16 ───────────────────────────────────────────────────────────
            print("\n16. mark_seen records observation without faking a change")
            before = (await db.execute(
                select(CloudResource.updated_at).where(CloudResource.id == target_id)
            )).scalar_one()
            stamp = NOW + timedelta(minutes=5)
            await normalizer.mark_seen(db, acc_a_id, [target_pid], now=stamp)
            await db.commit()
            row = (await db.execute(
                select(CloudResource.updated_at, CloudResource.last_seen_at)
                .where(CloudResource.id == target_id)
            )).one()
            check("last_seen_at moves", row.last_seen_at is not None
                  and abs((row.last_seen_at - stamp).total_seconds()) < 1)
            check("updated_at does NOT move", row.updated_at == before,
                  f"{before} -> {row.updated_at}")

            check("an empty id list is a no-op",
                  await normalizer.mark_seen(db, acc_a_id, []) == 0)

            # ── 17 ───────────────────────────────────────────────────────────
            print("\n17. Renormalization does not stamp resources as changed")
            before = (await db.execute(
                select(CloudResource.updated_at).where(CloudResource.id == target_id)
            )).scalar_one()
            await db.execute(
                CloudResource.__table__.update()
                .where(CloudResource.id == target_id)
                .values(normalized_status=None, updated_at=before)
            )
            await db.commit()
            # That UPDATE went around the ORM, so the identity map still holds
            # the old value. Production gets a fresh session per request; this
            # test has to drop the cached objects itself.
            db.expire_all()
            moved = await normalizer.renormalize_account(db, acc_a_id)
            await db.commit()
            row = (await db.execute(
                select(CloudResource.updated_at, CloudResource.normalized_status)
                .where(CloudResource.id == target_id)
            )).one()
            check("the projection is restored", row.normalized_status == rm.RUNNING,
                  str(row.normalized_status))
            check("...and it counted the row", moved == 1, str(moved))
            check("...WITHOUT touching updated_at", row.updated_at == before,
                  f"{before} -> {row.updated_at}")

            unchanged = await normalizer.renormalize_account(db, acc_a_id)
            check("a second pass is a no-op", unchanged == 0, str(unchanged))

            # The table this workspace replaces named the instance a volume is
            # attached to, and flagged when that instance was stopped. The
            # normalized row carries attachment_state, which answers "attached?"
            # but not "to what?" -- so without this the rebuild would quietly
            # drop a column that was doing real work.
            print("\n18. The attachment target survives the rebuild")
            page = await svc.query(str(acc_a_id), include_facets=False,
                                   include_summary=False, page_size=MAX_PAGE_SIZE)
            by_name = {r["resource_name"]: r for r in page["rows"]}
            attached = by_name["disk-attached"]
            orphan = by_name["disk-orphan"]
            vcn = by_name["vcn-main"]
            check("an attached volume names its target",
                  (attached["attached_to"] or {}).get("name") == "web-1",
                  str(attached["attached_to"]))
            check("...and carries the target's id for navigation",
                  (attached["attached_to"] or {}).get("id") == "ocid1.instance.oc1..web1")
            check("...and the target's own state, which is the cost question",
                  (attached["attached_to"] or {}).get("status") == "STOPPED")
            check("an unattached volume has no target, not an empty one",
                  orphan["attached_to"] is None, str(orphan["attached_to"]))
            check("...and is still UNATTACHED in its own right",
                  orphan["attachment_state"] == rm.UNATTACHED)
            check("a VCN is neither attached nor unattached",
                  vcn["attached_to"] is None and vcn["attachment_state"] is None)

        finally:
            await db.rollback()
            removed = await purge_fixtures(db)
            print(f"\n(removed {removed} fixture account(s))")

    # A fresh session for the final audit: the one above has just been through
    # a rollback and a purge, and reusing it here tangles the connection pool's
    # teardown with the assertion we actually care about.
    async with AsyncSessionLocal() as db:
        accounts_after = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)
    check("the account list is left exactly as it was found",
          accounts_after == accounts_before,
          f"{accounts_before} -> {accounts_after}")
    await engine.dispose()


asyncio.run(main())

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
