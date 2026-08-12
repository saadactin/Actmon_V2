from sqlalchemy import Column, Integer, String, Boolean, DateTime, Float, Text
from sqlalchemy.dialects.postgresql import JSONB
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
    # Which notification channels this rule notifies on firing — e.g.
    # ["email", "teams", "slack"]. Empty means "use the org's severity-based
    # default routing" (see notification_channels/severity_channel_routing).
    notification_channel_types = Column(JSONB, nullable=False, default=list)
    # Who receives THIS rule's email — there is no org-wide default recipient
    # any more (that was a hardcoded fallback to the SMTP sender's own
    # address). A rule with the "email" channel selected must set at least
    # one address in notification_recipients or its emails fail loudly with
    # a clear "no recipient configured" error instead of guessing.
    notification_recipients = Column(JSONB, nullable=False, default=list)
    notification_cc = Column(JSONB, nullable=False, default=list)
    notification_bcc = Column(JSONB, nullable=False, default=list)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
