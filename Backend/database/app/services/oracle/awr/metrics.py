"""Normalised, per-report AWR metrics — every value traceable to the AWR table it
came from.

Rules this module keeps:
- A metric is only emitted when its source table/row is present and numeric.
  Missing sections produce no metric (and are listed in data_quality), never 0.
- Rates are per second over the snapshot interval, so reports of different
  lengths (1 h vs 4 h windows) compare directly. Oracle's own "per Second"
  columns are used where printed; derived values say how they were derived.
- Nothing here is estimated: these are measurements, not model output.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .parser import ProductionAWRParser

METRICS_VERSION = "awr-metrics-1"

_num = ProductionAWRParser._to_float
_ms = ProductionAWRParser._to_ms


@dataclass
class Metric:
    key: str
    value: float
    unit: str
    category: str
    label: str
    source: str  # the AWR table the value was read from


@dataclass
class ReportFacts:
    """Identity and capacity of the database a report describes."""
    db_name: str | None = None
    dbid: str | None = None
    release: str | None = None
    rac: bool | None = None
    cdb: bool | None = None
    edition: str | None = None
    role: str | None = None
    instance_name: str | None = None
    instance_number: str | None = None
    instance_startup: str | None = None  # a change between reports = restart (baseline shift)
    host_name: str | None = None
    platform: str | None = None
    num_cpus: float | None = None
    num_cores: float | None = None
    host_mem_gb: float | None = None
    snap_begin_id: str | None = None
    snap_end_id: str | None = None
    elapsed_minutes: float | None = None
    db_time_minutes: float | None = None


@dataclass
class Extraction:
    facts: ReportFacts
    metrics: list[Metric] = field(default_factory=list)
    data_quality: dict = field(default_factory=dict)

    def get(self, key: str) -> float | None:
        return next((m.value for m in self.metrics if m.key == key), None)


# Sections a complete 12c+ AWR report has, with the label shown when one is missing.
_EXPECTED = {
    "this table displays database instance information": "Database instance",
    "this table displays host information": "Host",
    "this table displays snapshot information": "Snapshot",
    "this table displays load profile": "Load profile",
    "this table displays instance efficiency percentages": "Instance efficiency",
    "this table displays foreground wait class statistics": "Foreground wait classes",
    "this table displays operating systems statistics": "Operating system statistics",
    "this table displays different time model statistics": "Time model",
    "this table displays instance activity stat": "Instance activity",
    "this table displays memory statistics": "Memory statistics",
    "this table displays pga aggregate target statistics": "PGA aggregate target",
}

_LOAD_PROFILE = {
    "db time(s)": ("db_time_per_s", "DB time per second", "s/s", "workload"),
    "db cpu(s)": ("db_cpu_per_s", "DB CPU per second", "CPU s/s", "cpu"),
    "redo size (bytes)": ("redo_bytes_per_s", "Redo generated", "bytes/s", "workload"),
    "logical read (blocks)": ("logical_reads_per_s", "Logical reads", "blocks/s", "io"),
    "block changes": ("block_changes_per_s", "Block changes", "blocks/s", "workload"),
    "physical read (blocks)": ("physical_reads_per_s", "Physical reads", "blocks/s", "io"),
    "physical write (blocks)": ("physical_writes_per_s", "Physical writes", "blocks/s", "io"),
    "read io requests": ("read_iops", "Read I/O requests", "req/s", "io"),
    "write io requests": ("write_iops", "Write I/O requests", "req/s", "io"),
    "read io (mb)": ("read_mb_per_s", "Read throughput", "MB/s", "io"),
    "write io (mb)": ("write_mb_per_s", "Write throughput", "MB/s", "io"),
    "user calls": ("user_calls_per_s", "User calls", "calls/s", "workload"),
    "parses (sql)": ("parses_per_s", "Parses", "parses/s", "parsing"),
    "hard parses (sql)": ("hard_parses_per_s", "Hard parses", "parses/s", "parsing"),
    "executes (sql)": ("executes_per_s", "Executions", "exec/s", "workload"),
    "transactions": ("transactions_per_s", "Transactions", "tx/s", "workload"),
    "logons": ("logons_per_s", "Logons", "logons/s", "workload"),
}

_ACTIVITY = {  # Instance Activity Stats rows; per-second column
    "parse count (hard)": ("hard_parses_per_s", "Hard parses", "parses/s", "parsing"),
    "parse count (total)": ("parses_per_s", "Parses", "parses/s", "parsing"),
    "user commits": ("commits_per_s", "User commits", "commits/s", "workload"),
    "user rollbacks": ("rollbacks_per_s", "User rollbacks", "rollbacks/s", "workload"),
    "execute count": ("executes_per_s", "Executions", "exec/s", "workload"),
    "user calls": ("user_calls_per_s", "User calls", "calls/s", "workload"),
    "table scans (long tables)": ("full_scans_long_per_s", "Full scans of long tables", "scans/s", "sql"),
    "sorts (disk)": ("disk_sorts_per_s", "Sorts spilled to disk", "sorts/s", "memory"),
    "logons cumulative": ("logons_per_s", "Logons", "logons/s", "workload"),
}

_EFFICIENCY = {
    "buffer nowait %": "buffer_nowait_pct", "redo nowait %": "redo_nowait_pct",
    "buffer hit %": "buffer_hit_pct", "in-memory sort %": "in_memory_sort_pct",
    "library hit %": "library_hit_pct", "soft parse %": "soft_parse_pct",
    "execute to parse %": "execute_to_parse_pct", "latch hit %": "latch_hit_pct",
    "parse cpu to parse elapsd %": "parse_cpu_to_elapsed_pct", "% non-parse cpu": "non_parse_cpu_pct",
}

_WAIT_CLASSES = ("CPU", "User I/O", "Commit", "Concurrency", "Application", "Configuration",
                 "Cluster", "Network", "System I/O", "Scheduler", "Other")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _label_key(cell: str) -> str:
    return re.sub(r"\s+", " ", cell.replace(":", "")).strip().lower()


def _find(tables: dict[str, list[list[str]]], prefix: str) -> tuple[str, list[list[str]]] | tuple[None, None]:
    for summary, rows in tables.items():
        if summary.startswith(prefix):
            return summary, rows
    return None, None


def _source(summary: str) -> str:
    return summary.replace("this table displays ", "").split(".")[0].strip().capitalize()


def _header_map(rows: list[list[str]]) -> dict[str, int]:
    return {_slug(h): i for i, h in enumerate(rows[0])} if rows else {}


def extract(parser: ProductionAWRParser) -> Extraction:
    tables = parser.summary_tables()
    facts = ReportFacts()
    out: list[Metric] = []
    seen: set[str] = set()

    def add(key, value, unit, category, label, summary):
        if value is None or key in seen:
            return
        seen.add(key)
        out.append(Metric(key, round(float(value), 6), unit, category, label, _source(summary)))

    # ── identity & capacity ────────────────────────────────────────────────
    s, rows = _find(tables, "this table displays database instance information")
    if rows and len(rows) > 1:
        h, r = _header_map(rows), rows[1]
        cell = lambda name: r[h[name]] if name in h and h[name] < len(r) and r[h[name]] else None  # noqa: E731
        facts.db_name, facts.dbid, facts.release = cell("db_name"), cell("db_id"), cell("release")
        facts.edition, facts.role = cell("edition"), cell("role")
        facts.rac = {"YES": True, "NO": False}.get((cell("rac") or "").upper())
        facts.cdb = {"YES": True, "NO": False}.get((cell("cdb") or "").upper())
    for summary, rows in tables.items():
        if summary.startswith("this table displays database instance information") and rows and len(rows) > 1:
            h, r = _header_map(rows), rows[1]
            if "inst_num" in h:
                cell = lambda name: r[h[name]] if name in h and h[name] < len(r) and r[h[name]] else None  # noqa: E731
                facts.instance_name, facts.instance_number = cell("instance"), cell("inst_num")
                facts.instance_startup = cell("startup_time")
    s, rows = _find(tables, "this table displays host information")
    if rows and len(rows) > 1:
        h, r = _header_map(rows), rows[1]
        cell = lambda name: r[h[name]] if name in h and h[name] < len(r) else None  # noqa: E731
        facts.host_name, facts.platform = cell("host_name"), cell("platform")
        facts.num_cpus, facts.num_cores = _num(cell("cpus")), _num(cell("cores"))
        facts.host_mem_gb = _num(cell("memory_gb"))

    s, rows = _find(tables, "this table displays snapshot information")
    if rows:
        h = _header_map(rows)
        for r in rows[1:]:
            label = _label_key(r[0]) if r else ""
            if label == "begin snap" and len(r) > 1:
                facts.snap_begin_id = r[1] or None
                if "sessions" in h and h["sessions"] < len(r):
                    add("sessions_begin", _num(r[h["sessions"]]), "sessions", "sessions", "Sessions at begin snap", s)
            elif label == "end snap" and len(r) > 1:
                facts.snap_end_id = r[1] or None
                if "sessions" in h and h["sessions"] < len(r):
                    add("sessions_end", _num(r[h["sessions"]]), "sessions", "sessions", "Sessions at end snap", s)
            elif label == "elapsed":
                facts.elapsed_minutes = next((_num(c) for c in r[1:] if c), None)
            elif label == "db time":
                facts.db_time_minutes = next((_num(c) for c in r[1:] if c), None)
        if facts.db_time_minutes and facts.elapsed_minutes:
            add("aas", facts.db_time_minutes / facts.elapsed_minutes, "sessions", "workload",
                "Average active sessions (DB time ÷ elapsed)", s)

    # ── load profile (Oracle's own per-second column) ──────────────────────
    s, rows = _find(tables, "this table displays load profile")
    if rows:
        col = _header_map(rows).get("per_second", 1)
        for r in rows[1:]:
            spec = _LOAD_PROFILE.get(_label_key(r[0])) if r else None
            if spec and col < len(r):
                add(spec[0], _num(r[col]), spec[2], spec[3], spec[1], s)

    # ── instance activity (fills what the load profile lacks) ──────────────
    for prefix in ("this table displays key instance activity", "this table displays instance activity stat"):
        s, rows = _find(tables, prefix)
        if rows:
            col = _header_map(rows).get("per_second", 2)
            for r in rows[1:]:
                spec = _ACTIVITY.get(_label_key(r[0])) if r else None
                if spec and col < len(r):
                    add(spec[0], _num(r[col]), spec[2], spec[3], spec[1], s)

    # ── CPU ────────────────────────────────────────────────────────────────
    db_cpu = next((m.value for m in out if m.key == "db_cpu_per_s"), None)
    if db_cpu is not None and facts.num_cpus:
        add("db_cpu_util_pct", db_cpu / facts.num_cpus * 100, "%", "cpu",
            "Database CPU use as % of host CPUs (DB CPU/s ÷ CPUs)", "load profile + host")
    s, rows = _find(tables, "this table displays operating systems statistics")
    if rows:
        stat = {_label_key(r[0]): r for r in rows[1:] if r}
        busy, idle = (_num(stat.get(k, [None, None])[1]) for k in ("busy_time", "idle_time"))
        if busy is not None and idle and busy + idle > 0:
            add("host_cpu_busy_pct", busy / (busy + idle) * 100, "%", "cpu", "Host CPU busy (BUSY_TIME ÷ total)", s)
        if facts.num_cpus is None and "num_cpus" in stat:
            facts.num_cpus = _num(stat["num_cpus"][1])
        load = stat.get("load")
        if load:
            add("host_load", _num(load[2] if len(load) > 2 and load[2] else load[1]), "load", "cpu", "Host load average (end)", s)
    s, rows = _find(tables, "this table displays cpu usage and wait statistics")
    if rows and len(rows) > 1:
        h, r = _header_map(rows), rows[1]
        idx = next((i for k, i in h.items() if k.startswith("db_time_waiting_for_cpu")), None)
        if idx is not None and idx < len(r):
            add("cpu_wait_pct_db_time", _num(r[idx]), "% DB time", "cpu", "DB time waiting for CPU (resource manager)", s)

    # ── time model ─────────────────────────────────────────────────────────
    s, rows = _find(tables, "this table displays different time model statistics")
    if rows:
        for r in rows[1:]:
            name = _label_key(r[0]) if r else ""
            if len(r) > 2 and name in ("hard parse elapsed time", "parse time elapsed"):
                key = "hard_parse_time_pct" if name.startswith("hard") else "parse_time_pct"
                add(key, _num(r[2]), "% DB time", "parsing", f"{r[0]} (% of DB time)", s)

    # ── efficiency ratios (two metrics per row) ────────────────────────────
    s, rows = _find(tables, "this table displays instance efficiency percentages")
    if rows:
        for r in rows:
            for name, value in zip(r[0::2], r[1::2]):
                key = _EFFICIENCY.get(_label_key(name))
                if key:
                    add(key, _num(value), "%", "efficiency", name.rstrip(":").strip(), s)

    # ── wait classes & key latencies ───────────────────────────────────────
    s, rows = _find(tables, "this table displays foreground wait class statistics")
    if rows:
        h = _header_map(rows)
        pct = next((i for k, i in h.items() if k.endswith("db_time")), None)
        for r in rows[1:]:
            klass = "CPU" if r and r[0].upper() == "DB CPU" else (r[0] if r else "")
            if klass in _WAIT_CLASSES and pct is not None and pct < len(r):
                add(f"wait_class_{_slug(klass)}_pct", _num(r[pct]), "% DB time", "waits", f"{klass} share of DB time", s)
    # every top foreground event, so a rising wait can be followed across reports
    for ev in parser_events(parser)[:20]:
        if ev.percent_db_time is not None and ev.name.lower() != "db cpu":
            add(f"event_pct:{_slug(ev.name)}"[:80], ev.percent_db_time, "% DB time", "event", ev.name,
                "foreground wait events")
    for event, key, label in (("db file sequential read", "single_block_read_ms", "Single-block read latency"),
                              ("log file sync", "log_file_sync_ms", "Commit (log file sync) latency")):
        ev = next((e for e in parser_events(parser) if e.name.lower() == event), None)
        if ev and ev.avg_wait_ms is not None:
            add(key, ev.avg_wait_ms, "ms", "waits", label, "foreground wait events")

    # ── memory ─────────────────────────────────────────────────────────────
    s, rows = _find(tables, "this table displays memory statistics")
    if rows:
        for r in rows[1:]:
            name = _label_key(r[0]) if r else ""
            end = _num(r[2]) if len(r) > 2 and r[2] else (_num(r[1]) if len(r) > 1 else None)
            if name.startswith("sga use"):
                add("sga_used_mb", end, "MB", "memory", "SGA in use (end)", s)
            elif name.startswith("pga use"):
                add("pga_used_mb", end, "MB", "memory", "PGA in use (end)", s)
            elif name.startswith("% host mem used"):
                add("host_mem_used_by_db_pct", end, "%", "memory", "Host memory used by SGA+PGA (end)", s)
    s, rows = _find(tables, "this table displays pga aggregate target statistics")
    if rows:
        h = _header_map(rows)
        end = next((r for r in rows[1:] if r and r[0].upper() == "E"), None)
        if end:
            tgt, alloc = h.get("pga_aggr_target_m"), h.get("pga_mem_alloc_m")
            if tgt is not None and tgt < len(end):
                add("pga_target_mb", _num(end[tgt]), "MB", "memory", "PGA aggregate target", s)
            if alloc is not None and alloc < len(end):
                add("pga_alloc_mb", _num(end[alloc]), "MB", "memory", "PGA allocated (end)", s)
    s, rows = _find(tables, "this table displays pga aggregate summary")
    if rows and len(rows) > 1:
        add("pga_cache_hit_pct", _num(rows[1][0]), "%", "memory", "PGA cache hit %", s)
    s, rows = _find(tables, "this table displays pga memory advisory")
    if rows:
        h = _header_map(rows)
        fi, oi = h.get("size_factr"), next((i for k, i in h.items() if "overalloc" in k), None)
        cur = next((r for r in rows[1:] if fi is not None and fi < len(r) and _num(r[fi]) == 1.0), None)
        if cur and oi is not None and oi < len(cur):
            add("pga_overalloc_count", _num(cur[oi]), "count", "memory", "PGA over-allocation count at current target", s)

    # ── resource limits (only rows Oracle printed, only finite limits) ─────
    s, rows = _find(tables, "this table displays resource limit statistics")
    if rows:
        h = _header_map(rows)
        mx, lim = h.get("maximum_utilization"), h.get("limit")
        for r in rows[1:]:
            if mx is None or lim is None or lim >= len(r):
                continue
            limit, peak = _num(r[lim]), _num(r[mx])
            if limit and peak is not None and r[lim].strip().upper() != "UNLIMITED":
                add(f"limit_{_slug(r[0])}_peak_pct", peak / limit * 100, "% of limit", "sessions",
                    f"{r[0]} peak as % of limit", s)

    present = [label for summary, label in _EXPECTED.items() if any(t.startswith(summary) for t in tables)]
    missing = [label for summary, label in _EXPECTED.items() if not any(t.startswith(summary) for t in tables)]
    quality = {
        "metrics_version": METRICS_VERSION,
        "sections_expected": len(_EXPECTED),
        "sections_present": len(present),
        "missing_sections": missing,
        "metric_count": len(out),
        "level": "complete" if not missing else ("partial" if len(present) >= len(_EXPECTED) // 2 else "poor"),
    }
    return Extraction(facts=facts, metrics=out, data_quality=quality)


def parser_events(parser: ProductionAWRParser):
    if not hasattr(parser, "_awr_cache"):
        parser._awr_cache = parser.parse_all()
    return parser._awr_cache.top_wait_events
