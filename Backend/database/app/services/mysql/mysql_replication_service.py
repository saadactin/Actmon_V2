from urllib.parse import quote_plus
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster


# ── DB helpers ────────────────────────────────────────────────────────────────

def _engine(conn: ConnectionMaster):
    pw  = quote_plus(conn.password or "")
    usr = quote_plus(conn.username or "")
    url = (
        f"mysql+pymysql://{usr}:{pw}"
        f"@{conn.host}:{conn.port or 3306}/{conn.database_name or ''}"
    )
    return create_engine(
        url,
        connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30},
        poolclass=NullPool,
    )


def _rows(engine, sql: str) -> list:
    with engine.connect() as c:
        res  = c.execute(text(sql))
        cols = list(res.keys())
        return [dict(zip(cols, row)) for row in res.fetchall()]


def _scalar(engine, sql: str):
    try:
        with engine.connect() as c:
            return c.execute(text(sql)).scalar()
    except Exception:
        return None


def _show_variables_like(engine, pattern: str) -> dict:
    try:
        rows = _rows(engine, f"SHOW GLOBAL VARIABLES LIKE '{pattern}'")
        return {r["Variable_name"]: r["Value"] for r in rows}
    except Exception:
        return {}


def _show_status_like(engine, pattern: str) -> dict:
    try:
        rows = _rows(engine, f"SHOW GLOBAL STATUS LIKE '{pattern}'")
        return {r["Variable_name"]: r["Value"] for r in rows}
    except Exception:
        return {}


def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, "Connection not found")
    return rec


# ── Pure logic helpers ────────────────────────────────────────────────────────

def _lag_human(secs) -> str:
    try:
        s = int(secs)
    except (TypeError, ValueError):
        return "N/A"
    if s < 0:
        return "N/A"
    if s == 0:
        return "In sync"
    if s < 60:
        return f"{s}s behind"
    if s < 3600:
        return f"{s // 60}m {s % 60}s behind"
    return f"{s // 3600}h {(s % 3600) // 60}m behind"


def _compute_health(r: dict):
    issues, ok = [], []

    if r["is_galera"]:
        g = r["galera"] or {}
        if g.get("cluster_status") == "Primary":
            ok.append("Galera cluster status: Primary")
        else:
            issues.append(f"⚠ Galera cluster status: {g.get('cluster_status', '?')}")

        if str(g.get("connected", "OFF")).upper() == "ON":
            ok.append("Galera node connected")
        else:
            issues.append("✗ Galera node NOT connected")

        if str(g.get("ready", "OFF")).upper() == "ON":
            ok.append("Galera node ready")
        else:
            issues.append("✗ Galera node NOT ready")

        local_state = g.get("local_state_comment", "?")
        if local_state == "Synced":
            ok.append("Node state: Synced")
        else:
            issues.append(f"⚠ Node state: {local_state}")

        try:
            if float(g.get("local_recv_queue", 0)) > 10:
                issues.append(f"⚠ High receive queue: {g['local_recv_queue']}")
        except Exception:
            pass

        try:
            fc = float(g.get("flow_control_paused", 0))
            if fc > 0.1:
                issues.append(f"⚠ Flow control active: {fc:.2%} of time paused")
        except Exception:
            pass

    if r["is_slave"]:
        ss  = r["slave_status"] or {}
        io  = str(ss.get("io_running",  "No")).strip()
        sql = str(ss.get("sql_running", "No")).strip()

        if io.lower() == "yes":
            ok.append("IO thread running")
        else:
            issues.append(f"✗ IO thread not running ({io})")

        if sql.lower() == "yes":
            ok.append("SQL thread running")
        else:
            issues.append(f"✗ SQL thread not running ({sql})")

        lag = ss.get("seconds_behind_master")
        try:
            lag_int = int(lag)
            if lag_int == 0:
                ok.append("Replication lag: 0s (in sync)")
            elif lag_int < 30:
                ok.append(f"Replication lag: {lag_int}s (acceptable)")
            elif lag_int < 300:
                issues.append(f"⚠ Replication lag: {lag_int}s")
            else:
                issues.append(f"✗ High replication lag: {lag_int}s")
        except (TypeError, ValueError):
            pass

        for key, label in [
            ("last_error",     "Error"),
            ("last_io_error",  "IO error"),
            ("last_sql_error", "SQL error"),
        ]:
            if ss.get(key):
                issues.append(f"✗ {label}: {ss[key]}")

    if not r["is_slave"] and not r["is_galera"] and r["is_master"]:
        ok.append("Standalone master — no replicas connected")
    if not r["is_master"] and not r["is_slave"] and not r["is_galera"]:
        ok.append("Standalone server — no replication configured")

    health = "critical" if any("✗" in i for i in issues) else ("warning" if issues else "healthy")
    return health, ok + issues


# ── Service functions (called by route handlers) ──────────────────────────────

def get_replication_status(conn_id: int, db: Session, live: bool = False) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    if not live:
        cached = _get_snap(conn_id, "mysql_replication_status", db)
        if cached is not None:
            return cached

    conn = _get_conn(conn_id, db)
    result = {
        "status":        "success",
        "is_master":     False,
        "is_slave":      False,
        "is_galera":     False,
        "master_status": None,
        "slave_status":  None,
        "galera":        None,
        "server_info":   {},
        "gtid":          {},
        "health":        "unknown",
        "health_detail": [],
        "errors":        {},
    }

    try:
        engine = _engine(conn)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    # server info
    try:
        sv = _show_variables_like(engine, "version%")
        sv.update(_show_variables_like(engine, "server_id"))
        sv.update(_show_variables_like(engine, "hostname"))
        result["server_info"] = {
            "version":         sv.get("version", "—"),
            "version_comment": sv.get("version_comment", "—"),
            "server_id":       sv.get("server_id", "—"),
            "hostname":        sv.get("hostname", "—"),
        }
    except Exception as e:
        result["errors"]["server_info"] = str(e)

    # master status
    try:
        ms_rows = _rows(engine, "SHOW MASTER STATUS")
        if ms_rows:
            ms = ms_rows[0]
            result["is_master"]     = True
            result["master_status"] = {
                "file":              ms.get("File") or ms.get("file"),
                "position":          ms.get("Position") or ms.get("position"),
                "binlog_do_db":      ms.get("Binlog_Do_DB", ""),
                "binlog_ignore_db":  ms.get("Binlog_Ignore_DB", ""),
                "executed_gtid_set": ms.get("Executed_Gtid_Set", ""),
            }
    except Exception as e:
        result["errors"]["master_status"] = str(e)

    # slave / replica status
    slave_raw = None
    for cmd in ("SHOW SLAVE STATUS", "SHOW REPLICA STATUS"):
        try:
            rows = _rows(engine, cmd)
            if rows:
                slave_raw = rows[0]
                break
        except Exception:
            continue

    if slave_raw:
        result["is_slave"] = True

        def _v(key, *aliases):
            for k in (key, *aliases):
                if k in slave_raw:
                    return slave_raw[k]
            return None

        io_running   = str(_v("Slave_IO_Running",  "Replica_IO_Running")  or "No").strip()
        sql_running  = str(_v("Slave_SQL_Running", "Replica_SQL_Running") or "No").strip()
        lag_secs     = _v("Seconds_Behind_Master", "Seconds_Behind_Source")

        result["slave_status"] = {
            "io_running":            io_running,
            "sql_running":           sql_running,
            "seconds_behind_master": lag_secs,
            "lag_human":             _lag_human(lag_secs),
            "master_host":           _v("Master_Host", "Source_Host", "Master_host"),
            "master_port":           _v("Master_Port", "Source_Port"),
            "master_user":           _v("Master_User", "Source_User"),
            "master_log_file":       _v("Master_Log_File",  "Source_Log_File"),
            "read_master_log_pos":   _v("Read_Master_Log_Pos",  "Read_Source_Log_Pos"),
            "relay_log_file":        _v("Relay_Log_File"),
            "relay_log_pos":         _v("Relay_Log_Pos"),
            "relay_master_log_file": _v("Relay_Master_Log_File", "Relay_Source_Log_File"),
            "exec_master_log_pos":   _v("Exec_Master_Log_Pos",   "Exec_Source_Log_Pos"),
            "replicate_do_db":       _v("Replicate_Do_DB", ""),
            "replicate_ignore_db":   _v("Replicate_Ignore_DB", ""),
            "skip_counter":          _v("Skip_Counter"),
            "retrieved_gtid_set":    _v("Retrieved_Gtid_Set", ""),
            "executed_gtid_set":     _v("Executed_Gtid_Set", ""),
            "using_gtid":            _v("Using_Gtid", ""),
            "last_error":            _v("Last_Error", "Last_Errno") or "",
            "last_io_error":         _v("Last_IO_Error", "Last_IO_Errno") or "",
            "last_sql_error":        _v("Last_SQL_Error", "Last_SQL_Errno") or "",
            "auto_position":         _v("Auto_Position"),
        }
    else:
        result["errors"]["slave_status"] = "No slave / replica found (or REPLICATION CLIENT privilege needed)"

    # Galera / wsrep
    wsrep = _show_status_like(engine, "wsrep%")
    if wsrep and wsrep.get("wsrep_on") != "OFF":
        result["is_galera"] = True
        result["galera"] = {
            "cluster_name":         wsrep.get("wsrep_cluster_name", "—"),
            "cluster_status":       wsrep.get("wsrep_cluster_status", "—"),
            "cluster_size":         wsrep.get("wsrep_cluster_size", "—"),
            "cluster_state_uuid":   wsrep.get("wsrep_cluster_state_uuid", "—"),
            "node_name":            wsrep.get("wsrep_node_name", "—"),
            "node_address":         wsrep.get("wsrep_node_address", "—"),
            "local_state":          wsrep.get("wsrep_local_state", "—"),
            "local_state_comment":  wsrep.get("wsrep_local_state_comment", "—"),
            "connected":            wsrep.get("wsrep_connected", "OFF"),
            "ready":                wsrep.get("wsrep_ready", "OFF"),
            "received":             wsrep.get("wsrep_received", "0"),
            "received_bytes":       wsrep.get("wsrep_received_bytes", "0"),
            "replicated":           wsrep.get("wsrep_replicated", "0"),
            "replicated_bytes":     wsrep.get("wsrep_replicated_bytes", "0"),
            "cert_deps_distance":   wsrep.get("wsrep_cert_deps_distance", "—"),
            "apply_oooe":           wsrep.get("wsrep_apply_oooe", "—"),
            "flow_control_paused":  wsrep.get("wsrep_flow_control_paused", "0"),
            "flow_control_sent":    wsrep.get("wsrep_flow_control_sent", "0"),
            "flow_control_recv":    wsrep.get("wsrep_flow_control_recv", "0"),
            "local_recv_queue":     wsrep.get("wsrep_local_recv_queue", "0"),
            "local_recv_queue_avg": wsrep.get("wsrep_local_recv_queue_avg", "0"),
            "local_send_queue":     wsrep.get("wsrep_local_send_queue", "0"),
            "local_send_queue_avg": wsrep.get("wsrep_local_send_queue_avg", "0"),
            "commit_window":        wsrep.get("wsrep_commit_window", "—"),
            "causal_reads":         wsrep.get("wsrep_causal_reads", "0"),
            "cert_failures":        wsrep.get("wsrep_local_cert_failures", "0"),
            "bf_aborts":            wsrep.get("wsrep_local_bf_aborts", "0"),
            "protocol_version":     wsrep.get("wsrep_protocol_version", "—"),
            "provider_name":        wsrep.get("wsrep_provider_name", "—"),
            "provider_version":     wsrep.get("wsrep_provider_version", "—"),
            "provider_vendor":      wsrep.get("wsrep_provider_vendor", "—"),
        }

    # GTID
    gtid_vars = _show_variables_like(engine, "gtid%")
    result["gtid"] = {
        "gtid_mode":        gtid_vars.get("gtid_mode", "—"),
        "gtid_binlog_pos":  _scalar(engine, "SELECT @@gtid_binlog_pos") or gtid_vars.get("gtid_binlog_pos", "—"),
        "gtid_slave_pos":   _scalar(engine, "SELECT @@gtid_slave_pos")  or "—",
        "gtid_current_pos": _scalar(engine, "SELECT @@gtid_current_pos") or "—",
        "gtid_strict_mode": gtid_vars.get("gtid_strict_mode", "—"),
        "gtid_domain_id":   _scalar(engine, "SELECT @@gtid_domain_id") or "—",
    }

    health, details = _compute_health(result)
    result["health"]        = health
    result["health_detail"] = details

    return result


def get_replication_variables(conn_id: int, db: Session, live: bool = False) -> dict:
    from app.utils.agent_cache import get_snapshot as _get_snap
    if not live:
        cached = _get_snap(conn_id, "mysql_replication_variables", db)
        if cached is not None:
            return cached

    conn = _get_conn(conn_id, db)
    try:
        engine = _engine(conn)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    PATTERNS = [
        "server_id", "log_bin%", "binlog%", "relay_log%",
        "sync_binlog", "innodb_flush_log_at_trx_commit",
        "slave%", "replica%", "gtid%", "rpl%",
        "expire_logs_days", "max_binlog_size", "innodb_support_xa",
        "auto_increment%", "read_only", "super_read_only",
        "wsrep%",
    ]
    merged = {}
    for p in PATTERNS:
        merged.update(_show_variables_like(engine, p))

    categories = {
        "Identity":      {k: v for k, v in merged.items() if k in ("server_id", "hostname")},
        "Binary Log":    {k: v for k, v in merged.items() if "log_bin" in k or "binlog" in k or k == "sync_binlog"},
        "Relay Log":     {k: v for k, v in merged.items() if "relay_log" in k},
        "GTID":          {k: v for k, v in merged.items() if "gtid" in k},
        "Slave/Replica": {k: v for k, v in merged.items() if "slave" in k or "replica" in k},
        "InnoDB Sync":   {k: v for k, v in merged.items() if "innodb_flush" in k or "innodb_support" in k},
        "Galera/wsrep":  {k: v for k, v in merged.items() if "wsrep" in k},
        "Misc":          {k: v for k, v in merged.items() if k in (
            "read_only", "super_read_only", "expire_logs_days", "max_binlog_size"
        ) or "auto_increment" in k},
    }

    return {"status": "success", "variables": merged, "categories": categories,
            "total_count": len(merged)}
