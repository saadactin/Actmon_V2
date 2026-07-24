"""
Agent reaper - keeps the agent/host list honest when an agent is uninstalled.

An uninstalled agent simply stops pushing. This background thread notices the
silence (measured against the DB clock, so timezone handling is Postgres's job) and:

  * marks agents / agent-hosts OFFLINE after AGENT_OFFLINE_SECS of silence, and
  * REMOVES a long-silent host agent (AGENT_REMOVE_SECS) *only* when it has no DB
    monitoring attached - so a pure host (uninstalled laptop/server) disappears,
    while a host with a configured database just goes offline and is kept until
    an operator removes it explicitly.

If the agent is reinstalled it re-enrolls on its next push and reappears.
Thresholds are overridable via env: AGENT_OFFLINE_SECS, AGENT_REMOVE_SECS.
"""
import logging
import os
import threading

from sqlalchemy import text

from app.database.connection import SessionLocal
from app.services.agent import monitoring_settings_service

logger = logging.getLogger("agent_reaper")

# Default offline threshold is 180s (3 min = 12 missed pushes at the 15s cadence —
# a truly dead agent, not one that's merely busy with a long job; 120s made those
# flap offline↔online). Now Super Admin configurable from the Settings page —
# see monitoring_settings_service.get_settings().offline_after_sec, read fresh on
# every reap pass below instead of a fixed constant.
REMOVE_AFTER = int(os.getenv("AGENT_REMOVE_SECS", "900"))      # 15 min silence -> uninstalled

# PostgreSQL is NOT a telemetry store — it keeps only a short IN-FLIGHT BUFFER of
# telemetry rows (the transport window that feeds Redis/ClickHouse via the insert
# hooks + gives dashboards a fallback). ClickHouse holds all history (90d).
# Pruned every 10 minutes.
METRICS_RETENTION_HOURS = int(os.getenv("METRICS_RETENTION_HOURS", "2"))
_last_prune = 0.0

_stop = threading.Event()
_thread = None


def _notify(db, agent_name, message, severity):
    """Raise a bell notification (once, on transition) so operators see the change."""
    try:
        db.execute(text(
            "INSERT INTO agent_notifications (agent_name, message, severity, is_read, created_at) "
            "VALUES (:n, :m, :sev, FALSE, now())"),
            {"n": agent_name, "m": message, "sev": severity})
    except Exception as e:  # noqa: BLE001
        logger.warning("[reaper] notify failed for %s: %s", agent_name, e)


def _prune_metrics(db):
    """Every 10 min: trim PostgreSQL's telemetry tables to the in-flight buffer window
    (default 2h). PG is transport, not storage — full history lives in ClickHouse."""
    global _last_prune
    import time as _t
    if (_t.monotonic() - _last_prune) < 600 and _last_prune:
        return
    _last_prune = _t.monotonic()
    for table, col in (("agent_metrics", "timestamp"), ("agent_top_sql", "timestamp"),
                       ("agent_wait_events", "timestamp"), ("agent_sessions", "timestamp")):
        try:
            r = db.execute(text(
                f"DELETE FROM {table} WHERE {col} < now() - make_interval(hours => :h)"),
                {"h": METRICS_RETENTION_HOURS})
            if r.rowcount:
                logger.info("[reaper] pruned %s rows from %s (>%sh buffer)",
                            r.rowcount, table, METRICS_RETENTION_HOURS)
        except Exception as e:  # noqa: BLE001 — a missing column/table must not stop reaping
            logger.debug("[reaper] prune %s skipped: %s", table, e)
            db.rollback()
    db.commit()


def reap_once():
    """One reaping pass. Returns a dict of what changed (for logging/tests)."""
    db = SessionLocal()
    changed = {"offline_agents": 0, "offline_hosts": 0, "removed_hosts": []}
    offline_after = monitoring_settings_service.get_settings().offline_after_sec
    try:
        _prune_metrics(db)
        # 1) Stale agents -> offline. ADAPTIVE per agent: an agent is offline only
        # after max(offline_after, 4 × its own collection interval, ...) of silence —
        # so a slow/busy host that reports every 60s isn't flapped by a fixed 3-min
        # rule, and status changes only after genuinely missed collection cycles.
        #
        # A host running SEVERAL database engines side by side (one test box with
        # MySQL + MSSQL + Oracle + ... all monitored through the same physical agent)
        # serializes their collection cycles — that agent processes one job at a time
        # (see actmon_agent.py's job loop), so each connection's own cycle can take
        # noticeably longer to come around when it shares a host with many others.
        # Give those busier hosts proportionally more grace instead of flapping them.
        sibling_counts = dict(db.execute(text(
            "SELECT s.agent_token, COUNT(*) FROM agents a "
            "JOIN database_instances di ON di.connection_id = a.db_connection_id "
            "JOIN os_servers s ON s.id = di.server_id "
            "WHERE s.agent_token IS NOT NULL GROUP BY s.agent_token"
        )).fetchall())

        candidates = db.execute(text(
            "SELECT a.agent_name, a.last_heartbeat, a.collection_interval_sec, s.agent_token, "
            "EXTRACT(EPOCH FROM (now() - a.last_heartbeat)) AS silent_secs "
            "FROM agents a "
            "LEFT JOIN database_instances di ON di.connection_id = a.db_connection_id "
            "LEFT JOIN os_servers s ON s.id = di.server_id "
            "WHERE a.status <> 'offline' AND a.last_heartbeat IS NOT NULL"
        )).fetchall()

        going_offline = []
        for name, _last_hb, interval_sec, token, silent_secs in candidates:
            interval = interval_sec or 60
            n_siblings = sibling_counts.get(token, 1) if token else 1
            floor = max(offline_after, interval * 4, interval * n_siblings * 2)
            if silent_secs is not None and silent_secs > floor:
                going_offline.append(name)

        if going_offline:
            r = db.execute(text(
                "UPDATE agents SET status='offline' WHERE agent_name = ANY(:names) "
                "AND status <> 'offline'"), {"names": going_offline})
            changed["offline_agents"] = r.rowcount or 0
            for name in going_offline:
                _notify(db, name, f"Agent '{name}' went offline - it stopped reporting "
                                  f"(uninstalled or host unreachable).", "warning")

        # 2) Stale agent-hosts -> Disconnected.
        r = db.execute(text(
            "UPDATE os_servers SET status='Disconnected' "
            "WHERE collector='agent' AND status <> 'Disconnected' AND last_infra_at IS NOT NULL "
            "AND last_infra_at < now() - make_interval(secs => :s)"), {"s": offline_after})
        changed["offline_hosts"] = r.rowcount or 0

        # 3) Remove long-silent host agents that have NO database monitoring attached
        #    (the "uninstalled laptop/server" case, e.g. ACTIN-CS-81/85). A host with a
        #    configured DB target (e.g. a PostgreSQL/MySQL server) is KEPT and only
        #    marked offline - we never silently delete a configured monitoring target.
        stale = db.execute(text(
            "SELECT s.id, s.hostname FROM os_servers s "
            "WHERE s.collector='agent' AND s.last_infra_at IS NOT NULL "
            "AND s.last_infra_at < now() - make_interval(secs => :s) "
            "AND NOT EXISTS (SELECT 1 FROM database_instances di WHERE di.server_id = s.id)"),
            {"s": REMOVE_AFTER}).fetchall()
        for sid, hostname in stale:
            db.execute(text("DELETE FROM os_servers WHERE id=:id"), {"id": sid})
            # matching host-agent row (agent_name == hostname, host-type only)
            db.execute(text("DELETE FROM agents WHERE agent_name=:n AND (db_type IS NULL OR lower(db_type)='host')"),
                       {"n": hostname})
            changed["removed_hosts"].append(hostname)
            _notify(db, hostname, f"Host '{hostname}' was removed - its agent has been "
                                  f"uninstalled/silent for over {REMOVE_AFTER // 60} minutes.", "critical")
            logger.info("[reaper] removed uninstalled host '%s' (id %s)", hostname, sid)

        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.error("[reaper] pass failed: %s", e)
    finally:
        db.close()
    return changed


def _loop(interval):
    # first pass shortly after startup, then every `interval` seconds
    while not _stop.wait(15):
        reap_once()
        if _stop.wait(max(0, interval - 15)):
            break


def start_agent_reaper(interval_sec=15):
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, args=(interval_sec,), daemon=True, name="agent-reaper")
    _thread.start()
    logger.info("[reaper] started (offline>%ss, remove>%ss, every %ss)",
                monitoring_settings_service.get_settings().offline_after_sec, REMOVE_AFTER, interval_sec)


def stop_agent_reaper():
    _stop.set()
