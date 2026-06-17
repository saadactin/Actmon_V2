from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus
import urllib.request
import urllib.parse
import json
import base64
import logging

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/connections/clickhouse",
    tags=["ClickHouse Monitoring"]
)


# ── Database session ──────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Connection helpers ────────────────────────────────────────────────────────

def _ch_http_port(conn) -> int:
    """
    Return the correct ClickHouse HTTP port.
    Native TCP port 9000 (or 9440 TLS) → use HTTP port 8123.
    Any other port is assumed to already be an HTTP port.
    """
    p = conn.port or 9000
    if p in (9000, 9440):
        return 8123
    return p


def _ch_engine(conn):
    """
    Build a SQLAlchemy engine using the clickhouse-driver native protocol.
    Falls back gracefully if clickhouse-sqlalchemy is not installed.
    """
    pw = quote_plus(conn.password or "")
    native_port = conn.port if conn.port and conn.port not in (8123, 8443) else 9000
    return create_engine(
        f"clickhouse+native://{conn.username}:{pw}@{conn.host}:{native_port}/{conn.database_name or 'default'}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    )


def _rows(engine, sql):
    """Execute *sql* and return all rows as a list of dicts."""
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


def _ch_query_http(conn, sql):
    """
    Execute *sql* via ClickHouse HTTP interface.
    Port mapping: native TCP 9000/9440 → HTTP 8123 automatically.
    Auth: tries X-ClickHouse-User/Key first, then Basic Auth, then query-param auth.
    Raises on all failures.
    """
    import urllib.error as _ue

    http_port = _ch_http_port(conn)
    username  = (conn.username or "default").strip()
    password  = (conn.password or "")
    database  = (conn.database_name or "default").strip()

    params = urllib.parse.urlencode({"query": sql, "default_format": "JSONEachRow"})
    db_enc = urllib.parse.quote(database)
    url    = f"http://{conn.host}:{http_port}/?{params}&database={db_enc}"

    # Three auth strategies in priority order
    auth_strategies = [
        # 1 — X-ClickHouse-User / X-ClickHouse-Key (recommended by ClickHouse docs)
        {"X-ClickHouse-User": username, "X-ClickHouse-Key": password},
        # 2 — HTTP Basic Auth
        {"Authorization": "Basic " + base64.b64encode(
            f"{username}:{password}".encode()).decode()},
        # 3 — No explicit auth header (server may allow default user without auth)
        {},
    ]

    last_err = None
    for headers in auth_strategies:
        try:
            req = urllib.request.Request(url)
            for k, v in headers.items():
                req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read().decode().strip()
                lines = raw.split("\n") if raw else []
                return [json.loads(line) for line in lines if line.strip()]
        except _ue.HTTPError as e:
            try:
                body = e.read().decode()[:300].strip()
            except Exception:
                body = e.reason
            last_err = f"HTTP {e.code}: {body}"
            # 403/401 — try next auth strategy
            if e.code in (401, 403):
                continue
            # Other HTTP errors (400/500) — re-raise immediately
            raise RuntimeError(last_err) from e
        except Exception as e:
            last_err = str(e)
            # Network errors — no point retrying with different auth
            raise

    raise RuntimeError(f"ClickHouse auth failed on {http_port}: {last_err}")


def _query(conn, sql):
    """
    Try HTTP first (stdlib urllib, zero extra packages, maps port 9000→8123),
    then native clickhouse-driver as fallback.
    Returns (rows: list[dict], source: str, error: str | None).
    """
    try:
        rows = _ch_query_http(conn, sql)
        return rows, "http", None
    except Exception as http_err:
        logger.debug("HTTP query failed (%s), trying native driver", http_err)

    # Native TCP fallback via clickhouse-driver
    try:
        from clickhouse_driver import Client as _CHClient
        username = (conn.username or "default").strip()
        native_port = conn.port if conn.port and conn.port not in (8123, 8443) else 9000
        database    = (conn.database_name or "default").strip()
        client = _CHClient(
            host=conn.host,
            port=native_port,
            user=username,
            password=conn.password or "",
            database=database,
            connect_timeout=8,
            settings={"use_numpy": False},
        )
        rows_raw, cols = client.execute(sql, with_column_types=True)
        client.disconnect()
        col_names = [c[0] for c in cols]
        rows = [dict(zip(col_names, row)) for row in rows_raw]
        return rows, "native", None
    except Exception as native_err:
        return [], "none", str(native_err)


def _safe_query(conn, sql):
    """Run *sql*, return (rows, error_str_or_None). Swallows all exceptions."""
    rows, _src, err = _query(conn, sql)
    return rows, err


def _get_connection_or_404(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not rec:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    return rec


# ── Utility ───────────────────────────────────────────────────────────────────

def _uptime_str(seconds):
    """Convert integer seconds to a human-readable string."""
    try:
        s = int(seconds)
        days, rem = divmod(s, 86400)
        hours, rem = divmod(rem, 3600)
        minutes, secs = divmod(rem, 60)
        parts = []
        if days:
            parts.append(f"{days}d")
        if hours:
            parts.append(f"{hours}h")
        if minutes:
            parts.append(f"{minutes}m")
        parts.append(f"{secs}s")
        return " ".join(parts)
    except Exception:
        return str(seconds)


def _metric_value(metrics_rows, name):
    """Extract a numeric value from a system.metrics result list."""
    for row in metrics_rows:
        if row.get("metric") == name:
            try:
                return float(row.get("value", 0))
            except (TypeError, ValueError):
                return 0
    return 0


def _fmt_bytes(b):
    """Convert byte count to a readable string."""
    try:
        b = int(b)
    except (TypeError, ValueError):
        return "0 B"
    if b >= 1 << 30:
        return f"{b / (1 << 30):.2f} GB"
    if b >= 1 << 20:
        return f"{b / (1 << 20):.2f} MB"
    if b >= 1 << 10:
        return f"{b / (1 << 10):.2f} KB"
    return f"{b} B"


# ── Endpoint 1: Main Dashboard ────────────────────────────────────────────────

@router.get("/{conn_id}/ch-dashboard")
def get_ch_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Main dashboard: version, uptime, db count, table count, memory %, query rate,
    disk usage, active queries, recent errors, top tables, top databases,
    merge queue size.
    """
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "ch_dashboard", db)
    if _cached is not None:
        return _cached
    conn = _get_connection_or_404(conn_id, db)
    results = {}
    errors = {}

    # -- Version --
    version_rows, err = _safe_query(conn, "SELECT version() AS version")
    results["version"] = version_rows[0].get("version", "unknown") if version_rows else "unknown"
    if err:
        errors["version"] = err

    # -- Uptime --
    uptime_rows, err = _safe_query(conn, "SELECT uptime() AS uptime_seconds")
    uptime_seconds = 0
    if uptime_rows:
        uptime_seconds = uptime_rows[0].get("uptime_seconds", 0)
        results["uptime_seconds"] = uptime_seconds
        results["uptime_str"] = _uptime_str(uptime_seconds)
    else:
        results["uptime_seconds"] = 0
        results["uptime_str"] = "unknown"
        if err:
            errors["uptime"] = err

    # -- Databases --
    db_rows, err = _safe_query(
        conn,
        "SELECT name, engine FROM system.databases "
        "WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY name"
    )
    results["databases"] = db_rows
    if err:
        errors["databases"] = err

    # -- Top tables by size --
    table_rows, err = _safe_query(
        conn,
        "SELECT database, name, engine, "
        "toUInt64(total_rows) AS total_rows, "
        "toUInt64(total_bytes) AS total_bytes, "
        "formatReadableSize(total_bytes) AS size_pretty "
        "FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY total_bytes DESC "
        "LIMIT 50"
    )
    results["tables"] = table_rows
    if err:
        errors["tables"] = err

    # -- System metrics --
    metrics_rows, err = _safe_query(conn, "SELECT metric, value FROM system.metrics")
    results["metrics"] = metrics_rows
    if err:
        errors["metrics"] = err

    # -- Async metrics --
    async_metrics_rows, err = _safe_query(
        conn,
        "SELECT metric, value FROM system.asynchronous_metrics "
        "WHERE metric IN ("
        "'MemoryResident','MemoryVirtual','MemoryTracking',"
        "'MaxPartCountForPartition','ReplicasMaxQueueSize',"
        "'NumberOfDatabases','NumberOfTables','TotalPartsOfMergeTreeTables',"
        "'OSMemoryTotal','OSMemoryFreePlusCached','DiskTotal','DiskFree'"
        ")"
    )
    results["async_metrics"] = async_metrics_rows
    if err:
        errors["async_metrics"] = err

    # -- Active processes --
    process_rows, err = _safe_query(
        conn,
        "SELECT query_id, user, elapsed, read_rows, read_bytes, "
        "result_rows, memory_usage, LEFT(query, 200) AS query "
        "FROM system.processes "
        "ORDER BY elapsed DESC"
    )
    results["active_processes"] = process_rows
    if err:
        errors["active_processes"] = err

    # -- Recent errors --
    error_rows, err = _safe_query(
        conn,
        "SELECT event_time, type, error_code_id, "
        "LEFT(exception, 300) AS message, user "
        "FROM system.query_log "
        "WHERE type IN ('ExceptionBeforeStart','ExceptionWhileProcessing') "
        "ORDER BY event_time DESC "
        "LIMIT 20"
    )
    results["recent_errors"] = error_rows
    if err:
        errors["recent_errors"] = err

    # -- Disk usage --
    disk_rows, _err = _safe_query(
        conn,
        "SELECT name, path, "
        "toUInt64(free_space) AS free_space, "
        "toUInt64(total_space) AS total_space, "
        "round(100*(1 - free_space/total_space), 1) AS used_pct "
        "FROM system.disks"
    )
    disk_usage = {}
    if disk_rows:
        d = disk_rows[0]
        total = int(d.get("total_space") or 0)
        free = int(d.get("free_space") or 0)
        used = total - free
        disk_usage = {
            "name": d.get("name", "default"),
            "path": d.get("path", ""),
            "total_space": total,
            "free_space": free,
            "used_space": used,
            "used_pct": float(d.get("used_pct") or 0),
            "total_human": _fmt_bytes(total),
            "free_human": _fmt_bytes(free),
            "used_human": _fmt_bytes(used),
        }

    # -- Merges --
    merges_rows, _err = _safe_query(
        conn,
        "SELECT database, \"table\", elapsed, progress, num_parts, "
        "result_part_name, rows_read, bytes_read_uncompressed "
        "FROM system.merges ORDER BY elapsed DESC"
    )

    # -- Replicas --
    replicas_rows, _err = _safe_query(
        conn,
        "SELECT database, \"table\", is_leader, is_readonly, "
        "absolute_delay, queue_size, inserts_in_queue, merges_in_queue, "
        "log_max_index, log_pointer, last_queue_update, last_queue_exception "
        "FROM system.replicas LIMIT 50"
    )

    # -- Settings (changed only) --
    settings_rows, _err = _safe_query(
        conn,
        "SELECT name, value, changed, description, readonly, type "
        "FROM system.settings WHERE changed = 1 LIMIT 50"
    )

    # -- Top databases by size (include all databases so user sees real data) --
    top_db_rows, _err = _safe_query(
        conn,
        "SELECT database, "
        "sum(toUInt64(total_bytes)) AS total_bytes, "
        "count() AS table_count, "
        "sum(toUInt64(total_rows)) AS total_rows "
        "FROM system.tables "
        "GROUP BY database "
        "ORDER BY total_bytes DESC"
    )

    # -- Health calculations --
    memory_tracking = _metric_value(async_metrics_rows, "MemoryTracking")
    mem_total_bytes = _metric_value(async_metrics_rows, "OSMemoryTotal")
    mem_resident = _metric_value(async_metrics_rows, "MemoryResident")
    parts_count = _metric_value(async_metrics_rows, "TotalPartsOfMergeTreeTables")
    max_part_count = _metric_value(async_metrics_rows, "MaxPartCountForPartition")

    memory_pct = 0.0
    if mem_total_bytes > 0 and mem_resident > 0:
        memory_pct = round((mem_resident / mem_total_bytes) * 100, 1)
    elif memory_tracking > 0 and mem_total_bytes > 0:
        memory_pct = round((memory_tracking / mem_total_bytes) * 100, 1)

    query_rate = _metric_value(metrics_rows, "Query")

    health_summary = {
        "version": results.get("version", "unknown"),
        "uptime_str": results.get("uptime_str", "unknown"),
        "uptime_seconds": uptime_seconds,
        "host": conn.host,
        "total_databases": len(db_rows),
        "total_tables": len(table_rows),
        "active_queries": len(process_rows),
        "memory_usage_mb": round(memory_tracking / (1024 * 1024), 2) if memory_tracking else 0,
        "memory_usage_pct": memory_pct,
        "memory_usage_human": _fmt_bytes(mem_resident or memory_tracking),
        "total_memory_human": _fmt_bytes(mem_total_bytes),
        "queries_per_second": round(query_rate, 2),
        "total_parts": int(parts_count),
        "parts_count": int(parts_count),
        "max_part_count_for_partition": int(max_part_count),
        "max_parts_threshold": 3000,
        "replication_enabled": len(replicas_rows) > 0,
        "merge_queue_size": len(merges_rows),
    }

    query_stats = {
        "queries_per_second": round(query_rate, 2),
        "merges": len(merges_rows),
        "parts": int(parts_count),
        "select_count": int(_metric_value(metrics_rows, "SelectQuery")),
        "insert_count": int(_metric_value(metrics_rows, "InsertQuery")),
        "alter_count": 0,
        "create_count": 0,
        "drop_count": 0,
        "failed_count": int(_metric_value(metrics_rows, "FailedQuery")),
        "total_count": 0,
    }

    return {
        "status": "success",
        "connection": {
            "id": conn.id,
            "name": conn.connection_name,
            "host": conn.host,
            "port": conn.port,
            "database": conn.database_name,
        },
        "health_summary": health_summary,
        "version": results.get("version"),
        "uptime_seconds": results.get("uptime_seconds"),
        "uptime_str": results.get("uptime_str"),
        "databases": results.get("databases", []),
        "tables": results.get("tables", []),
        "top_databases": top_db_rows,
        "metrics": results.get("metrics", []),
        "async_metrics": results.get("async_metrics", []),
        "active_processes": results.get("active_processes", []),
        "processes": results.get("active_processes", []),
        "recent_errors": results.get("recent_errors", []),
        "merges": merges_rows,
        "replicas": replicas_rows,
        "settings": settings_rows,
        "disk_usage": disk_usage,
        "query_stats": query_stats,
        "errors": errors if errors else None,
    }


# ── Endpoint 2 (legacy alias): monitoring-dashboard ──────────────────────────

@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """Legacy alias — delegates to ch-dashboard."""
    return get_ch_dashboard(conn_id, db)


# ── Endpoint 3: Active Queries ────────────────────────────────────────────────

@router.get("/{conn_id}/ch-queries")
def get_ch_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns active queries from system.processes:
    query_id, user, elapsed, read_rows, read_bytes, result_rows,
    memory_usage, query truncated to 400 chars.
    """
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "ch_queries", db)
    if _cached is not None:
        return _cached
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    query_id, "
        "    user, "
        "    elapsed, "
        "    read_rows, "
        "    read_bytes, "
        "    result_rows, "
        "    memory_usage, "
        "    LEFT(query, 400) AS query, "
        "    is_initial_query, "
        "    current_database "
        "FROM system.processes "
        "ORDER BY elapsed DESC"
    )
    queries, _src, error = _query(conn, sql)

    # -- summary metrics --
    metrics_rows, _ = _safe_query(conn, "SELECT metric, value FROM system.metrics")
    query_rate = _metric_value(metrics_rows, "Query")
    failed = _metric_value(metrics_rows, "FailedQuery")
    select_q = _metric_value(metrics_rows, "SelectQuery")
    insert_q = _metric_value(metrics_rows, "InsertQuery")

    return {
        "status": "success" if not error else "error",
        "queries": queries,
        "total": len(queries),
        "stats": {
            "queries_per_second": round(query_rate, 2),
            "failed_queries": int(failed),
            "select_queries": int(select_q),
            "insert_queries": int(insert_q),
        },
        "error": error,
    }


# ── Endpoint 4: Query Log ─────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-query-log")
def get_ch_query_log(conn_id: int, db: Session = Depends(get_db)):
    """
    Recent 100 entries from system.query_log:
    query_id, event_time, user, query_kind, elapsed_ms, read_rows,
    read_bytes, result_rows, memory_usage, exception, is_initial_query.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    query_id, "
        "    event_time, "
        "    user, "
        "    query_kind, "
        "    query_duration_ms AS elapsed_ms, "
        "    read_rows, "
        "    read_bytes, "
        "    result_rows, "
        "    memory_usage, "
        "    LEFT(exception, 300) AS exception, "
        "    is_initial_query, "
        "    type, "
        "    LEFT(query, 300) AS query "
        "FROM system.query_log "
        "WHERE type IN ('QueryFinish','ExceptionBeforeStart','ExceptionWhileProcessing') "
        "  AND query NOT LIKE '%system.query_log%' "
        "ORDER BY event_time DESC "
        "LIMIT 100"
    )
    logs, _src, error = _query(conn, sql)

    return {
        "status": "success" if not error else "error",
        "logs": logs,
        "total": len(logs),
        "error": error,
    }


# ── Endpoint 5: Slow Queries ──────────────────────────────────────────────────

@router.get("/{conn_id}/ch-slow-queries")
def get_ch_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Queries >500ms from system.query_log in last 24h,
    sorted by elapsed DESC, top 100.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    query_id, "
        "    event_time, "
        "    user, "
        "    query_duration_ms, "
        "    read_rows, "
        "    read_bytes, "
        "    result_rows, "
        "    memory_usage, "
        "    LEFT(query, 500) AS query, "
        "    type, "
        "    databases, "
        "    tables, "
        "    LEFT(exception, 300) AS exception "
        "FROM system.query_log "
        "WHERE type IN ('QueryFinish','ExceptionWhileProcessing') "
        "  AND query_duration_ms > 500 "
        "  AND event_time >= now() - INTERVAL 24 HOUR "
        "  AND query NOT LIKE '%system.query_log%' "
        "ORDER BY query_duration_ms DESC "
        "LIMIT 100"
    )
    queries, _src, error = _query(conn, sql)

    return {
        "status": "success" if not error else "error",
        "queries": queries,
        "source": "system.query_log",
        "total": len(queries),
        "threshold_ms": 500,
        "window_hours": 24,
        "error": error,
    }


# ── Endpoint 6: Tables ────────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-tables")
def get_ch_tables(conn_id: int, db: Session = Depends(get_db)):
    """
    Enhanced table list: database, name, engine, rows, bytes, compressed_bytes,
    compression_ratio, partitions_count, parts_count, last_modified.
    """
    conn = _get_connection_or_404(conn_id, db)

    # -- Base table info --
    tables_sql = (
        "SELECT "
        "    t.database, "
        "    t.name, "
        "    t.engine, "
        "    toUInt64(t.total_rows) AS rows, "
        "    toUInt64(t.total_bytes) AS bytes, "
        "    formatReadableSize(t.total_bytes) AS size_pretty, "
        "    t.metadata_modification_time AS last_modified "
        "FROM system.tables t "
        "WHERE t.database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY t.total_bytes DESC "
        "LIMIT 500"
    )
    tables_rows, err1 = _safe_query(conn, tables_sql)

    # -- Parts aggregation per table --
    parts_sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    count() AS parts_count, "
        "    countDistinct(partition) AS partitions_count, "
        "    sum(toUInt64(data_compressed_bytes)) AS compressed_bytes, "
        "    sum(toUInt64(data_uncompressed_bytes)) AS uncompressed_bytes "
        "FROM system.parts "
        "WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\""
    )
    parts_rows, err2 = _safe_query(conn, parts_sql)

    # Build lookup map
    parts_map = {}
    for p in parts_rows:
        key = f"{p.get('database','')}.{p.get('table','')}"
        parts_map[key] = p

    # Merge
    for t in tables_rows:
        key = f"{t.get('database','')}.{t.get('name','')}"
        pm = parts_map.get(key, {})
        comp = int(pm.get("compressed_bytes") or 0)
        uncomp = int(pm.get("uncompressed_bytes") or 0)
        ratio = round(uncomp / comp, 2) if comp > 0 else None
        t["parts_count"] = int(pm.get("parts_count") or 0)
        t["partitions_count"] = int(pm.get("partitions_count") or 0)
        t["compressed_bytes"] = comp
        t["uncompressed_bytes"] = uncomp
        t["compression_ratio"] = ratio
        t["compression_ratio_pct"] = round((1 - comp / uncomp) * 100, 1) if uncomp > 0 else 0

    errors = {}
    if err1:
        errors["tables"] = err1
    if err2:
        errors["parts"] = err2

    return {
        "status": "success" if not errors else "partial",
        "tables": tables_rows,
        "total": len(tables_rows),
        "errors": errors if errors else None,
    }


# ── Endpoint 7: Partitions ────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-partitions")
def get_ch_partitions(conn_id: int, db: Session = Depends(get_db)):
    """
    Partition details from system.parts:
    database, table, partition, partition_id, active, rows, bytes, marks, part_count.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    partition, "
        "    partition_id, "
        "    active, "
        "    count() AS part_count, "
        "    sum(toUInt64(rows)) AS rows, "
        "    sum(toUInt64(bytes_on_disk)) AS bytes, "
        "    sum(toUInt64(marks)) AS marks, "
        "    formatReadableSize(sum(toUInt64(bytes_on_disk))) AS size_pretty "
        "FROM system.parts "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\", partition, partition_id, active "
        "ORDER BY bytes DESC "
        "LIMIT 500"
    )
    partitions, _src, error = _query(conn, sql)

    return {
        "status": "success" if not error else "error",
        "partitions": partitions,
        "total": len(partitions),
        "error": error,
    }


# ── Endpoint 8: Merges ────────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-merges")
def get_ch_merges(conn_id: int, db: Session = Depends(get_db)):
    """
    Active merges from system.merges:
    database, table, elapsed, progress, num_parts, source_part_names,
    source_parts_size, result_part_name.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    elapsed, "
        "    progress, "
        "    num_parts, "
        "    source_part_names, "
        "    source_parts_size, "
        "    result_part_name, "
        "    rows_read, "
        "    rows_written, "
        "    bytes_read_uncompressed, "
        "    bytes_written_uncompressed, "
        "    memory_usage "
        "FROM system.merges "
        "ORDER BY elapsed DESC"
    )
    merges, _src, error = _query(conn, sql)

    # -- historical merge rate from events --
    merge_rate_rows, _ = _safe_query(
        conn,
        "SELECT value FROM system.events WHERE event = 'MergedRows'"
    )
    merge_rate = merge_rate_rows[0].get("value", 0) if merge_rate_rows else 0

    return {
        "status": "success" if not error else "error",
        "merges": merges,
        "total": len(merges),
        "merge_rate_total_rows": int(merge_rate),
        "error": error,
    }


# ── Endpoint 9: Replicas ──────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-replicas")
def get_ch_replicas(conn_id: int, db: Session = Depends(get_db)):
    """
    Enhanced replica status from system.replicas:
    database, table, zookeeper_path, is_leader, is_readonly, absolute_delay,
    queue_size, inserts_in_queue, merges_in_queue, log_max_index, log_pointer,
    last_queue_update, last_queue_exception.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    zookeeper_path, "
        "    is_leader, "
        "    can_become_leader, "
        "    is_readonly, "
        "    is_session_expired, "
        "    future_parts, "
        "    parts_to_check, "
        "    zookeeper_name, "
        "    zookeeper_session_expired, "
        "    queue_size, "
        "    inserts_in_queue, "
        "    merges_in_queue, "
        "    part_mutations_in_queue, "
        "    queue_oldest_time, "
        "    inserts_oldest_time, "
        "    merges_oldest_time, "
        "    log_max_index, "
        "    log_pointer, "
        "    last_queue_update, "
        "    absolute_delay, "
        "    total_replicas, "
        "    active_replicas, "
        "    last_queue_exception "
        "FROM system.replicas "
        "ORDER BY absolute_delay DESC, queue_size DESC "
        "LIMIT 100"
    )
    replicas, _src, error = _query(conn, sql)

    # Summary stats
    total = len(replicas)
    leaders = sum(1 for r in replicas if r.get("is_leader"))
    readonly = sum(1 for r in replicas if r.get("is_readonly"))
    with_delay = sum(1 for r in replicas if int(r.get("absolute_delay") or 0) > 0)
    with_errors = sum(1 for r in replicas if r.get("last_queue_exception"))
    total_queue = sum(int(r.get("queue_size") or 0) for r in replicas)

    return {
        "status": "success" if not error else "error",
        "replicas": replicas,
        "total": total,
        "summary": {
            "total_replicated_tables": total,
            "leaders": leaders,
            "readonly": readonly,
            "with_delay": with_delay,
            "with_errors": with_errors,
            "total_queue_size": total_queue,
        },
        "error": error,
    }


# ── Endpoint 10: Clusters ─────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-clusters")
def get_ch_clusters(conn_id: int, db: Session = Depends(get_db)):
    """
    Cluster info from system.clusters:
    cluster, shard_num, shard_weight, replica_num, host_name, host_address,
    port, is_local, user, errors_count, estimated_recovery_time.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    cluster, "
        "    shard_num, "
        "    shard_weight, "
        "    replica_num, "
        "    host_name, "
        "    host_address, "
        "    port, "
        "    is_local, "
        "    user, "
        "    default_database, "
        "    errors_count, "
        "    slowdowns_count, "
        "    estimated_recovery_time "
        "FROM system.clusters "
        "ORDER BY cluster, shard_num, replica_num"
    )
    clusters, _src, error = _query(conn, sql)

    # Group by cluster name
    cluster_map = {}
    for row in clusters:
        cname = row.get("cluster", "default")
        if cname not in cluster_map:
            cluster_map[cname] = {
                "name": cname,
                "shards": 0,
                "replicas": 0,
                "hosts": [],
                "errors": 0,
            }
        cluster_map[cname]["hosts"].append(row)
        cluster_map[cname]["replicas"] += 1
        cluster_map[cname]["errors"] += int(row.get("errors_count") or 0)
        shard = int(row.get("shard_num") or 0)
        if shard > cluster_map[cname]["shards"]:
            cluster_map[cname]["shards"] = shard

    return {
        "status": "success" if not error else "error",
        "clusters": clusters,
        "cluster_summary": list(cluster_map.values()),
        "total_hosts": len(clusters),
        "error": error,
    }


# ── Endpoint 11: Databases ────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-databases")
def get_ch_databases(conn_id: int, db: Session = Depends(get_db)):
    """
    Enhanced databases from system.databases plus table counts and total sizes.
    Also discovers databases found in system.tables but missing from system.databases
    (can happen when the user has restricted access to system.databases).
    """
    conn = _get_connection_or_404(conn_id, db)

    dbs_sql = (
        "SELECT name, engine, data_path, metadata_path, uuid "
        "FROM system.databases "
        "ORDER BY name"
    )
    dbs_rows, err1 = _safe_query(conn, dbs_sql)

    # -- Aggregated sizes per database (all databases visible in system.tables) --
    sizes_sql = (
        "SELECT "
        "    database, "
        "    count() AS table_count, "
        "    sum(toUInt64(total_rows)) AS total_rows, "
        "    sum(toUInt64(total_bytes)) AS total_bytes, "
        "    formatReadableSize(sum(toUInt64(total_bytes))) AS size_pretty "
        "FROM system.tables "
        "GROUP BY database "
        "ORDER BY total_bytes DESC"
    )
    sizes_rows, err2 = _safe_query(conn, sizes_sql)

    sizes_map = {r["database"]: r for r in sizes_rows}

    # Build set of database names already in dbs_rows
    known_db_names = {d.get("name", "") for d in dbs_rows}

    # Add any databases seen in system.tables that are NOT in system.databases
    # (covers permission gaps where user can query tables but not list databases)
    for db_name, sm in sizes_map.items():
        if db_name and db_name not in known_db_names:
            dbs_rows.append({
                "name": db_name,
                "engine": "—",
                "data_path": "",
                "metadata_path": "",
                "uuid": "",
            })
            known_db_names.add(db_name)

    # Attach size/count info to each database row
    for d in dbs_rows:
        nm = d.get("name", "")
        sm = sizes_map.get(nm, {})
        d["table_count"] = int(sm.get("table_count") or 0)
        d["total_rows"]   = int(sm.get("total_rows")   or 0)
        d["total_bytes"]  = int(sm.get("total_bytes")  or 0)
        d["size_pretty"]  = sm.get("size_pretty", "0 B")

    # Sort: databases with tables first, then alphabetically
    dbs_rows.sort(key=lambda d: (-d["total_bytes"], d.get("name", "")))

    errors = {}
    if err1:
        errors["databases"] = err1
    if err2:
        errors["sizes"] = err2

    return {
        "status": "success" if not errors else "partial",
        "databases": dbs_rows,
        "total": len(dbs_rows),
        "errors": errors if errors else None,
    }


# ── Endpoint 12: Settings ─────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-settings")
def get_ch_settings(conn_id: int, db: Session = Depends(get_db)):
    """
    Changed settings from system.settings where changed=1:
    name, value, description, readonly, type.
    """
    conn = _get_connection_or_404(conn_id, db)

    changed_sql = (
        "SELECT name, value, description, readonly, type, changed "
        "FROM system.settings "
        "WHERE changed = 1 "
        "ORDER BY name"
    )
    changed_rows, err1 = _safe_query(conn, changed_sql)

    # Also fetch key settings regardless of changed status
    key_settings_sql = (
        "SELECT name, value, description, readonly, type, changed "
        "FROM system.settings "
        "WHERE name IN ("
        "  'max_memory_usage','max_threads','max_query_size',"
        "  'connect_timeout','receive_timeout','send_timeout',"
        "  'max_result_rows','max_execution_time','max_rows_to_read',"
        "  'allow_experimental_query_cache','enable_http_compression'"
        ") "
        "ORDER BY name"
    )
    key_rows, err2 = _safe_query(conn, key_settings_sql)

    # Merge, de-duplicate
    all_names = {r["name"] for r in changed_rows}
    for r in key_rows:
        if r["name"] not in all_names:
            changed_rows.append(r)

    return {
        "status": "success",
        "settings": changed_rows,
        "changed_count": sum(1 for r in changed_rows if r.get("changed")),
        "total": len(changed_rows),
    }


# ── Endpoint 13: System Metrics ───────────────────────────────────────────────

@router.get("/{conn_id}/ch-system-metrics")
def get_ch_system_metrics(conn_id: int, db: Session = Depends(get_db)):
    """
    From system.metrics, system.asynchronous_metrics, system.events:
    key metrics like QueryThread, Merge, InsertQuery, etc.
    """
    conn = _get_connection_or_404(conn_id, db)

    metrics_rows, err1 = _safe_query(conn, "SELECT metric, value, description FROM system.metrics")

    async_rows, err2 = _safe_query(
        conn,
        "SELECT metric, value FROM system.asynchronous_metrics "
        "WHERE metric IN ("
        "  'MemoryResident','MemoryVirtual','MemoryTracking',"
        "  'OSMemoryTotal','OSMemoryFreePlusCached','OSMemoryBuffersAndCache',"
        "  'MaxPartCountForPartition','TotalPartsOfMergeTreeTables',"
        "  'NumberOfDatabases','NumberOfTables',"
        "  'ReplicasMaxQueueSize','ReplicasMaxAbsoluteDelay',"
        "  'DiskTotal','DiskFree','DiskUsed',"
        "  'OSCPUWaitMicroseconds','OSIOWaitMicroseconds',"
        "  'OSUserTime','OSSystemTime','OSNiceTime'"
        ")"
    )

    events_rows, err3 = _safe_query(
        conn,
        "SELECT event, value, description FROM system.events "
        "WHERE event IN ("
        "  'Query','SelectQuery','InsertQuery','FailedQuery',"
        "  'MergedRows','MergedUncompressedBytes',"
        "  'ReplicatedDataLoss','ReplicatedPartFetches',"
        "  'ReadCompressedBytes','WriteCompressedBytes',"
        "  'NetworkReceiveBytes','NetworkSendBytes',"
        "  'FileOpen','Seek','ReadBufferFromFileDescriptorRead',"
        "  'OSReadChars','OSWriteChars','OSReadBytes','OSWriteBytes'"
        ")"
    )

    errors = {}
    if err1: errors["metrics"] = err1
    if err2: errors["async_metrics"] = err2
    if err3: errors["events"] = err3

    def _val(rows, key):
        for r in rows:
            k = r.get("metric") or r.get("event")
            if k == key:
                try:
                    return float(r.get("value", 0))
                except (TypeError, ValueError):
                    return 0
        return 0

    summary = {
        "memory_resident_bytes": int(_val(async_rows, "MemoryResident")),
        "memory_total_bytes": int(_val(async_rows, "OSMemoryTotal")),
        "memory_pct": round(
            (_val(async_rows, "MemoryResident") / _val(async_rows, "OSMemoryTotal") * 100)
            if _val(async_rows, "OSMemoryTotal") > 0 else 0, 1
        ),
        "total_queries": int(_val(events_rows, "Query")),
        "select_queries": int(_val(events_rows, "SelectQuery")),
        "insert_queries": int(_val(events_rows, "InsertQuery")),
        "failed_queries": int(_val(events_rows, "FailedQuery")),
        "merged_rows": int(_val(events_rows, "MergedRows")),
        "active_merges": int(_val(metrics_rows, "BackgroundMergesAndMutationsPoolTask")),
        "query_threads": int(_val(metrics_rows, "QueryThread")),
        "read_compressed_bytes": int(_val(events_rows, "ReadCompressedBytes")),
        "write_compressed_bytes": int(_val(events_rows, "WriteCompressedBytes")),
        "network_receive_bytes": int(_val(events_rows, "NetworkReceiveBytes")),
        "network_send_bytes": int(_val(events_rows, "NetworkSendBytes")),
        "total_parts": int(_val(async_rows, "TotalPartsOfMergeTreeTables")),
        "max_part_count_for_partition": int(_val(async_rows, "MaxPartCountForPartition")),
        "replicas_max_queue": int(_val(async_rows, "ReplicasMaxQueueSize")),
        "replicas_max_delay": int(_val(async_rows, "ReplicasMaxAbsoluteDelay")),
    }

    return {
        "status": "success" if not errors else "partial",
        "metrics": metrics_rows,
        "async_metrics": async_rows,
        "events": events_rows,
        "summary": summary,
        "errors": errors if errors else None,
    }


# ── Endpoint 14: Error Logs ───────────────────────────────────────────────────

@router.get("/{conn_id}/ch-error-logs")
def get_ch_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """
    Errors from system.query_log (exception != '') + system.text_log level=Error,
    last 200 rows merged, ordered by timestamp desc.
    """
    conn = _get_connection_or_404(conn_id, db)

    combined_logs = []
    source_errors = {}

    # -- query_log errors --
    query_log_sql = (
        "SELECT "
        "    event_time, "
        "    type, "
        "    error_code_id, "
        "    LEFT(exception, 500) AS message, "
        "    LEFT(query, 300) AS query, "
        "    user, "
        "    query_duration_ms "
        "FROM system.query_log "
        "WHERE type IN ('ExceptionBeforeStart','ExceptionWhileProcessing') "
        "ORDER BY event_time DESC "
        "LIMIT 200"
    )
    query_log_rows, err = _safe_query(conn, query_log_sql)
    if err:
        source_errors["query_log"] = err
    for row in query_log_rows:
        combined_logs.append({
            "logged": str(row.get("event_time", "")),
            "severity": "Error",
            "source": "query_log",
            "type": row.get("type", ""),
            "message": row.get("message", ""),
            "query": row.get("query", ""),
            "error_code": row.get("error_code_id", ""),
            "user": row.get("user", ""),
            "elapsed_ms": row.get("query_duration_ms", 0),
        })

    # -- text_log errors --
    text_log_sql = (
        "SELECT "
        "    event_time, "
        "    level AS severity, "
        "    source, "
        "    LEFT(message, 500) AS message "
        "FROM system.text_log "
        "WHERE level IN ('Fatal','Critical','Error','Warning') "
        "ORDER BY event_time DESC "
        "LIMIT 200"
    )
    text_log_rows, err = _safe_query(conn, text_log_sql)
    if err:
        source_errors["text_log"] = err
    for row in text_log_rows:
        combined_logs.append({
            "logged": str(row.get("event_time", "")),
            "severity": row.get("severity", "Error"),
            "source": row.get("source", "text_log"),
            "type": None,
            "message": row.get("message", ""),
            "query": None,
            "error_code": None,
            "user": None,
            "elapsed_ms": None,
        })

    combined_logs.sort(key=lambda x: x.get("logged", ""), reverse=True)
    combined_logs = combined_logs[:200]

    return {
        "status": "success" if not source_errors else "partial",
        "source": "system.query_log + system.text_log",
        "logs": combined_logs,
        "total": len(combined_logs),
        "source_errors": source_errors if source_errors else None,
    }


# ── Endpoint 15: Table Analysis ───────────────────────────────────────────────

@router.get("/{conn_id}/ch-table-analysis")
def get_ch_table_analysis(conn_id: int, db: Session = Depends(get_db)):
    """
    Parts/partitions per table, rows per part distribution,
    size analysis, compression analysis.
    """
    conn = _get_connection_or_404(conn_id, db)
    analysis_errors = {}

    # -- Parts (active, excluding system) --
    parts_sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    partition, "
        "    active, "
        "    rows, "
        "    bytes_on_disk, "
        "    data_compressed_bytes, "
        "    data_uncompressed_bytes, "
        "    marks "
        "FROM system.parts "
        "WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY bytes_on_disk DESC "
        "LIMIT 200"
    )
    parts_rows, err = _safe_query(conn, parts_sql)
    if err:
        analysis_errors["parts"] = err

    # -- Active merges --
    merges_sql = (
        "SELECT "
        "    database, \"table\", elapsed, progress, num_parts, "
        "    rows_read, rows_written "
        "FROM system.merges"
    )
    merges_rows, err = _safe_query(conn, merges_sql)
    if err:
        analysis_errors["merges"] = err

    # -- Table-level aggregation --
    table_stats_sql = (
        "SELECT "
        "    database, "
        "    name AS table_name, "
        "    engine, "
        "    toUInt64(total_rows) AS total_rows, "
        "    toUInt64(total_bytes) AS total_bytes, "
        "    formatReadableSize(total_bytes) AS size_pretty "
        "FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "  AND engine LIKE '%MergeTree%' "
        "ORDER BY total_bytes DESC "
        "LIMIT 100"
    )
    table_stats_rows, err = _safe_query(conn, table_stats_sql)
    if err:
        analysis_errors["table_stats"] = err

    # -- Compression per table --
    compression_sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    sum(toUInt64(data_compressed_bytes)) AS compressed, "
        "    sum(toUInt64(data_uncompressed_bytes)) AS uncompressed, "
        "    count() AS parts_count "
        "FROM system.parts "
        "WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\" "
        "ORDER BY uncompressed DESC "
        "LIMIT 100"
    )
    compression_rows, err = _safe_query(conn, compression_sql)
    if err:
        analysis_errors["compression"] = err

    for r in compression_rows:
        comp = int(r.get("compressed") or 0)
        uncomp = int(r.get("uncompressed") or 0)
        r["compression_ratio"] = round(uncomp / comp, 2) if comp > 0 else None
        r["savings_pct"] = round((1 - comp / uncomp) * 100, 1) if uncomp > 0 else 0
        r["compressed_human"] = _fmt_bytes(comp)
        r["uncompressed_human"] = _fmt_bytes(uncomp)

    # -- Summary --
    total_bytes_on_disk = sum(int(p.get("bytes_on_disk") or 0) for p in parts_rows)
    total_compressed = sum(int(p.get("data_compressed_bytes") or 0) for p in parts_rows)
    total_uncompressed = sum(int(p.get("data_uncompressed_bytes") or 0) for p in parts_rows)
    compression_ratio = round(total_uncompressed / total_compressed, 2) if total_compressed > 0 else None

    table_part_counts: dict = {}
    for p in parts_rows:
        key = f"{p.get('database','')}.{p.get('table','')}"
        table_part_counts[key] = table_part_counts.get(key, 0) + 1

    summary = {
        "total_active_parts": len(parts_rows),
        "total_bytes_on_disk": total_bytes_on_disk,
        "total_bytes_on_disk_human": _fmt_bytes(total_bytes_on_disk),
        "total_compressed_bytes": total_compressed,
        "total_uncompressed_bytes": total_uncompressed,
        "compression_ratio": compression_ratio,
        "active_merges": len(merges_rows),
        "tables_with_parts": len(table_part_counts),
        "table_part_counts": table_part_counts,
    }

    return {
        "status": "success" if not analysis_errors else "partial",
        "parts": parts_rows,
        "merges": merges_rows,
        "table_stats": table_stats_rows,
        "compression": compression_rows,
        "summary": summary,
        "errors": analysis_errors if analysis_errors else None,
    }
