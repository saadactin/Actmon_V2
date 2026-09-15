"""Topology API routes.

Split by question rather than served as one payload (section 65). The full
graph is one endpoint; a single resource's neighbourhood, a path, an impact
analysis, coverage and diagnostics are their own, so inspecting one instance
does not mean downloading a whole cloud.

## Route order is load-bearing

`/{scope}` matches any single path segment, so every literal route — `global`,
`relationships`, `snapshots` — is declared before it. FastAPI matches in
declaration order, and getting this wrong would turn `GET /topology/global`
into a scope lookup for an account called "global".
"""
from __future__ import annotations

import csv
import io
import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.api import rbac
from app.api.deps import get_topology_service
from app.services.topology_service import TopologyService
from app.topology.model import VIEW_MODES, relationship_catalog

router = APIRouter(prefix="/cloud/topology", tags=["Topology"])


# ── shared filter dependency ─────────────────────────────────────────────────

class TopologyFilters:
    """The section 42 filters, parsed once and shared by every route that takes
    them, so the graph endpoint and the export endpoint cannot disagree about
    what a filter means — an export that quietly ignored a filter and returned
    everything would be the worst possible bug in this feature.
    """

    def __init__(
        self,
        provider: Optional[str] = Query(None, description="AWS | Azure | OCI"),
        account_id: Optional[str] = Query(None),
        account_name: Optional[str] = Query(None),
        region: Optional[str] = Query(None),
        resource_type: Optional[str] = Query(None),
        category: Optional[str] = Query(None),
        status: Optional[str] = Query(None),
        health: Optional[str] = Query(
            None, description="Healthy | Warning | Degraded | Failed | Stopped | Unknown"
        ),
        resource_group: Optional[str] = Query(None),
        compartment_id: Optional[str] = Query(None),
        compartment_name: Optional[str] = Query(None),
        has_drift: bool = Query(False),
        has_events: bool = Query(False),
        exposed: bool = Query(False, description="Only internet-exposed resources"),
        exposure_severity: Optional[str] = Query(None),
        has_broad_access: bool = Query(
            False, description="Only resources whose identity carries a wildcard grant"
        ),
        search: Optional[str] = Query(None),
        view: Optional[str] = Query(
            None, description="infrastructure | network | security | dataflow | identity"
        ),
        hide_defaults: bool = Query(False),
        hide_isolated: bool = Query(False),
        hide_empty_containers: bool = Query(False),
        node_limit: Optional[int] = Query(
            None, ge=1, le=20000,
            description="Cap the nodes returned, keeping the most connected.",
        ),
        context_hops: int = Query(
            0, ge=0, le=3,
            description=(
                "When a filter or search is active, also include this many hops "
                "of neighbouring resources so the matches keep their "
                "relationships. Matched nodes are flagged `matched: true`."
            ),
        ),
        refresh: bool = Query(False, description="Rebuild instead of serving the cached graph"),
    ) -> None:
        self.filters: Dict[str, Any] = {
            "provider": provider,
            "account_id": account_id,
            "account_name": account_name,
            "region": region,
            "resource_type": resource_type,
            "category": category,
            "status": status,
            "health": health,
            "resource_group": resource_group,
            "compartment_id": compartment_id,
            "compartment_name": compartment_name,
            "has_drift": has_drift,
            "has_events": has_events,
            "exposed": exposed,
            "exposure_severity": exposure_severity,
            "has_broad_access": has_broad_access,
        }
        self.search = search
        self.view = view
        self.hide_defaults = hide_defaults
        self.hide_isolated = hide_isolated
        self.hide_empty_containers = hide_empty_containers
        self.node_limit = node_limit
        self.context_hops = context_hops
        self.refresh = refresh

    def as_kwargs(self) -> Dict[str, Any]:
        return {
            "view": self.view,
            "search": self.search,
            "filters": self.filters,
            "hide_defaults": self.hide_defaults,
            "hide_isolated": self.hide_isolated,
            "hide_empty_containers": self.hide_empty_containers,
            "node_limit": self.node_limit,
            "context_hops": self.context_hops,
            "refresh": self.refresh,
        }


# ── literal routes (must precede /{scope}) ───────────────────────────────────

@router.get("/global")
async def global_view(
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Level 1: every provider, its accounts and their resource counts.

    Builds no graph — it is the entry point and has to stay fast regardless of
    how large the accounts are.
    """
    return await service.global_view()


@router.get("/relationships")
async def relationships(
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """The relationship vocabulary — what each edge kind means.

    The legend, the tooltips and the view-mode filters are all generated from
    this, which is what keeps the legend from claiming something the renderer
    does not draw.
    """
    return {
        "relationships": relationship_catalog(),
        "view_modes": VIEW_MODES,
        "permission_note": (
            "A `permission` relationship means the source is ALLOWED to reach "
            "the target. It is never evidence that any access occurred."
        ),
        "confidence_note": (
            "Every edge is provider-confirmed: it was drawn from an identifier "
            "the provider itself reported, resolved exactly against the "
            "inventory. There is no inferred or probabilistic edge kind."
        ),
    }


@router.get("/access")
async def access_model(
    principal: rbac.Principal = Depends(rbac.get_principal),
) -> Dict[str, Any]:
    """Who the caller is and what the access model currently is."""
    return {"principal": principal.to_dict(), "rbac": rbac.rbac_summary()}


@router.get("/snapshots")
async def list_snapshots(
    scope: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    return await service.list_snapshots(scope=scope, limit=limit)


@router.get("/snapshots/{snapshot_id}/diff")
async def diff_snapshot(
    snapshot_id: str,
    against: Optional[str] = Query(
        None,
        description="Another snapshot id. Omit to compare with the live topology.",
    ),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    return await service.diff(snapshot_id, against=against)


@router.delete("/snapshots/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: str,
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_SNAPSHOT)),
) -> Dict[str, Any]:
    return await service.delete_snapshot(snapshot_id)


# ── scoped routes ────────────────────────────────────────────────────────────

@router.get("/{scope}")
async def get_topology_graph(
    scope: str,
    params: TopologyFilters = Depends(),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Nodes and edges for a scope.

    `scope` is a cloud account UUID, a provider name (`AWS`, `Azure`, `OCI`) or
    `ALL` for a unified multi-cloud graph.
    """
    return await service.topology(scope, **params.as_kwargs())


@router.get("/{scope}/search")
async def search_resources(
    scope: str,
    q: str = Query(..., min_length=1, description="Name, id, ARN, ARM ID, OCID, IP, type…"),
    limit: int = Query(50, ge=1, le=500),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    return await service.search(scope, q, limit=limit)


@router.get("/{scope}/coverage")
async def coverage(
    scope: str,
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Relationship coverage — a data-completeness metric, not a security score."""
    return await service.coverage(scope)


@router.get("/{scope}/unresolved")
async def unresolved(
    scope: str,
    limit: int = Query(500, ge=1, le=5000),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Identifiers the providers reported that we could not resolve.

    Each row names the resource, the field, the value and why it could not be
    resolved, so a missing edge is explainable rather than merely absent.
    """
    return await service.unresolved(scope, limit=limit)


@router.get("/{scope}/isolated")
async def isolated(
    scope: str,
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Unconnected resources, each with the reason it is unconnected."""
    return await service.isolated(scope)


@router.get("/{scope}/diagnostics")
async def diagnostics(
    scope: str,
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Counts, gaps, per-account scan state and provider permission problems."""
    return await service.diagnostics(scope)


@router.get("/{scope}/path")
async def find_path(
    scope: str,
    source: str = Query(..., description="Source resource id"),
    target: str = Query(..., description="Target resource id"),
    max_depth: int = Query(6, ge=1, le=12),
    view: Optional[str] = Query(None),
    relationship_types: Optional[str] = Query(
        None, description="Comma-separated edge kinds to restrict the search to"
    ),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """A shortest provider-confirmed relationship path, or an honest miss."""
    kinds: Optional[List[str]] = None
    if relationship_types:
        kinds = [k.strip() for k in relationship_types.split(",") if k.strip()]
    return await service.path(
        scope, source, target, max_depth=max_depth, view=view,
        relationship_types=kinds,
    )


@router.get("/{scope}/impact/{resource_id}")
async def impact(
    scope: str,
    resource_id: str,
    max_depth: int = Query(4, ge=1, le=8),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """What would be affected if this resource went away."""
    return await service.impact(scope, resource_id, max_depth=max_depth)


@router.get("/{scope}/edge/{edge_id}")
async def explain_edge(
    scope: str,
    edge_id: str,
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """One relationship with both endpoints and the evidence behind it."""
    return await service.edge(scope, edge_id)


@router.get("/{scope}/resource/{resource_id}")
async def resource_topology(
    scope: str,
    resource_id: str,
    request: Request,
    hops: int = Query(2, ge=1, le=5),
    view: Optional[str] = Query(None),
    include_raw: bool = Query(
        False, description="Include the raw provider payload (requires topology:view_raw)"
    ),
    service: TopologyService = Depends(get_topology_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """One resource, its neighbourhood and everything needed to investigate it.

    `include_raw` is decided here rather than as a route dependency because it
    is a parameter of this route, not a separate endpoint — and the refusal
    still goes through `rbac.deny` so it is recorded like every other.
    """
    if include_raw and not principal.can(rbac.TOPOLOGY_VIEW_RAW):
        await rbac.deny(principal, rbac.TOPOLOGY_VIEW_RAW, request)
    return await service.resource_topology(
        scope, resource_id, hops=hops, view=view, include_raw=include_raw,
    )


@router.get("/{scope}/resource/{resource_id}/neighbors")
async def resource_neighbors(
    scope: str,
    resource_id: str,
    hops: int = Query(1, ge=1, le=5),
    view: Optional[str] = Query(None),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_VIEW)),
) -> Dict[str, Any]:
    """Just the neighbourhood — for lazy expansion of a collapsed node."""
    return await service.neighbors(scope, resource_id, hops=hops, view=view)


@router.post("/{scope}/snapshot")
async def take_snapshot(
    scope: str,
    label: Optional[str] = Query(None, max_length=200),
    note: Optional[str] = Query(None, max_length=2000),
    service: TopologyService = Depends(get_topology_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_SNAPSHOT)),
) -> Dict[str, Any]:
    """Capture the current topology so it can be compared with later."""
    return await service.take_snapshot(
        scope, label=label, note=note, taken_by=principal.name,
    )


# ── export ───────────────────────────────────────────────────────────────────

def _csv_cell(value: Any) -> str:
    """Neutralise a value that a spreadsheet would evaluate as a formula.

    A resource name beginning with `=`, `+`, `-` or `@` is executed by Excel
    and Sheets on open. The same defence the Event Log export uses, for the
    same reason: an export is opened by a person, in a spreadsheet, and a
    resource name is attacker-influenced text.
    """
    if value is None:
        return ""
    text = str(value)
    if text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


@router.get("/{scope}/export")
async def export_topology(
    scope: str,
    fmt: str = Query("json", pattern="^(json|csv)$"),
    params: TopologyFilters = Depends(),
    service: TopologyService = Depends(get_topology_service),
    _: rbac.Principal = Depends(rbac.require(rbac.TOPOLOGY_EXPORT)),
) -> StreamingResponse:
    """Export the topology as it is currently filtered.

    Takes the same filter dependency as the graph endpoint, so what is exported
    is what is on screen — including the view mode, the search term and the
    hide toggles. An export that silently widened the scope back to everything
    would be worse than no export.
    """
    payload = await service.topology(scope, **params.as_kwargs())
    if "error" in payload:
        # A 200 with an error body would be written into the user's file.
        return StreamingResponse(
            iter([json.dumps(payload, indent=2)]),
            media_type="application/json",
            status_code=400,
        )

    nodes = payload["nodes"]
    edges = payload["edges"]
    stamp = (payload.get("topology_generated_at") or "").replace(":", "").replace("-", "")[:15]
    base = f"topology-{scope}-{stamp or 'export'}"

    if fmt == "json":
        body = {
            "generated_at": payload.get("topology_generated_at"),
            "scope": scope,
            "view": payload.get("view"),
            "filters": {k: v for k, v in params.filters.items() if v},
            "search": params.search,
            "metadata": {
                "resource_count": len(nodes),
                "relationship_count": len(edges),
                "coverage": payload.get("coverage"),
                "inventory": payload.get("inventory"),
                "confidence": "provider-confirmed",
            },
            "nodes": nodes,
            "edges": edges,
        }
        return StreamingResponse(
            iter([json.dumps(body, indent=2, default=str)]),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{base}.json"'},
        )

    # CSV: one row per relationship, which is the shape section 84 asks for.
    # Resources with no relationship would vanish from a relationship-only
    # file, so they are appended with an empty target and their isolation
    # reason — an export that dropped them would understate the inventory.
    node_by_id = {n["id"]: n for n in nodes}
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([
        "source_name", "source_type", "source_id",
        "relationship", "semantic", "label",
        "target_name", "target_type", "target_id",
        "provider", "evidence_field", "evidence_value", "confidence",
        "observed", "discovered_at",
    ])
    connected = set()
    for edge in edges:
        source = node_by_id.get(edge["source"], {})
        target = node_by_id.get(edge["target"], {})
        connected.add(edge["source"])
        connected.add(edge["target"])
        evidence = edge.get("evidence") or {}
        writer.writerow([_csv_cell(v) for v in (
            source.get("name"), source.get("type"), source.get("provider_id"),
            edge.get("type"), edge.get("semantic"), edge.get("label"),
            target.get("name"), target.get("type"), target.get("provider_id"),
            edge.get("provider"), evidence.get("field"), evidence.get("value"),
            evidence.get("confidence"), edge.get("observed"),
            evidence.get("discovered_at"),
        )])
    for node in nodes:
        if node["id"] in connected:
            continue
        writer.writerow([_csv_cell(v) for v in (
            node.get("name"), node.get("type"), node.get("provider_id"),
            "", "", "no discovered relationship",
            "", "", "", node.get("provider"), "", "", "", "", "",
        )])

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{base}.csv"'},
    )
