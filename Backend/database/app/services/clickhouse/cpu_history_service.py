"""
CPU history in ClickHouse — the CPU time split and the top CPU processes, one row (set) per collection.
=========================================================================================================

  {CH_DB}.host_cpu_metrics     one row per host per collection: busy / user / system / iowait / irq / steal / idle %,
                               context switches & interrupts per second, runnable tasks, load averages
  {CH_DB}.host_process_cpu     the top 15 processes by CURRENT CPU at each collection

"Current" matters: Linux ps %CPU is an average since the process started, so it is not stored. Linux rows come from
the collector's PROCNOW section (two /proc/<pid>/stat reads 0.5 s apart); Windows rows from the collector's own 0.4 s
sample. Both scales are "% of one core" on Linux and "% of total CPU" on Windows — the platform column says which.

Same ClickHouse connection and conventions as memory_history_service (UTC, day partitions, TTL; failures raised).
"""
import datetime
import os

from app.services.clickhouse.memory_history_service import MemoryHistoryUnavailable, _client, _f, _u
from app.services.clickhouse.metrics_history_service import CH_DB, mark_down

TTL_DAYS = int(os.getenv("CPU_CH_TTL_DAYS", "90") or 90)
PROC_TTL_DAYS = int(os.getenv("CPU_PROC_CH_TTL_DAYS", "30") or 30)
HOST_T = f"{CH_DB}.host_cpu_metrics"
PROC_T = f"{CH_DB}.host_process_cpu"
HOST_COLS = [
    ("busy_pct", "Nullable(Float64)"), ("user_pct", "Nullable(Float64)"), ("system_pct", "Nullable(Float64)"),
    ("iowait_pct", "Nullable(Float64)"), ("irq_pct", "Nullable(Float64)"), ("steal_pct", "Nullable(Float64)"),
    ("idle_pct", "Nullable(Float64)"), ("ctx_ps", "Nullable(Float64)"), ("intr_ps", "Nullable(Float64)"),
    ("runnable", "Nullable(UInt32)"), ("load1", "Nullable(Float64)"), ("load5", "Nullable(Float64)"),
    ("load15", "Nullable(Float64)"),
]
PROC_COLS = [
    ("pid", "UInt32"), ("name", "LowCardinality(String)"), ("cpu_pct", "Float64"), ("mem_pct", "Nullable(Float64)"),
    ("threads", "Nullable(UInt32)"), ("user_name", "Nullable(String)"), ("running_s", "Nullable(UInt64)"),
    ("user_cpu_pct", "Nullable(Float64)"), ("kernel_cpu_pct", "Nullable(Float64)"), ("ppid", "Nullable(UInt32)"),
]
_ready = False


def ensure_tables(cli):
    global _ready
    if _ready:
        return
    cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
    cols = ",\n".join(f"{c} {t}" for c, t in HOST_COLS)
    cli.command(f"""CREATE TABLE IF NOT EXISTS {HOST_T} (
        ts DateTime('UTC'), server_id UInt32, platform LowCardinality(String),
        {cols}
      ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, ts)
        TTL ts + INTERVAL {TTL_DAYS} DAY""")
    pcols = ",\n".join(f"{c} {t}" for c, t in PROC_COLS)
    cli.command(f"""CREATE TABLE IF NOT EXISTS {PROC_T} (
        ts DateTime('UTC'), server_id UInt32, platform LowCardinality(String),
        {pcols}
      ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, ts, pid)
        TTL ts + INTERVAL {PROC_TTL_DAYS} DAY""")
    for c, t in PROC_COLS:      # columns added after the table was first created
        cli.command(f"ALTER TABLE {PROC_T} ADD COLUMN IF NOT EXISTS {c} {t}")
    _ready = True


def _platform(parsed):
    os_name = str(((parsed or {}).get("system") or {}).get("os") or "")
    return "windows" if "windows" in os_name.lower() else "linux"


def write_cpu(server_id, parsed, now=None):
    """One collection -> host row (+ process rows). "skipped" when the collector sent no CPU split (old script)."""
    c = dict((parsed or {}).get("cpu_detail") or {})
    if c.get("user_pct") is None and c.get("busy_pct") is None:
        return "skipped"
    plat = _platform(parsed)
    if plat == "windows":
        # Windows counters: Privileged = kernel, Interrupt + DPC = interrupt handling; busy = overall utilisation.
        def n(k):
            v = c.get(k)
            return float(v) if isinstance(v, (int, float)) else None
        busy = n("busy_pct") if n("busy_pct") is not None else (float(parsed["cpu_pct"]) if isinstance(parsed.get("cpu_pct"), (int, float)) else None)
        irq = sum(v for v in (n("interrupt_pct"), n("dpc_pct")) if v is not None) if (n("interrupt_pct") is not None or n("dpc_pct") is not None) else None
        c.setdefault("system_pct", n("privileged_pct"))
        c.setdefault("irq_pct", irq)
        c["busy_pct"] = busy
        if c.get("idle_pct") is None and busy is not None:
            c["idle_pct"] = round(max(0.0, 100.0 - busy), 1)
    now = (now or datetime.datetime.now(datetime.timezone.utc)).replace(microsecond=0)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    load = (parsed or {}).get("load") or {}
    vals = {**c, "ctx_ps": c.get("context_switches_per_s"), "intr_ps": c.get("interrupts_per_s"),
            "runnable": c.get("runnable_tasks"), "load1": load.get("one"), "load5": load.get("five"), "load15": load.get("fifteen")}
    cli = _client()
    try:
        ensure_tables(cli)
        row = [now, int(server_id), plat] + [(_f(vals.get(k)) if "Float" in t else _u(vals.get(k))) for k, t in HOST_COLS]
        cli.insert(HOST_T, [row], column_names=["ts", "server_id", "platform"] + [k for k, _ in HOST_COLS])
        if plat == "linux":
            procs = parsed.get("procs_now") or []
        else:   # the Windows collector's processes ARE a short current sample
            procs = [p for p in (parsed.get("processes") or []) if isinstance(p.get("cpu"), (int, float))]
        procs = [p for p in procs if p.get("pid") is not None][:15]
        if procs:
            rows = [[now, int(server_id), plat, _u(p["pid"]) or 0, str(p.get("command") or p.get("name") or "?")[:120],
                     float(p.get("cpu") or 0), _f(p.get("mem")), _u(p.get("threads")),
                     (str(p["user"])[:120] if p.get("user") else None), _u(p.get("running_s")),
                     _f(p.get("cpu_user")), _f(p.get("cpu_kernel")), _u(p.get("ppid"))] for p in procs]
            cli.insert(PROC_T, rows, column_names=["ts", "server_id", "platform"] + [k for k, _ in PROC_COLS])
        return "ok"
    except Exception:
        mark_down()
        raise


def _q(sql, params):
    cli = _client()
    try:
        ensure_tables(cli)
        r = cli.query(sql, parameters=params)
        return [dict(zip(r.column_names, row)) for row in r.result_rows]
    except Exception as e:  # noqa: BLE001
        raise MemoryHistoryUnavailable(f"ClickHouse query failed: {type(e).__name__}") from e


def _ms(ts):
    return int(ts.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000) if ts.tzinfo is None else int(ts.timestamp() * 1000)


def category_history(server_id, minutes=60, bucket=60):
    minutes, bucket = max(5, min(int(minutes), 10080)), max(15, min(int(bucket), 3600))
    rows = _q(f"""SELECT toStartOfInterval(ts, toIntervalSecond({{b:UInt32}})) AS t,
                    avg(user_pct) AS user, avg(system_pct) AS system, avg(iowait_pct) AS iowait, avg(irq_pct) AS irq,
                    avg(steal_pct) AS steal, avg(idle_pct) AS idle, avg(busy_pct) AS busy, count() AS n
                  FROM {HOST_T} WHERE server_id = {{s:UInt32}} AND ts >= now() - toIntervalMinute({{m:UInt32}})
                  GROUP BY t ORDER BY t""", {"s": int(server_id), "m": minutes, "b": bucket})
    return [{"t": _ms(r["t"]), **{k: (round(r[k], 2) if r[k] is not None else None) for k in ("user", "system", "iowait", "irq", "steal", "idle", "busy")}}
            for r in rows]


def processes_at(server_id, at_ms, tolerance_s=180):
    """The stored top-CPU set closest to `at_ms` (within tolerance)."""
    at_s, tol = int(at_ms) // 1000, int(tolerance_s)
    hit = _q(f"""SELECT toUnixTimestamp(ts) AS u FROM {PROC_T} WHERE server_id = {{s:UInt32}}
                   AND ts BETWEEN toDateTime({{lo:UInt32}}, 'UTC') AND toDateTime({{hi:UInt32}}, 'UTC')
                 GROUP BY u ORDER BY abs(toInt64(u) - {{at:Int64}}) LIMIT 1""",
             {"s": int(server_id), "lo": at_s - tol, "hi": at_s + tol, "at": at_s})
    if not hit:
        return {"ts": None, "processes": []}
    u = int(hit[0]["u"])
    rows = _q(f"""SELECT pid, name, cpu_pct, mem_pct, threads, user_name, running_s, platform, user_cpu_pct, kernel_cpu_pct, ppid FROM {PROC_T}
                  WHERE server_id = {{s:UInt32}} AND ts = toDateTime({{u:UInt32}}, 'UTC') ORDER BY cpu_pct DESC""",
              {"s": int(server_id), "u": u})
    return {"ts": u * 1000, "processes": rows}


def process_trend(server_id, pid, minutes=60, bucket=60):
    """CPU / memory of one process over time, only from the collections where it was in the top 15."""
    minutes, bucket = max(5, min(int(minutes), 10080)), max(15, min(int(bucket), 3600))
    rows = _q(f"""SELECT toStartOfInterval(ts, toIntervalSecond({{b:UInt32}})) AS t, avg(cpu_pct) AS cpu, avg(mem_pct) AS mem,
                    max(threads) AS threads, any(name) AS name
                  FROM {PROC_T} WHERE server_id = {{s:UInt32}} AND pid = {{p:UInt32}} AND ts >= now() - toIntervalMinute({{m:UInt32}})
                  GROUP BY t ORDER BY t""", {"s": int(server_id), "p": int(pid), "m": minutes, "b": bucket})
    return [{"t": _ms(r["t"]), "cpu": round(r["cpu"], 2), "mem": (round(r["mem"], 2) if r["mem"] is not None else None),
             "threads": r["threads"], "name": r["name"]} for r in rows]
