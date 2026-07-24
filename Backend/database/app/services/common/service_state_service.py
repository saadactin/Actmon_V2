"""
OS-level service-state check — the ground truth for "is the DB down", used by the
collector BEFORE it attempts a DB connection.

On Linux, `systemctl is-active <svc>` tells us the real state (active/inactive/
failed/activating/deactivating) directly from the OS, with no query timeout, no
retry, no error_streak involved. On Windows, `Get-Service` gives the equivalent
(Running/Stopped/Paused/...Pending). Only when the service is genuinely serving
(active / Running) is a DB connectivity attempt worth making at all — a stopped
or failed service can never answer a query, so trying one just burns a timeout
for a foregone conclusion.

Works for both agent-linked hosts (via the agent's cross-platform `shell` op,
already deployed — no agent update needed) and SSH-linked hosts (via a one-shot
paramiko exec) — whichever `os_servers.collector`/`os_type` says this connection's
host uses. A host OS this module doesn't recognize is simply left unchecked
(`checked: False`) — it falls back to the existing DB-query-based check, exactly
like an engine (e.g. Oracle on Linux) with no service-manager convention.
"""
import base64
import logging
import re

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.common.db_diagnose_service import _agent_shell
from app.services.common.db_proxy_service import agent_host_for_conn

logger = logging.getLogger("service_state")

# ── Linux / systemd ─────────────────────────────────────────────────────────
_LINUX_SERVICE_CANDIDATES = {
    "postgresql": ["postgresql", "postgresql@*", "postgresql-16", "postgresql-15", "postgresql-14"],
    "postgres":   ["postgresql", "postgresql@*"],
    "mysql":      ["mysql", "mysqld", "mariadb"],
    "mariadb":    ["mariadb", "mysql", "mysqld"],
    "mssql":      ["mssql-server"],
    "mongodb":    ["mongod", "mongodb"],
    "clickhouse": ["clickhouse-server"],
    "oracle":     [],   # Oracle isn't a simple systemd unit — rely on the query check
}
# ActiveState values that mean the service is genuinely serving requests.
# "reloading" keeps handling connections while it reloads config, so it counts too.
_LINUX_UP_STATES = {"active", "reloading"}
# Every ActiveState systemd actually reports — outside this set we can't trust
# the answer (usually means the candidate unit name doesn't exist on this host).
_LINUX_KNOWN_STATES = _LINUX_UP_STATES | {"inactive", "failed", "activating", "deactivating"}

_ACTIVE_LINE_RE = re.compile(r"^\s*Active:\s*(.+)$", re.MULTILINE)
_STATUS_LINE_RE = re.compile(r'^\s*Status:\s*"?(.+?)"?\s*$', re.MULTILINE)

# ── Windows / Service Control Manager ───────────────────────────────────────
# Wildcards (Get-Service supports them same as systemd's "postgresql@*" above) cover
# versioned/instance-named services without needing an exhaustive version list.
_WIN_SERVICE_CANDIDATES = {
    "postgresql": ["postgresql-x64-*", "postgresql-*", "postgresql"],
    "postgres":   ["postgresql-x64-*", "postgresql-*", "postgresql"],
    "mysql":      ["MySQL*", "MariaDB*"],
    "mariadb":    ["MariaDB*", "MySQL*"],
    # mssql deliberately absent — a wildcard/list here would risk matching a
    # DIFFERENT SQL Server instance on the same box (see _mssql_win_service_name).
    "mongodb":    ["MongoDB*"],
    "clickhouse": ["ClickHouse*"],
    "oracle":     ["OracleService*"],
}
_WIN_UP_STATES = {"running"}
_WIN_KNOWN_STATES = _WIN_UP_STATES | {
    "stopped", "paused", "startpending", "stoppending", "continuepending", "pausepending",
}


def _is_windows(os_type):
    return "win" in (os_type or "").lower()


def _mssql_win_service_name(instance_name):
    """SQL Server on Windows runs ONE service per instance: the default instance
    is 'MSSQLSERVER', a named instance is 'MSSQL$<INSTANCE_NAME>'. A host can run
    several instances side by side (e.g. MSSQLSERVER stopped, MSSQL$ACTIN_MSSQL
    running) — checking anything but the exact instance this connection targets
    would report on the WRONG SQL Server. There is never a candidate list here,
    only the one real answer."""
    inst = (instance_name or "").strip()
    if not inst or inst.upper() == "MSSQLSERVER":
        return "MSSQLSERVER"
    return f"MSSQL${inst}"


def _candidates_for(tech, windows, rec):
    if tech == "mssql":
        if windows:
            return [_mssql_win_service_name(getattr(rec, "instance_name", None))]
        return _LINUX_SERVICE_CANDIDATES.get(tech, [])   # mssql-server — single instance on Linux, already exact
    return (_WIN_SERVICE_CANDIDATES if windows else _LINUX_SERVICE_CANDIDATES).get(tech, [])


def _ps_encoded(script):
    """Wrap a PowerShell snippet as -EncodedCommand (base64 UTF-16LE) so it can be
    sent through the plain-string `shell` op with zero quoting risk — cmd.exe never
    sees a literal quote character to mis-escape (see actmon_agent.py's _shell()
    docstring for why naive quoting through cmd /c is fragile)."""
    b = base64.b64encode(script.encode("utf-16-le")).decode()
    return "powershell -NoProfile -NonInteractive -EncodedCommand " + b


def _win_probe_cmd(cand):
    """State AND display name in one call — one round trip through the agent's
    single-threaded job channel, whether the service turns out to be up or down
    (see _classify_windows; a host running several DB engines serializes all of
    their checks, so halving round trips here directly cuts cross-agent contention)."""
    return _ps_encoded(
        "$s = Get-Service -Name '%s' -ErrorAction SilentlyContinue | Select-Object -First 1; "
        "if ($s) { \"$($s.Status.ToString())|$($s.DisplayName)\" } else { 'notfound' }" % cand
    )


def _mssql_port_probe_cmd(port):
    """The agent's own dbquery channel connects to this DB by host:port, NEVER by
    instance name — so which service is actually bound to a connection is whatever
    Windows shows listening on that exact port, not whatever `instance_name` says
    (that field can be blank/stale on a working connection). Resolve PID-owning-the-
    port -> Win32_Service in one shot; this is the real, self-correcting answer."""
    return _ps_encoded(
        "$c = Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue "
        "| Select-Object -First 1; "
        "if (-not $c) { 'notfound' } else { "
        "$svc = Get-CimInstance Win32_Service -Filter \"ProcessId=$($c.OwningProcess)\" "
        "-ErrorAction SilentlyContinue | Select-Object -First 1; "
        "if ($svc) { \"$($svc.Name)|$($svc.State)|$($svc.DisplayName)\" } else { 'notfound' } }"
        % int(port)
    )


def _classify_mssql_windows(run, port, instance_name):
    """Resolve SQL Server's state by the connection's actual network binding (its
    configured port) first — the ground truth, since that's how ActMon really talks
    to it. Only falls back to guessing a service NAME from instance_name when the
    port can't be resolved at all (no port configured, or the probe itself failed),
    and even then checks that ONE exact name, never a wildcard scan."""
    if port:
        code, txt = run(_mssql_port_probe_cmd(port))
        if txt is None:
            return {"checked": False}
        line = (txt or "").strip().splitlines()[0].strip() if txt else ""
        if not line or line.lower() == "notfound":
            # The agent answered — nothing is listening on OUR port. That's a real,
            # self-contained "down" verdict; don't fall back to naming a DIFFERENT
            # instance that happens to be running on this host.
            return {
                "checked": True,
                "active": False,
                "state": "not-listening",
                "detail": f"Nothing is listening on TCP port {port} on this host",
                "service_name": None,
            }
        parts = line.split("|")
        name = parts[0].strip()
        state_raw = parts[1].strip() if len(parts) > 1 else ""
        display = parts[2].strip() if len(parts) > 2 else name
        state = state_raw.lower().replace(" ", "")   # Win32_Service uses "Start Pending" (with space)
        if state in _WIN_KNOWN_STATES:
            return {
                "checked": True,
                "active": state in _WIN_UP_STATES,
                "state": state_raw,
                "detail": f"{state_raw}: {display}",
                "service_name": name,
            }
    # No port on file, or the port-probe result was unparseable (e.g. NetTCPIP
    # module unavailable on very old Windows) — best-effort fallback by name.
    cand = _mssql_win_service_name(instance_name)
    return _classify_windows(run, [cand])


def _ssh_host_for_conn(conn_id, db: Session):
    """SSH-monitored counterpart of db_proxy_service.agent_host_for_conn."""
    if not conn_id:
        return None
    return db.execute(text(
        "SELECT s.ip_address AS ip_address, s.ssh_port AS ssh_port, "
        "s.ssh_username AS ssh_username, s.ssh_password AS ssh_password, "
        "s.os_type AS os_type "
        "FROM database_instances di JOIN os_servers s ON s.id = di.server_id "
        "WHERE di.connection_id = :c AND s.collector = 'ssh' "
        "AND s.ssh_username IS NOT NULL AND s.ssh_password IS NOT NULL LIMIT 1"
    ), {"c": conn_id}).first()


def _ssh_shell(server, cmd, timeout=10):
    """One-shot non-interactive SSH exec. Returns (exit_code, stdout_text), or
    (None, None) if the host couldn't be reached in time — mirrors _agent_shell's
    contract so both paths can share _classify()."""
    try:
        import paramiko
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=server.ip_address, port=server.ssh_port or 22,
            username=server.ssh_username, password=server.ssh_password,
            timeout=timeout,
        )
        try:
            _stdin, stdout, _stderr = ssh.exec_command(cmd, timeout=timeout)
            out = stdout.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
            return code, out
        finally:
            ssh.close()
    except Exception as exc:  # noqa: BLE001 — unreachable host must not crash the collector
        logger.debug(f"[service_state] SSH shell failed for {getattr(server, 'ip_address', '?')}: {exc}")
        return None, None


_SPLIT_MARK = "==ACTMON=="


def _classify_linux(run, candidates):
    for cand in candidates:
        # State AND status-detail in ONE round trip always — a host running several
        # DB engines serializes all of their checks through the agent's single job
        # channel, so halving round trips here directly cuts cross-agent contention
        # (see actmon_agent.py's job loop: one job at a time, never concurrent).
        code, txt = run(
            f"systemctl is-active {cand} 2>/dev/null; echo {_SPLIT_MARK}; "
            f"systemctl status {cand} --no-pager 2>&1 | head -6"
        )
        if txt is None:
            return {"checked": False}
        head, _, rest = (txt or "").partition(_SPLIT_MARK)
        state = head.strip().splitlines()[0].strip() if head.strip() else ""
        if state in _LINUX_KNOWN_STATES:
            detail = state
            if state not in _LINUX_UP_STATES:
                # Pull the real OS-reported line dynamically — never hardcoded text.
                m = _ACTIVE_LINE_RE.search(rest or "")
                if m:
                    detail = m.group(1).strip()
                sm = _STATUS_LINE_RE.search(rest or "")
                if sm:
                    detail = f"{detail} - {sm.group(1).strip()}"
            return {"checked": True, "active": state in _LINUX_UP_STATES, "state": state,
                    "detail": detail, "service_name": cand}
    return {"checked": False}


def _classify_windows(run, candidates):
    for cand in candidates:
        code, txt = run(_win_probe_cmd(cand))
        if txt is None:
            return {"checked": False}
        line = (txt or "").strip().splitlines()[0].strip() if txt else ""
        if not line or line.lower() == "notfound":
            continue   # this candidate name isn't installed here — try the next one
        state_raw, _, display = line.partition("|")
        state_raw = state_raw.strip()
        state = state_raw.lower()
        if state in _WIN_KNOWN_STATES:
            detail = state_raw if state in _WIN_UP_STATES else f"{state_raw}: {display.strip()}"
            return {"checked": True, "active": state in _WIN_UP_STATES, "state": state_raw,
                    "detail": detail, "service_name": cand}
    return {"checked": False}


def _resolve(tech, windows, rec, run):
    if tech == "mssql" and windows:
        return _classify_mssql_windows(run, getattr(rec, "port", None), getattr(rec, "instance_name", None))
    candidates = _candidates_for(tech, windows, rec)
    if not candidates:
        return {"checked": False}
    classify = _classify_windows if windows else _classify_linux
    return classify(run, candidates)


def get_service_state(conn_id, db: Session) -> dict:
    """{"checked": False} means no OS-service verdict was possible (engine has no
    service-manager convention on this host's OS, e.g. Oracle on Linux; the host/
    agent didn't answer; or the OS isn't one this module knows how to query) — the
    caller should fall back entirely to its existing DB-query-based check.
    Otherwise: {"checked": True, "active": bool, "state": "<raw OS state word>",
    "detail": "<raw OS-reported status text>", "service_name": str,
    "source": "agent"|"ssh"}."""
    try:
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not rec:
            return {"checked": False}
        tech = (rec.db_type or "").lower()

        host = agent_host_for_conn(conn_id, db)
        if host and getattr(host, "token", None):
            windows = _is_windows(getattr(host, "os_type", None))
            result = _resolve(tech, windows, rec, lambda cmd: _agent_shell(host.token, cmd, timeout=10))
            if result.get("checked"):
                result["source"] = "agent"
                return result
            return {"checked": False}

        server = _ssh_host_for_conn(conn_id, db)
        if server:
            windows = _is_windows(getattr(server, "os_type", None))
            result = _resolve(tech, windows, rec, lambda cmd: _ssh_shell(server, cmd, timeout=10))
            if result.get("checked"):
                result["source"] = "ssh"
                return result

        return {"checked": False}
    except Exception as exc:  # noqa: BLE001 — a broken probe must never break monitoring
        logger.error(f"[service_state] probe failed for conn {conn_id}: {exc}")
        return {"checked": False}
