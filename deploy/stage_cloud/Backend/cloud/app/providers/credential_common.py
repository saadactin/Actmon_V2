"""What every certificate/secret collector returns, and how a public
certificate is read.

A collector returns a list of **scope results** — one per (source, scope) it
tried, whether or not the attempt worked. The failed ones are as important as
the successful ones: they are what stops "no certificate expiring" from being
printed over a vault the scanner was refused. See
app/models/credential_inventory.py for why the scope is the unit of trust.

Certificate parsing is only ever done on PUBLIC material (a load balancer's
uploaded certificate, an Application Gateway's public data). It never touches a
private key, and the bytes are discarded once the dates are read.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from app.models.credential_inventory import (
    COLLECT_AUTH_FAILED, COLLECT_BLOCKED, COLLECT_OK, COLLECT_PERMISSION_DENIED,
    COLLECT_UNAVAILABLE,
)


def scope_result(source: str, scope: str, status: str, *,
                 items: Iterable[Dict[str, Any]] = (), scope_label: Optional[str] = None,
                 error_detail: Optional[str] = None, missing_permission: Optional[str] = None,
                 remediation: Optional[str] = None,
                 container: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "source": source,
        "scope": scope,
        "scope_label": scope_label or scope,
        "status": status,
        # Items are only meaningful when the scope was read in full; a failed
        # scope carries none, so a partial listing can never replace good data.
        "items": list(items) if status == COLLECT_OK else [],
        "error_detail": (error_detail or None) and str(error_detail)[:2000],
        "missing_permission": missing_permission,
        "remediation": remediation,
        "container": container,
    }


def unreadable_note(names: List[str]) -> Optional[str]:
    """The detail a store carries when some of its certificates would not
    parse: they are named, so an unknown expiry is a visible gap rather than a
    certificate that silently is not there."""
    if not names:
        return None
    shown = ", ".join(names[:20])
    more = f" and {len(names) - 20} more" if len(names) > 20 else ""
    return (f"{len(names)} certificate(s) could not be parsed, so their expiry is unknown "
            f"and they are not listed: {shown}{more}.")


def is_transient_text(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in (
        "timed out", "timeout", "connection reset", "connection aborted", "eof occurred",
        "unexpected_eof", "max retries exceeded", "temporarily unavailable", "10053",
        "10054", "name resolution", "getaddrinfo", "connectionerror",
        "endpointconnectionerror", "remote end closed", "ssl",
    ))


def status_from_text(text: str) -> str:
    """Fallback classification when a provider exception carries no code."""
    t = (text or "").lower()
    if any(s in t for s in ("accessdenied", "access denied", "not authorized",
                            "notauthorized", "forbidden", "unauthorizedoperation",
                            "authorizationfailed", "does not have authorization")):
        return COLLECT_PERMISSION_DENIED
    if any(s in t for s in ("invalidclienttokenid", "unrecognizedclient", "signaturedoesnotmatch",
                            "expiredtoken", "notauthenticated", "invalid_client",
                            "authenticationfailed")):
        return COLLECT_AUTH_FAILED
    if "firewall" in t or "forbiddenbyconnection" in t:
        return COLLECT_BLOCKED
    return COLLECT_UNAVAILABLE


def as_utc(value: Any) -> Optional[datetime]:
    """A provider timestamp as an aware UTC datetime, or None.

    Accepts datetimes (naive ones are UTC — every SDK here reports UTC),
    ISO-8601 strings, and Unix epoch seconds (Key Vault's `exp`).
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


# ── Public certificate parsing ───────────────────────────────────────────────
def _load_certificates(data: bytes) -> List[Any]:
    from cryptography import x509
    from cryptography.hazmat.primitives.serialization import pkcs7

    stripped = data.strip()
    begin = stripped.find(b"-----BEGIN")
    if begin > 0:
        # openssl's PKCS#12 export writes "Bag Attributes" / "subject=" lines
        # before the PEM block. Requiring the text to START with BEGIN dropped
        # every such certificate without a trace — 17 of the 38 on KOEL's
        # load balancers, current in-use ones included.
        stripped = stripped[begin:]
    if stripped.startswith(b"-----BEGIN"):
        if b"PKCS7" in stripped[:40]:
            return list(pkcs7.load_pem_pkcs7_certificates(stripped))
        try:
            return list(x509.load_pem_x509_certificates(stripped))
        except ValueError:
            return [x509.load_pem_x509_certificate(stripped)]
    for loader in (lambda b: list(pkcs7.load_der_pkcs7_certificates(b)),
                   lambda b: [x509.load_der_x509_certificate(b)]):
        try:
            certs = loader(stripped)
            if certs:
                return certs
        except ValueError:
            continue
    return []


def _leaf(certs: List[Any]) -> Any:
    """The end-entity certificate of a chain: the one that issued no other."""
    if len(certs) == 1:
        return certs[0]
    subjects_that_issue = {c.issuer.rfc4514_string() for c in certs}
    for c in certs:
        if c.subject.rfc4514_string() not in subjects_that_issue:
            return c
    return certs[0]


def parse_public_certificate(data: Any) -> Optional[Dict[str, Any]]:
    """Dates and identity of the leaf certificate in `data`, or None.

    `data` may be PEM text, DER bytes, PKCS#7 (either encoding), or base64 of
    any of those — Azure hands back base64 PKCS#7, OCI hands back PEM.
    """
    if not data:
        return None
    raw: bytes
    if isinstance(data, str):
        text = data.strip()
        if "-----BEGIN" in text:          # PEM, possibly after a text preamble
            raw = text.encode()
        else:
            try:
                raw = base64.b64decode(text, validate=False)
            except (ValueError, TypeError):
                return None
    else:
        raw = bytes(data)
    try:
        certs = _load_certificates(raw)
    except Exception:  # noqa: BLE001 — unparseable is "no dates", never a guess
        return None
    if not certs:
        return None
    leaf = _leaf(certs)

    from cryptography import x509
    from cryptography.x509.oid import NameOID

    def _cn(name) -> Optional[str]:
        attrs = name.get_attributes_for_oid(NameOID.COMMON_NAME)
        return attrs[0].value if attrs else None

    try:
        sans = leaf.extensions.get_extension_for_class(
            x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        sans = []

    not_after = getattr(leaf, "not_valid_after_utc", None) or leaf.not_valid_after.replace(
        tzinfo=timezone.utc)
    not_before = getattr(leaf, "not_valid_before_utc", None) or leaf.not_valid_before.replace(
        tzinfo=timezone.utc)
    key = leaf.public_key()
    key_name = type(key).__name__.replace("_", "").replace("PublicKey", "")
    size = getattr(key, "key_size", None)
    return {
        "subject": _cn(leaf.subject) or leaf.subject.rfc4514_string(),
        "issuer": _cn(leaf.issuer) or leaf.issuer.rfc4514_string(),
        "not_before": not_before,
        "not_after": not_after,
        "dns_names": list(sans)[:50],
        "key_algorithm": f"{key_name}{'-' + str(size) if size else ''}",
        "serial": format(leaf.serial_number, "x"),
    }
