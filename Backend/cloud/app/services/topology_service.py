"""Topology service — resource dependency graph across AWS, Azure and OCI.

Edges are only ever drawn from data the provider actually reported. Nothing here
guesses: an earlier version matched resource names by substring and invented
relationships that did not exist, which is worse than a sparse graph because a
wrong edge is indistinguishable from a real one.

Every rule below resolves an identifier the provider gave us (an ARN, an OCID, an
ARM resource ID, an attachment target) against the inventory, and emits an edge
only on an exact hit. Identifiers that point at something we never discovered are
counted as "dangling" and reported in the response, so a missing edge is
visible as a scanner gap rather than silently absent.

Edge kinds:
  contains    parent owns child (ARM nesting, resource group, compartment)
  network     resource sits in a VPC / VNet / VCN / subnet
  security    resource is governed by a security group / NSG
  role        resource assumes an IAM role / identity
  attached    block storage attached to a compute instance
  dataflow    compute references a data store (Lambda env var)
  routes-to   load balancer forwards to a backend
  managed-by  another resource owns this one's lifecycle
"""
from __future__ import annotations

import logging
import uuid
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Set

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository

logger = logging.getLogger("cloud_svc.topology")

# Resource types that represent detachable block storage, per provider.
_STORAGE_TYPES = {"BlockVolume", "ManagedDisk", "EBSVolume"}


# ── identifier helpers ────────────────────────────────────────────────────────

def _extract_resource_group(provider_id: Optional[str]) -> Optional[str]:
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


def _arm_parent(provider_id: Optional[str]) -> Optional[str]:
    """The parent resource ID for a nested Azure (ARM) resource, else None.

    ARM encodes ownership in the ID itself: everything after `/providers/{ns}/`
    is a sequence of `type/name` pairs, and more than one pair means the resource
    is a child of the one formed by dropping the last pair:

      .../providers/Microsoft.Compute/virtualMachines/vm1/extensions/ext1
        -> .../providers/Microsoft.Compute/virtualMachines/vm1
      .../providers/Microsoft.Sql/servers/srv1/databases/db1      -> srv1
      .../providers/Microsoft.Network/virtualNetworks/vn1/subnets/s1 -> vn1

    This is free, exact structure — no API call and no guessing — and it is what
    connects Azure's long tail (extensions, databases, subnets, slots, elastic
    pools, DNS links) that the generic ARM sweep reports as flat rows.
    """
    if not provider_id:
        return None
    marker = "/providers/"
    idx = provider_id.lower().find(marker)
    if idx == -1:
        return None
    head = provider_id[:idx]
    parts = provider_id[idx + len(marker):].split("/")
    # parts = [namespace, type1, name1, type2, name2, ...]
    # One pair (len 3) is a top-level resource and has no parent here.
    if len(parts) < 5 or (len(parts) - 1) % 2 != 0:
        return None
    return f"{head}{marker}" + "/".join(parts[:-2])


def _strip_stream_suffix(arn: Optional[str]) -> Optional[str]:
    """A DynamoDB Streams ARN names the stream, not the table:
      arn:aws:dynamodb:r:a:table/Orders/stream/2026-08-17T00:00:00.000
    The table is what we have in inventory, so trim the stream part.
    """
    if not arn:
        return None
    return arn.split("/stream/")[0]


def _as_list(value: Any) -> List[str]:
    """Normalise a config field that may hold a single id or a list of ids."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, (list, tuple, set)):
        return [v for v in value if isinstance(v, str) and v]
    return []


class _Index:
    """Lookup from any provider identifier to our internal node id.

    Azure resource IDs are case-insensitive and the same ID comes back with
    different casing from different ARM endpoints, so every id lookup is folded
    to lowercase. Names are indexed separately and only consulted when an id
    lookup misses, because names are not unique across types.
    """

    def __init__(self) -> None:
        self.by_id: Dict[str, str] = {}
        self.by_name: Dict[str, str] = {}
        self.by_type_name: Dict[tuple, str] = {}
        self._ambiguous_names: Set[str] = set()

    def add(self, node_id: str, provider_id: Optional[str],
            name: Optional[str], rtype: Optional[str]) -> None:
        if provider_id:
            self.by_id[provider_id.lower()] = node_id
        if name:
            key = name.lower()
            if key in self.by_name and self.by_name[key] != node_id:
                # Two resources share a name — stop trusting the bare name.
                self._ambiguous_names.add(key)
            else:
                self.by_name[key] = node_id
            if rtype:
                self.by_type_name[(rtype, key)] = node_id

    def resolve(self, ident: Optional[str], rtype: Optional[str] = None) -> Optional[str]:
        if not ident:
            return None
        hit = self.by_id.get(ident.lower())
        if hit:
            return hit
        if rtype:
            hit = self.by_type_name.get((rtype, ident.lower()))
            if hit:
                return hit
        key = ident.lower()
        if key in self._ambiguous_names:
            return None
        return self.by_name.get(key)


# ── main entry point ──────────────────────────────────────────────────────────

async def get_topology(account_id: uuid.UUID | str, db: AsyncSession) -> Dict[str, Any]:
    res_repo = ResourceRepository(db)
    acc_repo = CloudAccountRepository(db)

    if account_id == "ALL":
        resources = await res_repo.list_all()
    else:
        try:
            aid = uuid.UUID(str(account_id))
            resources = await res_repo.list_by_account(aid)
        except ValueError:
            return {"error": "Invalid account ID format"}

    accounts = await acc_repo.list_all()
    account_map = {str(a.id): a.account_name for a in accounts}

    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []
    index = _Index()
    # Load balancers identify their backends by IP, not by id, so an address ->
    # instance map is the only way to connect a balancer to what it serves.
    by_ip: Dict[str, str] = {}

    # ── 1. nodes ──────────────────────────────────────────────────────────────
    for r in resources:
        rid = str(r.id)
        index.add(rid, r.provider_resource_id, r.resource_name, r.resource_type)
        cfg = r.config or {}
        for ip in (r.ip_address, cfg.get("private_ip"), cfg.get("public_ip")):
            # First writer wins: a load balancer also has an IP, and mapping an
            # address to the balancer instead of the instance would invert the edge.
            if ip and r.resource_type not in ("LoadBalancer", "NetworkLoadBalancer"):
                by_ip.setdefault(ip, rid)

        is_default = False
        if (r.resource_name or "").lower() == "default":
            is_default = True
        elif r.config and r.config.get("is_default") is True:
            is_default = True
        elif r.raw_data and (
            r.raw_data.get("IsDefault") is True or r.raw_data.get("GroupName") == "default"
        ):
            is_default = True

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
            "is_default": is_default,
        })

    added_edges: Set[str] = set()
    # Identifiers the provider reported that we could not resolve. These are the
    # honest signal that a scanner is not collecting something yet.
    dangling: Counter = Counter()

    # Structural relationships are symmetric facts reported from both ends: a NIC
    # lists its public IP while the public IP lists its NIC, and a subnet's ARM
    # parent is the same VNet its config names. Drawing both directions produced
    # visible duplicates (18 NIC->PublicIP plus 18 PublicIP->NIC), so for these
    # kinds one edge per pair is enough, whichever end reported it first.
    # Directional kinds (security, role, dataflow, permission, routes-to) are
    # excluded: those genuinely mean different things each way.
    _SYMMETRIC = {"contains", "network", "attached", "managed-by"}
    linked_pairs: Set[frozenset] = set()

    def add_edge(source: str, target: str, link_type: str, label: Optional[str] = None) -> bool:
        key = f"{source}->{target}:{link_type}"
        if source == target or key in added_edges:
            return False
        if link_type in _SYMMETRIC:
            pair = frozenset((source, target))
            if pair in linked_pairs:
                return False
            linked_pairs.add(pair)
        added_edges.add(key)
        edges.append({
            "id": str(uuid.uuid4()),
            "source": source,
            "target": target,
            "type": link_type,
            "label": label,
        })
        return True

    def link(source: str, ident: Optional[str], link_type: str,
             label: Optional[str] = None, expect_type: Optional[str] = None,
             gap: Optional[str] = None) -> bool:
        """Resolve `ident` and draw an edge, or record it as dangling."""
        if not ident:
            return False
        target = index.resolve(ident, expect_type)
        if target:
            return add_edge(source, target, link_type, label)
        if gap:
            dangling[gap] += 1
        return False

    # Resources with a real parent should not also hang off the resource-group /
    # compartment hub — that would draw every node twice and flatten the tree.
    has_parent: Set[str] = set()

    # ── 2. relationship rules ─────────────────────────────────────────────────
    for r in resources:
        rid = str(r.id)
        config = r.config or {}
        meta = r.metadata_ or {}
        rtype = r.resource_type

        # ARM nesting (Azure): child -> parent
        parent = _arm_parent(r.provider_resource_id)
        if parent and link(rid, parent, "contains", "child of",
                           gap="azure parent resource not discovered"):
            has_parent.add(rid)

        # Network containment: VPC (AWS) / VCN (OCI) / VNet (Azure)
        for ident in _as_list(config.get("vpc_id")) + _as_list(config.get("vcn_id")) \
                + _as_list(config.get("virtual_network_id")):
            link(rid, ident, "network", "in network",
                 gap="network (VPC/VCN/VNet) not discovered")

        # Subnet containment. Subnets are themselves resources when the scanner
        # collects them; when it does not, these are counted as dangling rather
        # than silently dropped.
        for ident in _as_list(config.get("subnet_id")) + _as_list(config.get("subnet_ids")):
            link(rid, ident, "network", "in subnet",
                 gap="subnet not discovered")

        # Security groups / NSGs / OCI Security Lists (the older, subnet-level
        # mechanism NSGs were added alongside, not a replacement for — a subnet
        # can be governed by either or both).
        for ident in (_as_list(config.get("security_group_ids"))
                      + _as_list(config.get("security_groups"))
                      + _as_list(config.get("nsg_id"))
                      + _as_list(config.get("network_security_group_id"))
                      + _as_list(config.get("security_list_ids"))):
            link(rid, ident, "security", "guarded by",
                 gap="security group / NSG / Security List not discovered")

        # OCI subnet -> its route table.
        link(rid, config.get("route_table_id"), "network", "routes via",
             gap="route table not discovered")

        # IAM role. Azure's config["identity_id"] is deliberately excluded: it is a
        # principal GUID, not a resource ID, so it can never resolve against the
        # inventory and only registered a permanent phantom gap.
        for ident in _as_list(config.get("role_arn")) + _as_list(config.get("role")):
            link(rid, ident, "role", "assumes",
                 gap="IAM role not discovered")

        # Azure VM wiring: its NICs and its managed disks, both given as full
        # resource IDs on the VM model.
        for ident in _as_list(config.get("nic_ids")):
            link(rid, ident, "network", "has interface",
                 gap="network interface not discovered")
        for ident in ([config.get("os_disk_id")] + _as_list(config.get("data_disk_ids"))):
            link(rid, ident, "attached", "has disk",
                 gap="managed disk not discovered")
        link(rid, config.get("availability_set_id"), "contains", "in availability set",
             gap="availability set not discovered")

        # Azure NIC -> the public IPs bound to it.
        for ident in _as_list(config.get("public_ip_ids")):
            link(rid, ident, "network", "exposes",
                 gap="public IP not discovered")

        # A NIC or public IP records what it is attached to. For a public IP that
        # is a NIC *ip-configuration* id, which is a child path of the NIC, so
        # trim it back to the NIC itself.
        if rtype in ("NetworkInterface", "PublicIP"):
            target = config.get("attached_to_id")
            if rtype == "PublicIP" and target and "/ipConfigurations/" in target:
                target = target.split("/ipConfigurations/")[0]
            link(rid, target, "network", "bound to",
                 gap="public IP / NIC attachment target not discovered")

        # Block storage attached to a compute instance. The scanners already
        # record this for OCI BlockVolume and Azure ManagedDisk; nothing was
        # drawing it, which is why 80 OCI volumes sat unconnected.
        if rtype in _STORAGE_TYPES and config.get("attachment_status") == "Attached":
            attached_to = config.get("attached_to_id") or config.get("attached_to_name")
            label = "attached to"
            if config.get("attached_to_status"):
                label = f"attached to ({config['attached_to_status']})"
            link(rid, attached_to, "attached", label,
                 gap="attached instance not discovered")

        # What a load balancer forwards to. AWS target groups give instance ids;
        # OCI backend sets give IP addresses, so those resolve through the IP map.
        for ident in _as_list(config.get("backend_instance_ids")):
            link(rid, ident, "routes-to", "forwards to",
                 gap="load balancer backend not discovered")
        for backend_ip in _as_list(config.get("backend_ips")):
            target = by_ip.get(backend_ip)
            if target:
                add_edge(rid, target, "routes-to", f"forwards to {backend_ip}")
            else:
                dangling["load balancer backend IP not matched to an instance"] += 1

        # Azure: another resource owns this one's lifecycle (disks owned by a VM,
        # anything created by a VM scale set).
        link(rid, config.get("managed_by"), "managed-by", "managed by",
             gap="managing resource not discovered")

        # Azure SQL: the scanner stores the parent server name in metadata.
        if rtype == "SQLDatabase" and meta.get("server"):
            link(rid, meta["server"], "contains", "hosted on", expect_type="SQLServer")

        # OCI Functions belong to an application
        link(rid, config.get("application_id"), "contains", "in application",
             gap="OCI function application not discovered")

        # Deliberately no edge for config["image_id"]: machine images are not
        # scanned as resources by design, so every instance would register a
        # permanent "unresolved" reference and drown the real gaps.

        # Streams / queues that invoke this function (DynamoDB Streams, SQS,
        # Kinesis). The trigger ARN points at the source, so the edge runs
        # source -> function, matching the direction the events travel.
        for src in _as_list(config.get("event_source_arns")):
            src_node = index.resolve(_strip_stream_suffix(src))
            if src_node:
                add_edge(src_node, rid, "dataflow", "triggers")
            else:
                dangling["lambda event source not discovered"] += 1

        # Lambda environment variables that name a real resource. Exact matches
        # only — substring guessing fabricated relationships and was removed.
        if rtype == "LambdaFunction":
            for var_key, var_val in (config.get("environment_variables") or {}).items():
                if isinstance(var_val, str) and var_val:
                    link(rid, var_val, "dataflow", f"uses ({var_key})")

    # ── 3. permissions granted through an IAM role ────────────────────────────
    # An IAM role is where "this Lambda writes to that table" is actually
    # recorded, so the edge is drawn from the thing that runs code to the thing it
    # is allowed to reach — that is the question people ask of the graph. The
    # role edge added above still shows which role carries the grant.
    #
    # Only concrete resource ARNs become edges. Wildcard grants (`Resource: "*"`,
    # very common) are surfaced as the role's `broad_access` summary instead:
    # expanding them would connect every consumer to every table and mean nothing.
    role_grants: Dict[str, List[dict]] = {}
    for r in resources:
        if r.resource_type == "IAMRole":
            grants = (r.config or {}).get("accessible_resources") or []
            if grants:
                role_grants[str(r.id)] = [g for g in grants if isinstance(g, dict)]

    # Wildcard grants per role. These are the reason a consumer can have no
    # permission edge at all while genuinely having access: if a policy says
    # `Resource: "*"`, AWS itself never records which specific tables are meant,
    # so there is no true edge to draw. Carried onto the node so the UI can say
    # "can reach every DynamoDB table" instead of showing a bare unconnected node.
    role_broad: Dict[str, List[str]] = {}
    for r in resources:
        if r.resource_type == "IAMRole":
            broad = (r.config or {}).get("broad_access") or []
            if broad:
                role_broad[str(r.id)] = list(broad)

    broad_by_node: Dict[str, List[str]] = dict(role_broad)
    roles_with_consumer: Set[str] = set()
    if role_grants or role_broad:
        for r in resources:
            config = r.config or {}
            role_ident = config.get("role_arn") or config.get("role")
            role_node = index.resolve(role_ident) if role_ident else None
            if not role_node:
                continue
            if role_node in role_broad:
                broad_by_node.setdefault(str(r.id), role_broad[role_node])
            if role_node not in role_grants:
                continue
            roles_with_consumer.add(role_node)
            for grant in role_grants[role_node]:
                link(str(r.id), grant.get("resource"), "permission",
                     f"can {grant.get('access', 'access')}",
                     gap="permission target not discovered")

        # A role nothing assumes still has meaningful grants — attach them to the
        # role itself so they are not invisible.
        for role_node, grants in role_grants.items():
            if role_node in roles_with_consumer:
                continue
            for grant in grants:
                link(role_node, grant.get("resource"), "permission",
                     f"grants {grant.get('access', 'access')}",
                     gap="permission target not discovered")

    # ── 4. grouping hubs ──────────────────────────────────────────────────────
    # Azure resource groups. Case-insensitive so "actin" and "ACTIN" merge.
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
            nodes.append({
                "id": hub_id, "name": rg, "type": "ResourceGroup",
                "status": None, "cost": None, "region": r.region_or_zone,
                "provider_id": rg,
                "account_name": account_map.get(str(r.account_id), "Unknown"),
                "account_id": str(r.account_id), "is_default": False,
            })
        # Only top-level resources attach to the group; nested ones reach it
        # through their parent.
        if str(r.id) not in has_parent:
            add_edge(hub_id, str(r.id), "contains", "contains")

    # OCI compartments — a genuine containment the scanner records per resource.
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
                "id": hub_id, "name": comp_name, "type": "Compartment",
                "status": None, "cost": None, "region": r.region_or_zone,
                "provider_id": comp_id,
                "account_name": account_map.get(str(r.account_id), "Unknown"),
                "account_id": str(r.account_id), "is_default": False,
            })
        if str(r.id) not in has_parent:
            add_edge(hub_id, str(r.id), "contains", "contains")

    # Attach wildcard-permission summaries to their nodes.
    if broad_by_node:
        for n in nodes:
            broad = broad_by_node.get(n["id"])
            if broad:
                n["broad_access"] = broad

    connected = {e["source"] for e in edges} | {e["target"] for e in edges}
    isolated = [n["id"] for n in nodes if n["id"] not in connected]

    if dangling:
        logger.info(
            "Topology for %s: %d edge(s); unresolved references: %s",
            account_id, len(edges), dict(dangling),
        )

    return {
        "account_id": str(account_id),
        "nodes": nodes,
        "edges": edges,
        "total_nodes": len(nodes),
        "total_edges": len(edges),
        "edge_type_counts": dict(Counter(e["type"] for e in edges)),
        "isolated_nodes": len(isolated),
        # What the providers referenced but we never discovered — the honest
        # explanation for any relationship a user expects but cannot see.
        "unresolved_references": dict(dangling),
    }
