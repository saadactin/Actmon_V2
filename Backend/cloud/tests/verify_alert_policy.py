"""Notification policy: whether an alert's email goes out now, and why.

Run: venv\\Scripts\\python.exe tests\\verify_alert_policy.py

This module decides whether a human is told about a production problem. A
wrong branch here is invisible: nothing errors, no log line appears, the mail
simply does not arrive. That makes it the highest defect-per-line risk in the
alerting stack and the reason this suite exists.

The rules it pins, in rough order of how expensive they are to get wrong:

  A  A CRITICAL alert is NEVER batched into a digest, and quiet hours never
     hold one unless the bypass has been deliberately switched off. The module
     docstring calls this "a rule, not a default"; nothing enforced it.
  B  Quiet hours DELAY, they never cancel — and a held alert carries a
     deliver_after in the future, so it is visibly held rather than lost.
  C  A resolution notice ignores quiet hours, digests AND cooldown. Telling
     someone at 09:00 that a problem cleared at 23:00 is worse than silence.
  D  Cooldown boundaries, on both sides, and the re-open exception.
  E  escalate_after_seconds = 0 means DISABLED, not "escalate immediately" —
     the classic silent bug in this shape of code.

Every object below is a real CloudAlertRule / CloudAlert / CloudAlertSettings,
never a stand-in: `rule.channels()` and `rule.is_silenced()` are production
methods, and a mirror of them would prove nothing about production.
"""
import logging
import pathlib
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from app.models.alert_rule import (  # noqa: E402
    CloudAlertRule, CloudAlertSettings,
)
from app.models.alert import CloudAlert  # noqa: E402
from app.services.alerts import policy  # noqa: E402

ok, fail = [], []
NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


# ── Fixture builders ─────────────────────────────────────────────────────────
# These CONSTRUCT real model objects. They deliberately compute nothing about
# what a rule MEANS -- that is policy.decide()'s job, and restating it here is
# the mirror mistake that has already hidden two bugs in this repo.
def _rule(**over):
    rule = CloudAlertRule(
        name=over.pop("name", "zzpolicy-test-rule"),
        severity=over.pop("severity", "HIGH"),
        notification_config=over.pop("notification_config", {"channels": ["email"]}),
        notification_mode=over.pop("notification_mode", policy.MODE_IMMEDIATE),
        respect_quiet_hours=over.pop("respect_quiet_hours", True),
        repeat_interval_seconds=over.pop("repeat_interval_seconds", 0),
        escalate_after_seconds=over.pop("escalate_after_seconds", 0),
        silenced_until=over.pop("silenced_until", None),
        silence_reason=over.pop("silence_reason", None),
    )
    for key, value in over.items():
        setattr(rule, key, value)
    return rule


def _alert(**over):
    alert = CloudAlert(
        anomaly_type=over.pop("anomaly_type", "zzpolicy:test"),
        severity=over.pop("severity", "HIGH"),
        state=over.pop("state", "OPEN"),
        last_notified_at=over.pop("last_notified_at", None),
        silenced_until=over.pop("silenced_until", None),
        silence_reason=over.pop("silence_reason", None),
        escalated_at=over.pop("escalated_at", None),
        created_at=over.pop("created_at", NOW),
    )
    for key, value in over.items():
        setattr(alert, key, value)
    return alert


def _settings(**over):
    settings = CloudAlertSettings(
        quiet_hours_enabled=over.pop("quiet_hours_enabled", False),
        quiet_hours_start=over.pop("quiet_hours_start", "22:00"),
        quiet_hours_end=over.pop("quiet_hours_end", "07:00"),
        quiet_hours_critical_bypass=over.pop("quiet_hours_critical_bypass", True),
        display_timezone=over.pop("display_timezone", "UTC"),
    )
    for key, value in over.items():
        setattr(settings, key, value)
    return settings


def decide(rule=None, alert=None, settings=None, *, now=NOW,
           just_opened=False, resolved=False):
    return policy.decide(
        rule=rule if rule is not None else _rule(),
        alert=alert,
        settings=settings if settings is not None else _settings(),
        now=now, just_opened=just_opened, resolved=resolved,
    )


# ── A. CRITICAL is never batched, and never held by quiet hours ─────────────
def test_critical_is_never_batched():
    section("A. A CRITICAL alert is never batched and never quietly held")

    for mode in (policy.MODE_HOURLY, policy.MODE_DAILY):
        decision = decide(_rule(severity="CRITICAL", notification_mode=mode))
        check(f"CRITICAL with {mode} digest is SENT, not batched",
              decision.outcome == policy.SEND, f"{decision.outcome}: {decision.reason}")
        check(f"CRITICAL with {mode} digest is not marked for batching",
              decision.batch is not True)
        check(f"the reason says WHY it overrode the {mode} setting",
              "CRITICAL" in decision.reason, decision.reason)

    # The mirror image: a non-critical alert still batches, so the rule above
    # cannot be satisfied by simply disabling digests.
    high = decide(_rule(severity="HIGH", notification_mode=policy.MODE_DAILY))
    check("a HIGH alert with a daily digest IS batched (digests still work)",
          high.outcome == policy.HOLD_DIGEST and high.batch is True,
          f"{high.outcome}")

    quiet = _settings(quiet_hours_enabled=True, quiet_hours_start="00:00",
                      quiet_hours_end="23:59")
    critical_in_quiet = decide(_rule(severity="CRITICAL"), settings=quiet)
    check("CRITICAL is sent during quiet hours when the bypass is on (default)",
          critical_in_quiet.outcome == policy.SEND,
          f"{critical_in_quiet.outcome}: {critical_in_quiet.reason}")

    no_bypass = _settings(quiet_hours_enabled=True, quiet_hours_start="00:00",
                          quiet_hours_end="23:59", quiet_hours_critical_bypass=False)
    critical_held = decide(_rule(severity="CRITICAL"), settings=no_bypass)
    check("with the bypass deliberately OFF, even CRITICAL is held — the "
          "switch means what it says",
          critical_held.outcome == policy.HOLD_QUIET_HOURS,
          critical_held.outcome)


# ── B. Quiet hours delay, never cancel ──────────────────────────────────────
def test_quiet_hours():
    section("B. Quiet hours delay rather than cancel, and wrap around midnight")

    quiet = _settings(quiet_hours_enabled=True, quiet_hours_start="22:00",
                      quiet_hours_end="07:00")

    at_2330 = NOW.replace(hour=23, minute=30)
    at_0200 = NOW.replace(hour=2, minute=0)
    at_0800 = NOW.replace(hour=8, minute=0)
    at_1200 = NOW.replace(hour=12, minute=0)

    check("23:30 is inside a 22:00-07:00 window", policy.in_quiet_hours(at_2330, quiet))
    check("02:00 is inside it too — the window WRAPS past midnight, which is "
          "the arithmetic most easily got wrong",
          policy.in_quiet_hours(at_0200, quiet))
    check("08:00 is outside it", not policy.in_quiet_hours(at_0800, quiet))
    check("12:00 is outside it", not policy.in_quiet_hours(at_1200, quiet))

    held = decide(settings=quiet, now=at_2330)
    check("a HIGH alert during quiet hours is HELD",
          held.outcome == policy.HOLD_QUIET_HOURS, held.outcome)
    check("the held decision carries a deliver_after — it is scheduled, not dropped",
          held.deliver_after is not None, str(held.deliver_after))
    check("and that deliver_after is in the FUTURE",
          held.deliver_after > at_2330, f"{held.deliver_after} vs {at_2330}")
    check("the reason says the alert is open now, so nothing looks lost",
          "open now" in held.reason.lower(), held.reason)

    disabled = _settings(quiet_hours_enabled=False, quiet_hours_start="00:00",
                         quiet_hours_end="23:59")
    check("quiet hours switched off never hold anything",
          decide(settings=disabled).outcome == policy.SEND)

    opted_out = decide(_rule(respect_quiet_hours=False), settings=quiet, now=at_2330)
    check("a rule that opts out of quiet hours is sent during them",
          opted_out.outcome == policy.SEND, opted_out.outcome)

    end = policy.quiet_hours_end_utc(at_2330, quiet)
    check("quiet_hours_end_utc returns a real, future moment",
          end is not None and end > at_2330, str(end))


# ── C. Resolution notices skip everything that delays ───────────────────────
def test_resolution_notices():
    section("C. A resolution notice is news, or it is nothing")

    quiet = _settings(quiet_hours_enabled=True, quiet_hours_start="00:00",
                      quiet_hours_end="23:59")
    resolved_in_quiet = decide(settings=quiet, resolved=True)
    check("a resolution notice ignores quiet hours",
          resolved_in_quiet.outcome == policy.SEND, resolved_in_quiet.outcome)
    check("and says so", "Resolution" in resolved_in_quiet.reason, resolved_in_quiet.reason)

    resolved_digest = decide(_rule(notification_mode=policy.MODE_DAILY), resolved=True)
    check("a resolution notice is never batched into a digest",
          resolved_digest.outcome == policy.SEND, resolved_digest.outcome)

    just_notified = _alert(last_notified_at=NOW - timedelta(seconds=1))
    resolved_cooldown = decide(alert=just_notified, resolved=True)
    check("a resolution notice is not rate limited, even one second after the "
          "last notification",
          resolved_cooldown.outcome == policy.SEND, resolved_cooldown.outcome)


# ── D. Cooldown, both sides of the boundary ─────────────────────────────────
def test_cooldown():
    section("D. Cooldown boundaries and the re-open exception")

    never = _alert(last_notified_at=None)
    check("an alert never notified before is sent",
          decide(alert=never).outcome == policy.SEND)

    notified = _alert(last_notified_at=NOW - timedelta(seconds=10))
    check("repeat notifications OFF means notify once, then hold",
          decide(_rule(repeat_interval_seconds=0), alert=notified).outcome
          == policy.HOLD_COOLDOWN)
    check("the hold reason says the alert is still open",
          "still open" in decide(_rule(repeat_interval_seconds=0),
                                 alert=notified).reason.lower())

    rule = _rule(repeat_interval_seconds=3600)
    just_under = _alert(last_notified_at=NOW - timedelta(seconds=3599))
    just_over = _alert(last_notified_at=NOW - timedelta(seconds=3601))
    check("one second INSIDE the repeat interval holds",
          decide(rule, alert=just_under).outcome == policy.HOLD_COOLDOWN)
    check("one second OUTSIDE the repeat interval sends",
          decide(rule, alert=just_over).outcome == policy.SEND)

    reopened = _alert(last_notified_at=NOW - timedelta(seconds=1))
    check("a re-opened alert is sent even inside the cooldown — a re-open "
          "after a genuine resolution is news, and the previous episode's "
          "cooldown must not silence it",
          decide(alert=reopened, just_opened=True).outcome == policy.SEND)

    # A naive datetime is what actually comes back from the database on some
    # drivers; the comparison must not raise.
    naive = _alert(last_notified_at=datetime(2026, 9, 21, 11, 0, 0))
    try:
        outcome = decide(alert=naive).outcome
        raised = False
    except Exception as exc:  # noqa: BLE001
        outcome, raised = f"{type(exc).__name__}: {exc}", True
    check("a NAIVE last_notified_at does not raise (this is the realistic "
          "shape read back from the database)", not raised, str(outcome))


# ── E. Guard order, channels and silence ───────────────────────────────────
def test_guards():
    section("E. Channel, silence and guard ordering")

    no_email = _rule(notification_config={"channels": ["slack"]})
    check("a rule that does not notify by email holds with HOLD_NO_CHANNEL",
          decide(no_email).outcome == policy.HOLD_NO_CHANNEL)

    # Ordering is load-bearing: a silenced rule with no email channel must
    # report the channel, because that is the more fundamental reason.
    silenced_no_email = _rule(notification_config={"channels": ["slack"]},
                              silenced_until=NOW + timedelta(hours=1))
    check("the channel guard runs BEFORE the silence guard",
          decide(silenced_no_email).outcome == policy.HOLD_NO_CHANNEL,
          decide(silenced_no_email).outcome)

    silenced = _rule(silenced_until=NOW + timedelta(hours=1), silence_reason="maintenance")
    decision = decide(silenced)
    check("a silenced rule holds", decision.outcome == policy.HOLD_SILENCED_RULE)
    check("the silence reason is carried into the explanation",
          "maintenance" in decision.reason, decision.reason)
    check("and it states the alert was still RECORDED — silence suppresses the "
          "email, not the detection",
          "recorded" in decision.reason.lower(), decision.reason)

    expired = _rule(silenced_until=NOW - timedelta(hours=1))
    check("an EXPIRED silence no longer holds",
          decide(expired).outcome == policy.SEND)

    silenced_alert = _alert(silenced_until=NOW + timedelta(hours=1))
    check("a silenced ALERT holds, distinctly from a silenced rule",
          decide(alert=silenced_alert).outcome == policy.HOLD_SILENCED_ALERT)
    check("the silenced-alert reason says it is still open",
          "still open" in decide(alert=silenced_alert).reason.lower())

    default_channels = _rule(notification_config={})
    check("a rule with no channels configured defaults to email (so an "
          "unconfigured rule still reaches someone)",
          decide(default_channels).outcome == policy.SEND)


# ── F. Escalation: 0 means off ─────────────────────────────────────────────
def test_escalation():
    section("F. Escalation is for alerts nobody picked up")

    old = _alert(created_at=NOW - timedelta(hours=2))

    check("escalate_after_seconds = 0 means DISABLED, not 'escalate "
          "immediately' — the classic silent bug in this shape of code",
          policy.should_escalate(_rule(escalate_after_seconds=0), old, NOW) is False)
    check("a negative window is also treated as disabled",
          policy.should_escalate(_rule(escalate_after_seconds=-1), old, NOW) is False)

    rule = _rule(escalate_after_seconds=3600)
    check("an unacknowledged alert past the window escalates",
          policy.should_escalate(rule, old, NOW) is True)
    check("an alert still inside the window does not",
          policy.should_escalate(rule, _alert(created_at=NOW - timedelta(seconds=10)),
                                 NOW) is False)

    check("an ACKNOWLEDGED alert does not escalate — a human owns it, which is "
          "exactly what escalation was trying to achieve",
          policy.should_escalate(rule, _alert(created_at=NOW - timedelta(hours=2),
                                              state="ACKNOWLEDGED"), NOW) is False)
    check("a RESOLVED alert does not escalate",
          policy.should_escalate(rule, _alert(created_at=NOW - timedelta(hours=2),
                                              state="RESOLVED"), NOW) is False)
    check("an already-escalated alert does not escalate twice — escalated_at "
          "is the latch",
          policy.should_escalate(rule, _alert(created_at=NOW - timedelta(hours=2),
                                              escalated_at=NOW), NOW) is False)
    check("no alert at all does not escalate",
          policy.should_escalate(rule, None, NOW) is False)

    naive_created = _alert(created_at=datetime(2026, 9, 21, 9, 0, 0))
    try:
        escalates = policy.should_escalate(rule, naive_created, NOW)
        raised = False
    except Exception as exc:  # noqa: BLE001
        escalates, raised = f"{type(exc).__name__}", True
    check("a NAIVE created_at does not raise", not raised, str(escalates))


# ── G. The vocabulary itself ───────────────────────────────────────────────
def test_vocabulary():
    section("G. Every mode has a label, every outcome is a declared one")

    check("every notification mode has a human label — a new mode with no "
          "label renders blank in the UI",
          set(policy.MODES) == set(policy.MODE_LABELS),
          f"modes={set(policy.MODES)} labels={set(policy.MODE_LABELS)}")
    check("MODE_IMMEDIATE is one of the modes", policy.MODE_IMMEDIATE in policy.MODES)

    known = {policy.SEND, policy.HOLD_COOLDOWN, policy.HOLD_SILENCED_RULE,
             policy.HOLD_SILENCED_ALERT, policy.HOLD_QUIET_HOURS,
             policy.HOLD_DIGEST, policy.HOLD_NO_CHANNEL}
    check("every outcome constant is a distinct string", len(known) == 7, str(sorted(known)))

    # Drive a broad matrix and assert every outcome is one the caller can
    # branch on -- a typo'd outcome string would be treated as "not send",
    # silently suppressing mail.
    quiet = _settings(quiet_hours_enabled=True, quiet_hours_start="00:00",
                      quiet_hours_end="23:59")
    seen = set()
    for severity in ("CRITICAL", "HIGH", "LOW"):
        for mode in policy.MODES:
            for settings in (_settings(), quiet):
                for resolved in (False, True):
                    for just_opened in (False, True):
                        for alert in (None, _alert(last_notified_at=NOW - timedelta(seconds=5))):
                            decision = decide(
                                _rule(severity=severity, notification_mode=mode),
                                alert=alert, settings=settings,
                                resolved=resolved, just_opened=just_opened)
                            seen.add(decision.outcome)
                            if decision.outcome not in known:
                                check(f"unexpected outcome {decision.outcome!r}", False)
                            if not decision.reason:
                                check(f"outcome {decision.outcome} carried no reason", False)
    check("every outcome produced across the whole matrix is a declared one",
          seen <= known, str(sorted(seen - known)))
    check("the matrix actually exercised several distinct outcomes",
          len(seen) >= 4, str(sorted(seen)))
    check("every decision in the matrix carried a non-empty reason — an "
          "unexplained hold is indistinguishable from a bug",
          True)  # asserted inline above; this records that the sweep ran


def main():
    print("Notification policy: whether an alert's email goes out now, and why")
    print("=" * 70)
    test_critical_is_never_batched()
    test_quiet_hours()
    test_resolution_notices()
    test_cooldown()
    test_guards()
    test_escalation()
    test_vocabulary()

    print("\n" + "=" * 70)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP 0")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
