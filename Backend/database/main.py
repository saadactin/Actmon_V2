import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Installed FIRST, before any other app module can log anything. No handler
# was ever configured on the root logger anywhere in this app, so every
# `logging.getLogger("some_module")` call was propagating to Python's
# internal "lastResort" handler with no redaction whatsoever — this gives
# root a real handler and attaches the redaction filter TO THAT HANDLER
# (not just the logger: a Filter attached to a Logger object only runs for
# records that logger itself emits, not ones propagating up from a child
# logger — attaching to the handler is what actually makes this apply
# app-wide, to every named logger's propagated records). Scrubs password/
# token/api_key/Authorization-shaped values and embedded URL credentials,
# via the ONE centralized CredentialEncryptionService — never a second
# redaction implementation.
from app.services.common.credential_encryption_service import RedactingLogFilter
logging.basicConfig(level=logging.INFO)
for _h in logging.getLogger().handlers:
    _h.addFilter(RedactingLogFilter())

from app.database.connection import engine
from app.database.base import Base

# Import ALL models so Base registers their tables
from app.models.connection_model import ConnectionMaster          # noqa: F401
from app.models.cosmos_query_log_model import CosmosQueryLog       # noqa: F401
from app.models.os_server_model import OsServer, DatabaseInstance # noqa: F401
from app.models.agent_model import (                              # noqa: F401
    Agent, AgentMetric, AgentTopSQL,
    AgentWaitEvent, AgentNotification, AgentOracleSnapshot, AgentSnapshot,
)
from app.models.oracle_report_schedule_model import OracleReportSchedule  # noqa: F401
from app.models.oracle_topology_model import OracleTopologyLink           # noqa: F401
from app.models.mysql_report_schedule_model import MysqlReportSchedule        # noqa: F401
from app.models.postgres_report_schedule_model import PostgresReportSchedule  # noqa: F401
from app.models.mssql_report_schedule_model import MssqlReportSchedule          # noqa: F401
from app.models.smtp_config_model import SmtpConfig                       # noqa: F401
from app.models.alert_rule_model import AlertRule                         # noqa: F401
from app.models.monitoring_settings_model import MonitoringSettings       # noqa: F401
from app.models.dashboard_appearance_model import DashboardAppearanceSettings  # noqa: F401
from app.models.help_center_appearance_model import HelpCenterAppearance   # noqa: F401
from app.models.diagnosis_run_model import DiagnosisRun                   # noqa: F401
from app.models.db_check_run_model import DbCheckRun                       # noqa: F401
from app.models.patroni_config_history_model import PatroniConfigHistory   # noqa: F401
from app.models.postgres_patroni_ch_retention_settings_model import PostgresPatroniChRetentionSettings  # noqa: F401
# Access-Control / Administration (RBAC) schema — organization, employee, role,
# module, page, permission, user, sessions, audit, etc.
from app.models.admin_models import (                                # noqa: F401
    StatusMaster, OrganizationMaster, DepartmentMaster, DesignationMaster,
    EmployeeMaster, Role, ModuleMaster, PageMaster, Permission,
    GroupRolePagePermission, UserMaster, UserSession, LoginHistory,
    PasswordHistory, AuditLog,
)

# Routes
from app.routes.os_server.server_routes import router as server_router
from app.routes.mysql.mysql_routes import router as mysql_router
from app.routes.oracle.oracle_routes import router as oracle_router
from app.routes.postgres.postgres_routes import router as postgres_router
from app.routes.mongo.mongo_routes import router as mongo_router
from app.routes.clickhouse.clickhouse_routes import router as clickhouse_router
from app.routes.mssql.mssql_routes import router as mssql_router
from app.routes.cosmosdb.cosmosdb_routes import router as cosmosdb_router

from app.routes.postgres.postgres_error_analysis_routes import router as postgres_error_router
from app.routes.postgres.postgres_monitoring_routes import router as postgres_monitoring_router
from app.routes.postgres.postgres_hint_plan_routes import router as postgres_hint_plan_router
from app.routes.postgres.patroni_routes import router as patroni_router
from app.routes.postgres.postgres_drilldown_routes import router as postgres_drilldown_router
from app.routes.drilldown_routes import router as drilldown_router
from app.routes.mongo.mongo_error_analysis_routes import router as mongo_error_router
from app.routes.clickhouse.clickhouse_error_analysis_routes import router as clickhouse_error_router
from app.routes.clickhouse.clickhouse_monitoring_routes import router as clickhouse_monitoring_router
from app.routes.mssql.mssql_error_analysis_routes import router as mssql_error_router
from app.routes.mssql.mssql_monitoring_routes import router as mssql_monitoring_router

from app.routes.mysql.mysql_slow_queries_routes import router as mysql_slow_queries_router
from app.routes.mysql.mysql_explain_routes import router as mysql_explain_router
from app.routes.mysql.mysql_error_logs_routes import router as mysql_error_logs_router
from app.routes.mysql.mysql_index_analysis_routes import router as mysql_index_analysis_router
from app.routes.mysql.mysql_table_routes import router as mysql_table_router
from app.routes.mysql.mysql_replication_routes import router as mysql_replication_router
from app.routes.mysql.mysql_binlog_routes import router as mysql_binlog_router
from app.routes.mysql.mysql_report_routes import router as mysql_report_router

from app.routes.oracle.oracle_monitoring_routes import router as oracle_monitoring_router
from app.routes.oracle.oracle_maintenance_routes import router as oracle_maintenance_router
from app.routes.oracle.oracle_report_email_routes import router as oracle_report_email_router
from app.routes.mysql.mysql_report_email_routes import router as mysql_report_email_router
from app.routes.postgres.postgres_report_email_routes import router as postgres_report_email_router
from app.routes.mssql.mssql_report_email_routes import router as mssql_report_email_router
from app.routes.smtp.smtp_config_routes import router as smtp_config_router
from app.routes.notifications.notification_routes import router as notification_router
from app.routes.settings.monitoring_settings_routes import router as monitoring_settings_router
from app.routes.settings.mysql_ch_retention_routes import router as mysql_ch_retention_router
from app.routes.settings.oracle_ch_retention_routes import router as oracle_ch_retention_router
from app.routes.settings.dashboard_appearance_routes import router as dashboard_appearance_router
from app.routes.settings.help_center_appearance_routes import router as help_center_appearance_router
from app.routes.mongo.mongo_monitoring_routes import router as mongo_monitoring_router

from app.routes.common.db_diagnose_routes import router as db_diagnose_router

from app.routes.os_server.os_server_routes import router as os_server_router
from app.routes.os_server.terminal_routes import router as terminal_router
from app.routes.os_server.test_connection_routes import router as test_connection_router
from app.routes.digital_experience.external_check_routes import router as external_check_router
from app.routes.settings.report_schedule_admin_routes import router as report_schedule_admin_router
from app.routes.auth.auth_routes import router as auth_router
from app.routes.setup.setup_routes import router as setup_router
from app.routes.admin.admin_crud_routes import admin_crud_routers
from app.routes.agent.agent_routes import router as agent_router
from app.routes.agent.db_agent_routes import router as db_agent_router
from app.routes.agent.agent_install_routes import router as agent_install_router
from app.routes.chatbot.chatbot_routes import router as chatbot_router
from app.routes.chatbot.chat_session_routes import router as chat_session_router
from app.routes.admin.ai_chat_audit_routes import router as ai_chat_audit_router
from app.routes.alerts.alert_routes import router as alerts_router
from app.routes.logs.logs_routes import router as logs_router
from app.routes.download.download_routes import router as download_router

# Create all tables in PostgreSQL (graceful — won't crash if DB is offline at import time)
try:
    Base.metadata.create_all(bind=engine)
except Exception as _db_err:
    import warnings
    warnings.warn(f"[ACTMON] Could not create tables: {_db_err}\nStart PostgreSQL and restart the server.")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_instance):
    # Start centralized agent collector — METRICS every 15s (feeds the Redis hot
    # tier at its designed cadence); heavy dashboard snapshots stay at ~60s inside
    # the collector (SNAPSHOT_INTERVAL_SEC). Override with AGENT_COLLECTOR_INTERVAL.
    import os as _os
    from app.services.agent.agent_collector_service import start_agent_collector
    start_agent_collector(interval_sec=int(_os.getenv("AGENT_COLLECTOR_INTERVAL", "15") or 15))
    # Metrics pipeline: Redis hot tier (15s samples) + ClickHouse history tier.
    # Registers an AgentMetric insert hook — every metric write (agent pushes AND
    # collector cycles) flows through automatically. Degrades to no-op when
    # Redis/ClickHouse aren't installed.
    try:
        from app.services.common import metrics_pipeline
        metrics_pipeline.register_hooks()
    except Exception as _mp_err:
        import warnings; warnings.warn(f"[metrics_pipeline] not started: {_mp_err}")
    # Start agent reaper (marks uninstalled/offline agents, removes dead hosts)
    from app.services.agent.agent_reaper_service import start_agent_reaper
    start_agent_reaper(interval_sec=15)
    # Start ActMon metric logger → ClickHouse (per-metric time-series)
    try:
        from app.services.logs.actmon_logs_service import start_metric_logger
        start_metric_logger()
    except Exception as _log_err:
        import warnings; warnings.warn(f"[actmon_logs] logger not started: {_log_err}")
    # Start PostgreSQL resource history collector (logs CPU/RAM/Disk + spike evidence)
    from app.services.postgres.postgres_resource_collector import start_resource_collector
    start_resource_collector()
    # Start Digital Experience external-check scheduler (Website/Ping/DNS/TCP/UDP)
    from app.services.digital_experience.external_check_service import start_external_check_scheduler
    start_external_check_scheduler()
    # Start Oracle report email scheduler
    from app.services.oracle.oracle_report_email_service import start_oracle_report_scheduler
    start_oracle_report_scheduler()
    # Start MySQL report email scheduler
    from app.services.mysql.mysql_report_email_service import start_mysql_report_scheduler
    start_mysql_report_scheduler()
    # Start PostgreSQL report email scheduler
    from app.services.postgres.postgres_report_email_service import start_postgres_report_scheduler
    start_postgres_report_scheduler()
    # Start SQL Server report email scheduler
    from app.services.mssql.mssql_report_email_service import start_mssql_report_scheduler
    start_mssql_report_scheduler()
    # Enterprise Alert Notification System: the evaluator tracks sustained
    # breaches/cooldown and enqueues notifications; the dispatcher sends them
    # (with retry) so the evaluator never waits on a channel to respond.
    from app.services.alerts.alert_evaluator_service import start_alert_evaluator
    start_alert_evaluator()
    from app.services.notifications.notification_queue_service import start_notification_dispatcher
    start_notification_dispatcher()
    # Keeps DatabaseInstance.status current for SSH-polled hosts — without
    # this, "Database Service Down" alerts could keep firing on a status that
    # was only ever checked once, whenever someone last clicked Refresh.
    from app.services.os_server.os_server_refresh_scheduler import start_os_server_refresh_scheduler
    start_os_server_refresh_scheduler()
    # Oracle Storage Health: executes admin-approved maintenance jobs (SHRINK/
    # MOVE/REBUILD) — never runs anything that wasn't explicitly approved.
    from app.services.oracle.oracle_maintenance_job_runner import start_oracle_maintenance_job_runner
    start_oracle_maintenance_job_runner()
    yield
    # Graceful shutdown
    from app.services.agent.agent_collector_service import stop_agent_collector
    stop_agent_collector()
    from app.services.agent.agent_reaper_service import stop_agent_reaper
    stop_agent_reaper()
    from app.services.alerts.alert_evaluator_service import stop_alert_evaluator
    stop_alert_evaluator()
    from app.services.notifications.notification_queue_service import stop_notification_dispatcher
    stop_notification_dispatcher()
    from app.services.os_server.os_server_refresh_scheduler import stop_os_server_refresh_scheduler
    stop_os_server_refresh_scheduler()
    from app.services.oracle.oracle_maintenance_job_runner import stop_oracle_maintenance_job_runner
    stop_oracle_maintenance_job_runner()
    # These 4 report-email schedulers were started above but never stopped —
    # harmless in a normal single-shutdown process exit, but on any in-process
    # lifespan re-entry (a reload, or a test harness starting the app twice)
    # the old threads were left running, orphaned, alongside new ones.
    from app.services.oracle.oracle_report_email_service import stop_oracle_report_scheduler
    stop_oracle_report_scheduler()
    from app.services.mysql.mysql_report_email_service import stop_mysql_report_scheduler
    stop_mysql_report_scheduler()
    from app.services.postgres.postgres_report_email_service import stop_postgres_report_scheduler
    stop_postgres_report_scheduler()
    from app.services.mssql.mssql_report_email_service import stop_mssql_report_scheduler
    stop_mssql_report_scheduler()

app = FastAPI(
    title="ACTMON API",
    version="2.0.0",
    description="ACTMON Database Monitoring Platform",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Connection CRUD routes
app.include_router(mysql_router)
app.include_router(oracle_router)
app.include_router(postgres_router)
app.include_router(mongo_router)
app.include_router(clickhouse_router)
app.include_router(mssql_router)
app.include_router(cosmosdb_router)
app.include_router(server_router)

# Error analysis routes
app.include_router(postgres_error_router)
app.include_router(postgres_monitoring_router)
app.include_router(postgres_hint_plan_router)
app.include_router(patroni_router)
app.include_router(postgres_drilldown_router)
app.include_router(drilldown_router)
app.include_router(mongo_error_router)
app.include_router(clickhouse_error_router)
app.include_router(clickhouse_monitoring_router)
app.include_router(mssql_error_router)
app.include_router(mssql_monitoring_router)

# MySQL specialty routes
app.include_router(mysql_slow_queries_router)
app.include_router(mysql_explain_router)
app.include_router(mysql_error_logs_router)
app.include_router(mysql_index_analysis_router)
app.include_router(mysql_table_router)
app.include_router(mysql_replication_router)
app.include_router(mysql_binlog_router)
app.include_router(mysql_report_router)

app.include_router(db_diagnose_router)

# DB Monitoring routes
app.include_router(oracle_monitoring_router)
app.include_router(oracle_maintenance_router)
app.include_router(oracle_report_email_router)
app.include_router(mysql_report_email_router)
app.include_router(postgres_report_email_router)
app.include_router(mssql_report_email_router)
app.include_router(smtp_config_router)
app.include_router(monitoring_settings_router)
app.include_router(mysql_ch_retention_router)
app.include_router(oracle_ch_retention_router)
app.include_router(dashboard_appearance_router)
app.include_router(help_center_appearance_router)
app.include_router(mongo_monitoring_router)

# New OS server + terminal routes
app.include_router(os_server_router)
app.include_router(terminal_router)
app.include_router(test_connection_router)
app.include_router(external_check_router)
app.include_router(report_schedule_admin_router)
from app.routes.onboarding_routes import router as onboarding_router
app.include_router(onboarding_router)

# Metrics pipeline (Redis hot tier + ClickHouse history) read endpoints
from app.routes.redis.metrics_routes import router as metrics_pipeline_router
app.include_router(metrics_pipeline_router)
from app.routes.connection_manage_routes import router as connection_manage_router
app.include_router(connection_manage_router)
app.include_router(auth_router)
app.include_router(setup_router)   # first-run: create the initial Super Admin

# Administration / Access Control (roles, permissions, modules, pages, orgs,
# departments, designations, employees, users, statuses, audit-logs — all generic)
for _admin_router in admin_crud_routers:
    app.include_router(_admin_router)

# Organization logo upload + the static directory it's served back from.
# Mounted under /api/v1/ (not a bare /uploads/) so nginx's existing "proxy
# every /api/ path to this backend" rule already covers it — no new,
# per-deployment nginx location block needed just for this.
from fastapi.staticfiles import StaticFiles
from app.routes.admin.admin_upload_routes import router as admin_upload_router, _UPLOAD_ROOT
app.include_router(admin_upload_router)
app.mount("/api/v1/uploads", StaticFiles(directory=_UPLOAD_ROOT), name="uploads")

# Centralized Agent routes
app.include_router(agent_router)
app.include_router(db_agent_router)
app.include_router(agent_install_router)

# ActMon AI Chatbot
app.include_router(chatbot_router)
app.include_router(chat_session_router)
app.include_router(ai_chat_audit_router)
app.include_router(alerts_router)
app.include_router(notification_router)
app.include_router(logs_router)
app.include_router(download_router)


@app.get("/")
def home():
    return {
        "status": "success",
        "message": "ACTMON Backend v2.0 Running — PostgreSQL"
    }
