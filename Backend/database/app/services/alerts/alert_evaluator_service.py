"""
Background alert evaluator — the persistent-state layer over
alert_engine_service's pure evaluation functions (which the live /alerts/active
endpoint also uses, unchanged). Runs on a fixed tick, tracks how long each
(rule, server) breach has been continuous in alert_fired_state, and enqueues
exactly one notification per resolved channel only when:
  - the breach has been sustained for >= rule.duration_seconds, AND
  - rule.cooldown_seconds has elapsed since the last notification for it.

Without this, "notify on alert" would mean "notify once per poll tick for as
long as the condition holds" — this is what makes duration_seconds/
cooldown_seconds (already columns on alert_rules) actually do something.

Same daemon-thread-polling-a-table pattern as every other scheduler in this
app (see mysql_report_email_service.py's _scheduler_loop).
"""
import logging
import threading
from datetime import datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

from app.database.connection import SessionLocal
from app.models.alert_rule_model import AlertRule
from app.models.os_server_model import OsServer
from app.models.admin_models import OrganizationMaster
from app.models.notification_model import (
    AlertFiredState, NotificationChannel, NotificationQueue, NotificationSettings, SeverityChannelRouting,
)
from app.services.alerts.alert_engine_service import applies, evaluate, techs_of, stopped_instances
from app.services.notifications import template_service

log = logging.getLogger("alert_evaluator")

TICK_SECONDS = 30
DEFAULT_TIMEZONE = "Asia/Kolkata"  # IST — this deployment's default, configurable in Settings → Notifications


def _org_timezone(db, org_id: int) -> ZoneInfo:
    row = db.query(NotificationSettings).filter(NotificationSettings.org_id == org_id).first()
    tz_name = (row.timezone if row else None) or DEFAULT_TIMEZONE
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo(DEFAULT_TIMEZONE)


def _format_local(dt: datetime, tz: ZoneInfo) -> str:
    """`dt` is a naive UTC datetime (everything in this app is stored/compared
    in UTC) — attach that fact, then convert to the org's configured
    timezone only for display, e.g. {{Timestamp}} in a notification."""
    aware_utc = dt.replace(tzinfo=dt_timezone.utc)
    local = aware_utc.astimezone(tz)
    return local.strftime("%Y-%m-%d %H:%M:%S %Z")


def _scope_key(server) -> str:
    return f"server:{server.id}"


def _resolve_channels(db, rule: AlertRule) -> list:
    """The rule's own channel selection if it has one, else the org's
    severity-based default routing — filtered to channels that are actually
    enabled/configured, so a rule never silently 'fires' into an unset
    channel."""
    org_id = rule.org_id or 1
    wanted = list(rule.notification_channel_types or [])
    if not wanted:
        routes = (
            db.query(SeverityChannelRouting)
            .filter(
                SeverityChannelRouting.org_id == org_id,
                SeverityChannelRouting.severity == (rule.severity or "warning"),
                SeverityChannelRouting.enabled == True,
            )
            .all()
        )
        wanted = [r.channel_type for r in routes]
    if not wanted:
        return []
    enabled = {
        c.channel_type
        for c in db.query(NotificationChannel)
        .filter(
            NotificationChannel.org_id == org_id,
            NotificationChannel.channel_type.in_(wanted),
            NotificationChannel.enabled == True,
        )
        .all()
    }
    resolved = [c for c in wanted if c in enabled]

    # Email has no org-wide default recipient — send_via_channel() rejects it
    # outright ("no recipient configured for this alert rule", see
    # email_channel_service.py's own docstring on why there's no fallback
    # mailbox). Enqueueing it anyway just means a job that's guaranteed to
    # fail, retried three times, then a permanent "failed" row in Notification
    # History — for every breach, forever. Drop it here instead: nothing to
    # send it to means nothing gets attempted.
    if "email" in resolved and not (rule.notification_recipients or rule.notification_cc or rule.notification_bcc):
        resolved = [c for c in resolved if c != "email"]
    return resolved


def _enqueue(db, rule: AlertRule, server, value, threshold, message, channels: list, breach_started_at):
    stack = techs_of(server) or "—"
    down_since = breach_started_at

    if rule.metric == "service_down":
        # Name the SPECIFIC service(s) that are actually down, not every
        # technology installed on the host — and surface the real check
        # output (e.g. systemctl status) instead of leaving Error blank.
        stopped = stopped_instances(server)
        database_name = ", ".join(i.db_type for i in stopped) or stack
        error = "\n\n".join(f"{i.db_type}:\n{i.status_detail}" for i in stopped if i.status_detail)
        changed_ats = [i.status_changed_at for i in stopped if i.status_changed_at]
        if changed_ats:
            # The instance's own last-checked transition is more precise
            # than the rule's sustain-window start when we have it.
            down_since = min(changed_ats)
    else:
        database_name = stack
        error = ""

    org_id = rule.org_id or 1
    org = db.query(OrganizationMaster).filter(OrganizationMaster.org_id == org_id).first()
    organization = org.org_name if org else str(org_id)
    tz = _org_timezone(db, org_id)

    context = template_service.build_context(
        organization=organization,
        alert_name=rule.name,
        severity=(rule.severity or "warning").title(),
        server_name=server.server_name or "",
        hostname=server.hostname or server.server_name or "",
        database_name=database_name,
        database_type=database_name,
        metric=rule.metric,
        current_value=value or "",
        threshold=threshold or "—",
        error=error,
        ip_address=server.ip_address or "",
        timestamp=_format_local(down_since, tz),
        alert_description=message or "",
    )
    for ch in channels:
        db.add(NotificationQueue(
            org_id=rule.org_id or 1,
            alert_rule_id=rule.id,
            channel_type=ch,
            payload={
                "context": context,
                "recipients_override": rule.notification_recipients or [],
                "cc_override": rule.notification_cc or [],
                "bcc_override": rule.notification_bcc or [],
            },
        ))
    db.commit()


def _tick():
    with SessionLocal() as db:
        now = datetime.utcnow()
        rules = db.query(AlertRule).filter(AlertRule.enabled.is_(True)).all()
        servers = db.query(OsServer).all()

        breaching_keys = set()
        for server in servers:
            for rule in rules:
                if not applies(rule, server):
                    continue
                res = evaluate(rule, server)
                if not res:
                    continue
                value, threshold, message = res
                scope_key = _scope_key(server)
                breaching_keys.add((rule.id, scope_key))

                state = (
                    db.query(AlertFiredState)
                    .filter(AlertFiredState.alert_rule_id == rule.id, AlertFiredState.scope_key == scope_key)
                    .first()
                )
                if not state:
                    state = AlertFiredState(
                        alert_rule_id=rule.id, scope_key=scope_key,
                        first_breach_at=now, last_breach_at=now, is_firing=False,
                    )
                    db.add(state)
                else:
                    state.last_breach_at = now
                db.commit()

                sustained = (now - state.first_breach_at) >= timedelta(seconds=rule.duration_seconds or 0)
                cooled_down = state.last_notified_at is None or (now - state.last_notified_at) >= timedelta(seconds=rule.cooldown_seconds or 0)

                if sustained and cooled_down:
                    channels = _resolve_channels(db, rule)
                    if channels:
                        _enqueue(db, rule, server, value, threshold, message, channels, state.first_breach_at)
                        # Only start the cooldown clock once something was
                        # actually sent — a rule with no channel resolved yet
                        # (nothing configured for its severity) must fire
                        # immediately the moment a channel IS configured,
                        # not wait out a cooldown that never really started.
                        state.last_notified_at = now
                        state.is_firing = True
                        db.commit()

        # A (rule, scope) no longer breaching resets — the next breach starts
        # a fresh sustain window instead of firing instantly off a stale
        # first_breach_at from a previous, unrelated incident.
        for st in db.query(AlertFiredState).all():
            if (st.alert_rule_id, st.scope_key) not in breaching_keys:
                db.delete(st)
        db.commit()


_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def _loop():
    while not _stop.is_set():
        try:
            _tick()
        except Exception:  # noqa: BLE001 — one bad tick must not kill the evaluator
            log.exception("Alert evaluator tick failed")
        _stop.wait(TICK_SECONDS)


def start_alert_evaluator():
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="alert_evaluator")
        _thread.start()


def stop_alert_evaluator():
    _stop.set()
