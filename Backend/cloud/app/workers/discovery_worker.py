"""
Discovery background runner — no Celery, no Redis.
Uses asyncio tasks directly inside FastAPI's event loop.
"""
from __future__ import annotations

import asyncio
import logging
import uuid

logger = logging.getLogger("cloud_svc.discovery_runner")


def partial_sweep_note(failures, scope) -> str:
    """The job's note for an incomplete sweep: what share was read and what
    kept the rest from being read, rather than only the first failure."""
    if scope and scope.get("attempted"):
        parts = [f"{scope.get('read', 0)} of {scope['attempted']} scopes read"]
        denied = scope.get("denied") or {}
        if denied:
            parts.append("not permitted for these credentials: " + ", ".join(
                f"{label} ({len(entry.get('regions') or [])} region"
                f"{'' if len(entry.get('regions') or []) == 1 else 's'})"
                for label, entry in sorted(denied.items())))
        failed = scope.get("failed") or []
        n_failed = int(scope.get("failed_count") or len(failed))  # the list is capped
        if n_failed:
            parts.append(f"{n_failed} did not answer"
                         + (f" (first: {failed[0].get('scope')})" if failed else ""))
        return ("Incomplete sweep: " + "; ".join(parts)
                + ". Existing resources were kept rather than pruned.")
    return (f"Incomplete sweep: {len(failures)} scope(s) failed to enumerate, so existing "
            f"resources were kept rather than pruned. First failure: {failures[0]}")

def resources_detail(count, failures, scope) -> str:
    """The refresh's resources line: how many are on file and, when the sweep
    was incomplete, how much of the account it actually read."""
    line = f"{count} resource(s) in inventory"
    if not failures:
        return line + "."
    if scope and scope.get("attempted"):
        return (f"{line}; {scope.get('read', 0)} of {scope['attempted']} scopes read — "
                "the rest was not permitted or did not answer (the Security "
                "Center's Coverage tab says which).")
    return f"{line}; {len(failures)} scope(s) could not be read."


# Keep a strong reference to fire-and-forget cache-warming tasks so the event
# loop doesn't garbage-collect them mid-run.
_warm_tasks: set[asyncio.Task] = set()


async def run_discovery_scan(
    job_id: uuid.UUID, account_id: uuid.UUID,
    refresh_id: uuid.UUID | None = None,
) -> None:
    """
    Async background task that:
      1. Decrypts credentials for the account
      2. Authenticates with the cloud provider
      3. Scans all resources across ALL regions
      4. Upserts results into the DB
      5. Updates job status throughout

    `refresh_id` is optional and changes NOTHING about what this does. When an
    Account Refresh drove this scan it passes its id, and each stage stamps its
    outcome onto that refresh record — which is how a refresh can report
    "inventory fresh, cost throttled" instead of one opaque success.

    The stamping is fire-and-forget by design. This worker already treats cost
    and security failures as non-fatal so that a good inventory sweep is never
    thrown away; bookkeeping about them must not become the thing that breaks
    it.
    """
    from app.services.account_refresh_service import set_component as _stamp

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

        # Bound outside the try so the failure handler can tell "this job was
        # logging drift" from "it died before it got that far".
        drift_job_id: uuid.UUID | None = None

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

            await _stamp(refresh_id, "connection", "RUNNING")
            await provider.authenticate()
            logger.info("Provider auth OK for job=%s", job_id)
            # AWS keys do not say which account they belong to; STS just did.
            # Recorded once so organisation onboarding can recognise this
            # account as already connected.
            if not account.provider_account_id:
                learned = getattr(getattr(provider, "auth", None), "account_id", None)
                if learned:
                    account.provider_account_id = learned
                    await db.commit()
            await _stamp(refresh_id, "connection", "SUCCEEDED",
                         detail=f"Authenticated to {provider_name}.")
            await _stamp(refresh_id, "resources", "RUNNING")

            # Incremental persistence: each batch of resources is upserted and the
            # job's live count is updated the moment it's discovered, so the UI can
            # show progress every few seconds instead of waiting for the full scan.
            # Rows are NOT deleted up front — we prune whatever wasn't re-seen at the
            # end, so a partial/failed scan never leaves the account empty.
            seen_ids: set[str] = set()
            write_lock = asyncio.Lock()

            # Configuration drift is only meaningful against a known previous
            # state. Decided ONCE, before any batch lands: an account with
            # nothing on file is being baselined, and calling all 1,500 of its
            # resources "new" would be noise, not history. Checking per-batch
            # would get this wrong — batch 2 always sees batch 1's rows and
            # would report every later resource as freshly created.
            baseline_count = await resource_repo.count_by_account(account_id)
            if baseline_count > 0:
                drift_job_id = job_id
            if drift_job_id is None:
                logger.info(
                    "Discovery job=%s account has no inventory on file — this sweep "
                    "establishes the drift baseline, no changes will be logged.", job_id,
                )

            async def on_batch(batch: list[dict]) -> None:
                if not batch:
                    return
                async with write_lock:  # serialize writes on the shared session
                    await resource_repo.upsert_resources(
                        account_id, batch, drift_job_id=drift_job_id
                    )
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
            # What was read, scope by scope — kept on the job so coverage (and
            # every later assessment of this inventory) reports the real share
            # instead of 0% for any imperfect sweep.
            # Optional, and never allowed to fail the sweep: a provider that
            # does not count its scopes (or one whose count breaks) simply
            # has no summary, and coverage falls back to complete / incomplete.
            scope = None
            try:
                summary_fn = getattr(provider, "scope_summary", None)
                scope = summary_fn() if callable(summary_fn) else None
                await disco_repo.set_scope_summary(job_id, scope)
            except Exception as scope_exc:  # noqa: BLE001
                logger.warning("Scope summary unavailable for job=%s: %s", job_id, scope_exc)
                scope = None

            if seen_ids and failures:
                count = len(seen_ids)
                logger.warning(
                    "Discovery job=%s found %d resources but %d scope(s) failed to "
                    "enumerate — SKIPPING prune to avoid deleting live resources. "
                    "Stale rows (if any) will clear on the next clean scan. First: %s",
                    job_id, count, len(failures), failures[:3],
                )
                await disco_repo.set_partial(job_id, partial_sweep_note(failures, scope))
                # A partial sweep could not prune, but it DID observe what it
                # enumerated. Those rows are fresh; the ones it never reached
                # keep their old timestamp and correctly read as stale.
                await resource_repo.mark_seen(account_id, list(seen_ids))
                # The change log gets a narrower version of the same caution. A
                # scope that fails to enumerate produces MISSING data, not wrong
                # data — whatever this sweep did report, it genuinely read from
                # the provider. So a field that changed to a new value is still
                # trustworthy, while a field that went empty may simply have
                # been unreadable. Only the latter is discarded. Dropping the
                # whole sweep instead would mean an account that routinely has a
                # few unreachable scopes never shows any drift at all.
                if drift_job_id:
                    from app.repository.drift_repo import DriftRepository

                    dropped = await DriftRepository(db).delete_unreliable_for_job(drift_job_id)
                    if dropped:
                        logger.warning(
                            "Discovery job=%s discarded %d change-log row(s) whose value "
                            "went empty during an incomplete sweep (possible scan gap, "
                            "not a confirmed removal).", job_id, dropped,
                        )
                await db.commit()
            elif seen_ids:
                # Streamed path: batches already persisted. Prune rows from prior
                # scans that weren't seen this time.
                async with write_lock:
                    removed = await resource_repo.delete_stale(
                        account_id, list(seen_ids), drift_job_id=drift_job_id
                    )
                    # Everything this sweep enumerated was observed just now,
                    # whether or not any of its fields moved.
                    await resource_repo.mark_seen(account_id, list(seen_ids))
                    await db.commit()
                count = len(seen_ids)
                logger.info("Discovery job=%s pruned %d stale resources", job_id, removed)
            elif resources:
                # Nothing streamed (e.g. on_batch failed for every batch) but the
                # provider did return resources — persist them without wiping first.
                count = await resource_repo.upsert_resources(
                    account_id, resources, drift_job_id=drift_job_id
                )
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

            # Alerts are a side effect of discovery, not its purpose, and they now
            # write to the DB. Give them their own session so an alerting failure
            # can't poison the scan's transaction (the handler below still needs a
            # usable session to record job failure), and swallow errors so a
            # successful scan is never reported as failed because of them.
            from app.services.alerting_service import check_storage_attachment_alerts

            try:
                async with AsyncSessionLocal() as alert_db:
                    await check_storage_attachment_alerts(
                        alert_db,
                        account.account_name,
                        resources,
                        account_id=account_id,
                        sweep_complete=not failures,
                    )
            except Exception as alert_exc:
                logger.warning(
                    "Storage-attachment alert check failed for job=%s: %s",
                    job_id, alert_exc, exc_info=True,
                )

            # Fire-and-forget: warm the cost cache now so the Cost page's
            # first load after this scan doesn't pay a cold 30-50s billing
            # API round trip. Not awaited — must not delay job completion.
            from app.services.cost_service import prewarm_cost_cache

            warm_task = asyncio.create_task(prewarm_cost_cache(account))
            _warm_tasks.add(warm_task)
            warm_task.add_done_callback(_warm_tasks.discard)

            # Persist the recent billing window into cloud_cost_facts.
            #
            # Without this the fact table stays empty forever, and everything
            # built on stored history — the trend, forecast, anomalies,
            # month-over-month, budgets — reports "needs more history" in
            # perpetuity with no way for a user to get out of that state.
            # Ingestion is idempotent, so running it on every scan re-reads and
            # CORRECTS the last 30 days rather than duplicating them; that
            # repeated re-reading is also what eventually earns a fact its
            # STABLE finality.
            #
            # Its own session, because this runs detached and the caller's
            # session closes when the job completes.
            async def _ingest_costs():
                from app.core.database import AsyncSessionLocal as _Session
                from app.services.cost_ingestion import ingest_recent

                try:
                    async with _Session() as _db:
                        outcome = await ingest_recent(_db, account, days=30)
                    if outcome.get("ok"):
                        logger.info(
                            "Cost ingestion for %s: %d fact(s) written, %d corrected",
                            account.account_name, outcome.get("inserted", 0),
                            outcome.get("updated", 0),
                        )
                        await _stamp(
                            refresh_id, "cost", "SUCCEEDED",
                            detail=(f"{outcome.get('inserted', 0)} billing fact(s) "
                                    f"written, {outcome.get('updated', 0)} corrected."))
                    else:
                        # `ok: false` is the provider declining, not a crash —
                        # a 403 on Cost Explorer, or a throttle. It carries the
                        # reason, and that reason is the whole value of
                        # reporting this component separately.
                        await _stamp(
                            refresh_id, "cost", "FAILED",
                            detail=str(outcome.get("error")
                                       or outcome.get("message")
                                       or "The provider returned no billing data.")[:400])
                except Exception as exc:  # never fail a completed scan on this
                    logger.warning(
                        "Cost ingestion failed for %s: %s", account.account_name, exc,
                    )
                    await _stamp(refresh_id, "cost", "FAILED",
                                 detail=str(exc)[:400])

            # Same split as event collection below, and for the same reason.
            #
            # A plain Run Discovery fires and forgets: billing APIs take 30-50s
            # and a completed inventory sweep must not wait on them.
            #
            # An Account Refresh AWAITS it, because it has to grade the run.
            # Detaching it there is a race the refresh loses on any account
            # whose event collection finishes first: grading reads `cost` while
            # it is still PENDING, counts it as neither success nor failure,
            # and reports SUCCEEDED for a run whose billing data never
            # arrived — or worse, stamps FAILED onto a run already graded
            # green. A component nobody waited for cannot be reported on
            # honestly.
            if refresh_id is None:
                ingest_task = asyncio.create_task(_ingest_costs())
                _warm_tasks.add(ingest_task)
                ingest_task.add_done_callback(_warm_tasks.discard)
            else:
                await _stamp(refresh_id, "cost", "RUNNING")
                await _ingest_costs()

            # Also fire-and-forget: pull this account's audit events now, so
            # the Event Log has the control-plane activity that explains the
            # inventory this scan just recorded. Not awaited — an audit API
            # that is throttled or unreachable must not delay a completed scan,
            # and collect_account never raises for a provider failure (it
            # records the failure in cloud_event_sync_state instead).
            # Exactly one path collects events, never both.
            #
            # A plain Run Discovery fires and forgets, as it always has: an
            # audit API that is throttled must not delay a completed scan.
            #
            # An Account Refresh needs the OUTCOME, not just the attempt — it
            # has to report "events refreshed" or "events failed" honestly — so
            # it awaits the same collection itself after this returns. Firing
            # it here as well would mean two collection passes against the same
            # provider for one refresh, which is precisely the duplicated API
            # call the refresh design exists to avoid.
            if refresh_id is None:
                from app.services.event_collector import schedule_after_discovery

                schedule_after_discovery(account_id)

            await account_repo.update_last_discovery(account_id)
            await disco_repo.complete_job(job_id, count)
            # An incomplete sweep refreshed what it could read and kept the
            # rest, so it is SUCCEEDED-but-incomplete: the refresh grades
            # PARTIAL, never "Successful" beside an 80% inventory.
            await _stamp(refresh_id, "resources", "SUCCEEDED",
                         detail=resources_detail(count, failures, scope),
                         incomplete=bool(failures))
            # Drift rides on the same upsert, so it succeeds exactly when the
            # sweep does — except on the very first scan of an account, where
            # there is no previous state to diff against and nothing is logged.
            # Reporting that as a success would claim drift was checked when
            # the baseline was merely established.
            drift_detail = None
            if drift_job_id:
                # The number of changes this sweep actually logged. Counted
                # rather than asserted: "drift checked" with no number leaves
                # the reader unable to tell a clean comparison from one that
                # ran against nothing.
                from sqlalchemy import func as _func, select as _select

                from app.models.drift import CloudResourceChange

                logged = (await db.execute(
                    _select(_func.count()).select_from(CloudResourceChange)
                    .where(CloudResourceChange.job_id == drift_job_id)
                )).scalar_one()
                drift_detail = (f"{logged} change(s) recorded." if logged
                                else "No configuration changes since the "
                                     "previous scan.")
            await _stamp(
                refresh_id, "drift",
                "SUCCEEDED" if drift_job_id else "SKIPPED",
                detail=(drift_detail if drift_job_id else
                        "First scan of this account — this run establishes the "
                        "baseline, so there is nothing to compare against yet."))
            await db.commit()

            # The topology is derived from the inventory this scan just
            # rewrote, so any cached graph for it is now wrong. The cache
            # would also notice on the next request via its fingerprint, but
            # dropping it here is what makes section 70's "invalidate when a
            # discovery scan completes" an explicit step rather than a lucky
            # consequence of a comparison.
            from app.services.topology_service import invalidate_cache

            invalidate_cache(str(account_id))

            # ── Security assessment ──────────────────────────────────────────
            # Run here rather than on page load. Two reasons: the API then
            # serves persisted findings instead of re-running ~48 rules over
            # every resource on every request, and findings only accumulate
            # history — first_detected_at, detection_count, "is this new since
            # Tuesday" — if something evaluates them on a schedule rather than
            # when someone happens to look.
            #
            # `sweep_complete` is threaded through because it decides whether
            # findings and their alerts may be RESOLVED. On an incomplete sweep
            # an absent finding may only mean its resource failed to enumerate,
            # and closing it would tell the user a problem was fixed when it was
            # not. Same guard as the inventory prune.
            #
            # Its own session and swallowed, like the alert check above: a
            # security-assessment failure must not turn a successful scan into a
            # failed one.
            try:
                async with AsyncSessionLocal() as sec_db:
                    from app.services.security_center_service import (
                        SecurityCenterService,
                    )

                    svc = SecurityCenterService(sec_db)
                    # Identity grants first, so the assessment that follows sees
                    # them. Azure only; AWS and OCI keep identity data in the
                    # inventory this scan just refreshed.
                    try:
                        await svc.collect_identity(account_id, account=account)
                    except Exception as ident_exc:  # noqa: BLE001
                        logger.warning(
                            "Identity collection failed for job=%s: %s",
                            job_id, ident_exc,
                        )
                    # Certificates, secrets and keys, so the assessment below
                    # sees fresh expiry data. Their stores have their own
                    # permissions (a Key Vault's data plane is not covered by
                    # ARM Reader), so a refusal is recorded per store and never
                    # fails the scan — see models/credential_inventory.py.
                    try:
                        from app.services.credential_service import CredentialService

                        cred_out = await CredentialService(sec_db).collect(
                            account_id, account=account)
                        logger.info(
                            "Credential collection for job=%s: %s scope(s) read, "
                            "%s failed, %s object(s)", job_id, cred_out["scopes_ok"],
                            cred_out["scopes_failed"], cred_out["objects"])
                    except Exception as cred_exc:  # noqa: BLE001
                        logger.warning(
                            "Credential collection failed for job=%s: %s",
                            job_id, cred_exc,
                        )
                    result = await svc.assess(
                        account_id,
                        triggered_by=f"discovery:{job_id}",
                        sweep_complete=not failures,
                        failed_scopes=len(failures or ()),
                        scope_summary=scope,
                        discovery_scan_id=job_id,
                    )
                    logger.info(
                        "Security assessment for job=%s: outcome=%s score=%s "
                        "findings(new=%s resolved=%s) alerts(new=%s resolved=%s)",
                        job_id, result["outcome"], result["score"].get("score"),
                        result["findings"].get("new"),
                        result["findings"].get("resolved"),
                        result["alerts"].get("created"),
                        result["alerts"].get("resolved"),
                    )
                    await _stamp(
                        refresh_id, "security", "SUCCEEDED",
                        detail=(f"Score {result['score'].get('score')}, "
                                f"{result['findings'].get('new')} new finding(s), "
                                f"{result['findings'].get('resolved')} resolved."))
            except Exception as sec_exc:  # noqa: BLE001
                logger.warning(
                    "Security assessment failed for job=%s: %s",
                    job_id, sec_exc, exc_info=True,
                )
                await _stamp(refresh_id, "security", "FAILED",
                             detail=str(sec_exc)[:400])

            logger.info(
                "Discovery complete: job=%s account=%s resources=%d",
                job_id, account_id, count,
            )

        except Exception as exc:
            logger.error(
                "Discovery failed: job=%s error=%s", job_id, exc, exc_info=True
            )
            # Whichever stage was in flight is the one that failed. Anything
            # still PENDING behind it is stamped SKIPPED rather than FAILED —
            # a security assessment that never ran because authentication
            # failed did not itself fail, and calling it a failure would send
            # somebody looking at the wrong subsystem.
            await _stamp(refresh_id, "resources", "FAILED", detail=str(exc)[:400])
            for _later in ("drift", "cost", "security"):
                await _stamp(refresh_id, _later, "SKIPPED",
                             detail="Not reached — the inventory sweep failed first.")
            await disco_repo.fail_job(job_id, str(exc))
            # A scan that died partway through is an incomplete sweep by
            # definition, so its diffs get the same treatment as a sweep that
            # could not enumerate every scope: discarded, not published as
            # change. Inventory rows already written are still kept — those are
            # real observations, and wiping them is what the prune guard exists
            # to prevent. Best-effort: recording the failure matters more.
            if drift_job_id:
                try:
                    from app.repository.drift_repo import DriftRepository

                    dropped = await DriftRepository(db).delete_for_job(drift_job_id)
                    if dropped:
                        logger.warning(
                            "Discovery job=%s discarded %d change-log row(s) from a "
                            "failed sweep.", job_id, dropped,
                        )
                except Exception as drift_exc:
                    logger.warning(
                        "Discovery job=%s could not discard its change-log rows: %s",
                        job_id, drift_exc,
                    )
            await db.commit()
