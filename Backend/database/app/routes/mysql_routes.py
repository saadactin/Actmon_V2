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