"""Topology service — builds, caches and answers questions about the graph.

Edges are only ever drawn from data the provider actually reported. Nothing
here guesses: an earlier version matched resource names by substring and
invented relationships that did not exist, which is worse than a sparse graph
because a wrong edge is indistinguishable from a real one. The rules themselves
live in `app/topology/rules.py` and the resolver in `app/topology/builder.py`;
this module is orchestration — scope resolution, caching, filtering, and the
per-question endpoints.

## Why the graph is cached, and how it is invalidated

Building the graph reads every resource row for the scope and applies every
rule. That is fine once, and wasteful on the fifth click of a node. So the
built graph is held in process and reused — but never on a timer.

A time-to-live is the wrong tool here. It either serves a graph that is known
to be out of date (a scan landed two seconds ago) or rebuilds one that is known
to be current, and both are avoidable, because everything the graph is derived
from carries a monotonic high-water mark. `TopologyRepository.fingerprint`
reads those marks, and the cache is valid exactly while they are unchanged.
Section 70's invalidation triggers — discovery completed, resource changed,
drift scan completed — are all covered by that comparison rather than by
each one having to remember to call an invalidate hook.

Section 72's staleness warning is a separate matter and deliberately so: the
cache can be perfectly current while the *inventory* is hours old. The response
reports the inventory's age from the accounts' own `last_discovery`, so
"topology generated just now" never gets mistaken for "your cloud looked like
this just now".
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.events.redaction import redact
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository
from app.repository.topology_repo import TopologyRepository
from app.services.exposure_service import compute_exposure
from app.topology.builder import build_graph
from app.topology.graph import Graph
from app.topology.model import (
    DEPENDENCY_CLASSES,
    SYNTHETIC_TYPES,
    VIEW_MODES,
    kinds_for_view,
    relationship_catalog,
)
from app.topology.rules import EXCLUDED_FIELDS, RULES

logger = logging.getLogger("cloud_svc.topology")

# How long an inventory may go unrefreshed before the UI is told to say so.
STALE_AFTER_SECONDS = 6 * 3600

# Graph cache: scope -> (fingerprint, graph, built_at_monotonic, built_at_utc).
# Bounded, because "ALL" plus a handful of accounts is the realistic working
# set and an unbounded dict keyed by user input is a slow leak.
_CACHE: Dict[str, Tuple[tuple, Graph, float, str]] = {}
_CACHE_MAX = 12


def _cache_put(scope: str, fingerprint: tuple, graph: Graph, built_at: str) -> None:
    if len(_CACHE) >= _CACHE_MAX and scope not in _CACHE:
        # Evict the least recently built. There is no access-time tracking
        # because a scope is rebuilt far more often than it is evicted, and
        # build time is the cost that matters.
        oldest = min(_CACHE.items(), key=lambda kv: kv[1][2])[0]
        _CACHE.pop(oldest, None)
    _CACHE[scope] = (fingerprint, graph, time.monotonic(), built_at)


def invalidate_cache(scope: Optional[str] = None) -> None:
    """Drop cached graphs. Called after a discovery scan writes new inventory.

    Not strictly required — the fingerprint would catch the change on the next
    request anyway — but it turns "correct on the next request" into "correct
    and already rebuilt", and it makes the invalidation points in section 70
    explicit in the code rather than implicit in a comparison.
    """
    if scope is None:
        _CACHE.clear()
    else:
        _CACHE.pop(scope, None)
        _CACHE.pop("ALL", None)


class TopologyService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.resources = ResourceRepository(db)
        self.accounts = CloudAccountRepository(db)
        self.repo = TopologyRepository(db)

    # ── scope ────────────────────────────────────────────────────────────────

    async def _resolve_scope(
        self, scope: str
    ) -> Tuple[Optional[List[uuid.UUID]], List[Any], Optional[str]]:
        """(account ids to include, the account rows, error).

        `ALL` means every account. A provider name (`AWS`, `Azure`, `OCI`)
        means every account of that provider, which is what the cloud filter
        chips in section 74 select. Anything else must be an account UUID.
        """
        accounts = await self.repo.accounts()
        if scope == "ALL":
            return None, accounts, None

        upper = scope.upper()
        provider_keys = {"AWS": "AWS", "AZURE": "Azure", "OCI": "OCI", "ORACLE": "OCI"}
        if upper in provider_keys:
            wanted = provider_keys[upper]
            matched = [
                a for a in accounts
                if ("OCI" if a.provider == "Oracle" else a.provider) == wanted
            ]
            return [a.id for a in matched], accounts, None

        try:
            account_id = uuid.UUID(scope)
        except ValueError:
            return None, accounts, "Invalid scope. Expected 'ALL', a provider name, or an account UUID."
        return [account_id], accounts, None

    # ── graph construction ───────────────────────────────────────────────────

    async def get_graph(self, scope: str, *, refresh: bool = False) -> Tuple[Optional[Graph], Optional[str]]:
        account_ids, accounts, error = await self._resolve_scope(scope)
        if error:
            return None, error

        fingerprint = await self.repo.fingerprint(account_ids)
        cached = _CACHE.get(scope)
        if cached and cached[0] == fingerprint and not refresh:
            return cached[1], None

        started = time.perf_counter()
        if account_ids is None:
            resources = await self.resources.list_all()
        elif len(account_ids) == 1:
            resources = await self.resources.list_by_account(account_ids[0])
        else:
            # Several accounts (a provider scope). One pass over everything and
            # a filter beats N round trips, and the inventory is already fully
            # loaded for the ALL case anyway.
            wanted = set(account_ids)
            resources = [
                r for r in await self.resources.list_all() if r.account_id in wanted
            ]

        graph = build_graph(resources, accounts, scope=scope)
        await self._annotate(graph, resources, account_ids)

        graph.meta = {
            "scope": scope,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "build_ms": round((time.perf_counter() - started) * 1000, 1),
            "account_ids": [str(a) for a in account_ids] if account_ids else None,
        }
        _cache_put(scope, fingerprint, graph, graph.meta["generated_at"])
        logger.info(
            "Built topology for %s: %d nodes, %d edges in %sms",
            scope, graph.node_count, graph.edge_count, graph.meta["build_ms"],
        )
        return graph, None

    async def _annotate(
        self,
        graph: Graph,
        resources: Sequence[Any],
        account_ids: Optional[Sequence[uuid.UUID]],
    ) -> None:
        """Attach drift, activity and exposure to each node.

        All three come from data this product already holds and can defend:
        the append-only change log, the audit trail, and the exposure engine's
        rule evaluation over the security groups actually attached. None of it
        is inferred from a resource's name or type.
        """
        drift = await self.repo.drift_by_resource(account_ids)
        events = await self.repo.events_by_resource(account_ids)

        # The exposure engine needs the resource rows, not the nodes — it reads
        # security group rules off the referenced resources.
        try:
            exposure = compute_exposure(list(resources))
        except Exception as exc:  # never let an analysis failure blank the graph
            logger.warning("Exposure analysis failed for the topology: %s", exc)
            exposure = {"exposed_resources": []}
        exposed_by_id = {
            row["resource_id"]: row for row in exposure.get("exposed_resources", [])
        }

        for node in graph.nodes:
            provider_id = node.get("provider_id")
            if provider_id and provider_id in drift:
                node.update(drift[provider_id])
            else:
                node["drift_count"] = 0
                node["last_drift_at"] = None
                node["significant_drift_count"] = 0
            if provider_id and provider_id in events:
                node.update(events[provider_id])
            else:
                node["event_count"] = 0
                node["last_event_at"] = None
                node["high_risk_event_count"] = 0

            hit = exposed_by_id.get(node["id"])
            if hit:
                node["exposed"] = True
                node["exposure_severity"] = hit["severity"]
                node["exposure_public_ip"] = hit["public_ip"]
                node["exposure_confidence"] = hit["confidence"]
                node["exposure_open_ports"] = [
                    {"port": p.get("port"), "label": p.get("label"),
                     "severity": p.get("severity"), "protocol": p.get("protocol")}
                    for p in hit.get("open_ports", [])
                ]
            else:
                node["exposed"] = False
                node["exposure_severity"] = None

    # ── filtering ────────────────────────────────────────────────────────────

    @staticmethod
    def _matches(node: Dict[str, Any], filters: Dict[str, Any]) -> bool:
        """Server-side node filtering (sections 42, 64).

        Absent filter values never exclude anything. A filter for a field the
        provider did not report excludes the node — which is correct: asking
        for "health = Healthy" should not return resources whose health is
        unknown, because that would be asserting a health we never measured.
        """
        if filters.get("provider") and node.get("provider") != filters["provider"]:
            return False
        if filters.get("account_id") and node.get("account_id") != filters["account_id"]:
            return False
        # Filtering by NAME as well as by id, because the facet dropdowns are
        # built from the graph's own values and those are names — that is what
        # a person picks from a list. The id filter stays for callers that have
        # one (a link from another page), and neither is used as identity: this
        # is a display filter, not a relationship.
        if filters.get("account_name") and node.get("account_name") != filters["account_name"]:
            return False
        if filters.get("region") and node.get("region") != filters["region"]:
            return False
        if filters.get("resource_type") and node.get("type") != filters["resource_type"]:
            return False
        if filters.get("category") and node.get("category") != filters["category"]:
            return False
        if filters.get("status") and (node.get("status") or "") != filters["status"]:
            return False
        if filters.get("health") and node.get("health") != filters["health"]:
            return False
        if filters.get("resource_group") and node.get("resource_group") != filters["resource_group"]:
            return False
        if filters.get("compartment_id") and node.get("compartment_id") != filters["compartment_id"]:
            return False
        if filters.get("compartment_name") and node.get("compartment_name") != filters["compartment_name"]:
            return False
        if filters.get("has_drift") and not node.get("drift_count"):
            return False
        if filters.get("has_events") and not node.get("event_count"):
            return False
        if filters.get("exposed") and not node.get("exposed"):
            return False
        if filters.get("exposure_severity"):
            if node.get("exposure_severity") != filters["exposure_severity"]:
                return False
        if filters.get("has_broad_access") and not node.get("broad_access"):
            return False
        return True

    @staticmethod
    def _search_hit(node: Dict[str, Any], needle: str) -> bool:
        """Section 41's fields, matched case-insensitively as a substring.

        Substring matching is right for a SEARCH BOX and wrong for edge
        resolution — the distinction the original implementation's history
        turns on. A search shows the user candidates to choose from; an edge
        asserts a fact. Only the first is allowed to be fuzzy.
        """
        if not needle:
            return True
        for field in (
            "name", "provider_id", "type", "category", "provider", "region",
            "account_name", "ip_address", "private_ip", "public_ip",
            "resource_group", "compartment_name", "subscription_id",
            "availability_zone",
        ):
            value = node.get(field)
            if isinstance(value, str) and needle in value.lower():
                return True
        return False

    # ── the main topology payload ────────────────────────────────────────────

    async def topology(
        self,
        scope: str,
        *,
        view: Optional[str] = None,
        search: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        hide_defaults: bool = False,
        hide_isolated: bool = False,
        hide_empty_containers: bool = False,
        refresh: bool = False,
        node_limit: Optional[int] = None,
        context_hops: int = 0,
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope, refresh=refresh)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}

        kinds = kinds_for_view(view)
        filters = filters or {}
        needle = (search or "").strip().lower()

        # 1. node filter
        keep: List[Dict[str, Any]] = []
        for node in graph.nodes:
            if hide_defaults and node.get("is_default"):
                continue
            if not self._matches(node, filters):
                continue
            if needle and not self._search_hit(node, needle):
                continue
            keep.append(node)

        keep_ids = {n["id"] for n in keep}
        matched_ids = set(keep_ids)

        # 1b. optional context around the matches.
        #
        # A filter that keeps only what matched produces a graph with no edges
        # the moment the filter is narrower than a relationship: asking for
        # "Storage" returns 226 volumes and zero connections, because every
        # volume's counterpart is a compute instance that the filter excluded.
        # That is a correct answer to the wrong question — nobody wants a
        # disconnected dust cloud. Pulling in each match's immediate
        # neighbours restores the relationships that make the selection
        # legible, and the response marks which nodes actually matched so the
        # UI can show the context differently from the result.
        if context_hops > 0 and matched_ids and len(matched_ids) < graph.node_count:
            expanded = set(matched_ids)
            frontier = set(matched_ids)
            for _ in range(min(context_hops, 3)):
                nxt: Set[str] = set()
                for node_id in frontier:
                    for _idx, other in graph.incident(node_id, kinds):
                        if other not in expanded:
                            nxt.add(other)
                expanded |= nxt
                frontier = nxt
                if not frontier:
                    break
            keep = [n for n in graph.nodes if n["id"] in expanded]
            keep_ids = expanded

        # 2. edges, restricted to the view mode and to surviving nodes
        edges = [
            e for e in graph.edges
            if e["source"] in keep_ids and e["target"] in keep_ids
            and (kinds is None or e["type"] in kinds)
        ]

        # 3. optional hiding that depends on the edges that survived
        if hide_isolated or hide_empty_containers:
            connected: Set[str] = set()
            for edge in edges:
                connected.add(edge["source"])
                connected.add(edge["target"])
            filtered: List[Dict[str, Any]] = []
            for node in keep:
                lonely = node["id"] not in connected
                if lonely and hide_empty_containers and node.get("type") in SYNTHETIC_TYPES:
                    continue
                if lonely and hide_isolated:
                    continue
                filtered.append(node)
            keep = filtered
            keep_ids = {n["id"] for n in keep}
            edges = [
                e for e in edges if e["source"] in keep_ids and e["target"] in keep_ids
            ]

        truncated = False
        total_matching = len(keep)
        if node_limit and len(keep) > node_limit:
            # Keep the most connected nodes: an arbitrary slice of a large
            # graph is worse than a small graph, because the parts a user
            # navigates from are the hubs. The response says it happened.
            keep = sorted(
                keep, key=lambda n: -(n.get("connection_count") or 0)
            )[:node_limit]
            keep_ids = {n["id"] for n in keep}
            edges = [
                e for e in edges if e["source"] in keep_ids and e["target"] in keep_ids
            ]
            truncated = True

        if len(matched_ids) != len(keep_ids):
            # Shallow copies: the cached graph's node dicts are shared, and
            # writing a per-request flag onto them would leak this request's
            # filter into the next one's response.
            keep = [
                {**node, "matched": node["id"] in matched_ids} for node in keep
            ]

        return {
            "scope": scope,
            "account_id": scope,  # kept: the previous payload's field name
            "nodes": keep,
            "matched_nodes": len(matched_ids),
            "context_hops": context_hops,
            "edges": edges,
            "total_nodes": len(keep),
            "total_edges": len(edges),
            "graph_nodes": graph.node_count,
            "graph_edges": graph.edge_count,
            "matching_nodes": total_matching,
            "truncated": truncated,
            "edge_type_counts": graph.edge_type_counts(edges),
            "isolated_nodes": self._count_isolated(keep, edges),
            "default_nodes": sum(1 for n in graph.nodes if n.get("is_default")),
            "view": view or "infrastructure",
            "relationship_catalog": relationship_catalog(),
            "view_modes": {
                key: {"label": mode["label"], "description": mode["description"]}
                for key, mode in VIEW_MODES.items()
            },
            "coverage": graph.coverage(),
            # Kept for compatibility with the previous payload, which reported
            # unresolved references as a reason -> count map.
            "unresolved_references": {
                row["gap"]: row["count"]
                for row in graph.unresolved_report()["by_reason"]
            },
            "facets": self._facets(graph),
            **await self._provenance(scope, graph),
        }

    @staticmethod
    def _count_isolated(
        nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]
    ) -> int:
        connected: Set[str] = set()
        for edge in edges:
            connected.add(edge["source"])
            connected.add(edge["target"])
        return sum(1 for n in nodes if n["id"] not in connected)

    @staticmethod
    def _facets(graph: Graph) -> Dict[str, List[Dict[str, Any]]]:
        """The distinct values each filter can take, with counts.

        Computed from the graph rather than hardcoded, so a dropdown can never
        offer a region or a resource type this account does not have — and the
        counts make it obvious where the resources are.
        """
        def tally(field: str) -> List[Dict[str, Any]]:
            counts: Dict[Any, int] = {}
            for node in graph.nodes:
                value = node.get(field)
                if value in (None, ""):
                    continue
                counts[value] = counts.get(value, 0) + 1
            return [
                {"value": value, "count": count}
                for value, count in sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))
            ]

        return {
            "provider": tally("provider"),
            "account": [
                {"value": row["value"], "count": row["count"]}
                for row in tally("account_name")
            ],
            "region": tally("region"),
            "resource_type": tally("type"),
            "category": tally("category"),
            "status": tally("status"),
            "health": tally("health"),
            "resource_group": tally("resource_group"),
            "compartment": tally("compartment_name"),
        }

    async def _provenance(self, scope: str, graph: Graph) -> Dict[str, Any]:
        """When this graph was built, and how old the inventory behind it is.

        These are two different ages and the difference matters (section 72):
        the graph can be a millisecond old and built from a scan that ran
        yesterday. Reporting only the first would be a claim of real-time data
        the inventory cannot support.
        """
        account_ids, accounts, _ = await self._resolve_scope(scope)
        wanted = set(account_ids) if account_ids else None
        relevant = [a for a in accounts if wanted is None or a.id in wanted]

        discoveries = [a.last_discovery for a in relevant if a.last_discovery]
        oldest = min(discoveries) if discoveries else None
        newest = max(discoveries) if discoveries else None
        now = datetime.now(timezone.utc)

        def age(moment: Optional[datetime]) -> Optional[int]:
            if not moment:
                return None
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            return int((now - moment).total_seconds())

        never_scanned = [a.account_name for a in relevant if not a.last_discovery]
        oldest_age = age(oldest)

        jobs = await self.repo.latest_discovery_jobs()
        failed = []
        for account in relevant:
            job = jobs.get(str(account.id)) or {}
            if job.get("status") != "FAILED":
                continue
            detail = job.get("error_detail") or ""
            failed.append({
                "account_id": str(account.id),
                "account_name": account.account_name,
                "provider": "OCI" if account.provider == "Oracle" else account.provider,
                "error": detail[:400] or None,
                # Named from the provider's own words, never guessed from an
                # empty result: an account can legitimately hold nothing.
                "permission_problem": bool(detail and any(
                    marker in detail.lower()
                    for marker in (
                        "authorizationfailed", "accessdenied", "not authorized",
                        "forbidden", "unauthorized", "permission",
                        "notauthorizedornotfound",
                    )
                )),
            })

        return {
            "topology_generated_at": (graph.meta or {}).get("generated_at"),
            "build_ms": (graph.meta or {}).get("build_ms"),
            "inventory": {
                "last_discovery_oldest": oldest.isoformat() if oldest else None,
                "last_discovery_newest": newest.isoformat() if newest else None,
                "oldest_age_seconds": oldest_age,
                "stale": bool(oldest_age is not None and oldest_age > STALE_AFTER_SECONDS),
                "stale_after_seconds": STALE_AFTER_SECONDS,
                "accounts_never_scanned": never_scanned,
                "accounts_with_failed_scan": failed,
                "note": (
                    "The topology is derived from the last discovery scan, not "
                    "from a live provider query. It shows the infrastructure as "
                    "of that scan."
                ),
            },
        }

    # ── per-resource ─────────────────────────────────────────────────────────

    async def resource_topology(
        self,
        scope: str,
        resource_id: str,
        *,
        hops: int = 2,
        view: Optional[str] = None,
        include_raw: bool = False,
    ) -> Dict[str, Any]:
        """Everything about one resource and exactly how it connects.

        Section 66's endpoint: this is what stops the frontend downloading a
        whole cloud to inspect a single instance.
        """
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}

        node = graph.node(resource_id)
        if node is None:
            # A provider identifier is just as valid a way to name a resource,
            # and it is what an Event Log row or a drift row carries.
            match = next(
                (n for n in graph.nodes if n.get("provider_id") == resource_id), None
            )
            if match is None:
                return {
                    "found": False,
                    "reason": "not_in_topology",
                    "detail": (
                        "No resource with this id is in the current topology for "
                        "this scope. It may belong to another account, or it may "
                        "not have been returned by the last discovery scan."
                    ),
                }
            node = match

        node_id = node["id"]
        neighborhood = graph.neighborhood(
            node_id, hops=max(1, min(hops, 5)), kinds=kinds_for_view(view)
        )
        connections = graph.connections_of(node_id)
        dependencies = graph.dependencies_of(node_id)

        # The unresolved references this resource itself registered — the
        # honest answer to "why does it have no subnet edge?"
        own_unresolved = [
            ref for ref in graph.unresolved if ref.get("resource_id") == node_id
        ]

        payload: Dict[str, Any] = {
            "found": True,
            "scope": scope,
            "resource": node,
            "neighbors": neighborhood["nodes"],
            "edges": neighborhood["edges"],
            "depth": neighborhood["depth"],
            "truncated": neighborhood["truncated"],
            "hops": neighborhood["hops"],
            "inbound": connections["inbound"],
            "outbound": connections["outbound"],
            "depends_on": dependencies["depends_on"],
            "depended_on_by": dependencies["depended_on_by"],
            "connection_count": graph.degree(node_id),
            "unresolved_references": own_unresolved,
            "topology_generated_at": (graph.meta or {}).get("generated_at"),
        }

        # Configuration and the raw provider payload come from the row, not the
        # node, because the graph deliberately does not carry them.
        if not node.get("is_synthetic"):
            try:
                row = await self.repo.resource(uuid.UUID(node_id))
            except (ValueError, TypeError):
                row = None
            if row is not None:
                config, config_redacted = redact(row.config or {})
                metadata, meta_redacted = redact(row.metadata_ or {})
                payload["configuration"] = config
                payload["metadata"] = metadata
                payload["tags"] = row.tags or {}
                payload["redacted"] = bool(config_redacted or meta_redacted)
                if include_raw:
                    raw, raw_redacted = redact(row.raw_data or {})
                    payload["raw_data"] = raw
                    payload["redacted"] = bool(payload["redacted"] or raw_redacted)
        return payload

    async def neighbors(
        self,
        scope: str,
        resource_id: str,
        *,
        hops: int = 1,
        view: Optional[str] = None,
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        result = graph.neighborhood(
            resource_id, hops=max(1, min(hops, 5)), kinds=kinds_for_view(view)
        )
        if not result["found"]:
            return {"found": False, "reason": "not_in_topology"}
        return {**result, "scope": scope}

    # ── path, impact ─────────────────────────────────────────────────────────

    async def path(
        self,
        scope: str,
        source: str,
        target: str,
        *,
        max_depth: int = 6,
        view: Optional[str] = None,
        relationship_types: Optional[Iterable[str]] = None,
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}

        kinds: Optional[FrozenSet[str]] = None
        if relationship_types:
            kinds = frozenset(relationship_types)
        elif view:
            kinds = kinds_for_view(view)

        result = graph.find_path(
            source, target, max_depth=max(1, min(max_depth, 12)), kinds=kinds
        )
        if not result["found"]:
            result["detail"] = (
                "The two resources are both in the topology, but no chain of "
                "provider-confirmed relationships connects them within the "
                "search depth. No path is drawn, because a path that the "
                "providers do not report is one this feature would be "
                "inventing."
                if result.get("reason") == "no_confirmed_path" else
                "One or both resources are not in the current topology for "
                "this scope."
            )
        return {**result, "scope": scope}

    async def impact(
        self, scope: str, resource_id: str, *, max_depth: int = 4
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        result = graph.impact(resource_id, max_depth=max(1, min(max_depth, 8)))
        if not result.get("found"):
            return {"found": False, "reason": "not_in_topology"}
        node = graph.node(resource_id)
        return {
            **result,
            "scope": scope,
            "resource": node,
            "dependency_classes": list(DEPENDENCY_CLASSES),
        }

    # ── coverage, unresolved, diagnostics ────────────────────────────────────

    async def coverage(self, scope: str) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        return {
            "scope": scope,
            **graph.coverage(),
            "isolated": graph.isolated_report()["by_reason"],
            **await self._provenance(scope, graph),
        }

    async def unresolved(self, scope: str, *, limit: int = 500) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        return {"scope": scope, **graph.unresolved_report(limit=limit)}

    async def isolated(self, scope: str) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        return {"scope": scope, **graph.isolated_report()}

    async def diagnostics(self, scope: str) -> Dict[str, Any]:
        """The operational view: what we have, what we are missing, and why.

        Section 89. Everything here is a measurement or a documented product
        limitation — there are no estimates.
        """
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}

        account_ids, accounts, _ = await self._resolve_scope(scope)
        wanted = set(account_ids) if account_ids else None
        relevant = [a for a in accounts if wanted is None or a.id in wanted]

        counts = await self.repo.resource_counts_by_account()
        jobs = await self.repo.latest_discovery_jobs()

        provider_status: List[Dict[str, Any]] = []
        permission_gaps = 0
        for account in relevant:
            account_id = str(account.id)
            job = jobs.get(account_id) or {}
            resource_count = counts.get(account_id, 0)
            detail = job.get("error_detail")
            # A permission problem is what the provider said it was. This is
            # not classified from the resource count: an account can legitimately
            # hold nothing.
            looks_like_permission = bool(
                detail and any(
                    marker in detail.lower()
                    for marker in (
                        "authorizationfailed", "accessdenied", "not authorized",
                        "forbidden", "unauthorized", "permission",
                        "notauthorizedornotfound",
                    )
                )
            )
            if looks_like_permission:
                permission_gaps += 1

            if job.get("status") == "FAILED":
                state = "scan_failed"
            elif not job:
                state = "never_scanned"
            elif resource_count == 0:
                state = "no_resources"
            else:
                state = "ok"

            provider_status.append({
                "account_id": account_id,
                "account_name": account.account_name,
                "provider": "OCI" if account.provider == "Oracle" else account.provider,
                "environment": account.environment,
                "resources": resource_count,
                "state": state,
                "last_discovery": (
                    account.last_discovery.isoformat() if account.last_discovery else None
                ),
                "last_job_status": job.get("status"),
                "last_job_error": detail,
                "permission_problem": looks_like_permission,
                "explanation": {
                    "scan_failed": (
                        "The last discovery scan failed, so this account's "
                        "resources and relationships may be missing or out of "
                        "date. The provider's own error is shown above."
                    ),
                    "never_scanned": (
                        "No discovery scan has run for this account, so there "
                        "is nothing to build a topology from yet."
                    ),
                    "no_resources": (
                        "The last scan completed and returned no resources. "
                        "This is a real empty account unless the credentials "
                        "lack read permission on the resource APIs."
                    ),
                    "ok": None,
                }[state],
            })

        unresolved = graph.unresolved_report()
        return {
            "scope": scope,
            "resources": graph.node_count,
            "relationships": graph.edge_count,
            "edge_type_counts": graph.edge_type_counts(),
            "unresolved": {
                "total": unresolved["total"],
                "missing_target": unresolved["missing_target"],
                "unsupported_type": unresolved["unsupported_type"],
                "by_reason": unresolved["by_reason"],
            },
            "isolated": graph.isolated_report()["by_reason"],
            "coverage": graph.coverage(),
            "accounts": provider_status,
            "permission_gaps": permission_gaps,
            "rules": {
                "active": len(RULES),
                "excluded_fields": [
                    {"field": field, "reason": reason}
                    for field, reason in sorted(EXCLUDED_FIELDS.items())
                ],
            },
            **await self._provenance(scope, graph),
        }

    # ── global / hierarchy view ──────────────────────────────────────────────

    async def global_view(self) -> Dict[str, Any]:
        """Level 1 (section 3): providers, their accounts, and the counts.

        Deliberately does NOT build any graph. It is the entry point, so it has
        to be fast even when every account holds thousands of resources, and
        every number on it comes from an aggregate rather than from walking a
        graph.
        """
        accounts = await self.repo.accounts()
        counts = await self.repo.resource_counts_by_account()
        jobs = await self.repo.latest_discovery_jobs()

        providers: Dict[str, Dict[str, Any]] = {}
        for account in accounts:
            provider = "OCI" if account.provider == "Oracle" else account.provider
            entry = providers.setdefault(provider, {
                "provider": provider,
                "accounts": [],
                "resources": 0,
                "account_count": 0,
            })
            resource_count = counts.get(str(account.id), 0)
            job = jobs.get(str(account.id)) or {}
            entry["accounts"].append({
                "account_id": str(account.id),
                "account_name": account.account_name,
                "environment": account.environment,
                "tenant_or_region": account.tenant_or_region,
                "resources": resource_count,
                "last_discovery": (
                    account.last_discovery.isoformat() if account.last_discovery else None
                ),
                "last_job_status": job.get("status"),
                "last_job_error": job.get("error_detail"),
            })
            entry["resources"] += resource_count
            entry["account_count"] += 1

        for entry in providers.values():
            entry["accounts"].sort(key=lambda a: a["account_name"])

        return {
            "providers": sorted(providers.values(), key=lambda p: p["provider"]),
            "total_accounts": len(accounts),
            "total_resources": sum(counts.values()),
            "note": (
                "Counts are of resources discovered by the last scan per "
                "account. Cross-cloud relationships are not shown because none "
                "are reported by the providers — see the multi-cloud note in "
                "the topology response."
            ),
        }

    # ── search ───────────────────────────────────────────────────────────────

    async def search(
        self, scope: str, query: str, *, limit: int = 50
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        needle = (query or "").strip().lower()
        if not needle:
            return {"scope": scope, "query": query, "results": [], "total": 0}

        hits = [n for n in graph.nodes if self._search_hit(n, needle)]

        def rank(node: Dict[str, Any]) -> tuple:
            name = (node.get("name") or "").lower()
            provider_id = (node.get("provider_id") or "").lower()
            # Exact identity first, then exact name, then name prefix, then the
            # rest. Sorting the results is the only place a substring match is
            # weighted; it never changes whether something matched.
            if provider_id == needle:
                tier = 0
            elif name == needle:
                tier = 1
            elif name.startswith(needle):
                tier = 2
            elif needle in name:
                tier = 3
            else:
                tier = 4
            return (tier, -(node.get("connection_count") or 0), name)

        hits.sort(key=rank)
        grouped: Dict[str, int] = {}
        for node in hits:
            provider = node.get("provider") or "Unknown"
            grouped[provider] = grouped.get(provider, 0) + 1

        return {
            "scope": scope,
            "query": query,
            "total": len(hits),
            "by_provider": [
                {"provider": provider, "count": count}
                for provider, count in sorted(grouped.items())
            ],
            "results": hits[:limit],
            "truncated": len(hits) > limit,
        }

    # ── edge explanation ─────────────────────────────────────────────────────

    async def edge(self, scope: str, edge_id: str) -> Dict[str, Any]:
        """One relationship, with both endpoints and its evidence.

        Section 11's panel. The evidence was recorded by the same rule that
        drew the edge, so this cannot describe a different field than the one
        actually used.
        """
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        edge = graph.edge(edge_id)
        if edge is None:
            return {"found": False, "reason": "unknown_edge"}
        return {
            "found": True,
            "scope": scope,
            "edge": edge,
            "source": graph.node(edge["source"]),
            "target": graph.node(edge["target"]),
        }

    # ── snapshots and diff ───────────────────────────────────────────────────

    @staticmethod
    def _snapshot_nodes(graph: Graph) -> List[Dict[str, Any]]:
        return [
            {
                "key": node.get("provider_id") or node["id"],
                "name": node.get("name"),
                "type": node.get("type"),
                "category": node.get("category"),
                "provider": node.get("provider"),
                "region": node.get("region"),
                "account_name": node.get("account_name"),
            }
            for node in graph.nodes
        ]

    @staticmethod
    def _snapshot_edges(graph: Graph) -> List[Dict[str, Any]]:
        by_id = {n["id"]: (n.get("provider_id") or n["id"]) for n in graph.nodes}
        rows: List[Dict[str, Any]] = []
        for edge in graph.edges:
            source = by_id.get(edge["source"])
            target = by_id.get(edge["target"])
            if not source or not target:
                continue
            rows.append({
                "source": source,
                "target": target,
                "type": edge["type"],
                "label": edge.get("label"),
            })
        return rows

    async def take_snapshot(
        self,
        scope: str,
        *,
        label: Optional[str] = None,
        note: Optional[str] = None,
        taken_by: Optional[str] = None,
    ) -> Dict[str, Any]:
        graph, error = await self.get_graph(scope)
        if error or graph is None:
            return {"error": error or "Topology unavailable"}
        coverage = graph.coverage()
        snapshot = await self.repo.save_snapshot(
            scope=scope,
            label=label,
            note=note,
            taken_by=taken_by,
            node_count=graph.node_count,
            edge_count=graph.edge_count,
            unresolved_count=coverage["unresolved_references"],
            nodes=self._snapshot_nodes(graph),
            edges=self._snapshot_edges(graph),
            coverage=coverage,
        )
        await self.db.commit()
        return snapshot.summary()

    async def list_snapshots(
        self, *, scope: Optional[str] = None, limit: int = 50
    ) -> Dict[str, Any]:
        rows = await self.repo.list_snapshots(scope=scope, limit=limit)
        return {
            "snapshots": [row.summary() for row in rows],
            "total": await self.repo.count_snapshots(scope=scope),
        }

    async def delete_snapshot(self, snapshot_id: str) -> Dict[str, Any]:
        try:
            parsed = uuid.UUID(snapshot_id)
        except ValueError:
            return {"deleted": False, "reason": "invalid_id"}
        deleted = await self.repo.delete_snapshot(parsed)
        await self.db.commit()
        return {"deleted": deleted}

    async def diff(
        self, snapshot_id: str, *, against: Optional[str] = None
    ) -> Dict[str, Any]:
        """Compare a snapshot with another snapshot, or with the live topology.

        Identity is the provider's resource id throughout (see the snapshot
        model's note). A resource that was deleted and recreated keeps its
        provider identity, so it reads as unchanged — which is right, because
        to anyone looking at the cloud it is the same resource.
        """
        try:
            parsed = uuid.UUID(snapshot_id)
        except ValueError:
            return {"error": "Invalid snapshot id."}
        base = await self.repo.get_snapshot(parsed)
        if base is None:
            return {"error": "Snapshot not found."}

        if against:
            try:
                other_id = uuid.UUID(against)
            except ValueError:
                return {"error": "Invalid comparison snapshot id."}
            other = await self.repo.get_snapshot(other_id)
            if other is None:
                return {"error": "Comparison snapshot not found."}
            after_nodes = other.nodes or []
            after_edges = other.edges or []
            after_label = other.label or other.taken_at.isoformat()
            after_at = other.taken_at.isoformat() if other.taken_at else None
            after_coverage = other.coverage
        else:
            graph, error = await self.get_graph(base.scope)
            if error or graph is None:
                return {"error": error or "Topology unavailable"}
            after_nodes = self._snapshot_nodes(graph)
            after_edges = self._snapshot_edges(graph)
            after_label = "Current"
            after_at = (graph.meta or {}).get("generated_at")
            after_coverage = graph.coverage()

        before_by_key = {n["key"]: n for n in (base.nodes or [])}
        after_by_key = {n["key"]: n for n in after_nodes}

        added = [after_by_key[k] for k in after_by_key.keys() - before_by_key.keys()]
        removed = [before_by_key[k] for k in before_by_key.keys() - after_by_key.keys()]

        def edge_key(edge: Dict[str, Any]) -> Tuple[str, str, str]:
            return (edge["source"], edge["target"], edge["type"])

        before_edges = {edge_key(e): e for e in (base.edges or [])}
        after_edge_map = {edge_key(e): e for e in after_edges}

        added_edges = [after_edge_map[k] for k in after_edge_map.keys() - before_edges.keys()]
        removed_edges = [before_edges[k] for k in before_edges.keys() - after_edge_map.keys()]
        # An edge whose endpoints and kind are the same but whose label moved —
        # "attached to (Running)" becoming "attached to (Stopped)" is a real
        # change in the relationship's state, not a new relationship.
        changed_edges = [
            {
                "source": key[0], "target": key[1], "type": key[2],
                "before_label": before_edges[key].get("label"),
                "after_label": after_edge_map[key].get("label"),
            }
            for key in before_edges.keys() & after_edge_map.keys()
            if before_edges[key].get("label") != after_edge_map[key].get("label")
        ]

        def sort_nodes(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return sorted(rows, key=lambda r: ((r.get("type") or ""), (r.get("name") or "")))

        def sort_edges(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return sorted(rows, key=lambda r: (r["type"], r["source"], r["target"]))

        return {
            "base": base.summary(),
            "compared_with": {
                "label": after_label,
                "taken_at": after_at,
                "node_count": len(after_nodes),
                "edge_count": len(after_edges),
                "coverage": after_coverage,
            },
            "added_resources": sort_nodes(added),
            "removed_resources": sort_nodes(removed),
            "added_relationships": sort_edges(added_edges),
            "removed_relationships": sort_edges(removed_edges),
            "changed_relationships": sorted(
                changed_edges, key=lambda r: (r["type"], r["source"])
            ),
            "summary": {
                "added_resources": len(added),
                "removed_resources": len(removed),
                "added_relationships": len(added_edges),
                "removed_relationships": len(removed_edges),
                "changed_relationships": len(changed_edges),
            },
            "identity_note": (
                "Resources and relationships are compared by provider resource "
                "id, not by our internal row id, so a resource that was "
                "re-created with the same identifier is not reported as removed "
                "and re-added."
            ),
        }


# ── backwards-compatible entry point ─────────────────────────────────────────

async def get_topology(account_id: uuid.UUID | str, db: AsyncSession) -> Dict[str, Any]:
    """The original single-function API, kept working.

    The route now calls the service directly, but this signature was the whole
    public surface of the module and nothing is gained by breaking any caller
    that still uses it.
    """
    return await TopologyService(db).topology(str(account_id))
