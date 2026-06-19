import base64
import json
import logging
import urllib.error as _ue
import urllib.parse
import urllib.request
from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

logger = logging.getLogger(__name__)


# ── Connection helpers ────────────────────────────────────────────────────────

def _ch_http_port(conn) -> int:
    p = conn.port or 9000
    if p in (9000, 9440):
        return 8123
    return p


def _ch_engine(conn):
    pw = quote_plus(conn.password or "")
    native_port = conn.port if conn.port and conn.port not in (8123, 8443) else 9000
    return create_engine(
        f"clickhouse+native://{conn.username}:{pw}@{conn.host}:{native_port}/{conn.database_name or 'default'}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    )


def _rows(engine, sql):
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


def _ch_query_http(conn, sql):
    http_port = _ch_http_port(conn)
    username  = (conn.username or "default").strip()
    password  = (conn.password or "")
    database  = (conn.database_name or "default").strip()

    params = urllib.parse.urlencode({"query": sql, "default_format": "JSONEachRow"})
    db_enc = urllib.parse.quote(database)
    url    = f"http://{conn.host}:{http_port}/?{params}&database={db_enc}"

    auth_strategies = [
        {"X-ClickHouse-User": username, "X-ClickHouse-Key": password},
        {"Authorization": "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()},
        {},
    ]

    last_err = None
    for headers in auth_strategies:
        try:
            req = urllib.request.Request(url)
            for k, v in headers.items():
                req.add_header(k, v)
            with urllib.request.urlopen(req, timeout=10) as r:
                raw   = r.read().decode().strip()
                lines = raw.split("\n") if raw else []
                return [json.loads(line) for line in lines if line.strip()]
        except _ue.HTTPError as e:
            try:
                body = e.read().decode()[:300].strip()
            except Exception:
                body = e.reason
            last_err = f"HTTP {e.code}: {body}"
            if e.code in (401, 403):
                continue
            raise RuntimeError(last_err) from e
        except Exception as e:
            last_err = str(e)
            raise

    raise RuntimeError(f"ClickHouse auth failed on {http_port}: {last_err}")


def _query(conn, sql):
    try:
        rows = _ch_query_http(conn, sql)
        return rows, "http", None
    except Exception as http_err:
        logger.debug("HTTP query failed (%s), trying native driver", http_err)

    try:
        from clickhouse_driver import Client as _CHClient
        username    = (conn.username or "default").strip()
        native_port = conn.port if conn.port and conn.port not in (8123, 8443) else 9000
        database    = (conn.database_name or "default").strip()
        client      = _CHClient(
            host=conn.host, port=native_port, user=username,
            password=conn.password or "", database=database,
            connect_timeout=8, settings={"use_numpy": False},
        )
        rows_raw, cols = client.execute(sql, with_column_types=True)
        client.disconnect()
        col_names = [c[0] for c in cols]
        rows      = [dict(zip(col_names, row)) for row in rows_raw]
        return rows, "native", None
    except Exception as native_err:
        return [], "none", str(native_err)


def _safe_query(conn, sql):
    rows, _src, err = _query(conn, sql)
    return rows, err


def _get_connection_or_404(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not rec:
        raise HTTPException(404, "ClickHouse connection not found")
    return rec


# ── Utility helpers ───────────────────────────────────────────────────────────

def _uptime_str(seconds):
    try:
        s = int(seconds)
        days, rem   = divmod(s, 86400)
        hours, rem  = divmod(rem, 3600)
        minutes, s  = divmod(rem, 60)
        parts = []
        if days:    parts.append(f"{days}d")
        if hours:   parts.append(f"{hours}h")
        if minutes: parts.append(f"{minutes}m")
        parts.append(f"{s}s")
        return " ".join(parts)
    except Exception:
        return str(seconds)


def _metric_value(metrics_rows, name):
    for row in metrics_rows:
        if row.get("metric") == name:
            try:
                return float(row.get("value", 0))
            except (TypeError, ValueError):
                return 0
    return 0


def _fmt_bytes(b):
    try:
        b = int(b)
    except (TypeError, ValueError):
        return "0 B"
    if b >= 1 << 30: return f"{b / (1 << 30):.2f} GB"
    if b >= 1 << 20: return f"{b / (1 << 20):.2f} MB"
    if b >= 1 << 10: return f"{b / (1 << 10):.2f} KB"
    return f"{b} B"


# ═════════════════════════════════════════════════════════════════════════════
#  Service functions
# ═════════════════════════════════════════════════════════════════════════════

def get_dashboard(conn_id: int, db: Session) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "ch_dashboard", db)
    if cached is not None:
        return cached

    conn    = _get_connection_or_404(conn_id, db)
    results = {}
    errors  = {}

    version_rows, err = _safe_query(conn, "SELECT version() AS version")
    results["version"] = version_rows[0].get("version", "unknown") if version_rows else "unknown"
    if err: errors["version"] = err

    uptime_rows, err = _safe_query(conn, "SELECT uptime() AS uptime_seconds")
    uptime_seconds = 0
    if uptime_rows:
        uptime_seconds = uptime_rows[0].get("uptime_seconds", 0)
        results["uptime_seconds"] = uptime_seconds
        results["uptime_str"]     = _uptime_str(uptime_seconds)
    else:
        results["uptime_seconds"] = 0
        results["uptime_str"]     = "unknown"
        if err: errors["uptime"] = err

    db_rows, err = _safe_query(
        conn,
        "SELECT name, engine FROM system.databases "
        "WHERE name NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY name",
    )
    results["databases"] = db_rows
    if err: errors["databases"] = err

    table_rows, err = _safe_query(
        conn,
        "SELECT database, name, engine, "
        "toUInt64(total_rows) AS total_rows, "
        "toUInt64(total_bytes) AS total_bytes, "
        "formatReadableSize(total_bytes) AS size_pretty "
        "FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY total_bytes DESC LIMIT 50",
    )
    results["tables"] = table_rows
    if err: errors["tables"] = err

    metrics_rows, err = _safe_query(conn, "SELECT metric, value FROM system.metrics")
    results["metrics"] = metrics_rows
    if err: errors["metrics"] = err

    async_metrics_rows, err = _safe_query(
        conn,
        "SELECT metric, value FROM system.asynchronous_metrics "
        "WHERE metric IN ("
        "'MemoryResident','MemoryVirtual','MemoryTracking',"
        "'MaxPartCountForPartition','ReplicasMaxQueueSize',"
        "'NumberOfDatabases','NumberOfTables','TotalPartsOfMergeTreeTables',"
        "'OSMemoryTotal','OSMemoryFreePlusCached','DiskTotal','DiskFree'"
        ")",
    )
    results["async_metrics"] = async_metrics_rows
    if err: errors["async_metrics"] = err

    process_rows, err = _safe_query(
        conn,
        "SELECT query_id, user, elapsed, read_rows, read_bytes, "
        "result_rows, memory_usage, LEFT(query, 200) AS query "
        "FROM system.processes ORDER BY elapsed DESC",
    )
    results["active_processes"] = process_rows
    if err: errors["active_processes"] = err

    error_rows, err = _safe_query(
        conn,
        "SELECT event_time, type, error_code_id, "
        "LEFT(exception, 300) AS message, user "
        "FROM system.query_log "
        "WHERE type IN ('ExceptionBeforeStart','ExceptionWhileProcessing') "
        "ORDER BY event_time DESC LIMIT 20",
    )
    results["recent_errors"] = error_rows
    if err: errors["recent_errors"] = err

    disk_rows, _ = _safe_query(
        conn,
        "SELECT name, path, "
        "toUInt64(free_space) AS free_space, "
        "toUInt64(total_space) AS total_space, "
        "round(100*(1 - free_space/total_space), 1) AS used_pct "
        "FROM system.disks",
    )
    disk_usage = {}
    if disk_rows:
        d     = disk_rows[0]
        total = int(d.get("total_space") or 0)
        free  = int(d.get("free_space") or 0)
        used  = total - free
        disk_usage = {
            "name": d.get("name", "default"), "path": d.get("path", ""),
            "total_space": total, "free_space": free, "used_space": used,
            "used_pct": float(d.get("used_pct") or 0),
            "total_human": _fmt_bytes(total), "free_human": _fmt_bytes(free),
            "used_human": _fmt_bytes(used),
        }

    merges_rows, _ = _safe_query(
        conn,
        "SELECT database, \"table\", elapsed, progress, num_parts, "
        "result_part_name, rows_read, bytes_read_uncompressed "
        "FROM system.merges ORDER BY elapsed DESC",
    )
    replicas_rows, _ = _safe_query(
        conn,
        "SELECT database, \"table\", is_leader, is_readonly, "
        "absolute_delay, queue_size, inserts_in_queue, merges_in_queue, "
        "log_max_index, log_pointer, last_queue_update, last_queue_exception "
        "FROM system.replicas LIMIT 50",
    )
    settings_rows, _ = _safe_query(
        conn,
        "SELECT name, value, changed, description, readonly, type "
        "FROM system.settings WHERE changed = 1 LIMIT 50",
    )
    top_db_rows, _ = _safe_query(
        conn,
        "SELECT database, "
        "sum(toUInt64(total_bytes)) AS total_bytes, "
        "count() AS table_count, "
        "sum(toUInt64(total_rows)) AS total_rows "
        "FROM system.tables GROUP BY database ORDER BY total_bytes DESC",
    )

    memory_tracking  = _metric_value(async_metrics_rows, "MemoryTracking")
    mem_total_bytes  = _metric_value(async_metrics_rows, "OSMemoryTotal")
    mem_resident     = _metric_value(async_metrics_rows, "MemoryResident")
    parts_count      = _metric_value(async_metrics_rows, "TotalPartsOfMergeTreeTables")
    max_part_count   = _metric_value(async_metrics_rows, "MaxPartCountForPartition")

    memory_pct = 0.0
    if mem_total_bytes > 0 and mem_resident > 0:
        memory_pct = round((mem_resident / mem_total_bytes) * 100, 1)
    elif memory_tracking > 0 and mem_total_bytes > 0:
        memory_pct = round((memory_tracking / mem_total_bytes) * 100, 1)

    query_rate     = _metric_value(metrics_rows, "Query")
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
        "alter_count": 0, "create_count": 0, "drop_count": 0,
        "failed_count": int(_metric_value(metrics_rows, "FailedQuery")),
        "total_count": 0,
    }

    return {
        "status": "success",
        "connection": {"id": conn.id, "name": conn.connection_name, "host": conn.host,
                       "port": conn.port, "database": conn.database_name},
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


def get_queries(conn_id: int, db: Session) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "ch_queries", db)
    if cached is not None:
        return cached

    conn    = _get_connection_or_404(conn_id, db)
    queries, _src, error = _query(
        conn,
        "SELECT query_id, user, elapsed, read_rows, read_bytes, result_rows, "
        "memory_usage, LEFT(query, 400) AS query, is_initial_query, current_database "
        "FROM system.processes ORDER BY elapsed DESC",
    )
    metrics_rows, _ = _safe_query(conn, "SELECT metric, value FROM system.metrics")
    return {
        "status": "success" if not error else "error",
        "queries": queries,
        "total": len(queries),
        "stats": {
            "queries_per_second": round(_metric_value(metrics_rows, "Query"), 2),
            "failed_queries":     int(_metric_value(metrics_rows, "FailedQuery")),
            "select_queries":     int(_metric_value(metrics_rows, "SelectQuery")),
            "insert_queries":     int(_metric_value(metrics_rows, "InsertQuery")),
        },
        "error": error,
    }


def get_query_log(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    logs, _src, error = _query(
        conn,
        "SELECT query_id, event_time, user, query_kind, "
        "query_duration_ms AS elapsed_ms, read_rows, read_bytes, result_rows, "
        "memory_usage, LEFT(exception, 300) AS exception, is_initial_query, "
        "type, LEFT(query, 300) AS query "
        "FROM system.query_log "
        "WHERE type IN ('QueryFinish','ExceptionBeforeStart','ExceptionWhileProcessing') "
        "  AND query NOT LIKE '%system.query_log%' "
        "ORDER BY event_time DESC LIMIT 100",
    )
    return {"status": "success" if not error else "error", "logs": logs, "total": len(logs), "error": error}


def get_slow_queries(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    queries, _src, error = _query(
        conn,
        "SELECT query_id, event_time, user, query_duration_ms, read_rows, read_bytes, "
        "result_rows, memory_usage, LEFT(query, 500) AS query, type, databases, tables, "
        "LEFT(exception, 300) AS exception "
        "FROM system.query_log "
        "WHERE type IN ('QueryFinish','ExceptionWhileProcessing') "
        "  AND query_duration_ms > 500 "
        "  AND event_time >= now() - INTERVAL 24 HOUR "
        "  AND query NOT LIKE '%system.query_log%' "
        "ORDER BY query_duration_ms DESC LIMIT 100",
    )
    return {
        "status": "success" if not error else "error",
        "queries": queries, "source": "system.query_log",
        "total": len(queries), "threshold_ms": 500, "window_hours": 24, "error": error,
    }


def get_tables(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    tables_rows, err1 = _safe_query(
        conn,
        "SELECT t.database, t.name, t.engine, "
        "toUInt64(t.total_rows) AS rows, toUInt64(t.total_bytes) AS bytes, "
        "formatReadableSize(t.total_bytes) AS size_pretty, "
        "t.metadata_modification_time AS last_modified "
        "FROM system.tables t "
        "WHERE t.database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY t.total_bytes DESC LIMIT 500",
    )
    parts_rows, err2 = _safe_query(
        conn,
        "SELECT database, \"table\", count() AS parts_count, "
        "countDistinct(partition) AS partitions_count, "
        "sum(toUInt64(data_compressed_bytes)) AS compressed_bytes, "
        "sum(toUInt64(data_uncompressed_bytes)) AS uncompressed_bytes "
        "FROM system.parts WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\"",
    )
    parts_map = {f"{p.get('database','')}.{p.get('table','')}": p for p in parts_rows}
    for t in tables_rows:
        key   = f"{t.get('database','')}.{t.get('name','')}"
        pm    = parts_map.get(key, {})
        comp  = int(pm.get("compressed_bytes") or 0)
        uncomp= int(pm.get("uncompressed_bytes") or 0)
        t["parts_count"]          = int(pm.get("parts_count") or 0)
        t["partitions_count"]     = int(pm.get("partitions_count") or 0)
        t["compressed_bytes"]     = comp
        t["uncompressed_bytes"]   = uncomp
        t["compression_ratio"]    = round(uncomp / comp, 2) if comp > 0 else None
        t["compression_ratio_pct"]= round((1 - comp / uncomp) * 100, 1) if uncomp > 0 else 0

    errors = {}
    if err1: errors["tables"] = err1
    if err2: errors["parts"]  = err2
    return {"status": "success" if not errors else "partial",
            "tables": tables_rows, "total": len(tables_rows),
            "errors": errors if errors else None}


def get_partitions(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    partitions, _src, error = _query(
        conn,
        "SELECT database, \"table\", partition, partition_id, active, "
        "count() AS part_count, sum(toUInt64(rows)) AS rows, "
        "sum(toUInt64(bytes_on_disk)) AS bytes, sum(toUInt64(marks)) AS marks, "
        "formatReadableSize(sum(toUInt64(bytes_on_disk))) AS size_pretty "
        "FROM system.parts "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\", partition, partition_id, active "
        "ORDER BY bytes DESC LIMIT 500",
    )
    return {"status": "success" if not error else "error",
            "partitions": partitions, "total": len(partitions), "error": error}


def get_merges(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    merges, _src, error = _query(
        conn,
        "SELECT database, \"table\", elapsed, progress, num_parts, "
        "source_part_names, source_parts_size, result_part_name, "
        "rows_read, rows_written, bytes_read_uncompressed, "
        "bytes_written_uncompressed, memory_usage "
        "FROM system.merges ORDER BY elapsed DESC",
    )
    merge_rate_rows, _ = _safe_query(conn, "SELECT value FROM system.events WHERE event = 'MergedRows'")
    merge_rate = merge_rate_rows[0].get("value", 0) if merge_rate_rows else 0
    return {"status": "success" if not error else "error",
            "merges": merges, "total": len(merges),
            "merge_rate_total_rows": int(merge_rate), "error": error}


def get_replicas(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    replicas, _src, error = _query(
        conn,
        "SELECT database, \"table\", zookeeper_path, is_leader, can_become_leader, "
        "is_readonly, is_session_expired, future_parts, parts_to_check, "
        "zookeeper_name, zookeeper_session_expired, queue_size, inserts_in_queue, "
        "merges_in_queue, part_mutations_in_queue, queue_oldest_time, inserts_oldest_time, "
        "merges_oldest_time, log_max_index, log_pointer, last_queue_update, absolute_delay, "
        "total_replicas, active_replicas, last_queue_exception "
        "FROM system.replicas ORDER BY absolute_delay DESC, queue_size DESC LIMIT 100",
    )
    total      = len(replicas)
    leaders    = sum(1 for r in replicas if r.get("is_leader"))
    readonly   = sum(1 for r in replicas if r.get("is_readonly"))
    with_delay = sum(1 for r in replicas if int(r.get("absolute_delay") or 0) > 0)
    with_errors= sum(1 for r in replicas if r.get("last_queue_exception"))
    total_queue= sum(int(r.get("queue_size") or 0) for r in replicas)
    return {
        "status": "success" if not error else "error",
        "replicas": replicas, "total": total,
        "summary": {"total_replicated_tables": total, "leaders": leaders, "readonly": readonly,
                    "with_delay": with_delay, "with_errors": with_errors, "total_queue_size": total_queue},
        "error": error,
    }


def get_clusters(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    clusters, _src, error = _query(
        conn,
        "SELECT cluster, shard_num, shard_weight, replica_num, host_name, host_address, "
        "port, is_local, user, default_database, errors_count, slowdowns_count, "
        "estimated_recovery_time "
        "FROM system.clusters ORDER BY cluster, shard_num, replica_num",
    )
    cluster_map: dict = {}
    for row in clusters:
        cname = row.get("cluster", "default")
        if cname not in cluster_map:
            cluster_map[cname] = {"name": cname, "shards": 0, "replicas": 0, "hosts": [], "errors": 0}
        cluster_map[cname]["hosts"].append(row)
        cluster_map[cname]["replicas"] += 1
        cluster_map[cname]["errors"]   += int(row.get("errors_count") or 0)
        shard = int(row.get("shard_num") or 0)
        if shard > cluster_map[cname]["shards"]:
            cluster_map[cname]["shards"] = shard
    return {
        "status": "success" if not error else "error",
        "clusters": clusters, "cluster_summary": list(cluster_map.values()),
        "total_hosts": len(clusters), "error": error,
    }


def get_databases(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    dbs_rows, err1 = _safe_query(
        conn, "SELECT name, engine, data_path, metadata_path, uuid FROM system.databases ORDER BY name"
    )
    sizes_rows, err2 = _safe_query(
        conn,
        "SELECT database, count() AS table_count, "
        "sum(toUInt64(total_rows)) AS total_rows, "
        "sum(toUInt64(total_bytes)) AS total_bytes, "
        "formatReadableSize(sum(toUInt64(total_bytes))) AS size_pretty "
        "FROM system.tables GROUP BY database ORDER BY total_bytes DESC",
    )
    sizes_map      = {r["database"]: r for r in sizes_rows}
    known_db_names = {d.get("name", "") for d in dbs_rows}

    for db_name, sm in sizes_map.items():
        if db_name and db_name not in known_db_names:
            dbs_rows.append({"name": db_name, "engine": "—", "data_path": "",
                             "metadata_path": "", "uuid": ""})
            known_db_names.add(db_name)

    for d in dbs_rows:
        nm = d.get("name", "")
        sm = sizes_map.get(nm, {})
        d["table_count"] = int(sm.get("table_count") or 0)
        d["total_rows"]  = int(sm.get("total_rows")   or 0)
        d["total_bytes"] = int(sm.get("total_bytes")  or 0)
        d["size_pretty"] = sm.get("size_pretty", "0 B")

    dbs_rows.sort(key=lambda d: (-d["total_bytes"], d.get("name", "")))

    errors = {}
    if err1: errors["databases"] = err1
    if err2: errors["sizes"]     = err2
    return {"status": "success" if not errors else "partial",
            "databases": dbs_rows, "total": len(dbs_rows),
            "errors": errors if errors else None}


def get_settings(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    changed_rows, _ = _safe_query(
        conn,
        "SELECT name, value, description, readonly, type, changed "
        "FROM system.settings WHERE changed = 1 ORDER BY name",
    )
    key_rows, _ = _safe_query(
        conn,
        "SELECT name, value, description, readonly, type, changed "
        "FROM system.settings "
        "WHERE name IN ("
        "  'max_memory_usage','max_threads','max_query_size',"
        "  'connect_timeout','receive_timeout','send_timeout',"
        "  'max_result_rows','max_execution_time','max_rows_to_read',"
        "  'allow_experimental_query_cache','enable_http_compression'"
        ") ORDER BY name",
    )
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


def get_system_metrics(conn_id: int, db: Session) -> dict:
    conn = _get_connection_or_404(conn_id, db)
    metrics_rows, err1 = _safe_query(conn, "SELECT metric, value, description FROM system.metrics")
    async_rows,   err2 = _safe_query(
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
        ")",
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
        ")",
    )

    errors = {}
    if err1: errors["metrics"]       = err1
    if err2: errors["async_metrics"] = err2
    if err3: errors["events"]        = err3

    def _val(rows, key):
        for r in rows:
            k = r.get("metric") or r.get("event")
            if k == key:
                try:    return float(r.get("value", 0))
                except: return 0
        return 0

    summary = {
        "memory_resident_bytes":      int(_val(async_rows, "MemoryResident")),
        "memory_total_bytes":         int(_val(async_rows, "OSMemoryTotal")),
        "memory_pct":                 round(
            (_val(async_rows, "MemoryResident") / _val(async_rows, "OSMemoryTotal") * 100)
            if _val(async_rows, "OSMemoryTotal") > 0 else 0, 1),
        "total_queries":              int(_val(events_rows, "Query")),
        "select_queries":             int(_val(events_rows, "SelectQuery")),
        "insert_queries":             int(_val(events_rows, "InsertQuery")),
        "failed_queries":             int(_val(events_rows, "FailedQuery")),
        "merged_rows":                int(_val(events_rows, "MergedRows")),
        "active_merges":              int(_val(metrics_rows, "BackgroundMergesAndMutationsPoolTask")),
        "query_threads":              int(_val(metrics_rows, "QueryThread")),
        "read_compressed_bytes":      int(_val(events_rows, "ReadCompressedBytes")),
        "write_compressed_bytes":     int(_val(events_rows, "WriteCompressedBytes")),
        "network_receive_bytes":      int(_val(events_rows, "NetworkReceiveBytes")),
        "network_send_bytes":         int(_val(events_rows, "NetworkSendBytes")),
        "total_parts":                int(_val(async_rows, "TotalPartsOfMergeTreeTables")),
        "max_part_count_for_partition": int(_val(async_rows, "MaxPartCountForPartition")),
        "replicas_max_queue":         int(_val(async_rows, "ReplicasMaxQueueSize")),
        "replicas_max_delay":         int(_val(async_rows, "ReplicasMaxAbsoluteDelay")),
    }
    return {
        "status": "success" if not errors else "partial",
        "metrics": metrics_rows, "async_metrics": async_rows, "events": events_rows,
        "summary": summary, "errors": errors if errors else None,
    }


def get_error_logs(conn_id: int, db: Session) -> dict:
    conn          = _get_connection_or_404(conn_id, db)
    combined_logs = []
    source_errors = {}

    query_log_rows, err = _safe_query(
        conn,
        "SELECT event_time, type, error_code_id, LEFT(exception, 500) AS message, "
        "LEFT(query, 300) AS query, user, query_duration_ms "
        "FROM system.query_log "
        "WHERE type IN ('ExceptionBeforeStart','ExceptionWhileProcessing') "
        "ORDER BY event_time DESC LIMIT 200",
    )
    if err: source_errors["query_log"] = err
    for row in query_log_rows:
        combined_logs.append({
            "logged": str(row.get("event_time", "")), "severity": "Error",
            "source": "query_log", "type": row.get("type", ""),
            "message": row.get("message", ""), "query": row.get("query", ""),
            "error_code": row.get("error_code_id", ""), "user": row.get("user", ""),
            "elapsed_ms": row.get("query_duration_ms", 0),
        })

    text_log_rows, err = _safe_query(
        conn,
        "SELECT event_time, level AS severity, source, LEFT(message, 500) AS message "
        "FROM system.text_log "
        "WHERE level IN ('Fatal','Critical','Error','Warning') "
        "ORDER BY event_time DESC LIMIT 200",
    )
    if err: source_errors["text_log"] = err
    for row in text_log_rows:
        combined_logs.append({
            "logged": str(row.get("event_time", "")), "severity": row.get("severity", "Error"),
            "source": row.get("source", "text_log"), "type": None,
            "message": row.get("message", ""), "query": None,
            "error_code": None, "user": None, "elapsed_ms": None,
        })

    combined_logs.sort(key=lambda x: x.get("logged", ""), reverse=True)
    combined_logs = combined_logs[:200]
    return {
        "status": "success" if not source_errors else "partial",
        "source": "system.query_log + system.text_log",
        "logs": combined_logs, "total": len(combined_logs),
        "source_errors": source_errors if source_errors else None,
    }


def get_table_analysis(conn_id: int, db: Session) -> dict:
    conn            = _get_connection_or_404(conn_id, db)
    analysis_errors = {}

    parts_rows, err = _safe_query(
        conn,
        "SELECT database, \"table\", partition, active, rows, bytes_on_disk, "
        "data_compressed_bytes, data_uncompressed_bytes, marks "
        "FROM system.parts WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "ORDER BY bytes_on_disk DESC LIMIT 200",
    )
    if err: analysis_errors["parts"] = err

    merges_rows, err = _safe_query(
        conn,
        "SELECT database, \"table\", elapsed, progress, num_parts, rows_read, rows_written "
        "FROM system.merges",
    )
    if err: analysis_errors["merges"] = err

    table_stats_rows, err = _safe_query(
        conn,
        "SELECT database, name AS table_name, engine, "
        "toUInt64(total_rows) AS total_rows, toUInt64(total_bytes) AS total_bytes, "
        "formatReadableSize(total_bytes) AS size_pretty "
        "FROM system.tables "
        "WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "  AND engine LIKE '%MergeTree%' "
        "ORDER BY total_bytes DESC LIMIT 100",
    )
    if err: analysis_errors["table_stats"] = err

    compression_rows, err = _safe_query(
        conn,
        "SELECT database, \"table\", "
        "sum(toUInt64(data_compressed_bytes)) AS compressed, "
        "sum(toUInt64(data_uncompressed_bytes)) AS uncompressed, "
        "count() AS parts_count "
        "FROM system.parts WHERE active = 1 "
        "  AND database NOT IN ('system','INFORMATION_SCHEMA','information_schema') "
        "GROUP BY database, \"table\" ORDER BY uncompressed DESC LIMIT 100",
    )
    if err: analysis_errors["compression"] = err

    for r in compression_rows:
        comp   = int(r.get("compressed") or 0)
        uncomp = int(r.get("uncompressed") or 0)
        r["compression_ratio"]  = round(uncomp / comp, 2) if comp > 0 else None
        r["savings_pct"]        = round((1 - comp / uncomp) * 100, 1) if uncomp > 0 else 0
        r["compressed_human"]   = _fmt_bytes(comp)
        r["uncompressed_human"] = _fmt_bytes(uncomp)

    total_bytes_on_disk  = sum(int(p.get("bytes_on_disk") or 0) for p in parts_rows)
    total_compressed     = sum(int(p.get("data_compressed_bytes") or 0) for p in parts_rows)
    total_uncompressed   = sum(int(p.get("data_uncompressed_bytes") or 0) for p in parts_rows)
    compression_ratio    = round(total_uncompressed / total_compressed, 2) if total_compressed > 0 else None

    table_part_counts: dict = {}
    for p in parts_rows:
        key = f"{p.get('database','')}.{p.get('table','')}"
        table_part_counts[key] = table_part_counts.get(key, 0) + 1

    summary = {
        "total_active_parts":       len(parts_rows),
        "total_bytes_on_disk":      total_bytes_on_disk,
        "total_bytes_on_disk_human":_fmt_bytes(total_bytes_on_disk),
        "total_compressed_bytes":   total_compressed,
        "total_uncompressed_bytes": total_uncompressed,
        "compression_ratio":        compression_ratio,
        "active_merges":            len(merges_rows),
        "tables_with_parts":        len(table_part_counts),
        "table_part_counts":        table_part_counts,
    }
    return {
        "status": "success" if not analysis_errors else "partial",
        "parts": parts_rows, "merges": merges_rows,
        "table_stats": table_stats_rows, "compression": compression_rows,
        "summary": summary, "errors": analysis_errors if analysis_errors else None,
    }
