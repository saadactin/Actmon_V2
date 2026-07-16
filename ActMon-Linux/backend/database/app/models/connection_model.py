from sqlalchemy import Column, Integer, String, Boolean, Text
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
