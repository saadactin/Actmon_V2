"""
PostgreSQL Resource Drill-Down routes (SolarWinds-style), on-demand.

  GET /api/v1/connections/postgresql/{conn_id}/host-metrics
  GET /api/v1/connections/postgresql/{conn_id}/processes?sort=cpu|mem
  GET /api/v1/connections/postgresql/{conn_id}/process/{pid}/sessions
  GET /api/v1/connections/postgresql/{conn_id}/session/{pid}/detail
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.postgres import postgres_drilldown_service as svc

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL Drill-Down"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/host-metrics")
def host_metrics(conn_id: int, db: Session = Depends(get_db)):
    return svc.host_metrics(conn_id, db)


@router.get("/{conn_id}/processes")
def processes(conn_id: int, sort: str = "cpu", limit: int = 25, db: Session = Depends(get_db)):
    return svc.processes(conn_id, db, sort=sort, limit=limit)


@router.get("/{conn_id}/process/{pid}/sessions")
def process_sessions(conn_id: int, pid: int, db: Session = Depends(get_db)):
    return svc.process_sessions(conn_id, pid, db)


@router.get("/{conn_id}/session/{pid}/detail")
def session_detail(conn_id: int, pid: int, db: Session = Depends(get_db)):
    return svc.session_detail(conn_id, pid, db)


@router.get("/{conn_id}/rca")
def rca(conn_id: int, resource: str = "cpu", pid: int | None = None, cmd: str | None = None, db: Session = Depends(get_db)):
    return svc.rca(conn_id, db, pid=pid, resource=resource, target_cmd=cmd)


@router.post("/{conn_id}/grant-monitor")
def grant_monitor(conn_id: int, db: Session = Depends(get_db)):
    return svc.grant_monitor(conn_id, db)


@router.get("/{conn_id}/history")
def history(conn_id: int, hours: int = 6, db: Session = Depends(get_db)):
    return svc.history(conn_id, db, hours=hours)


@router.get("/{conn_id}/history/{sample_id}")
def history_detail(conn_id: int, sample_id: int, db: Session = Depends(get_db)):
    return svc.history_detail(conn_id, sample_id, db)


@router.get("/{conn_id}/history/{sample_id}/rca")
def history_rca(conn_id: int, sample_id: int, resource: str = "cpu", db: Session = Depends(get_db)):
    return svc.history_rca(conn_id, sample_id, db, resource=resource)
