"""Alert rules, evaluation safety, deduplication, cooldown and notification.

Run: venv\\Scripts\\python.exe tests\\verify_alert_rules.py

The assertions here are not about whether the feature works in the happy case.
They guard the decisions that are expensive to get wrong and cheap to break:

  A  catalog/evaluator parity — a condition the UI can offer that the engine
     cannot answer is a rule that sits at UNKNOWN forever.
  B  validation refuses a rule the engine cannot evaluate, rather than storing
     it and failing every five minutes.
  C  UNKNOWN is never zero, and never resolves an open alert. This is the one
     that turns a monitoring system into a liar: a throttled billing API must
     not read as "spend went down", and a missing assessment must not read as
     "no findings".
  D  fingerprints are stable across evaluations and distinct across rules,
     resources and conditions — the difference between one alert and 288.
  E  cooldown suppresses repeat mail without touching the alert's lifecycle.
  F  account isolation: a rule id from another account is a 404, not that rule.
  G  nothing sensitive reaches an email body or an API response.

Sections A, B, D, E and G are pure logic and always run. The rest need
Postgres; they skip loudly rather than silently if it is not up, because a
suite that reports "all passed" having checked nothing is worse than a failure.

Creates and removes its own account, rules, recipients and alert rows.
"""
import asyncio
import logging
import pathlib
import sys
import uuid
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from app.models.alert_rule import (
    EVAL_ERROR, EVAL_INCONCLUSIVE, EVAL_NOT_TRIGGERED, EVAL_TRIGGERED,
    EVAL_UNKNOWN, EVAL_UNSUPPORTED, CloudAlertRule,
)
from app.services.alerts import catalog, engine, evaluators, notifier, result, templates

ok, fail, skipped = [], [], []
PREFIX = "zzalert-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  [SKIP] {label}  {why}")


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


# ── A. Catalog / evaluator parity ─────────────────────────────────────────────
def test_catalog():
    section("A. Catalog and evaluator parity")

    check("every catalog condition has an evaluator",
          set(catalog.CONDITIONS) == set(evaluators.EVALUATORS),
          f"{len(catalog.CONDITIONS)} conditions")

    payload = catalog.catalog_payload()
    listed = {c["key"] for cat in payload["categories"] for c in cat["conditions"]}
    check("every condition is reachable from the capabilities payload",
          listed == set(catalog.CONDITIONS),
          f"{len(listed)} listed")

    # A condition whose category is not a real category would render into a
    # tab that does not exist.
    bad_category = [c.key for c in catalog.CONDITIONS.values()
                    if c.category not in catalog.CATEGORY_LABELS]
    check("every condition belongs to a known category", not bad_category,
          str(bad_category))

    # Every condition must produce a readable sentence from its own defaults.
    unreadable = []
    for key, cond in catalog.CONDITIONS.items():
        cfg = {f.key: f.default for f in cond.fields if f.default is not None}
        cfg.setdefault("threshold", 1)
        cfg.setdefault("currency", "USD")
        sentence = catalog.describe(key, cfg, {}, "acct")
        if not sentence or "None" in sentence or sentence == cond.summary:
            unreadable.append(key)
    check("every condition renders a human sentence", not unreadable,
          str(unreadable))

    # Scope narrowing must be declared, or the builder can offer a filter the
    # evaluator silently ignores.
    check("every condition declares its scope support",
          set(catalog.SCOPE_SUPPORT) == set(catalog.CONDITIONS))


# ── B. Validation ─────────────────────────────────────────────────────────────
def test_validation():
    section("B. Validation refuses what the engine cannot answer")

    try:
        catalog.get("nonsense_condition")
        check("an unknown condition type is refused", False)
    except catalog.ValidationError as exc:
        check("an unknown condition type is refused",
              "condition_type" in exc.errors)

    try:
        catalog.validate(catalog.COST_THRESHOLD,
                         {"period": "month_to_date", "threshold": 100,
                          "currency": "US DOLLARS"})
        check("a bad currency code is refused", False)
    except catalog.ValidationError as exc:
        check("a bad currency code is refused", "currency" in exc.errors,
              exc.errors.get("currency", "")[:60])

    try:
        catalog.validate(catalog.SECURITY_FINDING_COUNT,
                         {"severity_filter": "SEVERE", "operator": "greater_than",
                          "threshold": 0})
        check("a severity outside the vocabulary is refused", False)
    except catalog.ValidationError as exc:
        check("a severity outside the vocabulary is refused",
              "severity_filter" in exc.errors)

    try:
        catalog.validate(catalog.SECURITY_SCORE_BELOW, {"threshold": 140})
        check("a score threshold above 100 is refused", False)
    except catalog.ValidationError as exc:
        check("a score threshold above 100 is refused", "threshold" in exc.errors)

    # A scope the evaluator cannot honour must be refused, not ignored. An
    # alert scoped to one region that actually watches the whole account is
    # worse than one that refuses the scope.
    try:
        catalog.validate(catalog.DISCOVERY_FAILED, {}, {"region": "ap-south-1"})
        check("an unsupported scope narrowing is refused", False)
    except catalog.ValidationError as exc:
        check("an unsupported scope narrowing is refused",
              "scope.region" in exc.errors, exc.errors.get("scope.region", "")[:70])

    clean = catalog.validate(
        catalog.RESOURCE_STATUS_COUNT,
        {"status": "STOPPED", "operator": "greater_than", "threshold": 5,
         "bogus_key": "dropped"})
    check("unknown config keys are dropped rather than stored",
          "bogus_key" not in clean, str(sorted(clean)))
    check("a count threshold is stored as an integer",
          isinstance(clean["threshold"], int), repr(clean["threshold"]))

    scoped = catalog.clean_scope(catalog.RESOURCE_STATUS_COUNT,
                                 {"region": "eu-west-1", "service": "nope",
                                  "resource_type": ""})
    check("clean_scope keeps only supported, non-empty narrowings",
          scoped == {"region": "eu-west-1"}, str(scoped))


# ── C. Result semantics (pure) ────────────────────────────────────────────────
def test_result_semantics():
    section("C. UNKNOWN is never zero")

    unknown = result.unknown("the provider was throttled")
    check("an UNKNOWN result carries no observed value",
          unknown.observed is None)
    check("an UNKNOWN observed value renders as NA, not 0",
          unknown.observed_label == "NA", unknown.observed_label)
    check("UNKNOWN is classified inconclusive", not unknown.is_conclusive)
    check("UNKNOWN did not fire", not unknown.fired)

    for state in EVAL_INCONCLUSIVE:
        check(f"{state} is inconclusive, so it can never resolve an alert",
              state in EVAL_INCONCLUSIVE)

    # Passing observed= to an unknown must not smuggle a number in.
    sneaky = result.unknown("no data", observed=0)
    check("an UNKNOWN cannot be given an observed value",
          sneaky.observed is None)

    met = result.compared(True, 12, 5, catalog.OP_GT)
    check("a met comparison is TRIGGERED", met.state == EVAL_TRIGGERED)
    unmet = result.compared(False, 2, 5, catalog.OP_GT)
    check("an unmet comparison is NOT_TRIGGERED", unmet.state == EVAL_NOT_TRIGGERED)
    check("a genuine zero is still a real number, not NA",
          result.compared(False, 0, 5, catalog.OP_GT).observed_label == "0")

    money = result.compared(True, 1234.5, 1000, catalog.OP_GT, unit="INR")
    check("a currency is a suffix, never a guessed symbol",
          money.observed_label == "1,234.50 INR", money.observed_label)
    check("a percentage renders with a percent sign",
          result.compared(True, 30, 20, catalog.OP_GTE,
                          unit="%").observed_label == "30%")


# ── D. Fingerprints ───────────────────────────────────────────────────────────
def _rule(**kw):
    rule = CloudAlertRule()
    rule.id = kw.get("id", uuid.uuid4())
    rule.account_id = kw.get("account_id", uuid.uuid4())
    rule.condition_type = kw.get("condition_type", catalog.SECURITY_FINDING_COUNT)
    rule.condition_version = kw.get("condition_version", 1)
    rule.name = kw.get("name", "test rule")
    rule.severity = kw.get("severity", "HIGH")
    rule.category = kw.get("category", "security")
    rule.cooldown_seconds = kw.get("cooldown_seconds", 3600)
    rule.repeat_interval_seconds = kw.get("repeat_interval_seconds", 0)
    rule.evaluation_interval_seconds = kw.get("evaluation_interval_seconds", 300)
    rule.notification_config = kw.get("notification_config")
    rule.scope_config = kw.get("scope_config")
    rule.condition_config = kw.get("condition_config", {})
    # Column defaults apply at INSERT, not at instantiation, so a bare ORM
    # object has None here. Set explicitly — otherwise a test that passes
    # consecutive_breaches_required=2 would silently exercise the no-bar path
    # and pass while proving nothing.
    rule.min_duration_seconds = kw.get("min_duration_seconds", 0)
    rule.consecutive_breaches_required = kw.get("consecutive_breaches_required", 1)
    rule.silenced_until = kw.get("silenced_until")
    rule.silenced_by = kw.get("silenced_by")
    rule.silence_reason = kw.get("silence_reason")
    rule.notification_mode = kw.get("notification_mode", "immediate")
    rule.escalate_after_seconds = kw.get("escalate_after_seconds", 0)
    rule.respect_quiet_hours = kw.get("respect_quiet_hours", True)
    return rule


def test_fingerprints():
    section("D. Deduplication fingerprints")

    r1 = _rule()
    check("the same rule and subject give the same fingerprint",
          engine.fingerprint(r1, "res-1") == engine.fingerprint(r1, "res-1"))
    check("different subjects give different fingerprints",
          engine.fingerprint(r1, "res-1") != engine.fingerprint(r1, "res-2"))
    check("an account-wide condition has a stable fingerprint",
          engine.fingerprint(r1, None) == engine.fingerprint(r1, None))

    r2 = _rule(account_id=r1.account_id, condition_type=r1.condition_type)
    check("two rules watching the same thing keep separate alerts",
          engine.fingerprint(r1, "res-1") != engine.fingerprint(r2, "res-1"))

    r3 = _rule(id=r1.id, account_id=r1.account_id,
               condition_type=catalog.RESOURCE_STATUS_COUNT)
    check("changing a rule's condition starts a new alert",
          engine.fingerprint(r1, None) != engine.fingerprint(r3, None))

    # dedupe_key is a bounded UNIQUE column. A long OCID must not truncate into
    # a collision with a different resource.
    long_a = "ocid1.instance.oc1.ap-mumbai-1." + ("a" * 900)
    long_b = "ocid1.instance.oc1.ap-mumbai-1." + ("a" * 899) + "b"
    fa, fb = engine.fingerprint(r1, long_a), engine.fingerprint(r1, long_b)
    check("two very long, nearly identical ids do not collide", fa != fb)
    check("a fingerprint fits the dedupe_key column", len(fa) <= 600, f"len={len(fa)}")


# ── E. Cooldown ───────────────────────────────────────────────────────────────
class _FakeAlert:
    def __init__(self, last_notified_at=None):
        self.last_notified_at = last_notified_at
        self.state = "OPEN"


def test_cooldown():
    section("E. Cooldown suppresses mail without touching the lifecycle")

    eng = engine.AlertEngine.__new__(engine.AlertEngine)  # no DB needed
    now = datetime.now(timezone.utc)

    rule = _rule(cooldown_seconds=3600, repeat_interval_seconds=0)
    fresh = _FakeAlert(None)
    should, why = eng._cooldown_check(rule, fresh, now, just_opened=True)
    check("a brand-new alert notifies", should, why)

    recent = _FakeAlert(now - timedelta(minutes=5))
    should, why = eng._cooldown_check(rule, recent, now, just_opened=False)
    check("a recurrence of an already-notified alert does not re-notify",
          not should, why)
    check("the suppressed alert's state is untouched", recent.state == "OPEN")

    repeating = _rule(repeat_interval_seconds=3600)
    should, _ = eng._cooldown_check(repeating, _FakeAlert(now - timedelta(minutes=30)),
                                    now, just_opened=False)
    check("a repeat interval that has not elapsed suppresses", not should)
    should, _ = eng._cooldown_check(repeating, _FakeAlert(now - timedelta(minutes=90)),
                                    now, just_opened=False)
    check("a repeat interval that has elapsed re-notifies", should)

    # A re-open after a real resolution is news, and the previous episode's
    # cooldown must not silence it.
    should, why = eng._cooldown_check(rule, _FakeAlert(now - timedelta(minutes=1)),
                                      now, just_opened=True)
    check("a re-opened alert notifies despite a recent notification", should, why)

    # A naive timestamp must not blow up the comparison.
    naive = _FakeAlert(datetime.utcnow() - timedelta(minutes=5))
    try:
        eng._cooldown_check(rule, naive, now, just_opened=False)
        check("a naive last_notified_at is handled", True)
    except TypeError as exc:
        check("a naive last_notified_at is handled", False, str(exc))


# ── F. Cost windows ───────────────────────────────────────────────────────────
def test_cost_windows():
    section("F. Cost windows exclude today and demand full coverage")

    today = date(2026, 9, 17)
    start, end, expected = evaluators._period_range("month_to_date", today)
    check("month-to-date ends yesterday, not today",
          end == date(2026, 9, 16), str(end))
    check("month-to-date starts on the 1st", start == date(2026, 9, 1), str(start))
    check("month-to-date expects the right number of days",
          expected == 16, str(expected))

    start, end, expected = evaluators._period_range("yesterday", today)
    check("yesterday is one complete day",
          (start, end, expected) == (date(2026, 9, 16), date(2026, 9, 16), 1))

    # Inclusive of both ends: 10th through 16th IS seven days. Stated as a
    # computed span rather than two hardcoded dates, because an off-by-one here
    # silently compares a 6-day window against a 7-day baseline.
    start, end, expected = evaluators._period_range("last_7_days", today)
    check("a 7-day window is 7 complete days ending yesterday",
          end == date(2026, 9, 16) and (end - start).days + 1 == 7 and expected == 7,
          f"{start}..{end} = {(end - start).days + 1} days")

    # On the 1st there is no complete day in the month yet. Reporting that as
    # zero spend would clear every cost alert at midnight on the 1st.
    _, _, expected = evaluators._period_range("month_to_date", date(2026, 9, 1))
    check("month-to-date on the 1st has no complete day (reported, not zeroed)",
          expected == 0, str(expected))


# ── G. Email safety ───────────────────────────────────────────────────────────
def test_email_safety():
    section("G. Nothing sensitive reaches an email")

    body = templates.render(
        title="Test", severity="CRITICAL", lead="lead",
        facts={
            "Account": "prod",
            # Every one of these must be dropped: the template renders an
            # allowlist, so a caller that passes a secret cannot leak it.
            "Password": "hunter2",
            "smtp_password": "hunter2",
            "Access key": "AKIAIOSFODNN7EXAMPLE",
            "Connection string": "postgres://u:p@h/db",
            "Private key": "-----BEGIN RSA PRIVATE KEY-----",
        },
        samples=[], why=None)
    blob = body["html"] + body["text"]
    leaked = [s for s in ("hunter2", "AKIAIOSFODNN7EXAMPLE", "postgres://",
                          "BEGIN RSA PRIVATE KEY") if s in blob]
    check("secrets passed as facts are dropped by the allowlist", not leaked,
          str(leaked))
    check("allowed facts still render", "prod" in blob)

    # HTML injection through a resource name must not become markup. The test
    # is that no UNESCAPED tag survives — the escaped text "&lt;img … onerror=…"
    # appearing in the body is the correct outcome, not a leak, so a naive
    # substring search for "onerror" would fail on working code.
    injected = templates.render(
        title='<script>alert(1)</script>', severity="HIGH", lead="x",
        facts={"Resource": '<img src=x onerror=alert(1)>'})
    rendered = injected["html"]
    check("a hostile resource name is escaped, not rendered",
          "<script>" not in rendered and "<img " not in rendered
          and "&lt;script&gt;" in rendered and "&lt;img" in rendered)

    check("a test email is labelled TEST in the subject",
          templates.subject(severity="CRITICAL", kind="Security Alert",
                            account="prod", test=True).startswith("[TEST]"))
    check("a resolved email is labelled RESOLVED, not by severity",
          templates.subject(severity="CRITICAL", kind="Security Alert",
                            account="prod", resolved=True).startswith("[RESOLVED]"))
    check("a severity email leads with the severity",
          templates.subject(severity="CRITICAL", kind="Security Alert",
                            account="prod").startswith("[CRITICAL]"))

    # A value that could not be read must say NA in the mail, never 0.
    na_body = templates.render(
        title="t", severity="HIGH", lead="l", facts={"Account": "a"},
        why={"Observed": result.unknown("x").observed_label,
             "Expected": "is greater than 5"})
    check("an unreadable value renders as NA in the email body",
          "NA" in na_body["text"] and ">0<" not in na_body["html"])

    for address, valid in (("ops@example.com", True), ("ops@", False),
                           ("ops example@x.com", False), ("a@b.co", True),
                           ("", False), ("a@b", False)):
        check(f"email validation: {address!r} -> {valid}",
              notifier.valid_email(address) is valid)


# ── H. Deep links ─────────────────────────────────────────────────────────────
def test_links():
    section("H. Deep links")

    check("no public URL configured means no link, not a guessed host",
          notifier._deep_link(None, "aws", "abc") is None)
    check("an AWS account links to its alerts tab",
          notifier._deep_link("https://actmon.example.com", "aws", "abc")
          == "https://actmon.example.com/cloud/aws-accounts/abc/alerts")
    check("a trailing slash on the base URL does not double up",
          notifier._deep_link("https://x.com/", "oci", "1")
          == "https://x.com/cloud/oci-accounts/1/alerts")
    check("an unknown provider produces no link rather than a broken one",
          notifier._deep_link("https://x.com", "", "1") is None)


# ── DB-backed ─────────────────────────────────────────────────────────────────
async def db_available() -> bool:
    try:
        from sqlalchemy import text

        from app.core.database import AsyncSessionLocal

        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


async def test_db():
    section("I. Account isolation, lifecycle and notification (needs Postgres)")

    if not await db_available():
        for label in ("account isolation on rules",
                      "a rule that cannot be evaluated is refused at save time",
                      "an inconclusive evaluation does not resolve an open alert",
                      "a recurrence updates one alert rather than adding rows",
                      "a soft-deleted rule stops being evaluated and keeps its history",
                      "email is skipped with a reason when nobody is configured"):
            skip(label, "Postgres is not reachable")
        return

    from sqlalchemy import delete, select

    from app.core.database import AsyncSessionLocal
    from app.models.alert import CloudAlert
    from app.models.alert_rule import (
        CloudAlertEvent, CloudAlertRecipient, CloudAlertRule,
    )
    from app.models.cloud_account import CloudAccount
    from app.services.alert_rule_service import AlertRuleService, NotFound

    async with AsyncSessionLocal() as db:
        # credentials_enc is NOT NULL and encrypted; an empty string is enough
        # for a fixture that never talks to a provider.
        a1 = CloudAccount(account_name=PREFIX + "one", provider="OCI",
                          environment="Test", tenant_or_region="test-region",
                          credentials_enc="")
        a2 = CloudAccount(account_name=PREFIX + "two", provider="AWS",
                          environment="Test", tenant_or_region="test-region",
                          credentials_enc="")
        db.add_all([a1, a2])
        await db.commit()
        await db.refresh(a1)
        await db.refresh(a2)
        # Held as plain UUIDs, not read off the ORM objects later. The cleanup
        # runs after a rollback, which expires every loaded attribute, and
        # touching `a1.id` then triggers a lazy refresh outside the async
        # context — surfacing as MissingGreenlet and burying whatever actually
        # failed.
        a1_id, a2_id = a1.id, a2.id

        svc = AlertRuleService(db)
        try:
            created = await svc.create_rule(str(a1.id), {
                "name": PREFIX + "stopped",
                "condition_type": catalog.RESOURCE_STATUS_COUNT,
                "condition_config": {"status": "STOPPED",
                                     "operator": "greater_than", "threshold": 0},
                "severity": "MEDIUM",
            }, actor="suite")
            check("a valid rule is created", bool(created.get("id")))
            check("the stored rule carries its human sentence",
                  bool(created.get("condition_human")),
                  (created.get("condition_human") or "")[:60])

            # Isolation: account two must not be able to reach account one's rule.
            try:
                await svc.get_rule(str(a2.id), created["id"])
                check("account isolation on rules", False,
                      "another account could read the rule")
            except NotFound:
                check("account isolation on rules", True)

            # A condition the account cannot support must be refused at save
            # time, not stored and left permanently UNKNOWN.
            try:
                await svc.create_rule(str(a1.id), {
                    "name": PREFIX + "baseline",
                    "condition_type": catalog.COST_INCREASE_PERCENT,
                    "condition_config": {"window_days": "7",
                                         "threshold_percent": 20,
                                         "currency": "USD"},
                }, actor="suite")
                check("a rule that cannot be evaluated is refused at save time",
                      False, "a no-history baseline rule was accepted")
            except catalog.ValidationError as exc:
                check("a rule that cannot be evaluated is refused at save time",
                      "condition_type" in exc.errors,
                      list(exc.errors)[0] if exc.errors else "")

            # An inconclusive evaluation must leave an open alert alone.
            rule = await db.get(CloudAlertRule, uuid.UUID(created["id"]))
            eng = engine.AlertEngine(db)
            key = engine.fingerprint(rule, None)
            alert, _ = eng.alerts and await eng.alerts.upsert(
                anomaly_type="TEST", details="open", severity="HIGH",
                dedupe_key=key, account_id=a1.id)
            await db.commit()

            await eng._handle_inconclusive(
                rule, result.unknown("the provider was throttled"), 1.0)
            await db.commit()
            await db.refresh(alert)
            check("an inconclusive evaluation does not resolve an open alert",
                  alert.state == "OPEN", alert.state)
            check("the rule reports why it could not evaluate",
                  rule.last_result == EVAL_UNKNOWN
                  and "throttled" in (rule.last_result_detail or ""),
                  f"{rule.last_result}: {(rule.last_result_detail or '')[:40]}")
            check("an unreadable value is stored as NULL, not 0",
                  rule.last_observed_value is None, repr(rule.last_observed_value))

            # Recurrence must update one row rather than adding more.
            before = len((await db.execute(
                select(CloudAlert).where(CloudAlert.account_id == a1.id)
            )).scalars().all())
            for _ in range(3):
                await eng.alerts.upsert(anomaly_type="TEST", details="again",
                                        severity="HIGH", dedupe_key=key,
                                        account_id=a1.id)
            await db.commit()
            after = len((await db.execute(
                select(CloudAlert).where(CloudAlert.account_id == a1.id)
            )).scalars().all())
            check("a recurrence updates one alert rather than adding rows",
                  before == after, f"{before} -> {after}")

            # Email must be skipped with a stated reason, not silently.
            recips = await notifier.resolve_recipients(db, rule)
            check("a rule with no recipients resolves to nobody",
                  recips["total"] == 0, str(recips["total"]))
            db.add(CloudAlertRecipient(account_id=a1.id, email="ops@example.com",
                                       kind="to", enabled=True))
            await db.commit()
            recips = await notifier.resolve_recipients(db, rule)
            check("account defaults reach a rule that did not set its own",
                  recips["to"] == ["ops@example.com"], str(recips["to"]))

            # A disabled recipient must not receive anything.
            row = (await db.execute(select(CloudAlertRecipient).where(
                CloudAlertRecipient.account_id == a1.id))).scalars().first()
            row.enabled = False
            await db.commit()
            recips = await notifier.resolve_recipients(db, rule)
            check("a disabled recipient is excluded", recips["total"] == 0)

            # Soft delete keeps history and stops evaluation.
            await svc.delete_rule(str(a1.id), created["id"], actor="suite")
            gone = await db.get(CloudAlertRule, uuid.UUID(created["id"]))
            check("a soft-deleted rule stops being evaluated and keeps its history",
                  gone is not None and gone.deleted_at is not None
                  and gone.enabled is False,
                  f"deleted_at={gone.deleted_at is not None} enabled={gone.enabled}")
            due = await eng.rules.due_rules(limit=500)
            check("a deleted rule is never picked up as due",
                  all(r.id != gone.id for r in due))

            events = (await db.execute(select(CloudAlertEvent).where(
                CloudAlertEvent.account_id == a1.id))).scalars().all()
            check("every configuration change left an audit row",
                  len(events) >= 3, f"{len(events)} events")
            check("the delete is auditable by action name",
                  any(e.action == "rule.deleted" for e in events))

        finally:
            # A failed assertion can leave the session in an aborted
            # transaction, and every cleanup statement would then fail with
            # "current transaction is aborted" — burying the real failure under
            # a stack trace about DELETE. Roll back first, always.
            await db.rollback()
            ids = [a1_id, a2_id]
            await db.execute(delete(CloudAlertEvent).where(
                CloudAlertEvent.account_id.in_(ids)))
            await db.execute(delete(CloudAlertRecipient).where(
                CloudAlertRecipient.account_id.in_(ids)))
            await db.execute(delete(CloudAlert).where(
                CloudAlert.account_id.in_(ids)))
            await db.execute(delete(CloudAlertRule).where(
                CloudAlertRule.account_id.in_(ids)))
            await db.execute(delete(CloudAccount).where(
                CloudAccount.account_name.like(PREFIX + "%")))
            await db.commit()


# ── J. Minimum duration and consecutive breaches ──────────────────────────────
class _FakeBreach:
    """Stands in for a cloud_alerts row while testing the hold-off arithmetic."""

    def __init__(self, state, occurrence_count=1, created_at=None):
        self.state = state
        self.occurrence_count = occurrence_count
        self.created_at = created_at or datetime.now(timezone.utc)


def test_holdoff():
    section("J. A transient spike is held back, not alerted")

    eng = engine.AlertEngine.__new__(engine.AlertEngine)
    now = datetime.now(timezone.utc)

    plain = _rule()
    held, why = eng._within_holdoff(plain, _FakeBreach("PENDING"))
    check("a rule with no bars alerts on the first breach", not held, why)

    twice = _rule(consecutive_breaches_required=2)
    held, why = eng._within_holdoff(twice, _FakeBreach("PENDING", 1))
    check("one breach does not satisfy a two-evaluation bar", held, why)
    held, why = eng._within_holdoff(twice, _FakeBreach("PENDING", 2))
    check("two breaches satisfy a two-evaluation bar", not held, why)

    timed = _rule(min_duration_seconds=900)
    fresh = _FakeBreach("PENDING", 5, now - timedelta(seconds=60))
    held, why = eng._within_holdoff(timed, fresh)
    check("a breach younger than the minimum duration is held", held, why)
    old = _FakeBreach("PENDING", 5, now - timedelta(seconds=1200))
    held, why = eng._within_holdoff(timed, old)
    check("a breach older than the minimum duration is released", not held, why)

    # Both bars apply. Satisfying one does not satisfy the other.
    both = _rule(min_duration_seconds=900, consecutive_breaches_required=3)
    held, _ = eng._within_holdoff(both, _FakeBreach("PENDING", 1, now - timedelta(hours=2)))
    check("an old breach seen once still fails the consecutive bar", held)
    held, _ = eng._within_holdoff(both, _FakeBreach("PENDING", 5, now - timedelta(seconds=10)))
    check("a repeated breach that is too young still fails the duration bar", held)
    held, _ = eng._within_holdoff(both, _FakeBreach("PENDING", 5, now - timedelta(hours=2)))
    check("clearing both bars releases the breach", not held)

    # The bar is for getting in, not for staying in. An alert that is already
    # open must never be pushed back into PENDING by an interval change.
    for state in ("OPEN", "ACKNOWLEDGED"):
        held, why = eng._within_holdoff(both, _FakeBreach(state, 1, now))
        check(f"an already-{state} alert is never re-held", not held, why)

    # A naive created_at must not blow up the arithmetic.
    naive = _FakeBreach("PENDING", 9, datetime.utcnow() - timedelta(hours=2))
    try:
        held, _ = eng._within_holdoff(timed, naive)
        check("a naive created_at is handled", not held)
    except TypeError as exc:
        check("a naive created_at is handled", False, str(exc))


# ── K. Silence ────────────────────────────────────────────────────────────────
def test_silence():
    section("K. Silence stops the mail, not the watching")

    now = datetime.now(timezone.utc)
    rule = _rule()
    check("a rule with no silence is not silenced", not rule.is_silenced(now))

    rule.silenced_until = now + timedelta(hours=1)
    check("a rule silenced into the future is silenced", rule.is_silenced(now))

    rule.silenced_until = now - timedelta(minutes=1)
    check("an expired silence is not a silence", not rule.is_silenced(now))

    # A naive timestamp from the database must not raise.
    rule.silenced_until = datetime.utcnow() + timedelta(hours=1)
    try:
        check("a naive silenced_until is handled", rule.is_silenced(now))
    except TypeError as exc:
        check("a naive silenced_until is handled", False, str(exc))

    check("SILENCED is its own notification status, distinct from cooldown",
          notifier.NOTIFY_SILENCED != notifier.NOTIFY_SKIPPED_COOLDOWN)


# ── L. Templates ──────────────────────────────────────────────────────────────
def test_templates():
    section("L. Every template describes a condition the engine can answer")

    from app.services.alerts import templates_catalog as tc

    problems = tc.validate_all()
    check("every template validates against the catalog", not problems,
          "; ".join(problems)[:160])
    check("there are templates to offer", len(tc.TEMPLATES) >= 10,
          str(len(tc.TEMPLATES)))
    check("every recommended key is a real template",
          all(k in tc.TEMPLATES for k in tc.RECOMMENDED))

    # A recommended rule must never need a value only the operator can supply —
    # apply-all would silently skip it and the user would wonder what happened.
    needy = [k for k in tc.RECOMMENDED if tc.TEMPLATES[k].needs_input]
    check("no recommended template needs an operator-supplied value",
          not needy, str(needy))

    # The recommended set should span categories rather than being seven
    # security rules.
    cats = {tc.TEMPLATES[k].category for k in tc.RECOMMENDED}
    check("the recommended set spans at least four categories",
          len(cats) >= 4, ", ".join(sorted(cats)))


# ── M. Timezone ───────────────────────────────────────────────────────────────
def test_timezone():
    section("M. Timestamps are never ambiguous")

    utc_moment = datetime(2026, 9, 17, 5, 12, tzinfo=timezone.utc)
    ist = notifier.local_time(utc_moment, "Asia/Kolkata")
    check("a UTC instant renders in the configured zone",
          "10:42" in ist, ist)
    check("the zone is named in the rendered string",
          "IST" in ist, ist)
    check("the date is unambiguous (day, month name, year)",
          "17 Sep 2026" in ist, ist)

    as_utc = notifier.local_time(utc_moment, "UTC")
    check("rendering in UTC says UTC", "UTC" in as_utc and "05:12" in as_utc, as_utc)

    # A naive timestamp is what the database hands back. Treating it as the
    # reader's local time would shift every alert by the UTC offset.
    naive = notifier.local_time(datetime(2026, 9, 17, 5, 12), "Asia/Kolkata")
    check("a naive timestamp is treated as UTC, not as local",
          "10:42" in naive, naive)

    check("an ISO string is accepted as well as a datetime",
          "10:42" in (notifier.local_time("2026-09-17T05:12:00Z", "Asia/Kolkata") or ""))
    check("an unknown zone falls back to UTC rather than raising",
          "UTC" in (notifier.local_time(utc_moment, "Mars/Olympus") or ""))
    check("None stays None", notifier.local_time(None) is None)


# ── N. Email links ────────────────────────────────────────────────────────────
def test_links_by_category():
    section("N. Email links go where the alert points")

    base = "https://actmon.example.com"

    class _Acct:
        provider = "aws"
        id = "acct-1"
        account_name = "prod"

    class _Ev:
        subject_name = None

    for category, expected in (("cost", "/cost"), ("security", "/security"),
                               ("drift", "/drift"), ("event", "/events"),
                               ("resource", "/resources")):
        rule = _rule(category=category)
        rule.account_id = "acct-1"
        links = notifier._alert_links(base, _Acct(), rule, _Ev())
        urls = " ".join(x["url"] for x in links)
        check(f"a {category} alert links to {expected}", expected in urls, urls[:120])
        check(f"a {category} alert still links to the alert itself",
              "/alerts" in urls)

    # A resource-specific alert gets a link that finds that resource.
    class _EvNamed:
        subject_name = "i-0abc123"

    rule = _rule(category="resource")
    rule.account_id = "acct-1"
    urls = " ".join(x["url"] for x in notifier._alert_links(base, _Acct(), rule, _EvNamed()))
    check("a named subject produces a resource search link",
          "q=i-0abc123" in urls, urls[-80:])

    # With no public URL there must be no links at all rather than broken ones.
    links = notifier._alert_links(None, _Acct(), rule, _EvNamed())
    check("no public URL means no links, not broken ones", links == [])


class _Settings:
    def __init__(self, **kw):
        self.quiet_hours_enabled = kw.get("quiet_hours_enabled", False)
        self.quiet_hours_start = kw.get("quiet_hours_start", "22:00")
        self.quiet_hours_end = kw.get("quiet_hours_end", "07:00")
        self.quiet_hours_critical_bypass = kw.get("quiet_hours_critical_bypass", True)
        self.display_timezone = kw.get("display_timezone", "Asia/Kolkata")


class _Alert:
    def __init__(self, **kw):
        self.state = kw.get("state", "OPEN")
        self.last_notified_at = kw.get("last_notified_at")
        self.created_at = kw.get("created_at", datetime.now(timezone.utc))
        self.escalated_at = kw.get("escalated_at")
        self.silenced_until = kw.get("silenced_until")
        self.silence_reason = kw.get("silence_reason")

    def is_silenced(self, now=None):
        if self.silenced_until is None:
            return False
        now = now or datetime.now(timezone.utc)
        until = self.silenced_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > now


def test_quiet_hours():
    section("P. Quiet hours hold mail without hiding alerts")

    from app.services.alerts import policy

    ist = _Settings(quiet_hours_enabled=True, display_timezone="Asia/Kolkata")
    # 20:00 UTC == 01:30 IST, inside 22:00–07:00.
    night = datetime(2026, 9, 17, 20, 0, tzinfo=timezone.utc)
    # 06:00 UTC == 11:30 IST, outside it.
    day = datetime(2026, 9, 17, 6, 0, tzinfo=timezone.utc)

    check("a time inside the window is quiet", policy.in_quiet_hours(night, ist))
    check("a time outside the window is not", not policy.in_quiet_hours(day, ist))
    check("the window is evaluated in local time, not UTC",
          policy.in_quiet_hours(night, ist)
          and not policy.in_quiet_hours(night, _Settings(
              quiet_hours_enabled=True, display_timezone="UTC")),
          "20:00 UTC is quiet in IST but not in UTC")
    check("quiet hours off means never quiet",
          not policy.in_quiet_hours(night, _Settings()))
    check("a zero-length window never holds anything",
          not policy.in_quiet_hours(night, _Settings(
              quiet_hours_enabled=True, quiet_hours_start="22:00",
              quiet_hours_end="22:00")))

    end = policy.quiet_hours_end_utc(night, ist)
    check("the release time is in the future", end and end > night, str(end))

    # A held message is scheduled, not dropped.
    medium = _rule(severity="MEDIUM")
    d = policy.decide(rule=medium, alert=_Alert(), settings=ist, now=night,
                      just_opened=True, resolved=False)
    check("a MEDIUM alert is held during quiet hours",
          d.outcome == policy.HOLD_QUIET_HOURS, d.outcome)
    check("a held message says when it will be sent", d.deliver_after is not None)
    check("the reason says the alert is open now",
          "open now" in d.reason, d.reason[:70])

    # Severity wins by default.
    critical = _rule(severity="CRITICAL")
    d = policy.decide(rule=critical, alert=_Alert(), settings=ist, now=night,
                      just_opened=True, resolved=False)
    check("a CRITICAL alert bypasses quiet hours by default", d.should_send, d.outcome)

    no_bypass = _Settings(quiet_hours_enabled=True,
                          quiet_hours_critical_bypass=False)
    d = policy.decide(rule=critical, alert=_Alert(), settings=no_bypass, now=night,
                      just_opened=True, resolved=False)
    check("turning the bypass off holds even a CRITICAL",
          d.outcome == policy.HOLD_QUIET_HOURS, d.outcome)

    # A rule can opt out entirely.
    exempt = _rule(severity="MEDIUM")
    exempt.respect_quiet_hours = False
    d = policy.decide(rule=exempt, alert=_Alert(), settings=ist, now=night,
                      just_opened=True, resolved=False)
    check("a rule that opts out of quiet hours still sends", d.should_send)

    # A resolution notice is only useful while it is news.
    d = policy.decide(rule=medium, alert=_Alert(), settings=ist, now=night,
                      just_opened=False, resolved=True)
    check("a resolution notice is never held by quiet hours", d.should_send, d.outcome)


def test_digest_policy():
    section("Q. A digest can never swallow a CRITICAL")

    from app.services.alerts import policy

    plain = _Settings()
    for mode in (policy.MODE_HOURLY, policy.MODE_DAILY):
        low = _rule(severity="MEDIUM")
        low.notification_mode = mode
        d = policy.decide(rule=low, alert=_Alert(), settings=plain,
                          just_opened=True, resolved=False)
        check(f"a MEDIUM alert is batched into the {mode}",
              d.outcome == policy.HOLD_DIGEST and d.batch, d.outcome)

        crit = _rule(severity="CRITICAL")
        crit.notification_mode = mode
        d = policy.decide(rule=crit, alert=_Alert(), settings=plain,
                          just_opened=True, resolved=False)
        check(f"a CRITICAL alert is sent immediately despite {mode}",
              d.should_send, d.outcome)
        check("and it says why it ignored the setting",
              "never batched" in d.reason, d.reason[:60])

    # A batched message is held, not dropped — the caller can tell.
    low = _rule(severity="LOW")
    low.notification_mode = policy.MODE_DAILY
    d = policy.decide(rule=low, alert=_Alert(), settings=plain,
                      just_opened=True, resolved=False)
    check("a digest hold is marked as a batch, not a drop", d.batch)


def test_silence_precedence():
    section("R. Silence beats everything, on the rule or the alert")

    from app.services.alerts import policy

    now = datetime.now(timezone.utc)
    later = now + timedelta(hours=1)
    plain = _Settings()

    ruled = _rule(severity="CRITICAL", silenced_until=later)
    d = policy.decide(rule=ruled, alert=_Alert(), settings=plain, now=now,
                      just_opened=True, resolved=False)
    check("a silenced RULE suppresses even a CRITICAL",
          d.outcome == policy.HOLD_SILENCED_RULE, d.outcome)
    check("and says the alert was still recorded",
          "still recorded" in d.reason, d.reason[:60])

    d = policy.decide(rule=_rule(severity="CRITICAL"),
                      alert=_Alert(silenced_until=later), settings=plain, now=now,
                      just_opened=True, resolved=False)
    check("a silenced ALERT suppresses independently of its rule",
          d.outcome == policy.HOLD_SILENCED_ALERT, d.outcome)
    check("and says the alert is still open", "still open" in d.reason)

    # An expired silence is not a silence.
    d = policy.decide(rule=_rule(silenced_until=now - timedelta(minutes=1)),
                      alert=_Alert(), settings=plain, now=now,
                      just_opened=True, resolved=False)
    check("an expired silence no longer suppresses", d.should_send, d.outcome)

    # No email channel at all.
    nochan = _rule(notification_config={"channels": ["slack"]})
    d = policy.decide(rule=nochan, alert=_Alert(), settings=plain,
                      just_opened=True, resolved=False)
    check("a rule that does not notify by email is held at the channel gate",
          d.outcome == policy.HOLD_NO_CHANNEL, d.outcome)


def test_escalation():
    section("S. Escalation fires once, and stops when someone picks it up")

    from app.services.alerts import policy

    now = datetime.now(timezone.utc)
    rule = _rule()
    rule.escalate_after_seconds = 3600

    old = _Alert(created_at=now - timedelta(hours=2))
    check("an old unacknowledged alert escalates",
          policy.should_escalate(rule, old, now))

    fresh = _Alert(created_at=now - timedelta(minutes=10))
    check("a recent alert does not escalate yet",
          not policy.should_escalate(rule, fresh, now))

    acked = _Alert(created_at=now - timedelta(hours=2), state="ACKNOWLEDGED")
    check("an acknowledged alert never escalates — that is the point",
          not policy.should_escalate(rule, acked, now))

    already = _Alert(created_at=now - timedelta(hours=5),
                     escalated_at=now - timedelta(hours=1))
    check("an already-escalated alert escalates only once",
          not policy.should_escalate(rule, already, now))

    off = _rule()
    off.escalate_after_seconds = 0
    check("escalation off means never", not policy.should_escalate(off, old, now))

    naive = _Alert(created_at=datetime.utcnow() - timedelta(hours=2))
    try:
        check("a naive created_at is handled",
              policy.should_escalate(rule, naive, now))
    except TypeError as exc:
        check("a naive created_at is handled", False, str(exc))


async def test_db_new():
    section("O. Preview, duplicate, silence and retention (needs Postgres)")

    if not await db_available():
        for label in ("a preview writes nothing",
                      "a duplicate is created disabled",
                      "recommended rules are created disabled and notify nobody",
                      "retention never prunes an open alert",
                      "a held breach is not counted as an alert"):
            skip(label, "Postgres is not reachable")
        return

    from sqlalchemy import delete, func, select

    from app.core.database import AsyncSessionLocal
    from app.models.alert import STATE_OPEN, STATE_PENDING, STATE_RESOLVED, CloudAlert
    from app.models.alert_rule import (
        CloudAlertEvent, CloudAlertRecipient, CloudAlertRule,
    )
    from app.models.cloud_account import CloudAccount
    from app.services.alert_rule_service import AlertRuleService

    async with AsyncSessionLocal() as db:
        acct = CloudAccount(account_name=PREFIX + "new", provider="OCI",
                            environment="Test", tenant_or_region="test-region",
                            credentials_enc="")
        db.add(acct)
        await db.commit()
        await db.refresh(acct)
        aid = acct.id

        svc = AlertRuleService(db)
        try:
            # ── Preview must not persist anything ────────────────────────────
            before = (await db.execute(
                select(func.count()).select_from(CloudAlertRule)
                .where(CloudAlertRule.account_id == aid))).scalar_one()
            preview = await svc.preview_rule(str(aid), {
                "name": "unsaved",
                "condition_type": catalog.RESOURCE_STATUS_COUNT,
                "condition_config": {"status": "STOPPED",
                                     "operator": "greater_than", "threshold": 0},
                "severity": "LOW",
            })
            after = (await db.execute(
                select(func.count()).select_from(CloudAlertRule)
                .where(CloudAlertRule.account_id == aid))).scalar_one()
            check("a preview writes nothing", before == after, f"{before} -> {after}")
            check("a preview returns a real evaluation",
                  preview.get("ready") and preview.get("result"),
                  str(preview.get("result")))
            check("a preview explains what would happen in plain words",
                  bool(preview.get("summary", {}).get("when"))
                  and bool(preview["summary"].get("send")),
                  (preview.get("summary") or {}).get("send", "")[:70])
            check("a preview with no recipients says so rather than implying mail",
                  "nobody" in (preview["summary"]["send"] or "").lower())

            # An incomplete condition is an ordinary intermediate state while
            # typing, not an error the panel should shout about.
            partial = await svc.preview_rule(str(aid), {
                "condition_type": catalog.COST_THRESHOLD,
                "condition_config": {"period": "month_to_date"},
            })
            check("an incomplete condition previews as not-ready, not as an error",
                  partial.get("ready") is False and "errors" in partial)

            # ── Duplicate ────────────────────────────────────────────────────
            original = await svc.create_rule(str(aid), {
                "name": PREFIX + "original",
                "condition_type": catalog.RESOURCE_STATUS_COUNT,
                "condition_config": {"status": "STOPPED",
                                     "operator": "greater_than", "threshold": 3},
                "severity": "MEDIUM", "enabled": True,
            }, actor="suite")
            copy = await svc.duplicate_rule(str(aid), original["id"], actor="suite")
            check("a duplicate is created disabled",
                  copy["enabled"] is False, str(copy["enabled"]))
            check("a duplicate gets a distinct name",
                  copy["name"] != original["name"], copy["name"])
            check("a duplicate keeps the condition",
                  copy["condition_config"] == original["condition_config"])

            # ── Recommended templates ────────────────────────────────────────
            applied = await svc.apply_recommended(str(aid), actor="suite")
            created = applied["created"]
            check("recommended rules were created", bool(created),
                  f"{len(created)} created, {len(applied['skipped'])} skipped")
            check("every recommended rule is created DISABLED",
                  all(r["enabled"] is False for r in created))
            check("no recommended rule inherits account default recipients",
                  all(r["notification_config"].get("use_account_defaults") is False
                      for r in created))
            check("no recommended rule has its own recipients either",
                  all(not r["notification_config"].get("recipients")
                      for r in created))

            # ── Retention ────────────────────────────────────────────────────
            now = datetime.now(timezone.utc)
            old = now - timedelta(days=400)
            db.add_all([
                CloudAlert(account_id=aid, anomaly_type="T", severity="HIGH",
                           details="ancient but still open", dedupe_key=PREFIX + "open",
                           state=STATE_OPEN, created_at=old, last_seen_at=old),
                CloudAlert(account_id=aid, anomaly_type="T", severity="LOW",
                           details="ancient and resolved", dedupe_key=PREFIX + "res",
                           state=STATE_RESOLVED, created_at=old, last_seen_at=old,
                           resolved_at=old),
                CloudAlert(account_id=aid, anomaly_type="T", severity="LOW",
                           details="abandoned breach", dedupe_key=PREFIX + "pend",
                           state=STATE_PENDING, created_at=old, last_seen_at=old),
            ])
            await db.commit()

            settings = await engine.get_settings(db)
            settings.pruning_enabled = True
            await db.commit()

            dry = await engine.prune(db, dry_run=True)
            check("a dry run reports without deleting",
                  dry.get("dry_run") is True and dry["would_remove"]["resolved_alerts"] >= 1)

            await engine.prune(db)
            survivors = {
                r.dedupe_key: r.state for r in (await db.execute(
                    select(CloudAlert).where(CloudAlert.account_id == aid)
                )).scalars().all()
            }
            check("retention never prunes an open alert, at any age",
                  (PREFIX + "open") in survivors, str(sorted(survivors)))
            check("an ancient resolved alert is pruned",
                  (PREFIX + "res") not in survivors)
            check("an abandoned held breach is cleaned up",
                  (PREFIX + "pend") not in survivors)

            # ── PENDING never counts as an alert ─────────────────────────────
            listed = await svc.list_alerts(str(aid), states=None)
            states = {a["state"] for a in listed["alerts"]}
            check("a held breach is not counted as an alert",
                  STATE_PENDING not in states, str(sorted(states)))

            summary = await svc.summary(str(aid))
            check("held breaches do not inflate the active count",
                  summary["active_alerts"] == 1, str(summary["active_alerts"]))

            # ── Silence ──────────────────────────────────────────────────────
            silenced = await svc.silence_rule(str(aid), original["id"],
                                              seconds=3600, reason="maintenance",
                                              actor="suite")
            check("silencing sets an expiry and keeps the rule enabled",
                  silenced["is_silenced"] and silenced["enabled"],
                  f"until={silenced['silenced_until']}")
            try:
                await svc.silence_rule(str(aid), original["id"],
                                       seconds=90 * 86400, actor="suite")
                check("an over-long silence is refused", False)
            except catalog.ValidationError as exc:
                check("an over-long silence is refused, pointing at Disable",
                      "Disable" in str(exc), str(exc)[:80])

            cleared = await svc.unsilence_rule(str(aid), original["id"], actor="suite")
            check("unsilencing clears the expiry", not cleared["is_silenced"])

            # ── Analytics shape ──────────────────────────────────────────────
            stats = await svc.analytics(str(aid), days=7)
            check("the time series is padded so quiet days are real zeros",
                  len(stats["over_time"]) == 8, str(len(stats["over_time"])))
            check("every severity is present in the breakdown, including zeroes",
                  set(stats["by_severity"]) == {"CRITICAL", "HIGH", "MEDIUM",
                                                "LOW", "INFO"})
            check("delivery is reported separately from what the engine decided",
                  "decided_by_engine" in stats["notifications"]
                  and "delivered" in stats["notifications"])

            noisy = await svc.noisy_rules(str(aid), days=7)
            check("noisy-rule analysis refuses a rate on too few samples",
                  all(r["resolution_rate_pct"] is None
                      or r["alerts"] >= 5 for r in noisy["rules"]))

        finally:
            await db.rollback()
            await db.execute(delete(CloudAlertEvent).where(
                CloudAlertEvent.account_id == aid))
            await db.execute(delete(CloudAlertRecipient).where(
                CloudAlertRecipient.account_id == aid))
            await db.execute(delete(CloudAlert).where(CloudAlert.account_id == aid))
            await db.execute(delete(CloudAlertRule).where(
                CloudAlertRule.account_id == aid))
            await db.execute(delete(CloudAccount).where(
                CloudAccount.account_name.like(PREFIX + "%")))
            settings = await engine.get_settings(db)
            settings.pruning_enabled = False
            await db.commit()


async def main():
    print("Alert rules, evaluation safety, deduplication and notification")
    print("=" * 66)
    test_catalog()
    test_validation()
    test_result_semantics()
    test_fingerprints()
    test_cooldown()
    test_cost_windows()
    test_email_safety()
    test_links()
    test_holdoff()
    test_silence()
    test_templates()
    test_timezone()
    test_links_by_category()
    test_quiet_hours()
    test_digest_policy()
    test_silence_precedence()
    test_escalation()
    await test_db()
    await test_db_new()

    print("\n" + "=" * 66)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP {len(skipped)}")
    if skipped:
        print("\nSkipped (Postgres was not reachable) — these are NOT passes:")
        for s in skipped:
            print(f"  - {s}")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
