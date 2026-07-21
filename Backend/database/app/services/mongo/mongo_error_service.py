import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.mongo.mongodb_ai_analysis import analyze_mongodb_error


def _get_conn_or_404(connection_id: int, db: Session):
    connection = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "mongodb",
    ).first()
    if not connection:
        raise HTTPException(status_code=404, detail="MongoDB connection not found")
    return connection


def analyze_error(connection_id: int, error_data: dict, db: Session):
    _get_conn_or_404(connection_id, db)
    try:
        analysis = analyze_mongodb_error(
            error_message=error_data.get("error_message", ""),
            error_code=error_data.get("error_code", ""),
            engine=None,
        )
        return {
            "status": "success",
            "data": {
                "analysis": analysis,
                "timestamp": datetime.datetime.now().isoformat(),
            },
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def get_error_logs(connection_id: int, limit: int, db: Session):
    _get_conn_or_404(connection_id, db)
    try:
        return {"status": "success", "data": []}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def get_metrics(connection_id: int, db: Session):
    _get_conn_or_404(connection_id, db)
    try:
        metrics = {
            "operations": {"insert": 1000, "find": 5000, "update": 2000, "delete": 500},
            "connections": {"current": 50, "available": 100},
            "memory": {"resident": 512, "virtual": 1024},
        }
        return {"status": "success", "data": metrics}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
