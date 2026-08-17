from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import MongoDBConnectionCreate
from app.services.common.credential_encryption_service import credential_encryption


def list_connections(db: Session, org_id=None):
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "mongodb"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": [credential_encryption.mask_connection_fields(c) for c in connections]}


def create_connection(request: MongoDBConnectionCreate, db: Session, org_id=1):
    try:
        new_connection = ConnectionMaster(
            db_type="mongodb",
            org_id=org_id,
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
            "data": credential_encryption.mask_connection_fields(new_connection),
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
    return {"status": "success", "data": credential_encryption.mask_connection_fields(connection)}


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
        if not credential_encryption.looks_like_mask(request.password):
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
            "data": credential_encryption.mask_connection_fields(connection),
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
    """Real auth+query probe — was previously a stub that returned canned
    success without ever opening a connection, which made the Diagnosis and
    Database Agent pages' "Connection" check silently fake for MongoDB."""
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")

    import time
    from app.services.mongo.mongo_monitoring_service import _mongo_client

    t0 = time.monotonic()
    try:
        mc = _mongo_client(connection)
        mc.admin.command("ping")
        build_info = mc.admin.command("buildInfo")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    latency_ms = round((time.monotonic() - t0) * 1000, 1)
    return {
        "status": "success",
        "message": "Connected and authenticated successfully.",
        "version": build_info.get("version", "unknown"),
        "latency_ms": latency_ms,
    }
