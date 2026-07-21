from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional

from app.database.connection import SessionLocal
from app.services.mssql.mssql_backup_service import (
    TakeBackupRequest, PITRRequest,
    ScheduleCreate, ScheduleUpdate, ScheduleToggle,
    get_backup_summary, get_backup_history, get_recovery_chain,
    list_schedules, create_schedule, update_schedule, delete_schedule,
    toggle_schedule, run_schedule_now,
    list_backups, take_backup, get_backup_job, delete_backup_job, start_pitr,
)

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL Backup & PITR"],
)

try:
    from app.database.connection import engine as _startup_engine
    from app.models.backup_model import BackupJob
    from app.models.backup_schedule_model import BackupSchedule
    BackupSchedule.__table__.create(bind=_startup_engine, checkfirst=True)
    BackupJob.__table__.create(bind=_startup_engine, checkfirst=True)
except Exception:
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/backup/summary")
def get_backup_summary_route(conn_id: int, db: Session = Depends(get_db)):
    return get_backup_summary(conn_id, db)


@router.get("/{conn_id}/backup/history")
def get_backup_history_route(
    conn_id: int,
    db_name: Optional[str] = Query(None),
    backup_type: Optional[str] = Query(None),
    days: int = Query(30),
    limit: int = Query(100),
    db: Session = Depends(get_db),
):
    return get_backup_history(conn_id, db_name, backup_type, days, limit, db)


@router.get("/{conn_id}/backup/recovery-chain")
def get_recovery_chain_route(conn_id: int, db_name: Optional[str] = Query(None), db: Session = Depends(get_db)):
    return get_recovery_chain(conn_id, db_name, db)


@router.get("/{conn_id}/backup/schedules")
def list_schedules_route(conn_id: int, db: Session = Depends(get_db)):
    return list_schedules(conn_id, db)


@router.post("/{conn_id}/backup/schedules", status_code=201)
def create_schedule_route(conn_id: int, body: ScheduleCreate, db: Session = Depends(get_db)):
    return create_schedule(conn_id, body, db)


@router.put("/{conn_id}/backup/schedules/{sid}")
def update_schedule_route(conn_id: int, sid: int, body: ScheduleUpdate, db: Session = Depends(get_db)):
    return update_schedule(conn_id, sid, body, db)


@router.delete("/{conn_id}/backup/schedules/{sid}")
def delete_schedule_route(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return delete_schedule(conn_id, sid, db)


@router.patch("/{conn_id}/backup/schedules/{sid}/toggle")
def toggle_schedule_route(conn_id: int, sid: int, body: ScheduleToggle, db: Session = Depends(get_db)):
    return toggle_schedule(conn_id, sid, body.enabled, db)


@router.post("/{conn_id}/backup/schedules/{sid}/run-now")
def run_schedule_now_route(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return run_schedule_now(conn_id, sid, db)


@router.get("/{conn_id}/backups")
def list_backups_route(
    conn_id: int,
    status: Optional[str] = Query(None),
    limit: int = Query(50),
    db: Session = Depends(get_db),
):
    return list_backups(conn_id, status, limit, db)


@router.post("/{conn_id}/backup/take", status_code=202)
def take_backup_route(conn_id: int, body: TakeBackupRequest, db: Session = Depends(get_db)):
    return take_backup(conn_id, body, db)


@router.get("/{conn_id}/backup/{job_id}")
def get_backup_job_route(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return get_backup_job(conn_id, job_id, db)


@router.delete("/{conn_id}/backup/{job_id}")
def delete_backup_job_route(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return delete_backup_job(conn_id, job_id, db)


@router.post("/{conn_id}/pitr", status_code=202)
def start_pitr_route(conn_id: int, body: PITRRequest, db: Session = Depends(get_db)):
    return start_pitr(conn_id, body, db)
