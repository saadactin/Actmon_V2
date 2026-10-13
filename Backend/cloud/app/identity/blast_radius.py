"""Blast radius: what a principal could reach if it were compromised.

§17 is explicit — "Do not invent impact. Use actual inventory + permissions +
relationships" — so every number this module produces is traceable to three
inputs this platform already holds:

1.  the principal's evaluated permissions (`identity/engine.summarize`),
2.  the resource inventory (`cloud_resources`),
3.  the topology graph (`app/topology`), for indirect reach.

**The most important output is `inventory_complete`.** A blast radius of 4 can
mean "this identity is tightly scoped" or "the inventory sweep failed and we
only have 4 resources". Those are opposite conclusions from identical numbers,
so the coverage is returned beside every count and the UI withholds the score
rather than printing a reassuring small number over a failed scan. This is the
same discipline the Security Center applies to its own score and the partial-
scan prune already applies to inventory.

**Direct and indirect reach are counted separately.** Direct is "a permission
matches this resource". Indirect is "a resource the principal controls can
reach another through a topology edge" — a role that can modify a Lambda
reaches whatever that Lambda's own role can touch. Merging the two would make
a narrow permission look enormous and a broad one look the same, which is the
distinction the whole feature exists to draw.

**A path is evidence, not decoration.** Each reachable resource carries the
permission and the edge that put it in the set, so §18's "show why each node is
reachable" is answerable from stored data rather than recomputed on click.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from app.identity.capability import covers, probe_operations
from app.identity.model import (
    CAP_BACKUP_DELETE, CAP_CREDENTIAL_CREATION, CAP_DATABASE_ADMINISTRATION,
    CAP_IAM_ADMINISTRATION, CAP_IDENTITY_ADMINISTRATION, CAP_KEY_MANAGEMENT,
    CAP_LOGGING_CONFIGURATION, CAP_NETWORK_ADMINISTRATION, CAP_RESOURCE_DELETE,
    CAP_STORAGE_DELETE, normalize_provider,
)

# Resource types whose compromise is materially worse than average, because
# they hold data or control other resources. Used only to COUNT sensitive
# resources separately — never to inflate a total.
SENSITIVE_TYPES = {
    "ObjectStorageBucket", "S3Bucket", "StorageAccount", "Bucket",
    "AutonomousDatabase", "DbSystem", "MySQLDbSystem", "NoSQLTable",
    "RDSInstance", "DynamoDBTable", "SQLDatabase", "CosmosDB",
    "KeyVault", "Vault", "KMSKey", "SecretsManagerSecret",
    "IAMRole", "IAMUser", "IAMPolicy", "IAMGroup",
}

# How the six §17 capability flags are decided.
CAPABILITY_FLAGS: Dict[str, Tuple[str, ...]] = {
    "can_modify_iam": (CAP_IAM_ADMINISTRATION, CAP_IDENTITY_ADMINISTRATION),
    "can_modify_network": (CAP_NETWORK_ADMINISTRATION,),
    "can_delete_data": (CAP_STORAGE_DELETE, CAP_DATABASE_ADMINISTRATION,
                        CAP_BACKUP_DELETE, CAP_RESOURCE_DELETE),
    "can_create_credentials": (CAP_CREDENTIAL_CREATION,),
    "can_modify_logging": (CAP_LOGGING_CONFIGURATION,),
    "can_manage_keys": (CAP_KEY_MANAGEMENT,),
}

BAND_CRITICAL, BAND_HIGH, BAND_MEDIUM, BAND_LOW = "CRITICAL", "HIGH", "MEDIUM", "LOW"


@dataclass
class ResourceRef:
    """The minimum this module needs to know about a resource."""

    key: str                       # provider id: ARN / ARM id / OCID
    name: Optional[str] = None
    resource_type: Optional[str] = None
    region: Optional[str] = None
    service: Optional[str] = None
    account_id: Optional[str] = None

    @property
    def sensitive(self) -> bool:
        return (self.resource_type or "") in SENSITIVE_TYPES


@dataclass
class Reach:
    """One resource the principal can reach, and why."""

    resource: ResourceRef
    via: str                       # "direct" | "topology"
    permission: Optional[str] = None
    capability: Optional[str] = None
    edge_kind: Optional[str] = None
    through: Optional[str] = None  # the resource key it was reached through
    hops: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resource_key": self.resource.key,
            "resource_name": self.resource.name,
            "resource_type": self.resource.resource_type,
            "region": self.resource.region,
            "sensitive": self.resource.sensitive,
            "via": self.via,
            "permission": self.permission,
            "capability": self.capability,
            "edge_kind": self.edge_kind,
            "through": self.through,
            "hops": self.hops,
        }


def resource_matches(
    provider: str, resource_patterns: Sequence[str], resource: ResourceRef,
) -> Optional[str]:
    """The first pattern that matches this resource, or None.

    Grant-as-pattern again, and a `*` pattern matches everything — which is the
    correct reading of `"Resource": "*"` and the reason an admin role's blast
    radius is the whole inventory.
    """
    prov = normalize_provider(provider) or provider
    for pattern in resource_patterns:
        if not pattern:
            continue
        if pattern == "*":
            return pattern
        if covers(prov, pattern, resource.key):
            return pattern
    return None


def compute(
    provider: str,
    *,
    permissions: Sequence[Dict[str, Any]],
    resources: Sequence[ResourceRef],
    capabilities: Sequence[str],
    topology_edges: Optional[Sequence[Dict[str, Any]]] = None,
    inventory_complete: bool = False,
    inventory_note: Optional[str] = None,
    assumable_privileged_roles: int = 0,
    reachable_accounts: Optional[Iterable[str]] = None,
    max_hops: int = 2,
    sample_size: int = 50,
) -> Dict[str, Any]:
    """Compute the blast radius for one principal.

    `permissions` are the evaluated permissive grants — each a dict with at
    least `action_pattern`, `resource_pattern` and `capability`. Non-permissive
    decisions must be filtered out by the caller; including a denied grant here
    would count reach the principal does not have.
    """
    prov = normalize_provider(provider) or provider
    by_key = {r.key: r for r in resources}
    reached: Dict[str, Reach] = {}

    # ── Direct reach ─────────────────────────────────────────────────────────
    patterns_by_capability: Dict[str, List[str]] = {}
    for perm in permissions:
        capability = perm.get("capability")
        resource_pattern = perm.get("resource_pattern") or "*"
        patterns_by_capability.setdefault(capability or "OTHER", []).append(resource_pattern)

    for resource in resources:
        for perm in permissions:
            pattern = perm.get("resource_pattern") or "*"
            matched = resource_matches(prov, [pattern], resource)
            if matched is None:
                continue
            existing = reached.get(resource.key)
            if existing is None:
                reached[resource.key] = Reach(
                    resource=resource, via="direct",
                    permission=perm.get("action_pattern"),
                    capability=perm.get("capability"), hops=0,
                )
            break

    direct_keys = set(reached)

    # ── Indirect reach, through the topology ─────────────────────────────────
    # Only from resources the principal can MODIFY: being able to read a VM
    # does not let you pivot through it. The caller supplies edges; an empty
    # edge list means the topology was unavailable, which is reported rather
    # than silently producing 0.
    edges = list(topology_edges or [])
    adjacency: Dict[str, List[Dict[str, Any]]] = {}
    for edge in edges:
        src = edge.get("source") or edge.get("from")
        dst = edge.get("target") or edge.get("to")
        if not src or not dst:
            continue
        adjacency.setdefault(str(src), []).append(
            {"to": str(dst), "kind": edge.get("kind") or edge.get("relationship")})

    write_capabilities = set(CAPABILITY_FLAGS["can_modify_iam"]) | {
        CAP_NETWORK_ADMINISTRATION, CAP_RESOURCE_DELETE, CAP_DATABASE_ADMINISTRATION,
        CAP_STORAGE_DELETE, CAP_KEY_MANAGEMENT,
    }
    frontier = [
        key for key in direct_keys
        if (reached[key].capability or "") in write_capabilities
    ]
    hop = 0
    while frontier and hop < max_hops:
        hop += 1
        next_frontier: List[str] = []
        for key in frontier:
            for link in adjacency.get(key, []):
                target_key = link["to"]
                if target_key in reached:
                    continue
                target = by_key.get(target_key)
                if target is None:
                    continue
                reached[target_key] = Reach(
                    resource=target, via="topology", edge_kind=link.get("kind"),
                    through=key, hops=hop,
                    capability=reached[key].capability,
                )
                next_frontier.append(target_key)
        frontier = next_frontier

    indirect_keys = set(reached) - direct_keys

    # ── Aggregates ───────────────────────────────────────────────────────────
    held = set(capabilities or [])
    flags = {
        flag: bool(held & set(caps)) for flag, caps in CAPABILITY_FLAGS.items()
    }

    regions = {r.resource.region for r in reached.values() if r.resource.region}
    accounts = set(str(a) for a in (reachable_accounts or []) if a)
    accounts |= {r.resource.account_id for r in reached.values() if r.resource.account_id}
    sensitive = [r for r in reached.values() if r.resource.sensitive]

    by_service: Dict[str, int] = {}
    by_type: Dict[str, int] = {}
    for reach in reached.values():
        service = reach.resource.service or _service_of(reach.resource.resource_type)
        if service:
            by_service[service] = by_service.get(service, 0) + 1
        rtype = reach.resource.resource_type or "Unknown"
        by_type[rtype] = by_type.get(rtype, 0) + 1

    score, band, note = _score(
        direct=len(direct_keys), indirect=len(indirect_keys),
        total_inventory=len(resources), sensitive=len(sensitive),
        flags=flags, assumable=assumable_privileged_roles,
        inventory_complete=inventory_complete,
    )

    # Sample ordered so the most informative rows come first: sensitive, then
    # direct, then everything else. §34 forbids shipping the whole estate.
    ordered = sorted(
        reached.values(),
        key=lambda r: (not r.resource.sensitive, r.via != "direct", r.resource.name or ""),
    )

    return {
        "direct_resources": len(direct_keys),
        "indirect_resources": len(indirect_keys),
        "accounts_reachable": len(accounts),
        "regions_reachable": len(regions),
        "sensitive_resources": len(sensitive),
        "privileged_roles_assumable": assumable_privileged_roles,
        "capabilities": flags,
        "score": score,
        "score_band": band,
        "resources_evaluated": len(resources),
        "inventory_complete": inventory_complete,
        "coverage_note": inventory_note or note,
        "by_service": by_service,
        "by_resource_type": by_type,
        "sample_resources": [r.to_dict() for r in ordered[:sample_size]],
        "topology_available": bool(edges),
        "topology_note": (
            None if edges else
            "No topology edges were available, so indirect reach could not be "
            "calculated. The indirect count is not zero — it is unknown."
        ),
        "paths": [r.to_dict() for r in ordered if r.via == "topology"][:sample_size],
    }


def _score(
    *, direct: int, indirect: int, total_inventory: int, sensitive: int,
    flags: Dict[str, bool], assumable: int, inventory_complete: bool,
) -> Tuple[Optional[float], Optional[str], Optional[str]]:
    """0-100, or withheld.

    Withheld — not zero, not a guess — when the inventory is incomplete. A
    score computed over a failed sweep is worse than no score, because it looks
    like reassurance.
    """
    if not inventory_complete:
        return None, None, (
            "The resource inventory for this account is incomplete, so a blast-radius "
            "score would be computed over an unknown fraction of the estate. The "
            "counts below are what was reachable among the resources we hold, and are "
            "a floor rather than a total."
        )
    if total_inventory <= 0:
        return None, None, (
            "No resources are held for this account, so there is nothing to compute a "
            "blast radius against."
        )

    coverage = (direct + indirect) / total_inventory
    score = 55.0 * min(1.0, coverage)
    score += 15.0 * min(1.0, sensitive / max(1, total_inventory * 0.1))
    weighted = sum((
        12.0 if flags.get("can_modify_iam") else 0.0,
        6.0 if flags.get("can_create_credentials") else 0.0,
        5.0 if flags.get("can_modify_logging") else 0.0,
        4.0 if flags.get("can_manage_keys") else 0.0,
        3.0 if flags.get("can_delete_data") else 0.0,
        2.0 if flags.get("can_modify_network") else 0.0,
    ))
    score += min(25.0, weighted)
    score += min(5.0, assumable * 1.5)
    score = round(min(100.0, score), 1)

    if score >= 75:
        band = BAND_CRITICAL
    elif score >= 50:
        band = BAND_HIGH
    elif score >= 25:
        band = BAND_MEDIUM
    else:
        band = BAND_LOW
    return score, band, None


def _service_of(resource_type: Optional[str]) -> Optional[str]:
    if not resource_type:
        return None
    mapping = {
        "ObjectStorageBucket": "Object Storage", "S3Bucket": "S3",
        "StorageAccount": "Storage", "ComputeInstance": "Compute",
        "EC2Instance": "EC2", "VirtualMachine": "Compute",
        "AutonomousDatabase": "Database", "DbSystem": "Database",
        "RDSInstance": "RDS", "SQLDatabase": "SQL",
        "IAMRole": "IAM", "IAMUser": "IAM", "IAMPolicy": "IAM", "IAMGroup": "IAM",
        "KeyVault": "Key Vault", "Vault": "Vault",
    }
    return mapping.get(resource_type, resource_type)


def explain(reach: Dict[str, Any]) -> List[Dict[str, str]]:
    """Sentences for §17's summary panel, each tied to a stored number.

    Accepts either shape of the capability block: `compute()` returns the
    `can_*` keys the model column names use, while the stored row's `to_dict()`
    drops the prefix. Reading only one of them silently produced an explanation
    with every capability claim missing — the panel rendered, and said nothing,
    which is worse than failing.
    """
    out: List[Dict[str, str]] = []
    raw = reach.get("capabilities") or {}
    caps = {
        **{k: v for k, v in raw.items()},
        **{f"can_{k}": v for k, v in raw.items() if not k.startswith("can_")},
    }
    if caps.get("can_modify_iam"):
        out.append({"claim": "Can modify identity and access configuration",
                    "why": "Holds IAM or directory administration, so it can grant "
                           "itself or others any further permission."})
    if caps.get("can_create_credentials"):
        out.append({"claim": "Can mint new credentials",
                    "why": "A credential created now survives this identity being "
                           "disabled later."})
    if caps.get("can_modify_logging"):
        out.append({"claim": "Can disable the audit trail",
                    "why": "Everything after that point becomes unobservable."})
    if caps.get("can_delete_data"):
        out.append({"claim": "Can delete stored data",
                    "why": f"{reach.get('sensitive_resources', 0)} data-bearing "
                           "resources are within its reach."})
    if reach.get("indirect_resources"):
        out.append({"claim": f"Reaches {reach['indirect_resources']} further resources "
                             "indirectly",
                    "why": "Through resources it can modify, following the collected "
                           "topology."})
    if not reach.get("inventory_complete"):
        out.append({"claim": "These counts are a floor, not a total",
                    "why": reach.get("coverage_note") or
                           "The inventory sweep for this account was incomplete."})
    return out
