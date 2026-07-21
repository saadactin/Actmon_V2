from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.clickhouse import clickhouse_error_service

router = APIRouter(
    prefix="/api/v1/clickhouse",
    tags=["ClickHouse Error Analysis"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/{connection_id}/analyze-error")
def analyze_clickhouse_error_endpoint(connection_id: int, error_data: dict, db: Session = Depends(get_db)):
    return clickhouse_error_service.analyze_error(
        connection_id,
        error_data.get("error_message", ""),
        error_data.get("error_code", ""),
        db,
    )


@router.get("/{connection_id}/error-logs")
def get_clickhouse_error_logs(connection_id: int, limit: int = 50, db: Session = Depends(get_db)):
    return clickhouse_error_service.get_error_logs(connection_id, limit, db)


@router.get("/{connection_id}/metrics")
def get_clickhouse_metrics(connection_id: int, db: Session = Depends(get_db)):
    return clickhouse_error_service.get_metrics(connection_id, db)
