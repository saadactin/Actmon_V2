"""
Shared Oracle health-score formula — backend mirror of
frontend/src/utils/oracleHealth.js, so any future server-side consumer
(e.g. a report/email generator) computes the identical score the dashboard
shows, rather than a third divergent implementation.
"""


def compute_instance_health_score(
    session_pct=None, buf_hit_pct=None, max_ts_pct=None, wait_count=None,
    host_cpu_pct=None, rman_failed=None, archive_gap_count=None, invalid_objects_total=None,
) -> int:
    score = 100
    if (session_pct or 0) > 90:
        score -= 25
    elif (session_pct or 0) > 75:
        score -= 12
    if buf_hit_pct is not None and 0 < buf_hit_pct < 80:
        score -= 25
    elif buf_hit_pct is not None and 0 < buf_hit_pct < 90:
        score -= 12
    if (max_ts_pct or 0) > 95:
        score -= 25
    elif (max_ts_pct or 0) > 85:
        score -= 12
    if (host_cpu_pct or 0) > 90:
        score -= 15
    elif (host_cpu_pct or 0) > 75:
        score -= 8
    if (wait_count or 0) > 20:
        score -= 8
    if (rman_failed or 0) > 0:
        score -= 15
    if (archive_gap_count or 0) > 10:
        score -= 20
    elif (archive_gap_count or 0) > 5:
        score -= 10
    if (invalid_objects_total or 0) > 50:
        score -= 10
    return max(0, score)


def cluster_health_from_nodes(nodes: list) -> str:
    """Topology-aware RAC rollup (§23) — mirrors
    oracle_monitoring_service.oracle_rac_nodes()'s own computation and
    frontend/src/utils/oracleHealth.js's clusterHealthFromNodes()."""
    if not nodes:
        return "not_applicable"
    open_count = sum(1 for n in nodes if str(n.get("instance_status") or "").upper() == "OPEN")
    if open_count == len(nodes):
        return "healthy"
    if open_count == 0:
        return "critical"
    return "warning"
