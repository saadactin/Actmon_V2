"""
PostgreSQL Error Analysis routes — thin handlers only.
All business logic lives in app/services/postgres/postgres_error_analysis_service.py
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.postgres.postgres_error_analysis_service import (
    svc_analyze_error,
    svc_get_error_logs,
    svc_get_metrics,
)

router = APIRouter(prefix="/api/v1/postgresql", tags=["PostgreSQL Error Analysis"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/{connection_id}/analyze-error")
def analyze_postgresql_error_endpoint(
    connection_id: int,
    error_data: dict,
    db: Session = Depends(get_db),
):
    return svc_analyze_error(connection_id, error_data, db)


@router.get("/{connection_id}/error-logs")
def get_postgresql_error_logs(
    connection_id: int,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    return svc_get_error_logs(connection_id, db, limit)


@router.get("/{connection_id}/metrics")
def get_postgresql_metrics(connection_id: int, db: Session = Depends(get_db)):
    return svc_get_metrics(connection_id, db)
