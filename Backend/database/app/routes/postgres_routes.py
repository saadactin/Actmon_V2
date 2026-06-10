from fastapi import APIRouter, Depends, HTTPException
import datetime
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text

from urllib.parse import quote_plus

import os
import json

from app.database.connection import SessionLocal

from app.models.connection_model import ConnectionMaster

from app.models.connection_schema import PostgreSQLConnectionCreate


router = APIRouter(
    prefix="/api/v1/connections/postgresql",
    tags=["PostgreSQL"]
)


# =========================================================
# DATABASE SESSION
# =========================================================

def get_db():

    db = SessionLocal()

    try:
        yield db

    finally:
        db.close()


# =========================================================
# LIST CONNECTIONS
# =========================================================

@router.get("/")
def list_postgresql_connections(
    db: Session = Depends(get_db)
):

    connections = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.db_type == "postgresql"
    ).all()

    return {
        "status": "success",
        "data": connections
    }


# =========================================================
# CREATE CONNECTION
# =========================================================

@router.post("/")
def create_postgresql_connection(
    request: PostgreSQLConnectionCreate,
    db: Session = Depends(get_db)
):

    try:

        # ============================================
        # TEST CONNECTION
        # ============================================

        connection_string = (
            f"postgresql://"
            f"{request.username}:"
            f"{quote_plus(request.password)}@"
            f"{request.host}:"
            f"{request.port}/"
            f"{request.database_name}"
        )

        engine = create_engine(
            connection_string,
            echo=False
        )

        with engine.connect() as connection:
            connection.execute(
                text("SELECT 1")
            )

        # ============================================
        # SAVE CONNECTION
        # ============================================

        new_connection = ConnectionMaster(

            connection_name=request.connection_name,

            db_type="postgresql",

            registration_mode="standard",

            environment="Production",

            host=request.host,

            port=request.port,

            username=request.username,

            password=request.password,

            database_name=request.database_name,

            ssl_mode=request.ssl_mode
        )

        db.add(new_connection)

        db.commit()

        db.refresh(new_connection)

        return {
            "status": "success",
            "message": "PostgreSQL connection created successfully",
            "data": new_connection
        }

    except Exception as error:

        db.rollback()

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )


# =========================================================
# GET CONNECTION
# =========================================================

@router.get("/{connection_id}")
def get_postgresql_connection(
    connection_id: int,
    db: Session = Depends(get_db)
):

    connection = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="PostgreSQL connection not found"
        )

    return {
        "status": "success",
        "data": connection
    }


# =========================================================
# UPDATE CONNECTION
# =========================================================

@router.put("/{connection_id}")
def update_postgresql_connection(
    connection_id: int,
    request: PostgreSQLConnectionCreate,
    db: Session = Depends(get_db)
):

    connection = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="PostgreSQL connection not found"
        )

    try:

        connection.connection_name = (
            request.connection_name
        )

        connection.host = request.host

        connection.port = request.port

        connection.username = request.username

        connection.password = request.password

        connection.database_name = (
            request.database_name
        )

        connection.ssl_mode = (
            request.ssl_mode
        )

        db.commit()

        db.refresh(connection)

        return {
            "status": "success",
            "message": "PostgreSQL connection updated successfully",
            "data": connection
        }

    except Exception as error:

        db.rollback()

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )


# =========================================================
# DELETE CONNECTION
# =========================================================

@router.delete("/{connection_id}")
def delete_postgresql_connection(
    connection_id: int,
    db: Session = Depends(get_db)
):

    connection = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="PostgreSQL connection not found"
        )

    try:

        db.delete(connection)

        db.commit()

        return {
            "status": "success",
            "message": "PostgreSQL connection deleted successfully"
        }

    except Exception as error:

        db.rollback()

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )


# =========================================================
# TEST SAVED CONNECTION
# =========================================================

@router.post("/{connection_id}/test")
def test_postgresql_connection(
    connection_id: int,
    db: Session = Depends(get_db)
):

    connection = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="PostgreSQL connection not found"
        )

    try:

        connection_string = (
            f"postgresql://"
            f"{connection.username}:"
            f"{quote_plus(connection.password)}@"
            f"{connection.host}:"
            f"{connection.port}/"
            f"{connection.database_name}"
        )

        engine = create_engine(
            connection_string,
            echo=False
        )

        with engine.connect() as conn:

            result = conn.execute(
                text("SELECT version()")
            )

            version = result.fetchone()[0]

        return {
            "status": "success",
            "message": "PostgreSQL connection test successful",
            "version": version
        }

    except Exception as error:

        raise HTTPException(
            status_code=400,
            detail=str(error)
        )
        
        
        
        # =========================================================
        # POSTGRESQL TELEMETRY DASHBOARD
        # =========================================================

@router.get("/{connection_id}/dashboard")
def get_postgresql_dashboard(
    connection_id: int,
    db: Session = Depends(get_db)
):

    connection = db.query(
        ConnectionMaster
    ).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()

    if not connection:

        raise HTTPException(
            status_code=404,
            detail="PostgreSQL connection not found"
        )

    conn_meta = {
        "id": connection.id,
        "name": connection.connection_name,
        "host": connection.host,
        "port": connection.port,
        "database": connection.database_name
    }

    try:

        connection_string = (
            f"postgresql://"
            f"{connection.username}:"
            f"{quote_plus(connection.password)}@"
            f"{connection.host}:"
            f"{connection.port}/"
            f"{connection.database_name}"
        )

        engine = create_engine(
            connection_string,
            echo=False
        )

        with engine.connect() as conn:

            version = conn.execute(
            text("SELECT version()")
            ).scalar()

        try:
            shared_buffers = conn.execute(
            text("SHOW shared_buffers")
            ).scalar()
        except Exception:
            shared_buffers = "0"

        try:
            effective_cache_size = conn.execute(
            text("SHOW effective_cache_size")
            ).scalar()
        except Exception:
            effective_cache_size = "0"

        try:
         work_mem = conn.execute(
            text("SHOW work_mem")
            ).scalar()
        except Exception:
            work_mem = "0"

    
    
            # uptime
            try:
                uptime_seconds = conn.execute(text(
                    "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))"
                )).scalar()
                uptime_seconds = int(uptime_seconds or 0)
            except Exception:
                uptime_seconds = 0

            days = uptime_seconds // 86400
            hours = (uptime_seconds % 86400) // 3600
            minutes = (uptime_seconds % 3600) // 60

            uptime = (f"{days}d {hours}h {minutes}m" if days > 0 else f"{hours}h {minutes}m")

            last_restart = (
                datetime.datetime.now() - datetime.timedelta(seconds=uptime_seconds)
            ).strftime("%Y-%m-%d %H:%M:%S")

            # connections
            try:
                current_connections = int(conn.execute(text("SELECT count(*) FROM pg_stat_activity")).scalar() or 0)
            except Exception:
                current_connections = 0

            try:
                max_conn_raw = conn.execute(text("SHOW max_connections")).scalar()
                max_connections = int(max_conn_raw) if max_conn_raw is not None else 0
            except Exception:
                max_connections = 0

            connection_usage_pct = round((current_connections / max_connections) * 100, 2) if max_connections > 0 else 0

            # databases and sizes
            databases = []
            total_databases = 0
            total_size_bytes = 0

            try:
                db_result = conn.execute(text(
                    "SELECT d.datname, pg_database_size(d.datname) FROM pg_database d WHERE d.datistemplate = false"
                ))

                for row in db_result:
                    name = row[0]
                    size = int(row[1] or 0)
                    size_mb = round(size / (1024 * 1024), 2)

                    databases.append({
                        "name": name,
                        "tables_count": 0,
                        "size_mb": size_mb
                    })

                    total_databases += 1
                    total_size_bytes += size
            except Exception:
                databases = []

            total_size_mb = round(total_size_bytes / (1024 * 1024), 2) if total_size_bytes > 0 else 0
            total_size_gb = round(total_size_mb / 1024, 2) if total_size_mb > 0 else 0

            # process list
            process_list = []

            try:
                proc_result = conn.execute(text(
                    "SELECT pid, usename, datname, state, query, EXTRACT(EPOCH FROM (now() - COALESCE(query_start, now()))) AS duration FROM pg_stat_activity WHERE pid <> pg_backend_pid()"
                ))

                for row in proc_result:
                    process_list.append({
                        "Id": row[0],
                        "User": row[1],
                        "db": row[2],
                        "State": row[3],
                        "Info": row[4],
                        "Time": int(row[5] or 0)
                    })
            except Exception:
                process_list = []

            long_running_queries = [
    p
    for p in process_list
    if (
        p.get("Time", 0) >= 30
        and p.get("Info")
        and p.get("Info").strip()
        and p.get("Info") not in (
            "ROLLBACK",
            "COMMIT",
            "BEGIN"
        )
        and p.get("State") != "idle"
    )
]
            # replication
            replication = {}
            try:
                repl = conn.execute(text("SELECT * FROM pg_stat_replication"))
                first = repl.fetchone()
                replication = {"state": "REPLICA"} if first else {"state": "STANDALONE"}
            except Exception:
                replication = {"state": "UNKNOWN"}

            # cache hit ratio (from pg_stat_database)
            try:
                stat = conn.execute(text("SELECT sum(blks_hit) AS hit, sum(blks_read) AS read FROM pg_stat_database")).fetchone()
                blks_hit = int(stat[0] or 0)
                blks_read = int(stat[1] or 0)
                cache_hit_ratio = round((blks_hit / (blks_hit + blks_read)) * 100, 2) if (blks_hit + blks_read) > 0 else 0
            except Exception:
                cache_hit_ratio = 0

                                    # basic query stats derived from active queries
                                    # =====================================================
                                    # QUERY STATISTICS
                                    # =====================================================

            try:

                stats = conn.execute(text("""
                        SELECT query, calls
                        FROM pg_stat_statements
                        ORDER BY calls DESC
                        LIMIT 100
                        """)).fetchall()

                qs_counts = {"SELECT": 0,
                        "INSERT": 0,
                        "UPDATE": 0,
                        "DELETE": 0
                        }

                for row in stats:

                    query = (row.query or "").strip().upper()

                    calls = row.calls or 0

                if query.startswith("SELECT"):
                    qs_counts["SELECT"] += calls

                elif query.startswith("INSERT"):
                    qs_counts["INSERT"] += calls

                elif query.startswith("UPDATE"):
                    qs_counts["UPDATE"] += calls

                elif query.startswith("DELETE"):
                    qs_counts["DELETE"] += calls

            except Exception:

                qs_counts = {
                "SELECT": 0,
                "INSERT": 0,
                "UPDATE": 0,
                "DELETE": 0
                }

            chart_query_stats = {
                "labels": ["SELECT", "INSERT", "UPDATE", "DELETE"],
                "values": [qs_counts["SELECT"], qs_counts["INSERT"], qs_counts["UPDATE"], qs_counts["DELETE"]]
            }
            
            try:

                    error_logs = get_postgresql_error_logs(
                    connection.id,
                    limit=100
                    )

                    error_count = len(
                    error_logs.get("data", [])
                    )

            except Exception:

                    error_count = 0
            
            

            payload = {
                "status": "success",
                "connection": conn_meta,
                "health_summary": {
                    "uptime": uptime,
                    "last_restart": last_restart,
                    "host_name": connection.host,
                    "version": version,
                    "replication_state": replication.get("state"),
                    "connection_usage_pct": connection_usage_pct,
                    "cache_usage_pct": cache_hit_ratio,
                    "total_databases": total_databases,
                    "total_tables": 0,
                    "total_size_mb": total_size_mb,
                    "total_size_gb": total_size_gb,
                    "current_connections": current_connections,
                    "max_connections": max_connections,
                    "storage_engine": "PostgreSQL",
                },
                "databases": databases,
                "chart_data": {
                    "connection_pct": connection_usage_pct,
                    "cache_pct": cache_hit_ratio,
                    "query_stats": chart_query_stats,
                    "db_sizes": [
                        {"name": d["name"], "size_mb": d["size_mb"]} for d in databases
                    ]
                },
                "connections_detail": {
                    "current": current_connections,
                    "max": max_connections,
                    "connection_usage_pct": connection_usage_pct
                },
                "memory": {
                    "shared_buffers": shared_buffers,
                    "effective_cache_size": effective_cache_size,
                    "work_mem": work_mem,
                    "cache_usage_pct": cache_hit_ratio
                },
                "query_stats": {
                    "Com_select": qs_counts.get("SELECT", 0),
                    "Com_insert": qs_counts.get("INSERT", 0),
                    "Com_update": qs_counts.get("UPDATE", 0),
                    "Com_delete": qs_counts.get("DELETE", 0),
                    "Questions": sum(qs_counts.values()),
                    "Slow_queries": len(long_running_queries),
                    "slow_queries": len(long_running_queries)
                },
                "network": {
                    "bytes_received": 0,
                    "bytes_sent": 0
                },
                "slow_query_config": {
                    "slow_query_log": "N/A",
                    "long_query_time": 1,
                    "slow_query_log_file": ""
                },
                "error_log_path":  r"C:\Program Files\PostgreSQL\17\data\log",
                "error_log_count": error_count,
                "process_list": process_list,
                "long_running_queries": long_running_queries,
                "replication": replication
            }

            try:
                save_snapshot(connection.id, payload)
            except Exception:
                pass

            return payload

    except Exception as error:

        return {
            "status": "error",
            "error": str(error),
            "connection": conn_meta
        }


# -----------------------------
# Snapshot helpers & log readers
# -----------------------------

LOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), '..', 'logs')
SNAPSHOT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), '..', 'logs', 'snapshots')

def ensure_dirs():
    try:
        os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    except Exception:
        pass

def snapshot_path(connection_id: int):
    ensure_dirs()
    return os.path.join(SNAPSHOT_DIR, f"postgres_snapshot_{connection_id}.json")

def save_snapshot(connection_id: int, payload: dict):
    try:
        path = snapshot_path(connection_id)
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, default=str)
    except Exception:
        pass

def load_snapshot(connection_id: int):
    try:
        path = snapshot_path(connection_id)
        if os.path.exists(path):
            
            with open(path, 'r', encoding='utf-8') as fh:
                return json.load(fh)
            
            
            
    except Exception:
        return None
    
    

def read_log_tail(candidates, limit=200):
    for path in candidates:
        try:
            if not path:
                continue
            if os.path.exists(path):

                # PostgreSQL log directory
                if os.path.isdir(path):

                    log_files = sorted(

                        [
                            os.path.join(path, file)
                            for file in os.listdir(path)
                            if file.endswith(".log")
                        ],

                        key=os.path.getmtime,

                        reverse=True

                    )

                    if not log_files:
                        continue

                    path = log_files[0]

                with open(
                    path,
                    'r',
                    encoding='utf-8',
                    errors='ignore'
                ) as fh:
                    lines = fh.readlines()
                    return [l.strip() for l in lines[-limit:]][::-1]
        except Exception:
            continue
    return []


# =========================================================
# ERROR LOGS
# =========================================================

@router.get("/{connection_id}/error-logs")
def get_postgresql_error_logs(connection_id: int, limit: int = 50):
    """Return last error log lines either from common log paths or from last snapshot."""
    # common candidate paths
    candidates = [

    r"C:\Program Files\PostgreSQL\17\data\log",

    os.path.join(
        os.getcwd(),
        'logs',
        f'postgresql_{connection_id}.log'
    ),

    os.path.join(
        os.getcwd(),
        'logs',
        'postgresql.log'
    )
]

    lines = read_log_tail(candidates, limit)

    if lines:
        return {
            'status': 'success',
            'source': 'file',
            'data': [{'message': l} for l in lines]
        }

    # fallback to snapshot
    snap = load_snapshot(connection_id)
    if snap and snap.get('error_log_path') is not None:
        # try to return last stored errors if present
        return {
            'status': 'success',
            'source': 'snapshot',
            'data': snap.get('last_error_logs', [])
        }

    return {
        'status': 'success',
        'source': 'none',
        'data': []
    }


# =========================================================
# LONG QUERY LOGS
# =========================================================

@router.get("/{connection_id}/long-query-logs")
def get_postgresql_long_query_logs(connection_id: int, limit: int = 50):
    """Return last captured long query log lines (uses log_min_duration_statement output where available)."""
    candidates = [

    r"C:\Program Files\PostgreSQL\17\data\log",

    os.path.join(
        os.getcwd(),
        'logs',
        f'postgresql_{connection_id}.log'
    ),

    os.path.join(
        os.getcwd(),
        'logs',
        'postgresql.log'
    )
]

    lines = read_log_tail(candidates, limit * 5)

    long_lines = []
    if lines:
        for l in lines:
            if 'duration:' in l or 'long query' in l.lower() or 'execute' in l.lower():
                long_lines.append({'message': l})
                if len(long_lines) >= limit:
                    break

    if long_lines:
        return {
            'status': 'success',
            'source': 'file',
            'data': long_lines
        }

    snap = load_snapshot(connection_id)
    if snap:
        return {
            'status': 'success',
            'source': 'snapshot',
            'data': snap.get('long_query_logs', [])
        }

    return {
        'status': 'success',
        'source': 'none',
        'data': []
    }


# =========================================================
# ANALYZE (AI Diagnosis placeholder)
# =========================================================

@router.get("/{connection_id}/analyze")
def analyze_postgresql(connection_id: int):
    """Produce a lightweight analysis from snapshot or live data."""
    snap = load_snapshot(connection_id)

    if not snap:
        return {
            'status': 'error',
            'message': 'No snapshot available to analyze'
        }

    analysis = {}
    try:
        # simple heuristic analysis
        hs = snap.get('health_summary', {})
        qs = snap.get('query_stats', {})
        replication = snap.get('replication', {})

        analysis['connection_ok'] = hs.get('current_connections', 0) >= 0
        analysis['slow_queries'] = qs.get('slow_queries', 0)
        analysis['replication_state'] = replication.get('state')
        analysis['top_issues'] = []

        if analysis['slow_queries'] and analysis['slow_queries'] > 5:
            analysis['top_issues'].append('High number of slow queries')

        if hs.get('connection_usage_pct', 0) > 90:
            analysis['top_issues'].append('Connection usage high')

        if replication.get('state') == 'UNKNOWN':
            analysis['top_issues'].append('Replication state unknown')

    except Exception as e:
        analysis['error'] = str(e)

    return {
        'status': 'success',
        'data': analysis
    }


@router.post("/{connection_id}/analyze-error")
def analyze_postgresql_error(connection_id: int, payload: dict):
    """Accept an error payload and return a short analysis string (markdown-like)."""
    snap = load_snapshot(connection_id)

    parts = []

    em = payload.get('error_message') if isinstance(payload, dict) else None
    ec = payload.get('error_code') if isinstance(payload, dict) else None

    if em:
        parts.append(f"**Observed Error:** {em}")

    if ec:
        parts.append(f"**Error Code:** {ec}")

    if snap:
        hs = snap.get('health_summary', {})
        qs = snap.get('query_stats', {})
        replication = snap.get('replication', {})

        parts.append('\n**Snapshot Summary:**')
        parts.append(f"- Uptime: {hs.get('uptime')}")
        parts.append(f"- Current Connections: {hs.get('current_connections')}/{hs.get('max_connections')}")
        parts.append(f"- Slow Queries: {qs.get('slow_queries')}")
        parts.append(f"- Replication: {replication.get('state')}")

        issues = []
        if qs.get('slow_queries', 0) > 5:
            issues.append('High slow query count')
        if hs.get('connection_usage_pct', 0) > 90:
            issues.append('High connection utilization')
        if replication.get('state') == 'UNKNOWN':
            issues.append('Replication not reporting')

        if issues:
            parts.append('\n**Potential Issues:**')
            for it in issues:
                parts.append(f'- {it}')

    else:
        parts.append('\nNo snapshot available to enrich analysis.')

    analysis_text = '\n'.join(parts)

    return {
        'status': 'success',
        'data': {
            'analysis': analysis_text
        }
    }
        