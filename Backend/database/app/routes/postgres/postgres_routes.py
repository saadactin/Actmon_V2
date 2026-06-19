"""
PostgreSQL Connection routes — thin handlers only.
All business logic lives in app/services/postgres/postgres_connection_service.py
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import PostgreSQLConnectionCreate
from app.services.postgres.postgres_connection_service import (
    svc_list_connections,
    svc_create_connection,
    svc_get_connection,
    svc_update_connection,
    svc_delete_connection,
    svc_test_connection,
    svc_get_dashboard,
    svc_get_error_logs,
    svc_get_long_query_logs,
    svc_analyze,
    svc_analyze_error,
)

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def list_postgresql_connections(db: Session = Depends(get_db)):
    return svc_list_connections(db)


@router.post("/")
def create_postgresql_connection(request: PostgreSQLConnectionCreate, db: Session = Depends(get_db)):
    return svc_create_connection(request, db)


@router.get("/{connection_id}")
def get_postgresql_connection(connection_id: int, db: Session = Depends(get_db)):
    return svc_get_connection(connection_id, db)


@router.put("/{connection_id}")
def update_postgresql_connection(
    connection_id: int,
    request: PostgreSQLConnectionCreate,
    db: Session = Depends(get_db),
):
    return svc_update_connection(connection_id, request, db)


@router.delete("/{connection_id}")
def delete_postgresql_connection(connection_id: int, db: Session = Depends(get_db)):
    return svc_delete_connection(connection_id, db)


@router.post("/{connection_id}/test")
def test_postgresql_connection(connection_id: int, db: Session = Depends(get_db)):
    return svc_test_connection(connection_id, db)


@router.get("/{connection_id}/dashboard")
def get_postgresql_dashboard(connection_id: int, db: Session = Depends(get_db)):
    return svc_get_dashboard(connection_id, db)


@router.get("/{connection_id}/error-logs")
def get_postgresql_error_logs(connection_id: int, limit: int = 50):
    return svc_get_error_logs(connection_id, limit)


@router.get("/{connection_id}/long-query-logs")
def get_postgresql_long_query_logs(connection_id: int, limit: int = 50):
    return svc_get_long_query_logs(connection_id, limit)


@router.get("/{connection_id}/analyze")
def analyze_postgresql(connection_id: int):
    return svc_analyze(connection_id)


@router.post("/{connection_id}/analyze-error")
def analyze_postgresql_error(connection_id: int, payload: dict):
    return svc_analyze_error(connection_id, payload)
