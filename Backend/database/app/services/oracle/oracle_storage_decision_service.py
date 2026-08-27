"""
Oracle Storage Health — Phase 2 decision engine.

Turns Phase 1's read-only collector output (oracle_storage_service.py,
oracle_monitoring_service.py) into evidence-based findings: healthy / monitor
/ warning / critical, each grounded in a real signal, never a guess. No
mutating SQL, no persistence, no approval workflow — that's Phase 3. Every
finding is computed live on each call, the same "no black-box scoring" shape
as mysql_slow_query_analysis_service.py's diagnose(): a flat list of dicts,
each carrying its own evidence, sorted by severity.

Thresholds below are deliberately conservative and code-level constants —
see the Phase 2 plan for the reasoning behind each one (in particular: index
fragmentation alone NEVER recommends a rebuild, and aging partitions NEVER
exceed "monitor" — both are explicit non-goals, not oversights).
"""

import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404, _get_engine, _safe_float, _safe_int, _safe_str,
    oracle_tablespaces, oracle_datafile_mounts, oracle_index_analysis,
)
from app.services.oracle.oracle_storage_service import (
    oracle_storage_segments, oracle_storage_partitions,
)

_SEVERITY_RANK = {"critical": 0, "warning": 1, "monitor": 2, "healthy": 3}

# ── Tablespace thresholds ────────────────────────────────────────────────
TS_CRITICAL_USED_PCT = 90
TS_CRITICAL_DAYS_TO_FULL = 7
TS_CRITICAL_USED_PCT_ANY = 95
TS_WARNING_USED_PCT = 85
TS_WARNING_USED_PCT_WITH_TREND = 70
TS_WARNING_DAYS_TO_FULL = 30
TS_MONITOR_USED_PCT = 70
GROWTH_HISTORY_MINUTES = 60 * 24 * 30  # 30 days

# ── Datafile thresholds ──────────────────────────────────────────────────
DF_WARNING_PCT_OF_MAX = 85

# ── Segment (shrink/move candidate) thresholds ───────────────────────────
SEGMENT_SIZE_FLOOR_MB = 100
SEGMENT_LARGE_MB = 1024
SEGMENT_CRITICAL_RECLAIM_PCT = 60
SEGMENT_WARNING_RECLAIM_PCT = 40
SEGMENT_MONITOR_RECLAIM_PCT = 20
STATS_STALE_DAYS = 30

# ── Partition thresholds ─────────────────────────────────────────────────
PARTITION_AGING_DAYS = 400

_HIGH_VALUE_DATE_RE = re.compile(r"'\s*(\d{4}-\d{2}-\d{2})")


def _finding(object_type, object_name, tablespace_name, status, problem,
             evidence, recommended_action, expected_benefit, risk):
    return {
        "object_type": object_type,
        "object_name": object_name,
        "tablespace_name": tablespace_name,
        "status": status,
        "problem": problem,
        "evidence": evidence,
        "recommended_action": recommended_action,
        "expected_benefit": expected_benefit,
        "risk": risk,
    }


# ── Growth rate (ClickHouse history) ─────────────────────────────────────

def _tablespace_growth_map(conn_id):
    """Returns {tablespace_name: {mb_per_day, days_to_full, insufficient_history}}.
    Linear delta between the earliest and latest sample in the last 30 days —
    fewer than a day's spread between samples is explicitly reported as
    insufficient history, never guessed as zero growth."""
    try:
        from app.services.clickhouse import metrics_history_service as ch
        rows = ch.query_oracle_storage(conn_id, metric_type="tablespace", minutes=GROWTH_HISTORY_MINUTES)
    except Exception:
        rows = []

    by_object = {}
    for r in rows:
        try:
            ts = datetime.strptime(r["ts"][:19], "%Y-%m-%d %H:%M:%S")
        except Exception:
            continue
        by_object.setdefault(r["object_name"], []).append((ts, _safe_float(r.get("size_mb")), _safe_float(r.get("total_mb"))))

    result = {}
    for name, samples in by_object.items():
        samples.sort(key=lambda s: s[0])
        first_ts, first_mb, _ = samples[0]
        last_ts, last_mb, last_total = samples[-1]
        span_days = (last_ts - first_ts).total_seconds() / 86400
        if span_days < 1:
            result[name] = {"mb_per_day": None, "days_to_full": None, "insufficient_history": True}
            continue
        mb_per_day = (last_mb - first_mb) / span_days
        days_to_full = None
        if mb_per_day > 0:
            free_mb = max(last_total - last_mb, 0)
            days_to_full = round(free_mb / mb_per_day, 1)
        result[name] = {"mb_per_day": round(mb_per_day, 2), "days_to_full": days_to_full, "insufficient_history": False}
    return result


# ── Evaluators ────────────────────────────────────────────────────────────

def evaluate_tablespaces(tablespaces, datafiles, growth_map):
    autoextend_on = {}
    for df in datafiles:
        ts_name = df.get("tablespace")
        autoextend_on.setdefault(ts_name, False)
        if df.get("autoextend") == "YES":
            autoextend_on[ts_name] = True

    findings = []
    for t in tablespaces:
        name = t["tablespace_name"]
        used_pct = t.get("used_pct") or 0
        growth = growth_map.get(name, {"mb_per_day": None, "days_to_full": None, "insufficient_history": True})
        days_to_full = growth["days_to_full"]
        can_autoextend = autoextend_on.get(name, False)

        status, problem, action, benefit = "healthy", "Utilization within normal range.", "no_action", "None needed."
        if used_pct > TS_CRITICAL_USED_PCT_ANY or (used_pct > TS_CRITICAL_USED_PCT and days_to_full is not None and days_to_full < TS_CRITICAL_DAYS_TO_FULL):
            status = "critical"
            problem = "Tablespace is nearly full and will exhaust space soon at current growth."
            action, benefit = "tablespace_datafile_management", "Prevents an out-of-space outage for objects in this tablespace."
        elif not can_autoextend and used_pct > TS_WARNING_USED_PCT:
            status = "critical"
            problem = "Tablespace is highly utilized and no datafile has autoextend enabled — it cannot grow automatically."
            action, benefit = "tablespace_datafile_management", "Prevents an immediate out-of-space failure on the next write."
        elif used_pct > TS_WARNING_USED_PCT or (used_pct > TS_WARNING_USED_PCT_WITH_TREND and days_to_full is not None and days_to_full < TS_WARNING_DAYS_TO_FULL):
            status = "warning"
            problem = "Tablespace utilization is high."
            action, benefit = "tablespace_datafile_management", "Adding space now avoids an urgent/unplanned resize later."
        elif used_pct > TS_MONITOR_USED_PCT:
            status = "monitor"
            problem = "Tablespace utilization is trending up."
            action, benefit = "continue_monitoring", "Early visibility before this becomes urgent."

        if growth["insufficient_history"]:
            evidence = f"used={used_pct}%, autoextend_enabled={can_autoextend}, growth trend unavailable (insufficient history)."
        else:
            dtf = f"{days_to_full}d to full" if days_to_full is not None else "not growing"
            evidence = f"used={used_pct}%, autoextend_enabled={can_autoextend}, growth={growth['mb_per_day']}MB/day ({dtf})."

        findings.append(_finding(
            "tablespace", name, name, status, problem, evidence, action, benefit,
            "None — this is a read-only assessment; any datafile resize requires separate administrator action." if status != "healthy" else "None.",
        ))
    return findings


def evaluate_datafiles(datafiles):
    findings = []
    for df in datafiles:
        if df.get("autoextend") == "YES" and (df.get("max_gb") or 0) > 0:
            pct = (df["size_gb"] / df["max_gb"]) * 100
            if pct >= DF_WARNING_PCT_OF_MAX:
                findings.append(_finding(
                    "datafile", df.get("file_name"), df.get("tablespace"), "warning",
                    "Datafile is approaching its own configured MAXSIZE — autoextend cannot help once that limit is hit.",
                    f"size={df['size_gb']}GB, maxsize={df['max_gb']}GB ({round(pct, 1)}% of configured max).",
                    "tablespace_datafile_management",
                    "Raising MAXSIZE or adding a datafile now avoids a hard stop when growth continues.",
                    "None — assessment only; changing MAXSIZE/adding a datafile requires separate administrator action.",
                ))
    return findings


def evaluate_segments(segments):
    findings = []
    for s in segments:
        if s.get("segment_type") != "TABLE":
            continue
        size_mb = s.get("size_mb") or 0
        if size_mb < SEGMENT_SIZE_FLOOR_MB:
            continue
        num_rows = s.get("num_rows")
        avg_row_len = s.get("avg_row_len")
        if num_rows is None or avg_row_len is None:
            continue
        used_est_mb = (num_rows * avg_row_len) / (1024 * 1024)
        reclaimable_mb = max(size_mb - used_est_mb, 0)
        reclaimable_pct = round((reclaimable_mb / size_mb) * 100, 1) if size_mb else 0

        stale = True
        if s.get("last_analyzed"):
            try:
                analyzed = datetime.strptime(s["last_analyzed"][:19], "%Y-%m-%d %H:%M:%S")
                stale = (datetime.now() - analyzed).days > STATS_STALE_DAYS
            except Exception:
                stale = True

        status = "healthy"
        if size_mb >= SEGMENT_LARGE_MB and reclaimable_pct >= SEGMENT_CRITICAL_RECLAIM_PCT:
            status = "critical"
        elif size_mb >= SEGMENT_LARGE_MB and reclaimable_pct >= SEGMENT_WARNING_RECLAIM_PCT:
            status = "warning"
        elif reclaimable_pct >= SEGMENT_MONITOR_RECLAIM_PCT:
            status = "monitor"
        if status == "healthy":
            continue
        if stale and status != "monitor":
            status = "monitor"

        row_movement = (s.get("row_movement") or "DISABLED").upper()
        action = "shrink_space" if row_movement == "ENABLED" else "move"
        risk = ("Online operation; briefly holds a lock during the final phase." if action == "shrink_space"
                else "MOVE rebuilds the segment and invalidates dependent indexes — they will need rebuilding afterward, and this typically needs a maintenance window.")
        evidence = (f"size={size_mb}MB, estimated used={round(used_est_mb, 1)}MB from num_rows={num_rows}*avg_row_len={avg_row_len}, "
                    f"estimated reclaimable={reclaimable_pct}%, row_movement={row_movement}, "
                    f"last_analyzed={s.get('last_analyzed') or 'never'}" + (" (stats stale — treat as an estimate only)" if stale else ""))

        findings.append(_finding(
            "segment", f"{s['owner']}.{s['segment_name']}", s.get("tablespace_name"), status,
            "Table has significant estimated reclaimable space below its high-water mark.",
            evidence, action,
            f"Could reclaim roughly {round(reclaimable_mb, 1)}MB and improve full-scan efficiency on this table.",
            risk,
        ))
    return findings


def evaluate_indexes(index_analysis):
    findings = []
    for idx in index_analysis.get("indexes", []):
        if idx.get("status") == "UNUSABLE":
            findings.append(_finding(
                "index", f"{idx['owner']}.{idx['index_name']}", None, "critical",
                "Index is UNUSABLE — any statement that needs it will fail or silently skip it (non-unique) until rebuilt.",
                f"status=UNUSABLE, table={idx.get('table_name')}",
                "index_maintenance_rebuild",
                "Restores index availability and query correctness/performance for statements that depend on it.",
                "Rebuild holds resources proportional to index size; consider ONLINE rebuild during low-traffic hours.",
            ))
    for f in index_analysis.get("fragmented_indexes", []):
        findings.append(_finding(
            "index", f"{f['owner']}.{f['index_name']}", None, "monitor",
            "B-tree depth heuristic suggests possible internal fragmentation.",
            f"blevel={f['blevel']}, leaf_blocks={f['leaf_blocks']}, fragmentation_pct={f['fragmentation_pct']} "
            "(heuristic only — combine with actual query performance data before considering a rebuild).",
            "continue_monitoring",
            "N/A — fragmentation alone is not sufficient justification for a rebuild.",
            "N/A — no action recommended from this signal alone.",
        ))
    return findings


def evaluate_partitions(partitions):
    findings = []
    now = datetime.now()
    for p in partitions:
        high_value = p.get("high_value") or ""
        m = _HIGH_VALUE_DATE_RE.search(high_value)
        if not m:
            continue
        try:
            part_date = datetime.strptime(m.group(1), "%Y-%m-%d")
        except Exception:
            continue
        age_days = (now - part_date).days
        has_data = (p.get("num_rows") or 0) > 0 or (p.get("size_mb") or 0) > 0
        if age_days > PARTITION_AGING_DAYS and has_data:
            findings.append(_finding(
                "partition", f"{p['owner']}.{p['table_name']}.{p['partition_name']}", None, "monitor",
                "Partition's range boundary is well in the past and still holds data — a candidate for an ILM/retention review.",
                f"high_value date={part_date.date()} (~{age_days} days ago), size={p.get('size_mb')}MB, num_rows={p.get('num_rows')}",
                "partition_maintenance",
                "Evaluate against your retention/ILM policy — archival or compression may free space, but that is a business decision, not a technical one.",
                "None from detection alone — no action is recommended without an explicit administrator decision on retention.",
            ))
    return findings


# ── Orchestrator ──────────────────────────────────────────────────────────

def _fetch_with_own_session(fn, conn_id):
    """Run one collector on its own short-lived Postgres session — the
    Session passed into oracle_storage_findings() is not safe to share
    across threads, and these five collectors otherwise have nothing to do
    with each other (each opens its own Oracle connection too), so there's
    no reason they were ever forced to run one after another."""
    with SessionLocal() as session:
        return fn(conn_id, session)


def oracle_storage_findings(conn_id: int, db: Session):
    errors = []

    # These six were previously awaited one at a time — each is an
    # independent read against Oracle (or ClickHouse, for growth), so
    # sequential execution was pure added latency, not a real dependency.
    # This is the entire reason Storage Health's first load felt slow.
    with ThreadPoolExecutor(max_workers=6) as pool:
        ts_future = pool.submit(_fetch_with_own_session, oracle_tablespaces, conn_id)
        df_future = pool.submit(_fetch_with_own_session, oracle_datafile_mounts, conn_id)
        seg_future = pool.submit(_fetch_with_own_session, oracle_storage_segments, conn_id)
        idx_future = pool.submit(_fetch_with_own_session, oracle_index_analysis, conn_id)
        part_future = pool.submit(_fetch_with_own_session, oracle_storage_partitions, conn_id)
        growth_future = pool.submit(_tablespace_growth_map, conn_id)

        ts_resp = ts_future.result()
        df_resp = df_future.result()
        seg_resp = seg_future.result()
        idx_resp = idx_future.result()
        part_resp = part_future.result()
        growth_map = growth_future.result()

    if ts_resp.get("status") != "success":
        errors.append(f"tablespaces: {ts_resp.get('error', 'failed')}")
        tablespaces = []
    else:
        tablespaces = ts_resp.get("tablespaces", [])

    errors.extend(df_resp.get("errors") or [])
    datafiles = df_resp.get("datafiles", [])

    errors.extend(seg_resp.get("errors") or [])
    segments = seg_resp.get("segments", [])

    errors.extend(idx_resp.get("errors") or [])

    errors.extend(part_resp.get("errors") or [])
    partitions = part_resp.get("partitions", [])

    findings = []
    findings += evaluate_tablespaces(tablespaces, datafiles, growth_map)
    findings += evaluate_datafiles(datafiles)
    findings += evaluate_segments(segments)
    findings += evaluate_indexes(idx_resp)
    findings += evaluate_partitions(partitions)

    findings.sort(key=lambda f: _SEVERITY_RANK.get(f["status"], 9))

    summary = {"healthy": 0, "monitor": 0, "warning": 0, "critical": 0}
    for f in findings:
        summary[f["status"]] = summary.get(f["status"], 0) + 1

    return {
        "status": "success",
        "findings": findings,
        "summary": summary,
        "coverage": {
            "tablespaces_evaluated": len(tablespaces),
            "segments_evaluated": len(segments),
            "indexes_evaluated": len(idx_resp.get("indexes", [])),
            "partitions_evaluated": len(partitions),
        },
        "errors": errors,
    }


# ── On-demand precise reclaimable-space check ──────────────────────────────

def oracle_storage_precise_check(conn_id: int, db: Session, owner: str, segment_name: str, segment_type: str):
    """DBMS_SPACE.SPACE_USAGE via a real OUT-bind PL/SQL call — direct
    (non-agent-routed) Oracle connections only. Fullness buckets fs1-fs4
    represent 0-25%/25-50%/50-75%/75-100% full blocks below the high-water
    mark; unformatted+fs1+fs2+fs3 is the standard heuristic for "reclaimable"
    space a SHRINK could actually recover."""
    from app.services.common import db_proxy_service
    if db_proxy_service.agent_host_for_conn(conn_id, db) is not None:
        raise HTTPException(
            status_code=400,
            detail="Precise reclaimable-space check is only available for direct Oracle connections, not agent-routed ones.",
        )

    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)

    import oracledb
    raw = engine.raw_connection()
    try:
        cur = raw.cursor()
        try:
            cur.call_timeout = 15000
        except Exception:
            pass
        outs = [cur.var(oracledb.DB_TYPE_NUMBER) for _ in range(12)]
        cur.callproc("dbms_space.space_usage", [owner, segment_name, segment_type] + outs)
        vals = [(v.getvalue() or 0) for v in outs]
        (unformatted_blocks, unformatted_bytes, fs1_blocks, fs1_bytes, fs2_blocks, fs2_bytes,
         fs3_blocks, fs3_bytes, fs4_blocks, fs4_bytes, full_blocks, full_bytes) = vals

        reclaimable_bytes = unformatted_bytes + fs1_bytes + fs2_bytes + fs3_bytes
        total_bytes = reclaimable_bytes + fs4_bytes + full_bytes
        reclaimable_pct = round((reclaimable_bytes / total_bytes) * 100, 1) if total_bytes else 0.0

        return {
            "status": "success",
            "owner": owner, "segment_name": segment_name, "segment_type": segment_type,
            "unformatted_mb": round(unformatted_bytes / 1024 / 1024, 2),
            "fs1_mb": round(fs1_bytes / 1024 / 1024, 2),
            "fs2_mb": round(fs2_bytes / 1024 / 1024, 2),
            "fs3_mb": round(fs3_bytes / 1024 / 1024, 2),
            "fs4_mb": round(fs4_bytes / 1024 / 1024, 2),
            "full_mb": round(full_bytes / 1024 / 1024, 2),
            "reclaimable_mb": round(reclaimable_bytes / 1024 / 1024, 2),
            "reclaimable_pct": reclaimable_pct,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DBMS_SPACE.SPACE_USAGE failed: {exc}")
    finally:
        raw.close()
