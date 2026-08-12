"""
Notification dispatch/retry queue — polls notification_queue for due rows,
sends via the resolved channel adapter (channel_dispatch.send), and writes a
terminal notification_history row once a job succeeds or exhausts retries.

Same daemon-thread-polling-a-table pattern as the report-email schedulers,
just on a much shorter tick — retries need finer granularity than a 60s
report-email tick, and the alert engine "must never wait for notifications
to complete" (this thread is exactly how that's true: the evaluator only
ever INSERTs a queue row and returns immediately).
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from app.database.connection import SessionLocal
from app.models.notification_model import NotificationQueue, NotificationHistory, NotificationChannel
from app.services.notifications import channel_dispatch
from app.services.notifications.channel_config_service import record_send_result

log = logging.getLogger("notification_dispatcher")

TICK_SECONDS = 10
# Widening backoff per attempt — attempt 1 retries in 30s, attempt 2 in 2m,
# attempt 3+ in 10m, so a broken channel degrades to slow retries instead of
# a hot loop (same philosophy as the report-email schedulers' next_run_at).
RETRY_BACKOFF_SECONDS = [30, 120, 600]


def _next_backoff(attempt_count: int) -> int:
    idx = min(attempt_count, len(RETRY_BACKOFF_SECONDS) - 1)
    return RETRY_BACKOFF_SECONDS[idx]


def _write_history(db, job: NotificationQueue, *, status, response_code, response_time_ms, error, recipient=None):
    ctx = (job.payload or {}).get("context", {})
    db.add(NotificationHistory(
        org_id=job.org_id,
        alert_rule_id=job.alert_rule_id,
        alert_name=ctx.get("AlertName"),
        server_name=ctx.get("ServerName"),
        database_name=ctx.get("DatabaseName"),
        severity=ctx.get("Severity"),
        channel_type=job.channel_type,
        recipient=recipient,
        status=status,
        response_code=response_code,
        response_time_ms=response_time_ms,
        retry_count=job.attempt_count,
        error_message=error,
    ))
    db.commit()


def _process_one(db, job: NotificationQueue):
    channel_row = (
        db.query(NotificationChannel)
        .filter(NotificationChannel.org_id == job.org_id, NotificationChannel.channel_type == job.channel_type)
        .first()
    )
    if not channel_row or not channel_row.enabled:
        job.status = "failed"
        job.last_error = "Channel is disabled or not configured."
        job.sent_at = datetime.utcnow()
        db.commit()
        _write_history(db, job, status="failed", response_code=None, response_time_ms=None, error=job.last_error)
        return

    context = (job.payload or {}).get("context", {})
    recipients_override = (job.payload or {}).get("recipients_override") or None
    cc_override = (job.payload or {}).get("cc_override") or None
    bcc_override = (job.payload or {}).get("bcc_override") or None
    started = time.monotonic()
    try:
        result = channel_dispatch.send(
            db, job.org_id, channel_row, context,
            recipients_override=recipients_override, cc_override=cc_override, bcc_override=bcc_override,
        )
    except Exception as exc:  # noqa: BLE001 — a bad adapter must not crash the dispatcher
        log.exception("Notification adapter raised for channel %s", job.channel_type)
        result = {"status": "error", "message": str(exc), "response_code": None}
    elapsed_ms = (time.monotonic() - started) * 1000

    ok = result.get("status") == "success"
    record_send_result(db, channel_row, ok, error=None if ok else result.get("message"))

    if ok:
        job.status = "sent"
        job.sent_at = datetime.utcnow()
        db.commit()
        _write_history(db, job, status="sent", response_code=result.get("response_code"), response_time_ms=elapsed_ms, error=None, recipient=result.get("recipient"))
        return

    job.attempt_count += 1
    job.last_error = result.get("message")
    if job.attempt_count >= job.max_attempts:
        job.status = "failed"
        job.sent_at = datetime.utcnow()
        db.commit()
        _write_history(db, job, status="failed", response_code=result.get("response_code"), response_time_ms=elapsed_ms, error=job.last_error, recipient=result.get("recipient"))
    else:
        job.next_attempt_at = datetime.utcnow() + timedelta(seconds=_next_backoff(job.attempt_count))
        db.commit()


def _tick():
    with SessionLocal() as db:
        now = datetime.utcnow()
        jobs = (
            db.query(NotificationQueue)
            .filter(NotificationQueue.status == "pending", NotificationQueue.next_attempt_at <= now)
            .limit(50)
            .all()
        )
        for job in jobs:
            try:
                _process_one(db, job)
            except Exception:  # noqa: BLE001 — one bad job must not stop the rest of the batch
                db.rollback()
                log.exception("Notification dispatch failed for job %s", job.id)


_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def _loop():
    while not _stop.is_set():
        try:
            _tick()
        except Exception:  # noqa: BLE001
            log.exception("Notification dispatcher tick crashed")
        _stop.wait(TICK_SECONDS)


def start_notification_dispatcher():
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="notification_dispatcher")
        _thread.start()


def stop_notification_dispatcher():
    _stop.set()
