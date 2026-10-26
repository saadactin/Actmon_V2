"""Persistence for optimization findings and analysis runs.

`persist` reconciles one analysis against the stored findings, and each of its
transitions has the trap the security repository documented:

**New** — insert, with a `detected` entry in the finding's history.

**Still present** — refresh evidence, savings and presentation; move
`last_detected_at`; bump `detection_count`. `first_detected_at` is never
touched. A severity change records `previous_severity`. A finding a person
SUPPRESSED stays suppressed; one they ACKNOWLEDGED stays acknowledged. One that
was RESOLVED and is detected again is REOPENED — leaving it resolved would hide
a regression.

**Absent** — resolved ONLY when there is evidence the problem is gone:
  * its own rule re-checked the same resource this run and concluded CLEAR (or
    NOT_APPLICABLE — the instance is running again, the volume re-attached), or
  * a COMPLETE discovery sweep no longer contains the resource.
Anything else — the resource's telemetry failed, the sweep was partial, the
rule could not decide — leaves the finding open, with `last_check` saying why.
Resolving on absence alone is the error the partial-scan prune once made with
62 live OCI resources, and it is not made again here.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.optimization import CloudOptimizationFinding, CloudOptimizationRun
from app.optimization.model import (
    ACKNOWLEDGED, ACTIVE_STATUSES, CLEAR, NOT_APPLICABLE, OPEN, RESOLVED, SUPPRESSED,
)

_HISTORY_CAP = 50
_SNAPSHOT_EVIDENCE = 16


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


_SEVERITY_RANK = {"INFO": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}


def _push(row: CloudOptimizationFinding, event: str, at: datetime, detail: Optional[str] = None,
          by: Optional[str] = None) -> None:
    hist = list(row.history or [])
    hist.append({"at": _iso(at), "event": event, "detail": detail, "by": by})
    row.history = hist[-_HISTORY_CAP:]


def _snapshot(row: CloudOptimizationFinding) -> Dict[str, Any]:
    """What the finding said just before it closed — kept on the resolution so
    "what happened after" can compare against it once the live row has moved on."""
    return {
        "severity": row.severity,
        "evidence": (row.evidence or [])[:_SNAPSHOT_EVIDENCE],
        "current_configuration": row.current_configuration,
        "recommended_configuration": row.recommended_configuration,
        "savings": {"amount": row.estimated_savings, "currency": row.savings_currency,
                    "method": row.savings_method, "basis": row.savings_basis},
        "first_detected_at": _iso(row.first_detected_at),
        "last_detected_at": _iso(row.last_detected_at),
    }


class OptimizationRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Reconcile an analysis ──────────────────────────────────────────────

    async def persist(self, *, account_id: uuid.UUID, analysis, run_id: uuid.UUID,
                      sweep_complete: bool, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or datetime.now(timezone.utc)
        existing = {r.fingerprint: r for r in (await self.db.execute(
            select(CloudOptimizationFinding).where(
                CloudOptimizationFinding.account_id == account_id))).scalars().all()}
        stats = {"new": 0, "updated": 0, "reopened": 0, "resolved": 0, "escalated": 0,
                 "deescalated": 0, "kept_unverified": 0}
        seen = set()
        for f in analysis.findings:
            seen.add(f.fingerprint)
            row = existing.get(f.fingerprint)
            if row is None:
                row = CloudOptimizationFinding(
                    account_id=account_id, provider=f.provider, fingerprint=f.fingerprint,
                    rule_id=f.rule_id, status=OPEN, first_detected_at=now, detection_count=1,
                    history=[])
                self._apply(row, f, now, run_id)
                _push(row, "detected", now, f.description, "analysis")
                self.db.add(row)
                stats["new"] += 1
                continue
            if row.severity != f.severity:
                row.previous_severity = row.severity
                row.severity_changed_at = now
                _push(row, "severity_changed", now, f"{row.severity} → {f.severity}", "analysis")
                # Counted by direction: a downgrade is not an escalation.
                up = _SEVERITY_RANK.get(f.severity, 0) > _SEVERITY_RANK.get(row.severity, 0)
                stats["escalated" if up else "deescalated"] += 1
            self._apply(row, f, now, run_id)
            row.detection_count = (row.detection_count or 1) + 1
            if row.status == RESOLVED:
                row.status = OPEN
                row.resolved_at = None
                row.status_reason = None
                # Stamped, so a Cost-tab "implemented" decision older than
                # this reopening gives way to it (resolve_state: latest wins).
                row.status_changed_at = now
                row.status_changed_by = "analysis"
                _push(row, "reopened", now, "Detected again by analysis.", "analysis")
                stats["reopened"] += 1
            stats["updated"] += 1

        for fp, row in existing.items():
            if fp in seen or row.status == RESOLVED:
                continue
            key = (row.rule_id, (row.resource_key or "").lower())
            verdict, reason = analysis.evaluations.get(key, (None, None))
            row.last_check = {"at": _iso(now), "verdict": verdict or "NOT_EVALUATED",
                              "reason": reason}
            kind = None
            if verdict in (CLEAR, NOT_APPLICABLE):
                kind = "condition_cleared"
            elif ((row.resource_key or "").lower() not in analysis.resource_keys
                  and sweep_complete):
                kind = "resource_removed"
                reason = ("The resource is no longer in the inventory, and the discovery sweep "
                          "that produced it read every scope.")
            if kind is None:
                stats["kept_unverified"] += 1
                continue
            prior = row.status
            row.resolution = {"kind": kind, "at": _iso(now), "by": "analysis",
                              "detail": reason, "previous_status": prior,
                              "before": _snapshot(row)}
            row.status = RESOLVED
            row.resolved_at = now
            row.status_reason = reason
            row.status_changed_at = now
            row.status_changed_by = "analysis"
            _push(row, "resolved", now, reason, "analysis")
            stats["resolved"] += 1

        await self.db.flush()
        return stats

    def _apply(self, row: CloudOptimizationFinding, f, now: datetime, run_id: uuid.UUID) -> None:
        s = f.savings.to_dict()
        row.rule_version = f.rule_version
        row.provider = f.provider
        row.resource_key = f.resource_key
        row.resource_id = uuid.UUID(f.resource_id) if f.resource_id else None
        row.resource_name = f.resource_name
        row.resource_type = f.resource_type
        row.region = f.region
        row.category = f.category
        row.severity = f.severity
        row.signal = f.signal
        row.effort = f.effort
        row.title = f.title
        row.description = f.description
        row.rationale = f.rationale
        row.recommendation = f.recommendation
        row.remediation = f.remediation
        row.confidence = f.confidence
        row.confidence_reasons = f.confidence_reasons
        row.evidence = f.evidence
        row.current_configuration = f.current_configuration
        row.recommended_configuration = f.recommended_configuration
        row.data_sources = f.data_sources
        row.metrics_used = f.metrics_used
        row.estimated_savings = s["amount"]
        row.savings_currency = s["currency"]
        row.savings_method = s["method"]
        row.savings_basis = s["basis"]
        row.savings_reason = s["reason"]
        row.savings_breakdown = s["breakdown"]
        row.assumptions = s["assumptions"]
        row.risk = f.risk
        row.risk_notes = f.risk_notes
        row.impact = f.impact
        row.safety = f.safety
        row.last_detected_at = now
        row.last_verified_at = now
        row.last_check = {"at": _iso(now), "verdict": "FINDING", "reason": None}
        row.analysis_run_id = run_id

    # ── Runs ───────────────────────────────────────────────────────────────

    async def record_run(self, *, run_id: uuid.UUID, account_id: uuid.UUID, analysis,
                         persist_stats: Dict[str, Any], triggered_by: Optional[str],
                         discovery_scan_id: Optional[uuid.UUID], telemetry: Dict[str, Any],
                         inputs: Dict[str, Any], savings_by_currency: Dict[str, float],
                         findings_open: int) -> CloudOptimizationRun:
        row = CloudOptimizationRun(
            id=run_id, account_id=account_id, provider=analysis.provider,
            outcome=analysis.outcome, triggered_by=triggered_by,
            discovery_scan_id=discovery_scan_id,
            resources_total=analysis.resources_total,
            resources_analyzed=analysis.resources_analyzed,
            rules_evaluated=analysis.rules_evaluated,
            findings_open=findings_open,
            findings_new=persist_stats.get("new", 0),
            findings_resolved=persist_stats.get("resolved", 0),
            coverage=analysis.coverage, telemetry=telemetry, inputs=inputs,
            savings_by_currency=savings_by_currency,
            incomplete_reasons=analysis.incomplete_reasons,
            evaluations=analysis.per_resource,
            started_at=analysis.started_at, finished_at=datetime.now(timezone.utc),
            duration_ms=int((datetime.now(timezone.utc) - analysis.started_at).total_seconds() * 1000),
        )
        self.db.add(row)
        await self.db.flush()
        return row

    async def latest_run(self, account_id: uuid.UUID) -> Optional[CloudOptimizationRun]:
        return (await self.db.execute(
            select(CloudOptimizationRun).where(CloudOptimizationRun.account_id == account_id)
            .order_by(CloudOptimizationRun.finished_at.desc()).limit(1))).scalars().first()

    async def runs(self, account_id: uuid.UUID, limit: int = 20) -> List[CloudOptimizationRun]:
        return list((await self.db.execute(
            select(CloudOptimizationRun).where(CloudOptimizationRun.account_id == account_id)
            .order_by(CloudOptimizationRun.finished_at.desc()).limit(limit))).scalars().all())

    async def prune_runs(self, account_id: uuid.UUID, keep: int = 60) -> int:
        ids = [r.id for r in await self.runs(account_id, limit=10_000)][keep:]
        if not ids:
            return 0
        await self.db.execute(delete(CloudOptimizationRun).where(CloudOptimizationRun.id.in_(ids)))
        return len(ids)

    # ── Findings ───────────────────────────────────────────────────────────

    async def get(self, account_id: uuid.UUID, key: str) -> Optional[CloudOptimizationFinding]:
        row = (await self.db.execute(select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id == account_id,
            CloudOptimizationFinding.fingerprint == key))).scalar_one_or_none()
        if row is not None:
            return row
        try:
            as_uuid = uuid.UUID(str(key))
        except ValueError:
            return None
        return (await self.db.execute(select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id == account_id,
            CloudOptimizationFinding.id == as_uuid))).scalar_one_or_none()

    async def by_fingerprint(self, key: str) -> Optional[CloudOptimizationFinding]:
        """A finding by fingerprint alone. The fingerprint hashes the account
        in, so it is unique across accounts."""
        return (await self.db.execute(select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.fingerprint == key).limit(1))).scalar_one_or_none()

    async def for_accounts(self, account_ids: Sequence[uuid.UUID], *,
                           statuses: Optional[Sequence[str]] = None) -> List[CloudOptimizationFinding]:
        stmt = select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id.in_(list(account_ids)))
        if statuses:
            stmt = stmt.where(CloudOptimizationFinding.status.in_(list(statuses)))
        return list((await self.db.execute(stmt)).scalars().all())

    async def for_resource(self, account_id: uuid.UUID, resource_id: uuid.UUID,
                           *, active_only: bool = True) -> List[CloudOptimizationFinding]:
        stmt = select(CloudOptimizationFinding).where(
            CloudOptimizationFinding.account_id == account_id,
            CloudOptimizationFinding.resource_id == resource_id)
        if active_only:
            stmt = stmt.where(CloudOptimizationFinding.status.in_(list(ACTIVE_STATUSES)))
        return list((await self.db.execute(stmt)).scalars().all())

    async def set_status(self, *, account_id: uuid.UUID, key: str, status: str,
                         reason: Optional[str], actor: Optional[str]) -> Optional[CloudOptimizationFinding]:
        row = await self.get(account_id, key)
        if row is None:
            return None
        now = datetime.now(timezone.utc)
        previous = row.status
        row.status = status
        row.status_reason = reason
        row.status_changed_by = actor
        row.status_changed_at = now
        if status == RESOLVED:
            row.resolved_at = now
            row.resolution = {"kind": "marked_by_user", "at": _iso(now), "by": actor,
                              "detail": reason, "previous_status": previous,
                              "before": _snapshot(row),
                              "note": ("Marked resolved by a person. The next analysis re-checks "
                                       "it, and reopens it if the condition is still present.")}
        elif previous == RESOLVED:
            row.resolved_at = None
        event = {ACKNOWLEDGED: "acknowledged", SUPPRESSED: "suppressed", RESOLVED: "marked_resolved",
                 OPEN: "reopened"}.get(status, f"status_{status.lower()}")
        _push(row, event, now, reason, actor)
        await self.db.flush()
        return row
