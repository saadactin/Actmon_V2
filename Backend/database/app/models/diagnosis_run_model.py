from datetime import datetime

from sqlalchemy import Column, Integer, String, DateTime, Text, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB

from app.database.base import Base


class DiagnosisRun(Base):
    """Append-only diagnosis-session log — one row per Diagnosis page session
    in which the administrator actually ran at least one check. Created only
    when the first check executes (never on merely opening the page, per the
    "no automatic execution" rule), then updated as RCA/AI/actions happen.
    Modeled on NotificationHistory's append-only shape and AlertFiredState's
    indexing (see app/models/notification_model.py)."""
    __tablename__ = "diagnosis_runs"

    id                 = Column(Integer, primary_key=True, autoincrement=True)
    org_id             = Column(Integer, default=1, nullable=False, index=True)
    connection_id      = Column(Integer, ForeignKey("connection_master.id", ondelete="CASCADE"), nullable=False, index=True)
    started_at         = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    finished_at        = Column(DateTime, nullable=True)
    status             = Column(String(30), nullable=True)     # header.current_status at run time
    severity           = Column(String(20), nullable=True)     # header.severity at run time
    checks_run         = Column(JSONB, nullable=False, default=list)   # [{id, title, status}, ...]
    root_cause         = Column(Text, nullable=True)
    confidence         = Column(Integer, nullable=True)
    ai_summary         = Column(JSONB, nullable=True)           # {diagnosis, root_cause, confidence, ...} or None
    actions_performed  = Column(JSONB, nullable=False, default=list)  # [{action, unit, result, at}, ...]
