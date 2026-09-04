"""Drift HTTP endpoints: status codes, response shape, filters, validation.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one.
"""
import asyncio
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

import httpx
from sqlalchemy import text

from app.core.database import engine
from app.main import app

# app.main turns SQL echo on; silence it after import so output stays readable.
logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

BASE = "/api/v1/cloud/drift"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def an_account():
    """Prefer an account that actually has change rows.

    Picking the first account by age would often land on one with an empty log,
    which silently skips every row-shape assertion — a suite that passes by
    having nothing to check is not a passing suite.
    """
    async with engine.begin() as c:
        # 1. An account with change rows exercises the most assertions.
        row = (await c.execute(text(
            "select account_id, count(*) n from cloud_resource_changes "
            "group by account_id order by n desc limit 1"
        ))).first()
        if row:
            return str(row[0])
        # 2. Failing that, one whose resources carry provider creation dates, so
        #    the /history sort and source-field checks still run for real.
        row = (await c.execute(text(
            "select account_id, count(*) n from cloud_resources "
            "where metadata ?| array['time_created','created_date','creation_date','create_date'] "
            "group by account_id order by n desc limit 1"
        ))).first()
        if row:
            return str(row[0])
        row = (await c.execute(text(
            "select id from cloud_accounts order by created_at limit 1"
        ))).first()
    return str(row[0]) if row else None


async def main():
    account_id = await an_account()
    if not account_id:
        print("! no cloud accounts on file — cannot exercise account-scoped endpoints")
        return 1
    print(f"account: {account_id}\n")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        # ── 1. summary ────────────────────────────────────────────────────────
        print("1. GET /drift/summary")
        r = await c.get(f"{BASE}/summary", params={"account_id": account_id, "days": 30})
        check("returns 200", r.status_code == 200, str(r.status_code))
        s = r.json()
        for key in ("window_days", "total_changes", "has_history", "by_change_type",
                    "by_severity", "by_impact", "by_resource_type", "by_day",
                    "top_resources", "newly_exposed", "scaled_up", "correlation"):
            check(f"summary has {key}", key in s)
        check("by_change_type covers all 3 states",
              set(s["by_change_type"]) == {"CREATED", "MODIFIED", "DELETED"}, str(list(s["by_change_type"])))
        check("by_impact covers all 6 pillars", len(s["by_impact"]) == 6, str(list(s["by_impact"])))
        check("by_severity covers all 4 levels", len(s["by_severity"]) == 4, str(list(s["by_severity"])))
        check("correlation reports changed/alerted counts",
              {"changed_resources", "with_active_alerts", "alerted_resources"} <= set(s["correlation"]),
              str(list(s["correlation"])))
        check("window is echoed back", s["window_days"] == 30)

        # ── 2. list ───────────────────────────────────────────────────────────
        print("\n2. GET /drift")
        r = await c.get(BASE, params={"account_id": account_id, "days": 30, "page_size": 5})
        check("returns 200", r.status_code == 200, str(r.status_code))
        body = r.json()
        check("paginated envelope", {"items", "total", "page", "page_size"} <= set(body), str(list(body)))
        check("page_size is honoured", len(body["items"]) <= 5, f"{len(body['items'])} items")
        if body["items"]:
            row = body["items"][0]
            for key in ("id", "provider_resource_id", "resource_type", "change_type",
                        "field_path", "old_value", "new_value", "impact", "severity",
                        "direction", "summary", "detected_at", "account_name", "provider"):
                check(f"row has {key}", key in row)
            check("impact is a list", isinstance(row["impact"], list), type(row["impact"]).__name__)
            check("change_type is a known value",
                  row["change_type"] in ("CREATED", "MODIFIED", "DELETED"), row["change_type"])
        else:
            print("  ! no changes on record for this account — row shape unverified")

        # ── 3. filters narrow, never widen ────────────────────────────────────
        print("\n3. filters")
        unfiltered = (await c.get(BASE, params={"account_id": account_id, "days": 30})).json()["total"]
        for name, params in [
            ("impact=security", {"impact": "security"}),
            ("impact=cost", {"impact": "cost"}),
            ("severity=CRITICAL", {"severity": "CRITICAL"}),
            ("change_type=MODIFIED", {"change_type": "MODIFIED"}),
            ("direction=MORE_OPEN", {"direction": "MORE_OPEN"}),
            ("search=nothingmatchesthis", {"search": "zzz-no-such-resource-zzz"}),
        ]:
            got = (await c.get(BASE, params={"account_id": account_id, "days": 30, **params})).json()["total"]
            check(f"{name} does not widen the result", got <= unfiltered, f"{got} <= {unfiltered}")
        nomatch = (await c.get(BASE, params={
            "account_id": account_id, "search": "zzz-no-such-resource-zzz"})).json()
        check("an impossible search returns empty, not everything",
              nomatch["total"] == 0 and nomatch["items"] == [], str(nomatch["total"]))

        # ── 4. bad input is rejected, not silently ignored ───────────────────
        print("\n4. validation")
        for name, params in [
            ("impact", {"impact": "bogus"}),
            ("severity", {"severity": "SEVERE"}),
            ("change_type", {"change_type": "UPDATED"}),
            ("direction", {"direction": "SIDEWAYS"}),
        ]:
            r = await c.get(BASE, params={"account_id": account_id, **params})
            check(f"invalid {name} -> 400", r.status_code == 400, str(r.status_code))
        r = await c.get(BASE, params={"account_id": account_id, "days": 9999})
        check("out-of-range days -> 422", r.status_code == 422, str(r.status_code))
        r = await c.get(BASE, params={"account_id": account_id, "page": 0})
        check("page 0 -> 422", r.status_code == 422, str(r.status_code))

        # ── 5. facets ─────────────────────────────────────────────────────────
        print("\n5. GET /drift/facets")
        r = await c.get(f"{BASE}/facets", params={"account_id": account_id})
        check("returns 200", r.status_code == 200, str(r.status_code))
        f = r.json()
        check("facets list resource types", isinstance(f.get("resource_types"), list))
        check("facets list the 6 pillars", len(f.get("impacts", [])) == 6, str(f.get("impacts")))

        # ── 5b. inventory history ─────────────────────────────────────────────
        # Reaches back before drift capture existed, using the provider's own
        # creation timestamps. Must never present first_seen as a creation date.
        print("\n5b. GET /drift/history")
        r = await c.get(f"{BASE}/history", params={"account_id": account_id, "page_size": 10})
        check("returns 200", r.status_code == 200, str(r.status_code))
        h = r.json()
        check("paginated envelope", {"items", "total", "page", "page_size"} <= set(h), str(list(h)))
        for key in ("coverage", "by_month", "sort"):
            check(f"history has {key}", key in h)
        cov = h.get("coverage", {})
        check("coverage counts add up",
              cov.get("with_provider_timestamp", 0) + cov.get("without_provider_timestamp", 0)
              == cov.get("total_resources", -1),
              str(cov))
        if h["items"]:
            row = h["items"][0]
            for key in ("resource_id", "resource_name", "resource_type", "region_or_zone",
                        "status", "created_at", "created_at_source", "first_seen", "provider"):
                check(f"history row has {key}", key in row)
            # The two dates must stay distinct fields. Collapsing them would
            # turn "we started scanning here" into "this was built that day".
            check("created_at and first_seen are separate fields",
                  "created_at" in row and "first_seen" in row and row["first_seen"] is not None)
            dated = [i for i in h["items"] if i["created_at"]]
            if dated:
                check("a dated row names the provider field it came from",
                      bool(dated[0]["created_at_source"]), str(dated[0]["created_at_source"]))
                # Default sort is newest-created first.
                stamps = [i["created_at"] for i in dated]
                check("dated rows are newest first", stamps == sorted(stamps, reverse=True),
                      f"{stamps[:3]}")
            else:
                print("  ! this account has no provider creation dates — sort unverified")
        check("by_month buckets carry both series",
              all({"month", "created", "first_seen"} <= set(m) for m in h["by_month"]),
              str(h["by_month"][:1]))

        r = await c.get(f"{BASE}/history", params={"account_id": account_id, "sort": "first_seen"})
        check("sort=first_seen accepted", r.status_code == 200 and r.json()["sort"] == "first_seen",
              str(r.status_code))
        r = await c.get(f"{BASE}/history", params={"account_id": account_id, "sort": "bogus"})
        check("invalid sort -> 400", r.status_code == 400, str(r.status_code))
        base_total = (await c.get(f"{BASE}/history", params={"account_id": account_id})).json()["total"]
        narrowed = (await c.get(f"{BASE}/history", params={
            "account_id": account_id, "search": "zzz-no-such-resource-zzz"})).json()
        check("an impossible search returns empty, not everything",
              narrowed["total"] == 0 and narrowed["items"] == [], str(narrowed["total"]))
        check("search does not widen the result", narrowed["total"] <= base_total)

        # ── 6. resource timeline ──────────────────────────────────────────────
        print("\n6. GET /drift/resource/{id}")
        r = await c.get(f"{BASE}/resource/{uuid.uuid4()}")
        check("unknown id -> 404", r.status_code == 404, str(r.status_code))
        r = await c.get(f"{BASE}/resource/not-a-uuid")
        check("malformed id -> 404, not 500", r.status_code == 404, str(r.status_code))

        async with engine.begin() as conn:
            row = (await conn.execute(text(
                "select id from cloud_resources where account_id = :a limit 1"
            ), {"a": uuid.UUID(account_id)})).first()
        if row:
            r = await c.get(f"{BASE}/resource/{row[0]}")
            check("real resource -> 200", r.status_code == 200, str(r.status_code))
            b = r.json()
            check("timeline has resource/changes/active_alerts",
                  {"resource", "changes", "active_alerts"} <= set(b), str(list(b)))
            check("resource block carries current state",
                  {"id", "resource_name", "resource_type", "status", "provider"} <= set(b["resource"]),
                  str(list(b["resource"])))
            check("changes is a list", isinstance(b["changes"], list))
            check("active_alerts is a list", isinstance(b["active_alerts"], list))
        else:
            print("  ! account has no resources — timeline shape unverified")

    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for x in fail:
            print(f"  FAILED: {x}")
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
