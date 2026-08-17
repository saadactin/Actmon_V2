"""
Shared alert-detection logic, extracted from routes/alerts/alert_routes.py so
it has exactly one implementation used by both:
  - the live GET /alerts/active read endpoint (unchanged behaviour), and
  - the new background evaluator (services/alerts/alert_evaluator_service.py),
    which additionally tracks persistent firing state so duration_seconds/
    cooldown_seconds are actually enforced and a real breach triggers a
    notification exactly once per transition, not once per poll.
"""

_NUMERIC_HOST = {"cpu": "cpu_usage", "memory": "ram_usage", "disk": "disk_usage"}
_UNIT = {"cpu": "%", "memory": "%", "disk": "%"}
_OPSYM = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "eq": "="}


def pct(v):
    try:
        return float(str(v).replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def cmp(val, op, thr):
    return {
        "gt": val > thr, "gte": val >= thr,
        "lt": val < thr, "lte": val <= thr, "eq": val == thr,
    }.get(op, False)


def techs_of(server):
    svcs = server.database_services or []
    return ", ".join(svcs) if svcs else ""


def stopped_instances(server):
    """The specific DatabaseInstance row(s) currently Stopped — what a
    "Database Service Down" notification should name, instead of every
    technology installed on the host (techs_of)."""
    return [i for i in (server.db_instances or []) if (i.status or "") == "Stopped"]


def applies(rule, server):
    st = rule.scope_type
    if st == "all":
        return True
    if st == "technology":
        svcs = [str(s).lower() for s in (server.database_services or [])]
        v = (rule.scope_value or "").lower()
        return any(s in ("mysql", "mariadb") for s in svcs) if v == "mysql" else v in svcs
    if st == "server":
        return server.server_name == rule.scope_value
    return False  # agent / account scopes are not host-based


def infer_metric(message):
    """Best-effort map a collector notification message → (metric_id, short label)
    so the feed can show a sensible icon/section for real alerts."""
    m = (message or "").lower()
    # Oracle RAC/Data-Guard/ASM — checked before the generic catch-alls below
    # so "RAC node 2 (host2) is down" resolves to rac_node_down, not host_down.
    if "rac node" in m or "rac instance" in m: return "rac_node_down", "RAC Node"
    if "oracle service" in m:                  return "service_down", "Oracle Service"
    if "data guard" in m and "transport" in m:  return "dg_transport_failure", "Data Guard Transport"
    if "data guard" in m and "apply" in m:      return "dg_apply_failure", "Data Guard Apply"
    if "data guard" in m and "lag" in m:        return "dg_transport_lag", "Data Guard Lag"
    if "archive gap" in m:                      return "dg_archive_gap", "Data Guard Archive Gap"
    if "asm" in m or "disk group" in m:          return "asm_diskgroup_critical", "ASM"
    if "cache" in m or "buffer" in m: return "cache_hit", "Cache / buffer hit ratio"
    if "cpu" in m:                    return "cpu", "CPU usage"
    if "memory" in m or "ram" in m:   return "memory", "Memory usage"
    if "disk" in m or "space" in m:   return "disk", "Disk usage"
    if "connection" in m:             return "connections", "Connections"
    if "replicat" in m:               return "replication_lag", "Replication"
    if "deadlock" in m:               return "deadlocks", "Deadlocks"
    if "backup" in m:                 return "backup_failed", "Backup"
    if "slow" in m or "quer" in m:    return "slow_queries", "Slow queries"
    if any(k in m for k in ("offline", "unreachable", "down", "crash", "stopped")):
        return "host_down", "Availability"
    return "", "Alert"


def evaluate(rule, server):
    """Return (value_str, threshold_str, message) if the rule fires against
    this server right now, else None."""
    metric = rule.metric
    techs = techs_of(server)
    tail = f" ({techs})" if techs else ""

    if metric in _NUMERIC_HOST:
        val = pct(getattr(server, _NUMERIC_HOST[metric]))
        if val is None or not cmp(val, rule.operator, rule.threshold):
            return None
        label = {"cpu": "CPU usage", "memory": "Memory usage", "disk": "Disk usage"}[metric]
        return (
            f"{val:g}%",
            f"{_OPSYM.get(rule.operator, '')} {rule.threshold:g}%",
            f"{label} is {val:g}% on {server.server_name}{tail} — threshold {_OPSYM.get(rule.operator,'')} {rule.threshold:g}%",
        )

    if metric == "host_down":
        if (server.status or "") != "Connected":
            return (server.status or "Unknown", None, f"Host {server.server_name}{tail} is offline / unreachable")
        return None

    if metric == "service_down":
        stopped = [i.db_type for i in (server.db_instances or []) if (i.status or "") == "Stopped"]
        if stopped:
            return ("Stopped", None, f"Database service stopped on {server.server_name}: {', '.join(stopped)}")
        return None

    # metrics without a live data source do not fire (no false positives)
    return None
