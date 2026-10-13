"""OCI Monitoring telemetry for OCI resources.

OCI has no per-resource metric call. SummarizeMetricsData takes an MQL
expression (`CpuUtilization[1h].mean()`) and returns every matching stream in
scope, so ONE query per (region, namespace, metric, statistic), issued at the
tenancy root with `compartment_id_in_subtree`, covers every instance, database
or volume of that kind at once. On oci_test that is ~50 queries for ~200
resources, where a per-resource design would be thousands.

What the live probe established, and this module depends on:

* Streams are matched to resources client-side, by the dimension each service
  actually uses: `resourceId` for compute, DB systems, ADB (upper-cased OCID),
  load balancers, volumes and functions; `resourceDisplayName` (the bucket
  name) for Object Storage, whose `resourceID` is not the inventory's key.
* One resource can emit several streams — a DB system one per node, a load
  balancer one per listener component, a bucket one per storage tier — and
  they are combined per metric (mean for utilization, sum for counters).
* `NetworksBytesIn/Out` are CUMULATIVE counters, so `rate()` (per second) is
  asked for and scaled to bytes per hour.
* Object Storage publishes no request counts, so access frequency cannot be
  measured for OCI buckets. It does publish `UncommittedParts` (abandoned
  multipart uploads, which are billed) and `EnabledOLM` (whether a lifecycle
  policy is enabled), and those are collected.
* The telemetry endpoint reset connections on roughly half the calls during
  the probe. Every query retries with backoff, on a fresh client each time.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.optimization.collect_common import (
    DAY, HOUR, MetricPlan, RawMetric, ResourcePlan, combine_streams, denied_or_error,
    is_transient, not_collected, ok_or_no_data,
)
from app.optimization.telemetry import ST_ERROR, ST_SKIPPED

logger = logging.getLogger("cloud_svc.optimization.oci")

_REGION_CONCURRENCY = 2
_ATTEMPTS = 4


def _src(ns: str, name: str, fn: str, peak: Optional[str], granularity: int,
         extra: str = "") -> str:
    per = "1 h" if granularity == HOUR else "1 day"
    fns = f"{fn}() + {peak}()" if peak else f"{fn}()"
    return f"OCI Monitoring · {ns} {name} ({fns}, {per}){extra}"


# (metric, namespace, name, fn, peak_fn, granularity, scale, combine, match)
# `match` is "id" (the inventory's provider id) or "name" (the resource name).
_CATALOG: Dict[str, List[Tuple]] = {
    "ComputeInstance": [
        ("cpu_percent", "oci_computeagent", "CpuUtilization", "mean", "max", HOUR, 1.0, "mean", "id"),
        ("memory_percent", "oci_computeagent", "MemoryUtilization", "mean", "max", HOUR, 1.0, "mean", "id"),
        ("network_in", "oci_computeagent", "NetworksBytesIn", "rate", None, HOUR, 3600.0, "sum", "id"),
        ("network_out", "oci_computeagent", "NetworksBytesOut", "rate", None, HOUR, 3600.0, "sum", "id"),
    ],
    # Per node; mean across nodes is the system's utilization, and the peak is
    # the busiest node's busiest hour.
    "DbSystem": [
        ("cpu_percent", "oci_database_cluster", "CpuUtilization", "mean", "max", HOUR, 1.0, "mean", "id"),
        ("memory_percent", "oci_database_cluster", "MemoryUtilization", "mean", "max", HOUR, 1.0, "mean", "id"),
        # One stream per ASM disk group (DATA, RECO); the fullest one is the
        # one that runs out first.
        ("storage_percent", "oci_database_cluster", "ASMDiskgroupUtilization", "mean", "max", HOUR, 1.0, "max", "id"),
    ],
    "AutonomousDatabase": [
        ("cpu_percent", "oci_autonomous_database", "CpuUtilization", "mean", "max", HOUR, 1.0, "mean", "id"),
        ("storage_percent", "oci_autonomous_database", "StorageUtilization", "mean", "max", HOUR, 1.0, "max", "id"),
        ("connections", "oci_autonomous_database", "CurrentLogons", "mean", "max", HOUR, 1.0, "sum", "id"),
    ],
    "LoadBalancer": [
        ("lb_connections", "oci_lbaas", "AcceptedConnections", "sum", None, HOUR, 1.0, "sum", "id"),
        ("lb_bytes_in", "oci_lbaas", "BytesReceived", "sum", None, HOUR, 1.0, "sum", "id"),
        ("lb_requests", "oci_lbaas", "HttpRequests", "sum", None, HOUR, 1.0, "sum", "id"),
    ],
    "BlockVolume": [
        ("volume_read_ops", "oci_blockstore", "VolumeReadOps", "sum", None, HOUR, 1.0, "sum", "id"),
        ("volume_write_ops", "oci_blockstore", "VolumeWriteOps", "sum", None, HOUR, 1.0, "sum", "id"),
    ],
    "BootVolume": [
        ("volume_read_ops", "oci_blockstore", "VolumeReadOps", "sum", None, HOUR, 1.0, "sum", "id"),
        ("volume_write_ops", "oci_blockstore", "VolumeWriteOps", "sum", None, HOUR, 1.0, "sum", "id"),
    ],
    "ObjectStorageBucket": [
        ("stored_bytes", "oci_objectstorage", "StoredBytes", "mean", None, DAY, 1.0, "sum", "name"),
        ("object_count", "oci_objectstorage", "ObjectCount", "mean", None, DAY, 1.0, "sum", "name"),
        ("uncommitted_parts", "oci_objectstorage", "UncommittedParts", "mean", None, DAY, 1.0, "sum", "name"),
        ("lifecycle_enabled", "oci_objectstorage", "EnabledOLM", "max", None, DAY, 1.0, "max", "name"),
    ],
    "Function": [
        ("invocations", "oci_faas", "FunctionInvocationCount", "sum", None, HOUR, 1.0, "sum", "id"),
        ("duration_ms", "oci_faas", "FunctionExecutionDuration", "mean", "max", HOUR, 1.0, "mean", "id"),
    ],
}

_ID_KEYS = ("resourceId", "resourceID")
_NAME_KEYS = ("resourceDisplayName", "resourceName")


def _region(resource) -> Optional[str]:
    meta = getattr(resource, "metadata_", None) or {}
    return (meta.get("region") or "").strip() or None


def _running(resource) -> Optional[bool]:
    ns = (getattr(resource, "normalized_status", None) or "").upper()
    if ns == "RUNNING":
        return True
    if ns in ("STOPPED", "TERMINATED"):
        return False
    raw = (getattr(resource, "status", None) or "").upper()
    if raw == "RUNNING":
        return True
    if raw in ("STOPPED", "STOPPING", "TERMINATED"):
        return False
    return None


def plan(resource) -> Optional[ResourcePlan]:
    rtype = resource.resource_type
    rows = _CATALOG.get(rtype)
    region = _region(resource)
    if not rows or not region:
        return None
    p = ResourcePlan(resource=resource, region=region)
    if rtype == "ComputeInstance" and _running(resource) is False:
        p.skipped = {row[0]: "Not queried: the instance was STOPPED when telemetry was "
                             "collected, and a stopped instance publishes no utilization."
                     for row in rows}
        return p
    for metric, ns, name, fn, peak, gran, scale, combine, match in rows:
        extra = " × 3600 (bytes/s → bytes/hour)" if scale == 3600.0 else ""
        p.metrics.append(MetricPlan(
            metric=metric,
            source=_src(ns, name, fn, peak, gran, extra),
            namespace=ns, name=name, stat=fn, peak_stat=peak, granularity=gran,
            scale=scale, combine=combine,
            match_value=(resource.resource_name if match == "name"
                         else resource.provider_resource_id),
            match_keys=_NAME_KEYS if match == "name" else _ID_KEYS,
        ))
    return p


def _interval(granularity: int) -> str:
    return "1d" if granularity == DAY else "1h"


def _summarize(auth, region: str, namespace: str, query: str,
               start: datetime, end: datetime):
    """One SummarizeMetricsData at the tenancy root, retried on a fresh client."""
    import oci as oci_sdk
    from oci.monitoring.models import SummarizeMetricsDataDetails

    last: Optional[BaseException] = None
    for attempt in range(_ATTEMPTS):
        try:
            cfg = auth.get_config()
            cfg["region"] = region
            client = oci_sdk.monitoring.MonitoringClient(cfg)
            resp = client.summarize_metrics_data(
                compartment_id=auth.tenancy_ocid,
                summarize_metrics_data_details=SummarizeMetricsDataDetails(
                    namespace=namespace, query=query, start_time=start, end_time=end),
                compartment_id_in_subtree=True,
            )
            return resp.data or []
        except Exception as exc:  # noqa: BLE001
            last = exc
            if is_transient(exc) and attempt < _ATTEMPTS - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            raise
    raise last  # pragma: no cover


def parse_series(series: Sequence[Any]) -> List[Tuple[Dict[str, str], List[Tuple[datetime, float]]]]:
    """SummarizeMetricsData streams → [(dimensions, [(ts, value)])]."""
    out = []
    for s in series or []:
        dims = {str(k): str(v) for k, v in (getattr(s, "dimensions", None) or {}).items()}
        pts = [(dp.timestamp, float(dp.value))
               for dp in (getattr(s, "aggregated_datapoints", None) or [])
               if getattr(dp, "value", None) is not None and getattr(dp, "timestamp", None)]
        out.append((dims, pts))
    return out


def match_streams(streams, value: Optional[str], keys: Sequence[str]):
    target = (value or "").strip().lower()
    if not target:
        return []
    return [pts for dims, pts in streams
            if any(dims.get(k, "").strip().lower() == target for k in keys)]


def _fetch_region(auth, region: str, plans: Sequence[ResourcePlan],
                  start: datetime, end: datetime) -> Tuple[Dict[Tuple[str, str], RawMetric], int]:
    out: Dict[Tuple[str, str], RawMetric] = {}
    # Every distinct query this region needs, run once.
    wanted: Dict[Tuple[str, str, str, int], None] = {}
    for rp in plans:
        for mp in rp.metrics:
            wanted[(mp.namespace, mp.name, mp.stat, mp.granularity)] = None
            if mp.peak_stat:
                wanted[(mp.namespace, mp.name, mp.peak_stat, mp.granularity)] = None
    streams: Dict[Tuple[str, str, str, int], Any] = {}
    for ns, name, fn, gran in wanted:
        query = f"{name}[{_interval(gran)}].{fn}()"
        try:
            streams[(ns, name, fn, gran)] = parse_series(
                _summarize(auth, region, ns, query, start, end))
        except Exception as exc:  # noqa: BLE001
            logger.warning("OCI %s %s %s failed: %s", region, ns, query, str(exc)[:200])
            streams[(ns, name, fn, gran)] = exc

    for rp in plans:
        for mp in rp.metrics:
            key = (rp.resource_id, mp.metric)
            got = streams.get((mp.namespace, mp.name, mp.stat, mp.granularity))
            if isinstance(got, BaseException):
                out[key] = denied_or_error(got, mp.source)
                continue
            mine = match_streams(got or [], mp.match_value, mp.match_keys)
            values = combine_streams(mine, mp.combine)
            if mp.scale != 1.0:
                values = [(t, round(v * mp.scale, 4)) for t, v in values]
            peaks = None
            if mp.peak_stat:
                pgot = streams.get((mp.namespace, mp.name, mp.peak_stat, mp.granularity))
                if not isinstance(pgot, BaseException):
                    pmine = match_streams(pgot or [], mp.match_value, mp.match_keys)
                    peaks = combine_streams(pmine, "max") or None
            empty = None
            if mp.metric == "invocations":
                empty = ("OCI Monitoring accepted the query and holds no invocation "
                         "datapoints for this function in the last 30 days. OCI Functions "
                         "publishes invocation counts only for periods in which it ran.")
            out[key] = ok_or_no_data(values, source=mp.source, peaks=peaks,
                                     granularity=mp.granularity, empty_reason=empty)
    return out, len(wanted)


async def fetch(creds: Dict[str, Any], plans: Sequence[ResourcePlan], *,
                start: datetime, end: datetime) -> Tuple[Dict[Tuple[str, str], RawMetric], Dict[str, Any]]:
    from app.providers.oci.oci_auth import OCIAuth

    results: Dict[Tuple[str, str], RawMetric] = {}
    stats: Dict[str, Any] = {"api": "OCI Monitoring SummarizeMetricsData", "queries": 0,
                             "regions": []}
    by_region: Dict[str, List[ResourcePlan]] = {}
    for rp in plans:
        for metric, reason in rp.skipped.items():
            results[(rp.resource_id, metric)] = RawMetric(ST_SKIPPED, reason=reason)
        for metric, reason in rp.not_collected.items():
            results[(rp.resource_id, metric)] = not_collected(reason)
        if rp.metrics:
            by_region.setdefault(rp.region, []).append(rp)
    if not by_region:
        return results, stats
    try:
        auth = OCIAuth(creds)
    except Exception as exc:  # noqa: BLE001
        for rps in by_region.values():
            for rp in rps:
                for mp in rp.metrics:
                    results[(rp.resource_id, mp.metric)] = RawMetric(
                        ST_ERROR, reason=f"Could not build OCI credentials: {exc}",
                        source=mp.source)
        return results, stats

    sem = asyncio.Semaphore(_REGION_CONCURRENCY)

    async def one(region: str, rps: List[ResourcePlan]):
        async with sem:
            try:
                return await asyncio.to_thread(_fetch_region, auth, region, rps, start, end)
            except Exception as exc:  # noqa: BLE001
                return ({(rp.resource_id, mp.metric): denied_or_error(exc, mp.source)
                         for rp in rps for mp in rp.metrics}, 0)

    for part, n in await asyncio.gather(*(one(r, rps) for r, rps in by_region.items())):
        results.update(part)
        stats["queries"] += n
    stats["regions"] = sorted(by_region)
    # Flex shape limits, for rightsizing targets. Read once: a shape's limits
    # are the same in every region that offers it.
    if any(rp.resource.resource_type == "ComputeInstance" for rps in by_region.values() for rp in rps):
        try:
            stats["shapes"] = await asyncio.to_thread(_shape_catalog, auth, sorted(by_region)[0])
        except Exception as exc:  # noqa: BLE001
            logger.warning("OCI ListShapes failed: %s", exc)
            stats["shapes"] = {}
    return results, stats


def _num(obj, *names):
    for n in names:
        v = getattr(obj, n, None) if obj is not None else None
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
    return None


def _shape_catalog(auth, region: str) -> Dict[str, Dict[str, Any]]:
    """{shape: OCPU and memory limits} for every Flex shape, from ListShapes."""
    import oci as oci_sdk

    cfg = auth.get_config()
    cfg["region"] = region
    client = oci_sdk.core.ComputeClient(cfg)
    shapes = oci_sdk.pagination.list_call_get_all_results(
        client.list_shapes, compartment_id=auth.tenancy_ocid).data
    out: Dict[str, Dict[str, Any]] = {}
    for s in shapes:
        if not (s.shape or "").endswith(".Flex"):
            continue
        oo, mo = getattr(s, "ocpu_options", None), getattr(s, "memory_options", None)
        out[s.shape] = {
            "ocpu_min": _num(oo, "min"), "ocpu_max": _num(oo, "max"),
            "memory_min": _num(mo, "min_in_g_bs", "min_in_gbs"),
            "memory_max": _num(mo, "max_in_g_bs", "max_in_gbs"),
            "memory_per_ocpu_min": _num(mo, "min_per_ocpu_in_gbs", "min_per_ocpu_in_g_bs"),
            "memory_per_ocpu_max": _num(mo, "max_per_ocpu_in_gbs", "max_per_ocpu_in_g_bs"),
            "gpus": _num(s, "gpus"),
            "source": "OCI Compute ListShapes",
        }
    return out
