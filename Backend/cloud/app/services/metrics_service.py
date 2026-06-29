"""Metrics service — fetches real-time performance metrics from AWS CloudWatch & Azure Monitor.

For each supported resource type we call the respective cloud provider's metrics API.
If the call fails (permissions, no data) we return a flat zero-baseline so the UI
always gets well-shaped data.
"""
from __future__ import annotations

import asyncio
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

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _zero_series(timestamps: List[str]) -> List[Dict[str, Any]]:
    return [{"timestamp": ts, "value": 0} for ts in timestamps]


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
        return {}


def _align_to_timestamps(
    ts_list: List[str],
    data: Dict[str, float],
) -> List[Dict[str, Any]]:
    if not data:
        return _zero_series(ts_list)
    return [{"timestamp": ts, "value": data.get(ts, 0)} for ts in ts_list]


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

    # ── Fetch the cloud account's credentials ─────────────────────────────
    cw_client = None
    az_monitor_client = None
    provider = "UNKNOWN"
    
    region = resource.region_or_zone or "us-east-1"
    if len(region) > 1 and region[-1].isalpha() and region[-2] == '-':
        parts = region.rsplit('-', 1)
        if parts[-1][-1].isalpha() and len(parts[-1]) > 1:
            region = parts[0] + '-' + parts[-1][:-1]

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
    except Exception as exc:
        logger.warning("Could not build metrics client for resource %s: %s", resource_id, exc)

    # ── Fetch metrics per resource type ──────────────────────────────────
    metrics: Dict[str, List[Dict[str, Any]]] = {}

    if rtype in ("EC2Instance", "VirtualMachine"):
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
        else:
            cpu_data = net_in_kb = net_out_kb = {}

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
            metrics = {
                "CPU Utilization (%)":      _align_to_timestamps(timestamps, cpu_data),
                "DB Connections":           _align_to_timestamps(timestamps, conn_data),
                "Freeable Memory (MB)":     _zero_series(timestamps),
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
            size_val  = next(iter(sz_mb.values()),  0)
            obj_val   = next(iter(obj_data.values()), 0)
            metrics = {
                "Size (MB)":      [{"timestamp": ts, "value": size_val}  for ts in timestamps],
                "Object Count":   [{"timestamp": ts, "value": obj_val}   for ts in timestamps],
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
            metrics = {
                "Node CPU (%)":     _zero_series(timestamps),
                "Node Memory (%)":  _zero_series(timestamps),
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

    else:
        metrics = {
            "Activity":   _zero_series(timestamps),
            "Latency (ms)": _zero_series(timestamps),
        }

    return {
        "resource_id":   str(resource_id),
        "resource_type": rtype,
        "metrics":       metrics,
        "realtime":      cw_client is not None or az_monitor_client is not None,
    }
