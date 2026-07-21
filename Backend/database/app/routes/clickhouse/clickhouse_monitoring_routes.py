from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.clickhouse import clickhouse_monitoring_service

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
def get_ch_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    return clickhouse_monitoring_service.get_slow_queries(conn_id, db)


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
