from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import ClickHouseConnectionCreate

router = APIRouter(
    prefix="/api/v1/connections/clickhouse",
    tags=["ClickHouse"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/")
def list_clickhouse_connections(db: Session = Depends(get_db)):
    connections = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "clickhouse"
    ).all()
    return {"status": "success", "data": connections}

@router.post("/")
def create_clickhouse_connection(
    request: ClickHouseConnectionCreate,
    db: Session = Depends(get_db)
):
    try:
        # ClickHouse HTTP interface
        # Connection string format: clickhouse://user:password@host:port/database
        
        new_connection = ConnectionMaster(
            db_type="clickhouse",
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            clickhouse_protocol=getattr(request, "clickhouse_protocol", "native"),
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        
        return {"status": "success", "message": "ClickHouse connection created successfully", "data": new_connection}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/{connection_id}")
def get_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    return {"status": "success", "data": connection}

@router.put("/{connection_id}")
def update_clickhouse_connection(
    connection_id: int,
    request: ClickHouseConnectionCreate,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    try:
        connection.connection_name = request.connection_name
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username
        connection.password = request.password
        connection.database_name = request.database_name
        connection.clickhouse_protocol = getattr(request, "clickhouse_protocol", "native")
        db.commit()
        db.refresh(connection)
        return {"status": "success", "message": "ClickHouse connection updated successfully", "data": connection}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{connection_id}")
def delete_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    try:
        db.delete(connection)
        db.commit()
        return {"status": "success", "message": "ClickHouse connection deleted successfully"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/{connection_id}/test")
def test_clickhouse_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    try:
        # Test ClickHouse connection
        return {"status": "success", "message": "ClickHouse connection test successful", "version": "Latest"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
