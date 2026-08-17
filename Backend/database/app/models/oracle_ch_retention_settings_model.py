from sqlalchemy import Column, Integer, String, DateTime
from app.database.base import Base
from datetime import datetime


class OracleChRetentionSettings(Base):
    """Singleton row (Super Admin configurable) controlling how long Oracle
    topology/RAC/Data-Guard/ASM historical data lives in ClickHouse before
    TTL-expiring. Mirrors mysql_ch_retention_settings_model.py's shape exactly.
    Read by metrics_history_service.py when creating/altering the
    actmon_oracle_* tables."""
    __tablename__ = "oracle_ch_retention_settings"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    events_days  = Column(Integer, nullable=False, default=90)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    updated_by   = Column(String(200), nullable=True)
