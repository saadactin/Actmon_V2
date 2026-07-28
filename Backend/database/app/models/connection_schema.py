from typing import Optional
from pydantic import BaseModel, Field


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


# =========================================================
# CLOUD-BASED DATABASES — Azure Cosmos DB
# (does NOT extend BaseConnectionCreate: no host/port/username concept —
#  Cosmos DB is addressed by an account endpoint URL + a key)
# =========================================================

class CosmosDBConnectionCreate(BaseModel):

    connection_name: str

    account_name: Optional[str] = None
    endpoint: str
    # Required when creating a new connection; optional on update — leaving it
    # blank on an edit keeps the previously-saved (encrypted) key untouched.
    primary_key: Optional[str] = None
    secondary_key: Optional[str] = None

    database_name: str
    container_name: str
    partition_key: Optional[str] = None

    api_type: str = Field(default="sql", pattern="^(sql|mongodb|cassandra|gremlin|table)$")

    preferred_region: Optional[str] = None
    consistency_level: Optional[str] = None
    connection_timeout_sec: Optional[int] = 30
    ssl_enabled: Optional[bool] = True
    proxy: Optional[str] = None
    custom_headers: Optional[str] = None
    description: Optional[str] = None

    # Informational only (shown in the UI, used nowhere for authentication) —
    # this app never requires an Azure AD App Registration / Service Principal.
    # Every metric is derived from the Cosmos SDK using just the endpoint + key.
    resource_group: Optional[str] = None
    subscription_id: Optional[str] = None