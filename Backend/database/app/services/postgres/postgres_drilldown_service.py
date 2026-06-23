"""
PostgreSQL Resource Drill-Down (SolarWinds-style), on-demand.

  Level 1  host_metrics      → live CPU / RAM / Disk of the DB host (SSH)
  Level 2  processes         → top OS processes by CPU or memory (SSH), DB ones tagged
  Level 3  process_sessions  → pg_stat_activity rows for an OS pid (pid == backend pid)
  Level 4  session_detail    → full query text, waits, blockers, EXPLAIN plan (SELECT only)

SSH uses the connection's ssh_host/ssh_port/ssh_user/ssh_password. The OS pid of a
PostgreSQL backend equals pg_stat_activity.pid, which is what makes the
process → exact query mapping precise.
"""
import socket
from typing import Optional

import paramiko
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer
from app.services.postgres.postgres_connection_service import _pg_engine, _get_conn_or_404


# ──────────────────────────────────────────────────────────────────────────────
# SSH helpers
# ──────────────────────────────────────────────────────────────────────────────

def _resolve_ssh(conn, db):
    """SSH creds for the DB host. Prefer the connection's own ssh_* fields; if absent,
    fall back to the matching OS server (same IP) whose SSH creds power its CPU refresh."""
    host = conn.ssh_host or conn.host
    port = conn.ssh_port or 22
    user = conn.ssh_user
    pwd = conn.ssh_password
    if not (user and pwd) and db is not None:
        srv = (db.query(OsServer)
                 .filter(OsServer.ip_address.in_([h for h in [conn.host, conn.ssh_host] if h]),
                         OsServer.ssh_username.isnot(None))
                 .first())
        if srv and srv.ssh_username and srv.ssh_password:
            host = srv.ip_address
            port = srv.ssh_port or 22
            user = srv.ssh_username
            pwd = srv.ssh_password
    return host, port, user, pwd


def _ssh_connect(conn, db=None):
    host, port, user, pwd = _resolve_ssh(conn, db)
    if not host or not user or not pwd:
        raise HTTPException(
            status_code=400,
            detail="SSH credentials not configured. Add SSH host/user/password to this connection, or register the host as an OS Server with SSH creds.",
        )
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(hostname=host, port=int(port or 22), username=user, password=pwd, timeout=10)
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=400, detail="SSH authentication failed — check the SSH username/password.")
    except (socket.timeout, TimeoutError):
        raise HTTPException(status_code=400, detail=f"SSH timeout — cannot reach {host}:{port}.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"SSH connection failed: {e}")
    return ssh


def _run(ssh, cmd: str) -> str:
    try:
        _, out, _ = ssh.exec_command(cmd, timeout=8)
        return out.read().decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _num(s, cast=float):
    try:
        return cast(str(s).replace("%", "").strip())
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Level 1 — host CPU / RAM / Disk
# ──────────────────────────────────────────────────────────────────────────────

def host_metrics(connection_id: int, db: Session) -> dict:
    conn = _get_conn_or_404(connection_id, db)
    ssh = _ssh_connect(conn, db)
    try:
        cpu = _num(_run(ssh, "top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}'"))
        ram_used = _num(_run(ssh, "free -m | awk 'NR==2{print $3}'"))
        ram_total = _num(_run(ssh, "free -m | awk 'NR==2{print $2}'"))
        disk = _num(_run(ssh, "df -h / | awk 'NR==2{print $5}'"))
        load = _run(ssh, "cat /proc/loadavg | awk '{print $1\" \"$2\" \"$3}'")
        cores = _num(_run(ssh, "nproc"), int)
        ram_pct = round(ram_used / ram_total * 100, 1) if ram_used and ram_total else None
    finally:
        ssh.close()
    return {
        "cpu_pct": cpu,
        "ram_pct": ram_pct,
        "ram_used_mb": ram_used,
        "ram_total_mb": ram_total,
        "disk_pct": disk,
        "load_avg": load,
        "cpu_cores": cores,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Level 2 — top OS processes
# ──────────────────────────────────────────────────────────────────────────────

def _res_to_mb(s):
    s = str(s).strip().lower()
    try:
        if s.endswith("g"): return round(float(s[:-1]) * 1024, 1)
        if s.endswith("m"): return round(float(s[:-1]), 1)
        if s.endswith("t"): return round(float(s[:-1]) * 1024 * 1024, 1)
        if s.endswith("k"): return round(float(s[:-1]) / 1024, 1)
        return round(float(s) / 1024, 1)  # plain KiB
    except Exception:
        return None


def _collect_processes(ssh, cores: int):
    """Real-time process snapshot via `top -bn2` (the 2nd iteration is an accurate delta).
    %CPU from top is per-core, so we divide by core count → each value is a share of the
    TOTAL host CPU and the column sums to <=100%. Our own `top` process is excluded."""
    cores = max(cores or 1, 1)
    raw = _run(ssh, "top -bn2 -d 0.6 -w 512 | awk 'BEGIN{p=0} /^[[:space:]]*PID/{p++} {if(p==2)print}'")
    rows = []
    for line in raw.splitlines():
        parts = line.split(None, 11)
        if len(parts) < 12:
            continue
        pid = parts[0]
        if not pid.isdigit():
            continue  # header / blank
        cmd = parts[11].strip()
        if cmd in ("top", "(top)"):
            continue
        pcpu = _num(parts[8]) or 0.0
        rows.append({
            "pid": int(pid),
            "user": parts[1],
            "cpu_pct": round(min(pcpu / cores, 100.0), 1),  # share of TOTAL host CPU
            "mem_pct": _num(parts[9]),
            "rss_mb": _res_to_mb(parts[5]),
            "command": cmd,
            "cmdline": cmd,
            "is_db": "postgres" in cmd.lower(),
        })
    return rows


def processes(connection_id: int, db: Session, sort: str = "cpu", limit: int = 25) -> dict:
    conn = _get_conn_or_404(connection_id, db)
    ssh = _ssh_connect(conn, db)
    cores = _num(_run(ssh, "nproc"), int) or 1
    rows = _collect_processes(ssh, cores)
    ssh.close()

    key = "mem_pct" if sort == "mem" else "cpu_pct"
    rows.sort(key=lambda r: r.get(key) or 0, reverse=True)
    rows = rows[: int(limit)]

    system_cpu = round(min(sum((r["cpu_pct"] or 0) for r in rows), 100.0), 1)
    db_cpu = round(sum((r["cpu_pct"] or 0) for r in rows if r["is_db"]), 1)
    db_mem = round(sum((r["mem_pct"] or 0) for r in rows if r["is_db"]), 1)
    return {
        "processes": rows, "sort": sort, "cpu_cores": cores,
        "system_cpu_pct": system_cpu, "db_cpu_pct": db_cpu, "db_mem_pct": db_mem,
    }


# ──────────────────────────────────────────────────────────────────────────────
# Level 3 — which queries that pid (or the whole engine) is running
# ──────────────────────────────────────────────────────────────────────────────

_ACTIVITY_COLS = """
    pid, usename, datname, client_addr::text AS client_addr, state,
    wait_event_type, wait_event, backend_type,
    ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 1) AS query_seconds,
    ROUND(EXTRACT(EPOCH FROM (now() - xact_start))::numeric, 1) AS xact_seconds,
    query
"""


def process_sessions(connection_id: int, pid: int, db: Session) -> dict:
    conn = _get_conn_or_404(connection_id, db)
    eng = _pg_engine(conn)
    with eng.connect() as c:
        rows = c.execute(text(f"SELECT {_ACTIVITY_COLS} FROM pg_stat_activity WHERE pid = :p"),
                         {"p": pid}).mappings().all()
        matched = bool(rows)
        if not rows:
            # pid was the postmaster / a non-backend → show all active backends instead
            rows = c.execute(text(
                f"SELECT {_ACTIVITY_COLS} FROM pg_stat_activity "
                "WHERE state IS DISTINCT FROM 'idle' AND backend_type = 'client backend' "
                "AND pid <> pg_backend_pid() ORDER BY query_start ASC NULLS LAST LIMIT 50"
            )).mappings().all()
    sessions = [dict(r) for r in rows]
    limited = any((s.get("query") or "") == "<insufficient privilege>" for s in sessions)
    return {"pid": pid, "matched_pid": matched, "sessions": sessions, "limited": limited}


# ──────────────────────────────────────────────────────────────────────────────
# Level 4 — why is this query consuming? (text, waits, blockers, plan)
# ──────────────────────────────────────────────────────────────────────────────

def session_detail(connection_id: int, pid: int, db: Session) -> dict:
    conn = _get_conn_or_404(connection_id, db)
    eng = _pg_engine(conn)
    with eng.connect() as c:
        row = c.execute(text(
            f"SELECT {_ACTIVITY_COLS}, pg_blocking_pids(pid) AS blocked_by, "
            "backend_start, xact_start, query_start "
            "FROM pg_stat_activity WHERE pid = :p"
        ), {"p": pid}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="No active session for this pid (it may have finished).")
        detail = {k: (str(v) if v is not None and not isinstance(v, (int, float, list, bool)) else v)
                  for k, v in dict(row).items()}

        plan = None
        q = (row["query"] or "").strip()
        if q.lower().startswith("select") and "$1" not in q:
            try:
                with c.begin():  # savepoint; EXPLAIN (no ANALYZE) does not execute the query
                    plan_rows = c.execute(text("EXPLAIN " + q)).fetchall()
                plan = "\n".join(r[0] for r in plan_rows)
            except Exception as e:
                plan = f"(plan unavailable: {str(e).splitlines()[0]})"
        elif "$1" in q:
            plan = "(plan unavailable: query uses bind parameters)"
    return {"detail": detail, "plan": plan, "limited": q == "<insufficient privilege>"}


def history(connection_id: int, db: Session, hours: int = 6) -> dict:
    rows = db.execute(text(
        "SELECT id, captured_at, cpu_pct, ram_pct, disk_pct, is_event "
        "FROM resource_samples WHERE connection_id = :c "
        "AND captured_at >= now() - make_interval(hours => :h) ORDER BY captured_at"
    ), {"c": connection_id, "h": int(hours)}).mappings().all()
    return {"samples": [{
        "id": r["id"], "captured_at": str(r["captured_at"]),
        "cpu_pct": float(r["cpu_pct"]) if r["cpu_pct"] is not None else None,
        "ram_pct": float(r["ram_pct"]) if r["ram_pct"] is not None else None,
        "disk_pct": float(r["disk_pct"]) if r["disk_pct"] is not None else None,
        "is_event": r["is_event"],
    } for r in rows]}


def _sample_row(connection_id: int, sample_id: int, db: Session):
    row = db.execute(text(
        "SELECT id, captured_at, cpu_pct, ram_pct, disk_pct, is_event, evidence "
        "FROM resource_samples WHERE id = :i AND connection_id = :c"
    ), {"i": sample_id, "c": connection_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Sample not found.")
    return row


def history_detail(connection_id: int, sample_id: int, db: Session) -> dict:
    row = _sample_row(connection_id, sample_id, db)
    ev = row["evidence"] or {}
    return {
        "id": row["id"], "captured_at": str(row["captured_at"]),
        "cpu_pct": float(row["cpu_pct"]) if row["cpu_pct"] is not None else None,
        "ram_pct": float(row["ram_pct"]) if row["ram_pct"] is not None else None,
        "disk_pct": float(row["disk_pct"]) if row["disk_pct"] is not None else None,
        "is_event": row["is_event"],
        "top_processes": ev.get("top_processes", []),
        "active_sessions": ev.get("active_sessions_list", []),
        "cache_hit_pct": ev.get("cache_hit_pct"),
    }


def history_rca(connection_id: int, sample_id: int, db: Session, resource: str = "cpu") -> dict:
    conn = _get_conn_or_404(connection_id, db)
    row = _sample_row(connection_id, sample_id, db)
    ev_stored = row["evidence"] or {}
    procs = ev_stored.get("top_processes", [])
    util = float(row["cpu_pct"] or 0) if resource == "cpu" else float(row["ram_pct"] or 0)
    mkey = "cpu_pct" if resource == "cpu" else "mem_pct"
    db_share = round(sum((p.get(mkey) or 0) for p in procs if p.get("is_db")), 1)
    ext_share = round(min(sum((p.get(mkey) or 0) for p in procs if not p.get("is_db")), 100.0), 1)
    is_db_related = db_share >= ext_share
    top_ext = next((p for p in sorted(procs, key=lambda x: x.get(mkey) or 0, reverse=True) if not p.get("is_db")), None)
    evidence = {
        "resource": resource, "host_util_pct": util,
        "db_share_pct": db_share, "external_share_pct": ext_share,
        "top_processes": procs, "target_process": None, "top_external_process": top_ext,
        "active_sessions": len(ev_stored.get("active_sessions_list", []) or []),
        "active_sessions_list": ev_stored.get("active_sessions_list", []),
        "cache_hit_pct": ev_stored.get("cache_hit_pct"),
        "captured_at": str(row["captured_at"]), "historical": True,
    }
    severity = _severity(util)
    title = _rca_title(resource, severity, util)
    rca_obj = _groq_rca(conn, evidence, is_db_related, resource, severity, util)
    rca_obj["severity"] = severity
    rca_obj["title"] = title
    rca_obj["host_util_pct"] = util
    return {"is_db_related": is_db_related, "severity": severity, "evidence": evidence,
            "rca": rca_obj, "captured_at": str(row["captured_at"])}


def grant_monitor(connection_id: int, db: Session) -> dict:
    """Grant pg_monitor to the monitoring user so it can see every session's query text.
    Best-effort: works only if the connection user is a superuser / has ADMIN on pg_monitor."""
    conn = _get_conn_or_404(connection_id, db)
    user = conn.username
    eng = _pg_engine(conn)
    try:
        with eng.connect() as c:
            with c.begin():
                c.execute(text(f'GRANT pg_monitor TO "{user}"'))
        return {"status": "success", "message": f"Granted pg_monitor to \"{user}\". Full query visibility is now enabled."}
    except Exception as e:
        return {
            "status": "failed",
            "message": f"Couldn't auto-grant — this requires a superuser. Ask your DBA to run the command below. ({str(e).splitlines()[0]})",
            "manual_sql": f'GRANT pg_monitor TO "{user}";',
            "manual_shell": f"sudo -u postgres psql -d {conn.database_name or 'postgres'} -c 'GRANT pg_monitor TO \"{user}\";'",
        }


# ──────────────────────────────────────────────────────────────────────────────
# RCA — Root Cause Analysis report (evidence + Groq narrative)
# ──────────────────────────────────────────────────────────────────────────────

def _safe_rows(c, sql, params=None):
    try:
        return [dict(r) for r in c.execute(text(sql), params or {}).mappings().all()]
    except Exception:
        return []


def _safe_scalar(c, sql):
    try:
        return c.execute(text(sql)).scalar()
    except Exception:
        return None


def rca(connection_id: int, db: Session, pid: Optional[int] = None, resource: str = "cpu",
        target_cmd: Optional[str] = None) -> dict:
    conn = _get_conn_or_404(connection_id, db)

    # ── 1) Host process snapshot → is the pressure DB or external? ──
    ssh = _ssh_connect(conn, db)
    cores = _num(_run(ssh, "nproc"), int) or 1
    all_procs = _collect_processes(ssh, cores)
    if resource == "cpu":
        host_util = _num(_run(ssh, "top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}'"))
    else:
        host_util = _num(_run(ssh, "free -m | awk 'NR==2{printf \"%.1f\", $3*100/$2}'"))
    ssh.close()

    metric = "cpu_pct" if resource == "cpu" else "mem_pct"
    # shares computed over the FULL snapshot (normalized to total host = <=100%)
    db_share = round(sum((p[metric] or 0) for p in all_procs if p["is_db"]), 1)
    ext_share = round(min(sum((p[metric] or 0) for p in all_procs if not p["is_db"]), 100.0), 1)
    top_procs = sorted(all_procs, key=lambda r: r.get(metric) or 0, reverse=True)[:10]
    top_ext = [p for p in top_procs if not p["is_db"]]

    # If a specific process was clicked, the RCA focuses on IT.
    target = None
    if pid:
        target = next((p for p in all_procs if p["pid"] == pid), None)
    if target is None and target_cmd:
        target = next((p for p in all_procs if p["command"] == target_cmd), None)

    if target is not None:
        is_db_related = target["is_db"]
    else:
        is_db_related = db_share >= ext_share
    top_external_proc = target if (target is not None and not target["is_db"]) else (top_ext[0] if top_ext else None)

    # ── 2) PostgreSQL evidence ──
    eng = _pg_engine(conn)
    with eng.connect() as c:
        cache_hit = _safe_scalar(c, "SELECT round(sum(blks_hit)*100.0/nullif(sum(blks_hit+blks_read),0),2) FROM pg_stat_database")
        active = _safe_scalar(c, "SELECT count(*) FROM pg_stat_activity WHERE state='active'")
        idle_in_txn = _safe_scalar(c, "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction'")
        db_size = _safe_scalar(c, "SELECT pg_size_pretty(pg_database_size(current_database()))")
        top_statements = _safe_rows(c,
            "SELECT left(query, 300) AS query, calls, round(total_exec_time::numeric,1) AS total_ms, "
            "round(mean_exec_time::numeric,1) AS mean_ms, rows FROM pg_stat_statements "
            "ORDER BY total_exec_time DESC LIMIT 5")
        seq_tables = _safe_rows(c,
            "SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan, n_live_tup "
            "FROM pg_stat_user_tables WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 5")
        long_running = _safe_rows(c,
            "SELECT pid, usename, state, wait_event, "
            "round(EXTRACT(EPOCH FROM (now()-query_start))::numeric,1) AS seconds, left(query,300) AS query "
            "FROM pg_stat_activity WHERE state='active' AND query_start IS NOT NULL "
            "ORDER BY query_start ASC LIMIT 5")
        blockers = _safe_rows(c,
            "SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query,200) AS query "
            "FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 LIMIT 5")
        focus_query = None
        if pid:
            fr = _safe_rows(c, f"SELECT {_ACTIVITY_COLS} FROM pg_stat_activity WHERE pid=:p", {"p": pid})
            focus_query = fr[0] if fr else None

    # tables likely missing an index = lots of seq reads, few/no index scans
    index_candidates = [t for t in seq_tables if (t.get("idx_scan") or 0) == 0 and (t.get("seq_tup_read") or 0) > 10000]

    evidence = {
        "resource": resource,
        "host_util_pct": host_util,
        "db_share_pct": db_share, "external_share_pct": ext_share,
        "top_processes": top_procs,
        "target_process": target,
        "top_external_process": top_external_proc,
        "cache_hit_pct": cache_hit, "active_sessions": active, "idle_in_transaction": idle_in_txn,
        "db_size": db_size,
        "top_statements": top_statements,
        "high_seq_scan_tables": seq_tables,
        "index_candidates": index_candidates,
        "long_running": long_running,
        "blockers": blockers,
        "focus_query": focus_query,
    }

    # ── 3) Severity + title are DETERMINISTIC, from the real utilization ──
    severity = _severity(host_util)
    title = _rca_title(resource, severity, host_util)

    # ── 4) Groq narrative (graceful fallback if no key); severity/title are forced ──
    rca_obj = _groq_rca(conn, evidence, is_db_related, resource, severity, host_util)
    rca_obj["severity"] = severity
    rca_obj["title"] = title
    rca_obj["host_util_pct"] = host_util
    return {"is_db_related": is_db_related, "severity": severity, "evidence": evidence, "rca": rca_obj}


def _severity(util_pct) -> str:
    """Severity strictly from measured host utilization (so 12% CPU is never 'Medium')."""
    if util_pct is None:
        return "Low"
    if util_pct >= 90:
        return "Critical"
    if util_pct >= 70:
        return "High"
    if util_pct >= 40:
        return "Medium"
    return "Low"


def _rca_title(resource: str, severity: str, util_pct) -> str:
    r = "CPU" if resource == "cpu" else "Memory"
    pct = f"{util_pct}%" if util_pct is not None else "n/a"
    return {
        "Low": f"{r} Healthy — No Pressure ({pct})",
        "Medium": f"Elevated {r} Usage ({pct})",
        "High": f"High {r} Pressure ({pct})",
        "Critical": f"Critical {r} Saturation ({pct})",
    }[severity]


def _groq_rca(conn, evidence: dict, is_db_related: bool, resource: str, severity: str = "Medium", host_util=None) -> dict:
    import json as _json
    from app.services.chatbot.ai_engine import chat_once

    sys = (
        "You are a senior PostgreSQL DBA writing an executive Root-Cause-Analysis (RCA) report, "
        "in the style used by enterprise banks (Citi/HSBC). Be precise, evidence-based and actionable. "
        "Respond with ONLY a JSON object, no markdown, matching exactly this schema: "
        '{"severity":"Low|Medium|High|Critical","issue":"one-line problem statement",'
        '"root_cause":"2-4 sentence explanation grounded in the evidence",'
        '"evidence_summary":["bullet strings citing the numbers"],'
        '"immediate_actions":["..."],"permanent_solution":["..."],"precautions":["..."],'
        '"is_db_related":true}'
    )
    tgt = evidence.get("target_process")
    focus = ""
    if tgt:
        focus = (
            f"\nFOCUS PROCESS the user clicked: command='{tgt.get('command')}', pid={tgt.get('pid')}, "
            f"user={tgt.get('user')}, cpu={tgt.get('cpu_pct')}% mem={tgt.get('mem_pct')}%, is_db={tgt.get('is_db')}.\n"
            "Center the whole RCA on THIS process: explain what this program is "
            "(e.g. 'etcd' = distributed key-value store for clusters/Kubernetes; 'kworker' = kernel thread; etc.), "
            "why it consumes this resource, and whether it has anything to do with PostgreSQL. "
            "If it is not PostgreSQL, clearly state the database is not the cause and give host-level advice "
            "(isolate the workload, move it off the DB host, tune that service)."
        )
    user = (
        f"Resource: {resource.upper()}. MEASURED host {resource} utilization = {host_util}% (this is the WHOLE host, already normalized to 100%).\n"
        f"Pre-computed severity = {severity}. Treat this severity as authoritative — your narrative MUST agree with it. "
        f"If utilization is low (e.g. under 40%), explicitly state there is NO performance problem and keep recommendations preventive/light.\n"
        f"DB share of {resource}: {evidence['db_share_pct']}% vs external processes: {evidence['external_share_pct']}%.\n"
        f"is_db_related={is_db_related}.{focus}\n"
        f"Evidence JSON:\n{_json.dumps(evidence, default=str)[:6000]}\n\n"
        "If is_db_related is false, the root cause is a non-database OS process — name it "
        "and say PostgreSQL is a victim, not the cause. If true, pinpoint the queries/tables/indexes responsible. "
        "Recommend concrete fixes (specific indexes, query rewrites, autovacuum, connection limits). Output JSON only."
    )
    try:
        raw = chat_once([{"role": "system", "content": sys}, {"role": "user", "content": user}])
        s, e = raw.find("{"), raw.rfind("}")
        obj = _json.loads(raw[s:e + 1]) if s >= 0 and e > s else {}
        if obj:
            obj.setdefault("is_db_related", is_db_related)
            return obj
    except Exception as ex:
        # fall through to deterministic fallback
        _ = ex

    # Deterministic fallback when Groq is unavailable
    healthy = severity == "Low"
    if is_db_related:
        return {
            "severity": severity,
            "issue": (f"{resource.upper()} is healthy at {host_util}% — no action required."
                      if healthy else f"PostgreSQL is the largest consumer of {resource.upper()} on the host ({host_util}%)."),
            "root_cause": ("Host utilization is low; the database is operating normally."
                           if healthy else "Database workload is driving resource usage — see the top statements and high-sequential-scan tables in the evidence."),
            "evidence_summary": [
                f"Host {resource} utilization: {host_util}%.",
                f"DB processes account for {evidence.get('db_share_pct')}% of {resource}.",
                f"Cache hit ratio: {evidence.get('cache_hit_pct')}%. Active sessions: {evidence.get('active_sessions')}.",
            ],
            "immediate_actions": (["None — system is within normal limits."] if healthy
                                  else ["Identify and (if safe) cancel the longest-running query.", "Check for blocking locks."]),
            "permanent_solution": (["Keep monitoring; no change needed."] if healthy
                                  else [f"Add indexes on heavy sequential-scan tables: {', '.join(t['relname'] for t in (evidence.get('index_candidates') or [])) or 'none detected'}.",
                                        "Tune slow statements shown in pg_stat_statements."]),
            "precautions": ["Enable pg_stat_statements monitoring.", "Set statement_timeout and review autovacuum."],
            "is_db_related": True,
        }
    return {
        "severity": severity,
        "issue": f"{resource.upper()} pressure is from a non-database process.",
        "root_cause": f"The top {resource} consumer is '{(evidence.get('top_external_process') or {}).get('command', 'an external process')}', not PostgreSQL.",
        "evidence_summary": [f"External processes account for {evidence.get('external_share_pct')}% of {resource} vs {evidence.get('db_share_pct')}% for the DB."],
        "immediate_actions": ["Investigate the external process owner/command on the host."],
        "permanent_solution": ["Isolate the database host from unrelated workloads, or schedule the offending job off-peak."],
        "precautions": ["Avoid co-locating batch/backup jobs with the primary DB host."],
        "is_db_related": False,
    }
