"""
Oracle Maintenance — real-time telemetry for the 5 maintenance categories
(Table, Index, Statistics, Partition, Space/Storage).

Every number here comes from a live query against the connected Oracle
instance (dba_segments/dba_indexes/dba_tab_partitions/dba_tab_modifications/
dba_recyclebin/dba_tablespace_usage_metrics, etc.) or from this app's own
oracle_maintenance_jobs table (job/history counts) — nothing is mocked or
hardcoded. Reuses oracle_storage_service.py's/oracle_monitoring_service.py's
existing collectors instead of re-querying what they already fetch, and adds
the columns/joins the Maintenance module needs beyond what Storage Health's
narrower Phase 1/2 views expose.

Read-only. Nothing here executes DDL — that stays in oracle_maintenance_service.py.
"""

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError
from datetime import datetime

from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.oracle_maintenance_job_model import OracleMaintenanceJob
from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404, _get_engine, _rows, _safe_float, _safe_int, _safe_str,
    _SYSTEM_OWNERS, oracle_tablespaces, oracle_datafile_mounts,
)
from app.services.oracle.oracle_storage_decision_service import STATS_STALE_DAYS, _tablespace_growth_map
from app.services.oracle.oracle_storage_service import oracle_storage_block_detail

_ACTIVE_JOB_STATUSES = ("pending_approval", "approved", "running")
_RUNNING_STATUSES = ("running",)  # 'approved' + start_requested_at also counts — handled explicitly below


def _job_history_map(db: Session, conn_id: int, object_types: tuple):
    """One most-recent-job-per-object map, plus running/failed/recommended-
    pending counts for a set of object_types — shared by every category's
    telemetry so 'last operation/status' and the Overview cards' job counts
    always agree with each other (same underlying rows, not two separate
    approximations)."""
    jobs = (
        db.query(OracleMaintenanceJob)
        .filter(
            OracleMaintenanceJob.conn_id == conn_id,
            OracleMaintenanceJob.object_type.in_(object_types),
        )
        .order_by(OracleMaintenanceJob.created_at.desc())
        .limit(2000)
        .all()
    )
    last_by_object = {}
    running = 0
    failed = 0
    pending_approval = 0
    last_execution_at = None
    for j in jobs:
        if j.object_name not in last_by_object:
            last_by_object[j.object_name] = j
        is_running = j.status == "running" or (j.status == "approved" and j.start_requested_at is not None)
        if is_running:
            running += 1
        if j.status == "failed":
            failed += 1
        if j.status == "pending_approval":
            pending_approval += 1
        end = j.execution_ended_at
        if end and (last_execution_at is None or end > last_execution_at):
            last_execution_at = end
    return {
        "last_by_object": last_by_object,
        "running": running,
        "failed": failed,
        "pending_approval": pending_approval,
        "last_execution_at": last_execution_at.isoformat() + "Z" if last_execution_at else None,
    }


def _job_ref(last_by_object, object_name):
    j = last_by_object.get(object_name)
    if not j:
        return {"last_operation": None, "last_status": None, "last_execution_at": None}
    return {
        "last_operation": j.recommended_action,
        "last_status": j.status,
        "last_execution_at": (j.execution_ended_at.isoformat() + "Z") if j.execution_ended_at else None,
    }


def _is_stale(last_analyzed_str):
    if not last_analyzed_str:
        return True
    try:
        analyzed = datetime.strptime(last_analyzed_str[:19], "%Y-%m-%d %H:%M:%S")
        return (datetime.now() - analyzed).days > STATS_STALE_DAYS
    except Exception:
        return True


# ─────────────────────────────────────────────────────────────────────────
#  1. TABLE MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────

def table_maintenance_telemetry(conn_id: int, db: Session):
    """Timeout-bounded like tablespace_space_analysis — see _run_with_timeout."""
    return _run_with_timeout(_table_maintenance_telemetry_inner, conn_id, db, default=_timeout_error())


def _table_maintenance_telemetry_inner(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    tables = []
    try:
        raw = _rows(
            engine,
            f"""SELECT s.owner, s.segment_name AS table_name, s.tablespace_name,
                       ROUND(s.bytes/1024/1024, 2) AS size_mb, s.blocks,
                       t.num_rows, t.avg_row_len, t.row_movement, t.last_analyzed,
                       t.temporary, t.partitioned
                FROM dba_segments s
                JOIN dba_tables t ON t.owner = s.owner AND t.table_name = s.segment_name
                WHERE s.owner NOT IN ({_SYSTEM_OWNERS})
                  AND s.segment_type = 'TABLE'
                ORDER BY s.bytes DESC
                FETCH FIRST 300 ROWS ONLY"""
        )
    except Exception as exc:
        errors.append(f"tables: {exc}")
        raw = []

    hist = _job_history_map(db, conn_id, ("segment", "table"))
    last_by_object = hist["last_by_object"]

    for r in raw:
        owner = _safe_str(r.get("OWNER"))
        name = _safe_str(r.get("TABLE_NAME"))
        object_name = f"{owner}.{name}"
        size_mb = round(_safe_float(r.get("SIZE_MB")), 2)
        num_rows = r.get("NUM_ROWS")
        avg_row_len = r.get("AVG_ROW_LEN")
        used_est_mb = None
        reclaimable_mb = None
        reclaimable_pct = None
        if num_rows is not None and avg_row_len is not None:
            used_est_mb = round((_safe_int(num_rows) * _safe_int(avg_row_len)) / (1024 * 1024), 2)
            reclaimable_mb = round(max(size_mb - used_est_mb, 0), 2)
            reclaimable_pct = round((reclaimable_mb / size_mb) * 100, 1) if size_mb else 0.0

        row_movement = (_safe_str(r.get("ROW_MOVEMENT")) or "DISABLED").upper()
        last_analyzed = _safe_str(r.get("LAST_ANALYZED")) or None
        recommendation = None
        if reclaimable_pct is not None and reclaimable_pct >= 30 and size_mb >= 10:
            recommendation = "shrink_space" if row_movement == "ENABLED" else "move"

        tables.append({
            "owner": owner, "table_name": name, "object_name": object_name,
            "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")),
            "size_mb": size_mb, "blocks": _safe_int(r.get("BLOCKS")),
            "num_rows": _safe_int(num_rows) if num_rows is not None else None,
            "avg_row_len": _safe_int(avg_row_len) if avg_row_len is not None else None,
            "used_est_mb": used_est_mb,
            "reclaimable_mb": reclaimable_mb, "reclaimable_pct": reclaimable_pct,
            "row_movement_enabled": row_movement == "ENABLED",
            "last_analyzed": last_analyzed,
            "stats_stale": _is_stale(last_analyzed),
            "temporary": _safe_str(r.get("TEMPORARY")) == "Y",
            "partitioned": _safe_str(r.get("PARTITIONED")) == "YES",
            "recommendation": recommendation,
            **_job_ref(last_by_object, object_name),
        })

    reclaimable_total_mb = round(sum(t["reclaimable_mb"] or 0 for t in tables), 2)
    needing_maintenance = [t for t in tables if t["recommendation"]]
    largest_reclaimable = sorted(
        [t for t in tables if (t["reclaimable_mb"] or 0) > 0],
        key=lambda t: t["reclaimable_mb"], reverse=True,
    )[:10]

    return {
        "status": "success",
        "tables": tables,
        "summary": {
            "total_tables": len(tables),
            "needing_maintenance": len(needing_maintenance),
            "with_reclaimable_space": sum(1 for t in tables if (t["reclaimable_mb"] or 0) > 0),
            "reclaimable_total_mb": reclaimable_total_mb,
            "largest_reclaimable": [
                {"object_name": t["object_name"], "reclaimable_mb": t["reclaimable_mb"]}
                for t in largest_reclaimable
            ],
            "running": hist["running"], "failed": hist["failed"],
            "pending_approval": hist["pending_approval"],
            "recommended_count": len(needing_maintenance),
            "last_execution_at": hist["last_execution_at"],
        },
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
#  2. INDEX MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────

def index_maintenance_telemetry(conn_id: int, db: Session):
    """Timeout-bounded like tablespace_space_analysis — see _run_with_timeout."""
    return _run_with_timeout(_index_maintenance_telemetry_inner, conn_id, db, default=_timeout_error())


def _index_maintenance_telemetry_inner(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    raw = []
    try:
        raw = _rows(
            engine,
            f"""SELECT i.owner, i.index_name, i.table_name, i.tablespace_name,
                       i.index_type, i.uniqueness, i.status,
                       i.blevel, i.leaf_blocks, i.distinct_keys, i.clustering_factor,
                       i.num_rows, i.last_analyzed,
                       ROUND(s.bytes/1024/1024, 2) AS size_mb
                FROM dba_indexes i
                LEFT JOIN dba_segments s
                       ON s.owner = i.owner AND s.segment_name = i.index_name
                      AND s.segment_type = 'INDEX'
                WHERE i.owner NOT IN ({_SYSTEM_OWNERS})
                ORDER BY NVL(s.bytes, 0) DESC
                FETCH FIRST 300 ROWS ONLY"""
        )
    except Exception as exc:
        errors.append(f"indexes: {exc}")

    hist = _job_history_map(db, conn_id, ("index",))
    last_by_object = hist["last_by_object"]

    indexes = []
    for r in raw:
        owner = _safe_str(r.get("OWNER"))
        name = _safe_str(r.get("INDEX_NAME"))
        object_name = f"{owner}.{name}"
        status = _safe_str(r.get("STATUS"))
        blevel = _safe_int(r.get("BLEVEL")) if r.get("BLEVEL") is not None else None
        last_analyzed = _safe_str(r.get("LAST_ANALYZED")) or None

        recommendation = None
        if status == "UNUSABLE":
            recommendation = "index_rebuild_unusable"
        elif blevel is not None and blevel >= 3:
            recommendation = "index_maintenance_rebuild"

        indexes.append({
            "owner": owner, "index_name": name, "table_name": _safe_str(r.get("TABLE_NAME")),
            "object_name": object_name,
            "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")) or None,
            "index_type": _safe_str(r.get("INDEX_TYPE")),
            "uniqueness": _safe_str(r.get("UNIQUENESS")),
            "status": status,
            "size_mb": round(_safe_float(r.get("SIZE_MB")), 2) if r.get("SIZE_MB") is not None else None,
            "blevel": blevel,
            "leaf_blocks": _safe_int(r.get("LEAF_BLOCKS")) if r.get("LEAF_BLOCKS") is not None else None,
            "distinct_keys": _safe_int(r.get("DISTINCT_KEYS")) if r.get("DISTINCT_KEYS") is not None else None,
            "clustering_factor": _safe_int(r.get("CLUSTERING_FACTOR")) if r.get("CLUSTERING_FACTOR") is not None else None,
            "num_rows": _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
            "last_analyzed": last_analyzed,
            "stats_stale": _is_stale(last_analyzed),
            "recommendation": recommendation,
            **_job_ref(last_by_object, object_name),
        })

    unusable = [i for i in indexes if i["status"] == "UNUSABLE"]
    needing_maintenance = [i for i in indexes if i["recommendation"]]

    return {
        "status": "success",
        "indexes": indexes,
        "summary": {
            "total_indexes": len(indexes),
            "unusable": len(unusable),
            "needing_maintenance": len(needing_maintenance),
            "running": hist["running"], "failed": hist["failed"],
            "pending_approval": hist["pending_approval"],
            "recommended_count": len(needing_maintenance),
            "last_execution_at": hist["last_execution_at"],
        },
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
#  3. STATISTICS MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────

def statistics_maintenance_telemetry(conn_id: int, db: Session):
    """Timeout-bounded like tablespace_space_analysis — see _run_with_timeout."""
    return _run_with_timeout(_statistics_maintenance_telemetry_inner, conn_id, db, default=_timeout_error())


def _statistics_maintenance_telemetry_inner(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    raw = []
    try:
        raw = _rows(
            engine,
            f"""SELECT t.owner, t.table_name, t.num_rows, t.last_analyzed,
                       t.stale_stats,
                       m.inserts, m.updates, m.deletes, m.timestamp AS mod_timestamp
                FROM dba_tables t
                LEFT JOIN dba_tab_modifications m
                       ON m.table_owner = t.owner AND m.table_name = t.table_name
                      AND m.partition_name IS NULL
                WHERE t.owner NOT IN ({_SYSTEM_OWNERS})
                  AND t.temporary = 'N'
                ORDER BY t.last_analyzed ASC NULLS FIRST
                FETCH FIRST 300 ROWS ONLY"""
        )
    except Exception as exc:
        # STALE_STATS requires the table to be monitored — fall back without it
        # rather than fail the whole page over one optional column.
        try:
            raw = _rows(
                engine,
                f"""SELECT t.owner, t.table_name, t.num_rows, t.last_analyzed,
                           NULL AS stale_stats,
                           m.inserts, m.updates, m.deletes, m.timestamp AS mod_timestamp
                    FROM dba_tables t
                    LEFT JOIN dba_tab_modifications m
                           ON m.table_owner = t.owner AND m.table_name = t.table_name
                          AND m.partition_name IS NULL
                    WHERE t.owner NOT IN ({_SYSTEM_OWNERS})
                      AND t.temporary = 'N'
                    ORDER BY t.last_analyzed ASC NULLS FIRST
                    FETCH FIRST 300 ROWS ONLY"""
            )
        except Exception as exc2:
            errors.append(f"statistics: {exc2}")

    hist = _job_history_map(db, conn_id, ("table_stats",))
    last_by_object = hist["last_by_object"]

    tables = []
    for r in raw:
        owner = _safe_str(r.get("OWNER"))
        name = _safe_str(r.get("TABLE_NAME"))
        object_name = f"{owner}.{name}"
        last_analyzed = _safe_str(r.get("LAST_ANALYZED")) or None
        stale_flag = _safe_str(r.get("STALE_STATS"))
        stale = (stale_flag == "YES") if stale_flag in ("YES", "NO") else _is_stale(last_analyzed)
        inserts = r.get("INSERTS")
        updates = r.get("UPDATES")
        deletes = r.get("DELETES")
        mod_total = None
        if inserts is not None or updates is not None or deletes is not None:
            mod_total = _safe_int(inserts) + _safe_int(updates) + _safe_int(deletes)

        tables.append({
            "owner": owner, "table_name": name, "object_name": object_name,
            "num_rows": _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
            "last_analyzed": last_analyzed,
            "stale": bool(stale),
            "modifications": mod_total,
            "inserts": _safe_int(inserts) if inserts is not None else None,
            "updates": _safe_int(updates) if updates is not None else None,
            "deletes": _safe_int(deletes) if deletes is not None else None,
            "recommendation": "gather_table_stats" if stale else None,
            **_job_ref(last_by_object, object_name),
        })

    needing = [t for t in tables if t["stale"]]

    return {
        "status": "success",
        "tables": tables,
        "summary": {
            "total_tables": len(tables),
            "stale_count": len(needing),
            "needing_maintenance": len(needing),
            "running": hist["running"], "failed": hist["failed"],
            "pending_approval": hist["pending_approval"],
            "recommended_count": len(needing),
            "last_execution_at": hist["last_execution_at"],
        },
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
#  4. PARTITION MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────

def partition_maintenance_telemetry(conn_id: int, db: Session):
    """Timeout-bounded like tablespace_space_analysis — see _run_with_timeout."""
    return _run_with_timeout(_partition_maintenance_telemetry_inner, conn_id, db, default=_timeout_error())


def _partition_maintenance_telemetry_inner(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    ranked = []
    try:
        # HIGH_VALUE is a LONG column — Oracle forbids it in the same query
        # block as ORDER BY/JOIN, so rank/limit first with no LONG column,
        # then fetch HIGH_VALUE separately only for the rows that made the cut
        # (same two-query approach as oracle_storage_service.oracle_storage_partitions).
        ranked = _rows(
            engine,
            f"""SELECT tp.table_owner AS owner, tp.table_name, tp.partition_name,
                       tp.partition_position, tp.tablespace_name,
                       tp.num_rows, tp.last_analyzed,
                       ROUND(s.bytes/1024/1024, 2) AS size_mb
                FROM dba_tab_partitions tp
                LEFT JOIN dba_segments s
                       ON s.owner = tp.table_owner AND s.segment_name = tp.table_name
                      AND s.partition_name = tp.partition_name
                      AND s.segment_type = 'TABLE PARTITION'
                WHERE tp.table_owner NOT IN ({_SYSTEM_OWNERS})
                ORDER BY size_mb DESC NULLS LAST
                FETCH FIRST 300 ROWS ONLY"""
        )
    except Exception as exc:
        errors.append(f"partitions: {exc}")

    high_values = {}
    table_pairs = {(r.get("OWNER"), r.get("TABLE_NAME")) for r in ranked}
    if table_pairs:
        try:
            params = {}
            tuples_sql = []
            for i, (owner, table) in enumerate(table_pairs):
                params[f"o{i}"] = owner
                params[f"t{i}"] = table
                tuples_sql.append(f"(:o{i}, :t{i})")
            hv_raw = _rows(
                engine,
                f"""SELECT table_owner AS owner, table_name, partition_name,
                           SUBSTR(high_value, 1, 500) AS high_value
                    FROM dba_tab_partitions
                    WHERE (table_owner, table_name) IN ({', '.join(tuples_sql)})""",
                params,
            )
            for r in hv_raw:
                high_values[(r.get("OWNER"), r.get("TABLE_NAME"), r.get("PARTITION_NAME"))] = r.get("HIGH_VALUE")
        except Exception as exc:
            errors.append(f"high_values: {exc}")

    # Local index partitions marked UNUSABLE — this is what makes REBUILD
    # PARTITION a real, meaningful operation (Oracle rebuilds an unusable
    # index partition, not the table partition itself, which has no
    # "rebuild" concept).
    unusable_idx_parts = {}
    try:
        ip_raw = _rows(
            engine,
            f"""SELECT ip.index_owner AS owner, i.table_name, ip.partition_name,
                       ip.index_name
                FROM dba_ind_partitions ip
                JOIN dba_indexes i ON i.owner = ip.index_owner AND i.index_name = ip.index_name
                WHERE ip.status = 'UNUSABLE' AND ip.index_owner NOT IN ({_SYSTEM_OWNERS})"""
        )
        for r in ip_raw:
            key = (_safe_str(r.get("OWNER")), _safe_str(r.get("TABLE_NAME")), _safe_str(r.get("PARTITION_NAME")))
            unusable_idx_parts.setdefault(key, []).append(_safe_str(r.get("INDEX_NAME")))
    except Exception as exc:
        errors.append(f"unusable_index_partitions: {exc}")

    hist = _job_history_map(db, conn_id, ("partition",))
    last_by_object = hist["last_by_object"]

    partitions = []
    for r in ranked:
        owner = _safe_str(r.get("OWNER"))
        table_name = _safe_str(r.get("TABLE_NAME"))
        part_name = _safe_str(r.get("PARTITION_NAME"))
        object_name = f"{owner}.{table_name}.{part_name}"
        size_mb = round(_safe_float(r.get("SIZE_MB")), 2) if r.get("SIZE_MB") is not None else None
        unusable_indexes = unusable_idx_parts.get((owner, table_name, part_name)) or []

        recommendation = None
        if unusable_indexes:
            recommendation = "rebuild_partition"
        elif size_mb and size_mb >= 50:
            recommendation = "shrink_partition"

        partitions.append({
            "owner": owner, "table_name": table_name, "partition_name": part_name,
            "object_name": object_name,
            "partition_position": _safe_int(r.get("PARTITION_POSITION")) if r.get("PARTITION_POSITION") is not None else None,
            "tablespace_name": _safe_str(r.get("TABLESPACE_NAME")) or None,
            "size_mb": size_mb,
            "high_value": _safe_str(high_values.get((owner, table_name, part_name))) or None,
            "num_rows": _safe_int(r.get("NUM_ROWS")) if r.get("NUM_ROWS") is not None else None,
            "last_analyzed": _safe_str(r.get("LAST_ANALYZED")) or None,
            "unusable_local_indexes": unusable_indexes,
            "recommendation": recommendation,
            **_job_ref(last_by_object, object_name),
        })

    needing = [p for p in partitions if p["recommendation"]]

    return {
        "status": "success",
        "partitions": partitions,
        "summary": {
            "total_partitions": len(partitions),
            "needing_maintenance": len(needing),
            "unusable_local_indexes": sum(len(p["unusable_local_indexes"]) for p in partitions),
            "running": hist["running"], "failed": hist["failed"],
            "pending_approval": hist["pending_approval"],
            "recommended_count": len(needing),
            "last_execution_at": hist["last_execution_at"],
        },
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
#  5. SPACE / STORAGE MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────

def space_maintenance_telemetry(conn_id: int, db: Session):
    """Timeout-bounded like tablespace_space_analysis — see _run_with_timeout."""
    return _run_with_timeout(_space_maintenance_telemetry_inner, conn_id, db, default=_timeout_error())


def _space_fetch_tablespaces(conn_id: int):
    with SessionLocal() as session:
        return oracle_tablespaces(conn_id, session)


def _space_fetch_datafiles(conn_id: int):
    with SessionLocal() as session:
        return oracle_datafile_mounts(conn_id, session)


def _space_fetch_recyclebin(engine):
    block_rows = _rows(engine, "SELECT value FROM v$parameter WHERE name='db_block_size'")
    block_size = _safe_int(block_rows[0].get("VALUE")) if block_rows else 8192
    rb_raw = _rows(
        engine,
        f"""SELECT owner, COUNT(*) AS object_count, SUM(space) AS total_blocks
            FROM dba_recyclebin
            WHERE owner NOT IN ({_SYSTEM_OWNERS})
            GROUP BY owner"""
    )
    by_owner = {}
    total_mb = 0.0
    for r in rb_raw:
        mb = round((_safe_int(r.get("TOTAL_BLOCKS")) * block_size) / 1024 / 1024, 2)
        by_owner[_safe_str(r.get("OWNER"))] = {
            "object_count": _safe_int(r.get("OBJECT_COUNT")), "size_mb": mb,
        }
        total_mb += mb
    return by_owner, total_mb


def _space_maintenance_telemetry_inner(conn_id: int, db: Session):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []

    # These 3 calls are independent Oracle round-trips — run them concurrently
    # instead of back-to-back, or a slow agent-routed connection adds all of
    # them up and can blow past the outer 20s timeout for no reason (each
    # thread gets its own Postgres session; `db` itself isn't thread-safe).
    with ThreadPoolExecutor(max_workers=3) as pool:
        ts_future = pool.submit(_space_fetch_tablespaces, conn_id)
        df_future = pool.submit(_space_fetch_datafiles, conn_id)
        rb_future = pool.submit(_space_fetch_recyclebin, engine)

        try:
            ts_resp = ts_future.result()
        except Exception as exc:
            errors.append(f"tablespaces: {exc}")
            ts_resp = {}
        try:
            df_resp = df_future.result()
        except Exception as exc:
            errors.append(f"datafiles: {exc}")
            df_resp = {}
        recyclebin_by_owner = {}
        recyclebin_total_mb = 0.0
        try:
            recyclebin_by_owner, recyclebin_total_mb = rb_future.result()
        except Exception as exc:
            errors.append(f"recyclebin: {exc}")

    if ts_resp.get("status") != "success":
        errors.append(f"tablespaces: {ts_resp.get('error', 'failed')}")
    tablespaces = ts_resp.get("tablespaces", [])

    errors.extend(df_resp.get("errors") or [])
    datafiles = df_resp.get("datafiles", [])

    for ts in tablespaces:
        ts["requires_attention"] = ts.get("used_pct", 0) is not None and ts["used_pct"] >= 85

    needing_attention = [t for t in tablespaces if t.get("requires_attention")]

    hist = _job_history_map(db, conn_id, ("tablespace", "datafile", "recyclebin"))

    return {
        "status": "success",
        "tablespaces": tablespaces,
        "datafiles": datafiles,
        "recyclebin": {
            "by_owner": recyclebin_by_owner,
            "total_mb": round(recyclebin_total_mb, 2),
        },
        "summary": {
            "total_tablespaces": len(tablespaces),
            "requiring_attention": len(needing_attention),
            "total_datafiles": len(datafiles),
            "reclaimable_mb": round(recyclebin_total_mb, 2),
            "running": hist["running"], "failed": hist["failed"],
            "pending_approval": hist["pending_approval"],
            "recommended_count": len(needing_attention) + (1 if recyclebin_total_mb > 100 else 0),
            "last_execution_at": hist["last_execution_at"],
        },
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────
#  SPACE — supporting lookups for the two Space operations that need a
#  DBA-supplied parameter before they're safe to run
# ─────────────────────────────────────────────────────────────────────────

def datafile_resize_info(conn_id: int, db: Session, file_name: str):
    """Real current/minimum-safe size for one datafile — the frontend's
    resize dialog uses min_safe_mb as the floor on the size input so a
    request that would shrink a datafile below its own used space is
    rejected before the DBA can even submit it (request_direct_maintenance's
    own validation re-checks this server-side regardless). Timeout-bounded
    like tablespace_space_analysis — see _run_with_timeout."""
    timeout_error = {
        "status": "error",
        "error": f"Timed out after {ANALYSIS_TIMEOUT_SECONDS}s waiting for Oracle — "
                 "the connection or its agent isn't answering right now.",
    }
    return _run_with_timeout(_datafile_resize_info_inner, conn_id, db, file_name, default=timeout_error)


def _datafile_resize_info_inner(conn_id: int, db: Session, file_name: str):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    try:
        rows = _rows(engine, "SELECT file_id, bytes, autoextensible, maxbytes FROM dba_data_files WHERE file_name = :f", {"f": file_name})
        if not rows:
            return {"status": "error", "error": "datafile not found"}
        r = rows[0]
        current_mb = round(_safe_int(r.get("BYTES")) / 1024 / 1024, 2)
        free = _rows(engine, "SELECT NVL(SUM(bytes),0) AS free_bytes FROM dba_free_space WHERE file_id = :fid", {"fid": r.get("FILE_ID")})
        free_mb = round((_safe_int(free[0].get("FREE_BYTES")) / 1024 / 1024), 2) if free else 0.0
        min_safe_mb = max(round(current_mb - free_mb, 2), 1)
        return {
            "status": "success", "file_name": file_name,
            "current_mb": current_mb, "free_mb": free_mb, "min_safe_mb": min_safe_mb,
            "autoextensible": _safe_str(r.get("AUTOEXTENSIBLE")),
            "max_mb": round(_safe_int(r.get("MAXBYTES")) / 1024 / 1024, 2) if r.get("MAXBYTES") else None,
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


ANALYSIS_TIMEOUT_SECONDS = 30


def _timeout_error():
    return {
        "status": "error",
        "error": f"Timed out after {ANALYSIS_TIMEOUT_SECONDS}s waiting for Oracle — "
                 "the connection or its agent isn't answering right now.",
    }


def _run_with_timeout(fn, *args, timeout=ANALYSIS_TIMEOUT_SECONDS, default=None, **kwargs):
    """Run `fn` on a worker thread and give up waiting after `timeout`
    seconds, returning `default` instead of hanging forever. An agent-routed
    Oracle connection (or ClickHouse) that never answers has no built-in
    timeout of its own at this layer — an on-demand analysis endpoint must
    never leave the frontend's dialog spinning indefinitely regardless of
    what's actually stuck underneath.

    Deliberately NOT a `with ThreadPoolExecutor(...)` block — exiting that
    context calls shutdown(wait=True), which blocks until the timed-out
    thread finishes too, silently undoing the timeout. The pool is left to
    be garbage-collected instead; the orphaned thread (if the call really
    never returns) finishes on its own whenever Oracle/the agent eventually
    responds or errors, without holding this request open.

    Also catches any OTHER exception `fn` raises (not just a timeout) and
    degrades to an error result instead of letting it blow up the whole
    request — a single category's real bug/DB error must not 500 the entire
    Maintenance Overview page, which calls all 5 categories from one route."""
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(fn, *args, **kwargs)
    try:
        result = future.result(timeout=timeout)
    except FuturesTimeoutError:
        pool.shutdown(wait=False)
        return default
    except Exception as exc:
        pool.shutdown(wait=False)
        return {"status": "error", "error": str(exc)}
    pool.shutdown(wait=False)
    return result


def tablespace_space_analysis(conn_id: int, db: Session, tablespace_name: str):
    """Read-only report — deliberately NOT a tracked job, since nothing here
    executes any SQL. Bundles the same real block/growth data Storage
    Health's decision engine uses (oracle_storage_block_detail + the
    tablespace growth map) into one on-demand answer to 'what is actually
    going on with this tablespace'. Both calls are timeout-bounded — see
    _run_with_timeout."""
    timeout_error = {
        "status": "error",
        "error": f"Timed out after {ANALYSIS_TIMEOUT_SECONDS}s waiting for Oracle — "
                 "the connection or its agent isn't answering right now.",
    }
    detail = _run_with_timeout(
        oracle_storage_block_detail, conn_id, db, "tablespace",
        tablespace_name=tablespace_name, default=timeout_error,
    )
    if detail.get("status") != "success":
        return detail

    growth_map = _run_with_timeout(_tablespace_growth_map, conn_id, default={})
    detail["growth"] = growth_map.get(tablespace_name, {
        "mb_per_day": None, "days_to_full": None, "insufficient_history": True,
    })
    return detail


# ─────────────────────────────────────────────────────────────────────────
#  OVERVIEW — all 5 category summaries in one call, for the landing cards
# ─────────────────────────────────────────────────────────────────────────

def _fetch_category_with_own_session(fn, conn_id: int):
    """Each of the 5 categories does several real Oracle queries (plus a
    Postgres job-history lookup) — run them concurrently instead of one
    after another, or the Overview card is stuck on 'Reading live
    maintenance telemetry...' for the sum of all five instead of the
    slowest one. Each thread gets its own short-lived Postgres session
    (the `db` passed into oracle_maintenance_overview is not safe to share
    across threads); the Oracle engine itself is already connection-pooled
    and fine to use concurrently (same fix already applied to Storage
    Health's oracle_storage_findings())."""
    with SessionLocal() as session:
        return fn(conn_id, session)


def oracle_maintenance_overview(conn_id: int, db: Session):
    with ThreadPoolExecutor(max_workers=5) as pool:
        table_future = pool.submit(_fetch_category_with_own_session, table_maintenance_telemetry, conn_id)
        index_future = pool.submit(_fetch_category_with_own_session, index_maintenance_telemetry, conn_id)
        stats_future = pool.submit(_fetch_category_with_own_session, statistics_maintenance_telemetry, conn_id)
        partition_future = pool.submit(_fetch_category_with_own_session, partition_maintenance_telemetry, conn_id)
        space_future = pool.submit(_fetch_category_with_own_session, space_maintenance_telemetry, conn_id)

        table_resp = table_future.result()
        index_resp = index_future.result()
        stats_resp = stats_future.result()
        partition_resp = partition_future.result()
        space_resp = space_future.result()

    def _status_for(summary, recommended_key="recommended_count"):
        if summary.get("failed"):
            return "attention_required"
        if summary.get(recommended_key):
            return "attention_required"
        if summary.get("running"):
            return "in_progress"
        return "healthy"

    def _resp_errors(resp):
        if resp.get("status") != "success":
            return [resp.get("error", "unavailable")]
        return resp.get("errors") or []

    def _card(resp, label, build):
        """A category that timed out or errored has no 'summary' at all —
        never index into it blindly, or one slow/broken category 500s the
        whole Overview page instead of just that one card showing
        unavailable (see _run_with_timeout — timeouts/errors both land
        here as {"status": "error", "error": "..."})."""
        if resp.get("status") != "success":
            return {"label": label, "status": "unavailable", "error": resp.get("error", "unavailable")}
        return {"label": label, **build(resp["summary"])}

    return {
        "status": "success",
        "categories": {
            "table": _card(table_resp, "Table Maintenance", lambda s: {
                "status": _status_for(s),
                "objects": s["total_tables"],
                "needing_maintenance": s["needing_maintenance"],
                "reclaimable_mb": s["reclaimable_total_mb"],
                "running": s["running"], "failed": s["failed"],
                "recommended_count": s["recommended_count"],
                "last_execution_at": s["last_execution_at"],
            }),
            "index": _card(index_resp, "Index Maintenance", lambda s: {
                "status": _status_for(s),
                "objects": s["total_indexes"],
                "needing_maintenance": s["needing_maintenance"],
                "unusable": s["unusable"],
                "running": s["running"], "failed": s["failed"],
                "recommended_count": s["recommended_count"],
                "last_execution_at": s["last_execution_at"],
            }),
            "statistics": _card(stats_resp, "Statistics Maintenance", lambda s: {
                "status": _status_for(s),
                "objects": s["total_tables"],
                "needing_maintenance": s["stale_count"],
                "running": s["running"], "failed": s["failed"],
                "recommended_count": s["recommended_count"],
                "last_execution_at": s["last_execution_at"],
            }),
            "partition": _card(partition_resp, "Partition Maintenance", lambda s: {
                "status": _status_for(s),
                "objects": s["total_partitions"],
                "needing_maintenance": s["needing_maintenance"],
                "running": s["running"], "failed": s["failed"],
                "recommended_count": s["recommended_count"],
                "last_execution_at": s["last_execution_at"],
            }),
            "space": _card(space_resp, "Space / Storage Maintenance", lambda s: {
                "status": _status_for(s),
                "objects": s["total_tablespaces"],
                "needing_maintenance": s["requiring_attention"],
                "reclaimable_mb": s["reclaimable_mb"],
                "running": s["running"], "failed": s["failed"],
                "recommended_count": s["recommended_count"],
                "last_execution_at": s["last_execution_at"],
            }),
        },
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "errors": (
            _resp_errors(table_resp) + _resp_errors(index_resp) + _resp_errors(stats_resp)
            + _resp_errors(partition_resp) + _resp_errors(space_resp)
        ),
    }
