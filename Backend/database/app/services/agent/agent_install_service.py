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
from sqlalchemy.orm import Session

from app.models.agent_model import Agent, AgentToken

# Backend/agent/dist/* (this file: Backend/database/app/services/agent/…)
_BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), *([os.pardir] * 4)))
MSI_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.msi")
DEB_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.deb")
RPM_PATH = os.path.join(_BACKEND_DIR, "agent", "dist", "actmon-agent.rpm")


def msi_available() -> bool:
    return os.path.isfile(MSI_PATH)


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

    existing.last_heartbeat = datetime.datetime.utcnow()
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
    db.commit()
    return {"status": "success", "db_type": dbt, "connection_id": tgt.connection_id}


def svc_get_db_targets(token: str, db: Session):
    from app.models.agent_model import AgentDbTarget
    rows = db.query(AgentDbTarget).filter(
        AgentDbTarget.token == token, AgentDbTarget.enabled.is_(True)).all()
    return [{
        "db_type": r.db_type, "host": r.host or "localhost", "port": r.port,
        "username": r.username, "password": r.password, "database": r.database_name,
        "connection_name": r.connection_name,
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
    return WINDOWS_AGENT if (os_name or "").lower().startswith("win") else LINUX_AGENT


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
    try:
        with open(_LINUX_AGENT_PATH, "r", encoding="utf-8") as f:
            return f.read()
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


def build_windows_setup_ps1(token: str, url: str) -> str:
    """One-shot elevated installer: install MSI, write registry token/URL, create
    + start the boot-time SYSTEM scheduled task. token/url are baked in."""
    # Basic sanitisation — these are reflected into a script.
    safe_token = "".join(c for c in (token or "") if c.isalnum() or c in "-_")
    safe_url = (url or "").strip().replace("'", "")
    if not safe_url.lower().startswith("http"):
        safe_url = ""
    return f"""$ErrorActionPreference = 'Stop'
$token = '{safe_token}'
$url   = '{safe_url}'
$exe   = 'C:\\ProgramData\\ActMon\\actmon-agent.exe'
$msi   = "$env:TEMP\\actmon-agent.msi"
Write-Host 'Downloading ActMon Agent installer...'
Invoke-WebRequest -Uri "$url/agents/download/windows" -OutFile $msi
Write-Host 'Installing MSI...'
Start-Process msiexec.exe -Wait -ArgumentList '/i', "$msi", '/qb', '/norestart'

New-Item -Path 'HKLM:\\SOFTWARE\\ActMon\\Agent' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\ActMon\\Agent' -Name Token -Value $token
Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\ActMon\\Agent' -Name Url   -Value $url

# Persistent boot-time SYSTEM task (Register-ScheduledTask surfaces errors, unlike schtasks.exe).
try {{
    $action    = New-ScheduledTaskAction -Execute $exe
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName 'ActMonAgent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName 'ActMonAgent'
    Write-Host 'Scheduled task ActMonAgent registered and started.'
}} catch {{
    Write-Warning "Scheduled task setup failed: $($_.Exception.Message)"
}}

# Start immediately (hidden) so the agent reports right away, even if the task lags.
Start-Process -FilePath $exe -WindowStyle Hidden
Write-Host 'ActMon Agent installed and started. It also starts automatically on every boot.'
"""
