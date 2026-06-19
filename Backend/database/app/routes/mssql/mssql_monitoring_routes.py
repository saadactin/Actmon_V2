from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mssql import mssql_monitoring_service

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL Monitoring"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/monitoring-dashboard")
def get_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_monitoring_dashboard(conn_id, db)


@router.get("/{conn_id}/mssql-slow-queries")
def get_mssql_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_slow_queries(conn_id, db)


@router.get("/{conn_id}/mssql-error-logs")
def get_mssql_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_error_logs(conn_id, db)


@router.get("/{conn_id}/mssql-index-analysis")
def get_mssql_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    return mssql_monitoring_service.get_index_analysis(conn_id, db)
