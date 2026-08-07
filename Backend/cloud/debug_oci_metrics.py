"""Find out what OCI Monitoring actually exposes for this tenancy.

summarize_metrics_data returned an empty list with no error, so the query is
syntactically valid but matches no stream. list_metrics enumerates the namespaces,
metric names and dimension keys that genuinely exist, which settles whether the
metric names are wrong, the compartment is wrong, or nothing is being emitted.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


async def main():
    import oci
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.config import settings
    from app.models.cloud_account import CloudAccount
    from app.models.resource import CloudResource
    from app.providers.oci.oci_auth import OCIAuth
    from app.utils.encryption import decrypt_credentials

    engine = create_async_engine(settings.async_database_url)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        acc = (await db.execute(
            select(CloudAccount).where(CloudAccount.provider.in_(["OCI", "Oracle"]))
        )).scalars().first()
        creds = decrypt_credentials(acc.credentials_enc)
        auth = OCIAuth(creds)
        tenancy = auth.tenancy_ocid

        inst = (await db.execute(
            select(CloudResource)
            .where(CloudResource.account_id == acc.id)
            .where(CloudResource.resource_type == "ComputeInstance")
            .where(CloudResource.status == "RUNNING")
            .limit(1)
        )).scalars().first()

    cfg = auth.get_config()
    cfg["region"] = "ap-mumbai-1"
    mon = oci.monitoring.MonitoringClient(cfg)

    print(f"tenancy   : {tenancy}")
    print(f"region    : {cfg['region']}")
    print(f"instance  : {inst.resource_name}  {inst.provider_resource_id}")
    inst_compartment = (inst.metadata_ or {}).get("compartment_id")
    print(f"compartment: {inst_compartment}")

    # ── 1. What metric streams exist, tenancy-wide? ──────────────────────────
    for scope_label, comp in (("TENANCY ROOT", tenancy), ("INSTANCE COMPARTMENT", inst_compartment)):
        print("\n" + "=" * 74)
        print(f"list_metrics from {scope_label}")
        print("=" * 74)
        try:
            resp = mon.list_metrics(
                compartment_id=comp,
                list_metrics_details=oci.monitoring.models.ListMetricsDetails(),
                compartment_id_in_subtree=True,
            )
            items = resp.data or []
            print(f"  {len(items)} metric streams returned")
            seen = {}
            for m in items:
                seen.setdefault(m.namespace, set()).add(m.name)
            for ns, names in sorted(seen.items()):
                print(f"    {ns}: {len(names)} metrics")
                print(f"       {', '.join(sorted(names)[:12])}")
            # Show dimension keys for the compute namespace
            for m in items:
                if m.namespace == "oci_computeagent":
                    print(f"\n    sample oci_computeagent stream: name={m.name}")
                    print(f"      dimensions={m.dimensions}")
                    break
        except Exception as exc:
            print(f"  FAILED: {type(exc).__name__}: {str(exc)[:300]}")

    # ── 2. Unfiltered query — is anything at all being aggregated? ───────────
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=24)
    print("\n" + "=" * 74)
    print("summarize_metrics_data WITHOUT a dimension filter")
    print("=" * 74)
    for ns, metric in (("oci_computeagent", "CpuUtilization"),
                       ("oci_autonomous_database", "CpuUtilization"),
                       ("oci_lbaas", "AcceptedConnections"),
                       ("oci_objectstorage", "StoredBytes")):
        for comp_label, comp in (("root", tenancy), ("inst-comp", inst_compartment)):
            try:
                d = oci.monitoring.models.SummarizeMetricsDataDetails(
                    namespace=ns, query=f"{metric}[1h].mean()",
                    start_time=start, end_time=now,
                )
                r = mon.summarize_metrics_data(
                    compartment_id=comp, summarize_metrics_data_details=d,
                    compartment_id_in_subtree=True,
                )
                series = r.data or []
                pts = sum(len(s.aggregated_datapoints or []) for s in series)
                print(f"  {ns:<26} {metric:<20} [{comp_label:<9}] -> {len(series)} streams, {pts} points")
                if series:
                    s0 = series[0]
                    print(f"      dims={s0.dimensions}")
                    if s0.aggregated_datapoints:
                        dp = s0.aggregated_datapoints[-1]
                        print(f"      last: {dp.timestamp} = {dp.value}")
            except Exception as exc:
                print(f"  {ns:<26} {metric:<20} [{comp_label:<9}] -> {type(exc).__name__}: {str(exc)[:150]}")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
