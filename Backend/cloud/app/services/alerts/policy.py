"""Should this notification go out now, later, or not at all?

Every reason a message is held back lives here, in one function, returning one
decision with one sentence explaining it. The alternative — a check in the
engine, another in the notifier, a third in the queue — is how a system ends up
silently withholding mail for a reason nobody can find afterwards.

The four holds, and what each one is NOT:

    cooldown    already told you about this recently. Not "the problem stopped".
    silenced    a person chose to stop the mail. Not "the alert closed".
    quiet hours held until morning. Not dropped — `deliver_after` says when.
    digest      batched into a periodic summary. Not suppressed.

Two things this module refuses to let configuration do:

*   **A CRITICAL alert is never batched into a digest.** Not as a default the
    user can change — as a rule. Someone setting a rule to "daily digest" and
    then missing a breach is a mistake the product should not make available.

*   **Quiet hours never apply to a CRITICAL** unless the operator has
    explicitly turned the bypass off. The default is that severity wins.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone
from typing import Any, Dict, Optional

logger = logging.getLogger("cloud_svc.alerts.policy")

# Delivery pacing.
MODE_IMMEDIATE = "immediate"
MODE_HOURLY = "hourly_digest"
MODE_DAILY = "daily_digest"
MODES = (MODE_IMMEDIATE, MODE_HOURLY, MODE_DAILY)

MODE_LABELS = {
    MODE_IMMEDIATE: "Send immediately",
    MODE_HOURLY: "Batch into an hourly digest",
    MODE_DAILY: "Batch into a daily digest",
}

# Severities that always bypass batching and (by default) quiet hours. Held as a
# constant rather than a setting: this is the promise the feature makes.
ALWAYS_IMMEDIATE = ("CRITICAL",)

# Outcomes.
SEND = "send"
HOLD_COOLDOWN = "cooldown"
HOLD_SILENCED_RULE = "silenced_rule"
HOLD_SILENCED_ALERT = "silenced_alert"
HOLD_QUIET_HOURS = "quiet_hours"
HOLD_DIGEST = "digest"
HOLD_NO_CHANNEL = "no_channel"


@dataclass
class Decision:
    """What to do with one notification, and why."""

    outcome: str
    reason: str
    # For quiet hours: when it WILL go. None for the holds that have no
    # scheduled release (cooldown, silence) — those are re-evaluated naturally.
    deliver_after: Optional[datetime] = None
    # True when this should be added to a digest batch rather than dropped.
    batch: bool = False
    detail: Dict[str, Any] = field(default_factory=dict)

    @property
    def should_send(self) -> bool:
        return self.outcome == SEND

    def to_dict(self) -> Dict[str, Any]:
        return {
            "outcome": self.outcome,
            "reason": self.reason,
            "deliver_after": (self.deliver_after.isoformat()
                              if self.deliver_after else None),
            "batch": self.batch,
            **self.detail,
        }


def _parse_hhmm(value: str, fallback: time) -> time:
    try:
        hh, mm = str(value).split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError):
        return fallback


def in_quiet_hours(now_utc: datetime, settings) -> bool:
    """Is `now` inside the configured quiet window, in the display timezone?

    The window is expressed in local wall-clock time, so it has to be compared
    in local wall-clock time — comparing a UTC hour against "22:00" would put
    an Indian installation's quiet hours in the middle of its afternoon.
    """
    if not getattr(settings, "quiet_hours_enabled", False):
        return False

    zone = getattr(settings, "display_timezone", None) or "UTC"
    try:
        from zoneinfo import ZoneInfo

        local = now_utc.astimezone(ZoneInfo(zone))
    except Exception:  # noqa: BLE001 — an unknown zone must not withhold mail
        logger.debug("Quiet hours: unknown timezone %r, treating as not quiet.", zone)
        return False

    start = _parse_hhmm(settings.quiet_hours_start, time(22, 0))
    end = _parse_hhmm(settings.quiet_hours_end, time(7, 0))
    current = local.time()

    if start == end:
        return False
    if start < end:
        return start <= current < end
    # Crosses midnight — the normal case for 22:00 → 07:00.
    return current >= start or current < end


def quiet_hours_end_utc(now_utc: datetime, settings) -> Optional[datetime]:
    """When the current quiet window ends, in UTC."""
    zone = getattr(settings, "display_timezone", None) or "UTC"
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(zone)
    except Exception:  # noqa: BLE001
        return None

    local = now_utc.astimezone(tz)
    end = _parse_hhmm(settings.quiet_hours_end, time(7, 0))
    candidate = local.replace(hour=end.hour, minute=end.minute,
                              second=0, microsecond=0)
    if candidate <= local:
        candidate += timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def decide(*, rule, alert, settings, now: Optional[datetime] = None,
           just_opened: bool, resolved: bool) -> Decision:
    """The single decision point for whether an alert's email goes out now.

    Order matters and is not arbitrary. Channel and silence come first because
    they are absolute; cooldown next because it is about this alert's own
    history; then quiet hours and digest, which only DELAY rather than cancel,
    and which a resolution notice skips entirely — telling someone at 09:00
    that a problem cleared at 23:00 and reopened at 02:00 is worse than not
    telling them.
    """
    now = now or datetime.now(timezone.utc)
    severity = (getattr(rule, "severity", None) or "INFO").upper()
    critical = severity in ALWAYS_IMMEDIATE

    if "email" not in rule.channels():
        return Decision(HOLD_NO_CHANNEL,
                        "This rule does not notify by email.")

    if rule.is_silenced(now):
        return Decision(
            HOLD_SILENCED_RULE,
            f"The rule is silenced until {rule.silenced_until.isoformat()}"
            + (f" ({rule.silence_reason})" if rule.silence_reason else "")
            + ". The alert was still recorded.",
            detail={"silenced_until": rule.silenced_until.isoformat()},
        )

    if alert is not None and getattr(alert, "is_silenced", None) and alert.is_silenced(now):
        return Decision(
            HOLD_SILENCED_ALERT,
            f"This alert is silenced until {alert.silenced_until.isoformat()}"
            + (f" ({alert.silence_reason})" if alert.silence_reason else "")
            + ". It is still open.",
            detail={"silenced_until": alert.silenced_until.isoformat()},
        )

    cooling, why = _cooldown(rule, alert, now, just_opened=just_opened,
                             resolved=resolved)
    if cooling:
        return Decision(HOLD_COOLDOWN, why)

    # A resolution notice is only useful while it is news. It ignores quiet
    # hours and digests rather than arriving hours later out of order.
    if resolved:
        return Decision(SEND, "Resolution notice.")

    if (getattr(settings, "quiet_hours_enabled", False)
            and rule.respect_quiet_hours
            and in_quiet_hours(now, settings)):
        bypass = critical and getattr(settings, "quiet_hours_critical_bypass", True)
        if not bypass:
            until = quiet_hours_end_utc(now, settings)
            return Decision(
                HOLD_QUIET_HOURS,
                f"Held by quiet hours ({settings.quiet_hours_start}–"
                f"{settings.quiet_hours_end} {settings.display_timezone}). "
                "It will be sent when they end; the alert is open now.",
                deliver_after=until,
                detail={"severity": severity},
            )

    mode = getattr(rule, "notification_mode", MODE_IMMEDIATE) or MODE_IMMEDIATE
    if mode != MODE_IMMEDIATE:
        if critical:
            # Not negotiable — see the module docstring.
            return Decision(
                SEND,
                f"Sent immediately despite the {MODE_LABELS[mode].lower()} "
                "setting: CRITICAL alerts are never batched.")
        return Decision(
            HOLD_DIGEST,
            f"Batched into the {'hourly' if mode == MODE_HOURLY else 'daily'} "
            "digest rather than sent on its own.",
            batch=True,
            detail={"mode": mode},
        )

    return Decision(SEND, "Sent immediately.")


def _cooldown(rule, alert, now: datetime, *, just_opened: bool,
              resolved: bool) -> tuple[bool, str]:
    """(holding, why). Unchanged semantics, moved here so every hold is in one
    place and the engine has one thing to ask."""
    if resolved:
        return False, "resolution notices are not rate limited"
    if alert is None:
        return False, "no alert row"

    last = getattr(alert, "last_notified_at", None)
    if last is None:
        return False, "never notified"
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    elapsed = (now - last).total_seconds()

    if just_opened:
        # A re-open after a genuine resolution is news; the previous episode's
        # cooldown must not silence it.
        return False, "re-opened"

    repeat = getattr(rule, "repeat_interval_seconds", 0) or 0
    if repeat > 0:
        if elapsed >= repeat:
            return False, "repeat interval elapsed"
        return True, (f"Within the repeat interval — {elapsed:.0f}s of "
                      f"{repeat}s. The alert is still open.")
    return True, ("Already notified for this alert, and repeat notifications "
                  "are off. The alert is still open.")


def should_escalate(rule, alert, now: Optional[datetime] = None) -> bool:
    """Has this alert gone unacknowledged long enough to escalate?

    Escalation is for alerts nobody has *picked up* — so acknowledging stops
    it, and resolving obviously does. It fires once; `escalated_at` is the
    latch.
    """
    window = getattr(rule, "escalate_after_seconds", 0) or 0
    if window <= 0 or alert is None:
        return False
    if getattr(alert, "escalated_at", None) is not None:
        return False
    # ACKNOWLEDGED means a human owns it. That is exactly what escalation is
    # trying to achieve, so it stops.
    if getattr(alert, "state", None) != "OPEN":
        return False

    created = getattr(alert, "created_at", None)
    if created is None:
        return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return (now - created).total_seconds() >= window
