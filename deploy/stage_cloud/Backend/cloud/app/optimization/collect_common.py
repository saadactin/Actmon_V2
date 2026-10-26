"""Shapes shared by the three telemetry collectors. Pure — no I/O.

A collector works in two steps, and the split is what makes it testable:

1. **Plan** (pure): for each resource, which metrics to ask for, from which
   namespace, with which provider statistic. A resource type the provider
   cannot report a metric for gets a `not_collected` entry WITH the reason
   ("memory is published by the CloudWatch agent, which is not installed"),
   so an empty chart always has a sentence behind it.
2. **Fetch** (I/O): execute the plans in whatever batching shape the provider
   API rewards, and return one `RawMetric` per (resource, metric) — datapoints
   plus the real outcome of the query.

Nothing here invents a value. A query that returned nothing is NO_DATA; a
query the credentials may not run is DENIED; neither is ever turned into 0.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.optimization.telemetry import (
    ST_DENIED, ST_ERROR, ST_NO_DATA, ST_NOT_COLLECTED, ST_OK,
)

HOUR = 3600
DAY = 86400
WINDOW_DAYS = 30

Point = Tuple[datetime, float]


@dataclass
class MetricPlan:
    """One metric to request for one resource."""

    metric: str                       # canonical key in telemetry.METRICS
    source: str                       # human label: API · namespace · name (statistic)
    namespace: Optional[str] = None
    name: Optional[str] = None        # the provider's metric name
    stat: Optional[str] = None        # AWS Statistic / Azure aggregation / OCI MQL function
    peak_stat: Optional[str] = None   # the per-period Maximum, when the provider offers one
    dims: Optional[List[Dict[str, str]]] = None
    granularity: int = HOUR
    # Multiply every value — e.g. Azure reports disk ops per SECOND averaged
    # over the hour; x3600 makes it ops per hour like every other counter.
    scale: float = 1.0
    # How several streams for one resource combine (OCI splits a load
    # balancer by listener and a DB system by node).
    combine: str = "mean"             # mean | sum | max
    match_value: Optional[str] = None
    match_keys: Tuple[str, ...] = ("resourceId", "resourceID")
    derive: Optional[str] = None      # "memory_from_available" (Azure)


@dataclass
class ResourcePlan:
    resource: Any
    region: Optional[str]
    metrics: List[MetricPlan] = field(default_factory=list)
    # metric -> why it is not requested. Written as NOT_COLLECTED rows so the
    # UI can say "not published because…" instead of showing an empty chart.
    not_collected: Dict[str, str] = field(default_factory=dict)
    # metric -> why it was deliberately not queried this time (a stopped VM
    # publishes no utilization). Written as SKIPPED, never as zero.
    skipped: Dict[str, str] = field(default_factory=dict)
    # Facts learned while collecting that the rules need, e.g. an Azure VM
    # size's vCPU and memory from the Resource SKUs API.
    facts: Dict[str, Any] = field(default_factory=dict)

    @property
    def resource_id(self) -> str:
        return str(self.resource.id)


@dataclass
class RawMetric:
    status: str
    points: List[Point] = field(default_factory=list)
    peaks: Optional[List[Point]] = None
    reason: Optional[str] = None
    source: Optional[str] = None
    granularity: int = HOUR


def ok_or_no_data(points: Sequence[Point], *, source: str, peaks=None,
                  granularity: int = HOUR, empty_reason: Optional[str] = None) -> RawMetric:
    if points:
        return RawMetric(ST_OK, list(points), list(peaks) if peaks else None,
                         source=source, granularity=granularity)
    return RawMetric(ST_NO_DATA, [], None, source=source, granularity=granularity,
                     reason=empty_reason or "The monitoring API accepted the query and "
                                            "returned no datapoints for the last 30 days.")


# Provider error text → collection status. Kept to phrases each provider
# actually returns, observed on the live accounts: AWS "AccessDenied" /
# "not authorized", Azure "AuthorizationFailed", OCI "NotAuthorizedOrNotFound".
_DENIED = re.compile(
    r"accessdenied|not authorized|unauthorizedoperation|authorizationfailed|"
    r"notauthorizedornotfound|forbidden|\b403\b", re.IGNORECASE)


def classify_error(exc: BaseException) -> Tuple[str, str]:
    text = f"{type(exc).__name__}: {exc}"
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if status in (401, 403) or _DENIED.search(text):
        return ST_DENIED, _short(text)
    return ST_ERROR, _short(text)


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def is_transient(exc: BaseException) -> bool:
    """Worth retrying: throttling, 5xx, and dropped connections.

    The last matters on this network specifically — the OCI telemetry endpoint
    reset connections on roughly half the calls during the live probe, and a
    single failed attempt must not blank a metric for a whole month.
    """
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if status in (429, 500, 502, 503, 504):
        return True
    text = f"{type(exc).__name__} {exc}".lower()
    return any(k in text for k in (
        "throttl", "rate exceeded", "too many requests", "timed out", "timeout",
        "connection", "max retries exceeded", "reset by peer", "temporarily",
        "serviceunavailable", "internalerror", "bad gateway",
    ))


def not_collected(reason: str, source: Optional[str] = None) -> RawMetric:
    return RawMetric(ST_NOT_COLLECTED, [], None, reason=reason, source=source)


def denied_or_error(exc: BaseException, source: Optional[str]) -> RawMetric:
    status, text = classify_error(exc)
    return RawMetric(status, [], None, reason=text, source=source)


def combine_streams(streams: Sequence[Sequence[Point]], how: str) -> List[Point]:
    """Combine several streams for one resource into one series.

    `sum` for counters split across listeners or attachments; `max` for "the
    busiest node"; `mean` for a utilization reported per node.
    """
    buckets: Dict[datetime, List[float]] = {}
    for stream in streams:
        for ts, v in stream:
            if v is None:
                continue
            buckets.setdefault(ts, []).append(float(v))
    out: List[Point] = []
    for ts in sorted(buckets):
        vs = buckets[ts]
        if how == "sum":
            val = sum(vs)
        elif how == "max":
            val = max(vs)
        else:
            val = sum(vs) / len(vs)
        out.append((ts, round(val, 6)))
    return out
