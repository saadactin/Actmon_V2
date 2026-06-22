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

from fastapi import APIRouter, Body, Depends, Request
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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


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
     "order": "employee_id", "org_scoped": True,
     "sp_insert": "sp_insertemployee", "sp_update": "sp_updateemployee", "sp_delete": "sp_deleteemployee"},
    {"path": "users", "title": "User", "view": "vw_user", "pk": "user_id",
     "order": "user_id", "org_scoped": True,
     "sp_insert": "sp_insertuser", "sp_update": "sp_updateuser", "sp_delete": "sp_deleteuser"},
]


def make_router(cfg: dict) -> APIRouter:
    r = APIRouter(prefix=f"/api/v1/admin/{cfg['path']}", tags=[f"Admin - {cfg['title']}"])
    pk, view, order = cfg["pk"], cfg["view"], cfg["order"]

    @r.get("")
    def list_all(org_id: Optional[int] = None, db: Session = Depends(get_db)):
        scope = org_id if cfg["org_scoped"] else None
        return {"data": svc.list_rows(db, view, order, scope)}

    @r.get("/{item_id}")
    def get_one(item_id: int, db: Session = Depends(get_db)):
        return svc.get_row(db, view, pk, item_id)

    @r.post("")
    def create(request: Request, body: dict = Body(...), db: Session = Depends(get_db)):
        svc.call_sp(db, cfg["sp_insert"], {**body, "created_by": body.get("created_by", 1)}, _ctx(request))
        return {"status": "success", "message": f"{cfg['title']} created successfully"}

    @r.put("/{item_id}")
    def update(item_id: int, request: Request, body: dict = Body(...), db: Session = Depends(get_db)):
        svc.call_sp(db, cfg["sp_update"], {**body, pk: item_id, "modified_by": body.get("modified_by", 1)}, _ctx(request))
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
