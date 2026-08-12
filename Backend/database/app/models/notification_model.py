from sqlalchemy import Column, Integer, String, Boolean, DateTime, Float, Text, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from app.database.base import Base
from datetime import datetime


class NotificationChannel(Base):
    """One row per (org, channel_type) — the 9 provider slots (email, teams,
    slack, telegram, whatsapp, webhook, pagerduty, jira, servicenow).

    `config` holds non-secret settings (channel name, method, project, etc.);
    `secrets_enc` holds a Fernet-encrypted JSON blob of every secret field
    (webhook URL, tokens, API keys) — see app/services/common/crypto_service.py.
    Email's row never carries SMTP credentials of its own; those stay in
    smtp_configs and are looked up at send time.
    """
    __tablename__ = "notification_channels"
    __table_args__ = (UniqueConstraint("org_id", "channel_type", name="uq_notification_channel_org_type"),)

    id              = Column(Integer, primary_key=True, autoincrement=True)
    org_id          = Column(Integer, default=1, nullable=False, index=True)
    channel_type    = Column(String(30), nullable=False)
    enabled         = Column(Boolean, default=False, nullable=False)
    config          = Column(JSONB, nullable=False, default=dict)
    secrets_enc     = Column(Text, nullable=True)
    last_test_at    = Column(DateTime, nullable=True)
    last_test_ok    = Column(Boolean, nullable=True)
    last_test_msg   = Column(String(500), nullable=True)
    last_success_at = Column(DateTime, nullable=True)
    last_failure_at = Column(DateTime, nullable=True)
    last_error      = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SeverityChannelRouting(Base):
    """Org-wide default channels per severity (Information/Warning/Critical) —
    used when a firing rule doesn't specify its own channel selection."""
    __tablename__ = "severity_channel_routing"
    __table_args__ = (UniqueConstraint("org_id", "severity", "channel_type", name="uq_severity_channel"),)

    id           = Column(Integer, primary_key=True, autoincrement=True)
    org_id       = Column(Integer, default=1, nullable=False, index=True)
    severity     = Column(String(20), nullable=False)
    channel_type = Column(String(30), nullable=False)
    enabled      = Column(Boolean, default=True, nullable=False)


class AlertFiredState(Base):
    """Persistent firing state per (rule, scope) — the missing piece that
    makes alert_rules.duration_seconds (sustain) and cooldown_seconds
    (re-notify throttle) actually mean something, instead of sitting unused
    while every alert is recomputed fresh on every API poll."""
    __tablename__ = "alert_fired_state"
    __table_args__ = (UniqueConstraint("alert_rule_id", "scope_key", name="uq_alert_fired_scope"),)

    id                = Column(Integer, primary_key=True, autoincrement=True)
    alert_rule_id     = Column(Integer, ForeignKey("alert_rules.id", ondelete="CASCADE"), nullable=False, index=True)
    scope_key         = Column(String(300), nullable=False)
    first_breach_at   = Column(DateTime, nullable=False)
    last_breach_at    = Column(DateTime, nullable=False)
    last_notified_at  = Column(DateTime, nullable=True)
    is_firing         = Column(Boolean, default=False, nullable=False)


class NotificationQueue(Base):
    """The dispatcher's working set — one row per (firing alert x channel),
    polled by notification_queue_service.py and retried per policy until it
    succeeds or exhausts max_attempts."""
    __tablename__ = "notification_queue"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    org_id          = Column(Integer, default=1, nullable=False, index=True)
    alert_rule_id   = Column(Integer, ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True)
    channel_type    = Column(String(30), nullable=False)
    payload         = Column(JSONB, nullable=False)
    status          = Column(String(20), default="pending", nullable=False, index=True)  # pending/sent/failed
    attempt_count   = Column(Integer, default=0, nullable=False)
    max_attempts    = Column(Integer, default=3, nullable=False)
    next_attempt_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    timeout_seconds = Column(Integer, default=15, nullable=False)
    last_error      = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)
    sent_at         = Column(DateTime, nullable=True)


class NotificationHistory(Base):
    """Append-only delivery audit log — written once a queue item reaches a
    terminal state (sent, or failed after exhausting retries). This is what
    the Notification History page reads."""
    __tablename__ = "notification_history"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    org_id            = Column(Integer, default=1, nullable=False, index=True)
    sent_at           = Column(DateTime, default=datetime.utcnow, index=True)
    alert_rule_id     = Column(Integer, ForeignKey("alert_rules.id", ondelete="SET NULL"), nullable=True)
    alert_name        = Column(String(200), nullable=True)
    server_name       = Column(String(255), nullable=True)
    database_name     = Column(String(255), nullable=True)
    severity          = Column(String(20), nullable=True)
    channel_type      = Column(String(30), nullable=False)
    recipient         = Column(String(500), nullable=True)
    status            = Column(String(20), nullable=False)  # sent/failed
    response_code     = Column(String(20), nullable=True)
    response_time_ms  = Column(Float, nullable=True)
    retry_count       = Column(Integer, default=0, nullable=False)
    error_message     = Column(Text, nullable=True)


class NotificationTemplate(Base):
    """Optional per-org override of the built-in subject/body template for a
    channel type; when absent, template_service.py's default is used."""
    __tablename__ = "notification_templates"
    __table_args__ = (UniqueConstraint("org_id", "channel_type", name="uq_notification_template_org_type"),)

    id               = Column(Integer, primary_key=True, autoincrement=True)
    org_id           = Column(Integer, default=1, nullable=False, index=True)
    channel_type     = Column(String(30), nullable=False)
    subject_template = Column(Text, nullable=True)
    body_template    = Column(Text, nullable=True)


class NotificationSettings(Base):
    """Org-wide notification preferences that don't belong to any single
    channel — one row per org. Currently just which timezone the {{Timestamp}}
    variable renders in (IANA zone name, e.g. 'Asia/Kolkata'); everything is
    stored and evaluated in UTC internally and converted only at send time."""
    __tablename__ = "notification_settings"

    org_id     = Column(Integer, primary_key=True, default=1)
    timezone   = Column(String(64), nullable=False, default="Asia/Kolkata")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
