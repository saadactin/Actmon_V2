"""
ActMon Host Agent (Windows)
===========================
A small, dependency-light monitoring agent packaged into actmon-agent.exe and
installed by actmon-agent.msi.

Configuration is read from (in priority order):
  1. Command-line:  actmon-agent.exe --token <t> --url <u>
  2. Registry:      HKLM\\SOFTWARE\\ActMon\\Agent  (Token, Url)  [written by the MSI]
  3. Environment:   ACTMON_ACCESS_TOKEN / ACTMON_URL

On start it enrolls against the token to resolve its agent identity, then pushes
host CPU / memory to <url>/agents/data every ACTMON_INTERVAL seconds (default 15).
"""

import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request


def _read_registry():
    """Return (token, url) from HKLM\\SOFTWARE\\ActMon\\Agent, or (None, None)."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ActMon\Agent") as k:
            token = _reg_get(k, "Token")
            url = _reg_get(k, "Url")
            return token, url
    except OSError:
        return None, None


def _reg_get(key, name):
    try:
        import winreg
        val, _ = winreg.QueryValueEx(key, name)
        return val or None
    except OSError:
        return None


def _arg(name):
    """Read a --name value from argv."""
    flag = f"--{name}"
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def _resolve_config():
    token = _arg("token")
    url = _arg("url")
    if not token or not url:
        reg_token, reg_url = _read_registry()
        token = token or reg_token
        url = url or reg_url
    token = token or os.environ.get("ACTMON_ACCESS_TOKEN")
    url = url or os.environ.get("ACTMON_URL")
    if url:
        url = url.rstrip("/")
    return token, url


def _post(url, payload, timeout=15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_text(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def _log(msg):
    print(f"{time.strftime('%H:%M:%S')}  {msg}", flush=True)


def collect_windows(collector_ps):
    """Run the same PowerShell collector the SSH path runs; return its raw output."""
    b64 = base64.b64encode(collector_ps.encode("utf-16-le")).decode()
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
        capture_output=True, text=True, timeout=60,
    )
    return proc.stdout


def _get_json(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def collect_mysql(tgt, state):
    """Connect to the local MySQL and collect internals (status + top SQL).
    Returns (metrics dict, top_sql list) matching the backend ingest shape."""
    import pymysql
    conn = pymysql.connect(
        host=tgt.get("host") or "localhost", port=int(tgt.get("port") or 3306),
        user=tgt.get("username"), password=tgt.get("password") or "",
        database=tgt.get("database") or None, connect_timeout=6, read_timeout=10,
    )
    try:
        cur = conn.cursor()
        cur.execute("SHOW GLOBAL STATUS")
        st = {k: v for (k, v) in cur.fetchall()}
        cur.execute("SHOW GLOBAL VARIABLES LIKE 'max_connections'")
        row = cur.fetchall()
        max_conn = int(row[0][1]) if row else 0

        def g(k):
            try:
                return float(st.get(k, 0) or 0)
            except (TypeError, ValueError):
                return 0.0

        uptime = g("Uptime") or 1.0
        queries, commits, rollbacks = g("Queries"), g("Com_commit"), g("Com_rollback")
        now = time.time()
        qps = tps = 0.0
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            qps = max(0.0, (queries - state["q"]) / dt)
            tps = max(0.0, ((commits + rollbacks) - state["tx"]) / dt)
        state.update(t=now, q=queries, tx=commits + rollbacks)

        rr, rd = g("Innodb_buffer_pool_read_requests"), g("Innodb_buffer_pool_reads")
        cache = 100.0 if rr <= 0 else max(0.0, (1 - rd / rr) * 100)

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": int(g("Threads_running")),
            "connections_used": int(g("Threads_connected")),
            "connections_max": max_conn,
            "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1),
            "uptime_seconds": int(uptime),
        }

        top = []
        try:
            cur.execute(
                "SELECT DIGEST, LEFT(DIGEST_TEXT,500), COUNT_STAR, SUM_TIMER_WAIT, "
                "AVG_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT "
                "FROM performance_schema.events_statements_summary_by_digest "
                "WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 20")
            for dig, txt, cnt, sumt, avgt, rex, rsent in cur.fetchall():
                top.append({
                    "sql_id": (dig or "")[:64], "sql_text": txt or "",
                    "executions": int(cnt or 0),
                    "avg_elapsed_ms": float(avgt or 0) / 1e9,   # ps → ms
                    "total_ms": float(sumt or 0) / 1e9,
                    "rows_examined": float(rex or 0), "rows_sent": float(rsent or 0),
                })
        except Exception:  # noqa: BLE001 — performance_schema may be off
            pass

        sessions = []
        try:
            # Exclude the agent's own connection so counts reflect real client sessions.
            cur.execute(
                "SELECT ID,USER,HOST,DB,COMMAND,TIME,STATE,INFO FROM information_schema.PROCESSLIST "
                "WHERE ID <> CONNECTION_ID()")
            for row in cur.fetchall():
                sessions.append({
                    "session_id": str(row[0]), "username": row[1] or "", "client_host": row[2] or "",
                    "db_name": row[3] or "", "command": row[4] or "", "duration_ms": float(row[5] or 0) * 1000,
                    "state": row[6] or "", "query": (row[7] or "")[:1000],
                })
        except Exception:  # noqa: BLE001
            pass
        # Make the metric agree with the list: active = sessions actually running a query.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["command"] or "").lower() == "query")
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def collect_postgres(tgt, state):
    """Connect to the local PostgreSQL and collect internals (activity + top SQL)."""
    import psycopg2
    conn = psycopg2.connect(
        host=tgt.get("host") or "localhost", port=int(tgt.get("port") or 5432),
        user=tgt.get("username"), password=tgt.get("password") or "",
        dbname=tgt.get("database") or "postgres", connect_timeout=6,
    )
    try:
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM pg_stat_activity")
        used = cur.fetchone()[0]
        cur.execute("SELECT count(*) FROM pg_stat_activity WHERE state = 'active'")
        active = cur.fetchone()[0]
        cur.execute("SHOW max_connections")
        max_conn = int(cur.fetchone()[0])
        cur.execute("SELECT COALESCE(sum(xact_commit+xact_rollback),0), COALESCE(sum(blks_hit),0), COALESCE(sum(blks_read),0) FROM pg_stat_database")
        row = cur.fetchone()
        tx = float(row[0] or 0); hit = float(row[1] or 0); read = float(row[2] or 0)   # sum() → Decimal
        cache = 100.0 if (hit + read) <= 0 else (hit / (hit + read) * 100)

        now = time.time()
        qps = tps = 0.0
        calls = 0.0
        try:
            cur.execute("SELECT COALESCE(sum(calls),0) FROM pg_stat_statements")
            calls = float(cur.fetchone()[0] or 0)
        except Exception:
            conn.rollback()
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            tps = max(0.0, (tx - state["tx"]) / dt)
            qps = max(0.0, (calls - state["calls"]) / dt) if calls else 0.0
        state.update(t=now, tx=tx, calls=calls)

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": int(active), "connections_used": int(used),
            "connections_max": max_conn, "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1), "uptime_seconds": 0,
        }
        top = []
        try:
            cur.execute(
                "SELECT queryid, LEFT(query,500), calls, total_exec_time, mean_exec_time, rows "
                "FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20")
            for qid, q, cnt, tot, mean, rows in cur.fetchall():
                top.append({
                    "sql_id": str(qid or "")[:64], "sql_text": q or "",
                    "executions": int(cnt or 0), "avg_elapsed_ms": float(mean or 0),
                    "total_ms": float(tot or 0), "rows_examined": float(rows or 0), "rows_sent": float(rows or 0),
                })
        except Exception:
            conn.rollback()   # pg_stat_statements not installed

        sessions = []
        try:
            cur.execute(
                "SELECT pid, usename, datname, client_addr, state, "
                "COALESCE(EXTRACT(EPOCH FROM (now()-query_start))*1000,0), LEFT(query,1000) "
                "FROM pg_stat_activity WHERE pid <> pg_backend_pid()")
            for pid, usr, dat, caddr, state, dur, q in cur.fetchall():
                sessions.append({
                    "session_id": str(pid), "username": usr or "", "db_name": dat or "",
                    "client_host": str(caddr or "local"), "state": state or "", "command": "",
                    "duration_ms": float(dur or 0), "query": (q or "")[:1000],
                })
        except Exception:
            conn.rollback()
        # Make the metric agree with the list: active = sessions in 'active' state.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["state"] or "").lower() == "active")
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def collect_mssql(tgt, state):
    """Connect to the local SQL Server and collect internals (DMVs + top SQL)."""
    import pymssql
    conn = pymssql.connect(
        server=tgt.get("host") or "localhost", port=int(tgt.get("port") or 1433),
        user=tgt.get("username"), password=tgt.get("password") or "",
        database=tgt.get("database") or "master", login_timeout=6, timeout=10,
    )
    try:
        cur = conn.cursor()
        cur.execute("SELECT DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) FROM sys.dm_os_sys_info")
        uptime = int(cur.fetchone()[0] or 0)
        cur.execute("SELECT @@MAX_CONNECTIONS")
        max_conn = int(cur.fetchone()[0] or 0)

        # Cumulative perf counters → per-second rates via deltas between cycles.
        cur.execute(
            "SELECT RTRIM(counter_name), cntr_value FROM sys.dm_os_performance_counters "
            "WHERE (counter_name = 'Batch Requests/sec' AND object_name LIKE '%SQL Statistics%') "
            "   OR (counter_name = 'Transactions/sec' AND instance_name = '_Total')")
        ctr = {name: float(v or 0) for name, v in cur.fetchall()}
        batches, tx = ctr.get("Batch Requests/sec", 0.0), ctr.get("Transactions/sec", 0.0)
        now = time.time()
        qps = tps = 0.0
        if state.get("t"):
            dt = max(1.0, now - state["t"])
            qps = max(0.0, (batches - state["q"]) / dt)
            tps = max(0.0, (tx - state["tx"]) / dt)
        state.update(t=now, q=batches, tx=tx)

        cur.execute(
            "SELECT (a.cntr_value * 1.0 / NULLIF(b.cntr_value, 0)) * 100 "
            "FROM sys.dm_os_performance_counters a "
            "JOIN sys.dm_os_performance_counters b "
            "  ON b.counter_name = 'Buffer cache hit ratio base' AND b.object_name = a.object_name "
            "WHERE a.counter_name = 'Buffer cache hit ratio'")
        row = cur.fetchone()
        cache = float(row[0] or 0) if row else 0.0

        metrics = {
            "host_cpu": 0.0, "host_memory": 0.0, "db_cpu": 0.0,
            "active_sessions": 0, "connections_used": 0,
            "connections_max": max_conn, "cache_hit_pct": round(cache, 1),
            "qps": round(qps, 1), "tps": round(tps, 1), "uptime_seconds": uptime,
        }

        top = []
        try:
            cur.execute(
                "SELECT TOP 20 CONVERT(VARCHAR(64), qs.query_hash, 1), "
                "LEFT(SUBSTRING(st.text, (qs.statement_start_offset/2)+1, "
                "  ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) "
                "    ELSE qs.statement_end_offset END - qs.statement_start_offset)/2)+1), 500), "
                "qs.execution_count, qs.total_elapsed_time/1000.0, "
                "(qs.total_elapsed_time / NULLIF(qs.execution_count,0))/1000.0, "
                "qs.total_logical_reads, ISNULL(qs.total_rows,0) "
                "FROM sys.dm_exec_query_stats qs "
                "CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st "
                "ORDER BY qs.total_elapsed_time DESC")
            for sid, txt, cnt, tot, avg, reads, rows in cur.fetchall():
                top.append({
                    "sql_id": (sid or "")[:64], "sql_text": txt or "",
                    "executions": int(cnt or 0), "avg_elapsed_ms": float(avg or 0),
                    "total_ms": float(tot or 0),
                    "rows_examined": float(reads or 0), "rows_sent": float(rows or 0),
                })
        except Exception:  # noqa: BLE001 — needs VIEW SERVER STATE
            pass

        sessions = []
        try:
            cur.execute(
                "SELECT s.session_id, s.login_name, ISNULL(s.host_name,''), "
                "ISNULL(DB_NAME(s.database_id),''), s.status, ISNULL(r.status,''), "
                "ISNULL(r.total_elapsed_time,0), ISNULL(t.text,'') "
                "FROM sys.dm_exec_sessions s "
                "LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id "
                "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t "
                "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID")
            for sid, usr, hostn, dbn, sstat, rstat, dur, q in cur.fetchall():
                sessions.append({
                    "session_id": str(sid), "username": usr or "", "client_host": hostn or "",
                    "db_name": dbn or "", "command": rstat or "", "duration_ms": float(dur or 0),
                    "state": (rstat or sstat or ""), "query": (q or "")[:1000],
                })
        except Exception:  # noqa: BLE001
            pass
        # Make the metric agree with the list: active = sessions with a live request.
        metrics["active_sessions"] = sum(1 for s in sessions if (s["command"] or "").lower() in ("running", "runnable", "suspended"))
        metrics["connections_used"] = len(sessions) or metrics["connections_used"]
        return metrics, top, sessions
    finally:
        conn.close()


def main():
    token, url = _resolve_config()
    if not token or not url:
        _log("ERROR: token/URL not configured (registry, --args, or env).")
        return 1

    interval = int(os.environ.get("ACTMON_INTERVAL", "30") or 30)
    host = socket.gethostname()
    _log(f"ActMon Agent starting on {host} -> {url}")

    # Fetch the exact collector command the backend expects (no drift vs SSH).
    collector_ps = None
    while collector_ps is None:
        try:
            collector_ps = _get_text(f"{url}/agents/collector/windows")
        except Exception as e:  # noqa: BLE001
            _log(f"cannot reach backend ({e}); retry in 10s")
            time.sleep(10)

    # Identity for DB metric pushes (enroll returns the agent name for this token).
    agent_name = None
    db_state = {}

    while True:
        # 1) Host infra (always). The response tells us this agent's name.
        try:
            raw = collect_windows(collector_ps)
            res = _post(f"{url}/agents/infra", {"token": token, "os_type": "windows", "raw": raw})
            agent_name = res.get("agent_name") or agent_name
            _log(f"infra pushed -> {res.get('status')}")
        except Exception as e:  # noqa: BLE001
            _log(f"infra push failed: {e}")

        # 2) DB internals for any DBs the wizard assigned to this agent.
        try:
            targets = _get_json(f"{url}/agents/db-config?token={token}")
        except Exception:  # noqa: BLE001
            targets = []
        if targets and agent_name:
            for tgt in targets:
                dbt = (tgt.get("db_type") or "").lower()
                key = f"{dbt}:{tgt.get('host')}:{tgt.get('port')}"
                stt = db_state.setdefault(key, {})
                try:
                    if dbt in ("mysql", "mariadb"):
                        metrics, top, sessions = collect_mysql(tgt, stt)
                    elif dbt in ("postgresql", "postgres"):
                        metrics, top, sessions = collect_postgres(tgt, stt)
                    elif dbt in ("mssql", "sql server", "sqlserver"):
                        metrics, top, sessions = collect_mssql(tgt, stt)
                    else:
                        continue   # MySQL / PostgreSQL / MSSQL implemented so far
                    _post(f"{url}/agents/data", {"agent_name": agent_name, "metrics": metrics,
                                                 "top_sql": top, "sessions": sessions})
                    _log(f"{dbt} pushed: qps={metrics['qps']} sessions={metrics['active_sessions']} conns={len(sessions)} top={len(top)}")
                except Exception as e:  # noqa: BLE001
                    _log(f"{dbt} collect failed: {e}")

        time.sleep(max(5, interval))


if __name__ == "__main__":
    sys.exit(main())
