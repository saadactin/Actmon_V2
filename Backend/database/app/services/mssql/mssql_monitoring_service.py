import datetime
import re
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mssql_engine(conn):
    pw = quote_plus(conn.password or "")
    db_name = conn.database_name or "master"
    return create_engine(
        f"mssql+pyodbc://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name}"
        "?driver=ODBC+Driver+17+for+SQL+Server&timeout=5",
        pool_pre_ping=True,
    )


def _rows(engine, sql):
    with engine.connect() as c:
        r = c.execute(text(sql))
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

        server_info = {}
        try:
            rows = _rows(engine, """
                SELECT @@SERVERNAME AS server_name,
                       CAST(SERVERPROPERTY('ProductVersion') AS VARCHAR(50)) AS product_version,
                       CAST(SERVERPROPERTY('ProductLevel')   AS VARCHAR(50)) AS product_level,
                       CAST(SERVERPROPERTY('Edition')        AS VARCHAR(120)) AS edition,
                       @@VERSION AS version
            """)
            server_info = rows[0] if rows else {}
        except Exception as e:
            server_info = {"error": str(e)}

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

        active_sessions = 0
        try:
            # Exclude ActMon's own monitoring connection (@@SPID) so this count equals the
            # number of rows shown in the Active Sessions list.
            row = _rows(engine, "SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND session_id <> @@SPID")
            active_sessions = _to_int(row[0].get("cnt", 0)) if row else 0
        except Exception:
            pass

        max_connections_cfg = 0
        try:
            row = _rows(engine, "SELECT CAST(value_in_use AS INT) AS max_conn FROM sys.configurations WHERE name = 'max connections'")
            max_connections_cfg = _to_int(row[0].get("max_conn", 0)) if row else 0
        except Exception:
            pass

        # SQL Server's "max connections" = 0 means UNLIMITED — the effective ceiling is 32767.
        # Report the effective number so the UI never shows "?".
        max_connections_unlimited = (max_connections_cfg == 0)
        effective_max = max_connections_cfg if max_connections_cfg > 0 else 32767
        max_connections = effective_max
        connection_pct = round((active_sessions / effective_max) * 100, 2)

        buffer_cache_hit_pct = 0.0
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
                buffer_cache_hit_pct = min(_to_float(rows[0].get("pct", 0)), 100.0)
        except Exception:
            pass

        databases = []
        total_databases = 0
        try:
            databases = _rows(engine, """
                SELECT d.name, d.state_desc, d.recovery_model_desc,
                    CAST(SUM(CAST(f.size AS BIGINT)) * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb
                FROM sys.databases d
                LEFT JOIN sys.master_files f ON d.database_id = f.database_id
                GROUP BY d.name, d.state_desc, d.recovery_model_desc, d.database_id
                ORDER BY size_mb DESC
            """)
            total_databases = len(databases)
            for db_row in databases:
                for k, v in db_row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        db_row[k] = str(v)
        except Exception as e:
            databases = [{"error": str(e)}]

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

        wait_stats = []
        try:
            wait_stats = _rows(engine, """
                SELECT TOP 10 wait_type, waiting_tasks_count, wait_time_ms,
                    CAST(100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER (), 0) AS DECIMAL(5,1)) AS pct
                FROM sys.dm_os_wait_stats
                WHERE wait_type NOT IN (
                    'SLEEP_TASK','BROKER_TO_FLUSH','BROKER_EVENTHANDLER','CHECKPOINT_QUEUE','CLR_AUTO_EVENT',
                    'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','HADR_FILESTREAM_IOMGR_IOCOMPLETION',
                    'HADR_WORK_QUEUE','LAZYWRITER_SLEEP','LOGMGR_QUEUE','ONDEMAND_TASK_QUEUE',
                    'REQUEST_FOR_DEADLOCK_SEARCH','RESOURCE_QUEUE','SERVER_IDLE_CHECK','SLEEP_DBSTARTUP',
                    'SLEEP_DBRECOVER','SLEEP_MASTERDBREADY','SLEEP_MASTERMDREADY','SLEEP_MASTERUPGRADED',
                    'SLEEP_MSDBSTARTUP','SLEEP_SYSTEMTASK','SLEEP_TEMPDBSTARTUP','SNI_HTTP_ACCEPT',
                    'SP_SERVER_DIAGNOSTICS_SLEEP','SQLTRACE_BUFFER_FLUSH','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
                    'WAITFOR','XE_DISPATCHER_WAIT','XE_TIMER_EVENT'
                )
                ORDER BY wait_time_ms DESC
            """)
            for row in wait_stats:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            wait_stats = [{"error": str(e)}]

        active_queries = []
        try:
            # One row per user session — this is the exact set behind the "Active Sessions" count.
            # @@SPID (ActMon's own monitoring connection) is excluded so the list matches what the
            # user actually cares about. Aliases match the frontend (database_name / duration_ms / wait_type).
            active_queries = _rows(engine, """
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
            active_queries = [{"error": str(e)}]

        top_cpu_queries = []
        try:
            top_cpu_queries = _rows(engine, """
                SELECT TOP 20
                    CAST(total_worker_time / 1000.0 / NULLIF(execution_count, 0) AS DECIMAL(10,2)) AS avg_cpu_ms,
                    execution_count,
                    total_worker_time / 1000 AS total_cpu_ms,
                    total_elapsed_time / 1000 / NULLIF(execution_count, 0) AS avg_elapsed_ms,
                    LEFT(t.text, 200) AS query
                FROM sys.dm_exec_query_stats s
                CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
                ORDER BY avg_cpu_ms DESC
            """)
            for row in top_cpu_queries:
                for k, v in row.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            top_cpu_queries = [{"error": str(e)}]

        io_stats = []
        try:
            io_stats = _rows(engine, """
                SELECT TOP 10 DB_NAME(vfs.database_id) AS db_name, mf.physical_name,
                    vfs.io_stall_read_ms, vfs.io_stall_write_ms, vfs.io_stall,
                    vfs.num_of_reads, vfs.num_of_writes,
                    CAST(vfs.io_stall * 1.0 / NULLIF(vfs.num_of_reads + vfs.num_of_writes, 0) AS DECIMAL(10,2)) AS avg_io_ms
                FROM sys.dm_io_virtual_file_stats(NULL, NULL) vfs
                JOIN sys.master_files mf ON vfs.database_id = mf.database_id AND vfs.file_id = mf.file_id
                ORDER BY vfs.io_stall DESC
            """)
            for row in io_stats:
                for k, v in row.items():
                    if isinstance(v, (datetime.datetime, datetime.date)):
                        row[k] = str(v)
                    elif hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        row[k] = float(v)
        except Exception as e:
            io_stats = [{"error": str(e)}]

        memory_info = {}
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

        locks = []
        blocking = []
        try:
            locks = _rows(engine, """
                SELECT TOP 20 r.session_id, DB_NAME(r.database_id) AS db_name,
                    r.wait_type, r.wait_time, r.blocking_session_id,
                    LEFT(ISNULL(t.text,''), 200) AS query
                FROM sys.dm_exec_requests r
                OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE r.wait_type IS NOT NULL AND r.blocking_session_id >= 0
            """)
            blocking = [r for r in locks if _to_int(r.get("blocking_session_id", 0)) > 0]
        except Exception:
            pass

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

        users = []
        try:
            users = _rows(engine, """
                SELECT TOP 50 name, type_desc, is_disabled,
                    CAST(create_date AS VARCHAR(30)) AS create_date,
                    CAST(modify_date AS VARCHAR(30)) AS modify_date
                FROM sys.server_principals
                WHERE type IN ('S','U','G') ORDER BY name
            """)
        except Exception:
            pass

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
            for d in user_dbs:
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
                    for r in rows:
                        for k, v in list(r.items()):
                            if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                                r[k] = float(v)
                        r["missing_index_count"] = mi_counts.get((db_id, _to_int(r.get("object_id"))), 0)
                        tables.append(r)   # keeps db_name + raw schema_name for drill-down
                except Exception:
                    continue
            tables.sort(key=lambda x: x.get("total_mb") or 0, reverse=True)
            tables = tables[:100]
        except Exception as e:
            tables = [{"error": str(e)}]

        backup_history = []
        try:
            backup_history = _rows(engine, """
                SELECT TOP 20 database_name,
                    CAST(backup_start_date AS VARCHAR(30)) AS backup_start_date,
                    CAST(backup_finish_date AS VARCHAR(30)) AS backup_finish_date,
                    CAST(backup_size/1024/1024 AS DECIMAL(10,2)) AS size_mb,
                    type AS backup_type, CAST(is_copy_only AS INT) AS is_copy_only
                FROM msdb.dbo.backupset
                WHERE backup_finish_date >= DATEADD(day,-7,GETDATE())
                ORDER BY backup_finish_date DESC
            """)
            for r in backup_history:
                for k, v in r.items():
                    if hasattr(v, '__class__') and v.__class__.__name__ == 'Decimal':
                        r[k] = float(v)
        except Exception:
            pass

        job_history = []
        try:
            job_history = _rows(engine, """
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
            pass

        always_on = {"enabled": False, "groups": []}
        try:
            rows = _rows(engine, """
                SELECT ag.name AS ag_name, ars.role_desc, ags.synchronization_health_desc
                FROM sys.availability_groups ag
                JOIN sys.dm_hadr_availability_replica_states ars ON ag.group_id=ars.group_id
                LEFT JOIN sys.dm_hadr_availability_group_states ags ON ag.group_id=ags.group_id
                WHERE ars.is_local=1
            """)
            always_on = {"enabled": bool(rows), "groups": rows}
        except Exception:
            pass

        replication = {"enabled": False, "databases": [], "state": replication_state}
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
            pass

        product_version = str(server_info.get("product_version") or "").strip()
        edition = str(server_info.get("edition") or "").strip()
        full_version = str(server_info.get("version", "") or "")
        version_str = product_version or (full_version.split("\n")[0].strip() if full_version else "N/A")

        total_size_mb = round(sum(_to_float(d.get("size_mb", 0)) for d in databases if not d.get("error")), 1)

        return {
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
        return cached

    conn_rec = _get_conn_or_404(conn_id, db)
    try:
        engine = _mssql_engine(conn_rec)
        queries = _rows(engine, """
            SELECT TOP 50
                CAST(total_elapsed_time / 1000.0 / NULLIF(execution_count, 0) AS DECIMAL(10,2)) AS avg_elapsed_ms,
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

    return {
        "status": "success",
        "unused_indexes": unused_indexes,
        "missing_indexes": missing_indexes,
        "duplicate_indexes": duplicate_indexes,
        "all_indexes_count": all_indexes_count,
        "summary": summary,
        "errors": errors,
    }
