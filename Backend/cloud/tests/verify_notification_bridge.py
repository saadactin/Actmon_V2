"""The notification bridge: which channels an alert is queued to, and what
the queued payload is allowed to contain.

Run: venv\\Scripts\\python.exe tests\\verify_notification_bridge.py

**This suite must never cause an email to be sent, and it is built so it
cannot.** Three layers, because the risk here is not theoretical -- the cloud
service has no dispatcher of its own, it INSERTs into `notification_queue`,
and the database service polls that table every 10 seconds. A row left behind
by a test is a message a different process sends minutes later, after this
process has exited.

  1. It refuses to run if the environment is unsafe. If any notification
     channel is enabled, or the queue is not empty, the whole section SKIPs
     with a stated reason rather than proceeding. A skip here is the correct
     outcome, not a gap.
  2. It never commits. `queue_notifications_for_alert` executes INSERTs on the
     CALLER's session and does not commit -- that property is itself asserted
     below, because it is what makes everything else safe. Every test rolls
     back, and a fresh session then confirms zero rows survived.
  3. Every row it creates is identifiable by content (a sentinel Organization
     in the payload), so teardown can find them even if an insert failed
     halfway.

What it pins beyond that:

  * The 5-severity to 3-bucket collapse, including that an UNKNOWN severity
    fails TOWARD notifying rather than silently dropping the alert.
  * A channel that is routed but disabled queues NOTHING -- otherwise every
    alert becomes three failed delivery attempts, forever.
  * Email is dropped only when the account has no recipients, and an alert
    with no account never borrows another account's addresses.
  * No payload ever carries a credential, a channel secret or an encryption
    key.
  * Metric/CurrentValue/Threshold are EMPTY strings, not "0" -- a cloud alert
    has no metric value, and rendering 0 in an email states one.
"""
import asyncio
import json
import logging
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True
logging.getLogger("cloud_svc.notification_bridge").setLevel(logging.CRITICAL)

from sqlalchemy import text  # noqa: E402

from app.core.database import AsyncSessionLocal  # noqa: E402
from app.services import notification_bridge as bridge  # noqa: E402

ok, fail, skipped = [], [], []
SENTINEL_ORG = "zznotif-test-ActMon Cloud"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  [SKIP] {label}  {why}")


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


class FakeAlert:
    """The attributes the bridge reads. A real CloudAlert would do, but it
    would also need an account row and a rule row for no benefit -- the bridge
    only ever reads these fields off it."""

    def __init__(self, severity="CRITICAL", account_id=None, **over):
        self.id = over.pop("id", uuid.uuid4())
        self.severity = severity
        self.account_id = account_id
        self.anomaly_type = over.pop("anomaly_type", "zznotif_test_condition")
        self.details = over.pop("details", "A test condition was observed.")
        self.resource_name = over.pop("resource_name", "i-0123456789")
        self.resource_type = over.pop("resource_type", "EC2Instance")
        self.last_seen_at = over.pop("last_seen_at", None)
        self.created_at = over.pop("created_at", None)
        for key, value in over.items():
            setattr(self, key, value)


# ── Pure: the severity collapse ─────────────────────────────────────────────
def test_routing_bucket():
    section("A. The 5-severity to 3-bucket collapse")

    expected = {
        "CRITICAL": "critical", "HIGH": "critical",
        "MEDIUM": "warning",
        "LOW": "information", "INFO": "information",
    }
    for severity, bucket in expected.items():
        check(f"{severity} routes to the {bucket} bucket",
              bridge._routing_bucket(severity) == bucket,
              bridge._routing_bucket(severity))

    check("routing is case-insensitive",
          bridge._routing_bucket("critical") == "critical")

    # Failing toward notifying is the safe direction: a severity nobody
    # mapped should still reach someone, not vanish.
    check("an UNKNOWN severity falls back to 'warning' -- it still notifies "
          "somebody rather than silently dropping the alert",
          bridge._routing_bucket("NOT_A_SEVERITY") == "warning",
          bridge._routing_bucket("NOT_A_SEVERITY"))
    check("an empty severity also falls back to warning, not to nothing",
          bridge._routing_bucket("") == "warning")
    check("a None severity does not raise and falls back to warning",
          bridge._routing_bucket(None) == "warning")

    # Every severity the ENGINE can produce must have an explicit mapping --
    # imported rather than restated, so a severity added to the engine and not
    # here shows up as a failure instead of falling through to the default.
    from app.models.alert_rule import SEVERITIES

    unmapped = [s for s in SEVERITIES if s.upper() not in bridge._ROUTING_BUCKET]
    check("every severity the alert engine defines has an EXPLICIT bucket, "
          "not just the fallback",
          not unmapped, f"unmapped: {unmapped}")


def test_context():
    section("B. The rendered context: unavailable is blank, never zero")

    alert = FakeAlert(severity="HIGH")
    context = bridge._build_context(alert=alert, account_name="zz-account")

    # A cloud alert has no metric reading. Rendering "0" in the email body
    # states that the metric WAS zero, which is a different and false claim.
    for field in ("Metric", "CurrentValue", "Threshold", "IPAddress", "Error"):
        value = context.get(field)
        check(f"{field} is an EMPTY string -- a cloud alert has no such "
              f"reading, and '0' in an email would state that it was zero",
              value == "", repr(value))

    check("the alert's own description is carried", context["AlertDescription"] == alert.details)
    check("the account name is carried", context["ServerName"] == "zz-account")
    check("the severity is title-cased for display", context["Severity"] == "High",
          context["Severity"])
    check("the anomaly type is humanised rather than shown raw",
          "_" not in context["AlertName"], context["AlertName"])
    check("a missing account name renders an em dash, not 'None'",
          bridge._build_context(alert=alert, account_name=None)["ServerName"] == "—")
    check("a missing timestamp renders empty rather than 'None'",
          bridge._build_context(alert=FakeAlert(), account_name="x")["Timestamp"] == "")


# ── DB-backed, and only when the environment is safe ───────────────────────
async def environment_is_safe(db):
    """Returns (safe, reason). Refuses rather than risks a real send."""
    try:
        enabled = (await db.execute(text(
            "SELECT channel_type FROM notification_channels WHERE enabled IS true"
        ))).scalars().all()
    except Exception as exc:  # noqa: BLE001
        return False, f"could not read notification_channels: {exc}"
    if enabled:
        return False, (f"{len(enabled)} notification channel(s) are ENABLED "
                       f"({', '.join(enabled)}). Refusing to queue anything: the "
                       f"database service polls notification_queue every 10s and "
                       f"would dispatch it. Disable channels before running this suite.")

    pending = (await db.execute(text(
        "SELECT COUNT(*) FROM notification_queue"
    ))).scalar() or 0
    if pending:
        return False, (f"notification_queue already holds {pending} row(s). "
                       f"Refusing to add to a queue that is about to be drained.")
    return True, ""


async def queued_rows(db):
    """Rows this suite created, found by the sentinel in their payload.

    Matched on ServerName, not Organization: `_build_context` hardcodes
    Organization to "ActMon Cloud" for every alert, so it identifies nothing.
    The account name -- which this suite always sets to SENTINEL_ORG -- is
    what lands in ServerName and is therefore the only content-based handle
    on rows this suite created.
    """
    return (await db.execute(text(
        "SELECT channel_type, payload FROM notification_queue "
        "WHERE payload->'context'->>'ServerName' = :org"
    ), {"org": SENTINEL_ORG})).all()


async def make_account(db, suffix):
    """A real cloud_accounts row. cloud_alert_recipients.account_id carries a
    FK to it, so a bare random UUID would be refused. Created inside the
    caller's uncommitted transaction like everything else here."""
    account_id = uuid.uuid4()
    await db.execute(text(
        "INSERT INTO cloud_accounts (id, account_name, provider, environment, "
        " tenant_or_region, auth_mode, auto_discovery, credentials_enc, "
        " created_at, updated_at) "
        "VALUES (:id, :name, 'AWS', 'Production', 'ap-south-1', 'API_Keys', "
        "        false, 'x', now(), now())"
    ), {"id": str(account_id), "name": f"zznotif-test-{suffix}"})
    return account_id


async def add_recipient(db, account_id, email, *, kind="to", enabled=True):
    """cloud_alert_recipients.id is a PYTHON-side uuid4 default, so a raw SQL
    insert has to supply it -- the column is NOT NULL with no server default."""
    await db.execute(text(
        "INSERT INTO cloud_alert_recipients (id, account_id, email, kind, enabled, "
        " created_at) VALUES (:id, :acc, :email, :kind, :enabled, now())"
    ), {"id": str(uuid.uuid4()), "acc": str(account_id), "email": email,
        "kind": kind, "enabled": enabled})


async def setup_routing(db, *, bucket, channels, enabled_channels):
    """Create routing + channel rows INSIDE the caller's uncommitted
    transaction. org_id is hardcoded to 1 in the bridge, so these cannot be
    isolated by org -- the rollback discipline is what keeps them contained."""
    for channel in set(channels) | set(enabled_channels):
        await db.execute(text(
            "INSERT INTO notification_channels (org_id, channel_type, enabled, config) "
            "VALUES (:org, :ch, :en, '{}'::jsonb) "
            "ON CONFLICT (org_id, channel_type) DO UPDATE SET enabled = :en"
        ), {"org": bridge.ORG_ID, "ch": channel, "en": channel in enabled_channels})
    for channel in channels:
        await db.execute(text(
            "INSERT INTO severity_channel_routing (org_id, severity, channel_type, enabled) "
            "VALUES (:org, :sev, :ch, true) "
            "ON CONFLICT (org_id, severity, channel_type) DO UPDATE SET enabled = true"
        ), {"org": bridge.ORG_ID, "sev": bucket, "ch": channel})


async def test_db():
    section("C. Queueing, routing and payload safety (needs Postgres)")

    labels = ["does not commit", "a disabled channel queues nothing",
              "email without recipients is dropped", "account isolation",
              "no secrets in the payload", "naive timestamps"]

    try:
        async with AsyncSessionLocal() as db:
            safe, reason = await environment_is_safe(db)
    except Exception as exc:  # noqa: BLE001
        for label in labels:
            skip(label, f"Postgres unreachable: {exc}")
        return

    if not safe:
        for label in labels:
            skip(label, reason)
        return

    # ---- The load-bearing property: the bridge does not commit -------------
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="critical", channels=["slack"],
                                enabled_channels=["slack"])
            alert = FakeAlert(severity="CRITICAL", account_id=uuid.uuid4())
            queued = await bridge.queue_notifications_for_alert(
                db, alert, account_name=SENTINEL_ORG)
            rows = await queued_rows(db)
            check("a routed, enabled channel queues exactly one row",
                  queued == 1 and len(rows) == 1, f"queued={queued} rows={len(rows)}")
            check("and it is the channel that was routed",
                  rows and rows[0][0] == "slack", str(rows[0][0]) if rows else "none")
        finally:
            await db.rollback()

    async with AsyncSessionLocal() as fresh:
        rows = await queued_rows(fresh)
        check("after a rollback a FRESH session sees ZERO rows -- proving "
              "queue_notifications_for_alert does not commit. If someone adds "
              "a commit inside it, this fails, and a fire-and-forget caller "
              "would start leaking real queued messages",
              len(rows) == 0, f"{len(rows)} row(s) survived")

    # ---- A routed but DISABLED channel queues nothing ---------------------
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="critical", channels=["slack"],
                                enabled_channels=[])
            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=uuid.uuid4()),
                account_name=SENTINEL_ORG)
            rows = await queued_rows(db)
            check("a channel that routing wants but which is DISABLED queues "
                  "nothing -- queueing it would produce three failed delivery "
                  "attempts per alert, forever",
                  queued == 0 and len(rows) == 0, f"queued={queued} rows={len(rows)}")
        finally:
            await db.rollback()

    # ---- Bucket selection actually filters --------------------------------
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="warning", channels=["slack"],
                                enabled_channels=["slack"])
            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=uuid.uuid4()),
                account_name=SENTINEL_ORG)
            check("routing configured for a DIFFERENT bucket does not fire -- "
                  "a CRITICAL alert does not pick up warning-bucket routing",
                  queued == 0, str(queued))
        finally:
            await db.rollback()

    # ---- Email: dropped without recipients, scoped when present -----------
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="critical", channels=["email"],
                                enabled_channels=["email"])
            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=uuid.uuid4()),
                account_name=SENTINEL_ORG)
            check("email is DROPPED when the account has no enabled recipients, "
                  "and with no other channel routed nothing is queued at all",
                  queued == 0, str(queued))
        finally:
            await db.rollback()

    async with AsyncSessionLocal() as db:
        try:
            account_a = await make_account(db, "acct-a")
            account_b = await make_account(db, "acct-b")
            await setup_routing(db, bucket="critical", channels=["email"],
                                enabled_channels=["email"])
            await add_recipient(db, account_a, "a@zznotif-test.invalid")
            await add_recipient(db, account_b, "b@zznotif-test.invalid")

            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=account_a),
                account_name=SENTINEL_ORG)
            rows = await queued_rows(db)
            payload = json.loads(rows[0][1]) if rows and isinstance(rows[0][1], str) else (
                rows[0][1] if rows else {})
            recipients = payload.get("recipients_override") or []
            check("email queues once the account HAS a recipient", queued == 1, str(queued))
            check("the payload carries the recipient list explicitly",
                  recipients == ["a@zznotif-test.invalid"], str(recipients))
            check("account B's address is NOT included -- an alert on one "
                  "account must never be mailed to another account's owners",
                  "b@zznotif-test.invalid" not in recipients, str(recipients))
        finally:
            await db.rollback()

    # ---- An alert with no account never borrows someone else's addresses --
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="critical", channels=["email", "slack"],
                                enabled_channels=["email", "slack"])
            other = await make_account(db, "other")
            await add_recipient(db, other, "someone@zznotif-test.invalid")

            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=None),
                account_name=SENTINEL_ORG)
            rows = await queued_rows(db)
            channels = [r[0] for r in rows]
            check("a tenancy-wide alert (no account) drops EMAIL -- it has no "
                  "account, so it has no recipients, and borrowing another "
                  "account's would be a cross-account disclosure",
                  "email" not in channels, str(channels))
            check("but its non-email channels are still queued",
                  "slack" in channels, str(channels))
        finally:
            await db.rollback()

    # ---- Disabled / cc recipients do not count ---------------------------
    async with AsyncSessionLocal() as db:
        try:
            account = await make_account(db, "filtered")
            await setup_routing(db, bucket="critical", channels=["email"],
                                enabled_channels=["email"])
            await add_recipient(db, account, "off@zznotif-test.invalid", enabled=False)
            await add_recipient(db, account, "cc@zznotif-test.invalid", kind="cc")
            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=account),
                account_name=SENTINEL_ORG)
            check("a DISABLED recipient and a cc-only recipient do not make an "
                  "account 'has recipients' -- the query filters on enabled "
                  "AND kind='to'", queued == 0, str(queued))
        finally:
            await db.rollback()

    # ---- No secrets in any payload ---------------------------------------
    async with AsyncSessionLocal() as db:
        try:
            account = await make_account(db, "secrets")
            secret = "zzsupersecrettokenvalue"
            await setup_routing(db, bucket="critical", channels=["slack"],
                                enabled_channels=["slack"])
            # Give the channel a config and a secret blob. Neither may reach
            # the queue payload -- the dispatcher re-reads them itself.
            await db.execute(text(
                "UPDATE notification_channels SET config = CAST(:cfg AS JSONB), "
                "secrets_enc = :sec WHERE org_id = :org AND channel_type = 'slack'"
            ), {"cfg": json.dumps({"webhook": f"https://hooks.invalid/{secret}"}),
                "sec": secret, "org": bridge.ORG_ID})

            await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=account),
                account_name=SENTINEL_ORG)
            rows = await queued_rows(db)
            blob = json.dumps([r[1] if not isinstance(r[1], str) else json.loads(r[1])
                               for r in rows])
            check("no queued payload contains the channel's secret",
                  secret not in blob, "secret leaked into the payload")
            check("no queued payload contains a webhook URL",
                  "hooks.invalid" not in blob)
            for pattern in ("password", "api_key", "credentials_enc", "FERNET",
                            "secrets_enc"):
                check(f"no queued payload contains {pattern!r}",
                      pattern.lower() not in blob.lower(), pattern)
        finally:
            await db.rollback()

    # ---- Naive timestamps, as the DB-side columns require ----------------
    async with AsyncSessionLocal() as db:
        try:
            await setup_routing(db, bucket="critical", channels=["slack"],
                                enabled_channels=["slack"])
            await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL", account_id=uuid.uuid4()),
                account_name=SENTINEL_ORG)
            row = (await db.execute(text(
                "SELECT next_attempt_at, created_at FROM notification_queue "
                "WHERE payload->'context'->>'ServerName' = :org LIMIT 1"
            ), {"org": SENTINEL_ORG})).first()
            check("next_attempt_at and created_at are stored NAIVE -- the "
                  "database service's columns are naive, and a tz-aware bind "
                  "makes asyncpg refuse the insert outright",
                  row is not None and row[0].tzinfo is None and row[1].tzinfo is None,
                  str(row))
        finally:
            await db.rollback()

    # ---- Fails soft, but leaves evidence ---------------------------------
    section("D. A broken notification config never breaks alerting")

    async with AsyncSessionLocal() as db:
        try:
            original = db.execute
            calls = {"logged": False}

            async def boom(*a, **kw):
                raise RuntimeError("severity_channel_routing does not exist")
            db.execute = boom

            queued = await bridge.queue_notifications_for_alert(
                db, FakeAlert(severity="CRITICAL"), account_name=SENTINEL_ORG)
            db.execute = original
            check("a failure inside the bridge returns 0 rather than raising -- "
                  "a broken notification config must not stop an alert being "
                  "RECORDED", queued == 0, str(queued))
        except Exception as exc:  # noqa: BLE001
            check("a failure inside the bridge does not propagate", False, str(exc))
        finally:
            await db.rollback()

    # ---- Final safety audit ----------------------------------------------
    section("E. The queue is left exactly as it was found")

    async with AsyncSessionLocal() as db:
        rows = await queued_rows(db)
        check("this suite left NOTHING in notification_queue", len(rows) == 0,
              f"{len(rows)} row(s) remain -- the database service would send these")
        total = (await db.execute(text("SELECT COUNT(*) FROM notification_queue"))).scalar() or 0
        check("and the queue as a whole is still empty", total == 0, f"{total} row(s)")
        enabled = (await db.execute(text(
            "SELECT COUNT(*) FROM notification_channels WHERE enabled IS true"
        ))).scalar() or 0
        check("no notification channel was left ENABLED by this suite",
              enabled == 0, f"{enabled} channel(s) enabled")


async def main():
    print("Notification bridge: what gets queued, and what the payload may contain")
    print("=" * 74)
    test_routing_bucket()
    test_context()
    await test_db()

    print("\n" + "=" * 74)
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
