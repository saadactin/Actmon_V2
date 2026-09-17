"""Resource inventory routes — list, query, drill-down.

ROUTE ORDER MATTERS HERE
------------------------
`/{account_id}` is a single-segment path, so it will happily match any literal
that is not already claimed by a route declared before it. Every static path in
this module — /query, /reference, /detail/... — is therefore declared ABOVE it.
This is not a stylistic preference: the same shape in the cost routes swallowed
/cloud/cost/budgets and turned it into a 422 on an account-id UUID parse.

BACKWARD COMPATIBILITY
----------------------
`GET /cloud/resources/` and `GET /cloud/resources/{account_id}` still return a
bare JSON array of resources when called with no query parameters, exactly as
before. The existing table, the topology page and the drift page all consume
that shape. The paginated envelope lives at /query, so nothing that works today
has to change to keep working.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import (
    get_db, get_resource_query_service, get_resource_service,
    get_resource_view_service, get_resource_action_service,
)
from app.repository.resource_query_repo import QueryValidationError
from app.schemas.resource import CloudResourceDetail, CloudResourceResponse
from app.services.resource_query_service import ResourceQueryService, ScopeError
from app.services.resource_service import ResourceService
from app.services.resource_action_service import (
    ActionError, ResourceActionService, available_actions,
)
from app.services.resource_view_service import ResourceViewService, ViewValidationError

router = APIRouter(prefix="/cloud/resources", tags=["Resources"])


# ── Shared query parameters ──────────────────────────────────────────────────
# Declared once so /query, /summary, /facets, /groups and /export cannot drift
# apart — a filter that works in the table and is silently ignored by the export
# is how an export ends up containing rows the user filtered out.
def resource_filters(
    q: Optional[str] = Query(None, description="Free text: name, provider ID, IP, type, region, account, tag value"),
    provider: Optional[List[str]] = Query(None),
    type: Optional[List[str]] = Query(None),           # noqa: A002
    category: Optional[List[str]] = Query(None),
    region: Optional[List[str]] = Query(None),
    status: Optional[List[str]] = Query(None, description="Normalized status, not the provider's own word"),
    risk: Optional[List[str]] = Query(None, description="CRITICAL|HIGH|MEDIUM|LOW|INFO|NONE|UNKNOWN"),
    environment: Optional[List[str]] = Query(None),
    owner: Optional[List[str]] = Query(None),
    resource_group: Optional[List[str]] = Query(None),
    compartment: Optional[List[str]] = Query(None),
    attachment: Optional[str] = Query(None, description="ATTACHED|UNATTACHED"),
    has_tags: Optional[bool] = Query(None),
    tag_key: Optional[str] = Query(None),
    tag_value: Optional[str] = Query(None),
    missing_tag: Optional[str] = Query(None),
    has_cost: Optional[bool] = Query(None),
    cost_min: Optional[float] = Query(None, ge=0),
    cost_max: Optional[float] = Query(None, ge=0),
    has_findings: Optional[bool] = Query(None),
    updated_after: Optional[datetime] = Query(None),
    updated_before: Optional[datetime] = Query(None),
    stale: Optional[bool] = Query(None),
    include_defaults: bool = Query(True, description="False hides provider-created boilerplate"),
    sort: Optional[str] = Query(None),
    dir: Optional[str] = Query(None),                  # noqa: A002
    page: Optional[int] = Query(None, ge=1),
    page_size: Optional[int] = Query(None, ge=1),
) -> Dict[str, Any]:
    return {
        "q": q, "provider": provider, "type": type, "category": category,
        "region": region, "status": status, "risk": risk,
        "environment": environment, "owner": owner,
        "resource_group": resource_group, "compartment": compartment,
        "attachment": attachment, "has_tags": has_tags, "tag_key": tag_key,
        "tag_value": tag_value, "missing_tag": missing_tag,
        "has_cost": has_cost, "cost_min": cost_min, "cost_max": cost_max,
        "has_findings": has_findings, "updated_after": updated_after,
        "updated_before": updated_before, "stale": stale,
        "include_defaults": include_defaults,
        "sort": sort, "dir": dir, "page": page, "page_size": page_size,
    }


def _handle(exc: Exception) -> HTTPException:
    """Map a refusal onto the standard error envelope (spec §66)."""
    if isinstance(exc, QueryValidationError):
        return HTTPException(status_code=400, detail={
            "error": {
                "category": "validation",
                "message": str(exc),
                "field": exc.field_name,
                "allowed": exc.allowed,
                "retryable": False,
            }
        })
    if isinstance(exc, ScopeError):
        return HTTPException(status_code=404, detail={
            "error": {
                "category": "not_found",
                "message": str(exc),
                "retryable": False,
            }
        })
    raise exc


# ── Saved views ──────────────────────────────────────────────────────────────
# /views is a single-segment literal, so it MUST be declared above
# /{account_id} or FastAPI will try to parse the word "views" as an account
# UUID and return 422. Same trap the module header describes.
class SavedViewBody(BaseModel):
    name: str
    scope: str = "ALL"
    filters: Dict[str, Any] = {}
    description: Optional[str] = None
    columns: Optional[List[str]] = None
    sort: Optional[str] = None
    dir: Optional[str] = None                          # noqa: A003
    group_by: Optional[str] = None


def _view_error(exc: ViewValidationError) -> HTTPException:
    return HTTPException(status_code=400, detail={
        "error": {
            "category": "validation",
            "message": str(exc),
            "field": exc.field_name,
            "retryable": False,
        }
    })


@router.get("/views")
async def list_saved_views(
    scope: Optional[str] = Query(None, description="Account id or ALL"),
    svc: ResourceViewService = Depends(get_resource_view_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """The caller's saved views, filtered to those usable in this scope."""
    return {"views": await svc.list_views(principal.name or "", scope)}


@router.post("/views", status_code=201)
async def save_view(
    body: SavedViewBody,
    svc: ResourceViewService = Depends(get_resource_view_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Create a view, or overwrite the caller's view of the same name.

    Overwriting on name collision is deliberate: the alternative is a menu with
    three entries called "Untagged production" that differ invisibly.
    """
    try:
        return await svc.save(
            owner=principal.name or "",
            name=body.name,
            scope=body.scope,
            filters=body.filters,
            description=body.description,
            columns=body.columns,
            sort=body.sort,
            direction=body.dir,
            group_by=body.group_by,
        )
    except ViewValidationError as exc:
        raise _view_error(exc)


@router.delete("/views/{view_id}", status_code=204)
async def delete_view(
    view_id: uuid.UUID,
    svc: ResourceViewService = Depends(get_resource_view_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    try:
        removed = await svc.delete(view_id, principal.name or "")
    except ViewValidationError as exc:
        raise _view_error(exc)
    if not removed:
        raise HTTPException(status_code=404, detail={
            "error": {"category": "not_found", "message": "No such saved view.",
                      "retryable": False}
        })
    return Response(status_code=204)


# ── Actions ──────────────────────────────────────────────────────────────────
# Also above /{account_id}: /actions would otherwise be parsed as an account id.
#
# Nothing here can currently change a cloud resource. Every mutating capability
# is False because no provider adapter implements a write, so `execute` refuses
# at the support gate and audits the refusal. The preview path is fully real —
# permission, provider support, resource state and topology dependencies are all
# genuinely evaluated — which is what a confirmation dialog needs, and what the
# first provider write to land will already be wrapped in.
class ActionBody(BaseModel):
    resource_id: uuid.UUID
    action: str
    dry_run: bool = True
    operation_id: Optional[str] = None
    params: Optional[Dict[str, Any]] = None


class BulkActionBody(BaseModel):
    resource_ids: List[uuid.UUID]
    action: str
    dry_run: bool = True
    operation_id: Optional[str] = None
    params: Optional[Dict[str, Any]] = None


def _action_error(exc: ActionError) -> HTTPException:
    return HTTPException(status_code=400, detail={
        "error": {
            "category": "validation",
            "message": str(exc),
            "field": exc.field_name,
            "retryable": False,
        }
    })


@router.get("/actions/available")
async def list_available_actions(
    provider: Optional[str] = Query(None),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Every action and whether this provider can perform it.

    Unsupported actions are returned WITH their reason rather than omitted, so
    the UI can disable a control and say why instead of leaving a gap the user
    has to interpret.
    """
    return {"provider": provider, "actions": available_actions(provider)}


@router.post("/actions")
async def run_resource_action(
    body: ActionBody,
    svc: ResourceActionService = Depends(get_resource_action_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Preview an action (`dry_run: true`, the default) or attempt it.

    The default is a preview on purpose: a client that forgets the flag gets
    the safe behaviour, not the irreversible one.
    """
    try:
        if body.dry_run:
            return await svc.preview(
                body.resource_id, body.action,
                principal=principal, params=body.params,
            )
        return await svc.execute(
            body.resource_id, body.action,
            principal=principal,
            operation_id=body.operation_id,
            params=body.params,
        )
    except ActionError as exc:
        raise _action_error(exc)


@router.post("/actions/bulk")
async def run_bulk_action(
    body: BulkActionBody,
    svc: ResourceActionService = Depends(get_resource_action_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Preview a bulk action across a selection.

    Execution is intentionally not wired: a bulk write would fan out provider
    calls that do not exist, and the per-resource preview below already reports
    what each one would do.
    """
    try:
        preview = await svc.preview_bulk(
            body.resource_ids, body.action,
            principal=principal, params=body.params,
        )
    except ActionError as exc:
        raise _action_error(exc)

    if body.dry_run:
        return preview
    raise HTTPException(status_code=409, detail={
        "error": {
            "category": "unsupported",
            "message": (
                "Bulk execution is not available: no provider adapter implements "
                "a resource write. The preview reports what each selected "
                "resource would do."
            ),
            "retryable": False,
        }
    })


@router.get("/actions/history")
async def get_action_history(
    account_id: Optional[uuid.UUID] = Query(None),
    resource_id: Optional[uuid.UUID] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    svc: ResourceActionService = Depends(get_resource_action_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """The append-only action trail, including refusals."""
    return {
        "actions": await svc.history(
            account_id=account_id, resource_id=resource_id, limit=limit,
        )
    }


# ── Static paths — MUST precede /{account_id} ────────────────────────────────
@router.get("/reference/{account_id}")
async def get_resource_reference(
    account_id: str,
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Every vocabulary the workspace renders: statuses, categories, risk
    levels, the resource-type registry, sortable and groupable fields, and the
    provider capability matrix for this scope.

    Served from the backend on purpose. The current table keeps its own
    hardcoded map of ~60 resource types; the scanners now emit 83, so that map
    is already wrong and silently renders the difference as generic. A registry
    the frontend reads cannot drift from the one the backend groups by.
    """
    try:
        return await svc.reference(account_id)
    except Exception as exc:
        raise _handle(exc)


@router.get("/query/{account_id}")
async def query_resources(
    account_id: str,
    filters: Dict[str, Any] = Depends(resource_filters),
    group_by: Optional[str] = Query(None),
    include_facets: bool = Query(True),
    include_summary: bool = Query(True),
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """One page of the inventory, with the counts that describe it.

    `account_id` is a UUID or the literal "ALL" for the cross-account view.

    Rows, total, facet counts and summary cards are all produced from the same
    filter, in the same request. That is what stops the header, the rail and
    the table disagreeing about how many resources there are — the single most
    common defect in inventory UIs, and one the old browser-side filtering made
    structurally unavoidable.
    """
    try:
        return await svc.query(
            account_id,
            include_facets=include_facets,
            include_summary=include_summary,
            group_by=group_by,
            **filters,
        )
    except Exception as exc:
        raise _handle(exc)


@router.get("/summary/{account_id}")
async def get_resource_summary(
    account_id: str,
    filters: Dict[str, Any] = Depends(resource_filters),
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """The header strip and data-quality panel on their own.

    Separate from /query so the page shell can render its totals immediately
    without waiting for a row page it is about to re-request anyway.
    """
    try:
        return await svc.summary(account_id, **filters)
    except Exception as exc:
        raise _handle(exc)


@router.get("/facets/{account_id}")
async def get_resource_facets(
    account_id: str,
    filters: Dict[str, Any] = Depends(resource_filters),
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Facet counts in the current filter context.

    A facet's own filter is excluded from its own counts, so selecting one type
    does not zero out every other type in the rail.
    """
    try:
        return await svc.facets(account_id, **filters)
    except Exception as exc:
        raise _handle(exc)


@router.get("/groups/{account_id}")
async def get_resource_groups(
    account_id: str,
    group_by: str = Query(..., description="provider|account|region|resource_type|normalized_type|status|risk|environment|owner|resource_group|compartment"),
    filters: Dict[str, Any] = Depends(resource_filters),
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Server-aggregated groups. Cost totals are per currency and never summed
    across them — this estate bills in both INR and USD, and a combined figure
    would be a number denominated in nothing."""
    try:
        return await svc.groups(account_id, group_by, **filters)
    except Exception as exc:
        raise _handle(exc)


@router.get("/export/{account_id}")
async def export_resources(
    account_id: str,
    filters: Dict[str, Any] = Depends(resource_filters),
    svc: ResourceQueryService = Depends(get_resource_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_EXPORT)),
):
    """CSV of exactly the filtered set, with a metadata preamble.

    Gated on `resources:export` rather than `resources:view`: this is a file
    built to leave the building, which is the distinction that permission
    exists to draw. Pagination is deliberately ignored — the export covers
    every matching row, not the page on screen.
    """
    try:
        # page/page_size describe the on-screen page and must not truncate a
        # file the user asked for the whole of.
        params = {**filters, "page": None, "page_size": None}
        body, meta = await svc.export_csv(account_id, **params)
    except Exception as exc:
        raise _handle(exc)

    stamp = meta["generated_at"][:19].replace(":", "").replace("-", "")
    return Response(
        content=body,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="resources-{stamp}.csv"',
            "X-Resource-Rows": str(meta["rows"]),
        },
    )


# NOTE: /detail/{resource_id} MUST be declared before /{account_id}
# to prevent FastAPI matching "detail" as an account_id UUID (which fails)
@router.get("/detail/{resource_id}", response_model=CloudResourceDetail)
async def get_resource_detail(
    resource_id: uuid.UUID,
    svc: ResourceService = Depends(get_resource_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Return full configuration, metadata, and raw data for a single resource."""
    resource = await svc.get_resource_detail(resource_id)
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")
    return resource


@router.get("/detail/{resource_id}/metrics")
async def get_resource_metrics(
    resource_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Return historical performance metrics for a single resource."""
    from app.services.metrics_service import get_resource_metrics as fetch_metrics
    metrics = await fetch_metrics(resource_id, db)
    if "error" in metrics:
        raise HTTPException(status_code=404, detail=metrics["error"])
    return metrics


# ── Legacy list endpoints, unchanged in shape ────────────────────────────────
@router.get("/", response_model=List[CloudResourceResponse])
async def list_all_resources(
    svc: ResourceService = Depends(get_resource_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Return the full resource inventory across all cloud accounts.

    Kept as-is for the callers that already depend on a plain array. New work
    should use /query/ALL, which pages and does not require the browser to hold
    the estate in memory.
    """
    return await svc.list_all_resources()


@router.get("/{account_id}", response_model=List[CloudResourceResponse])
async def list_resources(
    account_id: uuid.UUID,
    svc: ResourceService = Depends(get_resource_service),
    _: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Return the full resource inventory for a cloud account."""
    return await svc.list_resources(account_id)
