"""
Oracle Storage Health — Phase 3 approval/execution service.

Turns one of Phase 2's live findings into a durable, audited job: request ->
approve/reject -> (job runner executes) -> result. Only findings whose
recommended_action is in EXECUTABLE_ACTIONS can ever reach a job row — the
rest (tablespace/datafile management, partition maintenance, continue
monitoring) need a human-supplied parameter this system can't safely infer,
so they stay informational-only (see the Phase 3 plan's "Scope decision").

request_maintenance() re-runs the decision engine live (never trusts a stale
client-supplied finding) and builds proposed_sql from the MATCHED finding's
own object_name — which is itself built from Oracle dictionary data, not
directly from the caller's request string — before it's ever templated into
SQL.
"""

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.oracle_maintenance_job_model import OracleMaintenanceJob
from app.services.oracle.oracle_monitoring_service import _get_engine, _rows, _safe_int, _safe_str
from app.services.oracle.oracle_storage_decision_service import oracle_storage_findings

EXECUTABLE_ACTIONS = {"shrink_space", "move", "index_maintenance_rebuild"}

ACTIVE_STATUSES = ("pending_approval", "approved", "running")

# ── Direct-request actions (the Maintenance module) ────────────────────────
# Separate from EXECUTABLE_ACTIONS/request_maintenance() above, which stays
# exactly as it was: it only ever fires from a live Storage Health finding.
# These are DBA-initiated directly from the Maintenance telemetry pages —
# there is no "finding" to match against, so request_direct_maintenance()
# below validates the object/action pair against Oracle itself instead.
TABLE_ACTIONS = {"shrink_space", "move", "truncate_table", "enable_row_movement", "disable_row_movement"}
INDEX_ACTIONS = {"index_maintenance_rebuild", "index_rebuild_online", "index_coalesce", "index_rebuild_unusable"}
STATS_ACTIONS = {"gather_table_stats", "gather_schema_stats", "gather_index_stats"}
PARTITION_ACTIONS = {"move_partition", "shrink_partition", "rebuild_partition",
                     "merge_partition", "split_partition", "drop_partition"}
SPACE_ACTIONS = {"purge_recyclebin", "datafile_resize"}
DIRECT_ACTIONS = TABLE_ACTIONS | INDEX_ACTIONS | STATS_ACTIONS | PARTITION_ACTIONS | SPACE_ACTIONS

# Confirmed destructive — the frontend must show a strong warning, and the
# backend independently refuses to run one without an explicit confirm flag
# (defense in depth: a UI bug must never be the only thing standing between
# a click and data loss).
DESTRUCTIVE_ACTIONS = {"truncate_table", "drop_partition"}

# object_type each action belongs to — drives which telemetry category's
# job-history join picks up this job, and how object_name is interpreted.
_ACTION_OBJECT_TYPE = {
    "shrink_space": "table", "move": "table", "truncate_table": "table",
    "enable_row_movement": "table", "disable_row_movement": "table",
    "index_maintenance_rebuild": "index", "index_rebuild_online": "index",
    "index_coalesce": "index", "index_rebuild_unusable": "index",
    "gather_table_stats": "table_stats", "gather_schema_stats": "schema_stats",
    "gather_index_stats": "index_stats",
    "move_partition": "partition", "shrink_partition": "partition",
    "rebuild_partition": "partition", "merge_partition": "partition",
    "split_partition": "partition", "drop_partition": "partition",
    "purge_recyclebin": "recyclebin", "datafile_resize": "datafile",
}


def _build_proposed_sql(recommended_action, object_name):
    if "." not in object_name:
        raise ValueError(f"object_name must be OWNER.NAME, got: {object_name!r}")
    owner, name = object_name.split(".", 1)
    if recommended_action == "shrink_space":
        return f"ALTER TABLE {owner}.{name} SHRINK SPACE"
    if recommended_action == "move":
        return f"ALTER TABLE {owner}.{name} MOVE"
    if recommended_action == "index_maintenance_rebuild":
        return f"ALTER INDEX {owner}.{name} REBUILD"
    raise ValueError(f"unsupported recommended_action: {recommended_action}")


def _split_object_name(object_type: str, object_name: str):
    """Every direct-action object_name follows one of three shapes:
    OWNER (schema_stats/recyclebin), OWNER.NAME (table/index/datafile), or
    OWNER.TABLE.PARTITION (partition). Centralized here so a malformed name
    fails once, clearly, instead of as a confusing split()/index error deep
    inside a SQL builder."""
    parts = object_name.split(".")
    if object_type in ("schema_stats", "recyclebin"):
        return (parts[0],)
    if object_type == "partition":
        if len(parts) != 3:
            raise HTTPException(status_code=400, detail=f"Partition object_name must be OWNER.TABLE.PARTITION, got: {object_name!r}")
        return tuple(parts)
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail=f"object_name must be OWNER.NAME, got: {object_name!r}")
    return tuple(parts)


def _build_direct_sql(action: str, object_type: str, object_name: str, params: dict) -> str:
    """SQL/PLSQL builder for the Maintenance module's direct (non-finding)
    actions. Every statement here is built from the caller-supplied
    object_name/params, which request_direct_maintenance() has already
    validated against Oracle's own dictionary before this is ever called —
    this function only assembles the string, it does not re-check anything."""
    params = params or {}

    if action in ("shrink_space", "move", "truncate_table", "enable_row_movement", "disable_row_movement",
                  "index_maintenance_rebuild", "index_rebuild_online", "index_coalesce", "index_rebuild_unusable",
                  "gather_table_stats", "gather_index_stats", "datafile_resize"):
        owner, name = _split_object_name(object_type, object_name)

    if action == "shrink_space":
        return f"ALTER TABLE {owner}.{name} SHRINK SPACE"
    if action == "move":
        target_ts = params.get("target_tablespace")
        return f"ALTER TABLE {owner}.{name} MOVE" + (f" TABLESPACE {target_ts}" if target_ts else "")
    if action == "truncate_table":
        return f"TRUNCATE TABLE {owner}.{name}"
    if action == "enable_row_movement":
        return f"ALTER TABLE {owner}.{name} ENABLE ROW MOVEMENT"
    if action == "disable_row_movement":
        return f"ALTER TABLE {owner}.{name} DISABLE ROW MOVEMENT"

    if action in ("index_maintenance_rebuild", "index_rebuild_unusable"):
        return f"ALTER INDEX {owner}.{name} REBUILD"
    if action == "index_rebuild_online":
        return f"ALTER INDEX {owner}.{name} REBUILD ONLINE"
    if action == "index_coalesce":
        return f"ALTER INDEX {owner}.{name} COALESCE"

    if action == "gather_table_stats":
        return f"BEGIN DBMS_STATS.GATHER_TABLE_STATS('{owner}', '{name}'); END;"
    if action == "gather_schema_stats":
        (schema,) = _split_object_name(object_type, object_name)
        # A plain DBMS_STATS.GATHER_SCHEMA_STATS('{schema}') call is all-or-
        # nothing — one table it can't analyze (wrong privilege, an odd
        # object type, a table dropped mid-run) raises ORA-20000 and aborts
        # stats collection for every OTHER table in the schema too, even
        # ones that would have succeeded fine. Loop table-by-table instead,
        # catching each failure individually, so a single bad table costs
        # exactly one table's stats, not the whole schema's. Still fails the
        # job (and reports exactly which tables and why) if anything failed —
        # this never turns a real failure into a false success, it just stops
        # one bad object from masking every good one.
        return f"""
DECLARE
  v_failed  PLS_INTEGER := 0;
  v_ok      PLS_INTEGER := 0;
  v_errors  VARCHAR2(3900) := '';
BEGIN
  FOR t IN (SELECT table_name FROM dba_tables WHERE owner = '{schema}' AND temporary = 'N') LOOP
    BEGIN
      DBMS_STATS.GATHER_TABLE_STATS('{schema}', t.table_name);
      v_ok := v_ok + 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_failed := v_failed + 1;
        IF LENGTH(v_errors) < 3700 THEN
          v_errors := v_errors || t.table_name || ': ' || SUBSTR(SQLERRM, 1, 150) || '; ';
        END IF;
    END;
  END LOOP;
  IF v_failed > 0 THEN
    RAISE_APPLICATION_ERROR(-20000,
      v_ok || ' of ' || (v_ok + v_failed) || ' tables succeeded. Failed: ' || v_errors);
  END IF;
END;
""".strip()
    if action == "gather_index_stats":
        return f"BEGIN DBMS_STATS.GATHER_INDEX_STATS('{owner}', '{name}'); END;"

    if action in ("move_partition", "shrink_partition", "rebuild_partition", "drop_partition"):
        p_owner, table, partition = _split_object_name(object_type, object_name)
        if action == "move_partition":
            target_ts = params.get("target_tablespace")
            return f"ALTER TABLE {p_owner}.{table} MOVE PARTITION {partition}" + (f" TABLESPACE {target_ts}" if target_ts else "")
        if action == "shrink_partition":
            return f"ALTER TABLE {p_owner}.{table} MODIFY PARTITION {partition} SHRINK SPACE"
        if action == "rebuild_partition":
            index_name = params.get("index_name")
            if not index_name:
                raise HTTPException(status_code=400, detail="rebuild_partition requires params.index_name (the unusable local index to rebuild)")
            return f"ALTER INDEX {p_owner}.{index_name} REBUILD PARTITION {partition}"
        if action == "drop_partition":
            return f"ALTER TABLE {p_owner}.{table} DROP PARTITION {partition}"
    if action == "merge_partition":
        p_owner, table, partition = _split_object_name(object_type, object_name)
        merge_with = params.get("merge_with")
        new_name = params.get("new_partition_name") or merge_with
        if not merge_with or not new_name:
            raise HTTPException(status_code=400, detail="merge_partition requires params.merge_with and params.new_partition_name")
        return f"ALTER TABLE {p_owner}.{table} MERGE PARTITIONS {partition}, {merge_with} INTO PARTITION {new_name}"
    if action == "split_partition":
        p_owner, table, partition = _split_object_name(object_type, object_name)
        split_at = params.get("split_at")
        name1 = params.get("new_partition_name_1")
        name2 = params.get("new_partition_name_2")
        if not split_at or not name1 or not name2:
            raise HTTPException(status_code=400, detail="split_partition requires params.split_at, new_partition_name_1, new_partition_name_2")
        return (f"ALTER TABLE {p_owner}.{table} SPLIT PARTITION {partition} AT ({split_at}) "
                f"INTO (PARTITION {name1}, PARTITION {name2})")

    if action == "purge_recyclebin":
        return "PURGE RECYCLEBIN"
    if action == "datafile_resize":
        target_mb = params.get("target_size_mb")
        if not target_mb:
            raise HTTPException(status_code=400, detail="datafile_resize requires params.target_size_mb")
        # object_name for a datafile is its file_name (path), not OWNER.NAME —
        # _split_object_name isn't used here since a Windows/Unix path can
        # itself contain dots.
        return f"ALTER DATABASE DATAFILE '{object_name}' RESIZE {int(target_mb)}M"

    raise ValueError(f"unsupported direct action: {action}")


def _validate_direct_action(engine, action: str, object_type: str, object_name: str, params: dict):
    """Real Oracle-dictionary prerequisite checks — the spec's "do not
    execute an operation just because the user clicked it" requirement.
    Returns (warnings: list[str]) and raises HTTPException(400) the moment
    a hard prerequisite fails, so the same function serves both an
    eligibility pre-check and the actual request path."""
    params = params or {}
    warnings = []

    if action in DESTRUCTIVE_ACTIONS and not params.get("confirm_destructive"):
        raise HTTPException(status_code=400, detail=f"'{action}' is destructive — resend with params.confirm_destructive=true after the user has confirmed.")

    if object_type == "table" or action in ("shrink_space", "move", "truncate_table", "enable_row_movement", "disable_row_movement"):
        owner, name = _split_object_name("table", object_name)
        rows = _rows(engine, "SELECT temporary, row_movement, partitioned FROM dba_tables WHERE owner = :o AND table_name = :n", {"o": owner, "n": name})
        if not rows:
            raise HTTPException(status_code=404, detail=f"Table {owner}.{name} does not exist.")
        row_movement = (_safe_str(rows[0].get("ROW_MOVEMENT")) or "DISABLED").upper()
        partitioned = _safe_str(rows[0].get("PARTITIONED")) == "YES"
        if action == "shrink_space":
            if row_movement != "ENABLED":
                raise HTTPException(status_code=400, detail="SHRINK SPACE requires row movement to be enabled on this table first — run ENABLE ROW MOVEMENT, then retry.")
            if partitioned:
                warnings.append("This table is partitioned — SHRINK SPACE here shrinks the table as a whole; consider Partition Maintenance for per-partition shrink instead.")
        if action == "move" and partitioned:
            warnings.append("This table is partitioned — MOVE here moves the table's default segment attributes; existing partitions are unaffected.")
        if action == "enable_row_movement" and row_movement == "ENABLED":
            warnings.append("Row movement is already enabled on this table.")
        if action == "disable_row_movement" and row_movement != "ENABLED":
            warnings.append("Row movement is already disabled on this table.")
        if action in ("move", "truncate_table"):
            locks = _rows(engine, "SELECT COUNT(*) AS cnt FROM v$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id WHERE o.owner = :o AND o.object_name = :n", {"o": owner, "n": name})
            if locks and _safe_int(locks[0].get("CNT")) > 0:
                warnings.append("This table currently has active locks — the operation may wait or fail if sessions are holding it open.")

    elif object_type == "index" or action.startswith("index_"):
        owner, name = _split_object_name("index", object_name)
        rows = _rows(engine, "SELECT status, index_type FROM dba_indexes WHERE owner = :o AND index_name = :n", {"o": owner, "n": name})
        if not rows:
            raise HTTPException(status_code=404, detail=f"Index {owner}.{name} does not exist.")
        status = _safe_str(rows[0].get("STATUS"))
        index_type = _safe_str(rows[0].get("INDEX_TYPE"))
        if action == "index_rebuild_unusable" and status != "UNUSABLE":
            raise HTTPException(status_code=400, detail=f"Index is '{status}', not UNUSABLE — use REBUILD or REBUILD ONLINE instead.")
        if action == "index_rebuild_online" and "BITMAP" in index_type:
            raise HTTPException(status_code=400, detail="Bitmap indexes cannot be rebuilt ONLINE in this Oracle version — use REBUILD instead.")
        if action == "index_coalesce" and status == "UNUSABLE":
            raise HTTPException(status_code=400, detail="COALESCE cannot run on an UNUSABLE index — use REBUILD first.")

    elif action in STATS_ACTIONS:
        # DBMS_STATS on another schema's objects needs either ANALYZE ANY or
        # the schema-specific analyze privilege — connected-user-owns-nothing
        # is exactly the ORA-20000 "Insufficient privileges to analyze an
        # object in Schema" failure this project hit, so surface it as a
        # warning before running rather than as a job that fails 2 seconds in.
        target_owner = None
        if action == "gather_schema_stats":
            (schema,) = _split_object_name("schema_stats", object_name)
            target_owner = schema
            rows = _rows(engine, "SELECT COUNT(*) AS cnt FROM dba_tables WHERE owner = :o", {"o": schema})
            if not rows or _safe_int(rows[0].get("CNT")) == 0:
                raise HTTPException(status_code=404, detail=f"Schema {schema} has no tables — nothing to gather statistics for.")
        elif action == "gather_table_stats":
            owner, name = _split_object_name("table", object_name)
            target_owner = owner
            rows = _rows(engine, "SELECT 1 FROM dba_tables WHERE owner = :o AND table_name = :n", {"o": owner, "n": name})
            if not rows:
                raise HTTPException(status_code=404, detail=f"Table {owner}.{name} does not exist.")
        elif action == "gather_index_stats":
            owner, name = _split_object_name("index", object_name)
            target_owner = owner
            rows = _rows(engine, "SELECT 1 FROM dba_indexes WHERE owner = :o AND index_name = :n", {"o": owner, "n": name})
            if not rows:
                raise HTTPException(status_code=404, detail=f"Index {owner}.{name} does not exist.")

        if target_owner:
            try:
                who = _rows(engine, "SELECT USER FROM DUAL")
                connected_as = _safe_str(who[0].get("USER")) if who else ""
                if connected_as.upper() != target_owner.upper():
                    # ANALYZE ANY is the only privilege that actually lets DBMS_STATS
                    # touch another schema's objects — SELECT ANY DICTIONARY only
                    # grants read access to DBA_% views and was wrongly treated as
                    # sufficient in an earlier version of this check.
                    priv = _rows(engine, "SELECT COUNT(*) AS cnt FROM session_privs WHERE privilege = 'ANALYZE ANY'")
                    has_analyze_any = bool(priv) and _safe_int(priv[0].get("CNT")) > 0
                    if not has_analyze_any:
                        warnings.append(
                            f"Connected as {connected_as}, gathering statistics for {target_owner} — this account may lack "
                            "ANALYZE ANY and the operation could fail with ORA-20000. Grant ANALYZE ANY to proceed reliably."
                        )
            except Exception:
                pass  # privilege check itself is best-effort — never block on it failing

    elif object_type == "partition":
        p_owner, table, partition = _split_object_name("partition", object_name)
        rows = _rows(engine, "SELECT tablespace_name, num_rows FROM dba_tab_partitions WHERE table_owner = :o AND table_name = :t AND partition_name = :p", {"o": p_owner, "t": table, "p": partition})
        if not rows:
            raise HTTPException(status_code=404, detail=f"Partition {partition} on {p_owner}.{table} does not exist.")
        if action == "rebuild_partition":
            index_name = params.get("index_name")
            if not index_name:
                raise HTTPException(status_code=400, detail="rebuild_partition requires params.index_name.")
            ip = _rows(engine, "SELECT status FROM dba_ind_partitions WHERE index_owner = :o AND index_name = :i AND partition_name = :p", {"o": p_owner, "i": index_name, "p": partition})
            if not ip:
                raise HTTPException(status_code=404, detail=f"Index partition {index_name}/{partition} does not exist.")
            if _safe_str(ip[0].get("STATUS")) != "UNUSABLE":
                warnings.append("This local index partition is not currently UNUSABLE — rebuild is optional, not required.")
        if action == "drop_partition":
            cnt = _rows(engine, "SELECT COUNT(*) AS cnt FROM dba_tab_partitions WHERE table_owner = :o AND table_name = :t", {"o": p_owner, "t": table})
            if cnt and _safe_int(cnt[0].get("CNT")) <= 1:
                raise HTTPException(status_code=400, detail="Cannot drop the only remaining partition of this table.")
            warnings.append("DROP PARTITION permanently deletes all rows in this partition and invalidates any GLOBAL indexes on this table — they will need rebuilding afterward.")
        if action in ("merge_partition", "split_partition"):
            warnings.append("Local indexes on this table will be maintained automatically only if the table was created/altered with UPDATE INDEXES; verify this beforehand or rebuild affected local index partitions afterward.")

    elif action == "datafile_resize":
        target_mb = params.get("target_size_mb")
        rows = _rows(engine, "SELECT bytes, autoextensible, maxbytes FROM dba_data_files WHERE file_name = :f", {"f": object_name})
        if not rows:
            raise HTTPException(status_code=404, detail=f"Datafile {object_name} does not exist.")
        current_mb = _safe_int(rows[0].get("BYTES")) / 1024 / 1024
        free = _rows(engine, "SELECT NVL(SUM(bytes),0) AS free_bytes FROM dba_free_space WHERE file_id = (SELECT file_id FROM dba_data_files WHERE file_name = :f)", {"f": object_name})
        free_mb = (_safe_int(free[0].get("FREE_BYTES")) / 1024 / 1024) if free else 0
        min_safe_mb = max(current_mb - free_mb, 1)
        if target_mb and target_mb < min_safe_mb:
            raise HTTPException(status_code=400, detail=f"Requested size {target_mb}MB is below the minimum safe size for this datafile ({round(min_safe_mb)}MB used) — resizing below used space will fail or corrupt the datafile.")

    elif action == "purge_recyclebin":
        pass  # no per-object prerequisite — always safe to attempt

    return warnings


def request_direct_maintenance(conn_id: int, db: Session, object_type: str, object_name: str,
                                action: str, claims: dict, params: dict = None):
    """Entry point for every Maintenance-module operation that isn't sourced
    from a Storage Health finding (request_maintenance() above stays
    untouched for that flow). Validates against Oracle live, builds the SQL,
    and creates the job already 'approved' — the confirmation dialog the
    user just clicked through on the Maintenance page IS the human approval
    step here, so there's no separate pending_approval stage to click
    through again for something the DBA explicitly just chose to run."""
    if action not in DIRECT_ACTIONS:
        raise HTTPException(status_code=400, detail=f"Unknown or unsupported maintenance action: {action!r}")

    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")

    engine = _get_engine(conn)
    warnings = _validate_direct_action(engine, action, object_type, object_name, params or {})
    proposed_sql = _build_direct_sql(action, object_type, object_name, params or {})

    job = OracleMaintenanceJob(
        org_id=conn.org_id or 1, conn_id=conn_id,
        object_type=_ACTION_OBJECT_TYPE.get(action, object_type), object_name=object_name,
        detected_issue=f"Requested directly from the Maintenance module: {action.replace('_', ' ')}.",
        evidence="; ".join(warnings) if warnings else "No prerequisite warnings.",
        recommended_action=action,
        expected_benefit=None, risk="; ".join(warnings) if warnings else None,
        proposed_sql=proposed_sql,
        status="approved",
        requested_by=claims.get("user_id"),
        approved_by=claims.get("user_id"),
        approved_at=datetime.utcnow(),
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(OracleMaintenanceJob).filter(
            OracleMaintenanceJob.conn_id == conn_id,
            OracleMaintenanceJob.object_type == _ACTION_OBJECT_TYPE.get(action, object_type),
            OracleMaintenanceJob.object_name == object_name,
            OracleMaintenanceJob.status.in_(ACTIVE_STATUSES),
        ).first()
        detail = (f"A maintenance job is already active for this object (job #{existing.id}, status={existing.status})."
                  if existing else "A maintenance job is already active for this object.")
        raise HTTPException(status_code=409, detail=detail)
    db.refresh(job)
    result = _job_to_dict(job)
    result["warnings"] = warnings
    return result


def _job_to_dict(job: OracleMaintenanceJob) -> dict:
    def _iso(v):
        # Every timestamp column here is set via datetime.utcnow() — genuinely
        # UTC, but naive (no tzinfo), so .isoformat() alone produces a string
        # with no timezone marker. The browser's `new Date(...)` then reads
        # that as LOCAL time instead of UTC, silently shifting every
        # timestamp by the browser's UTC offset (5:30 for IST — exactly the
        # "330m elapsed" bug). Appending "Z" makes it unambiguous.
        return (v.isoformat() + "Z") if v else None

    def _num(v):
        return float(v) if isinstance(v, Decimal) else v

    return {
        "id": job.id, "org_id": job.org_id, "conn_id": job.conn_id,
        "object_type": job.object_type, "object_name": job.object_name,
        "tablespace_name": job.tablespace_name,
        "detected_issue": job.detected_issue, "evidence": job.evidence,
        "recommended_action": job.recommended_action,
        "expected_benefit": job.expected_benefit, "risk": job.risk,
        "proposed_sql": job.proposed_sql,
        "status": job.status,
        "requested_by": job.requested_by, "requested_at": _iso(job.requested_at),
        "approved_by": job.approved_by, "approved_at": _iso(job.approved_at),
        "rejected_by": job.rejected_by, "rejected_at": _iso(job.rejected_at),
        "rejection_reason": job.rejection_reason,
        "start_requested_at": _iso(job.start_requested_at),
        "scheduled_at": _iso(job.scheduled_at),
        "notification_recipients": job.notification_recipients or [],
        "executed_sql": job.executed_sql,
        "execution_started_at": _iso(job.execution_started_at),
        "execution_ended_at": _iso(job.execution_ended_at),
        "before_metrics": job.before_metrics, "after_metrics": job.after_metrics,
        "reclaimed_mb": _num(job.reclaimed_mb), "error_details": job.error_details,
        "created_at": _iso(job.created_at), "updated_at": _iso(job.updated_at),
    }


def request_maintenance(conn_id: int, db: Session, object_type: str, object_name: str, claims: dict):
    conn = db.query(ConnectionMaster).filter(
        ConnectionMaster.id == conn_id, ConnectionMaster.db_type == "oracle"
    ).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Oracle connection not found")

    findings = oracle_storage_findings(conn_id, db).get("findings", [])
    match = next(
        (f for f in findings if f["object_type"] == object_type and f["object_name"] == object_name),
        None,
    )
    if match is None:
        raise HTTPException(
            status_code=400,
            detail="No current finding matches this object — it may no longer be a maintenance candidate.",
        )
    if match["recommended_action"] not in EXECUTABLE_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"'{match['recommended_action']}' requires manual execution outside ACTMON — "
                   "it needs a human-supplied parameter this system can't safely infer.",
        )

    proposed_sql = _build_proposed_sql(match["recommended_action"], match["object_name"])

    job = OracleMaintenanceJob(
        org_id=conn.org_id or 1, conn_id=conn_id,
        object_type=match["object_type"], object_name=match["object_name"],
        tablespace_name=match.get("tablespace_name"),
        detected_issue=match["problem"], evidence=match["evidence"],
        recommended_action=match["recommended_action"],
        expected_benefit=match.get("expected_benefit"), risk=match.get("risk"),
        proposed_sql=proposed_sql,
        status="pending_approval",
        requested_by=claims.get("user_id"),
    )
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.query(OracleMaintenanceJob).filter(
            OracleMaintenanceJob.conn_id == conn_id,
            OracleMaintenanceJob.object_type == object_type,
            OracleMaintenanceJob.object_name == object_name,
            OracleMaintenanceJob.status.in_(ACTIVE_STATUSES),
        ).first()
        if existing:
            detail = f"A maintenance job is already active for this object (job #{existing.id}, status={existing.status})."
        else:
            detail = "A maintenance job is already active for this object."
        raise HTTPException(status_code=409, detail=detail)
    db.refresh(job)
    return _job_to_dict(job)


def approve_maintenance(job_id: int, db: Session, claims: dict):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot approve a job in status '{job.status}'")
    if job.recommended_action not in EXECUTABLE_ACTIONS:
        raise HTTPException(status_code=400, detail=f"'{job.recommended_action}' is not an executable action")

    job.status = "approved"
    job.approved_by = claims.get("user_id")
    job.approved_at = datetime.utcnow()
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def start_maintenance(job_id: int, db: Session, claims: dict, recipients: list = None):
    """Explicit human trigger — approving no longer auto-queues execution.
    The runner only ever picks up an 'approved' job once start_requested_at
    (or a due scheduled_at) is set, so this is the only thing that actually
    sets anything running immediately."""
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot start a job in status '{job.status}'")
    if job.start_requested_at is not None or job.scheduled_at is not None:
        raise HTTPException(status_code=400, detail="This job has already been started or scheduled")

    job.start_requested_at = datetime.utcnow()
    if recipients:
        job.notification_recipients = recipients
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def schedule_maintenance(job_id: int, db: Session, claims: dict, scheduled_at: datetime, recipients: list = None):
    """Alternative to start_maintenance: pick a future UTC time instead of
    now. The runner (oracle_maintenance_job_runner.py) picks this up the
    same way once that time arrives."""
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "approved":
        raise HTTPException(status_code=400, detail=f"Cannot schedule a job in status '{job.status}'")
    if job.start_requested_at is not None or job.scheduled_at is not None:
        raise HTTPException(status_code=400, detail="This job has already been started or scheduled")

    # Every other timestamp column here is naive UTC (see _job_to_dict's
    # _iso()) — normalize a tz-aware value (Pydantic parses "...Z"/"+HH:MM"
    # into one) to naive UTC before comparing/storing, or this throws
    # comparing offset-naive datetime.utcnow() against an offset-aware value.
    if scheduled_at.tzinfo is not None:
        scheduled_at = scheduled_at.astimezone(timezone.utc).replace(tzinfo=None)
    if scheduled_at <= datetime.utcnow():
        raise HTTPException(status_code=400, detail="Scheduled time must be in the future")

    job.scheduled_at = scheduled_at
    if recipients:
        job.notification_recipients = recipients
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def reject_maintenance(job_id: int, db: Session, claims: dict, reason: str = None):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    if job.status != "pending_approval":
        raise HTTPException(status_code=400, detail=f"Cannot reject a job in status '{job.status}'")

    job.status = "rejected"
    job.rejected_by = claims.get("user_id")
    job.rejected_at = datetime.utcnow()
    job.rejection_reason = reason
    db.commit()
    db.refresh(job)
    return _job_to_dict(job)


def list_maintenance_jobs(db: Session, conn_id: int = None, status: str = None):
    q = db.query(OracleMaintenanceJob)
    if conn_id is not None:
        q = q.filter(OracleMaintenanceJob.conn_id == conn_id)
    if status:
        q = q.filter(OracleMaintenanceJob.status == status)
    jobs = q.order_by(OracleMaintenanceJob.created_at.desc()).limit(500).all()
    return {"status": "success", "jobs": [_job_to_dict(j) for j in jobs]}


def list_maintenance_jobs_all(db: Session, status: str = None):
    """Every Oracle maintenance job across every connection — the Maintenance
    Window page's feed. Same shape as list_maintenance_jobs(), with the
    owning connection's name/host attached since nothing else on this page
    scopes to a single connection the way Storage Health does."""
    q = db.query(OracleMaintenanceJob, ConnectionMaster).join(
        ConnectionMaster, ConnectionMaster.id == OracleMaintenanceJob.conn_id
    )
    if status:
        q = q.filter(OracleMaintenanceJob.status == status)
    rows = q.order_by(OracleMaintenanceJob.created_at.desc()).limit(1000).all()
    jobs = []
    for job, conn in rows:
        d = _job_to_dict(job)
        d["connection_name"] = conn.connection_name
        d["connection_host"] = conn.host
        jobs.append(d)
    return {"status": "success", "jobs": jobs}


def get_maintenance_job(job_id: int, db: Session):
    job = db.query(OracleMaintenanceJob).filter(OracleMaintenanceJob.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Maintenance job not found")
    return _job_to_dict(job)
