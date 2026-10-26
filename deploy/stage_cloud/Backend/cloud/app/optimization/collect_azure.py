"""Azure Monitor telemetry for Azure resources.

One `metrics.list` call per resource with every metric name at once (the API
accepts up to 20), hourly, 30 days — measured at 720 points per metric on the
TOR subscription, which the Reader role can read.

Two Azure facts shape the plan:

* **Memory is published as AVAILABLE bytes, not used.** `Available Memory
  Bytes` is a platform metric (no agent needed), but utilization needs the
  VM's real memory capacity. That comes from the Resource SKUs API for the
  VM's size in its region — a provider answer, not a lookup table here. With
  no capacity there is no percentage, and memory reports NOT_COLLECTED saying
  so. The Minimum of available memory is the peak of used memory, so that is
  what the peak series is built from.
* **Not every database exposes every metric.** A vCore or elastic-pool Azure
  SQL database rejects `dtu_consumption_percent` with a BadRequest that lists
  the valid names. The collector retries with that list rather than failing
  the resource, and records the metrics that do not exist as NOT_COLLECTED
  with Azure's own wording.
"""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.optimization.collect_common import (
    HOUR, MetricPlan, RawMetric, ResourcePlan, denied_or_error, is_transient,
    not_collected, ok_or_no_data,
)
from app.optimization.telemetry import ST_ERROR, ST_SKIPPED, derive_percent_used

logger = logging.getLogger("cloud_svc.optimization.azure")

_CONCURRENCY = 4
_SRC = "Azure Monitor"


def _src(name: str, agg: str, peak: Optional[str] = None) -> str:
    return f"{_SRC} · {name} ({agg + ' + ' + peak if peak else agg}, 1 h)"


def _running(resource) -> Optional[bool]:
    ns = (getattr(resource, "normalized_status", None) or "").upper()
    if ns == "RUNNING":
        return True
    if ns in ("STOPPED", "DEALLOCATED"):
        return False
    ps = ((getattr(resource, "config", None) or {}).get("power_state") or "").lower()
    if "running" in ps:
        return True
    if "stop" in ps or "deallocat" in ps:
        return False
    return None


def plan(resource) -> Optional[ResourcePlan]:
    rtype = resource.resource_type
    cfg = resource.config or {}
    p = ResourcePlan(resource=resource, region=(resource.region_or_zone or "").lower() or None)
    M = MetricPlan

    if rtype == "VirtualMachine":
        if "vm_size" not in cfg:
            # The generic ARM sweep's rows (no size, no power state) are not
            # analysable VMs; the detailed scanner's rows are.
            return None
        if _running(resource) is False:
            p.skipped = {m: "Not queried: the VM was stopped or deallocated when telemetry "
                            "was collected, and publishes no utilization in that state."
                         for m in ("cpu_percent", "memory_percent", "network_in",
                                   "network_out", "disk_read_ops", "disk_write_ops")}
            return p
        p.metrics += [
            M("cpu_percent", _src("Percentage CPU", "Average", "Maximum"),
              name="Percentage CPU", stat="Average", peak_stat="Maximum"),
            M("memory_percent", _src("Available Memory Bytes", "Average", "Minimum")
              + " → used % against the size's capacity (Resource SKUs API)",
              name="Available Memory Bytes", stat="Average", peak_stat="Minimum",
              derive="memory_from_available"),
            M("network_in", _src("Network In Total", "Total"), name="Network In Total",
              stat="Total"),
            M("network_out", _src("Network Out Total", "Total"), name="Network Out Total",
              stat="Total"),
            # Azure reports these as operations per SECOND averaged over the
            # hour; x3600 makes them per hour like every other counter here.
            M("disk_read_ops", _src("Disk Read Operations/Sec", "Average") + " × 3600",
              name="Disk Read Operations/Sec", stat="Average", scale=3600.0),
            M("disk_write_ops", _src("Disk Write Operations/Sec", "Average") + " × 3600",
              name="Disk Write Operations/Sec", stat="Average", scale=3600.0),
        ]
        p.facts["vm_size"] = cfg.get("vm_size")
    elif rtype == "SQLDatabase":
        p.metrics += [
            M("cpu_percent", _src("cpu_percent", "Average", "Maximum"), name="cpu_percent",
              stat="Average", peak_stat="Maximum"),
            M("dtu_percent", _src("dtu_consumption_percent", "Average", "Maximum"),
              name="dtu_consumption_percent", stat="Average", peak_stat="Maximum"),
            M("storage_percent", _src("storage_percent", "Maximum"), name="storage_percent",
              stat="Maximum"),
            M("connections_opened", _src("connection_successful", "Total"),
              name="connection_successful", stat="Total"),
        ]
    elif rtype == "PostgreSQLServer":
        p.metrics += [
            M("cpu_percent", _src("cpu_percent", "Average", "Maximum"), name="cpu_percent",
              stat="Average", peak_stat="Maximum"),
            M("memory_percent", _src("memory_percent", "Average", "Maximum"),
              name="memory_percent", stat="Average", peak_stat="Maximum"),
            M("storage_percent", _src("storage_percent", "Average", "Maximum"),
              name="storage_percent", stat="Average", peak_stat="Maximum"),
            M("connections", _src("active_connections", "Average", "Maximum"),
              name="active_connections", stat="Average", peak_stat="Maximum"),
        ]
    elif rtype == "AppServicePlan":
        p.metrics += [
            M("cpu_percent", _src("CpuPercentage", "Average", "Maximum"), name="CpuPercentage",
              stat="Average", peak_stat="Maximum"),
            M("memory_percent", _src("MemoryPercentage", "Average", "Maximum"),
              name="MemoryPercentage", stat="Average", peak_stat="Maximum"),
        ]
    elif rtype == "StorageAccount":
        p.metrics += [
            M("stored_bytes", _src("UsedCapacity", "Average"), name="UsedCapacity",
              stat="Average"),
            M("transactions", _src("Transactions", "Total"), name="Transactions", stat="Total"),
        ]
    elif rtype == "NATGateway":
        p.metrics += [
            M("nat_bytes", _src("ByteCount", "Total"), name="ByteCount", stat="Total"),
        ]
    elif rtype == "AKSCluster":
        p.metrics += [
            M("cpu_percent", _src("node_cpu_usage_percentage", "Average", "Maximum"),
              name="node_cpu_usage_percentage", stat="Average", peak_stat="Maximum"),
            M("memory_percent", _src("node_memory_rss_percentage", "Average", "Maximum"),
              name="node_memory_rss_percentage", stat="Average", peak_stat="Maximum"),
        ]
    else:
        return None
    return p


_VALID = re.compile(r"Valid metrics:\s*([A-Za-z0-9_ ,/%().-]+)")


def valid_metrics_from_error(text: str) -> Optional[List[str]]:
    """The metric names Azure says exist, from its BadRequest message."""
    m = _VALID.search(text or "")
    if not m:
        return None
    return [n.strip() for n in m.group(1).split(",") if n.strip()]


def parse_metrics(value: Sequence[Any]) -> Dict[str, Dict[str, List]]:
    """metrics.list(...).value → {metric_name: {aggregation: [(ts, v)]}}."""
    out: Dict[str, Dict[str, List]] = {}
    for metric in value or []:
        name = getattr(getattr(metric, "name", None), "value", None)
        if not name:
            continue
        per = out.setdefault(name, {"Average": [], "Maximum": [], "Minimum": [], "Total": []})
        for ts in (getattr(metric, "timeseries", None) or []):
            for d in (getattr(ts, "data", None) or []):
                stamp = getattr(d, "time_stamp", None)
                for agg in ("Average", "Maximum", "Minimum", "Total"):
                    v = getattr(d, agg.lower(), None)
                    if v is not None and stamp is not None:
                        per[agg].append((stamp, float(v)))
    return out


def _query(client, uri: str, names: List[str], timespan: str):
    for attempt in range(4):
        try:
            return client.metrics.list(
                resource_uri=uri, timespan=timespan, interval="PT1H",
                metricnames=",".join(names), aggregation="Average,Maximum,Minimum,Total")
        except Exception as exc:  # noqa: BLE001
            if is_transient(exc) and attempt < 3:
                import time
                time.sleep(2 ** (attempt + 1))
                continue
            raise


def _fetch_resource(client, rp: ResourcePlan, timespan: str,
                    capacity: Optional[Dict[str, float]]) -> Dict[Tuple[str, str], RawMetric]:
    out: Dict[Tuple[str, str], RawMetric] = {}
    uri = rp.resource.provider_resource_id
    names = [mp.name for mp in rp.metrics]
    try:
        resp = _query(client, uri, names, timespan)
    except Exception as exc:  # noqa: BLE001
        valid = valid_metrics_from_error(str(exc))
        if not valid:
            return {(rp.resource_id, mp.metric): denied_or_error(exc, mp.source)
                    for mp in rp.metrics}
        keep = [n for n in names if n in valid]
        for mp in rp.metrics:
            if mp.name not in valid:
                out[(rp.resource_id, mp.metric)] = not_collected(
                    f"Azure Monitor does not publish '{mp.name}' for this resource "
                    f"(its valid metrics are: {', '.join(valid[:12])}"
                    f"{'…' if len(valid) > 12 else ''}).", source=mp.source)
        if not keep:
            return out
        try:
            resp = _query(client, uri, keep, timespan)
        except Exception as exc2:  # noqa: BLE001
            for mp in rp.metrics:
                if mp.name in keep:
                    out[(rp.resource_id, mp.metric)] = denied_or_error(exc2, mp.source)
            return out

    parsed = parse_metrics(getattr(resp, "value", None) or [])
    for mp in rp.metrics:
        key = (rp.resource_id, mp.metric)
        if key in out:
            continue
        series = parsed.get(mp.name)
        if series is None:
            out[key] = ok_or_no_data([], source=mp.source)
            continue
        values = series.get(mp.stat) or []
        peaks = series.get(mp.peak_stat) if mp.peak_stat else None
        if mp.scale != 1.0:
            values = [(t, v * mp.scale) for t, v in values]
            peaks = [(t, v * mp.scale) for t, v in peaks] if peaks else peaks
        if mp.derive == "memory_from_available":
            cap_gb = (capacity or {}).get("memory_gb")
            if not cap_gb:
                out[key] = not_collected(
                    "Azure publishes available memory, not used memory. Turning it into "
                    "a utilization needs this VM size's memory capacity, and the Resource "
                    "SKUs API did not list the size in this region.", source=mp.source)
                continue
            cap_bytes = float(cap_gb) * 1024 ** 3
            values = derive_percent_used(values, cap_bytes)
            # Lowest available memory in an hour = highest used memory.
            peaks = derive_percent_used(peaks or [], cap_bytes) if peaks else None
        out[key] = ok_or_no_data(values, source=mp.source, peaks=peaks)
    return out


def _sku_catalog(auth, location: str) -> Dict[str, Dict[str, Any]]:
    """Every VM size offered in a region with its vCPUs, memory and family,
    from the Resource SKUs API. The rules use this for capacity and for the
    candidate sizes of a rightsizing recommendation."""
    from azure.mgmt.compute import ComputeManagementClient

    client = auth.get_client(ComputeManagementClient)
    out: Dict[str, Dict[str, Any]] = {}
    for sku in client.resource_skus.list(filter=f"location eq '{location}'"):
        if getattr(sku, "resource_type", None) != "virtualMachines" or not sku.name:
            continue
        caps = {c.name: c.value for c in (sku.capabilities or [])}
        restricted = any(
            getattr(r, "reason_code", None) == "NotAvailableForSubscription"
            for r in (sku.restrictions or []))

        def num(key):
            try:
                return float(caps[key]) if caps.get(key) not in (None, "") else None
            except (TypeError, ValueError):
                return None
        out[sku.name] = {
            "name": sku.name,
            "family": getattr(sku, "family", None),
            "vcpus": num("vCPUs"),
            "memory_gb": num("MemoryGB"),
            "premium_io": (caps.get("PremiumIO") or "").lower() == "true",
            "accelerated_networking": (caps.get("AcceleratedNetworkingEnabled") or "").lower() == "true",
            "gpus": num("GPUs"),
            "restricted": restricted,
        }
    return out


async def fetch(creds: Dict[str, Any], plans: Sequence[ResourcePlan], *,
                start: datetime, end: datetime) -> Tuple[Dict[Tuple[str, str], RawMetric], Dict[str, Any]]:
    from app.providers.azure.azure_auth import AzureAuth

    results: Dict[Tuple[str, str], RawMetric] = {}
    stats: Dict[str, Any] = {"api": "Azure Monitor metrics.list", "calls": 0,
                             "sku_catalogs": {}}
    for rp in plans:
        for metric, reason in rp.skipped.items():
            results[(rp.resource_id, metric)] = RawMetric(ST_SKIPPED, reason=reason)
        for metric, reason in rp.not_collected.items():
            results[(rp.resource_id, metric)] = not_collected(reason)
    live = [rp for rp in plans if rp.metrics]
    if not live:
        return results, stats
    try:
        auth = AzureAuth(creds)
        from azure.mgmt.monitor import MonitorManagementClient
        client = await asyncio.to_thread(lambda: auth.get_client(MonitorManagementClient))
    except Exception as exc:  # noqa: BLE001
        for rp in live:
            for mp in rp.metrics:
                results[(rp.resource_id, mp.metric)] = RawMetric(
                    ST_ERROR, reason=f"Could not build Azure credentials: {exc}", source=mp.source)
        return results, stats

    # Capacity catalogs, once per region that has a VM needing one.
    catalogs: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for loc in sorted({rp.region for rp in live
                       if rp.resource.resource_type == "VirtualMachine" and rp.region}):
        try:
            catalogs[loc] = await asyncio.to_thread(_sku_catalog, auth, loc)
            stats["sku_catalogs"][loc] = len(catalogs[loc])
        except Exception as exc:  # noqa: BLE001
            logger.warning("Resource SKUs lookup failed for %s: %s", loc, exc)
            stats["sku_catalogs"][loc] = f"failed: {str(exc)[:160]}"
            catalogs[loc] = {}
    stats["catalogs"] = catalogs

    timespan = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    sem = asyncio.Semaphore(_CONCURRENCY)

    async def one(rp: ResourcePlan):
        capacity = None
        if rp.resource.resource_type == "VirtualMachine":
            capacity = catalogs.get(rp.region or "", {}).get(rp.facts.get("vm_size") or "")
            if capacity:
                rp.facts["capacity"] = {**capacity, "source": "Azure Resource SKUs API"}
        async with sem:
            stats["calls"] += 1
            try:
                return await asyncio.to_thread(_fetch_resource, client, rp, timespan, capacity)
            except Exception as exc:  # noqa: BLE001
                return {(rp.resource_id, mp.metric): denied_or_error(exc, mp.source)
                        for mp in rp.metrics}

    for part in await asyncio.gather(*(one(rp) for rp in live)):
        results.update(part)
    return results, stats
