"""Event Log HTTP endpoints: status codes, response shape, validation, RBAC.

Driven through the ASGI app rather than a bound port, so it needs no running
service and cannot collide with one. Same approach as verify_drift_api.py.

A throwaway account with known fixture events is created so the shape
assertions actually run — a suite that passes because there was nothing to
check is not a passing suite.
"""
import asyncio
import json
import logging
import os
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.events.adapters.base import CollectedEvent  # noqa: E402
from app.events.schema import ensure_append_only  # noqa: E402
from app.main import app  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.repository.event_repo import EventRepository  # noqa: E402

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

BASE = "/api/v1/cloud/events"
ok, fail = [], []
NOW = datetime.now(timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def event(**kwargs) -> CollectedEvent:
    defaults = dict(
        provider="AWS",
        provider_event_id=f"api-{uuid.uuid4()}",
        timestamp=NOW - timedelta(minutes=5),
        event_name="AuthorizeSecurityGroupIngress",
        event_source="ec2.amazonaws.com",
        api_operation="ec2.amazonaws.com:AuthorizeSecurityGroupIngress",
        event_category="Network",
        action="Authorize",
        status="Success",
        risk_level="CRITICAL",
        risk_reason="A network rule was written with an all-addresses source.",
        actor_name="saad@example.com",
        actor_email="saad@example.com",
        actor_type="Human",
        actor_role="arn:aws:iam::123456789012:role/SecurityAdministrator",
        actor_auth_method="MFA",
        actor_chain=[{"step": "AssumedRole", "name": "SecurityAdministrator"}],
        account_ref="123456789012",
        region="ap-south-1",
        resource_id="sg-123456789",
        resource_name="Production-Web-SG",
        resource_type="SecurityGroup",
        source_ip="10.20.30.40",
        user_agent="signin.amazonaws.com",
        access_method="Console",
        request_id="9c8d7-req",
        correlation_id="corr-api-1",
        read_only=False,
        provider_metadata={"request_parameters": {"cidrIp": "0.0.0.0/0"}},
        raw_event={"eventName": "AuthorizeSecurityGroupIngress", "eventVersion": "1.09"},
    )
    defaults.update(kwargs)
    return CollectedEvent(**defaults)


async def main() -> int:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await ensure_append_only(conn)

    account_id = uuid.uuid4()
    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            id=account_id, account_name=f"__eventapi_{account_id.hex[:8]}",
            provider="AWS", environment="Test", tenant_or_region="ap-south-1",
            auth_mode="API_Keys", auto_discovery=False, credentials_enc="test-only",
        ))
        await db.commit()

        repo = EventRepository(db)
        await repo.insert_events(account_id, [
            event(provider_event_id="api-critical"),
            event(provider_event_id="api-denied", status="Denied", risk_level="HIGH",
                  error_code="AccessDenied",
                  error_message="User is not authorized to perform this action.",
                  event_name="DeleteBucket", action="Delete",
                  event_category="Storage", timestamp=NOW - timedelta(minutes=4)),
            event(provider_event_id="api-read", status="Success", risk_level="INFO",
                  action="Read", read_only=True, event_name="DescribeInstances",
                  event_category="Compute", timestamp=NOW - timedelta(minutes=3)),
            event(provider_event_id="api-azure", provider="Azure",
                  event_name="securityRules/write", action="Update",
                  actor_type="ServicePrincipal", actor_name="deploy-sp",
                  actor_email=None, region=None, subscription_id="sub-1111",
                  resource_group="prod-rg", risk_level="HIGH",
                  timestamp=NOW - timedelta(minutes=2)),
            event(provider_event_id="api-oci", provider="OCI",
                  event_name="UpdateSecurityList", action="Update",
                  compartment_name="production", region="ap-mumbai-1",
                  risk_level="HIGH",
                  change_before={"source": "0.0.0.0/0"},
                  change_after={"source": "10.10.0.0/16"},
                  changed_fields=["source"],
                  timestamp=NOW - timedelta(minutes=1)),
        ])
        await db.commit()

    try:
        return await run_checks(account_id)
    finally:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(text("DELETE FROM cloud_accounts WHERE id = :a"),
                             {"a": str(account_id)})
            await db.execute(
                text("DELETE FROM cloud_event_saved_queries WHERE name LIKE '__test%'")
            )
            await db.commit()
        await engine.dispose()


async def run_checks(account_id: uuid.UUID) -> int:
    aid = str(account_id)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                 timeout=60) as c:

        # ── 1. List ──────────────────────────────────────────────────────────
        print("1. GET /events")
        r = await c.get(BASE, params={"account_id": aid, "range": "1h"})
        eq("returns 200", r.status_code, 200)
        body = r.json()
        for key in ("items", "total", "page", "page_size", "pages", "sort",
                    "window", "sources", "access"):
            check(f"response carries `{key}`", key in body)
        eq("all five fixtures are in the window", body["total"], 5)
        eq("newest first", body["items"][0]["provider_event_id"], "api-oci")

        row = body["items"][0]
        for key in ("timestamp", "provider", "actor_name", "action", "resource_name",
                    "resource_type", "account_ref", "region", "status", "risk_level",
                    "source_ip", "access_method", "id", "event_name"):
            check(f"row carries the `{key}` column the table needs", key in row)
        check("a list row does NOT ship the raw payload", "raw_event" not in row)
        check("nor the provider metadata", "provider_metadata" not in row)

        # The window is stated explicitly, in UTC, on every response.
        window = body["window"]
        eq("window is labelled UTC", window["timezone"], "UTC")
        check("window start is an ISO instant with an offset",
              "T" in window["start_utc"] and (
                  "+" in window["start_utc"] or window["start_utc"].endswith("Z")))
        eq("window range echoed back", window["range"], "1h")

        # Source health travels with the data.
        check("sources reports per-provider health",
              isinstance(body["sources"].get("providers"), list))
        check("and a single degraded flag", "degraded" in body["sources"])

        # ── 2. Filtering ─────────────────────────────────────────────────────
        print("\n2. filtering")
        cases = [
            ({"provider": "AWS"}, 3, "provider"),
            ({"provider": "Azure"}, 1, "provider=Azure"),
            ({"status": "Denied"}, 1, "status"),
            ({"action": "Delete"}, 1, "action"),
            ({"event_category": "Network"}, 3, "category"),
            ({"risk_level": "CRITICAL"}, 1, "exact risk"),
            ({"min_risk": "HIGH"}, 4, "min_risk >= HIGH"),
            ({"actor_type": "ServicePrincipal"}, 1, "actor type"),
            ({"exclude_read_only": "true"}, 4, "exclude read-only"),
            ({"resource_type": "SecurityGroup"}, 5, "resource type"),
            ({"region": "ap-south-1"}, 3, "region"),
            ({"search": "saad"}, 4, "search by user"),
            ({"search": "10.20.30.40"}, 5, "search by IP"),
            ({"search": "DeleteBucket"}, 1, "search by event name"),
            ({"search": "corr-api-1"}, 5, "search by correlation id"),
            ({"search": "9c8d7-req"}, 5, "search by request id"),
            ({"search": "zzzznope"}, 0, "search with no match"),
        ]
        for params, want, label in cases:
            r = await c.get(BASE, params={"account_id": aid, "range": "1h", **params})
            got = r.json().get("total") if r.status_code == 200 else f"HTTP {r.status_code}"
            eq(f"filter: {label}", got, want)

        # ── 3. Validation ────────────────────────────────────────────────────
        print("\n3. validation — a bad filter is refused, never ignored")
        for params, label in [
            ({"provider": "GCP"}, "unknown provider"),
            ({"status": "Maybe"}, "unknown status"),
            ({"risk_level": "SUPER"}, "unknown risk level"),
            ({"min_risk": "SUPER"}, "unknown min_risk"),
            ({"action": "Frobnicate"}, "unknown action"),
            ({"event_category": "Vibes"}, "unknown category"),
            ({"actor_type": "Wizard"}, "unknown actor type"),
            ({"access_method": "Telepathy"}, "unknown access method"),
            ({"range": "3fortnights"}, "unknown range"),
            ({"page_size": "37"}, "unsupported page size"),
        ]:
            r = await c.get(BASE, params={"account_id": aid, **params})
            eq(f"{label} -> 400", r.status_code, 400)
            check(f"  and the 400 explains {label}",
                  "detail" in r.json() and len(r.json()["detail"]) > 20)

        # ── 4. Advanced filters ──────────────────────────────────────────────
        print("\n4. advanced filters")
        tree = {"op": "AND", "conditions": [
            {"op": "OR", "conditions": [
                {"field": "action", "operator": "eq", "value": "Delete"},
                {"field": "action", "operator": "eq", "value": "Update"},
            ]},
            {"field": "risk_level", "operator": "gte", "value": "HIGH"},
            {"field": "provider", "operator": "in", "value": ["AWS", "OCI"]},
        ]}
        r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                      "advanced_filter": json.dumps(tree)})
        eq("the specification's nested example returns 200", r.status_code, 200)
        eq("and matches the right rows", r.json()["total"], 2)

        r = await c.get(BASE, params={"account_id": aid,
                                      "advanced_filter": "{not json"})
        eq("malformed advanced_filter JSON -> 400", r.status_code, 400)
        r = await c.get(BASE, params={"account_id": aid, "advanced_filter": '"a string"'})
        eq("a non-object advanced_filter -> 400", r.status_code, 400)
        r = await c.get(BASE, params={
            "account_id": aid,
            "advanced_filter": json.dumps({"field": "no_such_field",
                                           "operator": "eq", "value": "x"})})
        eq("an unknown field in advanced_filter -> 400", r.status_code, 400)

        # ── 5. Pagination ────────────────────────────────────────────────────
        print("\n5. pagination")
        for size in (25, 50, 100, 250, 500):
            r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                          "page_size": size})
            eq(f"page_size={size} accepted", r.status_code, 200)

        seen = []
        for page in (1, 2, 3):
            r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                          "page_size": 25, "page": page})
            seen.extend(i["id"] for i in r.json()["items"])
        eq("paging returns no duplicates", len(seen), len(set(seen)))

        # ── 6. Sorting ───────────────────────────────────────────────────────
        print("\n6. sorting")
        for sort in ("newest", "oldest", "risk", "actor", "resource", "provider",
                     "status", "event_type", "category"):
            r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                          "sort": sort})
            eq(f"sort={sort} accepted", r.status_code, 200)

        r = await c.get(BASE, params={"account_id": aid, "range": "1h", "sort": "risk"})
        eq("risk sort puts CRITICAL first, not alphabetical order",
           r.json()["items"][0]["risk_level"], "CRITICAL")
        r = await c.get(BASE, params={"account_id": aid, "range": "1h", "sort": "oldest"})
        eq("oldest sort inverts the feed",
           r.json()["items"][0]["provider_event_id"], "api-critical")

        # ── 7. Stats ─────────────────────────────────────────────────────────
        print("\n7. GET /events/stats")
        r = await c.get(f"{BASE}/stats", params={"account_id": aid, "range": "1h"})
        eq("returns 200", r.status_code, 200)
        s = r.json()
        eq("total", s["total_events"], 5)
        eq("successful", s["successful_events"], 4)
        eq("failed (includes denied)", s["failed_events"], 1)
        eq("denied", s["denied_events"], 1)
        eq("delete operations", s["delete_operations"], 1)
        eq("critical", s["critical_events"], 1)
        eq("administrative changes exclude the read", s["administrative_changes"], 4)
        for key in ("by_provider", "by_risk", "by_status", "by_category", "by_action",
                    "by_actor_type", "by_region", "top_actors", "top_resources",
                    "window", "sources"):
            check(f"stats carry `{key}`", key in s)
        check("every risk level is present as a key, including zeroes",
              all(level in s["by_risk"] for level in
                  ("INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL")))

        # Stats must agree with the list for the same filters — the cards and
        # the table cannot disagree.
        r_list = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                           "provider": "AWS"})
        r_stats = await c.get(f"{BASE}/stats", params={"account_id": aid,
                                                       "range": "1h",
                                                       "provider": "AWS"})
        eq("stats total matches the filtered list total",
           r_stats.json()["total_events"], r_list.json()["total"])

        # ── 8. Timeline ──────────────────────────────────────────────────────
        print("\n8. GET /events/timeline")
        r = await c.get(f"{BASE}/timeline", params={"account_id": aid, "range": "1h"})
        eq("returns 200", r.status_code, 200)
        t = r.json()
        eq("a 1-hour window buckets by minute", t["bucket"], "minute")
        eq("bucket totals sum to the event count",
           sum(b["total"] for b in t["buckets"]), 5)
        r = await c.get(f"{BASE}/timeline", params={"account_id": aid, "range": "30d"})
        t30 = r.json()
        eq("a 30-day window buckets by day", t30["bucket"], "day")
        r = await c.get(f"{BASE}/timeline", params={"account_id": aid, "range": "365d"})
        eq("a 365-day window buckets by week", r.json()["bucket"], "week")

        # Empty slots must be present, not collapsed away. `GROUP BY date_trunc`
        # only returns buckets that HAVE events, and the chart gives every
        # bucket equal width — so a 7-day window with activity on two days
        # rendered as two half-screen-wide blocks under a legend reading
        # "one bar = 1 day". Seen on the live AWS account.
        check("a 30-day window returns ~30 day buckets, not just the busy ones",
              28 <= len(t30["buckets"]) <= 32, f"{len(t30['buckets'])} buckets")
        eq("padding does not invent events",
           sum(b["total"] for b in t30["buckets"]), 5)
        check("empty buckets are explicit zeroes",
              any(b["total"] == 0 for b in t30["buckets"]))
        check("buckets are in chronological order",
              [b["bucket"] for b in t30["buckets"]]
              == sorted(b["bucket"] for b in t30["buckets"]))

        r = await c.get(f"{BASE}/timeline", params={"account_id": aid, "range": "7d"})
        t7 = r.json()
        check("a 7-day window returns ~7 day buckets",
              6 <= len(t7["buckets"]) <= 9, f"{len(t7['buckets'])} buckets")
        eq("and still totals the real events", sum(b["total"] for b in t7["buckets"]), 5)

        # ── 9. Facets ────────────────────────────────────────────────────────
        print("\n9. GET /events/facets")
        r = await c.get(f"{BASE}/facets", params={"account_id": aid, "range": "1h"})
        eq("returns 200", r.status_code, 200)
        f = r.json()
        for key in ("present", "vocabulary", "query_capabilities", "window"):
            check(f"facets carry `{key}`", key in f)
        check("providers actually present are listed",
              set(f["present"]["providers"]) == {"AWS", "Azure", "OCI"},
              f["present"]["providers"])
        check("the full vocabulary is separate from what is present",
              len(f["vocabulary"]["categories"]) > len(f["present"]["categories"]))
        check("searchable fields are declared, so the placeholder cannot lie",
              "actor_name" in f["query_capabilities"]["searchable_fields"])
        check("operators are declared",
              "between" in f["query_capabilities"]["operators"])
        check("page sizes are declared",
              f["query_capabilities"]["page_sizes"] == [25, 50, 100, 250, 500])

        # ── 10. Detail ───────────────────────────────────────────────────────
        print("\n10. GET /events/{id}")
        r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                      "search": "api-critical"})
        event_id = r.json()["items"][0]["id"]

        r = await c.get(f"{BASE}/{event_id}")
        eq("returns 200", r.status_code, 200)
        d = r.json()
        for section in ("actor", "resource", "source", "request", "result", "change"):
            check(f"detail has the `{section}` section", section in d)
        eq("actor name", d["actor"]["name"], "saad@example.com")
        eq("actor type", d["actor"]["type"], "Human")
        eq("actor role", d["actor"]["role"],
           "arn:aws:iam::123456789012:role/SecurityAdministrator")
        check("the role-assumption chain is present", len(d["actor"]["chain"]) >= 1)
        eq("resource id", d["resource"]["id"], "sg-123456789")
        eq("source IP", d["source"]["ip"], "10.20.30.40")
        eq("access method", d["source"]["access_method"], "Console")
        eq("request id", d["request"]["request_id"], "9c8d7-req")
        eq("correlation id", d["request"]["correlation_id"], "corr-api-1")
        eq("risk reason is present so the badge is justified",
           bool(d["risk_reason"]), True)
        check("the raw payload is included for a permitted role", "raw_event" in d)
        eq("change availability is stated explicitly",
           d["change"]["available"], False)
        check("provider retention is reported alongside the event",
              d.get("provider_retention_days") == 90, d.get("provider_retention_days"))
        check("ingestion latency is reported", "ingestion_latency_s" in d)

        r = await c.get(f"{BASE}/{uuid.uuid4()}")
        eq("an unknown event id -> 404", r.status_code, 404)
        r = await c.get(f"{BASE}/not-a-uuid")
        eq("a malformed event id -> 404, not a 500", r.status_code, 404)

        # ── 11. The OCI event's real before/after ────────────────────────────
        print("\n11. change diff (only where the provider supplies one)")
        r = await c.get(BASE, params={"account_id": aid, "range": "1h",
                                      "search": "api-oci"})
        oci_id = r.json()["items"][0]["id"]
        d = (await c.get(f"{BASE}/{oci_id}")).json()
        eq("OCI reports a change diff", d["change"]["available"], True)
        eq("before state", d["change"]["before"], {"source": "0.0.0.0/0"})
        eq("after state", d["change"]["after"], {"source": "10.10.0.0/16"})
        eq("changed fields", d["change"]["changed_fields"], ["source"])
        check("and the list row flags that a diff exists",
              r.json()["items"][0]["has_change"] is True)

        # ── 12. Raw event ────────────────────────────────────────────────────
        print("\n12. GET /events/{id}/raw")
        r = await c.get(f"{BASE}/{event_id}/raw")
        eq("returns 200", r.status_code, 200)
        raw = r.json()
        check("raw payload returned", raw.get("raw_event") is not None)
        check("provider metadata returned", "provider_metadata" in raw)
        check("a redaction note is always present, either way",
              bool(raw.get("redaction_note")))
        r = await c.get(f"{BASE}/{uuid.uuid4()}/raw")
        eq("unknown id -> 404", r.status_code, 404)

        # ── 13. Related ──────────────────────────────────────────────────────
        print("\n13. GET /events/{id}/related")
        r = await c.get(f"{BASE}/{event_id}/related")
        eq("returns 200", r.status_code, 200)
        rel = r.json()
        check("groups returned", "groups" in rel)
        check("related drift is reported (empty is a valid answer)",
              "related_drift" in rel)
        check("the note warns against reading correlation as causation",
              "never treated as a relationship" in rel.get("note", ""))
        check("a correlation group exists for the shared correlation id",
              "correlation" in rel["groups"], list(rel["groups"]))
        if "correlation" in rel["groups"]:
            eq("and is marked high confidence",
               rel["groups"]["correlation"]["confidence"], "high")

        # ── 14. Sources and collection status ────────────────────────────────
        print("\n14. GET /events/sources and /events/collection")
        r = await c.get(f"{BASE}/sources", params={"account_id": aid})
        eq("sources returns 200", r.status_code, 200)
        src = r.json()
        check("providers listed", isinstance(src["providers"], list))
        check("degraded flag present", "degraded" in src)
        check("this fixture account has never collected, so it is degraded",
              src["degraded"] is True)

        r = await c.get(f"{BASE}/collection", params={"account_id": aid})
        eq("collection returns 200", r.status_code, 200)
        col = r.json()
        for key in ("providers", "scopes", "settings", "retention", "metrics"):
            check(f"collection status carries `{key}`", key in col)
        check("application and provider retention are reported SEPARATELY",
              "application_days" in col["retention"]
              and "provider_days" in col["retention"])
        eq("AWS provider retention is 90 days",
           col["retention"]["provider_days"]["AWS"], 90)
        eq("OCI provider retention is 365 days",
           col["retention"]["provider_days"]["OCI"], 365)
        for metric in ("events_received", "events_stored", "events_duplicate",
                       "events_failed", "api_calls", "api_errors",
                       "rate_limit_hits"):
            check(f"observability metric `{metric}` reported", metric in col["metrics"])

        # ── 15. Actors and resources ─────────────────────────────────────────
        print("\n15. GET /events/actors and /events/resources")
        r = await c.get(f"{BASE}/actors", params={"account_id": aid, "range": "1h"})
        eq("actors returns 200", r.status_code, 200)
        check("actors listed", len(r.json()["items"]) == 2, r.json()["items"])
        r = await c.get(f"{BASE}/resources", params={"account_id": aid, "range": "1h"})
        eq("resources returns 200", r.status_code, 200)
        check("resources listed", len(r.json()["items"]) >= 1)

        # ── 16. Drift bridge ─────────────────────────────────────────────────
        print("\n16. GET /events/for-resource (the Config Drift link)")
        r = await c.get(f"{BASE}/for-resource", params={
            "account_id": aid, "resource_id": "sg-123456789",
            "around": NOW.isoformat(), "hours": 2,
        })
        eq("returns 200", r.status_code, 200)
        fr = r.json()
        check("matching events found", fr["total"] >= 1, fr["total"])
        eq("and it says which identifier it matched on", fr["matched_on"], "resource_id")
        check("the note explains what an empty result would mean",
              "no matching control-plane event" in fr.get("note", ""))
        check("source health travels with it", "sources" in fr)

        r = await c.get(f"{BASE}/for-resource", params={"account_id": aid})
        eq("with neither id nor name -> 400", r.status_code, 400)

        # ── 17. Rules ────────────────────────────────────────────────────────
        print("\n17. GET /events/rules")
        r = await c.get(f"{BASE}/rules")
        eq("returns 200", r.status_code, 200)
        rules = r.json()
        check("base risk map exposed", "base_risk_by_action" in rules)
        check("rules exposed with reasons",
              all(x.get("why") for x in rules["risk_rules"]))
        check("the note explains how to override them",
              "EVENT_RULES_FILE" in rules.get("note", ""))
        check("and that stored events keep their original classification",
              "append-only" in rules.get("note", ""))

        # ── 18. Settings ─────────────────────────────────────────────────────
        print("\n18. settings")
        r = await c.get(f"{BASE}/settings")
        eq("GET returns 200", r.status_code, 200)
        st = r.json()
        eq("default retention is 90 days", st["retention_days"], 90)
        check("provider retention shown separately",
              st["provider_retention_days"]["OCI"] == 365)
        check("the redaction policy is inspectable", "redaction" in st)
        check("and says it applies at ingestion",
              st["redaction"]["applied_at"] == "ingestion")
        check("RBAC posture is reported", "rbac" in st)

        original = st["retention_days"]
        r = await c.put(f"{BASE}/settings", json={"retention_days": 180})
        eq("PUT accepts a valid change", r.status_code, 200)
        eq("and applies it", r.json()["retention_days"], 180)
        for bad, label in [
            ({"retention_days": 0}, "retention below range"),
            ({"retention_days": 99999}, "retention above range"),
            ({"retention_days": "ninety"}, "retention not an integer"),
            ({"collection_interval_minutes": 0}, "interval below range"),
            ({"collection_enabled": "yes please"}, "flag not a boolean"),
        ]:
            r = await c.put(f"{BASE}/settings", json=bad)
            eq(f"PUT rejects {label}", r.status_code, 400)
        await c.put(f"{BASE}/settings", json={"retention_days": original})

        # ── 19. Saved queries ────────────────────────────────────────────────
        print("\n19. saved queries")
        r = await c.post(f"{BASE}/queries", json={
            "name": "__test Critical IAM Changes",
            "description": "IAM writes at HIGH or above",
            "filters": {"event_category": "IAM", "min_risk": "HIGH"},
        })
        eq("POST creates one", r.status_code, 200)
        query_id = r.json()["id"]
        eq("with the filters intact",
           r.json()["filters"], {"event_category": "IAM", "min_risk": "HIGH"})

        r = await c.get(f"{BASE}/queries")
        check("it appears in the list",
              any(q["id"] == query_id for q in r.json()["items"]))

        r = await c.post(f"{BASE}/queries", json={"name": "", "filters": {"a": 1}})
        eq("a nameless query is refused", r.status_code, 400)
        r = await c.post(f"{BASE}/queries", json={"name": "__test x", "filters": {}})
        eq("an empty filter set is refused", r.status_code, 400)

        r = await c.delete(f"{BASE}/queries/{query_id}")
        eq("DELETE removes it", r.status_code, 200)
        r = await c.delete(f"{BASE}/queries/{query_id}")
        eq("deleting it twice -> 404", r.status_code, 404)

        # ── 20. Export ───────────────────────────────────────────────────────
        print("\n20. export")
        r = await c.get(f"{BASE}/export", params={"account_id": aid, "range": "1h",
                                                  "format": "csv"})
        eq("CSV export returns 200", r.status_code, 200)
        check("with a CSV content type", "text/csv" in r.headers.get("content-type", ""))
        check("and an attachment filename",
              "attachment" in r.headers.get("content-disposition", ""))
        eq("the total is reported in a header", r.headers.get("X-Event-Total"), "5")
        eq("and whether it was truncated", r.headers.get("X-Event-Truncated"), "false")
        csv_text = r.text
        check("the CSV states the window it represents",
              "# Window (UTC):" in csv_text)
        check("and the filters it was taken under", "# Filters:" in csv_text)
        check("header row present", "Timestamp (UTC)" in csv_text)
        eq("one data row per event (plus 4 comment lines and a header)",
           len([l for l in csv_text.strip().split("\n") if l and not l.startswith("#")]),
           6)

        # Export must honour the filters, not just the visible page.
        r = await c.get(f"{BASE}/export", params={"account_id": aid, "range": "1h",
                                                  "format": "csv", "provider": "AWS"})
        eq("a filtered export reports the filtered total",
           r.headers.get("X-Event-Total"), "3")
        check("and contains only that provider's rows",
              r.text.count("\nAzure") == 0 and r.text.count("\nOCI") == 0)

        r = await c.get(f"{BASE}/export", params={"account_id": aid, "range": "1h",
                                                  "format": "json"})
        eq("JSON export returns 200", r.status_code, 200)
        payload = r.json()
        check("with a metadata block first", "metadata" in payload)
        eq("stating the matching count", payload["metadata"]["matching_events"], 5)
        check("stating whether it was truncated",
              payload["metadata"]["truncated"] is False)
        check("stating the filters", "filters" in payload["metadata"])
        eq("and carrying the events", len(payload["events"]), 5)
        check("JSON export omits the raw payload unless asked",
              "raw_event" not in payload["events"][0])

        r = await c.get(f"{BASE}/export", params={"account_id": aid, "range": "1h",
                                                  "format": "json", "include_raw": "true"})
        check("include_raw adds the provider payload",
              "raw_event" in r.json()["events"][0])

        r = await c.get(f"{BASE}/export", params={"account_id": aid, "format": "xlsx"})
        eq("an unsupported format -> 400", r.status_code, 400)
        r = await c.get(f"{BASE}/export", params={"account_id": aid, "provider": "GCP"})
        eq("a bad filter on export -> 400 BEFORE streaming starts", r.status_code, 400)

        # ── 21. Access model / audit of the audit ────────────────────────────
        print("\n21. GET /events/access")
        r = await c.get(f"{BASE}/access")
        eq("returns 200", r.status_code, 200)
        acc = r.json()
        check("the RBAC posture is reported", "rbac" in acc)
        check("including whether it is enforced", "enforced" in acc["rbac"])
        check("and the caller's own role", acc["you"]["role"])
        check("the access log records the export we just did",
              acc.get("access_log") is not None
              and any(e["action"] == "EXPORT" for e in acc["access_log"]),
              str(acc.get("access_log_withheld"))[:80])
        check("and the raw-payload view",
              any(e["action"] == "VIEW_RAW_EVENT" for e in (acc.get("access_log") or [])))
        check("and the settings change",
              any(e["action"] == "SETTINGS_CHANGED" for e in (acc.get("access_log") or [])))
        check("and the saved-query creation",
              any(e["action"] == "QUERY_SAVED" for e in (acc.get("access_log") or [])))

        # ── 22. No write path for an event ───────────────────────────────────
        print("\n22. events are immutable over HTTP too")
        for method, path in [
            ("put", f"{BASE}/{event_id}"),
            ("patch", f"{BASE}/{event_id}"),
            ("delete", f"{BASE}/{event_id}"),
            ("post", f"{BASE}/{event_id}"),
        ]:
            # c.delete() in this httpx version takes no `json`, so every
            # method goes through request() for a uniform call.
            r = await c.request(method.upper(), path, json={"actor_name": "tampered"})
            check(f"{method.upper()} on an event is not routed ({r.status_code})",
                  r.status_code in (404, 405), r.status_code)

        # ── 23. RBAC enforcement ─────────────────────────────────────────────
        print("\n23. RBAC")
        r = await c.get(f"{BASE}/access")
        summary = r.json()["rbac"]
        eq("enforcement is off by default on this deployment",
           summary["enforced"], False)
        check("the four specified roles exist",
              set(summary["roles"]) == {"viewer", "security_analyst",
                                        "administrator", "audit_admin"},
              list(summary["roles"]))
        check("a viewer may view but not export",
              "events:view" in summary["roles"]["viewer"]
              and "events:export" not in summary["roles"]["viewer"])
        check("an analyst may search and export but not configure",
              "events:export" in summary["roles"]["security_analyst"]
              and "events:configure" not in summary["roles"]["security_analyst"])
        check("only the audit admin may read the access log",
              "events:view_access_log" in summary["roles"]["audit_admin"]
              and "events:view_access_log" not in summary["roles"]["administrator"])
        check("the posture note is explicit that enforcement is off",
              "OFF" in summary["note"])

        # Turn enforcement ON and confirm an unauthenticated call is refused.
        os.environ["EVENTLOG_RBAC_ENFORCE"] = "true"
        try:
            r = await c.get(BASE, params={"account_id": aid})
            eq("with enforcement on, an unauthenticated list -> 401",
               r.status_code, 401)

            from app.core.security import create_access_token
            import jwt as _jwt
            from app.core.config import settings as _settings

            def token_for(role):
                from datetime import datetime as _dt, timedelta as _td
                return _jwt.encode(
                    {"sub": f"{role}@example.com", "role": role,
                     "exp": _dt.now(timezone.utc) + _td(minutes=10)},
                    _settings.JWT_SECRET, algorithm=_settings.JWT_ALGORITHM,
                )

            r = await c.get(BASE, params={"account_id": aid},
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer token can list", r.status_code, 200)
            eq("and the response reports the resolved role",
               r.json()["access"]["role"], "viewer")

            r = await c.get(BASE, params={"account_id": aid, "search": "saad"},
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer may NOT search", r.status_code, 403)

            r = await c.get(f"{BASE}/export",
                            params={"account_id": aid, "format": "csv"},
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer may NOT export", r.status_code, 403)

            r = await c.get(f"{BASE}/{event_id}/raw",
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer may NOT read a raw payload", r.status_code, 403)

            r = await c.get(f"{BASE}/{event_id}",
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("but a viewer CAN still read the structured event", r.status_code, 200)
            check("with the raw payload withheld rather than the event refused",
                  "raw_event" not in r.json() and "raw_event_withheld" in r.json())

            r = await c.get(f"{BASE}/export",
                            params={"account_id": aid, "format": "csv"},
                            headers={"Authorization": f"Bearer {token_for('security_analyst')}"})
            eq("an analyst may export", r.status_code, 200)

            r = await c.put(f"{BASE}/settings", json={"retention_days": 90},
                            headers={"Authorization": f"Bearer {token_for('security_analyst')}"})
            eq("an analyst may NOT change retention", r.status_code, 403)

            r = await c.put(f"{BASE}/settings", json={"retention_days": 90},
                            headers={"Authorization": f"Bearer {token_for('administrator')}"})
            eq("an administrator may change retention", r.status_code, 200)

            r = await c.get(f"{BASE}/access",
                            headers={"Authorization": f"Bearer {token_for('administrator')}"})
            check("an administrator does NOT get the access log",
                  r.json()["access_log"] is None
                  and bool(r.json().get("access_log_withheld")))

            r = await c.get(f"{BASE}/access",
                            headers={"Authorization": f"Bearer {token_for('audit_admin')}"})
            check("an audit admin does", r.json()["access_log"] is not None)

            r = await c.get(BASE, params={"account_id": aid},
                            headers={"Authorization": "Bearer not-a-real-token"})
            eq("an invalid token is refused when enforcement is on",
               r.status_code, 401)

            # And the refusals were themselves audited.
            r = await c.get(f"{BASE}/access",
                            headers={"Authorization": f"Bearer {token_for('audit_admin')}"})
            denials = [e for e in r.json()["access_log"] if e["action"] == "ACCESS_DENIED"]
            check("every refusal was recorded in the access log",
                  len(denials) >= 4, f"{len(denials)} denials recorded")
            check("with the permission that was missing",
                  any(d["detail"].get("permission") for d in denials))
        finally:
            os.environ["EVENTLOG_RBAC_ENFORCE"] = "false"

        r = await c.get(BASE, params={"account_id": aid})
        eq("enforcement back off — anonymous access works again", r.status_code, 200)

        # ── 24. Empty results are distinguishable from broken collection ─────
        print("\n24. empty vs broken")
        r = await c.get(BASE, params={"account_id": aid, "range": "15m",
                                      "search": "nothing-matches-this"})
        eq("an empty result is a 200, not an error", r.status_code, 200)
        eq("with a zero total", r.json()["total"], 0)
        check("and the source health needed to interpret it",
              r.json()["sources"]["degraded"] is not None)

        # ── 25. Cross-account (no account_id) ────────────────────────────────
        print("\n25. cross-account feed")
        r = await c.get(BASE, params={"range": "1h"})
        eq("omitting account_id returns 200", r.status_code, 200)
        check("and includes rows from our fixture account",
              any(i["account_id"] == aid for i in r.json()["items"]))
        check("with the account name resolved for display",
              all("account_name" in i for i in r.json()["items"]))

    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        for name in fail:
            print(f"  ! {name}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
