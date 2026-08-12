import datetime
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.services.mongo.mongodb_ai_analysis import analyze_mongodb_error

_SEV_MAP = {"F": "FATAL", "E": "ERROR", "W": "WARNING", "I": "INFO", "D": "INFO"}


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
    conn = _get_conn_or_404(connection_id, db)
    n = int(limit) if limit else 20
    try:
        from app.services.mongo.mongo_monitoring_service import _mongo_client

        mc = _mongo_client(conn)
        # MongoDB's own ring buffer of its recent log lines — no file/SSH access
        # needed, and it's what `mongod --logpath` would have written. Requires
        # clusterMonitor (or broader) on the connecting user.
        raw = mc.admin.command("getLog", "global")
        lines = raw.get("log") or []
        entries = []
        for line in lines:
            try:
                rec = json.loads(line)
            except (TypeError, ValueError):
                continue
            sev = _SEV_MAP.get(rec.get("s"), "INFO")
            if sev not in ("FATAL", "ERROR", "WARNING"):
                continue
            msg = rec.get("msg") or ""
            attr = rec.get("attr")
            if attr:
                msg = f"{msg} {attr}" if msg else str(attr)
            entries.append({
                "timestamp": (rec.get("t") or {}).get("$date"),
                "severity": sev,
                "message": msg,
            })
        entries.reverse()  # getLog returns oldest-first; most recent matters most
        return {"status": "success", "data": entries[:n], "source": "mongodb getLog"}
    except Exception as e:
        return {"status": "success", "data": [], "note": f"Could not read MongoDB log: {e}"}


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
