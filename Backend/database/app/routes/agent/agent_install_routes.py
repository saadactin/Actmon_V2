"""
Agent installation routes (Add-Agent deploy wizard).
All under /api/v1/agents — paths are distinct from agent_routes.py so both
routers coexist on the same prefix.
"""

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.agent.agent_install_service import (
    DEB_PATH,
    MSI_PATH,
    RPM_PATH,
    AgentInfraIngest,
    DbConfigRequest,
    EnrollRequest,
    InstallTokenRequest,
    build_linux_setup_sh,
    build_windows_setup_ps1,
    deb_available,
    get_agent_script,
    msi_available,
    rpm_available,
    svc_create_install_token,
    svc_enroll_agent,
    svc_get_db_targets,
    svc_save_db_target,
)
from app.services.os_server.infra_detail_service import (
    LINUX_COLLECTOR_BUNDLE,
    WINDOWS_COLLECTOR_PS,
    svc_ingest_agent_infra,
)

router = APIRouter(prefix="/api/v1/agents", tags=["Agent Install"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/install-token", summary="Persist the wizard's ingestion token")
def route_install_token(req: InstallTokenRequest, db: Session = Depends(get_db)):
    return svc_create_install_token(req, db)


@router.post("/enroll", summary="Agent enrollment (token → agent identity)")
def route_enroll(req: EnrollRequest, db: Session = Depends(get_db)):
    return svc_enroll_agent(req, db)


@router.post("/infra", summary="Agent full host snapshot ingest (Infrastructure)")
def route_ingest_infra(req: AgentInfraIngest, db: Session = Depends(get_db)):
    return svc_ingest_agent_infra(req, db)


@router.post("/db-config", summary="Save a DB for the agent to monitor (by token)")
def route_save_db_config(req: DbConfigRequest, db: Session = Depends(get_db)):
    return svc_save_db_target(req, db)


@router.get("/db-config", summary="Agent fetches the DBs it should monitor")
def route_get_db_config(token: str = Query(...), db: Session = Depends(get_db)):
    return svc_get_db_targets(token, db)


@router.get("/collector/{os_name}", summary="Collector command the agent must run (matches SSH)")
def route_collector(os_name: str):
    is_win = os_name.lower().startswith("win")
    return PlainTextResponse(WINDOWS_COLLECTOR_PS if is_win else LINUX_COLLECTOR_BUNDLE, media_type="text/plain")


@router.get("/install/actmon-agent.sh", summary="Linux host agent script")
def route_agent_sh():
    return PlainTextResponse(get_agent_script("linux"), media_type="text/x-shellscript")


@router.get("/install/actmon-agent.ps1", summary="Windows host agent script")
def route_agent_ps1():
    return PlainTextResponse(get_agent_script("windows"), media_type="text/plain")


@router.get("/install/actmon-setup.ps1", summary="Windows one-shot MSI+service setup")
def route_setup_ps1(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64")):
    return PlainTextResponse(build_windows_setup_ps1(token, url), media_type="text/plain")


@router.get("/install/actmon-setup.sh", summary="Linux one-shot systemd setup (deb & rpm distros)")
def route_setup_sh(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64")):
    return PlainTextResponse(build_linux_setup_sh(token, url), media_type="text/x-shellscript")


@router.get("/host-ips", summary="LAN IPs of the ActMon server (build install URLs reachable from target hosts)")
def route_host_ips():
    """The install command must NOT point at localhost — the target host would dial
    itself. Report this server's LAN addresses so the UI can offer a reachable URL."""
    import socket

    primary = None
    ips: list[str] = []
    try:  # primary outbound interface (no packets actually sent)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    try:  # every IPv4 bound to this hostname (VMware/Hyper-V adapters included)
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    if primary and primary in ips:  # primary first
        ips.remove(primary)
    if primary:
        ips.insert(0, primary)
    return {"primary": primary or (ips[0] if ips else None), "ips": ips}


@router.get("/download/{os_name}", summary="Download the host agent installer")
def route_download(os_name: str, fmt: str = Query("deb")):
    is_win = os_name.lower().startswith("win")
    # Windows → serve the built MSI installer when available.
    if is_win and msi_available():
        return FileResponse(MSI_PATH, media_type="application/x-msi", filename="actmon-agent.msi")
    # Linux → serve the requested package format when available (fmt=rpm|deb).
    if not is_win:
        if fmt == "rpm" and rpm_available():
            return FileResponse(RPM_PATH, media_type="application/x-rpm", filename="actmon-agent.rpm")
        if fmt != "rpm" and deb_available():
            return FileResponse(DEB_PATH, media_type="application/vnd.debian.binary-package", filename="actmon-agent.deb")
    # Fallback → the self-contained agent script.
    filename = "actmon-agent.ps1" if is_win else "actmon-agent.sh"
    return PlainTextResponse(
        get_agent_script(os_name),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
