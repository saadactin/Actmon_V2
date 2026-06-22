"""
MySQL Report Email & Scheduling routes
  POST  /mysql-report/send-email          — send report immediately
  GET   /mysql-report/schedules/{conn_id} — list schedules
  POST  /mysql-report/schedules           — create schedule
  PUT   /mysql-report/schedules/{id}      — update schedule
  DELETE /mysql-report/schedules/{id}     — delete schedule
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql.mysql_report_email_service import (
    SendEmailRequest, ScheduleCreate, ScheduleUpdate,
    svc_send_report_now, svc_list_schedules, svc_create_schedule,
    svc_update_schedule, svc_delete_schedule,
)

router = APIRouter(prefix="/api/v1", tags=["mysql-report-email"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/mysql-report/send-email")
def send_report_now(req: SendEmailRequest, db: Session = Depends(get_db)):
    return svc_send_report_now(req, db)


@router.get("/mysql-report/schedules/{conn_id}")
def list_schedules(conn_id: int, db: Session = Depends(get_db)):
    return svc_list_schedules(conn_id, db)


@router.post("/mysql-report/schedules")
def create_schedule(req: ScheduleCreate, db: Session = Depends(get_db)):
    return svc_create_schedule(req, db)


@router.put("/mysql-report/schedules/{sched_id}")
def update_schedule(sched_id: int, req: ScheduleUpdate, db: Session = Depends(get_db)):
    return svc_update_schedule(sched_id, req, db)


@router.delete("/mysql-report/schedules/{sched_id}")
def delete_schedule(sched_id: int, db: Session = Depends(get_db)):
    return svc_delete_schedule(sched_id, db)
