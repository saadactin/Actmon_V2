"""Provider-aware redaction for audit payloads.

Control-plane events carry credential material. CloudTrail records the
`requestParameters` of a CreateAccessKey, Azure records an `authorization`
bearer header, OCI records `request.headers` verbatim. Storing those means the
audit trail — the one table with the widest read audience in the product —
becomes a credential store.

Redaction happens at INGESTION, before the row is written, so the secret never
reaches the database at all. Read-time redaction alone would leave the value on
disk, in every backup, and one missed code path away from exposure.

Two matching strategies, because payload shapes differ per provider:

*   **key match** — the field's own name says what it holds
    (`secretAccessKey`, `Authorization`, `x-amz-security-token`). Matched on a
    normalized key (lowercased, separators stripped) so `secret_access_key`,
    `secretAccessKey` and `Secret-Access-Key` are one rule.
*   **value match** — the field name is innocent but the value is
    recognisably credential-shaped (a PEM block, a JWT, an AWS secret-key
    literal). This catches a secret passed as `body` or `content`.

Both are conservative in the same direction: a false positive costs one
unreadable field in a raw payload, a false negative writes a live credential
into a shared table.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

REDACTED = "[REDACTED]"

# Field names whose contents are credential material. Compared against the key
# with separators and case removed, so one entry covers every spelling.
_SENSITIVE_KEYS = frozenset(
    {
        # Generic
        "password", "passwd", "pwd", "newpassword", "oldpassword", "currentpassword",
        "secret", "secrets", "secretvalue", "secretstring", "secretbinary",
        "token", "accesstoken", "refreshtoken", "idtoken", "bearertoken",
        "sessiontoken", "securitytoken", "authtoken", "apikey", "apisecret",
        "credential", "credentials", "clientsecret", "clientassertion",
        "privatekey", "privatekeycontent", "keymaterial", "keycontent",
        "passphrase", "pass", "connectionstring", "connectionstrings",
        "sasurl", "sastoken", "signature", "sig", "authorization",
        "proxyauthorization", "cookie", "setcookie", "certificate",
        "certificatepassword", "pfx", "pfxblob", "sshkey", "sshpublickey",
        "sshauthorizedkeys", "adminpassword", "administratorloginpassword",
        "masterpassword", "masteruserpassword", "encryptionkey", "cmk",
        "plaintext", "ciphertext", "ciphertextblob", "keyid",
        # AWS-specific
        "secretaccesskey", "sessioncredentials", "accesskeyid",
        "xamzsecuritytoken", "presignedurl", "signedurl",
        # Azure-specific
        "primarykey", "secondarykey", "primaryconnectionstring",
        "secondaryconnectionstring", "storagekey", "accountkey", "keyvalue",
        "customerkey", "instrumentationkey", "vaultbaseurl",
        # OCI-specific
        "opcprincipal", "authstring", "wrappedimportkey", "keydetails",
    }
)

# `accessKeyId` and `keyId` are identifiers rather than secrets, and they are
# genuinely useful in an investigation ("which key was used?"). They are listed
# above only so the normalization is obvious; this set takes them back out.
# Kept explicit so the exception is a decision on the page rather than an
# omission someone has to notice.
_KEEP_ANYWAY = frozenset({"accesskeyid", "keyid"})

_SENSITIVE = _SENSITIVE_KEYS - _KEEP_ANYWAY

# Substrings that make ANY key sensitive, for the fields nobody enumerated.
_SENSITIVE_FRAGMENTS: Tuple[str, ...] = (
    "password", "secret", "privatekey", "clientsecret", "connectionstring",
    "sastoken", "bearer", "passphrase",
)

# Values that are credential-shaped regardless of the field they arrived in.
_VALUE_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("pem-private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("pem-certificate", re.compile(r"-----BEGIN CERTIFICATE-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    ("bearer-header", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}")),
    ("aws-secret-key", re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*\S+")),
    # An AWS long-term access key id is not secret, but a 40-char base64 blob
    # sitting beside one almost always is.
    ("aws-key-pair", re.compile(r"AKIA[0-9A-Z]{16}[^A-Za-z0-9]{1,4}[A-Za-z0-9/+=]{40}")),
    ("sas-signature", re.compile(r"(?i)[?&]sig=[A-Za-z0-9%/+=]{20,}")),
]

# Depth and breadth caps. A provider payload is attacker-influenced input in
# the general case (a resource name, a tag value), so the walk is bounded
# rather than trusting it to terminate.
_MAX_DEPTH = 12
_MAX_ITEMS = 2000


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _is_sensitive_key(key: str) -> bool:
    norm = _normalize_key(key)
    if norm in _KEEP_ANYWAY:
        return False
    if norm in _SENSITIVE:
        return True
    return any(fragment in norm for fragment in _SENSITIVE_FRAGMENTS)


def _redact_value(value: str) -> Tuple[str, bool]:
    """Replace the whole value if it looks like credential material.

    The whole value, not the matched span: a partially-masked secret still
    leaks its length and prefix, and a JWT's header alone identifies the
    issuer.
    """
    for _, pattern in _VALUE_PATTERNS:
        if pattern.search(value):
            return REDACTED, True
    return value, False


def redact(payload: Any) -> Tuple[Any, bool]:
    """Return (redacted_copy, was_redacted).

    Never mutates the input — the caller may still need the original to derive
    a classification (e.g. spotting 0.0.0.0/0 in a security-rule payload) from
    a field that redaction would otherwise have removed. Classification runs
    first, redaction second, and only the redacted copy is persisted.
    """
    state = {"touched": False, "items": 0}
    result = _walk(payload, 0, state)
    return result, state["touched"]


def _walk(node: Any, depth: int, state: Dict[str, Any]) -> Any:
    if depth > _MAX_DEPTH:
        state["touched"] = True
        return "[TRUNCATED: nesting depth]"
    state["items"] += 1
    if state["items"] > _MAX_ITEMS:
        # Bounded, and it says so. Silently dropping the tail would make the
        # raw-event viewer lie about completeness.
        state["touched"] = True
        return "[TRUNCATED: payload too large]"

    if isinstance(node, dict):
        out: Dict[str, Any] = {}
        for key, value in node.items():
            if _is_sensitive_key(str(key)):
                out[key] = REDACTED
                state["touched"] = True
                continue
            out[key] = _walk(value, depth + 1, state)
        return out

    if isinstance(node, (list, tuple)):
        return [_walk(item, depth + 1, state) for item in node]

    if isinstance(node, str):
        cleaned, hit = _redact_value(node)
        if hit:
            state["touched"] = True
        return cleaned

    return node


def redaction_policy() -> Dict[str, Any]:
    """What redaction does, for the settings/diagnostics endpoint.

    Key names are listed; the value patterns are described rather than dumped
    as regex, since the point is for an operator to confirm coverage, not to
    debug the expressions.
    """
    return {
        "applied_at": "ingestion",
        "note": (
            "Sensitive values are replaced before the event row is written, so they "
            "never reach the database. Fields kept on purpose because they are "
            "identifiers rather than secrets: "
            + ", ".join(sorted(_KEEP_ANYWAY))
        ),
        "sensitive_key_count": len(_SENSITIVE),
        "sensitive_key_fragments": list(_SENSITIVE_FRAGMENTS),
        "value_patterns": [name for name, _ in _VALUE_PATTERNS],
        "max_depth": _MAX_DEPTH,
        "max_items": _MAX_ITEMS,
    }
