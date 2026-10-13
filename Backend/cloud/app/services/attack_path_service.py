"""Attack paths for one account, assembled from parts that already exist.

This service owns no analysis of its own. It fetches the cached topology graph,
recomputes exposure the same way the Exposure tab does, reads the account's open
findings, and hands all three to `app.security.attackpath`. Keeping the
analysis in a pure module and the I/O here is what lets the traversal be tested
against a real `Graph` with no database at all.

**Why this recomputes instead of reading a table.** A path is a function of the
graph and the exposure verdicts, both of which are already derived and cached
upstream — the graph by `TopologyService` behind a fingerprint of the inventory,
exposure by a pass over resources this service also needs for other reasons.
Persisting paths would add a table that can disagree with the graph it came
from, which is the failure mode the unified finding model was built to end.
What this does instead is cache the computed result against the graph's own
`generated_at`, so a second page load inside one inventory generation is free
and the cache cannot outlive the data it was derived from.

The consequence, stated plainly because it limits what the UI may claim: there
is **no attack-path history**. "Three new paths since Tuesday" is not a question
this service can answer, and the API says so rather than inventing a baseline.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_event import CloudEvent
from app.models.security_finding import CloudSecurityFinding
from app.security import (
    attackpath, exposure, incident, ransomware, risk, threat, vulnerability,
)
from app.security.model import (
    ACTIVE_FINDING_STATUSES, CAT_IAM, EXPOSED, PROTECTED, normalize_provider,
)
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository
from app.repository.security_repo import SecurityRepository
from app.services.topology_service import TopologyService

logger = logging.getLogger(__name__)

# scope -> (graph generated_at, params key, payload). One entry per scope: the
# Security Center asks for one account at a time, and holding every account's
# paths would trade a bounded recomputation for an unbounded memory leak.
_CACHE: Dict[str, Tuple[str, str, Dict[str, Any]]] = {}

# scope -> (graph generated_at, inputs). The inventory read and the exposure
# pass, shared by the path walk and by per-finding risk context.
#
# This exists because of a measured regression, not on principle. Wiring
# contextual risk into the finding drawer made every drawer open re-read the
# account's inventory and re-run `exposure.analyse` over all of it — twice,
# since `analyse()` did its own read — and the endpoint went to 1.0-5.5s on an
# account of 492 resources. Keyed on the graph's `generated_at`, so it expires
# exactly when the inventory it was derived from does.
_INPUTS: Dict[str, Tuple[str, Dict[str, Any]]] = {}

# account -> (cache key, payload). The key folds in the event count and the
# newest timestamp, both of which change only when the collector runs, so a
# page load inside one collection generation is free and a new batch of events
# invalidates it automatically.
_DETECTIONS: Dict[str, Tuple[str, Dict[str, Any]]] = {}


class _EventView:
    """A narrow read-only view of one event row.

    The detectors use attribute access, and a SQLAlchemy `Row` from a column
    projection already supports that — but only for the exact columns selected,
    so a detector reaching for a field nobody projected would raise rather than
    read None. This wrapper makes an unprojected field read as absent, which is
    what every detector's availability check already expects.
    """

    __slots__ = ("_r",)

    def __init__(self, row) -> None:
        self._r = row

    def __getattr__(self, name: str):
        return getattr(self._r, name, None)


def _as_uuid(value) -> Optional[uuid.UUID]:
    """A UUID, or None when the value is not one — never a raised comparison."""
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def invalidate_cache(scope: Optional[str] = None) -> None:
    if scope is None:
        _CACHE.clear()
        _INPUTS.clear()
        _DETECTIONS.clear()
    else:
        _CACHE.pop(scope, None)
        _INPUTS.pop(scope, None)
        _DETECTIONS.pop(scope, None)


class AttackPathService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.accounts = CloudAccountRepository(db)
        self.resources = ResourceRepository(db)
        self.repo = SecurityRepository(db)
        self.topology = TopologyService(db)

    # ── inputs ───────────────────────────────────────────────────────────────

    async def _finding_context(
        self, account_id: uuid.UUID
    ) -> Tuple[set, List[Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
        """One read of the account's open findings, three views of it.

        Both the privileged-identity set and the per-node finding index come
        from the same rows, so they are fetched together — two calls to
        `findings_for_account` would be two full scans of the same table for
        one page.

        Privileged identities are derived from findings rather than from a
        hand-written list of role names: if the IAM analyser did not think a
        role was over-permissioned, this module has no independent basis for
        saying it is. An account whose identity data was never collected
        therefore yields an empty set here — which the caller reports as a
        coverage gap rather than as an absence of privilege.
        """
        findings = await self.repo.findings_for_account(
            account_id, statuses=ACTIVE_FINDING_STATUSES)

        privileged: set = set()
        privileged_detail: List[Dict[str, Any]] = []
        by_node: Dict[str, List[Dict[str, Any]]] = {}

        for f in findings:
            if not f.resource_id:
                continue
            key = str(f.resource_id)
            by_node.setdefault(key, []).append({
                "finding_key": f.fingerprint,
                "rule_id": f.rule_id,
                "title": f.title,
                "severity": f.severity,
                "category": f.category,
            })
            if f.category == CAT_IAM:
                privileged.add(key)
                privileged_detail.append({
                    "resource_id": key,
                    "resource_name": f.resource_name,
                    "rule_id": f.rule_id,
                    "severity": f.severity,
                    "title": f.title,
                })
        return privileged, privileged_detail, by_node

    async def _inputs(
        self, account_id: uuid.UUID, provider: Optional[str], generated_at: str
    ) -> Dict[str, Any]:
        """The inventory read and the exposure pass, computed once per graph.

        Both the path walk and per-finding risk context need exactly this, and
        both used to fetch it independently. Sharing it is what keeps the
        finding drawer from paying for a full exposure analysis per open.
        """
        scope = str(account_id)
        hit = _INPUTS.get(scope)
        if hit and hit[0] == generated_at:
            return hit[1]

        resources = await self.resources.list_by_account(account_id)
        exposures = exposure.analyse(resources, provider) if provider else []
        data = {
            "resources": resources,
            "exposures": exposures,
            "exposure_by_id": {
                str(e.resource_id): e for e in exposures
                if getattr(e, "resource_id", None)
            },
            "resource_by_id": {str(r.id): r for r in resources},
        }
        _INPUTS[scope] = (generated_at, data)
        return data

    # ── the analysis ─────────────────────────────────────────────────────────

    async def analyse(
        self,
        account_id: uuid.UUID,
        *,
        max_depth: int = 6,
        limit: int = 100,
        refresh: bool = False,
    ) -> Dict[str, Any]:
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)
        scope = str(account_id)
        params_key = f"d{max_depth}"

        graph, error = await self.topology.get_graph(scope, refresh=refresh)
        if error or graph is None:
            return self._unavailable(
                account_id, provider,
                reason=error or "The topology graph could not be built for this account.",
            )

        generated_at = (graph.meta or {}).get("generated_at") or ""
        cached = _CACHE.get(scope)
        if cached and cached[0] == generated_at and cached[1] == params_key and not refresh:
            payload = dict(cached[2])
            payload["cached"] = True
            return self._limited(payload, limit)

        inputs = await self._inputs(account_id, provider, generated_at)
        if not inputs["resources"]:
            return self._unavailable(
                account_id, provider,
                reason="No inventory has been collected for this account yet, so "
                       "there is nothing to trace a path through.",
            )

        exposures = inputs["exposures"]
        privileged_ids, privileged_detail, findings_by_node = await self._finding_context(account_id)

        started = datetime.now(timezone.utc)
        result = attackpath.find_paths(
            graph, exposures,
            account_id=str(account_id), provider=provider or "",
            privileged_identity_ids=privileged_ids,
            max_depth=max_depth,
        )

        exposure_by_node = result["exposure_by_node"]
        scored: List[Dict[str, Any]] = []
        for path in result["paths"]:
            entry_exposure = exposure_by_node.get(path.entry_node_id)
            blast = graph.degree(path.target_node_id)
            score = attackpath.score_path(
                path,
                exposure=entry_exposure,
                privileged_identity_ids=privileged_ids,
                findings_by_node=findings_by_node,
                blast_radius=blast,
            )
            row = path.to_dict()
            row["risk"] = score
            row["entry"] = self._node_brief(graph, path.entry_node_id, exposure_by_node)
            row["target"] = self._node_brief(graph, path.target_node_id, exposure_by_node)
            scored.append(row)

        # Worst first, then shortest, then by id so the order is stable across
        # calls — an unstable list makes "the top 5 paths" meaningless.
        scored.sort(key=lambda r: (-r["risk"]["points"], r["length"], r["path_id"]))

        payload = {
            "account_id": str(account_id),
            "account_name": account.account_name,
            "provider": provider,
            "available": True,
            "generated_at": started.isoformat(),
            "graph_generated_at": generated_at,
            "paths": scored,
            "total_paths": len(scored),
            "summary": self._summary(scored, result, privileged_detail, exposures),
            "entry_points": result["entry_points"],
            "entries_without_path": result["entries_without_path"],
            "truncated": result["truncated"],
            "limits": result["limits"],
            "traversal_model": attackpath.traversal_model(),
            "coverage": self._coverage(exposures, privileged_ids, graph),
            "history_available": False,
            "history_note": (
                "Attack paths are derived from the current graph and are not stored "
                "per scan, so no trend over time is available."
            ),
            "cached": False,
        }
        _CACHE[scope] = (generated_at, params_key, payload)
        return self._limited(payload, limit)

    # ── presentation helpers ─────────────────────────────────────────────────

    @staticmethod
    def _node_brief(graph, node_id: str, exposure_by_node) -> Dict[str, Any]:
        node = graph.node(node_id) or {}
        exp = exposure_by_node.get(node_id)
        return {
            "node_id": node_id,
            "name": node.get("name"),
            "type": node.get("type"),
            "category": node.get("category"),
            "region": node.get("region"),
            "resource_id": node.get("resource_id"),
            "public_addresses": list(getattr(exp, "public_addresses", []) or []) if exp else [],
            "open_ports": [p.to_dict() for p in (getattr(exp, "open_ports", []) or [])] if exp else [],
        }

    @staticmethod
    def _summary(scored, result, privileged_detail, exposures) -> Dict[str, Any]:
        bands: Dict[str, int] = {}
        classes: Dict[str, int] = {}
        for r in scored:
            band = r["risk"]["band"]
            bands[band] = bands.get(band, 0) + 1
            cls = r.get("path_class") or "UNKNOWN"
            classes[cls] = classes.get(cls, 0) + 1
        targets = {r["target_node_id"] for r in scored}
        entries = {r["entry_node_id"] for r in scored}
        resources_on_paths = {n["id"] for r in scored for n in r["nodes"] if n.get("id")}
        return {
            "by_band": bands,
            # Grouped so a VM's own boot disk does not compete for attention
            # with a route that crosses an identity. Live data is dominated by
            # the first kind; without this the second is invisible.
            "by_class": classes,
            "class_labels": attackpath.PATH_CLASS_LABEL,
            "class_meanings": attackpath.PATH_CLASS_MEANING,
            "distinct_targets": len(targets),
            "distinct_entry_points": len(entries),
            "resources_involved": len(resources_on_paths),
            "exposed_resources": sum(
                1 for e in exposures if getattr(e, "verdict", None) == EXPOSED),
            "entry_points_with_no_path": len(result["entries_without_path"]),
            "privileged_identities_flagged": len({d["resource_id"] for d in privileged_detail}),
            "shortest_path": min((r["length"] for r in scored), default=None),
        }

    @staticmethod
    def _coverage(exposures, privileged_ids, graph) -> Dict[str, Any]:
        """What the path list could not see. Shown beside it, never folded in.

        The edge census is the load-bearing part. An attack path can only cross
        a relationship the topology builder actually emitted, and on live data
        that varies sharply by provider: the AWS account carries 23 `role` and
        21 `permission` edges, while OCI and Azure carry none at all despite
        holding identity resources. Without this block an operator reading
        "no identity pivots found" would reasonably conclude there are none,
        when the truthful statement is that none could be looked for.
        """
        undetermined = [
            e for e in exposures
            if getattr(e, "verdict", None) not in (EXPOSED, PROTECTED)
        ]

        present: Dict[str, int] = {}
        for e in graph.edges:
            kind = e.get("type")
            if kind in attackpath.TRAVERSABLE:
                present[kind] = present.get(kind, 0) + 1
        missing = [k for k in attackpath.TRAVERSABLE if k not in present]

        identity_kinds = ("role", "permission")
        identity_edges = sum(present.get(k, 0) for k in identity_kinds)

        return {
            "exposure_undetermined": len(undetermined),
            "exposure_undetermined_note": (
                "Resources whose internet reachability could not be resolved. None of "
                "them was used as an entry point, so any path starting at one is "
                "missing from this list."
            ) if undetermined else None,
            "identity_data_present": bool(privileged_ids),
            "identity_note": (
                None if privileged_ids else
                "No identity has been flagged as over-permissioned for this account, "
                "either because none is or because identity data was not collected. "
                "Paths through a privileged role may therefore be under-scored."
            ),
            # ── what the walk was able to traverse at all ──
            "traversable_edges_present": present,
            "traversable_edges_missing": missing,
            "identity_edges": identity_edges,
            "identity_paths_possible": identity_edges > 0,
            "identity_edge_note": (
                None if identity_edges else
                "This account's graph contains no role or permission relationships, so "
                "no path through an identity could be traced. That is a gap in what "
                "discovery records for this provider, not a finding that none exists."
            ),
            "any_traversable_edges": bool(present),
            "no_traversable_edges_note": (
                None if present else
                "The graph for this account holds only structural relationships "
                "(ownership, filtering), none of which an attacker can move along. "
                "No path could be traced regardless of exposure."
            ),
            "graph_nodes": graph.node_count,
            "graph_edges": graph.edge_count,
        }

    @staticmethod
    def _limited(payload: Dict[str, Any], limit: int) -> Dict[str, Any]:
        out = dict(payload)
        paths = out.get("paths") or []
        if limit and len(paths) > limit:
            out["paths"] = paths[:limit]
            out["returned"] = limit
            out["truncated"] = list(out.get("truncated") or []) + [
                f"Showing the {limit} highest-scoring paths of {len(paths)}."
            ]
        else:
            out["returned"] = len(paths)
        return out

    @staticmethod
    def _unavailable(account_id, provider, *, reason: str) -> Dict[str, Any]:
        """An honest empty result. Never an empty list that reads as 'no risk'."""
        return {
            "account_id": str(account_id),
            "provider": provider,
            "available": False,
            "unavailable_reason": reason,
            "paths": [],
            "total_paths": None,
            "returned": 0,
            "summary": None,
            "entry_points": [],
            "entries_without_path": [],
            "truncated": [],
            "traversal_model": attackpath.traversal_model(),
            "history_available": False,
        }

    # ── contextual risk for one finding ──────────────────────────────────────

    async def risk_context(
        self,
        account_id: uuid.UUID,
        *,
        resource_id: Optional[str],
        severity: str,
        rule_id: Optional[str],
        resource_type: Optional[str] = None,
        identity_collected: bool = True,
        max_depth: int = 6,
    ) -> Optional[Dict[str, Any]]:
        """What this finding's severity means on THIS resource.

        Assembled here rather than in `risk.py` because the model is pure by
        design: it takes evidence and returns arithmetic, and every lookup that
        turns an account id into evidence is I/O. Everything this reads is
        already cached behind the inventory fingerprint — the graph by
        `TopologyService`, the paths by this service — so a finding drawer costs
        one resource query rather than a re-analysis of the estate.

        Returns None for a finding with no resource (an account-level or
        aggregate finding): there is no single resource whose context could
        change what it means, and inventing one would be worse than omitting it.
        """
        if not resource_id:
            return None

        account = await self.accounts.get_by_id(account_id)
        if account is None:
            return None
        provider = normalize_provider(account.provider)

        graph, _err = await self.topology.get_graph(str(account_id))
        generated_at = (graph.meta or {}).get("generated_at", "") if graph is not None else ""
        blast = graph.degree(str(resource_id)) if graph is not None else None

        inputs = await self._inputs(account_id, provider, generated_at)
        row = inputs["resource_by_id"].get(str(resource_id))
        exp = inputs["exposure_by_id"].get(str(resource_id))

        # Only this resource's IAM findings matter here. Reusing the account-wide
        # `_finding_context` meant loading every finding — with its JSONB evidence
        # column — to answer a question about one row, which was most of what a
        # finding drawer spent its time on.
        attached_privileged = [
            {
                "resource_id": str(f.resource_id),
                "resource_name": f.resource_name,
                "rule_id": f.rule_id,
                "severity": f.severity,
                "title": f.title,
            }
            for f in (await self.db.execute(
                select(
                    CloudSecurityFinding.resource_id,
                    CloudSecurityFinding.resource_name,
                    CloudSecurityFinding.rule_id,
                    CloudSecurityFinding.severity,
                    CloudSecurityFinding.title,
                ).where(
                    CloudSecurityFinding.account_id == account_id,
                    CloudSecurityFinding.resource_id == _as_uuid(resource_id),
                    CloudSecurityFinding.category == CAT_IAM,
                    CloudSecurityFinding.status.in_(list(ACTIVE_FINDING_STATUSES)),
                )
            )).all()
        ]

        path_ids: List[str] = []
        try:
            analysis = await self.analyse(account_id, max_depth=max_depth, limit=0)
            for p in analysis.get("paths") or []:
                if any(n.get("id") == str(resource_id) for n in p.get("nodes") or []):
                    path_ids.append(p["path_id"])
        except ValueError:
            path_ids = []

        ctx = risk.ResourceContext(
            resource_key=getattr(row, "provider_resource_id", None),
            resource_type=resource_type or getattr(row, "resource_type", None),
            tags=getattr(row, "tags", None),
            exposure=exp,
            privileged_identities=attached_privileged,
            identity_collected=identity_collected,
            attack_path_ids=path_ids,
            blast_radius=blast,
        )
        return risk.assess(severity, ctx, rule_id=rule_id).to_dict()

    # ── vulnerability correlation ────────────────────────────────────────────

    async def vulnerabilities(
        self, account_id: uuid.UUID, *, max_depth: int = 6,
    ) -> Dict[str, Any]:
        """Software identity per compute resource, joined to reachability.

        Lives here because the two things it needs — the exposure pass and the
        attack paths — are already computed and cached on this service. A
        separate service would have recomputed both to answer a question that
        is mostly about the same data.

        With no vulnerability source configured this returns identities,
        coverage and reachability, and `source_configured: false`. That is the
        point: the inventory half is real and testable today, so adding a feed
        later is a provider registration rather than a re-scan.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)

        graph, _err = await self.topology.get_graph(str(account_id))
        generated_at = (graph.meta or {}).get("generated_at", "") if graph is not None else ""
        inputs = await self._inputs(account_id, provider, generated_at)

        identities = [
            vulnerability.identify(r, provider or "") for r in inputs["resources"]
        ]
        assessable = [i for i in identities if i.status != vulnerability.NOT_APPLICABLE]

        source = vulnerability.active_provider()
        found = source.lookup(assessable) if source.configured else {}

        # Which resources sit on a traced path — reused from the cached walk.
        on_path: Dict[str, List[str]] = {}
        try:
            analysis = await self.analyse(account_id, max_depth=max_depth, limit=0)
            for p in analysis.get("paths") or []:
                for n in p.get("nodes") or []:
                    if n.get("id"):
                        on_path.setdefault(n["id"], []).append(p["path_id"])
        except ValueError:
            pass

        rows = [
            vulnerability.correlate(
                i,
                found.get(i.resource_id, []),
                exposure=inputs["exposure_by_id"].get(i.resource_id),
                attack_path_ids=on_path.get(i.resource_id, []),
            )
            for i in assessable
        ]
        # Reachable first, then worst identity status — so the rows an operator
        # can act on, and the gaps they can close, both surface above the noise.
        rows.sort(key=lambda r: (
            not r["internet_reachable"],
            r["identity"]["status"] != vulnerability.RESOLVED,
            r["resource_name"] or "",
        ))

        return {
            "account_id": str(account_id),
            "provider": provider,
            "source_configured": source.configured,
            "source": {
                "name": source.name,
                "description": source.description,
                "unavailable_reason": source.unavailable_reason(),
            },
            "providers": vulnerability.available_providers(),
            "coverage": vulnerability.coverage(identities),
            "resources": rows,
            "total_assessable": len(assessable),
            "vulnerabilities_found": sum(r["vulnerability_count"] for r in rows),
            "empty_means": (
                "not assessed — no vulnerability source is configured"
                if not source.configured else
                "assessed against the configured source"
            ),
        }

    # ── ransomware resilience ────────────────────────────────────────────────

    async def ransomware_posture(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Recovery-control posture for every data store.

        Reads the findings the engine already produced rather than re-deriving
        anything, so this view and the Findings tab cannot disagree about
        whether a bucket has versioning — they are literally the same row.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)

        graph, _err = await self.topology.get_graph(str(account_id))
        generated_at = (graph.meta or {}).get("generated_at", "") if graph is not None else ""
        inputs = await self._inputs(account_id, provider, generated_at)

        findings = await self.repo.findings_for_account(
            account_id, statuses=ACTIVE_FINDING_STATUSES)

        out = ransomware.posture(
            provider=provider or "",
            resources=inputs["resources"],
            findings=findings,
        )
        out["account_id"] = str(account_id)
        return out

    # ── behavioural threat detection ─────────────────────────────────────────

    async def threats(
        self, account_id: uuid.UUID, *, days: int = 30,
    ) -> Dict[str, Any]:
        """Behavioural detections over the Event Log for this account.

        Reads `cloud_events` directly — the same rows the Event Log tab renders
        — so a detection can always be traced to events the operator can open.
        Bounded by `days` because the detectors are windowed and an unbounded
        read of a busy account's audit trail is not a page load.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")

        since = datetime.now(timezone.utc) - timedelta(days=days)

        # Cheap probe first: how many events, and how recent. Both change only
        # when the collector runs, so they make a correct cache key without
        # reading a single event row.
        stamp = (await self.db.execute(
            select(func.count(), func.max(CloudEvent.timestamp))
            .where(CloudEvent.account_id == account_id,
                   CloudEvent.timestamp >= since)
        )).one()
        cache_key = f"{account_id}|{days}|{stamp[0]}|{stamp[1]}"
        hit = _DETECTIONS.get(str(account_id))
        if hit and hit[0] == cache_key:
            return dict(hit[1])

        # Only the columns the detectors actually read. Selecting whole ORM
        # rows pulled each event's JSONB payload, `resources` list and raw
        # provider body as well — on a 14,574-event account that was ~6s per
        # request, and `incidents()` paid it twice because it calls this.
        # Narrowing the projection is most of the fix; the cache is the rest.
        cols = (
            CloudEvent.id, CloudEvent.timestamp, CloudEvent.event_name,
            CloudEvent.event_category, CloudEvent.action, CloudEvent.status,
            CloudEvent.risk_level, CloudEvent.actor_id, CloudEvent.actor_name,
            CloudEvent.actor_type, CloudEvent.resource_id,
            CloudEvent.resource_name, CloudEvent.source_ip,
            CloudEvent.source_location, CloudEvent.region,
        )
        rows = (await self.db.execute(
            select(*cols)
            .where(CloudEvent.account_id == account_id,
                   CloudEvent.timestamp >= since)
            .order_by(CloudEvent.timestamp)
        )).all()
        events = [_EventView(r) for r in rows]

        out = threat.detect(events)
        out["account_id"] = str(account_id)
        out["provider"] = normalize_provider(account.provider)
        out["window_days"] = days
        out["window_start"] = since.isoformat()
        _DETECTIONS[str(account_id)] = (cache_key, dict(out))
        if not events:
            out["empty_means"] = (
                f"No events have been collected for this account in the last "
                f"{days} days, so no behaviour could be assessed. This is not a "
                f"statement that nothing happened."
            )
        return out

    # ── correlated incidents ─────────────────────────────────────────────────

    async def incidents(
        self, account_id: uuid.UUID, *, days: int = 30, max_depth: int = 6,
    ) -> Dict[str, Any]:
        """Signals from every subsystem, grouped by the subject they concern.

        Deliberately a pure join over outputs that already exist: the findings
        the engine stored, the detections `threats()` produced, the paths
        `analyse()` walked and the exposure verdicts in the shared input cache.
        Nothing is recomputed, so an incident cannot disagree with the tab its
        signals came from.
        """
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)

        graph, _err = await self.topology.get_graph(str(account_id))
        generated_at = (graph.meta or {}).get("generated_at", "") if graph is not None else ""
        inputs = await self._inputs(account_id, provider, generated_at)

        findings = await self.repo.findings_for_account(
            account_id, statuses=ACTIVE_FINDING_STATUSES)

        detections = (await self.threats(account_id, days=days)).get("detections") or []
        try:
            paths = (await self.analyse(
                account_id, max_depth=max_depth, limit=0)).get("paths") or []
        except ValueError:
            paths = []

        out = incident.correlate(
            findings=findings,
            detections=detections,
            attack_paths=paths,
            exposures=inputs["exposures"],
            resources=inputs["resources"],
        )
        out["account_id"] = str(account_id)
        out["provider"] = provider
        out["window_days"] = days
        return out

    # ── one path ─────────────────────────────────────────────────────────────

    async def path_detail(
        self, account_id: uuid.UUID, path_id: str, *, max_depth: int = 6
    ) -> Optional[Dict[str, Any]]:
        """One path with its full node and hop detail.

        Recomputes (hitting the cache in the normal case) and selects, rather
        than storing paths by id. `path_id` is a hash of the node sequence, so
        the same route through the same estate resolves to the same path across
        calls; a path that no longer exists returns None rather than a stale copy.
        """
        full = await self.analyse(account_id, max_depth=max_depth, limit=0)
        for row in full.get("paths") or []:
            if row["path_id"] == path_id:
                return row
        return None
