"""Read paths for Identity & Access: the dashboard, the table, and the queries.

Split from `identity_service.py` for the reason `resource_query_service` is
split from `resource_service`: writing and reading have different shapes, and
the read side is where filtering, faceting, paging and the §34 performance
rules live.

Three rules govern everything here.

**Filter and page in SQL, never in Python.** The UI must not download the
identity estate (§34), so the table query is a single filtered, ordered,
limited statement, and the counts come from `COUNT(*)` rather than from
`len(rows)`.

**Every count is of identities that were ACTUALLY ASSESSED.** A principal whose
policies could not be read is `PRIV_UNKNOWN`, and it is reported in its own
`not_assessed` number rather than being swept into the denominator of
"privileged identities". The dashboard shows both, so a reassuring number can
never be read without the coverage beside it.

**The explorer computes, the dashboard reads.** `can_do` and `who_can_access`
are the only methods that evaluate anything, and they evaluate exactly one
question. Everything else reads what `analyze` materialised.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import Select, and_, desc, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.identity import engine, trust as trust_mod
from app.identity.capability import catalog as capability_catalog, covers
from app.identity.model import (
    ACTOR_HUMAN, AWS, AZURE, DECISIONS_PERMISSIVE, HIGH_IMPACT_CAPABILITIES, OCI,
    PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_UNKNOWN, meta as model_meta, normalize_provider,
)
from app.models.cloud_account import CloudAccount
from app.models.identity import (
    CloudIdentity, CloudIdentityCredential, CloudIdentityMembership, CloudIdentityPolicy,
)
from app.models.identity_analysis import (
    ANALYSIS_NEVER_RUN, CloudEffectivePermission, CloudIdentityAnalysisState,
    CloudIdentityBlastRadius, CloudIdentityCapability, CloudIdentityTrust,
    CloudPermissionUsage,
)
from app.repository.ciem_repo import CiemRepository

logger = logging.getLogger("cloud_svc.identity.query")

MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50

SORTABLE = {
    "name": CloudIdentity.name,
    "privilege": CloudIdentity.privilege_level,
    "last_used": CloudIdentity.last_used_at,
    "type": CloudIdentity.identity_type,
    "mfa": CloudIdentity.mfa_state,
    "credentials": CloudIdentity.active_credential_count,
    "created": CloudIdentity.created_at_provider,
}


class IdentityQueryService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = CiemRepository(db)

    # ── Dashboard ────────────────────────────────────────────────────────────
    async def overview(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """The §20 dashboard: tiles, coverage, and the lists worth acting on."""
        state = await self.repo.analysis_state(account_id)
        counts = await self.repo.counts(account_id)

        top_blast = await self.repo.top_blast_radius(account_id, limit=10)
        blast_ids = [b.identity_id for b in top_blast]
        blast_names = await self._names(blast_ids)

        trust_rows = await self.repo.trust_edges(account_id)
        trust_summary = trust_mod.summarize([
            trust_mod.TrustEdge(
                provider=t.provider, target_key=t.target_key,
                source_principal=t.source_principal, trust_kind=t.trust_kind,
                target_name=t.target_name, source_account=t.source_account,
                external=t.external, has_external_id=t.has_external_id,
                has_mfa_condition=t.has_mfa_condition,
                target_privilege=t.target_privilege,
            ) for t in trust_rows
        ])

        utilization = await self._utilization(account_id)
        capability_counts = await self._capability_counts(account_id)

        return {
            "account_id": str(account_id),
            "analysis": state.to_dict() if state else {
                "status": ANALYSIS_NEVER_RUN, "trustworthy": False,
                "note": "The identity analysis has never run for this account. "
                        "Nothing below is a statement about the estate.",
            },
            "counts": counts,
            # Stated next to every count so a small number is never read as
            # good news over an account whose policies could not be read.
            "coverage": {
                "assessed": counts["assessed"],
                "not_assessed": counts["not_assessed"],
                "percent": (round(100.0 * counts["assessed"] / counts["identities"], 1)
                            if counts["identities"] else None),
                "note": ("Privilege counts are of identities whose permissions were "
                         "actually evaluated. Identities that could not be assessed are "
                         "counted separately and are never treated as unprivileged."),
            },
            "top_blast_radius": [
                {**b.to_dict(), "identity_name": blast_names.get(b.identity_id)}
                for b in top_blast
            ],
            "trust": trust_summary,
            "permission_utilization": utilization,
            "capabilities": capability_counts,
        }

    async def _utilization(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Granted-versus-observed across the account, with its window.

        Returns nulls, not zeros, when no usage rows exist: "0% utilized" over
        an account with no audit trail would be a fabricated statistic.
        """
        total = int((await self.db.execute(
            select(func.count()).select_from(CloudPermissionUsage)
            .where(CloudPermissionUsage.account_id == account_id)
        )).scalar() or 0)
        if not total:
            return {
                "observed": None, "not_observed": None, "unknown": None,
                "percent": None, "window": None,
                "note": "No permission-usage rows exist for this account. Run the "
                        "identity analysis, and confirm the Event Log is collecting.",
            }

        by_state: Dict[str, int] = {}
        for state, count in (await self.db.execute(
            select(CloudPermissionUsage.usage_state, func.count())
            .where(CloudPermissionUsage.account_id == account_id)
            .group_by(CloudPermissionUsage.usage_state)
        )).all():
            by_state[state] = int(count)

        sample = (await self.db.execute(
            select(CloudPermissionUsage.window_start, CloudPermissionUsage.window_end,
                   CloudPermissionUsage.window_days,
                   CloudPermissionUsage.events_in_window)
            .where(CloudPermissionUsage.account_id == account_id).limit(1)
        )).first()

        observed = by_state.get("OBSERVED", 0)
        return {
            "observed": observed,
            "not_observed_high": by_state.get("NOT_OBSERVED_HIGH_CONFIDENCE", 0),
            "not_observed_low": by_state.get("NOT_OBSERVED_LOW_CONFIDENCE", 0),
            "unknown": by_state.get("UNKNOWN", 0),
            "total": total,
            "percent": round(100.0 * observed / total, 1) if total else None,
            "window": {
                "start": sample[0].isoformat() if sample and sample[0] else None,
                "end": sample[1].isoformat() if sample and sample[1] else None,
                "days": sample[2] if sample else None,
                "events_in_window": sample[3] if sample else None,
            } if sample else None,
        }

    async def _capability_counts(self, account_id: uuid.UUID) -> List[Dict[str, Any]]:
        rows = (await self.db.execute(
            select(CloudIdentityCapability.capability,
                   CloudIdentityCapability.high_impact,
                   func.count(func.distinct(CloudIdentityCapability.identity_id)))
            .where(CloudIdentityCapability.account_id == account_id)
            .group_by(CloudIdentityCapability.capability,
                      CloudIdentityCapability.high_impact)
        )).all()
        return sorted(
            [{"capability": c, "high_impact": bool(h), "identities": int(n)}
             for c, h, n in rows],
            key=lambda r: (not r["high_impact"], -r["identities"]),
        )

    # ── The identity table ───────────────────────────────────────────────────
    async def list_identities(
        self, account_id: uuid.UUID, *,
        q: Optional[str] = None,
        identity_types: Optional[Sequence[str]] = None,
        actor_classes: Optional[Sequence[str]] = None,
        privilege_levels: Optional[Sequence[str]] = None,
        mfa_states: Optional[Sequence[str]] = None,
        external: Optional[Sequence[str]] = None,
        standing_admin: Optional[bool] = None,
        dormant_days: Optional[int] = None,
        capability: Optional[str] = None,
        high_impact_only: bool = False,
        blast_band: Optional[Sequence[str]] = None,
        include_deleted: bool = False,
        sort: str = "privilege",
        direction: str = "asc",
        page: int = 1,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> Dict[str, Any]:
        """The §21 table. Filtered, sorted and paged in SQL."""
        size = max(1, min(page_size, MAX_PAGE_SIZE))
        offset = max(0, (max(1, page) - 1) * size)

        conditions: List[Any] = [CloudIdentity.account_id == account_id]
        if not include_deleted:
            conditions.append(CloudIdentity.status != "DELETED")
        if q:
            like = f"%{q.strip()}%"
            conditions.append(or_(
                CloudIdentity.name.ilike(like),
                CloudIdentity.principal_name.ilike(like),
                CloudIdentity.provider_id.ilike(like),
            ))
        if identity_types:
            conditions.append(CloudIdentity.identity_type.in_(list(identity_types)))
        if actor_classes:
            conditions.append(CloudIdentity.actor_class.in_(list(actor_classes)))
        if privilege_levels:
            conditions.append(CloudIdentity.privilege_level.in_(list(privilege_levels)))
        if mfa_states:
            conditions.append(CloudIdentity.mfa_state.in_(list(mfa_states)))
        if external:
            conditions.append(CloudIdentity.external.in_(list(external)))
        if standing_admin is not None:
            conditions.append(CloudIdentity.standing_admin.is_(standing_admin))
        if dormant_days:
            cutoff = datetime.now(timezone.utc) - timedelta(days=dormant_days)
            # Deliberately NOT `OR last_used_at IS NULL`: a null means the
            # provider did not report it, and including those would present
            # "unknown" as "dormant", which is the §35 failure this whole
            # feature is built to avoid. Unknowns are their own filter.
            conditions.append(and_(CloudIdentity.last_used_at.isnot(None),
                                   CloudIdentity.last_used_at < cutoff))

        stmt = select(CloudIdentity).where(*conditions)

        if capability or high_impact_only:
            sub = select(CloudIdentityCapability.identity_id).where(
                CloudIdentityCapability.account_id == account_id)
            if capability:
                sub = sub.where(CloudIdentityCapability.capability == capability)
            if high_impact_only:
                sub = sub.where(CloudIdentityCapability.high_impact.is_(True))
            stmt = stmt.where(CloudIdentity.id.in_(sub))

        if blast_band:
            sub = select(CloudIdentityBlastRadius.identity_id).where(
                CloudIdentityBlastRadius.account_id == account_id,
                CloudIdentityBlastRadius.score_band.in_(list(blast_band)))
            stmt = stmt.where(CloudIdentity.id.in_(sub))

        total = int((await self.db.execute(
            select(func.count()).select_from(stmt.subquery())
        )).scalar() or 0)

        column = SORTABLE.get(sort, CloudIdentity.privilege_level)
        order = column.desc() if direction == "desc" else column.asc()
        rows = list((await self.db.execute(
            stmt.order_by(order, CloudIdentity.name.asc()).limit(size).offset(offset)
        )).scalars().all())

        ids = [r.id for r in rows]
        blast = {
            b.identity_id: b for b in (await self.db.execute(
                select(CloudIdentityBlastRadius).where(
                    CloudIdentityBlastRadius.identity_id.in_(ids))
            )).scalars().all()
        } if ids else {}
        caps = await self._capabilities_for(ids)
        usage = await self._usage_summary_for(ids)

        return {
            "total": total,
            "page": max(1, page),
            "page_size": size,
            "pages": (total + size - 1) // size if size else 0,
            "items": [
                self._row(r, blast.get(r.id), caps.get(r.id, []), usage.get(r.id))
                for r in rows
            ],
        }

    def _row(self, identity: CloudIdentity, blast: Any,
             capabilities: Sequence[str], usage: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        out = identity.to_dict()
        out["capabilities"] = list(capabilities)
        out["high_impact_capabilities"] = [c for c in HIGH_IMPACT_CAPABILITIES
                                           if c in capabilities]
        out["blast_radius"] = {
            "score": blast.score if blast else None,
            "band": blast.score_band if blast else None,
            "direct_resources": blast.direct_resources if blast else None,
            "indirect_resources": blast.indirect_resources if blast else None,
            "inventory_complete": blast.inventory_complete if blast else None,
        }
        out["usage"] = usage or {
            "observed": None, "not_observed": None,
            "note": "No usage analysis for this identity.",
        }
        # The table must be able to render "not assessed" distinctly from
        # "read-only". This flag is what the column binds to.
        out["assessed"] = identity.privilege_level != PRIV_UNKNOWN
        return out

    async def _capabilities_for(
        self, ids: Sequence[uuid.UUID],
    ) -> Dict[uuid.UUID, List[str]]:
        if not ids:
            return {}
        out: Dict[uuid.UUID, List[str]] = {}
        for identity_id, capability in (await self.db.execute(
            select(CloudIdentityCapability.identity_id,
                   CloudIdentityCapability.capability)
            .where(CloudIdentityCapability.identity_id.in_(list(ids)))
        )).all():
            out.setdefault(identity_id, []).append(capability)
        return out

    async def _usage_summary_for(
        self, ids: Sequence[uuid.UUID],
    ) -> Dict[uuid.UUID, Dict[str, Any]]:
        if not ids:
            return {}
        out: Dict[uuid.UUID, Dict[str, Any]] = {}
        for identity_id, state, count in (await self.db.execute(
            select(CloudPermissionUsage.identity_id, CloudPermissionUsage.usage_state,
                   func.count())
            .where(CloudPermissionUsage.identity_id.in_(list(ids)))
            .group_by(CloudPermissionUsage.identity_id,
                      CloudPermissionUsage.usage_state)
        )).all():
            entry = out.setdefault(identity_id, {"observed": 0, "not_observed_high": 0,
                                                 "not_observed_low": 0, "unknown": 0})
            key = {"OBSERVED": "observed",
                   "NOT_OBSERVED_HIGH_CONFIDENCE": "not_observed_high",
                   "NOT_OBSERVED_LOW_CONFIDENCE": "not_observed_low",
                   "UNKNOWN": "unknown"}.get(state)
            if key:
                entry[key] = int(count)
        return out

    async def _names(self, ids: Sequence[uuid.UUID]) -> Dict[uuid.UUID, Optional[str]]:
        if not ids:
            return {}
        return {
            i: n for i, n in (await self.db.execute(
                select(CloudIdentity.id, CloudIdentity.name)
                .where(CloudIdentity.id.in_(list(ids)))
            )).all()
        }

    # ── Identity detail ──────────────────────────────────────────────────────
    async def detail(self, identity_id: uuid.UUID) -> Optional[Dict[str, Any]]:
        identity = await self.repo.identity_by_id(identity_id)
        if identity is None:
            return None
        capabilities = await self.repo.capabilities(
            account_id=identity.account_id, identity_id=identity_id)
        blast = await self.repo.blast_radius(identity_id)
        credentials = await self.repo.credentials(account_id=identity.account_id,
                                                  identity_id=identity_id)
        state = await self.repo.analysis_state(identity.account_id)
        memberships = await self._memberships(identity)
        baseline = await self.repo.baseline(identity_id)

        return {
            "identity": identity.to_dict(include_detail=True),
            "assessed": identity.privilege_level != PRIV_UNKNOWN,
            "capabilities": [c.to_dict() for c in capabilities],
            "high_impact": [c.to_dict() for c in capabilities if c.high_impact],
            "credentials": [c.to_dict() for c in credentials],
            "groups": memberships,
            "blast_radius": blast.to_dict() if blast else None,
            # The observed baseline, so the Events tab can say what is normal
            # for this principal. `sufficient` gates any comparison: a baseline
            # built from six events cannot support a deviation claim, and the
            # row carries the reason rather than a silent empty list.
            "baseline": baseline.to_dict() if baseline else None,
            "analysis": state.to_dict() if state else None,
        }

    async def _memberships(self, identity: CloudIdentity) -> List[Dict[str, Any]]:
        rows = list((await self.db.execute(
            select(CloudIdentityMembership, CloudIdentity)
            .join(CloudIdentity,
                  CloudIdentity.id == CloudIdentityMembership.container_identity_id)
            .where(CloudIdentityMembership.member_identity_id == identity.id)
        )).all())
        return [{
            "membership_kind": m.membership_kind,
            "match_rule": m.match_rule,
            "container": {"id": str(c.id), "name": c.name,
                          "identity_type": c.identity_type,
                          "privilege_level": c.privilege_level},
        } for m, c in rows]

    async def permissions(
        self, identity_id: uuid.UUID, *, decisions: Optional[Sequence[str]] = None,
        capability: Optional[str] = None, q: Optional[str] = None,
        page: int = 1, page_size: int = DEFAULT_PAGE_SIZE,
    ) -> Dict[str, Any]:
        """The §3 effective-permissions list: every grant with its decision."""
        size = max(1, min(page_size, MAX_PAGE_SIZE))
        offset = max(0, (max(1, page) - 1) * size)
        conditions: List[Any] = [CloudEffectivePermission.identity_id == identity_id]
        if decisions:
            conditions.append(CloudEffectivePermission.decision.in_(list(decisions)))
        if capability:
            conditions.append(CloudEffectivePermission.capability == capability)
        if q:
            conditions.append(CloudEffectivePermission.action_pattern.ilike(f"%{q}%"))

        stmt = select(CloudEffectivePermission).where(*conditions)
        total = int((await self.db.execute(
            select(func.count()).select_from(stmt.subquery())
        )).scalar() or 0)
        rows = list((await self.db.execute(
            stmt.order_by(CloudEffectivePermission.action_pattern)
            .limit(size).offset(offset)
        )).scalars().all())

        by_decision: Dict[str, int] = {}
        for decision, count in (await self.db.execute(
            select(CloudEffectivePermission.decision, func.count())
            .where(CloudEffectivePermission.identity_id == identity_id)
            .group_by(CloudEffectivePermission.decision)
        )).all():
            by_decision[decision] = int(count)

        uncertain = int((await self.db.execute(
            select(func.count()).select_from(CloudEffectivePermission).where(
                CloudEffectivePermission.identity_id == identity_id,
                CloudEffectivePermission.unevaluated.isnot(None),
            )
        )).scalar() or 0)

        return {
            "total": total, "page": max(1, page), "page_size": size,
            "pages": (total + size - 1) // size if size else 0,
            "by_decision": by_decision,
            "not_fully_verified": uncertain,
            "verification_note": (
                f"{uncertain} grant(s) were evaluated with at least one link of the "
                "provider's decision chain unavailable. They are shown as 'allowed by "
                "the policies we can read', not as allowed."
            ) if uncertain else None,
            "items": [r.to_dict() for r in rows],
        }

    async def usage(self, identity_id: uuid.UUID) -> Dict[str, Any]:
        rows = await self.repo.usage(identity_id)
        if not rows:
            return {
                "items": [], "window": None,
                "note": "No permission-usage analysis exists for this identity.",
            }
        first = rows[0]
        observed = [r for r in rows if r.usage_state == "OBSERVED"]
        return {
            "window": {
                "start": first.window_start.isoformat(),
                "end": first.window_end.isoformat(),
                "days": first.window_days,
                "events_in_window": first.events_in_window,
            },
            "observed_count": len(observed),
            "not_observed_high": len([r for r in rows
                                      if r.usage_state == "NOT_OBSERVED_HIGH_CONFIDENCE"]),
            "not_observed_low": len([r for r in rows
                                     if r.usage_state == "NOT_OBSERVED_LOW_CONFIDENCE"]),
            "unknown": len([r for r in rows if r.usage_state == "UNKNOWN"]),
            "items": [r.to_dict() for r in rows],
            "note": ("Counts are of granted statements and observed actions over the "
                     "window above. This platform does not expand wildcards into a "
                     "full provider action catalog, so no granted-action total is "
                     "shown."),
        }

    async def trust(self, identity_id: uuid.UUID) -> List[Dict[str, Any]]:
        identity = await self.repo.identity_by_id(identity_id)
        if identity is None:
            return []
        rows = list((await self.db.execute(
            select(CloudIdentityTrust).where(
                CloudIdentityTrust.account_id == identity.account_id,
                or_(CloudIdentityTrust.target_identity_id == identity_id,
                    CloudIdentityTrust.target_key == identity.provider_id),
            )
        )).scalars().all())
        return [r.to_dict() for r in rows]

    async def trust_map(self, account_id: uuid.UUID, *,
                        external_only: bool = False) -> Dict[str, Any]:
        rows = await self.repo.trust_edges(account_id, external_only=external_only)
        edges = [
            trust_mod.TrustEdge(
                provider=t.provider, target_key=t.target_key,
                source_principal=t.source_principal, trust_kind=t.trust_kind,
                target_name=t.target_name, source_account=t.source_account,
                source_type=t.source_type, external=t.external,
                conditions=t.conditions, has_external_id=t.has_external_id,
                has_mfa_condition=t.has_mfa_condition,
                target_privilege=t.target_privilege,
            ) for t in rows
        ]
        for edge in edges:
            edge.risk_factors = trust_mod.risk_factors(edge)
        return {
            "summary": trust_mod.summarize(edges),
            "graph": trust_mod.graph(edges),
            "edges": [e.to_dict() for e in edges],
        }

    async def events(self, identity_id: uuid.UUID, *,
                     limit: int = 100) -> List[Dict[str, Any]]:
        """§27: the Event Log rows attributable to this principal."""
        from app.models.cloud_event import CloudEvent

        identity = await self.repo.identity_by_id(identity_id)
        if identity is None:
            return []
        keys = [k for k in (identity.provider_id, identity.name,
                            identity.principal_name) if k]
        if not keys:
            return []
        rows = list((await self.db.execute(
            select(CloudEvent).where(
                CloudEvent.account_id == identity.account_id,
                or_(CloudEvent.actor_id.in_(keys), CloudEvent.actor_name.in_(keys)),
            ).order_by(desc(CloudEvent.timestamp)).limit(limit)
        )).scalars().all())
        return [{
            "id": str(e.id), "timestamp": e.timestamp.isoformat() if e.timestamp else None,
            "event_name": e.event_name, "event_source": e.event_source,
            "api_operation": e.api_operation, "status": e.status,
            "risk_level": e.risk_level, "region": e.region,
            "resource_name": e.resource_name, "resource_type": e.resource_type,
            "source_ip": e.source_ip, "actor_name": e.actor_name,
        } for e in rows]

    # ── The permission explorer (§4) ─────────────────────────────────────────
    async def can_do(
        self, account_id: uuid.UUID, *, identity_id: uuid.UUID, action: str,
        resource: Optional[str] = None,
    ) -> Dict[str, Any]:
        """"CAN THIS IDENTITY DO THIS?" — evaluated live, with the full trace.

        Evaluated rather than looked up, because the question is about a
        specific (action, resource) pair that the materialised grant rows do
        not enumerate. One identity, one question — not a cross-product.
        """
        identity = await self.repo.identity_by_id(identity_id)
        if identity is None:
            return {"error": "identity not found"}
        account = await self.db.get(CloudAccount, account_id)
        provider = normalize_provider(identity.provider) or identity.provider

        from app.services.identity_service import IdentityService

        service = IdentityService(self.db)
        own = await self.repo.policies(account_id=account_id, identity_id=identity_id)
        inherited: List[Any] = []
        for membership in (await self.db.execute(
            select(CloudIdentityMembership).where(
                CloudIdentityMembership.member_identity_id == identity_id)
        )).scalars().all():
            inherited.extend(await self.repo.policies(
                account_id=account_id, identity_id=membership.container_identity_id))

        policy_set, evaluable, gaps = service._build_policy_set(
            provider, identity, own, inherited)
        decision = engine.evaluate(provider, policy_set, action=action,
                                   resource=resource)
        return {
            "identity": {"id": str(identity.id), "name": identity.name,
                         "identity_type": identity.identity_type,
                         "provider": provider},
            "question": {"action": action, "resource": resource},
            "evaluable": evaluable,
            **decision.to_dict(),
            "collection_gaps": gaps,
        }

    async def who_can_access(
        self, account_id: uuid.UUID, *, action: Optional[str] = None,
        resource: Optional[str] = None, capability: Optional[str] = None,
        limit: int = 100,
    ) -> Dict[str, Any]:
        """§23's reverse query: which principals can do this, to this?

        Answered from the materialised grant rows — matching the concrete
        action against each stored PATTERN, which is the direction that keeps
        `*/read` from matching a privileged operation. Capability is the fast
        path and uses the 18-row index; action+resource is the precise one.
        """
        if not action and not capability:
            return {"error": "an action or a capability is required"}

        if capability and not action:
            rows = list((await self.db.execute(
                select(CloudIdentity, CloudIdentityCapability)
                .join(CloudIdentityCapability,
                      CloudIdentityCapability.identity_id == CloudIdentity.id)
                .where(CloudIdentityCapability.account_id == account_id,
                       CloudIdentityCapability.capability == capability,
                       CloudIdentity.status != "DELETED")
                .limit(limit)
            )).all())
            # The coverage caveat belongs on BOTH reverse paths. Omitting it
            # here would make the capability query — the faster, more-used one —
            # the single answer in the product that reads as complete.
            state = await self.repo.analysis_state(account_id)
            return {
                "query": {"capability": capability},
                "matched": len(rows),
                "coverage": {
                    "not_assessed": state.unevaluated_count if state else None,
                    "analysis_status": state.status if state else ANALYSIS_NEVER_RUN,
                    "note": ("Identities whose policies could not be evaluated are not "
                             "in this answer. The list is who we can SHOW holds this "
                             "capability, which is a lower bound on who does.")
                    if state and state.unevaluated_count else None,
                },
                "principals": [{
                    "identity_id": str(i.id), "name": i.name,
                    "identity_type": i.identity_type, "actor_class": i.actor_class,
                    "privilege_level": i.privilege_level, "external": i.external,
                    "mfa_state": i.mfa_state, "last_used_at":
                        i.last_used_at.isoformat() if i.last_used_at else None,
                    "scope_level": c.scope_level, "scope": c.scope,
                    "evidence_actions": c.evidence_actions,
                    "certain": c.certain,
                } for i, c in rows],
            }

        grants = list((await self.db.execute(
            select(CloudEffectivePermission, CloudIdentity)
            .join(CloudIdentity, CloudIdentity.id == CloudEffectivePermission.identity_id)
            .where(CloudEffectivePermission.account_id == account_id,
                   CloudEffectivePermission.decision.in_(list(DECISIONS_PERMISSIVE)),
                   CloudIdentity.status != "DELETED")
        )).all())

        provider_of = {}
        matched: List[Dict[str, Any]] = []
        for grant, identity in grants:
            provider = normalize_provider(grant.provider) or grant.provider
            if not covers(provider, grant.action_pattern, action):
                continue
            if resource and grant.resource_pattern and grant.resource_pattern != "*":
                if not covers(provider, grant.resource_pattern, resource):
                    continue
            matched.append({
                "identity_id": str(identity.id), "name": identity.name,
                "identity_type": identity.identity_type,
                "actor_class": identity.actor_class,
                "privilege_level": identity.privilege_level,
                "external": identity.external, "mfa_state": identity.mfa_state,
                "last_used_at": identity.last_used_at.isoformat()
                                if identity.last_used_at else None,
                "granted_by": grant.action_pattern,
                "resource_pattern": grant.resource_pattern,
                "source": grant.source_name, "source_stage": grant.source_stage,
                "inherited": grant.inherited,
                "decision": grant.decision,
                "certain": not bool(grant.unevaluated),
                "conditional": grant.conditional,
            })
            if len(matched) >= limit:
                break

        state = await self.repo.analysis_state(account_id)
        return {
            "query": {"action": action, "resource": resource},
            "matched": len(matched),
            "principals": matched,
            "coverage": {
                "not_assessed": state.unevaluated_count if state else None,
                "note": ("Identities whose policies could not be evaluated are not in "
                         "this answer. The list is who we can SHOW has access, which is "
                         "a lower bound on who does.")
                if state and state.unevaluated_count else None,
            },
        }

    # ── Search (§33) ─────────────────────────────────────────────────────────
    async def search(self, account_id: uuid.UUID, query: str, *,
                     limit: int = 25) -> Dict[str, Any]:
        """Free-text search over the indexed identity data.

        Deliberately not a natural-language parser. It matches principals,
        capabilities and action patterns, and returns the structured filters
        that would answer the question — so the UI can turn a search into a
        filtered table rather than pretending to understand a sentence.
        """
        text = (query or "").strip()
        if not text:
            return {"query": text, "identities": [], "suggestions": []}

        like = f"%{text}%"
        identities = list((await self.db.execute(
            select(CloudIdentity).where(
                CloudIdentity.account_id == account_id,
                CloudIdentity.status != "DELETED",
                or_(CloudIdentity.name.ilike(like),
                    CloudIdentity.principal_name.ilike(like),
                    CloudIdentity.provider_id.ilike(like)),
            ).limit(limit)
        )).scalars().all())

        actions = list((await self.db.execute(
            select(CloudEffectivePermission.action_pattern,
                   func.count(func.distinct(CloudEffectivePermission.identity_id)))
            .where(CloudEffectivePermission.account_id == account_id,
                   CloudEffectivePermission.action_pattern.ilike(like))
            .group_by(CloudEffectivePermission.action_pattern).limit(limit)
        )).all())

        lowered = text.lower()
        suggestions: List[Dict[str, Any]] = []
        for capability in HIGH_IMPACT_CAPABILITIES:
            if lowered in capability.lower().replace("_", " "):
                suggestions.append({
                    "label": f"Identities that can {capability.lower().replace('_', ' ')}",
                    "filter": {"capability": capability},
                })
        if "mfa" in lowered:
            suggestions.append({"label": "Human identities with no MFA",
                                "filter": {"mfa_states": ["DISABLED"],
                                           "actor_classes": ["HUMAN"]}})
        if "dormant" in lowered or "unused" in lowered:
            suggestions.append({"label": "Identities dormant for 90+ days",
                                "filter": {"dormant_days": 90}})
        if "external" in lowered or "cross" in lowered:
            suggestions.append({"label": "External principals",
                                "filter": {"external": ["EXTERNAL", "ANONYMOUS"]}})
        if "admin" in lowered or "owner" in lowered or "privileged" in lowered:
            suggestions.append({"label": "Administrative identities",
                                "filter": {"privilege_levels": ["ADMIN"]}})
        if "blast" in lowered:
            suggestions.append({"label": "High blast-radius identities",
                                "filter": {"blast_band": ["CRITICAL", "HIGH"]}})

        return {
            "query": text,
            "identities": [i.to_dict() for i in identities],
            "actions": [{"action_pattern": a, "identities": int(n)} for a, n in actions],
            "suggestions": suggestions,
        }

    # ── Resource-side question (§23 from the Resource page) ──────────────────
    async def principals_for_resource(
        self, account_id: uuid.UUID, resource_key: str, *, limit: int = 100,
    ) -> Dict[str, Any]:
        """"Who can access this?" for one resource, from the Resources tab."""
        grants = list((await self.db.execute(
            select(CloudEffectivePermission, CloudIdentity)
            .join(CloudIdentity, CloudIdentity.id == CloudEffectivePermission.identity_id)
            .where(CloudEffectivePermission.account_id == account_id,
                   CloudEffectivePermission.decision.in_(list(DECISIONS_PERMISSIVE)),
                   CloudIdentity.status != "DELETED")
        )).all())

        out: Dict[str, Dict[str, Any]] = {}
        for grant, identity in grants:
            provider = normalize_provider(grant.provider) or grant.provider
            pattern = grant.resource_pattern or "*"
            if pattern != "*" and not covers(provider, pattern, resource_key):
                continue
            entry = out.setdefault(str(identity.id), {
                "identity_id": str(identity.id), "name": identity.name,
                "identity_type": identity.identity_type,
                "actor_class": identity.actor_class,
                "privilege_level": identity.privilege_level,
                "external": identity.external, "mfa_state": identity.mfa_state,
                "last_used_at": identity.last_used_at.isoformat()
                                if identity.last_used_at else None,
                "access": [],
            })
            if len(entry["access"]) < 25:
                entry["access"].append({
                    "action_pattern": grant.action_pattern,
                    "capability": grant.capability,
                    "resource_pattern": pattern,
                    "source": grant.source_name,
                    "source_stage": grant.source_stage,
                    "inherited": grant.inherited,
                    "certain": not bool(grant.unevaluated),
                })
            if len(out) >= limit:
                break

        state = await self.repo.analysis_state(account_id)
        return {
            "resource_key": resource_key,
            "matched": len(out),
            "principals": sorted(out.values(),
                                 key=lambda p: (p["privilege_level"] or "ZZ",
                                                p["name"] or "")),
            "coverage": {
                "not_assessed": state.unevaluated_count if state else None,
                "analysis_status": state.status if state else ANALYSIS_NEVER_RUN,
                "note": ("This is who we can show has access. Identities whose policies "
                         "could not be evaluated are not included."),
            },
        }

    def meta(self) -> Dict[str, Any]:
        """The vocabulary and the capability catalog, for the UI legend."""
        return {**model_meta(), "capability_catalog": capability_catalog()}
