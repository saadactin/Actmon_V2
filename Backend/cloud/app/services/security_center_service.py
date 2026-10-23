"""Security Center orchestration: assess, persist, alert, and serve the views.

The read/write split is the point of this module.

**Write path** — `assess()` runs after a discovery scan, or on an explicit
"Run assessment" click. It loads inventory, runs the engine, reconciles the
findings table, records the assessment row, evaluates the alert policies and
creates or resolves alerts. It is the only thing that computes anything.

**Read path** — everything else serves *persisted* findings. Previously
`GET /security/{id}` re-ran every rule over every resource on each request, and
the Compliance tab then ran the whole thing a second time. On the live OCI
tenancy that is 1,045 rule evaluations per page load, twice, with no history to
show for it. Now a page load is a filtered, indexed, paged SELECT.

Two behaviours worth knowing before changing anything here:

* **Nothing is resolved from an incomplete assessment.** The engine reports
  `outcome=PARTIAL` when the sweep did not enumerate every scope, and the
  repository refuses to resolve absent findings in that case. Closing a finding
  because the scanner could not see it is the single worst mistake this system
  could make, and it is the mistake a partially-failed OCI scan already made
  once with the inventory prune.
* **An alert is only ever created from a canonical finding.** There is no path
  from a rule to an alert that bypasses the findings table, so an alert can
  always be traced back to the evidence that produced it.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import STATE_ACKNOWLEDGED, STATE_OPEN, STATE_RESOLVED, CloudAlert
from app.models.cloud_account import CloudAccount
from app.models.identity_grant import (
    COLLECT_NEVER_RUN, COLLECT_NOT_SUPPORTED, COLLECT_OK,
)
from app.repository.alert_repo import AlertRepository
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.credential_repo import CredentialRepository
from app.repository.identity_repo import IdentityRepository
from app.repository.resource_repo import ResourceRepository
from app.repository.security_repo import SecurityRepository
from app.security import compliance as comp
from app.security import controls as ctl
from app.security import engine, exposure, identity, policies as pol, scoring
from app.security import registry as reg
from app.security.model import (
    ACTIVE_FINDING_STATUSES, ASSESS_COMPLETE, AWS, AZURE, COMPENSATING_CONTROLS, CRITICAL,
    EXCEPTION_ACTIVE, EXCEPTION_EXPIRING, EXCEPTION_NO_REVIEW_DATE,
    FINDING_STATUSES, MUTED_FINDING_STATUSES, OCI, OPEN, RESOLVED,
    STATUS_REQUIRES_OWNER_AND_EXPIRY, STATUS_REQUIRES_REASON, SEVERITIES,
    exception_max_days, exception_state, normalize_provider,
)

logger = logging.getLogger("cloud_svc.security.center")

# How old an assessment may be before the UI is told to say so. Deliberately
# shorter than the inventory staleness window: an assessment is cheap to re-run
# (it reads stored data), so there is no excuse for a stale one.
ASSESSMENT_STALE_AFTER = timedelta(hours=6)
# Inventory staleness is a different and more serious statement — it means the
# provider has not been contacted, and no assessment can be fresher than the
# data under it.
INVENTORY_STALE_AFTER = timedelta(hours=24)


class SecurityCenterService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = SecurityRepository(db)
        self.accounts = CloudAccountRepository(db)
        self.resources = ResourceRepository(db)
        self.identity = IdentityRepository(db)
        self.alerts = AlertRepository(db)
        self.credentials = CredentialRepository(db)

    # ═════════════════════════════════════════════════════════════════════════
    # Write path
    # ═════════════════════════════════════════════════════════════════════════

    async def assess(
        self,
        account_id: uuid.UUID,
        *,
        triggered_by: str = "manual",
        sweep_complete: Optional[bool] = None,
        failed_scopes: Optional[int] = None,
        scope_summary: Optional[Dict[str, Any]] = None,
        discovery_scan_id: Optional[uuid.UUID] = None,
        evaluate_policies: bool = True,
        account_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Evaluate an account, persist the result, and fire any due alerts.

        The sweep's completeness is the inventory's, not the caller's: when a
        caller does not say (the "Run assessment" button, a certificate
        re-check), it is read from the latest FINISHED discovery job. This used
        to default to complete, so a manual run straight after a partial sweep
        reported the inventory as fully read.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")

        if sweep_complete is None or scope_summary is None:
            from app.models.discovery_job import DiscoveryJob

            last = (await self.db.execute(
                select(DiscoveryJob).where(
                    DiscoveryJob.account_id == account_id,
                    DiscoveryJob.status.in_(["COMPLETED", "FAILED"]))
                .order_by(DiscoveryJob.started_at.desc()).limit(1)
            )).scalar_one_or_none()
            if last is not None:
                if sweep_complete is None:
                    # A partial sweep COMPLETEs with its note in error_detail.
                    sweep_complete = last.status == "COMPLETED" and not last.error_detail
                if scope_summary is None:
                    scope_summary = last.scope_summary
        if sweep_complete is None:
            # Never scanned: the engine's empty-inventory branch says so.
            sweep_complete = True
        if failed_scopes is None:
            failed_scopes = 0

        resources = await self.resources.list_by_account(account_id)
        grants = await self.identity.grants(account_id)
        state = await self.identity.state(account_id)
        cred_objects = await self.credentials.objects([account_id])
        cred_sources = await self.credentials.sources([account_id])

        assessment = engine.assess(
            account_id=str(account_id),
            provider=account.provider,
            resources=resources,
            grants=grants,
            identity_state=state,
            credentials=cred_objects,
            credential_sources=cred_sources,
            sweep_complete=sweep_complete,
            failed_scopes=failed_scopes,
            scope_summary=scope_summary,
            discovery_scan_id=str(discovery_scan_id) if discovery_scan_id else None,
            inventory_last_discovered=account.last_discovery,
        )

        persist_stats = await self.repo.persist_findings(
            account_id=account_id,
            findings=assessment.findings,
            outcome=assessment.outcome,
            discovery_scan_id=discovery_scan_id,
        )

        score = scoring.compute(
            assessment.findings,
            coverage_pct=assessment.coverage_pct,
            resources_evaluated=assessment.subjects_evaluated,
        )
        await self.repo.record_assessment(
            account_id=account_id, assessment=assessment, score=score,
            persist_stats=persist_stats, triggered_by=triggered_by,
            inventory_last_discovered=account.last_discovery,
        )
        await self.repo.prune_assessments(account_id)

        alert_stats = {"created": 0, "reopened": 0, "resolved": 0, "notified": 0}
        if evaluate_policies:
            alert_stats = await self._evaluate_policies(
                account=account,
                assessment=assessment,
                score=score,
                newly_opened=persist_stats["newly_opened"],
                resources=resources,
            )

        await self.db.commit()

        return {
            "account_id": str(account_id),
            "account_name": account.account_name,
            "provider": assessment.provider,
            "outcome": assessment.outcome,
            "findings": {k: v for k, v in persist_stats.items() if k != "newly_opened"},
            "alerts": alert_stats,
            "score": score.to_dict(),
            "assessment": assessment.to_dict(),
        }

    async def collect_identity(
        self, account_id: uuid.UUID, *, account: Optional[CloudAccount] = None,
    ) -> Dict[str, Any]:
        """Collect provider identity grants. Azure only today; AWS and OCI keep
        theirs in `cloud_resources` and need no separate call.

        Never raises. A refusal is recorded as a collection state, which is the
        useful output — it is what turns "no over-privileged identities" into
        "we were denied Microsoft.Authorization/roleAssignments/read".
        """
        account = account or await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        prov = normalize_provider(account.provider)

        if prov != AZURE:
            await self.identity.record_state(
                account_id=account_id, provider=prov or account.provider,
                status=COLLECT_NOT_SUPPORTED,
                error_detail=("This provider's identity data is collected as resources "
                              "(IAM roles for AWS, IAM policies for OCI) and needs no "
                              "separate call."),
            )
            await self.db.commit()
            return {"status": COLLECT_NOT_SUPPORTED, "grants": 0}

        from app.providers.azure.azure_auth import AzureAuth
        from app.providers.azure.azure_rbac import collect_role_assignments
        from app.utils.encryption import decrypt_credentials

        try:
            creds = decrypt_credentials(account.credentials_enc)
        except Exception as exc:  # noqa: BLE001
            await self.identity.record_state(
                account_id=account_id, provider=AZURE,
                status="AuthenticationFailed",
                error_detail=f"Stored credentials could not be decrypted: {exc}",
            )
            await self.db.commit()
            return {"status": "AuthenticationFailed", "grants": 0}

        auth = AzureAuth(creds)
        loop = asyncio.get_running_loop()
        # Blocking Azure SDK call — same executor contract as every scanner.
        result = await loop.run_in_executor(
            None, collect_role_assignments, auth, creds["subscription_id"])

        if result["status"] == COLLECT_OK:
            n = await self.identity.replace_grants(
                account_id=account_id, provider=AZURE, grants=result["grants"])
            await self.identity.record_state(
                account_id=account_id, provider=AZURE, status=COLLECT_OK, grant_count=n)
            await self.db.commit()
            logger.info("Collected %d Azure role assignment(s) for %s", n,
                        account.account_name)
            return {"status": COLLECT_OK, "grants": n}

        await self.identity.record_state(
            account_id=account_id, provider=AZURE, status=result["status"],
            error_detail=result.get("error_detail"),
            missing_permission=result.get("missing_permission"),
        )
        await self.db.commit()
        logger.info("Azure identity collection for %s: %s", account.account_name,
                    result["status"])
        return {"status": result["status"], "grants": 0,
                "missing_permission": result.get("missing_permission")}

    async def _evaluate_policies(
        self, *, account: CloudAccount, assessment: Any, score: Any,
        newly_opened: Set[str], resources: Sequence[Any],
    ) -> Dict[str, int]:
        """Turn findings into alerts, per policy, with dedupe and cooldown."""
        rows = await self.repo.list_policies(account.id, enabled_only=True)
        if not rows:
            return {"created": 0, "reopened": 0, "resolved": 0, "notified": 0}

        # Read back the persisted findings rather than using the in-memory ones:
        # the stored rows carry detection_count and the true first_detected_at,
        # which the consecutive-detection and duration thresholds depend on.
        stored = await self.repo.findings_for_account(
            account.id, statuses=ACTIVE_FINDING_STATUSES)

        resource_counts: Dict[str, int] = {}
        for r in resources:
            resource_counts[r.resource_type] = resource_counts.get(r.resource_type, 0) + 1

        intents = pol.evaluate(
            policies=rows,
            findings=stored,
            account_id=str(account.id),
            account_name=account.account_name,
            provider=assessment.provider,
            # A withheld score must not fire the score-threshold policy: there
            # is no number to compare, and alerting on `None < 70` would page
            # someone about a scanner permission problem under a security label.
            score=score.score if score.reliable else None,
            resource_counts=resource_counts,
            newly_opened=newly_opened,
        )

        stats = {"created": 0, "reopened": 0, "resolved": 0, "notified": 0}
        now = datetime.now(timezone.utc)
        seen_keys: List[str] = []
        triggered_policies: Set[str] = set()

        for intent in intents:
            seen_keys.append(intent.dedupe_key)
            existing = await self.alerts.get_by_dedupe_key(intent.dedupe_key)
            alert, just_opened = await self.alerts.upsert(
                anomaly_type=intent.policy_name,
                details=intent.details,
                severity=intent.severity,
                dedupe_key=intent.dedupe_key,
                account_id=account.id,
                resource_id=_as_uuid(intent.resource_id),
                resource_name=intent.resource_name,
                resource_type=intent.resource_type,
                context=intent.context,
            )
            alert.finding_fingerprint = intent.finding_fingerprint
            alert.policy_id = _as_uuid(intent.policy_id)
            alert.policy_name = intent.policy_name
            if existing is None:
                stats["created"] += 1
            elif just_opened:
                stats["reopened"] += 1
            triggered_policies.add(intent.policy_id)

            if pol.should_notify(alert, intent, just_opened=just_opened, now=now):
                queued = await self._notify(alert, account.account_name)
                alert.last_notified_at = now
                alert.notification_count = (alert.notification_count or 0) + 1
                alert.notification_status = f"queued:{queued}" if queued else "no_channel"
                if queued:
                    stats["notified"] += 1

        # ── Auto-resolve, gated exactly as finding resolution is ────────────
        if assessment.outcome == ASSESS_COMPLETE:
            stats["resolved"] = await self.alerts.auto_resolve_missing(
                seen_keys, "POLICY:", account_id=account.id)
        else:
            logger.info(
                "Skipping security alert auto-resolve for %s — assessment outcome was "
                "%s, so an absent condition may only mean it could not be evaluated.",
                account.account_name, assessment.outcome,
            )

        await self.repo.note_policy_trigger(triggered_policies)
        return stats

    async def _notify(self, alert, account_name: Optional[str]) -> int:
        """Queue notifications through the existing bridge. Never raises — a
        notification problem must not fail an assessment."""
        try:
            from app.services.notification_bridge import queue_notifications_for_alert
            return await queue_notifications_for_alert(
                self.db, alert, account_name=account_name)
        except Exception:  # noqa: BLE001
            logger.exception("Notification queueing failed for alert %s",
                             getattr(alert, "id", "?"))
            return 0

    # ═════════════════════════════════════════════════════════════════════════
    # Read path
    # ═════════════════════════════════════════════════════════════════════════

    async def overview(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Everything the Security Center Overview needs, in one response."""
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")

        latest = await self.repo.latest_assessment(account_id)
        findings = await self.repo.findings_for_account(account_id)
        active = [f for f in findings if f.status in ACTIVE_FINDING_STATUSES]

        confirmed = [f for f in active if f.verdict == "VULNERABLE"]
        undetermined = [f for f in active if f.verdict in ("UNKNOWN", "NOT_SCANNED")]

        alert_counts = await self.alerts.counts_by_state(account_id)
        state = await self.identity.state(account_id)
        grants = await self.identity.grants(account_id)
        prov = normalize_provider(account.provider)
        identity_row = _identity_state(state, prov)

        # Top risks: the findings an operator should look at first. Confirmed
        # only — an UNKNOWN belongs in Coverage, not at the top of a risk list.
        top = sorted(
            confirmed,
            key=lambda f: (SEVERITIES.index(f.severity)
                           if f.severity in SEVERITIES else 9,
                           -(f.affected_count or 1)),
        )[:10]

        return {
            "account": {
                "id": str(account.id),
                "name": account.account_name,
                "provider": account.provider,
                "last_discovery": _iso(account.last_discovery),
                "auto_discovery": getattr(account, "auto_discovery", None),
            },
            "score": (latest.score_breakdown if latest and latest.score_breakdown
                      else _no_assessment_score()),
            "findings_summary": {
                "total": len(active),
                "confirmed": len(confirmed),
                "undetermined": len(undetermined),
                "muted": sum(1 for f in findings if f.status in MUTED_FINDING_STATUSES),
                "exceptions": _exception_summary(findings, datetime.now(timezone.utc)),
                "resolved": sum(1 for f in findings if f.status == RESOLVED),
                "by_severity": {
                    sev: sum(1 for f in confirmed if f.severity == sev)
                    for sev in SEVERITIES
                },
                "by_severity_undetermined": {
                    sev: sum(1 for f in undetermined if f.severity == sev)
                    for sev in SEVERITIES
                },
                "by_category": _count_by(confirmed, "category"),
            },
            "alerts_summary": {
                "open": alert_counts.get(STATE_OPEN, 0),
                "acknowledged": alert_counts.get(STATE_ACKNOWLEDGED, 0),
                "resolved": alert_counts.get(STATE_RESOLVED, 0),
                "active": alert_counts.get(STATE_OPEN, 0)
                + alert_counts.get(STATE_ACKNOWLEDGED, 0),
            },
            "exposure_summary": _exposure_summary_from_findings(active),
            "identity_summary": {
                "collection_status": _identity_status(state, prov),
                # AWS and OCI identity data arrives with the inventory, so
                # there is no collection step to fail. `state and
                # state.trustworthy` reported both as untrustworthy, and the
                # Overview tile read "identity not collected" directly beside
                # 39 escalation findings derived from that very data.
                "trustworthy": _identity_status(state, prov) == COLLECT_OK,
                "missing_permission": (identity_row.missing_permission
                                       if identity_row else None),
                "error_detail": identity_row.error_detail if identity_row else None,
                "grants_collected": len(grants),
                "flagged": sum(1 for f in confirmed if f.category == "Identity & Access"),
                "escalation_paths": sum(
                    1 for f in confirmed if f.rule_id in _ESCALATION_RULES),
            },
            "coverage": (latest.coverage if latest else None),
            "coverage_pct": (latest.coverage_pct if latest else None),
            "freshness": self._freshness(account, latest),
            "top_risks": [f.to_dict() for f in top],
            "assessment": latest.to_dict() if latest else None,
        }

    def _freshness(self, account, latest) -> Dict[str, Any]:
        """Three distinct timestamps the UI must not conflate (§7).

        `last_verified_against_provider` is deliberately null for an ordinary
        assessment: the engine reads stored inventory, so the newest thing it
        can honestly claim is "evaluated", and claiming "verified" would be a
        real-time claim over data that may be 70 days old.
        """
        now = datetime.now(timezone.utc)
        disc = account.last_discovery
        assessed = latest.finished_at if latest else None

        def age(dt):
            if not dt:
                return None
            d = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
            return int((now - d).total_seconds())

        inv_age = age(disc)
        asm_age = age(assessed)
        return {
            "inventory_collected_at": _iso(disc),
            "inventory_age_seconds": inv_age,
            "inventory_stale": (inv_age is not None
                                and inv_age > INVENTORY_STALE_AFTER.total_seconds()),
            "last_assessed_at": _iso(assessed),
            "assessment_age_seconds": asm_age,
            "assessment_stale": (asm_age is None
                                 or asm_age > ASSESSMENT_STALE_AFTER.total_seconds()),
            "last_verified_against_provider": None,
            "note": (
                "The assessment evaluates stored inventory; it does not re-contact the "
                "provider. Findings can therefore be no fresher than the inventory they "
                "were derived from, whatever the assessment timestamp says."
            ),
        }

    async def findings(
        self, *, account_ids: Sequence[uuid.UUID], filters: Dict[str, Any],
        limit: int = 100, offset: int = 0,
    ) -> Dict[str, Any]:
        rows, total = await self.repo.list_findings(
            account_ids=account_ids, limit=limit, offset=offset, **filters)
        return {
            "findings": [r.to_dict() for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(rows) < total,
        }

    async def finding_detail(
        self, account_id: uuid.UUID, key: str,
    ) -> Optional[Dict[str, Any]]:
        """One finding plus everything connected to it (§38).

        The connections are what make a finding investigable rather than merely
        readable: the alert it produced, the controls it breaches, the drift
        that may have caused it, and the events around that change.
        """
        row = await self.repo.get_finding(account_id, key)
        if row is None:
            return None

        rule = reg.by_id(row.rule_id)
        out = row.to_dict(include_sample=True)
        out["rule"] = {
            "rule_id": row.rule_id,
            "current_version": rule.version if rule else None,
            "finding_version": row.rule_version,
            # A finding produced by an older version of a rule is explainable
            # rather than mysterious — this is what answers "why did this change
            # last Tuesday?".
            "version_changed_since": bool(rule and rule.version != row.rule_version),
            "provider": rule.provider if rule else None,
            "resource_types": list(rule.resource_types) if rule else [],
            "aggregate": bool(rule and rule.aggregate),
            "coverage_dimension": rule.coverage if rule else None,
        }

        alerts = list((await self.db.execute(
            select(CloudAlert)
            .where(CloudAlert.finding_fingerprint == row.fingerprint)
            .order_by(CloudAlert.created_at.desc())
        )).scalars().all())
        out["alerts"] = [a.to_dict() for a in alerts]

        out["timeline"] = self._timeline(row, alerts)
        out["related"] = await self._related(row)

        # What the declared severity means on THIS resource. Carried beside
        # `severity`, never instead of it: the rule's verdict about the
        # condition stays stable across scans, and the contextual band is a
        # separate, fully-shown calculation the drawer can re-derive.
        try:
            from app.services.attack_path_service import AttackPathService

            state = await self.identity.state(account_id)
            out["risk_context"] = await AttackPathService(self.db).risk_context(
                account_id,
                resource_id=str(row.resource_id) if row.resource_id else None,
                severity=row.severity,
                rule_id=row.rule_id,
                resource_type=row.resource_type,
                identity_collected=state is not None,
            )
        except Exception:
            # A finding must remain readable even if context cannot be built —
            # a missing graph is a reason to show the finding without its
            # amplifiers, not a reason to 500 the drawer.
            logger.exception("Contextual risk unavailable for finding %s", key)
            out["risk_context"] = None

        return out

    def _timeline(self, row, alerts) -> List[Dict[str, Any]]:
        """The audit trail for one finding (§64), newest last."""
        events: List[Dict[str, Any]] = []
        if row.first_detected_at:
            events.append({"at": _iso(row.first_detected_at), "event": "finding_detected",
                           "detail": f"First detected by {row.rule_id} "
                                     f"v{row.rule_version}."})
        if row.severity_changed_at:
            events.append({
                "at": _iso(row.severity_changed_at), "event": "severity_changed",
                "detail": f"{row.previous_severity} → {row.severity}.",
            })
        for a in alerts:
            events.append({"at": a.created_at.isoformat() if a.created_at else None,
                           "event": "alert_created",
                           "detail": f"Policy '{a.policy_name or a.anomaly_type}' "
                                     f"({a.severity})."})
            if a.acknowledged_at:
                events.append({"at": a.acknowledged_at.isoformat(),
                               "event": "alert_acknowledged",
                               "detail": f"By {a.acknowledged_by or 'unknown'}."})
            if a.resolved_at:
                events.append({"at": a.resolved_at.isoformat(),
                               "event": "alert_resolved",
                               "detail": a.resolution_reason or ""})
        if row.status_changed_at:
            events.append({
                "at": _iso(row.status_changed_at), "event": f"status_{row.status.lower()}",
                "detail": (f"By {row.status_changed_by or 'unknown'}"
                           + (f": {row.status_reason}" if row.status_reason else "")),
            })
        if row.resolved_at and row.status == RESOLVED:
            events.append({"at": _iso(row.resolved_at), "event": "finding_resolved",
                           "detail": row.status_reason or ""})
        if row.last_detected_at and row.detection_count > 1:
            events.append({
                "at": _iso(row.last_detected_at), "event": "last_detected",
                "detail": f"Seen in {row.detection_count} assessments.",
            })
        return sorted(events, key=lambda e: e["at"] or "")

    async def _related(self, row) -> Dict[str, Any]:
        """Deep links the UI renders as buttons. Query strings only — the
        Security Center never duplicates the drift or event views, it hands off
        to them, which is the same contract the topology already uses."""
        if not row.resource_id and not row.resource_key:
            return {}
        drift_count = 0
        if row.resource_id:
            from app.models.drift import CloudResourceChange
            from sqlalchemy import func
            drift_count = int((await self.db.execute(
                select(func.count()).select_from(CloudResourceChange).where(
                    CloudResourceChange.resource_id == row.resource_id)
            )).scalar() or 0)
        return {
            "resource_id": str(row.resource_id) if row.resource_id else None,
            "resource_key": row.resource_key,
            "drift_changes": drift_count,
            "links": {
                "resource": (f"/cloud/resources/{row.resource_id}"
                             if row.resource_id else None),
                "drift": (f"?resource={row.resource_id}"
                          f"&resourceName={row.resource_name or ''}&range=30d"
                          if row.resource_id else None),
                "events": (f"?resource={row.resource_id}"
                           f"&resourceName={row.resource_name or ''}&range=30d"
                           if row.resource_id else None),
                "topology": (f"?focus={row.resource_id}" if row.resource_id else None),
            },
        }

    async def set_finding_status(
        self, *, account_id: uuid.UUID, key: str, status: str,
        reason: Optional[str], actor: Optional[str],
        assigned_to: Optional[str] = None,
        expires_at: Optional[datetime] = None,
        review_in_days: Optional[int] = None,
        owner: Optional[str] = None,
        ticket: Optional[str] = None,
        compensating_controls: Optional[List[str]] = None,
        compensating_note: Optional[str] = None,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        """Returns (finding, error). Suppression and risk acceptance require a
        written reason — those are the two transitions someone will have to
        defend later. Accepting a risk also needs an owner and a review date
        within the category's window (see "Exceptions" in security/model.py)."""
        if status not in FINDING_STATUSES:
            return None, f"Unknown status {status!r}. Valid: {', '.join(FINDING_STATUSES)}"
        if status in STATUS_REQUIRES_REASON and not (reason or "").strip():
            return None, (f"A reason is required to set status {status}: it records why "
                          "a known risk was deliberately left in place.")

        exception = None
        if status in MUTED_FINDING_STATUSES:
            existing = await self.repo.get_finding(account_id, key)
            if existing is None:
                return None, "Finding not found"
            exception, err = _validate_exception(
                status=status, category=existing.category, expires_at=expires_at,
                review_in_days=review_in_days, owner=owner, ticket=ticket,
                compensating_controls=compensating_controls,
                compensating_note=compensating_note)
            if err:
                return None, err

        row = await self.repo.set_status(
            account_id=account_id, key=key, status=status, reason=reason,
            actor=actor, assigned_to=assigned_to, exception=exception)
        if row is None:
            return None, "Finding not found"

        # Suppressing or accepting a finding closes the alerts that pointed at
        # it: leaving them open would keep paging someone about a decision that
        # has already been made.
        if status in MUTED_FINDING_STATUSES or status == RESOLVED:
            alerts = list((await self.db.execute(
                select(CloudAlert).where(
                    CloudAlert.finding_fingerprint == row.fingerprint,
                    CloudAlert.state.in_([STATE_OPEN, STATE_ACKNOWLEDGED]),
                )
            )).scalars().all())
            now = datetime.now(timezone.utc)
            for a in alerts:
                a.state = STATE_RESOLVED
                a.resolved_at = now
                a.resolved_by = actor
                a.resolution_reason = (
                    f"Underlying finding set to {status} by {actor or 'unknown'}"
                    + (f": {reason}" if reason else "")
                )
        await self.db.commit()
        return row.to_dict(), None

    async def compliance(
        self, account_id: uuid.UUID, *, framework: Optional[str] = None,
        include_diff: bool = True,
    ) -> Dict[str, Any]:
        """The compliance view, built from persisted findings.

        `rule_stats` is reconstructed from the stored findings plus the rules
        that could have applied to this account's inventory. It is rebuilt
        rather than stored because it is derived data, and storing it would give
        two sources of truth for whether a control was assessed.
        """
        out = (await self.compliance_dataset(account_id, framework=framework))["view"]
        if include_diff:
            prev = await self.repo.latest_assessment(account_id, offset=1)
            out["trend"] = comp.diff(out, _stored_compliance(prev))
        return out

    async def compliance_dataset(
        self, account_id: uuid.UUID, *, framework: Optional[str] = None,
    ) -> Dict[str, Any]:
        """The compliance view together with what it was computed from.

        The audit export needs the same findings (every status, so accepted
        risks can be listed as exceptions) and the same rule statistics the
        view was resolved against. Handing them back from one place is what
        keeps the export from ever disagreeing with the Compliance tab.
        """
        findings = await self.repo.findings_for_account(account_id)
        rule_stats = await self._rule_stats(account_id, findings)
        account = await self.accounts.get_by_id(account_id)
        provider = normalize_provider(account.provider) if account else None
        view = comp.build(findings=findings, rule_stats=rule_stats,
                          account_id=str(account_id), framework=framework,
                          provider=provider)
        return {"view": view, "findings": findings, "rule_stats": rule_stats,
                "account": account, "provider": provider}

    async def _rule_stats(
        self, account_id: uuid.UUID, findings: Sequence[Any],
    ) -> Dict[str, Dict[str, int]]:
        """Which rules ran, and what they concluded, for control resolution.

        Derived from two sources: the findings themselves (a finding proves its
        rule produced that verdict), and the account's inventory (a rule whose
        resource type is present ran, and produced SAFE wherever it did not
        produce a finding). Without the second half a control with no findings
        would be indistinguishable from a control nobody checked — and the
        difference between PASS and NOT_EVALUATED is the whole point.
        """
        account = await self.accounts.get_by_id(account_id)
        prov = normalize_provider(account.provider) if account else None
        counts = await self.resources.count_by_type(account_id) \
            if hasattr(self.resources, "count_by_type") else {}
        if not counts:
            rows = await self.resources.list_by_account(account_id)
            counts = {}
            for r in rows:
                counts[r.resource_type] = counts.get(r.resource_type, 0) + 1

        stats: Dict[str, Dict[str, int]] = {}
        for f in findings:
            if f.status not in ACTIVE_FINDING_STATUSES:
                continue
            # A synthetic finding (certificate, role assignment) has no inventory
            # row; its statistics come from the analyser below, not from here.
            n = max(1, int(f.affected_count or 1))
            for key in (f.rule_id, ctl.stat_key(f.rule_id, f.resource_type or "")):
                stats.setdefault(key, {})
                stats[key][f.verdict] = stats[key].get(f.verdict, 0) + n

        if prov:
            for rtype, n in counts.items():
                for rule in reg.rules_for(prov, rtype):
                    for key in (rule.rule_id, ctl.stat_key(rule.rule_id, rtype)):
                        entry = stats.setdefault(key, {})
                        accounted = sum(entry.values())
                        if key == rule.rule_id:
                            # Per-rule totals span every type the rule covers —
                            # all of them for a universal rule.
                            total = (sum(counts.values()) if rule.resource_types == ("*",)
                                     else sum(counts.get(t, 0) for t in rule.resource_types))
                            if total > accounted:
                                entry["SAFE"] = entry.get("SAFE", 0) + (total - accounted)
                        elif n > accounted:
                            entry["SAFE"] = entry.get("SAFE", 0) + (n - accounted)

            # Certificate / secret / key rules: rebuilt from the stored
            # credential inventory with the same analyser the assessment ran,
            # so "the vault refused us" reaches compliance as NOT_SCANNED —
            # never as a pass.
            cred_objects = await self.credentials.objects([account_id])
            cred_sources = await self.credentials.sources([account_id])
            if cred_objects or cred_sources:
                from app.security import credentials as credx

                analysis = credx.analyse(provider=prov, objects=cred_objects,
                                         sources=cred_sources,
                                         now=datetime.now(timezone.utc))
                for rid, verdicts in analysis.rule_stats.items():
                    # Replace, not add: the persisted findings counted above are
                    # the same subjects the analyser just counted.
                    stats[rid] = dict(verdicts)
            # Exposure rules have no resource type of their own; if any exposure
            # finding exists the rules ran, and if the account has compute at
            # all they ran and found nothing.
            has_compute = any(
                rtype in exposure.COMPUTE_TYPES.get(prov, frozenset())
                for rtype in counts
            )
            if has_compute:
                for rid in ("EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN",
                            "EXPOSURE_DATA_PORT_WORLD_OPEN",
                            "EXPOSURE_ALL_PORTS_WORLD_OPEN",
                            "EXPOSURE_PORT_WORLD_OPEN", "EXPOSURE_UNDETERMINED"):
                    stats.setdefault(rid, {}).setdefault("SAFE", 1)
        return stats

    async def exposure(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Internet exposure, recomputed from inventory.

        The one read path that recomputes rather than reading findings, because
        an exposure verdict is a graph walk whose evidence (the path, the
        per-port verdicts) is too large to store per finding and is exactly what
        this view exists to show.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        prov = normalize_provider(account.provider)
        resources = await self.resources.list_by_account(account_id)
        results = exposure.analyse(resources, prov) if prov else []
        summary = exposure.summarise(results)
        return {
            "account_id": str(account_id),
            "provider": prov,
            **summary,
            "resources": [e.to_dict() for e in results],
            "port_catalog_note": (
                "Severity reflects what an internet-reachable service on that port would "
                "expose, not the service in general. Web ports are informational because "
                "a public web port is usually the intended configuration."
            ),
        }

    async def identity_review(self, account_id: uuid.UUID) -> Dict[str, Any]:
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        prov = normalize_provider(account.provider)
        findings = await self.repo.findings_for_account(
            account_id, statuses=ACTIVE_FINDING_STATUSES)
        grants = await self.identity.grants(account_id)
        state = await self.identity.state(account_id)
        counts = {}
        for r in await self.resources.list_by_account(account_id):
            counts[r.resource_type] = counts.get(r.resource_type, 0) + 1
        # What "an identity" is differs per provider: an AWS role, an OCI
        # policy, an Azure role assignment. The denominator has to match, or
        # "13 of 37 flagged" compares two different things.
        if prov == "AWS":
            reviewed = counts.get("IAMRole", 0)
        elif prov == "OCI":
            reviewed = counts.get("IAMPolicy", 0)
        else:
            reviewed = len(grants)
        row = _identity_state(state, prov)
        out = identity.review(
            provider=prov,
            findings=findings,
            grants=grants,
            collection_status=_identity_status(state, prov),
            collection_error=row.error_detail if row else None,
            missing_permission=row.missing_permission if row else None,
            identities_reviewed=reviewed,
        )
        out["grants"] = [g.to_dict() for g in grants[:500]]
        out["grants_truncated"] = len(grants) > 500
        return out

    async def coverage(self, account_id: uuid.UUID) -> Dict[str, Any]:
        latest = await self.repo.latest_assessment(account_id)
        account = await self.accounts.get_by_id(account_id)
        identity_row = _identity_state(
            await self.identity.state(account_id),
            normalize_provider(account.provider) if account else None)
        findings = await self.repo.findings_for_account(
            account_id, statuses=ACTIVE_FINDING_STATUSES)
        gaps = [
            {
                "rule_id": f.rule_id,
                "title": f.title,
                "verdict": f.verdict,
                "affected_count": f.affected_count,
                "reason": (f.evidence or {}).get("reason") or f.description,
                "remediation": f.remediation,
            }
            for f in findings if f.verdict in ("UNKNOWN", "NOT_SCANNED")
        ]
        gaps.sort(key=lambda g: -(g["affected_count"] or 1))
        sweep = await self._last_sweep(account_id)
        sources = await self.credentials.sources([account_id])
        return {
            "account_id": str(account_id),
            "overall_pct": latest.coverage_pct if latest else None,
            "dimensions": latest.coverage if latest else None,
            "assessment_outcome": latest.outcome if latest else None,
            "incomplete_reasons": (latest.incomplete_reasons if latest else None),
            "identity_collection": identity_row.to_dict() if identity_row else None,
            "inventory_last_discovered": _iso(account.last_discovery if account else None),
            "gaps": gaps,
            # What the last sweep read, scope by scope, and every permission
            # that would let the next one read the rest.
            "sweep": sweep,
            "permissions": permissions_block(account.provider if account else None,
                                             (sweep or {}).get("scope_summary"), sources),
            "note": (
                "This is a data-availability metric, not a security score. It reports how "
                "much of the information each check needs was actually present. Low "
                "coverage means findings are missing, not that there are none."
            ),
        }

    async def _last_sweep(self, account_id: uuid.UUID) -> Optional[Dict[str, Any]]:
        from app.models.discovery_job import DiscoveryJob

        job = (await self.db.execute(
            select(DiscoveryJob).where(
                DiscoveryJob.account_id == account_id,
                DiscoveryJob.status.in_(["COMPLETED", "FAILED"]))
            .order_by(DiscoveryJob.started_at.desc()).limit(1)
        )).scalar_one_or_none()
        if job is None:
            return None
        return {"job_id": str(job.id), "status": job.status,
                "finished_at": _iso(job.completed_at), "note": job.error_detail,
                "scope_summary": job.scope_summary}

    async def trends(self, account_id: uuid.UUID, *, limit: int = 60) -> Dict[str, Any]:
        rows = await self.repo.assessment_history(account_id, limit=limit)
        rows = list(reversed(rows))
        return {
            "account_id": str(account_id),
            "points": [
                {
                    "at": _iso(r.finished_at),
                    "score": r.score,
                    "grade": r.grade,
                    "reliable": r.score_reliable,
                    "coverage_pct": r.coverage_pct,
                    "outcome": r.outcome,
                    "findings_confirmed": r.findings_confirmed,
                    "findings_undetermined": r.findings_undetermined,
                    "new": r.findings_new_by_run,
                    "resolved": r.findings_resolved_by_run,
                    "by_severity": r.by_severity,
                }
                for r in rows
            ],
            "note": ("Points where reliable=false had too little coverage to score and "
                     "are plotted as gaps, not as zeroes — a break in the line is a break "
                     "in the data, not a collapse in posture."),
        }

    # ── Alerts (scoped to the Security Center) ───────────────────────────────

    async def alerts_feed(
        self, *, account_id: Optional[uuid.UUID] = None,
        states: Optional[Sequence[str]] = None, include_resolved: bool = False,
        limit: int = 200,
    ) -> Dict[str, Any]:
        if states is None:
            states = ([STATE_OPEN, STATE_ACKNOWLEDGED, STATE_RESOLVED]
                      if include_resolved else [STATE_OPEN, STATE_ACKNOWLEDGED])
        rows = await self.alerts.list_alerts(
            account_id=account_id, states=list(states), limit=limit)
        counts = await self.alerts.counts_by_state(account_id)
        return {
            "alerts": [r.to_dict() for r in rows],
            "counts": {
                "open": counts.get(STATE_OPEN, 0),
                "acknowledged": counts.get(STATE_ACKNOWLEDGED, 0),
                "resolved": counts.get(STATE_RESOLVED, 0),
            },
        }

    async def act_on_alert(
        self, alert_id: uuid.UUID, action: str, *, actor: Optional[str],
        reason: Optional[str] = None,
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        alert = await self.alerts.get_by_id(alert_id)
        if alert is None:
            return None, "Alert not found"
        now = datetime.now(timezone.utc)
        if action == "acknowledge":
            alert.state = STATE_ACKNOWLEDGED
            alert.is_read = True
            alert.acknowledged_at = now
            alert.acknowledged_by = actor
        elif action == "resolve":
            alert.state = STATE_RESOLVED
            alert.is_read = True
            alert.resolved_at = now
            alert.resolved_by = actor
            alert.resolution_reason = reason
        elif action == "suppress":
            # Suppressing an alert suppresses its FINDING, so the next
            # assessment does not immediately recreate it. Acting only on the
            # alert would make suppression appear not to work.
            if not (reason or "").strip():
                return None, "A reason is required to suppress an alert."
            alert.state = STATE_RESOLVED
            alert.resolved_at = now
            alert.resolved_by = actor
            alert.resolution_reason = f"Suppressed: {reason}"
            if alert.finding_fingerprint and alert.account_id:
                await self.repo.set_status(
                    account_id=alert.account_id, key=alert.finding_fingerprint,
                    status="SUPPRESSED", reason=reason, actor=actor)
        else:
            return None, f"Unknown action {action!r}"
        await self.db.commit()
        return alert.to_dict(), None

    # ── Policies ─────────────────────────────────────────────────────────────

    async def list_policies(self, account_id: Optional[uuid.UUID]) -> Dict[str, Any]:
        rows = await self.repo.list_policies(account_id)
        return {
            "policies": [r.to_dict() for r in rows],
            "threshold_kinds": [
                {"value": k, "label": v}
                for k, v in _threshold_labels().items()
            ],
            "selectable": {
                "rule_ids": sorted(reg.RULES),
                "categories": sorted({r.category for r in reg.RULES.values()}),
                "severities": list(SEVERITIES),
            },
        }

    async def upsert_policy(
        self, *, policy_id: Optional[uuid.UUID], payload: Dict[str, Any],
        actor: Optional[str],
    ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        from app.models.security_finding import THRESHOLD_KINDS, CloudAlertPolicy

        kind = payload.get("threshold_kind")
        if kind and kind not in THRESHOLD_KINDS:
            return None, f"Unknown threshold kind {kind!r}"
        for rid in payload.get("rule_ids") or []:
            if rid not in reg.RULES:
                return None, f"Unknown rule_id {rid!r}"

        if policy_id:
            row = await self.repo.get_policy(policy_id)
            if row is None:
                return None, "Policy not found"
        else:
            row = CloudAlertPolicy(name=payload.get("name") or "Untitled policy")
            self.db.add(row)

        for field in ("name", "description", "enabled", "providers", "rule_ids",
                      "categories", "resource_types", "min_severity", "ports",
                      "match_verdicts", "threshold_kind", "threshold_value",
                      "alert_severity", "cooldown_minutes", "notify"):
            if field in payload:
                setattr(row, field, payload[field])
        if "account_id" in payload:
            row.account_id = _as_uuid(payload["account_id"])
        row.updated_by = actor
        await self.db.commit()
        return row.to_dict(), None

    async def delete_policy(self, policy_id: uuid.UUID) -> Tuple[bool, Optional[str]]:
        row = await self.repo.get_policy(policy_id)
        if row is None:
            return False, "Policy not found"
        if row.builtin:
            # Deleting a built-in would have it silently reappear on the next
            # boot, which is worse than refusing. Disabling is the supported way
            # to turn one off, and it persists.
            return False, ("Built-in policies cannot be deleted — they are re-seeded on "
                           "startup. Disable it instead; that persists.")
        await self.db.delete(row)
        await self.db.commit()
        return True, None

    # ── Multi-cloud ──────────────────────────────────────────────────────────

    async def multi_cloud(self) -> Dict[str, Any]:
        """Every account side by side (§58, §59), grouped by provider.

        Deliberately does NOT sum the scores into an organisation-wide number.
        Averaging a 35 with a withheld score would produce a figure that no
        account has and that moves when coverage changes rather than when
        posture does.
        """
        accounts = await self.accounts.list_all()
        rows: List[Dict[str, Any]] = []
        for a in accounts:
            latest = await self.repo.latest_assessment(a.id)
            counts = await self.repo.severity_counts([a.id])
            alert_counts = await self.alerts.counts_by_state(a.id)
            state = await self.identity.state(a.id)
            rows.append({
                "account_id": str(a.id),
                "account_name": a.account_name,
                "provider": normalize_provider(a.provider) or a.provider,
                "score": latest.score if latest else None,
                "grade": latest.grade if latest else "Not assessed",
                "score_reliable": latest.score_reliable if latest else False,
                "coverage_pct": latest.coverage_pct if latest else None,
                "assessment_outcome": latest.outcome if latest else None,
                "last_assessed_at": _iso(latest.finished_at) if latest else None,
                "last_discovery": _iso(a.last_discovery),
                "findings_by_severity": counts,
                "active_alerts": (alert_counts.get(STATE_OPEN, 0)
                                  + alert_counts.get(STATE_ACKNOWLEDGED, 0)),
                # AWS and OCI keep identity data in cloud_resources, so neither
                # "NeverRun" nor their NotSupported row describes them — their
                # identity review works. Only Azure needs a separate
                # collection, and only Azure can fail it.
                "identity_collection": _identity_status(
                    state, normalize_provider(a.provider)),
                "resources": latest.resources_evaluated if latest else None,
            })

        by_provider: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            p = by_provider.setdefault(r["provider"], {
                "provider": r["provider"], "accounts": 0, "assessed": 0,
                "critical": 0, "high": 0, "active_alerts": 0, "resources": 0,
                "unassessed_accounts": [],
            })
            p["accounts"] += 1
            if r["score"] is not None:
                p["assessed"] += 1
            else:
                p["unassessed_accounts"].append(r["account_name"])
            p["critical"] += r["findings_by_severity"].get(CRITICAL, 0)
            p["high"] += r["findings_by_severity"].get("HIGH", 0)
            p["active_alerts"] += r["active_alerts"]
            p["resources"] += r["resources"] or 0

        return {
            "accounts": sorted(rows, key=lambda r: (
                r["score"] if r["score"] is not None else 999, r["account_name"])),
            "by_provider": list(by_provider.values()),
            "note": ("No organisation-wide score is reported. Averaging accounts with "
                     "different coverage would produce a number that changes when "
                     "collection changes rather than when posture does."),
        }

    async def diagnostics(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Why the numbers look the way they do (§56)."""
        account = await self.accounts.get_by_id(account_id)
        latest = await self.repo.latest_assessment(account_id)
        state = await self.identity.state(account_id)
        resources = await self.resources.list_by_account(account_id)
        prov = normalize_provider(account.provider) if account else None

        applicable = set()
        for r in resources:
            for rule in reg.rules_for(prov or "", r.resource_type):
                applicable.add(rule.rule_id)

        return {
            "account_id": str(account_id),
            "provider": prov,
            "inventory": _inventory_diagnosis(
                resources, account, await self._last_sweep(account_id)),
            "assessment": {
                "status": latest.outcome if latest else "Never run",
                "last_assessed_at": _iso(latest.finished_at) if latest else None,
                "rules_available": len(reg.RULES),
                "rules_applicable_to_this_inventory": len(applicable),
                "incomplete_reasons": latest.incomplete_reasons if latest else None,
            },
            "identity": _identity_diagnosis(state, prov, resources),
            "coverage": latest.coverage if latest else None,
            "rules_not_applicable": sorted(set(reg.RULES) - applicable),
        }


# ── helpers ──────────────────────────────────────────────────────────────────

# The IAM actions each AWS certificate / secret store's collector calls
# (providers/aws/aws_credentials.py), so a denied store is fixed in one change.
_AWS_CREDENTIAL_ACTIONS = {
    "aws:acm": ("acm:ListCertificates", "acm:DescribeCertificate"),
    "aws:secretsmanager": ("secretsmanager:ListSecrets",),
    "aws:iam-server-certificates": ("iam:ListServerCertificates",),
}


def permissions_block(provider: Optional[str], scope_summary: Optional[Dict[str, Any]],
                      sources: Sequence[Any]) -> Dict[str, Any]:
    """Every permission missing for a complete read of the account, from the
    two places a denial is recorded: the discovery sweep (per service) and the
    certificate / secret stores (per store). For AWS, also the policy that
    grants exactly those actions."""
    from app.models.credential_inventory import COLLECT_PERMISSION_DENIED
    from app.security.credentials import SOURCE_LABEL

    prov = normalize_provider(provider)
    areas: List[Dict[str, Any]] = []
    for label, entry in sorted(((scope_summary or {}).get("denied") or {}).items()):
        areas.append({"area": "Inventory", "item": label,
                      "scopes": len(entry.get("regions") or []),
                      "actions": sorted(entry.get("actions") or [])})
    denied_stores: Dict[str, Dict[str, Any]] = {}
    for s in sources:
        if s.status != COLLECT_PERMISSION_DENIED:
            continue
        entry = denied_stores.setdefault(s.source, {"scopes": 0, "actions": set()})
        entry["scopes"] += 1
        if s.missing_permission:
            entry["actions"].add(s.missing_permission)
    for source, entry in sorted(denied_stores.items()):
        actions = set(entry["actions"])
        if prov == "AWS":
            actions |= set(_AWS_CREDENTIAL_ACTIONS.get(source, ()))
        areas.append({"area": "Certificates & secrets", "item": SOURCE_LABEL.get(source, source),
                      "scopes": entry["scopes"], "actions": sorted(actions)})
    missing = sorted({a for area in areas for a in area["actions"]})
    block: Dict[str, Any] = {"provider": prov, "missing": missing, "areas": areas}
    if prov == "AWS" and missing:
        # List / Describe / Get only: read access, and nothing that returns a
        # secret value (secretsmanager:GetSecretValue is never asked for).
        block["aws_policy"] = {
            "Version": "2012-10-17",
            "Statement": [{"Sid": "ActmonReadAccess", "Effect": "Allow",
                           "Action": missing, "Resource": "*"}],
        }
        block["managed_policy"] = "arn:aws:iam::aws:policy/ReadOnlyAccess"
    return block


def _identity_status(state, provider: Optional[str]) -> str:
    """The honest collection status for an account's identity data.

    AWS reads it from IAMRole rows and OCI from IAMPolicy rows — both are part
    of the inventory the discovery scan already writes, so there is no separate
    collection step to have "never run". Reporting NeverRun for them would
    imply a gap that does not exist, next to Azure's PermissionDenied, which is
    a gap that does.

    Provider first, row second: every scan leaves AWS and OCI a NotSupported
    row ("needs no separate call", from collect_identity), and reading that as
    their status put "identity not collected" beside 39 escalation paths
    derived from the very data it said was missing.
    """
    if provider in (AWS, OCI):
        return COLLECT_OK
    return state.status if state is not None else COLLECT_NEVER_RUN


def _identity_state(state, provider: Optional[str]):
    """The collection-state row where it describes a real collection step —
    Azure's. For AWS and OCI it only says there is no such step, so its
    detail is not an error to show."""
    return None if provider in (AWS, OCI) else state


def _inventory_diagnosis(resources, account, sweep) -> Dict[str, Any]:
    """The Scan status card's inventory row, from what the last finished sweep
    read. It said "Complete" whenever any resource was on file — beside an
    inventory coverage of 80.1%, because a partial sweep keeps what it could
    not re-read rather than pruning it."""
    out: Dict[str, Any] = {
        "resources": len(resources),
        "last_discovery": _iso(account.last_discovery if account else None),
    }
    if sweep is None:
        return {**out, "status": ("No resources collected" if not resources
                                  else "Unknown")}
    if sweep["status"] == "FAILED":
        return {**out, "status": "Failed"}
    s = sweep.get("scope_summary") or {}
    if s.get("attempted"):
        out.update(scopes_read=s.get("read"), scopes_attempted=s["attempted"])
    incomplete = bool(sweep.get("note")) or (
        bool(s.get("attempted")) and (s.get("read") or 0) < s["attempted"]
    ) or bool(s.get("regions_unknown"))
    return {**out, "status": "Partial" if incomplete else "Complete"}


def _identity_diagnosis(state, provider: Optional[str], resources) -> Dict[str, Any]:
    """The Scan status card's identity row. For AWS and OCI: how many
    identities the inventory holds, counted — not a grant count, which is an
    Azure notion and read "0 grants" beside 39 escalation paths."""
    if provider in (AWS, OCI):
        kind = "IAMRole" if provider == AWS else "IAMPolicy"
        n = sum(1 for r in resources if r.resource_type == kind)
        noun = ("IAM role" if n == 1 else "IAM roles") if provider == AWS else (
            "IAM policy" if n == 1 else "IAM policies")
        return {"status": COLLECT_OK, "trustworthy": True, "error_detail": None,
                "missing_permission": None, "identities": n,
                "note": f"{n} {noun}, read with the inventory"}
    if state is not None:
        return state.to_dict()
    return {"status": COLLECT_NEVER_RUN, "trustworthy": False,
            "error_detail": "Identity collection has not been attempted."}


_ESCALATION_RULES = frozenset({
    "AWS_IAM_ROLE_ESCALATION", "OCI_IAM_POLICY_ESCALATION", "AZURE_RBAC_ESCALATION",
})


def _validate_exception(
    *, status: str, category: Optional[str], expires_at: Optional[datetime],
    review_in_days: Optional[int], owner: Optional[str], ticket: Optional[str],
    compensating_controls: Optional[List[str]], compensating_note: Optional[str],
    now: Optional[datetime] = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Check a SUPPRESSED / ACCEPTED_RISK decision; return (exception, error).

    The review date may be given as a date or as days from now. Either way it
    must be in the future and inside the category's window — 180 days for
    network exposure, a year otherwise — because an acceptance with no end is
    the failure this exists to prevent.
    """
    now = now or datetime.now(timezone.utc)
    owner = (owner or "").strip() or None
    ticket = (ticket or "").strip() or None
    note = (compensating_note or "").strip() or None

    if expires_at is None and review_in_days is not None:
        if review_in_days < 1:
            return None, "review_in_days must be at least 1."
        expires_at = now + timedelta(days=review_in_days)
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if status in STATUS_REQUIRES_OWNER_AND_EXPIRY:
        if not owner:
            return None, ("An owner is required to accept a risk: the person or team "
                          "accountable for it while it stays in place.")
        if expires_at is None:
            return None, ("A review date is required to accept a risk (expires_at or "
                          "review_in_days). An acceptance with no end is never revisited.")
    if expires_at is not None:
        if expires_at <= now:
            return None, "The review date must be in the future."
        limit = exception_max_days(category)
        # A day's grace so "180 days" chosen in a browser in another timezone
        # is not refused for being a few hours over.
        if expires_at > now + timedelta(days=limit + 1):
            return None, (f"The review date can be at most {limit} days away for a "
                          f"{category or 'finding'} finding."
                          + (" PCI DSS 4.0 requirement 1.2.7 reviews network security "
                             "controls at least every six months." if limit < 365 else ""))

    controls = [c for c in (compensating_controls or []) if c]
    unknown = [c for c in controls if c not in COMPENSATING_CONTROLS]
    if unknown:
        return None, (f"Unknown compensating control(s): {', '.join(unknown)}. "
                      f"Known: {', '.join(COMPENSATING_CONTROLS)}")

    return {
        "expires_at": expires_at,
        "owner": owner,
        "ticket": ticket,
        "compensating_controls": controls,
        "compensating_note": note,
    }, None


def _exception_summary(findings: Sequence[Any], now: datetime) -> Dict[str, int]:
    """How the account's muted findings stand against their review dates."""
    out = {EXCEPTION_ACTIVE: 0, EXCEPTION_EXPIRING: 0, EXCEPTION_NO_REVIEW_DATE: 0}
    for f in findings:
        state = exception_state(f.status, f.exception_expires_at, now)
        if state:
            out[state] += 1
    return {"active": out[EXCEPTION_ACTIVE], "expiring_soon": out[EXCEPTION_EXPIRING],
            "no_review_date": out[EXCEPTION_NO_REVIEW_DATE]}


def _threshold_labels() -> Dict[str, str]:
    from app.models.security_finding import THRESHOLD_LABEL
    return dict(THRESHOLD_LABEL)


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _as_uuid(value) -> Optional[uuid.UUID]:
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _count_by(items: Sequence[Any], attr: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for i in items:
        k = getattr(i, attr, None) or "Unknown"
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def _no_assessment_score() -> Dict[str, Any]:
    return {
        "score": None,
        "grade": "Not assessed",
        "reliable": False,
        "coverage_pct": None,
        "grade_capped_by": ("No security assessment has been run for this account yet. "
                            "Run one, or trigger a discovery scan, which runs one "
                            "automatically."),
        "breakdown": [],
        "unscored": {},
        "confidence": "unknown",
        "methodology": scoring.METHODOLOGY,
    }


def _exposure_summary_from_findings(active: Sequence[Any]) -> Dict[str, Any]:
    """Exposure counts from persisted findings, for the overview.

    The full picture (paths, per-port verdicts) comes from `exposure()`, which
    recomputes. This is the cheap version for a summary tile — and it counts
    undetermined separately, because a tile reading "0 exposed" over 49
    unevaluated VMs is the failure this whole rewrite was for.
    """
    exp_findings = [f for f in active if f.category == "Exposure"]
    confirmed = [f for f in exp_findings if f.verdict == "VULNERABLE"]
    undet = [f for f in exp_findings if f.verdict in ("UNKNOWN", "NOT_SCANNED")]
    resources = {f.resource_key or f.resource_id for f in confirmed
                 if (f.resource_key or f.resource_id)}
    return {
        "exposed_resources": len(resources),
        "exposure_findings": len(confirmed),
        "undetermined_findings": len(undet),
        "undetermined_resources": sum(f.affected_count or 1 for f in undet),
        "by_severity": {
            sev: sum(1 for f in confirmed if f.severity == sev) for sev in SEVERITIES
        },
        "clean_result_trustworthy": not confirmed and not undet,
    }


def _stored_compliance(assessment) -> Optional[Dict[str, Any]]:
    """Reconstruct enough of a previous compliance result for a trend.

    Only the framework counts are needed, and only those are stored — keeping a
    full previous control list on every assessment row would be a large write
    for a small feature.
    """
    if assessment is None or not assessment.score_breakdown:
        return None
    prev = (assessment.score_breakdown or {}).get("compliance_frameworks")
    return {"frameworks": prev} if prev else None
