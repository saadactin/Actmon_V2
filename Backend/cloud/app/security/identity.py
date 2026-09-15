"""Identity risk: who can reach the most, on the least justification for it.

Where the data lives differs by provider, which is why this module exists at
all rather than being three more rules in the registry:

* **AWS** — `IAMRole.config.broad_access`, computed at discovery time from the
  role's attached and inline policy documents. It is a resource field, so it is
  evaluated by ordinary registry rules (`AWS_IAM_ROLE_*`) and this module does
  not touch it.
* **OCI** — `IAMPolicy.config.statements`, the tenancy's policy language. Also a
  resource field, also handled by registry rules (`OCI_IAM_POLICY_*`).
* **Azure** — role assignments, which are not resources and live in
  `cloud_identity_grants`. That is what this module analyses.

The reason Azure needed its own path is worth stating: the identity review
previously returned `not_scanned: true` for Azure with the reason "role
assignments aren't collected by the discovery scanner". That was accurate but
self-fulfilling — nothing had tried. They collect fine on two of the three live
subscriptions.

**Escalation is decided from the role's actions, not from its name.** The
tempting shortcut is a set of well-known role GUIDs. It works until someone
creates a custom role with `Microsoft.Authorization/roleAssignments/write` in
it, at which point the most dangerous assignment in the subscription is the one
the analyser does not recognise. `_role_powers` reads the actual action list.
"""
from __future__ import annotations

import fnmatch
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence

from app.models.identity_grant import (
    COLLECT_NEVER_RUN, COLLECT_NOT_SUPPORTED, COLLECT_OK, SCOPE_GROUP, SCOPE_RANK,
    SCOPE_RESOURCE, SCOPE_ROOT, SCOPE_SUBSCRIPTION,
)
from app.security.model import (
    AWS, AZURE, CONF_HIGH, CONF_MEDIUM, CRITICAL, HIGH, MEDIUM, OCI,
)

# ── Deciding what a role can do ──────────────────────────────────────────────
#
# The direction of the glob match is the whole correctness question here, and
# getting it backwards produced a spectacular false positive on live data: the
# built-in **Reader** role, whose only action is `*/read`, was reported as
# "holds full control over the entire subscription" with a privilege-escalation
# path, on 23 assignments.
#
# The cause: `fnmatch(action, "*")` asks "does the string `*/read` match the
# pattern `*`", which is trivially true of every string. The question that
# actually matters is the other way round — "does this role's action pattern
# COVER this concrete privileged operation?" — so the ACTION is the pattern and
# a concrete operation is the string:
#
#     fnmatch("Microsoft.Authorization/roleAssignments/write", action)
#
# Under that test `*/read` covers nothing privileged, `*` covers everything, and
# a custom role with `Microsoft.Authorization/*` is caught without needing to
# be recognised by name.
#
# Concrete operations probed for escalation. A role covering any of them can
# change who is allowed to do what.
_ESCALATION_OPERATIONS = (
    "Microsoft.Authorization/roleAssignments/write",
    "Microsoft.Authorization/roleDefinitions/write",
    "Microsoft.Authorization/elevateAccess/action",
)

# Concrete operations probed for unconstrained write. Deliberately drawn from
# different resource providers: a role scoped to one provider's writes is broad
# within that provider but is not subscription-wide write.
_BROAD_WRITE_OPERATIONS = (
    "Microsoft.Compute/virtualMachines/write",
    "Microsoft.Network/networkSecurityGroups/write",
    "Microsoft.Storage/storageAccounts/write",
    "Microsoft.Resources/subscriptions/resourceGroups/delete",
)

# Full control is the literal wildcard, matched exactly. Nothing else counts:
# a role that covers every write operation we probe is still not Owner, and
# conflating them would make Contributor indistinguishable from Owner.
_FULL_CONTROL_ACTIONS = frozenset({"*"})

# Principal types whose lifecycle this tenant does not control.
_EXTERNAL_PRINCIPAL_TYPES = frozenset({"ForeignGroup", "Guest", "User#EXT#"})

# Scopes broad enough that a privileged role there is a finding in itself.
_BROAD_SCOPES = frozenset({SCOPE_ROOT, SCOPE_SUBSCRIPTION})

# Severity of an escalation path, by how far it reaches.
#
# Scope is not a detail here, it is most of the risk. The live TOR subscription
# has 69 principals holding a role that can write role assignments — and 64 of
# those are `Owner` on a single App Service or database. Owner on one resource
# lets the holder grant others access to *that resource*: worth knowing, and
# nothing like the four assignments that can do it across the whole
# subscription. Reporting all 69 as CRITICAL, as the first version did, buries
# the four that matter under 64 that do not.
_ESCALATION_SEVERITY_BY_SCOPE = {
    SCOPE_ROOT: CRITICAL,
    SCOPE_SUBSCRIPTION: CRITICAL,
    SCOPE_GROUP: HIGH,
    SCOPE_RESOURCE: MEDIUM,
}

_SCOPE_REACH = {
    SCOPE_ROOT: "every subscription under the management group",
    SCOPE_SUBSCRIPTION: "the entire subscription",
    SCOPE_GROUP: "this resource group",
    SCOPE_RESOURCE: "this single resource",
}


class RolePowers(NamedTuple):
    """What a role can actually do, derived from its action list."""

    full_control: bool
    can_escalate: bool
    broad_write: bool
    action_count: int
    matched_actions: List[str]


def _covers(operation: str, action_patterns: Iterable[str]) -> List[str]:
    """Which of the role's action patterns permit `operation`.

    ARM action strings are globs (`*/read`, `Microsoft.Compute/*`), so the
    action is the pattern and the concrete operation is the subject. Returns the
    matching patterns rather than a boolean so the finding can quote the
    specific grant as evidence.
    """
    op = (operation or "").strip()
    return [p for p in action_patterns
            if p == "*" or fnmatch.fnmatch(op, str(p).strip())]


def _role_powers(permissions: Optional[Dict[str, Any]]) -> Optional[RolePowers]:
    """None when the role definition was never fetched — which is not the same
    as a role with no permissions, and must not be treated as harmless."""
    if not isinstance(permissions, dict):
        return None
    actions = [str(a) for a in (permissions.get("actions") or [])]
    not_actions = [str(a) for a in (permissions.get("not_actions") or [])]
    if not actions:
        return RolePowers(False, False, False, 0, [])

    def permitted(operation: str) -> List[str]:
        """Granted by an Action and not taken back by a NotAction.

        Reading NotActions is what separates Contributor from Owner: Contributor
        grants `*` and then excludes `Microsoft.Authorization/*/write`, so it can
        do everything except grant access. Ignoring NotActions would report
        every Contributor assignment as a privilege-escalation path — which is
        both wrong and the kind of wrong that gets a security tool ignored.
        """
        granted = _covers(operation, actions)
        if not granted:
            return []
        if _covers(operation, not_actions):
            return []
        return granted

    escalating = sorted({p for op in _ESCALATION_OPERATIONS for p in permitted(op)})
    writing = sorted({p for op in _BROAD_WRITE_OPERATIONS for p in permitted(op)})
    full = sorted(a for a in actions if a.strip() in _FULL_CONTROL_ACTIONS)

    return RolePowers(
        # Full control requires the wildcard AND that it was not clawed back.
        # Contributor grants `*` and then excludes Microsoft.Authorization
        # writes, so it can destroy everything but cannot grant access — that
        # is broad write, not full control, and the distinction is the entire
        # difference between the Owner and Contributor findings.
        full_control=bool(full) and bool(escalating),
        can_escalate=bool(escalating),
        # Full control implies write, but only if it was not clawed back — a
        # role with `*` and a NotAction on everything is not a write role.
        broad_write=bool(writing),
        action_count=len(actions),
        matched_actions=(escalating or full or writing)[:12],
    )


class IdentityRisk(NamedTuple):
    """One risky grant, ready for the engine to turn into a canonical finding."""

    rule_id: str
    severity: str
    principal_id: Optional[str]
    principal_type: Optional[str]
    principal_name: Optional[str]
    role_name: Optional[str]
    scope: Optional[str]
    scope_level: Optional[str]
    detail: str
    evidence: Dict[str, Any]
    grant_key: str
    confidence: str = CONF_HIGH


def analyse_azure_grants(grants: Sequence[Any]) -> List[IdentityRisk]:
    """Risky Azure role assignments, worst first.

    One risk per (grant, problem): a subscription-scoped Owner assignment to a
    foreign group is both a full-control finding AND an external-principal
    finding, and collapsing them would hide half of why it matters.
    """
    risks: List[IdentityRisk] = []

    for g in grants:
        powers = _role_powers(g.permissions)
        scope_level = g.scope_level or SCOPE_RESOURCE
        broad_scope = scope_level in _BROAD_SCOPES
        base = {
            "principal_id": g.principal_id,
            "principal_type": g.principal_type,
            "role_name": g.role_name,
            "role_key": g.role_key,
            "role_type": g.role_type,
            "scope": g.scope,
            "scope_level": scope_level,
        }

        if powers is None:
            # The definition was not fetched, so we cannot say what the role can
            # do. Only report it if the scope is broad enough to matter, and say
            # plainly that the role's powers are unknown.
            if broad_scope:
                risks.append(IdentityRisk(
                    rule_id="AZURE_RBAC_BROAD_WRITE",
                    severity=MEDIUM,
                    principal_id=g.principal_id, principal_type=g.principal_type,
                    principal_name=g.principal_name, role_name=g.role_name,
                    scope=g.scope, scope_level=scope_level,
                    detail=(f"Role '{g.role_name or g.role_key}' is assigned at "
                            f"{scope_level} scope, but its permission list could not be "
                            f"retrieved, so its actual power is unknown."),
                    evidence={**base, "role_definition_retrieved": False},
                    grant_key=g.grant_key, confidence=CONF_MEDIUM,
                ))
            continue

        if powers.can_escalate:
            reach = _SCOPE_REACH.get(scope_level, scope_level)
            risks.append(IdentityRisk(
                rule_id="AZURE_RBAC_ESCALATION",
                severity=_ESCALATION_SEVERITY_BY_SCOPE.get(scope_level, MEDIUM),
                principal_id=g.principal_id, principal_type=g.principal_type,
                principal_name=g.principal_name, role_name=g.role_name,
                scope=g.scope, scope_level=scope_level,
                detail=(f"Role '{g.role_name or g.role_key}' includes role-assignment "
                        f"write, so this principal can grant itself — or anyone else — "
                        f"further access to {reach}."),
                evidence={**base, "escalating_actions": powers.matched_actions,
                          "total_actions": powers.action_count,
                          "reach": reach},
                grant_key=g.grant_key,
            ))

        if powers.full_control and broad_scope:
            risks.append(IdentityRisk(
                rule_id="AZURE_RBAC_SUBSCRIPTION_OWNER",
                severity=CRITICAL,
                principal_id=g.principal_id, principal_type=g.principal_type,
                principal_name=g.principal_name, role_name=g.role_name,
                scope=g.scope, scope_level=scope_level,
                detail=(f"Role '{g.role_name or g.role_key}' grants the wildcard action "
                        f"'*' at {scope_level} scope."),
                evidence={**base, "actions": powers.matched_actions},
                grant_key=g.grant_key,
            ))
        elif powers.broad_write and broad_scope:
            risks.append(IdentityRisk(
                rule_id="AZURE_RBAC_BROAD_WRITE",
                severity=HIGH,
                principal_id=g.principal_id, principal_type=g.principal_type,
                principal_name=g.principal_name, role_name=g.role_name,
                scope=g.scope, scope_level=scope_level,
                detail=(f"Role '{g.role_name or g.role_key}' grants unconstrained write "
                        f"at {scope_level} scope."),
                evidence={**base, "actions": powers.matched_actions,
                          "total_actions": powers.action_count},
                grant_key=g.grant_key,
            ))

        if (g.principal_type in _EXTERNAL_PRINCIPAL_TYPES
                and (powers.full_control or powers.broad_write or powers.can_escalate)):
            risks.append(IdentityRisk(
                rule_id="AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED",
                severity=(CRITICAL if (powers.full_control and broad_scope)
                          else HIGH if broad_scope else MEDIUM),
                principal_id=g.principal_id, principal_type=g.principal_type,
                principal_name=g.principal_name, role_name=g.role_name,
                scope=g.scope, scope_level=scope_level,
                detail=(f"An external principal ({g.principal_type}) holds "
                        f"'{g.role_name or g.role_key}' at {scope_level} scope."),
                evidence={**base, "external_principal": True},
                grant_key=g.grant_key,
            ))

    from app.security.model import severity_rank
    risks.sort(key=lambda r: (severity_rank(r.severity), SCOPE_RANK.get(r.scope_level or "", 9)))
    return risks


# ── The cross-provider identity review the UI renders ───────────────────────


def review(
    *,
    provider: str,
    findings: Sequence[Any],
    grants: Sequence[Any] = (),
    collection_status: Optional[str] = None,
    collection_error: Optional[str] = None,
    missing_permission: Optional[str] = None,
    identities_reviewed: int = 0,
) -> Dict[str, Any]:
    """Summarise identity risk for one account, from findings already produced.

    Reads canonical findings rather than re-deriving anything, so the Identity
    & Access tab and the Findings tab can never disagree about the same role.

    `collection_status` matters as much as the findings: for Azure it decides
    whether an empty result means "no over-privileged identities" or "we were
    refused permission to look", and those must never render the same way.
    """
    from app.security.model import ACTIVE_FINDING_STATUSES, CAT_IAM

    iam = [
        f for f in findings
        if getattr(f, "category", None) == CAT_IAM
        and getattr(f, "status", None) in ACTIVE_FINDING_STATUSES
    ]
    escalation_rules = {"AWS_IAM_ROLE_ESCALATION", "OCI_IAM_POLICY_ESCALATION",
                        "AZURE_RBAC_ESCALATION"}

    trustworthy = True
    reason = None
    if provider == AZURE:
        trustworthy = collection_status == COLLECT_OK
        if not trustworthy:
            if collection_status in (None, COLLECT_NEVER_RUN):
                reason = ("Role assignments have not been collected for this subscription "
                          "yet. Run a discovery scan to collect them.")
            elif collection_status == COLLECT_NOT_SUPPORTED:
                reason = "Role-assignment collection is not implemented for this provider."
            else:
                reason = (
                    "Role assignments could not be read for this subscription, so no "
                    "identity review is possible. This is a permission gap, not a clean "
                    "result."
                )

    return {
        "provider": provider,
        # Kept for the existing panel, which branches on it — but it is now
        # per-subscription rather than a blanket statement about Azure.
        "not_scanned": not trustworthy,
        "trustworthy": trustworthy,
        "reason": reason,
        "collection_status": collection_status,
        "collection_error": collection_error,
        "missing_permission": missing_permission,
        "identities_reviewed": identities_reviewed,
        "grants_collected": len(grants),
        "total_flagged": len(iam),
        "escalation_risk_count": sum(
            1 for f in iam if getattr(f, "rule_id", None) in escalation_rules
        ),
        "by_severity": {
            sev: sum(1 for f in iam if getattr(f, "severity", None) == sev)
            for sev in (CRITICAL, HIGH, MEDIUM)
        },
        "findings": [f.to_dict() if hasattr(f, "to_dict") else f for f in iam],
    }
