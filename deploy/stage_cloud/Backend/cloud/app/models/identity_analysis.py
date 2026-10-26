"""Derived identity analysis: effective permissions, usage, trust, blast radius.

Everything here is COMPUTED from `identity.py`'s inventory plus the Event Log,
and everything here is disposable — delete the lot and a re-analysis rebuilds
it. That is the point of the split: the inventory is expensive to collect (it
costs provider API calls and rate limit) and the analysis is expensive to
compute, and conflating them would mean a re-evaluation had to re-scan.

**Why effective permissions are stored as GRANTS, not as a cross-product.**
The naive schema is one row per (identity, action, resource), which for 10,000
identities against ~18,000 AWS actions is combinatorially absurd before any
resource dimension is added. So a row here is one evaluated *statement*:
"this principal is allowed `s3:*` on `arn:aws:s3:::prod-*`, from policy X,
subject to condition Y". That is bounded by the size of the policy estate,
which is what the provider actually has.

The cross-product is then computed on demand for the one question being asked
(the permission explorer), and the cheap aggregate — which of the 18 normalized
capabilities does this identity hold — is materialized separately in
`CloudIdentityCapability`, bounded at 18 rows per principal, so the dashboard,
the filters and the reverse query never pay for pattern matching.

**Why usage is per (identity, action) and carries its window.** §5 and §35
together: an unused-permission claim is meaningless without the observation
period, so the window bounds are columns on every row rather than a global
setting someone can change behind the data. A row that says "0 events" is only
interpretable beside "between these two dates, out of this many events".
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401
from app.models.identity import CloudIdentity      # noqa: F401


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


class CloudEffectivePermission(Base):
    """One evaluated grant: principal, action pattern, resource pattern, verdict.

    `decision` is the result AFTER the provider's full chain was walked —
    explicit denies, boundaries, deny assignments and (where collected) SCPs.
    `unevaluated` records which links of that chain were missing, and a row
    with a non-empty `unevaluated` must never be rendered as a certain ALLOW.
    """

    __tablename__ = "cloud_effective_permissions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # The provider's own action string or pattern — `s3:*`, `*/read`,
    # `manage:object-family`. Never replaced by the normalized capability.
    action_pattern: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    capability: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    resource_pattern: Mapped[str | None] = mapped_column(Text, nullable=True)

    decision: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    # Whether the grant carries conditions this engine does not evaluate.
    conditional: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    conditions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Provenance — §3's "Source: Role policy XYZ" and §22's policy explorer.
    source_stage: Mapped[str] = mapped_column(String(40), nullable=False)
    source_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    statement_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # Set when the grant arrived through a group, a role, or scope inheritance.
    inherited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    inherited_from: Mapped[str | None] = mapped_column(Text, nullable=True)

    # The full explain trace and the missing links, as rendered by the UI.
    steps: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    unevaluated: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now,
                                                  index=True)
    analysis_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True),
                                                              nullable=True, index=True)

    __table_args__ = (
        Index("ix_effperm_identity_decision", "identity_id", "decision"),
        Index("ix_effperm_account_capability", "account_id", "capability"),
        Index("ix_effperm_account_action", "account_id", "action_pattern"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "identity_id": str(self.identity_id),
            "provider": self.provider,
            "action_pattern": self.action_pattern,
            "capability": self.capability,
            "resource_pattern": self.resource_pattern,
            "decision": self.decision,
            "conditional": self.conditional,
            "conditions": self.conditions,
            "source_stage": self.source_stage,
            "source_name": self.source_name,
            "source_key": self.source_key,
            "statement_id": self.statement_id,
            "inherited": self.inherited,
            "inherited_from": self.inherited_from,
            "steps": self.steps,
            "unevaluated": self.unevaluated,
            "certain": not bool(self.unevaluated),
            "computed_at": _iso(self.computed_at),
        }


class CloudIdentityCapability(Base):
    """Which of the 18 normalized capabilities a principal holds, and on what.

    At most 18 rows per principal, which is what makes the dashboard counts,
    the "privileged" filter and the cross-cloud question ("who can delete
    storage anywhere?") indexed lookups rather than pattern scans.

    `evidence_actions` names the actual granted patterns that conferred it, so
    the claim is always traceable back to a provider statement.
    """

    __tablename__ = "cloud_identity_capabilities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    capability: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    high_impact: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False,
                                              index=True)
    # The broadest scope at which it is held — decides severity, as in
    # security/identity.py's SCOPE_RANK.
    scope_level: Mapped[str | None] = mapped_column(String(32), nullable=True)
    scope: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_actions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    source_names: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Carried through from the decision: a capability derived while a chain
    # link was unreadable is still reported, flagged as not fully verified.
    certain: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("identity_id", "capability", name="uq_identity_capability"),
        Index("ix_identity_capability_account", "account_id", "capability", "high_impact"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "identity_id": str(self.identity_id),
            "provider": self.provider,
            "capability": self.capability,
            "high_impact": self.high_impact,
            "scope_level": self.scope_level,
            "scope": self.scope,
            "evidence_actions": self.evidence_actions,
            "source_names": self.source_names,
            "certain": self.certain,
            "computed_at": _iso(self.computed_at),
        }


class CloudPermissionUsage(Base):
    """Observed use of one action by one principal, within a stated window.

    The window columns are not metadata — they are half the claim. "43 events"
    means nothing without "between these dates, from this many total events,
    from this source". A reader who cannot see the window cannot tell a
    well-evidenced NOT_OBSERVED from a log that started yesterday.
    """

    __tablename__ = "cloud_permission_usage"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # The concrete action, as the audit log spelled it.
    action: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    capability: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)

    # OBSERVED / NOT_OBSERVED_HIGH_CONFIDENCE / NOT_OBSERVED_LOW_CONFIDENCE / UNKNOWN
    usage_state: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    event_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    success_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    first_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                               nullable=True)
    last_observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                              nullable=True, index=True)
    distinct_resources: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    regions: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    # The window. Mandatory on every row.
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False)
    # How many events the window held in total, for this account. Context for
    # a zero: 0 out of 2.4M is evidence; 0 out of 11 is not.
    events_in_window: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    # Why confidence is what it is: "data-plane action, not recorded by default".
    confidence_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("identity_id", "action", name="uq_permission_usage_identity_action"),
        Index("ix_permission_usage_account_state", "account_id", "usage_state"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "identity_id": str(self.identity_id),
            "provider": self.provider,
            "action": self.action,
            "capability": self.capability,
            "usage_state": self.usage_state,
            "event_count": self.event_count,
            "success_count": self.success_count,
            "first_observed_at": _iso(self.first_observed_at),
            "last_observed_at": _iso(self.last_observed_at),
            "distinct_resources": self.distinct_resources,
            "regions": self.regions,
            "window": {
                "start": _iso(self.window_start),
                "end": _iso(self.window_end),
                "days": self.window_days,
                "events_in_window": self.events_in_window,
            },
            "confidence_reason": self.confidence_reason,
            "computed_at": _iso(self.computed_at),
        }


class CloudIdentityTrust(Base):
    """A trust relationship that lets one principal become, or reach, another.

    Covers AWS assume-role trust policies, Azure cross-tenant / guest / foreign
    principals, and OCI federation and cross-tenancy policy. One table because
    the question is the same in all three — "who outside this boundary can get
    in, and to what?" — and §13 asks for one graph.
    """

    __tablename__ = "cloud_identity_trust"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True,
                                          default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # The target inside our boundary: the role that can be assumed, the
    # subscription a guest was invited into.
    target_identity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    target_key: Mapped[str] = mapped_column(Text, nullable=False)
    target_name: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # The source outside it. `source_account` is the foreign account id, tenant
    # id or tenancy OCID where one could be parsed.
    source_principal: Mapped[str] = mapped_column(Text, nullable=False)
    source_account: Mapped[str | None] = mapped_column(String(256), nullable=True, index=True)
    source_type: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # INTERNAL / EXTERNAL / UNKNOWN / ANONYMOUS
    external: Mapped[str] = mapped_column(String(20), nullable=False, default="UNKNOWN",
                                          index=True)
    # ASSUME_ROLE / FEDERATION / GUEST / CROSS_TENANCY / SERVICE_PRINCIPAL
    trust_kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)

    # The condition block on the trust. An ExternalId or a tenant restriction
    # is the difference between a scoped integration and an open door, so it is
    # stored and rendered rather than summarised to "conditional: yes".
    conditions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    has_external_id: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_mfa_condition: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    # What the trust leads to once taken, carried so the graph edge can be
    # weighted without re-evaluating the target's permissions.
    target_privilege: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Last time an event showed this trust actually being used. Null means not
    # observed, which is not the same as not used.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                          nullable=True)

    evidence: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (
        UniqueConstraint("account_id", "target_key", "source_principal", "trust_kind",
                         name="uq_identity_trust_edge"),
        Index("ix_identity_trust_account_external", "account_id", "external"),
    )

    def to_dict(self) -> dict:
        return {
            "id": str(self.id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "target_identity_id": str(self.target_identity_id) if self.target_identity_id else None,
            "target_key": self.target_key,
            "target_name": self.target_name,
            "source_principal": self.source_principal,
            "source_account": self.source_account,
            "source_type": self.source_type,
            "external": self.external,
            "trust_kind": self.trust_kind,
            "conditions": self.conditions,
            "has_external_id": self.has_external_id,
            "has_mfa_condition": self.has_mfa_condition,
            "target_privilege": self.target_privilege,
            "last_used_at": _iso(self.last_used_at),
            "evidence": self.evidence,
            "first_seen_at": _iso(self.first_seen_at),
            "last_seen_at": _iso(self.last_seen_at),
        }


class CloudIdentityBlastRadius(Base):
    """What a principal could reach if it were compromised.

    One row per principal, recomputed by the analyser. Every number here is
    derived from evaluated permissions matched against the actual inventory —
    §17 is explicit that impact must not be invented, so a count of 0 with
    `resources_evaluated = 0` is reported as "could not determine", not as
    "reaches nothing".
    """

    __tablename__ = "cloud_identity_blast_radius"

    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        primary_key=True,
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    # Resources the principal's permissions match directly.
    direct_resources: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Reached through the topology graph from a directly reachable resource.
    indirect_resources: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    accounts_reachable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    regions_reachable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sensitive_resources: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    privileged_roles_assumable: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    can_modify_iam: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_modify_network: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_delete_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_create_credentials: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_modify_logging: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    can_manage_keys: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # 0-100, and withheld (null) rather than guessed when coverage is too thin.
    score: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    score_band: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)

    # How much of the estate the calculation could actually see. Without this,
    # a small blast radius caused by a failed inventory sweep is indistinguish-
    # able from a genuinely well-scoped identity.
    resources_evaluated: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    inventory_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    coverage_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Per-service and per-type breakdown, and a sample of reachable resources
    # for the drill-down. A sample, not the full list: §34 forbids shipping the
    # estate to the browser.
    by_service: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    by_resource_type: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    sample_resources: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    paths: Mapped[list | None] = mapped_column(JSONB, nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    def to_dict(self) -> dict:
        return {
            "identity_id": str(self.identity_id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "direct_resources": self.direct_resources,
            "indirect_resources": self.indirect_resources,
            "accounts_reachable": self.accounts_reachable,
            "regions_reachable": self.regions_reachable,
            "sensitive_resources": self.sensitive_resources,
            "privileged_roles_assumable": self.privileged_roles_assumable,
            "capabilities": {
                "modify_iam": self.can_modify_iam,
                "modify_network": self.can_modify_network,
                "delete_data": self.can_delete_data,
                "create_credentials": self.can_create_credentials,
                "modify_logging": self.can_modify_logging,
                "manage_keys": self.can_manage_keys,
            },
            "score": self.score,
            "score_band": self.score_band,
            "resources_evaluated": self.resources_evaluated,
            "inventory_complete": self.inventory_complete,
            "coverage_note": self.coverage_note,
            "by_service": self.by_service,
            "by_resource_type": self.by_resource_type,
            "sample_resources": self.sample_resources,
            "paths": self.paths,
            "computed_at": _iso(self.computed_at),
        }


class CloudIdentityBaseline(Base):
    """What this principal normally does, so a change can be described.

    §28 asks for explainable behavioural detection and is explicit that unusual
    is not malicious. This table holds only the observed baseline — services,
    regions, action classes, volume — and the detector states the difference in
    those terms. It never carries a judgement.
    """

    __tablename__ = "cloud_identity_baselines"

    identity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_identities.id", ondelete="CASCADE"),
        primary_key=True,
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)

    baseline_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    baseline_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    baseline_days: Mapped[int] = mapped_column(Integer, nullable=False)
    event_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    services: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    regions: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    capabilities: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    source_ips: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Median and p95 daily call volume, for the "sudden high-volume" signal.
    median_daily_events: Mapped[float | None] = mapped_column(Float, nullable=True)
    p95_daily_events: Mapped[float | None] = mapped_column(Float, nullable=True)

    # A baseline built from too few events cannot support a deviation claim.
    sufficient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    insufficient_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    def to_dict(self) -> dict:
        return {
            "identity_id": str(self.identity_id),
            "account_id": str(self.account_id),
            "provider": self.provider,
            "window": {
                "start": _iso(self.baseline_start),
                "end": _iso(self.baseline_end),
                "days": self.baseline_days,
                "event_count": self.event_count,
            },
            "services": self.services,
            "regions": self.regions,
            "capabilities": self.capabilities,
            "source_ips": self.source_ips,
            "median_daily_events": self.median_daily_events,
            "p95_daily_events": self.p95_daily_events,
            "sufficient": self.sufficient,
            "insufficient_reason": self.insufficient_reason,
            "computed_at": _iso(self.computed_at),
        }


# ── Analysis health ──────────────────────────────────────────────────────────
# The same argument as CloudIdentityCollectionState, one level up: an empty
# CIEM dashboard must be able to say whether the estate is clean or whether the
# analysis never ran.
ANALYSIS_NEVER_RUN = "NeverRun"
ANALYSIS_OK = "Complete"
ANALYSIS_PARTIAL = "Partial"
ANALYSIS_FAILED = "Failed"

ANALYSIS_STATES = (ANALYSIS_NEVER_RUN, ANALYSIS_OK, ANALYSIS_PARTIAL, ANALYSIS_FAILED)
ANALYSIS_TRUSTWORTHY = frozenset({ANALYSIS_OK})


class CloudIdentityAnalysisState(Base):
    """Whether the CIEM analysis for an account is trustworthy, and if not, why."""

    __tablename__ = "cloud_identity_analysis_state"

    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False,
                                        default=ANALYSIS_NEVER_RUN)

    identity_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evaluated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Principals we hold but could not evaluate — their permissions are
    # NOT_DETERMINED and the dashboard says so rather than counting them clean.
    unevaluated_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Which stages of which provider chains were unavailable this run, and the
    # permission that would fix each. The actionable half of a coverage gap.
    missing_stages: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    usage_window_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    usage_events_analyzed: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    usage_source_available: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True),
                                                             nullable=True)
    last_run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)

    @property
    def trustworthy(self) -> bool:
        return self.status in ANALYSIS_TRUSTWORTHY

    def to_dict(self) -> dict:
        return {
            "account_id": str(self.account_id),
            "provider": self.provider,
            "status": self.status,
            "trustworthy": self.trustworthy,
            "identity_count": self.identity_count,
            "evaluated_count": self.evaluated_count,
            "unevaluated_count": self.unevaluated_count,
            "missing_stages": self.missing_stages,
            "usage_window_days": self.usage_window_days,
            "usage_events_analyzed": self.usage_events_analyzed,
            "usage_source_available": self.usage_source_available,
            "error_detail": self.error_detail,
            "last_attempt_at": _iso(self.last_attempt_at),
            "last_success_at": _iso(self.last_success_at),
            "last_run_id": str(self.last_run_id) if self.last_run_id else None,
            "duration_s": self.duration_s,
        }
