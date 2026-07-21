"""
Host operations over the agent channel (SSH fallback for SSH hosts):
  • service inventory + status               (svc_list_services)
  • start / stop / restart a service         (svc_service_action)   ← password-gated route
  • reboot the host                          (svc_reboot_host)      ← password-gated route
  • network diagnostics: ping / TCP port / DNS (svc_net_diag)       ← read-only, no password

Control actions (start/stop/restart/reboot) re-authenticate the caller's password
in the route before reaching here. Diagnostics are read-only and need no password.
"""
import re
import shlex

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.os_server_model import OsServer
from app.services.agent import agent_fs_service
from app.services.os_server.fs_browse_service import _resolve_ssh, _ssh_output


def verify_user_password(db: Session, user_id: int, password: str) -> bool:
    """Re-auth the current user (plaintext store — matches access_control_service)."""
    stored = db.execute(text("SELECT password_hash FROM user_master WHERE user_id=:u"),
                        {"u": user_id}).scalar()
    return stored is not None and str(stored) == str(password)


def _get(server_id: int, db: Session) -> OsServer:
    srv = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not srv:
        raise HTTPException(status_code=404, detail="Server not found")
    if (srv.os_type or "").lower().startswith("win") and (srv.collector or "") != "agent":
        raise HTTPException(status_code=400, detail="Host operations run through the ActMon agent. This Windows host has no agent — install it to enable them.")
    return srv


def _run(srv: OsServer, db: Session, op: str, arg: str, ssh_cmd: str) -> str:
    """Dispatch an op (svcctl / diag) to the agent, else SSH, else error."""
    is_agent = (srv.collector or "") == "agent" and srv.agent_token
    if is_agent:
        raw = agent_fs_service.request(srv.agent_token, op, arg)
        if raw is not None:
            return raw.decode("utf-8", errors="replace")
        if _resolve_ssh(srv, db):
            return _ssh_output(srv, db, ssh_cmd).decode("utf-8", errors="replace")
        raise HTTPException(status_code=504, detail="This host's agent is an older build that doesn't support this yet. Update it once (re-run the installer, or `sudo systemctl restart actmon-agent`) — newer agents self-update automatically.")
    if _resolve_ssh(srv, db):
        return _ssh_output(srv, db, ssh_cmd).decode("utf-8", errors="replace")
    raise HTTPException(status_code=400, detail="This host has no agent and no SSH credentials configured.")


# ── Services ──────────────────────────────────────────────────────────────────
def _norm_status(s: str) -> str:
    v = (s or "").strip().lower()
    if v in ("running", "active"):
        return "running"
    if v in ("stopped", "inactive", "dead", "exited", "failed"):
        return "stopped" if v != "failed" else "failed"
    return v or "unknown"


def svc_list_services(server_id: int, db: Session) -> dict:
    """Full service inventory with status (name | status | description)."""
    srv = _get(server_id, db)
    ssh = ("systemctl list-units --type=service --all --no-legend --no-pager | "
           "awk '{name=$1; st=$3; desc=\"\"; for(i=5;i<=NF;i++) desc=desc $i \" \"; print name\"|\"st\"|\"desc}' | head -400")
    raw = _run(srv, db, "services", "services", ssh)
    services = []
    for ln in raw.splitlines():
        parts = ln.split("|")
        if len(parts) >= 2 and parts[0].strip():
            services.append({
                "unit": parts[0].strip(),
                "status": _norm_status(parts[1]),
                "description": (parts[2].strip() if len(parts) > 2 else ""),
            })
    services.sort(key=lambda s: (s["status"] != "running", s["unit"].lower()))
    return {"services": services, "source": "agent" if (srv.collector or "") == "agent" else "ssh"}


def _valid_unit(unit: str) -> str:
    u = (unit or "").strip()
    # Linux units (name.service) and Windows service names (e.g. MSSQL$SQLEXPRESS, W32Time).
    if not u or not re.match(r"^[\w .$@#+-]{1,128}$", u):
        raise HTTPException(status_code=400, detail="Invalid service name.")
    return u


_ACTIONS = {"start", "stop", "restart"}


def svc_service_action(server_id: int, unit: str, action: str, db: Session) -> dict:
    """start / stop / restart a service. (Route re-auths the password first.)"""
    srv = _get(server_id, db)
    u = _valid_unit(unit)
    if action not in _ACTIONS:
        raise HTTPException(status_code=400, detail="action must be start, stop or restart.")
    ssh = f"sh -c 'systemctl {action} {shlex.quote(u)} 2>&1 && echo OK:{action}ed; systemctl is-active {shlex.quote(u)}'"
    raw = _run(srv, db, "svcctl", f"{action}:{u}", ssh).strip()
    if raw.startswith("OK"):
        return {"status": "success", "message": raw.replace("OK:", "").strip() or f"{action} ok", "action": action, "unit": u}
    raise HTTPException(status_code=400, detail=f"{action} failed: {raw.replace('ERR:', '').strip() or 'unknown error'}")


# Kept for the config-editor "restart networking" flow.
def svc_restart_service(server_id: int, unit: str, db: Session) -> dict:
    return svc_service_action(server_id, unit, "restart", db)


# ── OS Configuration: registry + whitelisted info commands ────────────────────
_CMD_WHITELIST = {
    # Operating System
    "systeminfo": "systeminfo",
    "wmic_os": "wmic os get Caption,Version,OSArchitecture,BuildNumber,InstallDate,LastBootUpTime /format:list",
    "get_computerinfo": "Get-ComputerInfo | Format-List | Out-String",
    "get_os": "Get-CimInstance Win32_OperatingSystem | Format-List * | Out-String",
    "hostname": "hostname",
    "ver": "cmd /c ver",
    "uname": "uname -a",
    "os_release": "cat /etc/os-release",
    # CPU
    "wmic_cpu": "wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,CurrentClockSpeed,LoadPercentage /format:list",
    "get_cpu": "Get-CimInstance Win32_Processor | Format-List Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,CurrentClockSpeed,LoadPercentage,L2CacheSize,L3CacheSize,Virtualization* | Out-String",
    "powercfg_scheme": "powercfg /getactivescheme",
    "cpu_load": "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
    "lscpu": "lscpu",
    "proc_cpuinfo": "cat /proc/cpuinfo",
    "nproc": "nproc",
    "uptime": "uptime",
}


def _valid_regkey(k: str) -> str:
    k = (k or "").strip()
    if not k.upper().startswith(("HKLM\\", "HKCU\\", "HKCR\\", "HKU\\", "HKEY_")):
        raise HTTPException(status_code=400, detail="Registry key must start with HKLM\\, HKCU\\, etc.")
    if any(c in k for c in ("\n", "\r", "\x00", "|", "'", '"', ";", "&", "`")):
        raise HTTPException(status_code=400, detail="Invalid characters in registry key.")
    return k


def svc_reg_get(server_id: int, key: str, db: Session) -> dict:
    srv = _get(server_id, db)
    k = _valid_regkey(key)
    raw = _run(srv, db, "regget", k, "echo registry-not-applicable")
    vals = []
    for ln in raw.splitlines():
        ln = ln.rstrip()
        if ln.startswith("ERR:"):
            raise HTTPException(status_code=400, detail=ln[4:].strip() or "Registry read failed.")
        if "=" in ln:
            n, _, v = ln.partition("=")
            vals.append({"name": n.strip(), "value": v.strip()})
    return {"key": k, "values": vals, "source": "agent" if (srv.collector or "") == "agent" else "ssh"}


def svc_reg_set(server_id: int, key: str, name: str, value: str, db: Session) -> dict:
    srv = _get(server_id, db)
    k = _valid_regkey(key)
    if not (name or "").strip() or any(c in (name or "") for c in ("\n", "\r", "\x00", "|")):
        raise HTTPException(status_code=400, detail="Invalid value name.")
    if any(c in (value or "") for c in ("\n", "\r", "\x00", "|")):
        raise HTTPException(status_code=400, detail="Value cannot contain newlines or '|'.")
    raw = _run(srv, db, "regset", f"{k}|{name}|{value or ''}", "echo not-applicable").strip()
    if raw.startswith("OK"):
        return {"status": "success", "message": raw.replace("OK:", "").strip() or "registry value set"}
    raise HTTPException(status_code=400, detail=raw.replace("ERR:", "").strip() or "Registry write failed.")


def svc_run_command(server_id: int, cmd_key: str, db: Session) -> dict:
    srv = _get(server_id, db)
    cmd = _CMD_WHITELIST.get(cmd_key)
    if not cmd:
        raise HTTPException(status_code=400, detail="Unknown command.")
    raw = _run(srv, db, "runcmd", cmd, cmd)
    return {"command": cmd, "output": (raw or "").strip() or "(no output)",
            "source": "agent" if (srv.collector or "") == "agent" else "ssh"}


def svc_kill_process(server_id: int, pid, db: Session) -> dict:
    """Force-kill a process by PID. (Route re-auths the password first.)"""
    srv = _get(server_id, db)
    p = str(pid).strip()
    if not p.isdigit():
        raise HTTPException(status_code=400, detail="Invalid PID.")
    ssh = f"sh -c 'kill -9 {p} 2>&1 && echo OK:killed {p} || echo ERR:could not kill {p}'"
    raw = _run(srv, db, "killproc", p, ssh).strip()
    if raw.startswith("OK"):
        return {"status": "success", "message": raw.replace("OK:", "").strip() or f"killed PID {p}"}
    raise HTTPException(status_code=400, detail=f"Kill failed: {raw.replace('ERR:', '').strip() or 'unknown error'}")


def svc_update_agent(server_id: int, db: Session) -> dict:
    """Ask the host's Windows agent to download the current MSI and silently self-upgrade.
    (Linux agents already self-update each cycle.)"""
    srv = _get(server_id, db)
    if (srv.collector or "") != "agent" or not srv.agent_token:
        raise HTTPException(status_code=400, detail="This host has no ActMon agent to update.")
    if not (srv.os_type or "").lower().startswith("win"):
        raise HTTPException(status_code=400, detail="Linux agents self-update automatically — no manual update needed.")
    raw = agent_fs_service.request(srv.agent_token, "selfupdate", "")
    if raw is None:
        raise HTTPException(status_code=504, detail="The agent didn't respond — it may be offline. Check that the ActMon service is running on the host.")
    out = raw.decode("utf-8", errors="replace").strip()
    if out.startswith("OK"):
        return {"status": "success", "message": out.replace("OK:", "").strip() or "Update scheduled — the agent will upgrade and reconnect shortly."}
    if "unsupported op" in out.lower():
        raise HTTPException(status_code=400, detail="This host is running an older agent that can't self-update yet. Reinstall the MSI once (Download ActMon Agent → run it) — after that, this button handles all future updates automatically.")
    raise HTTPException(status_code=400, detail=out.replace("ERR:", "").strip() or "Agent update failed to start.")


def svc_reboot_host(server_id: int, db: Session) -> dict:
    srv = _get(server_id, db)
    _run(srv, db, "svcctl", "reboot", "sh -c '(sleep 2; systemctl reboot) >/dev/null 2>&1 & echo OK:rebooting'")
    return {"status": "success", "message": "Reboot signal sent — the host will drop offline shortly and return in a few minutes."}


# ── Network diagnostics (read-only) ────────────────────────────────────────────
def _valid_target(t: str) -> str:
    t = (t or "").strip()
    if not t or not re.match(r"^[A-Za-z0-9_.:\-]{1,255}$", t):
        raise HTTPException(status_code=400, detail="Enter a valid host name or IP address.")
    return t


def _valid_port(p) -> int:
    try:
        n = int(p)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Enter a valid port (1–65535).")
    if not 1 <= n <= 65535:
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535.")
    return n


def svc_net_diag(server_id: int, kind: str, target: str, port=None, db: Session = None) -> dict:
    """Run a network check on the host: kind = ping | port | dns."""
    srv = _get(server_id, db)
    t = _valid_target(target)
    if kind == "ping":
        arg = f"ping:{t}"
        ssh = f"ping -c 4 -W 2 {shlex.quote(t)} 2>&1 || true"
        ok_hint = None
    elif kind == "port":
        n = _valid_port(port)
        arg = f"port:{t}:{n}"
        ssh = (f"sh -c 'if command -v nc >/dev/null 2>&1; then nc -zv -w 3 {shlex.quote(t)} {n} 2>&1; "
               f"else timeout 3 bash -c \"echo > /dev/tcp/{t}/{n}\" 2>/dev/null && echo \"OPEN {t}:{n}\" || echo \"CLOSED {t}:{n}\"; fi'")
    elif kind == "dns":
        arg = f"dns:{t}"
        ssh = f"sh -c 'getent hosts {shlex.quote(t)} 2>/dev/null || nslookup {shlex.quote(t)} 2>&1 || true'"
    else:
        raise HTTPException(status_code=400, detail="kind must be ping, port or dns.")
    raw = _run(srv, db, "diag", arg, ssh)
    out = raw.strip()
    low = out.lower()
    if kind == "port":
        if "tcptestsucceeded" in low:                 # Windows Test-NetConnection
            reachable = "tcptestsucceeded : true" in low
        else:                                         # nc / bash /dev/tcp
            reachable = ("open" in low) or ("succeeded" in low) or ("connected" in low)
    elif kind == "ping":
        reachable = (("ttl=" in low or "bytes from" in low or "reply from" in low)
                     and "100% loss" not in low and "100% packet loss" not in low)
    else:
        reachable = bool(out) and "can't find" not in low and "nxdomain" not in low and "failed" not in low
    return {"kind": kind, "target": t, "port": port, "reachable": reachable,
            "output": out or "(no output)", "source": "agent" if (srv.collector or "") == "agent" else "ssh"}
