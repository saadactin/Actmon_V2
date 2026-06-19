from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.models.os_server_model import OsServer, DatabaseInstance
from app.models.connection_model import ConnectionMaster

router = APIRouter(
    prefix="/api/servers",
    tags=["Servers (Legacy)"]
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("")
def get_servers(db: Session = Depends(get_db)):
    servers = db.query(OsServer).order_by(OsServer.server_name).all()
    return [
        {
            "server_id": s.id,
            "server_name": s.server_name,
            "hostname": s.hostname,
            "ip_address": s.ip_address,
            "os_type": s.os_type,
            "environment": s.environment,
            "status": s.status,
        }
        for s in servers
    ]


@router.get("/{server_id}")
def get_server_details(server_id: int, db: Session = Depends(get_db)):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    cluster_siblings = []
    if server.cluster_name:
        siblings = db.query(OsServer).filter(
            OsServer.cluster_name == server.cluster_name,
            OsServer.id != server_id,
        ).all()
        cluster_siblings = [
            {"server_id": s.id, "server_name": s.server_name, "node_role": s.node_type, "status": s.status}
            for s in siblings
        ]

    return {
        "server_id": server.id,
        "server_name": server.server_name,
        "hostname": server.hostname,
        "ip_address": server.ip_address,
        "os_type": server.os_type,
        "environment": server.environment,
        "status": server.status,
        "group_name": server.cluster_name,
        "group_type": "Cluster" if server.cluster_name else "Standalone",
        "node_role": server.node_type,
        "cluster_siblings": cluster_siblings,
    }


@router.get("/{server_id}/databases")
def get_server_databases(server_id: int, db: Session = Depends(get_db)):
    instances = db.query(DatabaseInstance).filter(
        DatabaseInstance.server_id == server_id
    ).all()

    result = []
    for inst in instances:
        conn_info = None
        if inst.connection_id:
            conn = db.query(ConnectionMaster).filter(
                ConnectionMaster.id == inst.connection_id
            ).first()
            if conn:
                conn_info = {
                    "id": conn.id,
                    "connection_name": conn.connection_name,
                    "host": conn.host,
                    "port": conn.port,
                    "database_name": conn.database_name,
                }
        result.append({
            "database_instance_id": inst.id,
            "instance_name": f"{inst.db_type} on {inst.port}",
            "db_engine": inst.db_type,
            "version": inst.db_version,
            "connection_name": conn_info["connection_name"] if conn_info else None,
            "host": conn_info["host"] if conn_info else None,
            "port": inst.port,
            "database_name": conn_info["database_name"] if conn_info else None,
            "connection_id": inst.connection_id,
            "status": inst.status,
        })

    return result
