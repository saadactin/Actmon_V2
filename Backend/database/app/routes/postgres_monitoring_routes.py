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
