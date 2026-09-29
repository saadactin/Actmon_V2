"""Certificates, secrets and keys: persistence, views, assessment, alerting.

Postgres fixtures (`zzcerts-test-`), driven through the ASGI app where it
matters. What must hold:

* **A scope read in full replaces its objects; a failed scope changes
  nothing.** Replacing on a refusal would turn "the vault said 403" into
  "every certificate was removed".
* **A vault a successful listing no longer returns is forgotten** — and never
  on a failed listing.
* **The views file objects by expiry and name their unread stores.**
* **The assessment turns stored objects into findings and compliance states**,
  with an unread store making controls PARTIAL, never PASS.
* **The alert condition counts from the same store** and answers UNSUPPORTED
  before first collection and UNKNOWN when every store refused.
"""
import asyncio
import logging
import os
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

import httpx  # noqa: E402
from sqlalchemy import delete, func, select, text  # noqa: E402

from app.core import schema_patches  # noqa: E402
from app.core.database import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.alert import CloudAlert  # noqa: E402
from app.models.client import CloudClient  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.credential_inventory import (  # noqa: E402
    COLLECT_OK, COLLECT_PERMISSION_DENIED, KIND_CERTIFICATE, KIND_SECRET,
    CloudCredentialObject, CloudCredentialSource,
)
from app.models.security_finding import (  # noqa: E402
    CloudSecurityAssessment, CloudSecurityFinding,
)
from app.providers.credential_common import scope_result  # noqa: E402
from app.repository.credential_repo import CredentialRepository  # noqa: E402
from app.services.credential_service import CredentialService  # noqa: E402

BASE = "/api/v1/cloud/certificates"
PREFIX = "zzcerts-test-"
NOW = datetime.now(timezone.utc)
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def token_for(role):
    import jwt as _jwt

    from app.core.config import settings as _settings
    return _jwt.encode({"sub": f"{role}@example.com", "role": role,
                        "exp": datetime.now(timezone.utc) + timedelta(minutes=10)},
                       _settings.JWT_SECRET, algorithm=_settings.JWT_ALGORITHM)


async def purge():
    async with AsyncSessionLocal() as db:
        ids = (await db.execute(select(CloudAccount.id).where(
            CloudAccount.account_name.like(f"{PREFIX}%")))).scalars().all()
        if ids:
            for model in (CloudSecurityFinding, CloudSecurityAssessment, CloudAlert,
                          CloudCredentialObject, CloudCredentialSource):
                await db.execute(delete(model).where(model.account_id.in_(ids)))
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.execute(delete(CloudClient).where(CloudClient.name.like(f"{PREFIX}%")))
        await db.commit()
        return len(ids)


async def make_account(name, provider, client_id=None):
    async with AsyncSessionLocal() as db:
        a = CloudAccount(account_name=f"{PREFIX}{name}", provider=provider, environment="Test",
                         tenant_or_region="r1", auth_mode="API_Keys", auto_discovery=False,
                         credentials_enc="junk", client_id=client_id,
                         last_discovery=NOW)
        db.add(a)
        await db.commit()
        return a


def cert(key, days, **over):
    return {"kind": KIND_CERTIFICATE, "object_key": key, "name": key,
            "expires_at": NOW + timedelta(days=days), **over}


VAULT_A = {"vault_id": "/subscriptions/zz/vaults/kv-a", "vault_name": "kv-a",
           "rbac_authorization": True, "purge_protection": True, "soft_delete": True}
VAULT_B = {"vault_id": "/subscriptions/zz/vaults/kv-b", "vault_name": "kv-b",
           "rbac_authorization": False, "purge_protection": None, "soft_delete": True}


async def main() -> int:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [SKIP] Postgres is not reachable ({exc}); these are NOT passes")
        return 1
    await schema_patches.apply_standalone()

    print("\n=== 0. Schema patches take no table lock when nothing is missing ===")
    # ALTER TABLE ... IF NOT EXISTS takes ACCESS EXCLUSIVE before it learns the
    # column exists, so it used to wait behind any open transaction on the
    # table — a running discovery holds one — with every other query queued
    # behind it. Now: catalog check first, DDL only when something is missing.
    import time as _time

    async with engine.connect() as holder:
        trans = await holder.begin()
        await holder.execute(text("SELECT 1 FROM discovery_jobs LIMIT 1"))  # holds a lock
        started = _time.monotonic()
        try:
            ran = await asyncio.wait_for(schema_patches.apply_standalone(), timeout=20)
            took = _time.monotonic() - started
            check("with a transaction open on discovery_jobs, an up-to-date database "
                  "patches instantly and runs no DDL", ran == 0 and took < 10,
                  f"{ran} patch(es) in {took:.1f}s")
        except asyncio.TimeoutError:
            check("with a transaction open on discovery_jobs, an up-to-date database "
                  "patches instantly and runs no DDL", False, "blocked on the table lock")
        finally:
            await trans.rollback()

    left = await purge()
    if left:
        print(f"  (purged {left} account(s) left by an earlier run)")
    try:
        await run()
    finally:
        await purge()
        await engine.dispose()
    print(f"\n{len(ok)} passed, {len(fail)} failed")
    if fail:
        print("\nFAILURES:")
        for f in fail:
            print(f"  ! {f}")
    return 1 if fail else 0


async def run():
    print("\n=== A. A scope read in full replaces its objects; a failed one changes nothing ===")
    acct = await make_account("aws", "AWS")
    async with AsyncSessionLocal() as db:
        repo = CredentialRepository(db)
        n = await repo.replace_scope(account_id=acct.id, provider="AWS", source="aws:acm",
                                     scope="ap-south-1",
                                     specs=[cert("zz-c1", 5), cert("zz-c2", 40), cert("zz-c3", -2)])
        await repo.replace_scope(account_id=acct.id, provider="AWS", source="aws:acm",
                                 scope="eu-west-1", specs=[cert("zz-eu", 100)])
        await db.commit()
        eq("three objects stored for the scope", n, 3)
        first = {o.object_key: o.first_seen_at for o in await repo.objects([acct.id])}
        await repo.replace_scope(account_id=acct.id, provider="AWS", source="aws:acm",
                                 scope="ap-south-1", specs=[cert("zz-c1", 5), cert("zz-c2", 400)])
        await db.commit()
        now_keys = {o.object_key: o for o in await repo.objects([acct.id])}
        eq("a re-read without zz-c3 removes it (it really is gone)",
           sorted(now_keys), ["zz-c1", "zz-c2", "zz-eu"])
        eq("...an object that persists keeps its first-seen time",
           now_keys["zz-c1"].first_seen_at, first["zz-c1"])
        check("...and takes the new expiry (renewed)",
              now_keys["zz-c2"].expires_at > NOW + timedelta(days=300))
        check("...another scope of the same source is untouched", "zz-eu" in now_keys)
        await repo.record_source(account_id=acct.id, provider="AWS",
                                 result=scope_result("aws:acm", "ap-south-1", COLLECT_OK),
                                 item_count=2)
        await db.commit()
        await repo.record_source(account_id=acct.id, provider="AWS", result=scope_result(
            "aws:acm", "ap-south-1", COLLECT_PERMISSION_DENIED, error_detail="AccessDenied",
            missing_permission="acm:ListCertificates"), item_count=0)
        await db.commit()
        s = next(x for x in await repo.sources([acct.id]) if x.scope == "ap-south-1")
        eq("a refused attempt is recorded as refused", s.status, COLLECT_PERMISSION_DENIED)
        eq("...but keeps the last successful count", s.item_count, 2)
        check("...and the last success time", s.last_success_at is not None)
        eq("...naming the permission", s.missing_permission, "acm:ListCertificates")
        eq("objects of a refused scope are still there",
           len([o for o in await repo.objects([acct.id]) if o.source_scope == "ap-south-1"]), 2)

    print("\n=== B. Vaults that disappear are forgotten — only on a successful listing ===")
    az = await make_account("azure", "Azure")
    svc_results = lambda vaults, listing=COLLECT_OK: (  # noqa: E731
        [scope_result("azure:keyvault-vaults", "sub", listing)]
        + [scope_result("azure:keyvault:secrets", v["vault_id"], COLLECT_OK,
                        items=[{"kind": KIND_SECRET, "object_key": f"{v['vault_id']}/s1",
                                "name": "s1", "container_key": v["vault_id"],
                                "container_name": v["vault_name"], "expires_at": None,
                                "enabled": True}],
                        scope_label=v["vault_name"], container=v) for v in vaults])
    async with AsyncSessionLocal() as db:
        out = await CredentialService(db)._persist(az, "AZURE", svc_results([VAULT_A, VAULT_B]))
        eq("two vaults' secrets stored", out["objects"], 2)
        out = await CredentialService(db)._persist(az, "AZURE", [
            scope_result("azure:keyvault-vaults", "sub", COLLECT_PERMISSION_DENIED)])
        keys = sorted(o.container_key for o in await CredentialRepository(db).objects([az.id]))
        eq("a FAILED vault listing forgets nothing", keys,
           sorted([VAULT_A["vault_id"], VAULT_B["vault_id"]]))
        await CredentialService(db)._persist(az, "AZURE", svc_results([VAULT_A]))
        keys = sorted(o.container_key for o in await CredentialRepository(db).objects([az.id]))
        eq("a successful listing without kv-b forgets kv-b's objects", keys, [VAULT_A["vault_id"]])
        scopes = sorted(s.scope for s in await CredentialRepository(db).sources([az.id])
                        if s.source.startswith("azure:keyvault:"))
        eq("...and its source rows", scopes, [VAULT_A["vault_id"]])

    # A subscription with NO Key Vault: the listing succeeds and returns none.
    # This used to hand NOT IN a "\x00" sentinel that Postgres refuses, so the
    # whole collection failed (HTTP 500 on the live TOR subscription) and
    # nothing — App Service or Application Gateway certificates included —
    # was stored.
    az0 = await make_account("azure-novault", "Azure")
    async with AsyncSessionLocal() as db:
        await CredentialService(db)._persist(az0, "AZURE", svc_results([VAULT_A]))
        try:
            out = await CredentialService(db)._persist(az0, "AZURE", svc_results([]))
            raised = None
        except Exception as exc:  # noqa: BLE001
            out, raised = {}, exc
        eq("a successful listing that returns NO vaults does not fail the collection",
           repr(raised) if raised else None, None)
        eq("...and forgets every vault it had", [o.container_key for o in
                                                 await CredentialRepository(db).objects([az0.id])], [])
        left = sorted(s.source for s in await CredentialRepository(db).sources([az0.id]))
        eq("...keeping only the listing's own source row", left, ["azure:keyvault-vaults"])

    print("\n=== C. The views ===")
    client = CloudClient(name=f"{PREFIX}client")
    async with AsyncSessionLocal() as db:
        db.add(client)
        await db.commit()
        await db.execute(CloudAccount.__table__.update().where(
            CloudAccount.id == acct.id).values(client_id=client.id))
        await db.commit()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get(f"{BASE}/{acct.id}")
        eq("account view -> 200", r.status_code, 200)
        v = r.json()
        buckets = {o["object_key"]: o["bucket"] for o in v["objects"]}
        eq("5 days left files under within_7", buckets.get("zz-c1"), "within_7")
        eq("400 days files under later", buckets.get("zz-c2"), "later")
        eq("the summary counts one urgent certificate", v["summary"]["by_bucket"]["within_7"], 1)
        eq("...and one failing source", v["summary"]["sources_failing"], 1)
        src = next(s for s in v["sources"] if s["scope"] == "ap-south-1")
        eq("the failing source carries a readable label", src["source_label"],
           "AWS Certificate Manager")
        r = await c.get(f"{BASE}/{uuid.uuid4()}")
        eq("an unknown account -> 404", r.status_code, 404)
        r = await c.get(BASE, params={"client_id": str(client.id), "within_days": 30})
        e = r.json()
        eq("estate view filtered to the client's accounts", sorted(
            a["account_name"] for a in e["accounts"]), [f"{PREFIX}aws"])
        eq("...listing only what expires within 30 days", [o["object_key"] for o in e["objects"]],
           ["zz-c1"])
        r = await c.get(BASE, params={"client_id": str(client.id), "kind": "SECRET"})
        eq("a kind filter", r.json()["objects"], [])
        r = await c.get(BASE, params={"kind": "BOGUS"})
        eq("an unknown kind -> 400", r.status_code, 400)
        r = await c.get(BASE, params={"unassigned": "true", "include_no_expiry": "true",
                                      "within_days": 0})
        check("unassigned + include_no_expiry shows the Azure secret with no expiry",
              any(o["object_key"].endswith("/s1") for o in r.json()["objects"]))

        os.environ["CLOUD_RBAC_ENFORCE"] = "true"
        try:
            r = await c.post(f"{BASE}/{acct.id}/collect",
                             headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("a viewer cannot trigger collection (it calls every provider store)",
               r.status_code, 403)
            r = await c.get(f"{BASE}/{acct.id}",
                            headers={"Authorization": f"Bearer {token_for('viewer')}"})
            eq("...but can read the inventory", r.status_code, 200)
        finally:
            os.environ.pop("CLOUD_RBAC_ENFORCE", None)
        r = await c.post(f"{BASE}/{uuid.uuid4()}/collect")
        eq("collecting for an unknown account -> 404", r.status_code, 404)

    print("\n=== D. Assessment and compliance read the same inventory ===")
    from app.services.security_center_service import SecurityCenterService

    async with AsyncSessionLocal() as db:
        await SecurityCenterService(db).assess(acct.id, triggered_by="test",
                                               evaluate_policies=False)
        rules = {f.rule_id: f for f in (await db.execute(select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == acct.id))).scalars().all()}
    check("an expiring certificate becomes a CERT_EXPIRING_SOON finding",
          "CERT_EXPIRING_SOON" in rules, str(sorted(rules)))
    check("the refused store becomes a CREDENTIAL_STORE_NOT_READ gap",
          "CREDENTIAL_STORE_NOT_READ" in rules, str(sorted(rules)))
    eq("...recorded as not scanned", rules.get("CREDENTIAL_STORE_NOT_READ") and
       rules["CREDENTIAL_STORE_NOT_READ"].verdict, "NOT_SCANNED")
    async with AsyncSessionLocal() as db:
        comp = await SecurityCenterService(db).compliance(acct.id, include_diff=False)
    check("an AWS account's compliance view offers CIS AWS and not CIS OCI",
          "CIS-AWS" in comp["frameworks"] and "CIS-OCI" not in comp["frameworks"],
          str(sorted(comp["frameworks"])))
    pci = next(x for x in comp["controls"] if x["framework"] == "PCI-DSS"
               and x["control_id"] == "4.2.1")
    check("PCI 4.2.1 is NOT a pass while a certificate store refused the listing",
          pci["state"] in ("PARTIAL", "UNKNOWN"), pci["state"])
    cis217 = next(x for x in comp["controls"] if x["framework"] == "CIS-AWS"
                  and x["control_id"] == "2.17")
    check("CIS AWS 2.17 (IAM certificates) is not claimed passed: IAM was never read",
          cis217["state"] != "PASS", cis217["state"])

    # The certificate drawer lists one object's findings with ?resource_key=.
    async with AsyncSessionLocal() as db:
        active = (await db.execute(select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == acct.id,
            CloudSecurityFinding.status.in_(["OPEN", "IN_PROGRESS"])))).scalars().all()
    by_key: dict = {}
    for f in active:
        if f.resource_key:
            by_key.setdefault(f.resource_key, set()).add(f.fingerprint)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        exact = bool(by_key)
        for key, fingerprints in by_key.items():
            r = await c.get(f"/api/v1/cloud/security-center/{acct.id}/findings",
                            params={"resource_key": key})
            got = {x["fingerprint"] for x in r.json().get("findings", [])}
            exact = exact and r.status_code == 200 and got == fingerprints
        check("findings?resource_key= returns exactly one object's findings, for every "
              "object with any", exact, f"{len(by_key)} object(s)")
        r = await c.get(f"/api/v1/cloud/security-center/{acct.id}/findings",
                        params={"resource_key": "zz-c_"})
        eq("...and matches exactly: as a LIKE pattern 'zz-c_' would match zz-c1..zz-c3",
           r.json().get("total"), 0)

    print("\n=== E. The alert condition counts the same store ===")
    from app.services.alerts import catalog, evaluators

    async with AsyncSessionLocal() as db:
        a = await db.get(CloudAccount, acct.id)
        ctx = evaluators.EvalContext(db, a)
        ev = await evaluators.evaluate(ctx, catalog.CREDENTIAL_EXPIRY,
                                       {"kind": "CERTIFICATE", "within_days": 30,
                                        "include_expired": "yes", "operator": "greater_than",
                                        "threshold": 0}, {})
        eq("certificates expiring within 30 days -> TRIGGERED", ev.state, "TRIGGERED")
        eq("...counting one", ev.observed, 1.0)
        check("...and says a store could not be read", "could not be read" in (ev.detail or ""),
              ev.detail)
        ctx = evaluators.EvalContext(db, a)
        ev = await evaluators.evaluate(ctx, catalog.CREDENTIAL_EXPIRY,
                                       {"kind": "CERTIFICATE", "within_days": 0,
                                        "include_expired": "yes", "operator": "greater_than",
                                        "threshold": 0}, {})
        eq("window 0 counts only what has already expired (none here)", ev.state,
           "NOT_TRIGGERED")
        fresh = await make_account("fresh", "OCI")
        ctx = evaluators.EvalContext(db, await db.get(CloudAccount, fresh.id))
        ev = await evaluators.evaluate(ctx, catalog.CREDENTIAL_EXPIRY, {"kind": "ANY",
                                       "within_days": 30, "include_expired": "yes",
                                       "operator": "greater_than", "threshold": 0}, {})
        eq("never collected -> UNSUPPORTED, not zero", ev.state, "UNSUPPORTED")
        await CredentialRepository(db).record_source(
            account_id=fresh.id, provider="OCI",
            result=scope_result("oci:certificates", "r1", COLLECT_PERMISSION_DENIED),
            item_count=0)
        await db.commit()
        ctx = evaluators.EvalContext(db, await db.get(CloudAccount, fresh.id))
        ev = await evaluators.evaluate(ctx, catalog.CREDENTIAL_EXPIRY, {"kind": "CERTIFICATE",
                                       "within_days": 30, "include_expired": "yes",
                                       "operator": "greater_than", "threshold": 0}, {})
        eq("every relevant store refused -> UNKNOWN, never NOT_TRIGGERED", ev.state, "UNKNOWN")

    print("\n=== F. The estate summary counts certificates ===")
    from app.services import estate_summary

    async with AsyncSessionLocal() as db:
        s = (await estate_summary.account_summaries(db, [acct.id]))[acct.id]["certificates"]
    eq("one expiring within 30 days", s["expiring_soon"], 1)
    eq("one failing source is counted", s["sources_failing"], 1)

    print("\n=== G. A manual assessment reads the sweep from the last FINISHED job ===")
    # "Run assessment" and the certificate re-check call assess() without the
    # sweep's state. It used to default to complete, so a manual run straight
    # after a partial sweep reported the whole inventory as read.
    from app.models.discovery_job import DiscoveryJob
    from app.services.security_center_service import SecurityCenterService

    sweep = {"provider": "AWS", "regions": 1, "services": 3, "attempted": 10, "read": 8,
             "unread": 2, "not_offered": {}, "failed": [],
             "denied": {"Redshift": {"regions": ["r1", "r2"],
                                     "observed_actions": ["redshift:DescribeClusters"],
                                     "actions": ["redshift:DescribeClusters"]}},
             "missing_permissions": ["redshift:DescribeClusters"], "regions_unknown": False}
    async with AsyncSessionLocal() as db:
        db.add(DiscoveryJob(account_id=acct.id, status="COMPLETED",
                            error_detail="Incomplete sweep: 8 of 10 scopes read",
                            started_at=NOW - timedelta(hours=1),
                            completed_at=NOW - timedelta(minutes=50), scope_summary=sweep))
        # A scan still running has read nothing yet: it must not be the one used.
        db.add(DiscoveryJob(account_id=acct.id, status="RUNNING", started_at=NOW))
        await db.commit()
    async with AsyncSessionLocal() as db:
        res = await SecurityCenterService(db).assess(acct.id, triggered_by="test",
                                                     evaluate_policies=False)
    inv = next(d for d in res["assessment"]["coverage"] if d["dimension"] == "inventory")
    eq("a manual assessment after a partial sweep is PARTIAL", res["outcome"], "PARTIAL")
    eq("...with inventory coverage from the sweep's own count (8 of 10)", inv["pct"], 80.0)
    check("...and its reasons say what was not read and why",
          any("8 of 10 scopes" in r and "Redshift" not in r for r in res["assessment"]
              ["incomplete_reasons"])
          and any("Redshift (2 regions)" in r for r in res["assessment"]["incomplete_reasons"]))

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get(f"/api/v1/cloud/security-center/{acct.id}/coverage")
    body = r.json()
    perms = body.get("permissions") or {}
    eq("coverage -> 200", r.status_code, 200)
    check("it lists inventory AND certificate-store permissions in one place",
          "redshift:DescribeClusters" in perms.get("missing", [])
          and "acm:ListCertificates" in perms.get("missing", [])
          and "acm:DescribeCertificate" in perms.get("missing", []), str(perms.get("missing")))
    check("...with the AWS policy that grants exactly them",
          (perms.get("aws_policy") or {}).get("Statement", [{}])[0].get("Action")
          == perms.get("missing"))
    eq("...and the sweep it came from", ((body.get("sweep") or {}).get("scope_summary")
                                         or {}).get("read"), 8)

    print("\n=== H. AWS/OCI identity data comes with the inventory; only Azure can fail it ===")
    # Every scan runs collect_identity, which leaves AWS and OCI a NotSupported
    # row ("needs no separate call"). Reading that row as their status put
    # "identity not collected" on the Overview beside 39 escalation paths
    # derived from the very data it said was missing, and a red "NotSupported,
    # 0 grants" on the Scan status card.
    az = await make_account("identity-az", "AZURE")
    async with AsyncSessionLocal() as db:
        svc = SecurityCenterService(db)
        await svc.collect_identity(acct.id)          # the scan's own step, for AWS
        await svc.identity.record_state(
            account_id=az.id, provider="AZURE", status="PermissionDenied",
            error_detail="AuthorizationFailed: roleAssignments/read",
            missing_permission="Microsoft.Authorization/roleAssignments/read")
        await db.commit()
    async with AsyncSessionLocal() as db:
        svc = SecurityCenterService(db)
        row = await svc.identity.state(acct.id)
        eq("the scan's identity step leaves AWS a NotSupported row", row.status if row else None,
           "NotSupported")
        ident = (await svc.overview(acct.id))["identity_summary"]
        eq("...which the Overview reads as collected", ident["collection_status"], "Collected")
        eq("...so the escalation tile is not captioned 'identity not collected'",
           ident["trustworthy"], True)
        eq("...and carries no error text", ident["error_detail"], None)
        eq("Coverage shows no identity-collection problem for AWS",
           (await svc.coverage(acct.id))["identity_collection"], None)
        review = await svc.identity_review(acct.id)
        eq("the Identity tab says Collected", review["collection_status"], "Collected")
        eq("...with no collection error", review["collection_error"], None)
        diag = (await svc.diagnostics(acct.id))["identity"]
        eq("the Scan status card says Collected", diag["status"], "Collected")
        check("...and counts the IAM roles it holds instead of '0 grants'",
              diag.get("note", "").endswith("read with the inventory")
              and diag.get("identities") == 0, str(diag))
        estate = {r["account_id"]: r for r in (await svc.multi_cloud())["accounts"]}
        eq("the all-accounts view says Collected for AWS",
           (estate.get(str(acct.id)) or {}).get("identity_collection"), "Collected")

        # Negative control: an Azure refusal must still show everywhere.
        ident_az = (await svc.overview(az.id))["identity_summary"]
        eq("an Azure refusal is still reported", ident_az["collection_status"], "PermissionDenied")
        eq("...as untrustworthy", ident_az["trustworthy"], False)
        eq("...naming the permission", ident_az["missing_permission"],
           "Microsoft.Authorization/roleAssignments/read")
        eq("...and Coverage shows it", ((await svc.coverage(az.id))["identity_collection"]
                                        or {}).get("status"), "PermissionDenied")
        eq("...and the Identity tab cannot be trusted", (await svc.identity_review(az.id))
           ["trustworthy"], False)
        eq("...and the Scan status card says so", (await svc.diagnostics(az.id))["identity"]
           ["status"], "PermissionDenied")
        eq("...and so does the all-accounts view",
           (estate.get(str(az.id)) or {}).get("identity_collection"), "PermissionDenied")

    print("\n=== I. The Scan status card's inventory row comes from the last sweep ===")
    # It said "Complete" whenever any resource was on file — beside an
    # inventory coverage of 80.1% on the same card.
    async with AsyncSessionLocal() as db:
        inv_row = (await SecurityCenterService(db).diagnostics(acct.id))["inventory"]
    eq("the sweep from G read 8 of 10 scopes: Partial, not Complete", inv_row["status"], "Partial")
    eq("...and the row says how much it read",
       (inv_row.get("scopes_read"), inv_row.get("scopes_attempted")), (8, 10))
    whole = await make_account("inventory-whole", "AWS")
    broke = await make_account("inventory-failed", "AWS")
    never = await make_account("inventory-never", "OCI")
    full = {**sweep, "read": 10, "unread": 0, "denied": {}, "missing_permissions": []}
    async with AsyncSessionLocal() as db:
        db.add(DiscoveryJob(account_id=whole.id, status="COMPLETED", scope_summary=full,
                            started_at=NOW - timedelta(hours=1),
                            completed_at=NOW - timedelta(minutes=50)))
        db.add(DiscoveryJob(account_id=broke.id, status="COMPLETED", scope_summary=full,
                            started_at=NOW - timedelta(hours=2),
                            completed_at=NOW - timedelta(hours=1, minutes=50)))
        db.add(DiscoveryJob(account_id=broke.id, status="FAILED",
                            error_detail="The security token is invalid",
                            started_at=NOW - timedelta(hours=1)))
        await db.commit()
    async with AsyncSessionLocal() as db:
        svc = SecurityCenterService(db)
        eq("a sweep that read every scope is Complete",
           (await svc.diagnostics(whole.id))["inventory"]["status"], "Complete")
        eq("a failed last sweep is Failed, even after an earlier complete one",
           (await svc.diagnostics(broke.id))["inventory"]["status"], "Failed")
        eq("no sweep and nothing on file says exactly that",
           (await svc.diagnostics(never.id))["inventory"]["status"], "No resources collected")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
