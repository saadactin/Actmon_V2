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


# ──────────────────────────────────────────────────────────────
#  1. MONITORING DASHBOARD
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/monitoring-dashboard")
def oracle_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Comprehensive Oracle monitoring dashboard.
    Returns instance info, session counts, memory usage, tablespace utilisation,
    active SQL, wait events, and buffer cache hit ratio.
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

    # ── Version ───────────────────────────────────────────────
    version = ""
    try:
        rows = _rows(engine, "SELECT banner FROM v$version WHERE rownum=1")
        version = rows[0].get("BANNER", "") if rows else ""
    except Exception as exc:
        errors.append(f"version: {exc}")

    # ── Instance ──────────────────────────────────────────────
    instance_info = {}
    try:
        rows = _rows(
            engine,
            "SELECT instance_name, host_name, version, status, startup_time "
            "FROM v$instance"
        )
        if rows:
            instance_info = rows[0]
            instance_info = {k: _safe_str(v) for k, v in instance_info.items()}
    except Exception as exc:
        errors.append(f"instance: {exc}")

    # ── DB name / log mode ────────────────────────────────────
    db_info = {}
    try:
        rows = _rows(
            engine,
            "SELECT name, db_unique_name, log_mode FROM v$database"
        )
        if rows:
            db_info = {k: _safe_str(v) for k, v in rows[0].items()}
    except Exception as exc:
        errors.append(f"database: {exc}")

    # ── Session counts ────────────────────────────────────────
    active_sessions = 0
    total_sessions = 0
    max_sessions = 0
    try:
        rows = _rows(
            engine,
            "SELECT count(*) AS cnt FROM v$session WHERE status='ACTIVE' AND type='USER'"
        )
        active_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"active_sessions: {exc}")

    try:
        rows = _rows(
            engine,
            "SELECT count(*) AS cnt FROM v$session WHERE type='USER'"
        )
        total_sessions = _safe_int(rows[0].get("CNT", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"total_sessions: {exc}")

    try:
        rows = _rows(
            engine,
            "SELECT value FROM v$parameter WHERE name='sessions'"
        )
        max_sessions = _safe_int(rows[0].get("VALUE", 0)) if rows else 0
    except Exception as exc:
        errors.append(f"max_sessions: {exc}")

    session_pct = round(total_sessions / max_sessions * 100, 2) if max_sessions > 0 else 0.0

    # ── SGA usage ─────────────────────────────────────────────
    sga_stats = []
    sga_mb_total = 0.0
    try:
        sga_stats = _rows(
            engine,
            "SELECT name, bytes/1024/1024 AS mb FROM v$sgastat "
            "WHERE pool IS NULL ORDER BY bytes DESC"
        )
        sga_stats = [
            {"name": _safe_str(r.get("NAME")), "mb": round(_safe_float(r.get("MB")), 2)}
            for r in sga_stats
        ]
        sga_mb_total = round(sum(r["mb"] for r in sga_stats), 2)
    except Exception as exc:
        errors.append(f"sga: {exc}")

    # ── PGA usage ─────────────────────────────────────────────
    pga_mb = 0.0
    try:
        rows = _rows(
            engine,
            "SELECT sum(pga_alloc_mem)/1024/1024 AS pga_mb FROM v$process"
        )
        pga_mb = round(_safe_float(rows[0].get("PGA_MB", 0.0)), 2) if rows else 0.0
    except Exception as exc:
        errors.append(f"pga: {exc}")

    # ── DB size ───────────────────────────────────────────────
    db_size_gb = 0.0
    try:
        rows = _rows(
            engine,
            "SELECT sum(bytes)/1024/1024/1024 AS size_gb FROM dba_data_files"
        )
        db_size_gb = round(_safe_float(rows[0].get("SIZE_GB", 0.0)), 4) if rows else 0.0
    except Exception as exc:
        errors.append(f"db_size: {exc}")

    # ── Tablespaces ───────────────────────────────────────────
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

    # ── Active SQL ────────────────────────────────────────────
    active_sql = []
    try:
        active_sql = _rows(
            engine,
            """SELECT s.sid,
                      s.serial#,
                      s.username,
                      s.status,
                      s.machine,
                      s.module,
                      ROUND((sysdate-s.logon_time)*24*60,1) AS session_min,
                      SUBSTR(q.sql_text,1,200)              AS sql_text
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

    # ── Wait events ───────────────────────────────────────────
    wait_events = []
    try:
        wait_events = _rows(
            engine,
            """SELECT event,
                      count(*) AS cnt,
                      round(avg(wait_time_micro)/1000000,3) AS avg_wait_sec
               FROM v$session_wait
               WHERE wait_class != 'Idle'
               GROUP BY event
               ORDER BY cnt DESC
               FETCH FIRST 10 ROWS ONLY"""
        )
        wait_events = [
            {
                "event":        _safe_str(r.get("EVENT")),
                "count":        _safe_int(r.get("CNT")),
                "avg_wait_sec": round(_safe_float(r.get("AVG_WAIT_SEC")), 3),
            }
            for r in wait_events
        ]
    except Exception as exc:
        errors.append(f"wait_events: {exc}")

    # ── Buffer cache hit ratio ────────────────────────────────
    buffer_cache_hit_pct = 0.0
    try:
        rows = _rows(
            engine,
            """SELECT ROUND(1-phyrds/(dbgets+NULLIF(consists,0)),4)*100 AS pct
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

    # ── Compose response ──────────────────────────────────────
    health_summary = {
        "version":              version,
        "instance_name":        instance_info.get("INSTANCE_NAME", ""),
        "host_name":            instance_info.get("HOST_NAME", ""),
        "status":               instance_info.get("STATUS", ""),
        "startup_time":         instance_info.get("STARTUP_TIME", ""),
        "db_name":              db_info.get("NAME", ""),
        "db_unique_name":       db_info.get("DB_UNIQUE_NAME", ""),
        "log_mode":             db_info.get("LOG_MODE", ""),
        "active_sessions":      active_sessions,
        "total_sessions":       total_sessions,
        "max_sessions":         max_sessions,
        "session_pct":          session_pct,
        "sga_mb":               sga_mb_total,
        "pga_mb":               pga_mb,
        "db_size_gb":           db_size_gb,
        "buffer_cache_hit_pct": buffer_cache_hit_pct,
    }

    return {
        "status":               "success",
        "health_summary":       health_summary,
        "sga_details":          sga_stats,
        "tablespaces":          tablespaces,
        "active_sql":           active_sql,
        "wait_events":          wait_events,
        "errors":               errors,
    }


# ──────────────────────────────────────────────────────────────
#  2. SLOW QUERIES
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-slow-queries")
def oracle_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Top 50 slowest SQL statements from v$sqlarea ranked by average elapsed time.
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
        return {
            "status":  "success",
            "source":  "v$sqlarea",
            "total":   len(queries),
            "queries": queries,
            "error":   None,
        }
    except Exception as exc:
        return {
            "status":  "error",
            "source":  "v$sqlarea",
            "total":   0,
            "queries": [],
            "error":   str(exc),
        }


# ──────────────────────────────────────────────────────────────
#  3. ERROR LOGS
# ──────────────────────────────────────────────────────────────

@router.get("/{conn_id}/oracle-error-logs")
def oracle_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """
    Retrieves Oracle alert log entries (12c+ via v$diag_alert_ext, falls back to
    v$log) plus sessions in problematic wait states or long waits.
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

    alert_logs = []
    source = ""
    note = ""

    # ── Primary: v$diag_alert_ext (Oracle 12c+) ───────────────
    try:
        raw = _rows(
            engine,
            """SELECT originating_timestamp,
                      organization_id,
                      component_id,
                      message_text,
                      message_level
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
        # ── Fallback: v$log (redo log info) ───────────────────
        try:
            raw = _rows(
                engine,
                """SELECT instance_number,
                          thread#,
                          sequence#,
                          first_change#,
                          first_time,
                          next_time,
                          status
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
            note = (
                "v$diag_alert_ext not accessible (requires SYSDBA or diagnostic pack); "
                "showing redo log info from v$log instead."
            )
        except Exception as exc:
            source = "none"
            note = f"Both v$diag_alert_ext and v$log queries failed: {exc}"

    # ── Blocking / problem sessions ───────────────────────────
    blocking_sessions = []
    try:
        raw = _rows(
            engine,
            """SELECT sid,
                      serial#,
                      username,
                      status,
                      state,
                      event,
                      wait_class,
                      seconds_in_wait,
                      machine
               FROM v$session
               WHERE wait_class='Application'
                  OR wait_class='Concurrency'
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
        note += f" | blocking_sessions query failed: {exc}"

    return {
        "status":           "success",
        "source":           source,
        "total":            len(alert_logs),
        "alert_logs":       alert_logs,
        "blocking_sessions": blocking_sessions,
        "note":             note,
    }


# ──────────────────────────────────────────────────────────────
#  4. INDEX ANALYSIS
# ──────────────────────────────────────────────────────────────

_ORACLE_SYSTEM_OWNERS = (
    "'SYS','SYSTEM','OUTLN','DBSNMP','WMSYS','XDB',"
    "'APEX_030200','APEX_040200','CTXSYS','MDSYS',"
    "'OLAPSYS','ORDDATA','ORDSYS','SI_INFORMTN_SCHEMA'"
)

@router.get("/{conn_id}/oracle-index-analysis")
def oracle_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    """
    Analyses indexes in user schemas:
    - Full index inventory from dba_indexes.
    - Fragmented indexes (blevel >= 3) ranked by estimated fragmentation.
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

    # ── Full index inventory ───────────────────────────────────
    indexes = []
    try:
        raw = _rows(
            engine,
            f"""SELECT i.owner,
                       i.table_name,
                       i.index_name,
                       i.index_type,
                       i.uniqueness,
                       i.status,
                       i.num_rows,
                       i.leaf_blocks
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

    # ── Fragmented indexes ────────────────────────────────────
    fragmented_indexes = []
    try:
        raw = _rows(
            engine,
            """SELECT owner,
                      index_name,
                      table_name,
                      blevel,
                      leaf_blocks,
                      ROUND(100*(1-1/POWER(2,blevel)),1) AS fragmentation_pct
               FROM dba_indexes
               WHERE blevel >= 3
                 AND owner NOT IN ('SYS','SYSTEM')
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

    # ── Summary ───────────────────────────────────────────────
    total_indexes = len(indexes)
    unique_indexes = sum(1 for i in indexes if i["uniqueness"] == "UNIQUE")
    nonunique_indexes = total_indexes - unique_indexes
    unusable_indexes = sum(1 for i in indexes if i["status"] == "UNUSABLE")
    fragmented_count = len(fragmented_indexes)
    high_frag = [f for f in fragmented_indexes if f["fragmentation_pct"] >= 50.0]

    summary = {
        "total_indexes":          total_indexes,
        "unique_indexes":         unique_indexes,
        "non_unique_indexes":     nonunique_indexes,
        "unusable_indexes":       unusable_indexes,
        "fragmented_indexes":     fragmented_count,
        "high_fragmentation_gte50_pct": len(high_frag),
    }

    return {
        "status":             "success",
        "indexes":            indexes,
        "fragmented_indexes": fragmented_indexes,
        "summary":            summary,
        "errors":             errors,
    }
