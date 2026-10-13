"""OCI IAM policy evaluation.

OCI's policy language is a sentence, not a JSON document:

    Allow <subject> to <verb> <resource-type> in <location> [where <condition>]
    Allow group NetworkAdmins to manage virtual-network-family in compartment Prod
    Allow dynamic-group AppInstances to read objects in tenancy where
        target.bucket.name = 'config'

Four facts about the model drive this implementation, and each has a wrong
assumption that would produce a confident falsehood:

**OCI IAM policy is allow-only.** There is no Deny statement in the policy
language — access is purely additive over an implicit deny. So this evaluator
never returns DENIED; the absence of a matching Allow is IMPLICIT_DENY, which
is the honest and complete answer. An evaluator that reported DENIED here would
be claiming an explicit denial that does not exist in the system.

**Verbs are ranked and cumulative.** inspect ⊂ read ⊂ use ⊂ manage. A statement
granting `manage` satisfies a question about `read`. Treating them as four
unordered tokens under-reports every administrative grant.

**Compartments nest, and a grant at the tenancy reaches everything.** A policy
`in tenancy` applies to every compartment; `in compartment Prod` applies to
Prod and its descendants. Where the compartment tree has not been collected,
descent cannot be verified, and the stage is reported as unevaluated rather
than guessed in either direction.

**`any-user` is not a user.** `Allow any-user to ...` is the OCI equivalent of
a wildcard principal and usually appears with a `where request.principal.type`
condition that narrows it drastically. Reporting it as "every user has this"
without the condition would be alarmist and wrong; dropping it would hide a
genuinely open grant. Both the subject and the condition are carried.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity.capability import OCI_VERB_RANK, OCI_VERBS, classify_action
from app.identity.model import (
    ALLOWED, ALLOWED_UNVERIFIED, Decision, DecisionStep, IMPLICIT_DENY, NOT_DETERMINED,
    OCI, STAGE_OCI_POLICY, UNEVAL_NOT_COLLECTED, Unevaluated,
)

ALL_RESOURCES = "all-resources"
ANY_USER = "any-user"

# `Allow <subject> to <verb> <resource> in <location> [where <condition>]`
# Tolerant of extra whitespace and case, which real tenancy policies are full of.
_STATEMENT_RE = re.compile(
    r"^\s*(?P<effect>allow|endorse|define|admit)\s+"
    r"(?P<subject>.+?)\s+to\s+"
    r"(?P<verb>inspect|read|use|manage)\s+"
    r"(?P<resource>[\w\-\.]+)\s+"
    r"in\s+(?P<location>.+?)"
    r"(?:\s+where\s+(?P<condition>.+))?\s*$",
    re.IGNORECASE | re.DOTALL,
)

_SUBJECT_RE = re.compile(
    r"^(?P<kind>group|dynamic-group|service|any-user|any-group)"
    r"(?:\s+(?P<name>.+))?$",
    re.IGNORECASE,
)


@dataclass
class PolicyStatement:
    """One parsed OCI policy statement."""

    raw: str
    verb: Optional[str] = None
    resource_type: Optional[str] = None
    subject_kind: Optional[str] = None
    subject_names: List[str] = field(default_factory=list)
    location_kind: Optional[str] = None       # tenancy / compartment
    location_name: Optional[str] = None
    condition: Optional[str] = None
    policy_name: Optional[str] = None
    policy_ocid: Optional[str] = None
    compartment_id: Optional[str] = None
    # Set when the sentence did not parse. Carried, never dropped: an
    # unparseable statement means this principal's permissions are not fully
    # known, and the evaluator degrades instead of ignoring it.
    parse_error: Optional[str] = None

    @property
    def parsed(self) -> bool:
        return self.parse_error is None and self.verb is not None

    def covers_verb(self, wanted: str) -> bool:
        """Whether this statement's verb satisfies `wanted` (manage ⊇ read)."""
        if not self.verb or wanted not in OCI_VERB_RANK:
            return False
        return OCI_VERB_RANK[self.verb] >= OCI_VERB_RANK[wanted]

    def covers_resource(self, wanted: Optional[str]) -> bool:
        if not self.resource_type:
            return False
        if self.resource_type.lower() == ALL_RESOURCES:
            return True
        if not wanted:
            return True
        return fnmatch.fnmatchcase(wanted.lower(), self.resource_type.lower())

    def applies_to(self, subject_names: Sequence[str], subject_kind: Optional[str]) -> bool:
        """Whether this statement's subject includes the principal in question."""
        kind = (self.subject_kind or "").lower()
        if kind in (ANY_USER, "any-group"):
            return True
        if subject_kind and kind and kind != subject_kind.lower():
            return False
        if not self.subject_names:
            return False
        wanted = {n.strip().lower() for n in subject_names if n}
        return any(n.strip().lower() in wanted for n in self.subject_names)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "raw": self.raw,
            "verb": self.verb,
            "resource_type": self.resource_type,
            "subject_kind": self.subject_kind,
            "subject_names": self.subject_names,
            "location_kind": self.location_kind,
            "location_name": self.location_name,
            "condition": self.condition,
            "policy_name": self.policy_name,
            "policy_ocid": self.policy_ocid,
            "parse_error": self.parse_error,
            "tenancy_wide": self.location_kind == "tenancy",
            "all_resources": (self.resource_type or "").lower() == ALL_RESOURCES,
            "any_user": (self.subject_kind or "").lower() == ANY_USER,
        }


def parse_statement(text: str, *, policy_name: Optional[str] = None,
                    policy_ocid: Optional[str] = None,
                    compartment_id: Optional[str] = None) -> PolicyStatement:
    """Parse one policy sentence. Never raises; failure is a field."""
    raw = (text or "").strip()
    stmt = PolicyStatement(raw=raw, policy_name=policy_name, policy_ocid=policy_ocid,
                           compartment_id=compartment_id)
    if not raw:
        stmt.parse_error = "empty statement"
        return stmt

    match = _STATEMENT_RE.match(raw.replace("\n", " "))
    if not match:
        stmt.parse_error = "did not match the OCI policy grammar"
        return stmt

    effect = (match.group("effect") or "").lower()
    if effect in ("endorse", "define", "admit"):
        # Cross-tenancy constructs. They are real and are collected as trust
        # evidence elsewhere, but they do not grant permission inside this
        # tenancy, so they are parsed and marked rather than evaluated here.
        stmt.parse_error = f"{effect} statement — cross-tenancy, not an in-tenancy grant"
        return stmt

    stmt.verb = (match.group("verb") or "").lower()
    stmt.resource_type = (match.group("resource") or "").lower()
    stmt.condition = (match.group("condition") or "").strip() or None

    subject_raw = (match.group("subject") or "").strip()
    sm = _SUBJECT_RE.match(subject_raw)
    if sm:
        stmt.subject_kind = (sm.group("kind") or "").lower()
        names = (sm.group("name") or "").strip()
        if names:
            stmt.subject_names = [n.strip() for n in names.split(",") if n.strip()]
    else:
        stmt.subject_kind = "group"
        stmt.subject_names = [subject_raw]

    location = (match.group("location") or "").strip()
    low = location.lower()
    if low.startswith("tenancy"):
        stmt.location_kind = "tenancy"
        stmt.location_name = None
    elif low.startswith("compartment"):
        stmt.location_kind = "compartment"
        stmt.location_name = location.split(None, 1)[1].strip() if " " in location else None
    else:
        stmt.location_kind = "compartment"
        stmt.location_name = location
    return stmt


class OciPolicySet:
    """Every statement bearing on one principal, with collection health."""

    def __init__(
        self,
        *,
        statements: Optional[Iterable[PolicyStatement]] = None,
        subject_names: Optional[Sequence[str]] = None,
        subject_kind: Optional[str] = None,
        policies_collected: bool = True,
        compartment_tree_collected: bool = False,
        compartment_descendants: Optional[Dict[str, Sequence[str]]] = None,
    ) -> None:
        self.statements: List[PolicyStatement] = list(statements or [])
        self.subject_names: List[str] = list(subject_names or [])
        self.subject_kind = subject_kind
        self.policies_collected = policies_collected
        self.compartment_tree_collected = compartment_tree_collected
        self.compartment_descendants = {
            k: list(v) for k, v in (compartment_descendants or {}).items()
        }

    @property
    def parse_errors(self) -> List[str]:
        return [s.parse_error for s in self.statements
                if s.parse_error and not s.parse_error.startswith(("endorse", "define", "admit"))]

    def applicable(self) -> List[PolicyStatement]:
        return [s for s in self.statements
                if s.parsed and s.applies_to(self.subject_names, self.subject_kind)]

    def granted_action_patterns(self) -> List[str]:
        """`verb:resource-type` for every applicable statement."""
        out: List[str] = []
        for s in self.applicable():
            token = f"{s.verb}:{s.resource_type}"
            if token not in out:
                out.append(token)
        return out


def evaluate(
    policy_set: OciPolicySet,
    *,
    action: str,
    resource: Optional[str] = None,
    compartment_id: Optional[str] = None,
) -> Decision:
    """Can this principal perform `action`?

    `action` is `verb:resource-family` (`manage:object-family`) or the policy
    language's own `manage object-family`. A bare OCI API operation name is not
    accepted, because mapping an operation to a (verb, family) pair is a
    provider-specific table this platform does not hold in full — and guessing
    it would put a fabricated permission in front of an operator.
    """
    steps: List[DecisionStep] = []
    unevaluated: List[Unevaluated] = []

    if not policy_set.policies_collected:
        return Decision(
            decision=NOT_DETERMINED, action=action, resource=resource,
            unevaluated=[Unevaluated(
                stage=STAGE_OCI_POLICY, reason=UNEVAL_NOT_COLLECTED,
                detail="IAM policies were not collected for this tenancy.",
                missing_permission="inspect policies in tenancy",
            )],
        )

    wanted = _split_action(action)
    if wanted is None:
        return Decision(
            decision=NOT_DETERMINED, action=action, resource=resource,
            unevaluated=[Unevaluated(
                stage=STAGE_OCI_POLICY, reason=UNEVAL_NOT_COLLECTED,
                detail=(f"{action!r} is not an OCI verb/resource-family pair. "
                        "Expected e.g. 'manage:object-family'."),
            )],
        )
    verb, family = wanted

    if policy_set.parse_errors:
        unevaluated.append(Unevaluated(
            stage=STAGE_OCI_POLICY, reason=UNEVAL_NOT_COLLECTED,
            detail=(f"{len(policy_set.parse_errors)} policy statement(s) could not be "
                    f"parsed, so this principal's permissions may be broader than shown. "
                    f"First: {policy_set.parse_errors[0]}"),
        ))

    for stmt in policy_set.applicable():
        if not stmt.covers_verb(verb):
            continue
        if not stmt.covers_resource(family):
            continue
        in_scope, scope_note, scope_uncertain = _location_applies(
            policy_set, stmt, compartment_id)
        if not in_scope:
            continue
        if scope_uncertain:
            unevaluated.append(Unevaluated(
                stage=STAGE_OCI_POLICY, reason=UNEVAL_NOT_COLLECTED,
                detail=("The compartment tree was not collected, so whether this "
                        "compartment grant reaches the target compartment could not "
                        "be confirmed."),
                missing_permission="inspect compartments in tenancy",
            ))
        steps.append(DecisionStep(
            stage=STAGE_OCI_POLICY, effect="Allow",
            source_name=stmt.policy_name or "IAM policy",
            source_key=stmt.policy_ocid, statement_id=stmt.raw,
            matched_action=f"{stmt.verb} {stmt.resource_type}",
            matched_resource=scope_note,
            inherited_from=(f"{stmt.subject_kind} "
                            f"{', '.join(stmt.subject_names)}" if stmt.subject_names else None),
            conditions={"where": stmt.condition} if stmt.condition else None,
            note=("Granted to any-user; read the condition before treating this as "
                  "broad." if (stmt.subject_kind or "").lower() == ANY_USER else None),
        ))
        decision = ALLOWED_UNVERIFIED if unevaluated else ALLOWED
        return Decision(decision=decision, action=action, resource=resource, steps=steps,
                        unevaluated=unevaluated, conditional=bool(stmt.condition))

    steps.append(DecisionStep(
        stage=STAGE_OCI_POLICY, effect="NoMatch", source_name="IAM policies",
        note=("No policy statement grants this verb on this resource family to this "
              "principal. OCI policy is allow-only, so this is an implicit denial "
              "rather than an explicit one."),
    ))
    return Decision(decision=IMPLICIT_DENY, action=action, resource=resource, steps=steps,
                    unevaluated=unevaluated)


def _location_applies(
    policy_set: OciPolicySet, stmt: PolicyStatement, compartment_id: Optional[str],
) -> Tuple[bool, str, bool]:
    """Whether a statement's location reaches the target compartment.

    Returns `(applies, human_scope, uncertain)`. `uncertain` is set when the
    compartment tree was not collected and descent therefore could not be
    confirmed — the caller turns that into an `Unevaluated` entry rather than
    silently resolving it either way.
    """
    if stmt.location_kind == "tenancy":
        return True, "tenancy (all compartments)", False
    name = stmt.location_name or "(unnamed compartment)"
    if not compartment_id:
        return True, f"compartment {name}", False
    if stmt.compartment_id and stmt.compartment_id == compartment_id:
        return True, f"compartment {name}", False
    if policy_set.compartment_tree_collected:
        descendants = policy_set.compartment_descendants.get(stmt.compartment_id or "", [])
        if compartment_id in descendants:
            return True, f"compartment {name} (inherited)", False
        if stmt.location_name and compartment_id == stmt.location_name:
            return True, f"compartment {name}", False
        return False, f"compartment {name}", False
    return True, f"compartment {name}", True


def _split_action(action: Optional[str]) -> Optional[Tuple[str, str]]:
    if not action:
        return None
    raw = action.strip().lower()
    if ":" in raw:
        verb, _, family = raw.partition(":")
    else:
        parts = raw.split()
        if len(parts) < 2:
            return None
        verb, family = parts[0], parts[1]
    verb, family = verb.strip(), family.strip()
    if verb not in OCI_VERB_RANK or not family:
        return None
    return verb, family


def parse_policy_resource(config: Any, *, policy_name: Optional[str] = None,
                          policy_ocid: Optional[str] = None,
                          compartment_id: Optional[str] = None) -> List[PolicyStatement]:
    """Parse the statements off an `IAMPolicy` resource's config block.

    That is where the OCI scanner already puts them, so this reads what the
    existing collector writes rather than introducing a parallel shape.
    """
    if config is None:
        return []
    raw = config
    if isinstance(config, dict):
        raw = config.get("statements") or config.get("Statements") or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    return [
        parse_statement(str(text), policy_name=policy_name, policy_ocid=policy_ocid,
                        compartment_id=compartment_id)
        for text in raw if text
    ]


def capabilities_from_policy_set(policy_set: OciPolicySet) -> Dict[str, List[str]]:
    from app.identity.capability import capabilities_covered, covers, probe_operations

    grants = policy_set.granted_action_patterns()
    out: Dict[str, List[str]] = {}
    for capability in capabilities_covered(OCI, grants):
        out[capability] = [
            g for g in grants
            if any(covers(OCI, g, op) for op in probe_operations(OCI, capability))
        ]
    return out


def classify(action: str) -> str:
    return classify_action(OCI, action)


__all__ = [
    "ALL_RESOURCES", "ANY_USER", "OCI_VERBS", "OciPolicySet", "PolicyStatement",
    "capabilities_from_policy_set", "classify", "evaluate", "parse_policy_resource",
    "parse_statement",
]
