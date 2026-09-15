from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Text, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB
from app.database.base import Base
from datetime import datetime


class PostgresWalPurgeConfig(Base):
    """One row per PostgreSQL connection — the Purge WAL Archive configuration
    (archive path, retention, schedule) plus the live status ActMon needs to
    render without a second round trip (last run outcome, whether the host
    scheduler entry is actually present). `trigger_token_hash` is the ONLY
    secret this table ever holds, and it's a one-way HMAC (via
    credential_encryption.hash_token) — the plaintext token is minted at
    Schedule Purge time, written once to a file on the DB host, and never
    stored here. See postgres_wal_purge_service.py for why: the OS-level cron
    entry / Scheduled Task calls back into ActMon with this token instead of
    running pg_archivecleanup directly, so the safety boundary is recomputed
    fresh on every fire and no DB credential ever touches the host scheduler."""

    __tablename__ = "postgres_wal_purge_config"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)
    conn_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, unique=True, index=True)
    os_server_id = Column(Integer, ForeignKey("os_servers.id"), nullable=True)

    archive_dir = Column(String(500), nullable=False)
    cleanup_binary = Column(String(500), nullable=True, default="pg_archivecleanup")
    cleanup_method = Column(String(30), nullable=False, default="pg_archivecleanup")

    retention_preset = Column(String(20), nullable=False, default="7d")   # 1d|3d|7d|14d|30d|custom
    retention_days = Column(Integer, nullable=False, default=7)
    require_standby_ok = Column(Boolean, nullable=False, default=True)
    max_standby_lag_mb = Column(Integer, nullable=False, default=1024)

    frequency = Column(String(20), nullable=False, default="daily")      # daily|weekly|monthly
    hour = Column(Integer, nullable=False, default=2)
    minute = Column(Integer, nullable=False, default=30)
    day_of_week = Column(Integer, nullable=False, default=0)             # 0=Sun..6=Sat
    day_of_month = Column(Integer, nullable=False, default=1)            # clamped 1-28

    enabled = Column(Boolean, nullable=False, default=False)
    scheduler_type = Column(String(20), nullable=True)                   # cron|schtasks
    scheduler_entry_name = Column(String(120), nullable=True)
    callback_base_url = Column(String(300), nullable=True)
    missed_grace_minutes = Column(Integer, nullable=False, default=15)

    trigger_token_hash = Column(String(64), nullable=True, unique=True)
    trigger_token_created_at = Column(DateTime, nullable=True)

    schedule_present = Column(Boolean, nullable=True)
    schedule_verified_at = Column(DateTime, nullable=True)

    next_run_at = Column(DateTime, nullable=True, index=True)
    last_run_at = Column(DateTime, nullable=True)
    last_status = Column(String(20), nullable=True)     # success|failed|blocked|missed
    last_error = Column(Text, nullable=True)
    last_files_purged = Column(Integer, nullable=True)
    last_space_reclaimed_bytes = Column(BigInteger, nullable=True)
    last_safety_state = Column(String(20), nullable=True)

    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_by = Column(Integer, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PostgresWalPurgeHistory(Base):
    """One row per purge run — scheduled (via the trigger callback), manual
    (Purge Now from the UI), or a dry-run Test. `status='running'` rows are
    guarded by the partial unique index below so two runs can never overlap
    for the same connection (same trick as oracle_maintenance_jobs'
    uq_oracle_maint_job_active); the watchdog reaps any row stuck 'running'
    for over 2 hours (a dead giveaway the backend restarted mid-run, since
    agent_fs_service jobs are in-memory/single-process and can't survive
    that)."""

    __tablename__ = "postgres_wal_purge_history"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)
    conn_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)
    config_id = Column(Integer, ForeignKey("postgres_wal_purge_config.id"), nullable=True)

    run_type = Column(String(20), nullable=False)          # scheduled|manual|test
    trigger_source = Column(String(30), nullable=True)      # cron|schtasks|ui|watchdog
    status = Column(String(20), nullable=False, default="running", index=True)
    # running|success|failed|blocked|missed|skipped

    safety_state = Column(String(20), nullable=True)        # SAFE|WARNING|CRITICAL
    safe_boundary_wal = Column(String(24), nullable=True)
    retention_cutoff_wal = Column(String(24), nullable=True)
    replication_cutoff_wal = Column(String(24), nullable=True)
    binding_cutoff = Column(String(20), nullable=True)       # retention|replication
    retention_days = Column(Integer, nullable=True)
    archive_dir = Column(String(500), nullable=True)

    files_before = Column(Integer, nullable=True)
    files_after = Column(Integer, nullable=True)
    files_purged = Column(Integer, nullable=True)
    files_matched = Column(Integer, nullable=True)          # dry-run would-delete count

    bytes_before = Column(BigInteger, nullable=True)
    bytes_after = Column(BigInteger, nullable=True)
    space_reclaimed_bytes = Column(BigInteger, nullable=True)
    estimated_bytes = Column(BigInteger, nullable=True)

    exit_code = Column(Integer, nullable=True)
    command_text = Column(Text, nullable=True)

    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error_message = Column(Text, nullable=True)
    details = Column(JSONB, nullable=True)

    user_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index(
            "uq_pg_wal_purge_running",
            "conn_id",
            unique=True,
            postgresql_where=status == "running",
        ),
    )
