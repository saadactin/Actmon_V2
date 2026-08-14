import concurrent.futures
import socket
from datetime import datetime
from typing import List, Optional

import paramiko
from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.connection_model import ConnectionMaster
from app.models.os_server_model import DatabaseInstance, OsServer

DEFAULT_PORTS = {
    "MySQL": 3306,
    "MariaDB": 3306,
    "PostgreSQL": 5432,
    "Oracle": 1521,
    "MongoDB": 27017,
    "MSSQL": 1433,
    "ClickHouse": 9000,
}


# ── Pydantic models ───────────────────────────────────────────────────────────

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
    collector: Optional[str] = "ssh"   # 'ssh' or 'agent'


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


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pct_to_float(raw) -> Optional[float]:
    """'12%' -> 12.0, 'N/A'/None/'' -> None. Metrics here are collected as
    formatted strings (see svc_refresh_server) but AgentMetric's host_cpu/
    host_memory/host_disk columns are Float — same conversion the agent-push
    path does inline, pulled out since SSH needs it for three fields at once."""
    if not raw or raw == "N/A":
        return None
    try:
        return float(str(raw).rstrip("%"))
    except ValueError:
        return None


def _tcp_check(ip: str, port: int, timeout: float = 3.0) -> bool:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        result = s.connect_ex((ip, port))
        s.close()
        return result == 0
    except Exception:
        return False


def _db_status_summary(instances) -> str:
    statuses = [i.status for i in instances]
    if not statuses:
        return "Unknown"
    if all(s == "Running" for s in statuses):
        return "Running"
    if any(s == "Running" for s in statuses):
        return "Degraded"
    if any(s == "Stopped" for s in statuses):
        return "Stopped"
    return "Unknown"


# ── Service functions ─────────────────────────────────────────────────────────

def svc_get_live_status(db: Session, org_id: Optional[int] = None):
    q = db.query(OsServer)
    if org_id is not None:
        q = q.filter(OsServer.org_id == org_id)
    all_servers = q.all()

    # ── Live truth for AGENT-collected databases ──────────────────────────────
    # The ActMon server cannot TCP-probe a DB on an agent host's localhost, so DB
    # health for those comes straight from the collector's own result: agents.status
    # per linked connection ('online' => the collector connected => Running; 'error'/
    # 'offline' => it could NOT connect => Stopped). This is what stops the Servers
    # page from claiming "DB Running" while the service is actually dead.
    conn_status: dict = {}
    try:
        for cid, st in db.execute(text(
            "SELECT db_connection_id, status FROM agents WHERE db_connection_id IS NOT NULL"
        )).all():
            if cid is None:
                continue
            cid = int(cid)
            st = (st or "").lower()
            # db_connection_id has no unique constraint, so a stale/duplicate agent
            # row (e.g. a leftover row re-pointed at a connection another agent
            # already owns) can share a connection with a live, online one. Which
            # row this unordered scan sees last is arbitrary, so an "online" must
            # never be clobbered by an "offline"/"error" from a different row —
            # that clobbering is exactly what made the Databases page show a
            # connection as Stopped while its real agent was Online.
            if conn_status.get(cid) != "online":
                conn_status[cid] = st
    except Exception:  # noqa: BLE001
        pass

    def _agent_os_up(s) -> bool:
        # Host agent heartbeat maintained by ingest/reaper; treat non-down as up.
        return (s.status or "").lower() not in ("disconnected", "offline", "stopped", "error")

    def check_one(s):
        is_agent = (s.collector or "ssh") == "agent"

        if is_agent:
            os_up = _agent_os_up(s)
        else:
            os_up = _tcp_check(s.ip_address, s.ssh_port or 22, timeout=2.0)
        os_status = "Connected" if os_up else "Disconnected"

        db_results: dict = {}

        # RULE: if the OS/host is down, every database on it is down too — never
        # report a DB as Running under an offline host.
        if not os_up:
            for inst in s.db_instances:
                db_results[inst.db_type] = "Stopped"
        elif is_agent:
            # Derive each DB's state from the live collector result for its connection.
            # Fall back to the collector-maintained instance status (set every cycle)
            # so we report Stopped rather than a vague "Unknown".
            for inst in s.db_instances:
                st = conn_status.get(inst.connection_id) if inst.connection_id else None
                if st == "online":
                    db_results[inst.db_type] = "Running"
                elif st in ("error", "offline"):
                    db_results[inst.db_type] = "Stopped"
                elif inst.status in ("Running", "Stopped", "Degraded"):
                    db_results[inst.db_type] = inst.status
                else:
                    db_results[inst.db_type] = "Unknown"
        else:
            # SSH host — TCP-probe each DB port from the ActMon server.
            for svc in list(s.database_services or []):
                port = DEFAULT_PORTS.get(svc)
                if not port:
                    for inst in s.db_instances:
                        if inst.db_type.lower() == svc.lower() and inst.port:
                            port = inst.port
                            break
                if port:
                    db_results[svc] = "Running" if _tcp_check(s.ip_address, port, timeout=2.0) else "Stopped"
            for inst in s.db_instances:
                if inst.db_type not in db_results and inst.port:
                    db_results[inst.db_type] = "Running" if _tcp_check(s.ip_address, inst.port, timeout=2.0) else "Stopped"

        vals = list(db_results.values())
        if vals and all(v == "Running" for v in vals):
            db_status = "Running"
        elif any(v == "Running" for v in vals):
            db_status = "Degraded"
        elif any(v == "Stopped" for v in vals):
            db_status = "Stopped"
        else:
            db_status = "Unknown"

        return {
            "id": s.id,
            "os_status": os_status,
            "db_status": db_status,
            "db_services": db_results,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as ex:
        results = list(ex.map(check_one, all_servers))

    status_map = {r["id"]: r for r in results}
    for s in all_servers:
        r = status_map.get(s.id)
        if r:
            # Persist OS status only for SSH hosts — agent-host OS status is owned by
            # the ingest/reaper path and must not be clobbered here.
            if (s.collector or "ssh") != "agent":
                s.status = r["os_status"]
            for inst in s.db_instances:
                if inst.db_type in r["db_services"]:
                    inst.status = r["db_services"][inst.db_type]
    db.commit()

    return {"status": "success", "data": results}


def svc_get_summary(db: Session, org_id: Optional[int] = None):
    def _q(*filters):
        q = db.query(func.count(OsServer.id))
        if org_id is not None:
            q = q.filter(OsServer.org_id == org_id)
        for f in filters:
            q = q.filter(f)
        return q.scalar() or 0

    total = _q()
    connected = _q(OsServer.status == "Connected")
    warning = _q(OsServer.status == "Warning")
    disconnected = _q(OsServer.status == "Disconnected")

    cq = db.query(OsServer.cluster_name).filter(
        OsServer.cluster_name.isnot(None),
        OsServer.cluster_name != ""
    )
    if org_id is not None:
        cq = cq.filter(OsServer.org_id == org_id)
    clusters = cq.distinct().count()

    return {
        "total": total,
        "connected": connected,
        "warning": warning,
        "disconnected": disconnected,
        "clusters": clusters,
    }


def svc_list_os_servers(db: Session, environment: Optional[str] = None, os_type: Optional[str] = None, org_id: Optional[int] = None):
    query = db.query(OsServer)

    if org_id is not None:
        query = query.filter(OsServer.org_id == org_id)
    if environment and environment not in ("All", "all"):
        query = query.filter(OsServer.environment == environment)
    if os_type and os_type not in ("All OS", "All", "all"):
        query = query.filter(OsServer.os_type == os_type)

    servers = query.order_by(OsServer.server_name).all()

    result = []
    for s in servers:
        inst_map = {}
        for inst in s.db_instances:
            inst_map[inst.db_type] = {
                "db_type": inst.db_type,
                "port": inst.port or DEFAULT_PORTS.get(inst.db_type),
                "status": inst.status or "Unknown",
                "connection_id": inst.connection_id,
            }

        for svc in (s.database_services or []):
            if svc not in inst_map:
                inst_map[svc] = {
                    "db_type": svc,
                    "port": DEFAULT_PORTS.get(svc),
                    "status": "Unknown",
                }

        db_instances_list = list(inst_map.values())
        db_status = _db_status_summary(s.db_instances) if s.db_instances else "Unknown"

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
            "db_status": db_status,
            "collector": s.collector or "ssh",
            "db_instances": db_instances_list,
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


def svc_get_os_server(server_id: int, db: Session, org_id: Optional[int] = None):
    q = db.query(OsServer).filter(OsServer.id == server_id)
    if org_id is not None:
        q = q.filter(OsServer.org_id == org_id)
    server = q.first()

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
            "collector": server.collector or "ssh",
            "agent_token": server.agent_token,
            "last_infra_at": server.last_infra_at.isoformat() if server.last_infra_at else None,
            "created_at": server.created_at.isoformat() if server.created_at else None,
            "db_instances": instances,
            "cluster_siblings": cluster_siblings,
        },
    }


def svc_create_os_server(request: OsServerCreate, db: Session, org_id: int = 1):
    import uuid
    collector = (request.collector or "ssh").lower()
    agent_token = f"actmon-{uuid.uuid4().hex}" if collector == "agent" else None

    server = OsServer(
        org_id=org_id,
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
        collector=collector,
        agent_token=agent_token,
    )

    db.add(server)
    db.flush()

    created_types = set()
    for svc in (request.database_services or []):
        if svc not in created_types:
            db.add(DatabaseInstance(
                org_id=org_id,
                server_id=server.id,
                db_type=svc,
                port=DEFAULT_PORTS.get(svc, 0),
                status="Unknown",
            ))
            created_types.add(svc)

    for inst_data in (request.db_instances or []):
        if inst_data.db_type not in created_types:
            db.add(DatabaseInstance(
                org_id=org_id,
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
        "data": {
            "id": server.id,
            "server_name": server.server_name,
            "collector": server.collector,
            "agent_token": server.agent_token,
        },
    }


def svc_update_os_server(server_id: int, request: OsServerUpdate, db: Session):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    for field, value in request.dict(exclude_unset=True).items():
        setattr(server, field, value)

    db.commit()
    db.refresh(server)

    return {"status": "success", "message": "Server updated"}


def svc_delete_os_server(server_id: int, db: Session):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    linked_ids = set()
    for inst in server.db_instances:
        if inst.connection_id:
            linked_ids.add(inst.connection_id)

    name_prefix = f"{server.server_name}-"
    named_conns = db.query(ConnectionMaster).filter(
        ConnectionMaster.connection_name.like(f"{name_prefix}%")
    ).all()
    for c in named_conns:
        linked_ids.add(c.id)

    if linked_ids:
        db.query(ConnectionMaster).filter(
            ConnectionMaster.id.in_(linked_ids)
        ).delete(synchronize_session=False)

    db.delete(server)
    db.commit()

    deleted_count = len(linked_ids)
    return {
        "status": "success",
        "message": f"Server deleted along with {deleted_count} associated DB connection(s)",
    }


def svc_test_ssh(request: SshTestRequest):
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


def _apply_instance_status(server: OsServer, running_dbs: dict, status_detail: dict, default_detail: str = None):
    """Update each DatabaseInstance's status, stamping `status_changed_at`
    only on an actual transition (not every re-check) and `status_detail`
    with the latest diagnostic text while Stopped (falling back to
    `default_detail` — e.g. "SSH failed" — when there's no per-service
    detail to give). This is what a "Database Service Down" alert reads to
    say WHEN and WHY, instead of guessing from its own poll tick or staying
    silent on the cause."""
    now = datetime.utcnow()
    for inst in server.db_instances:
        if inst.db_type in running_dbs:
            is_up = running_dbs[inst.db_type]
        elif inst.port:
            is_up = _tcp_check(server.ip_address, inst.port)
            running_dbs[inst.db_type] = is_up
        else:
            continue
        new_status = "Running" if is_up else "Stopped"
        if inst.status != new_status:
            inst.status_changed_at = now
        inst.status = new_status
        inst.status_detail = status_detail.get(inst.db_type, default_detail) if new_status == "Stopped" else None


def svc_refresh_server(server_id: int, db: Session):
    server = db.query(OsServer).filter(OsServer.id == server_id).first()

    if not server:
        raise HTTPException(status_code=404, detail="Server not found")

    if not server.ssh_username or not server.ssh_password:
        raise HTTPException(status_code=400, detail="SSH credentials not configured")

    db_services = list(server.database_services or [])
    svc_ports = {}
    for svc in db_services:
        port = DEFAULT_PORTS.get(svc)
        if not port:
            for inst in server.db_instances:
                if inst.db_type.lower() == svc.lower() and inst.port:
                    port = inst.port
                    break
        if port:
            svc_ports[svc] = port
    for inst in server.db_instances:
        if inst.port and inst.db_type not in svc_ports:
            svc_ports[inst.db_type] = inst.port

    metrics = {}
    running_dbs = {}
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

        db_check_cmds = {
            "MySQL":      "systemctl is-active mariadb 2>/dev/null || systemctl is-active mysql 2>/dev/null || systemctl is-active mysqld 2>/dev/null || echo inactive",
            "MariaDB":    "systemctl is-active mariadb 2>/dev/null || systemctl is-active mysql 2>/dev/null || echo inactive",
            "PostgreSQL": "systemctl is-active postgresql 2>/dev/null || systemctl is-active postgresql-* 2>/dev/null || echo inactive",
            "MongoDB":    "systemctl is-active mongod 2>/dev/null || systemctl is-active mongodb 2>/dev/null || echo inactive",
            "MSSQL":      "systemctl is-active mssql-server 2>/dev/null || echo inactive",
            "ClickHouse": "systemctl is-active clickhouse-server 2>/dev/null || echo inactive",
        }
        # Candidate unit names per service, for the fuller diagnostic below —
        # `systemctl status` accepts several unit names at once and reports on
        # whichever exist, so this doesn't need to know which one matched.
        db_status_units = {
            "MySQL": "mariadb mysql mysqld", "MariaDB": "mariadb mysql",
            "PostgreSQL": "postgresql", "MongoDB": "mongod mongodb",
            "MSSQL": "mssql-server", "ClickHouse": "clickhouse-server",
        }
        status_detail = {}
        for db_svc, cmd in db_check_cmds.items():
            res = run(cmd)
            running_dbs[db_svc] = "active" in res.lower()
            if not running_dbs[db_svc]:
                # Only spend the extra round-trip on services that are
                # actually down — this is what "Database Service Down"
                # alerts surface as their Error detail.
                units = db_status_units.get(db_svc, "")
                status_detail[db_svc] = run(f"systemctl status {units} --no-pager -l 2>&1 | head -n 10")

        for svc, port in svc_ports.items():
            if svc not in running_dbs:
                running_dbs[svc] = _tcp_check(server.ip_address, port)

        ssh.close()

        _apply_instance_status(server, running_dbs, status_detail)

        server.status = "Connected"
        server.cpu_usage = metrics.get("cpu_usage")
        server.ram_usage = metrics.get("ram_usage")
        server.disk_usage = metrics.get("disk_usage")
        server.uptime = metrics.get("uptime")

        # Feed the SAME AgentMetric table the agent-push path writes to
        # (infra_detail_service.svc_ingest_agent_infra) so SSH-polled hosts get
        # real persisted history too — the after_insert hook on AgentMetric
        # (metrics_pipeline.py) fans this out to Redis + ClickHouse for free,
        # no separate write path needed. Keyed by server_name, same as the
        # agent path, so the frontend's getMetricsHistory(host.server_name)
        # call works unchanged for either collector.
        cpu_f = _pct_to_float(metrics.get("cpu_usage"))
        ram_f = _pct_to_float(metrics.get("ram_usage"))
        disk_f = _pct_to_float(metrics.get("disk_usage"))
        if cpu_f is not None or ram_f is not None or disk_f is not None:
            from app.models.agent_model import AgentMetric
            db.add(AgentMetric(agent_name=server.server_name, host_cpu=cpu_f or 0.0,
                               host_memory=ram_f or 0.0, host_disk=disk_f or 0.0,
                               kind="infra", tech="host", conn_id=0))

        db.commit()

        return {
            "status": "success",
            "message": "Server refreshed",
            "metrics": metrics,
            "running_dbs": running_dbs,
        }

    except Exception as e:
        for svc, port in svc_ports.items():
            running_dbs[svc] = _tcp_check(server.ip_address, port)
        _apply_instance_status(server, running_dbs, {}, default_detail=f"SSH connection to the host failed: {e}")

        server.status = "Disconnected"
        db.commit()
        return {
            "status": "warning",
            "message": f"SSH failed: {str(e)}",
            "server_status": "Disconnected",
            "running_dbs": running_dbs,
        }


def svc_link_instance_to_connection(server_id: int, instance_id: int, connection_id: int, db: Session):
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
