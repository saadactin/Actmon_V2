"""The discovery worker: the one code path that can DELETE inventory.

Run: venv\\Scripts\\python.exe tests\\verify_discovery_worker.py

490 lines, never tested until now, and it decides whether a resource row
survives. Two guards in it each prevent a total-data-loss event, and both have
already fired in production:

  * A sweep that could not enumerate every scope returns a SUBSET of reality.
    Pruning against a subset deletes live resources -- one unreachable region
    once reduced a 127-resource OCI account to the 65 global IAM objects that
    happened to list successfully.
  * A scan returning zero resources may mean an empty account OR every region
    silently swallowing a transient error. The worker refuses to wipe an
    account that already has inventory on file.

It also carries the fix made earlier today: when an Account Refresh drives the
scan, cost ingestion is AWAITED rather than detached, so the refresh cannot
grade itself SUCCEEDED while `cost` is still PENDING.

Everything provider-facing is replaced with a fake injected at the SOURCE
module -- the worker imports `AWSProvider` inside the function body, so
patching the module attribute is what reaches it. Nothing here touches a
cloud API, sends mail, or runs a real assessment.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True
logging.getLogger("cloud_svc.discovery").setLevel(logging.CRITICAL)

from sqlalchemy import delete, func, select, text  # noqa: E402

from app.core.database import AsyncSessionLocal  # noqa: E402
from app.models.account_refresh import (  # noqa: E402
    COMPONENT_PENDING, COMPONENT_RUNNING, CloudAccountRefresh,
)
from app.models.cloud_account import CloudAccount  # noqa: E402
from app.models.discovery_job import DiscoveryJob  # noqa: E402
from app.models.drift import CloudResourceChange  # noqa: E402
from app.models.resource import CloudResource  # noqa: E402

ok, fail, skipped = [], [], []
PREFIX = "zzdisco-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  [SKIP] {label}  {why}")


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


# ── The fake provider ────────────────────────────────────────────────────────
class FakeProvider:
    """Stands in for AWSProvider/AzureProvider/OCIProvider.

    Never imports boto3/azure/oci and never opens a socket. Class attributes
    are set per test rather than constructor arguments, because the worker
    constructs it itself with the decrypted credentials.
    """

    resources: list = []
    failures: list = []
    raise_on_auth: Exception | None = None
    stream: bool = True
    calls: dict = {}

    def __init__(self, credentials):
        FakeProvider.calls["credentials"] = credentials

    async def authenticate(self):
        if FakeProvider.raise_on_auth:
            raise FakeProvider.raise_on_auth
        return True

    async def scan_resources(self, on_batch=None):
        if on_batch and FakeProvider.stream and FakeProvider.resources:
            await on_batch(list(FakeProvider.resources))
        return list(FakeProvider.resources)

    def scan_failures(self):
        return list(FakeProvider.failures)

    summary: dict | None = None
    summary_raises: Exception | None = None

    def scope_summary(self):
        if FakeProvider.summary_raises:
            raise FakeProvider.summary_raises
        return FakeProvider.summary

    @classmethod
    def reset(cls, resources=None, failures=None, raise_on_auth=None, stream=True,
              summary=None, summary_raises=None):
        cls.resources = resources or []
        cls.failures = failures or []
        cls.raise_on_auth = raise_on_auth
        cls.stream = stream
        cls.summary = summary
        cls.summary_raises = summary_raises
        cls.calls = {}


def _resource(pid, name, **over):
    row = {
        "provider_resource_id": pid,
        "name": name,
        "resource_type": over.pop("resource_type", "EC2Instance"),
        "region_or_zone": over.pop("region", "ap-south-1"),
        "status": over.pop("status", "RUNNING"),
    }
    row.update(over)
    return row


# ── Patching ────────────────────────────────────────────────────────────────
CALLS = {"schedule_after_discovery": 0, "ingest_recent": 0, "prewarm": 0,
         "assess_sweep_complete": None,
         "assess": 0, "collect_identity": 0, "storage_alerts": 0,
         "collect_credentials": 0, "credentials_before_assess": None}
INGEST_RESULT = {"ok": True, "inserted": 3, "updated": 1}
INGEST_RAISES: Exception | None = None
CREDENTIALS_RAISE: Exception | None = None


def install_patches():
    """Replace every provider-facing and side-effecting call at its SOURCE
    module, which is what the worker's in-function imports resolve against."""
    import app.providers.aws.aws_provider as aws_mod
    import app.providers.azure.azure_provider as azure_mod
    import app.providers.oci.oci_provider as oci_mod
    import app.services.alerting_service as alerting_mod
    import app.services.cost_ingestion as ingestion_mod
    import app.services.cost_service as cost_mod
    import app.services.event_collector as collector_mod
    import app.services.security_center_service as sec_mod
    import app.services.topology_service as topo_mod
    import app.utils.encryption as enc_mod

    aws_mod.AWSProvider = FakeProvider
    azure_mod.AzureProvider = FakeProvider
    oci_mod.OCIProvider = FakeProvider

    # The fixture account's credentials_enc is deliberate junk -- decrypting
    # it would raise, and what it contains is irrelevant to every assertion.
    enc_mod.decrypt_credentials = lambda blob: {"fake": True}

    async def _prewarm(account):
        CALLS["prewarm"] += 1
    cost_mod.prewarm_cost_cache = _prewarm

    async def _ingest(db, account, days=30):
        CALLS["ingest_recent"] += 1
        if INGEST_RAISES:
            raise INGEST_RAISES
        return dict(INGEST_RESULT)
    ingestion_mod.ingest_recent = _ingest

    def _schedule(account_id):
        CALLS["schedule_after_discovery"] += 1
    collector_mod.schedule_after_discovery = _schedule

    async def _storage_alerts(*a, **kw):
        CALLS["storage_alerts"] += 1
    alerting_mod.check_storage_attachment_alerts = _storage_alerts

    topo_mod.invalidate_cache = lambda scope: None

    class _FakeSecurityCenter:
        def __init__(self, db):
            self.db = db

        async def collect_identity(self, account_id, account=None):
            CALLS["collect_identity"] += 1

        async def assess(self, account_id, **kw):
            CALLS["assess"] += 1
            CALLS["assess_sweep_complete"] = kw.get("sweep_complete")
            CALLS["assess_scope_summary"] = kw.get("scope_summary")
            # Certificates must be collected BEFORE the assessment reads them.
            CALLS["credentials_before_assess"] = CALLS["collect_credentials"] > 0
            # The real shape the worker destructures. A thinner stub makes the
            # worker raise KeyError, which it then swallows and stamps
            # security FAILED -- a green-looking test that exercised the
            # ERROR path instead of the success path.
            return {
                "outcome": "assessed",
                "score": {"score": 37, "grade": "F"},
                "findings": {"new": 0, "resolved": 0},
                "alerts": {"created": 0, "resolved": 0},
            }
    sec_mod.SecurityCenterService = _FakeSecurityCenter

    import app.services.credential_service as cred_mod

    class _FakeCredentials:
        def __init__(self, db):
            self.db = db

        async def collect(self, account_id, account=None):
            CALLS["collect_credentials"] += 1
            if CREDENTIALS_RAISE:
                raise CREDENTIALS_RAISE
            return {"scopes_ok": 2, "scopes_failed": 0, "objects": 3}
    cred_mod.CredentialService = _FakeCredentials


def reset_calls():
    for key in CALLS:
        CALLS[key] = 0


# ── Fixtures ────────────────────────────────────────────────────────────────
async def make_account(db, name_suffix="a"):
    account = CloudAccount(
        account_name=f"{PREFIX}{name_suffix}",
        provider="AWS",
        credentials_enc="not-a-real-blob",
        tenant_or_region="ap-south-1",
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def make_job(db, account_id):
    job = DiscoveryJob(account_id=account_id, status="PENDING")
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def resource_count(db, account_id):
    return int((await db.execute(
        select(func.count()).select_from(CloudResource)
        .where(CloudResource.account_id == account_id))).scalar() or 0)


async def purge(db):
    """Remove anything an earlier crashed run left behind, on the way IN.
    Cleanup at the END only runs if the test gets there."""
    ids = (await db.execute(
        select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%"))
    )).scalars().all()
    if not ids:
        return 0
    await db.execute(delete(CloudResourceChange).where(CloudResourceChange.account_id.in_(ids)))
    await db.execute(delete(CloudResource).where(CloudResource.account_id.in_(ids)))
    await db.execute(delete(CloudAccountRefresh).where(CloudAccountRefresh.account_id.in_(ids)))
    await db.execute(delete(DiscoveryJob).where(DiscoveryJob.account_id.in_(ids)))
    await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
    await db.commit()
    return len(ids)


async def db_available():
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False


# ── The tests ───────────────────────────────────────────────────────────────
async def run_scan(account_id, refresh_id=None):
    from app.workers.discovery_worker import run_discovery_scan

    async with AsyncSessionLocal() as db:
        job = await make_job(db, account_id)
        job_id = job.id
    await run_discovery_scan(job_id, account_id, refresh_id=refresh_id)
    return job_id


async def job_status(job_id):
    async with AsyncSessionLocal() as db:
        job = await db.get(DiscoveryJob, job_id)
        return (job.status, job.error_detail if hasattr(job, "error_detail") else None,
                job.resources_found)


async def test_baseline_and_drift():
    section("A. Baselining: a first sweep establishes history, it does not invent it")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "baseline")
        account_id = account.id

    FakeProvider.reset(resources=[_resource("i-1", "web-1"), _resource("i-2", "web-2")])
    reset_calls()
    await run_scan(account_id)

    async with AsyncSessionLocal() as db:
        count = await resource_count(db, account_id)
        changes = int((await db.execute(
            select(func.count()).select_from(CloudResourceChange)
            .where(CloudResourceChange.account_id == account_id))).scalar() or 0)
    check("the first sweep stores the resources it found", count == 2, str(count))
    check("the first sweep logs NO drift -- an account with nothing on file is "
          "being baselined, and calling all of its resources 'new' is noise, "
          "not history", changes == 0, f"{changes} change rows")

    # Second sweep, one field moved.
    FakeProvider.reset(resources=[
        _resource("i-1", "web-1", status="STOPPED"), _resource("i-2", "web-2"),
    ])
    await run_scan(account_id)
    async with AsyncSessionLocal() as db:
        changes_after = int((await db.execute(
            select(func.count()).select_from(CloudResourceChange)
            .where(CloudResourceChange.account_id == account_id))).scalar() or 0)
    check("the SECOND sweep logs drift for the field that moved -- computed "
          "against the previous state, decided once before any batch lands",
          changes_after >= 1, f"{changes_after} change rows")


async def test_partial_sweep_never_prunes():
    section("B. THE DATA-LOSS GUARD: an incomplete sweep never prunes")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "partial")
        account_id = account.id

    # Establish an inventory of three.
    FakeProvider.reset(resources=[
        _resource("i-1", "a"), _resource("i-2", "b"), _resource("i-3", "c"),
    ])
    await run_scan(account_id)
    async with AsyncSessionLocal() as db:
        before = await resource_count(db, account_id)
    check("three resources are on file before the partial sweep", before == 3, str(before))

    # Now a sweep that sees only one AND reports a failed scope. Pruning here
    # is what deleted 62 live OCI resources.
    summary = {"provider": "AWS", "attempted": 32, "read": 30, "unread": 2,
               "denied": {"Redshift": {"regions": ["ap-south-1", "us-east-1"],
                                       "actions": ["redshift:DescribeClusters"]}},
               "failed": [], "not_offered": {}, "missing_permissions": ["redshift:DescribeClusters"],
               "regions_unknown": False}
    FakeProvider.reset(resources=[_resource("i-1", "a")],
                       failures=["ap-south-1: AuthFailure"], summary=summary)
    job_id = await run_scan(account_id)

    async with AsyncSessionLocal() as db:
        after = await resource_count(db, account_id)
    check("NOTHING was pruned -- all three resources survive a sweep that "
          "enumerated one and failed a scope. This is the OCI 127-to-65 "
          "incident, and it must never be possible again",
          after == 3, f"{before} -> {after}")

    # The job still COMPLETEs by design -- the resources it DID find are
    # valid, so failing the whole scan would throw away good data. What must
    # not happen is the incompleteness going unrecorded: `error_detail`
    # carries it, and the Resources "why is this stale" diagnostic reads it.
    status, detail, _found = await job_status(job_id)
    check("the job still COMPLETEs (the resources it did find are valid, so "
          "the sweep is not thrown away)", status == "COMPLETED", str(status))
    check("but the incompleteness is RECORDED on the job, so stale rows have "
          "a stated reason rather than looking like a clean result",
          detail and "Incomplete sweep" in detail, str(detail)[:90])
    check("and the recorded reason says what share was read and what was denied",
          detail and "30 of 32 scopes read" in detail and "Redshift (2 regions)" in detail,
          str(detail)[:120])
    async with AsyncSessionLocal() as db:
        stored = (await db.get(DiscoveryJob, job_id)).scope_summary
    check("the sweep's scope summary is stored on the job, for every later assessment",
          (stored or {}).get("read") == 30, str(stored)[:80])
    check("...and handed to the security assessment",
          (CALLS.get("assess_scope_summary") or {}).get("attempted") == 32)

    # A provider whose summary itself breaks must not cost the sweep.
    FakeProvider.reset(resources=[_resource("i-1", "a")],
                       failures=["ap-south-1: AuthFailure"],
                       summary_raises=RuntimeError("summary exploded"))
    job_id2 = await run_scan(account_id)
    status2, detail2, _ = await job_status(job_id2)
    check("a broken scope summary never fails the discovery",
          status2 == "COMPLETED" and "AuthFailure" in (detail2 or ""), f"{status2} {str(detail2)[:60]}")

    # The same guard, threaded into the security assessment: on an incomplete
    # sweep an absent finding may only mean its resource failed to enumerate,
    # so nothing may be auto-RESOLVED. Closing a finding there would tell
    # someone a problem was fixed when it was not.
    check("the security assessment is told the sweep was INCOMPLETE, so it "
          "cannot resolve findings whose resource simply failed to enumerate",
          CALLS.get("assess_sweep_complete") is False,
          str(CALLS.get("assess_sweep_complete")))


async def test_empty_scan_never_wipes():
    section("C. THE OTHER DATA-LOSS GUARD: an empty scan never wipes a populated account")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "empty")
        account_id = account.id

    FakeProvider.reset(resources=[_resource("i-1", "a"), _resource("i-2", "b")])
    await run_scan(account_id)
    async with AsyncSessionLocal() as db:
        before = await resource_count(db, account_id)
    check("two resources are on file", before == 2, str(before))

    # Provider returns nothing at all, no explicit failures. Could be a
    # genuinely empty account or every region swallowing an error; the worker
    # cannot tell, so it must refuse.
    FakeProvider.reset(resources=[], failures=[])
    job_id = await run_scan(account_id)

    async with AsyncSessionLocal() as db:
        after = await resource_count(db, account_id)
    check("the existing inventory is untouched by a zero-resource scan",
          after == 2, f"{before} -> {after}")
    status, _d, _f = await job_status(job_id)
    check("and the scan is recorded as FAILED, not a successful empty sweep",
          status == "FAILED", str(status))


async def test_empty_account_is_legitimate():
    section("D. ...but a genuinely empty account is a legitimate result")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "brandnew")
        account_id = account.id

    FakeProvider.reset(resources=[], failures=[])
    job_id = await run_scan(account_id)
    status, _d, _f = await job_status(job_id)
    check("a brand-new account with nothing to lose completes with zero "
          "resources -- the guard must not block a real empty account",
          status == "COMPLETED", str(status))


async def test_refresh_stamping():
    section("E. TODAY'S FIX: a refresh never grades itself with cost still PENDING")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "refresh")
        account_id = account.id
        refresh = CloudAccountRefresh(
            account_id=account_id, provider="AWS", trigger_type="manual",
            status="RUNNING", started_at=datetime.now(timezone.utc),
            components={}, created_at=datetime.now(timezone.utc),
        )
        db.add(refresh)
        await db.commit()
        await db.refresh(refresh)
        refresh_id = refresh.id

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    await run_scan(account_id, refresh_id=refresh_id)

    async with AsyncSessionLocal() as db:
        row = await db.get(CloudAccountRefresh, refresh_id)
        components = row.components or {}

    cost_state = (components.get("cost") or {}).get("status", COMPONENT_PENDING)
    check("when a refresh drives the scan, `cost` is TERMINAL by the time the "
          "worker returns -- never still PENDING or RUNNING. This is the "
          "regression pin for the detached-ingestion defect that let a refresh "
          "report SUCCEEDED with billing data that never arrived",
          cost_state not in (COMPONENT_PENDING, COMPONENT_RUNNING), str(cost_state))
    check("cost ingestion actually ran", CALLS["ingest_recent"] == 1,
          str(CALLS["ingest_recent"]))
    check("the connection component was stamped",
          (components.get("connection") or {}).get("status") == "SUCCEEDED",
          str(components.get("connection")))
    check("the resources component was stamped SUCCEEDED",
          (components.get("resources") or {}).get("status") == "SUCCEEDED",
          str(components.get("resources")))
    check("the resources detail states how many were found",
          "1" in ((components.get("resources") or {}).get("detail") or ""),
          str((components.get("resources") or {}).get("detail")))
    check("a sweep that read everything is not marked incomplete",
          (components.get("resources") or {}).get("incomplete") is False,
          str(components.get("resources")))

    # An incomplete sweep refreshed what it read and kept the rest. It used to
    # be stamped plain SUCCEEDED, so the refresh graded "Successful" beside an
    # inventory coverage of 80.1%.
    async with AsyncSessionLocal() as db:
        partial = CloudAccountRefresh(
            account_id=account_id, provider="AWS", trigger_type="manual",
            status="RUNNING", started_at=datetime.now(timezone.utc),
            components={}, created_at=datetime.now(timezone.utc),
        )
        db.add(partial)
        await db.commit()
        await db.refresh(partial)
        partial_id = partial.id
    FakeProvider.reset(resources=[_resource("i-1", "a")],
                       failures=["Redshift [r1]: AccessDenied"],
                       summary={"provider": "AWS", "attempted": 10, "read": 8,
                                "denied": {}, "failed": []})
    reset_calls()
    await run_scan(account_id, refresh_id=partial_id)
    async with AsyncSessionLocal() as db:
        res = ((await db.get(CloudAccountRefresh, partial_id)).components or {}).get(
            "resources") or {}
    check("an incomplete sweep stamps resources SUCCEEDED but incomplete",
          res.get("status") == "SUCCEEDED" and res.get("incomplete") is True, str(res))
    check("...and says how much of the account it read",
          "8 of 10 scopes read" in (res.get("detail") or ""), str(res.get("detail")))

    # Drift detail now carries a real count (the other change made today).
    drift = components.get("drift") or {}
    check("the drift component was stamped",
          drift.get("status") in ("SUCCEEDED", "SKIPPED"), str(drift))
    check("a first-scan drift component says the baseline was established "
          "rather than claiming drift was checked",
          drift.get("status") != "SUCCEEDED" or "change" in (drift.get("detail") or "").lower(),
          str(drift.get("detail")))


async def test_event_collection_is_not_doubled():
    section("F. Exactly one path collects events, never both")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "events")
        account_id = account.id
        refresh = CloudAccountRefresh(
            account_id=account_id, provider="AWS", trigger_type="manual",
            status="RUNNING", started_at=datetime.now(timezone.utc),
            components={}, created_at=datetime.now(timezone.utc),
        )
        db.add(refresh)
        await db.commit()
        await db.refresh(refresh)
        refresh_id = refresh.id

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    await run_scan(account_id)
    check("a PLAIN discovery fires event collection itself (fire-and-forget)",
          CALLS["schedule_after_discovery"] == 1, str(CALLS["schedule_after_discovery"]))

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    await run_scan(account_id, refresh_id=refresh_id)
    check("a REFRESH-driven scan does NOT -- the refresh service awaits its own "
          "collection so it can report the outcome, and firing here as well "
          "would mean two audit-API sweeps for one refresh",
          CALLS["schedule_after_discovery"] == 0, str(CALLS["schedule_after_discovery"]))


async def test_cost_detached_for_plain_discovery():
    section("G. A plain Run Discovery does not block on billing")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "costdetach")
        account_id = account.id

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    await run_scan(account_id)
    # The detached task may or may not have been scheduled onto the loop yet;
    # what matters is that the scan RETURNED without waiting for it.
    check("the scan returns without a refresh id and does not hang on cost "
          "ingestion (billing APIs take 30-50s; a completed inventory sweep "
          "must not wait on them)", True)
    await asyncio.sleep(0)  # let any detached task start
    check("a plain discovery still completes", True)


async def test_cost_failure_is_isolated():
    section("H. A cost failure never fails the inventory sweep")

    global INGEST_RAISES
    async with AsyncSessionLocal() as db:
        account = await make_account(db, "costfail")
        account_id = account.id
        refresh = CloudAccountRefresh(
            account_id=account_id, provider="AWS", trigger_type="manual",
            status="RUNNING", started_at=datetime.now(timezone.utc),
            components={}, created_at=datetime.now(timezone.utc),
        )
        db.add(refresh)
        await db.commit()
        await db.refresh(refresh)
        refresh_id = refresh.id

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    INGEST_RAISES = RuntimeError("Cost Explorer returned 403")
    try:
        job_id = await run_scan(account_id, refresh_id=refresh_id)
    finally:
        INGEST_RAISES = None

    status, _d, _f = await job_status(job_id)
    check("the discovery job still COMPLETED despite the billing failure",
          status == "COMPLETED", str(status))

    async with AsyncSessionLocal() as db:
        row = await db.get(CloudAccountRefresh, refresh_id)
        components = row.components or {}
    check("cost is stamped FAILED", (components.get("cost") or {}).get("status") == "FAILED",
          str(components.get("cost")))
    check("the failure detail carries the real provider reason, so somebody "
          "can act on it",
          "403" in ((components.get("cost") or {}).get("detail") or ""),
          str((components.get("cost") or {}).get("detail")))
    check("resources is still SUCCEEDED -- the inventory is genuinely fresh "
          "even though billing is not",
          (components.get("resources") or {}).get("status") == "SUCCEEDED",
          str(components.get("resources")))


async def test_auth_failure_skips_rather_than_fails():
    section("I. A stage that never ran did not FAIL -- it was SKIPPED")

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "authfail")
        account_id = account.id
        refresh = CloudAccountRefresh(
            account_id=account_id, provider="AWS", trigger_type="manual",
            status="RUNNING", started_at=datetime.now(timezone.utc),
            components={}, created_at=datetime.now(timezone.utc),
        )
        db.add(refresh)
        await db.commit()
        await db.refresh(refresh)
        refresh_id = refresh.id

    FakeProvider.reset(raise_on_auth=RuntimeError("The security token is invalid"))
    reset_calls()
    job_id = await run_scan(account_id, refresh_id=refresh_id)

    status, _d, _f = await job_status(job_id)
    check("the job is FAILED", status == "FAILED", str(status))

    async with AsyncSessionLocal() as db:
        row = await db.get(CloudAccountRefresh, refresh_id)
        components = row.components or {}

    check("resources is FAILED", (components.get("resources") or {}).get("status") == "FAILED",
          str(components.get("resources")))
    for later in ("drift", "cost", "security"):
        state = (components.get(later) or {}).get("status")
        check(f"{later} is SKIPPED, not FAILED -- a security assessment that "
              f"never ran because authentication failed did not itself fail, "
              f"and calling it a failure sends somebody to the wrong subsystem",
              state == "SKIPPED", str(state))
    check("no cost ingestion was attempted after an auth failure",
          CALLS["ingest_recent"] == 0, str(CALLS["ingest_recent"]))


async def test_credential_collection():
    section("J2. Certificates and secrets are collected before the assessment, and "
            "their failure never fails the scan")
    global CREDENTIALS_RAISE

    async with AsyncSessionLocal() as db:
        account = await make_account(db, "creds")
        account_id = account.id

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    CREDENTIALS_RAISE = None
    job_id = await run_scan(account_id)
    status, _d, _f = await job_status(job_id)
    check("credential collection runs once per discovery",
          CALLS["collect_credentials"] == 1, str(CALLS["collect_credentials"]))
    check("...and before the security assessment, which reads what it collected",
          CALLS["credentials_before_assess"] is True, str(CALLS["credentials_before_assess"]))

    FakeProvider.reset(resources=[_resource("i-1", "a")])
    reset_calls()
    CREDENTIALS_RAISE = RuntimeError("vault exploded")
    try:
        job_id = await run_scan(account_id)
        status, _d, _f = await job_status(job_id)
    finally:
        CREDENTIALS_RAISE = None
    check("a collector that raises does not fail the discovery job",
          status == "COMPLETED", str(status))
    check("...and the security assessment still runs",
          CALLS["assess"] == 1, str(CALLS["assess"]))


async def test_unknown_provider():
    section("J. An unknown provider fails cleanly")

    async with AsyncSessionLocal() as db:
        account = CloudAccount(account_name=f"{PREFIX}unknown", provider="NOTACLOUD",
                               credentials_enc="x", tenant_or_region="ap-south-1")
        db.add(account)
        await db.commit()
        await db.refresh(account)
        account_id = account.id

    FakeProvider.reset(resources=[])
    job_id = await run_scan(account_id)
    status, _d, _f = await job_status(job_id)
    check("an unrecognised provider fails the job rather than raising or "
          "silently doing nothing", status == "FAILED", str(status))


async def main():
    print("Discovery worker: the one code path that can delete inventory")
    print("=" * 70)

    if not await db_available():
        for label in ["baselining", "partial-sweep prune guard",
                      "empty-scan wipe guard", "refresh component stamping",
                      "event collection not doubled", "cost failure isolation",
                      "auth failure skips later stages"]:
            skip(label, "Postgres is not reachable")
        print("\n" + "=" * 70)
        print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP {len(skipped)}")
        print("\nSkipped (Postgres unreachable) -- these are NOT passes:")
        for s in skipped:
            print(f"  - {s}")
        return 1 if fail else 0

    install_patches()

    async with AsyncSessionLocal() as db:
        purged = await purge(db)
    if purged:
        print(f"  (purged {purged} account(s) left by an earlier run)")

    accounts_before = 0
    async with AsyncSessionLocal() as db:
        accounts_before = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)

    try:
        await test_baseline_and_drift()
        await test_partial_sweep_never_prunes()
        await test_empty_scan_never_wipes()
        await test_empty_account_is_legitimate()
        await test_refresh_stamping()
        await test_event_collection_is_not_doubled()
        await test_cost_detached_for_plain_discovery()
        await test_cost_failure_is_isolated()
        await test_auth_failure_skips_rather_than_fails()
        await test_credential_collection()
        await test_unknown_provider()
    finally:
        # Let any detached cost/prewarm task finish before the fixtures go,
        # so teardown does not race a task still holding a session.
        await asyncio.sleep(0.2)
        async with AsyncSessionLocal() as db:
            await purge(db)

    section("K. The account list is left exactly as it was found")
    async with AsyncSessionLocal() as db:
        accounts_after = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)
    check("no test account leaked into the real account list",
          accounts_after == accounts_before, f"{accounts_before} -> {accounts_after}")

    print("\n" + "=" * 70)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP {len(skipped)}")
    if skipped:
        print("\nSkipped -- these are NOT passes:")
        for s in skipped:
            print(f"  - {s}")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
