"""
Public downloads for the ActMon APPLICATION build (not the agent).

Builds live at Backend/database/install/downloads/:
  * ActMon-Windows.zip  - Windows application build
  * ActMon-Linux.zip     - Ubuntu/Linux deployment bundle (source + prebuilt UI + installer)

The landing page calls /actmon/status to see which OS builds are published and
links to /actmon/<os> to download. Per-OS path override via env ACTMON_APP_ZIP_<OS>.
"""
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/v1/download", tags=["Download"])

_BASE = Path(__file__).resolve().parents[3]                       # Backend/database
_DL = _BASE / "install" / "downloads"

# os key -> build metadata
BUILDS = {
    "windows": {"file": "ActMon-Windows.zip", "label": "Windows",
                "os": "Windows 10 / 11 & Windows Server (x64)"},
    "linux":   {"file": "ActMon-Linux.zip",    "label": "Linux / Ubuntu",
                "os": "Ubuntu 22.04 / 24.04 LTS (x86_64)"},
}


def _zip_path(os_key: str) -> Path:
    env = os.getenv(f"ACTMON_APP_ZIP_{os_key.upper()}")
    if env:
        return Path(env)
    return _DL / BUILDS[os_key]["file"]


@router.get("/actmon/status", summary="Which ActMon app builds are published?")
def download_status():
    builds = {}
    for key, meta in BUILDS.items():
        p = _zip_path(key)
        avail = p.is_file()
        builds[key] = {
            "available": avail,
            "label": meta["label"],
            "os": meta["os"],
            "filename": meta["file"],
            "size_mb": round(p.stat().st_size / 1048576, 1) if avail else None,
            "url": f"/api/v1/download/actmon/{key}",
        }
    return {
        "version": os.getenv("ACTMON_APP_VERSION", "2026.1"),
        "builds": builds,
        # backward-compat flags
        "windows_available": builds["windows"]["available"],
        "linux_available": builds["linux"]["available"],
    }


@router.get("/actmon/{os_key}", summary="Download the ActMon application build for an OS")
def download_build(os_key: str):
    if os_key not in BUILDS:
        raise HTTPException(status_code=404, detail=f"Unknown OS '{os_key}'. Supported: {', '.join(BUILDS)}.")
    p = _zip_path(os_key)
    if not p.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"The ActMon {BUILDS[os_key]['label']} build isn't published on this server yet.")
    return FileResponse(str(p), media_type="application/zip", filename=BUILDS[os_key]["file"])
