from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mssql import mssql_error_service

router = APIRouter(
    prefix="/api/v1/mssql",
    tags=["MSSQL Error Analysis"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/{connection_id}/analyze-error")
def analyze_mssql_error_endpoint(connection_id: int, error_data: dict, db: Session = Depends(get_db)):
    return mssql_error_service.analyze_error(connection_id, error_data, db)


@router.get("/{connection_id}/error-logs")
def get_mssql_error_logs(connection_id: int, limit: int = 50, db: Session = Depends(get_db)):
    return mssql_error_service.get_error_logs(connection_id, limit, db)


@router.get("/{connection_id}/metrics")
def get_mssql_metrics(connection_id: int, db: Session = Depends(get_db)):
    return mssql_error_service.get_metrics(connection_id, db)
