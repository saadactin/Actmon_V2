"""Topology service — calculates resource dependencies and relationship links."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Set

from sqlalchemy.ext.asyncio import AsyncSession
from app.repository.resource_repo import ResourceRepository
from app.repository.cloud_account_repo import CloudAccountRepository

logger = logging.getLogger("cloud_svc.topology")


def _extract_resource_group(provider_id: str | None) -> str | None:
    """Pull the resource-group name out of an Azure resource ID.

    Azure IDs look like:
      /subscriptions/{sub}/resourceGroups/{RG}/providers/{ns}/{type}/{name}
    Returns None for non-Azure IDs (no /resourceGroups/ segment).
    """
    if not provider_id:
        return None
    marker = "/resourcegroups/"
    lower = provider_id.lower()
    idx = lower.find(marker)
    if idx == -1:
        return None
    rest = provider_id[idx + len(marker):]
    return rest.split("/")[0] if rest else None


async def get_topology(account_id: uuid.UUID | str, db: AsyncSession) -> Dict[str, Any]:
    res_repo = ResourceRepository(db)
    acc_repo = CloudAccountRepository(db)

    # 1. Fetch resources
    if account_id == "ALL":
        resources = await res_repo.list_all()
    else:
        try:
            aid = uuid.UUID(str(account_id))
            resources = await res_repo.list_by_account(aid)
        except ValueError:
            return {"error": "Invalid account ID format"}

    # Fetch all accounts to map account names for nodes
    accounts = await acc_repo.list_all()
    account_map = {str(a.id): a.account_name for a in accounts}

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    
    # Track resource mapping by names/ARNs/IDs for fast lookup
    resource_by_arn: Dict[str, str] = {}
    resource_by_name: Dict[str, str] = {}
    resource_by_provider_id: Dict[str, str] = {}

    for r in resources:
        rid = str(r.id)
        resource_by_provider_id[r.provider_resource_id] = rid
        resource_by_name[r.resource_name] = rid
        
        # Determine if resource is default (boilerplate)
        is_default = False
        if r.resource_name.lower() == "default":
            is_default = True
        elif r.config and r.config.get("is_default") is True:
            is_default = True
        elif r.raw_data and (r.raw_data.get("IsDefault") is True or r.raw_data.get("GroupName") == "default"):
            is_default = True

        # Build node structure — status/cost are None (NA) when not reported
        nodes.append({
            "id": rid,
            "name": r.resource_name,
            "type": r.resource_type,
            "status": r.status,
            "cost": r.cost_monthly,
            "region": r.region_or_zone,
            "provider_id": r.provider_resource_id,
            "account_name": account_map.get(str(r.account_id), "Unknown"),
            "account_id": str(r.account_id),
            "is_default": is_default
        })

    # Helper to create connection
    added_edges: Set[str] = set()

    def add_edge(source: str, target: str, link_type: str):
        edge_key = f"{source}-{target}-{link_type}"
        if edge_key not in added_edges and source != target:
            added_edges.add(edge_key)
            edges.append({
                "id": str(uuid.uuid4()),
                "source": source,
                "target": target,
                "type": link_type
            })

    # 2. Build edges based on config analysis & fallback name matching
    for r in resources:
        rid = str(r.id)
        config = r.config or {}
        rtype = r.resource_type

        # ── VPC (AWS) / VCN (OCI) network relationships ──────────────────────
        # NSGs and OKE clusters store the real network OCID in config.vcn_id;
        # AWS resources store vpc_id. Link the resource to that network node.
        network_id = config.get("vpc_id") or config.get("vcn_id")
        if network_id:
            net_node_id = resource_by_provider_id.get(network_id) or resource_by_name.get(network_id)
            if net_node_id:
                add_edge(rid, net_node_id, "network")

        # ── Security Group relationships ─────────────────────────────────────
        sg_ids = config.get("security_group_ids") or config.get("security_groups")
        if sg_ids:
            if isinstance(sg_ids, str):
                sg_ids = [sg_ids]
            for sg in sg_ids:
                sg_node_id = resource_by_provider_id.get(sg) or resource_by_name.get(sg)
                if sg_node_id:
                    add_edge(rid, sg_node_id, "security")

        # ── IAM Role relationships ───────────────────────────────────────────
        role_arn = config.get("role_arn") or config.get("role")
        if role_arn:
            role_node_id = resource_by_provider_id.get(role_arn) or resource_by_name.get(role_arn)
            if role_node_id:
                add_edge(rid, role_node_id, "role")

        # ── Data Flow / Database access (Lambda env vars) ─────────────────────
        # Edges come only from exact matches against real resource names/ARNs —
        # substring guessing fabricated relationships and was removed.
        if rtype == "LambdaFunction":
            env_vars = config.get("environment_variables") or {}
            for var_key, var_val in env_vars.items():
                if not isinstance(var_val, str) or not var_val:
                    continue
                target_id = (
                    resource_by_name.get(var_val)
                    or resource_by_provider_id.get(var_val)
                )
                if target_id:
                    add_edge(rid, target_id, "dataflow")

    # ── Azure / resource-group grouping ──────────────────────────────────────
    # Azure resource IDs embed their resource group:
    #   /subscriptions/{sub}/resourceGroups/{RG}/providers/{ns}/{type}/{name}
    # Create one synthetic hub node per resource group and link its resources
    # with a "contains" edge, producing a readable tree even when the network
    # layer (VNets/NICs/NSGs) hasn't been discovered.
    # Azure RG names are case-insensitive, so key hubs by lowercase to merge
    # variants like "actin" / "ACTIN" that reference the same group.
    rg_hub_by_name: Dict[str, str] = {}
    for r in resources:
        rg = _extract_resource_group(r.provider_resource_id)
        if not rg:
            continue
        rg_key = rg.lower()
        hub_id = rg_hub_by_name.get(rg_key)
        if hub_id is None:
            hub_id = f"rg::{rg_key}"
            rg_hub_by_name[rg_key] = hub_id
            # Synthetic grouping node — status/cost are None: it is a visual
            # container, not a provider resource with real state or spend
            nodes.append({
                "id": hub_id,
                "name": rg,
                "type": "ResourceGroup",
                "status": None,
                "cost": None,
                "region": r.region_or_zone,
                "provider_id": rg,
                "account_name": account_map.get(str(r.account_id), "Unknown"),
                "account_id": str(r.account_id),
                "is_default": False,
            })
        add_edge(hub_id, str(r.id), "contains")

    # ── OCI / compartment grouping ────────────────────────────────────────────
    # Every OCI resource genuinely lives in a compartment; the scanner stores its
    # OCID (compartment_id) and readable name (compartment_name) in metadata.
    # Create one hub per compartment and link its resources with a "contains"
    # edge — a real containment relationship, not an inferred one.
    comp_hub_by_id: Dict[str, str] = {}
    for r in resources:
        meta = r.metadata_ or {}
        comp_id = meta.get("compartment_id")
        if not comp_id:
            continue
        hub_id = comp_hub_by_id.get(comp_id)
        if hub_id is None:
            hub_id = f"compartment::{comp_id}"
            comp_hub_by_id[comp_id] = hub_id
            comp_name = meta.get("compartment_name") or (
                "root" if comp_id.startswith("ocid1.tenancy") else comp_id[:24] + "…"
            )
            nodes.append({
                "id": hub_id,
                "name": comp_name,
                "type": "Compartment",
                "status": None,
                "cost": None,
                "region": r.region_or_zone,
                "provider_id": comp_id,
                "account_name": account_map.get(str(r.account_id), "Unknown"),
                "account_id": str(r.account_id),
                "is_default": False,
            })
        add_edge(hub_id, str(r.id), "contains")

    return {
        "account_id": str(account_id),
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "total_edges": len(edges)
    }
