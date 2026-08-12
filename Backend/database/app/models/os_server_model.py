from sqlalchemy import Column, Integer, String, Boolean, DateTime, JSON, ForeignKey, Text
from sqlalchemy.orm import relationship
from datetime import datetime
from app.database.base import Base


class OsServer(Base):
    __tablename__ = "os_servers"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)  # tenant scope
    server_name = Column(String(255), nullable=False)
    hostname = Column(String(500))
    ip_address = Column(String(100), nullable=False)
    os_type = Column(String(100), default="Linux")
    environment = Column(String(100), default="Production")
    node_type = Column(String(100), default="Standalone")
    cluster_name = Column(String(255))
    ssh_port = Column(Integer, default=22)
    ssh_username = Column(String(255))
    ssh_password = Column(String(500))
    database_services = Column(JSON, default=list)
    status = Column(String(50), default="Unknown")
    monitoring_enabled = Column(Boolean, default=True)
    auto_discovery = Column(Boolean, default=True)

    # Connection transport: 'ssh' (poll over SSH) or 'agent' (host agent pushes data)
    collector = Column(String(20), default="ssh")
    agent_token = Column(String(128), index=True, nullable=True)
    last_infra_json = Column(Text, nullable=True)     # latest agent-pushed snapshot
    last_infra_at = Column(DateTime, nullable=True)

    # Live metrics (refreshed via SSH)
    cpu_usage = Column(String(20))
    ram_usage = Column(String(20))
    disk_usage = Column(String(20))
    uptime = Column(String(100))

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    db_instances = relationship(
        "DatabaseInstance",
        back_populates="server",
        cascade="all, delete-orphan"
    )


class DatabaseInstance(Base):
    __tablename__ = "database_instances"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)  # tenant scope
    server_id = Column(Integer, ForeignKey("os_servers.id"), nullable=False)
    db_type = Column(String(100))
    db_version = Column(String(100))
    port = Column(Integer)
    status = Column(String(50), default="Unknown")
    # When `status` last actually changed (not merely re-checked) — this is
    # what an alert's "since when" should read, not the send time.
    status_changed_at = Column(DateTime, nullable=True)
    # Raw diagnostic text from the last check while Stopped (e.g. systemctl
    # status output) — surfaced in the "Database Service Down" alert's Error
    # field so the recipient doesn't have to SSH in just to see why.
    status_detail = Column(Text, nullable=True)
    connection_id = Column(Integer, nullable=True)   # references connection_master.id
    created_at = Column(DateTime, default=datetime.utcnow)

    server = relationship("OsServer", back_populates="db_instances")
