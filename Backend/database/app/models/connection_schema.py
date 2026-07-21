from typing import Optional
from pydantic import BaseModel


# =========================================================
# BASE CONNECTION
# =========================================================

class BaseConnectionCreate(BaseModel):

    connection_name: str
    host: str
    port: int
    username: str
    password: str
    database_name: str

# =========================================================
# MYSQL
# =========================================================

class MySQLConnectionCreate(
    BaseConnectionCreate
):
    pass


# =========================================================
# ORACLE
# =========================================================

class OracleConnectionCreate(
    BaseConnectionCreate
):

    service_name: Optional[str] = None

    sid: Optional[str] = None

    tns_descriptor: Optional[str] = None

    oracle_connect_string: Optional[str] = None


# =========================================================
# POSTGRESQL
# =========================================================

class PostgreSQLConnectionCreate(
    BaseConnectionCreate
):

    ssl_mode: Optional[str] = "prefer"


# =========================================================
# MSSQL
# =========================================================

class MSSQLConnectionCreate(
    BaseConnectionCreate
):

    windows_authentication: Optional[bool] = False

    instance_name: Optional[str] = None


# =========================================================
# MONGODB
# =========================================================

class MongoDBConnectionCreate(
    BaseConnectionCreate
):

    mongo_protocol: Optional[str] = "mongodb://"

    auth_source: Optional[str] = "admin"

    replica_set: Optional[str] = None


# =========================================================
# CLICKHOUSE
# =========================================================

class ClickHouseConnectionCreate(
    BaseConnectionCreate
):

    clickhouse_protocol: Optional[str] = "native"