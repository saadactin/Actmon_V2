from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import OracleConnectionCreate

router = APIRouter(
    prefix="/api/v1/connections/oracle",
    tags=["Oracle"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# GET ALL ORACLE CONNECTIONS
@router.get("/")
def list_oracle_connections(db: Session = Depends(get_db)):
    connections = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "oracle"
    ).all()
    
    return {
        "status": "success",
        "data": connections
    }

# CREATE ORACLE CONNECTION
@router.post("/")
def create_oracle_connection(
    request: OracleConnectionCreate,
    db: Session = Depends(get_db)
):
    try:
        new_connection = ConnectionMaster(
            db_type="oracle",
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            service_name=getattr(request, "service_name", None),
            sid=getattr(request, "sid", None),
            tns_descriptor=getattr(request, "tns_descriptor", None),
            oracle_connect_string=getattr(request, "oracle_connect_string", None),
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        
        return {
            "status": "success",
            "message": "Oracle connection created successfully",
            "data": new_connection
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# GET ORACLE CONNECTION DETAILS
@router.get("/{connection_id}")
def get_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    
    return {
        "status": "success",
        "data": connection
    }

# UPDATE ORACLE CONNECTION
@router.put("/{connection_id}")
def update_oracle_connection(
    connection_id: int,
    request: OracleConnectionCreate,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    
    try:
        connection.connection_name = request.connection_name
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username
        connection.password = request.password
        connection.database_name = request.database_name
        connection.service_name = getattr(request, "service_name", None)
        connection.sid = getattr(request, "sid", None)
        connection.tns_descriptor = getattr(request, "tns_descriptor", None)
        connection.oracle_connect_string = getattr(request, "oracle_connect_string", None)

        db.commit()
        db.refresh(connection)

        return {
            "status": "success",
            "message": "Oracle connection updated successfully",
            "data": connection
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# DELETE ORACLE CONNECTION
@router.delete("/{connection_id}")
def delete_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    
    try:
        db.delete(connection)
        db.commit()
        
        return {
            "status": "success",
            "message": "Oracle connection deleted successfully"
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# TEST ORACLE CONNECTION
@router.post("/{connection_id}/test")
def test_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    
    try:
        pw = quote_plus(connection.password or "")
        svc = getattr(connection, "service_name", None) or getattr(connection, "sid", None) or connection.database_name or ""
        connection_string = f"oracle+oracledb://{connection.username}:{pw}@{connection.host}:{connection.port}/?service_name={svc}"
        engine = create_engine(connection_string, echo=False)
        with engine.connect() as conn:
            result = conn.execute(text("SELECT banner FROM v$version WHERE rownum = 1"))
            version = result.fetchone()[0]
        
        return {
            "status": "success",
            "message": "Oracle connection test successful",
            "version": version
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{conn_id}")
def delete_oracle(conn_id: int):
    return {
        "status": "success",
        "message": f"Delete Oracle Connection {conn_id}"
    }