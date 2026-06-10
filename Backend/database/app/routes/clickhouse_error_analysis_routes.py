from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import datetime
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.clickhouse_ai_analysis import analyze_clickhouse_error

router = APIRouter(
    prefix="/api/v1/clickhouse",
    tags=["ClickHouse Error Analysis"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ANALYZE CLICKHOUSE ERROR
@router.post("/{connection_id}/analyze-error")
def analyze_clickhouse_error_endpoint(
    connection_id: int,
    error_data: dict,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    
    try:
        analysis = analyze_clickhouse_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=None
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

# GET CLICKHOUSE ERROR LOGS
@router.get("/{connection_id}/error-logs")
def get_clickhouse_error_logs(
    connection_id: int,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    
    try:
        # ClickHouse would require clickhouse-driver
        # For now, return empty logs
        logs = []
        
        return {
            "status": "success",
            "data": logs
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET CLICKHOUSE PERFORMANCE METRICS
@router.get("/{connection_id}/metrics")
def get_clickhouse_metrics(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="ClickHouse connection not found")
    
    try:
        # ClickHouse would require clickhouse-driver
        # For now, return mock metrics
        metrics = {
            "queries": {
                "total": 10000,
                "running": 5,
                "failed": 10
            },
            "storage": {
                "tables": 150,
                "partitions": 5000,
                "bytes_on_disk": 1099511627776  # 1TB in bytes
            },
            "merges": {
                "active": 2,
                "pending": 10
            }
        }
        
        return {
            "status": "success",
            "data": metrics
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
