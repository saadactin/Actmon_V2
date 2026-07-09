"""
Public downloads for the ActMon APPLICATION build (not the agent).

The Windows build is a zip produced by `python package_release.py --publish`, which
drops it at Backend/database/install/downloads/ActMon-Windows.zip. The landing page
checks /status to enable the button and links to /windows to download it.
Overridable path via env ACTMON_APP_ZIP.
"""
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/v1/download", tags=["Download"])

_BASE = Path(__file__).resolve().parents[2]                       # Backend/database
DEFAULT_ZIP = _BASE / "install" / "downloads" / "ActMon-Windows.zip"


def _zip_path() -> Path:
    return Path(os.getenv("ACTMON_APP_ZIP", str(DEFAULT_ZIP)))


@router.get("/actmon/status", summary="Is the ActMon app build published?")
def download_status():
    p = _zip_path()
    return {
        "windows_available": p.is_file(),
        "size_mb": round(p.stat().st_size / 1048576, 1) if p.is_file() else None,
        "version": os.getenv("ACTMON_APP_VERSION", "1.0.0"),
    }


@router.get("/actmon/windows", summary="Download the ActMon Windows application build")
def download_windows():
    p = _zip_path()
    if not p.is_file():
        raise HTTPException(
            status_code=404,
            detail="The ActMon Windows build isn't published on this server yet. "
                   "Run 'python package_release.py --publish' to generate it.")
    return FileResponse(str(p), media_type="application/zip", filename="ActMon-Windows.zip")
