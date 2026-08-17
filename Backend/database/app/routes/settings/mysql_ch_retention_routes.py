"""
MySQL ClickHouse Retention API — Super Admin tunable historical-data retention.
  GET /api/v1/settings/mysql-ch-retention  — current settings (creates the default row if missing)
  PUT /api/v1/settings/mysql-ch-retention  — update settings

Read by metrics_history_service.py (via mysql_ch_retention_service.py's cached reader)
when creating/altering the actmon_mysql_* historical tables' TTL clause.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.mysql_ch_retention_settings_model import MysqlChRetentionSettings
from app.services.mysql import mysql_ch_retention_service as svc

router = APIRouter(prefix="/api/v1/settings/mysql-ch-retention", tags=["mysql-ch-retention-settings"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class MysqlChRetentionUpdate(BaseModel):
    metrics_days: int = Field(ge=1, le=730, description="Days to retain MySQL metrics history in ClickHouse")
    events_days: int = Field(ge=1, le=730, description="Days to retain MySQL slow-query/error/binlog/replication events in ClickHouse")


def _to_dict(row: MysqlChRetentionSettings) -> dict:
    return {
        "metrics_days": row.metrics_days,
        "events_days": row.events_days,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


def _get_or_create(db: Session) -> MysqlChRetentionSettings:
    row = db.query(MysqlChRetentionSettings).first()
    if not row:
        row = MysqlChRetentionSettings(**svc.DEFAULTS)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("")
def get_retention_settings(db: Session = Depends(get_db)):
    return _to_dict(_get_or_create(db))


@router.put("")
def update_retention_settings(body: MysqlChRetentionUpdate, db: Session = Depends(get_db)):
    row = _get_or_create(db)
    row.metrics_days = body.metrics_days
    row.events_days = body.events_days
    db.commit()
    db.refresh(row)
    svc.invalidate_cache()
    return _to_dict(row)
