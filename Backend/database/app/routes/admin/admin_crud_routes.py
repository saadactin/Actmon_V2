"""
Generic Admin CRUD routes — one router per master entity, all config-driven.

Each entity exposes:
  GET    /api/v1/admin/{path}            list (optional ?org_id= for org-scoped)
  GET    /api/v1/admin/{path}/{id}       get by id
  POST   /api/v1/admin/{path}            create  (sp_insert*)
  PUT    /api/v1/admin/{path}/{id}       update  (sp_update*)
  DELETE /api/v1/admin/{path}/{id}       soft delete (sp_delete*)

Adding an entity = one ENTITIES row + its SPs/view. No new files.
"""
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.orm import Session


def _ctx(request: Request) -> dict:
    """Acting-user context for audit logging (user_id wired once auth is restored)."""
    return {
        "ip": request.client.host if request.client else None,
        "user_agent": request.headers.get("user-agent"),
    }

from app.database.connection import SessionLocal
from app.services.admin import crud_service as svc
from app.services.auth.tenant_context import tenant_ctx


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Genuinely per-company entities — non-super users only ever see/create their own org's rows.
# (modules / pages / permissions are GLOBAL app structure & catalog → shared by every org.)
TENANT_PATHS = {"roles", "organizations", "departments", "designations", "employees", "users"}
# Tenant entities that carry an org_id FK we stamp on create (organizations' org_id is its own PK).
ORG_FK_PATHS = {"roles", "departments", "designations", "employees", "users"}


# entity registry — view + pk + order + stored-procedure names
ENTITIES = [
    {"path": "roles", "title": "Role", "view": "vw_role", "pk": "role_id",
     "order": "role_id", "org_scoped": True,
     "sp_insert": "sp_insertrole", "sp_update": "sp_updaterole", "sp_delete": "sp_deleterole"},
    {"path": "permissions", "title": "Permission", "view": "vw_permission", "pk": "permission_id",
     "order": "permission_value", "org_scoped": False,
     "sp_insert": "sp_insertpermission", "sp_update": "sp_updatepermission", "sp_delete": "sp_deletepermission"},
    {"path": "modules", "title": "Module", "view": "vw_module", "pk": "module_id",
     "order": "display_order, module_id", "org_scoped": True,
     "sp_insert": "sp_insertmodule", "sp_update": "sp_updatemodule", "sp_delete": "sp_deletemodule"},
    {"path": "pages", "title": "Page", "view": "vw_page", "pk": "page_id",
     "order": "module_id, parent_id, display_order", "org_scoped": True,
     "sp_insert": "sp_insertpage", "sp_update": "sp_updatepage", "sp_delete": "sp_deletepage"},
    # ── Phase 2 ──
    {"path": "organizations", "title": "Organization", "view": "vw_organization", "pk": "org_id",
     "order": "org_id", "org_scoped": False,
     "sp_insert": "sp_insertorganization", "sp_update": "sp_updateorganization", "sp_delete": "sp_deleteorganization"},
    {"path": "departments", "title": "Department", "view": "vw_department", "pk": "department_id",
     "order": "department_id", "org_scoped": True,
     "sp_insert": "sp_insertdepartment", "sp_update": "sp_updatedepartment", "sp_delete": "sp_deletedepartment"},
    {"path": "designations", "title": "Designation", "view": "vw_designation", "pk": "designation_id",
     "order": "designation_id", "org_scoped": True,
     "sp_insert": "sp_insertdesignation", "sp_update": "sp_updatedesignation", "sp_delete": "sp_deletedesignation"},
    {"path": "employees", "title": "Employee", "view": "vw_employee", "pk": "employee_id",
     "order": "employee_id", "org_scoped": True, "unique_key": "employee_code",
     "sp_insert": "sp_insertemployee", "sp_update": "sp_updateemployee", "sp_delete": "sp_deleteemployee"},
    {"path": "users", "title": "User", "view": "vw_user", "pk": "user_id",
     "order": "user_id", "org_scoped": True,
     "sp_insert": "sp_insertuser", "sp_update": "sp_updateuser", "sp_delete": "sp_deleteuser"},
]


def make_router(cfg: dict) -> APIRouter:
    r = APIRouter(prefix=f"/api/v1/admin/{cfg['path']}", tags=[f"Admin - {cfg['title']}"])
    pk, view, order = cfg["pk"], cfg["view"], cfg["order"]
    is_tenant = cfg["path"] in TENANT_PATHS
    stamps_org = cfg["path"] in ORG_FK_PATHS

    @r.get("")
    def list_all(org_id: Optional[int] = None, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
        # Per-company entity: super admin may filter by a chosen org (or see all);
        # everyone else is locked to their own org. Global config is never filtered.
        if is_tenant:
            scope = org_id if ctx.get("is_super") else ctx.get("org_id")
        else:
            scope = None
        return {"data": svc.list_rows(db, view, order, scope)}

    @r.get("/{item_id}")
    def get_one(item_id: int, db: Session = Depends(get_db)):
        return svc.get_row(db, view, pk, item_id)

    @r.post("")
    def create(request: Request, body: dict = Body(...), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
        payload = {**body, "created_by": body.get("created_by", 1)}
        if stamps_org and not ctx.get("is_super"):
            payload["org_id"] = ctx.get("org_id")  # force creator's org
        svc.call_sp(db, cfg["sp_insert"], payload, _ctx(request))
        resp = {"status": "success", "message": f"{cfg['title']} created successfully"}
        # Return the newly-created row's id so the caller can chain follow-up actions —
        # e.g. auto-create a login for a new employee. Resolve by the unique business key
        # when supplied; otherwise (code auto-generated server-side) take the latest row.
        uk = cfg.get("unique_key")
        org_scope = payload.get("org_id") if stamps_org else None
        try:
            row = None
            if uk and (payload.get(uk) or "").strip():
                row = svc.find_by_unique(db, view, pk, uk, payload[uk], org_scope)
            elif cfg["path"] == "employees":
                row = svc.find_latest_by(db, view, pk, {
                    "org_id": org_scope, "employee_name": (payload.get("employee_name") or "").strip()})
            if row:
                resp["id"] = row.get(pk)
                resp["row"] = row
        except Exception:
            pass
        return resp

    @r.put("/{item_id}")
    def update(item_id: int, request: Request, body: dict = Body(...), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
        payload = {**body, pk: item_id, "modified_by": body.get("modified_by", 1)}
        if stamps_org and not ctx.get("is_super"):
            payload["org_id"] = ctx.get("org_id")
        svc.call_sp(db, cfg["sp_update"], payload, _ctx(request))
        return {"status": "success", "message": f"{cfg['title']} updated successfully"}

    @r.delete("/{item_id}")
    def delete(item_id: int, request: Request, db: Session = Depends(get_db)):
        svc.call_sp(db, cfg["sp_delete"], {pk: item_id, "deleted_by": 1}, _ctx(request))
        return {"status": "success", "message": f"{cfg['title']} deleted successfully"}

    return r


admin_crud_routers = [make_router(c) for c in ENTITIES]

# ── read-only lookup: status_master (for status dropdowns) ──
status_router = APIRouter(prefix="/api/v1/admin/statuses", tags=["Admin - Statuses"])


@status_router.get("")
def list_statuses(db: Session = Depends(get_db)):
    rows = db.execute(text(
        "SELECT status_id, status_code, status_name FROM status_master WHERE is_active = true ORDER BY status_id"
    )).mappings().all()
    return {"data": [dict(r) for r in rows]}


admin_crud_routers.append(status_router)

# ── read-only: audit log (Phase 3) ──
audit_router = APIRouter(prefix="/api/v1/admin/audit-logs", tags=["Admin - Audit Logs"])


@audit_router.get("")
def list_audit(limit: int = 300, table_name: str = None, db: Session = Depends(get_db)):
    sql = "SELECT * FROM vw_audit_log"
    params = {"l": limit}
    if table_name:
        sql += " WHERE table_name = :t"
        params["t"] = table_name
    sql += " ORDER BY audit_id DESC LIMIT :l"
    rows = db.execute(text(sql), params).mappings().all()
    return {"data": [dict(r) for r in rows]}


admin_crud_routers.append(audit_router)


# ── read-only security logs (Phase 4) ──
def _readonly_list_router(path: str, view: str, order_pk: str, title: str, limit_default: int = 300):
    rr = APIRouter(prefix=f"/api/v1/admin/{path}", tags=[f"Admin - {title}"])

    @rr.get("")
    def _list(limit: int = limit_default, db: Session = Depends(get_db)):
        rows = db.execute(text(f"SELECT * FROM {view} ORDER BY {order_pk} DESC LIMIT :l"),
                          {"l": limit}).mappings().all()
        return {"data": [dict(r) for r in rows]}

    return rr


admin_crud_routers.append(_readonly_list_router("login-history", "vw_login_history", "login_history_id", "Login History"))
admin_crud_routers.append(_readonly_list_router("user-sessions", "vw_user_session", "session_id", "User Sessions"))
admin_crud_routers.append(_readonly_list_router("password-history", "vw_password_history", "password_history_id", "Password History"))


# ── Group Role Page Permission (real CRUD on group_role_page_permission) ──
rp_router = APIRouter(prefix="/api/v1/admin/role-permissions", tags=["Admin - Role Permissions"])


@rp_router.get("")
def list_role_permissions(org_id: int, role_id: Optional[int] = None, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    if not ctx.get("is_super"):
        org_id = ctx.get("org_id")  # org admins can only inspect their own org's permissions
    sql = "SELECT * FROM vw_role_page_permission WHERE org_id = :o"
    params = {"o": org_id}
    if role_id is not None:
        sql += " AND role_id = :r"
        params["r"] = role_id
    sql += " ORDER BY role_id, page_id"
    rows = db.execute(text(sql), params).mappings().all()
    return {"data": [dict(r) for r in rows]}


def _guard_not_own_role(ctx: dict, org_id, role_id):
    """Forbid anyone from editing the permissions of the role they are logged in with
    (prevents self privilege-escalation)."""
    if (ctx.get("role_id") is not None
            and int(role_id) == int(ctx["role_id"])
            and int(org_id) == int(ctx.get("org_id") or -1)):
        raise HTTPException(status_code=403, detail="You cannot change the permissions of your own role.")


def _grpp_org_role(db: Session, page_permission_id: int):
    row = db.execute(text(
        "SELECT org_id, role_id FROM group_role_page_permission WHERE page_permission_id = :i"
    ), {"i": page_permission_id}).mappings().first()
    return (row["org_id"], row["role_id"]) if row else (None, None)


@rp_router.post("")
def create_role_permission(request: Request, body: dict = Body(...), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    _guard_not_own_role(ctx, body.get("org_id", 1), body.get("role_id"))
    svc.call_sp(db, "sp_insertrolepermission", {**body, "created_by": body.get("created_by", 1)}, _ctx(request))
    return {"status": "success", "message": "Permission assigned successfully"}


@rp_router.put("/{item_id}")
def update_role_permission(item_id: int, request: Request, body: dict = Body(...), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    o, rl = _grpp_org_role(db, item_id)
    if rl is not None:
        _guard_not_own_role(ctx, o, rl)
    svc.call_sp(db, "sp_updaterolepermission", {**body, "page_permission_id": item_id, "modified_by": 1}, _ctx(request))
    return {"status": "success", "message": "Permission updated successfully"}


@rp_router.delete("/{item_id}")
def delete_role_permission(item_id: int, request: Request, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    o, rl = _grpp_org_role(db, item_id)
    if rl is not None:
        _guard_not_own_role(ctx, o, rl)
    svc.call_sp(db, "sp_deleterolepermission", {"page_permission_id": item_id, "deleted_by": 1}, _ctx(request))
    return {"status": "success", "message": "Permission removed successfully"}


admin_crud_routers.append(rp_router)


# ── Username suggestion (for auto-creating a login when an employee is added) ──
# Distinct path so it never collides with /admin/users/{id:int}.
uname_router = APIRouter(prefix="/api/v1/admin/suggest-username", tags=["Admin - User"])


@uname_router.get("")
def suggest_username(base: str = "", db: Session = Depends(get_db)):
    import re
    slug = re.sub(r"[^a-z0-9]+", "_", (base or "").strip().lower()).strip("_") or "user"
    cand, n = slug, 1
    while db.execute(
        text("SELECT 1 FROM user_master WHERE lower(user_name)=lower(:u) AND deleted_at IS NULL"),
        {"u": cand},
    ).first():
        n += 1
        cand = f"{slug}{n}"
    return {"username": cand}


admin_crud_routers.append(uname_router)
