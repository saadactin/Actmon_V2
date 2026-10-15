"""Resource assessment report builder: preview + generate.

Generalizes `resources.py`'s `/assessment-export` (still live, unchanged)
into a real Scope -> Sections -> Layout -> Preview -> Generate flow. See
`app.services.report_service` for what each section actually is.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.api.routes.resources import _handle
from app.schemas.reports import (
    FORMAT_CSV, FORMAT_JSON, FORMAT_PDF, FORMAT_XLSX, ReportRequest,
)
from app.services import report_service as rs
from app.services.report_renderers import csv_renderer, json_renderer, pdf_renderer, xlsx_renderer
from app.services.resource_assessment_service import TooManyResourcesError
from fastapi import Response

router = APIRouter(prefix="/cloud/reports", tags=["Reports"])

PREVIEW_ROWS_PER_SECTION = 50

_MEDIA_TYPES = {
    FORMAT_CSV: "text/csv",
    FORMAT_JSON: "application/json",
    FORMAT_PDF: "application/pdf",
    FORMAT_XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
_EXTENSIONS = {FORMAT_CSV: "csv", FORMAT_JSON: "json", FORMAT_PDF: "pdf", FORMAT_XLSX: "xlsx"}


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
    return out


@router.post("/preview")
async def preview_report(
    body: ReportRequest,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    """A cheap, capped look at what `/generate` would produce -- no file
    bytes, so the UI can re-call this on every wizard step without
    regenerating a full report on every checkbox click."""
    try:
        resource_ids, total_matching = await rs.resolve_report_scope(db, body.account_id, body.scope)
    except TooManyResourcesError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # ScopeError and friends
        raise _handle(exc)

    dataset = await rs.build_report_dataset(
        db, body.account_id, resource_ids, body.sections, body.date_range,
    )
    return {
        "resolved_scope": {"resource_count": total_matching},
        "preview": _truncate_for_preview(dataset),
    }


@router.post("/generate")
async def generate_report(
    body: ReportRequest,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    try:
        resource_ids, _total = await rs.resolve_report_scope(db, body.account_id, body.scope)
    except TooManyResourcesError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise _handle(exc)

    if not resource_ids:
        raise HTTPException(status_code=400, detail="The selected scope matches no resources.")

    dataset = await rs.build_report_dataset(
        db, body.account_id, resource_ids, body.sections, body.date_range,
    )
    dataset["metadata"] = body.layout.metadata.model_dump()
    dataset["generated_at"] = datetime.now(timezone.utc).isoformat()

    fmt = body.layout.format
    if fmt == FORMAT_CSV:
        content = csv_renderer.build_csv(dataset)
    elif fmt == FORMAT_JSON:
        content = json_renderer.build_json(dataset)
    elif fmt == FORMAT_PDF:
        content = pdf_renderer.build_pdf(
            dataset, metadata=dataset["metadata"], detail_level=body.layout.detail_level,
        )
    elif fmt == FORMAT_XLSX:
        content = xlsx_renderer.build_xlsx(dataset)
    else:  # pragma: no cover - schema validation already rejects this
        raise HTTPException(status_code=400, detail=f"Unsupported format: {fmt}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    ext = _EXTENSIONS[fmt]
    filename = f"resource-assessment-{stamp}.{ext}"
    return Response(
        content=content,
        media_type=_MEDIA_TYPES[fmt],
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Resources-Resolved": str(len(resource_ids)),
        },
    )
