"""Budgets and cost alert policies.

These two tables say what spend SHOULD be and what is worth waking someone
for. They deliberately hold no money of their own: every figure a budget is
evaluated against is read from `cloud_cost_facts` at evaluation time, so a
budget can never drift out of step with actual billing.

**A budget is single-currency, always.** A budget of "5000" across an estate
billing in USD and INR is not a number, so `currency` is required and
evaluation only ever compares it against spend in that same currency. Facts in
other currencies are reported as out-of-scope rather than converted, because
there is no FX source in this product and a silent conversion would be an
invented figure.

**Alerts are raised through the existing alerting service**, not a second one.
`cloud_alerts` already has a unique `dedupe_key`, severity escalation columns
and notification cooldown state, and `notification_bridge` already routes by
severity to configured channels. Building a parallel path would produce two
systems with different ideas of whether you had already been told.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401

_NULLABLE_JSONB = JSONB(none_as_null=True)

# ── Budget periods ────────────────────────────────────────────────────────────
PERIOD_MONTHLY = "MONTHLY"
PERIOD_QUARTERLY = "QUARTERLY"
PERIOD_ANNUAL = "ANNUAL"
BUDGET_PERIODS = (PERIOD_MONTHLY, PERIOD_QUARTERLY, PERIOD_ANNUAL)

# ── Alert policy kinds ────────────────────────────────────────────────────────
# Each is enabled only where the data to evaluate it genuinely exists; see
# cost_budget_service for which are live and which report not_supported.
POLICY_BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
POLICY_FORECAST_EXCEEDS_BUDGET = "FORECAST_EXCEEDS_BUDGET"
POLICY_COST_SPIKE = "COST_SPIKE"
POLICY_DAILY_SPEND = "DAILY_SPEND_THRESHOLD"
POLICY_MONTHLY_SPEND = "MONTHLY_SPEND_THRESHOLD"
POLICY_SERVICE_COST = "SERVICE_COST_THRESHOLD"
POLICY_RESOURCE_COST = "RESOURCE_COST_THRESHOLD"
POLICY_UNALLOCATED_COST = "UNALLOCATED_COST_THRESHOLD"
POLICY_KINDS = (
    POLICY_BUDGET_EXCEEDED, POLICY_FORECAST_EXCEEDS_BUDGET, POLICY_COST_SPIKE,
    POLICY_DAILY_SPEND, POLICY_MONTHLY_SPEND, POLICY_SERVICE_COST,
    POLICY_RESOURCE_COST, POLICY_UNALLOCATED_COST,
)

# Default thresholds, as percentages of the budget.
DEFAULT_THRESHOLDS = [50, 75, 90, 100]

# ── Notification kind ────────────────────────────────────────────────────────
# A notification is either about ACTUAL spend crossing a threshold, or about
# the FORECAST (run-rate projection) crossing one before actual spend does.
# They are deliberately separate identities (see CloudCostBudgetNotification's
# docstring): a forecast notice at 100% must not suppress the real breach
# notice at 100% a week later, once spend actually gets there.
NOTIFICATION_ACTUAL = "ACTUAL"
NOTIFICATION_FORECAST = "FORECAST"
NOTIFICATION_KINDS = (NOTIFICATION_ACTUAL, NOTIFICATION_FORECAST)

# How long before the same threshold on the same budget may notify again.
# Crossing a HIGHER threshold ignores this — see cost_budget_service: going
# from 75% to 100% is new information and must not be silenced by a cooldown
# started at 75%.
DEFAULT_COOLDOWN_HOURS = 6


def severity_for_threshold(percent: float) -> str:
    """Map a budget-utilisation percentage to an alert severity.

    The ladder is deliberately coarse. What matters is that 51% and 150% do not
    arrive looking identical, not that every percentage point has its own tier.
    """
    if percent >= 100:
        return "CRITICAL"
    if percent >= 90:
        return "HIGH"
    if percent >= 75:
        return "MEDIUM"
    return "INFO"


class CloudCostBudget(Base):
    """A spend target for one scope, in one currency, over one period."""

    __tablename__ = "cloud_cost_budgets"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # ── Scope ────────────────────────────────────────────────────────────────
    # NULL account_id means the budget spans every account (an organisation
    # budget). SET NULL rather than CASCADE so deleting one account does not
    # silently delete a budget that covered it.
    account_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Further narrowing, all optional. NULL means "not filtered by this".
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    service: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    region: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    cost_component: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # ── The target ───────────────────────────────────────────────────────────
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    # NOT nullable. A budget without a currency cannot be compared to anything.
    currency: Mapped[str] = mapped_column(String(8), nullable=False)
    period: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PERIOD_MONTHLY
    )

    # Percentages of `amount` at which to alert, e.g. [50, 75, 90, 100].
    thresholds: Mapped[List[int]] = mapped_column(
        _NULLABLE_JSONB, nullable=False, default=lambda: list(DEFAULT_THRESHOLDS)
    )
    cooldown_hours: Mapped[int] = mapped_column(
        Integer, nullable=False, default=DEFAULT_COOLDOWN_HOURS
    )
    # Alert when the run-rate projection for the period exceeds the budget,
    # before actual spend does. Off by default: a projection is not a fact, and
    # paging on one should be a deliberate choice.
    alert_on_forecast: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )

    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("ix_cost_budget_account_enabled", "account_id", "enabled"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "name": self.name,
            "account_id": str(self.account_id) if self.account_id else None,
            "scope": {
                "account_id": str(self.account_id) if self.account_id else None,
                "provider": self.provider,
                "service": self.service,
                "region": self.region,
                "cost_component": self.cost_component,
            },
            "amount": self.amount,
            "currency": self.currency,
            "period": self.period,
            "thresholds": list(self.thresholds or []),
            "cooldown_hours": self.cooldown_hours,
            "alert_on_forecast": self.alert_on_forecast,
            "enabled": self.enabled,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_by": self.updated_by,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class CloudCostAlertPolicy(Base):
    """A cost condition worth alerting on, independent of any budget."""

    __tablename__ = "cloud_cost_alert_policies"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    kind: Mapped[str] = mapped_column(String(48), nullable=False, index=True)

    account_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    service: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # The trigger. `threshold_amount` needs a currency for the same reason a
    # budget does; `threshold_percent` is unitless and does not.
    threshold_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    threshold_currency: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    threshold_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # Paired with threshold_percent for spike policies: both bars must be
    # cleared, so a 300% rise on a trivial amount stays quiet.
    min_absolute: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="MEDIUM")
    cooldown_hours: Mapped[int] = mapped_column(
        Integer, nullable=False, default=DEFAULT_COOLDOWN_HOURS
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "name": self.name,
            "kind": self.kind,
            "account_id": str(self.account_id) if self.account_id else None,
            "provider": self.provider,
            "service": self.service,
            "threshold_amount": self.threshold_amount,
            "threshold_currency": self.threshold_currency,
            "threshold_percent": self.threshold_percent,
            "min_absolute": self.min_absolute,
            "severity": self.severity,
            "cooldown_hours": self.cooldown_hours,
            "enabled": self.enabled,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_by": self.updated_by,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class CloudCostBudgetNotification(Base):
    """Which budget threshold has already been announced, and when.

    This is the dedupe ledger. `cloud_alerts.dedupe_key` stops duplicate ALERT
    ROWS, but a budget needs a second, finer record: the highest threshold
    already reported for a given period. Without it, re-evaluating on every
    cycle either re-notifies at 75% forever, or -- if suppressed by a blanket
    cooldown -- stays silent when spend crosses 100%, which is the one moment
    that actually matters.

    `kind` (ACTUAL / FORECAST) is part of the dedupe identity, not an
    afterthought column. A forecast crossing 100% and an actual spend crossing
    100% are different facts about the same budget and period, and must be
    announced independently -- otherwise whichever fires first would silence
    the other for the rest of the period.
    """

    __tablename__ = "cloud_cost_budget_notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    budget_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_cost_budgets.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # e.g. "2026-09" for a monthly budget. Scoping by period is what lets a new
    # month start clean rather than inheriting last month's breach.
    period_key: Mapped[str] = mapped_column(String(16), nullable=False)
    threshold: Mapped[int] = mapped_column(Integer, nullable=False)
    # ACTUAL or FORECAST (NOTIFICATION_KINDS). Defaulted for the rows this
    # table already held before the column existed -- see db_setup patch.
    kind: Mapped[str] = mapped_column(
        String(16), nullable=False, default=NOTIFICATION_ACTUAL
    )
    notified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    # The utilisation that triggered it, for the audit trail.
    observed_percent: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    observed_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    __table_args__ = (
        # One record per (budget, period, threshold, kind): the database
        # itself refuses a duplicate even if two evaluations race.
        UniqueConstraint(
            "budget_id", "period_key", "threshold", "kind",
            name="uq_budget_period_threshold_kind",
        ),
    )
