from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_binlog_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Binary Logs"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/binlog/status")
def binlog_status(conn_id: int, db: Session = Depends(get_db)):
    return mysql_binlog_service.get_binlog_status(conn_id, db)


@router.get("/{conn_id}/binlogs")
def list_binlogs(
    conn_id: int,
    search: Optional[str] = Query(None),
    sort_by: str = Query("name", pattern="^(name|size)$"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    db: Session = Depends(get_db),
):
    return mysql_binlog_service.list_binlog_files(
        conn_id, db, search=search, sort_by=sort_by, sort_dir=sort_dir, page=page, page_size=page_size,
    )


@router.get("/{conn_id}/binlogs/{log_name}/events")
def binlog_events(
    conn_id: int,
    log_name: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    return mysql_binlog_service.get_binlog_events(conn_id, db, log_name, page=page, page_size=page_size)
