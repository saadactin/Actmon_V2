"""Resource assessment report builder: preview, generate, templates, history,
schedules.

Generalizes `resources.py`'s `/assessment-export` (still live, unchanged)
into a real Scope -> Sections -> Layout -> Preview -> Generate flow. See
`app.services.report_service` for what each section actually is and
`app.services.account_report_service` for history and scheduling.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.api.routes.resources import _handle
from app.schemas.reports import ReportRequest
from app.services import account_report_service as ars
from app.services import report_service as rs
from app.services.resource_assessment_service import TooManyResourcesError

router = APIRouter(prefix="/cloud/reports", tags=["Reports"])

PREVIEW_ROWS_PER_SECTION = 50

report_slug = ars.report_slug   # kept importable from here (tests, older callers)


def _truncate_for_preview(dataset: dict) -> dict:
    """Cap each tabular section to a small sample, with `truncated` + the
    real total alongside it -- the Preview step must label a sample as a
    sample, never silently show fewer rows than the export would contain."""
    out = dict(dataset)
    sections = {}
    for name, rows in dataset.get("sections", {}).items():
        if not isinstance(rows, list):
            sections[name] = rows
            continue
        sections[name] = {
            "rows": rows[:PREVIEW_ROWS_PER_SECTION],
            "total": len(rows),
            "truncated": len(rows) > PREVIEW_ROWS_PER_SECTION,
        }
    out["sections"] = sections
    out["coverage"] = {
        name: {**cov, "without": cov.get("without", [])[:PREVIEW_ROWS_PER_SECTION],
               "without_truncated": len(cov.get("without", [])) > PREVIEW_ROWS_PER_SECTION}
        for name, cov in dataset.get("coverage", {}).items()
    }
    return out


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, ars.ReportError):
        return HTTPException(status_code=exc.status, detail=exc.message)
    if isinstance(exc, TooManyResourcesError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, HTTPException):
        return exc
    return _handle(exc)


@router.post("/preview")
async def preview_report(
    body: ReportRequest,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    """A capped look at what `/generate` would produce -- the same dataset,
    built the same way, with each row section cut to a sample and no file
    bytes."""
    try:
        _ids, total, dataset, snapshot = await rs.build_for_request(db, body)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)
    await ars.attach_comparison(db, body, dataset, snapshot)
    return {"resolved_scope": {"resource_count": total},
            "preview": _truncate_for_preview(dataset)}


@router.post("/generate")
async def generate_report(
    body: ReportRequest,
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    try:
        row, content, info = await ars.produce(
            db, body, actor=principal.name, template_name=body.template_name, keep=body.keep)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)
    headers = {"Content-Disposition": f'attachment; filename="{info["filename"]}"',
               "X-Resources-Resolved": str(info["resources"])}
    if row is not None:
        headers["X-Report-Id"] = str(row.id)
    return Response(content=content, media_type=info["media_type"], headers=headers)


# ── Templates ────────────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates(
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    return {"templates": await ars.list_templates(db)}


@router.post("/templates")
async def create_template(
    data: Dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    try:
        return await ars.save_template(db, data, actor=principal.name)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)


@router.put("/templates/{template_id}")
async def update_template(
    template_id: uuid.UUID,
    data: Dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    try:
        return await ars.save_template(db, data, actor=principal.name, template_id=template_id)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    if not await ars.delete_template(db, template_id):
        raise HTTPException(status_code=404, detail="Template not found.")
    return {"deleted": True}


# ── History ──────────────────────────────────────────────────────────────────

@router.get("/history/{account_id}")
async def list_history(
    account_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    return {"reports": await ars.list_history(db, account_id, limit),
            "keep": ars.KEEP_REPORTS_PER_ACCOUNT}


@router.get("/history/{account_id}/{report_id}/download")
async def download_report(
    account_id: uuid.UUID,
    report_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    row = await ars.get_with_content(db, account_id, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Report not found.")
    if row.content is None:
        raise HTTPException(status_code=410, detail=row.content_note or row.error
                            or "This report's file was not kept.")
    return Response(content=bytes(row.content), media_type=row.content_type or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{row.filename}"'})


@router.delete("/history/{account_id}/{report_id}")
async def delete_history_report(
    account_id: uuid.UUID,
    report_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    if not await ars.delete_report(db, account_id, report_id):
        raise HTTPException(status_code=404, detail="Report not found.")
    return {"deleted": True}


# ── Schedules ────────────────────────────────────────────────────────────────

@router.get("/schedules/{account_id}")
async def list_schedules(
    account_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    return {"schedules": await ars.list_schedules(db, account_id),
            "delivery": await ars.delivery_status(db)}


@router.post("/schedules/{account_id}")
async def create_schedule(
    account_id: uuid.UUID,
    data: Dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    try:
        return await ars.save_schedule(db, account_id, data, actor=principal.name)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)


@router.put("/schedules/{account_id}/{schedule_id}")
async def update_schedule(
    account_id: uuid.UUID,
    schedule_id: uuid.UUID,
    data: Dict[str, Any] = Body(...),
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    try:
        return await ars.save_schedule(db, account_id, data, actor=principal.name,
                                       schedule_id=schedule_id)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)


@router.delete("/schedules/{account_id}/{schedule_id}")
async def delete_schedule(
    account_id: uuid.UUID,
    schedule_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    if not await ars.delete_schedule(db, account_id, schedule_id):
        raise HTTPException(status_code=404, detail="Schedule not found.")
    return {"deleted": True}


@router.post("/schedules/{account_id}/{schedule_id}/run")
async def run_schedule(
    account_id: uuid.UUID,
    schedule_id: uuid.UUID,
    send: bool = Query(False, description="Also e-mail it to the schedule's recipients"),
    db: AsyncSession = Depends(get_db),
    principal: rbac.Principal = Depends(rbac.require(rbac.REPORT_MANAGE)),
):
    """Produce a schedule's report now, into history; e-mail it only when
    `send` is true. Does not move the schedule's next run."""
    try:
        return await ars.run_schedule_now(db, account_id, schedule_id, actor=principal.name, send=send)
    except Exception as exc:  # noqa: BLE001
        raise _error(exc)
