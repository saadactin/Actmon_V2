from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus
import datetime

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL Monitoring"])


# =========================================================
# DATABASE SESSION
# =========================================================

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# =========================================================
# ENGINE + HELPER UTILITIES
# =========================================================

def _pg_engine(conn):
    pw = quote_plus(conn.password or "")
    return create_engine(
        f"postgresql+psycopg2://{conn.username}:{pw}@{conn.host}:{conn.port}/{conn.database_name or 'postgres'}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 5}
    )


def _pg_engine_db(conn, dbname: str):
    """Create a one-off engine for a specific database on the same server."""
    pw = quote_plus(conn.password or "")
    return create_engine(
        f"postgresql+psycopg2://{conn.username}:{pw}@{conn.host}:{conn.port}/{dbname}",
        pool_size=1, max_overflow=0, pool_pre_ping=True,
        connect_args={"connect_timeout": 5}
    )


def _rows(engine, sql, params=None):
    with engine.connect() as c:
        r = c.execute(text(sql), params or {})
        return [dict(row) for row in r.mappings().all()]


def _val(engine, sql):
    with engine.connect() as c:
        row = c.execute(text(sql)).fetchone()
        return row[0] if row else None


# =========================================================
# 1. MONITORING DASHBOARD
# =========================================================

@router.get("/{conn_id}/monitoring-dashboard")
def monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Comprehensive PostgreSQL monitoring dashboard.
    Returns: status, connection, health_summary, databases, query_stats,
             connections_detail, memory, replication, process_list,
             long_running_queries, server_vars.
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    connection_meta = {
        "id": conn_rec.id,
        "name": conn_rec.connection_name,
        "host": conn_rec.host,
        "port": conn_rec.port,
        "database": conn_rec.database_name,
    }

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "connection": connection_meta, "error": str(e)}

    # ── Version ──────────────────────────────────────────────────────────────
    version = None
    try:
        version = _val(engine, "SELECT version()")
    except Exception:
        version = "unknown"

    # ── Uptime ───────────────────────────────────────────────────────────────
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

    # ── Connection counts by state ────────────────────────────────────────────
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

    # ── Max connections ───────────────────────────────────────────────────────
    max_connections = 100
    try:
        max_raw = _val(engine, "SHOW max_connections")
        max_connections = int(max_raw) if max_raw is not None else 100
    except Exception:
        pass

    connection_pct = round((total_connections / max_connections) * 100, 2) if max_connections > 0 else 0.0

    # ── Cache hit ratio ───────────────────────────────────────────────────────
    cache_hit_pct = 0.0
    blks_hit = 0
    blks_read = 0
    try:
        row = _rows(engine, "SELECT sum(blks_hit) AS hit, sum(blks_read) AS rd FROM pg_stat_database")
        if row:
            blks_hit = int(row[0].get("hit") or 0)
            blks_read = int(row[0].get("rd") or 0)
            total_blks = blks_hit + blks_read
            cache_hit_pct = round((blks_hit / total_blks) * 100, 2) if total_blks > 0 else 0.0
    except Exception:
        pass

    # ── Commits / rollbacks ───────────────────────────────────────────────────
    commits = 0
    rollbacks = 0
    tup_returned = 0
    tup_fetched = 0
    try:
        row = _rows(
            engine,
            "SELECT sum(xact_commit) AS cmts, sum(xact_rollback) AS rbks, "
            "sum(tup_returned) AS tr, sum(tup_fetched) AS tf FROM pg_stat_database"
        )
        if row:
            commits = int(row[0].get("cmts") or 0)
            rollbacks = int(row[0].get("rbks") or 0)
            tup_returned = int(row[0].get("tr") or 0)
            tup_fetched = int(row[0].get("tf") or 0)
    except Exception:
        pass

    # ── Databases with sizes ──────────────────────────────────────────────────
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
            d["size_bytes"] = int(d.get("size_bytes") or 0)
            d["size_mb"] = round(d["size_bytes"] / (1024 * 1024), 2)
            d["xact_commit"] = int(d.get("xact_commit") or 0)
            d["xact_rollback"] = int(d.get("xact_rollback") or 0)
            d["blks_read"] = int(d.get("blks_read") or 0)
            d["blks_hit"] = int(d.get("blks_hit") or 0)
    except Exception:
        databases = []

    total_databases = len(databases)

    # ── Active queries (process list) ─────────────────────────────────────────
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

    # ── Long running queries (> 30 s) ─────────────────────────────────────────
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

    # ── Replication status ────────────────────────────────────────────────────
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

    # ── pg_stat_user_tables (full) ────────────────────────────────────────────
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
            t["n_live_tup"] = int(t.get("n_live_tup") or 0)
            t["n_dead_tup"] = int(t.get("n_dead_tup") or 0)
            t["seq_scan"] = int(t.get("seq_scan") or 0)
            t["idx_scan"] = int(t.get("idx_scan") or 0)
            t["last_vacuum"] = str(t.get("last_vacuum") or "")
            t["last_autovacuum"] = str(t.get("last_autovacuum") or "")
            t["last_analyze"] = str(t.get("last_analyze") or "")
            t["last_autoanalyze"] = str(t.get("last_autoanalyze") or "")
        total_tables = len(table_stats)
    except Exception:
        table_stats = []

    # ── Memory / config variables ─────────────────────────────────────────────
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

    # ── BGWriter statistics ───────────────────────────────────────────────────
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
                "buffers_checkpoint": int(bg.get("buffers_checkpoint") or 0),
                "stats_reset":        str(bg.get("stats_reset") or ""),
            }
            checkpoints = {
                "checkpoints_timed":      int(bg.get("checkpoints_timed") or 0),
                "checkpoints_req":        int(bg.get("checkpoints_req") or 0),
                "checkpoint_write_time":  float(bg.get("checkpoint_write_time") or 0),
                "checkpoint_sync_time":   float(bg.get("checkpoint_sync_time") or 0),
                "buffers_checkpoint":     int(bg.get("buffers_checkpoint") or 0),
            }
    except Exception:
        pass

    # ── pg_stat_statements ────────────────────────────────────────────────────
    pg_stat_statements = []
    try:
        pg_stat_statements = _rows(
            engine,
            "SELECT userid::regrole AS usename, dbid::text AS dbname, query, calls, "
            "total_exec_time, mean_exec_time, max_exec_time, min_exec_time, "
            "stddev_exec_time, rows, shared_blks_hit, shared_blks_read "
            "FROM pg_stat_statements "
            "WHERE query NOT LIKE '%pg_stat_statements%' "
            "ORDER BY mean_exec_time DESC LIMIT 50"
        )
        pg_stat_statements = [dict(s) for s in pg_stat_statements]
        for s in pg_stat_statements:
            s["usename"] = str(s.get("usename") or "")
            s["calls"] = int(s.get("calls") or 0)
            s["rows"] = int(s.get("rows") or 0)
            s["total_exec_time"] = float(s.get("total_exec_time") or 0)
            s["mean_exec_time"] = float(s.get("mean_exec_time") or 0)
            s["max_exec_time"] = float(s.get("max_exec_time") or 0)
            s["min_exec_time"] = float(s.get("min_exec_time") or 0)
            s["stddev_exec_time"] = float(s.get("stddev_exec_time") or 0)
            s["shared_blks_hit"] = int(s.get("shared_blks_hit") or 0)
            s["shared_blks_read"] = int(s.get("shared_blks_read") or 0)
    except Exception:
        pg_stat_statements = []

    # ── pg_locks ──────────────────────────────────────────────────────────────
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
            lk["granted"] = bool(lk.get("granted"))
            lk["duration_sec"] = int(lk.get("duration_sec") or 0)
    except Exception:
        pg_locks = []

    # ── Blocking queries ──────────────────────────────────────────────────────
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

    # ── Replication slots ─────────────────────────────────────────────────────
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

    # ── Tablespaces ───────────────────────────────────────────────────────────
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
            t["size_mb"] = round(t["size_bytes"] / (1024 * 1024), 2)
    except Exception:
        tablespaces = []

    # ── Users activity (aggregated) ───────────────────────────────────────────
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
            u["total"] = int(u.get("total") or 0)
            u["active"] = int(u.get("active") or 0)
            u["idle"] = int(u.get("idle") or 0)
            u["idle_in_transaction"] = int(u.get("idle_in_transaction") or 0)
            u["waiting"] = int(u.get("waiting") or 0)
            u["max_duration"] = int(u.get("max_duration") or 0)
    except Exception:
        users_activity = []

    # ── Total DB size ─────────────────────────────────────────────────────────
    total_size_bytes = sum(d.get("size_bytes", 0) for d in databases)
    total_size_mb = round(total_size_bytes / (1024 * 1024), 2)
    total_size = f"{round(total_size_mb / 1024, 2)} GB" if total_size_mb > 1024 else f"{total_size_mb} MB"

    # ── Aggregate query stats across all databases ────────────────────────────
    total_seq_scan = 0
    total_idx_scan = 0
    n_tup_ins = 0
    n_tup_upd = 0
    n_tup_del = 0
    try:
        rows = _rows(
            engine,
            "SELECT sum(seq_scan) AS total_seq_scan, sum(idx_scan) AS total_idx_scan "
            "FROM pg_stat_user_tables"
        )
        if rows:
            total_seq_scan = int(rows[0].get("total_seq_scan") or 0)
            total_idx_scan = int(rows[0].get("total_idx_scan") or 0)
        rows2 = _rows(
            engine,
            "SELECT sum(n_tup_ins) AS ins, sum(n_tup_upd) AS upd, sum(n_tup_del) AS del "
            "FROM pg_stat_user_tables"
        )
        if rows2:
            n_tup_ins = int(rows2[0].get("ins") or 0)
            n_tup_upd = int(rows2[0].get("upd") or 0)
            n_tup_del = int(rows2[0].get("del") or 0)
    except Exception:
        pass

    temp_files = 0
    temp_bytes = 0
    try:
        rows = _rows(engine, "SELECT sum(temp_files) AS tf, sum(temp_bytes) AS tb FROM pg_stat_database")
        if rows:
            temp_files = int(rows[0].get("tf") or 0)
            temp_bytes = int(rows[0].get("tb") or 0)
    except Exception:
        pass

    # ── Postmaster start time ─────────────────────────────────────────────────
    pg_postmaster_start_time = "unknown"
    try:
        pg_postmaster_start_time = str(_val(engine, "SELECT pg_postmaster_start_time()"))
    except Exception:
        pass

    # ── Autovacuum enabled ────────────────────────────────────────────────────
    autovacuum_enabled = True
    try:
        val = _val(engine, "SHOW autovacuum")
        autovacuum_enabled = str(val).lower() == "on"
    except Exception:
        pass

    active_connections = connections_by_state.get("active", 0)

    # ── Build health_summary ──────────────────────────────────────────────────
    health_summary = {
        "version": version,
        "uptime_str": uptime_str,
        "uptime": uptime_str,
        "host_name": conn_rec.host,
        "total_databases": total_databases,
        "total_tables": total_tables,
        "total_size": total_size,
        "total_size_mb": total_size_mb,
        "total_connections": total_connections,
        "active_connections": active_connections,
        "max_connections": max_connections,
        "connection_pct": connection_pct,
        "connection_usage_pct": connection_pct,
        "cache_hit_pct": cache_hit_pct,
        "cache_hit_ratio": cache_hit_pct,
        "commits": commits,
        "rollbacks": rollbacks,
        "tup_returned": tup_returned,
        "tup_fetched": tup_fetched,
        "replication_state": replication_state,
        "is_recovery": is_recovery,
        "autovacuum_enabled": autovacuum_enabled,
        "pg_postmaster_start_time": pg_postmaster_start_time,
        "last_restart": pg_postmaster_start_time,
    }

    return {
        "status": "success",
        "connection": connection_meta,
        "health_summary": health_summary,
        "databases": databases,
        "query_stats": {
            "commits": commits,
            "xact_commit": commits,
            "rollbacks": rollbacks,
            "xact_rollback": rollbacks,
            "tup_returned": tup_returned,
            "tup_fetched": tup_fetched,
            "tup_inserted": n_tup_ins,
            "tup_updated": n_tup_upd,
            "tup_deleted": n_tup_del,
            "n_tup_ins": n_tup_ins,
            "n_tup_upd": n_tup_upd,
            "n_tup_del": n_tup_del,
            "total_seq_scan": total_seq_scan,
            "total_idx_scan": total_idx_scan,
            "blks_read": blks_read,
            "blks_hit": blks_hit,
            "temp_files": temp_files,
            "temp_bytes": temp_bytes,
            "slow_queries": len(long_running_queries),
        },
        "connections_detail": {
            "total": total_connections,
            "max": max_connections,
            "connection_pct": connection_pct,
            "by_state": connections_by_state,
            "idle": connections_by_state.get("idle", 0),
            "idle_in_transaction": connections_by_state.get("idle in transaction", 0),
            "waiting": sum(1 for _ in pg_locks if not _.get("granted", True)),
        },
        "shared_buffers": {
            "size": server_vars.get("shared_buffers", "unknown"),
            "blks_read": blks_read,
            "blks_hit": blks_hit,
        },
        "memory": memory,
        "bgwriter": bgwriter,
        "checkpoints": checkpoints,
        "replication": replication,
        "replication_slots": replication_slots,
        "replication_state": replication_state,
        "is_recovery": is_recovery,
        "process_list": process_list,
        "long_running_queries": long_running_queries,
        "pg_stat_statements": pg_stat_statements,
        "pg_stat_user_tables": table_stats,
        "table_stats": table_stats,
        "pg_locks": pg_locks,
        "blocking_queries": blocking_queries,
        "tablespaces": tablespaces,
        "users_activity": users_activity,
        "server_vars": server_vars,
    }


# =========================================================
# 2. SLOW QUERIES
# =========================================================

@router.get("/{conn_id}/pg-slow-queries")
def pg_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Return top 50 slowest queries.
    Tries pg_stat_statements first; falls back to pg_stat_activity.
    """
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
    source = "pg_stat_activity"
    error = None

    # ── Try pg_stat_statements ────────────────────────────────────────────────
    try:
        rows = _rows(
            engine,
            "SELECT userid::regrole AS user_name, dbid, query, calls, "
            "total_exec_time, mean_exec_time, max_exec_time, stddev_exec_time, "
            "rows, shared_blks_hit, shared_blks_read "
            "FROM pg_stat_statements "
            "WHERE query NOT LIKE '%pg_stat_statements%' "
            "AND query NOT LIKE '%pg_catalog%' "
            "ORDER BY mean_exec_time DESC "
            "LIMIT 50"
        )
        queries = [dict(r) for r in rows]
        for q in queries:
            q["user_name"] = str(q.get("user_name") or "")
            q["calls"] = int(q.get("calls") or 0)
            q["rows"] = int(q.get("rows") or 0)
            q["shared_blks_hit"] = int(q.get("shared_blks_hit") or 0)
            q["shared_blks_read"] = int(q.get("shared_blks_read") or 0)
            q["total_exec_time"] = float(q.get("total_exec_time") or 0.0)
            q["mean_exec_time"] = float(q.get("mean_exec_time") or 0.0)
            q["max_exec_time"] = float(q.get("max_exec_time") or 0.0)
            q["stddev_exec_time"] = float(q.get("stddev_exec_time") or 0.0)
        pg_stat_statements_available = True
        source = "pg_stat_statements"
    except Exception as e:
        error = str(e)
        # ── Fallback: pg_stat_activity ────────────────────────────────────────
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
        except Exception as e2:
            error = f"pg_stat_statements: {error} | pg_stat_activity: {str(e2)}"
            queries = []

    return {
        "status": "success",
        "source": source,
        "queries": queries,
        "pg_stat_statements_available": pg_stat_statements_available,
        "total": len(queries),
        "error": error,
    }


# =========================================================
# 3. ERROR LOGS
# =========================================================

@router.get("/{conn_id}/pg-error-logs")
def pg_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """
    Retrieve PostgreSQL error/warning log entries.
    Source 1: pg_catalog.pg_log (PostgreSQL 10+).
    Source 2: pg_stat_activity fallback (aborted / locked sessions).
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")

    try:
        engine = _pg_engine(conn_rec)
    except Exception as e:
        return {"status": "error", "error": str(e), "logs": [], "total": 0}

    logs = []
    source = "unknown"
    note = None

    # ── Source 1: pg_catalog.pg_log ───────────────────────────────────────────
    try:
        rows = _rows(
            engine,
            "SELECT log_time, user_name, database_name, process_id, "
            "connection_from, session_id, session_line_num, command_tag, "
            "session_start_time, virtual_transaction_id, transaction_id, "
            "error_severity, sql_state_code, message, detail, hint, "
            "internal_query, internal_query_pos, context, query, query_pos, "
            "location, application_name "
            "FROM pg_catalog.pg_log "
            "ORDER BY log_time DESC LIMIT 200"
        )
        logs = []
        for r in rows:
            logs.append({
                "logged": str(r.get("log_time") or ""),
                "severity": str(r.get("error_severity") or ""),
                "database": str(r.get("database_name") or ""),
                "user": str(r.get("user_name") or ""),
                "message": str(r.get("message") or ""),
                "sql_state": str(r.get("sql_state_code") or ""),
                "context": str(r.get("context") or ""),
                "detail": str(r.get("detail") or ""),
                "hint": str(r.get("hint") or ""),
                "application_name": str(r.get("application_name") or ""),
                "process_id": r.get("process_id"),
            })
        source = "pg_catalog.pg_log"
    except Exception as e1:
        note = f"pg_catalog.pg_log not available ({e1}); using pg_stat_activity fallback."
        # ── Source 2: pg_stat_activity fallback ──────────────────────────────
        try:
            rows = _rows(
                engine,
                "SELECT pid, usename, datname, state, wait_event_type, wait_event, "
                "left(query, 300) AS query, backend_start "
                "FROM pg_stat_activity "
                "WHERE state = 'idle in transaction (aborted)' "
                "OR wait_event_type = 'Lock'"
            )
            logs = []
            for r in rows:
                logs.append({
                    "logged": str(r.get("backend_start") or ""),
                    "severity": "WARNING",
                    "database": str(r.get("datname") or ""),
                    "user": str(r.get("usename") or ""),
                    "message": (
                        f"State: {r.get('state')} | "
                        f"Wait: {r.get('wait_event_type')}/{r.get('wait_event')}"
                    ),
                    "sql_state": "",
                    "context": str(r.get("query") or ""),
                    "detail": "",
                    "hint": "",
                    "application_name": "",
                    "process_id": r.get("pid"),
                })
            source = "pg_stat_activity"
        except Exception as e2:
            note = (note or "") + f" pg_stat_activity also failed: {e2}"
            logs = []
            source = "none"

    return {
        "status": "success",
        "source": source,
        "logs": logs,
        "total": len(logs),
        "note": note,
    }


# =========================================================
# 4. INDEX ANALYSIS
# =========================================================

@router.get("/{conn_id}/pg-index-analysis")
def pg_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    """
    Analyse PostgreSQL indexes:
    - unused_indexes: indexes with zero scans (excluding primary keys)
    - all_indexes: all user indexes ordered by scan count ascending
    - bloated_tables: tables with high dead-tuple ratios (vacuum candidates)
    - summary: aggregate counts
    """
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
    all_indexes = []
    bloated_tables = []
    errors = []

    # ── Unused indexes ────────────────────────────────────────────────────────
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
            idx["idx_scan"] = int(idx.get("idx_scan") or 0)
            idx["idx_tup_read"] = int(idx.get("idx_tup_read") or 0)
            idx["idx_tup_fetch"] = int(idx.get("idx_tup_fetch") or 0)
    except Exception as e:
        errors.append(f"unused_indexes: {str(e)}")

    # ── All indexes ───────────────────────────────────────────────────────────
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
        errors.append(f"all_indexes: {str(e)}")

    # ── Bloated tables ────────────────────────────────────────────────────────
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
            t["n_live_tup"] = int(t.get("n_live_tup") or 0)
            t["n_dead_tup"] = int(t.get("n_dead_tup") or 0)
            t["dead_pct"] = float(t.get("dead_pct") or 0.0)
            t["last_vacuum"] = str(t.get("last_vacuum") or "")
            t["last_autovacuum"] = str(t.get("last_autovacuum") or "")
    except Exception as e:
        errors.append(f"bloated_tables: {str(e)}")

    summary = {
        "total_indexes": len(all_indexes),
        "unused_count": len(unused_indexes),
        "total_tables": len(bloated_tables),
    }

    return {
        "status": "success",
        "unused_indexes": unused_indexes,
        "all_indexes": all_indexes,
        "bloated_tables": bloated_tables,
        "summary": summary,
        "errors": errors,
    }


# =========================================================
# 5. ADVANCED REPLICATION DETAIL
# =========================================================

@router.get("/{conn_id}/replication-detail")
def replication_detail(conn_id: int, db: Session = Depends(get_db)):
    """
    Advanced replication monitoring:
    - Role detection (primary / standby)
    - Per-replica byte lag, all LSN positions, lag intervals
    - Standby recovery info if this server is a replica
    - Enhanced replication slots with retained WAL bytes
    - Replication config parameters
    - Replication topology summary
    """
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

    # ── Server role ───────────────────────────────────────────────────────────
    is_recovery = False
    try:
        is_recovery = bool(_val(engine, "SELECT pg_is_in_recovery()"))
    except Exception as e:
        errors.append(f"role: {e}")

    server_role = "STANDBY" if is_recovery else "PRIMARY"

    # ── PostgreSQL version number (integer) ──────────────────────────────────
    pg_ver_num = 0
    try:
        pg_ver_num = int(_val(engine, "SELECT current_setting('server_version_num')::int") or 0)
    except Exception:
        try:
            pg_ver_num = int(_val(engine, "SHOW server_version_num") or 0)
        except Exception:
            pass

    # ── Primary WAL info ─────────────────────────────────────────────────────
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

    # ── Standby recovery info ─────────────────────────────────────────────────
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
                    "receive_lsn":           r.get("receive_lsn", ""),
                    "replay_lsn":            r.get("replay_lsn", ""),
                    "last_replay_ts":        str(r.get("last_replay_ts") or ""),
                    "receive_replay_diff":   int(r.get("receive_replay_diff") or 0),
                    "seconds_behind":        int(r.get("seconds_behind") or 0),
                }
        except Exception as e:
            errors.append(f"standby_info: {e}")

        # WAL receiver details – SELECT * handles PG13/14 (received_lsn) vs PG15+ (flushed_lsn)
        try:
            rows = _rows(engine, "SELECT * FROM pg_stat_wal_receiver LIMIT 1")
            if rows:
                r = rows[0]
                # received_lsn was renamed to flushed_lsn in PG15+; try all variants
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

    # ── Streaming replicas with byte lag ────────────────────────────────────
    replicas = []
    if not is_recovery:
        try:
            rows = _rows(
                engine,
                "SELECT "
                "  pid::text AS pid, "
                "  usename, "
                "  application_name, "
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

    # ── Enhanced replication slots ───────────────────────────────────────────
    # On STANDBY: pg_current_wal_lsn() is unavailable during recovery;
    # use pg_last_wal_receive_lsn() (falling back to replay LSN) instead.
    slots = []
    try:
        lsn_fn = (
            "COALESCE(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())"
            if is_recovery
            else "pg_current_wal_lsn()"
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
            # Add a human-readable reason why this slot is inactive
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

    # ── Replication config params ─────────────────────────────────────────────
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

    # ── Active WAL sender processes ──────────────────────────────────────────
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

    # ── Topology summary ─────────────────────────────────────────────────────
    streaming_count  = len([r for r in replicas if r.get("state") in ("streaming","catchup")])
    sync_count       = len([r for r in replicas if r.get("sync_state") == "sync"])
    async_count      = len([r for r in replicas if r.get("sync_state") == "async"])
    total_byte_lag   = sum(r.get("byte_lag", 0) for r in replicas)
    max_byte_lag     = max((r.get("byte_lag", 0) for r in replicas), default=0)
    active_slots     = len([s for s in slots if s.get("active")])
    inactive_slots   = len([s for s in slots if not s.get("active")])
    total_retained   = sum(max(0, s.get("retained_bytes", 0)) for s in slots)

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

    # ── Checkpoint / bgwriter stats ─────────────────────────────────────────
    checkpoint_stats = {}
    try:
        rows = _rows(engine,
            "SELECT checkpoints_timed, checkpoints_req, "
            "checkpoint_write_time, checkpoint_sync_time, "
            "buffers_checkpoint, buffers_clean, maxwritten_clean, "
            "buffers_backend, buffers_backend_fsync, buffers_alloc, "
            "stats_reset::text AS stats_reset "
            "FROM pg_stat_bgwriter LIMIT 1"
        )
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

    # ── WAL generation stats (PG14+) ────────────────────────────────────────
    wal_stats = {}
    if pg_ver_num >= 140000:
        try:
            rows = _rows(engine,
                "SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full, "
                "wal_write, wal_sync, wal_write_time, wal_sync_time, "
                "stats_reset::text AS stats_reset "
                "FROM pg_stat_wal LIMIT 1"
            )
            if rows:
                wal_stats = dict(rows[0])
                for k in ("wal_records", "wal_fpi", "wal_buffers_full", "wal_write", "wal_sync"):
                    wal_stats[k] = int(wal_stats.get(k) or 0)
                wal_stats["wal_bytes"] = int(wal_stats.get("wal_bytes") or 0)
                for k in ("wal_write_time", "wal_sync_time"):
                    wal_stats[k] = float(wal_stats.get(k) or 0)
        except Exception as e:
            errors.append(f"wal_stats: {e}")

    # ── Replication conflicts (standby only) ─────────────────────────────────
    conflicts = []
    if is_recovery:
        try:
            rows = _rows(engine,
                "SELECT datname, confl_tablespace, confl_lock, confl_snapshot, "
                "confl_bufferpin, confl_deadlock "
                "FROM pg_stat_database_conflicts "
                "WHERE (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) > 0 "
                "ORDER BY (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) DESC"
            )
            conflicts = [dict(r) for r in rows]
            for c in conflicts:
                for k in ("confl_tablespace", "confl_lock", "confl_snapshot",
                          "confl_bufferpin", "confl_deadlock"):
                    c[k] = int(c.get(k) or 0)
        except Exception as e:
            errors.append(f"conflicts: {e}")

    # ── Logical replication publications ────────────────────────────────────
    publications = []
    if not is_recovery:
        try:
            rows = _rows(engine,
                "SELECT pubname, puballtables, pubinsert, pubupdate, "
                "pubdelete, pubtruncate "
                "FROM pg_publication ORDER BY pubname"
            )
            publications = [dict(r) for r in rows]
            for p in publications:
                for k in ("puballtables", "pubinsert", "pubupdate", "pubdelete", "pubtruncate"):
                    p[k] = bool(p.get(k))
        except Exception as e:
            errors.append(f"publications: {e}")

    # ── Logical replication subscriptions ────────────────────────────────────
    subscriptions = []
    try:
        rows = _rows(engine,
            "SELECT subname, subenabled, subslotname, subpublications "
            "FROM pg_subscription ORDER BY subname"
        )
        subscriptions = [dict(r) for r in rows]
        for s in subscriptions:
            s["subenabled"] = bool(s.get("subenabled"))
    except Exception as e:
        errors.append(f"subscriptions: {e}")

    # ── Standby replay pause state ───────────────────────────────────────────
    recovery_state = {}
    if is_recovery:
        # Try PG14+ detailed function first, fall back to PG9.6+ boolean function
        try:
            pause_state = _val(engine, "SELECT pg_wal_replay_pause_state()")
            recovery_state["pause_state"] = str(pause_state or "")
        except Exception:
            try:
                paused = _val(engine, "SELECT pg_is_wal_replay_paused()")
                recovery_state["pause_state"] = "paused" if paused else "not paused"
            except Exception as e:
                errors.append(f"recovery_state: {e}")

        # Recovery configuration from pg_settings
        try:
            import re as _re
            cfg_rows = _rows(engine,
                "SELECT name, setting FROM pg_settings "
                "WHERE name IN ('primary_conninfo','primary_slot_name','recovery_target_timeline',"
                "               'restore_command','recovery_min_apply_delay','wal_receiver_status_interval') "
                "ORDER BY name"
            )
            for row in cfg_rows:
                k, v = row.get("name", ""), row.get("setting", "")
                if k == "primary_conninfo" and v:
                    v = _re.sub(r"password=[^ ']*", "password=***", v)
                recovery_state[k] = v
        except Exception:
            pass

        # WAL receiver process count
        try:
            wa = _rows(engine,
                "SELECT count(*)::int AS cnt "
                "FROM pg_stat_activity WHERE backend_type='walreceiver'"
            )
            recovery_state["walreceiver_procs"] = int((wa[0].get("cnt") or 0) if wa else 0)
        except Exception:
            pass

        # If WAL receiver is down, parse primary_conninfo for host/port as fallback
        if not standby_info.get("wal_receiver") and recovery_state.get("primary_conninfo"):
            try:
                import re as _re2
                ci = recovery_state["primary_conninfo"]
                host_m = _re2.search(r"host=([^\s']+)", ci)
                port_m = _re2.search(r"port=([^\s']+)", ci)
                user_m = _re2.search(r"user=([^\s']+)", ci)
                app_m  = _re2.search(r"application_name=([^\s']+)", ci)
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


# =========================================================
# 6. ADVANCED QUERIES DETAIL
# =========================================================

@router.get("/{conn_id}/queries-detail")
def queries_detail(conn_id: int, db: Session = Depends(get_db)):
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

    # ── pg_stat_statements base query ────────────────────────────────────────
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
            row["cache_hit_pct"]       = round(row["shared_blks_hit"] / max(total_io, 1) * 100, 1)
            row["rows_per_call"]       = round(row["rows"] / max(row["calls"], 1), 2)
            qt = str(row.get("query","")).strip().upper()[:6]
            row["query_type"] = qt if qt in ("SELECT","INSERT","UPDATE","DELETE","WITH","VACUUM","ANALYZ","CREATE","DROP","ALTER","TRUNCA") else "OTHER"
            out.append(row)
        return out

    all_stmts = []
    try:
        rows = _rows(engine, ss_base + "LIMIT 500")
        all_stmts = _cast(rows)
        pg_ss_available = True
    except Exception as e:
        errors.append(f"pg_stat_statements: {e}")

    top_mean   = sorted(all_stmts, key=lambda x: x["mean_exec_time"],  reverse=True)[:25]
    top_total  = sorted(all_stmts, key=lambda x: x["total_exec_time"], reverse=True)[:25]
    top_calls  = sorted(all_stmts, key=lambda x: x["calls"],           reverse=True)[:25]
    top_io     = sorted(all_stmts, key=lambda x: x["shared_blks_read"],reverse=True)[:25]
    top_rows   = sorted(all_stmts, key=lambda x: x["rows"],            reverse=True)[:25]
    top_temp   = sorted(all_stmts, key=lambda x: x["temp_blks_read"],  reverse=True)[:10]

    by_type = {}
    for s in all_stmts:
        qt = s["query_type"]
        by_type[qt] = by_type.get(qt, 0) + 1

    # ── Active queries (pg_stat_activity) ────────────────────────────────────
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

    # ── Long-running (> 30s) ──────────────────────────────────────────────────
    long_running = [q for q in active_queries if q.get("duration_sec", 0) > 30]

    # ── Wait event breakdown ──────────────────────────────────────────────────
    wait_events = {}
    for q in active_queries:
        we = q.get("wait_event_type") or "running"
        wait_events[we] = wait_events.get(we, 0) + 1

    # ── All backends (including bg) ───────────────────────────────────────────
    all_backends = []
    try:
        rows = _rows(
            engine,
            "SELECT backend_type, state, count(*) AS cnt "
            "FROM pg_stat_activity "
            "GROUP BY backend_type, state ORDER BY cnt DESC"
        )
        all_backends = [{"backend_type": r.get("backend_type",""),
                          "state": r.get("state",""),
                          "count": int(r.get("cnt") or 0)} for r in rows]
    except Exception as e:
        errors.append(f"all_backends: {e}")

    # ── Cache hit ratio ───────────────────────────────────────────────────────
    cache_hit = 0.0
    try:
        rows = _rows(engine, "SELECT sum(blks_hit) AS hit, sum(blks_read) AS rd FROM pg_stat_database")
        if rows:
            h = int(rows[0].get("hit") or 0)
            r = int(rows[0].get("rd") or 0)
            cache_hit = round(h / max(h+r, 1) * 100, 2)
    except Exception:
        pass

    return {
        "status":             "success",
        "pg_ss_available":    pg_ss_available,
        "total_statements":   len(all_stmts),
        "cache_hit_pct":      cache_hit,
        "by_type":            by_type,
        "wait_events":        wait_events,
        "top_by_mean_time":   top_mean,
        "top_by_total_time":  top_total,
        "top_by_calls":       top_calls,
        "top_by_io":          top_io,
        "top_by_rows":        top_rows,
        "top_by_temp":        top_temp,
        "active_queries":     active_queries,
        "long_running":       long_running,
        "all_backends":       all_backends,
        "errors":             errors,
    }


# =========================================================
# 7. ADVANCED TABLES DETAIL
# =========================================================

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


def _process_table_rows(raw_rows, dbname: str) -> list:
    """Normalise and enrich a list of pg_stat_user_tables rows."""
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


@router.get("/{conn_id}/tables-detail")
def tables_detail(conn_id: int, db: Session = Depends(get_db)):
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

    # ── Discover all user databases on this server ────────────────────────────
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

    # ── Query tables from every database ─────────────────────────────────────
    all_tables: list = []
    all_idx_by_db: dict = {}   # dbname -> {schema.table -> [indexes]}

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

    # ── Attach indexes ────────────────────────────────────────────────────────
    for t in all_tables:
        key = f"{t['schemaname']}.{t['relname']}"
        idx_map = all_idx_by_db.get(t["database"], {})
        t["indexes"]        = idx_map.get(key, [])
        t["index_count"]    = len(t["indexes"])
        t["unused_indexes"] = [i for i in t["indexes"] if i["idx_scan"] == 0]

    # ── Sort by total size descending ─────────────────────────────────────────
    all_tables.sort(key=lambda x: x.get("total_bytes", 0), reverse=True)

    # ── Autovacuum settings (server-wide, query once) ─────────────────────────
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
        "status":          "success",
        "tables":          all_tables,
        "total_count":     len(all_tables),
        "total_bytes":     total_bytes,
        "vacuum_needed":   len(vacuum_needed),
        "analyze_needed":  len(analyze_needed),
        "autovac_config":  autovac_config,
        "databases":       databases_list,
        "errors":          errors,
    }


# ──────────────────────────────────────────────────────────────────────────
# 7b. Table Structure  GET /{conn_id}/table-structure
#     ?database=actmon_test&schema=public&table=employee
# ──────────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/table-structure")
def table_structure(
    conn_id:  int,
    database: str,
    schema:   str = "public",
    table:    str = "",
    db:       Session = Depends(get_db),
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

    columns     = []
    indexes     = []
    constraints = []
    triggers    = []
    row_count   = None

    try:
        with db_eng.connect() as conn:

            # ── Columns ──────────────────────────────────────────────────────
            columns = [dict(r) for r in conn.execute(text("""
                SELECT
                    c.ordinal_position,
                    c.column_name,
                    c.data_type,
                    c.udt_name,
                    c.character_maximum_length,
                    c.numeric_precision,
                    c.numeric_scale,
                    c.datetime_precision,
                    c.is_nullable,
                    c.column_default,
                    c.is_identity,
                    c.identity_generation,
                    pgd.description AS column_comment
                FROM information_schema.columns c
                LEFT JOIN pg_catalog.pg_statio_all_tables st
                    ON st.schemaname = c.table_schema AND st.relname = c.table_name
                LEFT JOIN pg_catalog.pg_description pgd
                    ON pgd.objoid = st.relid
                    AND pgd.objsubid = c.ordinal_position
                WHERE c.table_schema = :schema AND c.table_name = :table
                ORDER BY c.ordinal_position
            """), {"schema": schema, "table": table}).mappings().fetchall()]

            # ── Indexes (full detail) ─────────────────────────────────────────
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
                WHERE n.nspname = :schema AND t.relname = :table AND t.relkind = 'r'
                GROUP BY i.relname, ix.indisunique, ix.indisprimary, ix.indisvalid,
                         ix.indisclustered, i.oid, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
                ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname
            """), {"schema": schema, "table": table}).mappings().fetchall()]

            # ── Constraints ───────────────────────────────────────────────────
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
                WHERE tc.table_schema = :schema AND tc.table_name = :table
                GROUP BY tc.constraint_name, tc.constraint_type,
                         ccu.table_schema, ccu.table_name, ccu.column_name,
                         rc.update_rule, rc.delete_rule
                ORDER BY tc.constraint_type, tc.constraint_name
            """), {"schema": schema, "table": table}).mappings().fetchall()]

            # ── Triggers ─────────────────────────────────────────────────────
            try:
                triggers = [dict(r) for r in conn.execute(text("""
                    SELECT trigger_name, event_manipulation, action_timing,
                           action_statement, action_orientation
                    FROM information_schema.triggers
                    WHERE event_object_schema = :schema
                      AND event_object_table  = :table
                    ORDER BY trigger_name, event_manipulation
                """), {"schema": schema, "table": table}).mappings().fetchall()]
            except Exception as e:
                errors.append(f"triggers: {e}")

            # ── Estimated row count ───────────────────────────────────────────
            try:
                row = conn.execute(text("""
                    SELECT reltuples::bigint AS row_count
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = :schema AND c.relname = :table
                """), {"schema": schema, "table": table}).fetchone()
                row_count = int(row[0]) if row else None
            except Exception:
                pass

    except Exception as e:
        errors.append(str(e))
    finally:
        db_eng.dispose()

    return {
        "status":      "success",
        "database":    database,
        "schema":      schema,
        "table":       table,
        "row_count":   row_count,
        "columns":     columns,
        "indexes":     indexes,
        "constraints": constraints,
        "triggers":    triggers,
        "errors":      errors,
    }


# ──────────────────────────────────────────────────────────────────────────
# 8. Config Detail  GET /{conn_id}/config-detail
# ──────────────────────────────────────────────────────────────────────────

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


@router.get("/{conn_id}/config-detail")
def pg_config_detail(conn_id: int, db: Session = Depends(get_db)):
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")

    engine  = _pg_engine(rec)
    errors  = []
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


# =========================================================
# 9. ADVANCED USERS DETAIL
# =========================================================

@router.get("/{conn_id}/users-detail")
def users_detail(conn_id: int, db: Session = Depends(get_db)):
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

    # ── All roles ────────────────────────────────────────────────────────────
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
            r["rolsuper"]      = bool(r.get("rolsuper"))
            r["rolinherit"]    = bool(r.get("rolinherit"))
            r["rolcreaterole"] = bool(r.get("rolcreaterole"))
            r["rolcreatedb"]   = bool(r.get("rolcreatedb"))
            r["rolcanlogin"]   = bool(r.get("rolcanlogin"))
            r["rolreplication"]= bool(r.get("rolreplication"))
            r["rolbypassrls"]  = bool(r.get("rolbypassrls"))
            r["expired"]       = bool(r.get("expired"))
    except Exception as e:
        errors.append(f"roles: {e}")

    # ── Role memberships ─────────────────────────────────────────────────────
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

    # ── Current activity by user ─────────────────────────────────────────────
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
            for k in ("total","active","idle","idle_in_txn","waiting"):
                a[k] = int(a.get(k) or 0)
            a["max_conn_age_s"]  = int(a.get("max_conn_age_s")  or 0)
            a["max_query_age_s"] = int(a.get("max_query_age_s") or 0)
    except Exception as e:
        errors.append(f"activity: {e}")

    # ── Per-user total connections right now ────────────────────────────────
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

    # ── Object ownership summary ────────────────────────────────────────────
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
            for k in ("tables","views","indexes","sequences"):
                o[k] = int(o.get(k) or 0)
    except Exception as e:
        errors.append(f"obj_ownership: {e}")

    # ── Summary counts ───────────────────────────────────────────────────────
    total_roles     = len(roles)
    login_roles     = len([r for r in roles if r.get("rolcanlogin")])
    superuser_count = len([r for r in roles if r.get("rolsuper")])
    expired_count   = len([r for r in roles if r.get("expired")])

    return {
        "status":         "success",
        "roles":          roles,
        "memberships":    memberships,
        "activity":       activity,
        "conn_summary":   conn_summary,
        "obj_ownership":  obj_ownership,
        "summary": {
            "total_roles":     total_roles,
            "login_roles":     login_roles,
            "superuser_count": superuser_count,
            "expired_count":   expired_count,
        },
        "errors": errors,
    }


# =========================================================
# 10. ADVANCED STORAGE DETAIL
# =========================================================

@router.get("/{conn_id}/storage-detail")
def storage_detail(conn_id: int, db: Session = Depends(get_db)):
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

    # ── Database sizes ───────────────────────────────────────────────────────
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

    # ── Tablespaces ─────────────────────────────────────────────────────────
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

    # ── Top tables by total size (with vacuum stats) ─────────────────────────
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
            for k in ("total_bytes","table_bytes","index_bytes","n_live_tup","n_dead_tup",
                      "vacuum_count","autovacuum_count","analyze_count","autoanalyze_count",
                      "seq_scan","idx_scan","n_tup_ins","n_tup_upd","n_tup_del","n_tup_hot_upd"):
                t[k] = int(t.get(k) or 0)
            t["dead_ratio"] = float(t.get("dead_ratio") or 0)
    except Exception as e:
        errors.append(f"top_tables: {e}")

    # ── Bloat candidates (high dead tuple ratio) ────────────────────────────
    bloat_tables = sorted(
        [t for t in top_tables if t.get("dead_ratio", 0) > 5 or t.get("n_dead_tup", 0) > 1000],
        key=lambda x: x.get("n_dead_tup", 0),
        reverse=True
    )[:20]

    # ── Tables needing vacuum (no vacuum in 7+ days or never) ───────────────
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
            v["n_live_tup"]  = int(v.get("n_live_tup")  or 0)
            v["n_dead_tup"]  = int(v.get("n_dead_tup")  or 0)
            v["autovacuum_count"] = int(v.get("autovacuum_count") or 0)
            v["secs_since_vacuum"]= int(v.get("secs_since_vacuum") or 0)
    except Exception as e:
        errors.append(f"vacuum_needed: {e}")

    # ── TOAST tables with significant size ──────────────────────────────────
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

    # ── Autovacuum settings ──────────────────────────────────────────────────
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
                "setting": r.get("setting",""),
                "unit":    r.get("unit",""),
                "desc":    r.get("short_desc",""),
            }
    except Exception as e:
        errors.append(f"autovacuum_settings: {e}")

    # ── Summary ──────────────────────────────────────────────────────────────
    total_db_bytes    = sum(d.get("size_bytes",0) for d in db_sizes)
    total_table_bytes = sum(t.get("total_bytes",0) for t in top_tables)
    total_index_bytes = sum(t.get("index_bytes",0) for t in top_tables)
    total_dead_tup    = sum(t.get("n_dead_tup",0) for t in top_tables)

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
