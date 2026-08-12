"""Probe candidate OCI metric names to find which actually return data.

list_metrics is paginated and returned only a partial list, so metric names are
verified the direct way: run each candidate unfiltered at the tenancy root and
report how many datapoints come back. Only names proven here get wired into
metrics_service.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CANDIDATES = {
    "oci_computeagent": [
        ("CpuUtilization", "mean"), ("MemoryUtilization", "mean"),
        ("NetworksBytesIn", "sum"), ("NetworksBytesOut", "sum"),
        ("DiskBytesRead", "sum"), ("DiskBytesWritten", "sum"),
        ("DiskIopsRead", "mean"), ("DiskIopsWritten", "mean"),
        ("LoadAverage", "mean"),
    ],
    "oci_autonomous_database": [
        ("CpuUtilization", "mean"), ("StorageUtilization", "mean"),
        ("CurrentLogons", "sum"), ("ExecuteCount", "sum"),
        ("AverageActiveSessions", "mean"), ("ConnectionLatency", "mean"),
        ("CPUTime", "sum"), ("DBBlockChanges", "sum"),
        ("TransactionCount", "sum"), ("UserCalls", "sum"),
        ("SessionCount", "mean"), ("StorageAllocated", "mean"),
    ],
    "oci_lbaas": [
        ("AcceptedConnections", "sum"), ("ActiveConnections", "mean"),
        ("BytesReceived", "sum"), ("BytesSent", "sum"),
        ("BackendServers", "mean"), ("UnHealthyBackendServers", "mean"),
        ("ClosedConnections", "sum"), ("BackendTimeouts", "sum"),
        ("ResponseTimeFirstByte", "mean"), ("HealthyBackendServers", "mean"),
    ],
    "oci_objectstorage": [
        ("StoredBytes", "mean"), ("ObjectCount", "mean"),
        ("BucketCount", "mean"), ("AllRequests", "sum"),
    ],
}


async def main():
    import oci
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.config import settings
    from app.models.cloud_account import CloudAccount
    from app.providers.oci.oci_auth import OCIAuth
    from app.utils.encryption import decrypt_credentials

    engine = create_async_engine(settings.async_database_url)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as db:
        acc = (await db.execute(
            select(CloudAccount).where(CloudAccount.provider.in_(["OCI", "Oracle"]))
        )).scalars().first()
        auth = OCIAuth(decrypt_credentials(acc.credentials_enc))
    await engine.dispose()

    cfg = auth.get_config()
    cfg["region"] = "ap-mumbai-1"
    mon = oci.monitoring.MonitoringClient(cfg)
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)

    for ns, names in CANDIDATES.items():
        print("=" * 74)
        print(ns)
        print("=" * 74)
        for metric, stat in names:
            try:
                d = oci.monitoring.models.SummarizeMetricsDataDetails(
                    namespace=ns, query=f"{metric}[1h].{stat}()",
                    start_time=start, end_time=now,
                )
                r = mon.summarize_metrics_data(
                    compartment_id=auth.tenancy_ocid,
                    summarize_metrics_data_details=d,
                    compartment_id_in_subtree=True,
                )
                series = r.data or []
                pts = sum(len(s.aggregated_datapoints or []) for s in series)
                if pts:
                    keys = sorted((series[0].dimensions or {}).keys())
                    id_keys = [k for k in keys if 'resource' in k.lower() or 'name' in k.lower()]
                    print(f"  OK    {metric:<24}.{stat:<5} {len(series):>3} streams {pts:>5} pts  id-dims={id_keys}")
                else:
                    print(f"  empty {metric:<24}.{stat:<5} (valid name, no data)")
            except Exception as exc:
                code = getattr(exc, 'code', type(exc).__name__)
                print(f"  BAD   {metric:<24}.{stat:<5} {code}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
