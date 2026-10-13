"""Identity & Access (CIEM) HTTP surface.

Three services behind one router, split by what a call does: reads from
`IdentityQueryService`, collection and analysis from `IdentityService`, and
anything that can change a customer's IAM from `IdentityWorkflowService`.

Permissions follow the split rather than the URL shape:

*   reading the table and the dashboard needs `identity:view`,
*   policy documents and decision traces need `identity:view_raw`, gated exactly
    as raw event, topology and security payloads are,
*   the permission explorer and the reverse query need `identity:query`, because
    "who can delete backups across this estate" is reconnaissance in a way a
    table of names is not,
*   running collection or analysis needs `identity:analyze` — it contacts
    provider APIs and writes,
*   approving needs `identity:approve` and applying needs `identity:apply`, and
    they are separate permissions so no single role can both bless and execute
    a privilege change without that being a deliberate grant.

Every response that touches the workflow carries `write_mode`, so the UI states
whether this deployment can actually apply a change rather than implying it.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.services.identity_query_service import (
    DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, IdentityQueryService,
)
from app.services.identity_service import IdentityService
from app.services.identity_workflow_service import (
    InvalidTransition, IdentityWorkflowService, REQUEST_KINDS, write_mode,
)

router = APIRouter(prefix="/cloud/identity", tags=["Identity & Access"])


async def get_query_service(db: AsyncSession = Depends(get_db)) -> IdentityQueryService:
    return IdentityQueryService(db)


async def get_identity_service(db: AsyncSession = Depends(get_db)) -> IdentityService:
    return IdentityService(db)


async def get_workflow_service(
    db: AsyncSession = Depends(get_db),
) -> IdentityWorkflowService:
    return IdentityWorkflowService(db)


def _csv(value: Optional[str]) -> Optional[List[str]]:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def _actor(principal: rbac.Principal) -> str:
    return principal.name or f"unauthenticated:{principal.role}"


def _ip(request: Request) -> Optional[str]:
    return request.client.host if request.client else None


# ── Vocabulary ───────────────────────────────────────────────────────────────
@router.get("/meta")
async def get_meta(
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """Identity types, decisions, capabilities, usage states and their meanings.

    Served from the backend so the UI legend and the engine can never drift —
    the same contract the Security Center and Resource Intelligence use.
    """
    out = svc.meta()
    out["rbac"] = rbac.rbac_summary()
    out["write_mode"] = write_mode()
    return out


# ── Dashboard and table ──────────────────────────────────────────────────────
@router.get("/{account_id}/overview")
async def overview(
    account_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    return await svc.overview(account_id)


@router.get("/{account_id}/principals")
async def list_principals(
    account_id: uuid.UUID,
    q: Optional[str] = None,
    identity_type: Optional[str] = Query(None, description="CSV"),
    actor_class: Optional[str] = Query(None, description="CSV"),
    privilege: Optional[str] = Query(None, description="CSV"),
    mfa: Optional[str] = Query(None, description="CSV"),
    external: Optional[str] = Query(None, description="CSV"),
    standing_admin: Optional[bool] = None,
    dormant_days: Optional[int] = Query(None, ge=1, le=3650),
    capability: Optional[str] = None,
    high_impact_only: bool = False,
    blast_band: Optional[str] = Query(None, description="CSV"),
    include_deleted: bool = False,
    sort: str = "privilege",
    direction: str = Query("asc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """The §21 identity table. Filtered, sorted and paged in SQL."""
    return await svc.list_identities(
        account_id, q=q, identity_types=_csv(identity_type),
        actor_classes=_csv(actor_class), privilege_levels=_csv(privilege),
        mfa_states=_csv(mfa), external=_csv(external),
        standing_admin=standing_admin, dormant_days=dormant_days,
        capability=capability, high_impact_only=high_impact_only,
        blast_band=_csv(blast_band), include_deleted=include_deleted,
        sort=sort, direction=direction, page=page, page_size=page_size,
    )


@router.get("/principals/{identity_id}")
async def principal_detail(
    identity_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    detail = await svc.detail(identity_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Identity not found")
    return detail


@router.get("/principals/{identity_id}/permissions")
async def principal_permissions(
    identity_id: uuid.UUID,
    decision: Optional[str] = Query(None, description="CSV"),
    capability: Optional[str] = None,
    q: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    svc: IdentityQueryService = Depends(get_query_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
    request: Request = None,  # type: ignore[assignment]
) -> Dict[str, Any]:
    """Effective permissions, each with its decision and provenance.

    The decision TRACE — which statement matched, in which policy — is part of
    the raw payload and needs `identity:view_raw`. A viewer sees what the
    identity can do; reading the policy statements that grant it is the analyst
    permission, for the reason the raw event payload is.
    """
    out = await svc.permissions(identity_id, decisions=_csv(decision),
                                capability=capability, q=q, page=page,
                                page_size=page_size)
    if not principal.can(rbac.IDENTITY_VIEW_RAW):
        for item in out.get("items", []):
            item.pop("steps", None)
            item.pop("conditions", None)
        out["raw_withheld"] = True
        out["raw_withheld_note"] = (
            "The decision trace and condition blocks are withheld: they quote provider "
            "policy statements and need identity:view_raw."
        )
    return out


@router.get("/principals/{identity_id}/usage")
async def principal_usage(
    identity_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """Granted versus observed, always beside the window that was searched."""
    return await svc.usage(identity_id)


@router.get("/principals/{identity_id}/blast-radius")
async def principal_blast_radius(
    identity_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    detail = await svc.detail(identity_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Identity not found")
    reach = detail.get("blast_radius")
    if reach is None:
        return {
            "available": False,
            "reason": ("No blast-radius calculation exists for this identity. Run the "
                       "identity analysis for this account."),
        }
    from app.identity.blast_radius import explain

    return {"available": True, **reach, "explanation": explain(reach)}


@router.get("/principals/{identity_id}/trust")
async def principal_trust(
    identity_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> List[Dict[str, Any]]:
    return await svc.trust(identity_id)


@router.get("/principals/{identity_id}/events")
async def principal_events(
    identity_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> List[Dict[str, Any]]:
    """§27: what this principal was observed doing, from the Event Log."""
    return await svc.events(identity_id, limit=limit)


@router.get("/principals/{identity_id}/recommendations")
async def principal_recommendations(
    identity_id: uuid.UUID,
    svc: IdentityQueryService = Depends(get_query_service),
    workflow: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """§29: evidence-driven recommendations for one identity.

    Each carries why, the evidence, the current and proposed state, and the
    risks — assembled from the stored analysis rather than generated as prose.
    """
    detail = await svc.detail(identity_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Identity not found")

    identity = detail["identity"]
    out: List[Dict[str, Any]] = []

    if identity.get("mfa_state") == "DISABLED":
        out.append({
            "id": "ENABLE_MFA", "title": "Enable multi-factor authentication",
            "why": "A password alone protects this identity's permissions.",
            "evidence": {"mfa_state": identity["mfa_state"],
                         "privilege_level": identity["privilege_level"],
                         "source": detail["identity"].get("mfa_detail")},
            "current_state": "No MFA device registered",
            "proposed_state": "At least one MFA device registered",
            "expected_effect": "A stolen password alone no longer grants access.",
            "risks": "The holder must enrol a device before their next sign-in.",
        })

    for credential in detail.get("credentials", []):
        if credential.get("recommendation") in ("ROTATE", "DISABLE", "DELETE"):
            out.append({
                "id": f"CREDENTIAL_{credential['recommendation']}",
                "title": f"{credential['recommendation'].title()} "
                         f"{credential['credential_kind'].replace('_', ' ').lower()}",
                "why": credential.get("recommendation_reason"),
                "evidence": {k: credential.get(k) for k in
                             ("credential_ref", "created_at_provider", "last_used_at",
                              "never_used", "status")},
                "current_state": credential.get("status"),
                "proposed_state": credential["recommendation"],
                "expected_effect": "Removes a long-lived bearer credential.",
                "risks": ("Any system still using it will fail to authenticate. "
                          "Rotate in four steps rather than deleting outright."),
            })

    usage = await svc.usage(identity_id)
    if usage.get("not_observed_high"):
        out.append({
            "id": "RIGHTSIZE_PERMISSIONS", "title": "Right-size permissions",
            "why": f"{usage['not_observed_high']} granted statement(s) had no observed "
                   "use in the window.",
            "evidence": {"window": usage.get("window"),
                         "observed": usage.get("observed_count"),
                         "not_observed_high": usage.get("not_observed_high"),
                         "not_observed_low": usage.get("not_observed_low")},
            "current_state": "Permissions as granted",
            "proposed_state": "A policy built from observed activity",
            "expected_effect": "Reduces the blast radius without changing observed "
                               "behaviour.",
            "risks": ("A permission used only outside the window would be removed. "
                      "Review the diff and apply as a boundary first."),
            "action": {"kind": "PERMISSION_RIGHTSIZE",
                       "endpoint": f"/cloud/identity/principals/{identity_id}/rightsize"},
        })

    if identity.get("standing_admin"):
        out.append({
            "id": "REPLACE_WITH_JIT", "title": "Replace standing admin with JIT access",
            "why": "Administrative permission is held continuously rather than "
                   "requested when needed.",
            "evidence": {"privilege_level": identity["privilege_level"],
                         "last_used_at": identity.get("last_used_at")},
            "current_state": "Standing administrative access",
            "proposed_state": "Time-boxed elevation with approval and auto-expiry",
            "expected_effect": "Shrinks the window in which a stolen credential is "
                               "useful from months to minutes.",
            "risks": "An approval path that is unavailable during an incident. Keep "
                     "one documented break-glass account outside the flow.",
        })

    return {"identity_id": str(identity_id), "recommendations": out,
            "write_mode": write_mode()}


# ── The permission explorer and reverse queries ──────────────────────────────
@router.get("/{account_id}/permission-query")
async def permission_query(
    account_id: uuid.UUID,
    identity_id: uuid.UUID,
    action: str = Query(..., min_length=1),
    resource: Optional[str] = None,
    svc: IdentityQueryService = Depends(get_query_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_QUERY)),
) -> Dict[str, Any]:
    """§4: "CAN THIS IDENTITY DO THIS?", with the full decision chain."""
    out = await svc.can_do(account_id, identity_id=identity_id, action=action,
                           resource=resource)
    if "error" in out:
        raise HTTPException(status_code=404, detail=out["error"])
    if not principal.can(rbac.IDENTITY_VIEW_RAW):
        out.pop("steps", None)
        out["raw_withheld"] = True
    return out


@router.get("/{account_id}/who-can-access")
async def who_can_access(
    account_id: uuid.UUID,
    action: Optional[str] = None,
    resource: Optional[str] = None,
    capability: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_QUERY)),
) -> Dict[str, Any]:
    """§4's reverse query: which principals can perform this action?"""
    out = await svc.who_can_access(account_id, action=action, resource=resource,
                                   capability=capability, limit=limit)
    if "error" in out:
        raise HTTPException(status_code=400, detail=out["error"])
    return out


@router.get("/{account_id}/resources/{resource_key:path}/principals")
async def resource_principals(
    account_id: uuid.UUID,
    resource_key: str,
    limit: int = Query(100, ge=1, le=500),
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_QUERY)),
) -> Dict[str, Any]:
    """§23: "Who can access this?" — answered from the Resources tab.

    `resource_key` is a path parameter because an ARN and an ARM id both carry
    slashes; matching on `:path` keeps them intact rather than truncating at the
    first separator.
    """
    return await svc.principals_for_resource(account_id, resource_key, limit=limit)


@router.get("/{account_id}/trust-map")
async def trust_map(
    account_id: uuid.UUID,
    external_only: bool = False,
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """§13: the cross-account / cross-tenant trust graph."""
    return await svc.trust_map(account_id, external_only=external_only)


@router.get("/{account_id}/search")
async def search(
    account_id: uuid.UUID,
    q: str = Query(..., min_length=1),
    limit: int = Query(25, ge=1, le=100),
    svc: IdentityQueryService = Depends(get_query_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """§33: search over indexed identity data, returning structured filters."""
    return await svc.search(account_id, q, limit=limit)


# ── Collection and analysis ──────────────────────────────────────────────────
@router.post("/{account_id}/collect")
async def collect(
    account_id: uuid.UUID,
    svc: IdentityService = Depends(get_identity_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_ANALYZE)),
) -> Dict[str, Any]:
    """Read the principal estate from the provider."""
    try:
        return await svc.collect(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{account_id}/analyze")
async def analyze(
    account_id: uuid.UUID,
    usage_window_days: int = Query(90, ge=1, le=365),
    dormant_days: int = Query(90, ge=1, le=3650),
    svc: IdentityService = Depends(get_identity_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_ANALYZE)),
) -> Dict[str, Any]:
    """Evaluate permissions, correlate usage, compute reach, emit findings."""
    try:
        return await svc.analyze(account_id, usage_window_days=usage_window_days,
                                 dormant_days=dormant_days)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── Access requests ──────────────────────────────────────────────────────────
class AccessRequestBody(BaseModel):
    request_kind: str = Field(..., description="|".join(REQUEST_KINDS))
    reason: str = Field(..., min_length=1)
    identity_id: Optional[uuid.UUID] = None
    requested_role: Optional[str] = None
    target_scope: Optional[str] = None
    target_resource: Optional[str] = None
    requested_actions: Optional[List[str]] = None
    duration_minutes: Optional[int] = Field(None, ge=1, le=480)
    ticket_ref: Optional[str] = None


class DecisionBody(BaseModel):
    comment: Optional[str] = None


class ApplyBody(BaseModel):
    confirm: bool = Field(False, description="Must be true. Applying is deliberate.")


@router.post("/{account_id}/access-requests")
async def create_request(
    account_id: uuid.UUID,
    body: AccessRequestBody,
    request: Request,
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_REQUEST)),
) -> Dict[str, Any]:
    """§16: raise an access or right-sizing request. Changes nothing."""
    try:
        return await svc.request_access(
            account_id=account_id, request_kind=body.request_kind,
            reason=body.reason, identity_id=body.identity_id,
            requested_role=body.requested_role, target_scope=body.target_scope,
            target_resource=body.target_resource,
            requested_actions=body.requested_actions,
            duration_minutes=body.duration_minutes, ticket_ref=body.ticket_ref,
            actor=_actor(principal), actor_role=principal.role,
            source_ip=_ip(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{account_id}/access-requests")
async def list_requests(
    account_id: uuid.UUID,
    status: Optional[str] = Query(None, description="CSV"),
    kind: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    items = await svc.list_requests(account_id=account_id, statuses=_csv(status),
                                    kind=kind, limit=limit, offset=offset)
    return {"items": items, "write_mode": write_mode()}


@router.get("/access-requests/{request_id}")
async def get_request(
    request_id: uuid.UUID,
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    """The request, its approvals, its sessions and its full timeline."""
    out = await svc.get_request(request_id)
    if out is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return out


@router.post("/access-requests/{request_id}/approve")
async def approve_request(
    request_id: uuid.UUID,
    request: Request,
    body: DecisionBody = Body(default=DecisionBody()),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_APPROVE)),
) -> Dict[str, Any]:
    try:
        return await svc.decide(request_id, approve=True, actor=_actor(principal),
                                actor_role=principal.role, comment=body.comment,
                                source_ip=_ip(request))
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/access-requests/{request_id}/reject")
async def reject_request(
    request_id: uuid.UUID,
    request: Request,
    body: DecisionBody = Body(default=DecisionBody()),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_APPROVE)),
) -> Dict[str, Any]:
    try:
        return await svc.decide(request_id, approve=False, actor=_actor(principal),
                                actor_role=principal.role, comment=body.comment,
                                source_ip=_ip(request))
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/access-requests/{request_id}/apply")
async def apply_request(
    request_id: uuid.UUID,
    request: Request,
    body: ApplyBody = Body(default=ApplyBody()),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_APPLY)),
) -> Dict[str, Any]:
    """Execute an approved request. Needs `confirm`, and execution switched on."""
    try:
        return await svc.apply(request_id, actor=_actor(principal),
                               actor_role=principal.role, source_ip=_ip(request),
                               confirm=body.confirm)
    except InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── JIT sessions ─────────────────────────────────────────────────────────────
@router.get("/{account_id}/sessions")
async def list_sessions(
    account_id: uuid.UUID,
    status: Optional[str] = Query(None, description="CSV"),
    limit: int = Query(100, ge=1, le=500),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_VIEW)),
) -> Dict[str, Any]:
    items = await svc.list_sessions(account_id=account_id, statuses=_csv(status),
                                    limit=limit)
    overdue = [s for s in items if s.get("overdue")]
    return {
        "items": items,
        "overdue": len(overdue),
        # The dangerous state, surfaced rather than buried in a list: expired by
        # the clock and still live on the provider.
        "overdue_note": (
            f"{len(overdue)} session(s) have passed their expiry without a confirmed "
            "revocation. They may still grant access on the provider."
        ) if overdue else None,
        "write_mode": write_mode(),
    }


@router.post("/sessions/{session_id}/revoke")
async def revoke_session(
    session_id: uuid.UUID,
    request: Request,
    body: DecisionBody = Body(default=DecisionBody()),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_APPLY)),
) -> Dict[str, Any]:
    try:
        return await svc.revoke_now(session_id, actor=_actor(principal),
                                    actor_role=principal.role, reason=body.comment)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/sessions/expire-due")
async def expire_due(
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_APPLY)),
) -> Dict[str, Any]:
    """Revoke every session past its expiry. Idempotent; also runs on a worker."""
    return await svc.expire_due_sessions()


# ── Right-sizing ─────────────────────────────────────────────────────────────
@router.post("/principals/{identity_id}/rightsize")
async def propose_rightsizing(
    identity_id: uuid.UUID,
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    query: IdentityQueryService = Depends(get_query_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_REQUEST)),
) -> Dict[str, Any]:
    """§6/§7: generate a least-privilege proposal from observed activity.

    Writes nothing to the provider. The result is a diff and a proposed
    document, which become an access request if someone chooses to pursue them.
    """
    detail = await query.detail(identity_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Identity not found")
    account_id = uuid.UUID(detail["identity"]["account_id"])
    try:
        return await svc.propose_rightsizing(account_id=account_id,
                                             identity_id=identity_id,
                                             actor=_actor(principal))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ── Audit ────────────────────────────────────────────────────────────────────
@router.get("/{account_id}/audit")
async def audit_log(
    account_id: uuid.UUID,
    identity_id: Optional[uuid.UUID] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    svc: IdentityWorkflowService = Depends(get_workflow_service),
    _: rbac.Principal = Depends(rbac.require(rbac.IDENTITY_AUDIT)),
) -> Dict[str, Any]:
    """§31: who requested, who approved, what changed, and what failed."""
    items = await svc.audit_log(account_id=account_id, identity_id=identity_id,
                                limit=limit, offset=offset)
    return {"items": items}
