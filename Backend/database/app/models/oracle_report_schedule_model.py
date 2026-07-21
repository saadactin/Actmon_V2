from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text
from app.database.base import Base
from datetime import datetime


class OracleReportSchedule(Base):
    __tablename__ = "oracle_report_schedules"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    conn_id          = Column(Integer, nullable=False, index=True)
    schedule_name    = Column(String(200), nullable=False)

    # Frequency
    frequency        = Column(String(20), default="daily")   # daily|weekly|monthly
    hour             = Column(Integer,    default=7)          # 0-23
    minute           = Column(Integer,    default=0)          # 0-59
    day_of_week      = Column(String(20), default="0")        # Mon=0..Sun=6
    day_of_month     = Column(Integer,    default=1)          # 1-31

    # Recipients
    recipient_emails = Column(Text, nullable=False)           # JSON array string

    # SMTP
    smtp_host        = Column(String(200), nullable=False)
    smtp_port        = Column(Integer,     default=587)
    smtp_user        = Column(String(200), nullable=True)
    smtp_password    = Column(String(500), nullable=True)
    smtp_tls         = Column(Boolean,     default=True)
    sender_email     = Column(String(200), nullable=False)
    sender_name      = Column(String(200), default="Actmon Oracle Monitor")

    # Report scope
    report_period    = Column(String(20),  default="24h")     # 24h|7d|30d
    include_sections = Column(Text,        nullable=True)      # JSON list of sections

    enabled          = Column(Boolean,  default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)
    updated_at       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_sent_at     = Column(DateTime, nullable=True)
    next_run_at      = Column(DateTime, nullable=True)
    last_status      = Column(String(20), nullable=True)
