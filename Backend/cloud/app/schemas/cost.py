"""Pydantic schemas for Cost data.

Beyond the wire shapes, this module defines the vocabulary the whole Cost
feature answers in. Three enums carry most of the weight:

``CostSourceKind``  -- where a number came from. A figure derived from a public
    price list is not spend, and must never be presented as though it were.
``DataStatus``      -- how complete an answer is. "partial" presented as
    "complete" is the single most damaging thing a cost tool can do, because
    the number looks authoritative and is wrong low.
``ErrorCategory``   -- mirrors ``app.services.cost_errors``, so the API contract
    and the classifier cannot drift apart.

The NA rule, stated once: an ``Optional[float]`` that is ``None`` means the
value is unavailable and MUST render as NA. It is never coerced to 0, and 0
means the provider reported a real zero. Every optional money field below
inherits that meaning.
"""
from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── Vocabulary ────────────────────────────────────────────────────────────────

class CostSourceKind(str, Enum):
    """Where a monetary figure came from. Displayed next to the number."""

    #: Actual billed spend from the provider's billing API.
    PROVIDER_BILLING = "provider_billing"
    #: A public list price (e.g. OCI Price List API). NOT spend.
    PROVIDER_PRICE_LIST = "provider_price_list"
    #: The provider's own estimate/forecast endpoint.
    PROVIDER_ESTIMATE = "provider_estimate"
    #: Derived by this product from one of the above (e.g. a run-rate
    #: projection). The calculation must be disclosed alongside it.
    CALCULATED = "calculated"
    #: A figure exists but its origin could not be established.
    UNKNOWN = "unknown"
    #: No figure exists. Renders as NA with a reason.
    NOT_AVAILABLE = "not_available"


class DataStatus(str, Enum):
    """How complete an answer is. Never report PARTIAL as COMPLETE."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    FAILED = "failed"
    PERMISSION_DENIED = "permission_denied"
    RATE_LIMITED = "rate_limited"
    NOT_SUPPORTED = "not_supported"
    #: The query succeeded and the provider genuinely has no records.
    NO_DATA = "no_data"


class ErrorCategory(str, Enum):
    """Mirrors app.services.cost_errors.CATEGORIES."""

    CREDENTIALS = "credentials"
    PERMISSION = "permission"
    RATE_LIMITED = "rate_limited"
    NETWORK = "network"
    TIMEOUT = "timeout"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    UNSUPPORTED = "unsupported"
    INVALID_REQUEST = "invalid_request"
    PARTIAL = "partial"
    UNKNOWN = "unknown"


class DataQuality(str, Enum):
    """The page-level badge. Clicking it opens diagnostics."""

    GOOD = "good"
    PARTIAL = "partial"
    LIMITED = "limited"
    UNAVAILABLE = "unavailable"


# ── Supporting shapes ─────────────────────────────────────────────────────────

class Period(BaseModel):
    """The window a figure covers, with the timezone it is expressed in."""

    start: str                      # ISO date, inclusive
    end: str                        # ISO date, exclusive
    days: int
    timezone: str = "UTC"


class Provenance(BaseModel):
    """Where a number came from, so the UI can show it under the figure."""

    source: CostSourceKind
    #: The specific API, named as a person would recognize it, e.g.
    #: "OCI Usage API", "AWS Cost Explorer", "Azure Cost Management".
    provider_api: Optional[str] = None
    currency: Optional[str] = None
    period: Optional[Period] = None
    retrieved_at: Optional[datetime] = None
    #: True when served from cache rather than a fresh provider call.
    cached: bool = False
    #: Age of the cached value, so the UI can say "15 minutes ago".
    age_seconds: Optional[int] = None
    #: For price-list and calculated figures: the assumptions behind them.
    assumptions: List[str] = Field(default_factory=list)


class Completeness(BaseModel):
    """Whether an answer is whole, and what is missing when it is not."""

    status: DataStatus
    reason: Optional[str] = None
    #: Sub-windows or scopes that returned data, and those that did not.
    covered: List[str] = Field(default_factory=list)
    missing: List[str] = Field(default_factory=list)
    #: When the last fully-successful refresh happened.
    last_good_at: Optional[datetime] = None

    @property
    def is_trustworthy_as_total(self) -> bool:
        """Whether this answer may be presented as a definitive total."""
        return self.status in (DataStatus.COMPLETE, DataStatus.NO_DATA)


class Freshness(BaseModel):
    """Per-dataset timestamps. These are NOT synchronized, and pretending they
    are is a lie -- inventory is scanned on one schedule and billing on
    another, so each carries its own age."""

    billing_updated_at: Optional[datetime] = None
    inventory_updated_at: Optional[datetime] = None
    resource_cost_updated_at: Optional[datetime] = None
    price_list_updated_at: Optional[datetime] = None


class CostErrorDetail(BaseModel):
    category: ErrorCategory
    message: str
    retry_after_seconds: Optional[int] = None
    http_status: Optional[int] = None
    provider: Optional[str] = None
    terminal: bool = False
    retryable: bool = False
    #: The provider-native permission to grant, when category == permission.
    required_permission: Optional[str] = None


class CurrencyBreakdown(BaseModel):
    """A total that may span currencies. ``amount`` is None when mixed --
    different currencies are never added together."""

    amount: Optional[float] = None
    currency: Optional[str] = None
    by_currency: Dict[str, float] = Field(default_factory=dict)
    currencies: List[str] = Field(default_factory=list)
    mixed: bool = False
    na_reason: Optional[str] = None


class ProviderCapabilities(BaseModel):
    """What a provider's billing integration can answer. Drives which UI
    controls are enabled, and what the tooltip on a disabled one says."""

    provider: str
    service: bool
    region: bool
    resource: bool
    daily_trend: bool
    daily_service: bool
    daily_region: bool
    usage_type: bool
    tags: bool
    forecast_api: bool
    budget_api: bool
    max_lookback_days: int
    window_split_days: Optional[int] = None
    native_resource_id: Optional[str] = None
    rate_limit_sensitive: bool = False
    unsupported_reasons: Dict[str, str] = Field(default_factory=dict)


# ── The normalized cost record ────────────────────────────────────────────────

class CostRecord(BaseModel):
    """One normalized billing fact, whatever provider it came from.

    Provider adapters convert their native billing responses into this shape.
    Provider-specific dimensions are deliberately NOT flattened into columns --
    they live in ``dimensions`` so AWS usage types, Azure meters and OCI SKUs
    can all be preserved without corrupting the common model or inventing
    fields the other two providers cannot fill.
    """

    provider: str
    account_id: str
    billing_date: Optional[str] = None      # ISO date; None for whole-window rows

    service: Optional[str] = None
    region: Optional[str] = None

    resource_id: Optional[str] = None       # provider-native: ARN / ARM ID / OCID
    resource_name: Optional[str] = None
    resource_type: Optional[str] = None

    amount: Optional[float] = None          # None = NA, never 0
    currency: Optional[str] = None

    cost_component: Optional[str] = None    # Compute/Database/Storage/Network/Other
    usage_type: Optional[str] = None

    #: True when this billing row was matched to a row in our inventory.
    #: False means billed-but-unmatched, which stays visible rather than
    #: being dropped -- unattributed spend is still spend.
    in_inventory: bool = False

    source: CostSourceKind = CostSourceKind.PROVIDER_BILLING
    retrieved_at: Optional[datetime] = None

    #: Provider-native dimensions, preserved verbatim.
    dimensions: Dict[str, Any] = Field(default_factory=dict)


# ── The response envelope ─────────────────────────────────────────────────────

class CostEnvelope(BaseModel):
    """The consistent wrapper every Cost endpoint answers in.

    The payload alone is never enough: a caller must be able to tell a complete
    answer from a partial one, a real zero from an unavailable value, and fresh
    data from a cached fallback, without reading the numbers and guessing.
    """

    status: DataStatus
    data: Any = None

    provenance: Optional[Provenance] = None
    completeness: Optional[Completeness] = None
    freshness: Optional[Freshness] = None
    totals: Optional[CurrencyBreakdown] = None

    #: Populated for every account in scope that failed, so one broken account
    #: in an ALL view cannot be silently absorbed into a lower total.
    errors: List[CostErrorDetail] = Field(default_factory=list)

    #: Capabilities of the providers in scope, so the UI can disable controls
    #: rather than render an unanswerable question as zero.
    capabilities: Dict[str, ProviderCapabilities] = Field(default_factory=dict)

    quality: Optional[DataQuality] = None
    generated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    @property
    def succeeded_completely(self) -> bool:
        return self.status in (DataStatus.COMPLETE, DataStatus.NO_DATA) and not self.errors


# ── Existing shapes (unchanged, still used by /cloud/cost/{account_id}) ───────

class CostEntry(BaseModel):
    resource_type: str
    resource_name: str
    region: Optional[str] = None
    monthly_cost: float
    # Currency comes from the provider billing API; None means unknown (UI shows NA)
    currency: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


class CostSummaryResponse(BaseModel):
    account_id: str
    provider: Optional[str] = None
    # None means no billing data is available for this account (UI shows NA)
    total_monthly_cost: Optional[float] = None
    currency: Optional[str] = None
    cost_source: Optional[str] = None
    breakdown: List[CostEntry] = []
