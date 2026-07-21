"""Topology service — calculates resource dependencies and relationship links."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Set

from sqlalchemy.ext.asyncio import AsyncSession
from app.repository.resource_repo import ResourceRepository
from app.repository.cloud_account_repo import CloudAccountRepository

logger = logging.getLogger("cloud_svc.topology")


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

        # Build node structure
        nodes.append({
            "id": rid,
            "name": r.resource_name,
            "type": r.resource_type,
            "status": r.status or "unknown",
            "cost": r.cost_monthly or 0.0,
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

        # ── VPC / Network relationships ──────────────────────────────────────
        vpc_id = config.get("vpc_id")
        if vpc_id:
            # Check if this VPC exists in our nodes
            vpc_node_id = resource_by_provider_id.get(vpc_id) or resource_by_name.get(vpc_id)
            if vpc_node_id:
                add_edge(rid, vpc_node_id, "contains")

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

        # ── Data Flow / Database access (Lambda env vars, S3 bucket names) ──
        if rtype == "LambdaFunction":
            env_vars = config.get("environment_variables") or {}
            # Scan all environment variable values for mentions of other resources
            for var_key, var_val in env_vars.items():
                if not isinstance(var_val, str):
                    continue
                
                # Check for table or bucket names
                # Try direct name lookup
                target_id = resource_by_name.get(var_val)
                if target_id:
                    add_edge(rid, target_id, "dataflow")
                    continue
                
                # Try substring lookup (e.g. ARN)
                for arn, res_id in resource_by_provider_id.items():
                    if arn in var_val or var_val in arn:
                        add_edge(rid, res_id, "dataflow")

        # ── RDS Instance database subnet or VPC ──────────────────────────────
        if rtype == "RDSInstance":
            # Link RDS to VPC
            subnets = config.get("subnets", [])
            for subnet in subnets:
                # RDS to subnet/vpc relationships if subnets are present
                pass

        # ── Fallback Heuristics for Topology Connections (Multi-Account / Seed Support) ──
        # 1. Lambda IAM Role fallback by name
        if rtype == "LambdaFunction":
            lambda_lower = r.resource_name.lower()
            base_name = lambda_lower.replace("lambda", "") if "lambda" in lambda_lower else lambda_lower
            
            for node in nodes:
                if node["type"] == "IAMRole":
                    role_lower = node["name"].lower()
                    if (lambda_lower in role_lower or base_name in role_lower or role_lower in lambda_lower) and ("role" in role_lower or "exec" in role_lower):
                        add_edge(rid, node["id"], "role")
                # 2. Database/Storage dataflow fallback by name matching
                elif node["type"] in ["DynamoDBTable", "S3Bucket", "RDSInstance"]:
                    st_lower = node["name"].lower()
                    if st_lower in lambda_lower or base_name in st_lower or st_lower in base_name:
                        add_edge(rid, node["id"], "dataflow")

        # 3. EC2 Security Group fallback by name
        if rtype == "EC2Instance":
            ec2_lower = r.resource_name.lower()
            for node in nodes:
                if node["type"] == "SecurityGroup":
                    sg_lower = node["name"].lower()
                    if sg_lower in ec2_lower or ec2_lower in sg_lower or (sg_lower == "default" and len([n for n in nodes if n["type"] == "SecurityGroup"]) == 1):
                        add_edge(rid, node["id"], "security")

        # 4. Containment by single VPC fallback
        if not vpc_id and rtype in ["EC2Instance", "RDSInstance", "SecurityGroup", "LambdaFunction"]:
            vpcs = [n for n in nodes if n["type"] == "VPC"]
            if len(vpcs) == 1:
                add_edge(rid, vpcs[0]["id"], "contains")

    return {
        "account_id": str(account_id),
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "total_edges": len(edges)
    }
