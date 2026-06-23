from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import OracleConnectionCreate
from app.services.oracle import oracle_connection_service
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id

router = APIRouter(
    prefix="/api/v1/connections/oracle",
    tags=["Oracle"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/")
def list_oracle_connections(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_connection_service.list_connections(db, scope_org_id(ctx))


@router.post("/")
def create_oracle_connection(request: OracleConnectionCreate, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_connection_service.create_connection(request, db, create_org_id(ctx))


@router.get("/{connection_id}")
def get_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    return oracle_connection_service.get_connection(connection_id, db)


@router.put("/{connection_id}")
def update_oracle_connection(connection_id: int, request: OracleConnectionCreate, db: Session = Depends(get_db)):
    return oracle_connection_service.update_connection(connection_id, request, db)


@router.delete("/{connection_id}")
def delete_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    return oracle_connection_service.delete_connection(connection_id, db)


@router.post("/{connection_id}/test")
def test_oracle_connection(connection_id: int, db: Session = Depends(get_db)):
    return oracle_connection_service.test_connection(connection_id, db)
