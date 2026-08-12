"""
Notifications API — /api/v1/notifications/*
  GET    /channels                         list all 9 channel settings (org-scoped)
  GET    /channels/{type}                  one channel's settings
  PUT    /channels/{type}                  save enable/disable + config + secrets
  POST   /channels/{type}/test             test connection
  POST   /channels/{type}/test-notification  send a real test notification now
  GET    /severity-routing                 org-wide default channels per severity
  PUT    /severity-routing                 replace the routing table for one severity
  GET    /history                          delivery history, filterable
  GET    /templates                        every channel's effective subject/body template
  GET    /templates/{type}                 one channel's effective template
  PUT    /templates/{type}                 save a custom subject/body override
  DELETE /templates/{type}                 remove the override, revert to the built-in default
  POST   /templates/{type}/preview         render a draft template against sample alert data
  GET    /settings                         org-wide notification settings (currently: timezone)
  PUT    /settings                         save org-wide notification settings
"""
from datetime import datetime
from typing import Optional, List
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import desc, or_
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.notification_model import (
    NotificationChannel, NotificationHistory, NotificationSettings, NotificationTemplate, SeverityChannelRouting,
)
from app.services.common.time_utils import iso_utc
from app.services.notifications import channel_config_service, channel_dispatch, template_service

router = APIRouter(prefix="/api/v1/notifications", tags=["Notifications"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── channel settings ──────────────────────────────────────────────────────
class ChannelSave(BaseModel):
    enabled: Optional[bool] = None
    config: dict = {}
    secrets: dict = {}   # only non-empty keys overwrite the stored secret


@router.get("/channels")
def list_channels(org_id: int = Query(1), db: Session = Depends(get_db)):
    rows = [channel_config_service.get_or_create(db, org_id, ct) for ct in channel_config_service.CHANNEL_TYPES]
    return {"status": "success", "channels": [channel_config_service.to_public_dict(r) for r in rows]}


@router.get("/channels/{channel_type}")
def get_channel(channel_type: str, org_id: int = Query(1), db: Session = Depends(get_db)):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    row = channel_config_service.get_or_create(db, org_id, channel_type)
    return {"status": "success", "channel": channel_config_service.to_public_dict(row)}


@router.put("/channels/{channel_type}")
def save_channel(channel_type: str, req: ChannelSave, org_id: int = Query(1), db: Session = Depends(get_db)):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    row = channel_config_service.get_or_create(db, org_id, channel_type)
    row = channel_config_service.save(db, row, enabled=req.enabled, config=req.config, secrets=req.secrets)
    return {"status": "success", "channel": channel_config_service.to_public_dict(row)}


@router.post("/channels/{channel_type}/test")
def test_channel(channel_type: str, org_id: int = Query(1), db: Session = Depends(get_db)):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    row = channel_config_service.get_or_create(db, org_id, channel_type)
    result = channel_dispatch.test_connection(db, org_id, row)
    channel_config_service.record_test_result(db, row, result.get("ok", False), result.get("msg", ""))
    return {"status": "success", **result}


class TestNotificationIn(BaseModel):
    # Email has no org-wide default recipient any more (that was a hardcoded
    # fallback to the SMTP sender's own address) — a test send needs an
    # explicit one-off address, used only for this call, never persisted.
    recipient: Optional[str] = None


@router.post("/channels/{channel_type}/test-notification")
def send_test_notification(
    channel_type: str, req: TestNotificationIn = TestNotificationIn(),
    org_id: int = Query(1), db: Session = Depends(get_db),
):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    row = channel_config_service.get_or_create(db, org_id, channel_type)
    if not row.enabled:
        raise HTTPException(status_code=400, detail="Enable this channel before sending a test notification.")
    if channel_type == "email" and not (req.recipient or "").strip():
        raise HTTPException(status_code=400, detail="Enter an email address to send the test to.")
    recipients_override = [req.recipient.strip()] if channel_type == "email" and req.recipient else None
    result = channel_dispatch.send(db, org_id, row, channel_dispatch.SAMPLE_CONTEXT, recipients_override=recipients_override)
    ok = result.get("status") == "success"
    channel_config_service.record_send_result(db, row, ok, error=None if ok else result.get("message"))
    db.add(NotificationHistory(
        org_id=org_id, alert_rule_id=None, alert_name="Test Notification",
        server_name=channel_dispatch.SAMPLE_CONTEXT.get("ServerName"), database_name=None,
        severity="Information", channel_type=channel_type, recipient=result.get("recipient"),
        status="sent" if ok else "failed", response_code=result.get("response_code"),
        response_time_ms=None, retry_count=0, error_message=None if ok else result.get("message"),
    ))
    db.commit()
    return {"status": "success", **result}


# ─── severity-based default routing ────────────────────────────────────────
class SeverityRoutingIn(BaseModel):
    severity: str
    channel_types: List[str] = []


@router.get("/severity-routing")
def get_severity_routing(org_id: int = Query(1), db: Session = Depends(get_db)):
    rows = db.query(SeverityChannelRouting).filter(SeverityChannelRouting.org_id == org_id, SeverityChannelRouting.enabled == True).all()
    out = {"information": [], "warning": [], "critical": []}
    for r in rows:
        out.setdefault(r.severity, []).append(r.channel_type)
    return {"status": "success", "routing": out}


@router.put("/severity-routing")
def set_severity_routing(req: SeverityRoutingIn, org_id: int = Query(1), db: Session = Depends(get_db)):
    db.query(SeverityChannelRouting).filter(
        SeverityChannelRouting.org_id == org_id, SeverityChannelRouting.severity == req.severity,
    ).delete()
    for ct in req.channel_types:
        db.add(SeverityChannelRouting(org_id=org_id, severity=req.severity, channel_type=ct, enabled=True))
    db.commit()
    return {"status": "success"}


# ─── delivery history ───────────────────────────────────────────────────────
@router.get("/history")
def list_history(
    org_id: Optional[int] = Query(None),
    channel_type: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    limit: int = Query(200, le=1000),
    db: Session = Depends(get_db),
):
    q = db.query(NotificationHistory)
    if org_id is not None:
        q = q.filter(NotificationHistory.org_id == org_id)
    if channel_type:
        q = q.filter(NotificationHistory.channel_type == channel_type)
    if severity:
        q = q.filter(NotificationHistory.severity == severity)
    if status:
        q = q.filter(NotificationHistory.status == status)
    if date_from:
        q = q.filter(NotificationHistory.sent_at >= date_from)
    if date_to:
        q = q.filter(NotificationHistory.sent_at <= date_to)
    if search:
        like = f"%{search}%"
        q = q.filter(or_(
            NotificationHistory.alert_name.ilike(like),
            NotificationHistory.server_name.ilike(like),
            NotificationHistory.database_name.ilike(like),
            NotificationHistory.recipient.ilike(like),
        ))
    rows = q.order_by(desc(NotificationHistory.sent_at)).limit(limit).all()
    return {"status": "success", "history": [
        {
            "id": r.id,
            "sent_at": iso_utc(r.sent_at),
            "alert_name": r.alert_name,
            "org_id": r.org_id,
            "server_name": r.server_name,
            "database_name": r.database_name,
            "severity": r.severity,
            "channel_type": r.channel_type,
            "recipient": r.recipient,
            "status": r.status,
            "response_code": r.response_code,
            "response_time_ms": r.response_time_ms,
            "retry_count": r.retry_count,
            "error_message": r.error_message,
        }
        for r in rows
    ]}


# ─── templates ──────────────────────────────────────────────────────────────
def _template_row(db: Session, org_id: int, channel_type: str) -> Optional[NotificationTemplate]:
    return (
        db.query(NotificationTemplate)
        .filter(NotificationTemplate.org_id == org_id, NotificationTemplate.channel_type == channel_type)
        .first()
    )


def _template_dict(db: Session, org_id: int, channel_type: str) -> dict:
    row = _template_row(db, org_id, channel_type)
    defaults = template_service.get_templates(db, org_id, channel_type, html=(channel_type == "email"))
    return {
        "channel_type": channel_type,
        "is_override": row is not None,
        "subject_template": (row.subject_template if row and row.subject_template else None) or defaults["subject"],
        "body_template": (row.body_template if row and row.body_template else None) or defaults["body"],
    }


class TemplateSave(BaseModel):
    subject_template: str = ""
    body_template: str = ""


@router.get("/templates")
def list_templates(org_id: int = Query(1), db: Session = Depends(get_db)):
    return {"status": "success", "templates": [
        _template_dict(db, org_id, ct) for ct in channel_config_service.CHANNEL_TYPES
    ]}


@router.get("/templates/{channel_type}")
def get_template(channel_type: str, org_id: int = Query(1), db: Session = Depends(get_db)):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    return {"status": "success", "template": _template_dict(db, org_id, channel_type)}


@router.put("/templates/{channel_type}")
def save_template(channel_type: str, req: TemplateSave, org_id: int = Query(1), db: Session = Depends(get_db)):
    if channel_type not in channel_config_service.CHANNEL_TYPES:
        raise HTTPException(status_code=404, detail="Unknown channel type")
    if not req.subject_template.strip() or not req.body_template.strip():
        raise HTTPException(status_code=400, detail="Subject and body cannot be empty.")
    row = _template_row(db, org_id, channel_type)
    if not row:
        row = NotificationTemplate(org_id=org_id, channel_type=channel_type)
        db.add(row)
    row.subject_template = req.subject_template
    row.body_template = req.body_template
    db.commit()
    return {"status": "success", "template": _template_dict(db, org_id, channel_type)}


@router.delete("/templates/{channel_type}")
def reset_template(channel_type: str, org_id: int = Query(1), db: Session = Depends(get_db)):
    db.query(NotificationTemplate).filter(
        NotificationTemplate.org_id == org_id, NotificationTemplate.channel_type == channel_type,
    ).delete()
    db.commit()
    return {"status": "success", "template": _template_dict(db, org_id, channel_type)}


class TemplatePreviewIn(BaseModel):
    subject_template: str = ""
    body_template: str = ""


@router.post("/templates/{channel_type}/preview")
def preview_template(channel_type: str, req: TemplatePreviewIn):
    return {
        "status": "success",
        "subject": template_service.render(req.subject_template, channel_dispatch.SAMPLE_CONTEXT),
        "body": template_service.render(req.body_template, channel_dispatch.SAMPLE_CONTEXT),
    }


# ─── org-wide notification settings (currently: timezone) ──────────────────
class NotificationSettingsIn(BaseModel):
    timezone: str


@router.get("/settings")
def get_notification_settings(org_id: int = Query(1), db: Session = Depends(get_db)):
    row = db.query(NotificationSettings).filter(NotificationSettings.org_id == org_id).first()
    return {"status": "success", "timezone": row.timezone if row else "Asia/Kolkata"}


@router.put("/settings")
def save_notification_settings(req: NotificationSettingsIn, org_id: int = Query(1), db: Session = Depends(get_db)):
    if req.timezone not in available_timezones():
        raise HTTPException(status_code=400, detail=f"Unknown timezone '{req.timezone}'")
    row = db.query(NotificationSettings).filter(NotificationSettings.org_id == org_id).first()
    if not row:
        row = NotificationSettings(org_id=org_id)
        db.add(row)
    row.timezone = req.timezone
    db.commit()
    return {"status": "success", "timezone": row.timezone}
