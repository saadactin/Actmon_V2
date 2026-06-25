"""
Generic resource drill-down routes for every engine.
  /api/v1/drilldown/{tech}/{conn_id}/host-metrics | processes | process/{pid}/sessions
                                     | session/{pid}/detail | rca | history | history/{id} | history/{id}/rca
tech ∈ mysql | postgresql | oracle | mssql | clickhouse | mongodb
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services import drilldown_service as svc

router = APIRouter(prefix="/api/v1/drilldown", tags=["Resource Drill-Down"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{tech}/{conn_id}/host-metrics")
def host_metrics(tech: str, conn_id: int, db: Session = Depends(get_db)):
    return svc.host_metrics(tech, conn_id, db)


@router.get("/{tech}/{conn_id}/processes")
def processes(tech: str, conn_id: int, sort: str = "cpu", limit: int = 25, db: Session = Depends(get_db)):
    return svc.processes(tech, conn_id, db, sort=sort, limit=limit)


@router.get("/{tech}/{conn_id}/process/{pid}/sessions")
def process_sessions(tech: str, conn_id: int, pid: int, db: Session = Depends(get_db)):
    return svc.process_sessions(tech, conn_id, pid, db)


@router.get("/{tech}/{conn_id}/session/{pid}/detail")
def session_detail(tech: str, conn_id: int, pid: str, db: Session = Depends(get_db)):
    return svc.session_detail(tech, conn_id, pid, db)


@router.get("/{tech}/{conn_id}/rca")
def rca(tech: str, conn_id: int, resource: str = "cpu", pid: int | None = None, cmd: str | None = None, db: Session = Depends(get_db)):
    return svc.rca(tech, conn_id, db, pid=pid, resource=resource, target_cmd=cmd)


@router.get("/{tech}/{conn_id}/history")
def history(tech: str, conn_id: int, hours: int = 6, db: Session = Depends(get_db)):
    return svc.history(tech, conn_id, db, hours=hours)


@router.get("/{tech}/{conn_id}/history/{sample_id}")
def history_detail(tech: str, conn_id: int, sample_id: int, db: Session = Depends(get_db)):
    return svc.history_detail(tech, conn_id, sample_id, db)


@router.get("/{tech}/{conn_id}/history/{sample_id}/rca")
def history_rca(tech: str, conn_id: int, sample_id: int, resource: str = "cpu", db: Session = Depends(get_db)):
    return svc.history_rca(tech, conn_id, sample_id, db, resource=resource)


# Windows OS process visibility (SQL Server hosts) — opt-in, uses xp_cmdshell.
@router.get("/mssql/{conn_id}/os-processes")
def mssql_os_processes(conn_id: int, db: Session = Depends(get_db)):
    return svc.mssql_os_processes(conn_id, db)


@router.post("/mssql/{conn_id}/enable-os-visibility")
def mssql_enable_os_visibility(conn_id: int, db: Session = Depends(get_db)):
    return svc.mssql_enable_os_visibility(conn_id, db)


@router.get("/mssql/{conn_id}/table-detail")
def mssql_table_detail(conn_id: int, db_name: str, schema: str, table: str, db: Session = Depends(get_db)):
    return svc.mssql_table_detail(conn_id, db, db_name, schema, table)
