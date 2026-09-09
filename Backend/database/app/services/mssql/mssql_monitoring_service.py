import datetime
import re
from concurrent.futures import ThreadPoolExecutor
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster
from app.services.common.actmon_internal_tables import mssql_exclude_internal_tables_sql
from app.services.common.slow_query_normalize import attach_normalized, build_normalized_row

# SQL Server's own idle/background waits — these accrue constantly on a healthy,
# idle instance and would drown out every real wait if left in. Shared with
# mssql_wait_analysis_service.py so "% of total wait time" means the same thing
# in both places.
BENIGN_WAIT_TYPES_SQL = """
    'SLEEP_TASK','BROKER_TO_FLUSH','BROKER_EVENTHANDLER','CHECKPOINT_QUEUE','CLR_AUTO_EVENT',
    'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
    'HADR_WORK_QUEUE','LAZYWRITER_SLEEP','LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE',
    'REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE','SERVER_IDLE_CHECK','SLEEP_DBSTARTUP',
    'SLEEP_DBRECOVER','SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED',
    'SLEEP_MSDBSTARTUP','SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP','SNI_HTTP_ACCEPT',
    'SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
    'WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT'
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mssql_direct_engine(conn):
    pw = quote_plus(conn.password or "")
    db_name = conn.database_name or "master"
    return create_engine(
        f"mssql+pyodbc://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name}"
        "?driver=ODBC+Driver+17+for+SQL+Server&timeout=5",
        pool_pre_ping=True,
    )


def _mssql_engine(conn):
    """Engine for dashboard queries. Agent-linked connections (SQL Server living on an
    agent host's localhost) route through that host's agent — the backend can't reach
    them directly and has no ODBC driver anyway. Standalone connections stay direct."""
    from app.services.common import db_proxy_service
    return db_proxy_service.engine_for(conn, lambda: _mssql_direct_engine(conn))


def _rows(engine, sql):
    with engine.connect() as c:
        r = c.execute(text(sql))
        return [dict(row) for row in r.mappings().all()]


def _rows_params(engine, sql, params):
    """Like _rows, but for statements that take bound parameters — used where a
    caller-supplied value (e.g. a table/index name from a query string) must
    never be interpolated directly into SQL text."""
    with engine.connect() as c:
        r = c.execute(text(sql), params)
        return [dict(row) for row in r.mappings().all()]


def _scalar(engine, sql, default=None):
    try:
        with engine.connect() as c:
            row = c.execute(text(sql)).fetchone()
            return row[0] if row else default
    except Exception:
        return default


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


def _to_int(val, default=0):
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _to_float(val, default=0.0):
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def _extract_severity(text_val: str) -> int:
    match = re.search(r"severity\s+(\d+)", text_val, re.IGNORECASE)
    if match:
        return int(match.group(1))
    if "error" in text_val.lower():
        return 16
    if "warning" in text_val.lower():
        return 10
    return 0


def _get_conn_or_404(conn_id: int, db: Session) -> ConnectionMaster:
    conn_rec = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mssql",
    ).first()
    if not conn_rec:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    return conn_rec


def _self_cache(conn_id: int, snapshot_type: str, res: dict, db: Session) -> dict:
    """Write back a freshly-built live result as this connection's snapshot,
    same as get_monitoring_dashboard() already did — without it, a connection
    with no background agent collector polling it never gets a snapshot
    written at all, so every single page load falls all the way through to
    a live query instead of the instant cached read the dashboard is
    designed around."""
    try:
        from app.utils.agent_cache import store_snapshot_for_conn
        store_snapshot_for_conn(conn_id, snapshot_type, res, db)
    except Exception:
        pass
    return res


# ── Service functions ─────────────────────────────────────────────────────────

def get_monitoring_dashboard(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "mssql_monitoring_dashboard", db)
    if cached is not None:
        return cached

    conn_rec = _get_conn_or_404(conn_id, db)
    conn_meta = {
        "id": conn_rec.id,
        "name": conn_rec.connection_name,
        "host": conn_rec.host,
        "port": conn_rec.port,
        "database": conn_rec.database_name,
    }

    try:
        engine = _mssql_engine(conn_rec)

        # ── Section fetchers ────────────────────────────────────────────────
        # Every one of these ~18 reads is independent of all the others — none
        # needs another section's result, they only combine in Python once
        # every result is in hand. They used to run one after another, each
        # opening/closing its own pooled connection in turn; that serial
        # chain of round-trips (worse still over an agent-routed connection)
        # is exactly what made the Overview tab slow to load. Each section now
        # gets its own connection and runs concurrently via ThreadPoolExecutor;
        # every section keeps its original try/except so one bad section still
        # can't take any other section (or the whole response) down.

        def _fetch_server_info():
            try:
                rows = _rows(engine, """
                    SELECT @@SERVERNAME AS server_name,
                           CAST(SERVERPROPERTY('ProductVersion') AS VARCHAR(50)) AS product_version,
                           CAST(SERVERPROPERTY('ProductLevel')   AS VARCHAR(50)) AS product_level,
                           CAST(SERVERPROPERTY('Edition')        AS VARCHAR(120)) AS edition,
                           @@VERSION AS version
                """)
                return rows[0] if rows else {}
            except Exception as e:
                return {"error": str(e)}

        def _fetch_uptime():
            uptime_str = "N/A"
            last_restart_str = "N/A"
            try:
                start_row = _rows(engine, "SELECT sqlserver_start_time FROM sys.dm_os_sys_info")
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
            return uptime_str, last_restart_str

        def _fetch_active_sessions():
            try:
                # Exclude ActMon's own monitoring connection (@@SPID) so this count equals the
                # number of rows shown in the Active Sessions list.
                row = _rows(engine, "SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND session_id <> @@SPID")
                return _to_int(row[0].get("cnt", 0)) if row else 0
            except Exception:
                return 0

        def _fetch_max_connections_cfg():
            try:
                row = _rows(engine, "SELECT CAST(value_in_use AS INT) AS max_conn FROM sys.configurations WHERE name = 'max connections'")
                return _to_int(row[0].get("max_conn", 0)) if row else 0
            except Exception:
                return 0

        def _fetch_buffer_cache_hit_pct():
            try:
                # SQL Server's 'Buffer cache hit ratio' is a RATIO counter — it must be divided
                # by its '... base' counter and ×100, otherwise you get garbage like 1276%.
                rows = _rows(engine, """
                    SELECT CAST(ROUND(100.0 * a.cntr_value / NULLIF(b.cntr_value, 0), 2) AS FLOAT) AS pct
                    FROM sys.dm_os_performance_counters a
                    JOIN sys.dm_os_performance_counters b ON a.object_name = b.object_name
                    WHERE a.counter_name = 'Buffer cache hit ratio'
                      AND b.counter_name = 'Buffer cache hit ratio base'
                """)
                if rows:
                    return min(_to_float(rows[0].get("pct", 0)), 100.0)
            except Exception:
                pass
            return 0.0

        def _fetch_databases():
            try:
                # size_mb is DATA files only, with the log reported separately — summing
                # both into one number made "Size" and "Log Size" overlap, so the UI's
                # size column double-counted the log.
                # owner / collation / compatibility_level / create_date are selected
                # because the dashboard has always had columns for them; without them
                # those columns could only ever render "—".
                rows = _rows(engine, """
                    SELECT d.name, d.state_desc, d.recovery_model_desc,
                        d.compatibility_level,
                        d.collation_name,
                        SUSER_SNAME(d.owner_sid) AS owner,
                        CAST(d.create_date AS VARCHAR(30)) AS create_date,
                        CAST(d.is_read_only AS INT) AS is_read_only,
                        CAST(SUM(CASE WHEN f.type = 0 THEN CAST(f.size AS BIGINT) ELSE 0 END) * 8.0 / 1024 AS DECIMAL(12,2)) AS size_mb,
                        CAST(SUM(CASE WHEN f.type = 1 THEN CAST(f.size AS BIGINT) ELSE 0 END) * 8.0 / 1024 AS DECIMAL(12,2)) AS log_size_mb
                    FROM sys.databases d
                    LEFT JOIN sys.master_files f ON d.database_id = f.database_id
                    GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.database_id,
                             d.compatibility_level, d.collation_name, d.owner_sid,
                             d.create_date, d.is_read_only
                    ORDER BY size_mb DESC
                """)
                for db_row in rows:
                    for k, v in db_row.items():
                        if isinstance(v, (datetime.datetime, datetime.date)):
                            db_row[k] = str(v)
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_replication():
            replication_state = "STANDALONE"
            try:
                rows = _rows(engine, "SELECT name FROM sys.databases WHERE is_distributor = 1")
                if rows:
                    replication_state = "DISTRIBUTOR"
                else:
                    pub_rows = _rows(engine, "SELECT COUNT(*) AS cnt FROM sys.databases WHERE is_published = 1 OR is_subscribed = 1")
                    if pub_rows and _to_int(pub_rows[0].get("cnt", 0)) > 0:
                        replication_state = "REPLICATION_PARTICIPANT"
            except Exception:
                pass
            try:
                rows = _rows(engine, """
                    SELECT name AS database_name,
                        CAST(is_published AS INT) AS is_published,
                        CAST(is_subscribed AS INT) AS is_subscribed,
                        CAST(is_distributor AS INT) AS is_distributor
                    FROM sys.databases
                    WHERE is_published=1 OR is_subscribed=1 OR is_distributor=1
                """)
                replication = {"enabled": bool(rows), "databases": rows, "state": replication_state}
            except Exception:
                replication = {"enabled": False, "databases": [], "state": replication_state}
            return replication_state, replication

        def _fetch_wait_stats():
            try:
                rows = _rows(engine, f"""
                    SELECT TOP 10 wait_type, waiting_tasks_count, wait_time_ms,
                        CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER (), 0) AS DECIMAL(5,1)) AS pct
                    FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                    ORDER BY wait_time_ms DESC
                """)
                for row in rows:
                    for k, v in row.items():
                        if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                            row[k] = float(v)
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_active_queries():
            try:
                # One row per user session — this is the exact set behind the "Active Sessions" count.
                # @@SPID (ActMon's own monitoring connection) is excluded so the list matches what the
                # user actually cares about. Aliases match the frontend (database_name / duration_ms / wait_type).
                return _rows(engine, """
                    SELECT TOP 100 s.session_id, s.login_name, s.host_name,
                        DB_NAME(s.database_id) AS database_name,
                        DB_NAME(s.database_id) AS db_name,
                        s.status,
                        ISNULL(r.total_elapsed_time, 0) AS duration_ms,
                        ISNULL(r.total_elapsed_time / 1000, 0) AS elapsed_sec,
                        r.wait_type,
                        LEFT(ISNULL(t.text, ''), 200) AS query,
                        LEFT(ISNULL(t.text, ''), 200) AS sql_text
                    FROM sys.dm_exec_sessions s
                    LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
                    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                    WHERE s.is_user_process = 1
                      AND s.session_id <> @@SPID
                    ORDER BY duration_ms DESC
                """)
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_top_cpu_queries():
            try:
                rows = _rows(engine, f"""
                    SELECT TOP 20
                        CAST(total_worker_time / 1000.0 / NULLIF(execution_count, 0) AS DECIMAL(10,2)) AS avg_cpu_ms,
                        execution_count,
                        total_worker_time / 1000 AS total_cpu_ms,
                        total_elapsed_time / 1000 / NULLIF(execution_count, 0) AS avg_elapsed_ms,
                        LEFT(t.text, 200) AS query
                    FROM sys.dm_exec_query_stats s
                    CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
                    WHERE {mssql_exclude_internal_tables_sql('t.text')}
                    ORDER BY avg_cpu_ms DESC
                """)
                for row in rows:
                    for k, v in row.items():
                        if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                            row[k] = float(v)
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_io_stats():
            try:
                rows = _rows(engine, """
                    SELECT TOP 10 DB_NAME(vfs.database_id) AS db_name, mf.physical_name,
                        vfs.io_stall_read_ms, vfs.io_stall_write_ms, vfs.io_stall,
                        vfs.num_of_reads, vfs.num_of_writes,
                        CAST(vfs.io_stall * 1.0 / NULLIF(vfs.num_of_reads + vfs.num_of_writes, 0) AS DECIMAL(10,2)) AS avg_io_ms
                    FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
                    JOIN sys.master_files mf ON vfs.database_id = mf.database_id AND vfs.file_id = mf.file_id
                    ORDER BY vfs.io_stall DESC
                """)
                for row in rows:
                    for k, v in row.items():
                        if isinstance(v, (datetime.datetime, datetime.date)):
                            row[k] = str(v)
                        elif hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                            row[k] = float(v)
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_memory():
            try:
                rows = _rows(engine, """
                    SELECT physical_memory_in_use_kb / 1024 AS sql_memory_used_mb,
                        page_fault_count, memory_utilization_percentage
                    FROM sys.dm_os_process_memory
                """)
                memory_info = rows[0] if rows else {}
            except Exception as e:
                memory_info = {"error": str(e)}

            # Rich, clearly-scoped memory picture: SQL Server allocation + host RAM ("out of what").
            mem = {
                "used_mb": round(_to_float(memory_info.get("sql_memory_used_mb", 0)), 1),   # SQL Server process in use
                "utilization_pct": _to_float(memory_info.get("memory_utilization_percentage", 0)),
                "page_fault_count": _to_int(memory_info.get("page_fault_count", 0)),
            }
            try:  # Total / Target Server Memory (what SQL Server has grabbed vs wants)
                for x in _rows(engine, "SELECT RTRIM(counter_name) AS cn, cntr_value FROM sys.dm_os_performance_counters "
                                       "WHERE counter_name IN ('Total Server Memory (KB)','Target Server Memory (KB)')"):
                    v = round(_to_float(x.get("cntr_value", 0)) / 1024.0, 1)
                    if str(x.get("cn", "")).startswith("Total"):
                        mem["total_mb"] = v          # SQL Server currently using
                    elif str(x.get("cn", "")).startswith("Target"):
                        mem["target_mb"] = v         # SQL Server wants/ceiling
            except Exception:
                pass
            try:  # Page Life Expectancy (seconds pages stay in buffer pool)
                r = _rows(engine, "SELECT cntr_value FROM sys.dm_os_performance_counters "
                                  "WHERE RTRIM(counter_name)='Page life expectancy' AND object_name LIKE '%Buffer Manager%'")
                if r:
                    mem["page_life_expectancy"] = _to_int(r[0].get("cntr_value", 0))
            except Exception:
                pass
            try:  # Physical host RAM — gives the real "out of" denominator
                r = _rows(engine, "SELECT total_physical_memory_kb, available_physical_memory_kb, "
                                  "system_memory_state_desc FROM sys.dm_os_sys_memory")
                if r:
                    ht = round(_to_float(r[0].get("total_physical_memory_kb", 0)) / 1024.0, 1)
                    ha = round(_to_float(r[0].get("available_physical_memory_kb", 0)) / 1024.0, 1)
                    mem["host_total_mb"] = ht
                    mem["host_available_mb"] = ha
                    mem["host_used_mb"] = round(ht - ha, 1)
                    mem["host_used_pct"] = round((ht - ha) / ht * 100, 1) if ht > 0 else 0
                    mem["system_memory_state"] = r[0].get("system_memory_state_desc")
            except Exception:
                pass
            return mem

        def _fetch_locks():
            locks = []
            try:
                locks = _rows(engine, """
                    SELECT TOP 20 r.session_id, DB_NAME(r.database_id) AS db_name,
                        r.wait_type, r.wait_time, r.blocking_session_id,
                        LEFT(ISNULL(t.text,''), 200) AS query
                    FROM sys.dm_exec_requests r
                    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                    WHERE r.wait_type IS NOT NULL AND r.blocking_session_id >= 0
                """)
            except Exception:
                pass
            blocking = [r for r in locks if _to_int(r.get("blocking_session_id", 0)) > 0]
            return locks, blocking

        def _fetch_cpu():
            cpu_info = {"sql_cpu_pct": 0, "sql_only_pct": 0}
            try:
                # Correct node names: SystemIdle = idle %, ProcessUtilization = SQL Server's CPU %.
                rows = _rows(engine, """
                    SELECT TOP 1
                        100 - system_idle AS sql_cpu_pct,
                        sql_cpu AS sql_only_pct
                    FROM (
                        SELECT
                            record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int') AS system_idle,
                            record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int') AS sql_cpu
                        FROM (
                            SELECT TOP 1 CONVERT(XML, record) AS record
                            FROM sys.dm_os_ring_buffers
                            WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR'
                            AND record LIKE '%<SystemHealth>%'
                            ORDER BY timestamp DESC
                        ) ring
                    ) cpu_data
                """)
                if rows:
                    cpu_info = {
                        "sql_cpu_pct": max(min(_to_int(rows[0].get("sql_cpu_pct", 0)), 100), 0),
                        "sql_only_pct": max(min(_to_int(rows[0].get("sql_only_pct", 0)), 100), 0),
                    }
            except Exception:
                pass

            # Clearly-scoped CPU: host total (out of 100% across all cores) + SQL Server's own slice,
            # plus throughput counters the overview panel shows.
            cpu = {
                "host_cpu_pct": cpu_info.get("sql_cpu_pct", 0),      # whole machine, 0–100%
                "sql_server_cpu_pct": cpu_info.get("sql_only_pct", 0),  # SQL Server's portion, 0–100%
                "other_cpu_pct": max(cpu_info.get("sql_cpu_pct", 0) - cpu_info.get("sql_only_pct", 0), 0),
            }
            try:
                m = {str(x.get("cn", "")).strip(): _to_int(x.get("cntr_value", 0))
                     for x in _rows(engine, "SELECT RTRIM(counter_name) AS cn, cntr_value FROM sys.dm_os_performance_counters "
                                            "WHERE counter_name IN ('SQL Compilations/sec','SQL Re-Compilations/sec','Batch Requests/sec','Full Scans/sec')")}
                cpu.update({
                    "sql_compilations": m.get("SQL Compilations/sec", 0),
                    "sql_recompilations": m.get("SQL Re-Compilations/sec", 0),
                    "batch_requests_sec": m.get("Batch Requests/sec", 0),
                    "full_scans_sec": m.get("Full Scans/sec", 0),
                })
            except Exception:
                pass
            # Signal wait vs. resource wait ratio — the classic "is this actually
            # CPU pressure" signal DBAs use: a high share of wait time spent
            # SIGNALED (runnable, waiting for a scheduler) rather than actually
            # blocked on a resource means requests are queuing for CPU, not I/O
            # or locks. >20-25% signal ratio is the commonly-cited pressure
            # threshold. Same BENIGN_WAIT_TYPES_SQL exclusion as the wait-stats
            # card, so this agrees with what that card already shows.
            try:
                r = _rows(engine, f"""
                    SELECT SUM(signal_wait_time_ms) AS signal_ms, SUM(wait_time_ms) AS total_ms
                    FROM sys.dm_os_wait_stats WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                """)
                if r:
                    total_ms = _to_float(r[0].get("total_ms"))
                    cpu["signal_wait_pct"] = round((_to_float(r[0].get("signal_ms")) / total_ms) * 100, 1) if total_ms else 0.0
            except Exception:
                cpu["signal_wait_pct"] = None
            # Runnable queue length — tasks ready to run but waiting for a free
            # scheduler. Non-zero and sustained means the box doesn't have
            # enough CPU for its current load, independent of the ratio above.
            try:
                r = _rows(engine, "SELECT SUM(runnable_tasks_count) AS runnable FROM sys.dm_os_schedulers WHERE status = 'VISIBLE ONLINE'")
                cpu["runnable_tasks"] = _to_int(r[0].get("runnable")) if r else 0
            except Exception:
                cpu["runnable_tasks"] = None
            return cpu

        def _fetch_users():
            try:
                return _rows(engine, """
                    SELECT TOP 50 name, type_desc, is_disabled,
                        CAST(create_date AS VARCHAR(30)) AS create_date,
                        CAST(modify_date AS VARCHAR(30)) AS modify_date
                    FROM sys.server_principals
                    WHERE type IN ('S','U','G') ORDER BY name
                """)
            except Exception:
                return []

        def _fetch_tables():
            # Tables across ALL user databases (the connected DB is usually master → empty).
            tables = []
            try:
                user_dbs = [r["name"] for r in _rows(engine,
                            "SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0")]
                mi_counts = {}
                try:
                    for r in _rows(engine, "SELECT database_id, object_id, COUNT(*) AS cnt "
                                           "FROM sys.dm_db_missing_index_details GROUP BY database_id, object_id"):
                        mi_counts[(_to_int(r.get("database_id")), _to_int(r.get("object_id")))] = _to_int(r.get("cnt"))
                except Exception:
                    pass

                def _fetch_one_db(d):
                    D = d.replace("]", "]]")
                    try:
                        db_id = _to_int(_rows(engine, f"SELECT DB_ID('{d}') AS i")[0].get("i"))
                        rows = _rows(engine, f"""
                            SELECT '{d}' AS db_name, s.name AS schema_name, t.name AS table_name, t.object_id,
                                p.rows AS row_count,
                                CAST(SUM(CASE WHEN i.index_id IN (0,1) THEN a.data_pages ELSE 0 END)*8/1024.0 AS DECIMAL(12,2)) AS data_mb,
                                CAST(SUM(CASE WHEN i.index_id NOT IN (0,1) THEN a.used_pages ELSE 0 END)*8/1024.0 AS DECIMAL(12,2)) AS index_mb,
                                CAST(SUM(a.total_pages)*8/1024.0 AS DECIMAL(12,2)) AS total_mb,
                                CONVERT(VARCHAR(19), t.modify_date, 120) AS last_updated
                            FROM [{D}].sys.tables t
                            JOIN [{D}].sys.schemas s ON t.schema_id = s.schema_id
                            JOIN [{D}].sys.indexes i ON t.object_id = i.object_id
                            JOIN [{D}].sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
                            JOIN [{D}].sys.allocation_units a ON p.partition_id = a.container_id
                            WHERE i.index_id <= 1
                            GROUP BY s.name, t.name, t.object_id, p.rows, t.modify_date""")
                        out_rows = []
                        for r in rows:
                            for k, v in list(r.items()):
                                if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                                    r[k] = float(v)
                            r["missing_index_count"] = mi_counts.get((db_id, _to_int(r.get("object_id"))), 0)
                            out_rows.append(r)   # keeps db_name + raw schema_name for drill-down
                        return out_rows
                    except Exception:
                        return []

                # Each user database is its own independent pair of round-trips
                # (DB_ID lookup + table sizes) — with many user databases this
                # loop used to be the single biggest contributor to a slow
                # Overview load, run one database at a time.
                if user_dbs:
                    with ThreadPoolExecutor(max_workers=min(8, len(user_dbs))) as db_pool:
                        for db_rows in db_pool.map(_fetch_one_db, user_dbs):
                            tables.extend(db_rows)

                tables.sort(key=lambda x: _to_float(x.get("total_mb"), 0), reverse=True)
                tables = tables[:100]
            except Exception as e:
                tables = [{"error": str(e)}]
            return tables

        def _fetch_backup_history():
            try:
                rows = _rows(engine, """
                    SELECT TOP 20 database_name,
                        CAST(backup_start_date AS VARCHAR(30)) AS backup_start_date,
                        CAST(backup_finish_date AS VARCHAR(30)) AS backup_finish_date,
                        CAST(backup_size/1024/1024 AS DECIMAL(10,2)) AS size_mb,
                        type AS backup_type, CAST(is_copy_only AS INT) AS is_copy_only
                    FROM msdb.dbo.backupset
                    WHERE backup_finish_date >= DATEADD(day,-7,GETDATE())
                    ORDER BY backup_finish_date DESC
                """)
                for r in rows:
                    for k, v in r.items():
                        if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                            r[k] = float(v)
                return rows
            except Exception:
                return []

        def _fetch_job_history():
            try:
                return _rows(engine, """
                    SELECT TOP 20 j.name AS job_name, h.run_status,
                        CAST(h.run_date AS VARCHAR(8)) AS run_date,
                        CAST(h.run_time AS VARCHAR(6)) AS run_time,
                        h.run_duration, LEFT(h.message,200) AS message
                    FROM msdb.dbo.sysjobhistory h
                    JOIN msdb.dbo.sysjobs j ON h.job_id=j.job_id
                    WHERE h.step_id=0
                    ORDER BY h.run_date DESC, h.run_time DESC
                """)
            except Exception:
                return []

        def _fetch_always_on():
            try:
                rows = _rows(engine, """
                    SELECT ag.name AS ag_name, ars.role_desc, ags.synchronization_health_desc
                    FROM sys.availability_groups ag
                    JOIN sys.dm_hadr_availability_replica_states ars ON ag.group_id=ars.group_id
                    LEFT JOIN sys.dm_hadr_availability_group_states ags ON ag.group_id=ags.group_id
                    WHERE ars.is_local=1
                """)
            except Exception:
                return {"enabled": False, "groups": [], "database_lag": []}
            # Role/sync-health above is instance-wide (one row per AG this
            # replica belongs to) — it says "healthy" without saying HOW FAR
            # BEHIND, which is the number that actually matters operationally.
            # That lives per-DATABASE in a separate DMV: log_send_queue_size
            # (not yet shipped to the secondary) and redo_queue_size (shipped
            # but not yet replayed there), both in KB.
            db_lag = []
            try:
                db_lag = _rows(engine, """
                    SELECT DB_NAME(drs.database_id) AS database_name, ar.replica_server_name,
                        drs.is_local, drs.synchronization_state_desc,
                        drs.log_send_queue_size, drs.redo_queue_size
                    FROM sys.dm_hadr_database_replica_states drs
                    JOIN sys.availability_replicas ar ON drs.replica_id = ar.replica_id
                """)
            except Exception:
                pass
            return {"enabled": bool(rows), "groups": rows, "database_lag": db_lag}

        def _fetch_backup_status():
            # The 7-day backup_history list above only shows what happened
            # recently — a database with NO full backup at all in that window
            # (overdue OR never backed up) simply doesn't appear in it, so
            # "no rows" reads as "no problem" instead of "look at this urgently".
            # This asks the opposite question: for every ONLINE user database,
            # when was its last full backup, full stop, no window — LEFT JOIN
            # so a database that has literally never been backed up still
            # produces a row with last_full_backup = NULL rather than vanishing.
            try:
                # b.type = 'D' filters INSIDE the join condition, not after — on a
                # long-lived server, log backups (type 'L') vastly outnumber full
                # backups, so filtering post-join meant joining every backup row
                # ever taken just to discard most of them per group. Same result
                # (still LEFT JOIN, still NULL for "never backed up"), far less
                # data touched.
                rows = _rows(engine, """
                    SELECT d.name AS database_name,
                        MAX(b.backup_finish_date) AS last_full_backup
                    FROM sys.databases d
                    LEFT JOIN msdb.dbo.backupset b ON b.database_name = d.name AND b.type = 'D'
                    WHERE d.database_id > 4 AND d.state = 0
                    GROUP BY d.name
                """)
                for r in rows:
                    v = r.get("last_full_backup")
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        r["last_full_backup"] = str(v)
                        r["hours_since_backup"] = round((datetime.datetime.now() - v).total_seconds() / 3600, 1)
                    else:
                        r["hours_since_backup"] = None
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        def _fetch_vlf_info():
            # A database with thousands of VLFs (usually from many small
            # autogrowth steps rather than one sensible size) has real,
            # measurable overhead on startup/recovery/backup/replication —
            # and nothing else in this dashboard surfaces it. sys.dm_db_log_info
            # is a genuine cross-database DMV (pass NULL for "every database"),
            # no need to loop/switch context per database like DBCC LOGINFO would.
            try:
                rows = _rows(engine, """
                    SELECT DB_NAME(database_id) AS database_name, COUNT(*) AS vlf_count
                    FROM sys.dm_db_log_info(NULL)
                    GROUP BY database_id
                    ORDER BY vlf_count DESC
                """)
                return rows
            except Exception as e:
                # sys.dm_db_log_info needs SQL Server 2016 SP2+/2017 CU3+ — an
                # older instance just won't have this VLF signal, not an error
                # worth surfacing as one.
                return []

        def _fetch_plan_cache():
            # The classic "turn on optimize for ad hoc workloads" signal: a
            # plan cache dominated by single-use ad-hoc plans (executed once,
            # never reused) wastes memory that could hold plans actually worth
            # caching, and the compiles themselves cost CPU for no reuse benefit.
            try:
                rows = _rows(engine, """
                    SELECT COUNT(*) AS total_plans,
                        SUM(CASE WHEN objtype = 'Adhoc' AND usecounts = 1 THEN 1 ELSE 0 END) AS adhoc_single_use,
                        CAST(SUM(size_in_bytes) / 1024.0 / 1024.0 AS DECIMAL(10,1)) AS total_cache_mb
                    FROM sys.dm_exec_cached_plans
                """)
                if rows:
                    r = rows[0]
                    total = _to_int(r.get("total_plans"))
                    single_use = _to_int(r.get("adhoc_single_use"))
                    return {
                        "total_plans": total,
                        "adhoc_single_use": single_use,
                        "adhoc_single_use_pct": round((single_use / total) * 100, 1) if total else 0.0,
                        "total_cache_mb": _to_float(r.get("total_cache_mb")),
                    }
            except Exception:
                pass
            return {}

        def _fetch_memory_grants():
            # Queries can be granted workspace memory (for sorts/hashes) that
            # simply isn't available right now, and sit waiting for it — a
            # real, common "the whole box is slow" cause that shows up nowhere
            # else here (it's distinct from CPU pressure and from disk I/O).
            # grant_time IS NULL is exactly "still waiting", not "already granted".
            try:
                rows = _rows(engine, """
                    SELECT COUNT(*) AS waiting_count,
                        CAST(ISNULL(SUM(requested_memory_kb), 0) / 1024.0 AS DECIMAL(10,1)) AS requested_mb
                    FROM sys.dm_exec_query_memory_grants
                    WHERE grant_time IS NULL
                """)
                if rows:
                    return {
                        "waiting_count": _to_int(rows[0].get("waiting_count")),
                        "requested_mb": _to_float(rows[0].get("requested_mb")),
                    }
            except Exception:
                pass
            return {"waiting_count": 0, "requested_mb": 0.0}

        def _fetch_long_transactions():
            # A transaction can sit open with NO active request (nothing
            # currently running on it) and still hold locks and pin the
            # transaction log from truncating — invisible to the Locks tab,
            # which only shows requests that are actively blocked/blocking
            # right now. This is duration-based, not blocking-based.
            try:
                rows = _rows(engine, """
                    SELECT s.session_id, DB_NAME(s.database_id) AS database_name,
                        s.login_name, s.host_name, s.program_name,
                        DATEDIFF(SECOND, at.transaction_begin_time, GETDATE()) AS open_seconds,
                        CONVERT(VARCHAR(19), at.transaction_begin_time, 120) AS begin_time
                    FROM sys.dm_tran_active_transactions at
                    JOIN sys.dm_tran_session_transactions st ON at.transaction_id = st.transaction_id
                    JOIN sys.dm_exec_sessions s ON st.session_id = s.session_id
                    WHERE DATEDIFF(SECOND, at.transaction_begin_time, GETDATE()) > 60
                      AND s.session_id <> @@SPID
                    ORDER BY open_seconds DESC
                """)
                return rows
            except Exception as e:
                return [{"error": str(e)}]

        # ── Run every section concurrently ──────────────────────────────────
        with ThreadPoolExecutor(max_workers=23) as pool:
            f_server_info = pool.submit(_fetch_server_info)
            f_uptime = pool.submit(_fetch_uptime)
            f_active_sessions = pool.submit(_fetch_active_sessions)
            f_max_conn = pool.submit(_fetch_max_connections_cfg)
            f_buffer_cache = pool.submit(_fetch_buffer_cache_hit_pct)
            f_databases = pool.submit(_fetch_databases)
            f_replication = pool.submit(_fetch_replication)
            f_wait_stats = pool.submit(_fetch_wait_stats)
            f_active_queries = pool.submit(_fetch_active_queries)
            f_top_cpu_queries = pool.submit(_fetch_top_cpu_queries)
            f_io_stats = pool.submit(_fetch_io_stats)
            f_memory = pool.submit(_fetch_memory)
            f_locks = pool.submit(_fetch_locks)
            f_cpu = pool.submit(_fetch_cpu)
            f_users = pool.submit(_fetch_users)
            f_tables = pool.submit(_fetch_tables)
            f_backup_history = pool.submit(_fetch_backup_history)
            f_job_history = pool.submit(_fetch_job_history)
            f_always_on = pool.submit(_fetch_always_on)
            f_backup_status = pool.submit(_fetch_backup_status)
            f_vlf_info = pool.submit(_fetch_vlf_info)
            f_plan_cache = pool.submit(_fetch_plan_cache)
            f_memory_grants = pool.submit(_fetch_memory_grants)
            f_long_transactions = pool.submit(_fetch_long_transactions)

            server_info = f_server_info.result()
            uptime_str, last_restart_str = f_uptime.result()
            active_sessions = f_active_sessions.result()
            max_connections_cfg = f_max_conn.result()
            buffer_cache_hit_pct = f_buffer_cache.result()
            databases = f_databases.result()
            replication_state, replication = f_replication.result()
            wait_stats = f_wait_stats.result()
            active_queries = f_active_queries.result()
            top_cpu_queries = f_top_cpu_queries.result()
            io_stats = f_io_stats.result()
            mem = f_memory.result()
            locks, blocking = f_locks.result()
            cpu = f_cpu.result()
            users = f_users.result()
            tables = f_tables.result()
            backup_history = f_backup_history.result()
            job_history = f_job_history.result()
            always_on = f_always_on.result()
            backup_status = f_backup_status.result()
            vlf_info = f_vlf_info.result()
            plan_cache = f_plan_cache.result()
            memory_grants = f_memory_grants.result()
            long_transactions = f_long_transactions.result()

        # Derived, not a new query: job_history already carries run_status (0 = failed)
        # for its most recent runs — this was fetched into the payload already but
        # never actually flagged/surfaced anywhere in the UI.
        failed_jobs = [j for j in job_history if not j.get("error") and _to_int(j.get("run_status"), -1) == 0]

        # Backup RPO: flag any database with no full backup in the last 24h
        # (or none, ever — last_full_backup stays None for those).
        BACKUP_STALE_HOURS = 24
        at_risk_backups = [
            b for b in backup_status
            if not b.get("error") and (b.get("hours_since_backup") is None or b["hours_since_backup"] > BACKUP_STALE_HOURS)
        ]

        # VLF count: a few hundred is normal; a database climbing into the
        # thousands (usually from many small autogrowth steps) has a real cost.
        VLF_WARNING_COUNT = 1000
        high_vlf_dbs = [v for v in vlf_info if _to_int(v.get("vlf_count")) > VLF_WARNING_COUNT]

        # SQL Server's "max connections" = 0 means UNLIMITED — the effective ceiling is 32767.
        # Report the effective number so the UI never shows "?".
        max_connections_unlimited = (max_connections_cfg == 0)
        effective_max = max_connections_cfg if max_connections_cfg > 0 else 32767
        max_connections = effective_max
        connection_pct = round((active_sessions / effective_max) * 100, 2)
        total_databases = len(databases)

        product_version = str(server_info.get("product_version") or "").strip()
        edition = str(server_info.get("edition") or "").strip()
        full_version = str(server_info.get("version", "") or "")
        version_str = product_version or (full_version.split("\n")[0].strip() if full_version else "N/A")

        # Disk footprint = data + log. size_mb alone is data files only (see the
        # databases query), so summing just that would understate the total.
        total_size_mb = round(sum(
            _to_float(d.get("size_mb", 0)) + _to_float(d.get("log_size_mb", 0))
            for d in databases if not d.get("error")
        ), 1)

        _res = {
            "status": "success",
            "connection": conn_meta,
            "health_summary": {
                "version": version_str,
                "edition": edition,
                "product_version": product_version,
                "uptime": uptime_str,
                "uptime_str": uptime_str,
                "last_restart": last_restart_str,
                "host_name": str(server_info.get("server_name", conn_rec.host)),
                "total_databases": total_databases,
                "total_size_mb": total_size_mb,
                "total_size_gb": round(total_size_mb / 1024, 2),
                "active_sessions": active_sessions,
                "max_connections": max_connections,
                "max_connections_unlimited": max_connections_unlimited,
                "connection_pct": connection_pct,
                "connection_usage_pct": connection_pct,
                "buffer_cache_hit_pct": buffer_cache_hit_pct,
                "disk_io_pct": 0.0,
                # host RAM used % (true "out of host memory"); falls back to process utilization
                "memory_usage_pct": mem.get("host_used_pct", mem.get("utilization_pct", 0)),
                "page_life_expectancy": mem.get("page_life_expectancy"),
                "replication_state": replication_state,
                "host_cpu_pct": cpu.get("host_cpu_pct", 0),
                "sql_cpu_pct": cpu.get("sql_server_cpu_pct", 0),
            },
            "databases": databases,
            "wait_stats": wait_stats,
            "active_queries": active_queries,
            "top_cpu_queries": top_cpu_queries,
            "top_queries": top_cpu_queries,
            "io_stats": io_stats,
            "disk_io": io_stats,
            "memory": mem,
            "server_info": {
                "server_name": str(server_info.get("server_name", conn_rec.host)),
                "version": version_str,
                "product_version": product_version,
                "edition": edition,
            },
            "sessions": {"active": active_sessions, "max": max_connections, "pct": connection_pct},
            "cpu": cpu,
            "locks": locks,
            "blocking": blocking,
            "replication": replication,
            "always_on": always_on,
            "users": users,
            "logins": users,
            "tables": tables,
            "backup_history": backup_history,
            "job_history": job_history,
            "job_alerts": {"failed_count": len(failed_jobs), "failed_jobs": failed_jobs[:10]},
            "backup_status": {
                "at_risk_count": len(at_risk_backups), "at_risk": at_risk_backups,
                "threshold_hours": BACKUP_STALE_HOURS,
            },
            "vlf_info": {"warning_count": len(high_vlf_dbs), "high_vlf": high_vlf_dbs, "all": vlf_info,
                         "warning_threshold": VLF_WARNING_COUNT},
            "plan_cache": plan_cache,
            "memory_grants": memory_grants,
            "long_transactions": long_transactions,
            "missing_indexes": [],
            "chart_data": {
                "connection_pct": connection_pct,
                "buffer_cache_hit_pct": buffer_cache_hit_pct,
                "db_sizes": [
                    {"name": d.get("name", ""), "size_mb": _to_float(d.get("size_mb", 0))}
                    for d in databases if not d.get("error")
                ][:10],
                "top_wait_types": [
                    {"wait_type": w.get("wait_type", ""), "pct": _to_float(w.get("pct", 0))}
                    for w in wait_stats if not w.get("error")
                ][:5],
            },
        }
        # Cache ONLY a run that actually reached SQL Server. Every inner query swallows
        # its own exception, so an all-failed run still builds a structurally-valid but
        # EMPTY dict — storing that would poison the cache (served for hours) and keep
        # the dashboard blank long after the agent recovers.
        _got_data = bool(product_version) or bool(databases) or active_sessions > 0
        if _got_data:
            try:
                from app.utils.agent_cache import store_snapshot_for_conn
                store_snapshot_for_conn(conn_id, "mssql_monitoring_dashboard", _res, db)
            except Exception:
                pass
        return _res

    except Exception as e:
        return {
            "status": "error",
            "error": f"MSSQL connection failed: {str(e)}",
            "connection": conn_meta,
        }


def get_slow_queries(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "mssql_slow_queries", db)
    if cached is not None:
        if "normalized" not in cached:
            _normalize_mssql_rows(cached.get("queries") or [], cached)
        return cached

    conn_rec = _get_conn_or_404(conn_id, db)
    try:
        engine = _mssql_engine(conn_rec)
        # ActMon's own queries are NOT excluded here — the Slow Queries page
        # tags them via `classify_query_type()` in `_normalize_mssql_rows`
        # instead, so the "ActMon Queries" filter has real rows to show.
        queries = _rows(engine, """
            SELECT TOP 200
                CONVERT(VARCHAR(32), qs.query_hash, 2) AS query_hash,
                CAST(total_elapsed_time / 1000.0 / NULLIF(execution_count, 0) AS DECIMAL(10,2)) AS avg_elapsed_ms,
                CAST(min_elapsed_time / 1000.0 AS DECIMAL(10,2)) AS min_elapsed_ms,
                CAST(max_elapsed_time / 1000.0 AS DECIMAL(10,2)) AS max_elapsed_ms,
                execution_count,
                CAST(total_worker_time / 1000.0 AS DECIMAL(10,2)) AS total_cpu_ms,
                CAST(total_logical_reads / NULLIF(execution_count, 0) AS DECIMAL(10,0)) AS avg_logical_reads,
                CAST(total_physical_reads / NULLIF(execution_count, 0) AS DECIMAL(10,0)) AS avg_physical_reads,
                last_execution_time,
                LEFT(t.text, 500) AS sql_text,
                DB_NAME(t.dbid) AS db_name,
                qs.creation_time AS plan_created
            FROM sys.dm_exec_query_stats qs
            CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
            WHERE t.text NOT LIKE '%sys.dm_exec%'
            ORDER BY avg_elapsed_ms DESC
        """)

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

        response = {
            "status": "success",
            "source": "dm_exec_query_stats",
            "queries": normalised,
            "total": len(normalised),
            "error": None,
        }
        _normalize_mssql_rows(normalised, response)
        return _self_cache(conn_id, "mssql_slow_queries", response, db)
    except Exception as e:
        return {
            "status": "error",
            "source": "dm_exec_query_stats",
            "queries": [],
            "total": 0,
            "error": str(e),
        }


def _normalize_mssql_rows(queries: list, response: dict) -> None:
    """Builds the shared cross-engine `normalized`/`capabilities` shape from
    the dm_exec_query_stats rows above. Mutates `response` in place; see
    slow_query_normalize.py."""
    common_rows = []
    for q in queries:
        avg_ms = q.get("avg_elapsed_ms")
        execs = q.get("execution_count")
        common_rows.append(build_normalized_row(
            query_id=q.get("query_hash"),
            query_text=q.get("sql_text"),
            database_name=q.get("db_name"),
            execution_count=execs,
            total_execution_time=(avg_ms * execs) if (avg_ms is not None and execs is not None) else None,
            average_execution_time=avg_ms,
            min_execution_time=q.get("min_elapsed_ms"),
            max_execution_time=q.get("max_elapsed_ms"),
            last_seen=q.get("last_execution_time"),
            source="dm_exec_query_stats",
        ))
    attach_normalized(response, "mssql", common_rows)


def get_slow_queries_filtered(
    conn_id: int, db: Session, *,
    db_name: str = None, query_type: str = None, severity: str = None,
    user_name: str = None, search: str = None, min_avg_ms: float = None,
    date_from: str = None, date_to: str = None,
    sort_by: str = None, sort_dir: str = "desc", page: int = 1, page_size: int = 25,
) -> dict:
    """Wraps `get_slow_queries` with the shared filter/sort/paginate contract
    every engine's Slow Queries list now uses. `user_name` has no effect for
    MSSQL — `sys.dm_exec_query_stats` carries no per-plan user identity —
    passed through only for a consistent function signature."""
    from app.services.common.slow_query_normalize import filter_paginate_rows
    response = get_slow_queries(conn_id, db)
    result = filter_paginate_rows(
        response.get("normalized") or [],
        database_name=db_name, query_type=query_type, severity=severity,
        user_name=user_name, search=search, min_avg_ms=min_avg_ms,
        date_from=date_from, date_to=date_to,
        sort_by=sort_by, sort_dir=sort_dir, page=page, page_size=page_size,
    )
    response.update(result)
    return response


def get_error_logs(conn_id: int, db: Session):
    conn_rec = _get_conn_or_404(conn_id, db)
    try:
        engine = _mssql_engine(conn_rec)
        logs = []
        source = "xp_readerrorlog"
        xp_error = None

        try:
            with engine.connect() as c:
                result = c.execute(text("EXEC xp_readerrorlog 0, 1, NULL, NULL, NULL, NULL, 'DESC'"))
                raw_rows = result.fetchmany(200)
                keys = list(result.keys()) if hasattr(result, 'keys') else []

            for raw in raw_rows:
                if len(raw) >= 3:
                    log_date_val, process_info, text_val = raw[0], raw[1], raw[2]
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

        fallback_error = None
        if not logs:
            source = "sys.messages"
            try:
                rows = _rows(engine, """
                    SELECT TOP 100 message_id, severity, text AS message,
                        OBJECT_NAME(object_id) AS object_name,
                        CAST(GETDATE() AS VARCHAR(30)) AS log_date
                    FROM sys.messages
                    WHERE language_id = 1033 AND severity >= 16
                    ORDER BY severity DESC
                """)
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


def get_index_analysis(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "mssql_index_analysis", db)
    if cached is not None:
        return cached

    conn_rec = _get_conn_or_404(conn_id, db)
    errors = {}
    unused_indexes = []
    missing_indexes = []
    duplicate_indexes = []
    all_indexes_count = 0

    try:
        engine = _mssql_engine(conn_rec)

        try:
            row = _rows(engine, "SELECT COUNT(*) AS cnt FROM sys.indexes i WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1 AND i.index_id > 0")
            all_indexes_count = _to_int(row[0].get("cnt", 0)) if row else 0
            errors["all_indexes"] = None
        except Exception as e:
            errors["all_indexes"] = str(e)

        try:
            raw_unused = _rows(engine, """
                SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name,
                    i.type_desc, i.is_unique,
                    ISNULL(ius.user_seeks,0)+ISNULL(ius.user_scans,0)+ISNULL(ius.user_lookups,0) AS total_reads,
                    ISNULL(ius.user_updates,0) AS total_writes,
                    ius.last_user_seek, ius.last_user_scan
                FROM sys.indexes i
                LEFT JOIN sys.dm_db_index_usage_stats ius
                    ON i.object_id=ius.object_id AND i.index_id=ius.index_id AND ius.database_id=DB_ID()
                WHERE OBJECTPROPERTY(i.object_id,'IsUserTable')=1 AND i.index_id > 1
                  AND (ius.user_seeks IS NULL OR ius.user_seeks=0)
                  AND (ius.user_scans IS NULL OR ius.user_scans=0)
                  AND (ius.user_lookups IS NULL OR ius.user_lookups=0)
                ORDER BY ISNULL(ius.user_updates,0) DESC
            """)
            for row in raw_unused:
                for k, v in row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        row[k] = str(v)
            unused_indexes = raw_unused
            errors["unused_indexes"] = None
        except Exception as e:
            errors["unused_indexes"] = str(e)

        try:
            raw_missing = _rows(engine, """
                SELECT
                    CAST(mid.equality_columns + ISNULL(', ' + mid.inequality_columns,'') AS VARCHAR(300)) AS suggested_columns,
                    mid.included_columns,
                    CAST(migs.avg_total_user_cost * migs.avg_user_impact * (migs.user_seeks+migs.user_scans) AS DECIMAL(18,2)) AS improvement_measure,
                    OBJECT_NAME(mid.object_id) AS table_name,
                    migs.user_seeks, migs.user_scans
                FROM sys.dm_db_missing_index_details mid
                JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle=mig.index_handle
                JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle=migs.group_handle
                WHERE mid.database_id=DB_ID()
                ORDER BY improvement_measure DESC
            """)
            for row in raw_missing:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
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

        try:
            raw_dupes = _rows(engine, """
                SELECT t.name AS table_name, i1.name AS index1, i2.name AS index2,
                    i1.type_desc AS index1_type, i2.type_desc AS index2_type,
                    (SELECT COUNT(*) FROM sys.index_columns ic WHERE ic.object_id=i1.object_id AND ic.index_id=i1.index_id) AS key_column_count
                FROM sys.indexes i1
                JOIN sys.indexes i2 ON i1.object_id=i2.object_id AND i1.index_id < i2.index_id
                JOIN sys.tables t ON i1.object_id=t.object_id
                WHERE i1.type > 0 AND i2.type > 0
                  AND (SELECT COUNT(*) FROM sys.index_columns ic1 WHERE ic1.object_id=i1.object_id AND ic1.index_id=i1.index_id)
                    = (SELECT COUNT(*) FROM sys.index_columns ic2 WHERE ic2.object_id=i2.object_id AND ic2.index_id=i2.index_id)
                ORDER BY t.name, i1.name
            """)
            for row in raw_dupes:
                table = row.get("table_name", "")
                idx2 = row.get("index2", "")
                row["drop_hint"] = f"-- Verify columns match before dropping:\nDROP INDEX [{idx2}] ON [dbo].[{table}];"
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

    unused_with_writes = [u for u in unused_indexes if _to_int(u.get("total_writes", 0)) > 0]
    summary = {
        "total_indexes": all_indexes_count,
        "unused_indexes_count": len(unused_indexes),
        "unused_with_writes_count": len(unused_with_writes),
        "missing_indexes_count": len(missing_indexes),
        "duplicate_indexes_count": len(duplicate_indexes),
        "health_score": max(0, 100 - len(unused_indexes)*3 - len(missing_indexes)*4 - len(duplicate_indexes)*2),
        "note": "unused_indexes count reflects indexes with zero reads since the last SQL Server restart. Validate before dropping.",
    }

    return _self_cache(conn_id, "mssql_index_analysis", {
        "status": "success",
        "unused_indexes": unused_indexes,
        "missing_indexes": missing_indexes,
        "duplicate_indexes": duplicate_indexes,
        "all_indexes_count": all_indexes_count,
        "summary": summary,
        "errors": errors,
    }, db)


# ── Fragmentation analysis (its own feature, separate from Index Analysis) ────
#
# Two-tier design, mirroring the same broad-sweep + on-demand-precise-check
# pattern already used for Oracle storage:
#   1. get_fragmentation_analysis() — a 'LIMITED' scan across every index in the
#      database. 'LIMITED' only reads the b-tree's top level, so it is cheap
#      enough to run over everything, but it CANNOT report internal
#      fragmentation (page density) — sys.dm_db_index_physical_stats leaves
#      avg_page_space_used_in_percent/record_count/fragment_count/
#      avg_fragment_size_in_pages NULL in this mode.
#   2. get_fragmentation_detail() — an on-demand 'DETAILED' scan of ONE index
#      (a full page walk), run only when a user asks for it on a specific
#      finding. This is what actually answers "how tightly packed are the
#      pages" — the number that decides whether a REORGANIZE/REBUILD is worth
#      the I/O it costs to run.
def get_fragmentation_analysis(conn_id: int, db: Session):
    from app.utils.agent_cache import get_snapshot as _get_snap
    cached = _get_snap(conn_id, "mssql_fragmentation_analysis", db)
    if cached is not None:
        return cached

    conn_rec = _get_conn_or_404(conn_id, db)
    errors = {}
    fragmented_indexes = []

    try:
        engine = _mssql_engine(conn_rec)

        try:
            # Floor of 1000 pages (~8MB) and 5% fragmentation is Microsoft's own
            # long-standing guidance for when fragmentation is even worth acting
            # on — below that the number is noise, not signal. partition_number
            # is left ungrouped: a partitioned table's partitions fragment
            # independently, and collapsing them would hide which partition
            # actually needs the rebuild.
            raw_frag = _rows(engine, """
                SELECT OBJECT_NAME(i.object_id) AS table_name, i.name AS index_name,
                    i.type_desc, i.is_unique, i.fill_factor, i.allow_page_locks,
                    ps.partition_number,
                    CAST(ps.avg_fragmentation_in_percent AS DECIMAL(5,1)) AS frag_pct,
                    ps.page_count
                FROM sys.indexes i
                CROSS APPLY sys.dm_db_index_physical_stats(DB_ID(), i.object_id, i.index_id, NULL, 'LIMITED') ps
                WHERE OBJECTPROPERTY(i.object_id, 'IsUserTable') = 1 AND i.index_id > 0
                  AND ps.page_count > 1000 AND ps.avg_fragmentation_in_percent >= 5
                ORDER BY ps.avg_fragmentation_in_percent DESC
            """)
            for row in raw_frag:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
                frag_pct = _to_float(row.get("frag_pct"))
                fill_factor = _to_int(row.get("fill_factor"))
                row["fill_factor"] = fill_factor if fill_factor else 100
                page_locks_disabled = not row.get("allow_page_locks", True)
                partitioned = _to_int(row.get("partition_number")) > 1
                # Microsoft's own published threshold, unchanged since SQL 2005:
                # 5-30% -> REORGANIZE (always fully online, lighter weight),
                # >30% -> REBUILD (heavier; ONLINE=ON needs Enterprise edition).
                # But REORGANIZE physically defragments by shuffling pages using
                # page locks — with ALLOW_PAGE_LOCKS=OFF on the index it silently
                # does nothing useful, so REBUILD is the only real option
                # regardless of how low the fragmentation number is.
                if frag_pct >= 30 or page_locks_disabled:
                    row["recommended_action"] = "REBUILD"
                    ddl = f"ALTER INDEX [{row['index_name']}] ON [dbo].[{row['table_name']}] REBUILD"
                    if partitioned:
                        ddl += f" PARTITION = {row['partition_number']}"
                    row["ddl"] = ddl + ";"
                    row["action_note"] = (
                        "Forced to REBUILD: ALLOW_PAGE_LOCKS is OFF on this index, so REORGANIZE "
                        "cannot move pages here even though fragmentation is under 30%."
                    ) if page_locks_disabled and frag_pct < 30 else None
                else:
                    row["recommended_action"] = "REORGANIZE"
                    ddl = f"ALTER INDEX [{row['index_name']}] ON [dbo].[{row['table_name']}] REORGANIZE"
                    if partitioned:
                        ddl += f" PARTITION = {row['partition_number']}"
                    row["ddl"] = ddl + ";"
                    row["action_note"] = None
            fragmented_indexes = raw_frag
            errors["fragmented_indexes"] = None
        except Exception as e:
            errors["fragmented_indexes"] = str(e)
            fragmented_indexes = []

    except Exception as e:
        return {
            "status": "error",
            "error": f"Engine creation failed: {str(e)}",
            "fragmented_indexes": [],
            "summary": {},
            "errors": {},
        }

    needs_rebuild = [f for f in fragmented_indexes if f.get("recommended_action") == "REBUILD"]
    needs_reorganize = [f for f in fragmented_indexes if f.get("recommended_action") == "REORGANIZE"]
    page_locks_blocked = [f for f in fragmented_indexes if f.get("action_note")]
    total_wasted_mb = round(sum(
        (_to_int(f.get("page_count")) * 8 / 1024) * (_to_float(f.get("frag_pct")) / 100)
        for f in fragmented_indexes
    ), 1)
    summary = {
        "fragmented_indexes_count": len(fragmented_indexes),
        "needs_rebuild_count": len(needs_rebuild),
        "needs_reorganize_count": len(needs_reorganize),
        "page_locks_blocked_count": len(page_locks_blocked),
        "avg_fragmentation_pct": round(sum(_to_float(f.get("frag_pct")) for f in fragmented_indexes)
                                        / len(fragmented_indexes), 1) if fragmented_indexes else 0,
        "estimated_wasted_mb": total_wasted_mb,
        "note": "'LIMITED' scan (fast, safe to run broadly) — page count and % fragmented only. "
                "Run a precise check on any one finding for internal page-density detail.",
    }

    return _self_cache(conn_id, "mssql_fragmentation_analysis", {
        "status": "success",
        "fragmented_indexes": fragmented_indexes,
        "summary": summary,
        "errors": errors,
    }, db)


_IDENT_RE = re.compile(r"^[A-Za-z0-9_.$]+$")


def get_fragmentation_detail(conn_id: int, db: Session, table_name: str, index_name: str, partition_number: int = None):
    """On-demand 'DETAILED' scan (a full page walk) of ONE index — expensive
    enough that it is never run in the broad sweep, only when a user asks for
    the precise picture on a specific finding. table_name/index_name are
    resolved through OBJECT_ID()/a WHERE-clause bind parameter, never
    interpolated into SQL text, since they arrive from the request."""
    conn_rec = _get_conn_or_404(conn_id, db)
    if not _IDENT_RE.match(table_name or "") or not _IDENT_RE.match(index_name or ""):
        return {"status": "error", "error": "Invalid table or index name"}

    try:
        engine = _mssql_engine(conn_rec)
        sql = """
            SELECT ps.partition_number, ps.page_count,
                CAST(ps.avg_fragmentation_in_percent AS DECIMAL(5,1)) AS frag_pct,
                CAST(ps.avg_page_space_used_in_percent AS DECIMAL(5,1)) AS page_density_pct,
                ps.record_count, ps.fragment_count,
                CAST(ps.avg_fragment_size_in_pages AS DECIMAL(10,1)) AS avg_fragment_size_pages
            FROM sys.indexes i
            CROSS APPLY sys.dm_db_index_physical_stats(DB_ID(), OBJECT_ID(:table_name), i.index_id, :partition_number, 'DETAILED') ps
            WHERE i.object_id = OBJECT_ID(:table_name) AND i.name = :index_name
            ORDER BY ps.partition_number
        """
        partitions = _rows_params(engine, sql, {
            "table_name": table_name, "index_name": index_name, "partition_number": partition_number,
        })
        for row in partitions:
            for k, v in row.items():
                if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                    row[k] = float(v)
        if not partitions:
            return {"status": "error", "error": "No matching index found — it may have been dropped or rebuilt since the last sweep"}

        total_pages = sum(_to_int(p.get("page_count")) for p in partitions) or 1
        weighted = lambda key: round(sum(
            _to_float(p.get(key)) * _to_int(p.get("page_count")) for p in partitions
        ) / total_pages, 1)
        aggregate = {
            "page_count": total_pages,
            "frag_pct": weighted("frag_pct"),
            "page_density_pct": weighted("page_density_pct"),
            "record_count": sum(_to_int(p.get("record_count")) for p in partitions),
            "fragment_count": sum(_to_int(p.get("fragment_count")) for p in partitions),
        }
        return {"status": "success", "table_name": table_name, "index_name": index_name,
                "partitions": partitions, "aggregate": aggregate}
    except Exception as e:
        return {"status": "error", "error": str(e)}
