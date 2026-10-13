"""Certificate, secret and key analysis. Pure: no I/O, no clock of its own.

Input is the stored credential inventory plus the health of every source scope
it came from; output is the risks the engine turns into canonical findings.
The engine is still the only thing that produces a finding — this module is to
certificates what `identity.py` is to Azure role assignments.

**Why expiry is two rules, not one.** A certificate with 25 days left is valid.
Calling it a control failure would be false: PCI-DSS 4.2.1 asks that
certificates be "confirmed as valid and not expired", and it is. So:

* `CERT_EXPIRED` — a confirmed failure, cited against compliance controls.
  HIGH, or LOW when the provider says the certificate is not in use (then it is
  clutter to delete, not an outage).
* `CERT_EXPIRING_SOON` — operational, never a control failure. MEDIUM inside 7
  days, LOW inside 30. Paging on it is the job of the alert condition, which
  lets each team choose its own window.

Crossing the expiry date therefore resolves the "expiring" finding and opens an
"expired" one. That is the truth — the condition changed — and the new finding
is the more severe of the two.

**Renewal that the provider manages is still checked.** ACM renews 60 days
before expiry, App Service managed certificates and Key Vault auto-renew
policies well before 30. A managed certificate inside the 30-day window means
renewal has not happened, so it is reported — with the provider's renewal
status in the evidence — rather than waved through as "AWS renews it".

**A renewal uploaded under a new name supersedes the old certificate.**
Renewing rarely updates the old object in place: App Service, OCI load
balancers and imported ACM certificates all take the renewed certificate as a
NEW object, often under a new name (toriotcom-26 → toriotcom-27), and the old
one stays behind until someone deletes it. Without recognising that, every
renewal leaves an "expired" finding that no renewal can clear. So a
certificate is *superseded* when another certificate in the same account is
valid now, outlives it, and covers every domain it covers (see
`supersession`). What that changes depends on whether the old one is in use:

* not in use → it is a leftover. `CERT_EXPIRED` / `CERT_EXPIRING_SOON` do not
  fire; a LOW `CERT_SUPERSEDED` cleanup finding names its replacement.
* in use, or use unknown → the expiry findings stand exactly as before (an
  expired certificate on a listener is an outage whatever else exists), and
  their detail names the replacement to switch the binding to.

AWS IAM server certificates are excluded: CIS asks for every expired one to be
deleted, replacement or not.

**Nothing unread passes.** A store that could not be read yields a
`CREDENTIAL_STORE_NOT_READ` gap (verdict NOT_SCANNED), and its certificates'
rules are counted NOT_SCANNED for compliance — so a control can go PARTIAL or
UNKNOWN, never PASS, over a vault that refused us.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.models.credential_inventory import (
    COLLECT_NEVER_RUN, COLLECT_NOT_SUPPORTED, COLLECT_OK, COLLECTION_ACTIONABLE,
    COLLECTION_LABEL, KIND_CERTIFICATE, KIND_KEY, KIND_SECRET,
)
from app.security.model import (
    AZURE, CONF_HIGH, CONF_MEDIUM, CONF_UNKNOWN, HIGH, LOW, MEDIUM, NOT_APPLICABLE,
    NOT_SCANNED, SAFE, VULNERABLE,
)

# ── Rule ids (declared in registry.py, which imports these) ─────────────────
CERT_EXPIRED = "CERT_EXPIRED"
CERT_EXPIRING_SOON = "CERT_EXPIRING_SOON"
AWS_IAM_SERVER_CERT_EXPIRED = "AWS_IAM_SERVER_CERT_EXPIRED"
SECRET_EXPIRED = "SECRET_EXPIRED"
SECRET_EXPIRING_SOON = "SECRET_EXPIRING_SOON"
# CIS Azure numbers these separately for RBAC vaults and access-policy vaults
# (8.3.1-8.3.4 in v6.0.0), so the rule is chosen by the vault's permission
# model — one rule per (model, kind) — and each can be cited exactly.
AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY = "AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY"
AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY = "AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY"
AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY = "AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY"
AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY = "AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY"
AZURE_KEYVAULT_NOT_RECOVERABLE = "AZURE_KEYVAULT_NOT_RECOVERABLE"
AWS_SECRETSMANAGER_ROTATION_DISABLED = "AWS_SECRETSMANAGER_ROTATION_DISABLED"
SECRET_ROTATION_OVERDUE = "SECRET_ROTATION_OVERDUE"
CREDENTIAL_STORE_NOT_READ = "CREDENTIAL_STORE_NOT_READ"
CERT_SUPERSEDED = "CERT_SUPERSEDED"

RULE_IDS = (
    CERT_EXPIRED, CERT_EXPIRING_SOON, CERT_SUPERSEDED, AWS_IAM_SERVER_CERT_EXPIRED,
    SECRET_EXPIRED,
    SECRET_EXPIRING_SOON, AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY,
    AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY, AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY,
    AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY, AZURE_KEYVAULT_NOT_RECOVERABLE,
    AWS_SECRETSMANAGER_ROTATION_DISABLED, SECRET_ROTATION_OVERDUE,
    CREDENTIAL_STORE_NOT_READ,
)


def no_expiry_rule(kind: str, rbac_vault: Optional[bool]) -> str:
    """Which CIS-numbered rule an unexpiring Key Vault object falls under.

    `rbac_vault` None (the vault did not report its model) is filed under the
    access-policy rule: that was the only model for vaults created before
    Azure changed the default, and ARM reports the flag for every vault that
    uses RBAC.
    """
    if kind == KIND_KEY:
        return (AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY if rbac_vault
                else AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY)
    return (AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY if rbac_vault
            else AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY)

EXPIRY_WINDOW_DAYS = 30
URGENT_DAYS = 7
ROTATION_GRACE_DAYS = 2

# Which sources hold which kind — used to decide whether a rule "ran".
CERT_SOURCES = frozenset({
    "aws:acm", "azure:keyvault:certificates", "azure:app-service-certificates",
    "azure:application-gateway", "oci:certificates", "oci:load-balancer-certificates",
})
IAM_CERT_SOURCES = frozenset({"aws:iam-server-certificates"})
SECRET_SOURCES = frozenset({
    "aws:secretsmanager", "azure:keyvault:secrets", "azure:keyvault:keys",
    "oci:vault-secrets",
})
KEYVAULT_SOURCES = frozenset({
    "azure:keyvault:certificates", "azure:keyvault:secrets", "azure:keyvault:keys",
})
ROTATING_SOURCES = frozenset({"aws:secretsmanager", "oci:vault-secrets"})

# The stores each rule reads. Decides NOT_APPLICABLE vs NOT_SCANNED for a rule
# with nothing to evaluate, and the NOT_SCANNED carried when a store failed.
RULE_SOURCES: Dict[str, frozenset] = {
    CERT_EXPIRED: CERT_SOURCES,
    CERT_EXPIRING_SOON: CERT_SOURCES,
    CERT_SUPERSEDED: CERT_SOURCES,
    AWS_IAM_SERVER_CERT_EXPIRED: IAM_CERT_SOURCES,
    SECRET_EXPIRED: SECRET_SOURCES,
    SECRET_EXPIRING_SOON: SECRET_SOURCES,
    AZURE_KEYVAULT_RBAC_SECRET_NO_EXPIRY: frozenset({"azure:keyvault:secrets"}),
    AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY: frozenset({"azure:keyvault:secrets"}),
    AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY: frozenset({"azure:keyvault:keys"}),
    AZURE_KEYVAULT_POLICY_KEY_NO_EXPIRY: frozenset({"azure:keyvault:keys"}),
    AZURE_KEYVAULT_NOT_RECOVERABLE: frozenset({"azure:keyvault-vaults"}),
    AWS_SECRETSMANAGER_ROTATION_DISABLED: frozenset({"aws:secretsmanager"}),
    SECRET_ROTATION_OVERDUE: ROTATING_SOURCES,
}

SOURCE_LABEL = {
    "aws:acm": "AWS Certificate Manager",
    "aws:iam-server-certificates": "IAM server certificates",
    "aws:secretsmanager": "AWS Secrets Manager",
    "azure:keyvault-vaults": "Key Vault listing",
    "azure:keyvault:certificates": "Key Vault certificates",
    "azure:keyvault:secrets": "Key Vault secrets",
    "azure:keyvault:keys": "Key Vault keys",
    "azure:app-service-certificates": "App Service certificates",
    "azure:application-gateway": "Application Gateway certificates",
    "oci:certificates": "OCI Certificates",
    "oci:vault-secrets": "OCI Vault secrets",
    "oci:load-balancer-certificates": "OCI load balancer certificates",
}


def _g(obj: Any, name: str, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


@dataclass
class CredentialRisk:
    rule_id: str
    severity: str
    subject_key: str
    name: str
    resource_type: str
    detail: str
    evidence: Dict[str, Any]
    region: Optional[str] = None
    verdict: str = VULNERABLE
    confidence: str = CONF_HIGH
    discriminator: Optional[str] = None
    affected_count: int = 1
    affected_sample: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class CredentialAnalysis:
    risks: List[CredentialRisk]
    scopes_ok: int
    scopes_failed: int
    objects_evaluated: int
    rule_stats: Dict[str, Dict[str, int]]


def _bump(stats: Dict[str, Dict[str, int]], rule_id: str, verdict: str, n: int = 1) -> None:
    if n <= 0:
        return
    entry = stats.setdefault(rule_id, {})
    entry[verdict] = entry.get(verdict, 0) + n


def _days(delta: timedelta) -> float:
    return delta.total_seconds() / 86400.0


def _when(dt: Optional[datetime]) -> str:
    return dt.strftime("%d %b %Y") if dt else "an unknown date"


def _type_of(kind: str) -> str:
    return {KIND_CERTIFICATE: "Certificate", KIND_SECRET: "Secret", KIND_KEY: "Key"}.get(
        kind, "Credential")


def _where(obj: Any) -> str:
    container = _g(obj, "container_name")
    source = SOURCE_LABEL.get(_g(obj, "source"), _g(obj, "source"))
    region = _g(obj, "region")
    bits = [b for b in (container, source, region) if b]
    return f" ({', '.join(bits)})" if bits else ""


def _evidence(obj: Any) -> Dict[str, Any]:
    def iso(v):
        return v.isoformat() if hasattr(v, "isoformat") else v

    return {k: iso(_g(obj, k)) for k in (
        "object_key", "source", "source_scope", "container_name", "region", "subject",
        "issuer", "dns_names", "expires_at", "not_before", "status", "managed_renewal",
        "renewal_status", "in_use", "in_use_by", "rotation_enabled",
        "rotation_interval_days", "last_rotated_at", "next_rotation_at", "last_seen_at",
    ) if _g(obj, k) not in (None, [], {})}


# ── Supersession: a renewal uploaded as a new object ────────────────────────
# Only a certificate this close to (or past) its end is looked at: two valid
# certificates for one domain far from expiry are usually deliberate (one per
# region or listener), not a renewal.
SUPERSEDE_LOOKAHEAD_DAYS = 90


def cert_names(obj: Any) -> frozenset:
    """The host names a certificate covers: its SANs, else its subject CN."""
    names = {str(n).strip().lower().rstrip(".") for n in (_g(obj, "dns_names") or [])
             if n and str(n).strip()}
    if not names:
        subject = (_g(obj, "subject") or "").strip()
        cn = subject
        for part in subject.split(","):
            part = part.strip()
            if part.upper().startswith("CN="):
                cn = part[3:]
                break
        cn = cn.strip().lower().rstrip(".")
        # A bare string with "=" in it is a DN without a CN — not a host name.
        if cn and "=" not in cn and " " not in cn:
            names.add(cn)
    return frozenset(names)


def _host_covered(host: str, by: frozenset) -> bool:
    if host in by:
        return True
    # A wildcard covers exactly one label: *.example.com covers a.example.com,
    # not example.com and not a.b.example.com.
    if not host.startswith("*.") and "." in host:
        return "*." + host.split(".", 1)[1] in by
    return False


# Where a certificate can be bound from. A load balancer or gateway serves only
# certificates uploaded to it; an App Service app binds only certificates in
# its own resource group; ACM serves only in its own region. A renewal held
# anywhere else proves the domain was renewed, but cannot be bound in place —
# it has to be uploaded/imported there first.
HOLDER_BOUND_SOURCES = frozenset({
    "oci:load-balancer-certificates", "azure:application-gateway",
    "azure:app-service-certificates",
})
REGION_BOUND_SOURCES = frozenset({"aws:acm"})


def _usable_in_place(old: Any, new: Any, locality: int) -> bool:
    source = _g(old, "source")
    if source in HOLDER_BOUND_SOURCES:
        return locality == 0 and _g(new, "source") == source
    if source in REGION_BOUND_SOURCES:
        return locality <= 1
    return True


def _locality(old: Any, new: Any) -> int:
    """0 = same holder (load balancer, gateway, vault, resource group),
    1 = same store and region, 2 = elsewhere in the account."""
    ck_old, ck_new = _g(old, "container_key"), _g(new, "container_key")
    if ck_old and ck_old == ck_new:
        return 0
    rg_old = ((_g(old, "details") or {}).get("resource_group") or "").lower()
    rg_new = ((_g(new, "details") or {}).get("resource_group") or "").lower()
    same_store = _g(old, "source") == _g(new, "source")
    if same_store and rg_old and rg_old == rg_new:
        return 0
    if same_store and (_g(old, "region") or "").lower() == (_g(new, "region") or "").lower():
        return 1
    return 2


def supersession(objects: Iterable[Any], now: datetime) -> Dict[str, Dict[str, Any]]:
    """For each certificate that has been renewed as a NEW object, its replacement.

    Keyed by the old certificate's object_key. A certificate B supersedes A when,
    in the same account: B is valid now (started, not ended), B ends after A,
    and B covers every host name A covers. A has to be expired or within
    SUPERSEDE_LOOKAHEAD_DAYS of its end. A certificate whose names are unknown
    is never matched — "no names" would otherwise be covered by anything.

    Of several candidates the closest wins (same holder, then same store and
    region), then the one that lasts longest.
    """
    certs = [o for o in objects
             if _g(o, "kind") == KIND_CERTIFICATE and _g(o, "enabled") is not False
             and _g(o, "expires_at") is not None and _g(o, "source") not in IAM_CERT_SOURCES]
    by_account: Dict[Any, List[Tuple[Any, frozenset]]] = {}
    for o in certs:
        by_account.setdefault(_g(o, "account_id"), []).append((o, cert_names(o)))

    out: Dict[str, Dict[str, Any]] = {}
    horizon = now + timedelta(days=SUPERSEDE_LOOKAHEAD_DAYS)
    for members in by_account.values():
        valid = [(o, names) for o, names in members
                 if names and _g(o, "expires_at") > now
                 and (_g(o, "not_before") is None or _g(o, "not_before") <= now)]
        for old, old_names in members:
            old_exp = _g(old, "expires_at")
            if not old_names or old_exp > horizon:
                continue
            best = None
            for new, new_names in valid:
                if new is old or _g(new, "object_key") == _g(old, "object_key"):
                    continue
                if _g(new, "expires_at") <= old_exp:
                    continue
                if not all(_host_covered(h, new_names) for h in old_names):
                    continue
                rank = (_locality(old, new), -_g(new, "expires_at").timestamp())
                if best is None or rank < best[0]:
                    best = (rank, new)
            if best is None:
                continue
            new = best[1]
            exp = _g(new, "expires_at")
            out[_g(old, "object_key")] = {
                "object_key": _g(new, "object_key"),
                "name": _g(new, "name") or _g(new, "object_key"),
                "expires_at": exp.isoformat() if hasattr(exp, "isoformat") else exp,
                "source": _g(new, "source"),
                "source_label": SOURCE_LABEL.get(_g(new, "source"), _g(new, "source")),
                "container_name": _g(new, "container_name"),
                "region": _g(new, "region"),
                "in_use": _g(new, "in_use"),
                "same_holder": best[0][0] == 0,
                "usable_in_place": _usable_in_place(old, new, best[0][0]),
            }
    return out


def is_retired(obj: Any, successor: Optional[Dict[str, Any]]) -> bool:
    """Replaced by a renewal AND reported unused: a leftover, not a risk."""
    return bool(successor) and _g(obj, "in_use") is False


def _successor_note(succ: Dict[str, Any], *, in_use: Optional[bool]) -> str:
    where = ", ".join(b for b in (succ.get("container_name"), succ.get("source_label"),
                                  succ.get("region")) if b)
    exp = succ.get("expires_at")
    when = exp[:10] if isinstance(exp, str) else _when(exp)
    head = (f" It has been renewed: {succ['name']}"
            + (f" ({where})" if where else "") + f" is valid until {when}")
    if in_use is False:
        return head + ". Nothing uses this one, so it can be deleted."
    if in_use and not succ.get("usable_in_place", True):
        return (head + ", but it is held elsewhere and cannot be bound here as it is. "
                "Upload the renewed certificate where this one lives, switch the binding "
                "to it, then delete this one.")
    if in_use:
        return (head + ". Switch the binding that still uses this one to the renewed "
                "certificate, then delete this one.")
    return (head + ". Whether this one is still bound was not reported — confirm "
            "nothing uses it before deleting it.")


def analyse(*, provider: str, objects: Sequence[Any], sources: Sequence[Any],
            now: datetime) -> CredentialAnalysis:
    risks: List[CredentialRisk] = []
    stats: Dict[str, Dict[str, int]] = {}

    # ── Source health ───────────────────────────────────────────────────────
    ok_sources = [s for s in sources if _g(s, "status") == COLLECT_OK]
    failed = [s for s in sources
              if _g(s, "status") not in (COLLECT_OK, COLLECT_NOT_SUPPORTED, COLLECT_NEVER_RUN)]
    ok_by_source = {}
    for s in ok_sources:
        ok_by_source[_g(s, "source")] = ok_by_source.get(_g(s, "source"), 0) + 1
    failed_by_source: Dict[str, int] = {}
    for s in failed:
        failed_by_source[_g(s, "source")] = failed_by_source.get(_g(s, "source"), 0) + 1

    _bump(stats, CREDENTIAL_STORE_NOT_READ, SAFE, len(ok_sources))
    _bump(stats, CREDENTIAL_STORE_NOT_READ, NOT_SCANNED, len(failed))

    groups: Dict[Tuple[str, str], List[Any]] = {}
    for s in failed:
        groups.setdefault((_g(s, "source"), _g(s, "status")), []).append(s)
    for (source, status), members in sorted(groups.items()):
        label = SOURCE_LABEL.get(source, source)
        perms = sorted({_g(m, "missing_permission") for m in members
                        if _g(m, "missing_permission")})
        fixes = sorted({_g(m, "remediation") for m in members if _g(m, "remediation")})
        names = [(_g(m, "scope_label") or _g(m, "scope")) for m in members]
        detail = (f"{len(members)} {label} scope(s) could not be read "
                  f"({COLLECTION_LABEL.get(status, status)}): {', '.join(names[:8])}"
                  f"{'…' if len(names) > 8 else ''}.")
        if perms:
            detail += f" Missing: {'; '.join(perms)}."
        if fixes:
            detail += f" {fixes[0]}"
        risks.append(CredentialRisk(
            rule_id=CREDENTIAL_STORE_NOT_READ,
            severity=MEDIUM if status in COLLECTION_ACTIONABLE else LOW,
            subject_key=f"{source}|{status}",
            name=f"{label}: {len(members)} unread",
            resource_type="CredentialStore",
            detail=detail,
            evidence={"source": source, "status": status, "missing_permission": perms,
                      "scopes": [{"scope": _g(m, "scope"),
                                  "scope_label": _g(m, "scope_label"),
                                  "error_detail": (_g(m, "error_detail") or "")[:300],
                                  "last_success_at": (_g(m, "last_success_at").isoformat()
                                                      if _g(m, "last_success_at") else None)}
                                 for m in members[:50]]},
            verdict=NOT_SCANNED, confidence=CONF_UNKNOWN,
            affected_count=len(members),
        ))

    no_expiry: Dict[Tuple[str, str], List[Any]] = {}
    # Each vault's permission model, from its source row — decides which
    # CIS-numbered no-expiry rule its objects fall under.
    vault_rbac: Dict[str, Optional[bool]] = {}
    for s in sources:
        c = _g(s, "container") or {}
        if _g(s, "source") in KEYVAULT_SOURCES and c.get("vault_id"):
            vault_rbac[c["vault_id"]] = c.get("rbac_authorization")
    successors = supersession(objects, now)
    evaluated = 0

    for obj in objects:
        if _g(obj, "enabled") is False:
            continue
        kind = _g(obj, "kind")
        source = _g(obj, "source")
        exp: Optional[datetime] = _g(obj, "expires_at")
        name = _g(obj, "name") or _g(obj, "object_key")
        evaluated += 1

        if kind == KIND_CERTIFICATE:
            if exp is None:
                continue
            left = _days(exp - now)
            iam_store = source in IAM_CERT_SOURCES
            expired_rule = AWS_IAM_SERVER_CERT_EXPIRED if iam_store else CERT_EXPIRED
            succ = None if iam_store else successors.get(_g(obj, "object_key"))
            in_use = _g(obj, "in_use")
            evidence_succ = {"superseded_by": succ} if succ else {}
            # Renewed as a new object and nothing uses this one: a leftover.
            # Reported once, as cleanup — not as an expiry it can never clear.
            if is_retired(obj, succ) and left <= EXPIRY_WINDOW_DAYS:
                state = (f"expired {int(-left)} day(s) ago, on {_when(exp)}" if left < 0
                         else f"expires in {int(left)} day(s), on {_when(exp)}")
                risks.append(CredentialRisk(
                    rule_id=CERT_SUPERSEDED, severity=LOW,
                    subject_key=_g(obj, "object_key"), name=name,
                    resource_type="Certificate", region=_g(obj, "region"),
                    detail=(f"{name}{_where(obj)} {state}."
                            + _successor_note(succ, in_use=False)),
                    evidence={**_evidence(obj), **evidence_succ}))
                _bump(stats, CERT_SUPERSEDED, VULNERABLE)
                _bump(stats, expired_rule, NOT_APPLICABLE if left < 0 else SAFE)
                _bump(stats, CERT_EXPIRING_SOON, NOT_APPLICABLE if left < 0 else SAFE)
                continue
            if succ:
                _bump(stats, CERT_SUPERSEDED, SAFE)
            if left < 0:
                sev = LOW if in_use is False else HIGH
                use = (" The provider reports it is not in use, so this is a certificate "
                       "to delete rather than an outage." if in_use is False else
                       " It is still attached to a listener or service." if in_use else
                       " Whether it is still in use was not reported.")
                if succ:
                    use += _successor_note(succ, in_use=in_use)
                risks.append(CredentialRisk(
                    rule_id=expired_rule, severity=sev,
                    subject_key=_g(obj, "object_key"), name=name,
                    resource_type="Certificate", region=_g(obj, "region"),
                    detail=(f"{name}{_where(obj)} expired {int(-left)} day(s) ago, on "
                            f"{_when(exp)}.{use}"),
                    evidence={**_evidence(obj), **evidence_succ}))
                _bump(stats, expired_rule, VULNERABLE)
                if not iam_store:
                    _bump(stats, CERT_EXPIRING_SOON, NOT_APPLICABLE)
                continue
            _bump(stats, expired_rule, SAFE)
            if iam_store:
                continue
            if left <= EXPIRY_WINDOW_DAYS:
                managed = _g(obj, "managed_renewal")
                renewal = (_g(obj, "renewal_status") or "").upper()
                sev = MEDIUM if left <= URGENT_DAYS else LOW
                note = ""
                if managed and renewal in ("PENDING_VALIDATION", "FAILED"):
                    sev = MEDIUM
                    note = (f" Renewal is managed by the provider but is {renewal}: it will "
                            "not complete without action (usually domain validation).")
                elif managed and renewal in ("PENDING_AUTO_RENEWAL", "SUCCESS"):
                    note = (f" The provider reports renewal as {renewal}; confirm the "
                            "renewed certificate is deployed.")
                elif managed:
                    note = (" Renewal is managed by the provider, and should already have "
                            "happened this close to expiry.")
                elif managed is False:
                    note = " Nothing renews this certificate automatically."
                if succ:
                    note = _successor_note(succ, in_use=in_use)
                risks.append(CredentialRisk(
                    rule_id=CERT_EXPIRING_SOON, severity=sev,
                    subject_key=_g(obj, "object_key"), name=name,
                    resource_type="Certificate", region=_g(obj, "region"),
                    detail=(f"{name}{_where(obj)} expires in {max(0, int(left))} day(s), "
                            f"on {_when(exp)}.{note}"),
                    evidence={**_evidence(obj), **evidence_succ},
                    confidence=CONF_HIGH))
                _bump(stats, CERT_EXPIRING_SOON, VULNERABLE)
            else:
                _bump(stats, CERT_EXPIRING_SOON, SAFE)
            continue

        if kind in (KIND_SECRET, KIND_KEY):
            noun = _type_of(kind).lower()
            if exp is None:
                if source in KEYVAULT_SOURCES:
                    no_expiry.setdefault((_g(obj, "container_key") or "?", kind), []).append(obj)
                _bump(stats, SECRET_EXPIRED, NOT_APPLICABLE)
            else:
                left = _days(exp - now)
                if left < 0:
                    risks.append(CredentialRisk(
                        rule_id=SECRET_EXPIRED, severity=MEDIUM,
                        subject_key=_g(obj, "object_key"), name=name,
                        resource_type=_type_of(kind), region=_g(obj, "region"),
                        detail=(f"The {noun} {name}{_where(obj)} expired {int(-left)} "
                                f"day(s) ago, on {_when(exp)}, and is still enabled."),
                        evidence=_evidence(obj)))
                    _bump(stats, SECRET_EXPIRED, VULNERABLE)
                else:
                    _bump(stats, SECRET_EXPIRED, SAFE)
                    if left <= EXPIRY_WINDOW_DAYS:
                        risks.append(CredentialRisk(
                            rule_id=SECRET_EXPIRING_SOON, severity=LOW,
                            subject_key=_g(obj, "object_key"), name=name,
                            resource_type=_type_of(kind), region=_g(obj, "region"),
                            detail=(f"The {noun} {name}{_where(obj)} expires in "
                                    f"{int(left)} day(s), on {_when(exp)}."),
                            evidence=_evidence(obj)))
                        _bump(stats, SECRET_EXPIRING_SOON, VULNERABLE)
                    else:
                        _bump(stats, SECRET_EXPIRING_SOON, SAFE)
            if source in KEYVAULT_SOURCES and exp is not None:
                _bump(stats, no_expiry_rule(kind, vault_rbac.get(_g(obj, "container_key"))),
                      SAFE)

            if kind == KIND_SECRET and source in ROTATING_SOURCES:
                _rotation(obj, name, now, risks, stats)

    # Key Vault objects with no expiry: one finding per vault and kind, because
    # the fix (a vault policy, or a sweep of that vault) is per vault.
    for (vault_key, kind), members in sorted(no_expiry.items(), key=lambda kv: kv[0]):
        rbac = vault_rbac.get(vault_key)
        rid = no_expiry_rule(kind, rbac)
        vault = _g(members[0], "container_name") or vault_key
        noun = "secret(s)" if kind == KIND_SECRET else "key(s)"
        risks.append(CredentialRisk(
            rule_id=rid, severity=LOW, subject_key=vault_key,
            name=f"{vault}: {len(members)} {noun} without expiry",
            resource_type="KeyVault", region=_g(members[0], "region"),
            detail=(f"{len(members)} enabled {noun} in Key Vault {vault} have no "
                    "expiration date set. The vault uses "
                    + ("Azure RBAC" if rbac else "access policies")
                    + " for data-plane permissions."),
            evidence={"vault": vault, "vault_id": vault_key, "rbac_authorization": rbac,
                      "objects": [_g(m, "name") for m in members[:100]],
                      "truncated": len(members) > 100},
            discriminator=kind, affected_count=len(members),
            affected_sample=[{"resource_name": _g(m, "name"),
                              "resource_type": _type_of(kind),
                              "resource_key": _g(m, "object_key"),
                              "region": _g(m, "region")} for m in members[:200]]))
        _bump(stats, rid, VULNERABLE, len(members))

    # ── Vault recoverability (Azure) ────────────────────────────────────────
    if (provider or "").upper() == AZURE:
        vaults: Dict[str, Dict[str, Any]] = {}
        for s in sources:
            if _g(s, "source") in KEYVAULT_SOURCES and _g(s, "container"):
                c = _g(s, "container") or {}
                if c.get("vault_id"):
                    vaults[c["vault_id"]] = c
        for vid, c in sorted(vaults.items()):
            purge = c.get("purge_protection")
            soft = c.get("soft_delete")
            problems = []
            if soft is False:
                problems.append("soft delete is disabled")
            if purge is not True:
                # The resource provider returns the vault's full properties, so
                # an absent flag here is the service default (off), not an
                # unread field.
                problems.append("purge protection is not enabled")
            if problems:
                risks.append(CredentialRisk(
                    rule_id=AZURE_KEYVAULT_NOT_RECOVERABLE, severity=MEDIUM,
                    subject_key=vid, name=c.get("vault_name") or vid,
                    resource_type="KeyVault", region=c.get("location"),
                    detail=(f"Key Vault {c.get('vault_name') or vid}: "
                            f"{' and '.join(problems)}."),
                    evidence={k: c.get(k) for k in (
                        "vault_name", "vault_id", "soft_delete", "purge_protection",
                        "soft_delete_retention_days", "rbac_authorization")},
                    confidence=CONF_HIGH))
                _bump(stats, AZURE_KEYVAULT_NOT_RECOVERABLE, VULNERABLE)
            else:
                _bump(stats, AZURE_KEYVAULT_NOT_RECOVERABLE, SAFE)

    # Every rule reports whether it could have run. A rule that found nothing
    # to look at is NOT_APPLICABLE only if a store of its kind was actually
    # read; and whenever one of its stores failed, it also carries NOT_SCANNED —
    # objects found elsewhere do not vouch for a vault that refused us.
    for rid, kind_sources in RULE_SOURCES.items():
        read = sum(ok_by_source.get(s, 0) for s in kind_sources)
        unread = sum(failed_by_source.get(s, 0) for s in kind_sources)
        if rid not in stats and read:
            _bump(stats, rid, NOT_APPLICABLE)
        _bump(stats, rid, NOT_SCANNED, unread)

    return CredentialAnalysis(
        risks=risks, scopes_ok=len(ok_sources), scopes_failed=len(failed),
        objects_evaluated=evaluated, rule_stats=stats)


def _rotation(obj: Any, name: str, now: datetime, risks: List[CredentialRisk],
              stats: Dict[str, Dict[str, int]]) -> None:
    source = _g(obj, "source")
    enabled = _g(obj, "rotation_enabled")
    details = _g(obj, "details") or {}
    if source == "aws:secretsmanager":
        if enabled is False and not details.get("owning_service"):
            risks.append(CredentialRisk(
                rule_id=AWS_SECRETSMANAGER_ROTATION_DISABLED, severity=LOW,
                subject_key=_g(obj, "object_key"), name=name, resource_type="Secret",
                region=_g(obj, "region"),
                detail=f"Automatic rotation is not enabled for {name}{_where(obj)}.",
                evidence=_evidence(obj), confidence=CONF_MEDIUM))
            _bump(stats, AWS_SECRETSMANAGER_ROTATION_DISABLED, VULNERABLE)
        elif enabled is not None:
            _bump(stats, AWS_SECRETSMANAGER_ROTATION_DISABLED, SAFE)

    if not enabled:
        return
    interval = _g(obj, "rotation_interval_days")
    last = _g(obj, "last_rotated_at")
    nxt = _g(obj, "next_rotation_at")
    grace = timedelta(days=ROTATION_GRACE_DAYS)
    overdue_since: Optional[datetime] = None
    if nxt is not None and now > nxt + grace:
        overdue_since = nxt
    elif interval and last is not None and now > last + timedelta(days=interval) + grace:
        overdue_since = last + timedelta(days=interval)
    if overdue_since is not None:
        risks.append(CredentialRisk(
            rule_id=SECRET_ROTATION_OVERDUE, severity=MEDIUM,
            subject_key=_g(obj, "object_key"), name=name, resource_type="Secret",
            region=_g(obj, "region"),
            detail=(f"Rotation is enabled for {name}{_where(obj)} but was due on "
                    f"{_when(overdue_since)} and has not happened"
                    + (f" (last rotated {_when(last)})" if last else "") + "."),
            evidence=_evidence(obj)))
        _bump(stats, SECRET_ROTATION_OVERDUE, VULNERABLE)
    else:
        _bump(stats, SECRET_ROTATION_OVERDUE, SAFE)


def expiry_bucket(expires_at: Optional[datetime], now: datetime) -> str:
    """The bucket a view files an object under. Shared by the API and tests."""
    if expires_at is None:
        return "no_expiry"
    left = _days(expires_at - now)
    if left < 0:
        return "expired"
    if left <= URGENT_DAYS:
        return "within_7"
    if left <= EXPIRY_WINDOW_DAYS:
        return "within_30"
    if left <= 90:
        return "within_90"
    return "later"
