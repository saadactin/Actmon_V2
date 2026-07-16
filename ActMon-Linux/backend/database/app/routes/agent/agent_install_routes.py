"""
Agent installation routes (Add-Agent deploy wizard).
All under /api/v1/agents — paths are distinct from agent_routes.py so both
routers coexist on the same prefix.
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.agent.agent_install_service import (
    DEB_PATH,
    EXE_PATH,
    MSI_PATH,
    RPM_PATH,
    AgentInfraIngest,
    DbConfigRequest,
    EnrollRequest,
    InstallTokenRequest,
    build_linux_setup_sh,
    build_token_msi,
    build_windows_install_bat,
    build_windows_setup_ps1,
    deb_available,
    exe_available,
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


class DbTestRequest(BaseModel):
    token: str
    db_type: str
    host: Optional[str] = None
    port: Optional[int] = None
    username: Optional[str] = None
    password: Optional[str] = None
    database_name: Optional[str] = None


@router.post("/db-test", summary="Test a DB connection THROUGH the agent (connects locally on the agent host)")
def route_db_test(req: DbTestRequest):
    """The agent runs where the DB lives, so it can validate 'localhost' — which the
    backend never can. Enqueue a SELECT 1 as a dbquery job on the agent's token and
    return its verdict. Requires the agent to be installed + online on the DB host."""
    import json
    from app.services.agent import agent_fs_service
    # Engine-appropriate connectivity probe: Oracle needs FROM DUAL (bare SELECT 1 is
    # ORA-00923); MongoDB isn't SQL at all — the agent runs the JSON command document.
    # Every other engine (MySQL/Postgres/MSSQL) accepts "SELECT 1".
    dbt_l = (req.db_type or "").lower()
    if "oracle" in dbt_l:
        probe_sql = "SELECT 1 FROM DUAL"
    elif "mongo" in dbt_l:
        probe_sql = '{"ping": 1}'
    else:
        probe_sql = "SELECT 1"
    payload = json.dumps({
        "db_type": req.db_type, "host": req.host or "127.0.0.1", "port": req.port or 0,
        "user": req.username or "", "password": req.password or "",
        "database": req.database_name or "", "sql": probe_sql,
    })
    try:
        raw = agent_fs_service.request(req.token, "dbquery", payload, timeout=20)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    if raw is None:
        return {"ok": False, "error": "The agent did not respond. Make sure it is installed and Online on the DB host, then retry."}
    try:
        res = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
    except Exception:  # noqa: BLE001
        return {"ok": False, "error": "Unexpected response from the agent."}
    if res.get("error"):
        return {"ok": False, "error": res["error"]}
    return {"ok": True, "message": f"Connected on the agent host (localhost) — {probe_sql} succeeded."}


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


@router.get("/install/actmon-setup.ps1", summary="Windows one-shot exe+service setup")
def route_setup_ps1(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64")):
    return PlainTextResponse(build_windows_setup_ps1(token, url), media_type="text/plain")


@router.get("/install/actmon-install.bat", summary="Double-clickable Windows installer (token baked in)")
def route_install_bat(token: str = Query(...), url: str = Query(...)):
    return PlainTextResponse(
        build_windows_install_bat(token, url),
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment; filename=actmon-install.bat"},
    )


@router.get("/install/actmon-agent.msi", summary="Self-configuring MSI (token + URL baked in)")
def route_configured_msi(token: str = Query(...), url: str = Query(...)):
    """Build & return an MSI with this deployment's token/URL baked in as defaults —
    a plain double-click installs a fully-configured, auto-starting agent."""
    try:
        path = build_token_msi(token, url)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not build MSI on the server: {e}")
    return FileResponse(path, media_type="application/x-msi", filename="actmon-agent.msi")


@router.get("/download/actmon.msi", summary="Universal one-click ActMon Agent MSI (self-registers)")
def route_universal_msi(url: str = Query(...), db: Session = Depends(get_db)):
    """The 'like any product' installer: mints + persists a fresh token, bakes it and
    the server URL into an MSI, and returns it as ActMon-Agent.msi. Just download and
    double-click — the host self-registers by its own name. No wizard, no token to manage."""
    import uuid
    from app.models.agent_model import AgentToken
    token = "actmon-" + uuid.uuid4().hex
    db.add(AgentToken(token=token, token_name="ActMon Agent", agent_name="ActMon Agent", os_type="windows"))
    db.commit()
    try:
        path = build_token_msi(token, url)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not build MSI on the server: {e}")
    return FileResponse(path, media_type="application/x-msi", filename="ActMon-Agent.msi")


@router.get("/install/actmon-setup.sh", summary="Linux one-shot systemd setup (deb & rpm distros)")
def route_setup_sh(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64")):
    return PlainTextResponse(build_linux_setup_sh(token, url), media_type="text/x-shellscript")


@router.get("/fs-poll", summary="Agent long-polls for pending file-browse jobs")
def route_fs_poll(token: str, hold: int = 15):
    from fastapi.responses import PlainTextResponse
    from app.services.agent import agent_fs_service
    return PlainTextResponse(agent_fs_service.poll(token, hold))


@router.post("/fs-result", summary="Agent delivers a file-browse job's output")
def route_fs_result(payload: dict):
    from app.services.agent import agent_fs_service
    ok = agent_fs_service.result(
        str(payload.get("id") or ""),
        payload.get("data_b64"),
        payload.get("error"),
    )
    return {"status": "success" if ok else "expired"}


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
    # Windows → raw .exe when explicitly requested, else the built MSI installer.
    if is_win and fmt == "exe" and exe_available():
        return FileResponse(EXE_PATH, media_type="application/vnd.microsoft.portable-executable", filename="actmon-agent.exe")
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
