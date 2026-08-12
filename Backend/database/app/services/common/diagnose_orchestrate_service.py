"""
ActMon Diagnosis Window — orchestrator.

Single entry point the frontend's shared Diagnosis window calls. Wraps the
existing per-purpose services (diagnose_engine's cross-technology Linux
checks, host_action_service's cross-OS service/connectivity checks, each
engine's own dashboard/error-log services, alert/notification history) into
ONE normalized response so the frontend never branches on db_type or os_type
— it renders the same 14 sections from the same shape every time, and a
section the current OS/technology genuinely can't support says so honestly
via an `available: false` + `reason` pair rather than being silently empty
or guessed at.

Nothing here invents data. Every field traces to a real row/command output;
where there's no real source, the section says exactly that.
"""
import re
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer, DatabaseInstance
from app.services.common import diagnose_engine as eng

# diagnose_engine now runs its own Linux (bash/systemctl/journalctl/ps/ss) AND
# Windows (PowerShell/Get-Service/Get-WinEvent/Get-CimInstance) command sets —
# see WIN_PROFILES + _win_cmd in diagnose_engine.py. Only OSes neither branch
# recognizes (anything that isn't Linux or Windows) are genuinely unsupported;
# `os_supports_engine_checks` now gates on that instead of Windows specifically.
def os_supports_engine_checks(conn_id: int, db: Session) -> tuple:
    """(supported: bool, os_type: str|None) — whether diagnose_engine's
    step-by-step checks can run against this connection's host at all."""
    ag_row = _agent_row(conn_id, db)
    _, srv = _instance_and_server(conn_id, db)
    os_type = (ag_row.os_type if ag_row else None) or (srv.os_type if srv else None)
    if not os_type:
        return True, None  # unknown OS: don't block, but don't claim certainty either
    ot = os_type.lower()
    return (ot.startswith("lin") or "win" in ot), os_type


_DB_CHECK_IDS = {"db_connection", "db_health", "db_logs"}


def run_check_safe(conn_id: int, check_id: str, db: Session) -> dict:
    """Wraps diagnose_engine.run_check with the OS-support guard above.
    Database-level checks (Connection/Health/Logs — API calls, not shell
    commands) are OS-agnostic, so they dispatch straight to run_db_check
    without the OS-support gate below."""
    if check_id in _DB_CHECK_IDS:
        return run_db_check(conn_id, check_id, db)
    supported, os_type = os_supports_engine_checks(conn_id, db)
    if not supported:
        title = next((c[1] for c in eng.CHECKS if c[0] == check_id), check_id)
        group = next((c[2] for c in eng.CHECKS if c[0] == check_id), "General")
        return {
            "id": check_id, "title": title, "group": group, "status": "skipped",
            "detail": f"Not available for {os_type} yet — checks currently run on Linux and Windows hosts only.",
            "evidence": "", "os_unsupported": True,
        }
    return eng.run_check(conn_id, check_id, db)


def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    return db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()


def _agent_row(conn_id: int, db: Session):
    """Per-connection collector record (Agent model) — status/last_error/
    last_heartbeat/os_type, when this connection is agent-monitored."""
    return db.execute(text(
        "SELECT status, last_error, last_heartbeat, os_type, agent_name "
        "FROM agents WHERE db_connection_id = :c LIMIT 1"
    ), {"c": conn_id}).first()


def _instance_and_server(conn_id: int, db: Session):
    """The OsServer/DatabaseInstance pair backing this connection, when the
    host is registered as an infra server (SSH- or agent-collected) rather
    than a bare direct DB connection. Returns (instance, server) or
    (None, None)."""
    inst = db.query(DatabaseInstance).filter(DatabaseInstance.connection_id == conn_id).first()
    if not inst:
        return None, None
    srv = db.query(OsServer).filter(OsServer.id == inst.server_id).first()
    return inst, srv


def _iso(dt) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc).isoformat()
    return dt.isoformat()


def _duration_seconds(since) -> int | None:
    if not since:
        return None
    now = datetime.now(timezone.utc)
    then = since if since.tzinfo else since.replace(tzinfo=timezone.utc)
    return max(0, int((now - then).total_seconds()))


# ── header + summary ────────────────────────────────────────────────────────

def _build_header(rec: ConnectionMaster, ag_row, inst: DatabaseInstance | None, srv: OsServer | None) -> dict:
    os_type = (ag_row.os_type if ag_row else None) or (srv.os_type if srv else None)
    status_source = None
    current_status = "Unknown"
    down_since = None

    if inst and inst.status:
        current_status = inst.status
        down_since = inst.status_changed_at
        status_source = "database_instances.status"
    elif ag_row and ag_row.status:
        current_status = {"online": "Healthy", "offline": "Offline", "error": "DB Error"}.get(ag_row.status, ag_row.status)
        status_source = "agents.status"

    severity = {
        "Healthy": "Low", "Running": "Low",
        "Warning": "Medium",
        "DB Error": "High", "Stopped": "High",
        "Offline": "Critical", "Down": "Critical",
    }.get(current_status, "Medium")

    return {
        "database_name": rec.connection_name or f"{rec.db_type}-{rec.id}",
        "technology": rec.db_type,
        "host": rec.host,
        "port": rec.port,
        "os_type": os_type,
        "os_supported": (not os_type) or os_type.lower().startswith("lin") or "win" in os_type.lower(),
        "current_status": current_status,
        "status_source": status_source,
        "severity": severity,
        "down_since": _iso(down_since),
        "duration_seconds": _duration_seconds(down_since) if current_status not in ("Healthy", "Running") else None,
    }


def _build_summary(header: dict, rca: dict | None, ag_row) -> dict:
    return {
        "current_status": header["current_status"],
        "primary_diagnosis": (rca or {}).get("root_cause") or "Diagnosis not yet run.",
        "root_cause": (rca or {}).get("root_cause"),
        "confidence": (rca or {}).get("confidence"),
        "detected_at": header["down_since"],
        "last_successful_heartbeat": _iso(ag_row.last_heartbeat) if ag_row else None,
        "last_successful_connection": _iso(ag_row.last_heartbeat) if (ag_row and ag_row.status == "online") else None,
    }


# ── service / process / connectivity ────────────────────────────────────────
#
# There used to be a separate, eager service/connectivity resolver here that
# ran the moment the Diagnosis page loaded. Two problems with that: (1) it's
# exactly the "runs a diagnostic command automatically" behaviour the admin
# now explicitly controls via the check catalogue, and (2) it duplicated the
# step-engine's own "service" and "port" checks (diagnose_engine.py), which
# already delegate service-state resolution to service_state_service.
# get_service_state — the same per-technology-scoped resolver (Windows
# wildcard patterns like "OracleService*", SQL Server's exact per-instance
# name via its own port, never a loose cross-engine text match) and already
# run real commands (systemctl/Get-Service, ss/Get-NetTCPConnection) with
# real output. So "is the service up" / "is the port listening" are now
# answered by running the "service"/"port" checks from `/diagnose/plan`
# explicitly, not by a parallel always-on code path here.


def _test_db_connection(rec: ConnectionMaster, db: Session) -> dict:
    """Real auth+query test against the database itself (not just the TCP
    port) — reuses each engine's existing engine-builder/test function so
    credential/URL handling isn't duplicated here."""
    import time
    tech = (rec.db_type or "").lower()
    t0 = time.monotonic()
    try:
        if tech in ("postgresql", "postgres"):
            from app.services.postgres.postgres_connection_service import _pg_engine
            with _pg_engine(rec).connect() as c:
                c.execute(text("SELECT 1"))
        elif tech in ("mysql", "mariadb"):
            from app.services.mysql.mysql_dashboard_service import _engine as _my_engine
            with _my_engine(rec).connect() as c:
                c.execute(text("SELECT 1"))
        elif tech == "mssql":
            from app.services.mssql.mssql_error_service import _engine as _ms_engine
            with _ms_engine(rec).connect() as c:
                c.execute(text("SELECT 1"))
        elif tech == "oracle":
            from app.services.oracle.oracle_connection_service import test_connection as _ora_test
            _ora_test(rec.id, db)
        elif tech == "mongodb":
            from app.services.mongo.mongo_connection_service import test_connection as _mongo_test
            _mongo_test(rec.id, db)
        elif tech == "clickhouse":
            from app.services.clickhouse.clickhouse_connection_service import test_connection as _ch_test
            _ch_test(rec.id, db)
        else:
            return {"ok": None, "latency_ms": None, "detail": f"No DB connection test wired for '{rec.db_type}' yet."}
    except Exception as e:
        detail = getattr(e, "detail", None) or str(e)
        return {"ok": False, "latency_ms": round((time.monotonic() - t0) * 1000, 1), "detail": str(detail)}
    return {"ok": True, "latency_ms": round((time.monotonic() - t0) * 1000, 1), "detail": "Connected and authenticated successfully."}


# ── host / OS health ─────────────────────────────────────────────────────────

def _build_host_os_health(srv: OsServer | None) -> dict:
    if not srv:
        return {"available": False, "reason": "No registered infra server for this connection."}
    return {
        "available": True,
        "cpu": srv.cpu_usage,
        "memory": srv.ram_usage,
        "disk": srv.disk_usage,
        "uptime": srv.uptime,
        "collected_via": srv.collector,
        "last_updated": _iso(srv.last_infra_at) if srv.collector == "agent" else None,
    }


# ── latest error / logs (dispatches to each engine's own error-log service) ──

def _normalize_log_entry(raw: dict) -> dict:
    msg = raw.get("message") or raw.get("msg") or raw.get("text") or raw.get("Message") or ""
    sev = raw.get("severity") or raw.get("level") or raw.get("Severity") or "INFO"
    ts = raw.get("logged") or raw.get("timestamp") or raw.get("time") or raw.get("Timestamp") or raw.get("created_at")
    return {"timestamp": ts, "severity": str(sev).upper(), "message": msg}


def _dispatch_error_logs(rec: ConnectionMaster, db: Session) -> dict:
    tech = (rec.db_type or "").lower()
    try:
        if tech == "mysql":
            from app.services.mysql.mysql_log_service import get_error_logs
            raw = get_error_logs(rec.id, db)
            entries = raw.get("logs", [])
            return {"available": True, "entries": [_normalize_log_entry(e) for e in entries],
                    "source": raw.get("source"), "log_file": raw.get("log_path")}
        if tech in ("postgresql", "postgres"):
            supported, _os_type = os_supports_engine_checks(rec.id, db)
            if supported:
                from app.services.common.pg_diagnose_service import _agent_token, _agent_shell
                token = _agent_token(rec.id, db)
                if token:
                    tail_script = (
                        'for d in /var/log/postgresql "$PGDATA/log" /var/lib/pgsql/*/data/log '
                        '/var/lib/postgresql/*/main/log; do [ -d "$d" ] && LOG=$(ls -1t "$d"/*.log 2>/dev/null | head -1) '
                        '&& [ -n "$LOG" ] && break; done; echo "LOGFILE:$LOG"; [ -n "$LOG" ] && tail -60 "$LOG" 2>/dev/null'
                    )
                    out = _agent_shell(token, tail_script, timeout=30)
                    if out and "LOGFILE:" in out:
                        logfile_line, _, tail_text = out.partition("\n")
                        log_path = logfile_line.replace("LOGFILE:", "").strip()
                        entries = []
                        for line in tail_text.splitlines():
                            m = re.search(r'\b(FATAL|ERROR|PANIC|WARNING)\b', line)
                            if m:
                                entries.append({"message": line.strip(), "severity": m.group(1)})
                        if log_path:
                            return {"available": True, "entries": [_normalize_log_entry(e) for e in entries],
                                    "source": "postgresql log file", "log_file": log_path}
            # No real PostgreSQL log-file access on this host (Windows, or no agent) —
            # pg_stat_activity is session/query state, not error text, so it is never
            # reported here as an "error" to avoid misrepresenting session data.
            return {"available": False,
                    "reason": "No PostgreSQL error-log source is available on this host yet "
                              "(native log-file reading currently requires a Linux + agent-connected host)."}
        if tech == "mssql":
            from app.services.mssql.mssql_monitoring_service import get_error_logs
            raw = get_error_logs(rec.id, db)
            entries = raw.get("logs") or []
            if not entries:
                return {"available": False, "reason": raw.get("xp_readerrorlog_error") or raw.get("fallback_error") or "No error log entries found."}
            return {"available": True, "entries": [_normalize_log_entry(e) for e in entries], "source": raw.get("source")}
        if tech == "oracle":
            from app.services.oracle.oracle_monitoring_service import oracle_error_logs
            raw = oracle_error_logs(rec.id, db)
            alert_logs = raw.get("alert_logs") or []
            if not alert_logs:
                return {"available": False, "reason": raw.get("note") or "No error log entries found."}
            mapped = [{"message": e.get("message_text") or f"Redo log status: {e.get('status')}",
                       "severity": e.get("message_level"),
                       "timestamp": e.get("originating_timestamp") or e.get("first_time")} for e in alert_logs]
            return {"available": True, "entries": [_normalize_log_entry(e) for e in mapped], "source": raw.get("source")}
        if tech == "mongodb":
            from app.services.mongo.mongo_error_service import get_error_logs
            raw = get_error_logs(rec.id, 20, db)
            entries = raw.get("logs") or raw.get("data") or []
            return {"available": True, "entries": [_normalize_log_entry(e) for e in entries], "source": raw.get("source")}
        if tech == "clickhouse":
            from app.services.clickhouse.clickhouse_error_service import get_error_logs
            raw = get_error_logs(rec.id, 20, db)
            entries = raw.get("logs") or raw.get("data") or []
            return {"available": True, "entries": [_normalize_log_entry(e) for e in entries], "source": raw.get("source")}
    except Exception as e:  # noqa: BLE001 — logs are supplementary, never fail the window over them
        return {"available": False, "reason": f"Could not read error logs: {e}"}
    return {"available": False, "reason": f"No error-log source is wired for '{rec.db_type}' yet."}


def _latest_error_section(log_result: dict) -> dict:
    if not log_result.get("available") or not log_result.get("entries"):
        return {"available": False, "reason": log_result.get("reason") or "No error log entries found."}
    # Prefer the most severe of the most recent entries, not just the last line.
    entries = log_result["entries"]
    order = {"CRITICAL": 0, "FATAL": 0, "ERROR": 1, "WARNING": 2, "INFO": 3}
    pick = sorted(entries, key=lambda e: order.get(e["severity"], 4))[0] if entries else None
    if not pick:
        return {"available": False, "reason": "No error log entries found."}
    return {
        "available": True,
        "timestamp": pick.get("timestamp"),
        "source": log_result.get("source"),
        "severity": pick.get("severity"),
        "message": pick.get("message"),
        "log_file": log_result.get("log_file"),
    }


# ── timeline ──────────────────────────────────────────────────────────────────

def _build_timeline(rec: ConnectionMaster, inst: DatabaseInstance | None, srv: OsServer | None, db: Session) -> list:
    steps = [
        {"label": "Last Healthy", "timestamp": None, "available": False},
        {"label": "First Warning", "timestamp": None, "available": False},
        {"label": "First Error", "timestamp": None, "available": False},
        {"label": "Service/Process Change", "timestamp": None, "available": False},
        {"label": "Connection Failure", "timestamp": None, "available": False},
        {"label": "Database Down", "timestamp": None, "available": False},
        {"label": "Current Status", "timestamp": _iso(datetime.now(timezone.utc)), "available": True},
    ]
    if inst and inst.status_changed_at:
        ts = _iso(inst.status_changed_at)
        if (inst.status or "").lower() in ("stopped", "down", "offline"):
            steps[5] = {"label": "Database Down", "timestamp": ts, "available": True}
            steps[3] = {"label": "Service/Process Change", "timestamp": ts, "available": True,
                        "note": "Inferred from the last detected status transition."}
        else:
            steps[0] = {"label": "Last Healthy", "timestamp": ts, "available": True}

    if srv:
        scope_key = f"server:{srv.id}"
        try:
            rows = db.execute(text(
                "SELECT ar.severity, afs.first_breach_at FROM alert_fired_state afs "
                "JOIN alert_rules ar ON ar.id = afs.alert_rule_id "
                "WHERE afs.scope_key = :sk ORDER BY afs.first_breach_at ASC"
            ), {"sk": scope_key}).fetchall()
            for sev, first_breach in rows:
                ts = _iso(first_breach)
                if (sev or "").lower() == "warning" and not steps[1]["available"]:
                    steps[1] = {"label": "First Warning", "timestamp": ts, "available": True}
                elif (sev or "").lower() in ("critical", "error") and not steps[2]["available"]:
                    steps[2] = {"label": "First Error", "timestamp": ts, "available": True}
        except Exception:
            pass
    return steps


# ── root cause analysis (rule-based, from real evidence) ────────────────────

def _build_rca_from_checks(conn_id: int, check_results: list, db: Session) -> dict:
    if not check_results:
        return {
            "primary_cause": None,
            "possible_causes": [],
            "evidence": [],
            "confidence": 0,
            "insufficient": True,
            "missing_checks": [c[0] for c in eng.CHECKS],
            "reason": "Root cause could not be determined from the available diagnostics — no checks have been run yet.",
        }
    ran_ids = {r.get("id") for r in check_results}
    missing = [cid for cid, _, _ in eng.CHECKS if cid not in ran_ids]
    all_skipped_os = check_results and all(r.get("os_unsupported") for r in check_results)
    if all_skipped_os:
        return {
            "primary_cause": None,
            "possible_causes": [],
            "evidence": [],
            "confidence": 0,
            "insufficient": True,
            "missing_checks": missing,
            "reason": "Root cause could not be determined from the available diagnostics — OS-level checks aren't available for this host's operating system yet.",
        }
    rca = eng.build_rca(conn_id, check_results, db)
    return {
        "primary_cause": rca.get("root_cause"),
        "possible_causes": [rca.get("root_cause")] if rca.get("root_cause") else [],
        "evidence": rca.get("evidence", []),
        "confidence": rca.get("confidence", 0),
        "insufficient": rca.get("confidence", 0) < 55,
        "missing_checks": missing,
        "severity": rca.get("severity"),
        "recommended_fix": rca.get("recommended_fix"),
        "recovery_commands": rca.get("recovery_commands", []),
        "affected_files": rca.get("affected_files", []),
        "failed_components": rca.get("failed_components", []),
        "preventive": rca.get("preventive", []),
    }


# ── database health (technology-specific, from each engine's own live dashboard) ──

def _health_item(label, value, unit=""):
    return {"label": label, "value": f"{value}{unit}" if value not in (None, "") else "—"}


def _build_database_health(rec: ConnectionMaster, db: Session) -> dict:
    """Pulls the same real, already-computed health fields each engine's own
    dashboard already shows — never re-derives or guesses them. Only the
    technologies with a verified field mapping are wired; the rest say so
    honestly instead of guessing at a shape."""
    tech = (rec.db_type or "").lower()
    try:
        if tech in ("mysql", "mariadb"):
            from app.services.mysql.mysql_dashboard_service import get_dashboard
            hs = get_dashboard(rec.id, db, live=True).get("health_summary") or {}
            return {"available": True, "items": [
                _health_item("Server Version", hs.get("version")),
                _health_item("Uptime", hs.get("uptime")),
                _health_item("Replication State", hs.get("replication_state")),
                _health_item("Connections", f"{hs.get('current_connections')}/{hs.get('max_connections')}"),
                _health_item("Connection Usage", hs.get("connection_usage_pct"), "%"),
                _health_item("InnoDB Buffer Cache Hit", hs.get("cache_usage_pct"), "%"),
                _health_item("Storage Engine", hs.get("storage_engine")),
            ]}
        if tech in ("postgresql", "postgres"):
            from app.services.postgres.postgres_connection_service import svc_get_dashboard
            hs = svc_get_dashboard(rec.id, db).get("health_summary") or {}
            return {"available": True, "items": [
                _health_item("Server Version", hs.get("version")),
                _health_item("Uptime", hs.get("uptime")),
                _health_item("Recovery / Replication State", hs.get("replication_state")),
                _health_item("Connections", f"{hs.get('current_connections')}/{hs.get('max_connections')}"),
                _health_item("Connection Usage", hs.get("connection_usage_pct"), "%"),
                _health_item("Cache Hit Ratio", hs.get("cache_usage_pct"), "%"),
                _health_item("Databases", hs.get("total_databases")),
            ]}
        if tech == "mssql":
            from app.services.mssql.mssql_monitoring_service import get_monitoring_dashboard
            hs = get_monitoring_dashboard(rec.id, db).get("health_summary") or {}
            return {"available": True, "items": [
                _health_item("Server Version", hs.get("version")),
                _health_item("Edition", hs.get("edition")),
                _health_item("Uptime", hs.get("uptime")),
                _health_item("Active Sessions", f"{hs.get('active_sessions')}/{hs.get('max_connections')}"),
                _health_item("Connection Usage", hs.get("connection_usage_pct"), "%"),
                _health_item("Buffer Cache Hit", hs.get("buffer_cache_hit_pct"), "%"),
                _health_item("Page Life Expectancy", hs.get("page_life_expectancy")),
            ]}
        if tech == "oracle":
            from app.services.oracle.oracle_monitoring_service import oracle_db_status
            res = oracle_db_status(rec.id, db)
            inst = res.get("instance") or {}
            dbs = res.get("db_status") or {}
            if not inst and not dbs:
                return {"available": False, "reason": "; ".join(res.get("errors") or []) or "Could not read instance status."}
            return {"available": True, "items": [
                _health_item("Instance Status", inst.get("status")),
                _health_item("Database Status", inst.get("db_status")),
                _health_item("Open Mode / Role", f"{dbs.get('open_mode')} / {dbs.get('role')}"),
                _health_item("Archiver", inst.get("archiver")),
                _health_item("Logins", inst.get("logins")),
                _health_item("Uptime (days)", inst.get("uptime_days")),
                _health_item("Version", inst.get("version")),
            ]}
        if tech == "mongodb":
            from app.services.mongo.mongo_monitoring_service import get_dashboard
            hs = get_dashboard(rec.id, db).get("health_summary") or {}
            if not hs:
                return {"available": False, "reason": "Could not read MongoDB server status."}
            return {"available": True, "items": [
                _health_item("Server Version", hs.get("version")),
                _health_item("Uptime", hs.get("uptime_str")),
                _health_item("Storage Engine", hs.get("storage_engine")),
                _health_item("Connections", f"{hs.get('current_connections')}/{hs.get('available_connections')}"),
                _health_item("Connection Usage", hs.get("connection_pct"), "%"),
                _health_item("Replication State", hs.get("replication_state")),
                _health_item("Replica Set", hs.get("replica_set")),
            ]}
        if tech == "clickhouse":
            from app.services.clickhouse.clickhouse_monitoring_service import get_dashboard
            hs = get_dashboard(rec.id, db).get("health_summary") or {}
            if not hs:
                return {"available": False, "reason": "Could not read ClickHouse server status."}
            return {"available": True, "items": [
                _health_item("Server Version", hs.get("version")),
                _health_item("Uptime", hs.get("uptime_str")),
                _health_item("Memory Usage", hs.get("memory_usage_pct"), "%"),
                _health_item("Queries / sec", hs.get("queries_per_second")),
                _health_item("Total Parts", hs.get("total_parts")),
                _health_item("Max Parts / Partition", hs.get("max_part_count_for_partition")),
                _health_item("Databases", hs.get("total_databases")),
            ]}
    except Exception as e:  # noqa: BLE001 — health detail is supplementary, never fail the window over it
        return {"available": False, "reason": f"Could not read database health: {e}"}
    return {"available": False, "reason": f"Technology-specific health metrics for '{rec.db_type}' aren't wired into the Diagnosis window yet — see the {rec.db_type} dashboard for full detail."}


# ── public entry points ──────────────────────────────────────────────────────

def get_overview(conn_id: int, db: Session) -> dict:
    """The Diagnosis page's PASSIVE snapshot only — header, summary, timeline,
    and host/OS health (already-collected OsServer columns, refreshed by the
    ongoing agent heartbeat, not a probe triggered by this call). Nothing here
    opens a connection, runs a shell command, or queries the database — that
    would be "running a diagnostic" automatically, which the admin now
    controls explicitly via the check catalogue (`/diagnose/plan` +
    `/diagnose/check/{id}`, covering service/process/port/network plus the
    database-level db_connection/db_health/db_logs checks below)."""
    rec = _get_conn(conn_id, db)
    if not rec:
        return {"status": "error", "error": "Connection not found"}

    ag_row = _agent_row(conn_id, db)
    inst, srv = _instance_and_server(conn_id, db)

    header = _build_header(rec, ag_row, inst, srv)
    timeline = _build_timeline(rec, inst, srv, db)
    host_os_health = _build_host_os_health(srv)
    summary = _build_summary(header, None, ag_row)

    return {
        "status": "success",
        "header": header,
        "summary": summary,
        "host_os_health": host_os_health,
        "timeline": timeline,
        "os_checks_supported": header["os_supported"],
        "server_id": srv.id if srv else None,
    }


def get_rca(conn_id: int, check_results: list, db: Session) -> dict:
    return _build_rca_from_checks(conn_id, check_results, db)


# ── database-level checks (Database Connection / Health / Logs) ─────────────
# Same shape as diagnose_engine.run_check()'s result, so the frontend's check
# catalogue and Terminal transcript can treat every check uniformly whether
# it's a shell/PowerShell command or, as here, a direct API call against the
# database. No new connection/health/log logic — these wrap the exact
# functions get_overview() used to call eagerly, now run only on request.
DB_CHECKS = [
    ("db_connection", "Database Connection", "Database"),
    ("db_health", "Database Health", "Database"),
    ("db_logs", "Database Logs", "Database"),
]


def db_checks_plan(db_type: str) -> list:
    tech = db_type or "the database"
    return [
        {"id": "db_connection", "title": "Database Connection", "group": "Database",
         "why": "Confirms the database actually accepts an authenticated connection and query — "
                "the strongest single signal of whether it is truly up.",
         "what": "Opens a real connection with the configured credentials and runs a trivial query.",
         "files": [], "command": f"Auth + query test against the live {tech} connection (e.g. SELECT 1).",
         "command_desc": "Connects and runs a lightweight query."},
        {"id": "db_health", "title": "Database Health", "group": "Database",
         "why": "Surfaces version/uptime/connection-usage/replication state — the same summary "
                "the technology's own dashboard shows.",
         "what": "Reads the database's live health summary.",
         "files": [], "command": f"Read {tech}'s live health summary.",
         "command_desc": "Reads server status/health fields."},
        {"id": "db_logs", "title": "Database Logs", "group": "Database",
         "why": "The database's own error log is the most direct source of the real failure reason.",
         "what": "Reads the database's native error log (SQL/driver-native — not a shell file tail; "
                 "see the separate OS-level \"Error Logs\"/\"System Journal\" checks for that).",
         "files": [], "command": f"Read {tech}'s own error log via its native mechanism.",
         "command_desc": "Reads recent error-log entries via the database's own mechanism."},
    ]


def run_db_check(conn_id: int, check_id: str, db: Session) -> dict:
    import time
    rec = _get_conn(conn_id, db)
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    title = next((c[1] for c in DB_CHECKS if c[0] == check_id), check_id)
    group = next((c[2] for c in DB_CHECKS if c[0] == check_id), "Database")
    plan_entry = next((c for c in db_checks_plan(rec.db_type) if c["id"] == check_id), {})
    command = plan_entry.get("command", "")
    t0 = time.monotonic()

    if check_id == "db_connection":
        result = _test_db_connection(rec, db)
        duration_ms = result.get("latency_ms") if result.get("latency_ms") is not None else round((time.monotonic() - t0) * 1000)
        status = "passed" if result["ok"] is True else ("failed" if result["ok"] is False else "skipped")
        detail = result["detail"]
        return {"id": check_id, "title": title, "group": group, "status": status,
                "detail": detail, "evidence": detail, "output": detail,
                "command": command, "duration_ms": duration_ms,
                "exit_code": 0 if result["ok"] is not None else None,
                "permission_issue": None, "analysis": None}

    if check_id == "db_health":
        result = _build_database_health(rec, db)
        duration_ms = round((time.monotonic() - t0) * 1000)
        if result.get("available"):
            output = "\n".join(f"{it['label']}: {it['value']}" for it in result.get("items", []))
            return {"id": check_id, "title": title, "group": group, "status": "passed",
                    "detail": "Database health read successfully.", "evidence": output, "output": output,
                    "command": command, "duration_ms": duration_ms, "exit_code": 0,
                    "permission_issue": None, "analysis": None}
        return {"id": check_id, "title": title, "group": group, "status": "skipped",
                "detail": result.get("reason") or "Not available.", "evidence": "", "output": "",
                "command": command, "duration_ms": duration_ms, "exit_code": None,
                "permission_issue": None, "analysis": None}

    if check_id == "db_logs":
        result = _dispatch_error_logs(rec, db)
        duration_ms = round((time.monotonic() - t0) * 1000)
        entries = result.get("entries") or []
        if result.get("available") and entries:
            output = "\n".join(f"[{e['severity']}] {e.get('timestamp') or ''} {e['message']}" for e in entries[:25])
            worst = ("failed" if any(e["severity"] in ("ERROR", "FATAL", "CRITICAL") for e in entries)
                     else "warning" if any(e["severity"] == "WARNING" for e in entries) else "passed")
            n = len(entries)
            return {"id": check_id, "title": title, "group": group, "status": worst,
                    "detail": f"{n} log entr{'y' if n == 1 else 'ies'} read from {result.get('source') or 'the database'}.",
                    "evidence": output, "output": output,
                    "command": command, "duration_ms": duration_ms, "exit_code": 0,
                    "permission_issue": None, "analysis": None}
        return {"id": check_id, "title": title, "group": group, "status": "skipped",
                "detail": result.get("reason") or "No log entries found.", "evidence": "", "output": "",
                "command": command, "duration_ms": duration_ms, "exit_code": None,
                "permission_issue": None, "analysis": None}

    return {"id": check_id, "title": title, "group": group, "status": "skipped",
            "detail": "Unknown database check.", "evidence": "", "output": "",
            "command": command, "duration_ms": 0, "exit_code": None, "permission_issue": None, "analysis": None}


# ── engine-agnostic report ────────────────────────────────────────────────────
# Generalizes pg_diagnose_service.build_report's layout (Overall Health → Root
# Cause → Recommended Fix → Evidence → Preventive → Raw Sections) to work from
# the orchestrator's normalized bundle for ANY technology — the `/diagnose/report`
# route previously called the Postgres-only builder unconditionally, which
# produced a wrong report for every other engine.
def build_report(conn_id: int, db: Session, check_results: list | None = None, ai: dict | None = None) -> str:
    rec = _get_conn(conn_id, db)
    if not rec:
        return "ActMon Diagnosis Report\nError: Connection not found\n"

    overview = get_overview(conn_id, db)
    results_by_id = {r.get("id"): r for r in (check_results or [])}
    rca = _build_rca_from_checks(conn_id, check_results or [], db)
    header = overview["header"]
    L = []
    L.append("=" * 70)
    L.append(f"  ActMon — {header['technology']} Diagnosis & Root-Cause Report")
    L.append("=" * 70)
    L.append(f"Connection      : {header['database_name']}  ({header['technology']})")
    L.append(f"Host            : {header['host']}:{header['port']}  OS: {header.get('os_type') or 'unknown'}")
    L.append(f"Generated       : {_iso(datetime.now(timezone.utc))}")
    L.append("")
    L.append("-" * 70)
    L.append("  1. OVERALL STATUS")
    L.append("-" * 70)
    L.append(f"Status          : {header['current_status']}")
    L.append(f"Severity        : {header['severity']}")
    L.append(f"Down since      : {header.get('down_since') or '—'}")
    svc_result = results_by_id.get("service")
    if svc_result:
        L.append(f"Service         : {svc_result.get('detail')}")
    port_result = results_by_id.get("port")
    if port_result:
        L.append(f"Port check      : {port_result.get('detail')}")
    conn_result = results_by_id.get("db_connection")
    if conn_result:
        L.append(f"DB connection   : {conn_result.get('detail')}")
    L.append("")
    L.append("-" * 70)
    L.append("  2. ROOT CAUSE (rule-based, from real evidence)")
    L.append("-" * 70)
    if rca.get("insufficient"):
        L.append("Root cause could not be determined from the available diagnostics.")
        L.append("Missing checks: " + ", ".join(rca.get("missing_checks", [])))
    else:
        L.append(rca.get("primary_cause") or "—")
        L.append(f"Severity        : {rca.get('severity')}")
        L.append(f"Confidence      : {rca.get('confidence')}%")
    L.append("")
    L.append("-" * 70)
    L.append("  3. RECOMMENDED FIX")
    L.append("-" * 70)
    L.append(rca.get("recommended_fix") or "—")
    for c in rca.get("recovery_commands", []):
        L.append(f"  $ {c}")
    L.append("")
    L.append("-" * 70)
    L.append("  4. EVIDENCE")
    L.append("-" * 70)
    for e in rca.get("evidence", []) or ["(no fatal signals captured)"]:
        L.append(str(e))
    if ai and ai.get("available"):
        L.append("")
        L.append("-" * 70)
        L.append("  5. ACTMONAI ANALYSIS")
        L.append("-" * 70)
        L.append(f"Diagnosis       : {ai.get('diagnosis')}")
        L.append(f"Root cause      : {ai.get('root_cause')}")
        L.append(f"Confidence      : {ai.get('confidence')}%")
        L.append(f"Recommendation  : {ai.get('recommended_resolution')}")
        for e in ai.get("evidence", []):
            L.append(f"  - {e}")
    L.append("")
    L.append("-" * 70)
    L.append("  6. PREVENTIVE RECOMMENDATIONS")
    L.append("-" * 70)
    for p in rca.get("preventive", []):
        L.append(f"  - {p}")
    L.append("")
    L.append("=" * 70)
    L.append("  RAW DIAGNOSTIC CHECKS")
    L.append("=" * 70)
    for c in (check_results or []):
        L.append("")
        L.append(f"### {c.get('title', c.get('id'))} — {c.get('status')}")
        L.append(str(c.get("evidence") or c.get("detail") or "(empty)"))
    L.append("")
    L.append("Generated by ActMon Diagnosis Center")
    return "\n".join(L)
