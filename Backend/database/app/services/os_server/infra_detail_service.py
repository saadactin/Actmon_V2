"""
Per-host Infrastructure detail collector.

Opens ONE SSH session to the target host and runs a single marker-delimited
command bundle, then parses the output into structured JSON:
  system info, uptime, load, CPU%, memory, filesystems, listening ports +
  owning process, top processes, network interfaces, active connections,
  and ARP neighbors (connected devices).

Linux-focused (ss/ps/ip/df/free). Windows hosts return whatever succeeds;
sections that fail are simply empty — never raises.
"""
import re
import base64
import json
import paramiko

from app.models.os_server_model import OsServer

# ── Windows collector: one PowerShell script that emits the SAME JSON shape as
#    the Linux parser. Sent via -EncodedCommand (UTF-16LE base64) to dodge quoting. ──
_WIN_PS = r"""
$ErrorActionPreference='SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = [int][math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)
$totalMB = [int]($os.TotalVisibleMemorySize/1024)
$freeMB = [int]($os.FreePhysicalMemory/1024)
$usedMB = $totalMB - $freeMB
$up = (Get-Date) - $os.LastBootUpTime
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $u=$_.Size-$_.FreeSpace; [pscustomobject]@{ filesystem=$_.DeviceID; mount=$_.DeviceID; size=("{0} GB" -f [math]::Round($_.Size/1GB,1)); used=("{0} GB" -f [math]::Round($u/1GB,1)); avail=("{0} GB" -f [math]::Round($_.FreeSpace/1GB,1)); use_pct=$(if($_.Size){[int]($u*100/$_.Size)}else{0}) } })
$pm=@{}; Get-Process | ForEach-Object { $pm[$_.Id]=$_.ProcessName }
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique | ForEach-Object { [pscustomobject]@{ port=[int]$_.LocalPort; address="$($_.LocalAddress)"; process=$pm[[int]$_.OwningProcess]; pid=[string]$_.OwningProcess } })
$procs = @(Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 | ForEach-Object { [pscustomobject]@{ pid=[string]$_.Id; user=''; cpu=[int]([math]::Round($_.CPU)); mem=[int]([math]::Round($_.WorkingSet64/1MB)); command=$_.ProcessName } })
$ifaces = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { [pscustomobject]@{ iface="$($_.InterfaceAlias)"; state='UP'; addresses=@("$($_.IPAddress)/$($_.PrefixLength)") } })
$neigh = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Reachable' -or $_.State -eq 'Stale' } | Select-Object -First 40 | ForEach-Object { [pscustomobject]@{ ip="$($_.IPAddress)"; mac="$($_.LinkLayerAddress)"; dev="$($_.InterfaceAlias)"; state="$($_.State)" } })
$conn = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
[pscustomobject]@{ system=[pscustomobject]@{ os=$os.Caption; kernel=[string]$os.Version; hostname=$env:COMPUTERNAME }; uptime=("up {0}d {1}h {2}m" -f $up.Days,$up.Hours,$up.Minutes); load=$null; cpu_pct=$cpu; memory=[pscustomobject]@{ total_mb=$totalMB; used_mb=$usedMB; free_mb=$freeMB; available_mb=$freeMB; used_pct=$(if($totalMB){[int]($usedMB*100/$totalMB)}else{0}) }; filesystems=$disks; ports=$ports; processes=$procs; interfaces=$ifaces; neighbors=$neigh; connections=[pscustomobject]@{ count=$conn.Count; peers=@() } } | ConvertTo-Json -Depth 5 -Compress
"""


def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def parse_windows(raw):
    """Parse the Windows PowerShell collector JSON into the canonical shape.
    Shared by the SSH path and the agent push so both yield identical output."""
    i, j = raw.find("{"), raw.rfind("}")
    if i < 0 or j <= i:
        return None
    try:
        d = json.loads(raw[i:j + 1])
    except Exception:
        return None
    # ConvertTo-Json collapses single-element arrays to objects — normalize back to lists.
    for k in ("filesystems", "ports", "processes", "interfaces", "neighbors"):
        d[k] = _as_list(d.get(k))
    if not isinstance(d.get("connections"), dict):
        d["connections"] = {"count": 0, "peers": []}
    d["connections"].setdefault("peers", [])
    return d


def _run_windows(ssh):
    b64 = base64.b64encode(_WIN_PS.encode("utf-16-le")).decode()
    _, out, _ = ssh.exec_command(f"powershell -NoProfile -NonInteractive -EncodedCommand {b64}", timeout=35)
    raw = out.read().decode("utf-8", errors="replace")
    return parse_windows(raw)


# The exact collector commands the agent must run so its output matches SSH.
WINDOWS_COLLECTOR_PS = _WIN_PS

# Single bundle so we only pay for one SSH connection.
_BUNDLE = r"""
echo '@@SYS@@'; (cat /etc/os-release 2>/dev/null | grep -E '^PRETTY_NAME' | cut -d'"' -f2); uname -sr 2>/dev/null; hostname 2>/dev/null
echo '@@UPTIME@@'; (uptime -p 2>/dev/null || uptime 2>/dev/null)
echo '@@LOAD@@'; cat /proc/loadavg 2>/dev/null
echo '@@CPU@@'; top -bn1 2>/dev/null | grep -i 'Cpu(s)' | head -1
echo '@@MEM@@'; free -m 2>/dev/null | awk 'NR==2{print $2, $3, $4, $7}'
echo '@@DISK@@'; df -hP 2>/dev/null | tail -n +2
echo '@@PORTS@@'; (ss -tlnpH 2>/dev/null || ss -tlnp 2>/dev/null | tail -n +2 || netstat -tlnp 2>/dev/null)
echo '@@PROCS@@'; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | tail -n +2 | head -15
echo '@@NET@@'; ip -br addr 2>/dev/null
echo '@@CONN@@'; (ss -tnHo state established 2>/dev/null || ss -tn state established 2>/dev/null | tail -n +2) | head -50
echo '@@NEIGH@@'; ip neigh 2>/dev/null
echo '@@END@@'
"""


def _split_sections(output: str) -> dict:
    out = {}
    current = None
    for line in output.splitlines():
        m = re.match(r"^@@([A-Z]+)@@$", line.strip())
        if m:
            current = m.group(1)
            out[current] = []
            continue
        if current and current != "END":
            out[current].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


def _to_int(s, default=0):
    try:
        return int(float(str(s).strip().replace("%", "")))
    except Exception:
        return default


def _parse_disk(raw):
    rows = []
    for ln in raw.splitlines():
        p = ln.split()
        if len(p) >= 6:
            rows.append({
                "filesystem": p[0], "size": p[1], "used": p[2], "avail": p[3],
                "use_pct": _to_int(p[4]), "mount": " ".join(p[5:]),
            })
    return rows


def _parse_ports(raw):
    rows = []
    for ln in raw.splitlines():
        p = ln.split()
        if len(p) < 4:
            continue
        # ss -tlnp columns: State Recv-Q Send-Q Local:Port Peer:Port Process
        local = p[3]
        port = local.rsplit(":", 1)[-1]
        addr = local.rsplit(":", 1)[0]
        proc, pid = None, None
        mproc = re.search(r'"([^"]+)",pid=(\d+)', ln)
        if mproc:
            proc, pid = mproc.group(1), mproc.group(2)
        if port.isdigit():
            rows.append({"port": int(port), "address": addr, "process": proc or "—", "pid": pid})
    # de-dup by port, keep first
    seen, uniq = set(), []
    for r in sorted(rows, key=lambda x: x["port"]):
        if r["port"] in seen:
            continue
        seen.add(r["port"]); uniq.append(r)
    return uniq


def _parse_procs(raw):
    rows = []
    for ln in raw.splitlines():
        p = ln.split(None, 4)
        if len(p) >= 5 and p[0].isdigit():
            rows.append({"pid": p[0], "user": p[1], "cpu": _to_int(p[2]), "mem": _to_int(p[3]), "command": p[4]})
    return rows


def _parse_net(raw):
    rows = []
    for ln in raw.splitlines():
        p = ln.split()
        if len(p) >= 2:
            rows.append({"iface": p[0], "state": p[1], "addresses": [a for a in p[2:] if a]})
    return rows


def _parse_conn(raw):
    peers = []
    for ln in raw.splitlines():
        p = ln.split()
        # established rows: ... Local Peer ...  (peer is the last :port token typically index 4 or 3)
        cand = [t for t in p if ":" in t]
        if len(cand) >= 2:
            peers.append(cand[1])
    uniq = sorted(set(peers))
    return {"count": len([ln for ln in raw.splitlines() if ln.strip()]), "peers": uniq[:30]}


def _parse_neigh(raw):
    rows = []
    for ln in raw.splitlines():
        p = ln.split()
        if not p:
            continue
        ip = p[0]
        dev = p[p.index("dev") + 1] if "dev" in p else None
        mac = p[p.index("lladdr") + 1] if "lladdr" in p else None
        state = p[-1]
        rows.append({"ip": ip, "dev": dev, "mac": mac, "state": state})
    return rows


def _parse_cpu(raw):
    # "%Cpu(s):  3.2 us,  1.1 sy, ..."  -> us + sy
    m = re.findall(r"([\d.]+)\s*us.*?([\d.]+)\s*sy", raw)
    try:
        nums = re.findall(r"([\d.]+)\s*(us|sy)", raw)
        total = sum(float(v) for v, _ in nums)
        return round(total, 1)
    except Exception:
        return None


def _parse_mem(raw):
    p = raw.split()
    if len(p) >= 4:
        total, used, free, avail = (_to_int(x) for x in p[:4])
        return {
            "total_mb": total, "used_mb": used, "free_mb": free, "available_mb": avail,
            "used_pct": round(used * 100 / total) if total else 0,
        }
    return None


def _parse_load(raw):
    p = raw.split()
    if len(p) >= 3:
        try:
            return {"one": float(p[0]), "five": float(p[1]), "fifteen": float(p[2])}
        except Exception:
            return None
    return None


# Marker-delimited bundle the Linux agent must run so its output matches SSH.
LINUX_COLLECTOR_BUNDLE = _BUNDLE


def parse_linux(raw: str, os_type=None, hostname=None, uptime=None) -> dict:
    """Parse the Linux marker-delimited collector output into the canonical shape.
    Shared by the SSH path and the agent push so both yield identical output."""
    sec = _split_sections(raw)
    sys_lines = (sec.get("SYS") or "").splitlines()
    return {
        "system": {
            "os": sys_lines[0] if sys_lines else (os_type or "—"),
            "kernel": sys_lines[1] if len(sys_lines) > 1 else "—",
            "hostname": sys_lines[2] if len(sys_lines) > 2 else (hostname or "—"),
        },
        "uptime": sec.get("UPTIME") or uptime or "—",
        "load": _parse_load(sec.get("LOAD") or ""),
        "cpu_pct": _parse_cpu(sec.get("CPU") or ""),
        "memory": _parse_mem(sec.get("MEM") or ""),
        "filesystems": _parse_disk(sec.get("DISK") or ""),
        "ports": _parse_ports(sec.get("PORTS") or ""),
        "processes": _parse_procs(sec.get("PROCS") or ""),
        "interfaces": _parse_net(sec.get("NET") or ""),
        "connections": _parse_conn(sec.get("CONN") or ""),
        "neighbors": _parse_neigh(sec.get("NEIGH") or ""),
    }


def _live_cols_from_snapshot(d: dict) -> dict:
    """Derive the OsServer live columns (cpu/ram/disk/uptime) from a parsed snapshot."""
    cpu = d.get("cpu_pct")
    mem = (d.get("memory") or {}).get("used_pct")
    fs = d.get("filesystems") or []
    disk = max((f.get("use_pct", 0) for f in fs), default=None)
    return {
        "cpu_usage": f"{round(cpu)}%" if cpu is not None else None,
        "ram_usage": f"{mem}%" if mem is not None else None,
        "disk_usage": f"{disk}%" if disk is not None else None,
        "uptime": d.get("uptime"),
    }


def svc_ingest_agent_infra(payload, db) -> dict:
    """Agent push: parse the raw collector output (same commands as SSH) and store
    it on the matching OsServer so the detail UI renders identically. Also mirrors
    CPU/mem to the Agents page so both surfaces stay in sync."""
    from datetime import datetime
    from app.models.agent_model import Agent, AgentMetric, AgentToken

    server = db.query(OsServer).filter(OsServer.agent_token == payload.token).first()
    if not server:
        # Deploy-wizard token (AgentToken) → auto-create an Infrastructure host for it,
        # so agent-deployed hosts appear alongside SSH hosts with the same detail UI.
        tok = db.query(AgentToken).filter(AgentToken.token == payload.token).first()
        if not tok:
            return {"status": "error", "message": "Unknown agent token."}
        name = tok.agent_name or tok.token_name or "host-agent"
        server = OsServer(
            server_name=name, hostname=name, ip_address=name,
            os_type=("Windows" if (payload.os_type or "").lower().startswith("win") else "Linux"),
            environment="Production", node_type="Standalone", status="Unknown",
            collector="agent", agent_token=payload.token, monitoring_enabled=True,
        )
        db.add(server)
        db.flush()

    raw = payload.raw or ""
    if not raw and getattr(payload, "raw_b64", None):
        try:
            raw = base64.b64decode(payload.raw_b64).decode("utf-8", errors="replace")
        except Exception:
            raw = ""

    os_type = (payload.os_type or server.os_type or "").lower()
    if os_type.startswith("win"):
        parsed = parse_windows(raw)
    else:
        parsed = parse_linux(raw, server.os_type, server.hostname, server.uptime)
    if not parsed:
        return {"status": "error", "message": "Could not parse collector output."}

    server.last_infra_json = json.dumps(parsed)
    live = _live_cols_from_snapshot(parsed)
    server.cpu_usage = live["cpu_usage"] or server.cpu_usage
    server.ram_usage = live["ram_usage"] or server.ram_usage
    server.disk_usage = live["disk_usage"] or server.disk_usage
    server.uptime = live["uptime"] or server.uptime
    server.status = "Connected"
    server.last_infra_at = datetime.utcnow()
    if not server.hostname or server.hostname == server.ip_address:
        hn = (parsed.get("system") or {}).get("hostname")
        if hn and hn != "—":
            server.hostname = hn

    # Auto-created agent hosts start with ip_address = agent name (the enroll flow
    # doesn't know the IP). Learn the real address from the agent's own interface
    # report so SSH-based drill-downs (file explorer, terminal) can reach the host.
    def _is_ip(v: str) -> bool:
        import re
        return bool(re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", (v or "").strip()))
    if not _is_ip(server.ip_address):
        for itf in (parsed.get("interfaces") or []):
            got = None
            for addr in (itf.get("addresses") or []):
                ip = str(addr).split("/")[0].strip()
                if _is_ip(ip) and not ip.startswith(("127.", "169.254.")):
                    server.ip_address = ip
                    got = ip
                    break
            if got:
                break

    # DB services come from what the user REGISTERED — add-server form selections AND
    # DB-credential targets. MERGE (never wipe form selections, never scan open ports).
    from app.models.os_server_model import DatabaseInstance
    from app.models.agent_model import AgentDbTarget
    targets = db.query(AgentDbTarget).filter(
        AgentDbTarget.token == payload.token, AgentDbTarget.enabled.is_(True)).all()
    current = set(server.database_services or [])
    merged = current | {t.db_type for t in targets}
    if merged != current:
        server.database_services = sorted(merged)
    have = {di.db_type: di for di in db.query(DatabaseInstance).filter(DatabaseInstance.server_id == server.id).all()}
    for t in targets:
        inst = have.get(t.db_type)
        if not inst:
            inst = DatabaseInstance(server_id=server.id, db_type=t.db_type, port=t.port,
                                    status="Running", org_id=getattr(server, "org_id", 1) or 1)
            db.add(inst)
        inst.connection_id = t.connection_id   # link the DB dashboard

    # Mirror to the Agents page (Agent row + latest metric) so both surfaces agree.
    agent_name = server.server_name
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        agent = Agent(agent_name=agent_name, db_type="Host", hostname=server.hostname,
                      ip_address=server.ip_address, os_type=server.os_type,
                      environment=server.environment, description="Host agent (Infrastructure)")
        db.add(agent)
    agent.status = "online"
    agent.last_heartbeat = datetime.utcnow()
    cpu = parsed.get("cpu_pct") or 0.0
    mem = (parsed.get("memory") or {}).get("used_pct") or 0.0
    db.add(AgentMetric(agent_name=agent_name, host_cpu=float(cpu), host_memory=float(mem)))

    db.commit()
    return {"status": "success", "server_id": server.id, "agent_name": agent_name}


def svc_host_infra_detail(server_id: int, db) -> dict:
    server = db.query(OsServer).filter(OsServer.id == server_id).first()
    if not server:
        return {"status": "error", "message": "Host not found"}

    host = {
        "id": server.id, "server_name": server.server_name, "hostname": server.hostname,
        "ip_address": server.ip_address, "os_type": server.os_type,
        "environment": server.environment, "uptime": server.uptime,
    }

    # Agent-connected host → serve the last snapshot the agent pushed (same shape).
    if (server.collector or "ssh") == "agent":
        if server.last_infra_json:
            d = json.loads(server.last_infra_json)
            d["status"] = "success"
            d["host"] = host
            return d
        return {"status": "error", "message": "Waiting for the agent to report. Ensure it is installed and running.", "host": host}

    is_windows = "win" in str(server.os_type or "").lower()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=server.ip_address, port=server.ssh_port or 22,
            username=server.ssh_username, password=server.ssh_password, timeout=12,
        )
        if is_windows:
            wd = _run_windows(ssh)
            ssh.close()
            if wd:
                wd["status"] = "success"
                wd["host"] = host
                return wd
            return {"status": "error", "message": "No data returned from Windows host (PowerShell/OpenSSH may be unavailable).", "host": host}
        _, out, _ = ssh.exec_command(_BUNDLE, timeout=25)
        raw = out.read().decode("utf-8", errors="replace")
        ssh.close()
    except Exception as e:
        return {"status": "error", "message": str(e), "host": host}

    d = parse_linux(raw, server.os_type, server.hostname, server.uptime)
    d["status"] = "success"
    d["host"] = host
    return d
