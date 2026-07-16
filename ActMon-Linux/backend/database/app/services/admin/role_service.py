"""
Role service — Access Control / Administration.

Reads  → view  vw_role          (joins org name, excludes soft-deleted)
Writes → stored procedures       sp_insertrole / sp_updaterole / sp_deleterole
                                 (JSONB param, same convention as department)
No inline write SQL; procedures own all validation + soft-delete.
"""
import json

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session


# ─────────────────────────── reads ───────────────────────────
def list_roles(db: Session, org_id: int | None = None) -> list[dict]:
    if org_id is not None:
        rows = db.execute(text(
            "SELECT * FROM vw_role WHERE org_id = :o ORDER BY role_name"
        ), {"o": org_id}).mappings().all()
    else:
        rows = db.execute(text(
            "SELECT * FROM vw_role ORDER BY org_id, role_name"
        )).mappings().all()
    return [dict(r) for r in rows]


def get_role(db: Session, role_id: int) -> dict:
    row = db.execute(text("SELECT * FROM vw_role WHERE role_id = :i"),
                     {"i": role_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Role not found")
    return dict(row)


# ─────────────────────── writes (via SPs) ───────────────────────
def _call(db: Session, proc: str, payload: dict) -> None:
    """CALL a JSONB stored procedure; surface its RAISE EXCEPTION message as 400."""
    try:
        db.execute(text(f"CALL {proc}(CAST(:j AS jsonb))"),
                   {"j": json.dumps(payload, default=str)})
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        diag = getattr(getattr(e, "orig", None), "diag", None)
        detail = getattr(diag, "message_primary", None) if diag else None
        raise HTTPException(status_code=400, detail=detail or "Operation failed")


def create_role(db: Session, data: dict, created_by: int = 1) -> dict:
    _call(db, "sp_insertrole", {
        "org_id": data.get("org_id") or 1,
        "role_name": data.get("role_name"),
        "role_description": data.get("role_description"),
        "created_by": created_by,
    })
    return {"status": "success", "message": "Role created successfully"}


def update_role(db: Session, role_id: int, data: dict, modified_by: int = 1) -> dict:
    _call(db, "sp_updaterole", {
        "role_id": role_id,
        "org_id": data.get("org_id"),
        "role_name": data.get("role_name"),
        "role_description": data.get("role_description"),
        "is_active": data.get("is_active", True),
        "modified_by": modified_by,
    })
    return {"status": "success", "message": "Role updated successfully"}


def delete_role(db: Session, role_id: int, deleted_by: int = 1) -> dict:
    _call(db, "sp_deleterole", {"role_id": role_id, "deleted_by": deleted_by})
    return {"status": "success", "message": "Role deleted successfully"}
