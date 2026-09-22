"""Account refresh: one workflow, driven by a button or by the scheduler.

Manual and scheduled refreshes call `AccountRefreshService.start()`. There is
no second code path, so the two cannot drift apart — a bug fixed for one is
fixed for both, and a scheduled run behaves exactly like the one someone
tested by hand.

**What it actually does**, and what it deliberately does not:

    start()
      ├── take the per-account lock          (refuses a duplicate, does not queue it)
      ├── create the refresh record
      ├── run the EXISTING discovery job     (inventory, drift, cost, security)
      ├── collect audit events               (the one thing discovery never did)
      └── grade the result                   SUCCEEDED / PARTIAL / FAILED

It does not re-run discovery's parts. `run_discovery_scan` already performs
resource enumeration, drift capture, cost ingestion, topology invalidation and
the security assessment in a single provider pass. Calling those again here
would double every API call against a rate-limited provider to learn nothing
new. The worker stamps its component outcomes onto the refresh record instead.

**Failure never destroys good data.** That property belongs to the existing
worker — a scan that dies partway keeps the inventory rows it already wrote
and discards only its own unreliable drift rows — and this service inherits it
by reusing that worker rather than replacing it.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account_refresh import (
    COMPONENT_FAILED, COMPONENT_PENDING, COMPONENT_RUNNING, COMPONENT_SKIPPED,
    COMPONENT_SUCCEEDED, COMPONENTS, REFRESH_ACTIVE, REFRESH_CANCELLED,
    REFRESH_FAILED, REFRESH_PARTIAL, REFRESH_QUEUED, REFRESH_RUNNING,
    REFRESH_SUCCEEDED, TRIGGER_MANUAL, TRIGGER_SCHEDULED, TRIGGER_TEST,
    CloudAccountRefresh, CloudAccountRefreshSchedule,
)

logger = logging.getLogger("cloud_svc.refresh")

# Frequencies the scheduler can honestly support. Nothing shorter than an hour:
# a full account refresh is a provider sweep that takes minutes, and offering
# "every 15 minutes" would queue runs faster than they complete on any estate
# worth scheduling.
FREQUENCIES = {
    "interval": "Every N hours",
    "daily": "Every day at a set time",
    "weekly": "Every week on a set day and time",
}
ALLOWED_INTERVAL_HOURS = (1, 2, 3, 6, 12, 24, 48)
DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
             "Saturday", "Sunday")

# A refresh still RUNNING after this long is assumed dead — the process that
# owned it was restarted. Without this the account's lock would be held
# forever by a job nobody is running, and every later refresh would be refused.
STALE_RUNNING_AFTER = timedelta(hours=3)


# What a component that never reported is told to the user. It is a failure,
# not silence — see `grade_components`.
UNREPORTED_DETAIL = ("This component did not report a result before the "
                     "refresh finished, so its data was not updated.")


def _status_of(components: Dict[str, Any], name: str) -> str:
    """One component's state, from either shape.

    Accepts `{"cost": "FAILED"}` and `{"cost": {"status": "FAILED", ...}}`, so
    the grading rule can be exercised directly with plain states instead of
    being re-implemented in a test that then proves nothing about production.
    """
    value = components.get(name)
    if isinstance(value, str):
        return value
    return (value or {}).get("status", COMPONENT_PENDING)


def unresolved_components(components: Dict[str, Any]) -> List[str]:
    """Components still PENDING or RUNNING when the refresh is being graded.

    There should never be any. One means the work either never started or
    nobody awaited it — the exact race that let a detached cost ingestion be
    graded as though it had reported.
    """
    return [n for n in COMPONENTS
            if _status_of(components, n) in (COMPONENT_PENDING, COMPONENT_RUNNING)]


def grade_components(components: Dict[str, Any]) -> Tuple[str, List[str]]:
    """The grading rule. The only implementation — production calls this, and
    so do its tests, so the two cannot describe different rules.

    Returns the overall status and the components counted against it.

      - connection or resources failed -> FAILED. Nothing downstream can be
        trusted, and no data was replaced.
      - some other component failed    -> PARTIAL. The inventory IS fresh;
        cost or events are not. Calling that SUCCEEDED is precisely how stale
        data comes to look current.
      - nothing succeeded              -> FAILED. A refresh that achieved
        nothing did not succeed, whatever its components say individually.

    A component that never reported counts as failed, never as absent. SKIPPED
    does not: a provider with no cost integration did not fail to refresh cost,
    it was never asked to.
    """
    states = {n: _status_of(components, n) for n in COMPONENTS}
    failed = [n for n, s in states.items()
              if s in (COMPONENT_FAILED, COMPONENT_PENDING, COMPONENT_RUNNING)]
    succeeded = [n for n, s in states.items() if s == COMPONENT_SUCCEEDED]

    if "connection" in failed or "resources" in failed:
        return REFRESH_FAILED, failed
    if failed:
        return REFRESH_PARTIAL, failed
    if not succeeded:
        return REFRESH_FAILED, failed
    return REFRESH_SUCCEEDED, failed


class RefreshError(RuntimeError):
    """A refresh could not be started. Carries the reason for the caller."""

    def __init__(self, message: str, *, code: str = "refresh_error",
                 existing: Optional[dict] = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.existing = existing


# Strong references to in-flight orchestration tasks, so the event loop cannot
# garbage-collect a refresh mid-run. Same reason discovery_service keeps its
# own set.
_running: set = set()


class AccountRefreshService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Reads ────────────────────────────────────────────────────────────────
    async def _account(self, account_id: uuid.UUID):
        from app.repository.cloud_account_repo import CloudAccountRepository

        account = await CloudAccountRepository(self.db).get_by_id(account_id)
        if account is None:
            raise RefreshError(f"Cloud account {account_id} was not found.",
                               code="account_not_found")
        return account

    async def active_refresh(self, account_id: uuid.UUID) -> Optional[CloudAccountRefresh]:
        """The refresh currently holding this account's lock, if any.

        A row left RUNNING by a killed process is released here rather than
        blocking the account forever. It is marked FAILED with a stated reason,
        not silently deleted — "the service restarted mid-refresh" is exactly
        the kind of thing someone needs to be able to find later.
        """
        row = (await self.db.execute(
            select(CloudAccountRefresh)
            .where(CloudAccountRefresh.account_id == account_id,
                   CloudAccountRefresh.status.in_(REFRESH_ACTIVE))
            .order_by(CloudAccountRefresh.created_at.desc())
        )).scalars().first()
        if row is None:
            return None

        started = row.started_at or row.created_at
        if started and _aware(started) < datetime.now(timezone.utc) - STALE_RUNNING_AFTER:
            row.status = REFRESH_FAILED
            row.error = ("Interrupted: the service restarted while this refresh "
                         "was running, so its outcome is unknown.")
            row.error_code = "interrupted"
            row.completed_at = datetime.now(timezone.utc)
            await self.db.commit()
            logger.warning("Released a stale refresh lock on account %s", account_id)
            return None
        return row

    async def get(self, account_id: uuid.UUID,
                  refresh_id: uuid.UUID) -> CloudAccountRefresh:
        row = await self.db.get(CloudAccountRefresh, refresh_id)
        # The account check is the isolation boundary: a refresh id from
        # another account must not be readable through this account's URL.
        if row is None or row.account_id != account_id:
            raise RefreshError("That refresh was not found on this account.",
                               code="not_found")
        return row

    async def history(self, account_id: uuid.UUID, *, limit: int = 20,
                      status: Optional[str] = None) -> List[dict]:
        stmt = select(CloudAccountRefresh).where(
            CloudAccountRefresh.account_id == account_id)
        if status:
            stmt = stmt.where(CloudAccountRefresh.status == status.upper())
        stmt = stmt.order_by(CloudAccountRefresh.created_at.desc()).limit(
            min(limit, 200))
        return [r.to_dict() for r in (await self.db.execute(stmt)).scalars().all()]

    async def latest(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """What the Overview header needs: current, last attempt, last success.

        Last attempt and last success are separate rows on purpose. A failed
        refresh must never overwrite the timestamp people read as "when was
        this account last actually refreshed" — showing both is the only way
        to say "we tried at 02:00 and it failed; the data is from Tuesday".
        """
        current = await self.active_refresh(account_id)
        last_attempt = (await self.db.execute(
            select(CloudAccountRefresh)
            .where(CloudAccountRefresh.account_id == account_id,
                   CloudAccountRefresh.status.notin_(REFRESH_ACTIVE))
            .order_by(CloudAccountRefresh.created_at.desc()).limit(1)
        )).scalars().first()
        last_success = (await self.db.execute(
            select(CloudAccountRefresh)
            .where(CloudAccountRefresh.account_id == account_id,
                   CloudAccountRefresh.status.in_(
                       [REFRESH_SUCCEEDED, REFRESH_PARTIAL]))
            .order_by(CloudAccountRefresh.completed_at.desc().nullslast()).limit(1)
        )).scalars().first()

        schedule = await self.get_schedule(account_id)
        return {
            "account_id": str(account_id),
            "current": current.to_dict() if current else None,
            "last_attempt": last_attempt.to_dict() if last_attempt else None,
            "last_success": last_success.to_dict() if last_success else None,
            "schedule": schedule.to_dict(),
            # The one sentence describing the cadence is rendered here, not in
            # the browser, so the header and the settings drawer cannot
            # disagree about what a schedule means.
            "schedule_summary": describe_schedule(schedule),
            "is_running": current is not None,
        }

    # ── Start ────────────────────────────────────────────────────────────────
    async def start(self, account_id: uuid.UUID, *,
                    trigger_type: str = TRIGGER_MANUAL,
                    actor: Optional[str] = None) -> CloudAccountRefresh:
        """Take the lock, create the record, and launch the workflow.

        Returns as soon as the job is queued. A full refresh takes minutes and
        holding an HTTP request open for it would tie the job's lifetime to a
        browser tab — close the tab and the sweep dies halfway through.
        """
        account = await self._account(account_id)

        # One refresh per account. Refused rather than queued: the second
        # request is almost always an impatient second click, and running two
        # provider sweeps concurrently would race the inventory prune.
        existing = await self.active_refresh(account_id)
        if existing is not None:
            raise RefreshError(
                "A refresh is already running for this account.",
                code="already_running", existing=existing.to_dict())

        row = CloudAccountRefresh(
            account_id=account_id,
            provider=account.provider,
            trigger_type=trigger_type,
            triggered_by=actor,
            status=REFRESH_QUEUED,
            components={name: {"status": COMPONENT_PENDING} for name in COMPONENTS},
        )
        self.db.add(row)
        await self.db.commit()
        await self.db.refresh(row)

        await _record_event(account, row, "started",
                            f"Account refresh started ({trigger_type}).")

        task = asyncio.create_task(_run_refresh(row.id, account_id))
        _running.add(task)
        task.add_done_callback(_running.discard)
        return row

    async def cancel(self, account_id: uuid.UUID, refresh_id: uuid.UUID,
                     *, actor: Optional[str] = None) -> dict:
        """Mark a running refresh cancelled.

        Honest about its limits: the provider sweep already in flight is not
        interrupted, because the discovery worker has no cancellation point
        that would leave the inventory consistent. What this does is stop the
        refresh being reported as in-progress and release the account's lock.
        """
        row = await self.get(account_id, refresh_id)
        if row.status not in REFRESH_ACTIVE:
            return row.to_dict()
        row.status = REFRESH_CANCELLED
        row.completed_at = datetime.now(timezone.utc)
        row.error = f"Cancelled by {actor or 'a user'}."
        row.error_code = "cancelled"
        await self.db.commit()
        return {
            **row.to_dict(),
            "note": ("The account is no longer locked. Any provider request "
                     "already in flight will finish on its own — it cannot be "
                     "interrupted without leaving the inventory half-written."),
        }

    # ── Schedule ─────────────────────────────────────────────────────────────
    async def get_schedule(self, account_id: uuid.UUID) -> CloudAccountRefreshSchedule:
        row = (await self.db.execute(
            select(CloudAccountRefreshSchedule)
            .where(CloudAccountRefreshSchedule.account_id == account_id)
        )).scalars().first()
        if row is None:
            # Created disabled. A newly onboarded account must not silently
            # start sweeping a provider on a schedule nobody asked for.
            row = CloudAccountRefreshSchedule(account_id=account_id, enabled=False)
            self.db.add(row)
            await self.db.commit()
            await self.db.refresh(row)
        return row

    async def set_schedule(self, account_id: uuid.UUID, data: Dict[str, Any],
                           *, actor: Optional[str] = None) -> dict:
        account = await self._account(account_id)
        row = await self.get_schedule(account_id)
        before = row.to_dict()
        errors: Dict[str, str] = {}

        frequency = str(data.get("frequency_type") or row.frequency_type)
        if frequency not in FREQUENCIES:
            errors["frequency_type"] = (
                f"Must be one of: {', '.join(FREQUENCIES)}.")

        interval = data.get("interval_hours", row.interval_hours)
        if frequency == "interval":
            try:
                interval = int(interval)
            except (TypeError, ValueError):
                interval = None
            if interval not in ALLOWED_INTERVAL_HOURS:
                errors["interval_hours"] = (
                    "Must be one of: "
                    f"{', '.join(str(h) for h in ALLOWED_INTERVAL_HOURS)} hours. "
                    "A full refresh is a provider sweep taking minutes, so "
                    "anything shorter would queue runs faster than they finish.")

        day = data.get("day_of_week", row.day_of_week)
        if frequency == "weekly":
            try:
                day = int(day)
            except (TypeError, ValueError):
                day = None
            if day is None or not 0 <= day <= 6:
                errors["day_of_week"] = "Must be 0 (Monday) through 6 (Sunday)."

        time_of_day = str(data.get("time_of_day") or row.time_of_day)
        if _parse_hhmm(time_of_day) is None:
            errors["time_of_day"] = "Must be a 24-hour time such as 02:00."

        zone_name = str(data.get("timezone") or row.timezone)
        if _zone(zone_name) is None:
            errors["timezone"] = (
                f"{zone_name!r} is not a known IANA timezone (for example "
                "Asia/Kolkata or UTC).")

        if errors:
            raise RefreshError("The schedule could not be saved.",
                               code="validation", existing=errors)

        row.frequency_type = frequency
        row.interval_hours = interval if frequency == "interval" else None
        row.day_of_week = day if frequency == "weekly" else None
        row.time_of_day = time_of_day
        row.timezone = zone_name
        if "enabled" in data:
            row.enabled = bool(data["enabled"])
        row.updated_by = actor

        # Recomputed on every save. A schedule whose next_run_at still reflects
        # the OLD cadence would fire at the old time once more, which is
        # exactly when somebody is watching to check the change took effect.
        row.next_run_at = compute_next_run(row) if row.enabled else None
        await self.db.commit()
        await self.db.refresh(row)

        await _record_schedule_event(account, before, row.to_dict(), actor)
        return row.to_dict()


# ── Schedule arithmetic ───────────────────────────────────────────────────────
def _zone(name: str):
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:  # noqa: BLE001
        return None


def _parse_hhmm(value: str) -> Optional[dtime]:
    try:
        hh, mm = str(value).split(":")
        hh, mm = int(hh), int(mm)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return dtime(hh, mm)
    except (ValueError, AttributeError):
        pass
    return None


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def compute_next_run(schedule: CloudAccountRefreshSchedule,
                     *, after: Optional[datetime] = None) -> Optional[datetime]:
    """The next run, in UTC, honouring the schedule's own timezone.

    The whole reason `timezone` is a stored column: "02:00" means 02:00 where
    the operator lives. Computing it in UTC would run an Asia/Kolkata account's
    quiet-hours refresh at 07:30 local, in the middle of the working day.

    Daylight-saving is handled by doing the arithmetic in local time and
    converting once at the end, so "02:00 every day" stays 02:00 across a DST
    boundary rather than drifting by an hour.
    """
    now = after or datetime.now(timezone.utc)

    if schedule.frequency_type == "interval":
        hours = schedule.interval_hours or 24
        return now + timedelta(hours=hours)

    tz = _zone(schedule.timezone) or timezone.utc
    at = _parse_hhmm(schedule.time_of_day) or dtime(2, 0)
    local_now = now.astimezone(tz)

    candidate = local_now.replace(hour=at.hour, minute=at.minute,
                                  second=0, microsecond=0)

    if schedule.frequency_type == "weekly":
        target = schedule.day_of_week if schedule.day_of_week is not None else 0
        delta = (target - candidate.weekday()) % 7
        candidate += timedelta(days=delta)
        # Landing on today but already past the time means next week, not a run
        # that fires the moment it is saved.
        if candidate <= local_now:
            candidate += timedelta(days=7)
    else:
        if candidate <= local_now:
            candidate += timedelta(days=1)

    return candidate.astimezone(timezone.utc)


def describe_schedule(schedule: CloudAccountRefreshSchedule) -> str:
    if not schedule.enabled:
        return "Off"
    if schedule.frequency_type == "interval":
        hours = schedule.interval_hours or 24
        return f"Every {hours} hour{'s' if hours != 1 else ''}"
    if schedule.frequency_type == "weekly":
        day = DAY_NAMES[schedule.day_of_week or 0]
        return f"Every {day} at {schedule.time_of_day} {schedule.timezone}"
    return f"Every day at {schedule.time_of_day} {schedule.timezone}"


# ── The workflow ──────────────────────────────────────────────────────────────
async def _run_refresh(refresh_id: uuid.UUID, account_id: uuid.UUID) -> None:
    """Drive one refresh to completion. Own session; never raises to the caller."""
    from app.core.database import AsyncSessionLocal

    started = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        row = await db.get(CloudAccountRefresh, refresh_id)
        if row is None:
            return
        row.status = REFRESH_RUNNING
        row.started_at = started
        await db.commit()

        from app.repository.cloud_account_repo import CloudAccountRepository

        account = await CloudAccountRepository(db).get_by_id(account_id)
        if account is None:
            await _finish(db, refresh_id, REFRESH_FAILED, started,
                          error="The account no longer exists.",
                          error_code="account_not_found")
            return
        account_name, provider = account.account_name, account.provider

    # ── Discovery: inventory, drift, cost, security, topology ────────────────
    # The refresh id is handed to the worker so it can stamp each component as
    # it goes. This is the ONLY place those run — nothing below re-invokes them.
    try:
        from app.repository.discovery_repo import DiscoveryRepository
        from app.workers.discovery_worker import run_discovery_scan

        async with AsyncSessionLocal() as db:
            job = await DiscoveryRepository(db).create_job(account_id)
            await db.commit()
            await db.refresh(job)
            job_id = job.id
            row = await db.get(CloudAccountRefresh, refresh_id)
            row.discovery_job_id = job_id
            await db.commit()

        await run_discovery_scan(job_id, account_id, refresh_id=refresh_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Refresh %s: discovery failed", refresh_id)
        async with AsyncSessionLocal() as db:
            await _set_component(db, refresh_id, "resources", COMPONENT_FAILED,
                                 detail=str(exc)[:400])
            await db.commit()

    # ── Events: the one component discovery never covered ────────────────────
    async with AsyncSessionLocal() as db:
        await _set_component(db, refresh_id, "events", COMPONENT_RUNNING)
        await db.commit()
    try:
        from app.services.event_collector import collect_account

        # CollectionOutcome is a dict subclass, so this reads by key — an
        # attribute lookup would silently return None and report every
        # collection as "completed" with no numbers.
        outcome = await collect_account(account_id)
        stored = outcome.get("stored")
        failed_scopes = outcome.get("failed") or outcome.get("failed_scopes") or 0
        async with AsyncSessionLocal() as db:
            if failed_scopes:
                # collect_account never raises for a provider failure — it
                # records the failure per scope instead. So "it returned" is
                # not the same as "it worked", and reporting success here
                # would hide a permission error on an audit trail.
                await _set_component(
                    db, refresh_id, "events", COMPONENT_FAILED,
                    detail=(f"{failed_scopes} collection scope(s) could not be "
                            "read. See Collection health on the Event Log tab."))
            else:
                await _set_component(
                    db, refresh_id, "events", COMPONENT_SUCCEEDED,
                    detail=(f"{stored} event(s) stored." if stored is not None
                            else "Collection completed."))
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Refresh %s: event collection failed: %s", refresh_id, exc)
        async with AsyncSessionLocal() as db:
            await _set_component(db, refresh_id, "events", COMPONENT_FAILED,
                                 detail=str(exc)[:400])
            await db.commit()

    # ── Grade it ─────────────────────────────────────────────────────────────
    async with AsyncSessionLocal() as db:
        row = await db.get(CloudAccountRefresh, refresh_id)
        if row is None:
            return
        if row.status == REFRESH_CANCELLED:
            return

        # How many resources this refresh ended up with. Copied from the
        # discovery job that did the counting rather than counted again, so
        # the number on the refresh and the number on the scan cannot
        # disagree. Left null when the sweep never completed — an unknown
        # count must read as unknown, not as zero.
        if row.discovery_job_id is not None:
            from app.models.discovery_job import DiscoveryJob

            job = await db.get(DiscoveryJob, row.discovery_job_id)
            if job is not None and job.resources_found is not None:
                row.resources_found = job.resources_found
                await db.commit()
                row = await db.get(CloudAccountRefresh, refresh_id)

        # Nothing may still be PENDING or RUNNING by the time we grade. If it
        # is, the work either never started or nobody awaited it, and the
        # honest report is "did not report" rather than silence. Recorded
        # against the component itself so the history says which one, and
        # `grade_components` counts it as a failure either way.
        unresolved = unresolved_components(row.components or {})
        for name in unresolved:
            logger.warning("Refresh %s: component %s never reported a result.",
                           refresh_id, name)
            await _set_component(db, refresh_id, name, COMPONENT_FAILED,
                                 detail=UNREPORTED_DETAIL)
        if unresolved:
            await db.commit()
            row = await db.get(CloudAccountRefresh, refresh_id)

        status, failed = grade_components(row.components or {})

        await _finish(db, refresh_id, status, started,
                      error=(f"{len(failed)} component(s) failed: "
                             f"{', '.join(failed)}." if failed else None),
                      error_code="partial" if failed else None)

        row = await db.get(CloudAccountRefresh, refresh_id)
        schedule = (await db.execute(
            select(CloudAccountRefreshSchedule)
            .where(CloudAccountRefreshSchedule.account_id == account_id)
        )).scalars().first()
        if schedule is not None:
            schedule.last_run_at = datetime.now(timezone.utc)
            # Only a run that achieved something moves the success timestamp.
            if status in (REFRESH_SUCCEEDED, REFRESH_PARTIAL):
                schedule.last_success_at = schedule.last_run_at
            await db.commit()

        from app.repository.cloud_account_repo import CloudAccountRepository

        account = await CloudAccountRepository(db).get_by_id(account_id)
        if account is not None:
            await _record_event(
                account, row,
                {"SUCCEEDED": "completed", "PARTIAL": "partial",
                 "FAILED": "failed"}.get(status, "completed"),
                f"Account refresh {status.lower()} for {account_name} "
                f"({provider}).")


async def _finish(db: AsyncSession, refresh_id: uuid.UUID, status: str,
                  started: datetime, *, error: Optional[str] = None,
                  error_code: Optional[str] = None) -> None:
    row = await db.get(CloudAccountRefresh, refresh_id)
    if row is None:
        return
    now = datetime.now(timezone.utc)
    row.status = status
    row.completed_at = now
    row.duration_ms = int((now - started).total_seconds() * 1000)
    if error:
        row.error = error
        row.error_code = error_code
    await db.commit()


async def _set_component(db: AsyncSession, refresh_id: uuid.UUID, name: str,
                         status: str, *, detail: Optional[str] = None) -> None:
    """Stamp one component's outcome.

    Reassigns the whole dict rather than mutating in place: SQLAlchemy does not
    track mutation inside a JSONB column, so an in-place update would be
    silently dropped on flush and every component would stay PENDING.
    """
    row = await db.get(CloudAccountRefresh, refresh_id)
    if row is None:
        return
    comps = dict(row.components or {})
    entry = dict(comps.get(name) or {})
    entry["status"] = status
    if detail:
        entry["detail"] = detail
    now = datetime.now(timezone.utc).isoformat()
    if status == COMPONENT_RUNNING:
        entry["started_at"] = now
    if status in (COMPONENT_SUCCEEDED, COMPONENT_FAILED, COMPONENT_SKIPPED):
        entry["completed_at"] = now
    comps[name] = entry
    row.components = comps


async def set_component(refresh_id: Optional[uuid.UUID], name: str, status: str,
                        *, detail: Optional[str] = None) -> None:
    """Public helper for the discovery worker, which owns its own session.

    A no-op when the scan was not driven by a refresh — Run Discovery on its
    own still works exactly as before and has nothing to stamp.
    """
    if refresh_id is None:
        return
    from app.core.database import AsyncSessionLocal

    try:
        async with AsyncSessionLocal() as db:
            await _set_component(db, refresh_id, name, status, detail=detail)
            await db.commit()
    except Exception as exc:  # noqa: BLE001 — never fail a scan over bookkeeping
        logger.debug("Could not stamp refresh component %s: %s", name, exc)


# ── Event Log integration ─────────────────────────────────────────────────────
async def _record_event(account, refresh, kind: str, summary: str) -> None:
    """Record refresh lifecycle in the alerting activity log.

    NOT in `cloud_events`: that table is the provider control-plane audit
    mirror with `provider NOT NULL`, and an Actmon-initiated refresh was not
    emitted by AWS. Writing it there would corrupt the per-provider counts and
    the collector's health. `cloud_alert_events` is this platform's own
    activity trail and already renders on the Alerts tab.
    """
    from app.core.database import AsyncSessionLocal
    from app.repository.alert_rule_repo import AlertRuleRepository

    try:
        async with AsyncSessionLocal() as db:
            await AlertRuleRepository(db).record(
                action=f"refresh.{kind}",
                account_id=account.id,
                summary=summary,
                detail={
                    "refresh_id": str(refresh.id),
                    "trigger": refresh.trigger_type,
                    "status": refresh.status,
                    "duration_ms": refresh.duration_ms,
                    "provider": account.provider,
                },
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not record a refresh event: %s", exc)


async def _record_schedule_event(account, before: dict, after: dict,
                                 actor: Optional[str]) -> None:
    from app.core.database import AsyncSessionLocal
    from app.repository.alert_rule_repo import AlertRuleRepository

    changed = {k: {"before": before.get(k), "after": after.get(k)}
               for k in ("enabled", "frequency_type", "interval_hours",
                         "day_of_week", "time_of_day", "timezone")
               if before.get(k) != after.get(k)}
    if not changed:
        return
    try:
        async with AsyncSessionLocal() as db:
            await AlertRuleRepository(db).record(
                action="refresh.schedule_changed",
                account_id=account.id,
                actor=actor,
                summary=(f"Automatic refresh for {account.account_name} "
                         f"{'enabled' if after.get('enabled') else 'disabled'}: "
                         f"{after.get('frequency_type')}."),
                detail={"changed": changed, "next_run_at": after.get("next_run_at")},
            )
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not record a schedule change: %s", exc)
