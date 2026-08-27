"""
ClickHouse metrics history service — the COLD/history tier of the metrics pipeline.
===================================================================================

Table layout — one table per MODULE / TECHNOLOGY:

  actmon.metrics_infra          ← module: Infrastructure (host agents)
  actmon.metrics_db_mysql       ← module: Database → MySQL
  actmon.metrics_db_postgresql  ·  db_oracle · db_mssql · db_mongodb · …
                                   (auto-created on first sample of a new tech)

All tables share ONE uniform schema, sorted (agent, conn_id, ts) inside each — the
hierarchy is: table = module→technology, then agent → connection → time. Uniform
schema also lets merge('actmon', '^metrics_') query the whole family at once.

Reuses the actmon_logs ClickHouse connection (same host/creds, same master switch:
ACTMON_LOGS_ENABLED). Degrades gracefully with a cooldown; never raises.

Config (env):
  METRICS_CH_TTL_DAYS   default 90 (per-table retention)
"""

import os
import re
import time
import logging

logger = logging.getLogger("metrics_history")

TTL_DAYS = int(os.getenv("METRICS_CH_TTL_DAYS", "90") or 90)

# ClickHouse database these tables live in — same var actmon_logs/core.py reads,
# so both the generic log store and this file's tables stay in sync. Defaulting
# to "actmon" keeps existing installs unaffected; a separate deployment (e.g.
# actmon-b1) can point this at its own database via .env so its history never
# mixes with another install sharing the same ClickHouse server.
CH_DB = os.getenv("ACTMON_LOGS_CH_DB", "actmon")

# Numeric fields carried through the pipeline (mirror of AgentMetric).
FIELDS = ("host_cpu", "host_memory", "host_disk", "db_cpu", "active_sessions", "connections_used",
          "connections_max", "cache_hit_pct", "qps", "tps", "uptime_seconds")
INT_FIELDS = ("active_sessions", "connections_used", "connections_max", "uptime_seconds")
COLUMNS = ["ts", "kind", "tech", "agent", "conn_id"] + list(FIELDS)

_COOLDOWN = 15.0
_next_retry = 0.0
_db_ready = False
_tables_ready = set()


def get_client():
    """Fresh ClickHouse client via the shared actmon_logs config, or None (cooldown)."""
    global _next_retry
    if time.monotonic() < _next_retry:
        return None
    try:
        from actmon_logs import core as logs_core
        return logs_core.get_client()
    except Exception:  # noqa: BLE001
        _next_retry = time.monotonic() + _COOLDOWN
        return None


def mark_down():
    global _next_retry, _db_ready
    _db_ready = False
    _tables_ready.clear()
    _next_retry = time.monotonic() + _COOLDOWN


def table_for(kind, tech):
    """Module/technology → table name.  infra → metrics_infra; database → metrics_db_<tech>."""
    if (kind or "infra") == "infra":
        return "metrics_infra"
    safe = re.sub(r"[^a-z0-9_]", "_", (tech or "unknown").lower()) or "unknown"
    return "metrics_db_%s" % safe


def ensure_table(cli, table):
    global _db_ready
    if table in _tables_ready:
        return True
    try:
        if not _db_ready:
            cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
            _db_ready = True
        cli.command(f"""
            CREATE TABLE IF NOT EXISTS {CH_DB}.{table} (
                ts               DateTime,
                kind             LowCardinality(String),
                tech             LowCardinality(String),
                agent            LowCardinality(String),
                conn_id          UInt32,
                host_cpu         Float64,
                host_memory      Float64,
                host_disk        Float64,
                db_cpu           Float64,
                active_sessions  Int32,
                connections_used Int32,
                connections_max  Int32,
                cache_hit_pct    Float64,
                qps              Float64,
                tps              Float64,
                uptime_seconds   Int64
            ) ENGINE = MergeTree
              PARTITION BY toYYYYMM(ts)
              ORDER BY (agent, conn_id, ts)
              TTL ts + INTERVAL {TTL_DAYS} DAY
        """)
        # CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists from
        # before a field was added here — ADD COLUMN IF NOT EXISTS is what actually
        # backfills the schema on every table this process has ever created.
        cli.command(f"ALTER TABLE {CH_DB}.{table} ADD COLUMN IF NOT EXISTS host_disk Float64 DEFAULT 0")
        _tables_ready.add(table)
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] schema (%s): %s", table, e)
        mark_down()
        return False


def flush_sample(agent_name, sample):
    """Insert ONE displaced sample into its module/technology table. Never raises."""
    cli = get_client()
    if cli is None:
        return
    kind = sample.get("kind") or "infra"
    tech = sample.get("tech") or "host"
    table = table_for(kind, tech)
    if not ensure_table(cli, table):
        return
    try:
        import datetime
        ts = sample.get("ts")
        # SERVER-LOCAL time, not UTC: the DateTime columns are timezone-naive and
        # ClickHouse's now() is server-local — inserting UTC on an IST server made
        # every row look 5.5h old, so "last N minutes" windows came back empty.
        row = [datetime.datetime.fromtimestamp(float(ts)) if ts else datetime.datetime.now(),
               kind, tech, agent_name, int(sample.get("conn_id") or 0)]
        for f in FIELDS:
            v = sample.get(f, 0) or 0
            row.append(int(v) if f in INT_FIELDS else float(v))
        cli.insert("%s.%s" % (CH_DB, table), [row], column_names=COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] insert (%s): %s", table, e)
        mark_down()


# ── Transactional telemetry tables (top SQL, wait events) ─────────────────────
# ClickHouse is the ONLY historical store for these; PostgreSQL keeps just a short
# in-flight buffer. One table each, sorted (agent, ts), 90d TTL like metrics.

TOPSQL_COLUMNS = ["ts", "agent", "sql_id", "sql_text", "executions",
                  "avg_elapsed_ms", "cpu_time_ms", "buffer_gets", "total_ms", "max_ms"]
WAIT_COLUMNS = ["ts", "agent", "event_name", "wait_class", "time_waited_ms", "avg_ms", "count"]

_EXTRA_DDL = {
    "top_sql": f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.top_sql (
            ts DateTime, agent LowCardinality(String), sql_id String, sql_text String,
            executions Int64, avg_elapsed_ms Float64, cpu_time_ms Float64,
            buffer_gets Int64, total_ms Float64, max_ms Float64
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (agent, ts) TTL ts + INTERVAL {TTL_DAYS} DAY""",
    "wait_events": f"""
        CREATE TABLE IF NOT EXISTS {CH_DB}.wait_events (
            ts DateTime, agent LowCardinality(String), event_name String,
            wait_class LowCardinality(String), time_waited_ms Float64,
            avg_ms Float64, count Int64
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (agent, ts) TTL ts + INTERVAL {TTL_DAYS} DAY""",
}


def _ensure_extra(cli, table):
    global _db_ready
    if table in _tables_ready:
        return True
    try:
        if not _db_ready:
            cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
            _db_ready = True
        cli.command(_EXTRA_DDL[table])
        _tables_ready.add(table)
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] schema (%s): %s", table, e)
        mark_down()
        return False


# ── MySQL historical EVENT/snapshot tables (Reports architecture) ─────────────
# One source of truth for slow queries / error logs / binlog & replication
# history so the Reports page and the Slow Queries/Error Logs pages never
# diverge again. Retention is admin-configurable (mysql_ch_retention_service)
# rather than the hardcoded METRICS_CH_TTL_DAYS the generic metrics_* tables use.

MYSQL_SLOWQ_COLUMNS = ["ts", "agent", "conn_id", "db_name", "query_hash", "query_text",
                       "execution_time", "lock_time", "rows_sent", "rows_examined",
                       "user", "host", "severity", "source_log_file"]
MYSQL_ERRLOG_COLUMNS = ["ts", "agent", "conn_id", "severity", "error_code", "source", "message", "log_file"]
MYSQL_BINLOG_COLUMNS = ["ts", "agent", "conn_id", "binary_logging", "log_bin", "binlog_format",
                        "server_id", "current_log_file", "current_position",
                        "number_of_log_files", "total_size_bytes"]
MYSQL_REPL_COLUMNS = ["ts", "agent", "conn_id", "configured", "role", "io_thread_running",
                      "sql_thread_running", "seconds_behind_source", "last_error"]

_MYSQL_EXTRA_DDL = {
    "actmon_mysql_slow_queries": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_mysql_slow_queries (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            db_name LowCardinality(String), query_hash String, query_text String,
            execution_time Float64, lock_time Float64, rows_sent UInt32, rows_examined UInt32,
            user LowCardinality(String), host LowCardinality(String),
            severity LowCardinality(String), source_log_file String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_mysql_error_logs": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_mysql_error_logs (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            severity LowCardinality(String), error_code String,
            source LowCardinality(String), message String, log_file String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_mysql_binlog_history": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_mysql_binlog_history (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            binary_logging UInt8, log_bin UInt8, binlog_format LowCardinality(String),
            server_id UInt32, current_log_file String, current_position UInt64,
            number_of_log_files UInt32, total_size_bytes Int64
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_mysql_replication_history": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_mysql_replication_history (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            configured UInt8, role LowCardinality(String),
            io_thread_running UInt8, sql_thread_running UInt8,
            seconds_behind_source Int64, last_error String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
}

_MYSQL_TTL_TABLE = {
    "actmon_mysql_slow_queries": "events_days",
    "actmon_mysql_error_logs": "events_days",
    "actmon_mysql_binlog_history": "events_days",
    "actmon_mysql_replication_history": "events_days",
}


def _mysql_retention_days(table):
    try:
        from app.services.mysql.mysql_ch_retention_service import get_retention
        r = get_retention()
        return getattr(r, _MYSQL_TTL_TABLE.get(table, "events_days"))
    except Exception:  # noqa: BLE001
        return TTL_DAYS


def _ensure_mysql_table(cli, table):
    """Same idempotent create as _ensure_extra, plus a MODIFY TTL on every call
    (cheap — gated by the same cooldown/_tables_ready cache as everything else)
    so an admin-changed retention setting actually takes effect on an
    already-created table, not just on tables created after the change."""
    global _db_ready
    try:
        if not _db_ready:
            cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
            _db_ready = True
        days = _mysql_retention_days(table)
        if table not in _tables_ready:
            cli.command(_MYSQL_EXTRA_DDL[table] % {"days": int(days), "db": CH_DB})
            _tables_ready.add(table)
        else:
            cli.command(f"ALTER TABLE {CH_DB}.{table} MODIFY TTL ts + INTERVAL {int(days)} DAY")
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] schema (%s): %s", table, e)
        mark_down()
        return False


def flush_mysql_slow_queries(rows):
    """rows: list of dicts matching MYSQL_SLOWQ_COLUMNS (minus 'ts' resolved here).
    Never raises — caller (collector) just logs+drops on failure, matching the
    rest of this file's degrade-gracefully contract."""
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_mysql_table(cli, "actmon_mysql_slow_queries"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in MYSQL_SLOWQ_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_mysql_slow_queries", data, column_names=MYSQL_SLOWQ_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_mysql_slow_queries: %s", e)
        mark_down()


def flush_mysql_error_logs(rows):
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_mysql_table(cli, "actmon_mysql_error_logs"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in MYSQL_ERRLOG_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_mysql_error_logs", data, column_names=MYSQL_ERRLOG_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_mysql_error_logs: %s", e)
        mark_down()


def flush_mysql_binlog_snapshot(row):
    cli = get_client()
    if cli is None or not _ensure_mysql_table(cli, "actmon_mysql_binlog_history"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in MYSQL_BINLOG_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_mysql_binlog_history", data, column_names=MYSQL_BINLOG_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_mysql_binlog_snapshot: %s", e)
        mark_down()


def flush_mysql_replication_snapshot(row):
    """Caller should simply NOT call this for a cycle where replication isn't
    configured — absence of rows in the window is how the report layer tells
    'Standalone / Not Configured' apart from a real outage (§8/§29)."""
    cli = get_client()
    if cli is None or not _ensure_mysql_table(cli, "actmon_mysql_replication_history"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in MYSQL_REPL_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_mysql_replication_history", data, column_names=MYSQL_REPL_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_mysql_replication_snapshot: %s", e)
        mark_down()


def _window_where(conn_id, minutes=None, since=None, until=None):
    """Same style as history()'s WHERE builder: a relative `minutes` window is
    resolved against ClickHouse's OWN now() (server-local, same clock the
    inserts used — see flush_sample's note on why UTC-from-Python would be
    wrong here); `since`/`until` give an absolute range for custom reports."""
    where, params = ["conn_id = %(c)s"], {"c": int(conn_id)}
    if minutes is not None:
        where.append("ts > now() - INTERVAL %(m)s MINUTE")
        params["m"] = int(minutes)
    else:
        if since:
            where.append("ts >= %(since)s"); params["since"] = since
        if until:
            where.append("ts < %(until)s"); params["until"] = until
    return where, params


def query_mysql_slow_queries(conn_id, minutes=None, since=None, until=None, limit=5000):
    """Raw slow-query events for one connection, newest first."""
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, db_name, query_hash, query_text, execution_time, "
            "lock_time, rows_sent, rows_examined, user, host, severity, source_log_file "
            f"FROM {CH_DB}.actmon_mysql_slow_queries WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "db_name", "query_hash", "query_text", "execution_time", "lock_time",
                "rows_sent", "rows_examined", "user", "host", "severity", "source_log_file"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_mysql_slow_queries: %s", e)
        mark_down()
        return []


def query_mysql_error_logs(conn_id, minutes=None, since=None, until=None, limit=2000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, severity, error_code, source, message, log_file "
            f"FROM {CH_DB}.actmon_mysql_error_logs WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "severity", "error_code", "source", "message", "log_file"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_mysql_error_logs: %s", e)
        mark_down()
        return []


def query_mysql_binlog_history(conn_id, minutes=None, since=None, until=None, limit=1000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, binary_logging, log_bin, binlog_format, server_id, "
            "current_log_file, current_position, number_of_log_files, total_size_bytes "
            f"FROM {CH_DB}.actmon_mysql_binlog_history WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "binary_logging", "log_bin", "binlog_format", "server_id",
                "current_log_file", "current_position", "number_of_log_files", "total_size_bytes"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_mysql_binlog_history: %s", e)
        mark_down()
        return []


def query_mysql_replication_history(conn_id, minutes=None, since=None, until=None, limit=1000):
    """Empty list means 'no rows in this window' — caller must render that as
    Standalone/Not-Configured-or-no-data, never as fabricated zero metrics."""
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, configured, role, io_thread_running, sql_thread_running, "
            "seconds_behind_source, last_error "
            f"FROM {CH_DB}.actmon_mysql_replication_history WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "configured", "role", "io_thread_running", "sql_thread_running",
                "seconds_behind_source", "last_error"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_mysql_replication_history: %s", e)
        mark_down()
        return []


def _f(v):
    try:
        return float(v or 0)
    except Exception:  # noqa: BLE001
        return 0.0


def _i(v):
    try:
        return int(float(v or 0))
    except Exception:  # noqa: BLE001
        return 0


def flush_batch(items):
    """Insert MANY queued items grouped per table. Items are typed:
      {'agent':…, 'sample':{…}}                      → metrics_* tables
      {'type':'top_sql', 'agent':…, 'row':{…}}       → actmon.top_sql
      {'type':'wait_event', 'agent':…, 'row':{…}}    → actmon.wait_events
    Returns True only if EVERY insert succeeded — the caller requeues on False so
    nothing is lost while ClickHouse is unavailable."""
    cli = get_client()
    if cli is None:
        return False
    import datetime
    now = datetime.datetime.now()
    grouped, extra_topsql, extra_waits = {}, [], []
    for item in items:
        itype = item.get("type")
        if itype == "top_sql":
            r = item.get("row") or {}
            extra_topsql.append([now, item.get("agent") or "", str(r.get("sql_id") or ""),
                                 str(r.get("sql_text") or "")[:4000], _i(r.get("executions")),
                                 _f(r.get("avg_elapsed_ms")), _f(r.get("cpu_time_ms")),
                                 _i(r.get("buffer_gets")), _f(r.get("total_ms")), _f(r.get("max_ms"))])
            continue
        if itype == "wait_event":
            r = item.get("row") or {}
            extra_waits.append([now, item.get("agent") or "", str(r.get("event_name") or ""),
                                str(r.get("wait_class") or ""), _f(r.get("time_waited_ms")),
                                _f(r.get("avg_ms")), _i(r.get("count"))])
            continue
        sample = item.get("sample") or {}
        kind = sample.get("kind") or "infra"
        tech = sample.get("tech") or "host"
        table = table_for(kind, tech)
        ts = sample.get("ts")
        row = [datetime.datetime.fromtimestamp(float(ts)) if ts else now,
               kind, tech, item.get("agent") or sample.get("agent") or "", int(sample.get("conn_id") or 0)]
        for f in FIELDS:
            v = sample.get(f, 0) or 0
            row.append(int(v) if f in INT_FIELDS else float(v))
        grouped.setdefault(table, []).append(row)
    try:
        for table, rows in grouped.items():
            if not ensure_table(cli, table):
                return False
            cli.insert("%s.%s" % (CH_DB, table), rows, column_names=COLUMNS)
        if extra_topsql:
            if not _ensure_extra(cli, "top_sql"):
                return False
            cli.insert(f"{CH_DB}.top_sql", extra_topsql, column_names=TOPSQL_COLUMNS)
        if extra_waits:
            if not _ensure_extra(cli, "wait_events"):
                return False
            cli.insert(f"{CH_DB}.wait_events", extra_waits, column_names=WAIT_COLUMNS)
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_batch: %s", e)
        mark_down()
        return False


def history(agent_name=None, minutes=60, kind=None, tech=None, conn_id=None):
    """Samples (newest first). kind/tech pick the exact table; otherwise merge()
    spans the whole metrics_* family. conn_id narrows to one database connection."""
    cli = get_client()
    if cli is None:
        return []
    try:
        if kind or tech:
            source = "%s.%s" % (CH_DB, table_for(kind or ("infra" if tech == "host" else "database"), tech))
        else:
            source = "merge('%s', '^metrics_')" % CH_DB
        where, params = ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes)}
        if agent_name:
            where.append("agent = %(a)s"); params["a"] = agent_name
        if conn_id:
            where.append("conn_id = %(c)s"); params["c"] = int(conn_id)
        # toTimeZone(..., 'UTC') pins the OUTPUT to UTC regardless of this particular
        # ClickHouse server's own display timezone (session tz defaults to whatever
        # the server's OS is set to — UTC here, but not guaranteed elsewhere; see
        # history_bucketed's note). Callers can then always parse `ts` as UTC.
        res = cli.query(
            "SELECT toTimeZone(ts, 'UTC') AS ts, kind, tech, agent, conn_id, " + ", ".join(FIELDS) +
            " FROM " + source + " WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT 5000", parameters=params)
        cols = ["ts", "kind", "tech", "agent", "conn_id"] + list(FIELDS)
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] history: %s", e)
        mark_down()
        return []


def history_bucketed(agent_name=None, minutes=60, bucket_seconds=60, kind=None, tech=None, conn_id=None):
    """Same window as `history()`, averaged into fixed-width time buckets server-side.

    `history()` alone can't serve a real range picker: it caps at 5000 raw rows,
    which is ~20 hours of this agent's own 15s-cadence samples — a "Last 7 Days"
    selection would just silently truncate to under a day with no indication why.
    Bucketing moves the row cap from "how much history" to "how many buckets"
    (a 7-day window at 1-hour buckets is 168 rows, comfortably under the cap
    regardless of how many raw samples fed each one), and doubles as the
    granularity control itself — the "per minute / per 15 min / per hour"
    choice a caller makes IS this bucket width.
    """
    cli = get_client()
    if cli is None:
        return []
    try:
        if kind or tech:
            source = "%s.%s" % (CH_DB, table_for(kind or ("infra" if tech == "host" else "database"), tech))
        else:
            source = "merge('%s', '^metrics_')" % CH_DB
        where, params = ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes), "b": int(bucket_seconds)}
        if agent_name:
            where.append("agent = %(a)s"); params["a"] = agent_name
        if conn_id:
            where.append("conn_id = %(c)s"); params["c"] = int(conn_id)
        # kind/tech/agent/conn_id are NOT re-selected from the aggregate: they're
        # already known from the call's own arguments (this bucket's row always
        # describes the same agent/connection the caller asked for), and aliasing
        # an aggregate to the SAME name as a column filtered in WHERE (any(agent)
        # AS agent, alongside `agent = %(a)s`) hits a real ClickHouse quirk —
        # ILLEGAL_AGGREGATION, "Aggregate function ... is found in WHERE" — because
        # it resolves the WHERE reference to the SELECT alias instead of the
        # underlying column. Simplest fix is to just not create that alias.
        # Same toTimeZone(..., 'UTC') pin as history() above — the bucket boundary
        # is rendered in UTC no matter what timezone this ClickHouse server's OS
        # defaults its DateTime display to (confirmed to differ between this dev
        # WSL install [UTC] and at least one prior deployment [server-local] —
        # this is a per-install setting, not a ClickHouse universal, so the API
        # must not depend on the server's default to stay correct everywhere).
        avg_cols = ", ".join("avg(%s) AS %s" % (f, f) for f in FIELDS)
        res = cli.query(
            "SELECT toTimeZone(toStartOfInterval(ts, INTERVAL %(b)s SECOND), 'UTC') AS bucket, " + avg_cols
            + " FROM " + source + " WHERE " + " AND ".join(where)
            + " GROUP BY bucket ORDER BY bucket DESC LIMIT 5000", parameters=params)
        return [
            {"ts": str(r[0]), "kind": kind or "", "tech": tech or "", "agent": agent_name or "",
             "conn_id": int(conn_id or 0), **dict(zip(FIELDS, r[1:]))}
            for r in res.result_rows
        ]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] history_bucketed: %s", e)
        mark_down()
        return []


def list_tables():
    """Names of the metrics_* tables that exist (for the status endpoint)."""
    cli = get_client()
    if cli is None:
        return []
    try:
        res = cli.query(f"SELECT name FROM system.tables WHERE database='{CH_DB}' "
                        "AND name LIKE 'metrics_%' ORDER BY name")
        return [row[0] for row in res.result_rows]
    except Exception:  # noqa: BLE001
        return sorted(_tables_ready)


def is_up():
    cli = get_client()
    return bool(cli) and ensure_table(cli, "metrics_infra")


# ── Oracle topology historical tables (RAC / Data Guard / ASM) ────────────────
# One source of truth for RAC node/instance history, per-instance Oracle
# Services, Data Guard role/transport/apply lag, ASM diskgroup usage, and
# role-transition (switchover/failover) events. Retention is admin-configurable
# (oracle_ch_retention_service) rather than a hardcoded constant, mirroring the
# actmon_mysql_* tables above exactly. The existing generic metrics_db_oracle
# table (CPU/sessions/uptime) is untouched — these are new, topology-shaped
# tables because a single Oracle connection can now report on MULTIPLE
# instances/services/diskgroups per cycle, which the generic single-row-per-
# connection metrics schema cannot represent.

ORACLE_RAC_NODE_COLUMNS = ["ts", "agent", "conn_id", "instance_number", "instance_name",
                           "host_name", "instance_status", "database_status", "thread_status"]
ORACLE_SERVICE_COLUMNS = ["ts", "agent", "conn_id", "service_name", "instance_number", "status"]
ORACLE_DATAGUARD_COLUMNS = ["ts", "agent", "conn_id", "role", "protection_mode", "protection_level",
                            "open_mode", "transport_status", "apply_status", "transport_lag_sec",
                            "apply_lag_sec", "last_received_seq", "last_applied_seq",
                            "archive_gap", "last_error"]
ORACLE_ASM_COLUMNS = ["ts", "agent", "conn_id", "diskgroup_name", "state", "total_mb", "used_mb",
                      "free_mb", "offline_disks", "rebalance_active"]
ORACLE_ROLE_TRANSITION_COLUMNS = ["ts", "agent", "conn_id", "previous_role", "new_role", "reason"]
ORACLE_STORAGE_COLUMNS = ["ts", "agent", "conn_id", "metric_type", "object_name",
                          "tablespace_name", "segment_type", "size_mb", "total_mb", "used_pct"]
ORACLE_RAC_EVICTION_COLUMNS = ["ts", "agent", "conn_id", "instance_number", "host_name",
                               "previous_status", "new_status", "event_type"]

_ORACLE_EXTRA_DDL = {
    "actmon_oracle_rac_nodes": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_rac_nodes (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            instance_number UInt16, instance_name LowCardinality(String),
            host_name LowCardinality(String), instance_status LowCardinality(String),
            database_status LowCardinality(String), thread_status LowCardinality(String)
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, instance_number, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_services": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_services (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            service_name LowCardinality(String), instance_number UInt16,
            status LowCardinality(String)
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, service_name, instance_number, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_dataguard_history": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_dataguard_history (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            role LowCardinality(String), protection_mode LowCardinality(String),
            protection_level LowCardinality(String), open_mode LowCardinality(String),
            transport_status LowCardinality(String), apply_status LowCardinality(String),
            transport_lag_sec Int64, apply_lag_sec Int64,
            last_received_seq Int64, last_applied_seq Int64,
            archive_gap Int64, last_error String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_asm_history": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_asm_history (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            diskgroup_name LowCardinality(String), state LowCardinality(String),
            total_mb Int64, used_mb Int64, free_mb Int64,
            offline_disks UInt32, rebalance_active UInt8
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, diskgroup_name, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_role_transitions": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_role_transitions (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            previous_role LowCardinality(String), new_role LowCardinality(String), reason String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_storage_history": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_storage_history (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            metric_type LowCardinality(String), object_name String,
            tablespace_name LowCardinality(String), segment_type LowCardinality(String),
            size_mb Float64, total_mb Float64, used_pct Float64
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, metric_type, object_name, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_oracle_rac_eviction_events": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_oracle_rac_eviction_events (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            instance_number UInt16, host_name LowCardinality(String),
            previous_status LowCardinality(String), new_status LowCardinality(String),
            event_type LowCardinality(String)
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, instance_number, ts) TTL ts + INTERVAL %(days)s DAY""",
}


def _oracle_retention_days():
    try:
        from app.services.oracle.oracle_ch_retention_service import get_retention
        return get_retention().events_days
    except Exception:  # noqa: BLE001
        return TTL_DAYS


def _ensure_oracle_table(cli, table):
    """Same idempotent create + MODIFY TTL pattern as _ensure_mysql_table."""
    global _db_ready
    try:
        if not _db_ready:
            cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
            _db_ready = True
        days = _oracle_retention_days()
        if table not in _tables_ready:
            cli.command(_ORACLE_EXTRA_DDL[table] % {"days": int(days), "db": CH_DB})
            _tables_ready.add(table)
        else:
            cli.command(f"ALTER TABLE {CH_DB}.{table} MODIFY TTL ts + INTERVAL {int(days)} DAY")
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] schema (%s): %s", table, e)
        mark_down()
        return False


def flush_oracle_rac_nodes(rows):
    """rows: list of dicts matching ORACLE_RAC_NODE_COLUMNS (minus 'ts'). One
    row per instance per cycle — never raises, matching this file's
    degrade-gracefully contract."""
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_rac_nodes"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in ORACLE_RAC_NODE_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_oracle_rac_nodes", data, column_names=ORACLE_RAC_NODE_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_rac_nodes: %s", e)
        mark_down()


def flush_oracle_services(rows):
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_services"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in ORACLE_SERVICE_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_oracle_services", data, column_names=ORACLE_SERVICE_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_services: %s", e)
        mark_down()


def flush_oracle_dataguard_snapshot(row):
    """Caller should simply NOT call this when Data Guard isn't configured —
    absence of rows in the window is how the report layer tells
    'Standalone / Not Configured' apart from a real outage."""
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_dataguard_history"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in ORACLE_DATAGUARD_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_oracle_dataguard_history", data, column_names=ORACLE_DATAGUARD_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_dataguard_snapshot: %s", e)
        mark_down()


def flush_oracle_asm(rows):
    """Caller should simply NOT call this when ASM isn't configured."""
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_asm_history"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in ORACLE_ASM_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_oracle_asm_history", data, column_names=ORACLE_ASM_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_asm: %s", e)
        mark_down()


def flush_oracle_storage(rows):
    """rows: list of dicts matching ORACLE_STORAGE_COLUMNS (minus 'ts') — one
    row per tablespace plus one per top segment, per cycle (see
    oracle_history_flush_service.flush_storage). Never raises."""
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_storage_history"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in ORACLE_STORAGE_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_oracle_storage_history", data, column_names=ORACLE_STORAGE_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_storage: %s", e)
        mark_down()


def query_oracle_storage(conn_id, metric_type=None, minutes=None, since=None, until=None, limit=5000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        if metric_type:
            where.append("metric_type = %(metric_type)s")
            params["metric_type"] = metric_type
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, metric_type, object_name, tablespace_name, "
            "segment_type, size_mb, total_mb, used_pct "
            f"FROM {CH_DB}.actmon_oracle_storage_history WHERE " + " AND ".join(where) +
            " ORDER BY object_name, ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "metric_type", "object_name", "tablespace_name",
                "segment_type", "size_mb", "total_mb", "used_pct"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_storage: %s", e)
        mark_down()
        return []


def flush_oracle_rac_eviction_event(row):
    """Written only when oracle_history_flush_service.flush_rac_nodes() detects
    an ACTUAL status transition (OPEN->non-OPEN or the reverse) against
    ConnectionMaster.oracle_rac_node_status — never one row per collector
    cycle for a node that's simply been down a while."""
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_rac_eviction_events"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in ORACLE_RAC_EVICTION_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_oracle_rac_eviction_events", data, column_names=ORACLE_RAC_EVICTION_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_rac_eviction_event: %s", e)
        mark_down()


def query_oracle_rac_eviction_events(conn_id, minutes=None, since=None, until=None, limit=200):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, instance_number, host_name, "
            "previous_status, new_status, event_type "
            f"FROM {CH_DB}.actmon_oracle_rac_eviction_events WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "instance_number", "host_name", "previous_status", "new_status", "event_type"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_rac_eviction_events: %s", e)
        mark_down()
        return []


def flush_oracle_role_transition(row):
    """Written only when the collector detects an ACTUAL role change since
    the last cycle (see oracle_history_flush_service) — satisfies §12's
    "generate an event: Oracle Data Guard role transition detected" requirement
    as a real historical record, not a derived/inferred one."""
    cli = get_client()
    if cli is None or not _ensure_oracle_table(cli, "actmon_oracle_role_transitions"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in ORACLE_ROLE_TRANSITION_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_oracle_role_transitions", data, column_names=ORACLE_ROLE_TRANSITION_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_oracle_role_transition: %s", e)
        mark_down()


def query_oracle_rac_nodes(conn_id, minutes=None, since=None, until=None, limit=5000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, instance_number, instance_name, host_name, "
            "instance_status, database_status, thread_status "
            f"FROM {CH_DB}.actmon_oracle_rac_nodes WHERE " + " AND ".join(where) +
            " ORDER BY instance_number, ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "instance_number", "instance_name", "host_name",
                "instance_status", "database_status", "thread_status"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_rac_nodes: %s", e)
        mark_down()
        return []


def query_oracle_services(conn_id, minutes=None, since=None, until=None, limit=5000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, service_name, instance_number, status "
            f"FROM {CH_DB}.actmon_oracle_services WHERE " + " AND ".join(where) +
            " ORDER BY service_name, instance_number, ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "service_name", "instance_number", "status"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_services: %s", e)
        mark_down()
        return []


def query_oracle_dataguard_history(conn_id, minutes=None, since=None, until=None, limit=1000):
    """Empty list means 'no rows in this window' — caller must render that as
    Standalone/Not-Configured-or-no-data, never as fabricated zero metrics."""
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, role, protection_mode, protection_level, open_mode, "
            "transport_status, apply_status, transport_lag_sec, apply_lag_sec, "
            "last_received_seq, last_applied_seq, archive_gap, last_error "
            f"FROM {CH_DB}.actmon_oracle_dataguard_history WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "role", "protection_mode", "protection_level", "open_mode",
                "transport_status", "apply_status", "transport_lag_sec", "apply_lag_sec",
                "last_received_seq", "last_applied_seq", "archive_gap", "last_error"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_dataguard_history: %s", e)
        mark_down()
        return []


def query_oracle_asm(conn_id, minutes=None, since=None, until=None, limit=1000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, diskgroup_name, state, total_mb, used_mb, "
            "free_mb, offline_disks, rebalance_active "
            f"FROM {CH_DB}.actmon_oracle_asm_history WHERE " + " AND ".join(where) +
            " ORDER BY diskgroup_name, ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "diskgroup_name", "state", "total_mb", "used_mb",
                "free_mb", "offline_disks", "rebalance_active"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_asm: %s", e)
        mark_down()
        return []


def query_oracle_role_transitions(conn_id, minutes=None, since=None, until=None, limit=200):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, previous_role, new_role, reason "
            f"FROM {CH_DB}.actmon_oracle_role_transitions WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "previous_role", "new_role", "reason"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_oracle_role_transitions: %s", e)
        mark_down()
        return []


# ═════════════════════════════════════════════════════════════════════════════
#  PostgreSQL Patroni — cluster/member history + leader-transition events
#  Same _ensure_*/flush_*/query_* pattern as the Oracle RAC/DG tables above.
# ═════════════════════════════════════════════════════════════════════════════

POSTGRES_PATRONI_MEMBER_COLUMNS = ["ts", "agent", "conn_id", "member_name", "role", "state",
                                   "timeline", "receive_lag", "replay_lag", "patroni_state"]
POSTGRES_PATRONI_TRANSITION_COLUMNS = ["ts", "agent", "conn_id", "event_type",
                                       "previous_leader", "new_leader", "reason"]

_POSTGRES_PATRONI_DDL = {
    "actmon_postgres_patroni_members": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_postgres_patroni_members (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            member_name LowCardinality(String), role LowCardinality(String),
            state LowCardinality(String), timeline UInt32,
            receive_lag Int64, replay_lag Int64, patroni_state LowCardinality(String)
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, member_name, ts) TTL ts + INTERVAL %(days)s DAY""",
    "actmon_postgres_patroni_transitions": """
        CREATE TABLE IF NOT EXISTS %(db)s.actmon_postgres_patroni_transitions (
            ts DateTime, agent LowCardinality(String), conn_id UInt32,
            event_type LowCardinality(String), previous_leader LowCardinality(String),
            new_leader LowCardinality(String), reason String
        ) ENGINE = MergeTree PARTITION BY toYYYYMM(ts)
          ORDER BY (conn_id, ts) TTL ts + INTERVAL %(days)s DAY""",
}


def _postgres_patroni_retention_days():
    try:
        from app.services.postgres.postgres_patroni_ch_retention_service import get_retention
        return get_retention().events_days
    except Exception:  # noqa: BLE001
        return TTL_DAYS


def _ensure_postgres_patroni_table(cli, table):
    global _db_ready
    try:
        if not _db_ready:
            cli.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
            _db_ready = True
        days = _postgres_patroni_retention_days()
        if table not in _tables_ready:
            cli.command(_POSTGRES_PATRONI_DDL[table] % {"days": int(days), "db": CH_DB})
            _tables_ready.add(table)
        else:
            cli.command(f"ALTER TABLE {CH_DB}.{table} MODIFY TTL ts + INTERVAL {int(days)} DAY")
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] schema (%s): %s", table, e)
        mark_down()
        return False


def flush_postgres_patroni_members(rows):
    """rows: list of dicts matching POSTGRES_PATRONI_MEMBER_COLUMNS (minus 'ts').
    One row per member per cycle."""
    if not rows:
        return
    cli = get_client()
    if cli is None or not _ensure_postgres_patroni_table(cli, "actmon_postgres_patroni_members"):
        return
    try:
        import datetime
        data = [[r.get("ts") or datetime.datetime.now()] + [r.get(c) for c in POSTGRES_PATRONI_MEMBER_COLUMNS[1:]] for r in rows]
        cli.insert(f"{CH_DB}.actmon_postgres_patroni_members", data, column_names=POSTGRES_PATRONI_MEMBER_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_postgres_patroni_members: %s", e)
        mark_down()


def flush_postgres_patroni_transition(row):
    """Written only when the collector detects an ACTUAL leader change since
    the last cycle — a real event, not an inferred one (same discipline as
    flush_oracle_role_transition)."""
    cli = get_client()
    if cli is None or not _ensure_postgres_patroni_table(cli, "actmon_postgres_patroni_transitions"):
        return
    try:
        import datetime
        data = [[row.get("ts") or datetime.datetime.now()] + [row.get(c) for c in POSTGRES_PATRONI_TRANSITION_COLUMNS[1:]]]
        cli.insert(f"{CH_DB}.actmon_postgres_patroni_transitions", data, column_names=POSTGRES_PATRONI_TRANSITION_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] flush_postgres_patroni_transition: %s", e)
        mark_down()


def query_postgres_patroni_members(conn_id, minutes=None, since=None, until=None, limit=5000):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, member_name, role, state, timeline, "
            "receive_lag, replay_lag, patroni_state "
            f"FROM {CH_DB}.actmon_postgres_patroni_members WHERE " + " AND ".join(where) +
            " ORDER BY member_name, ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "member_name", "role", "state", "timeline", "receive_lag", "replay_lag", "patroni_state"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_postgres_patroni_members: %s", e)
        mark_down()
        return []


def query_postgres_patroni_transitions(conn_id, minutes=None, since=None, until=None, limit=200):
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = _window_where(conn_id, minutes, since, until)
        res = cli.query(
            "SELECT toTimeZone(ts,'UTC') AS ts, event_type, previous_leader, new_leader, reason "
            f"FROM {CH_DB}.actmon_postgres_patroni_transitions WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT %(lim)s", parameters={**params, "lim": int(limit)})
        cols = ["ts", "event_type", "previous_leader", "new_leader", "reason"]
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] query_postgres_patroni_transitions: %s", e)
        mark_down()
        return []
