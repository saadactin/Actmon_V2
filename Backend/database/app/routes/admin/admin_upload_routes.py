"""Generic image upload for Administration masters (currently: organization logos).

Stores the file under Backend/database/uploads/<kind>/ and returns a URL
under /api/v1/uploads/... (NOT a bare /uploads/...) — nginx already proxies
every /api/ path to this backend, so this rides that existing rule instead
of needing a brand-new, per-deployment nginx location block just for this."""
import os
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile

router = APIRouter(prefix="/api/v1/admin/uploads", tags=["Admin - Uploads"])

_ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
_MAX_BYTES = 2 * 1024 * 1024  # 2MB — a logo, not a photo library

_UPLOAD_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *([os.pardir] * 3), "uploads"))
_LOGO_DIR = os.path.join(_UPLOAD_ROOT, "org_logos")
os.makedirs(_LOGO_DIR, exist_ok=True)


@router.post("/logo")
async def upload_org_logo(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported image type '{ext}'. Allowed: {', '.join(sorted(_ALLOWED_EXT))}")
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(400, f"Image too large ({len(data) // 1024}KB) — max {_MAX_BYTES // (1024 * 1024)}MB.")
    name = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(_LOGO_DIR, name), "wb") as f:
        f.write(data)
    return {"status": "success", "logo_path": f"/api/v1/uploads/org_logos/{name}"}
