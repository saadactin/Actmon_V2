"""
PostgreSQL Backup & PITR Service — all business logic, background workers,
schedule helpers, and scheduler thread.
"""

import base64, json, shutil, tarfile, threading, uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List
from urllib.parse import quote_plus

import paramiko
from fastapi import BackgroundTasks, HTTPException
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer
from app.models.backup_model import BackupJob
from app.models.backup_schedule_model import BackupSchedule

# ── Storage root ──────────────────────────────────────────────────────────────
_HERE = Path(__file__).resolve().parent.parent.parent.parent
PG_BACKUPS_ROOT = _HERE / "backups" / "postgresql"
PG_BACKUPS_ROOT.mkdir(parents=True, exist_ok=True)

# Ensure backup_schedules table exists at import time
try:
    from app.database.connection import engine as _startup_engine
    BackupSchedule.__table__.create(bind=_startup_engine, checkfirst=True)
    print("[PGBackup] backup_schedules table ready.")
except Exception as _e:
    print(f"[PGBackup] table check skipped: {_e}")


# ═════════════════════════════════════════════════════════════════════════════
#  Pydantic schemas
# ═════════════════════════════════════════════════════════════════════════════

class TakeBackupRequest(BaseModel):
    backup_type: str = "logical"
    databases: Optional[List[str]] = None
    dump_format: str = "custom"
    compress: bool = True
    notes: Optional[str] = None
    custom_storage_path: Optional[str] = None

class RestoreRequest(BaseModel):
    job_id: int
    target_db: Optional[str] = None
    create_db: bool = True
    clean: bool = True
    no_owner: bool = True
    confirm: bool = False

class PITRRequest(BaseModel):
    base_job_id: int
    target_datetime: str
    target_action: str = "pause"
    recovery_port: Optional[int] = None
    wal_archive_path: Optional[str] = None
    confirm: bool = False

class ScheduleCreate(BaseModel):
    name: str
    backup_type: str = "logical"
    schedule_type: str = "daily"
    interval_minutes: Optional[int] = 30
    minute: Optional[int] = 0
    hour: Optional[int] = 2
    day_of_week: Optional[str] = "0"
    day_of_month: Optional[int] = 1
    databases: Optional[List[str]] = None
    compress: bool = True
    custom_storage_path: Optional[str] = None
    retain_days: Optional[int] = 7
    notes: Optional[str] = None
    enabled: bool = True

class ScheduleUpdate(ScheduleCreate):
    pass

class ScheduleToggle(BaseModel):
    enabled: bool


# ═════════════════════════════════════════════════════════════════════════════
#  Shared helpers
# ═════════════════════════════════════════════════════════════════════════════

def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, f"Connection {conn_id} not found")
    return rec


def _pg_engine(rec: ConnectionMaster):
    pw  = quote_plus(rec.password or "")
    usr = quote_plus(rec.username or "")
    dbn = rec.database_name or "postgres"
    return create_engine(
        f"postgresql+psycopg2://{usr}:{pw}@{rec.host}:{rec.port or 5432}/{dbn}",
        pool_pre_ping=True,
        connect_args={"connect_timeout": 8},
        pool_size=2, max_overflow=2,
    )


def _rows(engine, sql: str, params=None) -> list:
    with engine.connect() as conn:
        res  = conn.execute(text(sql), params or {})
        cols = list(res.keys())
        return [dict(zip(cols, row)) for row in res.fetchall()]


def _val(engine, sql: str):
    with engine.connect() as conn:
        return conn.execute(text(sql)).scalar()


def _get_ssh(rec: ConnectionMaster):
    db = SessionLocal()
    try:
        srv = db.query(OsServer).filter(OsServer.ip_address == rec.host).first()
        if not srv or not srv.ssh_username:
            return None
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=srv.ip_address,
            port=srv.ssh_port or 22,
            username=srv.ssh_username,
            password=srv.ssh_password or "",
            timeout=15,
        )
        return ssh
    except Exception:
        return None
    finally:
        db.close()


def _ssh_run(ssh, cmd: str, timeout: int = 3600):
    _, out, err = ssh.exec_command(cmd, timeout=timeout)
    exit_code = out.channel.recv_exit_status()
    return out.read(), err.read().decode("utf-8", errors="replace"), exit_code


class _Runner:
    """Unified command / file executor for the DB host.

    Chooses the transport automatically:
      • AGENT  — when the connection is agent-linked (the agent runs the command on
                 the DB host and streams files back over the job channel). This is
                 what makes backups work for localhost connections the server cannot
                 reach over the network.
      • SSH    — when SSH credentials are registered for the host (legacy path).
    `shell()` runs a control command (text output), `getfile()`/`putfile()` move the
    dump. `via` is None when neither transport is available (caller reports cleanly)."""

    def __init__(self, rec: ConnectionMaster, db: Session):
        self.rec = rec
        self.token = None
        self.ssh = None
        try:
            from app.services.common.db_proxy_service import agent_host_for_conn
            row = agent_host_for_conn(rec.id, db)
            self.token = row.token if row else None
        except Exception:
            self.token = None
        if not self.token:
            self.ssh = _get_ssh(rec)
        self.via = "agent" if self.token else ("ssh" if self.ssh else None)

    def shell(self, cmd: str, timeout: int = 900):
        """Return (exit_code, combined_text)."""
        if self.token:
            from app.services.agent import agent_fs_service
            raw = agent_fs_service.request(self.token, "shell", cmd, timeout=timeout)
            if raw is None:
                raise RuntimeError("The agent did not respond in time (shell).")
            txt = raw.decode("utf-8", "replace")
            code = 0
            if txt.startswith("EXIT:"):
                head, _, rest = txt.partition("\n")
                try:
                    code = int(head[5:].strip())
                except Exception:
                    code = 0
                txt = rest
            return code, txt
        if self.ssh:
            out, err, code = _ssh_run(self.ssh, cmd, timeout)
            body = (out.decode("utf-8", "replace") if isinstance(out, bytes) else str(out))
            if err:
                body += "\n" + err
            return code, body
        raise RuntimeError("No execution path: connection is not agent-linked and has no SSH credentials.")

    def getfile(self, remote_path: str, timeout: int = 900) -> bytes:
        if self.token:
            from app.services.agent import agent_fs_service
            raw = agent_fs_service.request(self.token, "getfile", remote_path, timeout=timeout)
            if raw is None:
                raise RuntimeError("The agent did not respond in time (getfile).")
            return raw
        if self.ssh:
            sftp = self.ssh.open_sftp()
            try:
                with sftp.open(remote_path, "rb") as f:
                    return f.read()
            finally:
                sftp.close()
        raise RuntimeError("No execution path for getfile.")

    def putfile(self, remote_path: str, data: bytes, timeout: int = 900):
        if self.token:
            from app.services.agent import agent_fs_service
            b64 = base64.b64encode(data).decode()
            raw = agent_fs_service.request(self.token, "putfile", remote_path, data=b64, timeout=timeout)
            if raw is None:
                raise RuntimeError("The agent did not respond in time (putfile).")
            return
        if self.ssh:
            sftp = self.ssh.open_sftp()
            try:
                with sftp.open(remote_path, "wb") as f:
                    f.write(data)
            finally:
                sftp.close()
            return
        raise RuntimeError("No execution path for putfile.")

    def close(self):
        try:
            if self.ssh:
                self.ssh.close()
        except Exception:
            pass


def _backup_dir(conn_id: int) -> Path:
    d = PG_BACKUPS_ROOT / f"conn_{conn_id}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fmt_bytes(b: int) -> str:
    if b >= 1_073_741_824: return f"{b/1_073_741_824:.2f} GB"
    if b >= 1_048_576:     return f"{b/1_048_576:.2f} MB"
    if b >= 1_024:         return f"{b/1_024:.2f} KB"
    return f"{b} B"


def _job_dict(j: BackupJob) -> dict:
    dur = None
    if j.backup_start and j.backup_end:
        dur = int((j.backup_end - j.backup_start).total_seconds())
    return {
        "id":            j.id,
        "uuid":          j.uuid,
        "connection_id": j.connection_id,
        "db_host":       j.db_host,
        "db_name":       j.db_name,
        "backup_type":   j.backup_type,
        "compress":      j.compress,
        "status":        j.status,
        "size_bytes":    j.size_bytes or 0,
        "size_human":    _fmt_bytes(j.size_bytes or 0),
        "file_path":     j.file_path,
        "wal_file":      j.binlog_file,
        "start_lsn":     j.binlog_pos,
        "backup_start":  j.backup_start.isoformat() if j.backup_start else None,
        "backup_end":    j.backup_end.isoformat()   if j.backup_end   else None,
        "duration_sec":  dur,
        "error_msg":     j.error_msg,
        "notes":         j.notes,
        "created_at":    j.created_at.isoformat()   if j.created_at   else None,
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Background workers
# ═════════════════════════════════════════════════════════════════════════════

def _do_pg_logical(job_id: int, conn_id: int, custom_path: Optional[str]):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not job or not rec:
            return

        job.status = "running"; job.backup_start = datetime.utcnow(); db.commit()

        try:
            eng = _pg_engine(rec)
            job.binlog_file = str(_val(eng, "SELECT pg_walfile_name(pg_current_wal_lsn())") or "")
            db.commit()
        except Exception:
            pass

        runner = _Runner(rec, db)
        if not runner.via:
            job.status = "failed"
            job.error_msg = ("No execution path — this connection is not agent-linked and has no "
                             "SSH credentials. Install the agent on the DB host, or add SSH creds.")
            job.backup_end = datetime.utcnow(); db.commit(); return

        pw   = (rec.password or "").replace("'", "'\\''")
        port = rec.port or 5432
        user = rec.username or "postgres"
        dbn  = job.db_name
        ext  = "sql.gz" if dbn == "ALL" else "dump"
        # Write the dump to a temp file ON THE DB HOST, then stream it back — this works
        # identically over the agent channel and over SSH (no binary-over-text issues).
        remote = f"/tmp/actmon_pgdump_{job.uuid}.{ext}"
        errf   = f"/tmp/actmon_pgdump_{job.uuid}.err"
        if dbn == "ALL":
            cmd = (f"PGPASSWORD='{pw}' pg_dumpall -h 127.0.0.1 -p {port} -U '{user}' "
                   f"--clean --if-exists 2>'{errf}' | gzip > '{remote}'")
        else:
            cmd = (f"PGPASSWORD='{pw}' pg_dump -h 127.0.0.1 -p {port} -U '{user}' "
                   f"-Fc --no-password -f '{remote}' '{dbn}' 2>'{errf}'")

        try:
            rc, _out = runner.shell(cmd, timeout=1800)
            data = b""
            if rc == 0:
                try:
                    data = runner.getfile(remote, timeout=1800)
                except Exception:
                    data = b""
            if rc != 0 or len(data) < 50:
                _, err_txt = runner.shell(f"cat '{errf}' 2>/dev/null || true")
                job.status = "failed"
                job.error_msg = (err_txt.strip() or _out.strip() or "pg_dump produced no output")[:2000]
                job.backup_end = datetime.utcnow(); db.commit()
                runner.shell(f"rm -f '{remote}' '{errf}'"); return

            bdir = Path(custom_path) if custom_path else _backup_dir(conn_id)
            bdir.mkdir(parents=True, exist_ok=True)
            ts    = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            fpath = bdir / f"{job.uuid}_logical_{ts}.{ext}"
            fpath.write_bytes(data)
            runner.shell(f"rm -f '{remote}' '{errf}'")

            job.status     = "completed"
            job.file_path  = str(fpath)
            job.size_bytes = fpath.stat().st_size
            job.backup_end = datetime.utcnow(); db.commit()
        finally:
            runner.close()

    except Exception as exc:
        try:
            j = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if j:
                j.status = "failed"; j.error_msg = str(exc); j.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_pg_basebackup(job_id: int, conn_id: int, custom_path: Optional[str]):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not job or not rec:
            return

        job.status = "running"; job.backup_start = datetime.utcnow(); db.commit()

        try:
            eng = _pg_engine(rec)
            job.binlog_file = str(_val(eng, "SELECT pg_walfile_name(pg_current_wal_lsn())") or "")
            db.commit()
        except Exception:
            pass

        runner = _Runner(rec, db)
        if not runner.via:
            job.status = "failed"
            job.error_msg = ("No execution path — this connection is not agent-linked and has no "
                             "SSH credentials. Install the agent on the DB host, or add SSH creds.")
            job.backup_end = datetime.utcnow(); db.commit(); return

        pw   = (rec.password or "").replace("'", "'\\''")
        port = rec.port or 5432
        user = rec.username or "postgres"
        tmp  = f"/tmp/actmon_pgbase_{job.uuid}"
        errf = f"/tmp/actmon_pgbase_{job.uuid}.err"

        cmd = (
            f"PGPASSWORD='{pw}' pg_basebackup -h 127.0.0.1 -p {port} -U '{user}' "
            f"-D '{tmp}' -Ft -z --wal-method=stream --checkpoint=fast -P "
            f"2>'{errf}' && echo __PGBASE_OK__"
        )
        rc, out_text = runner.shell(cmd, timeout=3600)

        if rc != 0 or "__PGBASE_OK__" not in out_text:
            _, err_txt = runner.shell(f"tail -60 '{errf}' 2>/dev/null || true")
            job.status = "failed"; job.error_msg = (err_txt.strip() or "pg_basebackup failed")[:2000]
            job.backup_end = datetime.utcnow(); db.commit()
            runner.shell(f"rm -rf '{tmp}' '{errf}'"); runner.close(); return

        ts       = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        tmp_arch = f"/tmp/actmon_pgbase_{job.uuid}_{ts}.tar.gz"
        tar_rc, _ = runner.shell(f"tar czf '{tmp_arch}' -C '{tmp}' . 2>&1", timeout=1200)

        if tar_rc != 0:
            job.status = "failed"; job.error_msg = "Could not pack basebackup"
            job.backup_end = datetime.utcnow(); db.commit()
            runner.shell(f"rm -rf '{tmp}' '{tmp_arch}' '{errf}'"); runner.close(); return

        bdir  = Path(custom_path) if custom_path else _backup_dir(conn_id)
        bdir.mkdir(parents=True, exist_ok=True)
        fpath = bdir / f"{job.uuid}_basebackup_{ts}.tar.gz"
        fpath.write_bytes(runner.getfile(tmp_arch, timeout=1800))
        runner.shell(f"rm -rf '{tmp}' '{tmp_arch}' '{errf}'")

        try:
            with tarfile.open(str(fpath), "r:gz") as tar:
                lf = tar.extractfile("backup_label")
                if lf:
                    for line in lf.read().decode("utf-8", errors="replace").splitlines():
                        if "START WAL LOCATION" in line:
                            parts = line.split()
                            if len(parts) >= 6:
                                job.binlog_file = parts[5].strip("()")
        except Exception:
            pass

        job.status     = "completed"
        job.file_path  = str(fpath)
        job.size_bytes = fpath.stat().st_size
        job.backup_end = datetime.utcnow(); db.commit(); runner.close()

    except Exception as exc:
        try:
            j = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if j:
                j.status = "failed"; j.error_msg = str(exc); j.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_pg_wal_archive(job_id: int, conn_id: int, custom_path: Optional[str]):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not job or not rec:
            return

        job.status = "running"; job.backup_start = datetime.utcnow(); db.commit()

        runner = _Runner(rec, db)
        if not runner.via:
            job.status = "failed"
            job.error_msg = ("No execution path — this connection is not agent-linked and has no "
                             "SSH credentials. Install the agent on the DB host, or add SSH creds.")
            job.backup_end = datetime.utcnow(); db.commit(); return

        try:
            eng = _pg_engine(rec)
            _val(eng, "SELECT pg_switch_wal()")
        except Exception:
            pass

        pw   = (rec.password or "").replace("'", "'\\''")
        port = rec.port or 5432
        user = rec.username or "postgres"

        _, dd_out = runner.shell(
            f"PGPASSWORD='{pw}' psql -h 127.0.0.1 -p {port} -U '{user}' "
            f"-t -c \"SHOW data_directory\" postgres 2>/dev/null | xargs echo", timeout=30)
        data_dir = (dd_out or "").strip()
        wal_dir  = f"{data_dir}/pg_wal" if data_dir else "/var/lib/postgresql/data/pg_wal"

        _, ls_out = runner.shell(f"ls '{wal_dir}' 2>/dev/null | grep -E '^[0-9A-F]{{24}}$'")
        wal_files = [f.strip() for f in (ls_out or "").splitlines() if f.strip()]

        if not wal_files:
            job.status = "failed"
            job.error_msg = f"No WAL segments found in {wal_dir}. Ensure wal_level >= replica."
            job.backup_end = datetime.utcnow(); db.commit(); runner.close(); return

        cap = min(len(wal_files), 64)
        ts  = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        tmp_arch  = f"/tmp/actmon_pgwal_{job.uuid}_{ts}.tar.gz"
        file_list = " ".join(f"'{f}'" for f in wal_files[:cap])
        tar_rc, _ = runner.shell(f"cd '{wal_dir}' && tar czf '{tmp_arch}' {file_list} 2>&1", timeout=1200)

        if tar_rc != 0:
            job.status = "failed"; job.error_msg = "Failed to archive WAL segments"
            job.backup_end = datetime.utcnow(); db.commit()
            runner.shell(f"rm -f '{tmp_arch}'"); runner.close(); return

        bdir  = Path(custom_path) if custom_path else _backup_dir(conn_id)
        bdir.mkdir(parents=True, exist_ok=True)
        fpath = bdir / f"{job.uuid}_wal_{ts}.tar.gz"
        fpath.write_bytes(runner.getfile(tmp_arch, timeout=1800))
        runner.shell(f"rm -f '{tmp_arch}'")

        job.status      = "completed"
        job.file_path   = str(fpath)
        job.size_bytes  = fpath.stat().st_size
        job.binlog_file = wal_files[-1]
        job.notes       = f"{cap}/{len(wal_files)} WAL segments archived"
        job.backup_end  = datetime.utcnow(); db.commit(); runner.close()

    except Exception as exc:
        try:
            j = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if j:
                j.status = "failed"; j.error_msg = str(exc); j.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_pg_restore(job_id: int, restore_job_id: int, conn_id: int,
                   target_db: Optional[str], create_db: bool, clean: bool, no_owner: bool):
    db = SessionLocal()
    try:
        rm  = db.query(BackupJob).filter(BackupJob.id == restore_job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not rm or not rec:
            return

        rm.status = "running"; rm.backup_start = datetime.utcnow(); db.commit()

        src = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        if not src or not src.file_path or not Path(src.file_path).exists():
            rm.status = "failed"; rm.error_msg = "Source backup file not found"
            rm.backup_end = datetime.utcnow(); db.commit(); return

        runner = _Runner(rec, db)
        if not runner.via:
            rm.status = "failed"
            rm.error_msg = ("No execution path — this connection is not agent-linked and has no "
                            "SSH credentials. Install the agent on the DB host, or add SSH creds.")
            rm.backup_end = datetime.utcnow(); db.commit(); return

        src_path   = Path(src.file_path)
        pw         = (rec.password or "").replace("'", "'\\''")
        port       = rec.port or 5432
        user       = rec.username or "postgres"
        t_db       = target_db or src.db_name or "restored_db"
        tmp_remote = f"/tmp/actmon_pgrestore_{rm.uuid}{src_path.suffix}"

        try:
            # Upload the dump to the DB host (agent putfile or SSH sftp).
            runner.putfile(tmp_remote, src_path.read_bytes(), timeout=1800)

            if create_db:
                runner.shell(
                    f"PGPASSWORD='{pw}' psql -h 127.0.0.1 -p {port} -U '{user}' postgres "
                    f"-c \"SELECT 1 FROM pg_database WHERE datname='{t_db}'\" -t | "
                    f"grep -q 1 || PGPASSWORD='{pw}' psql -h 127.0.0.1 -p {port} "
                    f"-U '{user}' postgres -c \"CREATE DATABASE \\\"{t_db}\\\"\" 2>&1", timeout=60)

            if src_path.suffix == ".gz":
                cmd = (f"PGPASSWORD='{pw}' zcat '{tmp_remote}' | "
                       f"psql -h 127.0.0.1 -p {port} -U '{user}' '{t_db}' 2>&1")
            else:
                flags = ""
                if clean:    flags += " --clean --if-exists"
                if no_owner: flags += " --no-owner --no-privileges"
                cmd = (f"PGPASSWORD='{pw}' pg_restore -h 127.0.0.1 -p {port} -U '{user}' "
                       f"-d '{t_db}' -Fc{flags} --single-transaction '{tmp_remote}' 2>&1")

            rc, out_text = runner.shell(cmd, timeout=1800)
            runner.shell(f"rm -f '{tmp_remote}'")

            if rc != 0 and "ERROR" in (out_text or "").upper():
                rm.status = "failed"; rm.error_msg = out_text[:2000]
            else:
                rm.status = "completed"
                if out_text.strip():
                    rm.notes = out_text[:500]
            rm.backup_end = datetime.utcnow(); db.commit()
        finally:
            runner.close()

    except Exception as exc:
        try:
            j = db.query(BackupJob).filter(BackupJob.id == restore_job_id).first()
            if j:
                j.status = "failed"; j.error_msg = str(exc); j.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_pg_pitr(pitr_job_id: int, base_job_id: int, conn_id: int,
                target_dt: str, target_action: str,
                recovery_port: Optional[int], wal_archive_path: Optional[str]):
    db = SessionLocal()
    try:
        pj   = db.query(BackupJob).filter(BackupJob.id == pitr_job_id).first()
        base = db.query(BackupJob).filter(BackupJob.id == base_job_id).first()
        rec  = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not pj or not base or not rec:
            return

        pj.status = "running"; pj.backup_start = datetime.utcnow()
        pj.notes  = f"PITR to {target_dt}"; db.commit()

        if not base.file_path or not Path(base.file_path).exists():
            pj.status = "failed"; pj.error_msg = "Base backup file not found on disk"
            pj.backup_end = datetime.utcnow(); db.commit(); return

        runner = _Runner(rec, db)
        if not runner.via:
            pj.status = "failed"
            pj.error_msg = ("No execution path — this connection is not agent-linked and has no "
                            "SSH credentials. Install the agent on the DB host, or add SSH creds.")
            pj.backup_end = datetime.utcnow(); db.commit(); return

        pw    = (rec.password or "").replace("'", "'\\''")
        port  = rec.port or 5432
        rport = recovery_port or (port + 1)
        user  = rec.username or "postgres"
        rdir  = f"/tmp/actmon_pgpitr_{pj.uuid}"
        arch  = f"/tmp/actmon_pgpitr_base_{pj.uuid}.tar.gz"

        try:
            pj.notes = "Step 1/4: Uploading base backup…"; db.commit()
            runner.putfile(arch, Path(base.file_path).read_bytes(), timeout=1800)

            pj.notes = "Step 2/4: Extracting base backup…"; db.commit()
            runner.shell(f"rm -rf '{rdir}' && mkdir -p '{rdir}'")
            tar_rc, _ = runner.shell(f"tar xzf '{arch}' -C '{rdir}' 2>&1", timeout=1200)
            runner.shell(f"rm -f '{arch}'")

            if tar_rc != 0:
                pj.status = "failed"; pj.error_msg = "Failed to extract base backup"
                pj.backup_end = datetime.utcnow(); db.commit()
                runner.shell(f"rm -rf '{rdir}'"); runner.close(); return

            pj.notes = "Step 3/4: Writing recovery configuration…"; db.commit()

            try:
                eng = _pg_engine(rec)
                pg_ver_num = int(str(_val(eng, "SHOW server_version_num") or "120000").strip())
            except Exception:
                pg_ver_num = 120000

            wal_restore_src = wal_archive_path or f"{rdir}/pg_wal"
            restore_cmd_str = f"cp '{wal_restore_src}/%f' '%p' 2>/dev/null"

            if pg_ver_num >= 120000:
                auto_conf = (
                    f"recovery_target_time = '{target_dt}'\n"
                    f"recovery_target_action = '{target_action}'\n"
                    f"restore_command = '{restore_cmd_str}'\n"
                    f"port = {rport}\n"
                )
                runner.shell(f"cat >> '{rdir}/postgresql.auto.conf' << 'ACTMON_CONF'\n{auto_conf}\nACTMON_CONF")
                runner.shell(f"touch '{rdir}/recovery.signal'")
                runner.shell(f"rm -f '{rdir}/standby.signal'")
            else:
                rec_conf = (
                    f"restore_command = '{restore_cmd_str}'\n"
                    f"recovery_target_time = '{target_dt}'\n"
                    f"recovery_target_action = '{target_action}'\n"
                    f"recovery_target_inclusive = true\n"
                )
                runner.shell(f"cat > '{rdir}/recovery.conf' << 'ACTMON_CONF'\n{rec_conf}\nACTMON_CONF")

            runner.shell(f"chown -R postgres:postgres '{rdir}' 2>/dev/null; chmod 700 '{rdir}'")

            pj.notes = f"Step 4/4: Starting recovery instance on port {rport}…"; db.commit()

            _, pg_ctl_raw = runner.shell("which pg_ctl 2>/dev/null || find /usr/lib/postgresql -name pg_ctl 2>/dev/null | head -1")
            pg_ctl  = (pg_ctl_raw or "").strip() or "pg_ctl"
            log     = f"/tmp/actmon_pgpitr_{pj.uuid}.log"
            start_cmd = f"sudo -u postgres {pg_ctl} -D '{rdir}' -l '{log}' start 2>&1"
            start_rc, start_txt = runner.shell(start_cmd, timeout=180)

            if start_rc != 0 and "already running" not in (start_txt or "").lower():
                pj.status    = "failed"
                pj.error_msg = f"Could not start recovery instance: {start_txt[:800]}"
                pj.backup_end = datetime.utcnow(); db.commit(); runner.close(); return

            pj.status = "completed"
            pj.notes  = (
                f"Recovery instance started on port {rport}. "
                f"Target: {target_dt} ({target_action}). "
                f"Data dir: {rdir}. Recovery log: {log}. "
                f"Connect with: psql -p {rport} -U {user} postgres"
            )
            pj.backup_end = datetime.utcnow(); db.commit(); runner.close()
        finally:
            runner.close()

    except Exception as exc:
        try:
            j = db.query(BackupJob).filter(BackupJob.id == pitr_job_id).first()
            if j:
                j.status = "failed"; j.error_msg = str(exc); j.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ═════════════════════════════════════════════════════════════════════════════
#  Schedule helpers
# ═════════════════════════════════════════════════════════════════════════════

def _calc_next_run(s: BackupSchedule, after: datetime = None) -> datetime:
    now = after or datetime.utcnow()
    st, h, m = s.schedule_type or "daily", s.hour or 0, s.minute or 0
    if st == "every_x_minutes":
        return now + timedelta(minutes=max(1, s.interval_minutes or 30))
    if st == "hourly":
        c = now.replace(second=0, microsecond=0, minute=m)
        return c if c > now else c + timedelta(hours=1)
    if st == "daily":
        c = now.replace(second=0, microsecond=0, hour=h, minute=m)
        return c if c > now else c + timedelta(days=1)
    if st == "weekly":
        wanted = {int(d.strip()) for d in (s.day_of_week or "0").split(",") if d.strip().isdigit()}
        c = now.replace(second=0, microsecond=0, hour=h, minute=m)
        for _ in range(8):
            if c > now and c.weekday() in wanted:
                return c
            c += timedelta(days=1)
        return c
    if st == "monthly":
        dom = s.day_of_month or 1
        try:
            c = now.replace(second=0, microsecond=0, hour=h, minute=m, day=dom)
        except ValueError:
            c = now.replace(second=0, microsecond=0, hour=h, minute=m, day=28)
        if c > now:
            return c
        mo = now.month % 12 + 1; yr = now.year + (1 if now.month == 12 else 0)
        try:
            return c.replace(year=yr, month=mo)
        except ValueError:
            return c.replace(year=yr, month=mo, day=28)
    return now + timedelta(days=1)


def _to_12h(h: int, m: int) -> str:
    per = "AM" if h < 12 else "PM"
    h12 = 12 if h in (0, 12) else (h % 12)
    return f"{h12}:{m:02d} {per}"


def _human_sched(s: BackupSchedule) -> str:
    st = s.schedule_type or "daily"
    t  = _to_12h(s.hour or 0, s.minute or 0)
    if st == "every_x_minutes":
        n = s.interval_minutes or 30
        return f"Every {n} min" if n < 60 else f"Every {n//60} hr"
    if st == "hourly":  return f"Every hour at :{(s.minute or 0):02d}"
    if st == "daily":   return f"Daily at {t}"
    if st == "weekly":
        dm = {0:"Mon",1:"Tue",2:"Wed",3:"Thu",4:"Fri",5:"Sat",6:"Sun"}
        days = ", ".join(dm.get(int(d.strip()), d) for d in (s.day_of_week or "0").split(",") if d.strip().isdigit())
        return f"Weekly {days} at {t}"
    if st == "monthly":
        dom = s.day_of_month or 1
        sfx = "st" if dom==1 else "nd" if dom==2 else "rd" if dom==3 else "th"
        return f"Monthly {dom}{sfx} at {t}"
    return st


def _sched_dict(s: BackupSchedule) -> dict:
    dbs = None
    if s.databases:
        try:   dbs = json.loads(s.databases)
        except: dbs = [s.databases]
    return {
        "id": s.id, "conn_id": s.conn_id, "name": s.name,
        "backup_type": s.backup_type, "schedule_type": s.schedule_type,
        "interval_minutes": s.interval_minutes, "minute": s.minute, "hour": s.hour,
        "day_of_week": s.day_of_week, "day_of_month": s.day_of_month,
        "databases": dbs, "compress": s.compress,
        "custom_storage_path": s.custom_storage_path, "retain_days": s.retain_days,
        "notes": s.notes, "enabled": s.enabled,
        "created_at":  s.created_at.isoformat()  if s.created_at  else None,
        "updated_at":  s.updated_at.isoformat()  if s.updated_at  else None,
        "last_run_at": s.last_run_at.isoformat() if s.last_run_at else None,
        "next_run_at": s.next_run_at.isoformat() if s.next_run_at else None,
        "last_job_id": s.last_job_id, "last_status": s.last_status,
        "human_schedule": _human_sched(s),
    }


def _apply_sched(sched: BackupSchedule, req: ScheduleCreate):
    sched.name = req.name; sched.backup_type = req.backup_type
    sched.schedule_type = req.schedule_type; sched.interval_minutes = req.interval_minutes
    sched.minute = req.minute; sched.hour = req.hour
    sched.day_of_week = req.day_of_week; sched.day_of_month = req.day_of_month
    sched.databases = json.dumps(req.databases) if req.databases else None
    sched.compress = req.compress; sched.custom_storage_path = req.custom_storage_path
    sched.retain_days = req.retain_days; sched.notes = req.notes; sched.enabled = req.enabled
    sched.next_run_at = _calc_next_run(sched) if req.enabled else None
    sched.updated_at  = datetime.utcnow()


# ── Scheduler thread ──────────────────────────────────────────────────────────
_pg_sched_started = False
_pg_sched_lock    = threading.Lock()


def _run_scheduled_job(sched_id: int, conn_id: int, backup_type: str,
                        databases_json: Optional[str], compress: bool,
                        custom_path: Optional[str], notes: Optional[str]):
    db = SessionLocal()
    job = None
    try:
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
        if not rec:
            return
        dbs = None
        if databases_json:
            try: dbs = json.loads(databases_json)
            except: pass
        db_name = "ALL" if not dbs else (dbs[0] if len(dbs) == 1 else ",".join(dbs))
        job = BackupJob(
            uuid=str(uuid.uuid4()), connection_id=conn_id,
            db_host=rec.host, db_port=rec.port or 5432, db_name=db_name,
            backup_type=backup_type, status="pending",
            compress="gz" if compress else "none",
            notes=f"[PGSched#{sched_id}] {notes or ''}".strip(),
            backup_start=datetime.utcnow(),
        )
        db.add(job); db.commit(); db.refresh(job)
        sched = db.query(BackupSchedule).filter(BackupSchedule.id == sched_id).first()
        if sched:
            sched.last_job_id = job.id; sched.last_status = "running"; db.commit()
    finally:
        db.close()

    if not job:
        return
    cpath = custom_path.strip() if custom_path and custom_path.strip() else None
    if backup_type == "logical":      _do_pg_logical(job.id, conn_id, cpath)
    elif backup_type == "basebackup": _do_pg_basebackup(job.id, conn_id, cpath)
    elif backup_type == "wal":        _do_pg_wal_archive(job.id, conn_id, cpath)

    db2 = SessionLocal()
    try:
        fj = db2.query(BackupJob).filter(BackupJob.id == job.id).first()
        s2 = db2.query(BackupSchedule).filter(BackupSchedule.id == sched_id).first()
        if fj and s2:
            s2.last_status = fj.status; db2.commit()
    finally:
        db2.close()


def _pg_tick():
    now = datetime.utcnow(); db = SessionLocal()
    try:
        pg_ids = [
            r.id for r in db.query(ConnectionMaster)
            .filter(ConnectionMaster.db_type.ilike("%postgres%")).all()
        ]
        if not pg_ids:
            return
        due = (db.query(BackupSchedule)
               .filter(BackupSchedule.enabled == True,
                       BackupSchedule.conn_id.in_(pg_ids),
                       BackupSchedule.next_run_at <= now)
               .all())
        for s in due:
            s.last_run_at = now; s.next_run_at = _calc_next_run(s, after=now); db.commit()
            threading.Thread(
                target=_run_scheduled_job,
                args=(s.id, s.conn_id, s.backup_type, s.databases, s.compress, s.custom_storage_path, s.notes),
                daemon=True,
            ).start()
    finally:
        db.close()


def start_pg_scheduler():
    global _pg_sched_started
    with _pg_sched_lock:
        if _pg_sched_started:
            return
        _pg_sched_started = True

    def _worker():
        while True:
            threading.Event().wait(30)
            try: _pg_tick()
            except Exception as e: print(f"[PGScheduler] tick error: {e}")

    threading.Thread(target=_worker, daemon=True).start()
    print("[PGScheduler] Background scheduler started.")


# ═════════════════════════════════════════════════════════════════════════════
#  Service functions (called by route handlers)
# ═════════════════════════════════════════════════════════════════════════════

def svc_backup_summary(conn_id: int, db: Session):
    rec = _get_conn(conn_id, db)
    wal_info, archiver, repl_slots, pg_version = {}, {}, [], "unknown"
    try:
        eng = _pg_engine(rec)
        wal_info = (_rows(eng, """
            SELECT pg_current_wal_lsn()::text AS current_lsn,
                   pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file,
                   pg_current_wal_insert_lsn()::text AS insert_lsn,
                   pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0'::pg_lsn)::bigint AS lsn_bytes,
                   current_setting('wal_level') AS wal_level,
                   current_setting('archive_mode') AS archive_mode,
                   current_setting('archive_command') AS archive_command,
                   current_setting('max_wal_senders') AS max_wal_senders,
                   current_setting('wal_keep_size',true) AS wal_keep_size,
                   current_setting('checkpoint_completion_target') AS checkpoint_target
        """) or [{}])[0]
        archiver = (_rows(eng, """
            SELECT archived_count, last_archived_wal, last_archived_time::text,
                   failed_count, last_failed_wal, last_failed_time::text, stats_reset::text
            FROM pg_stat_archiver
        """) or [{}])[0]
        repl_slots = _rows(eng, """
            SELECT slot_name, plugin, slot_type, active,
                   restart_lsn::text, confirmed_flush_lsn::text,
                   pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::bigint AS retained_bytes
            FROM pg_replication_slots
        """)
        pg_version = str(_val(eng, "SELECT version()") or "")
    except Exception as e:
        wal_info = {"error": str(e)}

    jobs      = db.query(BackupJob).filter(BackupJob.connection_id == conn_id).order_by(BackupJob.created_at.desc()).all()
    completed = [j for j in jobs if j.status == "completed"]
    total_sz  = sum(j.size_bytes or 0 for j in completed)
    by_type   = {}
    for j in completed:
        by_type[j.backup_type] = by_type.get(j.backup_type, 0) + 1

    return {
        "status":       "success",
        "pg_version":   pg_version,
        "wal":          {str(k): str(v) if v is not None else None for k, v in (wal_info or {}).items()},
        "archiver":     {str(k): str(v) if v is not None else None for k, v in (archiver or {}).items()},
        "repl_slots":   repl_slots,
        "storage_dir":  str(_backup_dir(conn_id)),
        "backup_stats": {
            "total_jobs":  len(jobs),
            "completed":   len(completed),
            "total_size":  total_sz,
            "size_human":  _fmt_bytes(total_sz),
            "last_backup": _job_dict(completed[0]) if completed else None,
            "by_type":     by_type,
        },
    }


def svc_list_schedules(conn_id: int, db: Session):
    try:
        rows = db.query(BackupSchedule).filter(BackupSchedule.conn_id == conn_id).order_by(BackupSchedule.id.desc()).all()
        return {"status": "success", "data": [_sched_dict(r) for r in rows]}
    except Exception as exc:
        try:
            BackupSchedule.__table__.create(bind=_startup_engine, checkfirst=True)
        except Exception:
            pass
        return {"status": "error", "error": str(exc), "data": []}


def svc_create_schedule(conn_id: int, req: ScheduleCreate, db: Session):
    _get_conn(conn_id, db)
    try:
        s = BackupSchedule(conn_id=conn_id, created_at=datetime.utcnow())
        _apply_sched(s, req)
        db.add(s); db.commit(); db.refresh(s)
        return {"status": "success", "data": _sched_dict(s)}
    except Exception as exc:
        db.rollback()
        raise HTTPException(500, f"Create failed: {exc}")


def svc_get_schedule(conn_id: int, sid: int, db: Session):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    return {"status": "success", "data": _sched_dict(s)}


def svc_update_schedule(conn_id: int, sid: int, req: ScheduleUpdate, db: Session):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    _apply_sched(s, req); db.commit(); db.refresh(s)
    return {"status": "success", "data": _sched_dict(s)}


def svc_delete_schedule(conn_id: int, sid: int, db: Session):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    db.delete(s); db.commit()
    return {"status": "success"}


def svc_toggle_schedule(conn_id: int, sid: int, req: ScheduleToggle, db: Session):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    s.enabled     = req.enabled
    s.next_run_at = _calc_next_run(s) if req.enabled else None
    s.updated_at  = datetime.utcnow()
    db.commit(); db.refresh(s)
    return {"status": "success", "data": _sched_dict(s)}


def svc_run_schedule_now(conn_id: int, sid: int, db: Session):
    s = db.query(BackupSchedule).filter(BackupSchedule.id == sid, BackupSchedule.conn_id == conn_id).first()
    if not s:
        raise HTTPException(404, "Schedule not found")
    cpath = s.custom_storage_path.strip() if s.custom_storage_path else None
    threading.Thread(
        target=_run_scheduled_job,
        args=(s.id, s.conn_id, s.backup_type, s.databases, s.compress, cpath, s.notes),
        daemon=True,
    ).start()
    return {"status": "success", "message": "Backup triggered"}


def svc_list_backups(conn_id: int, db: Session):
    _get_conn(conn_id, db)
    jobs = db.query(BackupJob).filter(BackupJob.connection_id == conn_id).order_by(BackupJob.created_at.desc()).all()
    return {"status": "success", "data": [_job_dict(j) for j in jobs]}


def svc_take_backup(conn_id: int, req: TakeBackupRequest, background_tasks: BackgroundTasks, db: Session):
    rec = _get_conn(conn_id, db)
    if req.backup_type not in ("logical", "basebackup", "wal"):
        raise HTTPException(400, "backup_type must be logical | basebackup | wal")

    db_name = "ALL"
    if req.databases and len(req.databases) == 1:
        db_name = req.databases[0]
    elif req.databases:
        db_name = ",".join(req.databases)

    job = BackupJob(
        uuid=str(uuid.uuid4()), connection_id=conn_id,
        db_host=rec.host, db_port=rec.port or 5432,
        db_name=db_name, backup_type=req.backup_type,
        compress="gz" if req.compress else "none",
        status="pending", notes=req.notes or "",
    )
    db.add(job); db.commit(); db.refresh(job)

    cpath = req.custom_storage_path.strip() if req.custom_storage_path and req.custom_storage_path.strip() else None
    if req.backup_type == "logical":
        background_tasks.add_task(_do_pg_logical, job.id, conn_id, cpath)
    elif req.backup_type == "basebackup":
        background_tasks.add_task(_do_pg_basebackup, job.id, conn_id, cpath)
    elif req.backup_type == "wal":
        background_tasks.add_task(_do_pg_wal_archive, job.id, conn_id, cpath)

    return {"status": "success", "message": f"{req.backup_type} backup started", "job": _job_dict(job)}


def svc_get_backup(conn_id: int, job_id: int, db: Session):
    j = db.query(BackupJob).filter(BackupJob.id == job_id, BackupJob.connection_id == conn_id).first()
    if not j:
        raise HTTPException(404, "Backup job not found")
    return {"status": "success", "data": _job_dict(j)}


def svc_delete_backup(conn_id: int, job_id: int, db: Session):
    j = db.query(BackupJob).filter(BackupJob.id == job_id, BackupJob.connection_id == conn_id).first()
    if not j:
        raise HTTPException(404, "Backup job not found")
    if j.status == "running":
        raise HTTPException(409, "Cannot delete a running backup")
    if j.file_path:
        p = Path(j.file_path)
        if p.exists():
            shutil.rmtree(str(p), ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
    db.delete(j); db.commit()
    return {"status": "success", "message": "Deleted"}


def svc_restore(conn_id: int, req: RestoreRequest, background_tasks: BackgroundTasks, db: Session):
    if not req.confirm:
        raise HTTPException(400, "Set confirm=true to proceed")
    rec     = _get_conn(conn_id, db)
    src_job = db.query(BackupJob).filter(BackupJob.id == req.job_id, BackupJob.connection_id == conn_id).first()
    if not src_job:
        raise HTTPException(404, "Source backup not found")
    if src_job.status != "completed":
        raise HTTPException(400, "Source backup is not completed")
    if src_job.backup_type not in ("logical",):
        raise HTTPException(400, "pg_restore only supports logical (pg_dump) backups")

    rm = BackupJob(
        uuid=str(uuid.uuid4()), connection_id=conn_id,
        db_host=rec.host, db_port=rec.port or 5432,
        db_name=req.target_db or src_job.db_name,
        backup_type="restore", compress="none", status="pending",
        notes=f"Restore from job #{src_job.id}",
    )
    db.add(rm); db.commit(); db.refresh(rm)
    background_tasks.add_task(
        _do_pg_restore, src_job.id, rm.id, conn_id,
        req.target_db, req.create_db, req.clean, req.no_owner,
    )
    return {"status": "success", "message": "Restore started", "job": _job_dict(rm)}


def svc_pitr(conn_id: int, req: PITRRequest, background_tasks: BackgroundTasks, db: Session):
    if not req.confirm:
        raise HTTPException(400, "Set confirm=true. PITR starts a new PostgreSQL instance on an alternate port.")
    _get_conn(conn_id, db)
    base_job = db.query(BackupJob).filter(BackupJob.id == req.base_job_id, BackupJob.connection_id == conn_id).first()
    if not base_job:
        raise HTTPException(404, "Base backup job not found")
    if base_job.backup_type != "basebackup":
        raise HTTPException(400, "PITR requires a basebackup job")
    if base_job.status != "completed":
        raise HTTPException(400, "Base backup is not completed")

    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    pj = BackupJob(
        uuid=str(uuid.uuid4()), connection_id=conn_id,
        db_host=rec.host, db_port=req.recovery_port or (rec.port or 5432) + 1,
        db_name="ALL", backup_type="pitr", compress="none", status="pending",
        notes=f"PITR to {req.target_datetime} from job #{base_job.id}",
    )
    db.add(pj); db.commit(); db.refresh(pj)
    background_tasks.add_task(
        _do_pg_pitr, pj.id, base_job.id, conn_id,
        req.target_datetime, req.target_action,
        req.recovery_port, req.wal_archive_path,
    )
    return {"status": "success", "message": "PITR started", "job": _job_dict(pj)}


def svc_pitr_preview(conn_id: int, db: Session):
    _get_conn(conn_id, db)
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    base_jobs = (db.query(BackupJob)
                 .filter(BackupJob.connection_id == conn_id,
                         BackupJob.backup_type == "basebackup",
                         BackupJob.status == "completed")
                 .order_by(BackupJob.created_at.desc()).all())
    wal_info = {}
    try:
        eng = _pg_engine(rec)
        wal_info = (_rows(eng, """
            SELECT pg_current_wal_lsn()::text AS current_lsn,
                   pg_walfile_name(pg_current_wal_lsn()) AS current_wal,
                   (SELECT last_archived_wal FROM pg_stat_archiver) AS last_archived_wal,
                   (SELECT last_archived_time::text FROM pg_stat_archiver) AS last_archived_time,
                   current_setting('wal_level') AS wal_level,
                   current_setting('archive_mode') AS archive_mode
        """) or [{}])[0]
    except Exception as e:
        wal_info = {"error": str(e)}

    return {
        "status":       "success",
        "wal_info":     {str(k): str(v) if v is not None else None for k, v in wal_info.items()},
        "base_backups": [_job_dict(j) for j in base_jobs],
        "pitr_capable": len(base_jobs) > 0 and wal_info.get("wal_level") not in ("minimal", None),
        "note": (
            "WAL-based PITR requires: wal_level >= replica, a completed basebackup, "
            "and WAL segments available on the server. "
            "PITR starts a recovery instance on an alternate port — it does NOT overwrite production."
        ),
    }


def svc_wal_status(conn_id: int, db: Session):
    rec = _get_conn(conn_id, db)
    try:
        eng = _pg_engine(rec)
        wal = (_rows(eng, """
            SELECT pg_current_wal_lsn()::text AS current_lsn,
                   pg_current_wal_insert_lsn()::text AS insert_lsn,
                   pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file,
                   pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0'::pg_lsn)::bigint AS total_wal_bytes,
                   current_setting('wal_level') AS wal_level,
                   current_setting('wal_compression',true) AS wal_compression,
                   current_setting('full_page_writes') AS full_page_writes,
                   current_setting('wal_buffers') AS wal_buffers,
                   current_setting('min_wal_size') AS min_wal_size,
                   current_setting('max_wal_size') AS max_wal_size,
                   current_setting('archive_mode') AS archive_mode,
                   current_setting('archive_command') AS archive_command,
                   current_setting('archive_timeout') AS archive_timeout,
                   current_setting('synchronous_commit') AS synchronous_commit,
                   current_setting('checkpoint_timeout') AS checkpoint_timeout,
                   current_setting('checkpoint_completion_target') AS checkpoint_completion_target
        """) or [{}])[0]
        archiver = (_rows(eng, """
            SELECT archived_count, last_archived_wal,
                   last_archived_time::text AS last_archived_time,
                   failed_count, last_failed_wal,
                   last_failed_time::text AS last_failed_time,
                   stats_reset::text AS stats_reset
            FROM pg_stat_archiver
        """) or [{}])[0]
        checkpoints = (_rows(eng, """
            SELECT checkpoints_timed, checkpoints_req,
                   checkpoint_write_time::bigint, checkpoint_sync_time::bigint,
                   buffers_checkpoint, buffers_clean, buffers_backend,
                   stats_reset::text AS stats_reset
            FROM pg_stat_bgwriter
        """) or [{}])[0]
        replication = _rows(eng, """
            SELECT client_addr::text, state, sent_lsn::text,
                   write_lsn::text, flush_lsn::text, replay_lsn::text,
                   sync_state, application_name
            FROM pg_stat_replication
        """)
        slots = _rows(eng, """
            SELECT slot_name, plugin, slot_type, active,
                   restart_lsn::text, confirmed_flush_lsn::text,
                   pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn)::bigint AS retained_bytes
            FROM pg_replication_slots
        """)
        return {
            "status":      "success",
            "wal":         {str(k): str(v) if v is not None else None for k, v in wal.items()},
            "archiver":    {str(k): str(v) if v is not None else None for k, v in archiver.items()},
            "checkpoints": {str(k): str(v) if v is not None else None for k, v in checkpoints.items()},
            "replication": replication,
            "slots":       slots,
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def svc_wal_segments(conn_id: int, db: Session):
    rec = _get_conn(conn_id, db)
    runner = _Runner(rec, db)
    if not runner.via:
        return {"status": "error", "error": "No execution path (agent or SSH) for this host", "segments": []}

    pw   = (rec.password or "").replace("'", "'\\''")
    port = rec.port or 5432
    user = rec.username or "postgres"

    try:
        _, dd_out = runner.shell(
            f"PGPASSWORD='{pw}' psql -h 127.0.0.1 -p {port} -U '{user}' postgres "
            f"-t -c \"SHOW data_directory\" 2>/dev/null | xargs echo", timeout=30)
        data_dir = (dd_out or "").strip()
        wal_dir  = f"{data_dir}/pg_wal" if data_dir else "/var/lib/postgresql/data/pg_wal"

        _, ls_out = runner.shell(
            f"ls -lh '{wal_dir}' 2>/dev/null | grep -E '[0-9A-F]{{24}}' | awk '{{print $5\" \"$9}}'")
    finally:
        runner.close()

    segments = []
    for line in (ls_out or "").splitlines():
        parts = line.strip().split()
        if len(parts) == 2:
            segments.append({"size": parts[0], "name": parts[1]})

    return {"status": "success", "wal_dir": wal_dir, "count": len(segments), "segments": segments}
