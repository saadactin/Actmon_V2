"""Builds the topology graph from the resource inventory.

Every edge here resolves an identifier a provider actually reported against the
inventory and is emitted only on an exact hit. Identifiers that point at
something we never discovered become unresolved references, recorded with the
resource, the field and the value — so a missing edge is visible as a scanner
gap instead of silently absent.

The rules this file applies are the ones the previous resolver applied, field
for field, plus the ones in `rules.py` that no code was reading yet. What is
new is that each edge now carries its evidence: which field, on which resource,
holding which value. Section 78 is the reason — a security analyst has to be
able to defend why the graph says two resources are connected, and "the
topology said so" is not a defence.

## What is deliberately NOT done

*   No name substring matching. An earlier version of this feature matched
    resource names by substring and invented relationships that did not exist,
    which is worse than a sparse graph because a wrong edge is
    indistinguishable from a real one.
*   No inference from shared region, shared resource group, similar tags or
    adjacent IP addresses.
*   Wildcard IAM grants are summarised, never expanded into per-resource edges.
*   A bare name is only ever accepted when an id lookup has already missed AND
    the name is unambiguous across the inventory.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.topology.graph import Graph
from app.topology.model import (
    ATTACHED,
    CONTAINS,
    DATAFLOW,
    PERMISSION,
    RELATIONSHIPS,
    ROUTES_TO,
    SYMMETRIC_KINDS,
    SYNTHETIC_TYPES,
    UNCOLLECTED_TARGETS,
    category_of,
    health_of,
    reference_class,
)
from app.topology.rules import RULES, Rule

logger = logging.getLogger("cloud_svc.topology.builder")

# Resource types that represent detachable block storage, per provider.
_STORAGE_TYPES = frozenset({"BlockVolume", "ManagedDisk", "EBSVolume", "BootVolume"})

# Every config/metadata key any rule reads, plus the keys the special-case rules
# below read. Used to decide whether an unconnected resource had any
# relationship field to begin with — the difference between "genuinely
# standalone" and "this type carries nothing we could use" (section 34).
_RELATIONSHIP_FIELDS: Set[str] = {rule.field for rule in RULES} | {
    "attached_to_id", "attached_to_name", "backend_ips", "event_source_arns",
    "environment_variables", "route_rules", "accessible_resources",
}


def _canonical_provider(raw: Optional[str]) -> str:
    """`Oracle` and `OCI` are the same provider on different records.

    The account table holds both spellings depending on when the account was
    added, and the frontend already normalises one way (see
    utils/providerScope.js). Doing it here too means every consumer of the
    topology sees one value per provider instead of two that must be compared
    through a helper.
    """
    if not raw:
        return "Unknown"
    return "OCI" if raw == "Oracle" else raw


# ── identifier helpers (unchanged behaviour, moved here) ─────────────────────

def extract_resource_group(provider_id: Optional[str]) -> Optional[str]:
    """Pull the resource-group name out of an Azure resource ID.

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


def extract_subscription(provider_id: Optional[str]) -> Optional[str]:
    """The subscription GUID out of an Azure resource ID."""
    if not provider_id:
        return None
    marker = "/subscriptions/"
    lower = provider_id.lower()
    idx = lower.find(marker)
    if idx == -1:
        return None
    rest = provider_id[idx + len(marker):]
    return rest.split("/")[0] if rest else None


def arm_parent(provider_id: Optional[str]) -> Optional[str]:
    """The parent resource ID for a nested Azure (ARM) resource, else None.

    ARM encodes ownership in the ID itself: everything after `/providers/{ns}/`
    is a sequence of `type/name` pairs, and more than one pair means the
    resource is a child of the one formed by dropping the last pair:

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


def strip_stream_suffix(arn: Optional[str]) -> Optional[str]:
    """A DynamoDB Streams ARN names the stream, not the table:
      arn:aws:dynamodb:r:a:table/Orders/stream/2026-08-17T00:00:00.000
    The table is what we have in inventory, so trim the stream part.
    """
    if not arn:
        return None
    return arn.split("/stream/")[0]


def as_list(value: Any) -> List[str]:
    """Normalise a config field that may hold a single id or a list of ids."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, (list, tuple, set)):
        return [v for v in value if isinstance(v, str) and v]
    return []


class ResourceIndex:
    """Lookup from any provider identifier to our internal node id.

    Azure resource IDs are case-insensitive and the same ID comes back with
    different casing from different ARM endpoints, so every id lookup is folded
    to lowercase. Names are indexed separately and only consulted when an id
    lookup misses, because names are not unique across types — and a name that
    turns out to belong to two resources is dropped from the name index
    entirely rather than resolving to whichever was seen first.
    """

    __slots__ = (
        "by_id", "by_name", "by_type_name", "_ambiguous_names",
        "_ambiguous_type_names", "by_ip",
    )

    def __init__(self) -> None:
        self.by_id: Dict[str, str] = {}
        self.by_name: Dict[str, str] = {}
        self.by_type_name: Dict[Tuple[str, str], str] = {}
        self._ambiguous_names: Set[str] = set()
        self._ambiguous_type_names: Set[Tuple[str, str]] = set()
        # Load balancers identify their backends by IP, not by id, so an
        # address -> instance map is the only way to connect a balancer to what
        # it serves. This is the provider's own authoritative identifier for a
        # backend, not a guess that an address "looks like" an instance.
        self.by_ip: Dict[str, str] = {}

    def add(
        self,
        node_id: str,
        provider_id: Optional[str],
        name: Optional[str],
        rtype: Optional[str],
    ) -> None:
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
                typed = (rtype, key)
                # The same guard the bare-name index gets. Without it the
                # type-scoped lookup was a way around the ambiguity check: two
                # SQL servers called "shared" resolved to whichever happened to
                # be indexed last, which is a name being used as identity.
                if typed in self.by_type_name and self.by_type_name[typed] != node_id:
                    self._ambiguous_type_names.add(typed)
                else:
                    self.by_type_name[typed] = node_id

    def add_ip(self, ip: Optional[str], node_id: str, rtype: Optional[str]) -> None:
        # First writer wins, and balancers are excluded: a load balancer also
        # has an IP, and mapping an address to the balancer instead of the
        # instance would invert the edge.
        if ip and rtype not in ("LoadBalancer", "NetworkLoadBalancer"):
            self.by_ip.setdefault(ip, node_id)

    def resolve(
        self,
        ident: Optional[str],
        rtype: Optional[str] = None,
        *,
        allow_name: bool = False,
    ) -> Optional[str]:
        """Resolve an identifier to a node id.

        Identifier lookup only, unless the caller declares that the field it
        read genuinely holds a NAME. That default is the whole of rule 4 -
        never use a resource name as authoritative identity - and it is a
        default rather than a special case because the name fallback was a live
        bug on every field: a Lambda whose environment held `LOG_LEVEL=debug`
        drew a data-flow edge to a DynamoDB table called "debug". A
        configuration value that happens to equal some resource's name is not a
        reference to that resource.

        Exactly two fields opt in, and both hold a name by construction: Azure
        SQL's `metadata.server`, and a storage attachment that reported
        `attached_to_name` because the provider gave no id.
        """
        if not ident:
            return None
        hit = self.by_id.get(ident.lower())
        if hit:
            return hit
        if not allow_name:
            return None
        key = ident.lower()
        if rtype:
            typed = (rtype, key)
            if typed in self._ambiguous_type_names:
                return None
            hit = self.by_type_name.get(typed)
            if hit:
                return hit
        if key in self._ambiguous_names:
            return None
        return self.by_name.get(key)

    def is_ambiguous(self, ident: Optional[str], rtype: Optional[str] = None) -> bool:
        if not ident:
            return False
        key = ident.lower()
        if rtype and (rtype, key) in self._ambiguous_type_names:
            return True
        return key in self._ambiguous_names


class _Builder:
    """One build. Holds the mutable bookkeeping a build needs."""

    def __init__(self, account_map: Dict[str, Dict[str, Any]]) -> None:
        self.graph = Graph()
        self.index = ResourceIndex()
        self.account_map = account_map
        self._edge_keys: Set[str] = set()
        # Keyed by (kind, unordered pair). Keying by the pair alone was a bug:
        # `attached` and `managed-by` are both symmetric, so an Azure VM's
        # os_disk_id edge was silently refused because the disk's managed_by
        # edge had already claimed that pair - losing a real relationship, and
        # which one survived depended on the order the rules ran in.
        self._symmetric_pairs: Set[Tuple[str, frozenset]] = set()
        # Resources with a real parent should not also hang off the
        # resource-group / compartment hub — that would draw every node twice
        # and flatten the tree.
        self.has_parent: Set[str] = set()
        # Per-resource unresolved reference detail, keyed so repeats of the
        # same (resource, field, value) collapse.
        self._unresolved: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

    # ── edges ────────────────────────────────────────────────────────────────

    def add_edge(
        self,
        source: str,
        target: str,
        kind: str,
        label: Optional[str],
        *,
        evidence_field: Optional[str],
        evidence_value: Optional[str],
        provider: Optional[str],
        discovered_at: Optional[str] = None,
        note: Optional[str] = None,
    ) -> bool:
        key = f"{source}->{target}:{kind}"
        if source == target or key in self._edge_keys:
            return False
        if kind in SYMMETRIC_KINDS:
            # Structural relationships are symmetric facts reported from both
            # ends: a NIC lists its public IP while the public IP lists its
            # NIC, and a subnet's ARM parent is the same VNet its config names.
            # Drawing both directions produced visible duplicates, so for these
            # kinds one edge per pair is enough, whichever end reported it
            # first. Directed kinds are excluded — those genuinely mean
            # different things each way.
            pair = (kind, frozenset((source, target)))
            if pair in self._symmetric_pairs:
                return False
            self._symmetric_pairs.add(pair)
        self._edge_keys.add(key)

        relationship = RELATIONSHIPS.get(kind)
        self.graph.add_edge({
            "id": str(uuid.uuid4()),
            "source": source,
            "target": target,
            "type": kind,
            "semantic": relationship.semantic if relationship else kind.upper(),
            "label": label,
            "direction": relationship.direction if relationship else "directed",
            "observed": relationship.observed if relationship else True,
            "provider": provider,
            # Why this edge exists, in the terms an analyst can verify against
            # the provider's own API output.
            "evidence": {
                "field": evidence_field,
                "value": evidence_value,
                "source_resource_id": source,
                "target_resource_id": target,
                "provider": provider,
                "confidence": "provider-confirmed",
                "discovered_at": discovered_at,
                "note": note,
            },
        })
        return True

    def link(
        self,
        resource: Any,
        node_id: str,
        ident: Optional[str],
        kind: str,
        label: Optional[str],
        *,
        evidence_field: str,
        gap: Optional[str],
        expect_type: Optional[str] = None,
        reverse: bool = False,
        note: Optional[str] = None,
        allow_name: bool = False,
    ) -> bool:
        """Resolve `ident` and draw an edge, or record an unresolved reference."""
        if not ident:
            return False
        provider = _canonical_provider(
            self.account_map.get(str(resource.account_id), {}).get("provider")
        )
        discovered_at = (
            resource.updated_at.isoformat() if getattr(resource, "updated_at", None) else None
        )
        target = self.index.resolve(ident, expect_type, allow_name=allow_name)
        if target:
            source, dest = (target, node_id) if reverse else (node_id, target)
            return self.add_edge(
                source, dest, kind, label,
                evidence_field=evidence_field,
                evidence_value=ident,
                provider=provider,
                discovered_at=discovered_at,
                note=note,
            )
        if gap:
            self.record_unresolved(
                resource, node_id, evidence_field, ident, gap, kind, expect_type
            )
        return False

    def record_unresolved(
        self,
        resource: Any,
        node_id: str,
        field: str,
        value: str,
        gap: str,
        kind: str,
        expect_type: Optional[str] = None,
    ) -> None:
        key = (node_id, field, value)
        existing = self._unresolved.get(key)
        if existing:
            existing["count"] += 1
            return
        provider = _canonical_provider(
            self.account_map.get(str(resource.account_id), {}).get("provider")
        )
        klass = reference_class(gap)
        self._unresolved[key] = {
            "resource_id": node_id,
            "resource_name": resource.resource_name,
            "resource_type": resource.resource_type,
            "provider_resource_id": resource.provider_resource_id,
            "provider": provider,
            "region": resource.region_or_zone,
            "field": field,
            "value": value,
            "expected_type": expect_type,
            "relationship": kind,
            "gap": gap,
            "reference_class": klass,
            "explanation": (
                UNCOLLECTED_TARGETS[gap] if klass == "unsupported_type"
                else (
                    "The identifier is ambiguous: more than one discovered "
                    "resource carries this name, so resolving it would be a "
                    "guess."
                    if self.index.is_ambiguous(value, expect_type) else
                    "The provider reported this identifier, but no resource "
                    "with it was found in the inventory. The target was most "
                    "likely not returned by a discovery scan — a permission "
                    "gap, an unswept region, or a resource created since the "
                    "last scan."
                )
            ),
            "count": 1,
        }

    def finish(self) -> Graph:
        self.graph.unresolved = list(self._unresolved.values())
        return self.graph


# ── node construction ────────────────────────────────────────────────────────

def _availability_zone(config: Dict[str, Any]) -> Optional[str]:
    """The AZ / availability domain / zone, wherever this provider puts it.

    These live in config rather than in region_or_zone: an earlier fix moved
    OCI availability domains and AWS availability zones out of the region
    column, because holding both in one field made an OCI tenancy in two
    regions report five of them.
    """
    for key in ("availability_domain", "availability_zone", "fault_domain"):
        value = config.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _is_default(resource: Any) -> bool:
    config = resource.config or {}
    raw = resource.raw_data or {}
    if (resource.resource_name or "").lower() == "default":
        return True
    if config.get("is_default") is True:
        return True
    if raw.get("IsDefault") is True or raw.get("GroupName") == "default":
        return True
    return False


def _has_relationship_fields(config: Dict[str, Any], meta: Dict[str, Any]) -> bool:
    for field in _RELATIONSHIP_FIELDS:
        if config.get(field) or meta.get(field):
            return True
    return False


def build_node(resource: Any, account: Dict[str, Any]) -> Dict[str, Any]:
    """The wire shape of one resource node.

    Carries what a tooltip, a filter and a table row need without a second
    request (section 54), and no more: `config`, `metadata` and `raw_data` are
    served by the per-resource endpoint instead, because attaching them to
    every node in a 1,400-resource account would multiply the payload by two
    orders of magnitude for data that is only read one resource at a time.
    """
    config = resource.config or {}
    meta = resource.metadata_ or {}
    provider = _canonical_provider(account.get("provider"))
    rtype = resource.resource_type

    return {
        "id": str(resource.id),
        # ── identity ──
        "name": resource.resource_name,
        "type": rtype,
        "category": category_of(rtype),
        "provider": provider,
        "provider_id": resource.provider_resource_id,
        # An alias, so a consumer reading the specification's `resourceId` and
        # one reading this codebase's `provider_id` both find the same string.
        "resource_id": resource.provider_resource_id,
        "account_id": str(resource.account_id),
        "account_name": account.get("account_name", "Unknown"),
        "environment": account.get("environment"),
        # ── placement ──
        "region": resource.region_or_zone,
        "availability_zone": _availability_zone(config),
        "subscription_id": extract_subscription(resource.provider_resource_id),
        "resource_group": extract_resource_group(resource.provider_resource_id),
        "compartment_id": meta.get("compartment_id"),
        "compartment_name": meta.get("compartment_name"),
        # ── state ──
        "status": resource.status,
        # Never inferred from the resource existing (section 47).
        "health": health_of(resource.status),
        "cost": resource.cost_monthly,
        # ── addresses ──
        "ip_address": resource.ip_address,
        "private_ip": config.get("private_ip"),
        "public_ip": config.get("public_ip"),
        # ── flags ──
        "is_default": _is_default(resource),
        "is_synthetic": False,
        "has_relationship_fields": _has_relationship_fields(config, meta),
        "tag_count": len(resource.tags) if isinstance(resource.tags, dict) else 0,
        # ── provenance ──
        "source": f"{provider} discovery scan",
        "discovered_at": (
            resource.discovered_at.isoformat() if resource.discovered_at else None
        ),
        "updated_at": (
            resource.updated_at.isoformat() if resource.updated_at else None
        ),
    }


def _synthetic_node(
    node_id: str,
    name: str,
    rtype: str,
    resource: Any,
    account: Dict[str, Any],
    *,
    provider_id: str,
) -> Dict[str, Any]:
    """A grouping hub — a resource group or compartment.

    Flagged `is_synthetic` so the UI can keep it visually distinct from real
    infrastructure (section 44). These are containers we assemble from a field
    every member resource carries; the provider does not return them as
    resources here.
    """
    provider = _canonical_provider(account.get("provider"))
    return {
        "id": node_id,
        "name": name,
        "type": rtype,
        "category": category_of(rtype),
        "provider": provider,
        "provider_id": provider_id,
        "resource_id": provider_id,
        "account_id": str(resource.account_id),
        "account_name": account.get("account_name", "Unknown"),
        "environment": account.get("environment"),
        "region": resource.region_or_zone,
        "availability_zone": None,
        "subscription_id": extract_subscription(resource.provider_resource_id),
        "resource_group": name if rtype == "ResourceGroup" else None,
        "compartment_id": provider_id if rtype == "Compartment" else None,
        "compartment_name": name if rtype == "Compartment" else None,
        "status": None,
        "health": "Unknown",
        "cost": None,
        "ip_address": None,
        "private_ip": None,
        "public_ip": None,
        "is_default": False,
        "is_synthetic": True,
        "has_relationship_fields": False,
        "tag_count": 0,
        "source": "Derived from the resource identifier",
        "discovered_at": None,
        "updated_at": None,
    }


# ── the build ────────────────────────────────────────────────────────────────

def build_graph(
    resources: Sequence[Any],
    accounts: Iterable[Any],
    *,
    scope: str = "ALL",
) -> Graph:
    """Resolve every relationship rule over the inventory and return the graph."""
    account_map: Dict[str, Dict[str, Any]] = {
        str(a.id): {
            "account_name": a.account_name,
            "provider": a.provider,
            "environment": a.environment,
            "last_discovery": a.last_discovery,
        }
        for a in accounts
    }
    builder = _Builder(account_map)
    graph = builder.graph
    index = builder.index

    # ── 1. nodes ──────────────────────────────────────────────────────────────
    for resource in resources:
        node_id = str(resource.id)
        index.add(
            node_id, resource.provider_resource_id,
            resource.resource_name, resource.resource_type,
        )
        config = resource.config or {}
        for ip in (resource.ip_address, config.get("private_ip"), config.get("public_ip")):
            index.add_ip(ip, node_id, resource.resource_type)
        graph.add_node(build_node(resource, account_map.get(str(resource.account_id), {})))

    # ── 2. declarative rules ──────────────────────────────────────────────────
    for resource in resources:
        node_id = str(resource.id)
        config = resource.config or {}
        meta = resource.metadata_ or {}
        rtype = resource.resource_type

        # ARM nesting (Azure): child -> parent. Applied first because it is
        # what decides whether the resource also attaches to a grouping hub.
        parent = arm_parent(resource.provider_resource_id)
        if parent and builder.link(
            resource, node_id, parent, CONTAINS, "child of",
            evidence_field="provider_resource_id (ARM parent path)",
            gap="azure parent resource not discovered",
            reverse=True,
            note=(
                "Azure encodes ownership in the resource ID itself: dropping "
                "the last type/name pair yields the parent. No API call and no "
                "inference."
            ),
        ):
            builder.has_parent.add(node_id)

        for rule in RULES:
            if rule.applies_to and rtype not in rule.applies_to:
                continue
            container = config if rule.source_of_truth == "config" else meta
            for ident in as_list(container.get(rule.field)):
                builder.link(
                    resource, node_id, ident, rule.kind, rule.label,
                    evidence_field=rule.evidence_field,
                    gap=rule.gap,
                    expect_type=rule.expect_type,
                    reverse=rule.reverse,
                )

        # ── 3. rules that need more than a field read ─────────────────────────

        # A NIC or public IP records what it is attached to. For a public IP
        # that is a NIC *ip-configuration* id, which is a child path of the
        # NIC, so trim it back to the NIC itself.
        if rtype in ("NetworkInterface", "PublicIP"):
            target = config.get("attached_to_id")
            note = None
            if rtype == "PublicIP" and target and "/ipConfigurations/" in target:
                target = target.split("/ipConfigurations/")[0]
                note = (
                    "Azure reports the NIC's ip-configuration path; trimmed to "
                    "the network interface, which is the resource in inventory."
                )
            builder.link(
                resource, node_id, target, "network", "bound to",
                evidence_field="config.attached_to_id",
                gap="public IP / NIC attachment target not discovered",
                note=note,
            )

        # Block storage attached to a compute instance. Only when the provider
        # says it is actually attached — a detached volume that remembers its
        # last instance is not attached to it.
        if rtype in _STORAGE_TYPES and config.get("attachment_status") == "Attached":
            attached_to = config.get("attached_to_id")
            field = "config.attached_to_id"
            if not attached_to:
                attached_to = config.get("attached_to_name")
                field = "config.attached_to_name"
            label = "attached to"
            if config.get("attached_to_status"):
                label = f"attached to ({config['attached_to_status']})"
            builder.link(
                resource, node_id, attached_to, ATTACHED, label,
                evidence_field=field,
                gap="attached instance not discovered",
                # Only when we fell back to the NAME field, which holds a name
                # by construction. `attached_to_id` stays identifier-only.
                allow_name=(field == "config.attached_to_name"),
            )

        # OCI load balancer backend sets identify backends by IP address —
        # that is the provider's own authoritative identifier for a backend, so
        # it resolves through the address index rather than by name.
        for backend_ip in as_list(config.get("backend_ips")):
            target = index.by_ip.get(backend_ip)
            if target:
                builder.add_edge(
                    node_id, target, ROUTES_TO, f"forwards to {backend_ip}",
                    evidence_field="config.backend_ips",
                    evidence_value=backend_ip,
                    provider=_canonical_provider(
                        account_map.get(str(resource.account_id), {}).get("provider")
                    ),
                    discovered_at=(
                        resource.updated_at.isoformat() if resource.updated_at else None
                    ),
                    note=(
                        "The backend set names an IP address; matched against "
                        "the address recorded on the instance itself."
                    ),
                )
            else:
                builder.record_unresolved(
                    resource, node_id, "config.backend_ips", backend_ip,
                    "load balancer backend IP not matched to an instance",
                    ROUTES_TO,
                )

        # OCI route tables: each rule names the gateway or other network entity
        # it sends traffic to. Gateways are not collected as resources yet, so
        # these usually land in the "type not collected" bucket — which is the
        # honest report, and a route table pointing at an internet gateway is
        # the single most load-bearing fact about whether a subnet is
        # internet-facing, so it is worth reporting rather than dropping.
        route_rules = config.get("route_rules")
        if isinstance(route_rules, list):
            for rule_entry in route_rules:
                if not isinstance(rule_entry, dict):
                    continue
                entity = rule_entry.get("network_entity_id")
                if not isinstance(entity, str) or not entity:
                    continue
                destination = rule_entry.get("destination") or "traffic"
                builder.link(
                    resource, node_id, entity, ROUTES_TO,
                    f"routes {destination} to",
                    evidence_field="config.route_rules[].network_entity_id",
                    gap="OCI gateway",
                )

        # Streams / queues that invoke this function (DynamoDB Streams, SQS,
        # Kinesis). The trigger ARN points at the source, so the edge runs
        # source -> function, matching the direction the events travel.
        for source_arn in as_list(config.get("event_source_arns")):
            trimmed = strip_stream_suffix(source_arn)
            source_node = index.resolve(trimmed)
            if source_node:
                builder.add_edge(
                    source_node, node_id, DATAFLOW, "triggers",
                    evidence_field="config.event_source_arns",
                    evidence_value=source_arn,
                    provider=_canonical_provider(
                        account_map.get(str(resource.account_id), {}).get("provider")
                    ),
                    discovered_at=(
                        resource.updated_at.isoformat() if resource.updated_at else None
                    ),
                    note=(
                        "A DynamoDB Streams ARN names the stream, not the "
                        "table; trimmed at /stream/ to reach the table."
                        if trimmed != source_arn else None
                    ),
                )
            else:
                builder.record_unresolved(
                    resource, node_id, "config.event_source_arns", source_arn,
                    "lambda event source not discovered", DATAFLOW,
                )

        # Lambda environment variables that name a real resource. Exact
        # matches only — substring guessing fabricated relationships and was
        # removed. A variable whose value is not an identifier we hold simply
        # produces nothing, and is not reported: environment variables are
        # mostly not resource references, so counting the misses would swamp
        # the unresolved list with feature flags and log levels.
        if rtype == "LambdaFunction":
            for var_key, var_value in (config.get("environment_variables") or {}).items():
                if isinstance(var_value, str) and var_value:
                    builder.link(
                        resource, node_id, var_value, DATAFLOW, f"uses ({var_key})",
                        evidence_field=f"config.environment_variables.{var_key}",
                        gap=None,
                        note=(
                            "The function's environment holds this resource's "
                            "exact provider identifier. Matched on the "
                            "identifier only - a variable whose value merely "
                            "equals some resource's name is not a reference."
                        ),
                    )

        # Azure SQL: the scanner stores the parent server NAME in metadata, not
        # an ARM ID, so this is the one lookup that starts from a name — scoped
        # to SQLServer so a database called the same thing as a storage account
        # cannot match, and still refused if two servers share the name.
        if rtype == "SQLDatabase" and meta.get("server"):
            builder.link(
                resource, node_id, meta["server"], CONTAINS, "hosted on",
                evidence_field="metadata.server",
                gap="azure parent resource not discovered",
                expect_type="SQLServer",
                reverse=True,
                allow_name=True,
                note=(
                    "The scanner records the parent server by name; matched "
                    "within SQLServer resources only, and refused if the name "
                    "is not unique."
                ),
            )

    # ── 4. permissions granted through an IAM role ────────────────────────────
    # An IAM role is where "this Lambda writes to that table" is actually
    # recorded, so the edge is drawn from the thing that runs code to the thing
    # it is allowed to reach — that is the question people ask of the graph.
    # The role edge added above still shows which role carries the grant.
    #
    # Only concrete resource ARNs become edges. Wildcard grants
    # (`Resource: "*"`, very common) are surfaced as the role's `broad_access`
    # summary instead: expanding them would connect every consumer to every
    # table and mean nothing.
    role_grants: Dict[str, List[dict]] = {}
    role_broad: Dict[str, List[str]] = {}
    role_resource: Dict[str, Any] = {}
    for resource in resources:
        if resource.resource_type != "IAMRole":
            continue
        config = resource.config or {}
        node_id = str(resource.id)
        role_resource[node_id] = resource
        grants = config.get("accessible_resources") or []
        if grants:
            role_grants[node_id] = [g for g in grants if isinstance(g, dict)]
        broad = config.get("broad_access") or []
        if broad:
            role_broad[node_id] = list(broad)

    broad_by_node: Dict[str, List[str]] = dict(role_broad)
    roles_with_consumer: Set[str] = set()

    if role_grants or role_broad:
        for resource in resources:
            config = resource.config or {}
            role_ident = config.get("role_arn") or config.get("role")
            role_node = index.resolve(role_ident) if role_ident else None
            if not role_node:
                continue
            node_id = str(resource.id)
            if role_node in role_broad:
                # Carried onto the consumer so the UI can say "can reach every
                # DynamoDB table" instead of showing a bare unconnected node.
                broad_by_node.setdefault(node_id, role_broad[role_node])
            if role_node not in role_grants:
                continue
            roles_with_consumer.add(role_node)
            for grant in role_grants[role_node]:
                builder.link(
                    resource, node_id, grant.get("resource"), PERMISSION,
                    f"can {grant.get('access', 'access')}",
                    evidence_field=(
                        "IAM role config.accessible_resources[].resource "
                        f"(via {'config.role_arn' if config.get('role_arn') else 'config.role'})"
                    ),
                    gap="permission target not discovered",
                    note=(
                        "A capability granted by the role's policy. It does "
                        "NOT mean any access has occurred."
                    ),
                )

        # A role nothing assumes still has meaningful grants — attach them to
        # the role itself so they are not invisible.
        for role_node, grants in role_grants.items():
            if role_node in roles_with_consumer:
                continue
            role_row = role_resource[role_node]
            for grant in grants:
                builder.link(
                    role_row, role_node, grant.get("resource"), PERMISSION,
                    f"grants {grant.get('access', 'access')}",
                    evidence_field="config.accessible_resources[].resource",
                    gap="permission target not discovered",
                    note=(
                        "No discovered resource assumes this role, so the "
                        "grant is shown on the role itself."
                    ),
                )

    # ── 5. grouping hubs ──────────────────────────────────────────────────────
    # Azure resource groups. Case-insensitive so "actin" and "ACTIN" merge.
    rg_hub_by_name: Dict[str, str] = {}
    for resource in resources:
        group = extract_resource_group(resource.provider_resource_id)
        if not group:
            continue
        account = account_map.get(str(resource.account_id), {})
        key = group.lower()
        hub_id = rg_hub_by_name.get(key)
        if hub_id is None:
            hub_id = f"rg::{key}"
            rg_hub_by_name[key] = hub_id
            graph.add_node(_synthetic_node(
                hub_id, group, "ResourceGroup", resource, account, provider_id=group,
            ))
        # Only top-level resources attach to the group; nested ones reach it
        # through their parent.
        if str(resource.id) not in builder.has_parent:
            builder.add_edge(
                hub_id, str(resource.id), CONTAINS, "contains",
                evidence_field="provider_resource_id (/resourceGroups/ segment)",
                evidence_value=group,
                provider=_canonical_provider(account.get("provider")),
                note=(
                    "The resource group is named inside every member's own "
                    "ARM resource ID."
                ),
            )

    # OCI compartments — a genuine containment the scanner records per resource.
    comp_hub_by_id: Dict[str, str] = {}
    for resource in resources:
        meta = resource.metadata_ or {}
        compartment_id = meta.get("compartment_id")
        if not compartment_id:
            continue
        account = account_map.get(str(resource.account_id), {})
        hub_id = comp_hub_by_id.get(compartment_id)
        if hub_id is None:
            hub_id = f"compartment::{compartment_id}"
            comp_hub_by_id[compartment_id] = hub_id
            name = meta.get("compartment_name") or (
                "root" if compartment_id.startswith("ocid1.tenancy")
                else compartment_id[:24] + "…"
            )
            graph.add_node(_synthetic_node(
                hub_id, name, "Compartment", resource, account,
                provider_id=compartment_id,
            ))
        if str(resource.id) not in builder.has_parent:
            builder.add_edge(
                hub_id, str(resource.id), CONTAINS, "contains",
                evidence_field="metadata.compartment_id",
                evidence_value=compartment_id,
                provider=_canonical_provider(account.get("provider")),
                note="Every OCI resource reports the compartment that holds it.",
            )

    # ── 6. wildcard-permission summaries onto their nodes ─────────────────────
    if broad_by_node:
        for node in graph.nodes:
            broad = broad_by_node.get(node["id"])
            if broad:
                node["broad_access"] = broad

    # ── 7. degree, for the tooltip and the isolation report ───────────────────
    for node in graph.nodes:
        node["connection_count"] = graph.degree(node["id"])

    result = builder.finish()
    unresolved_total = sum(int(r["count"]) for r in result.unresolved)
    if unresolved_total:
        logger.info(
            "Topology for %s: %d node(s), %d edge(s), %d unresolved reference(s)",
            scope, result.node_count, result.edge_count, unresolved_total,
        )
    return result
