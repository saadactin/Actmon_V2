"""
Oracle Storage Health — Phase 3 maintenance approval/execution routes.
Separate from oracle_monitoring_routes.py (read-only) — everything here is
mutating/approval-gated and requires a real authenticated user.
"""

from datetime import datetime
from typing import List, Optional

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
