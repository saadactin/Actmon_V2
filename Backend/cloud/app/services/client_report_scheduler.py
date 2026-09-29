"""Produce and e-mail scheduled client reports.

Built around the lesson of the 2026-09-17 e-mail storm, where a report
scheduler re-sent the same mail every minute because the send succeeded and
the bookkeeping that should have followed it failed:

* **One transaction.** The report row, the queued e-mail and the schedule's
  advance commit together or not at all. Nothing that can fail runs after the
  commit, so there is no "sent, but still due" state to fall into.
* **One report per client per period, enforced by the database.** A partial
  unique index on cloud_client_reports (client_id, period) WHERE
  trigger='schedule' refuses a second scheduled report for the same month. If
  anything ever did slip past the bookkeeping, the insert fails and nothing is
  queued.
* **No catch-up floods.** If the service was down across several due dates,
  only the most recent period is produced; the skipped ones are recorded on the
  schedule so someone can generate them by hand. A year of downtime must not
  become twelve e-mails five minutes apart.
* **A failure advances the schedule anyway**, with the error recorded. A
  report that cannot be built this month is retried next month or by hand —
  never in a loop.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

logger = logging.getLogger("cloud_svc.client_reports.scheduler")

TICK_SECONDS = 300
_stop = asyncio.Event()


def scheduler_enabled() -> bool:
    return os.getenv("CLIENT_REPORT_SCHEDULER_ENABLED", "true").strip().lower() not in (
        "false", "0", "no", "off")


def stop_scheduler() -> None:
    _stop.set()


def plan_run(next_run_at: datetime, now: datetime, *, day_of_month: int, send_time: str,
             tz_name: str) -> Dict[str, Any]:
    """Which run to perform now, and how many due runs are being skipped.

    Pure, so the catch-up rule is testable without a clock: walk forward from
    the overdue run while the NEXT one is also already due, and perform only
    the last. Returns `{run_at, period, skipped_periods, next_run_at}`.
    """
    from app.services.client_report_service import due_period, next_run_after

    run_at = next_run_at
    skipped: List[str] = []
    for _ in range(240):   # 20 years of monthly runs is more than enough
        following = next_run_after(run_at, day_of_month=day_of_month,
                                   send_time=send_time, tz_name=tz_name)
        if following > now:
            break
        skipped.append(due_period(run_at, tz_name))
        run_at = following
    return {
        "run_at": run_at,
        "period": due_period(run_at, tz_name),
        "skipped_periods": skipped,
        "next_run_at": next_run_after(run_at, day_of_month=day_of_month,
                                      send_time=send_time, tz_name=tz_name),
    }


async def run_due(now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    """Run every schedule that is due. Returns one outcome per schedule."""
    from app.core.database import AsyncSessionLocal
    from app.models.client import (
        TRIGGER_SCHEDULE, CloudClientReport, CloudClientReportSchedule,
    )
    from app.services.client_report_service import ClientReportService

    now = now or datetime.now(timezone.utc)
    outcomes: List[Dict[str, Any]] = []
    async with AsyncSessionLocal() as db:
        due = (await db.execute(
            select(CloudClientReportSchedule).where(
                CloudClientReportSchedule.enabled.is_(True),
                CloudClientReportSchedule.next_run_at.is_not(None),
                CloudClientReportSchedule.next_run_at <= now,
            ))).scalars().all()
        schedule_ids = [s.client_id for s in due]

    for client_id in schedule_ids:
        async with AsyncSessionLocal() as db:
            sched = await db.get(CloudClientReportSchedule, client_id)
            if sched is None or not sched.enabled or sched.next_run_at is None \
                    or sched.next_run_at > now:
                continue
            plan = plan_run(sched.next_run_at, now, day_of_month=sched.day_of_month,
                            send_time=sched.send_time, tz_name=sched.timezone)
            period = plan["period"]
            skipped_note = (
                f" Skipped {len(plan['skipped_periods'])} earlier period(s) while the "
                f"service was not running ({', '.join(plan['skipped_periods'])}); "
                "generate them by hand if needed." if plan["skipped_periods"] else "")

            already = (await db.execute(select(CloudClientReport.id).where(
                CloudClientReport.client_id == client_id,
                CloudClientReport.period == period,
                CloudClientReport.trigger == TRIGGER_SCHEDULE))).first()
            if already:
                sched.next_run_at = plan["next_run_at"]
                sched.last_status = "ALREADY_PRODUCED"
                sched.last_message = (f"A scheduled report for {period} already exists; "
                                      "not produced again." + skipped_note)
                sched.last_run_at = now
                await db.commit()
                outcomes.append({"client_id": str(client_id), "period": period,
                                 "outcome": "already_produced"})
                continue

            try:
                report = await ClientReportService(db).generate(
                    client_id, period, send=True, actor="schedule",
                    trigger=TRIGGER_SCHEDULE, schedule=sched, commit=False)
                sched.last_period = period
                sched.last_run_at = now
                # A report that could not be BUILT is the headline, not its
                # delivery ("not requested" would bury the failure). Its row
                # keeps the period's slot, so the schedule does not retry it in
                # a loop; a manual report can always be generated.
                sched.last_status = ("FAILED" if report.get("status") == "FAILED"
                                     else report.get("delivery_status") or report.get("status"))
                sched.last_message = ((report.get("error") or "")
                                      if report.get("status") == "FAILED"
                                      else (report.get("delivery_message") or "")) \
                    + skipped_note
                sched.next_run_at = plan["next_run_at"]
                await db.commit()     # report + e-mail + advance, together
                outcomes.append({"client_id": str(client_id), "period": period,
                                 "outcome": "produced", "report_id": report.get("id"),
                                 "delivery_status": report.get("delivery_status")})
                logger.info("Scheduled report for client %s, %s: %s", client_id, period,
                            sched.last_status)
            except IntegrityError:
                # The unique index refused a duplicate scheduled report. Nothing
                # was queued (same transaction); just move the schedule on.
                await db.rollback()
                await _advance(client_id, plan, now, "ALREADY_PRODUCED",
                               f"A scheduled report for {period} already exists." + skipped_note)
                outcomes.append({"client_id": str(client_id), "period": period,
                                 "outcome": "duplicate_refused"})
            except Exception as exc:  # noqa: BLE001 — recorded, schedule still advances
                await db.rollback()
                logger.exception("Scheduled report failed for client %s", client_id)
                await _advance(client_id, plan, now, "FAILED",
                               f"Could not produce the {period} report: {exc}"[:1500]
                               + skipped_note)
                outcomes.append({"client_id": str(client_id), "period": period,
                                 "outcome": "failed", "error": str(exc)[:300]})
    return outcomes


async def _advance(client_id, plan: Dict[str, Any], now: datetime, status: str,
                   message: str) -> None:
    from app.core.database import AsyncSessionLocal
    from app.models.client import CloudClientReportSchedule

    async with AsyncSessionLocal() as db:
        sched = await db.get(CloudClientReportSchedule, client_id)
        if sched is None:
            return
        sched.next_run_at = plan["next_run_at"]
        sched.last_run_at = now
        sched.last_status = status
        sched.last_message = message
        await db.commit()


async def scheduler_loop() -> None:
    _stop.clear()
    logger.info("Client report scheduler running (tick %ss).", TICK_SECONDS)
    while not _stop.is_set():
        try:
            outcomes = await run_due()
            if outcomes:
                logger.info("Client report scheduler: %s", outcomes)
        except Exception:  # noqa: BLE001 — the loop must survive any one tick
            logger.exception("Client report scheduler tick failed")
        try:
            await asyncio.wait_for(_stop.wait(), timeout=TICK_SECONDS)
        except asyncio.TimeoutError:
            pass
