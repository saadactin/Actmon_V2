"""Azure RBAC effective-permission evaluation.

Azure's model is a union, not a chain: a principal may perform an operation if
ANY role assignment whose scope covers the target grants it and does not
exclude it, and no deny assignment forbids it.

    effective = ⋃ (role.Actions − role.NotActions)  over assignments in scope
                − ⋃ deny assignments

Four properties this module gets right because each has a failure mode that
produces a confidently wrong answer:

**`NotActions` subtracts within one role definition, not globally.** Owner has
`Actions: ["*"]` and no NotActions; a custom role might have `Actions: ["*"]`,
`NotActions: ["Microsoft.Authorization/*/write"]`. Subtracting one role's
NotActions from another role's Actions would report a principal holding both
Owner and that custom role as unable to write role assignments, which is the
opposite of the truth. Each assignment is therefore evaluated independently and
the results are unioned.

**Actions and DataActions are different planes and never mix.** A role with
`Actions: ["*"]` and no DataActions is Owner of the storage account — it can
read its keys, delete it, change its firewall — but it cannot read a blob
through RBAC. Conflating them makes every Owner look like a data breach and
makes a Storage Blob Data Reader look like an administrator. The caller states
which plane it is asking about.

**Scope inheritance is by ARM path segment, not string prefix.** `/subscriptions/
S/resourceGroups/prod` must not be treated as covering `/subscriptions/S/
resourceGroups/production-east`, which a naive `startswith` does. Management
group scopes are a special case handled below.

**Deny assignments are usually invisible to us.** Reading them needs
`Microsoft.Authorization/denyAssignments/read`, which the subscription Reader
role does include — but it is frequently refused in practice, and when it is,
every ALLOW here becomes ALLOWED_UNVERIFIED with the stage named. Deny
assignments come from Blueprints and managed applications and are precisely the
mechanism an estate uses to lock down privileged operations, so assuming their
absence would be the most dangerous shortcut available.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity.capability import classify_action
from app.identity.model import (
    ALLOWED, ALLOWED_UNVERIFIED, AZURE, DENIED, Decision, DecisionStep, IMPLICIT_DENY,
    NOT_DETERMINED, STAGE_DENY_ASSIGNMENT, STAGE_RBAC_ASSIGNMENT,
    UNEVAL_NOT_COLLECTED, UNEVAL_PERMISSION_DENIED, Unevaluated,
)

PLANE_CONTROL = "control"
PLANE_DATA = "data"


@dataclass
class RoleAssignment:
    """One assignment of one role definition at one scope."""

    role_name: str
    scope: str
    actions: List[str] = field(default_factory=list)
    not_actions: List[str] = field(default_factory=list)
    data_actions: List[str] = field(default_factory=list)
    not_data_actions: List[str] = field(default_factory=list)
    role_key: Optional[str] = None
    role_type: Optional[str] = None          # BuiltInRole / CustomRole
    assignment_id: Optional[str] = None
    principal_id: Optional[str] = None
    condition: Optional[str] = None          # ABAC condition expression
    scope_level: Optional[str] = None

    @classmethod
    def from_grant(cls, grant: Any) -> "RoleAssignment":
        """Build from a `cloud_identity_grants` row or an equivalent dict.

        The permissions block is the one azure_rbac.py already stores, so this
        reads what the existing collector writes rather than a parallel shape.
        """
        get = (lambda k, d=None: grant.get(k, d)) if isinstance(grant, dict) \
            else (lambda k, d=None: getattr(grant, k, d))
        perms = get("permissions") or {}
        if isinstance(perms, list):           # some payloads carry a list of blocks
            merged: Dict[str, List[str]] = {}
            for block in perms:
                if not isinstance(block, dict):
                    continue
                for key in ("actions", "notActions", "dataActions", "notDataActions"):
                    merged.setdefault(key, []).extend(_as_list(block.get(key)))
            perms = merged
        return cls(
            role_name=get("role_name") or "(unnamed role)",
            scope=get("scope") or "",
            actions=_as_list(perms.get("actions") or perms.get("Actions")),
            not_actions=_as_list(perms.get("notActions") or perms.get("NotActions")),
            data_actions=_as_list(perms.get("dataActions") or perms.get("DataActions")),
            not_data_actions=_as_list(
                perms.get("notDataActions") or perms.get("NotDataActions")),
            role_key=get("role_key"),
            role_type=get("role_type"),
            assignment_id=get("grant_key"),
            principal_id=get("principal_id"),
            condition=get("condition"),
            scope_level=get("scope_level"),
        )

    def grants(self, operation: str, plane: str) -> Tuple[bool, Optional[str]]:
        """Does this assignment permit `operation` on the given plane?

        Returns `(granted, matched_pattern)`. NotActions are applied here, to
        this role's own Actions, and nowhere else.
        """
        allow = self.data_actions if plane == PLANE_DATA else self.actions
        deny = self.not_data_actions if plane == PLANE_DATA else self.not_actions
        matched = None
        for pattern in allow:
            if _covers(pattern, operation):
                matched = pattern
                break
        if matched is None:
            return False, None
        for pattern in deny:
            if _covers(pattern, operation):
                return False, None
        return True, matched


@dataclass
class DenyAssignment:
    """A deny assignment: subtractive, and it wins."""

    name: str
    scope: str
    actions: List[str] = field(default_factory=list)
    not_actions: List[str] = field(default_factory=list)
    data_actions: List[str] = field(default_factory=list)
    not_data_actions: List[str] = field(default_factory=list)
    assignment_id: Optional[str] = None
    # Principals the deny does NOT apply to. A deny assignment that excludes
    # this principal does not block it, and missing that inverts the result.
    excluded_principals: List[str] = field(default_factory=list)

    def forbids(self, operation: str, plane: str, principal_id: Optional[str]) -> Tuple[bool, Optional[str]]:
        if principal_id and principal_id in self.excluded_principals:
            return False, None
        allow = self.data_actions if plane == PLANE_DATA else self.actions
        deny = self.not_data_actions if plane == PLANE_DATA else self.not_actions
        matched = None
        for pattern in allow:
            if _covers(pattern, operation):
                matched = pattern
                break
        if matched is None:
            return False, None
        for pattern in deny:
            if _covers(pattern, operation):
                return False, None
        return True, matched


class AzureAssignmentSet:
    """Every assignment bearing on one principal, with collection health."""

    def __init__(
        self,
        *,
        assignments: Optional[Iterable[RoleAssignment]] = None,
        deny_assignments: Optional[Iterable[DenyAssignment]] = None,
        deny_assignments_collected: bool = False,
        deny_collection_error: Optional[str] = None,
        assignments_collected: bool = True,
    ) -> None:
        self.assignments: List[RoleAssignment] = list(assignments or [])
        self.deny_assignments: List[DenyAssignment] = list(deny_assignments or [])
        self.deny_assignments_collected = deny_assignments_collected
        self.deny_collection_error = deny_collection_error
        self.assignments_collected = assignments_collected

    def granted_action_patterns(self, plane: str = PLANE_CONTROL) -> List[str]:
        """Every Action pattern the principal holds, for capability classifying.

        NotActions are NOT subtracted here. A role's exclusions matter when
        answering about a specific operation, which `grants()` does; for the
        coarse "which capabilities does this principal hold" question the
        patterns are the input and `capabilities_covered` does the matching.
        The capability result is therefore an upper bound, which is the correct
        direction for a risk summary to err — and `evaluate()` gives the exact
        answer for any operation an operator drills into.
        """
        out: List[str] = []
        for a in self.assignments:
            source = a.data_actions if plane == PLANE_DATA else a.actions
            for pattern in source:
                if pattern not in out:
                    out.append(pattern)
        return out


def evaluate(
    assignment_set: AzureAssignmentSet,
    *,
    action: str,
    resource: Optional[str] = None,
    plane: str = PLANE_CONTROL,
    principal_id: Optional[str] = None,
) -> Decision:
    """Can this principal perform `action` on `resource`?"""
    steps: List[DecisionStep] = []
    unevaluated: List[Unevaluated] = []
    conditional = False

    if not assignment_set.assignments_collected:
        return Decision(
            decision=NOT_DETERMINED, action=action, resource=resource,
            unevaluated=[Unevaluated(
                stage=STAGE_RBAC_ASSIGNMENT, reason=UNEVAL_PERMISSION_DENIED,
                detail="Role assignments were not collected for this subscription.",
                missing_permission="Microsoft.Authorization/roleAssignments/read",
            )],
        )

    # ── Deny assignments win ─────────────────────────────────────────────────
    if assignment_set.deny_assignments_collected:
        for da in assignment_set.deny_assignments:
            if resource and not scope_covers(da.scope, resource):
                continue
            forbidden, matched = da.forbids(action, plane, principal_id)
            if forbidden:
                steps.append(DecisionStep(
                    stage=STAGE_DENY_ASSIGNMENT, effect="Deny", source_name=da.name,
                    source_key=da.assignment_id, matched_action=matched,
                    matched_resource=da.scope,
                    note="A deny assignment overrides every role assignment.",
                ))
                return Decision(decision=DENIED, action=action, resource=resource,
                                steps=steps)
    else:
        unevaluated.append(Unevaluated(
            stage=STAGE_DENY_ASSIGNMENT, reason=UNEVAL_NOT_COLLECTED,
            detail=(assignment_set.deny_collection_error
                    or "Deny assignments were not collected. A Blueprint or managed "
                       "application may forbid this action despite the role "
                       "assignments below permitting it."),
            missing_permission="Microsoft.Authorization/denyAssignments/read",
        ))

    # ── Any assignment in scope that grants it ───────────────────────────────
    out_of_scope = 0
    for a in assignment_set.assignments:
        if resource and not scope_covers(a.scope, resource):
            out_of_scope += 1
            continue
        granted, matched = a.grants(action, plane)
        if not granted:
            continue
        if a.condition:
            conditional = True
        inherited = bool(resource) and a.scope.rstrip("/") != resource.rstrip("/")
        steps.append(DecisionStep(
            stage=STAGE_RBAC_ASSIGNMENT, effect="Allow", source_name=a.role_name,
            source_key=a.role_key, statement_id=a.assignment_id,
            matched_action=matched, matched_resource=a.scope,
            inherited_from=a.scope if inherited else None,
            conditions={"abac": a.condition} if a.condition else None,
            note=("Inherited from a broader scope." if inherited else None),
        ))
        decision = ALLOWED_UNVERIFIED if unevaluated else ALLOWED
        return Decision(decision=decision, action=action, resource=resource, steps=steps,
                        unevaluated=unevaluated, conditional=conditional)

    note = "No role assignment covering this scope grants this operation."
    if out_of_scope:
        note += (f" {out_of_scope} assignment(s) grant it at a scope that does not "
                 f"cover this resource.")
    if plane == PLANE_DATA:
        note += (" Note: this is a data-plane operation. Control-plane roles such as "
                 "Owner or Contributor do not grant data actions.")
    steps.append(DecisionStep(
        stage=STAGE_RBAC_ASSIGNMENT, effect="NoMatch", source_name="role assignments",
        note=note,
    ))
    return Decision(decision=IMPLICIT_DENY, action=action, resource=resource, steps=steps,
                    unevaluated=unevaluated)


# ── Scope arithmetic ─────────────────────────────────────────────────────────
def scope_covers(assignment_scope: Optional[str], resource_scope: Optional[str]) -> bool:
    """Whether an assignment at `assignment_scope` applies to `resource_scope`.

    Segment-aware: `/subscriptions/S/resourceGroups/prod` covers
    `/subscriptions/S/resourceGroups/prod/providers/...` but NOT
    `/subscriptions/S/resourceGroups/production`. A plain `startswith` gets the
    second case wrong and silently widens every resource-group assignment.

    **Management groups.** A subscription's ARM path does not contain its
    management group, so no string operation can relate the two. This is not a
    gap in practice: the Azure API returns management-group assignments when
    assignments are listed at subscription scope, so an inherited assignment
    arrives already attached to the subscription's view. A management-group
    scope is therefore treated as covering everything in the set it was
    collected for, which is exactly what Azure means by returning it.
    """
    if not assignment_scope:
        return False
    if not resource_scope:
        return True
    a = assignment_scope.rstrip("/")
    r = resource_scope.rstrip("/")
    if a == r:
        return True
    if a.lower().startswith("/providers/microsoft.management/managementgroups/"):
        return True
    if a == "/":
        return True
    return r.lower().startswith(a.lower() + "/")


def scope_level(scope: Optional[str]) -> str:
    """Coarse level of an ARM scope, matching identity_grant.SCOPE_* ranking."""
    from app.models.identity_grant import (
        SCOPE_GROUP, SCOPE_RESOURCE, SCOPE_ROOT, SCOPE_SUBSCRIPTION,
    )
    s = (scope or "").rstrip("/").lower()
    if not s or s == "/":
        return SCOPE_ROOT
    if s.startswith("/providers/microsoft.management/managementgroups/"):
        return SCOPE_ROOT
    if "/providers/" in s.split("/resourcegroups/")[-1] and "/resourcegroups/" in s:
        return SCOPE_RESOURCE
    if "/resourcegroups/" in s:
        return SCOPE_GROUP
    if s.startswith("/subscriptions/"):
        return SCOPE_SUBSCRIPTION
    return SCOPE_RESOURCE


def _covers(pattern: Optional[str], operation: Optional[str]) -> bool:
    """Grant-as-pattern glob. The direction that keeps Reader out of Owner."""
    if not pattern or not operation:
        return False
    return fnmatch.fnmatchcase(operation.lower(), pattern.lower())


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if v is not None]
    return []


def capabilities_from_assignments(
    assignment_set: AzureAssignmentSet,
) -> Dict[str, List[str]]:
    """Normalized capabilities held, with the action patterns that conferred them.

    Both planes are considered: a Storage Blob Data Contributor holds
    STORAGE_WRITE through DataActions alone, and ignoring that plane would
    report it as having no storage access at all.
    """
    from app.identity.capability import capabilities_covered, covers, probe_operations

    grants = (assignment_set.granted_action_patterns(PLANE_CONTROL)
              + assignment_set.granted_action_patterns(PLANE_DATA))
    out: Dict[str, List[str]] = {}
    for capability in capabilities_covered(AZURE, grants):
        out[capability] = [
            g for g in grants
            if any(covers(AZURE, g, op) for op in probe_operations(AZURE, capability))
        ]
    return out


def classify(action: str) -> str:
    return classify_action(AZURE, action)
