"""
Agent reaper - keeps the agent/host list honest when an agent stops reporting.

An agent that's genuinely down (host powered off, service stopped, network
unreachable) simply stops pushing. This background thread notices the silence
(measured against the DB clock, so timezone handling is Postgres's job) and
marks agents / agent-hosts OFFLINE after AGENT_OFFLINE_SECS of silence.

It never deletes an agent or host row, no matter how long it's been silent —
a laptop switched off for a week (or a year) still shows up as Offline, not
removed, so nobody mistakes "the machine is off" for "ActMon uninstalled
itself". If the agent is reinstalled — or the same machine just comes back
online — it re-enrolls on its next push and goes back to Online automatically.
Thresholds are overridable via env: AGENT_OFFLINE_SECS.
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

# PostgreSQL is NOT a telemetry store — it keeps only a short IN-FLIGHT BUFFER of
# telemetry rows (the transport window that feeds Redis/ClickHouse via the insert
# hooks + gives dashboards a fallback). ClickHouse holds all history (90d).
# Pruned every 10 minutes.
METRICS_RETENTION_HOURS = int(os.getenv("METRICS_RETENTION_HOURS", "2"))
_last_prune = 0.0

_stop = threading.Event()
_thread = None
_start_lock = threading.Lock()


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


def _probe_service_states(names):
    """Record WHY each of these agents stopped reporting, straight from its own
    service manager. Runs on its own thread — each probe blocks for its timeout
    when the agent is genuinely down, which is exactly the common case here."""
    from app.services.agent import agent_service_state_service as svc_state
    db = SessionLocal()
    try:
        for name in names:
            try:
                res = svc_state.probe(name, db)
                if not res.get("checked"):
                    continue   # SSH-collected host: no channel, nothing to record
                detail = res["detail"]
                if res.get("running"):
                    # The service answered AND reports itself healthy, yet we just
                    # marked this agent offline for heartbeat silence. Those two
                    # facts together are a distinct diagnosis — the agent process
                    # is alive but its data push is failing (collector script
                    # error, blocked egress, wrong backend URL) — and pointing the
                    # operator at the service would send them the wrong way.
                    detail = (f"{res['detail']} It is running but has stopped sending data — "
                              f"the process is alive, so this is a collection/connectivity "
                              f"problem rather than a stopped service. Check the agent log on "
                              f"the host (Linux: journalctl -u actmon-agent; "
                              f"Windows: C:\\ProgramData\\ActMon\\agent.log).")
                db.execute(text(
                    "UPDATE agents SET last_error = :d WHERE agent_name = :n AND status = 'offline'"),
                    {"d": detail, "n": name})
                db.commit()
                logger.info("[reaper] '%s' service state: %s", name, res["state"])
            except Exception as e:  # noqa: BLE001 — one bad probe must not stop the rest
                db.rollback()
                logger.debug("[reaper] service probe failed for %s: %s", name, e)
    finally:
        db.close()


def _spawn_service_probes(names):
    if not names:
        return
    threading.Thread(target=_probe_service_states, args=(list(names),),
                     daemon=True, name="agent-svc-probe").start()


# Re-probe agents that are ALREADY offline, throttled per agent. Probing only on
# the online->offline transition left the recorded reason frozen at whatever the
# first probe said: an agent offline for hours kept showing a stale message, and
# a fix to the probe itself could never change it because no new transition ever
# happened. Refresh it periodically instead so the reason tracks reality.
_PROBE_REFRESH_SEC = int(os.getenv("AGENT_SVC_PROBE_REFRESH_SECS", "600"))
_probe_last = {}     # agent_name -> monotonic seconds of the last probe


def _due_for_reprobe(names):
    import time as _t
    now = _t.monotonic()
    due = [n for n in names if (now - _probe_last.get(n, 0.0)) >= _PROBE_REFRESH_SEC]
    for n in due:
        _probe_last[n] = now
    # Don't let the throttle dict grow forever as agents come and go.
    if len(_probe_last) > 5000:
        _probe_last.clear()
    return due


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
            # Heartbeat silence says "not reporting"; it can't say WHY. Ask each
            # agent's own service, off-thread so a non-answering host can't stall
            # this pass (the probe waits out its timeout by design).
            _due_for_reprobe(going_offline)   # stamp them so the refresh pass doesn't immediately redo these
            _spawn_service_probes(going_offline)

        # Refresh the recorded reason for agents that were ALREADY offline, so a
        # long-dead host's message stays accurate (and picks up probe fixes)
        # instead of being frozen at its first-ever probe. Throttled per agent by
        # _PROBE_REFRESH_SEC, and it runs off-thread like the transition probes.
        try:
            still_offline = [r[0] for r in db.execute(text(
                "SELECT agent_name FROM agents WHERE status = 'offline'")).fetchall()]
            _spawn_service_probes(_due_for_reprobe(
                [n for n in still_offline if n not in set(going_offline)]))
        except Exception as e:  # noqa: BLE001 — refresh is best-effort
            logger.debug("[reaper] offline re-probe skipped: %s", e)

        # 2) Stale agent-hosts -> Disconnected.
        r = db.execute(text(
            "UPDATE os_servers SET status='Disconnected' "
            "WHERE collector='agent' AND status <> 'Disconnected' AND last_infra_at IS NOT NULL "
            "AND last_infra_at < now() - make_interval(secs => :s)"), {"s": offline_after})
        changed["offline_hosts"] = r.rowcount or 0

        # No step 3 anymore — this used to DELETE a host's agent/server row once
        # it had been silent past REMOVE_AFTER (e.g. a laptop switched off for
        # 15+ minutes with no database attached to it). That made a merely-off
        # machine look "uninstalled" in the UI. An offline agent now just stays
        # offline, however long that lasts — it reappears on its own the moment
        # the machine (and its agent service) comes back and pushes again.

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
    # The is_alive() check and the thread creation below weren't atomic — two
    # near-simultaneous calls (a lifespan re-entry) could both pass the check
    # before either had started its thread, spawning duplicate reapers.
    with _start_lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, args=(interval_sec,), daemon=True, name="agent-reaper")
        _thread.start()
        logger.info("[reaper] started (offline>%ss, every %ss, never removes an agent/host)",
                    monitoring_settings_service.get_settings().offline_after_sec, interval_sec)


def stop_agent_reaper():
    _stop.set()
