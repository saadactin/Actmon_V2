"""What each provider integration can actually do with a resource.

Spec §49: do not force AWS, Azure and OCI into identical behaviour. The UI
reads this to disable a control with a real explanation, instead of offering a
button that fails, or worse, appears to succeed.

WHY THIS FILE CROSS-CHECKS ITSELF
---------------------------------
A capability flag is a claim about code that lives somewhere else. Left alone,
it rots the first time someone adds or removes a provider method, and the rot
is invisible until a user clicks something. So `verify_against_implementation`
walks the real provider classes and reports every flag that disagrees with
them. The test suite fails on any disagreement, which means a flag here cannot
outlive the method it describes.

The load-bearing entries today:

  * Every mutating capability is False for all three providers, because none of
    the three provider adapters implements a single write call. There is no
    start, no stop, no tag, no delete anywhere in app/providers/. Spec §39
    requires provider support before an action is offered, and the honest
    answer is that there is none yet.
  * AWS resource_cost is False. Cost Explorer has no per-resource dimension;
    that needs a Cost and Usage Report pipeline. Reporting it as merely "no
    data" would read as "these AWS resources cost nothing".
"""
from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# Capability keys. Each is a question a user asks by clicking something.
DISCOVERY = "discovery"
CONFIGURATION = "configuration"
RAW_DATA = "raw_data"
TAGS = "tags"
ACCOUNT_COST = "account_cost"
RESOURCE_COST = "resource_cost"
METRICS = "metrics"
MEMORY_METRICS = "memory_metrics"
RELATIONSHIPS = "relationships"
AUDIT_EVENTS = "audit_events"
CONFIG_HISTORY = "config_history"
TARGETED_REFRESH = "targeted_refresh"
TAG_MUTATION = "tag_mutation"
POWER_ACTIONS = "power_actions"
DELETE = "delete"
CONSOLE_LINK = "console_link"

CAPABILITY_LABELS: Dict[str, str] = {
    DISCOVERY: "Resource discovery",
    CONFIGURATION: "Configuration detail",
    RAW_DATA: "Raw provider payload",
    TAGS: "Tags",
    ACCOUNT_COST: "Account cost",
    RESOURCE_COST: "Per-resource cost",
    METRICS: "Metrics",
    MEMORY_METRICS: "Memory metrics",
    RELATIONSHIPS: "Relationships",
    AUDIT_EVENTS: "Audit events",
    CONFIG_HISTORY: "Configuration change history",
    TARGETED_REFRESH: "Refresh a single resource",
    TAG_MUTATION: "Edit tags",
    POWER_ACTIONS: "Start / stop / restart",
    DELETE: "Delete",
    CONSOLE_LINK: "Open in provider console",
}

CAPABILITY_ORDER: Tuple[str, ...] = (
    DISCOVERY, CONFIGURATION, RAW_DATA, TAGS, ACCOUNT_COST, RESOURCE_COST,
    METRICS, MEMORY_METRICS, RELATIONSHIPS, AUDIT_EVENTS, CONFIG_HISTORY,
    TARGETED_REFRESH, CONSOLE_LINK, TAG_MUTATION, POWER_ACTIONS, DELETE,
)

# Reasons are written for the person who clicked, not for us. Each says what is
# missing and, where there is one, what would fix it.
_NO_WRITE_API = (
    "This platform's {provider} adapter is read-only — it implements no write "
    "calls at all. Enabling this needs a provider action layer with its own "
    "permission checks, dependency checks and audit trail, which does not "
    "exist yet."
)


@dataclass(frozen=True)
class ProviderResourceCapabilities:
    provider: str
    supported: Dict[str, bool]
    reasons: Dict[str, str] = field(default_factory=dict)
    # Method name on the provider class that must exist for a capability to be
    # claimed. Only listed where a provider method genuinely backs it.
    backed_by: Dict[str, str] = field(default_factory=dict)

    def can(self, capability: str) -> bool:
        return bool(self.supported.get(capability, False))

    def reason(self, capability: str) -> Optional[str]:
        if self.can(capability):
            return None
        return self.reasons.get(
            capability,
            f"{CAPABILITY_LABELS.get(capability, capability)} is not available "
            f"for {self.provider}.",
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "capabilities": [
                {
                    "key": key,
                    "label": CAPABILITY_LABELS.get(key, key),
                    "supported": self.can(key),
                    "reason": self.reason(key),
                }
                for key in CAPABILITY_ORDER
            ],
        }


_COMMON_TRUE = {
    DISCOVERY: True,
    CONFIGURATION: True,
    RAW_DATA: True,
    TAGS: True,
    ACCOUNT_COST: True,
    METRICS: True,
    RELATIONSHIPS: True,
    CONFIG_HISTORY: True,
    TARGETED_REFRESH: True,
    CONSOLE_LINK: True,
    # No provider adapter here implements a write. See the module docstring.
    TAG_MUTATION: False,
    POWER_ACTIONS: False,
    DELETE: False,
}

_REGISTRY: Dict[str, ProviderResourceCapabilities] = {
    "AWS": ProviderResourceCapabilities(
        provider="AWS",
        supported={
            **_COMMON_TRUE,
            # The one that must not drift. Cost Explorer groups by service,
            # usage type, region — never by resource.
            RESOURCE_COST: False,
            MEMORY_METRICS: False,
            AUDIT_EVENTS: True,
        },
        reasons={
            RESOURCE_COST: (
                "AWS Cost Explorer has no per-resource dimension, so the cost "
                "of an individual EC2 instance or volume cannot be read from "
                "it. That needs a Cost and Usage Report delivered to S3 and "
                "queried through Athena, which is not configured. AWS costs "
                "are real and correct at the service level."
            ),
            MEMORY_METRICS: (
                "CloudWatch does not collect memory from EC2 instances without "
                "the CloudWatch agent installed on the guest. Memory is "
                "genuinely unavailable, not merely unqueried."
            ),
            TAG_MUTATION: _NO_WRITE_API.format(provider="AWS"),
            POWER_ACTIONS: _NO_WRITE_API.format(provider="AWS"),
            DELETE: _NO_WRITE_API.format(provider="AWS"),
        },
        backed_by={
            DISCOVERY: "scan_resources",
            CONFIGURATION: "get_resource_details",
            ACCOUNT_COST: "get_cost_data",
            TARGETED_REFRESH: "get_resource_details",
        },
    ),
    "AZURE": ProviderResourceCapabilities(
        provider="AZURE",
        supported={
            **_COMMON_TRUE,
            RESOURCE_COST: True,
            MEMORY_METRICS: True,
            AUDIT_EVENTS: True,
        },
        reasons={
            TAG_MUTATION: _NO_WRITE_API.format(provider="Azure"),
            POWER_ACTIONS: _NO_WRITE_API.format(provider="Azure"),
            DELETE: _NO_WRITE_API.format(provider="Azure"),
        },
        backed_by={
            DISCOVERY: "scan_resources",
            CONFIGURATION: "get_resource_details",
            ACCOUNT_COST: "get_cost_data",
            RESOURCE_COST: "get_cost_by_resource",
            TARGETED_REFRESH: "get_resource_details",
        },
    ),
    "OCI": ProviderResourceCapabilities(
        provider="OCI",
        supported={
            **_COMMON_TRUE,
            RESOURCE_COST: True,
            MEMORY_METRICS: True,
            AUDIT_EVENTS: True,
        },
        reasons={
            TAG_MUTATION: _NO_WRITE_API.format(provider="OCI"),
            POWER_ACTIONS: _NO_WRITE_API.format(provider="OCI"),
            DELETE: _NO_WRITE_API.format(provider="OCI"),
        },
        backed_by={
            DISCOVERY: "scan_resources",
            CONFIGURATION: "get_resource_details",
            ACCOUNT_COST: "get_cost_data",
            RESOURCE_COST: "get_cost_by_resource",
            TARGETED_REFRESH: "get_resource_details",
        },
    ),
}

_UNKNOWN = ProviderResourceCapabilities(
    provider="UNKNOWN",
    supported={key: False for key in CAPABILITY_ORDER},
    reasons={
        key: "This provider is not recognized by the platform, so nothing can "
             "be claimed about what it supports."
        for key in CAPABILITY_ORDER
    },
)


def for_provider(provider: Optional[str]) -> ProviderResourceCapabilities:
    return _REGISTRY.get((provider or "").strip().upper(), _UNKNOWN)


def intersect(providers: List[str]) -> Dict[str, bool]:
    """What holds for EVERY provider in a mixed scope.

    A cross-account view that offers per-resource cost sorting because one of
    its three providers supports it produces a table silently missing a third
    of the estate. The intersection is the only honest answer for a control
    that applies to the whole scope.
    """
    caps = [for_provider(p) for p in providers if p]
    if not caps:
        return {key: False for key in CAPABILITY_ORDER}
    return {key: all(c.can(key) for c in caps) for key in CAPABILITY_ORDER}


def unsupported_in_scope(providers: List[str], capability: str) -> List[Dict[str, str]]:
    """Which providers in scope cannot answer this, and why — so a partial
    answer can name what it is missing instead of quietly omitting it."""
    out: List[Dict[str, str]] = []
    for provider in sorted({(p or "").strip().upper() for p in providers if p}):
        caps = for_provider(provider)
        if not caps.can(capability):
            out.append({"provider": provider, "reason": caps.reason(capability) or ""})
    return out


def scope_summary(providers: List[str]) -> Dict[str, Any]:
    """The whole matrix for a scope: per provider, plus the intersection."""
    normalized = sorted({(p or "").strip().upper() for p in providers if p})
    shared = intersect(normalized)
    return {
        "providers": [for_provider(p).as_dict() for p in normalized],
        "shared": [
            {
                "key": key,
                "label": CAPABILITY_LABELS.get(key, key),
                "supported": shared.get(key, False),
                "blocked_by": unsupported_in_scope(normalized, key),
            }
            for key in CAPABILITY_ORDER
        ],
    }


# ── Self-check ───────────────────────────────────────────────────────────────
_PROVIDER_CLASSES = {
    "AWS": ("app.providers.aws.aws_provider", "AWSProvider"),
    "AZURE": ("app.providers.azure.azure_provider", "AzureProvider"),
    "OCI": ("app.providers.oci.oci_provider", "OCIProvider"),
}

# Method-name prefixes that would indicate a write path. If one of these ever
# appears on a provider class, the mutating capabilities above are stale and
# the check says so — it is much easier to add a capability than to notice a
# missing one.
_WRITE_PREFIXES = ("start_", "stop_", "restart_", "delete_", "terminate_",
                   "tag_", "untag_", "set_tags", "update_tags", "attach_",
                   "detach_", "create_", "modify_")


def verify_against_implementation() -> List[str]:
    """Every disagreement between this registry and the real provider classes.

    Returns a list of human-readable problems; empty means consistent.
    """
    problems: List[str] = []
    for provider, (module_path, class_name) in _PROVIDER_CLASSES.items():
        caps = _REGISTRY[provider]
        try:
            module = __import__(module_path, fromlist=[class_name])
            cls = getattr(module, class_name)
        except Exception as exc:  # pragma: no cover - import environment issue
            problems.append(f"{provider}: could not import {class_name}: {exc}")
            continue

        members = {
            name for name, _ in inspect.getmembers(cls)
            if not name.startswith("__")
        }

        for capability, method in caps.backed_by.items():
            if not caps.can(capability):
                continue
            if method not in members:
                problems.append(
                    f"{provider}: claims {capability} but {class_name} has no "
                    f"{method}()"
                )

        # A capability claimed with no backing method at all is not necessarily
        # wrong (relationships come from the topology engine, not the
        # provider), so only the mutating ones are policed in the other
        # direction — those are the ones where a false True is dangerous.
        writes = sorted(
            name for name in members
            if any(name.startswith(prefix) for prefix in _WRITE_PREFIXES)
        )
        for capability in (TAG_MUTATION, POWER_ACTIONS, DELETE):
            if caps.can(capability):
                problems.append(
                    f"{provider}: claims {capability}, but no action layer "
                    f"exists to execute, authorize or audit it"
                )
        if writes:
            problems.append(
                f"{provider}: {class_name} now exposes write methods {writes}; "
                f"the mutating capabilities in resource_capabilities.py are "
                f"stale and must be revisited"
            )
    return problems
