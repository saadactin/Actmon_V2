"""
Agent installation service
===========================
Backs the SolarWinds-style "Add Agent" deploy wizard:

  1. POST /install-token  → the wizard persists the ingestion token it will bake
                            into the install command (token → agent identity).
  2. GET  /install/actmon-agent.sh|.ps1 → the real, self-contained host agent.
  3. POST /enroll         → the running agent resolves its agent_name from the
                            token, auto-registering a push agent if needed.

The served agent reads ACTMON_ACCESS_TOKEN + ACTMON_URL from the environment,
enrolls once, then pushes host CPU/memory to /data on a fixed interval.
"""

import datetime
import os
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.agent_model import Agent, AgentToken

# Backend/agent/dist/* (this file: Backend/database/app/services/agent/…)
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), *([os.pardir] * 4)))
MSI_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.msi")
EXE_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.exe")
DEB_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.deb")
RPM_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.rpm")


def msi_available() -> bool:
    return os.path.isfile(MSI_PATH)


def exe_available() -> bool:
    return os.path.isfile(EXE_PATH)


# ── Per-download MSI build (token/URL baked in) ────────────────────────────────
import subprocess as _subprocess
import tempfile as _tempfile
import threading as _threading

_WIX_DIR = os.path.join(_BACKEND_DIR, "agent", "wix", "wix311")
_WXS_PATH = os.path.join(_BACKEND_DIR, "agent", "wix", "product.wxs")
_MSI_BUILD_LOCK = _threading.Lock()


def wix_available() -> bool:
    return os.path.isfile(os.path.join(_WIX_DIR, "candle.exe")) and os.path.isfile(os.path.join(_WIX_DIR, "light.exe"))


def build_token_msi(token: str, url: str) -> str:
    """Compile a self-configuring MSI with the token + URL baked in as defaults, so a
    plain double-click installs a working agent. Returns the built .msi path."""
    if not exe_available():
        raise RuntimeError("Agent exe not built on the server.")
    if not wix_available():
        raise RuntimeError("WiX toolset not available on the server (cannot build MSI).")
    safe_token = "".join(c for c in (token or "") if c.isalnum() or c in "-_")
    safe_url = (url or "").strip().replace('"', "").replace("'", "").rstrip("/")
    if not safe_url.lower().startswith("http"):
        raise RuntimeError("Invalid ActMon URL.")
    candle = os.path.join(_WIX_DIR, "candle.exe")
    light = os.path.join(_WIX_DIR, "light.exe")
    out_dir = _tempfile.mkdtemp(prefix="actmon-msi-")
    wixobj = os.path.join(out_dir, "product.wixobj")
    msi = os.path.join(out_dir, "actmon-agent.msi")
    with _MSI_BUILD_LOCK:   # candle/light write fixed intermediate names → serialize
        _subprocess.run(
            [candle, "-nologo", "-arch", "x64", f"-dAgentExe={EXE_PATH}",
             f"-dToken={safe_token}", f"-dUrl={safe_url}", "-ext", "WixUtilExtension",
             "-out", wixobj, _WXS_PATH],
            check=True, capture_output=True, text=True, timeout=90)
        _subprocess.run(
            [light, "-nologo", "-ext", "WixUtilExtension", "-out", msi, wixobj],
            check=True, capture_output=True, text=True, timeout=90)
    return msi


def deb_available() -> bool:
    return os.path.isfile(DEB_PATH)


def rpm_available() -> bool:
    return os.path.isfile(RPM_PATH)


# ── Pydantic ────────────────────────────────────────────────────────────────

class InstallTokenRequest(BaseModel):
    token: str
    token_name: Optional[str] = None
    os_type: Optional[str] = None


class EnrollRequest(BaseModel):
    token: str
    hostname: Optional[str] = None
    ip_address: Optional[str] = None
    os_type: Optional[str] = None


class DbConfigRequest(BaseModel):
    """DB credentials captured in the Add-Database wizard, handed to the agent
    (by token) so it collects the DB locally."""
    token: str
    db_type: str = "MySQL"
    connection_name: Optional[str] = None
    host: Optional[str] = "localhost"
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    database_name: Optional[str] = None
    environment: Optional[str] = "Production"


class AgentInfraIngest(BaseModel):
    """Full host snapshot pushed by the agent (raw collector output, same commands
    the SSH path runs). Parsed server-side into the canonical infra shape.
    raw_b64 is a base64 alternative for shells that can't JSON-escape (Linux bash)."""
    token: str
    os_type: Optional[str] = None
    raw: str = ""
    raw_b64: Optional[str] = None
    agent_version: Optional[str] = None   # which build is reporting (None = pre-1.1.0 agent)


# ── Services ──────────────────────────────────────────────────────────────────

def svc_create_install_token(req: InstallTokenRequest, db: Session):
    """Upsert the ingestion token issued by the wizard."""
    base = (req.token_name or "actmon-agent").strip() or "actmon-agent"
    rec = db.query(AgentToken).filter(AgentToken.token == req.token).first()
    if rec:
        rec.token_name = base
        rec.agent_name = rec.agent_name or base
        rec.os_type = req.os_type
    else:
        rec = AgentToken(token=req.token, token_name=base, agent_name=base, os_type=req.os_type)
        db.add(rec)
    db.commit()
    db.refresh(rec)
    return {"status": "success", "token": rec.token, "agent_name": rec.agent_name}


def svc_enroll_agent(req: EnrollRequest, db: Session):
    """Resolve (and auto-register) the agent identity for a token."""
    rec = db.query(AgentToken).filter(AgentToken.token == req.token).first()
    if not rec:
        raise HTTPException(status_code=404, detail="Unknown or expired ingestion token.")

    desired = rec.agent_name or rec.token_name or "actmon-agent"
    existing = db.query(Agent).filter(Agent.agent_name == desired).first()

    # If the name is already taken by a DB-connected agent, create a distinct host agent.
    if existing and existing.db_connection_id is not None and req.hostname:
        desired = f"{desired}-{req.hostname}"
        existing = db.query(Agent).filter(Agent.agent_name == desired).first()

    if not existing:
        existing = Agent(
            agent_name=desired,
            db_connection_id=None,
            db_type=req.db_type or "Host",
            hostname=req.hostname,
            ip_address=req.ip_address,
            os_type=req.os_type,
            environment="Production",
            status="online",
            description="Host agent deployed via Add-Agent wizard",
        )
        db.add(existing)
    else:
        existing.status = "online"
        existing.os_type = existing.os_type or req.os_type
        existing.hostname = existing.hostname or req.hostname
        if req.db_type:
            existing.db_type = req.db_type   # promote Host → MySQL when a DB is attached

    existing.last_heartbeat = func.now()   # DB clock — matches the reaper's now()
    rec.agent_name = desired
    db.commit()
    return {"status": "success", "agent_name": desired}


_DEFAULT_DB_PORT = {"mysql": 3306, "postgresql": 5432, "mssql": 1433,
                    "oracle": 1521, "mongodb": 27017, "clickhouse": 9000}

# Display names vary by entry point ("SQL Server", "Postgres", …) but the whole
# platform filters on canonical ids (mssql, postgresql, …). Normalise ONCE here.
_CANON_DB_TYPE = {
    "mysql": "MySQL", "mariadb": "MySQL",
    "postgresql": "PostgreSQL", "postgres": "PostgreSQL",
    "mssql": "MSSQL", "sql server": "MSSQL", "sqlserver": "MSSQL", "microsoft sql server": "MSSQL",
    "oracle": "Oracle", "oracle db": "Oracle",
    "mongodb": "MongoDB", "mongo": "MongoDB",
    "clickhouse": "ClickHouse",
}


def _canon_db_type(dbt: str) -> str:
    return _CANON_DB_TYPE.get((dbt or "").strip().lower(), (dbt or "").strip() or "MySQL")


def svc_save_db_target(req: DbConfigRequest, db: Session):
    """Store the DB the agent should monitor (keyed by token) and reflect it on the
    agent's Infrastructure host so it shows as a monitored DB."""
    from app.models.agent_model import AgentDbTarget
    from app.models.os_server_model import OsServer, DatabaseInstance
    from app.models.connection_model import ConnectionMaster

    dbt = _canon_db_type(req.db_type)       # "SQL Server" → "MSSQL", etc.
    ldbt = dbt.lower()                      # connection_master uses lowercase db_type
    port = req.port or _DEFAULT_DB_PORT.get(ldbt, 0)

    tgt = (db.query(AgentDbTarget)
             .filter(AgentDbTarget.token == req.token, AgentDbTarget.db_type == dbt)
             .first())
    if not tgt:
        tgt = AgentDbTarget(token=req.token, db_type=dbt)
        db.add(tgt)
    tgt.connection_name = req.connection_name or f"{dbt} on agent"
    tgt.host = req.host or "localhost"
    tgt.port = port
    tgt.username = req.username
    tgt.password = req.password
    tgt.database_name = req.database_name
    tgt.environment = req.environment or "Production"
    tgt.enabled = True

    # Create/refresh the connection_master (lowercase db_type) so the DB dashboard works.
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == tgt.connection_id).first() if tgt.connection_id else None
    if not conn:
        conn = ConnectionMaster(
            connection_name=tgt.connection_name, db_type=ldbt, registration_mode="agent",
            environment=tgt.environment, host=tgt.host, port=port,
            username=req.username, password=req.password, database_name=req.database_name,
        )
        db.add(conn)
        db.flush()
        tgt.connection_id = conn.id
    else:
        conn.db_type = ldbt
        conn.host, conn.port = tgt.host, port
        conn.username, conn.password = req.username, req.password
        conn.database_name = req.database_name

    # Reflect on the agent's host so the Databases page shows it + links the dashboard.
    server = db.query(OsServer).filter(OsServer.agent_token == req.token).first()
    if server:
        svcs = set(server.database_services or [])
        svcs.add(dbt)
        server.database_services = sorted(svcs)
        inst = db.query(DatabaseInstance).filter(
            DatabaseInstance.server_id == server.id, DatabaseInstance.db_type == dbt).first()
        if not inst:
            inst = DatabaseInstance(server_id=server.id, db_type=dbt, port=port,
                                    status="Running", org_id=getattr(server, "org_id", 1) or 1)
            db.add(inst)
        inst.connection_id = tgt.connection_id
    _ensure_connection_agent(tgt.connection_id, tgt.connection_name, tgt.host, tgt.environment, dbt, db)
    db.commit()
    return {"status": "success", "db_type": dbt, "connection_id": tgt.connection_id}


def _ensure_connection_agent(connection_id: int, name: str, host: str, environment: str, display_db_type: str, db: Session):
    """Create the per-connection `agents` row (db_connection_id set) that
    agent_collector_service.py's `_sync_agent_threads` requires to ever start
    polling this database's real status. Without this row, database_instances.
    status is set once (at row-creation, always "Running") and never updated
    again — a real bug found in production: DatabaseInstance rows are created
    here and by infra_detail_service.py's infra-push handler, but neither used
    to also create this row, and the only place that did
    (svc_sync_connections_to_agents) deliberately SKIPS creating one whenever
    a host-level agent with the same server name already exists — exactly the
    normal case for an agent-monitored host — so newly-added databases (or
    ones recreated after a reset) silently never got their status polled.
    A host-level agent row (db_connection_id=NULL) and this per-connection row
    coexisting is the correct, required shape, not duplication: the collector
    keys threads off `db_connection_id`, which the host row never has."""
    from app.models.agent_model import Agent
    if db.query(Agent).filter(Agent.db_connection_id == connection_id).first():
        return
    existing_name = db.query(Agent).filter(Agent.agent_name == name).first()
    agent_name = name if not existing_name else f"{name}-{connection_id}"
    db.add(Agent(
        agent_name=agent_name, db_connection_id=connection_id, db_type=display_db_type,
        hostname=host, ip_address=host, environment=environment or "Production", status="offline",
    ))


def svc_get_db_targets(token: str, db: Session):
    """The DBs this agent should collect, keyed by token.

    Each target now also carries its own `agent_name` — the SAME name as the
    per-connection `agents` row `_ensure_connection_agent()` creates
    (db_connection_id set). Without this, the physical agent had no way to
    know a per-connection identity exists at all, so `_db_engine_loop` pushed
    every engine's metrics under the shared HOST identity instead (see
    actmon_agent.py) — every DB engine's telemetry silently landed on the
    host's own agent row as kind=database/tech=unclassified, and the real
    per-connection agent rows ("ClickHouse", "MySQL", …) never received a
    single AgentMetric row: zero Redis ring samples, zero ClickHouse history,
    zero Delivery stats, forever "Waiting for samples" on their own pages."""
    from app.models.agent_model import Agent, AgentDbTarget
    rows = db.query(AgentDbTarget).filter(
        AgentDbTarget.token == token, AgentDbTarget.enabled.is_(True)).all()
    conn_ids = [r.connection_id for r in rows if r.connection_id]
    agent_by_conn = {}
    if conn_ids:
        agent_by_conn = {
            a.db_connection_id: a.agent_name
            for a in db.query(Agent).filter(Agent.db_connection_id.in_(conn_ids)).all()
        }
    return [{
        "db_type": r.db_type, "host": r.host or "localhost", "port": r.port,
        "username": r.username, "password": r.password, "database": r.database_name,
        "connection_name": r.connection_name,
        "agent_name": agent_by_conn.get(r.connection_id) or r.connection_name,
    } for r in rows]


# ── Agent scripts (real, self-contained) ───────────────────────────────────────

LINUX_AGENT = r"""#!/usr/bin/env bash
# ActMon Host Agent (Linux). Reads ACTMON_ACCESS_TOKEN + ACTMON_URL from env.
set -euo pipefail
: "${ACTMON_ACCESS_TOKEN:?ACTMON_ACCESS_TOKEN must be set}"
: "${ACTMON_URL:?ACTMON_URL must be set}"
INTERVAL="${ACTMON_INTERVAL:-15}"
HOST="$(hostname)"
echo "ActMon Agent starting on ${HOST} ..."

AGENT="$(curl -sS -X POST "${ACTMON_URL}/agents/enroll" -H 'Content-Type: application/json' \
  -d "{\"token\":\"${ACTMON_ACCESS_TOKEN}\",\"hostname\":\"${HOST}\",\"os_type\":\"linux\"}" \
  | sed -n 's/.*"agent_name"[ :]*"\([^"]*\)".*/\1/p')"
if [ -z "${AGENT}" ]; then echo "Enrollment failed. Check token/URL." >&2; exit 1; fi
echo "Enrolled as agent: ${AGENT}"

read_cpu() { grep '^cpu ' /proc/stat | awk '{print $2+$3+$4+$5+$6+$7+$8, $5}'; }
set -- $(read_cpu); prev_total=$1; prev_idle=$2
while true; do
  sleep "${INTERVAL}"
  set -- $(read_cpu); total=$1; idle=$2
  dt=$((total - prev_total)); di=$((idle - prev_idle)); prev_total=$total; prev_idle=$idle
  if [ "${dt}" -gt 0 ]; then cpu=$(awk "BEGIN{printf \"%.1f\", (1-(${di}/${dt}))*100}"); else cpu=0; fi
  mt=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  ma=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  mem=$(awk "BEGIN{printf \"%.1f\", (1-(${ma}/${mt}))*100}")
  curl -sS -X POST "${ACTMON_URL}/agents/data" -H 'Content-Type: application/json' \
    -d "{\"agent_name\":\"${AGENT}\",\"metrics\":{\"host_cpu\":${cpu},\"host_memory\":${mem}}}" >/dev/null \
    && echo "$(date +%H:%M:%S)  CPU ${cpu}%  MEM ${mem}%  -> sent" \
    || echo "$(date +%H:%M:%S)  post failed"
done
"""

WINDOWS_AGENT = r"""# ActMon Host Agent (Windows). Reads ACTMON_ACCESS_TOKEN + ACTMON_URL from env.
$ErrorActionPreference = "Stop"
$token = $env:ACTMON_ACCESS_TOKEN
$url   = $env:ACTMON_URL
$interval = if ($env:ACTMON_INTERVAL) { [int]$env:ACTMON_INTERVAL } else { 15 }
if (-not $token -or -not $url) { Write-Error "ACTMON_ACCESS_TOKEN and ACTMON_URL must be set."; return }
Write-Host "ActMon Agent starting on $env:COMPUTERNAME ..."

$enrollBody = @{ token = $token; hostname = $env:COMPUTERNAME; os_type = "windows" } | ConvertTo-Json
try {
  $agent = (Invoke-RestMethod -Uri "$url/agents/enroll" -Method Post -ContentType "application/json" -Body $enrollBody).agent_name
} catch { Write-Error "Enrollment failed: $($_.Exception.Message)"; return }
Write-Host "Enrolled as agent: $agent"

while ($true) {
  try {
    $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
    if (-not $cpu) { $cpu = 0 }
    $os  = Get-CimInstance Win32_OperatingSystem
    $mem = [math]::Round((($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100, 1)
    $body = @{ agent_name = $agent; metrics = @{ host_cpu = [double]$cpu; host_memory = [double]$mem } } | ConvertTo-Json
    Invoke-RestMethod -Uri "$url/agents/data" -Method Post -ContentType "application/json" -Body $body | Out-Null
    Write-Host ("{0}  CPU {1}%  MEM {2}%  -> sent" -f (Get-Date -Format "HH:mm:ss"), $cpu, $mem)
  } catch { Write-Warning $_.Exception.Message }
  Start-Sleep -Seconds $interval
}
"""


def get_agent_script(os_name: str) -> str:
    # Linux → the real, full-featured infra agent (collector push + file/net/fw/service
    # job channel + self-update). This is the SAME payload the setup.sh installer bakes
    # in, so an installed agent's self-update fetch matches byte-for-byte (LF-normalised).
    if (os_name or "").lower().startswith("win"):
        return WINDOWS_AGENT
    return _read_linux_agent()


# Canonical Linux agent script (infra-push) — single source of truth for the setup
# script and the .deb/.rpm packages (shared payload lives in linux/common/).
_LINUX_AGENT_PATH = os.path.join(_BACKEND_DIR, "agent", "linux", "common", "actmon-agent.sh")

LINUX_UNIT = """[Unit]
Description=ActMon Host Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/actmon/agent.conf
ExecStart=/bin/bash /usr/lib/actmon/actmon-agent.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
"""


def _read_linux_agent() -> str:
    # LF-normalise: the file may be checked out CRLF on Windows, but a bash script
    # with CRLF fails to run on Linux — and the agent's self-update compares this
    # byte-for-byte against the on-disk copy, so both must be identical LF text.
    try:
        with open(_LINUX_AGENT_PATH, "r", encoding="utf-8") as f:
            return f.read().replace("\r\n", "\n").replace("\r", "\n")
    except OSError:
        return LINUX_AGENT


def build_linux_setup_sh(token: str, url: str) -> str:
    """One-shot root installer for ANY systemd Linux (Debian/Ubuntu AND RHEL/CentOS/
    Oracle/Fedora). Installs the agent + systemd service directly — no dpkg/rpm needed."""
    safe_token = "".join(c for c in (token or "") if c.isalnum() or c in "-_")
    safe_url = (url or "").strip().replace("'", "")
    if not safe_url.lower().startswith("http"):
        safe_url = ""
    agent = _read_linux_agent().replace("\r\n", "\n")
    return f"""#!/usr/bin/env bash
# ActMon Agent installer — works on any systemd Linux (deb- or rpm-based).
set -e
if [ "$(id -u)" -ne 0 ]; then echo "Run as root (sudo)."; exit 1; fi
install -d -m 755 /usr/lib/actmon /etc/actmon

cat > /usr/lib/actmon/actmon-agent.sh <<'ACTMON_AGENT_EOF'
{agent}
ACTMON_AGENT_EOF
chmod 755 /usr/lib/actmon/actmon-agent.sh

printf 'ACTMON_ACCESS_TOKEN=%s\\nACTMON_URL=%s\\n' '{safe_token}' '{safe_url}' > /etc/actmon/agent.conf
chmod 600 /etc/actmon/agent.conf

cat > /etc/systemd/system/actmon-agent.service <<'ACTMON_UNIT_EOF'
{LINUX_UNIT}ACTMON_UNIT_EOF

systemctl daemon-reload
systemctl enable --now actmon-agent
echo "ActMon Agent installed and started (systemd service: actmon-agent)."
"""


def _to_ascii(s: str) -> str:
    """Guarantee generated install scripts are pure ASCII. Windows PowerShell 5.1
    mis-decodes non-ASCII bytes fetched via DownloadString (em dash -> 'â€"'), which
    breaks the parser. Map common Unicode punctuation to ASCII, drop anything else."""
    repl = {
        "—": "-", "–": "-", "―": "-",          # em / en / horizontal dash
        "‘": "'", "’": "'",                          # smart single quotes
        "“": '"', "”": '"',                          # smart double quotes
        "…": "...", "→": "->", "•": "*",        # ellipsis, arrow, bullet
        " ": " ", "­": "",                            # nbsp, soft hyphen
    }
    for k, v in repl.items():
        s = s.replace(k, v)
    return s.encode("ascii", "ignore").decode("ascii")


def build_windows_install_bat(token: str, url: str) -> str:
    """A double-clickable installer (.bat) with token+URL baked in — self-elevates
    (UAC), downloads a per-request MSI with the token/URL already configured, and
    installs it silently. No PowerShell copy-paste, no properties to type.

    Installs via the SELF-CONFIGURING MSI (/install/actmon-agent.msi), NOT the
    scheduled-task setup script this used to run. A Windows SERVICE is what every
    other always-on application on Windows already uses — antivirus, backup
    agents, Docker Desktop's engine — specifically because Service Control
    Manager's restart-on-failure is a mature, battle-tested primitive with no
    retry cap: it restarts the process indefinitely, not a fixed number of times.
    product.wxs already configures exactly that (restart on the 1st, 2nd and
    every failure after, 30s apart).

    The scheduled-task path this replaced needed a hand-rolled recurring
    "recheck and relaunch" trigger to approximate the same guarantee — and that
    trigger had a real bug (an out-of-range duration) that meant it was never
    actually registered on any host, so every agent installed that way was
    silently running on a 3-attempts-then-permanently-dead policy. A live host
    went dark for 46 minutes, then again overnight, before that was caught. The
    Service path doesn't need a home-grown equivalent at all — SCM already does
    this, correctly, for every service on the machine, and has for decades.

    Downloads the MSI to a file and runs it via msiexec, not an in-memory
    download-and-eval — the same fileless-pattern lesson as before still applies,
    and msiexec installing a downloaded .msi is about as ordinary a Windows
    operation as exists, which also makes it less likely to draw EDR attention
    than a PowerShell-driven exe-and-scheduled-task setup ever was."""
    from urllib.parse import quote
    safe_token = "".join(c for c in (token or "") if c.isalnum() or c in "-_")
    safe_url = (url or "").strip().replace('"', "").replace("'", "").rstrip("/")
    msi_url = f"{safe_url}/agents/install/actmon-agent.msi?token={safe_token}&url={quote(safe_url, safe='')}"
    # cmd.exe's batch parser expands ANY %N (digit) or %VAR% pattern it finds in a
    # .bat file's text BEFORE the line ever reaches the program it's quoted for —
    # including inside a quoted -Command argument. A percent-encoded URL (%3A,
    # %2F, ...) gets silently mangled this way: %3 looks like an (undefined,
    # therefore empty) positional parameter, leaving stray literal characters
    # behind — confirmed live, this turned a valid URL into an unresolvable
    # hostname. Doubling every % to %% is the standard batch-file escape that
    # survives that pass intact and comes out as a single % on the other side.
    msi_url_bat = msi_url.replace("%", "%%")
    # CRLF line endings — it's a Windows batch file.
    lines = [
        "@echo off",
        "title ActMon Agent Installer",
        "net session >nul 2>&1",
        "if %errorlevel% neq 0 (",
        "  echo Requesting administrator privileges...",
        "  powershell -NoProfile -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"",
        "  exit /b",
        ")",
        "echo Installing ActMon Agent...",
        "set \"ACTMON_MSI=%TEMP%\\actmon-agent.msi\"",
        "set \"ACTMON_MSILOG=%TEMP%\\actmon-agent-install.log\"",
        f"powershell -NoProfile -ExecutionPolicy Bypass -Command \"[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '{msi_url_bat}' -OutFile '%ACTMON_MSI%' -UseBasicParsing\"",
        "if not exist \"%ACTMON_MSI%\" (",
        "  echo Failed to download the installer - check your network and the ActMon server URL.",
        "  pause",
        "  exit /b 1",
        ")",
        "echo Running the installer ^(this installs and starts the ActMon Agent service^)...",
        "msiexec /i \"%ACTMON_MSI%\" /qn /norestart /l*v \"%ACTMON_MSILOG%\"",
        "set \"ACTMON_MSIEXIT=%errorlevel%\"",
        "del /f /q \"%ACTMON_MSI%\" >nul 2>&1",
        # 0 = success, 3010 = success but a reboot is recommended (never required
        # for this MSI — it installs a service, it does not touch anything that
        # needs a restart to take effect).
        "if %ACTMON_MSIEXIT% neq 0 if %ACTMON_MSIEXIT% neq 3010 (",
        "  echo Install failed ^(msiexec exit code %ACTMON_MSIEXIT%^). Full log: %ACTMON_MSILOG%",
        "  pause",
        "  exit /b 1",
        ")",
        # msiexec returning is not proof the service actually started — same
        # standard applied to the old script's process/log checks, just aimed at
        # the service manager instead of a bare process list.
        "set \"ACTMON_RUNNING=0\"",
        "for /l %%i in (1,1,20) do (",
        "  sc query ActMonAgent | find \"RUNNING\" >nul 2>&1",
        "  if not errorlevel 1 (set \"ACTMON_RUNNING=1\" & goto :checked)",
        "  powershell -NoProfile -Command \"Start-Sleep -Milliseconds 500\" >nul",
        ")",
        ":checked",
        "if \"%ACTMON_RUNNING%\"==\"1\" (",
        "  echo SUCCESS - ActMon Agent installed and running as a Windows service.",
        "  echo It starts automatically on every boot and restarts itself if it ever stops.",
        ") else (",
        "  echo Installed, but the service has not reported RUNNING yet.",
        "  echo Check with: sc query ActMonAgent",
        "  echo And the install log: %ACTMON_MSILOG%",
        ")",
        "echo.",
        "pause",
    ]
    return _to_ascii("\r\n".join(lines) + "\r\n")


def build_windows_setup_ps1(token: str, url: str) -> str:
    """One-shot elevated installer (STRICT ASCII — PS 5.1 safe), reached via the
    copy-paste one-liner (`Start-Process powershell -Verb RunAs ...`, built in
    SetupWizard.jsx) — so by the time this script body runs, it is already
    elevated; it only re-checks, never re-elevates.

    Installs via the SAME self-configuring MSI as the Deploy Agent wizard's
    .bat (build_windows_install_bat): downloads /install/actmon-agent.msi with
    the token/URL baked in, runs it with msiexec /qn, and verifies a Windows
    SERVICE — not the Scheduled Task this route used to register directly.

    That Scheduled Task path is gone for good reason: its own recovery trigger
    had a real, once-live bug (an out-of-range Task Scheduler duration) that
    meant the recheck-every-5-minutes safety net was never actually registered
    on any host — every agent installed that way was silently running on a
    3-attempts-then-permanently-dead policy. A host went dark for 46 minutes,
    then again overnight, before that was caught. Routing this endpoint through
    the MSI/Service instead — rather than just patching the scheduled-task bug —
    means every Windows install surface in the app (this one-liner, the Deploy
    wizard's .bat, and a direct .msi double-click) now produces the exact same
    outcome: one Service, SCM's own indefinite restart-on-failure, nothing
    home-grown to keep in sync across three different code paths.
    """
    from urllib.parse import quote
    safe_token = "".join(c for c in (token or "") if c.isalnum() or c in "-_")
    safe_url = (url or "").strip().replace('"', "").replace("'", "").rstrip("/")
    if not safe_url.lower().startswith("http"):
        safe_url = ""
    msi_url = f"{safe_url}/agents/install/actmon-agent.msi?token={quote(safe_token)}&url={quote(safe_url, safe='')}"
    script = f"""$ErrorActionPreference = 'Stop'
$url    = '{safe_url}'
$dir    = 'C:\\ProgramData\\ActMon'
$log    = "$dir\\install.log"
$msi    = "$env:TEMP\\actmon-agent.msi"
$msiLog = "$dir\\msiexec.log"
function Log($m) {{
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"
  Write-Host $line
  try {{ New-Item -ItemType Directory -Force -Path $dir | Out-Null; Add-Content -Path $log -Value $line }} catch {{}}
}}

try {{
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {{ throw "This installer must run as Administrator." }}
  if (-not $url)   {{ throw "No ActMon server URL was provided." }}

  Log "ActMon Agent install starting. Server: $url"
  Log "Downloading self-configured installer from $url/agents/install/actmon-agent.msi"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "{msi_url}" -OutFile $msi -UseBasicParsing
  $size = (Get-Item $msi).Length
  if ($size -lt 1000000) {{ throw "Downloaded installer is too small ($size bytes). Is the ActMon server URL reachable from THIS machine?" }}
  Log ("Downloaded {{0:N1}} MB." -f ($size / 1MB))

  $proc = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"") -Wait -PassThru
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {{
    throw "msiexec failed with exit code $($proc.ExitCode). Full log: $msiLog"
  }}
  Log "MSI installed (msiexec exit code $($proc.ExitCode))."

  # msiexec returning success is not proof the service actually started — wait
  # for SCM to report it Running before declaring victory.
  $running = $false
  for ($i = 0; $i -lt 20; $i++) {{
    Start-Sleep -Milliseconds 500
    $svc = Get-Service -Name ActMonAgent -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {{ $running = $true; break }}
  }}
  if (-not $running) {{
    throw "The agent was installed but the ActMonAgent service has not reported Running yet. Check: sc query ActMonAgent  and $msiLog"
  }}
  Log "ActMonAgent service is Running."

  # It is up; now confirm it is actually collecting, not just started. A service
  # that starts and then fails to reach the server is a different fault from one
  # that never starts, and the operator needs to be told which they have.
  $agentLog = "$dir\\agent.log"
  $before = 0
  if (Test-Path $agentLog) {{ $before = (Get-Item $agentLog).Length }}
  $logged = $false
  for ($i = 0; $i -lt 40; $i++) {{
    Start-Sleep -Milliseconds 750
    if ((Test-Path $agentLog) -and (Get-Item $agentLog).Length -gt $before) {{ $logged = $true; break }}
  }}
  if ($logged) {{
    Log "SUCCESS - ActMon Agent installed and reporting, as a Windows service. It starts automatically on every boot and restarts itself if it ever stops."
  }} else {{
    Log ("PARTIAL - the service is running but has not logged anything within 30s. It still starts on every " +
         "boot and restarts on failure regardless, but check that $url is reachable from this machine and see $agentLog.")
  }}
}} catch {{
  Log ("FAILED: " + $_.Exception.Message)
  Write-Host ""
  Write-Host ("Installation failed: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host ("Check that the ActMon server URL (" + $url + ") is reachable from THIS machine. Log: " + $log) -ForegroundColor Yellow
}}
"""
    return _to_ascii(script)
