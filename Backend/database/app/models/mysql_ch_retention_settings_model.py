from sqlalchemy import Column, Integer, String, DateTime
from app.database.base import Base
from datetime import datetime


class MysqlChRetentionSettings(Base):
    """Singleton row (Super Admin configurable) controlling how long MySQL
    historical data lives in ClickHouse before TTL-expiring. Mirrors
    monitoring_settings_model.py's shape/pattern. Read by
    metrics_history_service.py when creating/altering the actmon_mysql_* tables."""
    __tablename__ = "mysql_ch_retention_settings"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    metrics_days = Column(Integer, nullable=False, default=90)
    events_days  = Column(Integer, nullable=False, default=90)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by   = Column(String(200), nullable=True)
