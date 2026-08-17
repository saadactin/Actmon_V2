"""
CredentialEncryptionService — the ONE centralized encryption/masking/redaction
service for every secret ActMon stores or handles: database passwords, SSH
passwords, agent tokens, SMTP passwords, cloud provider keys, and anything
added in the future. No module should implement its own encryption, masking,
or redaction — import this instead.

    from app.services.common.credential_encryption_service import credential_encryption
    credential_encryption.encrypt(plaintext) -> ciphertext envelope
    credential_encryption.decrypt(ciphertext) -> plaintext
    credential_encryption.is_encrypted(value) -> bool
    credential_encryption.mask(value) -> "********" / None-safe
    credential_encryption.looks_like_mask(value) -> bool   (guards update payloads)
    credential_encryption.hash_token(token) -> deterministic lookup hash
    credential_encryption.redact(text) -> secret-scrubbed text (for logging)

── Algorithm ──────────────────────────────────────────────────────────────────
AES-256-GCM (authenticated encryption — confidentiality + integrity in one
primitive) via `cryptography.hazmat.primitives.ciphers.aead.AESGCM`. Every
`encrypt()` call generates a fresh random 96-bit nonce; nonces are never
reused with the same key. Ciphertext is wrapped in a versioned envelope,
`"enc:v1:" + base64(nonce + ciphertext_and_tag)`, so a future `v2` scheme
(key rotation, a different KDF, etc.) can be added to `decrypt()`'s dispatch
without touching anything already encrypted under `v1`.

── Key management ─────────────────────────────────────────────────────────────
The master key is read from the `ACTMON_ENCRYPTION_KEY` environment variable —
NEVER hardcoded, NEVER stored in the database. It must be a base64-encoded
32-byte value. Generate one with:

    python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"

(This is the exact same shape `Fernet.generate_key()` already produces — the
key already configured in this environment's `.env` for `crypto_service.py`
is reused as-is; no new secret needs to be generated or distributed.)

If the environment variable is missing, blank, or does not decode to exactly
32 bytes, every encrypt/decrypt call raises `RuntimeError` at first use. There
is NO fallback to an ephemeral or hardcoded key, and the key is never logged —
a missing key is a configuration error that must be fixed, not silently
worked around with plaintext or a throwaway key.

── Legacy Fernet bridge ────────────────────────────────────────────────────────
Before this service existed, `crypto_service.py` encrypted a handful of
columns (Cosmos DB keys, SMTP/notification secrets) with Fernet, using the
same `ACTMON_ENCRYPTION_KEY` value. `decrypt()` recognizes a legacy Fernet
token (its first decoded byte is always the fixed version byte 0x80) and
transparently decrypts it with the same key bytes, so already-encrypted rows
keep working through the migration window. Anything re-encrypted (via the
migration script, or the next time a value is saved) moves to the new `v1`
envelope.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.fernet import Fernet, InvalidToken

_ENV_VAR = "ACTMON_ENCRYPTION_KEY"
_PREFIX = "enc:v1:"
_MASK = "********"
_MASK_PLACEHOLDERS = {"********", "•" * 8, "•" * 12, "***"}
_NONCE_LEN = 12  # 96-bit, standard for AES-GCM


class CredentialEncryptionKeyError(RuntimeError):
    """Raised when ACTMON_ENCRYPTION_KEY is missing or malformed. Never caught
    and silently downgraded to plaintext anywhere in this app — a missing key
    is a deployment configuration error, not a runtime condition to route
    around."""


def _load_key_bytes() -> bytes:
    raw = os.environ.get(_ENV_VAR)
    if not raw:
        raise CredentialEncryptionKeyError(
            f"{_ENV_VAR} is not set. Generate one with: "
            "python -c \"import base64, os; print(base64.b64encode(os.urandom(32)).decode())\" "
            f"and set it in .env as {_ENV_VAR}=<value>. Refusing to encrypt/decrypt without it."
        )
    try:
        key = base64.urlsafe_b64decode(raw)
    except Exception as e:
        raise CredentialEncryptionKeyError(
            f"{_ENV_VAR} is not valid base64: {e}. Regenerate it with: "
            "python -c \"import base64, os; print(base64.b64encode(os.urandom(32)).decode())\""
        ) from e
    if len(key) != 32:
        raise CredentialEncryptionKeyError(
            f"{_ENV_VAR} must decode to exactly 32 bytes for AES-256 (got {len(key)}). "
            "Regenerate it with: "
            "python -c \"import base64, os; print(base64.b64encode(os.urandom(32)).decode())\""
        )
    return key


_SECRET_LINE_RE = re.compile(
    r"((?:password|passwd|pwd|ssh_password|secret|token|api[_-]?key|authorization)\s*[:=]\s*)"
    r"(?:(Bearer|Basic|Token)\s+)?"
    r"(\"[^\"]*\"|'[^']*'|\S+)",
    re.IGNORECASE,
)
_URL_CRED_RE = re.compile(r"(://[^\s:@/]*):([^\s@/]+)@")


class CredentialEncryptionService:
    """The one centralized encryption/masking/redaction surface. Stateless
    aside from a lazily-loaded, process-cached key — safe to share a single
    module-level instance across the whole app."""

    def __init__(self):
        self._key: bytes | None = None

    def _key_bytes(self) -> bytes:
        if self._key is None:
            self._key = _load_key_bytes()
        return self._key

    # ── core encrypt/decrypt ────────────────────────────────────────────────

    def encrypt(self, plaintext: str | None) -> str | None:
        """Encrypt a plaintext secret. None/empty passes through unchanged
        (there's nothing to encrypt, and every caller already treats a blank
        credential field as "not set")."""
        if not plaintext:
            return plaintext
        key = self._key_bytes()
        nonce = os.urandom(_NONCE_LEN)
        aesgcm = AESGCM(key)
        ct = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return _PREFIX + base64.b64encode(nonce + ct).decode("ascii")

    def decrypt(self, ciphertext: str | None) -> str | None:
        """Decrypt a value produced by `encrypt()`, OR a legacy Fernet token
        encrypted by the old `crypto_service.py`. Raises on a genuinely
        corrupt/wrong-key ciphertext rather than returning garbage — callers
        that need a soft-fail (e.g. the `EncryptedString` type, reading a
        not-yet-migrated plaintext row) check `is_encrypted()` first."""
        if not ciphertext:
            return ciphertext
        if ciphertext.startswith(_PREFIX):
            key = self._key_bytes()
            raw = base64.b64decode(ciphertext[len(_PREFIX):])
            nonce, ct = raw[:_NONCE_LEN], raw[_NONCE_LEN:]
            aesgcm = AESGCM(key)
            return aesgcm.decrypt(nonce, ct, None).decode("utf-8")
        if self._is_legacy_fernet(ciphertext):
            return self._legacy_fernet_decrypt(ciphertext)
        raise ValueError("Value is not a recognized ciphertext (neither enc:v1: nor legacy Fernet).")

    def is_encrypted(self, value: str | None) -> bool:
        """True if `value` is already ciphertext (either format) — used to
        avoid double-encrypting, and by `EncryptedString` to decide whether a
        row read from the database still needs migrating."""
        if not value:
            return False
        return value.startswith(_PREFIX) or self._is_legacy_fernet(value)

    # ── legacy Fernet bridge (read-only — nothing new is ever written in this format) ──

    @staticmethod
    def _is_legacy_fernet(value: str) -> bool:
        try:
            raw = base64.urlsafe_b64decode(value.encode("ascii") + b"=" * (-len(value) % 4))
        except Exception:
            return False
        return len(raw) > 0 and raw[0] == 0x80  # Fernet's fixed version byte

    def _legacy_fernet_decrypt(self, ciphertext: str) -> str:
        key = self._key_bytes()
        fernet_key = base64.urlsafe_b64encode(key)
        try:
            return Fernet(fernet_key).decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except InvalidToken as e:
            raise ValueError("Legacy Fernet ciphertext could not be decrypted with the current key.") from e

    # ── masking (API responses) ─────────────────────────────────────────────

    def mask(self, value: str | None) -> str | None:
        """What a GET response shows in place of a secret value. None stays
        None (field genuinely not set) — everything else becomes a fixed
        placeholder, never a partial/length-revealing mask."""
        return None if not value else _MASK

    def looks_like_mask(self, value: str | None) -> bool:
        """True if `value` is a mask placeholder (this app's own `********`,
        or another already-established one like the bullet-based `••••••••`
        used elsewhere) OR blank — the signal an update payload uses to mean
        'unchanged', so callers never persist the literal placeholder as a
        real credential."""
        if value is None:
            return True
        stripped = value.strip()
        if not stripped:
            return True
        if stripped in _MASK_PLACEHOLDERS:
            return True
        # A run of only mask characters (any length) is still a mask, not a
        # real secret — covers "•"*N/"*"*N variants without an exact-length match.
        return bool(stripped) and all(c in "*•" for c in stripped)

    # ── bearer tokens: hash, never encrypt (see plan — equality lookup) ─────

    def hash_token(self, token: str | None) -> str | None:
        """Deterministic, non-reversible HMAC-SHA256 of a bearer token, keyed
        with the same master key — used for WHERE-clause lookup of agent
        enrollment tokens. Never decrypt a token; the caller always has the
        plaintext already (the agent presents it on every request), so the
        backend only ever needs to verify, not recover, it."""
        if not token:
            return None
        return hmac.new(self._key_bytes(), token.encode("utf-8"), hashlib.sha256).hexdigest()

    # ── connection-row masking (API responses) ──────────────────────────────

    # Never serialized as a value — becomes `"{field}_configured": bool`.
    SENSITIVE_CONNECTION_FIELDS = frozenset({
        "password", "ssh_password",
        "cloud_primary_key_enc", "cloud_secondary_key_enc", "cloud_monitor_client_secret_enc",
    })
    # Structured strings that CAN embed a credential inline (Oracle EZConnect/
    # TNS, `mongodb://user:pass@host` URIs). Callers extract-and-strip any
    # embedded credential at write time (`extract_embedded_credentials`,
    # below) and the column itself is `EncryptedString` for defense in depth —
    # this mask is what an API response shows regardless, same as any other
    # secret-shaped field.
    WHOLESALE_MASKED_FIELDS = frozenset({"oracle_connect_string", "tns_descriptor", "connection_uri"})

    def mask_connection_fields(self, conn) -> dict:
        """A `ConnectionMaster` (or any SQLAlchemy row with a `__table__`) as
        an API-response dict — every sensitive field replaced with a
        `"{field}_configured": bool` flag or a wholesale mask, every other
        column passed through unchanged. Reused by all 6 engines' connection
        list/get routes instead of each returning the raw ORM row (which is
        what let `password` ride along in every response)."""
        out = {}
        for col in conn.__table__.columns:
            name = col.name
            value = getattr(conn, name, None)
            if name in self.SENSITIVE_CONNECTION_FIELDS:
                out[f"{name}_configured"] = bool(value)
            elif name in self.WHOLESALE_MASKED_FIELDS:
                out[name] = self.mask(value)
            else:
                out[name] = value
        return out

    # ── embedded-credential extraction (Oracle EZConnect / DSN, Mongo URI) ──

    # `user/pass@host:port/service` (Oracle EZConnect) — password optional
    # (`user@host...` alone is valid, e.g. OS-authenticated).
    _EZCONNECT_CRED_RE = re.compile(r"^([^/@\s:]+)/([^@\s]+)@(.+)$")
    # `scheme://user:pass@host...` (MongoDB URI, and any other `://` DSN).
    _URI_CRED_RE = re.compile(r"^(\w+://)([^:@/\s]+):([^@\s]+)@(.+)$")

    def extract_embedded_credentials(self, value: str | None):
        """Split a connection-string-shaped value into `(stripped, username,
        password)`. `stripped` has any embedded credential removed (leaving a
        pure DSN/URI); `username`/`password` are `None` when nothing was
        embedded (the normal case for this app's own Oracle DSNs — see
        oracle_connection_service.py, which passes `user`/`password` to
        oracledb separately from the DSN already).

        Used at WRITE time so a user pasting a full `scott/tiger@host:1521/
        orcl` or `mongodb://user:pass@host/db` string doesn't leave a live,
        readable credential sitting in `oracle_connect_string`/
        `tns_descriptor`/`connection_uri` redundant with (and unprotected by
        the same rotation/update path as) the connection's own encrypted
        `username`/`password` columns — the credential is promoted to those
        dedicated columns instead, not just masked in place."""
        if not value:
            return value, None, None
        m = self._URI_CRED_RE.match(value)
        if m:
            scheme, user, pw, rest = m.groups()
            return f"{scheme}{rest}", user, pw
        m = self._EZCONNECT_CRED_RE.match(value)
        if m:
            user, pw, rest = m.groups()
            return rest, user, pw
        return value, None, None

    # ── deep structural masking (nested config blobs — Patroni dynamic
    # config/patroni.yml, and anywhere else a dict/list tree can carry a
    # secret at an arbitrary depth) ─────────────────────────────────────────

    _DEEP_SECRET_KEY_RE = re.compile(
        r"(password|token|secret|credential|private_key|api_key|passwd)", re.I
    )

    def mask_deep(self, node):
        """Recursively mask any dict key matching a secret-shaped name, at
        any depth. Originated in the Patroni config/patroni.yml masking
        (the one place in the app that already did this correctly) —
        promoted here so it's the ONE implementation, reusable for any
        nested config structure, not private to one file."""
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if isinstance(v, (dict, list)):
                    out[k] = self.mask_deep(v)
                elif self._DEEP_SECRET_KEY_RE.search(str(k)) and v not in (None, ""):
                    out[k] = _MASK
                else:
                    out[k] = v
            return out
        if isinstance(node, list):
            return [self.mask_deep(v) for v in node]
        return node

    def reconcile_deep(self, submitted, current):
        """Where `submitted` still carries the mask placeholder for a secret
        key, substitute the REAL value from `current` instead of writing the
        literal mask over a real credential. Anything actually changed passes
        through untouched. Stateless (reconciled against a freshly-read
        `current` each call) — safe across multiple worker processes."""
        if isinstance(submitted, dict) and isinstance(current, dict):
            out = {}
            for k, v in submitted.items():
                cur_v = current.get(k)
                if self._DEEP_SECRET_KEY_RE.search(str(k)) and v == _MASK and cur_v is not None:
                    out[k] = cur_v
                elif isinstance(v, (dict, list)):
                    out[k] = self.reconcile_deep(v, cur_v)
                else:
                    out[k] = v
            return out
        return submitted

    def token_match_filter(self, hash_column, plain_column, token: str):
        """SQLAlchemy filter clause for looking up a row by a presented
        bearer token: hash-matches the token against `hash_column` (the
        correct, permanent check), OR-ed with a plaintext match against
        `plain_column` so a row `migrate_credentials_to_encrypted.py` hasn't
        backfilled yet still authenticates during the cutover window. Every
        agent-token/db-target-token lookup in the app should use this
        instead of a raw `column == token` filter."""
        from sqlalchemy import or_
        return or_(hash_column == self.hash_token(token), plain_column == token)

    # ── logging redaction ────────────────────────────────────────────────────

    def redact(self, text: str | None) -> str | None:
        """Scrub secret-shaped substrings out of a string before it's logged.
        Covers `key=value`-style fields (password=, token=, api_key=,
        Authorization:, ...) and `scheme://user:pass@host`-style URLs. Applied
        as a `logging.Filter` app-wide (see `main.py`) — most call sites need
        no per-call change."""
        if not text:
            return text
        redacted = _SECRET_LINE_RE.sub(
            lambda m: m.group(1) + (f"{m.group(2)} " if m.group(2) else "") + _MASK, text,
        )
        redacted = _URL_CRED_RE.sub(lambda m: m.group(1) + ":" + _MASK + "@", redacted)
        return redacted


credential_encryption = CredentialEncryptionService()


class RedactingLogFilter(logging.Filter):
    """Installed once on the root logger (see main.py) so every logger in the
    app is covered without touching individual `logger.*` call sites — scrubs
    the formatted message AND any positional args, since either can carry a
    secret (an f-string already baked into the message, or a raw value passed
    as a %-style logging arg)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = credential_encryption.redact(str(record.msg))
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {k: credential_encryption.redact(str(v)) for k, v in record.args.items()}
                else:
                    record.args = tuple(credential_encryption.redact(str(a)) for a in record.args)
        except Exception:  # noqa: BLE001 — a logging filter must never itself crash the app
            pass
        return True
