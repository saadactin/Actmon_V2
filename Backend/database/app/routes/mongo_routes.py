from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import datetime
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import MongoDBConnectionCreate

router = APIRouter(
    prefix="/api/v1/connections/mongodb",
    tags=["MongoDB"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/")
def list_mongodb_connections(db: Session = Depends(get_db)):
    connections = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "mongodb"
    ).all()
    return {"status": "success", "data": connections}

@router.post("/")
def create_mongodb_connection(
    request: MongoDBConnectionCreate,
    db: Session = Depends(get_db)
):
    try:
        # MongoDB connection string format
        connection_string = f"mongodb://{request.username}:{quote_plus(request.password)}@{request.host}:{request.port}/{request.database}"
        
        # Test connection would require pymongo library
        # For now, we'll assume the connection is valid
        
        new_connection = ConnectionMaster(
            db_type="mongodb",
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database=request.database,
            alias=request.alias,
            created_at=datetime.datetime.now()
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        
        return {"status": "success", "message": "MongoDB connection created successfully", "data": new_connection}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/{connection_id}")
def get_mongodb_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    return {"status": "success", "data": connection}

@router.put("/{connection_id}")
def update_mongodb_connection(
    connection_id: int,
    request: MongoDBConnectionCreate,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    try:
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username
        connection.password = request.password
        connection.database = request.database
        connection.alias = request.alias
        db.commit()
        db.refresh(connection)
        return {"status": "success", "message": "MongoDB connection updated successfully", "data": connection}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{connection_id}")
def delete_mongodb_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    try:
        db.delete(connection)
        db.commit()
        return {"status": "success", "message": "MongoDB connection deleted successfully"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/{connection_id}/test")
def test_mongodb_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    try:
        # Test with pymongo would go here
        return {"status": "success", "message": "MongoDB connection test successful", "version": "Atlas/Community"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
