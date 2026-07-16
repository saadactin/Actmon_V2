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

# Numeric fields carried through the pipeline (mirror of AgentMetric).
FIELDS = ("host_cpu", "host_memory", "db_cpu", "active_sessions", "connections_used",
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
            cli.command("CREATE DATABASE IF NOT EXISTS actmon")
            _db_ready = True
        cli.command(f"""
            CREATE TABLE IF NOT EXISTS actmon.{table} (
                ts               DateTime,
                kind             LowCardinality(String),
                tech             LowCardinality(String),
                agent            LowCardinality(String),
                conn_id          UInt32,
                host_cpu         Float64,
                host_memory      Float64,
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
        row = [datetime.datetime.utcfromtimestamp(float(ts)) if ts else datetime.datetime.utcnow(),
               kind, tech, agent_name, int(sample.get("conn_id") or 0)]
        for f in FIELDS:
            v = sample.get(f, 0) or 0
            row.append(int(v) if f in INT_FIELDS else float(v))
        cli.insert("actmon.%s" % table, [row], column_names=COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] insert (%s): %s", table, e)
        mark_down()


def history(agent_name=None, minutes=60, kind=None, tech=None, conn_id=None):
    """Samples (newest first). kind/tech pick the exact table; otherwise merge()
    spans the whole metrics_* family. conn_id narrows to one database connection."""
    cli = get_client()
    if cli is None:
        return []
    try:
        if kind or tech:
            source = "actmon.%s" % table_for(kind or ("infra" if tech == "host" else "database"), tech)
        else:
            source = "merge('actmon', '^metrics_')"
        where, params = ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes)}
        if agent_name:
            where.append("agent = %(a)s"); params["a"] = agent_name
        if conn_id:
            where.append("conn_id = %(c)s"); params["c"] = int(conn_id)
        res = cli.query(
            "SELECT ts, kind, tech, agent, conn_id, " + ", ".join(FIELDS) +
            " FROM " + source + " WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT 5000", parameters=params)
        cols = ["ts", "kind", "tech", "agent", "conn_id"] + list(FIELDS)
        return [dict(zip(cols, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[metrics_history] history: %s", e)
        mark_down()
        return []


def list_tables():
    """Names of the metrics_* tables that exist (for the status endpoint)."""
    cli = get_client()
    if cli is None:
        return []
    try:
        res = cli.query("SELECT name FROM system.tables WHERE database='actmon' "
                        "AND name LIKE 'metrics_%' ORDER BY name")
        return [row[0] for row in res.result_rows]
    except Exception:  # noqa: BLE001
        return sorted(_tables_ready)


def is_up():
    cli = get_client()
    return bool(cli) and ensure_table(cli, "metrics_infra")
