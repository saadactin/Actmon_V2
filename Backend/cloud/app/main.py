"""
FastAPI application entry point for the Cloud Discovery microservice.

Runs on port 8001 (configurable via CLOUD_SERVICE_PORT in .env).
All routes are prefixed with /api/v1 to match the frontend Axios client
and be compatible with Vite's proxy rules.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core import inflight as _inflight  # noqa: F401 — pins the process start time
from app.core.config import settings
from app.core.logging import setup_logging

# ── Bootstrap logging ─────────────────────────────────────────────────────────
setup_logging("DEBUG" if settings.DEBUG else "INFO")

# ── Import models so SQLAlchemy registers the tables ──────────────────────────
from app.models.cloud_account import CloudAccount   # noqa: F401
from app.models.resource import CloudResource       # noqa: F401
from app.models.discovery_job import DiscoveryJob   # noqa: F401
from app.models.alert import CloudAlert             # noqa: F401
from app.models.drift import CloudResourceChange    # noqa: F401
from app.models.topology_snapshot import CloudTopologySnapshot  # noqa: F401
from app.models.cloud_event import CloudEvent         # noqa: F401
# Registered so create_all builds them. Without the import the tables simply
# never exist, and the first findings write fails at runtime instead of at boot.
from app.models.security_finding import (              # noqa: F401
    CloudAlertPolicy, CloudSecurityAssessment, CloudSecurityFinding,
)
from app.models.identity_grant import (                # noqa: F401
    CloudIdentityCollectionState, CloudIdentityGrant,
)
from app.models.event_admin import (                  # noqa: F401
    CloudEventAccessLog,
    CloudEventSavedQuery,
    CloudEventSettings,
    CloudEventSyncState,
)
from app.models.cost_fact import (                     # noqa: F401
    CloudCostBackfillJob, CloudCostFact,
)
from app.models.fx_rate import CloudFxRate             # noqa: F401
from app.models.cost_recommendation import (            # noqa: F401
    CloudCostRecommendationDecision,
)
from app.models.cost_budget import (                   # noqa: F401
    CloudCostAlertPolicy, CloudCostBudget, CloudCostBudgetNotification,
)
from app.models.finops_scorecard import CloudFinopsScorecard  # noqa: F401
from app.models.resource_cost import CloudResourceCost   # noqa: F401
from app.models.resource_view import SavedResourceView   # noqa: F401
from app.models.resource_action import CloudResourceAction  # noqa: F401
from app.models.alert_rule import (                      # noqa: F401
    CloudAlertEvent, CloudAlertRecipient, CloudAlertRule, CloudAlertSettings,
)
from app.models.account_refresh import (                 # noqa: F401
    CloudAccountRefresh, CloudAccountRefreshSchedule,
)
from app.models.client import (                          # noqa: F401
    CloudClient, CloudClientReport, CloudClientReportSchedule,
)
from app.models.account_report import (                  # noqa: F401
    CloudAccountReport, CloudAccountReportSchedule, CloudReportTemplate,
)
from app.models.credential_inventory import (            # noqa: F401
    CloudCredentialObject, CloudCredentialSource,
)
from app.models.optimization import (                    # noqa: F401
    CloudOptimizationFinding, CloudOptimizationRun, CloudResourceTelemetry,
)
# Identity & Access (CIEM). The inventory, its derived analysis and the
# approval workflow are three modules because they have three lifetimes:
# the inventory costs provider calls, the analysis is recomputed freely, and
# the workflow rows are an audit trail that outlives both.
from app.models.identity import (                        # noqa: F401
    CloudIdentity, CloudIdentityCredential, CloudIdentityMembership,
    CloudIdentityPolicy,
)
from app.models.identity_analysis import (               # noqa: F401
    CloudEffectivePermission, CloudIdentityAnalysisState, CloudIdentityBaseline,
    CloudIdentityBlastRadius, CloudIdentityCapability, CloudIdentityTrust,
    CloudPermissionUsage,
)
from app.models.identity_workflow import (               # noqa: F401
    CloudAccessApproval, CloudAccessRequest, CloudIdentityAuditLog, CloudJitSession,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create DB tables on startup (idempotent — skips existing tables)."""
    import asyncio
    import os
    from concurrent.futures import ThreadPoolExecutor

    from app.core.database import engine, Base

    # Cloud SDK calls (boto3 / azure-sdk / oci) are blocking and are run via
    # loop.run_in_executor(None, ...). Python's default executor caps at
    # ~min(32, cpu+4) threads, which serializes the large
    # region × compartment × service fan-out and makes a single scan slow.
    # These calls are I/O-bound (they release the GIL while waiting on the
    # network), so a high thread count is safe and lets the fan-out — and
    # several accounts scanning at once — run truly concurrently.
    try:
        max_workers = int(os.getenv("CLOUD_SCAN_MAX_WORKERS", "64"))
    except ValueError:
        max_workers = 64
    asyncio.get_running_loop().set_default_executor(
        ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="cloud-scan")
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # ── Release scans orphaned by a previous process ──────────────────────────
    # Discovery runs as an in-process asyncio task, so a job left PENDING or
    # RUNNING when the process died can never progress. It still looks active to
    # DiscoveryService.trigger_scan, which returns that job instead of starting a
    # new one — so "Scan All Accounts" silently does nothing, forever, and the
    # inventory can never be refreshed. Nothing can legitimately be mid-scan at
    # startup, so fail those rows now.
    import logging as _logging
    from sqlalchemy import text as _text

    _log = _logging.getLogger("cloud_svc.startup")

    # ── Columns added to tables that already exist ────────────────────────────
    # create_all builds missing TABLES but never alters an existing one, so a
    # column added after a table shipped needs saying out loud. ADD COLUMN IF
    # NOT EXISTS makes this idempotent, so it is safe on every startup.
    try:
        async with engine.begin() as conn:
            await conn.execute(_text(
                "ALTER TABLE cloud_resource_changes "
                "ADD COLUMN IF NOT EXISTS value_vanished BOOLEAN NOT NULL DEFAULT FALSE"
            ))
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_cloud_resource_changes_value_vanished "
                "ON cloud_resource_changes (value_vanished)"
            ))
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not reconcile cloud_resource_changes columns: %s", exc)

    # Clients, organisation onboarding and the credential inventory added
    # columns to cloud_accounts. Kept in one module so tests apply the same DDL.
    try:
        from app.core import schema_patches

        async with engine.begin() as conn:
            await schema_patches.apply(conn)
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not reconcile client / onboarding columns: %s", exc)

    # Record the provider's own id (subscription id, tenancy OCID) for accounts
    # created before provider_account_id existed, so organisation onboarding
    # recognises them as already connected. Local decryption only; AWS accounts
    # learn theirs from STS on the next discovery.
    try:
        from app.core.database import AsyncSessionLocal as _Session
        from app.services.cloud_account_service import backfill_provider_account_ids

        async with _Session() as _db:
            filled, skipped = await backfill_provider_account_ids(_db)
            await _db.commit()
            if filled:
                _log.info("Recorded the provider id of %d existing account(s).", filled)
    except Exception as exc:  # never block startup
        _log.warning("Could not backfill provider account ids: %s", exc)

    # cloud_resources predates the Resources workspace, so the normalized
    # projections it filters, sorts and facets on are added here. They are a
    # cache of app/services/resource_model.py's output, not a second source of
    # truth: resource_normalizer.py recomputes them after every discovery
    # sweep, and the backfill below fills them in for rows that predate this.
    #
    # last_seen_at is the important one. Freshness cannot be read off
    # updated_at, which SQLAlchemy only moves when a field actually changes -
    # a resource nobody has touched would report as stale inventory forever.
    try:
        async with engine.begin() as conn:
            for ddl in (
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS normalized_status VARCHAR(20)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS status_reason TEXT",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS normalized_type VARCHAR(32)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS environment VARCHAR(128)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS owner VARCHAR(256)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS attachment_state VARCHAR(20)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS resource_group VARCHAR(255)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS compartment VARCHAR(255)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS availability_zone VARCHAR(100)",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS is_default BOOLEAN",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS tag_count INTEGER",
                "ALTER TABLE cloud_resources ADD COLUMN IF NOT EXISTS service VARCHAR(64)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_service "
                "ON cloud_resources (account_id, service)",
                # Indexes for the query shapes the workspace actually issues.
                # Every composite leads with account_id because no query in the
                # product reads resources without a scope.
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_type "
                "ON cloud_resources (account_id, resource_type)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_region "
                "ON cloud_resources (account_id, region_or_zone)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_nstatus "
                "ON cloud_resources (account_id, normalized_status)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_ntype "
                "ON cloud_resources (account_id, normalized_type)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_name "
                "ON cloud_resources (account_id, resource_name)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_account_seen "
                "ON cloud_resources (account_id, last_seen_at)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_resources_updated_at "
                "ON cloud_resources (updated_at)",
                # The findings join behind the risk column and the risk sort.
                "CREATE INDEX IF NOT EXISTS ix_findings_resource_status "
                "ON cloud_security_findings (resource_id, status)",
            ):
                await conn.execute(_text(ddl))
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not reconcile cloud_resources columns: %s", exc)

    # Backfill the normalized projections for rows that predate them. Bounded:
    # it only touches rows where normalized_status IS NULL, so it does real
    # work exactly once and is a no-op on every subsequent boot.
    try:
        from app.core.database import AsyncSessionLocal as _Session
        from app.services import resource_normalizer as _rn

        async with _Session() as session:
            pending = await _rn.accounts_needing_backfill(session)
            filled = 0
            for account_id in pending:
                filled += await _rn.renormalize_account(
                    session, account_id, only_missing=True
                )
            if filled:
                await session.commit()
                _log.info(
                    "Normalized %d resource row(s) across %d account(s) that "
                    "predated the resource projection columns.", filled, len(pending),
                )
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not backfill resource normalization: %s", exc)

    # cloud_alerts predates the Security Center, so its link back to the
    # canonical finding, the policy that fired it, and the notification-cooldown
    # state are added here. `IF NOT EXISTS` keeps it idempotent on every boot.
    #
    # Historical alerts keep NULL in finding_fingerprint, which is correct and
    # is what the UI reads to label them "created before findings were linked"
    # rather than pretending they point at something.
    try:
        async with engine.begin() as conn:
            for ddl in (
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "finding_fingerprint VARCHAR(64)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS policy_id UUID",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS policy_name VARCHAR(256)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "acknowledged_by VARCHAR(256)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(256)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS resolution_reason TEXT",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "previous_severity VARCHAR(20)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "severity_changed_at TIMESTAMPTZ",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "last_notified_at TIMESTAMPTZ",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "notification_count INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "notification_status VARCHAR(40)",
                "CREATE INDEX IF NOT EXISTS ix_cloud_alerts_finding "
                "ON cloud_alerts (finding_fingerprint)",
                # Which configured alert rule raised this. Added rather than
                # made a foreign key on purpose: rules are soft-deleted so
                # their alert history survives them, and a real FK would force
                # a choice between cascading that history away and blocking
                # the delete. Historical alerts keep NULL, which is correct —
                # they predate rules and were raised directly by a feature.
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS rule_id UUID",
                "CREATE INDEX IF NOT EXISTS ix_cloud_alerts_rule "
                "ON cloud_alerts (rule_id)",
            ):
                await conn.execute(_text(ddl))
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not reconcile cloud_alerts columns: %s", exc)

    # The alerting tables are created by create_all above. What create_all
    # cannot build is the PARTIAL unique index behind "one live rule per name
    # per account" — SQLAlchemy emits it from __table_args__ on a fresh table,
    # but an installation that already has cloud_alert_rules would never get
    # it. Stated here too so both paths end up with the same constraint.
    try:
        async with engine.begin() as conn:
            await conn.execute(_text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_alert_rules_account_name "
                "ON cloud_alert_rules (account_id, name) WHERE deleted_at IS NULL"
            ))
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_cloud_alert_rules_due "
                "ON cloud_alert_rules (enabled, deleted_at, last_evaluated_at)"
            ))
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_cloud_alert_events_account_at "
                "ON cloud_alert_events (account_id, at DESC)"
            ))
            # Account refresh. create_all builds these tables on a fresh
            # install; the indexes are stated here so an installation that
            # already has them gets the ones the lock and scheduler queries
            # depend on.
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_account_refresh_account_status "
                "ON cloud_account_refreshes (account_id, status)"
            ))
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_account_refresh_account_created "
                "ON cloud_account_refreshes (account_id, created_at DESC)"
            ))
            # The scheduler's only hot query: which schedules are due.
            await conn.execute(_text(
                "CREATE INDEX IF NOT EXISTS ix_refresh_schedule_due "
                "ON cloud_account_refresh_schedules (enabled, next_run_at)"
            ))
            # Account report schedules: one report per schedule per run,
            # enforced by the database rather than the scheduler's bookkeeping
            # (see app.models.account_report).
            await conn.execute(_text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_account_report_schedule_run "
                "ON cloud_account_reports (schedule_id, run_key) WHERE trigger = 'schedule'"
            ))
            # Columns added to cloud_alert_rules after it shipped. create_all
            # builds missing TABLES but never alters an existing one, so an
            # installation that already has the table would silently miss
            # these and every rule read would fail on the first SELECT.
            for ddl in (
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "min_duration_seconds INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "consecutive_breaches_required INTEGER NOT NULL DEFAULT 1",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "silenced_until TIMESTAMPTZ",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "silenced_by VARCHAR(256)",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "silence_reason TEXT",
                # The engine's own hot path: find held breaches for a rule.
                "CREATE INDEX IF NOT EXISTS ix_cloud_alerts_rule_state "
                "ON cloud_alerts (rule_id, state)",
                # Notification pacing, escalation and quiet-hours opt-out.
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "notification_mode VARCHAR(24) NOT NULL DEFAULT 'immediate'",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "escalate_after_seconds INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE cloud_alert_rules ADD COLUMN IF NOT EXISTS "
                "respect_quiet_hours BOOLEAN NOT NULL DEFAULT TRUE",
                # Per-alert silence and the escalation latch.
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "silenced_until TIMESTAMPTZ",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "silenced_by VARCHAR(256)",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "silence_reason TEXT",
                "ALTER TABLE cloud_alerts ADD COLUMN IF NOT EXISTS "
                "escalated_at TIMESTAMPTZ",
                # The escalation sweep's query: open, never escalated.
                "CREATE INDEX IF NOT EXISTS ix_cloud_alerts_escalation "
                "ON cloud_alerts (state, escalated_at) "
                "WHERE escalated_at IS NULL",
                # Quiet hours and digest bookkeeping on the settings row.
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE",
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "quiet_hours_start VARCHAR(5) NOT NULL DEFAULT '22:00'",
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "quiet_hours_end VARCHAR(5) NOT NULL DEFAULT '07:00'",
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "quiet_hours_critical_bypass BOOLEAN NOT NULL DEFAULT TRUE",
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "last_hourly_digest_at TIMESTAMPTZ",
                "ALTER TABLE cloud_alert_settings ADD COLUMN IF NOT EXISTS "
                "last_daily_digest_at TIMESTAMPTZ",
            ):
                await conn.execute(_text(ddl))
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not reconcile alert rule indexes: %s", exc)

    # Seed the built-in alert policies. Without this the policy table is empty
    # on a fresh install and no security finding can ever produce an alert —
    # which was the entire pre-Security-Center behaviour and is not a state
    # worth being able to reach by accident.
    try:
        from app.core.database import AsyncSessionLocal as _Session
        from app.repository.security_repo import SecurityRepository as _SecRepo

        async with _Session() as _db:
            created = await _SecRepo(_db).seed_default_policies()
            await _db.commit()
            if created:
                _log.info("Seeded %d built-in security alert policy/policies.", created)
    except Exception as exc:  # never block startup
        _log.warning("Could not seed default alert policies: %s", exc)

    try:
        async with engine.begin() as conn:
            result = await conn.execute(_text(
                "UPDATE discovery_jobs SET status='FAILED', completed_at=now(), "
                "error_detail=COALESCE(error_detail, "
                "'Interrupted: the service restarted while this scan was running.') "
                "WHERE status IN ('PENDING','RUNNING')"
            ))
            if result.rowcount:
                _log.warning(
                    "Released %d discovery job(s) left RUNNING/PENDING by a previous "
                    "process — they were blocking new scans.", result.rowcount,
                )
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not release orphaned discovery jobs: %s", exc)

    # ── Make cloud_events append-only, in the database ────────────────────────
    # The application already has no code path that updates or deletes an audit
    # event, but "we don't do that" is a convention and an audit trail needs a
    # guarantee. This trigger is the guarantee: UPDATE is always refused, and
    # DELETE is refused unless the caller has declared itself the retention
    # pruner for that transaction (EventRepository.prune_older_than issues
    # `SET LOCAL actmon.allow_event_prune = 'on'`).
    #
    # `current_setting(..., true)` returns NULL rather than raising when the
    # setting was never set, which is what makes the check safe on a connection
    # that has never pruned. And because it is SET LOCAL, the permission cannot
    # outlive its transaction onto the next request sharing that pooled
    # connection.
    # The DDL itself lives in app/events/schema.py so this startup path and the
    # test suite install the identical trigger — when it was inline here, the
    # tests created their own tables, never got the trigger, and "proved"
    # immutability that nothing was actually enforcing.
    try:
        from app.events.schema import ensure_append_only

        async with engine.begin() as conn:
            await ensure_append_only(conn)
            _log.info("cloud_events append-only trigger is in place.")
    except Exception as exc:
        # Never block startup: without the trigger the feature still works and
        # the application still never writes an update. But say so loudly —
        # the guarantee is weaker than it was designed to be, and that is worth
        # someone noticing.
        _log.warning(
            "Could not install the cloud_events append-only trigger (%s). Audit "
            "events remain append-only by application convention, but the database "
            "will not enforce it.", exc,
        )

    # ── Background audit-event collection ────────────────────────────────────
    # Started here rather than on first request so a service nobody has opened
    # the Event Log on is still collecting — an audit trail with gaps for the
    # hours nobody was looking is not an audit trail. Interval and on/off live
    # in cloud_event_settings and are re-read each cycle.
    collector_task = None
    if os.getenv("EVENT_COLLECTOR_ENABLED", "true").strip().lower() not in (
        "false", "0", "no", "off",
    ):
        from app.services.event_collector import collector_loop

        collector_task = asyncio.create_task(collector_loop())
        _log.info("Cloud audit-event collector started.")
    else:
        _log.info(
            "Cloud audit-event collector is disabled (EVENT_COLLECTOR_ENABLED=false). "
            "Events can still be collected on demand from the Event Log."
        )

    # ── Account refresh: release orphans, then start the scheduler ───────────
    # A refresh row left RUNNING by a killed process holds its account's lock
    # forever, so every later refresh — manual or scheduled — would be refused
    # with "already running" by a job nobody is running. Same reasoning as the
    # orphaned discovery jobs released above.
    try:
        from app.services import refresh_scheduler as _refresh

        released = await _refresh.release_orphaned_refreshes()
        if released:
            _log.warning(
                "Released %d account refresh(es) left running by a previous "
                "process.", released,
            )
    except Exception as exc:  # never block startup on this housekeeping
        _log.warning("Could not release orphaned account refreshes: %s", exc)

    refresh_task = None
    from app.services import refresh_scheduler as _refresh_sched

    if _refresh_sched.scheduler_enabled():
        refresh_task = asyncio.create_task(_refresh_sched.scheduler_loop())
        _log.info("Account refresh scheduler started.")
    else:
        _log.warning(
            "Account refresh scheduler is DISABLED "
            "(REFRESH_SCHEDULER_ENABLED=false). Schedules can be configured but "
            "nothing will run automatically; manual refresh is unaffected."
        )

    # ── Alert evaluation engine ──────────────────────────────────────────────
    # Started here for the same reason the event collector is: a rule that is
    # only evaluated while somebody has the Alerts page open is not monitoring.
    # Each rule still honours its own interval; this loop only decides how
    # often "is anything due" is asked.
    alert_task = None
    from app.services.alerts import engine as alert_engine

    if alert_engine.engine_enabled():
        alert_task = asyncio.create_task(alert_engine.engine_loop())
        _log.info("Cloud alert engine started.")
    else:
        _log.warning(
            "Cloud alert engine is DISABLED (ALERT_ENGINE_ENABLED=false). Alert "
            "rules can be configured but nothing will be evaluated and no "
            "notification will be sent."
        )

    # ── Monthly client reports ───────────────────────────────────────────────
    # Schedules are created disabled; this loop only acts on ones an operator
    # turned on. It can produce e-mail, so it has its own off switch.
    report_task = None
    from app.services import client_report_scheduler as _reports

    if _reports.scheduler_enabled():
        report_task = asyncio.create_task(_reports.scheduler_loop())
        _log.info("Client report scheduler started.")
    else:
        _log.warning(
            "Client report scheduler is DISABLED (CLIENT_REPORT_SCHEDULER_ENABLED=false). "
            "Reports can still be generated and sent by hand."
        )

    # ── Account report schedules ─────────────────────────────────────────────
    # Same contract as the client reports: schedules are created disabled and
    # this loop only acts on ones an operator turned on. It can produce
    # e-mail, so it has its own off switch.
    account_report_task = None
    from app.services import account_report_scheduler as _acct_reports

    if _acct_reports.scheduler_enabled():
        account_report_task = asyncio.create_task(_acct_reports.scheduler_loop())
        _log.info("Account report scheduler started.")
    else:
        _log.warning(
            "Account report scheduler is DISABLED (ACCOUNT_REPORT_SCHEDULER_ENABLED=false). "
            "Reports can still be generated by hand."
        )

    # ── JIT expiry ───────────────────────────────────────────────────────────
    # Runs by default. Its job is to REMOVE access, so the safe default is on:
    # an elevation whose expiry nothing enforces is standing admin access with
    # a misleading row in the database.
    jit_task = None
    from app.services import jit_expiry_scheduler as _jit

    if _jit.scheduler_enabled():
        jit_task = asyncio.create_task(_jit.scheduler_loop())
        _log.info("JIT expiry scheduler started.")
    else:
        _log.warning(
            "JIT expiry scheduler is DISABLED (CIEM_JIT_EXPIRY_ENABLED=false). "
            "Time-boxed elevations will NOT be revoked automatically."
        )

    # ── Security exception expiry ────────────────────────────────────────────
    # Runs by default, same reasoning as JIT expiry: it ends risk acceptances
    # whose review date has passed, and must not wait for a scan to succeed.
    exception_task = None
    from app.services import exception_expiry_scheduler as _exc_expiry

    if _exc_expiry.scheduler_enabled():
        exception_task = asyncio.create_task(_exc_expiry.scheduler_loop())
        _log.info("Security exception expiry scheduler started.")
    else:
        _log.warning(
            "Security exception expiry scheduler is DISABLED "
            "(SECURITY_EXCEPTION_EXPIRY_ENABLED=false). Accepted risks will only "
            "reopen when an assessment re-detects them."
        )

    # ── Cost budget guardrails ───────────────────────────────────────────────
    # Runs by default, same reasoning as JIT expiry: a budget already defaults
    # to enabled the moment someone creates it, so a budget whose thresholds
    # nothing evaluates is a configuration screen that does nothing.
    budget_task = None
    from app.services import budget_scheduler as _budget_sched

    if _budget_sched.scheduler_enabled():
        budget_task = asyncio.create_task(_budget_sched.scheduler_loop())
        _log.info("Cost budget scheduler started.")
    else:
        _log.warning(
            "Cost budget scheduler is DISABLED (COST_BUDGET_SCHEDULER_ENABLED=false). "
            "Budgets and alert policies can be configured but will only be "
            "evaluated by hand (POST .../budgets/evaluate or "
            ".../alert-policies/evaluate)."
        )

    yield

    if budget_task is not None:
        _budget_sched.stop_scheduler()
        budget_task.cancel()
        try:
            await budget_task
        except BaseException:
            pass

    if jit_task is not None:
        _jit.stop_scheduler()
        jit_task.cancel()
        try:
            await jit_task
        except BaseException:
            pass

    if exception_task is not None:
        _exc_expiry.stop_scheduler()
        exception_task.cancel()
        try:
            await exception_task
        except BaseException:
            pass

    if report_task is not None:
        _reports.stop_scheduler()
        report_task.cancel()
        try:
            await report_task
        except BaseException:
            pass

    if account_report_task is not None:
        _acct_reports.stop_scheduler()
        account_report_task.cancel()
        try:
            await account_report_task
        except BaseException:
            pass

    if collector_task is not None:
        collector_task.cancel()
        try:
            await collector_task
        except BaseException:
            # Cancellation is the expected outcome here; anything else has
            # already been logged inside the loop.
            pass

    if alert_task is not None:
        alert_engine.stop_engine()
        alert_task.cancel()
        try:
            await alert_task
        except BaseException:
            pass

    if refresh_task is not None:
        _refresh_sched.stop_scheduler()
        refresh_task.cancel()
        try:
            await refresh_task
        except BaseException:
            pass

    await engine.dispose()


# ── Application ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="ACTMON Cloud Discovery Service",
    version="1.0.0",
    description=(
        "Microservice for cloud account management, background resource discovery, "
        "and inventory across AWS, Azure, and OCI."
    ),
    lifespan=lifespan,
    docs_url="/api/v1/cloud/docs",
    openapi_url="/api/v1/cloud/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api.routes.cloud_accounts import router as accounts_router
from app.api.routes.discovery import router as discovery_router
from app.api.routes.resources import router as resources_router
from app.api.routes.cost import router as cost_router
from app.api.routes.cost_budgets import router as cost_budgets_router
from app.api.routes.security import router as security_router
from app.api.routes.cost_estimate import router as cost_estimate_router
from app.api.routes.topology import router as topology_router
from app.api.routes.compliance import router as compliance_router
from app.api.routes.alerts import router as alerts_router
from app.api.routes.alert_rules import router as alert_rules_router
from app.api.routes.account_refresh import router as account_refresh_router
from app.api.routes.drift import router as drift_router
from app.api.routes.events import router as events_router
# The unified Security Center. The three older routers (security, compliance,
# alerts) stay mounted unchanged; nothing new should be added to them.
#
# As of 2026-09-16 the pages they were the compatibility surface FOR are gone
# (SecurityPosturePage, CompliancePage, the cloud AlertsPage), and no part of
# the frontend calls GET /cloud/security/{id} any more — posture is read from
# /cloud/security-center/{id} alone, because the two engines scored the same
# account differently. The routers are left mounted rather than deleted because
# this service cannot prove what else calls them; deleting them is a separate,
# deliberate decision. Two endpoints on the security router are still genuinely
# used and are NOT superseded: /{id}/exposure and /{id}/iam-review.
from app.api.routes.security_center import router as security_center_router
# Clients (portfolio, onboarding, reports) and certificates/secrets. Their paths
# are all under their own prefixes, so order relative to the others is free.
from app.api.routes.clients import router as clients_router
from app.api.routes.certificates import router as certificates_router
# Resource Intelligence: optimization findings beside the Security Center's.
from app.api.routes.intelligence import router as intelligence_router
from app.api.routes.identity import router as identity_router
# Resource assessment report builder (Scope -> Sections -> Layout -> Preview ->
# Generate). Its own prefix, /cloud/reports, so order relative to the others
# is free -- no single-segment route under it to collide with.
from app.api.routes.reports import router as reports_router

# Standard API routes under /api/v1/
#
# ORDER MATTERS for the two cost routers. cost_router owns
# `/cloud/cost/{account_id}`, a single-segment parameterized path that matches
# ANY one segment — including the literal "budgets". Registered first, it
# swallows /cloud/cost/budgets and tries to parse "budgets" as a UUID, so the
# whole budgets surface 422s. cost_budgets_router therefore goes first, and its
# literal paths win. (Routes like /cloud/cost/capabilities/{id} are unaffected:
# two segments never collide with a one-segment route.)
#
# alert_rules_router goes BEFORE alerts_router for the same reason
# cost_budgets_router goes before cost_router. The old alerts router owns
# `/cloud/alerts/{alert_id}/acknowledge` and `/cloud/alerts/{alert_id}/resolve`
# — single-segment parameterised paths that would match the literal segment of
# `/cloud/alerts/{account_id}/rules` if they were registered first. The new
# router's paths are all two-or-more segments after the prefix, so putting it
# first lets each set win the shapes it actually owns.
#
# account_refresh_router shares the /cloud/accounts prefix with accounts_router
# and goes first, for the same reason cost_budgets and alert_rules do. Its
# paths are all `/{account_id}/<literal>`, which do not collide with that
# router's `/{account_id}` — but ordering it first means a future single-segment
# route added there cannot start swallowing /refresh without anyone noticing.
for router in [account_refresh_router, accounts_router, discovery_router, resources_router, cost_budgets_router, cost_router, security_router, cost_estimate_router, topology_router, compliance_router, alert_rules_router, alerts_router, drift_router, events_router, security_center_router, clients_router, certificates_router, intelligence_router, identity_router, reports_router]:
    app.include_router(router, prefix="/api/v1")




# ── Frontend-compatible inventory route ───────────────────────────────────────
# Frontend calls: GET /cloud/{provider}/{account_id}/inventory
# via Axios baseURL = /api/v1, so the full URL is:
#   GET /api/v1/cloud/{provider}/{account_id}/inventory
@app.get("/api/v1/cloud/{provider}/{account_id}/inventory")
async def get_provider_inventory(provider: str, account_id: str):
    """
    Frontend-compatible inventory endpoint.
    Returns normalized resource list from the DB for the given account.
    """
    import uuid
    from fastapi import HTTPException
    from app.core.database import AsyncSessionLocal
    from app.repository.resource_repo import ResourceRepository

    try:
        aid = uuid.UUID(account_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid account_id UUID")

    async with AsyncSessionLocal() as db:
        repo = ResourceRepository(db)
        resources = await repo.list_by_account(aid)

    return [
        {
            "id": str(r.id),
            "resource_name": r.resource_name,
            "resource_type": r.resource_type,
            "region_or_zone": r.region_or_zone,
            "status": r.status,
            "ip_address": r.ip_address,
            "config": r.config,
            "cost_monthly": r.cost_monthly,
            "tags": r.tags,
            "discovered_at": r.discovered_at.isoformat() if r.discovered_at else None,
        }
        for r in resources
    ]


@app.get("/")
def health():
    return {"status": "ok", "service": "ACTMON Cloud Discovery", "version": "1.0.0"}


@app.get("/health")
def health_check():
    return {"status": "healthy"}


@app.get("/health/inflight")
async def health_inflight():
    """Background work a restart would kill right now, and how this process is run.

    dev_server.py polls this before reloading. Async on purpose: it runs on the
    event loop thread that owns the tasks it inspects. Names and kinds only,
    so it is safe unauthenticated, like /health.
    """
    from app.core import inflight

    return {"inflight": inflight.inflight(), "service": inflight.service_info()}
