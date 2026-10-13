"""Persistence for the identity inventory, its analysis and its workflow.

Separate from `identity_repo.py`, which owns `cloud_identity_grants` — the
Azure role-assignment store the Security Center's identity analyser already
reads. That table keeps its own repository so the existing analyser is
untouched by this work; this one owns the fifteen CIEM tables.

**Replace-with-carry-forward, never delete-then-insert.** A re-collection
updates rows in place and removes only the keys the provider no longer returns,
so `first_seen_at` survives — "this principal has held Owner since March" is
one of the few facts in the product that gets more valuable with age, and a
truncate-and-reload would reset it on every scan.

**A failed collection must never reach the replace path.** Replacing a real
inventory with an empty one turns a permission error into "every identity was
deleted", which would then cascade into resolved findings and a clean
dashboard. The service layer is responsible for not calling `replace_identities`
on a failure; `record_analysis_state` is what it calls instead.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity import (
    CloudIdentity, CloudIdentityCredential, CloudIdentityMembership, CloudIdentityPolicy,
)
from app.models.identity_analysis import (
    ANALYSIS_NEVER_RUN, ANALYSIS_OK, CloudEffectivePermission, CloudIdentityAnalysisState,
    CloudIdentityBaseline, CloudIdentityBlastRadius, CloudIdentityCapability,
    CloudIdentityTrust, CloudPermissionUsage,
)
from app.models.identity_workflow import (
    CloudAccessApproval, CloudAccessRequest, CloudIdentityAuditLog, CloudJitSession,
)

# Columns carried over on an update rather than being reset.
_IDENTITY_FIELDS = (
    "provider_id", "identity_type", "actor_class", "name", "principal_name",
    "description", "path", "status", "created_at_provider", "last_used_at",
    "last_used_source", "last_used_service", "last_used_region", "mfa_state",
    "mfa_detail", "external", "external_detail", "privilege_level", "standing_admin",
    "potential_break_glass", "break_glass_signals", "credential_count",
    "active_credential_count", "policy_count", "group_count", "provider_detail",
    "scope", "compartment_id",
)

_CREDENTIAL_FIELDS = (
    "credential_kind", "fingerprint", "status", "created_at_provider", "expires_at",
    "last_used_at", "never_used", "last_used_service", "last_used_region",
    "recommendation", "recommendation_reason", "provider_detail",
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_datetime(value: Any) -> Optional[datetime]:
    """A datetime, or None. Accepts the ISO strings the analyser's
    `to_dict()` shapes carry, because asyncpg rejects them outright."""
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


class CiemRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Identities ───────────────────────────────────────────────────────────
    async def identities(
        self, account_id: uuid.UUID, *, identity_keys: Optional[Sequence[str]] = None,
    ) -> List[CloudIdentity]:
        stmt = select(CloudIdentity).where(CloudIdentity.account_id == account_id)
        if identity_keys is not None:
            stmt = stmt.where(CloudIdentity.identity_key.in_(list(identity_keys)))
        return list((await self.db.execute(stmt)).scalars().all())

    async def identity_by_key(
        self, account_id: uuid.UUID, identity_key: str,
    ) -> Optional[CloudIdentity]:
        return (await self.db.execute(
            select(CloudIdentity).where(
                CloudIdentity.account_id == account_id,
                CloudIdentity.identity_key == identity_key,
            )
        )).scalar_one_or_none()

    async def identity_by_id(self, identity_id: uuid.UUID) -> Optional[CloudIdentity]:
        return await self.db.get(CloudIdentity, identity_id)

    async def replace_identities(
        self, *, account_id: uuid.UUID, provider: str,
        identities: Sequence[Dict[str, Any]], prune: bool = True,
    ) -> Dict[str, uuid.UUID]:
        """Upsert the collected principals; return `{identity_key: row id}`.

        `prune=False` is for a PARTIAL collection, where an absent principal
        means "this page failed", not "it was deleted" — the same rule the
        inventory prune learned after a partially-failed scan removed 62 live
        OCI resources.
        """
        now = _now()
        existing = {i.identity_key: i for i in await self.identities(account_id)}
        seen: Dict[str, uuid.UUID] = {}

        for spec in identities:
            key = spec.get("identity_key")
            if not key:
                continue
            row = existing.get(key)
            new = row is None
            if new:
                row = CloudIdentity(
                    account_id=account_id, provider=provider, identity_key=key,
                    first_seen_at=now, last_seen_at=now,
                )
            # Fields are set BEFORE the flush, not after. `provider_id` is NOT
            # NULL, and flushing a half-built row to get its id writes a null
            # into it — the ordering bug `verify_identity_api.py` caught.
            for field in _IDENTITY_FIELDS:
                if field in spec:
                    setattr(row, field, spec[field])
            row.provider = provider
            row.last_seen_at = now
            if new:
                self.db.add(row)
                # Flushed per row because the caller needs the generated id to
                # attach this principal's credentials and policies.
                await self.db.flush()
            seen[key] = row.id

        if prune:
            stale = [k for k in existing if k not in seen]
            if stale:
                # Marked DELETED rather than removed: a finding pointing at an
                # identity that has gone needs the row to resolve against, and
                # the audit trail needs it to stay resolvable by name.
                await self.db.execute(
                    update(CloudIdentity)
                    .where(CloudIdentity.account_id == account_id,
                           CloudIdentity.identity_key.in_(stale))
                    .values(status="DELETED", last_seen_at=now)
                )
        await self.db.flush()
        return seen

    async def replace_credentials(
        self, *, account_id: uuid.UUID, provider: str, identity_id: uuid.UUID,
        credentials: Sequence[Dict[str, Any]],
    ) -> int:
        now = _now()
        existing = {
            c.credential_ref: c for c in (await self.db.execute(
                select(CloudIdentityCredential).where(
                    CloudIdentityCredential.identity_id == identity_id)
            )).scalars().all()
        }
        seen = set()
        for spec in credentials:
            ref = spec.get("credential_ref")
            if not ref:
                continue
            seen.add(ref)
            row = existing.get(ref)
            if row is None:
                row = CloudIdentityCredential(
                    account_id=account_id, identity_id=identity_id, provider=provider,
                    credential_ref=ref, first_seen_at=now, last_seen_at=now,
                )
                self.db.add(row)
            for field in _CREDENTIAL_FIELDS:
                if field in spec:
                    setattr(row, field, spec[field])
            row.last_seen_at = now
        stale = [r for r in existing if r not in seen]
        if stale:
            await self.db.execute(delete(CloudIdentityCredential).where(
                CloudIdentityCredential.identity_id == identity_id,
                CloudIdentityCredential.credential_ref.in_(stale),
            ))
        await self.db.flush()
        return len(seen)

    async def credentials(
        self, *, account_id: uuid.UUID, identity_id: Optional[uuid.UUID] = None,
    ) -> List[CloudIdentityCredential]:
        stmt = select(CloudIdentityCredential).where(
            CloudIdentityCredential.account_id == account_id)
        if identity_id:
            stmt = stmt.where(CloudIdentityCredential.identity_id == identity_id)
        return list((await self.db.execute(stmt)).scalars().all())

    async def replace_policies(
        self, *, account_id: uuid.UUID, provider: str,
        policies: Sequence[Dict[str, Any]],
    ) -> int:
        now = _now()
        await self.db.execute(delete(CloudIdentityPolicy).where(
            CloudIdentityPolicy.account_id == account_id))
        for spec in policies:
            self.db.add(CloudIdentityPolicy(
                account_id=account_id, provider=provider,
                identity_id=spec.get("identity_id"),
                policy_key=spec.get("policy_key") or "",
                policy_name=spec.get("policy_name"),
                policy_stage=spec.get("policy_stage") or "identity_policy",
                policy_type=spec.get("policy_type"),
                scope=spec.get("scope"), scope_level=spec.get("scope_level"),
                document=spec.get("document"),
                allow_actions=spec.get("allow_actions"),
                deny_actions=spec.get("deny_actions"),
                capabilities=spec.get("capabilities"),
                parse_failed=bool(spec.get("parse_failed")),
                parse_error=spec.get("parse_error"),
                first_seen_at=now, last_seen_at=now,
            ))
        await self.db.flush()
        return len(policies)

    async def policies(
        self, *, account_id: uuid.UUID, identity_id: Optional[uuid.UUID] = None,
        stage: Optional[str] = None,
    ) -> List[CloudIdentityPolicy]:
        stmt = select(CloudIdentityPolicy).where(
            CloudIdentityPolicy.account_id == account_id)
        if identity_id:
            stmt = stmt.where(CloudIdentityPolicy.identity_id == identity_id)
        if stage:
            stmt = stmt.where(CloudIdentityPolicy.policy_stage == stage)
        return list((await self.db.execute(stmt)).scalars().all())

    async def replace_memberships(
        self, *, account_id: uuid.UUID, memberships: Sequence[Dict[str, Any]],
    ) -> int:
        now = _now()
        await self.db.execute(delete(CloudIdentityMembership).where(
            CloudIdentityMembership.account_id == account_id))
        for spec in memberships:
            self.db.add(CloudIdentityMembership(
                account_id=account_id,
                member_identity_id=spec["member_identity_id"],
                container_identity_id=spec["container_identity_id"],
                membership_kind=spec.get("membership_kind") or "GROUP_MEMBER",
                match_rule=spec.get("match_rule"),
                first_seen_at=now, last_seen_at=now,
            ))
        await self.db.flush()
        return len(memberships)

    async def memberships(
        self, account_id: uuid.UUID,
    ) -> List[CloudIdentityMembership]:
        return list((await self.db.execute(
            select(CloudIdentityMembership).where(
                CloudIdentityMembership.account_id == account_id)
        )).scalars().all())

    # ── Analysis ─────────────────────────────────────────────────────────────
    async def replace_effective_permissions(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID,
        rows: Sequence[Dict[str, Any]], run_id: Optional[uuid.UUID] = None,
    ) -> int:
        await self.db.execute(delete(CloudEffectivePermission).where(
            CloudEffectivePermission.identity_id == identity_id))
        now = _now()
        for spec in rows:
            self.db.add(CloudEffectivePermission(
                account_id=account_id, identity_id=identity_id,
                provider=spec.get("provider") or "",
                action_pattern=spec.get("action_pattern") or "",
                capability=spec.get("capability"),
                resource_pattern=spec.get("resource_pattern"),
                decision=spec.get("decision") or "NOT_DETERMINED",
                conditional=bool(spec.get("conditional")),
                conditions=spec.get("conditions"),
                source_stage=spec.get("source_stage") or "identity_policy",
                source_name=spec.get("source_name"), source_key=spec.get("source_key"),
                statement_id=spec.get("statement_id"),
                inherited=bool(spec.get("inherited")),
                inherited_from=spec.get("inherited_from"),
                steps=spec.get("steps"), unevaluated=spec.get("unevaluated"),
                computed_at=now, analysis_run_id=run_id,
            ))
        await self.db.flush()
        return len(rows)

    async def effective_permissions(
        self, identity_id: uuid.UUID, *, decisions: Optional[Sequence[str]] = None,
    ) -> List[CloudEffectivePermission]:
        stmt = select(CloudEffectivePermission).where(
            CloudEffectivePermission.identity_id == identity_id)
        if decisions:
            stmt = stmt.where(CloudEffectivePermission.decision.in_(list(decisions)))
        return list((await self.db.execute(stmt)).scalars().all())

    async def replace_capabilities(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID,
        rows: Sequence[Dict[str, Any]],
    ) -> int:
        await self.db.execute(delete(CloudIdentityCapability).where(
            CloudIdentityCapability.identity_id == identity_id))
        now = _now()
        for spec in rows:
            self.db.add(CloudIdentityCapability(
                account_id=account_id, identity_id=identity_id,
                provider=spec.get("provider") or "",
                capability=spec["capability"],
                high_impact=bool(spec.get("high_impact")),
                scope_level=spec.get("scope_level"), scope=spec.get("scope"),
                evidence_actions=spec.get("evidence_actions"),
                source_names=spec.get("source_names"),
                certain=bool(spec.get("certain", True)),
                computed_at=now,
            ))
        await self.db.flush()
        return len(rows)

    async def capabilities(
        self, *, account_id: uuid.UUID, identity_id: Optional[uuid.UUID] = None,
        capability: Optional[str] = None, high_impact_only: bool = False,
    ) -> List[CloudIdentityCapability]:
        stmt = select(CloudIdentityCapability).where(
            CloudIdentityCapability.account_id == account_id)
        if identity_id:
            stmt = stmt.where(CloudIdentityCapability.identity_id == identity_id)
        if capability:
            stmt = stmt.where(CloudIdentityCapability.capability == capability)
        if high_impact_only:
            stmt = stmt.where(CloudIdentityCapability.high_impact.is_(True))
        return list((await self.db.execute(stmt)).scalars().all())

    async def replace_usage(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID,
        rows: Sequence[Dict[str, Any]],
    ) -> int:
        await self.db.execute(delete(CloudPermissionUsage).where(
            CloudPermissionUsage.identity_id == identity_id))
        now = _now()
        for spec in rows:
            self.db.add(CloudPermissionUsage(
                account_id=account_id, identity_id=identity_id,
                provider=spec.get("provider") or "",
                action=spec.get("action") or "",
                capability=spec.get("capability"),
                usage_state=spec.get("usage_state") or "UNKNOWN",
                event_count=spec.get("event_count") or 0,
                success_count=spec.get("success_count") or 0,
                first_observed_at=spec.get("first_observed_at"),
                last_observed_at=spec.get("last_observed_at"),
                distinct_resources=spec.get("distinct_resources") or 0,
                regions=spec.get("regions"),
                window_start=spec["window_start"], window_end=spec["window_end"],
                window_days=spec["window_days"],
                events_in_window=spec.get("events_in_window") or 0,
                confidence_reason=spec.get("confidence_reason"),
                computed_at=now,
            ))
        await self.db.flush()
        return len(rows)

    async def usage(self, identity_id: uuid.UUID) -> List[CloudPermissionUsage]:
        return list((await self.db.execute(
            select(CloudPermissionUsage).where(
                CloudPermissionUsage.identity_id == identity_id)
        )).scalars().all())

    async def replace_trust(
        self, *, account_id: uuid.UUID, provider: str,
        edges: Sequence[Dict[str, Any]],
    ) -> int:
        now = _now()
        existing = {
            (t.target_key, t.source_principal, t.trust_kind): t
            for t in (await self.db.execute(
                select(CloudIdentityTrust).where(
                    CloudIdentityTrust.account_id == account_id)
            )).scalars().all()
        }
        seen = set()
        for spec in edges:
            key = (spec.get("target_key") or "", spec.get("source_principal") or "",
                   spec.get("trust_kind") or "")
            seen.add(key)
            row = existing.get(key)
            if row is None:
                row = CloudIdentityTrust(
                    account_id=account_id, provider=provider,
                    target_key=key[0], source_principal=key[1], trust_kind=key[2],
                    first_seen_at=now,
                )
                self.db.add(row)
            for field in ("target_identity_id", "target_name", "source_account",
                          "source_type", "external", "conditions", "has_external_id",
                          "has_mfa_condition", "target_privilege", "last_used_at",
                          "evidence"):
                if field in spec:
                    setattr(row, field, spec[field])
            row.last_seen_at = now
        stale = [k for k in existing if k not in seen]
        for key in stale:
            await self.db.execute(delete(CloudIdentityTrust).where(
                CloudIdentityTrust.account_id == account_id,
                CloudIdentityTrust.target_key == key[0],
                CloudIdentityTrust.source_principal == key[1],
                CloudIdentityTrust.trust_kind == key[2],
            ))
        await self.db.flush()
        return len(seen)

    async def trust_edges(
        self, account_id: uuid.UUID, *, external_only: bool = False,
    ) -> List[CloudIdentityTrust]:
        stmt = select(CloudIdentityTrust).where(
            CloudIdentityTrust.account_id == account_id)
        if external_only:
            stmt = stmt.where(CloudIdentityTrust.external.in_(["EXTERNAL", "ANONYMOUS"]))
        return list((await self.db.execute(stmt)).scalars().all())

    async def upsert_blast_radius(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID, provider: str,
        data: Dict[str, Any],
    ) -> CloudIdentityBlastRadius:
        row = await self.db.get(CloudIdentityBlastRadius, identity_id)
        if row is None:
            row = CloudIdentityBlastRadius(identity_id=identity_id,
                                           account_id=account_id, provider=provider)
            self.db.add(row)
        caps = data.get("capabilities") or {}
        row.account_id = account_id
        row.provider = provider
        row.direct_resources = data.get("direct_resources") or 0
        row.indirect_resources = data.get("indirect_resources") or 0
        row.accounts_reachable = data.get("accounts_reachable") or 0
        row.regions_reachable = data.get("regions_reachable") or 0
        row.sensitive_resources = data.get("sensitive_resources") or 0
        row.privileged_roles_assumable = data.get("privileged_roles_assumable") or 0
        row.can_modify_iam = bool(caps.get("can_modify_iam"))
        row.can_modify_network = bool(caps.get("can_modify_network"))
        row.can_delete_data = bool(caps.get("can_delete_data"))
        row.can_create_credentials = bool(caps.get("can_create_credentials"))
        row.can_modify_logging = bool(caps.get("can_modify_logging"))
        row.can_manage_keys = bool(caps.get("can_manage_keys"))
        row.score = data.get("score")
        row.score_band = data.get("score_band")
        row.resources_evaluated = data.get("resources_evaluated") or 0
        row.inventory_complete = bool(data.get("inventory_complete"))
        row.coverage_note = data.get("coverage_note")
        row.by_service = data.get("by_service")
        row.by_resource_type = data.get("by_resource_type")
        row.sample_resources = data.get("sample_resources")
        row.paths = data.get("paths")
        row.computed_at = _now()
        await self.db.flush()
        return row

    async def blast_radius(
        self, identity_id: uuid.UUID,
    ) -> Optional[CloudIdentityBlastRadius]:
        return await self.db.get(CloudIdentityBlastRadius, identity_id)

    async def top_blast_radius(
        self, account_id: uuid.UUID, *, limit: int = 10,
    ) -> List[CloudIdentityBlastRadius]:
        return list((await self.db.execute(
            select(CloudIdentityBlastRadius)
            .where(CloudIdentityBlastRadius.account_id == account_id,
                   CloudIdentityBlastRadius.score.isnot(None))
            .order_by(CloudIdentityBlastRadius.score.desc())
            .limit(limit)
        )).scalars().all())

    async def upsert_baseline(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID, provider: str,
        data: Dict[str, Any],
    ) -> CloudIdentityBaseline:
        row = await self.db.get(CloudIdentityBaseline, identity_id)
        if row is None:
            row = CloudIdentityBaseline(identity_id=identity_id, account_id=account_id,
                                        provider=provider,
                                        baseline_start=data["window"]["start"],
                                        baseline_end=data["window"]["end"],
                                        baseline_days=data["window"]["days"])
            self.db.add(row)
        window = data.get("window") or {}
        # `Baseline.to_dict()` renders its window as ISO strings for the API;
        # these columns are DateTime. Coerced here rather than at every call
        # site, because asyncpg rejects the string outright and the failure
        # lands mid-analysis rather than at the boundary.
        row.baseline_start = _as_datetime(window.get("start")) or row.baseline_start
        row.baseline_end = _as_datetime(window.get("end")) or row.baseline_end
        row.baseline_days = window.get("days") or row.baseline_days
        row.event_count = window.get("event_count") or 0
        row.services = data.get("services")
        row.regions = data.get("regions")
        row.capabilities = data.get("capabilities")
        row.source_ips = data.get("source_networks")
        row.median_daily_events = data.get("median_daily_events")
        row.p95_daily_events = data.get("p95_daily_events")
        row.sufficient = bool(data.get("sufficient"))
        row.insufficient_reason = data.get("insufficient_reason")
        row.computed_at = _now()
        await self.db.flush()
        return row

    async def baseline(self, identity_id: uuid.UUID) -> Optional[CloudIdentityBaseline]:
        return await self.db.get(CloudIdentityBaseline, identity_id)

    # ── Analysis state ───────────────────────────────────────────────────────
    async def analysis_state(
        self, account_id: uuid.UUID,
    ) -> Optional[CloudIdentityAnalysisState]:
        return await self.db.get(CloudIdentityAnalysisState, account_id)

    async def record_analysis_state(
        self, *, account_id: uuid.UUID, provider: str, status: str, **fields: Any,
    ) -> CloudIdentityAnalysisState:
        now = _now()
        row = await self.analysis_state(account_id)
        if row is None:
            row = CloudIdentityAnalysisState(account_id=account_id, provider=provider)
            self.db.add(row)
        row.provider = provider
        row.status = status
        row.last_attempt_at = now
        for field, value in fields.items():
            if hasattr(row, field):
                setattr(row, field, value)
        if status == ANALYSIS_OK:
            row.last_success_at = now
        await self.db.flush()
        return row

    # ── Workflow ─────────────────────────────────────────────────────────────
    async def create_request(self, **fields: Any) -> CloudAccessRequest:
        row = CloudAccessRequest(**fields)
        self.db.add(row)
        await self.db.flush()
        return row

    async def request(self, request_id: uuid.UUID) -> Optional[CloudAccessRequest]:
        return await self.db.get(CloudAccessRequest, request_id)

    async def requests(
        self, *, account_id: Optional[uuid.UUID] = None,
        statuses: Optional[Sequence[str]] = None,
        identity_id: Optional[uuid.UUID] = None,
        kind: Optional[str] = None, limit: int = 100, offset: int = 0,
    ) -> List[CloudAccessRequest]:
        stmt = select(CloudAccessRequest)
        if account_id:
            stmt = stmt.where(CloudAccessRequest.account_id == account_id)
        if statuses:
            stmt = stmt.where(CloudAccessRequest.status.in_(list(statuses)))
        if identity_id:
            stmt = stmt.where(CloudAccessRequest.identity_id == identity_id)
        if kind:
            stmt = stmt.where(CloudAccessRequest.request_kind == kind)
        stmt = stmt.order_by(CloudAccessRequest.requested_at.desc()) \
                   .limit(limit).offset(offset)
        return list((await self.db.execute(stmt)).scalars().all())

    async def add_approval(self, **fields: Any) -> CloudAccessApproval:
        row = CloudAccessApproval(**fields)
        self.db.add(row)
        await self.db.flush()
        return row

    async def approvals(self, request_id: uuid.UUID) -> List[CloudAccessApproval]:
        return list((await self.db.execute(
            select(CloudAccessApproval)
            .where(CloudAccessApproval.request_id == request_id)
            .order_by(CloudAccessApproval.decided_at)
        )).scalars().all())

    async def create_session(self, **fields: Any) -> CloudJitSession:
        row = CloudJitSession(**fields)
        self.db.add(row)
        await self.db.flush()
        return row

    async def session(self, session_id: uuid.UUID) -> Optional[CloudJitSession]:
        return await self.db.get(CloudJitSession, session_id)

    async def sessions(
        self, *, account_id: Optional[uuid.UUID] = None,
        statuses: Optional[Sequence[str]] = None, limit: int = 100,
    ) -> List[CloudJitSession]:
        stmt = select(CloudJitSession)
        if account_id:
            stmt = stmt.where(CloudJitSession.account_id == account_id)
        if statuses:
            stmt = stmt.where(CloudJitSession.status.in_(list(statuses)))
        return list((await self.db.execute(
            stmt.order_by(CloudJitSession.expires_at.desc()).limit(limit)
        )).scalars().all())

    async def due_sessions(self, *, now: Optional[datetime] = None,
                           limit: int = 200) -> List[CloudJitSession]:
        """Sessions whose expiry has passed and whose revocation is unconfirmed.

        This is the query the expiry worker runs. It deliberately selects on
        `revoke_confirmed_at IS NULL` rather than on status: a session marked
        EXPIRED whose revocation failed is exactly the row that must keep being
        retried, and filtering by status would drop it.
        """
        moment = now or _now()
        return list((await self.db.execute(
            select(CloudJitSession)
            .where(CloudJitSession.expires_at <= moment,
                   CloudJitSession.revoke_confirmed_at.is_(None),
                   CloudJitSession.status.notin_(["REJECTED", "CANCELLED"]))
            .order_by(CloudJitSession.expires_at)
            .limit(limit)
        )).scalars().all())

    async def audit(self, **fields: Any) -> CloudIdentityAuditLog:
        row = CloudIdentityAuditLog(**fields)
        self.db.add(row)
        await self.db.flush()
        return row

    async def audit_log(
        self, *, account_id: Optional[uuid.UUID] = None,
        identity_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None, limit: int = 100, offset: int = 0,
    ) -> List[CloudIdentityAuditLog]:
        stmt = select(CloudIdentityAuditLog)
        if account_id:
            stmt = stmt.where(CloudIdentityAuditLog.account_id == account_id)
        if identity_id:
            stmt = stmt.where(CloudIdentityAuditLog.identity_id == identity_id)
        if request_id:
            stmt = stmt.where(CloudIdentityAuditLog.request_id == request_id)
        return list((await self.db.execute(
            stmt.order_by(CloudIdentityAuditLog.at.desc()).limit(limit).offset(offset)
        )).scalars().all())

    # ── Aggregates for the dashboard ─────────────────────────────────────────
    async def counts(self, account_id: uuid.UUID) -> Dict[str, int]:
        """Dashboard tiles, computed in SQL.

        Every count is of identities that were ACTUALLY ASSESSED — the
        privilege filters exclude UNKNOWN rather than treating it as low, which
        is what keeps "0 privileged identities" from being a lie about an
        account whose policies were never read.
        """
        base = CloudIdentity.account_id == account_id
        live = and_(base, CloudIdentity.status != "DELETED")

        async def count(*conditions: Any) -> int:
            return int((await self.db.execute(
                select(func.count()).select_from(CloudIdentity).where(*conditions)
            )).scalar() or 0)

        total = await count(live)
        unknown = await count(live, CloudIdentity.privilege_level == "UNKNOWN")
        privileged = await count(live,
                                 CloudIdentity.privilege_level.in_(["ADMIN", "PRIVILEGED"]))
        admin = await count(live, CloudIdentity.privilege_level == "ADMIN")
        standing = await count(live, CloudIdentity.standing_admin.is_(True))
        mfa_gap = await count(live, CloudIdentity.mfa_state == "DISABLED")
        mfa_unknown = await count(live, CloudIdentity.mfa_state == "UNKNOWN",
                                  CloudIdentity.actor_class == "HUMAN")
        external = await count(live, CloudIdentity.external.in_(["EXTERNAL", "ANONYMOUS"]))
        break_glass = await count(live, CloudIdentity.potential_break_glass.is_(True))

        stale_credentials = int((await self.db.execute(
            select(func.count()).select_from(CloudIdentityCredential).where(
                CloudIdentityCredential.account_id == account_id,
                CloudIdentityCredential.recommendation.in_(["ROTATE", "DISABLE", "DELETE"]),
            )
        )).scalar() or 0)

        high_blast = int((await self.db.execute(
            select(func.count()).select_from(CloudIdentityBlastRadius).where(
                CloudIdentityBlastRadius.account_id == account_id,
                CloudIdentityBlastRadius.score_band.in_(["CRITICAL", "HIGH"]),
            )
        )).scalar() or 0)

        return {
            "identities": total,
            "assessed": total - unknown,
            "not_assessed": unknown,
            "privileged": privileged,
            "admin": admin,
            "standing_admin": standing,
            "mfa_gaps": mfa_gap,
            "mfa_unknown": mfa_unknown,
            "external": external,
            "potential_break_glass": break_glass,
            "stale_credentials": stale_credentials,
            "high_blast_radius": high_blast,
        }
