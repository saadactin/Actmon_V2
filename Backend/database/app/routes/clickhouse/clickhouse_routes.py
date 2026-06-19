from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import ClickHouseConnectionCreate
from app.services.clickhouse import clickhouse_connection_service

router = APIRouter(
    prefix="/api/v1/connections/clickhouse",
    tags=["ClickHouse"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def list_clickhouse_connections(db: Session = Depends(get_db)):
    return clickhouse_connection_service.list_connections(db)


@router.post("/")
def create_clickhouse_connection(request: ClickHouseConnectionCreate, db: Session = Depends(get_db)):
    return clickhouse_connection_service.create_connection(request, db)


@router.get("/{connection_id}")
def get_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    return clickhouse_connection_service.get_connection(connection_id, db)


@router.put("/{connection_id}")
def update_clickhouse_connection(connection_id: int, request: ClickHouseConnectionCreate, db: Session = Depends(get_db)):
    return clickhouse_connection_service.update_connection(connection_id, request, db)


@router.delete("/{connection_id}")
def delete_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    return clickhouse_connection_service.delete_connection(connection_id, db)


@router.post("/{connection_id}/test")
def test_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    return clickhouse_connection_service.test_connection(connection_id, db)
