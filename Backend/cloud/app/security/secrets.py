"""Secrets left in cloud configuration — detected, never stored, never shown.

A credential sitting in a Lambda's environment variables is readable by anyone
who can call `GetFunctionConfiguration`, survives every key rotation nobody
knew to perform, and is copied into every log line that dumps the environment.
It is one of the few findings where the fix is unambiguous.

**The value never leaves this module.** Not in the finding, not in the evidence,
not in the API response, not in a log line. What travels is a *fingerprint* —
`sha256(account_id + value)` truncated — plus the key name, the location and
which detector fired. That is enough to answer the three questions an operator
actually has (is this the same secret as that one, has it changed since last
scan, where is it) without this product becoming a second place the secret is
stored. A security tool that copies the secrets it finds into its own database
has enlarged the problem it was bought to shrink.

The fingerprint is salted with the account id so it is stable within an account
and useless across accounts or against a precomputed table. It is deliberately
NOT a security boundary for a guessable value: anyone who can read a fingerprint
of `password123` can confirm that guess. It exists for correlation, and the
response says so rather than implying a cryptographic guarantee.

**Detection reuses `events/redaction.py` rather than restating it.** That module
already decides what a credential-shaped key and a credential-shaped value look
like, and it is the thing that redacts event payloads on the way into the
database. Two independent answers to "is this a secret?" would drift, and the
half that drifted would be the half nobody noticed — so this module imports the
same key set, the same fragments and the same value patterns.

**A surface nobody scans is reported, not omitted.** The scanners read Lambda
environment variables; they do not read EC2 user data, Azure app settings or
container definitions. Staying quiet about that would let "no secrets found"
mean "we looked everywhere", which is false. `surfaces()` reports every known
hiding place, which ones this sweep could actually read, and why.
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

# The single source of truth for what credential material looks like. These are
# private names in `redaction`, imported deliberately: duplicating them here
# would create a second answer that silently diverges from the one actually
# protecting the event log.
from app.events.redaction import (
    _SENSITIVE_FRAGMENTS, _VALUE_PATTERNS, _is_sensitive_key, _normalize_key,
)
from app.security.model import (
    AWS, AZURE, CONF_HIGH, CONF_MEDIUM, CRITICAL, HIGH, INFO, OCI, UNKNOWN,
    VULNERABLE,
)

# ── Rules this analyser produces ─────────────────────────────────────────────
RULE_SECRET_IN_CONFIG = "SECRET_PLAINTEXT_IN_CONFIG"
RULE_SECRET_IN_TAG = "SECRET_PLAINTEXT_IN_TAG"
RULE_SURFACE_NOT_SCANNED = "SECRET_SURFACE_NOT_SCANNED"

RULE_IDS: Tuple[str, ...] = (
    RULE_SECRET_IN_CONFIG, RULE_SECRET_IN_TAG, RULE_SURFACE_NOT_SCANNED,
)


# ── Where secrets hide ───────────────────────────────────────────────────────


class Surface(NamedTuple):
    """A place credentials are known to end up, and whether we can read it."""

    provider: str
    resource_type: str
    path: str                 # dotted path under the resource's config
    label: str
    why: str                  # why this surface is worth reading

    @property
    def key(self) -> str:
        return f"{self.provider}:{self.resource_type}:{self.path}"


SURFACES: Tuple[Surface, ...] = (
    Surface(AWS, "LambdaFunction", "environment_variables",
            "Lambda environment variables",
            "Readable by anyone who can call GetFunctionConfiguration, and "
            "printed by any handler that dumps its environment."),
    Surface(AWS, "EC2Instance", "user_data",
            "EC2 user data",
            "Bootstrap scripts routinely embed credentials, and user data is "
            "readable from the instance metadata service by anything on the host."),
    Surface(AWS, "ECSTaskDefinition", "container_environment",
            "ECS container environment",
            "Task definitions carry per-container environment blocks that are "
            "visible to anyone who can describe the task definition."),
    Surface(AZURE, "AppService", "app_settings",
            "App Service application settings",
            "Application settings are surfaced to the app as environment "
            "variables and are readable with Reader on the site config."),
    Surface(AZURE, "VirtualMachine", "custom_data",
            "VM custom data (cloud-init)",
            "Custom data is the Azure equivalent of user data and is readable "
            "from instance metadata."),
    Surface(OCI, "Function", "config",
            "OCI Function configuration",
            "Function config is a key/value map passed to the function as "
            "environment variables."),
)


class SurfaceState(NamedTuple):
    surface: Surface
    resources_of_type: int
    resources_with_field: int

    @property
    def status(self) -> str:
        """Readable, empty, or not collected — three different facts."""
        if self.resources_of_type == 0:
            return "no_such_resources"
        if self.resources_with_field == 0:
            return "not_collected"
        return "scanned"

    def to_dict(self) -> dict:
        return {
            "provider": self.surface.provider,
            "resource_type": self.surface.resource_type,
            "path": self.surface.path,
            "label": self.surface.label,
            "why": self.surface.why,
            "status": self.status,
            "resources_of_type": self.resources_of_type,
            "resources_with_field": self.resources_with_field,
        }


# ── What was found ───────────────────────────────────────────────────────────


class SecretRisk(NamedTuple):
    """One detected secret. Carries no secret.

    `discriminator` splits several secrets on one resource so each resolves
    independently — removing one environment variable should close one finding,
    not all of them.
    """

    rule_id: str
    severity: str
    confidence: str
    resource_key: Optional[str]
    resource_id: Optional[str]
    resource_name: Optional[str]
    resource_type: Optional[str]
    region: Optional[str]
    discriminator: str
    detail: str
    evidence: Dict[str, Any]
    verdict: str = VULNERABLE


class SecretsResult(NamedTuple):
    risks: List[SecretRisk]
    surfaces: List[SurfaceState]
    rule_stats: Dict[str, Dict[str, int]]

    def to_dict(self) -> dict:
        return {
            "surfaces": [s.to_dict() for s in self.surfaces],
            "scanned_surfaces": sum(1 for s in self.surfaces if s.status == "scanned"),
            "uncollected_surfaces": sum(
                1 for s in self.surfaces if s.status == "not_collected"),
        }


def fingerprint(account_id: str, value: str) -> str:
    """Stable within an account, useless across accounts or from a table.

    NOT a security boundary for a guessable secret — see the module docstring.
    Truncated to 16 hex characters: enough that two distinct secrets in one
    account will not collide, short enough that nobody mistakes it for the
    thing itself.
    """
    return hashlib.sha256(
        f"{account_id}\x00{value}".encode("utf-8")
    ).hexdigest()[:16]


def _detect_value(value: str) -> Optional[str]:
    """Which value-shape detector fires, if any."""
    for name, pattern in _VALUE_PATTERNS:
        if pattern.search(value):
            return name
    return None


# Values that look sensitive by key name but are placeholders, not secrets.
# Flagging these trains an operator to ignore the finding, which is worse than
# not having it.
_PLACEHOLDERS = frozenset({
    "", "none", "null", "nil", "changeme", "change_me", "todo", "tbd",
    "xxx", "xxxx", "placeholder", "example", "test", "dummy", "n/a", "na",
    "<secret>", "${secret}", "redacted", "unset", "false", "true", "0", "1",
})

# A reference to a managed secret store is the GOOD outcome — the config names
# where the secret lives rather than containing it. Flagging it would punish the
# fix. Matched on the value, which is why these are prefixes and not key names.
_MANAGED_REFERENCE_MARKERS = (
    "arn:aws:secretsmanager:", "arn:aws:ssm:", "arn:aws:kms:",
    "@microsoft.keyvault(", "https://", "ocid1.vaultsecret.",
    "secretref:", "vault:",
)


def _is_placeholder(value: str) -> bool:
    return value.strip().lower() in _PLACEHOLDERS


def _is_managed_reference(value: str) -> bool:
    low = value.strip().lower()
    return any(low.startswith(m) for m in _MANAGED_REFERENCE_MARKERS)


def _classify(key: str, value: str) -> Optional[Tuple[str, str, str]]:
    """(secret_type, detector, confidence), or None when this is not a secret.

    Two independent signals, and they are not equally strong:

    * the VALUE matches a known credential shape (a PEM block, a JWT, an AWS
      key pair) — that is what the thing is, regardless of what it is called,
      so confidence is HIGH;
    * the KEY is named like a credential and holds something that is not a
      placeholder or a reference — strong but circumstantial, so MEDIUM.
    """
    if not isinstance(value, str) or _is_placeholder(value):
        return None
    if _is_managed_reference(value):
        return None

    shape = _detect_value(value)
    if shape:
        return (shape.replace("-", " ").title(), f"value:{shape}", CONF_HIGH)

    if _is_sensitive_key(key):
        norm = _normalize_key(key)
        kind = next(
            (f.title() for f in _SENSITIVE_FRAGMENTS if f in norm),
            "Credential",
        )
        return (f"{kind} (by field name)", "key-name", CONF_MEDIUM)
    return None


def _walk_strings(node: Any, prefix: str = "", depth: int = 0):
    """Every (path, key, string value) under a config subtree. Depth-bounded."""
    if depth > 6:
        return
    if isinstance(node, dict):
        for k, v in node.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, str):
                yield path, str(k), v
            else:
                yield from _walk_strings(v, path, depth + 1)
    elif isinstance(node, list):
        for i, v in enumerate(node[:200]):
            path = f"{prefix}[{i}]"
            if isinstance(v, str):
                yield path, prefix.rsplit(".", 1)[-1], v
            else:
                yield from _walk_strings(v, path, depth + 1)


def _resolve(config: Dict[str, Any], path: str) -> Tuple[Any, bool]:
    cur: Any = config
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True


def analyse(
    *, provider: str, account_id: str, resources: Sequence[Any],
) -> SecretsResult:
    """Scan every readable surface. Pure: no I/O, no mutation of the inputs."""
    risks: List[SecretRisk] = []
    stats: Dict[str, Dict[str, int]] = {}

    def bump(rule_id: str, verdict: str) -> None:
        stats.setdefault(rule_id, {}).setdefault(verdict, 0)
        stats[rule_id][verdict] += 1

    by_type: Dict[str, List[Any]] = {}
    for r in resources:
        by_type.setdefault(getattr(r, "resource_type", "") or "", []).append(r)

    # ── Declared surfaces ────────────────────────────────────────────────────
    surface_states: List[SurfaceState] = []
    for surface in SURFACES:
        if surface.provider != provider:
            continue
        of_type = by_type.get(surface.resource_type, [])
        with_field = 0
        for r in of_type:
            subtree, present = _resolve(getattr(r, "config", None) or {}, surface.path)
            if not present or subtree in (None, {}, []):
                continue
            with_field += 1
            for path, key, value in _walk_strings(subtree, surface.path):
                hit = _classify(key, value)
                if hit is None:
                    continue
                secret_type, detector, confidence = hit
                risks.append(SecretRisk(
                    rule_id=RULE_SECRET_IN_CONFIG,
                    severity=CRITICAL if confidence == CONF_HIGH else HIGH,
                    confidence=confidence,
                    resource_key=getattr(r, "provider_resource_id", None),
                    resource_id=str(getattr(r, "id", "") or "") or None,
                    resource_name=getattr(r, "resource_name", None),
                    resource_type=surface.resource_type,
                    region=getattr(r, "region_or_zone", None),
                    discriminator=path,
                    detail=(
                        f"{secret_type} found in {surface.label} at "
                        f"`{path}`. The value is not stored or displayed."
                    ),
                    evidence={
                        "secret_type": secret_type,
                        "detector": detector,
                        "location": surface.label,
                        "path": path,
                        "field_name": key,
                        "fingerprint": fingerprint(account_id, value),
                        "value_length": len(value),
                        "value": "[REDACTED]",
                        "note": (
                            "The secret itself is never stored by this product. "
                            "The fingerprint is salted with the account id and is "
                            "for correlation only — it is not a cryptographic "
                            "guarantee for a guessable value."
                        ),
                    },
                ))
                bump(RULE_SECRET_IN_CONFIG, VULNERABLE)
        surface_states.append(SurfaceState(surface, len(of_type), with_field))

    # ── Tags, which every provider collects ──────────────────────────────────
    for r in resources:
        tags = getattr(r, "tags", None)
        if not isinstance(tags, dict):
            continue
        for key, value in tags.items():
            if not isinstance(value, str):
                continue
            hit = _classify(str(key), value)
            if hit is None:
                continue
            secret_type, detector, confidence = hit
            risks.append(SecretRisk(
                rule_id=RULE_SECRET_IN_TAG,
                severity=HIGH,
                confidence=confidence,
                resource_key=getattr(r, "provider_resource_id", None),
                resource_id=str(getattr(r, "id", "") or "") or None,
                resource_name=getattr(r, "resource_name", None),
                resource_type=getattr(r, "resource_type", None),
                region=getattr(r, "region_or_zone", None),
                discriminator=f"tag:{key}",
                detail=(
                    f"{secret_type} found in the tag `{key}`. Tags are visible to "
                    "anyone who can list the resource, and are copied into cost "
                    "reports and exports."
                ),
                evidence={
                    "secret_type": secret_type,
                    "detector": detector,
                    "location": "Resource tag",
                    "tag_key": str(key),
                    "fingerprint": fingerprint(account_id, value),
                    "value_length": len(value),
                    "value": "[REDACTED]",
                },
            ))
            bump(RULE_SECRET_IN_TAG, VULNERABLE)

    # ── Surfaces nobody read ─────────────────────────────────────────────────
    # One finding per uncollected surface, not per resource: the gap is in the
    # scanner, and 75 copies of it would bury the secrets actually found.
    for state in surface_states:
        if state.status == "not_collected":
            risks.append(SecretRisk(
                rule_id=RULE_SURFACE_NOT_SCANNED,
                severity=INFO,
                confidence=CONF_HIGH,
                resource_key=None, resource_id=None,
                resource_name=state.surface.label,
                resource_type=state.surface.resource_type,
                region=None,
                discriminator=state.surface.key,
                detail=(
                    f"{state.resources_of_type} {state.surface.resource_type} "
                    f"resource(s) exist, but {state.surface.label} is not collected "
                    f"by the scanner, so it was not searched for secrets."
                ),
                evidence={
                    "surface": state.surface.label,
                    "path": state.surface.path,
                    "why_it_matters": state.surface.why,
                    "resources_of_type": state.resources_of_type,
                },
                verdict=UNKNOWN,
            ))
            bump(RULE_SURFACE_NOT_SCANNED, UNKNOWN)

    return SecretsResult(risks=risks, surfaces=surface_states, rule_stats=stats)
