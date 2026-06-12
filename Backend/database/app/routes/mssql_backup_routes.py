"""
MSSQL Server — Backup, Restore & Point-in-Time Recovery
=========================================================
Backup types:
  full         → BACKUP DATABASE ... WITH FORMAT, INIT
  differential → BACKUP DATABASE ... WITH DIFFERENTIAL
  log          → BACKUP LOG ...
  copy_only    → BACKUP DATABASE ... WITH COPY_ONLY (ad-hoc, doesn't break LSN chain)

PITR flow:
  1. Restore latest FULL backup WITH NORECOVERY
  2. Optionally apply latest DIFFERENTIAL WITH NORECOVERY
  3. Apply LOG backups in sequence WITH NORECOVERY
  4. Issue RESTORE DATABASE WITH RECOVERY or WITH STOPAT for PITR

All BACKUP/RESTORE commands are T-SQL executed directly on the SQL Server instance.
Backup files reside on the SQL Server host. ACTMON tracks metadata in backup_jobs table.

Endpoints (prefix /api/v1/connections/mssql)
--------------------------------------------
GET    /{id}/backup/summary
GET    /{id}/backup/history
GET    /{id}/backup/recovery-chain
GET    /{id}/backup/schedules          ← literal routes BEFORE /{job_id}
POST   /{id}/backup/schedules
PUT    /{id}/backup/schedules/{sid}
DELETE /{id}/backup/schedules/{sid}
PATCH  /{id}/backup/schedules/{sid}/toggle
GET    /{id}/backups
POST   /{id}/backup/take
GET    /{id}/backup/{job_id}           ← parameterised last
DELETE /{id}/backup/{job_id}
POST   /{id}/pitr
"""

import threading, uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.backup_model import BackupJob
from app.models.backup_schedule_model import BackupSchedule

_HERE = Path(__file__).resolve().parent.parent.parent
MSSQL_BACKUPS_ROOT = _HERE / "backups" / "mssql"
MSSQL_BACKUPS_ROOT.mkdir(parents=True, exist_ok=True)

router = APIRouter(
    prefix="/api/v1/connections/mssql",
    tags=["MSSQL Backup & PITR"],
)

# ── ensure tables ─────────────────────────────────────────────────────────────
try:
    from app.database.connection import engine as _startup_engine
    BackupSchedule.__table__.create(bind=_startup_engine, checkfirst=True)
    BackupJob.__table__.create(bind=_startup_engine, checkfirst=True)
except Exception as _e:
    pass


# ════════════════════════════════════════════════════════════════════════════
#  Pydantic schemas
# ════════════════════════════════════════════════════════════════════════════

class TakeBackupRequest(BaseModel):
    backup_type: str = "full"               # full | differential | log | copy_only
    database: Optional[str] = None          # None = all user databases
    backup_path: Optional[str] = None       # None = use SQL Server default
    compress: bool = True                   # SQL Server 2008+ backup compression
    notes: Optional[str] = None

class PITRRequest(BaseModel):
    database: str                           # target database
    target_datetime: str                    # "YYYY-MM-DD HH:MM:SS"
    restore_as: Optional[str] = None        # restore as new DB name (None = overwrite)
    full_backup_set_id: Optional[int] = None  # specific media_set_id to start chain
    confirm: bool = False

class ScheduleCreate(BaseModel):
    name: str
    backup_type: str = "full"
    databases: Optional[List[str]] = None   # None = all user DBs
    schedule_type: str = "daily"            # every_x_minutes | hourly | daily | weekly
    interval_minutes: Optional[int] = 30
    minute: Optional[int] = 0
    hour: Optional[int] = 2
    day_of_week: Optional[str] = "0"
    day_of_month: Optional[int] = 1
    backup_path: Optional[str] = None
    compress: bool = True
    retain_days: Optional[int] = 7
    enabled: bool = True
    notes: Optional[str] = None

class ScheduleUpdate(ScheduleCreate):
    pass

class ScheduleToggle(BaseModel):
    enabled: bool


# ════════════════════════════════════════════════════════════════════════════
#  Helpers
# ════════════════════════════════════════════════════════════════════════════

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, f"Connection {conn_id} not found")
    return rec


def _mssql_engine(conn: ConnectionMaster, timeout: int = 30):
    pw = quote_plus(conn.password or "")
    db_name = conn.database_name or "master"
    return create_engine(
        f"mssql+pyodbc://{conn.username}:{pw}@{conn.host}:{conn.port}/{db_name}"
        f"?driver=ODBC+Driver+17+for+SQL+Server&timeout={timeout}",
        pool_pre_ping=True,
        pool_size=1,
        max_overflow=0,
    )


def _rows(engine, sql: str) -> list:
    with engine.connect() as c:
        r = c.execute(text(sql))
        cols = list(r.keys())
        return [dict(zip(cols, row)) for row in r.fetchall()]


def _scalar(engine, sql: str, default=None):
    try:
        with engine.connect() as c:
            row = c.execute(text(sql)).fetchone()
            return row[0] if row else default
    except Exception:
        return default


def _exec_autocommit(engine, sql: str, timeout_seconds: int = 7200):
    """Execute a statement with AUTOCOMMIT (required for BACKUP/RESTORE)."""
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        # Set longer statement timeout via connection attribute isn't standard for pyodbc,
        # but the engine-level timeout is set in URL. This will complete if SQL Server allows.
        conn.execute(text(sql))


def _fmt_bytes(b) -> str:
    b = int(b or 0)
    if b >= 1_073_741_824: return f"{b/1_073_741_824:.2f} GB"
    if b >= 1_048_576:     return f"{b/1_048_576:.2f} MB"
    if b >= 1_024:         return f"{b/1_024:.2f} KB"
    return f"{b} B"


def _job_to_dict(j: BackupJob) -> dict:
    return {
        "id":           j.id,
        "uuid":         j.uuid,
        "connection_id":j.connection_id,
        "db_host":      j.db_host,
        "db_name":      j.db_name,
        "backup_type":  j.backup_type,
        "status":       j.status,
        "size_bytes":   j.size_bytes or 0,
        "size_human":   _fmt_bytes(j.size_bytes or 0),
        "file_path":    j.file_path,
        "backup_start": j.backup_start.isoformat() if j.backup_start else None,
        "backup_end":   j.backup_end.isoformat()   if j.backup_end   else None,
        "error_msg":    j.error_msg,
        "notes":        j.notes,
        "created_at":   j.created_at.isoformat()   if j.created_at   else None,
        "duration_sec": (
            int((j.backup_end - j.backup_start).total_seconds())
            if j.backup_start and j.backup_end else None
        ),
    }


def _get_default_backup_dir(engine) -> str:
    """Read SQL Server's configured default backup directory."""
    try:
        # SQL Server 2014 SP2+ supports InstanceDefaultBackupPath
        val = _scalar(engine, "SELECT CONVERT(NVARCHAR(MAX), SERVERPROPERTY('InstanceDefaultBackupPath'))")
        if val:
            return str(val).rstrip("\\") + "\\"
    except Exception:
        pass
    try:
        # Fallback: read from registry
        rows = _rows(engine, """
            DECLARE @path NVARCHAR(512)
            EXEC master.dbo.xp_instance_regread
                N'HKEY_LOCAL_MACHINE',
                N'Software\\Microsoft\\MSSQLServer\\MSSQLServer',
                N'BackupDirectory', @path OUTPUT
            SELECT @path AS backup_dir
        """)
        if rows and rows[0].get("backup_dir"):
            return str(rows[0]["backup_dir"]).rstrip("\\") + "\\"
    except Exception:
        pass
    return "C:\\Program Files\\Microsoft SQL Server\\MSSQL\\Backup\\"


def _list_user_databases(engine) -> list:
    """Return list of user database names (exclude system DBs)."""
    try:
        rows = _rows(engine, """
            SELECT name FROM sys.databases
            WHERE name NOT IN ('master','model','msdb','tempdb')
              AND state_desc = 'ONLINE'
            ORDER BY name
        """)
        return [r["name"] for r in rows]
    except Exception:
        return []


def _get_last_backup_size_bytes(engine, database: str, backup_type: str) -> int:
    """Query msdb for the size of the most recent backup of a given type."""
    type_char = {"full": "D", "differential": "I", "log": "L", "copy_only": "D"}.get(backup_type, "D")
    try:
        rows = _rows(engine, f"""
            SELECT TOP 1 backup_size
            FROM msdb.dbo.backupset
            WHERE database_name = N'{database}' AND type = '{type_char}'
            ORDER BY backup_finish_date DESC
        """)
        return int(rows[0]["backup_size"] or 0) if rows else 0
    except Exception:
        return 0


# ════════════════════════════════════════════════════════════════════════════
#  Background backup worker
# ════════════════════════════════════════════════════════════════════════════

def _do_mssql_backup(job_id: int, conn_id: int):
    """Execute BACKUP DATABASE/LOG on SQL Server in a background thread."""
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not job or not rec:
            return

        job.status = "running"
        job.backup_start = datetime.utcnow()
        db.commit()

        # Use longer timeout for backup operations
        engine = _mssql_engine(rec, timeout=7200)

        # Build backup path
        backup_dir = job.notes  # notes stores custom path or default
        if not backup_dir:
            backup_dir = _get_default_backup_dir(engine)
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        db_safe = (job.db_name or "ALL").replace(" ", "_").replace("[", "").replace("]", "")
        fname = f"{db_safe}_{job.backup_type.upper()}_{timestamp}.bak"
        full_path = f"{backup_dir.rstrip(chr(92))}\\{fname}"

        compress_clause = "COMPRESSION," if job.compress == "gz" else ""

        # Build T-SQL
        if job.backup_type == "log":
            sql = (
                f"BACKUP LOG [{job.db_name}] TO DISK = N'{full_path}' "
                f"WITH {compress_clause}FORMAT, INIT, "
                f"NAME = N'ACTMON Log Backup {timestamp}', STATS = 10"
            )
        elif job.backup_type == "differential":
            sql = (
                f"BACKUP DATABASE [{job.db_name}] TO DISK = N'{full_path}' "
                f"WITH DIFFERENTIAL, {compress_clause}FORMAT, INIT, "
                f"NAME = N'ACTMON Differential Backup {timestamp}', STATS = 10"
            )
        elif job.backup_type == "copy_only":
            sql = (
                f"BACKUP DATABASE [{job.db_name}] TO DISK = N'{full_path}' "
                f"WITH COPY_ONLY, {compress_clause}FORMAT, INIT, "
                f"NAME = N'ACTMON Copy-Only Backup {timestamp}', STATS = 10"
            )
        else:  # full
            sql = (
                f"BACKUP DATABASE [{job.db_name}] TO DISK = N'{full_path}' "
                f"WITH {compress_clause}FORMAT, INIT, "
                f"NAME = N'ACTMON Full Backup {timestamp}', STATS = 10"
            )

        _exec_autocommit(engine, sql)

        # Get size from msdb (most reliable after backup completes)
        size_bytes = _get_last_backup_size_bytes(engine, job.db_name, job.backup_type)

        job.status     = "completed"
        job.file_path  = full_path
        job.size_bytes = size_bytes
        job.backup_end = datetime.utcnow()
        # Store path in binlog_file field for reference
        job.binlog_file = full_path
        db.commit()
        engine.dispose()

    except Exception as exc:
        try:
            job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if job:
                job.status    = "failed"
                job.error_msg = str(exc)[:2000]
                job.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ════════════════════════════════════════════════════════════════════════════
#  Schedule runner
# ════════════════════════════════════════════════════════════════════════════

def _next_run(sched: BackupSchedule) -> datetime:
    now = datetime.utcnow()
    st  = sched.schedule_type or "daily"
    if st == "every_x_minutes":
        interval = sched.interval_minutes or 30
        return now + timedelta(minutes=interval)
    if st == "hourly":
        nxt = now.replace(minute=sched.minute or 0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(hours=1)
        return nxt
    if st == "daily":
        nxt = now.replace(hour=sched.hour or 2, minute=sched.minute or 0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        return nxt
    if st == "weekly":
        target_dow = int(sched.day_of_week or 0)
        days_ahead = (target_dow - now.weekday()) % 7 or 7
        nxt = (now + timedelta(days=days_ahead)).replace(
            hour=sched.hour or 2, minute=sched.minute or 0, second=0, microsecond=0)
        return nxt
    return now + timedelta(hours=24)


def _run_scheduled_backup(sched_id: int):
    db = SessionLocal()
    try:
        sched = db.query(BackupSchedule).filter(BackupSchedule.id == sched_id).first()
        if not sched or not sched.enabled:
            return
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == sched.conn_id).first()
        if not rec:
            return

        engine = _mssql_engine(rec, timeout=30)
        # Determine databases
        import json as _json
        db_list = []
        if sched.databases:
            try:
                db_list = _json.loads(sched.databases) if isinstance(sched.databases, str) else sched.databases
            except Exception:
                db_list = []
        if not db_list:
            db_list = _list_user_databases(engine)
        engine.dispose()

        for db_name in (db_list or ["master"]):
            backup_path = sched.custom_storage_path or None
            j = BackupJob(
                uuid          = str(uuid.uuid4()),
                connection_id = sched.conn_id,
                db_host       = rec.host,
                db_port       = rec.port,
                db_name       = db_name,
                backup_type   = sched.backup_type or "full",
                compress      = "gz" if sched.compress else "none",
                status        = "pending",
                notes         = backup_path,
            )
            db.add(j)
            db.commit()
            db.refresh(j)
            t = threading.Thread(target=_do_mssql_backup, args=(j.id, rec.id), daemon=True)
            t.start()

        # Update schedule state
        sched.last_run_at = datetime.utcnow()
        sched.last_status = "triggered"
        sched.next_run_at = _next_run(sched)
        db.commit()

        # Prune old jobs
        if sched.retain_days and sched.retain_days > 0:
            cutoff = datetime.utcnow() - timedelta(days=sched.retain_days)
            old_jobs = db.query(BackupJob).filter(
                BackupJob.connection_id == sched.conn_id,
                BackupJob.backup_end < cutoff,
                BackupJob.status == "completed",
            ).all()
            for oj in old_jobs:
                db.delete(oj)
            db.commit()

    except Exception:
        pass
    finally:
        db.close()


_scheduler_started = False
_scheduler_lock    = threading.Lock()


def start_mssql_scheduler():
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True

    def _loop():
        import time
        while True:
            time.sleep(60)
            try:
                db = SessionLocal()
                now = datetime.utcnow()
                due = db.query(BackupSchedule).filter(
                    BackupSchedule.conn_id.isnot(None),
                    BackupSchedule.enabled == True,
                    BackupSchedule.next_run_at <= now,
                ).all()
                # Filter to MSSQL connections only
                ids = [s.conn_id for s in due]
                if ids:
                    mssql_ids = {
                        r.id for r in db.query(ConnectionMaster).filter(
                            ConnectionMaster.id.in_(ids),
                            ConnectionMaster.db_type.ilike("mssql%"),
                        ).all()
                    }
                    for s in due:
                        if s.conn_id in mssql_ids:
                            threading.Thread(
                                target=_run_scheduled_backup,
                                args=(s.id,), daemon=True
                            ).start()
                db.close()
            except Exception:
                pass

    threading.Thread(target=_loop, daemon=True).start()


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINT — Backup Summary
# ════════════════════════════════════════════════════════════════════════════

@router.get("/{conn_id}/backup/summary")
def get_backup_summary(conn_id: int, db: Session = Depends(get_db)):
    rec = _get_conn(conn_id, db)
    engine = _mssql_engine(rec)
    out = {"status": "success", "databases": [], "recent_backups": [], "storage": {}, "recovery_models": []}
    try:
        # Recovery models for all user databases
        out["recovery_models"] = _rows(engine, """
            SELECT name, recovery_model_desc, state_desc,
                   is_auto_shrink_on, is_auto_close_on,
                   log_reuse_wait_desc
            FROM sys.databases
            WHERE name NOT IN ('master','model','msdb','tempdb')
            ORDER BY name
        """)

        # Last backup per database per type
        out["last_backups"] = _rows(engine, """
            SELECT
                database_name,
                MAX(CASE WHEN type = 'D' THEN backup_finish_date END) AS last_full,
                MAX(CASE WHEN type = 'I' THEN backup_finish_date END) AS last_diff,
                MAX(CASE WHEN type = 'L' THEN backup_finish_date END) AS last_log,
                SUM(CASE WHEN type = 'D' THEN 1 ELSE 0 END) AS full_count,
                SUM(CASE WHEN type = 'I' THEN 1 ELSE 0 END) AS diff_count,
                SUM(CASE WHEN type = 'L' THEN 1 ELSE 0 END) AS log_count,
                SUM(backup_size) AS total_backup_bytes
            FROM msdb.dbo.backupset
            WHERE backup_finish_date >= DATEADD(day, -30, GETDATE())
            GROUP BY database_name
            ORDER BY database_name
        """)

        # Databases with NO backup in last 7 days
        out["unprotected_databases"] = _rows(engine, """
            SELECT d.name
            FROM sys.databases d
            WHERE d.name NOT IN ('tempdb')
              AND d.state_desc = 'ONLINE'
              AND d.name NOT IN (
                  SELECT DISTINCT database_name FROM msdb.dbo.backupset
                  WHERE backup_finish_date >= DATEADD(day, -7, GETDATE())
              )
            ORDER BY d.name
        """)

        # Overall stats
        stats = _rows(engine, """
            SELECT
                COUNT(*)                                  AS total_backups,
                SUM(backup_size) / 1048576.0              AS total_size_mb,
                MIN(backup_start_date)                    AS oldest_backup,
                MAX(backup_finish_date)                   AS newest_backup,
                COUNT(DISTINCT database_name)             AS databases_backed_up
            FROM msdb.dbo.backupset
            WHERE backup_finish_date >= DATEADD(day, -30, GETDATE())
        """)
        out["stats"] = stats[0] if stats else {}

        # Default backup directory
        out["default_backup_dir"] = _get_default_backup_dir(engine)

        # ACTMON job counts
        total_jobs = db.query(BackupJob).filter(BackupJob.connection_id == conn_id).count()
        running_jobs = db.query(BackupJob).filter(
            BackupJob.connection_id == conn_id,
            BackupJob.status == "running"
        ).count()
        out["actmon_jobs"] = {"total": total_jobs, "running": running_jobs}

    except Exception as e:
        out["error"] = str(e)
    finally:
        engine.dispose()
    return out


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINT — Native Backup History (from msdb)
# ════════════════════════════════════════════════════════════════════════════

@router.get("/{conn_id}/backup/history")
def get_backup_history(
    conn_id: int,
    db_name: Optional[str] = Query(None),
    backup_type: Optional[str] = Query(None),   # full | differential | log
    days: int = Query(30),
    limit: int = Query(100),
    db: Session = Depends(get_db),
):
    rec = _get_conn(conn_id, db)
    engine = _mssql_engine(rec)
    try:
        type_filter = ""
        if backup_type == "full":
            type_filter = "AND bs.type = 'D' AND bs.is_copy_only = 0"
        elif backup_type == "differential":
            type_filter = "AND bs.type = 'I'"
        elif backup_type == "log":
            type_filter = "AND bs.type = 'L'"
        elif backup_type == "copy_only":
            type_filter = "AND bs.type = 'D' AND bs.is_copy_only = 1"

        db_filter = f"AND bs.database_name = N'{db_name}'" if db_name else ""

        rows = _rows(engine, f"""
            SELECT TOP {limit}
                bs.database_name,
                CASE bs.type
                    WHEN 'D' THEN CASE WHEN bs.is_copy_only = 1 THEN 'copy_only' ELSE 'full' END
                    WHEN 'I' THEN 'differential'
                    WHEN 'L' THEN 'log'
                    ELSE bs.type
                END AS backup_type,
                CONVERT(VARCHAR(23), bs.backup_start_date,  121) AS backup_start,
                CONVERT(VARCHAR(23), bs.backup_finish_date, 121) AS backup_finish,
                DATEDIFF(second, bs.backup_start_date, bs.backup_finish_date) AS duration_sec,
                CAST(bs.backup_size / 1048576.0 AS DECIMAL(18,2)) AS size_mb,
                CAST(bs.compressed_backup_size / 1048576.0 AS DECIMAL(18,2)) AS compressed_mb,
                bs.server_name,
                bs.recovery_model,
                bs.media_set_id,
                bs.first_lsn,
                bs.last_lsn,
                bs.database_backup_lsn,
                ISNULL(bmf.physical_device_name, '') AS file_path,
                bs.name AS backup_name,
                bs.description
            FROM msdb.dbo.backupset bs
            LEFT JOIN msdb.dbo.backupmediafamily bmf
                ON bs.media_set_id = bmf.media_set_id
            WHERE bs.backup_finish_date >= DATEADD(day, -{days}, GETDATE())
              {db_filter}
              {type_filter}
            ORDER BY bs.backup_finish_date DESC
        """)

        # Convert Decimal/numeric to float for JSON serialisation
        for r in rows:
            for k, v in r.items():
                if hasattr(v, '__float__'):
                    r[k] = float(v)
                elif isinstance(v, datetime):
                    r[k] = v.isoformat()

        return {"status": "success", "history": rows, "count": len(rows)}
    except Exception as e:
        return {"status": "error", "error": str(e), "history": []}
    finally:
        engine.dispose()


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINT — Recovery Chain (for PITR planning)
# ════════════════════════════════════════════════════════════════════════════

@router.get("/{conn_id}/backup/recovery-chain")
def get_recovery_chain(
    conn_id: int,
    db_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    rec = _get_conn(conn_id, db)
    engine = _mssql_engine(rec)
    try:
        db_filter = f"WHERE bs.database_name = N'{db_name}'" if db_name else "WHERE 1=1"

        # Get all databases with backups
        db_names_rows = _rows(engine, f"""
            SELECT DISTINCT database_name
            FROM msdb.dbo.backupset
            {db_filter}
            ORDER BY database_name
        """)
        db_names = [r["database_name"] for r in db_names_rows]

        chains = []
        for dbn in db_names:
            # Latest full backup
            fulls = _rows(engine, f"""
                SELECT TOP 3
                    bs.media_set_id,
                    CONVERT(VARCHAR(23), bs.backup_start_date,  121) AS backup_start,
                    CONVERT(VARCHAR(23), bs.backup_finish_date, 121) AS backup_finish,
                    CAST(bs.backup_size / 1048576.0 AS DECIMAL(18,2)) AS size_mb,
                    bs.first_lsn, bs.last_lsn, bs.database_backup_lsn,
                    ISNULL(bmf.physical_device_name,'') AS file_path,
                    bs.recovery_model
                FROM msdb.dbo.backupset bs
                LEFT JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                WHERE bs.database_name = N'{dbn}' AND bs.type = 'D' AND bs.is_copy_only = 0
                ORDER BY bs.backup_finish_date DESC
            """)

            if not fulls:
                chains.append({
                    "database": dbn, "has_full": False,
                    "full_backup": None, "differentials": [], "log_backups": [],
                    "earliest_pitr": None, "latest_pitr": None,
                })
                continue

            latest_full = fulls[0]

            # Convert numerics
            for r in fulls:
                for k, v in r.items():
                    if hasattr(v, '__float__'):
                        r[k] = float(v)

            # Differential backups after this full
            diffs = _rows(engine, f"""
                SELECT TOP 5
                    bs.media_set_id,
                    CONVERT(VARCHAR(23), bs.backup_start_date,  121) AS backup_start,
                    CONVERT(VARCHAR(23), bs.backup_finish_date, 121) AS backup_finish,
                    CAST(bs.backup_size / 1048576.0 AS DECIMAL(18,2)) AS size_mb,
                    bs.first_lsn, bs.last_lsn, bs.database_backup_lsn,
                    ISNULL(bmf.physical_device_name,'') AS file_path
                FROM msdb.dbo.backupset bs
                LEFT JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                WHERE bs.database_name = N'{dbn}'
                  AND bs.type = 'I'
                  AND bs.database_backup_lsn >= {latest_full.get('database_backup_lsn') or 0}
                ORDER BY bs.backup_finish_date DESC
            """)
            for r in diffs:
                for k, v in r.items():
                    if hasattr(v, '__float__'):
                        r[k] = float(v)

            # Log backups after the latest full (or diff if present)
            anchor_lsn = float(diffs[0].get("last_lsn", 0) or 0) if diffs else float(latest_full.get("last_lsn", 0) or 0)
            logs = _rows(engine, f"""
                SELECT TOP 100
                    bs.media_set_id,
                    CONVERT(VARCHAR(23), bs.backup_start_date,  121) AS backup_start,
                    CONVERT(VARCHAR(23), bs.backup_finish_date, 121) AS backup_finish,
                    CAST(bs.backup_size / 1048576.0 AS DECIMAL(18,2)) AS size_mb,
                    bs.first_lsn, bs.last_lsn, bs.database_backup_lsn,
                    ISNULL(bmf.physical_device_name,'') AS file_path
                FROM msdb.dbo.backupset bs
                LEFT JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                WHERE bs.database_name = N'{dbn}'
                  AND bs.type = 'L'
                  AND bs.first_lsn >= {float(latest_full.get('last_lsn', 0) or 0)}
                ORDER BY bs.backup_finish_date ASC
            """)
            for r in logs:
                for k, v in r.items():
                    if hasattr(v, '__float__'):
                        r[k] = float(v)

            earliest_pitr = latest_full.get("backup_finish")
            latest_pitr   = logs[-1].get("backup_finish") if logs else latest_full.get("backup_finish")

            chains.append({
                "database":        dbn,
                "has_full":        True,
                "full_backup":     latest_full,
                "all_fulls":       fulls,
                "differentials":   diffs,
                "log_backups":     logs,
                "log_count":       len(logs),
                "earliest_pitr":   earliest_pitr,
                "latest_pitr":     latest_pitr,
                "recovery_model":  latest_full.get("recovery_model", "UNKNOWN"),
            })

        return {"status": "success", "chains": chains}
    except Exception as e:
        return {"status": "error", "error": str(e), "chains": []}
    finally:
        engine.dispose()


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINTS — Schedule CRUD  (all literal paths before /{job_id})
# ════════════════════════════════════════════════════════════════════════════

def _human_schedule(s: BackupSchedule) -> str:
    """Return a human-readable description of when a schedule fires."""
    st = s.schedule_type or "daily"
    h  = s.hour or 0
    m  = s.minute or 0
    per = "AM" if h < 12 else "PM"
    h12 = 12 if h == 0 else (h - 12 if h > 12 else h)
    t   = f"{h12}:{m:02d} {per}"
    if st == "every_x_minutes":
        n = s.interval_minutes or 30
        return f"Every {n} min" if n < 60 else f"Every {n//60} hr"
    if st == "hourly":
        return f"Every hour at :{m:02d}"
    if st == "daily":
        return f"Daily at {t}"
    if st == "weekly":
        dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        days = ", ".join(dow_names[int(d.strip())] for d in (s.day_of_week or "0").split(",") if d.strip().isdigit())
        return f"{days or 'Mon'} at {t}"
    if st == "monthly":
        dom = s.day_of_month or 1
        sfx = "st" if dom == 1 else "nd" if dom == 2 else "rd" if dom == 3 else "th"
        return f"{dom}{sfx} of month at {t}"
    return st


@router.get("/{conn_id}/backup/schedules")
def list_schedules(conn_id: int, db: Session = Depends(get_db)):
    _ = _get_conn(conn_id, db)
    scheds = db.query(BackupSchedule).filter(BackupSchedule.conn_id == conn_id).order_by(BackupSchedule.id).all()
    def _s(s):
        import json as _json
        return {
            "id":                s.id,
            "name":              s.name,
            "backup_type":       s.backup_type,
            "databases":         _json.loads(s.databases) if s.databases else [],
            "schedule_type":     s.schedule_type,
            "interval_minutes":  s.interval_minutes,
            "minute":            s.minute,
            "hour":              s.hour,
            "day_of_week":       s.day_of_week,
            "day_of_month":      s.day_of_month,
            "retain_days":       s.retain_days,
            "backup_path":       s.custom_storage_path,
            "compress":          s.compress,
            "enabled":           s.enabled,
            "last_run_at":       s.last_run_at.isoformat()  if s.last_run_at  else None,
            "next_run_at":       s.next_run_at.isoformat()  if s.next_run_at  else None,
            "last_status":       s.last_status,
            "created_at":        s.created_at.isoformat()   if s.created_at   else None,
            "human_schedule":    _human_schedule(s),
        }
    return {"status": "success", "schedules": [_s(s) for s in scheds]}


@router.post("/{conn_id}/backup/schedules", status_code=201)
def create_schedule(conn_id: int, body: ScheduleCreate, db: Session = Depends(get_db)):
    _ = _get_conn(conn_id, db)
    import json as _json
    s = BackupSchedule(
        conn_id              = conn_id,
        name                 = body.name,
        backup_type          = body.backup_type,
        databases            = _json.dumps(body.databases or []),
        schedule_type        = body.schedule_type,
        interval_minutes     = body.interval_minutes,
        minute               = body.minute,
        hour                 = body.hour,
        day_of_week          = body.day_of_week,
        day_of_month         = body.day_of_month,
        custom_storage_path  = body.backup_path,
        compress             = body.compress,
        retain_days          = body.retain_days,
        enabled              = body.enabled,
    )
    s.next_run_at = _next_run(s)
    db.add(s)
    db.commit()
    db.refresh(s)
    return {"status": "success", "id": s.id}


@router.put("/{conn_id}/backup/schedules/{sid}")
def update_schedule(conn_id: int, sid: int, body: ScheduleUpdate, db: Session = Depends(get_db)):
    import json as _json
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    s.name                = body.name
    s.backup_type         = body.backup_type
    s.databases           = _json.dumps(body.databases or [])
    s.schedule_type       = body.schedule_type
    s.interval_minutes    = body.interval_minutes
    s.minute              = body.minute
    s.hour                = body.hour
    s.day_of_week         = body.day_of_week
    s.day_of_month        = body.day_of_month
    s.custom_storage_path = body.backup_path
    s.compress            = body.compress
    s.retain_days         = body.retain_days
    s.enabled             = body.enabled
    s.next_run_at         = _next_run(s)
    s.updated_at          = datetime.utcnow()
    db.commit()
    return {"status": "success"}


@router.delete("/{conn_id}/backup/schedules/{sid}")
def delete_schedule(conn_id: int, sid: int, db: Session = Depends(get_db)):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    db.delete(s)
    db.commit()
    return {"status": "success"}


@router.patch("/{conn_id}/backup/schedules/{sid}/toggle")
def toggle_schedule(conn_id: int, sid: int, body: ScheduleToggle, db: Session = Depends(get_db)):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    s.enabled = body.enabled
    if body.enabled and not s.next_run_at:
        s.next_run_at = _next_run(s)
    db.commit()
    return {"status": "success", "enabled": s.enabled}


@router.post("/{conn_id}/backup/schedules/{sid}/run-now")
def run_schedule_now(conn_id: int, sid: int, db: Session = Depends(get_db)):
    """Immediately trigger all backup jobs for a schedule, regardless of next_run_at."""
    _ = _get_conn(conn_id, db)
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    t = threading.Thread(target=_run_scheduled_backup, args=(sid,), daemon=True)
    t.start()
    return {"status": "success", "message": f"Schedule '{s.name}' triggered immediately"}


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINTS — ACTMON Backup Jobs
# ════════════════════════════════════════════════════════════════════════════

@router.get("/{conn_id}/backups")
def list_backups(
    conn_id: int,
    status: Optional[str] = Query(None),
    limit: int = Query(50),
    db: Session = Depends(get_db),
):
    _ = _get_conn(conn_id, db)
    q = db.query(BackupJob).filter(BackupJob.connection_id == conn_id)
    if status:
        q = q.filter(BackupJob.status == status)
    jobs = q.order_by(BackupJob.id.desc()).limit(limit).all()
    return {"status": "success", "jobs": [_job_to_dict(j) for j in jobs]}


@router.post("/{conn_id}/backup/take", status_code=202)
def take_backup(conn_id: int, body: TakeBackupRequest, db: Session = Depends(get_db)):
    rec = _get_conn(conn_id, db)

    if not body.database:
        raise HTTPException(400, "database is required for MSSQL backup")

    j = BackupJob(
        uuid          = str(uuid.uuid4()),
        connection_id = conn_id,
        db_host       = rec.host,
        db_port       = rec.port,
        db_name       = body.database,
        backup_type   = body.backup_type,
        compress      = "gz" if body.compress else "none",
        status        = "pending",
        notes         = body.backup_path,  # reuse notes for custom path
    )
    db.add(j)
    db.commit()
    db.refresh(j)

    threading.Thread(target=_do_mssql_backup, args=(j.id, conn_id), daemon=True).start()

    return {"status": "accepted", "job_id": j.id, "uuid": j.uuid}


@router.get("/{conn_id}/backup/{job_id}")
def get_backup_job(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    _ = _get_conn(conn_id, db)
    j = db.query(BackupJob).filter(BackupJob.id == job_id, BackupJob.connection_id == conn_id).first()
    if not j:
        raise HTTPException(404, "Job not found")
    return {"status": "success", "job": _job_to_dict(j)}


@router.delete("/{conn_id}/backup/{job_id}")
def delete_backup_job(conn_id: int, job_id: int, db: Session = Depends(get_db)):
    _ = _get_conn(conn_id, db)
    j = db.query(BackupJob).filter(BackupJob.id == job_id, BackupJob.connection_id == conn_id).first()
    if not j:
        raise HTTPException(404, "Job not found")
    db.delete(j)
    db.commit()
    return {"status": "success"}


# ════════════════════════════════════════════════════════════════════════════
#  ENDPOINT — Point-in-Time Recovery (PITR)
# ════════════════════════════════════════════════════════════════════════════

@router.post("/{conn_id}/pitr", status_code=202)
def start_pitr(conn_id: int, body: PITRRequest, db: Session = Depends(get_db)):
    if not body.confirm:
        raise HTTPException(400, "Set confirm=true to proceed with PITR — this will overwrite the target database.")
    rec = _get_conn(conn_id, db)

    restore_db = body.restore_as or body.database
    job_uuid   = str(uuid.uuid4())

    j = BackupJob(
        uuid          = job_uuid,
        connection_id = conn_id,
        db_host       = rec.host,
        db_port       = rec.port,
        db_name       = restore_db,
        backup_type   = "pitr",
        compress      = "none",
        status        = "pending",
        notes         = body.target_datetime,
    )
    db.add(j)
    db.commit()
    db.refresh(j)

    target_dt = body.target_datetime
    target_db = body.database
    full_set_id = body.full_backup_set_id

    def _do_pitr():
        inner_db = SessionLocal()
        try:
            job_inner = inner_db.query(BackupJob).filter(BackupJob.id == j.id).first()
            if not job_inner:
                return
            job_inner.status = "running"
            job_inner.backup_start = datetime.utcnow()
            inner_db.commit()

            engine = _mssql_engine(rec, timeout=7200)

            # Step 1: Find the full backup to restore from
            if full_set_id:
                full_rows = _rows(engine, f"""
                    SELECT bs.media_set_id, bmf.physical_device_name AS file_path,
                           bs.last_lsn, bs.database_backup_lsn
                    FROM msdb.dbo.backupset bs
                    JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                    WHERE bs.media_set_id = {full_set_id} AND bs.type = 'D'
                """)
            else:
                full_rows = _rows(engine, f"""
                    SELECT TOP 1 bs.media_set_id, bmf.physical_device_name AS file_path,
                                 bs.last_lsn, bs.database_backup_lsn
                    FROM msdb.dbo.backupset bs
                    JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                    WHERE bs.database_name = N'{target_db}'
                      AND bs.type = 'D' AND bs.is_copy_only = 0
                      AND bs.backup_finish_date <= '{target_dt}'
                    ORDER BY bs.backup_finish_date DESC
                """)

            if not full_rows:
                job_inner.status = "failed"
                job_inner.error_msg = f"No full backup found for {target_db} before {target_dt}"
                job_inner.backup_end = datetime.utcnow()
                inner_db.commit()
                return

            full_file = full_rows[0]["file_path"]
            full_lsn  = float(full_rows[0].get("last_lsn") or 0)

            # Step 2: Latest differential after the full
            diff_rows = _rows(engine, f"""
                SELECT TOP 1 bmf.physical_device_name AS file_path,
                             bs.last_lsn, bs.database_backup_lsn
                FROM msdb.dbo.backupset bs
                JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                WHERE bs.database_name = N'{target_db}'
                  AND bs.type = 'I'
                  AND bs.database_backup_lsn >= {full_lsn - 1}
                  AND bs.backup_finish_date <= '{target_dt}'
                ORDER BY bs.backup_finish_date DESC
            """)

            # Step 3: Log backups
            anchor_lsn = float(diff_rows[0].get("last_lsn") or 0) if diff_rows else full_lsn
            log_rows = _rows(engine, f"""
                SELECT bmf.physical_device_name AS file_path,
                       bs.first_lsn, bs.last_lsn,
                       CONVERT(VARCHAR(23), bs.backup_finish_date, 121) AS backup_finish
                FROM msdb.dbo.backupset bs
                JOIN msdb.dbo.backupmediafamily bmf ON bs.media_set_id = bmf.media_set_id
                WHERE bs.database_name = N'{target_db}'
                  AND bs.type = 'L'
                  AND bs.first_lsn >= {anchor_lsn - 1}
                  AND bs.backup_start_date <= '{target_dt}'
                ORDER BY bs.backup_start_date ASC
            """)

            # Step 4: Execute restore chain
            replace_clause = f"WITH REPLACE, " if restore_db == target_db else ""

            # Kill existing connections if overwriting
            if restore_db == target_db:
                try:
                    _exec_autocommit(engine, f"""
                        ALTER DATABASE [{restore_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE
                    """)
                except Exception:
                    pass

            # Restore FULL WITH NORECOVERY
            _exec_autocommit(engine, f"""
                RESTORE DATABASE [{restore_db}]
                FROM DISK = N'{full_file}'
                WITH {replace_clause}NORECOVERY, STATS = 10
            """)

            # Restore DIFF WITH NORECOVERY (if found)
            if diff_rows:
                diff_file = diff_rows[0]["file_path"]
                _exec_autocommit(engine, f"""
                    RESTORE DATABASE [{restore_db}]
                    FROM DISK = N'{diff_file}'
                    WITH NORECOVERY, STATS = 10
                """)

            # Restore LOGS with NORECOVERY (except last which uses STOPAT)
            for i, lg in enumerate(log_rows):
                is_last = (i == len(log_rows) - 1)
                recovery_clause = f"RECOVERY, STOPAT = '{target_dt}'" if is_last else "NORECOVERY"
                _exec_autocommit(engine, f"""
                    RESTORE LOG [{restore_db}]
                    FROM DISK = N'{lg["file_path"]}'
                    WITH {recovery_clause}, STATS = 10
                """)

            # If no logs, bring DB online with RECOVERY
            if not log_rows:
                _exec_autocommit(engine, f"""
                    RESTORE DATABASE [{restore_db}] WITH RECOVERY
                """)

            job_inner.status    = "completed"
            job_inner.file_path = full_file
            job_inner.backup_end = datetime.utcnow()
            inner_db.commit()
            engine.dispose()

        except Exception as exc:
            try:
                job_inner = inner_db.query(BackupJob).filter(BackupJob.id == j.id).first()
                if job_inner:
                    job_inner.status    = "failed"
                    job_inner.error_msg = str(exc)[:2000]
                    job_inner.backup_end = datetime.utcnow()
                    inner_db.commit()
            except Exception:
                pass
        finally:
            inner_db.close()

    threading.Thread(target=_do_pitr, daemon=True).start()
    return {"status": "accepted", "job_id": j.id, "uuid": job_uuid, "message": f"PITR to {target_dt} started"}
