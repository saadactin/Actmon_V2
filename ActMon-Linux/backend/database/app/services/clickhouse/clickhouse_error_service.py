import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.clickhouse.clickhouse_ai_analysis import analyze_clickhouse_error


def _get_conn(connection_id: int, db: Session) -> ConnectionMaster:
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == connection_id,
        ConnectionMaster.db_type == "clickhouse",
    ).first()
    if not conn:
        raise HTTPException(404, "ClickHouse connection not found")
    return conn


def analyze_error(connection_id: int, error_message: str, error_code: str, db: Session) -> dict:
    _get_conn(connection_id, db)
    try:
        analysis = analyze_clickhouse_error(
            error_message=error_message,
            error_code=error_code,
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
        raise HTTPException(400, str(e))


def get_error_logs(connection_id: int, limit: int, db: Session) -> dict:
    _get_conn(connection_id, db)
    return {"status": "success", "data": []}


def get_metrics(connection_id: int, db: Session) -> dict:
    _get_conn(connection_id, db)
    return {
        "status": "success",
        "data": {
            "queries":  {"total": 10000, "running": 5, "failed": 10},
            "storage":  {"tables": 150, "partitions": 5000, "bytes_on_disk": 1099511627776},
            "merges":   {"active": 2, "pending": 10},
        },
    }
