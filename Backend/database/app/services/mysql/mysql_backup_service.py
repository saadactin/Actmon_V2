import gzip
import os
import shutil
import tarfile
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List
from urllib.parse import quote_plus

import paramiko
from fastapi import HTTPException
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import OsServer
from app.models.backup_model import BackupJob

# ── Storage root ──────────────────────────────────────────────────────────────
_HERE        = Path(__file__).resolve().parent.parent.parent.parent  # …/database/
BACKUPS_ROOT = _HERE / "backups"
BACKUPS_ROOT.mkdir(exist_ok=True)


# ── DB / engine helpers ───────────────────────────────────────────────────────

def _get_conn(conn_id: int, db: Session) -> ConnectionMaster:
    rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not rec:
        raise HTTPException(404, f"Connection {conn_id} not found")
    return rec


def _make_mysql_engine(rec: ConnectionMaster):
    pw  = quote_plus(rec.password or "")
    usr = quote_plus(rec.username or "")
    url = (
        f"mysql+pymysql://{usr}:{pw}"
        f"@{rec.host}:{rec.port or 3306}/{rec.database_name or ''}"
    )
    from app.services.common import db_proxy_service
    return db_proxy_service.engine_for(rec, lambda: create_engine(
        url,
        connect_args={"connect_timeout": 15, "read_timeout": 30, "write_timeout": 30},
        pool_pre_ping=True,
    ))


def _rows(engine, sql: str, params=None) -> list:
    with engine.connect() as conn:
        res  = conn.execute(text(sql), params or {})
        cols = res.keys()
        return [dict(zip(cols, row)) for row in res.fetchall()]


def _scalar(engine, sql: str):
    with engine.connect() as conn:
        return conn.execute(text(sql)).scalar()


# ── SSH helpers ───────────────────────────────────────────────────────────────

def _get_ssh(rec: ConnectionMaster) -> Optional[paramiko.SSHClient]:
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


def _ssh_run(ssh: paramiko.SSHClient, cmd: str, timeout: int = 600):
    _, out, err = ssh.exec_command(cmd, timeout=timeout)
    exit_code = out.channel.recv_exit_status()
    return out.read(), err.read().decode("utf-8", errors="replace"), exit_code


# ── Misc helpers ──────────────────────────────────────────────────────────────

def _backup_dir(conn_id: int) -> Path:
    d = BACKUPS_ROOT / f"conn_{conn_id}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _fmt_bytes(b: int) -> str:
    if b >= 1_073_741_824: return f"{b / 1_073_741_824:.2f} GB"
    if b >= 1_048_576:     return f"{b / 1_048_576:.2f} MB"
    if b >= 1_024:         return f"{b / 1_024:.2f} KB"
    return f"{b} B"


def _job_to_dict(j: BackupJob) -> dict:
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
        "binlog_file":   j.binlog_file,
        "binlog_pos":    j.binlog_pos,
        "backup_start":  j.backup_start.isoformat() if j.backup_start else None,
        "backup_end":    j.backup_end.isoformat()   if j.backup_end   else None,
        "error_msg":     j.error_msg,
        "notes":         j.notes,
        "created_at":    j.created_at.isoformat()   if j.created_at   else None,
        "duration_sec":  (
            int((j.backup_end - j.backup_start).total_seconds())
            if j.backup_start and j.backup_end else None
        ),
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Background workers
# ═════════════════════════════════════════════════════════════════════════════

def _do_logical_backup(job_id: int, rec_id: int, custom_path: str = None):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == rec_id).first()
        if not job or not rec:
            return

        job.status       = "running"
        job.backup_start = datetime.utcnow()
        db.commit()

        ssh = _get_ssh(rec)
        if not ssh:
            job.status    = "failed"
            job.error_msg = "SSH connection unavailable — check OS Server SSH credentials"
            job.backup_end = datetime.utcnow()
            db.commit()
            return

        db_flag = "--all-databases" if job.db_name == "ALL" else f"--databases {job.db_name}"
        port    = rec.port or 3306
        pw_esc  = (rec.password or "").replace("'", "'\\''")

        cmd = (
            f"mysqldump -h 127.0.0.1 -P {port} -u '{rec.username}' -p'{pw_esc}' "
            f"--single-transaction --flush-logs --master-data=2 "
            f"--routines --triggers --events "
            f"{db_flag} 2>/tmp/actmon_dump_err.txt | gzip"
        )

        out_bytes, err_str, exit_code = _ssh_run(ssh, cmd, timeout=3600)

        if exit_code != 0 or len(out_bytes) < 100:
            _, err_out, _ = _ssh_run(ssh, "cat /tmp/actmon_dump_err.txt 2>/dev/null")
            job.status    = "failed"
            job.error_msg = err_out.decode("utf-8", errors="replace") or err_str or "mysqldump failed"
            job.backup_end = datetime.utcnow()
            db.commit()
            ssh.close()
            return

        bdir  = Path(custom_path) if custom_path else _backup_dir(rec_id)
        bdir.mkdir(parents=True, exist_ok=True)
        fname = f"{job.uuid}_logical_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.sql.gz"
        fpath = bdir / fname
        fpath.write_bytes(out_bytes)

        try:
            first_chunk = gzip.decompress(out_bytes[:65536]).decode("utf-8", errors="replace")
            for line in first_chunk.splitlines():
                if "MASTER_LOG_FILE=" in line:
                    parts = line.strip().rstrip(";").split(",")
                    for p in parts:
                        if "MASTER_LOG_FILE=" in p:
                            job.binlog_file = p.split("=")[1].strip().strip("'")
                        if "MASTER_LOG_POS=" in p:
                            job.binlog_pos = int(p.split("=")[1].strip())
                    break
        except Exception:
            pass

        job.status     = "completed"
        job.file_path  = str(fpath)
        job.size_bytes = fpath.stat().st_size
        job.backup_end = datetime.utcnow()
        db.commit()
        ssh.close()

    except Exception as exc:
        try:
            job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if job:
                job.status     = "failed"
                job.error_msg  = str(exc)
                job.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_physical_backup(job_id: int, rec_id: int, custom_path: str = None):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == rec_id).first()
        if not job or not rec:
            return

        job.status       = "running"
        job.backup_start = datetime.utcnow()
        db.commit()

        ssh = _get_ssh(rec)
        if not ssh:
            job.status     = "failed"
            job.error_msg  = "SSH connection unavailable"
            job.backup_end = datetime.utcnow()
            db.commit()
            return

        port   = rec.port or 3306
        pw_esc = (rec.password or "").replace("'", "'\\''")

        check_cmd = "mariabackup --version 2>/dev/null && echo mariabackup || (xtrabackup --version 2>/dev/null && echo xtrabackup || echo none)"
        _, tool_out, _ = _ssh_run(ssh, check_cmd)
        tool_name = "mariabackup" if "mariabackup" in tool_out else ("xtrabackup" if "xtrabackup" in tool_out else None)

        if not tool_name:
            job.status     = "failed"
            job.error_msg  = "Neither mariabackup nor xtrabackup found on the server. Install with: apt install mariadb-backup"
            job.backup_end = datetime.utcnow()
            db.commit()
            ssh.close()
            return

        tmp_dir    = f"/tmp/actmon_phys_{job.uuid}"
        backup_cmd = (
            f"{tool_name} --backup --target-dir={tmp_dir} "
            f"--host=127.0.0.1 --port={port} "
            f"--user='{rec.username}' --password='{pw_esc}' "
            f"--stream=xbstream 2>/tmp/actmon_phys_err.txt | gzip"
        )

        out_bytes, err_str, exit_code = _ssh_run(ssh, backup_cmd, timeout=3600)

        if exit_code != 0 or len(out_bytes) < 512:
            _, err_out, _ = _ssh_run(ssh, "tail -50 /tmp/actmon_phys_err.txt 2>/dev/null")
            job.status     = "failed"
            job.error_msg  = err_out.decode("utf-8", errors="replace") or err_str or f"{tool_name} backup failed"
            job.backup_end = datetime.utcnow()
            db.commit()
            ssh.close()
            return

        bdir  = Path(custom_path) if custom_path else _backup_dir(rec_id)
        bdir.mkdir(parents=True, exist_ok=True)
        fname = f"{job.uuid}_physical_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.xbstream.gz"
        fpath = bdir / fname
        fpath.write_bytes(out_bytes)

        _, bl_out, _ = _ssh_run(ssh, f"cat {tmp_dir}/xtrabackup_binlog_info 2>/dev/null || echo ''")
        bl_text = bl_out.decode("utf-8", errors="replace").strip()
        if bl_text:
            parts = bl_text.split()
            if len(parts) >= 2:
                job.binlog_file = parts[0]
                try:
                    job.binlog_pos = int(parts[1])
                except Exception:
                    pass

        _ssh_run(ssh, f"rm -rf {tmp_dir} 2>/dev/null")

        job.status     = "completed"
        job.file_path  = str(fpath)
        job.size_bytes = fpath.stat().st_size
        job.backup_end = datetime.utcnow()
        db.commit()
        ssh.close()

    except Exception as exc:
        try:
            job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if job:
                job.status     = "failed"
                job.error_msg  = str(exc)
                job.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_binlog_backup(job_id: int, rec_id: int, custom_path: str = None):
    db = SessionLocal()
    try:
        job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        rec = db.query(ConnectionMaster).filter(ConnectionMaster.id == rec_id).first()
        if not job or not rec:
            return

        job.status       = "running"
        job.backup_start = datetime.utcnow()
        db.commit()

        engine = _make_mysql_engine(rec)

        with engine.connect() as conn:
            conn.execute(text("FLUSH BINARY LOGS"))

        binlogs = _rows(engine, "SHOW BINARY LOGS")
        if not binlogs:
            job.status     = "failed"
            job.error_msg  = "No binary logs found — ensure log_bin is enabled"
            job.backup_end = datetime.utcnow()
            db.commit()
            return

        datadir = ""
        try:
            datadir = _scalar(engine, "SELECT @@datadir") or ""
        except Exception:
            pass

        ssh = _get_ssh(rec)
        if not ssh or not datadir:
            job.status     = "failed"
            job.error_msg  = "SSH unavailable or could not get datadir — cannot download binlog files"
            job.backup_end = datetime.utcnow()
            db.commit()
            return

        bdir   = Path(custom_path) if custom_path else _backup_dir(rec_id)
        bdir.mkdir(parents=True, exist_ok=True)
        outdir = bdir / f"{job.uuid}_binlogs_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}"
        outdir.mkdir(exist_ok=True)

        sftp        = ssh.open_sftp()
        total_bytes = 0
        for bl in binlogs:
            log_name    = bl.get("Log_name") or bl.get("log_name", "")
            remote_path = datadir.rstrip("/") + "/" + log_name
            local_path  = outdir / log_name
            try:
                sftp.get(remote_path, str(local_path))
                total_bytes += local_path.stat().st_size
            except Exception:
                pass
        sftp.close()

        archive = bdir / f"{job.uuid}_binlogs_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.tar.gz"
        with tarfile.open(str(archive), "w:gz") as tar:
            tar.add(str(outdir), arcname="binlogs")
        shutil.rmtree(str(outdir), ignore_errors=True)

        last = binlogs[-1]
        job.binlog_file = last.get("Log_name") or last.get("log_name", "")
        job.status      = "completed"
        job.file_path   = str(archive)
        job.size_bytes  = archive.stat().st_size
        job.backup_end  = datetime.utcnow()
        db.commit()
        ssh.close()

    except Exception as exc:
        try:
            job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
            if job:
                job.status     = "failed"
                job.error_msg  = str(exc)
                job.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_restore_logical(job_id: int, restore_job_id: int, rec_id: int, target_db: Optional[str]):
    db = SessionLocal()
    try:
        restore_marker = db.query(BackupJob).filter(BackupJob.id == restore_job_id).first()
        rec            = db.query(ConnectionMaster).filter(ConnectionMaster.id == rec_id).first()
        if not restore_marker or not rec:
            return

        restore_marker.status       = "running"
        restore_marker.backup_start = datetime.utcnow()
        db.commit()

        src_job = db.query(BackupJob).filter(BackupJob.id == job_id).first()
        if not src_job or not src_job.file_path or not Path(src_job.file_path).exists():
            restore_marker.status     = "failed"
            restore_marker.error_msg  = "Source backup file not found"
            restore_marker.backup_end = datetime.utcnow()
            db.commit()
            return

        ssh = _get_ssh(rec)
        if not ssh:
            restore_marker.status     = "failed"
            restore_marker.error_msg  = "SSH unavailable"
            restore_marker.backup_end = datetime.utcnow()
            db.commit()
            return

        src_path   = Path(src_job.file_path)
        tmp_remote = f"/tmp/actmon_restore_{restore_marker.uuid}.sql.gz"
        sftp = ssh.open_sftp()
        sftp.put(str(src_path), tmp_remote)
        sftp.close()

        port    = rec.port or 3306
        pw_esc  = (rec.password or "").replace("'", "'\\''")
        db_arg  = target_db or ""

        restore_cmd = (
            f"zcat {tmp_remote} | mysql -h 127.0.0.1 -P {port} "
            f"-u '{rec.username}' -p'{pw_esc}' {db_arg} 2>&1"
        )

        _, out, exit_code = _ssh_run(ssh, restore_cmd, timeout=7200)
        out_text = out.decode("utf-8", errors="replace").strip() if isinstance(out, bytes) else str(out)

        _ssh_run(ssh, f"rm -f {tmp_remote}")
        ssh.close()

        if exit_code != 0:
            restore_marker.status    = "failed"
            restore_marker.error_msg = out_text[:2000]
        else:
            restore_marker.status = "completed"
        restore_marker.backup_end = datetime.utcnow()
        db.commit()

    except Exception as exc:
        try:
            rm = db.query(BackupJob).filter(BackupJob.id == restore_job_id).first()
            if rm:
                rm.status     = "failed"
                rm.error_msg  = str(exc)
                rm.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def _do_pitr(pitr_job_id: int, base_job_id: int, rec_id: int,
             target_dt: str, target_db: Optional[str]):
    db = SessionLocal()
    try:
        pitr_job = db.query(BackupJob).filter(BackupJob.id == pitr_job_id).first()
        base_job = db.query(BackupJob).filter(BackupJob.id == base_job_id).first()
        rec      = db.query(ConnectionMaster).filter(ConnectionMaster.id == rec_id).first()
        if not pitr_job or not base_job or not rec:
            return

        pitr_job.status       = "running"
        pitr_job.backup_start = datetime.utcnow()
        pitr_job.notes        = f"PITR to {target_dt}"
        db.commit()

        if not base_job.file_path or not Path(base_job.file_path).exists():
            pitr_job.status     = "failed"
            pitr_job.error_msg  = "Base backup file not found on disk"
            pitr_job.backup_end = datetime.utcnow()
            db.commit()
            return

        ssh = _get_ssh(rec)
        if not ssh:
            pitr_job.status     = "failed"
            pitr_job.error_msg  = "SSH unavailable — cannot perform PITR"
            pitr_job.backup_end = datetime.utcnow()
            db.commit()
            return

        port     = rec.port or 3306
        pw_esc   = (rec.password or "").replace("'", "'\\''")
        db_arg   = target_db or ""
        tmp_dump = f"/tmp/actmon_pitr_base_{pitr_job.uuid}.sql.gz"

        # Step 1: restore base dump
        pitr_job.notes = "Step 1/3: Restoring base logical backup…"
        db.commit()

        sftp = ssh.open_sftp()
        sftp.put(str(base_job.file_path), tmp_dump)
        sftp.close()

        restore_cmd = (
            f"zcat {tmp_dump} | mysql -h 127.0.0.1 -P {port} "
            f"-u '{rec.username}' -p'{pw_esc}' {db_arg} 2>&1"
        )
        _, out, exit_code = _ssh_run(ssh, restore_cmd, timeout=7200)
        if exit_code != 0:
            out_text = out.decode("utf-8", errors="replace") if isinstance(out, bytes) else str(out)
            pitr_job.status     = "failed"
            pitr_job.error_msg  = f"Base restore failed: {out_text[:1000]}"
            pitr_job.backup_end = datetime.utcnow()
            db.commit()
            _ssh_run(ssh, f"rm -f {tmp_dump}")
            ssh.close()
            return

        _ssh_run(ssh, f"rm -f {tmp_dump}")

        # Step 2: find binlogs to apply
        pitr_job.notes = "Step 2/3: Identifying binary logs to apply…"
        db.commit()

        engine  = _make_mysql_engine(rec)
        binlogs = _rows(engine, "SHOW BINARY LOGS")
        datadir = _scalar(engine, "SELECT @@datadir") or ""

        base_bl     = base_job.binlog_file or ""
        apply_logs  = []
        reached     = not bool(base_bl)
        for bl in binlogs:
            log_name = bl.get("Log_name") or bl.get("log_name", "")
            if not reached and log_name == base_bl:
                reached = True
            if reached:
                apply_logs.append(log_name)

        if not apply_logs:
            pitr_job.status     = "completed"
            pitr_job.notes      = f"PITR completed — no binlogs to apply after base backup (binlog: {base_bl})"
            pitr_job.backup_end = datetime.utcnow()
            db.commit()
            ssh.close()
            return

        # Step 3: apply binlogs up to target_dt
        pitr_job.notes = f"Step 3/3: Applying {len(apply_logs)} binlog(s) up to {target_dt}…"
        db.commit()

        log_paths      = " ".join(f"'{datadir.rstrip('/')}/{l}'" for l in apply_logs)
        start_pos_arg  = ""
        if base_job.binlog_pos and apply_logs[0] == base_bl:
            start_pos_arg = f"--start-position={base_job.binlog_pos}"

        db_filter   = f"--database={target_db} " if target_db else ""
        binlog_cmd  = (
            f"mysqlbinlog {start_pos_arg} "
            f"--stop-datetime='{target_dt}' "
            f"{db_filter}"
            f"{log_paths} | "
            f"mysql -h 127.0.0.1 -P {port} -u '{rec.username}' -p'{pw_esc}' 2>&1"
        )
        _, bl_out, bl_exit = _ssh_run(ssh, binlog_cmd, timeout=3600)
        bl_text = bl_out.decode("utf-8", errors="replace") if isinstance(bl_out, bytes) else str(bl_out)

        if bl_exit != 0 and "ERROR" in bl_text.upper():
            pitr_job.status    = "failed"
            pitr_job.error_msg = f"Binlog apply failed: {bl_text[:1000]}"
        else:
            pitr_job.status = "completed"
            pitr_job.notes  = (
                f"PITR completed to {target_dt}. "
                f"Applied {len(apply_logs)} binlog file(s) from {apply_logs[0]}."
            )

        pitr_job.backup_end = datetime.utcnow()
        db.commit()
        ssh.close()

    except Exception as exc:
        try:
            pj = db.query(BackupJob).filter(BackupJob.id == pitr_job_id).first()
            if pj:
                pj.status     = "failed"
                pj.error_msg  = str(exc)
                pj.backup_end = datetime.utcnow()
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ═════════════════════════════════════════════════════════════════════════════
#  Service functions
# ═════════════════════════════════════════════════════════════════════════════

def get_backup_summary(conn_id: int, db: Session) -> dict:
    rec    = _get_conn(conn_id, db)
    engine = _make_mysql_engine(rec)

    binlog_enabled, binlog_basename = False, ""
    try:
        val = _scalar(engine, "SELECT @@log_bin")
        binlog_enabled = str(val).strip().upper() in ("1", "ON")
    except Exception:
        pass
    try:
        binlog_basename = str(_scalar(engine, "SELECT @@log_bin_basename") or "").strip()
    except Exception:
        pass

    master_status, master_error = {}, None
    try:
        rows = _rows(engine, "SHOW MASTER STATUS")
        if rows:
            master_status = rows[0]
    except Exception as e:
        master_error = str(e)

    slave_status = {}
    try:
        try:
            rows = _rows(engine, "SHOW REPLICA STATUS")
        except Exception:
            rows = _rows(engine, "SHOW SLAVE STATUS")
        if rows:
            slave_status = rows[0]
    except Exception:
        pass

    all_jobs  = (db.query(BackupJob)
                 .filter(BackupJob.connection_id == conn_id)
                 .order_by(BackupJob.created_at.desc())
                 .all())
    completed  = [j for j in all_jobs if j.status == "completed"]
    total_size = sum(j.size_bytes or 0 for j in completed)
    last_job   = completed[0] if completed else None
    by_type    = {}
    for j in completed:
        by_type[j.backup_type] = by_type.get(j.backup_type, 0) + 1

    return {
        "status":          "success",
        "binlog_enabled":  binlog_enabled,
        "binlog_basename": binlog_basename,
        "master_error":    master_error,
        "master_status":   {str(k): str(v) for k, v in (master_status.items() if master_status else {}.items())},
        "slave_status":    {str(k): str(v) for k, v in (slave_status.items()  if slave_status  else {}.items())},
        "storage_dir":     str(_backup_dir(conn_id)),
        "backup_stats": {
            "total_jobs":        len(all_jobs),
            "completed_backups": len(completed),
            "total_size_bytes":  total_size,
            "total_size_human":  _fmt_bytes(total_size),
            "last_backup":       _job_to_dict(last_job) if last_job else None,
            "by_type":           by_type,
        },
    }


def list_backups(conn_id: int, db: Session) -> dict:
    _get_conn(conn_id, db)
    jobs = (db.query(BackupJob)
            .filter(BackupJob.connection_id == conn_id)
            .order_by(BackupJob.created_at.desc())
            .all())
    return {"status": "success", "data": [_job_to_dict(j) for j in jobs]}


def get_backup(conn_id: int, job_id: int, db: Session) -> dict:
    job = db.query(BackupJob).filter(
        BackupJob.id == job_id, BackupJob.connection_id == conn_id
    ).first()
    if not job:
        raise HTTPException(404, "Backup job not found")
    return {"status": "success", "data": _job_to_dict(job)}


def create_backup_job(conn_id: int, backup_type: str, databases: Optional[List[str]],
                      compress: bool, notes: Optional[str],
                      custom_path: Optional[str], db: Session) -> BackupJob:
    rec = _get_conn(conn_id, db)
    if backup_type not in ("logical", "physical", "binlog"):
        raise HTTPException(400, "backup_type must be logical | physical | binlog")

    db_name = "ALL"
    if databases and len(databases) == 1:
        db_name = databases[0]
    elif databases and len(databases) > 1:
        db_name = ",".join(databases)

    job = BackupJob(
        uuid          = str(uuid.uuid4()),
        connection_id = conn_id,
        db_host       = rec.host,
        db_port       = rec.port or 3306,
        db_name       = db_name,
        backup_type   = backup_type,
        compress      = "gz" if compress else "none",
        status        = "pending",
        notes         = notes or "",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def delete_backup_job(conn_id: int, job_id: int, db: Session) -> dict:
    job = db.query(BackupJob).filter(
        BackupJob.id == job_id, BackupJob.connection_id == conn_id
    ).first()
    if not job:
        raise HTTPException(404, "Backup job not found")
    if job.status == "running":
        raise HTTPException(409, "Cannot delete a running backup job")
    if job.file_path:
        p = Path(job.file_path)
        if p.exists():
            if p.is_dir():
                shutil.rmtree(str(p), ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
    db.delete(job)
    db.commit()
    return {"status": "success", "message": "Backup job deleted"}


def create_restore_job(conn_id: int, job_id: int, target_db: Optional[str],
                       confirm: bool, db: Session) -> BackupJob:
    if not confirm:
        raise HTTPException(400, "Set confirm=true to acknowledge this will OVERWRITE existing data")
    rec = _get_conn(conn_id, db)
    src_job = db.query(BackupJob).filter(
        BackupJob.id == job_id, BackupJob.connection_id == conn_id
    ).first()
    if not src_job:
        raise HTTPException(404, "Source backup job not found")
    if src_job.backup_type != "logical":
        raise HTTPException(400, "Direct restore is only supported for logical backups. Use PITR for physical.")
    if src_job.status != "completed":
        raise HTTPException(400, "Source backup is not in completed state")

    restore_job = BackupJob(
        uuid          = str(uuid.uuid4()),
        connection_id = conn_id,
        db_host       = rec.host,
        db_port       = rec.port or 3306,
        db_name       = target_db or src_job.db_name,
        backup_type   = "restore",
        status        = "pending",
        notes         = f"Restore from job #{src_job.id} ({src_job.backup_type})",
    )
    db.add(restore_job)
    db.commit()
    db.refresh(restore_job)
    return src_job, restore_job


def create_pitr_job(conn_id: int, base_job_id: int, target_datetime: str,
                    target_db: Optional[str], confirm: bool, db: Session):
    if not confirm:
        raise HTTPException(400, "Set confirm=true to acknowledge PITR will OVERWRITE existing data")
    try:
        datetime.strptime(target_datetime, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise HTTPException(400, "target_datetime must be 'YYYY-MM-DD HH:MM:SS'")

    rec = _get_conn(conn_id, db)
    base_job = db.query(BackupJob).filter(
        BackupJob.id == base_job_id, BackupJob.connection_id == conn_id
    ).first()
    if not base_job:
        raise HTTPException(404, "Base backup job not found")
    if base_job.backup_type != "logical":
        raise HTTPException(400, "PITR base backup must be a logical backup (mysqldump)")
    if base_job.status != "completed":
        raise HTTPException(400, "Base backup is not completed")
    if not base_job.binlog_file:
        raise HTTPException(400, "Base backup has no binlog position — retake the backup with --master-data=2")

    pitr_job = BackupJob(
        uuid          = str(uuid.uuid4()),
        connection_id = conn_id,
        db_host       = rec.host,
        db_port       = rec.port or 3306,
        db_name       = target_db or base_job.db_name,
        backup_type   = "pitr",
        status        = "pending",
        notes         = f"PITR to {target_datetime} from backup #{base_job.id}",
    )
    db.add(pitr_job)
    db.commit()
    db.refresh(pitr_job)
    return base_job, pitr_job


def get_binlog_status(conn_id: int, db: Session) -> dict:
    rec    = _get_conn(conn_id, db)
    engine = _make_mysql_engine(rec)

    binlog_enabled, binlog_basename = False, ""
    try:
        val = _scalar(engine, "SELECT @@log_bin")
        binlog_enabled = str(val).strip().upper() in ("1", "ON")
    except Exception:
        pass
    try:
        binlog_basename = str(_scalar(engine, "SELECT @@log_bin_basename") or "").strip()
    except Exception:
        pass

    master, master_error = {}, None
    try:
        rows = _rows(engine, "SHOW MASTER STATUS")
        if rows:
            master = {str(k): str(v) for k, v in rows[0].items()}
    except Exception as e:
        master_error = (
            str(e) +
            " — Grant REPLICATION CLIENT: GRANT REPLICATION CLIENT ON *.* TO 'user'@'%'; FLUSH PRIVILEGES;"
        )

    slave, is_replica = {}, False
    try:
        try:
            rows = _rows(engine, "SHOW REPLICA STATUS")
        except Exception:
            rows = _rows(engine, "SHOW SLAVE STATUS")
        if rows:
            slave      = {str(k): str(v) for k, v in rows[0].items()}
            is_replica = True
    except Exception:
        pass

    gvars = {}
    try:
        for row in _rows(engine,
                         "SHOW GLOBAL VARIABLES WHERE Variable_name IN "
                         "('log_bin','binlog_format','binlog_row_image','expire_logs_days',"
                         "'binlog_expire_logs_seconds','max_binlog_size','sync_binlog')"):
            gvars[row["Variable_name"]] = row["Value"]
    except Exception:
        pass

    return {
        "status":          "success",
        "binlog_enabled":  binlog_enabled,
        "binlog_basename": binlog_basename,
        "master_error":    master_error,
        "is_replica":      is_replica,
        "master_status":   master,
        "slave_status":    slave,
        "variables":       gvars,
    }


def list_binlogs_data(conn_id: int, db: Session) -> dict:
    rec    = _get_conn(conn_id, db)
    engine = _make_mysql_engine(rec)

    log_bin_on, binlog_basename = False, ""
    try:
        val = _scalar(engine, "SELECT @@log_bin")
        log_bin_on      = str(val).strip().upper() in ("1", "ON")
        binlog_basename = str(_scalar(engine, "SELECT @@log_bin_basename") or "").strip()
    except Exception:
        pass

    if not log_bin_on:
        return {
            "status": "disabled",
            "error": (
                "Binary logging is OFF on this server. "
                "Enable it by adding the following to /etc/mysql/mariadb.conf.d/50-server.cnf:\n"
                "  server_id = 1\n  log_bin = mysql-bin\n  binlog_format = ROW\n  expire_logs_days = 7\n"
                "Then restart: sudo systemctl restart mariadb"
            ),
            "data":             [],
            "binlog_basename":  binlog_basename,
        }

    try:
        rows = _rows(engine, "SHOW BINARY LOGS")
    except Exception as e:
        err  = str(e)
        hint = ""
        if "1381" in err:
            hint = " (Error 1381: binary logging is OFF)"
        elif "1227" in err or "access denied" in err.lower():
            hint = (
                " (Permission denied — grant REPLICATION CLIENT to the MySQL user: "
                "GRANT REPLICATION CLIENT ON *.* TO 'user'@'%'; FLUSH PRIVILEGES;)"
            )
        return {"status": "error", "error": err + hint, "data": []}

    result = []
    for r in rows:
        name      = r.get("Log_name") or r.get("log_name", "")
        size_b    = int(r.get("File_size") or r.get("file_size") or 0)
        encrypted = r.get("Encrypted") or r.get("encrypted") or "No"
        result.append({
            "log_name":  name,
            "file_size": size_b,
            "size_human": _fmt_bytes(size_b),
            "encrypted": str(encrypted),
        })

    return {"status": "success", "data": result, "total": len(result), "binlog_basename": binlog_basename}


def get_binlog_events(conn_id: int, log_name: str, offset: int, limit: int, db: Session) -> dict:
    rec    = _get_conn(conn_id, db)
    engine = _make_mysql_engine(rec)
    try:
        rows = _rows(engine, f"SHOW BINLOG EVENTS IN '{log_name}' LIMIT {offset}, {limit}")
    except Exception as e:
        return {"status": "error", "error": str(e), "data": []}

    events = [
        {
            "log_name":    r.get("Log_name", ""),
            "pos":         r.get("Pos", 0),
            "event_type":  r.get("Event_type", ""),
            "server_id":   r.get("Server_id", ""),
            "end_log_pos": r.get("End_log_pos", 0),
            "info":        str(r.get("Info", ""))[:300],
        }
        for r in rows
    ]
    return {"status": "success", "log_name": log_name, "offset": offset, "data": events}


def get_live_binlog_events(conn_id: int, limit: int, db: Session) -> dict:
    rec    = _get_conn(conn_id, db)
    engine = _make_mysql_engine(rec)

    current_log, current_pos = "", 0
    try:
        rows = _rows(engine, "SHOW MASTER STATUS")
        if rows:
            current_log = rows[0].get("File") or rows[0].get("file", "")
            current_pos = int(rows[0].get("Position") or rows[0].get("position", 0))
    except Exception as e:
        return {"status": "error", "error": str(e), "data": [], "current_log": ""}

    if not current_log:
        return {
            "status": "error",
            "error":  "Binary logging not enabled or SHOW MASTER STATUS returned no data",
            "data":   [], "current_log": "",
        }

    fetch_limit = min(limit * 5, 5000)
    try:
        rows   = _rows(engine, f"SHOW BINLOG EVENTS IN '{current_log}' LIMIT 0, {fetch_limit}")
        events = rows[-limit:] if len(rows) > limit else rows
    except Exception as e:
        return {"status": "error", "error": str(e), "data": [], "current_log": current_log}

    result = []
    for r in events:
        etype = r.get("Event_type", "")
        result.append({
            "log_name":    r.get("Log_name", ""),
            "pos":         r.get("Pos", 0),
            "end_log_pos": r.get("End_log_pos", 0),
            "event_type":  etype,
            "server_id":   r.get("Server_id", ""),
            "info":        str(r.get("Info", ""))[:400],
            "is_write":    etype in ("Write_rows", "Update_rows", "Delete_rows",
                                     "Write_rows_v1", "Update_rows_v1", "Delete_rows_v1", "Query"),
            "is_gtid":     etype in ("Gtid", "Anonymous_Gtid"),
            "is_rotate":   etype == "Rotate",
        })

    return {
        "status":      "success",
        "current_log": current_log,
        "current_pos": current_pos,
        "showing":     len(result),
        "data":        result,
    }


def get_pitr_preview(conn_id: int, base_job_id: int, target_datetime: str, db: Session) -> dict:
    rec      = _get_conn(conn_id, db)
    base_job = db.query(BackupJob).filter(
        BackupJob.id == base_job_id, BackupJob.connection_id == conn_id
    ).first()
    if not base_job:
        raise HTTPException(404, "Base backup not found")

    engine = _make_mysql_engine(rec)
    try:
        binlogs = _rows(engine, "SHOW BINARY LOGS")
    except Exception as e:
        return {"status": "error", "error": str(e)}

    base_bl    = base_job.binlog_file or ""
    apply_logs = []
    reached    = not bool(base_bl)
    for bl in binlogs:
        name = bl.get("Log_name") or bl.get("log_name", "")
        if not reached and name == base_bl:
            reached = True
        if reached:
            size_b = int(bl.get("File_size") or bl.get("file_size") or 0)
            apply_logs.append({"log_name": name, "size_human": _fmt_bytes(size_b)})

    return {
        "status":          "success",
        "base_backup_id":  base_job_id,
        "base_binlog":     base_bl,
        "base_binlog_pos": base_job.binlog_pos,
        "target_datetime": target_datetime,
        "logs_to_apply":   apply_logs,
        "log_count":       len(apply_logs),
        "warning": (
            "PITR will STOP MySQL, restore the base dump, and replay binlogs. "
            "All data after the target_datetime will be LOST."
        ),
    }
