"""
Centralized Agent Collector Service
====================================
This is the ONLY component that connects to monitored databases.
It runs as a background thread, collects metrics from each registered agent's
database, and stores results in the ACTMON PostgreSQL repository.

All other consumers (frontend, application servers) read pre-collected data
via the /api/v1/agents/* REST API — they never connect to the monitored DB.
"""

import threading
import time
import logging
import datetime
from hashlib import md5
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.database.connection import SessionLocal
from app.models.agent_model import (
    Agent, AgentMetric, AgentTopSQL, AgentWaitEvent,
    AgentNotification, AgentOracleSnapshot,
)
from app.models.connection_model import ConnectionMaster

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


# ─────────────────────────────────────────────────────────────
# MySQL collector
# ─────────────────────────────────────────────────────────────

def _collect_mysql(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
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
                agent_name=agent_name,
                host_cpu=0.0,
                host_memory=0.0,
                db_cpu=db_cpu_pct,
                active_sessions=threads_running,
                connections_used=threads_connected,
                connections_max=max_connections,
                cache_hit_pct=cache_hit,
                qps=qps,
                tps=tps,
                uptime_seconds=uptime,
            ))

            # Performance Schema — Top SQL & Wait Events
            ps_enabled = variables.get("performance_schema", "OFF").upper() == "ON"
            if ps_enabled:
                _collect_mysql_top_sql(agent_name, conn, db)
                _collect_mysql_wait_events(agent_name, conn, db)

            _check_thresholds(agent_name, threads_connected, max_connections, cache_hit, db)

        eng.dispose()
        return True

    except Exception as exc:
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
        eng = create_engine(url, connect_args={"connect_timeout": 10}, poolclass=NullPool)
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


# ─────────────────────────────────────────────────────────────
# Oracle collector
# ─────────────────────────────────────────────────────────────

def _collect_oracle(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
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

        # Instance info
        cursor.execute("""
            SELECT i.version, i.instance_name, i.host_name,
                   TO_CHAR(i.startup_time, 'YYYY-MM-DD HH24:MI:SS'),
                   d.log_mode, d.open_mode, i.database_status,
                   i.instance_role, i.status, i.archiver
            FROM v$instance i, v$database d
            WHERE rownum = 1
        """)
        row = cursor.fetchone()
        if row:
            # SGA / PGA
            cursor.execute("SELECT SUM(value) FROM v$sga")
            sga_row = cursor.fetchone()
            sga_bytes = int(sga_row[0] or 0) if sga_row else 0

            cursor.execute("SELECT SUM(pga_alloc_mem) FROM v$process")
            pga_row = cursor.fetchone()
            pga_bytes = int(pga_row[0] or 0) if pga_row else 0

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
        cursor.execute(
            "SELECT COUNT(*) FROM v$session WHERE status = 'ACTIVE' AND type = 'USER'"
        )
        act_row = cursor.fetchone()
        active = int(act_row[0] or 0) if act_row else 0

        cursor.execute("SELECT COUNT(*) FROM v$session WHERE type = 'USER'")
        tot_row = cursor.fetchone()
        total = int(tot_row[0] or 0) if tot_row else 0

        cursor.execute("SELECT value FROM v$parameter WHERE name = 'sessions'")
        max_row = cursor.fetchone()
        max_sess = int(max_row[0] or 100) if max_row else 100

        # Uptime in seconds
        cursor.execute(
            "SELECT (SYSDATE - startup_time) * 86400 FROM v$instance"
        )
        up_row = cursor.fetchone()
        uptime = int(up_row[0] or 0) if up_row else 0

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
        cursor.execute("""
            SELECT sql_id, SUBSTR(sql_text, 1, 2000),
                   executions, elapsed_time / 1000.0 / NULLIF(executions, 0),
                   cpu_time / 1000.0, buffer_gets,
                   elapsed_time / 1000.0
            FROM v$sqlarea
            WHERE executions > 0
            ORDER BY elapsed_time DESC FETCH FIRST 50 ROWS ONLY
        """)
        for r in cursor.fetchall():
            db.add(AgentTopSQL(
                agent_name=agent_name,
                sql_id=str(r[0] or ""),
                sql_text=str(r[1] or "")[:2000],
                executions=int(r[2] or 0),
                avg_elapsed_ms=float(r[3] or 0),
                cpu_time_ms=float(r[4] or 0),
                buffer_gets=int(r[5] or 0),
                total_ms=float(r[6] or 0),
                max_ms=0.0,
            ))

        # Wait events
        cursor.execute("""
            SELECT event, wait_class, time_waited / 100.0,
                   time_waited / 100.0 / NULLIF(total_waits, 0), total_waits
            FROM v$system_event
            WHERE wait_class != 'Idle'
            ORDER BY time_waited DESC FETCH FIRST 20 ROWS ONLY
        """)
        for r in cursor.fetchall():
            db.add(AgentWaitEvent(
                agent_name=agent_name,
                event_name=str(r[0] or ""),
                wait_class=str(r[1] or ""),
                time_waited_ms=float(r[2] or 0),
                avg_ms=float(r[3] or 0),
                count=int(r[4] or 0),
            ))

        cursor.close()
        oracle_conn.close()
        return True

    except ImportError:
        logger.debug(f"[agent_collector] oracledb not installed; Oracle agent '{agent_name}' uses push API.")
        return False
    except Exception as exc:
        logger.error(f"[agent_collector] Oracle failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# MongoDB collector
# ─────────────────────────────────────────────────────────────

def _collect_mongodb(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
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
        logger.error(f"[agent_collector] MongoDB failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# MSSQL collector
# ─────────────────────────────────────────────────────────────

def _collect_mssql(agent_name: str, conn_rec: ConnectionMaster, db) -> bool:
    try:
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

        cursor.execute("""
            SELECT
                (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND status = 'running') AS active,
                (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1)                        AS total,
                (SELECT value_in_use FROM sys.configurations WHERE name = 'max connections')                  AS max_conn,
                (SELECT sqlserver_start_time FROM sys.dm_os_sys_info)                                        AS start_time
        """)
        row = cursor.fetchone()
        active = int(row[0] or 0) if row else 0
        total = int(row[1] or 0) if row else 0
        max_conn = int(row[2] or 32767) if row else 32767
        start_time = row[3] if row else None

        uptime = 0
        if start_time:
            import datetime as _dt
            uptime = int((_dt.datetime.now() - start_time).total_seconds())

        # Buffer cache hit ratio
        cursor.execute("""
            SELECT
                (SELECT cntr_value FROM sys.dm_os_performance_counters
                 WHERE counter_name = 'Buffer cache hit ratio' AND object_name LIKE '%Buffer Manager%'),
                (SELECT cntr_value FROM sys.dm_os_performance_counters
                 WHERE counter_name = 'Buffer cache hit ratio base' AND object_name LIKE '%Buffer Manager%')
        """)
        cr = cursor.fetchone()
        cache_hit = 0.0
        if cr and cr[1] and int(cr[1]) > 0:
            cache_hit = round(int(cr[0] or 0) / int(cr[1]) * 100, 2)

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

        cursor.close()
        mssql_conn.close()
        _check_thresholds(agent_name, total, max_conn, cache_hit, db)
        return True

    except ImportError:
        logger.warning(f"[agent_collector] pymssql not installed; MSSQL agent '{agent_name}' uses push API.")
        return False
    except Exception as exc:
        logger.error(f"[agent_collector] MSSQL failed for {agent_name}: {exc}")
        return False


# ─────────────────────────────────────────────────────────────
# Snapshot collectors
# ─────────────────────────────────────────────────────────────

def _try_snapshot(agent_name: str, conn_id: int, snap_type: str, fn, db):
    from app.utils.agent_cache import store_snapshot
    try:
        result = fn()
        if result is not None:
            store_snapshot(agent_name, conn_id, snap_type, result, db)
    except Exception as exc:
        logger.debug(f"[agent_collector] Snapshot '{snap_type}' for {agent_name}: {exc}")


def _collect_mysql_snapshots(agent_name: str, conn_id: int, db):
    from app.routes.mysql.mysql_routes import (
        get_mysql_dashboard, get_table_stats, get_innodb_metrics,
        get_user_stats, get_performance_detail, get_backup_info,
    )
    from app.routes.mysql.mysql_slow_queries_routes import get_slow_queries
    from app.routes.mysql.mysql_replication_routes import replication_status, replication_variables
    from app.routes.mysql.mysql_index_analysis_routes import index_analysis

    for snap_type, fn in [
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
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


def _collect_postgres_snapshots(agent_name: str, conn_id: int, db):
    from app.services.postgres.postgres_monitoring_service import (
        svc_monitoring_dashboard, svc_pg_slow_queries, svc_pg_index_analysis,
        svc_replication_detail, svc_queries_detail, svc_tables_detail,
        svc_config_detail, svc_users_detail, svc_storage_detail,
    )

    for snap_type, fn in [
        ("pg_monitoring_dashboard", lambda: svc_monitoring_dashboard(conn_id, db)),
        ("pg_slow_queries",         lambda: svc_pg_slow_queries(conn_id, db)),
        ("pg_index_analysis",       lambda: svc_pg_index_analysis(conn_id, db)),
        ("pg_replication_detail",   lambda: svc_replication_detail(conn_id, db)),
        ("pg_queries_detail",       lambda: svc_queries_detail(conn_id, db)),
        ("pg_tables_detail",        lambda: svc_tables_detail(conn_id, db)),
        ("pg_config_detail",        lambda: svc_config_detail(conn_id, db)),
        ("pg_users_detail",         lambda: svc_users_detail(conn_id, db)),
        ("pg_storage_detail",       lambda: svc_storage_detail(conn_id, db)),
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


def _collect_oracle_snapshots(agent_name: str, conn_id: int, db):
    from app.services.oracle.oracle_monitoring_service import (
        oracle_dashboard, oracle_sga_detail, oracle_pga_detail,
        oracle_sessions, oracle_top_sql, oracle_wait_events,
    )

    for snap_type, fn in [
        ("oracle_dashboard",   lambda: oracle_dashboard(conn_id, db)),
        ("oracle_sga_detail",  lambda: oracle_sga_detail(conn_id, db)),
        ("oracle_pga_detail",  lambda: oracle_pga_detail(conn_id, db)),
        ("oracle_sessions",    lambda: oracle_sessions(conn_id, db)),
        ("oracle_top_sql",     lambda: oracle_top_sql(conn_id, db)),
        ("oracle_wait_events", lambda: oracle_wait_events(conn_id, db)),
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


def _collect_mssql_snapshots(agent_name: str, conn_id: int, db):
    from app.services.mssql.mssql_monitoring_service import (
        get_monitoring_dashboard, get_slow_queries as get_mssql_slow_queries, get_index_analysis as get_mssql_index_analysis,
    )

    for snap_type, fn in [
        ("mssql_monitoring_dashboard", lambda: get_monitoring_dashboard(conn_id, db)),
        ("mssql_slow_queries",         lambda: get_mssql_slow_queries(conn_id, db)),
        ("mssql_index_analysis",       lambda: get_mssql_index_analysis(conn_id, db)),
    ]:
        _try_snapshot(agent_name, conn_id, snap_type, fn, db)


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
}


def _run_collection_cycle():
    db = SessionLocal()
    try:
        agents = db.query(Agent).all()
        for agent in agents:
            try:
                if not agent.db_connection_id:
                    continue

                conn_rec = db.query(ConnectionMaster).filter(
                    ConnectionMaster.id == agent.db_connection_id
                ).first()

                if not conn_rec:
                    db.query(Agent).filter(
                        Agent.agent_name == agent.agent_name
                    ).update({"status": "error"})
                    db.commit()
                    continue

                db_type = (agent.db_type or "mysql").lower().strip()
                collector = _DB_TYPE_COLLECTORS.get(db_type)

                if collector:
                    success = collector(agent.agent_name, conn_rec, db)
                else:
                    logger.warning(
                        f"[agent_collector] No collector for db_type='{db_type}' on agent '{agent.agent_name}'"
                    )
                    success = False

                db.query(Agent).filter(
                    Agent.agent_name == agent.agent_name
                ).update({
                    "status": "online" if success else "error",
                    "last_heartbeat": datetime.datetime.utcnow(),
                })
                db.commit()

                if success:
                    snap_fn = _SNAPSHOT_COLLECTORS.get(db_type)
                    if snap_fn:
                        from app.utils.agent_cache import _bypass_cache
                        _bypass_cache.active = True
                        try:
                            snap_fn(agent.agent_name, agent.db_connection_id, db)
                            db.commit()
                        except Exception as snap_exc:
                            logger.error(
                                f"[agent_collector] Snapshot collection failed for"
                                f" '{agent.agent_name}': {snap_exc}"
                            )
                            db.rollback()
                        finally:
                            _bypass_cache.active = False

            except Exception as exc:
                logger.error(
                    f"[agent_collector] Cycle error for agent '{agent.agent_name}': {exc}"
                )
                db.rollback()

    except Exception as exc:
        logger.error(f"[agent_collector] Fatal cycle error: {exc}")
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────
# Background thread
# ─────────────────────────────────────────────────────────────

def _collector_loop(interval_sec: int):
    logger.info(f"[agent_collector] Started — polling every {interval_sec}s")
    while not _stop_event.is_set():
        try:
            _run_collection_cycle()
        except Exception as exc:
            logger.error(f"[agent_collector] Unhandled error: {exc}")
        _stop_event.wait(timeout=interval_sec)
    logger.info("[agent_collector] Stopped.")


def start_agent_collector(interval_sec: int = 60):
    global _thread
    _stop_event.clear()
    _thread = threading.Thread(
        target=_collector_loop,
        args=(interval_sec,),
        daemon=True,
        name="agent_collector",
    )
    _thread.start()
    logger.info("[agent_collector] Background thread launched.")


def stop_agent_collector():
    _stop_event.set()
    if _thread and _thread.is_alive():
        _thread.join(timeout=10)
