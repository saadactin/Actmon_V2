"""
Memory pages (Memory Analysis / Memory Pressure) — reads over the ClickHouse memory history.

Every function takes a server_id the route has ALREADY resolved through the org-scoped host lookup, and every query
filters on that server_id, so data from another host can never be returned. All SQL is parameterised.

Definitions (see infra_detail_service mem_detail):
  used_pct        (total - available) / total             — memory utilisation, OS-reported components
  pressure_score  max(100 - available %, commit charge %)  — CALCULATED score, not an OS metric (Linux: commit only
                  in strict overcommit mode). Linux PSI (psi_some_avg10) is the OS-native stall metric, shown apart.
Events: derived from the stored pressure samples with hysteresis (enter at the threshold, leave HYSTERESIS points
below it), so a value hovering at a boundary yields one event, not a flood. Nothing is invented: no samples → no events.
"""
import os
import time

from app.services.clickhouse import memory_history_service as mh

ALLOWED_MINUTES = (15, 30, 60, 360, 1440, 10080)
ALLOWED_BUCKETS = (0, 60, 300, 900, 3600)           # 0 = raw samples
MAX_POINTS = 5000
THRESHOLDS = [  # (level, min score) — highest first; override with MEMORY_PRESSURE_THRESHOLDS="60,75,90"
    ("Critical", 90.0), ("High", 75.0), ("Warning", 60.0)]
_t = os.getenv("MEMORY_PRESSURE_THRESHOLDS")
if _t:
    try:
        w, h, c = (float(x) for x in _t.split(","))
        THRESHOLDS = [("Critical", c), ("High", h), ("Warning", w)]
    except ValueError:
        pass
HYSTERESIS = float(os.getenv("MEMORY_PRESSURE_HYSTERESIS", "5") or 5)
SNAPSHOT_TOLERANCE_S = int(os.getenv("MEMORY_SNAPSHOT_TOLERANCE_S", "90") or 90)

H, P = mh.HOST_T, mh.PROC_T
NUM = [c for c, _ in mh.HOST_COLS]


class BadRequest(ValueError):
    pass


def validate(minutes, bucket):
    if minutes not in ALLOWED_MINUTES:
        raise BadRequest(f"minutes must be one of {ALLOWED_MINUTES}")
    if bucket not in ALLOWED_BUCKETS:
        raise BadRequest(f"bucket must be one of {ALLOWED_BUCKETS}")
    if bucket == 0 and minutes > 360:
        raise BadRequest("raw samples are limited to ranges of 6 hours or less")
    if bucket and minutes * 60 * 2 / bucket > MAX_POINTS:
        raise BadRequest("too many points for this range; choose a larger aggregation interval")


def _bucket_expr(bucket):
    return "ts" if not bucket else "toStartOfInterval(ts, INTERVAL {b:UInt32} SECOND)"


def history(sid, minutes, bucket):
    """2x the window (current + previous period) so the page can compare periods. Epoch-ms timestamps."""
    validate(minutes, bucket)
    cols = ", ".join(f"avg({c}) AS {c}" for c in NUM)
    rows = mh.query(f"""
        SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, {cols}, count() AS n
        FROM {H} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m2:UInt32}} MINUTE
        GROUP BY t ORDER BY t LIMIT {MAX_POINTS * 2}""", {"sid": sid, "m2": minutes * 2, "b": bucket or 1})
    return [_clean(r) for r in rows]


def _clean(r):
    out = {}
    for k, v in r.items():
        if isinstance(v, float):
            v = None if v != v else round(v, 2)
        out[k] = v
    return out


def stats(sid, minutes):
    """Real min/avg/peak over RAW samples for the current and the previous period."""
    out = {}
    for key, (a, b) in {"current": (minutes, 0), "previous": (minutes * 2, minutes)}.items():
        rows = mh.query(f"""
            SELECT count() AS n,
              avg(used_pct) AS used_avg, max(used_pct) AS used_max, toUnixTimestamp(argMax(ts, used_pct)) * 1000 AS used_max_t,
              min(used_pct) AS used_min, toUnixTimestamp(argMin(ts, used_pct)) * 1000 AS used_min_t,
              avg(pressure_score) AS pr_avg, max(pressure_score) AS pr_max, toUnixTimestamp(argMax(ts, pressure_score)) * 1000 AS pr_max_t,
              min(pressure_score) AS pr_min, toUnixTimestamp(argMin(ts, pressure_score)) * 1000 AS pr_min_t,
              min(available_bytes) AS avail_min, toUnixTimestamp(argMin(ts, available_bytes)) * 1000 AS avail_min_t,
              max(swap_used_bytes) AS swap_used_max, toUnixTimestamp(argMax(ts, swap_used_bytes)) * 1000 AS swap_used_max_t,
              argMax(swap_total_bytes, ts) AS swap_total, max(major_faults_ps) AS major_max, avg(major_faults_ps) AS major_avg,
              max(page_faults_ps) AS faults_max, avg(page_faults_ps) AS faults_avg,
              argMax(total_bytes, ts) AS total, avg(available_bytes) AS avail_avg, argMax(available_bytes, ts) AS avail_last,
              avg(cached_bytes) AS cached_avg, max(committed_bytes) AS commit_max, argMax(commit_limit_bytes, ts) AS commit_limit,
              avg(psi_some_avg10) AS psi_some_avg, max(psi_some_avg10) AS psi_some_max, max(psi_full_avg10) AS psi_full_max,
              avg(swap_in_ps) AS swapin_avg, max(swap_in_ps) AS swapin_max, avg(swap_out_ps) AS swapout_avg,
              avg(pages_ps) AS pages_avg, max(pages_ps) AS pages_max, argMax(platform, ts) AS platform,
              toUnixTimestamp(min(ts)) * 1000 AS first_t, toUnixTimestamp(max(ts)) * 1000 AS last_t
            FROM {H} WHERE server_id = {{sid:UInt32}}
              AND ts >= now() - INTERVAL {{a:UInt32}} MINUTE AND ts < now() - INTERVAL {{b:UInt32}} MINUTE""",
            {"sid": sid, "a": a, "b": b})
        r = _clean(rows[0]) if rows else {"n": 0}
        out[key] = r if r.get("n") else None
    return out


def snapshot_at(sid, at_ms, tolerance_s=None):
    """Host memory row + process rows at the stored collection nearest to at_ms, within the tolerance only."""
    tol = int(tolerance_s or SNAPSHOT_TOLERANCE_S)
    at_s = int(at_ms // 1000)
    near = mh.query(f"""
        SELECT ts, toUnixTimestamp(ts) * 1000 AS t FROM {P}
        WHERE server_id = {{sid:UInt32}} AND ts BETWEEN toDateTime({{lo:UInt32}}, 'UTC') AND toDateTime({{hi:UInt32}}, 'UTC')
        GROUP BY ts ORDER BY abs(toInt64(toUnixTimestamp(ts)) - {{at:Int64}}) LIMIT 1""",
        {"sid": sid, "lo": at_s - tol, "hi": at_s + tol, "at": at_s})
    if not near:
        return {"requested_t": at_ms, "tolerance_s": tol, "sample_t": None, "host": None, "processes": []}
    t = near[0]["t"]
    procs = mh.query(f"""
        SELECT pid, toUnixTimestamp(start_time) * 1000 AS start_t, name, ws_bytes, private_bytes, commit_bytes, peak_ws_bytes,
               mem_pct, cpu_pct, threads, user_name, status, path
        FROM {P} WHERE server_id = {{sid:UInt32}} AND ts = toDateTime({{s:UInt32}}, 'UTC') ORDER BY ws_bytes DESC LIMIT 50""",
        {"sid": sid, "s": t // 1000})
    host = mh.query(f"""
        SELECT toUnixTimestamp(ts) * 1000 AS t, {", ".join(NUM)} FROM {H}
        WHERE server_id = {{sid:UInt32}} AND ts BETWEEN toDateTime({{lo:UInt32}}, 'UTC') AND toDateTime({{hi:UInt32}}, 'UTC')
        ORDER BY abs(toInt64(toUnixTimestamp(ts)) - {{at:Int64}}) LIMIT 1""",
        {"sid": sid, "lo": t // 1000 - tol, "hi": t // 1000 + tol, "at": t // 1000})
    for p in procs:
        if p.get("start_t") == 0:
            p["start_t"] = None
    return {"requested_t": at_ms, "tolerance_s": tol, "sample_t": t, "host": _clean(host[0]) if host else None,
            "processes": [_clean(p) for p in procs]}


def process_history(sid, pid, name, start_ms, minutes, bucket):
    """One process instance: same PID AND name AND (when known) start time ±5 s, so a reused PID is not merged."""
    validate(minutes, bucket)
    cond, params = "", {"sid": sid, "pid": pid, "name": name, "m": minutes, "b": bucket or 1}
    if start_ms:
        cond = "AND abs(toInt64(toUnixTimestamp(start_time)) - {st:Int64}) <= 5"
        params["st"] = int(start_ms // 1000)
    rows = mh.query(f"""
        SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, avg(ws_bytes) AS ws_bytes, avg(private_bytes) AS private_bytes,
               max(peak_ws_bytes) AS peak_ws_bytes, avg(cpu_pct) AS cpu_pct, avg(mem_pct) AS mem_pct, avg(threads) AS threads
        FROM {P} WHERE server_id = {{sid:UInt32}} AND pid = {{pid:UInt32}} AND name = {{name:String}} {cond}
          AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE
        GROUP BY t ORDER BY t LIMIT {MAX_POINTS}""", params)
    return [_clean(r) for r in rows]


def top_timeline(sid, minutes, bucket, n=5):
    """Top-n process NAMES by average working set over the range (instances of one name summed per sample).
    Only the top 15 per collection are stored, so a process outside them has a gap there — never a zero."""
    validate(minutes, bucket)
    n = max(1, min(10, int(n)))
    base = f"""SELECT ts, name, sum(ws_bytes) AS ws FROM {P}
               WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE GROUP BY ts, name"""
    p = {"sid": sid, "m": minutes, "b": bucket or 1}
    names = [r["name"] for r in mh.query(f"SELECT name, avg(ws) AS a FROM ({base}) GROUP BY name ORDER BY a DESC LIMIT {n}", p)]
    if not names:
        return {"names": [], "points": []}
    rows = mh.query(f"""
        SELECT toUnixTimestamp({_bucket_expr(bucket)}) * 1000 AS t, name, avg(ws) AS ws FROM ({base})
        WHERE name IN {{names:Array(String)}} GROUP BY t, name ORDER BY t LIMIT {MAX_POINTS * 10}""", {**p, "names": names})
    by = {}
    for r in rows:
        by.setdefault(r["t"], {"t": r["t"]})[r["name"]] = round(r["ws"]) if r["ws"] == r["ws"] else None
    return {"names": names, "points": [by[k] for k in sorted(by)]}


def _level(v):
    for name, thr in THRESHOLDS:
        if v >= thr:
            return name
    return "Normal"


def events_from(series):
    """[(t_ms, score)] → level-change events with hysteresis. Pure: unit-tested."""
    order = ["Normal"] + [n for n, _ in reversed(THRESHOLDS)]
    thr = {n: t for n, t in THRESHOLDS}
    cur, out = None, []
    for t, v in series:
        if v is None:
            continue
        lv = _level(v)
        if cur is None:
            cur = lv
            continue
        if order.index(lv) > order.index(cur):
            cur = lv
            out.append({"t": t, "level": lv, "value": round(v, 1), "threshold": thr[lv],
                        "message": f"Memory pressure reached {v:.1f}% ({lv} ≥ {thr[lv]:g}%)"})
        elif order.index(lv) < order.index(cur):
            # leave the current level only once clearly below it
            while cur != "Normal" and v < thr[cur] - HYSTERESIS:
                cur = order[order.index(cur) - 1]
            if cur == "Normal" and out and out[-1]["level"] != "Info":
                out.append({"t": t, "level": "Info", "value": round(v, 1), "threshold": thr["Warning"] - HYSTERESIS,
                            "message": f"Memory pressure normalized ({v:.1f}%)"})
    return out


def duration_above(series, threshold):
    """Seconds the score spent ≥ threshold: each sample counts until the next one, gaps capped at 2x the median step."""
    pts = [(t, v) for t, v in series if v is not None]
    if len(pts) < 2:
        return 0, None, None
    steps = sorted(b[0] - a[0] for a, b in zip(pts, pts[1:]))
    cap = steps[len(steps) // 2] * 2
    total, first, last = 0, None, None
    for (t, v), (t2, _) in zip(pts, pts[1:]):
        if v >= threshold:
            total += min(t2 - t, cap)
            first = first or t
            last = t2
    return total // 1000, first, last


def leaks(sid, minutes):
    """Suspected leaks (heuristic, NOT proof): one process instance whose private memory (or working set when private
    is not collected) grew steadily — correlation with time ≥ 0.9, +20% and +100 MB over ≥ 20 samples covering ≥ half the
    range."""
    rows = mh.query(f"""
        SELECT pid, name, toUnixTimestamp(any(start_time)) * 1000 AS start_t, count() AS n,
          toUnixTimestamp(min(ts)) * 1000 AS first_t, toUnixTimestamp(max(ts)) * 1000 AS last_t,
          argMin(coalesce(private_bytes, ws_bytes), ts) AS first_b, argMax(coalesce(private_bytes, ws_bytes), ts) AS last_b,
          corr(toFloat64(toUnixTimestamp(ts)), toFloat64(coalesce(private_bytes, ws_bytes))) AS r,
          if(countIf(private_bytes IS NOT NULL) > 0, 'private', 'working set') AS basis
        FROM {P} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE
        GROUP BY pid, name, toStartOfMinute(start_time) HAVING n >= 20 ORDER BY last_b - first_b DESC LIMIT 200""",
        {"sid": sid, "m": minutes})
    out = []
    for r in rows:
        span = (r["last_t"] - r["first_t"]) / 60000
        grow = (r["last_b"] or 0) - (r["first_b"] or 0)
        if r["first_b"] and r["r"] == r["r"] and r["r"] >= 0.9 and grow >= 100 * 1048576 and grow / r["first_b"] >= 0.2 and span >= minutes / 2:
            out.append({**_clean(r), "growth_bytes": grow, "growth_pct": round(100 * grow / r["first_b"], 1),
                        "rate_bytes_per_h": round(grow / (span / 60)) if span else None})
    return out[:20]


def analysis(sid, minutes, bucket, threshold=None):
    validate(minutes, bucket)
    threshold = float(threshold if threshold is not None else dict(THRESHOLDS)["High"])
    st = stats(sid, minutes)
    cur = st["current"]
    eb = 60 if minutes <= 1440 else 300
    series_rows = mh.query(f"""
        SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL {{b:UInt32}} SECOND)) * 1000 AS t, max(pressure_score) AS v
        FROM {H} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE GROUP BY t ORDER BY t""",
        {"sid": sid, "m": minutes, "b": eb if minutes > 60 else 15})
    series = [(r["t"], None if r["v"] != r["v"] else r["v"]) for r in series_rows]
    secs, first, last = duration_above(series, threshold)
    top = mh.query(f"""
        SELECT name, argMax(pid, ws_bytes) AS pid, max(ws_bytes) AS ws_max, toUnixTimestamp(argMax(ts, ws_bytes)) * 1000 AS t,
               avg(mem_pct) AS mem_pct_avg
        FROM {P} WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE
        GROUP BY name ORDER BY ws_max DESC LIMIT 1""", {"sid": sid, "m": minutes})
    lk = leaks(sid, minutes)
    ev = events_from(series)
    consumers = mh.query(f"""
        SELECT name, count(DISTINCT pid) AS instances, avg(mem_pct) AS mem_pct_avg, max(ws_bytes) AS ws_max, any(user_name) AS user_name
        FROM (SELECT name, pid, ts, mem_pct, ws_bytes, user_name FROM {P}
              WHERE server_id = {{sid:UInt32}} AND ts >= now() - INTERVAL {{m:UInt32}} MINUTE)
        GROUP BY name ORDER BY mem_pct_avg DESC LIMIT 8""", {"sid": sid, "m": minutes})
    res = {
        "minutes": minutes, "threshold": threshold, "thresholds": {n: t for n, t in THRESHOLDS}, "hysteresis": HYSTERESIS,
        "event_resolution_s": eb if minutes > 60 else 15, "stats": st,
        "above_threshold": {"seconds": secs, "first_t": first, "last_t": last},
        "top_process": _clean(top[0]) if top else None, "events": list(reversed(ev))[:200], "leaks": lk,
        "consumers": [_clean(c) for c in consumers],
    }
    res["recommendations"] = recommendations(res, minutes)
    from app.services.os_server.memory_rules import CATALOGUE
    res["rule_catalogue"] = [{"rule": r, "name": n, "threshold": t} for r, n, t in CATALOGUE]
    return res


def recommendations(a, minutes):
    """Standard rule catalogue (services/os_server/memory_rules.py)."""
    from app.services.os_server import memory_rules
    return memory_rules.evaluate(a, minutes)


def now_ms():
    return int(time.time() * 1000)
