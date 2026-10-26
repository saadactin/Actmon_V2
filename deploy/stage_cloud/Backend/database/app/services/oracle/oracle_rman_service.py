"""
Oracle RMAN backup monitoring.

The question this answers is not "did RMAN run" but "if this instance died
right now, what would we get back, and how much would we lose". That is a
different set of views from the job history alone, so this reads seven:

    v$rman_backup_job_details  the jobs themselves
    v$rman_configuration       what RMAN has been CONFIGUREd to do
    v$database                 archivelog mode — the precondition for PITR
    v$backup                   datafiles stuck in BEGIN BACKUP
    v$datafile / v$backup_datafile   per-datafile backup coverage
    v$archived_log             archivelogs not yet backed up
    v$recovery_file_dest       FRA headroom

Every one is a dynamic performance view: no Diagnostic or Tuning Pack licence
is involved, unlike the DBA_HIST_* equivalents. That matters — a monitoring
product must not quietly generate a licence liability for the customer.

Each query is wrapped on its own. An instance that cannot read one view (a
restricted monitoring user, a version without it) loses that one panel and
keeps the rest, rather than returning an empty page.
"""

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404, _get_engine, _rows, _run_with_timeout, _safe_float,
    _safe_int, _safe_str, _timeout_error,
)

# A full backup older than this is the usual "something stopped running"
# signal. Not configurable yet — it is a finding, not an alert, and the job
# history is right there for anyone who disagrees with the threshold.
_FULL_BACKUP_STALE_DAYS = 7
_ARCHIVELOG_BACKUP_STALE_HOURS = 24
_FRA_WARN_PCT = 85
_FRA_CRIT_PCT = 95


def _finding(severity, title, detail, evidence):
    return {"severity": severity, "title": title, "detail": detail, "evidence": evidence}


# ──────────────────────────────────────────────────────────────
#  Job history
# ──────────────────────────────────────────────────────────────

# How far back the job history reaches. backup.sql uses 5 days; 7 keeps a full
# weekly cycle in view. The cap stops a pathological schedule (archivelogs every
# minute) returning thousands of rows to a browser.
JOB_HISTORY_DAYS = 7
JOB_HISTORY_CAP = 500

_JOB_COLUMNS = """session_key, session_recid, session_stamp, input_type, status,
                   TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI:SS') AS start_time,
                   TO_CHAR(end_time,   'YYYY-MM-DD HH24:MI:SS') AS end_time,
                   ROUND((SYSDATE - end_time) * 24, 2)           AS age_hours,
                   ROUND(input_bytes  / 1073741824, 3)           AS input_gb,
                   ROUND(output_bytes / 1073741824, 3)           AS output_gb,
                   ROUND(output_bytes_per_sec / 1048576, 2)      AS mb_per_sec,
                   output_device_type,
                   ROUND(compression_ratio, 2)                   AS compression_ratio,
                   elapsed_seconds"""


def _job_row(r, anchor=False):
    return {
        "session_key":        _safe_int(r.get("SESSION_KEY")),
        "session_recid":      _safe_int(r.get("SESSION_RECID")),
        "session_stamp":      _safe_int(r.get("SESSION_STAMP")),
        "input_type":         _safe_str(r.get("INPUT_TYPE")),
        "status":             _safe_str(r.get("STATUS")),
        "start_time":         _safe_str(r.get("START_TIME")),
        "end_time":           _safe_str(r.get("END_TIME")),
        "age_hours":          round(_safe_float(r.get("AGE_HOURS")), 2),
        "input_gb":           round(_safe_float(r.get("INPUT_GB")), 3),
        "output_gb":          round(_safe_float(r.get("OUTPUT_GB")), 3),
        "mb_per_sec":         round(_safe_float(r.get("MB_PER_SEC")), 2),
        "output_device_type": _safe_str(r.get("OUTPUT_DEVICE_TYPE")),
        "compression_ratio":  round(_safe_float(r.get("COMPRESSION_RATIO")), 2),
        "elapsed_seconds":    _safe_int(r.get("ELAPSED_SECONDS")),
        # elapsed_seconds/3600, as backup.sql reports it.
        "elapsed_hours":      round(_safe_int(r.get("ELAPSED_SECONDS")) / 3600.0, 2),
        # True when this job is older than the window and is listed only because
        # it is the latest of its type.
        "anchor":             anchor,
    }


def _anchor_jobs(engine, errors):
    """The latest COMPLETED job of each restore-relevant type, whatever its age.

    Kept apart from the windowed history on purpose: a weekly full backup must
    be findable even when a week of archivelog backups has scrolled past it.
    """
    try:
        raw = _rows(engine, f"""
            SELECT {_JOB_COLUMNS}
            FROM (
                SELECT j.*,
                       ROW_NUMBER() OVER (PARTITION BY input_type
                                          ORDER BY end_time DESC NULLS LAST) AS rn
                FROM   v$rman_backup_job_details j
                WHERE  status LIKE 'COMPLETED%'
                  AND  input_type IN ('DB FULL', 'DB INCR', 'ARCHIVELOG')
            )
            WHERE rn = 1""")
        return [_job_row(r, anchor=True) for r in raw]
    except Exception as exc:
        errors.append(f"rman_anchor_jobs: {exc}")
        return []


def merge_anchor_jobs(jobs, anchors):
    """Windowed history plus any anchor it does not already contain, newest
    first. Pure, so the merge can be tested without a database."""
    seen = {j.get("session_key") for j in jobs}
    merged = list(jobs) + [a for a in anchors if a.get("session_key") not in seen]
    # Window rows are not anchors even if they also happen to be the latest.
    return sorted(merged, key=lambda j: j.get("start_time") or "", reverse=True)


def _jobs(engine, errors, unavailable):
    """Note what is NOT selected: v$rman_backup_job_details has no
    INCREMENTAL_LEVEL column — that one is on v$backup_set_details. INPUT_TYPE
    already distinguishes DB FULL from DB INCR, so nothing is lost."""
    try:
        raw = _rows(engine, """
            SELECT """ + _JOB_COLUMNS + """
            FROM   v$rman_backup_job_details
            WHERE  start_time > SYSDATE - :days
            ORDER  BY start_time DESC
            FETCH FIRST """ + str(int(JOB_HISTORY_CAP)) + """ ROWS ONLY""",
            {"days": JOB_HISTORY_DAYS})
        return [_job_row(r) for r in raw]
    except Exception as exc:
        errors.append(f"rman_jobs: {exc}")
        unavailable.add("jobs")
        return []


# ──────────────────────────────────────────────────────────────
#  Configuration and instance facts
# ──────────────────────────────────────────────────────────────

def _configuration(engine, errors, unavailable):
    """v$rman_configuration lists only settings that differ from the default.
    An absent row therefore means "default", not "unknown" — which is why the
    caller is told explicitly whether controlfile autobackup was found, rather
    than being left to infer it from an empty list."""
    try:
        raw = _rows(engine, "SELECT conf#, name, value FROM v$rman_configuration ORDER BY conf#")
        return [
            {"conf_num": _safe_int(r.get("CONF#")), "name": _safe_str(r.get("NAME")),
             "value": _safe_str(r.get("VALUE"))}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"rman_configuration: {exc}")
        unavailable.add("config")
        return []


def _database_facts(engine, errors, unavailable):
    try:
        raw = _rows(engine, """
            SELECT name, log_mode, open_mode, database_role, platform_name,
                   controlfile_type,
                   TO_CHAR(controlfile_time,'YYYY-MM-DD HH24:MI:SS') AS controlfile_time
            FROM v$database""")
        if not raw:
            return {}
        r = raw[0]
        return {
            "name":             _safe_str(r.get("NAME")),
            "log_mode":         _safe_str(r.get("LOG_MODE")),
            "open_mode":        _safe_str(r.get("OPEN_MODE")),
            "database_role":    _safe_str(r.get("DATABASE_ROLE")),
            "controlfile_type": _safe_str(r.get("CONTROLFILE_TYPE")),
            "controlfile_time": _safe_str(r.get("CONTROLFILE_TIME")),
        }
    except Exception as exc:
        errors.append(f"database_facts: {exc}")
        unavailable.add("database")
        return {}


# ──────────────────────────────────────────────────────────────
#  Recovery exposure
# ──────────────────────────────────────────────────────────────

def _hot_backup_files(engine, errors, unavailable):
    """Datafiles left in BEGIN BACKUP. Every one of these is generating full
    block images into redo for as long as it stays that way, and a crash needs
    manual END BACKUP before the instance will open — so this is reported even
    though it is a user-managed backup artefact rather than an RMAN one."""
    try:
        raw = _rows(engine, """
            SELECT b.file# AS file_num, d.name AS file_name, b.status,
                   TO_CHAR(b.time,'YYYY-MM-DD HH24:MI:SS') AS since,
                   ROUND((SYSDATE - b.time) * 24, 2)        AS hours_open
            FROM   v$backup b
            JOIN   v$datafile d ON d.file# = b.file#
            WHERE  b.status = 'ACTIVE'
            ORDER  BY b.time""")
        return [
            {"file_num": _safe_int(r.get("FILE_NUM")), "file_name": _safe_str(r.get("FILE_NAME")),
             "status": _safe_str(r.get("STATUS")), "since": _safe_str(r.get("SINCE")),
             "hours_open": round(_safe_float(r.get("HOURS_OPEN")), 2)}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"hot_backup_mode: {exc}")
        unavailable.add("hot_backup")
        return []


def _datafile_coverage(engine, errors, unavailable):
    """Per-datafile last backup. The LEFT JOIN is the point: a datafile that
    has never been backed up produces a row with a NULL completion time, and
    that row is the one worth seeing. An inner join would hide it."""
    try:
        raw = _rows(engine, """
            SELECT d.file# AS file_num, d.name AS file_name, t.name AS tablespace_name,
                   ROUND(d.bytes / 1073741824, 3) AS size_gb,
                   TO_CHAR(MAX(b.completion_time),'YYYY-MM-DD HH24:MI:SS') AS last_backup,
                   ROUND(SYSDATE - MAX(b.completion_time), 2) AS age_days
            FROM   v$datafile d
            JOIN   v$tablespace t      ON t.ts#   = d.ts#
            LEFT   JOIN v$backup_datafile b ON b.file# = d.file#
            GROUP  BY d.file#, d.name, t.name, d.bytes
            ORDER  BY MAX(b.completion_time) ASC NULLS FIRST, d.file#""")
        return [
            {"file_num": _safe_int(r.get("FILE_NUM")), "file_name": _safe_str(r.get("FILE_NAME")),
             "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
             "size_gb": round(_safe_float(r.get("SIZE_GB")), 3),
             # No backup at all reads as an empty string and a null age, so the
             # UI can say "never" rather than printing a misleading 0 days.
             "last_backup": _safe_str(r.get("LAST_BACKUP")),
             "age_days": None if r.get("AGE_DAYS") is None else round(_safe_float(r.get("AGE_DAYS")), 2)}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"datafile_coverage: {exc}")
        unavailable.add("coverage")
        return []


def _unbacked_archivelogs(engine, errors, unavailable):
    """Archivelogs still on disk that no backup has copied. These are the
    window of data loss if the volume holding them is what fails."""
    try:
        raw = _rows(engine, """
            SELECT COUNT(*) AS cnt,
                   ROUND(SUM(blocks * block_size) / 1048576, 2) AS mb,
                   TO_CHAR(MIN(first_time),'YYYY-MM-DD HH24:MI:SS') AS oldest
            FROM   v$archived_log
            WHERE  backup_count = 0
              AND  deleted = 'NO'
              AND  standby_dest = 'NO'
              AND  status = 'A'""")
        if not raw:
            return {"count": 0, "mb": 0.0, "oldest": ""}
        r = raw[0]
        return {"count": _safe_int(r.get("CNT")), "mb": round(_safe_float(r.get("MB")), 2),
                "oldest": _safe_str(r.get("OLDEST"))}
    except Exception as exc:
        errors.append(f"unbacked_archivelogs: {exc}")
        unavailable.add("archivelogs")
        return {"count": 0, "mb": 0.0, "oldest": ""}


def _fra(engine, errors, unavailable):
    """Fast Recovery Area headroom. A full FRA does not degrade gracefully —
    the instance hangs on the next archive, so the percentage matters more
    than almost anything else on this page."""
    dest = {}
    try:
        raw = _rows(engine, """
            SELECT name,
                   ROUND(space_limit / 1073741824, 3)        AS limit_gb,
                   ROUND(space_used / 1073741824, 3)         AS used_gb,
                   ROUND(space_reclaimable / 1073741824, 3)  AS reclaimable_gb,
                   number_of_files
            FROM   v$recovery_file_dest""")
        if raw:
            r = raw[0]
            limit_gb = round(_safe_float(r.get("LIMIT_GB")), 3)
            used_gb  = round(_safe_float(r.get("USED_GB")), 3)
            dest = {
                "name":           _safe_str(r.get("NAME")),
                "limit_gb":       limit_gb,
                "used_gb":        used_gb,
                "reclaimable_gb": round(_safe_float(r.get("RECLAIMABLE_GB")), 3),
                "files":          _safe_int(r.get("NUMBER_OF_FILES")),
                "pct_used":       round(used_gb / limit_gb * 100, 1) if limit_gb else 0.0,
                "configured":     bool(_safe_str(r.get("NAME"))),
            }
    except Exception as exc:
        errors.append(f"fra: {exc}")
        unavailable.add("fra")

    usage = []
    # The view was renamed between releases; neither name exists on every
    # supported version, so try the newer one and fall back rather than
    # reporting an error for a view that was never going to be there.
    for view in ("v$flash_recovery_area_usage", "v$recovery_area_usage"):
        try:
            raw = _rows(engine, f"""
                SELECT file_type,
                       ROUND(percent_space_used, 2)        AS pct_used,
                       ROUND(percent_space_reclaimable, 2) AS pct_reclaimable,
                       number_of_files
                FROM   {view}
                WHERE  percent_space_used > 0
                ORDER  BY percent_space_used DESC""")
            usage = [
                {"file_type": _safe_str(r.get("FILE_TYPE")),
                 "pct_used": round(_safe_float(r.get("PCT_USED")), 2),
                 "pct_reclaimable": round(_safe_float(r.get("PCT_RECLAIMABLE")), 2),
                 "files": _safe_int(r.get("NUMBER_OF_FILES"))}
                for r in raw
            ]
            break
        except Exception:
            continue

    return dest, usage


# ──────────────────────────────────────────────────────────────
#  Findings
# ──────────────────────────────────────────────────────────────

def build_findings(db_facts, jobs, config, hot_files, coverage, archivelogs, fra,
                   unavailable=None):
    """Turn the readings into the handful of statements worth acting on.

    Pure function of the data above — no DB access — so it can be tested
    without an instance, in the same shape as the storage decision engine.

    `unavailable` names the readings that could not be taken. Every rule here
    is guarded by it, because the negative branch of a rule whose input failed
    is not a finding, it is a fabrication: an empty `jobs` list means "no
    backups on record" only when the view was actually read.
    """
    findings = []
    unavailable = set(unavailable or ())

    def unread(key, title, detail):
        """Record that a reading could not be taken. High, not critical: not
        knowing is not the same as knowing it is broken — but it is not
        reassuring either, and it must never be reported as a clean result."""
        findings.append(_finding(
            "high", title, detail,
            f"the '{key}' query failed — the exact Oracle error is in this response's errors list",
        ))

    log_mode = (db_facts or {}).get("log_mode", "")
    if "database" in unavailable:
        unread("database", "Could not read the database's archivelog mode",
               "v$database did not answer, so whether point-in-time recovery is even possible "
               "here is unknown.")
    elif log_mode and log_mode.upper() != "ARCHIVELOG":
        findings.append(_finding(
            "critical", "Database is in NOARCHIVELOG mode",
            "Point-in-time recovery is impossible: the only restore available is to the moment of "
            "the last full backup, and everything since is lost. Online backups are not possible "
            "either.",
            f"v$database.log_mode = {log_mode}",
        ))

    jobs_read = "jobs" not in unavailable
    completed = [j for j in jobs if j.get("status", "").upper().startswith("COMPLETED")]
    db_jobs = [j for j in completed if "DB" in j.get("input_type", "").upper()]
    full_jobs = [j for j in db_jobs if j.get("input_type", "").upper() == "DB FULL"]
    arch_jobs = [j for j in completed if "ARCHIVELOG" in j.get("input_type", "").upper()]

    if not jobs_read:
        unread("jobs", "Backup job history could not be read",
               "v$rman_backup_job_details did not answer, so this page cannot say when — or "
               "whether — this instance was last backed up. Treat every backup claim here as "
               "unverified until the view reads.")
    elif not jobs:
        findings.append(_finding(
            "critical", "No RMAN backup has ever been recorded",
            "v$rman_backup_job_details is empty. Either this instance has never been backed up "
            "with RMAN, or its control file records were reset.",
            "v$rman_backup_job_details returned no rows",
        ))
    elif not db_jobs:
        findings.append(_finding(
            "critical", "No completed database backup on record",
            "RMAN has run, but no job with a datafile input type has completed. Archivelog-only "
            "backups cannot restore a database on their own.",
            f"{len(jobs)} job(s) on record, none of input type DB FULL or DB INCR",
        ))
    else:
        newest = db_jobs[0]
        age_days = round(newest.get("age_hours", 0) / 24, 1)
        if age_days > _FULL_BACKUP_STALE_DAYS:
            findings.append(_finding(
                "critical" if age_days > _FULL_BACKUP_STALE_DAYS * 2 else "high",
                f"Last database backup is {age_days} days old",
                f"Nothing newer than {newest.get('end_time')} can be restored. The recovery point "
                "is only as recent as this backup plus whatever archivelogs survive.",
                f"{newest.get('input_type')} completed {newest.get('end_time')}",
            ))
        if not full_jobs:
            findings.append(_finding(
                "high", "Only incremental backups on record",
                "Every backup here is an incremental. Incrementals are useless without the level 0 "
                "or full backup they build on — confirm that base backup still exists.",
                f"{len(db_jobs)} database job(s), none of input type DB FULL",
            ))

    failed = [j for j in jobs if j.get("status", "").upper() in ("FAILED", "COMPLETED WITH ERRORS")]
    recent_failed = [j for j in failed if j.get("age_hours", 0) <= 24 * 7]
    if jobs_read and recent_failed:
        findings.append(_finding(
            "high", f"{len(recent_failed)} backup job(s) failed in the last 7 days",
            "A failed job leaves a gap in the recovery chain even when the next one succeeds, "
            "because the window it covered was never captured.",
            "most recent: " + ", ".join(
                f"{j.get('input_type')} at {j.get('start_time')}" for j in recent_failed[:3]
            ),
        ))

    warned = [j for j in jobs if j.get("status", "").upper() == "COMPLETED WITH WARNINGS"]
    if jobs_read and warned:
        findings.append(_finding(
            "medium", f"{len(warned)} job(s) completed with warnings",
            "RMAN finished but reported something it was unhappy about — commonly a file it could "
            "not read, or a piece it could not write. The job log says which.",
            f"{len(warned)} of {len(jobs)} job(s) on record",
        ))

    if "hot_backup" in unavailable:
        unread("hot_backup", "Could not check for datafiles in hot backup mode",
               "v$backup did not answer. A datafile left in BEGIN BACKUP is invisible to this "
               "page until it does.")
    elif hot_files:
        longest = max(hot_files, key=lambda f: f.get("hours_open", 0))
        findings.append(_finding(
            "critical", f"{len(hot_files)} datafile(s) stuck in hot backup mode",
            "Each of these is writing whole block images into redo instead of change vectors, and "
            "the instance will refuse to open after a crash until END BACKUP is issued. This is "
            "almost always a user-managed backup script that died between BEGIN and END.",
            f"longest open {longest.get('hours_open')}h — {longest.get('file_name')}",
        ))

    never = [c for c in coverage if not c.get("last_backup")]
    if "coverage" in unavailable:
        unread("coverage", "Could not check per-datafile backup coverage",
               "v$backup_datafile or v$datafile did not answer, so whether every datafile has a "
               "backup is unknown.")
    elif never:
        findings.append(_finding(
            "critical", f"{len(never)} datafile(s) have never been backed up",
            "A restore cannot complete without every datafile. One missing file makes the whole "
            "backup set unusable for a full recovery.",
            ", ".join(f"file {c.get('file_num')} ({c.get('tablespace_name')})" for c in never[:4]),
        ))

    if "archivelogs" in unavailable:
        unread("archivelogs", "Could not check for archivelogs awaiting backup",
               "v$archived_log did not answer, so the size of the data-loss window is unknown.")
    elif archivelogs.get("count"):
        findings.append(_finding(
            "medium" if archivelogs["count"] < 50 else "high",
            f"{archivelogs['count']} archivelog(s) not yet backed up",
            "These exist only on the archive destination. If that storage is what fails, the "
            "recovery window ends at the last archivelog that was backed up — not at the last "
            "one written.",
            f"{archivelogs['mb']} MB, oldest {archivelogs.get('oldest') or 'unknown'}",
        ))

    if jobs_read and arch_jobs:
        arch_age = arch_jobs[0].get("age_hours", 0)
        if arch_age > _ARCHIVELOG_BACKUP_STALE_HOURS:
            findings.append(_finding(
                "medium", f"Last archivelog backup is {round(arch_age, 1)} hours old",
                "Archivelog backups are what shorten the data-loss window between full backups. "
                "The gap since the last one is the exposure.",
                f"completed {arch_jobs[0].get('end_time')}",
            ))

    pct = (fra or {}).get("pct_used", 0)
    if (fra or {}).get("configured") and pct >= _FRA_WARN_PCT:
        findings.append(_finding(
            "critical" if pct >= _FRA_CRIT_PCT else "high",
            f"Fast Recovery Area is {pct}% full",
            "A full FRA does not degrade gracefully: the instance hangs the moment it cannot "
            "archive. Reclaimable space is only reclaimed when RMAN is allowed to delete, so "
            "check the retention policy and the deletion job, not just the size.",
            f"{fra.get('used_gb')} GB of {fra.get('limit_gb')} GB used, "
            f"{fra.get('reclaimable_gb')} GB reclaimable",
        ))

    config_read = "config" not in unavailable
    autobackup = next(
        (c for c in config if "CONTROLFILE AUTOBACKUP" == c.get("name", "").upper()), None
    )
    # v$rman_configuration only records non-default settings, so the absence of
    # a row means the default — and the default for controlfile autobackup is
    # OFF. Reporting that as "unknown" would be the comfortable answer and the
    # wrong one.
    if config_read and (autobackup is None or autobackup.get("value", "").upper() == "OFF"):
        findings.append(_finding(
            "high", "Controlfile autobackup is off",
            "Without it, losing the control file means recovering with a far more awkward "
            "procedure, and RMAN has no record of backups taken after the last control file "
            "backup.",
            "v$rman_configuration has no CONTROLFILE AUTOBACKUP ON row (default is OFF)"
            if autobackup is None else f"CONTROLFILE AUTOBACKUP = {autobackup.get('value')}",
        ))

    retention = next(
        (c for c in config if "RETENTION POLICY" == c.get("name", "").upper()), None
    )
    if config_read and retention and "NONE" in retention.get("value", "").upper():
        findings.append(_finding(
            "medium", "Retention policy is set to NONE",
            "Nothing is ever considered obsolete, so RMAN will never report backups as reclaimable "
            "and the FRA or backup volume grows without bound.",
            f"RETENTION POLICY = {retention.get('value')}",
        ))

    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    findings.sort(key=lambda f: rank.get(f["severity"], 9))
    return findings


def build_summary(db_facts, jobs, hot_files, coverage, archivelogs, fra, findings,
                  unavailable=None):
    """The tile row: the few numbers that answer "are we covered right now".

    `available` rides along so the UI can render "Unknown" for a reading that
    failed. A tile that says "Never" when the query errored is worse than no
    tile at all — it is a wrong answer with a confident face on it.
    """
    unavailable = set(unavailable or ())
    completed = [j for j in jobs if j.get("status", "").upper().startswith("COMPLETED")]
    db_jobs   = [j for j in completed if "DB" in j.get("input_type", "").upper()]
    arch_jobs = [j for j in completed if "ARCHIVELOG" in j.get("input_type", "").upper()]
    running   = [j for j in jobs if j.get("status", "").upper() == "RUNNING"]
    failed_7d = [
        j for j in jobs
        if j.get("status", "").upper() in ("FAILED", "COMPLETED WITH ERRORS")
        and j.get("age_hours", 0) <= 24 * 7
    ]

    jobs_read = "jobs" not in unavailable
    return {
        "available": {
            "jobs":        jobs_read,
            "coverage":    "coverage" not in unavailable,
            "archivelogs": "archivelogs" not in unavailable,
            "fra":         "fra" not in unavailable,
            "config":      "config" not in unavailable,
            "database":    "database" not in unavailable,
            "hot_backup":  "hot_backup" not in unavailable,
        },
        "log_mode":            (db_facts or {}).get("log_mode", ""),
        "database_role":       (db_facts or {}).get("database_role", ""),
        "last_db_backup":      db_jobs[0] if (jobs_read and db_jobs) else None,
        "last_archivelog":     arch_jobs[0] if (jobs_read and arch_jobs) else None,
        "running":             len(running),
        "failed_7d":           len(failed_7d),
        "total_jobs":          len(jobs),
        "hot_backup_files":    len(hot_files),
        "datafiles":           len(coverage),
        "datafiles_never":     len([c for c in coverage if not c.get("last_backup")]),
        "unbacked_archivelogs": archivelogs.get("count", 0),
        "fra_pct_used":        (fra or {}).get("pct_used", 0),
        "fra_configured":      bool((fra or {}).get("configured")),
        "worst_severity":      findings[0]["severity"] if findings else "ok",
    }


# ──────────────────────────────────────────────────────────────
#  Entry points
# ──────────────────────────────────────────────────────────────

def _rman_backup_inner(conn_id: int, db: Session):
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    # Which readings could not be taken. The findings engine needs this to tell
    # "looked, and it is not there" from "could not look".
    unavailable = set()

    db_facts    = _database_facts(engine, errors, unavailable)
    jobs        = _jobs(engine, errors, unavailable)
    # The latest full / incremental / archivelog backup, however old, so the
    # findings can never miss one because the window scrolled past it.
    if "jobs" not in unavailable:
        jobs = merge_anchor_jobs(jobs, _anchor_jobs(engine, errors))
    config      = _configuration(engine, errors, unavailable)
    hot_files   = _hot_backup_files(engine, errors, unavailable)
    coverage    = _datafile_coverage(engine, errors, unavailable)
    archivelogs = _unbacked_archivelogs(engine, errors, unavailable)
    fra, fra_usage = _fra(engine, errors, unavailable)

    findings = build_findings(db_facts, jobs, config, hot_files, coverage, archivelogs, fra,
                              unavailable)
    summary  = build_summary(db_facts, jobs, hot_files, coverage, archivelogs, fra, findings,
                             unavailable)

    return {
        "status":      "success",
        "database":    db_facts,
        "summary":     summary,
        "findings":    findings,
        "jobs":        jobs,
        "job_window_days": JOB_HISTORY_DAYS,
        "config":      config,
        "hot_backup":  hot_files,
        # The full list is useful but long; the UI pages it, and the ones that
        # matter (never backed up, oldest) sort to the top already.
        "coverage":    coverage,
        "archivelogs": archivelogs,
        "fra":         fra,
        "fra_usage":   fra_usage,
        "errors":      errors,
    }


def oracle_rman_backup(conn_id: int, db: Session):
    return _run_with_timeout(
        _rman_backup_inner, conn_id, db,
        default=_timeout_error(), label="oracle_rman_backup",
    )


def _rman_job_detail_inner(conn_id: int, db: Session, session_key: int):
    """What RMAN actually said, for one job.

    v$rman_output is memory-resident and bounded — it holds recent output only
    and is empty after an instance restart. An empty log is therefore normal
    for an old job and is reported as such, not as a failure.
    """
    conn   = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    job = None
    try:
        raw = _rows(engine, """
            SELECT session_key, input_type, status,
                   TO_CHAR(start_time,'YYYY-MM-DD HH24:MI:SS') AS start_time,
                   TO_CHAR(end_time,'YYYY-MM-DD HH24:MI:SS')   AS end_time,
                   ROUND(input_bytes / 1073741824, 3)          AS input_gb,
                   ROUND(output_bytes / 1073741824, 3)         AS output_gb,
                   elapsed_seconds, output_device_type
            FROM   v$rman_backup_job_details
            WHERE  session_key = :sk""", {"sk": session_key})
        if raw:
            r = raw[0]
            job = {
                "session_key":     _safe_int(r.get("SESSION_KEY")),
                "input_type":      _safe_str(r.get("INPUT_TYPE")),
                "status":          _safe_str(r.get("STATUS")),
                "start_time":      _safe_str(r.get("START_TIME")),
                "end_time":        _safe_str(r.get("END_TIME")),
                "input_gb":        round(_safe_float(r.get("INPUT_GB")), 3),
                "output_gb":       round(_safe_float(r.get("OUTPUT_GB")), 3),
                "elapsed_seconds": _safe_int(r.get("ELAPSED_SECONDS")),
                "output_device_type": _safe_str(r.get("OUTPUT_DEVICE_TYPE")),
            }
    except Exception as exc:
        errors.append(f"job: {exc}")

    output = []
    try:
        raw = _rows(engine, """
            SELECT recid, output
            FROM   v$rman_output
            WHERE  session_key = :sk
            ORDER  BY recid
            FETCH FIRST 2000 ROWS ONLY""", {"sk": session_key})
        output = [_safe_str(r.get("OUTPUT")) for r in raw]
    except Exception as exc:
        errors.append(f"rman_output: {exc}")

    # Backup sets are a best-effort extra: the session_key column on
    # v$backup_set_details is not present on every release, so a failure here
    # costs the sets panel and nothing else.
    sets = []
    try:
        raw = _rows(engine, """
            SELECT bs_key, backup_type, controlfile_included, incremental_level,
                   pieces, device_type, compressed,
                   ROUND(original_input_bytes / 1073741824, 3) AS input_gb,
                   ROUND(output_bytes / 1073741824, 3)         AS output_gb,
                   elapsed_seconds,
                   TO_CHAR(completion_time,'YYYY-MM-DD HH24:MI:SS') AS completion_time
            FROM   v$backup_set_details
            WHERE  session_key = :sk
            ORDER  BY completion_time""", {"sk": session_key})
        sets = [
            {"bs_key": _safe_int(r.get("BS_KEY")), "backup_type": _safe_str(r.get("BACKUP_TYPE")),
             "controlfile_included": _safe_str(r.get("CONTROLFILE_INCLUDED")),
             "incremental_level": _safe_int(r.get("INCREMENTAL_LEVEL")),
             "pieces": _safe_int(r.get("PIECES")), "device_type": _safe_str(r.get("DEVICE_TYPE")),
             "compressed": _safe_str(r.get("COMPRESSED")),
             "input_gb": round(_safe_float(r.get("INPUT_GB")), 3),
             "output_gb": round(_safe_float(r.get("OUTPUT_GB")), 3),
             "elapsed_seconds": _safe_int(r.get("ELAPSED_SECONDS")),
             "completion_time": _safe_str(r.get("COMPLETION_TIME"))}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"backup_sets: {exc}")

    return {"status": "success", "session_key": session_key, "job": job,
            "output": output, "sets": sets, "errors": errors}


def oracle_rman_job_detail(conn_id: int, db: Session, session_key: int):
    return _run_with_timeout(
        _rman_job_detail_inner, conn_id, db, session_key,
        default=_timeout_error(), label="oracle_rman_job_detail",
    )
