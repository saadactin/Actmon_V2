"""Probe and register Azure subscriptions from a local credential file.

Credentials are read from azure_accounts.local.json (gitignored) so no secret
ever lands in tracked source.

Usage:
    python register_azure_accounts.py --probe      # test creds only, no DB writes
    python register_azure_accounts.py --register   # probe, then store passing accounts

--probe answers, per subscription: does the service principal authenticate,
can it read ARM resources, and can it read Cost Management data. Only the last
one determines whether the cost dashboards will have anything to show.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CRED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "azure_accounts.local.json")

OK = "  [OK]   "
FAIL = "  [FAIL] "
WARN = "  [WARN] "


def load_accounts() -> list[dict]:
    if not os.path.exists(CRED_FILE):
        sys.exit(f"Credential file not found: {CRED_FILE}")
    with open(CRED_FILE, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return [a for a in data.get("accounts", []) if a.get("enabled")]


def probe_one(acct: dict) -> dict:
    """Synchronous probe of a single subscription. Returns a result dict."""
    from azure.identity import ClientSecretCredential
    from azure.mgmt.resource import ResourceManagementClient
    from azure.mgmt.subscription import SubscriptionClient

    sub_id = acct["subscription_id"]
    res: dict = {
        "account_name": acct["account_name"],
        "subscription_id": sub_id,
        "token": False,
        "subscription_read": False,
        "resource_read": False,
        "resource_count": 0,
        "cost_read": False,
        "cost_rows": 0,
        "cost_total": 0.0,
        "currency": None,
        "roles": [],
        "errors": [],
    }

    cred = ClientSecretCredential(
        tenant_id=acct["tenant_id"],
        client_id=acct["client_id"],
        client_secret=acct["client_secret"],
    )

    # 1. Can we get a token at all? (tenant + app id + secret correct)
    try:
        cred.get_token("https://management.azure.com/.default")
        res["token"] = True
        print(OK + "token acquired (tenant/app-id/secret are valid)")
    except Exception as exc:
        res["errors"].append(f"token: {exc}")
        print(FAIL + f"token acquisition failed: {exc}")
        return res  # nothing else can work

    # 2. Reader on the subscription itself
    try:
        sub = SubscriptionClient(cred).subscriptions.get(sub_id)
        res["subscription_read"] = True
        res["display_name"] = sub.display_name
        print(OK + f"subscription readable: {sub.display_name} (state={sub.state})")
    except Exception as exc:
        res["errors"].append(f"subscription_read: {exc}")
        print(FAIL + f"subscriptions/read denied: {str(exc).splitlines()[0]}")

    # 3. ARM resource listing — drives discovery / topology / inventory
    try:
        rm = ResourceManagementClient(cred, sub_id)
        types: dict[str, int] = {}
        count = 0
        for r in rm.resources.list():
            count += 1
            t = (r.type or "unknown").lower()
            types[t] = types.get(t, 0) + 1
            if count >= 2000:
                break
        res["resource_read"] = True
        res["resource_count"] = count
        res["resource_types"] = dict(sorted(types.items(), key=lambda kv: -kv[1])[:12])
        print(OK + f"resources readable: {count} resources, {len(types)} distinct types")
        for t, n in list(res["resource_types"].items())[:8]:
            print(f"           {n:>5}  {t}")
    except Exception as exc:
        res["errors"].append(f"resource_read: {exc}")
        print(FAIL + f"resources/read denied: {str(exc).splitlines()[0]}")

    # 4. Role assignments — explains *why* something is denied
    try:
        from azure.mgmt.authorization import AuthorizationManagementClient

        auth_client = AuthorizationManagementClient(cred, sub_id)
        scope = f"/subscriptions/{sub_id}"
        for ra in auth_client.role_assignments.list_for_scope(scope):
            rd_id = (ra.role_definition_id or "").rsplit("/", 1)[-1]
            try:
                rd = auth_client.role_definitions.get(scope, rd_id)
                res["roles"].append(rd.role_name)
            except Exception:
                res["roles"].append(rd_id)
        res["roles"] = sorted(set(res["roles"]))
        if res["roles"]:
            print(OK + f"role assignments at subscription scope: {', '.join(res['roles'])}")
    except ImportError:
        print(WARN + "azure-mgmt-authorization not installed - skipping role check")
    except Exception as exc:
        print(WARN + f"could not list role assignments: {str(exc).splitlines()[0]}")

    # 5. Cost Management — the one that decides whether cost pages have data
    try:
        from azure.mgmt.costmanagement import CostManagementClient
        from azure.mgmt.costmanagement.models import (
            QueryAggregation,
            QueryDataset,
            QueryDefinition,
            QueryGrouping,
            QueryTimePeriod,
        )

        cm = CostManagementClient(cred)
        today = date.today()
        query = QueryDefinition(
            type="ActualCost",
            timeframe="Custom",
            time_period=QueryTimePeriod(
                from_property=(today - timedelta(days=30)).strftime("%Y-%m-%dT00:00:00Z"),
                to=today.strftime("%Y-%m-%dT23:59:59Z"),
            ),
            dataset=QueryDataset(
                granularity=None,
                aggregation={"totalCost": QueryAggregation(name="Cost", function="Sum")},
                grouping=[QueryGrouping(type="Dimension", name="ServiceName")],
            ),
        )
        result = cm.query.usage(scope=f"/subscriptions/{sub_id}", parameters=query)
        cols = [c.name for c in (result.columns or [])]
        rows = [dict(zip(cols, row)) for row in (result.rows or [])]
        res["cost_read"] = True
        res["cost_rows"] = len(rows)
        res["cost_total"] = round(sum(float(r.get("Cost", 0) or 0) for r in rows), 2)
        res["currency"] = next((r.get("Currency") for r in rows if r.get("Currency")), None)
        if rows:
            print(
                OK
                + f"Cost Management readable: {len(rows)} service rows, "
                f"30-day total {res['cost_total']} {res['currency'] or ''}"
            )
            top = sorted(rows, key=lambda r: -float(r.get("Cost", 0) or 0))[:8]
            for r in top:
                print(f"           {float(r.get('Cost', 0) or 0):>12.2f}  {r.get('ServiceName')}")
        else:
            print(WARN + "Cost Management query succeeded but returned ZERO rows "
                         "(no spend in window, or no Cost Management Reader role)")
    except Exception as exc:
        res["errors"].append(f"cost_read: {exc}")
        print(FAIL + f"Cost Management denied: {str(exc).splitlines()[0]}")

    return res


async def register(acct: dict) -> None:
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.config import settings
    from app.repository.cloud_account_repo import CloudAccountRepository
    from app.schemas.cloud_account import CloudAccountCreate
    from app.services.cloud_account_service import CloudAccountService

    engine = create_async_engine(settings.async_database_url)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with async_session() as db:
            existing = await CloudAccountRepository(db).list_all()
            for e in existing:
                if e.account_name == acct["account_name"]:
                    print(WARN + f"'{acct['account_name']}' already registered (id={e.id}) - skipped")
                    return
            payload = CloudAccountCreate(
                account_name=acct["account_name"],
                provider="Azure",
                environment=acct.get("environment", "Production"),
                tenant_or_region=acct["tenant_id"],
                auth_mode="API_Keys",
                auto_discovery=True,
                tenant_id=acct["tenant_id"],
                client_id=acct["client_id"],
                client_secret=acct["client_secret"],
                subscription_id=acct["subscription_id"],
            )
            created = await CloudAccountService(db).create_account(payload)
            # The repository only flushes; in the API path get_db() commits.
            # Running standalone we must commit ourselves or the row is discarded.
            await db.commit()
            print(OK + f"registered '{created.account_name}' -> id={created.id}")
    except Exception as exc:
        print(FAIL + f"registration failed for '{acct['account_name']}': {exc}")
    finally:
        await engine.dispose()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true", help="test credentials only")
    parser.add_argument("--register", action="store_true", help="probe then store passing accounts")
    args = parser.parse_args()
    if not (args.probe or args.register):
        parser.error("pass --probe or --register")

    accounts = load_accounts()
    print(f"Loaded {len(accounts)} enabled account(s) from {os.path.basename(CRED_FILE)}\n")

    results = []
    for acct in accounts:
        print("=" * 78)
        print(f"{acct['account_name']}   sub={acct['subscription_id']}")
        print("=" * 78)
        res = await asyncio.get_event_loop().run_in_executor(None, probe_one, acct)
        results.append((acct, res))
        print()

    print("=" * 78)
    print("SUMMARY")
    print("=" * 78)
    print(f"{'Account':<34} {'auth':<6} {'res':<7} {'cost':<7} {'30d total'}")
    for acct, r in results:
        print(
            f"{r['account_name'][:33]:<34} "
            f"{'yes' if r['token'] and r['subscription_read'] else 'NO':<6} "
            f"{(str(r['resource_count']) if r['resource_read'] else 'NO'):<7} "
            f"{(str(r['cost_rows']) if r['cost_read'] else 'NO'):<7} "
            f"{r['cost_total'] if r['cost_read'] else '-'} {r['currency'] or ''}"
        )

    if args.register:
        print("\n" + "=" * 78)
        print("REGISTERING accounts that authenticated successfully")
        print("=" * 78)
        for acct, r in results:
            if r["token"] and r["subscription_read"]:
                await register(acct)
            else:
                print(FAIL + f"'{acct['account_name']}' skipped - authentication failed")


if __name__ == "__main__":
    asyncio.run(main())
