from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
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


@router.post("/{server_id}/instances/{instance_id}/link")
def route_link_instance_to_connection(
    server_id: int,
    instance_id: int,
    connection_id: int,
    db: Session = Depends(get_db),
):
    return svc_link_instance_to_connection(server_id, instance_id, connection_id, db)
