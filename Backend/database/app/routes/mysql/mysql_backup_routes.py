from typing import Optional, List

from fastapi import APIRouter, Depends, BackgroundTasks, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.mysql import mysql_backup_service

router = APIRouter(
    prefix="/api/v1/connections/mysql",
    tags=["MySQL Backup & Restore"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Request models ────────────────────────────────────────────────────────────

class TakeBackupRequest(BaseModel):
    backup_type:         str                  = "logical"
    databases:           Optional[List[str]]  = None
    compress:            bool                 = True
    notes:               Optional[str]        = None
    custom_storage_path: Optional[str]        = None


class RestoreRequest(BaseModel):
    job_id:    int
    target_db: Optional[str] = None
    confirm:   bool          = False


class PITRRequest(BaseModel):
    base_job_id:      int
    target_datetime:  str
    target_db:        Optional[str] = None
    confirm:          bool          = False


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{conn_id}/backup/summary")
def backup_summary(conn_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.get_backup_summary(conn_id, db)


@router.get("/{conn_id}/backups")
def list_backups(conn_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.list_backups(conn_id, db)


@router.get("/{conn_id}/backup/{job_id}")
def get_backup(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.get_backup(conn_id, job_id, db)


@router.post("/{conn_id}/backup/take")
def take_backup(
    conn_id: int,
    req: TakeBackupRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    cpath = req.custom_storage_path.strip() if req.custom_storage_path and req.custom_storage_path.strip() else None
    job   = mysql_backup_service.create_backup_job(
        conn_id, req.backup_type, req.databases, req.compress, req.notes, cpath, db
    )
    if req.backup_type == "logical":
        background_tasks.add_task(mysql_backup_service._do_logical_backup,  job.id, conn_id, cpath)
    elif req.backup_type == "physical":
        background_tasks.add_task(mysql_backup_service._do_physical_backup, job.id, conn_id, cpath)
    elif req.backup_type == "binlog":
        background_tasks.add_task(mysql_backup_service._do_binlog_backup,   job.id, conn_id, cpath)
    return {"status": "success", "message": f"{req.backup_type} backup started",
            "job": mysql_backup_service._job_to_dict(job)}


@router.delete("/{conn_id}/backup/{job_id}")
def delete_backup(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.delete_backup_job(conn_id, job_id, db)


@router.post("/{conn_id}/restore")
def restore_backup(
    conn_id: int,
    req: RestoreRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    src_job, restore_job = mysql_backup_service.create_restore_job(
        conn_id, req.job_id, req.target_db, req.confirm, db
    )
    background_tasks.add_task(
        mysql_backup_service._do_restore_logical,
        src_job.id, restore_job.id, conn_id, req.target_db,
    )
    return {"status": "success", "message": "Restore started",
            "job": mysql_backup_service._job_to_dict(restore_job)}


@router.post("/{conn_id}/pitr")
def point_in_time_recovery(
    conn_id: int,
    req: PITRRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    base_job, pitr_job = mysql_backup_service.create_pitr_job(
        conn_id, req.base_job_id, req.target_datetime, req.target_db, req.confirm, db
    )
    background_tasks.add_task(
        mysql_backup_service._do_pitr,
        pitr_job.id, base_job.id, conn_id, req.target_datetime, req.target_db,
    )
    return {"status": "success", "message": "PITR started",
            "job": mysql_backup_service._job_to_dict(pitr_job)}


@router.get("/{conn_id}/binlog/status")
def binlog_status(conn_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.get_binlog_status(conn_id, db)


@router.get("/{conn_id}/binlogs")
def list_binlogs(conn_id: int, db: Session = Depends(get_db)):
    return mysql_backup_service.list_binlogs_data(conn_id, db)


@router.get("/{conn_id}/binlogs/{log_name}/events")
def binlog_events(
    conn_id: int,
    log_name: str,
    offset: int = Query(0, ge=0),
    limit:  int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    return mysql_backup_service.get_binlog_events(conn_id, log_name, offset, limit, db)


@router.get("/{conn_id}/binlog/live")
def live_binlog_events(
    conn_id: int,
    limit: int = Query(200, ge=1, le=1000),
    db: Session = Depends(get_db),
):
    return mysql_backup_service.get_live_binlog_events(conn_id, limit, db)


@router.get("/{conn_id}/pitr/preview")
def pitr_preview(
    conn_id: int,
    base_job_id:     int,
    target_datetime: str,
    db: Session = Depends(get_db),
):
    return mysql_backup_service.get_pitr_preview(conn_id, base_job_id, target_datetime, db)
