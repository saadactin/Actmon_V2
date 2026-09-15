"""Recommendation lifecycle: what a human decided about an optimization.

The recommendations themselves are DERIVED on every analytics run from live
inventory — they are not stored, because a stored recommendation goes stale the
moment the resource changes, and presenting a stale finding as current is the
thing section 102 forbids.

What *is* stored is the part a re-derivation cannot reproduce: the human
decision. Someone dismissing "this OCI load balancer is idle" with the reason
"it fronts a failover path we keep warm" has added knowledge the rule engine
does not have, and losing that on the next discovery scan would mean the same
finding nagging forever.

So the join between the two is `fingerprint`: a stable hash of
(account, rule, resource) that survives re-derivation. A recommendation whose
underlying condition disappears simply stops being derived, and its decision
row remains as history rather than resurfacing.
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.cloud_account import CloudAccount  # noqa: F401

# ── Workflow states ───────────────────────────────────────────────────────────
# NEW is implicit: a recommendation with no decision row is NEW. Storing NEW
# explicitly would mean writing a row for every finding on every scan, which is
# a lot of writes to record "nobody has looked at this yet".
STATE_REVIEWED = "REVIEWED"
STATE_ACCEPTED = "ACCEPTED"
STATE_IN_PROGRESS = "IN_PROGRESS"
STATE_IMPLEMENTED = "IMPLEMENTED"
STATE_DISMISSED = "DISMISSED"
STATE_NEW = "NEW"

WORKFLOW_STATES = (
    STATE_NEW, STATE_REVIEWED, STATE_ACCEPTED, STATE_IN_PROGRESS,
    STATE_IMPLEMENTED, STATE_DISMISSED,
)
# States a user may set. NEW is the absence of a decision, not a decision.
SETTABLE_STATES = (
    STATE_REVIEWED, STATE_ACCEPTED, STATE_IN_PROGRESS,
    STATE_IMPLEMENTED, STATE_DISMISSED,
)

# States that mean "stop showing me this in the active list".
CLOSED_STATES = frozenset({STATE_IMPLEMENTED, STATE_DISMISSED})


def recommendation_fingerprint(
    *, account_id, rule: str, resource_id: Optional[str] = None,
) -> str:
    """Stable identity for one recommendation across re-derivations.

    Deliberately excludes everything that legitimately changes between runs —
    the savings figure, the description text, the severity. Including any of
    them would make a repriced recommendation look like a brand new one, and a
    user's dismissal would silently stop applying.
    """
    parts = [str(account_id), (rule or "").strip().lower(),
             (str(resource_id) if resource_id else "-").strip().lower()]
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


class CloudCostRecommendationDecision(Base):
    """One human decision about one recommendation."""

    __tablename__ = "cloud_cost_recommendation_decisions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    account_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cloud_accounts.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    state: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Who and when — an audit trail that records the state but not the actor
    # answers half the question.
    decided_by: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    previous_state: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    # A snapshot of what was being decided about, so the audit trail still
    # makes sense after the underlying resource is gone: "dismissed a
    # $1,240/month saving" is only meaningful if the figure is recorded.
    snapshot: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )

    # ── Savings realization (132) ────────────────────────────────────────────
    # Observed spend before and after implementation, filled in from
    # cloud_cost_facts rather than assumed. A recommendation marked IMPLEMENTED
    # is a claim; these two columns are the evidence, and their absence is why
    # realized savings report NA rather than the recommended figure.
    observed_before: Mapped[Optional[float]] = mapped_column(nullable=True)
    observed_after: Mapped[Optional[float]] = mapped_column(nullable=True)
    observed_currency: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)

    __table_args__ = (
        # One current decision per recommendation. History lives in the
        # previous_state column plus the alert/audit trail, not in duplicate rows.
        UniqueConstraint("fingerprint", name="uq_recommendation_decision"),
        Index("ix_reco_decision_account_state", "account_id", "state"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "fingerprint": self.fingerprint,
            "account_id": str(self.account_id) if self.account_id else None,
            "state": self.state,
            "previous_state": self.previous_state,
            "reason": self.reason,
            "decided_by": self.decided_by,
            "decided_at": self.decided_at.isoformat() if self.decided_at else None,
            "observed_before": self.observed_before,
            "observed_after": self.observed_after,
            "observed_currency": self.observed_currency,
        }
