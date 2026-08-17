"""
Bridges the MySQL collector cycle's already-fetched live data into the
historical ClickHouse event/snapshot tables (metrics_history_service.py's
actmon_mysql_* tables) — the Reports architecture's single source of truth.

No new MySQL queries are issued here: every function takes the SAME response
object the collector already builds for the live dashboard/slow-queries/error-log/
binlog/replication snapshots, and only decides what (if anything) is NEW since
the last cycle before writing it to ClickHouse. This keeps historical collection
at zero added load on the monitored MySQL server (§18).

Dedup is in-process, not a ClickHouse SELECT-before-insert: the slow-query log
file and error log are already fully re-parsed every cycle, so re-seeing an
entry we've already flushed is the normal case, not an error. A process
restart may re-flush a handful of entries once — acceptable, self-resolving,
and far cheaper than querying ClickHouse before every insert.
"""
import hashlib
import logging
import re
from datetime import datetime

logger = logging.getLogger("mysql_history_flush")

_SEEN_CAP = 5000  # per-connection cap so a long-lived process can't grow these unboundedly

_slowq_seen = {}   # conn_id -> set(query_id)
_errlog_seen = {}  # conn_id -> set(hash)


def _bounded_add(store: dict, conn_id: int, key: str):
    s = store.setdefault(conn_id, set())
    s.add(key)
    if len(s) > _SEEN_CAP:
        # Cheap unbounded-growth guard: drop the whole set and start fresh
        # rather than tracking insertion order — worst case is a handful of
        # already-seen entries getting re-flushed once, which is harmless.
        store[conn_id] = {key}


def _parse_ts(value):
    if not value:
        return datetime.now()
    s = str(value).strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        pass
    for fmt in ("%y%m%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    m = re.match(r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})", s)
    if m:
        try:
            return datetime.strptime(m.group(1).replace("T", " "), "%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass
    return datetime.now()


def flush_slow_queries(agent_name, conn_id, response):
    """response is get_slow_queries()'s return value — already carries a
    `normalized` list (built_normalized_row shape) with a deterministic
    `query_id` per logged occurrence. Only rows never flushed before for this
    connection are written."""
    if not isinstance(response, dict):
        return
    normalized = response.get("normalized") or []
    if not normalized:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        seen = _slowq_seen.setdefault(conn_id, set())
        rows = []
        for q in normalized:
            qid = q.get("query_id")
            if not qid or qid in seen:
                continue
            rows.append({
                "ts": _parse_ts(q.get("last_seen")),
                "agent": agent_name,
                "conn_id": conn_id,
                "db_name": q.get("database_name") or "",
                "query_hash": qid,
                "query_text": (q.get("query_text") or "")[:8000],
                "execution_time": float(q.get("average_execution_time") or 0) / 1000.0,
                "lock_time": 0.0,
                "rows_sent": int(q.get("rows_returned") or 0),
                "rows_examined": int(q.get("rows_affected") or 0),
                "user": q.get("user_name") or "",
                "host": q.get("host") or "",
                "severity": q.get("severity") or "low",
                "source_log_file": (response.get("slow_log_config") or {}).get("log_file") or "",
            })
            _bounded_add(_slowq_seen, conn_id, qid)
        if rows:
            ch.flush_mysql_slow_queries(rows)
    except Exception as e:  # noqa: BLE001 — historical flush must never break live collection
        logger.debug("[mysql_history_flush] slow_queries conn=%s: %s", conn_id, e)


def flush_error_logs(agent_name, conn_id, response):
    if not isinstance(response, dict):
        return
    logs = response.get("logs") or []
    if not logs:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        seen = _errlog_seen.setdefault(conn_id, set())
        rows = []
        for entry in logs:
            digest_key = "|".join([
                str(entry.get("logged") or ""), str(entry.get("severity") or ""),
                str(entry.get("error_code") or ""), str(entry.get("message") or "")[:300],
            ])
            key = hashlib.md5(digest_key.encode("utf-8", errors="ignore")).hexdigest()
            if key in seen:
                continue
            rows.append({
                "ts": _parse_ts(entry.get("logged")),
                "agent": agent_name,
                "conn_id": conn_id,
                "severity": entry.get("severity") or "INFO",
                "error_code": str(entry.get("error_code") or ""),
                "source": entry.get("subsystem") or entry.get("mysql_level") or "MySQL",
                "message": (entry.get("message") or "")[:4000],
                "log_file": response.get("log_path") or "",
            })
            _bounded_add(_errlog_seen, conn_id, key)
        if rows:
            ch.flush_mysql_error_logs(rows)
    except Exception as e:  # noqa: BLE001
        logger.debug("[mysql_history_flush] error_logs conn=%s: %s", conn_id, e)


def flush_binlog_snapshot(agent_name, conn_id, response):
    """One row per collector cycle — a lightweight status snapshot, never the
    binlog file contents themselves (§7/§18)."""
    if not isinstance(response, dict) or response.get("status") == "error":
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        ch.flush_mysql_binlog_snapshot({
            "ts": datetime.now(),
            "agent": agent_name,
            "conn_id": conn_id,
            "binary_logging": 1 if response.get("enabled") else 0,
            "log_bin": 1 if response.get("enabled") else 0,
            "binlog_format": response.get("format") or "",
            "server_id": int(response.get("server_id") or 0),
            "current_log_file": response.get("current_file") or "",
            "current_position": int(response.get("current_position") or 0),
            "number_of_log_files": int(response.get("file_count") or 0),
            "total_size_bytes": int(response.get("total_size_bytes") or 0),
        })
    except Exception as e:  # noqa: BLE001
        logger.debug("[mysql_history_flush] binlog conn=%s: %s", conn_id, e)


def flush_replication_snapshot(agent_name, conn_id, response):
    """Writes NOTHING when replication isn't configured — absence of rows in a
    time window is how the report layer distinguishes 'Standalone / Not
    Configured' from a real outage (§8/§29), never a fabricated zero row."""
    if not isinstance(response, dict) or response.get("status") == "error":
        return
    is_master = bool(response.get("is_master"))
    is_slave = bool(response.get("is_slave"))
    if not is_master and not is_slave:
        return
    try:
        from app.services.clickhouse import metrics_history_service as ch
        slave_status = response.get("slave_status") or {}
        role = "source" if is_master and not is_slave else ("replica" if is_slave else "source+replica")
        lag = slave_status.get("seconds_behind_master")
        ch.flush_mysql_replication_snapshot({
            "ts": datetime.now(),
            "agent": agent_name,
            "conn_id": conn_id,
            "configured": 1,
            "role": role,
            "io_thread_running": 1 if str(slave_status.get("io_running") or "").lower() == "yes" else 0,
            "sql_thread_running": 1 if str(slave_status.get("sql_running") or "").lower() == "yes" else 0,
            "seconds_behind_source": int(lag) if lag is not None else -1,
            "last_error": str(slave_status.get("last_error") or "")[:2000],
        })
    except Exception as e:  # noqa: BLE001
        logger.debug("[mysql_history_flush] replication conn=%s: %s", conn_id, e)
