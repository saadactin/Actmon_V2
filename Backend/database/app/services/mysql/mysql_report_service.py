"""
MySQL Monitoring Report — single service backing every report period
(live/2h/daily/weekly/monthly/custom), used by the Reports page, PDF export,
and scheduled email report alike (§16, §31, §32: one source of truth, not a
parallel implementation per consumer).

Core rule: MySQL is the source of truth for LIVE/current state; ClickHouse
(via metrics_history_service.py's actmon_mysql_* tables) is the source of
truth for every historical period. Live mode still reads MySQL directly for
its headline cards; ClickHouse is used there only for the small trend
sparkline. No mode ever issues an expensive query against the monitored
MySQL server for historical data (§18).

Every section of the returned dict carries its own `status` —
"live" | "historical" | "not_configured" | "unavailable" — so the frontend
(and the PDF/email consumers of this same dict) can render an honest empty
state instead of turning missing data into a fabricated zero (§29).
"""
import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.clickhouse import metrics_history_service as ch
from app.services.mysql import mysql_slow_query_service, mysql_log_service
from app.utils.mysql_health import compute_health_score

logger = logging.getLogger("mysql_report_service")

MODES = ("live", "2h", "daily", "weekly", "monthly", "custom")

# (window_minutes, bucket_seconds) per mode — mirrors §20's stated granularity
# rules (2h -> minute-level, 7d -> hourly, 30d -> hourly/daily).
_WINDOW = {
    "2h":      (120,     60),
    "daily":   (1440,    3600),
    "weekly":  (10080,   3600),
    "monthly": (43200,   86400),
}


def _bucket_for_range(minutes: float) -> int:
    if minutes <= 180:
        return 60
    if minutes <= 1440:
        return 3600
    if minutes <= 10080:
        return 3600
    return 86400


def _connection_meta(conn_id: int, db: Session) -> dict:
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "mysql"
    ).first()
    if not connection:
        return {}
    return {
        "id": connection.id, "name": connection.connection_name,
        "host": connection.host, "port": connection.port,
        "database": connection.database_name,
    }


def _slowq_summary(rows: list) -> dict:
    if not rows:
        return {"total": 0, "unique": 0, "avg_ms": 0.0, "max_ms": 0.0,
                "total_rows_examined": 0, "total_rows_sent": 0}
    exec_ms = [float(r.get("execution_time") or 0) * 1000 for r in rows]
    return {
        "total": len(rows),
        "unique": len({r.get("query_hash") for r in rows}),
        "avg_ms": round(sum(exec_ms) / len(exec_ms), 2),
        "max_ms": round(max(exec_ms), 2),
        "total_rows_examined": sum(int(r.get("rows_examined") or 0) for r in rows),
        "total_rows_sent": sum(int(r.get("rows_sent") or 0) for r in rows),
    }


def _errlog_summary(rows: list) -> dict:
    counts = {"CRITICAL": 0, "ERROR": 0, "WARNING": 0, "INFO": 0}
    for r in rows:
        sev = str(r.get("severity") or "INFO").upper()
        counts[sev] = counts.get(sev, 0) + 1
    return {"total": len(rows), **counts}


def _live_section(conn_id: int, db: Session) -> dict:
    from app.services.mysql.mysql_dashboard_service import get_dashboard
    dash = get_dashboard(conn_id, db)
    if not isinstance(dash, dict) or dash.get("status") != "success":
        return {"status": "unavailable", "reason": "MySQL dashboard unreachable"}
    hs = dash.get("health_summary") or {}
    long_running = dash.get("long_running_queries") or []
    conn_pct = float(hs.get("connection_usage_pct") or 0)
    cache_pct = float(hs.get("cache_usage_pct") or 0)
    return {
        "status": "live",
        "health_summary": hs,
        "health_score": compute_health_score(len(long_running), conn_pct, cache_pct),
        "long_running_queries": len(long_running),
        "connection_usage_pct": conn_pct,
        "cache_usage_pct": cache_pct,
        "databases": dash.get("databases") or [],
        "replication_state": hs.get("replication_state") or "STANDALONE",
    }


def _resource_section(conn_id: int, mode: str, from_ts=None, to_ts=None) -> dict:
    if mode == "live":
        rows = ch.history_bucketed(minutes=30, bucket_seconds=60, tech="mysql", conn_id=conn_id)
        return {"status": "historical", "granularity_seconds": 60, "points": list(reversed(rows))}
    if mode == "custom":
        span_minutes = max(1, (to_ts - from_ts).total_seconds() / 60)
        bucket = _bucket_for_range(span_minutes)
        rows = ch.history(agent_name=None, minutes=int(span_minutes), tech="mysql", conn_id=conn_id) \
            if span_minutes <= 180 else \
            ch.history_bucketed(minutes=int(span_minutes), bucket_seconds=bucket, tech="mysql", conn_id=conn_id)
        return {"status": "historical", "granularity_seconds": bucket, "points": list(reversed(rows))}
    minutes, bucket = _WINDOW[mode]
    rows = ch.history_bucketed(minutes=minutes, bucket_seconds=bucket, tech="mysql", conn_id=conn_id)
    return {"status": "historical", "granularity_seconds": bucket, "points": list(reversed(rows))}


def _slow_queries_section(conn_id: int, db: Session, mode: str, minutes=None, from_ts=None, to_ts=None) -> dict:
    if mode == "live":
        live = mysql_slow_query_service.get_slow_queries(conn_id, db)
        normalized = (live or {}).get("normalized") or []
        rows = [{
            "query_hash": q.get("query_id"), "db_name": q.get("database_name"),
            "query_text": q.get("query_text"), "execution_time": (q.get("average_execution_time") or 0) / 1000.0,
            "rows_examined": q.get("rows_affected"), "rows_sent": q.get("rows_returned"),
            "user": q.get("user_name"), "host": q.get("host"), "severity": q.get("severity"),
            "ts": q.get("last_seen"),
        } for q in normalized]
        return {"status": "live", "summary": _slowq_summary(rows),
                "top_queries": sorted(rows, key=lambda r: r["execution_time"] or 0, reverse=True)[:20]}
    if mode == "custom":
        rows = ch.query_mysql_slow_queries(conn_id, since=from_ts, until=to_ts)
    else:
        rows = ch.query_mysql_slow_queries(conn_id, minutes=minutes)
    return {"status": "historical", "summary": _slowq_summary(rows),
            "top_queries": sorted(rows, key=lambda r: r.get("execution_time") or 0, reverse=True)[:20]}


def _error_logs_section(conn_id: int, db: Session, mode: str, minutes=None, from_ts=None, to_ts=None) -> dict:
    if mode == "live":
        live = mysql_log_service.get_error_logs(conn_id, db)
        logs = (live or {}).get("logs") or []
        rows = [{"severity": l.get("severity"), "error_code": l.get("error_code"),
                 "message": l.get("message"), "ts": l.get("logged")} for l in logs]
        return {"status": "live", "summary": _errlog_summary(rows), "recent": rows[:20]}
    if mode == "custom":
        rows = ch.query_mysql_error_logs(conn_id, since=from_ts, until=to_ts)
    else:
        rows = ch.query_mysql_error_logs(conn_id, minutes=minutes)
    return {"status": "historical", "summary": _errlog_summary(rows), "recent": rows[:20]}


def _replication_section(conn_id: int, db: Session, mode: str, minutes=None, from_ts=None, to_ts=None) -> dict:
    if mode == "live":
        from app.services.mysql.mysql_replication_service import get_replication_status
        live = get_replication_status(conn_id, db) or {}
        if not live.get("is_master") and not live.get("is_slave"):
            return {"status": "not_configured"}
        return {"status": "live", "is_master": live.get("is_master"), "is_slave": live.get("is_slave"),
                "slave_status": live.get("slave_status"), "master_status": live.get("master_status")}
    if mode == "custom":
        rows = ch.query_mysql_replication_history(conn_id, since=from_ts, until=to_ts, limit=1)
    else:
        rows = ch.query_mysql_replication_history(conn_id, minutes=minutes, limit=1)
    if not rows:
        return {"status": "not_configured"}
    latest = rows[0]
    return {"status": "historical", "role": latest.get("role"),
            "io_thread_running": bool(latest.get("io_thread_running")),
            "sql_thread_running": bool(latest.get("sql_thread_running")),
            "seconds_behind_source": latest.get("seconds_behind_source"),
            "last_error": latest.get("last_error"), "as_of": latest.get("ts")}


def _binlog_section(conn_id: int, db: Session, mode: str, minutes=None, from_ts=None, to_ts=None) -> dict:
    if mode == "live":
        from app.services.mysql.mysql_binlog_service import get_binlog_status
        live = get_binlog_status(conn_id, db) or {}
        if live.get("status") == "error":
            return {"status": "unavailable", "reason": live.get("error")}
        return {"status": "live", **live}
    if mode == "custom":
        rows = ch.query_mysql_binlog_history(conn_id, since=from_ts, until=to_ts, limit=1)
    else:
        rows = ch.query_mysql_binlog_history(conn_id, minutes=minutes, limit=1)
    if not rows:
        return {"status": "unavailable", "reason": "no binlog snapshots collected in this period"}
    latest = rows[0]
    return {"status": "historical", **latest}


def build_report(conn_id: int, db: Session, mode: str = "live", from_ts: datetime = None, to_ts: datetime = None) -> dict:
    if mode not in MODES:
        mode = "live"
    if mode == "custom" and (from_ts is None or to_ts is None):
        mode = "live"

    minutes = _WINDOW.get(mode, (None, None))[0]

    report = {
        "server": _connection_meta(conn_id, db),
        "period": {"mode": mode, "from": from_ts.isoformat() if from_ts else None,
                   "to": to_ts.isoformat() if to_ts else None},
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }

    if mode == "live":
        report["health"] = _live_section(conn_id, db)
        report["resources"] = _resource_section(conn_id, mode)
    else:
        report["health"] = {"status": "historical", "note": "See resources/slow_queries/errors sections for this period"}
        report["resources"] = _resource_section(conn_id, mode, from_ts, to_ts)

    report["slow_queries"] = _slow_queries_section(conn_id, db, mode, minutes, from_ts, to_ts)
    report["errors"] = _error_logs_section(conn_id, db, mode, minutes, from_ts, to_ts)
    report["replication"] = _replication_section(conn_id, db, mode, minutes, from_ts, to_ts)
    report["binary_logs"] = _binlog_section(conn_id, db, mode, minutes, from_ts, to_ts)
    report["processlist"] = (
        {"status": "live", "note": "Use the live dashboard for the current process list"}
        if mode == "live" else
        {"status": "unavailable", "reason": "Historical process-list data is not collected by ActMon"}
    )

    return report
