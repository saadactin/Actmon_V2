"""Metrics service — fetches real-time performance metrics from AWS CloudWatch & Azure Monitor.

Policy: only datapoints actually returned by the provider's metrics API are
emitted. Hours with no datapoint are omitted (never zero-filled), unsupported
resource types return an empty metrics dict, and `realtime` is true only when
at least one real datapoint was retrieved — the UI shows NA otherwise.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource
from app.models.cloud_account import CloudAccount
from app.repository.resource_repo import ResourceRepository

logger = logging.getLogger("cloud_svc.metrics")

# Per-request collector for provider query errors. The individual _get_*_stats
# helpers deliberately swallow their exceptions and return {} so one dead metric
# doesn't kill the whole panel — but that erases the reason the panel is empty.
# A ContextVar keeps the reasons request-scoped (safe under concurrency, and
# asyncio.to_thread copies the context so worker threads append to the same list)
# so the UI can explain WHY there are no metrics instead of a bare empty state.
_metric_errors: contextvars.ContextVar[Optional[List[str]]] = contextvars.ContextVar(
    "metric_errors", default=None
)


def _record_metric_error(exc: Exception) -> None:
    bucket = _metric_errors.get()
    if bucket is not None:
        bucket.append(str(exc))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_timestamps(hours: int = 24) -> List[str]:
    """Return a list of ISO-8601 timestamps, one per hour, ascending."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return [(now - timedelta(hours=h)).isoformat() for h in reversed(range(hours))]


def _get_cw_stats(
    cw_client,
    namespace: str,
    metric_name: str,
    dimensions: List[Dict[str, str]],
    start_time: datetime,
    end_time: datetime,
    period: int = 3600,
    stat: str = "Average",
) -> Dict[str, float]:
    """Call CloudWatch GetMetricStatistics."""
    try:
        resp = cw_client.get_metric_statistics(
            Namespace=namespace,
            MetricName=metric_name,
            Dimensions=dimensions,
            StartTime=start_time,
            EndTime=end_time,
            Period=period,
            Statistics=[stat],
        )
        result: Dict[str, float] = {}
        for dp in resp.get("Datapoints", []):
            ts = dp["Timestamp"].replace(minute=0, second=0, microsecond=0)
            result[ts.isoformat()] = round(dp.get(stat, 0), 4)
        return result
    except Exception as exc:
        logger.warning("CloudWatch query failed (%s / %s): %s", namespace, metric_name, exc)
        _record_metric_error(exc)
        return {}


def _get_az_stats(
    monitor_client,
    resource_uri: str,
    metric_names: str,
    start_time: datetime,
    end_time: datetime,
    aggregation: str = "Average",
) -> Dict[str, float]:
    """Call Azure Monitor metrics list."""
    try:
        timespan = f"{start_time.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end_time.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        resp = monitor_client.metrics.list(
            resource_uri=resource_uri,
            timespan=timespan,
            interval="PT1H",
            metricnames=metric_names,
            aggregation=aggregation
        )
        result: Dict[str, float] = {}
        if not resp.value:
            return result
            
        for metric in resp.value:
            for timeseries in metric.timeseries:
                for data in timeseries.data:
                    ts = data.time_stamp.replace(minute=0, second=0, microsecond=0)
                    val = getattr(data, aggregation.lower(), 0) or 0
                    result[ts.isoformat()] = round(val, 4)
        return result
    except Exception as exc:
        logger.warning("Azure Monitor query failed (%s / %s): %s", resource_uri, metric_names, exc)
        _record_metric_error(exc)
        return {}


# Dimension keys OCI uses to identify a resource. They are not consistent across
# services: compute uses resourceId, Object Storage uses resourceID (capital D),
# and Autonomous Database reports resourceId with the OCID upper-cased. Matching
# is therefore done over all of these, case-insensitively.
_OCI_ID_DIMENSIONS = ("resourceId", "resourceID", "resourceName", "resourceDisplayName")


def _get_oci_stats(
    monitoring_client,
    tenancy_ocid: str,
    namespace: str,
    metric_name: str,
    match_value: str,
    start_time: datetime,
    end_time: datetime,
    statistic: str = "mean",
) -> Dict[str, float]:
    """Call OCI Monitoring SummarizeMetricsData and keep this resource's stream.

    OCI has no per-metric REST call like CloudWatch — you post an MQL expression,
    e.g. `CpuUtilization[1h].mean()`. The window inside the brackets sets the
    aggregation interval, so [1h] lines datapoints up with the hourly timestamps
    the other providers return.

    Three OCI-specific constraints shape this:

    * `compartment_id_in_subtree` may only be true for the *tenancy root* — the
      API returns 400 InvalidParameter for any other compartment. So the query is
      always issued at the root and covers every compartment in one call.
    * The identifying dimension is filtered client-side rather than in MQL,
      because the key differs per service and ADB upper-cases its OCID; a
      server-side `{resourceId = "..."}` predicate silently matches nothing.
    * One resource can emit several streams (a load balancer splits by
      backendSetName), so same-timestamp values are combined — added for `sum`
      statistics, averaged for gauges.
    """
    try:
        from oci.monitoring.models import SummarizeMetricsDataDetails

        details = SummarizeMetricsDataDetails(
            namespace=namespace,
            query=f"{metric_name}[1h].{statistic}()",
            start_time=start_time,
            end_time=end_time,
        )
        resp = monitoring_client.summarize_metrics_data(
            compartment_id=tenancy_ocid,
            summarize_metrics_data_details=details,
            compartment_id_in_subtree=True,
        )

        target = (match_value or "").strip().lower()
        if not target:
            return {}

        buckets: Dict[str, List[float]] = {}
        for series in (resp.data or []):
            dims = series.dimensions or {}
            if not any(
                str(dims.get(k, "")).strip().lower() == target for k in _OCI_ID_DIMENSIONS
            ):
                continue
            for dp in (series.aggregated_datapoints or []):
                if dp.value is None:
                    continue
                ts = dp.timestamp
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                ts = ts.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
                buckets.setdefault(ts.isoformat(), []).append(float(dp.value))

        combine = sum if statistic == "sum" else (lambda vs: sum(vs) / len(vs))
        return {ts: round(combine(vals), 4) for ts, vals in buckets.items() if vals}
    except Exception as exc:
        logger.warning(
            "OCI Monitoring query failed (%s / %s for %s): %s",
            namespace, metric_name, match_value, exc,
        )
        _record_metric_error(exc)
        return {}


def _build_metrics_diagnostic(
    provider: str,
    resource_type: str,
    unsupported_type: bool,
    client_error: Optional[str],
    query_errors: List[str],
    source_label: Optional[str],
) -> Dict[str, str]:
    """Explain an empty metrics panel using only what actually happened —
    credentials that wouldn't build, a provider API that refused the query, or a
    resource type this service has no metric mapping for."""
    if client_error:
        return {
            "category": "credentials",
            "message": (
                "Could not authenticate to the provider's monitoring API for this "
                f"account, so no metrics could be requested. Raw error: {client_error[:400]}"
            ),
        }

    if unsupported_type:
        return {
            "category": "unsupported",
            "message": (
                f"'{resource_type}' has no metrics mapping in this tool yet — no "
                "monitoring query is issued for this resource type. This is a product "
                "gap, not a problem with your cloud account. Metrics are currently "
                "collected for compute instances, databases, storage buckets, load "
                "balancers and serverless functions."
            ),
        }

    if provider == "UNKNOWN":
        return {
            "category": "credentials",
            "message": (
                "This resource isn't linked to a cloud account with usable credentials, "
                "so no monitoring API could be queried."
            ),
        }

    if query_errors:
        joined = " | ".join(dict.fromkeys(query_errors))[:400]
        low = joined.lower()
        if any(k in joined for k in (
            "AuthorizationFailed", "AccessDenied", "Forbidden", "NotAuthorizedOrNotFound",
            "UnauthorizedOperation",
        )) or " 403" in joined:
            return {
                "category": "permission",
                "message": (
                    f"{source_label or 'The provider monitoring API'} refused the metrics "
                    f"query — the account's credentials lack monitoring read permission. "
                    f"Raw error: {joined}"
                ),
            }
        if any(k in low for k in ("timeout", "timed out", "connection", "unreachable", "network")):
            return {
                "category": "network",
                "message": (
                    f"A network error occurred while querying {source_label or 'the monitoring API'}. "
                    f"Raw error: {joined}"
                ),
            }
        return {
            "category": "unknown",
            "message": (
                f"{source_label or 'The monitoring API'} returned an error for every metric "
                f"query. Raw error: {joined}"
            ),
        }

    return {
        "category": "no_data",
        "message": (
            f"{source_label or 'The provider monitoring API'} accepted the query but returned "
            "no datapoints for the last 24 hours. This normally means the resource is stopped, "
            "idle, or was created too recently to have emitted metrics yet."
        ),
    }


def _align_to_timestamps(
    ts_list: List[str],
    data: Dict[str, float],
) -> List[Dict[str, Any]]:
    """Emit only real datapoints; hours without data are omitted, and an empty
    query yields an empty series (UI shows 'no data'/NA — never a fake zero line)."""
    if not data:
        return []
    return [
        {"timestamp": ts, "value": data[ts]}
        for ts in ts_list
        if ts in data
    ]


# ---------------------------------------------------------------------------
# Main entry-point
# ---------------------------------------------------------------------------

async def get_resource_metrics(resource_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    repo = ResourceRepository(db)
    resource: Optional[CloudResource] = await repo.get_by_id(resource_id)
    if not resource:
        return {"error": "Resource not found"}

    rtype = resource.resource_type
    timestamps = _make_timestamps(24)
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)

    # Collect provider query errors for this request so an empty panel can
    # explain itself (see _metric_errors).
    _metric_errors.set([])
    client_error: Optional[str] = None
    unsupported_type = False

    # ── Fetch the cloud account's credentials ─────────────────────────────
    cw_client = None
    az_monitor_client = None
    oci_monitoring_client = None
    oci_tenancy_ocid: Optional[str] = None
    provider = "UNKNOWN"

    meta = resource.metadata_ or {}

    region = resource.region_or_zone or "us-east-1"
    if len(region) > 1 and region[-1].isalpha() and region[-2] == '-':
        parts = region.rsplit('-', 1)
        if parts[-1][-1].isalpha() and len(parts[-1]) > 1:
            region = parts[0] + '-' + parts[-1][:-1]

    # OCI stores the availability domain in region_or_zone (e.g.
    # "hpAD:AP-MUMBAI-1-AD-1"), which the AZ-stripping above would mangle. The
    # scanner records the real region in metadata, so prefer that.
    if meta.get("region"):
        region = meta["region"]

    try:
        account_result = await db.execute(select(CloudAccount).where(CloudAccount.id == resource.account_id))
        account: Optional[CloudAccount] = account_result.scalar_one_or_none()
        if account and account.credentials_enc:
            provider = account.provider.upper()
            from app.utils.encryption import decrypt_credentials
            creds = decrypt_credentials(account.credentials_enc)
            
            if provider == "AWS":
                from app.providers.aws.aws_auth import AWSAuth
                aws_auth = AWSAuth(creds)
                cw_client = await asyncio.to_thread(aws_auth.get_client, "cloudwatch", region)
            elif provider == "AZURE":
                from app.providers.azure.azure_auth import AzureAuth
                from azure.mgmt.monitor import MonitorManagementClient
                az_auth = AzureAuth(creds)
                az_monitor_client = await asyncio.to_thread(
                    lambda: MonitorManagementClient(az_auth.get_credential(), az_auth.subscription_id)
                )
            elif provider in ("OCI", "ORACLE"):
                import oci as oci_sdk
                from app.providers.oci.oci_auth import OCIAuth
                oci_auth = OCIAuth(creds)
                cfg = oci_auth.get_config()
                # Monitoring is regional: query the region the resource lives in,
                # not the tenancy's home region.
                cfg["region"] = region or cfg.get("region")
                oci_monitoring_client = await asyncio.to_thread(
                    lambda: oci_sdk.monitoring.MonitoringClient(cfg)
                )
                # Always query from the tenancy root: subtree search is rejected
                # for any other compartment, and the root covers every one.
                oci_tenancy_ocid = oci_auth.tenancy_ocid
    except Exception as exc:
        logger.warning("Could not build metrics client for resource %s: %s", resource_id, exc)
        client_error = str(exc)

    # ── Fetch metrics per resource type ──────────────────────────────────
    metrics: Dict[str, List[Dict[str, Any]]] = {}

    # OCI's compute type is "ComputeInstance" — it belongs on this branch, not in
    # the unsupported-type fallback.
    if rtype in ("EC2Instance", "VirtualMachine", "ComputeInstance"):
        if provider == "AWS":
            instance_id = resource.provider_resource_id
            dims = [{"Name": "InstanceId", "Value": instance_id}]
            if cw_client:
                cpu_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/EC2", "CPUUtilization", dims, start, now)
                net_in_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/EC2", "NetworkIn", dims, start, now, 3600, "Sum")
                net_out_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/EC2", "NetworkOut", dims, start, now, 3600, "Sum")
                net_in_kb = {k: round(v / 1024, 2) for k, v in net_in_data.items()}
                net_out_kb = {k: round(v / 1024, 2) for k, v in net_out_data.items()}
            else:
                cpu_data = net_in_kb = net_out_kb = {}
        elif provider == "AZURE":
            resource_uri = resource.provider_resource_id
            if az_monitor_client:
                cpu_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "Percentage CPU", start, now)
                net_in_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "Network In Total", start, now, "Total")
                net_out_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "Network Out Total", start, now, "Total")
                net_in_kb = {k: round(v / 1024, 2) for k, v in net_in_data.items()}
                net_out_kb = {k: round(v / 1024, 2) for k, v in net_out_data.items()}
            else:
                cpu_data = net_in_kb = net_out_kb = {}
        elif provider in ("OCI", "ORACLE"):
            # oci_computeagent is emitted by the Oracle Cloud Agent's monitoring
            # plugin, which is enabled by default on platform images. It is the
            # only one of the three providers that reports memory without an
            # extra agent install, so Memory Utilization is real here.
            ocid = resource.provider_resource_id
            if oci_monitoring_client:
                q = lambda name, stat="mean": _get_oci_stats(
                    oci_monitoring_client, oci_tenancy_ocid, "oci_computeagent",
                    name, ocid, start, now, stat,
                )
                cpu_data = await asyncio.to_thread(q, "CpuUtilization")
                mem_data = await asyncio.to_thread(q, "MemoryUtilization")
                # NetworksBytesIn/Out are CUMULATIVE counters (bytes since boot),
                # so sum/mean/max of the raw samples is meaningless — verified at
                # ~72 GB and climbing monotonically. rate() converts to bytes per
                # second, which is what a throughput chart needs.
                net_in_raw = await asyncio.to_thread(q, "NetworksBytesIn", "rate")
                net_out_raw = await asyncio.to_thread(q, "NetworksBytesOut", "rate")
                net_in_kb = {k: round(v / 1024, 3) for k, v in net_in_raw.items()}
                net_out_kb = {k: round(v / 1024, 3) for k, v in net_out_raw.items()}
            else:
                cpu_data = mem_data = net_in_kb = net_out_kb = {}

            metrics = {
                "CPU Utilization (%)":    _align_to_timestamps(timestamps, cpu_data),
                "Memory Utilization (%)": _align_to_timestamps(timestamps, mem_data),
                "Network In (KB/s)":      _align_to_timestamps(timestamps, net_in_kb),
                "Network Out (KB/s)":     _align_to_timestamps(timestamps, net_out_kb),
            }
            cpu_data = net_in_kb = net_out_kb = None  # consumed above
        else:
            cpu_data = net_in_kb = net_out_kb = {}

        # AWS/Azure share the same three series; OCI already built its own set
        # (with memory) above.
        if cpu_data is not None:
            metrics = {
                "CPU Utilization (%)":  _align_to_timestamps(timestamps, cpu_data),
                "Network In (KB)":      _align_to_timestamps(timestamps, net_in_kb),
                "Network Out (KB)":     _align_to_timestamps(timestamps, net_out_kb),
            }

    elif rtype == "LambdaFunction":
        fn_name = resource.provider_resource_id
        dims = [{"Name": "FunctionName", "Value": fn_name}]
        if cw_client:
            inv_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/Lambda", "Invocations", dims, start, now, 3600, "Sum")
            err_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/Lambda", "Errors", dims, start, now, 3600, "Sum")
            dur_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/Lambda", "Duration", dims, start, now, 3600, "Average")
        else:
            inv_data = err_data = dur_data = {}
        metrics = {
            "Invocations":    _align_to_timestamps(timestamps, inv_data),
            "Errors":         _align_to_timestamps(timestamps, err_data),
            "Duration (ms)":  _align_to_timestamps(timestamps, dur_data),
        }

    elif rtype == "DynamoDBTable":
        table_name = resource.resource_name
        dims = [{"Name": "TableName", "Value": table_name}]
        if cw_client:
            rcu_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/DynamoDB", "ConsumedReadCapacityUnits", dims, start, now, 3600, "Sum")
            wcu_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/DynamoDB", "ConsumedWriteCapacityUnits", dims, start, now, 3600, "Sum")
            lat_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/DynamoDB", "SuccessfulRequestLatency", dims, start, now, 3600, "Average")
        else:
            rcu_data = wcu_data = lat_data = {}
        metrics = {
            "Read Capacity (RCU)":  _align_to_timestamps(timestamps, rcu_data),
            "Write Capacity (WCU)": _align_to_timestamps(timestamps, wcu_data),
            "Latency (ms)":         _align_to_timestamps(timestamps, lat_data),
        }

    elif rtype in ("RDSInstance", "SQLDatabase"):
        if provider == "AWS":
            db_id = resource.provider_resource_id
            dims = [{"Name": "DBInstanceIdentifier", "Value": db_id}]
            if cw_client:
                cpu_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/RDS", "CPUUtilization", dims, start, now)
                conn_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/RDS", "DatabaseConnections", dims, start, now, 3600, "Maximum")
                freemem_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/RDS", "FreeableMemory", dims, start, now)
                freemem_mb = {k: round(v / (1024 * 1024), 2) for k, v in freemem_data.items()}
            else:
                cpu_data = conn_data = freemem_mb = {}
            metrics = {
                "CPU Utilization (%)":      _align_to_timestamps(timestamps, cpu_data),
                "DB Connections":           _align_to_timestamps(timestamps, conn_data),
                "Freeable Memory (MB)":     _align_to_timestamps(timestamps, freemem_mb),
            }
        elif provider == "AZURE":
            resource_uri = resource.provider_resource_id
            if az_monitor_client:
                cpu_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "cpu_percent", start, now)
                conn_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "connection_successful", start, now, "Total")
            else:
                cpu_data = conn_data = {}
            # Azure SQL has no direct freeable-memory equivalent — the metric is
            # omitted entirely rather than charted as fake zeros.
            metrics = {
                "CPU Utilization (%)":      _align_to_timestamps(timestamps, cpu_data),
                "DB Connections":           _align_to_timestamps(timestamps, conn_data),
            }
        else:
            metrics = {}

    elif rtype in ("S3Bucket", "StorageAccount"):
        if provider == "AWS":
            bucket_name = resource.resource_name
            dims_std = [{"Name": "BucketName", "Value": bucket_name}, {"Name": "StorageType", "Value": "StandardStorage"}]
            dims_obj = [{"Name": "BucketName", "Value": bucket_name}, {"Name": "StorageType", "Value": "AllStorageTypes"}]
            s3_start = now - timedelta(days=2)
            if cw_client:
                sz_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/S3", "BucketSizeBytes", dims_std, s3_start, now, 86400, "Average")
                obj_data = await asyncio.to_thread(_get_cw_stats, cw_client, "AWS/S3", "NumberOfObjects", dims_obj, s3_start, now, 86400, "Average")
                sz_mb = {k: round(v / (1024 * 1024), 2) for k, v in sz_data.items()}
            else:
                sz_mb = obj_data = {}
            # S3 storage metrics are daily datapoints — return them at their real
            # timestamps instead of replicating one value across 24 fake hours.
            metrics = {
                "Size (MB)": [
                    {"timestamp": ts, "value": val} for ts, val in sorted(sz_mb.items())
                ],
                "Object Count": [
                    {"timestamp": ts, "value": val} for ts, val in sorted(obj_data.items())
                ],
            }
        elif provider == "AZURE":
            resource_uri = resource.provider_resource_id
            if az_monitor_client:
                sz_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "UsedCapacity", start, now)
                tx_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "Transactions", start, now, "Total")
                sz_mb = {k: round(v / (1024 * 1024), 2) for k, v in sz_data.items()}
            else:
                sz_mb = tx_data = {}
            metrics = {
                "Size (MB)":      _align_to_timestamps(timestamps, sz_mb),
                "Transactions":   _align_to_timestamps(timestamps, tx_data),
            }
        else:
            metrics = {}

    elif rtype in ("EKSCluster", "AKSCluster"):
        if provider == "AZURE":
            resource_uri = resource.provider_resource_id
            if az_monitor_client:
                cpu_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "node_cpu_usage_percentage", start, now)
                mem_data = await asyncio.to_thread(_get_az_stats, az_monitor_client, resource_uri, "node_memory_rss_percentage", start, now)
            else:
                cpu_data = mem_data = {}
            metrics = {
                "Node CPU (%)":     _align_to_timestamps(timestamps, cpu_data),
                "Node Memory (%)":  _align_to_timestamps(timestamps, mem_data),
            }
        else:
            # EKS node metrics require CloudWatch Container Insights, which is
            # not wired up — return nothing rather than fake zero series.
            metrics = {}

    elif rtype == "LoadBalancer" and provider in ("OCI", "ORACLE"):
        # OCI LBaaS — kept separate from the AWS ELB branch below, whose
        # namespaces/dimensions are CloudWatch-only.
        ocid = resource.provider_resource_id
        if oci_monitoring_client:
            q = lambda name, stat="mean": _get_oci_stats(
                oci_monitoring_client, oci_tenancy_ocid, "oci_lbaas",
                name, ocid, start, now, stat,
            )
            # ResponseTimeFirstByte / HealthyBackendServers return no data in
            # oci_lbaas — BackendServers and UnHealthyBackendServers are the
            # names that actually report.
            conn_data = await asyncio.to_thread(q, "AcceptedConnections", "sum")
            bytes_in_raw = await asyncio.to_thread(q, "BytesReceived", "sum")
            bytes_out_raw = await asyncio.to_thread(q, "BytesSent", "sum")
            backend_data = await asyncio.to_thread(q, "BackendServers")
            unhealthy_data = await asyncio.to_thread(q, "UnHealthyBackendServers")
            bytes_in_kb = {k: round(v / 1024, 2) for k, v in bytes_in_raw.items()}
            bytes_out_kb = {k: round(v / 1024, 2) for k, v in bytes_out_raw.items()}
        else:
            conn_data = bytes_in_kb = bytes_out_kb = backend_data = unhealthy_data = {}

        metrics = {
            "Accepted Connections":       _align_to_timestamps(timestamps, conn_data),
            "Bytes Received (KB)":        _align_to_timestamps(timestamps, bytes_in_kb),
            "Bytes Sent (KB)":            _align_to_timestamps(timestamps, bytes_out_kb),
            "Backend Servers":            _align_to_timestamps(timestamps, backend_data),
            "Unhealthy Backend Servers":  _align_to_timestamps(timestamps, unhealthy_data),
        }

    elif rtype == "LoadBalancer":
        lb_name = resource.provider_resource_id
        if lb_name.startswith("arn:"):
            lb_dim_val = "/".join(lb_name.split("loadbalancer/", 1)[-1:])
            dims = [{"Name": "LoadBalancer", "Value": lb_dim_val}]
            ns = "AWS/ApplicationELB"
            req_metric = "RequestCount"
            lat_metric = "TargetResponseTime"
        else:
            dims = [{"Name": "LoadBalancerName", "Value": lb_name}]
            ns = "AWS/ELB"
            req_metric = "RequestCount"
            lat_metric = "Latency"

        if cw_client:
            req_data = await asyncio.to_thread(_get_cw_stats, cw_client, ns, req_metric, dims, start, now, 3600, "Sum")
            lat_data = await asyncio.to_thread(_get_cw_stats, cw_client, ns, lat_metric, dims, start, now)
        else:
            req_data = lat_data = {}

        metrics = {
            "Request Count":    _align_to_timestamps(timestamps, req_data),
            "Latency (s)":      _align_to_timestamps(timestamps, lat_data),
        }

    elif rtype == "AutonomousDatabase":
        # oci_autonomous_database is emitted by the service itself — no agent
        # involved, so this works for any ADB the credentials can see.
        ocid = resource.provider_resource_id
        if oci_monitoring_client:
            q = lambda name, stat="mean": _get_oci_stats(
                oci_monitoring_client, oci_tenancy_ocid, "oci_autonomous_database",
                name, ocid, start, now, stat,
            )
            cpu_data = await asyncio.to_thread(q, "CpuUtilization")
            storage_data = await asyncio.to_thread(q, "StorageUtilization")
            # CurrentLogons is a gauge — summing the per-minute samples over an
            # hour would report ~60x the real session count.
            sessions_data = await asyncio.to_thread(q, "CurrentLogons", "mean")
            exec_data = await asyncio.to_thread(q, "ExecuteCount", "sum")
        else:
            cpu_data = storage_data = sessions_data = exec_data = {}

        metrics = {
            "CPU Utilization (%)":     _align_to_timestamps(timestamps, cpu_data),
            "Storage Utilization (%)": _align_to_timestamps(timestamps, storage_data),
            "Current Logons":          _align_to_timestamps(timestamps, sessions_data),
            "Execute Count":           _align_to_timestamps(timestamps, exec_data),
        }

    elif rtype == "ObjectStorageBucket":
        # Object Storage identifies buckets by resourceDisplayName (the bucket
        # name) and resourceID — both are covered by the client-side matcher, so
        # the bucket name is the value to match on.
        if oci_monitoring_client:
            q = lambda name, stat="mean": _get_oci_stats(
                oci_monitoring_client, oci_tenancy_ocid, "oci_objectstorage",
                name, resource.resource_name, start, now, stat,
            )
            size_raw = await asyncio.to_thread(q, "StoredBytes")
            objects_data = await asyncio.to_thread(q, "ObjectCount")
            size_gb = {k: round(v / (1024 ** 3), 3) for k, v in size_raw.items()}
        else:
            size_gb = objects_data = {}

        metrics = {
            "Stored Size (GB)": _align_to_timestamps(timestamps, size_gb),
            "Object Count":     _align_to_timestamps(timestamps, objects_data),
        }

    else:
        # Unsupported resource type — no invented metric names/values
        metrics = {}
        unsupported_type = True

    # realtime is true only when at least one REAL datapoint came back —
    # a constructed client whose queries all failed does not count.
    has_real_data = any(len(series) > 0 for series in metrics.values())

    source_label = {
        "AWS": "AWS CloudWatch",
        "AZURE": "Azure Monitor",
        "OCI": "OCI Monitoring",
        "ORACLE": "OCI Monitoring",
    }.get(provider)

    diagnostic = None
    if not has_real_data:
        diagnostic = _build_metrics_diagnostic(
            provider=provider,
            resource_type=rtype,
            unsupported_type=unsupported_type,
            client_error=client_error,
            query_errors=_metric_errors.get() or [],
            source_label=source_label,
        )

    return {
        "resource_id":   str(resource_id),
        "resource_type": rtype,
        "metrics":       metrics,
        "realtime":      has_real_data,
        "provider":      provider,
        # Real metrics source, for honest UI labeling
        "source": source_label,
        # Why the panel is empty — real reasons only, never a guess.
        "diagnostic": diagnostic,
    }
