"""Persisted security findings, alert policies, and assessment runs.

Three tables, and the reason for each:

**`cloud_security_findings`** — findings used to be recomputed on every HTTP
request and never stored, which cost two things. Performance: a page load ran
~48 rules across 550 resources, and Compliance ran them a second time. And,
more importantly, history: without a row there is no `first_detected_at`, so
nothing could answer "how long has this been open", "is this new since
Tuesday", or "did we fix it and did it come back" — and an alert had nothing
durable to point at.

The `fingerprint` column is the identity. It is derived from provider +
account + rule + the *provider's* resource id, never from the resource name
(not unique) and never from our own UUID (a re-created resource gets a new one,
which would read as one finding resolving and a different one appearing for
what is the same unfixed problem).

**`cloud_alert_policies`** — alerting was a single hard-coded rule
(`STOPPED_INSTANCE_ATTACHED_STORAGE`) evaluated inside the discovery worker.
Every CRITICAL security finding in the estate — 82 on AWS, 68 on OCI — produced
no alert at all, because no code path connected findings to alerts. A policy
row is what makes "tell me when a database becomes internet-reachable" a
configuration change rather than a code change.

**`cloud_security_assessments`** — one row per evaluation, holding the score
and coverage. This is what Trends reads, and what lets the UI say "last
assessed 14:32" separately from "inventory collected 14:30". It also records
the assessment `outcome`, which decides whether findings absent from a run may
be resolved: they may not, unless the run was COMPLETE.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target registration)


class CloudSecurityFinding(Base):
    __tablename__ = "cloud_security_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)

    # Deterministic identity. Unique per account so a re-assessment updates the
    # existing row; the database refuses a duplicate even if two assessments
    # race, which they can when a manual re-assess overlaps a scan's automatic
    # one.
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    rule_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # Stored per finding, not looked up from the registry at read time: when a
    # rule's meaning changes, a historical finding must still say which version
    # produced it. Otherwise "why did this become INFO?" is unanswerable.
    rule_version: Mapped[str] = mapped_column(String(20), nullable=False)

    # The provider's own id — the durable pointer. resource_id is our UUID and
    # is nullable because aggregated and account-level findings have no single
    # resource.
    resource_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    resource_type: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    region: Mapped[str | None] = mapped_column(String(100), nullable=True)

    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    remediation: Mapped[str | None] = mapped_column(Text, nullable=True)

    severity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    verdict: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    confidence: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN",
                                        index=True)

    evidence: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    compliance: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Aggregated findings (the ownership-tag rule, collection-gap groups).
    affected_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    affected_sample: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # ── Freshness. All four are distinct and the UI must not conflate them ──
    first_detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    last_detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    # Set ONLY when a provider API was called to re-confirm this specific
    # finding. Left null by the ordinary assessment path, which reads stored
    # inventory — so "verified against the provider" cannot be claimed for
    # something that was only recomputed from a 70-day-old scan.
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                              nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                         nullable=True)
    resource_last_discovered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    discovery_scan_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                                nullable=True)

    # How many consecutive assessments have seen it. Feeds the "same finding
    # for N scans" and "open for more than 24h" alert thresholds.
    detection_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # Set when severity changes, so an escalation is visible rather than
    # silently overwritten.
    previous_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    severity_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                  nullable=True)

    # ── Remediation workflow ────────────────────────────────────────────────
    assigned_to: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_changed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                               nullable=True)

    __table_args__ = (
        UniqueConstraint("account_id", "fingerprint", name="uq_finding_account_fingerprint"),
        # The findings list is always "worst first, for one account, filtered by
        # status" — this index serves that directly.
        Index("ix_findings_account_status_severity", "account_id", "status", "severity"),
        Index("ix_findings_account_category", "account_id", "category"),
        Index("ix_findings_account_rule", "account_id", "rule_id"),
        Index("ix_findings_last_detected", "last_detected_at"),
    )

    def to_dict(self, *, include_sample: bool = False) -> dict:
        from app.security.model import (
            CONFIDENCE_LABEL, STATUS_LABEL, VERDICT_LABEL, NON_SECURITY_CATEGORIES,
            scores_toward_total,
        )

        def iso(dt):
            return dt.isoformat() if dt else None

        out = {
            "id": str(self.id),
            "fingerprint": self.fingerprint,
            "account_id": str(self.account_id),
            "provider": self.provider,
            "rule_id": self.rule_id,
            "rule_version": self.rule_version,
            "resource_key": self.resource_key,
            "resource_id": str(self.resource_id) if self.resource_id else None,
            "resource_name": self.resource_name,
            "resource_type": self.resource_type,
            "region": self.region,
            "title": self.title,
            "description": self.description,
            "rationale": self.rationale,
            "remediation": self.remediation,
            "severity": self.severity,
            "category": self.category,
            "verdict": self.verdict,
            "verdict_label": VERDICT_LABEL.get(self.verdict, self.verdict),
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABEL.get(self.confidence, self.confidence),
            "status": self.status,
            "status_label": STATUS_LABEL.get(self.status, self.status),
            "evidence": self.evidence,
            "compliance": self.compliance,
            "affected_count": self.affected_count,
            "first_detected_at": iso(self.first_detected_at),
            "last_detected_at": iso(self.last_detected_at),
            "last_verified_at": iso(self.last_verified_at),
            "resolved_at": iso(self.resolved_at),
            "resource_last_discovered_at": iso(self.resource_last_discovered_at),
            "discovery_scan_id": (str(self.discovery_scan_id)
                                  if self.discovery_scan_id else None),
            "detection_count": self.detection_count,
            "previous_severity": self.previous_severity,
            "severity_changed_at": iso(self.severity_changed_at),
            "assigned_to": self.assigned_to,
            "status_reason": self.status_reason,
            "status_changed_by": self.status_changed_by,
            "status_changed_at": iso(self.status_changed_at),
            "scores": (scores_toward_total(self.confidence)
                       and self.category not in NON_SECURITY_CATEGORIES
                       and self.verdict == "VULNERABLE"),
        }
        # The sample can be 200 entries; only the detail view asks for it.
        if include_sample:
            out["affected_sample"] = self.affected_sample
        return out


# ═════════════════════════════════════════════════════════════════════════════


# Threshold kinds (§27). The evaluator in app/security/policies.py switches on
# these, and the self-check there refuses a policy with an unknown kind.
THRESHOLD_FINDING_COUNT = "finding_count"        # N matching findings exist
THRESHOLD_ANY_NEW = "any_new"                    # a matching finding is newly opened
THRESHOLD_SEVERITY = "severity_at_least"         # any finding at/above a severity
THRESHOLD_RESOURCE_COUNT = "resource_count"      # N distinct resources affected
THRESHOLD_PERCENTAGE = "percentage_of_type"      # >X% of a resource type affected
THRESHOLD_CONSECUTIVE = "consecutive_detections"  # seen in N consecutive assessments
THRESHOLD_DURATION = "open_duration_hours"       # open longer than N hours
THRESHOLD_SCORE_BELOW = "score_below"            # account score under N

THRESHOLD_KINDS = (
    THRESHOLD_FINDING_COUNT, THRESHOLD_ANY_NEW, THRESHOLD_SEVERITY,
    THRESHOLD_RESOURCE_COUNT, THRESHOLD_PERCENTAGE, THRESHOLD_CONSECUTIVE,
    THRESHOLD_DURATION, THRESHOLD_SCORE_BELOW,
)

THRESHOLD_LABEL = {
    THRESHOLD_FINDING_COUNT: "Number of matching findings",
    THRESHOLD_ANY_NEW: "A new matching finding appears",
    THRESHOLD_SEVERITY: "Any matching finding at or above a severity",
    THRESHOLD_RESOURCE_COUNT: "Number of distinct resources affected",
    THRESHOLD_PERCENTAGE: "Percentage of a resource type affected",
    THRESHOLD_CONSECUTIVE: "Same finding seen in N consecutive assessments",
    THRESHOLD_DURATION: "Finding open longer than N hours",
    THRESHOLD_SCORE_BELOW: "Account security score below N",
}


class CloudAlertPolicy(Base):
    """When a finding should become an alert, and who hears about it."""

    __tablename__ = "cloud_alert_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    # Null means "all accounts" — the shape the built-in defaults use, so a new
    # account is covered the moment it is added rather than when someone
    # remembers to create policies for it.
    account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    # Stable identifier for the built-in defaults, so a redeploy updates them
    # rather than creating a second copy of each.
    policy_key: Mapped[str | None] = mapped_column(String(120), nullable=True, unique=True)

    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── What it matches ─────────────────────────────────────────────────────
    # All null/empty means "any finding". Each populated selector narrows it.
    providers: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    rule_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    categories: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    resource_types: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    min_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Ports, for the exposure policies. Matched against evidence.port.port.
    ports: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Only match findings whose verdict is confirmed, by default. A policy that
    # pages someone about an UNKNOWN finding is paging them about a scanner
    # problem, which is usually a different escalation path.
    match_verdicts: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # ── When it fires ───────────────────────────────────────────────────────
    threshold_kind: Mapped[str] = mapped_column(String(40), nullable=False,
                                                default=THRESHOLD_ANY_NEW)
    threshold_value: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    alert_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Minutes between notifications for the same alert. Prevents 100 emails for
    # one condition seen in 100 scans.
    cooldown_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    notify: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    last_triggered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                nullable=True)
    trigger_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc))
    updated_by: Mapped[str | None] = mapped_column(String(256), nullable=True)

    __table_args__ = (
        Index("ix_alert_policies_enabled_account", "enabled", "account_id"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id) if self.account_id else None,
            "policy_key": self.policy_key,
            "name": self.name,
            "description": self.description,
            "enabled": self.enabled,
            "builtin": self.builtin,
            "providers": self.providers,
            "rule_ids": self.rule_ids,
            "categories": self.categories,
            "resource_types": self.resource_types,
            "min_severity": self.min_severity,
            "ports": self.ports,
            "match_verdicts": self.match_verdicts,
            "threshold_kind": self.threshold_kind,
            "threshold_label": THRESHOLD_LABEL.get(self.threshold_kind,
                                                   self.threshold_kind),
            "threshold_value": self.threshold_value,
            "alert_severity": self.alert_severity,
            "cooldown_minutes": self.cooldown_minutes,
            "notify": self.notify,
            "last_triggered_at": (self.last_triggered_at.isoformat()
                                  if self.last_triggered_at else None),
            "trigger_count": self.trigger_count,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "updated_by": self.updated_by,
        }


class CloudSecurityAssessment(Base):
    """One evaluation run: its score, its coverage, and whether it was complete.

    Kept as history so Trends can show whether the estate is improving, and so
    "last assessed" is a fact rather than an assumption. `outcome` is the field
    that governs resolution: findings absent from a PARTIAL run are left open,
    because their absence may simply mean the sweep failed to enumerate them.
    """

    __tablename__ = "cloud_security_assessments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)

    # Nullable: an account with no inventory, or coverage too low for a number
    # to mean anything, has no score. Storing 100 for those would poison the
    # trend line with the accounts we can see least.
    score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    grade: Mapped[str | None] = mapped_column(String(24), nullable=True)
    score_reliable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    coverage_pct: Mapped[float | None] = mapped_column(Float, nullable=True)

    resources_evaluated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rules_evaluated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    findings_open: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_confirmed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_undetermined: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_resolved_by_run: Mapped[int] = mapped_column(Integer, nullable=False,
                                                          default=0)
    findings_new_by_run: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    by_severity: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    coverage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    score_breakdown: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    incomplete_reasons: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Distinguishes "evaluated from stored inventory" (the normal path) from a
    # run that re-read the provider. Only the latter may be described as
    # verified against the provider.
    triggered_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    inventory_last_discovered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_assessments_account_finished", "account_id", "finished_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "outcome": self.outcome,
            "score": self.score,
            "grade": self.grade,
            "score_reliable": self.score_reliable,
            "coverage_pct": self.coverage_pct,
            "resources_evaluated": self.resources_evaluated,
            "rules_evaluated": self.rules_evaluated,
            "findings_open": self.findings_open,
            "findings_confirmed": self.findings_confirmed,
            "findings_undetermined": self.findings_undetermined,
            "findings_resolved_by_run": self.findings_resolved_by_run,
            "findings_new_by_run": self.findings_new_by_run,
            "by_severity": self.by_severity,
            "coverage": self.coverage,
            "score_breakdown": self.score_breakdown,
            "incomplete_reasons": self.incomplete_reasons,
            "triggered_by": self.triggered_by,
            "inventory_last_discovered_at": (
                self.inventory_last_discovered_at.isoformat()
                if self.inventory_last_discovered_at else None),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "duration_ms": self.duration_ms,
        }
