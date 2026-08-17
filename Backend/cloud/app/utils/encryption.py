"""Encryption utilities for `cloud_accounts.credentials_enc`, using Fernet
(AES-128-CBC + HMAC) keyed off the SAME master secret as the database
service's `CredentialEncryptionService` (`ACTMON_ENCRYPTION_KEY`) — not a
second, independently-generated encryption key.

This service can't just `import` that service's module directly: it's a
separately-deployed FastAPI app with its own venv, and both services happen
to use `app` as their top-level package name, so a cross-service import would
silently resolve to whichever `app` package sys.path finds first and break
the OTHER service's own `app.*` imports. Porting just the key-loading logic
here (a few lines) avoids that collision while still deriving the exact same
key bytes the database service's own legacy-Fernet bridge uses
(`Fernet(base64.urlsafe_b64encode(raw_key))` — see
`credential_encryption_service.py`'s `_legacy_fernet_decrypt`), so this is a
port of the shared algorithm/key, not a second encryption mechanism.

Previously this module read a separate `FERNET_KEY` env var and, if unset,
silently generated one, PRINTED it to stdout, and persisted it to `.env` —
the exact "ephemeral key with no recovery path" anti-pattern the rest of the
app explicitly forbids (and the reason an earlier real account's credentials
were once orphaned by a process restart). A missing/malformed key now fails
fast instead.
"""
from __future__ import annotations

import base64
import json

from cryptography.fernet import Fernet

from app.core.config import settings


class CloudEncryptionKeyError(RuntimeError):
    """ACTMON_ENCRYPTION_KEY is missing or malformed. Never caught and
    downgraded to plaintext or an auto-generated key anywhere in this
    service."""


def _load_key_bytes() -> bytes:
    raw = settings.ACTMON_ENCRYPTION_KEY
    if not raw:
        raise CloudEncryptionKeyError(
            "ACTMON_ENCRYPTION_KEY is not set. Use the SAME value as the database "
            "service's .env (generate one there with: python -c \"import base64, os; "
            "print(base64.b64encode(os.urandom(32)).decode())\" if neither service has "
            "one yet). Refusing to encrypt/decrypt cloud account credentials without it."
        )
    try:
        key = base64.urlsafe_b64decode(raw)
    except Exception as e:
        raise CloudEncryptionKeyError(f"ACTMON_ENCRYPTION_KEY is not valid base64: {e}") from e
    if len(key) != 32:
        raise CloudEncryptionKeyError(
            f"ACTMON_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256 (got {len(key)})."
        )
    return key


_fernet: Fernet | None = None


def _cipher() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(base64.urlsafe_b64encode(_load_key_bytes()))
    return _fernet


def encrypt_credentials(credentials: dict) -> str:
    """Serialize and encrypt a credentials dict → base64 string."""
    raw = json.dumps(credentials).encode()
    return _cipher().encrypt(raw).decode()


def decrypt_credentials(token: str) -> dict:
    """Decrypt a stored token → credentials dict."""
    raw = _cipher().decrypt(token.encode())
    return json.loads(raw)
