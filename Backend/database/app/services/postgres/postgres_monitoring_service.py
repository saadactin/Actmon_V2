"""
PostgreSQL Monitoring Service — all business logic for monitoring endpoints.
Route file: app/routes/postgres/postgres_monitoring_routes.py
"""

import csv, io, json, os, re
from typing import Optional, List, Any

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster


# ═════════════════════════════════════════════════════════════════════════════
#  Shared helpers
# ═════════════════════════════════════════════════════════════════════════════

def _pg_engine(conn):
    from app.services.common import db_proxy_service
    pw = quote_plus(conn.password or "")
    return db_proxy_service.engine_for(conn, lambda: create_engine(
        f"postgresql+psycopg2://{conn.username}:{pw}@{conn.host}:{conn.port}/{conn.database_name or 'postgres'}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5},
    ))


def _pg_engine_db(conn, dbname: str):
    from app.services.common import db_proxy_service
    pw = quote_plus(conn.password or "")
    def _direct():
        return create_engine(
            f"postgresql+psycopg2://{conn.username}:{pw}@{conn.host}:{conn.port}/{dbname}",
            pool_size=1, max_overflow=0, pool_pre_ping=True,
            connect_args={"connect_timeout": 5},
        )
    # Route per-database queries through the agent too (connect to THIS dbname locally).
    return db_proxy_service.engine_for(db_proxy_service.conn_view(conn, dbname), _direct)


def _rows(engine, sql, params=None):
    with engine.connect() as c:
        r = c.execute(text(sql), params or {})
        return [dict(row) for row in r.mappings().all()]


def _pgss_engine(conn):
    """Return (engine, dbname) for a database where the pg_stat_statements VIEW is readable.
    The view returns cluster-wide stats, so any DB that has the extension works. Tries the
    connection's DB, then 'postgres', then 'template1'. Returns (None, None) if unavailable."""
    seen = set()
    for dbn in [conn.database_name, "postgres", "template1"]:
        if not dbn or dbn in seen:
            continue
        seen.add(dbn)
        try:
            e = _pg_engine_db(conn, dbn)
            with e.connect() as c:
                c.execute(text("SELECT 1 FROM pg_stat_statements LIMIT 1"))
            return e, dbn
        except Exception:
            continue
    return None, None


def _val(engine, sql):
    with engine.connect() as c:
        row = c.execute(text(sql)).fetchone()
        return row[0] if row else None


def _safe_int(v):
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0


def _pg_conn(conn_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    return conn, _pg_engine(conn)


# ═════════════════════════════════════════════════════════════════════════════
#  Module-level constants (used by tables_detail)
# ═════════════════════════════════════════════════════════════════════════════

_TABLE_SQL = (
    "SELECT "
    "  s.schemaname, s.relname, "
    "  s.n_live_tup, s.n_dead_tup, s.n_mod_since_analyze, "
    "  s.seq_scan, s.seq_tup_read, "
    "  s.idx_scan, s.idx_tup_fetch, "
    "  s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_tup_hot_upd, "
    "  s.last_vacuum, s.last_autovacuum, "
    "  s.last_analyze, s.last_autoanalyze, "
    "  s.vacuum_count, s.autovacuum_count, "
    "  s.analyze_count, s.autoanalyze_count, "
    "  io.heap_blks_read, io.heap_blks_hit, "
    "  io.idx_blks_read, io.idx_blks_hit, "
    "  io.toast_blks_read, io.toast_blks_hit, "
    "  pg_relation_size(s.relid)            AS heap_bytes, "
    "  pg_indexes_size(s.relid)              AS indexes_bytes, "
    "  pg_total_relation_size(s.relid)       AS total_bytes, "
    "  pg_size_pretty(pg_relation_size(s.relid))          AS heap_size, "
    "  pg_size_pretty(pg_indexes_size(s.relid))           AS indexes_size, "
    "  pg_size_pretty(pg_total_relation_size(s.relid))    AS total_size "
    "FROM pg_stat_user_tables s "
    "LEFT JOIN pg_statio_user_tables io ON s.relid = io.relid "
    "ORDER BY pg_total_relation_size(s.relid) DESC NULLS LAST "
    "LIMIT 300"
)

_IDX_SQL = (
    "SELECT s.schemaname, "
    "  s.relname       AS tablename, "
    "  s.indexrelname  AS indexname, "
    "  s.idx_scan, s.idx_tup_read, s.idx_tup_fetch, "
    "  pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size, "
    "  pg_relation_size(s.indexrelid)                 AS index_bytes, "
    "  ix.indisunique  AS is_unique, "
    "  ix.indisprimary AS is_primary, "
    "  pg_get_indexdef(s.indexrelid)                  AS index_def "
    "FROM pg_stat_user_indexes s "
    "JOIN pg_index ix ON ix.indexrelid = s.indexrelid "
    "ORDER BY s.idx_scan ASC"
)

_PARAM_GROUPS: dict = {
    "Memory": [
        "shared_buffers", "effective_cache_size", "work_mem", "maintenance_work_mem",
        "wal_buffers", "temp_buffers", "max_stack_depth", "huge_pages", "huge_page_size",
        "shared_memory_type", "dynamic_shared_memory_type", "autovacuum_work_mem",
    ],
    "WAL": [
        "wal_level", "fsync", "synchronous_commit", "wal_sync_method", "full_page_writes",
        "wal_log_hints", "wal_compression", "wal_init_zero", "wal_recycle",
        "wal_writer_delay", "wal_writer_flush_after",
        "commit_delay", "commit_siblings",
        "max_wal_size", "min_wal_size", "wal_segment_size",
        "track_wal_io_timing", "wal_skip_threshold",
    ],
    "Checkpoint": [
        "checkpoint_timeout", "checkpoint_completion_target", "checkpoint_warning",
        "checkpoint_flush_after", "max_wal_size", "min_wal_size",
    ],
    "Background Writer": [
        "bgwriter_delay", "bgwriter_lru_maxpages", "bgwriter_lru_multiplier",
        "bgwriter_flush_after",
    ],
    "Connections": [
        "max_connections", "superuser_reserved_connections", "listen_addresses", "port",
        "unix_socket_directories", "unix_socket_group", "unix_socket_permissions",
        "tcp_keepalives_idle", "tcp_keepalives_interval", "tcp_keepalives_count",
        "tcp_user_timeout", "authentication_timeout", "password_encryption",
    ],
    "Query Planner": [
        "enable_bitmapscan", "enable_gathermerge", "enable_hashagg", "enable_hashjoin",
        "enable_indexonlyscan", "enable_indexscan", "enable_material", "enable_mergejoin",
        "enable_nestloop", "enable_parallel_append", "enable_parallel_hash",
        "enable_partition_pruning", "enable_partitionwise_aggregate",
        "enable_partitionwise_join", "enable_seqscan", "enable_sort", "enable_tidscan",
        "seq_page_cost", "random_page_cost", "cpu_tuple_cost", "cpu_index_tuple_cost",
        "cpu_operator_cost", "parallel_setup_cost", "parallel_tuple_cost",
        "effective_cache_size", "jit_above_cost", "jit_inline_above_cost",
        "jit_optimize_above_cost", "default_statistics_target", "constraint_exclusion",
        "cursor_tuple_fraction", "from_collapse_limit", "geqo",
        "geqo_threshold", "join_collapse_limit",
    ],
    "Parallel Query": [
        "max_parallel_workers_per_gather", "max_parallel_workers",
        "max_parallel_maintenance_workers", "parallel_leader_participation",
        "min_parallel_table_scan_size", "min_parallel_index_scan_size",
        "force_parallel_mode",
    ],
    "Logging": [
        "log_destination", "logging_collector", "log_directory", "log_filename",
        "log_file_mode", "log_rotation_age", "log_rotation_size",
        "log_truncate_on_rotation", "log_min_messages", "log_min_error_statement",
        "log_min_duration_statement", "log_min_duration_sample",
        "log_statement_sample_rate", "log_transaction_sample_rate",
        "log_checkpoints", "log_connections", "log_disconnections", "log_duration",
        "log_error_verbosity", "log_hostname", "log_line_prefix",
        "log_lock_waits", "log_parameter_max_length",
        "log_parameter_max_length_on_error", "log_recovery_conflict_waits",
        "log_replication_commands", "log_temp_files", "log_timezone",
        "log_autovacuum_min_duration", "log_statement",
    ],
    "Security": [
        "password_encryption", "db_user_namespace", "krb_caseins_users",
        "authentication_timeout", "row_security",
        "ssl", "ssl_cert_file", "ssl_key_file", "ssl_ca_file",
    ],
    "SSL": [
        "ssl", "ssl_ca_file", "ssl_cert_file", "ssl_key_file", "ssl_crl_file",
        "ssl_ciphers", "ssl_prefer_server_ciphers",
        "ssl_min_protocol_version", "ssl_max_protocol_version",
        "ssl_dh_params_file",
    ],
    "Replication": [
        "wal_level", "max_wal_senders", "max_replication_slots", "wal_keep_size",
        "max_slot_wal_keep_size", "wal_sender_timeout", "wal_receiver_timeout",
        "wal_receiver_status_interval", "hot_standby", "max_standby_archive_delay",
        "max_standby_streaming_delay", "hot_standby_feedback",
        "track_commit_timestamp", "synchronous_standby_names",
        "vacuum_defer_cleanup_age",
    ],
    "Autovacuum": [
        "autovacuum", "autovacuum_max_workers", "autovacuum_naptime",
        "autovacuum_vacuum_threshold", "autovacuum_vacuum_insert_threshold",
        "autovacuum_analyze_threshold", "autovacuum_vacuum_scale_factor",
        "autovacuum_vacuum_insert_scale_factor", "autovacuum_analyze_scale_factor",
        "autovacuum_freeze_max_age", "autovacuum_multixact_freeze_max_age",
        "autovacuum_vacuum_cost_delay", "autovacuum_vacuum_cost_limit",
        "autovacuum_work_mem",
    ],
    "Archiving": [
        "archive_mode", "archive_command", "archive_timeout",
        "archive_cleanup_command", "restore_command", "recovery_end_command",
    ],
    "Resource Usage": [
        "max_files_per_process", "max_worker_processes", "max_prepared_transactions",
        "vacuum_cost_delay", "vacuum_cost_limit", "vacuum_cost_page_hit",
        "vacuum_cost_page_miss", "vacuum_cost_page_dirty",
        "effective_io_concurrency", "maintenance_io_concurrency",
    ],
    "Lock Management": [
        "deadlock_timeout", "max_locks_per_transaction",
        "max_pred_locks_per_transaction", "max_pred_locks_per_relation",
        "max_pred_locks_per_page", "lock_timeout", "statement_timeout",
        "idle_in_transaction_session_timeout",
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
#  Helper functions used by multiple svc_ functions
# ═════════════════════════════════════════════════════════════════════════════

def _process_table_rows(raw_rows, dbname: str) -> list:
    tables = []
    for r in raw_rows:
        t = dict(r)
        t["database"] = dbname
        live  = int(t.get("n_live_tup") or 0)
        dead  = int(t.get("n_dead_tup") or 0)
        seq   = int(t.get("seq_scan") or 0)
        idx   = int(t.get("idx_scan") or 0)
        hread = int(t.get("heap_blks_read") or 0)
        hhit  = int(t.get("heap_blks_hit") or 0)
        iread = int(t.get("idx_blks_read") or 0)
        ihit  = int(t.get("idx_blks_hit") or 0)

        t["n_live_tup"]          = live
        t["n_dead_tup"]          = dead
        t["seq_scan"]            = seq
        t["idx_scan"]            = idx
        t["n_tup_ins"]           = int(t.get("n_tup_ins") or 0)
        t["n_tup_upd"]           = int(t.get("n_tup_upd") or 0)
        t["n_tup_del"]           = int(t.get("n_tup_del") or 0)
        t["n_tup_hot_upd"]       = int(t.get("n_tup_hot_upd") or 0)
        t["n_mod_since_analyze"] = int(t.get("n_mod_since_analyze") or 0)
        t["vacuum_count"]        = int(t.get("vacuum_count") or 0)
        t["autovacuum_count"]    = int(t.get("autovacuum_count") or 0)
        t["analyze_count"]       = int(t.get("analyze_count") or 0)
        t["autoanalyze_count"]   = int(t.get("autoanalyze_count") or 0)
        t["heap_bytes"]          = int(t.get("heap_bytes") or 0)
        t["indexes_bytes"]       = int(t.get("indexes_bytes") or 0)
        t["total_bytes"]         = int(t.get("total_bytes") or 0)
        t["heap_blks_read"]      = hread
        t["heap_blks_hit"]       = hhit
        t["idx_blks_read"]       = iread
        t["idx_blks_hit"]        = ihit
        t["toast_blks_read"]     = int(t.get("toast_blks_read") or 0)
        t["toast_blks_hit"]      = int(t.get("toast_blks_hit") or 0)
        t["last_vacuum"]         = str(t.get("last_vacuum") or "")
        t["last_autovacuum"]     = str(t.get("last_autovacuum") or "")
        t["last_analyze"]        = str(t.get("last_analyze") or "")
        t["last_autoanalyze"]    = str(t.get("last_autoanalyze") or "")

        total_blks = hread + hhit
        t["heap_cache_pct"] = round(hhit / max(total_blks, 1) * 100, 1)
        total_scan = seq + idx
        t["idx_scan_pct"]   = round(idx / max(total_scan, 1) * 100, 1)
        dead_ratio          = dead / max(live + dead, 1) * 100
        t["dead_pct"]       = round(dead_ratio, 1)
        t["needs_vacuum"]   = dead_ratio > 20 or (t["n_mod_since_analyze"] > max(live * 0.1, 1000))
        t["needs_analyze"]  = t["n_mod_since_analyze"] > max(live * 0.1, 1000)
        tables.append(t)
    return tables


def _flatten_plan(plan, depth=0):
    nodes = []
    nodes.append({
        "depth":               depth,
        "node_type":           plan.get("Node Type", ""),
        "relation":            plan.get("Relation Name"),
        "alias":               plan.get("Alias"),
        "startup_cost":        plan.get("Startup Cost"),
        "total_cost":          plan.get("Total Cost"),
        "plan_rows":           plan.get("Plan Rows"),
        "actual_startup_time": plan.get("Actual Startup Time"),
        "actual_total_time":   plan.get("Actual Total Time"),
        "actual_rows":         plan.get("Actual Rows"),
        "actual_loops":        plan.get("Actual Loops"),
        "shared_hit_blocks":   plan.get("Shared Hit Blocks", 0),
        "shared_read_blocks":  plan.get("Shared Read Blocks", 0),
        "filter":              plan.get("Filter"),
        "join_type":           plan.get("Join Type"),
        "sort_key":            plan.get("Sort Key"),
        "sort_method":         plan.get("Sort Method"),
    })
    for sub in plan.get("Plans", []):
        nodes.extend(_flatten_plan(sub, depth + 1))
    return nodes


def _pg_explain_hints(nodes, planning_time, execution_time):
    hints = []
    seen_disk = False
    for node in nodes:
        nt         = node.get("node_type", "")
        rel        = node.get("relation") or node.get("alias") or "table"
        actual_rows = node.get("actual_rows") or 0
        actual_time = node.get("actual_total_time") or 0
        disk_read   = node.get("shared_read_blocks") or 0

        if "Seq Scan" in nt:
            hints.append({
                "level": "critical" if actual_rows > 10000 else "warning",
                "type":  "SEQ_SCAN",
                "title": f"Sequential scan on '{rel}'",
                "text":  f"Full table scan reading ~{actual_rows:,} rows — no index used.",
                "fix":   f"Add an index on the WHERE/JOIN columns of '{rel}'.",
            })
        if "Sort" in nt and actual_time > 50:
            hints.append({
                "level": "warning",
                "type":  "SORT",
                "title": f"Expensive sort ({actual_time:.0f} ms)",
                "text":  f"Sort method: {node.get('sort_method','unknown')}. Sort key: {node.get('sort_key','?')}.",
                "fix":   "Add an index that matches the ORDER BY / GROUP BY columns.",
            })
        if disk_read > 0 and not seen_disk:
            seen_disk = True
            hints.append({
                "level": "warning",
                "type":  "DISK_READ",
                "title": f"Disk I/O detected ({disk_read:,} blocks from disk)",
                "text":  "Data was read from disk rather than memory cache (shared_buffers).",
                "fix":   "Increase shared_buffers, or check if the working set fits in memory.",
            })
        if "Hash Join" in nt and actual_time > 500:
            hints.append({
                "level": "warning",
                "type":  "HASH_JOIN",
                "title": f"Slow hash join ({actual_time:.0f} ms)",
                "text":  "Hash join is building a large hash table.",
                "fix":   "Ensure join columns are indexed on both sides.",
            })
    return hints


# ═════════════════════════════════════════════════════════════════════════════
#  Pydantic models (used by AI / EXPLAIN endpoints — defined here so route
#  file can import them from one place)
# ═════════════════════════════════════════════════════════════════════════════

class PgSlowQueryGroqRequest(BaseModel):
    sql_text:           str
    user_name:          Optional[str] = None
    calls:              int   = 0
    mean_exec_time_ms:  float = 0.0
    max_exec_time_ms:   float = 0.0
    total_exec_time_ms: float = 0.0
    rows:               int   = 0
    shared_blks_hit:    int   = 0
    shared_blks_read:   int   = 0
    cache_hit_pct:      float = 100.0
    explain_rows:       Optional[List[Any]] = []


class PgExplainRequest(BaseModel):
    sql_text: str
    database: Optional[str] = None


class ErrorAnalysisRequest(BaseModel):
    message:     str
    severity:    str = ""
    sql_state:   str = ""
    detail:      str = ""
    hint:        str = ""
    query:       str = ""
    context:     str = ""
    location:    str = ""
    database:    str = ""
    user:        str = ""
    application: str = ""
    pid:         str = ""


# ═════════════════════════════════════════════════════════════════════════════
#  1. Monitoring Dashboard
# ═════════════════════════════════════════════════════════════════════════════

def svc_monitoring_dashboard(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_monitoring_dashboard", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    connection_meta = {
        "id":       conn_rec.id,
        "name":     conn_rec.connection_name,
        "host":     conn_rec.host,
        "port":     conn_rec.port,
        "database": conn_rec.database_name,
    }

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "connection": connection_meta, "error": str(e)}

    version = "unknown"
    try:
        version = _val(engine, "SELECT version()")
    except Exception:
        pass

    # `SELECT version()` never fails on a reachable PostgreSQL — an empty/unknown result
    # means the connection failed (agent timeout / unreachable). Return error so the empty
    # result is NOT cached over good data (see _try_snapshot).
    if not version or version == "unknown":
        return {"status": "error", "connection": connection_meta,
                "error": "PostgreSQL unreachable (no version) — not caching empty result"}

    uptime_str = "unknown"
    try:
        uptime_raw = _val(
            engine,
            "SELECT date_trunc('second', current_timestamp - pg_postmaster_start_time()) "
            "AS uptime FROM pg_postmaster_start_time()"
        )
        uptime_str = str(uptime_raw) if uptime_raw is not None else "unknown"
    except Exception:
        pass

    connections_by_state = {}
    total_connections = 0
    try:
        rows = _rows(engine, "SELECT count(*) AS cnt, state FROM pg_stat_activity GROUP BY state")
        for row in rows:
            state_key = row.get("state") or "unknown"
            cnt = int(row.get("cnt") or 0)
            connections_by_state[state_key] = cnt
            total_connections += cnt
    except Exception:
        pass

    max_connections = 100
    try:
        max_raw = _val(engine, "SHOW max_connections")
        max_connections = int(max_raw) if max_raw is not None else 100
    except Exception:
        pass

    connection_pct = round((total_connections / max_connections) * 100, 2) if max_connections > 0 else 0.0

    cache_hit_pct = 0.0
    blks_hit = 0
    blks_read = 0
    try:
        row = _rows(engine, "SELECT sum(blks_hit) AS hit, sum(blks_read) AS rd FROM pg_stat_database")
        if row:
            blks_hit  = int(row[0].get("hit") or 0)
            blks_read = int(row[0].get("rd") or 0)
            total_blks = blks_hit + blks_read
            cache_hit_pct = round((blks_hit / total_blks) * 100, 2) if total_blks > 0 else 0.0
    except Exception:
        pass

    commits = rollbacks = tup_returned = tup_fetched = 0
    try:
        row = _rows(
            engine,
            "SELECT sum(xact_commit) AS cmts, sum(xact_rollback) AS rbks, "
            "sum(tup_returned) AS tr, sum(tup_fetched) AS tf FROM pg_stat_database"
        )
        if row:
            commits      = int(row[0].get("cmts") or 0)
            rollbacks    = int(row[0].get("rbks") or 0)
            tup_returned = int(row[0].get("tr") or 0)
            tup_fetched  = int(row[0].get("tf") or 0)
    except Exception:
        pass

    databases = []
    try:
        databases = _rows(
            engine,
            "SELECT s.datname AS name, s.numbackends, "
            "pg_database_size(s.datname) AS size_bytes, "
            "s.xact_commit, s.xact_rollback, s.blks_read, s.blks_hit, "
            "s.tup_inserted AS n_tup_ins, s.tup_updated AS n_tup_upd, "
            "s.tup_deleted AS n_tup_del, "
            "pg_catalog.pg_get_userbyid(d.datdba) AS owner, "
            "pg_encoding_to_char(d.encoding) AS encoding "
            "FROM pg_stat_database s "
            "JOIN pg_database d ON s.datid = d.oid "
            "WHERE s.datname NOT IN ('template0','template1') "
            "ORDER BY size_bytes DESC"
        )
        databases = [dict(d) for d in databases]
        for d in databases:
            d["size_bytes"]    = int(d.get("size_bytes") or 0)
            d["size_mb"]       = round(d["size_bytes"] / (1024 * 1024), 2)
            d["xact_commit"]   = int(d.get("xact_commit") or 0)
            d["xact_rollback"] = int(d.get("xact_rollback") or 0)
            d["blks_read"]     = int(d.get("blks_read") or 0)
            d["blks_hit"]      = int(d.get("blks_hit") or 0)
    except Exception:
        databases = []

    total_databases = len(databases)

    process_list = []
    try:
        process_list = _rows(
            engine,
            "SELECT pid, usename, datname, state, "
            "EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec, "
            "left(query, 200) AS query "
            "FROM pg_stat_activity "
            "WHERE state != 'idle' "
            "AND query NOT LIKE '%pg_stat_activity%' "
            "ORDER BY duration_sec DESC NULLS LAST "
            "LIMIT 20"
        )
        process_list = [dict(p) for p in process_list]
        for p in process_list:
            p["duration_sec"] = int(p.get("duration_sec") or 0)
    except Exception:
        process_list = []

    long_running_queries = []
    try:
        long_running_queries = _rows(
            engine,
            "SELECT pid, usename, datname, state, "
            "EXTRACT(EPOCH FROM (now() - query_start))::int AS duration_sec, "
            "left(query, 200) AS query "
            "FROM pg_stat_activity "
            "WHERE state != 'idle' "
            "AND query NOT LIKE '%pg_stat_activity%' "
            "AND EXTRACT(EPOCH FROM (now() - query_start)) > 30 "
            "ORDER BY duration_sec DESC NULLS LAST "
            "LIMIT 20"
        )
        long_running_queries = [dict(q) for q in long_running_queries]
        for q in long_running_queries:
            q["duration_sec"] = int(q.get("duration_sec") or 0)
    except Exception:
        long_running_queries = []

    replication = []
    replication_state = "STANDALONE"
    try:
        replication = _rows(
            engine,
            "SELECT pid::text AS pid, usename, application_name, "
            "COALESCE(client_addr::text, '') AS client_addr, "
            "COALESCE(client_hostname, '') AS client_hostname, "
            "COALESCE(state, 'streaming') AS state, "
            "COALESCE(sent_lsn::text, '') AS sent_lsn, "
            "COALESCE(write_lsn::text, '') AS write_lsn, "
            "COALESCE(flush_lsn::text, '') AS flush_lsn, "
            "COALESCE(replay_lsn::text, '') AS replay_lsn, "
            "COALESCE(replay_lag::text, '0') AS replay_lag, "
            "COALESCE(write_lag::text, '0') AS write_lag, "
            "COALESCE(flush_lag::text, '0') AS flush_lag, "
            "sync_state "
            "FROM pg_stat_replication LIMIT 10"
        )
        replication = [dict(r) for r in replication]
        if replication:
            replication_state = "PRIMARY"
    except Exception:
        replication = []

    is_recovery = False
    try:
        is_recovery = bool(_val(engine, "SELECT pg_is_in_recovery()"))
        if is_recovery:
            replication_state = "REPLICA"
    except Exception:
        pass

    table_stats = []
    total_tables = 0
    try:
        table_stats = _rows(
            engine,
            "SELECT schemaname, relname, n_live_tup, n_dead_tup, seq_scan, idx_scan, "
            "last_vacuum, last_autovacuum, last_analyze, last_autoanalyze "
            "FROM pg_stat_user_tables "
            "ORDER BY n_live_tup DESC LIMIT 100"
        )
        table_stats = [dict(t) for t in table_stats]
        for t in table_stats:
            t["n_live_tup"]      = int(t.get("n_live_tup") or 0)
            t["n_dead_tup"]      = int(t.get("n_dead_tup") or 0)
            t["seq_scan"]        = int(t.get("seq_scan") or 0)
            t["idx_scan"]        = int(t.get("idx_scan") or 0)
            t["last_vacuum"]     = str(t.get("last_vacuum") or "")
            t["last_autovacuum"] = str(t.get("last_autovacuum") or "")
            t["last_analyze"]    = str(t.get("last_analyze") or "")
            t["last_autoanalyze"]= str(t.get("last_autoanalyze") or "")
        total_tables = len(table_stats)
    except Exception:
        table_stats = []

    # Cluster-wide table count — the connection DB (often "postgres") may hold no
    # user tables, so counting only the connected DB shows 0. Sum every user DB.
    try:
        with engine.connect() as _c:
            _dbs = [r[0] for r in _c.execute(text(
                "SELECT datname FROM pg_database WHERE datistemplate = false"
            )).fetchall()]
        _cluster_total = 0
        for _dn in _dbs:
            _e2 = None
            try:
                _e2 = _pg_engine_db(conn_rec, _dn)
                _cluster_total += int(_val(_e2, "SELECT count(*) FROM pg_stat_user_tables") or 0)
            except Exception:
                pass
            finally:
                if _e2 is not None:
                    _e2.dispose()
        if _cluster_total > total_tables:
            total_tables = _cluster_total
    except Exception:
        pass

    server_vars = {}
    memory = {
        "shared_buffers": "unknown",
        "effective_cache_size": "unknown",
        "work_mem": "unknown",
        "cache_hit_pct": cache_hit_pct,
    }
    try:
        for var in ("shared_buffers", "effective_cache_size", "work_mem",
                    "max_wal_size", "wal_level", "log_min_duration_statement",
                    "maintenance_work_mem", "checkpoint_completion_target", "data_directory"):
            try:
                val = _val(engine, f"SHOW {var}")
                server_vars[var] = val
                if var in ("shared_buffers", "effective_cache_size", "work_mem"):
                    memory[var] = val
            except Exception:
                server_vars[var] = "unknown"
    except Exception:
        pass

    bgwriter = {}
    checkpoints = {}
    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_bgwriter")
        if rows:
            bg = rows[0]
            bgwriter = {
                "buffers_clean":      int(bg.get("buffers_clean") or 0),
                "maxwritten_clean":   int(bg.get("maxwritten_clean") or 0),
                "buffers_backend":    int(bg.get("buffers_backend") or 0),
                "buffers_alloc":      int(bg.get("buffers_alloc") or 0),
                "stats_reset":        str(bg.get("stats_reset") or ""),
                "buffers_checkpoint": int(bg.get("buffers_checkpoint") or 0),
                "checkpoints_timed":  int(bg.get("checkpoints_timed") or 0),
                "checkpoints_req":    int(bg.get("checkpoints_req") or 0),
            }
    except Exception:
        pass

    try:
        cp_rows = _rows(engine, "SELECT * FROM pg_stat_checkpointer")
        if cp_rows:
            cp = cp_rows[0]
            checkpoints = {
                "checkpoints_timed":     int(cp.get("num_timed") or 0),
                "checkpoints_req":       int(cp.get("num_requested") or 0),
                "checkpoint_write_time": float(cp.get("write_time") or 0),
                "checkpoint_sync_time":  float(cp.get("sync_time") or 0),
                "buffers_written":       int(cp.get("buffers_written") or 0),
                "stats_reset":           str(cp.get("stats_reset") or ""),
            }
            bgwriter["buffers_checkpoint"] = checkpoints["buffers_written"]
    except Exception:
        if bgwriter:
            checkpoints = {
                "checkpoints_timed":     bgwriter.get("checkpoints_timed", 0),
                "checkpoints_req":       bgwriter.get("checkpoints_req", 0),
                "checkpoint_write_time": 0.0,
                "checkpoint_sync_time":  0.0,
                "buffers_written":       bgwriter.get("buffers_checkpoint", 0),
            }

    pg_stat_statements = []
    _pgss_eng, _ = _pgss_engine(conn_rec)
    try:
        pg_stat_statements = _rows(
            _pgss_eng or engine,
            "SELECT userid::regrole AS usename, dbid::text AS dbname, query, calls, "
            "total_exec_time, mean_exec_time, max_exec_time, min_exec_time, "
            "stddev_exec_time, rows, shared_blks_hit, shared_blks_read "
            "FROM pg_stat_statements "
            "WHERE query NOT LIKE '%pg_stat_statements%' "
            "ORDER BY mean_exec_time DESC LIMIT 50"
        )
        pg_stat_statements = [dict(s) for s in pg_stat_statements]
        for s in pg_stat_statements:
            s["usename"]         = str(s.get("usename") or "")
            s["calls"]           = int(s.get("calls") or 0)
            s["rows"]            = int(s.get("rows") or 0)
            s["total_exec_time"] = float(s.get("total_exec_time") or 0)
            s["mean_exec_time"]  = float(s.get("mean_exec_time") or 0)
            s["max_exec_time"]   = float(s.get("max_exec_time") or 0)
            s["min_exec_time"]   = float(s.get("min_exec_time") or 0)
            s["stddev_exec_time"]= float(s.get("stddev_exec_time") or 0)
            s["shared_blks_hit"] = int(s.get("shared_blks_hit") or 0)
            s["shared_blks_read"]= int(s.get("shared_blks_read") or 0)
    except Exception:
        pg_stat_statements = []

    pg_locks = []
    try:
        pg_locks = _rows(
            engine,
            "SELECT l.pid, l.locktype, c.relname AS relation_name, l.relation, "
            "l.mode, l.granted, a.datname AS database_name, "
            "EXTRACT(EPOCH FROM (now() - a.query_start))::int AS duration_sec, "
            "CASE WHEN a.query_start IS NOT NULL "
            "     THEN EXTRACT(EPOCH FROM (now() - a.query_start))::text || 's' "
            "     ELSE NULL END AS duration "
            "FROM pg_locks l "
            "LEFT JOIN pg_class c ON l.relation = c.oid "
            "LEFT JOIN pg_stat_activity a ON l.pid = a.pid "
            "WHERE NOT l.granted OR l.locktype = 'relation' "
            "LIMIT 50"
        )
        pg_locks = [dict(lk) for lk in pg_locks]
        for lk in pg_locks:
            lk["granted"]      = bool(lk.get("granted"))
            lk["duration_sec"] = int(lk.get("duration_sec") or 0)
    except Exception:
        pg_locks = []

    blocking_queries = []
    try:
        blocking_queries = _rows(
            engine,
            "SELECT blocked.pid AS blocked_pid, blocker.pid AS blocking_pid, "
            "blocked.query AS query, blocker.query AS blocking_query, "
            "bl.mode AS lock_mode "
            "FROM pg_stat_activity blocked "
            "JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted "
            "JOIN pg_locks grant_lock ON grant_lock.locktype = bl.locktype "
            "AND grant_lock.relation = bl.relation AND grant_lock.granted "
            "JOIN pg_stat_activity blocker ON blocker.pid = grant_lock.pid "
            "LIMIT 20"
        )
        blocking_queries = [dict(bq) for bq in blocking_queries]
    except Exception:
        blocking_queries = []

    replication_slots = []
    try:
        replication_slots = _rows(
            engine,
            "SELECT slot_name, plugin, slot_type, database, "
            "CAST(active AS TEXT) AS active, xmin, restart_lsn "
            "FROM pg_replication_slots"
        )
        replication_slots = [dict(s) for s in replication_slots]
        for s in replication_slots:
            s["active"] = str(s.get("active", "")).lower() == "true"
    except Exception:
        replication_slots = []

    tablespaces = []
    try:
        tablespaces = _rows(
            engine,
            "SELECT spcname AS name, pg_catalog.pg_get_userbyid(spcowner) AS owner, "
            "pg_tablespace_size(oid) AS size_bytes "
            "FROM pg_tablespace"
        )
        tablespaces = [dict(t) for t in tablespaces]
        for t in tablespaces:
            t["size_bytes"] = int(t.get("size_bytes") or 0)
            t["size_mb"]    = round(t["size_bytes"] / (1024 * 1024), 2)
    except Exception:
        tablespaces = []

    users_activity = []
    try:
        rows = _rows(
            engine,
            "SELECT usename, datname, "
            "count(*) AS total, "
            "count(*) FILTER (WHERE state='active') AS active, "
            "count(*) FILTER (WHERE state='idle') AS idle, "
            "count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_transaction, "
            "count(*) FILTER (WHERE wait_event_type='Lock') AS waiting, "
            "COALESCE(max(EXTRACT(EPOCH FROM (now()-query_start))::int), 0) AS max_duration "
            "FROM pg_stat_activity "
            "WHERE usename IS NOT NULL "
            "GROUP BY usename, datname ORDER BY total DESC"
        )
        users_activity = [dict(u) for u in rows]
        for u in users_activity:
            u["total"]               = int(u.get("total") or 0)
            u["active"]              = int(u.get("active") or 0)
            u["idle"]                = int(u.get("idle") or 0)
            u["idle_in_transaction"] = int(u.get("idle_in_transaction") or 0)
            u["waiting"]             = int(u.get("waiting") or 0)
            u["max_duration"]        = int(u.get("max_duration") or 0)
    except Exception:
        users_activity = []

    total_size_bytes = sum(d.get("size_bytes", 0) for d in databases)
    total_size_mb    = round(total_size_bytes / (1024 * 1024), 2)
    total_size       = f"{round(total_size_mb / 1024, 2)} GB" if total_size_mb > 1024 else f"{total_size_mb} MB"

    total_seq_scan = total_idx_scan = n_tup_ins = n_tup_upd = n_tup_del = 0
    try:
        rows = _rows(engine,
            "SELECT sum(seq_scan) AS total_seq_scan, sum(idx_scan) AS total_idx_scan "
            "FROM pg_stat_user_tables")
        if rows:
            total_seq_scan = int(rows[0].get("total_seq_scan") or 0)
            total_idx_scan = int(rows[0].get("total_idx_scan") or 0)
        rows2 = _rows(engine,
            "SELECT sum(n_tup_ins) AS ins, sum(n_tup_upd) AS upd, sum(n_tup_del) AS del "
            "FROM pg_stat_user_tables")
        if rows2:
            n_tup_ins = int(rows2[0].get("ins") or 0)
            n_tup_upd = int(rows2[0].get("upd") or 0)
            n_tup_del = int(rows2[0].get("del") or 0)
    except Exception:
        pass

    temp_files = temp_bytes = 0
    try:
        rows = _rows(engine, "SELECT sum(temp_files) AS tf, sum(temp_bytes) AS tb FROM pg_stat_database")
        if rows:
            temp_files = int(rows[0].get("tf") or 0)
            temp_bytes = int(rows[0].get("tb") or 0)
    except Exception:
        pass

    pg_postmaster_start_time = "unknown"
    try:
        pg_postmaster_start_time = str(_val(engine, "SELECT pg_postmaster_start_time()"))
    except Exception:
        pass

    autovacuum_enabled = True
    try:
        val = _val(engine, "SHOW autovacuum")
        autovacuum_enabled = str(val).lower() == "on"
    except Exception:
        pass

    active_connections = connections_by_state.get("active", 0)

    health_summary = {
        "version":                  version,
        "uptime_str":               uptime_str,
        "uptime":                   uptime_str,
        "host_name":                conn_rec.host,
        "total_databases":          total_databases,
        "total_tables":             total_tables,
        "total_size":               total_size,
        "total_size_mb":            total_size_mb,
        "total_connections":        total_connections,
        "active_connections":       active_connections,
        "max_connections":          max_connections,
        "connection_pct":           connection_pct,
        "connection_usage_pct":     connection_pct,
        "cache_hit_pct":            cache_hit_pct,
        "cache_hit_ratio":          cache_hit_pct,
        "commits":                  commits,
        "rollbacks":                rollbacks,
        "tup_returned":             tup_returned,
        "tup_fetched":              tup_fetched,
        "replication_state":        replication_state,
        "is_recovery":              is_recovery,
        "autovacuum_enabled":       autovacuum_enabled,
        "pg_postmaster_start_time": pg_postmaster_start_time,
        "last_restart":             pg_postmaster_start_time,
    }

    _res = {
        "status":     "success",
        "connection": connection_meta,
        "health_summary": health_summary,
        "databases":  databases,
        "query_stats": {
            "commits": commits, "xact_commit": commits,
            "rollbacks": rollbacks, "xact_rollback": rollbacks,
            "tup_returned": tup_returned, "tup_fetched": tup_fetched,
            "tup_inserted": n_tup_ins, "tup_updated": n_tup_upd, "tup_deleted": n_tup_del,
            "n_tup_ins": n_tup_ins, "n_tup_upd": n_tup_upd, "n_tup_del": n_tup_del,
            "total_seq_scan": total_seq_scan, "total_idx_scan": total_idx_scan,
            "blks_read": blks_read, "blks_hit": blks_hit,
            "temp_files": temp_files, "temp_bytes": temp_bytes,
            "slow_queries": len(long_running_queries),
        },
        "connections_detail": {
            "total": total_connections, "max": max_connections,
            "connection_pct": connection_pct, "by_state": connections_by_state,
            "idle": connections_by_state.get("idle", 0),
            "idle_in_transaction": connections_by_state.get("idle in transaction", 0),
            "waiting": sum(1 for _ in pg_locks if not _.get("granted", True)),
        },
        "shared_buffers": {
            "size": server_vars.get("shared_buffers", "unknown"),
            "blks_read": blks_read, "blks_hit": blks_hit,
        },
        "memory":            memory,
        "bgwriter":          bgwriter,
        "checkpoints":       checkpoints,
        "replication":       replication,
        "replication_slots": replication_slots,
        "replication_state": replication_state,
        "is_recovery":       is_recovery,
        "process_list":      process_list,
        "long_running_queries": long_running_queries,
        "pg_stat_statements":   pg_stat_statements,
        "pg_stat_user_tables":  table_stats,
        "table_stats":          table_stats,
        "pg_locks":             pg_locks,
        "blocking_queries":     blocking_queries,
        "tablespaces":          tablespaces,
        "users_activity":       users_activity,
        "server_vars":          server_vars,
    }
    # Self-cache this good build so the dashboard stays populated for the TTL even if
    # the collector's next build fails (agent busy).
    try:
        from app.utils.agent_cache import store_snapshot_for_conn
        store_snapshot_for_conn(conn_id, "pg_monitoring_dashboard", _res, db)
    except Exception:
        pass
    return _res


# ═════════════════════════════════════════════════════════════════════════════
#  2. Slow Queries
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_slow_queries(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_slow_queries", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e), "queries": [], "total": 0}

    pg_stat_statements_available = False
    queries = []
    source  = "pg_stat_activity"
    error   = None

    # pg_stat_statements returns CLUSTER-WIDE stats, but the view only exists in the DB(s)
    # where CREATE EXTENSION was run. The connection DB (e.g. 'actmon') often lacks it even
    # though the library is preloaded and 'postgres' has it — so read from whichever DB has it.
    pgss_eng, pgss_db = _pgss_engine(conn_rec)
    read_eng = pgss_eng or engine

    try:
        rows = _rows(
            read_eng,
            "SELECT userid::regrole AS user_name, s.dbid, d.datname, s.query, s.calls, "
            "s.total_exec_time, s.mean_exec_time, s.max_exec_time, s.stddev_exec_time, "
            "s.rows, s.shared_blks_hit, s.shared_blks_read "
            "FROM pg_stat_statements s "
            "JOIN pg_database d ON d.oid = s.dbid "
            "WHERE s.query NOT LIKE '%pg_stat_statements%' "
            "AND s.query NOT LIKE '%pg_catalog%' "
            "ORDER BY s.mean_exec_time DESC "
            "LIMIT 50"
        )
        queries = [dict(r) for r in rows]
        for q in queries:
            q["user_name"]       = str(q.get("user_name") or "")
            q["calls"]           = int(q.get("calls") or 0)
            q["rows"]            = int(q.get("rows") or 0)
            q["shared_blks_hit"] = int(q.get("shared_blks_hit") or 0)
            q["shared_blks_read"]= int(q.get("shared_blks_read") or 0)
            q["total_exec_time"] = float(q.get("total_exec_time") or 0.0)
            q["mean_exec_time"]  = float(q.get("mean_exec_time") or 0.0)
            q["max_exec_time"]   = float(q.get("max_exec_time") or 0.0)
            q["stddev_exec_time"]= float(q.get("stddev_exec_time") or 0.0)
        pg_stat_statements_available = True
        source = "pg_stat_statements"
    except Exception as e:
        raw = str(e)
        if "pg_stat_statements" in raw and ("does not exist" in raw or "UndefinedTable" in raw):
            error = "not_installed"
        elif "permission denied" in raw.lower() or "42501" in raw:
            error = "permission_denied"
        else:
            error = "unavailable"

        try:
            rows = _rows(
                engine,
                "SELECT pid, usename, datname, state, "
                "EXTRACT(EPOCH FROM (now() - query_start))::int AS elapsed_sec, "
                "left(query, 500) AS query "
                "FROM pg_stat_activity "
                "WHERE state = 'active' "
                "AND query NOT LIKE '%pg_stat_activity%' "
                "ORDER BY elapsed_sec DESC NULLS LAST "
                "LIMIT 50"
            )
            queries = [dict(r) for r in rows]
            for q in queries:
                q["elapsed_sec"] = int(q.get("elapsed_sec") or 0)
            source = "pg_stat_activity"
            pg_stat_statements_available = False
        except Exception:
            queries = []
    finally:
        if pgss_eng is not None:
            try:
                pgss_eng.dispose()
            except Exception:
                pass

    return {
        "status":  "success",
        "source":  source,
        "queries": queries,
        "pg_stat_statements_available": pg_stat_statements_available,
        "pgss_database": pgss_db,
        "total":   len(queries),
        "error":   error,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  3. Enable pg_stat_statements
# ═════════════════════════════════════════════════════════════════════════════

def svc_enable_pg_stat_statements(conn_id: int, db: Session, database: str = None):
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        # create the extension in the SPECIFIC database (each DB needs its own CREATE EXTENSION)
        engine = _pg_engine_db(conn_rec, database) if database else _pg_engine(conn_rec)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # If the view is already readable from some database (e.g. 'postgres'), we're done —
    # ActMon reads cluster-wide stats from there. No CREATE EXTENSION needed.
    pgss_eng, pgss_db = _pgss_engine(conn_rec)
    if pgss_eng:
        return {
            "status":  "success",
            "message": f"pg_stat_statements is already active (read from the '{pgss_db}' database). Reopen the Queries tab.",
            "next_step": None,
        }

    try:
        with engine.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            # standby/replica cannot accept writes — CREATE EXTENSION must run on the primary
            try:
                if conn.execute(text("SELECT pg_is_in_recovery()")).scalar():
                    return {
                        "status":  "read_only_replica",
                        "message": "This node is a read-only standby/replica — CREATE EXTENSION can only run on the PRIMARY. "
                                   "Enable it on the primary (or it's already enabled there and ActMon will read it).",
                        "next_step": "use_primary",
                    }
            except Exception:
                pass
            try:
                conn.execute(text("SET default_transaction_read_only = off"))
            except Exception:
                pass
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"))
        return {
            "status":    "success",
            "message":   "pg_stat_statements extension created successfully. Reopen the Queries tab to see data.",
            "next_step": None,
        }
    except Exception as e:
        raw = str(e)
        if "read-only" in raw.lower() or "readonlysql" in raw.lower():
            return {
                "status":  "read_only_replica",
                "message": "The target node is read-only (a standby/replica). Enable pg_stat_statements on the PRIMARY node — "
                           "ActMon will then read the stats automatically.",
                "next_step": "use_primary",
            }
        if "shared_preload_libraries" in raw or "requires restart" in raw or "could not open extension control file" in raw:
            return {
                "status":    "needs_restart",
                "message":   "The extension library is not loaded. Add it to postgresql.conf and restart PostgreSQL first.",
                "next_step": "add_preload",
            }
        if "permission denied" in raw.lower() or "42501" in raw or "must be superuser" in raw.lower():
            return {
                "status":    "permission_denied",
                "message":   f"'{conn_rec.username}' is not a superuser. Run CREATE EXTENSION as a superuser once "
                             "(in the 'postgres' database is enough — ActMon reads cluster-wide stats from there).",
                "next_step": "grant_permission",
            }
        return {
            "status":    "error",
            "message":   f"Could not create extension: {raw[:300]}",
            "next_step": None,
        }


# ═════════════════════════════════════════════════════════════════════════════
#  4. Index Analysis
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_index_analysis(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_index_analysis", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e),
                "unused_indexes": [], "all_indexes": [], "bloated_tables": [],
                "summary": {}, "errors": [str(e)]}

    unused_indexes = []
    all_indexes    = []
    bloated_tables = []
    errors         = []

    try:
        rows = _rows(
            engine,
            "SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, "
            "idx_tup_fetch, "
            "pg_size_pretty(pg_relation_size(indexrelid)) AS index_size "
            "FROM pg_stat_user_indexes "
            "WHERE idx_scan = 0 "
            "AND indexname NOT LIKE '%_pkey' "
            "ORDER BY pg_relation_size(indexrelid) DESC"
        )
        unused_indexes = [dict(r) for r in rows]
        for idx in unused_indexes:
            idx["idx_scan"]      = int(idx.get("idx_scan") or 0)
            idx["idx_tup_read"]  = int(idx.get("idx_tup_read") or 0)
            idx["idx_tup_fetch"] = int(idx.get("idx_tup_fetch") or 0)
    except Exception as e:
        errors.append(f"unused_indexes: {e}")

    try:
        rows = _rows(
            engine,
            "SELECT s.schemaname, s.tablename, s.indexname, s.idx_scan, "
            "i.indexdef, "
            "pg_size_pretty(pg_relation_size(s.indexrelid)) AS size "
            "FROM pg_stat_user_indexes s "
            "JOIN pg_indexes i "
            "ON s.schemaname = i.schemaname "
            "AND s.tablename = i.tablename "
            "AND s.indexname = i.indexname "
            "ORDER BY s.idx_scan ASC "
            "LIMIT 200"
        )
        all_indexes = [dict(r) for r in rows]
        for idx in all_indexes:
            idx["idx_scan"] = int(idx.get("idx_scan") or 0)
    except Exception as e:
        errors.append(f"all_indexes: {e}")

    try:
        rows = _rows(
            engine,
            "SELECT schemaname, tablename, n_live_tup, n_dead_tup, "
            "CASE WHEN n_live_tup > 0 "
            "     THEN round(100.0 * n_dead_tup / n_live_tup, 1) "
            "     ELSE 0 "
            "END AS dead_pct, "
            "last_vacuum, last_autovacuum "
            "FROM pg_stat_user_tables "
            "WHERE n_live_tup > 1000 "
            "ORDER BY n_live_tup DESC "
            "LIMIT 30"
        )
        bloated_tables = [dict(r) for r in rows]
        for t in bloated_tables:
            t["n_live_tup"]      = int(t.get("n_live_tup") or 0)
            t["n_dead_tup"]      = int(t.get("n_dead_tup") or 0)
            t["dead_pct"]        = float(t.get("dead_pct") or 0.0)
            t["last_vacuum"]     = str(t.get("last_vacuum") or "")
            t["last_autovacuum"] = str(t.get("last_autovacuum") or "")
    except Exception as e:
        errors.append(f"bloated_tables: {e}")

    summary = {
        "total_indexes": len(all_indexes),
        "unused_count":  len(unused_indexes),
        "total_tables":  len(bloated_tables),
    }

    return {
        "status":         "success",
        "unused_indexes": unused_indexes,
        "all_indexes":    all_indexes,
        "bloated_tables": bloated_tables,
        "summary":        summary,
        "errors":         errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  5. Replication Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_replication_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_replication_detail", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    errors = []

    is_recovery = False
    try:
        is_recovery = bool(_val(engine, "SELECT pg_is_in_recovery()"))
    except Exception as e:
        errors.append(f"role: {e}")

    server_role = "STANDBY" if is_recovery else "PRIMARY"

    pg_ver_num = 0
    try:
        pg_ver_num = int(_val(engine, "SELECT current_setting('server_version_num')::int") or 0)
    except Exception:
        try:
            pg_ver_num = int(_val(engine, "SHOW server_version_num") or 0)
        except Exception:
            pass

    primary_wal = {}
    if not is_recovery:
        try:
            row = _rows(
                engine,
                "SELECT pg_current_wal_lsn()::text AS current_lsn, "
                "pg_walfile_name(pg_current_wal_lsn()) AS wal_file, "
                "pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') AS total_wal_bytes"
            )
            if row:
                primary_wal = {
                    "current_lsn":     row[0].get("current_lsn", ""),
                    "wal_file":        row[0].get("wal_file", ""),
                    "total_wal_bytes": int(row[0].get("total_wal_bytes") or 0),
                }
        except Exception as e:
            errors.append(f"primary_wal: {e}")

    standby_info = {}
    if is_recovery:
        try:
            row = _rows(
                engine,
                "SELECT "
                "  COALESCE(pg_last_wal_receive_lsn()::text, '')  AS receive_lsn, "
                "  COALESCE(pg_last_wal_replay_lsn()::text, '')   AS replay_lsn, "
                "  pg_last_xact_replay_timestamp()                 AS last_replay_ts, "
                "  CASE WHEN pg_last_wal_receive_lsn() IS NOT NULL AND pg_last_wal_replay_lsn() IS NOT NULL "
                "       THEN pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) "
                "       ELSE 0 END                                 AS receive_replay_diff, "
                "  EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint AS seconds_behind"
            )
            if row:
                r = row[0]
                standby_info = {
                    "receive_lsn":         r.get("receive_lsn", ""),
                    "replay_lsn":          r.get("replay_lsn", ""),
                    "last_replay_ts":      str(r.get("last_replay_ts") or ""),
                    "receive_replay_diff": int(r.get("receive_replay_diff") or 0),
                    "seconds_behind":      int(r.get("seconds_behind") or 0),
                }
        except Exception as e:
            errors.append(f"standby_info: {e}")

        try:
            rows = _rows(engine, "SELECT * FROM pg_stat_wal_receiver LIMIT 1")
            if rows:
                r = rows[0]
                received_lsn_val = (
                    str(r.get("received_lsn") or "")
                    or str(r.get("flushed_lsn") or "")
                    or str(r.get("written_lsn") or "")
                )
                standby_info["wal_receiver"] = {
                    "status":                str(r.get("status") or ""),
                    "receive_start_lsn":     str(r.get("receive_start_lsn") or ""),
                    "received_lsn":          received_lsn_val,
                    "last_msg_send_time":    str(r.get("last_msg_send_time") or ""),
                    "last_msg_receipt_time": str(r.get("last_msg_receipt_time") or ""),
                    "latest_end_lsn":        str(r.get("latest_end_lsn") or ""),
                    "sender_host":           str(r.get("sender_host") or ""),
                    "sender_port":           r.get("sender_port"),
                    "slot_name":             str(r.get("slot_name") or ""),
                }
        except Exception as e:
            errors.append(f"wal_receiver: {e}")

    replicas = []
    if not is_recovery:
        try:
            rows = _rows(
                engine,
                "SELECT "
                "  pid::text AS pid, usename, application_name, "
                "  COALESCE(client_addr::text, 'local') AS client_addr, "
                "  COALESCE(client_hostname, '')         AS client_hostname, "
                "  COALESCE(state, 'streaming')          AS state, "
                "  COALESCE(sent_lsn::text,   '')        AS sent_lsn, "
                "  COALESCE(write_lsn::text,  '')        AS write_lsn, "
                "  COALESCE(flush_lsn::text,  '')        AS flush_lsn, "
                "  COALESCE(replay_lsn::text, '')        AS replay_lsn, "
                "  COALESCE(write_lag::text,  '0')       AS write_lag, "
                "  COALESCE(flush_lag::text,  '0')       AS flush_lag, "
                "  COALESCE(replay_lag::text, '0')       AS replay_lag, "
                "  COALESCE(EXTRACT(EPOCH FROM write_lag)::bigint,  0) AS write_lag_ms, "
                "  COALESCE(EXTRACT(EPOCH FROM flush_lag)::bigint,  0) AS flush_lag_ms, "
                "  COALESCE(EXTRACT(EPOCH FROM replay_lag)::bigint, 0) AS replay_lag_ms, "
                "  CASE WHEN sent_lsn IS NOT NULL AND replay_lsn IS NOT NULL "
                "       THEN pg_wal_lsn_diff(sent_lsn, replay_lsn) ELSE 0 "
                "  END AS byte_lag, "
                "  CASE WHEN sent_lsn IS NOT NULL AND write_lsn IS NOT NULL "
                "       THEN pg_wal_lsn_diff(sent_lsn, write_lsn) ELSE 0 "
                "  END AS write_byte_lag, "
                "  CASE WHEN write_lsn IS NOT NULL AND flush_lsn IS NOT NULL "
                "       THEN pg_wal_lsn_diff(write_lsn, flush_lsn) ELSE 0 "
                "  END AS flush_byte_lag, "
                "  CASE WHEN flush_lsn IS NOT NULL AND replay_lsn IS NOT NULL "
                "       THEN pg_wal_lsn_diff(flush_lsn, replay_lsn) ELSE 0 "
                "  END AS apply_byte_lag, "
                "  sync_state, "
                "  backend_start::text AS backend_start "
                "FROM pg_stat_replication "
                "ORDER BY byte_lag DESC "
                "LIMIT 20"
            )
            replicas = [dict(r) for r in rows]
            for r in replicas:
                r["write_lag_ms"]   = int(r.get("write_lag_ms")   or 0)
                r["flush_lag_ms"]   = int(r.get("flush_lag_ms")   or 0)
                r["replay_lag_ms"]  = int(r.get("replay_lag_ms")  or 0)
                r["byte_lag"]       = int(r.get("byte_lag")       or 0)
                r["write_byte_lag"] = int(r.get("write_byte_lag") or 0)
                r["flush_byte_lag"] = int(r.get("flush_byte_lag") or 0)
                r["apply_byte_lag"] = int(r.get("apply_byte_lag") or 0)
        except Exception as e:
            errors.append(f"replicas: {e}")

    slots = []
    try:
        lsn_fn = (
            "COALESCE(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())"
            if is_recovery else "pg_current_wal_lsn()"
        )
        if pg_ver_num >= 130000:
            slot_sql = (
                "SELECT slot_name, plugin, slot_type, database, active, "
                "COALESCE(active_pid::text,'') AS active_pid, "
                "COALESCE(xmin::text,'') AS xmin, "
                "COALESCE(catalog_xmin::text,'') AS catalog_xmin, "
                "COALESCE(restart_lsn::text,'') AS restart_lsn, "
                "COALESCE(confirmed_flush_lsn::text,'') AS confirmed_flush_lsn, "
                "wal_status, "
                "COALESCE(safe_wal_size, 0) AS safe_wal_size, "
                f"CASE WHEN restart_lsn IS NOT NULL "
                f"     THEN GREATEST(0, pg_wal_lsn_diff({lsn_fn}, restart_lsn)) "
                f"     ELSE 0 END AS retained_bytes "
                "FROM pg_replication_slots"
            )
        else:
            slot_sql = (
                "SELECT slot_name, plugin, slot_type, database, active, "
                "COALESCE(active_pid::text,'') AS active_pid, "
                "COALESCE(xmin::text,'') AS xmin, "
                "COALESCE(catalog_xmin::text,'') AS catalog_xmin, "
                "COALESCE(restart_lsn::text,'') AS restart_lsn, "
                "COALESCE(confirmed_flush_lsn::text,'') AS confirmed_flush_lsn, "
                "NULL AS wal_status, "
                "0 AS safe_wal_size, "
                f"CASE WHEN restart_lsn IS NOT NULL "
                f"     THEN GREATEST(0, pg_wal_lsn_diff({lsn_fn}, restart_lsn)) "
                f"     ELSE 0 END AS retained_bytes "
                "FROM pg_replication_slots"
            )
        rows = _rows(engine, slot_sql)
        slots = [dict(r) for r in rows]
        for s in slots:
            s["active"]         = bool(s.get("active"))
            s["retained_bytes"] = max(0, int(s.get("retained_bytes") or 0))
            s["safe_wal_size"]  = int(s.get("safe_wal_size") or 0)
            if not s["active"]:
                stype = s.get("slot_type", "physical")
                if stype == "logical":
                    s["inactive_reason"] = "Logical replication subscriber is not connected"
                else:
                    if is_recovery:
                        s["inactive_reason"] = "Downstream replica not streaming from this standby (cascading slot)"
                    else:
                        s["inactive_reason"] = "Replica is not currently connected to this primary"
    except Exception as e:
        errors.append(f"slots: {e}")

    rep_config = {}
    for param in ("wal_level", "max_wal_senders", "max_replication_slots",
                  "synchronous_commit", "synchronous_standby_names",
                  "hot_standby", "hot_standby_feedback",
                  "wal_keep_size", "wal_sender_timeout", "wal_receiver_timeout",
                  "recovery_min_apply_delay"):
        try:
            rep_config[param] = _val(engine, f"SHOW {param}")
        except Exception:
            rep_config[param] = "n/a"

    wal_senders = []
    try:
        rows = _rows(
            engine,
            "SELECT pid, usename, application_name, "
            "COALESCE(client_addr::text,'local') AS client_addr, "
            "state, backend_start::text "
            "FROM pg_stat_activity "
            "WHERE backend_type = 'walsender' "
            "ORDER BY backend_start"
        )
        wal_senders = [dict(r) for r in rows]
    except Exception:
        pass

    streaming_count = len([r for r in replicas if r.get("state") in ("streaming", "catchup")])
    sync_count      = len([r for r in replicas if r.get("sync_state") == "sync"])
    async_count     = len([r for r in replicas if r.get("sync_state") == "async"])
    total_byte_lag  = sum(r.get("byte_lag", 0) for r in replicas)
    max_byte_lag    = max((r.get("byte_lag", 0) for r in replicas), default=0)
    active_slots    = len([s for s in slots if s.get("active")])
    inactive_slots  = len([s for s in slots if not s.get("active")])
    total_retained  = sum(max(0, s.get("retained_bytes", 0)) for s in slots)

    topology = {
        "role":            server_role,
        "replica_count":   len(replicas),
        "streaming_count": streaming_count,
        "sync_count":      sync_count,
        "async_count":     async_count,
        "total_byte_lag":  total_byte_lag,
        "max_byte_lag":    max_byte_lag,
        "slot_count":      len(slots),
        "active_slots":    active_slots,
        "inactive_slots":  inactive_slots,
        "total_retained":  total_retained,
    }

    checkpoint_stats = {}
    try:
        rows = _rows(engine,
            "SELECT checkpoints_timed, checkpoints_req, "
            "checkpoint_write_time, checkpoint_sync_time, "
            "buffers_checkpoint, buffers_clean, maxwritten_clean, "
            "buffers_backend, buffers_backend_fsync, buffers_alloc, "
            "stats_reset::text AS stats_reset "
            "FROM pg_stat_bgwriter LIMIT 1")
        if rows:
            checkpoint_stats = dict(rows[0])
            for k in ("checkpoints_timed", "checkpoints_req", "buffers_checkpoint",
                      "buffers_clean", "maxwritten_clean", "buffers_backend",
                      "buffers_backend_fsync", "buffers_alloc"):
                checkpoint_stats[k] = int(checkpoint_stats.get(k) or 0)
            for k in ("checkpoint_write_time", "checkpoint_sync_time"):
                checkpoint_stats[k] = float(checkpoint_stats.get(k) or 0)
    except Exception as e:
        errors.append(f"checkpoint_stats: {e}")

    wal_stats = {}
    if pg_ver_num >= 140000:
        try:
            rows = _rows(engine,
                "SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full, "
                "wal_write, wal_sync, wal_write_time, wal_sync_time, "
                "stats_reset::text AS stats_reset "
                "FROM pg_stat_wal LIMIT 1")
            if rows:
                wal_stats = dict(rows[0])
                for k in ("wal_records", "wal_fpi", "wal_buffers_full", "wal_write", "wal_sync"):
                    wal_stats[k] = int(wal_stats.get(k) or 0)
                wal_stats["wal_bytes"] = int(wal_stats.get("wal_bytes") or 0)
                for k in ("wal_write_time", "wal_sync_time"):
                    wal_stats[k] = float(wal_stats.get(k) or 0)
        except Exception as e:
            errors.append(f"wal_stats: {e}")

    conflicts = []
    if is_recovery:
        try:
            rows = _rows(engine,
                "SELECT datname, confl_tablespace, confl_lock, confl_snapshot, "
                "confl_bufferpin, confl_deadlock "
                "FROM pg_stat_database_conflicts "
                "WHERE (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) > 0 "
                "ORDER BY (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) DESC")
            conflicts = [dict(r) for r in rows]
            for c in conflicts:
                for k in ("confl_tablespace", "confl_lock", "confl_snapshot",
                          "confl_bufferpin", "confl_deadlock"):
                    c[k] = int(c.get(k) or 0)
        except Exception as e:
            errors.append(f"conflicts: {e}")

    publications = []
    if not is_recovery:
        try:
            rows = _rows(engine,
                "SELECT pubname, puballtables, pubinsert, pubupdate, "
                "pubdelete, pubtruncate "
                "FROM pg_publication ORDER BY pubname")
            publications = [dict(r) for r in rows]
            for p in publications:
                for k in ("puballtables", "pubinsert", "pubupdate", "pubdelete", "pubtruncate"):
                    p[k] = bool(p.get(k))
        except Exception as e:
            errors.append(f"publications: {e}")

    subscriptions = []
    try:
        rows = _rows(engine,
            "SELECT subname, subenabled, subslotname, subpublications "
            "FROM pg_subscription ORDER BY subname")
        subscriptions = [dict(r) for r in rows]
        for s in subscriptions:
            s["subenabled"] = bool(s.get("subenabled"))
    except Exception as e:
        errors.append(f"subscriptions: {e}")

    recovery_state = {}
    if is_recovery:
        try:
            pause_state = _val(engine, "SELECT pg_wal_replay_pause_state()")
            recovery_state["pause_state"] = str(pause_state or "")
        except Exception:
            try:
                paused = _val(engine, "SELECT pg_is_wal_replay_paused()")
                recovery_state["pause_state"] = "paused" if paused else "not paused"
            except Exception as e:
                errors.append(f"recovery_state: {e}")

        try:
            cfg_rows = _rows(engine,
                "SELECT name, setting FROM pg_settings "
                "WHERE name IN ('primary_conninfo','primary_slot_name','recovery_target_timeline',"
                "               'restore_command','recovery_min_apply_delay','wal_receiver_status_interval') "
                "ORDER BY name")
            for row in cfg_rows:
                k, v = row.get("name", ""), row.get("setting", "")
                if k == "primary_conninfo" and v:
                    v = re.sub(r"password=[^ ']*", "password=***", v)
                recovery_state[k] = v
        except Exception:
            pass

        try:
            wa = _rows(engine,
                "SELECT count(*)::int AS cnt "
                "FROM pg_stat_activity WHERE backend_type='walreceiver'")
            recovery_state["walreceiver_procs"] = int((wa[0].get("cnt") or 0) if wa else 0)
        except Exception:
            pass

        if not standby_info.get("wal_receiver") and recovery_state.get("primary_conninfo"):
            try:
                ci     = recovery_state["primary_conninfo"]
                host_m = re.search(r"host=([^\s']+)", ci)
                port_m = re.search(r"port=([^\s']+)", ci)
                user_m = re.search(r"user=([^\s']+)", ci)
                app_m  = re.search(r"application_name=([^\s']+)", ci)
                standby_info["conninfo_host"] = host_m.group(1) if host_m else ""
                standby_info["conninfo_port"] = int(port_m.group(1)) if port_m else None
                standby_info["conninfo_user"] = user_m.group(1) if user_m else ""
                standby_info["conninfo_app"]  = app_m.group(1) if app_m else ""
            except Exception:
                pass

    return {
        "status":           "success",
        "role":             server_role,
        "is_recovery":      is_recovery,
        "pg_version":       pg_ver_num,
        "primary_wal":      primary_wal,
        "standby_info":     standby_info,
        "replicas":         replicas,
        "slots":            slots,
        "wal_senders":      wal_senders,
        "rep_config":       rep_config,
        "topology":         topology,
        "checkpoint_stats": checkpoint_stats,
        "wal_stats":        wal_stats,
        "conflicts":        conflicts,
        "publications":     publications,
        "subscriptions":    subscriptions,
        "recovery_state":   recovery_state,
        "errors":           errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  6. Queries Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_queries_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_queries_detail", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    errors = []
    pg_ss_available = False

    ss_base = (
        "SELECT "
        "  COALESCE(userid::regrole::text, '') AS usename, "
        "  dbid::text AS dbid, "
        "  query, calls, "
        "  total_exec_time, mean_exec_time, max_exec_time, min_exec_time, "
        "  stddev_exec_time, rows, "
        "  shared_blks_hit, shared_blks_read, shared_blks_dirtied, shared_blks_written, "
        "  local_blks_hit, local_blks_read, "
        "  temp_blks_read, temp_blks_written "
        "FROM pg_stat_statements "
        "WHERE query NOT LIKE '%pg_stat_statements%' "
        "  AND query NOT LIKE '%pg_catalog%' "
        "  AND query NOT LIKE '%pg_class%' "
    )

    def _cast(rows_list):
        out = []
        for r in rows_list:
            row = dict(r)
            row["calls"]               = int(row.get("calls") or 0)
            row["rows"]                = int(row.get("rows") or 0)
            row["total_exec_time"]     = round(float(row.get("total_exec_time") or 0), 3)
            row["mean_exec_time"]      = round(float(row.get("mean_exec_time") or 0), 3)
            row["max_exec_time"]       = round(float(row.get("max_exec_time") or 0), 3)
            row["min_exec_time"]       = round(float(row.get("min_exec_time") or 0), 3)
            row["stddev_exec_time"]    = round(float(row.get("stddev_exec_time") or 0), 3)
            row["shared_blks_hit"]     = int(row.get("shared_blks_hit") or 0)
            row["shared_blks_read"]    = int(row.get("shared_blks_read") or 0)
            row["shared_blks_dirtied"] = int(row.get("shared_blks_dirtied") or 0)
            row["shared_blks_written"] = int(row.get("shared_blks_written") or 0)
            row["temp_blks_read"]      = int(row.get("temp_blks_read") or 0)
            row["temp_blks_written"]   = int(row.get("temp_blks_written") or 0)
            total_io = row["shared_blks_hit"] + row["shared_blks_read"]
            row["cache_hit_pct"]  = round(row["shared_blks_hit"] / max(total_io, 1) * 100, 1)
            row["rows_per_call"]  = round(row["rows"] / max(row["calls"], 1), 2)
            qt = str(row.get("query", "")).strip().upper()[:6]
            row["query_type"] = qt if qt in (
                "SELECT", "INSERT", "UPDATE", "DELETE", "WITH",
                "VACUUM", "ANALYZ", "CREATE", "DROP", "ALTER", "TRUNCA"
            ) else "OTHER"
            out.append(row)
        return out

    all_stmts = []
    pgss_eng, _pgss_db = _pgss_engine(conn_rec)
    if pgss_eng:
        try:
            rows = _rows(pgss_eng, ss_base + "LIMIT 500")
            all_stmts = _cast(rows)
            pg_ss_available = True
        except Exception as e:
            errors.append(f"pg_stat_statements: {e}")
    else:
        errors.append("pg_stat_statements view not found in any accessible database")

    top_mean  = sorted(all_stmts, key=lambda x: x["mean_exec_time"],  reverse=True)[:25]
    top_total = sorted(all_stmts, key=lambda x: x["total_exec_time"], reverse=True)[:25]
    top_calls = sorted(all_stmts, key=lambda x: x["calls"],           reverse=True)[:25]
    top_io    = sorted(all_stmts, key=lambda x: x["shared_blks_read"],reverse=True)[:25]
    top_rows  = sorted(all_stmts, key=lambda x: x["rows"],            reverse=True)[:25]
    top_temp  = sorted(all_stmts, key=lambda x: x["temp_blks_read"],  reverse=True)[:10]

    by_type = {}
    for s in all_stmts:
        qt = s["query_type"]
        by_type[qt] = by_type.get(qt, 0) + 1

    active_queries = []
    try:
        rows = _rows(
            engine,
            "SELECT pid, usename, datname, application_name, "
            "  client_addr::text AS client_addr, backend_type, "
            "  state, wait_event_type, wait_event, "
            "  EXTRACT(EPOCH FROM (now()-query_start))::int AS duration_sec, "
            "  EXTRACT(EPOCH FROM (now()-state_change))::int AS state_sec, "
            "  left(query, 500) AS query, "
            "  backend_start::text AS backend_start, "
            "  query_start::text AS query_start_ts "
            "FROM pg_stat_activity "
            "WHERE state != 'idle' "
            "  AND backend_type = 'client backend' "
            "  AND query NOT LIKE '%pg_stat_activity%' "
            "ORDER BY duration_sec DESC NULLS LAST "
            "LIMIT 50"
        )
        active_queries = [dict(r) for r in rows]
        for q in active_queries:
            q["duration_sec"] = int(q.get("duration_sec") or 0)
            q["state_sec"]    = int(q.get("state_sec")    or 0)
    except Exception as e:
        errors.append(f"active_queries: {e}")

    long_running = [q for q in active_queries if q.get("duration_sec", 0) > 30]

    wait_events = {}
    for q in active_queries:
        we = q.get("wait_event_type") or "running"
        wait_events[we] = wait_events.get(we, 0) + 1

    all_backends = []
    try:
        rows = _rows(
            engine,
            "SELECT backend_type, state, count(*) AS cnt "
            "FROM pg_stat_activity "
            "GROUP BY backend_type, state ORDER BY cnt DESC"
        )
        all_backends = [{"backend_type": r.get("backend_type", ""),
                         "state":        r.get("state", ""),
                         "count":        int(r.get("cnt") or 0)} for r in rows]
    except Exception as e:
        errors.append(f"all_backends: {e}")

    cache_hit = 0.0
    try:
        rows = _rows(engine, "SELECT sum(blks_hit) AS hit, sum(blks_read) AS rd FROM pg_stat_database")
        if rows:
            h = int(rows[0].get("hit") or 0)
            r = int(rows[0].get("rd")  or 0)
            cache_hit = round(h / max(h + r, 1) * 100, 2)
    except Exception:
        pass

    return {
        "status":            "success",
        "pg_ss_available":   pg_ss_available,
        "total_statements":  len(all_stmts),
        "cache_hit_pct":     cache_hit,
        "by_type":           by_type,
        "wait_events":       wait_events,
        "top_by_mean_time":  top_mean,
        "top_by_total_time": top_total,
        "top_by_calls":      top_calls,
        "top_by_io":         top_io,
        "top_by_rows":       top_rows,
        "top_by_temp":       top_temp,
        "active_queries":    active_queries,
        "long_running":      long_running,
        "all_backends":      all_backends,
        "errors":            errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  7. Tables Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_tables_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_tables_detail", db)
    if _cached is not None:
        return _cached

    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    errors = []

    try:
        with engine.connect() as conn:
            db_rows = conn.execute(text(
                "SELECT datname FROM pg_database "
                "WHERE datistemplate = false "
                "ORDER BY datname"
            )).fetchall()
            all_dbs = [r[0] for r in db_rows]
    except Exception as e:
        errors.append(f"db-list: {e}")
        all_dbs = [conn_rec.database_name or "postgres"]

    all_tables: list = []
    all_idx_by_db: dict = {}

    for dbname in all_dbs:
        try:
            db_eng = _pg_engine_db(conn_rec, dbname)
            try:
                raw = _rows(db_eng, _TABLE_SQL)
                all_tables.extend(_process_table_rows(raw, dbname))

                idx_by_table: dict = {}
                for r in _rows(db_eng, _IDX_SQL):
                    key = f"{r.get('schemaname')}.{r.get('tablename')}"
                    idx_by_table.setdefault(key, []).append({
                        "indexname":    r.get("indexname", ""),
                        "idx_scan":     int(r.get("idx_scan") or 0),
                        "idx_tup_read": int(r.get("idx_tup_read") or 0),
                        "index_size":   r.get("index_size", ""),
                        "index_bytes":  int(r.get("index_bytes") or 0),
                        "is_unique":    bool(r.get("is_unique")),
                        "is_primary":   bool(r.get("is_primary")),
                        "index_def":    r.get("index_def", ""),
                    })
                all_idx_by_db[dbname] = idx_by_table
            except Exception as e:
                errors.append(f"{dbname}-tables: {e}")
            finally:
                db_eng.dispose()
        except Exception as e:
            errors.append(f"{dbname}-connect: {e}")

    for t in all_tables:
        key = f"{t['schemaname']}.{t['relname']}"
        idx_map = all_idx_by_db.get(t["database"], {})
        t["indexes"]        = idx_map.get(key, [])
        t["index_count"]    = len(t["indexes"])
        t["unused_indexes"] = [i for i in t["indexes"] if i["idx_scan"] == 0]

    all_tables.sort(key=lambda x: x.get("total_bytes", 0), reverse=True)

    autovac_config = {}
    for p in ("autovacuum", "autovacuum_vacuum_threshold", "autovacuum_analyze_threshold",
              "autovacuum_vacuum_scale_factor", "autovacuum_analyze_scale_factor",
              "autovacuum_vacuum_cost_delay", "autovacuum_max_workers"):
        try:
            autovac_config[p] = _val(engine, f"SHOW {p}")
        except Exception:
            autovac_config[p] = "n/a"

    vacuum_needed  = [t for t in all_tables if t.get("needs_vacuum")]
    analyze_needed = [t for t in all_tables if t.get("needs_analyze")]
    total_bytes    = sum(t.get("total_bytes", 0) for t in all_tables)
    databases_list = sorted(set(t["database"] for t in all_tables))

    return {
        "status":         "success",
        "tables":         all_tables,
        "total_count":    len(all_tables),
        "total_bytes":    total_bytes,
        "vacuum_needed":  len(vacuum_needed),
        "analyze_needed": len(analyze_needed),
        "autovac_config": autovac_config,
        "databases":      databases_list,
        "errors":         errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  8. Table Structure
# ═════════════════════════════════════════════════════════════════════════════

def svc_table_structure(
    conn_id:  int,
    database: str,
    db:       Session,
    schema:   str = "public",
    table:    str = "",
):
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(404, "Connection not found")

    errors = []
    try:
        db_eng = _pg_engine_db(conn_rec, database)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    columns = indexes = constraints = triggers = []
    row_count = exact_row_count = None
    table_meta = {}
    partitions = []
    partition_info = {}
    col_stats = []
    top_queries = []
    slow_queries = []
    has_pg_stat_statements = False

    try:
        with db_eng.connect() as conn:

            try:
                # Read columns from pg_catalog (NOT information_schema) — information_schema.columns
                # is privilege-filtered, so a monitoring user with no table privileges sees 0 columns.
                columns = [dict(r) for r in conn.execute(text("""
                    SELECT
                        a.attnum AS ordinal_position,
                        a.attname AS column_name,
                        format_type(a.atttypid, a.atttypmod) AS data_type,
                        format_type(a.atttypid, a.atttypmod) AS udt_name,
                        NULL::int AS character_maximum_length,
                        NULL::int AS numeric_precision,
                        NULL::int AS numeric_scale,
                        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
                        pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
                        CASE WHEN a.attidentity IN ('a','d') THEN 'YES' ELSE 'NO' END AS is_identity,
                        CASE a.attidentity WHEN 'a' THEN 'ALWAYS' WHEN 'd' THEN 'BY DEFAULT' ELSE NULL END AS identity_generation,
                        col_description(c.oid, a.attnum) AS column_comment
                    FROM pg_catalog.pg_attribute a
                    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                    WHERE n.nspname = :schema AND c.relname = :tname
                      AND a.attnum > 0 AND NOT a.attisdropped
                    ORDER BY a.attnum
                """), {"schema": schema, "tname": table}).mappings().fetchall()]
            except Exception as e:
                errors.append(f"columns: {e}")

            try:
                indexes = [dict(r) for r in conn.execute(text("""
                    SELECT
                        i.relname                           AS index_name,
                        ix.indisunique                      AS is_unique,
                        ix.indisprimary                     AS is_primary,
                        ix.indisvalid                       AS is_valid,
                        ix.indisclustered                   AS is_clustered,
                        pg_size_pretty(pg_relation_size(i.oid)) AS index_size,
                        pg_relation_size(i.oid)             AS index_bytes,
                        s.idx_scan,
                        s.idx_tup_read,
                        s.idx_tup_fetch,
                        pg_get_indexdef(i.oid)              AS index_def,
                        string_agg(a.attname, ', ' ORDER BY x.n) AS columns
                    FROM pg_class t
                    JOIN pg_namespace n  ON n.oid = t.relnamespace
                    JOIN pg_index ix     ON ix.indrelid = t.oid
                    JOIN pg_class i      ON i.oid = ix.indexrelid
                    JOIN pg_stat_user_indexes s
                        ON s.indexrelid = i.oid
                    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON true
                    JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = x.attnum
                    WHERE n.nspname = :schema AND t.relname = :tname AND t.relkind IN ('r','p')
                    GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indisvalid,
                             ix.indisclustered, i.oid, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
                    ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname
                """), {"schema": schema, "tname": table}).mappings().fetchall()]
            except Exception as e:
                errors.append(f"indexes: {e}")

            try:
                constraints = [dict(r) for r in conn.execute(text("""
                    SELECT
                        tc.constraint_name,
                        tc.constraint_type,
                        string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns,
                        ccu.table_schema  AS foreign_schema,
                        ccu.table_name    AS foreign_table,
                        ccu.column_name   AS foreign_column,
                        rc.update_rule,
                        rc.delete_rule
                    FROM information_schema.table_constraints tc
                    LEFT JOIN information_schema.key_column_usage kcu
                        ON kcu.constraint_name = tc.constraint_name
                        AND kcu.table_schema   = tc.table_schema
                        AND kcu.table_name     = tc.table_name
                    LEFT JOIN information_schema.constraint_column_usage ccu
                        ON ccu.constraint_name = tc.constraint_name
                        AND ccu.table_schema   = tc.table_schema
                    LEFT JOIN information_schema.referential_constraints rc
                        ON rc.constraint_name  = tc.constraint_name
                        AND rc.constraint_schema = tc.table_schema
                    WHERE tc.table_schema = :schema AND tc.table_name = :tname
                    GROUP BY tc.constraint_name, tc.constraint_type,
                             ccu.table_schema, ccu.table_name, ccu.column_name,
                             rc.update_rule, rc.delete_rule
                    ORDER BY tc.constraint_type, tc.constraint_name
                """), {"schema": schema, "tname": table}).mappings().fetchall()]
            except Exception as e:
                errors.append(f"constraints: {e}")

            try:
                triggers = [dict(r) for r in conn.execute(text("""
                    SELECT trigger_name, event_manipulation, action_timing,
                           action_statement, action_orientation
                    FROM information_schema.triggers
                    WHERE event_object_schema = :schema
                      AND event_object_table  = :tname
                    ORDER BY trigger_name, event_manipulation
                """), {"schema": schema, "tname": table}).mappings().fetchall()]
            except Exception as e:
                errors.append(f"triggers: {e}")

            try:
                row = conn.execute(text("""
                    SELECT
                        c.reltuples::bigint                                    AS est_rows,
                        COALESCE(s.n_live_tup, 0)                             AS live_rows,
                        COALESCE(s.n_dead_tup, 0)                             AS dead_rows,
                        c.relkind,
                        c.reloptions,
                        CASE WHEN c.relkind = 'p' THEN true ELSE false END    AS is_partitioned,
                        pg_size_pretty(pg_total_relation_size(c.oid))         AS total_size,
                        pg_size_pretty(pg_relation_size(c.oid))               AS heap_size,
                        pg_total_relation_size(c.oid)                         AS total_bytes,
                        pg_relation_size(c.oid)                               AS heap_bytes,
                        pg_size_pretty(pg_indexes_size(c.oid))                AS indexes_size,
                        pg_indexes_size(c.oid)                                AS indexes_bytes,
                        CASE WHEN c.reltoastrelid != 0
                             THEN pg_size_pretty(pg_relation_size(c.reltoastrelid))
                             ELSE '0 B' END                                    AS toast_size,
                        CASE WHEN c.reltoastrelid != 0
                             THEN pg_relation_size(c.reltoastrelid)
                             ELSE 0 END                                        AS toast_bytes,
                        obj_description(c.oid, 'pg_class')                    AS table_comment
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
                    WHERE n.nspname = :schema AND c.relname = :tname
                """), {"schema": schema, "tname": table}).mappings().fetchone()
                if row:
                    est  = int(row["est_rows"]  or 0)
                    live = int(row["live_rows"] or 0)
                    row_count = live if live > 0 else est
                    table_meta = {
                        "is_partitioned":  bool(row["is_partitioned"]),
                        "relkind":         str(row["relkind"] or ""),
                        "total_size":      str(row["total_size"] or ""),
                        "heap_size":       str(row["heap_size"] or ""),
                        "total_bytes":     int(row["total_bytes"] or 0),
                        "heap_bytes":      int(row["heap_bytes"] or 0),
                        "indexes_size":    str(row["indexes_size"] or ""),
                        "indexes_bytes":   int(row["indexes_bytes"] or 0),
                        "toast_size":      str(row["toast_size"] or "0 B"),
                        "toast_bytes":     int(row["toast_bytes"] or 0),
                        "table_comment":   str(row["table_comment"] or ""),
                        "est_rows":        est,
                        "live_rows":       live,
                        "stats_uptodate":  live > 0,
                        "storage_options": [],
                    }
                    if row["reloptions"]:
                        for opt in (row["reloptions"] or []):
                            if "=" in str(opt):
                                k, v = str(opt).split("=", 1)
                                table_meta["storage_options"].append({"key": k, "value": v})
            except Exception as e:
                errors.append(f"table_meta: {e}")

            try:
                rc_row = conn.execute(text("""
                    SELECT
                        n_live_tup             AS live_tup,
                        n_dead_tup             AS dead_tup,
                        reltuples::bigint       AS est_tup
                    FROM pg_stat_user_tables st
                    JOIN pg_class c ON c.oid = st.relid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE st.schemaname = :schema AND st.relname = :tname
                """), {"schema": schema, "tname": table}).mappings().fetchone()
                if rc_row:
                    live = int(rc_row["live_tup"] or 0)
                    est  = int(rc_row["est_tup"]  or 0)
                    exact_row_count = live if live > 0 else est
                    if table_meta:
                        table_meta["live_rows"]      = live
                        table_meta["est_rows"]       = est
                        table_meta["stats_uptodate"] = live > 0
            except Exception as e:
                errors.append(f"row_count: {e}")

            try:
                if table_meta.get("is_partitioned"):
                    prow = conn.execute(text("""
                        SELECT
                            CASE pt.partstrat
                                WHEN 'r' THEN 'RANGE'
                                WHEN 'l' THEN 'LIST'
                                WHEN 'h' THEN 'HASH'
                                ELSE pt.partstrat::text
                            END                             AS strategy,
                            pg_get_partkeydef(c.oid)        AS partition_key
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
                        WHERE n.nspname = :schema AND c.relname = :tname
                    """), {"schema": schema, "tname": table}).mappings().fetchone()
                    if prow:
                        partition_info = {
                            "strategy":      str(prow["strategy"] or ""),
                            "partition_key": str(prow["partition_key"] or ""),
                        }
                    part_rows = conn.execute(text("""
                        SELECT
                            child.relname                                         AS partition_name,
                            cn.nspname                                            AS schema_name,
                            pg_size_pretty(pg_total_relation_size(child.oid))     AS total_size,
                            pg_total_relation_size(child.oid)                     AS total_bytes,
                            pg_get_expr(child.relpartbound, child.oid)            AS partition_bound,
                            COALESCE(s.n_live_tup, 0)                            AS n_live_tup,
                            COALESCE(s.n_dead_tup, 0)                            AS n_dead_tup,
                            child.reltuples::bigint                               AS est_rows
                        FROM pg_inherits i
                        JOIN pg_class parent ON i.inhparent = parent.oid
                        JOIN pg_namespace pn  ON pn.oid = parent.relnamespace
                        JOIN pg_class child   ON i.inhrelid = child.oid
                        JOIN pg_namespace cn  ON cn.oid = child.relnamespace
                        LEFT JOIN pg_stat_user_tables s ON s.relid = child.oid
                        WHERE pn.nspname = :schema AND parent.relname = :tname
                        ORDER BY child.relname
                    """), {"schema": schema, "tname": table}).mappings().fetchall()
                    partitions = [dict(r) for r in part_rows]
                    for p in partitions:
                        p["total_bytes"] = int(p.get("total_bytes") or 0)
                        p["n_live_tup"]  = int(p.get("n_live_tup")  or 0)
                        p["n_dead_tup"]  = int(p.get("n_dead_tup")  or 0)
                        p["est_rows"]    = int(p.get("est_rows")    or 0)
                    partition_info["count"] = len(partitions)
            except Exception as e:
                errors.append(f"partitions: {e}")

            try:
                cstat_rows = conn.execute(text("""
                    SELECT
                        attname          AS column_name,
                        null_frac,
                        avg_width,
                        n_distinct,
                        correlation,
                        most_common_vals::text AS most_common_vals,
                        most_common_freqs
                    FROM pg_stats
                    WHERE schemaname = :schema AND tablename = :tname
                    ORDER BY attname
                """), {"schema": schema, "tname": table}).mappings().fetchall()
                col_stats = [dict(r) for r in cstat_rows]
                for cs in col_stats:
                    cs["null_frac"]  = float(cs.get("null_frac") or 0)
                    cs["avg_width"]  = int(cs.get("avg_width") or 0)
                    cs["n_distinct"] = float(cs.get("n_distinct") or 0)
                    mcv = cs.get("most_common_vals") or ""
                    if mcv.startswith("{") and mcv.endswith("}"):
                        inner = mcv[1:-1]
                        cs["most_common_vals"] = [v.strip('"') for v in inner.split(",")][:5]
                    else:
                        cs["most_common_vals"] = []
                    cs["correlation"] = float(cs.get("correlation") or 0) if cs.get("correlation") is not None else None
            except Exception as e:
                errors.append(f"col_stats: {e}")

            try:
                # pg_stat_statements view may only exist in another DB (e.g. 'postgres'); read it
                # from there and filter to THIS database + table. Works for monitoring users with
                # pg_read_all_stats even without the extension in the table's own database.
                pgss_eng, _pgssdb = _pgss_engine(conn_rec)
                has_pg_stat_statements = bool(pgss_eng)

                if has_pg_stat_statements:
                    tbl_pattern = f"%{table}%"
                    with pgss_eng.connect() as pc:
                        q_rows = pc.execute(text("""
                            SELECT
                                queryid::text                                   AS query_id,
                                LEFT(query, 300)                                AS query_text,
                                calls,
                                ROUND(total_exec_time::numeric, 1)              AS total_time_ms,
                                ROUND(mean_exec_time::numeric, 2)               AS mean_time_ms,
                                ROUND(stddev_exec_time::numeric, 2)             AS stddev_ms,
                                rows,
                                shared_blks_hit,
                                shared_blks_read,
                                ROUND((shared_blks_hit::numeric /
                                       GREATEST(shared_blks_hit + shared_blks_read, 1) * 100), 1) AS cache_hit_pct
                            FROM pg_stat_statements
                            WHERE query ILIKE :pattern
                              AND query NOT ILIKE '%pg_stat%'
                              AND (dbid = (SELECT oid FROM pg_database WHERE datname = :dbname) OR :dbname IS NULL)
                            ORDER BY total_exec_time DESC
                            LIMIT 15
                        """), {"pattern": tbl_pattern, "dbname": database}).mappings().fetchall()
                    all_queries = [dict(r) for r in q_rows]
                    for q in all_queries:
                        q["calls"]          = int(q.get("calls") or 0)
                        q["rows"]           = int(q.get("rows") or 0)
                        q["total_time_ms"]  = float(q.get("total_time_ms") or 0)
                        q["mean_time_ms"]   = float(q.get("mean_time_ms") or 0)
                        q["stddev_ms"]      = float(q.get("stddev_ms") or 0)
                        q["cache_hit_pct"]  = float(q.get("cache_hit_pct") or 0)
                        q["shared_blks_hit"]  = int(q.get("shared_blks_hit") or 0)
                        q["shared_blks_read"] = int(q.get("shared_blks_read") or 0)
                    top_queries  = sorted(all_queries, key=lambda x: x["calls"], reverse=True)[:5]
                    slow_queries = sorted(
                        [q for q in all_queries if q["calls"] >= 3],
                        key=lambda x: x["mean_time_ms"], reverse=True
                    )[:5]
            except Exception as e:
                errors.append(f"top_queries: {e}")

    except Exception as e:
        errors.append(str(e))
    finally:
        db_eng.dispose()

    return {
        "status":                 "success",
        "database":               database,
        "schema":                 schema,
        "table":                  table,
        "row_count":              exact_row_count if exact_row_count is not None else row_count,
        "table_meta":             table_meta,
        "columns":                columns,
        "indexes":                indexes,
        "constraints":            constraints,
        "triggers":               triggers,
        "partitions":             partitions,
        "partition_info":         partition_info,
        "col_stats":              col_stats,
        "top_queries":            top_queries,
        "slow_queries":           slow_queries,
        "has_pg_stat_statements": has_pg_stat_statements,
        "errors":                 errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  9. Config Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_config_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_config_detail", db)
    if _cached is not None:
        return _cached

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    engine = _pg_engine(rec)
    errors = []
    all_settings: dict = {}
    version_str = uptime_str = started_at = None

    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT name, setting, unit, category, short_desc, context, vartype, source,
                       min_val, max_val, enumvals, boot_val, reset_val,
                       sourcefile, sourceline, pending_restart
                FROM pg_settings
                ORDER BY name
            """)).mappings().fetchall()

            for row in rows:
                ev = row["enumvals"]
                all_settings[row["name"]] = {
                    "name":            row["name"],
                    "setting":         row["setting"],
                    "unit":            row["unit"],
                    "category":        row["category"],
                    "description":     row["short_desc"],
                    "context":         row["context"],
                    "vartype":         row["vartype"],
                    "source":          row["source"],
                    "min_val":         row["min_val"],
                    "max_val":         row["max_val"],
                    "enumvals":        list(ev) if ev else None,
                    "boot_val":        row["boot_val"],
                    "reset_val":       row["reset_val"],
                    "sourcefile":      row["sourcefile"],
                    "sourceline":      str(row["sourceline"]) if row["sourceline"] else None,
                    "pending_restart": bool(row["pending_restart"]),
                    "is_modified":     row["source"] not in ("default", "client"),
                }

            version_str = conn.execute(text("SELECT version()")).scalar()

            try:
                ui = conn.execute(text("""
                    SELECT to_char(
                               now() - pg_postmaster_start_time(),
                               'DD" days "HH24" hrs "MI" min"'
                           ) AS uptime,
                           pg_postmaster_start_time()::text AS started_at
                """)).mappings().fetchone()
                if ui:
                    uptime_str = ui["uptime"]
                    started_at = ui["started_at"]
            except Exception as e:
                errors.append(f"uptime: {e}")

    except Exception as e:
        errors.append(str(e))

    groups_result: dict = {}
    for group_name, param_names in _PARAM_GROUPS.items():
        group_params = [all_settings[n] for n in param_names if n in all_settings]
        if group_params:
            groups_result[group_name] = group_params

    modified_count        = sum(1 for s in all_settings.values() if s["is_modified"])
    pending_restart_count = sum(1 for s in all_settings.values() if s.get("pending_restart"))

    return {
        "status":                "success",
        "version":               version_str,
        "uptime":                uptime_str,
        "started_at":            started_at,
        "groups":                groups_result,
        "total_params":          len(all_settings),
        "tracked_params":        sum(len(v) for v in groups_result.values()),
        "modified_count":        modified_count,
        "pending_restart_count": pending_restart_count,
        "errors":                errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  10. Users Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_users_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_users_detail", db)
    if _cached is not None:
        return _cached

    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    try:
        engine = _pg_engine(rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    errors = []

    roles = []
    try:
        rows = _rows(engine,
            "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, "
            "rolcanlogin, rolreplication, rolbypassrls, "
            "CASE WHEN rolconnlimit < 0 THEN NULL ELSE rolconnlimit END AS rolconnlimit, "
            "rolvaliduntil::text AS rolvaliduntil, "
            "CASE WHEN rolvaliduntil IS NOT NULL AND rolvaliduntil < now() THEN true ELSE false END AS expired "
            "FROM pg_roles "
            "ORDER BY rolcanlogin DESC, rolsuper DESC, rolname"
        )
        roles = [dict(r) for r in rows]
        for r in roles:
            r["rolsuper"]       = bool(r.get("rolsuper"))
            r["rolinherit"]     = bool(r.get("rolinherit"))
            r["rolcreaterole"]  = bool(r.get("rolcreaterole"))
            r["rolcreatedb"]    = bool(r.get("rolcreatedb"))
            r["rolcanlogin"]    = bool(r.get("rolcanlogin"))
            r["rolreplication"] = bool(r.get("rolreplication"))
            r["rolbypassrls"]   = bool(r.get("rolbypassrls"))
            r["expired"]        = bool(r.get("expired"))
    except Exception as e:
        errors.append(f"roles: {e}")

    memberships = []
    try:
        rows = _rows(engine,
            "SELECT r.rolname AS role_name, m.rolname AS member_name, am.admin_option "
            "FROM pg_auth_members am "
            "JOIN pg_roles r ON r.oid = am.roleid "
            "JOIN pg_roles m ON m.oid = am.member "
            "ORDER BY r.rolname, m.rolname"
        )
        memberships = [dict(r) for r in rows]
        for m in memberships:
            m["admin_option"] = bool(m.get("admin_option"))
    except Exception as e:
        errors.append(f"memberships: {e}")

    activity = []
    try:
        rows = _rows(engine,
            "SELECT usename, datname, "
            "count(*) AS total, "
            "count(*) FILTER (WHERE state='active') AS active, "
            "count(*) FILTER (WHERE state='idle') AS idle, "
            "count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_txn, "
            "count(*) FILTER (WHERE wait_event_type='Lock') AS waiting, "
            "max(EXTRACT(EPOCH FROM (now()-backend_start))::int) AS max_conn_age_s, "
            "max(EXTRACT(EPOCH FROM (now()-query_start))::int) FILTER (WHERE state='active') AS max_query_age_s "
            "FROM pg_stat_activity "
            "WHERE usename IS NOT NULL "
            "GROUP BY usename, datname ORDER BY total DESC LIMIT 50"
        )
        activity = [dict(r) for r in rows]
        for a in activity:
            for k in ("total", "active", "idle", "idle_in_txn", "waiting"):
                a[k] = int(a.get(k) or 0)
            a["max_conn_age_s"]  = int(a.get("max_conn_age_s")  or 0)
            a["max_query_age_s"] = int(a.get("max_query_age_s") or 0)
    except Exception as e:
        errors.append(f"activity: {e}")

    conn_summary = {}
    try:
        rows = _rows(engine,
            "SELECT usename, count(*) AS cnt "
            "FROM pg_stat_activity "
            "WHERE usename IS NOT NULL "
            "GROUP BY usename"
        )
        conn_summary = {r.get("usename"): int(r.get("cnt") or 0) for r in rows}
    except Exception:
        pass

    obj_ownership = []
    try:
        rows = _rows(engine,
            "SELECT t.rolname AS owner, "
            "count(*) FILTER (WHERE c.relkind='r') AS tables, "
            "count(*) FILTER (WHERE c.relkind='v') AS views, "
            "count(*) FILTER (WHERE c.relkind='i') AS indexes, "
            "count(*) FILTER (WHERE c.relkind='S') AS sequences "
            "FROM pg_class c "
            "JOIN pg_roles t ON t.oid = c.relowner "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') "
            "GROUP BY t.rolname ORDER BY tables DESC LIMIT 20"
        )
        obj_ownership = [dict(r) for r in rows]
        for o in obj_ownership:
            for k in ("tables", "views", "indexes", "sequences"):
                o[k] = int(o.get(k) or 0)
    except Exception as e:
        errors.append(f"obj_ownership: {e}")

    total_roles     = len(roles)
    login_roles     = len([r for r in roles if r.get("rolcanlogin")])
    superuser_count = len([r for r in roles if r.get("rolsuper")])
    expired_count   = len([r for r in roles if r.get("expired")])

    return {
        "status":        "success",
        "roles":         roles,
        "memberships":   memberships,
        "activity":      activity,
        "conn_summary":  conn_summary,
        "obj_ownership": obj_ownership,
        "summary": {
            "total_roles":     total_roles,
            "login_roles":     login_roles,
            "superuser_count": superuser_count,
            "expired_count":   expired_count,
        },
        "errors": errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  11. Storage Detail
# ═════════════════════════════════════════════════════════════════════════════

def svc_storage_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "pg_storage_detail", db)
    if _cached is not None:
        return _cached

    rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    try:
        engine = _pg_engine(rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    errors = []

    db_sizes = []
    try:
        rows = _rows(engine,
            "SELECT datname, "
            "pg_database_size(oid) AS size_bytes, "
            "pg_size_pretty(pg_database_size(oid)) AS size_pretty "
            "FROM pg_database "
            "WHERE NOT datistemplate "
            "ORDER BY size_bytes DESC"
        )
        db_sizes = [dict(r) for r in rows]
        for d in db_sizes:
            d["size_bytes"] = int(d.get("size_bytes") or 0)
    except Exception as e:
        errors.append(f"db_sizes: {e}")

    tablespaces = []
    try:
        rows = _rows(engine,
            "SELECT spcname, "
            "pg_catalog.pg_get_userbyid(spcowner) AS owner, "
            "pg_tablespace_location(oid) AS location, "
            "pg_tablespace_size(oid) AS size_bytes, "
            "pg_size_pretty(pg_tablespace_size(oid)) AS size_pretty "
            "FROM pg_tablespace "
            "ORDER BY size_bytes DESC"
        )
        tablespaces = [dict(r) for r in rows]
        for t in tablespaces:
            t["size_bytes"] = int(t.get("size_bytes") or 0)
    except Exception as e:
        errors.append(f"tablespaces: {e}")

    top_tables = []
    try:
        rows = _rows(engine,
            "SELECT s.schemaname, s.relname, "
            "pg_total_relation_size(s.relid) AS total_bytes, "
            "pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size, "
            "pg_relation_size(s.relid) AS table_bytes, "
            "pg_size_pretty(pg_relation_size(s.relid)) AS table_size, "
            "pg_indexes_size(s.relid) AS index_bytes, "
            "pg_size_pretty(pg_indexes_size(s.relid)) AS index_size, "
            "s.n_live_tup, s.n_dead_tup, "
            "CASE WHEN s.n_live_tup > 0 "
            "     THEN round(s.n_dead_tup::numeric / GREATEST(s.n_live_tup, 1) * 100, 1) "
            "     ELSE 0 END AS dead_ratio, "
            "s.last_vacuum::text, s.last_autovacuum::text, "
            "s.last_analyze::text, s.last_autoanalyze::text, "
            "s.vacuum_count, s.autovacuum_count, "
            "s.analyze_count, s.autoanalyze_count, "
            "s.seq_scan, s.idx_scan, "
            "s.n_tup_ins, s.n_tup_upd, s.n_tup_del, s.n_tup_hot_upd "
            "FROM pg_stat_user_tables s "
            "ORDER BY total_bytes DESC LIMIT 50"
        )
        top_tables = [dict(r) for r in rows]
        for t in top_tables:
            for k in ("total_bytes", "table_bytes", "index_bytes", "n_live_tup", "n_dead_tup",
                      "vacuum_count", "autovacuum_count", "analyze_count", "autoanalyze_count",
                      "seq_scan", "idx_scan", "n_tup_ins", "n_tup_upd", "n_tup_del", "n_tup_hot_upd"):
                t[k] = int(t.get(k) or 0)
            t["dead_ratio"] = float(t.get("dead_ratio") or 0)
    except Exception as e:
        errors.append(f"top_tables: {e}")

    bloat_tables = sorted(
        [t for t in top_tables if t.get("dead_ratio", 0) > 5 or t.get("n_dead_tup", 0) > 1000],
        key=lambda x: x.get("n_dead_tup", 0),
        reverse=True,
    )[:20]

    vacuum_needed = []
    try:
        rows = _rows(engine,
            "SELECT s.schemaname, s.relname, "
            "s.n_live_tup, s.n_dead_tup, "
            "s.last_autovacuum::text, s.last_vacuum::text, "
            "s.autovacuum_count, "
            "EXTRACT(EPOCH FROM (now() - COALESCE(s.last_autovacuum, s.last_vacuum)))::int AS secs_since_vacuum "
            "FROM pg_stat_user_tables s "
            "WHERE (s.last_autovacuum IS NULL AND s.last_vacuum IS NULL) "
            "   OR EXTRACT(EPOCH FROM (now() - COALESCE(s.last_autovacuum, s.last_vacuum))) > 86400*7 "
            "ORDER BY s.n_dead_tup DESC LIMIT 20"
        )
        vacuum_needed = [dict(r) for r in rows]
        for v in vacuum_needed:
            v["n_live_tup"]        = int(v.get("n_live_tup")        or 0)
            v["n_dead_tup"]        = int(v.get("n_dead_tup")        or 0)
            v["autovacuum_count"]  = int(v.get("autovacuum_count")  or 0)
            v["secs_since_vacuum"] = int(v.get("secs_since_vacuum") or 0)
    except Exception as e:
        errors.append(f"vacuum_needed: {e}")

    toast_tables = []
    try:
        rows = _rows(engine,
            "SELECT n.nspname AS schemaname, c.relname AS tablename, "
            "pg_size_pretty(pg_total_relation_size(t.oid)) AS toast_size, "
            "pg_total_relation_size(t.oid) AS toast_bytes "
            "FROM pg_class c "
            "JOIN pg_class t ON t.oid = c.reltoastrelid "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind = 'r' AND t.oid IS NOT NULL "
            "  AND n.nspname NOT IN ('pg_catalog','information_schema') "
            "  AND pg_total_relation_size(t.oid) > 1024 "
            "ORDER BY toast_bytes DESC LIMIT 20"
        )
        toast_tables = [dict(r) for r in rows]
        for t in toast_tables:
            t["toast_bytes"] = int(t.get("toast_bytes") or 0)
    except Exception as e:
        errors.append(f"toast_tables: {e}")

    autovacuum_settings = {}
    try:
        rows = _rows(engine,
            "SELECT name, setting, unit, short_desc "
            "FROM pg_settings "
            "WHERE name LIKE 'autovacuum%' "
            "   OR name IN ('vacuum_cost_delay','vacuum_cost_limit','vacuum_freeze_min_age', "
            "               'vacuum_freeze_table_age','vacuum_multixact_freeze_min_age') "
            "ORDER BY name"
        )
        for r in rows:
            autovacuum_settings[r.get("name", "")] = {
                "setting": r.get("setting", ""),
                "unit":    r.get("unit",    ""),
                "desc":    r.get("short_desc", ""),
            }
    except Exception as e:
        errors.append(f"autovacuum_settings: {e}")

    total_db_bytes    = sum(d.get("size_bytes",  0) for d in db_sizes)
    total_table_bytes = sum(t.get("total_bytes", 0) for t in top_tables)
    total_index_bytes = sum(t.get("index_bytes", 0) for t in top_tables)
    total_dead_tup    = sum(t.get("n_dead_tup",  0) for t in top_tables)

    return {
        "status":              "success",
        "db_sizes":            db_sizes,
        "tablespaces":         tablespaces,
        "top_tables":          top_tables,
        "bloat_tables":        bloat_tables,
        "vacuum_needed":       vacuum_needed,
        "toast_tables":        toast_tables,
        "autovacuum_settings": autovacuum_settings,
        "summary": {
            "total_db_bytes":    total_db_bytes,
            "total_table_bytes": total_table_bytes,
            "total_index_bytes": total_index_bytes,
            "total_dead_tup":    total_dead_tup,
            "bloat_count":       len(bloat_tables),
            "vacuum_needed":     len(vacuum_needed),
        },
        "errors": errors,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  12. Analyze Slow Query — Groq LLM
# ═════════════════════════════════════════════════════════════════════════════

def svc_analyze_slow_query_groq(conn_id: int, payload: PgSlowQueryGroqRequest, db: Session):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    try:
        from groq import Groq
        groq_client = Groq(api_key=os.getenv("GROQ_API_KEY", ""))

        explain_text = json.dumps(payload.explain_rows, indent=2) if payload.explain_rows else "Not run yet"

        prompt = f"""You are a world-class PostgreSQL DBA expert. Analyze this slow query deeply and return ONLY valid JSON — no markdown, no code blocks.

=== QUERY CONTEXT ===
Host: {rec.host}:{rec.port}
Database: {rec.database_name or 'unknown'}
PostgreSQL User: {payload.user_name or 'unknown'}
SQL: {payload.sql_text}

=== PERFORMANCE METRICS ===
Execution Count: {payload.calls:,}
Average Execution Time: {payload.mean_exec_time_ms:.2f} ms
Maximum Execution Time: {payload.max_exec_time_ms:.2f} ms
Total Cumulative Time: {payload.total_exec_time_ms:.2f} ms
Rows Returned: {payload.rows:,}
Shared Blocks Hit (cache): {payload.shared_blks_hit:,}
Shared Blocks Read (disk): {payload.shared_blks_read:,}
Cache Hit Rate: {payload.cache_hit_pct:.1f}%

=== EXPLAIN ANALYZE OUTPUT ===
{explain_text}

Return this exact JSON structure:
{{
  "severity": "critical|high|medium|low",
  "severity_reason": "why this severity was assigned",
  "summary": "one-sentence description of what the query does and why it is slow",
  "root_cause": "detailed root cause — what exactly is making this query slow",
  "issues": [
    {{
      "type": "SEQ_SCAN|MISSING_INDEX|INEFFICIENT_JOIN|SORT_SPILL|HIGH_DISK_READ|TEMP_TABLE|N_PLUS_1|LOCK_CONTENTION|LARGE_RESULT_SET|OTHER",
      "table": "affected table name or null",
      "description": "detailed description of the issue",
      "severity": "critical|high|medium|low",
      "evidence": "exact value from EXPLAIN or metrics that proves this issue"
    }}
  ],
  "index_recommendations": [
    {{
      "table": "table_name",
      "columns": ["col1", "col2"],
      "index_type": "BTREE|GIN|GIST|HASH|BRIN",
      "create_sql": "CREATE INDEX CONCURRENTLY idx_name ON table_name (col1, col2);",
      "reason": "why this specific index will help",
      "estimated_improvement": "e.g. eliminates sequential scan, 99% row reduction"
    }}
  ],
  "query_rewrite": {{
    "applicable": true,
    "optimized_sql": "rewritten query or empty string if not applicable",
    "changes_made": ["list", "of", "changes"],
    "explanation": "what was changed and why it will be faster",
    "expected_gain": "e.g. 10x-50x faster"
  }},
  "schema_suggestions": [
    "Any table design or schema changes that would help"
  ],
  "priority_actions": [
    "1. Most impactful thing to do first",
    "2. Second action",
    "3. Third action"
  ],
  "business_impact": "impact on application performance and end users",
  "estimated_overall_improvement": "overall expected improvement after all fixes",
  "validation_queries": [
    "SQL query to verify the optimization worked"
  ]
}}"""

        response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=3000,
        )

        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
        analysis = json.loads(raw.strip())
        return {"status": "success", "analysis": analysis}

    except Exception as e:
        return {"status": "error", "error": str(e)}


# ═════════════════════════════════════════════════════════════════════════════
#  13. Explain Analyze
# ═════════════════════════════════════════════════════════════════════════════

def svc_explain_analyze(conn_id: int, payload: PgExplainRequest, db: Session):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    try:
        engine = _pg_engine(rec)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    sql_clean = re.sub(r'\$\d+', 'NULL', payload.sql_text.strip())

    _explain_re = re.compile(
        r'^EXPLAIN\s*(?:\(\s*[^)]*\))?\s*',
        re.IGNORECASE | re.DOTALL
    )
    inner = _explain_re.sub('', sql_clean).strip()
    if inner and inner.upper() != sql_clean.upper():
        sql_clean = inner

    plan_json = None
    analyzed  = False
    used_db   = payload.database or rec.database_name or "postgres"

    def _run_explain(conn, analyze: bool):
        opts = "ANALYZE, BUFFERS, FORMAT JSON" if analyze else "FORMAT JSON"
        if analyze:
            conn.execute(text("SET LOCAL statement_timeout = '6s'"))
        row = conn.execute(text(f"EXPLAIN ({opts}) {sql_clean}")).fetchone()
        return row[0]

    def _try_explain(eng, with_analyze: bool) -> bool:
        nonlocal plan_json, analyzed
        try:
            with eng.connect() as conn:
                plan_json = _run_explain(conn, analyze=with_analyze)
                analyzed = with_analyze
                return True
        except Exception:
            return False

    dbs_to_try: list = []
    if payload.database:
        dbs_to_try.append(payload.database)

    try:
        with engine.connect() as conn:
            original_prefix = payload.sql_text.strip()[:80].replace("%", "%%")
            rows_db = conn.execute(text(
                "SELECT DISTINCT d.datname FROM pg_stat_statements s "
                "JOIN pg_database d ON d.oid = s.dbid "
                "WHERE s.query LIKE :prefix "
                "ORDER BY d.datname LIMIT 5"
            ), {"prefix": original_prefix + "%"}).fetchall()
            for r in rows_db:
                if r[0] not in dbs_to_try:
                    dbs_to_try.append(r[0])
    except Exception:
        pass

    default_db = rec.database_name or "postgres"
    if default_db not in dbs_to_try:
        dbs_to_try.append(default_db)

    for db_name in dbs_to_try:
        eng = _pg_engine_db(rec, db_name) if db_name != default_db else engine
        if _try_explain(eng, True) or _try_explain(eng, False):
            used_db = db_name
            break

    if plan_json is None:
        tried = ", ".join(f"'{d}'" for d in dbs_to_try)
        return {
            "status": "error",
            "error": (
                f"EXPLAIN could not run in any of the tried databases ({tried}).\n\n"
                "The query references tables that aren't accessible from this connection. "
                "Possible reasons:\n"
                "• The tables were in a database this user cannot connect to\n"
                "• The tables have been dropped since the query was recorded\n"
                "• A schema search_path mismatch (table exists but isn't visible)\n\n"
                "Fix: In ActMon, edit connection settings and set the Database field to "
                "the exact database where this query runs."
            ),
            "tried_databases": dbs_to_try,
        }

    try:
        if isinstance(plan_json, str):
            plan_json = json.loads(plan_json)

        top            = plan_json[0] if isinstance(plan_json, list) else plan_json
        plan_node      = top.get("Plan", top)
        planning_time  = top.get("Planning Time", 0)
        execution_time = top.get("Execution Time", 0)

        nodes = _flatten_plan(plan_node)
        hints = _pg_explain_hints(nodes, planning_time, execution_time)

        return {
            "status":         "success",
            "analyzed":       analyzed,
            "planning_time":  planning_time,
            "execution_time": execution_time,
            "nodes":          nodes,
            "hints":          hints,
            "raw":            plan_json,
            "used_db":        used_db,
            "inner_sql":      sql_clean,
        }

    except Exception as e:
        return {"status": "error", "error": str(e)[:300]}


# ═════════════════════════════════════════════════════════════════════════════
#  14. PG Error Logs
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_error_logs(conn_id: int, db: Session, limit: int = 300):
    try:
        conn_rec = db.query(ConnectionMaster).filter(
            ConnectionMaster.id == conn_id,
            ConnectionMaster.db_type == "postgresql"
        ).first()
        if not conn_rec:
            raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
        try:
            engine = _pg_engine(conn_rec)
        except Exception as e:
            return {"status": "error", "error": f"Cannot build engine: {e}", "logs": [],
                    "counts": {}, "db_stats": {}, "total": 0, "source": "none", "note": ""}
    except HTTPException:
        raise
    except Exception as e:
        return {"status": "error", "error": str(e)[:300], "logs": [],
                "counts": {}, "db_stats": {}, "total": 0, "source": "none", "note": ""}

    def _classify(sev: str) -> str:
        s = (sev or "").upper()
        if s in ("FATAL", "PANIC"):   return "FATAL"
        if s == "ERROR":              return "ERROR"
        if s in ("WARNING", "WARN"):  return "WARNING"
        if s == "LOG":                return "LOG"
        if s in ("INFO", "NOTICE"):   return "INFO"
        if s == "DEBUG":              return "DEBUG"
        return "LOG"

    CSV_COLS_BASE = [
        "log_time", "user_name", "database_name", "process_id", "connection_from",
        "session_id", "session_line_num", "command_tag", "session_start_time",
        "virtual_transaction_id", "transaction_id", "error_severity", "sql_state_code",
        "message", "detail", "hint", "internal_query", "internal_query_pos",
        "context", "query", "query_pos", "location", "application_name",
    ]
    CSV_COLS_EXT = CSV_COLS_BASE + ["backend_type", "leader_pid", "query_id"]

    def _parse_csv_content(content: str) -> list:
        entries = []
        try:
            reader = csv.reader(io.StringIO(content))
            for row in reader:
                try:
                    cols = CSV_COLS_EXT if len(row) >= 26 else CSV_COLS_BASE
                    rec  = dict(zip(cols, row))
                    sev  = _classify(rec.get("error_severity", ""))
                    entries.append({
                        "timestamp":    rec.get("log_time", ""),
                        "severity":     sev,
                        "raw_severity": rec.get("error_severity", ""),
                        "database":     rec.get("database_name", ""),
                        "user":         rec.get("user_name", ""),
                        "pid":          rec.get("process_id", ""),
                        "sql_state":    rec.get("sql_state_code", ""),
                        "message":      rec.get("message", ""),
                        "detail":       rec.get("detail", ""),
                        "hint":         rec.get("hint", ""),
                        "query":        rec.get("query", "") or rec.get("internal_query", ""),
                        "context":      rec.get("context", ""),
                        "location":     rec.get("location", ""),
                        "command_tag":  rec.get("command_tag", ""),
                        "application":  rec.get("application_name", ""),
                        "session_id":   rec.get("session_id", ""),
                    })
                except Exception:
                    pass
        except Exception:
            pass
        return entries

    def _parse_stderr_content(content: str) -> list:
        pat = re.compile(
            r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \w+)\s+'
            r'\[(\d+)\]\s+'
            r'(FATAL|PANIC|ERROR|WARNING|LOG|INFO|NOTICE|DEBUG|DETAIL):\s+(.*)',
            re.MULTILINE
        )
        entries = []
        for m in pat.finditer(content):
            sev = _classify(m.group(3))
            entries.append({
                "timestamp": m.group(1),
                "severity":  sev,
                "raw_severity": m.group(3),
                "pid":       m.group(2),
                "message":   m.group(4),
                "database": "", "user": "", "sql_state": "",
                "detail": "", "hint": "", "query": "",
                "context": "", "location": "", "command_tag": "",
                "application": "", "session_id": "",
            })
        return entries

    log_path = ""
    source   = "none"
    logs     = []
    note     = ""

    # Method 1 — direct filesystem read
    try:
        with engine.connect() as c:
            data_dir_row = c.execute(text("SHOW data_directory")).fetchone()
            log_dir_row  = c.execute(text("SHOW log_directory")).fetchone()
            data_dir = (data_dir_row[0] if data_dir_row else "").replace("/", os.sep)
            log_dir  = (log_dir_row[0]  if log_dir_row  else "log").replace("/", os.sep)

        if os.path.isabs(log_dir):
            full_log_dir = log_dir
        else:
            full_log_dir = os.path.join(data_dir, log_dir)

        if os.path.isdir(full_log_dir):
            csv_files = sorted(
                [f for f in os.listdir(full_log_dir) if f.endswith(".csv")],
                reverse=True
            )
            if not csv_files:
                log_files = sorted(
                    [f for f in os.listdir(full_log_dir) if f.endswith(".log")],
                    reverse=True
                )
                chosen_file = log_files[0] if log_files else None
                is_csv = False
            else:
                chosen_file = csv_files[0]
                is_csv = True

            if chosen_file:
                full_path = os.path.join(full_log_dir, chosen_file)
                log_path  = full_path
                with open(full_path, "rb") as fh:
                    fh.seek(0, 2)
                    fsize = fh.tell()
                    read_size = min(fsize, 1_048_576)
                    fh.seek(max(0, fsize - read_size))
                    raw_bytes = fh.read()
                content = raw_bytes.decode("utf-8", errors="replace")
                if fsize > read_size:
                    nl = content.find("\n")
                    if nl != -1:
                        content = content[nl + 1:]
                if is_csv:
                    logs   = _parse_csv_content(content)
                    source = "csv_log"
                else:
                    logs   = _parse_stderr_content(content)
                    source = "stderr_log"
        else:
            note = f"Log directory not accessible from backend: {full_log_dir}"
    except Exception as e:
        note = f"Filesystem read failed: {str(e)[:300]}"

    # Method 2 — pg_ls_logdir() + pg_read_file()
    if not logs:
        try:
            with engine.connect() as c:
                try:
                    file_rows = c.execute(text("""
                        SELECT name, size, modification
                        FROM pg_ls_logdir()
                        ORDER BY modification DESC
                        LIMIT 10
                    """)).fetchall()
                except Exception as e:
                    file_rows = []
                    note = (note + " | pg_ls_logdir: " + str(e)[:200]).strip(" | ")

                chosen = None
                is_csv = False
                for fr in file_rows:
                    if fr[0].endswith(".csv"):
                        chosen = fr; is_csv = True; break
                if not chosen:
                    for fr in file_rows:
                        if fr[0].endswith((".log", ".txt")):
                            chosen = fr; break
                if not chosen and file_rows:
                    chosen = file_rows[0]

                if chosen:
                    fname     = chosen[0]
                    fsize     = chosen[1] or 0
                    log_path  = f"log/{fname}"
                    read_size = min(fsize, 786432)
                    offset    = max(0, fsize - read_size)
                    try:
                        row = c.execute(
                            text("SELECT pg_read_file(:p, :off, :sz)"),
                            {"p": log_path, "off": int(offset), "sz": int(read_size)}
                        ).fetchone()
                        content = row[0] if row else ""
                        if is_csv:
                            logs   = _parse_csv_content(content)
                            source = "csv_log"
                        else:
                            logs   = _parse_stderr_content(content)
                            source = "stderr_log"
                    except Exception as e:
                        note = (note + " | pg_read_file: " + str(e)[:200]).strip(" | ")
        except Exception as e:
            note = (note + " | SQL log access: " + str(e)[:200]).strip(" | ")

    # Method 3 — pg_stat_activity fallback
    if not logs:
        source = "pg_stat_activity"
        try:
            with engine.connect() as c:
                rows = c.execute(text("""
                    SELECT
                        now()                               AS log_time,
                        usename                             AS user_name,
                        datname                             AS database_name,
                        pid                                 AS process_id,
                        client_addr::text                   AS connection_from,
                        application_name,
                        state,
                        wait_event_type,
                        wait_event,
                        query_start,
                        state_change,
                        query
                    FROM pg_stat_activity
                    WHERE state IS NOT NULL
                      AND state != 'idle'
                    ORDER BY query_start DESC NULLS LAST
                    LIMIT :lim
                """), {"lim": limit}).fetchall()

                for r in rows:
                    d   = dict(r._mapping)
                    msg = d.get("query") or ""
                    sev = "ERROR"   if d.get("wait_event_type") == "Lock" else \
                          "WARNING" if d.get("wait_event_type") else "LOG"
                    logs.append({
                        "timestamp":    str(d.get("log_time", ""))[:23],
                        "severity":     sev,
                        "raw_severity": sev,
                        "database":     d.get("database_name", "") or "",
                        "user":         d.get("user_name", "") or "",
                        "pid":          str(d.get("process_id", "") or ""),
                        "sql_state":    "",
                        "message":      f"[{d.get('state','').upper()}] {msg[:200]}",
                        "detail":       f"wait_event={d.get('wait_event_type')}/{d.get('wait_event')}",
                        "hint":         "",
                        "query":        msg,
                        "context":      "",
                        "location":     "",
                        "command_tag":  "",
                        "application":  d.get("application_name", "") or "",
                        "session_id":   "",
                    })
        except Exception as e:
            note = (note + " | pg_stat_activity: " + str(e)[:200]).strip(" | ")

    # pg_stat_database stats
    db_stats = {}
    try:
        with engine.connect() as c:
            row = c.execute(text("""
                SELECT datname, numbackends, xact_commit, xact_rollback,
                       deadlocks, checksum_failures
                FROM pg_stat_database
                WHERE datname = current_database()
            """)).fetchone()
            if row:
                m = dict(row._mapping)
                db_stats = {
                    "datname":           str(m.get("datname") or ""),
                    "numbackends":       int(m.get("numbackends") or 0),
                    "xact_commit":       int(m.get("xact_commit") or 0),
                    "xact_rollback":     int(m.get("xact_rollback") or 0),
                    "deadlocks":         int(m.get("deadlocks") or 0),
                    "checksum_failures": int(m.get("checksum_failures") or 0),
                }
    except Exception:
        db_stats = {}

    logs = [l for l in logs if l.get("message")]
    logs.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    logs = logs[:limit]

    counts = {sev: sum(1 for l in logs if l["severity"] == sev)
              for sev in ["FATAL", "ERROR", "WARNING", "LOG", "INFO", "DEBUG"]}

    return {
        "status":   "success",
        "source":   source,
        "log_path": str(log_path),
        "note":     note,
        "logs":     logs,
        "counts":   counts,
        "db_stats": db_stats,
        "total":    len(logs),
    }


# ═════════════════════════════════════════════════════════════════════════════
#  15. AI Analyze Error — Groq
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_analyze_error(conn_id: int, payload: ErrorAnalysisRequest, db: Session):
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        from groq import Groq
    except ImportError:
        return {"status": "error",
                "error": "Groq library not installed. Run: pip install groq"}

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        return {"status": "error",
                "error": "GROQ_API_KEY environment variable is not set on the backend server."}

    ctx_lines = [
        "PostgreSQL 17 Error Log Entry",
        "=" * 40,
        f"Severity    : {payload.severity or 'UNKNOWN'}",
        f"SQL State   : {payload.sql_state or 'N/A'}",
        f"Database    : {payload.database or 'N/A'}",
        f"User        : {payload.user or 'N/A'}",
        f"Application : {payload.application or 'N/A'}",
        f"PID         : {payload.pid or 'N/A'}",
        "",
        f"Message: {payload.message}",
    ]
    if payload.detail:   ctx_lines.append(f"Detail : {payload.detail}")
    if payload.hint:     ctx_lines.append(f"Hint   : {payload.hint}")
    if payload.context:  ctx_lines.append(f"Context: {payload.context}")
    if payload.location: ctx_lines.append(f"Location: {payload.location}")
    if payload.query:    ctx_lines += ["", "SQL Query that caused the error:", payload.query[:1500]]
    error_context = "\n".join(ctx_lines)

    system_prompt = """You are an expert PostgreSQL 17 DBA analyst embedded in ActMon — an enterprise database monitoring platform.

Analyze the PostgreSQL error log entry and return ONLY a valid JSON object with this exact structure:
{
  "what": "1-2 clear sentences explaining what this error means in plain terms",
  "root_cause": "Specific technical explanation of WHY this error occurred (3-5 sentences, mention relevant PostgreSQL internals)",
  "immediate_fix": "Numbered step-by-step actions to resolve this error right now",
  "sql_fix": "Exact SQL commands or postgresql.conf changes to fix it — null if not applicable",
  "prevention": "How to prevent this error from recurring in future (specific settings, code changes, design patterns)",
  "severity_note": "Business impact assessment: data risk, performance impact, urgency level",
  "related_errors": "Other PostgreSQL errors or issues this commonly triggers or is related to"
}

Rules:
- Be specific and technical — this is for experienced DBAs
- Reference PostgreSQL 17 features/views when relevant
- For SQL fix, use proper PostgreSQL 17 syntax
- If the query in the log reveals a design issue, mention it
- Urgency: CRITICAL (data loss risk / crash), HIGH (service degradation), MEDIUM (performance), LOW (informational)
- Return ONLY the JSON object, no markdown, no explanation outside JSON"""

    try:
        client = Groq(api_key=api_key)
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": error_context},
            ],
            max_tokens=1800,
            temperature=0.25,
            response_format={"type": "json_object"},
        )
        raw      = resp.choices[0].message.content or "{}"
        analysis = json.loads(raw)
        return {"status": "success", "analysis": analysis}

    except json.JSONDecodeError:
        return {
            "status": "success",
            "analysis": {
                "what":           raw[:800] if raw else "Analysis failed",
                "root_cause":     "",
                "immediate_fix":  "",
                "sql_fix":        None,
                "prevention":     "",
                "severity_note":  "",
                "related_errors": "",
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)[:400]}


# ═════════════════════════════════════════════════════════════════════════════
#  16. WAL Statistics
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_wal_stats(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)
    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_wal")
        if not rows:
            return {"status": "success", "wal": {}, "note": "pg_stat_wal returned no rows"}
        w = rows[0]
        wal = {
            "wal_records":      int(w.get("wal_records") or 0),
            "wal_fpi":          int(w.get("wal_fpi") or 0),
            "wal_bytes":        int(w.get("wal_bytes") or 0),
            "wal_bytes_mb":     round(int(w.get("wal_bytes") or 0) / (1024 * 1024), 3),
            "wal_buffers_full": int(w.get("wal_buffers_full") or 0),
            "wal_write":        int(w.get("wal_write") or 0),
            "wal_sync":         int(w.get("wal_sync") or 0),
            "wal_write_time":   float(w.get("wal_write_time") or 0),
            "wal_sync_time":    float(w.get("wal_sync_time") or 0),
            "stats_reset":      str(w.get("stats_reset") or ""),
        }
        try:
            lsn_row = _rows(engine,
                "SELECT pg_current_wal_lsn()::text AS lsn, "
                "pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS lsn_bytes")
            if lsn_row:
                wal["current_lsn"]     = lsn_row[0].get("lsn", "")
                wal["lsn_bytes_total"] = int(lsn_row[0].get("lsn_bytes") or 0)
        except Exception:
            pass
        for var in ("wal_level", "wal_buffers", "max_wal_size", "min_wal_size",
                    "wal_compression", "wal_log_hints", "synchronous_commit",
                    "wal_writer_delay", "wal_writer_flush_after"):
            try:
                wal[f"cfg_{var}"] = _val(engine, f"SHOW {var}")
            except Exception:
                pass
        return {"status": "success", "wal": wal}
    except Exception as e:
        return {"status": "error", "error": str(e)[:300], "wal": {}}


# ═════════════════════════════════════════════════════════════════════════════
#  17. Checkpoint Statistics
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_checkpoint_stats(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)
    result = {}
    source = "unknown"

    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_checkpointer")
        if rows:
            cp = rows[0]
            result = {
                "num_timed":               int(cp.get("num_timed") or 0),
                "num_requested":           int(cp.get("num_requested") or 0),
                "num_done":                int(cp.get("num_done") or 0),
                "restartpoints_timed":     int(cp.get("restartpoints_timed") or 0),
                "restartpoints_requested": int(cp.get("restartpoints_requested") or 0),
                "restartpoints_done":      int(cp.get("restartpoints_done") or 0),
                "write_time":              float(cp.get("write_time") or 0),
                "sync_time":               float(cp.get("sync_time") or 0),
                "buffers_written":         int(cp.get("buffers_written") or 0),
                "stats_reset":             str(cp.get("stats_reset") or ""),
            }
            source = "pg_stat_checkpointer"
    except Exception:
        pass

    if not result:
        try:
            rows = _rows(engine, "SELECT * FROM pg_stat_bgwriter")
            if rows:
                bg = rows[0]
                result = {
                    "num_timed":       int(bg.get("checkpoints_timed") or 0),
                    "num_requested":   int(bg.get("checkpoints_req") or 0),
                    "write_time":      float(bg.get("checkpoint_write_time") or 0),
                    "sync_time":       float(bg.get("checkpoint_sync_time") or 0),
                    "buffers_written": int(bg.get("buffers_checkpoint") or 0),
                    "stats_reset":     str(bg.get("stats_reset") or ""),
                }
                source = "pg_stat_bgwriter"
        except Exception as e:
            return {"status": "error", "error": str(e)[:300], "checkpoints": {}, "source": source}

    bgwriter = {}
    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_bgwriter")
        if rows:
            bg = rows[0]
            bgwriter = {
                "buffers_clean":    int(bg.get("buffers_clean") or 0),
                "maxwritten_clean": int(bg.get("maxwritten_clean") or 0),
                "buffers_backend":  int(bg.get("buffers_backend") or 0),
                "buffers_alloc":    int(bg.get("buffers_alloc") or 0),
                "stats_reset":      str(bg.get("stats_reset") or ""),
            }
    except Exception:
        pass

    cfg = {}
    for var in ("checkpoint_completion_target", "checkpoint_timeout",
                "checkpoint_warning", "max_wal_size"):
        try:
            cfg[var] = _val(engine, f"SHOW {var}")
        except Exception:
            pass

    return {
        "status":      "success",
        "source":      source,
        "checkpoints": result,
        "bgwriter":    bgwriter,
        "config":      cfg,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  18. Session Details
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_session_details(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)
    try:
        sessions = _rows(engine, """
            SELECT
                pid,
                usename,
                datname,
                application_name,
                client_addr::text           AS client_addr,
                client_hostname,
                client_port,
                backend_start::text         AS backend_start,
                xact_start::text            AS xact_start,
                query_start::text           AS query_start,
                state_change::text          AS state_change,
                wait_event_type,
                wait_event,
                state,
                backend_xid::text           AS backend_xid,
                backend_xmin::text          AS backend_xmin,
                query_id::text              AS query_id,
                left(query, 500)            AS query,
                backend_type,
                EXTRACT(EPOCH FROM (now() - query_start))::int   AS query_age_sec,
                EXTRACT(EPOCH FROM (now() - xact_start))::int    AS xact_age_sec,
                EXTRACT(EPOCH FROM (now() - backend_start))::int AS backend_age_sec
            FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
            ORDER BY query_start DESC NULLS LAST
        """)
        sessions = [dict(s) for s in sessions]
        for s in sessions:
            s["query_age_sec"]   = int(s.get("query_age_sec")   or 0)
            s["xact_age_sec"]    = int(s.get("xact_age_sec")    or 0)
            s["backend_age_sec"] = int(s.get("backend_age_sec") or 0)

        summary = {
            "total":        len(sessions),
            "active":       sum(1 for s in sessions if s.get("state") == "active"),
            "idle":         sum(1 for s in sessions if s.get("state") == "idle"),
            "idle_in_tx":   sum(1 for s in sessions if (s.get("state") or "").startswith("idle in transaction")),
            "waiting":      sum(1 for s in sessions if s.get("wait_event_type") == "Lock"),
            "client":       sum(1 for s in sessions if s.get("backend_type") == "client backend"),
            "background":   sum(1 for s in sessions if s.get("backend_type") != "client backend"),
            "long_running": sum(1 for s in sessions if int(s.get("query_age_sec") or 0) > 60),
        }

        blockers = []
        try:
            blockers = _rows(engine, """
                SELECT
                    blocked.pid        AS blocked_pid,
                    blocked.usename    AS blocked_user,
                    blocked.query      AS blocked_query,
                    blocker.pid        AS blocking_pid,
                    blocker.usename    AS blocking_user,
                    blocker.query      AS blocking_query,
                    bl.mode            AS lock_mode,
                    EXTRACT(EPOCH FROM (now() - blocked.query_start))::int AS wait_sec
                FROM pg_stat_activity blocked
                JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
                JOIN pg_locks gl ON gl.locktype = bl.locktype
                    AND gl.relation IS NOT DISTINCT FROM bl.relation
                    AND gl.granted
                JOIN pg_stat_activity blocker ON blocker.pid = gl.pid
                ORDER BY wait_sec DESC
            """)
            blockers = [dict(b) for b in blockers]
            for b in blockers:
                b["wait_sec"] = int(b.get("wait_sec") or 0)
        except Exception:
            pass

        return {
            "status":   "success",
            "sessions": sessions,
            "summary":  summary,
            "blockers": blockers,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)[:300], "sessions": [], "summary": {}}


# ═════════════════════════════════════════════════════════════════════════════
#  19. Replication Detail (PG17 extended)
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_replication_detail(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)

    is_recovery = False
    try:
        is_recovery = bool(_val(engine, "SELECT pg_is_in_recovery()"))
    except Exception:
        pass

    standbys = []
    try:
        standbys = _rows(engine, """
            SELECT
                pid::text, usename, application_name,
                client_addr::text  AS client_addr,
                state,
                sent_lsn::text     AS sent_lsn,
                write_lsn::text    AS write_lsn,
                flush_lsn::text    AS flush_lsn,
                replay_lsn::text   AS replay_lsn,
                write_lag::text    AS write_lag,
                flush_lag::text    AS flush_lag,
                replay_lag::text   AS replay_lag,
                sync_state,
                sync_priority,
                reply_time::text   AS reply_time,
                pg_wal_lsn_diff(sent_lsn, replay_lsn)::bigint AS lag_bytes
            FROM pg_stat_replication
            ORDER BY lag_bytes DESC NULLS LAST
        """)
        standbys = [dict(s) for s in standbys]
        for s in standbys:
            s["lag_bytes"] = int(s.get("lag_bytes") or 0)
            s["lag_mb"]    = round(s["lag_bytes"] / (1024 * 1024), 3)
    except Exception:
        pass

    slots = []
    try:
        slots = _rows(engine, """
            SELECT
                slot_name, plugin, slot_type, database,
                active, active_pid,
                xmin::text AS xmin, catalog_xmin::text AS catalog_xmin,
                restart_lsn::text AS restart_lsn,
                confirmed_flush_lsn::text AS confirmed_flush_lsn,
                wal_status, safe_wal_size, two_phase,
                pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint AS lag_bytes
            FROM pg_replication_slots
            ORDER BY active DESC, slot_name
        """)
        slots = [dict(s) for s in slots]
        for s in slots:
            s["active"]    = bool(s.get("active"))
            s["lag_bytes"] = int(s.get("lag_bytes") or 0)
            s["lag_mb"]    = round(s["lag_bytes"] / (1024 * 1024), 3)
    except Exception:
        pass

    archiver = {}
    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_archiver")
        if rows:
            a = rows[0]
            archiver = {
                "archived_count":    int(a.get("archived_count") or 0),
                "last_archived_wal": str(a.get("last_archived_wal") or ""),
                "last_archived_time":str(a.get("last_archived_time") or ""),
                "failed_count":      int(a.get("failed_count") or 0),
                "last_failed_wal":   str(a.get("last_failed_wal") or ""),
                "last_failed_time":  str(a.get("last_failed_time") or ""),
                "stats_reset":       str(a.get("stats_reset") or ""),
            }
    except Exception:
        pass

    wal_summary = {}
    try:
        rows = _rows(engine, "SELECT * FROM pg_stat_wal")
        if rows:
            w = rows[0]
            wal_summary = {
                "wal_bytes_mb":   round(int(w.get("wal_bytes") or 0) / (1024 * 1024), 3),
                "wal_records":    int(w.get("wal_records") or 0),
                "wal_write":      int(w.get("wal_write") or 0),
                "wal_sync":       int(w.get("wal_sync") or 0),
                "wal_write_time": float(w.get("wal_write_time") or 0),
                "wal_sync_time":  float(w.get("wal_sync_time") or 0),
            }
    except Exception:
        pass

    return {
        "status":      "success",
        "is_primary":  not is_recovery,
        "is_recovery": is_recovery,
        "standbys":    standbys,
        "slots":       slots,
        "archiver":    archiver,
        "wal":         wal_summary,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  20. SLRU Cache Statistics
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_slru_stats(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)
    try:
        rows = _rows(engine, """
            SELECT
                name,
                blks_zeroed,
                blks_hit,
                blks_read,
                blks_written,
                blks_exists,
                flushes,
                truncates,
                stats_reset::text AS stats_reset
            FROM pg_stat_slru
            ORDER BY blks_hit + blks_read DESC
        """)
        slru = [dict(r) for r in rows]
        for s in slru:
            total    = int(s.get("blks_hit") or 0) + int(s.get("blks_read") or 0)
            s["hit_pct"] = round(int(s.get("blks_hit") or 0) / total * 100, 2) if total > 0 else 0.0
        return {"status": "success", "slru": slru}
    except Exception as e:
        return {"status": "error", "error": str(e)[:300], "slru": []}


# ═════════════════════════════════════════════════════════════════════════════
#  21. SSL Statistics
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_ssl_stats(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)
    try:
        rows = _rows(engine, """
            SELECT
                s.pid,
                s.ssl,
                s.version,
                s.cipher,
                s.bits,
                s.client_dn,
                s.client_serial::text AS client_serial,
                s.issuer_dn,
                a.usename,
                a.datname,
                a.application_name,
                a.client_addr::text AS client_addr,
                a.state
            FROM pg_stat_ssl s
            JOIN pg_stat_activity a ON s.pid = a.pid
            ORDER BY s.ssl DESC, a.usename
        """)
        conns         = [dict(r) for r in rows]
        ssl_count     = sum(1 for c in conns if c.get("ssl"))
        non_ssl_count = sum(1 for c in conns if not c.get("ssl"))
        ciphers: dict = {}
        for c in conns:
            if c.get("ssl") and c.get("cipher"):
                ciphers[c["cipher"]] = ciphers.get(c["cipher"], 0) + 1
        return {
            "status":        "success",
            "connections":   conns,
            "ssl_count":     ssl_count,
            "non_ssl_count": non_ssl_count,
            "ciphers":       ciphers,
        }
    except Exception as e:
        return {"status": "error", "error": str(e)[:300], "connections": []}


# ═════════════════════════════════════════════════════════════════════════════
#  22. Query Analytics
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_query_analytics(conn_id: int, db: Session, sort: str = "mean_exec_time", limit: int = 100):
    conn_rec, engine = _pg_conn(conn_id, db)
    # Read pg_stat_statements (cluster-wide) from whichever DB actually has the view.
    _pgss_eng, _ = _pgss_engine(conn_rec)
    if _pgss_eng is not None:
        engine = _pgss_eng

    valid_sorts = {
        "mean_exec_time":  "mean_exec_time DESC",
        "total_exec_time": "total_exec_time DESC",
        "calls":           "calls DESC",
        "rows":            "rows DESC",
        "blks":            "(shared_blks_hit + shared_blks_read) DESC",
        "stddev":          "stddev_exec_time DESC",
    }
    order_clause = valid_sorts.get(sort, "mean_exec_time DESC")

    try:
        rows = _rows(engine, f"""
            SELECT
                queryid::text               AS query_id,
                userid::regrole::text       AS username,
                dbid::text                  AS db_oid,
                query,
                calls,
                total_exec_time,
                min_exec_time,
                max_exec_time,
                mean_exec_time,
                stddev_exec_time,
                rows,
                shared_blks_hit,
                shared_blks_read,
                shared_blks_dirtied,
                shared_blks_written,
                local_blks_hit,
                local_blks_read,
                temp_blks_read,
                temp_blks_written,
                blk_read_time,
                blk_write_time,
                wal_records,
                wal_fpi,
                wal_bytes,
                plans,
                total_plan_time,
                mean_plan_time
            FROM pg_stat_statements
            WHERE query NOT LIKE '%pg_stat_statements%'
              AND calls > 0
            ORDER BY {order_clause}
            LIMIT :lim
        """, {"lim": limit})

        statements = [dict(r) for r in rows]
        for s in statements:
            s["calls"]            = int(s.get("calls") or 0)
            s["rows"]             = int(s.get("rows") or 0)
            s["total_exec_time"]  = round(float(s.get("total_exec_time") or 0), 3)
            s["mean_exec_time"]   = round(float(s.get("mean_exec_time") or 0), 3)
            s["max_exec_time"]    = round(float(s.get("max_exec_time") or 0), 3)
            s["min_exec_time"]    = round(float(s.get("min_exec_time") or 0), 3)
            s["stddev_exec_time"] = round(float(s.get("stddev_exec_time") or 0), 3)
            s["shared_blks_hit"]  = int(s.get("shared_blks_hit") or 0)
            s["shared_blks_read"] = int(s.get("shared_blks_read") or 0)
            s["wal_bytes"]        = int(s.get("wal_bytes") or 0)
            s["plans"]            = int(s.get("plans") or 0)
            s["total_plan_time"]  = round(float(s.get("total_plan_time") or 0), 3)
            blks = s["shared_blks_hit"] + s["shared_blks_read"]
            s["cache_hit_pct"] = round(s["shared_blks_hit"] / blks * 100, 2) if blks > 0 else 0.0

        total_calls = sum(s["calls"] for s in statements)
        total_time  = sum(s["total_exec_time"] for s in statements)
        return {
            "status":        "success",
            "sort":          sort,
            "statements":    statements,
            "total_queries": len(statements),
            "summary": {
                "total_calls":        total_calls,
                "total_exec_time_ms": round(total_time, 2),
                "avg_exec_time_ms":   round(total_time / total_calls, 3) if total_calls > 0 else 0,
                "unique_queries":     len(set(s.get("query_id", "") for s in statements)),
            },
        }
    except Exception as e:
        note = str(e)
        if "pg_stat_statements" in note and "does not exist" in note:
            return {
                "status":     "extension_missing",
                "error":      "pg_stat_statements extension is not installed.",
                "note":       "Run: CREATE EXTENSION pg_stat_statements; and add it to shared_preload_libraries.",
                "statements": [], "summary": {},
            }
        return {"status": "error", "error": note[:300], "statements": [], "summary": {}}
    finally:
        if _pgss_eng is not None:
            try:
                _pgss_eng.dispose()
            except Exception:
                pass


# ═════════════════════════════════════════════════════════════════════════════
#  23. Database Health
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_database_health(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)

    db_stats = []
    try:
        db_stats = _rows(engine, """
            SELECT
                s.datname,
                s.numbackends,
                s.xact_commit,
                s.xact_rollback,
                s.blks_read,
                s.blks_hit,
                s.tup_returned,
                s.tup_fetched,
                s.tup_inserted,
                s.tup_updated,
                s.tup_deleted,
                s.conflicts,
                s.temp_files,
                s.temp_bytes,
                s.deadlocks,
                s.checksum_failures,
                s.blk_read_time,
                s.blk_write_time,
                s.session_time,
                s.active_time,
                s.idle_in_transaction_time,
                s.sessions,
                s.sessions_abandoned,
                s.sessions_fatal,
                s.sessions_killed,
                pg_database_size(s.datname) AS size_bytes,
                ROUND(
                    CASE WHEN s.blks_hit + s.blks_read > 0
                    THEN s.blks_hit::numeric / (s.blks_hit + s.blks_read) * 100
                    ELSE 0 END, 2
                ) AS cache_hit_pct
            FROM pg_stat_database s
            WHERE s.datname NOT IN ('template0', 'template1')
            ORDER BY size_bytes DESC
        """)
        db_stats = [dict(d) for d in db_stats]
        for d in db_stats:
            d["size_bytes"] = int(d.get("size_bytes") or 0)
            d["size_mb"]    = round(d["size_bytes"] / (1024 * 1024), 2)
    except Exception as e:
        db_stats = [{"error": str(e)}]

    vacuum_needed = []
    try:
        vacuum_needed = _rows(engine, """
            SELECT
                schemaname, relname,
                n_live_tup, n_dead_tup,
                CASE WHEN n_live_tup + n_dead_tup > 0
                     THEN ROUND(n_dead_tup::numeric / (n_live_tup + n_dead_tup) * 100, 2)
                     ELSE 0 END AS dead_tup_pct,
                last_vacuum::text,
                last_autovacuum::text,
                last_analyze::text,
                last_autoanalyze::text,
                n_mod_since_analyze,
                seq_scan,
                idx_scan,
                pg_size_pretty(pg_total_relation_size(schemaname||'.'||relname)) AS total_size
            FROM pg_stat_user_tables
            WHERE n_dead_tup > 1000
               OR (n_live_tup + n_dead_tup > 0
                   AND n_dead_tup::float / (n_live_tup + n_dead_tup) > 0.1)
            ORDER BY n_dead_tup DESC
            LIMIT 30
        """)
        vacuum_needed = [dict(r) for r in vacuum_needed]
        for t in vacuum_needed:
            t["n_live_tup"] = int(t.get("n_live_tup") or 0)
            t["n_dead_tup"] = int(t.get("n_dead_tup") or 0)
    except Exception:
        pass

    index_health = {}
    try:
        rows = _rows(engine, """
            SELECT
                COUNT(*) FILTER (WHERE idx_scan = 0 AND indexrelname NOT LIKE '%_pkey') AS unused_indexes,
                COUNT(*) AS total_indexes,
                SUM(idx_scan) AS total_scans,
                SUM(idx_tup_read) AS total_tup_read,
                pg_size_pretty(SUM(pg_relation_size(indexrelid))) AS total_index_size
            FROM pg_stat_user_indexes
        """)
        if rows:
            index_health = dict(rows[0])
    except Exception:
        pass

    sequences = []
    try:
        sequences = _rows(engine, """
            SELECT
                schemaname, sequencename, last_value, start_value,
                increment_by, max_value, min_value, cycle, cache_size,
                CASE WHEN max_value > 0 AND last_value IS NOT NULL
                     THEN ROUND((last_value - min_value)::numeric
                                / NULLIF(max_value - min_value, 0) * 100, 2)
                     ELSE 0 END AS used_pct
            FROM pg_sequences
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY used_pct DESC NULLS LAST
            LIMIT 50
        """)
        sequences = [dict(r) for r in sequences]
    except Exception:
        pass

    return {
        "status":        "success",
        "databases":     db_stats,
        "vacuum_needed": vacuum_needed,
        "index_health":  index_health,
        "sequences":     sequences,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  24. Storage Objects
# ═════════════════════════════════════════════════════════════════════════════

def svc_pg_storage_objects(conn_id: int, db: Session):
    _, engine = _pg_conn(conn_id, db)

    top_tables = []
    try:
        top_tables = _rows(engine, """
            SELECT
                n.nspname AS schema,
                c.relname AS table_name,
                c.reltuples::bigint AS estimated_rows,
                pg_size_pretty(pg_table_size(c.oid))         AS table_size,
                pg_size_pretty(pg_indexes_size(c.oid))        AS index_size,
                pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
                pg_table_size(c.oid)                          AS table_size_bytes,
                pg_total_relation_size(c.oid)                 AS total_size_bytes,
                s.seq_scan, s.idx_scan,
                s.n_live_tup, s.n_dead_tup,
                s.last_vacuum::text, s.last_autovacuum::text
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relname = c.relname AND s.schemaname = n.nspname
            WHERE c.relkind = 'r'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY pg_total_relation_size(c.oid) DESC
            LIMIT 50
        """)
        top_tables = [dict(r) for r in top_tables]
        for t in top_tables:
            t["total_size_bytes"] = int(t.get("total_size_bytes") or 0)
            t["table_size_bytes"] = int(t.get("table_size_bytes") or 0)
            t["estimated_rows"]   = int(t.get("estimated_rows")   or 0)
    except Exception as e:
        top_tables = [{"error": str(e)}]

    top_indexes = []
    try:
        top_indexes = _rows(engine, """
            SELECT
                n.nspname AS schema,
                t.relname AS table_name,
                i.relname AS index_name,
                ix.indisprimary AS is_primary,
                ix.indisunique  AS is_unique,
                pg_size_pretty(pg_relation_size(i.oid)) AS size,
                pg_relation_size(i.oid)                 AS size_bytes,
                s.idx_scan,
                s.idx_tup_read,
                s.idx_tup_fetch,
                pg_get_indexdef(ix.indexrelid)          AS definition
            FROM pg_index ix
            JOIN pg_class i ON i.oid = ix.indexrelid
            JOIN pg_class t ON t.oid = ix.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            ORDER BY pg_relation_size(i.oid) DESC
            LIMIT 50
        """)
        top_indexes = [dict(r) for r in top_indexes]
        for idx in top_indexes:
            idx["size_bytes"] = int(idx.get("size_bytes") or 0)
            idx["idx_scan"]   = int(idx.get("idx_scan")   or 0)
            idx["is_primary"] = bool(idx.get("is_primary"))
            idx["is_unique"]  = bool(idx.get("is_unique"))
    except Exception as e:
        top_indexes = [{"error": str(e)}]

    extensions = []
    try:
        extensions = _rows(engine, """
            SELECT name, default_version, installed_version, comment
            FROM pg_available_extensions
            WHERE installed_version IS NOT NULL
            ORDER BY name
        """)
        extensions = [dict(e) for e in extensions]
    except Exception:
        pass

    storage_summary = {}
    try:
        rows = _rows(engine, """
            SELECT
                pg_size_pretty(SUM(pg_database_size(datname))) AS total_all_dbs,
                SUM(pg_database_size(datname))                 AS total_bytes,
                COUNT(*)                                       AS db_count
            FROM pg_database
            WHERE datname NOT IN ('template0', 'template1')
        """)
        if rows:
            storage_summary = dict(rows[0])
            storage_summary["total_bytes"] = int(storage_summary.get("total_bytes") or 0)
    except Exception:
        pass

    return {
        "status":          "success",
        "top_tables":      top_tables,
        "top_indexes":     top_indexes,
        "extensions":      extensions,
        "storage_summary": storage_summary,
    }
