from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_replication_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Replication"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/replication/status")
def replication_status(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_replication_service.get_replication_status(conn_id, db, live=live)


@router.get("/{conn_id}/replication/variables")
def replication_variables(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_replication_service.get_replication_variables(conn_id, db, live=live)
