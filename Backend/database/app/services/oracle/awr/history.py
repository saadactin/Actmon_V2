"""Cross-report analysis for ONE database: trends, anomalies, recurring patterns,
SQL regressions, repeated bottlenecks, batch-window correlation, restarts.

Input is the stored history (no AWR parsing here). Every comparison is between
reports of the same database_key; rates are per second, so windows of different
length compare directly. Each check declares its minimum history and returns
nothing — not a guess — below it.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from statistics import median

from .forecast import forecast_metric, time_to_threshold, window_of
from .stats import mann_kendall, robust_z, seasonal_mann_kendall, seasonal_sen_slope, theil_sen

HISTORY_VERSION = "awr-history-1"
MIN_TREND_POINTS = 6
MIN_ANOMALY_BASELINE = 5

# Metrics followed over time, with which direction is bad.
TRACKED = {
    "aas": ("Average active sessions", "up", "workload"),
    "db_cpu_per_s": ("DB CPU per second", "up", "cpu"),
    "host_cpu_busy_pct": ("Host CPU busy %", "up", "cpu"),
    "wait_class_user_i_o_pct": ("User I/O share of DB time", "up", "waits"),
    "wait_class_commit_pct": ("Commit share of DB time", "up", "waits"),
    "wait_class_concurrency_pct": ("Concurrency share of DB time", "up", "waits"),
    "wait_class_application_pct": ("Application (lock) share of DB time", "up", "waits"),
    "log_file_sync_ms": ("Commit latency (ms)", "up", "waits"),
    "single_block_read_ms": ("Single-block read latency (ms)", "up", "io"),
    "hard_parses_per_s": ("Hard parses per second", "up", "parsing"),
    "logical_reads_per_s": ("Logical reads per second", "up", "io"),
    "physical_reads_per_s": ("Physical reads per second", "up", "io"),
    "read_mb_per_s": ("Read throughput (MB/s)", "up", "io"),
    "sessions_end": ("Sessions", "up", "sessions"),
}


def _series(points, key):
    return [{"time": p["begin"], "value": p["metrics"][key], "report_id": p["report_id"]}
            for p in points if key in p["metrics"] and p["begin"]]


def trends(points: list[dict]) -> list[dict]:
    """Trend test + robust slope per tracked metric; called only when p < 0.05
    over >= MIN_TREND_POINTS reports. When the history has a time-of-day shape
    (>= 2 windows with >= 3 reports each) the Seasonal Kendall test and
    seasonal Sen slope are used, so the daily saw-tooth is not read as a trend."""
    out = []
    for key, (label, bad_dir, cat) in TRACKED.items():
        s = _series(points, key)
        if len(s) < MIN_TREND_POINTS:
            continue
        values = [p["value"] for p in s]
        origin = s[0]["time"]
        days = [(p["time"] - origin).total_seconds() / 86400 for p in s]
        by_win = defaultdict(list)
        for d, p in zip(days, s):
            by_win[window_of(p["time"])].append((d, p["value"]))
        seasons = [v for v in by_win.values() if len(v) >= 3]
        if len(seasons) >= 2:
            mk = seasonal_mann_kendall([[y for _, y in v] for v in seasons])
            slope = seasonal_sen_slope([([x for x, _ in v], [y for _, y in v]) for v in seasons])
            method = f"Seasonal Kendall over {len(seasons)} time-of-day windows + seasonal Sen slope"
        else:
            mk, slope, method = mann_kendall(values), theil_sen(days, values), "Mann-Kendall + Theil-Sen slope"
        base = median(values)
        out.append({
            "metric_key": key, "label": label, "category": cat, "n": len(s), "method": method,
            "first": values[0], "latest": values[-1], "median": base, "min": min(values), "max": max(values),
            "slope_per_day": slope, "pct_per_day": (slope / base * 100) if base else None,
            "p_value": mk["p"], "significant": mk["p"] < 0.05,
            "direction": "flat" if mk["p"] >= 0.05 else ("rising" if mk["s"] > 0 else "falling"),
            "worsening": mk["p"] < 0.05 and ((mk["s"] > 0) == (bad_dir == "up")),
            "series": [{"time": p["time"].isoformat(), "value": p["value"], "report_id": p["report_id"]} for p in s],
        })
    return out


def anomalies(points: list[dict]) -> list[dict]:
    """Is the latest report abnormal against its own history? Compared with the
    same time window when that has >= MIN_ANOMALY_BASELINE values (workload is
    seasonal by time of day), otherwise with all earlier reports."""
    if len(points) < MIN_ANOMALY_BASELINE + 1:
        return []
    latest, prior = points[-1], points[:-1]
    win = window_of(latest["begin"])
    out = []
    for key, (label, bad_dir, cat) in TRACKED.items():
        if key not in latest["metrics"]:
            continue
        same = [p["metrics"][key] for p in prior if key in p["metrics"] and window_of(p["begin"]) == win]
        base, scope = (same, f"same {win} window") if len(same) >= MIN_ANOMALY_BASELINE else (
            [p["metrics"][key] for p in prior if key in p["metrics"]], "all earlier reports")
        if len(base) < MIN_ANOMALY_BASELINE:
            continue
        z = robust_z(latest["metrics"][key], base)
        if z is not None and abs(z) >= 3.5:
            out.append({"metric_key": key, "label": label, "category": cat, "value": latest["metrics"][key],
                        "baseline_median": median(base), "baseline_n": len(base), "robust_z": z, "scope": scope,
                        "worse": (z > 0) == (bad_dir == "up"),
                        "report_id": latest["report_id"]})
    return out


def recurring_pattern(points: list[dict], key: str = "aas") -> dict | None:
    """Time-of-day profile. Reported when >= 2 windows each have >= 3 reports,
    with how consistently the busiest window is the busiest on each day."""
    by_win = defaultdict(list)
    for p in points:
        if key in p["metrics"] and p["begin"]:
            by_win[window_of(p["begin"])].append(p)
    usable = {w: ps for w, ps in by_win.items() if len(ps) >= 3}
    if len(usable) < 2:
        return None
    profile = {w: median(p["metrics"][key] for p in ps) for w, ps in usable.items()}
    peak = max(profile, key=profile.get)
    days = defaultdict(dict)
    for w, ps in usable.items():
        for p in ps:
            days[p["begin"].date()][w] = p["metrics"][key]
    full_days = [d for d in days.values() if len(d) == len(usable)]
    peak_days = sum(1 for d in full_days if max(d, key=d.get) == peak)
    others = [v for w, v in profile.items() if w != peak]
    return {
        "metric_key": key, "profile": [{"window": w, "median": profile[w], "n": len(usable[w])} for w in sorted(profile)],
        "peak_window": peak, "peak_median": profile[peak],
        "ratio_to_other_windows": profile[peak] / median(others) if others and median(others) else None,
        "peak_consistency": {"days_peak": peak_days, "days_compared": len(full_days)},
        "recurring": bool(full_days) and peak_days / len(full_days) >= 0.75 and len(full_days) >= 3,
    }


def sql_regressions(points: list[dict], ratio: float = 2.0, min_execs: float = 5, min_prior: int = 2) -> list[dict]:
    """A statement is regressed when its elapsed time per execution in the
    latest report is >= ratio x its median in earlier reports (each with
    >= min_execs executions). Plans are not compared: AWR HTML has no plan hash."""
    if len(points) < min_prior + 1:
        return []
    latest = points[-1]
    out = []
    for sql_id, cur in latest["sql"].items():
        if (cur.get("executions") or 0) < min_execs or not cur.get("elapsed_per_exec_s"):
            continue
        prior = [p["sql"][sql_id]["elapsed_per_exec_s"] for p in points[:-1]
                 if sql_id in p["sql"] and (p["sql"][sql_id].get("executions") or 0) >= min_execs
                 and p["sql"][sql_id].get("elapsed_per_exec_s")]
        if len(prior) < min_prior:
            continue
        base = median(prior)
        if base and cur["elapsed_per_exec_s"] / base >= ratio:
            out.append({"sql_id": sql_id, "module": cur.get("module"), "latest_per_exec_s": cur["elapsed_per_exec_s"],
                        "baseline_per_exec_s": base, "baseline_reports": len(prior),
                        "ratio": cur["elapsed_per_exec_s"] / base, "executions": cur.get("executions"),
                        "report_id": latest["report_id"]})
    return sorted(out, key=lambda r: -r["ratio"])


def sql_ranking(points: list[dict], limit: int = 25) -> list[dict]:
    """Statements ranked by total elapsed time across the history."""
    agg = {}
    for p in points:
        for sql_id, s in p["sql"].items():
            a = agg.setdefault(sql_id, {"sql_id": sql_id, "module": s.get("module"), "text_preview": s.get("text_preview"),
                                        "reports": 0, "elapsed_s": 0.0, "executions": 0.0, "max_pct_db_time": 0.0,
                                        "cpu_pct": [], "io_pct": [], "per_exec": []})
            a["reports"] += 1
            a["elapsed_s"] += s.get("elapsed_s") or 0
            a["executions"] += s.get("executions") or 0
            a["max_pct_db_time"] = max(a["max_pct_db_time"], s.get("pct_db_time") or 0)
            for k, src in (("cpu_pct", "cpu_pct"), ("io_pct", "io_pct"), ("per_exec", "elapsed_per_exec_s")):
                if s.get(src) is not None:
                    a[k].append(s[src])
    rows = []
    for a in agg.values():
        rows.append({**{k: v for k, v in a.items() if k not in ("cpu_pct", "io_pct", "per_exec")},
                     "median_cpu_pct": median(a["cpu_pct"]) if a["cpu_pct"] else None,
                     "median_io_pct": median(a["io_pct"]) if a["io_pct"] else None,
                     "median_per_exec_s": median(a["per_exec"]) if a["per_exec"] else None,
                     "profile": ("CPU-heavy" if a["cpu_pct"] and median(a["cpu_pct"]) >= 80 else
                                 "I/O-heavy" if a["io_pct"] and median(a["io_pct"]) >= 50 else "mixed")})
    return sorted(rows, key=lambda r: -r["elapsed_s"])[:limit]


def repeated_bottlenecks(rule_hits: dict[str, list[int]], total_reports: int, min_reports: int = 4) -> list[dict]:
    """A diagnosis that fires in >= 60% of a database's reports is a standing
    problem, not an incident."""
    if total_reports < min_reports:
        return []
    return [{"rule_id": rule, "reports": len(ids), "of": total_reports, "share": len(ids) / total_reports, "report_ids": ids}
            for rule, ids in rule_hits.items() if len(ids) / total_reports >= 0.6]


def batch_correlation(points: list[dict], top_n: int = 3) -> list[dict]:
    """Modules whose SQL dominates the busiest windows but not the others —
    usually batch / concurrent-manager jobs. Needs >= 8 reports."""
    pts = [p for p in points if "aas" in p["metrics"]]
    if len(pts) < 8:
        return []
    cut = sorted(p["metrics"]["aas"] for p in pts)[int(len(pts) * 0.75)]
    busy = [p for p in pts if p["metrics"]["aas"] >= cut]
    calm = [p for p in pts if p["metrics"]["aas"] < cut]

    def share(group):
        tot = Counter()
        for p in group:
            for s in p["sql"].values():
                if s.get("module") and s.get("pct_db_time"):
                    tot[s["module"]] += s["pct_db_time"]
        return {m: v / len(group) for m, v in tot.items()}

    b, c = share(busy), share(calm)
    rows = [{"module": m, "busy_avg_pct_db_time": v, "other_avg_pct_db_time": c.get(m, 0.0),
             "busy_windows": sorted({window_of(p["begin"]) for p in busy}), "batch_like": ":cp:" in m}
            for m, v in b.items() if v >= 2 and v >= 2 * c.get(m, 0.0)]
    return sorted(rows, key=lambda r: -r["busy_avg_pct_db_time"])[:top_n]


def restarts(points: list[dict]) -> list[dict]:
    out = []
    for prev, cur in zip(points, points[1:]):
        if prev.get("startup") and cur.get("startup") and prev["startup"] != cur["startup"]:
            out.append({"report_id": cur["report_id"], "before": prev["startup"], "after": cur["startup"]})
    return out


def forecasts(points: list[dict], keys=("aas", "host_cpu_busy_pct")) -> dict:
    return {k: forecast_metric(_series(points, k)) for k in keys if _series(points, k)}


def capacity(points: list[dict], num_cpus: float | None) -> dict:
    """Headroom and time-to-threshold for the resources AWR measures. Data
    growth is not measured by AWR (no tablespace sizes), so it is reported as
    unavailable rather than inferred."""
    def latest(key):
        s = _series(points, key)
        return s[-1]["value"] if s else None

    def peak(key):
        s = _series(points, key)
        return max(p["value"] for p in s) if s else None

    out = {
        "cpu": {
            "host_busy_pct": {"latest": latest("host_cpu_busy_pct"), "peak": peak("host_cpu_busy_pct"),
                              "to_80pct": time_to_threshold(_series(points, "host_cpu_busy_pct"), 80.0)},
            "db_cpu_util_pct": {"latest": latest("db_cpu_util_pct"), "peak": peak("db_cpu_util_pct")},
            "num_cpus": num_cpus,
            "aas_vs_cpus": ({"latest_aas": latest("aas"), "peak_aas": peak("aas"),
                             "peak_pct_of_cpus": (peak("aas") or 0) / num_cpus * 100,
                             "to_80pct_of_cpus": time_to_threshold(_series(points, "aas"), 0.8 * num_cpus)}
                            if num_cpus and latest("aas") is not None else None),
        },
        "memory": {k: {"latest": latest(k), "peak": peak(k)} for k in
                   ("sga_used_mb", "pga_alloc_mb", "pga_target_mb", "host_mem_used_by_db_pct", "pga_cache_hit_pct")},
        "sessions": {"latest": latest("sessions_end"), "peak": peak("sessions_end"),
                     "limits": {m: {"latest": latest(m), "peak": peak(m)} for m in
                                sorted({k for p in points for k in p["metrics"] if k.startswith("limit_")})}},
        "io": {k: {"latest": latest(k), "peak": peak(k)} for k in ("read_mb_per_s", "write_mb_per_s", "read_iops", "write_iops")},
        "storage_growth": {"status": "not_available",
                           "reason": "AWR reports do not contain tablespace or datafile sizes, so data growth and "
                                     "time-to-full cannot be estimated from uploaded AWR files."},
    }
    out["memory"]["pga_alloc_pct_of_target"] = (
        {"latest": latest("pga_alloc_mb") / latest("pga_target_mb") * 100}
        if latest("pga_alloc_mb") is not None and latest("pga_target_mb") else None)
    return out
