"""Quick debug script to test billing API calls directly."""
import asyncio
import sys
import os
import traceback

# Add parent to path so we can import app modules
sys.path.insert(0, os.path.dirname(__file__))

async def main():
    from app.core.config import settings
    from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
    from sqlalchemy.orm import sessionmaker
    from app.repository.cloud_account_repo import CloudAccountRepository
    from app.services.cost_service import _build_provider

    engine = create_async_engine(settings.async_database_url)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with async_session() as db:
        repo = CloudAccountRepository(db)
        accounts = await repo.list_all()

        for acc in accounts:
            print(f"\n{'='*60}")
            print(f"Account: {acc.account_name} ({acc.provider})")
            print(f"ID: {acc.id}")
            print(f"{'='*60}")

            provider = _build_provider(acc)
            if provider is None:
                print("  ERROR: Could not build provider (credential decryption failed?)")
                continue

            print(f"  Provider built successfully: {type(provider).__name__}")

            # Test get_cost_data
            print(f"\n  Testing get_cost_data()...")
            try:
                rows = await provider.get_cost_data()
                print(f"  SUCCESS: got {len(rows)} rows")
                if rows:
                    for r in rows[:5]:
                        print(f"    - {r.get('resource_name')}: {r.get('monthly_cost')} {r.get('currency')}")
                    if len(rows) > 5:
                        print(f"    ... and {len(rows)-5} more")
                else:
                    print("  WARNING: returned empty list (no cost data)")
            except Exception as exc:
                print(f"  FAILED: {exc}")
                traceback.print_exc()

            # Test get_daily_costs
            if hasattr(provider, 'get_daily_costs'):
                print(f"\n  Testing get_daily_costs()...")
                try:
                    daily = await provider.get_daily_costs()
                    print(f"  SUCCESS: got {len(daily)} days")
                    if daily:
                        print(f"    First: {daily[0]}")
                        print(f"    Last:  {daily[-1]}")
                    else:
                        print("  WARNING: returned empty list")
                except Exception as exc:
                    print(f"  FAILED: {exc}")
                    traceback.print_exc()

    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(main())
