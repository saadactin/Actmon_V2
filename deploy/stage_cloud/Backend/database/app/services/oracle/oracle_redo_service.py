"""
Oracle redo generation — how many log switches, and how much redo, per hour.

Built from the two scripts the DBA team uses (redo_hour.sql: switches per hour
per day; redo2.sql: megabytes per hour), with three corrections that matter on
this estate, which is RAC:

1. SWITCHES COME FROM v$log_history, NOT gv$log_history.
   The log history lives in the control file, and the control file is shared
   by every instance. v$log_history on any one instance already lists every
   thread's switches. gv$log_history asks each instance for that same list and
   concatenates the answers — so on a two-node cluster every count is DOUBLED.
   redo_hour.sql uses gv$log_history.

2. VOLUME COMES FROM v$archived_log, NOT "switches x log size".
   redo2.sql multiplies the number of switches by the size of log group 1. That
   is the CONFIGURED size of a log, not what was written to it: a log switched
   early (ARCHIVE_LAG_TARGET, a manual `alter system switch logfile`, a
   shutdown) is counted as full. v$archived_log records the bytes actually
   archived (blocks x block_size). Two more wrinkles are handled:
     - one log is archived once per destination, so rows are de-duplicated on
       (thread#, sequence#, resetlogs_change#) before summing — otherwise a
       second archive destination doubles the volume;
     - in NOARCHIVELOG mode there is nothing in v$archived_log, and only then
       is the switches x log-size estimate used, labelled as an estimate.
   redo2.sql also joins gv$log and gv$database with no join condition, which
   on two nodes is 2 x 2 = 4 copies of every hour.

3. DAYS ARE TRUNC(first_time), NOT to_date(first_time).
   first_time is already a DATE. to_date() on it converts to text through
   NLS_DATE_FORMAT and back; with the default DD-MON-RR that happens to drop
   the time, but a session with a different NLS format either fails or groups
   by the wrong key.

Everything here is a read of v$ views — nothing is executed against user data.
"""
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404,
    _get_engine,
    _rows,
    _run_with_timeout,
    _safe_float,
    _safe_int,
    _safe_str,
    _timeout_error,
)

# A commonly cited operating target is a log switch every 15-20 minutes at
# peak — about 3-4 per hour per thread. More than that sustained means the
# logs are too small for the workload, and every switch costs a checkpoint.
SWITCHES_PER_HOUR_TARGET = 4
DEFAULT_DAYS = 14
MAX_DAYS = 90


# ── reads ──────────────────────────────────────────────────────────────────

def _switches(engine, days, errors):
    """Switches per (day, hour, thread), from the shared control file."""
    try:
        raw = _rows(engine, """
            SELECT TO_CHAR(TRUNC(first_time), 'YYYY-MM-DD') AS day,
                   TO_NUMBER(TO_CHAR(first_time, 'HH24'))   AS hr,
                   thread#                                  AS thread,
                   COUNT(*)                                 AS switches
            FROM   v$log_history
            WHERE  first_time >= TRUNC(SYSDATE) - (:days - 1)
            GROUP  BY TRUNC(first_time), TO_CHAR(first_time, 'HH24'), thread#""",
            {"days": days})
        return [
            {"day": _safe_str(r.get("DAY")), "hour": _safe_int(r.get("HR")),
             "thread": _safe_int(r.get("THREAD")), "switches": _safe_int(r.get("SWITCHES"))}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"switches: {exc}")
        return None


def _archived_volume(engine, days, errors):
    """Bytes actually archived per (day, hour, thread), one row per log."""
    try:
        raw = _rows(engine, """
            SELECT TO_CHAR(TRUNC(first_time), 'YYYY-MM-DD') AS day,
                   TO_NUMBER(TO_CHAR(first_time, 'HH24'))   AS hr,
                   thread#                                  AS thread,
                   COUNT(*)                                 AS logs,
                   ROUND(SUM(bytes) / 1048576, 2)           AS mb
            FROM (
                SELECT thread#, sequence#,
                       MIN(first_time)          AS first_time,
                       MAX(blocks * block_size) AS bytes
                FROM   v$archived_log
                WHERE  first_time >= TRUNC(SYSDATE) - (:days - 1)
                  AND  standby_dest = 'NO'
                GROUP  BY thread#, sequence#, resetlogs_change#
            )
            GROUP  BY TRUNC(first_time), TO_CHAR(first_time, 'HH24'), thread#""",
            {"days": days})
        return [
            {"day": _safe_str(r.get("DAY")), "hour": _safe_int(r.get("HR")),
             "thread": _safe_int(r.get("THREAD")), "logs": _safe_int(r.get("LOGS")),
             "mb": round(_safe_float(r.get("MB")), 2)}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"archived_volume: {exc}")
        return None


def _log_sizes(engine, errors):
    """Online redo log size per thread — what a switch represents when full."""
    try:
        raw = _rows(engine, """
            SELECT thread#                       AS thread,
                   COUNT(*)                      AS groups,
                   MAX(members)                  AS members,
                   ROUND(MIN(bytes) / 1048576)   AS min_mb,
                   ROUND(MAX(bytes) / 1048576)   AS max_mb
            FROM   v$log
            GROUP  BY thread#
            ORDER  BY thread#""")
        return [
            {"thread": _safe_int(r.get("THREAD")), "groups": _safe_int(r.get("GROUPS")),
             "members": _safe_int(r.get("MEMBERS")),
             "min_mb": _safe_float(r.get("MIN_MB")), "max_mb": _safe_float(r.get("MAX_MB"))}
            for r in raw
        ]
    except Exception as exc:
        errors.append(f"log_sizes: {exc}")
        return None


def _database(engine, errors):
    try:
        rows = _rows(engine, "SELECT name, log_mode FROM v$database")
        if rows:
            return {"name": _safe_str(rows[0].get("NAME")),
                    "log_mode": _safe_str(rows[0].get("LOG_MODE"))}
    except Exception as exc:
        errors.append(f"database: {exc}")
    return {"name": "", "log_mode": ""}


# ── the summary (pure) ─────────────────────────────────────────────────────

def _nice_size_mb(mb):
    """Round a suggested log size up to a size a DBA would actually pick."""
    for step in (256, 512, 1024, 2048, 4096, 8192, 16384, 32768):
        if mb <= step:
            return step
    return int(-(-mb // 32768) * 32768)


def build_redo_summary(switches, volume, log_sizes, days, today=None, log_mode=""):
    """Turn the three reads into the heatmap, the series and the findings.

    Pure: no database, so every rule here can be tested. `None` for a read
    means it FAILED, which is different from an empty list (read, nothing
    there) — the result says which.
    """
    today = today or date.today()
    # Exactly `days` calendar days, today included — "last 14 days" is 14 rows.
    day_list = [(today - timedelta(days=d)).isoformat() for d in range(days - 1, -1, -1)]

    # Thread -> configured log size, for the NOARCHIVELOG estimate.
    size_by_thread = {s["thread"]: s["max_mb"] for s in (log_sizes or [])}

    # Volume: measured when v$archived_log has rows; otherwise estimated from
    # switches, and said so.
    volume_source = None
    vol_by_cell = {}
    if volume:
        volume_source = "archived"
        for v in volume:
            key = (v["day"], v["hour"])
            vol_by_cell[key] = vol_by_cell.get(key, 0.0) + v["mb"]
    elif switches and size_by_thread:
        volume_source = "estimated"
        for s in switches:
            key = (s["day"], s["hour"])
            vol_by_cell[key] = vol_by_cell.get(key, 0.0) + s["switches"] * size_by_thread.get(s["thread"], 0)

    matrix = []
    peak = None            # busiest hour, all threads together
    thread_peak = None     # busiest (hour, thread) — what sizing should answer to
    threads = sorted({s["thread"] for s in (switches or [])})
    total_switches = 0
    by_cell = {}
    for s in (switches or []):
        by_cell.setdefault((s["day"], s["hour"]), {})
        by_cell[(s["day"], s["hour"])][s["thread"]] = s["switches"]
        if not thread_peak or s["switches"] > thread_peak["switches"]:
            thread_peak = dict(s)

    if switches is not None:
        for d in day_list:
            hours, mb_hours, day_total, day_mb = [], [], 0, 0.0
            per_thread = {t: 0 for t in threads}
            for h in range(24):
                cell = by_cell.get((d, h), {})
                n = sum(cell.values())
                hours.append(n)
                day_total += n
                for t, c in cell.items():
                    per_thread[t] = per_thread.get(t, 0) + c
                mb = round(vol_by_cell.get((d, h), 0.0), 2) if volume_source else None
                mb_hours.append(mb)
                if mb is not None:
                    day_mb += mb
                if n and (not peak or n > peak["switches"]):
                    peak = {"day": d, "hour": h, "switches": n, "mb": mb}
            total_switches += day_total
            matrix.append({
                "day": d,
                "hours": hours,
                "total": day_total,
                "by_thread": per_thread,
                "mb_hours": mb_hours,
                "mb_total": round(day_mb, 2) if volume_source else None,
            })

    days_with_data = [m for m in matrix if m["total"]]
    total_mb = round(sum(m["mb_total"] or 0 for m in matrix), 2) if volume_source else None

    findings = []
    if switches is None:
        findings.append({"severity": "info", "title": "Log switch history could not be read",
                         "detail": "v$log_history did not answer, so nothing on this page is a reading."})
    elif not total_switches:
        findings.append({"severity": "info", "title": "No log switches in the window",
                         "detail": f"v$log_history has no switch in the last {days} days."})

    recommended_mb = None
    if thread_peak and thread_peak["switches"] > SWITCHES_PER_HOUR_TARGET:
        current = size_by_thread.get(thread_peak["thread"]) or 0
        if current:
            recommended_mb = _nice_size_mb(current * thread_peak["switches"] / SWITCHES_PER_HOUR_TARGET)
        findings.append({
            "severity": "warning" if thread_peak["switches"] <= SWITCHES_PER_HOUR_TARGET * 3 else "critical",
            "title": f"Up to {thread_peak['switches']} log switches an hour on thread {thread_peak['thread']}",
            "detail": (
                f"Peak at {thread_peak['day']} {thread_peak['hour']:02d}:00. About "
                f"{SWITCHES_PER_HOUR_TARGET} an hour per thread is a common target; every switch "
                "forces a checkpoint, and sustained switching above it usually means the logs are "
                "too small for the workload."
                + (f" At the peak rate, logs of about {recommended_mb} MB (currently {int(current)} MB) "
                   f"would bring it back to {SWITCHES_PER_HOUR_TARGET} an hour." if recommended_mb else "")
            ),
        })

    if volume_source == "estimated":
        findings.append({
            "severity": "info", "title": "Redo volume is estimated, not measured",
            "detail": ("v$archived_log has no rows for this window"
                       + (" — the database is in NOARCHIVELOG mode" if log_mode and log_mode != "ARCHIVELOG" else "")
                       + ", so volume is switches x configured log size. A log switched before it "
                       "was full is counted as full, so these figures are an upper bound."),
        })

    sizes = [s["max_mb"] for s in (log_sizes or []) if s["max_mb"]]
    if log_sizes and len(set(s["min_mb"] for s in log_sizes) | set(sizes)) > 1:
        findings.append({
            "severity": "info", "title": "Redo logs are not all the same size",
            "detail": "Groups of different sizes switch at different rates, which makes the per-hour "
                      "counts hard to compare. Oracle recommends equal-sized online logs.",
        })

    return {
        "days": days,
        "threads": threads,
        "matrix": matrix,
        "volume_source": volume_source,
        "stats": {
            "total_switches": total_switches,
            "avg_switches_per_day": round(total_switches / len(days_with_data), 1) if days_with_data else 0,
            "max_switches_per_hour": peak["switches"] if peak else 0,
            "peak": peak,
            "thread_peak": thread_peak,
            "total_mb": total_mb,
            "avg_mb_per_day": round(total_mb / len(days_with_data), 2) if (total_mb and days_with_data) else None,
            "switch_target_per_hour": SWITCHES_PER_HOUR_TARGET,
            "recommended_log_mb": recommended_mb,
        },
        "findings": findings,
    }


# ── entry point ─────────────────────────────────────────────────────────────

def _redo_generation_inner(conn_id: int, db: Session, days: int):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    switches = _switches(engine, days, errors)
    volume = _archived_volume(engine, days, errors)
    sizes = _log_sizes(engine, errors)
    dbi = _database(engine, errors)

    summary = build_redo_summary(switches, volume, sizes, days, log_mode=dbi["log_mode"])
    return {
        "status": "success",
        "database": dbi,
        "log_sizes": sizes or [],
        **summary,
        "errors": errors,
        "read_at": datetime.utcnow().isoformat(),
    }


def oracle_redo_generation(conn_id: int, db: Session, days: int = DEFAULT_DAYS):
    days = max(1, min(MAX_DAYS, int(days or DEFAULT_DAYS)))
    return _run_with_timeout(
        _redo_generation_inner, conn_id, db, days,
        default=_timeout_error(), label="oracle_redo_generation",
    )
