"""
Periodic SSH refresh for OS-server hosts — the missing piece that kept
DatabaseInstance.status (Running/Stopped) current. Before this, `status` only
changed when a user clicked "Refresh" on that host in the UI; a "Database
Service Down" alert could keep firing hours or days after the service was
actually restarted, because nothing ever re-checked it. Agent-collected hosts
push their own status continuously (see agent_collector_service.py) and are
skipped here — this is only for the SSH-polled collector path.

Same daemon-thread-polling-a-table pattern as every other scheduler in this
app (see mysql_report_email_service.py's _scheduler_loop).
"""
import logging
import threading

from app.database.connection import SessionLocal
from app.models.os_server_model import OsServer
from app.services.os_server.os_server_service import svc_refresh_server

log = logging.getLogger("os_server_refresh")

TICK_SECONDS = 180  # 3 minutes — frequent enough that a real recovery/outage
                     # shows up promptly, without hammering every host's SSH.


def _tick():
    with SessionLocal() as db:
        servers = (
            db.query(OsServer)
            .filter(
                OsServer.collector == "ssh",
                OsServer.monitoring_enabled.is_(True),
                OsServer.ssh_username.isnot(None),
                OsServer.ssh_password.isnot(None),
            )
            .all()
        )
        for server in servers:
            try:
                svc_refresh_server(server.id, db)
            except Exception:  # noqa: BLE001 — one unreachable host must not skip the rest
                log.exception("SSH refresh failed for server %s (%s)", server.id, server.server_name)
                db.rollback()


_stop = threading.Event()
_thread = None
_lock = threading.Lock()


def _loop():
    while not _stop.is_set():
        try:
            _tick()
        except Exception:  # noqa: BLE001
            log.exception("OS server refresh tick crashed")
        _stop.wait(TICK_SECONDS)


def start_os_server_refresh_scheduler():
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="os_server_refresh")
        _thread.start()


def stop_os_server_refresh_scheduler():
    _stop.set()
