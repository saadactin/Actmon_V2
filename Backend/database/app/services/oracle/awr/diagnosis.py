"""Single-report diagnosis: rule checks over the measured metrics of one AWR.

Every finding carries the measurements it rests on (observed_metrics), where in
the report they came from (evidence_refs), plausible causes, and actions with a
validation query and a rollback note. Thresholds are common DBA review
heuristics, not Oracle limits — each finding states the rule it applied
(confidence_method), so nobody mistakes a heuristic for a guarantee.

These are diagnoses of the snapshot window only. Anything about change over
time lives in history.py and needs several reports.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .metrics import Extraction
from .parser import ProductionAWRParser
from .schema import AWRReport

RULES_VERSION = "awr-rules-2"


@dataclass
class Finding:
    rule_id: str
    severity: str  # HIGH|MEDIUM|LOW|INFO
    category: str
    title: str
    evidence: str
    observed: dict
    refs: list
    causes: list
    actions: list
    rule: str
    finding_type: str = "diagnosis"
    extra: dict = field(default_factory=dict)

    @property
    def recommendation(self) -> str:
        return self.actions[0]["action"] if self.actions else ""

    @property
    def risk_level(self) -> str:
        return {"HIGH": "high", "MEDIUM": "medium", "LOW": "low"}.get(self.severity, "none")


def _obs(ex: Extraction, *keys) -> dict:
    out = {}
    for k in keys:
        m = next((m for m in ex.metrics if m.key == k), None)
        if m:
            out[k] = {"value": round(m.value, 3), "unit": m.unit, "label": m.label, "source": m.source}
    return out


def _refs(ex: Extraction, *keys) -> list:
    return [{"section": v["source"], "metric_key": k} for k, v in _obs(ex, *keys).items()]


def _band(value, medium, high):
    if value is None:
        return None
    return "HIGH" if value >= high else "MEDIUM" if value >= medium else None


def _segments(tables: dict, prefix: str, limit: int = 3) -> list[dict]:
    rows = next((r for s, r in tables.items() if s.startswith(prefix)), None)
    if not rows or len(rows) < 2:
        return []
    head = [h.lower() for h in rows[0]]
    def col(name):
        return next((i for i, h in enumerate(head) if h.startswith(name)), None)
    owner, obj, otype = col("owner"), col("object name"), col("obj. type")
    out = []
    for r in rows[1:limit + 1]:
        if obj is not None and obj < len(r):
            out.append({"owner": r[owner] if owner is not None else None, "object": r[obj],
                        "type": r[otype] if otype is not None and otype < len(r) else None,
                        "share_pct": ProductionAWRParser._to_float(r[-2]) if len(r) >= 2 else None})
    return out


def diagnose(ex: Extraction, awr: AWRReport, tables: dict, sqls: dict | None = None) -> list[Finding]:
    g = ex.get
    out: list[Finding] = []
    sqls = sqls or {}
    elapsed_s = (ex.facts.elapsed_minutes or 0) * 60

    # ── cursor sharing: many child cursors for one statement ───────────────
    many = sorted((s for s in sqls.values() if (s.get("version_count") or 0) >= 500),
                  key=lambda s: -s["version_count"])[:3]
    if many:
        top = many[0]
        out.append(Finding(
            "high_version_count", "MEDIUM", "Parsing", f"Cursor {top['sql_id']} has {top['version_count']:,.0f} child versions",
            "Statements with ≥ 500 child cursors: " + ", ".join(f"{s['sql_id']} ({s['version_count']:,.0f})" for s in many) + ".",
            {"statements": [{"sql_id": s["sql_id"], "version_count": s["version_count"]} for s in many]},
            [{"section": "SQL ordered by Version Count", "sql_id": s["sql_id"]} for s in many],
            ["Bind variables of varying length/type (bind mismatch)", "Optimizer environment differences between sessions",
             "Adaptive cursor sharing churn"],
            [{"action": f"Ask Oracle why cursors for {top['sql_id']} are not shared.",
              "rationale": "The reason column names the exact mismatch to fix.",
              "validation": f"SELECT * FROM v$sql_shared_cursor WHERE sql_id = '{top['sql_id']}';",
              "rollback": "Diagnostic only — no change.", "risk": "none"}],
            "Rule: version count ≥ 500 in SQL ordered by Version Count"))

    # ── polling: very frequent statements that return nothing ──────────────
    if elapsed_s:
        polls = [s for s in sqls.values()
                 if s.get("rows_processed") == 0 and (s.get("executions") or 0) / elapsed_s >= 1000]
        for s in sorted(polls, key=lambda s: -(s.get("executions") or 0))[:2]:
            per_s = s["executions"] / elapsed_s
            out.append(Finding(
                f"polling_sql:{s['sql_id']}", "LOW", "SQL", f"{s['sql_id']} runs {per_s:,.0f}×/s and returns no rows",
                f"{s['sql_id']} ({s.get('module') or 'unknown module'}) executed {s['executions']:,.0f} times in the window "
                f"with 0 rows processed.",
                {"sql_id": s["sql_id"], "executions": s["executions"], "executions_per_s": round(per_s, 1), "rows_processed": 0},
                [{"section": "SQL ordered by Executions", "sql_id": s["sql_id"]}],
                ["A polling loop checking for work that is rarely there", "A check that could be event-driven or cached"],
                [{"action": "Ask the owning module's team whether the poll interval can be lengthened or replaced.",
                  "rationale": "Each empty execution costs CPU and latches for nothing.",
                  "validation": "Executions/s for this sql_id drop in the next AWR.", "rollback": "Restore the interval.", "risk": "Slower pickup of new work."}],
                "Heuristic: ≥ 1,000 executions/s with 0 rows processed"))

    # ── commit latency ────────────────────────────────────────────────────
    lfs, commit_pct = g("log_file_sync_ms"), g("wait_class_commit_pct")
    sev = _band(lfs, 20, 100) if (commit_pct or 0) >= 5 else None
    if sev:
        out.append(Finding(
            "commit_latency", sev, "Commit", "Slow commits (log file sync)",
            f"Commits wait {lfs:.1f} ms on average and commit waits are {commit_pct:.1f}% of DB time.",
            _obs(ex, "log_file_sync_ms", "wait_class_commit_pct", "commits_per_s"),
            _refs(ex, "log_file_sync_ms", "wait_class_commit_pct", "commits_per_s"),
            ["Redo log writes are slow (storage latency or contention on the redo volume)",
             "The application commits very often (row-by-row commits in batch code)",
             "LGWR is starved of CPU or blocked (check 'log file parallel write' vs 'log file sync')"],
            [{"action": "Compare LGWR write time with commit wait time to tell storage from CPU/scheduling.",
              "rationale": "If 'log file parallel write' is close to 'log file sync', redo storage is the bottleneck.",
              "validation": "SELECT event, total_waits, ROUND(time_waited_micro/NULLIF(total_waits,0)/1000,2) avg_ms FROM v$system_event WHERE event IN ('log file sync','log file parallel write');",
              "rollback": "Diagnostic only — no change.", "risk": "none",
              "benefit": f"Commit waits are {commit_pct:.1f}% of DB time — the most that fixing commits can recover."},
             {"action": "Batch commits in high-frequency jobs (commit per N rows, not per row).",
              "rationale": "Fewer commits means fewer log file sync waits.",
              "validation": "Re-run AWR for the same window; log file sync avg and commits/s should fall.",
              "rollback": "Revert the application change.", "risk": "Larger transactions hold locks longer."},
             {"action": "Move redo logs to the lowest-latency storage; avoid sharing their volume with datafiles.",
              "rationale": "Redo writes are synchronous for every commit.",
              "validation": "'log file parallel write' average should drop below ~5 ms.",
              "rollback": "Re-point log members to the original location (ALTER DATABASE ADD/DROP LOGFILE MEMBER).",
              "risk": "Storage change; schedule a maintenance window."}],
            "Rule: avg log file sync ≥ 20 ms (MEDIUM) / ≥ 100 ms (HIGH) while commit waits ≥ 5% of DB time"))

    # ── storage latency vs I/O volume ─────────────────────────────────────
    io_pct, read_ms = g("wait_class_user_i_o_pct"), g("single_block_read_ms")
    sev = _band(read_ms, 10, 20)
    if sev:
        out.append(Finding(
            "storage_read_latency", sev, "I/O", "Slow single-block reads",
            f"Single-block reads average {read_ms:.2f} ms (well-tuned SAN/flash is typically under ~5 ms).",
            _obs(ex, "single_block_read_ms", "wait_class_user_i_o_pct", "read_iops"),
            _refs(ex, "single_block_read_ms", "wait_class_user_i_o_pct", "read_iops"),
            ["Storage latency (array, path or host queueing)", "I/O saturation from very high read rates"],
            [{"action": "Check OS-level device latency and queue depth during this window.",
              "rationale": "Separates a storage problem from a SQL problem.",
              "validation": "iostat / storage array latency for the datafile volumes in the same interval.",
              "rollback": "Diagnostic only — no change.", "risk": "none"}],
            "Rule: avg 'db file sequential read' ≥ 10 ms (MEDIUM) / ≥ 20 ms (HIGH)"))
    sev = _band(io_pct, 20, 40)
    if sev:
        latency_ok = read_ms is not None and read_ms < 5
        out.append(Finding(
            "io_wait_share", sev, "I/O", "User I/O is a large share of DB time",
            f"User I/O waits are {io_pct:.1f}% of DB time"
            + (f"; reads are fast ({read_ms:.2f} ms), so the cause is read volume, not storage." if latency_ok else "."),
            _obs(ex, "wait_class_user_i_o_pct", "single_block_read_ms", "physical_reads_per_s", "read_mb_per_s"),
            _refs(ex, "wait_class_user_i_o_pct", "single_block_read_ms", "physical_reads_per_s", "read_mb_per_s"),
            (["SQL reading far more blocks than needed (missing/unselective indexes, full scans)"]
             if latency_ok else ["Storage latency", "SQL reading more blocks than needed"]),
            [{"action": "Tune the top SQL by physical reads (see SQL Insights) before touching storage.",
              "rationale": "Reducing blocks read is cheaper and safer than faster storage.",
              "validation": "Physical reads/s and User I/O share fall in the next comparable AWR.",
              "rollback": "Drop any index or revert any SQL change that regresses.", "risk": "Index changes affect DML cost."}],
            "Rule: User I/O ≥ 20% (MEDIUM) / ≥ 40% (HIGH) of DB time"))

    # ── CPU pressure ──────────────────────────────────────────────────────
    host, cpu_wait = g("host_cpu_busy_pct"), g("cpu_wait_pct_db_time")
    sev = _band(host, 70, 85) or _band(cpu_wait, 5, 15)
    if sev:
        out.append(Finding(
            "cpu_pressure", sev, "CPU", "Host CPU pressure",
            f"Host CPUs were {host or 0:.1f}% busy; {cpu_wait or 0:.1f}% of DB time was spent waiting for CPU.",
            _obs(ex, "host_cpu_busy_pct", "cpu_wait_pct_db_time", "db_cpu_util_pct", "host_load"),
            _refs(ex, "host_cpu_busy_pct", "cpu_wait_pct_db_time", "db_cpu_util_pct", "host_load"),
            ["CPU-heavy SQL (see SQL Insights, %CPU)", "Non-database processes on the host", "Too few CPUs for the peak"],
            [{"action": "Identify the top CPU SQL and tune or reschedule it.", "rationale": "Usually cheaper than adding CPUs.",
              "validation": "Host busy % and CPU wait fall in the next comparable AWR.", "rollback": "Revert SQL/schedule change.", "risk": "low"}],
            "Rule: host CPU busy ≥ 70% (MEDIUM) / ≥ 85% (HIGH), or CPU wait ≥ 5% / 15% of DB time"))

    # ── application locks & concurrency ───────────────────────────────────
    app_pct = g("wait_class_application_pct")
    sev = _band(app_pct, 10, 25)
    if sev:
        segs = _segments(tables, "this table displays top segments by row lock waits")
        lock_ev = next((e for e in awr.top_wait_events if "row lock" in e.name.lower()), None)
        out.append(Finding(
            "row_lock_contention", sev, "Concurrency", "Row-lock contention between sessions",
            f"Application-class waits (mostly locks) are {app_pct:.1f}% of DB time"
            + (f"; '{lock_ev.name}' averages {lock_ev.avg_wait_ms/1000:.1f} s per wait" if lock_ev and lock_ev.avg_wait_ms else "")
            + (f". Most-locked segment: {segs[0]['owner']}.{segs[0]['object']}." if segs else "."),
            {**_obs(ex, "wait_class_application_pct"), **({"top_row_lock_segments": segs} if segs else {})},
            _refs(ex, "wait_class_application_pct") + ([{"section": "Top segments by row lock waits"}] if segs else []),
            ["Two jobs updating the same rows at the same time", "Long transactions holding row locks", "Unindexed foreign keys"],
            [{"action": "Find blockers and the statements they hold locks with during the busy window.",
              "rationale": "Lock waits are an application-design issue; the blocker is the fix point.",
              "validation": "SELECT blocking_session, sid, sql_id, event, seconds_in_wait FROM v$session WHERE blocking_session IS NOT NULL;",
              "rollback": "Diagnostic only — no change.", "risk": "none"},
             {"action": "Separate or serialise the jobs that update the hot segment(s); commit sooner.",
              "rationale": "Removes the collision instead of making it faster.",
              "validation": "Application wait share and row-lock waits on the segment fall in the next AWR.",
              "rollback": "Restore the previous schedule.", "risk": "Job timing changes."}],
            "Rule: Application-class waits ≥ 10% (MEDIUM) / ≥ 25% (HIGH) of DB time"))
    conc = g("wait_class_concurrency_pct")
    sev = _band(conc, 10, 25)
    if sev:
        out.append(Finding(
            "concurrency_waits", sev, "Concurrency", "Internal contention (latches, mutexes, buffer busy)",
            f"Concurrency-class waits are {conc:.1f}% of DB time.",
            _obs(ex, "wait_class_concurrency_pct"), _refs(ex, "wait_class_concurrency_pct"),
            ["Hot blocks or hot cursors", "Excessive parsing / cursor invalidation"],
            [{"action": "Review the concurrency events in Wait Events and the segments by buffer busy waits.",
              "rationale": "The specific event decides the fix.", "validation": "Concurrency share falls in the next AWR.",
              "rollback": "Diagnostic only — no change.", "risk": "none"}],
            "Rule: Concurrency-class waits ≥ 10% (MEDIUM) / ≥ 25% (HIGH) of DB time"))

    # ── parsing ───────────────────────────────────────────────────────────
    hard, soft = g("hard_parses_per_s"), g("soft_parse_pct")
    if (hard or 0) >= 100 or (soft is not None and soft < 95):
        out.append(Finding(
            "excessive_parsing", "MEDIUM", "Parsing", "Excessive hard parsing",
            f"{hard or 0:.1f} hard parses/s; soft parse ratio {soft if soft is not None else 'n/a'}%.",
            _obs(ex, "hard_parses_per_s", "soft_parse_pct", "hard_parse_time_pct"),
            _refs(ex, "hard_parses_per_s", "soft_parse_pct", "hard_parse_time_pct"),
            ["SQL built with literals instead of bind variables", "Shared pool too small, cursors aged out"],
            [{"action": "Find statements that differ only by literals and convert them to bind variables.",
              "rationale": "Each literal variant is a separate hard parse.",
              "validation": "SELECT force_matching_signature, COUNT(*) FROM v$sql GROUP BY force_matching_signature HAVING COUNT(*) > 50 ORDER BY 2 DESC;",
              "rollback": "Revert the application change.", "risk": "low"}],
            "Rule: hard parses ≥ 100/s or soft parse ratio < 95%"))

    # ── memory ────────────────────────────────────────────────────────────
    over, pga_hit = g("pga_overalloc_count"), g("pga_cache_hit_pct")
    if (over or 0) > 0 or (pga_hit is not None and pga_hit < 90):
        out.append(Finding(
            "pga_pressure", "HIGH" if (over or 0) > 0 else "MEDIUM", "Memory", "PGA memory pressure",
            f"PGA over-allocations at current target: {over if over is not None else 'n/a'}; PGA cache hit {pga_hit if pga_hit is not None else 'n/a'}%.",
            _obs(ex, "pga_overalloc_count", "pga_cache_hit_pct", "pga_alloc_mb", "pga_target_mb"),
            _refs(ex, "pga_overalloc_count", "pga_cache_hit_pct", "pga_alloc_mb", "pga_target_mb"),
            ["PGA_AGGREGATE_TARGET too small for sort/hash work", "A few sessions with very large work areas"],
            [{"action": "Review the PGA Memory Advisory and size PGA_AGGREGATE_TARGET to the point with no over-allocations.",
              "rationale": "Over-allocation means Oracle exceeded its own target.",
              "validation": "Estd PGA Overalloc Count = 0 at the new size in the next AWR.",
              "rollback": "ALTER SYSTEM SET pga_aggregate_target=<previous value>;", "risk": "Uses more host memory."}],
            "Rule: PGA over-allocation count > 0 (HIGH) or PGA cache hit < 90% (MEDIUM)"))
    mem = g("host_mem_used_by_db_pct")
    sev = _band(mem, 85, 95)
    if sev:
        out.append(Finding(
            "host_memory", sev, "Memory", "SGA + PGA use most of host memory",
            f"SGA + PGA use {mem:.1f}% of host memory.", _obs(ex, "host_mem_used_by_db_pct", "sga_used_mb", "pga_used_mb"),
            _refs(ex, "host_mem_used_by_db_pct"), ["Memory targets sized close to physical memory"],
            [{"action": "Leave headroom for the OS and other processes; check for paging on the host.",
              "rationale": "Paging degrades every process on the host.", "validation": "No swap activity during peak.",
              "rollback": "Restore the previous SGA/PGA targets.", "risk": "Smaller caches."}],
            "Rule: SGA+PGA ≥ 85% (MEDIUM) / ≥ 95% (HIGH) of host memory"))

    # ── resource limits ───────────────────────────────────────────────────
    for m in ex.metrics:
        if m.key.startswith("limit_") and m.value >= 85:
            name = m.label.replace(" peak as % of limit", "")
            out.append(Finding(
                f"resource_limit_{m.key}", "HIGH" if m.value >= 95 else "MEDIUM", "Capacity",
                f"{name} close to its configured limit",
                f"{name} peaked at {m.value:.1f}% of its limit during the window.",
                _obs(ex, m.key), _refs(ex, m.key), ["Connection storms or leaked sessions", "Limit sized for an older workload"],
                [{"action": f"Check what drives {name} usage, then raise the limit only if the usage is legitimate.",
                  "rationale": "Hitting the limit refuses new work (e.g. ORA-00020 for processes).",
                  "validation": "Peak stays below 80% of the limit in the next AWR.",
                  "rollback": "Restore the previous parameter value (spfile change needs restart).", "risk": "More memory per process."}],
                "Rule: resource peak ≥ 85% (MEDIUM) / ≥ 95% (HIGH) of its limit"))

    # ── dominant individual wait events (excluding CPU, covered above) ────
    for ev in awr.top_wait_events[:10]:
        name = ev.name.lower()
        if name == "db cpu" or ev.percent_db_time is None:
            continue
        sev = _band(ev.percent_db_time, 10, 25)
        if sev and not ({"log file sync": "commit_latency", "enq: tx - row lock contention": "row_lock_contention"}.get(name) in {f.rule_id for f in out}):
            out.append(Finding(
                f"wait_event:{name}"[:80], sev, "Wait Events", f"{ev.name} is {ev.percent_db_time:.1f}% of DB time",
                f"{ev.name}: {ev.percent_db_time:.1f}% of DB time"
                + (f", avg {ev.avg_wait_ms:.2f} ms over {ev.waits:,.0f} waits." if ev.avg_wait_ms is not None and ev.waits else "."),
                {"event": ev.name, "percent_db_time": ev.percent_db_time, "avg_wait_ms": ev.avg_wait_ms, "wait_class": ev.wait_class},
                [{"section": "Top 10 foreground events by total wait time", "event": ev.name}],
                [f"See the {ev.wait_class or 'event'} guidance in Wait Events"],
                [{"action": "Correlate this event with the top SQL of the same window.",
                  "rationale": "Waits are symptoms; the SQL causing them is the fix point.",
                  "validation": "The event's share falls in the next comparable AWR.", "rollback": "Diagnostic only.", "risk": "none"}],
                "Rule: single event ≥ 10% (MEDIUM) / ≥ 25% (HIGH) of DB time"))

    # ── efficiency ratios the old engine checked ──────────────────────────
    for key, label in (("buffer_nowait_pct", "Buffer Nowait %"), ("library_hit_pct", "Library Hit %")):
        v = g(key)
        if v is not None and v < 95:
            out.append(Finding(
                f"efficiency_{key}", "MEDIUM", "Instance Efficiency", f"{label} below 95%",
                f"{label} is {v:.2f}%.", _obs(ex, key), _refs(ex, key),
                ["Buffer contention / hot blocks" if "buffer" in key else "Shared pool pressure or cursor invalidation"],
                [{"action": "Review the matching wait events before changing memory settings.", "rationale": "Ratios are symptoms.",
                  "validation": "Ratio ≥ 95% in the next AWR.", "rollback": "Diagnostic only.", "risk": "none"}],
                "Rule: ratio < 95%"))

    # ── SQL: share of DB time, CPU-/I/O-heavy, full scans ─────────────────
    db_time_s = (ex.facts.db_time_minutes or 0) * 60
    for sql in awr.sql_by_elapsed_time[:10]:
        if not sql.sql_id or not sql.elapsed_time_seconds or not db_time_s:
            continue
        share = sql.elapsed_time_seconds / db_time_s * 100
        sev = _band(share, 5, 10)
        if not sev:
            continue
        cpu_pct, io_pct_sql = (ProductionAWRParser._to_float(sql.raw.get(k)) for k in ("cpu", "io"))
        per_exec = ProductionAWRParser._to_float(sql.raw.get("elapsed_time_per_exec_s"))
        kind = "CPU-heavy" if (cpu_pct or 0) >= 80 else "I/O-heavy" if (io_pct_sql or 0) >= 50 else "Expensive"
        module = sql.raw.get("sql_module") or "unknown module"
        out.append(Finding(
            f"sql:{sql.sql_id}", sev, "SQL", f"{kind} SQL {sql.sql_id} uses {share:.1f}% of DB time",
            f"{sql.sql_id} ({module}): {sql.elapsed_time_seconds:,.0f} s elapsed over {sql.executions or 0:,.0f} executions"
            + (f" ({per_exec:,.2f} s each)" if per_exec else "")
            + (f"; {cpu_pct:.0f}% CPU, {io_pct_sql:.0f}% I/O." if cpu_pct is not None and io_pct_sql is not None else "."),
            {"sql_id": sql.sql_id, "module": module, "elapsed_s": sql.elapsed_time_seconds, "executions": sql.executions,
             "elapsed_per_exec_s": per_exec, "cpu_pct": cpu_pct, "io_pct": io_pct_sql, "share_of_db_time_pct": round(share, 2)},
            [{"section": "SQL ordered by Elapsed Time", "sql_id": sql.sql_id}],
            (["Inefficient plan (full scans, nested loops over large row sources)", "Called far more often than needed"]
             if kind != "I/O-heavy" else ["Missing or unselective index", "Full scans of large tables"]),
            [{"action": f"Pull the execution plan and runtime stats for {sql.sql_id}.",
              "rationale": "The plan shows where the time goes.",
              "validation": f"SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY_AWR('{sql.sql_id}'));",
              "rollback": "Diagnostic only — no change.", "risk": "none"},
             {"action": f"Run SQL Tuning Advisor on {sql.sql_id}; accept index/profile advice only after testing.",
              "rationale": "Advisor recommendations are evidence-based for this statement.",
              "validation": "Elapsed per execution falls in the next comparable AWR.",
              "rollback": "DBMS_SQLTUNE.DROP_SQL_PROFILE / DROP INDEX for anything accepted.",
              "risk": "New indexes add DML overhead."}],
            "Rule: one statement ≥ 5% (MEDIUM) / ≥ 10% (HIGH) of DB time", finding_type="diagnosis"))

    scans = g("full_scans_long_per_s")
    segs = _segments(tables, "this table displays top segments by table scans")
    if scans is not None and scans >= 1 and segs and (io_pct or 0) >= 10:
        out.append(Finding(
            "full_scans", "LOW", "SQL", "Full scans of large tables worth investigating",
            f"{scans:.1f} long-table full scans/s; most-scanned: {segs[0]['owner']}.{segs[0]['object']}.",
            {**_obs(ex, "full_scans_long_per_s"), "top_scanned_segments": segs},
            _refs(ex, "full_scans_long_per_s") + [{"section": "Top segments by table scans"}],
            ["Missing index for a frequent predicate", "Reporting queries that legitimately scan"],
            [{"action": "Find SQL that full-scans the top segment and check whether an index fits its predicates.",
              "rationale": "A scan may be correct for reports; it is wrong for selective lookups.",
              "validation": "SELECT sql_id, object_name FROM v$sql_plan WHERE operation='TABLE ACCESS' AND options='FULL' AND object_name = '<segment>';",
              "rollback": "Diagnostic only — no change.", "risk": "none"}],
            "Heuristic: ≥ 1 long-table scan/s while User I/O ≥ 10% of DB time"))

    if not out:
        out.append(Finding(
            "baseline", "INFO", "Baseline", "No rule thresholds crossed",
            "None of the diagnosis rules fired for this snapshot window.", {}, [], [],
            [{"action": "Keep this report as a baseline for future comparisons.", "rationale": "Trends need a normal reference.",
              "validation": "n/a", "rollback": "n/a", "risk": "none"}],
            "All rules evaluated; none crossed"))
    return out
