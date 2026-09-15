"""Normalized topology vocabulary — relationships, node categories, health.

Everything the graph asserts about a resource or a relationship is defined here
once, so the builder, the API and the UI legend cannot disagree about what an
edge means. The previous version defined edge kinds in two places (a dict in the
service and a parallel dict in the React page) and the two had already drifted:
the page carried a style for `unknown` that the service never emitted.

## Wire values are deliberately unchanged

The specification lists relationship types in UPPER_SNAKE (`ROUTES_TO`,
`MANAGED_BY`). The existing API emits lowercase hyphenated values
(`routes-to`, `managed-by`) and the existing UI keys its styling off them. So
each relationship carries BOTH: `type` stays the established wire value, and
`semantic` is the normalized name. Renaming the wire value would have been a
breaking change to a working feature for no gain, and the spec's own
instruction is that existing semantics be retained.

## Permission is not access

`permission` means CAN reach, never DOES reach. It is the one edge kind flagged
`observed = False`, and the flag is on the relationship definition rather than
left to a naming convention, so anything that consumes the registry — the
legend, the tooltip, the data-flow view filter — gets the distinction for free
instead of each re-deciding it.
"""
from __future__ import annotations

from typing import Dict, FrozenSet, List, Optional

# ── Relationship registry ────────────────────────────────────────────────────
# direction: "directed"  — A→B and B→A mean different things; keep both.
#            "symmetric" — the same fact reported from either end; keep one.
#
# Symmetric kinds are deduplicated as unordered pairs by the builder. This is
# not cosmetic: a NIC lists its public IP while the public IP lists its NIC, so
# without it every structural pair rendered twice (18 NIC→PublicIP plus 18
# PublicIP→NIC on this deployment's Azure account).

CONTAINS = "contains"
NETWORK = "network"
SECURITY = "security"
ROLE = "role"
ATTACHED = "attached"
DATAFLOW = "dataflow"
ROUTES_TO = "routes-to"
PERMISSION = "permission"
MANAGED_BY = "managed-by"
ENCRYPTED_BY = "encrypted-by"
PROTECTS = "protects"
PEERS_WITH = "peers-with"


class Relationship:
    """One relationship kind. Immutable by convention — it is a vocabulary."""

    __slots__ = (
        "type", "semantic", "label", "direction", "meaning", "observed",
        "group",
    )

    def __init__(
        self,
        type: str,
        semantic: str,
        label: str,
        direction: str,
        meaning: str,
        *,
        observed: bool = True,
        group: str = "infrastructure",
    ) -> None:
        self.type = type
        self.semantic = semantic
        self.label = label
        self.direction = direction
        self.meaning = meaning
        # False for a capability that has not been observed happening. Only
        # `permission` is False today; the flag exists so nothing has to infer
        # it from the kind's name.
        self.observed = observed
        # Which view mode highlights this kind (see the `view` query parameter).
        self.group = group

    @property
    def symmetric(self) -> bool:
        return self.direction == "symmetric"

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "semantic": self.semantic,
            "label": self.label,
            "direction": self.direction,
            "meaning": self.meaning,
            "observed": self.observed,
            "group": self.group,
        }


RELATIONSHIPS: Dict[str, Relationship] = {
    r.type: r
    for r in (
        Relationship(
            CONTAINS, "CONTAINS", "Contains", "symmetric",
            "The parent owns the child: ARM resource nesting, an Azure resource "
            "group, an OCI compartment, an availability set.",
            group="infrastructure",
        ),
        Relationship(
            NETWORK, "NETWORK", "Network / subnet", "symmetric",
            "The resource sits inside this network or subnet, or is bound to "
            "this interface or address. Placement, not reachability.",
            group="network",
        ),
        Relationship(
            SECURITY, "SECURITY", "Security group", "directed",
            "Traffic to and from the resource is filtered by this security "
            "group, NSG or Security List.",
            group="security",
        ),
        Relationship(
            ROLE, "ROLE", "Assumes role", "directed",
            "The resource runs as this identity. What the identity may reach is "
            "a separate `permission` relationship.",
            group="identity",
        ),
        Relationship(
            ATTACHED, "ATTACHED", "Storage attached", "symmetric",
            "Block storage attached to a compute instance.",
            group="infrastructure",
        ),
        Relationship(
            DATAFLOW, "DATAFLOW", "Data flow / trigger", "directed",
            "The source hands data to, or invokes, the target — an event source "
            "mapping, or a function configured with the target's identifier.",
            group="dataflow",
        ),
        Relationship(
            ROUTES_TO, "ROUTES_TO", "Routes to", "directed",
            "The source forwards traffic to the target: a load balancer to its "
            "backend, a route table to a gateway.",
            group="network",
        ),
        Relationship(
            PERMISSION, "PERMISSION", "Can access (IAM)", "directed",
            "The source is ALLOWED to reach the target. This is a capability "
            "granted by policy, not an observation that any access occurred.",
            observed=False,
            group="identity",
        ),
        Relationship(
            MANAGED_BY, "MANAGED_BY", "Managed by", "symmetric",
            "Another resource owns this one's lifecycle — a disk owned by its "
            "VM, anything created by a scale set.",
            group="infrastructure",
        ),
        Relationship(
            ENCRYPTED_BY, "ENCRYPTED_BY", "Encrypted by", "directed",
            "The resource's data is encrypted with this customer-managed key.",
            group="security",
        ),
        Relationship(
            PROTECTS, "PROTECTS", "Protects", "directed",
            "A firewall or WAF in front of the target, inspecting its traffic.",
            group="security",
        ),
        Relationship(
            PEERS_WITH, "PEERS_WITH", "Peers with", "symmetric",
            "Two networks joined as peers — traffic can cross in both "
            "directions by the peering itself.",
            group="network",
        ),
    )
}

# Kinds whose edges are deduplicated as unordered pairs.
SYMMETRIC_KINDS: FrozenSet[str] = frozenset(
    r.type for r in RELATIONSHIPS.values() if r.symmetric
)

# The view modes of section 25, expressed as the relationship kinds each one
# highlights. "infrastructure" shows everything; the others narrow.
VIEW_MODES: Dict[str, Dict[str, object]] = {
    "infrastructure": {
        "label": "Infrastructure",
        "description": "Every discovered relationship.",
        "kinds": sorted(RELATIONSHIPS),
    },
    "network": {
        "label": "Network",
        "description": "Placement and traffic paths — networks, subnets, "
                       "interfaces, addresses, load balancers, gateways.",
        "kinds": sorted(
            r.type for r in RELATIONSHIPS.values() if r.group == "network"
        ),
    },
    "security": {
        "label": "Security",
        "description": "Filtering, inspection and encryption controls.",
        "kinds": sorted(
            r.type for r in RELATIONSHIPS.values() if r.group == "security"
        ),
    },
    "dataflow": {
        "label": "Data flow",
        "description": "Confirmed data movement and invocation only. A "
                       "permission is a capability, not a flow, so it is not "
                       "included here.",
        "kinds": sorted(
            r.type for r in RELATIONSHIPS.values() if r.group == "dataflow"
        ),
    },
    "identity": {
        "label": "Identity",
        "description": "Which identity a resource runs as, and what that "
                       "identity is permitted to reach.",
        "kinds": sorted(
            r.type for r in RELATIONSHIPS.values() if r.group == "identity"
        ),
    },
}


def kinds_for_view(view: Optional[str]) -> Optional[FrozenSet[str]]:
    """The relationship kinds a view mode keeps, or None for all of them."""
    if not view or view == "infrastructure":
        return None
    mode = VIEW_MODES.get(view)
    if not mode:
        return None
    return frozenset(mode["kinds"])  # type: ignore[arg-type]


# ── Node categories ──────────────────────────────────────────────────────────
# One category per resource type, used for the layout columns, the filter
# dropdown and the legend. A type absent from this table gets "Other" rather
# than a guess: mapping by keyword ("anything containing 'sql' is a database")
# is the same class of mistake as name-matching edges.

CATEGORY_NETWORK = "Network"
CATEGORY_COMPUTE = "Compute"
CATEGORY_STORAGE = "Storage"
CATEGORY_DATABASE = "Database"
CATEGORY_IDENTITY = "Identity"
CATEGORY_SECURITY = "Security"
CATEGORY_CONTAINER = "Container"
CATEGORY_APPLICATION = "Application"
CATEGORY_INTEGRATION = "Integration"
CATEGORY_MONITORING = "Monitoring"
CATEGORY_ANALYTICS = "Analytics"
CATEGORY_AI = "AI / ML"
CATEGORY_ORGANIZATION = "Organization"
CATEGORY_OTHER = "Other"

NODE_CATEGORY: Dict[str, str] = {
    # ── AWS ──
    "VPC": CATEGORY_NETWORK,
    "Subnet": CATEGORY_NETWORK,
    "SecurityGroup": CATEGORY_SECURITY,
    "LoadBalancer": CATEGORY_NETWORK,
    "NetworkLoadBalancer": CATEGORY_NETWORK,
    "APIGateway": CATEGORY_INTEGRATION,
    "EC2Instance": CATEGORY_COMPUTE,
    "LambdaFunction": CATEGORY_COMPUTE,
    "EKSCluster": CATEGORY_CONTAINER,
    "EBSVolume": CATEGORY_STORAGE,
    "S3Bucket": CATEGORY_STORAGE,
    "DynamoDBTable": CATEGORY_DATABASE,
    "RDSInstance": CATEGORY_DATABASE,
    "AuroraCluster": CATEGORY_DATABASE,
    "DocumentDBCluster": CATEGORY_DATABASE,
    "NeptuneCluster": CATEGORY_DATABASE,
    "RedshiftCluster": CATEGORY_ANALYTICS,
    "ElastiCacheRedis": CATEGORY_DATABASE,
    "ElastiCacheMemcached": CATEGORY_DATABASE,
    "IAMRole": CATEGORY_IDENTITY,
    "BedrockModel": CATEGORY_AI,
    "BedrockAgent": CATEGORY_AI,
    "BedrockKnowledgeBase": CATEGORY_AI,
    # ── Azure ──
    "VirtualNetwork": CATEGORY_NETWORK,
    "NetworkInterface": CATEGORY_NETWORK,
    "PublicIP": CATEGORY_NETWORK,
    "NetworkSecurityGroup": CATEGORY_SECURITY,
    "ApplicationGateway": CATEGORY_NETWORK,
    "PrivateEndpoint": CATEGORY_NETWORK,
    "RouteTable": CATEGORY_NETWORK,
    "VirtualMachine": CATEGORY_COMPUTE,
    "VMScaleSet": CATEGORY_COMPUTE,
    "AppService": CATEGORY_APPLICATION,
    "FunctionApp": CATEGORY_COMPUTE,
    "AppServicePlan": CATEGORY_COMPUTE,
    "LogicApp": CATEGORY_INTEGRATION,
    "AKSCluster": CATEGORY_CONTAINER,
    "ContainerRegistry": CATEGORY_CONTAINER,
    "ManagedDisk": CATEGORY_STORAGE,
    "StorageAccount": CATEGORY_STORAGE,
    "SQLServer": CATEGORY_DATABASE,
    "SQLDatabase": CATEGORY_DATABASE,
    "MySQLServer": CATEGORY_DATABASE,
    "PostgreSQLServer": CATEGORY_DATABASE,
    "CosmosDB": CATEGORY_DATABASE,
    "RedisCache": CATEGORY_DATABASE,
    "KeyVault": CATEGORY_SECURITY,
    "ManagedIdentity": CATEGORY_IDENTITY,
    "EventHub": CATEGORY_INTEGRATION,
    "ServiceBus": CATEGORY_INTEGRATION,
    "APIManagement": CATEGORY_INTEGRATION,
    "LogAnalytics": CATEGORY_MONITORING,
    "AppInsights": CATEGORY_MONITORING,
    "RecoveryVault": CATEGORY_STORAGE,
    "AvailabilitySet": CATEGORY_COMPUTE,
    "ResourceGroup": CATEGORY_ORGANIZATION,
    # ── OCI ──
    "VCN": CATEGORY_NETWORK,
    "SecurityList": CATEGORY_SECURITY,
    "DhcpOptions": CATEGORY_NETWORK,
    "VirtualCircuit": CATEGORY_NETWORK,
    "DrgAttachment": CATEGORY_NETWORK,
    "WebAppFirewall": CATEGORY_SECURITY,
    "ComputeInstance": CATEGORY_COMPUTE,
    "Function": CATEGORY_COMPUTE,
    "OKECluster": CATEGORY_CONTAINER,
    "BlockVolume": CATEGORY_STORAGE,
    "BootVolume": CATEGORY_STORAGE,
    "FileSystem": CATEGORY_STORAGE,
    "ObjectStorageBucket": CATEGORY_STORAGE,
    "AutonomousDatabase": CATEGORY_DATABASE,
    "DbSystem": CATEGORY_DATABASE,
    "MySQLDbSystem": CATEGORY_DATABASE,
    "NoSQLTable": CATEGORY_DATABASE,
    "AnalyticsInstance": CATEGORY_ANALYTICS,
    "IAMGroup": CATEGORY_IDENTITY,
    "IAMPolicy": CATEGORY_IDENTITY,
    "Compartment": CATEGORY_ORGANIZATION,
}


def category_of(resource_type: Optional[str]) -> str:
    return NODE_CATEGORY.get(resource_type or "", CATEGORY_OTHER)


# Synthetic grouping nodes. These are organizational containers we create, not
# resources a provider returned, and section 44 requires they stay
# distinguishable from real infrastructure.
SYNTHETIC_TYPES: FrozenSet[str] = frozenset({"ResourceGroup", "Compartment"})


# ── Health ───────────────────────────────────────────────────────────────────
# Provider status strings mapped onto one vocabulary. A resource whose status
# the provider did not report is Unknown — never Healthy. "It exists, so it must
# be fine" is exactly the false confidence section 47 forbids.

HEALTH_HEALTHY = "Healthy"
HEALTH_WARNING = "Warning"
HEALTH_DEGRADED = "Degraded"
HEALTH_FAILED = "Failed"
HEALTH_STOPPED = "Stopped"
HEALTH_UNKNOWN = "Unknown"

_HEALTH_BY_STATUS: Dict[str, str] = {
    # running / available / succeeded
    "running": HEALTH_HEALTHY,
    "available": HEALTH_HEALTHY,
    "active": HEALTH_HEALTHY,
    "succeeded": HEALTH_HEALTHY,
    "ok": HEALTH_HEALTHY,
    "healthy": HEALTH_HEALTHY,
    "ready": HEALTH_HEALTHY,
    "online": HEALTH_HEALTHY,
    "attached": HEALTH_HEALTHY,
    "inservice": HEALTH_HEALTHY,
    "enabled": HEALTH_HEALTHY,
    "vm running": HEALTH_HEALTHY,
    "powerstate/running": HEALTH_HEALTHY,
    # in flight — not yet a problem, not yet healthy
    "provisioning": HEALTH_WARNING,
    "creating": HEALTH_WARNING,
    "updating": HEALTH_WARNING,
    "pending": HEALTH_WARNING,
    "starting": HEALTH_WARNING,
    "stopping": HEALTH_WARNING,
    "terminating": HEALTH_WARNING,
    "deleting": HEALTH_WARNING,
    "modifying": HEALTH_WARNING,
    "rebooting": HEALTH_WARNING,
    "backing-up": HEALTH_WARNING,
    "restoring": HEALTH_WARNING,
    "scaling": HEALTH_WARNING,
    "moving": HEALTH_WARNING,
    "upgrading": HEALTH_WARNING,
    # degraded
    "degraded": HEALTH_DEGRADED,
    "impaired": HEALTH_DEGRADED,
    "warning": HEALTH_DEGRADED,
    "storage-full": HEALTH_DEGRADED,
    "insufficient-capacity": HEALTH_DEGRADED,
    "needs-attention": HEALTH_DEGRADED,
    "unavailable": HEALTH_DEGRADED,
    # failed
    "failed": HEALTH_FAILED,
    "error": HEALTH_FAILED,
    "terminated": HEALTH_FAILED,
    "deleted": HEALTH_FAILED,
    "canceled": HEALTH_FAILED,
    "cancelled": HEALTH_FAILED,
    "incompatible-parameters": HEALTH_FAILED,
    "inaccessible-encryption-credentials": HEALTH_FAILED,
    # stopped — deliberately its own state, not a failure
    "stopped": HEALTH_STOPPED,
    "deallocated": HEALTH_STOPPED,
    "shut_off": HEALTH_STOPPED,
    "shutoff": HEALTH_STOPPED,
    "suspended": HEALTH_STOPPED,
    "paused": HEALTH_STOPPED,
    "disabled": HEALTH_STOPPED,
    "inactive": HEALTH_STOPPED,
    "detached": HEALTH_STOPPED,
    "vm deallocated": HEALTH_STOPPED,
    "vm stopped": HEALTH_STOPPED,
}


def health_of(status: Optional[str]) -> str:
    """Map a provider status onto the health vocabulary.

    Unrecognised but present statuses return Unknown rather than Healthy: the
    point of this function is to avoid asserting a health we did not measure,
    and a status string we have never seen is not evidence of anything.
    """
    if not status:
        return HEALTH_UNKNOWN
    key = str(status).strip().lower()
    if key in _HEALTH_BY_STATUS:
        return _HEALTH_BY_STATUS[key]
    # Azure sends "PowerState/running" and OCI "AVAILABLE"; both are covered
    # above. Try the tail of a slash-separated compound before giving up.
    if "/" in key:
        tail = key.rsplit("/", 1)[-1]
        if tail in _HEALTH_BY_STATUS:
            return _HEALTH_BY_STATUS[tail]
    return HEALTH_UNKNOWN


# ── Reference targets the scanners do not collect ────────────────────────────
# When a provider names something we never discovered, there are two very
# different reasons, and section 34 requires they be told apart:
#
#   * the resource type IS collected, and this particular one is missing —
#     a permission gap, a region not swept, a race with a deletion;
#   * the resource type is NOT collected at all — no scanner asks for it.
#
# The second is a known limitation of this product, not a symptom, and lumping
# the two together makes a fixed roadmap item look like an incident. Every
# resource type listed here is one a rule below legitimately references and no
# scanner emits, verified against the three scanners' resource_type values.

UNCOLLECTED_TARGETS: Dict[str, str] = {
    "machine image": "Machine images are not collected as resources by design.",
    "OCI gateway": (
        "Internet, NAT, service and dynamic-routing gateways are not collected "
        "by the OCI scanner yet, so a route rule pointing at one cannot be "
        "resolved."
    ),
    "OCI DRG": "Dynamic routing gateways are not collected by the OCI scanner yet.",
    "KMS / Vault key": (
        "Encryption keys are not collected as resources yet, so a "
        "customer-managed-key reference cannot be resolved to a key."
    ),
    "WAF policy": (
        "Web application firewall policies are not collected as resources yet; "
        "the firewall itself is."
    ),
    "AWS DHCP option set": (
        "DHCP option sets are collected for OCI but not for AWS, so an AWS "
        "VPC's option-set reference cannot be resolved."
    ),
    "AWS target group": (
        "Load balancer target groups are not collected as resources; the "
        "balancer's resolved backend instances are recorded instead."
    ),
}


def reference_class(gap: str) -> str:
    """`unsupported_type` when nothing collects the target, else `missing_target`."""
    return "unsupported_type" if gap in UNCOLLECTED_TARGETS else "missing_target"


# ── Isolation reasons ────────────────────────────────────────────────────────
# Section 34: never just report a count of unconnected nodes. Each reason below
# is decided from evidence on the node itself, in the builder.

ISOLATION_REASONS: Dict[str, str] = {
    "wildcard_permission": (
        "Its identity's policy grants access with a wildcard, so the provider "
        "never records which specific resources are meant and no per-resource "
        "edge exists to draw."
    ),
    "references_unresolved": (
        "It names resources we did not discover, so its relationships are known "
        "but cannot be drawn. See unresolved references."
    ),
    "no_relationship_fields": (
        "Nothing the scanner collected for this resource type carries a "
        "relationship — no network, parent, attachment or identity field."
    ),
    "standalone_resource": (
        "The resource type does carry relationship fields, and the provider "
        "reported none set. It appears to be genuinely standalone."
    ),
    "empty_container": (
        "A grouping container — a resource group or compartment — that holds "
        "nothing we discovered."
    ),
}


def relationship_catalog() -> List[dict]:
    """The registry, for the UI legend and for verification."""
    return [RELATIONSHIPS[k].to_dict() for k in sorted(RELATIONSHIPS)]


# ── Which way impact travels ─────────────────────────────────────────────────
# For "what breaks if I delete this?" the edge's stored direction is not the
# answer, because the stored direction is whichever end the provider reported
# from. An EC2 instance names its subnet (edge instance -> subnet), so removing
# the SUBNET breaks the INSTANCE: impact travels against the edge. A VPC
# contains a subnet (edge vpc -> subnet), so removing the VPC breaks the
# subnet: impact travels along the edge.
#
#   "to_source"  removing the target affects the source
#   "to_target"  removing the source affects the target
#   "both"       either end's removal affects the other
#
# `both` is used where the two providers report the same concept from opposite
# ends and neither direction is wrong — an Azure VM names its disks while an
# OCI volume names its instance, so `attached` genuinely runs both ways in one
# graph. Treating those as one-directional would silently drop half the real
# dependents, which is the more damaging error for a blast-radius answer.
IMPACT_FLOW: Dict[str, str] = {
    CONTAINS: "to_target",
    NETWORK: "to_source",
    SECURITY: "to_source",
    ROLE: "to_source",
    ATTACHED: "both",
    DATAFLOW: "both",
    ROUTES_TO: "both",
    PERMISSION: "to_source",
    MANAGED_BY: "to_source",
    ENCRYPTED_BY: "to_source",
    PROTECTS: "to_target",
    PEERS_WITH: "both",
}

# How a dependent is classified in the impact breakdown (section 23).
DEPENDENCY_CLASS: Dict[str, str] = {
    CONTAINS: "structural",
    NETWORK: "network",
    SECURITY: "security",
    ROLE: "identity",
    ATTACHED: "storage",
    DATAFLOW: "data",
    ROUTES_TO: "network",
    PERMISSION: "permission",
    MANAGED_BY: "structural",
    ENCRYPTED_BY: "security",
    PROTECTS: "security",
    PEERS_WITH: "network",
}

DEPENDENCY_CLASSES = (
    "structural", "network", "security", "identity", "storage", "data",
    "permission",
)
