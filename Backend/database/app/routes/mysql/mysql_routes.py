from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import MySQLConnectionCreate
from app.services.mysql import mysql_dashboard_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def list_mysql_connections(db: Session = Depends(get_db)):
    return mysql_dashboard_service.list_connections(db)


@router.post("/")
def create_mysql_connection(request: MySQLConnectionCreate, db: Session = Depends(get_db)):
    return mysql_dashboard_service.create_connection(request, db)


@router.delete("/{conn_id}")
def delete_mysql_connection(conn_id: int, db: Session = Depends(get_db)):
    return mysql_dashboard_service.delete_connection(conn_id, db)


@router.get("/{conn_id}/dashboard")
def get_mysql_dashboard(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_dashboard(conn_id, db, live=live)


@router.get("/{conn_id}/backup-info")
def get_backup_info(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_backup_info(conn_id, db, live=live)


@router.get("/{conn_id}/table-stats")
def get_table_stats(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_table_stats(conn_id, db, live=live)


@router.get("/{conn_id}/user-stats")
def get_user_stats(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_user_stats(conn_id, db, live=live)


@router.get("/{conn_id}/innodb-metrics")
def get_innodb_metrics(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_innodb_metrics(conn_id, db, live=live)


@router.get("/{conn_id}/performance-detail")
def get_performance_detail(conn_id: int, live: bool = Query(False), db: Session = Depends(get_db)):
    return mysql_dashboard_service.get_performance_detail(conn_id, db, live=live)
