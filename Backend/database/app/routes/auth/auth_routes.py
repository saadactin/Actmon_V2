"""
Auth & Access Control routes — DB-driven with security tracking. Prefix /api/v1/auth.

  POST /login            → validate, record login_history + user_session, return JWT + user + role + menu + permissions
  POST /logout           → close session, stamp logout_time
  GET  /me  /profile     → current user profile
  POST /change-password  → change password (archives to password_history, blocks reuse)
  GET  /menu             → dynamic hierarchical menu
  GET  /permissions      → per-page permissions (+ catalog)
  POST /validate-access  → check a permission bit on a page url
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.auth import access_control_service as svc
from app.services.auth import otp_service

router = APIRouter(prefix="/api/v1/auth", tags=["Auth"])
bearer_scheme = HTTPBearer(auto_error=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def current_claims(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)) -> dict:
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return svc.decode_token(credentials.credentials)


def _req(request: Request):
    return (request.client.host if request.client else None,
            request.headers.get("user-agent"))


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ValidateAccessRequest(BaseModel):
    page_url: str
    required: int = 1


class VerifyOtpRequest(BaseModel):
    otp_token: str
    otp: str


class ResendOtpRequest(BaseModel):
    otp_token: str


def _issue_session(db: Session, user: dict, request: Request) -> dict:
    """Record login + create session + return the full JWT payload (post-OTP)."""
    ip, ua = _req(request)
    svc.record_login(db, user, success=True, ip=ip, ua=ua)
    sid, _ = svc.create_session(db, user, ip=ip, ua=ua)
    db.execute(text("UPDATE user_master SET failed_login_attempts=0, last_login_at=now() WHERE user_id=:u"),
               {"u": user["user_id"]})
    db.commit()
    payload = svc.build_login_payload(db, user)
    token = svc.make_token(user, session_id=sid)
    return {"access_token": token, "token_type": "bearer", "session_id": sid, **payload}


@router.post("/login")
def login(req: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Step 1 — validate credentials + access, then email a 6-digit OTP. No JWT yet."""
    ip, ua = _req(request)
    user = svc.authenticate(db, req.username, req.password, ip=ip, ua=ua)
    # Block login entirely if the role has no granted access (no point issuing OTP/JWT).
    if not svc.has_access(db, user["org_id"], user["role_id"]):
        svc.record_login(db, user, success=False, ip=ip, ua=ua)
        db.commit()
        raise HTTPException(status_code=403,
                            detail="Access denied — your role has no modules assigned. Please contact your administrator.")
    # Super Admin (role 1, org 1) is the break-glass account and skips the email OTP,
    # so the first sign-in works even before SMTP is configured.
    if int(user.get("role_id") or 0) == 1 and int(user.get("org_id") or 0) == 1:
        return {"otp_required": False, **_issue_session(db, user, request)}
    otp = otp_service.generate_and_send(db, user)
    return {"otp_required": True, **otp}   # otp_token, email_masked, expires_in (+ dev_otp if OTP_DEBUG)


@router.post("/verify-otp")
def verify_otp(req: VerifyOtpRequest, request: Request, db: Session = Depends(get_db)):
    """Step 2 — verify the OTP, then create the session and return the JWT + menu + permissions."""
    user_id = otp_service.verify_otp(req.otp_token, req.otp)
    user = svc.get_user_by_id(db, user_id)
    user["user_name"] = user.get("user_name")
    return _issue_session(db, user, request)


@router.post("/resend-otp")
def resend_otp(req: ResendOtpRequest, db: Session = Depends(get_db)):
    return otp_service.resend(db, req.otp_token, lambda uid: svc.get_user_by_id(db, uid))


@router.post("/logout")
def logout(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    svc.close_session(db, claims.get("user_id"), claims.get("sid"))
    return {"status": "success", "message": "Logged out"}


@router.get("/me")
def get_me(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    user = svc.get_user_by_id(db, claims["user_id"])
    return {
        "id": user["user_id"], "user_id": user["user_id"], "username": user["user_name"],
        "email": user.get("email_id"), "employee_name": user.get("employee_name"),
        "employee_code": user.get("employee_code"), "org_id": user["org_id"], "org_name": user.get("org_name"),
        "org_logo": user.get("org_logo"),
        "role_id": user["role_id"], "role": user.get("role_name"), "role_name": user.get("role_name"),
        "is_active": user.get("is_active", True),
        "is_superuser": user["role_id"] == 1 and user["org_id"] == 1,
        "last_login_at": str(user.get("last_login_at") or ""),
    }


@router.get("/profile")
def get_profile(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    return get_me(claims, db)


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    return svc.change_password(db, claims["user_id"], req.old_password, req.new_password)


@router.get("/menu")
def get_menu(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    return {"menu": svc.build_menu(db, claims["org_id"], claims["role_id"])}


@router.get("/permissions")
def get_permissions(claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    perms = svc.get_role_permissions(db, claims["org_id"], claims["role_id"])
    return {
        "permissions": [{"page_id": p["page_id"], "page_code": p["page_code"], "page_name": p["page_name"],
                         "page_url": p["page_url"], "permission": int(p["permission"]),
                         "permissions": p["permissions"]} for p in perms],
        "permission_catalog": svc.get_permission_catalog(db),
        "governed_urls": svc.get_governed_urls(db),
    }


@router.post("/validate-access")
def validate_access(req: ValidateAccessRequest, claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    return svc.validate_access(db, claims["org_id"], claims["role_id"], req.page_url, req.required)
