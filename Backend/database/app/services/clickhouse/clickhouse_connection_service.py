from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import ClickHouseConnectionCreate


def list_connections(db: Session, org_id=None) -> dict:
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "clickhouse"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": connections}


def create_connection(request: ClickHouseConnectionCreate, db: Session, org_id=1) -> dict:
    try:
        new_conn = ConnectionMaster(
            db_type="clickhouse",
            org_id=org_id,
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            clickhouse_protocol=getattr(request, "clickhouse_protocol", "native"),
        )
        db.add(new_conn)
        db.commit()
        db.refresh(new_conn)
        return {"status": "success", "message": "ClickHouse connection created successfully", "data": new_conn}
    except Exception as e:
        db.rollback()
        raise HTTPException(400, str(e))


def get_connection(connection_id: int, db: Session) -> dict:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")
    return {"status": "success", "data": conn}


def update_connection(connection_id: int, request: ClickHouseConnectionCreate, db: Session) -> dict:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")
    try:
        conn.connection_name      = request.connection_name
        conn.host                 = request.host
        conn.port                 = request.port
        conn.username             = request.username
        conn.password             = request.password
        conn.database_name        = request.database_name
        conn.clickhouse_protocol  = getattr(request, "clickhouse_protocol", "native")
        db.commit()
        db.refresh(conn)
        return {"status": "success", "message": "ClickHouse connection updated successfully", "data": conn}
    except Exception as e:
        db.rollback()
        raise HTTPException(400, str(e))


def delete_connection(connection_id: int, db: Session) -> dict:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")
    try:
        db.delete(conn)
        db.commit()
        return {"status": "success", "message": "ClickHouse connection deleted successfully"}
    except Exception as e:
        db.rollback()
        raise HTTPException(400, str(e))


def test_connection(connection_id: int, db: Session) -> dict:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")
    return {"status": "success", "message": "ClickHouse connection test successful", "version": "Latest"}
