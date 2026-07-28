from sqlalchemy import Column, Integer, String, Boolean, Text, JSON
from app.database.base import Base


class ConnectionMaster(Base):

    __tablename__ = "connection_master"

    # PRIMARY
    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)  # tenant scope

    # COMMON
    connection_name = Column(String(255))
    db_type = Column(String(100))
    registration_mode = Column(String(100))
    environment = Column(String(100))
    host = Column(String(500))
    port = Column(Integer)
    username = Column(String(255))
    password = Column(String(500))
    database_name = Column(String(255))
    connection_uri = Column(Text)

    # ORACLE
    service_name = Column(String(255))
    sid = Column(String(255))
    tns_descriptor = Column(Text)
    oracle_connect_string = Column(Text)

    # MSSQL
    windows_authentication = Column(Boolean)
    instance_name = Column(String(255))

    # POSTGRESQL
    ssl_mode = Column(String(100))

    # MONGODB
    mongo_protocol = Column(String(100))
    auth_source = Column(String(255))
    replica_set = Column(String(255))

    # CLICKHOUSE
    clickhouse_protocol = Column(String(100))

    # SSH (for remote file access — slow log reading, etc.)
    ssh_host     = Column(String(500))
    ssh_port     = Column(Integer)
    ssh_user     = Column(String(255))
    ssh_password = Column(String(500))

    # CLOUD-BASED DATABASES (Azure Cosmos DB, and future providers — DynamoDB,
    # Firestore, Bigtable, etc.). `cloud_provider` marks a row as belonging to
    # the "Cloud-Based Databases" category; `cloud_config` is a generic JSON
    # blob for provider-specific fields so adding a new provider later doesn't
    # require a schema migration. The two key columns are ENCRYPTED (see
    # app/services/common/crypto_service.py) — unlike every other connection's
    # plaintext `password`, these are master account keys.
    cloud_provider           = Column(String(50))    # 'azure_cosmos' | future: 'dynamodb' | 'firestore' | ...
    cloud_api_type           = Column(String(30))     # Cosmos DB: 'sql' | 'mongodb' | 'cassandra' | 'gremlin' | 'table'
    cloud_account_name       = Column(String(255))
    cloud_endpoint           = Column(String(500))
    cloud_primary_key_enc    = Column(Text)
    cloud_secondary_key_enc  = Column(Text)
    cloud_container_name     = Column(String(255))
    cloud_partition_key      = Column(String(255))
    cloud_config             = Column(JSON)          # preferred_region, consistency_level, connection_timeout_sec,
                                                       # ssl_enabled, proxy, custom_headers, description,
                                                       # monitor_tenant_id, monitor_client_id,
                                                       # monitor_subscription_id, monitor_resource_group, ...
    # Azure Monitor (optional) — a SEPARATE credential from the account key
    # above: an Azure AD Service Principal with "Monitoring Reader" role,
    # used only to read RU/throttling/latency/hot-partition metrics that
    # Azure computes on its own (zero RU cost, doesn't touch the data plane).
    cloud_monitor_client_secret_enc = Column(Text)
