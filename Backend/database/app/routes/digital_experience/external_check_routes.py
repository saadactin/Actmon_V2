"""
Digital Experience — Website Availability / Ping / DNS / TCP Port / UDP Port
monitor CRUD + results.
  POST   /api/v1/digital-experience/checks              — create a check
  GET    /api/v1/digital-experience/checks               — list checks for this org
  GET    /api/v1/digital-experience/checks/{id}           — one check + its latest result
  GET    /api/v1/digital-experience/checks/{id}/results   — result history (for the uptime chart)
  PATCH  /api/v1/digital-experience/checks/{id}           — update (name/target/interval/enabled/config)
  DELETE /api/v1/digital-experience/checks/{id}           — remove
  POST   /api/v1/digital-experience/checks/{id}/test      — run it once, right now

Read by AddWebsiteWizard.jsx (create) and the Digital Experience dashboard
pages (list/detail/results). Execution itself lives in
app/services/digital_experience/external_check_service.py.
"""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.external_check_model import ExternalCheck, ExternalCheckResult
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id
from app.services.digital_experience.external_check_service import run_check_now, CHECK_TYPES

router = APIRouter(prefix="/api/v1/digital-experience/checks", tags=["digital-experience"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ExternalCheckCreate(BaseModel):
    name: str
    check_type: str
    target: str
    port: Optional[int] = None
    interval_seconds: int = 300
    enabled: bool = True
    config: Optional[dict] = None


class ExternalCheckUpdate(BaseModel):
    name: Optional[str] = None
    target: Optional[str] = None
    port: Optional[int] = None
    interval_seconds: Optional[int] = None
    enabled: Optional[bool] = None
    config: Optional[dict] = None


def _to_dict(c: ExternalCheck) -> dict:
    return {
        "id": c.id, "name": c.name, "check_type": c.check_type, "target": c.target, "port": c.port,
        "interval_seconds": c.interval_seconds, "enabled": c.enabled, "config": c.config or {},
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "last_checked_at": c.last_checked_at.isoformat() if c.last_checked_at else None,
        "last_status": c.last_status, "last_response_time_ms": c.last_response_time_ms,
    }


def _get_owned(db: Session, check_id: int, ctx: dict) -> ExternalCheck:
    q = db.query(ExternalCheck).filter(ExternalCheck.id == check_id)
    org_id = scope_org_id(ctx)
    if org_id is not None:
        q = q.filter(ExternalCheck.org_id == org_id)
    check = q.first()
    if not check:
        raise HTTPException(status_code=404, detail="Check not found")
    return check


@router.post("")
def create_check(body: ExternalCheckCreate, ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    if body.check_type not in CHECK_TYPES:
        raise HTTPException(status_code=400, detail=f"check_type must be one of {', '.join(CHECK_TYPES)}")
    if body.check_type in ("tcp_port", "udp_port") and not body.port:
        raise HTTPException(status_code=400, detail=f"{body.check_type} requires a port")
    try:
        check = ExternalCheck(
            org_id=create_org_id(ctx), user_id=ctx.get("user_id"),
            name=body.name.strip(), check_type=body.check_type, target=body.target.strip(),
            port=body.port, interval_seconds=max(30, body.interval_seconds),
            enabled=body.enabled, config=body.config or {},
        )
        db.add(check)
        db.commit()
        db.refresh(check)
        # Give the wizard/dashboard an immediate first result instead of a
        # blank "no data yet" until the scheduler's next 30s tick.
        run_check_now(check.id)
        db.refresh(check)
        return _to_dict(check)
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to create check: {e}")


@router.get("")
def list_checks(ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    try:
        q = db.query(ExternalCheck)
        org_id = scope_org_id(ctx)
        if org_id is not None:
            q = q.filter(ExternalCheck.org_id == org_id)
        return [_to_dict(c) for c in q.order_by(ExternalCheck.created_at.desc()).all()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load checks: {e}")


@router.get("/{check_id}")
def get_check(check_id: int, ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    check = _get_owned(db, check_id, ctx)
    return _to_dict(check)


@router.get("/{check_id}/results")
def get_results(check_id: int, hours: int = Query(24, ge=1, le=720),
                 ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    check = _get_owned(db, check_id, ctx)
    since = datetime.utcnow() - timedelta(hours=hours)
    rows = (db.query(ExternalCheckResult)
              .filter(ExternalCheckResult.check_id == check.id, ExternalCheckResult.checked_at >= since)
              .order_by(ExternalCheckResult.checked_at.asc())
              .all())
    up_count = sum(1 for r in rows if r.status == "up")
    return {
        "check": _to_dict(check),
        "uptime_pct": round(100 * up_count / len(rows), 2) if rows else None,
        "results": [{
            "checked_at": r.checked_at.isoformat() if r.checked_at else None,
            "status": r.status, "response_time_ms": r.response_time_ms,
            "status_code": r.status_code, "error_message": r.error_message,
        } for r in rows],
    }


@router.patch("/{check_id}")
def update_check(check_id: int, body: ExternalCheckUpdate,
                  ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    check = _get_owned(db, check_id, ctx)
    try:
        for field in ("name", "target", "port", "interval_seconds", "enabled", "config"):
            v = getattr(body, field)
            if v is not None:
                setattr(check, field, v)
        check.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(check)
        return _to_dict(check)
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to update check: {e}")


@router.delete("/{check_id}")
def delete_check(check_id: int, ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    check = _get_owned(db, check_id, ctx)
    try:
        db.query(ExternalCheckResult).filter(ExternalCheckResult.check_id == check.id).delete()
        db.delete(check)
        db.commit()
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Failed to delete check: {e}")


@router.post("/{check_id}/test")
def test_check(check_id: int, ctx: dict = Depends(tenant_ctx), db: Session = Depends(get_db)):
    _get_owned(db, check_id, ctx)  # 404s if not owned, before running
    result = run_check_now(check_id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result
