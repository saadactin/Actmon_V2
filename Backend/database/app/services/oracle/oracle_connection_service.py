from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import OracleConnectionCreate


def list_connections(db: Session, org_id=None):
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "oracle"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": connections}


def create_connection(request: OracleConnectionCreate, db: Session, org_id=1):
    try:
        new_connection = ConnectionMaster(
            db_type="oracle",
            org_id=org_id,
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
            "data": new_connection,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def get_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    return {"status": "success", "data": connection}


def update_connection(connection_id: int, request: OracleConnectionCreate, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
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
            "data": connection,
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def delete_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    try:
        db.delete(connection)
        db.commit()
        return {"status": "success", "message": "Oracle connection deleted successfully"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))


def test_connection(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    try:
        pw = quote_plus(connection.password or "")
        svc = (getattr(connection, "service_name", None)
               or getattr(connection, "sid", None)
               or connection.database_name or "")
        connection_string = (
            f"oracle+oracledb://{connection.username}:{pw}"
            f"@{connection.host}:{connection.port}/?service_name={svc}"
        )
        engine = create_engine(connection_string, echo=False)
        with engine.connect() as conn:
            result = conn.execute(text("SELECT banner FROM v$version WHERE rownum = 1"))
            version = result.fetchone()[0]
        return {
            "status": "success",
            "message": "Oracle connection test successful",
            "version": version,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
