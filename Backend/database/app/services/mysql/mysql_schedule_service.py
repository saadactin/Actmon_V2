import json
import threading
import uuid
from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.backup_model import BackupJob
from app.models.backup_schedule_model import BackupSchedule


# ── Next-run calculator ───────────────────────────────────────────────────────

def _calc_next_run(sched: BackupSchedule, after: datetime = None) -> datetime:
    now = after or datetime.utcnow()
    st  = sched.schedule_type or "daily"
    h   = sched.hour   or 0
    m   = sched.minute or 0

    if st == "every_x_minutes":
        interval = max(1, sched.interval_minutes or 30)
        return now + timedelta(minutes=interval)

    if st == "hourly":
        candidate = now.replace(second=0, microsecond=0, minute=m)
        if candidate <= now:
            candidate += timedelta(hours=1)
        return candidate

    if st == "daily":
        candidate = now.replace(second=0, microsecond=0, hour=h, minute=m)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if st == "weekly":
        target_days = set()
        raw = (sched.day_of_week or "0").strip()
        for part in raw.split(","):
            try:
                target_days.add(int(part.strip()))
            except ValueError:
                pass
        if not target_days:
            target_days = {0}
        for delta in range(1, 8):
            cand_dt = now + timedelta(days=delta)
            if cand_dt.weekday() in target_days:
                candidate = cand_dt.replace(second=0, microsecond=0, hour=h, minute=m)
                if candidate > now:
                    return candidate
        return now + timedelta(days=7)

    if st == "monthly":
        dom = sched.day_of_month or 1
        try:
            candidate = now.replace(second=0, microsecond=0, day=dom, hour=h, minute=m)
            if candidate > now:
                return candidate
        except ValueError:
            pass
        y, mo = now.year, now.month
        if mo == 12:
            y, mo = y + 1, 1
        else:
            mo += 1
        try:
            return datetime(y, mo, dom, h, m, 0)
        except ValueError:
            return datetime(y, mo, 1, h, m, 0)

    return now + timedelta(hours=1)


# ── Serialization helpers ─────────────────────────────────────────────────────

def _to_12h(h: int, m: int) -> str:
    period = "AM" if h < 12 else "PM"
    h12    = 12 if h in (0, 12) else (h % 12)
    return f"{h12}:{m:02d} {period}"


def _human_schedule(s: BackupSchedule) -> str:
    st = s.schedule_type or "daily"
    h  = s.hour   or 0
    m  = s.minute or 0
    t  = _to_12h(h, m)

    if st == "every_x_minutes":
        n    = s.interval_minutes or 30
        hrs  = n // 60
        mins = n % 60
        if n < 60:
            return f"Every {n} min"
        return f"Every {hrs} hr" + (f" {mins} min" if mins else "")

    if st == "hourly":
        return f"Every hour at :{m:02d}"

    if st == "daily":
        return f"Daily at {t}"

    if st == "weekly":
        days_map = {0: "Mon", 1: "Tue", 2: "Wed", 3: "Thu", 4: "Fri", 5: "Sat", 6: "Sun"}
        parts = []
        for d in (s.day_of_week or "0").split(","):
            try:
                parts.append(days_map.get(int(d.strip()), d.strip()))
            except Exception:
                pass
        return f"Weekly {', '.join(parts)} at {t}"

    if st == "monthly":
        dom = s.day_of_month or 1
        suf = "st" if dom == 1 else "nd" if dom == 2 else "rd" if dom == 3 else "th"
        return f"Monthly {dom}{suf} at {t}"

    return st


def _sched_to_dict(s: BackupSchedule) -> dict:
    dbs = None
    if s.databases:
        try:
            dbs = json.loads(s.databases)
        except Exception:
            dbs = [s.databases]
    return {
        "id":                   s.id,
        "conn_id":              s.conn_id,
        "name":                 s.name,
        "backup_type":          s.backup_type,
        "schedule_type":        s.schedule_type,
        "interval_minutes":     s.interval_minutes,
        "minute":               s.minute,
        "hour":                 s.hour,
        "day_of_week":          s.day_of_week,
        "day_of_month":         s.day_of_month,
        "databases":            dbs,
        "compress":             s.compress,
        "custom_storage_path":  s.custom_storage_path,
        "retain_days":          s.retain_days,
        "notes":                s.notes,
        "enabled":              s.enabled,
        "created_at":           s.created_at.isoformat()  if s.created_at  else None,
        "updated_at":           s.updated_at.isoformat()  if s.updated_at  else None,
        "last_run_at":          s.last_run_at.isoformat() if s.last_run_at else None,
        "next_run_at":          s.next_run_at.isoformat() if s.next_run_at else None,
        "last_job_id":          s.last_job_id,
        "last_status":          s.last_status,
        "human_schedule":       _human_schedule(s),
    }


def _apply_fields(sched: BackupSchedule, data: dict):
    """Apply validated schedule fields from a dict onto a BackupSchedule ORM object."""
    sched.name                = data["name"]
    sched.backup_type         = data.get("backup_type", "logical")
    sched.schedule_type       = data.get("schedule_type", "daily")
    sched.interval_minutes    = data.get("interval_minutes")
    sched.minute              = data.get("minute", 0)
    sched.hour                = data.get("hour", 2)
    sched.day_of_week         = data.get("day_of_week", "0")
    sched.day_of_month        = data.get("day_of_month", 1)
    databases                 = data.get("databases")
    sched.databases           = json.dumps(databases) if databases else None
    sched.compress            = data.get("compress", True)
    sched.custom_storage_path = data.get("custom_storage_path")
    sched.retain_days         = data.get("retain_days", 7)
    sched.notes               = data.get("notes")
    sched.enabled             = data.get("enabled", True)
    sched.next_run_at         = _calc_next_run(sched) if sched.enabled else None
    sched.updated_at          = datetime.utcnow()


# ── Background scheduler ──────────────────────────────────────────────────────

_scheduler_started = False
_scheduler_lock    = threading.Lock()


def _run_scheduled_job(sched_id: int, conn_id: int, backup_type: str,
                       databases_json: Optional[str], compress: bool,
                       custom_path: Optional[str], notes: Optional[str]):
    from app.services.mysql.mysql_backup_service import (
        _do_logical_backup, _do_physical_backup, _do_binlog_backup,
    )

    db = SessionLocal()
    job = None
    try:
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not rec:
            return

        dbs_list = None
        if databases_json:
            try:
                dbs_list = json.loads(databases_json)
            except Exception:
                pass

        job = BackupJob(
            uuid         = str(uuid.uuid4()),
            conn_id      = conn_id,
            db_host      = rec.host,
            db_port      = rec.port or 3306,
            db_name      = (dbs_list[0] if dbs_list and len(dbs_list) == 1 else None),
            backup_type  = backup_type,
            status       = "pending",
            compress     = compress,
            notes        = f"[Scheduled#{sched_id}] {notes or ''}".strip(),
            backup_start = datetime.utcnow(),
        )
        db.add(job)
        db.commit()
        db.refresh(job)
        job_id = job.id

        sched = db.query(BackupSchedule).filter(BackupSchedule.id == sched_id).first()
        if sched:
            sched.last_job_id = job_id
            sched.last_status = "running"
            db.commit()
    finally:
        db.close()

    if job is None:
        return

    try:
        if backup_type == "logical":
            _do_logical_backup(job_id, conn_id, custom_path)
        elif backup_type == "physical":
            _do_physical_backup(job_id, conn_id, custom_path)
        elif backup_type == "binlog":
            _do_binlog_backup(job_id, conn_id, custom_path)
    except Exception:
        pass

    db2 = SessionLocal()
    try:
        finished_job = db2.query(BackupJob).filter(BackupJob.id == job_id).first()
        final_status = finished_job.status if finished_job else "failed"
        sched2 = db2.query(BackupSchedule).filter(BackupSchedule.id == sched_id).first()
        if sched2:
            sched2.last_status = final_status
            db2.commit()
    finally:
        db2.close()


def _scheduler_tick():
    now = datetime.utcnow()
    db  = SessionLocal()
    try:
        due = (db.query(BackupSchedule)
               .filter(BackupSchedule.enabled == True,
                       BackupSchedule.next_run_at <= now)
               .all())
        for sched in due:
            sched.last_run_at = now
            sched.next_run_at = _calc_next_run(sched, after=now)
            db.commit()
            threading.Thread(
                target=_run_scheduled_job,
                args=(sched.id, sched.conn_id, sched.backup_type,
                      sched.databases, sched.compress,
                      sched.custom_storage_path, sched.notes),
                daemon=True,
            ).start()
    finally:
        db.close()


def _scheduler_worker():
    while True:
        threading.Event().wait(30)
        try:
            _scheduler_tick()
        except Exception as exc:
            print(f"[BackupScheduler] tick error: {exc}")


def _ensure_table():
    try:
        from app.database.connection import engine as _eng
        BackupSchedule.__table__.create(bind=_eng, checkfirst=True)
        print("[BackupScheduler] backup_schedules table ready.")
    except Exception as exc:
        print(f"[BackupScheduler] Could not ensure table: {exc}")


def start_scheduler():
    """Idempotent — safe to call multiple times; only starts once."""
    _ensure_table()
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    t = threading.Thread(target=_scheduler_worker, daemon=True, name="BackupScheduler")
    t.start()
    print("[BackupScheduler] Background scheduler started.")


# ── CRUD service functions ────────────────────────────────────────────────────

def list_schedules(conn_id: int, db: Session) -> dict:
    try:
        rows = (db.query(BackupSchedule)
                .filter(BackupSchedule.conn_id == conn_id)
                .order_by(BackupSchedule.id.desc())
                .all())
        return {"status": "success", "data": [_sched_to_dict(r) for r in rows]}
    except Exception as exc:
        _ensure_table()
        print(f"[list_schedules] error: {exc}")
        return {"status": "error", "error": str(exc), "data": []}


def create_schedule(conn_id: int, data: dict, db: Session) -> dict:
    _ensure_table()
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        raise HTTPException(404, "Connection not found")
    try:
        sched = BackupSchedule(conn_id=conn_id, created_at=datetime.utcnow())
        _apply_fields(sched, data)
        db.add(sched)
        db.commit()
        db.refresh(sched)
        return {"status": "success", "message": "Schedule created", "data": _sched_to_dict(sched)}
    except Exception as exc:
        db.rollback()
        print(f"[create_schedule] error: {exc}")
        raise HTTPException(500, f"Failed to create schedule: {exc}")


def get_schedule(conn_id: int, sid: int, db: Session) -> dict:
    sched = db.query(BackupSchedule).filter(
        BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not sched:
        raise HTTPException(404, "Schedule not found")
    return {"status": "success", "data": _sched_to_dict(sched)}


def update_schedule(conn_id: int, sid: int, data: dict, db: Session) -> dict:
    sched = db.query(BackupSchedule).filter(
        BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not sched:
        raise HTTPException(404, "Schedule not found")
    _apply_fields(sched, data)
    db.commit()
    db.refresh(sched)
    return {"status": "success", "message": "Schedule updated", "data": _sched_to_dict(sched)}


def delete_schedule(conn_id: int, sid: int, db: Session) -> dict:
    sched = db.query(BackupSchedule).filter(
        BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not sched:
        raise HTTPException(404, "Schedule not found")
    db.delete(sched)
    db.commit()
    return {"status": "success", "message": "Schedule deleted"}


def toggle_schedule(conn_id: int, sid: int, enabled: bool, db: Session) -> dict:
    sched = db.query(BackupSchedule).filter(
        BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not sched:
        raise HTTPException(404, "Schedule not found")
    sched.enabled     = enabled
    sched.next_run_at = _calc_next_run(sched) if enabled else None
    sched.updated_at  = datetime.utcnow()
    db.commit()
    db.refresh(sched)
    return {
        "status":  "success",
        "message": f"Schedule {'enabled' if enabled else 'disabled'}",
        "data":    _sched_to_dict(sched),
    }


def run_schedule_now(conn_id: int, sid: int, db: Session) -> dict:
    sched = db.query(BackupSchedule).filter(
        BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not sched:
        raise HTTPException(404, "Schedule not found")

    threading.Thread(
        target=_run_scheduled_job,
        args=(sched.id, sched.conn_id, sched.backup_type,
              sched.databases, sched.compress,
              sched.custom_storage_path, sched.notes),
        daemon=True,
    ).start()

    sched.last_run_at = datetime.utcnow()
    sched.last_status = "running"
    db.commit()
    return {"status": "success", "message": "Backup triggered — check My Backups for progress"}
