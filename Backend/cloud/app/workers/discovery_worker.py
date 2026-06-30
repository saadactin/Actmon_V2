"""
Discovery background runner — no Celery, no Redis.
Uses asyncio tasks directly inside FastAPI's event loop.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

logger = logging.getLogger("cloud_svc.discovery_runner")


async def run_discovery_scan(job_id: uuid.UUID, account_id: uuid.UUID) -> None:
    """
    Async background task that:
      1. Decrypts credentials for the account
      2. Authenticates with the cloud provider
      3. Scans all resources across ALL regions
      4. Upserts results into the DB
      5. Updates job status throughout
    """
    from app.core.database import AsyncSessionLocal
    from app.repository.cloud_account_repo import CloudAccountRepository
    from app.repository.discovery_repo import DiscoveryRepository
    from app.repository.resource_repo import ResourceRepository
    from app.utils.encryption import decrypt_credentials

    logger.info("Discovery started: job=%s account=%s", job_id, account_id)

    async with AsyncSessionLocal() as db:
        disco_repo = DiscoveryRepository(db)
        account_repo = CloudAccountRepository(db)
        resource_repo = ResourceRepository(db)

        # Mark as RUNNING
        await disco_repo.set_running(job_id, task_id=str(job_id))
        await db.commit()

        try:
            account = await account_repo.get_by_id(account_id)
            if not account:
                await disco_repo.fail_job(job_id, "Account not found")
                await db.commit()
                return

            credentials = decrypt_credentials(account.credentials_enc)
            provider_name = account.provider.upper()

            from app.providers.aws.aws_provider import AWSProvider
            from app.providers.azure.azure_provider import AzureProvider
            from app.providers.oci.oci_provider import OCIProvider

            provider_map = {
                "AWS": AWSProvider,
                "AZURE": AzureProvider,
                "ORACLE": OCIProvider,
                "OCI": OCIProvider,
            }
            ProviderClass = provider_map.get(provider_name)
            if not ProviderClass:
                await disco_repo.fail_job(job_id, f"Unknown provider: {provider_name}")
                await db.commit()
                return

            provider = ProviderClass(credentials)

            await provider.authenticate()
            logger.info("Provider auth OK for job=%s", job_id)

            resources = await provider.scan_resources()
            logger.info("Scan returned %d resources for job=%s", len(resources), job_id)

            # Wipe old stale data before upserting fresh results
            await resource_repo.delete_by_account(account_id)
            count = await resource_repo.upsert_resources(account_id, resources)

            # Estimate and update monthly costs
            try:
                from app.services.cost_service import estimate_costs
                estimates = await estimate_costs(account_id, db)
                for est in estimates.get("breakdown", []):
                    res_id = uuid.UUID(est["resource_id"])
                    res = await resource_repo.get_by_id(res_id)
                    if res:
                        res.cost_monthly = est["monthly_cost"]
            except Exception as cost_exc:
                logger.error("Failed to calculate costs during discovery: %s", cost_exc)

            await account_repo.update_last_discovery(account_id)
            await disco_repo.complete_job(job_id, count)
            await db.commit()

            logger.info(
                "Discovery complete: job=%s account=%s resources=%d",
                job_id, account_id, count,
            )

        except Exception as exc:
            logger.error(
                "Discovery failed: job=%s error=%s", job_id, exc, exc_info=True
            )
            await disco_repo.fail_job(job_id, str(exc))
            await db.commit()
