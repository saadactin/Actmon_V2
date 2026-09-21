"""Alert rule CRUD, recipients, email settings, and the page's summary.

Everything that changes configuration goes through here so that two things are
guaranteed rather than remembered:

*   **A rule is validated against the catalog before it is stored.** The
    catalog is what the evaluator dispatches on, so a rule that passes
    validation is a rule the engine can answer. The alternative — store now,
    fail every five minutes forever — produces a rule list full of entries that
    look configured and do nothing.

*   **Every configuration change is audited.** Created, updated, enabled,
    disabled, deleted, recipients changed, test sent. The append-only
    `cloud_alert_events` row is written in the same transaction as the change,
    so there is no path that alters a rule without leaving a record.

Account isolation is enforced at the top of every method that takes an id: a
rule, a recipient or an alert is only ever reachable through the account it
belongs to. Passing another account's rule id returns 404, not that rule.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import STATE_ACKNOWLEDGED, STATE_OPEN, STATE_RESOLVED, CloudAlert
from app.models.alert_rule import (
    ACT_ALERT_ACKNOWLEDGED, ACT_ALERT_RESOLVED, ACT_ALERT_SILENCED,
    ACT_NOTIFY_TEST,
    ACT_RECIPIENTS_CHANGED, ACT_RULE_CREATED, ACT_RULE_DELETED,
    ACT_RULE_DISABLED, ACT_RULE_ENABLED, ACT_RULE_SILENCED, ACT_RULE_TESTED,
    ACT_RULE_UNSILENCED, ACT_RULE_UPDATED, ACT_SETTINGS_CHANGED,
    CATEGORIES, DEFAULT_COOLDOWN_SECONDS, DEFAULT_INTERVAL_SECONDS,
    MIN_INTERVAL_SECONDS, SEVERITIES, CloudAlertRecipient, CloudAlertRule,
)
from app.repository.alert_repo import AlertRepository
from app.repository.alert_rule_repo import AlertRuleRepository
from app.repository.cloud_account_repo import CloudAccountRepository
from app.services.alerts import (
    catalog, engine, evaluators, notifier, policy, templates_catalog,
)
from app.services.alerts.analytics import AlertAnalytics
from app.services.alerts.correlation import AlertCorrelation

logger = logging.getLogger("cloud_svc.alerts.service")

# Bars on the two timing knobs. The floor on evaluation exists because every
# source underneath is refreshed by discovery, not continuously — a 10-second
# rule would re-read the same numbers 30 times and call the provider none.
MAX_INTERVAL_SECONDS = 24 * 3600
MAX_COOLDOWN_SECONDS = 7 * 24 * 3600
# A silence is a temporary decision by definition. Anything longer than a month
# is someone meaning "disable" and choosing the control that keeps the rule
# looking active — so the bar refuses it and says which control they want.
MAX_SILENCE_SECONDS = 30 * 24 * 3600
# The longest a breach may be held before it becomes an alert. Past this, the
# hold is doing the job of a longer evaluation interval and doing it invisibly.
MAX_MIN_DURATION_SECONDS = 24 * 3600
MAX_CONSECUTIVE_BREACHES = 10
MAX_ESCALATION_SECONDS = 7 * 24 * 3600

# The nine channels the shared dispatcher knows about. Mirrored here rather
# than imported because that module lives in the database service's tree; the
# `implemented` flag is what actually matters and only email carries it.
_CHANNEL_LABELS = {
    "email": "Email",
    "teams": "Microsoft Teams",
    "slack": "Slack",
    "telegram": "Telegram",
    "whatsapp": "WhatsApp Business Cloud API",
    "webhook": "Generic Webhook",
    "pagerduty": "PagerDuty",
    "jira": "Jira Service Management",
    "servicenow": "ServiceNow",
}


class NotFound(LookupError):
    pass


class AlertRuleService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = AlertRuleRepository(db)
        self.alerts = AlertRepository(db)
        self.accounts = CloudAccountRepository(db)

    # ── Scope ────────────────────────────────────────────────────────────────
    async def _account(self, account_id: str):
        parsed = _uuid(account_id)
        if parsed is None:
            raise NotFound(f"{account_id!r} is not a valid account id.")
        account = await self.accounts.get_by_id(parsed)
        if account is None:
            raise NotFound(f"Cloud account {account_id} was not found.")
        return account

    async def _rule(self, account, rule_id: str) -> CloudAlertRule:
        parsed = _uuid(rule_id)
        rule = await self.repo.get(parsed) if parsed else None
        # The account check is the isolation boundary. Without it, a rule id
        # leaked from one account could be read, edited or deleted through
        # another account's URL.
        if rule is None or rule.account_id != account.id:
            raise NotFound(f"Alert rule {rule_id} was not found on this account.")
        return rule

    # ── Capabilities ─────────────────────────────────────────────────────────
    async def capabilities(self, account_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        support = await catalog.account_support(self.db, account)
        payload = catalog.catalog_payload()
        for category in payload["categories"]:
            for condition in category["conditions"]:
                condition["support"] = support.get(
                    condition["key"], {"supported": True, "reason": None,
                                       "warning": None})
        payload["account"] = {
            "id": str(account.id), "name": account.account_name,
            "provider": account.provider,
        }
        payload["delivery"] = await notifier.delivery_status(self.db)
        return payload

    # ── Rules ────────────────────────────────────────────────────────────────
    async def list_rules(self, account_id: str, *, category: Optional[str] = None,
                         enabled: Optional[bool] = None,
                         severity: Optional[str] = None,
                         condition_type: Optional[str] = None,
                         notifies: Optional[bool] = None,
                         search: Optional[str] = None) -> Dict[str, Any]:
        """Rules, filtered. Filtering happens in SQL for the cheap dimensions
        and in Python only for `notifies`, which depends on resolving account
        defaults per rule and cannot be expressed as a column predicate."""
        account = await self._account(account_id)
        rules = await self.repo.list_for_account(
            account.id, category=category, enabled=enabled,
            severity=severity, condition_type=condition_type, search=search)

        serialized = [self._serialize(r, account) for r in rules]

        if notifies is not None:
            defaults = await notifier.account_recipients(self.db, account.id)
            has_default = bool(defaults.get("to"))
            kept = []
            for rule, payload in zip(rules, serialized):
                own = rule.recipients()
                reaches = bool(own["to"] or own["cc"] or own["bcc"]) or (
                    rule.uses_account_defaults() and has_default)
                if reaches is notifies:
                    kept.append(payload)
            serialized = kept

        return {
            "account_id": str(account.id),
            "rules": serialized,
            "returned": len(serialized),
            "counts": await self.repo.counts_for_account(account.id),
            "facets": await self.repo.rule_facets(account.id),
        }

    async def duplicate_rule(self, account_id: str, rule_id: str,
                             *, actor: Optional[str] = None,
                             actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Copy a rule, disabled.

        Disabled on purpose: a duplicate is almost always about to be edited,
        and a copy that starts evaluating (and emailing) the instant it is made
        would double every notification from the original until somebody
        finished changing it.
        """
        account = await self._account(account_id)
        source = await self._rule(account, rule_id)

        base = f"{source.name} (copy)"
        name, suffix = base, 2
        while await self.repo.name_taken(account.id, name):
            name = f"{base} {suffix}"
            suffix += 1

        clone = CloudAlertRule(
            account_id=account.id, provider=account.provider,
            name=name, description=source.description,
            category=source.category, condition_type=source.condition_type,
            condition_version=source.condition_version,
            condition_config=dict(source.condition_config or {}),
            scope_config=dict(source.scope_config or {}) or None,
            severity=source.severity,
            enabled=False,
            notification_config=dict(source.notification_config or {}),
            evaluation_interval_seconds=source.evaluation_interval_seconds,
            cooldown_seconds=source.cooldown_seconds,
            repeat_interval_seconds=source.repeat_interval_seconds,
            notify_on_resolution=source.notify_on_resolution,
            min_duration_seconds=source.min_duration_seconds,
            consecutive_breaches_required=source.consecutive_breaches_required,
            created_by=actor, updated_by=actor,
        )
        await self.repo.add(clone)
        await self.repo.record(
            action=ACT_RULE_CREATED, rule=clone, actor=actor, actor_role=actor_role,
            summary=f"Alert rule {clone.name!r} created as a copy of "
                    f"{source.name!r}.",
            detail={"copied_from": str(source.id),
                    "note": "Created disabled so it can be edited before it "
                            "starts evaluating."},
        )
        await self.db.commit()
        await self.db.refresh(clone)
        return self._serialize(clone, account)

    async def get_rule(self, account_id: str, rule_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        payload = self._serialize(rule, account)
        payload["recipients_resolved"] = await notifier.resolve_recipients(
            self.db, rule)
        payload["recent_activity"] = [
            e.to_dict() for e in await self.repo.activity(
                account.id, rule_id=rule.id, limit=25)
        ]
        return payload

    async def create_rule(self, account_id: str, data: Dict[str, Any],
                          *, actor: Optional[str] = None,
                          actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        fields = await self._validate(account, data)

        if await self.repo.name_taken(account.id, fields["name"]):
            raise catalog.ValidationError({
                "name": f"A rule called {fields['name']!r} already exists on "
                        "this account."})

        rule = CloudAlertRule(
            account_id=account.id,
            provider=account.provider,
            created_by=actor,
            updated_by=actor,
            **fields,
        )
        await self.repo.add(rule)
        await self.repo.record(
            action=ACT_RULE_CREATED, rule=rule, actor=actor, actor_role=actor_role,
            summary=f"Alert rule {rule.name!r} created.",
            detail={"condition": catalog.describe(
                rule.condition_type, rule.condition_config, rule.scope_config,
                account.account_name)},
        )
        await self.db.commit()
        await self.db.refresh(rule)
        return self._serialize(rule, account)

    async def update_rule(self, account_id: str, rule_id: str,
                          data: Dict[str, Any], *, actor: Optional[str] = None,
                          actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        was_enabled = rule.enabled

        # Merge onto the stored values so a PATCH that touches only the
        # threshold is still validated as a whole rule — a partial validation
        # can accept a config the evaluator will choke on.
        merged = {
            "name": rule.name, "description": rule.description,
            "category": rule.category, "condition_type": rule.condition_type,
            "condition_config": rule.condition_config,
            "scope_config": rule.scope_config, "severity": rule.severity,
            "enabled": rule.enabled,
            "notification_config": rule.notification_config,
            "evaluation_interval_seconds": rule.evaluation_interval_seconds,
            "cooldown_seconds": rule.cooldown_seconds,
            "repeat_interval_seconds": rule.repeat_interval_seconds,
            "notify_on_resolution": rule.notify_on_resolution,
            # Every field _validate returns must be seeded here. A field missing
            # from this dict is silently reset to its default by any PATCH that
            # does not mention it — so editing a threshold would quietly drop a
            # rule's minimum-duration protection.
            "min_duration_seconds": rule.min_duration_seconds,
            "consecutive_breaches_required": rule.consecutive_breaches_required,
            "notification_mode": rule.notification_mode,
            "escalate_after_seconds": rule.escalate_after_seconds,
            "respect_quiet_hours": rule.respect_quiet_hours,
        }
        merged.update({k: v for k, v in data.items() if v is not None})
        fields = await self._validate(account, merged)

        if await self.repo.name_taken(account.id, fields["name"], exclude=rule.id):
            raise catalog.ValidationError({
                "name": f"A rule called {fields['name']!r} already exists on "
                        "this account."})

        condition_changed = (
            fields["condition_type"] != rule.condition_type
            or fields["condition_config"] != (rule.condition_config or {})
            or fields["scope_config"] != (rule.scope_config or {})
        )

        for key, value in fields.items():
            setattr(rule, key, value)
        rule.updated_by = actor

        if condition_changed:
            # The fingerprint includes the condition, so an edited rule starts
            # a fresh alert rather than re-labelling the open one. Clearing the
            # stale result stops the list showing a verdict that was reached
            # about a different question.
            rule.last_result = None
            rule.last_result_detail = None
            rule.last_observed_value = None
            rule.last_evaluated_at = None

        await self.repo.record(
            action=ACT_RULE_UPDATED, rule=rule, actor=actor, actor_role=actor_role,
            summary=f"Alert rule {rule.name!r} updated.",
            detail={"condition_changed": condition_changed,
                    "condition": catalog.describe(
                        rule.condition_type, rule.condition_config,
                        rule.scope_config, account.account_name)},
        )
        if was_enabled != rule.enabled:
            await self.repo.record(
                action=ACT_RULE_ENABLED if rule.enabled else ACT_RULE_DISABLED,
                rule=rule, actor=actor, actor_role=actor_role,
                summary=(f"Alert rule {rule.name!r} "
                         f"{'enabled' if rule.enabled else 'disabled'}."),
                detail=None if rule.enabled else {
                    "note": "The rule is retained and stops being evaluated. "
                            "Existing alert history is unaffected."},
            )
        await self.db.commit()
        await self.db.refresh(rule)
        return self._serialize(rule, account)

    async def set_enabled(self, account_id: str, rule_id: str, enabled: bool,
                          *, actor: Optional[str] = None,
                          actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        if rule.enabled == enabled:
            return self._serialize(rule, account)
        rule.enabled = enabled
        rule.updated_by = actor
        await self.repo.record(
            action=ACT_RULE_ENABLED if enabled else ACT_RULE_DISABLED,
            rule=rule, actor=actor, actor_role=actor_role,
            summary=(f"Alert rule {rule.name!r} "
                     f"{'enabled' if enabled else 'disabled'}."),
        )
        await self.db.commit()
        await self.db.refresh(rule)
        return self._serialize(rule, account)

    async def delete_rule(self, account_id: str, rule_id: str,
                          *, actor: Optional[str] = None,
                          actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        await self.repo.soft_delete(rule, actor)
        await self.repo.record(
            action=ACT_RULE_DELETED, rule=rule, actor=actor, actor_role=actor_role,
            summary=f"Alert rule {rule.name!r} deleted.",
            detail={"note": "Future evaluations stop. Alerts this rule already "
                            "raised are retained and remain queryable."},
        )
        await self.db.commit()
        return {"deleted": True, "id": str(rule.id), "name": rule.name,
                "history_retained": True}

    async def test_rule(self, account_id: str, rule_id: str,
                        *, actor: Optional[str] = None,
                        actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Evaluate the rule for real, change nothing.

        No alert is created and no email is sent, even when the condition is
        met. A test that manufactures an alert to look successful would put a
        fabricated row in the feed, which is the one thing this whole feature
        is built not to do.
        """
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        outcome = await engine.AlertEngine(self.db).evaluate_rule(
            rule, account=account, dry_run=True)
        evaluation = outcome["evaluation"]

        await self.repo.record(
            action=ACT_RULE_TESTED, rule=rule, actor=actor, actor_role=actor_role,
            summary=(f"Alert rule {rule.name!r} tested: {evaluation.state} "
                     f"(observed {evaluation.observed_label})."),
            detail={"explain": evaluation.explain(outcome["condition_human"]),
                    "dry_run": True},
        )
        await self.db.commit()
        return {
            "rule_id": str(rule.id),
            "condition": outcome["condition_human"],
            "result": evaluation.state,
            "would_trigger": evaluation.fired,
            "explain": evaluation.explain(outcome["condition_human"]),
            "duration_ms": outcome["duration_ms"],
            "note": ("This evaluated live data. No alert was created and no "
                     "notification was sent."),
        }

    async def preview_rule(self, account_id: str,
                           data: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate an UNSAVED rule against live data.

        This is the "what exactly will cause this email to arrive" answer, and
        it runs before anything is stored: the config is validated exactly as a
        save would validate it, then evaluated for real. Nothing is written —
        no rule, no alert, no notification, no audit row. A preview that left a
        trace would make the builder's back button destructive.

        Validation errors are returned rather than raised, because the preview
        panel updates live as the user types and a half-typed threshold is an
        ordinary intermediate state, not a failure worth a red banner.
        """
        account = await self._account(account_id)
        # Held as plain values. The rollback below expires every loaded ORM
        # attribute, and reading `account.id` afterwards triggers a lazy refresh
        # outside the async context — which surfaces as MissingGreenlet and
        # buries whatever the preview was actually going to say.
        acct_id, acct_name = account.id, account.account_name

        condition_type = str(data.get("condition_type") or "").strip()
        if not condition_type:
            return {"ready": False,
                    "reason": "Choose what to alert on to see a preview."}

        try:
            condition = catalog.get(condition_type)
            config = catalog.validate(condition_type, data.get("condition_config"),
                                      data.get("scope_config"))
            scope = catalog.clean_scope(condition_type, data.get("scope_config"))
        except catalog.ValidationError as exc:
            return {"ready": False,
                    "reason": "This condition is not complete yet.",
                    "errors": exc.errors}

        support = (await catalog.account_support(self.db, account)).get(
            condition_type, {})
        human = catalog.describe(condition_type, config, scope, acct_name)

        if not support.get("supported", True):
            return {"ready": False, "condition": human,
                    "reason": support.get("reason"),
                    "supported": False}

        # Evaluated through the evaluator directly rather than through
        # AlertEngine.evaluate_rule, because there is no rule yet. Constructing
        # a fake CloudAlertRule to satisfy a signature would put an object in
        # the session that looks persistable, which is exactly the accident this
        # endpoint must not have.
        ctx = evaluators.EvalContext(self.db, account)
        evaluation = await evaluators.evaluate(ctx, condition_type, config, scope)

        # Rolled back rather than committed: evaluation itself writes nothing,
        # but an evaluator that touched a cache row should not survive a preview.
        await self.db.rollback()

        recipients = await self._preview_recipients(acct_id, data)
        return {
            "ready": True,
            "supported": True,
            "warning": support.get("warning"),
            "condition": human,
            "result": evaluation.state,
            "would_trigger": evaluation.fired,
            "explain": evaluation.explain(human),
            "match_count": len(evaluation.samples) or None,
            "samples": evaluation.samples,
            "recipients": recipients,
            "summary": self._preview_summary(evaluation, data, recipients, human),
        }

    async def _preview_recipients(self, account_id: uuid.UUID,
                                  data: Dict[str, Any]) -> Dict[str, Any]:
        cfg = data.get("notification_config") or {}
        own = [str(a).strip() for a in (cfg.get("recipients") or []) if str(a).strip()]
        use_defaults = bool(cfg.get("use_account_defaults", True))
        defaults = ((await notifier.account_recipients(self.db, account_id)).get("to")
                    if use_defaults else [])
        merged = list(dict.fromkeys([*own, *(defaults or [])]))
        return {"to": merged, "from_rule": own,
                "from_account_defaults": defaults or [],
                "uses_account_defaults": use_defaults}

    def _preview_summary(self, evaluation, data: Dict[str, Any],
                         recipients: Dict[str, Any], human: str) -> Dict[str, Any]:
        """The WHEN / THEN / SEND block, phrased the way it will actually behave."""
        severity = str(data.get("severity") or "MEDIUM").upper()
        cooldown = _int(data.get("cooldown_seconds"), DEFAULT_COOLDOWN_SECONDS)
        hold = _int(data.get("min_duration_seconds"), 0)
        consecutive = _int(data.get("consecutive_breaches_required"), 1)

        holdoff = []
        if consecutive > 1:
            holdoff.append(f"seen on {consecutive} consecutive evaluations")
        if hold > 0:
            holdoff.append(f"still true after {hold // 60} minute(s)")

        return {
            "when": human,
            "then": f"Open a {severity} alert"
                    + (f", but only once it has been {' and '.join(holdoff)}"
                       if holdoff else ""),
            "send": (f"Email {', '.join(recipients['to'])}"
                     if recipients["to"]
                     else "Email nobody — this rule will record alerts without "
                          "notifying anyone"),
            "cooldown": (f"At most one email every {cooldown // 60} minute(s) "
                         "for the same condition"
                         if cooldown else "No cooldown — every recurrence emails"),
            "on_resolve": ("Also email when it clears"
                           if data.get("notify_on_resolution")
                           else "No email when it clears"),
        }

    # ── Silence ──────────────────────────────────────────────────────────────
    async def silence_rule(self, account_id: str, rule_id: str,
                           *, seconds: int, reason: Optional[str] = None,
                           actor: Optional[str] = None,
                           actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Stop this rule emailing, without stopping it watching.

        The rule keeps evaluating and keeps opening and resolving alerts, so the
        Alerts tab stays honest about what is wrong; only the mail is
        suppressed. That is the whole difference from disabling, and it is why
        both controls exist.
        """
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        if seconds <= 0 or seconds > MAX_SILENCE_SECONDS:
            raise catalog.ValidationError({
                "seconds": "A silence must be between 1 second and 30 days. "
                           "Use Disable if you want it off indefinitely — a "
                           "permanent silence is a disabled rule that still "
                           "looks active."})

        until = datetime.now(timezone.utc) + timedelta(seconds=seconds)
        rule.silenced_until = until
        rule.silenced_by = actor
        rule.silence_reason = reason
        await self.repo.record(
            action=ACT_RULE_SILENCED, rule=rule, actor=actor, actor_role=actor_role,
            summary=(f"Alert rule {rule.name!r} silenced until "
                     f"{until.isoformat()}"
                     + (f": {reason}" if reason else ".")),
            detail={"until": until.isoformat(), "seconds": seconds,
                    "reason": reason,
                    "note": "Evaluation continues; alerts still open and "
                            "resolve. Only notification is suppressed."},
        )
        await self.db.commit()
        await self.db.refresh(rule)
        return self._serialize(rule, account)

    async def unsilence_rule(self, account_id: str, rule_id: str,
                             *, actor: Optional[str] = None,
                             actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        rule = await self._rule(account, rule_id)
        if rule.silenced_until is None:
            return self._serialize(rule, account)
        rule.silenced_until = None
        rule.silenced_by = None
        rule.silence_reason = None
        await self.repo.record(
            action=ACT_RULE_UNSILENCED, rule=rule, actor=actor, actor_role=actor_role,
            summary=f"Alert rule {rule.name!r} unsilenced.")
        await self.db.commit()
        await self.db.refresh(rule)
        return self._serialize(rule, account)

    async def silence_alert(self, account_id: str, alert_id: str,
                            *, seconds: int, reason: Optional[str] = None,
                            actor: Optional[str] = None,
                            actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Silence ONE alert, not its whole rule.

        "This instance is known and being worked on" is a different decision
        from "stop telling me about this class of thing", and collapsing them
        means muting a rule to quieten one noisy resource — which then hides
        the next genuine one it finds.
        """
        account = await self._account(account_id)
        parsed = _uuid(alert_id)
        alert = await self.alerts.get_by_id(parsed) if parsed else None
        if alert is None or alert.account_id != account.id:
            raise NotFound(f"Alert {alert_id} was not found on this account.")
        if seconds <= 0 or seconds > MAX_SILENCE_SECONDS:
            raise catalog.ValidationError({
                "seconds": "A silence must be between 1 second and 30 days."})

        until = datetime.now(timezone.utc) + timedelta(seconds=seconds)
        alert.silenced_until = until
        alert.silenced_by = actor
        alert.silence_reason = reason
        await self.repo.record(
            action=ACT_ALERT_SILENCED, account_id=account.id,
            rule_id=alert.rule_id, alert_id=alert.id, severity=alert.severity,
            actor=actor, actor_role=actor_role,
            summary=(f"Alert silenced until {until.isoformat()}"
                     + (f": {reason}" if reason else ".")),
            detail={"until": until.isoformat(), "reason": reason,
                    "note": "The alert stays open and in the feed; only its "
                            "notification is suppressed."},
        )
        await self.db.commit()
        return {**alert.to_dict(),
                "note": ("This alert stays open and still counts as active. "
                         "Only its email is suppressed.")}

    async def unsilence_alert(self, account_id: str, alert_id: str,
                              *, actor: Optional[str] = None,
                              actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        parsed = _uuid(alert_id)
        alert = await self.alerts.get_by_id(parsed) if parsed else None
        if alert is None or alert.account_id != account.id:
            raise NotFound(f"Alert {alert_id} was not found on this account.")
        alert.silenced_until = None
        alert.silenced_by = None
        alert.silence_reason = None
        await self.repo.record(
            action=ACT_ALERT_SILENCED, account_id=account.id,
            rule_id=alert.rule_id, alert_id=alert.id, actor=actor,
            actor_role=actor_role, summary="Alert unsilenced.")
        await self.db.commit()
        return alert.to_dict()

    # ── Notification channels ────────────────────────────────────────────────
    async def channels(self, account_id: str) -> Dict[str, Any]:
        """Every delivery channel, and whether it actually delivers.

        Reports eight channels as NOT connected rather than hiding them,
        because "Actmon has no Slack integration" and "Slack is configured but
        off" are different answers and the settings UI elsewhere shows all nine.
        Each stub says plainly that configuration for it is stored and unused.
        """
        await self._account(account_id)
        from sqlalchemy import text as sql

        rows: Dict[str, Any] = {}
        try:
            for r in (await self.db.execute(sql(
                "SELECT channel_type, enabled, last_test_at, last_test_ok, "
                "       last_test_msg, last_success_at, last_failure_at, last_error "
                "FROM notification_channels WHERE org_id = :org"
            ), {"org": notifier.ORG_ID})).mappings().all():
                rows[r["channel_type"]] = dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read notification channels: %s", exc)

        delivery = await notifier.delivery_status(self.db)
        catalogue = []
        for key, label in _CHANNEL_LABELS.items():
            stored = rows.get(key)
            implemented = key == "email"
            catalogue.append({
                "channel_type": key,
                "label": label,
                "implemented": implemented,
                "configured": stored is not None,
                "enabled": bool(stored and stored.get("enabled")),
                "last_test_at": _iso(stored.get("last_test_at")) if stored else None,
                "last_test_ok": stored.get("last_test_ok") if stored else None,
                "last_test_message": stored.get("last_test_msg") if stored else None,
                "last_success_at": _iso(stored.get("last_success_at")) if stored else None,
                "last_failure_at": _iso(stored.get("last_failure_at")) if stored else None,
                "last_error": stored.get("last_error") if stored else None,
                "note": (None if implemented else
                         f"{label} is not connected in this build. Its "
                         "configuration is stored by the shared notification "
                         "settings and never used, so alert rules do not offer "
                         "it."),
            })
        return {"channels": catalogue, "delivery": delivery,
                "implemented": ["email"]}

    async def test_channel(self, account_id: str, channel_type: str,
                           *, recipients: Optional[Sequence[str]] = None,
                           actor: Optional[str] = None,
                           actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Test the TRANSPORT, not a rule.

        Deliberately distinct from testing a rule: this proves the mail can
        leave the building, a rule test proves the detection is right, and
        confusing the two is how somebody concludes their alerting works
        because an SMTP handshake succeeded.
        """
        channel = (channel_type or "").strip().lower()
        if channel not in _CHANNEL_LABELS:
            raise catalog.ValidationError({
                "channel_type": f"Unknown channel {channel_type!r}."})
        if channel != "email":
            return {
                "queued": False, "channel_type": channel,
                "reason": (f"{_CHANNEL_LABELS[channel]} is not connected in this "
                           "build, so there is nothing to test. Only email "
                           "delivers today."),
            }
        return await self.send_test_email(
            account_id, recipients=recipients, actor=actor, actor_role=actor_role)

    # ── Notification history ─────────────────────────────────────────────────
    async def notifications(self, account_id: str, *, status: Optional[str] = None,
                            days: int = 30, limit: int = 100) -> Dict[str, Any]:
        """Delivery attempts as a first-class, queryable resource.

        Reads the shared ledger the dispatcher writes — the only place in this
        system where "sent" is claimed, because it is the only place that knows.
        """
        await self._account(account_id)
        from sqlalchemy import text as sql

        # make_interval rather than `(:days || ' days')::interval`: asyncpg
        # binds the parameter as an integer, and Postgres has no `int || text`
        # operator, so the concat form raised on every call and the endpoint
        # reported the ledger as permanently unreadable.
        clauses = ["channel_type = 'email'",
                   "sent_at >= now() - make_interval(days => :days)"]
        params: Dict[str, Any] = {"days": days, "limit": min(limit, 500)}
        if status:
            clauses.append("status = :status")
            params["status"] = status
        where = " AND ".join(clauses)

        try:
            rows = (await self.db.execute(sql(
                f"SELECT id, sent_at, alert_name, server_name, database_name, "
                f"       severity, recipient, status, response_code, "
                f"       response_time_ms, retry_count, error_message "
                f"FROM notification_history WHERE {where} "
                f"ORDER BY sent_at DESC LIMIT :limit"
            ), params)).mappings().all()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read notification history: %s", exc)
            # Not an empty list — an unreadable ledger is not a ledger of
            # nothing, and the UI must be able to tell those apart.
            return {"available": False, "reason": str(exc), "notifications": []}

        return {
            "available": True,
            "window_days": days,
            "notifications": [{
                "id": r["id"],
                "at": _iso(r["sent_at"]),
                "alert": r["alert_name"],
                "account": r["server_name"],
                "category": r["database_name"],
                "severity": r["severity"],
                "recipient": r["recipient"],
                "status": r["status"],
                "response_code": r["response_code"],
                "response_time_ms": r["response_time_ms"],
                "retries": r["retry_count"],
                "error": r["error_message"],
            } for r in rows],
            "returned": len(rows),
        }

    async def notification(self, account_id: str, notification_id: int) -> Dict[str, Any]:
        await self._account(account_id)
        from sqlalchemy import text as sql

        try:
            row = (await self.db.execute(sql(
                "SELECT id, sent_at, alert_name, server_name, database_name, "
                "       severity, channel_type, recipient, status, response_code, "
                "       response_time_ms, retry_count, error_message "
                "FROM notification_history WHERE id = :id"
            ), {"id": notification_id})).mappings().first()
        except Exception as exc:  # noqa: BLE001
            raise NotFound(f"The notification ledger could not be read: {exc}")
        if row is None:
            raise NotFound(f"Notification {notification_id} was not found.")
        return {
            "id": row["id"], "at": _iso(row["sent_at"]),
            "alert": row["alert_name"], "account": row["server_name"],
            "category": row["database_name"], "severity": row["severity"],
            "channel_type": row["channel_type"], "recipient": row["recipient"],
            "status": row["status"], "response_code": row["response_code"],
            "response_time_ms": row["response_time_ms"],
            "retries": row["retry_count"], "error": row["error_message"],
            "note": ("'sent' means the mail server accepted the message. It is "
                     "not a guarantee it reached the inbox — no SMTP server "
                     "can confirm that."),
        }

    # ── Templates ────────────────────────────────────────────────────────────
    async def templates(self, account_id: str) -> Dict[str, Any]:
        """The template list, with each one's support for THIS account.

        A template whose condition cannot be evaluated here is returned marked
        unsupported with the reason, not hidden — "Actmon cannot do cost
        baselines" and "this account has no billing history yet" are very
        different messages, and hiding the card sends the first.
        """
        account = await self._account(account_id)
        support = await catalog.account_support(self.db, account)
        payload = templates_catalog.payload()
        for t in payload["templates"]:
            t["support"] = support.get(t["condition_type"],
                                       {"supported": True, "reason": None,
                                        "warning": None})
            t["preview_sentence"] = catalog.describe(
                t["condition_type"], t["condition_config"], t["scope_config"],
                account.account_name)
        return payload

    async def apply_recommended(self, account_id: str, *, keys: Optional[List[str]] = None,
                                actor: Optional[str] = None,
                                actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Create the recommended rules — DISABLED, and notifying nobody.

        Two safeguards, both deliberate. They are created disabled, so nothing
        starts evaluating until somebody looks at it; and `use_account_defaults`
        is off, so even enabling them cannot produce a surprise email flood to
        an address configured for something else. Turning each on is a separate,
        visible act.

        Templates whose condition this account cannot evaluate are skipped and
        reported, not created as permanently-UNKNOWN rules.
        """
        account = await self._account(account_id)
        wanted = list(keys or templates_catalog.RECOMMENDED)
        support = await catalog.account_support(self.db, account)

        created, skipped = [], []
        for key in wanted:
            try:
                template = templates_catalog.get(key)
            except catalog.ValidationError as exc:
                skipped.append({"key": key, "reason": str(exc)})
                continue

            if template.needs_input:
                skipped.append({
                    "key": key, "label": template.label,
                    "reason": f"Needs a value only you can supply "
                              f"({', '.join(template.needs_input)}), so it is "
                              "offered in the builder rather than created for "
                              "you."})
                continue

            cond_support = support.get(template.condition_type, {})
            if not cond_support.get("supported", True):
                skipped.append({"key": key, "label": template.label,
                                "reason": cond_support.get("reason")})
                continue

            name = template.suggested_name
            if await self.repo.name_taken(account.id, name):
                skipped.append({"key": key, "label": template.label,
                                "reason": f"A rule called {name!r} already exists."})
                continue

            try:
                payload = await self.create_rule(account_id, {
                    "name": name,
                    "description": template.rationale,
                    "condition_type": template.condition_type,
                    "condition_config": dict(template.condition_config),
                    "scope_config": dict(template.scope_config or {}),
                    "severity": template.severity,
                    "enabled": False,
                    "notification_config": {
                        "channels": ["email"],
                        "use_account_defaults": False,
                        "recipients": [],
                    },
                    "evaluation_interval_seconds": template.evaluation_interval_seconds,
                    "cooldown_seconds": template.cooldown_seconds,
                    "repeat_interval_seconds": template.repeat_interval_seconds,
                    "notify_on_resolution": template.notify_on_resolution,
                    "min_duration_seconds": template.min_duration_seconds,
                    "consecutive_breaches_required":
                        template.consecutive_breaches_required,
                }, actor=actor, actor_role=actor_role)
                created.append(payload)
            except catalog.ValidationError as exc:
                skipped.append({"key": key, "label": template.label,
                                "reason": str(exc)})

        return {
            "created": created, "skipped": skipped,
            "note": ("Created disabled and with no recipients, so nothing can "
                     "email anyone until you enable each rule and choose who "
                     "receives it."),
        }

    # ── Analytics ────────────────────────────────────────────────────────────
    async def analytics(self, account_id: str, *, days: int = 30) -> Dict[str, Any]:
        account = await self._account(account_id)
        return await AlertAnalytics(self.db).overview(account.id, days=days)

    async def noisy_rules(self, account_id: str, *, days: int = 7) -> Dict[str, Any]:
        account = await self._account(account_id)
        return await AlertAnalytics(self.db).noisy_rules(account.id, days=days)

    async def correlation(self, account_id: str, alert_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        parsed = _uuid(alert_id)
        alert = await self.alerts.get_by_id(parsed) if parsed else None
        if alert is None or alert.account_id != account.id:
            raise NotFound(f"Alert {alert_id} was not found on this account.")
        return await AlertCorrelation(self.db).for_alert(alert)

    # ── Settings / retention ─────────────────────────────────────────────────
    async def get_settings(self, account_id: str) -> Dict[str, Any]:
        await self._account(account_id)
        row = await engine.get_settings(self.db)
        await self.db.commit()
        payload = row.to_dict()
        payload["scope"] = ("installation-wide — retention applies to every "
                            "cloud account, not just this one")
        payload["preview"] = await engine.prune(self.db, dry_run=True)
        return payload

    async def update_settings(self, account_id: str, data: Dict[str, Any],
                              *, actor: Optional[str] = None,
                              actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        row = await engine.get_settings(self.db)
        errors: Dict[str, str] = {}

        for field, floor, ceiling in (
            ("alert_retention_days", 7, 3650),
            ("activity_retention_days", 7, 3650),
            ("notification_payload_days", 1, 3650),
        ):
            if field not in data or data[field] is None:
                continue
            value = _int(data[field], getattr(row, field))
            if not floor <= value <= ceiling:
                errors[field] = f"Must be between {floor} and {ceiling} days."
            else:
                setattr(row, field, value)

        if "display_timezone" in data and data["display_timezone"]:
            zone = str(data["display_timezone"]).strip()
            try:
                from zoneinfo import ZoneInfo

                ZoneInfo(zone)
                row.display_timezone = zone
            except Exception:  # noqa: BLE001
                errors["display_timezone"] = (
                    f"{zone!r} is not a known IANA timezone (for example "
                    "Asia/Kolkata or UTC).")

        if "pruning_enabled" in data:
            row.pruning_enabled = bool(data["pruning_enabled"])

        for field in ("quiet_hours_start", "quiet_hours_end"):
            if field not in data or not data[field]:
                continue
            value = str(data[field]).strip()
            try:
                hh, mm = value.split(":")
                if not (0 <= int(hh) <= 23 and 0 <= int(mm) <= 59):
                    raise ValueError
                setattr(row, field, f"{int(hh):02d}:{int(mm):02d}")
            except (ValueError, AttributeError):
                errors[field] = "Must be a 24-hour time like 22:00."

        if "quiet_hours_enabled" in data:
            row.quiet_hours_enabled = bool(data["quiet_hours_enabled"])
        if "quiet_hours_critical_bypass" in data:
            row.quiet_hours_critical_bypass = bool(data["quiet_hours_critical_bypass"])

        # A zero-length window silently disables quiet hours while the switch
        # still reads "on", which is the kind of setting people spend an
        # afternoon on.
        if (row.quiet_hours_enabled
                and row.quiet_hours_start == row.quiet_hours_end
                and "quiet_hours_start" not in errors
                and "quiet_hours_end" not in errors):
            errors["quiet_hours_end"] = (
                "The start and end are the same, which is a window of zero "
                "length — nothing would ever be held. Set different times, or "
                "turn quiet hours off.")

        if errors:
            raise catalog.ValidationError(errors)

        row.updated_by = actor
        await self.repo.record(
            action=ACT_SETTINGS_CHANGED, account_id=account.id, actor=actor,
            actor_role=actor_role,
            summary="Alert retention settings changed.",
            detail={"after": row.to_dict()})
        await self.db.commit()
        return row.to_dict()

    async def run_prune(self, account_id: str, *, dry_run: bool = True,
                        actor: Optional[str] = None,
                        actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        result = await engine.prune(self.db, dry_run=dry_run)
        if not dry_run and not result.get("skipped"):
            await self.repo.record(
                action=ACT_SETTINGS_CHANGED, account_id=account.id, actor=actor,
                actor_role=actor_role,
                summary="Alert retention prune run manually.",
                detail=result.get("removed"))
            await self.db.commit()
        return result

    # ── Validation ───────────────────────────────────────────────────────────
    async def _validate(self, account, data: Dict[str, Any]) -> Dict[str, Any]:
        errors: Dict[str, str] = {}

        name = str(data.get("name") or "").strip()
        if not name:
            errors["name"] = "A rule name is required."
        elif len(name) > 255:
            errors["name"] = "A rule name cannot be longer than 255 characters."

        condition_type = str(data.get("condition_type") or "").strip()
        condition = None
        try:
            condition = catalog.get(condition_type)
        except catalog.ValidationError as exc:
            errors.update(exc.errors)

        severity = str(data.get("severity") or "MEDIUM").upper()
        if severity not in SEVERITIES:
            errors["severity"] = f"Severity must be one of: {', '.join(SEVERITIES)}."

        interval = _int(data.get("evaluation_interval_seconds"),
                        DEFAULT_INTERVAL_SECONDS)
        if interval < MIN_INTERVAL_SECONDS:
            errors["evaluation_interval_seconds"] = (
                f"The shortest evaluation interval is "
                f"{MIN_INTERVAL_SECONDS // 60} minutes. Every source this reads "
                "is refreshed by discovery rather than continuously, so a "
                "shorter interval would re-read identical numbers.")
        elif interval > MAX_INTERVAL_SECONDS:
            errors["evaluation_interval_seconds"] = (
                "The longest evaluation interval is 24 hours.")

        cooldown = _int(data.get("cooldown_seconds"), DEFAULT_COOLDOWN_SECONDS)
        if cooldown < 0 or cooldown > MAX_COOLDOWN_SECONDS:
            errors["cooldown_seconds"] = (
                "The notification cooldown must be between 0 and 7 days.")

        repeat = _int(data.get("repeat_interval_seconds"), 0)
        if repeat < 0 or repeat > MAX_COOLDOWN_SECONDS:
            errors["repeat_interval_seconds"] = (
                "The repeat interval must be between 0 (notify once) and 7 days.")
        if repeat and repeat < interval:
            errors["repeat_interval_seconds"] = (
                "Repeating more often than the rule is evaluated cannot produce "
                f"more notifications — the rule is evaluated every "
                f"{interval // 60} minute(s).")

        hold = _int(data.get("min_duration_seconds"), 0)
        if hold < 0 or hold > MAX_MIN_DURATION_SECONDS:
            errors["min_duration_seconds"] = (
                "The minimum duration must be between 0 and 24 hours.")

        consecutive = _int(data.get("consecutive_breaches_required"), 1)
        if consecutive < 1 or consecutive > MAX_CONSECUTIVE_BREACHES:
            errors["consecutive_breaches_required"] = (
                f"Must be between 1 and {MAX_CONSECUTIVE_BREACHES} evaluations.")
        # The two bars interact, and the combination can be silently
        # unsatisfiable: waiting 30 minutes across 2 evaluations that run hourly
        # is fine, but requiring 5 consecutive evaluations on an hourly rule
        # means nothing fires for five hours — which is a legitimate choice but
        # almost never the intended one, so it is stated rather than assumed.
        if consecutive > 1 and interval:
            implied = consecutive * interval
            if implied > MAX_MIN_DURATION_SECONDS:
                errors["consecutive_breaches_required"] = (
                    f"{consecutive} consecutive evaluations at one every "
                    f"{interval // 60} minute(s) means nothing would alert for "
                    f"{implied // 3600} hours. Lengthen the interval or lower "
                    "this instead.")

        mode = str(data.get("notification_mode") or policy.MODE_IMMEDIATE)
        if mode not in policy.MODES:
            errors["notification_mode"] = (
                f"Must be one of: {', '.join(policy.MODES)}.")

        escalate = _int(data.get("escalate_after_seconds"), 0)
        if escalate < 0 or escalate > MAX_ESCALATION_SECONDS:
            errors["escalate_after_seconds"] = (
                "Escalation must be between 0 (off) and 7 days.")

        notification = await self._validate_notification(
            account, data.get("notification_config"), errors)

        # Escalating to nobody is a rule that will latch and silently do
        # nothing at the moment it matters most, so it is refused rather than
        # accepted and logged later.
        if escalate > 0 and not notification.get("escalation_recipients"):
            errors["escalate_after_seconds"] = (
                "Escalation is on but no escalation recipients are set, so "
                "there would be nobody to escalate to. Add at least one, or "
                "turn escalation off.")

        # A digest that can never contain anything is a setting that looks
        # configured and does nothing.
        if mode != policy.MODE_IMMEDIATE and severity in policy.ALWAYS_IMMEDIATE:
            errors["notification_mode"] = (
                f"{severity} alerts are always sent immediately and are never "
                "batched, so a digest setting would have no effect. Lower the "
                "severity or keep this on immediate.")

        scope = {}
        clean_config: Dict[str, Any] = {}
        if condition is not None:
            scope = catalog.clean_scope(condition_type, data.get("scope_config"))
            try:
                clean_config = catalog.validate(
                    condition_type, data.get("condition_config"),
                    data.get("scope_config"))
            except catalog.ValidationError as exc:
                errors.update(exc.errors)

            # Refuse to store a rule the engine has already said it cannot
            # answer for this account. This is the check that stops the
            # "configured but permanently UNKNOWN" rule from existing.
            support = (await catalog.account_support(self.db, account)).get(
                condition_type, {})
            if not support.get("supported", True):
                errors["condition_type"] = support.get(
                    "reason",
                    "This condition cannot be evaluated for this account.")

        if errors:
            raise catalog.ValidationError(errors)

        return {
            "name": name,
            "description": (str(data.get("description")).strip()
                            if data.get("description") else None),
            "category": condition.category,
            "condition_type": condition_type,
            "condition_version": condition.version,
            "condition_config": clean_config,
            "scope_config": scope or None,
            "severity": severity,
            "enabled": bool(data.get("enabled", True)),
            "notification_config": notification,
            "evaluation_interval_seconds": interval,
            "cooldown_seconds": cooldown,
            "repeat_interval_seconds": repeat,
            "notify_on_resolution": bool(data.get("notify_on_resolution", False)),
            "min_duration_seconds": hold,
            "consecutive_breaches_required": consecutive,
            "notification_mode": mode,
            "escalate_after_seconds": escalate,
            "respect_quiet_hours": bool(data.get("respect_quiet_hours", True)),
        }

    async def _validate_notification(self, account, raw: Optional[dict],
                                     errors: Dict[str, str]) -> Dict[str, Any]:
        cfg = dict(raw or {})
        channels = [str(c).strip().lower()
                    for c in (cfg.get("channels") or ["email"]) if c]
        # Email is the only channel that sends anything today — every other
        # entry in the database service's dispatch map is a stub that returns
        # "not yet connected". Accepting one here would let someone configure a
        # rule that can never notify and be told nothing about it.
        unsupported = [c for c in channels if c != "email"]
        if unsupported:
            errors["notification_config.channels"] = (
                f"{', '.join(sorted(set(unsupported)))} "
                + ("is" if len(set(unsupported)) == 1 else "are")
                + " not connected in this build; email is the only channel that "
                  "delivers. The configuration would be saved and never used.")
        if not channels:
            channels = ["email"]

        clean: Dict[str, Any] = {
            "channels": ["email"],
            "use_account_defaults": bool(cfg.get("use_account_defaults", True)),
        }
        for key in ("recipients", "cc", "bcc", "escalation_recipients"):
            addresses, bad = [], []
            for address in (cfg.get(key) or []):
                text = str(address).strip()
                if not text:
                    continue
                (addresses if notifier.valid_email(text) else bad).append(text)
            if bad:
                errors[f"notification_config.{key}"] = (
                    f"Not a valid email address: {', '.join(bad)}.")
            clean[key] = addresses

        # A rule that notifies nobody is almost always a mistake, but it is a
        # legitimate one — an alert can be worth recording in the feed without
        # emailing anyone. So this warns on the returned payload rather than
        # refusing to save.
        if not clean["recipients"] and not clean["use_account_defaults"]:
            clean["_warning"] = (
                "This rule has no recipients of its own and does not use the "
                "account defaults, so it will record alerts but email nobody.")
        return clean

    # ── Recipients ───────────────────────────────────────────────────────────
    async def list_recipients(self, account_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        rows = await self.repo.recipients(account.id)
        return {
            "account_id": str(account.id),
            "recipients": [r.to_dict() for r in rows],
            "delivery": await notifier.delivery_status(self.db),
        }

    async def add_recipient(self, account_id: str, email: str,
                            *, label: Optional[str] = None, kind: str = "to",
                            actor: Optional[str] = None,
                            actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        email = (email or "").strip()
        kind = (kind or "to").strip().lower()
        errors: Dict[str, str] = {}
        if not notifier.valid_email(email):
            errors["email"] = f"{email!r} is not a valid email address."
        if kind not in ("to", "cc", "bcc"):
            errors["kind"] = "Recipient kind must be to, cc or bcc."
        if not errors and await self.repo.recipient_exists(account.id, email, kind):
            errors["email"] = (f"{email} is already configured as a {kind} "
                               "recipient for this account.")
        if errors:
            raise catalog.ValidationError(errors)

        row = await self.repo.add_recipient(CloudAlertRecipient(
            account_id=account.id, email=email, label=(label or None).strip()
            if label else None, kind=kind, created_by=actor))
        await self.repo.record(
            action=ACT_RECIPIENTS_CHANGED, account_id=account.id, actor=actor,
            actor_role=actor_role,
            summary=f"Added {kind.upper()} recipient {email}.",
            detail={"email": email, "kind": kind, "label": label},
        )
        await self.db.commit()
        return row.to_dict()

    async def set_recipient_enabled(self, account_id: str, recipient_id: str,
                                    enabled: bool, *, actor: Optional[str] = None,
                                    actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        row = await self.repo.get_recipient(_uuid(recipient_id), account.id)
        if row is None:
            raise NotFound("That recipient was not found on this account.")
        row.enabled = enabled
        await self.repo.record(
            action=ACT_RECIPIENTS_CHANGED, account_id=account.id, actor=actor,
            actor_role=actor_role,
            summary=(f"{'Enabled' if enabled else 'Disabled'} recipient "
                     f"{row.email}."),
            detail={"email": row.email, "enabled": enabled},
        )
        await self.db.commit()
        return row.to_dict()

    async def delete_recipient(self, account_id: str, recipient_id: str,
                               *, actor: Optional[str] = None,
                               actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        row = await self.repo.get_recipient(_uuid(recipient_id), account.id)
        if row is None:
            raise NotFound("That recipient was not found on this account.")
        email = row.email
        await self.db.delete(row)
        await self.repo.record(
            action=ACT_RECIPIENTS_CHANGED, account_id=account.id, actor=actor,
            actor_role=actor_role,
            summary=f"Removed recipient {email}.", detail={"email": email},
        )
        await self.db.commit()
        return {"deleted": True, "email": email}

    # ── Email delivery ───────────────────────────────────────────────────────
    async def email_settings(self, account_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        rows = await self.repo.recipients(account.id)
        delivery = await notifier.delivery_status(self.db)
        history = await self._delivery_history(limit=20)
        return {
            "account_id": str(account.id),
            "delivery": delivery,
            "recipients": [r.to_dict() for r in rows],
            "history": history["rows"],
            "history_totals": history["totals"],
            "channels": {
                # Said plainly rather than shown as a row of switches that do
                # nothing: eight of the nine channels in the shared dispatcher
                # are stubs.
                "email": {"implemented": True, "label": "Email"},
                "others": {
                    "implemented": False,
                    "label": "Teams, Slack, Telegram, WhatsApp, Webhook, "
                             "PagerDuty, Jira, ServiceNow",
                    "note": "Configuration for these is stored by the shared "
                            "notification settings, but no adapter delivers "
                            "them yet, so they are not offered on alert rules.",
                },
            },
        }

    async def enable_email_channel(self, account_id: str, *,
                                   actor: Optional[str] = None,
                                   actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        outcome = await notifier.enable_email_channel(self.db, actor)
        if outcome.get("ok"):
            await self.repo.record(
                action=ACT_RECIPIENTS_CHANGED, account_id=account.id, actor=actor,
                actor_role=actor_role,
                summary="Email delivery channel enabled.",
                detail={"scope": "shared notification channel (all alerting)"},
            )
            await self.db.commit()
        return {**outcome, "delivery": await notifier.delivery_status(self.db)}

    async def send_test_email(self, account_id: str,
                              *, recipients: Optional[Sequence[str]] = None,
                              actor: Optional[str] = None,
                              actor_role: Optional[str] = None) -> Dict[str, Any]:
        """Queue a clearly-labelled test message.

        Reports "queued", never "sent". Whether it is delivered is decided by
        the dispatcher a few seconds later and shown in the history table on
        the same page — which is exactly the distinction operators need when
        SMTP is misconfigured.
        """
        account = await self._account(account_id)

        to = [a.strip() for a in (recipients or []) if a and a.strip()]
        invalid = [a for a in to if not notifier.valid_email(a)]
        if invalid:
            raise catalog.ValidationError({
                "recipients": f"Not a valid email address: {', '.join(invalid)}."})
        if not to:
            defaults = await notifier.account_recipients(self.db, account.id)
            to = defaults.get("to") or []
        if not to:
            return {
                "queued": False,
                "reason": ("No recipient was given and this account has no "
                           "enabled default recipients, so there is nobody to "
                           "send a test to."),
                "delivery": await notifier.delivery_status(self.db),
            }

        delivery = await notifier.delivery_status(self.db)
        if not delivery["ready"]:
            return {
                "queued": False,
                "reason": "; ".join(b["message"] for b in delivery["blockers"]),
                "delivery": delivery,
            }

        mail = notifier.compose_test_email(
            account=account, base_url=engine.base_url(), actor=actor)
        queued, message = await notifier.queue_email(
            self.db, subject=mail["subject"], html_body=mail["html"],
            text_body=mail["text"], to=to,
            context={"AlertName": "Test notification",
                     "ServerName": account.account_name,
                     "Severity": "Information",
                     "AlertDescription": "Actmon cloud alerting test message.",
                     "Timestamp": datetime.now(timezone.utc).isoformat()},
        )
        await self.repo.record(
            action=ACT_NOTIFY_TEST, account_id=account.id, actor=actor,
            actor_role=actor_role,
            summary=(f"Test notification queued for {', '.join(to)}."
                     if queued else f"Test notification could not be queued: {message}"),
            detail={"to": to, "queued": queued, "message": message},
        )
        await self.db.commit()
        return {
            "queued": queued,
            "recipients": to,
            "message": message,
            "note": ("Queued for delivery. The result appears in Delivery "
                     "history within about ten seconds — 'queued' is not yet "
                     "'delivered'.") if queued else None,
            "delivery": delivery,
        }

    async def _delivery_history(self, *, limit: int = 20) -> Dict[str, Any]:
        """Real rows from the shared notification ledger, cloud alerts only."""
        from sqlalchemy import text as sql

        try:
            rows = (await self.db.execute(sql(
                "SELECT sent_at, alert_name, server_name, severity, recipient, "
                "       status, response_code, response_time_ms, retry_count, "
                "       error_message "
                "FROM notification_history "
                "WHERE channel_type = 'email' "
                "ORDER BY sent_at DESC LIMIT :limit"
            ), {"limit": limit})).mappings().all()
            totals = (await self.db.execute(sql(
                "SELECT status, COUNT(*) FROM notification_history "
                "WHERE channel_type = 'email' "
                "  AND sent_at >= now() - interval '7 days' "
                "GROUP BY status"
            ))).all()
            pending = (await self.db.execute(sql(
                "SELECT COUNT(*) FROM notification_queue "
                "WHERE channel_type = 'email' AND status = 'pending'"
            ))).scalar_one()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not read notification history: %s", exc)
            # None, not zero. "We could not read the ledger" and "nothing has
            # ever been sent" are different facts.
            return {"rows": [], "totals": {"available": False, "reason": str(exc)}}

        return {
            "rows": [
                {"at": _iso(r["sent_at"]), "alert": r["alert_name"],
                 "account": r["server_name"], "severity": r["severity"],
                 "recipient": r["recipient"], "status": r["status"],
                 "response_code": r["response_code"],
                 "response_time_ms": r["response_time_ms"],
                 "retries": r["retry_count"], "error": r["error_message"]}
                for r in rows
            ],
            "totals": {
                "available": True,
                "window_days": 7,
                **{str(status): int(count) for status, count in totals},
                "pending": int(pending or 0),
            },
        }

    # ── Alert instances ──────────────────────────────────────────────────────
    async def list_alerts(self, account_id: str, *, states: Optional[List[str]] = None,
                          severity: Optional[str] = None,
                          category: Optional[str] = None,
                          rule_id: Optional[str] = None,
                          days: Optional[int] = None,
                          search: Optional[str] = None,
                          limit: int = 200) -> Dict[str, Any]:
        account = await self._account(account_id)
        stmt = select(CloudAlert).where(CloudAlert.account_id == account.id)
        if states:
            stmt = stmt.where(CloudAlert.state.in_(states))
        if severity:
            stmt = stmt.where(CloudAlert.severity == severity.upper())
        if category:
            stmt = stmt.where(CloudAlert.anomaly_type.ilike(f"{category.upper()}:%"))
        if rule_id and _uuid(rule_id):
            stmt = stmt.where(CloudAlert.rule_id == _uuid(rule_id))
        if days:
            stmt = stmt.where(
                CloudAlert.created_at >= datetime.now(timezone.utc)
                - timedelta(days=int(days)))
        if search:
            like = f"%{search.strip().lower()}%"
            stmt = stmt.where(
                func.lower(CloudAlert.details).like(like)
                | func.lower(CloudAlert.anomaly_type).like(like)
                | func.lower(func.coalesce(CloudAlert.resource_name, "")).like(like)
            )
        stmt = stmt.order_by(CloudAlert.created_at.desc()).limit(min(limit, 500))
        rows = list((await self.db.execute(stmt)).scalars().all())

        # Rule names for the rows whose rule still exists. A rule that was
        # deleted is labelled as such rather than shown with a blank name.
        rule_ids = {r.rule_id for r in rows if r.rule_id}
        names: Dict[uuid.UUID, str] = {}
        if rule_ids:
            found = (await self.db.execute(
                select(CloudAlertRule.id, CloudAlertRule.name,
                       CloudAlertRule.deleted_at)
                .where(CloudAlertRule.id.in_(list(rule_ids)))
            )).all()
            names = {rid: (f"{name} (deleted)" if deleted else name)
                     for rid, name, deleted in found}

        return {
            "account_id": str(account.id),
            "alerts": [
                {**a.to_dict(),
                 "rule_name": names.get(a.rule_id) if a.rule_id else None,
                 "category": (a.anomaly_type.split(":", 1)[0].lower()
                              if ":" in (a.anomaly_type or "") else None)}
                for a in rows
            ],
            "returned": len(rows),
            "truncated": len(rows) >= min(limit, 500),
        }

    async def get_alert(self, account_id: str, alert_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        parsed = _uuid(alert_id)
        alert = await self.alerts.get_by_id(parsed) if parsed else None
        if alert is None or alert.account_id != account.id:
            raise NotFound(f"Alert {alert_id} was not found on this account.")

        rule = None
        if alert.rule_id:
            rule = await self.repo.get(alert.rule_id, include_deleted=True)

        return {
            **alert.to_dict(),
            "rule": (self._serialize(rule, account) if rule else None),
            "rule_deleted": bool(rule and rule.deleted_at),
            # The evaluation snapshot that produced it — the "why did this
            # fire" panel reads this, not a re-evaluation. Re-running would
            # answer "is it true NOW", which is a different question.
            "explain": (alert.context or {}).get("explain"),
            "activity": [e.to_dict() for e in await self.repo.activity(
                account.id, alert_id=alert.id, limit=50)],
        }

    async def act_on_alert(self, account_id: str, alert_id: str, action: str,
                           *, reason: Optional[str] = None,
                           actor: Optional[str] = None,
                           actor_role: Optional[str] = None) -> Dict[str, Any]:
        account = await self._account(account_id)
        parsed = _uuid(alert_id)
        alert = await self.alerts.get_by_id(parsed) if parsed else None
        if alert is None or alert.account_id != account.id:
            raise NotFound(f"Alert {alert_id} was not found on this account.")

        if action == "acknowledge":
            alert.state = STATE_ACKNOWLEDGED
            alert.is_read = True
            alert.acknowledged_at = datetime.now(timezone.utc)
            alert.acknowledged_by = actor
            audit, summary = ACT_ALERT_ACKNOWLEDGED, "acknowledged"
        elif action == "resolve":
            alert.state = STATE_RESOLVED
            alert.is_read = True
            alert.resolved_at = datetime.now(timezone.utc)
            alert.resolved_by = actor
            alert.resolution_reason = reason or "Resolved manually."
            audit, summary = ACT_ALERT_RESOLVED, "resolved manually"
        else:
            raise catalog.ValidationError({
                "action": "Action must be 'acknowledge' or 'resolve'."})

        await self.repo.record(
            action=audit, account_id=account.id, rule_id=alert.rule_id,
            alert_id=alert.id, severity=alert.severity, actor=actor,
            actor_role=actor_role,
            summary=f"Alert {summary}: {alert.anomaly_type}",
            detail={"reason": reason} if reason else None,
        )
        await self.db.commit()

        # Said out loud because it surprises people: a manually resolved alert
        # whose condition is still true will be re-opened by the next
        # evaluation. That is correct — the problem did not go away — but it
        # looks like a bug if nobody says so.
        note = None
        if action == "resolve" and alert.rule_id:
            note = ("If the condition is still true at the next evaluation this "
                    "alert will re-open. Disable the rule if you want it to "
                    "stay closed.")
        return {**alert.to_dict(), "note": note}

    # ── Summary ──────────────────────────────────────────────────────────────
    async def summary(self, account_id: str) -> Dict[str, Any]:
        account = await self._account(account_id)
        counts = await self.repo.counts_for_account(account.id)
        states = await self.alerts.counts_by_state(account.id)

        by_severity = dict((await self.db.execute(
            select(CloudAlert.severity, func.count())
            .where(CloudAlert.account_id == account.id,
                   CloudAlert.state.in_([STATE_OPEN, STATE_ACKNOWLEDGED]))
            .group_by(CloudAlert.severity)
        )).all())

        history = await self._delivery_history(limit=1)
        delivery = await notifier.delivery_status(self.db)
        activity = await self.repo.activity_counts(account.id, days=7)

        # Rules whose last evaluation could not reach their source. Surfaced as
        # its own number because "14 rules enabled, 0 alerts" reads as healthy
        # and can mean 14 rules that have not managed to read anything.
        inconclusive = (await self.db.execute(
            select(func.count()).select_from(CloudAlertRule).where(
                CloudAlertRule.account_id == account.id,
                CloudAlertRule.deleted_at.is_(None),
                CloudAlertRule.enabled.is_(True),
                CloudAlertRule.last_result.in_(["UNKNOWN", "ERROR", "UNSUPPORTED"]),
            )
        )).scalar_one()
        never = (await self.db.execute(
            select(func.count()).select_from(CloudAlertRule).where(
                CloudAlertRule.account_id == account.id,
                CloudAlertRule.deleted_at.is_(None),
                CloudAlertRule.enabled.is_(True),
                CloudAlertRule.last_evaluated_at.is_(None),
            )
        )).scalar_one()
        last_eval = (await self.db.execute(
            select(func.max(CloudAlertRule.last_evaluated_at)).where(
                CloudAlertRule.account_id == account.id,
                CloudAlertRule.deleted_at.is_(None))
        )).scalar_one()

        if not delivery["ready"]:
            system, system_detail = "configuration_required", (
                "; ".join(b["message"] for b in delivery["blockers"]))
        elif inconclusive:
            system, system_detail = "degraded", (
                f"{inconclusive} enabled rule(s) could not read their data "
                "source at the last evaluation.")
        elif not counts["enabled"]:
            system, system_detail = "configuration_required", (
                "No alert rules are enabled for this account, so nothing is "
                "being watched.")
        else:
            system, system_detail = "healthy", None

        return {
            "account_id": str(account.id),
            "active_alerts": states.get(STATE_OPEN, 0) + states.get(STATE_ACKNOWLEDGED, 0),
            "alerts_by_state": states,
            "alerts_by_severity": by_severity,
            "rules": counts,
            "rules_inconclusive": int(inconclusive or 0),
            "rules_never_evaluated": int(never or 0),
            "last_evaluation_at": _iso(last_eval),
            "delivery": delivery,
            "notifications": history["totals"],
            "activity_7d": activity,
            "engine": engine.engine_status(),
            "system_status": system,
            "system_detail": system_detail,
        }

    async def activity(self, account_id: str, *, days: int = 30,
                       limit: int = 100) -> Dict[str, Any]:
        account = await self._account(account_id)
        rows = await self.repo.activity(account.id, days=days, limit=limit)
        return {"account_id": str(account.id),
                "activity": [r.to_dict() for r in rows]}

    # ── Serialization ────────────────────────────────────────────────────────
    def _serialize(self, rule: CloudAlertRule, account) -> Dict[str, Any]:
        return rule.to_dict(human=catalog.describe(
            rule.condition_type, rule.condition_config, rule.scope_config,
            account.account_name))


def _uuid(value) -> Optional[uuid.UUID]:
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _int(value, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)
