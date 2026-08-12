"""
Shared read/write helpers for `notification_channels` rows — the 9 provider
slots. Secrets (webhook URLs, tokens, API keys) are never stored or returned
in the clear: they're JSON-encoded then Fernet-encrypted into `secrets_enc`
(app/services/common/crypto_service.py), and API responses only ever expose
a boolean "is the secret set" per field, never the value.
"""
import json
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models.notification_model import NotificationChannel
from app.services.common.crypto_service import encrypt_secret, decrypt_secret
from app.services.common.time_utils import iso_utc

# The 9 supported channels, in the order the Settings UI presents them.
CHANNEL_TYPES = [
    "email", "teams", "slack", "telegram", "whatsapp",
    "webhook", "pagerduty", "jira", "servicenow",
]

# Which config keys are secrets (encrypted, masked in API output) per channel —
# everything else in `config` is plain settings, stored and returned as-is.
SECRET_FIELDS = {
    "email": [],  # credentials live in smtp_configs, not here
    "teams": ["webhook_url"],
    "slack": ["webhook_url"],
    "telegram": ["bot_token"],
    "whatsapp": ["access_token"],
    "webhook": ["auth_token", "basic_password"],
    "pagerduty": ["integration_key"],
    "jira": ["api_token"],
    "servicenow": ["password"],
}


def get_or_create(db: Session, org_id: int, channel_type: str) -> NotificationChannel:
    row = (
        db.query(NotificationChannel)
        .filter(NotificationChannel.org_id == org_id, NotificationChannel.channel_type == channel_type)
        .first()
    )
    if row:
        return row
    row = NotificationChannel(org_id=org_id, channel_type=channel_type, enabled=False, config={})
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _secrets_dict(row: NotificationChannel) -> dict:
    if not row.secrets_enc:
        return {}
    try:
        return json.loads(decrypt_secret(row.secrets_enc) or "{}")
    except Exception:
        return {}


def resolve_secrets(row: NotificationChannel) -> dict:
    """Decrypted secrets for actually SENDING through this channel — never
    exposed via an API response, only used internally by adapters."""
    return _secrets_dict(row)


def to_public_dict(row: NotificationChannel) -> dict:
    """API-safe shape: plain config as-is, secrets collapsed to a boolean
    'is this field set' per secret key — the value itself never leaves the
    server."""
    secrets = _secrets_dict(row)
    secret_flags = {k: bool(secrets.get(k)) for k in SECRET_FIELDS.get(row.channel_type, [])}
    return {
        "channel_type": row.channel_type,
        "enabled": row.enabled,
        "config": row.config or {},
        "secrets_set": secret_flags,
        "last_test_at": iso_utc(row.last_test_at),
        "last_test_ok": row.last_test_ok,
        "last_test_msg": row.last_test_msg,
        "last_success_at": iso_utc(row.last_success_at),
        "last_failure_at": iso_utc(row.last_failure_at),
        "last_error": row.last_error,
    }


def save(db: Session, row: NotificationChannel, *, enabled: Optional[bool], config: dict, secrets: dict) -> NotificationChannel:
    """Update a channel's settings. `secrets` may include masked/omitted
    fields — only non-empty, non-placeholder values overwrite the stored
    ones, so the UI can round-trip "unchanged" without ever seeing the
    original value."""
    if enabled is not None:
        row.enabled = enabled
    row.config = {**(row.config or {}), **(config or {})}

    if secrets:
        current = _secrets_dict(row)
        for key in SECRET_FIELDS.get(row.channel_type, []):
            if key in secrets and secrets[key]:
                current[key] = secrets[key]
        row.secrets_enc = encrypt_secret(json.dumps(current)) if current else None

    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


def record_test_result(db: Session, row: NotificationChannel, ok: bool, msg: str):
    row.last_test_at = datetime.utcnow()
    row.last_test_ok = ok
    row.last_test_msg = msg[:500] if msg else msg
    db.commit()


def record_send_result(db: Session, row: NotificationChannel, ok: bool, error: Optional[str] = None):
    now = datetime.utcnow()
    if ok:
        row.last_success_at = now
        row.last_error = None
    else:
        row.last_failure_at = now
        row.last_error = error
    db.commit()
