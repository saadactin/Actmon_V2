from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_table_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Table Explorer"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/databases")
def list_databases(conn_id: int, db: Session = Depends(get_db)):
    return mysql_table_service.get_databases(conn_id, db)


@router.get("/{conn_id}/all-tables")
def list_all_tables(conn_id: int, db: Session = Depends(get_db)):
    return mysql_table_service.get_all_tables(conn_id, db)


@router.get("/{conn_id}/databases/{db_name}/tables")
def list_tables(conn_id: int, db_name: str, db: Session = Depends(get_db)):
    return mysql_table_service.get_tables(conn_id, db_name, db)


@router.get("/{conn_id}/databases/{db_name}/tables/{table_name}")
def table_detail(conn_id: int, db_name: str, table_name: str, db: Session = Depends(get_db)):
    return mysql_table_service.get_table_detail(conn_id, db_name, table_name, db)


@router.get("/{conn_id}/databases/{db_name}/tables/{table_name}/data")
def table_sample_data(conn_id: int, db_name: str, table_name: str, db: Session = Depends(get_db)):
    return mysql_table_service.get_table_sample_data(conn_id, db_name, table_name, db)
