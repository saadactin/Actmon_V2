"""
Oracle Monitoring routes — thin handlers only.
All business logic lives in app/services/oracle/oracle_monitoring_service.py
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
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
    oracle_redo_logs,
    oracle_data_guard,
    oracle_processes,
    oracle_system_stats,
    oracle_awr_sql,
    oracle_monitoring_dashboard,
    oracle_slow_queries,
    oracle_error_logs,
    oracle_index_analysis,
    oracle_live_queries,
    oracle_locks,
    oracle_parameters,
    oracle_sql_plan,
    oracle_archive_log_gap,
    oracle_rman_backup,
    oracle_invalid_objects_detail,
    oracle_datafile_mounts,
    oracle_sar_top,
    oracle_ebs_concurrent,
    oracle_ebs_workflow,
    oracle_db_status,
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
def route_oracle_dashboard(conn_id: int, db: Session = Depends(get_db)):
    return oracle_dashboard(conn_id, db)


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
def route_oracle_slow_queries(conn_id: int, db: Session = Depends(get_db)):
    return oracle_slow_queries(conn_id, db)


# 18
@router.get("/{conn_id}/oracle-error-logs")
def route_oracle_error_logs(conn_id: int, db: Session = Depends(get_db)):
    return oracle_error_logs(conn_id, db)


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


# 22
@router.get("/{conn_id}/oracle-parameters")
def route_oracle_parameters(conn_id: int, db: Session = Depends(get_db)):
    return oracle_parameters(conn_id, db)


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
