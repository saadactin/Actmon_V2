"""Small, dependency-free statistics for AWR history (no numpy in this venv).

Each function states its assumptions; callers decide whether there is enough
data before using any of them.
"""
from __future__ import annotations

import math
from statistics import NormalDist, median

_N = NormalDist()


def t_ppf(p: float, df: int) -> float:
    """Student-t quantile. Exact for df 1-2; Cornish-Fisher expansion
    (Abramowitz & Stegun 26.7.5) otherwise — within 0.01 of tables for df >= 3."""
    if df < 1:
        raise ValueError("df must be >= 1")
    if df == 1:
        return math.tan(math.pi * (p - 0.5))
    if df == 2:
        return (2 * p - 1) / math.sqrt(2 * p * (1 - p))
    z = _N.inv_cdf(p)
    g1 = (z ** 3 + z) / 4
    g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96
    g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384
    g4 = (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / 92160
    return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4


def mann_kendall(values: list[float]) -> dict:
    """Mann-Kendall monotonic-trend test (normal approximation, no tie
    correction). Returns S, z and two-sided p. Needs n >= 4 to mean anything."""
    n = len(values)
    s = sum((values[j] > values[i]) - (values[j] < values[i]) for i in range(n) for j in range(i + 1, n))
    var = n * (n - 1) * (2 * n + 5) / 18
    z = 0.0 if s == 0 or var == 0 else (s - 1) / math.sqrt(var) if s > 0 else (s + 1) / math.sqrt(var)
    return {"s": s, "z": z, "p": 2 * (1 - _N.cdf(abs(z))), "n": n}


def seasonal_mann_kendall(groups: list[list[float]]) -> dict:
    """Seasonal Kendall test (Hirsch, Slack & Smith 1982): Mann-Kendall within
    each season (here: time-of-day window), S and variances summed. Use it when
    the series has a recurring daily shape — a plain test on the interleaved
    series mistakes the saw-tooth for a trend."""
    s_total, var_total, n_total = 0, 0.0, 0
    for values in groups:
        n = len(values)
        s_total += sum((values[j] > values[i]) - (values[j] < values[i]) for i in range(n) for j in range(i + 1, n))
        var_total += n * (n - 1) * (2 * n + 5) / 18
        n_total += n
    if var_total == 0 or s_total == 0:
        z = 0.0
    else:
        z = (s_total - 1) / math.sqrt(var_total) if s_total > 0 else (s_total + 1) / math.sqrt(var_total)
    return {"s": s_total, "z": z, "p": 2 * (1 - _N.cdf(abs(z))), "n": n_total, "seasons": len(groups)}


def seasonal_sen_slope(groups: list[tuple[list[float], list[float]]]) -> float:
    """Median of within-season pairwise slopes (never across seasons)."""
    slopes = [(ys[j] - ys[i]) / (xs[j] - xs[i])
              for xs, ys in groups for i in range(len(xs)) for j in range(i + 1, len(xs)) if xs[j] != xs[i]]
    return median(slopes) if slopes else 0.0


def theil_sen(xs: list[float], ys: list[float]) -> float:
    """Median of pairwise slopes — robust to the odd outlier window."""
    slopes = [(ys[j] - ys[i]) / (xs[j] - xs[i]) for i in range(len(xs)) for j in range(i + 1, len(xs)) if xs[j] != xs[i]]
    return median(slopes) if slopes else 0.0


def robust_z(value: float, baseline: list[float]) -> float | None:
    """Modified z-score (Iglewicz & Hoaglin): 0.6745 (x - median) / MAD.
    |z| >= 3.5 is the conventional outlier cut. When over half the baseline is
    identical MAD is 0; then the mean absolute deviation is used
    ((x - median) / (1.253314 * MeanAD)). None only for a constant baseline."""
    if len(baseline) < 3:
        return None
    med = median(baseline)
    mad = median(abs(v - med) for v in baseline)
    if mad:
        return 0.6745 * (value - med) / mad
    mean_ad = sum(abs(v - med) for v in baseline) / len(baseline)
    return None if mean_ad == 0 else (value - med) / (1.253314 * mean_ad)


def ols(xs: list[float], ys: list[float]) -> dict:
    """Least-squares line with what a prediction interval needs."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0.0
    intercept = my - slope * mx
    resid = [y - (intercept + slope * x) for x, y in zip(xs, ys)]
    s = math.sqrt(sum(r * r for r in resid) / (n - 2)) if n > 2 else float("nan")
    return {"slope": slope, "intercept": intercept, "s": s, "n": n, "mean_x": mx, "sxx": sxx}


def mean_sd(values: list[float]) -> tuple[float, float]:
    n = len(values)
    m = sum(values) / n
    sd = math.sqrt(sum((v - m) ** 2 for v in values) / (n - 1)) if n > 1 else float("nan")
    return m, sd
