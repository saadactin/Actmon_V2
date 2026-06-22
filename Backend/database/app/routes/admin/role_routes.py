"""
Role routes — Access Control / Administration.
  GET    /api/v1/admin/roles            list (optional ?org_id=)
  GET    /api/v1/admin/roles/{id}       get by id
  POST   /api/v1/admin/roles            create   (sp_insertrole)
  PUT    /api/v1/admin/roles/{id}       update   (sp_updaterole)
  DELETE /api/v1/admin/roles/{id}       soft delete (sp_deleterole)
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.admin import role_service as svc

router = APIRouter(prefix="/api/v1/admin/roles", tags=["Admin - Roles"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class RoleIn(BaseModel):
    org_id: Optional[int] = None
    role_name: str
    role_description: Optional[str] = None
    is_active: Optional[bool] = True


@router.get("")
def list_roles(org_id: Optional[int] = None, db: Session = Depends(get_db)):
    return {"data": svc.list_roles(db, org_id)}


@router.get("/{role_id}")
def get_role(role_id: int, db: Session = Depends(get_db)):
    return svc.get_role(db, role_id)


@router.post("")
def create_role(body: RoleIn, db: Session = Depends(get_db)):
    return svc.create_role(db, body.dict())


@router.put("/{role_id}")
def update_role(role_id: int, body: RoleIn, db: Session = Depends(get_db)):
    return svc.update_role(db, role_id, body.dict())


@router.delete("/{role_id}")
def delete_role(role_id: int, db: Session = Depends(get_db)):
    return svc.delete_role(db, role_id)
