from sqlalchemy import Column, Integer, String, Boolean, DateTime
from app.database.base import Base
from datetime import datetime


class SmtpConfig(Base):
    __tablename__ = "smtp_configs"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    name         = Column(String(200), nullable=False, default="Default SMTP")
    smtp_host    = Column(String(300), nullable=False)
    smtp_port    = Column(Integer,     default=587)
    smtp_user    = Column(String(300), nullable=True)
    smtp_password= Column(String(500), nullable=True)
    smtp_tls     = Column(Boolean,     default=True)
    sender_email = Column(String(300), nullable=False)
    sender_name  = Column(String(200), default="Actmon Monitor")
    is_default   = Column(Boolean,     default=True)
    created_at   = Column(DateTime,    default=datetime.utcnow)
    updated_at   = Column(DateTime,    default=datetime.utcnow, onupdate=datetime.utcnow)
    last_test_at = Column(DateTime,    nullable=True)
    last_test_ok = Column(Boolean,     nullable=True)
    last_test_msg= Column(String(500), nullable=True)
