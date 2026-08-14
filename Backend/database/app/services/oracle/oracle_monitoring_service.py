"""
Oracle Monitoring Service — all business logic for oracle monitoring endpoints.
Part A: helpers + endpoints 1-15
Part B: endpoints 16-31
"""

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster
from app.services.common.actmon_internal_tables import oracle_exclude_internal_tables_sql
from app.services.common.slow_query_normalize import attach_normalized, build_normalized_row


# ──────────────────────────────────────────────────────────────
#  HELPERS
# ──────────────────────────────────────────────────────────────

def _oracle_engine(conn):
    pw = quote_plus(conn.password or "")
    if conn.service_name:
        url = f"oracle+oracledb://{conn.username}:{pw}@{conn.host}:{conn.port}/?service_name={conn.service_name}"
    elif conn.sid:
        url = f"oracle+oracledb://{conn.username}:{pw}@{conn.host}:{conn.port}/{conn.sid}"
    else:
        svc = conn.database_name or ""
        url = f"oracle+oracledb://{conn.username}:{pw}@{conn.host}:{conn.port}/?service_name={svc}"
    return create_engine(url, pool_pre_ping=True)


def _rows(engine, sql, params=None):
    with engine.connect() as c:
        r = c.execute(text(sql), params or {})
        return [{k.upper(): v for k, v in row.items()} for row in r.mappings().all()]


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
        from app.services.common import db_proxy_service
        return db_proxy_service.engine_for(conn, lambda: _oracle_engine(conn))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Engine creation failed: {str(e)}")


_SYSTEM_OWNERS = (
    "'SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB','APEX_030200','APEX_040200',"
    "'CTXSYS','MDSYS','OLAPSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA',"
    "'AUDSYS','GGSYS','GSMADMIN_INTERNAL','LBACSYS','OJVMSYS','ORACLE_OCM',"
    "'REMOTE_SCHEDULER_AGENT','APPQOSSYS','DVF','DVSYS','FLOWS_FILES',"
    "'GSMCATUSER','GSMUSER','SYSBACKUP','SYSDG','SYSKM','SYSRAC'"
)

_ORACLE_SYSTEM_OWNERS = (
    "'SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB',"
    "'APEX_030200','APEX_040200','CTXSYS','MDSYS',"
    "'OLAPSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA'"
)


def _obj_query_with_fallback(engine, dba_sql, all_sql, params=None):
    """Try DBA view first; fall back to ALL view on any privilege error."""
    try:
        return _rows(engine, dba_sql, params or {})
    except Exception:
        return _rows(engine, all_sql, params or {})


# ──────────────────────────────────────────────────────────────
#  1. MAIN DASHBOARD
# ──────────────────────────────────────────────────────────────

def oracle_dashboard(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_dashboard", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
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

    db_size_gb = 0.0
    try:
        rows = _rows(engine, "SELECT sum(bytes)/1024/1024/1024 AS size_gb FROM dba_data_files")
        db_size_gb = round(_safe_float(rows[0].get("SIZE_GB", 0.0)), 4) if rows else 0.0
    except Exception as exc:
        errors.append(f"db_size: {exc}")

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

    library_cache_hit_pct = 0.0
    try:
        rows = _rows(engine, "SELECT ROUND(sum(pinhits) / NULLIF(sum(pins), 0) * 100, 2) AS pct FROM v$librarycache")
        library_cache_hit_pct = round(_safe_float(rows[0].get("PCT", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"library_cache_hit: {exc}")

    # ── CPU (host + cores) — Oracle exposes these natively, no OS access needed ──
    cpu_count = 0
    cpu_cores = 0
    host_cpu_pct = 0.0
    db_cpu_pct = 0.0
    physical_mem_mb = 0.0
    try:
        rows = _rows(engine, "SELECT value FROM v$parameter WHERE name='cpu_count'")
        cpu_count = _safe_int(rows[0].get("VALUE", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"cpu_count: {exc}")
    try:
        rows = _rows(engine,
            "SELECT metric_name, ROUND(value,2) AS val FROM v$sysmetric "
            "WHERE metric_name IN ('Host CPU Utilization (%)','Database CPU Time Ratio') AND group_id=2")
        for r in rows:
            nm = _safe_str(r.get("METRIC_NAME"))
            if nm == "Host CPU Utilization (%)":
                host_cpu_pct = round(_safe_float(r.get("VAL", 0.0)), 2)
            elif nm == "Database CPU Time Ratio":
                db_cpu_pct = round(_safe_float(r.get("VAL", 0.0)), 2)
    except Exception as exc:
        errors.append(f"host_cpu_sysmetric: {exc}")

    # v$sysmetric is empty on many instances (XE / MMON metrics off). Fall back to an INSTANT
    # cumulative read from v$osstat (no sleep, so the dashboard never blocks). The live
    # instantaneous % (busy/idle delta) is computed by the separate, async Host Resources
    # drill-down call — keeping it off the dashboard's critical path.
    if not host_cpu_pct:
        try:
            rs = _rows(engine, "SELECT stat_name, value FROM v$osstat WHERE stat_name IN ('BUSY_TIME','IDLE_TIME')")
            m = {_safe_str(x.get("STAT_NAME")): _safe_float(x.get("VALUE", 0.0)) for x in rs}
            busy, idle = m.get("BUSY_TIME", 0.0), m.get("IDLE_TIME", 0.0)
            if (busy + idle) > 0:
                host_cpu_pct = round(busy / (busy + idle) * 100, 1)
        except Exception as exc:
            errors.append(f"host_cpu_osstat: {exc}")
    try:
        rows = _rows(engine,
            "SELECT stat_name, value FROM v$osstat "
            "WHERE stat_name IN ('NUM_CPUS','NUM_CPU_CORES','PHYSICAL_MEMORY_BYTES')")
        os_map = {_safe_str(r.get("STAT_NAME")): _safe_float(r.get("VALUE", 0.0)) for r in rows}
        cpu_cores = int(os_map.get("NUM_CPU_CORES") or os_map.get("NUM_CPUS") or 0)
        physical_mem_mb = round((os_map.get("PHYSICAL_MEMORY_BYTES") or 0.0) / 1048576.0, 1)
        if not cpu_count:
            cpu_count = int(os_map.get("NUM_CPUS") or 0)
    except Exception as exc:
        errors.append(f"osstat: {exc}")

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

    top_sql = []
    try:
        raw = _rows(
            engine,
            f"""SELECT sql_id, executions,
                      ROUND(elapsed_time / 1000, 2) AS elapsed_ms,
                      ROUND(cpu_time / 1000, 2)     AS cpu_ms,
                      buffer_gets, disk_reads, rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000, 2) AS avg_elapsed_ms,
                      SUBSTR(sql_text, 1, 300) AS sql_text
               FROM v$sql
               WHERE executions > 0
                 AND {oracle_exclude_internal_tables_sql('sql_text')}
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
        "cpu_count":             cpu_count,
        "cpu_cores":             cpu_cores,
        "host_cpu_pct":          host_cpu_pct,
        "db_cpu_pct":            db_cpu_pct,
        "physical_mem_mb":       physical_mem_mb,
    }

    _res = {
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
            "sga_mb":        sga_total_mb,
            "sga_target_mb": sga_target_mb,
            "sga_used_pct":  sga_used_pct,
            "pga_mb":        pga_mb,
            "pga_target_mb": pga_target_mb,
            "pga_used_pct":  pga_used_pct,
        },
        "performance": {
            "buffer_cache_hit_pct":  buffer_cache_hit_pct,
            "library_cache_hit_pct": library_cache_hit_pct,
            "active_sessions":       active_sessions,
            "session_pct":           session_pct,
        },
        "tablespaces": tablespaces,
        "top_sql":     top_sql,
        "wait_events": top_waits,
        "redo_logs":   redo_logs,
        "errors":      errors,
    }
    try:
        from app.utils.agent_cache import store_snapshot_for_conn
        store_snapshot_for_conn(conn_id, "oracle_dashboard", _res, db)
    except Exception:
        pass
    return _res


# ──────────────────────────────────────────────────────────────
#  2. SGA DETAIL
# ──────────────────────────────────────────────────────────────

def oracle_sga_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_sga_detail", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    pools = []
    try:
        raw = _rows(engine, "SELECT pool, name, bytes / 1024 / 1024 AS mb FROM v$sgastat ORDER BY bytes DESC")
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

    return {"status": "success", "pools": pools, "sga_info": sga_info, "total_mb": total_mb}


# ──────────────────────────────────────────────────────────────
#  3. PGA DETAIL
# ──────────────────────────────────────────────────────────────

def oracle_pga_detail(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_pga_detail", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    stats = []
    try:
        raw = _rows(engine, "SELECT name, value, unit FROM v$pgastat ORDER BY name")
        stats = [
            {"name": _safe_str(r.get("NAME")), "value": _safe_float(r.get("VALUE")), "unit": _safe_str(r.get("UNIT"))}
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
        "total_allocated_mb":  round(_pga("total PGA allocated") / 1024 / 1024, 2),
        "total_used_mb":       round(_pga("total PGA used for manual work areas") / 1024 / 1024, 2),
        "aggregate_target_mb": round(_pga("aggregate PGA target parameter") / 1024 / 1024, 2),
        "cache_hit_pct":       round(_pga("cache hit percentage"), 2),
        "work_areas_active":   int(_pga("total number of PGA work areas active") or 0),
    }

    return {"status": "success", "stats": stats, "summary": summary}


# ──────────────────────────────────────────────────────────────
#  4. SESSIONS
# ──────────────────────────────────────────────────────────────

def oracle_sessions(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_sessions", db)
    if _cached is not None:
        return _cached
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
#  5. TOP SQL
# ──────────────────────────────────────────────────────────────

def oracle_top_sql(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_top_sql", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    sql_list = []
    try:
        raw = _rows(
            engine,
            f"""SELECT sql_id, executions,
                      ROUND(elapsed_time / 1000, 2)                         AS elapsed_ms,
                      ROUND(cpu_time / 1000, 2)                             AS cpu_ms,
                      buffer_gets, disk_reads, rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000, 2) AS avg_elapsed_ms,
                      ROUND(cpu_time     / NULLIF(executions, 0) / 1000, 2) AS avg_cpu_ms,
                      parsing_schema_name,
                      last_active_time,
                      SUBSTR(sql_text, 1, 500) AS sql_text,
                      SUBSTR(sql_fulltext, 1, 2000) AS sql_fulltext
               FROM v$sql
               WHERE executions > 0
                 AND {oracle_exclude_internal_tables_sql('sql_text')}
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
#  6. WAIT EVENTS
# ──────────────────────────────────────────────────────────────

def oracle_wait_events(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_wait_events", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    events = []
    try:
        raw = _rows(
            engine,
            """SELECT event, wait_class, total_waits, total_timeouts,
                      ROUND(time_waited / 100, 2)         AS time_waited_seconds,
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

    by_class = {}
    for e in events:
        wc = e["wait_class"]
        by_class[wc] = by_class.get(wc, 0.0) + e["time_waited_seconds"]
    class_breakdown = [
        {"wait_class": k, "time_seconds": round(v, 2)}
        for k, v in sorted(by_class.items(), key=lambda x: -x[1])
    ]

    return {"status": "success", "events": events, "class_breakdown": class_breakdown}


# ──────────────────────────────────────────────────────────────
#  7. TABLESPACES
# ──────────────────────────────────────────────────────────────

def oracle_tablespaces(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    tablespaces = []
    try:
        raw = _rows(
            engine,
            """SELECT m.tablespace_name,
                      t.status, t.contents, t.extent_management, t.logging,
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
                "tablespace_name":   _safe_str(r.get("TABLESPACE_NAME")),
                "status":            _safe_str(r.get("STATUS")),
                "contents":          _safe_str(r.get("CONTENTS")),
                "extent_management": _safe_str(r.get("EXTENT_MANAGEMENT")),
                "logging":           _safe_str(r.get("LOGGING")),
                "used_mb":           round(_safe_float(r.get("USED_MB")), 2),
                "total_mb":          round(_safe_float(r.get("TOTAL_MB")), 2),
                "free_mb":           round(_safe_float(r.get("FREE_MB")), 2),
                "used_pct":          round(_safe_float(r.get("USED_PCT")), 1),
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
#  8. OBJECTS
# ──────────────────────────────────────────────────────────────

def oracle_objects(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    by_type = []
    try:
        raw = _obj_query_with_fallback(
            engine,
            f"SELECT object_type, count(*) AS cnt FROM dba_objects WHERE owner NOT IN ({_SYSTEM_OWNERS}) GROUP BY object_type ORDER BY cnt DESC",
            f"SELECT object_type, count(*) AS cnt FROM all_objects WHERE owner NOT IN ({_SYSTEM_OWNERS}) GROUP BY object_type ORDER BY cnt DESC",
        )
        by_type = [
            {"object_type": _safe_str(r.get("OBJECT_TYPE")), "count": _safe_int(r.get("CNT"))}
            for r in raw
        ]
    except Exception:
        by_type = []

    top_tables = []
    try:
        raw = _obj_query_with_fallback(
            engine,
            f"""SELECT owner, segment_name AS table_name,
                       ROUND(SUM(bytes)/1024/1024,2) AS size_mb
                FROM dba_segments
                WHERE segment_type='TABLE' AND owner NOT IN ({_SYSTEM_OWNERS})
                GROUP BY owner, segment_name
                ORDER BY size_mb DESC FETCH FIRST 20 ROWS ONLY""",
            f"""SELECT t.owner, t.table_name,
                       ROUND(t.num_rows * t.avg_row_len / 1024 / 1024, 2) AS size_mb
                FROM all_tables t
                WHERE t.owner NOT IN ({_SYSTEM_OWNERS}) AND t.num_rows IS NOT NULL
                ORDER BY size_mb DESC NULLS LAST FETCH FIRST 20 ROWS ONLY""",
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
        "total_objects": sum(b["count"] for b in by_type),
        "tables":     _count("TABLE"),  "indexes":    _count("INDEX"),
        "views":      _count("VIEW"),   "procedures": _count("PROCEDURE"),
        "functions":  _count("FUNCTION"), "packages": _count("PACKAGE"),
        "triggers":   _count("TRIGGER"), "sequences": _count("SEQUENCE"),
        "synonyms":   _count("SYNONYM"),
    }

    invalid_count = 0
    try:
        rows = _obj_query_with_fallback(
            engine,
            f"SELECT count(*) AS cnt FROM dba_objects WHERE status='INVALID' AND owner NOT IN ({_SYSTEM_OWNERS})",
            f"SELECT count(*) AS cnt FROM all_objects WHERE status='INVALID' AND owner NOT IN ({_SYSTEM_OWNERS})",
        )
        invalid_count = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception:
        pass
    summary["invalid_objects"] = invalid_count

    return {"status": "success", "by_type": by_type, "top_tables": top_tables, "summary": summary}


# ──────────────────────────────────────────────────────────────
#  9. SCHEMA TABLE BROWSER
# ──────────────────────────────────────────────────────────────

def oracle_schema_tables(conn_id: int, db: Session, owner: str = ""):
    # Only the default (no owner filter) view is snapshot-cached — that's what the
    # Tables tab requests on first load. An explicit owner selection is a deliberate,
    # infrequent action, so it always goes live rather than needing a per-owner cache.
    if not owner:
        from app.utils.agent_cache import get_snapshot as _get_snap
        _cached = _get_snap(conn_id, "oracle_schema_tables", db)
        if _cached is not None:
            return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    schemas = []
    try:
        raw = _obj_query_with_fallback(
            engine,
            f"SELECT username AS owner FROM dba_users WHERE username NOT IN ({_SYSTEM_OWNERS}) ORDER BY username",
            f"SELECT DISTINCT owner FROM all_tables WHERE owner NOT IN ({_SYSTEM_OWNERS}) ORDER BY owner",
        )
        schemas = [_safe_str(r.get("OWNER") or r.get("USERNAME")) for r in raw]
    except Exception:
        pass

    if not schemas:
        return {"status": "success", "schemas": [], "tables": [], "owner": owner}

    target_owner = (owner.upper() if owner else (schemas[0] if schemas else ""))

    tables = []
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT t.table_name, t.num_rows, t.avg_row_len, t.last_analyzed,
                      t.status, t.partitioned, t.row_movement,
                      ROUND(s.bytes/1024/1024, 2)   AS size_mb,
                      (SELECT count(*) FROM dba_tab_columns c WHERE c.owner=t.owner AND c.table_name=t.table_name) AS col_count,
                      (SELECT count(*) FROM dba_indexes  i  WHERE i.table_owner=t.owner AND i.table_name=t.table_name) AS idx_count
               FROM dba_tables t
               LEFT JOIN dba_segments s ON s.owner=t.owner AND s.segment_name=t.table_name AND s.segment_type='TABLE'
               WHERE t.owner = :ow ORDER BY t.table_name""",
            """SELECT t.table_name, t.num_rows, t.avg_row_len, t.last_analyzed,
                      t.status, t.partitioned, t.row_movement,
                      NULL AS size_mb,
                      (SELECT count(*) FROM all_tab_columns c WHERE c.owner=t.owner AND c.table_name=t.table_name) AS col_count,
                      (SELECT count(*) FROM all_indexes    i WHERE i.table_owner=t.owner AND i.table_name=t.table_name) AS idx_count
               FROM all_tables t WHERE t.owner = :ow ORDER BY t.table_name""",
            {"ow": target_owner},
        )
        tables = [
            {
                "table_name":    _safe_str(r.get("TABLE_NAME")),
                "num_rows":      _safe_int(r.get("NUM_ROWS")),
                "avg_row_len":   _safe_int(r.get("AVG_ROW_LEN")),
                "last_analyzed": _safe_str(r.get("LAST_ANALYZED")),
                "status":        _safe_str(r.get("STATUS")),
                "partitioned":   _safe_str(r.get("PARTITIONED")),
                "size_mb":       round(_safe_float(r.get("SIZE_MB")), 3) if r.get("SIZE_MB") else None,
                "col_count":     _safe_int(r.get("COL_COUNT")),
                "idx_count":     _safe_int(r.get("IDX_COUNT")),
            }
            for r in raw
        ]
    except Exception:
        tables = []

    columns_by_table = {}
    try:
        raw = _obj_query_with_fallback(
            engine,
            "SELECT column_name, data_type, data_length, nullable, column_id, data_default, table_name FROM dba_tab_columns WHERE owner = :ow ORDER BY table_name, column_id",
            "SELECT column_name, data_type, data_length, nullable, column_id, data_default, table_name FROM all_tab_columns WHERE owner = :ow ORDER BY table_name, column_id",
            {"ow": target_owner},
        )
        for r in raw:
            tbl = _safe_str(r.get("TABLE_NAME"))
            if tbl not in columns_by_table:
                columns_by_table[tbl] = []
            columns_by_table[tbl].append({
                "column_name": _safe_str(r.get("COLUMN_NAME")),
                "data_type":   _safe_str(r.get("DATA_TYPE")),
                "data_length": _safe_int(r.get("DATA_LENGTH")),
                "nullable":    _safe_str(r.get("NULLABLE")),
                "column_id":   _safe_int(r.get("COLUMN_ID")),
            })
    except Exception:
        pass

    indexes_by_table = {}
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT i.table_name, i.index_name, i.index_type, i.uniqueness, i.status,
                      LISTAGG(ic.column_name,',') WITHIN GROUP (ORDER BY ic.column_position) AS cols
               FROM dba_indexes i
               JOIN dba_ind_columns ic ON ic.index_owner=i.owner AND ic.index_name=i.index_name
               WHERE i.table_owner = :ow
               GROUP BY i.table_name, i.index_name, i.index_type, i.uniqueness, i.status
               ORDER BY i.table_name, i.index_name""",
            """SELECT i.table_name, i.index_name, i.index_type, i.uniqueness, i.status,
                      LISTAGG(ic.column_name,',') WITHIN GROUP (ORDER BY ic.column_position) AS cols
               FROM all_indexes i
               JOIN all_ind_columns ic ON ic.index_owner=i.owner AND ic.index_name=i.index_name
               WHERE i.table_owner = :ow
               GROUP BY i.table_name, i.index_name, i.index_type, i.uniqueness, i.status
               ORDER BY i.table_name, i.index_name""",
            {"ow": target_owner},
        )
        for r in raw:
            tbl = _safe_str(r.get("TABLE_NAME"))
            if tbl not in indexes_by_table:
                indexes_by_table[tbl] = []
            indexes_by_table[tbl].append({
                "index_name": _safe_str(r.get("INDEX_NAME")),
                "index_type": _safe_str(r.get("INDEX_TYPE")),
                "uniqueness": _safe_str(r.get("UNIQUENESS")),
                "status":     _safe_str(r.get("STATUS")),
                "columns":    _safe_str(r.get("COLS")),
            })
    except Exception:
        pass

    for t in tables:
        tn = t["table_name"]
        t["columns"] = columns_by_table.get(tn, [])
        t["indexes"]  = indexes_by_table.get(tn, [])

    return {"status": "success", "schemas": schemas, "owner": target_owner, "tables": tables, "total": len(tables)}


def _oracle_col_type(data_type, data_length, data_precision, data_scale):
    """Build a human-readable Oracle column type string, e.g. VARCHAR2(100), NUMBER(10,2)."""
    dt = (data_type or "").upper()
    if dt in ("VARCHAR2", "NVARCHAR2", "CHAR", "NCHAR", "RAW"):
        return f"{dt}({_safe_int(data_length)})" if data_length else dt
    if dt == "NUMBER":
        if data_precision is not None:
            scale = _safe_int(data_scale, 0)
            return f"NUMBER({_safe_int(data_precision)},{scale})" if scale else f"NUMBER({_safe_int(data_precision)})"
        return "NUMBER"
    return dt


def _clob_to_str(val):
    """python-oracledb hands CLOB columns back as LOB objects (needing .read()) rather
    than plain str. Handle both shapes; NULL stays NULL."""
    if val is None:
        return None
    if hasattr(val, "read"):
        try:
            return val.read()
        except Exception:
            return str(val)
    return str(val)


# ──────────────────────────────────────────────────────────────
#  9b. TABLE DETAIL
# ──────────────────────────────────────────────────────────────

def oracle_table_detail(conn_id: int, db: Session, owner: str, table: str) -> dict:
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    target_owner = (owner or "").upper()
    target_table = (table or "").upper()
    p = {"ow": target_owner, "tbl": target_table}

    result = {
        "status": "success",
        "summary": {"row_count": None, "total_bytes": None, "index_bytes": None, "column_count": 0, "index_count": 0},
        "columns": [], "indexes": [], "constraints": [], "foreign_keys": [], "triggers": [],
        "ddl": None,
        "sample_columns": [], "sample_rows": [], "sample_returned": 0,
        "errors": {},
    }

    # ── summary: row count / avg row len ────────────────────────────────────
    row_count = None
    try:
        rows = _obj_query_with_fallback(
            engine,
            "SELECT num_rows, avg_row_len FROM dba_tables WHERE owner = :ow AND table_name = :tbl",
            "SELECT num_rows, avg_row_len FROM all_tables WHERE owner = :ow AND table_name = :tbl",
            p,
        )
        if rows:
            row_count = _safe_int(rows[0].get("NUM_ROWS")) if rows[0].get("NUM_ROWS") is not None else None
    except Exception as exc:
        result["errors"]["summary_rows"] = str(exc)

    # ── summary: total table size (DBA_SEGMENTS only — there is no ALL_SEGMENTS
    #    view in Oracle's data dictionary, so the "ALL" fallback simply yields no
    #    size rather than erroring, matching oracle_schema_tables' own pattern) ──
    total_bytes = None
    try:
        rows = _obj_query_with_fallback(
            engine,
            """SELECT SUM(bytes) AS total_bytes FROM dba_segments
               WHERE owner = :ow AND segment_name = :tbl AND segment_type IN ('TABLE','TABLE PARTITION')""",
            "SELECT NULL AS total_bytes FROM dual",
            p,
        )
        if rows and rows[0].get("TOTAL_BYTES") is not None:
            total_bytes = _safe_int(rows[0].get("TOTAL_BYTES"))
    except Exception as exc:
        result["errors"]["summary_table_size"] = str(exc)

    # ── summary: total index size ────────────────────────────────────────────
    index_bytes = None
    try:
        rows = _obj_query_with_fallback(
            engine,
            """SELECT SUM(s.bytes) AS total_bytes
               FROM dba_segments s
               JOIN dba_indexes i ON i.owner = s.owner AND i.index_name = s.segment_name
               WHERE i.table_owner = :ow AND i.table_name = :tbl AND s.segment_type LIKE 'INDEX%'""",
            "SELECT NULL AS total_bytes FROM dual",
            p,
        )
        if rows and rows[0].get("TOTAL_BYTES") is not None:
            index_bytes = _safe_int(rows[0].get("TOTAL_BYTES"))
    except Exception as exc:
        result["errors"]["summary_index_size"] = str(exc)

    # ── columns (+ PK marker) ─────────────────────────────────────────────────
    columns = []
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT column_name, data_type, data_length, data_precision, data_scale,
                      nullable, data_default, column_id
               FROM dba_tab_columns WHERE owner = :ow AND table_name = :tbl ORDER BY column_id""",
            """SELECT column_name, data_type, data_length, data_precision, data_scale,
                      nullable, data_default, column_id
               FROM all_tab_columns WHERE owner = :ow AND table_name = :tbl ORDER BY column_id""",
            p,
        )

        pk_cols = set()
        try:
            pk_raw = _obj_query_with_fallback(
                engine,
                """SELECT cc.column_name FROM dba_constraints c
                   JOIN dba_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                   WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type = 'P'""",
                """SELECT cc.column_name FROM all_constraints c
                   JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
                   WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type = 'P'""",
                p,
            )
            pk_cols = {_safe_str(r.get("COLUMN_NAME")).upper() for r in pk_raw}
        except Exception as exc:
            result["errors"]["columns_pk"] = str(exc)

        for r in raw:
            name = _safe_str(r.get("COLUMN_NAME"))
            columns.append({
                "position": _safe_int(r.get("COLUMN_ID")),
                "name":     name,
                "type":     _oracle_col_type(r.get("DATA_TYPE"), r.get("DATA_LENGTH"), r.get("DATA_PRECISION"), r.get("DATA_SCALE")),
                "nullable": _safe_str(r.get("NULLABLE")) != "N",
                "default":  _safe_str(r.get("DATA_DEFAULT")) if r.get("DATA_DEFAULT") is not None else None,
                "key":      "PRIMARY" if name.upper() in pk_cols else None,
                "comment":  None,
            })
        result["columns"] = columns
    except Exception as exc:
        result["errors"]["columns"] = str(exc)

    # ── indexes ───────────────────────────────────────────────────────────────
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT i.index_name, i.index_type, i.uniqueness, i.num_rows,
                      LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position) AS cols
               FROM dba_indexes i
               JOIN dba_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
               WHERE i.table_owner = :ow AND i.table_name = :tbl
               GROUP BY i.index_name, i.index_type, i.uniqueness, i.num_rows
               ORDER BY i.index_name""",
            """SELECT i.index_name, i.index_type, i.uniqueness, i.num_rows,
                      LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position) AS cols
               FROM all_indexes i
               JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
               WHERE i.table_owner = :ow AND i.table_name = :tbl
               GROUP BY i.index_name, i.index_type, i.uniqueness, i.num_rows
               ORDER BY i.index_name""",
            p,
        )

        size_by_index = {}
        try:
            size_rows = _obj_query_with_fallback(
                engine,
                """SELECT i.index_name, s.bytes
                   FROM dba_indexes i
                   JOIN dba_segments s ON s.owner = i.owner AND s.segment_name = i.index_name AND s.segment_type LIKE 'INDEX%'
                   WHERE i.table_owner = :ow AND i.table_name = :tbl""",
                "SELECT NULL AS index_name, NULL AS bytes FROM dual WHERE 1=0",
                p,
            )
            size_by_index = {_safe_str(r.get("INDEX_NAME")): _safe_int(r.get("BYTES")) for r in size_rows}
        except Exception as exc:
            result["errors"]["indexes_size"] = str(exc)

        result["indexes"] = [
            {
                "name":       _safe_str(r.get("INDEX_NAME")),
                "type":       _safe_str(r.get("INDEX_TYPE")),
                "unique":     _safe_str(r.get("UNIQUENESS")) == "UNIQUE",
                "columns":    _safe_str(r.get("COLS")),
                "size_bytes": size_by_index.get(_safe_str(r.get("INDEX_NAME"))),
                "uses":       _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
            }
            for r in raw
        ]
    except Exception as exc:
        result["errors"]["indexes"] = str(exc)

    # ── constraints (P / U / C) ───────────────────────────────────────────────
    # search_condition is a LONG column — LONG cannot appear in GROUP BY/DISTINCT/
    # ORDER BY, so its header (incl. search_condition) is fetched separately from
    # the LISTAGG'd column list and the two are merged in Python.
    _CONS_TYPE_WORDS = {"P": "PRIMARY KEY", "U": "UNIQUE", "C": "CHECK"}
    try:
        headers = _obj_query_with_fallback(
            engine,
            """SELECT constraint_name, constraint_type, search_condition
               FROM dba_constraints WHERE owner = :ow AND table_name = :tbl AND constraint_type IN ('P','U','C')""",
            """SELECT constraint_name, constraint_type, search_condition
               FROM all_constraints WHERE owner = :ow AND table_name = :tbl AND constraint_type IN ('P','U','C')""",
            p,
        )

        cols_by_cons = {}
        try:
            col_rows = _obj_query_with_fallback(
                engine,
                """SELECT cc.constraint_name,
                          LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) AS cols
                   FROM dba_cons_columns cc
                   JOIN dba_constraints c ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
                   WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type IN ('P','U')
                   GROUP BY cc.constraint_name""",
                """SELECT cc.constraint_name,
                          LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) AS cols
                   FROM all_cons_columns cc
                   JOIN all_constraints c ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
                   WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type IN ('P','U')
                   GROUP BY cc.constraint_name""",
                p,
            )
            cols_by_cons = {_safe_str(r.get("CONSTRAINT_NAME")): _safe_str(r.get("COLS")) for r in col_rows}
        except Exception as exc:
            result["errors"]["constraints_columns"] = str(exc)

        constraints = []
        for r in headers:
            ctype = _safe_str(r.get("CONSTRAINT_TYPE"))
            name = _safe_str(r.get("CONSTRAINT_NAME"))
            if ctype == "C":
                columns_str = None
                definition = _clob_to_str(r.get("SEARCH_CONDITION"))
            else:
                columns_str = cols_by_cons.get(name)
                definition = None
            constraints.append({
                "type":       _CONS_TYPE_WORDS.get(ctype, ctype),
                "name":       name,
                "columns":    columns_str,
                "definition": definition,
            })
        result["constraints"] = constraints
    except Exception as exc:
        result["errors"]["constraints"] = str(exc)

    # ── foreign keys ──────────────────────────────────────────────────────────
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT c.constraint_name, c.delete_rule, rc.owner AS ref_schema, rc.table_name AS ref_table,
                      LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) AS fk_columns,
                      LISTAGG(rcc.column_name, ', ') WITHIN GROUP (ORDER BY rcc.position) AS ref_columns
               FROM dba_constraints c
               JOIN dba_cons_columns cc  ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
               JOIN dba_constraints rc   ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
               JOIN dba_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                                         AND rcc.position = cc.position
               WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type = 'R'
               GROUP BY c.constraint_name, c.delete_rule, rc.owner, rc.table_name
               ORDER BY c.constraint_name""",
            """SELECT c.constraint_name, c.delete_rule, rc.owner AS ref_schema, rc.table_name AS ref_table,
                      LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position) AS fk_columns,
                      LISTAGG(rcc.column_name, ', ') WITHIN GROUP (ORDER BY rcc.position) AS ref_columns
               FROM all_constraints c
               JOIN all_cons_columns cc  ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
               JOIN all_constraints rc   ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
               JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                                         AND rcc.position = cc.position
               WHERE c.owner = :ow AND c.table_name = :tbl AND c.constraint_type = 'R'
               GROUP BY c.constraint_name, c.delete_rule, rc.owner, rc.table_name
               ORDER BY c.constraint_name""",
            p,
        )
        result["foreign_keys"] = [
            {
                "name":       _safe_str(r.get("CONSTRAINT_NAME")),
                "column":     _safe_str(r.get("FK_COLUMNS")),
                "ref_schema": _safe_str(r.get("REF_SCHEMA")),
                "ref_table":  _safe_str(r.get("REF_TABLE")),
                "ref_column": _safe_str(r.get("REF_COLUMNS")),
                # Oracle foreign keys have no ON UPDATE action (unlike MySQL/Postgres) —
                # always null here, deliberately.
                "on_update":  None,
                "on_delete":  _safe_str(r.get("DELETE_RULE")) if r.get("DELETE_RULE") is not None else None,
            }
            for r in raw
        ]
    except Exception as exc:
        result["errors"]["foreign_keys"] = str(exc)

    # ── triggers ──────────────────────────────────────────────────────────────
    try:
        raw = _obj_query_with_fallback(
            engine,
            """SELECT trigger_name, trigger_type, triggering_event, trigger_body
               FROM dba_triggers WHERE table_owner = :ow AND table_name = :tbl""",
            """SELECT trigger_name, trigger_type, triggering_event, trigger_body
               FROM all_triggers WHERE table_owner = :ow AND table_name = :tbl""",
            p,
        )
        result["triggers"] = [
            {
                "name":    _safe_str(r.get("TRIGGER_NAME")),
                "timing":  _safe_str(r.get("TRIGGER_TYPE")),
                "event":   _safe_str(r.get("TRIGGERING_EVENT")),
                "definer": None,
                "body":    _clob_to_str(r.get("TRIGGER_BODY")),
            }
            for r in raw
        ]
    except Exception as exc:
        result["errors"]["triggers"] = str(exc)

    # ── ddl (DBMS_METADATA.GET_DDL — needs SELECT_CATALOG_ROLE or equivalent) ──
    try:
        rows = _rows(
            engine,
            "SELECT DBMS_METADATA.GET_DDL('TABLE', :tbl, :ow) AS ddl FROM dual",
            p,
        )
        result["ddl"] = _clob_to_str(rows[0].get("DDL")) if rows else None
    except Exception as exc:
        result["ddl"] = None
        result["errors"]["ddl"] = str(exc)

    # ── sample data ───────────────────────────────────────────────────────────
    try:
        sample_rows = _rows(
            engine,
            f'SELECT * FROM "{target_owner}"."{target_table}" WHERE ROWNUM <= 100',
        )
        sample_columns = list(sample_rows[0].keys()) if sample_rows else []
        safe_rows = []
        for row in sample_rows:
            safe = {}
            for k, v in row.items():
                if v is None or isinstance(v, (int, float, str, bool)):
                    safe[k] = v
                else:
                    safe[k] = _clob_to_str(v)
            safe_rows.append(safe)
        result["sample_columns"] = sample_columns
        result["sample_rows"] = safe_rows
        result["sample_returned"] = len(safe_rows)
    except Exception as exc:
        result["errors"]["sample_data"] = str(exc)

    result["summary"] = {
        "row_count":    row_count,
        "total_bytes":  total_bytes,
        "index_bytes":  index_bytes,
        "column_count": len(result["columns"]),
        "index_count":  len(result["indexes"]),
    }

    return result


# ──────────────────────────────────────────────────────────────
#  10. USERS
# ──────────────────────────────────────────────────────────────

def oracle_users(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    users = []
    try:
        raw = _rows(
            engine,
            """SELECT username, account_status,
                      TO_CHAR(created, 'YYYY-MM-DD HH24:MI:SS') AS created,
                      profile, default_tablespace, temporary_tablespace,
                      TO_CHAR(last_login, 'YYYY-MM-DD HH24:MI:SS') AS last_login
               FROM dba_users ORDER BY username"""
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

    return {"status": "success", "users": users, "total": len(users),
            "open": open_count, "locked": locked_count, "expired": expired_count}


# ──────────────────────────────────────────────────────────────
#  11. REDO LOGS
# ──────────────────────────────────────────────────────────────

def oracle_redo_logs(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    log_groups = []
    try:
        raw = _rows(
            engine,
            """SELECT l.group#, l.thread#, l.sequence#, l.members,
                      ROUND(l.bytes / 1024 / 1024, 2) AS size_mb,
                      l.status, l.archived, l.first_change#,
                      TO_CHAR(l.first_time, 'YYYY-MM-DD HH24:MI:SS') AS first_time
               FROM v$log l ORDER BY l.group#"""
        )
        log_groups = [
            {
                "group":        _safe_int(r.get("GROUP#")),
                "thread":       _safe_int(r.get("THREAD#")),
                "sequence":     _safe_int(r.get("SEQUENCE#")),
                "members":      _safe_int(r.get("MEMBERS")),
                "size_mb":      round(_safe_float(r.get("SIZE_MB")), 2),
                "status":       _safe_str(r.get("STATUS")),
                "archived":     _safe_str(r.get("ARCHIVED")),
                "first_change": _safe_int(r.get("FIRST_CHANGE#")),
                "first_time":   _safe_str(r.get("FIRST_TIME")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "log_groups": [], "logfiles": [], "error": str(exc)}

    logfiles = []
    try:
        raw = _rows(
            engine,
            """SELECT l.group#, lf.member, lf.type, lf.status AS file_status
               FROM v$logfile lf JOIN v$log l ON l.group# = lf.group#
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
        "status":        "success",
        "log_groups":    log_groups,
        "logfiles":      logfiles,
        "log_mode":      db_info.get("LOG_MODE", ""),
        "current_group": next((g["group"] for g in log_groups if g["status"] == "CURRENT"), None),
    }


# ──────────────────────────────────────────────────────────────
#  12. DATA GUARD
# ──────────────────────────────────────────────────────────────

def oracle_data_guard(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    _cached = _get_snap(conn_id, "oracle_data_guard", db)
    if _cached is not None:
        return _cached
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    dg_status = []
    try:
        raw = _rows(
            engine,
            """SELECT severity, TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
                      dest_id, message, callout
               FROM v$dataguard_status ORDER BY timestamp DESC FETCH FIRST 50 ROWS ONLY"""
        )
        dg_status = [
            {"severity": _safe_str(r.get("SEVERITY")), "timestamp": _safe_str(r.get("TIMESTAMP")),
             "dest_id": _safe_int(r.get("DEST_ID")), "message": _safe_str(r.get("MESSAGE")),
             "callout": _safe_str(r.get("CALLOUT"))}
            for r in raw
        ]
    except Exception:
        pass

    archive_dests = []
    try:
        raw = _rows(
            engine,
            """SELECT dest_id, dest_name, status, target, archiver, schedule,
                      destination, applied_scn, db_unique_name, synchronization_status
               FROM v$archive_dest_status WHERE status != 'INACTIVE'"""
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
            "SELECT group#, thread#, sequence#, ROUND(bytes / 1024 / 1024, 2) AS size_mb, status FROM v$standby_log ORDER BY group#"
        )
        standby_logs = [
            {"group": _safe_int(r.get("GROUP#")), "thread": _safe_int(r.get("THREAD#")),
             "sequence": _safe_int(r.get("SEQUENCE#")), "size_mb": round(_safe_float(r.get("SIZE_MB")), 2),
             "status": _safe_str(r.get("STATUS"))}
            for r in raw
        ]
    except Exception:
        pass

    configured = len(dg_status) > 0 or len(archive_dests) > 1 or len(standby_logs) > 0

    return {"status": "success", "configured": configured,
            "dg_status": dg_status, "archive_dests": archive_dests, "standby_logs": standby_logs}


# ──────────────────────────────────────────────────────────────
#  13. PROCESSES
# ──────────────────────────────────────────────────────────────

def oracle_processes(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    processes = []
    try:
        raw = _rows(
            engine,
            """SELECT b.pname, b.description, p.pid, p.spid,
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

    return {"status": "success", "processes": processes, "total": len(processes), "total_pga_mb": total_pga_mb}


# ──────────────────────────────────────────────────────────────
#  14. SYSTEM STATS
# ──────────────────────────────────────────────────────────────

def oracle_system_stats(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    stats = []
    try:
        raw = _rows(engine, "SELECT name, value, class FROM v$sysstat WHERE value > 0 ORDER BY class, name")
        stats = [
            {"name": _safe_str(r.get("NAME")), "value": _safe_float(r.get("VALUE")), "class": _safe_int(r.get("CLASS"))}
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
    key_stats_map = {s["name"]: s["value"] for s in stats if s["name"].lower() in KEY_STATS}

    CLASS_NAMES = {1: "User", 2: "Redo", 4: "Enqueue", 8: "Cache", 16: "OS",
                   32: "Real Application Clusters", 64: "SQL", 128: "Debug"}
    by_class = {}
    for s in stats:
        cls_name = CLASS_NAMES.get(s["class"], f"Class {s['class']}")
        if cls_name not in by_class:
            by_class[cls_name] = []
        by_class[cls_name].append({"name": s["name"], "value": s["value"]})

    return {"status": "success", "stats": stats, "key_stats": key_stats_map, "by_class": by_class, "total": len(stats)}


# ──────────────────────────────────────────────────────────────
#  15. AWR SQL
# ──────────────────────────────────────────────────────────────

def oracle_awr_sql(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    sql_list = []
    try:
        raw = _rows(
            engine,
            """SELECT sql_id, executions,
                      ROUND(elapsed_time / 1000000, 4) AS elapsed_sec,
                      ROUND(cpu_time / 1000000, 4)     AS cpu_sec,
                      buffer_gets, disk_reads, rows_processed,
                      ROUND(elapsed_time / NULLIF(executions, 0) / 1000000, 4) AS avg_elapsed_sec,
                      parsing_schema_name, module, action, last_active_time,
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
#  16. LEGACY MONITORING DASHBOARD
# ──────────────────────────────────────────────────────────────

def oracle_monitoring_dashboard(conn_id: int, db: Session):
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
        raw = _rows(
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
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"tablespaces: {exc}")

    active_sql = []
    try:
        raw = _rows(
            engine,
            """SELECT s.sid, s.serial#, s.username, s.status, s.machine, s.module,
                      ROUND((sysdate-s.logon_time)*24*60,1) AS session_min,
                      SUBSTR(q.sql_text,1,200) AS sql_text
               FROM v$session s LEFT JOIN v$sql q ON s.sql_id = q.sql_id
               WHERE s.type='USER' AND s.status='ACTIVE'
               ORDER BY session_min DESC FETCH FIRST 20 ROWS ONLY"""
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
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"active_sql: {exc}")

    wait_events = []
    try:
        raw = _rows(
            engine,
            """SELECT event, count(*) AS cnt, round(avg(wait_time_micro)/1000000,3) AS avg_wait_sec
               FROM v$session_wait WHERE wait_class != 'Idle'
               GROUP BY event ORDER BY cnt DESC FETCH FIRST 10 ROWS ONLY"""
        )
        wait_events = [
            {"event": _safe_str(r.get("EVENT")), "count": _safe_int(r.get("CNT")), "avg_wait_sec": round(_safe_float(r.get("AVG_WAIT_SEC")), 3)}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"wait_events: {exc}")

    buffer_cache_hit_pct = 0.0
    try:
        rows = _rows(
            engine,
            "SELECT ROUND(1-phyrds/(dbgets+NULLIF(consists,0)),4)*100 AS pct FROM (SELECT sum(physical_reads) phyrds, sum(db_block_gets) dbgets, sum(consistent_gets) consists FROM v$buffer_pool_statistics)"
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
#  17. SLOW QUERIES
# ──────────────────────────────────────────────────────────────

def oracle_slow_queries(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    try:
        raw = _rows(
            engine,
            f"""SELECT sql_id, executions,
                      ROUND(elapsed_time/NULLIF(executions,0)/1000000,4) AS avg_elapsed_sec,
                      ROUND(cpu_time/NULLIF(executions,0)/1000000,4)     AS avg_cpu_sec,
                      ROUND(disk_reads/NULLIF(executions,0),0)           AS avg_disk_reads,
                      ROUND(buffer_gets/NULLIF(executions,0),0)          AS avg_buffer_gets,
                      rows_processed, last_active_time,
                      SUBSTR(sql_text,1,400)                             AS sql_text,
                      parsing_schema_name
               FROM v$sqlarea
               WHERE executions > 0
                 AND {oracle_exclude_internal_tables_sql('sql_text')}
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
        response = {"status": "success", "source": "v$sqlarea", "total": len(queries), "queries": queries, "error": None}
        _normalize_oracle_rows(queries, response)
        return response
    except Exception as exc:
        return {"status": "error", "source": "v$sqlarea", "total": 0, "queries": [], "error": str(exc)}


def _normalize_oracle_rows(queries: list, response: dict) -> None:
    """Builds the shared cross-engine `normalized`/`capabilities` shape from
    the v$sqlarea rows above. Mutates `response` in place; see
    slow_query_normalize.py."""
    common_rows = []
    for q in queries:
        avg_ms = (q.get("avg_elapsed_sec") or 0) * 1000
        execs = q.get("executions")
        common_rows.append(build_normalized_row(
            query_id=q.get("sql_id"),
            query_text=q.get("sql_text"),
            schema_name=q.get("parsing_schema_name"),
            execution_count=execs,
            total_execution_time=(avg_ms * execs) if execs is not None else None,
            average_execution_time=avg_ms,
            rows_returned=q.get("rows_processed"),
            last_seen=q.get("last_active_time"),
            source="v$sqlarea",
        ))
    attach_normalized(response, "oracle", common_rows)


# ──────────────────────────────────────────────────────────────
#  18. ERROR LOGS
# ──────────────────────────────────────────────────────────────

def oracle_error_logs(conn_id: int, db: Session):
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
                   FROM v$log ORDER BY first_time DESC FETCH FIRST 20 ROWS ONLY"""
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
               ORDER BY seconds_in_wait DESC FETCH FIRST 50 ROWS ONLY"""
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
#  19. INDEX ANALYSIS
# ──────────────────────────────────────────────────────────────

def oracle_index_analysis(conn_id: int, db: Session):
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
               ORDER BY fragmentation_pct DESC FETCH FIRST 30 ROWS ONLY"""
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
            "total_indexes":                total_indexes,
            "unique_indexes":               unique_indexes,
            "non_unique_indexes":           total_indexes - unique_indexes,
            "unusable_indexes":             unusable_indexes,
            "fragmented_indexes":           len(fragmented_indexes),
            "high_fragmentation_gte50_pct": len([f for f in fragmented_indexes if f["fragmentation_pct"] >= 50.0]),
        },
        "errors": errors,
    }


# ──────────────────────────────────────────────────────────────
#  20. LIVE QUERIES
# ──────────────────────────────────────────────────────────────

def oracle_live_queries(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    queries = []
    try:
        raw = _rows(
            engine,
            """SELECT s.sid,
                      s.serial#                           AS serial_number,
                      s.username, s.osuser, s.machine, s.program, s.module,
                      s.action, s.status, s.state,
                      s.event                             AS wait_event,
                      s.wait_class, s.seconds_in_wait, s.last_call_et,
                      TO_CHAR(s.logon_time,'YYYY-MM-DD HH24:MI:SS') AS logon_time,
                      s.blocking_session, s.sql_id, s.prev_sql_id,
                      ROUND(q.elapsed_time / NULLIF(q.executions,0) / 1000, 2) AS avg_elapsed_ms,
                      ROUND(q.cpu_time     / NULLIF(q.executions,0) / 1000, 2) AS avg_cpu_ms,
                      q.executions, q.disk_reads, q.buffer_gets,
                      SUBSTR(NVL(q.sql_fulltext, q.sql_text), 1, 4000) AS sql_fulltext,
                      SUBSTR(q.sql_text, 1, 500)                        AS sql_text
               FROM   v$session s
               LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = 0
               WHERE  s.type = 'USER' AND s.status NOT IN ('KILLED', 'SNIPED')
               ORDER BY
                 CASE s.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                 s.seconds_in_wait DESC NULLS LAST,
                 s.last_call_et    ASC  NULLS LAST"""
        )
        queries = [
            {
                "sid":              _safe_int(r.get("SID")),
                "serial_number":    _safe_int(r.get("SERIAL_NUMBER")),
                "username":         _safe_str(r.get("USERNAME")),
                "osuser":           _safe_str(r.get("OSUSER")),
                "machine":          _safe_str(r.get("MACHINE")),
                "program":          _safe_str(r.get("PROGRAM")),
                "module":           _safe_str(r.get("MODULE")),
                "action":           _safe_str(r.get("ACTION")),
                "status":           _safe_str(r.get("STATUS")),
                "state":            _safe_str(r.get("STATE")),
                "wait_event":       _safe_str(r.get("WAIT_EVENT")),
                "wait_class":       _safe_str(r.get("WAIT_CLASS")),
                "seconds_in_wait":  _safe_int(r.get("SECONDS_IN_WAIT")),
                "last_call_et":     _safe_int(r.get("LAST_CALL_ET")),
                "logon_time":       _safe_str(r.get("LOGON_TIME")),
                "blocking_session": _safe_int(r.get("BLOCKING_SESSION")) if r.get("BLOCKING_SESSION") else None,
                "sql_id":           _safe_str(r.get("SQL_ID")),
                "prev_sql_id":      _safe_str(r.get("PREV_SQL_ID")),
                "avg_elapsed_ms":   round(_safe_float(r.get("AVG_ELAPSED_MS")), 2),
                "avg_cpu_ms":       round(_safe_float(r.get("AVG_CPU_MS")), 2),
                "executions":       _safe_int(r.get("EXECUTIONS")),
                "disk_reads":       _safe_int(r.get("DISK_READS")),
                "buffer_gets":      _safe_int(r.get("BUFFER_GETS")),
                "sql_text":         _safe_str(r.get("SQL_TEXT")),
                "sql_fulltext":     _safe_str(r.get("SQL_FULLTEXT")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "queries": [], "total": 0, "error": str(exc)}

    return {
        "status":         "success",
        "queries":        queries,
        "total":          len(queries),
        "active_count":   sum(1 for q in queries if q["status"] == "ACTIVE"),
        "inactive_count": sum(1 for q in queries if q["status"] == "INACTIVE"),
        "connection": {
            "name":         conn.connection_name,
            "host":         conn.host,
            "port":         conn.port,
            "service_name": conn.service_name,
        },
    }


# ──────────────────────────────────────────────────────────────
#  21. LOCKS
# ──────────────────────────────────────────────────────────────

def oracle_locks(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    lock_waits = []
    enqueue_stats = []

    try:
        raw = _rows(
            engine,
            """SELECT w.sid          AS waiter_sid,
                      ws.username    AS waiter_user,
                      ws.machine     AS waiter_machine,
                      ws.program     AS waiter_program,
                      ws.seconds_in_wait,
                      ws.event       AS wait_event,
                      h.sid          AS holder_sid,
                      hs.username    AS holder_user,
                      hs.machine     AS holder_machine,
                      SUBSTR(sq.sql_text,1,200) AS waiter_sql,
                      l.type         AS lock_type,
                      l.id1, l.id2, l.lmode, l.request
               FROM v$lock w
               JOIN v$lock h        ON (h.id1=w.id1 AND h.id2=w.id2 AND h.lmode>0 AND w.request>0)
               JOIN v$session ws    ON ws.sid=w.sid
               JOIN v$session hs    ON hs.sid=h.sid
               LEFT JOIN v$sql sq   ON sq.sql_id=ws.sql_id
               WHERE w.request > 0
               ORDER BY ws.seconds_in_wait DESC"""
        )
        lock_waits = [
            {
                "waiter_sid":      _safe_int(r.get("WAITER_SID")),
                "waiter_user":     _safe_str(r.get("WAITER_USER")),
                "waiter_machine":  _safe_str(r.get("WAITER_MACHINE")),
                "waiter_program":  _safe_str(r.get("WAITER_PROGRAM")),
                "seconds_in_wait": _safe_int(r.get("SECONDS_IN_WAIT")),
                "wait_event":      _safe_str(r.get("WAIT_EVENT")),
                "holder_sid":      _safe_int(r.get("HOLDER_SID")),
                "holder_user":     _safe_str(r.get("HOLDER_USER")),
                "holder_machine":  _safe_str(r.get("HOLDER_MACHINE")),
                "waiter_sql":      _safe_str(r.get("WAITER_SQL")),
                "lock_type":       _safe_str(r.get("LOCK_TYPE")),
                "id1":             _safe_int(r.get("ID1")),
                "id2":             _safe_int(r.get("ID2")),
                "lmode":           _safe_int(r.get("LMODE")),
                "request":         _safe_int(r.get("REQUEST")),
            }
            for r in raw
        ]
    except Exception:
        lock_waits = []

    try:
        raw2 = _rows(
            engine,
            """SELECT eq_type, total_req#, total_wait#, succ_req#, failed_req#,
                      ROUND(cum_wait_time/1000,2) AS cum_wait_sec
               FROM v$enqueue_statistics
               WHERE total_wait# > 0
               ORDER BY cum_wait_time DESC FETCH FIRST 20 ROWS ONLY"""
        )
        enqueue_stats = [
            {
                "eq_type":      _safe_str(r.get("EQ_TYPE")),
                "total_req":    _safe_int(r.get("TOTAL_REQ#")),
                "total_wait":   _safe_int(r.get("TOTAL_WAIT#")),
                "succ_req":     _safe_int(r.get("SUCC_REQ#")),
                "failed_req":   _safe_int(r.get("FAILED_REQ#")),
                "cum_wait_sec": round(_safe_float(r.get("CUM_WAIT_SEC")), 2),
            }
            for r in raw2
        ]
    except Exception:
        enqueue_stats = []

    return {
        "status":        "success",
        "lock_waits":    lock_waits,
        "enqueue_stats": enqueue_stats,
        "total_waits":   len(lock_waits),
        "deadlock_risk": len(lock_waits) > 0,
    }


# ──────────────────────────────────────────────────────────────
#  22. PARAMETERS
# ──────────────────────────────────────────────────────────────

def oracle_parameters(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    KEY_PARAMS = [
        'sga_target','pga_aggregate_target','db_cache_size','shared_pool_size',
        'large_pool_size','java_pool_size','streams_pool_size','memory_target',
        'memory_max_target','cpu_count','parallel_max_servers','sessions',
        'processes','db_block_size','log_buffer','undo_retention',
        'undo_tablespace','db_name','db_unique_name','instance_name',
        'log_mode','archive_lag_target','db_recovery_file_dest',
        'db_recovery_file_dest_size','optimizer_mode','optimizer_index_cost_adj',
        'cursor_sharing','open_cursors','session_cached_cursors',
        'sort_area_size','hash_area_size','audit_trail',
        'enable_ddl_logging','enable_goldengate_replication',
        'cluster_database','db_file_multiblock_read_count',
        'parallel_degree_policy','max_dump_file_size',
    ]
    params = []
    try:
        placeholders = ','.join(f"'{p}'" for p in KEY_PARAMS)
        raw = _rows(
            engine,
            f"""SELECT name, value, description, isdefault, ismodified, isinstance_modifiable
                FROM v$parameter
                WHERE LOWER(name) IN ({placeholders.lower()})
                ORDER BY name"""
        )
        params = [
            {
                "name":        _safe_str(r.get("NAME")),
                "value":       _safe_str(r.get("VALUE")),
                "description": _safe_str(r.get("DESCRIPTION")),
                "isdefault":   _safe_str(r.get("ISDEFAULT")),
                "ismodified":  _safe_str(r.get("ISMODIFIED")),
                "modifiable":  _safe_str(r.get("ISINSTANCE_MODIFIABLE")),
            }
            for r in raw
        ]
    except Exception as exc:
        return {"status": "error", "params": [], "error": str(exc)}

    all_params = []
    try:
        raw2 = _rows(
            engine,
            "SELECT name, value, description, isdefault, ismodified, isinstance_modifiable FROM v$parameter ORDER BY name"
        )
        all_params = [
            {
                "name":        _safe_str(r.get("NAME")),
                "value":       _safe_str(r.get("VALUE")),
                "description": _safe_str(r.get("DESCRIPTION")),
                "isdefault":   _safe_str(r.get("ISDEFAULT")),
                "ismodified":  _safe_str(r.get("ISMODIFIED")),
                "modifiable":  _safe_str(r.get("ISINSTANCE_MODIFIABLE")),
            }
            for r in raw2
        ]
    except Exception:
        pass

    return {"status": "success", "key_params": params, "all_params": all_params, "total": len(all_params)}


# ──────────────────────────────────────────────────────────────
#  23. SQL EXECUTION PLAN
# ──────────────────────────────────────────────────────────────

def oracle_sql_plan(conn_id: int, db: Session, sql_id: str = ""):
    if not sql_id:
        return {"status": "error", "error": "sql_id is required", "plan": [], "sql_stats": {}}
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    plan = []
    try:
        raw = _rows(engine, """
            SELECT id, parent_id, depth, operation, options,
                   object_owner, object_name, object_type,
                   cost, cardinality, bytes, cpu_cost, io_cost,
                   access_predicates, filter_predicates
            FROM   v$sql_plan
            WHERE  sql_id = :sid
            ORDER  BY id
        """, {"sid": sql_id})
        plan = [
            {
                "id":                _safe_int(r.get("ID")),
                "parent_id":         _safe_int(r.get("PARENT_ID")),
                "depth":             _safe_int(r.get("DEPTH")),
                "operation":         _safe_str(r.get("OPERATION")),
                "options":           _safe_str(r.get("OPTIONS")),
                "object_owner":      _safe_str(r.get("OBJECT_OWNER")),
                "object_name":       _safe_str(r.get("OBJECT_NAME")),
                "object_type":       _safe_str(r.get("OBJECT_TYPE")),
                "cost":              _safe_int(r.get("COST")),
                "cardinality":       _safe_int(r.get("CARDINALITY")),
                "bytes":             _safe_int(r.get("BYTES")),
                "cpu_cost":          _safe_int(r.get("CPU_COST")),
                "io_cost":           _safe_int(r.get("IO_COST")),
                "access_predicates": _safe_str(r.get("ACCESS_PREDICATES")),
                "filter_predicates": _safe_str(r.get("FILTER_PREDICATES")),
            }
            for r in raw
        ]
    except Exception:
        plan = []

    sql_stats = {}
    try:
        raw2 = _rows(engine, """
            SELECT sql_id, sql_text, sql_fulltext,
                   executions, elapsed_time, cpu_time,
                   buffer_gets, disk_reads, rows_processed,
                   parse_calls, sorts, loads,
                   elapsed_time / 1000.0 / NULLIF(executions,0) AS avg_elapsed_ms,
                   cpu_time    / 1000.0 / NULLIF(executions,0) AS avg_cpu_ms,
                   parsing_schema_name, module, action,
                   last_active_time, first_load_time,
                   optimizer_mode, optimizer_cost
            FROM   v$sql WHERE sql_id = :sid AND rownum <= 1
        """, {"sid": sql_id})
        if raw2:
            r = raw2[0]
            sql_stats = {
                "sql_id":           _safe_str(r.get("SQL_ID")),
                "sql_text":         _safe_str(r.get("SQL_TEXT")),
                "sql_fulltext":     _safe_str(r.get("SQL_FULLTEXT")),
                "executions":       _safe_int(r.get("EXECUTIONS")),
                "elapsed_ms":       round(_safe_float(r.get("ELAPSED_TIME")) / 1000, 2),
                "cpu_ms":           round(_safe_float(r.get("CPU_TIME")) / 1000, 2),
                "buffer_gets":      _safe_int(r.get("BUFFER_GETS")),
                "disk_reads":       _safe_int(r.get("DISK_READS")),
                "rows_processed":   _safe_int(r.get("ROWS_PROCESSED")),
                "avg_elapsed_ms":   round(_safe_float(r.get("AVG_ELAPSED_MS")), 2),
                "avg_cpu_ms":       round(_safe_float(r.get("AVG_CPU_MS")), 2),
                "parse_calls":      _safe_int(r.get("PARSE_CALLS")),
                "parsing_schema":   _safe_str(r.get("PARSING_SCHEMA_NAME")),
                "module":           _safe_str(r.get("MODULE")),
                "action":           _safe_str(r.get("ACTION")),
                "last_active_time": _safe_str(r.get("LAST_ACTIVE_TIME")),
                "first_load_time":  _safe_str(r.get("FIRST_LOAD_TIME")),
                "optimizer_mode":   _safe_str(r.get("OPTIMIZER_MODE")),
                "optimizer_cost":   _safe_int(r.get("OPTIMIZER_COST")),
            }
    except Exception:
        pass

    indexes_used = [
        {
            "operation":   p["operation"],
            "index_name":  p["object_name"],
            "owner":       p["object_owner"],
            "index_type":  p["object_type"],
            "cost":        p["cost"],
            "cardinality": p["cardinality"],
            "access":      p["access_predicates"],
            "filter":      p["filter_predicates"],
        }
        for p in plan
        if "INDEX" in (p.get("object_type") or "").upper() or "INDEX" in (p.get("operation") or "").upper()
    ]

    wait_info = {}
    try:
        raw3 = _rows(engine, """
            SELECT s.sid, s.serial#, s.username, s.status,
                   s.event, s.wait_class, s.seconds_in_wait,
                   s.state, s.machine, s.program
            FROM   v$session s
            WHERE  s.sql_id = :sid AND s.type = 'USER' AND rownum <= 1
        """, {"sid": sql_id})
        if raw3:
            r = raw3[0]
            wait_info = {
                "sid":             _safe_int(r.get("SID")),
                "username":        _safe_str(r.get("USERNAME")),
                "status":          _safe_str(r.get("STATUS")),
                "wait_event":      _safe_str(r.get("EVENT")),
                "wait_class":      _safe_str(r.get("WAIT_CLASS")),
                "seconds_in_wait": _safe_float(r.get("SECONDS_IN_WAIT")),
                "state":           _safe_str(r.get("STATE")),
                "machine":         _safe_str(r.get("MACHINE")),
                "program":         _safe_str(r.get("PROGRAM")),
            }
    except Exception:
        pass

    return {
        "status":       "success",
        "sql_id":       sql_id,
        "plan":         plan,
        "sql_stats":    sql_stats,
        "indexes_used": indexes_used,
        "wait_info":    wait_info,
        "plan_steps":   len(plan),
    }


# ──────────────────────────────────────────────────────────────
#  24. ARCHIVE LOG GAP
# ──────────────────────────────────────────────────────────────

def oracle_archive_log_gap(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    dr_gap, hourly_rate, arch_mode, arch_dest = [], [], "", []
    errors = []

    try:
        raw = _rows(engine, """
            SELECT dest_id, db_unique_name,
                   thread#                              AS thread_num,
                   archived_seq#                        AS log_archived,
                   applied_seq#                         AS log_applied,
                   archived_seq# - applied_seq#         AS log_gap,
                   status, target, archiver, schedule, dest_name
            FROM   v$archive_dest_status
            WHERE  status != 'INACTIVE' ORDER BY dest_id""")
        dr_gap = [
            {
                "dest_id":      _safe_int(r.get("DEST_ID")),
                "dest_name":    _safe_str(r.get("DEST_NAME")),
                "db_unique":    _safe_str(r.get("DB_UNIQUE_NAME")),
                "thread_num":   _safe_int(r.get("THREAD_NUM")),
                "log_archived": _safe_int(r.get("LOG_ARCHIVED")),
                "log_applied":  _safe_int(r.get("LOG_APPLIED")),
                "log_gap":      _safe_int(r.get("LOG_GAP")),
                "status":       _safe_str(r.get("STATUS")),
                "target":       _safe_str(r.get("TARGET")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"dr_gap: {exc}")

    try:
        raw = _rows(engine, """
            SELECT TO_CHAR(first_time,'YYYY-MM-DD HH24') AS hour_slot,
                   COUNT(*)                              AS logs_count,
                   ROUND(SUM(blocks*block_size)/1024/1024,2) AS mb_generated,
                   thread#
            FROM   v$archived_log
            WHERE  first_time >= SYSDATE - 1 AND standby_dest = 'NO'
            GROUP  BY TO_CHAR(first_time,'YYYY-MM-DD HH24'), thread#
            ORDER  BY hour_slot DESC FETCH FIRST 48 ROWS ONLY""")
        hourly_rate = [
            {"hour_slot": _safe_str(r.get("HOUR_SLOT")), "logs": _safe_int(r.get("LOGS_COUNT")),
             "mb": _safe_float(r.get("MB_GENERATED")), "thread": _safe_int(r.get("THREAD#"))}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"hourly_rate: {exc}")

    try:
        rows = _rows(engine, "SELECT log_mode FROM v$database")
        arch_mode = _safe_str(rows[0].get("LOG_MODE")) if rows else ""
    except Exception:
        pass

    try:
        raw = _rows(engine, """
            SELECT dest_id, dest_name, status, target, archiver, schedule, destination, transmit_mode
            FROM   v$archive_dest WHERE status != 'INACTIVE' ORDER BY dest_id""")
        arch_dest = [
            {"dest_id": _safe_int(r.get("DEST_ID")), "dest_name": _safe_str(r.get("DEST_NAME")),
             "status": _safe_str(r.get("STATUS")), "target": _safe_str(r.get("TARGET")),
             "destination": _safe_str(r.get("DESTINATION"))}
            for r in raw
        ]
    except Exception:
        pass

    standby_lag = max((g["log_gap"] for g in dr_gap if g.get("target") == "STANDBY"), default=0)
    total_lag   = sum(g["log_gap"] for g in dr_gap if g.get("target") == "STANDBY")

    return {
        "status":      "success",
        "arch_mode":   arch_mode,
        "dr_gap":      dr_gap,
        "hourly_rate": hourly_rate,
        "arch_dest":   arch_dest,
        "max_gap":     standby_lag,
        "total_gap":   total_lag,
        "errors":      errors,
    }


# ──────────────────────────────────────────────────────────────
#  25. RMAN BACKUP
# ──────────────────────────────────────────────────────────────

def oracle_rman_backup(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    jobs, last_db_backup, errors = [], None, []

    try:
        raw = _rows(engine, """
            SELECT session_key, input_type, status,
                   TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
                   TO_CHAR(end_time,   'YYYY-MM-DD HH24:MI:SS') AS end_time,
                   ROUND((end_time - start_time) * 24, 4)        AS hrs,
                   ROUND(input_bytes  / 1073741824, 3)           AS input_gb,
                   ROUND(output_bytes / 1073741824, 3)           AS output_gb,
                   ROUND(output_bytes_per_sec / 1048576, 2)      AS mb_per_sec,
                   output_device_type,
                   ROUND(compression_ratio, 2)                   AS compression_ratio,
                   elapsed_seconds, incremental_level
            FROM   v$rman_backup_job_details
            ORDER  BY start_time DESC FETCH FIRST 30 ROWS ONLY""")
        jobs = [
            {
                "session_key":        _safe_int(r.get("SESSION_KEY")),
                "input_type":         _safe_str(r.get("INPUT_TYPE")),
                "status":             _safe_str(r.get("STATUS")),
                "start_time":         _safe_str(r.get("START_TIME")),
                "end_time":           _safe_str(r.get("END_TIME")),
                "hrs":                round(_safe_float(r.get("HRS")), 4),
                "input_gb":           round(_safe_float(r.get("INPUT_GB")), 3),
                "output_gb":          round(_safe_float(r.get("OUTPUT_GB")), 3),
                "mb_per_sec":         round(_safe_float(r.get("MB_PER_SEC")), 2),
                "output_device_type": _safe_str(r.get("OUTPUT_DEVICE_TYPE")),
                "compression_ratio":  round(_safe_float(r.get("COMPRESSION_RATIO")), 2),
                "elapsed_seconds":    _safe_int(r.get("ELAPSED_SECONDS")),
                "incremental_level":  _safe_int(r.get("INCREMENTAL_LEVEL")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"rman_jobs: {exc}")

    db_jobs = [j for j in jobs if "DB" in j["input_type"].upper()]
    if db_jobs:
        last_db_backup = db_jobs[0]

    running = [j for j in jobs if j["status"] == "RUNNING"]
    failed  = [j for j in jobs if j["status"] in ("FAILED", "COMPLETED WITH WARNINGS")]

    return {"status": "success", "jobs": jobs, "last_db_backup": last_db_backup,
            "running": running, "failed": failed, "total": len(jobs), "errors": errors}


# ──────────────────────────────────────────────────────────────
#  26. INVALID OBJECTS DETAIL
# ──────────────────────────────────────────────────────────────

def oracle_invalid_objects_detail(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    objects, errors = [], []

    def _try_invalid(view_name):
        return _rows(engine, f"""
            SELECT owner, object_type, object_name, status,
                   TO_CHAR(last_ddl_time,'YYYY-MM-DD HH24:MI:SS') AS last_ddl_time,
                   TO_CHAR(created,'YYYY-MM-DD HH24:MI:SS')        AS created
            FROM   {view_name}
            WHERE  status = 'INVALID' AND owner NOT IN ({_SYSTEM_OWNERS})
            ORDER  BY owner, object_type, object_name""")

    try:
        raw = _try_invalid("dba_objects")
    except Exception:
        try:
            raw = _try_invalid("all_objects")
        except Exception as exc:
            errors.append(str(exc))
            raw = []

    objects = [
        {
            "owner":       _safe_str(r.get("OWNER")),
            "object_type": _safe_str(r.get("OBJECT_TYPE")),
            "object_name": _safe_str(r.get("OBJECT_NAME")),
            "status":      _safe_str(r.get("STATUS")),
            "last_ddl":    _safe_str(r.get("LAST_DDL_TIME")),
            "created":     _safe_str(r.get("CREATED")),
        }
        for r in raw
    ]

    by_type  = {}
    by_owner = {}
    for o in objects:
        by_type[o["object_type"]]  = by_type.get(o["object_type"], 0) + 1
        by_owner[o["owner"]]       = by_owner.get(o["owner"], 0) + 1

    return {
        "status":   "success",
        "objects":  objects,
        "total":    len(objects),
        "by_type":  [{"type": k, "count": v} for k, v in sorted(by_type.items(), key=lambda x: -x[1])],
        "by_owner": [{"owner": k, "count": v} for k, v in sorted(by_owner.items(), key=lambda x: -x[1])],
        "errors":   errors,
    }


# ──────────────────────────────────────────────────────────────
#  27. DATAFILE MOUNTS
# ──────────────────────────────────────────────────────────────

def oracle_datafile_mounts(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    datafiles, tempfiles, logfiles, mount_summary, errors = [], [], [], [], []

    try:
        raw = _rows(engine, """
            SELECT df.file_id, df.tablespace_name, df.file_name,
                   ROUND(df.bytes/1073741824,3)    AS size_gb,
                   df.autoextensible,
                   ROUND(df.maxbytes/1073741824,3) AS max_gb,
                   df.status,
                   REGEXP_SUBSTR(df.file_name,'^(/[^/]*/[^/]*)') AS mount_point
            FROM   dba_data_files df
            ORDER  BY df.tablespace_name, df.file_name""")
        datafiles = [
            {
                "file_id":    _safe_int(r.get("FILE_ID")),
                "tablespace": _safe_str(r.get("TABLESPACE_NAME")),
                "file_name":  _safe_str(r.get("FILE_NAME")),
                "size_gb":    round(_safe_float(r.get("SIZE_GB")), 3),
                "autoextend": _safe_str(r.get("AUTOEXTENSIBLE")),
                "max_gb":     round(_safe_float(r.get("MAX_GB")), 3),
                "status":     _safe_str(r.get("STATUS")),
                "mount":      _safe_str(r.get("MOUNT_POINT")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"datafiles: {exc}")

    try:
        raw = _rows(engine, """
            SELECT tf.file_id, tf.tablespace_name, tf.file_name,
                   ROUND(tf.bytes/1073741824,3) AS size_gb,
                   tf.autoextensible, tf.status
            FROM   dba_temp_files tf ORDER BY tf.tablespace_name""")
        tempfiles = [
            {
                "file_id":    _safe_int(r.get("FILE_ID")),
                "tablespace": _safe_str(r.get("TABLESPACE_NAME")),
                "file_name":  _safe_str(r.get("FILE_NAME")),
                "size_gb":    round(_safe_float(r.get("SIZE_GB")), 3),
                "autoextend": _safe_str(r.get("AUTOEXTENSIBLE")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"tempfiles: {exc}")

    try:
        raw = _rows(engine, """
            SELECT lf.group#, lf.member, lf.type,
                   lg.bytes/1048576 AS size_mb, lg.status, lg.archived
            FROM   v$logfile lf
            JOIN   v$log lg ON lg.group# = lf.group#
            ORDER  BY lf.group#, lf.member""")
        logfiles = [
            {
                "group":    _safe_int(r.get("GROUP#")),
                "member":   _safe_str(r.get("MEMBER")),
                "type":     _safe_str(r.get("TYPE")),
                "size_mb":  round(_safe_float(r.get("SIZE_MB")), 1),
                "status":   _safe_str(r.get("STATUS")),
                "archived": _safe_str(r.get("ARCHIVED")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"logfiles: {exc}")

    mnt = {}
    for f in datafiles:
        mp = f["mount"] or "unknown"
        if mp not in mnt:
            mnt[mp] = {"mount": mp, "files": 0, "total_gb": 0.0}
        mnt[mp]["files"]    += 1
        mnt[mp]["total_gb"] += f["size_gb"]
    mount_summary = sorted(mnt.values(), key=lambda x: -x["total_gb"])

    return {
        "status":        "success",
        "datafiles":     datafiles,
        "tempfiles":     tempfiles,
        "logfiles":      logfiles,
        "mount_summary": mount_summary,
        "errors":        errors,
    }


# ──────────────────────────────────────────────────────────────
#  28. SAR / TOP PROCESSES
# ──────────────────────────────────────────────────────────────

def oracle_sar_top(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    os_stats, top_cpu, top_io, sysstat_top, errors = {}, [], [], [], []

    try:
        raw = _rows(engine, """
            SELECT stat_name, value, comments FROM v$osstat
            WHERE  stat_name IN (
                'NUM_CPUS','NUM_CPU_CORES','NUM_CPU_SOCKETS',
                'PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES',
                'BUSY_TIME','IDLE_TIME','USER_TIME','SYS_TIME',
                'IOWAIT_TIME','NICE_TIME','LOAD',
                'VM_IN_BYTES','VM_OUT_BYTES',
                'TCP_SEND_KB','TCP_RECV_KB'
            )""")
        for r in raw:
            sn  = _safe_str(r.get("STAT_NAME"))
            val = _safe_float(r.get("VALUE"))
            if "BYTES" in sn:
                os_stats[sn] = round(val / 1073741824, 2)
            elif "KB" in sn:
                os_stats[sn] = round(val / 1024, 2)
            else:
                os_stats[sn] = val
    except Exception as exc:
        errors.append(f"os_stats: {exc}")

    try:
        raw = _rows(engine, """
            SELECT s.sid, s.username, s.program, s.machine, s.status,
                   s.event, st.value AS cpu_used, p.spid AS os_pid,
                   ROUND(100 * st.value / NULLIF(SUM(st.value) OVER(), 0), 2) AS cpu_pct
            FROM   v$session s
            JOIN   v$sesstat  st ON st.sid = s.sid
            JOIN   v$statname sn ON sn.statistic# = st.statistic# AND sn.name = 'CPU used by this session'
            JOIN   v$process   p ON p.addr = s.paddr
            WHERE  s.type = 'USER' AND st.value > 0
            ORDER  BY st.value DESC FETCH FIRST 15 ROWS ONLY""")
        top_cpu = [
            {
                "sid":      _safe_int(r.get("SID")),
                "username": _safe_str(r.get("USERNAME")),
                "program":  _safe_str(r.get("PROGRAM")),
                "machine":  _safe_str(r.get("MACHINE")),
                "status":   _safe_str(r.get("STATUS")),
                "event":    _safe_str(r.get("EVENT")),
                "cpu_used": _safe_int(r.get("CPU_USED")),
                "cpu_pct":  round(_safe_float(r.get("CPU_PCT")), 2),
                "os_pid":   _safe_str(r.get("OS_PID")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"top_cpu: {exc}")

    try:
        raw = _rows(engine, """
            SELECT s.sid, s.username, s.program,
                   pio.value AS physical_reads, bio.value AS block_gets
            FROM   v$session s
            JOIN   v$sesstat pio ON pio.sid = s.sid
            JOIN   v$statname pn ON pn.statistic# = pio.statistic# AND pn.name = 'physical reads'
            JOIN   v$sesstat bio ON bio.sid = s.sid
            JOIN   v$statname bn ON bn.statistic# = bio.statistic# AND bn.name = 'db block gets'
            WHERE  s.type = 'USER' AND pio.value > 0
            ORDER  BY pio.value DESC FETCH FIRST 10 ROWS ONLY""")
        top_io = [
            {
                "sid":            _safe_int(r.get("SID")),
                "username":       _safe_str(r.get("USERNAME")),
                "program":        _safe_str(r.get("PROGRAM")),
                "physical_reads": _safe_int(r.get("PHYSICAL_READS")),
                "block_gets":     _safe_int(r.get("BLOCK_GETS")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"top_io: {exc}")

    try:
        raw = _rows(engine, """
            SELECT sn.name, ss.value FROM v$sysstat ss
            JOIN   v$statname sn ON sn.statistic# = ss.statistic#
            WHERE  ss.value > 0 AND sn.class IN (1, 4, 8, 64)
            ORDER  BY ss.value DESC FETCH FIRST 20 ROWS ONLY""")
        sysstat_top = [{"name": _safe_str(r.get("NAME")), "value": _safe_int(r.get("VALUE"))} for r in raw]
    except Exception as exc:
        errors.append(f"sysstat: {exc}")

    busy    = _safe_float(os_stats.get("BUSY_TIME"))
    idle    = _safe_float(os_stats.get("IDLE_TIME"))
    total   = busy + idle
    cpu_pct = round(100 * busy / total, 1) if total > 0 else 0

    phys_gb = _safe_float(os_stats.get("PHYSICAL_MEMORY_BYTES"))
    free_gb = _safe_float(os_stats.get("FREE_MEMORY_BYTES"))
    mem_pct = round(100 * (phys_gb - free_gb) / phys_gb, 1) if phys_gb > 0 else 0

    return {
        "status":      "success",
        "os_stats":    os_stats,
        "cpu_pct":     cpu_pct,
        "mem_pct":     mem_pct,
        "phys_gb":     phys_gb,
        "free_gb":     free_gb,
        "load":        os_stats.get("LOAD", 0),
        "top_cpu":     top_cpu,
        "top_io":      top_io,
        "sysstat_top": sysstat_top,
        "errors":      errors,
    }


# ──────────────────────────────────────────────────────────────
#  29. EBS CONCURRENT MANAGER
# ──────────────────────────────────────────────────────────────

def oracle_ebs_concurrent(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    managers, running_requests, errors = [], [], []

    try:
        raw = _rows(engine, """
            SELECT concurrent_queue_name,
                   user_concurrent_queue_name AS display_name,
                   enabled_flag, running_processes, max_processes, min_processes, description
            FROM   apps.fnd_concurrent_queues_vl
            ORDER  BY user_concurrent_queue_name""")
        managers = [
            {
                "name":        _safe_str(r.get("CONCURRENT_QUEUE_NAME")),
                "display":     _safe_str(r.get("DISPLAY_NAME")),
                "enabled":     _safe_str(r.get("ENABLED_FLAG")),
                "running":     _safe_int(r.get("RUNNING_PROCESSES")),
                "max":         _safe_int(r.get("MAX_PROCESSES")),
                "min":         _safe_int(r.get("MIN_PROCESSES")),
                "description": _safe_str(r.get("DESCRIPTION")),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"concurrent_managers: {exc}")

    try:
        raw = _rows(engine, """
            SELECT fcr.request_id,
                   fcp.user_concurrent_program_name  AS program_name,
                   fcr.status_code, fcr.phase_code,
                   fcr.requested_by,
                   TO_CHAR(fcr.actual_start_date,'YYYY-MM-DD HH24:MI:SS') AS start_time,
                   ROUND((SYSDATE - fcr.actual_start_date)*60, 1)         AS running_mins
            FROM   apps.fnd_concurrent_requests   fcr
            JOIN   apps.fnd_concurrent_programs_vl fcp
                ON fcp.concurrent_program_id = fcr.concurrent_program_id
            WHERE  fcr.phase_code = 'R'
            ORDER  BY fcr.actual_start_date FETCH FIRST 50 ROWS ONLY""")
        running_requests = [
            {
                "request_id":   _safe_int(r.get("REQUEST_ID")),
                "program":      _safe_str(r.get("PROGRAM_NAME")),
                "status":       _safe_str(r.get("STATUS_CODE")),
                "phase":        _safe_str(r.get("PHASE_CODE")),
                "requested_by": _safe_str(r.get("REQUESTED_BY")),
                "start_time":   _safe_str(r.get("START_TIME")),
                "running_mins": round(_safe_float(r.get("RUNNING_MINS")), 1),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"running_requests: {exc}")

    return {"status": "success", "is_ebs": len(managers) > 0,
            "managers": managers, "running_requests": running_requests, "errors": errors}


# ──────────────────────────────────────────────────────────────
#  30. EBS WORKFLOW
# ──────────────────────────────────────────────────────────────

def oracle_ebs_workflow(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    stuck, by_type, errors = [], [], []

    try:
        raw = _rows(engine, """
            SELECT item_type, item_key,
                   activity_status, activity_result_code,
                   TO_CHAR(begin_date,'YYYY-MM-DD HH24:MI:SS') AS begin_date,
                   ROUND(SYSDATE - begin_date, 2)               AS days_stuck
            FROM   wf_item_activity_statuses
            WHERE  activity_status IN ('NOTIFIED','DEFERRED','ERROR')
              AND  begin_date < SYSDATE - 1/24
            ORDER  BY begin_date FETCH FIRST 100 ROWS ONLY""")
        stuck = [
            {
                "item_type":   _safe_str(r.get("ITEM_TYPE")),
                "item_key":    _safe_str(r.get("ITEM_KEY")),
                "status":      _safe_str(r.get("ACTIVITY_STATUS")),
                "result_code": _safe_str(r.get("ACTIVITY_RESULT_CODE")),
                "begin_date":  _safe_str(r.get("BEGIN_DATE")),
                "days_stuck":  round(_safe_float(r.get("DAYS_STUCK")), 2),
            }
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"workflow_stuck: {exc}")

    try:
        raw = _rows(engine, """
            SELECT activity_status, COUNT(*) AS cnt
            FROM   wf_item_activity_statuses
            GROUP  BY activity_status ORDER BY cnt DESC""")
        by_type = [{"status": _safe_str(r.get("ACTIVITY_STATUS")), "count": _safe_int(r.get("CNT"))} for r in raw]
    except Exception as exc:
        errors.append(f"workflow_by_type: {exc}")

    return {"status": "success", "is_ebs": len(by_type) > 0,
            "stuck": stuck, "by_type": by_type, "total_stuck": len(stuck), "errors": errors}


# ──────────────────────────────────────────────────────────────
#  31. DB INSTANCE STATUS SNAPSHOT
# ──────────────────────────────────────────────────────────────

def oracle_db_status(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    result = {"status": "success", "db_status": {}, "instance": {}, "sessions": {}, "errors": []}

    try:
        rows = _rows(engine, """
            SELECT d.name, d.db_unique_name, d.open_mode, d.database_role,
                   d.protection_mode, d.flashback_on, d.log_mode, d.platform_name,
                   i.instance_name, i.host_name, i.version,
                   i.status         AS inst_status,
                   i.database_status, i.logins, i.archiver,
                   TO_CHAR(i.startup_time,'YYYY-MM-DD HH24:MI:SS') AS startup_time,
                   ROUND(SYSDATE - i.startup_time, 2)               AS uptime_days
            FROM   v$database d, v$instance i""")
        if rows:
            r = rows[0]
            result["db_status"] = {
                "name":        _safe_str(r.get("NAME")),
                "unique_name": _safe_str(r.get("DB_UNIQUE_NAME")),
                "open_mode":   _safe_str(r.get("OPEN_MODE")),
                "role":        _safe_str(r.get("DATABASE_ROLE")),
                "protection":  _safe_str(r.get("PROTECTION_MODE")),
                "flashback":   _safe_str(r.get("FLASHBACK_ON")),
                "log_mode":    _safe_str(r.get("LOG_MODE")),
                "platform":    _safe_str(r.get("PLATFORM_NAME")),
            }
            result["instance"] = {
                "name":         _safe_str(r.get("INSTANCE_NAME")),
                "host":         _safe_str(r.get("HOST_NAME")),
                "version":      _safe_str(r.get("VERSION")),
                "status":       _safe_str(r.get("INST_STATUS")),
                "db_status":    _safe_str(r.get("DATABASE_STATUS")),
                "logins":       _safe_str(r.get("LOGINS")),
                "archiver":     _safe_str(r.get("ARCHIVER")),
                "startup_time": _safe_str(r.get("STARTUP_TIME")),
                "uptime_days":  round(_safe_float(r.get("UPTIME_DAYS")), 2),
            }
    except Exception as exc:
        result["errors"].append(f"db_status: {exc}")

    try:
        rows = _rows(engine, "SELECT status, COUNT(*) AS cnt FROM v$session WHERE type = 'USER' GROUP BY status ORDER BY status")
        result["sessions"] = {_safe_str(r.get("STATUS")): _safe_int(r.get("CNT")) for r in rows}
    except Exception:
        pass

    return result
