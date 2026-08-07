"""Exercise get_resource_metrics against real OCI resources.

Metric names are the risky part of the OCI implementation — a wrong name returns
an empty series rather than an error, so this prints per-series datapoint counts
for one resource of each supported type.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TYPES = ["ComputeInstance", "AutonomousDatabase", "LoadBalancer", "ObjectStorageBucket"]


async def main():
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.config import settings
    from app.models.cloud_account import CloudAccount
    from app.models.resource import CloudResource
    from app.services.metrics_service import get_resource_metrics

    engine = create_async_engine(settings.async_database_url)
    Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Session() as db:
        acc = (await db.execute(
            select(CloudAccount).where(CloudAccount.provider.in_(["OCI", "Oracle"]))
        )).scalars().first()
        if not acc:
            print("No OCI account registered")
            return
        print(f"Account: {acc.account_name} ({acc.provider})\n")

        for rtype in TYPES:
            rows = (await db.execute(
                select(CloudResource)
                .where(CloudResource.account_id == acc.id)
                .where(CloudResource.resource_type == rtype)
                .limit(2)
            )).scalars().all()
            if not rows:
                print(f"── {rtype}: none discovered\n")
                continue

            for res in rows:
                print(f"── {rtype}: {res.resource_name}")
                print(f"   status={res.status}  region_or_zone={res.region_or_zone}")
                print(f"   compartment={(res.metadata_ or {}).get('compartment_id', 'N/A')[:40]}")
                out = await get_resource_metrics(res.id, db)
                print(f"   provider={out.get('provider')}  realtime={out.get('realtime')}"
                      f"  source={out.get('source')}")
                m = out.get("metrics") or {}
                if not m:
                    print("   !! metrics dict EMPTY (type not handled)")
                for name, series in m.items():
                    n = len(series)
                    if n:
                        vals = [d["value"] for d in series]
                        print(f"     {n:>3} pts  {name:<26} "
                              f"min={min(vals)} max={max(vals)} last={vals[-1]}")
                    else:
                        print(f"       0 pts  {name:<26} (no data returned)")
                print()

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
