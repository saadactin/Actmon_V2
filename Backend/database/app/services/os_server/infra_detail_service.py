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
from app.services.common.credential_encryption_service import credential_encryption

# ── Windows collector: one PowerShell script that emits the SAME JSON shape as
#    the Linux parser. Sent via -EncodedCommand (UTF-16LE base64) to dodge quoting. ──
_WIN_PS = r"""
$ErrorActionPreference='SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
# Win32_Processor.LoadPercentage is a stale/cached WMI counter and routinely
# disagrees with the real instantaneous load by a wide margin; the perf-counter
# reading below is what Task Manager itself is backed by, so it's the one that
# actually matches what's happening on the box. LoadPercentage is kept as a
# fallback only for the rare locked-down host where performance counters are
# disabled.
# ONE counter sample (~1 s) for every counter this script reads, instead of a separate sample per counter.
$allCtr = @((Get-Counter -Counter @('\Processor(*)\% Processor Time','\Processor(_Total)\% Privileged Time','\Processor(_Total)\% User Time','\Processor(_Total)\% Interrupt Time','\Processor(_Total)\% DPC Time','\System\Context Switches/sec','\Processor(_Total)\Interrupts/sec','\Processor(_Total)\DPCs Queued/sec','\System\Processor Queue Length','\Memory\Available Bytes','\Memory\Cache Bytes','\Memory\Committed Bytes','\Memory\Commit Limit','\Memory\Pool Paged Bytes','\Memory\Pool Nonpaged Bytes','\Memory\Page Faults/sec','\Memory\Pages/sec','\Memory\Pages Input/sec','\Memory\Modified Page List Bytes','\Memory\Standby Cache Normal Priority Bytes','\Memory\Standby Cache Reserve Bytes','\Memory\Standby Cache Core Bytes','\Memory\Free & Zero Page List Bytes','\Paging File(_Total)\% Usage') -ErrorAction SilentlyContinue).CounterSamples)
$cpu = ($allCtr | Where-Object { $_.InstanceName -eq '_total' -and $_.Path -like '*% processor time' } | Select-Object -First 1).CookedValue
if ($null -eq $cpu) { $cpu = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples.CookedValue }
if ($cpu) { $cpu = [math]::Round($cpu, 1) } else { $cpu = [int][math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average) }
# Windows has no Unix-style load average — Processor Queue Length (threads
# ready to run but waiting for a core) is the closest native equivalent, so
# the UI can show something real instead of a bare "not reported on this OS".
$queueLen = ($allCtr | Where-Object { $_.Path -like '*processor queue length' } | Select-Object -First 1).CookedValue
if ($null -eq $queueLen) { $queueLen = (Get-Counter '\System\Processor Queue Length' -ErrorAction SilentlyContinue).CounterSamples.CookedValue }
if ($null -eq $queueLen) { $queueLen = $null } else { $queueLen = [int]$queueLen }
$totalMB = [int]($os.TotalVisibleMemorySize/1024)
$freeMB = [int]($os.FreePhysicalMemory/1024)
$usedMB = $totalMB - $freeMB
$up = (Get-Date) - $os.LastBootUpTime
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $u=$_.Size-$_.FreeSpace; [pscustomobject]@{ filesystem=$_.DeviceID; mount=$_.DeviceID; size=("{0} GB" -f [math]::Round($_.Size/1GB,1)); used=("{0} GB" -f [math]::Round($u/1GB,1)); avail=("{0} GB" -f [math]::Round($_.FreeSpace/1GB,1)); use_pct=$(if($_.Size){[int]($u*100/$_.Size)}else{0}); size_b=[int64]$_.Size; used_b=[int64]$u; avail_b=[int64]$_.FreeSpace; fstype=$_.FileSystem; label=$_.VolumeName } })
$totalBytes=[double]$os.TotalVisibleMemorySize*1024
$ncpu=[int]$env:NUMBER_OF_PROCESSORS; if($ncpu -lt 1){$ncpu=1}
# Two CPU-time samples ~0.4s apart → instantaneous per-process CPU% (normalised across cores).
$sw=[Diagnostics.Stopwatch]::StartNew()
$pm=@{}; $cpu0=@{}; Get-Process | ForEach-Object { $pm[$_.Id]=$_.ProcessName; $cpu0[$_.Id]=[double]$_.CPU }
# TCP connection table via netstat, NOT Get-NetTCPConnection. On a host with many
# thousands of live connections (routine on a box running several database
# engines at once) Get-NetTCPConnection took 15-20+ SECONDS per call in testing —
# and this script used to call it three separate times (listeners / established /
# all-states-grouped), reliably exceeding the agent's own infra-push timeout and
# leaving the host stuck permanently offline even though the box and every
# database on it were completely healthy. netstat -ano returns the identical
# information in well under a second regardless of connection count, because it
# doesn't pay Get-NetTCPConnection's internal WMI-correlation cost.
$stateMap=@{LISTENING='Listen';ESTABLISHED='Established';TIME_WAIT='TimeWait';CLOSE_WAIT='CloseWait';SYN_SENT='SynSent';SYN_RECEIVED='SynReceived';FIN_WAIT_1='FinWait1';FIN_WAIT_2='FinWait2';CLOSING='Closing';LAST_ACK='LastAck';CLOSED='Closed';DELETE_TCB='DeleteTcb'}
$tcpRows = @(netstat -ano | Where-Object { $_ -match '^\s*TCP\s' } | ForEach-Object {
  $f = ($_.Trim() -split '\s+')
  if ($f.Length -ge 5) {
    $lp = $f[1]; $ix = $lp.LastIndexOf(':')
    if ($ix -ge 0) { [pscustomobject]@{ LocalAddress=$lp.Substring(0,$ix); LocalPort=$lp.Substring($ix+1); State=$f[3]; OwningProcess=$f[4] } }
  }
})
$ports = @($tcpRows | Where-Object { $_.State -eq 'LISTENING' } | Sort-Object { [int]$_.LocalPort } -Unique | ForEach-Object { [pscustomobject]@{ port=[int]$_.LocalPort; address=$_.LocalAddress; process=$pm[[int]$_.OwningProcess]; pid=[string]$_.OwningProcess } })
Start-Sleep -Milliseconds 400
$sw.Stop(); $el=$sw.Elapsed.TotalSeconds; if($el -le 0){$el=0.4}
$dbNames = @('postgres','mysqld','mariadbd','sqlservr','oracle','tnslsnr','mongod','clickhouse')
$pobj=@{}
$rawProcs = @(Get-Process | ForEach-Object { $pobj[$_.Id]=$_; $d=[double]$_.CPU - $(if($cpu0.ContainsKey($_.Id)){$cpu0[$_.Id]}else{[double]$_.CPU}); $cp=[math]::Round(($d/$el)/$ncpu*100,1); if($cp -lt 0){$cp=0}; if($cp -gt 100){$cp=100}; $mp=$(if($totalBytes -gt 0){[math]::Round($_.WorkingSet64*100/$totalBytes,1)}else{0}); [pscustomobject]@{ pid=[string]$_.Id; cpu=$cp; mem=$mp; name=$_.ProcessName; threads=$(if($_.Threads){$_.Threads.Count}else{$null}); ws=[int64]$_.WorkingSet64; pb=[int64]$_.PrivateMemorySize64; pk=[int64]$_.PeakWorkingSet64 } })
# A database engine is usually MANY OS processes sharing one name (e.g. Postgres
# runs ~30 backend/worker processes) — group by name and sum, the same way Task
# Manager's own grouped view ("PostgreSQL Server (30)") does, instead of leaving
# each worker as its own near-idle row that a plain top-15-by-CPU cut would drop.
$grouped = @($rawProcs | Group-Object name | ForEach-Object { $g=$_.Group; $rep=($g | Sort-Object cpu -Descending | Select-Object -First 1); [pscustomobject]@{ pid=$rep.pid; user=''; cpu=[math]::Round(($g | Measure-Object cpu -Sum).Sum,1); mem=[math]::Round(($g | Measure-Object mem -Sum).Sum,1); command=$_.Name; threads=($g | Measure-Object threads -Sum).Sum; instances=$g.Count } })
$topByUsage = @($grouped | Sort-Object cpu -Descending | Select-Object -First 15)
$topNames = @($topByUsage | ForEach-Object { $_.command })
# Always keep a known DB engine's group in the snapshot even when it's idle and
# wouldn't otherwise make the top 15 — an idle-but-present engine must report its
# real near-zero number, not silently vanish from the sample (which previously
# made per-technology CPU/Memory charts fall back to the whole host's numbers
# every time the engine dropped out of a plain top-15-by-CPU cut).
$dbGroups = @($grouped | Where-Object { $lname=$_.command.ToLower(); (($dbNames | Where-Object { $lname -like "*$_*" }).Count -gt 0) -and -not ($topNames -contains $_.command) })
$procs = @($topByUsage + $dbGroups)
$ifaces = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object { [pscustomobject]@{ iface="$($_.InterfaceAlias)"; state='UP'; addresses=@("$($_.IPAddress)/$($_.PrefixLength)") } })
$neigh = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Reachable' -or $_.State -eq 'Stale' } | Select-Object -First 40 | ForEach-Object { [pscustomobject]@{ ip="$($_.IPAddress)"; mac="$($_.LinkLayerAddress)"; dev="$($_.InterfaceAlias)"; state="$($_.State)" } })
$conn = @($tcpRows | Where-Object { $_.State -eq 'ESTABLISHED' })
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ -and $_ -ne '' } | Select-Object -Unique)
$routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix } | Sort-Object RouteMetric | Select-Object -First 40 | ForEach-Object { ("{0} via {1} dev {2} metric {3}" -f $_.DestinationPrefix, $_.NextHop, $_.InterfaceAlias, $_.RouteMetric) })
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name="$($_.Name)"; desc="$($_.InterfaceDescription)"; status="$($_.Status)"; mac="$($_.MacAddress)"; speed_mbps=$(if($_.Speed){[int64]($_.Speed/1000000)}else{$null}); mtu=$_.MtuSize; index=$_.ifIndex; type="$($_.MediaType)"; driver="$($_.DriverVersion)" } })
$ifstat = @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name="$($_.Name)"; rx_bytes=[int64]$_.ReceivedBytes; tx_bytes=[int64]$_.SentBytes; rx_packets=[int64]$_.ReceivedUnicastPackets; tx_packets=[int64]$_.SentUnicastPackets; rx_dropped=[int64]$_.ReceivedDiscardedPackets; tx_dropped=[int64]$_.OutboundDiscardedPackets; rx_errors=[int64]$_.ReceivedPacketErrors; tx_errors=[int64]$_.OutboundPacketErrors } })
$cstates = @{}; $tcpRows | Group-Object { if($stateMap.ContainsKey($_.State)){$stateMap[$_.State]}else{$_.State} } | ForEach-Object { $cstates["$($_.Name)"] = $_.Count }
$udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue).Count
$wifiRaw = ""; try { $wifiRaw = (netsh wlan show interfaces 2>$null | Out-String) } catch {}
# Hardware identity — the same facts `systeminfo` reports (System Manufacturer /
# System Model / BIOS Version), via CIM instead of parsing systeminfo's text
# output. The Linux collector fills these same field names from hostnamectl;
# Windows never did, so System Information's Hardware Vendor/Model/Firmware
# rows were always blank on a Windows host.
# CPU identity and one performance-counter sample for the CPU Performance page. Additive and
# self-contained: any failure (e.g. counters disabled or non-English counter names) leaves it $null.
$cpuInfo=$null; try { $reg=Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0'; $pr=@(Get-CimInstance -ClassName Win32_Processor -Property NumberOfCores,NumberOfLogicalProcessors); $cpuInfo=[pscustomobject]@{ model=("$($reg.ProcessorNameString)").Trim(); max_mhz=$reg.'~MHz'; current_mhz=$null; sockets=$pr.Count; physical_cores=[int]($pr | Measure-Object NumberOfCores -Sum).Sum; logical=[int]($pr | Measure-Object NumberOfLogicalProcessors -Sum).Sum } } catch {}
$cpuCtr=@($allCtr | ForEach-Object { [pscustomobject]@{ path=("$($_.Path)").ToLower(); inst="$($_.InstanceName)"; v=[math]::Round($_.CookedValue,2) } })
# Memory page: page file, installed vs visible RAM, and the top 15 processes by working set (one row per PID,
# with start time so a reused PID is never mistaken for the same process). Any failure leaves the value $null.
$memInfo=$null; try { $pf=@(Get-CimInstance -ClassName Win32_PageFileUsage -Property AllocatedBaseSize,CurrentUsage,PeakUsage -ErrorAction SilentlyContinue); $inst=(Get-CimInstance -ClassName Win32_PhysicalMemory -Property Capacity -ErrorAction SilentlyContinue | Measure-Object Capacity -Sum).Sum; $memInfo=[pscustomobject]@{ pagefile_total_mb=$(if($pf.Count){[int64]($pf | Measure-Object AllocatedBaseSize -Sum).Sum}else{$null}); pagefile_used_mb=$(if($pf.Count){[int64]($pf | Measure-Object CurrentUsage -Sum).Sum}else{$null}); pagefile_peak_mb=$(if($pf.Count){[int64]($pf | Measure-Object PeakUsage -Sum).Sum}else{$null}); installed_bytes=$(if($inst){[int64]$inst}else{$null}); visible_bytes=[int64]$totalBytes } } catch {}
$memProcs=@(); try { $topMem=@($rawProcs | Sort-Object ws -Descending | Select-Object -First 15); $un=@{}; try { Get-Process -Id @($topMem | ForEach-Object { [int]$_.pid }) -IncludeUserName -ErrorAction SilentlyContinue | ForEach-Object { $un[$_.Id]=$_.UserName } } catch {}
  $memProcs=@($topMem | ForEach-Object { $po=$pobj[[int]$_.pid]; $st=$null; $pa=$null; try { $st=$po.StartTime.ToUniversalTime().ToString('o') } catch {}; try { $pa=$po.Path } catch {}; [pscustomobject]@{ pid=[int]$_.pid; name=$_.name; ws=$_.ws; private=$_.pb; peak_ws=$_.pk; cpu=$_.cpu; threads=$_.threads; user=$un[[int]$_.pid]; start=$st; path=$pa; status=$(if($po -and $po.Responding -eq $false){'Not responding'}else{'Running'}) } }) } catch {}
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$pcTypeNames = @{1="Desktop";2="Laptop";3="Workstation";4="Server";5="Server";6="Appliance";7="Server";8="Tablet"}
$chassis = $pcTypeNames[[int]$cs.PCSystemType]
$biosDate = $(if($bios.ReleaseDate){$bios.ReleaseDate.ToString('yyyy-MM-dd')}else{$null})
[pscustomobject]@{ system=[pscustomobject]@{ os=$os.Caption; kernel=[string]$os.Version; hostname=$env:COMPUTERNAME; architecture=$os.OSArchitecture; hardware_vendor=$cs.Manufacturer; hardware_model=$cs.Model; chassis=$chassis; firmware_version=$bios.SMBIOSBIOSVersion; firmware_date=$biosDate }; uptime=("up {0}d {1}h {2}m" -f $up.Days,$up.Hours,$up.Minutes); load=$null; queue_length=$queueLen; cpu_pct=$cpu; memory=[pscustomobject]@{ total_mb=$totalMB; used_mb=$usedMB; free_mb=$freeMB; available_mb=$freeMB; used_pct=$(if($totalMB){[int]($usedMB*100/$totalMB)}else{0}) }; filesystems=$disks; ports=$ports; processes=$procs; interfaces=$ifaces; neighbors=$neigh; connections=[pscustomobject]@{ count=$conn.Count; peers=@() }; gateway=$gw; dns=[pscustomobject]@{ nameservers=$dns; search=$null }; routes=$routes; adapters=$adapters; ifstat=$ifstat; conn_states=$cstates; udp_count=$udp; wifi_raw=$wifiRaw; cpu_info=$cpuInfo; cpu_counters=$cpuCtr; mem_info=$memInfo; mem_procs=$memProcs; proc_count=$rawProcs.Count; thread_count=[int]($rawProcs | Measure-Object threads -Sum).Sum; boot_time=$os.LastBootUpTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 6 -Compress
"""

# The agent and the SSH path both pass this script as powershell -EncodedCommand, and a Windows command line is
# capped at 32,767 characters (WinError 206 beyond it). UTF-16 + base64 makes that ~12,200 script characters, so
# comments, blank lines and indentation are stripped before it is served or run. PowerShell does not need them;
# the script has no here-strings or backtick continuations (test_memory_detail guards the size).
_WIN_PS = "\n".join(t for t in (ln.strip() for ln in _WIN_PS.splitlines()) if t and not t.startswith("#"))


def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


# ── CPU detail (CPU Performance page). Additive: absent sections -> cpu_detail None / no threads. ──
_STAT_FIELDS = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")


def _stat_sample(lines):
    cpus, other = {}, {}
    for ln in lines:
        p = ln.split()
        if not p:
            continue
        if p[0].startswith("cpu"):
            vals = [int(x) for x in p[1:9] if x.isdigit()]
            vals += [0] * (8 - len(vals))
            cpus[p[0]] = dict(zip(_STAT_FIELDS, vals))
        elif len(p) >= 2 and p[1].isdigit():
            other[p[0]] = int(p[1])
    return cpus, other


def _parse_cpux(raw, interval_s=0.5):
    """Two /proc/stat readings -> per-core busy %, the time split, and event rates over the interval."""
    if "--" not in raw:
        return None
    a_raw, b_raw = raw.split("--", 1)
    (ca, oa), (cb, ob) = _stat_sample(a_raw.splitlines()), _stat_sample(b_raw.splitlines())
    if "cpu" not in ca or "cpu" not in cb:
        return None

    def delta(name):
        d = {k: cb[name][k] - ca[name][k] for k in _STAT_FIELDS}
        return d, sum(d.values())

    d, tot = delta("cpu")
    if tot <= 0:
        return None

    def pct(v):
        return round(v * 100 / tot, 1)

    cores = []
    for name in sorted((n for n in cb if n != "cpu" and n in ca), key=lambda n: int(n[3:]) if n[3:].isdigit() else 0):
        dd, tt = delta(name)
        if tt > 0:
            cores.append({"id": int(name[3:]), "pct": round(100 - (dd["idle"] + dd["iowait"]) * 100 / tt, 1)})

    def rate(k):
        return round((ob[k] - oa[k]) / interval_s, 1) if k in oa and k in ob else None

    return {
        "per_core": cores,
        "user_pct": pct(d["user"] + d["nice"]), "system_pct": pct(d["system"]), "iowait_pct": pct(d["iowait"]),
        "irq_pct": pct(d["irq"] + d["softirq"]), "steal_pct": pct(d["steal"]), "idle_pct": pct(d["idle"]),
        "busy_pct": round(100 - pct(d["idle"] + d["iowait"]), 1),
        "context_switches_per_s": rate("ctxt"), "interrupts_per_s": rate("intr"),
        "runnable_tasks": ob.get("procs_running"), "sample_s": interval_s,
    }


def _parse_cpuinfo(raw):
    kv = {}
    for ln in raw.splitlines():
        k, _, v = ln.partition(":")
        if v.strip():
            kv[k.strip()] = v.strip()
    if not kv:
        return None

    def num(k):
        return float(kv[k]) if k in kv and re.match(r"^[\d.]+$", kv[k]) else None

    sockets, cps, logical = num("Socket(s)"), num("Core(s) per socket"), num("CPU(s)")
    return {
        "model": kv.get("Model name"), "max_mhz": num("CPU max MHz"), "current_mhz": num("CPU MHz"),
        "sockets": int(sockets) if sockets else None,
        "physical_cores": int(sockets * cps) if sockets and cps else None,
        "logical": int(logical) if logical else None,
    }


def _merge_proc_threads(procs, raw):
    extra = {}
    for ln in raw.splitlines():
        p = ln.split()
        if len(p) >= 3 and p[0].isdigit():
            extra[p[0]] = (int(p[1]) if p[1].isdigit() else None, int(p[2]) if p[2].isdigit() else None)
    for pr in procs:
        t = extra.get(str(pr.get("pid")))
        if t:
            pr["threads"], pr["running_s"] = t
    return procs


def _linux_cpu_detail(sec):
    stat, info = _parse_cpux(sec.get("CPUX") or ""), _parse_cpuinfo(sec.get("CPUINFO") or "")
    if not stat and not info:
        return None
    return {**(info or {}), **(stat or {})}


def _windows_cpu_detail(d):
    info, ctr = d.pop("cpu_info", None), _as_list(d.pop("cpu_counters", None))
    if not info and not ctr:
        return None
    by, cores = {}, []
    for c in ctr:
        path, inst, v = str(c.get("path") or ""), str(c.get("inst") or ""), c.get("v")
        if "% processor time" in path and inst not in ("", "_total"):
            if re.match(r"^\d+(,\d+)?$", inst):
                cores.append({"id": inst, "pct": round(float(v), 1)})
        else:
            by[path.rsplit("\\", 1)[-1]] = v
    cores.sort(key=lambda c: [int(x) for x in str(c["id"]).split(",")])
    info = info or {}
    return {
        "model": info.get("model"), "max_mhz": info.get("max_mhz"), "current_mhz": info.get("current_mhz"),
        "sockets": info.get("sockets"), "physical_cores": info.get("physical_cores"), "logical": info.get("logical"),
        "per_core": cores,
        "user_pct": by.get("% user time"), "privileged_pct": by.get("% privileged time"),
        "interrupt_pct": by.get("% interrupt time"), "dpc_pct": by.get("% dpc time"),
        "context_switches_per_s": by.get("context switches/sec"), "interrupts_per_s": by.get("interrupts/sec"),
        "dpcs_per_s": by.get("dpcs queued/sec"), "sample_s": 1,
    }


# ── Memory page (mem_detail / mem_procs) ─────────────────────────────────────────────────────────
# Byte values throughout. A metric the platform does not expose is None, never 0. Definitions:
#   used_bytes      = total - available          (both platforms; "in use" incl. modified on Windows)
#   cached_bytes    Windows: standby lists (reclaimable cache) · Linux: Buffers + Cached + SReclaimable
#   committed/limit Windows: Committed Bytes / Commit Limit · Linux: Committed_AS / CommitLimit
#   swap_*          Windows: page file (Win32_PageFileUsage) · Linux: SwapTotal / SwapFree
#   page_faults_ps  all page faults per second (soft + hard) — most are NOT disk I/O
#   major_faults_ps Windows: Pages Input/sec (hard faults read from disk) · Linux: pgmajfault/s
def _mem_pressure_score(m):
    """Calculated score, NOT an OS metric: the worse of physical scarcity (100 - available %) and commit charge
    (committed / commit limit; Linux only in strict overcommit mode). Two independent signals combined with max(),
    so nothing is counted twice. 0-100. Linux PSI (the OS-native stall metric) is stored and shown separately."""
    parts = []
    if m.get("total_bytes") and m.get("available_bytes") is not None:
        parts.append(100.0 * (1 - m["available_bytes"] / m["total_bytes"]))
    if m.get("commit_limit_bytes") and m.get("committed_bytes") is not None:
        parts.append(100.0 * m["committed_bytes"] / m["commit_limit_bytes"])
    return round(max(0.0, min(100.0, max(parts))), 1) if parts else None


def _windows_mem_detail(d):
    info, ctr, procs = d.pop("mem_info", None), _as_list(d.get("cpu_counters")), _as_list(d.pop("mem_procs", None))
    by = {}
    for c in ctr:
        path = str(c.get("path") or "")
        if "\\memory\\" in path or "paging file" in path:
            by[path.rsplit("\\", 1)[-1]] = c.get("v")
    mem = d.get("memory") or {}
    if not info and not by:
        return None, []
    info = info or {}
    total = info.get("visible_bytes") or (mem.get("total_mb") or 0) * 1048576 or None
    avail = by.get("available bytes")
    if avail is None and mem.get("available_mb") is not None:
        avail = mem["available_mb"] * 1048576
    standby = [by.get(k) for k in ("standby cache normal priority bytes", "standby cache reserve bytes", "standby cache core bytes")]
    mb = lambda k: info[k] * 1048576 if info.get(k) is not None else None  # noqa: E731
    inst = info.get("installed_bytes")
    m = {
        "platform": "windows", "total_bytes": int(total) if total else None,
        "available_bytes": int(avail) if avail is not None else None,
        "free_bytes": int(by["free & zero page list bytes"]) if by.get("free & zero page list bytes") is not None else None,
        "cached_bytes": int(sum(standby)) if all(v is not None for v in standby) else None,
        "modified_bytes": int(by["modified page list bytes"]) if by.get("modified page list bytes") is not None else None,
        "committed_bytes": int(by["committed bytes"]) if by.get("committed bytes") is not None else None,
        "commit_limit_bytes": int(by["commit limit"]) if by.get("commit limit") is not None else None,
        "paged_pool_bytes": int(by["pool paged bytes"]) if by.get("pool paged bytes") is not None else None,
        "nonpaged_pool_bytes": int(by["pool nonpaged bytes"]) if by.get("pool nonpaged bytes") is not None else None,
        "swap_total_bytes": mb("pagefile_total_mb"), "swap_used_bytes": mb("pagefile_used_mb"), "swap_peak_bytes": mb("pagefile_peak_mb"),
        "installed_bytes": int(inst) if inst else None,
        "hardware_reserved_bytes": int(inst - total) if inst and total and inst > total else (0 if inst and total else None),
        "buffers_bytes": None, "shmem_bytes": None,
        "page_faults_ps": by.get("page faults/sec"), "major_faults_ps": by.get("pages input/sec"),
        "pages_ps": by.get("pages/sec"), "swap_in_ps": None, "swap_out_ps": None,
        "psi_some_avg10": None, "psi_full_avg10": None, "sample_s": 1,
    }
    m["used_bytes"] = m["total_bytes"] - m["available_bytes"] if m["total_bytes"] and m["available_bytes"] is not None else None
    m["used_pct"] = round(100.0 * m["used_bytes"] / m["total_bytes"], 1) if m["used_bytes"] is not None else None
    m["pressure_score"] = _mem_pressure_score(m)
    out = []
    for r in procs:
        ws = r.get("ws")
        out.append({
            "pid": r.get("pid"), "name": r.get("name"), "ws_bytes": ws, "private_bytes": r.get("private"),
            "peak_ws_bytes": r.get("peak_ws"), "commit_bytes": r.get("private"),   # Windows commit charge of a process = private bytes
            "mem_pct": round(100.0 * ws / total, 2) if ws is not None and total else None,
            "cpu": r.get("cpu"), "threads": r.get("threads"), "user": r.get("user") or None, "start": r.get("start"),
            "path": r.get("path") or None, "status": r.get("status") or "Running",
        })
    return m, out


def _kv_kb(raw):
    out = {}
    for ln in raw.splitlines():
        k, _, v = ln.partition(":")
        p = v.split()
        if p and p[0].isdigit():
            out[k.strip()] = int(p[0]) * (1024 if len(p) > 1 and p[1].lower() == "kb" else 1)
    return out


def _linux_mem_detail(sec):
    parts = re.split(r"(?m)^--$", sec.get("MEMX") or "")   # line-based: an empty PSI block must not merge sections
    mi = _kv_kb(parts[0]) if parts and parts[0].strip() else {}
    if not mi.get("MemTotal"):
        return None
    psi = {}
    if len(parts) > 1:
        for ln in parts[1].splitlines():
            w = ln.split()
            if len(w) == 2 and w[0] == "overcommit" and w[1].isdigit():
                psi["overcommit"] = int(w[1])
            elif w and w[0] in ("some", "full"):
                kv = dict(x.split("=", 1) for x in w[1:] if "=" in x)
                try:
                    psi[w[0]] = float(kv.get("avg10"))
                except (TypeError, ValueError):
                    pass

    def vm(i):
        o = {}
        if len(parts) > i:
            for ln in parts[i].splitlines():
                w = ln.split()
                if len(w) == 2 and w[1].isdigit():
                    o[w[0]] = int(w[1])
        return o
    a, b = vm(2), vm(3)
    rate = lambda k: round((b[k] - a[k]) / 0.5, 1) if k in a and k in b and b[k] >= a[k] else None  # noqa: E731
    total, avail = mi["MemTotal"], mi.get("MemAvailable")
    cached = sum(mi.get(k, 0) for k in ("Buffers", "Cached", "SReclaimable"))
    m = {
        "platform": "linux", "total_bytes": total, "available_bytes": avail, "free_bytes": mi.get("MemFree"),
        "cached_bytes": cached, "buffers_bytes": mi.get("Buffers"), "shmem_bytes": mi.get("Shmem"), "modified_bytes": None,
        "committed_bytes": mi.get("Committed_AS"), "commit_limit_bytes": mi.get("CommitLimit"),
        "paged_pool_bytes": None, "nonpaged_pool_bytes": None,
        "swap_total_bytes": mi.get("SwapTotal"),
        "swap_used_bytes": mi["SwapTotal"] - mi.get("SwapFree", 0) if mi.get("SwapTotal") is not None else None,
        "swap_peak_bytes": None, "installed_bytes": None, "hardware_reserved_bytes": None,
        "page_faults_ps": rate("pgfault"), "major_faults_ps": rate("pgmajfault"), "pages_ps": None,
        "swap_in_ps": rate("pswpin"), "swap_out_ps": rate("pswpout"),
        "psi_some_avg10": psi.get("some"), "psi_full_avg10": psi.get("full"), "sample_s": 0.5,
        "overcommit_mode": psi.get("overcommit"),
    }
    m["used_bytes"] = total - avail if avail is not None else None
    m["used_pct"] = round(100.0 * m["used_bytes"] / total, 1) if m["used_bytes"] is not None else None
    # CommitLimit is only enforced in strict mode (vm.overcommit_memory=2); under the default heuristic mode
    # Committed_AS routinely exceeds it, so it is not a pressure signal there.
    m["pressure_score"] = _mem_pressure_score(m if m["overcommit_mode"] == 2 else {**m, "commit_limit_bytes": None})
    return m


def _linux_mem_procs(raw, total_bytes):
    out = []
    for ln in raw.splitlines():
        main, _, extra = ln.partition("@@")
        w = main.split()
        if len(w) < 9 or not w[0].isdigit():
            continue
        ex = extra.split()
        try:
            rss = int(w[2]) * 1024
            out.append({
                "pid": int(w[0]), "user": w[1], "ws_bytes": rss, "name": " ".join(w[8:]),
                "mem_pct": round(100.0 * rss / total_bytes, 2) if total_bytes else float(w[3]),
                "cpu": float(w[4]), "threads": int(w[5]), "running_s": int(w[6]),
                "status": {"R": "Running", "S": "Sleeping", "D": "Uninterruptible", "Z": "Zombie", "T": "Stopped", "I": "Idle"}.get(w[7][:1], w[7]),
                "peak_ws_bytes": int(ex[0]) * 1024 if len(ex) > 0 and ex[0].isdigit() else None,
                "private_bytes": int(ex[1]) * 1024 if len(ex) > 1 and ex[1].isdigit() else None,   # RssAnon: private resident memory
                "commit_bytes": None, "start": None, "path": None,
            })
        except (TypeError, ValueError):
            continue
    return out


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
    d["mem_detail"], d["mem_procs"] = _windows_mem_detail(d)   # before _windows_cpu_detail pops the counters
    d["cpu_detail"] = _windows_cpu_detail(d)
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
echo '@@DFB@@'; df -PTB1 2>/dev/null | tail -n +2
echo '@@DFI@@'; df -Pi 2>/dev/null | tail -n +2
echo '@@PORTS@@'; (ss -tlnpH 2>/dev/null || ss -tlnp 2>/dev/null | tail -n +2 || netstat -tlnp 2>/dev/null)
echo '@@PROCS@@'; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | tail -n +2 | head -15
echo '@@PROCT@@'; ps -eo pid,nlwp,etimes --sort=-pcpu 2>/dev/null | tail -n +2 | head -15
echo '@@CPUX@@'; awk '/^cpu/||/^ctxt /||/^procs_running /{print} /^intr /{print $1, $2}' /proc/stat 2>/dev/null; sleep 0.5; echo '--'; awk '/^cpu/||/^ctxt /||/^procs_running /{print} /^intr /{print $1, $2}' /proc/stat 2>/dev/null
echo '@@MEMX@@'; cat /proc/meminfo 2>/dev/null; echo '--'; cat /proc/pressure/memory 2>/dev/null; echo "overcommit $(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"; echo '--'; grep -E '^(pgfault|pgmajfault|pswpin|pswpout) ' /proc/vmstat 2>/dev/null; sleep 0.5; echo '--'; grep -E '^(pgfault|pgmajfault|pswpin|pswpout) ' /proc/vmstat 2>/dev/null
echo '@@PROCMEM@@'; ps -eo pid,user:32,rss,pmem,pcpu,nlwp,etimes,stat,comm --sort=-rss 2>/dev/null | tail -n +2 | head -15 | while read pid rest; do echo "$pid $rest @@ $(awk '/^VmHWM|^RssAnon/{printf "%s ", $2}' /proc/$pid/status 2>/dev/null)"; done
echo '@@PROCNOW@@'; T=$(getconf CLK_TCK 2>/dev/null || echo 100); A=$(awk '{s=$0; sub(/^.*\) /,"",s); n=split(s,f," "); if(n>13) print FILENAME, f[12], f[13]}' /proc/[0-9]*/stat 2>/dev/null); sleep 0.5; { echo "$A"; echo '--'; awk '{s=$0; sub(/^.*\) /,"",s); n=split(s,f," "); if(n>13) print FILENAME, f[12], f[13]}' /proc/[0-9]*/stat 2>/dev/null; } | awk -v T="$T" '$0=="--"{b=1;next} !b{u[$1]=$2; k[$1]=$3; next} ($1 in u){du=$2-u[$1]; dk=$3-k[$1]; if(du+dk>0){split($1,p,"/"); printf "%s %.1f %.1f %.1f\n", p[3], (du+dk)*100/(T*0.5), du*100/(T*0.5), dk*100/(T*0.5)}}' | sort -k2 -nr | head -15 | while read pid pc pu pk; do echo "$pid $pc $pu $pk $(ps -o ppid=,user:32=,pmem=,nlwp=,etimes=,comm= -p $pid 2>/dev/null)"; done
echo '@@BOOT@@'; awk '/^btime /{print $2}' /proc/stat 2>/dev/null; ps -e --no-headers 2>/dev/null | wc -l; awk '{print $4}' /proc/loadavg 2>/dev/null
echo '@@CPUINFO@@'; LC_ALL=C lscpu 2>/dev/null | grep -E '^(Model name|CPU\(s\)|Core\(s\) per socket|Socket\(s\)|Thread\(s\) per core|CPU MHz|CPU max MHz):'
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


def _merge_disk_bytes(rows, dfb, dfi):
    """Linux: add exact sizes (df -PTB1) and inode use (df -Pi) to the df -hP rows, matched by mount point."""
    by, ino = {}, {}
    for ln in (dfb or "").splitlines():
        p = ln.split()
        if len(p) >= 7 and p[2].isdigit():
            by[" ".join(p[6:])] = (p[1], int(p[2]), int(p[3]) if p[3].isdigit() else None, int(p[4]) if p[4].isdigit() else None)
    for ln in (dfi or "").splitlines():
        p = ln.split()
        if len(p) >= 6 and p[1].isdigit():
            ino[" ".join(p[5:])] = (int(p[1]), int(p[2]) if p[2].isdigit() else None, _to_int(p[4]) if p[4] != "-" else None)
    for r in rows:
        b = by.get(r.get("mount"))
        if b:
            r["fstype"], r["size_b"], r["used_b"], r["avail_b"] = b
        i = ino.get(r.get("mount"))
        if i and i[0]:
            r["inodes"], r["inodes_used"], r["inode_pct"] = i
    return rows


def _parse_boot(raw):
    """@@BOOT@@ → (boot_time ISO UTC, process count, thread count). /proc/stat btime is epoch seconds (UTC);
    /proc/loadavg field 4 is running/total scheduling entities (threads)."""
    import datetime as _dt
    ln = [x.strip() for x in (raw or "").splitlines() if x.strip()]
    boot = procs = threads = None
    if len(ln) > 0 and ln[0].isdigit():
        boot = _dt.datetime.fromtimestamp(int(ln[0]), _dt.timezone.utc).isoformat().replace("+00:00", "Z")
    if len(ln) > 1 and ln[1].isdigit():
        procs = int(ln[1])
    if len(ln) > 2 and "/" in ln[2] and ln[2].split("/")[1].isdigit():
        threads = int(ln[2].split("/")[1])
    return boot, procs, threads


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


def _parse_procnow(raw):
    """PROCNOW, measured over 0.5 s (100 = one core):
         new  "pid cpu user_cpu kernel_cpu ppid user mem% threads elapsed_s command"
         old  "pid cpu user mem% threads elapsed_s command"   (collector before the user/kernel split)
    A process that exited between the sample and the ps lookup has no detail columns and is dropped."""
    rows = []
    for ln in raw.splitlines():
        p = ln.split()
        if not p or not p[0].isdigit():
            continue
        try:
            new = len(p) >= 10 and _is_num(p[2]) and _is_num(p[3]) and p[4].isdigit()
            if new:
                q = ln.split(None, 9)
                r = {"pid": int(q[0]), "cpu": float(q[1]), "cpu_user": float(q[2]), "cpu_kernel": float(q[3]), "ppid": int(q[4]),
                     "user": q[5], "mem": float(q[6]), "threads": int(q[7]) if q[7].isdigit() else None,
                     "running_s": int(q[8]) if q[8].isdigit() else None, "command": q[9].strip()}
            elif len(p) >= 7:
                q = ln.split(None, 6)
                r = {"pid": int(q[0]), "cpu": float(q[1]), "user": q[2], "mem": float(q[3]),
                     "threads": int(q[4]) if q[4].isdigit() else None, "running_s": int(q[5]) if q[5].isdigit() else None,
                     "command": q[6].strip()}
            else:
                continue
        except ValueError:
            continue
        # 0.5 s at 100 ticks/s is coarse: a young single-threaded process can read just over one core.
        # One thread cannot use more than one core, so cap there rather than show an impossible value.
        if r["threads"] == 1 and r["cpu"] > 100:
            f = 100.0 / r["cpu"]
            r["cpu"] = 100.0
            for k in ("cpu_user", "cpu_kernel"):
                if k in r:
                    r[k] = round(r[k] * f, 1)
        rows.append(r)
    return rows


def _is_num(x):
    try:
        float(x)
        return True
    except ValueError:
        return False


def _share_of_host(rows, cpu_detail):
    """Per-process CPU as a share of the WHOLE host (all cores = 100%), the same scale as host CPU and Windows.
    The raw sample is "% of one core" (a process busy on 2 of 4 cores reads 200); divided by the core count it is 50."""
    n = len((cpu_detail or {}).get("per_core") or []) or (cpu_detail or {}).get("logical")
    if not n:          # core count unknown (old collector): leave the values as they came
        return rows
    for r in rows:
        if isinstance(r.get("cpu"), (int, float)):
            r["cpu"] = round(min(100.0, r["cpu"] / n), 1)
            for k in ("cpu_user", "cpu_kernel"):
                if isinstance(r.get(k), (int, float)):
                    r[k] = round(min(100.0, r[k] / n), 2)
            r["cpu_scale"] = "host"
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
    mem_detail = _linux_mem_detail(sec)
    mem_procs = _linux_mem_procs(sec.get("PROCMEM") or "", (mem_detail or {}).get("total_bytes"))
    boot_time, proc_count, thread_count = _parse_boot(sec.get("BOOT"))
    cpu_detail = _linux_cpu_detail(sec)
    return {
        "boot_time": boot_time, "proc_count": proc_count, "thread_count": thread_count,
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
        # the /proc/stat delta (all busy time, every core) is the real average; top -bn1's us+sy is only a fallback
        "cpu_pct": (cpu_detail or {}).get("busy_pct") if (cpu_detail or {}).get("busy_pct") is not None
                   else _parse_cpu(sec.get("CPU") or ""),
        "memory": _parse_mem(sec.get("MEM") or ""),
        "filesystems": _merge_disk_bytes(_parse_disk(sec.get("DISK") or ""), sec.get("DFB"), sec.get("DFI")),
        "ports": _parse_ports(sec.get("PORTS") or ""),
        "processes": _share_of_host(_merge_proc_threads(_parse_procs(sec.get("PROCS") or ""), sec.get("PROCT") or ""), cpu_detail),
        "procs_now": _share_of_host(_parse_procnow(sec.get("PROCNOW") or ""), cpu_detail),
        "cpu_detail": cpu_detail,
        "mem_detail": mem_detail,
        "mem_procs": _share_of_host(mem_procs or [], cpu_detail),
        "interfaces": _parse_net(sec.get("NET") or ""),
        "connections": _parse_conn(sec.get("CONN") or ""),
        "neighbors": _parse_neigh(sec.get("NEIGH") or ""),
        "network": _build_network(sec, _parse_net(sec.get("NET") or ""),
                                  _parse_neigh(sec.get("NEIGH") or ""),
                                  _parse_conn(sec.get("CONN") or "")),
    }


def _apply_network_rates(parsed: dict, prev_json, prev_at, now_at=None):
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
    # prev_at is stamped with the DATABASE clock (func.now(), session-local and naive), so the elapsed time must
    # come from that same clock — datetime.utcnow() on an IST server made dt ≈ −5.5 h and every rate was skipped.
    dt = ((now_at or datetime.utcnow()) - prev_at).total_seconds()
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
    from sqlalchemy import func, text
    from app.models.agent_model import Agent, AgentMetric, AgentToken

    server = db.query(OsServer).filter(
        credential_encryption.token_match_filter(OsServer.agent_token_hash, OsServer.agent_token, payload.token)
    ).first()
    tok = None
    if not server:
        # Token must be a known deploy token (per-deployment OR the universal MSI token).
        tok = db.query(AgentToken).filter(
            credential_encryption.token_match_filter(AgentToken.token_hash, AgentToken.token, payload.token)
        ).first()
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
            # Only take over the hostname match if its CURRENT binding looks
            # abandoned (never reported, or gone quiet for a while) — not if it's
            # actively reporting. A second wizard run on the SAME machine (e.g.
            # "Add Database" → Oracle, minting its own fresh token, run on a host
            # that already has a live MySQL-integration agent) used to silently
            # steal that live host's identity: this OsServer row's agent_token
            # got overwritten mid-stream, orphaning every AgentDbTarget still
            # keyed to the old token — confirmed live (a MySQL connection's
            # queries stopped resolving to this host the moment Oracle's
            # installer ran here). Genuine reinstalls (the old agent really is
            # gone) still take over normally once it's been quiet this long.
            abandoned = db.execute(
                text("SELECT :at IS NULL OR :at < now() - interval '3 minutes'"),
                {"at": server.last_infra_at},
            ).scalar()
            if abandoned:
                server.agent_token = payload.token
            elif server.agent_token != payload.token:
                return {
                    "status": "error",
                    "message": (
                        f"Host '{hn}' already has an active agent (a different token is "
                        "reporting from it right now). Attach this database to that existing "
                        "agent instead of deploying a new one — see the Agents page."
                    ),
                }
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

    try:
        db_now = db.execute(text("SELECT LOCALTIMESTAMP")).scalar()
    except Exception:  # noqa: BLE001
        db_now = None
    _apply_network_rates(parsed, server.last_infra_json, server.last_infra_at, db_now)
    server.last_infra_json = json.dumps(parsed)
    live = _live_cols_from_snapshot(parsed)
    server.cpu_usage = live["cpu_usage"] or server.cpu_usage
    server.ram_usage = live["ram_usage"] or server.ram_usage
    server.disk_usage = live["disk_usage"] or server.disk_usage
    server.uptime = live["uptime"] or server.uptime
    server.status = "Connected"
    server.last_infra_at = func.now()   # DB clock — matches the reaper's now() (avoids tz drift)
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
        credential_encryption.token_match_filter(AgentDbTarget.token_hash, AgentDbTarget.token, payload.token),
        AgentDbTarget.enabled.is_(True)).all()
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
        if t.connection_id:
            # Same fix as agent_install_service.svc_save_db_target: without this,
            # the collector never starts a per-connection thread for this database,
            # and database_instances.status is set once here and never updated again.
            from app.services.agent.agent_install_service import _ensure_connection_agent
            _ensure_connection_agent(t.connection_id, t.connection_name, t.host, t.environment, t.db_type, db)

    # Mirror to the Agents page (Agent row + latest metric) so both surfaces agree.
    agent_name = server.server_name
    agent = db.query(Agent).filter(Agent.agent_name == agent_name).first()
    if not agent:
        agent = Agent(agent_name=agent_name, db_type="Host", hostname=server.hostname,
                      ip_address=server.ip_address, os_type=server.os_type,
                      environment=server.environment, description="Host agent (Infrastructure)")
        db.add(agent)
    agent.status = "online"
    agent.last_heartbeat = func.now()   # DB clock — MUST match the reaper's now() (avoids tz drift → flapping)
    cpu = parsed.get("cpu_pct") or 0.0
    mem = (parsed.get("memory") or {}).get("used_pct") or 0.0
    # Same "worst filesystem" figure _live_cols_from_snapshot already derives for
    # OsServer.disk_usage — recomputed here as a raw float (that one returns a
    # formatted "NN%" string) so it can go straight into a Float column.
    disk = max((f.get("use_pct", 0) for f in (parsed.get("filesystems") or [])), default=0.0)
    # Explicit kind/tech so this row is never mistaken for one of this agent's
    # own DB-engine pushes (see metrics_pipeline.py's after_insert hook) —
    # this IS the host reading, unambiguously, every time.
    db.add(AgentMetric(agent_name=agent_name, host_cpu=float(cpu), host_memory=float(mem), host_disk=float(disk),
                       kind="infra", tech="host", conn_id=0))

    db.commit()
    # Memory history (ClickHouse). The snapshot above is already committed, so the push itself succeeded; a failed
    # history write is reported in its own field — never hidden behind the snapshot's success.
    try:
        from app.services.clickhouse import memory_history_service as mh
        mem_hist = mh.write_snapshot(server.id, agent_name, parsed)
    except Exception as e:  # noqa: BLE001
        print(f"[infra] memory history write failed for {agent_name}: {type(e).__name__}")
        mem_hist = "error"
    try:
        disk_hist = mh.write_filesystems(server.id, parsed)
    except Exception as e:  # noqa: BLE001
        print(f"[infra] filesystem history write failed for {agent_name}: {type(e).__name__}")
        disk_hist = "error"
    try:
        mh.write_network(server.id, parsed)
    except Exception as e:  # noqa: BLE001
        print(f"[infra] network history write failed for {agent_name}: {type(e).__name__}")
    try:
        from app.services.clickhouse import cpu_history_service as ch
        ch.write_cpu(server.id, parsed)
    except Exception as e:  # noqa: BLE001
        print(f"[infra] cpu history write failed for {agent_name}: {type(e).__name__}")
    return {"status": "success", "server_id": server.id, "agent_name": agent_name, "memory_history": mem_hist, "disk_history": disk_hist}


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
