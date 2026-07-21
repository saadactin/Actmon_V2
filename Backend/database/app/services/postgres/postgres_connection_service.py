"""
PostgreSQL Connection Service — business logic for connection CRUD, dashboard,
log reading, and snapshot helpers.
"""

import os
import json
import datetime
from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import PostgreSQLConnectionCreate


# ──────────────────────────────────────────────────────────────
#  SNAPSHOT / LOG HELPERS
# ──────────────────────────────────────────────────────────────

_BASE = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'logs')
SNAPSHOT_DIR = os.path.join(_BASE, 'snapshots')


def _ensure_dirs():
    try:
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    except Exception:
        pass


def _snapshot_path(connection_id: int) -> str:
    _ensure_dirs()
    return os.path.join(SNAPSHOT_DIR, f"postgres_snapshot_{connection_id}.json")


def _save_snapshot(connection_id: int, payload: dict):
    try:
        with open(_snapshot_path(connection_id), 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, default=str)
    except Exception:
        pass


def _load_snapshot(connection_id: int):
    try:
        path = _snapshot_path(connection_id)
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as fh:
                return json.load(fh)
    except Exception:
        pass
    return None


def _read_log_tail(candidates, limit: int = 200):
    for path in candidates:
        try:
            if not path:
                continue
            if os.path.exists(path):
                if os.path.isdir(path):
                    log_files = sorted(
                        [os.path.join(path, f) for f in os.listdir(path) if f.endswith(".log")],
                        key=os.path.getmtime,
                        reverse=True,
                    )
                    if not log_files:
                        continue
                    path = log_files[0]
                with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
                    lines = fh.readlines()
                    return [ln.strip() for ln in lines[-limit:]][::-1]
        except Exception:
            continue
    return []


def _log_candidates(connection_id: int):
    return [
        r"C:\Program Files\PostgreSQL\17\data\log",
        os.path.join(os.getcwd(), 'logs', f'postgresql_{connection_id}.log'),
        os.path.join(os.getcwd(), 'logs', 'postgresql.log'),
    ]


# ──────────────────────────────────────────────────────────────
#  ENGINE / AUTH HELPERS
# ──────────────────────────────────────────────────────────────

def _pg_engine(conn):
    # When no database is given, connect to the always-present "postgres" DB.
    # (An empty database makes libpq default to the USERNAME as the db name, which
    # fails with 'database "<user>" does not exist'.)
    dbname = (getattr(conn, "database_name", None) or "").strip() or "postgres"
    url = (
        f"postgresql://{conn.username}:{quote_plus(conn.password)}"
        f"@{conn.host}:{conn.port}/{dbname}"
    )
    return create_engine(url, echo=False)


def _get_conn_or_404(connection_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql",
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    return conn


# ──────────────────────────────────────────────────────────────
#  CRUD
# ──────────────────────────────────────────────────────────────

def svc_list_connections(db: Session, org_id=None):
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "postgresql"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": connections}


def svc_create_connection(request: PostgreSQLConnectionCreate, db: Session, org_id=1):
    try:
        engine = _pg_engine(request)
        with engine.connect() as c:
            c.execute(text("SELECT 1"))

        new_conn = ConnectionMaster(
            connection_name=request.connection_name,
            db_type="postgresql",
            org_id=org_id,
            registration_mode="standard",
            environment="Production",
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            ssl_mode=request.ssl_mode,
        )
        db.add(new_conn)
        db.commit()
        db.refresh(new_conn)
        return {
            "status": "success",
            "message": "PostgreSQL connection created successfully",
            "data": new_conn,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


def svc_get_connection(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    return {"status": "success", "data": conn}


def svc_update_connection(connection_id: int, request: PostgreSQLConnectionCreate, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        conn.connection_name = request.connection_name
        conn.host            = request.host
        conn.port            = request.port
        conn.username        = request.username
        conn.password        = request.password
        conn.database_name   = request.database_name
        conn.ssl_mode        = request.ssl_mode
        db.commit()
        db.refresh(conn)
        return {
            "status": "success",
            "message": "PostgreSQL connection updated successfully",
            "data": conn,
        }
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


def svc_delete_connection(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        db.delete(conn)
        db.commit()
        return {"status": "success", "message": "PostgreSQL connection deleted successfully"}
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


def svc_test_connection(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        engine = _pg_engine(conn)
        with engine.connect() as c:
            version = c.execute(text("SELECT version()")).fetchone()[0]
        return {
            "status": "success",
            "message": "PostgreSQL connection test successful",
            "version": version,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ──────────────────────────────────────────────────────────────
#  DASHBOARD
# ──────────────────────────────────────────────────────────────

def svc_get_dashboard(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    conn_meta = {
        "id":       conn.id,
        "name":     conn.connection_name,
        "host":     conn.host,
        "port":     conn.port,
        "database": conn.database_name,
    }

    try:
        engine = _pg_engine(conn)
        with engine.connect() as c:

            version = c.execute(text("SELECT version()")).scalar()

            try:
                shared_buffers = c.execute(text("SHOW shared_buffers")).scalar()
            except Exception:
                shared_buffers = "0"

            try:
                effective_cache_size = c.execute(text("SHOW effective_cache_size")).scalar()
            except Exception:
                effective_cache_size = "0"

            try:
                work_mem = c.execute(text("SHOW work_mem")).scalar()
            except Exception:
                work_mem = "0"

            # uptime
            try:
                uptime_seconds = int(c.execute(text(
                    "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))"
                )).scalar() or 0)
            except Exception:
                uptime_seconds = 0

            days    = uptime_seconds // 86400
            hours   = (uptime_seconds % 86400) // 3600
            minutes = (uptime_seconds % 3600) // 60
            uptime  = f"{days}d {hours}h {minutes}m" if days > 0 else f"{hours}h {minutes}m"
            last_restart = (
                datetime.datetime.now() - datetime.timedelta(seconds=uptime_seconds)
            ).strftime("%Y-%m-%d %H:%M:%S")

            # connections
            try:
                current_connections = int(c.execute(text("SELECT count(*) FROM pg_stat_activity")).scalar() or 0)
            except Exception:
                current_connections = 0

            try:
                max_connections = int(c.execute(text("SHOW max_connections")).scalar() or 0)
            except Exception:
                max_connections = 0

            connection_usage_pct = round(
                current_connections / max_connections * 100, 2
            ) if max_connections > 0 else 0

            # databases
            databases = []
            total_size_bytes = 0
            try:
                for row in c.execute(text(
                    "SELECT d.datname, pg_database_size(d.datname) FROM pg_database d WHERE d.datistemplate = false"
                )):
                    size = int(row[1] or 0)
                    databases.append({"name": row[0], "tables_count": 0, "size_mb": round(size / 1048576, 2)})
                    total_size_bytes += size
            except Exception:
                pass

            total_size_mb = round(total_size_bytes / 1048576, 2)
            total_size_gb = round(total_size_mb / 1024, 2)

            # process list
            process_list = []
            try:
                for row in c.execute(text(
                    "SELECT pid, usename, datname, state, query, "
                    "EXTRACT(EPOCH FROM (now() - COALESCE(query_start, now()))) AS duration "
                    "FROM pg_stat_activity WHERE pid <> pg_backend_pid()"
                )):
                    process_list.append({
                        "Id": row[0], "User": row[1], "db": row[2],
                        "State": row[3], "Info": row[4], "Time": int(row[5] or 0),
                    })
            except Exception:
                pass

            long_running_queries = [
                p for p in process_list
                if p.get("Time", 0) >= 30
                and p.get("Info") and p.get("Info").strip()
                and p.get("Info") not in ("ROLLBACK", "COMMIT", "BEGIN")
                and p.get("State") != "idle"
            ]

            # replication
            try:
                first = c.execute(text("SELECT * FROM pg_stat_replication")).fetchone()
                replication = {"state": "REPLICA"} if first else {"state": "STANDALONE"}
            except Exception:
                replication = {"state": "UNKNOWN"}

            # cache hit ratio
            try:
                stat = c.execute(text(
                    "SELECT sum(blks_hit) AS hit, sum(blks_read) AS read FROM pg_stat_database"
                )).fetchone()
                blks_hit  = int(stat[0] or 0)
                blks_read = int(stat[1] or 0)
                cache_hit_ratio = round(blks_hit / (blks_hit + blks_read) * 100, 2) if (blks_hit + blks_read) > 0 else 0
            except Exception:
                cache_hit_ratio = 0

            # query stats
            qs_counts = {"SELECT": 0, "INSERT": 0, "UPDATE": 0, "DELETE": 0}
            try:
                for row in c.execute(text(
                    "SELECT query, calls FROM pg_stat_statements ORDER BY calls DESC LIMIT 100"
                )).fetchall():
                    q     = (row.query or "").strip().upper()
                    calls = row.calls or 0
                    for key in qs_counts:
                        if q.startswith(key):
                            qs_counts[key] += calls
                            break
            except Exception:
                pass

        # error log count (from file)
        try:
            error_logs  = svc_get_error_logs(connection_id, limit=100)
            error_count = len(error_logs.get("data", []))
        except Exception:
            error_count = 0

        payload = {
            "status": "success",
            "connection": conn_meta,
            "health_summary": {
                "uptime":              uptime,
                "last_restart":        last_restart,
                "host_name":           conn.host,
                "version":             version,
                "replication_state":   replication.get("state"),
                "connection_usage_pct": connection_usage_pct,
                "cache_usage_pct":     cache_hit_ratio,
                "total_databases":     len(databases),
                "total_tables":        0,
                "total_size_mb":       total_size_mb,
                "total_size_gb":       total_size_gb,
                "current_connections": current_connections,
                "max_connections":     max_connections,
                "storage_engine":      "PostgreSQL",
            },
            "databases": databases,
            "chart_data": {
                "connection_pct": connection_usage_pct,
                "cache_pct":      cache_hit_ratio,
                "query_stats": {
                    "labels": ["SELECT", "INSERT", "UPDATE", "DELETE"],
                    "values": [qs_counts["SELECT"], qs_counts["INSERT"], qs_counts["UPDATE"], qs_counts["DELETE"]],
                },
                "db_sizes": [{"name": d["name"], "size_mb": d["size_mb"]} for d in databases],
            },
            "connections_detail": {
                "current": current_connections,
                "max":     max_connections,
                "connection_usage_pct": connection_usage_pct,
            },
            "memory": {
                "shared_buffers":      shared_buffers,
                "effective_cache_size": effective_cache_size,
                "work_mem":            work_mem,
                "cache_usage_pct":     cache_hit_ratio,
            },
            "query_stats": {
                "Com_select":  qs_counts["SELECT"],
                "Com_insert":  qs_counts["INSERT"],
                "Com_update":  qs_counts["UPDATE"],
                "Com_delete":  qs_counts["DELETE"],
                "Questions":   sum(qs_counts.values()),
                "Slow_queries": len(long_running_queries),
                "slow_queries": len(long_running_queries),
            },
            "network":            {"bytes_received": 0, "bytes_sent": 0},
            "slow_query_config":  {"slow_query_log": "N/A", "long_query_time": 1, "slow_query_log_file": ""},
            "error_log_path":     r"C:\Program Files\PostgreSQL\17\data\log",
            "error_log_count":    error_count,
            "process_list":       process_list,
            "long_running_queries": long_running_queries,
            "replication":        replication,
        }

        _save_snapshot(connection_id, payload)
        return payload

    except Exception as exc:
        return {"status": "error", "error": str(exc), "connection": conn_meta}


# ──────────────────────────────────────────────────────────────
#  LOG ENDPOINTS (no DB session needed)
# ──────────────────────────────────────────────────────────────

def svc_get_error_logs(connection_id: int, limit: int = 50):
    lines = _read_log_tail(_log_candidates(connection_id), limit)
    if lines:
        return {"status": "success", "source": "file", "data": [{"message": ln} for ln in lines]}

    snap = _load_snapshot(connection_id)
    if snap is not None:
        return {"status": "success", "source": "snapshot", "data": snap.get("last_error_logs", [])}

    return {"status": "success", "source": "none", "data": []}


def svc_get_long_query_logs(connection_id: int, limit: int = 50):
    lines = _read_log_tail(_log_candidates(connection_id), limit * 5)
    long_lines = []
    for ln in lines:
        if "duration:" in ln or "long query" in ln.lower() or "execute" in ln.lower():
            long_lines.append({"message": ln})
            if len(long_lines) >= limit:
                break

    if long_lines:
        return {"status": "success", "source": "file", "data": long_lines}

    snap = _load_snapshot(connection_id)
    if snap:
        return {"status": "success", "source": "snapshot", "data": snap.get("long_query_logs", [])}

    return {"status": "success", "source": "none", "data": []}


# ──────────────────────────────────────────────────────────────
#  ANALYSIS (snapshot-based)
# ──────────────────────────────────────────────────────────────

def svc_analyze(connection_id: int):
    snap = _load_snapshot(connection_id)
    if not snap:
        return {"status": "error", "message": "No snapshot available to analyze"}

    hs          = snap.get("health_summary", {})
    qs          = snap.get("query_stats", {})
    replication = snap.get("replication", {})

    analysis = {
        "connection_ok":     hs.get("current_connections", 0) >= 0,
        "slow_queries":      qs.get("slow_queries", 0),
        "replication_state": replication.get("state"),
        "top_issues":        [],
    }
    if analysis["slow_queries"] and analysis["slow_queries"] > 5:
        analysis["top_issues"].append("High number of slow queries")
    if hs.get("connection_usage_pct", 0) > 90:
        analysis["top_issues"].append("Connection usage high")
    if replication.get("state") == "UNKNOWN":
        analysis["top_issues"].append("Replication state unknown")

    return {"status": "success", "data": analysis}


def svc_analyze_error(connection_id: int, payload: dict):
    snap = _load_snapshot(connection_id)
    parts = []

    em = payload.get("error_message") if isinstance(payload, dict) else None
    ec = payload.get("error_code")    if isinstance(payload, dict) else None

    if em:
        parts.append(f"**Observed Error:** {em}")
    if ec:
        parts.append(f"**Error Code:** {ec}")

    if snap:
        hs          = snap.get("health_summary", {})
        qs          = snap.get("query_stats", {})
        replication = snap.get("replication", {})

        parts.append("\n**Snapshot Summary:**")
        parts.append(f"- Uptime: {hs.get('uptime')}")
        parts.append(f"- Current Connections: {hs.get('current_connections')}/{hs.get('max_connections')}")
        parts.append(f"- Slow Queries: {qs.get('slow_queries')}")
        parts.append(f"- Replication: {replication.get('state')}")

        issues = []
        if qs.get("slow_queries", 0) > 5:
            issues.append("High slow query count")
        if hs.get("connection_usage_pct", 0) > 90:
            issues.append("High connection utilization")
        if replication.get("state") == "UNKNOWN":
            issues.append("Replication not reporting")

        if issues:
            parts.append("\n**Potential Issues:**")
            for it in issues:
                parts.append(f"- {it}")
    else:
        parts.append("\nNo snapshot available to enrich analysis.")

    return {"status": "success", "data": {"analysis": "\n".join(parts)}}
