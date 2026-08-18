"""
Help Center Appearance API — one org-wide, singleton visual configuration for
the documentation library (card theme, colors, sizing, typography, layout,
sidebar, images). Unlike most settings in this app there is no per-user or
per-org scoping: every viewer of the Help Center sees the same look.

  GET    /api/v1/settings/help-center-appearance   — any signed-in user (every
                                                      viewer needs to read this
                                                      to render the page)
  PUT    /api/v1/settings/help-center-appearance   — admin only (edit permission
                                                      on the virtual page below)
  DELETE /api/v1/settings/help-center-appearance   — admin only; reset to default

The stored `config` is deep-merged under the frontend's own DEFAULT_CONFIG
(frontend/src/pages/help/appearance/helpAppearanceConfig.js is the visually
authoritative source of what "default" looks like) — this backend deliberately
does not keep its own copy of the full default shape, so the two can never
drift out of sync. PUT deep-merges the request body onto whatever is already
stored (not onto a hardcoded default), so a partial update never clobbers
fields the admin didn't touch.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Any, Dict

from app.database.connection import SessionLocal
from app.models.help_center_appearance_model import HelpCenterAppearance
from app.routes.auth.auth_routes import current_claims
from app.services.auth.permission_guard import require_permission

router = APIRouter(prefix="/api/v1/settings/help-center-appearance", tags=["help-center-appearance"])

HELP_APPEARANCE_PAGE = "/help-center-appearance"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge `override` onto `base`, returning a new dict.
    Only merges when both sides are dicts at a given key; any other type
    (including lists) is replaced wholesale by `override`'s value."""
    result = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _get_or_create(db: Session) -> HelpCenterAppearance:
    row = db.query(HelpCenterAppearance).first()
    if not row:
        row = HelpCenterAppearance(config={})
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _to_dict(row: HelpCenterAppearance) -> dict:
    return {
        "config": row.config or {},
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "updated_by": row.updated_by,
    }


@router.get("")
def get_help_center_appearance(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    try:
        row = _get_or_create(db)
        return _to_dict(row)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to load Help Center appearance: {e}")


@router.put("")
def update_help_center_appearance(
    body: Dict[str, Any],
    claims: dict = Depends(require_permission(HELP_APPEARANCE_PAGE, "edit")),
    db: Session = Depends(get_db),
):
    try:
        row = _get_or_create(db)
        row.config = _deep_merge(row.config or {}, body or {})
        row.updated_by = claims.get("email") or str(claims.get("user_id") or "")
        db.commit()
        db.refresh(row)
        return _to_dict(row)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to save Help Center appearance: {e}")


@router.delete("")
def reset_help_center_appearance(
    claims: dict = Depends(require_permission(HELP_APPEARANCE_PAGE, "edit")),
    db: Session = Depends(get_db),
):
    try:
        db.query(HelpCenterAppearance).delete()
        db.commit()
        return {"config": {}, "updated_at": None, "updated_by": None}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to reset Help Center appearance: {e}")
