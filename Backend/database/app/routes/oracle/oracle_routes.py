from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.connection_schema import OracleConnectionCreate
from app.services.oracle import oracle_connection_service, oracle_topology_service
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


# ── Topology: deployment-type selection + Data Guard peer links ──
# (RAC needs none of this — GV$INSTANCE discovers RAC nodes from the one
# connection already registered; see oracle_monitoring_routes.py's
# /oracle-topology and /oracle-rac-nodes endpoints.)

class DeploymentTypeUpdate(BaseModel):
    deployment_type: str  # standalone | rac | data_guard | rac_dg
    role: str = None  # primary | standby | farsync | unknown — Data Guard side, if applicable


class PeerLinkCreate(BaseModel):
    peer_connection_id: int
    link_type: str = "standby"  # standby | far_sync | cascaded_standby


@router.put("/{connection_id}/deployment-type")
def set_oracle_deployment_type(connection_id: int, body: DeploymentTypeUpdate, db: Session = Depends(get_db)):
    return oracle_topology_service.set_deployment_type(connection_id, body.deployment_type, db, role=body.role)


@router.get("/{connection_id}/topology/peers")
def list_oracle_topology_peers(connection_id: int, db: Session = Depends(get_db)):
    return oracle_topology_service.list_peers(connection_id, db)


@router.post("/{connection_id}/topology/peers")
def add_oracle_topology_peer(connection_id: int, body: PeerLinkCreate, db: Session = Depends(get_db)):
    return oracle_topology_service.link_peer(connection_id, body.peer_connection_id, body.link_type, db)


@router.delete("/topology/peers/{link_id}")
def remove_oracle_topology_peer(link_id: int, db: Session = Depends(get_db)):
    return oracle_topology_service.unlink_peer(link_id, db)
