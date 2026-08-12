"""
Centralized Agent Collector Service
====================================
This is the ONLY component that connects to monitored databases.
It runs as a background thread, collects metrics from each registered agent's
database, and stores results in the ACTMON PostgreSQL repository.

All other consumers (frontend, application servers) read pre-collected data
via the /api/v1/agents/* REST API — they never connect to the monitored DB.
"""

import os as _os
import threading
import time
import time as _time
import logging
import datetime
from hashlib import md5
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text, func
from sqlalchemy.pool import NullPool

from app.database.connection import SessionLocal
from app.models.agent_model import (
    Agent, AgentMetric, AgentTopSQL, AgentWaitEvent,
    AgentNotification, AgentOracleSnapshot,
)
from app.models.connection_model import ConnectionMaster
from app.services.agent import monitoring_settings_service
from app.services.common import service_state_service

logger = logging.getLogger("agent_collector")

_stop_event = threading.Event()
_thread = None

# ─────────────────────────────────────────────────────────────
# Threshold configuration (can be moved to env vars later)
# ─────────────────────────────────────────────────────────────
CONN_WARN_PCT = 75
CONN_CRIT_PCT = 90
CACHE_WARN_PCT = 85   # below this → warning


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _ti(v, d=0):
    try:
        return int(v)
    except Exception:
        # Agent-routed rows arrive JSON-serialised: Oracle NUMBERs come back as
        # strings like "594.9" — int() alone rejects those.
        try:
            return int(float(v))
        except Exception:
            return d


def _tf(v, d=0.0):
    try:
        return float(v)
    except Exception:
        return d


def _check_thresholds(agent_name: str, connections_used: int, connections_max: int,
                      cache_hit: float, db):
    """Emit AgentNotification rows when thresholds are breached."""
    conn_pct = connections_used / max(connections_max, 1) * 100
    if conn_pct >= CONN_CRIT_PCT:
        db.add(AgentNotification(
            agent_name=agent_name,
            message=(f"Critical: connection usage {conn_pct:.1f}%"
                     f" ({connections_used}/{connections_max})"),
            severity="critical",
        ))
    elif conn_pct >= CONN_WARN_PCT:
        db.add(AgentNotification(
            agent_name=agent_name,
            message=(f"Warning: connection usage {conn_pct:.1f}%"
                     f" ({connections_used}/{connections_max})"),
            severity="warning",
        ))
    if cache_hit < CACHE_WARN_PCT:
        db.add(AgentNotification(
            agent_name=agent_name,
            message=f"Warning: buffer cache hit ratio low at {cache_hit:.1f}%",
            severity="warning",
        ))


def _check_thresholds_from_latest_metric(agent_name: str, db):
    """Phase 2, step 2: push-covered engines (mysql/postgres/mssql) get their
    AgentMetric rows from the agent's own push loop now, not a pull-side query —
    read the row push already stored instead of re-deriving connections/cache-hit
    with another round-trip to the monitored DB."""
    row = (db.query(AgentMetric)
           .filter(AgentMetric.agent_name == agent_name)
           .order_by(AgentMetric.timestamp.desc())
           .first())
    if row:
        _check_thresholds(agent_name, row.connections_used, row.connections_max,
                           row.cache_hit_pct, db)


# ─────────────────────────────────────────────────────────────
# MySQL collector
# ─────────────────────────────────────────────────────────────

def _store_mysql_metrics(agent_name, status, variables, db):
    uptime = _ti(status.get("Uptime", 1)) or 1
    threads_connected = _ti(status.get("Threads_connected", 0))
    threads_running = _ti(status.get("Threads_running", 0))
    max_connections = _ti(variables.get("max_connections", 151))
    questions = _ti(status.get("Questions", 0))
    commits = _ti(status.get("Com_commit", 0))
    rollbacks = _ti(status.get("Com_rollback", 0))
    bp_read_req = _ti(status.get("Innodb_buffer_pool_read_requests", 0))
    bp_reads = _ti(status.get("Innodb_buffer_pool_reads", 0))

    _bp_total = bp_read_req + bp_reads
    cache_hit = round(bp_read_req / _bp_total * 100, 2) if _bp_total > 0 else 100.0
    qps = round(questions / uptime, 2)
    tps = round((commits + rollbacks) / uptime, 2)
    db_cpu_pct = round(threads_running / max(max_connections, 1) * 100, 2)

    db.add(AgentMetric(
        agent_name=agent_name, host_cpu=0.0, host_memory=0.0, db_cpu=db_cpu_pct,
        active_sessions=threads_running, connections_used=threads_connected,
        connections_max=max_connections, cache_hit_pct=cache_hit,
        qps=qps, tps=tps, uptime_seconds=uptime,
    ))
    _check_thresholds(agent_name, threads_connected, max_connections, cache_hit, db)


def _collect_mysql(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    # Prefer the host agent (the DB is usually on the agent host's localhost, which
    # the backend cannot reach directly). Falls through to a direct connection if the
    # connection isn't linked to an agent host, or the agent is unreachable.
    try:
        from app.services.common.db_proxy_service import make_runner
        runner = make_runner(conn_rec, db)
        if getattr(runner, "via", "direct") == "agent":
            status = {r[0]: r[1] for r in runner("SHOW GLOBAL STATUS")}
            variables = {r[0]: r[1] for r in runner("SHOW GLOBAL VARIABLES")}
            _store_mysql_metrics(agent_name, status, variables, db)
            return True
    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] MySQL (agent) failed for {agent_name}: {exc}")
        # The agent ran the query itself and got back a definitive DB-level error
        # (agent-side prefix "query failed: ...", from actmon_agent.py) — the DB is
        # confirmed unreachable, not just the agent. A direct attempt would almost
        # certainly hit the exact same wall ~10s slower (connect_timeout); skip it.
        if str(exc).startswith("query failed:"):
            return False
        # Otherwise the agent itself didn't answer (transport/timeout) — we don't
        # actually know if the DB is up, so a direct attempt is still worth trying.

    enc_pass = quote_plus(conn_rec.password or "")
    url = (
        f"mysql+pymysql://{conn_rec.username}:{enc_pass}"
        f"@{conn_rec.host}:{conn_rec.port}/{conn_rec.database_name or ''}"
    )
    try:
        eng = create_engine(
            url,
            connect_args={"connect_timeout": 10, "read_timeout": 20},
            poolclass=NullPool,
        )
        with eng.connect() as conn:
            status = {r[0]: r[1] for r in conn.execute(text("SHOW GLOBAL STATUS")).fetchall()}
            variables = {r[0]: r[1] for r in conn.execute(text("SHOW GLOBAL VARIABLES")).fetchall()}
            _store_mysql_metrics(agent_name, status, variables, db)

            # Performance Schema — Top SQL & Wait Events (direct connection only)
            ps_enabled = variables.get("performance_schema", "OFF").upper() == "ON"
            if ps_enabled:
                _collect_mysql_top_sql(agent_name, conn, db)
                _collect_mysql_wait_events(agent_name, conn, db)

        eng.dispose()
        return True

    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] MySQL failed for {agent_name}: {exc}")
        return False


def _collect_mysql_top_sql(agent_name: str, conn, db):
    try:
        rows = conn.execute(text("""
            SELECT SUBSTRING(DIGEST_TEXT, 1, 2000),
                   COUNT_STAR,
                   ROUND(AVG_TIMER_WAIT / 1e9, 3),
                   ROUND(MAX_TIMER_WAIT / 1e9, 3),
                   ROUND(SUM_TIMER_WAIT / 1e9, 3),
                   ROUND(SUM_ROWS_EXAMINED / NULLIF(COUNT_STAR, 0), 1),
                   ROUND(SUM_ROWS_SENT / NULLIF(COUNT_STAR, 0), 1),
                   DIGEST
            FROM performance_schema.events_statements_summary_by_digest
            WHERE DIGEST_TEXT IS NOT NULL
            ORDER BY SUM_TIMER_WAIT DESC LIMIT 50
        """)).fetchall()
        for r in rows:
            sql_text = str(r[0] or "")
            digest = str(r[7] or "")
            sql_id = digest[:16] if digest else md5(sql_text.encode()).hexdigest()[:16]
            db.add(AgentTopSQL(
                agent_name=agent_name,
                sql_id=sql_id,
                sql_text=sql_text,
                executions=_ti(r[1]),
                avg_elapsed_ms=_tf(r[2]),
                cpu_time_ms=_tf(r[4]),
                buffer_gets=0,
                total_ms=_tf(r[4]),
                max_ms=_tf(r[3]),
                rows_examined=_tf(r[5]),
                rows_sent=_tf(r[6]),
            ))
    except Exception as exc:
        logger.debug(f"[agent_collector] MySQL top SQL skipped: {exc}")


def _collect_mysql_wait_events(agent_name: str, conn, db):
    try:
        rows = conn.execute(text("""
            SELECT EVENT_NAME,
                   SUBSTRING_INDEX(EVENT_NAME, '/', 2),
                   COUNT_STAR,
                   ROUND(SUM_TIMER_WAIT / 1e9, 3),
                   ROUND(AVG_TIMER_WAIT / 1e9, 3)
            FROM performance_schema.events_waits_summary_global_by_event_name
            WHERE COUNT_STAR > 0 AND EVENT_NAME NOT LIKE '%idle%'
            ORDER BY SUM_TIMER_WAIT DESC LIMIT 20
        """)).fetchall()
        for r in rows:
            db.add(AgentWaitEvent(
                agent_name=agent_name,
                event_name=str(r[0] or ""),
                wait_class=str(r[1] or ""),
                time_waited_ms=_tf(r[3]),
                avg_ms=_tf(r[4]),
                count=_ti(r[2]),
            ))
    except Exception as exc:
        logger.debug(f"[agent_collector] MySQL wait events skipped: {exc}")


# ─────────────────────────────────────────────────────────────
# PostgreSQL collector
# ─────────────────────────────────────────────────────────────

def _collect_postgres(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    enc_pass = quote_plus(conn_rec.password or "")
    ssl = conn_rec.ssl_mode or "prefer"
    db_name = conn_rec.database_name or "postgres"
    url = (
        f"postgresql://{conn_rec.username}:{enc_pass}"
        f"@{conn_rec.host}:{conn_rec.port}/{db_name}?sslmode={ssl}"
    )
    try:
        # Agent-hosted Postgres (localhost on the DB box) routes through the agent;
        # direct connections keep the plain engine unchanged.
        from app.services.common import db_proxy_service
        eng = db_proxy_service.engine_for(
            conn_rec, lambda: create_engine(url, connect_args={"connect_timeout": 10}, poolclass=NullPool))
        with eng.connect() as conn:
            # Active / total connections
            act_row = conn.execute(text("""
                SELECT
                    COUNT(*) FILTER (WHERE state = 'active') AS active,
                    COUNT(*)                                  AS total,
                    (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conn
                FROM pg_stat_activity
            """)).fetchone()
            active_sessions = _ti(act_row[0]) if act_row else 0
            total_conn = _ti(act_row[1]) if act_row else 0
            max_conn = _ti(act_row[2]) if act_row else 100

            # DB stats (cache + xact)
            db_row = conn.execute(text("""
                SELECT blks_hit, blks_read, xact_commit, xact_rollback
                FROM pg_stat_database
                WHERE datname = current_database()
            """)).fetchone()
            blks_hit = _ti(db_row[0]) if db_row else 0
            blks_read = _ti(db_row[1]) if db_row else 0
            xact_commit = _ti(db_row[2]) if db_row else 0
            xact_rollback = _ti(db_row[3]) if db_row else 0
            cache_hit = round(blks_hit / max(blks_hit + blks_read, 1) * 100, 2)

            # Uptime
            up_row = conn.execute(text(
                "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint"
            )).fetchone()
            uptime = _ti(up_row[0]) if up_row else 0

            qps = round((xact_commit + xact_rollback) / max(uptime, 1), 2)

            db.add(AgentMetric(
                agent_name=agent_name,
                host_cpu=0.0,
                host_memory=0.0,
                db_cpu=round(active_sessions / max(max_conn, 1) * 100, 2),
                active_sessions=active_sessions,
                connections_used=total_conn,
                connections_max=max_conn,
                cache_hit_pct=cache_hit,
                qps=qps,
                tps=qps,
                uptime_seconds=uptime,
            ))

            # Top SQL (pg_stat_statements if available)
            _collect_postgres_top_sql(agent_name, conn, db)

            # Wait events from pg_stat_activity
            _collect_postgres_wait_events(agent_name, conn, db)

            _check_thresholds(agent_name, total_conn, max_conn, cache_hit, db)

        eng.dispose()
        return True

    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] PostgreSQL failed for {agent_name}: {exc}")
        return False


def _collect_postgres_top_sql(agent_name: str, conn, db):
    try:
        rows = conn.execute(text("""
            SELECT query, calls,
                   round(mean_exec_time::numeric, 3),
                   round(total_exec_time::numeric, 3),
                   round(max_exec_time::numeric, 3),
                   rows,
                   queryid::text
            FROM pg_stat_statements
            ORDER BY total_exec_time DESC LIMIT 50
        """)).fetchall()
        for r in rows:
            sql_text = str(r[0] or "")
            qid = str(r[6] or "")
            sql_id = qid[:16] if qid else md5(sql_text.encode()).hexdigest()[:16]
            db.add(AgentTopSQL(
                agent_name=agent_name,
                sql_id=sql_id,
                sql_text=sql_text[:2000],
                executions=_ti(r[1]),
                avg_elapsed_ms=_tf(r[2]),
                cpu_time_ms=_tf(r[3]),
                buffer_gets=0,
                total_ms=_tf(r[3]),
                max_ms=_tf(r[4]),
                rows_examined=_tf(r[5]),
                rows_sent=0.0,
            ))
    except Exception as exc:
        logger.debug(f"[agent_collector] PG top SQL skipped: {exc}")


def _collect_postgres_wait_events(agent_name: str, conn, db):
    try:
        rows = conn.execute(text("""
            SELECT wait_event_type, wait_event, count(*)
            FROM pg_stat_activity
            WHERE wait_event IS NOT NULL
            GROUP BY wait_event_type, wait_event
            ORDER BY count(*) DESC LIMIT 20
        """)).fetchall()
        for r in rows:
            db.add(AgentWaitEvent(
                agent_name=agent_name,
                event_name=str(r[1] or ""),
                wait_class=str(r[0] or ""),
                time_waited_ms=0.0,
                avg_ms=0.0,
                count=_ti(r[2]),
            ))
    except Exception as exc:
        logger.debug(f"[agent_collector] PG wait events skipped: {exc}")


def _collect_postgres_wait_events_only(agent_name: str, conn_rec: ConnectionMaster, db):
    """Phase 2, step 2: the agent's push loop already covers Postgres metrics/
    top-SQL/sessions — wait-events has no push equivalent, so this lightweight
    round-trip is the only pull-side query still worth running once the probe
    has already confirmed the DB is up. Best-effort only, never affects status."""
    enc_pass = quote_plus(conn_rec.password or "")
    ssl = conn_rec.ssl_mode or "prefer"
    db_name = conn_rec.database_name or "postgres"
    url = (
        f"postgresql://{conn_rec.username}:{enc_pass}"
        f"@{conn_rec.host}:{conn_rec.port}/{db_name}?sslmode={ssl}"
    )
    try:
        from app.services.common import db_proxy_service
        eng = db_proxy_service.engine_for(
            conn_rec, lambda: create_engine(url, connect_args={"connect_timeout": 10}, poolclass=NullPool))
        with eng.connect() as conn:
            _collect_postgres_wait_events(agent_name, conn, db)
        eng.dispose()
    except Exception as exc:
        logger.debug(f"[agent_collector] PG wait-events-only skipped for {agent_name}: {exc}")


# ─────────────────────────────────────────────────────────────
# Oracle collector
# ─────────────────────────────────────────────────────────────

def _collect_oracle(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
        # Agent-hosted Oracle (localhost on the DB box) → run every query THROUGH the
        # agent; the backend can't reach it and has no oracledb driver. Standalone
        # Oracle at a reachable address keeps the direct driver path.
        from app.services.common import db_proxy_service
        _closer = lambda: None  # noqa: E731
        if db_proxy_service.agent_host_for_conn(conn_rec.id, db) is not None:
            q = db_proxy_service.make_runner(conn_rec, db)
        else:
            import oracledb  # type: ignore
            dsn = conn_rec.oracle_connect_string or conn_rec.tns_descriptor
            if not dsn and conn_rec.host:
                svc = conn_rec.service_name or conn_rec.sid or ""
                dsn = f"{conn_rec.host}:{conn_rec.port or 1521}/{svc}"
            oracle_conn = oracledb.connect(
                user=conn_rec.username,
                password=conn_rec.password,
                dsn=dsn,
            )
            cursor = oracle_conn.cursor()

            def q(sql):
                cursor.execute(sql)
                return cursor.fetchall()

            def _closer():
                cursor.close()
                oracle_conn.close()

        # Instance info
        rows = q("""
            SELECT i.version, i.instance_name, i.host_name,
                   TO_CHAR(i.startup_time, 'YYYY-MM-DD HH24:MI:SS'),
                   d.log_mode, d.open_mode, i.database_status,
                   i.instance_role, i.status, i.archiver
            FROM v$instance i, v$database d
            WHERE rownum = 1
        """)
        row = rows[0] if rows else None
        if row:
            # SGA / PGA
            sga_rows = q("SELECT SUM(value) FROM v$sga")
            sga_bytes = _ti(sga_rows[0][0]) if sga_rows else 0

            pga_rows = q("SELECT SUM(pga_alloc_mem) FROM v$process")
            pga_bytes = _ti(pga_rows[0][0]) if pga_rows else 0

            snap = AgentOracleSnapshot(
                agent_name=agent_name,
                version=str(row[0] or ""),
                instance_name=str(row[1] or ""),
                startup_time=str(row[3] or ""),
                sga_size_bytes=sga_bytes,
                pga_size_bytes=pga_bytes,
                log_mode=str(row[4] or ""),
                open_mode=str(row[5] or ""),
                database_status=str(row[6] or ""),
                instance_role=str(row[7] or ""),
                status=str(row[8] or ""),
                archiver=str(row[9] or ""),
            )
            db.add(snap)

        # Active sessions
        act_rows = q("SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND type = 'USER'")
        active = _ti(act_rows[0][0]) if act_rows else 0

        tot_rows = q("SELECT COUNT(*) FROM v$session WHERE type = 'USER'")
        total = _ti(tot_rows[0][0]) if tot_rows else 0

        max_rows = q("SELECT value FROM v$parameter WHERE name = 'sessions'")
        max_sess = _ti(max_rows[0][0], 100) if max_rows else 100

        # Uptime in seconds
        up_rows = q("SELECT (SYSDATE - startup_time) * 86400 FROM v$instance")
        uptime = _ti(up_rows[0][0]) if up_rows else 0

        db.add(AgentMetric(
            agent_name=agent_name,
            host_cpu=0.0,
            host_memory=0.0,
            db_cpu=round(active / max(max_sess, 1) * 100, 2),
            active_sessions=active,
            connections_used=total,
            connections_max=max_sess,
            cache_hit_pct=0.0,
            qps=0.0,
            tps=0.0,
            uptime_seconds=uptime,
        ))

        # Top SQL
        for r in q("""
            SELECT sql_id, SUBSTR(sql_text, 1, 2000),
                   executions, elapsed_time / 1000.0 / NULLIF(executions, 0),
                   cpu_time / 1000.0, buffer_gets,
                   elapsed_time / 1000.0
            FROM v$sqlarea
            WHERE executions > 0
            ORDER BY elapsed_time DESC FETCH FIRST 50 ROWS ONLY
        """):
            db.add(AgentTopSQL(
                agent_name=agent_name,
                sql_id=str(r[0] or ""),
                sql_text=str(r[1] or "")[:2000],
                executions=_ti(r[2]),
                avg_elapsed_ms=_tf(r[3]),
                cpu_time_ms=_tf(r[4]),
                buffer_gets=_ti(r[5]),
                total_ms=_tf(r[6]),
                max_ms=0.0,
            ))

        # Wait events
        for r in q("""
            SELECT event, wait_class, time_waited / 100.0,
                   time_waited / 100.0 / NULLIF(total_waits, 0), total_waits
            FROM v$system_event
            WHERE wait_class != 'Idle'
            ORDER BY time_waited DESC FETCH FIRST 20 ROWS ONLY
        """):
            db.add(AgentWaitEvent(
                agent_name=agent_name,
                event_name=str(r[0] or ""),
                wait_class=str(r[1] or ""),
                time_waited_ms=_tf(r[2]),
                avg_ms=_tf(r[3]),
                count=_ti(r[4]),
            ))

        _closer()
        return True

    except ImportError:
        logger.debug(f"[agent_collector] oracledb not installed; Oracle agent '{agent_name}' uses push API.")
        return False
    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] Oracle failed for {agent_name}: {exc}")
        return False


def _collect_oracle_extras_only(agent_name: str, conn_rec: ConnectionMaster, db):
    """Phase 3, step 2: push already covers Oracle metrics/top-SQL — the instance
    snapshot (version/SGA/PGA/log mode/...) and wait-events have no push
    equivalent, so this is the only pull-side round-trip still worth running once
    the probe has already confirmed the DB is up. Best-effort only, never affects
    status."""
    try:
        from app.services.common import db_proxy_service
        _closer = lambda: None  # noqa: E731
        if db_proxy_service.agent_host_for_conn(conn_rec.id, db) is not None:
            q = db_proxy_service.make_runner(conn_rec, db)
        else:
            import oracledb  # type: ignore
            dsn = conn_rec.oracle_connect_string or conn_rec.tns_descriptor
            if not dsn and conn_rec.host:
                svc = conn_rec.service_name or conn_rec.sid or ""
                dsn = f"{conn_rec.host}:{conn_rec.port or 1521}/{svc}"
            oracle_conn = oracledb.connect(user=conn_rec.username, password=conn_rec.password, dsn=dsn)
            cursor = oracle_conn.cursor()

            def q(sql):
                cursor.execute(sql)
                return cursor.fetchall()

            def _closer():
                cursor.close()
                oracle_conn.close()

        rows = q("""
            SELECT i.version, i.instance_name, i.host_name,
                   TO_CHAR(i.startup_time, 'YYYY-MM-DD HH24:MI:SS'),
                   d.log_mode, d.open_mode, i.database_status,
                   i.instance_role, i.status, i.archiver
            FROM v$instance i, v$database d
            WHERE rownum = 1
        """)
        row = rows[0] if rows else None
        if row:
            sga_rows = q("SELECT SUM(value) FROM v$sga")
            sga_bytes = _ti(sga_rows[0][0]) if sga_rows else 0
            pga_rows = q("SELECT SUM(pga_alloc_mem) FROM v$process")
            pga_bytes = _ti(pga_rows[0][0]) if pga_rows else 0
            db.add(AgentOracleSnapshot(
                agent_name=agent_name,
                version=str(row[0] or ""),
                instance_name=str(row[1] or ""),
                startup_time=str(row[3] or ""),
                sga_size_bytes=sga_bytes,
                pga_size_bytes=pga_bytes,
                log_mode=str(row[4] or ""),
                open_mode=str(row[5] or ""),
                database_status=str(row[6] or ""),
                instance_role=str(row[7] or ""),
                status=str(row[8] or ""),
                archiver=str(row[9] or ""),
            ))

        for r in q("""
            SELECT event, wait_class, time_waited / 100.0,
                   time_waited / 100.0 / NULLIF(total_waits, 0), total_waits
            FROM v$system_event
            WHERE wait_class != 'Idle'
            ORDER BY time_waited DESC FETCH FIRST 20 ROWS ONLY
        """):
            db.add(AgentWaitEvent(
                agent_name=agent_name,
                event_name=str(r[0] or ""),
                wait_class=str(r[1] or ""),
                time_waited_ms=_tf(r[2]),
                avg_ms=_tf(r[3]),
                count=_ti(r[4]),
            ))

        _closer()
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"[agent_collector] Oracle extras-only skipped for {agent_name}: {exc}")


# ─────────────────────────────────────────────────────────────
# MongoDB collector
# ─────────────────────────────────────────────────────────────

def _collect_mongodb(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
        # Agent-hosted MongoDB (localhost on the DB box) → run serverStatus THROUGH
        # the agent (JSON command over the dbquery channel). Standalone stays direct.
        from app.services.common import db_proxy_service
        if db_proxy_service.agent_host_for_conn(conn_rec.id, db) is not None:
            import json as _json
            q = db_proxy_service.make_runner(conn_rec, db)
            rows = q('{"serverStatus": 1}')
            if not rows or not rows[0]:
                return False
            status = _json.loads(rows[0][0])
        else:
            from urllib.parse import quote_plus
            import pymongo  # type: ignore

            auth = ""
            if conn_rec.username:
                auth = f"{conn_rec.username}:{quote_plus(conn_rec.password or '')}@"
            uri = f"mongodb://{auth}{conn_rec.host}:{conn_rec.port or 27017}/"
            client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000)
            status = client.admin.command("serverStatus")
            client.close()

        conns   = status.get("connections", {})
        uptime  = int(status.get("uptime", 0))
        current = int(conns.get("current", 0))
        avail   = int(conns.get("available", 0))

        db.add(AgentMetric(
            agent_name=agent_name,
            host_cpu=0.0,
            host_memory=0.0,
            db_cpu=0.0,
            active_sessions=current,
            connections_used=current,
            connections_max=current + avail,
            cache_hit_pct=0.0,
            qps=0.0,
            tps=0.0,
            uptime_seconds=uptime,
        ))
        db.commit()
        return True

    except ImportError:
        logger.debug(f"[agent_collector] pymongo not installed; MongoDB agent '{agent_name}' uses push API.")
        return False
    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] MongoDB failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# MSSQL collector
# ─────────────────────────────────────────────────────────────

def _collect_mssql(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
        # Agent-hosted SQL Server (localhost on the DB box) → query THROUGH the agent;
        # the backend can't reach it. Standalone SQL Server keeps the direct driver.
        from app.services.common import db_proxy_service
        _closer = lambda: None  # noqa: E731
        if db_proxy_service.agent_host_for_conn(conn_rec.id, db) is not None:
            q = db_proxy_service.make_runner(conn_rec, db)
        else:
            import pymssql  # type: ignore
            host = conn_rec.host
            if conn_rec.instance_name:
                host = f"{host}\\{conn_rec.instance_name}"
            mssql_conn = pymssql.connect(
                server=host,
                port=conn_rec.port or 1433,
                user=conn_rec.username,
                password=conn_rec.password,
                database=conn_rec.database_name or "master",
                login_timeout=10,
            )
            cursor = mssql_conn.cursor()

            def q(sql):
                cursor.execute(sql)
                return cursor.fetchall()

            def _closer():
                cursor.close()
                mssql_conn.close()

        rows = q("""
            SELECT
                (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND status = 'running') AS active,
                (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1)                        AS total,
                (SELECT value_in_use FROM sys.configurations WHERE name = 'max connections')                  AS max_conn,
                (SELECT sqlserver_start_time FROM sys.dm_os_sys_info)                                        AS start_time
        """)
        row = rows[0] if rows else None
        active = _ti(row[0]) if row else 0
        total = _ti(row[1]) if row else 0
        max_conn = _ti(row[2], 32767) or 32767 if row else 32767
        start_time = row[3] if row else None

        uptime = 0
        if start_time:
            import datetime as _dt
            if isinstance(start_time, str):
                # Agent-routed rows are JSON-serialised — datetimes arrive as strings.
                try:
                    start_time = _dt.datetime.strptime(start_time[:19], "%Y-%m-%d %H:%M:%S")
                except Exception:
                    start_time = None
            if start_time is not None:
                uptime = int((_dt.datetime.now() - start_time).total_seconds())

        # Buffer cache hit ratio
        cr_rows = q("""
            SELECT
                (SELECT cntr_value FROM sys.dm_os_performance_counters
                 WHERE counter_name = 'Buffer cache hit ratio' AND object_name LIKE '%Buffer Manager%'),
                (SELECT cntr_value FROM sys.dm_os_performance_counters
                 WHERE counter_name = 'Buffer cache hit ratio base' AND object_name LIKE '%Buffer Manager%')
        """)
        cr = cr_rows[0] if cr_rows else None
        cache_hit = 0.0
        if cr and _ti(cr[1]) > 0:
            cache_hit = round(_ti(cr[0]) / _ti(cr[1]) * 100, 2)

        db.add(AgentMetric(
            agent_name=agent_name,
            host_cpu=0.0,
            host_memory=0.0,
            db_cpu=round(active / max(max_conn, 1) * 100, 2),
            active_sessions=active,
            connections_used=total,
            connections_max=max_conn,
            cache_hit_pct=cache_hit,
            qps=0.0,
            tps=0.0,
            uptime_seconds=uptime,
        ))

        _closer()
        _check_thresholds(agent_name, total, max_conn, cache_hit, db)
        return True

    except ImportError:
        logger.warning(f"[agent_collector] pymssql not installed; MSSQL agent '{agent_name}' uses push API.")
        return False
    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] MSSQL failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# ClickHouse collector
# ─────────────────────────────────────────────────────────────

_ch_qps_cache = {}   # agent_name -> (epoch_ts, cumulative Query-event count) for real QPS


def _collect_clickhouse(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    """ClickHouse is never backend-direct-capable — the agent runs on the DB host, so
    every query goes THROUGH the agent (dbquery channel). A direct clickhouse_driver
    connection is used only when the connection isn't agent-linked."""
    try:
        from app.services.common import db_proxy_service
        _closer = lambda: None  # noqa: E731
        if db_proxy_service.agent_host_for_conn(conn_rec.id, db) is not None:
            q = db_proxy_service.make_runner(conn_rec, db)
        else:
            from clickhouse_driver import connect as _ch_connect  # type: ignore
            ch = _ch_connect(host=conn_rec.host or "localhost", port=conn_rec.port or 9000,
                             user=conn_rec.username or "default", password=conn_rec.password or "",
                             database=conn_rec.database_name or "default")
            cur = ch.cursor()

            def q(sql):
                cur.execute(sql)
                return cur.fetchall()

            def _closer():
                cur.close(); ch.close()

        # Single round-trip: current load, connection count, cap, uptime, and the
        # cumulative Query counter (→ real QPS via inter-cycle delta) + mark-cache hits.
        rows = q(
            "SELECT "
            "(SELECT count() FROM system.processes) AS active_q, "
            "(SELECT value FROM system.metrics WHERE metric='TCPConnection') AS tcp_conn, "
            "(SELECT toUInt64OrZero(value) FROM system.settings WHERE name='max_concurrent_queries') AS max_q, "
            "(SELECT toUInt64(uptime())) AS uptime_s, "
            "(SELECT value FROM system.events WHERE event='Query') AS q_total, "
            "(SELECT value FROM system.events WHERE event='MarkCacheHits') AS hits, "
            "(SELECT value FROM system.events WHERE event='MarkCacheMisses') AS misses"
        )
        row = rows[0] if rows else None
        if not row:
            raise RuntimeError("ClickHouse system query returned no rows")

        active   = _ti(row[0])
        tcp_conn = _ti(row[1])
        max_q    = _ti(row[2], 100) or 100
        uptime   = _ti(row[3])
        q_total  = _ti(row[4])
        hits     = _ti(row[5])
        misses   = _ti(row[6])

        cache_hit = round(hits / (hits + misses) * 100, 2) if (hits + misses) > 0 else 0.0

        import time as _time
        now = _time.time()
        qps = 0.0
        prev = _ch_qps_cache.get(agent_name)
        if prev and q_total >= prev[1]:
            dt = now - prev[0]
            if dt > 0:
                qps = round((q_total - prev[1]) / dt, 2)
        _ch_qps_cache[agent_name] = (now, q_total)

        db.add(AgentMetric(
            agent_name=agent_name,
            host_cpu=0.0,
            host_memory=0.0,
            db_cpu=round(active / max(max_q, 1) * 100, 2),
            active_sessions=active,
            connections_used=tcp_conn,
            connections_max=max_q,
            cache_hit_pct=cache_hit,
            qps=qps,
            tps=0.0,
            uptime_seconds=uptime,
        ))
        db.commit()
        _closer()
        _check_thresholds(agent_name, tcp_conn, max_q, cache_hit, db)
        return True

    except ImportError:
        _record_error(agent_name, "clickhouse-driver not installed on the server (direct mode)")
        logger.warning(f"[agent_collector] clickhouse-driver missing for '{agent_name}'")
        return False
    except Exception as exc:
        _record_error(agent_name, str(exc))
        logger.error(f"[agent_collector] ClickHouse failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# Snapshot collectors
# ─────────────────────────────────────────────────────────────

def _try_snapshot(agent_name: str, conn_id: int, snap_type: str, fn, db):
    from app.utils.agent_cache import store_snapshot
    try:
        result = fn()
        # NEVER overwrite a good snapshot with a failed/empty collection — a transient
        # agent timeout must not wipe the dashboard. Skip storing on error/empty so the
        # last good snapshot survives.
        if result is None:
            return
        if isinstance(result, dict) and (result.get("status") == "error" or result.get("_collect_failed")):
            logger.debug(f"[agent_collector] '{snap_type}' for {agent_name} failed — keeping last good snapshot")
            return
        store_snapshot(agent_name, conn_id, snap_type, result, db)
    except Exception as exc:
        logger.debug(f"[agent_collector] Snapshot '{snap_type}' for {agent_name}: {exc}")


def _is_agent_routed(conn_id, db) -> bool:
    """True if this connection's queries go through the host agent (in-process job
    channel). For those we build ONLY the main dashboard snapshot per cycle — building
    all sub-snapshots floods the single agent channel and cascades into timeouts.
    Direct connections are fast, so they keep building everything."""
    try:
        from app.services.common.db_proxy_service import agent_host_for_conn
        return agent_host_for_conn(conn_id, db) is not None
    except Exception:  # noqa: BLE001
        return False


_snap_rotation = {}       # agent_name -> next sub-snapshot index (round-robin)

# Agent-routed connections: how many sub-snapshots to build per cycle, in round-robin,
# alongside the main dashboard. Was 1 — with engines carrying up to 9 sub-snapshot
# types, that meant up to 9 SNAPSHOT_INTERVAL_SEC cycles (~9 min at the 60s default)
# before every dashboard tab had EVER been cache-warm, so a tab's first visit could
# fall through to a slow live query over the agent channel for minutes after startup.
# Building 3 per cycle cuts that to ~1/3 the time while staying far short of
# "build everything every cycle" — the original flooding problem this was designed
# to avoid in the first place.
_SUBS_PER_CYCLE = 3


def _run_snaps(agent_name, conn_id, db, snaps):
    """Build snapshots. Agent-routed connections get the main dashboard EVERY slot
    plus _SUBS_PER_CYCLE sub-snapshots in round-robin — so within a few minutes every
    dashboard tab is cache-warm (instant page loads) without ever flooding the
    single-threaded agent channel the way building all ~10 at once did."""
    if _is_agent_routed(conn_id, db) and len(snaps) > 1:
        n_subs = len(snaps) - 1
        take = min(_SUBS_PER_CYCLE, n_subs)
        idx = _snap_rotation.get(agent_name, 0) % n_subs
        _snap_rotation[agent_name] = idx + take
        picked = [snaps[1 + ((idx + i) % n_subs)] for i in range(take)]
        snaps = [snaps[0]] + picked
    for snap_type, fn in snaps:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


def _collect_mysql_snapshots(agent_name: str, conn_id: int, db):
    from app.routes.mysql.mysql_routes import (
        get_mysql_dashboard, get_table_stats, get_innodb_metrics,
        get_user_stats, get_performance_detail, get_backup_info,
    )
    from app.routes.mysql.mysql_slow_queries_routes import get_slow_queries
    from app.routes.mysql.mysql_replication_routes import replication_status, replication_variables
    from app.routes.mysql.mysql_index_analysis_routes import index_analysis

    _run_snaps(agent_name, conn_id, db, [
        ("mysql_dashboard",             lambda: get_mysql_dashboard(conn_id, db)),
        ("mysql_slow_queries",          lambda: get_slow_queries(conn_id, db)),
        ("mysql_table_stats",           lambda: get_table_stats(conn_id, db)),
        ("mysql_innodb",                lambda: get_innodb_metrics(conn_id, db)),
        ("mysql_user_stats",            lambda: get_user_stats(conn_id, db)),
        ("mysql_performance_detail",    lambda: get_performance_detail(conn_id, db)),
        ("mysql_backup_info",           lambda: get_backup_info(conn_id, db)),
        ("mysql_replication_status",    lambda: replication_status(conn_id, db)),
        ("mysql_replication_variables", lambda: replication_variables(conn_id, db)),
        ("mysql_index_analysis",        lambda: index_analysis(conn_id, db)),
    ])


def _collect_postgres_snapshots(agent_name: str, conn_id: int, db):
    from app.services.postgres.postgres_monitoring_service import (
        svc_monitoring_dashboard, svc_pg_slow_queries, svc_pg_index_analysis,
        svc_replication_detail, svc_queries_detail, svc_tables_detail,
        svc_config_detail, svc_users_detail, svc_storage_detail,
    )

    _run_snaps(agent_name, conn_id, db, [
        ("pg_monitoring_dashboard", lambda: svc_monitoring_dashboard(conn_id, db)),
        ("pg_slow_queries",         lambda: svc_pg_slow_queries(conn_id, db)),
        ("pg_index_analysis",       lambda: svc_pg_index_analysis(conn_id, db)),
        ("pg_replication_detail",   lambda: svc_replication_detail(conn_id, db)),
        ("pg_queries_detail",       lambda: svc_queries_detail(conn_id, db)),
        ("pg_tables_detail",        lambda: svc_tables_detail(conn_id, db)),
        ("pg_config_detail",        lambda: svc_config_detail(conn_id, db)),
        ("pg_users_detail",         lambda: svc_users_detail(conn_id, db)),
        ("pg_storage_detail",       lambda: svc_storage_detail(conn_id, db)),
    ])


def _collect_oracle_snapshots(agent_name: str, conn_id: int, db):
    from app.services.oracle.oracle_monitoring_service import (
        oracle_dashboard, oracle_sga_detail, oracle_pga_detail,
        oracle_sessions, oracle_top_sql, oracle_wait_events,
        oracle_schema_tables, oracle_data_guard,
    )

    _run_snaps(agent_name, conn_id, db, [
        ("oracle_dashboard",     lambda: oracle_dashboard(conn_id, db)),
        ("oracle_sga_detail",    lambda: oracle_sga_detail(conn_id, db)),
        ("oracle_pga_detail",    lambda: oracle_pga_detail(conn_id, db)),
        ("oracle_sessions",      lambda: oracle_sessions(conn_id, db)),
        ("oracle_top_sql",       lambda: oracle_top_sql(conn_id, db)),
        ("oracle_wait_events",   lambda: oracle_wait_events(conn_id, db)),
        ("oracle_schema_tables", lambda: oracle_schema_tables(conn_id, db)),
        ("oracle_data_guard",    lambda: oracle_data_guard(conn_id, db)),
    ])


def _collect_mssql_snapshots(agent_name: str, conn_id: int, db):
    from app.services.mssql.mssql_monitoring_service import (
        get_monitoring_dashboard, get_slow_queries as get_mssql_slow_queries, get_index_analysis as get_mssql_index_analysis,
    )

    _run_snaps(agent_name, conn_id, db, [
        ("mssql_monitoring_dashboard", lambda: get_monitoring_dashboard(conn_id, db)),
        ("mssql_slow_queries",         lambda: get_mssql_slow_queries(conn_id, db)),
        ("mssql_index_analysis",       lambda: get_mssql_index_analysis(conn_id, db)),
    ])


def _collect_mongo_snapshots(agent_name: str, conn_id: int, db):
    from app.services.mongo.mongo_monitoring_service import (
        get_dashboard, get_ops, get_collections,
        get_indexes, get_replication,
    )

    for snap_type, fn in [
        ("mongo_dashboard",   lambda: get_dashboard(conn_id, db)),
        ("mongo_ops",         lambda: get_ops(conn_id, db)),
        ("mongo_collections", lambda: get_collections(conn_id, db)),
        ("mongo_indexes",     lambda: get_indexes(conn_id, db)),
        ("mongo_replication", lambda: get_replication(conn_id, db)),
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


def _collect_clickhouse_snapshots(agent_name: str, conn_id: int, db):
    from app.services.clickhouse.clickhouse_monitoring_service import (
        get_dashboard as get_ch_dashboard,
        get_queries as get_ch_queries,
    )

    for snap_type, fn in [
        ("ch_dashboard", lambda: get_ch_dashboard(conn_id, db)),
        ("ch_queries",   lambda: get_ch_queries(conn_id, db)),
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


_SNAPSHOT_COLLECTORS = {
    "mysql":      _collect_mysql_snapshots,
    "postgresql": _collect_postgres_snapshots,
    "postgres":   _collect_postgres_snapshots,
    "oracle":     _collect_oracle_snapshots,
    "mssql":      _collect_mssql_snapshots,
    "mongodb":    _collect_mongo_snapshots,
    "clickhouse": _collect_clickhouse_snapshots,
}


# ─────────────────────────────────────────────────────────────
# Collection cycle
# ─────────────────────────────────────────────────────────────

_DB_TYPE_COLLECTORS = {
    "mysql":      _collect_mysql,
    "postgresql": _collect_postgres,
    "postgres":   _collect_postgres,
    "oracle":     _collect_oracle,
    "mssql":      _collect_mssql,
    "mongodb":    _collect_mongodb,
    "clickhouse": _collect_clickhouse,
}

# Engines whose full metrics/top-SQL are already collected by the agent's own
# push loop (actmon_agent.py: collect_mysql/collect_postgres/collect_mssql/
# collect_oracle/collect_mongodb/collect_clickhouse, every ~15s via /agents/data)
# — the pull side no longer needs to re-run that same query just to prove the DB
# is up; the cheap probe below does that instead.
_PUSH_COVERED_ENGINES = {
    "mysql", "mariadb", "postgresql", "postgres", "mssql",
    "oracle", "oracle db", "mongodb", "mongo", "clickhouse",
}

# Oracle requires a FROM clause ("SELECT 1" alone raises ORA-00923) — everything
# else (including MongoDB, whose agent-side dbquery handler maps a bare "SELECT 1"
# to a ping command) is happy with the plain default.
_PROBE_QUERY_BY_ENGINE = {"oracle": "SELECT 1 FROM DUAL", "oracle db": "SELECT 1 FROM DUAL"}


def _probe_connectivity(agent_name: str, conn_rec, db, db_type: str = "") -> bool:
    """Cheapest possible 'is this DB actually up and answering right now' check —
    nothing but a trivial round-trip. For _PUSH_COVERED_ENGINES this replaces the
    full metrics query (SHOW GLOBAL STATUS / DMV counters / v$session scans) as
    the connectivity proof, since that data now arrives via the agent's own push
    instead — running the full query here too would just be the redundant
    double-collection Phase 2/3 are removing."""
    try:
        from app.services.common.db_proxy_service import make_runner
        runner = make_runner(conn_rec, db)
        query = _PROBE_QUERY_BY_ENGINE.get((db_type or "").lower(), "SELECT 1")
        rows = runner(query)
        return bool(rows)
    except Exception as exc:  # noqa: BLE001
        _record_error(agent_name, str(exc))
        return False

# Last failure reason per agent — surfaced in the UI (hover the DB Error badge) so the
# user sees *why* a collection failed, not just that it did.
_last_error = {}
_last_error_guard = threading.Lock()


def _record_error(agent_name, msg):
    with _last_error_guard:
        _last_error[agent_name] = (str(msg) or "").strip()[:500]


# Transport-level failure markers — the AGENT didn't respond at all, so this says
# nothing about whether the DB itself is up or down (as opposed to e.g. "query
# failed: ..." from actmon_agent.py, which means the agent DID run the query and
# the DB itself rejected it — a real verdict).
_AGENT_UNREACHABLE_MARKERS = ("did not answer in time",)


def _agent_unreachable(msg):
    m = (msg or "").lower()
    return any(marker in m for marker in _AGENT_UNREACHABLE_MARKERS)


# Agents currently in an "agent didn't answer" streak we've already alerted on —
# so the notification fires once per streak, not every 15s while it persists.
_ambiguous_notified = set()
_ambiguous_guard = threading.Lock()


def _note_ambiguous(agent_name):
    """Returns True the FIRST time this agent goes ambiguous (caller should raise
    an alert), False on every repeat cycle of the same streak."""
    with _ambiguous_guard:
        if agent_name in _ambiguous_notified:
            return False
        _ambiguous_notified.add(agent_name)
        return True


def _clear_ambiguous_notice(agent_name):
    """Call whenever a cycle produces a real verdict (success, definitive failure,
    or OS-confirmed down) — the next ambiguous streak should alert again."""
    with _ambiguous_guard:
        _ambiguous_notified.discard(agent_name)


# ── Parallel collection ────────────────────────────────────────────────────────
# The old loop was fully SEQUENTIAL: with ~10 agents funnelling through slow agent
# channels, one "15s" cycle really took 1.5-2 minutes — telemetry arrived sparsely
# and heartbeats stalled long enough for the reaper to flap agents offline↔online.
# Now agents are collected in PARALLEL across hosts, while agents that share ONE
# host stay serialized (a host's job channel is single-threaded; stacking queries
# onto it would just trade flapping for timeouts).

def _host_key_for(agent, db):
    """Agents on the same HOST must not run concurrently — key by the host agent's
    token (via database_instances → os_servers); fall back to the agent name."""
    try:
        if agent.db_connection_id:
            row = db.execute(text(
                "SELECT s.agent_token FROM database_instances di "
                "JOIN os_servers s ON s.id = di.server_id "
                "WHERE di.connection_id = :c AND s.agent_token IS NOT NULL LIMIT 1"),
                {"c": agent.db_connection_id}).first()
            if row and row[0]:
                return row[0]
    except Exception:  # noqa: BLE001
        pass
    return agent.agent_name


_host_locks = {}
_host_locks_guard = threading.Lock()


def _lock_for_host(key):
    with _host_locks_guard:
        if key not in _host_locks:
            _host_locks[key] = threading.Lock()
        return _host_locks[key]


def _collect_one_agent(agent_id):
    """Collect ONE agent on its own DB session (thread-safe unit of work)."""
    db = SessionLocal()
    try:
        agent = db.query(Agent).filter(Agent.id == agent_id).first()
        if not agent or not agent.db_connection_id:
            return
        conn_rec = db.query(ConnectionMaster).filter(
            ConnectionMaster.id == agent.db_connection_id).first()
        if not conn_rec:
            db.query(Agent).filter(Agent.agent_name == agent.agent_name).update({"status": "error"})
            db.commit()
            return

        db_type = (agent.db_type or "mysql").lower().strip()
        collector = _DB_TYPE_COLLECTORS.get(db_type)

        host_lock = _lock_for_host(_host_key_for(agent, db))
        with host_lock:                      # serialize per HOST, parallel across hosts
            # ── OS service-state gate: ask systemctl BEFORE touching the DB ──
            # If the OS already says the service isn't running, a connection
            # attempt can only time out for a foregone conclusion — skip it and
            # reflect the OS-reported state immediately, with no error_streak wait.
            svc_state = service_state_service.get_service_state(agent.db_connection_id, db)
            service_down = svc_state.get("checked") and not svc_state.get("active")

            ambiguous_this_cycle = False   # True only for "agent didn't answer" — see below

            if service_down:
                success = False
                new_status = "error"
                err_text = svc_state.get("detail") or f"service is {svc_state.get('state')}"
                _fail_streak.pop(agent.agent_name, None)   # this isn't a query-retry situation
                with _last_error_guard:
                    _last_error[agent.agent_name] = err_text
                _clear_ambiguous_notice(agent.agent_name)   # a real OS verdict, no longer "unknown"
                logger.info(f"[agent_collector] '{agent.agent_name}' service "
                            f"'{svc_state.get('service_name')}' reports "
                            f"'{svc_state.get('state')}' (via {svc_state.get('source')}) — "
                            f"skipping DB connectivity check, status forced to error.")
            else:
                if db_type in _PUSH_COVERED_ENGINES:
                    # Phase 2/3: the agent's own push loop (actmon_agent.py) already
                    # collects full metrics/top-SQL/sessions for every engine it
                    # supports, every ~15s — stop re-running that here entirely.
                    # Only fetch what push does NOT send: Postgres wait-events and
                    # Oracle's instance snapshot + wait-events have no push
                    # equivalent, so those alone are still worth a pull-side
                    # round-trip. Threshold alerts read the metric row push already
                    # stored — but only for engines whose pull collector actually
                    # computed a real cache-hit number before (Oracle/MongoDB never
                    # did; introducing it now would just spam a false "cache hit
                    # low at 0%" alert every cycle).
                    success = _probe_connectivity(agent.agent_name, conn_rec, db, db_type)
                    if success:
                        if db_type in ("postgresql", "postgres"):
                            _collect_postgres_wait_events_only(agent.agent_name, conn_rec, db)
                            _check_thresholds_from_latest_metric(agent.agent_name, db)
                        elif db_type in ("oracle", "oracle db"):
                            _collect_oracle_extras_only(agent.agent_name, conn_rec, db)
                        elif db_type in ("mysql", "mariadb", "mssql", "clickhouse"):
                            _check_thresholds_from_latest_metric(agent.agent_name, db)
                        # mongodb/mongo: push already covers everything pull ever did
                        # here, and pull never threshold-checked it either — nothing
                        # further to run once the probe confirms it's up.
                elif collector:
                    success = collector(agent.agent_name, conn_rec, db)
                else:
                    msg = f"No server-side collector for db_type '{db_type}'"
                    logger.warning(f"[agent_collector] {msg} on agent '{agent.agent_name}'")
                    _record_error(agent.agent_name, msg)
                    success = False

                # ── Status hysteresis: degrade SLOWLY, recover INSTANTLY ────────
                if success:
                    _fail_streak.pop(agent.agent_name, None)
                    with _last_error_guard:
                        _last_error.pop(agent.agent_name, None)
                    _clear_ambiguous_notice(agent.agent_name)
                    new_status = "online"
                    err_text = None
                else:
                    err_text = _last_error.get(agent.agent_name)
                    if _agent_unreachable(err_text):
                        # The AGENT itself didn't answer — that's transport-level
                        # uncertainty, not a DB verdict (the service-state gate above
                        # already tried and couldn't reach it either). We genuinely
                        # don't know if the DB is up or down, so never flip status on
                        # this alone: hold the last known state and keep retrying every
                        # cycle. A truly dead/silent agent is the reaper's job (heartbeat
                        # silence), not this fast collector's error_streak. Surface it as
                        # an ALERT instead of a status change, once per unreachable streak.
                        ambiguous_this_cycle = True
                        new_status = agent.status or "online"
                        if _note_ambiguous(agent.agent_name):
                            db.add(AgentNotification(
                                agent_name=agent.agent_name,
                                message=(f"'{agent.agent_name}': the agent on the DB host did "
                                         f"not answer this cycle — database status could not "
                                         f"be confirmed, retrying automatically."),
                                severity="warning",
                            ))
                        logger.info(f"[agent_collector] '{agent.agent_name}' agent "
                                    f"unreachable this cycle — retrying, status "
                                    f"unchanged ({new_status}).")
                    else:
                        _clear_ambiguous_notice(agent.agent_name)
                        n = _fail_streak.get(agent.agent_name, 0) + 1
                        _fail_streak[agent.agent_name] = n
                        error_streak = monitoring_settings_service.get_settings().error_streak
                        if n >= error_streak:
                            new_status = "error"
                        else:
                            new_status = agent.status or "online"   # keep showing last state
                            logger.info(f"[agent_collector] '{agent.agent_name}' failed cycle "
                                        f"{n}/{error_streak} — status unchanged ({new_status})")

            update_fields = {"status": new_status}
            if not ambiguous_this_cycle:
                # last_heartbeat means "the agent actually answered" — only bump it when
                # it did. Refreshing it unconditionally (as this used to do) kept a fully
                # unreachable agent's DB row artificially "fresh" forever, since this
                # collector cycle runs on our own timer regardless of whether the remote
                # agent responds — masking real silence from the reaper's staleness check
                # and leaving the DB row stuck "Online" while the host's own heartbeat
                # (a genuinely different signal) correctly went stale and flipped Offline.
                # Only surface the error reason once we actually flip to error; clear it
                # while the agent is (still) considered online so the tooltip never lies.
                update_fields["last_heartbeat"] = func.now()   # DB clock — matches the reaper's now()
                update_fields["last_error"] = (err_text if new_status == "error" else None)
            db.query(Agent).filter(Agent.agent_name == agent.agent_name).update(update_fields)
            # Keep the Databases/Servers page in lock-step with reality: the linked
            # database_instance is Running only when the collector actually connected.
            # 'error' => the DB is unreachable => Stopped (no more "DB Running" on a
            # dead service). Left untouched during the online grace window.
            inst_status = "Running" if new_status == "online" else ("Stopped" if new_status == "error" else None)
            if inst_status and conn_rec is not None:
                # Stamp status_changed_at only on an actual transition — mirrors
                # os_server_service._apply_instance_status's behavior for the
                # SSH-polled path. Without this, "Down since" / the Diagnosis
                # timeline had nothing to show for agent-collected hosts even
                # though the status itself was correct.
                current = db.execute(text(
                    "SELECT status FROM database_instances WHERE connection_id = :c"),
                    {"c": conn_rec.id}).scalar()
                if current != inst_status:
                    db.execute(text(
                        "UPDATE database_instances SET status = :st, status_changed_at = now(), "
                        "status_detail = :detail WHERE connection_id = :c"),
                        {"st": inst_status, "c": conn_rec.id,
                         "detail": err_text if inst_status == "Stopped" else None})
                else:
                    db.execute(text(
                        "UPDATE database_instances SET status = :st WHERE connection_id = :c"),
                        {"st": inst_status, "c": conn_rec.id})
            db.commit()

            if success:
                # Metrics run every cycle; heavy SNAPSHOT builds stay throttled.
                snap_fn = _SNAPSHOT_COLLECTORS.get(db_type)
                if snap_fn and _snapshot_due(agent.agent_name):
                    from app.utils.agent_cache import _bypass_cache
                    _bypass_cache.active = True
                    try:
                        snap_fn(agent.agent_name, agent.db_connection_id, db)
                        db.commit()
                    except Exception as snap_exc:
                        logger.error(f"[agent_collector] Snapshot collection failed for"
                                     f" '{agent.agent_name}': {snap_exc}")
                        db.rollback()
                    finally:
                        _bypass_cache.active = False
    except Exception as exc:
        logger.error(f"[agent_collector] Cycle error for agent id={agent_id}: {exc}")
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        db.close()


# ── Per-agent independent collection loops ──────────────────────────────────
# Each agent runs its OWN "check; wait interval_sec; repeat" loop on its OWN thread —
# there is no shared "cycle" or batch at all, so one agent's hung/slow connection can
# NEVER change when any OTHER agent gets checked or how fresh its status is. A small
# manager thread just keeps the set of per-agent threads in sync with the DB (start a
# thread when an agent/connection is added, stop it when removed).
_agent_threads = {}             # agent_name -> {"id": agent_id, "thread": Thread, "stop": Event}
_agent_threads_lock = threading.Lock()


def _agent_loop(agent_id, agent_name, interval_sec, stop_event):
    while not stop_event.is_set():
        try:
            _collect_one_agent(agent_id)
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[agent_collector] '{agent_name}' loop error: {exc}")
        # Read live each iteration (Super Admin configurable) rather than using the
        # value captured at thread-start — a saved settings change takes effect on
        # this agent's very next wait, no thread restart needed. `interval_sec` (the
        # startup default from main.py) is only the fallback if settings are unreadable.
        wait_sec = monitoring_settings_service.get_settings().collector_interval_sec or interval_sec
        if stop_event.wait(wait_sec):
            break
    logger.info(f"[agent_collector] '{agent_name}' loop stopped.")


def _sync_agent_threads(interval_sec):
    """Start a loop thread for every currently db_connection_id-linked agent that
    doesn't have one yet; stop threads for agents that were removed or re-pointed
    to a different connection. Safe to call repeatedly — idempotent."""
    db = SessionLocal()
    try:
        current = {a.agent_name: a.id for a in db.query(Agent).all() if a.db_connection_id}
    except Exception as exc:  # noqa: BLE001
        logger.error(f"[agent_collector] Fatal sync error: {exc}")
        return
    finally:
        db.close()

    with _agent_threads_lock:
        for name in list(_agent_threads):
            info = _agent_threads[name]
            if current.get(name) != info["id"]:
                info["stop"].set()
                del _agent_threads[name]
        for name, agent_id in current.items():
            if name in _agent_threads:
                continue
            stop_ev = threading.Event()
            t = threading.Thread(target=_agent_loop, args=(agent_id, name, interval_sec, stop_ev),
                                  daemon=True, name=f"collector-{name}")
            _agent_threads[name] = {"id": agent_id, "thread": t, "stop": stop_ev}
            t.start()


# Snapshot throttle: metrics run every collector cycle (fast), dashboard snapshot
# builds at most once per SNAPSHOT_INTERVAL_SEC per agent (they're 20-50 queries).
SNAPSHOT_INTERVAL_SEC = int(_os.getenv("SNAPSHOT_INTERVAL_SEC", "60") or 60)
_last_snapshot_at = {}          # agent_name -> monotonic time of last snapshot build

# Status hysteresis: consecutive failed cycles before an agent shows "error". The
# actual threshold is read live from monitoring_settings_service (Super Admin
# configurable) at the point of use, not fixed here.
_fail_streak = {}               # agent_name -> consecutive failure count


def _snapshot_due(agent_name):
    now = _time.monotonic()
    if (now - _last_snapshot_at.get(agent_name, 0.0)) >= SNAPSHOT_INTERVAL_SEC:
        _last_snapshot_at[agent_name] = now
        return True
    return False


# ─────────────────────────────────────────────────────────────
# Background thread — a small manager that keeps each agent's OWN independent
# loop thread alive; it does no DB polling itself beyond that bookkeeping.
# ─────────────────────────────────────────────────────────────

def _manager_loop(interval_sec: int, resync_sec: int):
    logger.info(f"[agent_collector] Started — each agent polls independently every "
                f"{interval_sec}s (fleet resync every {resync_sec}s, "
                f"snapshots every {SNAPSHOT_INTERVAL_SEC}s)")
    while not _stop_event.is_set():
        try:
            _sync_agent_threads(interval_sec)
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[agent_collector] Unhandled sync error: {exc}")
        if _stop_event.wait(resync_sec):
            break
    logger.info("[agent_collector] Manager stopped.")


def start_agent_collector(interval_sec: int = 60):
    global _thread
    _stop_event.clear()
    resync_sec = max(15, int(_os.getenv("COLLECTOR_RESYNC_SEC", "20") or 20))
    _thread = threading.Thread(
        target=_manager_loop,
        args=(interval_sec, resync_sec),
        daemon=True,
        name="agent_collector_manager",
    )
    _thread.start()
    logger.info("[agent_collector] Background manager thread launched.")


def stop_agent_collector():
    _stop_event.set()
    with _agent_threads_lock:
        agent_infos = list(_agent_threads.values())
        for info in agent_infos:
            info["stop"].set()
        _agent_threads.clear()
    if _thread and _thread.is_alive():
        _thread.join(timeout=10)
    for info in agent_infos:
        info["thread"].join(timeout=5)
