"""Topology HTTP endpoints: status codes, response shape, filters, RBAC, export.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one — the same approach as the Event Log and
drift API suites.

A throwaway account with a known fixture estate is created, so the shape
assertions actually run: a suite that passes because there was nothing to check
is not a passing suite. The fixture is removed at the end, and the real
resource count is measured before and after — an earlier test in this codebase
destroyed 154 live audit events by pruning against a fixture cutoff, and that
mistake is cheap to make and expensive to notice.
"""
import asyncio
import csv
import io
import json
import logging
import os
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import func, select, text  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402
from app.services.topology_service import invalidate_cache  # noqa: E402

BASE = "/api/v1/cloud/topology"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


# ── Fixture estate ───────────────────────────────────────────────────────────
# Shaped like a real small account: a VPC with a subnet, an instance in it
# guarded by a security group and running as a role that may reach a table, a
# volume attached to the instance, a balancer in front of it, one deliberately
# unconnected bucket, and one deliberately dangling subnet reference.

def resource(account_id, rtype, name, pid, config=None, metadata=None,
             status="running", ip=None):
    return CloudResource(
        id=uuid.uuid4(),
        account_id=account_id,
        provider_resource_id=pid,
        resource_type=rtype,
        resource_name=name,
        region_or_zone="ap-south-1",
        status=status,
        ip_address=ip,
        config=config or {},
        metadata_=metadata or {},
        cost_monthly=None,
        tags={"env": "test"},
        raw_data={"Id": pid, "Secret": "should-be-redacted", "Password": "hunter2"},
    )


def fixture_rows(account_id):
    return [
        resource(account_id, "VPC", "topo-vpc", "vpc-topo",
                 config={"cidr_block": "10.9.0.0/16"},
                 metadata={"dhcp_options_id": "dopt-topo"}),
        resource(account_id, "Subnet", "topo-subnet", "subnet-topo",
                 config={"vpc_id": "vpc-topo"}),
        resource(account_id, "SecurityGroup", "topo-sg", "sg-topo",
                 config={"vpc_id": "vpc-topo"}),
        resource(account_id, "IAMRole", "topo-role", "arn:aws:iam::9:role/topo-role",
                 config={"accessible_resources": [
                     {"resource": "arn:aws:dynamodb:ap-south-1:9:table/TopoTable",
                      "access": "write"}]}),
        resource(account_id, "DynamoDBTable", "TopoTable",
                 "arn:aws:dynamodb:ap-south-1:9:table/TopoTable"),
        resource(account_id, "EC2Instance", "topo-app-01", "i-topo", config={
            "vpc_id": "vpc-topo", "subnet_id": "subnet-topo",
            "security_group_ids": ["sg-topo"],
            "role_arn": "arn:aws:iam::9:role/topo-role",
            "private_ip": "10.9.1.7", "instance_type": "t3.medium",
            "db_password": "should-be-redacted",
        }, ip="10.9.1.7"),
        resource(account_id, "EBSVolume", "topo-vol", "vol-topo", config={
            "attachment_status": "Attached", "attached_to_id": "i-topo",
            "attached_to_status": "running", "size_gb": 100,
        }),
        resource(account_id, "LoadBalancer", "topo-lb", "arn:aws:elb:9:lb/topo-lb",
                 config={"backend_instance_ids": ["i-topo"]}),
        resource(account_id, "S3Bucket", "topo-lonely", "arn:aws:s3:::topo-lonely"),
        # Names a subnet that does not exist -> one unresolved reference.
        resource(account_id, "EC2Instance", "topo-orphan", "i-topo-orphan",
                 config={"subnet_id": "subnet-does-not-exist"}),
    ]


async def real_resource_count() -> int:
    async with AsyncSessionLocal() as db:
        return (await db.execute(
            select(func.count()).select_from(CloudResource)
        )).scalar_one()


async def main() -> int:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    before_total = await real_resource_count()

    account_id = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            id=account_id, account_name=f"__topoapi_{account_id.hex[:8]}",
            provider="AWS", environment="Test", tenant_or_region="ap-south-1",
            auth_mode="API_Keys", auto_discovery=False, credentials_enc="test-only",
        ))
        await db.commit()
        for row in fixture_rows(account_id):
            db.add(row)
        await db.commit()

    # The cache keys off the inventory's high-water marks, so it would notice
    # the new rows anyway. Dropped explicitly so the first request in this
    # suite is measuring a fresh build rather than someone else's.
    invalidate_cache()

    try:
        return await run_checks(account_id, before_total)
    finally:
        async with AsyncSessionLocal() as db:
            # The append-only trigger on cloud_events refuses a cascade delete
            # unless the caller declares itself the pruner for the transaction.
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(text("DELETE FROM cloud_topology_snapshots WHERE scope = :s"),
                             {"s": str(account_id)})
            await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                             {"a": str(account_id)})
            await db.commit()
        invalidate_cache()

        after_total = await real_resource_count()
        expected = before_total
        check("the fixture was removed and no real resource was touched",
              after_total == expected, f"before {before_total}, after {after_total}")
        await engine.dispose()


async def run_checks(account_id: uuid.UUID, before_total: int) -> int:
    aid = str(account_id)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                 timeout=120) as c:

        # ── 1. The graph ─────────────────────────────────────────────────────
        print("1. GET /topology/{scope}")
        r = await c.get(f"{BASE}/{aid}")
        eq("the graph returns 200", r.status_code, 200)
        body = r.json()
        eq("with the ten fixture resources", body["total_nodes"], 10)
        check("and relationships between them", body["total_edges"] >= 7, body["total_edges"])
        check("edge type counts are reported", bool(body["edge_type_counts"]))
        check("the previous payload's field names still exist",
              {"nodes", "edges", "total_nodes", "total_edges", "edge_type_counts",
               "isolated_nodes", "unresolved_references"} <= set(body))
        eq("two resources are unconnected", body["isolated_nodes"], 2)

        by_name = {n["name"]: n for n in body["nodes"]}
        node = by_name["topo-app-01"]
        check("a node carries its provider, category and health",
              node["provider"] == "AWS" and node["category"] == "Compute"
              and node["health"] == "Healthy",
              (node["provider"], node["category"], node["health"]))
        check("and its identity as the provider reported it",
              node["provider_id"] == "i-topo" and node["resource_id"] == "i-topo")
        check("and the counts a tooltip needs, without another request",
              all(k in node for k in ("connection_count", "drift_count", "event_count",
                                      "exposed")))
        check("the node does NOT carry its full configuration",
              "configuration" not in node and "raw_data" not in node)

        edge = next(e for e in body["edges"] if e["type"] == "security")
        check("every edge carries its evidence",
              edge["evidence"]["field"] and edge["evidence"]["confidence"]
              == "provider-confirmed",
              edge["evidence"])
        check("and its normalized semantic name", edge["semantic"] == "SECURITY")

        check("the relationship catalog ships with the graph",
              len(body["relationship_catalog"]) >= 10)
        check("as do the view modes", set(body["view_modes"]) >= {
            "infrastructure", "network", "security", "dataflow", "identity"})
        check("provenance says when the graph was built",
              bool(body["topology_generated_at"]))
        check("and how old the inventory behind it is",
              "stale" in body["inventory"] and "note" in body["inventory"])

        cov = body["coverage"]
        eq("coverage separates a missing target from an uncollected type",
           (cov["missing_target"], cov["unsupported_type"]), (1, 1))
        check("and disclaims being a security score",
              "not a security score" in cov["definition"])

        # ── 2. Scope resolution ──────────────────────────────────────────────
        print("\n2. scope")
        r = await c.get(f"{BASE}/ALL")
        eq("ALL returns 200", r.status_code, 200)
        check("and includes the fixture account's resources",
              any(n["account_id"] == aid for n in r.json()["nodes"]))

        r = await c.get(f"{BASE}/AWS")
        eq("a provider name is a valid scope", r.status_code, 200)
        check("and returns only that provider",
              {n["provider"] for n in r.json()["nodes"]} <= {"AWS"})

        r = await c.get(f"{BASE}/not-a-uuid")
        eq("an invalid scope returns 200 with an error body", r.status_code, 200)
        check("naming what a valid scope looks like",
              "ALL" in r.json().get("error", ""), r.json())

        # ── 3. Filters ───────────────────────────────────────────────────────
        print("\n3. filters")
        r = await c.get(f"{BASE}/{aid}", params={"category": "Compute"})
        eq("a category filter narrows the nodes", r.json()["total_nodes"], 2)
        eq("and reports how many are in the whole graph", r.json()["graph_nodes"], 10)

        r = await c.get(f"{BASE}/{aid}", params={"category": "Compute", "context_hops": 1})
        ctx = r.json()
        check("context hops restore the relationships around the matches",
              ctx["total_edges"] > 0, ctx["total_edges"])
        eq("the matched count stays the number that actually matched",
           ctx["matched_nodes"], 2)
        check("and context nodes are flagged as not matched",
              any(n.get("matched") is False for n in ctx["nodes"]))

        r = await c.get(f"{BASE}/{aid}", params={"resource_type": "EC2Instance"})
        eq("a resource type filter works", r.json()["total_nodes"], 2)

        r = await c.get(f"{BASE}/{aid}", params={"health": "Healthy"})
        check("a health filter returns only resources with a reported health",
              all(n["health"] == "Healthy" for n in r.json()["nodes"]))

        r = await c.get(f"{BASE}/{aid}", params={"search": "topo-app"})
        eq("search narrows to the matching resource", r.json()["total_nodes"], 1)

        r = await c.get(f"{BASE}/{aid}", params={"search": "10.9.1.7"})
        eq("search matches an IP address", r.json()["total_nodes"], 1)

        r = await c.get(f"{BASE}/{aid}", params={"hide_isolated": True})
        eq("hiding unconnected resources drops exactly those two",
           r.json()["total_nodes"], 8)

        r = await c.get(f"{BASE}/{aid}", params={"view": "security"})
        check("the security view keeps only security relationships",
              set(r.json()["edge_type_counts"]) <= {"security", "protects", "encrypted-by"},
              r.json()["edge_type_counts"])

        r = await c.get(f"{BASE}/{aid}", params={"node_limit": 3})
        eq("a node limit is honoured", r.json()["total_nodes"], 3)
        check("and the truncation is reported", r.json()["truncated"] is True)

        check("facets are computed from the graph, with counts",
              any(f["value"] == "Compute" for f in body["facets"]["category"]))

        # ── 4. Per-resource ──────────────────────────────────────────────────
        print("\n4. GET /topology/{scope}/resource/{id}")
        instance_id = by_name["topo-app-01"]["id"]
        r = await c.get(f"{BASE}/{aid}/resource/{instance_id}")
        eq("a resource lookup returns 200", r.status_code, 200)
        detail = r.json()
        check("it is found", detail["found"] is True)
        check("with its neighbourhood", len(detail["neighbors"]) >= 5)
        check("its inbound and outbound relationships",
              detail["inbound"] and detail["outbound"])
        check("its dependencies, split by reliance",
              "depends_on" in detail and "depended_on_by" in detail)
        check("and its configuration", detail["configuration"]["instance_type"] == "t3.medium")

        check("a credential-looking config value is redacted",
              detail["configuration"].get("db_password") == "[REDACTED]",
              detail["configuration"].get("db_password"))
        check("and the response says redaction happened", detail["redacted"] is True)
        check("the raw payload is not included unless asked for",
              "raw_data" not in detail)

        r = await c.get(f"{BASE}/{aid}/resource/{instance_id}",
                        params={"include_raw": True})
        raw = r.json().get("raw_data") or {}
        check("the raw payload is returned when asked for", bool(raw))
        check("with its secrets redacted too",
              raw.get("Secret") == "[REDACTED]" and raw.get("Password") == "[REDACTED]",
              {k: raw.get(k) for k in ("Secret", "Password")})

        r = await c.get(f"{BASE}/{aid}/resource/i-topo")
        check("a resource can also be addressed by its provider id",
              r.json().get("found") is True)

        orphan_id = by_name["topo-orphan"]["id"]
        r = await c.get(f"{BASE}/{aid}/resource/{orphan_id}")
        refs = r.json()["unresolved_references"]
        eq("a resource reports its own unresolved references", len(refs), 1)
        eq("naming the value the provider gave", refs[0]["value"], "subnet-does-not-exist")
        check("with an explanation of why it could not be resolved",
              bool(refs[0]["explanation"]))

        r = await c.get(f"{BASE}/{aid}/resource/{uuid.uuid4()}")
        eq("an unknown resource returns 200 with found=false", r.status_code, 200)
        eq("and says so", r.json()["found"], False)
        check("with a reason a person can act on", bool(r.json()["detail"]))

        r = await c.get(f"{BASE}/{aid}/resource/{instance_id}/neighbors",
                        params={"hops": 1})
        eq("the neighbours endpoint returns 200", r.status_code, 200)
        check("and is found", r.json()["found"] is True)

        # ── 5. Path ──────────────────────────────────────────────────────────
        print("\n5. GET /topology/{scope}/path")
        vpc_id = by_name["topo-vpc"]["id"]
        lonely_id = by_name["topo-lonely"]["id"]

        r = await c.get(f"{BASE}/{aid}/path",
                        params={"source": instance_id, "target": vpc_id})
        eq("a path request returns 200", r.status_code, 200)
        path = r.json()
        check("a confirmed path is found", path["found"] is True)
        # AWS reports both subnet_id and vpc_id on an instance, so there is a
        # direct edge and the shortest path is one hop. A shortest-path search
        # must return that rather than the scenic route through the subnet.
        eq("and it is the shortest one, not the scenic route", path["length"], 1)
        check("with each hop's relationship and direction",
              all({"relationship", "with_direction"} <= set(h) for h in path["hops"]))

        # The same pair, restricted to relationships that exclude the direct
        # edge, still connects through the subnet - so "no path" below is a
        # real absence and not an artefact of the restriction.
        subnet_route = await c.get(
            f"{BASE}/{aid}/path",
            params={"source": instance_id, "target": vpc_id, "max_depth": 3,
                    "relationship_types": "contains,network,attached"})
        check("the route through the subnet exists as well",
              subnet_route.json()["found"] is True)

        r = await c.get(f"{BASE}/{aid}/path",
                        params={"source": instance_id, "target": lonely_id})
        miss = r.json()
        eq("no path is invented to an unconnected resource", miss["found"], False)
        eq("the reason is stated", miss["reason"], "no_confirmed_path")
        check("and the wording refuses to guess",
              "inventing" in miss["detail"] or "not report" in miss["detail"],
              miss["detail"])

        r = await c.get(f"{BASE}/{aid}/path",
                        params={"source": instance_id, "target": vpc_id,
                                "relationship_types": "security"})
        eq("restricting the relationship kinds can remove the path",
           r.json()["found"], False)

        # ── 6. Impact ────────────────────────────────────────────────────────
        print("\n6. GET /topology/{scope}/impact/{id}")
        subnet_id = by_name["topo-subnet"]["id"]
        r = await c.get(f"{BASE}/{aid}/impact/{subnet_id}")
        eq("an impact request returns 200", r.status_code, 200)
        impact = r.json()
        check("the subnet has dependents", impact["total_affected"] >= 2,
              impact["total_affected"])
        check("removing it directly affects the instance in it",
              "topo-app-01" in {d["name"] for d in impact["direct_dependents"]})
        check("and indirectly the volume attached to that instance",
              "topo-vol" in {d["name"] for d in impact["indirect_dependents"]},
              [d["name"] for d in impact["indirect_dependents"]])
        check("a blast-radius level is given", impact["impact_level"] in
              {"NONE", "LOW", "MEDIUM", "HIGH"})
        check("with the thresholds that produced it", "NONE" in impact["impact_basis"])

        r = await c.get(f"{BASE}/{aid}/impact/{lonely_id}")
        eq("an unconnected resource has no blast radius",
           r.json()["total_affected"], 0)

        # ── 7. Edge explanation ──────────────────────────────────────────────
        print("\n7. GET /topology/{scope}/edge/{id}")
        edge_id = next(e["id"] for e in body["edges"] if e["type"] == "permission")
        r = await c.get(f"{BASE}/{aid}/edge/{edge_id}")
        eq("an edge lookup returns 200", r.status_code, 200)
        ex = r.json()
        check("it is found with both endpoints",
              ex["found"] and ex["source"] and ex["target"])
        check("the permission edge is flagged as not observed",
              ex["edge"]["observed"] is False)
        check("and its note says a permission is not an access",
              "NOT mean any access" in (ex["edge"]["evidence"]["note"] or ""))

        r = await c.get(f"{BASE}/{aid}/edge/{uuid.uuid4()}")
        eq("an unknown edge returns found=false", r.json()["found"], False)

        # ── 8. Coverage, unresolved, isolated, diagnostics ───────────────────
        print("\n8. coverage and diagnostics")
        r = await c.get(f"{BASE}/{aid}/coverage")
        eq("coverage returns 200", r.status_code, 200)
        check("with a data-coverage metric", r.json()["metric"] == "data_coverage")

        r = await c.get(f"{BASE}/{aid}/unresolved")
        eq("unresolved returns 200", r.status_code, 200)
        unres = r.json()
        eq("with the two references the fixture creates", unres["total"], 2)
        check("grouped by reason", bool(unres["by_reason"]))
        row = next(x for x in unres["references"] if x["value"] == "subnet-does-not-exist")
        check("each row names the resource, field, value and reason",
              all(row[k] for k in ("resource_name", "field", "value", "gap", "explanation")))
        eq("a missing instance of a collected type is classified as missing_target",
           row["reference_class"], "missing_target")

        r = await c.get(f"{BASE}/{aid}/isolated")
        eq("isolated returns 200", r.status_code, 200)
        iso = r.json()
        eq("with both unconnected resources", iso["total"], 2)
        reasons = {row["name"]: row["reason"] for row in iso["resources"]}
        eq("the bucket is unconnected because its type carries no relationship field",
           reasons.get("topo-lonely"), "no_relationship_fields")
        eq("the orphan is unconnected because its reference did not resolve",
           reasons.get("topo-orphan"), "references_unresolved")
        check("and every row carries an explanation, not just a reason",
              all(row["explanation"] for row in iso["resources"]))

        r = await c.get(f"{BASE}/{aid}/diagnostics")
        eq("diagnostics returns 200", r.status_code, 200)
        diag = r.json()
        check("it reports the accounts and their scan state",
              any(a["account_id"] == aid for a in diag["accounts"]))
        check("counts the active rules", diag["rules"]["active"] > 20)
        check("and documents the fields deliberately excluded",
              any(f["field"] == "config.image_id" for f in diag["rules"]["excluded_fields"]))

        # ── 9. Search ────────────────────────────────────────────────────────
        print("\n9. GET /topology/{scope}/search")
        r = await c.get(f"{BASE}/{aid}/search", params={"q": "topo"})
        eq("search returns 200", r.status_code, 200)
        found = r.json()
        eq("matching the whole fixture estate", found["total"], 10)
        check("grouped by provider", found["by_provider"][0]["provider"] == "AWS")

        r = await c.get(f"{BASE}/{aid}/search", params={"q": "arn:aws:s3:::topo-lonely"})
        eq("an exact identifier ranks first",
           r.json()["results"][0]["name"], "topo-lonely")

        r = await c.get(f"{BASE}/{aid}/search", params={"q": ""})
        eq("an empty query is rejected by validation", r.status_code, 422)

        # ── 10. Global view and relationship catalog ─────────────────────────
        print("\n10. literal routes")
        r = await c.get(f"{BASE}/global")
        eq("the global view returns 200", r.status_code, 200)
        check("it is not mistaken for an account scope",
              "providers" in r.json(), list(r.json())[:5])
        check("and lists the fixture account under AWS",
              any(a["account_id"] == aid
                  for p in r.json()["providers"] for a in p["accounts"]))

        r = await c.get(f"{BASE}/relationships")
        eq("the relationship catalog returns 200", r.status_code, 200)
        cat = r.json()
        check("every relationship has a meaning", all(x["meaning"] for x in cat["relationships"]))
        check("and the permission note is explicit",
              "never evidence" in cat["permission_note"])

        r = await c.get(f"{BASE}/access")
        eq("the access model returns 200", r.status_code, 200)
        check("reporting whether RBAC is enforced",
              "enforced" in r.json()["rbac"])

        # ── 11. Snapshots and diff ───────────────────────────────────────────
        print("\n11. snapshots")
        r = await c.post(f"{BASE}/{aid}/snapshot", params={"label": "__test baseline"})
        eq("a snapshot is created", r.status_code, 200)
        snap = r.json()
        eq("recording the node count", snap["node_count"], 10)
        snapshot_id = snap["id"]

        r = await c.get(f"{BASE}/snapshots", params={"scope": aid})
        eq("snapshots list returns 200", r.status_code, 200)
        check("and includes the new one",
              any(s["id"] == snapshot_id for s in r.json()["snapshots"]))

        r = await c.get(f"{BASE}/snapshots/{snapshot_id}/diff")
        eq("a diff against the live topology returns 200", r.status_code, 200)
        d = r.json()
        eq("and finds nothing changed", d["summary"], {
            "added_resources": 0, "removed_resources": 0,
            "added_relationships": 0, "removed_relationships": 0,
            "changed_relationships": 0,
        })
        check("stating that identity is the provider's, not ours",
              "provider resource id" in d["identity_note"])

        # Remove a resource and confirm the diff notices.
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "DELETE FROM cloud_resources WHERE account_id = :a "
                "AND provider_resource_id = 'arn:aws:s3:::topo-lonely'"
            ), {"a": aid})
            await db.commit()
        invalidate_cache()

        r = await c.get(f"{BASE}/snapshots/{snapshot_id}/diff")
        d2 = r.json()
        eq("after deleting a resource the diff reports one removal",
           d2["summary"]["removed_resources"], 1)
        eq("naming it", d2["removed_resources"][0]["name"], "topo-lonely")

        r = await c.delete(f"{BASE}/snapshots/{snapshot_id}")
        eq("a snapshot can be deleted", r.json()["deleted"], True)

        # ── 12. Export ───────────────────────────────────────────────────────
        print("\n12. export")
        r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "json"})
        eq("a JSON export returns 200", r.status_code, 200)
        check("as an attachment", "attachment" in r.headers.get("content-disposition", ""))
        payload = json.loads(r.text)
        check("carrying nodes, edges and metadata",
              {"nodes", "edges", "metadata", "generated_at"} <= set(payload))
        eq("with the confidence stated", payload["metadata"]["confidence"],
           "provider-confirmed")

        r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "csv"})
        eq("a CSV export returns 200", r.status_code, 200)
        rows = list(csv.reader(io.StringIO(r.text)))
        header = rows[0]
        check("with the relationship columns section 84 asks for",
              {"source_name", "target_name", "relationship", "provider",
               "evidence_field"} <= set(header), header)
        check("one row per relationship", len(rows) - 1 >= 7, len(rows) - 1)

        # An export must honour the filters that are on screen. An export that
        # silently widened back to everything would be the worst bug here.
        r = await c.get(f"{BASE}/{aid}/export",
                        params={"fmt": "json", "resource_type": "EC2Instance"})
        filtered = json.loads(r.text)
        eq("the export honours the filters it was given", len(filtered["nodes"]), 2)
        eq("and records them in the file", filtered["filters"]["resource_type"],
           "EC2Instance")

        # A resource with no relationship must still appear, or the export
        # would understate the inventory.
        r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "csv"})
        text_csv = r.text
        check("an unconnected resource still appears in the CSV",
              "no discovered relationship" in text_csv)

        # Formula injection: a name beginning with = is executed by Excel.
        async with AsyncSessionLocal() as db:
            db.add(resource(account_id, "S3Bucket", "=cmd|' /C calc'!A0",
                            "arn:aws:s3:::topo-formula"))
            await db.commit()
        invalidate_cache()
        r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "csv"})
        check("a formula-looking resource name is neutralised in the CSV",
              "'=cmd" in r.text and "\n=cmd" not in r.text)

        r = await c.get(f"{BASE}/not-a-uuid/export", params={"fmt": "json"})
        eq("exporting an invalid scope is a 400, not a file with an error in it",
           r.status_code, 400)

        r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "xml"})
        eq("an unsupported format is rejected by validation", r.status_code, 422)

        # ── 13. Validation ───────────────────────────────────────────────────
        print("\n13. validation")
        for params, label in [
            ({"hops": 0}, "hops below the minimum"),
            ({"hops": 99}, "hops above the maximum"),
        ]:
            r = await c.get(f"{BASE}/{aid}/resource/{instance_id}", params=params)
            eq(f"{label} is rejected", r.status_code, 422)

        r = await c.get(f"{BASE}/{aid}/path", params={"source": instance_id})
        eq("a path without a target is rejected", r.status_code, 422)

        r = await c.get(f"{BASE}/{aid}", params={"context_hops": 9})
        eq("context hops above the maximum are rejected", r.status_code, 422)

        # ── 14. Immutability ─────────────────────────────────────────────────
        print("\n14. the topology is derived, never written")
        for method in ("post", "put", "patch", "delete"):
            r = await c.request(method.upper(), f"{BASE}/{aid}", json={"nodes": []})
            check(f"{method.upper()} on the graph is not routed ({r.status_code})",
                  r.status_code in (404, 405), r.status_code)

        # ── 15. RBAC ─────────────────────────────────────────────────────────
        print("\n15. RBAC")
        r = await c.get(f"{BASE}/access")
        rbac = r.json()["rbac"]
        eq("enforcement is off by default on this deployment", rbac["enforced"], False)
        check("a viewer may view the topology",
              "topology:view" in rbac["roles"]["viewer"])
        check("but not the raw provider payload",
              "topology:view_raw" not in rbac["roles"]["viewer"])
        check("an analyst may read raw payloads and export",
              {"topology:view_raw", "topology:export"}
              <= set(rbac["roles"]["security_analyst"]))
        check("only an administrator or above may snapshot",
              "topology:snapshot" not in rbac["roles"]["security_analyst"]
              and "topology:snapshot" in rbac["roles"]["administrator"])

        os.environ["CLOUD_RBAC_ENFORCE"] = "true"
        try:
            r = await c.get(f"{BASE}/{aid}")
            eq("with enforcement on, an unauthenticated graph request -> 401",
               r.status_code, 401)

            # `create_access_token` takes a plain subject string and mints
            # no `role` claim, so the token is built directly here - the same
            # approach verify_event_api.py takes, for the same reason.
            from datetime import datetime as _dt, timedelta as _td, timezone as _tz

            import jwt as _jwt

            from app.core.config import settings as _settings

            def token_for(role):
                return _jwt.encode(
                    {"sub": f"{role}@example.com", "role": role,
                     "exp": _dt.now(_tz.utc) + _td(minutes=10)},
                    _settings.JWT_SECRET, algorithm=_settings.JWT_ALGORITHM,
                )

            r = await c.get(f"{BASE}/{aid}", headers={
                "Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer's token is accepted for the graph", r.status_code, 200)

            r = await c.get(f"{BASE}/{aid}/resource/{instance_id}",
                            params={"include_raw": True},
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer asking for the raw payload -> 403", r.status_code, 403)

            r = await c.get(f"{BASE}/{aid}/resource/{instance_id}",
                            params={"include_raw": True},
                            headers={"Authorization": f"Bearer {token_for('security_analyst')}"})
            eq("an analyst may read it", r.status_code, 200)

            r = await c.get(f"{BASE}/{aid}/export", params={"fmt": "json"},
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer may not export", r.status_code, 403)

            r = await c.post(f"{BASE}/{aid}/snapshot",
                             headers={"Authorization": f"Bearer {token_for('security_analyst')}"})
            eq("an analyst may not snapshot", r.status_code, 403)

            r = await c.post(f"{BASE}/{aid}/snapshot",
                             headers={"Authorization": f"Bearer {token_for('administrator')}"})
            eq("an administrator may", r.status_code, 200)
            if r.status_code == 200:
                await c.delete(f"{BASE}/snapshots/{r.json()['id']}", headers={
                    "Authorization": f"Bearer {token_for('administrator')}"})
        finally:
            os.environ.pop("CLOUD_RBAC_ENFORCE", None)
            os.environ["EVENTLOG_RBAC_ENFORCE"] = "false"

        r = await c.get(f"{BASE}/{aid}")
        eq("enforcement back off — anonymous access works again", r.status_code, 200)

        # ── 16. Caching ──────────────────────────────────────────────────────
        print("\n16. caching")
        first = (await c.get(f"{BASE}/{aid}")).json()
        second = (await c.get(f"{BASE}/{aid}")).json()
        eq("a repeat request is served from the cached graph",
           second["topology_generated_at"], first["topology_generated_at"])

        third = (await c.get(f"{BASE}/{aid}", params={"refresh": True})).json()
        check("refresh=true rebuilds it",
              third["topology_generated_at"] != first["topology_generated_at"])

        # A new resource changes the inventory's high-water mark, so the cache
        # must notice without anyone telling it to.
        async with AsyncSessionLocal() as db:
            db.add(resource(account_id, "S3Bucket", "topo-late", "arn:aws:s3:::topo-late"))
            await db.commit()
        fourth = (await c.get(f"{BASE}/{aid}")).json()
        check("a new resource invalidates the cache by itself",
              fourth["total_nodes"] > third["total_nodes"],
              f"{third['total_nodes']} -> {fourth['total_nodes']}")

    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        for name in fail:
            print(f"  ! {name}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
