"""The alert engine: evaluate, deduplicate, notify, resolve.

The shape of one pass:

    due rules  →  group by account  →  one EvalContext per account
                                            │
                              evaluate each rule against it
                                            │
                       ┌────────────────────┴────────────────────┐
              conclusive result                        inconclusive result
                       │                                         │
          TRIGGERED → fingerprint → upsert alert      record it on the rule,
          NOT_TRIGGERED → resolve open alert          change NOTHING about any
                       │                              open alert, notify nobody
              cooldown / repeat check
                       │
              queue email → audit

Four behaviours are load-bearing and each exists because its absence produces a
specific, known failure:

**Fingerprints, not timestamps.** A rule evaluated every five minutes against a
condition that stays true would otherwise create 288 alerts and 288 emails a
day. The fingerprint is derived from (rule, account, condition, subject), so a
recurrence updates one alert row.

**Cooldown is separate from lifecycle.** An alert stays OPEN through its
cooldown; it just stops emailing. Conflating the two would mean either
resolving a live problem to stop the mail, or mailing forever.

**Inconclusive never resolves.** UNKNOWN, ERROR and UNSUPPORTED leave open
alerts exactly as they were. A throttled billing API is not evidence that
spend went down.

**Queued is not sent.** The engine can truthfully say it queued a message. Only
the database service's dispatcher learns whether it was delivered, and it
records that in notification_history. The two states are reported separately
everywhere.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import (
    ACTIVE_STATES, STATE_ACKNOWLEDGED, STATE_OPEN, STATE_PENDING, STATE_RESOLVED,
    CloudAlert,
)
from app.models.alert_rule import (
    ACT_ALERT_ESCALATED, ACT_ALERT_RESOLVED, ACT_ALERT_TRIGGERED, ACT_EVAL_ERROR,
    ACT_EVAL_UNKNOWN, ACT_NOTIFY_QUEUED, ACT_NOTIFY_SKIPPED, EVAL_ERROR,
    EVAL_INCONCLUSIVE, EVAL_NOT_TRIGGERED, EVAL_TRIGGERED, EVAL_UNKNOWN,
    EVAL_UNSUPPORTED, CloudAlertRule,
)
from app.repository.alert_repo import AlertRepository
from app.repository.alert_rule_repo import AlertRuleRepository
from app.services.alerts import catalog, evaluators, notifier, policy
from app.services.alerts.result import Evaluation

logger = logging.getLogger("cloud_svc.alerts.engine")

# A policy hold maps to the status stored on the alert row, so the UI can say
# WHICH kind of hold it was rather than lumping them all under "suppressed".
_STATUS_FOR_HOLD = {
    policy.HOLD_COOLDOWN: notifier.NOTIFY_SKIPPED_COOLDOWN,
    policy.HOLD_SILENCED_RULE: notifier.NOTIFY_SILENCED,
    policy.HOLD_SILENCED_ALERT: notifier.NOTIFY_SILENCED,
    policy.HOLD_QUIET_HOURS: notifier.NOTIFY_QUIET_HOURS,
    policy.HOLD_DIGEST: notifier.NOTIFY_DIGEST_PENDING,
    policy.HOLD_NO_CHANNEL: notifier.NOTIFY_NO_CHANNEL,
}

# How often the loop wakes. Individual rules still honour their own interval —
# this is only the granularity at which "is anything due" is asked.
TICK_SECONDS = 60
# Most rules a single pass will evaluate. A bound rather than "all of them" so
# one enormous installation cannot turn a tick into a ten-minute transaction;
# whatever is left is simply the most overdue next time round.
MAX_RULES_PER_TICK = 200
# After this many consecutive ERROR results a rule stops being evaluated on
# every tick and backs off, so a permanently broken evaluator does not burn a
# slot forever. It is not disabled — that would be a silent decision about
# somebody's monitoring.
ERROR_BACKOFF_AFTER = 5


def base_url() -> Optional[str]:
    """Where the deep links in alert email should point.

    None when unset, and a link is simply omitted rather than pointing at a
    guessed hostname — a broken "View in Actmon" button is worse than none.
    """
    value = (os.getenv("ACTMON_PUBLIC_URL") or os.getenv("CLOUD_PUBLIC_URL") or "").strip()
    return value or None


def _aware(value: Optional[datetime]) -> datetime:
    """Treat a naive timestamp as UTC, which is what the database stores."""
    if value is None:
        return datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def fingerprint(rule: CloudAlertRule, subject: Optional[str]) -> str:
    """Stable identity for one condition on one thing.

    Hashed rather than concatenated because `subject` can be an ARN or an OCID
    and `dedupe_key` is a bounded, UNIQUE column — a truncated key would
    collide two different resources into one alert. The rule id is included so
    two rules watching the same resource keep separate alerts, and the
    condition type is included so editing a rule's condition starts a new
    alert rather than silently re-labelling the old one.
    """
    raw = "|".join([
        "cloudrule",
        str(rule.id),
        str(rule.account_id),
        rule.condition_type,
        str(rule.condition_version),
        subject or "-",
    ])
    return "RULE:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AlertEngine:
    """One pass of evaluation. Constructed per tick, not held across ticks."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.rules = AlertRuleRepository(db)
        self.alerts = AlertRepository(db)
        self._timezone: Optional[str] = None
        self._settings_row = None

    # ── Public entry points ──────────────────────────────────────────────────
    async def run_once(self, *, limit: int = MAX_RULES_PER_TICK) -> Dict[str, Any]:
        """Evaluate every due rule. Returns a summary for the health panel."""
        started = time.monotonic()
        due = await self.rules.due_rules(limit=limit)

        # Grouped so twenty rules on one account share one EvalContext and
        # therefore one read of each source, rather than twenty.
        by_account: Dict[uuid.UUID, List[CloudAlertRule]] = {}
        for rule in due:
            by_account.setdefault(rule.account_id, []).append(rule)

        totals = {"rules_evaluated": 0, "triggered": 0, "resolved": 0,
                  "unknown": 0, "errors": 0, "notifications_queued": 0}

        # NOTE: this deliberately does NOT return early when nothing is due.
        # Escalation and digests are driven by time passing, not by a rule
        # being re-evaluated — and an installation with no rules currently due
        # is precisely the one where an alert has been sitting unacknowledged.
        # Returning early here would mean escalation never fired on a quiet
        # system, which is the only kind of system it exists for.

        from app.repository.cloud_account_repo import CloudAccountRepository

        accounts_repo = CloudAccountRepository(self.db)
        for account_id, rules in by_account.items():
            account = await accounts_repo.get_by_id(account_id)
            if account is None:
                # The rule's FK cascades on account delete, so this is a race
                # rather than a normal state. Skip rather than crash the pass.
                logger.warning("Skipping %d rule(s): account %s is gone.",
                               len(rules), account_id)
                continue
            ctx = evaluators.EvalContext(self.db, account)
            for rule in rules:
                try:
                    outcome = await self.evaluate_rule(rule, ctx=ctx, account=account)
                except Exception:  # noqa: BLE001 — one rule must not stop the pass
                    logger.exception("Alert rule %s crashed the engine", rule.id)
                    await self.db.rollback()
                    continue
                totals["rules_evaluated"] += 1
                state = outcome["evaluation"].state
                if state == EVAL_TRIGGERED:
                    totals["triggered"] += 1
                elif outcome.get("resolved"):
                    totals["resolved"] += 1
                if state == EVAL_UNKNOWN or state == EVAL_UNSUPPORTED:
                    totals["unknown"] += 1
                elif state == EVAL_ERROR:
                    totals["errors"] += 1
                if outcome.get("notification_queued"):
                    totals["notifications_queued"] += 1

        # Escalation and digests are time-driven rather than condition-driven,
        # so they run once per pass regardless of which rules were due. Each is
        # wrapped: neither is allowed to lose a pass's evaluation work.
        for label, coro in (
            ("escalations", self.escalate_stale()),
            ("hourly_digests", self.send_digests(policy.MODE_HOURLY)),
            ("daily_digests", self.send_digests(policy.MODE_DAILY)),
        ):
            try:
                totals[label] = await coro
            except Exception:  # noqa: BLE001
                logger.exception("Alert pass: %s failed", label)
                totals[label] = None

        await self.db.commit()
        totals["duration_ms"] = round((time.monotonic() - started) * 1000, 1)
        logger.info("Alert pass: %s", totals)
        return totals

    async def evaluate_rule(
        self, rule: CloudAlertRule, *,
        ctx: Optional[evaluators.EvalContext] = None,
        account=None,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """Evaluate one rule and act on the result.

        `dry_run=True` is the "Test rule" button: it evaluates against real
        data and returns the real answer, but creates no alert, sends no email
        and does not move the rule's own state. A test that fabricates an alert
        to make the UI look successful teaches the operator nothing.
        """
        if account is None:
            from app.repository.cloud_account_repo import CloudAccountRepository

            account = await CloudAccountRepository(self.db).get_by_id(rule.account_id)
            if account is None:
                raise ValueError(f"Account {rule.account_id} not found")
        if ctx is None:
            ctx = evaluators.EvalContext(self.db, account)

        started = time.monotonic()
        evaluation = await evaluators.evaluate(
            ctx, rule.condition_type, rule.condition_config or {},
            rule.scope_config or {},
        )
        elapsed_ms = round((time.monotonic() - started) * 1000, 2)
        human = catalog.describe(rule.condition_type, rule.condition_config,
                                rule.scope_config, account.account_name)

        if dry_run:
            return {
                "evaluation": evaluation, "dry_run": True,
                "condition_human": human, "duration_ms": elapsed_ms,
                "explain": evaluation.explain(human),
            }

        outcome: Dict[str, Any] = {
            "evaluation": evaluation, "condition_human": human,
            "duration_ms": elapsed_ms, "resolved": False,
            "notification_queued": False, "alert": None,
        }

        if evaluation.state in EVAL_INCONCLUSIVE:
            await self._handle_inconclusive(rule, evaluation, elapsed_ms)
            return outcome

        if evaluation.state == EVAL_TRIGGERED:
            alert, just_opened, notified, pending = await self._handle_triggered(
                rule, evaluation, account, human)
            outcome["alert"] = alert
            outcome["notification_queued"] = notified
            outcome["just_opened"] = just_opened
            outcome["pending"] = pending
        else:
            outcome["resolved"] = await self._handle_cleared(
                rule, evaluation, account, human)

        self._stamp(rule, evaluation, elapsed_ms)
        rule.consecutive_errors = 0
        await self.db.flush()
        return outcome

    # ── Result handling ──────────────────────────────────────────────────────
    async def _handle_inconclusive(self, rule: CloudAlertRule,
                                   evaluation: Evaluation, elapsed_ms: float) -> None:
        """Record that we could not tell — and change nothing else.

        In particular: no alert is opened, no alert is resolved, and no email
        is sent. The rule's status carries the reason so the UI can show
        "Evaluation unavailable" rather than a stale "OK".
        """
        previous = rule.last_result
        self._stamp(rule, evaluation, elapsed_ms)
        if evaluation.state == EVAL_ERROR:
            rule.consecutive_errors = (rule.consecutive_errors or 0) + 1
        else:
            rule.consecutive_errors = 0

        # Audited only on a CHANGE of state, not on every tick. A billing API
        # throttled for a day would otherwise write 288 identical audit rows
        # and bury the events that matter.
        if previous != evaluation.state:
            await self.rules.record(
                action=(ACT_EVAL_ERROR if evaluation.state == EVAL_ERROR
                        else ACT_EVAL_UNKNOWN),
                rule=rule,
                severity=rule.severity,
                summary=(f"{rule.name}: {evaluation.state} — "
                         f"{evaluation.detail or 'no detail reported'}"),
                detail={"state": evaluation.state, "detail": evaluation.detail,
                        "previous_state": previous},
            )
        if (rule.consecutive_errors or 0) >= ERROR_BACKOFF_AFTER:
            # Back off without disabling. Pushing last_evaluated_at forward is
            # the whole mechanism: the due query will not pick it up again for
            # a while, and it self-heals the moment one evaluation succeeds.
            rule.last_evaluated_at = datetime.now(timezone.utc) + timedelta(
                seconds=min(rule.evaluation_interval_seconds * 10, 3600))
            logger.warning(
                "Rule %s has failed %d times consecutively; backing off. Last "
                "error: %s", rule.id, rule.consecutive_errors, evaluation.detail)
        await self.db.flush()

    async def _handle_triggered(
        self, rule: CloudAlertRule, evaluation: Evaluation, account,
        human: str,
    ) -> Tuple[Optional[dict], bool, bool, bool]:
        key = fingerprint(rule, evaluation.subject)
        details = self._alert_text(rule, evaluation, account, human)

        alert, just_opened = await self.alerts.upsert(
            anomaly_type=f"{rule.category.upper()}:{rule.condition_type}",
            details=details,
            severity=rule.severity,
            dedupe_key=key,
            account_id=rule.account_id,
            resource_name=evaluation.subject_name,
            context={
                "rule_id": str(rule.id),
                "rule_name": rule.name,
                "condition": human,
                "explain": evaluation.explain(human),
                "scope": rule.scope_config or {},
            },
        )
        # cloud_alerts predates rules, so the link is set here rather than in
        # upsert(), which is shared with the pre-existing storage-attachment
        # rule that has no CloudAlertRule behind it.
        alert.rule_id = rule.id

        # ── False-positive protection ────────────────────────────────────────
        # A brand-new breach on a rule with a duration or consecutive-read bar
        # is parked in PENDING rather than opened. It is not in the feed, not in
        # the counts, and notifies nobody, until the bar is cleared — at which
        # point it becomes a normal OPEN alert with its first-seen time intact,
        # so the alert correctly says the problem started when it started rather
        # than when we admitted it.
        held, hold_reason = self._within_holdoff(rule, alert)
        if held:
            alert.state = STATE_PENDING
            alert.is_read = True
            alert.notification_status = None
            await self.db.flush()
            logger.debug("Rule %s breach held: %s", rule.id, hold_reason)
            return alert.to_dict(), False, False, True

        # The bar has been cleared (or there was none). A row coming out of
        # PENDING is opening for the first time, so it must be treated as newly
        # opened even though upsert saw an existing row.
        if alert.state == STATE_PENDING:
            alert.state = STATE_OPEN
            alert.is_read = False
            just_opened = True

        if just_opened:
            rule.last_triggered_at = datetime.now(timezone.utc)
            rule.trigger_count = (rule.trigger_count or 0) + 1
            await self.rules.record(
                action=ACT_ALERT_TRIGGERED, rule=rule, alert_id=alert.id,
                severity=rule.severity,
                summary=f"{rule.name} triggered: {evaluation.detail or human}",
                detail={"explain": evaluation.explain(human),
                        "fingerprint": key,
                        "reopened": alert.occurrence_count > 1},
            )

        notified = await self._maybe_notify(
            rule, alert, evaluation, account, human,
            just_opened=just_opened, resolved=False)
        return alert.to_dict(), just_opened, notified, False

    def _within_holdoff(self, rule: CloudAlertRule, alert) -> Tuple[bool, str]:
        """Should this breach still be held back? (held, why).

        Both bars must be satisfied. `occurrence_count` is the number of
        evaluations that have seen this exact fingerprint breaching, and
        `created_at` is when the first one did — both maintained by the same
        upsert that deduplicates, so there is no separate counter to drift.

        An alert already OPEN or ACKNOWLEDGED is never re-held: the bar is for
        getting in, not for staying in.
        """
        if alert.state in (STATE_OPEN, STATE_ACKNOWLEDGED):
            return False, "already open"

        required = max(1, rule.consecutive_breaches_required or 1)
        seen = alert.occurrence_count or 1
        if seen < required:
            return True, f"{seen} of {required} consecutive evaluations"

        window = rule.min_duration_seconds or 0
        if window > 0:
            first = alert.created_at
            if first is not None:
                if first.tzinfo is None:
                    first = first.replace(tzinfo=timezone.utc)
                held_for = (datetime.now(timezone.utc) - first).total_seconds()
                if held_for < window:
                    return True, (f"breaching for {held_for:.0f}s of the "
                                  f"{window}s minimum")
        return False, "bar cleared"

    async def _handle_cleared(self, rule: CloudAlertRule, evaluation: Evaluation,
                              account, human: str) -> bool:
        """The condition is measurably false. Close the open alert, if any."""
        key = fingerprint(rule, evaluation.subject)
        existing = await self.alerts.get_by_dedupe_key(key)
        if existing is None or existing.state == STATE_RESOLVED:
            return False

        # A breach that cleared before it ever qualified as an alert is deleted,
        # not resolved. Leaving a RESOLVED row would put a transient spike in
        # the history claiming an incident occurred and was handled — which is
        # the opposite of what the minimum-duration bar is for, and would make
        # the noisy-rule analysis count blips as real alerts.
        if existing.state == STATE_PENDING:
            await self.db.delete(existing)
            await self.db.flush()
            logger.debug(
                "Discarded a held breach for rule %s: the condition cleared "
                "before it qualified as an alert.", rule.id)
            return False

        existing.state = STATE_RESOLVED
        existing.resolved_at = datetime.now(timezone.utc)
        existing.resolved_by = "alert-engine"
        existing.resolution_reason = (
            f"The condition is no longer met: {evaluation.detail or human}")
        existing.is_read = True
        await self.db.flush()

        await self.rules.record(
            action=ACT_ALERT_RESOLVED, rule=rule, alert_id=existing.id,
            severity=rule.severity,
            summary=(f"{rule.name} resolved automatically: "
                     f"{evaluation.detail or 'the condition is no longer met'}"),
            detail={"explain": evaluation.explain(human), "fingerprint": key},
        )
        if rule.notify_on_resolution:
            await self._maybe_notify(
                rule, existing, evaluation, account, human,
                just_opened=False, resolved=True, ignore_cooldown=True)
        return True

    # ── Notification ─────────────────────────────────────────────────────────
    async def _maybe_notify(
        self, rule: CloudAlertRule, alert, evaluation: Evaluation, account,
        human: str, *, just_opened: bool, resolved: bool,
        ignore_cooldown: bool = False,
    ) -> bool:
        """Decide whether to queue mail, and queue it. Returns True if queued.

        The decision itself lives in `policy.decide`, so that every reason a
        message is held back has one home and one sentence. This method only
        acts on the answer.
        """
        now = datetime.now(timezone.utc)
        settings = await self._settings()

        decision = policy.decide(
            rule=rule, alert=alert, settings=settings, now=now,
            just_opened=just_opened or ignore_cooldown, resolved=resolved)

        if not decision.should_send:
            alert.notification_status = _STATUS_FOR_HOLD.get(
                decision.outcome, notifier.NOTIFY_SKIPPED_COOLDOWN)

            # A plain cooldown is the rule working as designed, so it is logged
            # rather than audited — auditing it on every tick would drown the
            # events worth reading. Every other hold IS audited, because each
            # one is a decision somebody will later need explained.
            if decision.outcome == policy.HOLD_COOLDOWN:
                logger.debug("Notification held for %s: %s", rule.id, decision.reason)
            else:
                await self._audit_notify_skip(
                    rule, alert, decision.reason, decision.to_dict())
            return False

        recipients = await notifier.resolve_recipients(self.db, rule)
        if recipients["total"] == 0:
            alert.notification_status = notifier.NOTIFY_NO_RECIPIENT
            await self._audit_notify_skip(
                rule, alert,
                "No recipient is configured for this rule or for the account, "
                "so no email could be sent. The alert itself was still "
                "recorded." + (
                    f" {len(recipients['invalid'])} configured address(es) are "
                    "not valid email addresses and were skipped."
                    if recipients["invalid"] else ""),
                {"invalid": recipients["invalid"]})
            return False

        delivery = await notifier.delivery_status(self.db)
        if not delivery["ready"]:
            alert.notification_status = (
                notifier.NOTIFY_CHANNEL_DISABLED if delivery["smtp_configured"]
                else notifier.NOTIFY_NOT_CONFIGURED)
            await self._audit_notify_skip(
                rule, alert,
                "Email delivery is not ready, so nothing was queued: "
                + "; ".join(b["message"] for b in delivery["blockers"]),
                {"blockers": delivery["blockers"]})
            return False

        mail = notifier.compose_alert_email(
            rule=rule, alert=alert, evaluation=evaluation, account=account,
            condition_human=human, base_url=base_url(), resolved=resolved,
            timezone_name=await self._display_timezone(),
        )
        queued, message = await notifier.queue_email(
            self.db,
            subject=mail["subject"], html_body=mail["html"], text_body=mail["text"],
            to=recipients["to"], cc=recipients["cc"], bcc=recipients["bcc"],
            # These keys are what notification_history indexes on, so a cloud
            # alert's delivery record is as searchable as a database alert's.
            context={
                "AlertName": rule.name,
                "ServerName": getattr(account, "account_name", None) or "—",
                "DatabaseName": rule.category,
                "Severity": (rule.severity or "").title(),
                "AlertDescription": evaluation.detail or human,
                "Timestamp": now.isoformat(),
            },
        )
        if not queued:
            alert.notification_status = notifier.NOTIFY_FAILED_TO_QUEUE
            await self._audit_notify_skip(rule, alert, message, None)
            return False

        # QUEUED, not SENT. Whether it left the building is the dispatcher's
        # finding, and it records that in notification_history.
        alert.notification_status = notifier.NOTIFY_QUEUED
        alert.last_notified_at = now
        alert.notification_count = (alert.notification_count or 0) + 1
        await self.rules.record(
            action=ACT_NOTIFY_QUEUED, rule=rule, alert_id=alert.id,
            severity=rule.severity,
            summary=(f"{'Resolution n' if resolved else 'N'}otification queued "
                     f"for {rule.name} to {len(recipients['to'])} recipient(s)."),
            detail={"to": recipients["to"], "cc": recipients["cc"],
                    "bcc_count": len(recipients["bcc"]),
                    "resolved": resolved, "subject": mail["subject"],
                    "from_account_defaults": recipients["uses_account_defaults"]},
        )
        await self.db.flush()
        return True

    async def _settings(self):
        """The one settings row, read once per pass.

        Cached on the engine instance: one pass can make dozens of delivery
        decisions and the policy cannot change mid-pass.
        """
        if self._settings_row is None:
            self._settings_row = await get_settings(self.db)
        return self._settings_row

    async def _display_timezone(self) -> str:
        """The zone email timestamps are rendered in."""
        if self._timezone is None:
            try:
                settings = await self._settings()
                self._timezone = settings.display_timezone or notifier.DEFAULT_TIMEZONE
            except Exception as exc:  # noqa: BLE001 — never block an alert on this
                logger.debug("Could not read the display timezone: %s", exc)
                self._timezone = notifier.DEFAULT_TIMEZONE
        return self._timezone

    # ── Escalation ───────────────────────────────────────────────────────────
    async def escalate_stale(self) -> int:
        """Notify a second set of recipients about alerts nobody has picked up.

        Runs as its own sweep rather than inside rule evaluation, because the
        thing that makes an alert escalate is TIME PASSING, not the condition
        being re-checked — an hourly rule would otherwise escalate up to an hour
        late, and a disabled rule's open alerts would never escalate at all.

        Fires once per alert; `escalated_at` is the latch. Acknowledging stops
        it, because being picked up is exactly the outcome escalation wants.
        """
        from sqlalchemy import select

        from app.repository.cloud_account_repo import CloudAccountRepository

        candidates = (await self.db.execute(
            select(CloudAlert, CloudAlertRule)
            .join(CloudAlertRule, CloudAlertRule.id == CloudAlert.rule_id)
            .where(
                CloudAlert.state == STATE_OPEN,
                CloudAlert.escalated_at.is_(None),
                CloudAlertRule.escalate_after_seconds > 0,
                CloudAlertRule.deleted_at.is_(None),
            ).limit(100)
        )).all()

        accounts = CloudAccountRepository(self.db)
        sent = 0
        now = datetime.now(timezone.utc)
        for alert, rule in candidates:
            if not policy.should_escalate(rule, alert, now):
                continue
            recipients = (rule.notification_config or {}).get(
                "escalation_recipients") or []
            recipients = [a for a in recipients if notifier.valid_email(a)]
            # Latched either way. A rule configured to escalate to nobody has a
            # configuration problem, and retrying it every minute forever turns
            # that into a log flood rather than surfacing it.
            alert.escalated_at = now
            if not recipients:
                await self.rules.record(
                    action=ACT_ALERT_ESCALATED, rule=rule, alert_id=alert.id,
                    severity=rule.severity,
                    summary=(f"{rule.name}: escalation was due but no escalation "
                             "recipients are configured, so nobody was told."),
                    detail={"unacknowledged_for_seconds":
                            int((now - _aware(alert.created_at)).total_seconds())})
                continue

            account = await accounts.get_by_id(alert.account_id)
            if account is None:
                continue

            mail = notifier.compose_escalation_email(
                rule=rule, alert=alert, account=account,
                base_url=base_url(), timezone_name=await self._display_timezone(),
                unacknowledged_for=(now - _aware(alert.created_at)),
            )
            queued, message = await notifier.queue_email(
                self.db, subject=mail["subject"], html_body=mail["html"],
                text_body=mail["text"], to=recipients,
                context={"AlertName": f"[ESCALATED] {rule.name}",
                         "ServerName": account.account_name,
                         "Severity": (rule.severity or "").title(),
                         "AlertDescription": alert.details or "",
                         "Timestamp": now.isoformat()})
            await self.rules.record(
                action=ACT_ALERT_ESCALATED, rule=rule, alert_id=alert.id,
                severity=rule.severity,
                summary=(f"{rule.name} escalated to {len(recipients)} recipient(s) "
                         "after going unacknowledged."
                         if queued else
                         f"{rule.name}: escalation could not be queued — {message}"),
                detail={"to": recipients, "queued": queued})
            if queued:
                sent += 1
        if candidates:
            await self.db.flush()
        return sent

    # ── Digest ───────────────────────────────────────────────────────────────
    async def send_digests(self, cadence: str) -> int:
        """One summary per account of everything batched since the last one.

        Grouped per account rather than per rule: a person who set three rules
        to daily digest wants one email a day, not three. CRITICAL alerts are
        never in here — `policy.decide` sends those immediately regardless of
        the rule's mode, so a digest cannot swallow one.
        """
        from sqlalchemy import select

        from app.repository.cloud_account_repo import CloudAccountRepository

        settings = await self._settings()
        field = ("last_hourly_digest_at" if cadence == policy.MODE_HOURLY
                 else "last_daily_digest_at")
        window = timedelta(hours=1) if cadence == policy.MODE_HOURLY else timedelta(days=1)

        last = getattr(settings, field, None)
        now = datetime.now(timezone.utc)
        if last is not None and (now - _aware(last)) < window:
            return 0

        since = _aware(last) if last else now - window
        rows = (await self.db.execute(
            select(CloudAlert, CloudAlertRule)
            .join(CloudAlertRule, CloudAlertRule.id == CloudAlert.rule_id)
            .where(
                CloudAlert.created_at >= since,
                CloudAlert.state != STATE_PENDING,
                CloudAlertRule.notification_mode == cadence,
                CloudAlertRule.deleted_at.is_(None),
            ).order_by(CloudAlert.created_at.desc()).limit(500)
        )).all()

        setattr(settings, field, now)
        if not rows:
            await self.db.flush()
            return 0

        by_account: Dict[Any, list] = {}
        for alert, rule in rows:
            if rule.is_silenced(now) or alert.is_silenced(now):
                continue
            by_account.setdefault(alert.account_id, []).append((alert, rule))

        accounts = CloudAccountRepository(self.db)
        sent = 0
        for account_id, items in by_account.items():
            account = await accounts.get_by_id(account_id)
            if account is None:
                continue
            # Recipients are the union across the rules that contributed, so a
            # digest reaches everyone who would have received the individual
            # mails and nobody who would not.
            to: list = []
            for _alert, rule in items:
                resolved = await notifier.resolve_recipients(self.db, rule)
                to.extend(resolved["to"])
            to = list(dict.fromkeys(to))
            if not to:
                continue

            mail = notifier.compose_digest_email(
                account=account, items=items, cadence=cadence,
                since=since, until=now, base_url=base_url(),
                timezone_name=await self._display_timezone())
            queued, message = await notifier.queue_email(
                self.db, subject=mail["subject"], html_body=mail["html"],
                text_body=mail["text"], to=to,
                context={"AlertName": mail["subject"],
                         "ServerName": account.account_name,
                         "Severity": "Information",
                         "AlertDescription": f"{len(items)} alert(s).",
                         "Timestamp": now.isoformat()})
            for alert, _rule in items:
                if queued:
                    alert.notification_status = notifier.NOTIFY_QUEUED
                    alert.last_notified_at = now
                    alert.notification_count = (alert.notification_count or 0) + 1
            await self.rules.record(
                action=ACT_NOTIFY_QUEUED, account_id=account_id,
                summary=(f"{cadence.replace('_', ' ').title()} queued for "
                         f"{len(to)} recipient(s) covering {len(items)} alert(s)."
                         if queued else f"Digest could not be queued: {message}"),
                detail={"to": to, "alerts": len(items), "cadence": cadence})
            if queued:
                sent += 1

        await self.db.flush()
        return sent

    def _cooldown_check(self, rule: CloudAlertRule, alert, now: datetime,
                        just_opened: bool) -> Tuple[bool, str]:
        last = alert.last_notified_at
        if last is None:
            return True, "never notified"
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        elapsed = (now - last).total_seconds()

        if just_opened:
            # A re-open after a genuine resolution is news, and the cooldown of
            # the previous episode should not silence it.
            return True, "re-opened"
        if rule.repeat_interval_seconds and rule.repeat_interval_seconds > 0:
            if elapsed >= rule.repeat_interval_seconds:
                return True, "repeat interval elapsed"
            return False, (f"repeat interval not elapsed "
                           f"({elapsed:.0f}s of {rule.repeat_interval_seconds}s)")
        # No repeat configured: notify once per episode, full stop.
        return False, "already notified for this alert and repeats are off"

    async def _audit_notify_skip(self, rule: CloudAlertRule, alert,
                                 summary: str, detail: Optional[dict]) -> None:
        await self.rules.record(
            action=ACT_NOTIFY_SKIPPED, rule=rule, alert_id=alert.id,
            severity=rule.severity,
            summary=f"{rule.name}: {summary}", detail=detail)
        await self.db.flush()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _alert_text(self, rule: CloudAlertRule, evaluation: Evaluation,
                    account, human: str) -> str:
        """The one-line body stored on the alert row and shown in the feed."""
        name = getattr(account, "account_name", None) or "this account"
        measured = evaluation.detail or human
        return (f"[{name}] {rule.name}: {measured} "
                f"(observed {evaluation.observed_label}, "
                f"threshold {evaluation.threshold_label})")

    def _stamp(self, rule: CloudAlertRule, evaluation: Evaluation,
               elapsed_ms: float) -> None:
        rule.last_evaluated_at = datetime.now(timezone.utc)
        rule.last_result = evaluation.state
        rule.last_result_detail = evaluation.detail
        # A value that could not be read is stored as NULL, not as "0". The
        # column is the rule list's "last observed" cell, and it must render as
        # NA there.
        rule.last_observed_value = (
            evaluation.observed_label if evaluation.observed is not None else None)
        rule.last_evaluation_ms = elapsed_ms


# ── Retention ─────────────────────────────────────────────────────────────────
async def get_settings(db: AsyncSession):
    """The one settings row, created with defaults on first read."""
    from sqlalchemy import select

    from app.models.alert_rule import CloudAlertSettings

    row = (await db.execute(
        select(CloudAlertSettings).where(CloudAlertSettings.id == 1)
    )).scalar_one_or_none()
    if row is None:
        row = CloudAlertSettings(id=1)
        db.add(row)
        await db.flush()
    return row


async def prune(db: AsyncSession, *, dry_run: bool = False) -> Dict[str, Any]:
    """Apply the retention policy. Returns what was (or would be) removed.

    Three deliberate refusals:

    *   OPEN and ACKNOWLEDGED alerts are never touched, at any age. An
        unresolved problem does not stop being one because it is six months
        old, and deleting it would make the estate look healthier than it is.
    *   PENDING rows older than a day are cleaned up, because a held breach
        whose rule was deleted or disabled has nothing left to promote it.
    *   Notification payloads are stripped from delivered rows, but the
        delivery RECORD stays. "Did this email go out, to whom, and did it
        arrive" must remain answerable long after the rendered HTML stops
        being interesting.
    """
    from sqlalchemy import and_, delete, func, select, text

    from app.models.alert import CloudAlert
    from app.models.alert_rule import CloudAlertEvent

    settings = await get_settings(db)
    if not settings.pruning_enabled and not dry_run:
        return {"skipped": True,
                "reason": "Pruning is disabled. Enable it in Alert settings; "
                          "deletion is irreversible, so it is off by default."}

    now = datetime.now(timezone.utc)
    alert_cutoff = now - timedelta(days=settings.alert_retention_days)
    activity_cutoff = now - timedelta(days=settings.activity_retention_days)
    payload_cutoff = now - timedelta(days=settings.notification_payload_days)
    pending_cutoff = now - timedelta(days=1)

    resolved_q = and_(CloudAlert.state == STATE_RESOLVED,
                      CloudAlert.resolved_at < alert_cutoff)
    stale_pending_q = and_(CloudAlert.state == STATE_PENDING,
                           CloudAlert.last_seen_at < pending_cutoff)
    activity_q = CloudAlertEvent.at < activity_cutoff

    counts = {
        "resolved_alerts": (await db.execute(
            select(func.count()).select_from(CloudAlert).where(resolved_q)
        )).scalar_one(),
        "abandoned_pending": (await db.execute(
            select(func.count()).select_from(CloudAlert).where(stale_pending_q)
        )).scalar_one(),
        "activity_rows": (await db.execute(
            select(func.count()).select_from(CloudAlertEvent).where(activity_q)
        )).scalar_one(),
    }

    try:
        counts["notification_payloads"] = (await db.execute(text(
            "SELECT COUNT(*) FROM notification_queue "
            "WHERE status <> 'pending' AND created_at < :cutoff "
            "  AND payload IS NOT NULL AND payload::text <> '{}'"
        ), {"cutoff": payload_cutoff.replace(tzinfo=None)})).scalar_one()
    except Exception as exc:  # noqa: BLE001 — another service's table
        logger.debug("Could not size notification payloads: %s", exc)
        counts["notification_payloads"] = None

    if dry_run:
        return {"dry_run": True, "would_remove": counts,
                "policy": settings.to_dict()}

    await db.execute(delete(CloudAlert).where(resolved_q))
    await db.execute(delete(CloudAlert).where(stale_pending_q))
    await db.execute(delete(CloudAlertEvent).where(activity_q))
    if counts.get("notification_payloads"):
        try:
            # The row and its status stay; only the rendered body goes.
            await db.execute(text(
                "UPDATE notification_queue SET payload = '{}'::jsonb "
                "WHERE status <> 'pending' AND created_at < :cutoff "
                "  AND payload IS NOT NULL AND payload::text <> '{}'"
            ), {"cutoff": payload_cutoff.replace(tzinfo=None)})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not strip notification payloads: %s", exc)

    settings.last_pruned_at = now
    settings.last_prune_result = counts
    await db.commit()
    logger.info("Alert retention pruned: %s", counts)
    return {"removed": counts, "policy": settings.to_dict()}


# ── Background loop ───────────────────────────────────────────────────────────
_stop = asyncio.Event()
_last_pass: Dict[str, Any] = {"at": None, "result": None, "error": None}
# Guards against two passes overlapping inside one process. Cross-process
# safety comes from the due query itself: last_evaluated_at is written inside
# the same transaction that evaluates, so a second process picks up a rule only
# after the first has committed.
_pass_lock = asyncio.Lock()
# When retention last ran. None means "not since this process started", so a
# restart-loop cannot turn a daily prune into a per-restart one — the first
# check after boot waits a full interval rather than pruning immediately.
_last_prune_at: Optional[datetime] = None
PRUNE_INTERVAL_SECONDS = 24 * 3600


def _prune_due() -> bool:
    global _last_prune_at
    now = datetime.now(timezone.utc)
    if _last_prune_at is None:
        _last_prune_at = now
        return False
    return (now - _last_prune_at).total_seconds() >= PRUNE_INTERVAL_SECONDS


def engine_enabled() -> bool:
    return (os.getenv("ALERT_ENGINE_ENABLED", "true").strip().lower()
            not in ("false", "0", "no", "off"))


def engine_status() -> Dict[str, Any]:
    """What the health panel shows. Only metrics that are genuinely collected."""
    return {
        "enabled": engine_enabled(),
        "running": not _stop.is_set(),
        "tick_seconds": TICK_SECONDS,
        "last_pass_at": _last_pass["at"],
        "last_pass": _last_pass["result"],
        "last_error": _last_pass["error"],
    }


async def engine_loop() -> None:
    """Run a pass every TICK_SECONDS until cancelled.

    Its own session per pass, so a failed pass rolls back cleanly and the next
    one starts from a known state.
    """
    from app.core.database import AsyncSessionLocal

    _stop.clear()
    logger.info("Alert engine started (tick=%ss).", TICK_SECONDS)
    while not _stop.is_set():
        try:
            async with _pass_lock:
                async with AsyncSessionLocal() as db:
                    try:
                        result = await AlertEngine(db).run_once()
                        _last_pass.update({
                            "at": datetime.now(timezone.utc).isoformat(),
                            "result": result, "error": None,
                        })
                    except Exception:  # noqa: BLE001
                        await db.rollback()
                        raise

            # Retention runs at most daily and in its own session, so a slow or
            # failing prune can never delay or poison an evaluation pass.
            if _prune_due():
                async with AsyncSessionLocal() as db:
                    try:
                        await prune(db)
                    except Exception:  # noqa: BLE001
                        await db.rollback()
                        logger.exception("Alert retention prune failed")
                    finally:
                        globals()["_last_prune_at"] = datetime.now(timezone.utc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — a bad pass must not kill the loop
            logger.exception("Alert engine pass failed")
            _last_pass.update({
                "at": datetime.now(timezone.utc).isoformat(),
                "error": f"{type(exc).__name__}: {exc}",
            })
        try:
            await asyncio.wait_for(_stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
    logger.info("Alert engine stopped.")


def stop_engine() -> None:
    _stop.set()
