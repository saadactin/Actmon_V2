"""Event Log HTTP endpoints — the unified cloud audit trail.

Every route is a read except three, and those three are deliberate:
`/collect` (fetch more events), `/settings` (retention and collection policy)
and `/queries` (a user's saved filters). There is no endpoint that edits or
deletes an event, and there is no plan for one — see app/models/cloud_event.py.

Two conventions worth knowing:

*   **Filters are validated, never ignored.** An unknown value produces a 400
    that names the field and lists what is accepted. Silently dropping it would
    return a full unfiltered page, which reads as a valid answer to a question
    that was never asked.

*   **Time is always UTC on the wire.** Every response carries a `window`
    block with explicit `start_utc` / `end_utc`, so the client converts for
    display rather than guessing what the server meant.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.api import rbac
from app.api.deps import get_event_service
from app.core.database import AsyncSessionLocal
from app.models.cloud_event import (
    ACCESS_METHODS,
    ACTIONS,
    ACTOR_TYPES,
    CATEGORIES,
    CloudEvent,
    EVENT_STATUSES,
    RISK_LEVELS,
)
from app.models.event_admin import (
    ACCESS_COLLECTION_TRIGGERED,
    ACCESS_EXPORT,
    ACCESS_VIEW_RAW,
)
from app.repository.event_repo import EventRepository, FilterError
from app.services.event_service import (
    EXPORT_MAX_ROWS,
    NAMED_RANGES,
    PAGE_SIZES,
    EventService,
)

logger = logging.getLogger("cloud_svc.events.api")

router = APIRouter(prefix="/cloud/events", tags=["Event Log"])


# ── Shared parameter handling ─────────────────────────────────────────────────


def _validate(name: str, value: Optional[str], allowed) -> None:
    if value is not None and value != "" and value not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {name}={value!r}. Expected one of: {', '.join(allowed)}",
        )


class EventFilters:
    """The filter set every list-shaped endpoint accepts.

    One class so `/events`, `/events/stats`, `/events/timeline` and
    `/events/export` cannot drift apart — an export that honours a different
    filter set from the table it was exported from is the specification's
    explicit warning about export respecting the current filters.
    """

    def __init__(
        self,
        account_id: Optional[str] = Query(None, description="Limit to one cloud account."),
        range: Optional[str] = Query(
            None, alias="range",
            description=f"Named window. One of: {', '.join(NAMED_RANGES)}. Default 24h.",
        ),
        start: Optional[str] = Query(None, description="Custom range start (ISO-8601, UTC)."),
        end: Optional[str] = Query(None, description="Custom range end (ISO-8601, UTC)."),
        provider: Optional[str] = Query(None, description="AWS | Azure | OCI"),
        event_category: Optional[str] = Query(None),
        provider_category: Optional[str] = Query(
            None, description="The provider's own category, e.g. Administrative."
        ),
        action: Optional[str] = Query(None),
        status: Optional[str] = Query(None, description="Success | Failed | Denied | Partial"),
        risk_level: Optional[str] = Query(None, description="Exactly this level."),
        min_risk: Optional[str] = Query(
            None, description="This level or above (INFO < LOW < MEDIUM < HIGH < CRITICAL)."
        ),
        actor_name: Optional[str] = Query(None),
        actor_type: Optional[str] = Query(None),
        resource_type: Optional[str] = Query(None),
        resource_id: Optional[str] = Query(None),
        region: Optional[str] = Query(None),
        account_ref: Optional[str] = Query(None, description="Cloud account/subscription/tenancy id."),
        subscription_id: Optional[str] = Query(None),
        tenant_id: Optional[str] = Query(None),
        compartment_name: Optional[str] = Query(None),
        resource_group: Optional[str] = Query(None),
        access_method: Optional[str] = Query(None),
        event_name: Optional[str] = Query(None),
        source_ip: Optional[str] = Query(None),
        correlation_id: Optional[str] = Query(None),
        request_id: Optional[str] = Query(None),
        search: Optional[str] = Query(
            None, description="Partial match across actor, resource, event, IP and id fields."
        ),
        exclude_read_only: bool = Query(
            False, description="Hide events the provider marked read-only."
        ),
    ) -> None:
        _validate("provider", provider, ("AWS", "Azure", "OCI"))
        _validate("event_category", event_category, CATEGORIES)
        _validate("action", action, ACTIONS)
        _validate("status", status, EVENT_STATUSES)
        _validate("risk_level", risk_level, RISK_LEVELS)
        _validate("min_risk", min_risk, RISK_LEVELS)
        _validate("actor_type", actor_type, ACTOR_TYPES)
        _validate("access_method", access_method, ACCESS_METHODS)
        if range is not None and range not in NAMED_RANGES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid range={range!r}. Expected one of: {', '.join(NAMED_RANGES)}, "
                       f"or supply explicit start/end.",
            )

        self.account_id = account_id
        self.range_key = range
        self.start = start
        self.end = end
        self.provider = provider
        self.search = search
        self.min_risk = min_risk
        self.exclude_read_only = exclude_read_only
        # Only non-empty values become clauses: an empty string from a cleared
        # dropdown must mean "no filter", not "match the empty string".
        self.simple = {
            key: value
            for key, value in {
                "event_category": event_category,
                "provider_category": provider_category,
                "action": action,
                "status": status,
                "risk_level": risk_level,
                "actor_name": actor_name,
                "actor_type": actor_type,
                "resource_type": resource_type,
                "resource_id": resource_id,
                "region": region,
                "account_ref": account_ref,
                "subscription_id": subscription_id,
                "tenant_id": tenant_id,
                "compartment_name": compartment_name,
                "resource_group": resource_group,
                "access_method": access_method,
                "event_name": event_name,
                "source_ip": source_ip,
                "correlation_id": correlation_id,
                "request_id": request_id,
            }.items()
            if value not in (None, "")
        }

    def as_kwargs(self, advanced: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return {
            "account_id": self.account_id,
            "range_key": self.range_key,
            "start": self.start,
            "end": self.end,
            "provider": self.provider,
            "filters": self.simple,
            "search": self.search,
            "min_risk": self.min_risk,
            "advanced": advanced,
            "exclude_read_only": self.exclude_read_only,
        }

    def describe(self) -> Dict[str, Any]:
        """What was actually applied — echoed into an export so the file can
        state the filters it represents."""
        described = dict(self.simple)
        described.update(
            {
                k: v for k, v in {
                    "account_id": self.account_id,
                    "provider": self.provider,
                    "search": self.search,
                    "min_risk": self.min_risk,
                    "range": self.range_key,
                    "start": self.start,
                    "end": self.end,
                    "exclude_read_only": self.exclude_read_only or None,
                }.items() if v not in (None, "", False)
            }
        )
        return described


def _parse_advanced(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    """Parse the advanced-filter tree from its JSON query parameter.

    A query parameter rather than a body because these endpoints are GETs that
    must stay cacheable and linkable — a saved query is a URL. Malformed JSON
    is a 400 naming the problem, never a silently-dropped filter.
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"advanced_filter must be a JSON object: {exc}",
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=400, detail="advanced_filter must be a JSON object.",
        )
    return parsed


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("", response_model=Dict[str, Any])
async def list_events(
    request: Request,
    filters: EventFilters = Depends(),
    advanced_filter: Optional[str] = Query(
        None,
        description=(
            'AND/OR condition tree as JSON, e.g. '
            '{"op":"AND","conditions":[{"field":"action","operator":"in",'
            '"value":["Delete","Modify"]},{"field":"risk_level","operator":"gte",'
            '"value":"HIGH"}]}'
        ),
    ),
    sort: str = Query("newest"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """The event feed, newest first, server-side filtered and paginated."""
    if page_size not in PAGE_SIZES:
        raise HTTPException(
            status_code=400,
            detail=f"page_size must be one of: {', '.join(str(s) for s in PAGE_SIZES)}",
        )
    if filters.search and not principal.can(rbac.SEARCH):
        # Through rbac.deny, not an inline raise: searching is a permission
        # like any other, and a refusal that skips the recorder is the one
        # refusal nobody can audit afterwards.
        await rbac.deny(principal, rbac.SEARCH, request)
    try:
        result = await svc.list_events(
            **filters.as_kwargs(_parse_advanced(advanced_filter)),
            sort=sort, page=page, page_size=page_size,
        )
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result["access"] = principal.to_dict()
    return result


@router.get("/stats", response_model=Dict[str, Any])
async def event_stats(
    filters: EventFilters = Depends(),
    advanced_filter: Optional[str] = Query(None),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Summary counters for the current filter set.

    These are computed from the same filters as the list, so the cards and the
    table always agree. Nothing here is a stored or cached total.
    """
    try:
        return await svc.stats(**filters.as_kwargs(_parse_advanced(advanced_filter)))
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/timeline", response_model=Dict[str, Any])
async def event_timeline(
    filters: EventFilters = Depends(),
    advanced_filter: Optional[str] = Query(None),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Bucketed counts for the timeline view. The bucket width is chosen from
    the window so the response stays bounded."""
    try:
        return await svc.timeline(**filters.as_kwargs(_parse_advanced(advanced_filter)))
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/facets", response_model=Dict[str, Any])
async def event_facets(
    account_id: Optional[str] = Query(None),
    range: Optional[str] = Query(None, alias="range"),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Filter options present in this window, plus the full vocabulary and the
    query capabilities (operators, sortable fields, searchable fields)."""
    return await svc.facets(account_id=account_id, range_key=range, start=start, end=end)


@router.get("/sources", response_model=Dict[str, Any])
async def event_sources(
    account_id: Optional[str] = Query(None),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Per-provider collection health.

    The endpoint that makes "no events" and "collection is broken"
    distinguishable — the two conditions that look identical in a table.
    """
    return await svc.source_status(_parse_uuid_or_none(account_id))


@router.get("/collection", response_model=Dict[str, Any])
async def collection_status(
    account_id: Optional[str] = Query(None),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Ingestion detail: per-scope checkpoints, counters and last errors, plus
    the observability metrics and the retention comparison."""
    return await svc.collection_status(account_id)


@router.get("/actors", response_model=Dict[str, Any])
async def event_actors(
    filters: EventFilters = Depends(),
    limit: int = Query(25, ge=1, le=200),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """The principals active in this window, busiest first."""
    window_start, window_end, label = svc.resolve_window(
        range_key=filters.range_key, start=filters.start, end=filters.end
    )
    try:
        actors = await svc.repo.top_actors(
            limit=limit,
            account_id=_parse_uuid_or_none(filters.account_id),
            start=window_start, end=window_end, provider=filters.provider,
            simple=filters.simple, search=filters.search, min_risk=filters.min_risk,
            exclude_read_only=filters.exclude_read_only,
        )
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "items": actors,
        "window": svc._window_block(window_start, window_end, label),
    }


@router.get("/resources", response_model=Dict[str, Any])
async def event_resources(
    filters: EventFilters = Depends(),
    limit: int = Query(25, ge=1, le=200),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """The resources acted on in this window, busiest first."""
    window_start, window_end, label = svc.resolve_window(
        range_key=filters.range_key, start=filters.start, end=filters.end
    )
    try:
        resources = await svc.repo.top_resources(
            limit=limit,
            account_id=_parse_uuid_or_none(filters.account_id),
            start=window_start, end=window_end, provider=filters.provider,
            simple=filters.simple, search=filters.search, min_risk=filters.min_risk,
            exclude_read_only=filters.exclude_read_only,
        )
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "items": resources,
        "window": svc._window_block(window_start, window_end, label),
    }


@router.get("/for-resource", response_model=Dict[str, Any])
async def events_for_resource(
    account_id: Optional[str] = Query(None),
    resource_id: Optional[str] = Query(None),
    resource_name: Optional[str] = Query(None),
    around: Optional[str] = Query(
        None, description="ISO-8601 instant to search around — a drift detection time."
    ),
    hours: int = Query(72, ge=1, le=720),
    limit: int = Query(100, ge=1, le=500),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Events touching one resource — the Configuration Drift → Event Log link.

    Called from a drift finding with its resource and detection time; searches
    backwards from that instant, because a configuration change is observed by
    the scan that follows it.
    """
    if not resource_id and not resource_name:
        raise HTTPException(
            status_code=400,
            detail="Give at least one of resource_id or resource_name.",
        )
    return await svc.events_for_resource(
        account_id=account_id, resource_id=resource_id, resource_name=resource_name,
        around=around, hours=hours, limit=limit,
    )


@router.get("/rules", response_model=Dict[str, Any])
async def classification_rules(
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """The effective classification ruleset — how category, action and risk are
    decided, and how to override them."""
    return await svc.ruleset()


@router.get("/access", response_model=Dict[str, Any])
async def access_model(
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(200, ge=1, le=1000),
    principal: rbac.Principal = Depends(rbac.get_principal),
    svc: EventService = Depends(get_event_service),
):
    """The access model, and the audit of the audit system.

    Deliberately readable by any caller for the model half — the UI needs to
    know whether RBAC is enforced in order to say so. The access LOG half needs
    the audit-admin permission and is omitted otherwise, with a reason.
    """
    payload: Dict[str, Any] = {
        "rbac": rbac.rbac_summary(),
        "you": principal.to_dict(),
    }
    if principal.can(rbac.VIEW_ACCESS_LOG):
        entries = await svc.repo.list_access_log(days=days, limit=limit)
        payload["access_log"] = [e.to_dict() for e in entries]
    else:
        payload["access_log"] = None
        payload["access_log_withheld"] = (
            f"Viewing the Event Log's own access log needs {rbac.VIEW_ACCESS_LOG}, "
            f"which your role ({principal.role}) does not have."
        )
    return payload


# ── Settings ──────────────────────────────────────────────────────────────────


@router.get("/settings", response_model=Dict[str, Any])
async def get_settings(
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    payload = await svc.get_settings()
    payload["rbac"] = rbac.rbac_summary()
    payload["can_configure"] = principal.can(rbac.CONFIGURE)
    return payload


@router.put("/settings", response_model=Dict[str, Any])
async def update_settings(
    request: Request,
    body: Dict[str, Any] = Body(...),
    principal: rbac.Principal = Depends(rbac.require(rbac.CONFIGURE)),
    svc: EventService = Depends(get_event_service),
):
    """Change retention or collection policy.

    Validated rather than clamped: silently accepting `retention_days: 5000`
    and storing something else would leave the UI showing a value the server
    does not hold.
    """
    if "retention_days" in body and body["retention_days"] is not None:
        days = body["retention_days"]
        if not isinstance(days, int) or not 1 <= days <= 3650:
            raise HTTPException(
                status_code=400,
                detail="retention_days must be an integer between 1 and 3650.",
            )
    if "collection_interval_minutes" in body and body["collection_interval_minutes"] is not None:
        minutes = body["collection_interval_minutes"]
        if not isinstance(minutes, int) or not 1 <= minutes <= 1440:
            raise HTTPException(
                status_code=400,
                detail="collection_interval_minutes must be an integer between 1 and 1440.",
            )
    if "initial_lookback_hours" in body and body["initial_lookback_hours"] is not None:
        hours = body["initial_lookback_hours"]
        if not isinstance(hours, int) or not 1 <= hours <= 8760:
            raise HTTPException(
                status_code=400,
                detail="initial_lookback_hours must be an integer between 1 and 8760.",
            )
    for flag in ("collection_enabled", "collect_read_only"):
        if flag in body and body[flag] is not None and not isinstance(body[flag], bool):
            raise HTTPException(status_code=400, detail=f"{flag} must be true or false.")

    return await svc.update_settings(
        body, actor=principal.name, role=principal.role,
        source_ip=principal.source_ip,
    )


# ── Saved queries ─────────────────────────────────────────────────────────────


@router.get("/queries", response_model=Dict[str, Any])
async def list_saved_queries(
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    return {
        "items": await svc.list_saved_queries(principal.name),
        "can_save": principal.can(rbac.SAVE_QUERY),
    }


@router.post("/queries", response_model=Dict[str, Any])
async def save_query(
    body: Dict[str, Any] = Body(...),
    principal: rbac.Principal = Depends(rbac.require(rbac.SAVE_QUERY)),
    svc: EventService = Depends(get_event_service),
):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A saved query needs a name.")
    filters = body.get("filters")
    if not isinstance(filters, dict) or not filters:
        raise HTTPException(
            status_code=400,
            detail="A saved query needs a non-empty `filters` object.",
        )
    return await svc.save_query(
        name=name,
        filters=filters,
        description=body.get("description"),
        account_id=body.get("account_id"),
        owner=principal.name,
        role=principal.role,
        query_id=body.get("id"),
        source_ip=principal.source_ip,
    )


@router.delete("/queries/{query_id}", response_model=Dict[str, Any])
async def delete_saved_query(
    query_id: str,
    principal: rbac.Principal = Depends(rbac.require(rbac.SAVE_QUERY)),
    svc: EventService = Depends(get_event_service),
):
    removed = await svc.delete_saved_query(
        query_id, owner=principal.name, role=principal.role,
        source_ip=principal.source_ip,
    )
    if not removed:
        raise HTTPException(status_code=404, detail="Saved query not found.")
    return {"deleted": True, "id": query_id}


# ── Collection ────────────────────────────────────────────────────────────────


@router.post("/collect", response_model=Dict[str, Any])
async def trigger_collection(
    account_id: Optional[str] = Query(
        None, description="One account, or omit for every auto-discovery account."
    ),
    lookback_hours: Optional[int] = Query(
        None, ge=1, le=8760,
        description="Force a window instead of resuming from the checkpoint.",
    ),
    principal: rbac.Principal = Depends(rbac.require(rbac.COLLECT)),
    svc: EventService = Depends(get_event_service),
):
    """Collect now, synchronously, and report what happened.

    Synchronous on purpose: a "collect now" button whose result the user cannot
    see is indistinguishable from one that does nothing, and the per-scope
    outcome is the diagnostic the operator actually needs. The background loop
    is what handles routine collection.
    """
    from app.services.event_collector import collect_account, collect_all_accounts

    await svc.repo.record_access(
        ACCESS_COLLECTION_TRIGGERED,
        actor=principal.name, role=principal.role,
        target=account_id or "all-accounts",
        detail={"lookback_hours": lookback_hours},
        source_ip=principal.source_ip,
    )
    await svc.db.commit()

    if account_id:
        parsed = _parse_uuid_or_none(account_id)
        if parsed is None:
            raise HTTPException(status_code=400, detail="account_id must be a UUID.")
        outcomes = [await collect_account(parsed, lookback_hours=lookback_hours)]
    else:
        outcomes = await collect_all_accounts(only_auto=False)

    return {
        "results": outcomes,
        "events_stored": sum(o.get("events_stored", 0) or 0 for o in outcomes),
        "events_duplicate": sum(o.get("events_duplicate", 0) or 0 for o in outcomes),
        "scopes_failed": sum(o.get("scopes_failed", 0) or 0 for o in outcomes),
    }


# ── Export ────────────────────────────────────────────────────────────────────


# The columns a CSV export carries, in this order. Explicit rather than derived
# from the row dict, so a new column in `to_row` cannot silently reshape
# everyone's saved spreadsheets.
_EXPORT_COLUMNS = [
    ("timestamp", "Timestamp (UTC)"),
    ("provider", "Provider"),
    ("account_name", "Account"),
    ("actor_name", "Actor"),
    ("actor_type", "Actor type"),
    ("event_name", "Event"),
    ("api_operation", "API operation"),
    ("action", "Action"),
    ("event_category", "Category"),
    ("resource_name", "Resource"),
    ("resource_type", "Resource type"),
    ("resource_id", "Resource id"),
    ("account_ref", "Cloud account"),
    ("region", "Region"),
    ("compartment_name", "Compartment"),
    ("resource_group", "Resource group"),
    ("status", "Status"),
    ("risk_level", "Risk"),
    ("source_ip", "Source IP"),
    ("access_method", "Access method"),
    ("error_code", "Error code"),
    ("provider_event_id", "Provider event id"),
    ("id", "Event id"),
]


@router.get("/export")
async def export_events(
    request: Request,
    filters: EventFilters = Depends(),
    advanced_filter: Optional[str] = Query(None),
    format: str = Query("csv", description="csv | json"),
    sort: str = Query("newest"),
    include_raw: bool = Query(
        False, description="JSON only: include the raw provider payload per event."
    ),
    principal: rbac.Principal = Depends(rbac.require(rbac.EXPORT)),
    svc: EventService = Depends(get_event_service),
):
    """Stream every event matching the current filters — not just this page.

    Streamed rather than assembled: a 100,000-row export built in memory is
    hundreds of megabytes, and the request would time out before the first byte
    reached the client. Keyset-paged inside the repository, so cost per batch
    is constant and rows cannot be skipped or repeated while events continue
    arriving.
    """
    if format not in ("csv", "json"):
        raise HTTPException(status_code=400, detail="format must be csv or json.")
    if include_raw and not principal.can(rbac.VIEW_RAW):
        await rbac.deny(principal, rbac.VIEW_RAW, request)

    window_start, window_end, label = svc.resolve_window(
        range_key=filters.range_key, start=filters.start, end=filters.end
    )
    applied = filters.describe()

    await svc.repo.record_access(
        ACCESS_EXPORT,
        actor=principal.name, role=principal.role, target=format,
        detail={
            "filters": applied,
            "window": {"start": window_start.isoformat(), "end": window_end.isoformat()},
            "include_raw": include_raw,
        },
        source_ip=principal.source_ip,
    )
    await svc.db.commit()

    query = dict(
        account_id=_parse_uuid_or_none(filters.account_id),
        start=window_start,
        end=window_end,
        provider=filters.provider,
        simple=filters.simple,
        search=filters.search,
        min_risk=filters.min_risk,
        advanced=_parse_advanced(advanced_filter),
        exclude_read_only=filters.exclude_read_only,
    )

    # Validate the filters BEFORE the response starts streaming. Once a
    # StreamingResponse has begun, the status code is already sent and a
    # FilterError would truncate the body with no way to report it — the client
    # would receive a partial file that looks complete.
    try:
        total = await svc.repo.count(**query)
    except FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    stamp = window_end.strftime("%Y%m%d-%H%M")
    filename = f"cloud-events-{stamp}.{format}"
    accounts = await svc._account_map()

    async def rows():
        """A fresh session for the stream.

        The request-scoped session is committed and returned to the pool when
        the handler returns, which happens before a StreamingResponse finishes
        producing its body. Reusing it here would query a closed session.
        """
        async with AsyncSessionLocal() as db:
            repo = EventRepository(db)
            async for event in repo.iter_for_export(
                sort=sort, max_rows=EXPORT_MAX_ROWS, **query
            ):
                yield event

    if format == "csv":
        async def csv_stream():
            buffer = io.StringIO()
            writer = csv.writer(buffer, lineterminator="\n")

            # Provenance comments, so a spreadsheet sitting in someone's
            # downloads folder still says what it is a view of and whether it
            # was truncated.
            #
            # Written as raw lines rather than through the csv writer: a
            # filters line contains commas, so the writer wrapped the whole
            # thing in quotes and the line then began with `"` instead of `#`.
            # A comment that does not start with a comment character is not a
            # comment — it is a stray data row in everyone's spreadsheet. Any
            # newline inside a value is flattened for the same reason.
            preamble = [
                "ACTMON Cloud Event Log export",
                f"Window (UTC): {window_start.isoformat()} to {window_end.isoformat()}",
                f"Filters: {json.dumps(applied, default=str)}",
                f"Matching events: {total}"
                + (f" (export capped at {EXPORT_MAX_ROWS})"
                   if total > EXPORT_MAX_ROWS else ""),
            ]
            for line in preamble:
                yield "# " + line.replace("\r", " ").replace("\n", " ") + "\n"

            writer.writerow([label for _, label in _EXPORT_COLUMNS])
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

            async for event in rows():
                row = event.to_row()
                row["account_name"] = (accounts.get(event.account_id) or {}).get("account_name")
                writer.writerow([_csv_cell(row.get(key)) for key, _ in _EXPORT_COLUMNS])
                yield buffer.getvalue()
                buffer.seek(0)
                buffer.truncate(0)

        return StreamingResponse(
            csv_stream(),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Event-Total": str(total),
                "X-Event-Export-Cap": str(EXPORT_MAX_ROWS),
                "X-Event-Truncated": "true" if total > EXPORT_MAX_ROWS else "false",
            },
        )

    async def json_stream():
        # NDJSON-framed inside a JSON envelope: a single well-formed document
        # the client can parse, produced incrementally so nothing is held in
        # memory. The metadata comes FIRST so a truncated download still says
        # what it was and whether it was capped.
        header = {
            "export": "ACTMON Cloud Event Log",
            "window": {"start_utc": window_start.isoformat(),
                       "end_utc": window_end.isoformat(), "range": label},
            "filters": applied,
            "matching_events": total,
            "export_cap": EXPORT_MAX_ROWS,
            "truncated": total > EXPORT_MAX_ROWS,
            "includes_raw_event": include_raw,
        }
        yield '{"metadata": ' + json.dumps(header, default=str) + ', "events": ['
        first = True
        async for event in rows():
            detail = event.to_detail(include_raw=include_raw)
            detail["account_name"] = (accounts.get(event.account_id) or {}).get("account_name")
            yield ("" if first else ",") + json.dumps(detail, default=str)
            first = False
        yield "]}"

    return StreamingResponse(
        json_stream(),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Event-Total": str(total),
            "X-Event-Truncated": "true" if total > EXPORT_MAX_ROWS else "false",
        },
    )


# ── Single event (last: these paths would otherwise shadow the named ones) ────


@router.get("/{event_id}", response_model=Dict[str, Any])
async def get_event(
    event_id: str,
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """One event in full.

    A caller without the raw-payload permission still gets every normalized
    field — the payload is simply absent, and the response says so. Refusing
    the whole event would make an ordinary viewer unable to answer who/what/
    when, which is the point of the feature.
    """
    detail = await svc.get_event(event_id, include_raw=principal.can(rbac.VIEW_RAW))
    if detail is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return detail


@router.get("/{event_id}/raw", response_model=Dict[str, Any])
async def get_event_raw(
    event_id: str,
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW_RAW)),
    svc: EventService = Depends(get_event_service),
):
    """The provider's original payload, post-redaction.

    Recorded in the access log: opening a raw audit payload is exactly the kind
    of privileged read the audit-of-the-audit requirement exists for.
    """
    payload = await svc.get_raw(event_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Event not found.")

    await svc.repo.record_access(
        ACCESS_VIEW_RAW,
        actor=principal.name, role=principal.role, target=event_id,
        detail={"provider": payload.get("provider")},
        source_ip=principal.source_ip,
    )
    return payload


@router.get("/{event_id}/related", response_model=Dict[str, Any])
async def get_related(
    event_id: str,
    limit: int = Query(25, ge=1, le=100),
    principal: rbac.Principal = Depends(rbac.require(rbac.VIEW)),
    svc: EventService = Depends(get_event_service),
):
    """Related events, grouped by why they are related, plus any configuration
    drift this event could have caused."""
    result = await svc.related(event_id, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Event not found.")
    return result


def _parse_uuid_or_none(value: Optional[str]) -> Optional[uuid.UUID]:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def _csv_cell(value: Any) -> str:
    """Render a cell, neutralising spreadsheet formula injection.

    An audit trail carries attacker-influenced strings — a resource name, a
    user agent, an error message. A cell beginning `=`, `+`, `-`, `@` or a
    control character is executed as a formula when the CSV is opened in Excel
    or Sheets, which turns exporting an audit log into remote code execution on
    the analyst's machine. Prefixing a tab defuses it while leaving the value
    readable.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "\t" + text
    return text
