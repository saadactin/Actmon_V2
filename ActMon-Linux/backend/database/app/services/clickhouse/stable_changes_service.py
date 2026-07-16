"""
ClickHouse stable-changes log — an audit trail of slowly-changing facts.
========================================================================

Written ONLY when the stable store detects drift (never on the 15s cycle):

  actmon.stable_changes
    ts · kind · tech · agent · conn_id · field · old_value · new_value

Examples of rows that land here: "version: 8.0.36 → 8.0.37",
"databases: [...] → [...]" (database added/dropped), "max_connections: 100 → 200".

Reuses the shared actmon_logs ClickHouse connection; degrades with cooldown.
"""

import time
import logging

logger = logging.getLogger("stable_changes")

_COOLDOWN = 15.0
_next_retry = 0.0
_table_ready = False

_COLUMNS = ["ts", "kind", "tech", "agent", "conn_id", "field", "old_value", "new_value"]


def get_client():
    global _next_retry
    if time.monotonic() < _next_retry:
        return None
    try:
        from actmon_logs import core as logs_core
        return logs_core.get_client()
    except Exception:  # noqa: BLE001
        _next_retry = time.monotonic() + _COOLDOWN
        return None


def _mark_down():
    global _next_retry, _table_ready
    _table_ready = False
    _next_retry = time.monotonic() + _COOLDOWN


def _ensure_table(cli):
    global _table_ready
    if _table_ready:
        return True
    try:
        cli.command("CREATE DATABASE IF NOT EXISTS actmon")
        cli.command("""
            CREATE TABLE IF NOT EXISTS actmon.stable_changes (
                ts        DateTime,
                kind      LowCardinality(String),
                tech      LowCardinality(String),
                agent     LowCardinality(String),
                conn_id   UInt32,
                field     LowCardinality(String),
                old_value String,
                new_value String
            ) ENGINE = MergeTree
              PARTITION BY toYYYYMM(ts)
              ORDER BY (kind, tech, agent, ts)
        """)
        _table_ready = True
        return True
    except Exception as e:  # noqa: BLE001
        logger.debug("[stable_changes] schema: %s", e)
        _mark_down()
        return False


def log_changes(agent_name, changes, kind, tech, conn_id=0):
    """Insert one row per changed field. Never raises."""
    if not changes:
        return
    cli = get_client()
    if cli is None or not _ensure_table(cli):
        return
    try:
        import datetime
        now = datetime.datetime.utcnow()
        rows = [[now, kind or "infra", tech or "host", agent_name, int(conn_id or 0),
                 c.get("field") or "", c.get("old") or "", c.get("new") or ""]
                for c in changes]
        cli.insert("actmon.stable_changes", rows, column_names=_COLUMNS)
    except Exception as e:  # noqa: BLE001
        logger.debug("[stable_changes] insert: %s", e)
        _mark_down()


def history(agent_name=None, minutes=1440, kind=None, tech=None):
    """Change log, newest first (default: last 24h)."""
    cli = get_client()
    if cli is None:
        return []
    try:
        where, params = ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes)}
        if agent_name:
            where.append("agent = %(a)s"); params["a"] = agent_name
        if kind:
            where.append("kind = %(k)s"); params["k"] = kind
        if tech:
            where.append("tech = %(t)s"); params["t"] = tech
        res = cli.query(
            "SELECT ts, kind, tech, agent, conn_id, field, old_value, new_value"
            " FROM actmon.stable_changes WHERE " + " AND ".join(where) +
            " ORDER BY ts DESC LIMIT 2000", parameters=params)
        return [dict(zip(_COLUMNS, [str(r[0])] + list(r[1:]))) for r in res.result_rows]
    except Exception as e:  # noqa: BLE001
        logger.debug("[stable_changes] history: %s", e)
        _mark_down()
        return []
