from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError
from urllib.parse import quote_plus
import datetime

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.mssql_ai_analysis import analyze_mssql_error

router = APIRouter(
    prefix="/api/v1/mssql",
    tags=["MSSQL Error Analysis"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ANALYZE MSSQL ERROR
@router.post("/{connection_id}/analyze-error")
def analyze_mssql_error_endpoint(
    connection_id: int,
    error_data: dict,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        connection_string = f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database}?driver=ODBC+Driver+17+for+SQL+Server"
        engine = create_engine(connection_string, echo=False)
        
        analysis = analyze_mssql_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=engine
        )
        
        return {
            "status": "success",
            "data": {
                "analysis": analysis,
                "timestamp": datetime.datetime.now().isoformat()
            }
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET MSSQL ERROR LOGS
@router.get("/{connection_id}/error-logs")
def get_mssql_error_logs(
    connection_id: int,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        connection_string = f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database}?driver=ODBC+Driver+17+for+SQL+Server"
        engine = create_engine(connection_string, echo=False)
        
        with engine.connect() as conn:
            query = text(f"""
                SELECT TOP {limit}
                    error_number,
                    severity,
                    message,
                    log_date
                FROM sys.dm_exec_query_stats
                ORDER BY log_date DESC
            """)
            result = conn.execute(query)
            logs = [dict(row) for row in result.fetchall()]
        
        return {
            "status": "success",
            "data": logs
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET MSSQL PERFORMANCE METRICS
@router.get("/{connection_id}/metrics")
def get_mssql_metrics(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mssql"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MSSQL connection not found")
    
    try:
        connection_string = f"mssql+pyodbc://{connection.username}:{quote_plus(connection.password)}@{connection.host}:{connection.port}/{connection.database}?driver=ODBC+Driver+17+for+SQL+Server"
        engine = create_engine(connection_string, echo=False)
        
        with engine.connect() as conn:
            # Get CPU time
            cpu_result = conn.execute(text("""
                SELECT SUM(total_worker_time) / 1000000 as cpu_seconds
                FROM sys.dm_exec_query_stats
            """))
            cpu_data = cpu_result.fetchone()
            
            # Get memory usage
            memory_result = conn.execute(text("""
                SELECT SUM(total_physical_reads) as physical_reads,
                       SUM(total_logical_reads) as logical_reads
                FROM sys.dm_exec_query_stats
            """))
            memory_data = memory_result.fetchone()
        
        return {
            "status": "success",
            "data": {
                "cpu_seconds": cpu_data[0] or 0,
                "physical_reads": memory_data[0] or 0,
                "logical_reads": memory_data[1] or 0
            }
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
