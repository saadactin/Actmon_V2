from sqlalchemy import Column, Integer, String, DateTime
from app.database.base import Base
from datetime import datetime


class PostgresPatroniChRetentionSettings(Base):
    """Singleton row controlling how long Patroni cluster-history data lives in
    ClickHouse before TTL-expiring. Mirrors oracle_ch_retention_settings_model.py's
    shape exactly. Read by metrics_history_service.py when creating/altering the
    actmon_postgres_patroni_* tables."""
    __tablename__ = "postgres_patroni_ch_retention_settings"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    events_days  = Column(Integer, nullable=False, default=90)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by   = Column(String(200), nullable=True)
