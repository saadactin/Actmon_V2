from typing import Optional

from fastapi import APIRouter, Depends, Body, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.routes.auth.auth_routes import current_claims
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id
from app.services.os_server.os_server_service import (
    DbInstanceIn,  # noqa: F401
    OsServerCreate,
    OsServerUpdate,
    SshTestRequest,
    svc_create_os_server,
    svc_delete_os_server,
    svc_get_live_status,
    svc_get_os_server,
    svc_get_summary,
    svc_link_instance_to_connection,
    svc_list_os_servers,
    svc_refresh_server,
    svc_test_ssh,
    svc_update_os_server,
)

router = APIRouter(prefix="/api/v1/os-servers", tags=["OS Servers"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/live-status")
def route_get_live_status(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return svc_get_live_status(db, scope_org_id(ctx))


@router.get("/summary")
def route_get_summary(db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return svc_get_summary(db, scope_org_id(ctx))


@router.get("/")
def route_list_os_servers(
    environment: Optional[str] = None,
    os_type: Optional[str] = None,
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx),
):
    return svc_list_os_servers(db, environment, os_type, scope_org_id(ctx))


@router.get("/{server_id}")
def route_get_os_server(server_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return svc_get_os_server(server_id, db, scope_org_id(ctx))


@router.post("/")
def route_create_os_server(request: OsServerCreate, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return svc_create_os_server(request, db, create_org_id(ctx))


@router.put("/{server_id}")
def route_update_os_server(
    server_id: int,
    request: OsServerUpdate,
    db: Session = Depends(get_db),
):
    return svc_update_os_server(server_id, request, db)


@router.delete("/{server_id}")
def route_delete_os_server(server_id: int, db: Session = Depends(get_db)):
    return svc_delete_os_server(server_id, db)


@router.post("/test-ssh")
def route_test_ssh(request: SshTestRequest):
    return svc_test_ssh(request)


@router.post("/{server_id}/refresh")
def route_refresh_server(server_id: int, db: Session = Depends(get_db)):
    return svc_refresh_server(server_id, db)


@router.get("/{server_id}/infra-detail")
def route_host_infra_detail(server_id: int, db: Session = Depends(get_db)):
    from app.services.os_server.infra_detail_service import svc_host_infra_detail
    return svc_host_infra_detail(server_id, db)


@router.get("/{server_id}/fs")
def route_fs_list(server_id: int, path: str = "/", db: Session = Depends(get_db)):
    """Storage drill-down: list folders & files under a path (SSH)."""
    from app.services.os_server.fs_browse_service import svc_fs_list
    return svc_fs_list(server_id, path, db)


@router.get("/{server_id}/fs/file")
def route_fs_read(server_id: int, path: str, db: Session = Depends(get_db)):
    """Storage drill-down: read a file's content preview (first 64 KB)."""
    from app.services.os_server.fs_browse_service import svc_fs_read
    return svc_fs_read(server_id, path, db)


@router.get("/{server_id}/netconfig")
def route_net_config(server_id: int, db: Session = Depends(get_db)):
    """Live IP configuration: interfaces, addresses, routes, gateway, DNS."""
    from app.services.os_server.net_config_service import svc_net_config
    return svc_net_config(server_id, db)


@router.get("/{server_id}/firewall")
def route_fw_list(server_id: int, db: Session = Depends(get_db)):
    """Current ActMon firewall allow/block IP rules."""
    from app.services.os_server.net_config_service import svc_fw_list
    return svc_fw_list(server_id, db)


@router.post("/{server_id}/firewall")
def route_fw_add(server_id: int, ip: str, action: str = "allow", db: Session = Depends(get_db)):
    """Whitelist (allow) or blacklist (block) a source IP / CIDR on this host."""
    from app.services.os_server.net_config_service import svc_fw_add
    return svc_fw_add(server_id, ip, action, db)


@router.delete("/{server_id}/firewall/{handle}")
def route_fw_del(server_id: int, handle: str, db: Session = Depends(get_db)):
    """Remove a firewall rule by its nft handle."""
    from app.services.os_server.net_config_service import svc_fw_del
    return svc_fw_del(server_id, handle, db)


class FsWriteBody(BaseModel):
    path: str
    content: str


@router.put("/{server_id}/fs/file")
def route_fs_write(server_id: int, body: FsWriteBody, db: Session = Depends(get_db)):
    """Edit/overwrite a text file on the host (keeps a .actmon.bak backup)."""
    from app.services.os_server.fs_browse_service import svc_fs_write
    return svc_fs_write(server_id, body.path, body.content, db)


@router.get("/{server_id}/net-files")
def route_net_files(server_id: int, db: Session = Depends(get_db)):
    """Editable network config files present on the host + active networking units."""
    from app.services.os_server.net_config_service import svc_net_files
    return svc_net_files(server_id, db)


@router.get("/{server_id}/services")
def route_list_services(server_id: int, db: Session = Depends(get_db)):
    """Service inventory with status (running/stopped) for the Services panel."""
    from app.services.os_server.host_action_service import svc_list_services
    return svc_list_services(server_id, db)


@router.get("/{server_id}/net-diag")
def route_net_diag(server_id: int, kind: str, target: str, port: Optional[int] = None,
                   db: Session = Depends(get_db)):
    """Read-only network check on the host: kind = ping | port | dns."""
    from app.services.os_server.host_action_service import svc_net_diag
    return svc_net_diag(server_id, kind, target, port, db)


class HostActionBody(BaseModel):
    password: str
    unit: str | None = None
    action: str | None = None   # start | stop | restart
    pid: str | None = None      # for kill-process


def _audit_service_action(db: Session, server_id: int, user_id, action_type: str, new_data: dict):
    from app.models.admin_models import AuditLog
    from app.services.os_server.os_server_service import svc_get_os_server
    try:
        srv = svc_get_os_server(server_id, db)
        org_id = getattr(srv, "org_id", None)
        db.add(AuditLog(org_id=org_id, user_id=user_id, table_name="os_server_service",
                         record_id=server_id, action_type=action_type, new_data=new_data))
        db.commit()
    except Exception:  # noqa: BLE001 — the action already ran; audit failure must not mask its result
        db.rollback()


@router.post("/{server_id}/service-action")
def route_service_action(server_id: int, body: HostActionBody,
                         claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Start / stop / restart a service. Re-authenticates the caller's password first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_service_action
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    if not body.unit:
        raise HTTPException(status_code=400, detail="Service name is required.")
    action = (body.action or "restart").lower()
    result = svc_service_action(server_id, body.unit, action, db)
    _audit_service_action(db, server_id, claims.get("user_id"), f"{action}_service", {"unit": body.unit, "result": result})
    return result


@router.post("/{server_id}/restart-service")
def route_restart_service(server_id: int, body: HostActionBody,
                          claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Restart a service. Re-authenticates the caller's password first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_restart_service
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    if not body.unit:
        raise HTTPException(status_code=400, detail="Service unit is required.")
    result = svc_restart_service(server_id, body.unit, db)
    _audit_service_action(db, server_id, claims.get("user_id"), "restart_service", {"unit": body.unit, "result": result})
    return result


@router.post("/{server_id}/kill-process")
def route_kill_process(server_id: int, body: HostActionBody,
                       claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Force-kill a process by PID. Re-authenticates the caller's password first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_kill_process
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    if not body.pid:
        raise HTTPException(status_code=400, detail="PID is required.")
    return svc_kill_process(server_id, body.pid, db)


@router.post("/{server_id}/reboot")
def route_reboot(server_id: int, body: HostActionBody,
                 claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Reboot the host. Re-authenticates the caller's password first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_reboot_host
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    return svc_reboot_host(server_id, db)


@router.post("/{server_id}/update-agent")
def route_update_agent(server_id: int, body: HostActionBody,
                       claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Trigger a self-upgrade of the host's Windows agent. Re-authenticates first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_update_agent
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    return svc_update_agent(server_id, db)


@router.get("/{server_id}/os-config/registry")
def route_reg_get(server_id: int, key: str, db: Session = Depends(get_db)):
    """Read a Windows registry key's values (read-only)."""
    from app.services.os_server.host_action_service import svc_reg_get
    return svc_reg_get(server_id, key, db)


@router.get("/{server_id}/os-config/command")
def route_run_command(server_id: int, key: str, db: Session = Depends(get_db)):
    """Run a whitelisted read-only OS info command (systeminfo, hostname, …)."""
    from app.services.os_server.host_action_service import svc_run_command
    return svc_run_command(server_id, key, db)


class RegSetBody(BaseModel):
    password: str
    key: str
    name: str
    value: str = ""


@router.post("/{server_id}/os-config/registry")
def route_reg_set(server_id: int, body: RegSetBody,
                  claims: dict = Depends(current_claims), db: Session = Depends(get_db)):
    """Set a Windows registry value. Re-authenticates the caller's password first."""
    from app.services.os_server.host_action_service import verify_user_password, svc_reg_set
    if not verify_user_password(db, claims.get("user_id"), body.password):
        raise HTTPException(status_code=401, detail="Password verification failed.")
    return svc_reg_set(server_id, body.key, body.name, body.value, db)


@router.post("/{server_id}/instances/{instance_id}/link")
def route_link_instance_to_connection(
    server_id: int,
    instance_id: int,
    connection_id: int,
    db: Session = Depends(get_db),
):
    return svc_link_instance_to_connection(server_id, instance_id, connection_id, db)
