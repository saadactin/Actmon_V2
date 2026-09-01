"""Field-level configuration diffing and cross-pillar impact classification.

Pure functions - no DB, no provider SDKs - so the rules can be unit-tested and
reused by whatever writes the change log.

Every field name below was taken from a live inventory dump of this system's
own database (1,527 resources across AWS / Azure / OCI), not from provider
documentation. A field we have never actually seen is classified as CONFIG with
LOW severity rather than guessed into a pillar it might not belong to.

Two things this module deliberately does NOT do:

*   It does not diff `raw_data`. That is the verbatim provider payload, carrying
    timestamps, ETags and SDK-version churn, so it differs on essentially every
    scan and would bury real drift under noise. `metadata` IS diffed, minus its
    timestamp keys (see ``TIMESTAMP_FIELDS``), because the rest of it is real:
    an OCI compartment or an Azure resource group moving changes who gets
    billed for the resource.
*   It does not diff continuously-varying usage counters (see
    ``USAGE_COUNTER_FIELDS``). A DynamoDB table's `item_count` changes every
    minute by design; that is telemetry, not configuration drift.
"""
from __future__ import annotations

import json
from enum import Enum
from typing import Any, Dict, Iterable, List, Optional, Tuple

# -- Pillars -------------------------------------------------------------------
# What a change affects. A field may touch more than one: stopping an instance
# is both an availability event and a cost event, because the compute stops
# billing while its attached storage keeps billing.
PILLAR_SECURITY = "security"
PILLAR_COST = "cost"
PILLAR_TOPOLOGY = "topology"
PILLAR_AVAILABILITY = "availability"
PILLAR_GOVERNANCE = "governance"
PILLAR_CONFIG = "config"

ALL_PILLARS = (
    PILLAR_SECURITY,
    PILLAR_COST,
    PILLAR_TOPOLOGY,
    PILLAR_AVAILABILITY,
    PILLAR_GOVERNANCE,
    PILLAR_CONFIG,
)

# -- Severities ----------------------------------------------------------------
SEV_CRITICAL = "CRITICAL"
SEV_HIGH = "HIGH"
SEV_MEDIUM = "MEDIUM"
SEV_LOW = "LOW"

_SEV_ORDER = {SEV_LOW: 0, SEV_MEDIUM: 1, SEV_HIGH: 2, SEV_CRITICAL: 3}

# -- Change kinds --------------------------------------------------------------
CHANGE_CREATED = "CREATED"
CHANGE_MODIFIED = "MODIFIED"
CHANGE_DELETED = "DELETED"

# -- Direction -----------------------------------------------------------------
# Only set when the transition itself is unambiguous. A security field flipping
# from false to true is a real widening; a list of firewall rules growing from
# 3 to 5 entries is not necessarily, so it gets no direction at all rather than
# a guessed one.
DIR_MORE_OPEN = "MORE_OPEN"
DIR_MORE_RESTRICTIVE = "MORE_RESTRICTIVE"
DIR_SCALE_UP = "SCALE_UP"
DIR_SCALE_DOWN = "SCALE_DOWN"

# -- Fields never diffed -------------------------------------------------------
# Telemetry that moves on its own. Excluded so the change log stays a record of
# what someone actually did, which is the only thing you can act on.
USAGE_COUNTER_FIELDS = frozenset({
    "available_ips",     # AWS Subnet - falls as instances launch
    "item_count",        # AWS DynamoDBTable
    "size_bytes",        # AWS DynamoDBTable
    "metered_bytes",     # OCI FileSystem - grows with every write
    "member_count",      # OCI IAMGroup
    "statement_count",   # OCI IAMPolicy - the statements themselves are diffed
    "route_rule_count",  # OCI RouteTable - ditto route_rules
    "total_rules",       # OCI SecurityList / NSG - ditto ingress/egress_rules
})

# Mirrors of another resource's state. `attached_to_status` on a volume just
# repeats its instance's `status`, so keeping it would log the same instance
# stop once per attached disk. The volume's own `attachment_status` is a real,
# independent event and IS diffed.
DERIVED_MIRROR_FIELDS = frozenset({
    "attached_to_status",
    "attached_to_name",
})

# Fields a provider fills in from a SECOND API call, made per resource after the
# list call that found it. That call can fail on its own, and when it does the
# field comes back empty while the resource is otherwise reported fine.
#
# Observed live: five OCI instances in one sweep, four of which gained
# private_ip / subnet_id and one of which LOST them. Churn in both directions
# across one scan is the signature of a flaky lookup, not of anyone changing
# five instances' networking. So when one of these goes from a value to nothing,
# it is reported at LOW with the ambiguity stated, instead of as a topology and
# security event that may never have happened. A value changing to a DIFFERENT
# value is unambiguous and keeps its full classification.
SECONDARY_LOOKUP_FIELDS = frozenset({
    "private_ip",   # OCI ComputeInstance, via list_vnic_attachments -> get_vnic
    "public_ip",    # same VNIC
    "subnet_id",    # same VNIC
    "nsg_ids",      # same VNIC
    # AWS S3, one separate per-bucket call each, every one wrapped in a
    # try/except that swallows the failure (aws_scanner._scan_s3).
    "public_access_block",   # get_public_access_block
    "encryption",            # get_bucket_encryption
    "versioning",            # get_bucket_versioning
    "lifecycle_rules",       # get_bucket_lifecycle_configuration
})

# A stricter subset: fields where an empty STORED value cannot be told apart
# from a lookup that failed, so a value APPEARING is also ambiguous.
#
# This is deliberately narrower than SECONDARY_LOOKUP_FIELDS. For an OCI VNIC
# field, a stored null is a real answer — the scanner only writes public_ip at
# all when the lookup succeeded, so null means "we looked, there is no public
# IP", and a value appearing IS a genuine exposure change that must stay
# CRITICAL. For these AWS fields the scanner defaults a failure and a
# legitimately-unset value to the SAME None, so the two cannot be separated:
#
#   public_access_block  AWS throws NoSuchPublicAccessBlockConfiguration when
#                        it is unset, and _scan_s3 maps that and a transport
#                        failure both to None.
#   encryption           None means "no default encryption" or "could not read".
#   versioning           None only ever means the call failed (success always
#                        yields a string), so None -> a value is a recovery.
#   lifecycle_rules      None = could not read; [] = confirmed zero rules. Only
#                        None is ambiguous, which is why _is_unreadable below
#                        does NOT treat an empty list as unreadable.
#
# Added after a live scan reported a bucket's public_access_block appearing as a
# HIGH security finding when the previous scan had simply failed to read it.
UNREADABLE_WHEN_EMPTY_FIELDS = frozenset({
    "public_access_block",
    "encryption",
    "versioning",
    "lifecycle_rules",
    # OCI NSG rules, from a separate per-NSG call
    # (list_network_security_group_security_rules). Keyed on None, not on
    # emptiness, which is what makes this safe to list here: the OCI SecurityList
    # scanner and the Azure/AWS equivalents get their rules inline and emit [] for
    # "no rules", so this never fires for them — only for the one scanner that
    # writes None because it genuinely could not read.
    "ingress_rules",
    "egress_rules",
    "total_rules",
})

# Values a scanner writes when a lookup failed, as opposed to a value the
# provider actually reported. aws_scanner._scan_s3 stores "unknown" when
# get_bucket_location throws, so "unknown" -> "ap-south-1" is a lookup finally
# succeeding, not a bucket changing region (which is impossible anyway).
_UNREADABLE_SENTINELS = frozenset({"unknown", "unavailable", "n/a"})

# Provider-side timestamps living in `metadata`. `time_created` never moves and
# the rest only record when something else happened, so logging them as changes
# in their own right says nothing you cannot read off detected_at.
TIMESTAMP_FIELDS = frozenset({
    "time_created",
    "create_date",
    "created_date",
    "creation_date",
    "last_modified",
})

# Top-level resource columns worth watching. Everything else on the row is
# either an identity key, a timestamp, or provider payload.
#
# `ip_address` is deliberately absent: the scanners populate it from the same
# VNIC lookup that fills config.private_ip / config.public_ip, so tracking it
# too reports every address change twice — once with the caveats those fields
# carry (see SECONDARY_LOOKUP_FIELDS) and once without them, which is the worse
# of the two rows. The address is still tracked, at config level.
TRACKED_COLUMNS = ("status", "resource_name", "region_or_zone")


# -- Field -> (pillars, severity) ----------------------------------------------
# Keyed on the leaf field name, which is unambiguous here: every provider's
# `config` in this system is a flat one-level dict (verified against all 90
# provider/type combinations on file).

_SECURITY_EXPOSURE_FIELDS = {
    # Fields whose value directly decides whether something is reachable from
    # the internet. These are the ones that can carry a MORE_OPEN direction.
    "public_access_type",         # OCI ObjectStorageBucket
    "public_access_block",        # AWS S3Bucket
    "allow_blob_public_access",   # Azure StorageAccount
    "public_network_access",      # Azure PostgreSQLServer
    "is_public",                  # OCI Subnet
    "public_ip_on_launch",        # AWS Subnet
    "public_ip",                  # OCI ComputeInstance
    "public_ip_ids",              # Azure NetworkInterface
    "is_private",                 # OCI LoadBalancer (inverted - see below)
    "fqdn",                       # Azure PublicIP
}

# Value -> is this the open end of the field. Anything not listed stays
# direction-less rather than being guessed.
_OPEN_VALUES = {"true", "enabled", "public", "objectread", "objectreadwithoutlist"}
_CLOSED_VALUES = {"false", "disabled", "private", "nopublicaccess", "none", ""}

# Fields where the open end is the falsy one, so the direction inverts.
_INVERTED_EXPOSURE_FIELDS = frozenset({
    "is_private",           # is_private=false means internet-facing
    "public_access_block",  # AWS: the block being ON is the safe end
})

# Exposure decided by presence, not by a keyword. An address or hostname will
# never match _OPEN_VALUES, but a compute instance that gains a public IP is
# reachable from the internet and one that loses it is not - so for these
# fields, having any value at all IS the open end.
_PRESENCE_EXPOSURE_FIELDS = frozenset({
    "public_ip",       # OCI ComputeInstance
    "public_ip_ids",   # Azure NetworkInterface
    "fqdn",            # Azure PublicIP
})

_FIELD_RULES: Dict[str, Tuple[Tuple[str, ...], str]] = {}


def _register(fields: Iterable[str], pillars: Tuple[str, ...], severity: str) -> None:
    for f in fields:
        _FIELD_RULES[f] = (pillars, severity)


# Security - exposure. Highest base severity in the table: a bucket going
# public is the single worst config change in this product's problem domain.
_register(_SECURITY_EXPOSURE_FIELDS, (PILLAR_SECURITY,), SEV_HIGH)

# Security - firewall and access rules. HIGH, but no direction: these are lists
# of rule objects and "more rules" is not the same as "more open".
_register(
    (
        "ingress_rules", "egress_rules",             # OCI SecurityList/NSG, Azure NSG
        "inbound_rules", "outbound_rules",           # AWS SecurityGroup
        "route_rules",                               # OCI RouteTable
        "statements",                                # OCI IAMPolicy
        "accessible_resources", "broad_access",      # AWS IAMRole
        "listeners", "backend_sets", "backend_ips",  # OCI LoadBalancer
    ),
    (PILLAR_SECURITY,),
    SEV_HIGH,
)

# Security - encryption, key management and data protection.
_register(
    (
        "encryption", "versioning", "kms_key_id",
        "environment_variables",   # AWS Lambda - a common secret-leak surface
        "geo_redundant_backup", "backup_retention_days",
    ),
    (PILLAR_SECURITY,),
    SEV_MEDIUM,
)

# Security + topology - which firewall a resource sits behind. Changing this
# silently re-points the whole rule set that governs the resource.
_register(
    (
        "network_security_group_id", "nsg_ids", "security_group_ids",
        "security_list_ids", "web_app_firewall_policy_id",
        "default_security_list_id",
    ),
    (PILLAR_SECURITY, PILLAR_TOPOLOGY),
    SEV_HIGH,
)

# Cost - the shape/tier/SKU dials. These are what a bill actually responds to.
_register(
    (
        "shape", "shape_name", "vm_size", "sku", "tier", "edition",
        "capacity_type", "license_type", "license_model", "lb_type",
        "bandwidth_shape_name", "billing_mode", "storage_tier", "access_tier",
        "compute_model", "storage_performance_mode", "disk_redundancy",
        "high_availability_mode", "image", "database_edition",
    ),
    (PILLAR_COST,),
    SEV_MEDIUM,
)

# Cost - numeric capacity. Diffable as numbers, so these carry SCALE_UP /
# SCALE_DOWN, which is the honest form of "cost impact": we can prove the
# capacity moved and in which direction without inventing a currency figure.
_register(
    (
        "ocpus", "cpu_core_count", "compute_count", "node_count",
        "memory_gb", "memory_mb", "memory_in_mbs",
        "size_gb", "disk_size_gb", "storage_gb", "data_storage_size_gb",
        "data_storage_size_tbs", "max_size_bytes", "vpus_per_gb",
        "read_capacity", "write_capacity", "capacity_value",
        "attached_storage_gb", "block_volume_gb", "boot_volume_gb",
        "block_volume_count", "timeout_s", "timeout_in_seconds",
        "max_session_duration",
    ),
    (PILLAR_COST,),
    SEV_MEDIUM,
)

# Cost - autoscaling / auto-tuning switches.
_register(
    ("is_auto_scaling_enabled", "is_auto_tune_enabled"),
    (PILLAR_COST,),
    SEV_MEDIUM,
)

# Topology - attachment. This is the pair of fields the storage attach/detach
# work already keys off, so drift here lines up with the existing alerts.
_register(
    ("attached_to_id", "attachment_status", "managed_by", "os_disk_id",
     "data_disk_ids", "nic_ids", "load_balancer_id", "gateway_id",
     "attached_network_id", "attached_network_type", "drg_id",
     "application_id", "availability_set_id", "identity_id"),
    (PILLAR_TOPOLOGY,),
    SEV_MEDIUM,
)

# Topology - network placement and addressing.
_register(
    (
        "subnet_id", "subnet_ids", "vcn_id", "vpc_id", "virtual_network_id",
        "route_table_id", "nat_gateway_id", "default_route_table_id",
        "default_dhcp_options_id", "private_ip", "ip_addresses",
        "cidr_block", "cidr_blocks", "address_prefix",
        "availability_domain", "availability_zone", "fault_domain",
        "fault_domain_full", "dns_label", "domain_name", "domain_name_type",
        "is_ipv6_enabled", "allocation_method", "accelerated_networking",
        "listener_port", "hostname", "cluster_name", "invoke_endpoint",
        "service_url", "target", "protocol", "backend_type",
        # metadata-side equivalents
        "availability_zone_id", "dhcp_options_id", "server",
    ),
    (PILLAR_TOPOLOGY,),
    SEV_LOW,
)

# Governance + cost allocation — which compartment / resource group / region a
# resource is billed against. Moving a resource between them re-points its share
# of the bill, which is exactly what the compartment-aware cost report reads.
_register(
    ("compartment_id", "compartment_name", "resource_group", "region"),
    (PILLAR_GOVERNANCE, PILLAR_COST),
    SEV_MEDIUM,
)

# Security — credentials and login surface reported in metadata.
_register(("administrator_login",), (PILLAR_SECURITY,), SEV_HIGH)

# Deployment marker: a Lambda's package size only moves when new code ships.
_register(("code_size",), (PILLAR_GOVERNANCE,), SEV_MEDIUM)

# Availability / lifecycle state.
_register(
    ("power_state", "disk_state", "bgp_session_state", "provider_state",
     "provider_name", "lifecycle_state"),
    (PILLAR_AVAILABILITY,),
    SEV_MEDIUM,
)

# Governance - labels, ownership, descriptions. Real drift, low blast radius.
_register(
    ("description", "path", "db_name", "db_workload", "os_type", "runtime",
     "handler", "role_arn", "version", "feature_set", "kind", "azure_type",
     "namespace", "image_id", "image_digest", "is_default", "is_clone_parent",
     "lifecycle_rules", "event_source_arns", "application_name",
     # metadata-side equivalents
     "collation", "key_schema", "role_id"),
    (PILLAR_GOVERNANCE,),
    SEV_LOW,
)


# -- Value rendering -----------------------------------------------------------
_MAX_VALUE_CHARS = 400


def _canonical(value: Any) -> str:
    """Order-insensitive canonical form, used for equality only.

    Providers return collections in whatever order their API felt like, and a
    reordered list is not a change. Sorting the serialized members is what
    stops every scan from reporting phantom drift on `ingress_rules`.
    """
    if isinstance(value, list):
        return json.dumps(sorted(json.dumps(v, sort_keys=True, default=str) for v in value))
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, default=str)
    return json.dumps(value, default=str)


def render_value(value: Any) -> str:
    """Short human-readable form for the from -> to columns in the UI."""
    if value is None:
        return "-"
    # Provider SDK enums first. The Azure SDK's models subclass (str, Enum), and
    # since Python 3.11 str() on such a member returns "DiskState.RESERVED"
    # rather than its value — so a real disk state change was displayed as
    # "Attached -> DiskState.RESERVED", leaking Python syntax into the log next
    # to a plain value. Comparison was never affected (_canonical goes through
    # json.dumps, which yields "Reserved"), only what the reader saw.
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        text = str(value)
    elif isinstance(value, list):
        if not value:
            text = "(empty)"
        elif all(isinstance(v, (str, int, float, bool)) for v in value):
            text = ", ".join(str(v) for v in value)
        else:
            # Lists of rule/dict objects: a count is the only summary that is
            # both compact and true. The full payload stays on the resource.
            text = f"{len(value)} item{'s' if len(value) != 1 else ''}"
    elif isinstance(value, dict):
        text = json.dumps(value, sort_keys=True, default=str)
    else:
        text = str(value)
    if len(text) > _MAX_VALUE_CHARS:
        # Budget for the marker itself, so the result honours the cap rather
        # than overshooting it by the marker's width.
        text = text[: _MAX_VALUE_CHARS - 3] + "..."
    return text or "-"


def _as_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _openness(value: Any, *, by_presence: bool = False) -> Optional[bool]:
    """True if this value is the internet-facing end of an exposure field.

    None means "cannot tell from this value" — the caller then records no
    direction rather than guessing one.
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (list, tuple)):
        return len(value) > 0
    if by_presence:
        return bool(str(value).strip())
    text = str(value).strip().lower().replace("_", "").replace(" ", "")
    if text in _OPEN_VALUES:
        return True
    if text in _CLOSED_VALUES:
        return False
    return None


def _is_empty(value: Any) -> bool:
    """Nothing there — None, blank string, or an empty collection."""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


# Top-level columns a scanner may fill with a sentinel rather than leave empty.
_SENTINEL_COLUMNS = frozenset({"region_or_zone"})


def _is_unreadable(value: Any) -> bool:
    """None, or a scanner's placeholder for a lookup that failed.

    Deliberately stricter than _is_empty: an empty LIST or STRING is often a
    real answer the provider gave (lifecycle_rules == [] means "confirmed zero
    rules", which _scan_s3 goes out of its way to distinguish from None). Only
    None and the explicit sentinels mean "nobody could read this".
    """
    if value is None:
        return True
    return isinstance(value, str) and value.strip().lower() in _UNREADABLE_SENTINELS


def _is_lookup_artifact(leaf: str, old: Any, new: Any) -> bool:
    """Could this diff be the follow-up lookup failing or recovering?

    Two different situations, kept apart on purpose:

    *   A value EMPTYING OUT, for any field fetched by its own fallible call.
        Always ambiguous — the call may just have failed this time.
    *   A value APPEARING, only for the narrower set where an empty stored
        value is itself unreadable. For an OCI VNIC field a stored null is a
        real answer, so a public IP appearing stays a genuine CRITICAL exposure
        change; suppressing that would silence the finding this whole module
        exists to raise.

    Only ONE-SIDED transitions qualify. A real value changing to a different
    real value is unambiguous and keeps its full classification.
    """
    if leaf in _SENTINEL_COLUMNS:
        # Symmetric: a sentinel is never something the provider reported.
        return _is_unreadable(old) != _is_unreadable(new)
    if leaf in UNREADABLE_WHEN_EMPTY_FIELDS:
        # Symmetric and keyed on None: for these fields None is the scanner's
        # "could not read", so it is ambiguous whichever side it lands on.
        return _is_unreadable(old) != _is_unreadable(new)
    if leaf in SECONDARY_LOOKUP_FIELDS and _is_empty(new) and not _is_empty(old):
        return True
    return False


def _bump(severity: str, floor: str) -> str:
    return severity if _SEV_ORDER[severity] >= _SEV_ORDER[floor] else floor


def classify_field_change(
    field_path: str, old: Any, new: Any, old_present: bool = True
) -> Tuple[List[str], str, Optional[str]]:
    """(pillars, severity, direction) for one changed field.

    An unrecognised field is CONFIG / LOW - visible in the log, never dressed
    up as a security or cost event it may not be.

    `old_present=False` means the key was ABSENT from the stored config, not
    that the provider reported it empty. Those are different facts and this is
    the single most important place not to conflate them: three OCI instances
    whose VNIC lookup came back empty on one sweep and populated on the next
    would otherwise each report "became reachable from the internet" — a
    CRITICAL security alarm raised by a scan gap, not by anything anyone did.
    So a first-time-collected field keeps its pillar and base severity but
    claims no direction, because there is no previous value to compare against.
    """
    leaf = field_path.rsplit(".", 1)[-1]

    if field_path.startswith("tags."):
        return [PILLAR_GOVERNANCE], SEV_LOW, None

    if field_path == "status":
        # Both pillars, on purpose. A stopped instance is an availability event,
        # and it is also the cost event this product already reports on: compute
        # billing stops while attached storage keeps billing.
        return [PILLAR_AVAILABILITY, PILLAR_COST], SEV_MEDIUM, None

    if field_path == "resource_name":
        return [PILLAR_GOVERNANCE], SEV_LOW, None

    if field_path == "region_or_zone":
        # "unknown" -> a real region is get_bucket_location finally answering,
        # not a resource moving between regions (which cannot happen for most
        # types anyway). Reported, but not as a topology and cost event.
        if _is_lookup_artifact(leaf, old, new):
            return [PILLAR_CONFIG], SEV_LOW, None
        return [PILLAR_TOPOLOGY, PILLAR_COST], SEV_MEDIUM, None

    if field_path == "ip_address":
        return [PILLAR_TOPOLOGY, PILLAR_SECURITY], SEV_MEDIUM, None

    rule_pillars, severity = _FIELD_RULES.get(leaf, ((PILLAR_CONFIG,), SEV_LOW))
    pillars = list(rule_pillars)
    direction: Optional[str] = None

    if not old_present:
        # Nothing to compare against — no direction can be claimed either way.
        return pillars, severity, None

    # A secondary-lookup field appearing or emptying out is as likely to be the
    # follow-up call recovering or failing as a real change, so it is recorded
    # without being escalated. Both directions, because both are ambiguous: a
    # bucket's public_access_block showing up was reported as a HIGH security
    # finding when the earlier scan had merely failed to read it.
    if _is_lookup_artifact(leaf, old, new):
        return pillars, SEV_LOW, None

    if leaf in _SECURITY_EXPOSURE_FIELDS:
        by_presence = leaf in _PRESENCE_EXPOSURE_FIELDS
        was_open = _openness(old, by_presence=by_presence)
        is_open = _openness(new, by_presence=by_presence)
        if leaf in _INVERTED_EXPOSURE_FIELDS:
            was_open = None if was_open is None else not was_open
            is_open = None if is_open is None else not is_open
        if was_open is not None and is_open is not None and was_open != is_open:
            if is_open:
                # Something that was not reachable from the internet now is.
                direction = DIR_MORE_OPEN
                severity = _bump(severity, SEV_CRITICAL)
            else:
                direction = DIR_MORE_RESTRICTIVE
                severity = SEV_LOW

    if PILLAR_COST in pillars and direction is None:
        old_n, new_n = _as_number(old), _as_number(new)
        if old_n is not None and new_n is not None and old_n != new_n:
            direction = DIR_SCALE_UP if new_n > old_n else DIR_SCALE_DOWN

    return pillars, severity, direction


def describe_field_change(
    resource_type: str,
    field_path: str,
    old: Any,
    new: Any,
    direction: Optional[str],
    old_present: bool = True,
) -> str:
    """One sentence, stating only what the two values were."""
    label = (
        field_path.split(".", 1)[-1]
        if field_path.startswith(("config.", "metadata."))
        else field_path
    )
    if not old_present:
        # Say what actually happened. Rendering this as "- -> 1.2.3.4" reads as
        # "it just got a public IP", which is a claim we cannot support.
        return (
            f"{resource_type} {label} recorded for the first time: {render_value(new)} "
            "(not collected by the previous scan, so no before value to compare)"
        )
    base = f"{resource_type} {label}: {render_value(old)} -> {render_value(new)}"
    leaf = field_path.rsplit(".", 1)[-1]
    if _is_lookup_artifact(leaf, old, new):
        recovered = _is_unreadable(old) and not _is_unreadable(new)
        return base + (
            " (this value comes from a follow-up lookup that can fail on its own,"
            " so the previous scan may simply have been unable to read it rather"
            " than it being newly set)"
            if recovered else
            " (this value comes from a follow-up lookup that can fail on its own,"
            " so it may have been unreadable this scan rather than removed)"
        )
    suffix = {
        DIR_MORE_OPEN: " (now reachable from the internet)",
        DIR_MORE_RESTRICTIVE: " (now more restricted)",
        DIR_SCALE_UP: " (capacity increased - expect higher spend)",
        DIR_SCALE_DOWN: " (capacity reduced - expect lower spend)",
    }.get(direction or "", "")
    return base + suffix


# -- Diffing -------------------------------------------------------------------

def _diff_dict(prefix: str, old: Any, new: Any) -> List[Tuple[str, Any, Any, bool]]:
    """Per-key diff of two flat dicts (config / tags / metadata).

    The fourth element is whether the key existed in the stored dict — see
    classify_field_change for why "absent" and "empty" must not be conflated.
    """
    old_d = old if isinstance(old, dict) else {}
    new_d = new if isinstance(new, dict) else {}
    out: List[Tuple[str, Any, Any, bool]] = []
    for key in sorted(set(old_d) | set(new_d)):
        if (
            key in USAGE_COUNTER_FIELDS
            or key in DERIVED_MIRROR_FIELDS
            or key in TIMESTAMP_FIELDS
        ):
            continue
        before, after = old_d.get(key), new_d.get(key)
        if _canonical(before) != _canonical(after):
            out.append((f"{prefix}.{key}", before, after, key in old_d))
    return out


def diff_resource(existing: Any, incoming: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Field-level changes between a stored resource row and a freshly scanned one.

    `existing` is a CloudResource ORM instance; `incoming` is the scanner's
    normalized dict. Returns one entry per changed field, already classified.
    An empty list means nothing we track moved - the common case, and the reason
    a nightly scan does not produce thousands of log rows.
    """
    resource_type = (
        incoming.get("resource_type")
        or getattr(existing, "resource_type", "")
        or "Resource"
    )
    # (field_path, before, after, the key existed in the stored state)
    changes: List[Tuple[str, Any, Any, bool]] = []

    for column in TRACKED_COLUMNS:
        # The scanner omitting a key is not the same as the provider reporting
        # it empty: upsert only writes name/type/region when the key is present,
        # so a missing key must not be read as "cleared".
        if column in ("resource_name", "region_or_zone") and column not in incoming:
            continue
        before = getattr(existing, column, None)
        after = incoming.get(column)
        if _canonical(before) != _canonical(after):
            # A real table column always existed, so there is always a genuine
            # before value here — only dict keys can be newly collected.
            changes.append((column, before, after, True))

    changes.extend(_diff_dict("config", getattr(existing, "config", None), incoming.get("config")))
    changes.extend(_diff_dict("tags", getattr(existing, "tags", None), incoming.get("tags")))
    # The ORM attribute is metadata_ (metadata is reserved on the declarative
    # base); the scanner's key is plain "metadata".
    changes.extend(
        _diff_dict("metadata", getattr(existing, "metadata_", None), incoming.get("metadata"))
    )

    out: List[Dict[str, Any]] = []
    for field_path, before, after, old_present in changes:
        pillars, severity, direction = classify_field_change(
            field_path, before, after, old_present
        )
        out.append({
            "change_type": CHANGE_MODIFIED,
            "field_path": field_path,
            # A field with no stored predecessor has no before value to show;
            # rendering None as "-" here would imply the provider reported it
            # empty last time, which is exactly the confusion to avoid.
            "old_value": render_value(before) if old_present else None,
            "new_value": render_value(after),
            "impact": pillars,
            "severity": severity,
            "direction": direction,
            # The field went away rather than changing value. This is the only
            # diff an incomplete sweep can manufacture, so it is flagged for the
            # worker to drop if the sweep turns out not to have been clean.
            "value_vanished": _is_empty(after) and not _is_empty(before),
            "summary": describe_field_change(
                resource_type, field_path, before, after, direction, old_present
            ),
        })
    return out


def describe_deletion(resource_type: str, resource_name: str) -> Dict[str, Any]:
    """A resource that a clean sweep no longer sees.

    Only ever produced from a complete sweep - an incomplete one cannot tell
    "gone" from "not enumerated", the same reason it is not allowed to prune.
    """
    return {
        "change_type": CHANGE_DELETED,
        "field_path": None,
        "old_value": resource_name or None,
        "new_value": None,
        "impact": [PILLAR_TOPOLOGY, PILLAR_COST, PILLAR_AVAILABILITY],
        "severity": SEV_HIGH,
        "direction": None,
        "summary": f"{resource_type} '{resource_name}' no longer exists in the provider",
    }


def describe_creation(
    resource_type: str, resource_name: str, region: Optional[str]
) -> Dict[str, Any]:
    """A resource seen for the first time after the account's baseline scan."""
    where = f" in {region}" if region else ""
    return {
        "change_type": CHANGE_CREATED,
        "field_path": None,
        "old_value": None,
        "new_value": resource_name or None,
        "impact": [PILLAR_TOPOLOGY, PILLAR_COST],
        "severity": SEV_MEDIUM,
        "direction": None,
        "summary": f"New {resource_type} '{resource_name}' appeared{where}",
    }
