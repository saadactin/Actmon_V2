from sqlalchemy import Column, Integer, String, DateTime, Float, Text, BigInteger
from sqlalchemy.sql import func
from app.database.base import Base


class BackupJob(Base):
    __tablename__ = "backup_jobs"

    id            = Column(Integer, primary_key=True, index=True)
    uuid          = Column(String(36), unique=True, nullable=False)
    connection_id = Column(Integer, index=True, nullable=False)
    db_host       = Column(String(255))
    db_port       = Column(Integer)
    db_name       = Column(String(255))          # 'ALL' or specific database
    backup_type   = Column(String(30))           # logical | physical | binlog | incremental
    compress      = Column(String(5), default="gz")  # gz | none
    status        = Column(String(20), default="pending")  # pending|running|completed|failed|cancelled
    size_bytes    = Column(BigInteger, default=0)
    file_path     = Column(String(1000))
    binlog_file   = Column(String(255))          # binlog file at backup time
    binlog_pos    = Column(BigInteger)            # binlog position at backup time
    backup_start  = Column(DateTime)
    backup_end    = Column(DateTime)
    error_msg     = Column(Text)
    notes         = Column(Text)
    created_at    = Column(DateTime, server_default=func.now())
