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

def _ch_engine(conn):
    """Build a SQLAlchemy engine using the clickhouse-sqlalchemy native driver."""
    pw = quote_plus(conn.password or "")
    return create_engine(
        f"clickhouse+native://{conn.username}:{pw}@{conn.host}:{conn.port or 9000}/{conn.database_name or 'default'}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    )


def _rows(engine, sql):
    """Execute *sql* and return all rows as a list of dicts."""
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


def _ch_query_http(conn, sql):
    """Execute *sql* via the ClickHouse HTTP interface and return rows as dicts."""
    params = urllib.parse.urlencode({"query": sql, "default_format": "JSONEachRow"})
    url = f"http://{conn.host}:{conn.port or 8123}/?{params}"
    req = urllib.request.Request(url)
    if conn.username:
        creds = base64.b64encode(
            f"{conn.username}:{conn.password or ''}".encode()
        ).decode()
        req.add_header("Authorization", f"Basic {creds}")
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read().decode().strip()
        lines = raw.split("\n") if raw else []
        return [json.loads(line) for line in lines if line.strip()]


def _query(conn, sql):
    """
    Try SQLAlchemy (clickhouse+native) first; fall back to ClickHouse HTTP API.
    Returns (rows: list[dict], source: str, error: str | None).
    """
    try:
        engine = _ch_engine(conn)
        rows = _rows(engine, sql)
        return rows, "sqlalchemy", None
    except Exception as sa_err:
        logger.debug("SQLAlchemy failed (%s), trying HTTP fallback", sa_err)
        try:
            rows = _ch_query_http(conn, sql)
            return rows, "http", None
        except Exception as http_err:
            return [], "none", str(http_err)


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


# ── Endpoint 1: Monitoring Dashboard ─────────────────────────────────────────

@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns a comprehensive monitoring dashboard for a ClickHouse instance,
    including version, uptime, databases, tables, metrics, active processes,
    and recent errors.
    """
    conn = _get_connection_or_404(conn_id, db)

    results = {}
    errors = {}

    # -- Version --
    version_rows, err = _safe_query(conn, "SELECT version() AS version")
    if version_rows:
        results["version"] = version_rows[0].get("version", "unknown")
    else:
        results["version"] = "unknown"
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

    # -- Table stats --
    table_rows, err = _safe_query(
        conn,
        "SELECT database, name, engine, total_rows, "
        "formatReadableSize(total_bytes) AS size_pretty, total_bytes "
        "FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY total_bytes DESC "
        "LIMIT 50"
    )
    results["tables"] = table_rows
    if err:
        errors["tables"] = err

    # -- System metrics --
    metrics_rows, err = _safe_query(
        conn,
        "SELECT metric, value FROM system.metrics"
    )
    results["metrics"] = metrics_rows
    if err:
        errors["metrics"] = err

    # -- Async metrics (subset) --
    async_metrics_rows, err = _safe_query(
        conn,
        "SELECT metric, value FROM system.asynchronous_metrics "
        "WHERE metric IN ("
        "'MemoryTracking','MaxPartCountForPartition',"
        "'ReplicasMaxQueueSize','NumberOfDatabases',"
        "'NumberOfTables','TotalPartsOfMergeTreeTables'"
        ")"
    )
    results["async_metrics"] = async_metrics_rows
    if err:
        errors["async_metrics"] = err

    # -- Current running processes --
    process_rows, err = _safe_query(
        conn,
        "SELECT query_id, user, elapsed, read_rows, read_bytes, memory_usage, "
        "LEFT(query, 200) AS query "
        "FROM system.processes "
        "ORDER BY elapsed DESC"
    )
    results["active_processes"] = process_rows
    if err:
        errors["active_processes"] = err

    # -- Recent errors from query_log --
    error_rows, err = _safe_query(
        conn,
        "SELECT event_time, type, error_code_id, message "
        "FROM system.query_log "
        "WHERE type = 'ExceptionWhileProcessing' "
        "ORDER BY event_time DESC "
        "LIMIT 20"
    )
    results["recent_errors"] = error_rows
    if err:
        errors["recent_errors"] = err

    # -- Health summary --
    memory_tracking = _metric_value(async_metrics_rows, "MemoryTracking")
    parts_count = _metric_value(async_metrics_rows, "TotalPartsOfMergeTreeTables")

    health_summary = {
        "version": results.get("version", "unknown"),
        "uptime_str": results.get("uptime_str", "unknown"),
        "host": conn.host,
        "total_databases": len(db_rows),
        "total_tables": len(table_rows),
        "active_queries": len(process_rows),
        "memory_usage_mb": round(memory_tracking / (1024 * 1024), 2) if memory_tracking else 0,
        "parts_count": int(parts_count),
    }

    return {
        "status": "success",
        "health_summary": health_summary,
        "version": results.get("version"),
        "uptime_seconds": results.get("uptime_seconds"),
        "uptime_str": results.get("uptime_str"),
        "databases": results.get("databases", []),
        "tables": results.get("tables", []),
        "metrics": results.get("metrics", []),
        "async_metrics": results.get("async_metrics", []),
        "active_processes": results.get("active_processes", []),
        "recent_errors": results.get("recent_errors", []),
        "errors": errors if errors else None,
    }


# ── Endpoint 2: Slow Queries ──────────────────────────────────────────────────

@router.get("/{conn_id}/ch-slow-queries")
def get_ch_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns slow queries from system.query_log (duration > 100 ms),
    ordered by query_duration_ms descending, up to 100 rows.
    """
    conn = _get_connection_or_404(conn_id, db)

    sql = (
        "SELECT "
        "    query_id, "
        "    event_time, "
        "    query_duration_ms, "
        "    read_rows, "
        "    read_bytes, "
        "    result_rows, "
        "    memory_usage, "
        "    LEFT(query, 500) AS query, "
        "    type, "
        "    user, "
        "    databases, "
        "    tables "
        "FROM system.query_log "
        "WHERE type IN ('QueryFinish', 'ExceptionWhileProcessing') "
        "  AND query_duration_ms > 100 "
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
        "error": error,
    }


# ── Endpoint 3: Error Logs ────────────────────────────────────────────────────

@router.get("/{conn_id}/ch-error-logs")
def get_ch_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns error-level entries from system.query_log and system.text_log,
    merged and ordered by timestamp descending.
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
        "    LEFT(message, 500) AS message, "
        "    LEFT(query, 300) AS query, "
        "    user, "
        "    exception "
        "FROM system.query_log "
        "WHERE type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing') "
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
            "message": row.get("message", "") or row.get("exception", ""),
            "query": row.get("query", ""),
            "error_code": row.get("error_code_id", ""),
            "user": row.get("user", ""),
        })

    # -- text_log errors --
    text_log_sql = (
        "SELECT "
        "    event_time, "
        "    level AS severity, "
        "    source, "
        "    message "
        "FROM system.text_log "
        "WHERE level IN ('Fatal', 'Critical', 'Error', 'Warning') "
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
        })

    # Sort merged list by timestamp descending (lexicographic on ISO strings is fine)
    combined_logs.sort(key=lambda x: x.get("logged", ""), reverse=True)

    overall_status = "success" if not source_errors else "partial"

    return {
        "status": overall_status,
        "source": "system.query_log + system.text_log",
        "logs": combined_logs,
        "total": len(combined_logs),
        "source_errors": source_errors if source_errors else None,
    }


# ── Endpoint 4: Table Analysis ────────────────────────────────────────────────

@router.get("/{conn_id}/ch-table-analysis")
def get_ch_table_analysis(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns per-table MergeTree parts, active merge operations, and
    aggregated table-level statistics.
    """
    conn = _get_connection_or_404(conn_id, db)

    analysis_errors = {}

    # -- Parts (active only, excluding system) --
    parts_sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    partition, "
        "    active, "
        "    rows, "
        "    bytes_on_disk, "
        "    data_compressed_bytes, "
        "    data_uncompressed_bytes "
        "FROM system.parts "
        "WHERE active = 1 "
        "  AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') "
        "ORDER BY bytes_on_disk DESC "
        "LIMIT 100"
    )
    parts_rows, err = _safe_query(conn, parts_sql)
    if err:
        analysis_errors["parts"] = err

    # -- Active merges --
    merges_sql = (
        "SELECT "
        "    database, "
        "    \"table\", "
        "    elapsed, "
        "    progress, "
        "    num_parts, "
        "    rows_read, "
        "    rows_written "
        "FROM system.merges"
    )
    merges_rows, err = _safe_query(conn, merges_sql)
    if err:
        analysis_errors["merges"] = err

    # -- Aggregated table-level stats from system.tables --
    table_stats_sql = (
        "SELECT "
        "    database, "
        "    name AS table_name, "
        "    engine, "
        "    total_rows, "
        "    total_bytes, "
        "    formatReadableSize(total_bytes) AS size_pretty "
        "FROM system.tables "
        "WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') "
        "  AND engine LIKE '%MergeTree%' "
        "ORDER BY total_bytes DESC "
        "LIMIT 100"
    )
    table_stats_rows, err = _safe_query(conn, table_stats_sql)
    if err:
        analysis_errors["table_stats"] = err

    # -- Summary --
    total_bytes_on_disk = sum(
        int(p.get("bytes_on_disk", 0) or 0) for p in parts_rows
    )
    total_compressed = sum(
        int(p.get("data_compressed_bytes", 0) or 0) for p in parts_rows
    )
    total_uncompressed = sum(
        int(p.get("data_uncompressed_bytes", 0) or 0) for p in parts_rows
    )
    compression_ratio = (
        round(total_uncompressed / total_compressed, 2)
        if total_compressed > 0
        else None
    )

    # Group part counts per table
    table_part_counts: dict = {}
    for p in parts_rows:
        key = f"{p.get('database', '')}.{p.get('table', '')}"
        table_part_counts[key] = table_part_counts.get(key, 0) + 1

    summary = {
        "total_active_parts": len(parts_rows),
        "total_bytes_on_disk": total_bytes_on_disk,
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
        "summary": summary,
        "errors": analysis_errors if analysis_errors else None,
    }
