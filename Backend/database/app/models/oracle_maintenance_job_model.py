from sqlalchemy import (
    Column, Integer, String, Text, Numeric, DateTime, ForeignKey, Index
)
from sqlalchemy.dialects.postgresql import JSONB
from app.database.base import Base
from datetime import datetime


class OracleMaintenanceJob(Base):
    """One row = the full lifecycle of one Oracle Storage Health maintenance
    action: requested -> approved/rejected -> executed -> result. This is the
    audit record the spec asks for (Object/Problem/Evidence/Recommended
    Action/Expected Benefit/Risk/Approve-Reject, plus before/after metrics and
    execution result) — deliberately one table, not a separate findings store,
    since a finding only becomes durable once someone acts on it (Phase 1/2
    stay fully live/stateless).

    The partial unique index below is the "prevent duplicate/concurrent
    maintenance jobs" safety requirement: only one non-terminal
    (pending_approval/approved/running) row can exist per (conn_id,
    object_type, object_name) at a time."""
    __tablename__ = "oracle_maintenance_jobs"

    id = Column(Integer, primary_key=True, index=True)
    org_id = Column(Integer, nullable=False, default=1, index=True)  # copied from ConnectionMaster.org_id
    conn_id = Column(Integer, ForeignKey("connection_master.id"), nullable=False, index=True)

    object_type = Column(String(50), nullable=False)       # 'segment' | 'index'
    object_name = Column(String(500), nullable=False)      # e.g. 'APP.BIG_TABLE' or 'APP.IDX1'
    tablespace_name = Column(String(200), nullable=True)

    detected_issue = Column(Text, nullable=False)
    evidence = Column(Text, nullable=False)
    recommended_action = Column(String(50), nullable=False)  # shrink_space | move | index_maintenance_rebuild
    expected_benefit = Column(Text, nullable=True)
    risk = Column(Text, nullable=True)
    proposed_sql = Column(Text, nullable=False)

    status = Column(String(30), nullable=False, default="pending_approval", index=True)
    # pending_approval | approved | rejected | running | succeeded | failed

    requested_by = Column(Integer, nullable=True)
    requested_at = Column(DateTime, default=datetime.utcnow)
    approved_by = Column(Integer, nullable=True)
    approved_at = Column(DateTime, nullable=True)
    rejected_by = Column(Integer, nullable=True)
    rejected_at = Column(DateTime, nullable=True)
    rejection_reason = Column(Text, nullable=True)

    # Set only when a human explicitly clicks "Start Execution" on an already-
    # approved job — approval alone no longer auto-queues it for the runner.
    start_requested_at = Column(DateTime, nullable=True)
    # Alternative to start_requested_at: a future time the runner should start
    # this job on its own. Mutually exclusive in practice (the UI only lets
    # you pick one), but nothing enforces that at the DB level — the runner
    # just treats "either is due" as "go".
    scheduled_at = Column(DateTime, nullable=True)
    # Emails to notify on start/success/failure — a plain JSON array of
    # address strings, same shape as AlertRule.notification_recipients.
    # Empty/null means nobody is notified (still runs, just quietly).
    notification_recipients = Column(JSONB, nullable=True)

    executed_sql = Column(Text, nullable=True)
    execution_started_at = Column(DateTime, nullable=True)
    execution_ended_at = Column(DateTime, nullable=True)

    before_metrics = Column(JSONB, nullable=True)
    after_metrics = Column(JSONB, nullable=True)
    reclaimed_mb = Column(Numeric, nullable=True)
    error_details = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index(
            "uq_oracle_maint_job_active",
            "conn_id", "object_type", "object_name",
            unique=True,
            postgresql_where=status.in_(["pending_approval", "approved", "running"]),
        ),
    )
