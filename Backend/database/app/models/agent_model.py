from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, BigInteger
from sqlalchemy.sql import func
from app.database.base import Base


class Agent(Base):
    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), unique=True, index=True, nullable=False)
    db_connection_id = Column(Integer, nullable=True)   # FK → connection_master.id
    db_type = Column(String(100), nullable=False, default="MySQL")
    hostname = Column(String(500), nullable=True)
    ip_address = Column(String(100), nullable=True)
    os_type = Column(String(100), nullable=True)
    description = Column(Text, nullable=True)
    environment = Column(String(100), default="Production")
    status = Column(String(50), default="offline")      # online / offline / error
    last_heartbeat = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    collection_interval_sec = Column(Integer, default=60)


class AgentMetric(Base):
    __tablename__ = "agent_metrics"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    host_cpu = Column(Float, default=0.0)
    host_memory = Column(Float, default=0.0)
    db_cpu = Column(Float, default=0.0)
    active_sessions = Column(Integer, default=0)
    connections_used = Column(Integer, default=0)
    connections_max = Column(Integer, default=0)
    cache_hit_pct = Column(Float, default=0.0)
    qps = Column(Float, default=0.0)
    tps = Column(Float, default=0.0)
    uptime_seconds = Column(BigInteger, default=0)


class AgentTopSQL(Base):
    __tablename__ = "agent_top_sql"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    captured_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    sql_id = Column(String(64), nullable=True)
    sql_text = Column(Text, nullable=True)
    executions = Column(Integer, default=0)
    avg_elapsed_ms = Column(Float, default=0.0)
    cpu_time_ms = Column(Float, default=0.0)
    buffer_gets = Column(BigInteger, default=0)
    total_ms = Column(Float, default=0.0)
    max_ms = Column(Float, default=0.0)
    rows_examined = Column(Float, default=0.0)
    rows_sent = Column(Float, default=0.0)


class AgentWaitEvent(Base):
    __tablename__ = "agent_wait_events"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    captured_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    event_name = Column(String(500), nullable=True)
    wait_class = Column(String(255), nullable=True)
    time_waited_ms = Column(Float, default=0.0)
    avg_ms = Column(Float, default=0.0)
    count = Column(Integer, default=0)


class AgentNotification(Base):
    __tablename__ = "agent_notifications"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    message = Column(Text, nullable=False)
    severity = Column(String(50), default="info")       # info / warning / critical
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AgentOracleSnapshot(Base):
    __tablename__ = "agent_oracle_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    captured_at = Column(DateTime(timezone=True), server_default=func.now())
    version = Column(String(500), nullable=True)
    instance_name = Column(String(255), nullable=True)
    startup_time = Column(String(255), nullable=True)
    sga_size_bytes = Column(BigInteger, default=0)
    pga_size_bytes = Column(BigInteger, default=0)
    log_mode = Column(String(100), nullable=True)
    archiver = Column(String(100), nullable=True)
    status = Column(String(100), nullable=True)
    open_mode = Column(String(100), nullable=True)
    database_status = Column(String(100), nullable=True)
    instance_role = Column(String(100), nullable=True)


class AgentSnapshot(Base):
    """Stores full JSON payloads for all monitoring endpoints.
    Routes check this table first — if a fresh snapshot exists they return it
    directly without touching the monitored database at all.
    The agent collector is the ONLY code that ever connects to the monitored DB.
    """
    __tablename__ = "agent_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    connection_id = Column(Integer, index=True, nullable=True)
    snapshot_type = Column(String(100), index=True, nullable=False)
    captured_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    payload = Column(Text, nullable=False)
