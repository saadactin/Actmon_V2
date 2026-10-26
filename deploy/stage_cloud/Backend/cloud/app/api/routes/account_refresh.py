"""Account refresh: trigger, status, history and schedule.

Every path carries the account, and the service resolves the account before
anything else — so a refresh id belonging to another account is a 404 here,
not that account's data. That is the isolation boundary, and it is structural
rather than a filter someone has to remember to apply.

`POST /refresh` returns as soon as the job is queued. A full account refresh is
a provider sweep taking minutes; holding the HTTP request open for it would tie
the job's life to a browser tab, so closing the tab would kill a half-finished
inventory rewrite.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.core.database import get_db
from app.models.account_refresh import COMPONENT_LABELS, COMPONENTS
from app.services.account_refresh_service import (
    ALLOWED_INTERVAL_HOURS, DAY_NAMES, FREQUENCIES, TRIGGER_MANUAL, TRIGGER_TEST,
    AccountRefreshService, RefreshError, describe_schedule,
)
from app.services import refresh_scheduler

logger = logging.getLogger("cloud_svc.refresh.api")

router = APIRouter(prefix="/cloud/accounts", tags=["Account Refresh"])


async def _service(db: AsyncSession = Depends(get_db)) -> AccountRefreshService:
    return AccountRefreshService(db)


def _uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{value!r} is not a valid id.")


def _handle(exc: Exception):
    if isinstance(exc, RefreshError):
        if exc.code == "account_not_found" or exc.code == "not_found":
            raise HTTPException(status_code=404, detail=exc.message)
        if exc.code == "already_running":
            # 409, not 400: the request was well-formed, the account is simply
            # busy. The in-flight refresh is returned so the UI can show its
            # progress instead of an error.
            raise HTTPException(status_code=409, detail={
                "message": exc.message, "code": exc.code,
                "refresh": exc.existing,
            })
        if exc.code == "scan_running":
            # Busy the same way, with a plain discovery scan rather than a
            # refresh — returned so the UI can say which.
            raise HTTPException(status_code=409, detail={
                "message": exc.message, "code": exc.code,
                "scan": exc.existing,
            })
        if exc.code == "validation":
            raise HTTPException(status_code=422, detail={
                "message": exc.message, "errors": exc.existing,
            })
        raise HTTPException(status_code=400, detail=exc.message)
    raise exc


class ScheduleIn(BaseModel):
    enabled: Optional[bool] = None
    frequency_type: Optional[str] = None
    interval_hours: Optional[int] = None
    day_of_week: Optional[int] = None
    time_of_day: Optional[str] = None
    timezone: Optional[str] = None


# ── Trigger ───────────────────────────────────────────────────────────────────
@router.post("/{account_id}/refresh", status_code=202)
async def start_refresh(
    account_id: str,
    test: bool = Query(False, description="Record as a test run. The work is "
                                          "identical — only the label differs."),
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_DISCOVER)),
):
    """Refresh this cloud account.

    Runs the SAME workflow the scheduler runs, so what you test by hand is what
    happens at 02:00. A `test` run is not a simulation — it performs the real
    refresh and is simply labelled so it can be told apart in the history.

    202, because the work has been accepted and has not finished. Poll the
    status endpoint for progress.
    """
    try:
        row = await svc.start(
            _uuid(account_id),
            trigger_type=TRIGGER_TEST if test else TRIGGER_MANUAL,
            actor=principal.name)
        return row.to_dict()
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/refresh/latest")
async def latest_refresh(
    account_id: str,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """What the Overview header needs, in one call.

    Returns the in-flight refresh, the last ATTEMPT and the last SUCCESS as
    three separate things. They are not interchangeable: a failed 02:00 run
    must never overwrite the timestamp people read as "when was this account
    last actually refreshed".
    """
    try:
        return await svc.latest(_uuid(account_id))
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/refresh/{refresh_id}")
async def refresh_status(
    account_id: str, refresh_id: str,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """One refresh, with per-component state.

    Components report PENDING / RUNNING / SUCCEEDED / FAILED / SKIPPED — never
    a percentage, because the backend genuinely does not know how far through a
    provider sweep it is, and a fabricated 64% is worse than an honest stage
    name.
    """
    try:
        row = await svc.get(_uuid(account_id), _uuid(refresh_id))
        return row.to_dict()
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/refresh/{refresh_id}/cancel")
async def cancel_refresh(
    account_id: str, refresh_id: str,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_DISCOVER)),
):
    """Release the account's refresh lock.

    Honest about its limit: a provider request already in flight is not
    interrupted, because the discovery worker has no cancellation point that
    leaves the inventory consistent. The response says so.
    """
    try:
        return await svc.cancel(_uuid(account_id), _uuid(refresh_id),
                                actor=principal.name)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/refresh-history")
async def refresh_history(
    account_id: str,
    limit: int = Query(20, ge=1, le=200),
    status: Optional[str] = Query(None),
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Past refreshes, newest first. Bounded — history grows without end."""
    try:
        return {
            "account_id": account_id,
            "history": await svc.history(_uuid(account_id), limit=limit,
                                         status=status),
        }
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Schedule ──────────────────────────────────────────────────────────────────
@router.get("/{account_id}/refresh-schedule")
async def get_schedule(
    account_id: str,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """This account's schedule, plus the options the backend can honestly run.

    The frequency list is served rather than hardcoded in the UI so the two
    cannot drift — the form can only ever offer a cadence the scheduler
    actually supports.
    """
    try:
        row = await svc.get_schedule(_uuid(account_id))
        return {
            **row.to_dict(),
            "summary": describe_schedule(row),
            "options": {
                "frequencies": [{"value": k, "label": v}
                                for k, v in FREQUENCIES.items()],
                "interval_hours": list(ALLOWED_INTERVAL_HOURS),
                "days": [{"value": i, "label": n} for i, n in enumerate(DAY_NAMES)],
                "note": ("Nothing shorter than an hour: a full refresh is a "
                         "provider sweep taking minutes, so a shorter cadence "
                         "would queue runs faster than they finish."),
            },
            "scheduler": refresh_scheduler.scheduler_status(),
        }
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.put("/{account_id}/refresh-schedule")
async def update_schedule(
    account_id: str,
    payload: ScheduleIn,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_DISCOVER)),
):
    """Save the schedule. `next_run_at` is recomputed on every save.

    Turning automatic refresh OFF cancels only FUTURE runs — a refresh already
    in flight keeps going, because stopping it is a separate decision with its
    own endpoint.
    """
    try:
        return await svc.set_schedule(
            _uuid(account_id), payload.model_dump(exclude_unset=True),
            actor=principal.name)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/refresh-capabilities")
async def refresh_capabilities(
    account_id: str,
    svc: AccountRefreshService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.RESOURCE_VIEW)),
):
    """Which components a refresh of THIS account can actually cover.

    Derived from the provider integration rather than asserted: a capability is
    only claimed where the code to deliver it exists.
    """
    try:
        account = await svc._account(_uuid(account_id))
    except Exception as exc:  # noqa: BLE001
        _handle(exc)

    from app.providers import capabilities as provider_caps

    cost_cap = provider_caps.for_provider(account.provider)
    return {
        "account_id": account_id,
        "provider": account.provider,
        "components": [
            {"key": name, "label": COMPONENT_LABELS[name],
             "supported": True if name != "cost" else cost_cap is not None,
             "reason": (None if name != "cost" or cost_cap is not None else
                        f"Actmon has no cost integration for {account.provider!r}, "
                        "so a refresh cannot update billing for this account.")}
            for name in COMPONENTS
        ],
        "note": ("All components run inside a single provider sweep — a refresh "
                 "does not make a separate round of API calls per component."),
    }
