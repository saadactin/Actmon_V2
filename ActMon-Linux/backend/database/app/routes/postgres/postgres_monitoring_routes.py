"""
PostgreSQL Monitoring routes — thin handlers only.
All business logic lives in app/services/postgres/postgres_monitoring_service.py
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.postgres.postgres_monitoring_service import (
    # Pydantic models
    PgSlowQueryGroqRequest,
    PgExplainRequest,
    ErrorAnalysisRequest,
    # svc functions 1–11
    svc_monitoring_dashboard,
    svc_pg_slow_queries,
    svc_enable_pg_stat_statements,
    svc_pg_index_analysis,
    svc_replication_detail,
    svc_queries_detail,
    svc_tables_detail,
    svc_table_structure,
    svc_config_detail,
    svc_users_detail,
    svc_storage_detail,
    # svc functions 12–15
    svc_analyze_slow_query_groq,
    svc_explain_analyze,
    svc_pg_error_logs,
    svc_pg_analyze_error,
    # svc functions 16–24
    svc_pg_wal_stats,
    svc_pg_checkpoint_stats,
    svc_pg_session_details,
    svc_pg_replication_detail,
    svc_pg_slru_stats,
    svc_pg_ssl_stats,
    svc_pg_query_analytics,
    svc_pg_database_health,
    svc_pg_storage_objects,
)

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL Monitoring"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── 1. Monitoring Dashboard ───────────────────────────────────────────────────
@router.get("/{conn_id}/monitoring-dashboard")
def route_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return svc_monitoring_dashboard(conn_id, db)


# ── 2. Slow Queries ───────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-slow-queries")
def route_pg_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_slow_queries(conn_id, db)


# ── 3. Enable pg_stat_statements ─────────────────────────────────────────────
@router.post("/{conn_id}/enable-pg-stat-statements")
def route_enable_pg_stat_statements(conn_id: int, database: str = None, db: Session = Depends(get_db)):
    return svc_enable_pg_stat_statements(conn_id, db, database=database)


# ── 4. Index Analysis ─────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-index-analysis")
def route_pg_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_index_analysis(conn_id, db)


# ── 5. Replication Detail ─────────────────────────────────────────────────────
@router.get("/{conn_id}/replication-detail")
def route_replication_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_replication_detail(conn_id, db)


# ── 6. Queries Detail ─────────────────────────────────────────────────────────
@router.get("/{conn_id}/queries-detail")
def route_queries_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_queries_detail(conn_id, db)


# ── 7. Tables Detail ──────────────────────────────────────────────────────────
@router.get("/{conn_id}/tables-detail")
def route_tables_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_tables_detail(conn_id, db)


# ── 8. Table Structure ────────────────────────────────────────────────────────
@router.get("/{conn_id}/table-structure")
def route_table_structure(
    conn_id:  int,
    database: str,
    schema:   str = "public",
    table:    str = "",
    db:       Session = Depends(get_db),
):
    return svc_table_structure(conn_id, database, db, schema, table)


# ── 9. Config Detail ──────────────────────────────────────────────────────────
@router.get("/{conn_id}/config-detail")
def route_config_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_config_detail(conn_id, db)


# ── 10. Users Detail ──────────────────────────────────────────────────────────
@router.get("/{conn_id}/users-detail")
def route_users_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_users_detail(conn_id, db)


# ── 11. Storage Detail ────────────────────────────────────────────────────────
@router.get("/{conn_id}/storage-detail")
def route_storage_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_storage_detail(conn_id, db)


# ── 12. Analyze Slow Query — Groq ─────────────────────────────────────────────
@router.post("/{conn_id}/pg-slow-queries/analyze-groq")
def route_analyze_slow_query_groq(
    conn_id: int,
    payload: PgSlowQueryGroqRequest,
    db:      Session = Depends(get_db),
):
    return svc_analyze_slow_query_groq(conn_id, payload, db)


# ── 13. Explain Analyze ───────────────────────────────────────────────────────
@router.post("/{conn_id}/pg-slow-queries/explain-analyze")
def route_explain_analyze(
    conn_id: int,
    payload: PgExplainRequest,
    db:      Session = Depends(get_db),
):
    return svc_explain_analyze(conn_id, payload, db)


# ── 14. Error Logs ────────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-error-logs")
def route_pg_error_logs(
    conn_id: int,
    limit:   int = 300,
    db:      Session = Depends(get_db),
):
    return svc_pg_error_logs(conn_id, db, limit)


# ── 15. AI Analyze Error ──────────────────────────────────────────────────────
@router.post("/{conn_id}/pg-analyze-error")
def route_pg_analyze_error(
    conn_id: int,
    payload: ErrorAnalysisRequest,
    db:      Session = Depends(get_db),
):
    return svc_pg_analyze_error(conn_id, payload, db)


# ── 16. WAL Statistics ────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-wal-stats")
def route_pg_wal_stats(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_wal_stats(conn_id, db)


# ── 17. Checkpoint Statistics ─────────────────────────────────────────────────
@router.get("/{conn_id}/pg-checkpoint-stats")
def route_pg_checkpoint_stats(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_checkpoint_stats(conn_id, db)


# ── 18. Session Details ───────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-session-details")
def route_pg_session_details(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_session_details(conn_id, db)


# ── 19. Replication Detail (PG17 extended) ────────────────────────────────────
@router.get("/{conn_id}/pg-replication-detail")
def route_pg_replication_detail(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_replication_detail(conn_id, db)


# ── 20. SLRU Stats ────────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-slru-stats")
def route_pg_slru_stats(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_slru_stats(conn_id, db)


# ── 21. SSL Stats ─────────────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-ssl-stats")
def route_pg_ssl_stats(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_ssl_stats(conn_id, db)


# ── 22. Query Analytics ───────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-query-analytics")
def route_pg_query_analytics(
    conn_id: int,
    sort:    str = "mean_exec_time",
    limit:   int = 100,
    db:      Session = Depends(get_db),
):
    return svc_pg_query_analytics(conn_id, db, sort, limit)


# ── 23. Database Health ───────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-database-health")
def route_pg_database_health(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_database_health(conn_id, db)


# ── 24. Storage Objects ───────────────────────────────────────────────────────
@router.get("/{conn_id}/pg-storage-objects")
def route_pg_storage_objects(conn_id: int, db: Session = Depends(get_db)):
    return svc_pg_storage_objects(conn_id, db)
