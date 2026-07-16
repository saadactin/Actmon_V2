"""
SQL Server Report Email & Scheduling routes
  POST   /mssql-report/send-email          — send report immediately
  GET    /mssql-report/schedules/{conn_id} — list schedules
  POST   /mssql-report/schedules           — create schedule
  PUT    /mssql-report/schedules/{id}      — update schedule
  DELETE /mssql-report/schedules/{id}      — delete schedule
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mssql.mssql_report_email_service import (
    SendEmailRequest, ScheduleCreate, ScheduleUpdate,
    svc_send_report_now, svc_list_schedules, svc_create_schedule,
    svc_update_schedule, svc_delete_schedule,
)

router = APIRouter(prefix="/api/v1", tags=["mssql-report-email"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/mssql-report/send-email")
def send_report_now(req: SendEmailRequest, db: Session = Depends(get_db)):
    return svc_send_report_now(req, db)


@router.get("/mssql-report/schedules/{conn_id}")
def list_schedules(conn_id: int, db: Session = Depends(get_db)):
    return svc_list_schedules(conn_id, db)


@router.post("/mssql-report/schedules")
def create_schedule(req: ScheduleCreate, db: Session = Depends(get_db)):
    return svc_create_schedule(req, db)


@router.put("/mssql-report/schedules/{sched_id}")
def update_schedule(sched_id: int, req: ScheduleUpdate, db: Session = Depends(get_db)):
    return svc_update_schedule(sched_id, req, db)


@router.delete("/mssql-report/schedules/{sched_id}")
def delete_schedule(sched_id: int, db: Session = Depends(get_db)):
    return svc_delete_schedule(sched_id, db)
