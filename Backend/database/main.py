from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database.connection import engine
from app.database.base import Base

# Import ALL models so Base registers their tables
from app.models.connection_model import ConnectionMaster          # noqa: F401
from app.models.os_server_model import OsServer, DatabaseInstance # noqa: F401
from app.models.backup_model import BackupJob                     # noqa: F401
from app.models.backup_schedule_model import BackupSchedule       # noqa: F401
from app.models.agent_model import (                              # noqa: F401
    Agent, AgentMetric, AgentTopSQL,
    AgentWaitEvent, AgentNotification, AgentOracleSnapshot, AgentSnapshot,
)
from app.models.oracle_report_schedule_model import OracleReportSchedule  # noqa: F401
from app.models.mysql_report_schedule_model import MysqlReportSchedule        # noqa: F401
from app.models.postgres_report_schedule_model import PostgresReportSchedule  # noqa: F401
from app.models.smtp_config_model import SmtpConfig                       # noqa: F401

# Routes
from app.routes.os_server.server_routes import router as server_router
from app.routes.mysql.mysql_routes import router as mysql_router
from app.routes.oracle.oracle_routes import router as oracle_router
from app.routes.postgres.postgres_routes import router as postgres_router
from app.routes.mongo.mongo_routes import router as mongo_router
from app.routes.clickhouse.clickhouse_routes import router as clickhouse_router
from app.routes.mssql.mssql_routes import router as mssql_router

from app.routes.postgres.postgres_error_analysis_routes import router as postgres_error_router
from app.routes.postgres.postgres_monitoring_routes import router as postgres_monitoring_router
from app.routes.mongo.mongo_error_analysis_routes import router as mongo_error_router
from app.routes.clickhouse.clickhouse_error_analysis_routes import router as clickhouse_error_router
from app.routes.clickhouse.clickhouse_monitoring_routes import router as clickhouse_monitoring_router
from app.routes.mssql.mssql_error_analysis_routes import router as mssql_error_router
from app.routes.mssql.mssql_monitoring_routes import router as mssql_monitoring_router

from app.routes.mysql.mysql_slow_queries_routes import router as mysql_slow_queries_router
from app.routes.mysql.mysql_explain_routes import router as mysql_explain_router
from app.routes.mysql.mysql_error_logs_routes import router as mysql_error_logs_router
from app.routes.mysql.mysql_index_analysis_routes import router as mysql_index_analysis_router
from app.routes.mysql.mysql_backup_routes import router as mysql_backup_router
from app.routes.mysql.mysql_schedule_routes import router as mysql_schedule_router
from app.routes.mysql.mysql_table_routes import router as mysql_table_router
from app.routes.mysql.mysql_replication_routes import router as mysql_replication_router

from app.routes.oracle.oracle_monitoring_routes import router as oracle_monitoring_router
from app.routes.oracle.oracle_report_email_routes import router as oracle_report_email_router
from app.routes.mysql.mysql_report_email_routes import router as mysql_report_email_router
from app.routes.postgres.postgres_report_email_routes import router as postgres_report_email_router
from app.routes.smtp.smtp_config_routes import router as smtp_config_router
from app.routes.mongo.mongo_monitoring_routes import router as mongo_monitoring_router

from app.routes.postgres.postgres_backup_routes import router as postgres_backup_router
from app.routes.mssql.mssql_backup_routes import router as mssql_backup_router

from app.routes.os_server.os_server_routes import router as os_server_router
from app.routes.os_server.terminal_routes import router as terminal_router
from app.routes.os_server.test_connection_routes import router as test_connection_router
from app.routes.auth.auth_routes import router as auth_router
from app.routes.admin.admin_crud_routes import admin_crud_routers
from app.routes.agent.agent_routes import router as agent_router
from app.routes.chatbot.chatbot_routes import router as chatbot_router

# Create all tables in PostgreSQL (graceful — won't crash if DB is offline at import time)
try:
    Base.metadata.create_all(bind=engine)
except Exception as _db_err:
    import warnings
    warnings.warn(f"[ACTMON] Could not create tables: {_db_err}\nStart PostgreSQL and restart the server.")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_instance):
    # Start backup scheduler background threads on server startup
    from app.routes.mysql.mysql_schedule_routes import start_scheduler
    start_scheduler()
    from app.services.postgres.postgres_backup_service import start_pg_scheduler
    start_pg_scheduler()
    from app.services.mssql.mssql_backup_service import start_mssql_scheduler
    start_mssql_scheduler()
    # Start centralized agent collector (polls monitored DBs every 60s)
    from app.services.agent.agent_collector_service import start_agent_collector
    start_agent_collector(interval_sec=60)
    # Start Oracle report email scheduler
    from app.services.oracle.oracle_report_email_service import start_oracle_report_scheduler
    start_oracle_report_scheduler()
    # Start MySQL report email scheduler
    from app.services.mysql.mysql_report_email_service import start_mysql_report_scheduler
    start_mysql_report_scheduler()
    # Start PostgreSQL report email scheduler
    from app.services.postgres.postgres_report_email_service import start_postgres_report_scheduler
    start_postgres_report_scheduler()
    yield
    # Graceful shutdown
    from app.services.agent.agent_collector_service import stop_agent_collector
    stop_agent_collector()

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
app.include_router(server_router)

# Error analysis routes
app.include_router(postgres_error_router)
app.include_router(postgres_monitoring_router)
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
app.include_router(mysql_schedule_router)   # must come before backup_router (avoids /{job_id} conflict)
app.include_router(mysql_backup_router)
app.include_router(mysql_table_router)
app.include_router(mysql_replication_router)

# PostgreSQL backup + PITR routes (schedule routes are embedded in the same router — ordered correctly)
app.include_router(postgres_backup_router)

# MSSQL backup + PITR routes
app.include_router(mssql_backup_router)

# DB Monitoring routes
app.include_router(oracle_monitoring_router)
app.include_router(oracle_report_email_router)
app.include_router(mysql_report_email_router)
app.include_router(postgres_report_email_router)
app.include_router(smtp_config_router)
app.include_router(mongo_monitoring_router)

# New OS server + terminal routes
app.include_router(os_server_router)
app.include_router(terminal_router)
app.include_router(test_connection_router)
app.include_router(auth_router)

# Administration / Access Control (roles, permissions, modules, pages, orgs,
# departments, designations, employees, users, statuses, audit-logs — all generic)
for _admin_router in admin_crud_routers:
    app.include_router(_admin_router)

# Centralized Agent routes
app.include_router(agent_router)

# ActMon AI Chatbot
app.include_router(chatbot_router)


@app.get("/")
def home():
    return {
        "status": "success",
        "message": "ACTMON Backend v2.0 Running — PostgreSQL"
    }
