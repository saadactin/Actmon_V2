from sqlalchemy import Column, Integer, String, Boolean, DateTime, Float, Text
from app.database.base import Base
from datetime import datetime


class AlertRule(Base):
    """A dynamic, user-configurable alert threshold rule (Percona-PMM style).

    Rules are fully data-driven: metric + operator + threshold, scoped to all
    servers, a technology, a single server, or a single agent. The monitoring
    engine reads enabled rules to decide when to raise a notification.
    """
    __tablename__ = "alert_rules"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    org_id          = Column(Integer, default=1, index=True)   # multi-tenant (default org 1)

    name            = Column(String(200), nullable=False)
    description     = Column(Text, nullable=True)

    metric          = Column(String(50),  nullable=False)      # cpu / memory / disk / connections / replication_lag / status
    operator        = Column(String(10),  default="gt")         # gt / gte / lt / lte / eq
    threshold       = Column(Float,        default=0)           # numeric threshold (for status: 0 = offline)

    scope_type      = Column(String(20),  default="all")        # all / technology / server / agent
    scope_value     = Column(String(200), nullable=True)        # e.g. "mysql" / server name / agent name

    severity        = Column(String(20),  default="warning")    # warning / critical
    duration_seconds = Column(Integer,    default=60)           # sustained-for before firing
    cooldown_seconds = Column(Integer,    default=600)          # re-notify cooldown

    enabled         = Column(Boolean, default=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
