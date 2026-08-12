"""Encryption utilities using Fernet symmetric encryption."""
from __future__ import annotations

import json
import os

from cryptography.fernet import Fernet

from app.core.config import _ENV_PATH, settings


def _persist_key_to_env(key: str) -> None:
    """Append FERNET_KEY=<key> to .env so a freshly generated key survives
    the next restart. Without this, every account's credentials silently and
    permanently stop decrypting the moment the process restarts — this is
    the exact bug that orphaned the AWS 'suyash' account's credentials."""
    try:
        with open(_ENV_PATH, "a", encoding="utf-8") as f:
            f.write(f"\nFERNET_KEY={key}\n")
    except Exception as exc:
        print(f"[CLOUD-SVC] WARNING: could not persist FERNET_KEY to {_ENV_PATH}: {exc}")


def _get_or_create_key() -> bytes:
    """Return the configured Fernet key, auto-generating and persisting one
    to .env if absent. NEVER regenerate a key once real accounts have been
    saved under it — that permanently orphans their stored credentials with
    no way to recover them. If .env's FERNET_KEY is ever lost or changed,
    every existing cloud account must be deleted and re-added."""
    key = settings.FERNET_KEY
    if key:
        return key.encode()

    generated = Fernet.generate_key()
    print(
        "[CLOUD-SVC] WARNING: FERNET_KEY not set. Generated a new key and "
        f"saved it to {_ENV_PATH} so it survives restarts.\n"
        f"  FERNET_KEY={generated.decode()}"
    )
    os.environ["FERNET_KEY"] = generated.decode()
    _persist_key_to_env(generated.decode())
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
