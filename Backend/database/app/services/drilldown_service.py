"""
Generic SolarWinds-style resource drill-down for ALL database engines.

Host side (CPU/RAM/Disk gauges → process explorer → RCA report → history) is
identical for every technology — it's pure SSH/OS introspection — so it's shared.
Only two things vary per engine and live in TECH below:
  • proc_names  — which OS process IS the database (for the DB/external split)
  • engine + sessions SQL — how to read the live active queries

Reuses the proven PostgreSQL helpers (SSH, severity, Groq narrative, etc.).
"""
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.postgres import postgres_drilldown_service as pg

# shared engine-agnostic helpers
_run = pg._run
_num = pg._num
_res_to_mb = pg._res_to_mb
_ssh_connect = pg._ssh_connect
_severity = pg._severity
_rca_title = pg._rca_title
_groq_rca = pg._groq_rca


# ──────────────────────────────────────────────────────────────────────────────
# Per-engine configuration
# ──────────────────────────────────────────────────────────────────────────────

def _mysql_engine(conn):
    from app.services.mysql.mysql_dashboard_service import _engine
    return _engine(conn)

def _oracle_engine(conn):
    from app.services.oracle.oracle_monitoring_service import _oracle_engine
    return _oracle_engine(conn)

def _mssql_engine(conn):
    from app.services.mssql.mssql_monitoring_service import _mssql_engine
    return _mssql_engine(conn)

def _ch_engine(conn):
    from app.services.clickhouse.clickhouse_monitoring_service import _ch_engine
    return _ch_engine(conn)


# active-session SQL → normalized columns:
# pid, usename, datname, client_addr, state, wait_event_type, wait_event, query_seconds, query
_SQL = {
    # Every query EXCLUDES ActMon's own monitoring session — otherwise the list
    # shows the drill-down's own SELECT, which is gone by the time it's clicked
    # ("Session no longer active").
    "mysql": """
        SELECT ID AS pid, USER AS usename, DB AS datname, HOST AS client_addr,
               COMMAND AS state, '' AS wait_event_type, STATE AS wait_event,
               TIME AS query_seconds, INFO AS query
        FROM information_schema.PROCESSLIST
        WHERE INFO IS NOT NULL AND COMMAND <> 'Sleep' AND ID <> CONNECTION_ID()
        ORDER BY TIME DESC LIMIT 50""",
    "mssql": """
        SELECT r.session_id AS pid, s.login_name AS usename, DB_NAME(r.database_id) AS datname,
               s.host_name AS client_addr, r.status AS state, r.wait_type AS wait_event_type,
               r.wait_resource AS wait_event, r.total_elapsed_time/1000 AS query_seconds,
               SUBSTRING(t.text, 1, 2000) AS query
        FROM sys.dm_exec_requests r
        JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
        CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE r.session_id > 50 AND r.session_id <> @@SPID
        ORDER BY r.total_elapsed_time DESC""",
    "oracle": """
        SELECT * FROM (
          SELECT s.sid AS pid, s.username AS usename, s.schemaname AS datname,
                 s.machine AS client_addr, s.status AS state, s.wait_class AS wait_event_type,
                 s.event AS wait_event, s.last_call_et AS query_seconds, q.sql_text AS query
          FROM v$session s LEFT JOIN v$sql q ON s.sql_id = q.sql_id
          WHERE s.type = 'USER' AND s.username IS NOT NULL
            AND s.audsid <> USERENV('SESSIONID')
          ORDER BY s.last_call_et DESC
        ) WHERE ROWNUM <= 50""",
    "clickhouse": """
        SELECT query_id AS pid, user AS usename, current_database AS datname,
               toString(address) AS client_addr, 'active' AS state,
               '' AS wait_event_type, '' AS wait_event, elapsed AS query_seconds, query
        FROM system.processes
        WHERE query <> '' AND query_id <> queryID()
        ORDER BY elapsed DESC LIMIT 50""",
}

TECH = {
    "postgresql": {"db_types": ["postgresql"], "procs": ("postgres",), "engine": pg._pg_engine},
    "mysql": {"db_types": ["mysql", "mariadb"], "procs": ("mysqld", "mariadbd", "mysql"), "engine": _mysql_engine, "sql": _SQL["mysql"]},
    "oracle": {"db_types": ["oracle"], "procs": ("oracle", "ora_", "tnslsnr"), "engine": _oracle_engine, "sql": _SQL["oracle"]},
    "mssql": {"db_types": ["mssql"], "procs": ("sqlservr",), "engine": _mssql_engine, "sql": _SQL["mssql"]},
    "clickhouse": {"db_types": ["clickhouse"], "procs": ("clickhouse",), "engine": _ch_engine, "sql": _SQL["clickhouse"]},
    "mongodb": {"db_types": ["mongodb"], "procs": ("mongod",), "engine": None},
}


def _cfg(tech: str) -> dict:
    cfg = TECH.get((tech or "").lower())
    if not cfg:
        raise HTTPException(status_code=400, detail=f"Unsupported technology: {tech}")
    return cfg


def _get_conn(conn_id: int, db: Session, tech: str):
    cfg = _cfg(tech)
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id,
        ConnectionMaster.db_type.in_(cfg["db_types"]),
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail=f"{tech} connection not found")
    return conn


def _is_db_proc(cmd: str, procs) -> bool:
    c = (cmd or "").lower()
    return any(p in c for p in procs)


# ──────────────────────────────────────────────────────────────────────────────
# Host side (engine-agnostic)
# ──────────────────────────────────────────────────────────────────────────────

def _collect(ssh, cores, procs):
    cores = max(cores or 1, 1)
    raw = _run(ssh, "top -bn2 -d 0.6 -w 512 | awk 'BEGIN{p=0} /^[[:space:]]*PID/{p++} {if(p==2)print}'")
    rows = []
    for line in raw.splitlines():
        parts = line.split(None, 11)
        if len(parts) < 12 or not parts[0].isdigit():
            continue
        cmd = parts[11].strip()
        if cmd in ("top", "(top)"):
            continue
        pcpu = _num(parts[8]) or 0.0
        rows.append({
            "pid": int(parts[0]), "user": parts[1],
            "cpu_pct": round(min(pcpu / cores, 100.0), 1),
            "mem_pct": _num(parts[9]), "rss_mb": _res_to_mb(parts[5]),
            "command": cmd, "cmdline": cmd, "is_db": _is_db_proc(cmd, procs),
        })
    return rows


def _is_local_host(host) -> bool:
    """True when the DB host is the same machine the backend runs on — then we can read the
    real host CPU/RAM/processes directly with psutil instead of needing SSH (Linux) or DMVs."""
    if not host:
        return False
    h = str(host).strip().lower()
    if h in ("localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"):
        return True
    try:
        import socket
        names = {socket.gethostname().lower(), socket.getfqdn().lower()}
        if h in names:
            return True
        host_ip = socket.gethostbyname(h)
        if host_ip.startswith("127."):
            return True
        local_ips = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None)}
        if host_ip in local_ips:
            return True
    except Exception:
        pass
    return False


_DB_PROC_KEYS = ("mysqld", "mariadb", "postgres", "sqlservr", "oracle", "ora_", "mongod", "clickhouse")


def _agent_processes(conn_id: int, db, sort: str = "cpu", limit: int = 25) -> dict | None:
    """Top processes from the ActMon agent's last snapshot (no SSH needed)."""
    import json
    from app.models.os_server_model import OsServer, DatabaseInstance
    inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == conn_id).first()
    if not inst:
        return None
    server = db.query(OsServer).filter(
        OsServer.id == inst.server_id, OsServer.collector == "agent").first()
    if not server or not server.last_infra_json:
        return None
    try:
        d = json.loads(server.last_infra_json)
    except Exception:
        return None
    rows = []
    for p in (d.get("processes") or []):
        cmd = str(p.get("command") or "")
        rows.append({
            "pid": str(p.get("pid") or ""), "user": p.get("user") or "",
            "cpu_pct": float(p.get("cpu") or 0), "mem_pct": float(p.get("mem") or 0),
            "command": cmd, "is_db": any(k in cmd.lower() for k in _DB_PROC_KEYS),
        })
    key = "mem_pct" if sort == "mem" else "cpu_pct"
    rows.sort(key=lambda r: r.get(key) or 0, reverse=True)
    rows = rows[: int(limit)]
    return {
        "processes": rows, "sort": sort, "cpu_cores": None,
        "system_cpu_pct": d.get("cpu_pct"),
        "db_cpu_pct": round(sum(r["cpu_pct"] for r in rows if r["is_db"]), 1),
        "source": "agent",
    }


def _agent_host_metrics(conn_id: int, db) -> dict | None:
    """Host CPU/RAM/Disk from the ActMon agent's last pushed snapshot (for hosts
    monitored via agent, where SSH isn't configured and the DB may be remote)."""
    import json
    from app.models.os_server_model import OsServer, DatabaseInstance
    inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == conn_id).first()
    if not inst:
        return None
    server = db.query(OsServer).filter(
        OsServer.id == inst.server_id, OsServer.collector == "agent").first()
    if not server or not server.last_infra_json:
        return None
    try:
        d = json.loads(server.last_infra_json)
    except Exception:
        return None
    mem = d.get("memory") or {}
    fs = d.get("filesystems") or []
    disk = max((f.get("use_pct", 0) for f in fs), default=None)
    load = d.get("load") or {}
    load_avg = None
    if isinstance(load, dict) and load.get("one") is not None:
        load_avg = f"{load.get('one')} {load.get('five')} {load.get('fifteen')}"
    return {
        "source": "agent",
        "cpu_pct": d.get("cpu_pct"),
        "ram_pct": mem.get("used_pct"),
        "ram_used_mb": mem.get("used_mb"),
        "ram_total_mb": mem.get("total_mb"),
        "disk_pct": disk,
        "load_avg": load_avg,
        "cpu_cores": None,
    }


def _local_host_metrics() -> dict | None:
    """Host CPU/RAM/Disk of THIS machine via psutil (DB is on localhost → same box)."""
    try:
        import psutil, os as _os
    except Exception:
        return None
    out = {"source": "psutil-local", "cpu_pct": None, "ram_pct": None, "disk_pct": None,
           "cpu_cores": None, "ram_used_mb": None, "ram_total_mb": None, "load_avg": None}
    try:
        out["cpu_pct"] = round(psutil.cpu_percent(interval=0.4), 1)
        out["cpu_cores"] = psutil.cpu_count()
    except Exception:
        pass
    try:
        vm = psutil.virtual_memory()
        out["ram_total_mb"] = round(vm.total / 1048576, 1)
        out["ram_used_mb"] = round((vm.total - vm.available) / 1048576, 1)
        out["ram_pct"] = round(vm.percent, 1)
    except Exception:
        pass
    try:
        path = "C:\\" if _os.name == "nt" else "/"
        out["disk_pct"] = round(psutil.disk_usage(path).percent, 1)
    except Exception:
        pass
    try:
        if hasattr(_os, "getloadavg"):
            la = _os.getloadavg()
            out["load_avg"] = f"{la[0]:.2f} {la[1]:.2f} {la[2]:.2f}"
    except Exception:
        pass
    return out if (out["cpu_pct"] is not None or out["ram_pct"] is not None) else None


def _local_processes(procs, sort: str = "cpu", limit: int = 25) -> dict | None:
    """Top processes of THIS machine via psutil — matches the SSH _collect row shape."""
    try:
        import psutil
    except Exception:
        return None
    ncores = max(psutil.cpu_count() or 1, 1)
    plist = list(psutil.process_iter(["pid", "name", "username", "memory_info", "memory_percent"]))
    for p in plist:                       # prime cpu_percent (first call returns 0.0)
        try:
            p.cpu_percent()
        except Exception:
            pass
    host_cpu = psutil.cpu_percent(interval=0.6)   # true host CPU over the sample window
    rows = []
    for p in plist:
        try:
            info = p.info
            name = info.get("name") or ""
            pid = info.get("pid")
            # Windows "System Idle Process" (PID 0) is IDLE time, not usage — never a consumer.
            if pid == 0 or name.lower() in ("system idle process", "idle"):
                continue
            cpu = (p.cpu_percent() or 0.0) / ncores         # normalise to % of whole host
            mem_pct = info.get("memory_percent") or 0.0
            rss = info.get("memory_info").rss if info.get("memory_info") else 0
            rows.append({
                "pid": info.get("pid"), "user": info.get("username") or "",
                "cpu_pct": round(min(cpu, 100.0), 1),
                "mem_pct": round(mem_pct, 1), "rss_mb": round(rss / 1048576, 1),
                "command": name, "cmdline": name, "is_db": _is_db_proc(name, procs),
            })
        except Exception:
            continue
    key = "mem_pct" if sort == "mem" else "cpu_pct"
    rows.sort(key=lambda r: r.get(key) or 0, reverse=True)
    rows = [r for r in rows if (r["cpu_pct"] or r["mem_pct"])][: int(limit)]
    return {
        "processes": rows, "sort": sort, "cpu_cores": ncores,
        "system_cpu_pct": round(host_cpu, 1),                       # true OS host CPU
        "db_cpu_pct": round(sum((r["cpu_pct"] or 0) for r in rows if r["is_db"]), 1),
        "source": "psutil-local",
    }


def _mssql_host_metrics(conn) -> dict:
    """SQL Server runs on Windows (no Linux SSH), so read host CPU/RAM/Disk from DMVs."""
    eng = _mssql_engine(conn)
    out = {"cpu_pct": None, "ram_pct": None, "disk_pct": None, "cpu_cores": None,
           "ram_used_mb": None, "ram_total_mb": None, "source": "sql-dmv"}
    with eng.connect() as c:
        try:
            r = c.execute(text("""
                SELECT TOP 1 100 - record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int') AS cpu
                FROM (SELECT TOP 1 CONVERT(XML, record) AS record FROM sys.dm_os_ring_buffers
                      WHERE ring_buffer_type=N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE '%<SystemHealth>%'
                      ORDER BY timestamp DESC) x""")).first()
            if r and r[0] is not None:
                out["cpu_pct"] = max(min(int(r[0]), 100), 0)
        except Exception:
            pass
        try:
            r = c.execute(text("SELECT total_physical_memory_kb, available_physical_memory_kb FROM sys.dm_os_sys_memory")).first()
            if r and r[0]:
                tot, avail = float(r[0]) / 1024.0, float(r[1] or 0) / 1024.0
                out["ram_total_mb"] = round(tot, 1)
                out["ram_used_mb"] = round(tot - avail, 1)
                out["ram_pct"] = round((tot - avail) / tot * 100, 1)
        except Exception:
            pass
        try:
            r = c.execute(text("SELECT cpu_count FROM sys.dm_os_sys_info")).first()
            if r:
                out["cpu_cores"] = int(r[0])
        except Exception:
            pass
        try:  # busiest data/log volume usage %
            r = c.execute(text("""
                SELECT TOP 1 CAST(100.0*(vs.total_bytes - vs.available_bytes)/NULLIF(vs.total_bytes,0) AS DECIMAL(5,1)) AS pct
                FROM sys.master_files mf CROSS APPLY sys.dm_os_volume_stats(mf.database_id, mf.file_id) vs
                GROUP BY vs.volume_mount_point, vs.total_bytes, vs.available_bytes
                ORDER BY pct DESC""")).first()
            if r and r[0] is not None:
                out["disk_pct"] = float(r[0])
        except Exception:
            pass
    return out


def _oracle_host_metrics(conn) -> dict:
    """Oracle exposes host CPU/cores/RAM via v$osstat & v$sysmetric — no SSH required."""
    eng = _oracle_engine(conn)
    out = {"cpu_pct": None, "ram_pct": None, "disk_pct": None, "cpu_cores": None,
           "ram_used_mb": None, "ram_total_mb": None, "load_avg": None, "source": "oracle-v$views"}
    with eng.connect() as c:
        # host CPU utilisation % — the 60-second metric window (group_id=2)
        try:
            r = c.execute(text(
                "SELECT ROUND(value,1) FROM v$sysmetric "
                "WHERE metric_name='Host CPU Utilization (%)' AND group_id=2 "
                "AND rownum=1 ORDER BY end_time DESC")).first()
            if r and r[0] is not None:
                out["cpu_pct"] = max(min(float(r[0]), 100.0), 0.0)
        except Exception:
            pass
        # v$sysmetric is often empty (XE) — derive a live % from v$osstat busy/idle delta
        if not out["cpu_pct"]:
            try:
                import time as _t

                def _bi():
                    rs = c.execute(text("SELECT stat_name, value FROM v$osstat "
                                        "WHERE stat_name IN ('BUSY_TIME','IDLE_TIME')")).all()
                    m = {str(x[0]): float(x[1] or 0) for x in rs}
                    return m.get("BUSY_TIME", 0.0), m.get("IDLE_TIME", 0.0)

                b1, i1 = _bi(); _t.sleep(0.7); b2, i2 = _bi()
                dt = (b2 - b1) + (i2 - i1)
                if dt > 0:
                    out["cpu_pct"] = round((b2 - b1) / dt * 100, 1)
                elif (b1 + i1) > 0:
                    out["cpu_pct"] = round(b1 / (b1 + i1) * 100, 1)
            except Exception:
                pass
        # cores + physical memory from v$osstat (one round trip)
        try:
            rows = c.execute(text(
                "SELECT stat_name, value FROM v$osstat "
                "WHERE stat_name IN ('NUM_CPUS','NUM_CPU_CORES','PHYSICAL_MEMORY_BYTES','FREE_MEMORY_BYTES')")).all()
            os_map = {str(rw[0]): float(rw[1] or 0) for rw in rows}
            cores = os_map.get("NUM_CPU_CORES") or os_map.get("NUM_CPUS")
            if cores:
                out["cpu_cores"] = int(cores)
            phys = os_map.get("PHYSICAL_MEMORY_BYTES")
            free = os_map.get("FREE_MEMORY_BYTES")
            if phys:
                tot = phys / 1048576.0
                out["ram_total_mb"] = round(tot, 1)
                if free is not None and free > 0:
                    used = (phys - free) / 1048576.0
                    out["ram_used_mb"] = round(used, 1)
                    out["ram_pct"] = round(used / tot * 100, 1)
        except Exception:
            pass
        # fall back to cpu_count parameter for cores
        if out["cpu_cores"] is None:
            try:
                r = c.execute(text("SELECT value FROM v$parameter WHERE name='cpu_count'")).first()
                if r and r[0]:
                    out["cpu_cores"] = int(float(r[0]))
            except Exception:
                pass
        # busiest tablespace usage as a storage proxy (Oracle has no host-disk view)
        try:
            r = c.execute(text(
                "SELECT ROUND(MAX(used_percent),1) FROM dba_tablespace_usage_metrics")).first()
            if r and r[0] is not None:
                out["disk_pct"] = float(r[0])
        except Exception:
            pass
    return out


def _mssql_cpu_split(c):
    """(host CPU %, SQL Server CPU %) from the scheduler ring buffer."""
    host = sqlc = 0
    try:
        r = c.execute(text("""
            SELECT TOP 1
              100 - record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int') AS host,
              record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int') AS sqlc
            FROM (SELECT TOP 1 CONVERT(XML, record) AS record FROM sys.dm_os_ring_buffers
                  WHERE ring_buffer_type=N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE '%<SystemHealth>%'
                  ORDER BY timestamp DESC) x""")).first()
        if r:
            host = max(min(int(r[0] or 0), 100), 0)
            sqlc = max(min(int(r[1] or 0), 100), 0)
    except Exception:
        pass
    return host, sqlc


_INTERNAL_SQL = ("sys.dm_", "dm_exec_", "dm_os_", "dm_db_", "missing_index", "ring_buffer",
                 "sys.partitions", "sys.allocation_units", "sys.dm_os_performance_counters",
                 "dm_exec_sessions", "sys.databases")


def _is_internal_sql(t) -> bool:
    tl = (t or "").lower()
    return any(p in tl for p in _INTERNAL_SQL)


def _mssql_sessions(conn, pid=None, limit=25):
    """Persistent SQL Server SESSIONS (not transient requests) ranked by cumulative CPU,
    each carrying its LAST query (most_recent_sql_handle) so the drill never goes stale."""
    eng = _mssql_engine(conn)
    where = "AND s.session_id = :pid" if pid else ""
    sql = f"""
        SELECT TOP {int(limit)} s.session_id AS pid, s.login_name AS usename,
               DB_NAME(s.database_id) AS datname, s.host_name AS client_addr,
               s.status AS state, r.wait_type AS wait_event,
               s.cpu_time AS cpu_ms, s.memory_usage * 8 AS memory_kb,
               ISNULL(mg.granted_memory_kb, 0) AS granted_kb,
               s.reads, s.writes,
               ISNULL(r.total_elapsed_time / 1000, 0) AS query_seconds,
               s.last_request_start_time, s.program_name,
               SUBSTRING(COALESCE(rt.text, st.text), 1, 2000) AS query
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) rt
        LEFT JOIN sys.dm_exec_connections cn ON s.session_id = cn.session_id
        OUTER APPLY sys.dm_exec_sql_text(cn.most_recent_sql_handle) st
        LEFT JOIN (SELECT session_id, SUM(granted_memory_kb) AS granted_memory_kb
                   FROM sys.dm_exec_query_memory_grants GROUP BY session_id) mg ON s.session_id = mg.session_id
        WHERE s.is_user_process = 1 {where}
        ORDER BY s.cpu_time DESC"""
    with eng.connect() as c:
        rows = [dict(x) for x in c.execute(text(sql), ({"pid": pid} if pid else {})).mappings().all()]
    for x in rows:
        for k, v in list(x.items()):
            if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                x[k] = float(v)
            elif hasattr(v, "isoformat"):
                x[k] = str(v)
        # Hide ActMon's OWN monitoring queries so they're never shown as "the consuming query".
        if _is_internal_sql(x.get("query")):
            x["query"] = None
            x["is_internal"] = True
    return rows


def _mssql_processes(conn, sort: str = "cpu") -> dict:
    """Windows host has no Linux SSH — show SQL Server's SESSIONS (persistent) as the 'processes'."""
    eng = _mssql_engine(conn)
    cores = None
    total_mem_kb = 0
    with eng.connect() as c:
        host, sqlc = _mssql_cpu_split(c)
        try:
            cores = int(c.execute(text("SELECT cpu_count FROM sys.dm_os_sys_info")).scalar() or 0)
        except Exception:
            pass
        try:
            total_mem_kb = float(c.execute(text("SELECT cntr_value FROM sys.dm_os_performance_counters "
                                                "WHERE RTRIM(counter_name)='Total Server Memory (KB)'")).scalar() or 0)
        except Exception:
            pass
    sess = _mssql_sessions(conn, limit=25)
    tot = sum(float(x.get("cpu_ms") or 0) for x in sess) or 1.0
    rows = []
    for x in sess:
        cpu_ms = float(x.get("cpu_ms") or 0)
        mem_kb = max(float(x.get("memory_kb") or 0), float(x.get("granted_kb") or 0))  # session + active grant
        rows.append({
            "pid": x["pid"], "user": x.get("usename") or "—",
            # cpu_pct here is the session's share of SQL Server's HOST CPU (so it's consistent with the
            # "SQL Server share" summary — ~0 when SQL is idle). The TABLE displays cpu_ms (time) instead.
            "cpu_pct": round(cpu_ms / tot * sqlc, 1),
            "cpu_share_pct": round(cpu_ms / tot * 100, 1),   # share of SQL Server's OWN cpu (sums to 100%)
            "cpu_ms": round(cpu_ms),
            "mem_pct": round(mem_kb / total_mem_kb * 100, 2) if total_mem_kb else None,  # % of SQL Server memory
            "rss_mb": round(mem_kb / 1024, 2 if mem_kb < 1024 else 1),
            "command": f"SQL ({x.get('datname') or '-'})", "cmdline": x.get("query") or "",
            "is_db": True, "query": x.get("query"),
        })
    rows.sort(key=lambda r: (r.get("mem_pct") or 0) if sort == "mem" else (r.get("cpu_ms") or 0), reverse=True)
    other = max(host - sqlc, 0)
    note = (f"SQL Server is using only {sqlc}% of CPU — the host is at {host}%, so ~{other}% is from "
            "NON-SQL Windows processes. ActMon can't list Windows OS processes without a host agent; "
            "check Task Manager / Resource Monitor on the server. The rows below are SQL Server sessions "
            "ranked by their own cumulative CPU.")
    return {"processes": rows, "sort": "cpu", "cpu_cores": cores,
            "system_cpu_pct": host, "db_cpu_pct": sqlc, "is_external": other > sqlc, "note": note}


def _mssql_process_sessions(conn, pid) -> dict:
    rows = _mssql_sessions(conn, pid=pid)
    if not rows:                       # session disconnected → show the busiest sessions instead
        rows = _mssql_sessions(conn, limit=20)
        return {"pid": pid, "matched_pid": False, "sessions": rows, "limited": False,
                "note": f"Session {pid} has disconnected — showing the busiest current sessions instead."}
    return {"pid": pid, "matched_pid": True, "sessions": rows, "limited": False}


_SYS_DBS = ("master", "tempdb", "model", "msdb")


def _dec(rows):
    for x in rows:
        for k, v in list(x.items()):
            if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                x[k] = float(v)
    return rows


def _mssql_pick_db(c, conn, session_db=None):
    """Choose a real USER database to analyse (session db → connection db → largest user db)."""
    users = []
    try:
        users = [r[0] for r in c.execute(text("SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0")).fetchall()]
    except Exception:
        pass
    if session_db and session_db not in _SYS_DBS and session_db in users:
        return session_db
    if conn.database_name and conn.database_name not in _SYS_DBS and conn.database_name in users:
        return conn.database_name
    try:
        r = c.execute(text("SELECT TOP 1 DB_NAME(database_id) FROM sys.master_files WHERE database_id > 4 GROUP BY database_id ORDER BY SUM(CAST(size AS BIGINT)) DESC")).scalar()
        if r:
            return r
    except Exception:
        pass
    return users[0] if users else (conn.database_name or None)


def _mssql_deep_analysis(conn, pid) -> dict:
    """Deep, step-wise DB analysis BEFORE the RCA: table sizes, index usage, missing indexes,
    partitioning candidates — with concrete CREATE/DROP/partition recommendations."""
    eng = _mssql_engine(conn)
    sess = _mssql_sessions(conn, pid=pid)
    srow = sess[0] if sess else {}
    tables = indexes = missing = parts = top_queries = []
    with eng.connect() as c:
        adb = _mssql_pick_db(c, conn, srow.get("datname"))
        D = adb.replace("]", "]]") if adb else None
        if D:
            tables = _dec(_mrows(c, f"""
                SELECT TOP 12 s.name AS schema_name, t.name AS table_name, p.rows AS row_count,
                    CAST(SUM(a.total_pages)*8/1024.0 AS DECIMAL(12,1)) AS total_mb,
                    CAST(SUM(CASE WHEN i.index_id NOT IN (0,1) THEN a.used_pages ELSE 0 END)*8/1024.0 AS DECIMAL(12,1)) AS index_mb
                FROM [{D}].sys.tables t
                JOIN [{D}].sys.schemas s ON t.schema_id = s.schema_id
                JOIN [{D}].sys.indexes i ON t.object_id = i.object_id
                JOIN [{D}].sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
                JOIN [{D}].sys.allocation_units a ON p.partition_id = a.container_id
                WHERE i.index_id <= 1
                GROUP BY s.name, t.name, p.rows ORDER BY total_mb DESC"""))
            indexes = _dec(_mrows(c, f"""
                SELECT TOP 25 OBJECT_NAME(i.object_id, DB_ID('{adb}')) AS table_name,
                    ISNULL(i.name,'(heap)') AS index_name, i.type_desc,
                    ISNULL(ius.user_seeks,0) AS seeks, ISNULL(ius.user_scans,0) AS scans,
                    ISNULL(ius.user_lookups,0) AS lookups, ISNULL(ius.user_updates,0) AS updates
                FROM [{D}].sys.indexes i
                LEFT JOIN sys.dm_db_index_usage_stats ius
                       ON ius.object_id = i.object_id AND ius.index_id = i.index_id AND ius.database_id = DB_ID('{adb}')
                WHERE i.object_id IN (SELECT object_id FROM [{D}].sys.tables)
                ORDER BY (ISNULL(ius.user_seeks,0)+ISNULL(ius.user_scans,0)+ISNULL(ius.user_lookups,0)) DESC"""))
            missing = _dec(_mrows(c, f"""
                SELECT TOP 10 OBJECT_NAME(mid.object_id, mid.database_id) AS table_name,
                    mid.equality_columns, mid.inequality_columns, mid.included_columns,
                    CAST(migs.avg_user_impact AS DECIMAL(5,1)) AS impact, (migs.user_seeks+migs.user_scans) AS uses
                FROM sys.dm_db_missing_index_details mid
                JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle = mig.index_handle
                JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
                WHERE mid.database_id = DB_ID('{adb}')
                ORDER BY migs.avg_total_user_cost*migs.avg_user_impact*(migs.user_seeks+migs.user_scans) DESC"""))
            parts = _dec(_mrows(c, f"""
                SELECT t.name AS table_name, SUM(p.rows) AS row_count, MAX(p.partition_number) AS parts
                FROM [{D}].sys.tables t
                JOIN [{D}].sys.indexes i ON t.object_id = i.object_id AND i.index_id <= 1
                JOIN [{D}].sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
                GROUP BY t.name HAVING SUM(p.rows) > 1000000 AND MAX(p.partition_number) = 1
                ORDER BY SUM(p.rows) DESC"""))
            top_queries = _dec(_mrows(c, f"""
                SELECT TOP 8 qs.execution_count,
                    qs.total_worker_time/1000 AS total_cpu_ms,
                    CAST(qs.total_worker_time/1000.0/NULLIF(qs.execution_count,0) AS DECIMAL(12,1)) AS avg_cpu_ms,
                    qs.total_logical_reads/NULLIF(qs.execution_count,0) AS avg_reads,
                    SUBSTRING(t.text,1,300) AS query
                FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
                WHERE t.dbid = DB_ID('{adb}')
                  AND t.text NOT LIKE '%dm_exec%' AND t.text NOT LIKE '%dm_os%' AND t.text NOT LIKE '%dm_db%'
                ORDER BY qs.total_worker_time DESC"""))

    def _cols(s):
        return [x.strip().strip("[]") for x in (s or "").split(",") if x.strip()]

    missing_ddl = []
    for m in missing:
        cols = _cols(m.get("equality_columns")) + _cols(m.get("inequality_columns"))
        inc = _cols(m.get("included_columns"))
        tbl = m.get("table_name") or "table"
        if cols:
            ix = f"IX_{tbl}_{'_'.join(cols)}"[:120]
            ddl = (f"CREATE NONCLUSTERED INDEX [{ix}] ON [{tbl}] ("
                   + ", ".join(f"[{c2}]" for c2 in cols) + ")"
                   + (f" INCLUDE (" + ", ".join(f"[{c2}]" for c2 in inc) + ")" if inc else "") + ";")
            missing_ddl.append({"table": tbl, "impact": m.get("impact"), "uses": m.get("uses"), "ddl": ddl})

    unused = [i for i in indexes
              if (i.get("seeks", 0) + i.get("scans", 0) + i.get("lookups", 0)) == 0
              and (i.get("updates") or 0) > 0
              and i.get("index_name") not in ("(heap)",) and i.get("type_desc") != "CLUSTERED"]
    big_tables = [t for t in tables if (t.get("row_count") or 0) > 1000000]

    recommendations = []
    for d in missing_ddl[:5]:
        recommendations.append(f"Create index on [{d['table']}] (est. {d['impact']}% improvement): {d['ddl']}")
    for i in unused[:5]:
        recommendations.append(f"Consider dropping unused index [{i['index_name']}] on [{i['table_name']}] — only written ({i['updates']} updates), never read.")
    for t in (parts or [])[:5]:
        recommendations.append(f"Table [{t['table_name']}] has {int(t['row_count']):,} rows and is NOT partitioned — partition it by a date/range key to speed up scans, maintenance & archival.")
    if not recommendations:
        recommendations.append("No missing indexes, unused indexes, or partition candidates detected — schema looks healthy.")

    return {"detail": srow or {"datname": adb}, "plan": None, "limited": False,
            "analysis": {"database": adb, "tables": tables, "indexes": indexes,
                         "missing_indexes": missing_ddl, "unused_indexes": unused,
                         "partition_candidates": parts, "big_tables": big_tables,
                         "top_queries": top_queries, "recommendations": recommendations}}


def _mssql_session_detail(conn, pid) -> dict:
    return _mssql_deep_analysis(conn, pid)


def _mrows(c, sql):
    try:
        return [dict(r) for r in c.execute(text(sql)).mappings().all()]
    except Exception:
        return []


def mssql_table_detail(conn_id: int, db: Session, dbname: str, schema: str, table: str) -> dict:
    """Deep table detail: columns, indexes (+fragmentation & usage), sizes, partitions, missing indexes."""
    conn = _get_conn(conn_id, db, "mssql")
    eng = _mssql_engine(conn)
    D = (dbname or "").replace("]", "]]")
    obj = f"[{dbname}].[{schema}].[{table}]"
    out = {"database": dbname, "schema": schema, "table": table,
           "columns": [], "indexes": [], "missing_indexes": [], "stats": {}, "recommendations": []}
    with eng.connect() as c:
        out["stats"] = (_dec(_mrows(c, f"""
            SELECT MAX(CASE WHEN i.index_id <= 1 THEN p.rows END) AS row_count,
                CAST(SUM(a.total_pages)*8/1024.0 AS DECIMAL(12,2)) AS total_mb,
                CAST(SUM(CASE WHEN i.index_id IN (0,1) THEN a.data_pages ELSE 0 END)*8/1024.0 AS DECIMAL(12,2)) AS data_mb,
                CAST(SUM(CASE WHEN i.index_id NOT IN (0,1) THEN a.used_pages ELSE 0 END)*8/1024.0 AS DECIMAL(12,2)) AS index_mb,
                MAX(p.partition_number) AS partitions
            FROM [{D}].sys.indexes i
            JOIN [{D}].sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
            JOIN [{D}].sys.allocation_units a ON p.partition_id = a.container_id
            WHERE i.object_id = OBJECT_ID('{obj}')""")) or [{}])[0]

        out["columns"] = _dec(_mrows(c, f"""
            SELECT c.column_id, c.name, ty.name AS data_type,
                CASE WHEN ty.name IN ('nvarchar','nchar') AND c.max_length > 0 THEN c.max_length/2 ELSE c.max_length END AS length,
                c.is_nullable, c.is_identity,
                CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk,
                dc.definition AS default_def
            FROM [{D}].sys.columns c
            JOIN [{D}].sys.types ty ON c.user_type_id = ty.user_type_id
            LEFT JOIN (SELECT ic.object_id, ic.column_id FROM [{D}].sys.indexes i
                       JOIN [{D}].sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                       WHERE i.is_primary_key = 1) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
            LEFT JOIN [{D}].sys.default_constraints dc ON c.default_object_id = dc.object_id
            WHERE c.object_id = OBJECT_ID('{obj}') ORDER BY c.column_id"""))

        out["indexes"] = _dec(_mrows(c, f"""
            SELECT i.name AS index_name, i.type_desc, i.is_unique, i.is_primary_key,
                STUFF((SELECT ', ' + col.name FROM [{D}].sys.index_columns ic
                       JOIN [{D}].sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
                       WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                       ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS key_columns,
                CAST(ps.avg_fragmentation_in_percent AS DECIMAL(5,1)) AS frag_pct,
                ISNULL(ius.user_seeks,0) AS seeks, ISNULL(ius.user_scans,0) AS scans,
                ISNULL(ius.user_lookups,0) AS lookups, ISNULL(ius.user_updates,0) AS updates
            FROM [{D}].sys.indexes i
            OUTER APPLY sys.dm_db_index_physical_stats(DB_ID('{dbname}'), OBJECT_ID('{obj}'), i.index_id, NULL, 'LIMITED') ps
            LEFT JOIN sys.dm_db_index_usage_stats ius ON ius.object_id = i.object_id AND ius.index_id = i.index_id AND ius.database_id = DB_ID('{dbname}')
            WHERE i.object_id = OBJECT_ID('{obj}') AND i.type > 0
            ORDER BY i.index_id"""))

        out["missing_indexes"] = _dec(_mrows(c, f"""
            SELECT mid.equality_columns, mid.inequality_columns, mid.included_columns,
                CAST(migs.avg_user_impact AS DECIMAL(5,1)) AS impact, (migs.user_seeks+migs.user_scans) AS uses
            FROM sys.dm_db_missing_index_details mid
            JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle = mig.index_handle
            JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
            WHERE mid.object_id = OBJECT_ID('{obj}') AND mid.database_id = DB_ID('{dbname}')
            ORDER BY migs.avg_user_impact DESC"""))

    def _cols(s):
        return [x.strip().strip("[]") for x in (s or "").split(",") if x.strip()]
    for m in out["missing_indexes"]:
        cols = _cols(m.get("equality_columns")) + _cols(m.get("inequality_columns"))
        inc = _cols(m.get("included_columns"))
        if cols:
            ixn = f"IX_{table}_{'_'.join(cols)}"[:120]
            m["ddl"] = (f"CREATE NONCLUSTERED INDEX [{ixn}] ON [{schema}].[{table}] ("
                        + ", ".join(f"[{x}]" for x in cols) + ")"
                        + (f" INCLUDE (" + ", ".join(f"[{x}]" for x in inc) + ")" if inc else "") + ";")
            out["recommendations"].append(f"Create index (≈{m.get('impact')}% faster): {m['ddl']}")
    for ix in out["indexes"]:
        if (ix.get("frag_pct") or 0) >= 30 and (out["stats"].get("row_count") or 0) > 1000:
            out["recommendations"].append(f"Rebuild index [{ix.get('index_name')}] — {ix.get('frag_pct')}% fragmented: ALTER INDEX [{ix.get('index_name')}] ON [{schema}].[{table}] REBUILD;")
        if (ix.get("seeks", 0) + ix.get("scans", 0) + ix.get("lookups", 0)) == 0 and (ix.get("updates") or 0) > 0 and not ix.get("is_primary_key"):
            out["recommendations"].append(f"Index [{ix.get('index_name')}] is never read but maintained on writes — consider dropping it.")
    if (out["stats"].get("row_count") or 0) > 1000000 and (out["stats"].get("partitions") or 1) == 1:
        out["recommendations"].append(f"[{table}] has {int(out['stats']['row_count']):,} rows and isn't partitioned — partition by a date/range key.")
    if not out["recommendations"]:
        out["recommendations"].append("No tuning needed — indexes are used, low fragmentation, no missing indexes.")
    return out


def _mssql_xp_enabled(c) -> bool:
    try:
        v = c.execute(text("SELECT CAST(value_in_use AS INT) FROM sys.configurations WHERE name = 'xp_cmdshell'")).scalar()
        return int(v or 0) == 1
    except Exception:
        return False


def _wmic_snapshot(c):
    """Parse one wmic process snapshot → {pid: {name, cpu100ns, mem}} (CPU = cumulative 100ns)."""
    rows = c.exec_driver_sql(
        "EXEC xp_cmdshell 'wmic process get Name,ProcessId,WorkingSetSize,KernelModeTime,UserModeTime /format:csv'"
    ).fetchall()
    lines = [r[0] for r in rows if r and r[0] and str(r[0]).strip()]
    hdr = next((i for i, l in enumerate(lines) if "ProcessId" in l and "Name" in l), None)
    out = {}
    if hdr is None:
        return out
    cols = [x.strip() for x in lines[hdr].split(",")]
    ix = {n: i for i, n in enumerate(cols)}
    for l in lines[hdr + 1:]:
        p = l.split(",")
        if len(p) < len(cols):
            continue
        try:
            name = p[ix["Name"]].strip()
            pid = p[ix["ProcessId"]].strip()
            if not name or name.lower() == "name" or not pid.isdigit():
                continue
            kt = float(p[ix["KernelModeTime"]] or 0)
            ut = float(p[ix["UserModeTime"]] or 0)
            ws = float(p[ix["WorkingSetSize"]] or 0)
            out[int(pid)] = {"name": name, "cpu100ns": kt + ut, "mem": ws}
        except Exception:
            continue
    return out


def mssql_os_processes(conn_id: int, db: Session) -> dict:
    return _mssql_os_collect(_get_conn(conn_id, db, "mssql"))


def _mssql_os_collect(conn) -> dict:
    """Enumerate WINDOWS OS processes with REAL instantaneous CPU% (two wmic samples 1s apart)."""
    import time
    eng = _mssql_engine(conn)
    with eng.connect() as c:
        if not _mssql_xp_enabled(c):
            return {"enabled": False, "needs_enable": True, "processes": [],
                    "note": "Windows process visibility requires xp_cmdshell (a sysadmin-only feature). Enable it to identify the non-SQL process."}
        try:
            cores = int(c.execute(text("SELECT cpu_count FROM sys.dm_os_sys_info")).scalar() or 1)
        except Exception:
            cores = 1
        try:
            s1 = _wmic_snapshot(c); t1 = time.time()
            time.sleep(1.0)
            s2 = _wmic_snapshot(c); t2 = time.time()
        except Exception as e:
            return {"enabled": True, "processes": [], "note": f"Could not run wmic: {str(e).splitlines()[0]}"}

    dt = max(t2 - t1, 0.5)
    window_100ns = dt * 1e7 * max(cores, 1)   # max CPU 100ns available across all cores in the window
    procs = []
    idle_pct = 0.0
    for pid, p2 in s2.items():
        p1 = s1.get(pid)
        delta = p2["cpu100ns"] - (p1["cpu100ns"] if p1 else p2["cpu100ns"])
        pct = max(min(delta / window_100ns * 100, 100.0), 0.0)
        row = {"name": p2["name"], "pid": pid, "cpu_pct": round(pct, 1),
               "cpu_seconds": round(p2["cpu100ns"] / 1e7, 1), "mem_mb": round(p2["mem"] / 1048576, 1)}
        if "idle" in p2["name"].lower():
            idle_pct = round(pct, 1)
            continue   # don't list the Idle process among consumers
        procs.append(row)

    procs.sort(key=lambda x: x["cpu_pct"], reverse=True)
    total_busy = round(min(sum(p["cpu_pct"] for p in procs), 100.0), 1)
    return {"enabled": True, "cpu_cores": cores, "processes": procs[:15],
            "total_cpu_pct": total_busy, "idle_pct": idle_pct,
            "note": "Real-time CPU% = each process's share of the whole host (sampled over 1s, ÷ cores). "
                    "CPU (s) is cumulative since process start. 'sqlservr' is SQL Server itself."}


def mssql_enable_os_visibility(conn_id: int, db: Session) -> dict:
    """Enable xp_cmdshell (sysadmin only) so Windows OS processes can be listed."""
    conn = _get_conn(conn_id, db, "mssql")
    eng = _mssql_engine(conn)
    try:
        with eng.connect() as c:
            c = c.execution_options(isolation_level="AUTOCOMMIT")
            for stmt in ("EXEC sp_configure 'show advanced options', 1", "RECONFIGURE",
                         "EXEC sp_configure 'xp_cmdshell', 1", "RECONFIGURE"):
                c.exec_driver_sql(stmt)
        return {"status": "success", "message": "Windows process visibility enabled (xp_cmdshell)."}
    except Exception as e:
        return {"status": "failed",
                "message": f"Could not enable — needs a sysadmin login. ({str(e).splitlines()[0]})",
                "manual_sql": "EXEC sp_configure 'show advanced options',1; RECONFIGURE; EXEC sp_configure 'xp_cmdshell',1; RECONFIGURE;"}


def _mssql_rca(conn, resource, pid=None, target_cmd=None) -> dict:
    eng = _mssql_engine(conn)
    with eng.connect() as c:
        host, sqlc = _mssql_cpu_split(c)
        cores = None
        try:
            cores = int(c.execute(text("SELECT cpu_count FROM sys.dm_os_sys_info")).scalar() or 0)
        except Exception:
            pass
        host_util = host
        mem = {}
        if resource == "mem":
            r = _mrows(c, "SELECT total_physical_memory_kb AS t, available_physical_memory_kb AS a FROM sys.dm_os_sys_memory")
            if r and r[0].get("t"):
                t, a = float(r[0]["t"]), float(r[0].get("a") or 0)
                host_util = round((t - a) / t * 100, 1)
                mem = {"host_used_mb": round((t - a) / 1024, 1), "host_total_mb": round(t / 1024, 1)}

        other = max(host - sqlc, 0)
        is_db = (sqlc >= other) if resource == "cpu" else True

        active = top_queries = top_waits = missing_ix = big_tables = []
        adb = None
        if is_db:   # only gather DB evidence when the DATABASE is actually the cause
            active = _mrows(c, """
                SELECT TOP 8 r.session_id, s.login_name, DB_NAME(r.database_id) AS db_name,
                       r.cpu_time AS cpu_ms, r.total_elapsed_time AS elapsed_ms, r.status,
                       r.wait_type, r.wait_time, r.blocking_session_id, r.reads, r.writes, r.logical_reads,
                       SUBSTRING(ISNULL(t.text,''),1,400) AS query
                FROM sys.dm_exec_requests r
                JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
                OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE s.is_user_process = 1 ORDER BY r.cpu_time DESC""")
            top_queries = _mrows(c, """
                SELECT TOP 8 DB_NAME(t.dbid) AS db_name, qs.execution_count,
                       qs.total_worker_time/1000 AS total_cpu_ms,
                       CAST(qs.total_worker_time/1000.0/NULLIF(qs.execution_count,0) AS DECIMAL(12,1)) AS avg_cpu_ms,
                       CAST(qs.total_elapsed_time/1000.0/NULLIF(qs.execution_count,0) AS DECIMAL(12,1)) AS avg_elapsed_ms,
                       qs.total_logical_reads/NULLIF(qs.execution_count,0) AS avg_logical_reads,
                       SUBSTRING(t.text,1,400) AS query
                FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
                WHERE t.text NOT LIKE '%dm_exec%' ORDER BY qs.total_worker_time DESC""")
            top_waits = _mrows(c, """
                SELECT TOP 6 wait_type, waiting_tasks_count, wait_time_ms
                FROM sys.dm_os_wait_stats
                WHERE wait_type NOT LIKE '%SLEEP%' AND wait_type NOT LIKE '%IDLE%' AND wait_time_ms > 0
                ORDER BY wait_time_ms DESC""")
            for grp in (active, top_queries, top_waits):
                for row in grp:
                    for k, v in list(row.items()):
                        if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                            row[k] = float(v)
            adb = _mssql_pick_db(c, conn, None)
            if adb:
                Dn = adb.replace("]", "]]")
                missing_ix = _dec(_mrows(c, f"""
                    SELECT TOP 5 OBJECT_NAME(mid.object_id, mid.database_id) AS table_name,
                        mid.equality_columns, mid.inequality_columns, CAST(migs.avg_user_impact AS DECIMAL(5,1)) AS impact
                    FROM sys.dm_db_missing_index_details mid
                    JOIN sys.dm_db_missing_index_groups mig ON mid.index_handle = mig.index_handle
                    JOIN sys.dm_db_missing_index_group_stats migs ON mig.index_group_handle = migs.group_handle
                    WHERE mid.database_id = DB_ID('{adb}')
                    ORDER BY migs.avg_total_user_cost*migs.avg_user_impact*(migs.user_seeks+migs.user_scans) DESC"""))
                big_tables = _dec(_mrows(c, f"""
                    SELECT TOP 5 t.name AS table_name, SUM(p.rows) AS row_count, MAX(p.partition_number) AS parts
                    FROM [{Dn}].sys.tables t
                    JOIN [{Dn}].sys.indexes i ON t.object_id = i.object_id AND i.index_id <= 1
                    JOIN [{Dn}].sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
                    GROUP BY t.name HAVING SUM(p.rows) > 1000000 ORDER BY SUM(p.rows) DESC"""))

    # External cause → enumerate the real Windows processes instead of DB internals
    os_data = None if is_db else _mssql_os_collect(conn)
    if is_db:
        top_consumer = active[0] if active else (top_queries[0] if top_queries else None)
    else:
        top_consumer = (os_data.get("processes") or [None])[0] if os_data else None

    evidence = {
        "engine": "mssql", "resource": resource, "host_util_pct": host_util,
        "host_cpu_pct": host, "sql_server_cpu_pct": sqlc, "other_cpu_pct": other,
        "cpu_cores": cores, "db_share_pct": sqlc, "external_share_pct": other,
        "top_consumer": top_consumer, "top_processes": [], "target_process": None,
    }
    if is_db:
        evidence.update({"active_sessions_list": active, "top_queries": top_queries, "top_waits": top_waits,
                         "analysis_db": adb, "missing_indexes": missing_ix, "big_tables": big_tables,
                         "active_sessions": len(active)})
    else:
        evidence["os"] = os_data
        evidence["top_external_process"] = top_consumer
    if mem:
        evidence["memory"] = mem
    severity = _severity(host_util)
    rca_obj = _mssql_groq_rca(evidence, is_db, resource, severity, host_util)
    rca_obj["severity"] = severity
    rca_obj["title"] = _rca_title(resource, severity, host_util)
    rca_obj["host_util_pct"] = host_util
    return {"is_db_related": is_db, "severity": severity, "evidence": evidence, "rca": rca_obj}


def _mssql_groq_rca(evidence, is_db, resource, severity, host_util) -> dict:
    """Pinpoint RCA for SQL Server: name the exact session / database / query consuming."""
    import json as _json
    from app.services.chatbot.ai_engine import chat_once

    sys = (
        "You are a principal SQL Server DBA writing a precise, executive Root-Cause-Analysis. "
        "Respond with ONLY a JSON object: "
        '{"severity":"...","issue":"one line","root_cause":"2-4 sentences naming the EXACT culprit",'
        '"evidence_summary":["bullets quoting real session_id / database / query / numbers"],'
        '"immediate_actions":["..."],"permanent_solution":["..."],"precautions":["..."],"is_db_related":true}'
    )
    user = (
        f"SQL Server host {resource.upper()} utilization = {host_util}% (whole machine). Pre-computed severity = {severity} — agree with it.\n"
        f"Host CPU {evidence.get('host_cpu_pct')}% = SQL Server {evidence.get('sql_server_cpu_pct')}% + Other(non-SQL) {evidence.get('other_cpu_pct')}%.\n"
        "ALWAYS include this exact CPU breakdown calculation in evidence_summary (e.g. 'SQL 20% + non-SQL 50% = 70% of 100%').\n"
        "BE EXACT. Name the responsible session_id, login, database and quote the query. Do not say 'investigate' — "
        "use the evidence to state precisely which query/session/database is the top consumer and why "
        "(CPU time, reads, wait_type, blocking).\n"
        "If SQL Server's own CPU is LOW but host CPU is HIGH, state clearly that a NON-SQL Windows process is the cause; "
        "note ActMon can't enumerate Windows OS processes without a host agent, and advise checking Task Manager / installing the agent. "
        "Use 'missing_indexes' to recommend EXACT CREATE INDEX statements, and 'big_tables' to recommend partitioning where rows are very high. "
        "Do NOT output SQL fences.\n"
        f"EVIDENCE JSON:\n{_json.dumps(evidence, default=str)[:7000]}"
    )
    try:
        raw = chat_once([{"role": "system", "content": sys}, {"role": "user", "content": user}])
        s, e = raw.find("{"), raw.rfind("}")
        obj = _json.loads(raw[s:e + 1]) if s >= 0 and e > s else {}
        if obj:
            obj.setdefault("is_db_related", is_db)
            return obj
    except Exception:
        pass

    # Deterministic, still-exact fallback
    tc = evidence.get("top_consumer") or {}
    if is_db and tc:
        who = f"session {tc.get('session_id', '?')} ({tc.get('login_name', '?')}) on database {tc.get('db_name', '?')}"
        q = (tc.get("query") or "").strip()[:200]
        return {
            "severity": severity,
            "issue": f"SQL Server is the top {resource.upper()} consumer ({host_util}% host) — driven by {who}.",
            "root_cause": f"The heaviest work is {who}, CPU {tc.get('cpu_ms', tc.get('total_cpu_ms', '?'))} ms"
                          + (f", waiting on {tc['wait_type']}" if tc.get("wait_type") else "")
                          + (f". Query: {q}" if q else "."),
            "evidence_summary": [
                f"Host CPU {evidence.get('host_cpu_pct')}% (SQL {evidence.get('sql_server_cpu_pct')}% / other {evidence.get('other_cpu_pct')}%).",
                f"Top consumer: {who}.",
                f"Query: {q or 'n/a'}",
            ],
            "immediate_actions": [f"Inspect {who}; if runaway and safe, KILL {tc.get('session_id', '?')}.",
                                  "Check blocking chains and wait type."],
            "permanent_solution": ["Tune/﻿index the query above; review its execution plan.",
                                   "Add missing indexes / update statistics on the hot database."],
            "precautions": ["Set query/lock timeouts; monitor pg_stat_statements-equivalent (Query Store)."],
            "is_db_related": True,
        }
    return {
        "severity": severity,
        "issue": f"{resource.upper()} pressure ({host_util}%) is from NON-SQL Windows processes.",
        "root_cause": f"SQL Server is using only {evidence.get('sql_server_cpu_pct')}% of CPU while the host is at {evidence.get('host_cpu_pct')}% — "
                      "another Windows process is the cause. ActMon can't list Windows OS processes without a host agent.",
        "evidence_summary": [f"SQL Server CPU {evidence.get('sql_server_cpu_pct')}% vs host {evidence.get('host_cpu_pct')}%."],
        "immediate_actions": ["Open Task Manager / Resource Monitor on the SQL host to find the top process.",
                              "Install the ActMon Windows agent to enumerate OS processes here."],
        "permanent_solution": ["Move non-database workloads off the SQL Server host."],
        "precautions": ["Don't co-locate batch jobs/backups/AV scans with the SQL Server host."],
        "is_db_related": False,
    }


def host_metrics(tech: str, conn_id: int, db: Session) -> dict:
    conn = _get_conn(conn_id, db, tech)
    if tech == "mssql":
        return _mssql_host_metrics(conn)
    if tech == "oracle":
        # Prefer Oracle's own v$ views; only fall back to SSH if they yield nothing.
        try:
            m = _oracle_host_metrics(conn)
            if m.get("cpu_pct") is not None or m.get("ram_pct") is not None or m.get("cpu_cores"):
                return m
        except Exception:
            pass
    # DB running on this same machine → read the real host directly with psutil (no SSH needed).
    if _is_local_host(conn.host):
        m = _local_host_metrics()
        if m:
            return m
    # Host monitored by an ActMon agent → use the metrics the agent pushed (no SSH needed).
    am = _agent_host_metrics(conn_id, db)
    if am:
        return am
    ssh = _ssh_connect(conn, db)
    try:
        cpu = _num(_run(ssh, "top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}'"))
        ram_u = _num(_run(ssh, "free -m | awk 'NR==2{print $3}'"))
        ram_t = _num(_run(ssh, "free -m | awk 'NR==2{print $2}'"))
        disk = _num(_run(ssh, "df -h / | awk 'NR==2{print $5}'"))
        load = _run(ssh, "cat /proc/loadavg | awk '{print $1\" \"$2\" \"$3}'")
        cores = _num(_run(ssh, "nproc"), int)
    finally:
        ssh.close()
    return {"cpu_pct": cpu, "ram_pct": round(ram_u / ram_t * 100, 1) if ram_u and ram_t else None,
            "ram_used_mb": ram_u, "ram_total_mb": ram_t, "disk_pct": disk,
            "load_avg": load, "cpu_cores": cores}


def processes(tech: str, conn_id: int, db: Session, sort: str = "cpu", limit: int = 25) -> dict:
    conn = _get_conn(conn_id, db, tech)
    if tech == "mssql":
        return _mssql_processes(conn, sort=sort)
    cfg = _cfg(tech)
    # DB on this machine → enumerate processes locally with psutil (Windows/Mac/Linux).
    if _is_local_host(conn.host):
        local = _local_processes(cfg["procs"], sort=sort, limit=limit)
        if local is not None:
            return local
    # Host monitored by an ActMon agent → use the processes the agent pushed.
    am = _agent_processes(conn_id, db, sort=sort, limit=limit)
    if am:
        return am
    ssh = _ssh_connect(conn, db)
    cores = _num(_run(ssh, "nproc"), int) or 1
    rows = _collect(ssh, cores, cfg["procs"])
    ssh.close()
    key = "mem_pct" if sort == "mem" else "cpu_pct"
    rows.sort(key=lambda r: r.get(key) or 0, reverse=True)
    rows = rows[: int(limit)]
    return {
        "processes": rows, "sort": sort, "cpu_cores": cores,
        "system_cpu_pct": round(min(sum((r["cpu_pct"] or 0) for r in rows), 100.0), 1),
        "db_cpu_pct": round(sum((r["cpu_pct"] or 0) for r in rows if r["is_db"]), 1),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Live queries (per engine)
# ──────────────────────────────────────────────────────────────────────────────

def _active_sessions(tech: str, conn) -> list:
    cfg = _cfg(tech)
    if tech == "postgresql":
        eng = cfg["engine"](conn)
        with eng.connect() as c:
            return [dict(r) for r in c.execute(text(
                f"SELECT {pg._ACTIVITY_COLS} FROM pg_stat_activity "
                "WHERE state IS DISTINCT FROM 'idle' AND backend_type='client backend' "
                "ORDER BY query_start ASC NULLS LAST LIMIT 50")).mappings().all()]
    sql = cfg.get("sql")
    if not sql or not cfg.get("engine"):
        return []
    eng = cfg["engine"](conn)
    with eng.connect() as c:
        return [dict(r) for r in c.execute(text(sql)).mappings().all()]


def process_sessions(tech: str, conn_id: int, pid: int, db: Session) -> dict:
    conn = _get_conn(conn_id, db, tech)
    if tech == "mssql":
        return _mssql_process_sessions(conn, pid)
    if tech == "mongodb":
        return {"pid": pid, "matched_pid": False, "sessions": [], "limited": False,
                "note": "Live query introspection isn't available for MongoDB; use host processes + RCA."}
    try:
        sessions = _active_sessions(tech, conn)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read live sessions: {str(e).splitlines()[0]}")
    matched = False
    if tech == "postgresql":
        exact = [s for s in sessions if str(s.get("pid")) == str(pid)]
        if exact:
            sessions, matched = exact, True
    limited = any((s.get("query") or "") == "<insufficient privilege>" for s in sessions)
    return {"pid": pid, "matched_pid": matched, "sessions": sessions, "limited": limited}


def session_detail(tech: str, conn_id: int, pid, db: Session) -> dict:
    conn = _get_conn(conn_id, db, tech)
    if tech == "postgresql":
        return pg.session_detail(conn_id, int(pid), db)
    if tech == "mssql":
        return _mssql_session_detail(conn, pid)
    sessions = _active_sessions(tech, conn)
    row = next((s for s in sessions if str(s.get("pid")) == str(pid)), None)
    if not row:
        raise HTTPException(
            status_code=404,
            detail="This session finished before it could be inspected — short-lived queries "
                   "often complete within seconds. Go back to see the current sessions.")
    return {"detail": row, "plan": "(execution plan available on PostgreSQL/Oracle deep-dive)", "limited": False}


# ──────────────────────────────────────────────────────────────────────────────
# RCA (engine-agnostic host classification + Groq narrative)
# ──────────────────────────────────────────────────────────────────────────────

def rca(tech: str, conn_id: int, db: Session, pid: Optional[int] = None,
        resource: str = "cpu", target_cmd: Optional[str] = None) -> dict:
    conn = _get_conn(conn_id, db, tech)
    if tech == "mssql":
        return _mssql_rca(conn, resource, pid, target_cmd)
    cfg = _cfg(tech)
    # Agent-connected host → build the process snapshot from the agent's last
    # push instead of SSH (agent hosts often have no SSH creds at all).
    ap = _agent_processes(conn_id, db, sort=("mem" if resource != "cpu" else "cpu"), limit=200)
    if ap:
        all_procs = ap["processes"]
        if resource == "cpu":
            host_util = ap.get("system_cpu_pct")
        else:
            am = _agent_host_metrics(conn_id, db)
            host_util = (am or {}).get("ram_pct")
    else:
        ssh = _ssh_connect(conn, db)
        cores = _num(_run(ssh, "nproc"), int) or 1
        all_procs = _collect(ssh, cores, cfg["procs"])
        if resource == "cpu":
            host_util = _num(_run(ssh, "top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}'"))
        else:
            host_util = _num(_run(ssh, "free -m | awk 'NR==2{printf \"%.1f\", $3*100/$2}'"))
        ssh.close()

    metric = "cpu_pct" if resource == "cpu" else "mem_pct"
    db_share = round(sum((p[metric] or 0) for p in all_procs if p["is_db"]), 1)
    ext_share = round(min(sum((p[metric] or 0) for p in all_procs if not p["is_db"]), 100.0), 1)
    top_procs = sorted(all_procs, key=lambda r: r.get(metric) or 0, reverse=True)[:10]
    target = None
    if pid:
        target = next((p for p in all_procs if str(p["pid"]) == str(pid)), None)
    if target is None and target_cmd:
        target = next((p for p in all_procs if p["command"] == target_cmd), None)
    is_db_related = target["is_db"] if target is not None else (db_share >= ext_share)
    top_ext = [p for p in top_procs if not p["is_db"]]
    top_external_proc = target if (target is not None and not target["is_db"]) else (top_ext[0] if top_ext else None)

    # light DB-side evidence (best-effort, per engine)
    active_list = []
    try:
        active_list = _active_sessions(tech, conn)[:8]
    except Exception:
        pass

    evidence = {
        "engine": tech, "resource": resource, "host_util_pct": host_util,
        "db_share_pct": db_share, "external_share_pct": ext_share,
        "top_processes": top_procs, "target_process": target,
        "top_external_process": top_external_proc,
        "active_sessions": len(active_list), "active_sessions_list": active_list,
    }
    severity = _severity(host_util)
    title = _rca_title(resource, severity, host_util)
    rca_obj = _groq_rca(conn, evidence, is_db_related, resource, severity, host_util)
    rca_obj["severity"] = severity
    rca_obj["title"] = title
    rca_obj["host_util_pct"] = host_util
    return {"is_db_related": is_db_related, "severity": severity, "evidence": evidence, "rca": rca_obj}


# ──────────────────────────────────────────────────────────────────────────────
# History (delegates to the shared resource_samples table)
# ──────────────────────────────────────────────────────────────────────────────

def history(tech: str, conn_id: int, db: Session, hours: int = 6) -> dict:
    _get_conn(conn_id, db, tech)
    return pg.history(conn_id, db, hours=hours)


def history_detail(tech: str, conn_id: int, sample_id: int, db: Session) -> dict:
    _get_conn(conn_id, db, tech)
    return pg.history_detail(conn_id, sample_id, db)


def history_rca(tech: str, conn_id: int, sample_id: int, db: Session, resource: str = "cpu") -> dict:
    conn = _get_conn(conn_id, db, tech)
    row = pg._sample_row(conn_id, sample_id, db)
    ev = row["evidence"] or {}
    procs = ev.get("top_processes", [])
    util = float(row["cpu_pct"] or 0) if resource == "cpu" else float(row["ram_pct"] or 0)
    mkey = "cpu_pct" if resource == "cpu" else "mem_pct"
    db_share = round(sum((p.get(mkey) or 0) for p in procs if p.get("is_db")), 1)
    ext_share = round(min(sum((p.get(mkey) or 0) for p in procs if not p.get("is_db")), 100.0), 1)
    is_db = db_share >= ext_share
    top_ext = next((p for p in sorted(procs, key=lambda x: x.get(mkey) or 0, reverse=True) if not p.get("is_db")), None)
    evidence = {"engine": tech, "resource": resource, "host_util_pct": util,
                "db_share_pct": db_share, "external_share_pct": ext_share, "top_processes": procs,
                "target_process": None, "top_external_process": top_ext,
                "active_sessions_list": ev.get("active_sessions_list", []),
                "captured_at": str(row["captured_at"]), "historical": True}
    severity = _severity(util)
    rca_obj = _groq_rca(conn, evidence, is_db, resource, severity, util)
    rca_obj["severity"] = severity
    rca_obj["title"] = _rca_title(resource, severity, util)
    rca_obj["host_util_pct"] = util
    return {"is_db_related": is_db, "severity": severity, "evidence": evidence, "rca": rca_obj,
            "captured_at": str(row["captured_at"])}
