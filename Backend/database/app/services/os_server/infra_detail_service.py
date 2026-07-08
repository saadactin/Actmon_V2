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
$totalBytes=[double]$os.TotalVisibleMemorySize*1024
$ncpu=[int]$env:NUMBER_OF_PROCESSORS; if($ncpu -lt 1){$ncpu=1}
# Two CPU-time samples ~0.4s apart → instantaneous per-process CPU% (normalised across cores).
$sw=[Diagnostics.Stopwatch]::StartNew()
$pm=@{}; $cpu0=@{}; Get-Process | ForEach-Object { $pm[$_.Id]=$_.ProcessName; $cpu0[$_.Id]=[double]$_.CPU }
$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Sort-Object LocalPort -Unique | ForEach-Object { [pscustomobject]@{ port=[int]$_.LocalPort; address="$($_.LocalAddress)"; process=$pm[[int]$_.OwningProcess]; pid=[string]$_.OwningProcess } })
Start-Sleep -Milliseconds 400
$sw.Stop(); $el=$sw.Elapsed.TotalSeconds; if($el -le 0){$el=0.4}
$procs = @(Get-Process | ForEach-Object { $d=[double]$_.CPU - $(if($cpu0.ContainsKey($_.Id)){$cpu0[$_.Id]}else{[double]$_.CPU}); $cp=[math]::Round(($d/$el)/$ncpu*100,1); if($cp -lt 0){$cp=0}; if($cp -gt 100){$cp=100}; $mp=$(if($totalBytes -gt 0){[math]::Round($_.WorkingSet64*100/$totalBytes,1)}else{0}); [pscustomobject]@{ pid=[string]$_.Id; user=''; cpu=$cp; mem=$mp; command=$_.ProcessName } } | Sort-Object cpu -Descending | Select-Object -First 15)
$ifaces = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { [pscustomobject]@{ iface="$($_.InterfaceAlias)"; state='UP'; addresses=@("$($_.IPAddress)/$($_.PrefixLength)") } })
$neigh = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Reachable' -or $_.State -eq 'Stale' } | Select-Object -First 40 | ForEach-Object { [pscustomobject]@{ ip="$($_.IPAddress)"; mac="$($_.LinkLayerAddress)"; dev="$($_.InterfaceAlias)"; state="$($_.State)" } })
$conn = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -and $_ -ne '' } | Select-Object -Unique)
$routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix } | Sort-Object RouteMetric | Select-Object -First 40 | ForEach-Object { ("{0} via {1} dev {2} metric {3}" -f $_.DestinationPrefix, $_.NextHop, $_.InterfaceAlias, $_.RouteMetric) })
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name="$($_.Name)"; desc="$($_.InterfaceDescription)"; status="$($_.Status)"; mac="$($_.MacAddress)"; speed_mbps=$(if($_.Speed){[int64]($_.Speed/1000000)}else{$null}); mtu=$_.MtuSize; index=$_.ifIndex; type="$($_.MediaType)"; driver="$($_.DriverVersion)" } })
$ifstat = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name="$($_.Name)"; rx_bytes=[int64]$_.ReceivedBytes; tx_bytes=[int64]$_.SentBytes; rx_packets=[int64]$_.ReceivedUnicastPackets; tx_packets=[int64]$_.SentUnicastPackets; rx_dropped=[int64]$_.ReceivedDiscardedPackets; tx_dropped=[int64]$_.OutboundDiscardedPackets; rx_errors=[int64]$_.ReceivedPacketErrors; tx_errors=[int64]$_.OutboundPacketErrors } })
$cstates = @{}; Get-NetTCPConnection -ErrorAction SilentlyContinue | Group-Object State | ForEach-Object { $cstates["$($_.Name)"] = $_.Count }
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue).Count
$wifiRaw = ""; try { $wifiRaw = (netsh wlan show interfaces 2>$null | Out-String) } catch {}
[pscustomobject]@{ system=[pscustomobject]@{ os=$os.Caption; kernel=[string]$os.Version; hostname=$env:COMPUTERNAME }; uptime=("up {0}d {1}h {2}m" -f $up.Days,$up.Hours,$up.Minutes); load=$null; cpu_pct=$cpu; memory=[pscustomobject]@{ total_mb=$totalMB; used_mb=$usedMB; free_mb=$freeMB; available_mb=$freeMB; used_pct=$(if($totalMB){[int]($usedMB*100/$totalMB)}else{0}) }; filesystems=$disks; ports=$ports; processes=$procs; interfaces=$ifaces; neighbors=$neigh; connections=[pscustomobject]@{ count=$conn.Count; peers=@() }; gateway=$gw; dns=[pscustomobject]@{ nameservers=$dns; search=$null }; routes=$routes; adapters=$adapters; ifstat=$ifstat; conn_states=$cstates; udp_count=$udp; wifi_raw=$wifiRaw } | ConvertTo-Json -Depth 6 -Compress
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
    for k in ("filesystems", "ports", "processes", "interfaces", "neighbors", "routes"):
        d[k] = _as_list(d.get(k))
    if not isinstance(d.get("connections"), dict):
        d["connections"] = {"count": 0, "peers": []}
    d["connections"].setdefault("peers", [])
    if not isinstance(d.get("dns"), dict):
        d["dns"] = {"nameservers": [], "search": None}

    # Older Windows agents reported per-process memory in MB (not %). A real % never
    # exceeds 100, so if any process shows >100 the whole snapshot is MB-format —
    # convert every process to a % of physical RAM. Newer agents already send %.
    total_mb = (d.get("memory") or {}).get("total_mb") or 0
    procs = d["processes"]
    if total_mb and any((p.get("mem") or 0) > 100 for p in procs):
        for p in procs:
            try:
                p["mem"] = round((float(p.get("mem") or 0)) / total_mb * 100, 1)
            except (TypeError, ValueError, ZeroDivisionError):
                p["mem"] = 0
    d["network"] = _build_network_windows(d)
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
echo '@@IFLINK@@'; ip -o link 2>/dev/null
echo '@@IFSTAT@@'; for d in /sys/class/net/*; do n=${d##*/}; [ -n "$n" ] && echo "$n $(cat $d/statistics/rx_bytes 2>/dev/null||echo 0) $(cat $d/statistics/tx_bytes 2>/dev/null||echo 0) $(cat $d/statistics/rx_packets 2>/dev/null||echo 0) $(cat $d/statistics/tx_packets 2>/dev/null||echo 0) $(cat $d/statistics/rx_errors 2>/dev/null||echo 0) $(cat $d/statistics/tx_errors 2>/dev/null||echo 0) $(cat $d/statistics/rx_dropped 2>/dev/null||echo 0) $(cat $d/statistics/tx_dropped 2>/dev/null||echo 0) $(cat $d/speed 2>/dev/null||echo -1)"; done
echo '@@CONNSTATE@@'; ss -tan 2>/dev/null | awk 'NR>1{print $1}' | sort | uniq -c
echo '@@UDP@@'; ss -uanH 2>/dev/null | wc -l
echo '@@ROUTES@@'; ip route 2>/dev/null
echo '@@DNS@@'; grep -E '^nameserver' /etc/resolv.conf 2>/dev/null
echo '@@HW@@'; (hostnamectl 2>/dev/null || true)
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


# hostnamectl "  Key Name: value" → our field keys
_HW_MAP = {
    "static hostname": "static_hostname",
    "machine id": "machine_id",
    "boot id": "boot_id",
    "virtualization": "virtualization",
    "chassis": "chassis",
    "icon name": "icon_name",
    "hardware vendor": "hardware_vendor",
    "hardware model": "hardware_model",
    "operating system": "os_pretty",
    "kernel": "kernel_full",
    "architecture": "architecture",
    "firmware version": "firmware_version",
    "firmware date": "firmware_date",
}


def _parse_hw(raw: str) -> dict:
    hw = {}
    for ln in (raw or "").splitlines():
        if ":" not in ln:
            continue
        k, _, v = ln.partition(":")
        key = _HW_MAP.get(k.strip().lower())
        val = v.strip()
        # strip emoji/glyphs the way hostnamectl decorates chassis ("vm 🖴")
        val = re.sub(r"\s*[^\x00-\x7f]+\s*$", "", val).strip()
        if key and val:
            hw[key] = val
    return hw


# Normalize varied TCP-state spellings to a common set for the connection-stats widget.
_CONN_STATE_KEYS = {
    "ESTAB": "ESTABLISHED", "ESTABLISHED": "ESTABLISHED", "LISTEN": "LISTEN",
    "TIME-WAIT": "TIME_WAIT", "TIME_WAIT": "TIME_WAIT", "CLOSE-WAIT": "CLOSE_WAIT",
    "CLOSE_WAIT": "CLOSE_WAIT", "FIN-WAIT-1": "FIN_WAIT", "FIN-WAIT-2": "FIN_WAIT",
    "FIN_WAIT_1": "FIN_WAIT", "FIN_WAIT_2": "FIN_WAIT", "SYN-SENT": "SYN_SENT",
    "SYN_SENT": "SYN_SENT", "SYN-RECV": "SYN_RECEIVED", "SYN_RECV": "SYN_RECEIVED",
    "LAST-ACK": "LAST_ACK", "LAST_ACK": "LAST_ACK", "CLOSING": "CLOSING",
    "CLOSED": "CLOSED", "UNCONN": "UNCONN",
    # Windows Get-NetTCPConnection state spellings (no separators)
    "TIMEWAIT": "TIME_WAIT", "CLOSEWAIT": "CLOSE_WAIT", "SYNSENT": "SYN_SENT",
    "SYNRECEIVED": "SYN_RECEIVED", "FINWAIT1": "FIN_WAIT", "FINWAIT2": "FIN_WAIT",
    "LASTACK": "LAST_ACK", "BOUND": "BOUND", "DELETETCB": "CLOSED",
}


def _parse_iflink(raw: str) -> dict:
    """`ip -o link` → {name: {mac, mtu, index}}."""
    out = {}
    for ln in (raw or "").splitlines():
        m = re.match(r"^(\d+):\s+([^:@]+)[:@]", ln)
        if not m:
            continue
        name = m.group(2).strip()
        mac = re.search(r"link/\w+\s+([0-9a-f:]{17})", ln)
        mtu = re.search(r"\bmtu\s+(\d+)", ln)
        out[name] = {"index": int(m.group(1)), "mac": mac.group(1) if mac else None,
                     "mtu": int(mtu.group(1)) if mtu else None}
    return out


def _parse_ifstat(raw: str) -> dict:
    """/sys counters line: name rx_bytes tx_bytes rx_pkts tx_pkts rx_err tx_err rx_drop tx_drop speed."""
    out = {}
    for ln in (raw or "").splitlines():
        p = ln.split()
        if len(p) >= 10:
            n = p[0]
            try:
                vals = [int(x) for x in p[1:10]]
            except ValueError:
                continue
            out[n] = {
                "rx_bytes": vals[0], "tx_bytes": vals[1], "rx_packets": vals[2], "tx_packets": vals[3],
                "rx_errors": vals[4], "tx_errors": vals[5], "rx_dropped": vals[6], "tx_dropped": vals[7],
                "speed_mbps": vals[8] if vals[8] > 0 else None,
            }
    return out


def _parse_connstate(raw: str) -> dict:
    """`uniq -c` of ss states → {NORMALIZED_STATE: count}."""
    states = {}
    for ln in (raw or "").splitlines():
        p = ln.split()
        if len(p) >= 2 and p[0].isdigit():
            key = _CONN_STATE_KEYS.get(p[1].upper(), p[1].upper())
            states[key] = states.get(key, 0) + int(p[0])
    return states


def _build_network(sec: dict, interfaces: list, neighbors: list, connections: dict) -> dict:
    """Assemble the rich Network object (Linux). Rates are added later in svc_ingest."""
    links = _parse_iflink(sec.get("IFLINK") or "")
    stats = _parse_ifstat(sec.get("IFSTAT") or "")
    routes = [r.strip() for r in (sec.get("ROUTES") or "").splitlines() if r.strip()]
    gateway = next((r.split()[2] for r in routes if r.startswith("default") and "via" in r), None)
    dns = [l.split()[1] for l in (sec.get("DNS") or "").splitlines() if l.startswith("nameserver") and len(l.split()) > 1]
    conn_states = _parse_connstate(sec.get("CONNSTATE") or "")
    try:
        udp_count = int((sec.get("UDP") or "0").strip().split()[0])
    except (ValueError, IndexError):
        udp_count = 0

    ifaces = []
    for n in interfaces:
        name = n.get("iface")
        addrs = n.get("addresses") or []
        lk = links.get(name, {})
        st = stats.get(name, {})
        ifaces.append({
            "name": name, "status": n.get("state"), "mac": n.get("mac") or lk.get("mac"),
            "mtu": lk.get("mtu"), "index": lk.get("index"), "speed_mbps": st.get("speed_mbps"),
            "ipv4": [a for a in addrs if ":" not in a],
            "ipv6": [a for a in addrs if ":" in a],
            **{k: st.get(k) for k in ("rx_bytes", "tx_bytes", "rx_packets", "tx_packets",
                                      "rx_errors", "tx_errors", "rx_dropped", "tx_dropped")},
        })
    return {
        "interfaces": ifaces,
        "conn_states": conn_states,
        "tcp_total": sum(conn_states.values()),
        "udp_count": udp_count,
        "established": conn_states.get("ESTABLISHED", 0),
        "listening": conn_states.get("LISTEN", 0),
        "routes": routes,
        "gateway": gateway,
        "dns": dns,
        "arp": neighbors,
    }


def _parse_wifi(raw: str):
    """Parse `netsh wlan show interfaces` output into a Wi-Fi info dict."""
    if not raw or "SSID" not in raw:
        return None

    def g(label):
        m = re.search(rf"^\s*{re.escape(label)}\s*:\s*(.+)$", raw, re.MULTILINE)
        return m.group(1).strip() if m else None
    ssid = g("SSID")
    if not ssid:
        return None
    return {
        "ssid": ssid, "bssid": g("BSSID"), "signal": g("Signal"), "quality": g("Signal"),
        "state": g("State"), "radio": g("Radio type"), "channel": g("Channel"), "band": g("Band"),
        "rx_rate": g("Receive rate (Mbps)"), "tx_rate": g("Transmit rate (Mbps)"),
        "auth": g("Authentication"), "cipher": g("Cipher"),
    }


def _build_network_windows(d: dict) -> dict:
    """Assemble the rich Network object (Windows). Rates added later in svc_ingest."""
    adapters = _as_list(d.get("adapters"))
    ifstat = {s.get("name"): s for s in _as_list(d.get("ifstat"))}
    ipmap = {}
    for it in _as_list(d.get("interfaces")):
        ipmap.setdefault(it.get("iface"), []).extend(it.get("addresses") or [])
    ifaces = []
    for a in adapters:
        name = a.get("name")
        st = ifstat.get(name, {})
        addrs = ipmap.get(name, [])
        ifaces.append({
            "name": name, "desc": a.get("desc"), "status": a.get("status"), "mac": a.get("mac"),
            "mtu": a.get("mtu"), "speed_mbps": a.get("speed_mbps"), "index": a.get("index"),
            "type": a.get("type"), "driver": a.get("driver"),
            "ipv4": [x for x in addrs if ":" not in x], "ipv6": [x for x in addrs if ":" in x],
            **{k: st.get(k) for k in ("rx_bytes", "tx_bytes", "rx_packets", "tx_packets",
                                      "rx_errors", "tx_errors", "rx_dropped", "tx_dropped")},
        })
    cs_raw = d.get("conn_states") if isinstance(d.get("conn_states"), dict) else {}
    conn_states = {}
    for k, v in cs_raw.items():
        key = _CONN_STATE_KEYS.get(str(k).upper(), str(k).upper())
        try:
            conn_states[key] = conn_states.get(key, 0) + int(v)
        except (TypeError, ValueError):
            pass
    dns = (d.get("dns") or {}).get("nameservers") if isinstance(d.get("dns"), dict) else []
    dns = dns if isinstance(dns, list) else ([dns] if dns else [])
    return {
        "interfaces": ifaces,
        "conn_states": conn_states,
        "tcp_total": sum(conn_states.values()),
        "udp_count": int(d.get("udp_count") or 0),
        "established": conn_states.get("ESTABLISHED", 0),
        "listening": conn_states.get("LISTEN", 0),
        "routes": _as_list(d.get("routes")),
        "gateway": d.get("gateway"),
        "dns": dns,
        "arp": _as_list(d.get("neighbors")),
        "wifi": _parse_wifi(d.get("wifi_raw") or ""),
    }


def parse_linux(raw: str, os_type=None, hostname=None, uptime=None) -> dict:
    """Parse the Linux marker-delimited collector output into the canonical shape.
    Shared by the SSH path and the agent push so both yield identical output."""
    sec = _split_sections(raw)
    sys_lines = (sec.get("SYS") or "").splitlines()
    hw = _parse_hw(sec.get("HW") or "")
    return {
        "system": {
            "os": sys_lines[0] if sys_lines else (os_type or "—"),
            "kernel": sys_lines[1] if len(sys_lines) > 1 else "—",
            "hostname": sys_lines[2] if len(sys_lines) > 2 else (hostname or "—"),
            "architecture": hw.get("architecture"),
            "virtualization": hw.get("virtualization"),
            "chassis": hw.get("chassis"),
            "machine_id": hw.get("machine_id"),
            "boot_id": hw.get("boot_id"),
            "hardware_vendor": hw.get("hardware_vendor"),
            "hardware_model": hw.get("hardware_model"),
            "firmware_version": hw.get("firmware_version"),
            "firmware_date": hw.get("firmware_date"),
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
        "network": _build_network(sec, _parse_net(sec.get("NET") or ""),
                                  _parse_neigh(sec.get("NEIGH") or ""),
                                  _parse_conn(sec.get("CONN") or "")),
    }


def _apply_network_rates(parsed: dict, prev_json, prev_at):
    """Derive per-interface throughput (bytes/sec, packets/sec, Mbps) by diffing the
    current counters against the previous snapshot over the elapsed interval."""
    net = parsed.get("network") or {}
    ifaces = net.get("interfaces") or []
    if not ifaces or not prev_json or not prev_at:
        return
    from datetime import datetime
    try:
        prev = json.loads(prev_json)
    except (ValueError, TypeError):
        return
    prevmap = {i.get("name"): i for i in ((prev.get("network") or {}).get("interfaces") or [])}
    dt = (datetime.utcnow() - prev_at).total_seconds()
    if dt <= 0 or dt > 3600:          # stale / clock skew → skip rates this cycle
        return

    def rate(cur, old):
        try:
            return round(max(0.0, (cur or 0) - (old or 0)) / dt, 1)
        except (TypeError, ValueError):
            return 0.0

    tot_rx = tot_tx = 0.0
    for i in ifaces:
        p = prevmap.get(i.get("name"))
        if not p:
            continue
        i["rx_bps"] = rate(i.get("rx_bytes"), p.get("rx_bytes"))
        i["tx_bps"] = rate(i.get("tx_bytes"), p.get("tx_bytes"))
        i["rx_pps"] = rate(i.get("rx_packets"), p.get("rx_packets"))
        i["tx_pps"] = rate(i.get("tx_packets"), p.get("tx_packets"))
        i["download_mbps"] = round(i["rx_bps"] * 8 / 1e6, 2)
        i["upload_mbps"] = round(i["tx_bps"] * 8 / 1e6, 2)
        cap = i.get("speed_mbps") or 0
        i["download_util_pct"] = round(min(100, i["download_mbps"] / cap * 100), 1) if cap else None
        i["upload_util_pct"] = round(min(100, i["upload_mbps"] / cap * 100), 1) if cap else None
        tot_rx += i["rx_bps"]
        tot_tx += i["tx_bps"]
    net["total_download_mbps"] = round(tot_rx * 8 / 1e6, 2)
    net["total_upload_mbps"] = round(tot_tx * 8 / 1e6, 2)
    net["rate_interval_s"] = round(dt, 1)


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
    tok = None
    if not server:
        # Token must be a known deploy token (per-deployment OR the universal MSI token).
        tok = db.query(AgentToken).filter(AgentToken.token == payload.token).first()
        if not tok:
            return {"status": "error", "message": "Unknown agent token."}

    raw = payload.raw or ""
    if not raw and getattr(payload, "raw_b64", None):
        try:
            raw = base64.b64decode(payload.raw_b64).decode("utf-8", errors="replace")
        except Exception:
            raw = ""

    os_type = (payload.os_type or (server.os_type if server else None) or "").lower()
    if os_type.startswith("win"):
        parsed = parse_windows(raw)
    else:
        parsed = parse_linux(raw, server.os_type if server else None,
                             server.hostname if server else None,
                             server.uptime if server else None)
    if not parsed:
        return {"status": "error", "message": "Could not parse collector output."}

    # New enrollment (token, not yet bound to a host): name the host by its real
    # hostname and DEDUPE on it, so re-downloading/re-installing the MSI on the same
    # machine updates that host instead of creating duplicates.
    if not server:
        hn = ((parsed.get("system") or {}).get("hostname") or "").strip()
        if hn and hn != "—":
            server = (db.query(OsServer)
                        .filter(OsServer.collector == "agent", OsServer.hostname == hn).first())
        if server:
            server.agent_token = payload.token          # rebind to the latest installer's token
        else:
            name = hn if (hn and hn != "—") else (tok.agent_name or tok.token_name or "host-agent")
            server = OsServer(
                server_name=name, hostname=(hn or name), ip_address=name,
                os_type=("Windows" if os_type.startswith("win") else "Linux"),
                environment="Production", node_type="Standalone", status="Unknown",
                collector="agent", agent_token=payload.token, monitoring_enabled=True,
            )
            db.add(server)
            db.flush()

    _apply_network_rates(parsed, server.last_infra_json, server.last_infra_at)
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
        "collector": server.collector or "ssh",
        "is_agent": (server.collector or "") == "agent" and bool(server.agent_token),
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
