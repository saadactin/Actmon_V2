from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus
import datetime

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL Monitoring"]
)


# ── Database session ──────────────────────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Engine factory ────────────────────────────────────────────────────────────

def _mssql_engine(conn):
    pw = quote_plus(conn.password or "")
    db_name = conn.database_name or "master"
    return create_engine(
        f"mssql+pyodbc://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name}"
        "?driver=ODBC+Driver+17+for+SQL+Server&timeout=5",
        pool_pre_ping=True
    )


# ── Helper: run a query and return list of dicts ──────────────────────────────

def _rows(engine, sql):
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


# ── Helper: safe scalar fetch ─────────────────────────────────────────────────

def _scalar(engine, sql, default=None):
    try:
        with engine.connect() as c:
            row = c.execute(text(sql)).fetchone()
            return row[0] if row else default
    except Exception:
        return default


# ── Helper: uptime string from seconds ───────────────────────────────────────

def _uptime_str(seconds):
    if not seconds or seconds <= 0:
        return "0s"
    days = int(seconds) // 86400
    hours = (int(seconds) % 86400) // 3600
    minutes = (int(seconds) % 3600) // 60
    secs = int(seconds) % 60
    if days > 0:
        return f"{days}d {hours}h {minutes}m"
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m {secs}s"


# ── Helper: safe int conversion ───────────────────────────────────────────────

def _to_int(val, default=0):
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


# ── Helper: safe float conversion ────────────────────────────────────────────

def _to_float(val, default=0.0):
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINT 1 — Monitoring Dashboard
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    """
    Comprehensive MSSQL monitoring dashboard.
    Returns health summary, database list, wait stats, active queries,
    and top CPU queries in a single response.
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")

    conn_meta = {
        "id": conn_rec.id,
        "name": conn_rec.connection_name,
        "host": conn_rec.host,
        "port": conn_rec.port,
        "database": conn_rec.database_name,
    }

    try:
        engine = _mssql_engine(conn_rec)

        # ── Server info ───────────────────────────────────────────────────────
        server_info = {}
        try:
            rows = _rows(
                engine,
                "SELECT @@SERVERNAME AS server_name, @@VERSION AS version, "
                "GETDATE() AS current_time"
            )
            server_info = rows[0] if rows else {}
        except Exception as e:
            server_info = {"error": str(e)}

        # ── Uptime ────────────────────────────────────────────────────────────
        uptime_str = "N/A"
        last_restart_str = "N/A"
        try:
            start_row = _rows(
                engine,
                "SELECT sqlserver_start_time FROM sys.dm_os_sys_info"
            )
            if start_row:
                start_time = start_row[0].get("sqlserver_start_time")
                if start_time:
                    if isinstance(start_time, str):
                        start_time = datetime.datetime.fromisoformat(start_time)
                    now = datetime.datetime.now()
                    delta = now - start_time
                    uptime_str = _uptime_str(delta.total_seconds())
                    last_restart_str = start_time.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

        # ── Active sessions ───────────────────────────────────────────────────
        active_sessions = 0
        try:
            row = _rows(
                engine,
                "SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions "
                "WHERE is_user_process = 1"
            )
            active_sessions = _to_int(row[0].get("cnt", 0)) if row else 0
        except Exception:
            pass

        # ── Max connections config ────────────────────────────────────────────
        max_connections = 0
        try:
            row = _rows(
                engine,
                "SELECT CAST(value_in_use AS INT) AS max_conn "
                "FROM sys.configurations WHERE name = 'max connections'"
            )
            max_connections = _to_int(row[0].get("max_conn", 0)) if row else 0
        except Exception:
            pass

        # Use the SQL Server default (32767) when the config value is 0
        effective_max = max_connections if max_connections > 0 else 32767
        connection_pct = round((active_sessions / effective_max) * 100, 2)

        # ── Buffer cache hit ratio ────────────────────────────────────────────
        buffer_cache_hit_pct = 0.0
        try:
            rows = _rows(
                engine,
                "SELECT cntr_value FROM sys.dm_os_performance_counters "
                "WHERE counter_name = 'Buffer cache hit ratio' "
                "AND object_name LIKE '%Buffer Manager%'"
            )
            if rows:
                buffer_cache_hit_pct = _to_float(rows[0].get("cntr_value", 0))
        except Exception:
            pass

        # ── Databases ─────────────────────────────────────────────────────────
        databases = []
        total_databases = 0
        try:
            databases = _rows(
                engine,
                """
                SELECT
                    d.name,
                    d.state_desc,
                    d.recovery_model_desc,
                    CAST(
                        SUM(CAST(f.size AS BIGINT)) * 8.0 / 1024
                        AS DECIMAL(10,2)
                    ) AS size_mb
                FROM sys.databases d
                LEFT JOIN sys.master_files f
                    ON d.database_id = f.database_id
                GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.database_id
                ORDER BY size_mb DESC
                """
            )
            total_databases = len(databases)
            # Serialize datetime objects in rows
            for db_row in databases:
                for k, v in db_row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        db_row[k] = str(v)
        except Exception as e:
            databases = [{"error": str(e)}]

        # ── Replication state ─────────────────────────────────────────────────
        replication_state = "STANDALONE"
        try:
            rows = _rows(
                engine,
                "SELECT name FROM sys.databases WHERE is_distributor = 1"
            )
            if rows:
                replication_state = "DISTRIBUTOR"
            else:
                # Check if this server is a publisher or subscriber
                pub_rows = _rows(
                    engine,
                    "SELECT COUNT(*) AS cnt "
                    "FROM sys.databases WHERE is_published = 1 OR is_subscribed = 1"
                )
                if pub_rows and _to_int(pub_rows[0].get("cnt", 0)) > 0:
                    replication_state = "REPLICATION_PARTICIPANT"
        except Exception:
            pass

        # ── Wait stats top 10 ─────────────────────────────────────────────────
        wait_stats = []
        try:
            wait_stats = _rows(
                engine,
                """
                SELECT TOP 10
                    wait_type,
                    waiting_tasks_count,
                    wait_time_ms,
                    CAST(
                        100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER (), 0)
                        AS DECIMAL(5,1)
                    ) AS pct
                FROM sys.dm_os_wait_stats
                WHERE wait_type NOT IN (
                    'SLEEP_TASK','BROKER_TO_FLUSH','BROKER_EVENTHANDLER',
                    'CHECKPOINT_QUEUE','CLR_AUTO_EVENT',
                    'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT',
                    'HADR_FILESTREAM_IOMGR_IOCOMPLETION','HADR_WORK_QUEUE',
                    'LAZYWRITER_SLEEP','LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE',
                    'REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE',
                    'SERVER_IDLE_CHECK','SLEEP_DBSTARTUP','SLEEP_DBRECOVER',
                    'SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY',
                    'SLEEP_MASTERUPGRADED','SLEEP_MSDBSTARTUP',
                    'SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP','SNI_HTTP_ACCEPT',
                    'SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH',
                    'SQLTRACE_INCREMENTAL_FLUSH_SLEEP','WAITFOR',
                    'XE_DISPATCHER_WAIT','XE_TIMER_EVENT'
                )
                ORDER BY wait_time_ms DESC
                """
            )
            for row in wait_stats:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            wait_stats = [{"error": str(e)}]

        # ── Active queries (top 20 by elapsed time) ───────────────────────────
        active_queries = []
        try:
            active_queries = _rows(
                engine,
                """
                SELECT TOP 20
                    s.session_id,
                    s.login_name,
                    s.host_name,
                    DB_NAME(s.database_id) AS db_name,
                    s.status,
                    ISNULL(r.total_elapsed_time / 1000, 0) AS elapsed_sec,
                    LEFT(ISNULL(t.text, ''), 200) AS query
                FROM sys.dm_exec_sessions s
                LEFT JOIN sys.dm_exec_requests r
                    ON s.session_id = r.session_id
                OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE s.is_user_process = 1
                ORDER BY elapsed_sec DESC
                """
            )
        except Exception as e:
            active_queries = [{"error": str(e)}]

        # ── Top queries by CPU ────────────────────────────────────────────────
        top_cpu_queries = []
        try:
            top_cpu_queries = _rows(
                engine,
                """
                SELECT TOP 20
                    CAST(
                        total_worker_time / 1000.0 / NULLIF(execution_count, 0)
                        AS DECIMAL(10,2)
                    ) AS avg_cpu_ms,
                    execution_count,
                    total_worker_time / 1000 AS total_cpu_ms,
                    total_elapsed_time / 1000 / NULLIF(execution_count, 0)
                        AS avg_elapsed_ms,
                    LEFT(t.text, 200) AS query
                FROM sys.dm_exec_query_stats s
                CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
                ORDER BY avg_cpu_ms DESC
                """
            )
            for row in top_cpu_queries:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            top_cpu_queries = [{"error": str(e)}]

        # ── I/O stall stats ───────────────────────────────────────────────────
        io_stats = []
        try:
            io_stats = _rows(
                engine,
                """
                SELECT TOP 10
                    DB_NAME(vfs.database_id) AS db_name,
                    mf.physical_name,
                    vfs.io_stall_read_ms,
                    vfs.io_stall_write_ms,
                    vfs.io_stall,
                    vfs.num_of_reads,
                    vfs.num_of_writes,
                    CAST(
                        vfs.io_stall * 1.0 / NULLIF(vfs.num_of_reads + vfs.num_of_writes, 0)
                        AS DECIMAL(10,2)
                    ) AS avg_io_ms
                FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
                JOIN sys.master_files mf
                    ON vfs.database_id = mf.database_id
                    AND vfs.file_id = mf.file_id
                ORDER BY vfs.io_stall DESC
                """
            )
            for row in io_stats:
                for k, v in row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        row[k] = str(v)
                    elif hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            io_stats = [{"error": str(e)}]

        # ── Memory usage ──────────────────────────────────────────────────────
        memory_info = {}
        try:
            rows = _rows(
                engine,
                """
                SELECT
                    physical_memory_in_use_kb / 1024 AS sql_memory_used_mb,
                    page_fault_count,
                    memory_utilization_percentage
                FROM sys.dm_os_process_memory
                """
            )
            memory_info = rows[0] if rows else {}
        except Exception as e:
            memory_info = {"error": str(e)}

        # ── Version string (short) ────────────────────────────────────────────
        version_str = str(server_info.get("version", "N/A"))
        # Trim to first meaningful line
        if "\n" in version_str:
            version_str = version_str.split("\n")[0].strip()

        payload = {
            "status": "success",
            "connection": conn_meta,
            "health_summary": {
                "version": version_str,
                "uptime_str": uptime_str,
                "last_restart": last_restart_str,
                "host_name": str(server_info.get("server_name", conn_rec.host)),
                "total_databases": total_databases,
                "active_sessions": active_sessions,
                "max_connections": max_connections,
                "connection_pct": connection_pct,
                "buffer_cache_hit_pct": buffer_cache_hit_pct,
                "replication_state": replication_state,
            },
            "databases": databases,
            "wait_stats": wait_stats,
            "active_queries": active_queries,
            "top_cpu_queries": top_cpu_queries,
            "io_stats": io_stats,
            "memory": memory_info,
            "chart_data": {
                "connection_pct": connection_pct,
                "buffer_cache_hit_pct": buffer_cache_hit_pct,
                "db_sizes": [
                    {
                        "name": d.get("name", ""),
                        "size_mb": _to_float(d.get("size_mb", 0)),
                    }
                    for d in databases
                    if not d.get("error")
                ][:10],
                "top_wait_types": [
                    {
                        "wait_type": w.get("wait_type", ""),
                        "pct": _to_float(w.get("pct", 0)),
                    }
                    for w in wait_stats
                    if not w.get("error")
                ][:5],
            },
        }
        return payload

    except Exception as e:
        return {
            "status": "error",
            "error": f"MSSQL connection failed: {str(e)}",
            "connection": conn_meta,
        }


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINT 2 — Slow Queries
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/mssql-slow-queries")
def get_mssql_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns the top 50 slowest queries by average elapsed time from
    sys.dm_exec_query_stats, enriched with SQL text and execution metadata.
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")

    try:
        engine = _mssql_engine(conn_rec)

        queries = _rows(
            engine,
            """
            SELECT TOP 50
                CAST(
                    total_elapsed_time / 1000.0 / NULLIF(execution_count, 0)
                    AS DECIMAL(10,2)
                ) AS avg_elapsed_ms,
                execution_count,
                CAST(total_worker_time / 1000.0 AS DECIMAL(10,2)) AS total_cpu_ms,
                CAST(
                    total_logical_reads / NULLIF(execution_count, 0)
                    AS DECIMAL(10,0)
                ) AS avg_logical_reads,
                CAST(
                    total_physical_reads / NULLIF(execution_count, 0)
                    AS DECIMAL(10,0)
                ) AS avg_physical_reads,
                last_execution_time,
                LEFT(t.text, 500) AS sql_text,
                DB_NAME(t.dbid) AS db_name,
                qs.creation_time AS plan_created
            FROM sys.dm_exec_query_stats qs
            CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
            WHERE t.text NOT LIKE '%sys.dm_exec%'
            ORDER BY avg_elapsed_ms DESC
            """
        )

        # Normalize Decimal and datetime types for JSON serialisation
        normalised = []
        for row in queries:
            clean = {}
            for k, v in row.items():
                if isinstance(v, (datetime.datetime, datetime.date)):
                    clean[k] = str(v)
                elif hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                    clean[k] = float(v)
                else:
                    clean[k] = v
            normalised.append(clean)

        return {
            "status": "success",
            "source": "dm_exec_query_stats",
            "queries": normalised,
            "total": len(normalised),
            "error": None,
        }

    except Exception as e:
        return {
            "status": "error",
            "source": "dm_exec_query_stats",
            "queries": [],
            "total": 0,
            "error": str(e),
        }


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINT 3 — Error Logs
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/mssql-error-logs")
def get_mssql_error_logs(conn_id: int, db: Session = Depends(get_db)):
    """
    Reads the SQL Server error log via xp_readerrorlog.
    Falls back to sys.messages (severity >= 16) if the stored procedure
    is unavailable or access is denied.
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")

    try:
        engine = _mssql_engine(conn_rec)

        # ── Primary: xp_readerrorlog ──────────────────────────────────────────
        logs = []
        source = "xp_readerrorlog"
        xp_error = None

        try:
            with engine.connect() as c:
                result = c.execute(
                    text("EXEC xp_readerrorlog 0, 1, NULL, NULL, NULL, NULL, 'DESC'")
                )
                raw_rows = result.fetchmany(200)
                keys = list(result.keys()) if hasattr(result, 'keys') else []

            # xp_readerrorlog returns columns: LogDate, ProcessInfo, Text
            for raw in raw_rows:
                if len(raw) >= 3:
                    log_date_val = raw[0]
                    process_info = raw[1]
                    text_val = raw[2]
                elif keys:
                    row_dict = dict(zip(keys, raw))
                    log_date_val = row_dict.get("LogDate") or row_dict.get("logdate") or ""
                    process_info = row_dict.get("ProcessInfo") or row_dict.get("processinfo") or ""
                    text_val = row_dict.get("Text") or row_dict.get("text") or ""
                else:
                    continue

                logs.append({
                    "logged": str(log_date_val) if log_date_val else "",
                    "severity": _extract_severity(str(text_val)),
                    "message": str(text_val) if text_val else "",
                    "process_info": str(process_info) if process_info else "",
                })

        except Exception as e:
            xp_error = str(e)

        # ── Fallback: sys.messages (high-severity entries) ───────────────────
        fallback_error = None
        if not logs:
            source = "sys.messages"
            try:
                rows = _rows(
                    engine,
                    """
                    SELECT TOP 100
                        message_id,
                        severity,
                        text AS message,
                        OBJECT_NAME(object_id) AS object_name,
                        CAST(GETDATE() AS VARCHAR(30)) AS log_date
                    FROM sys.messages
                    WHERE language_id = 1033
                      AND severity >= 16
                    ORDER BY severity DESC
                    """
                )
                for row in rows:
                    logs.append({
                        "logged": str(row.get("log_date", "")),
                        "severity": _to_int(row.get("severity", 0)),
                        "message": str(row.get("message", "")),
                        "process_info": str(row.get("object_name") or "sys.messages"),
                    })
            except Exception as e:
                fallback_error = str(e)

        return {
            "status": "success" if logs else "partial",
            "source": source,
            "logs": logs,
            "total": len(logs),
            "xp_readerrorlog_error": xp_error,
            "fallback_error": fallback_error,
        }

    except Exception as e:
        return {
            "status": "error",
            "source": "none",
            "logs": [],
            "total": 0,
            "xp_readerrorlog_error": None,
            "fallback_error": str(e),
        }


def _extract_severity(text_val: str) -> int:
    """
    Attempt to parse a numeric severity from an MSSQL error log line.
    Returns 0 when not determinable.
    """
    import re
    match = re.search(r"severity\s+(\d+)", text_val, re.IGNORECASE)
    if match:
        return int(match.group(1))
    if "error" in text_val.lower():
        return 16
    if "warning" in text_val.lower():
        return 10
    return 0


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINT 4 — Index Analysis
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/mssql-index-analysis")
def get_mssql_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    """
    Returns three index analysis sections for the connected MSSQL database:
      - unused_indexes: indexes with zero reads since last server restart
      - missing_indexes: suggested indexes based on query optimizer hints
      - duplicate_indexes: indexes on the same table with identical key ordinal counts
    """
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql"
    ).first()

    if not conn_rec:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")

    errors = {}
    unused_indexes = []
    missing_indexes = []
    duplicate_indexes = []
    all_indexes_count = 0

    try:
        engine = _mssql_engine(conn_rec)

        # ── Total index count ─────────────────────────────────────────────────
        try:
            row = _rows(
                engine,
                """
                SELECT COUNT(*) AS cnt
                FROM sys.indexes i
                WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
                  AND i.index_id > 0
                """
            )
            all_indexes_count = _to_int(row[0].get("cnt", 0)) if row else 0
            errors["all_indexes"] = None
        except Exception as e:
            errors["all_indexes"] = str(e)

        # ── Unused indexes ────────────────────────────────────────────────────
        try:
            raw_unused = _rows(
                engine,
                """
                SELECT
                    OBJECT_NAME(i.object_id)            AS table_name,
                    i.name                              AS index_name,
                    i.type_desc,
                    i.is_unique,
                    ISNULL(ius.user_seeks, 0)
                      + ISNULL(ius.user_scans, 0)
                      + ISNULL(ius.user_lookups, 0)    AS total_reads,
                    ISNULL(ius.user_updates, 0)        AS total_writes,
                    ius.last_user_seek,
                    ius.last_user_scan
                FROM sys.indexes i
                LEFT JOIN sys.dm_db_index_usage_stats ius
                    ON  i.object_id  = ius.object_id
                    AND i.index_id   = ius.index_id
                    AND ius.database_id = DB_ID()
                WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1
                  AND i.index_id > 1
                  AND (
                    ius.user_seeks   IS NULL OR ius.user_seeks   = 0
                  )
                  AND (
                    ius.user_scans   IS NULL OR ius.user_scans   = 0
                  )
                  AND (
                    ius.user_lookups IS NULL OR ius.user_lookups = 0
                  )
                ORDER BY ISNULL(ius.user_updates, 0) DESC
                """
            )
            for row in raw_unused:
                for k, v in row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        row[k] = str(v)
                    elif v is None:
                        row[k] = None
            unused_indexes = raw_unused
            errors["unused_indexes"] = None
        except Exception as e:
            errors["unused_indexes"] = str(e)

        # ── Missing indexes ───────────────────────────────────────────────────
        try:
            raw_missing = _rows(
                engine,
                """
                SELECT
                    CAST(
                        mid.equality_columns
                        + ISNULL(', ' + mid.inequality_columns, '')
                        AS VARCHAR(300)
                    )                           AS suggested_columns,
                    mid.included_columns,
                    CAST(
                        migs.avg_total_user_cost
                        * migs.avg_user_impact
                        * (migs.user_seeks + migs.user_scans)
                        AS DECIMAL(18,2)
                    )                           AS improvement_measure,
                    OBJECT_NAME(mid.object_id)  AS table_name,
                    migs.user_seeks,
                    migs.user_scans
                FROM sys.dm_db_missing_index_details mid
                JOIN sys.dm_db_missing_index_groups mig
                    ON mid.index_handle = mig.index_handle
                JOIN sys.dm_db_missing_index_group_stats migs
                    ON mig.index_group_handle = migs.group_handle
                WHERE mid.database_id = DB_ID()
                ORDER BY improvement_measure DESC
                """
            )
            for row in raw_missing:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
                    elif v is None:
                        row[k] = None

                # Add a ready-to-use CREATE INDEX hint
                table = row.get("table_name", "unknown_table")
                cols = row.get("suggested_columns", "")
                inc_cols = row.get("included_columns")
                include_clause = f" INCLUDE ({inc_cols})" if inc_cols else ""
                safe_col_name = cols.replace(", ", "_").replace(" ", "_")[:40]
                row["create_index_hint"] = (
                    f"CREATE NONCLUSTERED INDEX [IX_{table}_{safe_col_name}] "
                    f"ON [dbo].[{table}] ({cols}){include_clause};"
                )

            missing_indexes = raw_missing
            errors["missing_indexes"] = None
        except Exception as e:
            errors["missing_indexes"] = str(e)

        # ── Duplicate indexes ─────────────────────────────────────────────────
        try:
            raw_dupes = _rows(
                engine,
                """
                SELECT
                    t.name          AS table_name,
                    i1.name         AS index1,
                    i2.name         AS index2,
                    i1.type_desc    AS index1_type,
                    i2.type_desc    AS index2_type,
                    (
                        SELECT COUNT(*)
                        FROM sys.index_columns ic
                        WHERE ic.object_id = i1.object_id
                          AND ic.index_id  = i1.index_id
                    )               AS key_column_count
                FROM sys.indexes i1
                JOIN sys.indexes i2
                    ON  i1.object_id = i2.object_id
                    AND i1.index_id  < i2.index_id
                JOIN sys.tables t
                    ON  i1.object_id = t.object_id
                WHERE i1.type > 0
                  AND i2.type > 0
                  AND (
                    SELECT COUNT(*)
                    FROM sys.index_columns ic1
                    WHERE ic1.object_id = i1.object_id
                      AND ic1.index_id  = i1.index_id
                  ) = (
                    SELECT COUNT(*)
                    FROM sys.index_columns ic2
                    WHERE ic2.object_id = i2.object_id
                      AND ic2.index_id  = i2.index_id
                  )
                ORDER BY t.name, i1.name
                """
            )
            # Add a drop hint for the second (duplicate) index
            for row in raw_dupes:
                table = row.get("table_name", "")
                idx2 = row.get("index2", "")
                row["drop_hint"] = (
                    f"-- Verify columns match before dropping:\n"
                    f"DROP INDEX [{idx2}] ON [dbo].[{table}];"
                )
            duplicate_indexes = raw_dupes
            errors["duplicate_indexes"] = None
        except Exception as e:
            errors["duplicate_indexes"] = str(e)

    except Exception as e:
        return {
            "status": "error",
            "error": f"Engine creation failed: {str(e)}",
            "unused_indexes": [],
            "missing_indexes": [],
            "duplicate_indexes": [],
            "all_indexes_count": 0,
            "summary": {},
            "errors": {},
        }

    # ── Summary ───────────────────────────────────────────────────────────────
    unused_with_writes = [
        u for u in unused_indexes if _to_int(u.get("total_writes", 0)) > 0
    ]
    summary = {
        "total_indexes": all_indexes_count,
        "unused_indexes_count": len(unused_indexes),
        "unused_with_writes_count": len(unused_with_writes),
        "missing_indexes_count": len(missing_indexes),
        "duplicate_indexes_count": len(duplicate_indexes),
        "health_score": max(
            0,
            100
            - len(unused_indexes) * 3
            - len(missing_indexes) * 4
            - len(duplicate_indexes) * 2,
        ),
        "note": (
            "unused_indexes count reflects indexes with zero reads since the "
            "last SQL Server restart. Validate before dropping."
        ),
    }

    return {
        "status": "success",
        "unused_indexes": unused_indexes,
        "missing_indexes": missing_indexes,
        "duplicate_indexes": duplicate_indexes,
        "all_indexes_count": all_indexes_count,
        "summary": summary,
        "errors": errors,
    }
