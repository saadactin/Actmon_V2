"""Organisation onboarding: list an AWS organisation / Azure tenant, create one
account per chosen member. Postgres fixtures; provider calls are stubbed.

What must hold:

* **Discovery stores nothing and echoes no secret.**
* **A member already connected is recognised by the provider's own id** and
  never created twice — including an account added before provider ids existed.
* **A member is stored with the role to assume INTO it**; the account the keys
  belong to is stored without one.
* **One member failing never rolls back the others.**
* **No more than MAX_DISCOVERY_STARTS scans start at once.**
"""
import asyncio
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

logging.getLogger("sqlalchemy.engine").setLevel(logging.ERROR)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.ERROR)

from sqlalchemy import delete, select, text  # noqa: E402

from app.core import schema_patches  # noqa: E402
from app.core.database import AsyncSessionLocal, engine  # noqa: E402
from app.models.client import CloudClient  # noqa: E402
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.discovery_job import DiscoveryJob  # noqa: E402
from app.schemas.client import OnboardIn, OrgCredentialsIn  # noqa: E402
from app.services import onboarding_service as ob  # noqa: E402
from app.services.cloud_account_service import CloudAccountService  # noqa: E402
from app.utils.encryption import decrypt_credentials, encrypt_credentials  # noqa: E402

PREFIX = "zzonboard-test-"
SECRET = "zz-super-secret-value-9f3a"
ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


MGMT, M1, M2, M3, SUSP = "900000000001", "900000000002", "900000000003", "900000000004", \
    "900000000005"
AWS_LISTING = {
    "status": "Collected",
    "organization": {"id": "o-zztest", "management_account_id": MGMT},
    "caller": {"account_id": MGMT, "is_management_account": True},
    "members": [
        {"account_id": MGMT, "name": "mgmt", "state": "ACTIVE", "is_management_account": True,
         "is_caller_account": True,
         "access": {"can_access": True, "access_mode": "direct_keys"}},
        {"account_id": M1, "name": "prod", "state": "ACTIVE", "is_management_account": False,
         "is_caller_account": False, "access": {"can_access": True, "access_mode": "assume_role"}},
        {"account_id": M2, "name": "dev", "state": "ACTIVE", "is_management_account": False,
         "is_caller_account": False,
         "access": {"can_access": False, "detail": "AccessDenied assuming the role"}},
        {"account_id": M3, "name": "already", "state": "ACTIVE",
         "is_management_account": False, "is_caller_account": False,
         "access": {"can_access": True, "access_mode": "assume_role"}},
        {"account_id": SUSP, "name": "old", "state": "SUSPENDED",
         "is_management_account": False, "is_caller_account": False,
         "access": {"can_access": False}},
    ],
    "error": None,
}
VALIDATE_FAIL_FOR = set()


async def purge():
    async with AsyncSessionLocal() as db:
        ids = (await db.execute(select(CloudAccount.id).where(
            CloudAccount.account_name.like(f"{PREFIX}%")))).scalars().all()
        if ids:
            await db.execute(delete(DiscoveryJob).where(DiscoveryJob.account_id.in_(ids)))
            await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
            await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.execute(delete(CloudClient).where(CloudClient.name.like(f"{PREFIX}%")))
        await db.commit()
        return len(ids)


def install_stubs():
    import app.providers.aws.aws_organizations as org_mod
    import app.providers.azure.azure_tenant as tenant_mod

    def _list_members(credentials, *, role_name="OrganizationAccountAccessRole",
                      external_id=None, probe=True):
        return dict(AWS_LISTING, role_name=role_name,
                    members=[dict(m) for m in AWS_LISTING["members"]])
    org_mod.list_members = _list_members

    def _list_subs(creds, *, management_group_id=None, probe=True):
        return {"status": "Collected", "tenant_id": creds["tenant_id"],
                "management_groups": None, "management_group_error": "no MG read",
                "subscriptions": [
                    {"subscription_id": "aaaaaaaa-0000-0000-0000-00000000000a",
                     "display_name": "Prod", "state": "Enabled", "tenant_id": creds["tenant_id"],
                     "access": {"probed": True, "inventory": True, "cost": True,
                                "identity": True, "detail": None}},
                    {"subscription_id": "bbbbbbbb-0000-0000-0000-00000000000b",
                     "display_name": "Billing only", "state": "Enabled",
                     "tenant_id": creds["tenant_id"],
                     "access": {"probed": True, "inventory": False, "cost": True,
                                "identity": False,
                                "detail": "This principal cannot list resources here."}},
                ], "error": None}
    tenant_mod.list_subscriptions = _list_subs

    async def _validate(provider, credentials):
        key = credentials.get("role_arn") or credentials.get("subscription_id") or "direct"
        if any(k in key for k in VALIDATE_FAIL_FOR):
            raise ValueError("synthetic auth failure")
        if credentials.get("role_arn"):
            return credentials["role_arn"].split(":")[4]
        if provider.upper() == "AWS":
            return MGMT
        return credentials.get("subscription_id")
    CloudAccountService._validate_credentials = staticmethod(_validate)

    import app.services.discovery_service as disco
    disco._launch_scan = lambda job_id, account_id: STARTED.append(str(account_id))


STARTED = []


async def main() -> int:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        print(f"  [SKIP] Postgres is not reachable ({exc}); these are NOT passes")
        return 1
    await schema_patches.apply_standalone()
    await purge()
    install_stubs()
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
    # An account connected before provider ids existed: provider_account_id is
    # NULL, but its credentials name the account (a role ARN) — the backfill
    # must recognise it.
    async with AsyncSessionLocal() as db:
        db.add(CloudAccount(
            account_name=f"{PREFIX}legacy", provider="AWS", environment="Test",
            tenant_or_region="ap-south-1", auth_mode="AssumeRole", auto_discovery=False,
            credentials_enc=encrypt_credentials({
                "access_key_id": "AKIA", "secret_access_key": "x",
                "role_arn": f"arn:aws:iam::{M3}:role/OrganizationAccountAccessRole"})))
        client = CloudClient(name=f"{PREFIX}client")
        db.add(client)
        await db.commit()
        client_id = client.id

    creds = dict(provider="AWS", access_key_id="AKIAZZTEST", secret_access_key=SECRET,
                 region="ap-south-1", role_name="OrganizationAccountAccessRole")

    print("\n=== A. Discovery lists, probes and flags — and stores nothing ===")
    async with AsyncSessionLocal() as db:
        before = (await db.execute(select(CloudAccount.id))).scalars().all()
        out = await ob.OnboardingService(db).discover(OrgCredentialsIn(**creds))
        after = (await db.execute(select(CloudAccount.id))).scalars().all()
    eq("discovery creates no account", len(after), len(before))
    check("the secret key never appears in the response", SECRET not in str(out))
    by = {m["member_id"]: m for m in out["members"]}
    eq("the management account is selectable (read with the keys directly)",
       by[MGMT]["selectable"], True)
    eq("a member whose role cannot be assumed is NOT selectable", by[M2]["selectable"], False)
    check("...and says why", "AccessDenied" in (by[M2]["reason"] or ""), by[M2]["reason"])
    eq("a suspended member is not selectable", by[SUSP]["selectable"], False)
    check("a member already connected — even one added before provider ids existed — "
          "is recognised", by[M3]["already_connected"] is not None, str(by[M3]))
    eq("summary counts", out["summary"], {"total": 5, "selectable": 2, "already_connected": 1,
                                          "no_access": 2})

    print("\n=== B. Onboarding creates exactly what was chosen ===")
    VALIDATE_FAIL_FOR.clear()
    async with AsyncSessionLocal() as db:
        res = await ob.OnboardingService(db).onboard(OnboardIn(
            **creds, members=[MGMT, M1, M3, "000000000000"], target_client_id=client_id,
            name_prefix=PREFIX, environment="Production"), actor="tester")
    outcomes = {r["member_id"]: r["outcome"] for r in res["results"]}
    eq("created / skipped / not found per member", outcomes,
       {MGMT: "created", M1: "created", M3: "skipped", "000000000000": "not_found"})
    async with AsyncSessionLocal() as db:
        rows = {a.provider_account_id: a for a in (await db.execute(select(CloudAccount).where(
            CloudAccount.account_name.like(f"{PREFIX}%"),
            CloudAccount.onboarding_source.is_not(None)))).scalars().all()}
    m1 = rows.get(M1)
    check("the member account exists with its provider id", m1 is not None)
    c1 = decrypt_credentials(m1.credentials_enc) if m1 else {}
    eq("...stored with the role to assume INTO it", c1.get("role_arn"),
       f"arn:aws:iam::{M1}:role/OrganizationAccountAccessRole")
    eq("...auth mode AssumeRole", m1 and m1.auth_mode, "AssumeRole")
    eq("...assigned to the chosen client", m1 and m1.client_id, client_id)
    eq("...named with the prefix", m1 and m1.account_name, f"{PREFIX}prod")
    eq("...and records where it came from", m1 and m1.onboarding_source.get("kind"),
       "aws_organization")
    mg = rows.get(MGMT)
    check("the management account is stored WITHOUT a role",
          mg is not None and "role_arn" not in decrypt_credentials(mg.credentials_enc))

    print("\n=== C. One member failing never rolls back another ===")
    async with AsyncSessionLocal() as db:
        await db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
        await db.execute(delete(CloudAccount).where(CloudAccount.provider_account_id.in_(
            [MGMT, M1])))
        await db.commit()
    VALIDATE_FAIL_FOR.add(M1)
    async with AsyncSessionLocal() as db:
        res = await ob.OnboardingService(db).onboard(OnboardIn(
            **creds, members=[M1, MGMT], name_prefix=PREFIX), actor="tester")
    outcomes = {r["member_id"]: r["outcome"] for r in res["results"]}
    eq("the failing member is reported failed, the other still created", outcomes,
       {M1: "failed", MGMT: "created"})
    VALIDATE_FAIL_FOR.clear()

    print("\n=== D. Azure tenants ===")
    az = dict(provider="Azure", tenant_id="zz-tenant", client_id="zz-app",
              client_secret=SECRET)
    async with AsyncSessionLocal() as db:
        out = await ob.OnboardingService(db).discover(OrgCredentialsIn(**az))
    by = {m["member_id"]: m for m in out["members"]}
    eq("a subscription the principal can inventory is selectable",
       by["aaaaaaaa-0000-0000-0000-00000000000a"]["selectable"], True)
    eq("a billing-only subscription (would scan empty) is NOT selectable",
       by["bbbbbbbb-0000-0000-0000-00000000000b"]["selectable"], False)
    check("...and says so", "cannot list resources" in
          (by["bbbbbbbb-0000-0000-0000-00000000000b"]["reason"] or ""))
    check("the secret never appears in the response", SECRET not in str(out))
    async with AsyncSessionLocal() as db:
        res = await ob.OnboardingService(db).onboard(OnboardIn(
            **az, members=["AAAAAAAA-0000-0000-0000-00000000000A"], name_prefix=PREFIX),
            actor="tester")
    eq("members are matched case-insensitively", [r["outcome"] for r in res["results"]],
       ["created"])
    async with AsyncSessionLocal() as db:
        a = (await db.execute(select(CloudAccount).where(
            CloudAccount.provider_account_id == "aaaaaaaa-0000-0000-0000-00000000000a"))
             ).scalar_one_or_none()
    eq("the Azure account stores the tenant as tenant_or_region", a and a.tenant_or_region,
       "zz-tenant")
    eq("...and the subscription in its credentials",
       a and decrypt_credentials(a.credentials_enc)["subscription_id"],
       "aaaaaaaa-0000-0000-0000-00000000000a")

    print("\n=== E. Guard rails ===")
    async with AsyncSessionLocal() as db:
        try:
            await ob.OnboardingService(db).discover(OrgCredentialsIn(provider="OCI"))
            refused = False
        except ob.OnboardingError as exc:
            refused = "compartment" in str(exc)
    check("OCI is refused with the reason (a tenancy is already one account)", refused)
    async with AsyncSessionLocal() as db:
        try:
            await ob.OnboardingService(db).discover(OrgCredentialsIn(provider="AWS"))
            refused = False
        except ob.OnboardingError:
            refused = True
    check("missing keys are refused before any call", refused)

    # Seven more members -> discovery starts for at most five.
    extra = [{"account_id": f"91000000000{i}", "name": f"m{i}", "state": "ACTIVE",
              "is_management_account": False, "is_caller_account": False,
              "access": {"can_access": True, "access_mode": "assume_role"}} for i in range(7)]
    AWS_LISTING["members"].extend(extra)
    STARTED.clear()
    async with AsyncSessionLocal() as db:
        res = await ob.OnboardingService(db).onboard(OnboardIn(
            **creds, members=[m["account_id"] for m in extra], name_prefix=PREFIX,
            start_discovery=True), actor="tester")
    eq("seven created", res["summary"]["created"], 7)
    eq(f"...discovery started for at most {ob.MAX_DISCOVERY_STARTS}", len(STARTED),
       ob.MAX_DISCOVERY_STARTS)
    eq("...and the rest are counted, with a note", res["discovery_not_started"], 2)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
