import json
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.backup_schedule_model import BackupSchedule
from app.services.mysql import mysql_schedule_service

# Re-export for main.py: `from app.routes.mysql.mysql_schedule_routes import start_scheduler`
from app.services.mysql.mysql_schedule_service import start_scheduler  # noqa: F401

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Backup Scheduler"],
)

# Ensure table exists at import time (handles --reload restarts)
try:
    from app.database.connection import engine as _startup_engine
    BackupSchedule.__table__.create(bind=_startup_engine, checkfirst=True)
    print("[BackupScheduler] backup_schedules table ready (startup check).")
except Exception as _tbl_err:
    print(f"[BackupScheduler] startup table check skipped: {_tbl_err}")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Request models ────────────────────────────────────────────────────────────

class ScheduleCreate(BaseModel):
    name:                str
    backup_type:         str           = "logical"
    schedule_type:       str           = "daily"
    interval_minutes:    Optional[int] = 30
    minute:              Optional[int] = 0
    hour:                Optional[int] = 2
    day_of_week:         Optional[str] = "0"
    day_of_month:        Optional[int] = 1
    databases:           Optional[List[str]] = None
    compress:            bool          = True
    custom_storage_path: Optional[str] = None
    retain_days:         Optional[int] = 7
    notes:               Optional[str] = None
    enabled:             bool          = True


class ScheduleUpdate(ScheduleCreate):
    pass


class ScheduleToggle(BaseModel):
    enabled: bool


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/backup/schedules")
def list_schedules(conn_id: int, db: Session = Depends(get_db)):
    return mysql_schedule_service.list_schedules(conn_id, db)


@router.post("/{conn_id}/backup/schedules")
def create_schedule(conn_id: int, req: ScheduleCreate, db: Session = Depends(get_db)):
    return mysql_schedule_service.create_schedule(conn_id, req.dict(), db)


@router.get("/{conn_id}/backup/schedules/{sid}")
def get_schedule(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return mysql_schedule_service.get_schedule(conn_id, sid, db)


@router.put("/{conn_id}/backup/schedules/{sid}")
def update_schedule(conn_id: int, sid: int, req: ScheduleUpdate, db: Session = Depends(get_db)):
    return mysql_schedule_service.update_schedule(conn_id, sid, req.dict(), db)


@router.delete("/{conn_id}/backup/schedules/{sid}")
def delete_schedule(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return mysql_schedule_service.delete_schedule(conn_id, sid, db)


@router.patch("/{conn_id}/backup/schedules/{sid}/toggle")
def toggle_schedule(conn_id: int, sid: int, req: ScheduleToggle, db: Session = Depends(get_db)):
    return mysql_schedule_service.toggle_schedule(conn_id, sid, req.enabled, db)


@router.post("/{conn_id}/backup/schedules/{sid}/run-now")
def run_schedule_now(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return mysql_schedule_service.run_schedule_now(conn_id, sid, db)
