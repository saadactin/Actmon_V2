"""
Database Diagnosis Center service.

When a database shows offline / DB Error, this runs REAL checks on the DB host
through the agent's `shell` op — the actual service state (systemctl), whether the
port is listening, and the collector's last error — so the UI shows the truth
instead of a stale dashboard. Read-only except the explicit "start service" action.
"""
import json
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

# systemd service-name candidates per engine (first active/known one wins)
_SERVICE_CANDIDATES = {
    "postgresql": ["postgresql", "postgresql@*", "postgresql-16", "postgresql-15", "postgresql-14"],
    "postgres":   ["postgresql", "postgresql@*"],
    "mysql":      ["mysql", "mysqld", "mariadb"],
    "mariadb":    ["mariadb", "mysql", "mysqld"],
    "mssql":      ["mssql-server"],
    "mongodb":    ["mongod", "mongodb"],
    "clickhouse": ["clickhouse-server"],
    "oracle":     [],   # Oracle isn't a simple systemd unit — rely on the port/listener
}
_DEFAULT_PORT = {"postgresql": 5432, "postgres": 5432, "mysql": 3306, "mariadb": 3306,
                 "mssql": 1433, "mongodb": 27017, "clickhouse": 9000, "oracle": 1521}


def _agent_for(conn_id: int, db: Session):
    from app.services.common.db_proxy_service import agent_host_for_conn
    try:
        row = agent_host_for_conn(conn_id, db)
        return (row.token if row else None)
    except Exception:  # noqa: BLE001
        return None


def _agent_shell(token: str, cmd: str, timeout: int = 30):
    """Run a shell command on the DB host via the agent. Returns (exit_code, text)
    or (None, None) if the agent didn't answer."""
    from app.services.agent import agent_fs_service
    raw = agent_fs_service.request(token, "shell", cmd, timeout=timeout)
    if raw is None:
        return None, None
    txt = raw.decode("utf-8", "replace")
    code = 0
    if txt.startswith("EXIT:"):
        head, _, rest = txt.partition("\n")
        try:
            code = int(head[5:].strip())
        except Exception:
            code = 0
        txt = rest
    return code, txt


def diagnose(conn_id: int, db: Session) -> dict:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": f"Connection {conn_id} not found"}

    tech = (rec.db_type or "").lower()
    port = rec.port or _DEFAULT_PORT.get(tech, 0)

    # Collector's own verdict + last error (from the agents table).
    ag = db.execute(text(
        "SELECT status, last_error, last_heartbeat FROM agents WHERE db_connection_id = :c LIMIT 1"),
        {"c": conn_id}).first()
    agent_status = (ag[0] if ag else None) or "unknown"
    last_error   = (ag[1] if ag else None)
    last_hb      = (ag[2].isoformat() if ag and ag[2] else None)

    token = _agent_for(conn_id, db)

    out = {
        "status": "success",
        "connection_id": conn_id,
        "connection_name": rec.connection_name or f"{rec.db_type}-{conn_id}",
        "db_type": rec.db_type,
        "host": rec.host,
        "port": port,
        "agent": {
            "linked": bool(token),
            "collector_status": agent_status,   # online / error / offline
            "last_error": last_error,
            "last_heartbeat": last_hb,
        },
        "service": {"name": None, "active": "unknown", "detail": ""},
        "port_check": {"number": port, "listening": None},
        "checks": [],
        "verdict": "unknown",
        "suggestions": [],
    }

    if not token:
        out["verdict"] = "no-agent"
        out["suggestions"] = ["This connection isn't linked to an agent host, so live "
                              "service checks aren't available. Add SSH creds or install the agent."]
        return out

    # 1) Service state — try each candidate name until one is known to systemd.
    svc_state, svc_name, svc_detail = "unknown", None, ""
    for cand in _SERVICE_CANDIDATES.get(tech, []):
        code, txt = _agent_shell(token, f"systemctl is-active {cand} 2>/dev/null")
        if txt is None:
            out["checks"].append({"name": "agent", "ok": False, "detail": "Agent did not respond."})
            out["verdict"] = "agent-unreachable"
            return out
        state = (txt or "").strip().splitlines()[0].strip() if txt else ""
        if state in ("active", "inactive", "failed", "activating", "deactivating"):
            svc_state, svc_name = state, cand
            _, det = _agent_shell(token, f"systemctl status {cand} --no-pager 2>&1 | head -5")
            svc_detail = (det or "").strip()
            break
    out["service"] = {"name": svc_name, "active": svc_state, "detail": svc_detail[:1500]}
    if svc_name:
        out["checks"].append({
            "name": f"service:{svc_name}",
            "ok": svc_state == "active",
            "detail": f"systemctl reports '{svc_state}'",
        })

    # 2) Port listening?
    _, ss_txt = _agent_shell(token, f"ss -ltn 2>/dev/null | grep -w ':{port}' || true")
    listening = bool((ss_txt or "").strip())
    out["port_check"]["listening"] = listening
    out["checks"].append({
        "name": f"port:{port}",
        "ok": listening,
        "detail": f"TCP {port} is {'listening' if listening else 'NOT listening'} on the host",
    })

    # 3) Verdict + suggestions
    if svc_state == "active" and listening and agent_status == "online":
        out["verdict"] = "up"
    elif svc_state in ("inactive", "failed") or listening is False:
        out["verdict"] = "down"
        if svc_name:
            out["suggestions"].append(f"The '{svc_name}' service is {svc_state}. Start it: systemctl start {svc_name}")
        if not listening:
            out["suggestions"].append(f"Nothing is listening on port {port}. Confirm the DB is running and bound to this port/host.")
    else:
        out["verdict"] = "degraded"
    if last_error:
        out["suggestions"].append(f"Collector's last error: {last_error[:200]}")

    return out


def start_service(conn_id: int, db: Session) -> dict:
    """Explicit remediation: start the DB service on the host via the agent."""
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        return {"status": "error", "error": "Connection not found"}
    tech = (rec.db_type or "").lower()
    token = _agent_for(conn_id, db)
    if not token:
        return {"status": "error", "error": "No agent linked to this connection"}
    # find the service name first
    svc_name = None
    for cand in _SERVICE_CANDIDATES.get(tech, []):
        code, txt = _agent_shell(token, f"systemctl is-active {cand} 2>/dev/null")
        state = (txt or "").strip().splitlines()[0].strip() if txt else ""
        if state in ("active", "inactive", "failed"):
            svc_name = cand
            break
    if not svc_name:
        return {"status": "error", "error": f"No known systemd service for {rec.db_type} on this host"}
    code, txt = _agent_shell(token, f"systemctl start {svc_name} 2>&1; systemctl is-active {svc_name}", timeout=60)
    active = "active" in (txt or "")
    return {"status": "success" if active else "error",
            "service": svc_name,
            "active": active,
            "output": (txt or "").strip()[:800]}
