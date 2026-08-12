"""
The channel_type → send-function map every notification eventually goes
through — one place to look to see which of the 9 channels actually sends
something today (just Email) versus which are settings-only stubs waiting to
be wired (the other 8, per the "Email first" scope decision).

Wiring a new channel later means writing its adapter and swapping one entry
here — the queue, retry, encryption, history and settings UI are already
shared and done.
"""
from typing import Callable

from sqlalchemy.orm import Session

from app.models.notification_model import NotificationChannel
from app.services.notifications import email_channel_service, template_service

CHANNEL_LABELS = {
    "email": "Email",
    "teams": "Microsoft Teams",
    "slack": "Slack",
    "telegram": "Telegram",
    "whatsapp": "WhatsApp Business Cloud API",
    "webhook": "Generic Webhook",
    "pagerduty": "PagerDuty",
    "jira": "Jira Service Management",
    "servicenow": "ServiceNow",
}


def _not_connected(channel_type: str) -> dict:
    return {
        "status": "error",
        "message": f"{CHANNEL_LABELS.get(channel_type, channel_type)} is not yet connected — "
                   "configuration is saved for when it is.",
        "response_code": None,
    }


def _send_email(db: Session, org_id: int, channel_row: NotificationChannel, context: dict,
                 recipients_override=None, cc_override=None, bcc_override=None) -> dict:
    html = template_service.render_for_channel(db, org_id, "email", context, html=True)
    # Derive the plain-text alternative from whatever HTML body is actually
    # being sent (default or a custom table/card template) rather than a
    # hardcoded default — so a saved custom template applies everywhere it's
    # supposed to, not just the HTML part.
    text = template_service.strip_html(html["body"]) if "<" in html["body"] else html["body"]
    return email_channel_service.send_via_channel(
        db, org_id, channel_row.config or {}, html["subject"], html["body"], text,
        recipients_override=recipients_override, cc_override=cc_override, bcc_override=bcc_override,
    )


def _stub(channel_type: str):
    def _send(db: Session, org_id: int, channel_row: NotificationChannel, context: dict,
              recipients_override=None, cc_override=None, bcc_override=None) -> dict:
        return _not_connected(channel_type)
    return _send


# channel_type -> send(db, org_id, channel_row, context, recipients_override=None, cc_override=None, bcc_override=None)
#              -> {status, message, response_code, recipient?}
SEND_DISPATCH: dict[str, Callable] = {
    "email": _send_email,
    **{ct: _stub(ct) for ct in CHANNEL_LABELS if ct != "email"},
}


def send(db: Session, org_id: int, channel_row: NotificationChannel, context: dict,
         recipients_override=None, cc_override=None, bcc_override=None) -> dict:
    fn = SEND_DISPATCH.get(channel_row.channel_type)
    if not fn:
        return {"status": "error", "message": f"Unknown channel type: {channel_row.channel_type}", "response_code": None}
    return fn(db, org_id, channel_row, context,
              recipients_override=recipients_override, cc_override=cc_override, bcc_override=bcc_override)


def test_connection(db: Session, org_id: int, channel_row: NotificationChannel) -> dict:
    """Connection test — Email genuinely tests the underlying SMTP config;
    every other channel honestly reports it isn't wired yet rather than
    faking success."""
    if channel_row.channel_type == "email":
        from app.routes.smtp.smtp_config_routes import _test_smtp
        cfg = email_channel_service.get_default_smtp_config(db)
        if not cfg:
            return {"ok": False, "msg": "No SMTP configuration saved yet — add one in Settings → SMTP Email."}
        return _test_smtp(cfg.smtp_host, cfg.smtp_port, cfg.smtp_user, email_channel_service.resolve_password(cfg), cfg.smtp_tls)
    result = _not_connected(channel_row.channel_type)
    return {"ok": False, "msg": result["message"]}


SAMPLE_CONTEXT = template_service.build_context(
    organization="Your Organization", alert_name="Test Notification", severity="Information",
    server_name="demo-server-01", hostname="demo-server-01.local", database_name="—",
    database_type="—", metric="—", current_value="—", threshold="—",
    error="", ip_address="127.0.0.1", timestamp="just now",
    alert_description="This is a test notification sent from ActMon's Notifications settings.",
)
