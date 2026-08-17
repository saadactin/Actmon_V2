"""
Generic connection management — update a registered DB connection in place.
`connection_master` is a single shared table across all engines, so one
PUT endpoint covers every technology (mysql/postgresql/mongodb/...).
"""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_model import ConnectionMaster
from app.services.common.credential_encryption_service import credential_encryption

router = APIRouter(prefix="/api/v1/connections", tags=["Connections"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ConnectionUpdate(BaseModel):
    connection_name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None          # only applied when non-empty
    database_name: Optional[str] = None
    environment: Optional[str] = None


@router.put("/{db_type}/{conn_id}")
def update_connection(db_type: str, conn_id: int, body: ConnectionUpdate, db: Session = Depends(get_db)):
    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == conn_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    data = body.dict(exclude_unset=True)
    if credential_encryption.looks_like_mask(data.get("password")):
        data.pop("password", None)          # blank OR a mask placeholder — never overwrite the stored password

    for field, value in data.items():
        if hasattr(conn, field):
            setattr(conn, field, value)

    db.commit()
    db.refresh(conn)
    return {"status": "success", "id": conn.id, "connection_name": conn.connection_name}
