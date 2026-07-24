from sqlalchemy import Column, Integer, String, DateTime
from app.database.base import Base
from datetime import datetime


class MonitoringSettings(Base):
    """Singleton row (Super Admin configurable) tuning how fast ActMon detects a
    monitored database going down / coming back up. See agent_collector_service.py
    and agent_reaper_service.py for how these are read (cached, short TTL)."""
    __tablename__ = "monitoring_settings"

    id                     = Column(Integer, primary_key=True, autoincrement=True)
    error_streak           = Column(Integer, nullable=False, default=3)
    collector_interval_sec = Column(Integer, nullable=False, default=15)
    offline_after_sec      = Column(Integer, nullable=False, default=180)
    updated_at             = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by             = Column(String(200), nullable=True)
