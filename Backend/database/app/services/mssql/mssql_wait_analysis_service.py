"""
SQL Server Wait Analysis — one evaluator per wait type, evidence-based, no
black-box scoring.

Each evaluator reads real DMV signals (sys.dm_os_wait_stats, sys.dm_exec_
requests/sessions, config) into one finding, the same "flat list of dicts"
shape as oracle_storage_decision_service.py's findings and
mysql_slow_query_analysis_service.py's diagnose(). get_wait_analysis() runs
every evaluator and returns their findings as a list — adding a new wait type
means adding a new evaluator function, not generalizing an existing one,
since each wait type is actionable for different reasons and needs its own
evidence shape.

No mutating SQL, no persistence, no approval workflow — every recommended
action here is a change outside SQL Server (client code, network, query
design, server configuration), so there is nothing for ActMon to safely
execute on the user's behalf.
"""

from sqlalchemy.orm import Session

from app.services.mssql.mssql_monitoring_service import (
    BENIGN_WAIT_TYPES_SQL, _get_conn_or_404, _mssql_engine, _rows, _to_float, _to_int,
)

# ── Thresholds (ASYNC_NETWORK_IO) ────────────────────────────────────────────
# Conservative, explicit constants — same philosophy as
# oracle_storage_decision_service.py: a documented starting point, not a
# tuned-from-data model. "pct" is share of TOTAL non-idle wait time
# (BENIGN_WAIT_TYPES_SQL excluded), matching the dashboard's own wait-stats
# card so the two never disagree.
PCT_MONITOR = 5.0
PCT_WARNING = 15.0
PCT_CRITICAL = 30.0
RANK_WARNING = 3          # top-3 wait by accumulated time
SESSIONS_WARNING = 3      # concurrently-waiting sessions right now
LARGE_ROW_COUNT = 100_000  # "this query returns a lot of data" evidence floor


def get_wait_analysis(conn_id: int, db: Session):
    conn_rec = _get_conn_or_404(conn_id, db)
    engine = _mssql_engine(conn_rec)
    errors = []

    findings = [
        _run_async_network_io(engine, errors),
        _run_cx_waits(engine, errors),
    ]
    config = _run_wait_config(engine, errors)
    all_wait_stats = _run_all_wait_stats(engine, errors)

    return {
        "status": "success", "findings": findings,
        "all_wait_stats": all_wait_stats, "config": config, "errors": errors,
    }


# ── All wait statistics (reference — not evaluated, just ranked) ────────────
# The two evaluators above only cover the wait types actionable enough to have
# their own evidence/recommendation shape. This is the plain top-N ranking —
# same shape as the main dashboard's own wait-stats card (BENIGN_WAIT_TYPES_SQL
# excluded so the two never disagree) — so a DBA can see where ASYNC_NETWORK_IO/
# CXPACKET/CXCONSUMER actually rank among everything else, not just each other.

ALL_WAIT_STATS_TOP_N = 20


def _run_all_wait_stats(engine, errors: list):
    try:
        rows = _rows(engine, f"""
            SELECT TOP {ALL_WAIT_STATS_TOP_N} wait_type, waiting_tasks_count, wait_time_ms,
                signal_wait_time_ms,
                CAST(100.0 * wait_time_ms / NULLIF((
                    SELECT SUM(wait_time_ms) FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                ), 0) AS DECIMAL(5,1)) AS pct
            FROM sys.dm_os_wait_stats
            WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL}) AND wait_time_ms > 0
            ORDER BY wait_time_ms DESC
        """)
        _decimals_to_float(rows)
        for row in rows:
            row["waiting_tasks_count"] = _to_int(row.get("waiting_tasks_count"))
            row["wait_time_ms"] = _to_int(row.get("wait_time_ms"))
            row["signal_wait_time_ms"] = _to_int(row.get("signal_wait_time_ms"))
            row["pct"] = _to_float(row.get("pct"))
        return rows
    except Exception as exc:  # noqa: BLE001
        errors.append(f"all_wait_stats: {exc}")
        return []


def _decimals_to_float(rows):
    for row in rows:
        for k, v in row.items():
            if hasattr(v, "__class__") and v.__class__.__name__ == "Decimal":
                row[k] = float(v)
    return rows


# ── 1. ASYNC_NETWORK_IO ───────────────────────────────────────────────────────
# ASYNC_NETWORK_IO means SQL Server has finished producing a row and is waiting
# for the CLIENT to read it — the bottleneck is the client or the network, not
# SQL Server itself.

def _run_async_network_io(engine, errors: list):
    stat = {}
    try:
        rows = _rows(engine, f"""
            SELECT wait_type, waiting_tasks_count, wait_time_ms, signal_wait_time_ms,
                CAST(100.0 * wait_time_ms / NULLIF((
                    SELECT SUM(wait_time_ms) FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                ), 0) AS DECIMAL(5,1)) AS pct,
                (SELECT COUNT(*) FROM sys.dm_os_wait_stats w2
                 WHERE w2.wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                   AND w2.wait_time_ms > w1.wait_time_ms) + 1 AS rank_position
            FROM sys.dm_os_wait_stats w1
            WHERE wait_type = 'ASYNC_NETWORK_IO'
        """)
        if rows:
            stat = _decimals_to_float(rows)[0]
    except Exception as exc:  # noqa: BLE001
        errors.append(f"async_network_io wait_stats: {exc}")

    sessions = []
    try:
        # last_rows/last_logical_reads come from the query's own execution-stats
        # cache (sys.dm_exec_query_stats) — how much data THIS query returned
        # last time it ran, not a guess. LEFT JOIN because a plan can age out of
        # the cache while the session is still running (or waiting).
        sessions = _rows(engine, """
            SELECT s.session_id, s.login_name, s.host_name, s.program_name,
                DB_NAME(s.database_id) AS database_name,
                r.wait_time AS wait_time_ms,
                r.total_elapsed_time AS elapsed_ms,
                LEFT(ISNULL(t.text, ''), 500) AS sql_text,
                qs.last_rows, qs.last_elapsed_time, qs.last_logical_reads
            FROM sys.dm_exec_sessions s
            JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
            LEFT JOIN sys.dm_exec_query_stats qs
                   ON qs.sql_handle = r.sql_handle AND qs.plan_handle = r.plan_handle
            WHERE r.wait_type = 'ASYNC_NETWORK_IO'
              AND s.session_id <> @@SPID
            ORDER BY r.wait_time DESC
        """)
        _decimals_to_float(sessions)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"async_network_io sessions: {exc}")

    return _evaluate_async_network_io(stat, sessions)


def _evaluate_async_network_io(stat, sessions):
    pct = _to_float(stat.get("pct")) if stat else 0.0
    rank = _to_int(stat.get("rank_position")) if stat and stat.get("rank_position") is not None else None
    waiting_now = len(sessions)

    status = "healthy"
    if pct >= PCT_CRITICAL and rank == 1:
        status = "critical"
    elif pct >= PCT_WARNING or (rank is not None and rank <= RANK_WARNING and waiting_now >= SESSIONS_WARNING):
        status = "warning"
    elif pct >= PCT_MONITOR or waiting_now >= 1:
        status = "monitor"

    rank_str = f", rank #{rank} overall" if rank else ""

    base_stat = {
        "waiting_tasks_count": _to_int(stat.get("waiting_tasks_count")) if stat else 0,
        "wait_time_ms": _to_int(stat.get("wait_time_ms")) if stat else 0,
        "signal_wait_time_ms": _to_int(stat.get("signal_wait_time_ms")) if stat else 0,
        "pct_of_total_wait": pct,
        "rank": rank,
    }

    if status == "healthy":
        return _finding(
            "ASYNC_NETWORK_IO", status,
            "ASYNC_NETWORK_IO is not a significant wait right now.",
            f"{pct}% of total non-idle wait time{rank_str}, {waiting_now} session(s) currently waiting.",
            "no_action", "None needed.", "None.", sessions=[], stat=base_stat,
        )

    # Evidence-matched recommendations — only suggested when the data in front
    # of us actually supports it, not the full checklist regardless of cause.
    apps = sorted({s.get("program_name") or "Unknown" for s in sessions})
    ssms_like = any(
        "management studio" in (s.get("program_name") or "").lower()
        or "ssms" in (s.get("program_name") or "").lower()
        for s in sessions
    )
    big_result = [s for s in sessions if _to_int(s.get("last_rows")) >= LARGE_ROW_COUNT]

    actions = []
    if big_result:
        max_rows = max(_to_int(s.get("last_rows")) for s in big_result)
        actions.append(
            f"Reduce the data returned — one waiting query last returned ~{max_rows:,} rows. "
            "Filter, paginate, or select only the columns actually needed."
        )
    if ssms_like:
        actions.append(
            "SSMS is one of the waiting clients — its results grid is slow on large sets; "
            "export to a file instead, or run this from the application."
        )
    if not actions:
        actions.append(
            "Optimize the client application: increase fetch/batch size, avoid row-by-row "
            "(RBAR) processing, and check for client-side blocking (UI thread, locks, think time)."
        )
    actions.append("If none of this explains it, check network latency/bandwidth to the affected client(s).")

    problem = "SQL Server is spending significant time on ASYNC_NETWORK_IO — clients are slow to consume result sets."
    evidence = (
        f"{pct}% of total non-idle wait time{rank_str}, {waiting_now} session(s) currently waiting"
        + (f": {', '.join(apps)}." if apps else ".")
    )

    return _finding(
        "ASYNC_NETWORK_IO", status, problem, evidence, " ".join(actions),
        "Faster client-side reads free up SQL Server resources (locks/memory) sooner and improve overall throughput.",
        "None — read-only assessment. Every recommended action here happens outside SQL Server "
        "(client code, network, or query design), so there is nothing to execute on your behalf.",
        sessions=sessions, stat=base_stat,
    )


# ── 2. CXPACKET / CXCONSUMER (parallelism) ───────────────────────────────────
# These waits occur when threads in a parallel plan exchange rows or wait for
# other threads to finish. Common and often benign under efficient parallelism
# — only a real problem if reducing DOP doesn't help, or CPU is low despite a
# high CX wait share. Grouped together (one combined bucket) because they're
# diagnosed as a pair, not separately.

CX_WAIT_TYPES_SQL = "'CXPACKET','CXCONSUMER'"
LOW_COST_THRESHOLD = 50  # SQL Server's own default (5) is widely cited as too low for most workloads;
                         # anything still under this commonly-recommended floor is worth flagging


def _run_cx_waits(engine, errors: list):
    stat = {}
    try:
        rows = _rows(engine, f"""
            SELECT SUM(wait_time_ms) AS wait_time_ms,
                SUM(waiting_tasks_count) AS waiting_tasks_count,
                SUM(signal_wait_time_ms) AS signal_wait_time_ms,
                CAST(100.0 * SUM(wait_time_ms) / NULLIF((
                    SELECT SUM(wait_time_ms) FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL})
                ), 0) AS DECIMAL(5,1)) AS pct
            FROM sys.dm_os_wait_stats
            WHERE wait_type IN ({CX_WAIT_TYPES_SQL})
        """)
        if rows:
            stat = _decimals_to_float(rows)[0]
            # Rank needs the combined total, not a per-row lookup like the single-wait-type
            # query above — computed as a second, tiny query against the same combined sum.
            rank_rows = _rows(engine, f"""
                SELECT COUNT(*) + 1 AS rank_position
                FROM (
                    SELECT wait_type, SUM(wait_time_ms) AS wt
                    FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN ({BENIGN_WAIT_TYPES_SQL}) AND wait_type NOT IN ({CX_WAIT_TYPES_SQL})
                    GROUP BY wait_type
                    HAVING SUM(wait_time_ms) > {_to_float(stat.get('wait_time_ms'))}
                ) x
            """)
            stat["rank_position"] = rank_rows[0]["rank_position"] if rank_rows else None
    except Exception as exc:  # noqa: BLE001
        errors.append(f"cx_waits wait_stats: {exc}")

    sessions = []
    try:
        sessions = _rows(engine, """
            SELECT s.session_id, s.login_name, s.host_name, s.program_name,
                DB_NAME(s.database_id) AS database_name,
                r.wait_type, r.wait_time AS wait_time_ms,
                r.total_elapsed_time AS elapsed_ms,
                LEFT(ISNULL(t.text, ''), 500) AS sql_text
            FROM sys.dm_exec_sessions s
            JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
            OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
            WHERE r.wait_type IN ('CXPACKET', 'CXCONSUMER')
              AND s.session_id <> @@SPID
            ORDER BY r.wait_time DESC
        """)
        _decimals_to_float(sessions)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"cx_waits sessions: {exc}")

    maxdop, cost_threshold = None, None
    try:
        cfg = _rows(engine, """
            SELECT name, CAST(value AS INT) AS value FROM sys.configurations
            WHERE name IN ('max degree of parallelism', 'cost threshold for parallelism')
        """)
        for row in cfg:
            if row.get("name") == "max degree of parallelism":
                maxdop = _to_int(row.get("value"))
            elif row.get("name") == "cost threshold for parallelism":
                cost_threshold = _to_int(row.get("value"))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"cx_waits config: {exc}")

    return _evaluate_cx(stat, sessions, maxdop, cost_threshold)


def _evaluate_cx(stat, sessions, maxdop, cost_threshold):
    pct = _to_float(stat.get("pct")) if stat else 0.0
    rank = _to_int(stat.get("rank_position")) if stat and stat.get("rank_position") is not None else None
    waiting_now = len(sessions)

    status = "healthy"
    if pct >= PCT_CRITICAL and rank == 1:
        status = "critical"
    elif pct >= PCT_WARNING or (rank is not None and rank <= RANK_WARNING and waiting_now >= SESSIONS_WARNING):
        status = "warning"
    elif pct >= PCT_MONITOR or waiting_now >= 1:
        status = "monitor"

    rank_str = f", rank #{rank} overall" if rank else ""
    base_stat = {
        "waiting_tasks_count": _to_int(stat.get("waiting_tasks_count")) if stat else 0,
        "wait_time_ms": _to_int(stat.get("wait_time_ms")) if stat else 0,
        "signal_wait_time_ms": _to_int(stat.get("signal_wait_time_ms")) if stat else 0,
        "pct_of_total_wait": pct,
        "rank": rank,
        "max_degree_of_parallelism": maxdop,
        "cost_threshold_for_parallelism": cost_threshold,
    }

    if status == "healthy":
        return _finding(
            "CXPACKET/CXCONSUMER", status,
            "CXPACKET/CXCONSUMER is not a significant wait right now.",
            f"{pct}% of total non-idle wait time{rank_str}, {waiting_now} session(s) currently waiting.",
            "no_action", "None needed.", "None.", sessions=[], stat=base_stat,
        )

    # Evidence-matched recommendations — never the full checklist regardless of
    # cause, only what the config/session data in front of us actually supports.
    actions = []
    if maxdop == 0:
        actions.append(
            "MAXDOP is unlimited (0) — consider setting it to a value appropriate for this "
            "hardware/workload (e.g. up to the number of cores per NUMA node)."
        )
    if cost_threshold is not None and cost_threshold < LOW_COST_THRESHOLD:
        actions.append(
            f"Cost threshold for parallelism is {cost_threshold} — small/simple queries may be "
            f"going parallel unnecessarily (a commonly-used floor is {LOW_COST_THRESHOLD})."
        )
    if not actions:
        actions.append(
            "Review the query plan for the waiting sessions below for parallelism operators "
            "(Distribute/Gather/Repartition Streams) and check for data skew — uneven row "
            "distribution across threads is a common cause even with sensible MAXDOP/cost settings."
        )
    actions.append(
        "CX waits are common and not always a problem when parallelism is efficient — only treat "
        "this as an issue if reducing DOP for the query doesn't help, or CPU is low despite the "
        "high CX wait share."
    )

    problem = "SQL Server is spending significant time on CXPACKET/CXCONSUMER — parallel query threads are coordinating/waiting on each other."
    evidence = f"{pct}% of total non-idle wait time{rank_str}, {waiting_now} session(s) currently waiting."

    return _finding(
        "CXPACKET/CXCONSUMER", status, problem, evidence, " ".join(actions),
        "Right-sizing parallelism (MAXDOP/cost threshold) or fixing plan-level skew reduces "
        "coordination overhead and can improve both this query's latency and overall CPU efficiency.",
        "None — read-only assessment. MAXDOP/cost-threshold changes are server configuration "
        "changes outside this tool's scope; nothing is executed on your behalf.",
        sessions=sessions, stat=base_stat,
    )


# ── Wait-related configuration ───────────────────────────────────────────────
# A curated set of sys.configurations entries that directly influence which
# waits show up and how severe they get — not every server setting, only the
# ones a DBA actually cross-checks against a wait-stats reading (parallelism
# for CX*, worker/memory pressure for THREADPOOL/RESOURCE_SEMAPHORE-style
# waits, blocked-process-threshold for lock-wait visibility).
_WAIT_CONFIG_PARAMS = [
    ("max degree of parallelism", "Caps parallel worker threads per query. 0 = unlimited — a common CXPACKET/CXCONSUMER contributor."),
    ("cost threshold for parallelism", "Query cost (est.) above which SQL Server considers a parallel plan. SQL Server's own default (5) is widely considered too low."),
    ("max worker threads", "Total worker threads available to the engine. 0 = SQL Server auto-computes from CPU count; too low can drive THREADPOOL waits."),
    ("max server memory (MB)", "Ceiling on the buffer pool + most other engine memory. Set too low, this drives PAGEIOLATCH_*/RESOURCE_SEMAPHORE waits."),
    ("min server memory (MB)", "Floor SQL Server won't release memory below once reached."),
    ("blocked process threshold (s)", "Seconds a session must be blocked before it's reported to the blocked-process report/system_health — 0 disables that reporting entirely."),
    ("lightweight pooling", "Fiber-mode scheduling (legacy) — changes how SOS_SCHEDULER_YIELD-class waits behave. Rarely enabled on modern hardware."),
    ("priority boost", "Raises the SQL Server process's OS scheduling priority. Microsoft recommends leaving this off."),
    ("affinity mask", "CPU affinity for schedulers (32-bit mask) — an uneven mask across NUMA nodes can skew CXPACKET distribution."),
    ("affinity64 mask", "CPU affinity for schedulers 33-64 on servers with more than 32 logical CPUs."),
    ("locks", "Configured max concurrent locks. 0 = dynamic (SQL Server manages it) — relevant when lock-wait exhaustion is suspected."),
]


def _run_wait_config(engine, errors: list):
    names = [p[0] for p in _WAIT_CONFIG_PARAMS]
    descriptions = dict(_WAIT_CONFIG_PARAMS)
    placeholders = ", ".join(f"'{n}'" for n in names)
    try:
        rows = _rows(engine, f"""
            SELECT name, CAST(value_in_use AS BIGINT) AS value_in_use
            FROM sys.configurations
            WHERE name IN ({placeholders})
        """)
        by_name = {r["name"]: _to_int(r.get("value_in_use")) for r in rows}
    except Exception as exc:  # noqa: BLE001
        errors.append(f"wait_config: {exc}")
        by_name = {}

    # Preserve _WAIT_CONFIG_PARAMS' curated order rather than whatever order
    # SQL Server returns rows in, and surface a param even if the query failed
    # entirely (value None) so the UI can show "unavailable" instead of nothing.
    return [
        {"name": name, "value": by_name.get(name), "description": descriptions[name]}
        for name in names
    ]


def _finding(wait_type, status, problem, evidence, recommended_action, expected_benefit, risk, sessions, stat):
    return {
        "wait_type": wait_type,
        "status": status,
        "problem": problem,
        "evidence": evidence,
        "recommended_action": recommended_action,
        "expected_benefit": expected_benefit,
        "risk": risk,
        "sessions_evaluated": len(sessions),
        "sessions": sessions,
        "stat": stat,
    }
