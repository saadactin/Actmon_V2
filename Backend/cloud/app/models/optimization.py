"""Persisted optimization findings, analysis runs and resource telemetry.

Three tables, and the reason for each:

**`cloud_optimization_findings`** — the Cost tab's recommendations are derived
per request and never stored, which is right for a list but leaves three of the
questions an engineer asks with no answer: how long has this been open, did
anyone look at it, and what happened after it was fixed. A row gives a finding
a first-detected time, a status someone set, and a `resolution` recording the
evidence before and after. Identity is the `fingerprint` (provider + account +
rule + the provider's own resource id), so the same condition on the next
analysis updates the same row.

**`cloud_optimization_runs`** — one row per analysis, carrying what was
analysed, what could not be and why, and the outcome. The outcome governs
resolution exactly as the security assessment's does: a finding may only be
closed by a run that actually re-checked its resource and found the condition
gone. An absent resource in an incomplete sweep means "not seen", not "fixed".

**`cloud_resource_telemetry`** — the metrics store this product never had
(roadmap 1.2). One row per (resource, metric), replaced on each collection:
window statistics, a daily rollup for the evidence charts, and the hourly
series itself. It stores only what a provider's monitoring API returned, with
the collection status beside it, so "no datapoints" and "not permitted" stay
distinguishable from each other and from zero.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401  (FK target)
from app.models.resource import CloudResource  # noqa: F401  (FK target)


def _iso(dt):
    return dt.isoformat() if dt else None


class CloudOptimizationFinding(Base):
    __tablename__ = "cloud_optimization_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    rule_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    rule_version: Mapped[str] = mapped_column(String(20), nullable=False)

    # The provider's id is the durable pointer; resource_id is our UUID, which
    # a re-created resource does not keep. No FK on resource_id on purpose: a
    # resolved finding must outlive the resource it was about, or "what
    # happened after it was deleted" has nothing left to answer from.
    resource_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True,
                                                          index=True)
    resource_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    resource_type: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    region: Mapped[str | None] = mapped_column(String(100), nullable=True)

    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # UNUSED / UNDERUTILIZED / CONSTRAINED / CONFIGURATION / RISK.
    signal: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)
    effort: Mapped[str | None] = mapped_column(String(10), nullable=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    recommendation: Mapped[str | None] = mapped_column(Text, nullable=True)
    remediation: Mapped[str | None] = mapped_column(Text, nullable=True)

    confidence: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence_reasons: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    evidence: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    current_configuration: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    recommended_configuration: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    data_sources: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    metrics_used: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # Savings, split into its parts so the list can sort and sum on the amount
    # while the method, basis and arithmetic travel with it. A NULL amount is
    # "not quantified" — `savings_reason` says why — and is never summed as 0.
    estimated_savings: Mapped[float | None] = mapped_column(Float, nullable=True)
    savings_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    savings_method: Mapped[str] = mapped_column(String(20), nullable=False, default="NONE")
    savings_basis: Mapped[str | None] = mapped_column(Text, nullable=True)
    savings_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    savings_breakdown: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    assumptions: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    risk: Mapped[str] = mapped_column(String(20), nullable=False, default="MEDIUM")
    risk_notes: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    impact: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    safety: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN",
                                        index=True)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    status_changed_by: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                               nullable=True)

    first_detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    last_detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    # The last analysis that re-evaluated this finding against freshly
    # collected telemetry/billing. Distinct from last_detected_at only in name
    # today; kept separate so a future cached-read path cannot claim it.
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                              nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                         nullable=True)
    # What happened: condition cleared on re-check, resource removed, or a
    # person marked it resolved — with the evidence before and after.
    resolution: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # The latest analysis's verdict on this finding's (rule, resource):
    # {at, verdict, reason}. An open finding whose re-check came back
    # INSUFFICIENT_DATA says so, instead of looking freshly re-verified.
    last_check: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    detection_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    previous_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    severity_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                                  nullable=True)
    # A short append-only trail (detected, acknowledged, suppressed, reopened,
    # resolved), capped by the repository. The finding's own history, so the
    # drawer's timeline needs no second table.
    history: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    analysis_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                              nullable=True)

    __table_args__ = (
        UniqueConstraint("account_id", "fingerprint",
                         name="uq_optimization_account_fingerprint"),
        Index("ix_opt_findings_account_status_severity", "account_id", "status", "severity"),
        Index("ix_opt_findings_account_category", "account_id", "category"),
    )

    def to_dict(self) -> dict:
        from app.optimization.model import (
            CATEGORY_LABEL, CONFIDENCE_LABEL, STATUS_LABEL,
        )

        return {
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
            "category": self.category,
            "category_label": CATEGORY_LABEL.get(self.category, self.category),
            "severity": self.severity,
            "signal": self.signal,
            "effort": self.effort,
            "title": self.title,
            "description": self.description,
            "rationale": self.rationale,
            "recommendation": self.recommendation,
            "remediation": self.remediation,
            "confidence": self.confidence,
            "confidence_label": CONFIDENCE_LABEL.get(self.confidence, self.confidence),
            "confidence_reasons": self.confidence_reasons or [],
            "evidence": self.evidence or [],
            "current_configuration": self.current_configuration or {},
            "recommended_configuration": self.recommended_configuration,
            "data_sources": self.data_sources or [],
            "metrics_used": self.metrics_used or [],
            "savings": {
                "amount": self.estimated_savings,
                "currency": self.savings_currency,
                "method": self.savings_method,
                "basis": self.savings_basis,
                "reason": self.savings_reason,
                "breakdown": self.savings_breakdown or [],
                "assumptions": self.assumptions or [],
                "priced": self.estimated_savings is not None,
            },
            "risk": self.risk,
            "risk_notes": self.risk_notes or [],
            "impact": self.impact or {},
            "safety": self.safety or {},
            "status": self.status,
            "status_label": STATUS_LABEL.get(self.status, self.status),
            "status_reason": self.status_reason,
            "status_changed_by": self.status_changed_by,
            "status_changed_at": _iso(self.status_changed_at),
            "first_detected_at": _iso(self.first_detected_at),
            "last_detected_at": _iso(self.last_detected_at),
            "last_verified_at": _iso(self.last_verified_at),
            "resolved_at": _iso(self.resolved_at),
            "resolution": self.resolution,
            "last_check": self.last_check,
            "detection_count": self.detection_count,
            "previous_severity": self.previous_severity,
            "severity_changed_at": _iso(self.severity_changed_at),
            "history": self.history or [],
            "analysis_run_id": str(self.analysis_run_id) if self.analysis_run_id else None,
        }


class CloudOptimizationRun(Base):
    """One analysis of one account: what was analysed, what could not be, and
    whether the run is complete enough to resolve findings."""

    __tablename__ = "cloud_optimization_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    triggered_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    discovery_scan_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                                nullable=True)

    resources_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    resources_analyzed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rules_evaluated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_open: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_new: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    findings_resolved: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Per rule: evaluated / findings / clear / insufficient, and the reasons the
    # insufficient ones gave. This is the "what we could not analyse" panel.
    coverage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Per metric: how many resources returned OK / NO_DATA / DENIED / ERROR.
    telemetry: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Billing and price-list inputs: were they available, and when fetched.
    inputs: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    savings_by_currency: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    incomplete_reasons: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # {resource_id: {rule_id: verdict}} — which rules reached a decision about
    # which resource. The health score reads it: a dimension is scored only
    # for a resource some rule actually decided about.
    evaluations: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    finished_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    __table_args__ = (
        Index("ix_opt_runs_account_finished", "account_id", "finished_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "outcome": self.outcome,
            "triggered_by": self.triggered_by,
            "discovery_scan_id": str(self.discovery_scan_id) if self.discovery_scan_id else None,
            "resources_total": self.resources_total,
            "resources_analyzed": self.resources_analyzed,
            "rules_evaluated": self.rules_evaluated,
            "findings_open": self.findings_open,
            "findings_new": self.findings_new,
            "findings_resolved": self.findings_resolved,
            "coverage": self.coverage or {},
            "telemetry": self.telemetry or {},
            "inputs": self.inputs or {},
            "savings_by_currency": self.savings_by_currency or {},
            "incomplete_reasons": self.incomplete_reasons or [],
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "duration_ms": self.duration_ms,
        }


class CloudResourceTelemetry(Base):
    """The latest collected window of one metric for one resource."""

    __tablename__ = "cloud_resource_telemetry"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # CASCADE: telemetry describes a resource that exists. When discovery prunes
    # the resource, its metrics go with it — a finding that needs them keeps
    # its own copy of the statistics it was decided on.
    resource_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_resources.id", ondelete="CASCADE"),
        nullable=False,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    metric: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # e.g. "AWS CloudWatch · AWS/EC2 CPUUtilization (Average + Maximum, 1 h)"
    source: Mapped[str | None] = mapped_column(Text, nullable=True)

    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    window_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    granularity_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=3600)

    samples: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # [[epoch_seconds, value], ...] — the hourly series the stats came from,
    # and the per-hour Maximum when the provider was asked for it.
    series: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    peak_series: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    collected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

    __table_args__ = (
        UniqueConstraint("resource_id", "metric", name="uq_resource_telemetry_metric"),
        Index("ix_resource_telemetry_account", "account_id", "collected_at"),
    )

    def to_dict(self, *, include_series: bool = False) -> dict:
        from app.optimization.telemetry import METRICS, STATUS_LABEL

        meta = METRICS.get(self.metric)
        out = {
            "resource_id": str(self.resource_id),
            "metric": self.metric,
            "label": meta.label if meta else self.metric,
            "unit": meta.unit if meta else None,
            "kind": meta.kind if meta else None,
            "status": self.status,
            "status_label": STATUS_LABEL.get(self.status, self.status),
            "reason": self.reason,
            "source": self.source,
            "window_days": self.window_days,
            "window_start": _iso(self.window_start),
            "window_end": _iso(self.window_end),
            "granularity_seconds": self.granularity_seconds,
            "samples": self.samples,
            "stats": self.stats,
            "collected_at": _iso(self.collected_at),
        }
        if include_series:
            out["series"] = self.series or []
            out["peak_series"] = self.peak_series or []
        return out
