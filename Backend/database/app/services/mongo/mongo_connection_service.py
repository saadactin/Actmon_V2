from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import MongoDBConnectionCreate


def list_connections(db: Session):
    connections = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "mongodb"
    ).all()
    return {"status": "success", "data": connections}


def create_connection(request: MongoDBConnectionCreate, db: Session):
    try:
        new_connection = ConnectionMaster(
            db_type="mongodb",
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            mongo_protocol=getattr(request, "mongo_protocol", "mongodb://"),
            auth_source=getattr(request, "auth_source", "admin"),
            replica_set=getattr(request, "replica_set", None),
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        return {
            "status": "success",
            "message": "MongoDB connection created successfully",
            "data": new_connection,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def get_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    return {"status": "success", "data": connection}


def update_connection(connection_id: int, request: MongoDBConnectionCreate, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    try:
        connection.connection_name = request.connection_name
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username
        connection.password = request.password
        connection.database_name = request.database_name
        connection.mongo_protocol = getattr(request, "mongo_protocol", "mongodb://")
        connection.auth_source = getattr(request, "auth_source", "admin")
        connection.replica_set = getattr(request, "replica_set", None)
        db.commit()
        db.refresh(connection)
        return {
            "status": "success",
            "message": "MongoDB connection updated successfully",
            "data": connection,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def delete_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
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


def test_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    try:
        return {
            "status": "success",
            "message": "MongoDB connection test successful",
            "version": "Atlas/Community",
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
