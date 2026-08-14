"""
ActMon AI — action permission map + dispatch.

The chat orchestrator never executes a mutating action itself — it can only
*propose* one (see chatbot_routes.py's `action_proposal` SSE event), and the
proposal is only ever carried out via `POST /api/v1/chatbot/action/confirm`,
which re-verifies both the password and the RBAC bit server-side before
calling the exact same service function the Infra page's own buttons call
(`os_server_routes.py`'s `/service-action`, `/kill-process`, `/reboot`,
`/update-agent`). No new mutating code path is introduced here — this module
is only the map from an AI-recognized action name to (page_url, verb, the
existing service function).
"""
from sqlalchemy.orm import Session

from app.services.auth.permission_guard import check_permission

# Must match os_server_routes.py's INFRA_DETAIL_PAGE — confirmed against the
# live page_master table there.
INFRA_DETAIL_PAGE = "/infra/:id"
ALERTS_PAGE = "/alerts"

ACTIONS = {
    "restart_service": {"page_url": INFRA_DETAIL_PAGE, "verb": "restart", "module": "infra",
                         "required_params": ["unit"], "summary": "Restart service {unit} on {resource_name}"},
    "kill_process": {"page_url": INFRA_DETAIL_PAGE, "verb": "execute", "module": "infra",
                      "required_params": ["pid"], "summary": "Kill process {pid} on {resource_name}"},
    "reboot_host": {"page_url": INFRA_DETAIL_PAGE, "verb": "restart", "module": "infra",
                     "required_params": [], "summary": "Reboot host {resource_name}"},
    "update_agent": {"page_url": INFRA_DETAIL_PAGE, "verb": "execute", "module": "infra",
                      "required_params": [], "summary": "Trigger an agent self-update on {resource_name}"},
    "acknowledge_alert": {"page_url": ALERTS_PAGE, "verb": "execute", "module": "alerts",
                           "required_params": [], "summary": "Acknowledge active alerts"},
}


def describe(action: str, resource_name: str, params: dict) -> str:
    spec = ACTIONS.get(action)
    if not spec:
        return f"Unrecognized action '{action}'"
    try:
        return spec["summary"].format(resource_name=resource_name or "the resource", **(params or {}))
    except KeyError:
        return spec["summary"].split("{")[0].strip() + f" on {resource_name or 'the resource'}"


def missing_params(action: str, params: dict) -> list:
    spec = ACTIONS.get(action)
    if not spec:
        return []
    params = params or {}
    return [p for p in spec["required_params"] if not params.get(p)]


def allowed(claims: dict, db: Session, action: str) -> tuple:
    """Returns (True, None) or (False, reason)."""
    spec = ACTIONS.get(action)
    if not spec:
        return False, f"'{action}' is not a supported ActMon action."
    try:
        check_permission(claims, db, spec["page_url"], spec["verb"])
        return True, None
    except Exception as e:
        detail = getattr(e, "detail", str(e))
        return False, str(detail)


def execute(action: str, resource_id: int, params: dict, password: str, user_id, db: Session) -> dict:
    """Re-verifies the password (never trusts a client-echoed proposal alone),
    then calls the exact existing mutating service function — same code path
    the Infra page's own action buttons use."""
    from app.services.os_server.host_action_service import (
        verify_user_password, svc_service_action, svc_kill_process, svc_reboot_host, svc_update_agent,
    )

    if not verify_user_password(db, user_id, password):
        raise PermissionError("Password verification failed.")

    params = params or {}
    if action == "restart_service":
        return svc_service_action(resource_id, params.get("unit"), "restart", db)
    if action == "kill_process":
        return svc_kill_process(resource_id, params.get("pid"), db)
    if action == "reboot_host":
        return svc_reboot_host(resource_id, db)
    if action == "update_agent":
        return svc_update_agent(resource_id, db)
    if action == "acknowledge_alert":
        from app.models.agent_model import AgentNotification
        db.query(AgentNotification).filter(AgentNotification.is_read.is_(False)).update(
            {AgentNotification.is_read: True}, synchronize_session=False
        )
        db.commit()
        return {"acknowledged": "all"}
    raise ValueError(f"No execution path wired for action '{action}'.")
