"""AWS effective-permission evaluation.

Implements AWS's own evaluation order for a request inside a single account,
and says out loud where it stops short. The order, from the IAM reference:

1.  **Explicit deny** anywhere — identity policy, resource policy, permissions
    boundary, session policy or SCP — wins over everything. Evaluated first.
2.  **Service control policies.** If the account is in an Organization, the
    action must be allowed by the SCPs that apply to it. An SCP grants nothing
    on its own; it only takes away.
3.  **Resource-based policy.** Can grant access by itself.
4.  **Permissions boundary.** If one is attached, the action must also be
    allowed by it.
5.  **Session policy.** If the principal is a session, the action must also be
    allowed by it.
6.  **Identity-based policy.** Attached and inline, plus anything inherited
    from the principal's groups.
7.  Otherwise **implicit deny**.

WHAT THIS EVALUATOR DOES NOT DO, and why each gap is reported rather than
assumed away:

*   **Conditions are not evaluated.** There is no request context here — no
    source IP, no MFA state, no session tag — so a matched statement carrying
    a `Condition` sets `conditional=True` on the decision and the UI says the
    access depends on conditions it names. Silently treating a conditional
    grant as unconditional would overstate access; silently discarding it would
    understate it. Neither is acceptable, so it is reported.
*   **Policy variables are not substituted.** `${aws:username}` in a resource
    ARN is left unresolved and `policy_ast.match_token` refuses to match it.
*   **SCPs are usually not collectable.** Reading them needs
    `organizations:ListPoliciesForTarget` against the management account, which
    a member-account credential does not have. When they are absent the stage
    is recorded as `Unevaluated` and every ALLOW becomes ALLOWED_UNVERIFIED.
    This is the single most important honesty in the module: an estate with
    restrictive SCPs will show access here that the organization actually
    blocks, and the result has to say so rather than claim certainty.
*   **Cross-account resource policies** are evaluated only where this platform
    holds the resource policy. Access granted by a bucket in an account we do
    not scan is invisible to us and is not claimed either way.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity import policy_ast as ast
from app.identity.capability import classify_action
from app.identity.model import (
    ALLOWED, ALLOWED_UNVERIFIED, AWS, DENIED, Decision, DecisionStep, IMPLICIT_DENY,
    NOT_DETERMINED, STAGE_IDENTITY_POLICY, STAGE_GROUP_POLICY,
    STAGE_PERMISSION_BOUNDARY, STAGE_RESOURCE_POLICY, STAGE_SCP, STAGE_SESSION_POLICY,
    STAGE_TRUST_POLICY, UNEVAL_NOT_COLLECTED, Unevaluated,
)


class AwsPolicySet:
    """Everything that bears on one principal's requests, already parsed.

    Built once per principal by the collector and reused across every action
    the explorer asks about, which is what keeps the permission explorer
    interactive at 10,000 identities (§34).
    """

    def __init__(
        self,
        *,
        identity_documents: Optional[Iterable[Any]] = None,
        group_documents: Optional[Iterable[Tuple[str, Any]]] = None,
        boundary_document: Any = None,
        session_documents: Optional[Iterable[Any]] = None,
        scp_documents: Optional[Iterable[Any]] = None,
        resource_policies: Optional[Dict[str, Any]] = None,
        trust_document: Any = None,
        scp_collected: bool = False,
        boundary_present: bool = False,
        policy_names: Optional[Dict[int, str]] = None,
    ) -> None:
        self.parse_errors: List[str] = []

        self.identity, errs = ast.documents_to_statements(identity_documents or [])
        self.parse_errors.extend(errs)

        # Group statements keep the group's name so provenance survives: an
        # operator needs "via group Developers", not "from somewhere".
        self.group: List[Tuple[str, ast.Statement]] = []
        for group_name, doc in (group_documents or []):
            parsed, err = ast.parse_document(doc)
            if err:
                self.parse_errors.append(f"group {group_name}: {err}")
                continue
            self.group.extend((group_name, s) for s in parsed)

        self.boundary, errs = ast.documents_to_statements(
            [boundary_document] if boundary_document else []
        )
        self.parse_errors.extend(errs)
        self.boundary_present = boundary_present or bool(boundary_document)

        self.session, errs = ast.documents_to_statements(session_documents or [])
        self.parse_errors.extend(errs)

        self.scp, errs = ast.documents_to_statements(scp_documents or [])
        self.parse_errors.extend(errs)
        self.scp_collected = scp_collected

        self.resource_policies: Dict[str, List[ast.Statement]] = {}
        for key, doc in (resource_policies or {}).items():
            parsed, err = ast.parse_document(doc)
            if err:
                self.parse_errors.append(f"resource policy {key}: {err}")
                continue
            self.resource_policies[key] = parsed

        self.trust, errs = ast.documents_to_statements(
            [trust_document] if trust_document else []
        )
        self.parse_errors.extend(errs)
        self.policy_names = policy_names or {}

    @property
    def empty(self) -> bool:
        return not (self.identity or self.group or self.boundary or self.session
                    or self.resource_policies)

    def granted_action_patterns(self) -> List[str]:
        """Every Allow action pattern reachable by this principal.

        Feeds the capability classifier. Group statements are included because
        a principal's privilege is what it can do, not what is attached
        directly to it.
        """
        stmts = list(self.identity) + [s for _, s in self.group]
        return ast.expand_actions(stmts, effect="Allow")

    def denied_action_patterns(self) -> List[str]:
        stmts = list(self.identity) + [s for _, s in self.group]
        return ast.expand_actions(stmts, effect="Deny")


def evaluate(
    policy_set: AwsPolicySet,
    *,
    action: str,
    resource: Optional[str] = None,
    principal_arn: Optional[str] = None,
) -> Decision:
    """Can this principal perform `action` on `resource`?"""
    steps: List[DecisionStep] = []
    unevaluated: List[Unevaluated] = []
    conditional = False

    if policy_set.parse_errors and policy_set.empty:
        # Nothing readable at all. NOT_DETERMINED, never "no access".
        return Decision(
            decision=NOT_DETERMINED, action=action, resource=resource,
            unevaluated=[Unevaluated(
                stage=STAGE_IDENTITY_POLICY, reason=UNEVAL_NOT_COLLECTED,
                detail="; ".join(policy_set.parse_errors[:3]),
            )],
        )

    # ── 1. Explicit deny anywhere ────────────────────────────────────────────
    deny_sources: List[Tuple[str, str, Sequence[ast.Statement]]] = [
        (STAGE_IDENTITY_POLICY, "identity policy", policy_set.identity),
        (STAGE_PERMISSION_BOUNDARY, "permissions boundary", policy_set.boundary),
        (STAGE_SESSION_POLICY, "session policy", policy_set.session),
        (STAGE_SCP, "service control policy", policy_set.scp),
    ]
    for stage, label, statements in deny_sources:
        hit = _first_match(statements, action, resource, deny=True)
        if hit:
            stmt, matched_action, matched_resource = hit
            steps.append(DecisionStep(
                stage=stage, effect="Deny", source_name=stmt.sid or label,
                statement_id=stmt.sid, matched_action=matched_action,
                matched_resource=matched_resource,
                conditions=ast.condition_summary(stmt.conditions) if stmt.conditions else None,
                note="An explicit deny overrides every allow, at every stage.",
            ))
            return Decision(decision=DENIED, action=action, resource=resource, steps=steps)

    for group_name, stmt in policy_set.group:
        if not stmt.is_deny:
            continue
        ok_a, matched_action = ast.statement_matches_action(stmt, action)
        ok_r, matched_resource = ast.statement_matches_resource(stmt, resource)
        if ok_a and ok_r:
            steps.append(DecisionStep(
                stage=STAGE_GROUP_POLICY, effect="Deny",
                source_name=stmt.sid or f"group {group_name}", statement_id=stmt.sid,
                matched_action=matched_action, matched_resource=matched_resource,
                inherited_from=f"group {group_name}",
                note="An explicit deny overrides every allow, at every stage.",
            ))
            return Decision(decision=DENIED, action=action, resource=resource, steps=steps)

    for key, statements in policy_set.resource_policies.items():
        hit = _first_match(statements, action, resource, deny=True,
                           principal=principal_arn, require_principal=True)
        if hit:
            stmt, matched_action, matched_resource = hit
            steps.append(DecisionStep(
                stage=STAGE_RESOURCE_POLICY, effect="Deny",
                source_name=stmt.sid or key, source_key=key, statement_id=stmt.sid,
                matched_action=matched_action, matched_resource=matched_resource,
            ))
            return Decision(decision=DENIED, action=action, resource=resource, steps=steps)

    # ── 2. Service control policies ──────────────────────────────────────────
    if policy_set.scp_collected:
        hit = _first_match(policy_set.scp, action, resource, deny=False)
        if hit:
            stmt, matched_action, matched_resource = hit
            steps.append(DecisionStep(
                stage=STAGE_SCP, effect="Allow", source_name=stmt.sid or "SCP",
                statement_id=stmt.sid, matched_action=matched_action,
                matched_resource=matched_resource,
                note="The organization permits this action in this account.",
            ))
        else:
            steps.append(DecisionStep(
                stage=STAGE_SCP, effect="NoMatch", source_name="SCP",
                note="No service control policy permits this action, so the "
                     "organization blocks it regardless of account-level policy.",
            ))
            return Decision(decision=IMPLICIT_DENY, action=action, resource=resource,
                            steps=steps)
    else:
        unevaluated.append(Unevaluated(
            stage=STAGE_SCP, reason=UNEVAL_NOT_COLLECTED,
            detail=("Service control policies were not collected for this account. "
                    "If the account belongs to an AWS Organization, an SCP may block "
                    "this action despite the policies below allowing it."),
            missing_permission="organizations:ListPoliciesForTarget "
                               "(on the management account)",
        ))

    # ── 3. Permissions boundary ──────────────────────────────────────────────
    if policy_set.boundary_present:
        hit = _first_match(policy_set.boundary, action, resource, deny=False)
        if hit:
            stmt, matched_action, matched_resource = hit
            steps.append(DecisionStep(
                stage=STAGE_PERMISSION_BOUNDARY, effect="Allow",
                source_name=stmt.sid or "permissions boundary", statement_id=stmt.sid,
                matched_action=matched_action, matched_resource=matched_resource,
            ))
        else:
            steps.append(DecisionStep(
                stage=STAGE_PERMISSION_BOUNDARY, effect="NoMatch",
                source_name="permissions boundary",
                note="A permissions boundary is attached and does not permit this "
                     "action, which caps whatever the identity policy grants.",
            ))
            return Decision(decision=IMPLICIT_DENY, action=action, resource=resource,
                            steps=steps, unevaluated=unevaluated)

    # ── 4. Session policy ────────────────────────────────────────────────────
    if policy_set.session:
        hit = _first_match(policy_set.session, action, resource, deny=False)
        if hit:
            stmt, matched_action, matched_resource = hit
            steps.append(DecisionStep(
                stage=STAGE_SESSION_POLICY, effect="Allow",
                source_name=stmt.sid or "session policy", statement_id=stmt.sid,
                matched_action=matched_action, matched_resource=matched_resource,
            ))
        else:
            steps.append(DecisionStep(
                stage=STAGE_SESSION_POLICY, effect="NoMatch", source_name="session policy",
                note="The session policy does not permit this action.",
            ))
            return Decision(decision=IMPLICIT_DENY, action=action, resource=resource,
                            steps=steps, unevaluated=unevaluated)

    # ── 5. Identity, group and resource policies ─────────────────────────────
    allow_step: Optional[DecisionStep] = None

    hit = _first_match(policy_set.identity, action, resource, deny=False)
    if hit:
        stmt, matched_action, matched_resource = hit
        conditional = conditional or bool(stmt.conditions)
        allow_step = DecisionStep(
            stage=STAGE_IDENTITY_POLICY, effect="Allow",
            source_name=stmt.sid or "identity policy", statement_id=stmt.sid,
            matched_action=matched_action, matched_resource=matched_resource,
            conditions=ast.condition_summary(stmt.conditions) if stmt.conditions else None,
        )

    if allow_step is None:
        for group_name, stmt in policy_set.group:
            if stmt.is_deny:
                continue
            ok_a, matched_action = ast.statement_matches_action(stmt, action)
            ok_r, matched_resource = ast.statement_matches_resource(stmt, resource)
            if ok_a and ok_r:
                conditional = conditional or bool(stmt.conditions)
                allow_step = DecisionStep(
                    stage=STAGE_GROUP_POLICY, effect="Allow",
                    source_name=stmt.sid or f"group {group_name}", statement_id=stmt.sid,
                    matched_action=matched_action, matched_resource=matched_resource,
                    inherited_from=f"group {group_name}",
                    conditions=(ast.condition_summary(stmt.conditions)
                                if stmt.conditions else None),
                )
                break

    if allow_step is None:
        for key, statements in policy_set.resource_policies.items():
            hit = _first_match(statements, action, resource, deny=False,
                               principal=principal_arn, require_principal=True)
            if hit:
                stmt, matched_action, matched_resource = hit
                conditional = conditional or bool(stmt.conditions)
                allow_step = DecisionStep(
                    stage=STAGE_RESOURCE_POLICY, effect="Allow",
                    source_name=stmt.sid or key, source_key=key, statement_id=stmt.sid,
                    matched_action=matched_action, matched_resource=matched_resource,
                    conditions=(ast.condition_summary(stmt.conditions)
                                if stmt.conditions else None),
                    note="Granted by the resource's own policy rather than by the "
                         "principal's identity policy.",
                )
                break

    if allow_step is None:
        steps.append(DecisionStep(
            stage=STAGE_IDENTITY_POLICY, effect="NoMatch", source_name="identity policy",
            note="No attached, inline, group or resource policy grants this action.",
        ))
        return Decision(decision=IMPLICIT_DENY, action=action, resource=resource,
                        steps=steps, unevaluated=unevaluated)

    steps.append(allow_step)
    decision = ALLOWED_UNVERIFIED if unevaluated else ALLOWED
    return Decision(decision=decision, action=action, resource=resource, steps=steps,
                    unevaluated=unevaluated, conditional=conditional)


def _first_match(
    statements: Sequence[ast.Statement],
    action: str,
    resource: Optional[str],
    *,
    deny: bool,
    principal: Optional[str] = None,
    require_principal: bool = False,
) -> Optional[Tuple[ast.Statement, Optional[str], Optional[str]]]:
    """The first statement of the requested effect that covers action+resource."""
    for stmt in statements:
        if stmt.is_deny != deny:
            continue
        if require_principal and not ast.statement_matches_principal(stmt, principal):
            continue
        ok_a, matched_action = ast.statement_matches_action(stmt, action)
        if not ok_a:
            continue
        ok_r, matched_resource = ast.statement_matches_resource(stmt, resource)
        if not ok_r:
            continue
        return stmt, matched_action, matched_resource
    return None


# ── Trust relationships ──────────────────────────────────────────────────────
def trust_principals(trust_document: Any) -> List[Dict[str, Any]]:
    """Who may assume this role, from its trust policy.

    Each entry carries the condition summary, because an `sts:ExternalId`
    requirement is the difference between a scoped third-party integration and
    a role any account can assume. §14 is explicit that external is not the
    same as malicious, so the facts are reported and the judgement is left to
    the finding rule.
    """
    statements, err = ast.parse_document(trust_document)
    if err:
        return []
    out: List[Dict[str, Any]] = []
    for stmt in statements:
        if stmt.is_deny:
            continue
        has_assume = any(
            ast.match_token(p, "sts:AssumeRole")
            or ast.match_token(p, "sts:AssumeRoleWithSAML")
            or ast.match_token(p, "sts:AssumeRoleWithWebIdentity")
            for p in stmt.actions
        ) or stmt.action_set_is_exclusionary
        if not has_assume:
            continue
        cond = ast.condition_summary(stmt.conditions)
        for principal in stmt.principals:
            out.append({
                "principal": principal,
                "statement_id": stmt.sid,
                "conditions": cond if cond.get("present") else None,
                "has_external_id": bool(cond.get("requires_external_id")),
                "has_mfa_condition": bool(cond.get("requires_mfa")),
                "restricts_org": bool(cond.get("restricts_org")),
                "stage": STAGE_TRUST_POLICY,
            })
    return out


def capabilities_from_policy_set(policy_set: AwsPolicySet) -> Dict[str, List[str]]:
    """Normalized capabilities this principal holds, with the evidence.

    Returns `{capability: [action patterns that conferred it]}`, so a claim
    like "this role can modify IAM" always arrives with the statement behind it.
    """
    from app.identity.capability import capabilities_covered, probe_operations, covers

    grants = policy_set.granted_action_patterns()
    out: Dict[str, List[str]] = {}
    for capability in capabilities_covered(AWS, grants):
        evidence = [
            g for g in grants
            if any(covers(AWS, g, op) for op in probe_operations(AWS, capability))
        ]
        out[capability] = evidence
    return out


def classify(action: str) -> str:
    """Normalized capability for a concrete AWS action."""
    return classify_action(AWS, action)
