"""
Agent installation routes (Add-Agent deploy wizard).
All under /api/v1/agents — paths are distinct from agent_routes.py so both
routers coexist on the same prefix.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
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
    build_docker_install_bat,
    build_docker_setup_ps1,
    build_docker_setup_sh,
    build_linux_setup_sh,
    build_token_msi,
    build_windows_install_bat,
    build_windows_setup_ps1,
    deb_available,
    exe_available,
    get_agent_script,
    granted_permissions_for_token,
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
    res = svc_ingest_agent_infra(req, db)
    # Every push doubles as a version report — this is what closes an open
    # upgrade in the ledger. Best-effort: never let it affect the ingest result.
    if req.agent_version:
        try:
            from app.services.agent import agent_update_ledger_service as ledger
            name = (res or {}).get("agent_name")
            if name:
                ledger.record_version(db, name, req.agent_version)
        except Exception:  # noqa: BLE001
            pass
    return res


class StartupPing(BaseModel):
    """Sent once by the agent as soon as it comes up. For a host that was just
    upgraded this is the FIRST thing the new build does, so it is the fastest
    and most reliable confirmation that the new version is really running."""
    token: str
    hostname: Optional[str] = None
    os_type: Optional[str] = None
    agent_version: Optional[str] = None


@router.post("/startup-ping", summary="Agent boot ping (reports the running version)")
def route_startup_ping(req: StartupPing, db: Session = Depends(get_db)):
    from app.services.agent import agent_update_ledger_service as ledger
    from app.models.agent_model import AgentToken
    from app.services.common.credential_encryption_service import credential_encryption
    # Resolve identity from the enrollment token, never from the self-reported
    # hostname — the token is what actually authorises this host.
    tok = db.query(AgentToken).filter(
        credential_encryption.token_match_filter(AgentToken.token_hash, AgentToken.token, req.token)
    ).first()
    if not tok:
        raise HTTPException(status_code=401, detail="Unknown agent token.")
    name = tok.agent_name or req.hostname
    if not name:
        return {"status": "ignored", "reason": "token has no agent identity yet"}
    ledger.record_version(db, name, req.agent_version)
    return {"status": "success", "agent_name": name,
            "update": ledger.status_for(db, name)}


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


def _permissions_list(token: str, db: Session) -> Optional[list]:
    """The wizard's recorded choice for this token, as a list — or None
    (unrestricted/no choice recorded), for the script builders below."""
    raw = granted_permissions_for_token(token, db)
    return raw.split(",") if raw is not None else None


@router.get("/install/actmon-setup.ps1", summary="Windows one-shot exe+service setup")
def route_setup_ps1(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64"),
                     db: Session = Depends(get_db)):
    return PlainTextResponse(build_windows_setup_ps1(token, url, _permissions_list(token, db)), media_type="text/plain")


@router.get("/install/actmon-install.bat", summary="Double-clickable Windows installer (token baked in)")
def route_install_bat(token: str = Query(...), url: str = Query(...), db: Session = Depends(get_db)):
    return PlainTextResponse(
        build_windows_install_bat(token, url, _permissions_list(token, db)),
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
    from app.services.common.credential_encryption_service import credential_encryption
    token = "actmon-" + uuid.uuid4().hex
    db.add(AgentToken(token=token, token_hash=credential_encryption.hash_token(token),
                       token_name="ActMon Agent", agent_name="ActMon Agent", os_type="windows"))
    db.commit()
    try:
        path = build_token_msi(token, url)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not build MSI on the server: {e}")
    return FileResponse(path, media_type="application/x-msi", filename="ActMon-Agent.msi")


@router.get("/install/actmon-setup.sh", summary="Linux one-shot systemd setup (deb & rpm distros)")
def route_setup_sh(token: str = Query(...), url: str = Query(...), arch: str = Query("amd64"),
                    db: Session = Depends(get_db)):
    return PlainTextResponse(build_linux_setup_sh(token, url, _permissions_list(token, db)), media_type="text/x-shellscript")


@router.get("/install/actmon-docker-setup.sh", summary="Docker one-shot build+run (real host visibility via nsenter)")
def route_docker_setup_sh(token: str = Query(...), url: str = Query(...), os: str = Query("debian")):
    return PlainTextResponse(build_docker_setup_sh(token, url, os), media_type="text/x-shellscript")


@router.get("/install/actmon-docker-setup.ps1", summary="Windows Docker one-shot build+run (container-scoped visibility only)")
def route_docker_setup_ps1(token: str = Query(...), url: str = Query(...)):
    return PlainTextResponse(build_docker_setup_ps1(token, url), media_type="text/plain")


@router.get("/install/actmon-docker-setup.bat", summary="Double-clickable Windows Docker installer (self-elevating wrapper)")
def route_docker_setup_bat(token: str = Query(...), url: str = Query(...)):
    return PlainTextResponse(build_docker_install_bat(token, url), media_type="text/plain")


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
    #
    # An explicit fmt=exe must NEVER fall through to another format. The install
    # script saves whatever comes back as actmon-agent.exe and only checks that it
    # is over 1 MB, so handing it the 20 MB MSI produced a file Windows refuses to
    # load ("This version of %1 is not compatible…"). The scheduled task then
    # registered and "started" it, the process died in the loader before it could
    # log anything, and the installer still printed SUCCESS — every agent went
    # offline with nothing anywhere saying why. Failing loudly here is the only
    # place that mismatch can still be caught.
    if is_win and fmt == "exe":
        if exe_available():
            return FileResponse(
                EXE_PATH,
                media_type="application/vnd.microsoft.portable-executable",
                filename="actmon-agent.exe",
            )
        raise HTTPException(
            status_code=503,
            detail="The Windows agent executable has not been built on this server "
                   f"({EXE_PATH} is missing). Build it with Backend/agent/build_agent.sh "
                   "(PyInstaller, on a Windows host), then retry. Refusing to serve a "
                   "different format, because the installer would save it as .exe and "
                   "Windows could not run it.",
        )
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


# ── Agent self-update source (Linux agents poll this hourly) ───────────────────
from fastapi.responses import PlainTextResponse as _PlainText


def _agent_source_text():
    from app.services.agent.agent_install_service import _BACKEND_DIR
    import os as _o
    path = _o.path.join(_BACKEND_DIR, "agent", "actmon_agent.py")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        # LF-normalise so the sha matches what the deb/rpm installed (their build
        # strips CR) and what the agent writes back to disk.
        return f.read().replace("\r\n", "\n").replace("\r", "\n")


def current_agent_version() -> str:
    """The version the shipped agent source declares — parsed from the agent file
    itself so there is exactly ONE source of truth. Reading it here (rather than
    keeping a copy in a server constant or a version.txt) means the two can never
    disagree about what an upgrade is supposed to produce."""
    import re
    try:
        m = re.search(r'^AGENT_VERSION\s*=\s*["\']([^"\']+)["\']',
                      _agent_source_text(), re.MULTILINE)
        return m.group(1) if m else ""
    except Exception:  # noqa: BLE001 — version reporting must never break a download
        return ""


@router.get("/install/actmon-agent.msi/sha", summary="SHA-256 + version of the token-baked MSI (Windows self-update verify)")
def route_configured_msi_sha(token: str = Query(...), url: str = Query(...)):
    """Integrity companion to /install/actmon-agent.msi.

    The Linux self-update path has verified a SHA-256 since it shipped
    (/agents/agent-source/sha); the Windows MSI path only ever checked that the
    download was larger than 100 KB, which catches a truncated transfer but not
    a corrupted or substituted one. This gives the Windows updater the same
    guarantee. Hashing the exact bytes we would serve, so a per-token rebuild
    can't drift from the hash.
    """
    import hashlib
    import os as _o
    try:
        path = build_token_msi(token, url)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return {"sha256": h.hexdigest(), "size": _o.path.getsize(path),
                "agent_version": current_agent_version()}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not hash the MSI: {e}")


@router.get("/agent-source/sha", summary="SHA-256 of the current agent source (self-update check)")
def agent_source_sha():
    import hashlib
    try:
        return {"sha": hashlib.sha256(_agent_source_text().encode("utf-8")).hexdigest()}
    except Exception as e:  # noqa: BLE001
        return {"sha": "", "error": str(e)[:200]}


@router.get("/agent-source", summary="Raw agent source (self-update download)")
def agent_source():
    try:
        return _PlainText(_agent_source_text())
    except Exception as e:  # noqa: BLE001
        return _PlainText("", status_code=500)
