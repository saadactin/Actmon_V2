"""ActMon Logs API — /api/v1/logs/*  (ClickHouse-backed metric time-series)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.logs import actmon_logs_service as logs

router = APIRouter(prefix="/api/v1/logs", tags=["Logs"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/status", summary="Log store connectivity")
def log_status():
    return logs.status()


@router.get("/catalog", summary="Available db_types, metrics & sources")
def log_catalog():
    return logs.catalog()


@router.get("/metrics", summary="Fetch a metric time-series")
def log_metrics(
    db_type: str = Query(...),
    metric: str = Query(...),
    connection_id: int | None = Query(None),
    hours: int = Query(6, ge=1, le=720),
):
    return {"db_type": db_type, "metric": metric, "connection_id": connection_id,
            "hours": hours, "points": logs.query_series(db_type, metric, connection_id, hours)}


@router.get("/snapshot", summary="Latest value of every metric per source (live table)")
def log_snapshot(db_type: str | None = Query(None)):
    return {"rows": logs.snapshot(db_type)}


@router.get("/history", summary="Per-source metric history (readable table)")
def log_history(db_type: str = Query(...), connection_id: int = Query(...), hours: int = Query(1, ge=1, le=168)):
    return {"rows": logs.history(db_type, connection_id, hours)}


@router.get("/spikes", summary="Highest-value moments of a metric ('when did it spike')")
def log_spikes(db_type: str = Query(...), metric: str = Query(...),
               connection_id: int | None = Query(None), hours: int = Query(24, ge=1, le=720)):
    return {"spikes": logs.spikes(db_type, metric, connection_id, hours)}


@router.get("/sql", summary="Top / slow SQL captured across time")
def log_sql(connection_id: int | None = Query(None), hours: int = Query(24, ge=1, le=720),
            limit: int = Query(300, ge=1, le=2000), db: Session = Depends(get_db)):
    return {"rows": logs.sql_logs(db, connection_id, hours, limit)}


@router.get("/errors", summary="Error / alert event log")
def log_errors(connection_id: int | None = Query(None), hours: int = Query(72, ge=1, le=720),
               severity: str | None = Query(None), limit: int = Query(400, ge=1, le=2000),
               db: Session = Depends(get_db)):
    return {"rows": logs.error_logs(db, connection_id, hours, severity, limit)}


@router.post("/flush", summary="Force-sample all agents into the log store now")
def log_flush(db: Session = Depends(get_db)):
    return {"written": logs.log_now(db)}
