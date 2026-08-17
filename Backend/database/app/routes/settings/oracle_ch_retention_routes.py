"""
Oracle ClickHouse Retention API — Super Admin tunable historical-data retention.
  GET /api/v1/settings/oracle-ch-retention  — current settings (creates the default row if missing)
  PUT /api/v1/settings/oracle-ch-retention  — update settings

Read by metrics_history_service.py (via oracle_ch_retention_service.py's cached reader)
when creating/altering the actmon_oracle_* historical tables' TTL clause.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.oracle_ch_retention_settings_model import OracleChRetentionSettings
from app.services.oracle import oracle_ch_retention_service as svc

router = APIRouter(prefix="/api/v1/settings/oracle-ch-retention", tags=["oracle-ch-retention-settings"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class OracleChRetentionUpdate(BaseModel):
    events_days: int = Field(ge=1, le=730, description="Days to retain Oracle RAC/Data-Guard/ASM/topology events in ClickHouse")


def _to_dict(row: OracleChRetentionSettings) -> dict:
    return {
        "events_days": row.events_days,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


def _get_or_create(db: Session) -> OracleChRetentionSettings:
    row = db.query(OracleChRetentionSettings).first()
    if not row:
        row = OracleChRetentionSettings(**svc.DEFAULTS)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("")
def get_retention_settings(db: Session = Depends(get_db)):
    return _to_dict(_get_or_create(db))


@router.put("")
def update_retention_settings(body: OracleChRetentionUpdate, db: Session = Depends(get_db)):
    row = _get_or_create(db)
    row.events_days = body.events_days
    db.commit()
    db.refresh(row)
    svc.invalidate_cache()
    return _to_dict(row)
