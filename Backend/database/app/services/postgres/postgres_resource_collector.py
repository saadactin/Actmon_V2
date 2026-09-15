"""
PostgreSQL resource history collector (background thread).

Every INTERVAL seconds it SSHes each PostgreSQL host, logs a CPU/RAM/Disk sample,
and — when utilization crosses a threshold — also captures the full process list
and active queries as 'evidence' so the spike can be analysed later (historical RCA).

Samples are kept for RETAIN_DAYS, then pruned. Table is created on startup.
"""
import json
import threading

from sqlalchemy import text

from app.database.connection import SessionLocal, engine
from app.models.connection_model import ConnectionMaster
from app.services import drilldown_service as dd

INTERVAL_SECONDS = 60
CPU_EVENT_PCT = 70.0
RAM_EVENT_PCT = 85.0
RETAIN_DAYS = 7

_started = False
_lock = threading.Lock()

_DDL = [
    """CREATE TABLE IF NOT EXISTS resource_samples (
        id            BIGSERIAL PRIMARY KEY,
        org_id        INTEGER NOT NULL DEFAULT 1,
        connection_id INTEGER NOT NULL,
        db_type       VARCHAR(50) DEFAULT 'postgresql',
        captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        cpu_pct       NUMERIC,
        ram_pct       NUMERIC,
        disk_pct      NUMERIC,
        is_event      BOOLEAN NOT NULL DEFAULT false,
        evidence      JSONB
    )""",
    "CREATE INDEX IF NOT EXISTS idx_resource_samples_conn_time ON resource_samples (connection_id, captured_at DESC)",
]


def _ensure_table():
    with engine.begin() as c:
        for stmt in _DDL:
            c.exec_driver_sql(stmt)


def _tech_of(db_type: str) -> str:
    t = (db_type or "").lower()
    return "mysql" if t == "mariadb" else t


def _sample_one(db, conn):
    tech = _tech_of(conn.db_type)
    cfg = dd.TECH.get(tech)
    if not cfg:
        return

    # Host monitored by an ActMon agent → use the metrics the agent actually
    # pushed. This MUST come before the local-host shortcut below: an
    # agent-linked connection's "localhost" means the AGENT's machine, not
    # the ActMon backend server — psutil here would silently sample the
    # WRONG box (this exact bug shipped briefly: a Windows DB reached via its
    # agent was reported as whatever the Linux backend's own CPU was doing).
    #
    # Prefer the ENGINE'S OWN process share (e.g. just mysqld, not the whole
    # Windows box) so two engines sharing one agent host show different,
    # technology-specific numbers — matching what Task Manager shows per
    # process. Falls back to whole-host metrics if the agent hasn't sent a
    # process list yet, or none of it matches this engine's process names.
    am = dd._agent_tech_metrics(conn.id, tech, db) or dd._agent_host_metrics(conn.id, db)
    if am:
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO resource_samples (org_id, connection_id, db_type, cpu_pct, ram_pct, disk_pct, is_event, evidence) "
                "VALUES (:o, :cid, :dbt, :cpu, :ram, :disk, false, NULL)"
            ), {"o": getattr(conn, "org_id", 1) or 1, "cid": conn.id, "dbt": (conn.db_type or "").lower(),
                "cpu": am.get("cpu_pct"), "ram": am.get("ram_pct"), "disk": am.get("disk_pct")})
        return

    # DB genuinely on this same machine (no agent involved) → read real host
    # CPU/RAM/disk with psutil, the same shortcut the instant host-metrics
    # endpoint already takes. Without this, a true-local connection has no
    # SSH credentials to fall back on, `_ssh_connect` always raises, and this
    # function returns before ever writing a row.
    if dd._is_local_host(conn.host):
        m = dd._local_host_metrics()
        if not m:
            return
        with engine.begin() as c:
            c.execute(text(
                "INSERT INTO resource_samples (org_id, connection_id, db_type, cpu_pct, ram_pct, disk_pct, is_event, evidence) "
                "VALUES (:o, :cid, :dbt, :cpu, :ram, :disk, false, NULL)"
            ), {"o": getattr(conn, "org_id", 1) or 1, "cid": conn.id, "dbt": (conn.db_type or "").lower(),
                "cpu": m.get("cpu_pct"), "ram": m.get("ram_pct"), "disk": m.get("disk_pct")})
        return

    try:
        ssh = dd._ssh_connect(conn, db)   # resolves connection creds or matching OS server
    except Exception:
        return  # no SSH path → can't sample this host
    cpu = ram = disk = None
    evidence = None
    try:
        cpu = dd._num(dd._run(ssh, "top -bn1 | grep -i 'Cpu(s)' | awk '{print $2+$4}'"))
        ram = dd._num(dd._run(ssh, "free -m | awk 'NR==2{printf \"%.1f\", $3*100/$2}'"))
        disk = dd._num(dd._run(ssh, "df -h / | awk 'NR==2{print $5}'"))
        is_event = (cpu is not None and cpu >= CPU_EVENT_PCT) or (ram is not None and ram >= RAM_EVENT_PCT)
        if is_event:
            cores = dd._num(dd._run(ssh, "nproc"), int) or 1
            procs = dd._collect(ssh, cores, cfg["procs"])
            evidence = {"engine": tech, "top_processes": sorted(procs, key=lambda r: r.get("cpu_pct") or 0, reverse=True)[:15]}
    finally:
        ssh.close()

    if evidence is not None:
        try:
            evidence["active_sessions_list"] = dd._active_sessions(tech, conn)[:10]
        except Exception:
            pass

    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO resource_samples (org_id, connection_id, db_type, cpu_pct, ram_pct, disk_pct, is_event, evidence) "
            "VALUES (:o, :cid, :dbt, :cpu, :ram, :disk, :ev, CAST(:evi AS jsonb))"
        ), {"o": getattr(conn, "org_id", 1) or 1, "cid": conn.id, "dbt": (conn.db_type or "").lower(),
            "cpu": cpu, "ram": ram, "disk": disk,
            "ev": bool(evidence is not None),
            "evi": json.dumps(evidence, default=str) if evidence else None})


def _tick():
    db = SessionLocal()
    try:
        conns = db.query(ConnectionMaster).all()
        for conn in conns:
            try:
                _sample_one(db, conn)
            except Exception as e:
                print(f"[ResColl] conn {conn.id}: {e}")
        with engine.begin() as c:
            c.exec_driver_sql(f"DELETE FROM resource_samples WHERE captured_at < now() - interval '{RETAIN_DAYS} days'")
    finally:
        db.close()


def start_resource_collector():
    global _started
    with _lock:
        if _started:
            return
        _started = True
    try:
        _ensure_table()
    except Exception as e:
        print(f"[ResColl] table init failed: {e}")

    def _worker():
        while True:
            threading.Event().wait(INTERVAL_SECONDS)
            try:
                _tick()
            except Exception as e:
                print(f"[ResColl] tick error: {e}")

    threading.Thread(target=_worker, daemon=True).start()
    print("[ResColl] PostgreSQL resource history collector started.")
