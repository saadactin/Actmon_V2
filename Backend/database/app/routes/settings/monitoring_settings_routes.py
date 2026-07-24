"""
Monitoring Settings API — Super Admin tunable detection-speed thresholds.
  GET /api/v1/settings/monitoring  — current settings (creates the default row if missing)
  PUT /api/v1/settings/monitoring  — update settings

Read by agent_collector_service.py (error_streak, collector_interval_sec) and
agent_reaper_service.py (offline_after_sec) — see monitoring_settings_service.py
for the cached reader both use.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.monitoring_settings_model import MonitoringSettings
from app.services.agent import monitoring_settings_service as svc

router = APIRouter(prefix="/api/v1/settings/monitoring", tags=["monitoring-settings"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class MonitoringSettingsUpdate(BaseModel):
    error_streak: int = Field(ge=1, le=10, description="Consecutive failed checks before a DB shows DB Error")
    collector_interval_sec: int = Field(ge=5, le=300, description="How often each DB is checked, in seconds")
    offline_after_sec: int = Field(ge=30, le=3600, description="Seconds of silence before a host/agent shows Offline")


def _to_dict(row: MonitoringSettings) -> dict:
    return {
        "error_streak": row.error_streak,
        "collector_interval_sec": row.collector_interval_sec,
        "offline_after_sec": row.offline_after_sec,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


def _get_or_create(db: Session) -> MonitoringSettings:
    row = db.query(MonitoringSettings).first()
    if not row:
        row = MonitoringSettings(**svc.DEFAULTS)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("")
def get_monitoring_settings(db: Session = Depends(get_db)):
    return _to_dict(_get_or_create(db))


@router.put("")
def update_monitoring_settings(body: MonitoringSettingsUpdate, db: Session = Depends(get_db)):
    row = _get_or_create(db)
    row.error_streak = body.error_streak
    row.collector_interval_sec = body.collector_interval_sec
    # Guard rail beyond the field's own bounds: the reaper's silence-based Offline
    # rule needs at least a couple of collector cycles of headroom, or the two
    # mechanisms fight each other and status flaps.
    row.offline_after_sec = max(body.offline_after_sec, body.collector_interval_sec * 2, 30)
    db.commit()
    db.refresh(row)
    svc.invalidate_cache()
    return _to_dict(row)
