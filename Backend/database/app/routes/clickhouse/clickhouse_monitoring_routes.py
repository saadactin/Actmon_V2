from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.clickhouse import clickhouse_monitoring_service, clickhouse_ai_analysis

router = APIRouter(
    prefix="/api/v1/connections/clickhouse",
    tags=["ClickHouse Monitoring"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/ch-dashboard")
def get_ch_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_dashboard(conn_id, db)


@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_dashboard(conn_id, db)


@router.get("/{conn_id}/ch-queries")
def get_ch_queries(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_queries(conn_id, db)


@router.get("/{conn_id}/ch-query-log")
def get_ch_query_log(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_query_log(conn_id, db)


@router.get("/{conn_id}/ch-slow-queries")
def get_ch_slow_queries(
    conn_id: int,
    db_name: Optional[str] = None,
    query_type: Optional[str] = None,
    severity: Optional[str] = None,
    user_name: Optional[str] = None,
    search: Optional[str] = None,
    min_avg_ms: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
    db: Session = Depends(get_db),
):
    return clickhouse_monitoring_service.get_slow_queries_filtered(
        conn_id, db, db_name=db_name, query_type=query_type, severity=severity,
        user_name=user_name, search=search, min_avg_ms=min_avg_ms,
        date_from=date_from, date_to=date_to, sort_by=sort_by, sort_dir=sort_dir,
        page=page, page_size=page_size,
    )


@router.post("/{conn_id}/ch-slow-queries/analyze-groq")
def analyze_ch_slow_query(
    conn_id: int, payload: clickhouse_ai_analysis.ClickHouseSlowQueryGroqRequest, db: Session = Depends(get_db)
):
    return clickhouse_ai_analysis.analyze_slow_query_groq(conn_id, payload, db)


class ChExplainRequest(BaseModel):
    sql_text: str


@router.post("/{conn_id}/ch-slow-queries/explain")
def explain_ch_slow_query(conn_id: int, payload: ChExplainRequest, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.explain_query(conn_id, payload.sql_text, db)


@router.get("/{conn_id}/ch-tables")
def get_ch_tables(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_tables(conn_id, db)


@router.get("/{conn_id}/ch-partitions")
def get_ch_partitions(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_partitions(conn_id, db)


@router.get("/{conn_id}/ch-merges")
def get_ch_merges(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_merges(conn_id, db)


@router.get("/{conn_id}/ch-replicas")
def get_ch_replicas(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_replicas(conn_id, db)


@router.get("/{conn_id}/ch-clusters")
def get_ch_clusters(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_clusters(conn_id, db)


@router.get("/{conn_id}/ch-databases")
def get_ch_databases(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_databases(conn_id, db)


@router.get("/{conn_id}/ch-settings")
def get_ch_settings(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_settings(conn_id, db)


@router.get("/{conn_id}/ch-system-metrics")
def get_ch_system_metrics(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_system_metrics(conn_id, db)


@router.get("/{conn_id}/ch-error-logs")
def get_ch_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_error_logs(conn_id, db)


@router.get("/{conn_id}/ch-table-analysis")
def get_ch_table_analysis(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_table_analysis(conn_id, db)
