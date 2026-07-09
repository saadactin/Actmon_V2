"""
First-run setup — create the initial Super Admin employee + user.

The installer's DB step seeds organization #1, the Super Admin role (#1) and all
page grants, but intentionally leaves users/employees empty. This endpoint pair
lets the browser first-run wizard create the very first admin. Both are guarded so
they only work while the system is uninitialized (no users yet) — once an admin
exists, POST /admin returns 409 and can never be used to escalate.
"""
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.database.connection import SessionLocal

router = APIRouter(prefix="/api/v1/setup", tags=["Setup"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AdminSetup(BaseModel):
    employee_name: str
    email: str
    mobile: str = ""
    employee_code: str = ""
    username: str
    password: str


def _user_count(db) -> int:
    return db.execute(text("SELECT COUNT(*) FROM user_master WHERE deleted_at IS NULL")).scalar() or 0


@router.get("/status", summary="Is first-run setup needed?")
def setup_status():
    db = SessionLocal()
    try:
        users = _user_count(db)
        org = db.execute(text("SELECT org_name FROM organization_master WHERE org_id=1")).scalar()
        role_ready = (db.execute(text("SELECT COUNT(*) FROM role WHERE role_id=1")).scalar() or 0) > 0
        pages = db.execute(text("SELECT COUNT(*) FROM page_master WHERE is_active")).scalar() or 0
        return {
            "needs_setup": users == 0,
            "user_count": users,
            "org_name": org or "",
            "db_ready": role_ready and pages > 0,
        }
    except Exception as e:  # noqa: BLE001 — DB not provisioned yet
        return {"needs_setup": True, "user_count": 0, "org_name": "", "db_ready": False,
                "error": str(e).splitlines()[0]}
    finally:
        db.close()


@router.post("/admin", summary="Create the first Super Admin employee + user")
def create_admin(body: AdminSetup):
    name = (body.employee_name or "").strip()
    email = (body.email or "").strip()
    username = (body.username or "").strip()
    password = body.password or ""
    if not name:
        raise HTTPException(status_code=400, detail="Full name is required.")
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="A valid email address is required.")
    if not username:
        raise HTTPException(status_code=400, detail="Username is required.")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")

    db = SessionLocal()
    try:
        if _user_count(db) > 0:
            raise HTTPException(status_code=409, detail="Setup already completed - an admin user already exists.")
        if (db.execute(text("SELECT COUNT(*) FROM role WHERE role_id=1")).scalar() or 0) == 0:
            raise HTTPException(status_code=500, detail="Super Admin role not found - run the installer's database step first.")
        if (db.execute(text("SELECT COUNT(*) FROM organization_master WHERE org_id=1")).scalar() or 0) == 0:
            raise HTTPException(status_code=500, detail="Organization not found - run the installer's database step first.")

        # username must be unique
        taken = db.execute(text("SELECT 1 FROM user_master WHERE lower(user_name)=lower(:u) AND deleted_at IS NULL"),
                           {"u": username}).first()
        if taken:
            raise HTTPException(status_code=409, detail=f"Username '{username}' is already taken.")

        status_id = db.execute(text("SELECT status_id FROM status_master ORDER BY status_id LIMIT 1")).scalar()
        code = (body.employee_code or "").strip() or "EMP001"

        emp_id = db.execute(text(
            "INSERT INTO employee_master "
            "(org_id, employee_code, employee_name, email_id, mobile_no, employment_status_id, is_active, created_by, created_at) "
            "VALUES (1, :code, :name, :email, :mobile, :st, TRUE, 1, NOW()) RETURNING employee_id"),
            {"code": code, "name": name, "email": email, "mobile": (body.mobile or "").strip(), "st": status_id}).scalar()

        user_id = db.execute(text(
            "INSERT INTO user_master "
            "(org_id, role_id, user_name, password_hash, employee_id, is_active, created_by, created_at) "
            "VALUES (1, 1, :un, :pw, :emp, TRUE, 1, NOW()) RETURNING user_id"),
            {"un": username, "pw": password, "emp": emp_id}).scalar()

        db.commit()
        return {"status": "success", "employee_id": emp_id, "user_id": user_id,
                "username": username, "role": "Super Admin",
                "message": "Super Admin created. You can now sign in."}
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Could not create admin: {str(e).splitlines()[0]}")
    finally:
        db.close()
