"""Security Center HTTP surface.

One router, split by question rather than by which page happens to render the
answer — the same shape the topology routes settled on, for the same reason: a
tab that needs the overview should not pay for the findings list, and a
findings list should be filterable and paged server-side.

Every route is behind an RBAC dependency. That is the single biggest change
from what these endpoints replace: `security.py`, `compliance.py` and
`alerts.py` had no authorisation of any kind, so a findings list — a ranked,
evidence-bearing map of exactly where an estate is weakest — and
`POST /alerts/{id}/resolve` were both reachable unauthenticated.

`evidence` is stripped for callers without `security:view_raw`, because it
quotes provider payloads verbatim: IAM policy statements, NSG rule bodies,
bucket policies. The same gate already protects raw event payloads and raw
topology metadata.

The old routers stay mounted and unchanged. They are the compatibility surface
for the existing pages while the frontend moves over; nothing new should be
added to them.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.api.deps import get_db
from app.security import controls as ctl
from app.security import policies as pol
from app.security import registry as reg
from app.security import scoring
from app.security.model import (
    CATEGORIES, CONFIDENCES, FINDING_STATUSES, SEVERITIES, VERDICTS,
)
from app.services.security_center_service import SecurityCenterService

router = APIRouter(prefix="/cloud/security-center", tags=["Security Center"])


async def get_service(db: AsyncSession = Depends(get_db)) -> SecurityCenterService:
    return SecurityCenterService(db)


def _actor(principal: rbac.Principal) -> str:
    """Who to record for an action. Falls back to the role rather than
    "unknown": while RBAC enforcement is off the caller is unauthenticated but
    the role they were granted is still the honest answer to "on what
    authority"."""
    return principal.name or f"unauthenticated:{principal.role}"


def _strip_evidence(payload: Any, allowed: bool) -> Any:
    """Remove provider payload quotes for callers without view_raw.

    Replaced with a marker rather than deleted, so the UI can say "evidence
    hidden by your role" instead of rendering a finding that looks like it has
    no supporting data.
    """
    if allowed:
        return payload
    if isinstance(payload, dict):
        out = dict(payload)
        if "evidence" in out:
            out["evidence"] = {"_withheld": "Requires the security:view_raw permission."}
        if "affected_sample" in out and out["affected_sample"]:
            out["affected_sample"] = [
                {k: v for k, v in item.items() if k != "evidence"}
                for item in out["affected_sample"]
            ]
        for key in ("findings", "top_risks", "violations", "resources", "grants"):
            if isinstance(out.get(key), list):
                out[key] = [_strip_evidence(i, False) for i in out[key]]
        return out
    if isinstance(payload, list):
        return [_strip_evidence(i, False) for i in payload]
    return payload


# ═════════════════════════════════════════════════════════════════════════════
# Metadata — declared before /{account_id} so the literal wins the route match
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/meta")
async def get_meta(
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """The vocabulary the UI renders: rules, categories, severities, control
    catalog, threshold kinds, and the scoring methodology.

    Served from the backend so the legend and the engine cannot disagree —
    duplicating the severity list or the rule catalog in the frontend is how a
    UI ends up describing behaviour the backend stopped having.
    """
    from app.models.security_finding import THRESHOLD_LABEL

    return {
        "severities": list(SEVERITIES),
        "categories": list(CATEGORIES),
        "statuses": list(FINDING_STATUSES),
        "verdicts": list(VERDICTS),
        "confidences": list(CONFIDENCES),
        "rules": [
            {
                "rule_id": r.rule_id,
                "version": r.version,
                "provider": r.provider,
                "resource_types": list(r.resource_types),
                "title": r.title,
                "severity": r.severity,
                "category": r.category,
                "confidence": r.confidence,
                "description": r.description,
                "rationale": r.rationale,
                "remediation": r.remediation,
                "aggregate": r.aggregate,
                "synthetic": r.evaluate is None,
                "coverage_dimension": r.coverage,
                "compliance": ctl.mappings_for_rule(r.rule_id),
            }
            for r in sorted(reg.RULES.values(), key=lambda x: x.rule_id)
        ],
        "frameworks": {fw: ctl.framework_meta(fw) for fw in ctl.FRAMEWORKS},
        "control_catalog": ctl.catalog_summary(),
        "threshold_kinds": [{"value": k, "label": v} for k, v in THRESHOLD_LABEL.items()],
        "scoring": {
            "methodology": scoring.METHODOLOGY,
            "category_budgets": scoring.CATEGORY_BUDGET,
            "severity_weights": scoring.SEVERITY_WEIGHT,
            "grade_bands": [{"min_score": t, "grade": g}
                            for t, g in scoring.GRADE_BANDS],
            "critical_grade_ceiling": scoring.CRITICAL_GRADE_CEILING,
            "coverage_withhold_below": scoring.COVERAGE_WITHHOLD_BELOW,
        },
        "rbac": rbac.rbac_summary(),
    }


@router.get("/overview")
async def multi_cloud_overview(
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Every account side by side, grouped by provider (§58, §59)."""
    return await svc.multi_cloud()


@router.get("/policies")
async def list_policies(
    account_id: Optional[uuid.UUID] = Query(None),
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    return await svc.list_policies(account_id)


class PolicyPayload(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None
    account_id: Optional[str] = None
    providers: Optional[List[str]] = None
    rule_ids: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    resource_types: Optional[List[str]] = None
    min_severity: Optional[str] = None
    ports: Optional[List[int]] = None
    match_verdicts: Optional[List[str]] = None
    threshold_kind: Optional[str] = None
    threshold_value: Optional[float] = None
    alert_severity: Optional[str] = None
    cooldown_minutes: Optional[int] = Field(None, ge=1, le=10080)
    notify: Optional[bool] = None


@router.post("/policies", status_code=status.HTTP_201_CREATED)
async def create_policy(
    payload: PolicyPayload,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_MANAGE_POLICIES)),
) -> Dict[str, Any]:
    row, err = await svc.upsert_policy(
        policy_id=None, payload=payload.model_dump(exclude_none=True),
        actor=_actor(principal))
    if err:
        raise HTTPException(status_code=400, detail=err)
    return row


@router.put("/policies/{policy_id}")
async def update_policy(
    policy_id: uuid.UUID,
    payload: PolicyPayload,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_MANAGE_POLICIES)),
) -> Dict[str, Any]:
    row, err = await svc.upsert_policy(
        policy_id=policy_id, payload=payload.model_dump(exclude_none=True),
        actor=_actor(principal))
    if err:
        raise HTTPException(status_code=404 if err == "Policy not found" else 400,
                            detail=err)
    return row


@router.delete("/policies/{policy_id}")
async def delete_policy(
    policy_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_MANAGE_POLICIES)),
) -> Dict[str, Any]:
    ok, err = await svc.delete_policy(policy_id)
    if not ok:
        raise HTTPException(status_code=404 if err == "Policy not found" else 400,
                            detail=err)
    return {"status": "deleted", "policy_id": str(policy_id)}


# ── Alerts ───────────────────────────────────────────────────────────────────


@router.get("/alerts")
async def list_alerts(
    account_id: Optional[uuid.UUID] = Query(None),
    include_resolved: bool = Query(False),
    limit: int = Query(200, ge=1, le=1000),
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Alerts, newest first, each carrying the finding fingerprint it came from
    so the UI can navigate Alert → Finding."""
    return await svc.alerts_feed(account_id=account_id,
                                include_resolved=include_resolved, limit=limit)


class AlertAction(BaseModel):
    reason: Optional[str] = None


@router.post("/alerts/{alert_id}/acknowledge")
async def acknowledge_alert(
    alert_id: uuid.UUID,
    body: AlertAction = Body(default=AlertAction()),
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_TRIAGE)),
) -> Dict[str, Any]:
    row, err = await svc.act_on_alert(alert_id, "acknowledge",
                                      actor=_actor(principal), reason=body.reason)
    if err:
        raise HTTPException(status_code=404, detail=err)
    return row


@router.post("/alerts/{alert_id}/resolve")
async def resolve_alert(
    alert_id: uuid.UUID,
    body: AlertAction = Body(default=AlertAction()),
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_TRIAGE)),
) -> Dict[str, Any]:
    """Marks the condition handled. The next assessment reopens it if the
    condition is still there, which is deliberate — resolving an alert is not
    a way to make a finding go away."""
    row, err = await svc.act_on_alert(alert_id, "resolve",
                                      actor=_actor(principal), reason=body.reason)
    if err:
        raise HTTPException(status_code=404, detail=err)
    return row


@router.post("/alerts/{alert_id}/suppress")
async def suppress_alert(
    alert_id: uuid.UUID,
    body: AlertAction,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_SUPPRESS)),
) -> Dict[str, Any]:
    """Suppresses the alert AND its underlying finding, with a mandatory reason.

    Suppressing only the alert would look like it worked and then have the next
    assessment recreate it — so this acts on the finding, which is where
    suppression has to live to mean anything.
    """
    row, err = await svc.act_on_alert(alert_id, "suppress",
                                      actor=_actor(principal), reason=body.reason)
    if err:
        raise HTTPException(status_code=400 if "reason" in err else 404, detail=err)
    return row


# ═════════════════════════════════════════════════════════════════════════════
# Per-account
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/{account_id}")
async def get_overview(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """The Overview tab: score, risk summary, alerts, exposure, identity,
    compliance headline, coverage and freshness — from persisted findings."""
    try:
        out = await svc.overview(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return _strip_evidence(out, principal.can(rbac.SECURITY_VIEW_RAW))


@router.post("/{account_id}/assess")
async def run_assessment(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_ASSESS)),
) -> Dict[str, Any]:
    """Re-evaluate the stored inventory. Does NOT contact the provider.

    Distinct from a discovery scan on purpose (§55): this is cheap and answers
    "apply the current rules to what we know", while refreshing the inventory
    is a long provider round-trip and lives on the Resources tab. Conflating
    them is how a user comes to believe a 70-day-old inventory was just
    verified.
    """
    try:
        return await svc.assess(account_id, triggered_by=f"manual:{_actor(principal)}")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{account_id}/collect-identity")
async def collect_identity(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_ASSESS)),
) -> Dict[str, Any]:
    """Collect provider identity grants (Azure role assignments).

    Contacts the provider, so it is separate from `/assess`. A refusal returns
    200 with the status and the missing permission: the refusal is the answer,
    not an error.
    """
    try:
        return await svc.collect_identity(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{account_id}/findings")
async def list_findings(
    account_id: uuid.UUID,
    request: Request,
    status_filter: Optional[str] = Query(None, alias="status"),
    severity: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    verdict: Optional[str] = Query(None),
    confidence: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    rule_id: Optional[str] = Query(None),
    framework: Optional[str] = Query(None, description="Narrow to one framework's rules"),
    control_id: Optional[str] = Query(None, description="Narrow to one control's rules"),
    search: Optional[str] = Query(None),
    resource_key: Optional[str] = Query(
        None, description="Exactly this resource — e.g. one certificate's provider id"),
    days: Optional[int] = Query(None, ge=1, le=3650),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """The Findings tab. Filtered, sorted worst-first and paged in SQL.

    Comma-separated values are accepted on every list filter, so the UI can
    send `severity=CRITICAL,HIGH` rather than issuing two requests and merging.
    """
    filters: Dict[str, Any] = {
        "statuses": _csv(status_filter) or ["OPEN", "IN_PROGRESS"],
        "severities": _csv(severity),
        "categories": _csv(category),
        "verdicts": _csv(verdict),
        "confidences": _csv(confidence),
        "resource_types": _csv(resource_type),
        "rule_ids": _csv(rule_id),
        "search": search,
        "resource_key": resource_key,
    }
    if days:
        filters["detected_after"] = datetime.now(timezone.utc) - timedelta(days=days)

    # A framework or control filter resolves to the rule ids that assess it, so
    # "show me what fails PCI Req 1.3" is one request against the same index.
    if control_id or framework:
        wanted: set = set()
        matched = []
        for c in ctl.CONTROLS:
            if framework and c.framework != framework:
                continue
            if control_id and c.control_id != control_id:
                continue
            wanted.update(c.rules)
            matched.append(c)
        existing = set(filters.get("rule_ids") or [])
        filters["rule_ids"] = sorted(wanted & existing) if existing else sorted(wanted)
        # One control scoped to particular resource types (CIS OCI 5.2.1 is
        # block volumes only) lists only those, as its state was decided.
        if len(matched) == 1 and matched[0].resource_types:
            scoped = set(matched[0].resource_types)
            asked = set(filters.get("resource_types") or [])
            filters["resource_types"] = sorted(scoped & asked) if asked else sorted(scoped)
        if not filters["rule_ids"]:
            return {"findings": [], "total": 0, "limit": limit, "offset": offset,
                    "has_more": False,
                    "note": "No rule in this build assesses the requested control."}

    out = await svc.findings(account_ids=[account_id], filters=filters,
                             limit=limit, offset=offset)
    out["facets"] = await svc.repo.facets([account_id])
    return _strip_evidence(out, principal.can(rbac.SECURITY_VIEW_RAW))


@router.get("/{account_id}/findings/{key}")
async def get_finding(
    account_id: uuid.UUID,
    key: str,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """One finding plus everything connected to it: the rule, the evidence, the
    alerts it produced, the controls it breaches, its timeline, and deep links
    into Drift, Events, Topology and the resource itself (§38)."""
    out = await svc.finding_detail(account_id, key)
    if out is None:
        raise HTTPException(status_code=404, detail="Finding not found")
    return _strip_evidence(out, principal.can(rbac.SECURITY_VIEW_RAW))


class StatusPayload(BaseModel):
    status: str
    reason: Optional[str] = None
    assigned_to: Optional[str] = None


@router.post("/{account_id}/findings/{key}/status")
async def set_finding_status(
    account_id: uuid.UUID,
    key: str,
    payload: StatusPayload,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.get_principal),
    request: Request = None,
) -> Dict[str, Any]:
    """Change a finding's remediation status.

    Permission depends on the target status, not on the route: assigning or
    marking in-progress is triage, while suppressing or accepting a risk makes
    a real finding stop counting and needs `security:suppress`. Expressing that
    as one route dependency would either over-restrict triage or under-restrict
    suppression.
    """
    needed = (rbac.SECURITY_SUPPRESS
              if payload.status in ("SUPPRESSED", "ACCEPTED_RISK")
              else rbac.SECURITY_TRIAGE)
    if not principal.can(needed):
        await rbac.deny(principal, needed, request)

    row, err = await svc.set_finding_status(
        account_id=account_id, key=key, status=payload.status,
        reason=payload.reason, actor=_actor(principal),
        assigned_to=payload.assigned_to,
    )
    if err:
        raise HTTPException(status_code=404 if err == "Finding not found" else 400,
                            detail=err)
    return row


@router.get("/{account_id}/compliance")
async def get_compliance(
    account_id: uuid.UUID,
    framework: Optional[str] = Query(None),
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Control states derived from canonical findings. No independent
    interpretation, no invented percentage."""
    if framework and framework not in ctl.FRAMEWORKS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown framework {framework!r}. Known: {', '.join(ctl.FRAMEWORKS)}",
        )
    await _require_applicable(svc, account_id, framework)
    return await svc.compliance(account_id, framework=framework)


async def _require_applicable(svc: SecurityCenterService, account_id: uuid.UUID,
                              framework: Optional[str]) -> None:
    """A provider benchmark asked of another cloud's account is a 400 that says
    so — not an empty 200 that reads like "no controls failed"."""
    if not framework:
        return
    account = await svc.accounts.get_by_id(account_id)
    if account is not None and not ctl.applies_to(framework, account.provider):
        raise HTTPException(
            status_code=400,
            detail=(f"{ctl.FRAMEWORK_META[framework]['label']} applies to "
                    f"{', '.join(ctl.FRAMEWORK_META[framework]['providers'])} accounts; "
                    f"this is a {account.provider} account."),
        )


@router.get("/{account_id}/compliance/{framework}/{control_id:path}")
async def get_control(
    account_id: uuid.UUID,
    framework: str,
    control_id: str,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """One control's state and the findings that decided it.

    `control_id:path` because HIPAA control ids contain slashes and parentheses
    — `164.312(a)(2)(iv)` — and a plain path parameter would truncate them.
    """
    if framework not in ctl.FRAMEWORKS:
        raise HTTPException(status_code=400, detail=f"Unknown framework {framework!r}")
    await _require_applicable(svc, account_id, framework)
    data = await svc.compliance(account_id, framework=framework, include_diff=False)
    match = next((c for c in data["controls"] if c["control_id"] == control_id), None)
    if match is None:
        raise HTTPException(
            status_code=404,
            detail=f"Control {control_id!r} is not in this build's {framework} catalog.",
        )
    return {"control": match, "framework": data["frameworks"].get(framework)}


@router.get("/{account_id}/exposure")
async def get_exposure(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Per-resource internet reachability with the full evidence path.

    Every internet-capable resource gets a verdict — EXPOSED, PROTECTED or
    UNKNOWN — and `clean_result_trustworthy` tells the UI whether it is allowed
    to render a clean empty state at all.
    """
    try:
        out = await svc.exposure(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return _strip_evidence(out, principal.can(rbac.SECURITY_VIEW_RAW))


@router.get("/{account_id}/identity")
async def get_identity(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Identity risk, plus the collection status that says whether an empty
    result means "nothing over-privileged" or "we were refused"."""
    try:
        out = await svc.identity_review(account_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return _strip_evidence(out, principal.can(rbac.SECURITY_VIEW_RAW))


@router.get("/{account_id}/coverage")
async def get_coverage(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """How much of the data each check needs was available — a
    data-availability metric, never a security score."""
    return await svc.coverage(account_id)


@router.get("/{account_id}/trends")
async def get_trends(
    account_id: uuid.UUID,
    limit: int = Query(60, ge=2, le=365),
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    return await svc.trends(account_id, limit=limit)


@router.get("/{account_id}/diagnostics")
async def get_diagnostics(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """Why the numbers look the way they do: what ran, what did not, and what
    the provider refused."""
    return await svc.diagnostics(account_id)


@router.get("/{account_id}/score")
async def explain_score(
    account_id: uuid.UUID,
    svc: SecurityCenterService = Depends(get_service),
    _: rbac.Principal = Depends(rbac.require(rbac.SECURITY_VIEW)),
) -> Dict[str, Any]:
    """"Why is my score 72?" — the deductions in the order they were applied,
    which sum to the displayed total (§6)."""
    findings = await svc.repo.findings_for_account(account_id)
    latest = await svc.repo.latest_assessment(account_id)
    score = scoring.compute(
        findings,
        coverage_pct=latest.coverage_pct if latest else None,
        resources_evaluated=latest.resources_evaluated if latest else None,
    )
    return scoring.explain(score)


def _csv(value: Optional[str]) -> Optional[List[str]]:
    if not value:
        return None
    parts = [p.strip() for p in value.split(",") if p.strip()]
    return parts or None
