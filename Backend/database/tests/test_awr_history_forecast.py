"""History, trends, forecasting gates and backtests — pure functions, no DB."""
import math
from datetime import datetime, timedelta

from app.services.oracle.awr import forecast as F
from app.services.oracle.awr import history as H
from app.services.oracle.awr.stats import mann_kendall, robust_z, seasonal_mann_kendall, t_ppf


# ── stats ──────────────────────────────────────────────────────────────────
def test_t_quantiles_match_tables():
    # two-sided 80% / 95% critical values from standard t tables
    for df, p, expected in ((1, 0.9, 3.078), (2, 0.9, 1.886), (4, 0.9, 1.533), (10, 0.975, 2.228), (30, 0.975, 2.042)):
        assert abs(t_ppf(p, df) - expected) < 0.01


def test_mann_kendall_detects_monotonic_rise_and_ignores_noise():
    assert mann_kendall(list(range(10)))["p"] < 0.01
    assert mann_kendall([5, 3, 6, 4, 5, 3, 6, 4])["p"] > 0.2


def test_seasonal_kendall_is_not_fooled_by_a_daily_sawtooth():
    # three windows a day with very different levels, no change across days
    days = [[40, 41, 39, 40, 41], [16, 17, 16, 15, 16], [15, 16, 15, 16, 15]]
    assert seasonal_mann_kendall(days)["p"] > 0.2


def test_robust_z_flags_outlier_only():
    base = [10, 11, 9, 10, 12, 10]
    assert robust_z(30, base) > 3.5
    assert abs(robust_z(10.5, base)) < 1


# ── helpers to build a history ─────────────────────────────────────────────
T0 = datetime(2026, 3, 27, 8, 30)
WINDOWS = (0, 3, 6)  # 08:30, 11:30, 14:30


def history(days=5, level=(40, 17, 16), drift=0.0, extra=None):
    pts, rid = [], 0
    for d in range(days):
        for w, base in zip(WINDOWS, level):
            rid += 1
            t = T0 + timedelta(days=d, hours=w)
            v = base + drift * d + (0.5 if rid % 2 else -0.5)
            pts.append({"report_id": rid, "begin": t, "metrics": {"aas": v, "host_cpu_busy_pct": v / 3, **(extra or {})},
                        "sql": {}, "startup": "01-Mar-26 01:00"})
    return pts


def series(points, key="aas"):
    return [{"time": p["begin"], "value": p["metrics"][key], "report_id": p["report_id"]} for p in points]


# ── forecasting gates ──────────────────────────────────────────────────────
def test_forecast_withheld_for_one_report():
    out = F.forecast_metric(series(history(days=1)[:1]))
    assert out["status"] == "insufficient" and out["reason"] == "Insufficient historical data"


def test_forecast_withheld_when_history_cannot_be_backtested():
    out = F.forecast_metric(series(history(days=2)))  # 6 reports, 2 per window: too little
    assert out["status"] == "insufficient"


def test_forecast_with_enough_history_has_intervals_backtest_and_horizons():
    out = F.forecast_metric(series(history(days=5)))
    assert out["status"] == "ok"
    assert {"mae", "rmse", "naive_mae", "coverage", "points"} <= set(out["backtest"])
    preds = out["predictions"]
    assert [p["horizon"].split()[-2] for p in preds] == ["08:30", "11:30", "14:30"]
    for p in preds:
        assert p["low"] < p["value"] < p["high"]
        assert p["target_time"] > T0 + timedelta(days=4)
    # the seasonal model knows the 08:30 window is the busy one
    assert preds[0]["value"] > preds[1]["value"] * 2


def test_seasonal_model_beats_naive_on_seasonal_data():
    out = F.forecast_metric(series(history(days=5)))
    assert out["model"] == F.SEASONAL and out["beats_naive"]


def test_time_to_threshold_only_for_a_significant_rise():
    flat = F.time_to_threshold(series(history(days=5)), 100)
    assert flat["status"] == "no_upward_trend"
    rising = F.time_to_threshold(series(history(days=6, level=(20, 20, 20), drift=4)), 60)
    assert rising["status"] == "estimated" and rising["days_to_threshold"] > 0 and "Mann-Kendall" in rising["method"]
    assert F.time_to_threshold(series(history(days=1)), 60)["status"] == "insufficient"


# ── history checks ─────────────────────────────────────────────────────────
def test_no_trend_called_on_stable_seasonal_history():
    assert not any(t["significant"] for t in H.trends(history(days=5)) if t["metric_key"] == "aas")


def test_rising_load_is_a_worsening_trend():
    t = next(t for t in H.trends(history(days=5, drift=3)) if t["metric_key"] == "aas")
    assert t["significant"] and t["direction"] == "rising" and t["worsening"] and "Seasonal Kendall" in t["method"]


def test_recurring_peak_window_detected():
    pat = H.recurring_pattern(history(days=5))
    assert pat["recurring"] and pat["peak_window"] == "08:30"
    assert pat["peak_consistency"] == {"days_peak": 5, "days_compared": 5}


def test_sql_regression_needs_history_and_a_real_slowdown():
    pts = history(days=3)
    for i, p in enumerate(pts):
        p["sql"]["abc"] = {"executions": 50, "elapsed_per_exec_s": 6.0 + (i % 2) * 0.5, "module": "m"}
    assert H.sql_regressions(pts) == []
    pts[-1]["sql"]["abc"]["elapsed_per_exec_s"] = 60.0
    reg = H.sql_regressions(pts)
    assert reg[0]["sql_id"] == "abc" and reg[0]["ratio"] >= 9
    # too few executions now: not judged
    pts[-1]["sql"]["abc"]["executions"] = 2
    assert H.sql_regressions(pts) == []


def test_anomaly_in_bad_direction_is_flagged_as_worse():
    pts = history(days=6)
    pts[-1]["metrics"]["aas"] = 200.0
    a = next(a for a in H.anomalies(pts) if a["metric_key"] == "aas")
    assert a["worse"] and a["robust_z"] > 3.5


def test_restart_between_reports_detected():
    pts = history(days=2)
    pts[-1]["startup"] = "30-Mar-26 02:00"
    assert H.restarts(pts)[0]["report_id"] == pts[-1]["report_id"]


def test_storage_growth_is_reported_unavailable_not_inferred():
    cap = H.capacity(history(days=5), num_cpus=16)
    assert cap["storage_growth"]["status"] == "not_available"
    assert math.isclose(cap["cpu"]["aas_vs_cpus"]["peak_pct_of_cpus"], max(p["metrics"]["aas"] for p in history(days=5)) / 16 * 100)


def test_robust_z_still_works_when_most_of_the_baseline_is_identical():
    assert robust_z(200, [16, 16, 16, 17, 16]) > 3.5  # MAD = 0 -> mean-absolute-deviation fallback
    assert robust_z(16, [16, 16, 16, 16, 16]) is None  # constant baseline: undefined, not a false alarm
