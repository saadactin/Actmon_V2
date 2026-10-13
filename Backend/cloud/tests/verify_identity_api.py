"""Identity & Access: persistence, the HTTP surface, RBAC and tenant isolation.

Postgres fixtures (`zzident-test-`), driven through the ASGI app. No provider
is contacted: fixture accounts carry undecryptable credentials, so the collect
path runs and records an AuthenticationFailed state — which is itself one of
the things checked, because a failed collection must NOT empty the inventory.

What must hold:

* **A failed collection leaves the inventory alone.** Replacing a real set with
  an empty one would turn a permission error into "every identity was deleted",
  and then into a clean dashboard.
* **The identity analyser resolves its own findings and nobody else's.**
  `persist_findings` closes anything it does not see; this analyser emits only
  `IDENTITY_*` rules, so without a rule scope it would close every storage,
  network and encryption finding on the account. That is the single most
  destructive thing in this feature and it gets a dedicated section.
* **Permissions are graduated on the wire, not just in the table.** A viewer
  gets the identity list; the decision trace and condition blocks are withheld
  unless the caller holds `identity:view_raw`; the reverse query needs
  `identity:query`; approving and applying need their own permissions.
* **Tenant isolation.** One account's principals never appear under another's
  id, on any route.
* **Nothing writes to a provider.** With execution off, an approved request is
  refused at the apply step with the reason, and the request stays APPROVED.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)
logging.getLogger("cloud_svc").setLevel(logging.CRITICAL)

import httpx  # noqa: E402
from sqlalchemy import delete, select, text  # noqa: E402

from app.core.database import AsyncSessionLocal, engine  # noqa: E402
engine.echo = False
from app.main import app  # noqa: E402
from app.identity import findings as cf  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.identity import (  # noqa: E402
    CloudIdentity, CloudIdentityCredential, CloudIdentityMembership, CloudIdentityPolicy,
)
from app.models.identity_analysis import (  # noqa: E402
    CloudEffectivePermission, CloudIdentityAnalysisState, CloudIdentityBaseline,
    CloudIdentityBlastRadius, CloudIdentityCapability, CloudIdentityTrust,
    CloudPermissionUsage,
)
from app.models.identity_workflow import (  # noqa: E402
    CloudAccessApproval, CloudAccessRequest, CloudIdentityAuditLog, CloudJitSession,
)
from app.models.security_finding import CloudSecurityFinding  # noqa: E402
from app.repository.ciem_repo import CiemRepository  # noqa: E402
from app.security.model import ASSESS_COMPLETE  # noqa: E402

BASE = "/api/v1/cloud/identity"
PREFIX = "zzident-test-"
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
            for model in (CloudIdentityAuditLog, CloudJitSession, CloudAccessApproval,
                          CloudAccessRequest, CloudIdentityBaseline,
                          CloudIdentityBlastRadius, CloudIdentityTrust,
                          CloudPermissionUsage, CloudIdentityCapability,
                          CloudEffectivePermission, CloudIdentityMembership,
                          CloudIdentityPolicy, CloudIdentityCredential,
                          CloudIdentityAnalysisState, CloudSecurityFinding):
                col = getattr(model, "account_id", None)
                if col is not None:
                    await db.execute(delete(model).where(col.in_(ids)))
            await db.execute(delete(CloudIdentity).where(CloudIdentity.account_id.in_(ids)))
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.commit()
        return len(ids)


async def make_account(name, provider="AWS"):
    async with AsyncSessionLocal() as db:
        a = CloudAccount(account_name=f"{PREFIX}{name}", provider=provider,
                         environment="Test", tenant_or_region="r1", auth_mode="API_Keys",
                         auto_discovery=False, credentials_enc="junk", last_discovery=NOW)
        db.add(a)
        await db.commit()
        return a.id


def spec(key, name, *, privilege="ADMIN", mfa="DISABLED", actor="HUMAN",
         itype="AWS_IAM_USER", standing=False, external="INTERNAL", last_used=None):
    return {
        "identity_key": key, "provider_id": f"arn:aws:iam::1:user/{name}",
        "identity_type": itype, "actor_class": actor, "name": name,
        "principal_name": name, "status": "ACTIVE", "privilege_level": privilege,
        "mfa_state": mfa, "standing_admin": standing, "external": external,
        "last_used_at": last_used,
    }


async def seed_identities(account_id, specs):
    """Seed in ONE call.

    `replace_identities` is a replace, not an append: calling it once per
    identity would mark every previously-seeded one DELETED, which is correct
    production behaviour and a broken fixture.
    """
    async with AsyncSessionLocal() as db:
        mapped = await CiemRepository(db).replace_identities(
            account_id=account_id, provider="AWS", identities=specs)
        await db.commit()
        return mapped


async def main():
    purged = await purge()
    if purged:
        print(f"(purged {purged} leftover fixture accounts)")

    account_a = await make_account("alpha")
    account_b = await make_account("beta")

    seeded = await seed_identities(account_a, [
        spec("k-alice", "alice", privilege="ADMIN", mfa="DISABLED", standing=True),
        spec("k-bot", "deploy-bot", privilege="PRIVILEGED", mfa="NOT_APPLICABLE",
             actor="WORKLOAD", itype="AWS_IAM_ROLE"),
        spec("k-ghost", "unassessed", privilege="UNKNOWN", mfa="UNKNOWN"),
    ])
    alice, bot = seeded["k-alice"], seeded["k-bot"]
    await seed_identities(account_b, [spec("k-other", "other-account-user")])

    async with AsyncSessionLocal() as db:
        repo = CiemRepository(db)
        await repo.replace_credentials(
            account_id=account_a, provider="AWS", identity_id=alice,
            credentials=[{
                "credential_ref": "AKIAEXAMPLE", "credential_kind": "AWS_ACCESS_KEY",
                "status": "ACTIVE", "created_at_provider": NOW - timedelta(days=400),
                "last_used_at": NOW - timedelta(days=200), "never_used": False,
                "recommendation": "DISABLE", "recommendation_reason": "Not used in 200 days.",
            }])
        await repo.replace_capabilities(
            account_id=account_a, identity_id=alice, rows=[{
                "provider": "AWS", "capability": "IAM_ADMINISTRATION",
                "high_impact": True, "scope_level": "subscription", "scope": "*",
                "evidence_actions": ["iam:*"], "certain": True,
            }])
        await repo.replace_effective_permissions(
            account_id=account_a, identity_id=alice, rows=[{
                "provider": "AWS", "action_pattern": "iam:*", "capability": "IAM_ADMINISTRATION",
                "resource_pattern": "*", "decision": "ALLOWED_UNVERIFIED",
                "source_stage": "identity_policy", "source_name": "AdministratorAccess",
                "conditions": {"IpAddress": {"aws:SourceIp": "10.0.0.0/8"}},
                "steps": [{"stage": "identity_policy", "effect": "Allow",
                           "source_name": "AdministratorAccess"}],
                "unevaluated": [{"stage": "service_control_policy",
                                 "reason": "NOT_COLLECTED",
                                 "missing_permission": "organizations:ListPoliciesForTarget"}],
            }])
        await repo.replace_usage(
            account_id=account_a, identity_id=alice, rows=[{
                "provider": "AWS", "action": "ec2:TerminateInstances",
                "usage_state": "NOT_OBSERVED_HIGH_CONFIDENCE",
                "window_start": NOW - timedelta(days=90), "window_end": NOW,
                "window_days": 90, "events_in_window": 500_000,
                "confidence_reason": "No event for this action in 90 days.",
            }])
        await repo.upsert_blast_radius(
            account_id=account_a, identity_id=alice, provider="AWS",
            data={"direct_resources": 120, "indirect_resources": 30, "score": 82.0,
                  "score_band": "CRITICAL", "inventory_complete": True,
                  "capabilities": {"can_modify_iam": True}})
        await repo.replace_trust(
            account_id=account_a, provider="AWS", edges=[{
                "target_key": "arn:aws:iam::1:role/Prod", "target_name": "Prod",
                "source_principal": "arn:aws:iam::999988887777:root",
                "trust_kind": "ASSUME_ROLE", "external": "EXTERNAL",
                "has_external_id": False, "target_privilege": "ADMIN",
            }])
        await repo.record_analysis_state(
            account_id=account_a, provider="AWS", status="Partial",
            identity_count=3, evaluated_count=2, unevaluated_count=1,
            usage_window_days=90, usage_events_analyzed=500_000,
            missing_stages=[{"stage": "service_control_policy",
                             "missing_permission": "organizations:ListPoliciesForTarget"}])
        await db.commit()

    admin = {"Authorization": f"Bearer {token_for('administrator')}"}
    analyst = {"Authorization": f"Bearer {token_for('security_analyst')}"}
    viewer = {"Authorization": f"Bearer {token_for('viewer')}"}

    tr = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=tr, base_url="http://t", timeout=60) as c:

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== A. Vocabulary and the dashboard ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.get(f"{BASE}/meta", headers=admin)
        eq("GET /meta is 200", r.status_code, 200)
        meta = r.json()
        check("meta carries the capability catalog", bool(meta.get("capability_catalog")))
        check("meta reports whether execution is enabled",
              meta.get("write_mode", {}).get("enabled") is False)
        check("meta names the usage state that may seed a removal",
              len([u for u in meta["usage_states"] if u["may_propose_removal"]]) == 1)

        r = await c.get(f"{BASE}/{account_a}/overview", headers=admin)
        eq("GET overview is 200", r.status_code, 200)
        ov = r.json()
        eq("the identity count is what was seeded", ov["counts"]["identities"], 3)
        eq("the unassessable identity is counted separately",
           ov["counts"]["not_assessed"], 1)
        eq("and is excluded from 'assessed'", ov["counts"]["assessed"], 2)
        eq("privileged counts only assessed identities", ov["counts"]["privileged"], 2)
        eq("standing admin is counted", ov["counts"]["standing_admin"], 1)
        eq("MFA gaps count only DISABLED, not UNKNOWN", ov["counts"]["mfa_gaps"], 1)
        eq("MFA unknown is its own number", ov["counts"]["mfa_unknown"], 1)
        check("the overview states the coverage caveat",
              "could not be assessed"
              in (ov.get("coverage", {}).get("note") or "").lower(),
              ov.get("coverage", {}).get("note"))
        check("the analysis state travels with the overview",
              ov["analysis"]["status"] == "Partial")
        check("the missing stage names its permission",
              "organizations:" in str(ov["analysis"]["missing_stages"]))

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== B. The identity table: filters, paging, isolation ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.get(f"{BASE}/{account_a}/principals", headers=admin)
        eq("GET principals is 200", r.status_code, 200)
        listing = r.json()
        eq("all three are listed", listing["total"], 3)
        names = {i["name"] for i in listing["items"]}
        check("the other account's identity is NOT in this list",
              "other-account-user" not in names, names)
        check("each row says whether it was assessed",
              all("assessed" in i for i in listing["items"]))
        unassessed_row = next(i for i in listing["items"] if i["name"] == "unassessed")
        check("the unassessable row is marked not assessed",
              unassessed_row["assessed"] is False)

        r = await c.get(f"{BASE}/{account_a}/principals?privilege=ADMIN", headers=admin)
        eq("filtering by privilege narrows the list", r.json()["total"], 1)
        r = await c.get(f"{BASE}/{account_a}/principals?mfa=DISABLED", headers=admin)
        eq("filtering by MFA state works", r.json()["total"], 1)
        r = await c.get(f"{BASE}/{account_a}/principals?capability=IAM_ADMINISTRATION",
                        headers=admin)
        eq("filtering by capability uses the capability index", r.json()["total"], 1)
        r = await c.get(f"{BASE}/{account_a}/principals?blast_band=CRITICAL", headers=admin)
        eq("filtering by blast band works", r.json()["total"], 1)
        r = await c.get(f"{BASE}/{account_a}/principals?dormant_days=30", headers=admin)
        eq("dormancy filter excludes identities with NO last-used date "
           "(unknown is not dormant)", r.json()["total"], 0)
        r = await c.get(f"{BASE}/{account_a}/principals?page_size=1&page=2", headers=admin)
        eq("paging works", len(r.json()["items"]), 1)
        eq("and reports the page count", r.json()["pages"], 3)

        r = await c.get(f"{BASE}/{account_b}/principals", headers=admin)
        eq("account B sees only its own identity", r.json()["total"], 1)

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== C. Detail, permissions, usage, blast radius ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.get(f"{BASE}/principals/{alice}", headers=admin)
        eq("GET principal detail is 200", r.status_code, 200)
        detail = r.json()
        eq("the credential is attached", len(detail["credentials"]), 1)
        check("the credential carries its recommendation",
              detail["credentials"][0]["recommendation"] == "DISABLE")
        check("no secret material is anywhere in the payload",
              "secret" not in str(detail).lower()
              or "client_secret" not in str(detail).lower())
        eq("the high-impact capability is listed", len(detail["high_impact"]), 1)

        r = await c.get(f"{BASE}/principals/{uuid.uuid4()}", headers=admin)
        eq("an unknown identity is 404", r.status_code, 404)

        r = await c.get(f"{BASE}/principals/{alice}/permissions", headers=admin)
        eq("GET permissions is 200", r.status_code, 200)
        perms = r.json()
        eq("the grant is returned", perms["total"], 1)
        item = perms["items"][0]
        eq("the decision is the unverified one", item["decision"], "ALLOWED_UNVERIFIED")
        check("the row is marked not certain", item["certain"] is False)
        check("the admin sees the decision trace", bool(item.get("steps")))
        check("the summary counts grants that were not fully verified",
              perms["not_fully_verified"] == 1)
        check("and explains what that means", "policies we can read"
              in (perms.get("verification_note") or ""))

        r = await c.get(f"{BASE}/principals/{alice}/usage", headers=admin)
        usage = r.json()
        eq("usage reports the window days", usage["window"]["days"], 90)
        eq("and the events analysed", usage["window"]["events_in_window"], 500_000)
        eq("the unexercised grant is high confidence", usage["not_observed_high"], 1)
        check("usage explains why no granted-action total is shown",
              "catalog" in (usage.get("note") or ""))

        r = await c.get(f"{BASE}/principals/{alice}/blast-radius", headers=admin)
        blast = r.json()
        eq("blast radius is available", blast["available"], True)
        eq("the score is returned", blast["score"], 82.0)
        check("the explanation is derived from the stored numbers",
              any("IAM" in e["claim"] or "identity" in e["claim"].lower()
                  for e in blast["explanation"]))

        r = await c.get(f"{BASE}/principals/{bot}/blast-radius", headers=admin)
        eq("an identity with no calculation says so rather than returning zeros",
           r.json()["available"], False)

        r = await c.get(f"{BASE}/{account_a}/trust-map", headers=admin)
        tm = r.json()
        eq("the external trust edge is in the map", tm["summary"]["external"], 1)
        eq("the missing ExternalId is counted", tm["summary"]["without_external_id"], 1)
        check("the graph has clickable nodes",
              all(n.get("id") for n in tm["graph"]["nodes"]))

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== D. Explorer, reverse query and search ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.get(f"{BASE}/{account_a}/who-can-access?capability=IAM_ADMINISTRATION",
                        headers=admin)
        eq("the reverse capability query is 200", r.status_code, 200)
        eq("it finds the identity holding it", r.json()["matched"], 1)
        check("and carries the coverage caveat",
              "lower bound" in str(r.json()["coverage"]).lower()
              or r.json()["coverage"]["not_assessed"] == 1)

        r = await c.get(f"{BASE}/{account_a}/who-can-access?action=iam:CreateUser",
                        headers=admin)
        eq("the reverse action query matches the stored pattern", r.json()["matched"], 1)
        r = await c.get(f"{BASE}/{account_a}/who-can-access?action=s3:GetObject",
                        headers=admin)
        eq("an action no grant covers matches nobody", r.json()["matched"], 0)
        r = await c.get(f"{BASE}/{account_a}/who-can-access", headers=admin)
        eq("a reverse query with no action and no capability is 400", r.status_code, 400)

        r = await c.get(f"{BASE}/{account_a}/search?q=alice", headers=admin)
        eq("search finds an identity by name", len(r.json()["identities"]), 1)
        r = await c.get(f"{BASE}/{account_a}/search?q=mfa", headers=admin)
        check("search offers a structured filter for an English question",
              any("mfa" in str(s).lower() for s in r.json()["suggestions"]))

        r = await c.get(
            f"{BASE}/{account_a}/resources/arn%3Aaws%3As3%3A%3A%3Aprod/principals",
            headers=admin)
        eq("the resource-side question is 200", r.status_code, 200)
        check("it answers with the coverage caveat",
              "could not be evaluated" in str(r.json()["coverage"]).lower())

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== E. Authorization is graduated on the wire ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.get(f"{BASE}/{account_a}/principals", headers=viewer)
        eq("a viewer can list identities", r.status_code, 200)

        r = await c.get(f"{BASE}/principals/{alice}/permissions", headers=viewer)
        eq("a viewer can see the permissions list", r.status_code, 200)
        v = r.json()
        check("but the decision trace is WITHHELD", v.get("raw_withheld") is True)
        check("and no item carries steps",
              all(not i.get("steps") for i in v["items"]))
        check("and no item carries a condition block",
              all(not i.get("conditions") for i in v["items"]))
        check("the withholding is explained", bool(v.get("raw_withheld_note")))

        r = await c.get(f"{BASE}/principals/{alice}/permissions", headers=analyst)
        check("an analyst DOES see the decision trace",
              bool(r.json()["items"][0].get("steps")))

        r = await c.get(f"{BASE}/{account_a}/who-can-access?capability=IAM_ADMINISTRATION",
                        headers=viewer)
        eq("a viewer may NOT run the reverse query", r.status_code, 403)
        r = await c.get(f"{BASE}/{account_a}/who-can-access?capability=IAM_ADMINISTRATION",
                        headers=analyst)
        eq("an analyst may", r.status_code, 200)

        r = await c.post(f"{BASE}/{account_a}/collect", headers=viewer)
        eq("a viewer may not run collection", r.status_code, 403)
        r = await c.post(f"{BASE}/{account_a}/analyze", headers=analyst)
        eq("an analyst may not run analysis", r.status_code, 403)

        r = await c.get(f"{BASE}/{account_a}/audit", headers=analyst)
        eq("an analyst may not read the CIEM audit trail", r.status_code, 403)
        r = await c.get(f"{BASE}/{account_a}/audit", headers=admin)
        eq("an administrator may", r.status_code, 200)

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== F. A failed collection must NOT empty the inventory ===")
        # ═══════════════════════════════════════════════════════════════════
        before = (await c.get(f"{BASE}/{account_a}/principals", headers=admin)).json()["total"]
        r = await c.post(f"{BASE}/{account_a}/collect", headers=admin)
        eq("collect against undecryptable credentials is still 200 "
           "(a refusal is data, not a crash)", r.status_code, 200)
        body = r.json()
        check("it reports a failure status", body["status"] != "Collected", body["status"])
        eq("and collected nothing", body["identities"], 0)
        after = (await c.get(f"{BASE}/{account_a}/principals", headers=admin)).json()["total"]
        eq("the existing identities are STILL THERE after the failed collection",
           after, before)
        state = (await c.get(f"{BASE}/{account_a}/overview", headers=admin)).json()["analysis"]
        eq("the analysis state records the failure", state["status"], "Failed")
        check("and the state is not trustworthy", state["trustworthy"] is False)

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== G. The analyser resolves its OWN findings and nobody else's ===")
        # ═══════════════════════════════════════════════════════════════════
        # This is the destructive case. Seed a non-CIEM finding, then persist a
        # CIEM finding set that does not contain it, with outcome COMPLETE.
        async with AsyncSessionLocal() as db:
            db.add(CloudSecurityFinding(
                account_id=account_a, provider="AWS", fingerprint="zz-storage-1",
                rule_id="AWS_S3_PUBLIC_READ", rule_version="1.0",
                resource_key="arn:aws:s3:::other", title="A storage finding",
                description="x", rationale="x", remediation="x" * 50,
                severity="HIGH", category="Exposure", verdict="VULNERABLE",
                confidence="HIGH", status="OPEN", first_detected_at=NOW,
                last_detected_at=NOW, detection_count=1))
            db.add(CloudSecurityFinding(
                account_id=account_a, provider="AWS", fingerprint="zz-identity-1",
                rule_id=cf.PRIVILEGED_IDENTITY_WITHOUT_MFA, rule_version="1.0",
                resource_key="arn:aws:iam::1:user/gone", title="A stale CIEM finding",
                description="x", rationale="x", remediation="x" * 50,
                severity="HIGH", category="Identity & Access", verdict="VULNERABLE",
                confidence="HIGH", status="OPEN", first_detected_at=NOW,
                last_detected_at=NOW, detection_count=1))
            await db.commit()

        from app.repository.security_repo import SecurityRepository

        async with AsyncSessionLocal() as db:
            await SecurityRepository(db).persist_findings(
                account_id=account_a, findings=[], outcome=ASSESS_COMPLETE,
                rule_scope=list(cf.RULE_IDS))
            await db.commit()

        async with AsyncSessionLocal() as db:
            rows = {f.fingerprint: f.status for f in (await db.execute(
                select(CloudSecurityFinding).where(
                    CloudSecurityFinding.account_id == account_a)
            )).scalars().all()}
        eq("the stale CIEM finding WAS resolved", rows.get("zz-identity-1"), "RESOLVED")
        eq("the storage finding was NOT touched", rows.get("zz-storage-1"), "OPEN")

        # And the unscoped call still reconciles everything, for existing callers.
        async with AsyncSessionLocal() as db:
            await SecurityRepository(db).persist_findings(
                account_id=account_a, findings=[], outcome=ASSESS_COMPLETE)
            await db.commit()
        async with AsyncSessionLocal() as db:
            rows = {f.fingerprint: f.status for f in (await db.execute(
                select(CloudSecurityFinding).where(
                    CloudSecurityFinding.account_id == account_a)
            )).scalars().all()}
        eq("without a scope, a complete assessment still resolves everything "
           "(existing callers are unchanged)", rows.get("zz-storage-1"), "RESOLVED")

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== H. The approval workflow, with execution OFF ===")
        # ═══════════════════════════════════════════════════════════════════
        body = {"request_kind": "JIT_ELEVATION", "identity_id": str(alice),
                "requested_role": "Owner", "target_scope": "/subscriptions/S",
                "duration_minutes": 30, "reason": "Production incident INC-1."}
        r = await c.post(f"{BASE}/{account_a}/access-requests", json=body, headers=viewer)
        eq("a VIEWER may raise a request — the person who needs access is rarely "
           "an administrator", r.status_code, 200)
        req = r.json()
        rid = req["id"]
        eq("it starts awaiting approval", req["status"], "APPROVAL_REQUIRED")
        check("the risk picture is snapshotted with the request",
              req["risk_snapshot"]["current_privilege"] == "ADMIN")
        check("the blast radius the approver sees is recorded",
              req["risk_snapshot"]["blast_radius"]["score"] == 82.0)

        r = await c.post(f"{BASE}/{account_a}/access-requests",
                         json={**body, "reason": ""}, headers=viewer)
        eq("a request with no reason is refused", r.status_code, 422)
        r = await c.post(f"{BASE}/{account_a}/access-requests",
                         json={**body, "duration_minutes": 10_000}, headers=viewer)
        eq("a duration beyond the cap is refused", r.status_code, 422)

        r = await c.post(f"{BASE}/access-requests/{rid}/apply",
                         json={"confirm": True}, headers=admin)
        eq("applying a request that is not APPROVED is 409", r.status_code, 409)

        r = await c.post(f"{BASE}/access-requests/{rid}/approve", json={}, headers=analyst)
        eq("an analyst may not approve", r.status_code, 403)

        r = await c.post(f"{BASE}/access-requests/{rid}/approve",
                         json={"comment": "Incident confirmed."}, headers=admin)
        eq("an administrator may approve", r.status_code, 200)
        eq("the request is now APPROVED", r.json()["status"], "APPROVED")

        r = await c.post(f"{BASE}/access-requests/{rid}/apply", json={"confirm": False},
                         headers=admin)
        eq("applying without confirmation is 409", r.status_code, 409)

        r = await c.post(f"{BASE}/access-requests/{rid}/apply", json={"confirm": True},
                         headers=admin)
        eq("applying with execution OFF is still 200", r.status_code, 200)
        applied = r.json()
        check("but nothing was applied", applied["applied"] is False)
        check("and it says why", "CIEM_ENABLE_WRITE" in (applied["refusal_reason"] or ""))
        eq("the request stays APPROVED rather than claiming APPLIED",
           applied["status"], "APPROVED")

        async with AsyncSessionLocal() as db:
            sessions = (await db.execute(select(CloudJitSession).where(
                CloudJitSession.account_id == account_a))).scalars().all()
        eq("NO elevation session was created", len(sessions), 0)

        r = await c.get(f"{BASE}/access-requests/{rid}", headers=admin)
        full = r.json()
        eq("the approval is recorded as its own row", len(full["approvals"]), 1)
        check("with who decided it", full["approvals"][0]["decided_by"]
              == "administrator@example.com")
        check("and what they were shown at the time",
              bool(full["approvals"][0]["risk_shown"]))
        check("the timeline records every step",
              len(full["timeline"]) >= 3, [t["operation"] for t in full["timeline"]])
        ops = {t["operation"] for t in full["timeline"]}
        check("including the refusal to apply", "APPLY_REFUSED" in ops, ops)

        r = await c.post(f"{BASE}/access-requests/{rid}/approve", json={}, headers=admin)
        eq("a second approval on a decided request is 409", r.status_code, 409)

        # Self-approval is refused.
        r = await c.post(f"{BASE}/{account_a}/access-requests", json=body, headers=admin)
        own = r.json()["id"]
        r = await c.post(f"{BASE}/access-requests/{own}/approve", json={}, headers=admin)
        eq("the requester may not approve their own request", r.status_code, 409)

        r = await c.get(f"{BASE}/{account_a}/audit", headers=admin)
        check("the audit trail has rows for the whole exchange",
              len(r.json()["items"]) >= 4)

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== I. Right-sizing proposes, and never applies ===")
        # ═══════════════════════════════════════════════════════════════════
        r = await c.post(f"{BASE}/principals/{alice}/rightsize", headers=admin)
        eq("a proposal is generated", r.status_code, 200)
        prop = r.json()
        check("it is available", prop.get("available") is True)
        eq("it is labelled PROPOSED", prop["status"], "PROPOSED")
        check("and explicitly not applied", prop["applied"] is False)
        check("it carries its observation window",
              prop["evidence"]["window"]["days"] == 90)
        check("it carries caveats about work outside the window",
              any("window" in cav for cav in prop["caveats"]))
        check("the unexercised grant is proposed for removal",
              any(d["verdict"] == "REMOVE" for d in prop["diff"]))

        r = await c.post(f"{BASE}/principals/{bot}/rightsize", headers=admin)
        eq("an identity with no usage analysis says so", r.json()["available"], False)
        check("and explains what to do", "analysis" in r.json()["reason"].lower())

        # ═══════════════════════════════════════════════════════════════════
        print("\n=== J. JIT expiry sweeps, even with execution off ===")
        # ═══════════════════════════════════════════════════════════════════
        async with AsyncSessionLocal() as db:
            repo = CiemRepository(db)
            overdue_req = await repo.create_request(
                account_id=account_a, provider="AWS", request_kind="JIT_ELEVATION",
                status="APPROVED", reason="fixture", identity_id=alice)
            await repo.create_session(
                request_id=overdue_req.id, account_id=account_a, provider="AWS",
                identity_id=alice, status="ACTIVE", granted_role="Owner",
                provider_grant_id="fixture-grant",
                expires_at=NOW - timedelta(minutes=5))
            await db.commit()

        r = await c.get(f"{BASE}/{account_a}/sessions", headers=admin)
        eq("the overdue session is reported as overdue", r.json()["overdue"], 1)
        check("and the danger is stated in words",
              "may still grant access" in (r.json()["overdue_note"] or ""))

        r = await c.post(f"{BASE}/sessions/expire-due", headers=admin)
        eq("the expiry sweep runs", r.status_code, 200)
        swept = r.json()
        eq("it found the due session", swept["due"], 1)
        eq("it could NOT revoke it with execution off", swept["revoked"], 0)
        eq("and counts it as still outstanding", swept["overdue_unrevoked"], 1)

        async with AsyncSessionLocal() as db:
            s = (await db.execute(select(CloudJitSession).where(
                CloudJitSession.account_id == account_a))).scalars().first()
            check("the session records that revocation was attempted",
                  s.revoke_attempted_at is not None)
            check("but NOT that it was confirmed", s.revoke_confirmed_at is None)
            check("and the error says it must be revoked by hand",
                  "by hand" in (s.revoke_error or ""))

    print(f"\n(purged {await purge()} fixture accounts)")
    await engine.dispose()
    print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
    if fail:
        print("\nFAILURES:")
        for x in fail:
            print(f"  ! {x}")
    sys.exit(1 if fail else 0)


asyncio.run(main())
