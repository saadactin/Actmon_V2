"""Encryption utilities using Fernet symmetric encryption."""
from __future__ import annotations

import json
import os

from cryptography.fernet import Fernet

from app.core.config import settings


def _get_or_create_key() -> bytes:
    """Return the configured Fernet key, auto-generating one if absent."""
    key = settings.FERNET_KEY
    if key:
        return key.encode()

    # Auto-generate and print a warning (development fallback)
    generated = Fernet.generate_key()
    print(
        "[CLOUD-SVC] WARNING: FERNET_KEY not set. "
        "Generated an ephemeral key — credentials will be unreadable after restart.\n"
        f"  Add to .env:  FERNET_KEY={generated.decode()}"
    )
    # Patch the env-var in-process so the same key is reused during this run
    os.environ["FERNET_KEY"] = generated.decode()
    return generated


_fernet: Fernet | None = None


def _cipher() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_get_or_create_key())
    return _fernet


def encrypt_credentials(credentials: dict) -> str:
    """Serialize and encrypt a credentials dict → base64 string."""
    raw = json.dumps(credentials).encode()
    return _cipher().encrypt(raw).decode()


def decrypt_credentials(token: str) -> dict:
    """Decrypt a stored token → credentials dict."""
    raw = _cipher().decrypt(token.encode())
    return json.loads(raw)
