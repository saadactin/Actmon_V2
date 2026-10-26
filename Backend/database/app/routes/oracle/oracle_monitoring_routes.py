"""
Oracle Monitoring routes — thin handlers only.
All business logic lives in app/services/oracle/oracle_monitoring_service.py
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.oracle import oracle_ai_analysis
from app.services.oracle.oracle_monitoring_service import (
    oracle_dashboard,
    oracle_sga_detail,
    oracle_pga_detail,
    oracle_sessions,
    oracle_top_sql,
    oracle_wait_events,
    oracle_tablespaces,
    oracle_objects,
    oracle_schema_tables,
    oracle_table_detail,
    oracle_users,
    oracle_user_privileges,
    oracle_redo_logs,
    oracle_data_guard,
    oracle_processes,
    oracle_system_stats,
    oracle_awr_sql,
    oracle_monitoring_dashboard,
    oracle_slow_queries,
    oracle_slow_queries_filtered,
    oracle_error_logs,
    oracle_index_analysis,
    oracle_live_queries,
    oracle_locks,
    oracle_parameters,
    oracle_sql_plan,
    oracle_archive_log_gap,
    oracle_invalid_objects_detail,
    oracle_datafile_mounts,
    oracle_sar_top,
    oracle_ebs_concurrent,
    oracle_ebs_workflow,
    oracle_db_status,
    oracle_topology_detect,
    oracle_rac_nodes,
    oracle_services,
    oracle_asm,
    oracle_cdb_pdb,
    oracle_listener_status,
)
from app.services.oracle.oracle_storage_service import (
    oracle_storage_segments,
    oracle_storage_partitions,
    oracle_storage_overview,
    oracle_storage_block_detail,
    oracle_table_dictionary,
)
from app.services.oracle.oracle_storage_decision_service import (
    oracle_storage_findings,
    oracle_storage_precise_check,
)
from app.services.oracle.oracle_rac_host_service import oracle_rac_node_hosts
from app.services.oracle.oracle_redo_service import oracle_redo_generation
from app.services.oracle.oracle_rman_service import (
    oracle_rman_backup,
    oracle_rman_job_detail,
)
from app.services.oracle.oracle_sql_tuning_service import (
    oracle_sql_monitor_active,
    oracle_sql_monitor_detail,
    oracle_plan_instability,
)

router = APIRouter(prefix="/api/v1/connections/oracle", tags=["Oracle Monitoring"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# 1
@router.get("/{conn_id}/oracle-dashboard")
def route_oracle_dashboard(
    conn_id: int,
    inst_id: Optional[int] = Query(None, ge=1, le=128,
                         description="RAC instance number (GV$INSTANCE.INSTANCE_NUMBER). "
                                     "Omit for the instance the connection lands on."),
    db: Session = Depends(get_db),
):
    return oracle_dashboard(conn_id, db, inst_id)


# 2
@router.get("/{conn_id}/oracle-sga-detail")
def route_oracle_sga_detail(conn_id: int, db: Session = Depends(get_db)):
    return oracle_sga_detail(conn_id, db)


# 3
@router.get("/{conn_id}/oracle-pga-detail")
def route_oracle_pga_detail(conn_id: int, db: Session = Depends(get_db)):
    return oracle_pga_detail(conn_id, db)


# 4
@router.get("/{conn_id}/oracle-sessions")
def route_oracle_sessions(conn_id: int, db: Session = Depends(get_db)):
    return oracle_sessions(conn_id, db)


# 5
@router.get("/{conn_id}/oracle-top-sql")
def route_oracle_top_sql(conn_id: int, db: Session = Depends(get_db)):
    return oracle_top_sql(conn_id, db)


# 6
@router.get("/{conn_id}/oracle-wait-events")
def route_oracle_wait_events(conn_id: int, db: Session = Depends(get_db)):
    return oracle_wait_events(conn_id, db)


# 7
@router.get("/{conn_id}/oracle-tablespaces")
def route_oracle_tablespaces(conn_id: int, db: Session = Depends(get_db)):
    return oracle_tablespaces(conn_id, db)


# 8
@router.get("/{conn_id}/oracle-objects")
def route_oracle_objects(conn_id: int, db: Session = Depends(get_db)):
    return oracle_objects(conn_id, db)


# 9 — extra query param: owner
@router.get("/{conn_id}/oracle-schema-tables")
def route_oracle_schema_tables(conn_id: int, owner: str = "", db: Session = Depends(get_db)):
    return oracle_schema_tables(conn_id, db, owner)


# 9b — extra query params: owner, table
@router.get("/{conn_id}/oracle-table-detail")
def route_oracle_table_detail(conn_id: int, owner: str, table: str, db: Session = Depends(get_db)):
    return oracle_table_detail(conn_id, db, owner, table)


# 10
@router.get("/{conn_id}/oracle-users")
def route_oracle_users(conn_id: int, db: Session = Depends(get_db)):
    return oracle_users(conn_id, db)


# 10b
@router.get("/{conn_id}/oracle-users/{username}/privileges")
def route_oracle_user_privileges(conn_id: int, username: str, db: Session = Depends(get_db)):
    return oracle_user_privileges(conn_id, db, username)


# 11
@router.get("/{conn_id}/oracle-redo-logs")
def route_oracle_redo_logs(conn_id: int, db: Session = Depends(get_db)):
    return oracle_redo_logs(conn_id, db)


# 12
@router.get("/{conn_id}/oracle-data-guard")
def route_oracle_data_guard(conn_id: int, db: Session = Depends(get_db)):
    return oracle_data_guard(conn_id, db)


# 13
@router.get("/{conn_id}/oracle-processes")
def route_oracle_processes(conn_id: int, db: Session = Depends(get_db)):
    return oracle_processes(conn_id, db)


# 14
@router.get("/{conn_id}/oracle-system-stats")
def route_oracle_system_stats(conn_id: int, db: Session = Depends(get_db)):
    return oracle_system_stats(conn_id, db)


# 15
@router.get("/{conn_id}/oracle-awr-sql")
def route_oracle_awr_sql(conn_id: int, db: Session = Depends(get_db)):
    return oracle_awr_sql(conn_id, db)


# 16
@router.get("/{conn_id}/monitoring-dashboard")
def route_oracle_monitoring_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return oracle_monitoring_dashboard(conn_id, db)


# 17
@router.get("/{conn_id}/oracle-slow-queries")
def route_oracle_slow_queries(
    conn_id: int,
    db_name: Optional[str] = None,
    query_type: Optional[str] = None,
    severity: Optional[str] = None,
    user_name: Optional[str] = None,
    search: Optional[str] = None,
    min_avg_ms: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "desc",
    page: int = 1,
    page_size: int = 25,
    db: Session = Depends(get_db),
):
    return oracle_slow_queries_filtered(
        conn_id, db, db_name=db_name, query_type=query_type, severity=severity,
        user_name=user_name, search=search, min_avg_ms=min_avg_ms,
        date_from=date_from, date_to=date_to, sort_by=sort_by, sort_dir=sort_dir,
        page=page, page_size=page_size,
    )


@router.post("/{conn_id}/oracle-slow-queries/analyze-groq")
def route_oracle_slow_query_analyze_groq(
    conn_id: int, payload: oracle_ai_analysis.OracleSlowQueryGroqRequest, db: Session = Depends(get_db)
):
    return oracle_ai_analysis.analyze_slow_query_groq(conn_id, payload, db)


@router.get("/{conn_id}/oracle-slow-queries/{query_id}")
def route_oracle_slow_query_by_id(conn_id: int, query_id: str, db: Session = Depends(get_db)):
    """Lets the shared Slow Query detail page re-fetch by id on a refresh or
    direct link, instead of only working when router state carries the row."""
    from app.services.common.slow_query_normalize import find_normalized_by_id
    response = oracle_slow_queries(conn_id, db)
    row = find_normalized_by_id(response, query_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Query not found in the current slow-query window")
    return {"status": "success", "query": row}


# 18
@router.get("/{conn_id}/oracle-error-logs")
def route_oracle_error_logs(
    conn_id: int,
    hours: int = Query(24, ge=1, le=720, description="Look back this many hours (default 1 day)."),
    ora_only: bool = Query(True, description="Only ORA-/TNS- errors, as the DBA alert-log query does."),
    db: Session = Depends(get_db),
):
    return oracle_error_logs(conn_id, db, hours, ora_only)


# Redo generation — log switches and redo volume per hour, from v$log_history
# and v$archived_log. See oracle_redo_service for why not gv$log_history.
@router.get("/{conn_id}/oracle-redo-generation")
def route_oracle_redo_generation(
    conn_id: int,
    days: int = Query(14, ge=1, le=90),
    db: Session = Depends(get_db),
):
    return oracle_redo_generation(conn_id, db, days)


# 19
@router.get("/{conn_id}/oracle-index-analysis")
def route_oracle_index_analysis(conn_id: int, db: Session = Depends(get_db)):
    return oracle_index_analysis(conn_id, db)


# 20
@router.get("/{conn_id}/oracle-live-queries")
def route_oracle_live_queries(conn_id: int, db: Session = Depends(get_db)):
    return oracle_live_queries(conn_id, db)


# 21
@router.get("/{conn_id}/oracle-locks")
def route_oracle_locks(conn_id: int, db: Session = Depends(get_db)):
    return oracle_locks(conn_id, db)


# 22 — extra query param: refresh (force a live re-fetch, bypassing the static-metadata cache)
@router.get("/{conn_id}/oracle-parameters")
def route_oracle_parameters(conn_id: int, refresh: bool = False, db: Session = Depends(get_db)):
    return oracle_parameters(conn_id, db, refresh)


# 23 — extra query param: sql_id
@router.get("/{conn_id}/oracle-sql-plan")
def route_oracle_sql_plan(conn_id: int, sql_id: str = "", db: Session = Depends(get_db)):
    return oracle_sql_plan(conn_id, db, sql_id)


# 24
@router.get("/{conn_id}/oracle-archive-log-gap")
def route_oracle_archive_log_gap(conn_id: int, db: Session = Depends(get_db)):
    return oracle_archive_log_gap(conn_id, db)


# 25
@router.get("/{conn_id}/oracle-rman-backup")
def route_oracle_rman_backup(conn_id: int, db: Session = Depends(get_db)):
    return oracle_rman_backup(conn_id, db)


@router.get("/{conn_id}/oracle-rac-node-hosts")
def route_oracle_rac_node_hosts(conn_id: int, db: Session = Depends(get_db)):
    return oracle_rac_node_hosts(conn_id, db)


@router.get("/{conn_id}/oracle-rman-job-detail")
def route_oracle_rman_job_detail(conn_id: int, session_key: int, db: Session = Depends(get_db)):
    return oracle_rman_job_detail(conn_id, db, session_key)


# 26
@router.get("/{conn_id}/oracle-invalid-objects")
def route_oracle_invalid_objects_detail(conn_id: int, db: Session = Depends(get_db)):
    return oracle_invalid_objects_detail(conn_id, db)


# 27
@router.get("/{conn_id}/oracle-datafile-mounts")
def route_oracle_datafile_mounts(conn_id: int, db: Session = Depends(get_db)):
    return oracle_datafile_mounts(conn_id, db)


# 28
@router.get("/{conn_id}/oracle-sar-top")
def route_oracle_sar_top(conn_id: int, db: Session = Depends(get_db)):
    return oracle_sar_top(conn_id, db)


# 29
@router.get("/{conn_id}/oracle-ebs-concurrent")
def route_oracle_ebs_concurrent(conn_id: int, db: Session = Depends(get_db)):
    return oracle_ebs_concurrent(conn_id, db)


# 30
@router.get("/{conn_id}/oracle-ebs-workflow")
def route_oracle_ebs_workflow(conn_id: int, db: Session = Depends(get_db)):
    return oracle_ebs_workflow(conn_id, db)


# 31
@router.get("/{conn_id}/oracle-db-status")
def route_oracle_db_status(conn_id: int, db: Session = Depends(get_db)):
    return oracle_db_status(conn_id, db)


# 32 — topology detection (RAC / Data Guard), re-derived live from Oracle
# metadata, never blindly trusting the registration-time selection.
@router.get("/{conn_id}/oracle-topology")
def route_oracle_topology_detect(conn_id: int, db: Session = Depends(get_db)):
    return oracle_topology_detect(conn_id, db)


# 33 — RAC per-instance nodes + cluster health rollup
@router.get("/{conn_id}/oracle-rac-nodes")
def route_oracle_rac_nodes(conn_id: int, db: Session = Depends(get_db)):
    return oracle_rac_nodes(conn_id, db)


# 34 — Oracle Services per-instance availability
@router.get("/{conn_id}/oracle-services")
def route_oracle_services(conn_id: int, db: Session = Depends(get_db)):
    return oracle_services(conn_id, db)


# 35 — ASM disk group usage/state
@router.get("/{conn_id}/oracle-asm")
def route_oracle_asm(conn_id: int, db: Session = Depends(get_db)):
    return oracle_asm(conn_id, db)


# 36 — CDB/PDB (multitenant) status
@router.get("/{conn_id}/oracle-cdb-pdb")
def route_oracle_cdb_pdb(conn_id: int, db: Session = Depends(get_db)):
    return oracle_cdb_pdb(conn_id, db)


# 37 — listener status, differentiated failure modes
@router.get("/{conn_id}/oracle-listener-status")
def route_oracle_listener_status(conn_id: int, db: Session = Depends(get_db)):
    return oracle_listener_status(conn_id, db)


# 38 — Storage Health: largest segments (tables/indexes/LOBs/clusters)
@router.get("/{conn_id}/oracle-storage-segments")
def route_oracle_storage_segments(conn_id: int, db: Session = Depends(get_db)):
    return oracle_storage_segments(conn_id, db)


# 39 — Storage Health: partition inventory + size
@router.get("/{conn_id}/oracle-storage-partitions")
def route_oracle_storage_partitions(conn_id: int, db: Session = Depends(get_db)):
    return oracle_storage_partitions(conn_id, db)


# 40 — Storage Health: tablespaces + datafiles + top segments, bundled
@router.get("/{conn_id}/oracle-storage-overview")
def route_oracle_storage_overview(conn_id: int, db: Session = Depends(get_db)):
    return oracle_storage_overview(conn_id, db)


# 41 — Storage Health: evidence-based findings (decision engine, read-only)
@router.get("/{conn_id}/oracle-storage-findings")
def route_oracle_storage_findings(conn_id: int, db: Session = Depends(get_db)):
    return oracle_storage_findings(conn_id, db)


# 42 — Storage Health: on-demand precise reclaimable-space check (direct connections only)
@router.get("/{conn_id}/oracle-storage-precise-check")
def route_oracle_storage_precise_check(
    conn_id: int, owner: str, segment_name: str, segment_type: str = "TABLE",
    db: Session = Depends(get_db),
):
    return oracle_storage_precise_check(conn_id, db, owner, segment_name, segment_type)


# 43 — Real-Time SQL Monitoring: currently/recently executing SQL (Tuning Pack gated)
@router.get("/{conn_id}/oracle-sql-monitor")
def route_oracle_sql_monitor(conn_id: int, db: Session = Depends(get_db)):
    return oracle_sql_monitor_active(conn_id, db)


# 44 — Real-Time SQL Monitoring: per-plan-step live progress for one execution
@router.get("/{conn_id}/oracle-sql-monitor-detail")
def route_oracle_sql_monitor_detail(
    conn_id: int, sql_id: str, sql_exec_id: str, db: Session = Depends(get_db),
):
    return oracle_sql_monitor_detail(conn_id, db, sql_id, sql_exec_id)


# 45 — SQL statements currently holding more than one distinct plan (v$sql, license-free)
@router.get("/{conn_id}/oracle-plan-instability")
def route_oracle_plan_instability(conn_id: int, db: Session = Depends(get_db)):
    return oracle_plan_instability(conn_id, db)


# 46 — RAC node eviction/rejoin event history (ClickHouse) — real transitions only
@router.get("/{conn_id}/oracle-rac-eviction-events")
def route_oracle_rac_eviction_events(conn_id: int, minutes: int = 1440, db: Session = Depends(get_db)):
    from app.services.clickhouse.metrics_history_service import query_oracle_rac_eviction_events
    return {"status": "success", "events": query_oracle_rac_eviction_events(conn_id, minutes=minutes)}


# 47 — Storage Health: real block-level detail for one datafile/tablespace/segment (drill-down)
@router.get("/{conn_id}/oracle-storage-block-detail")
def route_oracle_storage_block_detail(
    conn_id: int,
    object_type: str,
    file_id: int = None,
    file_name: str = None,
    tablespace_name: str = None,
    owner: str = None,
    segment_name: str = None,
    db: Session = Depends(get_db),
):
    return oracle_storage_block_detail(
        conn_id, db, object_type,
        file_id=file_id, file_name=file_name, tablespace_name=tablespace_name,
        owner=owner, name=segment_name,
    )


# 48 — Storage Health: plain-English explanation / free-text Q&A for one object,
# grounded only in the real facts the page already computed (never invents numbers)
@router.post("/{conn_id}/oracle-storage-ai-explain")
def route_oracle_storage_ai_explain(conn_id: int, payload: oracle_ai_analysis.OracleStorageAiExplainRequest):
    return oracle_ai_analysis.oracle_storage_ai_explain(payload)


# 49 — Storage Health: the real DBA_TABLES dictionary row for one table, grouped
# into steps (identity / storage params / statistics / behavior) for the stepper UI
@router.get("/{conn_id}/oracle-table-dictionary")
def route_oracle_table_dictionary(conn_id: int, owner: str, table_name: str, db: Session = Depends(get_db)):
    return oracle_table_dictionary(conn_id, db, owner, table_name)


# ── Service drill-down: service → instances → instance → sessions → session → SQL.
# Every level is addressed by ids alone so a page at any depth survives a refresh.
from app.services.oracle.oracle_service_drill_service import (  # noqa: E402
    oracle_service_detail,
    oracle_service_instance,
    oracle_service_sessions,
    oracle_session_activity,
    oracle_session_detail,
    oracle_sql_detail,
)


@router.get("/{conn_id}/oracle-service-detail")
def route_oracle_service_detail(conn_id: int, service: str = Query(..., min_length=1, max_length=256),
                                db: Session = Depends(get_db)):
    return oracle_service_detail(conn_id, db, service)


@router.get("/{conn_id}/oracle-service-instance")
def route_oracle_service_instance(conn_id: int, service: str = Query(..., min_length=1, max_length=256),
                                  inst_id: int = Query(..., ge=1, le=1000), db: Session = Depends(get_db)):
    return oracle_service_instance(conn_id, db, service, inst_id)


@router.get("/{conn_id}/oracle-service-sessions")
def route_oracle_service_sessions(conn_id: int, service: str = Query(..., min_length=1, max_length=256),
                                  inst_id: int = Query(..., ge=1, le=1000), db: Session = Depends(get_db)):
    return oracle_service_sessions(conn_id, db, service, inst_id)


@router.get("/{conn_id}/oracle-session-detail")
def route_oracle_session_detail(conn_id: int, inst_id: int = Query(..., ge=1, le=1000),
                                sid: int = Query(..., ge=0), serial: int = Query(..., ge=0),
                                db: Session = Depends(get_db)):
    return oracle_session_detail(conn_id, db, inst_id, sid, serial)


@router.get("/{conn_id}/oracle-sql-detail")
def route_oracle_sql_detail(conn_id: int, sql_id: str = Query(..., pattern=r"^[0-9a-z]{13}$"),
                            inst_id: int | None = Query(None, ge=1, le=1000), db: Session = Depends(get_db)):
    return oracle_sql_detail(conn_id, db, sql_id, inst_id)


# ── Performance tab: Oracle's own 1-minute metric history and the live "top now".
from app.services.oracle.oracle_perf_service import oracle_perf_history, oracle_perf_top_at, oracle_perf_top_now  # noqa: E402


@router.get("/{conn_id}/oracle-perf-history")
def route_oracle_perf_history(conn_id: int, minutes: int = Query(60, ge=5, le=10080),
                              inst_id: int | None = Query(None, ge=1, le=1000), db: Session = Depends(get_db)):
    return oracle_perf_history(conn_id, db, minutes, inst_id)


@router.get("/{conn_id}/oracle-perf-top-now")
def route_oracle_perf_top_now(conn_id: int, inst_id: int | None = Query(None, ge=1, le=1000),
                              db: Session = Depends(get_db)):
    return oracle_perf_top_now(conn_id, db, inst_id)


@router.get("/{conn_id}/oracle-perf-top-at")
def route_oracle_perf_top_at(conn_id: int, at: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"),
                             db: Session = Depends(get_db)):
    return oracle_perf_top_at(conn_id, db, at)


# ── Query Analysis results (keyed by the captured SQL_ID; nothing is executed).
from app.services.oracle.oracle_sql_analysis_service import oracle_sql_plan_stats, oracle_sql_trend  # noqa: E402


@router.get("/{conn_id}/oracle-sql-plan-stats")
def route_oracle_sql_plan_stats(conn_id: int, sql_id: str = Query(..., pattern=r"^[0-9a-z]{13}$"),
                                child: int | None = Query(None, ge=0), db: Session = Depends(get_db)):
    return oracle_sql_plan_stats(conn_id, db, sql_id, child)


@router.get("/{conn_id}/oracle-sql-trend")
def route_oracle_sql_trend(conn_id: int, sql_id: str = Query(..., pattern=r"^[0-9a-z]{13}$"),
                           hours: int = Query(24, ge=1, le=720), db: Session = Depends(get_db)):
    return oracle_sql_trend(conn_id, db, sql_id, hours)


@router.get("/{conn_id}/oracle-session-activity")
def route_oracle_session_activity(conn_id: int, inst_id: int = Query(..., ge=1, le=1000),
                                  sid: int = Query(..., ge=0), serial: int = Query(..., ge=0),
                                  db: Session = Depends(get_db)):
    return oracle_session_activity(conn_id, db, inst_id, sid, serial)
