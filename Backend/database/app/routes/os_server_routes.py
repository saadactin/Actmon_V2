from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import Optional, List
from pydantic import BaseModel
import paramiko
import socket

from app.database.connection import SessionLocal
from app.models.os_server_model import OsServer, DatabaseInstance
from app.models.connection_model import ConnectionMaster

router = APIRouter(
    prefix="/api/v1/os-servers",
    tags=["OS Servers"]
)

DEFAULT_PORTS = {
    "MySQL": 3306,
    "PostgreSQL": 5432,
    "Oracle": 1521,
    "MongoDB": 27017,
    "MSSQL": 1433,
    "ClickHouse": 9000,
}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ==========================================
# PYDANTIC SCHEMAS
# ==========================================

class DbInstanceIn(BaseModel):
    db_type: str
    db_version: Optional[str] = None
    port: Optional[int] = None
    connection_id: Optional[int] = None


class OsServerCreate(BaseModel):
    server_name: str
    hostname: Optional[str] = None
    ip_address: str
    os_type: Optional[str] = "Linux"
    environment: Optional[str] = "Production"
    node_type: Optional[str] = "Standalone"
    cluster_name: Optional[str] = None
    ssh_port: Optional[int] = 22
    ssh_username: Optional[str] = None
    ssh_password: Optional[str] = None
    database_services: Optional[List[str]] = []
    monitoring_enabled: Optional[bool] = True
    auto_discovery: Optional[bool] = True
    db_instances: Optional[List[DbInstanceIn]] = []


class OsServerUpdate(BaseModel):
    server_name: Optional[str] = None
    hostname: Optional[str] = None
    ip_address: Optional[str] = None
    os_type: Optional[str] = None
    environment: Optional[str] = None
    node_type: Optional[str] = None
    cluster_name: Optional[str] = None
    ssh_port: Optional[int] = None
    ssh_username: Optional[str] = None
    ssh_password: Optional[str] = None
    database_services: Optional[List[str]] = None
    monitoring_enabled: Optional[bool] = None
    auto_discovery: Optional[bool] = None


class SshTestRequest(BaseModel):
    ip_address: str
    ssh_port: int = 22
    ssh_username: str
    ssh_password: str


# ==========================================
# GET SUMMARY / KPIs
# ==========================================

@router.get("/summary")
def get_summary(db: Session = Depends(get_db)):
    total = db.query(func.count(OsServer.id)).scalar() or 0
    connected = db.query(func.count(OsServer.id)).filter(OsServer.status == "Connected").scalar() or 0
    warning = db.query(func.count(OsServer.id)).filter(OsServer.status == "Warning").scalar() or 0
    disconnected = db.query(func.count(OsServer.id)).filter(OsServer.status == "Disconnected").scalar() or 0

    clusters = db.query(OsServer.cluster_name).filter(
        OsServer.cluster_name.isnot(None),
        OsServer.cluster_name != ""
    ).distinct().count()

    return {
        "total": total,
        "connected": connected,
        "warning": warning,
        "disconnected": disconnected,
        "clusters": clusters,
    }


# ==========================================
# LIST ALL OS SERVERS
# ==========================================

@router.get("/")
def list_os_servers(
    environment: Optional[str] = None,
    os_type: Optional[str] = None,
    db: Session = Depends(get_db),
):
    query = db.query(OsServer)

    if environment and environment not in ("All", "all"):
        query = query.filter(OsServer.environment == environment)
    if os_type and os_type not in ("All OS", "All", "all"):
        query = query.filter(OsServer.os_type == os_type)

    servers = query.order_by(OsServer.server_name).all()

    result = []
    for s in servers:
        result.append({
            "id": s.id,
            "server_name": s.server_name,
            "hostname": s.hostname,
            "ip_address": s.ip_address,
            "os_type": s.os_type,
            "environment": s.environment,
            "node_type": s.node_type,
            "cluster_name": s.cluster_name,
            "ssh_port": s.ssh_port,
            "ssh_username": s.ssh_username,
            "database_services": s.database_services or [],
            "status": s.status,
            "cpu_usage": s.cpu_usage,
            "ram_usage": s.ram_usage,
            "disk_usage": s.disk_usage,
            "uptime": s.uptime,
            "monitoring_enabled": s.monitoring_enabled,
            "auto_discovery": s.auto_discovery,
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "db_instances_count": len(s.db_instances),
        })

    return {"status": "success", "data": result}


# ==========================================
# GET SINGLE SERVER WITH FULL DETAILS
# ==========================================

@router.get("/{server_id}")
def get_os_server(server_id: int, db: Session = Depends(get_db)):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    instances = []
    for inst in server.db_instances:
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
        instances.append({
            "id": inst.id,
            "db_type": inst.db_type,
            "db_version": inst.db_version,
            "port": inst.port,
            "status": inst.status,
            "connection_id": inst.connection_id,
            "connection": conn_info,
        })

    # Cluster siblings
    cluster_siblings = []
    if server.cluster_name:
        siblings = db.query(OsServer).filter(
            OsServer.cluster_name == server.cluster_name,
            OsServer.id != server_id,
        ).all()
        for sib in siblings:
            cluster_siblings.append({
                "id": sib.id,
                "server_name": sib.server_name,
                "ip_address": sib.ip_address,
                "node_type": sib.node_type,
                "status": sib.status,
            })

    return {
        "status": "success",
        "data": {
            "id": server.id,
            "server_name": server.server_name,
            "hostname": server.hostname,
            "ip_address": server.ip_address,
            "os_type": server.os_type,
            "environment": server.environment,
            "node_type": server.node_type,
            "cluster_name": server.cluster_name,
            "ssh_port": server.ssh_port,
            "ssh_username": server.ssh_username,
            "database_services": server.database_services or [],
            "status": server.status,
            "cpu_usage": server.cpu_usage,
            "ram_usage": server.ram_usage,
            "disk_usage": server.disk_usage,
            "uptime": server.uptime,
            "monitoring_enabled": server.monitoring_enabled,
            "auto_discovery": server.auto_discovery,
            "created_at": server.created_at.isoformat() if server.created_at else None,
            "db_instances": instances,
            "cluster_siblings": cluster_siblings,
        },
    }


# ==========================================
# CREATE OS SERVER
# ==========================================

@router.post("/")
def create_os_server(request: OsServerCreate, db: Session = Depends(get_db)):
    server = OsServer(
        server_name=request.server_name,
        hostname=request.hostname or request.ip_address,
        ip_address=request.ip_address,
        os_type=request.os_type,
        environment=request.environment,
        node_type=request.node_type,
        cluster_name=request.cluster_name,
        ssh_port=request.ssh_port,
        ssh_username=request.ssh_username,
        ssh_password=request.ssh_password,
        database_services=request.database_services,
        monitoring_enabled=request.monitoring_enabled,
        auto_discovery=request.auto_discovery,
        status="Unknown",
    )

    db.add(server)
    db.flush()

    # Auto-create a DatabaseInstance for every selected database service
    created_types = set()
    for svc in (request.database_services or []):
        if svc not in created_types:
            db.add(DatabaseInstance(
                server_id=server.id,
                db_type=svc,
                port=DEFAULT_PORTS.get(svc, 0),
                status="Unknown",
            ))
            created_types.add(svc)

    # Also add explicitly provided instances
    for inst_data in (request.db_instances or []):
        if inst_data.db_type not in created_types:
            db.add(DatabaseInstance(
                server_id=server.id,
                db_type=inst_data.db_type,
                db_version=inst_data.db_version,
                port=inst_data.port or DEFAULT_PORTS.get(inst_data.db_type, 0),
                connection_id=inst_data.connection_id,
                status="Unknown",
            ))

    db.commit()
    db.refresh(server)

    return {
        "status": "success",
        "message": "OS Server registered successfully",
        "data": {"id": server.id, "server_name": server.server_name},
    }


# ==========================================
# UPDATE OS SERVER
# ==========================================

@router.put("/{server_id}")
def update_os_server(
    server_id: int,
    request: OsServerUpdate,
    db: Session = Depends(get_db),
):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    for field, value in request.dict(exclude_unset=True).items():
        setattr(server, field, value)

    db.commit()
    db.refresh(server)

    return {"status": "success", "message": "Server updated"}


# ==========================================
# DELETE OS SERVER
# ==========================================

@router.delete("/{server_id}")
def delete_os_server(server_id: int, db: Session = Depends(get_db)):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    db.delete(server)
    db.commit()

    return {"status": "success", "message": "Server deleted"}


# ==========================================
# TEST SSH CONNECTION
# ==========================================

@router.post("/test-ssh")
def test_ssh(request: SshTestRequest):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=request.ip_address,
            port=request.ssh_port,
            username=request.ssh_username,
            password=request.ssh_password,
            timeout=10,
        )
        _, out, _ = ssh.exec_command("echo ACTMON_OK")
        output = out.read().decode().strip()
        ssh.close()

        return {
            "status": "success",
            "message": "SSH Connection Successful",
            "output": output,
        }
    except paramiko.AuthenticationException:
        raise HTTPException(status_code=400, detail="SSH Authentication Failed — check username/password")
    except (socket.timeout, TimeoutError):
        raise HTTPException(
            status_code=400,
            detail=f"Connection Timeout — cannot reach {request.ip_address}:{request.ssh_port}",
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"SSH Connection Failed: {str(e)}")


# ==========================================
# REFRESH SERVER STATUS via SSH
# ==========================================

@router.post("/{server_id}/refresh")
def refresh_server(server_id: int, db: Session = Depends(get_db)):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if not server.ssh_username or not server.ssh_password:
        raise HTTPException(status_code=400, detail="SSH credentials not configured")

    metrics = {}
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            hostname=server.ip_address,
            port=server.ssh_port or 22,
            username=server.ssh_username,
            password=server.ssh_password,
            timeout=10,
        )

        def run(cmd):
            try:
                _, out, _ = ssh.exec_command(cmd, timeout=5)
                return out.read().decode("utf-8", errors="replace").strip()
            except Exception:
                return "N/A"

        cpu_raw = run("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'")
        metrics["cpu_usage"] = f"{cpu_raw}%" if cpu_raw not in ("N/A", "") else "N/A"

        ram_raw = run("free -m | awk 'NR==2{printf \"%.0f\", $3*100/$2}'")
        metrics["ram_usage"] = f"{ram_raw}%" if ram_raw not in ("N/A", "") else "N/A"

        disk_raw = run("df -h / | awk 'NR==2{print $5}'")
        metrics["disk_usage"] = disk_raw if disk_raw not in ("N/A", "") else "N/A"

        uptime_raw = run("uptime -p 2>/dev/null || uptime")
        metrics["uptime"] = uptime_raw if uptime_raw else "N/A"

        # Detect running DB services
        running_dbs = {}
        db_check_cmds = {
            "MySQL": "systemctl is-active mysql 2>/dev/null || systemctl is-active mysqld 2>/dev/null || echo inactive",
            "PostgreSQL": "systemctl is-active postgresql 2>/dev/null || echo inactive",
            "MongoDB": "systemctl is-active mongod 2>/dev/null || echo inactive",
            "MSSQL": "systemctl is-active mssql-server 2>/dev/null || echo inactive",
        }
        for db_svc, cmd in db_check_cmds.items():
            result = run(cmd)
            running_dbs[db_svc] = "active" in result.lower()

        ssh.close()

        # Update DB instance statuses
        for inst in server.db_instances:
            if inst.db_type in running_dbs:
                inst.status = "Running" if running_dbs[inst.db_type] else "Stopped"

        server.status = "Connected"
        server.cpu_usage = metrics.get("cpu_usage")
        server.ram_usage = metrics.get("ram_usage")
        server.disk_usage = metrics.get("disk_usage")
        server.uptime = metrics.get("uptime")
        db.commit()

        return {"status": "success", "message": "Server refreshed", "metrics": metrics, "running_dbs": running_dbs}

    except Exception as e:
        server.status = "Disconnected"
        db.commit()
        return {"status": "warning", "message": f"Could not connect: {str(e)}", "server_status": "Disconnected"}


# ==========================================
# LINK A DB INSTANCE TO A CONNECTION
# ==========================================

@router.post("/{server_id}/instances/{instance_id}/link")
def link_instance_to_connection(
    server_id: int,
    instance_id: int,
    connection_id: int,
    db: Session = Depends(get_db),
):
    inst = db.query(DatabaseInstance).filter(
        DatabaseInstance.id == instance_id,
        DatabaseInstance.server_id == server_id,
    ).first()

    if not inst:
        raise HTTPException(status_code=404, detail="Instance not found")

    conn = db.query(ConnectionMaster).filter(ConnectionMaster.id == connection_id).first()
    if not conn:
        raise HTTPException(status_code=404, detail="Connection not found")

    inst.connection_id = connection_id
    inst.db_version = f"{conn.db_type or inst.db_type}"
    db.commit()

    return {"status": "success", "message": "Instance linked to connection"}
