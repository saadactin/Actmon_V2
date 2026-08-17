from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text
from app.database.base import Base
from app.models._encrypted_type import EncryptedString
from datetime import datetime


class MssqlReportSchedule(Base):
    __tablename__ = "mssql_report_schedules"

    id               = Column(Integer, primary_key=True, autoincrement=True)
    conn_id          = Column(Integer, nullable=False, index=True)
    schedule_name    = Column(String(200), nullable=False)

    frequency        = Column(String(20), default="daily")
    hour             = Column(Integer,    default=7)
    minute           = Column(Integer,    default=0)
    day_of_week      = Column(String(20), default="0")
    day_of_month     = Column(Integer,    default=1)

    recipient_emails = Column(Text, nullable=False)

    smtp_host        = Column(String(200), nullable=False)
    smtp_port        = Column(Integer,     default=587)
    smtp_user        = Column(String(200), nullable=True)
    smtp_password    = Column(EncryptedString, nullable=True)  # encrypted at rest
    smtp_tls         = Column(Boolean,     default=True)
    sender_email     = Column(String(200), nullable=False)
    sender_name      = Column(String(200), default="Actmon SQL Server Monitor")

    report_period    = Column(String(20),  default="24h")
    include_sections = Column(Text,        nullable=True)

    enabled          = Column(Boolean,  default=True)
    created_at       = Column(DateTime, default=datetime.utcnow)
    updated_at       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_sent_at     = Column(DateTime, nullable=True)
    next_run_at      = Column(DateTime, nullable=True)
    last_status      = Column(String(20), nullable=True)
