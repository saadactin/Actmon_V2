"""
Notification template rendering — substitutes {{Variable}} placeholders with
the firing alert's context. An org can override the subject/body per channel
type via notification_templates; otherwise a sensible built-in default is
used, so every channel works out of the box with zero template setup.
"""
import re
from typing import Optional
from sqlalchemy.orm import Session

from app.models.notification_model import NotificationTemplate

VARIABLES = [
    "Organization", "AlertName", "Severity", "ServerName", "Hostname",
    "DatabaseName", "DatabaseType", "Metric", "CurrentValue", "Threshold",
    "Error", "IPAddress", "Timestamp", "AlertDescription",
]

_PLACEHOLDER_RE = re.compile(r"\{\{\s*(\w+)\s*\}\}")
_TAG_RE = re.compile(r"<[^>]+>")

DEFAULT_SUBJECT = "[{{Severity}}] {{AlertName}} — {{ServerName}}"
DEFAULT_BODY = (
    "Alert: {{AlertName}}\n"
    "Severity: {{Severity}}\n"
    "Organization: {{Organization}}\n"
    "Server: {{ServerName}} ({{Hostname}})\n"
    "Database: {{DatabaseName}}\n"
    "Metric: {{Metric}} — current value {{CurrentValue}}, threshold {{Threshold}}\n"
    "IP Address: {{IPAddress}}\n"
    "Time: {{Timestamp}}\n"
    "\n"
    "{{AlertDescription}}\n"
    "{{Error}}"
)

# A slightly richer default for HTML-capable channels (Email).
DEFAULT_BODY_HTML = (
    "<p><b>Alert:</b> {{AlertName}}<br>"
    "<b>Severity:</b> {{Severity}}<br>"
    "<b>Organization:</b> {{Organization}}<br>"
    "<b>Server:</b> {{ServerName}} ({{Hostname}})<br>"
    "<b>Database:</b> {{DatabaseName}}<br>"
    "<b>Metric:</b> {{Metric}} — current value {{CurrentValue}}, threshold {{Threshold}}<br>"
    "<b>IP Address:</b> {{IPAddress}}<br>"
    "<b>Time:</b> {{Timestamp}}</p>"
    "<p>{{AlertDescription}}</p>"
    "<p style=\"color:#a02128\">{{Error}}</p>"
)


def render(template: str, context: dict) -> str:
    """Substitute every {{Variable}} in `template` from `context` (missing
    variables render as an empty string, never leave the raw placeholder)."""
    if not template:
        return ""
    return _PLACEHOLDER_RE.sub(lambda m: str(context.get(m.group(1), "") or ""), template)


def strip_html(s: str) -> str:
    """Best-effort HTML → plain text for the text/alternative MIME part when
    the active template is HTML (a custom table/card template has no separate
    plain-text version stored — this derives one instead of shipping raw tags
    to text-only mail clients)."""
    return _TAG_RE.sub("", s or "").replace("&nbsp;", " ").strip()


def get_templates(db: Session, org_id: int, channel_type: str, html: bool = False) -> dict:
    """Resolve the effective subject/body template for a channel — an org
    override if one exists, else the built-in default."""
    row = (
        db.query(NotificationTemplate)
        .filter(NotificationTemplate.org_id == org_id, NotificationTemplate.channel_type == channel_type)
        .first()
    )
    subject = (row.subject_template if row and row.subject_template else None) or DEFAULT_SUBJECT
    body = (row.body_template if row and row.body_template else None) or (DEFAULT_BODY_HTML if html else DEFAULT_BODY)
    return {"subject": subject, "body": body}


def render_for_channel(db: Session, org_id: int, channel_type: str, context: dict, html: bool = False) -> dict:
    tpl = get_templates(db, org_id, channel_type, html=html)
    return {"subject": render(tpl["subject"], context), "body": render(tpl["body"], context)}


def build_context(*, organization: str = "", alert_name: str = "", severity: str = "",
                   server_name: str = "", hostname: str = "", database_name: str = "",
                   database_type: str = "", metric: str = "", current_value="",
                   threshold="", error: str = "", ip_address: str = "",
                   timestamp: str = "", alert_description: str = "") -> dict:
    """Build the {{Variable}} → value mapping in one place so every caller
    (evaluator, test-notification button) fills the same shape consistently."""
    return {
        "Organization": organization, "AlertName": alert_name, "Severity": severity,
        "ServerName": server_name, "Hostname": hostname, "DatabaseName": database_name,
        "DatabaseType": database_type, "Metric": metric, "CurrentValue": current_value,
        "Threshold": threshold, "Error": error, "IPAddress": ip_address,
        "Timestamp": timestamp, "AlertDescription": alert_description,
    }
