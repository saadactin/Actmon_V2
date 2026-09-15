"""
Purge WAL Archive — business logic.
Route file: app/routes/postgres/postgres_wal_purge_routes.py

Architecture (see postgres_wal_purge_scheduler.py's module docstring for the
full reasoning): the OS-level cron/Task Scheduler entry this feature installs
never runs pg_archivecleanup directly and never carries a DB credential — it
only calls back into ActMon (svc_wal_purge_trigger), which recomputes the
safety boundary fresh and dispatches the actual cleanup through the agent at
that moment. compute_safety() is the SINGLE source of truth for that
boundary; every action below (info/preview/test/execute/trigger) calls it,
none derives a boundary any other way.
"""
import hmac
import logging
import re
import secrets
import threading
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.services.common.credential_encryption_service import credential_encryption
from app.services.common.db_proxy_service import agent_host_for_conn
from app.services.postgres.postgres_monitoring_service import (
    _pg_conn, _rows, _val, svc_pg_replication_detail,
)
from app.services.postgres.postgres_wal_purge_scheduler import (
    _agent_shell, _ps_encoded, _bash_encoded, install_schedule, remove_schedule, verify_schedule, next_run,
)

log = logging.getLogger("wal_purge")

_MAX_ARCHIVE_ENTRIES = 200_000
_MAX_PREVIEW_CANDIDATES = 500
_GUARD_WINDOW_SECONDS = 300
_EXECUTE_TIMEOUT_SECONDS = 900
_TEST_TIMEOUT_SECONDS = 300

_WAL_NAME_RE = re.compile(r"\b([0-9A-Fa-f]{24})\b")
_DANGEROUS_PATH_RE = re.compile(r"[;&|`$<>\n\r]|\$\(")


# ═════════════════════════════════════════════════════════════════════════════
#  Small helpers
# ═════════════════════════════════════════════════════════════════════════════

def _cfg_for(conn_id: int, db: Session):
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig
    return db.query(PostgresWalPurgeConfig).filter(PostgresWalPurgeConfig.conn_id == conn_id).first()


def _require_cfg(conn_id: int, db: Session):
    cfg = _cfg_for(conn_id, db)
    if not cfg or not cfg.archive_dir:
        raise HTTPException(400, "Save a WAL archive path in Purge Configuration first.")
    return cfg


def _safe_archive_dir(path: str, forbidden: list[str] | None = None) -> str:
    """Rejects anything that isn't a plausible, specific archive directory.
    This is the single most safety-critical check in the feature — pointing
    pg_archivecleanup at the live data/WAL directory instead of the archive
    would destroy the cluster, so this runs on every save AND every
    execution, not just once at save time."""
    p = (path or "").strip()
    if not p:
        raise HTTPException(400, "Archive path is required.")
    if len(p) > 500:
        raise HTTPException(400, "Archive path is too long.")
    if _DANGEROUS_PATH_RE.search(p) or ".." in p.replace("\\", "/").split("/"):
        raise HTTPException(400, "Archive path contains characters that are not allowed.")
    stripped = p.rstrip("\\/")
    if stripped in ("", "/", "\\") or re.fullmatch(r"[A-Za-z]:\\?", stripped):
        raise HTTPException(400, "Archive path cannot be a filesystem root.")
    for f in (forbidden or []):
        f_norm = (f or "").rstrip("\\/").lower()
        if f_norm and stripped.lower() == f_norm:
            raise HTTPException(400, "Archive path cannot be the database's own data or WAL directory.")
    return p


def _valid_wal_name(name: str | None) -> bool:
    return bool(name) and bool(re.fullmatch(r"[0-9A-Fa-f]{24}", name))


def _iso_utc(dt) -> str | None:
    """dt.isoformat() alone omits any timezone designator for these naive
    (datetime.utcnow()-sourced) columns — the frontend's Date parser then
    reads the bare string as browser-LOCAL time instead of UTC, silently
    shifting every timestamp on the page by the viewer's UTC offset (e.g.
    showing 5:30 hours early for an IST viewer). Marking it explicitly UTC
    here is what lets the frontend convert it correctly."""
    return (dt.isoformat() + "Z") if dt else None


def _looks_resolved(path: str | None) -> bool:
    """A real, verified executable path always has a directory separator —
    the pre-detection default ('pg_archivecleanup', bare) never does. Used to
    tell an already-saved-but-never-worked value apart from one a DBA or the
    probe actually resolved, so a config saved before path auto-detection
    existed gets silently re-probed instead of permanently stuck on the
    command that's already known to fail."""
    return bool(path) and ("\\" in path or "/" in path)


_ARCHIVE_PATH_RE = re.compile(r"([A-Za-z]:\\[^\"'%]+|/[^\s\"'%]+)")


def _detect_archive_dir(archive_command: str | None) -> str | None:
    """Best-effort extraction of the archive directory straight from
    archive_command (already known via a real query — SHOW archive_command)
    instead of asking the DBA to retype a path ActMon can already see, e.g.
    'copy "%p" "C:\\PGBackup\\WAL\\%f"' or
    'test ! -f /data/.../wal_archive/%f && cp %p /data/.../wal_archive/%f'.
    Takes the LAST path-like token: copy-style commands put the live pg_wal
    source (%p) first and the archive destination last. Still overridable —
    an explicitly saved config always wins over this guess."""
    if not archive_command:
        return None
    matches = _ARCHIVE_PATH_RE.findall(archive_command)
    if not matches:
        return None
    return matches[-1].rstrip("\\/") or None


def _effective_archive_dir(cfg, archive_command: str | None) -> tuple[str | None, bool]:
    """(archive_dir, was_detected). An explicitly saved cfg.archive_dir always
    wins; otherwise auto-detect from archive_command (a value the caller
    already fetched — this used to run its own redundant `SHOW archive_command`
    round trip, doubling agent latency on every load for an agent-routed
    connection) so the feature works before anyone has saved anything."""
    if cfg and cfg.archive_dir:
        return cfg.archive_dir, False
    detected = _detect_archive_dir(archive_command)
    return detected, bool(detected)


def _probe_cleanup_binary(agent, data_directory: str | None) -> str | None:
    """Actually LOCATES pg_archivecleanup on the DB host through the agent —
    checking PATH, the standard Windows installer's sibling bin\\ directory
    (derived from data_directory), and the common install roots — instead of
    just guessing a path and hoping it's right. A bare 'pg_archivecleanup'
    only works if it happens to be on PATH, which it usually isn't on
    Windows, so Test/Execute fail with CommandNotFoundException until this
    resolves to a real, verified file that exists on that exact host."""
    if not agent or not agent.token:
        return None
    windows = "win" in (agent.os_type or "").lower()

    if windows:
        derived = None
        d = (data_directory or "").rstrip("\\/")
        if "\\" in d:
            parent = d.rsplit("\\", 1)[0]
            if parent and parent != d:
                derived = parent + "\\bin\\pg_archivecleanup.exe"
        derived_lit = derived.replace("'", "''") if derived else None
        script = (
            "$found = ''\n"
            "try {\n"
            "  $c = Get-Command pg_archivecleanup.exe -ErrorAction SilentlyContinue\n"
            "  if (-not $c) { $c = Get-Command pg_archivecleanup -ErrorAction SilentlyContinue }\n"
            "  if ($c) { $found = $c.Source }\n"
            "} catch {}\n"
            + (f"if (-not $found -and (Test-Path -LiteralPath '{derived_lit}')) {{ $found = '{derived_lit}' }}\n"
               if derived_lit else "")
            # EDB's Windows installer records the real install location in the
            # registry — the single most reliable source when the data
            # directory has been moved to a different drive/path than the
            # binaries (common on hand-tuned installs), which defeats the
            # sibling-bin-of-data-directory guess above.
            + "if (-not $found) {\n"
            "  try {\n"
            "    $regHit = Get-ItemProperty 'HKLM:\\SOFTWARE\\PostgreSQL\\Installations\\*' -ErrorAction SilentlyContinue |\n"
            "      ForEach-Object { Join-Path $_.'Base Directory' 'bin\\pg_archivecleanup.exe' } |\n"
            "      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1\n"
            "    if ($regHit) { $found = $regHit }\n"
            "  } catch {}\n"
            "}\n"
            + "if (-not $found) {\n"
            "  try {\n"
            "    $hit = Get-ChildItem -Path 'C:\\Program Files\\PostgreSQL','C:\\Program Files (x86)\\PostgreSQL',"
            "'C:\\PostgreSQL','D:\\PostgreSQL','D:\\Program Files\\PostgreSQL' -Filter pg_archivecleanup.exe -Recurse "
            "-ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName\n"
            "    if ($hit) { $found = $hit }\n"
            "  } catch {}\n"
            "}\n"
            "Write-Output $found"
        )
        cmd = _ps_encoded(script)
    else:
        script = (
            'found=""\n'
            'p=$(command -v pg_archivecleanup 2>/dev/null || true)\n'
            'if [ -n "$p" ]; then found="$p"; fi\n'
            'if [ -z "$found" ]; then\n'
            '  for d in /usr/lib/postgresql/*/bin /usr/pgsql-*/bin /opt/postgresql/*/bin; do\n'
            '    if [ -x "$d/pg_archivecleanup" ]; then found="$d/pg_archivecleanup"; break; fi\n'
            '  done\n'
            'fi\n'
            'echo "$found"'
        )
        cmd = _bash_encoded(script)

    code, out = _agent_shell(agent.token, cmd, timeout=20)
    if code is None or code != 0:
        return None
    found = (out or "").split("--STDERR--")[0].strip()
    return found or None


_NOT_FOUND_MESSAGE = (
    "pg_archivecleanup could not be found on this host (checked PATH, the data directory's "
    "sibling bin\\ folder, PostgreSQL's registered install locations, and common install paths). "
    "Install the PostgreSQL client tools on this host, or set the exact binary path manually in "
    "Purge Configuration."
)


def _ensure_cleanup_binary(cfg, agent, engine, db: Session) -> tuple[str | None, str | None]:
    """(binary_path, error_message) — resolved right before an actual
    Test/Execute run, not just for display. A saved path that already looks
    resolved (an admin may have deliberately pointed it somewhere
    non-standard) is trusted as-is; anything else is re-probed fresh, and a
    successful find is persisted onto `cfg` so this doesn't re-probe every
    single run. Returning a clear, actionable message here — instead of
    dispatching a doomed `& 'pg_archivecleanup' ...` that just comes back as
    a cryptic CommandNotFoundException — also saves the round trip."""
    if _looks_resolved(cfg.cleanup_binary):
        return cfg.cleanup_binary, None
    data_directory = None
    try:
        data_directory = _val(engine, "SHOW data_directory")
    except Exception:  # noqa: BLE001
        pass
    found = _probe_cleanup_binary(agent, data_directory)
    if not found:
        return None, _NOT_FOUND_MESSAGE
    cfg.cleanup_binary = found
    db.commit()
    return found, None


def _fmt_bytes(n: int) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


_RETENTION_PREVIEW_DAYS = [1, 3, 7, 14, 30]


def _retention_preview(segments: list, replication_cutoff: str, cur_wal: str, now: datetime) -> list:
    """"If retention were N days, how many files / how much space would be
    purge-eligible right now" — one row per common preset, so a DBA can pick
    a retention before committing to it instead of guessing. Reuses the
    archive scan and replication cutoff compute_safety() already fetched —
    no extra agent round trip. Still honors the SAME replication-safety
    floor as the real boundary (min(retention_cutoff, replication_cutoff))
    at every preset — a shorter retention can never suggest purging a file a
    connected standby/slot still needs, matching what would actually happen
    if that retention were saved and run for real."""
    total_count = len(segments)
    total_bytes = sum(f["size"] for f in segments)
    out = []
    for days in _RETENTION_PREVIEW_DAYS:
        cutoff_ts = (now - timedelta(days=days)).timestamp()
        keep_by_age = [f for f in segments if f["mtime"] >= cutoff_ts]
        retention_cutoff = min((f["name"] for f in keep_by_age), default=cur_wal)
        boundary = min(retention_cutoff, replication_cutoff)
        candidates = [f for f in segments if f["name"] < boundary]
        space_bytes = sum(f["size"] for f in candidates)
        remaining_count = total_count - len(candidates)
        remaining_bytes = total_bytes - space_bytes
        out.append({
            "days": days, "label": f"{days}d",
            "files_count": len(candidates),
            "space_bytes": space_bytes, "space_pretty": _fmt_bytes(space_bytes),
            # What's left in the archive AFTER purging at this window — the
            # question "how many files remain after N days" asks for this,
            # not the purge-eligible count above.
            "files_remaining": remaining_count,
            "space_remaining_bytes": remaining_bytes, "space_remaining_pretty": _fmt_bytes(remaining_bytes),
        })
    return out


def _audit(db: Session, org_id: int, user_id, conn_id: int, action_type: str, payload: dict):
    """Never lets an audit-write failure mask the real action's result —
    same guarded pattern as patroni_cluster_service.py's AuditLog writes."""
    try:
        from app.models.admin_models import AuditLog
        db.add(AuditLog(org_id=org_id or 1, user_id=user_id, table_name="postgres_wal_purge",
                         record_id=conn_id, action_type=action_type, new_data=payload))
        db.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("wal_purge audit write failed (%s): %s", action_type, exc)
        try:
            db.rollback()
        except Exception:
            pass


# ═════════════════════════════════════════════════════════════════════════════
#  Archive directory scan (agent shell, mtime-based — the only real signal
#  for "archived N days ago", since a WAL filename encodes no timestamp)
# ═════════════════════════════════════════════════════════════════════════════

def _scan_archive(conn_id: int, archive_dir: str, db: Session) -> dict:
    agent = agent_host_for_conn(conn_id, db)
    if not agent or not agent.token:
        return {"status": "unreachable", "error": "No ActMon agent linked to this connection's host.",
                "segments": [], "aux_count": 0, "total_size_bytes": 0}

    windows = "win" in (agent.os_type or "").lower()
    if windows:
        script = _ps_encoded(
            "Get-ChildItem -File -LiteralPath '%s' -ErrorAction Stop | ForEach-Object { "
            '"{0}`t{1}`t{2}" -f $_.Name, ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeSeconds(), $_.Length }'
            % archive_dir.replace("'", "''")
        )
    else:
        script = "LC_ALL=C find '%s' -maxdepth 1 -type f -printf '%%f\\t%%T@\\t%%s\\n' 2>&1" % archive_dir.replace("'", "'\\''")

    code, out = _agent_shell(agent.token, script, timeout=120)
    if code is None:
        return {"status": "unreachable", "error": "The agent did not respond while scanning the archive directory.",
                "segments": [], "aux_count": 0, "total_size_bytes": 0}
    if code != 0:
        return {"status": "unreachable", "error": (out or "").strip()[:400] or f"Scan exited {code}.",
                "segments": [], "aux_count": 0, "total_size_bytes": 0}

    segments, aux_count, total = [], 0, 0
    lines = (out or "").splitlines()
    if len(lines) > _MAX_ARCHIVE_ENTRIES:
        return {"status": "too_large_to_scan", "segments": [], "aux_count": 0, "total_size_bytes": 0}
    for line in lines:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        name, mtime_s, size_s = parts
        try:
            mtime = float(mtime_s)
            size = int(size_s)
        except ValueError:
            continue
        total += size
        if re.fullmatch(r"[0-9A-Fa-f]{24}", name):
            segments.append({"name": name.upper(), "mtime": mtime, "size": size})
        else:
            aux_count += 1
    return {"status": "ok", "segments": segments, "aux_count": aux_count, "total_size_bytes": total}


def _cleanup_command(windows: bool, binary: str, archive_dir: str, boundary: str, dry_run: bool) -> str:
    binary = binary or "pg_archivecleanup"
    flags = "-d -n" if dry_run else "-d"
    if windows:
        # Wrapped in try/catch so a missing binary (CommandNotFoundException)
        # never escapes as an unhandled PowerShell error — with no real
        # console attached (the agent invokes via `cmd /c` with stderr piped),
        # an unhandled error serializes to raw CLIXML on the process's stderr
        # instead of readable text. Catching it here and printing a plain
        # "ERROR: ..." line to stdout keeps the exit code and message usable.
        # Deliberately NOT $ErrorActionPreference = 'Stop'.
        #
        # `2>&1` on a native exe ALWAYS wraps every line it writes to its own
        # stderr as an ErrorRecord object — that's inherent to how PowerShell
        # merges native-command stderr, independent of ErrorActionPreference
        # (which only controls whether it's TERMINATING). Piping those
        # ErrorRecord objects straight into `Out-String` doesn't print their
        # message — it renders PowerShell's full verbose error format
        # ("At line:X char:Y" / "+ CategoryInfo" / "+ FullyQualifiedErrorId"),
        # which is exactly the noise pg_archivecleanup's routine `-d` debug
        # chatter ("keeping WAL file ... and later") was coming back as. The
        # ForEach-Object below reduces any ErrorRecord to just its message
        # text before formatting, so stderr output reads as plain text same
        # as stdout, and a non-zero exit code is still whatever
        # pg_archivecleanup itself actually returned.
        return _ps_encoded(
            "try {\n"
            "  $__out = & '%s' %s '%s' '%s' 2>&1 | ForEach-Object {\n"
            "    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ }\n"
            "  } | Out-String -Width 4096\n"
            "  $__code = $LASTEXITCODE; if ($null -eq $__code) { $__code = 0 }\n"
            "  Write-Output $__out\n"
            "  exit $__code\n"
            "} catch {\n"
            "  Write-Output ('ERROR: ' + $_.Exception.Message)\n"
            "  exit 127\n"
            "}" % (binary.replace("'", "''"), flags, archive_dir.replace("'", "''"), boundary)
        )
    return "%s %s '%s' '%s' 2>&1" % (binary, flags, archive_dir.replace("'", "'\\''"), boundary)


# ═════════════════════════════════════════════════════════════════════════════
#  Safety boundary — the single source of truth for every action below
# ═════════════════════════════════════════════════════════════════════════════

def compute_safety(conn_id: int, db: Session, cfg=None) -> dict:
    if cfg is None:
        cfg = _cfg_for(conn_id, db)
    conn, engine = _pg_conn(conn_id, db)
    now = datetime.utcnow()

    blocking: list[dict] = []
    warnings: list[dict] = []

    repl = svc_pg_replication_detail(conn_id, db)
    is_primary = bool(repl.get("is_primary"))
    slots = repl.get("slots") or []
    standbys = repl.get("standbys") or []
    archiver = repl.get("archiver") or {}

    if not is_primary:
        blocking.append({"code": "not_primary",
                          "message": "Run WAL archive purge from the primary — this connection is currently a standby."})

    for s in slots:
        ws = (s.get("wal_status") or "").lower()
        if ws == "lost":
            blocking.append({"code": "slot_lost", "detail": s,
                              "message": f"Replication slot '{s.get('slot_name')}' has already lost WAL it required."})
        elif ws == "unreserved":
            blocking.append({"code": "slot_unreserved", "detail": s,
                              "message": f"Replication slot '{s.get('slot_name')}' is about to lose required WAL."})
        elif ws == "extended" or (s.get("lag_mb") or 0) > 1024:
            warnings.append({"code": "slot_lag_high", "detail": s,
                              "message": f"Replication slot '{s.get('slot_name')}' is far behind ({s.get('lag_mb')} MB)."})

    try:
        lf, la = archiver.get("last_failed_time") or "", archiver.get("last_archived_time") or ""
        if (archiver.get("failed_count") or 0) > 0 and lf and (not la or lf > la):
            blocking.append({"code": "archiving_failing", "detail": archiver,
                              "message": "WAL archiving has a failure more recent than its last success."})
    except Exception:  # noqa: BLE001
        pass

    # One combined round trip instead of three separate ones (archive_mode,
    # archive_command, current WAL file) — each `_val`/`_rows` call is a full
    # agent job dispatch-and-wait for an agent-routed (e.g. Windows-hosted)
    # connection, so serializing them here was the biggest single contributor
    # to this page taking a very long time to load.
    settings = {}
    try:
        settings = _rows(engine,
            "SELECT current_setting('archive_mode') AS archive_mode, "
            "current_setting('archive_command') AS archive_command, "
            "pg_walfile_name(pg_current_wal_lsn()) AS cur_wal")[0]
    except Exception:  # noqa: BLE001
        pass
    archive_mode = (settings.get("archive_mode") or "").lower()
    if archive_mode not in ("on", "always"):
        blocking.append({"code": "archiving_off",
                          "message": "archive_mode is not 'on' — WAL isn't being archived, so this directory's "
                                     "relationship to the live cluster can't be trusted."})

    if cfg and cfg.require_standby_ok:
        if not standbys:
            blocking.append({"code": "no_standby",
                              "message": "No connected standby, but the configuration requires a healthy one."})
        else:
            for sb in standbys:
                if (sb.get("lag_mb") or 0) > (cfg.max_standby_lag_mb or 1024):
                    blocking.append({"code": "standby_lag_high", "detail": sb,
                                      "message": f"Standby '{sb.get('application_name')}' lag exceeds the configured limit."})

    archive_dir, archive_dir_detected = _effective_archive_dir(cfg, settings.get("archive_command"))
    if not archive_dir:
        blocking.append({"code": "no_archive_dir",
                          "message": "Could not determine the archive path — archive_command doesn't contain a "
                                     "recognizable directory. Set Archive Path manually in Purge Configuration."})
        scan = {"status": "not_configured", "segments": [], "aux_count": 0, "total_size_bytes": 0}
    else:
        scan = _scan_archive(conn_id, archive_dir, db)

    archive_status = scan.get("status", "unreachable")
    segments = scan.get("segments", [])
    if archive_status == "unreachable" and archive_dir:
        blocking.append({"code": "archive_unreachable", "message": scan.get("error") or "Could not read the archive directory."})
    elif archive_status == "too_large_to_scan":
        blocking.append({"code": "archive_too_large", "message": "The archive directory has too many files to scan safely."})
    elif archive_status == "ok" and not segments and (archiver.get("archived_count") or 0) > 0:
        archive_status = "mismatch"
        blocking.append({"code": "archive_mismatch",
                          "message": "No WAL segments found at the configured path, but the archiver reports files "
                                     "have been archived — check that the path is correct."})

    cur_wal = (settings.get("cur_wal") or "FFFFFFFFFFFFFFFFFFFFFFFF").upper()

    required = [cur_wal]
    try:
        for r in _rows(engine,
            "SELECT pg_walfile_name(restart_lsn) AS wal FROM pg_replication_slots WHERE restart_lsn IS NOT NULL "
            "UNION ALL "
            "SELECT pg_walfile_name(LEAST(sent_lsn, replay_lsn)) AS wal FROM pg_stat_replication "
            "WHERE replay_lsn IS NOT NULL AND sent_lsn IS NOT NULL"):
            if r.get("wal"):
                required.append(str(r["wal"]).upper())
    except Exception:  # noqa: BLE001
        pass
    replication_cutoff = min(required)

    retention_days = (cfg.retention_days if cfg else 7) or 7
    cutoff_ts = (now - timedelta(days=retention_days)).timestamp()
    keep_by_age = [f for f in segments if f["mtime"] >= cutoff_ts]
    retention_cutoff = min((f["name"] for f in keep_by_age), default=cur_wal)

    safe_boundary = min(retention_cutoff, replication_cutoff)
    binding_cutoff = "retention" if retention_cutoff <= replication_cutoff else "replication"

    if not _valid_wal_name(safe_boundary):
        blocking.append({"code": "bad_boundary", "message": "Could not compute a valid WAL boundary from the data available."})

    candidates = [f for f in segments if f["name"] < safe_boundary]
    files_to_purge = len(candidates)
    space_bytes = sum(f["size"] for f in candidates)

    total_size = scan.get("total_size_bytes") or 0
    if archive_status == "ok" and total_size > 0 and space_bytes > total_size * 0.5:
        warnings.append({"code": "large_reclaim", "message": "This run would reclaim over half the archive's current size."})
    if retention_days < 7:
        warnings.append({"code": "short_retention", "message": f"Retention is set below 7 days ({retention_days})."})
    if cfg and cfg.enabled and cfg.schedule_present is False:
        warnings.append({"code": "schedule_missing", "message": "The schedule is enabled, but its host scheduler entry is missing — Schedule Purge again."})
    last_archived = str(archiver.get("last_archived_wal") or "").upper()
    if last_archived and segments and not any(f["name"] == last_archived for f in segments):
        warnings.append({"code": "latest_not_found", "message": "The archiver's last archived WAL was not found in the scanned directory."})

    safety_state = "CRITICAL" if blocking else ("WARNING" if warnings else "SAFE")
    retention_preview = _retention_preview(segments, replication_cutoff, cur_wal, now)

    return {
        "safety_state": safety_state,
        "retention_preview": retention_preview,
        "safe_boundary_wal": safe_boundary,
        "retention_cutoff_wal": retention_cutoff,
        "replication_cutoff_wal": replication_cutoff,
        "oldest_required_wal": replication_cutoff,
        "binding_cutoff": binding_cutoff,
        "current_wal_file": cur_wal,
        "files_to_purge": files_to_purge,
        "space_reclaimable_bytes": space_bytes,
        "space_reclaimable_pretty": _fmt_bytes(space_bytes),
        "archive_status": archive_status,
        "blocking_reasons": blocking,
        "warnings": warnings,
        "slots": slots,
        "standbys": standbys,
        "archiver": archiver,
        "computed_at": now.isoformat() + "Z",
        "_segments": segments,   # internal — reused by preview/test/execute, stripped before the HTTP response
    }


def _public_safety(safety: dict) -> dict:
    return {k: v for k, v in safety.items() if not k.startswith("_")}


# ═════════════════════════════════════════════════════════════════════════════
#  Archive info panel
# ═════════════════════════════════════════════════════════════════════════════

def svc_wal_archive_info(conn_id: int, db: Session) -> dict:
    conn, engine = _pg_conn(conn_id, db)
    cfg = _cfg_for(conn_id, db)

    # One combined round trip instead of four separate ones — each is a full
    # agent job dispatch-and-wait for an agent-routed connection (e.g. a
    # Windows-hosted DB), so this alone used to add many seconds to loading
    # this page.
    version = archive_mode = archive_command = archive_timeout = data_directory = None
    try:
        row = _rows(engine,
            "SELECT version() AS version, "
            "current_setting('archive_mode') AS archive_mode, "
            "current_setting('archive_command') AS archive_command, "
            "current_setting('archive_timeout') AS archive_timeout, "
            "current_setting('data_directory') AS data_directory")[0]
        version, archive_mode = row.get("version"), row.get("archive_mode")
        archive_command, archive_timeout = row.get("archive_command"), row.get("archive_timeout")
        data_directory = row.get("data_directory")
    except Exception:  # noqa: BLE001
        pass

    repl = svc_pg_replication_detail(conn_id, db)
    archiver = repl.get("archiver") or {}

    agent = agent_host_for_conn(conn_id, db)
    scheduler = None
    windows = False
    if agent:
        windows = "win" in (agent.os_type or "").lower()
        scheduler = "schtasks" if windows else "cron"

    archive_dir, archive_dir_detected = _effective_archive_dir(cfg, archive_command)
    scan = _scan_archive(conn_id, archive_dir, db) if archive_dir else {
        "status": "not_configured", "segments": [], "aux_count": 0, "total_size_bytes": 0}
    segments = scan.get("segments", [])
    oldest = min(segments, key=lambda f: f["mtime"], default=None)
    latest = max(segments, key=lambda f: f["mtime"], default=None)

    # Kept for the frontend's "Use detected path" hint even in the rare case
    # the effective dir came from a saved override that differs from what
    # archive_command would suggest today.
    suggested_dir = _detect_archive_dir(archive_command)
    # Only actually probe the host (an extra agent round trip) when there's
    # no already-saved, verified-real binary path to show instead — a saved
    # value with no path separator is the pre-detection bare default, which
    # is already known to fail, so it doesn't count as "already resolved".
    detected_cleanup_binary = None if (cfg and _looks_resolved(cfg.cleanup_binary)) else _probe_cleanup_binary(agent, data_directory)

    return {
        "status": "success",
        "instance": {
            "conn_id": conn_id, "name": conn.connection_name, "host": conn.host, "port": conn.port,
            "database": conn.database_name, "version": version, "is_primary": repl.get("is_primary"),
        },
        "agent": {
            "hostname": agent.hostname if agent else None,
            "os_type": agent.os_type if agent else None,
            "scheduler": scheduler,
            "linked": bool(agent),
        },
        "archive": {
            "archive_mode": archive_mode, "archive_command": archive_command, "archive_timeout": archive_timeout,
            "archive_dir": archive_dir, "archive_dir_detected": archive_dir_detected,
            "suggested_archive_dir": suggested_dir, "status": scan.get("status"),
            "size_bytes": scan.get("total_size_bytes", 0), "size_pretty": _fmt_bytes(scan.get("total_size_bytes", 0)),
            "segment_count": len(segments), "aux_count": scan.get("aux_count", 0),
            "oldest_wal": oldest["name"] if oldest else None,
            "oldest_wal_archived_at": datetime.utcfromtimestamp(oldest["mtime"]).isoformat() + "Z" if oldest else None,
            "latest_wal": latest["name"] if latest else None,
            "latest_wal_archived_at": datetime.utcfromtimestamp(latest["mtime"]).isoformat() + "Z" if latest else None,
            "archived_count": archiver.get("archived_count"), "failed_count": archiver.get("failed_count"),
            "last_failed_wal": archiver.get("last_failed_wal"), "last_failed_time": archiver.get("last_failed_time"),
        },
        "cleanup_binary": {
            "path": (cfg.cleanup_binary if cfg and _looks_resolved(cfg.cleanup_binary) else None)
                or detected_cleanup_binary or (cfg.cleanup_binary if cfg else None) or "pg_archivecleanup",
            "detected": bool(not (cfg and _looks_resolved(cfg.cleanup_binary)) and detected_cleanup_binary),
        },
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Config CRUD
# ═════════════════════════════════════════════════════════════════════════════

_VALID_FREQ = {"daily", "weekly", "monthly"}
_VALID_RETENTION_PRESETS = {"1d", "3d", "7d", "14d", "30d", "custom"}


def svc_wal_purge_config_get(conn_id: int, db: Session) -> dict:
    conn, engine = _pg_conn(conn_id, db)
    cfg = _cfg_for(conn_id, db)
    if not cfg:
        # Pre-fill from the live archive_command/data_directory instead of
        # handing back a blank form — a DBA who already configured archiving
        # in postgresql.conf shouldn't have to retype a path ActMon can
        # already see, and on Windows a bare 'pg_archivecleanup' fails with
        # CommandNotFoundException unless it happens to be on PATH.
        detected = detected_binary = None
        try:
            row = _rows(engine, "SELECT current_setting('archive_command') AS archive_command, "
                                 "current_setting('data_directory') AS data_directory")[0]
            detected = _detect_archive_dir(row.get("archive_command"))
            agent = agent_host_for_conn(conn_id, db)
            detected_binary = _probe_cleanup_binary(agent, row.get("data_directory"))
        except Exception:  # noqa: BLE001
            pass
        return {"status": "success", "config": {
            "exists": False, "archive_dir": detected or "", "archive_dir_detected": bool(detected),
            "cleanup_binary": detected_binary or "pg_archivecleanup", "cleanup_binary_detected": bool(detected_binary),
        }}

    result = _serialize_config(cfg)
    if not _looks_resolved(cfg.cleanup_binary):
        # Saved before path auto-detection existed (or never resolved) — a
        # bare command name is already known to fail on Windows, so re-probe
        # rather than keep handing back the same broken value forever.
        try:
            data_directory = _val(engine, "SELECT current_setting('data_directory')")
            agent = agent_host_for_conn(conn_id, db)
            detected_binary = _probe_cleanup_binary(agent, data_directory)
            if detected_binary:
                result["cleanup_binary"] = detected_binary
                result["cleanup_binary_detected"] = True
        except Exception:  # noqa: BLE001
            pass
    return {"status": "success", "config": result}


def _serialize_config(cfg) -> dict:
    return {
        "id": cfg.id, "exists": True, "archive_dir": cfg.archive_dir,
        "cleanup_binary": cfg.cleanup_binary, "cleanup_method": cfg.cleanup_method,
        "retention_preset": cfg.retention_preset, "retention_days": cfg.retention_days,
        "require_standby_ok": cfg.require_standby_ok, "max_standby_lag_mb": cfg.max_standby_lag_mb,
        "frequency": cfg.frequency, "hour": cfg.hour, "minute": cfg.minute,
        "day_of_week": cfg.day_of_week, "day_of_month": cfg.day_of_month,
        "enabled": cfg.enabled, "scheduler_type": cfg.scheduler_type,
        "scheduler_entry_name": cfg.scheduler_entry_name, "callback_base_url": cfg.callback_base_url,
        "missed_grace_minutes": cfg.missed_grace_minutes,
        "schedule_present": cfg.schedule_present,
        "schedule_verified_at": _iso_utc(cfg.schedule_verified_at),
        "next_run_at": _iso_utc(cfg.next_run_at),
        "last_run_at": _iso_utc(cfg.last_run_at),
        "last_status": cfg.last_status, "last_error": cfg.last_error,
        "last_files_purged": cfg.last_files_purged, "last_space_reclaimed_bytes": cfg.last_space_reclaimed_bytes,
        "last_safety_state": cfg.last_safety_state,
        "created_by": cfg.created_by, "created_at": _iso_utc(cfg.created_at),
        "updated_at": _iso_utc(cfg.updated_at),
    }


def svc_wal_purge_config_save(conn_id: int, req: dict, user_id, db: Session) -> dict:
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig
    conn, engine = _pg_conn(conn_id, db)

    forbidden = []
    try:
        data_dir = _val(engine, "SHOW data_directory")
        if data_dir:
            forbidden = [data_dir, data_dir.rstrip("\\/") + "/pg_wal", data_dir.rstrip("\\/") + "\\pg_wal"]
    except Exception:  # noqa: BLE001
        pass
    archive_dir = _safe_archive_dir(req.get("archive_dir"), forbidden)

    cleanup_method = (req.get("cleanup_method") or "pg_archivecleanup").strip()
    if cleanup_method != "pg_archivecleanup":
        raise HTTPException(400, "cleanup_method must be 'pg_archivecleanup'.")

    retention_preset = req.get("retention_preset") or "7d"
    if retention_preset not in _VALID_RETENTION_PRESETS:
        raise HTTPException(400, "Invalid retention preset.")
    retention_days = int(req.get("retention_days") or 7)
    if not (1 <= retention_days <= 3650):
        raise HTTPException(400, "retention_days must be between 1 and 3650.")

    frequency = req.get("frequency") or "daily"
    if frequency not in _VALID_FREQ:
        raise HTTPException(400, "frequency must be daily, weekly, or monthly.")
    hour = int(req.get("hour", 2))
    minute = int(req.get("minute", 30))
    day_of_week = int(req.get("day_of_week", 0))
    day_of_month = max(1, min(28, int(req.get("day_of_month", 1))))
    if not (0 <= hour <= 23):
        raise HTTPException(400, "hour must be between 0 and 23.")
    if not (0 <= minute <= 59):
        raise HTTPException(400, "minute must be between 0 and 59.")
    if not (0 <= day_of_week <= 6):
        raise HTTPException(400, "day_of_week must be between 0 and 6.")

    max_standby_lag_mb = int(req.get("max_standby_lag_mb", 1024))
    if max_standby_lag_mb <= 0:
        raise HTTPException(400, "max_standby_lag_mb must be positive.")

    # A trailing slash is the most natural way to type/copy a base URL (and
    # is exactly what the auto-detected fallback can hand back verbatim from
    # a browser's own address bar) — stripping it before validating means a
    # perfectly good URL doesn't get rejected over a harmless "/", and it
    # matches the already-normalized form install_schedule() builds on
    # (base_url.rstrip("/") + "/api/v1/...").
    callback_base_url = (req.get("callback_base_url") or "").strip().rstrip("/") or None
    if callback_base_url and not re.fullmatch(r"https?://[A-Za-z0-9._\-\[\]:]+(:\d{1,5})?", callback_base_url):
        raise HTTPException(400, "callback_base_url must be a plain http(s)://host[:port] URL.")

    cfg = _cfg_for(conn_id, db)
    is_new = cfg is None
    old_data = _serialize_config(cfg) if cfg else None
    if not cfg:
        cfg = PostgresWalPurgeConfig(org_id=getattr(conn, "org_id", 1) or 1, conn_id=conn_id, created_by=user_id)
        db.add(cfg)

    schedule_needs_reinstall = bool(cfg.enabled and (
        cfg.archive_dir != archive_dir or cfg.frequency != frequency or cfg.hour != hour or
        cfg.minute != minute or cfg.day_of_week != day_of_week or cfg.day_of_month != day_of_month
    ))

    cfg.archive_dir = archive_dir
    cfg.cleanup_binary = (req.get("cleanup_binary") or "pg_archivecleanup").strip() or "pg_archivecleanup"
    cfg.cleanup_method = cleanup_method
    cfg.retention_preset = retention_preset
    cfg.retention_days = retention_days
    cfg.require_standby_ok = bool(req.get("require_standby_ok", True))
    cfg.max_standby_lag_mb = max_standby_lag_mb
    cfg.frequency = frequency
    cfg.hour = hour
    cfg.minute = minute
    cfg.day_of_week = day_of_week
    cfg.day_of_month = day_of_month
    cfg.callback_base_url = callback_base_url
    cfg.missed_grace_minutes = int(req.get("missed_grace_minutes", 15))
    cfg.updated_by = user_id
    db.commit()
    db.refresh(cfg)

    _audit(db, getattr(conn, "org_id", 1), user_id, conn_id, "wal_purge_config_saved",
           {"old": old_data, "new": _serialize_config(cfg)})

    safety = compute_safety(conn_id, db, cfg)
    return {"status": "success", "config": _serialize_config(cfg), "safety": _public_safety(safety),
            "schedule_needs_reinstall": schedule_needs_reinstall}


# ═════════════════════════════════════════════════════════════════════════════
#  Preview / Test / Execute
# ═════════════════════════════════════════════════════════════════════════════

def svc_wal_purge_preview(conn_id: int, db: Session, user_id) -> dict:
    cfg = _require_cfg(conn_id, db)
    safety = compute_safety(conn_id, db, cfg)
    segments = safety.pop("_segments", [])
    boundary = safety["safe_boundary_wal"]
    candidates = sorted((f for f in segments if f["name"] < boundary), key=lambda f: f["name"])
    truncated = len(candidates) > _MAX_PREVIEW_CANDIDATES
    shown = candidates[:_MAX_PREVIEW_CANDIDATES]

    _audit(db, cfg.org_id, user_id, conn_id, "wal_purge_preview",
           {"boundary": boundary, "files_to_purge": safety["files_to_purge"]})

    return {
        "status": "success", "safety": safety, "boundary": boundary,
        "retention_days": cfg.retention_days,
        "files_to_purge": safety["files_to_purge"], "space_reclaimable_bytes": safety["space_reclaimable_bytes"],
        "space_reclaimable_pretty": safety["space_reclaimable_pretty"],
        "candidates": [{"name": f["name"], "size_bytes": f["size"],
                        "archived_at": datetime.utcfromtimestamp(f["mtime"]).isoformat() + "Z"} for f in shown],
        "candidates_truncated": truncated,
        "note": "WAL segments only — .backup/.history files are handled separately by pg_archivecleanup.",
    }


def svc_wal_purge_test(conn_id: int, db: Session, user_id) -> dict:
    from app.models.postgres_wal_purge_model import PostgresWalPurgeHistory
    cfg = _require_cfg(conn_id, db)
    safety = compute_safety(conn_id, db, cfg)
    safety.pop("_segments", None)

    agent = agent_host_for_conn(conn_id, db)
    if not agent:
        raise HTTPException(409, "No ActMon agent linked to this connection's host.")
    windows = "win" in (agent.os_type or "").lower()

    started = datetime.utcnow()
    _, engine = _pg_conn(conn_id, db)
    binary, binary_error = _ensure_cleanup_binary(cfg, agent, engine, db)
    if binary_error:
        # Don't bother the agent with a command that's already known to fail
        # — resolve straight to a clear, actionable message instead of the
        # cryptic CommandNotFoundException a doomed dispatch would come back
        # with.
        cmd, code, out = None, 127, binary_error
    else:
        cmd = _cleanup_command(windows, binary, cfg.archive_dir, safety["safe_boundary_wal"], dry_run=True)
        code, out = _agent_shell(agent.token, cmd, timeout=_TEST_TIMEOUT_SECONDS)
    finished = datetime.utcnow()
    duration_ms = int((finished - started).total_seconds() * 1000)

    would_delete = sorted(set(_WAL_NAME_RE.findall(out or "")))
    status = "success" if code == 0 else "failed"

    row = PostgresWalPurgeHistory(
        org_id=cfg.org_id, conn_id=conn_id, config_id=cfg.id, run_type="test", trigger_source="ui",
        status=status, safety_state=safety["safety_state"], safe_boundary_wal=safety["safe_boundary_wal"],
        retention_cutoff_wal=safety["retention_cutoff_wal"], replication_cutoff_wal=safety["replication_cutoff_wal"],
        binding_cutoff=safety["binding_cutoff"], retention_days=cfg.retention_days, archive_dir=cfg.archive_dir,
        files_purged=0, files_matched=len(would_delete), exit_code=code, command_text=cmd,
        started_at=started, finished_at=finished, duration_ms=duration_ms,
        error_message=None if code == 0 else (out or "")[:2000],
        details={"stdout_tail": (out or "")[-4000:]}, user_id=user_id,
    )
    db.add(row)
    db.commit()
    _audit(db, cfg.org_id, user_id, conn_id, "wal_purge_test", {"run_id": row.id, "exit_code": code})

    return {
        "status": "success", "run_id": row.id, "safety": safety,
        "command": cmd if not windows else cmd,  # PS-encoded on Windows for real dispatch; readable form not reconstructed here
        "exit_code": code, "binary_ok": code == 0,
        "would_delete_count": len(would_delete), "would_delete_sample": would_delete[:50],
        "estimate_count": safety["files_to_purge"],
        "count_delta": len(would_delete) - safety["files_to_purge"],
        "stdout_tail": (out or "")[-2000:], "duration_ms": duration_ms,
    }


def svc_wal_purge_execute(conn_id: int, req: dict, user_id, db: Session) -> dict:
    """Validates, then hands the actual run to a background thread and
    returns immediately with a run_id — the caller polls
    svc_wal_purge_run_status() for live progress instead of holding one HTTP
    request open for the whole (potentially many-minute) operation. Chunked
    execution (see _run_purge_chunked) means that polled status carries REAL
    incremental progress (files done so far, right now), not a guess."""
    from app.models.postgres_wal_purge_model import PostgresWalPurgeHistory
    if (req.get("confirm") or "") != "PURGE":
        raise HTTPException(400, "Confirmation phrase must be exactly 'PURGE'.")

    cfg = _require_cfg(conn_id, db)
    safety = compute_safety(conn_id, db, cfg)
    segments = safety.pop("_segments", [])
    if safety["safety_state"] == "CRITICAL":
        raise HTTPException(409, {"detail": "Purge is unsafe right now.", "blocking_reasons": safety["blocking_reasons"]})
    if safety["safety_state"] == "WARNING" and not req.get("acknowledge_warnings"):
        raise HTTPException(409, {"detail": "This run has warnings that must be acknowledged.", "warnings": safety["warnings"]})

    boundary = safety["safe_boundary_wal"]
    row = PostgresWalPurgeHistory(
        org_id=cfg.org_id, conn_id=conn_id, config_id=cfg.id, run_type="manual", trigger_source="ui",
        status="running", safety_state=safety["safety_state"], safe_boundary_wal=boundary,
        retention_cutoff_wal=safety["retention_cutoff_wal"], replication_cutoff_wal=safety["replication_cutoff_wal"],
        binding_cutoff=safety["binding_cutoff"], retention_days=cfg.retention_days, archive_dir=cfg.archive_dir,
        files_before=len(segments), bytes_before=sum(f["size"] for f in segments),
        started_at=datetime.utcnow(), user_id=user_id,
        details={"progress": {"completed_files": 0, "total_files": safety["files_to_purge"],
                               "completed_bytes": 0, "total_bytes": safety["space_reclaimable_bytes"],
                               "chunk": 0, "chunks_total": 0}},
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A purge is already running for this connection.")

    run_id = row.id
    threading.Thread(target=_run_purge_chunked, args=(conn_id, run_id, segments, boundary),
                      daemon=True, name=f"wal-purge-execute-{run_id}").start()
    return {"status": "accepted", "run_id": run_id}


def _run_purge_chunked(conn_id: int, run_id: int, segments_before: list, boundary: str):
    """The actual purge, run in a background thread and reported chunk-by-
    chunk so a poller sees real incremental progress. Every chunk still goes
    through the exact same official pg_archivecleanup binary as a single
    invocation would — this only calls it several times with a
    progressively later boundary (each one an ALREADY-OBSERVED real WAL
    filename from the archive scan, never a synthesized name) instead of
    once, so the safety-critical deletion logic itself is unchanged."""
    from app.database.connection import SessionLocal
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig, PostgresWalPurgeHistory
    session = SessionLocal()
    try:
        row = session.query(PostgresWalPurgeHistory).filter(PostgresWalPurgeHistory.id == run_id).first()
        if not row:
            return
        cfg = session.query(PostgresWalPurgeConfig).filter(PostgresWalPurgeConfig.id == row.config_id).first()
        if not cfg:
            return

        agent = agent_host_for_conn(conn_id, session)
        if not agent:
            row.status, row.error_message, row.finished_at = "failed", "No ActMon agent linked to this connection's host.", datetime.utcnow()
            session.commit()
            _audit(session, cfg.org_id, row.user_id, conn_id, "wal_purge_execute_failed", {"run_id": run_id, "error": row.error_message})
            return

        windows = "win" in (agent.os_type or "").lower()
        _, engine = _pg_conn(conn_id, session)
        binary, binary_error = _ensure_cleanup_binary(cfg, agent, engine, session)
        if binary_error:
            row.status, row.error_message, row.finished_at = "failed", binary_error, datetime.utcnow()
            session.commit()
            _audit(session, cfg.org_id, row.user_id, conn_id, "wal_purge_execute_failed", {"run_id": run_id, "error": row.error_message})
            return

        candidates = sorted((f for f in segments_before if f["name"] < boundary), key=lambda f: f["name"])
        total_files = len(candidates)
        total_bytes = sum(f["size"] for f in candidates)
        # ~10 real progress updates over the run, without turning a
        # 900-file purge into 900 separate agent round trips.
        if total_files:
            num_chunks = min(10, max(1, -(-total_files // 5)))
            chunk_size = max(1, -(-total_files // num_chunks))
            chunks = [candidates[i:i + chunk_size] for i in range(0, total_files, chunk_size)]
        else:
            # Nothing WAL-eligible, but still issue one real cleanup call —
            # pg_archivecleanup also handles stray .backup/.history aux
            # files at the boundary, which the WAL-only candidate count
            # above doesn't track.
            chunks = [[]]

        done_files, done_bytes, all_out, cmd = 0, 0, [], None
        for i, chunk in enumerate(chunks):
            is_last = i == len(chunks) - 1
            # Boundary for this chunk is either the real, already-observed
            # name of the NEXT chunk's first file, or (on the last chunk)
            # the true safety boundary itself — never a synthesized name.
            chunk_boundary = boundary if is_last else candidates[(i + 1) * chunk_size]["name"]
            cmd = _cleanup_command(windows, binary, cfg.archive_dir, chunk_boundary, dry_run=False)
            code, out = _agent_shell(agent.token, cmd, timeout=_EXECUTE_TIMEOUT_SECONDS)
            all_out.append(out or "")
            if code is None or code != 0:
                row.status = "failed"
                row.error_message = (out or "The agent did not respond while running pg_archivecleanup.")[:2000]
                row.command_text = cmd
                row.finished_at = datetime.utcnow()
                row.duration_ms = int((row.finished_at - row.started_at).total_seconds() * 1000)
                row.details = {
                    "progress": {"completed_files": done_files, "total_files": total_files,
                                 "completed_bytes": done_bytes, "total_bytes": total_bytes,
                                 "chunk": i + 1, "chunks_total": len(chunks)},
                    "stdout_tail": "\n".join(all_out)[-4000:],
                }
                session.commit()
                _audit(session, cfg.org_id, row.user_id, conn_id, "wal_purge_execute_failed", {"run_id": run_id, "error": row.error_message})
                return
            if chunk:
                done_files += len(chunk)
                done_bytes += sum(f["size"] for f in chunk)
            row.details = {"progress": {
                "completed_files": done_files, "total_files": total_files,
                "completed_bytes": done_bytes, "total_bytes": total_bytes,
                "last_file": chunk[-1]["name"] if chunk else None,
                "chunk": i + 1, "chunks_total": len(chunks),
            }}
            session.commit()

        finished = datetime.utcnow()
        rescan = _scan_archive(conn_id, cfg.archive_dir, session)
        after_segments = rescan.get("segments", [])
        files_after = len(after_segments)
        bytes_after = rescan.get("total_size_bytes", 0)
        files_purged = max(0, (row.files_before or 0) - files_after)
        space_reclaimed = max(0, (row.bytes_before or 0) - bytes_after)
        purged_names = sorted({f["name"] for f in segments_before} - {f["name"] for f in after_segments})

        row.status = "success"
        row.exit_code = 0
        row.command_text = cmd
        row.finished_at = finished
        row.duration_ms = int((finished - row.started_at).total_seconds() * 1000)
        row.files_after = files_after
        row.bytes_after = bytes_after
        row.files_purged = files_purged
        row.space_reclaimed_bytes = space_reclaimed
        row.error_message = None
        row.details = {
            "progress": {"completed_files": total_files, "total_files": total_files,
                         "completed_bytes": total_bytes, "total_bytes": total_bytes,
                         "chunk": len(chunks), "chunks_total": len(chunks)},
            "purged_files": purged_names[:1000],
            "stdout_tail": "\n".join(all_out)[-4000:],
        }
        session.commit()

        cfg.last_run_at = finished
        cfg.last_status = row.status
        cfg.last_error = None
        cfg.last_files_purged = row.files_purged
        cfg.last_space_reclaimed_bytes = row.space_reclaimed_bytes
        cfg.last_safety_state = row.safety_state
        session.commit()

        _audit(session, cfg.org_id, row.user_id, conn_id, "wal_purge_execute",
               {"run_id": run_id, "files_purged": row.files_purged, "space_reclaimed_bytes": row.space_reclaimed_bytes})
    except Exception as exc:  # noqa: BLE001
        log.exception("wal_purge chunked execute crashed (run_id=%s): %s", run_id, exc)
        try:
            row = session.query(PostgresWalPurgeHistory).filter(PostgresWalPurgeHistory.id == run_id).first()
            if row and row.status == "running":
                row.status = "failed"
                row.error_message = f"Internal error: {exc}"[:2000]
                row.finished_at = datetime.utcnow()
                session.commit()
        except Exception:  # noqa: BLE001
            pass
    finally:
        session.close()


def svc_wal_purge_run_status(conn_id: int, run_id: int, db: Session) -> dict:
    """Lightweight poll target for a run in progress — status/progress/final
    result for ONE history row, so the UI can show a live-updating purge
    instead of just waiting on one long request."""
    from app.models.postgres_wal_purge_model import PostgresWalPurgeHistory
    row = (db.query(PostgresWalPurgeHistory)
             .filter(PostgresWalPurgeHistory.id == run_id, PostgresWalPurgeHistory.conn_id == conn_id).first())
    if not row:
        raise HTTPException(404, "Purge run not found.")
    details = row.details or {}
    return {
        "status": "success", "run_id": row.id, "run_status": row.status,
        "progress": details.get("progress"), "purged_files": details.get("purged_files", []),
        "files_purged": row.files_purged, "space_reclaimed_bytes": row.space_reclaimed_bytes,
        "space_reclaimed_pretty": _fmt_bytes(row.space_reclaimed_bytes) if row.space_reclaimed_bytes else None,
        "files_before": row.files_before, "files_after": row.files_after,
        "duration_ms": row.duration_ms, "exit_code": row.exit_code, "error_message": row.error_message,
        "started_at": _iso_utc(row.started_at), "finished_at": _iso_utc(row.finished_at),
    }


# ═════════════════════════════════════════════════════════════════════════════
#  Schedule / Disable
# ═════════════════════════════════════════════════════════════════════════════

def svc_wal_purge_schedule(conn_id: int, req: dict, user_id, db: Session, request_base_url: str | None = None) -> dict:
    if (req.get("confirm") or "") != "SCHEDULE":
        raise HTTPException(400, "Confirmation phrase must be exactly 'SCHEDULE'.")
    cfg = _require_cfg(conn_id, db)

    agent = agent_host_for_conn(conn_id, db)
    if not agent:
        raise HTTPException(409, "No ActMon agent linked to this connection's host.")

    base_url = _resolve_callback_base(conn_id, cfg, agent, db, request_base_url)
    if not base_url:
        raise HTTPException(409, "Could not determine a callback URL for this host. Set 'Callback URL' in the "
                                  "configuration form, then try again.")

    plain_token = secrets.token_hex(24)
    try:
        result = install_schedule(conn_id, cfg, plain_token, base_url, db)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))

    cfg.scheduler_type = result["scheduler_type"]
    cfg.scheduler_entry_name = result["entry_name"]
    cfg.callback_base_url = base_url
    cfg.trigger_token_hash = credential_encryption.hash_token(plain_token)
    cfg.trigger_token_created_at = datetime.utcnow()
    cfg.enabled = True
    cfg.next_run_at = next_run(cfg)
    cfg.schedule_present = True
    cfg.schedule_verified_at = datetime.utcnow()
    cfg.updated_by = user_id
    db.commit()

    _audit(db, cfg.org_id, user_id, conn_id, "wal_purge_scheduled",
           {"scheduler_type": cfg.scheduler_type, "next_run_at": _iso_utc(cfg.next_run_at)})

    return {"status": "success", "scheduler_type": cfg.scheduler_type, "entry_name": cfg.scheduler_entry_name,
            "next_run_at": _iso_utc(cfg.next_run_at), "verified": True,
            "installed_command": result["installed_command"]}


def _resolve_callback_base(conn_id: int, cfg, agent, db: Session, request_base_url: str | None = None) -> str | None:
    if cfg.callback_base_url:
        return cfg.callback_base_url
    windows = "win" in (agent.os_type or "").lower()
    if windows:
        code, out = _agent_shell(agent.token, 'reg query "HKLM\\SOFTWARE\\ActMon\\Agent" /v Url', timeout=15)
        if code == 0 and out:
            m = re.search(r"Url\s+REG_SZ\s+(\S+)", out)
            if m:
                return m.group(1).strip()
    else:
        code, out = _agent_shell(agent.token, "grep -h '^ACTMON_URL=' /etc/actmon/agent.conf 2>/dev/null | head -1", timeout=15)
        if code == 0 and out:
            m = re.search(r"ACTMON_URL=(\S+)", out)
            if m:
                return m.group(1).strip().strip('"\'')
    import os as _os
    env_url = _os.getenv("ACTMON_CALLBACK_BASE_URL")
    if env_url:
        return env_url
    # Last resort: whatever address the DBA's own browser used to reach
    # ActMon just now. Neither the agent registry key nor a server-side env
    # var is guaranteed to exist (e.g. an older agent build that predates
    # this key, or a deployment that never set the env var) — but the
    # browser's request just proved THIS host+scheme is a real, currently
    # reachable public address for ActMon, which is exactly what the cron/
    # Task Scheduler entry also needs to call back into.
    return request_base_url


def svc_wal_purge_disable(conn_id: int, user_id, db: Session) -> dict:
    cfg = _require_cfg(conn_id, db)
    removal = remove_schedule(conn_id, cfg, db)

    cfg.enabled = False
    cfg.trigger_token_hash = None
    cfg.trigger_token_created_at = None
    cfg.next_run_at = None
    cfg.schedule_present = False
    cfg.updated_by = user_id
    db.commit()

    _audit(db, cfg.org_id, user_id, conn_id, "wal_purge_schedule_disabled", removal)
    return {"status": "success", "removed": True, **removal}


# ═════════════════════════════════════════════════════════════════════════════
#  Trigger callback (the cron/task's only job)
# ═════════════════════════════════════════════════════════════════════════════

def svc_wal_purge_trigger(schedule_id: int, token: str, source_ip: str, db: Session) -> dict:
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig, PostgresWalPurgeHistory

    cfg = db.query(PostgresWalPurgeConfig).filter(PostgresWalPurgeConfig.id == schedule_id).first()
    if not cfg or not cfg.trigger_token_hash or not cfg.enabled:
        raise HTTPException(401, "Invalid purge trigger.")
    if not token or not hmac.compare_digest(credential_encryption.hash_token(token) or "", cfg.trigger_token_hash):
        _audit(db, cfg.org_id, None, cfg.conn_id, "wal_purge_trigger_rejected", {"schedule_id": schedule_id, "source_ip": source_ip})
        raise HTTPException(401, "Invalid purge trigger.")

    guard_cutoff = datetime.utcnow() - timedelta(seconds=_GUARD_WINDOW_SECONDS)
    recent = db.query(PostgresWalPurgeHistory).filter(
        PostgresWalPurgeHistory.conn_id == cfg.conn_id,
        PostgresWalPurgeHistory.started_at >= guard_cutoff,
        PostgresWalPurgeHistory.run_type == "scheduled",
    ).first()
    if recent:
        raise HTTPException(429, "A purge run for this schedule started recently.")

    safety = compute_safety(cfg.conn_id, db, cfg)
    segments = safety.pop("_segments", [])

    if safety["safety_state"] == "CRITICAL":
        row = PostgresWalPurgeHistory(
            org_id=cfg.org_id, conn_id=cfg.conn_id, config_id=cfg.id, run_type="scheduled",
            trigger_source=cfg.scheduler_type, status="blocked", safety_state="CRITICAL",
            safe_boundary_wal=safety.get("safe_boundary_wal"), retention_days=cfg.retention_days,
            archive_dir=cfg.archive_dir, started_at=datetime.utcnow(), finished_at=datetime.utcnow(),
            details={"blocking_reasons": safety["blocking_reasons"]},
        )
        db.add(row)
        cfg.last_run_at = row.started_at
        cfg.last_status = "blocked"
        cfg.last_safety_state = "CRITICAL"
        db.commit()
        _audit(db, cfg.org_id, None, cfg.conn_id, "wal_purge_scheduled_run_blocked",
               {"run_id": row.id, "blocking_reasons": safety["blocking_reasons"]})
        return {"status": "blocked", "run_id": row.id, "reasons": safety["blocking_reasons"]}

    # Insert the running row NOW (in this request) so the partial unique
    # index guards concurrency, then hand the actual purge to a daemon
    # thread — cron must not hold a connection open for the full duration.
    row = PostgresWalPurgeHistory(
        org_id=cfg.org_id, conn_id=cfg.conn_id, config_id=cfg.id, run_type="scheduled",
        trigger_source=cfg.scheduler_type, status="running", safety_state=safety["safety_state"],
        safe_boundary_wal=safety["safe_boundary_wal"], retention_cutoff_wal=safety["retention_cutoff_wal"],
        replication_cutoff_wal=safety["replication_cutoff_wal"], binding_cutoff=safety["binding_cutoff"],
        retention_days=cfg.retention_days, archive_dir=cfg.archive_dir,
        files_before=len(segments), bytes_before=sum(f["size"] for f in segments),
        started_at=datetime.utcnow(),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A purge is already running for this connection.")

    run_id = row.id
    conn_id = cfg.conn_id
    threading.Thread(target=_run_scheduled_purge_async, args=(conn_id, run_id), daemon=True,
                      name=f"wal-purge-trigger-{run_id}").start()
    return {"status": "accepted", "run_id": run_id}


def _run_scheduled_purge_async(conn_id: int, run_id: int):
    from app.database.connection import SessionLocal
    from app.models.postgres_wal_purge_model import PostgresWalPurgeConfig, PostgresWalPurgeHistory
    session = SessionLocal()
    try:
        row = session.query(PostgresWalPurgeHistory).filter(PostgresWalPurgeHistory.id == run_id).first()
        cfg = session.query(PostgresWalPurgeConfig).filter(PostgresWalPurgeConfig.conn_id == conn_id).first()
        if not row or not cfg:
            return
        agent = agent_host_for_conn(conn_id, session)
        if not agent:
            row.status, row.error_message, row.finished_at = "failed", "No ActMon agent linked to this connection's host.", datetime.utcnow()
            session.commit()
            _audit(session, cfg.org_id, None, conn_id, "wal_purge_scheduled_run_failed", {"run_id": run_id, "error": row.error_message})
            return

        windows = "win" in (agent.os_type or "").lower()
        cmd = _cleanup_command(windows, cfg.cleanup_binary, cfg.archive_dir, row.safe_boundary_wal, dry_run=False)
        code, out = _agent_shell(agent.token, cmd, timeout=_EXECUTE_TIMEOUT_SECONDS)
        finished = datetime.utcnow()

        if code is None:
            row.status, row.error_message = "failed", "The agent did not respond while running pg_archivecleanup."
            row.finished_at = finished
            session.commit()
            cfg.last_run_at, cfg.last_status, cfg.last_error = finished, "failed", row.error_message
            session.commit()
            _audit(session, cfg.org_id, None, conn_id, "wal_purge_scheduled_run_failed", {"run_id": run_id, "error": row.error_message})
            return

        rescan = _scan_archive(conn_id, cfg.archive_dir, session)
        files_after = len(rescan.get("segments", []))
        bytes_after = rescan.get("total_size_bytes", 0)
        files_purged = max(0, (row.files_before or 0) - files_after)
        space_reclaimed = max(0, (row.bytes_before or 0) - bytes_after)

        row.status = "success" if code == 0 else "failed"
        row.exit_code = code
        row.command_text = cmd
        row.finished_at = finished
        row.duration_ms = int((finished - row.started_at).total_seconds() * 1000)
        row.files_after = files_after
        row.bytes_after = bytes_after
        row.files_purged = files_purged if code == 0 else 0
        row.space_reclaimed_bytes = space_reclaimed if code == 0 else 0
        row.error_message = None if code == 0 else (out or "")[:2000]
        row.details = {"stdout_tail": (out or "")[-4000:]}
        session.commit()

        cfg.last_run_at = finished
        cfg.last_status = row.status
        cfg.last_error = row.error_message
        cfg.last_files_purged = row.files_purged
        cfg.last_space_reclaimed_bytes = row.space_reclaimed_bytes
        cfg.last_safety_state = row.safety_state
        cfg.next_run_at = next_run(cfg, finished)
        session.commit()

        action = "wal_purge_scheduled_run" if code == 0 else "wal_purge_scheduled_run_failed"
        _audit(session, cfg.org_id, None, conn_id, action,
               {"run_id": run_id, "files_purged": row.files_purged, "space_reclaimed_bytes": row.space_reclaimed_bytes})
    except Exception as exc:  # noqa: BLE001
        log.error("Scheduled WAL purge run %s crashed: %s", run_id, exc)
        try:
            session.rollback()
        except Exception:
            pass
    finally:
        session.close()


# ═════════════════════════════════════════════════════════════════════════════
#  History
# ═════════════════════════════════════════════════════════════════════════════

def svc_wal_purge_history(conn_id: int, db: Session, limit: int = 50, offset: int = 0) -> dict:
    from app.models.postgres_wal_purge_model import PostgresWalPurgeHistory
    q = db.query(PostgresWalPurgeHistory).filter(PostgresWalPurgeHistory.conn_id == conn_id)
    total = q.count()
    rows = q.order_by(PostgresWalPurgeHistory.started_at.desc()).offset(offset).limit(limit).all()
    return {"status": "success", "total": total, "rows": [{
        "id": r.id, "run_type": r.run_type, "trigger_source": r.trigger_source, "status": r.status,
        "safety_state": r.safety_state, "started_at": _iso_utc(r.started_at),
        "finished_at": _iso_utc(r.finished_at), "duration_ms": r.duration_ms,
        "files_purged": r.files_purged, "space_reclaimed_bytes": r.space_reclaimed_bytes,
        "space_reclaimed_pretty": _fmt_bytes(r.space_reclaimed_bytes) if r.space_reclaimed_bytes else None,
        "safe_boundary_wal": r.safe_boundary_wal, "retention_days": r.retention_days,
        "exit_code": r.exit_code, "error_message": r.error_message, "user_id": r.user_id,
    } for r in rows]}


def svc_wal_purge_callback_base(conn_id: int, db: Session) -> dict:
    cfg = _cfg_for(conn_id, db)
    agent = agent_host_for_conn(conn_id, db)
    if not agent:
        return {"status": "success", "base_url": None, "source": None}
    base = _resolve_callback_base(conn_id, cfg, agent, db) if cfg else None
    source = "configured" if (cfg and cfg.callback_base_url) else ("agent_registry" if base else None)
    return {"status": "success", "base_url": base, "source": source}


def svc_wal_purge_audit(conn_id: int, db: Session, limit: int = 100) -> dict:
    from app.models.admin_models import AuditLog
    rows = (db.query(AuditLog)
              .filter(AuditLog.table_name == "postgres_wal_purge", AuditLog.record_id == conn_id)
              .order_by(AuditLog.created_at.desc()).limit(limit).all())
    return {"status": "success", "rows": [{
        "id": r.audit_id, "action": r.action_type, "user_id": r.user_id,
        "data": r.new_data, "timestamp": _iso_utc(r.created_at),
    } for r in rows]}
