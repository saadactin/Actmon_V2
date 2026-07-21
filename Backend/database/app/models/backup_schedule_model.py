from sqlalchemy import Column, Integer, String, Boolean, DateTime
from app.database.base import Base
from datetime import datetime


class BackupSchedule(Base):
    __tablename__ = "backup_schedules"

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    conn_id             = Column(Integer, nullable=False, index=True)
    name                = Column(String(200), nullable=False)

    # What to back up
    backup_type         = Column(String(20),  default="logical")   # logical|physical|binlog
    databases           = Column(String(500), nullable=True)        # JSON list or NULL (all)
    compress            = Column(Boolean,     default=True)
    custom_storage_path = Column(String(500), nullable=True)
    retain_days         = Column(Integer,     default=7)            # auto-prune after N days
    notes               = Column(String(500), nullable=True)

    # When to run
    # schedule_type: every_x_minutes | hourly | daily | weekly | monthly
    schedule_type       = Column(String(20), default="daily")
    interval_minutes    = Column(Integer,    default=30)    # for every_x_minutes
    minute              = Column(Integer,    default=0)     # 0-59
    hour                = Column(Integer,    default=2)     # 0-23  (daily/weekly/monthly)
    day_of_week         = Column(String(20), default="0")   # "0"-"6" (Mon=0) or "0,1,4"
    day_of_month        = Column(Integer,    default=1)     # 1-31  (monthly)

    enabled             = Column(Boolean,  default=True)
    created_at          = Column(DateTime, default=datetime.utcnow)
    updated_at          = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Runtime stats (updated by scheduler)
    last_run_at         = Column(DateTime, nullable=True)
    next_run_at         = Column(DateTime, nullable=True)
    last_job_id         = Column(Integer,  nullable=True)
    last_status         = Column(String(20), nullable=True)   # completed|failed|running
