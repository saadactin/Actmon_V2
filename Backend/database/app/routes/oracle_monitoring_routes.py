from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(prefix="/api/v1/connections/oracle", tags=["Oracle Monitoring"])


# ──────────────────────────────────────────────────────────────
#  HELPERS
# ──────────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _oracle_engine(conn):
    pw = quote_plus(conn.password or "")
    if conn.service_name:
        dsn = f"{conn.host}:{conn.port}/?service_name={conn.service_name}"
    elif conn.sid:
        dsn = f"{conn.host}:{conn.port}/{conn.sid}"
    else:
        dsn = f"{conn.host}:{conn.port}/{conn.database_name or ''}"
    return create_engine(
        f"oracle+cx_Oracle://{conn.username}:{pw}@{dsn}",
        pool_pre_ping=True
    )


def _rows(engine, sql):
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


def _safe_float(val, default=0.0):
    try:
        return float(val) if val is not None else default
    except (TypeError, ValueError):
        return default


def _safe_int(val, default=0):
    try:
        return int(val) if val is not None else default
    except (TypeError, ValueError):
        return default


def _safe_str(val, default=""):
    if val is None:
        return default
    return str(val)


def _get_conn_or_404(conn_id, db):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    return conn


def _get_engine(conn):
    try:
        return _oracle_engine(conn)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine creation failed: {str(e)}")


# ──────────────────────────────────────────────────────────────
#  1. MAIN DASHBOARD  GET /{conn_id}/oracle-dashboard
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-dashboard")
def oracle_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Main dashboard: instance info, SGA/PGA, sessions, buffer cache,
    library cache hit, top waits, top SQL.
    """
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    # ── Version ──────────────────────────────────────────────
    version = ""
    try:
        rows = _rows(engine, "SELECT banner FROM v$version WHERE rownum=1")
        version = rows[0].get("BANNER", "") if rows else ""
    except Exception as exc:
        errors.append(f"version: {exc}")

    # ── Instance ─────────────────────────────────────────────
    instance_info = {}
    try:
        rows = _rows(
            engine,
            "SELECT instance_name, host_name, version, status, startup_time "
            "FROM v$instance"
        )
        if rows:
            instance_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception as exc:
        errors.append(f"instance: {exc}")

    # ── Database ──────────────────────────────────────────────
    db_info = {}
    try:
        rows = _rows(engine, "SELECT name, db_unique_name, log_mode FROM v$database")
        if rows:
            db_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception as exc:
        errors.append(f"database: {exc}")

    # ── Sessions ──────────────────────────────────────────────
    active_sessions = 0
    total_sessions  = 0
    max_sessions    = 0
    try:
        rows = _rows(engine, "SELECT count(*) AS cnt FROM v$session WHERE status='ACTIVE' AND type='USER'")
        active_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"active_sessions: {exc}")

    try:
        rows = _rows(engine, "SELECT count(*) AS cnt FROM v$session WHERE type='USER'")
        total_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"total_sessions: {exc}")

    try:
        rows = _rows(engine, "SELECT value FROM v$parameter WHERE name='sessions'")
        max_sessions = _safe_int(rows[0].get("VALUE", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"max_sessions: {exc}")

    session_pct = round(total_sessions / max_sessions * 100, 2) if max_sessions > 0 else 0.0

    # ── SGA ──────────────────────────────────────────────────
    sga_total_mb = 0.0
    sga_target_mb = 0.0
    try:
        rows = _rows(engine, "SELECT sum(bytes)/1024/1024 AS mb FROM v$sgainfo")
        sga_total_mb = round(_safe_float(rows[0].get("MB", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"sga_total: {exc}")

    try:
        rows = _rows(engine, "SELECT value/1024/1024 AS mb FROM v$parameter WHERE name='sga_target'")
        sga_target_mb = round(_safe_float(rows[0].get("MB", 0.0)), 2) if rows else 0.0
    except Exception:
        pass

    sga_used_pct = round(sga_total_mb / sga_target_mb * 100, 1) if sga_target_mb > 0 else 0.0

    # ── PGA ──────────────────────────────────────────────────
    pga_mb = 0.0
    pga_target_mb = 0.0
    pga_used_pct = 0.0
    try:
        rows = _rows(engine, "SELECT sum(pga_alloc_mem)/1024/1024 AS mb FROM v$process")
        pga_mb = round(_safe_float(rows[0].get("MB", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"pga: {exc}")

    try:
        rows = _rows(engine, "SELECT value/1024/1024 AS mb FROM v$parameter WHERE name='pga_aggregate_target'")
        pga_target_mb = round(_safe_float(rows[0].get("MB", 0.0)), 2) if rows else 0.0
        if pga_target_mb > 0:
            pga_used_pct = round(pga_mb / pga_target_mb * 100, 1)
    except Exception:
        pass

    # ── DB Size ───────────────────────────────────────────────
    db_size_gb = 0.0
    try:
        rows = _rows(engine, "SELECT sum(bytes)/1024/1024/1024 AS size_gb FROM dba_data_files")
        db_size_gb = round(_safe_float(rows[0].get("SIZE_GB", 0.0)), 4) if rows else 0.0
    except Exception as exc:
        errors.append(f"db_size: {exc}")

    # ── Buffer Cache Hit ──────────────────────────────────────
    buffer_cache_hit_pct = 0.0
    try:
        rows = _rows(
            engine,
            """SELECT ROUND(1 - phyrds / (dbgets + NULLIF(consists, 0)), 4) * 100 AS pct
               FROM (
                   SELECT sum(physical_reads) phyrds,
                          sum(db_block_gets)   dbgets,
                          sum(consistent_gets) consists
                   FROM v$buffer_pool_statistics
               )"""
        )
        buffer_cache_hit_pct = round(_safe_float(rows[0].get("PCT", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"buffer_cache_hit: {exc}")

    # ── Library Cache Hit ─────────────────────────────────────
    library_cache_hit_pct = 0.0
    try:
        rows = _rows(
            engine,
            """SELECT ROUND(sum(pinhits) / NULLIF(sum(pins), 0) * 100, 2) AS pct
               FROM v$librarycache"""
        )
        library_cache_hit_pct = round(_safe_float(rows[0].get("PCT", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"library_cache_hit: {exc}")

    # ── Top Wait Events ───────────────────────────────────────
    top_waits = []
    try:
        raw = _rows(
            engine,
            """SELECT event, wait_class,
                      total_waits,
                      ROUND(time_waited / 100, 2) AS time_waited_seconds,
                      ROUND(average_wait / 100 * 1000, 2) AS avg_wait_ms
               FROM v$system_event
               WHERE wait_class != 'Idle'
               ORDER BY time_waited DESC
               FETCH FIRST 10 ROWS ONLY"""
        )
        top_waits = [
            {
                "event":               _safe_str(r.get("EVENT")),
                "wait_class":          _safe_str(r.get("WAIT_CLASS")),
                "total_waits":         _safe_int(r.get("TOTAL_WAITS")),
                "time_waited_seconds": round(_safe_float(r.get("TIME_WAITED_SECONDS")), 2),
                "avg_wait_ms":         round(_safe_float(r.get("AVG_WAIT_MS")), 2),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"top_waits: {exc}")

    # ── Top SQL ───────────────────────────────────────────────
    top_sql = []
    try:
        raw = _rows(
            engine,
            """SELECT sql_id,
                      executions,
                      ROUND(elapsed_time / 1000, 2) AS elapsed_ms,
                      ROUND(cpu_time / 1000, 2)     AS cpu_ms,
                      buffer_gets,
                      disk_reads,
                      rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000, 2) AS avg_elapsed_ms,
                      SUBSTR(sql_text, 1, 300) AS sql_text
               FROM v$sql
               WHERE executions > 0
               ORDER BY elapsed_time DESC
               FETCH FIRST 20 ROWS ONLY"""
        )
        top_sql = [
            {
                "sql_id":         _safe_str(r.get("SQL_ID")),
                "executions":     _safe_int(r.get("EXECUTIONS")),
                "elapsed_ms":     round(_safe_float(r.get("ELAPSED_MS")), 2),
                "cpu_ms":         round(_safe_float(r.get("CPU_MS")), 2),
                "buffer_gets":    _safe_int(r.get("BUFFER_GETS")),
                "disk_reads":     _safe_int(r.get("DISK_READS")),
                "rows_processed": _safe_int(r.get("ROWS_PROCESSED")),
                "avg_elapsed_ms": round(_safe_float(r.get("AVG_ELAPSED_MS")), 2),
                "sql_text":       _safe_str(r.get("SQL_TEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"top_sql: {exc}")

    # ── Tablespaces ───────────────────────────────────────────
    tablespaces = []
    try:
        raw = _rows(
            engine,
            """SELECT tablespace_name,
                      ROUND(used_space * 8192 / 1024 / 1024, 2)      AS used_mb,
                      ROUND(tablespace_size * 8192 / 1024 / 1024, 2)  AS total_mb,
                      ROUND(100 * used_space / NULLIF(tablespace_size, 0), 1) AS used_pct
               FROM dba_tablespace_usage_metrics
               ORDER BY used_pct DESC NULLS LAST"""
        )
        tablespaces = [
            {
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "used_mb":  round(_safe_float(r.get("USED_MB")), 2),
                "total_mb": round(_safe_float(r.get("TOTAL_MB")), 2),
                "free_mb":  round(max(0, _safe_float(r.get("TOTAL_MB")) - _safe_float(r.get("USED_MB"))), 2),
                "used_pct": round(_safe_float(r.get("USED_PCT")), 1),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"tablespaces: {exc}")

    # ── Redo Logs ─────────────────────────────────────────────
    redo_logs = []
    try:
        rows = _rows(engine, "SELECT group#, members, bytes/1024/1024 AS size_mb, status, archived FROM v$log ORDER BY group#")
        redo_logs = [
            {
                "group":    _safe_int(r.get("GROUP#")),
                "members":  _safe_int(r.get("MEMBERS")),
                "size_mb":  round(_safe_float(r.get("SIZE_MB")), 2),
                "status":   _safe_str(r.get("STATUS")),
                "archived": _safe_str(r.get("ARCHIVED")),
            }
            for r in rows
        ]
    except Exception as exc:
        errors.append(f"redo_logs: {exc}")

    health_summary = {
        "version":               version,
        "instance_name":         instance_info.get("INSTANCE_NAME", ""),
        "host_name":             instance_info.get("HOST_NAME", ""),
        "status":                instance_info.get("STATUS", ""),
        "startup_time":          instance_info.get("STARTUP_TIME", ""),
        "db_name":               db_info.get("NAME", ""),
        "db_unique_name":        db_info.get("DB_UNIQUE_NAME", ""),
        "log_mode":              db_info.get("LOG_MODE", ""),
        "active_sessions":       active_sessions,
        "total_sessions":        total_sessions,
        "max_sessions":          max_sessions,
        "session_pct":           session_pct,
        "sga_mb":                sga_total_mb,
        "sga_target_mb":         sga_target_mb,
        "sga_used_pct":          sga_used_pct,
        "pga_mb":                pga_mb,
        "pga_target_mb":         pga_target_mb,
        "pga_used_pct":          pga_used_pct,
        "db_size_gb":            db_size_gb,
        "buffer_cache_hit_pct":  buffer_cache_hit_pct,
        "library_cache_hit_pct": library_cache_hit_pct,
    }

    return {
        "status": "success",
        "connection": {
            "id":           conn.id,
            "name":         conn.connection_name,
            "host":         conn.host,
            "port":         conn.port,
            "database":     conn.database_name,
            "service_name": getattr(conn, "service_name", ""),
        },
        "health_summary":        health_summary,
        "overview":              health_summary,
        "memory": {
            "sga_mb":          sga_total_mb,
            "sga_target_mb":   sga_target_mb,
            "sga_used_pct":    sga_used_pct,
            "pga_mb":          pga_mb,
            "pga_target_mb":   pga_target_mb,
            "pga_used_pct":    pga_used_pct,
        },
        "performance": {
            "buffer_cache_hit_pct":  buffer_cache_hit_pct,
            "library_cache_hit_pct": library_cache_hit_pct,
            "active_sessions":       active_sessions,
            "session_pct":           session_pct,
        },
        "tablespaces":  tablespaces,
        "top_sql":      top_sql,
        "wait_events":  top_waits,
        "redo_logs":    redo_logs,
        "errors":       errors,
    }


# ──────────────────────────────────────────────────────────────
#  2. SGA DETAIL   GET /{conn_id}/oracle-sga-detail
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-sga-detail")
def oracle_sga_detail(conn_id: int, db: Session = Depends(get_db)):
    """SGA breakdown: Shared Pool, Buffer Cache, Large Pool, Java Pool, Streams Pool, Fixed SGA."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    pools = []
    try:
        raw = _rows(
            engine,
            """SELECT pool, name, bytes / 1024 / 1024 AS mb
               FROM v$sgastat
               ORDER BY bytes DESC"""
        )
        by_pool = {}
        for r in raw:
            pool = _safe_str(r.get("POOL") or "Fixed SGA")
            if pool not in by_pool:
                by_pool[pool] = 0.0
            by_pool[pool] += _safe_float(r.get("MB"))

        pools = [
            {"pool": k, "mb": round(v, 2)}
            for k, v in sorted(by_pool.items(), key=lambda x: -x[1])
        ]
    except Exception as exc:
        return {"status": "error", "pools": [], "error": str(exc)}

    total_mb = round(sum(p["mb"] for p in pools), 2)

    # also get sgainfo for fixed components
    sga_info = []
    try:
        raw = _rows(engine, "SELECT name, bytes / 1024 / 1024 AS mb, resizeable FROM v$sgainfo")
        sga_info = [
            {
                "name":       _safe_str(r.get("NAME")),
                "mb":         round(_safe_float(r.get("MB")), 2),
                "resizeable": _safe_str(r.get("RESIZEABLE")),
            }
            for r in raw
        ]
    except Exception:
        pass

    return {
        "status":    "success",
        "pools":     pools,
        "sga_info":  sga_info,
        "total_mb":  total_mb,
    }


# ──────────────────────────────────────────────────────────────
#  3. PGA DETAIL   GET /{conn_id}/oracle-pga-detail
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-pga-detail")
def oracle_pga_detail(conn_id: int, db: Session = Depends(get_db)):
    """PGA stats from v$pgastat."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    stats = []
    try:
        raw = _rows(engine, "SELECT name, value, unit FROM v$pgastat ORDER BY name")
        stats = [
            {
                "name":  _safe_str(r.get("NAME")),
                "value": _safe_float(r.get("VALUE")),
                "unit":  _safe_str(r.get("UNIT")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "stats": [], "error": str(exc)}

    def _pga(name):
        for s in stats:
            if s["name"].lower() == name.lower():
                return s["value"]
        return 0.0

    summary = {
        "total_allocated_mb":   round(_pga("total PGA allocated") / 1024 / 1024, 2),
        "total_used_mb":        round(_pga("total PGA used for manual work areas") / 1024 / 1024, 2),
        "aggregate_target_mb":  round(_pga("aggregate PGA target parameter") / 1024 / 1024, 2),
        "cache_hit_pct":        round(_pga("cache hit percentage"), 2),
        "work_areas_active":    int(_pga("total number of PGA work areas active") or 0),
    }

    return {"status": "success", "stats": stats, "summary": summary}


# ──────────────────────────────────────────────────────────────
#  4. SESSIONS   GET /{conn_id}/oracle-sessions
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-sessions")
def oracle_sessions(conn_id: int, db: Session = Depends(get_db)):
    """Sessions from v$session with status, type, wait event, blocking info."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    sessions = []
    try:
        raw = _rows(
            engine,
            """SELECT s.sid,
                      s.serial#      AS serial_number,
                      s.username,
                      s.status,
                      s.type,
                      s.machine,
                      s.program,
                      s.module,
                      s.sql_id,
                      s.event        AS wait_event,
                      s.wait_class,
                      s.seconds_in_wait,
                      s.blocking_session,
                      s.state,
                      TO_CHAR(s.logon_time, 'YYYY-MM-DD HH24:MI:SS') AS logon_time,
                      SUBSTR(q.sql_text, 1, 200) AS sql_text
               FROM v$session s
               LEFT JOIN v$sql q ON s.sql_id = q.sql_id AND ROWNUM <= 1
               ORDER BY s.seconds_in_wait DESC NULLS LAST"""
        )
        sessions = [
            {
                "sid":              _safe_int(r.get("SID")),
                "serial_number":    _safe_int(r.get("SERIAL_NUMBER")),
                "username":         _safe_str(r.get("USERNAME")),
                "status":           _safe_str(r.get("STATUS")),
                "type":             _safe_str(r.get("TYPE")),
                "machine":          _safe_str(r.get("MACHINE")),
                "program":          _safe_str(r.get("PROGRAM")),
                "module":           _safe_str(r.get("MODULE")),
                "sql_id":           _safe_str(r.get("SQL_ID")),
                "wait_event":       _safe_str(r.get("WAIT_EVENT")),
                "wait_class":       _safe_str(r.get("WAIT_CLASS")),
                "seconds_in_wait":  _safe_int(r.get("SECONDS_IN_WAIT")),
                "blocking_session": _safe_int(r.get("BLOCKING_SESSION")) if r.get("BLOCKING_SESSION") else None,
                "state":            _safe_str(r.get("STATE")),
                "logon_time":       _safe_str(r.get("LOGON_TIME")),
                "sql_text":         _safe_str(r.get("SQL_TEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "sessions": [], "error": str(exc)}

    active    = [s for s in sessions if s["status"] == "ACTIVE"]
    inactive  = [s for s in sessions if s["status"] == "INACTIVE"]
    blocking  = [s for s in sessions if s["blocking_session"] is not None]
    user_sess = [s for s in sessions if s["type"] == "USER"]
    bg_sess   = [s for s in sessions if s["type"] == "BACKGROUND"]

    return {
        "status":   "success",
        "sessions": sessions,
        "summary": {
            "total":      len(sessions),
            "active":     len(active),
            "inactive":   len(inactive),
            "blocking":   len(blocking),
            "user":       len(user_sess),
            "background": len(bg_sess),
        },
    }


# ──────────────────────────────────────────────────────────────
#  5. TOP SQL   GET /{conn_id}/oracle-top-sql
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-top-sql")
def oracle_top_sql(conn_id: int, db: Session = Depends(get_db)):
    """Top SQL from v$sql ordered by elapsed time."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    sql_list = []
    try:
        raw = _rows(
            engine,
            """SELECT sql_id,
                      executions,
                      ROUND(elapsed_time / 1000, 2)                         AS elapsed_ms,
                      ROUND(cpu_time / 1000, 2)                             AS cpu_ms,
                      buffer_gets,
                      disk_reads,
                      rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000, 2) AS avg_elapsed_ms,
                      ROUND(cpu_time     / NULLIF(executions, 0) / 1000, 2) AS avg_cpu_ms,
                      parsing_schema_name,
                      last_active_time,
                      SUBSTR(sql_text, 1, 500) AS sql_text,
                      SUBSTR(sql_fulltext, 1, 2000) AS sql_fulltext
               FROM v$sql
               WHERE executions > 0
               ORDER BY elapsed_time DESC
               FETCH FIRST 50 ROWS ONLY"""
        )
        sql_list = [
            {
                "sql_id":              _safe_str(r.get("SQL_ID")),
                "executions":          _safe_int(r.get("EXECUTIONS")),
                "elapsed_ms":          round(_safe_float(r.get("ELAPSED_MS")), 2),
                "cpu_ms":              round(_safe_float(r.get("CPU_MS")), 2),
                "buffer_gets":         _safe_int(r.get("BUFFER_GETS")),
                "disk_reads":          _safe_int(r.get("DISK_READS")),
                "rows_processed":      _safe_int(r.get("ROWS_PROCESSED")),
                "avg_elapsed_ms":      round(_safe_float(r.get("AVG_ELAPSED_MS")), 2),
                "avg_cpu_ms":          round(_safe_float(r.get("AVG_CPU_MS")), 2),
                "parsing_schema_name": _safe_str(r.get("PARSING_SCHEMA_NAME")),
                "last_active_time":    _safe_str(r.get("LAST_ACTIVE_TIME")),
                "sql_text":            _safe_str(r.get("SQL_TEXT")),
                "sql_fulltext":        _safe_str(r.get("SQL_FULLTEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "sql": [], "error": str(exc)}

    return {"status": "success", "total": len(sql_list), "sql": sql_list}


# ──────────────────────────────────────────────────────────────
#  6. WAIT EVENTS   GET /{conn_id}/oracle-wait-events
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-wait-events")
def oracle_wait_events(conn_id: int, db: Session = Depends(get_db)):
    """Wait events from v$system_event, excluding idle waits."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    events = []
    try:
        raw = _rows(
            engine,
            """SELECT event,
                      wait_class,
                      total_waits,
                      total_timeouts,
                      ROUND(time_waited / 100, 2)      AS time_waited_seconds,
                      ROUND(average_wait / 100 * 1000, 2) AS avg_wait_ms
               FROM v$system_event
               WHERE wait_class != 'Idle'
               ORDER BY time_waited DESC
               FETCH FIRST 30 ROWS ONLY"""
        )
        events = [
            {
                "event":               _safe_str(r.get("EVENT")),
                "wait_class":          _safe_str(r.get("WAIT_CLASS")),
                "total_waits":         _safe_int(r.get("TOTAL_WAITS")),
                "total_timeouts":      _safe_int(r.get("TOTAL_TIMEOUTS")),
                "time_waited_seconds": round(_safe_float(r.get("TIME_WAITED_SECONDS")), 2),
                "avg_wait_ms":         round(_safe_float(r.get("AVG_WAIT_MS")), 2),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "events": [], "error": str(exc)}

    # wait class breakdown
    by_class = {}
    for e in events:
        wc = e["wait_class"]
        by_class[wc] = by_class.get(wc, 0.0) + e["time_waited_seconds"]
    class_breakdown = [{"wait_class": k, "time_seconds": round(v, 2)} for k, v in sorted(by_class.items(), key=lambda x: -x[1])]

    return {"status": "success", "events": events, "class_breakdown": class_breakdown}


# ──────────────────────────────────────────────────────────────
#  7. TABLESPACES   GET /{conn_id}/oracle-tablespaces
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-tablespaces")
def oracle_tablespaces(conn_id: int, db: Session = Depends(get_db)):
    """Tablespaces with status, usage, autoextend from dba_tablespace_usage_metrics + dba_tablespaces."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    tablespaces = []
    try:
        raw = _rows(
            engine,
            """SELECT m.tablespace_name,
                      t.status,
                      t.contents,
                      t.extent_management,
                      t.logging,
                      ROUND(m.used_space * 8192 / 1024 / 1024, 2)      AS used_mb,
                      ROUND(m.tablespace_size * 8192 / 1024 / 1024, 2)  AS total_mb,
                      ROUND((m.tablespace_size - m.used_space) * 8192 / 1024 / 1024, 2) AS free_mb,
                      ROUND(100 * m.used_space / NULLIF(m.tablespace_size, 0), 1) AS used_pct
               FROM dba_tablespace_usage_metrics m
               JOIN dba_tablespaces t ON t.tablespace_name = m.tablespace_name
               ORDER BY used_pct DESC NULLS LAST"""
        )
        tablespaces = [
            {
                "tablespace_name":    _safe_str(r.get("TABLESPACE_NAME")),
                "status":             _safe_str(r.get("STATUS")),
                "contents":           _safe_str(r.get("CONTENTS")),
                "extent_management":  _safe_str(r.get("EXTENT_MANAGEMENT")),
                "logging":            _safe_str(r.get("LOGGING")),
                "used_mb":            round(_safe_float(r.get("USED_MB")), 2),
                "total_mb":           round(_safe_float(r.get("TOTAL_MB")), 2),
                "free_mb":            round(_safe_float(r.get("FREE_MB")), 2),
                "used_pct":           round(_safe_float(r.get("USED_PCT")), 1),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "tablespaces": [], "error": str(exc)}

    return {
        "status":      "success",
        "tablespaces": tablespaces,
        "total":       len(tablespaces),
        "critical":    [t for t in tablespaces if t["used_pct"] > 85],
        "warning":     [t for t in tablespaces if 70 < t["used_pct"] <= 85],
    }


# ──────────────────────────────────────────────────────────────
#  8. OBJECTS   GET /{conn_id}/oracle-objects
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-objects")
def oracle_objects(conn_id: int, db: Session = Depends(get_db)):
    """Objects from dba_objects grouped by type, top tables by size."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    by_type = []
    try:
        raw = _rows(
            engine,
            """SELECT object_type, count(*) AS cnt
               FROM dba_objects
               WHERE owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB',
                                   'APEX_030200','APEX_040200','CTXSYS','MDSYS',
                                   'OLAPSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA')
               GROUP BY object_type
               ORDER BY cnt DESC"""
        )
        by_type = [
            {"object_type": _safe_str(r.get("OBJECT_TYPE")), "count": _safe_int(r.get("CNT"))}
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "by_type": [], "top_tables": [], "error": str(exc)}

    top_tables = []
    try:
        raw = _rows(
            engine,
            """SELECT owner, segment_name AS table_name,
                      ROUND(sum(bytes) / 1024 / 1024, 2) AS size_mb
               FROM dba_segments
               WHERE segment_type = 'TABLE'
                 AND owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB')
               GROUP BY owner, segment_name
               ORDER BY size_mb DESC
               FETCH FIRST 20 ROWS ONLY"""
        )
        top_tables = [
            {
                "owner":      _safe_str(r.get("OWNER")),
                "table_name": _safe_str(r.get("TABLE_NAME")),
                "size_mb":    round(_safe_float(r.get("SIZE_MB")), 2),
            }
            for r in raw
        ]
    except Exception:
        pass

    def _count(otype):
        for b in by_type:
            if b["object_type"].upper() == otype.upper():
                return b["count"]
        return 0

    summary = {
        "total_objects":    sum(b["count"] for b in by_type),
        "tables":           _count("TABLE"),
        "indexes":          _count("INDEX"),
        "views":            _count("VIEW"),
        "procedures":       _count("PROCEDURE"),
        "functions":        _count("FUNCTION"),
        "packages":         _count("PACKAGE"),
        "triggers":         _count("TRIGGER"),
        "sequences":        _count("SEQUENCE"),
        "synonyms":         _count("SYNONYM"),
    }

    invalid_count = 0
    try:
        rows = _rows(
            engine,
            """SELECT count(*) AS cnt FROM dba_objects
               WHERE status = 'INVALID'
                 AND owner NOT IN ('SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB')"""
        )
        invalid_count = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception:
        pass

    summary["invalid_objects"] = invalid_count

    return {
        "status":     "success",
        "by_type":    by_type,
        "top_tables": top_tables,
        "summary":    summary,
    }


# ──────────────────────────────────────────────────────────────
#  9. USERS   GET /{conn_id}/oracle-users
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-users")
def oracle_users(conn_id: int, db: Session = Depends(get_db)):
    """Users from dba_users."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    users = []
    try:
        raw = _rows(
            engine,
            """SELECT username,
                      account_status,
                      TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created,
                      profile,
                      default_tablespace,
                      temporary_tablespace,
                      TO_CHAR(last_login, 'YYYY-MM-DD HH24:MI:SS') AS last_login
               FROM dba_users
               ORDER BY username"""
        )
        users = [
            {
                "username":             _safe_str(r.get("USERNAME")),
                "account_status":       _safe_str(r.get("ACCOUNT_STATUS")),
                "created":              _safe_str(r.get("CREATED")),
                "profile":              _safe_str(r.get("PROFILE")),
                "default_tablespace":   _safe_str(r.get("DEFAULT_TABLESPACE")),
                "temporary_tablespace": _safe_str(r.get("TEMPORARY_TABLESPACE")),
                "last_login":           _safe_str(r.get("LAST_LOGIN")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "users": [], "error": str(exc)}

    open_count    = sum(1 for u in users if u["account_status"] == "OPEN")
    locked_count  = sum(1 for u in users if "LOCKED" in u["account_status"])
    expired_count = sum(1 for u in users if "EXPIRED" in u["account_status"])

    return {
        "status": "success",
        "users":  users,
        "total":  len(users),
        "open":   open_count,
        "locked": locked_count,
        "expired": expired_count,
    }


# ──────────────────────────────────────────────────────────────
# 10. REDO LOGS   GET /{conn_id}/oracle-redo-logs
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-redo-logs")
def oracle_redo_logs(conn_id: int, db: Session = Depends(get_db)):
    """Redo logs from v$log + v$logfile."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    log_groups = []
    try:
        raw = _rows(
            engine,
            """SELECT l.group#,
                      l.thread#,
                      l.sequence#,
                      l.members,
                      ROUND(l.bytes / 1024 / 1024, 2) AS size_mb,
                      l.status,
                      l.archived,
                      l.first_change#,
                      TO_CHAR(l.first_time, 'YYYY-MM-DD HH24:MI:SS') AS first_time
               FROM v$log l
               ORDER BY l.group#"""
        )
        log_groups = [
            {
                "group":         _safe_int(r.get("GROUP#")),
                "thread":        _safe_int(r.get("THREAD#")),
                "sequence":      _safe_int(r.get("SEQUENCE#")),
                "members":       _safe_int(r.get("MEMBERS")),
                "size_mb":       round(_safe_float(r.get("SIZE_MB")), 2),
                "status":        _safe_str(r.get("STATUS")),
                "archived":      _safe_str(r.get("ARCHIVED")),
                "first_change":  _safe_int(r.get("FIRST_CHANGE#")),
                "first_time":    _safe_str(r.get("FIRST_TIME")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "log_groups": [], "logfiles": [], "error": str(exc)}

    logfiles = []
    try:
        raw = _rows(
            engine,
            """SELECT l.group#,
                      lf.member,
                      lf.type,
                      lf.status AS file_status
               FROM v$logfile lf
               JOIN v$log l ON l.group# = lf.group#
               ORDER BY lf.group#"""
        )
        logfiles = [
            {
                "group":       _safe_int(r.get("GROUP#")),
                "member":      _safe_str(r.get("MEMBER")),
                "type":        _safe_str(r.get("TYPE")),
                "file_status": _safe_str(r.get("FILE_STATUS")),
            }
            for r in raw
        ]
    except Exception:
        pass

    db_info = {}
    try:
        rows = _rows(engine, "SELECT log_mode FROM v$database")
        if rows:
            db_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception:
        pass

    return {
        "status":     "success",
        "log_groups": log_groups,
        "logfiles":   logfiles,
        "log_mode":   db_info.get("LOG_MODE", ""),
        "current_group": next((g["group"] for g in log_groups if g["status"] == "CURRENT"), None),
    }


# ──────────────────────────────────────────────────────────────
# 11. DATA GUARD   GET /{conn_id}/oracle-data-guard
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-data-guard")
def oracle_data_guard(conn_id: int, db: Session = Depends(get_db)):
    """Data Guard status messages, archive dest status, standby log."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    dg_status = []
    try:
        raw = _rows(
            engine,
            """SELECT severity,
                      TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
                      dest_id,
                      message,
                      callout
               FROM v$dataguard_status
               ORDER BY timestamp DESC
               FETCH FIRST 50 ROWS ONLY"""
        )
        dg_status = [
            {
                "severity":  _safe_str(r.get("SEVERITY")),
                "timestamp": _safe_str(r.get("TIMESTAMP")),
                "dest_id":   _safe_int(r.get("DEST_ID")),
                "message":   _safe_str(r.get("MESSAGE")),
                "callout":   _safe_str(r.get("CALLOUT")),
            }
            for r in raw
        ]
    except Exception:
        pass  # not configured

    archive_dests = []
    try:
        raw = _rows(
            engine,
            """SELECT dest_id,
                      dest_name,
                      status,
                      target,
                      archiver,
                      schedule,
                      destination,
                      applied_scn,
                      db_unique_name,
                      synchronization_status
               FROM v$archive_dest_status
               WHERE status != 'INACTIVE'"""
        )
        archive_dests = [
            {
                "dest_id":                _safe_int(r.get("DEST_ID")),
                "dest_name":              _safe_str(r.get("DEST_NAME")),
                "status":                 _safe_str(r.get("STATUS")),
                "target":                 _safe_str(r.get("TARGET")),
                "archiver":               _safe_str(r.get("ARCHIVER")),
                "schedule":               _safe_str(r.get("SCHEDULE")),
                "destination":            _safe_str(r.get("DESTINATION")),
                "applied_scn":            _safe_int(r.get("APPLIED_SCN")),
                "db_unique_name":         _safe_str(r.get("DB_UNIQUE_NAME")),
                "synchronization_status": _safe_str(r.get("SYNCHRONIZATION_STATUS")),
            }
            for r in raw
        ]
    except Exception:
        pass

    standby_logs = []
    try:
        raw = _rows(
            engine,
            """SELECT group#, thread#, sequence#,
                      ROUND(bytes / 1024 / 1024, 2) AS size_mb,
                      status
               FROM v$standby_log
               ORDER BY group#"""
        )
        standby_logs = [
            {
                "group":    _safe_int(r.get("GROUP#")),
                "thread":   _safe_int(r.get("THREAD#")),
                "sequence": _safe_int(r.get("SEQUENCE#")),
                "size_mb":  round(_safe_float(r.get("SIZE_MB")), 2),
                "status":   _safe_str(r.get("STATUS")),
            }
            for r in raw
        ]
    except Exception:
        pass

    configured = len(dg_status) > 0 or len(archive_dests) > 1 or len(standby_logs) > 0

    return {
        "status":        "success",
        "configured":    configured,
        "dg_status":     dg_status,
        "archive_dests": archive_dests,
        "standby_logs":  standby_logs,
    }


# ──────────────────────────────────────────────────────────────
# 12. PROCESSES   GET /{conn_id}/oracle-processes
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-processes")
def oracle_processes(conn_id: int, db: Session = Depends(get_db)):
    """Background processes from v$bgprocess and v$process."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    processes = []
    try:
        raw = _rows(
            engine,
            """SELECT b.pname,
                      b.description,
                      p.pid,
                      p.spid,
                      ROUND(p.pga_used_mem / 1024 / 1024, 2)  AS pga_used_mb,
                      ROUND(p.pga_alloc_mem / 1024 / 1024, 2) AS pga_alloc_mb,
                      ROUND(p.pga_max_mem / 1024 / 1024, 2)   AS pga_max_mb,
                      p.background
               FROM v$bgprocess b
               JOIN v$process p ON p.addr = b.paddr
               WHERE b.paddr != '00'
               ORDER BY p.pga_alloc_mem DESC NULLS LAST"""
        )
        processes = [
            {
                "pname":        _safe_str(r.get("PNAME")),
                "description":  _safe_str(r.get("DESCRIPTION")),
                "pid":          _safe_int(r.get("PID")),
                "spid":         _safe_str(r.get("SPID")),
                "pga_used_mb":  round(_safe_float(r.get("PGA_USED_MB")), 2),
                "pga_alloc_mb": round(_safe_float(r.get("PGA_ALLOC_MB")), 2),
                "pga_max_mb":   round(_safe_float(r.get("PGA_MAX_MB")), 2),
                "background":   _safe_str(r.get("BACKGROUND")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "processes": [], "error": str(exc)}

    total_pga_mb = round(sum(p["pga_alloc_mb"] for p in processes), 2)

    return {
        "status":        "success",
        "processes":     processes,
        "total":         len(processes),
        "total_pga_mb":  total_pga_mb,
    }


# ──────────────────────────────────────────────────────────────
# 13. SYSTEM STATS   GET /{conn_id}/oracle-system-stats
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-system-stats")
def oracle_system_stats(conn_id: int, db: Session = Depends(get_db)):
    """Key system statistics from v$sysstat."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    stats = []
    try:
        raw = _rows(
            engine,
            """SELECT name, value, class
               FROM v$sysstat
               WHERE value > 0
               ORDER BY class, name"""
        )
        stats = [
            {
                "name":  _safe_str(r.get("NAME")),
                "value": _safe_float(r.get("VALUE")),
                "class": _safe_int(r.get("CLASS")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "stats": [], "error": str(exc)}

    KEY_STATS = [
        "physical reads", "physical writes", "db block gets", "consistent gets",
        "redo size", "user commits", "user rollbacks", "execute count",
        "parse count (total)", "parse count (hard)", "sorts (memory)",
        "sorts (disk)", "table scans (long tables)", "table fetch by rowid",
        "table scan rows gotten", "session logical reads",
        "opened cursors cumulative", "logons cumulative",
        "enqueue waits", "enqueue deadlocks",
    ]

    key_stats_map = {}
    for s in stats:
        if s["name"].lower() in KEY_STATS:
            key_stats_map[s["name"]] = s["value"]

    CLASS_NAMES = {
        1: "User", 2: "Redo", 4: "Enqueue", 8: "Cache", 16: "OS",
        32: "Real Application Clusters", 64: "SQL", 128: "Debug",
    }
    by_class = {}
    for s in stats:
        cls_num = s["class"]
        cls_name = CLASS_NAMES.get(cls_num, f"Class {cls_num}")
        if cls_name not in by_class:
            by_class[cls_name] = []
        by_class[cls_name].append({"name": s["name"], "value": s["value"]})

    return {
        "status":        "success",
        "stats":         stats,
        "key_stats":     key_stats_map,
        "by_class":      by_class,
        "total":         len(stats),
    }


# ──────────────────────────────────────────────────────────────
# 14. AWR SQL   GET /{conn_id}/oracle-awr-sql
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-awr-sql")
def oracle_awr_sql(conn_id: int, db: Session = Depends(get_db)):
    """Top SQL by elapsed from v$sql (same as AWR-style, no license required via v$sql)."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    sql_list = []
    try:
        raw = _rows(
            engine,
            """SELECT sql_id,
                      executions,
                      ROUND(elapsed_time / 1000000, 4) AS elapsed_sec,
                      ROUND(cpu_time / 1000000, 4)     AS cpu_sec,
                      buffer_gets,
                      disk_reads,
                      rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000000, 4) AS avg_elapsed_sec,
                      parsing_schema_name,
                      module,
                      action,
                      last_active_time,
                      SUBSTR(sql_text, 1, 500) AS sql_text
               FROM v$sql
               WHERE executions > 0
               ORDER BY elapsed_time DESC
               FETCH FIRST 50 ROWS ONLY"""
        )
        sql_list = [
            {
                "sql_id":              _safe_str(r.get("SQL_ID")),
                "executions":          _safe_int(r.get("EXECUTIONS")),
                "elapsed_sec":         round(_safe_float(r.get("ELAPSED_SEC")), 4),
                "cpu_sec":             round(_safe_float(r.get("CPU_SEC")), 4),
                "buffer_gets":         _safe_int(r.get("BUFFER_GETS")),
                "disk_reads":          _safe_int(r.get("DISK_READS")),
                "rows_processed":      _safe_int(r.get("ROWS_PROCESSED")),
                "avg_elapsed_sec":     round(_safe_float(r.get("AVG_ELAPSED_SEC")), 4),
                "parsing_schema_name": _safe_str(r.get("PARSING_SCHEMA_NAME")),
                "module":              _safe_str(r.get("MODULE")),
                "action":              _safe_str(r.get("ACTION")),
                "last_active_time":    _safe_str(r.get("LAST_ACTIVE_TIME")),
                "sql_text":            _safe_str(r.get("SQL_TEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "sql": [], "error": str(exc)}

    return {"status": "success", "total": len(sql_list), "sql": sql_list}


# ──────────────────────────────────────────────────────────────
#  LEGACY — MONITORING DASHBOARD  (kept for compatibility)
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/monitoring-dashboard")
def oracle_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Legacy endpoint — delegates to the new oracle-dashboard endpoint.
    Kept for backward compatibility with existing frontend code.
    """
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")

    try:
        engine = _oracle_engine(conn)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine creation failed: {str(e)}")

    errors = []

    version = ""
    try:
        rows = _rows(engine, "SELECT banner FROM v$version WHERE rownum=1")
        version = rows[0].get("BANNER", "") if rows else ""
    except Exception as exc:
        errors.append(f"version: {exc}")

    instance_info = {}
    try:
        rows = _rows(engine, "SELECT instance_name, host_name, version, status, startup_time FROM v$instance")
        if rows:
            instance_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception as exc:
        errors.append(f"instance: {exc}")

    db_info = {}
    try:
        rows = _rows(engine, "SELECT name, db_unique_name, log_mode FROM v$database")
        if rows:
            db_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception as exc:
        errors.append(f"database: {exc}")

    active_sessions = 0
    total_sessions  = 0
    max_sessions    = 0
    try:
        rows = _rows(engine, "SELECT count(*) AS cnt FROM v$session WHERE status='ACTIVE' AND type='USER'")
        active_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"active_sessions: {exc}")

    try:
        rows = _rows(engine, "SELECT count(*) AS cnt FROM v$session WHERE type='USER'")
        total_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"total_sessions: {exc}")

    try:
        rows = _rows(engine, "SELECT value FROM v$parameter WHERE name='sessions'")
        max_sessions = _safe_int(rows[0].get("VALUE", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"max_sessions: {exc}")

    session_pct = round(total_sessions / max_sessions * 100, 2) if max_sessions > 0 else 0.0

    sga_stats = []
    sga_mb_total = 0.0
    try:
        sga_stats = _rows(engine, "SELECT name, bytes/1024/1024 AS mb FROM v$sgastat WHERE pool IS NULL ORDER BY bytes DESC")
        sga_stats = [{"name": _safe_str(r.get("NAME")), "mb": round(_safe_float(r.get("MB")), 2)} for r in sga_stats]
        sga_mb_total = round(sum(r["mb"] for r in sga_stats), 2)
    except Exception as exc:
        errors.append(f"sga: {exc}")

    pga_mb = 0.0
    try:
        rows = _rows(engine, "SELECT sum(pga_alloc_mem)/1024/1024 AS pga_mb FROM v$process")
        pga_mb = round(_safe_float(rows[0].get("PGA_MB", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"pga: {exc}")

    db_size_gb = 0.0
    try:
        rows = _rows(engine, "SELECT sum(bytes)/1024/1024/1024 AS size_gb FROM dba_data_files")
        db_size_gb = round(_safe_float(rows[0].get("SIZE_GB", 0.0)), 4) if rows else 0.0
    except Exception as exc:
        errors.append(f"db_size: {exc}")

    tablespaces = []
    try:
        tablespaces = _rows(
            engine,
            """SELECT tablespace_name,
                      ROUND(used_space*8192/1024/1024,2)       AS used_mb,
                      ROUND(tablespace_size*8192/1024/1024,2)  AS total_mb,
                      ROUND(100*used_space/NULLIF(tablespace_size,0),1) AS used_pct
               FROM dba_tablespace_usage_metrics
               ORDER BY used_pct DESC NULLS LAST"""
        )
        tablespaces = [
            {
                "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
                "used_mb":  round(_safe_float(r.get("USED_MB")), 2),
                "total_mb": round(_safe_float(r.get("TOTAL_MB")), 2),
                "used_pct": round(_safe_float(r.get("USED_PCT")), 1),
            }
            for r in tablespaces
        ]
    except Exception as exc:
        errors.append(f"tablespaces: {exc}")

    active_sql = []
    try:
        active_sql = _rows(
            engine,
            """SELECT s.sid, s.serial#, s.username, s.status, s.machine, s.module,
                      ROUND((sysdate-s.logon_time)*24*60,1) AS session_min,
                      SUBSTR(q.sql_text,1,200) AS sql_text
               FROM v$session s
               LEFT JOIN v$sql q ON s.sql_id = q.sql_id
               WHERE s.type='USER' AND s.status='ACTIVE'
               ORDER BY session_min DESC
               FETCH FIRST 20 ROWS ONLY"""
        )
        active_sql = [
            {
                "sid":         _safe_int(r.get("SID")),
                "serial":      _safe_int(r.get("SERIAL#")),
                "username":    _safe_str(r.get("USERNAME")),
                "status":      _safe_str(r.get("STATUS")),
                "machine":     _safe_str(r.get("MACHINE")),
                "module":      _safe_str(r.get("MODULE")),
                "session_min": _safe_float(r.get("SESSION_MIN")),
                "sql_text":    _safe_str(r.get("SQL_TEXT")),
            }
            for r in active_sql
        ]
    except Exception as exc:
        errors.append(f"active_sql: {exc}")

    wait_events = []
    try:
        wait_events = _rows(
            engine,
            """SELECT event, count(*) AS cnt, round(avg(wait_time_micro)/1000000,3) AS avg_wait_sec
               FROM v$session_wait
               WHERE wait_class != 'Idle'
               GROUP BY event
               ORDER BY cnt DESC
               FETCH FIRST 10 ROWS ONLY"""
        )
        wait_events = [
            {"event": _safe_str(r.get("EVENT")), "count": _safe_int(r.get("CNT")), "avg_wait_sec": round(_safe_float(r.get("AVG_WAIT_SEC")), 3)}
            for r in wait_events
        ]
    except Exception as exc:
        errors.append(f"wait_events: {exc}")

    buffer_cache_hit_pct = 0.0
    try:
        rows = _rows(
            engine,
            """SELECT ROUND(1-phyrds/(dbgets+NULLIF(consists,0)),4)*100 AS pct
               FROM (SELECT sum(physical_reads) phyrds, sum(db_block_gets) dbgets, sum(consistent_gets) consists FROM v$buffer_pool_statistics)"""
        )
        buffer_cache_hit_pct = round(_safe_float(rows[0].get("PCT", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"buffer_cache_hit: {exc}")

    health_summary = {
        "version": version,
        "instance_name": instance_info.get("INSTANCE_NAME", ""),
        "host_name":     instance_info.get("HOST_NAME", ""),
        "status":        instance_info.get("STATUS", ""),
        "startup_time":  instance_info.get("STARTUP_TIME", ""),
        "db_name":       db_info.get("NAME", ""),
        "db_unique_name":db_info.get("DB_UNIQUE_NAME", ""),
        "log_mode":      db_info.get("LOG_MODE", ""),
        "active_sessions": active_sessions,
        "total_sessions":  total_sessions,
        "max_sessions":    max_sessions,
        "session_pct":     session_pct,
        "sga_mb":          sga_mb_total,
        "pga_mb":          pga_mb,
        "db_size_gb":      db_size_gb,
        "buffer_cache_hit_pct": buffer_cache_hit_pct,
    }

    redo_logs = []
    try:
        rows = _rows(engine, "SELECT group#, members, bytes/1024/1024 AS size_mb, status, archived FROM v$log ORDER BY group#")
        redo_logs = [
            {"group": _safe_int(r.get("GROUP#")), "members": _safe_int(r.get("MEMBERS")),
             "size_mb": round(_safe_float(r.get("SIZE_MB")), 2), "status": _safe_str(r.get("STATUS")), "archived": _safe_str(r.get("ARCHIVED"))}
            for r in rows
        ]
    except Exception as exc:
        errors.append(f"redo_logs: {exc}")

    return {
        "status": "success",
        "connection": {"id": conn.id, "name": conn.connection_name, "host": conn.host, "port": conn.port, "database": conn.database_name},
        "health_summary":  health_summary,
        "overview":        health_summary,
        "memory":          {"sga_mb": sga_mb_total, "pga_mb": pga_mb, "sga_used_pct": 0.0, "pga_used_pct": 0.0, "sga_details": sga_stats},
        "performance":     {"buffer_cache_hit_pct": buffer_cache_hit_pct, "active_sessions": active_sessions, "session_pct": session_pct},
        "sga_details":     sga_stats,
        "tablespaces":     tablespaces,
        "active_sql":      active_sql,
        "active_sessions": active_sql,
        "top_sql":         active_sql,
        "wait_events":     wait_events,
        "redo_logs":       redo_logs,
        "sql_stats":       {},
        "objects":         [],
        "asm_diskgroups":  [],
        "segments":        [],
        "errors":          errors,
    }


# ──────────────────────────────────────────────────────────────
#  SLOW QUERIES   GET /{conn_id}/oracle-slow-queries
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-slow-queries")
def oracle_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """Top 50 slowest SQL statements from v$sqlarea ranked by average elapsed time."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    try:
        raw = _rows(
            engine,
            """SELECT sql_id,
                      executions,
                      ROUND(elapsed_time/NULLIF(executions,0)/1000000,4) AS avg_elapsed_sec,
                      ROUND(cpu_time/NULLIF(executions,0)/1000000,4)     AS avg_cpu_sec,
                      ROUND(disk_reads/NULLIF(executions,0),0)           AS avg_disk_reads,
                      ROUND(buffer_gets/NULLIF(executions,0),0)          AS avg_buffer_gets,
                      rows_processed,
                      last_active_time,
                      SUBSTR(sql_text,1,400)                             AS sql_text,
                      parsing_schema_name
               FROM v$sqlarea
               WHERE executions > 0
               ORDER BY elapsed_time/NULLIF(executions,0) DESC
               FETCH FIRST 50 ROWS ONLY"""
        )
        queries = [
            {
                "sql_id":              _safe_str(r.get("SQL_ID")),
                "executions":          _safe_int(r.get("EXECUTIONS")),
                "avg_elapsed_sec":     round(_safe_float(r.get("AVG_ELAPSED_SEC")), 4),
                "avg_cpu_sec":         round(_safe_float(r.get("AVG_CPU_SEC")), 4),
                "avg_disk_reads":      _safe_int(r.get("AVG_DISK_READS")),
                "avg_buffer_gets":     _safe_int(r.get("AVG_BUFFER_GETS")),
                "rows_processed":      _safe_int(r.get("ROWS_PROCESSED")),
                "last_active_time":    _safe_str(r.get("LAST_ACTIVE_TIME")),
                "sql_text":            _safe_str(r.get("SQL_TEXT")),
                "parsing_schema_name": _safe_str(r.get("PARSING_SCHEMA_NAME")),
            }
            for r in raw
        ]
        return {"status": "success", "source": "v$sqlarea", "total": len(queries), "queries": queries, "error": None}
    except Exception as exc:
        return {"status": "error", "source": "v$sqlarea", "total": 0, "queries": [], "error": str(exc)}


# ──────────────────────────────────────────────────────────────
#  ERROR LOGS   GET /{conn_id}/oracle-error-logs
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-error-logs")
def oracle_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """Alert log entries from v$diag_alert_ext (12c+), falls back to v$log."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    alert_logs = []
    source = ""
    note   = ""

    try:
        raw = _rows(
            engine,
            """SELECT originating_timestamp, organization_id, component_id,
                      message_text, message_level
               FROM v$diag_alert_ext
               WHERE message_type != 0
               ORDER BY originating_timestamp DESC
               FETCH FIRST 200 ROWS ONLY"""
        )
        alert_logs = [
            {
                "originating_timestamp": _safe_str(r.get("ORIGINATING_TIMESTAMP")),
                "organization_id":       _safe_str(r.get("ORGANIZATION_ID")),
                "component_id":          _safe_str(r.get("COMPONENT_ID")),
                "message_text":          _safe_str(r.get("MESSAGE_TEXT")),
                "message_level":         _safe_int(r.get("MESSAGE_LEVEL")),
            }
            for r in raw
        ]
        source = "v$diag_alert_ext"
    except Exception:
        try:
            raw = _rows(
                engine,
                """SELECT instance_number, thread#, sequence#, first_change#,
                          first_time, next_time, status
                   FROM v$log
                   ORDER BY first_time DESC
                   FETCH FIRST 20 ROWS ONLY"""
            )
            alert_logs = [
                {
                    "instance_number": _safe_int(r.get("INSTANCE_NUMBER")),
                    "thread":          _safe_int(r.get("THREAD#")),
                    "sequence":        _safe_int(r.get("SEQUENCE#")),
                    "first_change":    _safe_int(r.get("FIRST_CHANGE#")),
                    "first_time":      _safe_str(r.get("FIRST_TIME")),
                    "next_time":       _safe_str(r.get("NEXT_TIME")),
                    "status":          _safe_str(r.get("STATUS")),
                }
                for r in raw
            ]
            source = "v$log"
            note = "v$diag_alert_ext not accessible; showing redo log info from v$log instead."
        except Exception as exc:
            source = "none"
            note   = f"Both queries failed: {exc}"

    blocking_sessions = []
    try:
        raw = _rows(
            engine,
            """SELECT sid, serial#, username, status, state, event, wait_class, seconds_in_wait, machine
               FROM v$session
               WHERE wait_class='Application' OR wait_class='Concurrency'
                  OR (status='ACTIVE' AND seconds_in_wait > 60)
               ORDER BY seconds_in_wait DESC
               FETCH FIRST 50 ROWS ONLY"""
        )
        blocking_sessions = [
            {
                "sid":             _safe_int(r.get("SID")),
                "serial":          _safe_int(r.get("SERIAL#")),
                "username":        _safe_str(r.get("USERNAME")),
                "status":          _safe_str(r.get("STATUS")),
                "state":           _safe_str(r.get("STATE")),
                "event":           _safe_str(r.get("EVENT")),
                "wait_class":      _safe_str(r.get("WAIT_CLASS")),
                "seconds_in_wait": _safe_int(r.get("SECONDS_IN_WAIT")),
                "machine":         _safe_str(r.get("MACHINE")),
            }
            for r in raw
        ]
    except Exception as exc:
        note += f" | blocking_sessions: {exc}"

    return {
        "status":            "success",
        "source":            source,
        "total":             len(alert_logs),
        "alert_logs":        alert_logs,
        "blocking_sessions": blocking_sessions,
        "note":              note,
    }


# ──────────────────────────────────────────────────────────────
#  INDEX ANALYSIS   GET /{conn_id}/oracle-index-analysis
# ──────────────────────────────────────────────────────────────

_ORACLE_SYSTEM_OWNERS = (
    "'SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB',"
    "'APEX_030200','APEX_040200','CTXSYS','MDSYS',"
    "'OLAPSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA'"
)

@router.get("/{conn_id}/oracle-index-analysis")
def oracle_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    """Index inventory and fragmented indexes from dba_indexes."""
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    indexes = []
    try:
        raw = _rows(
            engine,
            f"""SELECT i.owner, i.table_name, i.index_name, i.index_type,
                       i.uniqueness, i.status, i.num_rows, i.leaf_blocks
                FROM dba_indexes i
                WHERE i.owner NOT IN ({_ORACLE_SYSTEM_OWNERS})
                ORDER BY i.owner, i.table_name"""
        )
        indexes = [
            {
                "owner":       _safe_str(r.get("OWNER")),
                "table_name":  _safe_str(r.get("TABLE_NAME")),
                "index_name":  _safe_str(r.get("INDEX_NAME")),
                "index_type":  _safe_str(r.get("INDEX_TYPE")),
                "uniqueness":  _safe_str(r.get("UNIQUENESS")),
                "status":      _safe_str(r.get("STATUS")),
                "num_rows":    _safe_int(r.get("NUM_ROWS")),
                "leaf_blocks": _safe_int(r.get("LEAF_BLOCKS")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"index_inventory: {exc}")

    fragmented_indexes = []
    try:
        raw = _rows(
            engine,
            """SELECT owner, index_name, table_name, blevel, leaf_blocks,
                      ROUND(100*(1-1/POWER(2,blevel)),1) AS fragmentation_pct
               FROM dba_indexes
               WHERE blevel >= 3 AND owner NOT IN ('SYS','SYSTEM')
               ORDER BY fragmentation_pct DESC
               FETCH FIRST 30 ROWS ONLY"""
        )
        fragmented_indexes = [
            {
                "owner":             _safe_str(r.get("OWNER")),
                "index_name":        _safe_str(r.get("INDEX_NAME")),
                "table_name":        _safe_str(r.get("TABLE_NAME")),
                "blevel":            _safe_int(r.get("BLEVEL")),
                "leaf_blocks":       _safe_int(r.get("LEAF_BLOCKS")),
                "fragmentation_pct": round(_safe_float(r.get("FRAGMENTATION_PCT")), 1),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"fragmented_indexes: {exc}")

    total_indexes    = len(indexes)
    unique_indexes   = sum(1 for i in indexes if i["uniqueness"] == "UNIQUE")
    unusable_indexes = sum(1 for i in indexes if i["status"] == "UNUSABLE")

    return {
        "status":             "success",
        "indexes":            indexes,
        "fragmented_indexes": fragmented_indexes,
        "summary": {
            "total_indexes":           total_indexes,
            "unique_indexes":          unique_indexes,
            "non_unique_indexes":      total_indexes - unique_indexes,
            "unusable_indexes":        unusable_indexes,
            "fragmented_indexes":      len(fragmented_indexes),
            "high_fragmentation_gte50_pct": len([f for f in fragmented_indexes if f["fragmentation_pct"] >= 50.0]),
        },
        "errors": errors,
    }
