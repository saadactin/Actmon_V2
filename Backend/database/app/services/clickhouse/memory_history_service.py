"""
Memory history in ClickHouse — host memory components and per-process memory, one row per collection.
=======================================================================================================

  {CH_DB}.host_memory_metrics      one row per host per collection (agents: every ~15 s)
  {CH_DB}.host_process_memory      the top 15 processes by working set / RSS at each collection

Both sorted (server_id, ts) so every read is a host + time-range scan; partitioned by day; TTL configurable:
  MEMORY_CH_TTL_DAYS          default 90   host rows    (~5.8k rows/host/day)
  MEMORY_PROC_CH_TTL_DAYS     default 30   process rows (~86k rows/host/day)
Timestamps are DateTime('UTC') — written as UTC, returned to callers as epoch milliseconds.

Same ClickHouse connection/config as metrics_history_service (actmon_logs settings). Writes report failure to the
caller (never swallowed into a fake success); reads raise MemoryHistoryUnavailable so the API returns a real error.
"""
import datetime
import os
import re

from app.services.clickhouse.metrics_history_service import CH_DB, get_client, mark_down

TTL_DAYS = int(os.getenv("MEMORY_CH_TTL_DAYS", "90") or 90)
PROC_TTL_DAYS = int(os.getenv("MEMORY_PROC_CH_TTL_DAYS", "30") or 30)

HOST_T = f"{CH_DB}.host_memory_metrics"
PROC_T = f"{CH_DB}.host_process_memory"

# (column, ClickHouse type, mem_detail key)
HOST_COLS = [
    ("total_bytes", "Nullable(UInt64)"), ("used_bytes", "Nullable(UInt64)"), ("available_bytes", "Nullable(UInt64)"),
    ("free_bytes", "Nullable(UInt64)"), ("cached_bytes", "Nullable(UInt64)"), ("modified_bytes", "Nullable(UInt64)"),
    ("buffers_bytes", "Nullable(UInt64)"), ("committed_bytes", "Nullable(UInt64)"), ("commit_limit_bytes", "Nullable(UInt64)"),
    ("swap_total_bytes", "Nullable(UInt64)"), ("swap_used_bytes", "Nullable(UInt64)"),
    ("paged_pool_bytes", "Nullable(UInt64)"), ("nonpaged_pool_bytes", "Nullable(UInt64)"),
    ("hardware_reserved_bytes", "Nullable(UInt64)"), ("installed_bytes", "Nullable(UInt64)"),
    ("page_faults_ps", "Nullable(Float64)"), ("major_faults_ps", "Nullable(Float64)"), ("pages_ps", "Nullable(Float64)"),
    ("swap_in_ps", "Nullable(Float64)"), ("swap_out_ps", "Nullable(Float64)"),
    ("psi_some_avg10", "Nullable(Float64)"), ("psi_full_avg10", "Nullable(Float64)"),
    ("used_pct", "Nullable(Float64)"), ("pressure_score", "Nullable(Float64)"),
]
PROC_COLS = [
    ("pid", "UInt32"), ("start_time", "Nullable(DateTime('UTC'))"), ("name", "LowCardinality(String)"),
    ("ws_bytes", "Nullable(UInt64)"), ("private_bytes", "Nullable(UInt64)"), ("commit_bytes", "Nullable(UInt64)"),
    ("peak_ws_bytes", "Nullable(UInt64)"), ("mem_pct", "Nullable(Float64)"), ("cpu_pct", "Nullable(Float64)"),
    ("threads", "Nullable(UInt32)"), ("user_name", "Nullable(String)"), ("status", "LowCardinality(String)"),
    ("path", "Nullable(String)"),
]
_ready = False


class MemoryHistoryUnavailable(Exception):
    pass


def _client():
    cli = get_client()
    if cli is None:
        raise MemoryHistoryUnavailable("ClickHouse is unavailable")
    return cli


def ensure_tables(cli):
    global _ready
    if _ready:
        return
    cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
    cols = ",\n".join(f"{c} {t}" for c, t in HOST_COLS)
    cli.command(f"""CREATE TABLE IF NOT EXISTS {HOST_T} (
        ts DateTime('UTC'), server_id UInt32, agent LowCardinality(String), platform LowCardinality(String),
        {cols}
      ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, ts)
        TTL ts + INTERVAL {TTL_DAYS} DAY""")
    pcols = ",\n".join(f"{c} {t}" for c, t in PROC_COLS)
    cli.command(f"""CREATE TABLE IF NOT EXISTS {PROC_T} (
        ts DateTime('UTC'), server_id UInt32,
        {pcols}
      ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, ts, pid)
        TTL ts + INTERVAL {PROC_TTL_DAYS} DAY""")
    _ready = True


def _u(v):
    try:
        return None if v is None else max(0, int(v))
    except (TypeError, ValueError):
        return None


def _f(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _iso(v):
    if not v:
        return None
    try:
        # Windows "o" format has 7 fractional digits; fromisoformat accepts at most 6 on older Pythons
        txt = re.sub(r"(\.\d{6})\d+", r"\1", str(v).strip().replace("Z", "+00:00"))
        dt = datetime.datetime.fromisoformat(txt)
        return (dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)).astimezone(datetime.timezone.utc)
    except ValueError:
        return None


def write_snapshot(server_id, agent, parsed, now=None):
    """Store one collection. Returns "ok", "skipped" (collector sent no memory detail — old agent script) or
    raises on a ClickHouse failure so the caller can report it."""
    m = (parsed or {}).get("mem_detail")
    if not m:
        return "skipped"
    # tz-AWARE UTC: clickhouse_connect turns a naive datetime into epoch seconds with the CLIENT machine's local
    # zone, which would shift every row by the server's UTC offset.
    now = (now or datetime.datetime.now(datetime.timezone.utc)).replace(microsecond=0)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    cli = _client()
    try:
        ensure_tables(cli)
        row = [now, int(server_id), agent or "", m.get("platform") or ""]
        for c, t in HOST_COLS:
            row.append(_f(m.get(c)) if "Float" in t else _u(m.get(c)))
        cli.insert(HOST_T, [row], column_names=["ts", "server_id", "agent", "platform"] + [c for c, _ in HOST_COLS])
        procs = [p for p in (parsed.get("mem_procs") or []) if p.get("pid") is not None][:15]
        if procs:
            run_start = lambda p: (now - datetime.timedelta(seconds=int(p["running_s"]))) if p.get("running_s") is not None else None  # noqa: E731
            rows = [[now, int(server_id), _u(p["pid"]) or 0, _iso(p.get("start")) or run_start(p), str(p.get("name") or "?")[:120],
                     _u(p.get("ws_bytes")), _u(p.get("private_bytes")), _u(p.get("commit_bytes")), _u(p.get("peak_ws_bytes")),
                     _f(p.get("mem_pct")), _f(p.get("cpu")), _u(p.get("threads")),
                     (str(p["user"])[:120] if p.get("user") else None), str(p.get("status") or "Running")[:32],
                     (str(p["path"])[:400] if p.get("path") else None)] for p in procs]
            cli.insert(PROC_T, rows, column_names=["ts", "server_id"] + [c for c, _ in PROC_COLS])
        return "ok"
    except Exception:
        mark_down()
        raise


# ── reads ───────────────────────────────────────────────────────────────────────────────────────
def query(sql, params):
    cli = _client()
    try:
        ensure_tables(cli)
        r = cli.query(sql, parameters=params)
        return [dict(zip(r.column_names, row)) for row in r.result_rows]
    except Exception as e:  # noqa: BLE001
        raise MemoryHistoryUnavailable(f"ClickHouse query failed: {type(e).__name__}") from e


# ── Filesystem usage (Disk Consumption page) ────────────────────────────────────────────────────
# One row per filesystem per collection. Exact bytes when the collector sends them (Windows Win32_LogicalDisk,
# Linux df -PTB1); otherwise only use_pct (older collectors) — sizes stay NULL, never guessed from "38G" text.
FS_T = f"{CH_DB}.host_fs_usage"
FS_TTL_DAYS = int(os.getenv("DISK_CH_TTL_DAYS", "90") or 90)
_fs_ready = False


def _ensure_fs(cli):
    global _fs_ready
    if _fs_ready:
        return
    ensure_tables(cli)
    cli.command(f"""CREATE TABLE IF NOT EXISTS {FS_T} (
        ts DateTime('UTC'), server_id UInt32, mount String, fstype LowCardinality(String),
        size_bytes Nullable(UInt64), used_bytes Nullable(UInt64), avail_bytes Nullable(UInt64),
        use_pct Float64, inode_pct Nullable(Float64)
      ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, mount, ts)
        TTL ts + INTERVAL {FS_TTL_DAYS} DAY""")
    _fs_ready = True


def write_filesystems(server_id, parsed, now=None):
    fss = [f for f in ((parsed or {}).get("filesystems") or []) if f.get("mount") and f.get("use_pct") is not None]
    # pseudo filesystems carry no capacity information worth a history
    fss = [f for f in fss if str(f.get("fstype") or "").lower() not in ("tmpfs", "devtmpfs", "overlay", "squashfs")
           and not str(f.get("filesystem") or "").startswith(("tmpfs", "devtmpfs", "overlay"))][:40]
    if not fss:
        return "skipped"
    now = (now or datetime.datetime.now(datetime.timezone.utc)).replace(microsecond=0)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    cli = _client()
    try:
        _ensure_fs(cli)
        rows = [[now, int(server_id), str(f["mount"])[:200], str(f.get("fstype") or "")[:32], _u(f.get("size_b")), _u(f.get("used_b")),
                 _u(f.get("avail_b")), float(f.get("use_pct") or 0), _f(f.get("inode_pct"))] for f in fss]
        cli.insert(FS_T, rows, column_names=["ts", "server_id", "mount", "fstype", "size_bytes", "used_bytes", "avail_bytes", "use_pct", "inode_pct"])
        return "ok"
    except Exception:
        mark_down()
        raise


def query_fs(sql, params):
    cli = _client()
    try:
        _ensure_fs(cli)
        r = cli.query(sql, parameters=params)
        return [dict(zip(r.column_names, row)) for row in r.result_rows]
    except Exception as e:  # noqa: BLE001
        raise MemoryHistoryUnavailable(f"ClickHouse query failed: {type(e).__name__}") from e


# ── Network throughput (Infrastructure overview "Network I/O") ──────────────────────────────────────
# Total receive / transmit bytes per second across the host's interfaces, as derived at ingest from two
# consecutive counter snapshots (infra_detail_service._apply_network_rates). Written only when that rate exists.
NET_T = f"{CH_DB}.host_net_metrics"
_net_ready = False


def write_network(server_id, parsed, now=None):
    net = (parsed or {}).get("network") or {}
    ifs = [i for i in (net.get("interfaces") or []) if i.get("rx_bps") is not None or i.get("tx_bps") is not None]
    if not ifs or net.get("rate_interval_s") is None:
        return "skipped"
    global _net_ready
    now = (now or datetime.datetime.now(datetime.timezone.utc)).replace(microsecond=0)
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    cli = _client()
    try:
        if not _net_ready:
            ensure_tables(cli)
            cli.command(f"""CREATE TABLE IF NOT EXISTS {NET_T} (
                ts DateTime('UTC'), server_id UInt32, rx_bps Float64, tx_bps Float64, interval_s Float32, interfaces UInt16
              ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (server_id, ts) TTL ts + INTERVAL {TTL_DAYS} DAY""")
            _net_ready = True
        rx = float(sum(i.get("rx_bps") or 0 for i in ifs))
        tx = float(sum(i.get("tx_bps") or 0 for i in ifs))
        cli.insert(NET_T, [[now, int(server_id), rx, tx, float(net["rate_interval_s"]), len(ifs)]],
                   column_names=["ts", "server_id", "rx_bps", "tx_bps", "interval_s", "interfaces"])
        return "ok"
    except Exception:
        mark_down()
        raise
