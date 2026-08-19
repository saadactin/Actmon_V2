"""
Database Diagnosis Center service.

When a database shows offline / DB Error, this runs REAL checks on the DB host
through the agent's `shell` op — the actual service state, whether the port is
listening, and the collector's last error — so the UI shows the truth instead
of a stale dashboard. Read-only except the explicit "start service" action.

Service-state checking itself delegates to service_state_service.py, which
already resolves this correctly for BOTH Windows (Get-Service/SCM) and Linux
(systemctl) hosts — this file used to run `systemctl is-active`/`systemctl
start` unconditionally, which is wrong (and for start_service(), actively
harmful/no-op) against a Windows-hosted DB host. MSSQL in particular is
overwhelmingly Windows-hosted, so this wasn't a theoretical case.
"""
import json
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster

# systemd service-name candidates per engine (Linux only — Windows service
# resolution is delegated to service_state_service.py, which knows the real
# Windows names, e.g. MSSQL's per-instance MSSQLSERVER/MSSQL$<name>).
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


def _is_windows_host(conn_id: int, db: Session) -> bool:
    """Best-effort: agent's own reported os_type, else the registered infra
    server behind it. Same lookup diagnose_engine.py's os_type_for_conn does —
    duplicated here as one query rather than a cross-import, since importing
    service_state_service would be circular (it already imports _agent_shell
    from this module)."""
    row = db.execute(text(
        "SELECT os_type FROM agents WHERE db_connection_id = :c AND os_type IS NOT NULL LIMIT 1"
    ), {"c": conn_id}).first()
    os_type = row[0] if row else None
    if not os_type:
        row = db.execute(text(
            "SELECT s.os_type FROM database_instances di JOIN os_servers s ON s.id = di.server_id "
            "WHERE di.connection_id = :c AND s.os_type IS NOT NULL LIMIT 1"
        ), {"c": conn_id}).first()
        os_type = row[0] if row else None
    return "win" in (os_type or "").lower()


def _ps_encoded(script: str) -> str:
    """Wrap a PowerShell snippet as -EncodedCommand (base64 UTF-16LE) so it
    survives the agent's cmd.exe-based shell op with zero quoting risk — same
    pattern already proven in diagnose_engine.py/service_state_service.py."""
    import base64
    b = base64.b64encode(script.encode("utf-16-le")).decode()
    return "powershell -NoProfile -NonInteractive -EncodedCommand " + b


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

    windows = _is_windows_host(conn_id, db)

    # 1) Service state — delegated to service_state_service, which already
    # resolves this correctly for both Windows (Get-Service/SCM, incl. MSSQL's
    # per-instance MSSQLSERVER/MSSQL$<name> naming) and Linux (systemctl).
    # svc_known tracks whether we got a definitive OS-level answer at all
    # (True/False), so the verdict logic below never has to string-match
    # OS-specific state vocabularies (Linux "inactive"/"failed" vs Windows
    # "Stopped"/"Paused") to know whether the service is genuinely down.
    from app.services.common.service_state_service import get_service_state
    ss = get_service_state(conn_id, db)
    svc_known = False
    if ss.get("checked"):
        svc_known = True
        svc_active = bool(ss.get("active"))
        svc_state = ss.get("state") or ("active" if svc_active else "unknown")
        svc_name = ss.get("service_name")
        svc_detail = ss.get("detail") or ""
        state_source = "Get-Service" if windows else "systemctl"
    else:
        # Not checkable via service_state_service (e.g. Oracle on Linux, which
        # has no simple systemd unit) — fall back to the direct systemctl probe
        # for the Linux candidates this engine might have; Windows has no
        # equivalent fallback here since service_state_service already covers
        # every Windows-recognized engine.
        svc_active, svc_state, svc_name, svc_detail, state_source = False, "unknown", None, "", "systemctl"
        if not windows:
            for cand in _SERVICE_CANDIDATES.get(tech, []):
                code, txt = _agent_shell(token, f"systemctl is-active {cand} 2>/dev/null")
                if txt is None:
                    out["checks"].append({"name": "agent", "ok": False, "detail": "Agent did not respond."})
                    out["verdict"] = "agent-unreachable"
                    return out
                state = (txt or "").strip().splitlines()[0].strip() if txt else ""
                if state in ("active", "inactive", "failed", "activating", "deactivating"):
                    svc_known = True
                    svc_active = state == "active"
                    svc_state, svc_name = state, cand
                    _, det = _agent_shell(token, f"systemctl status {cand} --no-pager 2>&1 | head -5")
                    svc_detail = (det or "").strip()
                    break
    out["service"] = {"name": svc_name, "active": svc_state, "detail": svc_detail[:1500]}
    if svc_name:
        out["checks"].append({
            "name": f"service:{svc_name}",
            "ok": svc_active,
            "detail": f"{state_source} reports '{svc_state}'",
        })

    # 2) Port listening?
    if windows:
        probe = _ps_encoded(
            f"if (Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue) "
            "{ 'LISTEN' } else { 'CLOSED' }"
        )
        _, probe_txt = _agent_shell(token, probe)
        listening = "LISTEN" in (probe_txt or "")
    else:
        _, ss_txt = _agent_shell(token, f"ss -ltn 2>/dev/null | grep -w ':{port}' || true")
        listening = bool((ss_txt or "").strip())
    out["port_check"]["listening"] = listening
    out["checks"].append({
        "name": f"port:{port}",
        "ok": listening,
        "detail": f"TCP {port} is {'listening' if listening else 'NOT listening'} on the host",
    })

    # 3) Verdict + suggestions
    start_hint = (f"Start-Service -Name '{svc_name}'  (PowerShell, or via services.msc)" if windows
                  else f"systemctl start {svc_name}")
    if svc_active and listening and agent_status == "online":
        out["verdict"] = "up"
    elif (svc_known and not svc_active) or listening is False:
        out["verdict"] = "down"
        if svc_name:
            out["suggestions"].append(f"The '{svc_name}' service is {svc_state}. Start it: {start_hint}")
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

    windows = _is_windows_host(conn_id, db)
    if windows:
        # Reuse service_state_service's own resolution (handles MSSQL's
        # per-instance MSSQLSERVER/MSSQL$<name> naming correctly) rather than
        # re-deriving a Windows service name here.
        from app.services.common.service_state_service import get_service_state
        ss = get_service_state(conn_id, db)
        svc_name = ss.get("service_name") if ss.get("checked") else None
        if not svc_name:
            return {"status": "error", "error": f"No known Windows service found for {rec.db_type} on this host"}
        code, txt = _agent_shell(
            token,
            _ps_encoded(
                f"Start-Service -Name '{svc_name}' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; "
                f"(Get-Service -Name '{svc_name}').Status.ToString()"
            ),
            timeout=60,
        )
        active = "running" in (txt or "").lower()
        return {"status": "success" if active else "error",
                "service": svc_name,
                "active": active,
                "output": (txt or "").strip()[:800]}

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
