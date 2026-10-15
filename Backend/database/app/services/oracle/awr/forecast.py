"""Forecasts for one database's AWR history — withheld unless the history can
support them, and always shipped with how well the same method did on the past.

Two transparent models (no black boxes, no fitting libraries):

  seasonal-baseline-1  Same window of the day (AWR reports are usually pulled for
                       fixed windows). Forecast = mean of that window's past
                       values; 80% prediction interval from Student-t with the
                       window's own spread. Needs >= 3 values for the window.
  linear-trend-1       Least-squares line over time; t-based prediction
                       interval that widens with distance. Needs >= 6 reports
                       spanning >= 3 days.

Every forecast is backtested by rolling origin (fit on the first k reports,
predict report k+1, ...) and reported with MAE, RMSE, interval coverage, and
the MAE of a naive last-value forecast on the same points — so a model that
cannot beat "same as last time" says so.

The old analyzer's forecaster was not reused: it only accepted 45-75 minute
windows (these reports are 3-4 h), invented a ±20% band when it had <10 points,
and clamped growth to ±5%/day. None of that is data-driven.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from .stats import mann_kendall, mean_sd, ols, t_ppf

SEASONAL = "seasonal-baseline-1"
LINEAR = "linear-trend-1"
LEVEL = 0.8
MIN_PER_WINDOW = 3
MIN_LINEAR_POINTS, MIN_LINEAR_DAYS = 6, 3
MIN_BACKTEST_TRAIN = 6


def window_of(t: datetime) -> str:
    """Window label = start time rounded to the half hour (08:30, 11:30, ...)."""
    minutes = round((t.hour * 60 + t.minute) / 30) * 30 % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _days(t: datetime, origin: datetime) -> float:
    return (t - origin).total_seconds() / 86400


def _seasonal(points, target_time):
    win = window_of(target_time)
    vals = [p["value"] for p in points if window_of(p["time"]) == win]
    if len(vals) < MIN_PER_WINDOW:
        return None
    m, sd = mean_sd(vals)
    half = t_ppf((1 + LEVEL) / 2, len(vals) - 1) * sd * math.sqrt(1 + 1 / len(vals))
    return {"value": m, "low": m - half, "high": m + half, "n": len(vals), "window": win}


def _linear(points, target_time):
    if len(points) < MIN_LINEAR_POINTS:
        return None
    origin = points[0]["time"]
    xs = [_days(p["time"], origin) for p in points]
    if xs[-1] - xs[0] < MIN_LINEAR_DAYS - 1e-9:
        return None
    fit = ols(xs, [p["value"] for p in points])
    if not fit["sxx"] or math.isnan(fit["s"]):
        return None
    x0 = _days(target_time, origin)
    y = fit["intercept"] + fit["slope"] * x0
    half = t_ppf((1 + LEVEL) / 2, fit["n"] - 2) * fit["s"] * math.sqrt(1 + 1 / fit["n"] + (x0 - fit["mean_x"]) ** 2 / fit["sxx"])
    return {"value": y, "low": y - half, "high": y + half, "n": fit["n"], "slope_per_day": fit["slope"]}


MODELS = {SEASONAL: _seasonal, LINEAR: _linear}


def backtest(points: list[dict], model: str) -> dict | None:
    """Rolling origin: for each k >= MIN_BACKTEST_TRAIN, fit on points[:k] and
    predict points[k]. Only steps where the model could produce a forecast count."""
    fn = MODELS[model]
    errs, naive_errs, covered = [], [], 0
    for k in range(MIN_BACKTEST_TRAIN, len(points)):
        pred = fn(points[:k], points[k]["time"])
        if not pred:
            continue
        actual = points[k]["value"]
        errs.append(pred["value"] - actual)
        naive_errs.append(points[k - 1]["value"] - actual)
        covered += pred["low"] <= actual <= pred["high"]
    if len(errs) < 3:
        return None
    return {
        "points": len(errs),
        "mae": sum(abs(e) for e in errs) / len(errs),
        "rmse": math.sqrt(sum(e * e for e in errs) / len(errs)),
        "naive_mae": sum(abs(e) for e in naive_errs) / len(naive_errs),
        "coverage": covered / len(errs),
    }


def next_targets(points: list[dict], count_days: int = 1) -> list[tuple[str, datetime]]:
    """The next occurrence of every window seen in the history (e.g. tomorrow's
    08:30, 11:30 and 14:30), after the latest report."""
    last = max(p["time"] for p in points)
    seen = sorted({window_of(p["time"]) for p in points})
    out = []
    for day in range(1, count_days + 1):
        base = (last + timedelta(days=day)).replace(second=0, microsecond=0)
        for win in seen:
            h, m = map(int, win.split(":"))
            out.append((f"{base:%d %b} {win} window", base.replace(hour=h, minute=m)))
    return out


def forecast_metric(points: list[dict]) -> dict:
    """points: [{"time": datetime, "value": float, "report_id": int}] sorted by time.
    Returns {status: "ok"|"insufficient", ...}. Never manufactures a forecast."""
    points = sorted(points, key=lambda p: p["time"])
    days = len({p["time"].date() for p in points})
    windows = {}
    for p in points:
        windows.setdefault(window_of(p["time"]), []).append(p)
    usable_windows = [w for w, ps in windows.items() if len(ps) >= MIN_PER_WINDOW]

    candidates = {}
    for model in (SEASONAL, LINEAR):
        bt = backtest(points, model)
        if bt:
            candidates[model] = bt
    if not candidates:
        return {
            "status": "insufficient",
            "reason": "Insufficient historical data",
            "detail": (f"{len(points)} report(s) over {days} day(s). Forecasts need either ≥ {MIN_PER_WINDOW} reports of the same "
                       f"time window, or ≥ {MIN_LINEAR_POINTS} reports spanning ≥ {MIN_LINEAR_DAYS} days — plus enough "
                       f"history to backtest the method on ≥ 3 past reports first."),
            "have": {"reports": len(points), "days": days, "windows_with_enough_history": usable_windows},
        }
    model = min(candidates, key=lambda m: candidates[m]["mae"])
    bt = candidates[model]
    preds = []
    for horizon, target in next_targets(points):
        pred = MODELS[model](points, target)
        if pred:
            preds.append({"horizon": horizon, "target_time": target, **pred})
    if not preds:
        return {"status": "insufficient", "reason": "Insufficient historical data",
                "detail": "The selected model could not produce a forecast for the next windows.", "have": {"reports": len(points)}}
    values = [p["value"] for p in points]
    return {
        "status": "ok",
        "model": model,
        "level": LEVEL,
        "backtest": bt,
        "beats_naive": bt["mae"] < bt["naive_mae"],
        "candidates": candidates,
        "trend": mann_kendall(values) if len(values) >= 4 else None,
        "predictions": preds,
        "train_points": len(points),
    }


def time_to_threshold(points: list[dict], threshold: float) -> dict:
    """When would a rising metric cross `threshold`? Only answered when the rise
    is statistically real (Mann-Kendall p < 0.05) over >= 6 reports and 3 days."""
    points = sorted(points, key=lambda p: p["time"])
    values = [p["value"] for p in points]
    days = len({p["time"].date() for p in points})
    if len(points) < MIN_LINEAR_POINTS or days < MIN_LINEAR_DAYS:
        return {"status": "insufficient", "reason": "Insufficient historical data",
                "detail": f"Needs ≥ {MIN_LINEAR_POINTS} reports over ≥ {MIN_LINEAR_DAYS} days; have {len(points)} over {days}."}
    latest, peak = values[-1], max(values)
    if peak >= threshold:
        return {"status": "crossed", "threshold": threshold, "peak": peak}
    mk = mann_kendall(values)
    origin = points[0]["time"]
    fit = ols([_days(p["time"], origin) for p in points], values)
    if mk["p"] >= 0.05 or fit["slope"] <= 0:
        return {"status": "no_upward_trend", "threshold": threshold, "latest": latest, "peak": peak,
                "trend_p": mk["p"], "slope_per_day": fit["slope"]}
    days_from_last = (threshold - (fit["intercept"] + fit["slope"] * _days(points[-1]["time"], origin))) / fit["slope"]
    return {"status": "estimated", "threshold": threshold, "latest": latest, "peak": peak, "slope_per_day": fit["slope"],
            "trend_p": mk["p"], "days_to_threshold": days_from_last,
            "eta": points[-1]["time"] + timedelta(days=days_from_last),
            "method": f"{LINEAR}: least-squares extrapolation of a Mann-Kendall-significant rise (p={mk['p']:.3f})"}
