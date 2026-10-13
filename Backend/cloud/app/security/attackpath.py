"""Attack paths: where an attacker could go, over the graph we already built.

This module adds no graph of its own. It walks `app.topology.graph.Graph` — the
same nodes and edges the Topology tab draws, built by the same builder from the
same provider fields — so a path shown here can be opened in Topology and
checked edge by edge. A second, security-only graph would have been quicker and
would have reintroduced exactly the disagreement the unified finding model was
built to end: two subsystems with two opinions about whether a VM talks to a
bucket, and no way to tell which is right.

Three decisions carry this module.

**Entry points are confirmed, never assumed.** A path starts only at a resource
the exposure analyser returned as `EXPOSED` — meaning it resolved a complete
inbound chain and can show it. `UNKNOWN` does not start a path. That makes the
path count a lower bound, and the module says so rather than padding it with
maybes: a fabricated attack path is worse than a missing one, because an
operator will spend an afternoon on it.

**Not every relationship is an attacker's move.** The topology vocabulary
describes how the estate is wired, which is a different question. `contains` is
ownership. `security` is a filter — it constrains movement rather than
providing it. `managed-by`, `encrypted-by` and `protects` are likewise not
steps. Traversing them would produce paths that are real relationships and
fictional attacks. `TRAVERSABLE` below is the explicit, reviewable list of the
kinds that are moves, each with the direction an attacker would take it.

**A path is only as honest as its weakest edge.** Two kinds need a caveat and
get one, in the path's own confidence and in a per-hop `observed` flag:

* `permission` is declared `observed=False` by the topology vocabulary itself —
  it means *allowed by policy*, not *seen happening*. An IAM path is a
  capability.
* `network` means co-location ("Placement, not reachability", in the
  vocabulary's own words). Two VMs in a subnet are not necessarily able to
  reach each other; a security group may still refuse. Walking it as though it
  were reachability is the single easiest way to invent an attack path, so a
  path that depends on one is downgraded and labelled.

So `confidence` is derived from the hops, never declared, and a path across a
permission edge and a subnet edge cannot come out HIGH no matter how alarming
its endpoints are.
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, FrozenSet, Iterable, List, NamedTuple, Optional, Sequence, Set, Tuple

from app.security import ports as portcat
from app.security.model import (
    CONF_HIGH, CONF_LOW, CONF_MEDIUM, CRITICAL, EXPOSED, HIGH, INFO, LOW, MEDIUM,
)
from app.topology.model import (
    ATTACHED, CATEGORY_DATABASE, CATEGORY_IDENTITY, CATEGORY_STORAGE, CONTAINS,
    DATAFLOW, ENCRYPTED_BY, MANAGED_BY, NETWORK, PEERS_WITH, PERMISSION,
    PROTECTS, RELATIONSHIPS, ROLE, ROUTES_TO, SECURITY,
)

# ── Attack stages ────────────────────────────────────────────────────────────
# Named for what an operator reads in an incident report, and ordered. The
# stage of a hop is derived from the edge kind and the node it lands on, not
# from its index in the path — a path can reach data in one hop or in four.
ENTRY_POINT = "ENTRY_POINT"
INITIAL_ACCESS = "INITIAL_ACCESS"
PRIVILEGE_ESCALATION = "PRIVILEGE_ESCALATION"
LATERAL_MOVEMENT = "LATERAL_MOVEMENT"
DATA_ACCESS = "DATA_ACCESS"
IMPACT = "IMPACT"

STAGES: Tuple[str, ...] = (
    ENTRY_POINT, INITIAL_ACCESS, PRIVILEGE_ESCALATION,
    LATERAL_MOVEMENT, DATA_ACCESS, IMPACT,
)

STAGE_LABEL: Dict[str, str] = {
    ENTRY_POINT: "Entry point",
    INITIAL_ACCESS: "Initial access",
    PRIVILEGE_ESCALATION: "Privilege escalation",
    LATERAL_MOVEMENT: "Lateral movement",
    DATA_ACCESS: "Data access",
    IMPACT: "Impact",
}


class Traversal(NamedTuple):
    """How one relationship kind may be walked, and what it means when walked."""

    kind: str
    # "forward"  — attacker moves source -> target only
    # "both"     — the relationship is symmetric and so is the movement
    direction: str
    stage: str
    # False where the vocabulary itself says the edge is a capability or a
    # placement rather than an observed flow. Drives path confidence.
    observed: bool
    rationale: str


# The complete, reviewable set. Anything absent is not an attacker's move.
TRAVERSABLE: Dict[str, Traversal] = {
    ROUTES_TO: Traversal(
        ROUTES_TO, "forward", INITIAL_ACCESS, True,
        "The source forwards traffic to the target, so reaching the source puts "
        "an attacker in front of the target.",
    ),
    ROLE: Traversal(
        ROLE, "forward", PRIVILEGE_ESCALATION, True,
        "The resource runs as this identity, so code execution on it yields the "
        "identity's credentials.",
    ),
    PERMISSION: Traversal(
        PERMISSION, "forward", DATA_ACCESS, False,
        "Policy allows the source to reach the target. This is a granted "
        "capability, not an observation that any access has occurred.",
    ),
    DATAFLOW: Traversal(
        DATAFLOW, "forward", LATERAL_MOVEMENT, True,
        "The source invokes or hands data to the target.",
    ),
    ATTACHED: Traversal(
        ATTACHED, "both", DATA_ACCESS, True,
        "Block storage attached to a compute instance: control of the instance "
        "is control of the volume's contents.",
    ),
    PEERS_WITH: Traversal(
        PEERS_WITH, "both", LATERAL_MOVEMENT, True,
        "The two networks are peered, so traffic can cross between them.",
    ),
    NETWORK: Traversal(
        NETWORK, "both", LATERAL_MOVEMENT, False,
        "The two resources share a network or subnet. This is co-location, not "
        "proven reachability — a security group may still refuse the traffic.",
    ),
}

# Spelled out so the exclusion is a decision on the record rather than an
# oversight, and so a future relationship kind fails loudly instead of silently
# becoming traversable.
NOT_TRAVERSABLE: Dict[str, str] = {
    CONTAINS: "Ownership and nesting. A resource group does not carry an attacker anywhere.",
    SECURITY: "A filter on traffic. It constrains movement; it does not provide it.",
    MANAGED_BY: "Lifecycle ownership, not a network or identity path.",
    ENCRYPTED_BY: "Names the key protecting data at rest. Reaching a key through "
                  "this edge is not a move the edge itself permits.",
    PROTECTS: "A firewall or WAF in front of the target — a control, not a route.",
}


def traversal_model() -> Dict[str, Any]:
    """The traversal rules, for the UI to explain what it is showing."""
    return {
        "traversable": [
            {
                "kind": t.kind,
                "direction": t.direction,
                "stage": t.stage,
                "stage_label": STAGE_LABEL[t.stage],
                "observed": t.observed,
                "rationale": t.rationale,
                "relationship": (
                    RELATIONSHIPS[t.kind].to_dict() if t.kind in RELATIONSHIPS else None
                ),
            }
            for t in TRAVERSABLE.values()
        ],
        "excluded": [
            {"kind": k, "reason": why} for k, why in NOT_TRAVERSABLE.items()
        ],
        "stages": [{"stage": s, "label": STAGE_LABEL[s]} for s in STAGES],
    }


# ── What counts as a target worth reaching ───────────────────────────────────
# A path to nothing in particular is not a finding. These are the categories
# whose compromise is the point: stored data, and the identities that reach it.
TARGET_CATEGORIES: FrozenSet[str] = frozenset({
    CATEGORY_STORAGE, CATEGORY_DATABASE,
})

# Identity nodes are targets only when something marked them privileged; a
# path to an unprivileged role is not an escalation.
IDENTITY_CATEGORY = CATEGORY_IDENTITY


class Hop(NamedTuple):
    """One step, carrying the edge's own evidence so the claim is checkable."""

    index: int
    stage: str
    from_node_id: str
    to_node_id: str
    edge_id: Optional[str]
    edge_kind: Optional[str]
    label: str
    reason: str
    observed: bool
    evidence: Dict[str, Any]

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "stage": self.stage,
            "stage_label": STAGE_LABEL.get(self.stage, self.stage),
            "from_node_id": self.from_node_id,
            "to_node_id": self.to_node_id,
            "edge_id": self.edge_id,
            "edge_kind": self.edge_kind,
            "label": self.label,
            "reason": self.reason,
            "observed": self.observed,
            "evidence": self.evidence,
        }


# ── Path classes ─────────────────────────────────────────────────────────────
# What KIND of route this is, so the UI can group rather than present a flat
# list in which a VM's own boot disk competes for attention with a route to a
# shared bucket. Added after the first live run, where 92 of 159 OCI paths and
# 87 of 109 Azure paths were the same shape and buried everything else.
CLASS_ENTRY_STORAGE = "ENTRY_STORAGE"
CLASS_IDENTITY_PIVOT = "IDENTITY_PIVOT"
CLASS_NETWORK_LATERAL = "NETWORK_LATERAL"
CLASS_DIRECT_ROUTE = "DIRECT_ROUTE"

PATH_CLASS_LABEL: Dict[str, str] = {
    CLASS_ENTRY_STORAGE: "Storage attached to the entry point",
    CLASS_IDENTITY_PIVOT: "Pivots through an identity",
    CLASS_NETWORK_LATERAL: "Lateral movement across a shared network",
    CLASS_DIRECT_ROUTE: "Direct routed path",
}

PATH_CLASS_MEANING: Dict[str, str] = {
    CLASS_ENTRY_STORAGE: (
        "The target is storage attached to the exposed resource itself. This is "
        "what compromising that resource already yields rather than a further "
        "move, so it is listed to show what data is at stake, not as a second "
        "way in."
    ),
    CLASS_IDENTITY_PIVOT: (
        "The route passes through a role or policy grant, so reaching the entry "
        "point yields permissions beyond the host."
    ),
    CLASS_NETWORK_LATERAL: (
        "The route depends on resources sharing a network. Co-location is not "
        "proven reachability — confirm the hop before acting."
    ),
    CLASS_DIRECT_ROUTE: (
        "Every hop is a routing, attachment or data-flow relationship the "
        "provider itself reports."
    ),
}


def classify(hops: Sequence[Hop]) -> str:
    if len(hops) == 1 and hops[0].edge_kind == ATTACHED:
        return CLASS_ENTRY_STORAGE
    if any(h.edge_kind in (ROLE, PERMISSION) for h in hops):
        return CLASS_IDENTITY_PIVOT
    if any(h.edge_kind == NETWORK for h in hops):
        return CLASS_NETWORK_LATERAL
    return CLASS_DIRECT_ROUTE


class AttackPath(NamedTuple):
    path_id: str
    account_id: str
    provider: str
    entry_node_id: str
    target_node_id: str
    hops: List[Hop]
    nodes: List[Dict[str, Any]]
    confidence: str
    confidence_reason: str
    path_class: str = CLASS_DIRECT_ROUTE
    # Set by score(); kept separate so traversal stays pure and testable.
    risk: Optional[Dict[str, Any]] = None

    @property
    def length(self) -> int:
        return len(self.hops)

    def to_dict(self) -> dict:
        return {
            "path_id": self.path_id,
            "account_id": self.account_id,
            "provider": self.provider,
            "entry_node_id": self.entry_node_id,
            "target_node_id": self.target_node_id,
            "length": self.length,
            "hops": [h.to_dict() for h in self.hops],
            "nodes": self.nodes,
            "confidence": self.confidence,
            "confidence_reason": self.confidence_reason,
            "path_class": self.path_class,
            "path_class_label": PATH_CLASS_LABEL.get(self.path_class, self.path_class),
            "path_class_meaning": PATH_CLASS_MEANING.get(self.path_class),
            "risk": self.risk,
        }


def _path_id(account_id: str, entry: str, target: str, edge_ids: Sequence[str]) -> str:
    """Stable across scans: the same route through the same edges is the same path.

    Edge ids are regenerated on every build (`uuid4()` in the builder), so they
    cannot be part of the identity. The node sequence can, and is what an
    operator means by "the same path".
    """
    raw = "|".join([account_id, entry, target, *edge_ids])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _node_sequence(hops: Sequence[Hop], entry: str) -> List[str]:
    return [entry] + [h.to_node_id for h in hops]


# ── Traversal ────────────────────────────────────────────────────────────────


def _stage_for(trav: Traversal, target_node: Dict[str, Any]) -> str:
    """Refine the edge kind's default stage using where it lands.

    An IAM permission edge onto a bucket is data access; the same edge onto a
    compute instance is lateral movement. Deriving this from the destination is
    what keeps the stage labels meaningful instead of decorative.
    """
    category = (target_node or {}).get("category")
    if trav.kind == PERMISSION:
        return DATA_ACCESS if category in TARGET_CATEGORIES else LATERAL_MOVEMENT
    if trav.kind in (ATTACHED, DATAFLOW) and category in TARGET_CATEGORIES:
        return DATA_ACCESS
    if trav.kind == ROLE:
        return PRIVILEGE_ESCALATION
    return trav.stage


def _confidence_of(hops: Sequence[Hop]) -> Tuple[str, str]:
    """Weakest-link confidence, with the reason named."""
    unobserved = [h for h in hops if not h.observed]
    if not unobserved:
        return CONF_HIGH, (
            "Every hop is a relationship the provider itself reports, in the "
            "direction the attacker would take it."
        )
    kinds = sorted({h.edge_kind for h in unobserved if h.edge_kind})
    if NETWORK in kinds:
        return CONF_LOW, (
            "This path depends on shared-network co-location, which is placement "
            "rather than proven reachability — a security group may still refuse "
            "the traffic. Confirm the hop before acting on the path."
        )
    return CONF_MEDIUM, (
        "This path crosses an IAM permission edge, which is a capability granted "
        "by policy rather than an observed access. The grant is real; whether it "
        "has ever been used is not known here."
    )


def _is_target(node: Dict[str, Any], privileged_identity_ids: Set[str]) -> Optional[str]:
    """Why this node is worth reaching, or None."""
    if not node:
        return None
    category = node.get("category")
    if category in TARGET_CATEGORIES:
        return f"{category} resource — holds or serves stored data"
    if category == IDENTITY_CATEGORY and node.get("id") in privileged_identity_ids:
        return "Privileged identity — reaching it yields its permissions"
    return None


# How many unobserved hops one path may rest on.
#
# This is a correctness bound, not a display preference. A `network` edge joins
# a resource to its subnet, so moving between two co-located hosts costs TWO
# such edges (host -> subnet -> host). A limit of 2 therefore permits exactly
# one co-location step and forbids chaining them.
#
# Without it the walk enumerates a subnet's transitive closure: the first live
# run returned 92 of 159 OCI paths and 87 of 109 Azure paths shaped
# `network->network->network->network->...`, which is not an attack path but
# the observation that a flat network is flat, repeated once per pair of hosts.
# Every one was already LOW confidence, and they still outnumbered the
# confirmed paths thirteen to one.
MAX_UNOBSERVED_HOPS = 2


def find_paths(
    graph,
    exposures: Sequence[Any],
    *,
    account_id: str,
    provider: str,
    privileged_identity_ids: Optional[Set[str]] = None,
    max_depth: int = 6,
    max_paths: int = 500,
    max_paths_per_entry: int = 25,
    max_unobserved_hops: int = MAX_UNOBSERVED_HOPS,
) -> Dict[str, Any]:
    """Every confirmed-entry path to a target of value, shortest first.

    Breadth-first from each entry point, so the first path found to a given
    target is a shortest one; later, longer routes to the same target are
    dropped. The caps are a performance guarantee, not a filter on the
    interesting cases — when one binds it is reported in `truncated` so the UI
    can say the list is incomplete rather than implying it is exhaustive.
    """
    privileged_identity_ids = privileged_identity_ids or set()

    entries = [
        e for e in exposures
        if getattr(e, "verdict", None) == EXPOSED and graph.has_node(str(getattr(e, "resource_id", "")))
    ]

    exposure_by_node: Dict[str, Any] = {
        str(e.resource_id): e for e in exposures if getattr(e, "resource_id", None)
    }

    paths: List[AttackPath] = []
    truncated: List[str] = []
    entries_without_path: List[str] = []

    for entry in sorted(entries, key=lambda e: str(e.resource_id)):
        entry_id = str(entry.resource_id)
        found_here = _walk_from(
            graph, entry_id,
            account_id=account_id, provider=provider,
            privileged_identity_ids=privileged_identity_ids,
            max_depth=max_depth, max_paths=max_paths_per_entry,
            max_unobserved_hops=max_unobserved_hops,
        )
        if not found_here:
            entries_without_path.append(entry_id)
        paths.extend(found_here)
        if len(paths) >= max_paths:
            truncated.append(
                f"Stopped after {max_paths} paths. More may exist; raise the cap or "
                f"narrow the scope to enumerate them."
            )
            paths = paths[:max_paths]
            break

    return {
        "paths": paths,
        "entry_points": [str(e.resource_id) for e in entries],
        "entries_without_path": entries_without_path,
        "exposure_by_node": exposure_by_node,
        "truncated": truncated,
        "limits": {
            "max_depth": max_depth,
            "max_paths": max_paths,
            "max_paths_per_entry": max_paths_per_entry,
            "max_unobserved_hops": max_unobserved_hops,
            "max_unobserved_hops_note": (
                "A path may rest on at most this many hops the provider does not "
                "confirm. Two permits one shared-network step (host to subnet to "
                "host) and forbids chaining them, which would enumerate a flat "
                "network rather than find a route."
            ),
        },
    }


def _walk_from(
    graph,
    entry_id: str,
    *,
    account_id: str,
    provider: str,
    privileged_identity_ids: Set[str],
    max_depth: int,
    max_paths: int,
    max_unobserved_hops: int = MAX_UNOBSERVED_HOPS,
) -> List[AttackPath]:
    """BFS from one entry point, recording a shortest path per distinct target."""
    from collections import deque

    results: List[AttackPath] = []
    best_target_seen: Set[str] = set()

    # Each queue item carries its own visited set, so two branches may both pass
    # through a shared subnet without one starving the other. Depth is bounded,
    # so this cannot grow without limit.
    start_visited = frozenset({entry_id})
    queue: deque = deque([(entry_id, [], start_visited)])

    while queue:
        current, hops, visited = queue.popleft()
        if len(hops) >= max_depth or len(results) >= max_paths:
            continue

        for edge_index, other in graph.incident(current):
            edge = graph.edges[edge_index]
            kind = edge.get("type")
            trav = TRAVERSABLE.get(kind)
            if trav is None:
                continue
            # Respect the attacker's direction for directed kinds: an attacker
            # on a load balancer's backend has not thereby reached the balancer.
            if trav.direction == "forward" and edge.get("source") != current:
                continue
            if other in visited:
                continue
            # Budget the unproven hops before building anything: a branch that
            # has spent its allowance cannot be rescued further down.
            if not trav.observed:
                spent = sum(1 for h in hops if not h.observed)
                if spent >= max_unobserved_hops:
                    continue

            target_node = graph.node(other) or {}
            stage = _stage_for(trav, target_node)
            hop = Hop(
                index=len(hops),
                stage=stage,
                from_node_id=current,
                to_node_id=other,
                edge_id=edge.get("id"),
                edge_kind=kind,
                label=edge.get("label") or (RELATIONSHIPS[kind].label if kind in RELATIONSHIPS else kind),
                reason=trav.rationale,
                observed=trav.observed,
                evidence=edge.get("evidence") or {},
            )
            next_hops = hops + [hop]

            why_target = _is_target(target_node, privileged_identity_ids)
            if why_target and other not in best_target_seen:
                best_target_seen.add(other)
                node_seq = _node_sequence(next_hops, entry_id)
                confidence, reason = _confidence_of(next_hops)
                results.append(AttackPath(
                    path_id=_path_id(account_id, entry_id, other, node_seq),
                    account_id=account_id,
                    provider=provider,
                    entry_node_id=entry_id,
                    target_node_id=other,
                    hops=next_hops,
                    nodes=[graph.node(n) or {"id": n} for n in node_seq],
                    confidence=confidence,
                    confidence_reason=reason,
                    path_class=classify(next_hops),
                ))
                if len(results) >= max_paths:
                    break

            queue.append((other, next_hops, visited | {other}))

    return results


# ═════════════════════════════════════════════════════════════════════════════
# Path risk scoring
# ═════════════════════════════════════════════════════════════════════════════
# Same contract as the contextual-risk model: every component is named, signed,
# evidenced, and adds up to the number shown. Nothing here is a judgement the
# caller cannot re-derive.
#
# One honesty note on "data sensitivity". This product cannot read object
# contents and does not try. What it knows is the resource's TYPE — a bucket is
# a data store, a VM is not — so the component below is called what it is, and
# claims no knowledge of whether the data inside matters. Calling a bucket
# "sensitive data" because it is a bucket would be inventing the finding that
# makes the whole path look urgent.

PC_ENTRY_EXPOSURE = "ENTRY_POINT_EXPOSURE"
PC_MANAGEMENT_PORT = "ENTRY_MANAGEMENT_PORT"
PC_PRIVILEGE = "CROSSES_PRIVILEGED_IDENTITY"
PC_TARGET_DATA = "TARGET_IS_DATA_STORE"
PC_SHORT_PATH = "SHORT_PATH"
PC_FINDINGS = "FINDINGS_ON_PATH"
PC_BLAST = "TARGET_BLAST_RADIUS"
PC_UNOBSERVED = "UNCONFIRMED_HOP"

PATH_BANDS: Tuple[Tuple[int, str], ...] = (
    (80, CRITICAL),
    (55, HIGH),
    (30, MEDIUM),
    (10, LOW),
    (0, INFO),
)


def path_band(points: float) -> str:
    for floor, band in PATH_BANDS:
        if points >= floor:
            return band
    return INFO


def _component(cid: str, label: str, points: int, explanation: str,
               evidence: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "component_id": cid,
        "label": label,
        "points": points,
        "explanation": explanation,
        "evidence": evidence,
    }


_ENTRY_POINTS_BY_SEVERITY: Dict[str, int] = {
    CRITICAL: 25, HIGH: 20, MEDIUM: 12, LOW: 6, INFO: 2,
}


def score_path(
    path: AttackPath,
    *,
    exposure: Optional[Any] = None,
    privileged_identity_ids: Optional[Set[str]] = None,
    findings_by_node: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    blast_radius: Optional[int] = None,
) -> Dict[str, Any]:
    """An evidenced score for one path. Pure, and shows its arithmetic."""
    privileged_identity_ids = privileged_identity_ids or set()
    findings_by_node = findings_by_node or {}
    components: List[Dict[str, Any]] = []

    # ── entry point ──────────────────────────────────────────────────────────
    if exposure is not None:
        open_ports = list(getattr(exposure, "open_ports", []) or [])
        worst = portcat.worst_of(open_ports) if open_ports else None
        if worst:
            components.append(_component(
                PC_ENTRY_EXPOSURE,
                "Entry point is reachable from the internet",
                _ENTRY_POINTS_BY_SEVERITY.get(worst, 10),
                "The exposure analyser resolved a complete inbound path to this "
                "resource, with {n} open port(s); the most severe is rated "
                "{worst}.".format(n=len(open_ports), worst=worst),
                {
                    "verdict": getattr(exposure, "verdict", None),
                    "public_addresses": list(getattr(exposure, "public_addresses", []) or []),
                    "open_ports": [p.to_dict() for p in open_ports],
                    "path": [h.to_dict() for h in (getattr(exposure, "path", None) or [])],
                },
            ))
        mgmt = [p for p in open_ports if p.port in portcat.MANAGEMENT_PORTS]
        if mgmt:
            components.append(_component(
                PC_MANAGEMENT_PORT,
                "Administrative port open at the entry point",
                15,
                "An interactive management service is world-open, so the first hop "
                "needs only valid or guessable credentials rather than an exploit.",
                {"ports": [p.to_dict() for p in mgmt]},
            ))

    # ── privilege crossed ────────────────────────────────────────────────────
    privileged_hops = [
        h for h in path.hops
        if h.to_node_id in privileged_identity_ids or h.edge_kind == ROLE
    ]
    if privileged_hops:
        crosses_flagged = [h for h in privileged_hops if h.to_node_id in privileged_identity_ids]
        components.append(_component(
            PC_PRIVILEGE,
            "Path crosses an identity",
            20 if crosses_flagged else 10,
            (
                "The path passes through an identity already flagged as broadly or "
                "administratively privileged, so compromise of the entry point "
                "yields those permissions."
                if crosses_flagged else
                "The path passes through a role the entry resource runs as. That "
                "role was not assessed as privileged, so this counts as escalation "
                "potential rather than confirmed privilege."
            ),
            {
                "hops": [h.to_dict() for h in privileged_hops],
                "flagged_privileged": bool(crosses_flagged),
            },
        ))

    # ── target ───────────────────────────────────────────────────────────────
    target_node = next((n for n in path.nodes if n.get("id") == path.target_node_id), {})
    target_category = target_node.get("category")
    if target_category in TARGET_CATEGORIES:
        components.append(_component(
            PC_TARGET_DATA,
            "Target is a data store",
            20,
            "The path terminates at a {t} — a resource whose purpose is storing or "
            "serving data. This scores the resource TYPE; the product does not read "
            "object contents and makes no claim about how sensitive the data "
            "actually is.".format(t=target_node.get("type") or target_category),
            {
                "resource_type": target_node.get("type"),
                "category": target_category,
                "resource_id": target_node.get("resource_id"),
                "basis": "resource type, not content inspection",
            },
        ))

    # ── path length ──────────────────────────────────────────────────────────
    if path.length <= 2:
        components.append(_component(
            PC_SHORT_PATH,
            "Short path",
            12 if path.length == 1 else 8,
            "{n} hop(s) from the internet to the target. Fewer hops mean fewer "
            "places a control could interrupt the sequence.".format(n=path.length),
            {"length": path.length},
        ))

    # ── findings sitting on the route ────────────────────────────────────────
    on_path: List[Dict[str, Any]] = []
    for node in path.nodes:
        on_path.extend(findings_by_node.get(node.get("id"), []))
    if on_path:
        severe = [f for f in on_path if (f.get("severity") or "").upper() in (CRITICAL, HIGH)]
        components.append(_component(
            PC_FINDINGS,
            "Open findings on resources along the path",
            min(15, 3 * len(severe)) if severe else 3,
            "{total} open finding(s) affect resources on this route, {severe} of "
            "them CRITICAL or HIGH. Each is a control that is already not holding "
            "on a resource the path depends on.".format(
                total=len(on_path), severe=len(severe)),
            {
                "total": len(on_path),
                "critical_or_high": len(severe),
                "sample": on_path[:10],
            },
        ))

    # ── blast radius at the target ───────────────────────────────────────────
    if blast_radius is not None and blast_radius >= 12:
        components.append(_component(
            PC_BLAST,
            "Target has a large blast radius",
            8,
            "{n} resources connect to or depend on the target, so impact does not "
            "stop there.".format(n=blast_radius),
            {"connected_resources": blast_radius},
        ))

    # ── the honesty discount ─────────────────────────────────────────────────
    # A path that needs an unproven hop must not outrank a fully confirmed one.
    unobserved = [h for h in path.hops if not h.observed]
    if unobserved:
        penalty = -15 if any(h.edge_kind == NETWORK for h in unobserved) else -8
        components.append(_component(
            PC_UNOBSERVED,
            "Path depends on an unconfirmed hop",
            penalty,
            path.confidence_reason,
            {"hops": [h.to_dict() for h in unobserved]},
        ))

    total = max(0, min(120, sum(c["points"] for c in components)))
    return {
        "points": total,
        "band": path_band(total),
        "components": components,
        "confidence": path.confidence,
        "confidence_reason": path.confidence_reason,
        "thresholds": [{"band": b, "min_points": f} for f, b in PATH_BANDS],
        "length": path.length,
    }
