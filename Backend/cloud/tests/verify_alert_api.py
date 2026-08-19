"""End-to-end through the ASGI app, so the Depends(get_db) wiring and the JSON
the frontend actually receives are both exercised."""
import asyncio
import logging
import pathlib
import sys

# Run as a plain script, so the project root is not on sys.path by default.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)

import httpx
from sqlalchemy import text

from app.core.config import settings
from app.core.database import engine
from app.main import app

# Importing app.main runs setup_logging(), which resets these — so quiet the
# query firehose down again afterwards or the results scroll off the screen.
for _noisy in ("sqlalchemy.engine", "httpx", "asyncio"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

BASE = "/api/v1/cloud/alerts"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


# The keys the existing AlertsPage reads — these must not change or the UI breaks.
UI_KEYS = {"id", "account_id", "anomaly_type", "severity", "details", "is_read",
           "simulated", "created_at"}


async def main():
    print(f"DEBUG mode: {settings.DEBUG}\n")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # ── list ──────────────────────────────────────────────────────────────
        r = await c.get(BASE)
        check("GET /alerts -> 200", r.status_code == 200, str(r.status_code))
        check("returns a list", isinstance(r.json(), list))

        r = await c.get(f"{BASE}/counts")
        check("GET /alerts/counts -> 200", r.status_code == 200, str(r.status_code))
        check("counts has all 3 states",
              set(r.json()) == {"OPEN", "ACKNOWLEDGED", "RESOLVED"}, str(r.json()))

        # ── create via the DEBUG simulate hook ────────────────────────────────
        r = await c.post(f"{BASE}/simulate", json={
            "anomaly_type": "TEST_API", "details": "api round trip",
            "severity": "MEDIUM"})
        if not settings.DEBUG:
            check("simulate blocked outside DEBUG", r.status_code == 403, str(r.status_code))
            print("\n  (DEBUG off — skipping the write-path checks)")
        else:
            check("POST /simulate -> 200", r.status_code == 200, str(r.status_code))
            alert = r.json()["alert"]
            aid = alert["id"]
            check("every key the UI reads is present",
                  UI_KEYS <= set(alert), f"missing: {UI_KEYS - set(alert)}")
            check("simulated flag is true", alert["simulated"] is True)
            check("new alert is OPEN", alert["state"] == "OPEN")

            # visible in the default feed
            feed = (await c.get(BASE)).json()
            check("appears in the default feed", any(a["id"] == aid for a in feed))

            # ── acknowledge ───────────────────────────────────────────────────
            r = await c.post(f"{BASE}/{aid}/acknowledge")
            check("POST /acknowledge -> 200", r.status_code == 200, str(r.status_code))
            check("state ACKNOWLEDGED", r.json()["alert"]["state"] == "ACKNOWLEDGED")

            # still in the feed — acknowledged is not resolved
            feed = (await c.get(BASE)).json()
            check("acknowledged stays in the feed", any(a["id"] == aid for a in feed))

            # ── resolve ───────────────────────────────────────────────────────
            r = await c.post(f"{BASE}/{aid}/resolve")
            check("POST /resolve -> 200", r.status_code == 200, str(r.status_code))
            check("state RESOLVED", r.json()["alert"]["state"] == "RESOLVED")

            feed = (await c.get(BASE)).json()
            check("resolved drops out of the default feed",
                  not any(a["id"] == aid for a in feed))
            feed = (await c.get(BASE, params={"include_resolved": "true"})).json()
            check("resolved returned with include_resolved",
                  any(a["id"] == aid for a in feed))

            # ── legacy read endpoint the current UI calls ──────────────────────
            r2 = await c.post(f"{BASE}/simulate", json={
                "anomaly_type": "TEST_API", "details": "legacy read", "severity": "LOW"})
            bid = r2.json()["alert"]["id"]
            r = await c.post(f"{BASE}/{bid}/read")
            check("POST /read still works -> 200", r.status_code == 200, str(r.status_code))
            check("read acknowledges", r.json()["alert"]["state"] == "ACKNOWLEDGED")
            check("is_read true for the UI", r.json()["alert"]["is_read"] is True)

            # ── error paths ───────────────────────────────────────────────────
            r = await c.post(f"{BASE}/00000000-0000-0000-0000-000000000000/resolve")
            check("unknown id -> 404", r.status_code == 404, str(r.status_code))
            r = await c.post(f"{BASE}/not-a-uuid/acknowledge")
            check("malformed id -> 404, not 500", r.status_code == 404, str(r.status_code))

    async with engine.begin() as conn:
        await conn.execute(text("delete from cloud_alerts where anomaly_type='TEST_API'"))
    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        for f in fail:
            print("  FAILED:", f)
        sys.exit(1)


asyncio.run(main())
