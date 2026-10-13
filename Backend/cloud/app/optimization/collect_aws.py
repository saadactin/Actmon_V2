"""CloudWatch telemetry for AWS resources.

Batched through GetMetricData — up to 100 metric queries per call, per region —
rather than one GetMetricStatistics call per metric. On test_aw that is ~2
calls instead of ~190. AWS bills GetMetricData at $0.01 per 1,000 metrics
requested, so a full analysis of an account this size costs well under a cent;
the number requested is recorded on the run so it is never a surprise.

Three AWS facts shape the plan:

* **Memory is not an EC2 metric.** AWS publishes CPU, network and disk from the
  hypervisor; memory is only published by the CloudWatch agent running inside
  the instance, under the `CWAgent` namespace with whatever dimensions the
  agent was configured with. So memory is looked up with ListMetrics first and
  queried with the dimensions it actually has — and when there is no agent,
  the metric is NOT_COLLECTED with that reason, never shown as 0%.
* **Lambda publishes nothing when nothing runs.** `Invocations` has no
  datapoint for an hour with no invocations, so an empty 30-day series from a
  successful query is how CloudWatch says "not invoked". The rule that reads it
  says exactly that and no more.
* **The FunctionName dimension is the name, not the ARN.** The inventory keys
  a function by ARN; querying with it matches nothing.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.optimization.collect_common import (
    DAY, HOUR, MetricPlan, RawMetric, ResourcePlan, denied_or_error, is_transient,
    not_collected, ok_or_no_data,
)
from app.optimization.telemetry import ST_DENIED, ST_ERROR, ST_SKIPPED

logger = logging.getLogger("cloud_svc.optimization.aws")

_BATCH = 100          # 100 x 720 hourly points stays under the 100,800-point cap
_AGENT_MEMORY = ("mem_used_percent", "Memory % Committed Bytes In Use")


def aws_region(resource) -> Optional[str]:
    """The API region for a resource. EC2 and EBS carry an availability zone
    ("ap-south-2a"); CloudWatch wants the region it belongs to."""
    raw = (getattr(resource, "region_or_zone", None) or "").strip()
    if not raw or raw.lower() == "global":
        return None
    if len(raw) > 2 and raw[-1].isalpha() and raw[-2].isdigit():
        return raw[:-1]
    return raw


def _src(ns: str, name: str, stat: str, peak: Optional[str] = None,
         granularity: int = HOUR) -> str:
    per = "1 h" if granularity == HOUR else "1 day"
    stats = f"{stat} + {peak}" if peak else stat
    return f"AWS CloudWatch · {ns} {name} ({stats}, {per})"


def _running(resource) -> Optional[bool]:
    ns = (getattr(resource, "normalized_status", None) or "").upper()
    if ns == "RUNNING":
        return True
    if ns in ("STOPPED", "TERMINATED", "DELETED"):
        return False
    raw = (getattr(resource, "status", None) or "").lower()
    if raw == "running":
        return True
    if raw in ("stopped", "stopping", "terminated", "shutting-down"):
        return False
    return None


def plan(resource) -> Optional[ResourcePlan]:
    rtype = resource.resource_type
    region = aws_region(resource)
    if not region:
        return None
    pid = resource.provider_resource_id
    p = ResourcePlan(resource=resource, region=region)

    if rtype == "EC2Instance":
        if _running(resource) is False:
            p.skipped = {m: "Not queried: the instance was stopped when telemetry was "
                            "collected, and a stopped instance publishes no utilization."
                         for m in ("cpu_percent", "memory_percent", "network_in", "network_out")}
            return p
        dims = [{"Name": "InstanceId", "Value": pid}]
        p.metrics += [
            MetricPlan("cpu_percent", _src("AWS/EC2", "CPUUtilization", "Average", "Maximum"),
                       "AWS/EC2", "CPUUtilization", "Average", "Maximum", dims),
            MetricPlan("network_in", _src("AWS/EC2", "NetworkIn", "Sum"),
                       "AWS/EC2", "NetworkIn", "Sum", None, dims),
            MetricPlan("network_out", _src("AWS/EC2", "NetworkOut", "Sum"),
                       "AWS/EC2", "NetworkOut", "Sum", None, dims),
            # Resolved at fetch time against ListMetrics — see module docstring.
            MetricPlan("memory_percent", "AWS CloudWatch · CWAgent memory (Average + Maximum, 1 h)",
                       "CWAgent", None, "Average", "Maximum", dims),
        ]
    elif rtype == "EBSVolume":
        dims = [{"Name": "VolumeId", "Value": pid}]
        p.metrics += [
            MetricPlan("volume_read_ops", _src("AWS/EBS", "VolumeReadOps", "Sum"),
                       "AWS/EBS", "VolumeReadOps", "Sum", None, dims),
            MetricPlan("volume_write_ops", _src("AWS/EBS", "VolumeWriteOps", "Sum"),
                       "AWS/EBS", "VolumeWriteOps", "Sum", None, dims),
        ]
    elif rtype == "LambdaFunction":
        dims = [{"Name": "FunctionName", "Value": resource.resource_name}]
        p.metrics += [
            MetricPlan("invocations", _src("AWS/Lambda", "Invocations", "Sum"),
                       "AWS/Lambda", "Invocations", "Sum", None, dims),
            MetricPlan("errors", _src("AWS/Lambda", "Errors", "Sum"),
                       "AWS/Lambda", "Errors", "Sum", None, dims),
            MetricPlan("throttles", _src("AWS/Lambda", "Throttles", "Sum"),
                       "AWS/Lambda", "Throttles", "Sum", None, dims),
            MetricPlan("duration_ms", _src("AWS/Lambda", "Duration", "Average", "Maximum"),
                       "AWS/Lambda", "Duration", "Average", "Maximum", dims),
        ]
    elif rtype == "DynamoDBTable":
        dims = [{"Name": "TableName", "Value": resource.resource_name}]
        p.metrics += [
            MetricPlan("consumed_rcu", _src("AWS/DynamoDB", "ConsumedReadCapacityUnits", "Sum"),
                       "AWS/DynamoDB", "ConsumedReadCapacityUnits", "Sum", None, dims),
            MetricPlan("consumed_wcu", _src("AWS/DynamoDB", "ConsumedWriteCapacityUnits", "Sum"),
                       "AWS/DynamoDB", "ConsumedWriteCapacityUnits", "Sum", None, dims),
        ]
    elif rtype == "S3Bucket":
        # Storage metrics are published once a day, so they are asked for at
        # a one-day period: an hourly query returns the same value 24 times.
        p.metrics += [
            MetricPlan("stored_bytes",
                       _src("AWS/S3", "BucketSizeBytes", "Average", None, DAY)
                       + " — Standard storage class",
                       "AWS/S3", "BucketSizeBytes", "Average", None,
                       [{"Name": "BucketName", "Value": pid},
                        {"Name": "StorageType", "Value": "StandardStorage"}], DAY),
            MetricPlan("object_count", _src("AWS/S3", "NumberOfObjects", "Average", None, DAY),
                       "AWS/S3", "NumberOfObjects", "Average", None,
                       [{"Name": "BucketName", "Value": pid},
                        {"Name": "StorageType", "Value": "AllStorageTypes"}], DAY),
        ]
    elif rtype == "RDSInstance":
        dims = [{"Name": "DBInstanceIdentifier", "Value": pid}]
        p.metrics += [
            MetricPlan("cpu_percent", _src("AWS/RDS", "CPUUtilization", "Average", "Maximum"),
                       "AWS/RDS", "CPUUtilization", "Average", "Maximum", dims),
            MetricPlan("connections", _src("AWS/RDS", "DatabaseConnections", "Average", "Maximum"),
                       "AWS/RDS", "DatabaseConnections", "Average", "Maximum", dims),
        ]
        p.not_collected["memory_percent"] = (
            "RDS publishes FreeableMemory in bytes, not a percentage; turning it into "
            "utilization needs the instance class's memory, which the inventory does "
            "not record.")
    else:
        return None
    return p


def _query_id(prefix: str, n: int) -> str:
    # GetMetricData ids must match ^[a-z][a-zA-Z0-9_]*$.
    return f"{prefix}{n}"


def _parse_results(results: Sequence[Dict[str, Any]]) -> Dict[str, Tuple[str, List]]:
    """GetMetricData results → {query_id: (status_code, [(ts, value)])}.

    Pages repeat ids; their timestamps are merged, not overwritten.
    """
    out: Dict[str, Tuple[str, List]] = {}
    for res in results or []:
        qid = res.get("Id")
        if not qid:
            continue
        pts = list(zip(res.get("Timestamps") or [], res.get("Values") or []))
        status, existing = out.get(qid, (None, []))
        out[qid] = (res.get("StatusCode") or status or "Complete", existing + pts)
    return out


def _agent_memory_dims(cw, instance_id: str) -> Tuple[Optional[str], Optional[List[Dict[str, str]]],
                                                       Optional[BaseException]]:
    """The CWAgent metric name and full dimension set for this instance, if
    the agent publishes memory at all."""
    for name in _AGENT_MEMORY:
        try:
            resp = cw.list_metrics(Namespace="CWAgent", MetricName=name,
                                   Dimensions=[{"Name": "InstanceId", "Value": instance_id}])
        except Exception as exc:  # noqa: BLE001
            return None, None, exc
        metrics = resp.get("Metrics") or []
        if metrics:
            return name, metrics[0].get("Dimensions") or [], None
    return None, None, None


def _fetch_region(session, region: str, plans: Sequence[ResourcePlan],
                  start: datetime, end: datetime) -> Dict[Tuple[str, str], RawMetric]:
    from botocore.config import Config

    out: Dict[Tuple[str, str], RawMetric] = {}
    cw = session.client("cloudwatch", region_name=region,
                        config=Config(retries={"max_attempts": 6, "mode": "adaptive"}))

    queries: List[Dict[str, Any]] = []
    index: Dict[str, Tuple[str, MetricPlan, str]] = {}   # qid -> (rid, plan, role)
    n = 0
    for rp in plans:
        for mp in rp.metrics:
            dims, name = mp.dims, mp.name
            if mp.namespace == "CWAgent":
                agent_name, agent_dims, err = _agent_memory_dims(
                    cw, rp.resource.provider_resource_id)
                if err is not None:
                    out[(rp.resource_id, mp.metric)] = denied_or_error(err, mp.source)
                    continue
                if not agent_name:
                    out[(rp.resource_id, mp.metric)] = not_collected(
                        "EC2 does not publish memory utilization. The CloudWatch agent does, "
                        "and it has published no memory metric for this instance in this "
                        "region, so memory utilization is not measurable here.",
                        source="AWS CloudWatch · CWAgent")
                    continue
                dims, name = agent_dims, agent_name
                mp.source = f"AWS CloudWatch · CWAgent {agent_name} (Average + Maximum, 1 h)"
            for role, stat in (("value", mp.stat), ("peak", mp.peak_stat)):
                if not stat:
                    continue
                n += 1
                qid = _query_id("q" if role == "value" else "p", n)
                index[qid] = (rp.resource_id, mp, role)
                queries.append({
                    "Id": qid,
                    "MetricStat": {
                        "Metric": {"Namespace": mp.namespace, "MetricName": name,
                                   "Dimensions": dims or []},
                        "Period": mp.granularity,
                        "Stat": stat,
                    },
                    "ReturnData": True,
                })

    collected: Dict[str, Tuple[str, List]] = {}
    failed: Dict[str, BaseException] = {}
    for i in range(0, len(queries), _BATCH):
        chunk = queries[i:i + _BATCH]
        token = None
        attempt = 0
        while True:
            try:
                kwargs = {"MetricDataQueries": chunk, "StartTime": start, "EndTime": end,
                          "ScanBy": "TimestampAscending"}
                if token:
                    kwargs["NextToken"] = token
                resp = cw.get_metric_data(**kwargs)
            except Exception as exc:  # noqa: BLE001
                if is_transient(exc) and attempt < 3:
                    attempt += 1
                    import time
                    time.sleep(2 ** attempt)
                    continue
                for q in chunk:
                    failed[q["Id"]] = exc
                break
            for qid, (status, pts) in _parse_results(resp.get("MetricDataResults")).items():
                prev_status, prev = collected.get(qid, (None, []))
                collected[qid] = (status or prev_status, prev + pts)
            token = resp.get("NextToken")
            if not token:
                break

    # Reassemble per (resource, metric).
    grouped: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for qid, (rid, mp, role) in index.items():
        g = grouped.setdefault((rid, mp.metric), {"plan": mp})
        if qid in failed:
            g["error"] = failed[qid]
            continue
        status, pts = collected.get(qid, ("Complete", []))
        if status == "Forbidden":
            g["forbidden"] = True
        g[role] = pts
    for key, g in grouped.items():
        mp = g["plan"]
        if "error" in g:
            out[key] = denied_or_error(g["error"], mp.source)
            continue
        if g.get("forbidden"):
            out[key] = RawMetric(ST_DENIED, [], None, source=mp.source,
                                 reason="CloudWatch returned Forbidden for this metric.")
            continue
        empty = None
        if mp.metric == "invocations":
            empty = ("CloudWatch accepted the query and holds no Invocations datapoints for "
                     "the last 30 days. Lambda publishes Invocations only for periods in "
                     "which the function ran.")
        out[key] = ok_or_no_data(g.get("value") or [], source=mp.source,
                                 peaks=g.get("peak"), granularity=mp.granularity,
                                 empty_reason=empty)
    return out


def _instance_types(session, region: str, types: List[str]) -> Dict[str, Dict[str, Any]]:
    ec2 = session.client("ec2", region_name=region)
    out: Dict[str, Dict[str, Any]] = {}
    for i in range(0, len(types), 100):
        resp = ec2.describe_instance_types(InstanceTypes=types[i:i + 100])
        for t in resp.get("InstanceTypes") or []:
            gpus = sum(int(g.get("Count") or 0) for g in (t.get("GpuInfo") or {}).get("Gpus") or [])
            out[t["InstanceType"]] = {
                "vcpus": float((t.get("VCpuInfo") or {}).get("DefaultVCpus") or 0) or None,
                "memory_gb": (float((t.get("MemoryInfo") or {}).get("SizeInMiB") or 0) / 1024.0) or None,
                "gpus": gpus or None,
                "current_generation": t.get("CurrentGeneration"),
                "source": "AWS EC2 DescribeInstanceTypes",
            }
    return out


async def fetch(creds: Dict[str, Any], plans: Sequence[ResourcePlan], *,
                start: datetime, end: datetime) -> Tuple[Dict[Tuple[str, str], RawMetric], Dict[str, Any]]:
    """Run every plan. Returns (results, stats)."""
    from app.providers.aws.aws_auth import AWSAuth

    results: Dict[Tuple[str, str], RawMetric] = {}
    stats = {"api": "cloudwatch:GetMetricData", "metrics_requested": 0, "regions": []}
    by_region: Dict[str, List[ResourcePlan]] = {}
    for rp in plans:
        if rp.metrics:
            by_region.setdefault(rp.region, []).append(rp)
        for metric, reason in rp.skipped.items():
            results[(rp.resource_id, metric)] = RawMetric(ST_SKIPPED, reason=reason)
        for metric, reason in rp.not_collected.items():
            results[(rp.resource_id, metric)] = not_collected(reason)
    if not by_region:
        return results, stats
    try:
        session = await asyncio.to_thread(lambda: AWSAuth(creds).get_session())
    except Exception as exc:  # noqa: BLE001
        for rps in by_region.values():
            for rp in rps:
                for mp in rp.metrics:
                    results[(rp.resource_id, mp.metric)] = RawMetric(
                        ST_ERROR, reason=f"Could not build AWS credentials: {exc}",
                        source=mp.source)
        return results, stats

    async def one(region: str, rps: List[ResourcePlan]):
        try:
            return await asyncio.to_thread(_fetch_region, session, region, rps, start, end)
        except Exception as exc:  # noqa: BLE001
            logger.warning("CloudWatch collection failed in %s: %s", region, exc)
            return {(rp.resource_id, mp.metric): denied_or_error(exc, mp.source)
                    for rp in rps for mp in rp.metrics}

    outs = await asyncio.gather(*(one(r, rps) for r, rps in by_region.items()))
    for part in outs:
        results.update(part)
    stats["regions"] = sorted(by_region)

    # vCPU, memory and GPUs per instance type, from EC2 itself.
    types_by_region: Dict[str, set] = {}
    for rp in plans:
        if rp.resource.resource_type == "EC2Instance":
            itype = (rp.resource.config or {}).get("instance_type")
            if itype:
                types_by_region.setdefault(rp.region, set()).add(itype)
    catalog: Dict[str, Dict[str, Any]] = {}
    for region, types in types_by_region.items():
        try:
            catalog.update(await asyncio.to_thread(_instance_types, session, region, sorted(types)))
        except Exception as exc:  # noqa: BLE001
            logger.warning("DescribeInstanceTypes failed in %s: %s", region, exc)
    stats["instance_types"] = catalog
    stats["metrics_requested"] = sum(
        (1 + (1 if mp.peak_stat else 0)) for rps in by_region.values()
        for rp in rps for mp in rp.metrics)
    return results, stats
