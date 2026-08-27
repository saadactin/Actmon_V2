from sqlalchemy import Column, Integer, String, Boolean, Text, JSON
from app.database.base import Base
from app.models._encrypted_type import EncryptedString


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
    # Encrypted at rest (AES-256-GCM, see CredentialEncryptionService) — reads
    # via the ORM (conn.password) transparently get plaintext back, exactly as
    # before; only the raw database row holds ciphertext.
    password = Column(EncryptedString)
    database_name = Column(String(255))
    # Encrypted at rest — a full connection URI (mongodb://user:pass@host/...)
    # can embed credentials inline; `mongo_connection_service` writes username/
    # password to their own dedicated columns and never populates this one
    # today, but a legacy/manually-seeded row can still hold a live URI, so it
    # gets the same protection as every other credential column.
    connection_uri = Column(EncryptedString)

    # ORACLE
    service_name = Column(String(255))
    sid = Column(String(255))
    # Encrypted at rest for the same reason as `connection_uri` — in normal use
    # these are bare EZConnect/TNS descriptors (host:port/service, no
    # credentials; oracledb.connect() is always given `user`/`password`
    # separately, see agent_collector_service.py), but a user can paste a full
    # `user/pass@host` string here, and oracle_connection_service strips any
    # embedded credential into the dedicated username/password columns before
    # save (see _extract_embedded_credentials) — this is defense in depth for
    # whatever text remains.
    tns_descriptor = Column(EncryptedString)
    oracle_connect_string = Column(EncryptedString)
    # Topology: `oracle_deployment_type` is the user's selection at registration
    # time (standalone|rac|data_guard|rac_dg) — a hint, not a source of truth;
    # actual topology is always re-detected live from GV$INSTANCE/V$DATABASE
    # (see oracle_monitoring_service.oracle_topology_detect). `oracle_role` is
    # collector-maintained (primary|standby|farsync|unknown), compared against
    # the freshly-detected role every cycle to catch switchover/failover role
    # transitions (see oracle_history_flush_service).
    oracle_deployment_type = Column(String(50))
    oracle_role = Column(String(50))
    # RAC per-instance status baseline — {"<instance_number>": "<status>"} from
    # the last collector cycle, compared every cycle to detect an actual
    # OPEN->non-OPEN (eviction) or non-OPEN->OPEN (rejoin) TRANSITION, the same
    # role-transition-detection idea as oracle_role above, just keyed per node
    # instead of a single value (see oracle_history_flush_service.flush_rac_nodes).
    oracle_rac_node_status = Column(JSON)

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
    ssh_password = Column(EncryptedString)  # encrypted at rest, same as `password` above

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
