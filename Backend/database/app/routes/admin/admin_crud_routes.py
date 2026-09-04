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


def _blanks_to_null(d: dict) -> dict:
    """Empty-string form fields → NULL, so optional integer/FK columns (e.g.
    reporting_manager_id) don't hit 'invalid input syntax for type integer: ""'."""
    return {k: (None if isinstance(v, str) and v.strip() == "" else v) for k, v in d.items()}


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
        payload = _blanks_to_null({**body, "created_by": body.get("created_by", 1)})
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
        payload = _blanks_to_null({**body, pk: item_id, "modified_by": body.get("modified_by", 1)})
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
def list_audit(limit: int = 300, offset: int = 0, table_name: str = None, db: Session = Depends(get_db)):
    # audit_log grows forever — previously this only ever returned the newest
    # `limit` rows with no way to reach anything older, while the frontend's
    # own page-2/3/... controls silently re-sliced that same fixed set
    # instead of asking the database for more. `offset` (+ `total`, so the
    # UI can compute a real page count) makes "next page" actually work.
    where = " WHERE table_name = :t" if table_name else ""
    params = {"l": limit, "o": offset}
    if table_name:
        params["t"] = table_name
    rows = db.execute(
        text(f"SELECT * FROM vw_audit_log{where} ORDER BY audit_id DESC LIMIT :l OFFSET :o"), params,
    ).mappings().all()
    total = db.execute(text(f"SELECT COUNT(*) FROM vw_audit_log{where}"), params).scalar()
    return {"data": [dict(r) for r in rows], "total": total}


admin_crud_routers.append(audit_router)


# ── read-only security logs (Phase 4) ──
def _readonly_list_router(path: str, view: str, order_pk: str, title: str, limit_default: int = 300):
    rr = APIRouter(prefix=f"/api/v1/admin/{path}", tags=[f"Admin - {title}"])

    @rr.get("")
    def _list(limit: int = limit_default, offset: int = 0, db: Session = Depends(get_db)):
        # Same fix as list_audit() above: these views grow forever (every
        # login, every session, every password change) and previously had no
        # offset at all — "page 2" in the UI just re-sliced the same fixed
        # `limit` rows already in memory instead of ever reaching older ones.
        rows = db.execute(text(f"SELECT * FROM {view} ORDER BY {order_pk} DESC LIMIT :l OFFSET :o"),
                          {"l": limit, "o": offset}).mappings().all()
        total = db.execute(text(f"SELECT COUNT(*) FROM {view}")).scalar()
        return {"data": [dict(r) for r in rows], "total": total}

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


@rp_router.post("/clone")
def clone_role_permissions(request: Request, body: dict = Body(...), db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    """Copy all page permissions from one role to another (same org).
    body: { org_id, source_role_id, target_role_id, mode: 'merge'|'replace' }
      - merge   : add/overwrite the target's grants with the source's (keeps extras)
      - replace : make the target's grants an exact copy of the source's
    """
    org = int(body.get("org_id") or ctx.get("org_id") or 1)
    if not ctx.get("is_super"):
        org = int(ctx.get("org_id") or org)          # org admins scoped to their org
    try:
        source = int(body["source_role_id"]); target = int(body["target_role_id"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="source_role_id and target_role_id are required.")
    if source == target:
        raise HTTPException(status_code=400, detail="Source and target roles must be different.")
    mode = (body.get("mode") or "merge").lower()
    _guard_not_own_role(ctx, org, target)            # never let a user re-grant their own role

    src = db.execute(text(
        "SELECT page_id, permission FROM group_role_page_permission "
        "WHERE role_id=:s AND org_id=:o AND deleted_at IS NULL AND COALESCE(is_active, TRUE)=TRUE"),
        {"s": source, "o": org}).mappings().all()

    if mode == "replace":
        db.execute(text("DELETE FROM group_role_page_permission WHERE role_id=:t AND org_id=:o"), {"t": target, "o": org})

    copied = 0
    for g in src:
        upd = db.execute(text(
            "UPDATE group_role_page_permission SET permission=:p, is_active=TRUE, modified_by=1, modified_at=now() "
            "WHERE role_id=:t AND org_id=:o AND page_id=:pg AND deleted_at IS NULL"),
            {"p": g["permission"], "t": target, "o": org, "pg": g["page_id"]})
        if (upd.rowcount or 0) == 0:
            db.execute(text(
                "INSERT INTO group_role_page_permission (org_id, role_id, page_id, permission, is_active, created_by, created_at) "
                "VALUES (:o, :t, :pg, :p, TRUE, 1, now())"),
                {"o": org, "t": target, "pg": g["page_id"], "p": g["permission"]})
        copied += 1

    db.commit()
    return {"status": "success", "copied": copied, "mode": mode,
            "message": f"Copied {copied} permission(s) to the target role."}


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
