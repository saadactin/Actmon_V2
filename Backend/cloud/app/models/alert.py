"""SQLAlchemy ORM model for cloud_alerts.

Alerts used to live in a plain Python list on a module-level service instance,
so every restart silently erased the entire alert history — and a monitoring
tool that forgets what it told you is not one anyone can act on. This table
gives them a lifecycle (open → acknowledged → resolved) and a durable record.

`dedupe_key` is what keeps a recurring condition from producing a new row on
every discovery cycle: the same key re-opens or updates the existing alert
instead of appending a duplicate.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# The account_id foreign key can only resolve if cloud_accounts is registered in
# the same metadata. Importing it here makes this model self-sufficient instead
# of silently depending on import order — without it, any entry point that
# reaches alerts without going through main.py fails on first flush with
# NoReferencedTableError. cloud_account does not import this module, so there is
# no cycle.
from app.models.cloud_account import CloudAccount  # noqa: F401

# Lifecycle states. OPEN is the only state that should page anyone.
STATE_OPEN = "OPEN"
STATE_ACKNOWLEDGED = "ACKNOWLEDGED"
STATE_RESOLVED = "RESOLVED"

# A breach that has been observed but has not yet cleared the rule's
# minimum-duration bar. PENDING exists so "CPU over 90% for 15 minutes" can be
# expressed without inventing a second table: the breach is recorded against the
# same dedupe_key the eventual alert will use, so the two cannot disagree about
# which condition on which resource is being tracked.
#
# A PENDING row is NOT an alert. It is excluded from the feed, from the counts
# and from notification. If the condition clears before the bar is met, the row
# is deleted outright rather than resolved — a transient spike that never became
# an alert should leave no history claiming it did.
STATE_PENDING = "PENDING"

# The states a human is meant to see. Everything that lists, counts or notifies
# filters on these, so adding a new internal state cannot leak into the feed by
# omission.
VISIBLE_STATES = (STATE_OPEN, STATE_ACKNOWLEDGED, STATE_RESOLVED)
ACTIVE_STATES = (STATE_OPEN, STATE_ACKNOWLEDGED)


class CloudAlert(Base):
    __tablename__ = "cloud_alerts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Nullable so a tenancy-wide alert that isn't tied to one account can exist;
    # SET NULL rather than CASCADE so deleting an account keeps its alert history.
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    anomaly_type: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    details: Mapped[str] = mapped_column(Text, nullable=False)

    # Stable identity for a recurring condition, e.g.
    # "STOPPED_INSTANCE_ATTACHED_STORAGE:<provider_resource_id>". Unique so the
    # database itself refuses duplicates even if two scans race.
    dedupe_key: Mapped[str | None] = mapped_column(String(600), nullable=True, unique=True)

    state: Mapped[str] = mapped_column(
        String(20), nullable=False, default=STATE_OPEN, index=True
    )
    # Kept for the existing UI, which reads is_read. Acknowledging sets both.
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Test alerts from the DEBUG-only simulate hook, so they can never be
    # mistaken for a real finding.
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # What the alert is about, when it points at a specific resource.
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    resource_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Anything rule-specific worth keeping without a schema change.
    context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # ── Link back to what caused it (§47) ────────────────────────────────────
    # An alert is a notification decision ABOUT a finding; the finding is the
    # statement of what is wrong. Keeping the link is what lets the UI go
    # Alert → Finding → Evidence → Topology → Remediation, and what stops the
    # two from drifting into separate stories about the same resource.
    #
    # `finding_fingerprint` rather than a foreign key to the findings row: the
    # fingerprint survives a resource being re-created, and an alert must not be
    # cascade-deleted just because its finding row was replaced.
    finding_fingerprint: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True)
    policy_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    policy_name: Mapped[str | None] = mapped_column(String(256), nullable=True)

    # Which configured alert rule produced this, when one did. NULL for the
    # alerts this system raised before rules existed (the stopped-instance
    # storage check) and for anything a feature raises directly — both are
    # legitimate, so this is a link, not a requirement.
    #
    # Deliberately NOT a foreign key: rules are soft-deleted precisely so their
    # alert history survives them, and a real FK would mean either cascading
    # that history away or blocking the delete. The rule id is enough to join
    # when the rule is still there and harmless when it is not.
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True)

    # ── Per-alert silence ────────────────────────────────────────────────────
    # Distinct from silencing the RULE. "This one instance is known and being
    # worked on, stop mailing me about it" is a different decision from "stop
    # mailing me about this whole class of thing", and collapsing them means
    # muting a rule to quieten one noisy resource — which then hides the next
    # genuine one.
    #
    # Like rule silence, this suppresses notification only. The alert stays
    # OPEN and stays in the feed, because it is still a real problem.
    silenced_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    silenced_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    silence_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # When this alert was escalated, so it is escalated once rather than on
    # every pass after the threshold.
    escalated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    # Who acted, not just when. An audit trail that records the time but not the
    # actor answers half the question.
    acknowledged_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    resolution_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Severity escalation (§35). An alert that goes MEDIUM → CRITICAL must show
    # that it changed; silently overwriting the column would hide it.
    previous_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    severity_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    # Notification cooldown state (§34). Without `last_notified_at` there is no
    # way to implement "at most once an hour", and a condition seen on every
    # scan would notify on every scan.
    last_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    notification_count: Mapped[int] = mapped_column(default=0)
    notification_status: Mapped[str | None] = mapped_column(String(40), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True
    )
    # Bumped each time the condition is seen again, so "first seen" and "still
    # happening" are distinguishable — a one-off blip reads differently from a
    # fault that has persisted for a week.
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    occurrence_count: Mapped[int] = mapped_column(default=1)
    acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # The alert feed is always "newest open first", per account.
        Index("ix_cloud_alerts_state_created", "state", "created_at"),
        Index("ix_cloud_alerts_account_state", "account_id", "state"),
    )

    def is_silenced(self, now: datetime | None = None) -> bool:
        """Whether THIS alert's own notification is suppressed right now.

        Independent of the rule's silence — both are checked at send time, and
        either one suppresses.
        """
        if self.silenced_until is None:
            return False
        now = now or datetime.now(timezone.utc)
        until = self.silenced_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until > now

    def to_dict(self) -> dict:
        """Response shape. Keeps the keys the existing AlertsPage already reads
        (id / anomaly_type / details / severity / created_at / is_read /
        simulated / account_id) so the UI needs no change, and adds the
        lifecycle fields alongside them."""
        return {
            "id": str(self.id),
            "account_id": str(self.account_id) if self.account_id else None,
            "anomaly_type": self.anomaly_type,
            "severity": self.severity,
            "details": self.details,
            "is_read": self.is_read,
            "simulated": self.simulated,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            # New lifecycle detail
            "state": self.state,
            "last_seen_at": self.last_seen_at.isoformat() if self.last_seen_at else None,
            "occurrence_count": self.occurrence_count,
            "acknowledged_at": self.acknowledged_at.isoformat() if self.acknowledged_at else None,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
            "resource_id": str(self.resource_id) if self.resource_id else None,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "context": self.context,
            # Link to the canonical finding, and the policy that decided this
            # was worth an alert.
            "finding_fingerprint": self.finding_fingerprint,
            "policy_id": str(self.policy_id) if self.policy_id else None,
            "policy_name": self.policy_name,
            "rule_id": str(self.rule_id) if self.rule_id else None,
            "dedupe_key": self.dedupe_key,
            "silenced_until": (self.silenced_until.isoformat()
                               if self.silenced_until else None),
            "silenced_by": self.silenced_by,
            "silence_reason": self.silence_reason,
            "is_silenced": self.is_silenced(),
            "escalated_at": (self.escalated_at.isoformat()
                             if self.escalated_at else None),
            "acknowledged_by": self.acknowledged_by,
            "resolved_by": self.resolved_by,
            "resolution_reason": self.resolution_reason,
            "previous_severity": self.previous_severity,
            "severity_changed_at": (self.severity_changed_at.isoformat()
                                    if self.severity_changed_at else None),
            "last_notified_at": (self.last_notified_at.isoformat()
                                 if self.last_notified_at else None),
            "notification_count": self.notification_count,
            "notification_status": self.notification_status,
        }
