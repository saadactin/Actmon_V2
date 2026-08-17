from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, BigInteger
from sqlalchemy.sql import func
from app.database.base import Base
from app.models._encrypted_type import EncryptedString


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
    last_error = Column(Text, nullable=True)             # why the last collection failed (UI hover)
    last_heartbeat = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    collection_interval_sec = Column(Integer, default=60)
    # Which build of the agent this host is actually running — reported on every
    # infra push and on the boot ping. Without it there is no way to tell a
    # successful upgrade from a silently-failed one, or to find hosts still on an
    # old build. NULL means the host predates version reporting.
    agent_version = Column(String(40), nullable=True)
    agent_version_seen_at = Column(DateTime(timezone=True), nullable=True)


class AgentPendingUpdate(Base):
    """Ledger for one in-flight agent upgrade — turns "we sent the command" into
    "the new build actually came up and told us its version".

    Lifecycle:
      pending    — command queued, agent hasn't picked it up yet
      installing — agent accepted the job (MSI scheduled / source swapped)
      completed  — a heartbeat/boot-ping arrived reporting expected_version
      version_mismatch — the agent came back, but on a DIFFERENT version than
                   expected (upgrade ran and silently produced the wrong build)
      timed_out  — nothing reported back within the timeout window
      failed     — the agent itself reported the attempt failed (e.g. checksum
                   mismatch, msiexec error), with the reason in `detail`
    """
    __tablename__ = "agent_pending_update"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    expected_version = Column(String(40), nullable=True)
    from_version = Column(String(40), nullable=True)
    status = Column(String(30), nullable=False, default="pending")
    detail = Column(Text, nullable=True)
    issued_at = Column(DateTime(timezone=True), server_default=func.now())
    issued_by = Column(Integer, nullable=True)      # user_id who pushed it
    delivered_at = Column(DateTime(timezone=True), nullable=True)
    confirmed_at = Column(DateTime(timezone=True), nullable=True)
    confirmed_version = Column(String(40), nullable=True)


class AgentToken(Base):
    """Ingestion token issued by the Add-Agent wizard. A host agent enrolls with
    this token to resolve its agent identity, then pushes metrics to /data."""
    __tablename__ = "agent_tokens"

    id = Column(Integer, primary_key=True, index=True)
    # Bearer credential — hashed for lookup, not encrypted (see os_servers.agent_token_hash
    # for the rationale). `token` is kept present-but-unread as the rollback path.
    token = Column(String(128), unique=True, index=True, nullable=False)
    token_hash = Column(String(64), unique=True, index=True, nullable=True)
    token_name = Column(String(255), nullable=True)
    agent_name = Column(String(255), nullable=True)
    os_type = Column(String(50), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AgentDbTarget(Base):
    """A database the agent monitors locally (credentials supplied in the Add-DB
    wizard). The agent fetches these by token, connects to the DB on the host, and
    pushes DB internals — the backend never connects to the monitored DB."""
    __tablename__ = "agent_db_targets"

    id = Column(Integer, primary_key=True, index=True)
    token = Column(String(128), index=True, nullable=False)
    token_hash = Column(String(64), index=True, nullable=True)
    db_type = Column(String(50), nullable=False, default="MySQL")
    connection_name = Column(String(255), nullable=True)
    host = Column(String(255), nullable=True, default="localhost")
    port = Column(Integer, nullable=True)
    username = Column(String(255), nullable=True)
    password = Column(EncryptedString, nullable=True)  # encrypted at rest
    database_name = Column(String(255), nullable=True)
    environment = Column(String(100), default="Production")
    enabled = Column(Boolean, default=True)
    connection_id = Column(Integer, nullable=True)   # linked connection_master.id (for the DB dashboard)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class AgentSession(Base):
    """Live DB connections/sessions the agent captured (current snapshot per agent)."""
    __tablename__ = "agent_sessions"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    captured_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    session_id = Column(String(64), nullable=True)
    username = Column(String(255), nullable=True)
    db_name = Column(String(255), nullable=True)
    client_host = Column(String(255), nullable=True)
    state = Column(String(100), nullable=True)
    command = Column(String(255), nullable=True)
    duration_ms = Column(Float, default=0.0)
    query = Column(Text, nullable=True)


class AgentMetric(Base):
    __tablename__ = "agent_metrics"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    # Explicit classification the INSERTING code sets, so the metrics_pipeline
    # hook doesn't have to guess it from agent_name alone — that guess is wrong
    # whenever one physical agent pushes both host telemetry and several DB
    # engines' metrics under the SAME shared agent_name (see metrics_pipeline.py's
    # after_insert hook for the full story). NULL falls back to the old lookup.
    kind = Column(String(32), nullable=True)
    tech = Column(String(64), nullable=True)
    conn_id = Column(Integer, nullable=True)
    host_cpu = Column(Float, default=0.0)
    host_memory = Column(Float, default=0.0)
    host_disk = Column(Float, default=0.0)
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


class AgentStableFact(Base):
    """Slowly-changing facts per agent (version, database list, config limits …).
    Stored ONCE and rewritten only when the freshly-collected facts differ from the
    stored checksum — the durable, always-on source the UI reads them from."""
    __tablename__ = "agent_stable_facts"

    id = Column(Integer, primary_key=True, index=True)
    agent_name = Column(String(255), unique=True, index=True, nullable=False)
    kind = Column(String(20), index=True, default="database")     # infra | database
    tech = Column(String(40), index=True, default="")             # mysql | oracle | …
    conn_id = Column(Integer, index=True, default=0)
    facts = Column(Text, nullable=False)                          # canonical JSON
    sha = Column(String(40), nullable=False)                      # checksum for compare
    updated_at = Column(DateTime(timezone=True), server_default=func.now(),
                        onupdate=func.now())


class AgentStableChange(Base):
    """Audit trail: one row per changed stable fact (version upgraded, DB added …).
    Written only on drift — never on the fast metrics cadence."""
    __tablename__ = "agent_stable_changes"

    id = Column(Integer, primary_key=True, index=True)
    ts = Column(DateTime(timezone=True), server_default=func.now(), index=True)
    agent_name = Column(String(255), index=True, nullable=False)
    kind = Column(String(20), default="database")
    tech = Column(String(40), default="")
    conn_id = Column(Integer, default=0)
    field = Column(String(120), nullable=False)
    old_value = Column(Text)
    new_value = Column(Text)
