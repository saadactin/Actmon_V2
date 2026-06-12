from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
import datetime

from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import MySQLConnectionCreate

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL"]
)

# DATABASE SESSION
def get_db():

    db = SessionLocal()

    try:
        yield db

    finally:
        db.close()


# GET ALL MYSQL CONNECTIONS
@router.get("/")
def list_mysql_connections(
    db: Session = Depends(get_db)
):

    connections = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "mysql"
    ).all()

    return {
        "status": "success",
        "data": connections
    }


# CREATE MYSQL CONNECTION
@router.post("/")
def create_mysql_connection(
    request: MySQLConnectionCreate,
    db: Session = Depends(get_db)
):

    # ENCODE PASSWORD
    encoded_password = quote_plus(request.password)

    # MYSQL CONNECTION URL
    mysql_url = (
        f"mysql+pymysql://{request.username}:"
        f"{encoded_password}@"
        f"{request.host}:"
        f"{request.port}/"
        f"{request.database_name}"
    )

    try:

        # TEST MYSQL CONNECTION
        engine = create_engine(mysql_url)

        connection = engine.connect()

        connection.close()

    except SQLAlchemyError as e:

        raise HTTPException(
            status_code=400,
            detail=f"MySQL Connection Failed: {str(e)}"
        )

    # SAVE CONNECTION
    new_connection = ConnectionMaster(
        connection_name=request.connection_name,
        db_type="mysql",
        host=request.host,
        port=request.port,
        username=request.username,
        password=request.password,
        database_name=request.database_name
    )
    # (no server/OS configuration persisted in this route)

    db.add(new_connection)

    db.commit()

    db.refresh(new_connection)

    return {
        "status": "success",
        "message": "MySQL Connection Successful",
        "data": {
            "id": new_connection.id,
            "connection_name": new_connection.connection_name,
            "host": new_connection.host
        }
    }


# DELETE MYSQL CONNECTION
@router.delete("/{conn_id}")
def delete_mysql_connection(
    conn_id: int,
    db: Session = Depends(get_db)
):

    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="Connection Not Found"
        )

    db.delete(connection)

    db.commit()

    return {
        "status": "success",
        "message": "Connection Deleted Successfully"
    }


# MYSQL TELEMETRY DASHBOARD
@router.get("/{conn_id}/dashboard")
def get_mysql_dashboard(
    conn_id: int,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mysql"
    ).first()

    if not connection:
        raise HTTPException(
            status_code=404,
            detail="Connection Profile Not Found"
        )

    conn_meta = {
        "id": connection.id,
        "name": connection.connection_name,
        "host": connection.host,
        "port": connection.port,
        "database": connection.database_name
    }

    # Build connection URL safely
    encoded_password = quote_plus(connection.password) if connection.password else ""
    user_part = f"{connection.username}" if connection.username else ""
    pass_part = f":{encoded_password}" if connection.password else ""
    auth_part = f"{user_part}{pass_part}@" if (user_part or pass_part) else ""
    db_name = connection.database_name or ""
    mysql_url = f"mysql+pymysql://{auth_part}{connection.host}:{connection.port}/{db_name}"

    try:
        # Connect to MySQL and gather status and telemetry variables
        engine = create_engine(
            mysql_url,
            connect_args={
                "connect_timeout": 15,
                "read_timeout": 30,
                "write_timeout": 30
            }
        )
        with engine.connect() as conn:
            status_dict = {}
            try:
                res_status = conn.execute(text("SHOW GLOBAL STATUS;"))
                status_dict = {row[0]: row[1] for row in res_status.fetchall()}
            except Exception:
                try:
                    res_status = conn.execute(text("SHOW STATUS;"))
                    status_dict = {row[0]: row[1] for row in res_status.fetchall()}
                except Exception:
                    pass

            vars_dict = {}
            try:
                res_vars = conn.execute(text("SHOW GLOBAL VARIABLES;"))
                vars_dict = {row[0]: row[1] for row in res_vars.fetchall()}
            except Exception:
                try:
                    res_vars = conn.execute(text("SHOW VARIABLES;"))
                    vars_dict = {row[0]: row[1] for row in res_vars.fetchall()}
                except Exception:
                    pass

            # Helpers for parsing types
            def to_int(val, default=0):
                try:
                    return int(val)
                except (ValueError, TypeError):
                    return default

            def to_float(val, default=0.0):
                try:
                    return float(val)
                except (ValueError, TypeError):
                    return default

            # Calculation for Uptime & Restart Time
            uptime_sec = to_int(status_dict.get("Uptime", 0))
            uptime_str = "0s"
            last_restart_str = "NA"
            if uptime_sec > 0:
                days = uptime_sec // 86400
                hours = (uptime_sec % 86400) // 3600
                minutes = (uptime_sec % 3600) // 60
                if days > 0:
                    uptime_str = f"{days}d {hours}h {minutes}m"
                else:
                    uptime_str = f"{hours}h {minutes}m"
                
                # Approximate calculation
                last_restart = datetime.datetime.now() - datetime.timedelta(seconds=uptime_sec)
                last_restart_str = last_restart.strftime("%Y-%m-%d %H:%M:%S")

            version = vars_dict.get("version", "NA")
            hostname = vars_dict.get("hostname", "NA")
            storage_engine = vars_dict.get("default_storage_engine", "InnoDB")

            max_conns = to_int(vars_dict.get("max_connections", 151))
            current_conns = to_int(status_dict.get("Threads_connected", 1))
            conn_usage_pct = round((current_conns / max_conns) * 100, 2) if max_conns > 0 else 0.0

            # Buffer Cache Usage %
            read_req = to_int(status_dict.get("Innodb_buffer_pool_read_requests", 0))
            reads = to_int(status_dict.get("Innodb_buffer_pool_reads", 0))
            cache_usage_pct = 100.0
            if read_req > 0:
                cache_usage_pct = round((1 - (reads / read_req)) * 100, 2)

            # ── Query Databases ─────────────────────────────────
            databases_list = []
            total_dbs = 0
            total_tbls = 0
            total_sz_bytes = 0

            SYSTEM_DBS = {'information_schema', 'performance_schema', 'mysql', 'sys'}

            # Step 1: Always get the database name list from SHOW DATABASES
            try:
                res_show = conn.execute(text("SHOW DATABASES;"))
                for r in res_show.fetchall():
                    if r[0] not in SYSTEM_DBS:
                        databases_list.append({
                            "name": r[0],
                            "tables_count": 0,
                            "size_mb": 0.0
                        })
                total_dbs = len(databases_list)
            except Exception:
                pass

            # Step 2: Enrich with real table counts + sizes from information_schema
            try:
                db_query = text("""
                    SELECT
                        table_schema                              AS db_name,
                        COUNT(*)                                  AS tables_count,
                        COALESCE(SUM(data_length + index_length), 0) AS size_bytes
                    FROM information_schema.tables
                    WHERE table_type = 'BASE TABLE'
                      AND table_schema NOT IN
                          ('information_schema','performance_schema','mysql','sys')
                    GROUP BY table_schema
                """)
                res_dbs = conn.execute(db_query)
                size_map = {}
                for r in res_dbs.fetchall():
                    size_map[r[0]] = {
                        "tables_count": to_int(r[1]),
                        "size_bytes":   to_int(r[2]),
                    }

                # Merge into databases_list; add any DB from info_schema not in SHOW DATABASES
                existing_names = {d["name"] for d in databases_list}
                for db_name, info in size_map.items():
                    if db_name not in existing_names:
                        databases_list.append({
                            "name": db_name,
                            "tables_count": info["tables_count"],
                            "size_mb": round(info["size_bytes"] / (1024 * 1024), 2),
                        })
                    else:
                        for d in databases_list:
                            if d["name"] == db_name:
                                d["tables_count"] = info["tables_count"]
                                d["size_mb"]      = round(info["size_bytes"] / (1024 * 1024), 2)
                                break

                # Recompute totals
                total_dbs = len(databases_list)
                total_tbls = sum(d["tables_count"] for d in databases_list)
                total_sz_bytes = sum(
                    to_int(size_map.get(d["name"], {}).get("size_bytes", 0))
                    for d in databases_list
                )
            except Exception:
                # info_schema query failed — keep the SHOW DATABASES list as-is
                pass

            total_sz_mb = round(total_sz_bytes / (1024 * 1024), 2)
            total_sz_gb = round(total_sz_mb / 1024, 2)

            # Process List
            process_list = []
            try:
                res_proc = conn.execute(text("SHOW FULL PROCESSLIST;"))
                for r in res_proc.fetchall():
                    process_list.append({
                        "Id": r[0],
                        "User": r[1],
                        "Host": r[2],
                        "db": r[3],
                        "Command": r[4],
                        "Time": r[5],
                        "State": r[6],
                        "Info": r[7]
                    })
            except Exception:
                pass

            long_running_queries = [
                proc for proc in process_list
                if to_int(proc.get("Time", 0)) >= 1 and proc.get("Command") != "Sleep"
            ]

            # Replication / Galera status
            replication_dict = {}
            replication_state = "STANDALONE"
            galera_info = {}
            try:
                # Check Galera WSREP first
                res_wsrep = conn.execute(text("SHOW GLOBAL STATUS LIKE 'wsrep_%';"))
                wsrep_rows = {r[0]: r[1] for r in res_wsrep.fetchall()}
                if wsrep_rows.get("wsrep_connected") == "ON":
                    cluster_size = int(wsrep_rows.get("wsrep_cluster_size", 1))
                    replication_state = "GALERA"
                    galera_info = {
                        "cluster_size": cluster_size,
                        "cluster_status": wsrep_rows.get("wsrep_cluster_status", ""),
                        "local_state_comment": wsrep_rows.get("wsrep_local_state_comment", ""),
                        "connected": wsrep_rows.get("wsrep_connected", ""),
                        "ready": wsrep_rows.get("wsrep_ready", ""),
                        "flow_control_paused": wsrep_rows.get("wsrep_flow_control_paused", ""),
                        "cert_deps_distance": wsrep_rows.get("wsrep_cert_deps_distance", ""),
                        "node_name": wsrep_rows.get("wsrep_node_name", ""),
                        "cluster_name": wsrep_rows.get("wsrep_cluster_name", ""),
                        "incoming_addresses": wsrep_rows.get("wsrep_incoming_addresses", ""),
                    }
            except Exception:
                pass

            if replication_state == "STANDALONE":
                try:
                    res_repl = conn.execute(text("SHOW SLAVE STATUS;"))
                    row_repl = res_repl.fetchone()
                    if not row_repl:
                        try:
                            res_repl = conn.execute(text("SHOW REPLICA STATUS;"))
                            row_repl = res_repl.fetchone()
                        except Exception:
                            pass
                    if row_repl:
                        replication_state = "REPLICA"
                        try:
                            keys = res_repl.keys()
                            for k, v in zip(keys, row_repl):
                                if isinstance(v, (int, float)):
                                    replication_dict[k] = v
                                elif v is None:
                                    replication_dict[k] = ""
                                else:
                                    replication_dict[k] = str(v)
                        except Exception:
                            for idx, v in enumerate(row_repl):
                                replication_dict[f"field_{idx}"] = str(v) if v is not None else ""
                except Exception:
                    pass

            slow_log = vars_dict.get("slow_query_log", "OFF")
            long_query = to_float(vars_dict.get("long_query_time", 10.0))
            slow_log_file = vars_dict.get("slow_query_log_file", "")

            # Memory buffer pool
            buf_pool_size = to_int(vars_dict.get("innodb_buffer_pool_size", 0))
            buf_pool_size_mb = round(buf_pool_size / (1024 * 1024), 2)
            pages_data = to_int(status_dict.get("Innodb_buffer_pool_pages_data", 0))
            pages_total = to_int(status_dict.get("Innodb_buffer_pool_pages_total", 0))

            # Extended metrics for enhanced overview
            threads_running       = to_int(status_dict.get("Threads_running", 1))
            threads_cached        = to_int(status_dict.get("Threads_cached", 0))
            threads_created       = to_int(status_dict.get("Threads_created", 0))
            max_used_connections  = to_int(status_dict.get("Max_used_connections", current_conns))
            aborted_clients       = to_int(status_dict.get("Aborted_clients", 0))
            aborted_connects      = to_int(status_dict.get("Aborted_connects", 0))
            table_locks_waited    = to_int(status_dict.get("Table_locks_waited", 0))
            table_locks_immediate = to_int(status_dict.get("Table_locks_immediate", 0))
            tmp_disk_tables       = to_int(status_dict.get("Created_tmp_disk_tables", 0))
            tmp_tables_total      = to_int(status_dict.get("Created_tmp_tables", 1))
            com_commit            = to_int(status_dict.get("Com_commit", 0))
            com_rollback          = to_int(status_dict.get("Com_rollback", 0))
            select_scan           = to_int(status_dict.get("Select_scan", 0))
            select_full_join      = to_int(status_dict.get("Select_full_join", 0))
            open_files_status     = to_int(status_dict.get("Open_files", 0))

            # Additional server variables
            datadir               = vars_dict.get("datadir", "")
            log_bin               = vars_dict.get("log_bin", "OFF")
            binlog_format         = vars_dict.get("binlog_format", "")
            table_open_cache_v    = to_int(vars_dict.get("table_open_cache", 0))
            open_files_limit      = to_int(vars_dict.get("open_files_limit", 0))
            innodb_log_file_size  = to_int(vars_dict.get("innodb_log_file_size", 0))

            payload = {
                "status": "success",
                "connection": conn_meta,
                "health_summary": {
                    "uptime": uptime_str,
                    "last_restart": last_restart_str,
                    "host_name": hostname,
                    "version": version,
                    "replication_state": replication_state,
                    "connection_usage_pct": conn_usage_pct,
                    "cache_usage_pct": cache_usage_pct,
                    "total_databases": total_dbs,
                    "total_tables": total_tbls,
                    "total_size_mb": total_sz_mb,
                    "total_size_gb": total_sz_gb,
                    "current_connections": current_conns,
                    "max_connections": max_conns,
                    "storage_engine": storage_engine
                },
                "databases": databases_list,
                "chart_data": {
                    "connection_pct": conn_usage_pct,
                    "cache_pct": cache_usage_pct,
                    "query_stats": {
                        "labels": ["Com_select", "Com_insert", "Com_update", "Com_delete"],
                        "values": [
                            to_int(status_dict.get("Com_select", 0)),
                            to_int(status_dict.get("Com_insert", 0)),
                            to_int(status_dict.get("Com_update", 0)),
                            to_int(status_dict.get("Com_delete", 0))
                        ]
                    },
                    "db_sizes": [
                        {"name": db["name"], "size_mb": db["size_mb"]}
                        for db in databases_list if db["name"] not in ["information_schema", "performance_schema", "mysql", "sys"]
                    ][:10]
                },
                "connections_detail": {
                    "current": current_conns,
                    "max": max_conns,
                    "connection_usage_pct": conn_usage_pct
                },
                "memory": {
                    "buffer_pool_size_mb": buf_pool_size_mb,
                    "pages_data": pages_data,
                    "pages_total": pages_total,
                    "read_requests": read_req,
                    "reads": reads,
                    "cache_usage_pct": cache_usage_pct
                },
                "query_stats": {
                    "Com_select":   to_int(status_dict.get("Com_select", 0)),
                    "Com_insert":   to_int(status_dict.get("Com_insert", 0)),
                    "Com_update":   to_int(status_dict.get("Com_update", 0)),
                    "Com_delete":   to_int(status_dict.get("Com_delete", 0)),
                    "Com_commit":   com_commit,
                    "Com_rollback": com_rollback,
                    "Questions":    to_int(status_dict.get("Questions", 0)),
                    "Slow_queries": to_int(status_dict.get("Slow_queries", 0)),
                },
                "network": {
                    "bytes_received": to_int(status_dict.get("Bytes_received", 0)),
                    "bytes_sent": to_int(status_dict.get("Bytes_sent", 0))
                },
                "threads": {
                    "running":   threads_running,
                    "connected": current_conns,
                    "cached":    threads_cached,
                    "created":   threads_created,
                    "max_used":  max_used_connections,
                },
                "tps": {
                    "commits":   com_commit,
                    "rollbacks": com_rollback,
                },
                "aborted": {
                    "clients":  aborted_clients,
                    "connects": aborted_connects,
                },
                "table_locks": {
                    "waited":         table_locks_waited,
                    "immediate":      table_locks_immediate,
                    "contention_pct": round(table_locks_waited / max(table_locks_waited + table_locks_immediate, 1) * 100, 2),
                },
                "tmp_tables": {
                    "disk":     tmp_disk_tables,
                    "total":    tmp_tables_total,
                    "disk_pct": round(tmp_disk_tables / max(tmp_tables_total, 1) * 100, 2),
                },
                "binlog": {
                    "enabled": log_bin == "ON",
                    "format":  binlog_format,
                },
                "server_vars": {
                    "datadir":                 datadir,
                    "hostname":                hostname,
                    "table_open_cache":        table_open_cache_v,
                    "open_files_limit":        open_files_limit,
                    "open_files":              open_files_status,
                    "innodb_log_file_size_mb": round(innodb_log_file_size / max(1024 * 1024, 1), 2),
                    "select_scan":             select_scan,
                    "select_full_join":        select_full_join,
                },
                "slow_query_config": {
                    "slow_query_log": slow_log,
                    "long_query_time": long_query,
                    "slow_query_log_file": slow_log_file
                },
                "error_log_path": vars_dict.get("log_error", "NA"),
                "error_log_count": 0,
                "process_list": process_list,
                "long_running_queries": long_running_queries,
                "replication": replication_dict,
                "galera": galera_info,
            }
            return payload

    except Exception as e:
        return {
            "status": "error",
            "error": f"MySQL Connection Failed: {str(e)}",
            "connection": conn_meta
        }


# ==========================================
# BACKUP INFO & PITR ENDPOINT
# ==========================================

@router.get("/{conn_id}/backup-info")
def get_backup_info(conn_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type == "mysql"
    ).first()

    if not connection:
        raise HTTPException(status_code=404, detail="MySQL connection not found")

    encoded_password = quote_plus(connection.password) if connection.password else ""
    mysql_url = (
        f"mysql+pymysql://{connection.username}:{encoded_password}"
        f"@{connection.host}:{connection.port}/{connection.database_name or ''}"
    )

    try:
        eng = create_engine(mysql_url, connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30})
        with eng.connect() as conn:

            def qval(sql):
                try:
                    row = conn.execute(text(sql)).fetchone()
                    return row[1] if row else "N/A"
                except Exception:
                    return "N/A"

            def qvar(var_name):
                return qval(f"SHOW VARIABLES LIKE '{var_name}'")

            def qstat(stat_name):
                try:
                    row = conn.execute(text(f"SHOW STATUS LIKE '{stat_name}'")).fetchone()
                    return row[1] if row else "N/A"
                except Exception:
                    return "N/A"

            binlog_enabled = qvar("log_bin")
            binlog_format = qvar("binlog_format")
            binlog_expire = qvar("binlog_expire_logs_seconds")
            expire_logs_days = qvar("expire_logs_days")
            gtid_mode = qvar("gtid_mode")
            sync_binlog = qvar("sync_binlog")
            innodb_flush = qvar("innodb_flush_log_at_trx_commit")
            datadir = qvar("datadir")
            server_id_val = qvar("server_id")

            # Current binlog file + position
            binlog_file = "N/A"
            binlog_position = "N/A"
            try:
                row = conn.execute(text("SHOW MASTER STATUS")).fetchone()
                if row:
                    binlog_file = row[0]
                    binlog_position = row[1]
            except Exception:
                try:
                    row = conn.execute(text("SHOW BINARY LOG STATUS")).fetchone()
                    if row:
                        binlog_file = row[0]
                        binlog_position = row[1]
                except Exception:
                    pass

            # Binary log files list
            binlog_files = []
            try:
                rows = conn.execute(text("SHOW BINARY LOGS")).fetchall()
                for r in rows:
                    binlog_files.append({"file": r[0], "size_bytes": r[1]})
            except Exception:
                pass

            # GTID current executed
            gtid_executed = "N/A"
            if gtid_mode in ("ON", "on"):
                try:
                    row = conn.execute(
                        text("SELECT @@global.gtid_executed")
                    ).fetchone()
                    gtid_executed = row[0] if row else "N/A"
                except Exception:
                    pass

            # Replication lag (if replica)
            replication_lag = None
            try:
                row = conn.execute(text("SHOW SLAVE STATUS")).fetchone()
                if row:
                    keys = conn.execute(text("SHOW SLAVE STATUS")).keys()
                    row_dict = dict(zip(keys, row))
                    replication_lag = row_dict.get("Seconds_Behind_Master")
            except Exception:
                pass

            return {
                "status": "success",
                "backup_info": {
                    "binlog_enabled": binlog_enabled,
                    "binlog_format": binlog_format,
                    "binlog_expire_seconds": binlog_expire,
                    "expire_logs_days": expire_logs_days,
                    "current_binlog_file": binlog_file,
                    "current_binlog_position": binlog_position,
                    "binlog_files": binlog_files[:20],
                    "gtid_mode": gtid_mode,
                    "gtid_executed": str(gtid_executed)[:200] if gtid_executed != "N/A" else "N/A",
                    "sync_binlog": sync_binlog,
                    "innodb_flush_log_at_trx_commit": innodb_flush,
                    "datadir": datadir,
                    "server_id": server_id_val,
                    "replication_lag_seconds": replication_lag,
                    "pitr_capable": binlog_enabled == "ON",
                    "durability_level": (
                        "Full Durability"
                        if (innodb_flush == "1" and sync_binlog == "1")
                        else "Partial Durability" if innodb_flush in ("1", "2")
                        else "Performance Mode"
                    ),
                },
            }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch backup info: {str(e)}")


# ──────────────────────────────────────────────────────────────
#  TABLE STATISTICS ENDPOINT
# ──────────────────────────────────────────────────────────────
@router.get("/{conn_id}/table-stats")
def get_table_stats(conn_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "mysql"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    encoded_password = quote_plus(connection.password) if connection.password else ""
    mysql_url = (f"mysql+pymysql://{connection.username}:{encoded_password}"
                 f"@{connection.host}:{connection.port}/{connection.database_name or ''}")
    try:
        eng = create_engine(mysql_url, connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30})
        with eng.connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    table_schema,
                    table_name,
                    engine,
                    COALESCE(table_rows, 0)                      AS table_rows,
                    COALESCE(ROUND((data_length)/1024/1024,2),0) AS data_mb,
                    COALESCE(ROUND((index_length)/1024/1024,2),0) AS index_mb,
                    COALESCE(ROUND((data_length+index_length)/1024/1024,2),0) AS total_mb,
                    table_collation,
                    COALESCE(auto_increment,0)                   AS auto_increment,
                    create_time,
                    update_time,
                    table_comment
                FROM information_schema.tables
                WHERE table_type = 'BASE TABLE'
                  AND table_schema NOT IN ('information_schema','performance_schema','mysql','sys')
                ORDER BY (data_length + index_length) DESC
                LIMIT 200
            """)).fetchall()
            tables = [{
                "schema": r[0], "table": r[1], "engine": r[2] or "?",
                "rows": int(r[3]), "data_mb": float(r[4]), "index_mb": float(r[5]),
                "total_mb": float(r[6]), "collation": r[7] or "",
                "auto_increment": int(r[8]),
                "create_time": str(r[9]) if r[9] else "",
                "update_time": str(r[10]) if r[10] else "",
                "comment": r[11] or "",
            } for r in rows]
        return {"status": "success", "tables": tables}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ──────────────────────────────────────────────────────────────
#  USER ACTIVITY ENDPOINT
# ──────────────────────────────────────────────────────────────
@router.get("/{conn_id}/user-stats")
def get_user_stats(conn_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "mysql"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    encoded_password = quote_plus(connection.password) if connection.password else ""
    mysql_url = (f"mysql+pymysql://{connection.username}:{encoded_password}"
                 f"@{connection.host}:{connection.port}/{connection.database_name or ''}")
    try:
        eng = create_engine(mysql_url, connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30})
        with eng.connect() as conn:
            # Active connections per user
            proc_rows = conn.execute(text("SHOW FULL PROCESSLIST")).fetchall()
            user_map = {}
            for r in proc_rows:
                u = r[1] or "unknown"
                if u not in user_map:
                    user_map[u] = {"user": u, "connections": 0, "active": 0, "sleeping": 0, "host": r[2] or ""}
                user_map[u]["connections"] += 1
                if r[4] == "Sleep":
                    user_map[u]["sleeping"] += 1
                else:
                    user_map[u]["active"] += 1

            # Global privileges
            grants = []
            try:
                g_rows = conn.execute(text(
                    "SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE "
                    "FROM information_schema.USER_PRIVILEGES"
                )).fetchall()
                for r in g_rows:
                    grants.append({"grantee": r[0], "privilege": r[1], "is_grantable": r[2]})
            except Exception:
                pass

        return {
            "status": "success",
            "users": list(user_map.values()),
            "grants": grants[:100],
            "total_processes": len(proc_rows),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ──────────────────────────────────────────────────────────────
#  INNODB METRICS ENDPOINT
# ──────────────────────────────────────────────────────────────
@router.get("/{conn_id}/innodb-metrics")
def get_innodb_metrics(conn_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "mysql"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    encoded_password = quote_plus(connection.password) if connection.password else ""
    mysql_url = (f"mysql+pymysql://{connection.username}:{encoded_password}"
                 f"@{connection.host}:{connection.port}/{connection.database_name or ''}")

    def to_int(v, d=0):
        try: return int(v)
        except: return d

    try:
        eng = create_engine(mysql_url, connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30})
        with eng.connect() as conn:
            status = {}
            try:
                res = conn.execute(text("SHOW GLOBAL STATUS"))
                status = {r[0]: r[1] for r in res.fetchall()}
            except Exception:
                pass

            # Active locks / transactions
            locks = []
            try:
                lock_rows = conn.execute(text(
                    "SELECT trx_id, trx_state, trx_started, trx_query, trx_rows_locked, trx_rows_modified "
                    "FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 20"
                )).fetchall()
                for r in lock_rows:
                    locks.append({
                        "trx_id": r[0], "state": r[1],
                        "started": str(r[2]) if r[2] else "",
                        "query": str(r[3] or "")[:200],
                        "rows_locked": to_int(r[4]),
                        "rows_modified": to_int(r[5]),
                    })
            except Exception:
                pass

            metrics = {
                "row_reads":          to_int(status.get("Innodb_rows_read")),
                "row_inserts":        to_int(status.get("Innodb_rows_inserted")),
                "row_updates":        to_int(status.get("Innodb_rows_updated")),
                "row_deletes":        to_int(status.get("Innodb_rows_deleted")),
                "deadlocks":          to_int(status.get("Innodb_deadlocks")),
                "lock_waits":         to_int(status.get("Innodb_row_lock_waits")),
                "lock_time_avg_ms":   round(to_int(status.get("Innodb_row_lock_time")) /
                                            max(to_int(status.get("Innodb_row_lock_waits")), 1), 2),
                "log_waits":          to_int(status.get("Innodb_log_waits")),
                "os_log_fsyncs":      to_int(status.get("Innodb_os_log_fsyncs")),
                "pending_reads":      to_int(status.get("Innodb_data_pending_reads")),
                "pending_writes":     to_int(status.get("Innodb_data_pending_writes")),
                "data_reads":         to_int(status.get("Innodb_data_reads")),
                "data_writes":        to_int(status.get("Innodb_data_writes")),
                "buffer_pool_reads":  to_int(status.get("Innodb_buffer_pool_reads")),
                "buffer_pool_read_requests": to_int(status.get("Innodb_buffer_pool_read_requests")),
                "buffer_pool_write_requests": to_int(status.get("Innodb_buffer_pool_write_requests")),
                "active_transactions": len(locks),
            }
        return {"status": "success", "metrics": metrics, "active_transactions": locks}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ──────────────────────────────────────────────────────────────
#  COMPREHENSIVE PERFORMANCE DETAIL  (Advanced Performance Tab)
# ──────────────────────────────────────────────────────────────
@router.get("/{conn_id}/performance-detail")
def get_performance_detail(conn_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "mysql"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Connection not found")

    encoded_password = quote_plus(connection.password) if connection.password else ""
    mysql_url = (f"mysql+pymysql://{connection.username}:{encoded_password}"
                 f"@{connection.host}:{connection.port}/{connection.database_name or ''}")

    def ti(v, d=0):
        try: return int(v)
        except: return d

    def tf(v, d=0.0):
        try: return float(v)
        except: return d

    try:
        eng = create_engine(mysql_url, connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30})
        with eng.connect() as conn:

            # ── 1. GLOBAL STATUS + VARIABLES ────────────────────────
            status = {}
            variables = {}
            try:
                for row in conn.execute(text("SHOW GLOBAL STATUS")).fetchall():
                    status[row[0]] = row[1]
            except Exception:
                pass
            try:
                for row in conn.execute(text("SHOW GLOBAL VARIABLES")).fetchall():
                    variables[row[0]] = row[1]
            except Exception:
                pass

            uptime = ti(status.get("Uptime", 1)) or 1

            # ── 2. BUFFER POOL ───────────────────────────────────────
            bp_size_bytes  = ti(variables.get("innodb_buffer_pool_size", 0))
            bp_total       = ti(status.get("Innodb_buffer_pool_pages_total", 0))
            bp_data        = ti(status.get("Innodb_buffer_pool_pages_data", 0))
            bp_free        = ti(status.get("Innodb_buffer_pool_pages_free", 0))
            bp_dirty       = ti(status.get("Innodb_buffer_pool_pages_dirty", 0))
            bp_misc        = max(0, bp_total - bp_data - bp_free)
            bp_read_req    = ti(status.get("Innodb_buffer_pool_read_requests", 0))
            bp_reads       = ti(status.get("Innodb_buffer_pool_reads", 0))
            bp_hit         = round((1 - bp_reads / max(bp_read_req, 1)) * 100, 2) if bp_read_req > 0 else 100.0

            buffer_pool = {
                "size_bytes":       bp_size_bytes,
                "size_mb":          round(bp_size_bytes / 1048576, 1),
                "pages_total":      bp_total,
                "pages_data":       bp_data,
                "pages_free":       bp_free,
                "pages_dirty":      bp_dirty,
                "pages_misc":       bp_misc,
                "data_pct":         round(bp_data  / max(bp_total, 1) * 100, 1),
                "free_pct":         round(bp_free  / max(bp_total, 1) * 100, 1),
                "dirty_pct":        round(bp_dirty / max(bp_total, 1) * 100, 1),
                "read_requests":    bp_read_req,
                "physical_reads":   bp_reads,
                "hit_ratio":        bp_hit,
                "write_requests":   ti(status.get("Innodb_buffer_pool_write_requests", 0)),
                "pages_flushed":    ti(status.get("Innodb_buffer_pool_pages_flushed", 0)),
                "pool_instances":   ti(variables.get("innodb_buffer_pool_instances", 1)),
            }

            # ── 3. ROW OPERATIONS ────────────────────────────────────
            rr = ti(status.get("Innodb_rows_read", 0))
            ri = ti(status.get("Innodb_rows_inserted", 0))
            ru = ti(status.get("Innodb_rows_updated", 0))
            rd = ti(status.get("Innodb_rows_deleted", 0))
            row_ops = {
                "reads":          rr, "inserts":     ri,
                "updates":        ru, "deletes":     rd,
                "total":          rr + ri + ru + rd,
                "reads_per_sec":   round(rr / uptime, 2),
                "inserts_per_sec": round(ri / uptime, 2),
                "updates_per_sec": round(ru / uptime, 2),
                "deletes_per_sec": round(rd / uptime, 2),
            }

            # ── 4. INNODB I/O ────────────────────────────────────────
            innodb_io = {
                "data_reads":            ti(status.get("Innodb_data_reads", 0)),
                "data_writes":           ti(status.get("Innodb_data_writes", 0)),
                "data_fsyncs":           ti(status.get("Innodb_data_fsyncs", 0)),
                "os_log_writes":         ti(status.get("Innodb_os_log_writes", 0)),
                "os_log_fsyncs":         ti(status.get("Innodb_os_log_fsyncs", 0)),
                "log_writes":            ti(status.get("Innodb_log_writes", 0)),
                "log_write_requests":    ti(status.get("Innodb_log_write_requests", 0)),
                "pending_reads":         ti(status.get("Innodb_data_pending_reads", 0)),
                "pending_writes":        ti(status.get("Innodb_data_pending_writes", 0)),
                "pending_log_writes":    ti(status.get("Innodb_os_log_pending_writes", 0)),
                "log_waits":             ti(status.get("Innodb_log_waits", 0)),
                "pages_created":         ti(status.get("Innodb_pages_created", 0)),
                "pages_read":            ti(status.get("Innodb_pages_read", 0)),
                "pages_written":         ti(status.get("Innodb_pages_written", 0)),
                "dblwr_pages_written":   ti(status.get("Innodb_dblwr_pages_written", 0)),
                "dblwr_writes":          ti(status.get("Innodb_dblwr_writes", 0)),
            }

            # ── 5. LOCKING ───────────────────────────────────────────
            lk_waits  = ti(status.get("Innodb_row_lock_waits", 0))
            lk_time   = ti(status.get("Innodb_row_lock_time", 0))
            tbl_waited = ti(status.get("Table_locks_waited", 0))
            tbl_imm    = ti(status.get("Table_locks_immediate", 0))
            locking = {
                "deadlocks":               ti(status.get("Innodb_deadlocks", 0)),
                "lock_waits":              lk_waits,
                "lock_time_ms":            lk_time,
                "lock_time_avg_ms":        round(lk_time / max(lk_waits, 1), 2),
                "table_locks_waited":      tbl_waited,
                "table_locks_immediate":   tbl_imm,
                "table_contention_pct":    round(tbl_waited / max(tbl_waited + tbl_imm, 1) * 100, 2),
                "lock_current_waits":      ti(status.get("Innodb_row_lock_current_waits", 0)),
            }

            # ── 6. SORT OPERATIONS ───────────────────────────────────
            sort_ops = {
                "rows":         ti(status.get("Sort_rows", 0)),
                "range":        ti(status.get("Sort_range", 0)),
                "scan":         ti(status.get("Sort_scan", 0)),
                "merge_passes": ti(status.get("Sort_merge_passes", 0)),
                "sort_buffer_size_kb": round(ti(variables.get("sort_buffer_size", 0)) / 1024, 0),
            }

            # ── 7. TEMP TABLES ───────────────────────────────────────
            tmp_mem  = ti(status.get("Created_tmp_tables", 0))
            tmp_disk = ti(status.get("Created_tmp_disk_tables", 0))
            tmp_ops  = {
                "in_memory":             tmp_mem,
                "on_disk":               tmp_disk,
                "total":                 tmp_mem + tmp_disk,
                "disk_pct":              round(tmp_disk / max(tmp_mem + tmp_disk, 1) * 100, 1),
                "disk_files":            ti(status.get("Created_tmp_files", 0)),
                "tmp_table_size_mb":     round(ti(variables.get("tmp_table_size", 0)) / 1048576, 1),
                "max_heap_table_size_mb":round(ti(variables.get("max_heap_table_size", 0)) / 1048576, 1),
            }

            # ── 8. CONNECTIONS ───────────────────────────────────────
            curr_conn = ti(status.get("Threads_connected", 0))
            max_conn  = ti(variables.get("max_connections", 151))
            conns     = ti(status.get("Connections", 1))
            thr_created = ti(status.get("Threads_created", 0))
            connections = {
                "current":              curr_conn,
                "max_connections":      max_conn,
                "usage_pct":            round(curr_conn / max(max_conn, 1) * 100, 1),
                "max_used":             ti(status.get("Max_used_connections", 0)),
                "aborted_clients":      ti(status.get("Aborted_clients", 0)),
                "aborted_connects":     ti(status.get("Aborted_connects", 0)),
                "total_created":        conns,
                "thread_cache_size":    ti(variables.get("thread_cache_size", 0)),
                "threads_cached":       ti(status.get("Threads_cached", 0)),
                "threads_created":      thr_created,
                "threads_running":      ti(status.get("Threads_running", 0)),
                "cache_hit_pct":        round((1 - thr_created / max(conns, 1)) * 100, 1),
                "errors_maxconn":       ti(status.get("Connection_errors_max_connections", 0)),
            }

            # ── 9. HANDLER STATS ─────────────────────────────────────
            handler_stats = {
                "read_first":    ti(status.get("Handler_read_first", 0)),
                "read_key":      ti(status.get("Handler_read_key", 0)),
                "read_next":     ti(status.get("Handler_read_next", 0)),
                "read_prev":     ti(status.get("Handler_read_prev", 0)),
                "read_rnd":      ti(status.get("Handler_read_rnd", 0)),
                "read_rnd_next": ti(status.get("Handler_read_rnd_next", 0)),
                "write":         ti(status.get("Handler_write", 0)),
                "update":        ti(status.get("Handler_update", 0)),
                "delete":        ti(status.get("Handler_delete", 0)),
                "commit":        ti(status.get("Handler_commit", 0)),
                "rollback":      ti(status.get("Handler_rollback", 0)),
                "savepoint":     ti(status.get("Handler_savepoint", 0)),
            }

            # ── 10. QUERY QUALITY ────────────────────────────────────
            questions   = ti(status.get("Questions", 0))
            slow_q      = ti(status.get("Slow_queries", 0))
            commits     = ti(status.get("Com_commit", 0))
            rollbacks   = ti(status.get("Com_rollback", 0))
            query_quality = {
                "questions":       questions,
                "qps":             round(questions / uptime, 2),
                "slow_queries":    slow_q,
                "slow_pct":        round(slow_q / max(questions, 1) * 100, 3),
                "com_select":      ti(status.get("Com_select", 0)),
                "com_insert":      ti(status.get("Com_insert", 0)),
                "com_update":      ti(status.get("Com_update", 0)),
                "com_delete":      ti(status.get("Com_delete", 0)),
                "full_joins":      ti(status.get("Select_full_join", 0)),
                "full_range_joins":ti(status.get("Select_full_range_join", 0)),
                "select_range":    ti(status.get("Select_range", 0)),
                "select_scan":     ti(status.get("Select_scan", 0)),
                "commits":         commits,
                "rollbacks":       rollbacks,
                "tps":             round((commits + rollbacks) / uptime, 2),
                "bytes_received":  ti(status.get("Bytes_received", 0)),
                "bytes_sent":      ti(status.get("Bytes_sent", 0)),
                "network_recv_kb_s": round(ti(status.get("Bytes_received", 0)) / uptime / 1024, 2),
                "network_send_kb_s": round(ti(status.get("Bytes_sent", 0)) / uptime / 1024, 2),
            }

            # ── 11. KEY CACHE (MyISAM) ───────────────────────────────
            kr_req = ti(status.get("Key_read_requests", 0))
            kr     = ti(status.get("Key_reads", 0))
            key_cache = {
                "blocks_unused":    ti(status.get("Key_blocks_unused", 0)),
                "blocks_used":      ti(status.get("Key_blocks_used", 0)),
                "read_requests":    kr_req,
                "reads":            kr,
                "hit_ratio":        round((1 - kr / max(kr_req, 1)) * 100, 2) if kr_req > 0 else 100.0,
                "write_requests":   ti(status.get("Key_write_requests", 0)),
                "writes":           ti(status.get("Key_writes", 0)),
                "buffer_size_mb":   round(ti(variables.get("key_buffer_size", 0)) / 1048576, 1),
            }

            # ── 12. SERVER CONFIG (key perf params) ──────────────────
            server_config = {
                "innodb_buffer_pool_size_mb":        round(ti(variables.get("innodb_buffer_pool_size", 0)) / 1048576, 1),
                "innodb_buffer_pool_instances":      variables.get("innodb_buffer_pool_instances", "1"),
                "innodb_log_file_size_mb":           round(ti(variables.get("innodb_log_file_size", 0)) / 1048576, 1),
                "innodb_flush_log_at_trx_commit":    variables.get("innodb_flush_log_at_trx_commit", "1"),
                "innodb_flush_method":               variables.get("innodb_flush_method", "fsync"),
                "innodb_io_capacity":                variables.get("innodb_io_capacity", "200"),
                "innodb_io_capacity_max":            variables.get("innodb_io_capacity_max", "2000"),
                "innodb_read_io_threads":            variables.get("innodb_read_io_threads", "4"),
                "innodb_write_io_threads":           variables.get("innodb_write_io_threads", "4"),
                "innodb_file_per_table":             variables.get("innodb_file_per_table", "ON"),
                "sort_buffer_size_kb":               round(ti(variables.get("sort_buffer_size", 0)) / 1024, 0),
                "join_buffer_size_kb":               round(ti(variables.get("join_buffer_size", 0)) / 1024, 0),
                "read_buffer_size_kb":               round(ti(variables.get("read_buffer_size", 0)) / 1024, 0),
                "read_rnd_buffer_size_kb":           round(ti(variables.get("read_rnd_buffer_size", 0)) / 1024, 0),
                "max_allowed_packet_mb":             round(ti(variables.get("max_allowed_packet", 0)) / 1048576, 0),
                "table_open_cache":                  variables.get("table_open_cache", "2000"),
                "open_files_limit":                  variables.get("open_files_limit", "5000"),
                "long_query_time":                   variables.get("long_query_time", "10"),
                "slow_query_log":                    variables.get("slow_query_log", "OFF"),
                "performance_schema":                variables.get("performance_schema", "OFF"),
                "query_cache_type":                  variables.get("query_cache_type", "OFF"),
                "max_connections":                   variables.get("max_connections", "151"),
                "thread_cache_size":                 variables.get("thread_cache_size", "9"),
                "wait_timeout":                      variables.get("wait_timeout", "28800"),
                "interactive_timeout":               variables.get("interactive_timeout", "28800"),
            }

            # ── 13. ACTIVE TRANSACTIONS ──────────────────────────────
            active_transactions = []
            try:
                trx_rows = conn.execute(text("""
                    SELECT t.trx_id, t.trx_state, t.trx_started,
                        TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS dur_sec,
                        COALESCE(t.trx_query,'') AS trx_query,
                        t.trx_rows_locked, t.trx_rows_modified,
                        COALESCE(p.USER,'') AS usr, COALESCE(p.HOST,'') AS hst,
                        t.trx_isolation_level
                    FROM information_schema.INNODB_TRX t
                    LEFT JOIN information_schema.PROCESSLIST p
                           ON p.ID = t.trx_mysql_thread_id
                    ORDER BY t.trx_started LIMIT 30
                """)).fetchall()
                for r in trx_rows:
                    active_transactions.append({
                        "trx_id":       str(r[0]),
                        "state":        str(r[1]),
                        "started":      str(r[2]) if r[2] else "",
                        "duration_sec": ti(r[3]),
                        "query":        str(r[4])[:300],
                        "rows_locked":  ti(r[5]),
                        "rows_modified":ti(r[6]),
                        "user":         str(r[7]),
                        "host":         str(r[8]),
                        "isolation":    str(r[9]) if r[9] else "",
                    })
            except Exception:
                pass

            # ── 14. LOCK WAITS ───────────────────────────────────────
            lock_waits_detail = []
            try:
                lw_rows = conn.execute(text("""
                    SELECT r.trx_id, COALESCE(r.trx_query,'') waiting_q,
                           COALESCE(p1.USER,'?') waiting_user,
                           b.trx_id, COALESCE(b.trx_query,'') blocking_q,
                           COALESCE(p2.USER,'?') blocking_user,
                           TIMESTAMPDIFF(SECOND, r.trx_started, NOW()) wait_sec
                    FROM performance_schema.data_lock_waits w
                    JOIN information_schema.INNODB_TRX b
                      ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
                    JOIN information_schema.INNODB_TRX r
                      ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
                    LEFT JOIN information_schema.PROCESSLIST p1
                      ON p1.ID = r.trx_mysql_thread_id
                    LEFT JOIN information_schema.PROCESSLIST p2
                      ON p2.ID = b.trx_mysql_thread_id
                    LIMIT 20
                """)).fetchall()
                for r in lw_rows:
                    lock_waits_detail.append({
                        "waiting_trx":    str(r[0]),
                        "waiting_query":  str(r[1])[:200],
                        "waiting_user":   str(r[2]),
                        "blocking_trx":   str(r[3]),
                        "blocking_query": str(r[4])[:200],
                        "blocking_user":  str(r[5]),
                        "wait_sec":       ti(r[6]),
                    })
            except Exception:
                try:
                    lw_rows = conn.execute(text("""
                        SELECT r.trx_id, COALESCE(r.trx_query,'') wq,
                               COALESCE(p1.USER,'?') wu,
                               b.trx_id, COALESCE(b.trx_query,'') bq,
                               COALESCE(p2.USER,'?') bu,
                               TIMESTAMPDIFF(SECOND, r.trx_started, NOW()) ws
                        FROM information_schema.INNODB_LOCK_WAITS w
                        JOIN information_schema.INNODB_TRX b ON b.trx_id=w.blocking_trx_id
                        JOIN information_schema.INNODB_TRX r ON r.trx_id=w.requesting_trx_id
                        LEFT JOIN information_schema.PROCESSLIST p1 ON p1.ID=r.trx_mysql_thread_id
                        LEFT JOIN information_schema.PROCESSLIST p2 ON p2.ID=b.trx_mysql_thread_id
                        LIMIT 20
                    """)).fetchall()
                    for r in lw_rows:
                        lock_waits_detail.append({
                            "waiting_trx":    str(r[0]), "waiting_query": str(r[1])[:200],
                            "waiting_user":   str(r[2]), "blocking_trx":  str(r[3]),
                            "blocking_query": str(r[4])[:200], "blocking_user": str(r[5]),
                            "wait_sec":       ti(r[6]),
                        })
                except Exception:
                    pass

            # ── 15. PERFORMANCE SCHEMA ───────────────────────────────
            ps_enabled = variables.get("performance_schema", "OFF").upper() == "ON"
            top_statements, wait_events, memory_consumers, table_io_stats = [], [], [], []

            if ps_enabled:
                # Top SQL by total latency
                try:
                    for r in conn.execute(text("""
                        SELECT SUBSTRING(DIGEST_TEXT,1,200) AS dtext,
                               COUNT_STAR,
                               ROUND(AVG_TIMER_WAIT/1e9,2)  AS avg_ms,
                               ROUND(MAX_TIMER_WAIT/1e9,2)  AS max_ms,
                               ROUND(SUM_TIMER_WAIT/1e9,2)  AS sum_ms,
                               ROUND(SUM_ROWS_EXAMINED/NULLIF(COUNT_STAR,0),1) AS rows_ex,
                               ROUND(SUM_ROWS_SENT/NULLIF(COUNT_STAR,0),1)     AS rows_sent,
                               SUM_NO_INDEX_USED        AS no_idx,
                               SUM_NO_GOOD_INDEX_USED   AS no_good_idx,
                               DATE_FORMAT(FIRST_SEEN,'%Y-%m-%d %H:%i') AS fs,
                               DATE_FORMAT(LAST_SEEN,'%Y-%m-%d %H:%i')  AS ls,
                               SUM_CREATED_TMP_DISK_TABLES AS tmp_disk,
                               SUM_SORT_ROWS              AS sort_rows
                        FROM performance_schema.events_statements_summary_by_digest
                        WHERE DIGEST_TEXT IS NOT NULL
                        ORDER BY SUM_TIMER_WAIT DESC LIMIT 30
                    """)).fetchall():
                        top_statements.append({
                            "digest_text":  str(r[0] or ""),
                            "count":        ti(r[1]),
                            "avg_ms":       tf(r[2]),
                            "max_ms":       tf(r[3]),
                            "sum_ms":       tf(r[4]),
                            "rows_examined":tf(r[5]),
                            "rows_sent":    tf(r[6]),
                            "no_index":     ti(r[7]),
                            "no_good_index":ti(r[8]),
                            "first_seen":   str(r[9] or ""),
                            "last_seen":    str(r[10] or ""),
                            "tmp_disk":     ti(r[11]),
                            "sort_rows":    ti(r[12]),
                        })
                except Exception:
                    pass

                # Wait events by total wait
                try:
                    for r in conn.execute(text("""
                        SELECT EVENT_NAME,
                               SUBSTRING_INDEX(EVENT_NAME,'/',2) AS wait_class,
                               COUNT_STAR,
                               ROUND(SUM_TIMER_WAIT/1e9,2)  AS total_ms,
                               ROUND(AVG_TIMER_WAIT/1e9,2)  AS avg_ms,
                               ROUND(MAX_TIMER_WAIT/1e9,2)  AS max_ms
                        FROM performance_schema.events_waits_summary_global_by_event_name
                        WHERE COUNT_STAR > 0 AND EVENT_NAME NOT LIKE '%idle%'
                        ORDER BY SUM_TIMER_WAIT DESC LIMIT 20
                    """)).fetchall():
                        wait_events.append({
                            "event_name": str(r[0] or ""),
                            "wait_class": str(r[1] or ""),
                            "count":      ti(r[2]),
                            "total_ms":   tf(r[3]),
                            "avg_ms":     tf(r[4]),
                            "max_ms":     tf(r[5]),
                        })
                except Exception:
                    pass

                # Memory consumers
                try:
                    for r in conn.execute(text("""
                        SELECT EVENT_NAME,
                               ROUND(CURRENT_NUMBER_OF_BYTES_USED/1048576,3) AS cur_mb,
                               ROUND(HIGH_NUMBER_OF_BYTES_USED/1048576,3)    AS hi_mb,
                               CURRENT_COUNT_USED
                        FROM performance_schema.memory_summary_global_by_event_name
                        WHERE CURRENT_NUMBER_OF_BYTES_USED > 0
                        ORDER BY CURRENT_NUMBER_OF_BYTES_USED DESC LIMIT 20
                    """)).fetchall():
                        memory_consumers.append({
                            "event_name":   str(r[0] or ""),
                            "current_mb":   tf(r[1]),
                            "high_mb":      tf(r[2]),
                            "count_used":   ti(r[3]),
                        })
                except Exception:
                    pass

                # Table I/O wait stats
                try:
                    for r in conn.execute(text("""
                        SELECT OBJECT_SCHEMA, OBJECT_NAME,
                               COUNT_FETCH, COUNT_INSERT, COUNT_UPDATE, COUNT_DELETE,
                               ROUND(SUM_TIMER_WAIT/1e9,2)  AS total_ms,
                               ROUND(AVG_TIMER_WAIT/1e9,2)  AS avg_ms,
                               ROUND(SUM_TIMER_FETCH/1e9,2) AS fetch_ms,
                               ROUND(SUM_TIMER_INSERT/1e9,2)AS insert_ms,
                               ROUND(SUM_TIMER_UPDATE/1e9,2)AS update_ms,
                               ROUND(SUM_TIMER_DELETE/1e9,2)AS delete_ms
                        FROM performance_schema.table_io_waits_summary_by_table
                        WHERE OBJECT_SCHEMA NOT IN
                              ('mysql','information_schema','performance_schema','sys')
                          AND COUNT_STAR > 0
                        ORDER BY SUM_TIMER_WAIT DESC LIMIT 25
                    """)).fetchall():
                        table_io_stats.append({
                            "schema":    str(r[0] or ""),
                            "table":     str(r[1] or ""),
                            "fetch":     ti(r[2]),
                            "insert":    ti(r[3]),
                            "update":    ti(r[4]),
                            "delete":    ti(r[5]),
                            "total_ms":  tf(r[6]),
                            "avg_ms":    tf(r[7]),
                            "fetch_ms":  tf(r[8]),
                            "insert_ms": tf(r[9]),
                            "update_ms": tf(r[10]),
                            "delete_ms": tf(r[11]),
                        })
                except Exception:
                    pass

            return {
                "status":             "success",
                "uptime":             uptime,
                "ps_enabled":         ps_enabled,
                "buffer_pool":        buffer_pool,
                "row_ops":            row_ops,
                "innodb_io":          innodb_io,
                "locking":            locking,
                "sort_ops":           sort_ops,
                "tmp_tables":         tmp_ops,
                "connections":        connections,
                "handler_stats":      handler_stats,
                "query_quality":      query_quality,
                "key_cache":          key_cache,
                "server_config":      server_config,
                "active_transactions":active_transactions,
                "lock_waits":         lock_waits_detail,
                "top_statements":     top_statements,
                "wait_events":        wait_events,
                "memory_consumers":   memory_consumers,
                "table_io_stats":     table_io_stats,
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))