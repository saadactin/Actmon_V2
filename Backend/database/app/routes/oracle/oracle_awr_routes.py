"""Oracle AWR Analyzer endpoints.

Reports are scoped to the caller's organisation; linking one to a monitored
Oracle connection is optional (see oracle_awr_service.py's module docstring).
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.auth.tenant_context import tenant_ctx, scope_org_id, create_org_id
from app.services.oracle import oracle_awr_service, oracle_awr_analysis

router = APIRouter(prefix="/api/v1/oracle/awr", tags=["Oracle AWR Analyzer"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _uploader(ctx: dict) -> Optional[str]:
    user_id = (ctx or {}).get("user_id")
    return str(user_id) if user_id is not None else None


@router.post("/upload")
async def upload_awr_report(
    file: UploadFile = File(...),
    connection_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx),
):
    return await oracle_awr_service.upload_and_analyze(
        create_org_id(ctx), file, _uploader(ctx), db, connection_id=connection_id,
    )


@router.post("/batch-upload")
async def batch_upload_awr_reports(
    files: list[UploadFile] = File(...),
    connection_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    ctx: dict = Depends(tenant_ctx),
):
    batch_id = uuid.uuid4().hex
    results = []
    for f in files:
        result = await oracle_awr_service.upload_and_analyze(
            create_org_id(ctx), f, _uploader(ctx), db, connection_id=connection_id, batch_id=batch_id,
        )
        results.append({"filename": f.filename, **result})
    parsed = sum(1 for r in results if r.get("report", {}).get("status") == "PARSED")
    return {
        "status": "ok",
        "batch_id": batch_id,
        "total": len(files),
        "succeeded": parsed,
        "failed": len(files) - parsed,
        "results": results,
    }


@router.get("/")
def list_awr_reports(connection_id: Optional[int] = None, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.list_reports(scope_org_id(ctx), db, connection_id=connection_id)


@router.get("/{report_id}")
def get_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.get_report(report_id, scope_org_id(ctx), db)


@router.get("/{report_id}/insights")
def get_awr_report_insights(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.get_report_insights(report_id, scope_org_id(ctx), db)


@router.get("/{report_id}/download")
def download_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    row = oracle_awr_service.get_report_file(report_id, scope_org_id(ctx), db)
    if not row:
        return {"status": "error", "error": "Report not found"}
    # attachment, never inline: the upload is untrusted HTML and must not render
    # on this origin.
    return FileResponse(row.stored_path, media_type="text/html", filename=row.original_filename,
                        content_disposition_type="attachment")


@router.delete("/{report_id}")
def delete_awr_report(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_service.delete_report(report_id, scope_org_id(ctx), db)


@router.post("/{report_id}/analyze-groq")
def analyze_awr_groq(report_id: int, db: Session = Depends(get_db), ctx: dict = Depends(tenant_ctx)):
    return oracle_awr_analysis.analyze_awr_groq(report_id, scope_org_id(ctx), db)
