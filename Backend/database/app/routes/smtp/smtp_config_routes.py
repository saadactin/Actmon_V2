"""
Global SMTP Configuration API
  GET    /api/v1/settings/smtp          — get all configs (usually just one default)
  POST   /api/v1/settings/smtp          — create config
  PUT    /api/v1/settings/smtp/{id}     — update config
  DELETE /api/v1/settings/smtp/{id}     — delete config
  POST   /api/v1/settings/smtp/{id}/test — test connection
  GET    /api/v1/settings/smtp/default  — get default config (for pre-filling forms)
"""

import smtplib
import socket
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.smtp_config_model import SmtpConfig
from app.services.common.crypto_service import encrypt_secret, decrypt_secret
from app.services.common.credential_encryption_service import credential_encryption

router = APIRouter(prefix="/api/v1/settings/smtp", tags=["smtp-config"])
log = logging.getLogger("smtp_config")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── Schemas ───────────────────────────────────────────────────
class SmtpCreate(BaseModel):
    name:         str  = "Default SMTP"
    smtp_host:    str
    smtp_port:    int  = 587
    smtp_user:    Optional[str] = None
    smtp_password:Optional[str] = None
    smtp_tls:     bool = True
    sender_email: str
    sender_name:  str  = "Actmon Monitor"
    is_default:   bool = True

class SmtpUpdate(BaseModel):
    name:         Optional[str]  = None
    smtp_host:    Optional[str]  = None
    smtp_port:    Optional[int]  = None
    smtp_user:    Optional[str]  = None
    smtp_password:Optional[str]  = None
    smtp_tls:     Optional[bool] = None
    sender_email: Optional[str]  = None
    sender_name:  Optional[str]  = None
    is_default:   Optional[bool] = None


# ─── Helpers ───────────────────────────────────────────────────
def _effective_password(cfg: SmtpConfig) -> Optional[str]:
    """The password to actually connect with — decrypted if the config was
    saved after the encryption retrofit, else the legacy plaintext column
    (still readable so configs saved before this change keep working until
    they're next edited, at which point they migrate to smtp_password_enc)."""
    if cfg.smtp_password_enc:
        try:
            return decrypt_secret(cfg.smtp_password_enc)
        except Exception:
            log.warning("Could not decrypt smtp_password_enc for config %s — falling back to legacy column", cfg.id)
    return cfg.smtp_password


def _to_dict(s: SmtpConfig) -> dict:
    return {
        "id":           s.id,
        "name":         s.name,
        "smtp_host":    s.smtp_host,
        "smtp_port":    s.smtp_port,
        "smtp_user":    s.smtp_user,
        "smtp_password": "•" * 12 if (s.smtp_password_enc or s.smtp_password) else None,  # never expose raw password
        "smtp_tls":     s.smtp_tls,
        "sender_email": s.sender_email,
        "sender_name":  s.sender_name,
        "is_default":   s.is_default,
        "created_at":   s.created_at.isoformat() if s.created_at else None,
        "updated_at":   s.updated_at.isoformat() if s.updated_at else None,
        "last_test_at": s.last_test_at.isoformat() if s.last_test_at else None,
        "last_test_ok": s.last_test_ok,
        "last_test_msg":s.last_test_msg,
    }


def _test_smtp(host: str, port: int, user: Optional[str], password: Optional[str], tls: bool) -> dict:
    """Try to connect and authenticate. Returns {ok, msg}."""
    try:
        # DNS check first
        socket.getaddrinfo(host, port)
    except socket.gaierror as e:
        return {
            "ok": False,
            "msg": (
                f"DNS resolution failed for '{host}' — "
                "check the hostname and ensure the server has internet access. "
                f"(Error: {e})"
            )
        }

    try:
        if tls:
            server = smtplib.SMTP(host, port, timeout=15)
            server.ehlo()
            server.starttls()
            server.ehlo()
        else:
            server = smtplib.SMTP_SSL(host, port, timeout=15)

        if user and password:
            server.login(user, password)

        server.quit()
        return {"ok": True, "msg": f"Connected and authenticated to {host}:{port} successfully."}
    except smtplib.SMTPAuthenticationError:
        return {"ok": False, "msg": "Authentication failed — check username and password (for Gmail use an App Password, not your account password)."}
    except smtplib.SMTPConnectError as e:
        return {"ok": False, "msg": f"Connection refused by {host}:{port}. Check port and firewall. ({e})"}
    except TimeoutError:
        return {"ok": False, "msg": f"Connection timed out to {host}:{port}. Server may be unreachable."}
    except Exception as e:
        return {"ok": False, "msg": str(e)}


# ─── Routes ────────────────────────────────────────────────────

@router.get("")
def list_configs(db: Session = Depends(get_db)):
    configs = db.query(SmtpConfig).order_by(SmtpConfig.is_default.desc(), SmtpConfig.id).all()
    return {"status": "success", "configs": [_to_dict(c) for c in configs]}


@router.get("/default")
def get_default(db: Session = Depends(get_db)):
    cfg = db.query(SmtpConfig).filter(SmtpConfig.is_default == True).first()
    if not cfg:
        cfg = db.query(SmtpConfig).order_by(SmtpConfig.id).first()
    if not cfg:
        return {"status": "success", "config": None}
    return {"status": "success", "config": _to_dict(cfg)}


@router.post("")
def create_config(req: SmtpCreate, db: Session = Depends(get_db)):
    if req.is_default:
        db.query(SmtpConfig).update({"is_default": False})
    cfg = SmtpConfig(
        name=req.name,
        smtp_host=req.smtp_host,
        smtp_port=req.smtp_port,
        smtp_user=req.smtp_user or None,
        smtp_password=None,
        smtp_password_enc=encrypt_secret(req.smtp_password) if req.smtp_password else None,
        smtp_tls=req.smtp_tls,
        sender_email=req.sender_email,
        sender_name=req.sender_name,
        is_default=req.is_default,
    )
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return {"status": "success", "config": _to_dict(cfg)}


@router.put("/{cfg_id}")
def update_config(cfg_id: int, req: SmtpUpdate, db: Session = Depends(get_db)):
    cfg = db.query(SmtpConfig).filter(SmtpConfig.id == cfg_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="SMTP config not found")
    data = req.model_dump(exclude_unset=True)
    if data.get("is_default"):
        db.query(SmtpConfig).filter(SmtpConfig.id != cfg_id).update({"is_default": False})
    # Password is handled separately: a masked placeholder means "unchanged",
    # a real value gets encrypted into smtp_password_enc and the legacy
    # plaintext column is cleared (this is the migration point for configs
    # saved before the encryption retrofit).
    new_password = data.pop("smtp_password", None)
    if not credential_encryption.looks_like_mask(new_password):
        cfg.smtp_password_enc = encrypt_secret(new_password)
        cfg.smtp_password = None
    for k, v in data.items():
        setattr(cfg, k, v)
    db.commit()
    return {"status": "success", "config": _to_dict(cfg)}


@router.delete("/{cfg_id}")
def delete_config(cfg_id: int, db: Session = Depends(get_db)):
    cfg = db.query(SmtpConfig).filter(SmtpConfig.id == cfg_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="SMTP config not found")
    db.delete(cfg)
    db.commit()
    return {"status": "success"}


@router.post("/{cfg_id}/test")
def test_config(cfg_id: int, db: Session = Depends(get_db)):
    cfg = db.query(SmtpConfig).filter(SmtpConfig.id == cfg_id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="SMTP config not found")
    result = _test_smtp(cfg.smtp_host, cfg.smtp_port, cfg.smtp_user, _effective_password(cfg), cfg.smtp_tls)
    cfg.last_test_at  = datetime.utcnow()
    cfg.last_test_ok  = result["ok"]
    cfg.last_test_msg = result["msg"]
    db.commit()
    return {"status": "success", **result}


@router.post("/test-inline")
def test_inline(req: SmtpCreate, db: Session = Depends(get_db)):
    """Test without saving — used from the Oracle report modal."""
    result = _test_smtp(req.smtp_host, req.smtp_port, req.smtp_user, req.smtp_password, req.smtp_tls)
    return {"status": "success", **result}
