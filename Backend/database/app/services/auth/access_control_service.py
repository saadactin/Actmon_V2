"""
Access Control + Security service — driven by the existing PostgreSQL schema.

Auth / profile        : user_master, employee_master, role, organization_master
Permission catalog    : permission              (bitwise)
Menu                  : module_master, page_master, vw_access_control_page_permission
Security tracking     : login_history, user_session, password_history   (Phase 4)

Reads use existing views; nothing recreates schema.
"""
from __future__ import annotations

import os
import datetime
import secrets
from typing import Optional

import jwt
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.common.credential_encryption_service import credential_encryption

SECRET_KEY = os.getenv("JWT_SECRET", "actmon-secret-key-change-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "24"))


# ─────────────────────────── JWT ───────────────────────────
def make_token(user: dict, session_id: Optional[int] = None) -> str:
    exp = datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {
        "sub": user["user_name"], "user_id": user["user_id"],
        "org_id": user["org_id"], "role_id": user["role_id"],
        "sid": session_id, "exp": exp,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ───────────────────── user agent parsing ─────────────────────
def parse_user_agent(ua: str) -> dict:
    ua = ua or ""
    low = ua.lower()
    browser = ("Edge" if "edg" in low else "Chrome" if "chrome" in low else "Firefox" if "firefox" in low
               else "Safari" if "safari" in low else "Unknown")
    os_name = ("Windows" if "windows" in low else "macOS" if "mac os" in low else "Android" if "android" in low
               else "iOS" if ("iphone" in low or "ipad" in low) else "Linux" if "linux" in low else "Unknown")
    device = "Mobile" if any(k in low for k in ("mobile", "android", "iphone")) else "Desktop"
    return {"browser": browser, "os": os_name, "device": device}


# ─────────────────────── permission catalog ───────────────────────
def get_governed_urls(db: Session) -> list[str]:
    """All RBAC-governed page URLs (every active page_master row). Lets the
    frontend distinguish 'page exists but you lack access' from 'public route'."""
    rows = db.execute(text(
        "SELECT DISTINCT page_url FROM page_master "
        "WHERE is_active = true AND deleted_at IS NULL AND page_url IS NOT NULL AND page_url <> ''"
    )).scalars().all()
    return list(rows)


def get_permission_catalog(db: Session) -> list[dict]:
    rows = db.execute(text(
        "SELECT permission_id, permission_name, permission_value FROM permission "
        "WHERE is_active = true ORDER BY permission_value"
    )).mappings().all()
    return [dict(r) for r in rows]


def _view_bit(db: Session) -> int:
    row = db.execute(text(
        "SELECT permission_value FROM permission WHERE lower(permission_name)='view' AND is_active=true LIMIT 1"
    )).scalar()
    return int(row) if row is not None else 1


# ─────────────────────────── auth ───────────────────────────
def fetch_user(db: Session, username: str) -> Optional[dict]:
    row = db.execute(text("""
        SELECT u.user_id, u.org_id, u.role_id, u.user_name, u.password_hash,
               u.employee_id, u.is_active, u.account_locked,
               e.employee_name, e.email_id, e.employee_code, e.mobile_no,
               r.role_name, r.role_description, o.org_name, o.org_code, o.logo_path AS org_logo
        FROM user_master u
        LEFT JOIN employee_master     e ON e.employee_id = u.employee_id
        LEFT JOIN role                r ON r.role_id      = u.role_id
        LEFT JOIN organization_master o ON o.org_id       = u.org_id
        WHERE lower(u.user_name) = lower(:username) AND u.deleted_at IS NULL
        LIMIT 1
    """), {"username": username}).mappings().first()
    return dict(row) if row else None


def authenticate(db: Session, username: str, password: str, ip: str = None, ua: str = None) -> dict:
    """Validate credentials. On failure, still record a failed login_history row."""
    user = fetch_user(db, username)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    if not user["is_active"]:
        raise HTTPException(status_code=403, detail="Account is inactive")
    if user["account_locked"]:
        raise HTTPException(status_code=403, detail="Account is locked. Contact administrator.")
    # passwords are plain text in this DB
    if str(user["password_hash"]) != str(password):
        try:
            db.execute(text("UPDATE user_master SET failed_login_attempts = failed_login_attempts + 1 WHERE user_id=:u"),
                       {"u": user["user_id"]})
            record_login(db, user, success=False, ip=ip, ua=ua)
            db.commit()
        except Exception:
            db.rollback()
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    user.pop("password_hash", None)
    return user


def get_user_by_id(db: Session, user_id: int) -> dict:
    row = db.execute(text("""
        SELECT u.user_id, u.org_id, u.role_id, u.user_name, u.employee_id,
               u.is_active, u.account_locked, u.last_login_at,
               e.employee_name, e.email_id, e.employee_code, e.mobile_no,
               r.role_name, r.role_description, o.org_name, o.org_code, o.logo_path AS org_logo
        FROM user_master u
        LEFT JOIN employee_master     e ON e.employee_id = u.employee_id
        LEFT JOIN role                r ON r.role_id      = u.role_id
        LEFT JOIN organization_master o ON o.org_id       = u.org_id
        WHERE u.user_id = :uid LIMIT 1
    """), {"uid": user_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


# ─────────────────── security tracking (Phase 4) ───────────────────
def record_login(db: Session, user: dict, success: bool, ip: str = None, ua: str = None) -> Optional[int]:
    info = parse_user_agent(ua)
    return db.execute(text("""
        INSERT INTO login_history (org_id, user_id, login_time, login_status, ip_address, device_name, browser_name, operating_system)
        VALUES (:org, :uid, now(), :ok, :ip, :dev, :br, :os)
        RETURNING login_history_id
    """), {"org": user.get("org_id"), "uid": user["user_id"], "ok": success, "ip": ip,
           "dev": info["device"], "br": info["browser"], "os": info["os"]}).scalar()


def create_session(db: Session, user: dict, ip: str = None, ua: str = None) -> tuple[int, str]:
    """Returns (session_id, raw_token) — the raw token is never persisted.
    Only its HMAC-SHA256 hash (via the centralized CredentialEncryptionService,
    same pattern as agent enrollment tokens) is stored in `user_session.
    session_token`, since this row is a write-only security-tracking/audit
    artifact (device/IP/login-time listing) that no auth path reads back for
    equality lookup — a one-way hash is strictly correct here, not reversible
    encryption, and this is nothing this app can decrypt back to."""
    token = secrets.token_urlsafe(32)
    info = parse_user_agent(ua)
    # expiry_time computed via the SAME SQL now() as login_time, not a
    # separately-computed Python datetime.utcnow() — this column is naive
    # (timestamp without time zone) and the DB's session TimeZone is
    # Asia/Kolkata (IST, UTC+5:30), so now() already returns IST wall-clock
    # time here. Mixing in a UTC-based Python value made every session's
    # displayed lifetime 5.5h short (18.5h instead of the intended 24h) and
    # could mark a still-valid session as "Ended" this many hours early on
    # the User Sessions page — the actual JWT's own `exp` claim (still
    # UTC-based in create_access_token, correctly so per the JWT spec) was
    # never affected; this only fixes what this audit table displays.
    sid = db.execute(text("""
        INSERT INTO user_session (user_id, session_token, login_time, expiry_time, ip_address, device_name, is_active)
        VALUES (:uid, :tok, now(), now() + (:hours || ' hours')::interval, :ip, :dev, true)
        RETURNING session_id
    """), {"uid": user["user_id"], "tok": credential_encryption.hash_token(token),
           "hours": TOKEN_EXPIRE_HOURS, "ip": ip, "dev": info["device"]}).scalar()
    return sid, token


def close_session(db: Session, user_id: int, session_id: Optional[int] = None) -> None:
    if session_id:
        db.execute(text("UPDATE user_session SET is_active=false WHERE session_id=:s"), {"s": session_id})
    else:
        db.execute(text("UPDATE user_session SET is_active=false WHERE user_id=:u AND is_active=true"), {"u": user_id})
    # stamp the most recent open login_history row
    db.execute(text("""
        UPDATE login_history SET logout_time = now()
        WHERE login_history_id = (
            SELECT login_history_id FROM login_history
            WHERE user_id = :u AND logout_time IS NULL AND login_status = true
            ORDER BY login_history_id DESC LIMIT 1)
    """), {"u": user_id})
    db.commit()


def change_password(db: Session, user_id: int, old_password: str, new_password: str) -> dict:
    current = db.execute(text("SELECT password_hash FROM user_master WHERE user_id=:u"), {"u": user_id}).scalar()
    if current is None:
        raise HTTPException(status_code=404, detail="User not found")
    if str(current) != str(old_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if str(new_password) == str(old_password):
        raise HTTPException(status_code=400, detail="New password must differ from the current password")
    # block reuse of last 3 passwords
    recent = db.execute(text(
        "SELECT password_hash FROM password_history WHERE user_id=:u ORDER BY password_history_id DESC LIMIT 3"
    ), {"u": user_id}).scalars().all()
    if any(str(new_password) == str(h) for h in recent):
        raise HTTPException(status_code=400, detail="You cannot reuse a recent password")
    # archive current, then set new
    db.execute(text("INSERT INTO password_history (user_id, password_hash, created_at) VALUES (:u, :h, now())"),
               {"u": user_id, "h": current})
    db.execute(text("UPDATE user_master SET password_hash=:p, modified_at=now(), modified_by=:u WHERE user_id=:u"),
               {"p": new_password, "u": user_id})
    db.commit()
    return {"status": "success", "message": "Password changed successfully"}


# ───────────────────── permissions + menu ─────────────────────
def _page_parent_map(db: Session) -> dict[int, int]:
    rows = db.execute(text(
        "SELECT page_id, COALESCE(parent_id,0) AS parent_id FROM page_master WHERE is_active = true"
    )).mappings().all()
    return {r["page_id"]: r["parent_id"] for r in rows}


def get_role_permissions(db: Session, org_id: int, role_id: int) -> list[dict]:
    rows = db.execute(text("""
        SELECT pm.page_id, pm.page_code, pm.page_name, pm.page_url,
               pm.module_id, COALESCE(pm.parent_id,0) AS parent_id, pm.is_menu, pm.display_order,
               v.permission, v.permissions, v.permission_description
        FROM vw_access_control_page_permission v
        JOIN page_master pm ON pm.page_id = v.page_id
        WHERE v.org_id = :org AND v.role_id = :role AND pm.is_active = true
        ORDER BY pm.module_id, COALESCE(pm.parent_id,0), pm.display_order
    """), {"org": org_id, "role": role_id}).mappings().all()
    out = []
    granted_view = {}
    view_bit = _view_bit(db)
    for r in rows:
        d = dict(r)
        d["permissions"] = [p.strip() for p in (d.get("permissions") or "").split(",") if p.strip()]
        out.append(d)
        granted_view[d["page_id"]] = (int(d["permission"]) & view_bit) == view_bit

    # Cascade: a page is only truly reachable if EVERY ancestor in its
    # parent_id chain also grants View — not just the page's own row. Without
    # this, revoking a parent (e.g. a catalog tab) only hid its children from
    # the nav menu (build_menu already walks parent_id) but left them directly
    # reachable by URL, since the frontend route guard (isDeniedHere) just
    # trusts each page's own permission bit independently. Zeroing the
    # descendant's permission here — before it ever reaches the frontend —
    # makes "revoke the parent" actually revoke everything under it,
    # regardless of how the page is reached.
    parent_of = _page_parent_map(db)
    ok_cache: dict[int, bool] = {}

    def ancestors_ok(pid: int) -> bool:
        if pid == 0:
            return True
        if pid in ok_cache:
            return ok_cache[pid]
        ok_cache[pid] = False  # guard against a cyclic parent_id
        result = granted_view.get(pid, False) and ancestors_ok(parent_of.get(pid, 0))
        ok_cache[pid] = result
        return result

    for d in out:
        if not ancestors_ok(d["parent_id"]):
            d["permission"] = 0
            d["permissions"] = []

    return out


def has_access(db: Session, org_id: int, role_id: int) -> bool:
    """True if the role has View on at least one page (i.e. can use the app at all)."""
    view = _view_bit(db)
    perms = get_role_permissions(db, org_id, role_id)
    return any((int(p["permission"]) & view) == view for p in perms)


def build_menu(db: Session, org_id: int, role_id: int) -> list[dict]:
    view_bit = _view_bit(db)
    perms = get_role_permissions(db, org_id, role_id)
    viewable = {p["page_id"]: p for p in perms if p["is_menu"] and (int(p["permission"]) & view_bit) == view_bit}
    children_of: dict[int, list[int]] = {}
    for p in viewable.values():
        children_of.setdefault(p["parent_id"], []).append(p["page_id"])

    def node(pid: int) -> dict:
        p = viewable[pid]
        kids = sorted(children_of.get(pid, []), key=lambda k: viewable[k]["display_order"])
        return {"page_id": p["page_id"], "code": p["page_code"], "name": p["page_name"],
                "url": p["page_url"], "permission": int(p["permission"]), "children": [node(k) for k in kids]}

    modules = db.execute(text(
        "SELECT module_id, module_name, module_code, module_route, module_icon, display_order "
        "FROM module_master WHERE is_active=true ORDER BY display_order, module_id"
    )).mappings().all()
    menu = []
    for m in modules:
        tops = sorted([p["page_id"] for p in viewable.values()
                       if p["module_id"] == m["module_id"] and p["parent_id"] == 0],
                      key=lambda k: viewable[k]["display_order"])
        if not tops:
            continue
        menu.append({"module_id": m["module_id"], "name": m["module_name"], "code": m["module_code"],
                     "icon": m["module_icon"], "route": m["module_route"], "children": [node(p) for p in tops]})
    return menu


def validate_access(db: Session, org_id: int, role_id: int, page_url: str, required: int = 1) -> dict:
    row = db.execute(text("""
        SELECT v.permission FROM vw_access_control_page_permission v
        JOIN page_master pm ON pm.page_id = v.page_id
        WHERE v.org_id=:org AND v.role_id=:role AND pm.page_url=:url LIMIT 1
    """), {"org": org_id, "role": role_id, "url": page_url}).scalar()
    perm = int(row) if row is not None else 0
    return {"allowed": (perm & required) == required and required != 0, "permission": perm,
            "required": required, "page_url": page_url}


def build_login_payload(db: Session, user: dict) -> dict:
    perms = get_role_permissions(db, user["org_id"], user["role_id"])
    return {
        "user": {
            "user_id": user["user_id"], "username": user["user_name"],
            "employee_id": user.get("employee_id"), "employee_name": user.get("employee_name"),
            "email": user.get("email_id"), "org_id": user["org_id"], "org_name": user.get("org_name"),
            "org_logo": user.get("org_logo"),
            "is_active": user.get("is_active", True),
            "is_superuser": user.get("role_id") == 1 and user.get("org_id") == 1,
        },
        "role": {"role_id": user["role_id"], "role_name": user.get("role_name"),
                 "role_description": user.get("role_description")},
        "menu": build_menu(db, user["org_id"], user["role_id"]),
        "permissions": [{"page_id": p["page_id"], "page_code": p["page_code"], "page_name": p["page_name"],
                         "page_url": p["page_url"], "permission": int(p["permission"]),
                         "permissions": p["permissions"]} for p in perms],
        "permission_catalog": get_permission_catalog(db),
        "governed_urls": get_governed_urls(db),
    }
