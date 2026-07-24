"""
Dashboard Appearance API — per-user, per-technology-scope gauge/chart visual
template + display mode (gauge vs. graph) preference.
  GET    /api/v1/settings/dashboard-appearance          — full map of scope -> settings for this user (creates 'all' default if missing)
  PUT    /api/v1/settings/dashboard-appearance?scope=X   — upsert settings for one scope ('all' or a technology name); returns the full map
  DELETE /api/v1/settings/dashboard-appearance?scope=X   — remove a technology's override (X must not be 'all'); returns the full map

Read by the frontend's DashboardAppearanceContext and applied via the shared
<Gauge>/<TrendChart> components, scoped per-dashboard via DashboardScopeProvider.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Literal

from app.database.connection import SessionLocal
from app.models.dashboard_appearance_model import DashboardAppearanceSettings
from app.routes.auth.auth_routes import current_claims

router = APIRouter(prefix="/api/v1/settings/dashboard-appearance", tags=["dashboard-appearance"])

SCOPES = ("all", "mysql", "mssql", "oracle", "postgresql", "mongodb", "clickhouse", "infra")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class DashboardAppearanceUpdate(BaseModel):
    indicator_style: Literal["ring", "stat", "donut", "minimal"]
    chart_style: Literal["area", "line", "bar", "spark"]
    display_mode: Literal["gauge", "graph"] = "gauge"


def _to_dict(row: DashboardAppearanceSettings) -> dict:
    return {
        "indicator_style": row.indicator_style,
        "chart_style": row.chart_style,
        "display_mode": row.display_mode,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _get_or_create_all(db: Session, user_id: int) -> DashboardAppearanceSettings:
    row = db.query(DashboardAppearanceSettings).filter(
        DashboardAppearanceSettings.user_id == user_id,
        DashboardAppearanceSettings.scope == "all",
    ).first()
    if not row:
        row = DashboardAppearanceSettings(user_id=user_id, scope="all",
                                           indicator_style="ring", chart_style="area", display_mode="gauge")
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _full_map(db: Session, user_id: int) -> dict:
    _get_or_create_all(db, user_id)
    rows = db.query(DashboardAppearanceSettings).filter(DashboardAppearanceSettings.user_id == user_id).all()
    return {r.scope: _to_dict(r) for r in rows}


@router.get("")
def get_dashboard_appearance(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    return _full_map(db, claims.get("user_id"))


@router.put("")
def update_dashboard_appearance(body: DashboardAppearanceUpdate, scope: str = Query("all"),
                                 claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    if scope not in SCOPES:
        raise HTTPException(status_code=400, detail=f"Unknown scope '{scope}'")
    user_id = claims.get("user_id")
    row = db.query(DashboardAppearanceSettings).filter(
        DashboardAppearanceSettings.user_id == user_id,
        DashboardAppearanceSettings.scope == scope,
    ).first()
    if not row:
        row = DashboardAppearanceSettings(user_id=user_id, scope=scope)
        db.add(row)
    row.indicator_style = body.indicator_style
    row.chart_style = body.chart_style
    row.display_mode = body.display_mode
    db.commit()
    db.refresh(row)
    return _full_map(db, user_id)


@router.delete("")
def delete_dashboard_appearance_override(scope: str = Query(...),
                                          claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    if scope == "all":
        raise HTTPException(status_code=400, detail="Cannot remove the 'all' default")
    if scope not in SCOPES:
        raise HTTPException(status_code=400, detail=f"Unknown scope '{scope}'")
    user_id = claims.get("user_id")
    db.query(DashboardAppearanceSettings).filter(
        DashboardAppearanceSettings.user_id == user_id,
        DashboardAppearanceSettings.scope == scope,
    ).delete()
    db.commit()
    return _full_map(db, user_id)
