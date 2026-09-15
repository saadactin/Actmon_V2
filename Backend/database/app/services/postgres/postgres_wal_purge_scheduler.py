"""
Purge WAL Archive — OS-level scheduler-entry management + watchdog.

The cron entry / Windows Scheduled Task this module installs does NOT run
pg_archivecleanup itself. Its only job is one credential-free HTTP callback
into ActMon (see postgres_wal_purge_service.svc_wal_purge_trigger) — ActMon
then re-computes the safety boundary fresh and dispatches the actual cleanup
through the agent's `shell` op at that exact moment. This is what lets the
boundary be recomputed on every single fire while nothing but a random,
independently-revocable trigger token (never a DB password) ever touches the
host's crontab / Task Scheduler, where `crontab -l` / `schtasks /Query /V`
would otherwise expose it.

Same job-dispatch mechanism this whole app already uses for any host-side
command (see db_diagnose_service.py's `_agent_shell`/`_ps_encoded`) — nothing
new about HOW a command reaches the host, only WHAT command gets installed.
"""
import base64
import logging
import threading
from datetime import datetime, timedelta

from app.services.agent import agent_fs_service
from app.services.common.db_proxy_service import agent_host_for_conn

log = logging.getLogger("wal_purge_scheduler")

_WATCHDOG_TICK_SECONDS = 60
_STUCK_RUN_HOURS = 2
_LIVENESS_RECHECK_HOURS = 6


# ── command/transport helpers (same envelope every agent shell caller uses) ──

def _agent_shell(token: str, cmd: str, timeout: int = 30):
    """Returns (exit_code, text) or (None, None) if the agent didn't answer."""
    raw = agent_fs_service.request(token, "shell", cmd, timeout=timeout)
    if raw is None:
        return None, None
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


def _ps_encoded(script: str) -> str:
    # $ProgressPreference must be set before anything else runs: PowerShell's
    # own module-autoload progress stream ("Preparing modules for first use")
    # otherwise serializes to CLIXML straight onto the process's real stderr
    # the instant there's no attached console — which is exactly how the
    # agent invokes this (`cmd /c ... | stderr=PIPE`). That's unrelated to
    # anything the wrapped script itself does or catches, so every caller
    # was seeing this noise regardless of whether their own command failed.
    wrapped = "$ProgressPreference = 'SilentlyContinue'\n" + script
    b = base64.b64encode(wrapped.encode("utf-16-le")).decode()
    return "powershell -NoProfile -NonInteractive -EncodedCommand " + b


def _bash_encoded(script: str) -> str:
    """Base64-wrap a multi-line bash script so it survives the agent's
    `bash -c <cmd>` invocation with zero quoting risk, mirroring the
    PowerShell -EncodedCommand pattern for the Linux side."""
    b = base64.b64encode(script.encode("utf-8")).decode()
    return f"echo {b} | base64 -d | bash"


def _is_windows(os_type: str) -> bool:
    return "win" in (os_type or "").lower()


def _entry_name(schedule_id: int) -> str:
    return f"ActMonWalPurge_{schedule_id}"


def _cron_marker(schedule_id: int) -> str:
    return f"# actmon-wal-purge-{schedule_id}"


def _resolve_agent(conn_id: int, db):
    row = agent_host_for_conn(conn_id, db)
    if not row or not row.token:
        return None
    return row


# ── frequency → concrete scheduler command ───────────────────────────────────

def _cron_schedule_fields(cfg) -> str:
    m, h = int(cfg.minute), int(cfg.hour)
    if cfg.frequency == "weekly":
        dow = max(0, min(6, int(cfg.day_of_week or 0)))
        return f"{m} {h} * * {dow}"
    if cfg.frequency == "monthly":
        dom = max(1, min(28, int(cfg.day_of_month or 1)))
        return f"{m} {h} {dom} * *"
    return f"{m} {h} * * *"   # daily


_DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]


def _schtasks_schedule_args(cfg) -> str:
    st = f"{int(cfg.hour):02d}:{int(cfg.minute):02d}"
    if cfg.frequency == "weekly":
        dow = _DOW_NAMES[max(0, min(6, int(cfg.day_of_week or 0)))]
        return f"/SC WEEKLY /D {dow} /ST {st}"
    if cfg.frequency == "monthly":
        dom = max(1, min(28, int(cfg.day_of_month or 1)))
        return f"/SC MONTHLY /D {dom} /ST {st}"
    return f"/SC DAILY /ST {st}"


# ── install / remove / verify ────────────────────────────────────────────────

def install_schedule(conn_id: int, cfg, plain_token: str, base_url: str, db) -> dict:
    """Writes the on-host token file + the OS scheduler entry. Returns
    {"scheduler_type","entry_name","installed_command" (token-free),
     "verified"}. Raises RuntimeError with a clear message on any failure —
    callers turn that into a 502/409 as appropriate."""
    agent = _resolve_agent(conn_id, db)
    if not agent:
        raise RuntimeError("This connection has no linked ActMon agent host — cannot install a schedule.")

    entry = _entry_name(cfg.id)
    payload = '{"schedule_id":%d,"token":"%s"}' % (cfg.id, plain_token)
    trigger_url = base_url.rstrip("/") + "/api/v1/connections/postgresql/wal-purge/trigger"

    if _is_windows(agent.os_type):
        # The token lives ONLY in this script file's content, protected by the
        # icacls lock-down below (SYSTEM + Administrators, read-only) — never
        # in the Scheduled Task's own arguments (which `schtasks /Query /V`
        # would print) and never in a machine-wide environment variable
        # (which is broadly readable by any authenticated user on the box).
        script_dir = r"C:\ProgramData\ActMon\wal-purge"
        script_path = f"{script_dir}\\trigger-{cfg.id}.ps1"
        write_script = (
            f"$d = '{script_dir}'\n"
            "New-Item -ItemType Directory -Force -Path $d | Out-Null\n"
            f"$body = '{payload}'\n"
            f"$content = @\"\n"
            "`$ErrorActionPreference='Stop'\n"
            "try {\n"
            f"  Invoke-RestMethod -Method Post -TimeoutSec 30 -Uri '{trigger_url}' "
            "-ContentType 'application/json' -Body '$body' | Out-Null\n"
            "} catch { }\n"
            "\"@\n"
            f"Set-Content -LiteralPath '{script_path}' -Encoding UTF8 -Value $content\n"
            f"icacls '{script_path}' /inheritance:r /grant:r 'SYSTEM:(R)' 'BUILTIN\\Administrators:(R)' | Out-Null\n"
            f"schtasks /Create /F /TN {entry} {_schtasks_schedule_args(cfg)} /RU SYSTEM /RL HIGHEST "
            f"/TR \"powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File {script_path}\"\n"
        )
        code, out = _agent_shell(agent.token, _ps_encoded(write_script), timeout=60)
        if code is None:
            raise RuntimeError("The agent did not respond while installing the scheduled task.")
        if code != 0:
            raise RuntimeError(f"Could not install the Windows Scheduled Task (exit {code}): {(out or '').strip()[:400]}")
        installed_command = (
            f'schtasks /Create /F /TN {entry} {_schtasks_schedule_args(cfg)} /RU SYSTEM /RL HIGHEST '
            f'/TR "powershell ... -File {script_path}"'
        )
        return {"scheduler_type": "schtasks", "entry_name": entry, "installed_command": installed_command}

    # Linux/Unix
    token_file = f"/etc/actmon/wal-purge-{cfg.id}.json"
    cron_field = _cron_schedule_fields(cfg)
    marker = _cron_marker(cfg.id)
    write_script = (
        "umask 077\n"
        "mkdir -p /etc/actmon\n"
        f"cat > {token_file} <<'ACTMON_EOF'\n{payload}\nACTMON_EOF\n"
        f"chmod 600 {token_file}\n"
        f"( crontab -l 2>/dev/null | grep -vF '{marker}' ; "
        f"echo '{cron_field} curl -fsS -m 30 -X POST -H \"Content-Type: application/json\" "
        f"--data-binary @{token_file} {trigger_url} >/dev/null 2>&1 {marker}' ) | crontab -\n"
    )
    code, out = _agent_shell(agent.token, _bash_encoded(write_script), timeout=60)
    if code is None:
        raise RuntimeError("The agent did not respond while installing the cron entry.")
    if code != 0:
        raise RuntimeError(f"Could not install the cron entry (exit {code}): {(out or '').strip()[:400]}")
    installed_command = (
        f"{cron_field} curl -fsS -m 30 -X POST --data-binary @{token_file} {trigger_url} "
        f">/dev/null 2>&1 {marker}"
    )
    return {"scheduler_type": "cron", "entry_name": marker, "installed_command": installed_command}


def remove_schedule(conn_id: int, cfg, db) -> dict:
    """Best-effort removal — tolerates an unreachable agent. Returns
    {"entry_removed": bool, "warning": str|None}."""
    agent = _resolve_agent(conn_id, db)
    if not agent:
        return {"entry_removed": False, "warning": "No agent linked to this connection — nothing to remove on the host."}

    if _is_windows(agent.os_type):
        entry = cfg.scheduler_entry_name or _entry_name(cfg.id)
        script_dir = r"C:\ProgramData\ActMon\wal-purge"
        script = (
            f"schtasks /Delete /F /TN {entry} 2>$null | Out-Null\n"
            f"Remove-Item -Force '{script_dir}\\trigger-{cfg.id}.ps1' -ErrorAction SilentlyContinue\n"
        )
        code, _ = _agent_shell(agent.token, _ps_encoded(script), timeout=30)
    else:
        marker = cfg.scheduler_entry_name or _cron_marker(cfg.id)
        token_file = f"/etc/actmon/wal-purge-{cfg.id}.json"
        script = (
            f"( crontab -l 2>/dev/null | grep -vF '{marker}' ) | crontab -\n"
            f"rm -f {token_file}\n"
        )
        code, _ = _agent_shell(agent.token, _bash_encoded(script), timeout=30)

    if code is None:
        return {"entry_removed": False,
                "warning": "Could not reach the host to remove the scheduler entry; the trigger token "
                           "has been revoked so any leftover entry is inert."}
    return {"entry_removed": code == 0, "warning": None if code == 0 else f"Removal command exited {code}."}


def verify_schedule(conn_id: int, cfg, db) -> bool | None:
    """Cheap presence check. Returns True/False, or None if the agent didn't
    answer (caller should leave schedule_present unchanged, not flip it to
    False on a transient timeout)."""
    agent = _resolve_agent(conn_id, db)
    if not agent:
        return None
    if _is_windows(agent.os_type):
        entry = cfg.scheduler_entry_name or _entry_name(cfg.id)
        code, _ = _agent_shell(agent.token, f'schtasks /Query /TN {entry}', timeout=30)
    else:
        marker = cfg.scheduler_entry_name or _cron_marker(cfg.id)
        code, out = _agent_shell(agent.token, f"crontab -l 2>/dev/null | grep -cF '{marker}'", timeout=30)
        if code is not None:
            try:
                return int((out or "0").strip().splitlines()[-1] or "0") > 0
            except Exception:
                return False
    if code is None:
        return None
    return code == 0


# ── next_run_at math — ported from postgres_report_email_service._next_run,
#    daily/weekly/monthly only (the three frequencies this feature supports) ──

def next_run(cfg, now: datetime | None = None) -> datetime:
    now = now or datetime.utcnow()

    if cfg.frequency == "weekly":
        dow = int(cfg.day_of_week or 0)
        days_ahead = (dow - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(
            hour=int(cfg.hour or 2), minute=int(cfg.minute or 30), second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(weeks=1)
        return candidate

    if cfg.frequency == "monthly":
        dom = max(1, min(28, int(cfg.day_of_month or 1)))
        try:
            candidate = now.replace(day=dom, hour=int(cfg.hour or 2), minute=int(cfg.minute or 30),
                                    second=0, microsecond=0)
        except ValueError:
            candidate = now.replace(day=28, hour=int(cfg.hour or 2), minute=int(cfg.minute or 30),
                                    second=0, microsecond=0)
        if candidate <= now:
            candidate = candidate.replace(month=now.month + 1) if now.month < 12 else candidate.replace(year=now.year + 1, month=1)
        return candidate

    candidate = now.replace(hour=int(cfg.hour or 2), minute=int(cfg.minute or 30), second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


# ── watchdog: detects fires that never arrive, checks entry liveness,
#    reaps runs orphaned by a backend restart. NEVER purges anything itself. ──

_wd_lock = threading.Lock()
_wd_thread = None
_wd_stop = threading.Event()


def _watchdog_tick():
    from app.database.connection import SessionLocal
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig, PostgresWalPurgeHistory
    from app.models.admin_models import AuditLog

    with SessionLocal() as session:
        now = datetime.utcnow()

        # 1) Missed-run detection.
        due = session.query(PostgresWalPurgeConfig).filter(
            PostgresWalPurgeConfig.enabled == True,
            PostgresWalPurgeConfig.next_run_at.isnot(None),
        ).all()
        for cfg in due:
            grace = timedelta(minutes=int(cfg.missed_grace_minutes or 15))
            if now <= cfg.next_run_at + grace:
                continue
            already = session.query(PostgresWalPurgeHistory).filter(
                PostgresWalPurgeHistory.conn_id == cfg.conn_id,
                PostgresWalPurgeHistory.started_at >= cfg.next_run_at,
            ).first()
            if already:
                cfg.next_run_at = next_run(cfg, now)
                session.commit()
                continue
            try:
                msg = (f"Scheduled purge did not fire — the host scheduler entry did not reach ActMon, "
                       f"or the host/network was unreachable around {cfg.next_run_at.isoformat()} UTC.")
                session.add(PostgresWalPurgeHistory(
                    org_id=cfg.org_id, conn_id=cfg.conn_id, config_id=cfg.id,
                    run_type="scheduled", trigger_source="watchdog", status="missed",
                    started_at=cfg.next_run_at, finished_at=now, error_message=msg,
                ))
                cfg.last_run_at = cfg.next_run_at
                cfg.last_status = "missed"
                cfg.last_error = msg
                cfg.next_run_at = next_run(cfg, now)
                session.add(AuditLog(org_id=cfg.org_id, user_id=None, table_name="postgres_wal_purge",
                                      record_id=cfg.conn_id, action_type="wal_purge_missed",
                                      new_data={"schedule_id": cfg.id, "expected_at": cfg.next_run_at.isoformat()}))
                session.commit()
            except Exception as exc:  # noqa: BLE001
                log.error("wal_purge watchdog: missed-run handling failed for config %s: %s", cfg.id, exc)
                session.rollback()

        # 2) Scheduler-entry liveness (cheap presence check, not too often).
        stale_cutoff = now - timedelta(hours=_LIVENESS_RECHECK_HOURS)
        to_check = session.query(PostgresWalPurgeConfig).filter(
            PostgresWalPurgeConfig.enabled == True,
        ).filter(
            (PostgresWalPurgeConfig.schedule_verified_at.is_(None)) |
            (PostgresWalPurgeConfig.schedule_verified_at < stale_cutoff)
        ).all()
        for cfg in to_check:
            try:
                present = verify_schedule(cfg.conn_id, cfg, session)
                if present is not None:
                    cfg.schedule_present = present
                    cfg.schedule_verified_at = now
                    session.commit()
            except Exception as exc:  # noqa: BLE001
                log.warning("wal_purge watchdog: liveness check failed for config %s: %s", cfg.id, exc)
                session.rollback()

        # 3) Stuck-run reap — a backend restart mid-run orphans the in-memory
        # agent_fs_service waiter permanently; without this the partial unique
        # index would block that connection's purges forever.
        stuck_cutoff = now - timedelta(hours=_STUCK_RUN_HOURS)
        stuck = session.query(PostgresWalPurgeHistory).filter(
            PostgresWalPurgeHistory.status == "running",
            PostgresWalPurgeHistory.started_at < stuck_cutoff,
        ).all()
        for row in stuck:
            try:
                row.status = "failed"
                row.finished_at = now
                row.error_message = "Run did not report a result (the ActMon backend restarted, or the agent never answered)."
                session.commit()
            except Exception as exc:  # noqa: BLE001
                log.error("wal_purge watchdog: could not reap stuck run %s: %s", row.id, exc)
                session.rollback()


def _watchdog_loop():
    while not _wd_stop.is_set():
        try:
            _watchdog_tick()
        except Exception as exc:  # noqa: BLE001
            log.error("wal_purge watchdog tick error: %s", exc)
        _wd_stop.wait(_WATCHDOG_TICK_SECONDS)


def start_wal_purge_watchdog():
    global _wd_thread
    with _wd_lock:
        if _wd_thread and _wd_thread.is_alive():
            return
        _wd_stop.clear()
        _wd_thread = threading.Thread(target=_watchdog_loop, daemon=True, name="postgres_wal_purge_watchdog")
        _wd_thread.start()
        log.info("PostgreSQL WAL purge watchdog started")


def stop_wal_purge_watchdog():
    _wd_stop.set()
