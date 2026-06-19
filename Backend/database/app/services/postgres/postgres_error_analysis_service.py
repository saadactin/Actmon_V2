"""
PostgreSQL Error Analysis Service — business logic for error analysis endpoints.
"""

import datetime
from urllib.parse import quote_plus

from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.postgres.postgres_ai_analysis import analyze_postgresql_error


# ──────────────────────────────────────────────────────────────
#  HELPERS
# ──────────────────────────────────────────────────────────────

def _pg_engine(conn):
    url = f"postgresql://{conn.username}:{quote_plus(conn.password)}@{conn.host}:{conn.port}/{conn.database_name}"
    return create_engine(url, echo=False)


def _get_conn_or_404(connection_id: int, db: Session):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "postgresql"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="PostgreSQL connection not found")
    return conn


# ──────────────────────────────────────────────────────────────
#  SERVICE FUNCTIONS
# ──────────────────────────────────────────────────────────────

def svc_analyze_error(connection_id: int, error_data: dict, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        engine = _pg_engine(conn)
        analysis = analyze_postgresql_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=engine,
        )
        return {
            "status": "success",
            "data": {
                "analysis":  analysis,
                "timestamp": datetime.datetime.now().isoformat(),
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def svc_get_error_logs(connection_id: int, db: Session, limit: int = 50):
    conn = _get_conn_or_404(connection_id, db)
    try:
        engine = _pg_engine(conn)
        with engine.connect() as c:
            result = c.execute(text(f"""
                SELECT usename, application_name, state, query_start, state_change
                FROM pg_stat_activity
                WHERE state IS NOT NULL
                ORDER BY query_start DESC
                LIMIT {limit}
            """))
            logs = [dict(row._mapping) for row in result.fetchall()]
        return {"status": "success", "data": logs}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def svc_get_metrics(connection_id: int, db: Session):
    conn = _get_conn_or_404(connection_id, db)
    try:
        engine = _pg_engine(conn)
        with engine.connect() as c:
            cache_row = c.execute(text("""
                SELECT
                    sum(heap_blks_read) AS heap_read,
                    sum(heap_blks_hit)  AS heap_hit,
                    sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) AS ratio
                FROM pg_statio_user_tables
            """)).fetchone()

            tables = [
                dict(row._mapping)
                for row in c.execute(text("""
                    SELECT schemaname, tablename,
                           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
                    FROM pg_tables
                    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
                    LIMIT 10
                """)).fetchall()
            ]

        return {
            "status": "success",
            "data": {
                "cache_hit_ratio": float(cache_row[2]) if cache_row and cache_row[2] else 0,
                "top_tables": tables,
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
