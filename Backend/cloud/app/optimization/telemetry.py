"""Telemetry vocabulary and statistics. Pure — no I/O.

Every number a rightsizing or idle rule reads comes through `summarize()`, and
`summarize()` only ever sees datapoints a provider's monitoring API returned.
Three rules keep it honest:

* **Gaps are not zeros.** An hour with no datapoint is absent from the series,
  not recorded as 0%. A VM stopped for a week has a week of missing hours, and
  its coverage says so; averaging zeros into it would make a busy VM look idle.
* **A peak is only a peak if something measured it.** CloudWatch, Azure Monitor
  and OCI can all return a per-hour Maximum. When that series was collected,
  `peak` is its maximum. When it was not, `peak` stays None and `max` is
  labelled what it is — the highest hourly AVERAGE — because the highest
  average understates a real spike, sometimes badly.
* **Percentiles are over what was observed.** P95 of 214 hourly samples says
  nothing about the 506 hours the instance was not running. `samples`,
  `expected_samples` and `coverage_pct` travel with every figure so a rule can
  refuse to conclude from too little.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

GAUGE = "gauge"      # a level: CPU %, memory %, bytes stored, open connections
COUNTER = "counter"  # an amount per period: invocations, bytes moved, I/O ops

# Collection outcome for one metric of one resource.
ST_OK = "OK"                        # datapoints returned
ST_NO_DATA = "NO_DATA"              # the query succeeded and returned nothing
ST_DENIED = "DENIED"                # the credentials may not read this metric
ST_ERROR = "ERROR"                  # the provider failed the query
ST_NOT_COLLECTED = "NOT_COLLECTED"  # nothing publishes it (agent absent) or no mapping
ST_SKIPPED = "SKIPPED"              # not queried on purpose (e.g. the resource is stopped)
STATUSES = (ST_OK, ST_NO_DATA, ST_DENIED, ST_ERROR, ST_NOT_COLLECTED, ST_SKIPPED)

STATUS_LABEL = {
    ST_OK: "Collected",
    ST_NO_DATA: "No datapoints returned",
    ST_DENIED: "Not permitted",
    ST_ERROR: "Provider error",
    ST_NOT_COLLECTED: "Not published",
    ST_SKIPPED: "Not queried",
}


@dataclass(frozen=True)
class MetricDef:
    key: str
    label: str
    unit: str        # percent | bytes | count | ops | ms
    kind: str        # GAUGE | COUNTER
    description: str


METRICS: Dict[str, MetricDef] = {m.key: m for m in (
    MetricDef("cpu_percent", "CPU utilization", "percent", GAUGE,
              "Share of provisioned vCPU/OCPU capacity in use, averaged per hour."),
    MetricDef("memory_percent", "Memory utilization", "percent", GAUGE,
              "Share of provisioned memory in use, averaged per hour."),
    MetricDef("network_in", "Network in", "bytes", COUNTER,
              "Bytes received per hour across all interfaces."),
    MetricDef("network_out", "Network out", "bytes", COUNTER,
              "Bytes sent per hour across all interfaces."),
    MetricDef("disk_read_ops", "Disk read operations", "ops", COUNTER,
              "Read operations per hour."),
    MetricDef("disk_write_ops", "Disk write operations", "ops", COUNTER,
              "Write operations per hour."),
    MetricDef("invocations", "Invocations", "count", COUNTER,
              "Function invocations per hour."),
    MetricDef("errors", "Errors", "count", COUNTER,
              "Invocations that ended in an error, per hour."),
    MetricDef("throttles", "Throttles", "count", COUNTER,
              "Invocation requests refused for concurrency, per hour."),
    MetricDef("duration_ms", "Duration", "ms", GAUGE,
              "Execution time per invocation, averaged per hour."),
    MetricDef("connections", "Connections", "count", GAUGE,
              "Database connections or sessions."),
    MetricDef("storage_percent", "Storage utilization", "percent", GAUGE,
              "Share of provisioned storage in use."),
    MetricDef("dtu_percent", "DTU utilization", "percent", GAUGE,
              "Share of the database's DTU allowance in use."),
    MetricDef("lb_connections", "Accepted connections", "count", COUNTER,
              "Connections accepted by the load balancer, per hour."),
    MetricDef("lb_bytes_in", "Bytes received", "bytes", COUNTER,
              "Bytes received by the load balancer, per hour."),
    MetricDef("lb_requests", "Requests", "count", COUNTER,
              "Requests handled by the load balancer, per hour."),
    MetricDef("stored_bytes", "Stored data", "bytes", GAUGE,
              "Bytes stored, as reported by the storage service."),
    MetricDef("object_count", "Objects", "count", GAUGE,
              "Number of stored objects."),
    MetricDef("requests", "Requests", "count", COUNTER,
              "Requests served by the storage service, per period."),
    MetricDef("volume_read_ops", "Volume read operations", "ops", COUNTER,
              "Read operations against the volume, per hour."),
    MetricDef("volume_write_ops", "Volume write operations", "ops", COUNTER,
              "Write operations against the volume, per hour."),
    MetricDef("nat_bytes", "NAT gateway traffic", "bytes", COUNTER,
              "Bytes processed by the NAT gateway, per hour."),
    MetricDef("transactions", "Transactions", "count", COUNTER,
              "Storage transactions per hour."),
    MetricDef("connections_opened", "Successful connections", "count", COUNTER,
              "Connections opened to the database, per hour."),
    MetricDef("consumed_rcu", "Consumed read capacity", "count", COUNTER,
              "Read capacity units consumed per hour."),
    MetricDef("consumed_wcu", "Consumed write capacity", "count", COUNTER,
              "Write capacity units consumed per hour."),
    MetricDef("uncommitted_parts", "Incomplete multipart upload size", "bytes", GAUGE,
              "The size of multipart-upload parts never committed or aborted (OCI's "
              "UncommittedParts, in bytes). They are stored — and billed — until removed."),
    MetricDef("lifecycle_enabled", "Lifecycle policy enabled", "count", GAUGE,
              "1 when an object lifecycle policy is enabled on the bucket, 0 when not, "
              "as reported by the storage service itself."),
)}


def _pct(sorted_values: Sequence[float], p: float) -> Optional[float]:
    """Linear-interpolated percentile (the same definition numpy uses by
    default), so a published P95 can be reproduced from the series."""
    n = len(sorted_values)
    if n == 0:
        return None
    if n == 1:
        return float(sorted_values[0])
    k = (n - 1) * p
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return float(sorted_values[int(k)])
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo))


def _aware(ts: datetime) -> datetime:
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def clean_points(points: Iterable[Tuple[datetime, Any]]) -> List[Tuple[datetime, float]]:
    """Drop None/NaN, normalise to UTC, and keep one value per timestamp.

    Providers occasionally repeat a timestamp across pages; keeping both would
    double-count that hour in every average and total.
    """
    by_ts: Dict[datetime, float] = {}
    for ts, value in points:
        if ts is None or value is None:
            continue
        try:
            v = float(value)
        except (TypeError, ValueError):
            continue
        if math.isnan(v) or math.isinf(v):
            continue
        by_ts[_aware(ts).astimezone(timezone.utc)] = v
    return sorted(by_ts.items(), key=lambda kv: kv[0])


def summarize(
    metric_key: str,
    points: Iterable[Tuple[datetime, Any]],
    *,
    window_start: datetime,
    window_end: datetime,
    granularity_seconds: int = 3600,
    peaks: Optional[Iterable[Tuple[datetime, Any]]] = None,
) -> Dict[str, Any]:
    """Statistics over the datapoints a provider returned for one metric.

    `peaks` is the per-period Maximum series when the provider was asked for
    it. Returns a JSON-ready dict; with no datapoints every statistic is None
    and `samples` is 0 — never a row of zeros.
    """
    meta = METRICS.get(metric_key)
    kind = meta.kind if meta else GAUGE
    series = clean_points(points)
    peak_series = clean_points(peaks) if peaks is not None else []
    window_hours = max(0.0, (_aware(window_end) - _aware(window_start)).total_seconds())
    expected = int(window_hours // granularity_seconds) if granularity_seconds else 0

    out: Dict[str, Any] = {
        "metric": metric_key,
        "unit": meta.unit if meta else None,
        "kind": kind,
        "granularity_seconds": granularity_seconds,
        "window_start": _aware(window_start).isoformat(),
        "window_end": _aware(window_end).isoformat(),
        "samples": len(series),
        "expected_samples": expected,
        "coverage_pct": (round(100.0 * min(len(series), expected) / expected, 1)
                         if expected else None),
        "observed_days": round(len(series) * granularity_seconds / 86400.0, 1),
        "first_at": series[0][0].isoformat() if series else None,
        "last_at": series[-1][0].isoformat() if series else None,
        "avg": None, "min": None, "max": None, "p50": None, "p95": None, "p99": None,
        "peak": None,
        # Says which of the two a reader is looking at. "Peak 41%" from a
        # Maximum statistic and "highest hourly average 41%" are different
        # claims, and only the first is a peak.
        "peak_source": None,
        "total": None,
        "active_periods": None,
        "daily": [],
    }
    if not series:
        return out

    values = [v for _, v in series]
    ordered = sorted(values)
    out["avg"] = round(sum(values) / len(values), 4)
    out["min"] = round(ordered[0], 4)
    out["max"] = round(ordered[-1], 4)
    out["p50"] = _round(_pct(ordered, 0.50))
    out["p95"] = _round(_pct(ordered, 0.95))
    out["p99"] = _round(_pct(ordered, 0.99))
    if peak_series:
        out["peak"] = round(max(v for _, v in peak_series), 4)
        out["peak_source"] = "maximum"
    else:
        out["peak"] = out["max"]
        out["peak_source"] = "highest_period_average"
    if kind == COUNTER:
        out["total"] = round(sum(values), 4)
        out["active_periods"] = sum(1 for v in values if v > 0)

    # Daily rollup for the evidence charts: one point per UTC day, carrying the
    # sample count so a half-observed day is visibly half-observed.
    peak_by_day: Dict[str, float] = {}
    for ts, v in peak_series:
        d = ts.date().isoformat()
        peak_by_day[d] = max(peak_by_day.get(d, v), v)
    days: Dict[str, List[float]] = {}
    for ts, v in series:
        days.setdefault(ts.date().isoformat(), []).append(v)
    daily = []
    for d in sorted(days):
        vs = days[d]
        entry = {
            "date": d,
            "avg": round(sum(vs) / len(vs), 4),
            "max": round(max(vs), 4),
            "samples": len(vs),
        }
        if d in peak_by_day:
            entry["peak"] = round(peak_by_day[d], 4)
        if kind == COUNTER:
            entry["total"] = round(sum(vs), 4)
        daily.append(entry)
    out["daily"] = daily
    return out


def _round(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(v, 4)


def derive_percent_used(available_points: Iterable[Tuple[datetime, Any]],
                        capacity_bytes: Optional[float]) -> List[Tuple[datetime, float]]:
    """Memory used %, from an "available bytes" series and the real capacity.

    Azure publishes available memory, not used memory. The capacity comes from
    the Resource SKUs API for the VM's size — not from a table here. With no
    capacity there is no percentage: the caller gets an empty series and the
    metric reports NOT_COLLECTED with that reason.
    """
    if not capacity_bytes or capacity_bytes <= 0:
        return []
    out = []
    for ts, avail in clean_points(available_points):
        used = 100.0 * (1.0 - (avail / capacity_bytes))
        # A reading above capacity (a size change mid-window, rounding in the
        # provider's aggregation) would otherwise produce a negative "used".
        out.append((ts, round(min(100.0, max(0.0, used)), 4)))
    return out


# ── The object a rule reads ──────────────────────────────────────────────────

@dataclass
class MetricResult:
    metric: str
    status: str
    stats: Optional[Dict[str, Any]] = None
    source: Optional[str] = None
    reason: Optional[str] = None
    collected_at: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.status == ST_OK and bool(self.stats) and (self.stats.get("samples") or 0) > 0

    def get(self, stat: str) -> Optional[float]:
        if not self.ok:
            return None
        return self.stats.get(stat)

    def to_dict(self) -> Dict[str, Any]:
        return {"metric": self.metric, "status": self.status, "status_label":
                STATUS_LABEL.get(self.status, self.status), "stats": self.stats,
                "source": self.source, "reason": self.reason,
                "collected_at": self.collected_at}


@dataclass
class ResourceTelemetry:
    """Everything collected for one resource, keyed by metric."""

    metrics: Dict[str, MetricResult] = field(default_factory=dict)
    collected_at: Optional[str] = None

    def result(self, key: str) -> MetricResult:
        return self.metrics.get(key) or MetricResult(
            metric=key, status=ST_NOT_COLLECTED,
            reason="No telemetry has been collected for this metric yet.")

    def ok(self, key: str) -> bool:
        return self.result(key).ok

    def stat(self, key: str, stat: str) -> Optional[float]:
        return self.result(key).get(stat)

    def reason(self, key: str) -> str:
        r = self.result(key)
        if r.ok:
            return ""
        return r.reason or STATUS_LABEL.get(r.status, r.status)


# ── Display helpers (used in evidence strings, never in arithmetic) ──────────

def human_bytes(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    v = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if abs(v) < 1024.0 or unit == "PB":
            return f"{v:,.1f} {unit}" if unit != "B" else f"{v:,.0f} B"
        v /= 1024.0
    return None


def display(value: Optional[float], unit: Optional[str]) -> str:
    """A value for a sentence. None is 'N/A', never 0."""
    if value is None:
        return "N/A"
    if unit == "percent":
        return f"{value:.1f}%"
    if unit == "bytes":
        return human_bytes(value) or "N/A"
    if unit == "ms":
        return f"{value:,.0f} ms"
    if unit in ("count", "ops"):
        return f"{value:,.0f}" if float(value).is_integer() or abs(value) >= 100 else f"{value:,.2f}"
    return f"{value:,.2f}"
