"""
Shared normalization layer for every engine's Slow Queries list.

Each engine keeps its own collection mechanism entirely (pg_stat_statements,
performance_schema, DMVs, v$sqlarea, the Mongo profiler, system.query_log) —
this module only turns whatever rows an engine's own service function already
fetched into one common shape, so a single shared frontend component can
render identical UI across every engine. Nothing here queries a database
itself; it is called from the tail end of each engine's existing service
function, the same way `actmon_internal_tables.py` is called from each
engine's own query-builder rather than owning a base class those functions
inherit from.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.services.common.actmon_internal_tables import contains_internal_table

NORMALIZED_FIELDS = (
    "query_id", "query_text", "database_name", "schema_name", "user_name", "host",
    "execution_count", "total_execution_time", "average_execution_time",
    "min_execution_time", "max_execution_time", "rows_affected", "rows_returned",
    "first_seen", "last_seen", "status", "severity", "source", "query_type",
)


def classify_query_type(query_text: Optional[str]) -> str:
    """'actmon' if this query references one of ActMon's own bookkeeping
    tables, else 'system' — the generic classifier used by every engine
    except MySQL, which has its own richer `is_actmon_internal_query()`
    (schema + admin-verb + signature-query signals) and calls that directly
    instead of this one."""
    return "actmon" if contains_internal_table(query_text or "") else "system"


def classify_severity(avg_ms: Optional[float], max_ms: Optional[float] = None) -> str:
    """One shared severity rule for every engine, in milliseconds — the same
    cutoffs PostgreSQL's own slow-query list already used before this refactor
    (avg > 10s critical, > 2s high, > 500ms medium, else low). Falls back to
    max_ms only when an engine has no average (e.g. a single-instance row)."""
    value = avg_ms if avg_ms is not None else (max_ms if max_ms is not None else 0)
    if value > 10000:
        return "critical"
    if value > 2000:
        return "high"
    if value > 500:
        return "medium"
    return "low"


def build_normalized_row(
    *,
    query_id: Optional[str] = None,
    query_text: Optional[str] = None,
    database_name: Optional[str] = None,
    schema_name: Optional[str] = None,
    user_name: Optional[str] = None,
    host: Optional[str] = None,
    execution_count: Optional[int] = None,
    total_execution_time: Optional[float] = None,
    average_execution_time: Optional[float] = None,
    min_execution_time: Optional[float] = None,
    max_execution_time: Optional[float] = None,
    rows_affected: Optional[int] = None,
    rows_returned: Optional[int] = None,
    first_seen: Optional[str] = None,
    last_seen: Optional[str] = None,
    status: str = "active",
    source: Optional[str] = None,
    query_type: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble one row in the common Slow Query shape. A field the caller
    doesn't supply stays None — the frontend renders that as "N/A" rather
    than the collector inventing a value the source system doesn't have.
    `query_type` defaults to classifying `query_text` via
    `classify_query_type()` if the caller doesn't already know it (MySQL and
    MongoDB pass their own richer classification in explicitly)."""
    return {
        "query_id": query_id,
        "query_text": query_text,
        "database_name": database_name,
        "schema_name": schema_name,
        "user_name": user_name,
        "host": host,
        "execution_count": execution_count,
        "total_execution_time": total_execution_time,
        "average_execution_time": average_execution_time,
        "min_execution_time": min_execution_time,
        "max_execution_time": max_execution_time,
        "rows_affected": rows_affected,
        "rows_returned": rows_returned,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "status": status,
        "severity": classify_severity(average_execution_time, max_execution_time),
        "source": source,
        "query_type": query_type or classify_query_type(query_text),
    }


# What each engine can genuinely populate today. "aggregation" is the one flag
# every consumer must check first: "digest" means many executions of the same
# query shape are summarized into one row (execution_count/avg/min/max/total
# all mean something real); "instance" means one row IS one single execution
# (MongoDB's profiler/currentOp have no per-shape aggregation at all) — in
# that case execution_count/min/max/total stay None and average_execution_time
# is that one observed duration, not a true average.
CAPABILITIES: Dict[str, Dict[str, Any]] = {
    "postgresql": {
        "aggregation": "digest", "query_id": True, "schema_name": False,
        "user_name": True, "host": False, "execution_count": True,
        "min_execution_time": True, "rows_returned": True, "rows_affected": False,
        "first_seen": False, "cache_hit": True,
    },
    "mysql": {
        "aggregation": "digest", "query_id": True, "schema_name": False,
        "user_name": True, "host": True, "execution_count": True,
        "min_execution_time": True, "rows_returned": True, "rows_affected": True,
        "first_seen": True, "cache_hit": False,
    },
    "mssql": {
        "aggregation": "digest", "query_id": True, "schema_name": False,
        "user_name": False, "host": False, "execution_count": True,
        "min_execution_time": True, "rows_returned": False, "rows_affected": False,
        "first_seen": False, "cache_hit": False,
    },
    "oracle": {
        "aggregation": "digest", "query_id": True, "schema_name": True,
        "user_name": False, "host": False, "execution_count": True,
        "min_execution_time": False, "rows_returned": True, "rows_affected": False,
        "first_seen": False, "cache_hit": False,
    },
    "mongodb": {
        "aggregation": "instance", "query_id": False, "schema_name": False,
        "user_name": True, "host": True, "execution_count": False,
        "min_execution_time": False, "rows_returned": True, "rows_affected": False,
        "first_seen": False, "cache_hit": False,
    },
    "clickhouse": {
        "aggregation": "digest", "query_id": True, "schema_name": False,
        "user_name": True, "host": False, "execution_count": True,
        "min_execution_time": True, "rows_returned": True, "rows_affected": False,
        "first_seen": False, "cache_hit": False,
    },
    "cosmosdb": {
        # Every row is one observed ActMon call, not a query-shape digest —
        # Cosmos has no native slow-query catalog to summarize by (see
        # cosmosdb_service.py's own docstring on why this is ActMon's own
        # call log, not an Azure diagnostic feed).
        "aggregation": "instance", "query_id": True, "schema_name": False,
        "user_name": False, "host": False, "execution_count": False,
        "min_execution_time": False, "rows_returned": False, "rows_affected": False,
        "first_seen": True, "cache_hit": False,
    },
}


def attach_normalized(response: Dict[str, Any], tech: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Adds `normalized` (a list of build_normalized_row() dicts) and
    `capabilities` to an engine's EXISTING slow-query response dict. Every
    legacy top-level field the response already had is left untouched, so
    the current per-engine frontend pages keep working unmodified until they
    are cut over to the shared component (see the migration plan)."""
    response["normalized"] = rows
    response["capabilities"] = CAPABILITIES.get(tech, {})
    return response


_SORT_FIELD = {
    "avg": "average_execution_time",
    "max": "max_execution_time",
    "execs": "execution_count",
    "count": "execution_count",
    "rows": "rows_returned",
    "rows_returned": "rows_returned",
    "rows_examined": "rows_affected",
    "first_seen": "first_seen",
    "last_seen": "last_seen",
}


def filter_paginate_rows(
    rows: List[Dict[str, Any]],
    *,
    database_name: Optional[str] = None,
    query_type: Optional[str] = None,
    severity: Optional[str] = None,
    user_name: Optional[str] = None,
    search: Optional[str] = None,
    min_avg_ms: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
) -> Dict[str, Any]:
    """The ONE filter/sort/paginate contract every engine's Slow Queries list
    uses — takes the already-normalized, already-`query_type`-tagged row list
    for ONE engine and returns the exact response shape the shared frontend
    `SlowQueryExplorer` reads, so no engine reimplements this. Filtering runs
    in Python over whatever the engine's own collector already returned
    (never re-queries the database) — safe here because every source this
    backs (pg_stat_statements, MSSQL/Oracle/ClickHouse's cached digests,
    Mongo's profiler/currentOp snapshot, ActMon's own Cosmos call log) is a
    bounded, already-in-memory snapshot, not an unbounded log file (MySQL's
    slow-query-log-file source is the one exception — it keeps its own real
    SQL/file-level filtering in `mysql_slow_query_service.py` instead of
    this helper, since a log file can be far larger than a digest table)."""
    available_databases = sorted({r["database_name"] for r in rows if r.get("database_name")})
    available_users = sorted({r["user_name"] for r in rows if r.get("user_name")})

    out = rows
    if database_name:
        out = [r for r in out if r.get("database_name") == database_name]
    if query_type and query_type != "all":
        out = [r for r in out if r.get("query_type") == query_type]
    if severity and severity != "all":
        out = [r for r in out if r.get("severity") == severity]
    if user_name:
        out = [r for r in out if r.get("user_name") == user_name]
    if search:
        needle = search.strip().lower()
        if needle:
            out = [r for r in out if needle in (r.get("query_text") or "").lower()]
    if min_avg_ms:
        floor = float(min_avg_ms)
        out = [r for r in out if (r.get("average_execution_time") or 0) >= floor]
    if date_from:
        out = [r for r in out if (r.get("last_seen") or "") >= date_from]
    if date_to:
        # last_seen is an ISO timestamp; date_to is a bare date — append the
        # end-of-day boundary so "to 2026-08-18" includes that whole day.
        out = [r for r in out if (r.get("last_seen") or "") <= f"{date_to}T23:59:59"]

    field = _SORT_FIELD.get(sort_by, "average_execution_time")
    reverse = sort_dir != "asc"
    out = sorted(out, key=lambda r: (r.get(field) is None, r.get(field) or 0), reverse=reverse)

    total = len(out)
    page = max(1, page)
    page_size = max(1, min(page_size, 500))
    page_count = max(1, (total + page_size - 1) // page_size)
    if page > page_count:
        page = page_count
    start = (page - 1) * page_size
    page_rows = out[start:start + page_size]

    return {
        "normalized": page_rows,
        "normalized_total": total,
        "available_databases": available_databases,
        "available_users": available_users,
        "page": page,
        "page_size": page_size,
    }


def find_normalized_by_id(response: Dict[str, Any], query_id: str) -> Optional[Dict[str, Any]]:
    """Looks up one row by `query_id` in an already-normalized list response —
    backs the detail page's refresh/direct-link fallback for the four
    digest-based engines (Postgres/MySQL/MSSQL/Oracle). Only meaningful where
    `query_id` is a stable per-digest identifier; MongoDB/ClickHouse-instance
    rows are not looked up this way (see the migration plan)."""
    for row in response.get("normalized") or []:
        if row.get("query_id") == query_id:
            return row
    return None
