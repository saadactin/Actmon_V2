from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database.connection import engine
from app.database.base import Base

# Import ALL models so Base registers their tables
from app.models.connection_model import ConnectionMaster          # noqa: F401
from app.models.os_server_model import OsServer, DatabaseInstance # noqa: F401
from app.models.backup_model import BackupJob                     # noqa: F401
from app.models.backup_schedule_model import BackupSchedule       # noqa: F401

# Routes
from app.routes.server_routes import router as server_router
from app.routes.mysql_routes import router as mysql_router
from app.routes.oracle_routes import router as oracle_router
from app.routes.postgres_routes import router as postgres_router
from app.routes.mongo_routes import router as mongo_router
from app.routes.clickhouse_routes import router as clickhouse_router
from app.routes.mssql_routes import router as mssql_router

from app.routes.postgres_error_analysis_routes import router as postgres_error_router
from app.routes.postgres_monitoring_routes import router as postgres_monitoring_router
from app.routes.mongo_error_analysis_routes import router as mongo_error_router
from app.routes.clickhouse_error_analysis_routes import router as clickhouse_error_router
from app.routes.clickhouse_monitoring_routes import router as clickhouse_monitoring_router
from app.routes.mssql_error_analysis_routes import router as mssql_error_router
from app.routes.mssql_monitoring_routes import router as mssql_monitoring_router

from app.routes.mysql_slow_queries_routes import router as mysql_slow_queries_router
from app.routes.mysql_explain_routes import router as mysql_explain_router
from app.routes.mysql_error_logs_routes import router as mysql_error_logs_router
from app.routes.mysql_index_analysis_routes import router as mysql_index_analysis_router
from app.routes.mysql_backup_routes import router as mysql_backup_router
from app.routes.mysql_schedule_routes import router as mysql_schedule_router
from app.routes.mysql_table_routes import router as mysql_table_router
from app.routes.mysql_replication_routes import router as mysql_replication_router

from app.routes.oracle_monitoring_routes import router as oracle_monitoring_router
from app.routes.mongo_monitoring_routes import router as mongo_monitoring_router

from app.routes.os_server_routes import router as os_server_router
from app.routes.terminal_routes import router as terminal_router
from app.routes.test_connection_routes import router as test_connection_router
from app.routes.auth_routes import router as auth_router

# Create all tables in PostgreSQL (graceful — won't crash if DB is offline at import time)
try:
    Base.metadata.create_all(bind=engine)
except Exception as _db_err:
    import warnings
    warnings.warn(f"[ACTMON] Could not create tables: {_db_err}\nStart PostgreSQL and restart the server.")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app_instance):
    # Start backup scheduler background thread on server startup
    from app.routes.mysql_schedule_routes import start_scheduler
    start_scheduler()
    yield

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
app.include_router(mysql_backup_router)
app.include_router(mysql_schedule_router)
app.include_router(mysql_table_router)
app.include_router(mysql_replication_router)

# DB Monitoring routes
app.include_router(oracle_monitoring_router)
app.include_router(mongo_monitoring_router)

# New OS server + terminal routes
app.include_router(os_server_router)
app.include_router(terminal_router)
app.include_router(test_connection_router)
app.include_router(auth_router)


@app.get("/")
def home():
    return {
        "status": "success",
        "message": "ACTMON Backend v2.0 Running — PostgreSQL"
    }
