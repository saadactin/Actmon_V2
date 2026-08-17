"""
Shared MySQL health-score formula — backend mirror of
frontend/src/utils/mysqlHealth.js. Used by mysql_report_service.py so the
PDF/scheduled-email report shows the exact same score the Dashboard/Reports
page renders, per the spec's "use the same health thresholds... do not
create different health logic" requirement.
"""


def compute_health_score(long_running_count: int, conn_pct: float, cache_pct: float) -> int:
    score = 100
    if conn_pct > 90:
        score -= 30
    elif conn_pct > 70:
        score -= 15
    if cache_pct < 80:
        score -= 20
    elif cache_pct < 90:
        score -= 10
    if long_running_count > 5:
        score -= 15
    elif long_running_count > 0:
        score -= 5
    return max(0, score)
