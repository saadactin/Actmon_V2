"""
Discovery background runner — no Celery, no Redis.
Uses asyncio tasks directly inside FastAPI's event loop.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

logger = logging.getLogger("cloud_svc.discovery_runner")

# Keep a strong reference to fire-and-forget cache-warming tasks so the event
# loop doesn't garbage-collect them mid-run.
_warm_tasks: set[asyncio.Task] = set()


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

            # Incremental persistence: each batch of resources is upserted and the
            # job's live count is updated the moment it's discovered, so the UI can
            # show progress every few seconds instead of waiting for the full scan.
            # Rows are NOT deleted up front — we prune whatever wasn't re-seen at the
            # end, so a partial/failed scan never leaves the account empty.
            seen_ids: set[str] = set()
            write_lock = asyncio.Lock()

            async def on_batch(batch: list[dict]) -> None:
                if not batch:
                    return
                async with write_lock:  # serialize writes on the shared session
                    await resource_repo.upsert_resources(account_id, batch)
                    for r in batch:
                        pid = r.get("provider_resource_id")
                        if pid:
                            seen_ids.add(pid)
                    await disco_repo.set_progress(job_id, len(seen_ids))
                    await db.commit()
                    logger.info("Discovery job=%s progress: %d resources", job_id, len(seen_ids))

            resources = await provider.scan_resources(on_batch=on_batch)

            # A sweep that couldn't enumerate every scope returns a SUBSET of
            # reality. Pruning against a subset deletes live resources: one
            # unreachable region reduced a 127-resource OCI account to the 65
            # global IAM objects that happened to list successfully. Only a clean
            # sweep is authoritative enough to delete anything.
            failures = provider.scan_failures()

            if seen_ids and failures:
                count = len(seen_ids)
                logger.warning(
                    "Discovery job=%s found %d resources but %d scope(s) failed to "
                    "enumerate — SKIPPING prune to avoid deleting live resources. "
                    "Stale rows (if any) will clear on the next clean scan. First: %s",
                    job_id, count, len(failures), failures[:3],
                )
                await disco_repo.set_partial(
                    job_id,
                    f"Incomplete sweep: {len(failures)} scope(s) failed to enumerate, so "
                    f"existing resources were kept rather than pruned. First failure: "
                    f"{failures[0]}",
                )
                await db.commit()
            elif seen_ids:
                # Streamed path: batches already persisted. Prune rows from prior
                # scans that weren't seen this time.
                async with write_lock:
                    removed = await resource_repo.delete_stale(account_id, list(seen_ids))
                    await db.commit()
                count = len(seen_ids)
                logger.info("Discovery job=%s pruned %d stale resources", job_id, removed)
            elif resources:
                # Nothing streamed (e.g. on_batch failed for every batch) but the
                # provider did return resources — persist them without wiping first.
                count = await resource_repo.upsert_resources(account_id, resources)
                await db.commit()
            else:
                # Scan returned nothing at all. This can mean a genuinely empty
                # account, or it can mean every region/compartment scan silently
                # swallowed a transient error (throttling, expired session, etc.)
                # without raising. We can't tell those apart here, so never wipe
                # an account that already has resources on file — do that only
                # for a brand-new account with nothing to lose.
                existing_count = await resource_repo.count_by_account(account_id)
                if existing_count > 0:
                    raise RuntimeError(
                        f"Scan returned 0 resources but account already has "
                        f"{existing_count} on file; refusing to wipe existing "
                        "inventory. Treating this as a failed scan."
                    )
                count = 0

            # Per-resource cost_monthly stays as the provider reported it (usually
            # None → NA in the UI). Account-level spend comes from the billing API
            # via the cost service — no config-based estimates are fabricated here.

            from app.services.alerting_service import check_storage_attachment_alerts

            check_storage_attachment_alerts(
                account.account_name, resources, account_id=str(account_id)
            )

            # Fire-and-forget: warm the cost cache now so the Cost page's
            # first load after this scan doesn't pay a cold 30-50s billing
            # API round trip. Not awaited — must not delay job completion.
            from app.services.cost_service import prewarm_cost_cache

            warm_task = asyncio.create_task(prewarm_cost_cache(account))
            _warm_tasks.add(warm_task)
            warm_task.add_done_callback(_warm_tasks.discard)

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
