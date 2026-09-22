"""Alert rules, their audit trail, and account-level notification recipients.

Three tables, and the reason each is separate:

*   **CloudAlertRule** — what someone asked to be told about. A rule is
    configuration; it is not a problem and it is not a notification.

*   **CloudAlertEvent** — the append-only record of what the rule engine and the
    people using it actually did: evaluated, triggered, notified, failed to
    notify, acknowledged, resolved, enabled, disabled. This is deliberately NOT
    written into `cloud_events`. That table is documented as the provider
    control-plane audit mirror — "Every row originates from AWS CloudTrail,
    Azure Activity Log or OCI Audit … It is NOT an application log" — and its
    `provider` column is NOT NULL. Writing Actmon's own actions there would
    claim a provider emitted them, corrupt the per-provider event counts and
    the collector's sync-state health, and be exactly the fabrication the rest
    of this feature forbids. So alert activity gets its own audit trail, and
    the Alerts UI links to the Event Log rather than pretending to be it.

*   **CloudAlertRecipient** — who to email. Account-level defaults live here;
    a rule may override them in `notification_config`. This exists because the
    notification path the database service already owns takes recipients
    ENTIRELY from the firing rule ("there is no org-wide default recipient" —
    email_channel_service.send_via_channel), and a cloud alert previously had
    nowhere to put one. That is why `notification_bridge` used to drop the
    email channel outright: routing it could only ever produce a
    guaranteed-fail queue row. This table is the missing half.

The triggered alerts themselves are NOT modelled here. They already exist in
`cloud_alerts` (app/models/alert.py) with dedupe_key, a three-state lifecycle,
occurrence counting, severity-escalation tracking and notification-cooldown
columns. A second alert-instance table would be a second answer to "what is
currently wrong", so the engine writes into that one and this module only adds
the `rule_id` and `fingerprint` link back to the rule that produced it.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target)

# JSONB that stores Python None as SQL NULL rather than the JSON literal
# `null` — same reasoning as cloud_event.py: without it, `WHERE col IS NULL`
# is false for a column set to None, and every SQL-level null check silently
# returns the wrong rows.
_NULLABLE_JSONB = JSONB(none_as_null=True)


# ── Severity ──────────────────────────────────────────────────────────────────
# The same five levels the rest of the cloud service already uses (drift_rules,
# exposure_service, security findings), so a rule's severity means the same
# thing as a finding's severity and the routing buckets keep working.
SEV_CRITICAL = "CRITICAL"
SEV_HIGH = "HIGH"
SEV_MEDIUM = "MEDIUM"
SEV_LOW = "LOW"
SEV_INFO = "INFO"
SEVERITIES = (SEV_CRITICAL, SEV_HIGH, SEV_MEDIUM, SEV_LOW, SEV_INFO)
SEVERITY_ORDER = {s: i for i, s in enumerate(SEVERITIES)}


# ── Categories ────────────────────────────────────────────────────────────────
CAT_SECURITY = "security"
CAT_COST = "cost"
CAT_RESOURCE = "resource"
CAT_DRIFT = "drift"
CAT_EVENT = "event"
CAT_DISCOVERY = "discovery"
CAT_PLATFORM = "platform"
CATEGORIES = (
    CAT_SECURITY, CAT_COST, CAT_RESOURCE, CAT_DRIFT,
    CAT_EVENT, CAT_DISCOVERY, CAT_PLATFORM,
)


# ── Evaluation outcome ────────────────────────────────────────────────────────
# Six states, not two. The distinction between "the condition is false" and
# "we could not find out" is the single most important thing in this feature:
# a rate-limited billing API must never read as zero spend, and an
# unreachable security assessment must never read as zero findings.
# NOT_TRIGGERED resolves an open alert; UNKNOWN and ERROR deliberately do not.
EVAL_TRIGGERED = "TRIGGERED"
EVAL_NOT_TRIGGERED = "NOT_TRIGGERED"
EVAL_RESOLVED = "RESOLVED"
EVAL_UNKNOWN = "UNKNOWN"
EVAL_ERROR = "ERROR"
EVAL_UNSUPPORTED = "UNSUPPORTED"
EVAL_STATES = (
    EVAL_TRIGGERED, EVAL_NOT_TRIGGERED, EVAL_RESOLVED,
    EVAL_UNKNOWN, EVAL_ERROR, EVAL_UNSUPPORTED,
)
# The states in which the source could not be read. Grouped once here because
# three different places need the same answer to "may I resolve on this?".
EVAL_INCONCLUSIVE = (EVAL_UNKNOWN, EVAL_ERROR, EVAL_UNSUPPORTED)


# ── Alert activity actions ────────────────────────────────────────────────────
ACT_RULE_CREATED = "rule.created"
ACT_RULE_UPDATED = "rule.updated"
ACT_RULE_ENABLED = "rule.enabled"
ACT_RULE_DISABLED = "rule.disabled"
ACT_RULE_DELETED = "rule.deleted"
ACT_RULE_TESTED = "rule.tested"
ACT_RULE_SILENCED = "rule.silenced"
ACT_RULE_UNSILENCED = "rule.unsilenced"
ACT_SETTINGS_CHANGED = "settings.changed"
ACT_ALERT_TRIGGERED = "alert.triggered"
ACT_ALERT_RESOLVED = "alert.resolved"
ACT_ALERT_ACKNOWLEDGED = "alert.acknowledged"
ACT_ALERT_ESCALATED = "alert.escalated"
ACT_ALERT_SILENCED = "alert.silenced"
ACT_EVAL_UNKNOWN = "evaluation.unknown"
ACT_EVAL_ERROR = "evaluation.error"
ACT_NOTIFY_QUEUED = "notification.queued"
ACT_NOTIFY_SKIPPED = "notification.skipped"
ACT_NOTIFY_TEST = "notification.test"
ACT_RECIPIENTS_CHANGED = "recipients.changed"

# Default evaluation cadence, in seconds. Five minutes matches the shortest
# interval the UI offers and is comfortably slower than any source it reads.
DEFAULT_INTERVAL_SECONDS = 300
MIN_INTERVAL_SECONDS = 300
DEFAULT_COOLDOWN_SECONDS = 3600


class CloudAlertRule(Base):
    """One configured condition, scoped to exactly one cloud account.

    `account_id` is NOT NULL on purpose. Every other scoping field is optional
    and narrows within the account; nothing widens beyond it. That is what
    makes cross-account leakage a structural impossibility rather than a thing
    each evaluator has to remember.
    """

    __tablename__ = "cloud_alert_rules"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # Denormalized from the account so an evaluator can decide provider support
    # without a join, and so a rule's history stays readable after the account
    # is gone.
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    condition_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Versioned so a condition's meaning can change without silently
    # reinterpreting rules saved under the old meaning.
    condition_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # {operator, threshold, severity_filter, period, currency, ...} — the
    # catalog (services/alerts/catalog.py) owns which keys each type accepts
    # and validates them before this is ever written.
    condition_config: Mapped[dict] = mapped_column(
        _NULLABLE_JSONB, nullable=False, default=dict)
    # {region, resource_type, service, ...} — always a NARROWING of account_id.
    scope_config: Mapped[Optional[dict]] = mapped_column(_NULLABLE_JSONB, nullable=True)

    severity: Mapped[str] = mapped_column(
        String(20), nullable=False, default=SEV_MEDIUM, index=True)
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, index=True)

    # ── Notification ─────────────────────────────────────────────────────────
    # {channels: ["email"], recipients: [...], cc: [...], bcc: [...],
    #  use_account_defaults: bool}
    # An empty recipients list with use_account_defaults=true means "whoever is
    # configured for this account", which is resolved at send time so adding a
    # recipient later applies to rules that already exist.
    notification_config: Mapped[Optional[dict]] = mapped_column(
        _NULLABLE_JSONB, nullable=True)

    evaluation_interval_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=DEFAULT_INTERVAL_SECONDS)
    # At most one notification per fingerprint per this many seconds. Separate
    # from the alert lifecycle: an alert stays OPEN through its cooldown, it
    # just stops emailing.
    cooldown_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=DEFAULT_COOLDOWN_SECONDS)
    # 0 = notify once. Otherwise re-notify this often while still unresolved.
    repeat_interval_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0)
    notify_on_resolution: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False)

    # ── Notification preferences ─────────────────────────────────────────────
    # How this rule's mail is paced. IMMEDIATE is the default because an alert
    # nobody sees for an hour is not an alert; digests exist for the rules that
    # are genuinely informational and would otherwise be muted entirely, which
    # is the worse outcome.
    #
    # A digest NEVER swallows a CRITICAL. That is enforced in the notifier
    # rather than left to configuration, because "I set it to daily and missed
    # a breach" is a mistake the product should not let someone make.
    notification_mode: Mapped[str] = mapped_column(
        String(24), nullable=False, default="immediate")

    # Escalate to a second set of recipients when nobody has acknowledged the
    # alert after this long. 0 = off. The escalation recipients live in
    # notification_config["escalation_recipients"].
    escalate_after_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0)

    # Whether this rule honours the installation's quiet hours. On by default;
    # a rule someone deliberately exempts is saying "wake me for this".
    respect_quiet_hours: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True)

    # ── False-positive protection ────────────────────────────────────────────
    # A condition must hold for this long, AND across this many consecutive
    # evaluations, before an alert opens. Both default to "no wait", so an
    # existing rule behaves exactly as before.
    #
    # Two bars rather than one because they answer different questions. Duration
    # covers "was this a momentary spike"; consecutive evaluations covers "did we
    # see it twice, or did one flaky read do it". A cost rule wants the second; a
    # utilisation rule wants the first.
    min_duration_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0)
    consecutive_breaches_required: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1)

    # ── Silence ──────────────────────────────────────────────────────────────
    # Silencing suppresses NOTIFICATION, not evaluation. The rule keeps running
    # and keeps opening and resolving alerts, so the Alerts tab stays truthful
    # about what is wrong; it just stops emailing. Disabling a rule is the other
    # thing, and the two are deliberately not the same control: a silenced rule
    # that is quietly not evaluating is how a real incident gets missed.
    silenced_until: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    silenced_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    silence_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Engine state ─────────────────────────────────────────────────────────
    # Nullable, and NULL means "never evaluated" — which the UI must render as
    # such rather than as "0 minutes ago".
    last_evaluated_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    last_triggered_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    last_result: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # Why the last evaluation landed where it did, in a sentence. This is what
    # makes "UNKNOWN" actionable instead of mysterious.
    last_result_detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_observed_value: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_evaluation_ms: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    consecutive_errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    trigger_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── Audit ────────────────────────────────────────────────────────────────
    created_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc), index=True)
    updated_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc))
    # Soft delete. Alert history outlives its rule, so deleting a rule must not
    # orphan or cascade away what it already told people.
    deleted_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True)
    deleted_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    __table_args__ = (
        # The engine's own query: enabled, not deleted, due for evaluation.
        Index("ix_cloud_alert_rules_due", "enabled", "deleted_at", "last_evaluated_at"),
        Index("ix_cloud_alert_rules_account_enabled", "account_id", "enabled"),
        # Two rules with the same name on one account is a support call waiting
        # to happen. Scoped to live rules so a name can be reused after delete.
        Index("uq_cloud_alert_rules_account_name", "account_id", "name",
              unique=True, postgresql_where=deleted_at.is_(None)),
    )

    @property
    def is_deleted(self) -> bool:
        return self.deleted_at is not None

    def recipients(self) -> Dict[str, List[str]]:
        """This rule's own recipient overrides. Does NOT resolve account
        defaults — that happens at send time so a later change to the defaults
        reaches rules that already exist."""
        cfg = self.notification_config or {}

        def _clean(key):
            return [str(a).strip() for a in (cfg.get(key) or []) if str(a).strip()]

        return {"to": _clean("recipients"), "cc": _clean("cc"), "bcc": _clean("bcc")}

    def uses_account_defaults(self) -> bool:
        cfg = self.notification_config or {}
        # Defaults ON unless explicitly turned off, so a rule created without
        # touching notifications still reaches somebody.
        return bool(cfg.get("use_account_defaults", True))

    def channels(self) -> List[str]:
        cfg = self.notification_config or {}
        chans = [str(c).strip().lower() for c in (cfg.get("channels") or []) if c]
        return chans or ["email"]

    def is_silenced(self, now: Optional[datetime] = None) -> bool:
        if self.silenced_until is None:
            return False
        now = now or datetime.now(timezone.utc)
        until = self.silenced_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > now

    def to_dict(self, *, human: Optional[str] = None) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "name": self.name,
            "description": self.description,
            "category": self.category,
            "condition_type": self.condition_type,
            "condition_version": self.condition_version,
            "condition_config": self.condition_config or {},
            "scope_config": self.scope_config or {},
            "condition_human": human,
            "severity": self.severity,
            "enabled": self.enabled,
            "notification_config": self.notification_config or {},
            "evaluation_interval_seconds": self.evaluation_interval_seconds,
            "cooldown_seconds": self.cooldown_seconds,
            "repeat_interval_seconds": self.repeat_interval_seconds,
            "notify_on_resolution": self.notify_on_resolution,
            "min_duration_seconds": self.min_duration_seconds,
            "consecutive_breaches_required": self.consecutive_breaches_required,
            "notification_mode": self.notification_mode,
            "escalate_after_seconds": self.escalate_after_seconds,
            "respect_quiet_hours": self.respect_quiet_hours,
            "silenced_until": _iso(self.silenced_until),
            "silenced_by": self.silenced_by,
            "silence_reason": self.silence_reason,
            "is_silenced": self.is_silenced(),
            "last_evaluated_at": _iso(self.last_evaluated_at),
            "last_triggered_at": _iso(self.last_triggered_at),
            "last_result": self.last_result,
            "last_result_detail": self.last_result_detail,
            "last_observed_value": self.last_observed_value,
            "last_evaluation_ms": self.last_evaluation_ms,
            "consecutive_errors": self.consecutive_errors,
            "trigger_count": self.trigger_count,
            "created_by": self.created_by,
            "created_at": _iso(self.created_at),
            "updated_by": self.updated_by,
            "updated_at": _iso(self.updated_at),
            "deleted_at": _iso(self.deleted_at),
        }


class CloudAlertEvent(Base):
    """Append-only activity for the alerting subsystem.

    Never updated and never deleted by application code — there is no update
    path in the repository. It is the answer to "why did this fire", "who
    turned it off", and "did the email actually go out", and all three are
    questions where a rewritable record is worth very little.
    """

    __tablename__ = "cloud_alert_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc), index=True)

    # All three nullable and all three SET NULL rather than CASCADE: the
    # activity log has to survive the rule, the alert and the account it
    # describes, or "rule deleted" becomes unprovable.
    account_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True, index=True)
    rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_alert_rules.id", ondelete="SET NULL"),
        nullable=True, index=True)
    alert_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True)

    action: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    severity: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # Kept even when rule_id is nulled by a delete, so history stays legible.
    rule_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    actor: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    actor_role: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # The evaluation snapshot for a trigger; the delivery result for a
    # notification. Never secrets — see services/alerts/notifier.py.
    detail: Mapped[Optional[dict]] = mapped_column(_NULLABLE_JSONB, nullable=True)

    __table_args__ = (
        Index("ix_cloud_alert_events_account_at", "account_id", "at"),
        Index("ix_cloud_alert_events_rule_at", "rule_id", "at"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "at": _iso(self.at),
            "account_id": str(self.account_id) if self.account_id else None,
            "rule_id": str(self.rule_id) if self.rule_id else None,
            "alert_id": str(self.alert_id) if self.alert_id else None,
            "action": self.action,
            "severity": self.severity,
            "rule_name": self.rule_name,
            "summary": self.summary,
            "actor": self.actor,
            "actor_role": self.actor_role,
            "detail": self.detail,
        }


class CloudAlertRecipient(Base):
    """An account-level default email recipient.

    Disabling rather than deleting is the common case — someone goes on leave,
    a team is reorganized — so `enabled` exists and the row survives.
    """

    __tablename__ = "cloud_alert_recipients"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True)

    email: Mapped[str] = mapped_column(String(320), nullable=False)
    label: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # "to" | "cc" | "bcc"
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="to")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("account_id", "email", "kind",
                         name="uq_cloud_alert_recipient"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "email": self.email,
            "label": self.label,
            "kind": self.kind,
            "enabled": self.enabled,
            "created_by": self.created_by,
            "created_at": _iso(self.created_at),
        }


class CloudAlertSettings(Base):
    """One row. Retention policy for the alerting subsystem.

    Retention is data rather than a constant because the right answer differs
    per installation: an audit-heavy tenant keeps activity for a year, a busy
    one cannot afford to. The defaults are deliberately generous — pruning is
    irreversible, and a first boot that silently discarded three months of
    history would be worse than a table that grew.

    What is pruned and what is NOT:

    *   Resolved alerts older than `alert_retention_days` are removed. OPEN and
        ACKNOWLEDGED alerts are NEVER pruned regardless of age — an unresolved
        problem does not stop being a problem because it is old, and deleting
        it would make the estate look healthier than it is.
    *   Activity rows older than `activity_retention_days` go. This is the
        audit trail, so its default is the longest.
    *   Notification payloads are the bulky part (a rendered HTML email per
        row), so `notification_payload_days` strips the body from delivered
        rows while keeping the delivery RECORD forever-ish. "Did this email go
        out" must stay answerable long after the email itself is uninteresting.
    """

    __tablename__ = "cloud_alert_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)

    alert_retention_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=180)
    activity_retention_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=365)
    notification_payload_days: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30)
    # Off by default. Pruning is irreversible, so it is an explicit decision.
    pruning_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False)

    # IANA zone used to render timestamps in email. The UI renders in the
    # reader's own browser zone; email has no browser, so it needs one stated.
    display_timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, default="Asia/Kolkata")

    # ── Quiet hours ──────────────────────────────────────────────────────────
    # A window in `display_timezone` during which non-critical mail is held
    # until morning rather than sent. Off by default: silently withholding
    # alerts is not something to start doing without being asked.
    #
    # `quiet_hours_critical_bypass` defaults to True and the notifier treats it
    # as a floor rather than a preference — a CRITICAL alert sent at 3am is
    # occasionally unwelcome, and one NOT sent at 3am is occasionally a
    # disaster.
    quiet_hours_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False)
    # "HH:MM" local to display_timezone. Start > end means the window crosses
    # midnight, which is the normal case (22:00 → 07:00).
    quiet_hours_start: Mapped[str] = mapped_column(
        String(5), nullable=False, default="22:00")
    quiet_hours_end: Mapped[str] = mapped_column(
        String(5), nullable=False, default="07:00")
    quiet_hours_critical_bypass: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True)

    # ── Digest ───────────────────────────────────────────────────────────────
    # When each digest cadence last went out, so a restart cannot re-send one
    # and a missed window is not silently skipped.
    last_hourly_digest_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    last_daily_digest_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)

    last_pruned_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True)
    last_prune_result: Mapped[Optional[dict]] = mapped_column(
        _NULLABLE_JSONB, nullable=True)

    updated_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alert_retention_days": self.alert_retention_days,
            "activity_retention_days": self.activity_retention_days,
            "notification_payload_days": self.notification_payload_days,
            "pruning_enabled": self.pruning_enabled,
            "display_timezone": self.display_timezone,
            "quiet_hours_enabled": self.quiet_hours_enabled,
            "quiet_hours_start": self.quiet_hours_start,
            "quiet_hours_end": self.quiet_hours_end,
            "quiet_hours_critical_bypass": self.quiet_hours_critical_bypass,
            "last_hourly_digest_at": _iso(self.last_hourly_digest_at),
            "last_daily_digest_at": _iso(self.last_daily_digest_at),
            "last_pruned_at": _iso(self.last_pruned_at),
            "last_prune_result": self.last_prune_result,
            "updated_by": self.updated_by,
            "updated_at": _iso(self.updated_at),
            "note": ("Open and acknowledged alerts are never pruned, whatever "
                     "their age. Only resolved ones expire."),
        }


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None
