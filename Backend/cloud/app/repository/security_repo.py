"""Persistence for findings, assessments and alert policies.

The interesting method is `persist_findings`, which reconciles a fresh
assessment against what is already stored. Three transitions matter and each
has a trap:

**New** — insert, and report it in `newly_opened` so an `any_new` alert policy
can fire exactly once rather than on every assessment for the life of the
finding.

**Still present** — update `last_detected_at`, bump `detection_count`, and
refresh the description and evidence (a rule's detail changes: "8 inbound
rules" becomes "13"). `first_detected_at` is never touched — it is the answer
to "how long has this been open", which is the whole reason for storing
findings at all. A severity change records `previous_severity` and
`severity_changed_at` rather than silently overwriting, so an escalation is
visible.

**Absent** — resolve, **but only if the assessment was COMPLETE.** This is the
guard that matters most. If the sweep failed to enumerate every scope, a
finding's absence means "we could not see it", not "it was fixed", and closing
it would tell the user a problem is solved when it is not. It is the same rule
that already protects the inventory prune and the storage alerts, and it exists
because a partially-failed OCI scan once deleted 62 live resources.

A finding a user has SUPPRESSED or accepted as risk is never resurrected to
OPEN by a re-detection. Their decision stands until they change it; only
`last_detected_at` and the counters move.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.security_finding import (
    CloudAlertPolicy, CloudSecurityAssessment, CloudSecurityFinding,
)
from app.security import policies as pol
from app.security.model import (
    ACTIVE_FINDING_STATUSES, ASSESS_COMPLETE, MUTED_FINDING_STATUSES, OPEN, RESOLVED,
    SEVERITIES, severity_rank,
)

logger = logging.getLogger("cloud_svc.security.repo")


class SecurityRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Findings ────────────────────────────────────────────────────────────

    async def persist_findings(
        self,
        *,
        account_id: uuid.UUID,
        findings: Sequence[Any],
        outcome: str,
        discovery_scan_id: Optional[uuid.UUID] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Reconcile an assessment's findings against the stored set.

        Returns `{new, updated, resolved, reopened, newly_opened, escalated}`.
        `newly_opened` is the set of fingerprints that went from absent-or-
        resolved to open — the only ones an `any_new` policy should fire on.
        """
        now = now or datetime.now(timezone.utc)
        existing_rows = list((await self.db.execute(
            select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id)
        )).scalars().all())
        existing = {r.fingerprint: r for r in existing_rows}

        seen: Set[str] = set()
        newly_opened: Set[str] = set()
        stats = {"new": 0, "updated": 0, "resolved": 0, "reopened": 0, "escalated": 0}

        for f in findings:
            fp = f.fingerprint
            seen.add(fp)
            row = existing.get(fp)
            if row is None:
                self.db.add(self._to_row(f, account_id, discovery_scan_id, now))
                newly_opened.add(fp)
                stats["new"] += 1
                continue

            # Presentation and evidence are refreshed; identity and history are not.
            row.rule_version = f.rule_version
            row.title = f.title
            row.description = f.description
            row.rationale = f.rationale
            row.remediation = f.remediation
            row.category = f.category
            row.verdict = f.verdict
            row.confidence = f.confidence
            row.evidence = f.evidence
            row.compliance = f.compliance
            row.affected_count = f.affected_count
            row.affected_sample = f.affected_sample
            row.resource_name = f.resource_name or row.resource_name
            row.resource_type = f.resource_type or row.resource_type
            row.region = f.region or row.region
            row.resource_last_discovered_at = (
                f.resource_last_discovered_at or row.resource_last_discovered_at)
            row.last_detected_at = now
            row.detection_count = (row.detection_count or 1) + 1
            if discovery_scan_id:
                row.discovery_scan_id = discovery_scan_id

            if row.severity != f.severity:
                row.previous_severity = row.severity
                row.severity_changed_at = now
                row.severity = f.severity
                stats["escalated"] += 1

            if row.status == RESOLVED:
                # It came back. Reopening is the only honest response, and
                # leaving it resolved would hide a regression.
                row.status = OPEN
                row.resolved_at = None
                row.status_reason = None
                newly_opened.add(fp)
                stats["reopened"] += 1
            elif row.status in MUTED_FINDING_STATUSES:
                # Suppressed / risk-accepted: a human decision. Re-detecting it
                # does not override them; only the counters move.
                pass
            stats["updated"] += 1

        # ── Resolution, gated on a complete assessment ──────────────────────
        if outcome == ASSESS_COMPLETE:
            for fp, row in existing.items():
                if fp in seen or row.status not in ACTIVE_FINDING_STATUSES:
                    continue
                row.status = RESOLVED
                row.resolved_at = now
                row.status_reason = (
                    "The condition was no longer present in a complete assessment."
                )
                stats["resolved"] += 1
        else:
            unseen = sum(
                1 for fp, r in existing.items()
                if fp not in seen and r.status in ACTIVE_FINDING_STATUSES
            )
            if unseen:
                logger.info(
                    "Not resolving %d finding(s) for account %s: the assessment was %s, "
                    "so an absent finding may only mean the sweep could not enumerate "
                    "its resource.", unseen, account_id, outcome,
                )

        await self.db.flush()
        return {**stats, "newly_opened": newly_opened, "unchanged_total": len(seen)}

    def _to_row(self, f, account_id: uuid.UUID,
                discovery_scan_id: Optional[uuid.UUID],
                now: datetime) -> CloudSecurityFinding:
        return CloudSecurityFinding(
            account_id=account_id,
            provider=f.provider,
            fingerprint=f.fingerprint,
            rule_id=f.rule_id,
            rule_version=f.rule_version,
            resource_key=f.resource_key,
            resource_id=_as_uuid(f.resource_id),
            resource_name=f.resource_name,
            resource_type=f.resource_type,
            region=f.region,
            title=f.title,
            description=f.description,
            rationale=f.rationale,
            remediation=f.remediation,
            severity=f.severity,
            category=f.category,
            verdict=f.verdict,
            confidence=f.confidence,
            status=OPEN,
            evidence=f.evidence,
            compliance=f.compliance,
            affected_count=f.affected_count,
            affected_sample=f.affected_sample,
            first_detected_at=f.first_detected_at or now,
            last_detected_at=now,
            resource_last_discovered_at=f.resource_last_discovered_at,
            discovery_scan_id=discovery_scan_id,
            detection_count=1,
        )

    async def list_findings(
        self,
        *,
        account_ids: Optional[Sequence[uuid.UUID]] = None,
        statuses: Optional[Sequence[str]] = None,
        severities: Optional[Sequence[str]] = None,
        categories: Optional[Sequence[str]] = None,
        verdicts: Optional[Sequence[str]] = None,
        confidences: Optional[Sequence[str]] = None,
        providers: Optional[Sequence[str]] = None,
        resource_types: Optional[Sequence[str]] = None,
        rule_ids: Optional[Sequence[str]] = None,
        search: Optional[str] = None,
        detected_after: Optional[datetime] = None,
        detected_before: Optional[datetime] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> Tuple[List[CloudSecurityFinding], int]:
        """A page of findings plus the total matching count.

        Filtering and paging happen in SQL, not in the browser: an account can
        hold hundreds of findings and the spec's target is a page that stays
        usable at 100,000 resources.
        """
        stmt = select(CloudSecurityFinding)
        count_stmt = select(func.count()).select_from(CloudSecurityFinding)

        conds = []
        if account_ids:
            conds.append(CloudSecurityFinding.account_id.in_(list(account_ids)))
        if statuses:
            conds.append(CloudSecurityFinding.status.in_(list(statuses)))
        if severities:
            conds.append(CloudSecurityFinding.severity.in_(list(severities)))
        if categories:
            conds.append(CloudSecurityFinding.category.in_(list(categories)))
        if verdicts:
            conds.append(CloudSecurityFinding.verdict.in_(list(verdicts)))
        if confidences:
            conds.append(CloudSecurityFinding.confidence.in_(list(confidences)))
        if providers:
            conds.append(CloudSecurityFinding.provider.in_(list(providers)))
        if resource_types:
            conds.append(CloudSecurityFinding.resource_type.in_(list(resource_types)))
        if rule_ids:
            conds.append(CloudSecurityFinding.rule_id.in_(list(rule_ids)))
        if detected_after:
            conds.append(CloudSecurityFinding.last_detected_at >= detected_after)
        if detected_before:
            conds.append(CloudSecurityFinding.last_detected_at <= detected_before)
        if search:
            like = f"%{search.strip()}%"
            conds.append(
                CloudSecurityFinding.resource_name.ilike(like)
                | CloudSecurityFinding.resource_key.ilike(like)
                | CloudSecurityFinding.title.ilike(like)
                | CloudSecurityFinding.rule_id.ilike(like)
                | CloudSecurityFinding.fingerprint.ilike(like)
                | CloudSecurityFinding.description.ilike(like)
            )
        for c in conds:
            stmt = stmt.where(c)
            count_stmt = count_stmt.where(c)

        total = int((await self.db.execute(count_stmt)).scalar() or 0)

        # Ordering is a CASE over the severity list rather than alphabetical:
        # alphabetically CRITICAL sorts after both HIGH and INFO.
        #
        # `fingerprint` is the final tiebreaker, and it is not optional. Every
        # finding from one assessment shares a `last_detected_at` to the
        # microsecond, so severity + timestamp leaves large groups of rows in an
        # arbitrary order that Postgres is free to vary between queries. Under
        # LIMIT/OFFSET that means page 2 can repeat a row from page 1 and skip
        # another entirely — which is exactly what a paging test caught here.
        severity_order = {s: i for i, s in enumerate(SEVERITIES)}
        stmt = stmt.order_by(
            _severity_case(severity_order),
            CloudSecurityFinding.last_detected_at.desc(),
            CloudSecurityFinding.fingerprint,
        ).limit(max(1, min(limit, 500))).offset(max(0, offset))

        rows = list((await self.db.execute(stmt)).scalars().all())
        return rows, total

    async def get_finding(self, account_id: uuid.UUID,
                          key: str) -> Optional[CloudSecurityFinding]:
        """By fingerprint, or by primary-key UUID. The UI links by fingerprint
        because it survives a re-created resource; the id form exists for
        callers holding a row id."""
        stmt = select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id,
            CloudSecurityFinding.fingerprint == key,
        )
        row = (await self.db.execute(stmt)).scalar_one_or_none()
        if row is not None:
            return row
        as_uuid = _as_uuid(key)
        if as_uuid is None:
            return None
        return (await self.db.execute(select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id,
            CloudSecurityFinding.id == as_uuid,
        ))).scalar_one_or_none()

    async def findings_for_account(
        self, account_id: uuid.UUID, *, statuses: Optional[Sequence[str]] = None,
    ) -> List[CloudSecurityFinding]:
        stmt = select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id)
        if statuses:
            stmt = stmt.where(CloudSecurityFinding.status.in_(list(statuses)))
        return list((await self.db.execute(stmt)).scalars().all())

    async def set_status(
        self, *, account_id: uuid.UUID, key: str, status: str,
        reason: Optional[str], actor: Optional[str],
        assigned_to: Optional[str] = None,
    ) -> Optional[CloudSecurityFinding]:
        row = await self.get_finding(account_id, key)
        if row is None:
            return None
        now = datetime.now(timezone.utc)
        row.status = status
        row.status_reason = reason
        row.status_changed_by = actor
        row.status_changed_at = now
        if assigned_to is not None:
            row.assigned_to = assigned_to
        if status == RESOLVED:
            row.resolved_at = now
        else:
            row.resolved_at = None
        await self.db.flush()
        return row

    async def facets(self, account_ids: Sequence[uuid.UUID]) -> Dict[str, Any]:
        """Distinct values for the filter dropdowns, computed in SQL.

        The filters offer what is actually present rather than every possible
        value, so a user cannot select a combination that is guaranteed empty.
        """
        out: Dict[str, Any] = {}
        for label, col in (
            ("severities", CloudSecurityFinding.severity),
            ("categories", CloudSecurityFinding.category),
            ("statuses", CloudSecurityFinding.status),
            ("verdicts", CloudSecurityFinding.verdict),
            ("confidences", CloudSecurityFinding.confidence),
            ("providers", CloudSecurityFinding.provider),
            ("resource_types", CloudSecurityFinding.resource_type),
            ("rule_ids", CloudSecurityFinding.rule_id),
        ):
            stmt = select(col, func.count()).group_by(col)
            if account_ids:
                stmt = stmt.where(CloudSecurityFinding.account_id.in_(list(account_ids)))
            rows = (await self.db.execute(stmt)).all()
            out[label] = [
                {"value": r[0], "count": int(r[1])} for r in rows if r[0] is not None
            ]
            if label == "severities":
                out[label].sort(key=lambda d: severity_rank(d["value"]))
            else:
                out[label].sort(key=lambda d: -d["count"])
        return out

    # ── Assessments ─────────────────────────────────────────────────────────

    async def record_assessment(
        self, *, account_id: uuid.UUID, assessment: Any, score: Any,
        persist_stats: Dict[str, Any], triggered_by: str,
        inventory_last_discovered: Optional[datetime] = None,
    ) -> CloudSecurityAssessment:
        from app.security.model import UNKNOWN as V_UNKNOWN, NOT_SCANNED, VULNERABLE

        confirmed = [f for f in assessment.findings if f.verdict == VULNERABLE]
        undet = [f for f in assessment.findings
                 if f.verdict in (V_UNKNOWN, NOT_SCANNED)]
        row = CloudSecurityAssessment(
            account_id=account_id,
            provider=assessment.provider,
            outcome=assessment.outcome,
            score=score.score,
            grade=score.grade,
            score_reliable=score.reliable,
            coverage_pct=assessment.coverage_pct,
            resources_evaluated=assessment.resources_evaluated,
            rules_evaluated=assessment.rules_evaluated,
            findings_open=len(assessment.findings),
            findings_confirmed=len(confirmed),
            findings_undetermined=len(undet),
            findings_resolved_by_run=persist_stats.get("resolved", 0),
            findings_new_by_run=persist_stats.get("new", 0),
            by_severity={
                sev: sum(1 for f in confirmed if f.severity == sev) for sev in SEVERITIES
            },
            coverage={c.dimension: c.pct for c in assessment.coverage},
            score_breakdown=score.to_dict(),
            incomplete_reasons=assessment.incomplete_reasons,
            triggered_by=triggered_by,
            inventory_last_discovered_at=inventory_last_discovered,
            started_at=assessment.started_at,
            finished_at=assessment.finished_at,
            duration_ms=int(
                (assessment.finished_at - assessment.started_at).total_seconds() * 1000),
        )
        self.db.add(row)
        await self.db.flush()
        return row

    async def latest_assessment(
        self, account_id: uuid.UUID, *, offset: int = 0,
    ) -> Optional[CloudSecurityAssessment]:
        stmt = (select(CloudSecurityAssessment)
                .where(CloudSecurityAssessment.account_id == account_id)
                .order_by(CloudSecurityAssessment.finished_at.desc())
                .limit(1).offset(offset))
        return (await self.db.execute(stmt)).scalar_one_or_none()

    async def assessment_history(
        self, account_id: uuid.UUID, *, limit: int = 60,
    ) -> List[CloudSecurityAssessment]:
        stmt = (select(CloudSecurityAssessment)
                .where(CloudSecurityAssessment.account_id == account_id)
                .order_by(CloudSecurityAssessment.finished_at.desc())
                .limit(max(1, min(limit, 365))))
        return list((await self.db.execute(stmt)).scalars().all())

    async def prune_assessments(self, account_id: uuid.UUID, keep: int = 200) -> int:
        """Assessment history grows one row per scan per account and only the
        recent ones are ever read. Unbounded, it would eventually dominate the
        table it shares with nothing."""
        stmt = (select(CloudSecurityAssessment.id)
                .where(CloudSecurityAssessment.account_id == account_id)
                .order_by(CloudSecurityAssessment.finished_at.desc())
                .offset(keep))
        old = list((await self.db.execute(stmt)).scalars().all())
        if not old:
            return 0
        await self.db.execute(
            delete(CloudSecurityAssessment).where(CloudSecurityAssessment.id.in_(old)))
        return len(old)

    # ── Alert policies ──────────────────────────────────────────────────────

    async def list_policies(
        self, account_id: Optional[uuid.UUID] = None, *, enabled_only: bool = False,
    ) -> List[CloudAlertPolicy]:
        """Policies in force for an account: its own, plus the global ones."""
        stmt = select(CloudAlertPolicy)
        if account_id is not None:
            stmt = stmt.where(
                (CloudAlertPolicy.account_id == account_id)
                | (CloudAlertPolicy.account_id.is_(None))
            )
        if enabled_only:
            stmt = stmt.where(CloudAlertPolicy.enabled.is_(True))
        return list((await self.db.execute(
            stmt.order_by(CloudAlertPolicy.name))).scalars().all())

    async def get_policy(self, policy_id: uuid.UUID) -> Optional[CloudAlertPolicy]:
        return await self.db.get(CloudAlertPolicy, policy_id)

    async def seed_default_policies(self) -> int:
        """Create the built-in policies, or refresh their wording.

        Deliberately does NOT overwrite `enabled`, `threshold_value`,
        `cooldown_minutes` or `alert_severity` on an existing row: those are the
        fields an operator tunes, and a deploy that silently re-enabled a policy
        someone had turned off would be a deploy that started paging people
        again for reasons nobody could trace.
        """
        created = 0
        for spec in pol.DEFAULT_POLICIES:
            key = spec["policy_key"]
            row = (await self.db.execute(select(CloudAlertPolicy).where(
                CloudAlertPolicy.policy_key == key))).scalar_one_or_none()
            if row is None:
                self.db.add(CloudAlertPolicy(
                    policy_key=key,
                    name=spec["name"],
                    description=spec.get("description"),
                    enabled=True,
                    builtin=True,
                    providers=spec.get("providers"),
                    rule_ids=spec.get("rule_ids"),
                    categories=spec.get("categories"),
                    resource_types=spec.get("resource_types"),
                    min_severity=spec.get("min_severity"),
                    ports=spec.get("ports"),
                    match_verdicts=spec.get("match_verdicts"),
                    threshold_kind=spec["threshold_kind"],
                    threshold_value=float(spec["threshold_value"]),
                    alert_severity=spec.get("alert_severity"),
                    cooldown_minutes=int(spec.get("cooldown_minutes", 60)),
                    notify=bool(spec.get("notify", True)),
                ))
                created += 1
            else:
                # Refresh only what is definitional, never what is tuned.
                row.name = spec["name"]
                row.description = spec.get("description")
                row.providers = spec.get("providers")
                row.rule_ids = spec.get("rule_ids")
                row.categories = spec.get("categories")
                row.resource_types = spec.get("resource_types")
                row.min_severity = spec.get("min_severity")
                row.ports = spec.get("ports")
                row.match_verdicts = spec.get("match_verdicts")
                row.threshold_kind = spec["threshold_kind"]
                row.builtin = True
        await self.db.flush()
        return created

    async def note_policy_trigger(self, policy_ids: Iterable[str]) -> None:
        ids = [_as_uuid(p) for p in policy_ids if p]
        ids = [i for i in ids if i]
        if not ids:
            return
        await self.db.execute(
            update(CloudAlertPolicy)
            .where(CloudAlertPolicy.id.in_(ids))
            .values(last_triggered_at=datetime.now(timezone.utc),
                    trigger_count=CloudAlertPolicy.trigger_count + 1)
        )

    # ── Aggregates for the overview ─────────────────────────────────────────

    async def severity_counts(
        self, account_ids: Sequence[uuid.UUID], *, statuses: Optional[Sequence[str]] = None,
    ) -> Dict[str, int]:
        stmt = select(CloudSecurityFinding.severity, func.count()).group_by(
            CloudSecurityFinding.severity)
        if account_ids:
            stmt = stmt.where(CloudSecurityFinding.account_id.in_(list(account_ids)))
        stmt = stmt.where(CloudSecurityFinding.status.in_(
            list(statuses or ACTIVE_FINDING_STATUSES)))
        rows = (await self.db.execute(stmt)).all()
        out = {s: 0 for s in SEVERITIES}
        for sev, n in rows:
            if sev in out:
                out[sev] = int(n)
        return out

    async def stale_finding_count(self, account_id: uuid.UUID, hours: int = 24) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        stmt = select(func.count()).select_from(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id,
            CloudSecurityFinding.status.in_(list(ACTIVE_FINDING_STATUSES)),
            CloudSecurityFinding.first_detected_at <= cutoff,
        )
        return int((await self.db.execute(stmt)).scalar() or 0)


def _severity_case(order: Dict[str, int]):
    from sqlalchemy import case
    return case(
        {sev: rank for sev, rank in order.items()},
        value=CloudSecurityFinding.severity,
        else_=len(order),
    )


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None
