"""
Oracle Storage Health — Phase 3 maintenance approval/execution routes.
Separate from oracle_monitoring_routes.py (read-only) — everything here is
mutating/approval-gated and requires a real authenticated user.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.oracle.oracle_maintenance_service import (
    request_maintenance,
    approve_maintenance,
    reject_maintenance,
    start_maintenance,
    schedule_maintenance,
    list_maintenance_jobs,
    list_maintenance_jobs_all,
    get_maintenance_job,
    request_direct_maintenance,
)
from app.services.oracle.oracle_maintenance_telemetry_service import (
    oracle_maintenance_overview,
    table_maintenance_telemetry,
    index_maintenance_telemetry,
    statistics_maintenance_telemetry,
    partition_maintenance_telemetry,
    space_maintenance_telemetry,
    datafile_resize_info,
    tablespace_space_analysis,
)

router = APIRouter(prefix="/api/v1", tags=["Oracle Maintenance"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class MaintenanceRequestBody(BaseModel):
    object_type: str
    object_name: str


class MaintenanceRejectBody(BaseModel):
    reason: Optional[str] = None


class MaintenanceStartBody(BaseModel):
    recipients: Optional[List[str]] = None


class MaintenanceScheduleBody(BaseModel):
    scheduled_at: datetime  # UTC — the frontend sends an ISO string with offset/Z
    recipients: Optional[List[str]] = None


class DirectMaintenanceRequestBody(BaseModel):
    object_type: str
    object_name: str
    action: str
    params: Optional[Dict[str, Any]] = None
    recipients: Optional[List[str]] = None


@router.post("/connections/oracle/{conn_id}/oracle-storage-maintenance/request")
def route_request_maintenance(
    conn_id: int, body: MaintenanceRequestBody,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return request_maintenance(conn_id, db, body.object_type, body.object_name, claims)


@router.get("/connections/oracle/{conn_id}/oracle-storage-maintenance/jobs")
def route_list_maintenance_jobs(
    conn_id: int, status: Optional[str] = None, db: Session = Depends(get_db),
):
    return list_maintenance_jobs(db, conn_id=conn_id, status=status)


# Cross-connection feed — the Maintenance Window page. Declared before the
# /{job_id} route below only for readability; FastAPI matches these on path
# shape (no trailing segment vs. one), so there's no literal collision either way.
@router.get("/oracle-maintenance/jobs")
def route_list_maintenance_jobs_all(status: Optional[str] = None, db: Session = Depends(get_db)):
    return list_maintenance_jobs_all(db, status=status)


@router.get("/oracle-maintenance/jobs/{job_id}")
def route_get_maintenance_job(job_id: int, db: Session = Depends(get_db)):
    return get_maintenance_job(job_id, db)


@router.post("/oracle-maintenance/jobs/{job_id}/approve")
def route_approve_maintenance(
    job_id: int, claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return approve_maintenance(job_id, db, claims)


@router.post("/oracle-maintenance/jobs/{job_id}/start")
def route_start_maintenance(
    job_id: int, body: Optional[MaintenanceStartBody] = None,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return start_maintenance(job_id, db, claims, recipients=body.recipients if body else None)


@router.post("/oracle-maintenance/jobs/{job_id}/schedule")
def route_schedule_maintenance(
    job_id: int, body: MaintenanceScheduleBody,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return schedule_maintenance(job_id, db, claims, body.scheduled_at, recipients=body.recipients)


@router.post("/oracle-maintenance/jobs/{job_id}/reject")
def route_reject_maintenance(
    job_id: int, body: MaintenanceRejectBody,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    return reject_maintenance(job_id, db, claims, body.reason)


# ═══════════════════════════════════════════════════════════════════════
#  Maintenance module — real-time telemetry (Table/Index/Statistics/
#  Partition/Space) and direct (non-finding) operation requests.
# ═══════════════════════════════════════════════════════════════════════

@router.get("/connections/oracle/{conn_id}/oracle-maintenance-overview")
def route_oracle_maintenance_overview(conn_id: int, db: Session = Depends(get_db)):
    return oracle_maintenance_overview(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/table-telemetry")
def route_table_maintenance_telemetry(conn_id: int, db: Session = Depends(get_db)):
    return table_maintenance_telemetry(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/index-telemetry")
def route_index_maintenance_telemetry(conn_id: int, db: Session = Depends(get_db)):
    return index_maintenance_telemetry(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/statistics-telemetry")
def route_statistics_maintenance_telemetry(conn_id: int, db: Session = Depends(get_db)):
    return statistics_maintenance_telemetry(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/partition-telemetry")
def route_partition_maintenance_telemetry(conn_id: int, db: Session = Depends(get_db)):
    return partition_maintenance_telemetry(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/space-telemetry")
def route_space_maintenance_telemetry(conn_id: int, db: Session = Depends(get_db)):
    return space_maintenance_telemetry(conn_id, db)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/datafile-resize-info")
def route_datafile_resize_info(conn_id: int, file_name: str, db: Session = Depends(get_db)):
    return datafile_resize_info(conn_id, db, file_name)


@router.get("/connections/oracle/{conn_id}/oracle-maintenance/tablespace-analysis")
def route_tablespace_space_analysis(conn_id: int, tablespace_name: str, db: Session = Depends(get_db)):
    return tablespace_space_analysis(conn_id, db, tablespace_name)


@router.post("/connections/oracle/{conn_id}/oracle-maintenance/request-direct")
def route_request_direct_maintenance(
    conn_id: int, body: DirectMaintenanceRequestBody,
    claims: dict = Depends(current_claims), db: Session = Depends(get_db),
):
    """One call for the Maintenance module's operation buttons: validates
    against live Oracle, creates the job (already 'approved' — the
    confirmation dialog the user just clicked through IS the approval step
    for a directly-chosen operation), and immediately starts it so the
    frontend can go straight to watching live job status, the same page
    JobDetailPage already provides for the Storage Health flow."""
    job = request_direct_maintenance(
        conn_id, db, body.object_type, body.object_name, body.action, claims, params=body.params,
    )
    started = start_maintenance(job["id"], db, claims, recipients=body.recipients)
    started["warnings"] = job.get("warnings", [])
    return started
