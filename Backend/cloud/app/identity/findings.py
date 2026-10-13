"""CIEM findings, expressed in the Security Center's canonical finding model.

These do NOT constitute a second finding engine. They produce
`security.model.SecurityFinding` objects with the same fingerprinting, the same
severity vocabulary, the same verdict and confidence semantics and the same
status lifecycle as every other finding in the product, so they appear in the
Security Center, map to compliance controls, and can be alerted on, triaged and
suppressed by the machinery that already exists.

`app/cloud/pages/CloudOverview` once had a second, independent security engine
that scored the same account 0/F while the real one said 35/F. That is the
mistake this module is written to avoid: the rule IDs are declared here, the
`SecurityRule` definitions live in `security/registry.py` beside every other
rule, and `verify_identity_findings.py` pins that the two agree.

**Two verdict disciplines carry over, and matter more here than anywhere.**

*   A principal whose policies could not be read produces an UNKNOWN-verdict
    coverage finding, never a clean result. `PRIV_UNKNOWN` is not a low
    privilege level, and an identity tab showing "0 privileged identities" over
    an account where RBAC collection was refused would be the single most
    dangerous screen in the product.
*   An MFA state of UNKNOWN is a coverage gap, not an MFA failure. Only
    `MFA_DISABLED` — the provider positively reporting no registered device —
    produces a finding.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity.model import (
    ACTOR_HUMAN, ACTOR_WORKLOAD, DORMANCY_DORMANT, DORMANCY_NEVER_USED,
    EXTERNAL_ANONYMOUS, EXTERNAL_YES, HIGH_IMPACT_WHY, MFA_DISABLED, MFA_UNKNOWN,
    PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_UNKNOWN, USAGE_NOT_OBSERVED_HIGH,
)
from app.security.model import (
    CAT_GOVERNANCE, CAT_IAM, CONF_HIGH, CONF_LOW, CONF_MEDIUM, CRITICAL, HIGH, INFO,
    LOW, MEDIUM, SecurityFinding, UNKNOWN, VULNERABLE, fingerprint, normalize_provider,
)

# ── Rule ids (SecurityRule objects are declared in security/registry.py) ─────
PRIVILEGED_IDENTITY_WITHOUT_MFA = "IDENTITY_PRIVILEGED_WITHOUT_MFA"
DORMANT_PRIVILEGED_IDENTITY = "IDENTITY_DORMANT_PRIVILEGED"
DORMANT_IDENTITY = "IDENTITY_DORMANT"
STALE_ACCESS_KEY = "IDENTITY_STALE_CREDENTIAL"
NEVER_USED_CREDENTIAL = "IDENTITY_NEVER_USED_CREDENTIAL"
MULTIPLE_ACTIVE_KEYS = "IDENTITY_MULTIPLE_ACTIVE_CREDENTIALS"
EXCESSIVE_PERMISSION_SCOPE = "IDENTITY_EXCESSIVE_PERMISSION_SCOPE"
UNUSED_PERMISSION = "IDENTITY_UNUSED_PERMISSION"
EXTERNAL_PRIVILEGED_PRINCIPAL = "IDENTITY_EXTERNAL_PRIVILEGED_PRINCIPAL"
ANONYMOUS_TRUST = "IDENTITY_ANONYMOUS_TRUST"
STANDING_ADMIN_ACCESS = "IDENTITY_STANDING_ADMIN_ACCESS"
HIGH_BLAST_RADIUS_IDENTITY = "IDENTITY_HIGH_BLAST_RADIUS"
UNMONITORED_BREAK_GLASS = "IDENTITY_POTENTIAL_BREAK_GLASS"
OVERLY_BROAD_ROLE = "IDENTITY_OVERLY_BROAD_ROLE"
CROSS_ACCOUNT_TRUST_NO_EXTERNAL_ID = "IDENTITY_CROSS_ACCOUNT_TRUST_UNCONSTRAINED"
UNUSED_SERVICE_PRINCIPAL = "IDENTITY_UNUSED_WORKLOAD"
ROOT_ACCOUNT_IN_USE = "IDENTITY_ROOT_ACCOUNT_ACTIVE"

# Coverage gaps. These carry verdict UNKNOWN and exist so that an empty result
# is never mistaken for a clean one.
POLICIES_NOT_EVALUATED = "IDENTITY_POLICIES_NOT_EVALUATED"
MFA_STATE_UNKNOWN = "IDENTITY_MFA_STATE_UNKNOWN"
USAGE_DATA_UNAVAILABLE = "IDENTITY_USAGE_DATA_UNAVAILABLE"

RULE_IDS: Tuple[str, ...] = (
    PRIVILEGED_IDENTITY_WITHOUT_MFA, DORMANT_PRIVILEGED_IDENTITY, DORMANT_IDENTITY,
    STALE_ACCESS_KEY, NEVER_USED_CREDENTIAL, MULTIPLE_ACTIVE_KEYS,
    EXCESSIVE_PERMISSION_SCOPE, UNUSED_PERMISSION, EXTERNAL_PRIVILEGED_PRINCIPAL,
    ANONYMOUS_TRUST, STANDING_ADMIN_ACCESS, HIGH_BLAST_RADIUS_IDENTITY,
    UNMONITORED_BREAK_GLASS, OVERLY_BROAD_ROLE, CROSS_ACCOUNT_TRUST_NO_EXTERNAL_ID,
    UNUSED_SERVICE_PRINCIPAL, ROOT_ACCOUNT_IN_USE, POLICIES_NOT_EVALUATED,
    MFA_STATE_UNKNOWN, USAGE_DATA_UNAVAILABLE,
)

RULE_VERSION = "1.0"


def _rule(rule_id: str) -> Any:
    """The registry's declaration for a rule.

    Imported lazily so `findings` can be imported by a test that does not want
    the whole registry, and so the import cycle (registry declares the rules,
    this module names them) never has to be resolved at module load.
    """
    from app.security.registry import RULES

    return RULES.get(rule_id)


def _finding(
    *, rule_id: str, provider: str, account_id: str, identity: Any,
    title: str, description: str, severity: str, evidence: Dict[str, Any],
    confidence: str = CONF_HIGH, verdict: str = VULNERABLE,
    category: str = CAT_IAM, discriminator: Optional[str] = None,
) -> SecurityFinding:
    """Build a canonical finding pointing at a principal.

    `resource_key` is the identity's provider id, which is what makes the
    fingerprint stable across scans — the same reasoning the Security Center
    applies to resources, and the reason a finding survives a re-collection
    rather than resolving and reappearing.

    `rationale` and `remediation` come from the registry, never from the
    analyser. A finding persisted with an empty remediation renders as a blank
    panel in the Security Center, and the registry's self-check already
    enforces that every rule has a real one — reading it here is what makes
    that guarantee reach the stored row.
    """
    prov = normalize_provider(provider) or provider
    key = _get(identity, "provider_id") or _get(identity, "identity_key")
    rule = _rule(rule_id)
    return SecurityFinding(
        rule_id=rule_id,
        rule_version=getattr(rule, "version", RULE_VERSION),
        provider=prov,
        account_id=str(account_id),
        fingerprint=fingerprint(provider=prov, account_id=str(account_id),
                                rule_id=rule_id, resource_key=key,
                                discriminator=discriminator),
        resource_key=key,
        resource_name=_get(identity, "name") or _get(identity, "principal_name"),
        resource_type=_get(identity, "identity_type"),
        title=title,
        description=description,
        rationale=getattr(rule, "rationale", "") or "",
        remediation=getattr(rule, "remediation", "") or "",
        severity=severity,
        category=category,
        verdict=verdict,
        confidence=confidence,
        evidence=evidence,
    )


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def analyse(
    *,
    provider: str,
    account_id: str,
    identities: Sequence[Any],
    capabilities_by_identity: Optional[Dict[str, Sequence[str]]] = None,
    credentials_by_identity: Optional[Dict[str, Sequence[Dict[str, Any]]]] = None,
    usage_by_identity: Optional[Dict[str, Dict[str, Any]]] = None,
    blast_by_identity: Optional[Dict[str, Dict[str, Any]]] = None,
    trust_edges: Optional[Sequence[Any]] = None,
    dormancy_by_identity: Optional[Dict[str, Dict[str, Any]]] = None,
    now: Optional[datetime] = None,
) -> List[SecurityFinding]:
    """Every CIEM finding for one account.

    Each input is keyed by the identity's `identity_key`. Missing input for an
    identity means that analysis did not run for it, and produces a coverage
    finding rather than silence.
    """
    moment = now or datetime.now(timezone.utc)
    caps = capabilities_by_identity or {}
    creds = credentials_by_identity or {}
    usage = usage_by_identity or {}
    blast = blast_by_identity or {}
    dormancy = dormancy_by_identity or {}

    out: List[SecurityFinding] = []
    unevaluated: List[str] = []
    mfa_unknown: List[str] = []

    for identity in identities:
        key = _get(identity, "identity_key")
        name = _get(identity, "name") or _get(identity, "principal_name") or key
        privilege = _get(identity, "privilege_level") or PRIV_UNKNOWN
        actor_class = _get(identity, "actor_class")
        mfa = _get(identity, "mfa_state")
        identity_type = _get(identity, "identity_type") or ""
        held = list(caps.get(key) or [])

        # ── Coverage: policies not evaluated ─────────────────────────────────
        if privilege == PRIV_UNKNOWN:
            unevaluated.append(name)
            continue

        # ── MFA ──────────────────────────────────────────────────────────────
        if mfa == MFA_UNKNOWN and actor_class == ACTOR_HUMAN:
            mfa_unknown.append(name)
        if mfa == MFA_DISABLED and privilege in (PRIV_ADMIN, PRIV_PRIVILEGED):
            out.append(_finding(
                rule_id=PRIVILEGED_IDENTITY_WITHOUT_MFA, provider=provider,
                account_id=account_id, identity=identity,
                severity=CRITICAL if privilege == PRIV_ADMIN else HIGH,
                title=f"{name} holds {privilege.lower()} permissions without MFA",
                description=(
                    f"This identity is classified {privilege} from its evaluated "
                    "permissions, and the provider reports no registered MFA device."
                ),
                evidence={
                    "privilege_level": privilege,
                    "mfa_state": mfa,
                    "capabilities": held,
                    "actor_class": actor_class,
                    "mfa_detail": _get(identity, "mfa_detail"),
                },
            ))

        # ── Standing administrative access ───────────────────────────────────
        if _get(identity, "standing_admin"):
            out.append(_finding(
                rule_id=STANDING_ADMIN_ACCESS, provider=provider,
                account_id=account_id, identity=identity, severity=HIGH,
                title=f"{name} holds standing administrative access",
                description=(
                    "Administrative permissions are held continuously rather than "
                    "requested when needed."
                ),
                evidence={
                    "privilege_level": privilege,
                    "scope": _get(identity, "scope"),
                    "capabilities": held,
                    "reason": _get(identity, "standing_admin_reason"),
                    "last_used_at": _iso(_get(identity, "last_used_at")),
                },
            ))

        # ── Overly broad role ────────────────────────────────────────────────
        if privilege == PRIV_ADMIN and actor_class == ACTOR_WORKLOAD:
            out.append(_finding(
                rule_id=OVERLY_BROAD_ROLE, provider=provider, account_id=account_id,
                identity=identity, severity=HIGH,
                title=f"Workload identity {name} holds administrative permissions",
                description=(
                    "A workload identity holds permissions classified administrative. "
                    "Workloads usually need a narrow, fixed set of actions."
                ),
                evidence={
                    "privilege_level": privilege, "capabilities": held,
                    "actor_class": actor_class,
                    "high_impact_why": {c: HIGH_IMPACT_WHY[c] for c in held
                                        if c in HIGH_IMPACT_WHY},
                },
            ))

        # ── Dormancy ─────────────────────────────────────────────────────────
        dorm = dormancy.get(key) or {}
        state = dorm.get("state")
        if state in (DORMANCY_DORMANT, DORMANCY_NEVER_USED):
            if privilege in (PRIV_ADMIN, PRIV_PRIVILEGED):
                out.append(_finding(
                    rule_id=DORMANT_PRIVILEGED_IDENTITY, provider=provider,
                    account_id=account_id, identity=identity,
                    severity=HIGH, confidence=CONF_HIGH,
                    title=f"{name} is {state.lower().replace('_', ' ')} but privileged",
                    description=(
                        "A privileged identity that is not being used is a standing "
                        "credential nobody is watching."
                    ),
                    evidence={
                        "dormancy": dorm, "privilege_level": privilege,
                        "capabilities": held,
                        "threshold_days": dorm.get("threshold_days"),
                        "last_used_at": dorm.get("last_used_at"),
                        "evidence_source": dorm.get("source"),
                    },
                ))
            elif actor_class == ACTOR_WORKLOAD:
                out.append(_finding(
                    rule_id=UNUSED_SERVICE_PRINCIPAL, provider=provider,
                    account_id=account_id, identity=identity, severity=LOW,
                    confidence=CONF_MEDIUM,
                    title=f"Workload identity {name} shows no recent activity",
                    description="No use of this workload identity was observed.",
                    evidence={"dormancy": dorm, "capabilities": held},
                ))
            else:
                out.append(_finding(
                    rule_id=DORMANT_IDENTITY, provider=provider,
                    account_id=account_id, identity=identity, severity=MEDIUM,
                    confidence=CONF_MEDIUM,
                    title=f"{name} has not been used in "
                          f"{dorm.get('days_since_use', 'the threshold period')} days",
                    description="An unused identity is an unnecessary way in.",
                    evidence={"dormancy": dorm},
                ))

        # ── Break-glass shape ────────────────────────────────────────────────
        if _get(identity, "potential_break_glass"):
            out.append(_finding(
                rule_id=UNMONITORED_BREAK_GLASS, provider=provider,
                account_id=account_id, identity=identity, severity=MEDIUM,
                confidence=CONF_LOW,
                title=f"{name} looks like an emergency-access account",
                description=(
                    "Its name, privileges and usage pattern match an emergency account. "
                    "This platform cannot confirm it is designated as one."
                ),
                evidence={
                    "signals": _get(identity, "break_glass_signals"),
                    "privilege_level": privilege, "mfa_state": mfa,
                    "dormancy": dorm,
                    "note": "Reported as POTENTIAL. Confirm against your own register "
                            "of emergency accounts before acting.",
                },
            ))

        # ── Root account ─────────────────────────────────────────────────────
        if identity_type == "AWS_ROOT" and state not in (DORMANCY_NEVER_USED,):
            last = _get(identity, "last_used_at")
            if last:
                out.append(_finding(
                    rule_id=ROOT_ACCOUNT_IN_USE, provider=provider,
                    account_id=account_id, identity=identity, severity=HIGH,
                    title="The AWS root account has been used",
                    description=(
                        "Root has unrestricted, non-removable permissions and cannot be "
                        "constrained by policy."
                    ),
                    evidence={"last_used_at": _iso(last), "mfa_state": mfa,
                              "dormancy": dorm},
                ))

        # ── Credentials ──────────────────────────────────────────────────────
        for cred in creds.get(key) or []:
            rec = cred.get("recommendation")
            signals = cred.get("signals") or []
            if "NEVER_USED" in signals and rec in ("DELETE", "DISABLE"):
                out.append(_finding(
                    rule_id=NEVER_USED_CREDENTIAL, provider=provider,
                    account_id=account_id, identity=identity, severity=MEDIUM,
                    discriminator=cred.get("credential_ref"),
                    title=f"{name} holds a credential that has never been used",
                    description="The provider reports this credential has never "
                                "authenticated a request.",
                    evidence={"credential": cred, "privilege_level": privilege},
                ))
            elif any(s.startswith("UNUSED_") for s in signals) or \
                    "OLD_CREDENTIAL" in signals:
                severity = HIGH if privilege in (PRIV_ADMIN, PRIV_PRIVILEGED) else MEDIUM
                out.append(_finding(
                    rule_id=STALE_ACCESS_KEY, provider=provider,
                    account_id=account_id, identity=identity, severity=severity,
                    discriminator=cred.get("credential_ref"),
                    title=f"{name} holds a stale credential",
                    description=cred.get("recommendation_reason")
                    or "This credential is old or has not been used recently.",
                    evidence={"credential": cred, "privilege_level": privilege},
                ))
            if "MULTIPLE_ACTIVE_KEYS" in signals:
                out.append(_finding(
                    rule_id=MULTIPLE_ACTIVE_KEYS, provider=provider,
                    account_id=account_id, identity=identity, severity=LOW,
                    discriminator=cred.get("credential_ref"),
                    title=f"{name} has more than one active credential",
                    description="More than one active credential of the same kind "
                                "usually means a rotation was started and not finished.",
                    evidence={"credential": cred},
                ))

        # ── Unused permissions ───────────────────────────────────────────────
        summary = usage.get(key) or {}
        candidates = summary.get("removal_candidates") or []
        if candidates:
            out.append(_finding(
                rule_id=UNUSED_PERMISSION, provider=provider, account_id=account_id,
                identity=identity,
                severity=MEDIUM if privilege in (PRIV_ADMIN, PRIV_PRIVILEGED) else LOW,
                confidence=CONF_MEDIUM,
                title=f"{name} holds {len(candidates)} permission grant(s) with no "
                      "observed use",
                description=(
                    "No action under these grants was observed in the window below. "
                    "That is evidence they are unnecessary; it is not proof."
                ),
                evidence={
                    "window": summary.get("window"),
                    "granted_pattern_count": summary.get("granted_pattern_count"),
                    "observed_action_count": summary.get("observed_action_count"),
                    "removal_candidates": candidates,
                    "retained_insufficient_evidence": (
                        summary.get("unexercised_pattern_count", 0)
                        - summary.get("high_confidence_unexercised_count", 0)
                    ),
                    "note": "Only high-confidence unexercised grants are listed here. "
                            "Grants with insufficient evidence are deliberately "
                            "excluded.",
                },
            ))

        # ── Blast radius ─────────────────────────────────────────────────────
        reach = blast.get(key) or {}
        if reach.get("score_band") in ("CRITICAL", "HIGH") and reach.get("score") is not None:
            out.append(_finding(
                rule_id=HIGH_BLAST_RADIUS_IDENTITY, provider=provider,
                account_id=account_id, identity=identity,
                severity=CRITICAL if reach.get("score_band") == "CRITICAL" else HIGH,
                confidence=CONF_MEDIUM,
                title=f"{name} has a large blast radius",
                description=(
                    f"If this identity were compromised it could reach "
                    f"{reach.get('direct_resources', 0)} resources directly and "
                    f"{reach.get('indirect_resources', 0)} further through the topology."
                ),
                evidence={
                    "blast_radius": {k: reach.get(k) for k in (
                        "direct_resources", "indirect_resources", "sensitive_resources",
                        "accounts_reachable", "regions_reachable", "score", "score_band",
                        "capabilities", "inventory_complete", "coverage_note")},
                    "privilege_level": privilege,
                },
            ))

        # ── Excessive scope ──────────────────────────────────────────────────
        scope_level = _get(identity, "broadest_scope_level")
        if privilege == PRIV_PRIVILEGED and scope_level in ("root", "subscription"):
            out.append(_finding(
                rule_id=EXCESSIVE_PERMISSION_SCOPE, provider=provider,
                account_id=account_id, identity=identity, severity=MEDIUM,
                title=f"{name} holds high-impact permissions at the broadest scope",
                description=(
                    "High-impact capabilities are granted across the whole account "
                    "rather than against the resources this identity works with."
                ),
                evidence={"capabilities": held, "scope_level": scope_level,
                          "scope": _get(identity, "scope")},
            ))

    # ── Trust ────────────────────────────────────────────────────────────────
    for edge in trust_edges or []:
        edge_dict = edge if isinstance(edge, dict) else edge.to_dict()
        external = edge_dict.get("external")
        factors = [f.get("factor") for f in (edge_dict.get("risk_factors") or [])]
        target = edge_dict.get("target_name") or edge_dict.get("target_key")

        if external == EXTERNAL_ANONYMOUS:
            out.append(_finding(
                rule_id=ANONYMOUS_TRUST, provider=provider, account_id=account_id,
                identity={"provider_id": edge_dict.get("target_key"),
                          "name": target, "identity_type": "TRUST"},
                severity=CRITICAL,
                discriminator=edge_dict.get("source_principal"),
                title=f"{target} can be assumed by any principal",
                description="The trust policy names a wildcard principal.",
                evidence={"trust": edge_dict},
            ))
            continue

        if external == EXTERNAL_YES:
            if edge_dict.get("target_privilege") in (PRIV_ADMIN, PRIV_PRIVILEGED):
                out.append(_finding(
                    rule_id=EXTERNAL_PRIVILEGED_PRINCIPAL, provider=provider,
                    account_id=account_id,
                    identity={"provider_id": edge_dict.get("target_key"),
                              "name": target, "identity_type": "TRUST"},
                    severity=HIGH, discriminator=edge_dict.get("source_principal"),
                    title=f"An external principal can assume privileged access to {target}",
                    description=(
                        "A principal outside this account or tenant can take on an "
                        "identity with privileged permissions."
                    ),
                    evidence={"trust": edge_dict},
                ))
            if "NO_EXTERNAL_ID" in factors:
                out.append(_finding(
                    rule_id=CROSS_ACCOUNT_TRUST_NO_EXTERNAL_ID, provider=provider,
                    account_id=account_id,
                    identity={"provider_id": edge_dict.get("target_key"),
                              "name": target, "identity_type": "TRUST"},
                    severity=MEDIUM, discriminator=edge_dict.get("source_principal"),
                    title=f"{target} trusts an external account with no ExternalId",
                    description=(
                        "A cross-account trust without an ExternalId condition is the "
                        "confused-deputy shape."
                    ),
                    evidence={"trust": edge_dict},
                ))

    # ── Coverage gaps, grouped ───────────────────────────────────────────────
    if unevaluated:
        out.append(SecurityFinding(
            rule_id=POLICIES_NOT_EVALUATED, rule_version=RULE_VERSION,
            provider=normalize_provider(provider) or provider,
            account_id=str(account_id),
            fingerprint=fingerprint(provider=provider, account_id=str(account_id),
                                    rule_id=POLICIES_NOT_EVALUATED),
            title=f"{len(unevaluated)} identities could not be assessed",
            description=(
                "Their policies or role assignments were not collected, so their "
                "permissions are unknown. They are NOT counted as unprivileged."
            ),
            rationale=getattr(_rule(POLICIES_NOT_EVALUATED), "rationale", "") or "",
            remediation=getattr(_rule(POLICIES_NOT_EVALUATED), "remediation", "") or "",
            severity=MEDIUM, category=CAT_IAM, verdict=UNKNOWN, confidence=CONF_HIGH,
            evidence={"identities": unevaluated[:50], "count": len(unevaluated),
                      "note": "An identity whose permissions could not be read is "
                              "excluded from every privilege count on this page, "
                              "rather than counted as safe."},
            affected_count=len(unevaluated),
        ))

    if mfa_unknown:
        out.append(SecurityFinding(
            rule_id=MFA_STATE_UNKNOWN, rule_version=RULE_VERSION,
            provider=normalize_provider(provider) or provider,
            account_id=str(account_id),
            fingerprint=fingerprint(provider=provider, account_id=str(account_id),
                                    rule_id=MFA_STATE_UNKNOWN),
            title=f"MFA state is unknown for {len(mfa_unknown)} human identities",
            description=(
                "The provider did not report MFA registration for these identities. "
                "This is a data gap, not an MFA failure."
            ),
            rationale=getattr(_rule(MFA_STATE_UNKNOWN), "rationale", "") or "",
            remediation=getattr(_rule(MFA_STATE_UNKNOWN), "remediation", "") or "",
            severity=LOW, category=CAT_IAM, verdict=UNKNOWN, confidence=CONF_HIGH,
            evidence={"identities": mfa_unknown[:50], "count": len(mfa_unknown)},
            affected_count=len(mfa_unknown),
        ))

    return out


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    return value if isinstance(value, str) else None
