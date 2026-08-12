"""
OTP login service — 2-step login.
  1) credentials validated  → generate 6-digit OTP, email it (smtp_configs), return a short-lived otp_token
  2) verify_otp(token, code) → returns the user_id on success

OTP store is in-memory with a 5-minute TTL (no schema change). Email uses the
default row in smtp_configs (reusing the app's existing SMTP setup).
"""
import math
import os
import time
import secrets
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("actmon.otp")

OTP_TTL_SECONDS = int(os.getenv("OTP_TTL_SECONDS", "300"))   # 5 minutes
OTP_MAX_ATTEMPTS = 5
# Resend guards: a minimum gap between codes (stops accidental double-clicks and
# deliberate mail-bombing of a user's inbox) and a hard cap per login attempt.
OTP_RESEND_COOLDOWN_SECONDS = int(os.getenv("OTP_RESEND_COOLDOWN_SECONDS", "30"))
OTP_MAX_RESENDS = int(os.getenv("OTP_MAX_RESENDS", "3"))
# When on, the response includes the code (dev/testing only). Off in production.
OTP_DEBUG = os.getenv("OTP_DEBUG", "0") in ("1", "true", "True")

# token -> {user_id, code, expires, attempts, email, resend_count, last_sent}
_STORE: dict[str, dict] = {}


def _now() -> float:
    return time.time()


def _purge() -> None:
    dead = [k for k, v in _STORE.items() if v["expires"] < _now()]
    for k in dead:
        _STORE.pop(k, None)


def _smtp_config(db: Session) -> dict:
    row = db.execute(text(
        "SELECT smtp_host, smtp_port, smtp_user, smtp_password, smtp_tls, sender_email, sender_name "
        "FROM smtp_configs WHERE is_default = true ORDER BY id LIMIT 1"
    )).mappings().first()
    if not row:
        row = db.execute(text(
            "SELECT smtp_host, smtp_port, smtp_user, smtp_password, smtp_tls, sender_email, sender_name "
            "FROM smtp_configs ORDER BY id LIMIT 1"
        )).mappings().first()
    if not row:
        raise HTTPException(status_code=500, detail="No SMTP configuration found. Configure SMTP first.")
    return dict(row)


def _send_email(cfg: dict, to_email: str, subject: str, html: str) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{cfg.get('sender_name') or 'Actmon'} <{cfg['sender_email']}>"
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html", "utf-8"))
    host, port = cfg["smtp_host"], int(cfg["smtp_port"])
    try:
        if cfg.get("smtp_tls"):
            server = smtplib.SMTP(host, port, timeout=30)
            server.ehlo(); server.starttls(); server.ehlo()
        else:
            server = smtplib.SMTP_SSL(host, port, timeout=30)
        if cfg.get("smtp_user"):
            server.login(cfg["smtp_user"], cfg["smtp_password"])
        server.sendmail(cfg["sender_email"], [to_email], msg.as_string())
        server.quit()
    except Exception as e:  # noqa: BLE001
        log.error("OTP email send failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Could not send OTP email: {e}")


def _otp_html(code: str, name: str) -> str:
    return f"""
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto">
      <h2 style="color:#1e293b">Actmon — Login Verification</h2>
      <p>Hi {name or 'there'}, use this one-time password to complete your login:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#4f46e5;
                  background:#eef2ff;border-radius:12px;padding:18px;text-align:center;margin:18px 0">{code}</div>
      <p style="color:#64748b;font-size:13px">This code expires in {OTP_TTL_SECONDS // 60} minutes.
         If you didn't request it, ignore this email.</p>
    </div>"""


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return email or ""
    name, dom = email.split("@", 1)
    head = name[0] if name else ""
    return f"{head}{'*' * max(1, len(name) - 1)}@{dom}"


def generate_and_send(db: Session, user: dict, *, resend_count: int = 0) -> dict:
    """Create + email an OTP for a (already credential-validated) user. Returns otp_token.

    The new token is stored ONLY after the email actually goes out — if SMTP
    fails this raises with nothing written, so a failed send can never leave a
    half-built session behind.
    """
    _purge()
    email = user.get("email_id")
    if not email:
        raise HTTPException(status_code=400, detail="No email on file for this user; cannot send OTP.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    cfg = _smtp_config(db)
    _send_email(cfg, email, "Your Actmon login OTP", _otp_html(code, user.get("employee_name") or user.get("user_name")))
    token = secrets.token_urlsafe(24)
    _STORE[token] = {"user_id": user["user_id"], "code": code,
                     "expires": _now() + OTP_TTL_SECONDS, "attempts": 0, "email": email,
                     "resend_count": resend_count, "last_sent": _now()}
    log.info("OTP issued for user_id=%s (resend #%s)", user["user_id"], resend_count)
    out = {"otp_token": token, "email_masked": mask_email(email), "expires_in": OTP_TTL_SECONDS,
           "resend_cooldown": OTP_RESEND_COOLDOWN_SECONDS,
           "resends_left": max(0, OTP_MAX_RESENDS - resend_count)}
    if OTP_DEBUG:
        out["dev_otp"] = code   # testing only
    return out


def verify_otp(token: str, code: str) -> int:
    """Return user_id if the OTP is valid; raise otherwise. Single-use."""
    _purge()
    entry = _STORE.get(token)
    if not entry:
        raise HTTPException(status_code=400, detail="OTP expired or invalid. Please login again.")
    if entry["attempts"] >= OTP_MAX_ATTEMPTS:
        _STORE.pop(token, None)
        raise HTTPException(status_code=429, detail="Too many incorrect attempts. Please login again.")
    if str(code).strip() != entry["code"]:
        entry["attempts"] += 1
        raise HTTPException(status_code=400, detail="Incorrect OTP.")
    _STORE.pop(token, None)   # consume
    return entry["user_id"]


def resend(db: Session, token: str, user_lookup) -> dict:
    """Re-issue an OTP for an existing pending token.

    The previous token is retired only AFTER the replacement has been issued
    and emailed. Doing it the other way round (pop first, then send) meant a
    transient SMTP failure destroyed the pending login outright — the user was
    left with no valid token at all and every retry answered "Session expired.
    Please login again.", with re-entering credentials the only way out.
    """
    _purge()
    entry = _STORE.get(token)
    if not entry or entry["expires"] < _now():
        _STORE.pop(token, None)
        raise HTTPException(status_code=400, detail="Session expired. Please login again.")

    waited = _now() - entry.get("last_sent", 0)
    if waited < OTP_RESEND_COOLDOWN_SECONDS:
        # ceil, not int()+1 — the latter reports "31s" for a 30s cooldown when
        # no measurable time has passed (Windows' coarse clock makes that common).
        remaining = math.ceil(OTP_RESEND_COOLDOWN_SECONDS - waited)
        raise HTTPException(status_code=429,
                            detail=f"Please wait {remaining}s before requesting another code.")
    if entry.get("resend_count", 0) >= OTP_MAX_RESENDS:
        raise HTTPException(status_code=429,
                            detail="Resend limit reached for this login. Please sign in again to get a new code.")

    user = user_lookup(entry["user_id"])
    if not user:
        _STORE.pop(token, None)
        raise HTTPException(status_code=400, detail="Session expired. Please login again.")

    out = generate_and_send(db, user, resend_count=entry.get("resend_count", 0) + 1)
    _STORE.pop(token, None)   # safe now: the replacement exists and was delivered
    return out
