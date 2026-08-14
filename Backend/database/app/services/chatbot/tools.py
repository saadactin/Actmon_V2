"""
ActMon AI — data-retrieval tool dispatch.

One thin wrapper per real, already-existing service function — this is
deliberately NOT a new SQL-generation surface. Every tool call here either
returns the exact data the corresponding dashboard/history/alert page already
shows, or an explicit `{"available": False, "reason": "..."}` — never a
fabricated value. Per Phase 1 §15, replication/HA maturity is uneven across
engines; `dashboard_snapshot`/`replication_status` pass that through as-is
rather than smoothing over it.
"""
import re

from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer
from app.models.alert_rule_model import AlertRule
from app.services.chatbot import health_tool


def _unavailable(reason: str) -> dict:
    return {"available": False, "reason": reason}


def dashboard_snapshot(db: Session, module: str, resource: dict) -> dict:
    """Current-state snapshot for a resolved resource."""
    if not resource or not resource.get("id"):
        return _unavailable("No resource resolved to fetch a snapshot for.")

    if module == "database":
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == resource["id"]).first()
        if not conn:
            return _unavailable("Connection no longer exists.")
        data = health_tool.get_live_health(db, conn)
        if isinstance(data, dict) and data.get("error"):
            return _unavailable(data["error"])
        return {"available": True, "data": health_tool.compact(data)}

    if module == "infra":
        try:
            from app.services.os_server.infra_detail_service import svc_host_infra_detail
            data = svc_host_infra_detail(resource["id"], db)
            return {"available": True, "data": health_tool.compact(data)}
        except Exception as e:
            return _unavailable(f"Could not fetch infra snapshot: {e}")

    return _unavailable(f"No live dashboard exists for module '{module}' yet.")


def history(module: str, resource: dict, engine=None, minutes: int = 60) -> dict:
    """Historical CPU/RAM/disk-style series from the ClickHouse-backed pipeline."""
    if not resource or not resource.get("id"):
        return _unavailable("No resource resolved to fetch history for.")
    try:
        from app.services.common import metrics_pipeline
    except Exception as e:
        return _unavailable(f"Metrics pipeline unavailable: {e}")

    if module == "infra":
        samples = metrics_pipeline.history(agent_name=resource.get("name"), minutes=minutes, kind="infra", tech="host")
    elif module == "database":
        samples = metrics_pipeline.history(conn_id=resource["id"], minutes=minutes, kind="database", tech=engine)
    else:
        return _unavailable(f"No historical series exists for module '{module}' yet.")

    if not samples:
        return _unavailable("No historical samples in the requested window (collector may not have reported yet).")
    return {"available": True, "data": samples[:200]}


def active_alerts(db: Session, org_id=None, resource: dict = None) -> dict:
    from app.services.alerts.alert_engine_service import applies, evaluate

    q = db.query(AlertRule).filter(AlertRule.enabled.is_(True))
    if org_id is not None:
        q = q.filter(AlertRule.org_id == org_id)
    rules = q.all()

    servers_q = db.query(OsServer)
    if org_id is not None:
        servers_q = servers_q.filter(OsServer.org_id == org_id)
    servers = servers_q.all()
    if resource and resource.get("id"):
        servers = [s for s in servers if s.id == resource["id"]] or servers

    firing = []
    for server in servers:
        for rule in rules:
            if not applies(rule, server):
                continue
            res = evaluate(rule, server)
            if res:
                value, threshold, message = res
                firing.append({"rule": rule.name, "severity": rule.severity, "server": server.server_name,
                                "value": value, "threshold": threshold, "message": message})
    return {"available": True, "data": firing[:50]}


def alert_history(db: Session, org_id=None, resource: dict = None, limit: int = 50) -> dict:
    from app.models.notification_model import NotificationHistory

    q = db.query(NotificationHistory)
    if org_id is not None:
        q = q.filter(NotificationHistory.org_id == org_id)
    if resource and resource.get("name"):
        q = q.filter(NotificationHistory.server_name == resource["name"])
    rows = q.order_by(NotificationHistory.sent_at.desc()).limit(limit).all()
    return {"available": True, "data": [
        {"alert_name": r.alert_name, "server_name": r.server_name, "severity": r.severity,
         "channel_type": r.channel_type, "status": r.status, "sent_at": str(r.sent_at)}
        for r in rows
    ]}


_SLOW_QUERY_FNS = {
    "mysql": ("app.services.mysql.mysql_slow_query_service", "get_slow_queries"),
    "mariadb": ("app.services.mysql.mysql_slow_query_service", "get_slow_queries"),
    "postgresql": ("app.services.postgres.postgres_monitoring_service", "svc_pg_slow_queries"),
    "oracle": ("app.services.oracle.oracle_monitoring_service", "oracle_slow_queries"),
    "mssql": ("app.services.mssql.mssql_monitoring_service", "get_slow_queries"),
    "clickhouse": ("app.services.clickhouse.clickhouse_monitoring_service", "get_slow_queries"),
}


def slow_queries(db: Session, resource: dict, engine: str) -> dict:
    if not resource or not resource.get("id"):
        return _unavailable("No connection resolved to fetch slow queries for.")
    entry = _SLOW_QUERY_FNS.get((engine or "").lower())
    if not entry:
        return _unavailable(f"Slow query analysis is not available for '{engine}' (or MongoDB, which has no aggregated slow-query view — only point-in-time currentOp).")
    module_path, fn_name = entry
    try:
        import importlib
        fn = getattr(importlib.import_module(module_path), fn_name)
        data = fn(resource["id"], db)
        return {"available": True, "data": health_tool.compact(data)}
    except Exception as e:
        return _unavailable(f"Could not fetch slow queries: {e}")


REPLICATION_MATURITY = {
    "mysql": "real computed health verdict (lag-based healthy/warning/critical)",
    "postgresql": "rich raw topology (per-replica lag, slots) but no single computed verdict",
    "mongodb": "full rs.status() parse with per-member state and computed lag",
    "mssql": "only an aggregate synchronization_health_desc string, no per-replica lag",
    "oracle": "weakest — raw v$dataguard_status viewer, no role/lag/health field at all",
}


DASHBOARD_DB_TECHS = ["mysql", "postgresql", "oracle", "mssql", "mongodb", "clickhouse"]
_TOP_CPU_HOSTS = 5  # matches frontend/src/hooks/useDashboardData.js's TOP_CPU_HOSTS


def _status_bucket(raw: str) -> str:
    """Ports frontend/src/components/charts/status.jsx's `statusOf` exactly —
    the Dashboard's own connectivity-status scale. Keep in sync if that file changes."""
    v = str(raw or "").lower()
    if v in ("online", "connected", "healthy", "up", "running", "active"):
        return "good"
    if v in ("warning", "degraded", "warn"):
        return "warning"
    if v in ("error", "critical", "failed", "offline", "disconnected", "down", "stopped", "inactive"):
        return "critical"
    return "unknown"


def _tally(rows: list, status_of) -> dict:
    out = {"total": len(rows), "good": 0, "warning": 0, "critical": 0, "unknown": 0}
    for r in rows:
        out[_status_bucket(status_of(r))] += 1
    return out


def _host_runs_tech(host: dict, tech: str) -> bool:
    services = [str(s).lower() for s in (host.get("database_services") or [])]
    if tech == "mysql":
        return "mysql" in services or "mariadb" in services
    return tech in services


def _instance_for(host: dict, tech: str) -> dict:
    for inst in (host.get("db_instances") or []):
        t = str(inst.get("db_type") or "").lower()
        if tech == "mysql":
            if t in ("mysql", "mariadb"):
                return inst
        elif t == tech:
            return inst
    return None


_LEADING_NUM = re.compile(r"[-+]?\d*\.?\d+")


def _num(v) -> float:
    """host.cpu_usage/ram_usage/disk_usage are stored as strings like "52%", not
    bare numbers — ports JS's `parseFloat("52%")` (which reads the leading numeric
    prefix and returns 52) rather than Python's `float()` (which raises on the
    trailing "%"). A plain `float(v)` here silently zeroed every host's reading."""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    m = _LEADING_NUM.match(str(v).strip())
    return float(m.group()) if m else 0.0


def fleet_dashboard(db: Session, org_id=None) -> dict:
    """The fleet-wide Monitoring Overview (/dashboard) — mirrors
    `frontend/src/hooks/useDashboardData.js`'s `derived` rollup exactly (same 5
    reads, same bucketing/averaging rules), so the AI reports the SAME numbers
    the page itself shows rather than a second, possibly-diverging computation.
    Reuses the existing service functions directly — no new SQL, no duplicate
    business logic beyond porting the (frontend-only, no backend equivalent
    exists) aggregation rules themselves. Keep in sync with that hook if it changes.
    """
    from app.services.os_server.os_server_service import svc_get_summary, svc_list_os_servers
    from app.services.agent.agent_service import svc_list_agents

    summary = svc_get_summary(db, org_id)
    hosts = svc_list_os_servers(db, None, None, org_id).get("data", [])
    try:
        agents = svc_list_agents(db)
    except Exception:
        agents = []
    alerts_result = active_alerts(db, org_id)
    firing = alerts_result.get("data", []) if alerts_result.get("available") else []

    infra = {
        "total": summary.get("total", len(hosts)),
        "good": summary.get("connected", 0),
        "warning": summary.get("warning", 0),
        "critical": summary.get("disconnected", 0),
    }
    infra["health_pct"] = round(infra["good"] / infra["total"] * 100) if infra["total"] else 0

    per_tech = []
    for tech in DASHBOARD_DB_TECHS:
        tech_hosts = [h for h in hosts if _host_runs_tech(h, tech)]
        per_tech.append({
            "engine": tech,
            **_tally(tech_hosts, lambda h, t=tech: (_instance_for(h, t) or {}).get("status")),
        })

    db_hosts = [h for h in hosts if any(_host_runs_tech(h, t) for t in DASHBOARD_DB_TECHS)]
    databases = _tally(db_hosts, lambda h: h.get("db_status"))

    agents_tally = _tally(agents, lambda a: a.get("status"))

    reporting_cpu = [_num(h.get("cpu_usage")) for h in hosts if _num(h.get("cpu_usage")) > 0]
    reporting_ram = [_num(h.get("ram_usage")) for h in hosts if _num(h.get("ram_usage")) > 0]
    reporting_disk = [_num(h.get("disk_usage")) for h in hosts if _num(h.get("disk_usage")) > 0]
    resources = {
        "cpu_avg_pct": round(sum(reporting_cpu) / len(reporting_cpu)) if reporting_cpu else 0,
        "ram_avg_pct": round(sum(reporting_ram) / len(reporting_ram)) if reporting_ram else 0,
        "disk_avg_pct": round(sum(reporting_disk) / len(reporting_disk)) if reporting_disk else 0,
        "hosts_reporting": len(reporting_cpu),
    }

    # Offline hosts excluded — their last cpu_usage is frozen, not live (matches
    # useDashboardData.js's topCpu filter exactly).
    top_cpu = sorted(
        (
            {"host": h.get("server_name") or h.get("ip_address") or "—",
             "os_type": h.get("os_type"), "cpu_pct": _num(h.get("cpu_usage"))}
            for h in hosts
            if _status_bucket(h.get("status")) in ("good", "warning") and _num(h.get("cpu_usage")) > 0
        ),
        key=lambda x: x["cpu_pct"], reverse=True,
    )[:_TOP_CPU_HOSTS]

    by_severity = {"critical": 0, "warning": 0, "info": 0}
    for a in firing:
        sev = str(a.get("severity") or "warning").lower()
        by_severity[sev if sev in by_severity else "warning"] += 1

    def _dist(rows, field, default="Unspecified"):
        counts = {}
        for r in rows:
            key = r.get(field) or default
            counts[key] = counts.get(key, 0) + 1
        return sorted(({"label": k, "count": v} for k, v in counts.items()), key=lambda x: -x["count"])

    return {
        "available": True,
        "as_of": "live snapshot — not a stored historical point",
        "infra": infra,
        "databases_by_host": databases,
        "per_engine": per_tech,
        "agents": agents_tally,
        "average_resource_usage": resources,
        "top_cpu_hosts": top_cpu,
        "active_alerts": {"total": len(firing), **by_severity},
        "hosts_by_os": _dist(hosts, "os_type"),
        "hosts_by_environment": _dist(hosts, "environment"),
        "cloud_accounts": {
            "available": False,
            "reason": "Cloud accounts are served by the separate Cloud microservice, "
                      "not yet wired into ActMon AI's live data tools.",
        },
    }


def replication_status(db: Session, resource: dict, engine: str) -> dict:
    eng = (engine or "").lower()
    note = REPLICATION_MATURITY.get(eng, "unknown maturity for this engine")
    if not resource or not resource.get("id"):
        return _unavailable("No connection resolved to fetch replication status for.")
    try:
        conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == resource["id"]).first()
        if not conn:
            return _unavailable("Connection no longer exists.")
        data = health_tool.get_live_health(db, conn)
        if isinstance(data, dict) and data.get("error"):
            return _unavailable(data["error"])
        repl = data.get("replication") if isinstance(data, dict) else None
        return {"available": True, "maturity_note": note, "data": health_tool.compact(repl) if repl else data.get("replication", {})}
    except Exception as e:
        return _unavailable(f"Could not fetch replication status: {e}")
