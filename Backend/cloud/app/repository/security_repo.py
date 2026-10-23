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

A finding a user has SUPPRESSED or accepted as risk is not resurrected to OPEN
by a mere re-detection. Their decision stands — until it runs out. Two things
end it, both recorded in the finding's exception history with the reason:

* **its review date passes** — checked here for re-detected findings, and by
  `lapse_expired_exceptions` (run on a timer) for everything else, so a
  lapsed acceptance reopens even on an account whose scans keep failing;
* **the finding gets worse than what was approved** — accepting SSH at HIGH
  is not accepting it at CRITICAL.

A *new* port on the same host is never covered: exposure findings are one per
port, so it arrives with its own fingerprint and opens normally.
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
    ACTIVE_FINDING_STATUSES, ASSESS_COMPLETE, EXCEPTION_HISTORY_LIMIT,
    MUTED_FINDING_STATUSES, NOT_SCANNED, OPEN, RESOLVED, SEVERITIES, STATUS_LABEL,
    UNKNOWN, severity_rank,
)

logger = logging.getLogger("cloud_svc.security.repo")

# Who is recorded as changing a status when no person did.
SYSTEM_EXCEPTION_REVIEW = "system:exception-review"


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _current_decision(row: CloudSecurityFinding) -> Optional[Dict[str, Any]]:
    """The muting decision in force on `row`, or None.

    Findings muted before exceptions had owners carry no `exception` record;
    their decision is rebuilt from the status columns so it still lands in
    history when it ends rather than vanishing.
    """
    if row.status not in MUTED_FINDING_STATUSES:
        return None
    current = (row.exception or {}).get("current")
    if current:
        return dict(current)
    return {
        "status": row.status,
        "reason": row.status_reason,
        "approved_by": row.status_changed_by,
        "approved_at": _iso(row.status_changed_at),
        "expires_at": None,
        "legacy": True,
    }


def close_exception(row: CloudSecurityFinding, now: datetime, why: str) -> None:
    """Move the decision in force into history. Does not change the status."""
    decision = _current_decision(row)
    history = list((row.exception or {}).get("history") or [])
    if decision:
        decision.update({"ended_at": _iso(now), "ended_reason": why})
        history.insert(0, decision)
    # Reassigned, never mutated in place: SQLAlchemy does not see in-place
    # changes to a JSONB dict, and the old decision would silently not save.
    row.exception = {"current": None, "history": history[:EXCEPTION_HISTORY_LIMIT]}
    row.exception_expires_at = None


def open_exception(row: CloudSecurityFinding, *, status: str, reason: Optional[str],
                   actor: Optional[str], now: datetime,
                   expires_at: Optional[datetime] = None, owner: Optional[str] = None,
                   ticket: Optional[str] = None,
                   compensating_controls: Optional[Sequence[str]] = None,
                   compensating_note: Optional[str] = None) -> None:
    """Record a new muting decision, archiving whichever one it replaces."""
    if row.status in MUTED_FINDING_STATUSES:
        close_exception(row, now, f"Replaced by a new decision from {actor or 'unknown'}")
    history = list((row.exception or {}).get("history") or [])
    row.exception = {
        "current": {
            "status": status,
            "reason": reason,
            "owner": owner,
            "ticket": ticket,
            "compensating_controls": list(compensating_controls or []),
            "compensating_note": compensating_note,
            "approved_by": actor,
            "approved_at": _iso(now),
            # What was agreed to. A later escalation past it reopens the finding.
            "approved_severity": row.severity,
            "expires_at": _iso(expires_at),
        },
        "history": history,
    }
    row.exception_expires_at = expires_at


def exception_end_reason(row: CloudSecurityFinding, now: datetime) -> Optional[str]:
    """Why a muted finding's decision no longer holds, or None while it does."""
    if row.status not in MUTED_FINDING_STATUSES:
        return None
    decision = (row.exception or {}).get("current") or {}
    label = STATUS_LABEL.get(row.status, row.status).lower()
    expires = row.exception_expires_at
    if expires is not None and expires <= now:
        who = decision.get("approved_by") or "unknown"
        return (f"The {label} decision reached its review date on {expires:%Y-%m-%d} "
                f"(approved by {who}: {decision.get('reason') or 'no reason recorded'}). "
                "Fix the finding or approve it again.")
    approved = decision.get("approved_severity")
    if approved and severity_rank(row.severity) < severity_rank(approved):
        return (f"Severity rose from {approved} to {row.severity} after this was "
                f"{label}. The decision covered {approved}, not {row.severity}, so it "
                "needs to be made again.")
    return None


def reopen_from_exception(row: CloudSecurityFinding, now: datetime, why: str) -> None:
    close_exception(row, now, why)
    row.status = OPEN
    row.status_reason = why
    row.status_changed_by = SYSTEM_EXCEPTION_REVIEW
    row.status_changed_at = now
    row.resolved_at = None


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
        rule_scope: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        """Reconcile an assessment's findings against the stored set.

        Returns `{new, updated, resolved, reopened, newly_opened, escalated}`.
        `newly_opened` is the set of fingerprints that went from absent-or-
        resolved to open — the only ones an `any_new` policy should fire on.

        `rule_scope` limits BOTH the existing set and the resolution sweep to
        findings whose `rule_id` is in it. Without it, a caller that produces
        only part of the finding estate — the identity analyser, which runs on
        its own schedule and emits only `IDENTITY_*` rules — would present its
        partial set as the whole, and the resolution pass below would close
        every storage, network and encryption finding on the account because
        they were "no longer present". That is the same shape as the partial
        scan that once pruned 62 live resources, and the scope is the guard:
        an analyser reconciles its own rules and cannot touch anyone else's.
        """
        now = now or datetime.now(timezone.utc)
        stmt = select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id)
        if rule_scope is not None:
            stmt = stmt.where(CloudSecurityFinding.rule_id.in_(list(rule_scope)))
        existing_rows = list((await self.db.execute(stmt)).scalars().all())
        existing = {r.fingerprint: r for r in existing_rows}

        seen: Set[str] = set()
        newly_opened: Set[str] = set()
        stats = {"new": 0, "updated": 0, "resolved": 0, "reopened": 0, "escalated": 0,
                 "exceptions_ended": 0, "superseded": 0}

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
                # Suppressed / risk-accepted: a human decision, and re-detecting
                # the finding does not override it — unless the decision has
                # reached its review date, or the finding is now worse than the
                # severity that was approved. Neither depends on the sweep
                # being complete: both are facts about the decision, not about
                # whether the resource was enumerated.
                why = exception_end_reason(row, now)
                if why:
                    reopen_from_exception(row, now, why)
                    newly_opened.add(fp)
                    stats["reopened"] += 1
                    stats["exceptions_ended"] += 1
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

        # ── Copies left by an unstable identity ─────────────────────────────
        # The aggregate "not assessed" findings once hashed their reason with
        # Python's hash(), which is salted per process, so every service
        # restart minted a new fingerprint for the same gap. oci_test ended up
        # with 11 open copies of one EXPOSURE_UNDETERMINED finding, and none
        # could ever resolve, because that account's sweeps are never
        # complete. The gap is still represented, by the row this run DID see,
        # so closing the copies is correct even from a PARTIAL assessment:
        # nothing is being declared fixed.
        live_gaps = {
            (f.rule_id, (f.evidence or {}).get("reason"))
            for f in findings
            if f.resource_key is None and f.verdict in (UNKNOWN, NOT_SCANNED)
            and (f.evidence or {}).get("reason")
        }
        if live_gaps:
            for fp, row in existing.items():
                if (fp in seen or row.status not in ACTIVE_FINDING_STATUSES
                        or row.resource_key is not None
                        or row.verdict not in (UNKNOWN, NOT_SCANNED)):
                    continue
                if (row.rule_id, (row.evidence or {}).get("reason")) in live_gaps:
                    row.status = RESOLVED
                    row.resolved_at = now
                    row.status_reason = (
                        "Superseded: a duplicate of the same not-assessed finding, "
                        "created when its identity changed on a service restart. The "
                        "gap itself is still open under its current finding."
                    )
                    stats["superseded"] += 1

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
        resource_key: Optional[str] = None,
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
        if resource_key:
            # Exact, not the free-text search: a certificate named cert_ls_2023
            # is a LIKE pattern in which every "_" matches any character.
            conds.append(CloudSecurityFinding.resource_key == resource_key)
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
        exception: Optional[Dict[str, Any]] = None,
    ) -> Optional[CloudSecurityFinding]:
        """`exception` carries expires_at / owner / ticket / compensating
        controls for a SUPPRESSED or ACCEPTED_RISK decision; the service has
        already validated it."""
        row = await self.get_finding(account_id, key)
        if row is None:
            return None
        now = datetime.now(timezone.utc)
        if status in MUTED_FINDING_STATUSES:
            open_exception(row, status=status, reason=reason, actor=actor, now=now,
                           **(exception or {}))
        elif row.status in MUTED_FINDING_STATUSES:
            close_exception(row, now, f"Status changed to {STATUS_LABEL.get(status, status)} "
                                      f"by {actor or 'unknown'}")
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

    async def lapse_expired_exceptions(
        self, *, now: Optional[datetime] = None,
        account_id: Optional[uuid.UUID] = None,
    ) -> List[CloudSecurityFinding]:
        """Reopen every muted finding whose review date has passed.

        `persist_findings` already does this for findings an assessment
        re-detects, but that is not enough on its own: an account whose scans
        keep failing may go weeks without an assessment, and an expiry that
        only takes effect when a scan succeeds is not an expiry.
        """
        now = now or datetime.now(timezone.utc)
        stmt = select(CloudSecurityFinding).where(
            CloudSecurityFinding.status.in_(list(MUTED_FINDING_STATUSES)),
            CloudSecurityFinding.exception_expires_at.isnot(None),
            CloudSecurityFinding.exception_expires_at <= now,
        )
        if account_id is not None:
            stmt = stmt.where(CloudSecurityFinding.account_id == account_id)
        rows = list((await self.db.execute(stmt)).scalars().all())
        for row in rows:
            reopen_from_exception(row, now, exception_end_reason(row, now)
                                  or "The review date passed.")
        await self.db.flush()
        return rows

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
