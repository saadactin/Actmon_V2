from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, Text, DateTime, ForeignKey
from app.database.base import Base


class DbCheckRun(Base):
    """One executed Database Agent Monitoring check result — the time series
    behind "Last Run / Last Success / Last Failure / Duration" on the Database
    Agent page. Modeled on ExternalCheckResult's append-only shape
    (app/models/external_check_model.py). A row is written ONLY when the
    admin explicitly clicks "Run Check" — there is no scheduler writing to
    this table, matching the "never auto-execute a check" rule."""
    __tablename__ = "db_check_runs"

    id            = Column(Integer, primary_key=True, index=True)
    org_id        = Column(Integer, nullable=False, default=1, index=True)
    connection_id = Column(Integer, ForeignKey("connection_master.id", ondelete="CASCADE"), nullable=False, index=True)
    check_id      = Column(String(50), nullable=False, index=True)   # e.g. "connection", "server_health", "tables"

    checked_at    = Column(DateTime, default=datetime.utcnow, index=True)
    status        = Column(String(20), nullable=False)   # passed | warning | failed | skipped
    duration_ms   = Column(Float, nullable=True)
    output        = Column(Text, nullable=True)
    error         = Column(Text, nullable=True)
