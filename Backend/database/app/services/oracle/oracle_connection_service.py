from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from urllib.parse import quote_plus

from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import OracleConnectionCreate
from app.services.common.credential_encryption_service import credential_encryption


def _clean_dsn_field(raw_value, existing_value):
    """Guard + strip for `tns_descriptor`/`oracle_connect_string`: if `raw_value`
    is a mask placeholder round-tripped from a GET response, keep whatever was
    already stored (never persist the literal "********"). Otherwise, strip
    any embedded `user/pass@` credential out of it — real DSNs from this app's
    own consumer (agent_collector_service.py) never have one, but a user can
    paste a full EZConnect string here, and that credential must not sit
    un-stripped in the DSN text redundant with the dedicated encrypted
    username/password columns. Returns (stored_value, extracted_username,
    extracted_password) — the latter two are None when nothing was embedded."""
    if credential_encryption.looks_like_mask(raw_value):
        return existing_value, None, None
    return credential_encryption.extract_embedded_credentials(raw_value)


def list_connections(db: Session, org_id=None):
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "oracle"
    )
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()
    return {"status": "success", "data": [credential_encryption.mask_connection_fields(c) for c in connections]}


def create_connection(request: OracleConnectionCreate, db: Session, org_id=1):
    try:
        tns_val, tns_user, tns_pw = _clean_dsn_field(getattr(request, "tns_descriptor", None), None)
        ocs_val, ocs_user, ocs_pw = _clean_dsn_field(getattr(request, "oracle_connect_string", None), None)
        new_connection = ConnectionMaster(
            db_type="oracle",
            org_id=org_id,
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username or tns_user or ocs_user,
            password=request.password or tns_pw or ocs_pw,
            database_name=request.database_name,
            service_name=getattr(request, "service_name", None),
            sid=getattr(request, "sid", None),
            tns_descriptor=tns_val,
            oracle_connect_string=ocs_val,
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        return {
            "status": "success",
            "message": "Oracle connection created successfully",
            "data": credential_encryption.mask_connection_fields(new_connection),
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
    return {"status": "success", "data": credential_encryption.mask_connection_fields(connection)}


def update_connection(connection_id: int, request: OracleConnectionCreate, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "oracle",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="Oracle connection not found")
    try:
        tns_val, tns_user, tns_pw = _clean_dsn_field(getattr(request, "tns_descriptor", None), connection.tns_descriptor)
        ocs_val, ocs_user, ocs_pw = _clean_dsn_field(getattr(request, "oracle_connect_string", None), connection.oracle_connect_string)

        connection.connection_name = request.connection_name
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username or tns_user or ocs_user or connection.username
        if not credential_encryption.looks_like_mask(request.password):
            connection.password = request.password
        elif tns_pw or ocs_pw:
            connection.password = tns_pw or ocs_pw
        connection.database_name = request.database_name
        connection.service_name = getattr(request, "service_name", None)
        connection.sid = getattr(request, "sid", None)
        connection.tns_descriptor = tns_val
        connection.oracle_connect_string = ocs_val
        db.commit()
        db.refresh(connection)
        return {
            "status": "success",
            "message": "Oracle connection updated successfully",
            "data": credential_encryption.mask_connection_fields(connection),
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
