"""
Onboarding / Sales — build a per-client ActMon installer .zip.

Takes the wizard config (organization + accepted policy + selected modules/pages
+ deployment server details + generated admin credentials) and streams back a
self-contained bundle:  app build + deploy.json + install.(ps1|sh) + README.txt
"""
import io
import os
import re
import json
import zipfile
import datetime

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from app.database.connection import SessionLocal

router = APIRouter(prefix="/api/v1/onboarding", tags=["Onboarding"])

# organization_master columns we accept from the registration form
_ORG_FIELDS = [
    "org_code", "org_name", "legal_name", "cin_number", "gst_number", "pan_number",
    "registration_no", "industry", "website_url", "contact_person_name",
    "contact_person_designation", "contact_person_email", "contact_person_no",
    "contact_no", "alternate_contact_no", "email_id", "address_line1", "address_line2",
    "city_name", "state_name", "country_name", "pincode",
]
_ORG_REQUIRED = ["org_code", "org_name", "legal_name", "contact_no", "email_id",
                 "country_name", "state_name", "city_name"]


@router.post("/register-org")
def register_org(body: dict = Body(...)):
    """Register a client organization (all onboarding fields, incl. CIN & contact person)."""
    missing = [f for f in _ORG_REQUIRED if not str(body.get(f) or "").strip()]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required field(s): {', '.join(missing)}")
    data = {f: (body.get(f) or None) for f in _ORG_FIELDS}
    db = SessionLocal()
    try:
        cols = ", ".join(_ORG_FIELDS) + ", status_id, is_active, created_by, created_at"
        vals = ", ".join(f":{f}" for f in _ORG_FIELDS) + ", 1, TRUE, 1, now()"
        row = db.execute(text(
            f"INSERT INTO organization_master ({cols}) VALUES ({vals}) RETURNING org_id, org_name"),
            data).mappings().first()
        db.commit()
        return {"status": "success", "org_id": row["org_id"], "org_name": row["org_name"]}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Could not register organization: {e}")
    finally:
        db.close()

# Backend/database/install/downloads/ActMon-Windows.zip (prebuilt app), if present.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DB_DIR = os.path.abspath(os.path.join(_HERE, "..", ".."))
APP_BUILD = os.path.join(_DB_DIR, "install", "downloads", "ActMon-Windows.zip")


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", str(s or "client").lower()).strip("-") or "client"


def _ps1(cfg, org):
    dep = cfg.get("deployment", {})
    return (
        "# ActMon installer - Windows\n"
        "# Generated for: {name}\n"
        "$ErrorActionPreference = 'Stop'\n"
        "Write-Host 'ActMon setup for {name}' -ForegroundColor Cyan\n"
        "$here = Split-Path -Parent $MyInvocation.MyCommand.Path\n"
        "$cfg  = Get-Content (Join-Path $here 'deploy.json') | ConvertFrom-Json\n"
        "Write-Host ('Deploying to host: ' + $cfg.deployment.host)\n"
        "if (Test-Path (Join-Path $here 'app\\ActMon-Windows.zip')) {{\n"
        "  Expand-Archive -Force (Join-Path $here 'app\\ActMon-Windows.zip') (Join-Path $here 'ActMon')\n"
        "  Write-Host 'App build extracted to .\\ActMon' -ForegroundColor Green\n"
        "}} else {{ Write-Host 'App build not bundled - download it from the ActMon portal.' -ForegroundColor Yellow }}\n"
        "Write-Host 'Modules:' ($cfg.modules -join ', ')\n"
        "Write-Host ('Admin login: ' + $cfg.credentials.username)\n"
        "Write-Host 'Setup complete. Follow README.txt for DB + service steps.' -ForegroundColor Green\n"
    ).format(name=org.get("org_name", "client"), host=dep.get("host", ""))


def _sh(cfg, org):
    return (
        "#!/usr/bin/env bash\n"
        "# ActMon installer - Linux/Ubuntu\n"
        "# Generated for: {name}\n"
        "set -e\n"
        "here=\"$(cd \"$(dirname \"$0\")\" && pwd)\"\n"
        "echo \"ActMon setup for {name}\"\n"
        "if command -v jq >/dev/null; then host=$(jq -r '.deployment.host' \"$here/deploy.json\"); echo \"Deploy host: $host\"; fi\n"
        "if [ -f \"$here/app/ActMon-Windows.zip\" ]; then unzip -o \"$here/app/ActMon-Windows.zip\" -d \"$here/ActMon\" >/dev/null && echo 'App build extracted to ./ActMon'; "
        "else echo 'App build not bundled - download it from the ActMon portal.'; fi\n"
        "echo 'Setup complete. Follow README.txt for DB + service steps.'\n"
    ).format(name=org.get("org_name", "client"))


def _readme(cfg, org, ts):
    dep = cfg.get("deployment", {})
    cred = cfg.get("credentials", {})
    mods = ", ".join(cfg.get("modules", [])) or "(none)"
    pages = len(cfg.get("pages", []))
    return (
        "ActMon - Client Installer Bundle\n"
        "================================\n\n"
        "Organization : {oname} ({ocode})\n"
        "Generated    : {ts}\n\n"
        "DEPLOYMENT TARGET\n"
        "  Host        : {host}\n"
        "  OS          : {os}\n"
        "  App port    : {aport}\n"
        "  Database    : {db} @ {dbhost}:{dbport}\n\n"
        "SELECTED MODULES ({mcount})\n  {mods}\n"
        "SELECTED PAGES   : {pages}\n\n"
        "ADMIN CREDENTIALS (change after first login)\n"
        "  Username    : {user}\n"
        "  Password    : {pwd}\n\n"
        "INSTALL\n"
        "  Windows : right-click install.ps1 > Run with PowerShell (as Administrator)\n"
        "  Linux   : chmod +x install.sh && sudo ./install.sh\n\n"
        "deploy.json contains the full machine-readable configuration.\n"
    ).format(
        oname=org.get("org_name", ""), ocode=org.get("org_code", ""), ts=ts,
        host=dep.get("host", ""), os=dep.get("os_type", ""), aport=dep.get("app_port", ""),
        db=dep.get("db_type", ""), dbhost=dep.get("db_host", ""), dbport=dep.get("db_port", ""),
        mcount=len(cfg.get("modules", [])), mods=mods, pages=pages,
        user=cred.get("username", ""), pwd=cred.get("password", ""),
    )


@router.post("/build")
def build_installer(cfg: dict = Body(...)):
    org = cfg.get("organization", {}) or {}
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    manifest = {**cfg, "generated_at": ts, "product": "ActMon", "bundle_version": "2026.1"}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("deploy.json", json.dumps(manifest, indent=2))
        z.writestr("install.ps1", _ps1(cfg, org))
        z.writestr("install.sh", _sh(cfg, org))
        z.writestr("README.txt", _readme(cfg, org, ts))
        if os.path.exists(APP_BUILD):
            z.write(APP_BUILD, arcname="app/ActMon-Windows.zip")
        else:
            z.writestr("app/PLACE_APP_BUILD_HERE.txt",
                       "Bundle the ActMon application build (ActMon-Windows.zip) in this folder,\n"
                       "or download it from the ActMon portal before running the installer.\n")
    buf.seek(0)
    fn = f"ActMon-{_slug(org.get('org_code') or org.get('org_name'))}-Setup.zip"
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{fn}"'})
