"""The Alerts API — rules, instances, recipients, email settings, activity.

Mounted at `/cloud/alerts/{account_id}/…`. Every path carries the account, and
the service resolves the account before anything else, so a rule, recipient or
alert belonging to another account is a 404 here rather than a leak.

Route ordering matters and is not accidental. The pre-existing `alerts.py`
router owns `/cloud/alerts/{alert_id}/acknowledge` — a single-segment
parameterised path. This router uses `/cloud/alerts/{account_id}/<literal>/…`,
which is always two or more segments after the prefix, so the two cannot
collide. The one genuinely ambiguous shape, `/cloud/alerts/{x}`, already
belongs to the old router and is deliberately not redefined here; this router's
equivalent is `/cloud/alerts/{account_id}/summary`.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import rbac
from app.core.database import get_db
from app.services.alert_rule_service import AlertRuleService, NotFound
from app.services.alerts import catalog, engine

logger = logging.getLogger("cloud_svc.alerts.api")

router = APIRouter(prefix="/cloud/alerts", tags=["Alerts"])


async def _service(db: AsyncSession = Depends(get_db)) -> AlertRuleService:
    return AlertRuleService(db)


def _handle(exc: Exception):
    """Turn a service error into the right HTTP answer.

    A validation failure returns the field map, because the rule builder shows
    errors against fields and a flat string forces it to guess.
    """
    if isinstance(exc, NotFound):
        raise HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, catalog.ValidationError):
        raise HTTPException(status_code=422, detail={
            "message": "This rule could not be saved as configured.",
            "errors": exc.errors,
        })
    raise exc


# ── Payloads ──────────────────────────────────────────────────────────────────
class RuleIn(BaseModel):
    name: str
    condition_type: str
    description: Optional[str] = None
    condition_config: Dict[str, Any] = Field(default_factory=dict)
    scope_config: Optional[Dict[str, Any]] = None
    severity: str = "MEDIUM"
    enabled: bool = True
    notification_config: Optional[Dict[str, Any]] = None
    evaluation_interval_seconds: Optional[int] = None
    cooldown_seconds: Optional[int] = None
    repeat_interval_seconds: Optional[int] = None
    notify_on_resolution: bool = False
    min_duration_seconds: Optional[int] = None
    consecutive_breaches_required: Optional[int] = None
    notification_mode: Optional[str] = None
    escalate_after_seconds: Optional[int] = None
    respect_quiet_hours: Optional[bool] = None


class RulePatch(BaseModel):
    """Every field optional — a PATCH is merged onto the stored rule and the
    result is validated as a whole, so a partial edit cannot produce a config
    the evaluator will reject at run time."""

    name: Optional[str] = None
    description: Optional[str] = None
    condition_type: Optional[str] = None
    condition_config: Optional[Dict[str, Any]] = None
    scope_config: Optional[Dict[str, Any]] = None
    severity: Optional[str] = None
    enabled: Optional[bool] = None
    notification_config: Optional[Dict[str, Any]] = None
    evaluation_interval_seconds: Optional[int] = None
    cooldown_seconds: Optional[int] = None
    repeat_interval_seconds: Optional[int] = None
    notify_on_resolution: Optional[bool] = None
    min_duration_seconds: Optional[int] = None
    consecutive_breaches_required: Optional[int] = None
    notification_mode: Optional[str] = None
    escalate_after_seconds: Optional[int] = None
    respect_quiet_hours: Optional[bool] = None


class RulePreviewIn(BaseModel):
    """Everything optional, deliberately.

    The preview fires while the user is still typing, so a half-built rule is
    the NORMAL input, not an error. Reusing `RuleIn` here made FastAPI reject a
    draft with no name yet as a 422 — turning the live panel into a red error
    for most of the time it is on screen. The service decides what is ready
    enough to evaluate and says so in plain words.
    """

    name: Optional[str] = None
    condition_type: Optional[str] = None
    condition_config: Optional[Dict[str, Any]] = None
    scope_config: Optional[Dict[str, Any]] = None
    severity: Optional[str] = None
    notification_config: Optional[Dict[str, Any]] = None
    cooldown_seconds: Optional[int] = None
    min_duration_seconds: Optional[int] = None
    consecutive_breaches_required: Optional[int] = None
    notify_on_resolution: Optional[bool] = None


class RecipientIn(BaseModel):
    email: str
    label: Optional[str] = None
    kind: str = "to"


class TestEmailIn(BaseModel):
    recipients: Optional[List[str]] = None


class AlertActionIn(BaseModel):
    reason: Optional[str] = None


class SilenceIn(BaseModel):
    seconds: int = 3600
    reason: Optional[str] = None


class SettingsIn(BaseModel):
    alert_retention_days: Optional[int] = None
    activity_retention_days: Optional[int] = None
    notification_payload_days: Optional[int] = None
    pruning_enabled: Optional[bool] = None
    display_timezone: Optional[str] = None
    quiet_hours_enabled: Optional[bool] = None
    quiet_hours_start: Optional[str] = None
    quiet_hours_end: Optional[str] = None
    quiet_hours_critical_bypass: Optional[bool] = None


# ── Capabilities and summary ──────────────────────────────────────────────────
@router.get("/{account_id}/capabilities")
async def capabilities(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """What can be alerted on for THIS account, with per-condition support.

    Support is observed, not declared: it asks the billing, security, event and
    drift subsystems whether each condition can actually be evaluated here, so
    the builder can disable one with a real reason instead of offering a rule
    that would sit at UNKNOWN forever.
    """
    try:
        return await svc.capabilities(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/summary")
async def summary(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """The header strip: active alerts, rule counts, delivery state, engine
    health. `rules_inconclusive` is reported alongside the alert count because
    "14 rules, 0 alerts" is reassuring and can mean 14 rules that have not
    managed to read anything."""
    try:
        return await svc.summary(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/activity")
async def activity(
    account_id: str,
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, ge=1, le=500),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Append-only alerting activity: rules created/changed, alerts triggered
    and resolved, notifications queued and skipped."""
    try:
        return await svc.activity(account_id, days=days, limit=limit)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Rules ─────────────────────────────────────────────────────────────────────
@router.get("/{account_id}/rules")
async def list_rules(
    account_id: str,
    category: Optional[str] = Query(None),
    enabled: Optional[bool] = Query(None),
    severity: Optional[str] = Query(None),
    condition_type: Optional[str] = Query(None),
    notifies: Optional[bool] = Query(
        None, description="True: rules that reach at least one recipient. "
                          "False: rules that record alerts but email nobody."),
    q: Optional[str] = Query(None, description="Matches rule name and description."),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Rules, filtered server-side. `facets` in the response carries the counts
    per dimension so the UI can offer only filters that would match something."""
    try:
        return await svc.list_rules(
            account_id, category=category, enabled=enabled, severity=severity,
            condition_type=condition_type, notifies=notifies, search=q)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules/preview")
async def preview_rule(
    account_id: str,
    payload: RulePreviewIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TEST)),
):
    """Evaluate an UNSAVED rule against live data.

    Writes nothing — no rule, no alert, no notification, no audit row. This is
    what answers "what exactly will cause this email to arrive" before the user
    commits to anything, and it returns the same evaluation the engine would
    produce, not an approximation of it.
    """
    try:
        return await svc.preview_rule(account_id, payload.model_dump(exclude_none=True))
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/templates")
async def list_templates(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Rule starting points, each marked with whether THIS account can evaluate
    it. Unsupported templates are returned marked, not hidden — the reason is
    the useful part."""
    try:
        return await svc.templates(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/templates/apply")
async def apply_templates(
    account_id: str,
    keys: Optional[List[str]] = Body(None, embed=True),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Create the recommended rules, DISABLED and with no recipients.

    Two safeguards so an upgrade can never produce a surprise email flood:
    nothing evaluates until each rule is enabled, and even then it reaches
    nobody until someone chooses recipients.
    """
    try:
        return await svc.apply_recommended(
            account_id, keys=keys, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules/{rule_id}/duplicate", status_code=201)
async def duplicate_rule(
    account_id: str, rule_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Copy a rule, disabled — a duplicate is about to be edited, and one that
    started evaluating immediately would double the original's mail."""
    try:
        return await svc.duplicate_rule(
            account_id, rule_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules/{rule_id}/silence")
async def silence_rule(
    account_id: str, rule_id: str,
    payload: SilenceIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    """Stop this rule emailing, without stopping it watching.

    Evaluation continues and alerts still open and resolve, so the Alerts tab
    stays truthful about what is wrong. Only notification is suppressed. That
    is the entire difference from disabling, which is why both exist.
    """
    try:
        return await svc.silence_rule(
            account_id, rule_id, seconds=payload.seconds, reason=payload.reason,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.delete("/{account_id}/rules/{rule_id}/silence")
async def unsilence_rule(
    account_id: str, rule_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    try:
        return await svc.unsilence_rule(
            account_id, rule_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules", status_code=201)
async def create_rule(
    account_id: str,
    payload: RuleIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    try:
        return await svc.create_rule(
            account_id, payload.model_dump(exclude_none=True),
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/rules/{rule_id}")
async def get_rule(
    account_id: str, rule_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    try:
        return await svc.get_rule(account_id, rule_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.patch("/{account_id}/rules/{rule_id}")
async def update_rule(
    account_id: str, rule_id: str,
    payload: RulePatch,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    try:
        return await svc.update_rule(
            account_id, rule_id, payload.model_dump(exclude_unset=True),
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules/{rule_id}/enabled")
async def set_rule_enabled(
    account_id: str, rule_id: str,
    enabled: bool = Body(..., embed=True),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Its own endpoint rather than a PATCH so the audit record says
    "disabled" rather than "updated" — the single most important alerting
    change to be able to find later."""
    try:
        return await svc.set_enabled(
            account_id, rule_id, enabled,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.delete("/{account_id}/rules/{rule_id}")
async def delete_rule(
    account_id: str, rule_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Soft delete. Future evaluations stop; alerts already raised are kept and
    remain queryable, labelled with the deleted rule's name."""
    try:
        return await svc.delete_rule(
            account_id, rule_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/rules/{rule_id}/test")
async def test_rule(
    account_id: str, rule_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TEST)),
):
    """Evaluate against live data and report the real answer. Creates no alert
    and sends no email, even when the condition is met."""
    try:
        return await svc.test_rule(
            account_id, rule_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Alert instances ───────────────────────────────────────────────────────────
@router.get("/{account_id}/instances")
async def list_instances(
    account_id: str,
    state: Optional[List[str]] = Query(None),
    severity: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    rule_id: Optional[str] = Query(None),
    days: Optional[int] = Query(None, ge=1, le=365),
    q: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=500),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    try:
        return await svc.list_alerts(
            account_id, states=state, severity=severity, category=category,
            rule_id=rule_id, days=days, search=q, limit=limit)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/instances/{alert_id}")
async def get_instance(
    account_id: str, alert_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """One alert with the evaluation snapshot that produced it.

    `explain` is the snapshot taken when it fired, NOT a re-evaluation:
    re-running would answer "is this true now", which is a different question
    from "why did I get this email".
    """
    try:
        return await svc.get_alert(account_id, alert_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/instances/{alert_id}/acknowledge")
async def acknowledge_instance(
    account_id: str, alert_id: str,
    payload: AlertActionIn = Body(default=AlertActionIn()),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    try:
        return await svc.act_on_alert(
            account_id, alert_id, "acknowledge", reason=payload.reason,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/instances/{alert_id}/resolve")
async def resolve_instance(
    account_id: str, alert_id: str,
    payload: AlertActionIn = Body(default=AlertActionIn()),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    """Close it by hand. The response carries a note: if the condition is still
    true, the next evaluation re-opens it, which is correct but surprising."""
    try:
        return await svc.act_on_alert(
            account_id, alert_id, "resolve", reason=payload.reason,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/instances/{alert_id}/silence")
async def silence_instance(
    account_id: str, alert_id: str,
    payload: SilenceIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    """Silence ONE alert, not its whole rule.

    "This instance is known and being worked on" is a different decision from
    "stop telling me about this class of thing". The alert stays open and still
    counts as active; only its email is suppressed.
    """
    try:
        return await svc.silence_alert(
            account_id, alert_id, seconds=payload.seconds, reason=payload.reason,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.delete("/{account_id}/instances/{alert_id}/silence")
async def unsilence_instance(
    account_id: str, alert_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TRIAGE)),
):
    try:
        return await svc.unsilence_alert(
            account_id, alert_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Notification channels ─────────────────────────────────────────────────────
@router.get("/{account_id}/channels")
async def list_channels(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Every delivery channel and whether it actually delivers.

    All nine are listed, eight of them marked not implemented, because
    "Actmon has no Slack integration" and "Slack is configured but disabled"
    are different answers and hiding the row gives the first.
    """
    try:
        return await svc.channels(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/channels/{channel_type}/test")
async def test_channel(
    account_id: str, channel_type: str,
    payload: TestEmailIn = Body(default=TestEmailIn()),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TEST)),
):
    """Test the TRANSPORT — deliberately distinct from testing a rule.

    This proves mail can leave the building; a rule test proves the detection
    is right. Confusing the two is how somebody concludes their alerting works
    because an SMTP handshake succeeded.
    """
    try:
        return await svc.test_channel(
            account_id, channel_type, recipients=payload.recipients,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Notification history ──────────────────────────────────────────────────────
@router.get("/{account_id}/notifications")
async def list_notifications(
    account_id: str,
    status: Optional[str] = Query(None, description="sent | failed"),
    days: int = Query(30, ge=1, le=365),
    limit: int = Query(100, ge=1, le=500),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Delivery attempts, from the ledger the dispatcher writes.

    `available: false` when the ledger cannot be read — which is NOT an empty
    list of deliveries, and the response keeps the two apart.
    """
    try:
        return await svc.notifications(account_id, status=status, days=days,
                                       limit=limit)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/notifications/{notification_id}")
async def get_notification(
    account_id: str, notification_id: int,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    try:
        return await svc.notification(account_id, notification_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Email settings ────────────────────────────────────────────────────────────
@router.get("/{account_id}/email")
async def email_settings(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Delivery readiness, recipients and the real send ledger.

    Never returns an SMTP username or password — only host, port, TLS and the
    sender identity, which are the fields an operator needs to recognise which
    server is configured.
    """
    try:
        return await svc.email_settings(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/recipients")
async def list_recipients(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    try:
        return await svc.list_recipients(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/recipients", status_code=201)
async def add_recipient(
    account_id: str,
    payload: RecipientIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RECIPIENTS)),
):
    try:
        return await svc.add_recipient(
            account_id, payload.email, label=payload.label, kind=payload.kind,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/recipients/{recipient_id}/enabled")
async def set_recipient_enabled(
    account_id: str, recipient_id: str,
    enabled: bool = Body(..., embed=True),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RECIPIENTS)),
):
    try:
        return await svc.set_recipient_enabled(
            account_id, recipient_id, enabled,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.delete("/{account_id}/recipients/{recipient_id}")
async def delete_recipient(
    account_id: str, recipient_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RECIPIENTS)),
):
    try:
        return await svc.delete_recipient(
            account_id, recipient_id, actor=principal.name,
            actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/email/enable-channel")
async def enable_email_channel(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RECIPIENTS)),
):
    """Switch on the shared email delivery channel.

    This is an installation-wide setting owned by the database service, not an
    account-scoped one — the same row Settings → Notifications writes. Exposed
    here because without it every queued alert is failed by the dispatcher, and
    an Alerts page that can name the blockage but not clear it is a dead end.
    """
    try:
        return await svc.enable_email_channel(
            account_id, actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/email/test")
async def send_test_email(
    account_id: str,
    payload: TestEmailIn = Body(default=TestEmailIn()),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_TEST)),
):
    """Queue a clearly-labelled `[TEST]` message.

    Reports `queued`, never `sent`. The delivery outcome arrives in the history
    table on the same page once the dispatcher has actually tried — which is
    the distinction that matters when SMTP is wrong.
    """
    try:
        return await svc.send_test_email(
            account_id, recipients=payload.recipients,
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Analytics ─────────────────────────────────────────────────────────────────
@router.get("/{account_id}/analytics")
async def analytics(
    account_id: str,
    days: int = Query(30, ge=1, le=365),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Chart data: alerts over time, by severity/category/provider/state,
    notification outcomes and top rules.

    Delivery is reported twice on purpose — what this service DECIDED (queued,
    suppressed, no recipient) and what the mail server actually DID. Collapsing
    them would let "queued" pass for "delivered".
    """
    try:
        return await svc.analytics(account_id, days=days)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/noisy-rules")
async def noisy_rules(
    account_id: str,
    days: int = Query(7, ge=1, le=90),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Which rules produce more noise than signal, with the four numbers that
    distinguish the causes. Nothing is disabled or retuned automatically."""
    try:
        return await svc.noisy_rules(account_id, days=days)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{account_id}/instances/{alert_id}/related")
async def related_signals(
    account_id: str, alert_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """What else was recorded around this alert — other alerts, configuration
    changes, cloud activity, new security findings and billed-spend movement.

    Co-occurrence only. Nothing here claims causation, and the payload carries
    that disclaimer so an API consumer cannot mistake it either.
    """
    try:
        return await svc.correlation(account_id, alert_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Settings and retention ────────────────────────────────────────────────────
@router.get("/{account_id}/settings")
async def get_settings(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Retention policy and display timezone. Installation-wide, not per
    account — the response says so. Includes a dry-run count of what pruning
    would remove right now."""
    try:
        return await svc.get_settings(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.put("/{account_id}/settings")
async def update_settings(
    account_id: str,
    payload: SettingsIn,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    try:
        return await svc.update_settings(
            account_id, payload.model_dump(exclude_unset=True),
            actor=principal.name, actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{account_id}/settings/prune")
async def run_prune(
    account_id: str,
    dry_run: bool = Query(True, description="Default true — nothing is deleted "
                                            "unless this is explicitly false."),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Apply retention now. Defaults to a dry run because deletion cannot be
    undone. Open and acknowledged alerts are never removed at any age."""
    try:
        return await svc.run_prune(
            account_id, dry_run=dry_run, actor=principal.name,
            actor_role=principal.role)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Engine ────────────────────────────────────────────────────────────────────
@router.get("/{account_id}/engine")
async def engine_health(
    account_id: str,
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_VIEW)),
):
    """Only metrics the engine genuinely records: whether it is running, its
    tick, when the last pass ran, what that pass did, and the last error."""
    try:
        await svc._account(account_id)  # account isolation / existence check
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    return engine.engine_status()


@router.post("/{account_id}/engine/run")
async def run_engine_now(
    account_id: str,
    db: AsyncSession = Depends(get_db),
    svc: AlertRuleService = Depends(_service),
    principal: rbac.Principal = Depends(rbac.require(rbac.ALERT_MANAGE_RULES)),
):
    """Run a full evaluation pass immediately.

    Deliberately NOT account-scoped in its effect: the engine's unit of work is
    "every rule that is due", and running a partial pass would leave
    last_evaluated_at inconsistent with what was actually checked. The account
    in the path is the authorisation scope, and the response says so.
    """
    try:
        await svc._account(account_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    result = await engine.AlertEngine(db).run_once()
    return {
        "ran": True,
        "scope": "all due rules across every account",
        "result": result,
    }
