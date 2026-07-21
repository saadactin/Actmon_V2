from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_index_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Index Analysis"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/index-analysis")
def index_analysis(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_index_service.get_index_analysis(conn_id, db, live=live)
