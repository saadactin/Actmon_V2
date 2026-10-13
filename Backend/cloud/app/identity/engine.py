"""The provider-agnostic face of the effective-permissions engine.

One `evaluate()` that dispatches to the right provider evaluator, and the
derived judgements every other module reads: what privilege level a principal
holds, which high-impact capabilities it has, and whether its permissions
amount to standing administrative access.

**Privilege is derived from evaluated capability, never from a role name.**
`security/identity.py` already records why: a custom role carrying
`Microsoft.Authorization/roleAssignments/write` is the most dangerous
assignment in a subscription and no list of well-known role GUIDs will ever
contain it. The same argument applies to `AdministratorAccess` by name, to
`Allow group X to manage all-resources`, and to every inline policy anyone will
ever write. So `classify_privilege` reads the action patterns.

**PRIV_UNKNOWN is not a low privilege level.** A principal whose policies could
not be read is UNKNOWN, and every count, filter and dashboard treats that as a
coverage gap rather than as "this one is fine". The whole §35 discipline fails
at exactly this function if it returns READ_ONLY for an empty input, so it does
not: `worst_privilege([])` is UNKNOWN by construction.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity import aws_eval, azure_eval, oci_eval
from app.identity.capability import (
    capabilities_covered, covers, high_impact_covered, is_full_control,
    probe_operations,
)
from app.identity.model import (
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_UNKNOWN, ACTOR_WORKLOAD, ALLOWED,
    ALLOWED_UNVERIFIED, AWS, AZURE, CAP_DATABASE_READ, CAP_IAM_ADMINISTRATION,
    CAP_IDENTITY_ADMINISTRATION, CAP_STORAGE_READ, DECISIONS_PERMISSIVE, Decision,
    HIGH_IMPACT_CAPABILITIES, NOT_DETERMINED, OCI, PRIV_ADMIN, PRIV_PRIVILEGED,
    PRIV_READ_ONLY, PRIV_STANDARD, PRIV_UNKNOWN, Unevaluated, normalize_provider,
)

# Capabilities that let an identity observe without changing anything. An
# identity holding ONLY these is read-only, however many of them it holds.
READ_ONLY_CAPABILITIES = frozenset({CAP_STORAGE_READ, CAP_DATABASE_READ})
from app.models.identity_grant import (
    SCOPE_GROUP, SCOPE_RANK, SCOPE_RESOURCE, SCOPE_ROOT, SCOPE_SUBSCRIPTION,
)

# A policy set for any provider. The service layer builds the right one and
# passes it through; this module does not know how they are stored.
PolicySet = Any


def evaluate(
    provider: str,
    policy_set: PolicySet,
    *,
    action: str,
    resource: Optional[str] = None,
    **kwargs: Any,
) -> Decision:
    """Dispatch to the provider's evaluator.

    An unrecognised provider returns NOT_DETERMINED rather than falling back to
    one of the three evaluators — running AWS semantics over an OCI policy set
    would produce an answer, and the answer would be fiction.
    """
    prov = normalize_provider(provider)
    if prov == AWS:
        return aws_eval.evaluate(policy_set, action=action, resource=resource,
                                 principal_arn=kwargs.get("principal_arn"))
    if prov == AZURE:
        return azure_eval.evaluate(
            policy_set, action=action, resource=resource,
            plane=kwargs.get("plane", azure_eval.PLANE_CONTROL),
            principal_id=kwargs.get("principal_id"),
        )
    if prov == OCI:
        return oci_eval.evaluate(policy_set, action=action, resource=resource,
                                 compartment_id=kwargs.get("compartment_id"))
    return Decision(
        decision=NOT_DETERMINED, action=action, resource=resource,
        unevaluated=[Unevaluated(
            stage="provider", reason="NOT_SUPPORTED",
            detail=f"No effective-permission evaluator for provider {provider!r}.",
        )],
    )


def granted_patterns(provider: str, policy_set: PolicySet) -> List[str]:
    """Every action pattern the principal holds, for capability classification."""
    prov = normalize_provider(provider)
    if prov == AWS:
        return policy_set.granted_action_patterns()
    if prov == AZURE:
        return (policy_set.granted_action_patterns(azure_eval.PLANE_CONTROL)
                + policy_set.granted_action_patterns(azure_eval.PLANE_DATA))
    if prov == OCI:
        return policy_set.granted_action_patterns()
    return []


def capabilities_with_evidence(
    provider: str, policy_set: PolicySet,
) -> Dict[str, List[str]]:
    """`{capability: [grant patterns that conferred it]}`.

    The evidence list is what makes a capability claim checkable: "this role can
    modify IAM" is an assertion, "because it grants `iam:*`" is a fact an
    operator can verify against the provider in one click.
    """
    prov = normalize_provider(provider)
    if prov == AWS:
        return aws_eval.capabilities_from_policy_set(policy_set)
    if prov == AZURE:
        return azure_eval.capabilities_from_assignments(policy_set)
    if prov == OCI:
        return oci_eval.capabilities_from_policy_set(policy_set)
    return {}


def classify_privilege(
    provider: str,
    granted: Sequence[str],
    *,
    evaluable: bool = True,
) -> str:
    """The privilege level implied by a set of granted action patterns.

    `evaluable=False` means the principal's policies could not be read, and the
    answer is UNKNOWN regardless of what the (empty) grant list looks like.
    That distinction is the difference between "this identity has no
    permissions" and "we could not find out", and only one of them is safe to
    show as a green row.
    """
    if not evaluable:
        return PRIV_UNKNOWN
    prov = normalize_provider(provider)
    if not prov:
        return PRIV_UNKNOWN
    patterns = [g for g in (granted or []) if g]
    if not patterns:
        # Genuinely nothing attached, and we know it. That is READ_ONLY only in
        # the sense of "cannot do anything" — STANDARD would overstate it.
        return PRIV_READ_ONLY

    if is_full_control(prov, patterns):
        return PRIV_ADMIN

    held = capabilities_covered(prov, patterns)
    # Being able to change who can do what is administrative even without `*`:
    # it is one step from everything, and the step is self-service.
    if CAP_IAM_ADMINISTRATION in held or CAP_IDENTITY_ADMINISTRATION in held:
        return PRIV_ADMIN
    if held & set(HIGH_IMPACT_CAPABILITIES):
        return PRIV_PRIVILEGED
    # READ_ONLY means "can observe, cannot change", not "matched no probe".
    # Azure's built-in Reader is the case that decides the shape of this test:
    # `*/read` genuinely does confer STORAGE_READ and DATABASE_READ — it can
    # enumerate every storage account and database in the subscription — so a
    # rule based on "covers no probe" would call it STANDARD and lose the one
    # distinction an operator cares about here, which is whether the identity
    # can MUTATE anything. Holding only read capabilities is read-only.
    if held and not (held - READ_ONLY_CAPABILITIES):
        return PRIV_READ_ONLY
    if held:
        return PRIV_STANDARD
    # Patterns exist but cover no probe at all.
    return PRIV_READ_ONLY


def is_standing_admin(
    provider: str,
    granted: Sequence[str],
    *,
    scope_level: Optional[str] = None,
    evaluable: bool = True,
) -> Tuple[bool, Optional[str]]:
    """Whether this is persistent administrative access, and why (§12).

    Returns `(standing, reason)`. "Standing" means the privilege is held
    continuously rather than requested when needed — which this platform infers
    from the grant being attached rather than time-boxed. A JIT session created
    by this platform is excluded by the caller, which knows about its own
    sessions; this function judges the permission shape only.
    """
    if not evaluable:
        return False, None
    level = classify_privilege(provider, granted, evaluable=True)
    if level != PRIV_ADMIN:
        return False, None
    prov = normalize_provider(provider) or provider
    broad = scope_level in (None, SCOPE_ROOT, SCOPE_SUBSCRIPTION)
    if not broad:
        return False, None
    if is_full_control(prov, granted):
        return True, ("Holds unrestricted control over the whole "
                      f"{_scope_word(prov, scope_level)}.")
    return True, ("Can change role or policy assignments across the whole "
                  f"{_scope_word(prov, scope_level)}, which is self-service "
                  "escalation to anything else.")


def _scope_word(provider: str, scope_level: Optional[str]) -> str:
    if scope_level == SCOPE_ROOT:
        return {AWS: "organization", AZURE: "management group",
                OCI: "tenancy"}.get(provider, "root scope")
    return {AWS: "account", AZURE: "subscription", OCI: "tenancy"}.get(
        provider, "account")


def refine_actor_class(
    identity_type: str,
    *,
    default: str,
    trust_principals: Optional[Sequence[Dict[str, Any]]] = None,
    provider_detail: Optional[Dict[str, Any]] = None,
) -> str:
    """Sharpen HUMAN/WORKLOAD using evidence rather than the type alone.

    The case that matters is an AWS IAM role, whose default is WORKLOAD but
    which is assumed by PEOPLE when it is an SSO permission set or has a SAML
    federated trust. Getting this wrong in either direction is costly: call an
    SSO role a workload and its missing MFA is dismissed as not applicable;
    call a Lambda execution role human and every service role becomes an MFA
    finding nobody can fix.
    """
    for entry in trust_principals or []:
        principal = str(entry.get("principal") or "")
        low = principal.lower()
        if low.startswith("federated:") or "saml-provider/" in low \
                or "oidc-provider/" in low:
            return ACTOR_HUMAN
        if low.startswith("service:"):
            return ACTOR_WORKLOAD
    detail = provider_detail or {}
    name = str(detail.get("RoleName") or detail.get("name") or "")
    if name.startswith("AWSReservedSSO_"):
        return ACTOR_HUMAN
    sp_type = str(detail.get("servicePrincipalType") or "")
    if sp_type.lower() == "managedidentity":
        return ACTOR_WORKLOAD
    return default


def scope_level_of(provider: str, scope: Optional[str]) -> Optional[str]:
    """Normalized scope level for a provider scope string."""
    prov = normalize_provider(provider)
    if prov == AZURE:
        return azure_eval.scope_level(scope)
    if prov == OCI:
        if not scope:
            return None
        return SCOPE_SUBSCRIPTION if "tenancy" in scope.lower() else SCOPE_GROUP
    if prov == AWS:
        if not scope or scope == "*":
            return SCOPE_SUBSCRIPTION
        return SCOPE_RESOURCE
    return None


def broadest_scope(levels: Iterable[Optional[str]]) -> Optional[str]:
    known = [lvl for lvl in levels if lvl in SCOPE_RANK]
    if not known:
        return None
    return min(known, key=lambda lvl: SCOPE_RANK[lvl])


def capability_scope(
    provider: str, policy_set: PolicySet, capability: str,
) -> Tuple[Optional[str], Optional[str]]:
    """The broadest scope at which a capability is held, and that scope string.

    Severity depends on it: `manage all-resources in tenancy` and the same verb
    on one compartment are not the same finding, and reporting both as
    "holds IAM administration" would flatten the difference an operator needs.
    """
    prov = normalize_provider(provider)
    probes = probe_operations(prov or "", capability)
    if not probes:
        return None, None

    if prov == AZURE:
        best_level, best_scope = None, None
        for assignment in getattr(policy_set, "assignments", []):
            patterns = list(assignment.actions) + list(assignment.data_actions)
            if not any(covers(prov, p, op) for p in patterns for op in probes):
                continue
            level = azure_eval.scope_level(assignment.scope)
            if best_level is None or SCOPE_RANK.get(level, 9) < SCOPE_RANK.get(best_level, 9):
                best_level, best_scope = level, assignment.scope
        return best_level, best_scope

    if prov == OCI:
        best_level, best_scope = None, None
        for stmt in getattr(policy_set, "applicable", lambda: [])():
            token = f"{stmt.verb}:{stmt.resource_type}"
            if not any(covers(prov, token, op) for op in probes):
                continue
            level = SCOPE_SUBSCRIPTION if stmt.location_kind == "tenancy" else SCOPE_GROUP
            scope = ("tenancy" if stmt.location_kind == "tenancy"
                     else f"compartment {stmt.location_name or '?'}")
            if best_level is None or SCOPE_RANK.get(level, 9) < SCOPE_RANK.get(best_level, 9):
                best_level, best_scope = level, scope
        return best_level, best_scope

    # AWS: scope lives in the statement's Resource, not in an attachment point.
    # A capability granted on `*` is account-wide; anything else is narrower.
    statements = list(getattr(policy_set, "identity", []))
    statements += [s for _, s in getattr(policy_set, "group", [])]
    for stmt in statements:
        if stmt.is_deny:
            continue
        if not any(covers(prov or AWS, p, op) for p in stmt.actions for op in probes):
            continue
        if "*" in stmt.resources or not stmt.resources:
            return SCOPE_SUBSCRIPTION, "*"
    return SCOPE_RESOURCE, None


def summarize(
    provider: str,
    policy_set: PolicySet,
    *,
    evaluable: bool = True,
) -> Dict[str, Any]:
    """Everything the identity row needs from one evaluation pass.

    Called once per principal by the analyser, so the privilege level, the
    capability set and the standing-admin flag are all derived from one walk of
    the policies rather than three.
    """
    patterns = granted_patterns(provider, policy_set) if evaluable else []
    caps = capabilities_with_evidence(provider, policy_set) if evaluable else {}
    privilege = classify_privilege(provider, patterns, evaluable=evaluable)

    scopes: Dict[str, Tuple[Optional[str], Optional[str]]] = {}
    for capability in caps:
        scopes[capability] = capability_scope(provider, policy_set, capability)
    broadest = broadest_scope(level for level, _ in scopes.values())
    standing, reason = is_standing_admin(provider, patterns, scope_level=broadest,
                                         evaluable=evaluable)

    return {
        "evaluable": evaluable,
        "granted_patterns": patterns,
        "privilege_level": privilege,
        "capabilities": caps,
        "capability_scopes": {k: {"level": v[0], "scope": v[1]} for k, v in scopes.items()},
        "high_impact": [c for c in HIGH_IMPACT_CAPABILITIES if c in caps],
        "full_control": is_full_control(provider, patterns) if evaluable else False,
        "standing_admin": standing,
        "standing_admin_reason": reason,
        "broadest_scope_level": broadest,
    }
