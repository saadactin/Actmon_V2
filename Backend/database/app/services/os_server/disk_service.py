"""
Disk Consumption page — reads over {CH_DB}.host_fs_usage (one row per filesystem per collection).

"Busiest" = the fullest filesystem at each collection (max use_pct) — the same figure the dashboard ranks hosts by
(OsServer.disk_usage). Growth and "days until full" are a straight-line estimate from the first and last stored
sample of that filesystem in the range; they are labelled estimates and only given when the samples span ≥ 30 min and
usage actually grew. All queries are parameterised and filtered on the already-authorised server_id.
"""
from app.services.clickhouse import memory_history_service as mh
from app.services.os_server.memory_service import BadRequest, _bucket_expr, _clean, validate

FS = mh.FS_T


def _per_ts(extra=""):
    return f"""SELECT ts, max(use_pct) AS busiest, sum(used_bytes) AS used, sum(size_bytes) AS size, count() AS fs
               FROM {FS} WHERE server_id = {{sid:UInt32}} {extra} GROUP BY ts"""


def history(sid, minutes, bucket):
    validate(minutes, bucket)
    rows = mh.query_fs(f"""
        SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, avg(busiest) AS busiest, avg(used) AS used_bytes, avg(size) AS size_bytes
        FROM ({_per_ts("AND ts >= now() - INTERVAL {m2:UInt32} MINUTE")}) GROUP BY t ORDER BY t LIMIT {2 * 5000}""",
        {"sid": sid, "m2": minutes * 2, "b": bucket or 1})
    return [_clean(r) for r in rows]


def stats(sid, minutes):
    out = {}
    for key, (a, b) in {"current": (minutes, 0), "previous": (minutes * 2, minutes)}.items():
        r = mh.query_fs(f"""
            SELECT count() AS n, avg(busiest) AS avg, max(busiest) AS max, toUnixTimestamp(argMax(ts, busiest)) * 1000 AS max_t,
                   min(busiest) AS min, toUnixTimestamp(argMin(ts, busiest)) * 1000 AS min_t,
                   toUnixTimestamp(min(ts)) * 1000 AS first_t, toUnixTimestamp(max(ts)) * 1000 AS last_t
            FROM ({_per_ts("AND ts >= now() - INTERVAL {a:UInt32} MINUTE AND ts < now() - INTERVAL {b:UInt32} MINUTE")})""",
            {"sid": sid, "a": a, "b": b})
        r = _clean(r[0]) if r else {"n": 0}
        out[key] = r if r.get("n") else None
    return out


def mounts(sid, minutes):
    """Per filesystem over the range: latest values, peak, growth and a labelled straight-line estimate."""
    rows = mh.query_fs(f"""
        SELECT mount, any(fstype) AS fstype, count() AS n,
          toUnixTimestamp(min(ts)) * 1000 AS first_t, toUnixTimestamp(max(ts)) * 1000 AS last_t,
          argMax(use_pct, ts) AS l_use_pct, max(use_pct) AS max_pct, argMax(size_bytes, ts) AS l_size_bytes,
          argMax(used_bytes, ts) AS l_used_bytes, argMax(avail_bytes, ts) AS l_avail_bytes, argMax(inode_pct, ts) AS l_inode_pct,
          argMin(used_bytes, ts) AS first_used, argMin(use_pct, ts) AS first_pct
        FROM {FS} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE
        GROUP BY mount ORDER BY l_use_pct DESC LIMIT 60""", {"sid": sid, "m": minutes})
    out = []
    for r in rows:
        # "l_" aliases (latest value) avoid ClickHouse resolving max(use_pct) to the argMax alias
        r = {(k[2:] if k.startswith("l_") else k): v for k, v in _clean(r).items()}
        span_h = ((r["last_t"] or 0) - (r["first_t"] or 0)) / 3_600_000
        growth = (r["used_bytes"] - r["first_used"]) if r.get("used_bytes") is not None and r.get("first_used") is not None else None
        r["growth_bytes"] = growth
        r["growth_pct_pts"] = round(r["use_pct"] - r["first_pct"], 2) if r.get("first_pct") is not None else None
        r["rate_bytes_per_day"] = round(growth / span_h * 24) if growth is not None and span_h >= 0.5 else None
        r["days_to_full_estimate"] = (round(r["avail_bytes"] / r["rate_bytes_per_day"], 1)
                                      if r["rate_bytes_per_day"] and r["rate_bytes_per_day"] > 0 and r.get("avail_bytes") is not None else None)
        out.append(r)
    return out


def mount_history(sid, mount, minutes, bucket):
    validate(minutes, bucket)
    if not mount or len(mount) > 200:
        raise BadRequest("mount is required (max 200 characters)")
    rows = mh.query_fs(f"""
        SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, avg(use_pct) AS use_pct, avg(used_bytes) AS used_bytes,
               avg(size_bytes) AS size_bytes, avg(inode_pct) AS inode_pct
        FROM {FS} WHERE server_id = {{sid:UInt32}} AND mount = {{mount:String}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE
        GROUP BY t ORDER BY t LIMIT 5000""", {"sid": sid, "mount": mount, "m": minutes, "b": bucket or 1})
    return [_clean(r) for r in rows]


def net_history(sid, minutes, bucket):
    """Total host throughput (bytes/s, receive + transmit) from host_net_metrics, 2x the window like the others."""
    validate(minutes, bucket)
    mh.query_fs("SELECT 1", {})  # ensures the shared tables/database exist before the first read
    try:
        rows = mh.query(f"""
            SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, avg(rx_bps) AS rx_bps, avg(tx_bps) AS tx_bps
            FROM {mh.NET_T} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m2:UInt32}} MINUTE
            GROUP BY t ORDER BY t LIMIT 10000""", {"sid": sid, "m2": minutes * 2, "b": bucket or 1})
    except mh.MemoryHistoryUnavailable as e:
        # the table is created on the first network write; before that there is simply no history yet
        if "UNKNOWN_TABLE" in str(e.__cause__) or "doesn't exist" in str(e.__cause__):
            return []
        raise
    return [_clean(r) for r in rows]
