"""The topology graph and the questions you can ask it.

Separated from the builder on purpose (section 65): building the graph reads
every resource row and applies every rule, while answering "what are this
instance's neighbours" only needs an adjacency lookup. Keeping them apart is
what makes a per-resource endpoint cheap enough to call on every click instead
of shipping the whole cloud to the browser.

Nothing in this module invents relationships. Every traversal walks edges the
builder already emitted from provider data, so a path that does not exist here
does not exist in the provider's own view of the account either — which is why
`find_path` reports "no confirmed path" rather than falling back to something
looser.
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from app.topology.model import (
    DEPENDENCY_CLASS,
    DEPENDENCY_CLASSES,
    IMPACT_FLOW,
    ISOLATION_REASONS,
    RELATIONSHIPS,
    SYNTHETIC_TYPES,
)


class Graph:
    """Nodes, edges and the adjacency built once alongside them.

    Node and edge dicts are the API's wire shape — there is no separate
    serialization step, so what a traversal returns is exactly what the caller
    sees. Adjacency is maintained on insert rather than rebuilt per query.
    """

    __slots__ = (
        "nodes", "edges", "_node_by_id", "_out", "_in", "_edges_by_id",
        "unresolved", "meta",
    )

    def __init__(self) -> None:
        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self._node_by_id: Dict[str, Dict[str, Any]] = {}
        # node id -> list of (edge index, other node id)
        self._out: Dict[str, List[Tuple[int, str]]] = defaultdict(list)
        self._in: Dict[str, List[Tuple[int, str]]] = defaultdict(list)
        self._edges_by_id: Dict[str, int] = {}
        self.unresolved: List[Dict[str, Any]] = []
        self.meta: Dict[str, Any] = {}

    # ── construction ─────────────────────────────────────────────────────────

    def add_node(self, node: Dict[str, Any]) -> None:
        nid = node["id"]
        if nid in self._node_by_id:
            return
        self._node_by_id[nid] = node
        self.nodes.append(node)

    def add_edge(self, edge: Dict[str, Any]) -> None:
        idx = len(self.edges)
        self.edges.append(edge)
        self._edges_by_id[edge["id"]] = idx
        self._out[edge["source"]].append((idx, edge["target"]))
        self._in[edge["target"]].append((idx, edge["source"]))

    def has_node(self, node_id: str) -> bool:
        return node_id in self._node_by_id

    def node(self, node_id: str) -> Optional[Dict[str, Any]]:
        return self._node_by_id.get(node_id)

    def edge(self, edge_id: str) -> Optional[Dict[str, Any]]:
        idx = self._edges_by_id.get(edge_id)
        return self.edges[idx] if idx is not None else None

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def edge_count(self) -> int:
        return len(self.edges)

    # ── traversal primitives ─────────────────────────────────────────────────

    def _incident(
        self, node_id: str, kinds: Optional[FrozenSet[str]] = None
    ) -> List[Tuple[int, str]]:
        """Every edge touching `node_id`, either direction, as (index, other)."""
        out = self._out.get(node_id) or []
        inn = self._in.get(node_id) or []
        if kinds is None:
            return list(out) + list(inn)
        return [
            pair for pair in (list(out) + list(inn))
            if self.edges[pair[0]]["type"] in kinds
        ]

    def incident(
        self, node_id: str, kinds: Optional[FrozenSet[str]] = None
    ) -> List[Tuple[int, str]]:
        """Public form of `_incident`, for callers outside this class."""
        return self._incident(node_id, kinds)

    def degree(self, node_id: str) -> int:
        return len(self._out.get(node_id) or []) + len(self._in.get(node_id) or [])

    def neighborhood(
        self,
        node_id: str,
        *,
        hops: int = 2,
        kinds: Optional[FrozenSet[str]] = None,
        max_nodes: int = 600,
    ) -> Dict[str, Any]:
        """The subgraph within `hops` of one node, breadth-first.

        Relationships are followed in both directions. A subnet does not list
        the instances inside it — the instances name the subnet — so a
        direction-respecting walk from the subnet would find nothing, which is
        the opposite of what "show me this subnet's neighbours" means.

        `max_nodes` bounds an unlucky expansion: a hub like a resource group can
        reach a whole subscription in two hops. When the bound is hit the result
        says so rather than silently returning an arbitrary slice.
        """
        if node_id not in self._node_by_id:
            return {
                "found": False, "nodes": [], "edges": [], "depth": {},
                "truncated": False, "hops": hops,
            }

        depth: Dict[str, int] = {node_id: 0}
        order: List[str] = [node_id]
        edge_ids: Set[int] = set()
        queue: deque = deque([node_id])
        truncated = False

        while queue:
            current = queue.popleft()
            d = depth[current]
            if d >= hops:
                continue
            for idx, other in self._incident(current, kinds):
                edge_ids.add(idx)
                if other in depth:
                    continue
                if len(order) >= max_nodes:
                    truncated = True
                    continue
                depth[other] = d + 1
                order.append(other)
                queue.append(other)

        included = set(order)
        # Keep only edges whose BOTH ends made it in, so the returned subgraph
        # is internally consistent — an edge to a node that was cut by the bound
        # would render as a line to nowhere.
        edges = [
            self.edges[i] for i in sorted(edge_ids)
            if self.edges[i]["source"] in included and self.edges[i]["target"] in included
        ]
        return {
            "found": True,
            "nodes": [self._node_by_id[n] for n in order],
            "edges": edges,
            "depth": depth,
            "truncated": truncated,
            "hops": hops,
        }

    def find_path(
        self,
        source_id: str,
        target_id: str,
        *,
        max_depth: int = 6,
        kinds: Optional[FrozenSet[str]] = None,
    ) -> Dict[str, Any]:
        """A shortest confirmed relationship path between two nodes.

        Breadth-first, so the first path found is a shortest one. Edges are
        traversed in both directions and each hop reports which way the stored
        edge actually points, because "these two are related through the subnet"
        is the question, while the direction of each individual link is a
        property of that link that the UI shows separately.

        Returns `found: False` when no path exists within `max_depth`. There is
        deliberately no fallback: an unconfirmed path is exactly the invented
        relationship this whole feature refuses to draw.
        """
        if source_id not in self._node_by_id or target_id not in self._node_by_id:
            return {
                "found": False, "reason": "unknown_node",
                "nodes": [], "edges": [], "hops": [],
            }
        if source_id == target_id:
            return {
                "found": True, "nodes": [self._node_by_id[source_id]],
                "edges": [], "hops": [], "length": 0,
            }

        # previous[node] = (previous node, edge index)
        previous: Dict[str, Tuple[Optional[str], Optional[int]]] = {source_id: (None, None)}
        queue: deque = deque([(source_id, 0)])
        found = False

        while queue and not found:
            current, d = queue.popleft()
            if d >= max_depth:
                continue
            for idx, other in self._incident(current, kinds):
                if other in previous:
                    continue
                previous[other] = (current, idx)
                if other == target_id:
                    found = True
                    break
                queue.append((other, d + 1))

        if not found:
            return {
                "found": False,
                "reason": "no_confirmed_path",
                "nodes": [], "edges": [], "hops": [],
                "searched_depth": max_depth,
            }

        # Walk back from the target.
        chain: List[Tuple[str, Optional[int]]] = []
        cursor: Optional[str] = target_id
        while cursor is not None:
            prev, idx = previous[cursor]
            chain.append((cursor, idx))
            cursor = prev
        chain.reverse()

        node_ids = [c[0] for c in chain]
        edges: List[Dict[str, Any]] = []
        hops: List[Dict[str, Any]] = []
        for position in range(1, len(chain)):
            node_id, idx = chain[position]
            assert idx is not None
            edge = self.edges[idx]
            edges.append(edge)
            previous_id = chain[position - 1][0]
            hops.append({
                "from": previous_id,
                "to": node_id,
                "edge_id": edge["id"],
                "relationship": edge["type"],
                "label": edge.get("label"),
                # True when the stored edge runs the same way we walked it.
                # A path can legitimately traverse an edge backwards, and the
                # analyst needs to see which, because a permission edge walked
                # backwards does not mean the target can reach the source.
                "with_direction": edge["source"] == previous_id,
                "observed": RELATIONSHIPS[edge["type"]].observed
                if edge["type"] in RELATIONSHIPS else True,
            })

        return {
            "found": True,
            "nodes": [self._node_by_id[n] for n in node_ids],
            "edges": edges,
            "hops": hops,
            "length": len(edges),
        }

    # ── impact / blast radius ────────────────────────────────────────────────

    def impact(
        self, node_id: str, *, max_depth: int = 4, max_nodes: int = 2000
    ) -> Dict[str, Any]:
        """What would be affected if this resource went away.

        Traversal follows `IMPACT_FLOW`, not the raw edge direction: an
        instance names its subnet, so the edge points instance -> subnet while
        the *impact* of losing the subnet lands on the instance. Getting this
        backwards would report a subnet's blast radius as zero.

        Direct dependents are one hop out. Indirect are everything further,
        which is what makes deleting a VPC visibly worse than deleting one
        subnet inside it.
        """
        if node_id not in self._node_by_id:
            return {"found": False}

        direct: Dict[str, Set[str]] = {}      # node id -> dependency classes
        indirect: Dict[str, Set[str]] = {}
        via_edge: Dict[str, str] = {}          # node id -> first edge id reached by
        depth: Dict[str, int] = {node_id: 0}
        queue: deque = deque([node_id])
        truncated = False

        while queue:
            current = queue.popleft()
            d = depth[current]
            if d >= max_depth:
                continue
            for idx, other in self._incident(current):
                edge = self.edges[idx]
                flow = IMPACT_FLOW.get(edge["type"], "both")
                # Does removing `current` affect `other`?
                if flow == "to_target" and edge["source"] != current:
                    continue
                if flow == "to_source" and edge["target"] != current:
                    continue
                klass = DEPENDENCY_CLASS.get(edge["type"], "structural")
                if other == node_id:
                    continue
                if other in depth:
                    # Already reached. Record the additional class only when
                    # this edge is a genuine ALTERNATIVE propagation path —
                    # that is, when `current` is strictly closer to the origin
                    # than `other` already is. A resource can be affected
                    # through two different relationships and both matter.
                    #
                    # The depth guard is what stops the walk from tagging a
                    # node with the classes of things that depend on IT. An
                    # instance reached from the subnet at depth 1 has its
                    # volumes at depth 2; without the guard, stepping back
                    # from a volume to the instance re-tagged the instance as
                    # a "storage" dependent of the subnet, which is backwards
                    # — and inflated the breakdown by every such pair (47
                    # affected resources reported 46 storage dependents when
                    # only 36 volumes existed).
                    if depth[current] < depth[other]:
                        bucket = direct if depth[other] == 1 else indirect
                        if other in bucket:
                            bucket[other].add(klass)
                    continue
                if len(depth) >= max_nodes:
                    truncated = True
                    continue
                depth[other] = d + 1
                via_edge[other] = edge["id"]
                (direct if d + 1 == 1 else indirect).setdefault(other, set()).add(klass)
                queue.append(other)

        def render(bucket: Dict[str, Set[str]]) -> List[Dict[str, Any]]:
            rows = []
            for nid, classes in bucket.items():
                node = self._node_by_id.get(nid)
                if not node:
                    continue
                rows.append({
                    "id": nid,
                    "name": node.get("name"),
                    "type": node.get("type"),
                    "category": node.get("category"),
                    "provider": node.get("provider"),
                    "region": node.get("region"),
                    "depth": depth[nid],
                    "dependency_classes": sorted(classes),
                    "via_edge_id": via_edge.get(nid),
                })
            rows.sort(key=lambda r: (r["depth"], r["type"] or "", r["name"] or ""))
            return rows

        direct_rows = render(direct)
        indirect_rows = render(indirect)

        by_class: Dict[str, int] = {c: 0 for c in DEPENDENCY_CLASSES}
        for row in direct_rows + indirect_rows:
            for klass in row["dependency_classes"]:
                by_class[klass] = by_class.get(klass, 0) + 1

        total = len(direct_rows) + len(indirect_rows)
        # A count, and the thresholds that turned it into a word, are both in
        # the payload. Section 24 requires the affected SET come from real
        # relationships — it does, above — and stating the thresholds is what
        # keeps the label from being an opaque judgement.
        if total == 0:
            level = "NONE"
        elif total <= 3:
            level = "LOW"
        elif total <= 15:
            level = "MEDIUM"
        else:
            level = "HIGH"

        return {
            "found": True,
            "resource_id": node_id,
            "direct_dependents": direct_rows,
            "indirect_dependents": indirect_rows,
            "direct_count": len(direct_rows),
            "indirect_count": len(indirect_rows),
            "total_affected": total,
            # A resource affected through two relationships is counted in
            # both classes, so these deliberately do not sum to
            # `total_affected`.
            "by_dependency_class": {k: v for k, v in by_class.items() if v},
            "impact_level": level,
            "impact_basis": (
                "Counted from provider-confirmed relationships only, following "
                "each relationship kind's dependency direction. Thresholds: "
                "0 = NONE, 1-3 = LOW, 4-15 = MEDIUM, 16+ = HIGH."
            ),
            "searched_depth": max_depth,
            "truncated": truncated,
        }

    def dependencies_of(self, node_id: str) -> Dict[str, List[Dict[str, Any]]]:
        """What this resource relies on, and what relies on it — one hop.

        The complement of `impact`, and the source for the resource panel's
        Dependencies section. Split by direction of reliance rather than by the
        stored edge direction, for the same reason `impact` is.
        """
        depends_on: List[Dict[str, Any]] = []
        depended_on_by: List[Dict[str, Any]] = []
        seen: Set[Tuple[str, str, str]] = set()

        for idx, other in self._incident(node_id):
            edge = self.edges[idx]
            node = self._node_by_id.get(other)
            if not node:
                continue
            flow = IMPACT_FLOW.get(edge["type"], "both")
            row = {
                "id": other,
                "name": node.get("name"),
                "type": node.get("type"),
                "category": node.get("category"),
                "provider": node.get("provider"),
                "relationship": edge["type"],
                "label": edge.get("label"),
                "edge_id": edge["id"],
                "dependency_class": DEPENDENCY_CLASS.get(edge["type"], "structural"),
                "observed": RELATIONSHIPS[edge["type"]].observed
                if edge["type"] in RELATIONSHIPS else True,
            }
            # "this depends on other" when losing `other` would affect us.
            we_depend = (
                (flow == "to_source" and edge["source"] == node_id)
                or (flow == "to_target" and edge["target"] == node_id)
                or flow == "both"
            )
            they_depend = (
                (flow == "to_source" and edge["target"] == node_id)
                or (flow == "to_target" and edge["source"] == node_id)
                or flow == "both"
            )
            if we_depend:
                key = (other, edge["type"], "d")
                if key not in seen:
                    seen.add(key)
                    depends_on.append(row)
            if they_depend:
                key = (other, edge["type"], "r")
                if key not in seen:
                    seen.add(key)
                    depended_on_by.append(dict(row))

        return {"depends_on": depends_on, "depended_on_by": depended_on_by}

    def connections_of(self, node_id: str) -> Dict[str, List[Dict[str, Any]]]:
        """Inbound and outbound edges as stored, for the relationships panel.

        Kept separate from `dependencies_of` because they answer different
        questions and conflating them was one of the original panel's
        weaknesses: "Inputs / Outputs" read as data flow when most of the edges
        were structural.
        """
        inbound: List[Dict[str, Any]] = []
        outbound: List[Dict[str, Any]] = []

        def row(edge: Dict[str, Any], other_id: str) -> Optional[Dict[str, Any]]:
            node = self._node_by_id.get(other_id)
            if not node:
                return None
            return {
                "id": other_id,
                "name": node.get("name"),
                "type": node.get("type"),
                "category": node.get("category"),
                "provider": node.get("provider"),
                "status": node.get("status"),
                "health": node.get("health"),
                "relationship": edge["type"],
                "semantic": edge.get("semantic"),
                "label": edge.get("label"),
                "edge_id": edge["id"],
                "evidence": edge.get("evidence"),
                "observed": RELATIONSHIPS[edge["type"]].observed
                if edge["type"] in RELATIONSHIPS else True,
            }

        for idx, other in self._in.get(node_id) or []:
            entry = row(self.edges[idx], other)
            if entry:
                inbound.append(entry)
        for idx, other in self._out.get(node_id) or []:
            entry = row(self.edges[idx], other)
            if entry:
                outbound.append(entry)

        inbound.sort(key=lambda r: (r["relationship"], r["name"] or ""))
        outbound.sort(key=lambda r: (r["relationship"], r["name"] or ""))
        return {"inbound": inbound, "outbound": outbound}

    # ── coverage and diagnostics ─────────────────────────────────────────────

    def coverage(self) -> Dict[str, Any]:
        """How much of what the providers told us we managed to resolve.

        This is a DATA COVERAGE metric and nothing else (section 33). It says
        nothing whatsoever about whether the infrastructure is securely
        configured, which is why it is never labelled a score.

        ## The two gaps are counted separately, and only one is a shortfall

        An unresolved reference has two very different causes:

        *   `missing_target` — we DO collect that resource type, and this
            particular one is absent. A permission gap, an unswept region, a
            race with a deletion. This is a real shortfall in the data.
        *   `unsupported_type` — no scanner collects that type at all, so the
            reference could never have resolved. A documented product
            limitation, on a roadmap, not a symptom.

        Blending them produces a badly misleading number. On this deployment's
        OCI tenancy, 514 of 532 unresolved references are route rules pointing
        at gateways we do not collect yet; counted together the headline reads
        65% and an operator concludes their inventory is broken, when the
        resolvable references are in fact at 98.2%. So `resolved_pct` is the
        share of references that COULD have resolved, and the unsupported
        count is reported beside it as its own, separately actionable fact.
        """
        confirmed = len(self.edges)
        missing = sum(
            int(r.get("count", 1)) for r in self.unresolved
            if r.get("reference_class") == "missing_target"
        )
        unsupported = sum(
            int(r.get("count", 1)) for r in self.unresolved
            if r.get("reference_class") == "unsupported_type"
        )
        unresolved = missing + unsupported

        by_provider: Dict[str, Dict[str, Any]] = {}
        for node in self.nodes:
            provider = node.get("provider") or "Unknown"
            entry = by_provider.setdefault(provider, {
                "provider": provider, "resources": 0, "confirmed": 0,
                "missing_target": 0, "unsupported_type": 0, "resolved_pct": None,
            })
            entry["resources"] += 1
        for edge in self.edges:
            provider = edge.get("provider") or "Unknown"
            if provider in by_provider:
                by_provider[provider]["confirmed"] += 1
        for ref in self.unresolved:
            provider = ref.get("provider") or "Unknown"
            if provider not in by_provider:
                continue
            key = (
                "unsupported_type"
                if ref.get("reference_class") == "unsupported_type"
                else "missing_target"
            )
            by_provider[provider][key] += int(ref.get("count", 1))
        for entry in by_provider.values():
            denominator = entry["confirmed"] + entry["missing_target"]
            entry["resolved_pct"] = (
                round(entry["confirmed"] * 100.0 / denominator, 1)
                if denominator else None
            )

        denominator = confirmed + missing
        return {
            "resources": len(self.nodes),
            "confirmed_relationships": confirmed,
            "unresolved_references": unresolved,
            "missing_target": missing,
            "unsupported_type": unsupported,
            # None, not 100, when there is nothing to resolve. An account with
            # no resources has no coverage to report, and calling that "100%"
            # is the false confidence section 79 rules out.
            "resolved_pct": (
                round(confirmed * 100.0 / denominator, 1) if denominator else None
            ),
            "by_provider": sorted(by_provider.values(), key=lambda e: e["provider"]),
            "metric": "data_coverage",
            "definition": (
                "The share of resolvable relationship identifiers the providers "
                "reported that matched a resource we discovered. References to "
                "resource types no scanner collects are excluded from this "
                "percentage and counted under unsupported_type, because they "
                "measure a missing feature rather than missing data. A "
                "data-completeness measure, not a security score."
            ),
        }

    def unresolved_report(self, *, limit: int = 500) -> Dict[str, Any]:
        """The unresolved references, grouped and classified.

        Section 32 wants the table, not a count — which resource, which field,
        what value, and why it could not be resolved.
        """
        rows = sorted(
            self.unresolved,
            key=lambda r: (r.get("reference_class") or "", r.get("gap") or ""),
        )
        by_reason: Dict[str, Dict[str, Any]] = {}
        for ref in self.unresolved:
            gap = ref.get("gap") or "unknown"
            entry = by_reason.setdefault(gap, {
                "gap": gap,
                "reference_class": ref.get("reference_class"),
                "explanation": ref.get("explanation"),
                "count": 0,
                "providers": set(),
            })
            entry["count"] += int(ref.get("count", 1))
            if ref.get("provider"):
                entry["providers"].add(ref["provider"])
        grouped = [
            {**entry, "providers": sorted(entry["providers"])}
            for entry in by_reason.values()
        ]
        grouped.sort(key=lambda e: -e["count"])

        return {
            "total": sum(int(r.get("count", 1)) for r in self.unresolved),
            "missing_target": sum(
                int(r.get("count", 1)) for r in self.unresolved
                if r.get("reference_class") == "missing_target"
            ),
            "unsupported_type": sum(
                int(r.get("count", 1)) for r in self.unresolved
                if r.get("reference_class") == "unsupported_type"
            ),
            "by_reason": grouped,
            "references": rows[:limit],
            "truncated": len(rows) > limit,
        }

    def isolated_report(self) -> Dict[str, Any]:
        """Unconnected nodes, each with the reason it is unconnected.

        Section 34: "63 isolated" on its own tells an operator nothing. Every
        reason below is read off the node — whether its identity carries a
        wildcard grant, whether it made references that did not resolve,
        whether its type carries relationship fields at all — never guessed.
        """
        connected: Set[str] = set()
        for edge in self.edges:
            connected.add(edge["source"])
            connected.add(edge["target"])

        # Which nodes registered an unresolved reference of their own.
        referenced_but_unresolved: Set[str] = {
            ref["resource_id"] for ref in self.unresolved if ref.get("resource_id")
        }

        rows: List[Dict[str, Any]] = []
        by_reason: Dict[str, int] = {}
        for node in self.nodes:
            if node["id"] in connected:
                continue
            if node.get("type") in SYNTHETIC_TYPES:
                reason = "empty_container"
            elif node.get("broad_access"):
                reason = "wildcard_permission"
            elif node["id"] in referenced_but_unresolved:
                reason = "references_unresolved"
            elif node.get("has_relationship_fields"):
                reason = "standalone_resource"
            else:
                reason = "no_relationship_fields"
            by_reason[reason] = by_reason.get(reason, 0) + 1
            rows.append({
                "id": node["id"],
                "name": node.get("name"),
                "type": node.get("type"),
                "category": node.get("category"),
                "provider": node.get("provider"),
                "region": node.get("region"),
                "account_name": node.get("account_name"),
                "reason": reason,
                "explanation": ISOLATION_REASONS[reason],
            })

        rows.sort(key=lambda r: (r["reason"], r["type"] or "", r["name"] or ""))
        return {
            "total": len(rows),
            "by_reason": [
                {"reason": reason, "count": count,
                 "explanation": ISOLATION_REASONS[reason]}
                for reason, count in sorted(by_reason.items(), key=lambda kv: -kv[1])
            ],
            "resources": rows,
        }

    # ── filtering ────────────────────────────────────────────────────────────

    def subgraph(self, node_ids: Iterable[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """The nodes named, and only the edges with both ends among them.

        Dropping half-dangling edges here rather than in the renderer is what
        stops a filtered view from drawing a line to a node that is not on
        screen — the bug the original page worked around by re-filtering edges
        in the component on every render.
        """
        keep = {n for n in node_ids if n in self._node_by_id}
        # Iterate self.nodes rather than `keep` so the returned order matches
        # the full graph's order; a layout that depends on node order must not
        # shuffle when a filter is applied.
        nodes = [node for node in self.nodes if node["id"] in keep]
        edges = [
            edge for edge in self.edges
            if edge["source"] in keep and edge["target"] in keep
        ]
        return nodes, edges

    def edge_type_counts(self, edges: Optional[List[Dict[str, Any]]] = None) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for edge in (edges if edges is not None else self.edges):
            counts[edge["type"]] = counts.get(edge["type"], 0) + 1
        return counts
