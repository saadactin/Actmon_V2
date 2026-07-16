"""
PostgreSQL Backup & PITR routes — thin handlers only.
All business logic lives in app/services/postgres/postgres_backup_service.py
"""

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.postgres.postgres_backup_service import (
    TakeBackupRequest,
    RestoreRequest,
    PITRRequest,
    ScheduleCreate,
    ScheduleUpdate,
    ScheduleToggle,
    svc_backup_summary,
    svc_list_schedules,
    svc_create_schedule,
    svc_get_schedule,
    svc_update_schedule,
    svc_delete_schedule,
    svc_toggle_schedule,
    svc_run_schedule_now,
    svc_list_backups,
    svc_take_backup,
    svc_get_backup,
    svc_delete_backup,
    svc_restore,
    svc_pitr,
    svc_pitr_preview,
    svc_wal_status,
    svc_wal_segments,
)

router = APIRouter(prefix="/api/v1/connections/postgresql", tags=["PostgreSQL Backup"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/{conn_id}/backup/summary")
def route_backup_summary(conn_id: int, db: Session = Depends(get_db)):
    return svc_backup_summary(conn_id, db)


@router.get("/{conn_id}/backup/schedules")
def route_list_schedules(conn_id: int, db: Session = Depends(get_db)):
    return svc_list_schedules(conn_id, db)


@router.post("/{conn_id}/backup/schedules")
def route_create_schedule(conn_id: int, req: ScheduleCreate, db: Session = Depends(get_db)):
    return svc_create_schedule(conn_id, req, db)


@router.get("/{conn_id}/backup/schedules/{sid}")
def route_get_schedule(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return svc_get_schedule(conn_id, sid, db)


@router.put("/{conn_id}/backup/schedules/{sid}")
def route_update_schedule(conn_id: int, sid: int, req: ScheduleUpdate, db: Session = Depends(get_db)):
    return svc_update_schedule(conn_id, sid, req, db)


@router.delete("/{conn_id}/backup/schedules/{sid}")
def route_delete_schedule(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return svc_delete_schedule(conn_id, sid, db)


@router.patch("/{conn_id}/backup/schedules/{sid}/toggle")
def route_toggle_schedule(conn_id: int, sid: int, req: ScheduleToggle, db: Session = Depends(get_db)):
    return svc_toggle_schedule(conn_id, sid, req, db)


@router.post("/{conn_id}/backup/schedules/{sid}/run-now")
def route_run_schedule_now(conn_id: int, sid: int, db: Session = Depends(get_db)):
    return svc_run_schedule_now(conn_id, sid, db)


@router.get("/{conn_id}/backups")
def route_list_backups(conn_id: int, db: Session = Depends(get_db)):
    return svc_list_backups(conn_id, db)


@router.post("/{conn_id}/backup/take")
def route_take_backup(
    conn_id: int,
    req: TakeBackupRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return svc_take_backup(conn_id, req, background_tasks, db)


@router.get("/{conn_id}/backup/{job_id}")
def route_get_backup(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return svc_get_backup(conn_id, job_id, db)


@router.delete("/{conn_id}/backup/{job_id}")
def route_delete_backup(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return svc_delete_backup(conn_id, job_id, db)


@router.post("/{conn_id}/restore")
def route_restore(
    conn_id: int,
    req: RestoreRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return svc_restore(conn_id, req, background_tasks, db)


@router.post("/{conn_id}/pitr")
def route_pitr(
    conn_id: int,
    req: PITRRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    return svc_pitr(conn_id, req, background_tasks, db)


@router.get("/{conn_id}/pitr/preview")
def route_pitr_preview(conn_id: int, db: Session = Depends(get_db)):
    return svc_pitr_preview(conn_id, db)


@router.get("/{conn_id}/wal/status")
def route_wal_status(conn_id: int, db: Session = Depends(get_db)):
    return svc_wal_status(conn_id, db)


@router.get("/{conn_id}/wal/segments")
def route_wal_segments(conn_id: int, db: Session = Depends(get_db)):
    return svc_wal_segments(conn_id, db)
