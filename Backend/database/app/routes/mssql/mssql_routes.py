from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.connection_schema import MSSQLConnectionCreate
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# GET ALL MSSQL CONNECTIONS
@router.get("/")
def list_mssql_connections(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    query = db.query(ConnectionMaster).filter(
        ConnectionMaster.db_type == "mssql"
    )
    org_id = scope_org_id(ctx)
    if org_id is not None:
        query = query.filter(ConnectionMaster.org_id == org_id)
    connections = query.all()

    return {
        "status": "success",
        "data": connections
    }

# CREATE MSSQL CONNECTION
@router.post("/")
def create_mssql_connection(
    request: MSSQLConnectionCreate,
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx)
):
    try:
        # Test connection
        db_part = (request.database_name or "master").strip()
        connection_string = (
            f"mssql+pyodbc://{request.username}:{quote_plus(request.password)}"
            f"@{request.host}:{request.port}/{db_part}"
            f"?driver=ODBC+Driver+17+for+SQL+Server&TrustServerCertificate=yes"
        )
        engine = create_engine(connection_string, echo=False)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))

        # Save connection
        new_connection = ConnectionMaster(
            db_type="mssql",
            org_id=create_org_id(ctx),
            connection_name=request.connection_name,
            host=request.host,
            port=request.port,
            username=request.username,
            password=request.password,
            database_name=request.database_name,
            windows_authentication=request.windows_authentication,
            instance_name=request.instance_name,
        )
        db.add(new_connection)
        db.commit()
        db.refresh(new_connection)
        
        return {
            "status": "success",
            "message": "MSSQL connection created successfully",
            "data": new_connection
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# GET MSSQL CONNECTION DETAILS
@router.get("/{connection_id}")
def get_mssql_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    return {
        "status": "success",
        "data": connection
    }

# UPDATE MSSQL CONNECTION
@router.put("/{connection_id}")
def update_mssql_connection(
    connection_id: int,
    request: MSSQLConnectionCreate,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        connection.connection_name = request.connection_name
        connection.host = request.host
        connection.port = request.port
        connection.username = request.username
        connection.password = request.password
        connection.database_name = request.database_name
        connection.windows_authentication = request.windows_authentication
        connection.instance_name = request.instance_name
        
        db.commit()
        db.refresh(connection)
        
        return {
            "status": "success",
            "message": "MSSQL connection updated successfully",
            "data": connection
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# DELETE MSSQL CONNECTION
@router.delete("/{connection_id}")
def delete_mssql_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        db.delete(connection)
        db.commit()
        
        return {
            "status": "success",
            "message": "MSSQL connection deleted successfully"
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))

# TEST MSSQL CONNECTION
@router.post("/{connection_id}/test")
def test_mssql_connection(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        db_part = (connection.database_name or "master").strip()
        connection_string = (
            f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}"
            f"@{connection.host}:{connection.port}/{db_part}"
            f"?driver=ODBC+Driver+17+for+SQL+Server&TrustServerCertificate=yes"
        )
        engine = create_engine(connection_string, echo=False)
        with engine.connect() as conn:
            result = conn.execute(text("SELECT @@version as version"))
            version = result.fetchone()[0]
        
        return {
            "status": "success",
            "message": "MSSQL connection test successful",
            "version": version
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
