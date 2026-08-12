"""
Database Agent Monitoring — per-technology check catalogue for the Database
Agent page (Agents module). Distinct from, but shaped identically to,
diagnose_orchestrate_service.py's DB_CHECKS — that one feeds the Diagnosis
workspace's OS+DB checklist; this one feeds a technology's own dedicated
"Database Monitoring Checks" table, with finer per-category granularity where
a real, already-existing function backs it.

Every supported technology gets the same three baseline checks (Connection /
Server / Errors), reusing diagnose_orchestrate_service's already-real
per-tech functions — no new connection/health/log logic is written here.
ClickHouse additionally gets a full breakdown (Databases/Tables/Queries/
Merges/Replication/Settings) from its own already-real granular monitoring
functions in clickhouse_monitoring_service.py. Extending another technology
to the same granularity later is additive — add its real granular functions
to TECH_EXTRA_CHECKS, nothing here needs restructuring.

Nothing in this module invents data or runs on a schedule: every check is
executed only when explicitly requested (see db_agent_routes.py), and a
result is persisted to db_check_runs only at that moment.
"""
import re
import time

from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.common import diagnose_orchestrate_service as diag

_SUPPORTED_TECHS = {"mysql", "mariadb", "postgresql", "postgres", "mssql", "oracle", "mongodb", "clickhouse"}


def is_supported(tech: str) -> bool:
    return (tech or "").lower() in _SUPPORTED_TECHS


# ── permission-issue detection (SQL/driver auth errors, per engine) ─────────
# Same spirit as diagnose_engine._permission_issue() but keyed to SQL/driver
# auth-error phrasings rather than shell/OS ones.
_PERMISSION_PATTERNS = {
    "mysql": re.compile(r"access denied for user", re.IGNORECASE),
    "mariadb": re.compile(r"access denied for user", re.IGNORECASE),
    "postgresql": re.compile(r"permission denied", re.IGNORECASE),
    "postgres": re.compile(r"permission denied", re.IGNORECASE),
    "mssql": re.compile(r"permission was denied|login failed", re.IGNORECASE),
    "oracle": re.compile(r"ORA-01031|ORA-01017", re.IGNORECASE),
    "mongodb": re.compile(r"not authorized", re.IGNORECASE),
    "clickhouse": re.compile(r"not enough privileges|authentication failed", re.IGNORECASE),
}


def _permission_issue(tech: str, text: str):
    pattern = _PERMISSION_PATTERNS.get((tech or "").lower())
    if not pattern or not text or not pattern.search(text):
        return None
    return {
        "required": f"Database-level privileges for this operation on {tech}.",
        "why": "ActMon needs this to complete the check.",
        "enables": "Completes this monitoring check.",
        "status": "The connection's configured database user lacks this privilege.",
        "how_obtained": "Grant the missing privilege to the connection's configured "
                         "database user, then re-run the check — ActMon cannot grant "
                         "this itself.",
    }


# ── baseline checks (every supported technology) ────────────────────────────

def _run_connection(rec, db):
    result = diag._test_db_connection(rec, db)
    detail = result.get("detail") or ""
    if result.get("ok") is True:
        return "passed", detail, detail
    if result.get("ok") is False:
        return "failed", detail, detail
    return "skipped", detail or "Not supported for this technology yet.", None


def _run_server_health(rec, db):
    result = diag._build_database_health(rec, db)
    if result.get("available"):
        output = "\n".join(f"{it['label']}: {it['value']}" for it in result.get("items", []))
        return "passed", "Server health read successfully.", output
    return "skipped", result.get("reason") or "Not available.", None


def _run_errors(rec, db):
    result = diag._dispatch_error_logs(rec, db)
    entries = result.get("entries") or []
    if result.get("available") and entries:
        output = "\n".join(f"[{e['severity']}] {e.get('timestamp') or ''} {e['message']}" for e in entries[:25])
        worst = ("failed" if any(e["severity"] in ("ERROR", "FATAL", "CRITICAL") for e in entries)
                 else "warning" if any(e["severity"] == "WARNING" for e in entries) else "passed")
        n = len(entries)
        return worst, f"{n} log entr{'y' if n == 1 else 'ies'} read from {result.get('source') or 'the database'}.", output
    return "skipped", result.get("reason") or "No log entries found.", None


BASE_CHECKS = [
    {"id": "connection", "title": "Database Connection", "category": "Connection",
     "command_desc": "Auth + query test against the live connection (each engine's real test/ping).", "run": _run_connection},
    {"id": "server_health", "title": "Server Health", "category": "Server",
     "command_desc": "Reads the technology's own live health summary (the same dashboard data).", "run": _run_server_health},
    {"id": "errors", "title": "Error Logs", "category": "Errors",
     "command_desc": "Reads the database's native error log via its own mechanism.", "run": _run_errors},
]


# ── ClickHouse-specific extra checks (real, independently-callable queries) ─

def _run_ch_databases(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_databases
    r = get_databases(rec.id, db)
    if r.get("status") == "error":
        raise RuntimeError("; ".join(str(v) for v in (r.get("errors") or {}).values()) or "Query failed.")
    rows = r.get("databases") or []
    output = "\n".join(f"{d.get('name')} ({d.get('engine')})" for d in rows[:50])
    return "passed", f"{r.get('total', len(rows))} database(s) found.", output


def _run_ch_tables(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_tables
    r = get_tables(rec.id, db)
    if r.get("status") == "error":
        raise RuntimeError("; ".join(str(v) for v in (r.get("errors") or {}).values()) or "Query failed.")
    rows = r.get("tables") or []
    output = "\n".join(f"{t.get('database')}.{t.get('name')} ({t.get('engine')}) — {t.get('size_pretty')}" for t in rows[:50])
    status = "warning" if r.get("status") == "partial" else "passed"
    return status, f"{r.get('total', len(rows))} table(s) found.", output


def _run_ch_queries(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_queries
    r = get_queries(rec.id, db)
    if r.get("error"):
        raise RuntimeError(r["error"])
    rows = r.get("logs") or []
    output = "\n".join(f"{q.get('event_time')} [{q.get('type')}] {q.get('query')}" for q in rows[:25])
    return "passed", f"{r.get('total', len(rows))} recent quer{'y' if len(rows) == 1 else 'ies'} read from system.query_log.", output


def _run_ch_merges(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_merges
    r = get_merges(rec.id, db)
    if r.get("error"):
        raise RuntimeError(r["error"])
    rows = r.get("merges") or []
    output = "\n".join(f"{m.get('database')}.{m.get('table')} — {m.get('progress')}" for m in rows[:25]) or "No merges in progress."
    return "passed", f"{r.get('total', len(rows))} merge(s) in progress.", output


def _run_ch_replication(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_replicas
    r = get_replicas(rec.id, db)
    if r.get("error"):
        raise RuntimeError(r["error"])
    rows = r.get("replicas") or []
    summary = r.get("summary") or {}
    if not rows:
        return "skipped", "No replicated tables on this server.", None
    output = "\n".join(f"{rep.get('database')}.{rep.get('table')} — queue={rep.get('queue_size')} delay={rep.get('absolute_delay')}s" for rep in rows[:25])
    status = "failed" if summary.get("with_errors") else ("warning" if summary.get("with_delay") else "passed")
    return status, f"{summary.get('total_replicated_tables', len(rows))} replicated table(s); {summary.get('with_errors', 0)} with errors.", output


def _run_ch_settings(rec, db):
    from app.services.clickhouse.clickhouse_monitoring_service import get_settings
    r = get_settings(rec.id, db)
    rows = r.get("settings") or []
    output = "\n".join(f"{s.get('name')} = {s.get('value')}" for s in rows[:50])
    return "passed", f"{r.get('changed_count', 0)} setting(s) changed from default (of {r.get('total', len(rows))} inspected).", output


TECH_EXTRA_CHECKS = {
    "clickhouse": [
        {"id": "databases", "title": "Databases", "category": "Database",
         "command_desc": "SELECT ... FROM system.databases", "run": _run_ch_databases},
        {"id": "tables", "title": "Tables", "category": "Tables",
         "command_desc": "SELECT ... FROM system.tables", "run": _run_ch_tables},
        {"id": "queries", "title": "Query Log", "category": "Queries",
         "command_desc": "SELECT ... FROM system.query_log", "run": _run_ch_queries},
        {"id": "merges", "title": "Active Merges", "category": "Performance",
         "command_desc": "SELECT ... FROM system.merges", "run": _run_ch_merges},
        {"id": "replication", "title": "Replication", "category": "Replication",
         "command_desc": "SELECT ... FROM system.replicas", "run": _run_ch_replication},
        {"id": "settings", "title": "Settings", "category": "Storage",
         "command_desc": "SELECT ... FROM system.settings WHERE changed = 1", "run": _run_ch_settings},
    ],
}


def catalog_for(tech: str) -> list:
    tech = (tech or "").lower()
    if not is_supported(tech):
        return []
    checks = list(BASE_CHECKS) + list(TECH_EXTRA_CHECKS.get(tech, []))
    return [{"id": c["id"], "title": c["title"], "category": c["category"], "command_desc": c["command_desc"]} for c in checks]


def _find_check(tech: str, check_id: str):
    tech = (tech or "").lower()
    for c in list(BASE_CHECKS) + list(TECH_EXTRA_CHECKS.get(tech, [])):
        if c["id"] == check_id:
            return c
    return None


def run_check(conn_id: int, check_id: str, db: Session) -> dict:
    """Executes ONE check now (never scheduled) and returns its result — the
    caller (db_agent_routes.py) persists this into db_check_runs."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    tech = (rec.db_type or "").lower()
    check = _find_check(tech, check_id)
    if not check:
        return {"id": check_id, "title": check_id, "category": "Unknown", "status": "skipped",
                "detail": f"Not supported for {tech}.", "output": None, "error": None,
                "duration_ms": 0, "permission_issue": None}

    t0 = time.monotonic()
    try:
        status, detail, output = check["run"](rec, db)
        duration_ms = round((time.monotonic() - t0) * 1000, 1)
        return {"id": check_id, "title": check["title"], "category": check["category"],
                "status": status, "detail": detail, "output": output, "error": None,
                "duration_ms": duration_ms, "permission_issue": _permission_issue(tech, detail)}
    except Exception as e:  # noqa: BLE001 — a check failing must never crash the page
        duration_ms = round((time.monotonic() - t0) * 1000, 1)
        err = str(e)
        return {"id": check_id, "title": check["title"], "category": check["category"],
                "status": "failed", "detail": err, "output": None, "error": err,
                "duration_ms": duration_ms, "permission_issue": _permission_issue(tech, err)}
