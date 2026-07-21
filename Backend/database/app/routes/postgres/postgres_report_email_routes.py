"""
PostgreSQL Report Email & Scheduling routes
  POST  /postgres-report/send-email          — send report immediately
  GET   /postgres-report/schedules/{conn_id} — list schedules
  POST  /postgres-report/schedules           — create schedule
  PUT   /postgres-report/schedules/{id}      — update schedule
  DELETE /postgres-report/schedules/{id}     — delete schedule
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.postgres.postgres_report_email_service import (
    SendEmailRequest, ScheduleCreate, ScheduleUpdate,
    svc_send_report_now, svc_list_schedules, svc_create_schedule,
    svc_update_schedule, svc_delete_schedule,
)

router = APIRouter(prefix="/api/v1", tags=["postgres-report-email"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/postgres-report/send-email")
def send_report_now(req: SendEmailRequest, db: Session = Depends(get_db)):
    return svc_send_report_now(req, db)


@router.get("/postgres-report/schedules/{conn_id}")
def list_schedules(conn_id: int, db: Session = Depends(get_db)):
    return svc_list_schedules(conn_id, db)


@router.post("/postgres-report/schedules")
def create_schedule(req: ScheduleCreate, db: Session = Depends(get_db)):
    return svc_create_schedule(req, db)


@router.put("/postgres-report/schedules/{sched_id}")
def update_schedule(sched_id: int, req: ScheduleUpdate, db: Session = Depends(get_db)):
    return svc_update_schedule(sched_id, req, db)


@router.delete("/postgres-report/schedules/{sched_id}")
def delete_schedule(sched_id: int, db: Session = Depends(get_db)):
    return svc_delete_schedule(sched_id, db)
