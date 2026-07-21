"""
Backend adapter for the standalone `actmon_logs` module (Backend/actmon_logs).

The actmon_logs package owns the ClickHouse store (config / writer / reader).
This adapter — which lives inside the DB backend and can see the ORM models —
samples each agent's latest metrics and hands them to actmon_logs.write_metrics().
"""
import os
import sys
import time
import threading
import warnings

# Make the sibling `Backend/actmon_logs` package importable (backend runs from Backend/database).
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import actmon_logs  # noqa: E402  (Backend/actmon_logs)

from datetime import datetime, timedelta, timezone   # noqa: E402
from app.database.connection import SessionLocal   # noqa: E402
from app.models.agent_model import Agent, AgentMetric, AgentTopSQL, AgentNotification   # noqa: E402

# AgentMetric column → logical metric name stored in ClickHouse
_METRIC_MAP = [
    ("cpu",         "db_cpu"),
    ("host_cpu",    "host_cpu"),
    ("memory",      "host_memory"),
    ("connections", "connections_used"),
    ("sessions",    "active_sessions"),
    ("cache_hit",   "cache_hit_pct"),
    ("qps",         "qps"),
    ("tps",         "tps"),
]

_started = False


# ── thin pass-throughs used by the routes ──
def status():
    return actmon_logs.status()


def catalog():
    return actmon_logs.catalog()


def query_series(db_type, metric, connection_id=None, hours=6):
    return actmon_logs.query_series(db_type, metric, connection_id, hours)


def snapshot(db_type=None):
    return actmon_logs.snapshot(db_type)


def history(db_type, connection_id, hours=1):
    return actmon_logs.history(db_type, connection_id, hours)


def spikes(db_type, metric, connection_id=None, hours=24):
    return actmon_logs.spikes(db_type, metric, connection_id, hours)


def _agent_names(db, connection_id):
    if not connection_id:
        return None
    return [a.agent_name for a in db.query(Agent).filter(Agent.db_connection_id == int(connection_id)).all()]


def sql_logs(db, connection_id=None, hours=24, limit=300):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=int(hours))
    q = db.query(AgentTopSQL).filter(AgentTopSQL.captured_at >= cutoff)
    names = _agent_names(db, connection_id)
    if names is not None:
        if not names:
            return []
        q = q.filter(AgentTopSQL.agent_name.in_(names))
    rows = q.order_by(AgentTopSQL.captured_at.desc()).limit(int(limit)).all()
    return [{"captured_at": str(r.captured_at), "agent": r.agent_name, "sql_id": r.sql_id,
             "sql_text": r.sql_text, "executions": r.executions, "avg_ms": r.avg_elapsed_ms,
             "total_ms": r.total_ms, "cpu_ms": r.cpu_time_ms, "rows_examined": r.rows_examined}
            for r in rows]


def error_logs(db, connection_id=None, hours=72, severity=None, limit=400):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=int(hours))
    q = db.query(AgentNotification).filter(AgentNotification.created_at >= cutoff)
    names = _agent_names(db, connection_id)
    if names is not None:
        if not names:
            return []
        q = q.filter(AgentNotification.agent_name.in_(names))
    if severity and severity != "all":
        q = q.filter(AgentNotification.severity == severity)
    rows = q.order_by(AgentNotification.created_at.desc()).limit(int(limit)).all()
    return [{"created_at": str(r.created_at), "agent": r.agent_name, "severity": r.severity,
             "message": r.message, "is_read": r.is_read} for r in rows]


# ── the part that needs ORM access ──
def log_now(db):
    """Snapshot every agent's latest metrics → ClickHouse (via actmon_logs)."""
    rows = []
    for a in db.query(Agent).all():
        m = (db.query(AgentMetric)
             .filter(AgentMetric.agent_name == a.agent_name)
             .order_by(AgentMetric.timestamp.desc()).first())
        if not m:
            continue
        base = dict(org_id=1, db_type=(a.db_type or "").lower(),
                    connection_id=a.db_connection_id or 0,
                    host=a.hostname or a.ip_address or a.agent_name)
        for metric, col in _METRIC_MAP:
            val = getattr(m, col, None)
            if val is None:
                continue
            rows.append({**base, "metric": metric, "value": val})
    return actmon_logs.write_metrics(rows)


def start_metric_logger():
    global _started
    if _started:
        return
    if not actmon_logs.logs_enabled():
        warnings.warn("[actmon_logs] ACTMON_LOGS_ENABLED=false — metric logger NOT started (ClickHouse off).")
        return
    _started = True
    interval = max(1, int(actmon_logs.CONFIG["sample_interval_sec"]))

    def _loop():
        time.sleep(8)                  # let startup settle
        retention_done = False
        while True:
            db = SessionLocal()
            try:
                if actmon_logs.ensure_schema():
                    if not retention_done:
                        actmon_logs.apply_retention(); retention_done = True
                    log_now(db)
                # if ClickHouse is down it self-heals after the cooldown — keep ticking.
            except Exception as e:
                warnings.warn(f"[actmon_logs] logger tick error: {e}")
            finally:
                db.close()
            time.sleep(interval)

    threading.Thread(target=_loop, name="actmon-metric-logger", daemon=True).start()
    warnings.warn(f"[actmon_logs] metric logger started (every {interval}s → {actmon_logs.TABLE}).")
