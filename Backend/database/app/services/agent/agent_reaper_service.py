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

logger = logging.getLogger("agent_reaper")

OFFLINE_AFTER = int(os.getenv("AGENT_OFFLINE_SECS", "120"))    # 2 min silence -> offline
REMOVE_AFTER = int(os.getenv("AGENT_REMOVE_SECS", "900"))      # 15 min silence -> uninstalled

_stop = threading.Event()
_thread = None


def reap_once():
    """One reaping pass. Returns a dict of what changed (for logging/tests)."""
    db = SessionLocal()
    changed = {"offline_agents": 0, "offline_hosts": 0, "removed_hosts": []}
    try:
        # 1) Stale agents -> offline.
        r = db.execute(text(
            "UPDATE agents SET status='offline' "
            "WHERE status <> 'offline' AND last_heartbeat IS NOT NULL "
            "AND last_heartbeat < now() - make_interval(secs => :s)"), {"s": OFFLINE_AFTER})
        changed["offline_agents"] = r.rowcount or 0

        # 2) Stale agent-hosts -> Disconnected.
        r = db.execute(text(
            "UPDATE os_servers SET status='Disconnected' "
            "WHERE collector='agent' AND status <> 'Disconnected' AND last_infra_at IS NOT NULL "
            "AND last_infra_at < now() - make_interval(secs => :s)"), {"s": OFFLINE_AFTER})
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


def start_agent_reaper(interval_sec=60):
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, args=(interval_sec,), daemon=True, name="agent-reaper")
    _thread.start()
    logger.info("[reaper] started (offline>%ss, remove>%ss, every %ss)",
                OFFLINE_AFTER, REMOVE_AFTER, interval_sec)


def stop_agent_reaper():
    _stop.set()
