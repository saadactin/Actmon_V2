from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import ClickHouseConnectionCreate
from app.services.common.credential_encryption_service import credential_encryption


def list_connections(db: Session, org_id=None) -> dict:
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "clickhouse"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": [credential_encryption.mask_connection_fields(c) for c in connections]}


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
        return {"status": "success", "message": "ClickHouse connection created successfully",
                "data": credential_encryption.mask_connection_fields(new_conn)}
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
    return {"status": "success", "data": credential_encryption.mask_connection_fields(conn)}


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
        if not credential_encryption.looks_like_mask(request.password):
            conn.password = request.password
        conn.database_name        = request.database_name
        conn.clickhouse_protocol  = getattr(request, "clickhouse_protocol", "native")
        db.commit()
        db.refresh(conn)
        return {"status": "success", "message": "ClickHouse connection updated successfully",
                "data": credential_encryption.mask_connection_fields(conn)}
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
    """Real auth+query probe — was previously a stub that returned canned
    success without ever opening a connection, which made the Diagnosis and
    Database Agent pages' "Connection" check silently fake for ClickHouse."""
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")

    import time
    from app.services.clickhouse.clickhouse_monitoring_service import _safe_query

    t0 = time.monotonic()
    rows, err = _safe_query(conn, "SELECT version() AS version")
    latency_ms = round((time.monotonic() - t0) * 1000, 1)
    if err or not rows:
        raise HTTPException(400, err or "ClickHouse did not return a version — connection failed.")
    return {
        "status": "success",
        "message": "Connected and authenticated successfully.",
        "version": rows[0].get("version", "unknown"),
        "latency_ms": latency_ms,
    }
