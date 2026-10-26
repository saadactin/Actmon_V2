"""
Memory recommendation rules — a fixed, documented catalogue.

Every rule:
  * fires only on MEASURED values from the selected range (ClickHouse host_memory_metrics / host_process_memory);
  * has a stable ID (MEM-xxx), a category, and thresholds taken from the usual operating-system / vendor guidance
    (cited in `standard`);
  * returns the evidence it fired on, why it matters, ordered next steps, and the read-only commands an administrator
    would run to confirm it on Linux or Windows.

Nothing here changes the host. Severity order: Critical > High > Warning > Info. When no problem rule fires, a single
"healthy" finding states the measured headroom instead of an empty page.
"""

SEV_ORDER = {"Critical": 0, "High": 1, "Warning": 2, "Info": 3}

# Database / application engines recognised by process name → engine-specific memory guidance
ENGINES = [
    ("oracle", ("ora_", "oracle", "tnslsnr", "ocssd", "crsd", "asm_"), "Oracle Database"),
    ("mssql", ("sqlservr",), "SQL Server"),
    ("mysql", ("mysqld", "mariadbd"), "MySQL / MariaDB"),
    ("postgres", ("postgres", "postmaster"), "PostgreSQL"),
    ("mongodb", ("mongod",), "MongoDB"),
    ("clickhouse", ("clickhouse",), "ClickHouse"),
    ("java", ("java",), "Java (JVM)"),
]
ENGINE_ADVICE = {
    "oracle": ("Check SGA_TARGET / SGA_MAX_SIZE and PGA_AGGREGATE_LIMIT against this host's RAM (V$SGA_TARGET_ADVICE, "
               "V$PGA_TARGET_ADVICE). On Linux, back the SGA with HugePages (Oracle recommends it for SGA > 8 GB) so it is "
               "not paged and page-table overhead stays small.",
               ["SELECT name, ROUND(bytes/1024/1024/1024,2) gb FROM v$sgainfo WHERE name IN ('Maximum SGA Size','Free SGA Memory Available');",
                "SELECT ROUND(value/1024/1024/1024,2) pga_gb FROM v$pgastat WHERE name = 'total PGA allocated';",
                "grep -i huge /proc/meminfo"]),
    "mssql": ("Set 'max server memory' so the OS keeps headroom (Microsoft: leave roughly 10–20% of RAM, at least 4 GB, "
              "to Windows and other processes).",
              ["SELECT name, value_in_use FROM sys.configurations WHERE name LIKE 'max server memory%';",
               "SELECT physical_memory_in_use_kb/1024 AS used_mb FROM sys.dm_os_process_memory;"]),
    "mysql": ("Size innodb_buffer_pool_size to the working set — commonly 50–75% of RAM on a dedicated server — and "
              "account for per-connection buffers × max_connections.",
              ["SHOW VARIABLES LIKE 'innodb_buffer_pool_size';", "SHOW GLOBAL STATUS LIKE 'Max_used_connections';"]),
    "postgres": ("PostgreSQL guidance: shared_buffers ≈ 25% of RAM; total work_mem × active sorts and maintenance_work_mem "
                 "must still fit; the OS page cache does the rest.",
                 ["SHOW shared_buffers;", "SHOW work_mem;", "SHOW max_connections;"]),
    "mongodb": ("WiredTiger's cache defaults to 50% of (RAM − 1 GB); cap it with storage.wiredTiger.engineConfig.cacheSizeGB "
                "if other services share this host.",
                ["db.serverStatus().wiredTiger.cache['maximum bytes configured']", "db.serverStatus().mem"]),
    "clickhouse": ("Check max_server_memory_usage_to_ram_ratio (default 0.9) and per-query max_memory_usage; large merges "
                   "and joins are the usual peaks.",
                   ["SELECT metric, value FROM system.asynchronous_metrics WHERE metric LIKE 'Memory%';"]),
    "java": ("Compare the JVM heap (-Xmx) and metaspace with what the host can spare; a heap close to RAM leaves no room "
             "for the OS cache.", ["jcmd <pid> GC.heap_info", "ps -o pid,rss,args -C java"]),
}


def _gb(b):
    return f"{b / 1073741824:.1f} GB" if b is not None else "N/A"


def _pct(x):
    return f"{x:.0f}%" if x is not None else "N/A"


def _engine(name):
    n = (name or "").lower()
    for key, prefixes, label in ENGINES:
        if any(n.startswith(p) or p in n for p in prefixes):
            return key, label
    return None, None


def _cmds(platform, linux, windows):
    return {"platform": platform, "commands": windows if platform == "windows" else linux}


def evaluate(a, minutes):
    cur = (a.get("stats") or {}).get("current")
    prev = (a.get("stats") or {}).get("previous")
    if not cur:
        return []
    plat = (cur.get("platform") or "linux").lower()
    win = plat == "windows"
    rng = {"from_t": cur.get("first_t"), "to_t": cur.get("last_t")}
    total = cur.get("total")
    out = []

    def add(rule, category, severity, condition, evidence, reason, standard, actions, linux=(), windows=(), **extra):
        out.append({"id": rule.lower(), "rule": rule, "category": category, "severity": severity, "condition": condition,
                    "evidence": evidence, "reason": reason, "standard": standard, "actions": list(actions),
                    "action": actions[0] if actions else "", **_cmds(plat, list(linux), list(windows)), **rng, **extra})

    avail_min, avail_avg = cur.get("avail_min"), cur.get("avail_avg")
    avail_min_pct = 100 * avail_min / total if total and avail_min is not None else None
    avail_avg_pct = 100 * avail_avg / total if total and avail_avg is not None else None
    cached_pct = 100 * cur["cached_avg"] / total if total and cur.get("cached_avg") is not None else None
    top_cons = (a.get("consumers") or [])[:5]
    top_txt = ", ".join(f"{c['name']} {c['mem_pct_avg']:.0f}%" for c in top_cons if c.get("mem_pct_avg") is not None) or "N/A"
    procs_sum = sum(c.get("mem_pct_avg") or 0 for c in (a.get("consumers") or []))
    engines = {k for k, _ in (_engine(c["name"]) for c in (a.get("consumers") or [])) if k}
    # Memory the process list cannot explain: shared memory (Oracle SGA / HugePages, PostgreSQL shared_buffers),
    # kernel slab, tmpfs. When it dominates, per-process figures are the wrong place to look.
    unattributed = (cur.get("used_avg") - procs_sum) if cur.get("used_avg") is not None and a.get("consumers") else None
    if unattributed is not None and unattributed >= 40:
        top_txt += f" — together only {procs_sum:.0f}% of RAM; the remaining ~{unattributed:.0f}% is not held by any single process (see MEM-013)"

    # MEM-001  Available memory (Linux MemAvailable / Windows Available MBytes)
    if avail_min_pct is not None and avail_min_pct < 10:
        crit = avail_min_pct < 5
        add("MEM-001", "Capacity", "Critical" if crit else "High", "Low available memory",
            f"Available memory fell to {_gb(avail_min)} ({avail_min_pct:.1f}% of {_gb(total)}); average {_pct(avail_avg_pct)} over the range.",
            "Below about 10% available the kernel starts reclaiming cache and active pages; below 5% it swaps or the OOM killer / "
            "Windows memory manager steps in, and every process slows down.",
            "Linux MemAvailable and Windows 'Memory\\Available MBytes': warning < 10% of RAM, critical < 5% (Microsoft performance "
            "guidance; Red Hat 'MemAvailable' documentation).",
            ["Open the Process Analysis tab at the lowest point and identify what grew.",
             "If the largest consumer is a database or JVM, check its configured memory limit against this host (see below).",
             "If demand is legitimate and sustained, add RAM or move a workload; do not rely on swap to cover it."],
            linux=["free -h", "grep -E 'MemTotal|MemAvailable|Cached|Committed_AS' /proc/meminfo", "ps -eo pid,user,rss,comm --sort=-rss | head -15"],
            windows=["Get-Counter '\\Memory\\Available MBytes','\\Memory\\Committed Bytes'", "Get-Process | Sort-Object WS -Descending | Select-Object -First 15 Name,Id,@{n='WS_MB';e={[int]($_.WS/1MB)}}"])

    # MEM-002  Sustained pressure (ActMon pressure score)
    secs = (a.get("above_threshold") or {}).get("seconds") or 0
    span = max(1, ((cur.get("last_t") or 0) - (cur.get("first_t") or 0)) // 1000)
    if secs and secs / span >= 0.25:
        share = secs / span
        add("MEM-002", "Pressure", "High" if share >= 0.5 else "Warning", "Sustained memory pressure",
            f"Pressure score ≥ {a['threshold']:g}% for {secs // 60} min ({100 * share:.0f}% of the range); peak {cur.get('pr_max')}%, average {cur.get('pr_avg')}%. "
            f"Largest consumers: {top_txt}.",
            "Pressure stayed above the High threshold for a large share of the range, so this is the host's normal load, not a spike.",
            "Capacity planning practice: sustained (> 25% of the time) operation above the High band means the host is undersized "
            "for its workload.",
            ["Confirm the largest consumers (listed above) are sized as intended.",
             "Compare with the previous period — growth means a capacity plan is needed, a flat line means the host was always tight.",
             "Plan RAM or rebalance workloads before the next peak; set an alert at the High band to catch it early."],
            linux=["vmstat 5 5", "cat /proc/pressure/memory", "sar -r 1 5"],
            windows=["Get-Counter '\\Memory\\% Committed Bytes In Use','\\Memory\\Pages/sec' -SampleInterval 5 -MaxSamples 5"])

    # MEM-003  Linux PSI stall time
    if not win and cur.get("psi_some_max") is not None:
        full, some = cur.get("psi_full_max") or 0, cur.get("psi_some_avg") or 0
        if full >= 5 or some >= 10:
            add("MEM-003", "Pressure", "Critical" if full >= 10 else "High", "Processes stalled waiting for memory",
                f"PSI memory: 'some' averaged {some:.1f}% (peak {cur.get('psi_some_max'):.1f}%), 'full' peaked at {full:.1f}%.",
                "PSI measures time tasks were actually stalled on memory. 'full' means ALL runnable tasks were stalled at once — "
                "real lost throughput, not just high usage.",
                "Linux kernel PSI (Documentation/accounting/psi.rst); oomd / systemd-oomd practice treats sustained 'some' > 10% "
                "or 'full' > 5% as memory pressure.",
                ["Treat this as lost throughput: correlate the stall times with application latency.",
                 "Reduce the working set of the largest consumer or add RAM.",
                 "Check that swap is on fast storage; stalls rise sharply when swap-in reads from slow disks."],
                linux=["cat /proc/pressure/memory", "vmstat 1 10", "ps -eo pid,user,rss,majflt,comm --sort=-majflt | head"])

    # MEM-004  Active swapping (swap-in hurts; swap-out alone is housekeeping)
    swin = cur.get("swapin_avg")
    if not win and swin is not None and swin >= 10:
        add("MEM-004", "Paging", "High" if swin >= 100 else "Warning", "Active swap-in",
            f"Pages swapped in averaged {swin:.0f}/s (peak {cur.get('swapin_max') or 0:.0f}/s); swapped out {cur.get('swapout_avg') or 0:.0f}/s.",
            "Swap-in means processes are waiting for pages read back from disk. Occasional swap-out of idle pages is normal; "
            "continuous swap-in is not.",
            "Linux vmstat 'si' — sustained non-zero si indicates RAM shortage (Red Hat performance tuning guide).",
            ["Find the process with the most major faults (command below).",
             "If it is a database, make sure its cache is not larger than RAM can hold and that HugePages are used (Oracle).",
             "Add RAM or reduce the workload; lowering vm.swappiness only hides the shortage."],
            linux=["vmstat 5 5", "ps -eo pid,user,majflt,rss,comm --sort=-majflt | head", "sysctl vm.swappiness"])

    # MEM-005  Hard paging (Windows Pages/sec, Linux major faults)
    if win and (cur.get("pages_avg") or 0) >= 1000:
        add("MEM-005", "Paging", "High" if cur["pages_avg"] >= 2500 else "Warning", "Heavy hard paging",
            f"Memory\\Pages/sec averaged {cur['pages_avg']:.0f}/s (peak {cur.get('pages_max') or 0:.0f}/s).",
            "Pages/sec counts pages read from or written to disk to resolve hard faults; sustained high values mean memory is "
            "being paged back in.",
            "Microsoft performance guidance: Pages/sec sustained above ~1000 with low Available MBytes indicates memory shortage.",
            ["Check Available MBytes at the same time — paging with plenty available is file I/O, not a shortage.",
             "Identify the process with the most page faults and its working-set growth.",
             "Add RAM or reduce the working set if both are high."],
            windows=["Get-Counter '\\Memory\\Pages/sec','\\Memory\\Available MBytes' -SampleInterval 5 -MaxSamples 6",
                     "Get-Process | Sort-Object PageFaults -Descending | Select-Object -First 10 Name,Id,PageFaults"])
    elif not win and (cur.get("major_avg") or 0) >= 100:
        add("MEM-005", "Paging", "Warning", "Repeated major page faults",
            f"Major faults averaged {cur['major_avg']:.0f}/s, peak {cur.get('major_max') or 0:.0f}/s.",
            "Major faults read pages from disk (swap or files not in cache); sustained high rates add latency to every miss.",
            "Linux /proc/vmstat pgmajfault — sustained rates in the hundreds per second indicate cache or RAM shortage.",
            ["Identify the process with the most major faults.", "Correlate with disk latency; if both are high, reduce the working set or add RAM."],
            linux=["ps -eo pid,user,majflt,comm --sort=-majflt | head", "iostat -x 5 3"])

    # MEM-006  Swap / page file occupancy
    sw_t, sw_u = cur.get("swap_total"), cur.get("swap_used_max")
    if sw_t and sw_u is not None and sw_u / sw_t >= 0.5:
        r = sw_u / sw_t
        add("MEM-006", "Paging", "High" if r >= 0.8 else "Warning", "High swap / page-file usage",
            f"Peak {_gb(sw_u)} of {_gb(sw_t)} ({100 * r:.0f}%).",
            "Full swap leaves no buffer for the next spike: the next allocation fails or the OOM killer runs.",
            "Common practice: swap more than 50% used is a warning, more than 80% critical — check together with swap-in rate.",
            ["Check MEM-004 / paging activity: occupied swap with no swap-in is old idle pages and is harmless.",
             "If swap-in is also high, the host is short of RAM (see MEM-001).",
             "Restarting a leaking service frees its swap; do it in a maintenance window."],
            linux=["swapon --show", "grep -E 'SwapTotal|SwapFree' /proc/meminfo", "for f in /proc/[0-9]*/status; do awk '/^Name|^VmSwap/{printf $2\" \"}END{print \"\"}' $f; done | sort -k2 -n | tail"],
            windows=["Get-CimInstance Win32_PageFileUsage | Select-Object Name,AllocatedBaseSize,CurrentUsage,PeakUsage"])

    # MEM-007  Commit charge near the limit (Windows always; Linux only matters with strict overcommit)
    cm, cl = cur.get("commit_max"), cur.get("commit_limit")
    if cm and cl and cm / cl >= 0.9:
        r = cm / cl
        sev7 = ("Critical" if r >= 0.98 else "High") if win else "Warning"
        add("MEM-007", "Capacity", sev7, "Commit charge near the limit" + ("" if win else " (enforced only with vm.overcommit_memory=2)"),
            f"Committed memory peaked at {_gb(cm)} of a {_gb(cl)} limit ({100 * r:.0f}%).",
            "When commit reaches the limit, new allocations fail (Windows: 'out of virtual memory'; Linux with "
            "vm.overcommit_memory=2: ENOMEM) even if some RAM is free.",
            "Windows: Committed Bytes / Commit Limit > 90% (Microsoft). Linux: Committed_AS vs CommitLimit, relevant under "
            "strict overcommit (kernel overcommit-accounting documentation).",
            ["Find the processes with the largest commit / private bytes.",
             "Increase the page file (Windows) or swap, or add RAM; on Linux review vm.overcommit_memory and vm.overcommit_ratio."],
            linux=["grep -E 'CommitLimit|Committed_AS' /proc/meminfo", "sysctl vm.overcommit_memory vm.overcommit_ratio"],
            windows=["Get-Counter '\\Memory\\Committed Bytes','\\Memory\\Commit Limit'",
                     "Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 10 Name,Id,@{n='Private_MB';e={[int]($_.PrivateMemorySize64/1MB)}}"])

    # MEM-008  Growth versus the previous period
    if prev and cur.get("used_avg") is not None and prev.get("used_avg") is not None:
        d = cur["used_avg"] - prev["used_avg"]
        if d >= 10:
            add("MEM-008", "Trend", "Warning", "Memory use growing",
                f"Average utilisation rose from {prev['used_avg']:.0f}% to {cur['used_avg']:.0f}% (+{d:.0f} points) compared with the previous equal period.",
                "A step up between two equal periods points to new workload, a configuration change or a leak.",
                "Capacity trending: a sustained rise of 10+ points between comparable periods should be explained before it becomes a shortage.",
                ["Check the Memory Leaks / Per-Process tabs for the process that grew.",
                 "Compare with recent deployments, configuration changes or batch jobs.",
                 "Widen the range (24 h / 7 d) to see whether it is a trend or a one-off."])

    # MEM-009  Single dominant consumer, with engine-specific guidance
    if top_cons and top_cons[0].get("mem_pct_avg") is not None and top_cons[0]["mem_pct_avg"] >= 30:
        c = top_cons[0]
        key, label = _engine(c["name"])
        engine_actions, engine_cmds = ENGINE_ADVICE.get(key, (None, []))
        add("MEM-009", "Workload", "Info" if (avail_min_pct or 100) >= 10 else "Warning",
            f"{c['name']} holds {c['mem_pct_avg']:.0f}% of RAM" + (f" ({label})" if label else ""),
            f"{c['name']} averaged {c['mem_pct_avg']:.1f}% of physical memory (peak working set {_gb(c.get('ws_max'))}"
            f"{', ' + str(c['instances']) + ' processes' if (c.get('instances') or 0) > 1 else ''}). Next: {top_txt}.",
            "One process this large decides how much is left for the OS cache and everything else; it should be a deliberate, "
            "configured size.",
            "Vendor sizing guidance for the detected engine." if label else "General practice: a dominant process should have an explicit memory limit.",
            [engine_actions or "Confirm its configured memory limit matches what this host can spare.",
             "Keep at least 10% of RAM free for the OS and file cache after its limit is reached."],
            linux=engine_cmds or ["ps -o pid,user,rss,vsz,args -p $(pgrep -d, -f '%s')" % c["name"][:20]],
            windows=engine_cmds or [f"Get-Process -Name '{c['name']}' | Select-Object Id,WS,PrivateMemorySize64"],
            engine=label)

    # MEM-013  Memory held outside individual processes (shared memory / SGA / kernel)
    if unattributed is not None and unattributed >= 40 and (cur.get("used_avg") or 0) >= 60:
        ora = "oracle" in engines
        add("MEM-013", "Workload", "Info" if (avail_min_pct or 100) >= 10 else "Warning",
            "Most memory is shared memory, not process memory" + (" (Oracle SGA)" if ora else ""),
            f"Average utilisation {cur['used_avg']:.0f}%, but the busiest processes together hold only {procs_sum:.0f}% of RAM "
            f"(each {top_cons[0]['mem_pct_avg']:.1f}% or less); about {unattributed:.0f}% of RAM is outside any single process.",
            ("On an Oracle server this is normally the SGA: it lives in shared memory (or HugePages), is mapped by every Oracle "
             "process and is not counted in any one of them. Sizing it is how memory is controlled here.") if ora else
            "Shared memory segments, tmpfs and kernel slab are not attributed to a single process, so per-process lists understate use.",
            ("Oracle: SGA in shared memory / HugePages (Oracle Database Administrator's Reference for Linux — HugePages "
             "recommended for SGA > 8 GB).") if ora else "Linux /proc/meminfo Shmem, Slab and HugePages accounting.",
            (["Check SGA size and HugePages allocation (commands below); SGA_TARGET + PGA_AGGREGATE_LIMIT should leave at least 10% of RAM to the OS.",
              "If HugePages_Total is 0 and the SGA is larger than 8 GB, configure HugePages (vm.nr_hugepages) and use_large_pages=ONLY.",
              "If the SGA is right-sized and pressure persists, add RAM rather than shrinking the SGA below its advised size (V$SGA_TARGET_ADVICE)."]
             if ora else
             ["Check shared memory and slab (commands below) to see what holds the memory.",
              "Look for large tmpfs mounts (/dev/shm) and IPC segments left behind by stopped applications."]),
            linux=(["grep -E 'Shmem|HugePages_|Hugepagesize|Slab' /proc/meminfo", "ipcs -m | sort -k5 -n | tail",
                    "SELECT name, ROUND(bytes/1024/1024/1024,2) gb FROM v$sgainfo;", "SELECT * FROM v$sga_target_advice ORDER BY sga_size;"]
                   if ora else ["grep -E 'Shmem|Slab|SReclaimable' /proc/meminfo", "ipcs -m", "df -h /dev/shm"]),
            windows=[r"Get-Counter '\Memory\Pool Nonpaged Bytes','\Memory\Pool Paged Bytes','\Memory\System Cache Resident Bytes'"],
            engine="Oracle Database" if ora else None)

    # MEM-010  Suspected leaks
    for lk in (a.get("leaks") or [])[:3]:
        add("MEM-010", "Workload", "Warning", f"Suspected memory leak: {lk['name']} (PID {lk['pid']})",
            f"{lk['basis'].capitalize()} memory grew {lk['growth_pct']}% (+{_gb(lk['growth_bytes'])}, about {_gb(lk.get('rate_bytes_per_h'))}/h) "
            f"steadily (r = {lk['r']:.2f}) over {lk['n']} samples.",
            "Steady linear growth of one process instance is the leak pattern. It is a heuristic: caches also grow until full.",
            "Leak heuristic: correlation with time ≥ 0.9, growth ≥ 20% and ≥ 100 MB over at least half the range.",
            ["Watch a longer range: a cache plateaus, a leak does not.",
             "Check the application's own memory diagnostics (heap dump, v$process for Oracle, DMVs for SQL Server).",
             "If it keeps growing, schedule a restart in a maintenance window and raise it with the vendor."],
            linux=[f"grep -E 'VmRSS|VmData|VmSwap' /proc/{lk['pid']}/status", f"pmap -x {lk['pid']} | tail -3"],
            windows=[f"Get-Process -Id {lk['pid']} | Select-Object Name,WS,PrivateMemorySize64,HandleCount"],
            from_t=lk.get("first_t"), to_t=lk.get("last_t"))

    # MEM-011  Repeated threshold events
    crit = [e for e in a.get("events") or [] if e["level"] in ("Critical", "High")]
    if len(crit) >= 3:
        add("MEM-011", "Pressure", "Warning", "Repeated High/Critical pressure events",
            f"{len(crit)} High/Critical pressure events in the range.",
            "Repeated crossings follow a schedule more often than not — jobs, backups, reports.",
            "Event correlation practice: three or more crossings in one range indicate a recurring pattern.",
            ["List the event times (Memory Pressure tab) and compare with cron / Task Scheduler / database jobs.",
             "Stagger the jobs that overlap, or size the host for the combined peak."],
            linux=["crontab -l; ls /etc/cron.d"], windows=["Get-ScheduledTask | Where-Object State -ne 'Disabled' | Select-Object TaskName,TaskPath"])

    # MEM-012  High "used" that is really file cache — a common false alarm
    if not out and cur.get("used_max") is not None and cur["used_max"] >= 85 and (avail_min_pct or 0) >= 15 and (cached_pct or 0) >= 20:
        add("MEM-012", "Capacity", "Info", "High utilisation is mostly reclaimable cache",
            f"Utilisation peaked at {cur['used_max']:.0f}%, but available memory never fell below {avail_min_pct:.0f}%; file cache averaged {cached_pct:.0f}% of RAM.",
            "The OS keeps free RAM busy as file cache and gives it back on demand. Available memory, not 'used', is what matters.",
            "Linux 'MemAvailable' semantics / Windows Standby list: cache is counted as available.",
            ["No action needed. Alert on available memory (MEM-001) rather than on utilisation."])

    # MEM-000  Healthy — say so, with the measured headroom
    if not [r for r in out if SEV_ORDER[r["severity"]] <= 2 or r["rule"] == "MEM-012"]:
        add("MEM-000", "Capacity", "Info", "Memory is healthy for this range",
            f"Peak utilisation {_pct(cur.get('used_max'))}, minimum available {_gb(avail_min)} ({_pct(avail_min_pct)} of RAM), "
            f"peak pressure {cur.get('pr_max')}%" + ("" if win else f", swap-in {cur.get('swapin_avg') or 0:.0f}/s") + ".",
            "No capacity, pressure, paging, commit, growth or leak rule fired.",
            "All MEM-001 … MEM-011 thresholds were checked against the measured values.",
            ["Keep alerting on available memory below 10% and on sustained pressure.",
             "Review again after workload or configuration changes."])

    out.sort(key=lambda r: (SEV_ORDER[r["severity"]], r["rule"]))
    return out


# The catalogue itself, so the UI can show what is checked and at which thresholds.
CATALOGUE = [
    ("MEM-001", "Low available memory", "available < 10% of RAM (High), < 5% (Critical)"),
    ("MEM-002", "Sustained memory pressure", "pressure ≥ High band for ≥ 25% of the range"),
    ("MEM-003", "Processes stalled on memory (Linux PSI)", "some avg ≥ 10% or full peak ≥ 5%"),
    ("MEM-004", "Active swap-in (Linux)", "swap-in ≥ 10 pages/s (≥ 100 High)"),
    ("MEM-005", "Hard paging", "Windows Pages/sec ≥ 1000; Linux major faults ≥ 100/s"),
    ("MEM-006", "Swap / page-file usage", "≥ 50% used (≥ 80% High)"),
    ("MEM-007", "Commit charge near limit", "committed ≥ 90% of the commit limit"),
    ("MEM-008", "Memory use growing", "average +10 points vs the previous period"),
    ("MEM-009", "Dominant consumer", "one process ≥ 30% of RAM (engine-specific advice)"),
    ("MEM-010", "Suspected leak", "steady growth r ≥ 0.9, +20% and +100 MB"),
    ("MEM-011", "Repeated pressure events", "≥ 3 High/Critical events"),
    ("MEM-012", "Utilisation is mostly cache", "used ≥ 85% but available ≥ 15%, cache ≥ 20%"),
    ("MEM-013", "Memory outside individual processes", "used − busiest processes ≥ 40 points (shared memory / SGA)"),
]
