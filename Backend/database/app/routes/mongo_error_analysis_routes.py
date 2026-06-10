from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
import datetime
from urllib.parse import quote_plus

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.mongodb_ai_analysis import analyze_mongodb_error

router = APIRouter(
    prefix="/api/v1/mongodb",
    tags=["MongoDB Error Analysis"]
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ANALYZE MONGODB ERROR
@router.post("/{connection_id}/analyze-error")
def analyze_mongodb_error_endpoint(
    connection_id: int,
    error_data: dict,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    
    try:
        analysis = analyze_mongodb_error(
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

# GET MONGODB ERROR LOGS
@router.get("/{connection_id}/error-logs")
def get_mongodb_error_logs(
    connection_id: int,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    
    try:
        # MongoDB would require pymongo client
        # For now, return empty logs
        logs = []
        
        return {
            "status": "success",
            "data": logs
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# GET MONGODB PERFORMANCE METRICS
@router.get("/{connection_id}/metrics")
def get_mongodb_metrics(connection_id: int, db: Session = Depends(get_db)):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb"
    ).first()
    
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    
    try:
        # MongoDB would require pymongo client
        # For now, return mock metrics
        metrics = {
            "operations": {
                "insert": 1000,
                "find": 5000,
                "update": 2000,
                "delete": 500
            },
            "connections": {
                "current": 50,
                "available": 100
            },
            "memory": {
                "resident": 512,
                "virtual": 1024
            }
        }
        
        return {
            "status": "success",
            "data": metrics
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
