"""
PostgreSQL Performance tab — rate/health computation over postgres_perf_samples.

Single source of truth for turning the collector's RAW cumulative counters
into the things the UI actually shows: per-second rates, a cache-hit
percentage, and a good/warning/critical status per KPI. Every trend chart
and every KPI card on the Performance page reads through this one module —
never a raw pg_stat_* column reaching the frontend directly.

Thresholds are deliberately only applied to the THREE metrics that have a
real, broadly-agreed "good vs bad" number in Postgres operations (cache hit
ratio, rollback rate, connection usage against max_connections) — TPS, I/O
volume and WAL generation vary by orders of magnitude between two entirely
healthy workloads, so grading them against a fixed number would just be
noise dressed up as a verdict. Those stay informational (status 'good'),
matching what any experienced DBA would actually tell you: "the number is
the point, not a red/green light."
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app.database.connection import engine
from app.services.postgres.postgres_monitoring_service import _pg_conn, _rows

# UI range key -> lookback window. The collector samples once every 60s
# (see postgres_perf_collector.INTERVAL_SECONDS), so '1m' will typically
# come back with 0-1 usable intervals — included anyway because the UI asks
# for it; a sparse/near-empty chart at that range is an honest reflection of
# the actual sampling rate, not a bug to paper over with fake density.
_RANGE_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "6h": 360, "24h": 1440}

_RATE_COLUMNS = [
    "xact_commit", "xact_rollback", "blks_read", "blks_hit",
    "tup_fetched", "tup_inserted", "tup_updated", "tup_deleted",
    "buffers_alloc", "buffers_clean", "buffers_backend", "maxwritten_clean",
    "buffers_checkpoint", "checkpoints_timed", "checkpoints_req",
    "checkpoint_write_time", "checkpoint_sync_time",
    "wal_bytes", "wal_records", "wal_write", "wal_sync",
    "wal_write_time", "wal_sync_time", "archived_count", "failed_count",
]


def _fetch_samples(conn_id: int, minutes: int) -> list[dict]:
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT * FROM postgres_perf_samples WHERE connection_id = :cid "
            "AND captured_at >= now() - make_interval(mins => :mins) "
            "ORDER BY captured_at ASC"
        ), {"cid": conn_id, "mins": minutes}).mappings().all()
    return [dict(r) for r in rows]


def _iso(dt) -> str | None:
    """ISO-8601 string for a possibly tz-aware datetime. captured_at is a
    TIMESTAMPTZ column, so psycopg2 hands back an ALREADY-offset-suffixed
    datetime (e.g. ...+00:00) — appending a literal "Z" on top of that (as
    this used to do in two places) produces an invalid double-suffixed
    string like "...+00:00Z" that JS's Date parser silently rejects. Only a
    genuinely naive datetime needs "Z" appended to be unambiguous.

    Some PostgreSQL connections are reached through the agent proxy rather
    than a direct psycopg2 connection, and that path hands timestamp columns
    back as plain strings, not datetime objects — pass those through as-is
    instead of crashing on a missing .isoformat()."""
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    return dt.isoformat() + ("Z" if dt.tzinfo is None else "")


def _rate_row(cur: dict, prev: dict) -> dict | None:
    """One interval's rates between two consecutive raw samples, or None if
    the interval can't be trusted (a NULL flanking either side — the view
    wasn't available on that tick — or a counter that WENT DOWN, meaning
    pg_stat_reset() ran or the server restarted between samples: a negative
    rate is never real, so that interval is a gap, not a value)."""
    dt = (cur["captured_at"] - prev["captured_at"]).total_seconds()
    if dt <= 0:
        return None
    out = {"t": _iso(cur["captured_at"])}
    for col in _RATE_COLUMNS:
        # Postgres NUMERIC columns (wal_bytes, checkpoint/wal write & sync
        # time) come back from psycopg2 as decimal.Decimal — Decimal / float
        # raises TypeError, so normalize both sides to float before the rate
        # math (BIGINT columns arrive as plain int and are unaffected).
        cv, pv = cur.get(col), prev.get(col)
        cv = float(cv) if cv is not None else None
        pv = float(pv) if pv is not None else None
        out[f"{col}_per_sec"] = round((cv - pv) / dt, 4) if (cv is not None and pv is not None and cv >= pv) else None

    br, bh = out.get("blks_read_per_sec"), out.get("blks_hit_per_sec")
    if br is not None and bh is not None and (br + bh) > 0:
        out["cache_hit_pct"] = round((bh / (br + bh)) * 100, 2)
    else:
        out["cache_hit_pct"] = None

    xc, xr = out.get("xact_commit_per_sec"), out.get("xact_rollback_per_sec")
    out["tps"] = round(xc + xr, 4) if xc is not None and xr is not None else None
    out["rollback_pct"] = round((xr / (xc + xr)) * 100, 2) if (xc is not None and xr is not None and (xc + xr) > 0) else None
    return out


def _series(rows: list[dict]) -> list[dict]:
    out = []
    prev = None
    for r in rows:
        if prev is not None:
            point = _rate_row(r, prev)
            if point:
                out.append(point)
        prev = r
    return out


def svc_pg_perf_history(conn_id: int, db, range_key: str) -> dict:
    minutes = _RANGE_MINUTES.get(range_key, 60)
    samples = _fetch_samples(conn_id, minutes)
    points = _series(samples)
    return {
        "status": "success", "range": range_key if range_key in _RANGE_MINUTES else "1h",
        "points": points,
        "sample_count": len(samples),
        "collector_interval_seconds": 60,
    }


def _status(value, good_below=None, warn_below=None, good_above=None, warn_above=None) -> str:
    """Both directions supported since some metrics are 'lower is better'
    (rollback %) and some are 'higher is better' (cache hit %)."""
    if value is None:
        return "unknown"
    if good_below is not None:
        if value <= good_below:
            return "good"
        return "warning" if value <= warn_below else "critical"
    if value >= good_above:
        return "good"
    return "warning" if value >= warn_above else "critical"


def svc_pg_perf_overview(conn_id: int, db) -> dict:
    """The 8 KPI cards on the Performance page — current rate (from the two
    most-recent collector samples), a trend arrow (vs the interval before
    that), a health verdict where one actually means something, and
    'updated Ns ago' so a stale collector never gets shown as if it were
    live."""
    samples = _fetch_samples(conn_id, 10)  # last ~10 collector ticks is plenty for current + previous

    # A single 60s tick is noisy for bursty counters (a quiet minute makes
    # commits/rollbacks/checkpoints legitimately zero, not "unavailable") —
    # span a few ticks (~3 min) so "current" reads as a short recent rate
    # instead of one instant that happens to be idle.
    SPAN = 3

    def _rate_over(rows, end_idx):
        if end_idx is None or end_idx < 1 or end_idx >= len(rows):
            return None
        start_idx = max(0, end_idx - SPAN)
        if start_idx == end_idx:
            return None
        return _rate_row(rows[end_idx], rows[start_idx])

    latest_idx = len(samples) - 1 if samples else None
    latest = _rate_over(samples, latest_idx)
    previous = _rate_over(samples, (latest_idx - SPAN) if latest_idx is not None else None)
    last_sample_at = samples[-1]["captured_at"] if samples else None

    if last_sample_at is not None:
        # captured_at may come back tz-aware in whatever session timezone
        # Postgres is using (not necessarily UTC) — comparing it directly
        # against an aware "now" keeps the true elapsed time regardless of
        # which zone it's labeled in; stripping tzinfo here previously threw
        # away that offset and produced a garbage (often negative) result.
        now = datetime.now(timezone.utc)
        ls = last_sample_at if last_sample_at.tzinfo is not None else last_sample_at.replace(tzinfo=timezone.utc)
        stale_seconds = (now - ls).total_seconds()
    else:
        stale_seconds = None

    def trend(key):
        if not latest or not previous or latest.get(key) is None or previous.get(key) is None:
            return None
        return round(latest[key] - previous[key], 4)

    # Live, non-cumulative facts that don't belong in the sampled-rate table
    # at all — read fresh, every call. Collapsed into ONE round trip (rather
    # than 3 separate connect+query calls) since an agent/tunnel-routed
    # connection pays real per-call latency — see the Query Analysis
    # EXPLAIN+SET LOCAL fix for the same lesson learned earlier this project.
    #
    # This is the ONLY part of this endpoint that touches the target
    # PostgreSQL server directly (every other KPI comes from our own
    # postgres_perf_samples table) — if that server/agent is slow or
    # unreachable, this must never be allowed to block the six other KPIs
    # behind it. Run it on a worker with a hard wall-clock timeout instead of
    # awaiting it inline; on timeout these two fields just come back
    # "unknown" rather than stalling the whole card grid for 30s+ of
    # react-query retries.
    active_sessions = None
    max_connections = None
    connection_pct = None

    def _live_connection_stats():
        _, eng = _pg_conn(conn_id, db)
        r = _rows(eng, (
            "SELECT "
            "  count(*) FILTER (WHERE state != 'idle') AS active_sessions, "
            "  count(*) AS total_backends, "
            "  current_setting('max_connections')::int AS max_connections "
            "FROM pg_stat_activity"
        ))
        if not r:
            return None, None, None
        d = r[0]
        act = int(d.get("active_sessions") or 0)
        mx = int(d.get("max_connections") or 0)
        total = int(d.get("total_backends") or 0)
        pct = round((total / mx) * 100, 1) if mx else None
        return act, mx, pct

    executor = ThreadPoolExecutor(max_workers=1)
    try:
        active_sessions, max_connections, connection_pct = executor.submit(_live_connection_stats).result(timeout=4)
    except Exception:
        pass
    finally:
        executor.shutdown(wait=False)

    cache_hit = latest.get("cache_hit_pct") if latest else None
    rollback_pct = latest.get("rollback_pct") if latest else None
    tps = latest.get("tps") if latest else None
    wal_bytes_per_sec = latest.get("wal_bytes_per_sec") if latest else None
    checkpoints_timed = latest.get("checkpoints_timed_per_sec") if latest else None
    checkpoints_req = latest.get("checkpoints_req_per_sec") if latest else None
    read_io = latest.get("blks_read_per_sec") if latest else None

    def _write_io(row):
        # "Write I/O" has no single pg_stat_database counter — buffers
        # actually reaching disk are the sum of bgwriter/checkpointer/
        # backend-direct writes.
        if not row:
            return None
        parts = [row.get(k) for k in ("buffers_checkpoint_per_sec", "buffers_clean_per_sec", "buffers_backend_per_sec")]
        return round(sum(p for p in parts if p is not None), 4) if any(p is not None for p in parts) else None

    def _combined_io(row):
        if not row:
            return None
        r, w = row.get("blks_read_per_sec"), _write_io(row)
        return round((r or 0) + (w or 0), 4) if (r is not None or w is not None) else None

    write_io = _write_io(latest)
    combined_io = _combined_io(latest)
    combined_io_prev = _combined_io(previous)
    combined_io_trend = round(combined_io - combined_io_prev, 4) if combined_io is not None and combined_io_prev is not None else None

    checkpoint_req_ratio = None
    if checkpoints_timed is not None and checkpoints_req is not None and (checkpoints_timed + checkpoints_req) > 0:
        checkpoint_req_ratio = round((checkpoints_req / (checkpoints_timed + checkpoints_req)) * 100, 1)

    kpis = {
        "cache_hit_ratio": {
            "value": cache_hit, "unit": "%",
            "status": _status(cache_hit, good_above=99, warn_above=90),
            "trend": trend("cache_hit_pct"),
        },
        "tps": {
            "value": tps, "unit": "/sec", "status": "good" if tps is not None else "unknown",
            "trend": trend("tps"),
        },
        "active_sessions": {
            "value": active_sessions, "unit": "", "status": "good" if active_sessions is not None else "unknown",
            "trend": None,
        },
        "wal_generation": {
            "value": wal_bytes_per_sec, "unit": "B/sec", "status": "good" if wal_bytes_per_sec is not None else "unknown",
            "trend": trend("wal_bytes_per_sec"),
        },
        "checkpoints": {
            "value": checkpoint_req_ratio, "unit": "% requested",
            "status": _status(checkpoint_req_ratio, good_below=30, warn_below=60) if checkpoint_req_ratio is not None else "unknown",
            "trend": None,
        },
        "database_io": {
            "value": combined_io, "unit": "blocks/sec", "status": "good" if combined_io is not None else "unknown",
            "trend": combined_io_trend,
            "read": read_io, "write": write_io,
        },
        "rollback_rate": {
            "value": rollback_pct, "unit": "%",
            "status": _status(rollback_pct, good_below=5, warn_below=15),
            "trend": trend("rollback_pct"),
        },
        "connection_usage": {
            "value": connection_pct, "unit": "%",
            "status": _status(connection_pct, good_below=70, warn_below=90) if connection_pct is not None else "unknown",
            "trend": None,
        },
    }

    return {
        "status": "success",
        "kpis": kpis,
        "last_sample_at": _iso(last_sample_at),
        "stale_seconds": round(stale_seconds) if stale_seconds is not None else None,
        "max_connections": max_connections,
    }
