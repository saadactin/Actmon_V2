"""Normalization for multi-cloud resource inventory.

AWS, Azure and OCI describe the same concepts in three different vocabularies.
Until now every consumer re-derived its own reading of them — the resource
table had one `statusTone()` in React, the cost service had `_stopped_status`,
the security engine had a third. They disagreed, and the disagreements were
invisible.

This module is the single place those readings live. Everything here is a pure
function of a resource row, so it is testable without a database and cannot
drift from what the API returns.

THE RULE THAT SHAPES ALL OF IT
------------------------------
A missing value is never upgraded into a good one. `None` status becomes
UNKNOWN with a sentence explaining what the provider did or did not say — never
RUNNING, never AVAILABLE, never a green dot. This matters concretely here: of
75 Azure virtual machines in this estate, 57 report a provisioning state of
'Succeeded' and no power state at all. 'Succeeded' means ARM finished creating
the VM. It says nothing about whether the VM is running, and a UI that paints
those 57 green is asserting something Azure never told it.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ── Normalized statuses ──────────────────────────────────────────────────────
# Deliberately small. Every extra value is another thing three providers must
# agree on, and another branch the UI has to render.
RUNNING = "RUNNING"
STOPPED = "STOPPED"
AVAILABLE = "AVAILABLE"
PROVISIONING = "PROVISIONING"
DEGRADED = "DEGRADED"
FAILED = "FAILED"
DELETED = "DELETED"
ATTACHED = "ATTACHED"
UNATTACHED = "UNATTACHED"
UNKNOWN = "UNKNOWN"

NORMALIZED_STATUSES: Tuple[str, ...] = (
    RUNNING, STOPPED, AVAILABLE, PROVISIONING, DEGRADED,
    FAILED, DELETED, ATTACHED, UNATTACHED, UNKNOWN,
)

# Sort order for `sort=status` (spec §15: "Logical normalized order rather than
# alphabetical"). Alphabetical puts ATTACHED before RUNNING and FAILED before
# STOPPED, which is noise. This orders by how much a human should care:
# broken first, then running, then inert, then the ones we cannot speak for.
STATUS_SORT_ORDER: Dict[str, int] = {
    FAILED: 0,
    DEGRADED: 1,
    RUNNING: 2,
    PROVISIONING: 3,
    AVAILABLE: 4,
    ATTACHED: 5,
    STOPPED: 6,
    UNATTACHED: 7,
    DELETED: 8,
    UNKNOWN: 9,
}

# Raw provider vocabulary -> normalized. Lower-cased on lookup, so 'AVAILABLE',
# 'available' and 'Available' all land in one place. Every entry here was taken
# from a state one of the three providers actually returns; nothing is
# speculative.
_STATUS_MAP: Dict[str, str] = {
    # running / powered on
    "running": RUNNING,
    "vm running": RUNNING,
    "poweredon": RUNNING,
    "started": RUNNING,
    # stopped / powered off. Azure distinguishes stopped (still billed for the
    # VM) from deallocated (not billed for compute); both are STOPPED here and
    # the raw value is preserved for anyone who needs the difference.
    "stopped": STOPPED,
    "vm stopped": STOPPED,
    "vm deallocated": STOPPED,
    "deallocated": STOPPED,
    "poweredoff": STOPPED,
    "shutdown": STOPPED,
    "suspended": STOPPED,
    "inactive": STOPPED,
    # available / active / provisioned — the resource exists and is usable.
    # 'active' is NOT 'running': an OCI VCN, an IAM policy and an SQS queue are
    # all ACTIVE and none of them is a thing that runs.
    "available": AVAILABLE,
    "active": AVAILABLE,
    "succeeded": AVAILABLE,
    "online": AVAILABLE,
    "ready": AVAILABLE,
    "enabled": AVAILABLE,
    "provisioned": AVAILABLE,
    "in_use": AVAILABLE,
    "in-use": AVAILABLE,
    # mid-flight
    "provisioning": PROVISIONING,
    "creating": PROVISIONING,
    "updating": PROVISIONING,
    "pending": PROVISIONING,
    "starting": PROVISIONING,
    "stopping": PROVISIONING,
    "restoring": PROVISIONING,
    "scaling": PROVISIONING,
    "accepted": PROVISIONING,
    "modifying": PROVISIONING,
    # unhealthy but present
    "degraded": DEGRADED,
    "unhealthy": DEGRADED,
    "warning": DEGRADED,
    "impaired": DEGRADED,
    "needs_attention": DEGRADED,
    # broken
    "failed": FAILED,
    "error": FAILED,
    "canceled": FAILED,
    "cancelled": FAILED,
    "unavailable": FAILED,
    # gone or going
    "deleted": DELETED,
    "deleting": DELETED,
    "terminated": DELETED,
    "terminating": DELETED,
    "deregistered": DELETED,
    # attachment, which OCI reports as a lifecycle state on volumes
    "attached": ATTACHED,
    "attaching": PROVISIONING,
    "detached": UNATTACHED,
    "detaching": PROVISIONING,
    "unattached": UNATTACHED,
}

# Types whose power state is a real, separate question from their provisioning
# state. For these the provisioning state alone is NOT an answer.
_POWERED_TYPES = frozenset({
    "VirtualMachine", "EC2Instance", "ComputeInstance", "Instance",
    "VirtualMachineScaleSet", "DbSystem", "MySQLDbSystem",
})

# Types where Attached/Unattached is a meaningful state rather than a category
# error. An unattached one of these is a real, billable orphan (spec §38).
ATTACHABLE_TYPES = frozenset({
    "BlockVolume", "BootVolume", "ManagedDisk", "EBSVolume",
    "NetworkInterface", "PublicIP", "ElasticIP", "Vnic",
})


@dataclass(frozen=True)
class StatusVerdict:
    """What we can honestly say about a resource's state."""

    normalized: str
    raw: Optional[str]
    # Present only when `normalized` is UNKNOWN, or when the normalized value
    # came from somewhere other than the raw status column. Rendered verbatim
    # in the UI, so it is written as a sentence a user can act on.
    reason: Optional[str] = None

    @property
    def is_unknown(self) -> bool:
        return self.normalized == UNKNOWN


def normalize_status(
    resource_type: Optional[str],
    raw_status: Optional[str],
    config: Optional[Dict[str, Any]] = None,
    *,
    provider: Optional[str] = None,
) -> StatusVerdict:
    """Map a provider's own state word onto the normalized vocabulary.

    The awkward case, and the reason this takes `config` at all: an Azure VM's
    `status` column holds its ARM *provisioning* state. 'Succeeded' there means
    "ARM finished building this", not "this machine is on". The scanner puts
    the real answer in `config.power_state` when the instance-view call
    succeeded — and leaves it absent when it did not, which is the majority of
    this estate. Absent means UNKNOWN. It does not mean off, and it certainly
    does not mean on.
    """
    cfg = config or {}
    rtype = resource_type or ""

    if rtype in _POWERED_TYPES:
        power = cfg.get("power_state") or cfg.get("powerState")
        if power:
            mapped = _STATUS_MAP.get(str(power).strip().lower())
            if mapped:
                return StatusVerdict(mapped, str(power))
            return StatusVerdict(
                UNKNOWN, str(power),
                f"The provider reported the power state {power!r}, which this "
                "platform does not recognize. It is shown unchanged rather "
                "than guessed at.",
            )
        if rtype == "VirtualMachine" and raw_status:
            # The specific trap. Do not let 'Succeeded' read as "on".
            return StatusVerdict(
                UNKNOWN, raw_status,
                f"Azure reported the provisioning state {raw_status!r}, which "
                "only says the VM was created successfully. Its power state "
                "was not returned, so whether it is running is unknown. "
                "Reading the power state needs Microsoft.Compute/"
                "virtualMachines/instanceView/read.",
            )

    if raw_status is None or str(raw_status).strip() == "":
        return StatusVerdict(
            UNKNOWN, None,
            "The provider did not report a state for this resource. Many "
            "resource types have no lifecycle state to report; this is not "
            "necessarily a fault.",
        )

    key = str(raw_status).strip().lower()
    mapped = _STATUS_MAP.get(key)
    if mapped:
        return StatusVerdict(mapped, str(raw_status))

    # Unrecognized, but the provider did say something. Say what it said.
    return StatusVerdict(
        UNKNOWN, str(raw_status),
        f"The provider reported the state {raw_status!r}, which this platform "
        "does not yet map to a normalized state. The provider's own wording is "
        "shown unchanged.",
    )


# ── Normalized type / category ───────────────────────────────────────────────
# Grouping happens on the category; the provider's own resource_type stays
# visible everywhere (spec §53). Icons are stable slugs, not component names —
# the frontend maps ~15 slugs to its icon set instead of maintaining its own
# copy of all 83 resource types, which is how the two drift apart.
COMPUTE = "COMPUTE"
STORAGE = "STORAGE"
DATABASE = "DATABASE"
NETWORK = "NETWORK"
SECURITY = "SECURITY"
IDENTITY = "IDENTITY"
SERVERLESS = "SERVERLESS"
CONTAINER = "CONTAINER"
ANALYTICS = "ANALYTICS"
AI_ML = "AI_ML"
INTEGRATION = "INTEGRATION"
MONITORING = "MONITORING"
MANAGEMENT = "MANAGEMENT"
OTHER = "OTHER"

CATEGORIES: Tuple[str, ...] = (
    COMPUTE, STORAGE, DATABASE, NETWORK, SECURITY, IDENTITY, SERVERLESS,
    CONTAINER, ANALYTICS, AI_ML, INTEGRATION, MONITORING, MANAGEMENT, OTHER,
)

CATEGORY_LABELS: Dict[str, str] = {
    COMPUTE: "Compute", STORAGE: "Storage", DATABASE: "Database",
    NETWORK: "Network", SECURITY: "Security", IDENTITY: "Identity",
    SERVERLESS: "Serverless", CONTAINER: "Containers", ANALYTICS: "Analytics",
    AI_ML: "AI / ML", INTEGRATION: "Integration", MONITORING: "Monitoring",
    MANAGEMENT: "Management", OTHER: "Other",
}

CATEGORY_ICONS: Dict[str, str] = {
    COMPUTE: "server", STORAGE: "hard-drive", DATABASE: "database",
    NETWORK: "network", SECURITY: "shield", IDENTITY: "user",
    SERVERLESS: "function", CONTAINER: "container", ANALYTICS: "chart",
    AI_ML: "brain", INTEGRATION: "inbox", MONITORING: "activity",
    MANAGEMENT: "settings", OTHER: "cloud",
}

# Explicit registry for the types this platform actually discovers. Anything
# not listed falls through to the heuristic below — which is mandatory, not a
# nicety: Azure's ARM type vocabulary is open-ended and grows without us
# (spec §51), so a closed list would silently mis-bucket new types forever.
_TYPE_REGISTRY: Dict[str, Tuple[str, str]] = {
    # (category, icon)  — icon overrides the category default where it helps
    "EC2Instance": (COMPUTE, "server"),
    "ComputeInstance": (COMPUTE, "server"),
    "VirtualMachine": (COMPUTE, "server"),
    "VirtualMachineScaleSet": (COMPUTE, "server"),
    "AutoScalingGroup": (COMPUTE, "server"),
    "InstancePool": (COMPUTE, "server"),
    "AppService": (COMPUTE, "globe"),
    "AppServicePlan": (COMPUTE, "server"),
    "Extensions": (COMPUTE, "settings"),

    "S3Bucket": (STORAGE, "hard-drive"),
    "ObjectStorageBucket": (STORAGE, "hard-drive"),
    "StorageAccount": (STORAGE, "hard-drive"),
    "BlockVolume": (STORAGE, "hard-drive"),
    "BootVolume": (STORAGE, "hard-drive"),
    "ManagedDisk": (STORAGE, "hard-drive"),
    "EBSVolume": (STORAGE, "hard-drive"),
    "EBSSnapshot": (STORAGE, "hard-drive"),
    "FileSystem": (STORAGE, "folder"),
    "EFSFileSystem": (STORAGE, "folder"),
    "Snapshot": (STORAGE, "hard-drive"),

    "RDSInstance": (DATABASE, "database"),
    "AuroraCluster": (DATABASE, "database"),
    "DynamoDBTable": (DATABASE, "database"),
    "DocumentDBCluster": (DATABASE, "database"),
    "NeptuneCluster": (DATABASE, "database"),
    "RedshiftCluster": (DATABASE, "database"),
    "AutonomousDatabase": (DATABASE, "database"),
    "DbSystem": (DATABASE, "database"),
    "MySQLDbSystem": (DATABASE, "database"),
    "NoSQLTable": (DATABASE, "database"),
    "SQLDatabase": (DATABASE, "database"),
    "SQLServer": (DATABASE, "database"),
    "MySQLServer": (DATABASE, "database"),
    "PostgreSQLServer": (DATABASE, "database"),
    "CosmosDB": (DATABASE, "database"),
    # Caches are not durable stores. Same family, different icon, because
    # "losing this loses nothing" is a materially different fact.
    "ElastiCacheRedis": (DATABASE, "zap"),
    "ElastiCacheMemcached": (DATABASE, "zap"),
    "RedisCache": (DATABASE, "zap"),

    "VPC": (NETWORK, "network"),
    "VCN": (NETWORK, "network"),
    "VirtualNetwork": (NETWORK, "network"),
    "Subnet": (NETWORK, "network"),
    "RouteTable": (NETWORK, "route"),
    "DhcpOptions": (NETWORK, "milestone"),
    "InternetGateway": (NETWORK, "globe"),
    "NatGateway": (NETWORK, "globe"),
    "ServiceGateway": (NETWORK, "globe"),
    "LoadBalancer": (NETWORK, "scale"),
    "NetworkLoadBalancer": (NETWORK, "scale"),
    "ApplicationGateway": (NETWORK, "scale"),
    "NetworkInterface": (NETWORK, "cable"),
    "Vnic": (NETWORK, "cable"),
    "PublicIP": (NETWORK, "globe"),
    "ElasticIP": (NETWORK, "globe"),
    "CloudFront": (NETWORK, "globe"),
    "APIGateway": (NETWORK, "globe"),
    "DrgAttachment": (NETWORK, "workflow"),
    "VirtualCircuit": (NETWORK, "cable"),
    "Drg": (NETWORK, "workflow"),
    "LocalPeeringGateway": (NETWORK, "workflow"),
    "DnsZone": (NETWORK, "globe"),
    "PrivateEndpoint": (NETWORK, "cable"),

    "SecurityGroup": (SECURITY, "shield"),
    "NetworkSecurityGroup": (SECURITY, "shield"),
    "SecurityList": (SECURITY, "shield"),
    "WebAppFirewall": (SECURITY, "shield-alert"),
    "WAF": (SECURITY, "shield-alert"),
    "KeyVault": (SECURITY, "lock"),
    "Vault": (SECURITY, "lock"),
    "KMSKey": (SECURITY, "lock"),
    "Certificates": (SECURITY, "lock"),
    "Certificate": (SECURITY, "lock"),

    "IAMRole": (IDENTITY, "user"),
    "IAMUser": (IDENTITY, "user"),
    "IAMGroup": (IDENTITY, "user"),
    "IAMPolicy": (IDENTITY, "user"),
    "ManagedIdentity": (IDENTITY, "user"),
    "ServicePrincipal": (IDENTITY, "user"),
    "Compartment": (MANAGEMENT, "folder"),
    "ResourceGroup": (MANAGEMENT, "folder"),

    "LambdaFunction": (SERVERLESS, "function"),
    "FunctionApp": (SERVERLESS, "function"),
    "OCIFunction": (SERVERLESS, "function"),
    "LogicApp": (SERVERLESS, "workflow"),

    "EKSCluster": (CONTAINER, "container"),
    "ECSCluster": (CONTAINER, "container"),
    "AKSCluster": (CONTAINER, "container"),
    "OKECluster": (CONTAINER, "container"),
    "ContainerInstance": (CONTAINER, "container"),
    "ContainerRegistry": (CONTAINER, "container"),

    "AnalyticsInstance": (ANALYTICS, "chart"),
    "Stream": (ANALYTICS, "chart"),
    "KinesisStream": (ANALYTICS, "chart"),
    "EventHub": (ANALYTICS, "chart"),
    "DataFactory": (ANALYTICS, "chart"),
    "Workspace": (ANALYTICS, "chart"),

    "BedrockModel": (AI_ML, "brain"),
    "BedrockAgent": (AI_ML, "brain"),
    "BedrockKnowledgeBase": (AI_ML, "book"),
    "SageMakerEndpoint": (AI_ML, "brain"),
    "CognitiveService": (AI_ML, "brain"),

    "SQSQueue": (INTEGRATION, "inbox"),
    "SNSTopic": (INTEGRATION, "megaphone"),
    "ServiceBus": (INTEGRATION, "inbox"),
    "NotificationTopic": (INTEGRATION, "megaphone"),
    "EventGrid": (INTEGRATION, "megaphone"),

    "Metricalerts": (MONITORING, "activity"),
    "MetricAlert": (MONITORING, "activity"),
    "ActivityLogAlerts": (MONITORING, "activity"),
    "SmartDetectorAlertRules": (MONITORING, "activity"),
    "ActionGroup": (MONITORING, "megaphone"),
    "AppInsights": (MONITORING, "activity"),
    "LogAnalytics": (MONITORING, "activity"),
    "CloudWatchAlarm": (MONITORING, "activity"),
    "Alarm": (MONITORING, "activity"),
}

# Ordered longest-first so 'SecurityGroup' cannot be swallowed by a 'group'
# rule before the more specific 'security' one is tried.
_TYPE_HEURISTICS: Tuple[Tuple[str, str], ...] = (
    ("securitygroup", SECURITY), ("securitylist", SECURITY),
    ("firewall", SECURITY), ("keyvault", SECURITY), ("certificate", SECURITY),
    ("vault", SECURITY), ("encryption", SECURITY), ("security", SECURITY),
    ("loadbalancer", NETWORK), ("gateway", NETWORK), ("networkinterface", NETWORK),
    ("publicip", NETWORK), ("subnet", NETWORK), ("network", NETWORK),
    ("vnet", NETWORK), ("vcn", NETWORK), ("vpc", NETWORK), ("dns", NETWORK),
    ("route", NETWORK), ("peering", NETWORK), ("endpoint", NETWORK),
    ("database", DATABASE), ("sql", DATABASE), ("mysql", DATABASE),
    ("postgres", DATABASE), ("mongo", DATABASE), ("cosmos", DATABASE),
    ("redis", DATABASE), ("cache", DATABASE), ("dynamo", DATABASE),
    ("cluster", DATABASE), ("dbsystem", DATABASE),
    ("volume", STORAGE), ("disk", STORAGE), ("bucket", STORAGE),
    ("storage", STORAGE), ("filesystem", STORAGE), ("snapshot", STORAGE),
    ("backup", STORAGE), ("blob", STORAGE),
    ("kubernetes", CONTAINER), ("container", CONTAINER), ("registry", CONTAINER),
    ("function", SERVERLESS), ("lambda", SERVERLESS), ("logicapp", SERVERLESS),
    ("instance", COMPUTE), ("virtualmachine", COMPUTE), ("compute", COMPUTE),
    ("server", COMPUTE), ("appservice", COMPUTE), ("scaleset", COMPUTE),
    ("alert", MONITORING), ("metric", MONITORING), ("monitor", MONITORING),
    ("insights", MONITORING), ("loganalytics", MONITORING), ("alarm", MONITORING),
    ("queue", INTEGRATION), ("topic", INTEGRATION), ("servicebus", INTEGRATION),
    ("eventgrid", INTEGRATION), ("notification", INTEGRATION),
    ("stream", ANALYTICS), ("analytics", ANALYTICS), ("eventhub", ANALYTICS),
    ("datafactory", ANALYTICS), ("warehouse", ANALYTICS),
    ("bedrock", AI_ML), ("sagemaker", AI_ML), ("cognitive", AI_ML), ("ml", AI_ML),
    ("iam", IDENTITY), ("role", IDENTITY), ("identity", IDENTITY),
    ("principal", IDENTITY), ("policy", IDENTITY), ("user", IDENTITY),
    ("group", IDENTITY),
    ("compartment", MANAGEMENT), ("resourcegroup", MANAGEMENT),
    ("subscription", MANAGEMENT), ("tenancy", MANAGEMENT),
)


@dataclass(frozen=True)
class TypeInfo:
    resource_type: str
    category: str
    label: str
    icon: str
    # False when the category came from the heuristic rather than the registry.
    # The UI can still group it correctly while being honest that nobody has
    # explicitly classified this type.
    known: bool


def normalize_type(resource_type: Optional[str]) -> TypeInfo:
    """Bucket a provider resource type into a category for grouping.

    Never raises and never returns None: an unrecognized Azure type must still
    appear in the inventory, in some bucket, with its own name intact.
    """
    rtype = (resource_type or "").strip() or "Unknown"
    entry = _TYPE_REGISTRY.get(rtype)
    if entry:
        category, icon = entry
        return TypeInfo(rtype, category, _humanize(rtype), icon, True)

    lowered = rtype.lower().replace("_", "").replace("-", "").replace(".", "")
    for needle, category in _TYPE_HEURISTICS:
        if needle in lowered:
            return TypeInfo(rtype, category, _humanize(rtype),
                            CATEGORY_ICONS[category], False)
    return TypeInfo(rtype, OTHER, _humanize(rtype), CATEGORY_ICONS[OTHER], False)


def _humanize(rtype: str) -> str:
    """'EC2Instance' -> 'EC2 Instance'. Cosmetic only; the raw type is never
    replaced by this, only shown alongside it."""
    out: List[str] = []
    for i, ch in enumerate(rtype):
        if (
            i and ch.isupper()
            and (rtype[i - 1].islower() or (i + 1 < len(rtype) and rtype[i + 1].islower()))
        ):
            out.append(" ")
        out.append(ch)
    return "".join(out).strip()


def type_registry() -> List[Dict[str, Any]]:
    """The registry as data, for the /types endpoint the frontend reads so it
    does not keep a second copy of this mapping."""
    return [
        {
            "resource_type": rtype,
            "category": category,
            "category_label": CATEGORY_LABELS[category],
            "label": _humanize(rtype),
            "icon": icon,
        }
        for rtype, (category, icon) in sorted(_TYPE_REGISTRY.items())
    ]


# ── Freshness ────────────────────────────────────────────────────────────────
FRESH = "FRESH"
AGING = "AGING"
STALE = "STALE"
CRITICALLY_STALE = "CRITICALLY_STALE"
NEVER_SEEN = "NEVER_SEEN"

FRESHNESS_ORDER: Dict[str, int] = {
    NEVER_SEEN: 0, CRITICALLY_STALE: 1, STALE: 2, AGING: 3, FRESH: 4,
}

# Hours. Overridable because "stale" is an operational judgement that depends
# on how often discovery is scheduled, not a law.
_FRESH_H = int(os.getenv("CLOUD_RESOURCE_FRESH_HOURS", "24"))
_AGING_H = int(os.getenv("CLOUD_RESOURCE_AGING_HOURS", str(7 * 24)))
_STALE_H = int(os.getenv("CLOUD_RESOURCE_STALE_HOURS", str(30 * 24)))

# Anything at or past AGING counts as stale for the summary card and the
# `stale=true` filter. AGING is the point at which the inventory has outlived a
# week of unobserved change, which is already long enough that a user should
# not be told the view is current.
STALE_AT = AGING


@dataclass(frozen=True)
class Freshness:
    severity: str
    observed_at: Optional[datetime]
    age_seconds: Optional[float]
    age_days: Optional[float]
    stale: bool
    label: str


def freshness(observed_at: Optional[datetime], *, now: Optional[datetime] = None) -> Freshness:
    """How old this observation is, and whether that should worry anyone.

    A stale row is not wrong — it is unverified. The distinction matters: the
    resource may have been deleted an hour after we last looked, and nothing in
    the inventory would know. So staleness is surfaced rather than smoothed
    over, and it is never inferred to mean the resource is gone.
    """
    if observed_at is None:
        return Freshness(NEVER_SEEN, None, None, None, True,
                         "Never observed")
    now = now or datetime.now(timezone.utc)
    if observed_at.tzinfo is None:
        observed_at = observed_at.replace(tzinfo=timezone.utc)
    age_s = max(0.0, (now - observed_at).total_seconds())
    age_h = age_s / 3600.0
    age_d = age_s / 86400.0

    if age_h < _FRESH_H:
        severity = FRESH
    elif age_h < _AGING_H:
        severity = AGING
    elif age_h < _STALE_H:
        severity = STALE
    else:
        severity = CRITICALLY_STALE

    return Freshness(
        severity, observed_at, age_s, round(age_d, 2),
        FRESHNESS_ORDER[severity] <= FRESHNESS_ORDER[STALE_AT],
        _age_label(age_s),
    )


def _age_label(age_seconds: float) -> str:
    def ago(n: int, unit: str) -> str:
        return f"{n} {unit}{'' if n == 1 else 's'} ago"   # never "1 hours ago"

    minutes = age_seconds / 60.0
    if minutes < 2:
        return "just now"
    if minutes < 60:
        return ago(int(minutes), "minute")
    hours = minutes / 60.0
    if hours < 48:
        return ago(int(hours), "hour")
    days = hours / 24.0
    if days < 60:
        return ago(int(days), "day")
    return ago(int(days / 30), "month")


# ── Tags, environment, owner ─────────────────────────────────────────────────
# Tag keys are matched case-insensitively because the three providers and every
# team within them disagree about capitalization — this estate carries both
# 'Customer' and 'customer', and both 'Type' and 'type'.
def _tag_lookup(tags: Optional[Dict[str, Any]], candidates: Iterable[str]) -> Optional[str]:
    if not tags or not isinstance(tags, dict):
        return None
    folded = {str(k).strip().lower(): v for k, v in tags.items()}
    for candidate in candidates:
        value = folded.get(candidate.strip().lower())
        if value not in (None, ""):
            return str(value)
    return None


def _env_keys() -> List[str]:
    raw = os.getenv("CLOUD_ENVIRONMENT_TAG_KEYS", "Environment,env,Env,Stage,tier")
    return [k for k in (p.strip() for p in raw.split(",")) if k]


def _owner_keys() -> List[str]:
    raw = os.getenv("CLOUD_OWNER_TAG_KEYS", "Owner,owner,Contact,Team,CreatedBy,ManagedBy")
    return [k for k in (p.strip() for p in raw.split(",")) if k]


def required_tag_keys() -> List[str]:
    """Tags this organization expects on every resource.

    Empty by default, and that is deliberate: shipping a default list of
    Environment/Owner/CostCenter would immediately report a governance failure
    rate this platform invented rather than one the organization declared. The
    keys come from configuration or nowhere.
    """
    raw = os.getenv("CLOUD_REQUIRED_TAG_KEYS", "")
    return [k for k in (p.strip() for p in raw.split(",")) if k]


def environment_of(tags: Optional[Dict[str, Any]]) -> Optional[str]:
    return _tag_lookup(tags, _env_keys())


def owner_of(tags: Optional[Dict[str, Any]]) -> Optional[str]:
    return _tag_lookup(tags, _owner_keys())


def tag_count(tags: Optional[Dict[str, Any]]) -> int:
    if not tags or not isinstance(tags, dict):
        return 0
    return len(tags)


def missing_required_tags(tags: Optional[Dict[str, Any]]) -> List[str]:
    keys = required_tag_keys()
    if not keys:
        return []
    return [k for k in keys if _tag_lookup(tags, [k]) is None]


# ── Provider-native placement ────────────────────────────────────────────────
# Azure writes resource_group into metadata, OCI writes compartment_name there;
# neither is in config, which is where an earlier reading of this code looked.
# Verified against 804/826 Azure rows and 476/476 OCI rows in this estate.
def placement(metadata: Optional[Dict[str, Any]],
              config: Optional[Dict[str, Any]]) -> Dict[str, Optional[str]]:
    md = metadata if isinstance(metadata, dict) else {}
    cfg = config if isinstance(config, dict) else {}

    def pick(*keys: str) -> Optional[str]:
        for key in keys:
            for source in (md, cfg):
                value = source.get(key)
                if value not in (None, ""):
                    return str(value)
        return None

    return {
        "resource_group": pick("resource_group", "resourceGroup"),
        "compartment": pick("compartment_name", "compartmentName"),
        "compartment_id": pick("compartment_id", "compartmentId"),
        "availability_zone": pick("availability_zone", "availability_domain",
                                  "availability_zone_id", "zone"),
        "subscription": pick("subscription_id", "subscriptionId", "subscription"),
    }


def attachment_state(resource_type: Optional[str],
                     config: Optional[Dict[str, Any]]) -> Optional[str]:
    """ATTACHED / UNATTACHED, or None when the question does not apply.

    None is not the same as UNATTACHED. A subnet is not an unattached disk, and
    counting it as one would put every network object into the orphan report.
    """
    if (resource_type or "") not in ATTACHABLE_TYPES:
        return None
    cfg = config if isinstance(config, dict) else {}
    raw = cfg.get("attachment_status")
    if raw is None:
        return None
    return ATTACHED if str(raw).strip().lower() == "attached" else UNATTACHED


def is_default_resource(resource_name: Optional[str],
                        config: Optional[Dict[str, Any]]) -> bool:
    """Provider-created boilerplate — default VPCs, default security groups.

    Kept identical to the definition the current table already uses, so the
    'hide defaults' control and the 'default' badge cannot disagree.
    """
    cfg = config if isinstance(config, dict) else {}
    if cfg.get("is_default") is True:
        return True
    return (resource_name or "").strip().lower() == "default"
