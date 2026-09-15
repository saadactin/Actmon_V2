"""What each provider's billing integration can actually answer.

The point of this module is to make "we cannot answer that" a first-class,
inspectable fact instead of an empty result. Three things that look identical
to a UI rendering a bare number must never be confused:

    not supported            -- the integration cannot produce this, as built.
    temporarily unavailable  -- it normally can, but this request failed.
    genuinely zero           -- the provider billed nothing.

Only the first is described here. The second is an error category
(``app.services.cost_errors``) and the third is a real value.

**These flags describe THIS CODEBASE'S QUERIES, not the provider's API.**

That distinction is the whole reason the module is trustworthy. AWS Cost
Explorer is perfectly capable of grouping by USAGE_TYPE, and of returning a
region alongside a daily service breakdown -- but ``AWSProvider.get_cost_report``
asks for ``GroupBy=[SERVICE]`` and nothing else, so a region filter applied to
AWS daily rows would match nothing and render as a confident, wrong zero.
So ``daily_region`` is False for AWS, and ``unsupported_reasons`` says exactly
why and what would change it. A flag here flipping to True must be accompanied
by the query change that earns it -- ``verify_against_implementation()`` below
enforces the half of that which is mechanically checkable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

# Canonical provider keys. 'ORACLE' is how accounts are stored; 'OCI' is what
# people type. Both resolve to the same capabilities.
_ALIASES = {"ORACLE": "OCI", "OCI": "OCI", "AWS": "AWS", "AZURE": "AZURE"}


@dataclass(frozen=True)
class ProviderCostCapabilities:
    """One provider's answerable cost questions."""

    provider: str

    # -- Aggregate (whole-window) breakdowns ---------------------------------
    service: bool
    region: bool
    resource: bool

    # -- Daily ledger breakdowns ---------------------------------------------
    # Deliberately separate from the aggregate flags: a provider can support a
    # dimension in one query shape and not the other, and collapsing the two
    # is precisely how a filter comes back silently empty.
    daily_trend: bool
    daily_service: bool
    daily_region: bool

    # -- Dimensions we do not currently request anywhere ----------------------
    usage_type: bool
    tags: bool

    # -- Provider-native APIs not yet wired up --------------------------------
    forecast_api: bool
    budget_api: bool

    # -- Window limits --------------------------------------------------------
    # max_lookback_days is the effective limit callers get, already accounting
    # for MAX_REPORT_DAYS. window_split_days is the largest single request the
    # provider accepts, or None when no splitting is needed.
    max_lookback_days: int
    window_split_days: Optional[int]

    # The identifier billing rows carry, for resource attribution.
    native_resource_id: str

    # Whether this provider's billing API throttles hard enough that callers
    # must serialize and honour Retry-After.
    rate_limit_sensitive: bool

    # Why each False flag is False, keyed by field name. Every False flag above
    # must have an entry -- enforced by verify_against_implementation().
    unsupported_reasons: Dict[str, str] = field(default_factory=dict)

    def supports(self, dimension: str) -> bool:
        return bool(getattr(self, dimension, False))

    def reason(self, dimension: str) -> Optional[str]:
        """Why `dimension` is unavailable, or None when it is available."""
        if self.supports(dimension):
            return None
        return self.unsupported_reasons.get(
            dimension, "Not supported by this provider's billing integration."
        )

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "service": self.service,
            "region": self.region,
            "resource": self.resource,
            "daily_trend": self.daily_trend,
            "daily_service": self.daily_service,
            "daily_region": self.daily_region,
            "usage_type": self.usage_type,
            "tags": self.tags,
            "forecast_api": self.forecast_api,
            "budget_api": self.budget_api,
            "max_lookback_days": self.max_lookback_days,
            "window_split_days": self.window_split_days,
            "native_resource_id": self.native_resource_id,
            "rate_limit_sensitive": self.rate_limit_sensitive,
            "unsupported_reasons": dict(self.unsupported_reasons),
        }


AWS = ProviderCostCapabilities(
    provider="AWS",
    service=True,
    region=True,          # get_cost_data groups DIMENSION SERVICE + REGION
    resource=False,
    daily_trend=True,     # get_daily_costs, DAILY granularity, Total metric
    daily_service=True,   # get_cost_report groups DIMENSION SERVICE
    daily_region=False,
    # TRUE for AWS alone: get_cost_report groups by SERVICE *and* USAGE_TYPE,
    # so its daily rows genuinely carry a usage type ("BoxUsage:t3.micro",
    # "TimedStorage-ByteHrs"). This is the closest thing to a resource-shaped
    # dimension AWS offers without a CUR pipeline, and it is the one dimension
    # AWS has that Azure and OCI do not.
    usage_type=True,
    tags=False,
    forecast_api=False,
    budget_api=False,
    max_lookback_days=365,
    window_split_days=None,   # Cost Explorer accepts the whole range in one call
    native_resource_id="ARN",
    rate_limit_sensitive=False,
    unsupported_reasons={
        "resource": (
            "AWS resource-level cost is not available through Cost Explorer, which "
            "reports spend per service and dimension but not per resource. Attributing "
            "cost to an individual ARN requires a Cost & Usage Report (CUR) delivered "
            "to S3 and queried through Athena or an equivalent detailed-billing "
            "pipeline. No CUR pipeline is configured, so AWS resource cost is NA -- "
            "it is never inferred from inventory."
        ),
        "daily_region": (
            "The daily AWS ledger is queried with GroupBy=[SERVICE] only, so its rows "
            "carry no region. Region IS available on the 30-day aggregate breakdown. "
            "Adding REGION to the daily GroupBy would enable this, at the cost of a "
            "larger, slower Cost Explorer response."
        ),
        "tags": (
            "Cost-allocation tags must be activated in the AWS Billing console before "
            "Cost Explorer will group by them, and the current queries do not request "
            "tag dimensions."
        ),
        "forecast_api": (
            "AWS Cost Explorer offers GetCostForecast, but it is not wired up. "
            "Forecasts shown in this product are run-rate projections computed from "
            "observed daily spend, and are labelled as such."
        ),
        "budget_api": "The AWS Budgets API is not integrated.",
    },
)

AZURE = ProviderCostCapabilities(
    provider="AZURE",
    service=True,
    region=True,          # ResourceLocation grouping
    resource=True,        # get_cost_by_resource, ResourceId grouping
    daily_trend=True,
    daily_service=True,
    daily_region=True,    # get_cost_report groups ServiceName + ResourceLocation
    usage_type=False,
    tags=False,
    forecast_api=False,
    budget_api=False,
    max_lookback_days=365,
    window_split_days=None,   # split adaptively on next_link, not on a fixed span
    native_resource_id="ARM resource ID",
    rate_limit_sensitive=True,
    unsupported_reasons={
        "usage_type": (
            "Cost Management exposes a Meter dimension that would serve this, but no "
            "query in this integration requests it."
        ),
        "tags": (
            "Cost Management can group by tag, but the current queries do not, so "
            "no tag-allocated cost data exists."
        ),
        "forecast_api": (
            "Cost Management has a Forecast API; it is not wired up. Forecasts here "
            "are run-rate projections from observed daily spend."
        ),
        "budget_api": "The Azure Consumption Budgets API is not integrated.",
    },
)

OCI = ProviderCostCapabilities(
    provider="OCI",
    service=True,
    region=True,
    resource=True,        # get_cost_by_resource, resourceId grouping
    daily_trend=True,
    daily_service=True,
    daily_region=True,
    usage_type=False,
    tags=False,
    forecast_api=False,
    budget_api=False,
    max_lookback_days=365,
    # The Usage API hard-rejects a DAILY request spanning more than 93 days;
    # _summarize_usages_windowed splits at 90 for margin.
    window_split_days=90,
    native_resource_id="OCID",
    rate_limit_sensitive=False,
    unsupported_reasons={
        "usage_type": (
            "The Usage API can group by skuPartNumber / unit, but its groupBy is "
            "capped at 4 keys and the current per-resource query already spends all "
            "four on resourceId, service, region and compartmentName."
        ),
        "tags": (
            "The Usage API supports tag-based grouping, but the current queries do "
            "not request it."
        ),
        "forecast_api": (
            "OCI has no usage-forecast API in this integration. Forecasts here are "
            "run-rate projections from observed daily spend."
        ),
        "budget_api": "The OCI Budgets API is not integrated.",
    },
)

_REGISTRY: Dict[str, ProviderCostCapabilities] = {"AWS": AWS, "AZURE": AZURE, "OCI": OCI}

# Every capability field a caller may ask about, in declaration order.
DIMENSIONS: Tuple[str, ...] = (
    "service", "region", "resource",
    "daily_trend", "daily_service", "daily_region",
    "usage_type", "tags", "forecast_api", "budget_api",
)


def for_provider(provider: Optional[str]) -> Optional[ProviderCostCapabilities]:
    """Capabilities for a provider string, or None when it is unrecognized.

    None is deliberate rather than a permissive default: an unknown provider
    must not be assumed capable of anything, because that assumption renders
    as a wrong zero.
    """
    if not provider:
        return None
    return _REGISTRY.get(_ALIASES.get(str(provider).strip().upper(), ""))


def all_capabilities() -> Dict[str, dict]:
    return {name: cap.to_dict() for name, cap in _REGISTRY.items()}


def intersect(providers) -> Dict[str, bool]:
    """What is answerable across EVERY given provider at once.

    This is what a multi-provider 'ALL' view may offer: a dimension is only
    offered when every provider in scope can supply it, otherwise the combined
    result would be a silent partial. An unrecognized provider contributes
    False to everything, which is the safe direction.
    """
    caps = [for_provider(p) for p in providers]
    if not caps:
        return {d: False for d in DIMENSIONS}
    return {
        d: all(c is not None and c.supports(d) for c in caps)
        for d in DIMENSIONS
    }


def unsupported_in_scope(providers, dimension: str) -> Dict[str, str]:
    """{provider: reason} for every provider in scope that cannot answer
    `dimension`. Empty when they all can.

    This is what a mixed-provider view shows instead of hiding a control: the
    dimension stays visible, disabled, and says which cloud is holding it back.
    """
    out: Dict[str, str] = {}
    for p in providers:
        cap = for_provider(p)
        if cap is None:
            out[str(p)] = (
                f"'{p}' is not a recognized cloud provider, so its billing "
                "capabilities are unknown."
            )
        elif not cap.supports(dimension):
            out[cap.provider] = cap.reason(dimension)
    return out


def verify_against_implementation() -> Dict[str, list]:
    """Cross-check the registry against the provider classes, so a flag cannot
    silently drift from the code it describes.

    Only the mechanically checkable half is enforced: whether a provider class
    defines the method a capability depends on. Whether a method requests a
    particular GroupBy is a claim the comments carry and the tests assert.

    Returns {provider: [problem, ...]}; an empty list means consistent.
    """
    from app.providers.aws.aws_provider import AWSProvider
    from app.providers.azure.azure_provider import AzureProvider
    from app.providers.oci.oci_provider import OCIProvider

    classes = {"AWS": AWSProvider, "AZURE": AzureProvider, "OCI": OCIProvider}
    # capability field -> the provider method that must exist to back it.
    backed_by = {
        "resource": "get_cost_by_resource",
        "daily_trend": "get_daily_costs",
        "daily_service": "get_cost_report",
        "service": "get_cost_data",
    }

    problems: Dict[str, list] = {}
    for name, cap in _REGISTRY.items():
        issues = []
        cls = classes[name]
        for field_name, method in backed_by.items():
            declared = cap.supports(field_name)
            implemented = hasattr(cls, method)
            if declared and not implemented:
                issues.append(
                    f"{field_name}=True but {cls.__name__} has no {method}()"
                )
            if not declared and implemented and field_name == "resource":
                issues.append(
                    f"resource=False but {cls.__name__} implements {method}() -- "
                    "the registry is understating the integration"
                )
        # Every False flag owes an explanation, or the UI has nothing to show.
        for dim in DIMENSIONS:
            if not cap.supports(dim) and dim not in cap.unsupported_reasons:
                issues.append(f"{dim}=False but no unsupported_reasons entry")
        problems[name] = issues
    return problems
