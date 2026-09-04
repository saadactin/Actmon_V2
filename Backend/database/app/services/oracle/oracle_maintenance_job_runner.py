"""
Executes APPROVED Oracle Storage Health maintenance jobs — the one place in
this feature that runs mutating SQL. Same daemon-thread-polling-a-table
pattern as every other scheduler in this app (see
os_server_refresh_scheduler.py). Processes exactly ONE job per tick, globally
— a deliberate simplicity/safety choice, not a limitation to fix later.

Timeout handling: for a direct Oracle connection, a real oracledb call_timeout
is set on the raw cursor (same technique as oracle_storage_decision_service's
precise-check). For an agent-routed connection there is no raw cursor to set
one on — execution instead goes through db_proxy_service's existing agent RPC
timeout. Either way, a timeout surfaces as a normal exception and the job is
marked 'failed' with the real error text — it never hangs the thread.
"""

import logging
import threading
from datetime import datetime

from sqlalchemy import func, or_, text

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.oracle_maintenance_job_model import OracleMaintenanceJob
from app.services.oracle.oracle_monitoring_service import _get_engine
from app.services.oracle.oracle_storage_service import oracle_storage_object_detail

log = logging.getLogger("oracle_maintenance_job_runner")

TICK_SECONDS = 4  # a human just clicked Start and is watching a live page — poll fast
EXECUTION_TIMEOUT_MS = 30 * 60 * 1000  # 30 minutes — SHRINK/MOVE/REBUILD on a large object legitimately takes time

_ACTION_LABELS = {
    "shrink_space": "Shrink Space", "move": "Move", "truncate_table": "Truncate Table",
    "enable_row_movement": "Enable Row Movement", "disable_row_movement": "Disable Row Movement",
    "index_maintenance_rebuild": "Rebuild Index", "index_rebuild_online": "Rebuild Index Online",
    "index_coalesce": "Coalesce Index", "index_rebuild_unusable": "Rebuild Unusable Index",
    "gather_table_stats": "Gather Table Statistics", "gather_schema_stats": "Gather Schema Statistics",
    "gather_index_stats": "Gather Index Statistics",
    "move_partition": "Move Partition", "shrink_partition": "Shrink Partition",
    "rebuild_partition": "Rebuild Partition", "merge_partition": "Merge Partition",
    "split_partition": "Split Partition", "drop_partition": "Drop Partition",
    "purge_recyclebin": "Purge Recycle Bin", "datafile_resize": "Resize Datafile",
}

# object_type -> the 'object_type' oracle_storage_object_detail() understands,
# and how to turn this job's object_name into the (owner, name) pair it takes.
# Anything not listed here has no meaningful "size before/after" — before/
# after stay null rather than guessing, matching the spec's "space reclaimed
# where applicable".
_SNAPSHOT_KIND = {
    "table": "segment", "segment": "segment", "index": "index",
    "partition": "partition", "datafile": "datafile",
}


def _capture_snapshot(conn_id, db, object_type: str, object_name: str):
    kind = _SNAPSHOT_KIND.get(object_type)
    if not kind:
        return None
    try:
        if kind == "datafile":
            # object_name is a filesystem path, not OWNER.NAME — may itself
            # contain dots (Windows paths, versioned filenames), so it is
            # never split like every other object_type here.
            return oracle_storage_object_detail(conn_id, db, "datafile", "", object_name)
        if kind == "partition":
            owner, table, partition = object_name.split(".", 2)
            return oracle_storage_object_detail(conn_id, db, "partition", owner, f"{table}.{partition}")
        owner, name = object_name.split(".", 1)
        return oracle_storage_object_detail(conn_id, db, kind, owner, name)
    except Exception as exc:  # noqa: BLE001 — a snapshot failure must not abort the job itself
        return {"status": "error", "error": str(exc)}


def _notify(db, job, event: str, extra: dict = None):
    """Queue an email via the app's existing notification pipeline
    (NotificationQueue -> notification_queue_service's dispatcher -> the
    org's configured email channel) — reuses retry/backoff/history for free
    instead of sending synchronously from this thread. Silently a no-op if
    the job has no recipients, and never lets a notification failure affect
    the job's own status — this is best-effort, not the point of the job."""
    if not job.notification_recipients:
        return
    try:
        from app.models.notification_model import NotificationQueue
        from app.services.notifications.template_service import build_context

        extra = extra or {}
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == job.conn_id).first()
        action_label = _ACTION_LABELS.get(job.recommended_action, job.recommended_action)

        if event == "started":
            severity, current_value, description = "Information", "Running", \
                f"{action_label} started on {job.object_name}."
        elif event == "succeeded":
            reclaimed = extra.get("reclaimed_mb")
            severity, current_value, description = "Information", \
                (f"{reclaimed} MB reclaimed" if reclaimed is not None else "Completed"), \
                f"{action_label} on {job.object_name} completed successfully." + (
                    f" Reclaimed {reclaimed} MB." if reclaimed is not None else "")
        else:  # failed
            severity, current_value, description = "Critical", "Failed", \
                f"{action_label} on {job.object_name} failed."

        context = build_context(
            organization="ActMon", alert_name=f"Storage Maintenance — {action_label}", severity=severity,
            server_name=(conn.connection_name if conn else "") or "", hostname=(conn.host if conn else "") or "",
            database_name=job.object_name, database_type="oracle",
            metric="Maintenance Status", current_value=current_value, threshold="",
            error=extra.get("error", "") if event == "failed" else "",
            ip_address="", timestamp=datetime.utcnow().isoformat() + "Z",
            alert_description=description,
        )
        db.add(NotificationQueue(
            org_id=job.org_id or 1,
            channel_type="email",
            payload={
                "context": context,
                "recipients_override": job.notification_recipients,
                "cc_override": [], "bcc_override": [],
            },
        ))
        db.commit()
    except Exception:  # noqa: BLE001 — a notification failure must never affect the job itself
        db.rollback()
        log.exception("[oracle_maintenance] failed to queue '%s' notification for job %s", event, job.id)


def _execute_ddl(engine, sql: str):
    """Direct connections get a real call_timeout on the raw oracledb cursor.
    Agent-routed connections (no raw_connection()) fall back to the normal
    proxied execute path, whose own RPC timeout in db_proxy_service applies."""
    try:
        raw = engine.raw_connection()
    except Exception:
        raw = None

    if raw is not None:
        try:
            cur = raw.cursor()
            try:
                cur.call_timeout = EXECUTION_TIMEOUT_MS
            except Exception:  # noqa: BLE001 — not every driver/version exposes call_timeout
                pass
            cur.execute(sql)
            try:
                raw.commit()
            except Exception:  # noqa: BLE001 — Oracle DDL implicitly commits regardless
                pass
        finally:
            raw.close()
        return

    with engine.connect() as c:
        # Only ever reached for an agent-routed connection (raw_connection() above
        # always succeeds for a real direct engine) — _AgentConnection.execute()
        # takes this kwarg (seconds) so a long DDL waits past the agent proxy's
        # normal ~25s interactive-query cap instead of a false "didn't answer".
        c.execute(text(sql), timeout=EXECUTION_TIMEOUT_MS / 1000)


def _tick():
    with SessionLocal() as db:
        # Approval alone no longer queues execution — a human must either
        # explicitly click Start (start_requested_at) or the object's
        # scheduled_at time must have arrived.
        now = datetime.utcnow()
        job = (
            db.query(OracleMaintenanceJob)
            .filter(
                OracleMaintenanceJob.status == "approved",
                or_(
                    OracleMaintenanceJob.start_requested_at.isnot(None),
                    OracleMaintenanceJob.scheduled_at <= now,
                ),
            )
            .order_by(func.coalesce(OracleMaintenanceJob.start_requested_at, OracleMaintenanceJob.scheduled_at).asc())
            .first()
        )
        if not job:
            return

        job.status = "running"
        job.execution_started_at = datetime.utcnow()
        db.commit()
        _notify(db, job, "started")

        job_id = job.id
        conn_id = job.conn_id
        object_type = job.object_type
        object_name = job.object_name
        sql = job.proposed_sql

        before = _capture_snapshot(conn_id, db, object_type, object_name) or {}

        try:
            conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
            if not conn:
                raise RuntimeError(f"Connection {conn_id} no longer exists")
            engine = _get_engine(conn)
            _execute_ddl(engine, sql)

            after = _capture_snapshot(conn_id, db, object_type, object_name) or {}
            reclaimed_mb = None
            if before.get("status") == "success" and after.get("status") == "success" \
                    and before.get("size_mb") is not None and after.get("size_mb") is not None:
                reclaimed_mb = round((before.get("size_mb") or 0) - (after.get("size_mb") or 0), 2)

            job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
            job.status = "succeeded"
            job.executed_sql = sql
            job.before_metrics = before
            job.after_metrics = after
            job.reclaimed_mb = reclaimed_mb
            job.execution_ended_at = datetime.utcnow()
            db.commit()
            log.info("[oracle_maintenance] job %s succeeded (%s)", job_id, job.object_name)
            _notify(db, job, "succeeded", {"reclaimed_mb": reclaimed_mb})
        except Exception as exc:  # noqa: BLE001 — must never crash the loop
            db.rollback()
            job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
            job.status = "failed"
            job.executed_sql = sql
            job.before_metrics = before
            job.error_details = str(exc)
            job.execution_ended_at = datetime.utcnow()
            db.commit()
            log.warning("[oracle_maintenance] job %s failed: %s", job_id, exc)
            _notify(db, job, "failed", {"error": str(exc)})


_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def _loop():
    while not _stop.is_set():
        try:
            _tick()
        except Exception:  # noqa: BLE001
            log.exception("Oracle maintenance job runner tick crashed")
        _stop.wait(TICK_SECONDS)


def start_oracle_maintenance_job_runner():
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="oracle_maintenance_job_runner")
        _thread.start()


def stop_oracle_maintenance_job_runner():
    _stop.set()
