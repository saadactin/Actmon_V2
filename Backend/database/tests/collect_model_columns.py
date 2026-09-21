"""Print this service's SQLAlchemy-declared columns as JSON, for the cloud
service's verify_schema_drift.py to compare against the live database.

Run: python tests\\collect_model_columns.py    (from Backend/database, using
the interpreter that actually runs this service -- see the note in
verify_schema_drift.py about why that is NOT venv\\Scripts\\python.exe here.)

Why this is a separate process at all: the cloud and database services both
define a top-level `app` package with their own, differently-built
SQLAlchemy `Base` (DeclarativeBase vs declarative_base()). Importing both
into one interpreter collides on the package name. Running each service's
model registration in ITS OWN interpreter, with ITS OWN dependencies, and
handing back plain JSON sidesteps that entirely -- and means this script
uses exactly the import list `main.py` uses to register models, not a
guess at what "the models" are.

Deliberately does NOT import `main` itself: that would also import every
route module (agents, chatbot, terminal, ...) and run `Base.metadata.
create_all(bind=engine)` against a live database. This script only needs
Python-side metadata -- no engine, no connection, no table creation.
"""
import json
import pathlib
import sys

# Run as `tests\collect_model_columns.py`, so sys.path[0] is tests/, not the
# service root -- `app` would not resolve without this, exactly like every
# suite in the cloud service's tests/ inserts its own parent directory.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

# The exact model-import block from Backend/database/main.py (lines 27-53),
# copied rather than imported from main.py, on purpose -- see the module
# docstring for why importing main.py itself is not safe here.
from app.database.base import Base  # noqa: E402

from app.models.connection_model import ConnectionMaster  # noqa: F401,E402
from app.models.cosmos_query_log_model import CosmosQueryLog  # noqa: F401,E402
from app.models.os_server_model import OsServer, DatabaseInstance  # noqa: F401,E402
from app.models.agent_model import (  # noqa: F401,E402
    Agent, AgentMetric, AgentTopSQL,
    AgentWaitEvent, AgentNotification, AgentOracleSnapshot, AgentSnapshot,
)
from app.models.oracle_topology_model import OracleTopologyLink  # noqa: F401,E402
from app.models.mysql_report_schedule_model import MysqlReportSchedule  # noqa: F401,E402
from app.models.postgres_report_schedule_model import PostgresReportSchedule  # noqa: F401,E402
from app.models.mssql_report_schedule_model import MssqlReportSchedule  # noqa: F401,E402
from app.models.smtp_config_model import SmtpConfig  # noqa: F401,E402
from app.models.alert_rule_model import AlertRule  # noqa: F401,E402
from app.models.monitoring_settings_model import MonitoringSettings  # noqa: F401,E402
from app.models.dashboard_appearance_model import DashboardAppearanceSettings  # noqa: F401,E402
from app.models.diagnosis_run_model import DiagnosisRun  # noqa: F401,E402
from app.models.db_check_run_model import DbCheckRun  # noqa: F401,E402
from app.models.patroni_config_history_model import PatroniConfigHistory  # noqa: F401,E402
from app.models.postgres_patroni_ch_retention_settings_model import (  # noqa: F401,E402
    PostgresPatroniChRetentionSettings,
)
from app.models.admin_models import (  # noqa: F401,E402
    StatusMaster, OrganizationMaster, DepartmentMaster, DesignationMaster,
    EmployeeMaster, Role, ModuleMaster, PageMaster, Permission,
    GroupRolePagePermission, UserMaster, UserSession, LoginHistory,
    PasswordHistory, AuditLog,
)


def collect():
    tables = {}
    for table_name, table in Base.metadata.tables.items():
        columns = {}
        for col in table.columns:
            columns[col.name] = {
                "type": str(col.type),
                "nullable": bool(col.nullable),
                "has_default": col.default is not None or col.server_default is not None,
            }
        tables[table_name] = columns
    return tables


if __name__ == "__main__":
    print(json.dumps({"tables": collect()}))
    sys.exit(0)
