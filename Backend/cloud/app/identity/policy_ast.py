"""Parsing and matching for IAM-style policy documents.

Shared by the AWS evaluator (which uses all of it) and the Azure and OCI
evaluators (which use the matcher but not the JSON shape). Kept separate from
the evaluators so the matching rules — the part that is easy to get subtly,
silently wrong — have one implementation and one test surface.

Two matching rules carry the weight.

**Action matching is grant-as-pattern.** The same rule, and the same reason, as
`capability.covers`: `fnmatch(concrete_operation, granted_pattern)`. A
statement granting `s3:*` covers `s3:GetObject`; a statement granting
`s3:GetObject` does not cover `s3:*`, and asking the question the other way
round is what reported Reader as Owner on 23 live assignments.

**`NotAction` is not negation of the match — it is negation of the SET.** A
statement with `"NotAction": "iam:*"` applies to every action that is NOT an
IAM action. The common mistake is to implement it as "does not match", which
gives the right answer for a concrete action and the wrong one for everything
built on top of it: an Allow/NotAction statement grants a near-unlimited
surface, and treating it as narrow is how a policy that is effectively
AdministratorAccess gets classified as STANDARD. `expand_actions` therefore
reports such a statement as unbounded rather than enumerating it.

ARN matching deliberately keeps `*` and `?` glob semantics and nothing else.
IAM policy variables (`${aws:username}`) are NOT substituted — they are
reported as unresolved, because guessing a value would produce a confident
answer about access that may not exist.
"""
from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# A statement whose action set is expressed by exclusion. Carried as a sentinel
# rather than an expanded list because the expansion is the entire action
# namespace minus a few, which is ~18,000 strings nobody should materialise.
UNBOUNDED = "*"

# Marks an action or resource string that contains an unsubstituted policy
# variable. Matching against it is refused rather than guessed.
_VARIABLE_MARKERS = ("${", "}")


def as_list(value: Any) -> List[str]:
    """Policy fields are string-or-list everywhere. One place normalises it."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def has_variable(token: Optional[str]) -> bool:
    """Whether a policy token carries an unresolved variable like ${aws:username}."""
    if not token:
        return False
    return all(m in token for m in _VARIABLE_MARKERS)


@dataclass
class Statement:
    """One normalised policy statement."""

    effect: str                              # "Allow" / "Deny"
    actions: List[str] = field(default_factory=list)
    not_actions: List[str] = field(default_factory=list)
    resources: List[str] = field(default_factory=list)
    not_resources: List[str] = field(default_factory=list)
    principals: List[str] = field(default_factory=list)
    not_principals: List[str] = field(default_factory=list)
    conditions: Dict[str, Any] = field(default_factory=dict)
    sid: Optional[str] = None
    # Set when the statement came from a document we could parse but a field
    # inside it was a shape we do not model. The evaluator degrades to
    # NOT_DETERMINED rather than ignoring it.
    anomaly: Optional[str] = None

    @property
    def is_deny(self) -> bool:
        return (self.effect or "").strip().lower() == "deny"

    @property
    def action_set_is_exclusionary(self) -> bool:
        return bool(self.not_actions) and not self.actions

    @property
    def resource_set_is_exclusionary(self) -> bool:
        return bool(self.not_resources) and not self.resources

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sid": self.sid,
            "effect": self.effect,
            "actions": self.actions,
            "not_actions": self.not_actions,
            "resources": self.resources,
            "not_resources": self.not_resources,
            "principals": self.principals,
            "not_principals": self.not_principals,
            "conditions": self.conditions or None,
            "anomaly": self.anomaly,
        }


def parse_document(document: Any) -> Tuple[List[Statement], Optional[str]]:
    """Parse an IAM policy document into statements.

    Returns `(statements, error)`. A parse failure returns `([], reason)` and
    the caller MUST treat the principal's permissions as NOT_DETERMINED — an
    unparseable policy is not an empty one, and the difference is the whole
    §35 discipline.
    """
    doc = document
    if isinstance(doc, (bytes, bytearray)):
        doc = doc.decode("utf-8", errors="replace")
    if isinstance(doc, str):
        text = doc.strip()
        if not text:
            return [], "empty policy document"
        try:
            doc = json.loads(text)
        except json.JSONDecodeError:
            # AWS URL-encodes inline policy documents in some API responses.
            try:
                from urllib.parse import unquote
                doc = json.loads(unquote(text))
            except Exception as exc:  # noqa: BLE001 - reported, not raised
                return [], f"not valid JSON: {exc}"
    if not isinstance(doc, dict):
        return [], f"expected a policy object, got {type(doc).__name__}"

    raw = doc.get("Statement", doc.get("statement"))
    if raw is None:
        return [], "document has no Statement"
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return [], f"Statement is {type(raw).__name__}, expected object or list"

    out: List[Statement] = []
    for item in raw:
        if not isinstance(item, dict):
            out.append(Statement(effect="Deny", anomaly="statement was not an object"))
            continue
        principals, not_principals, anomaly = _principals(item)
        out.append(Statement(
            effect=str(item.get("Effect", item.get("effect", "Allow"))),
            actions=as_list(item.get("Action", item.get("action"))),
            not_actions=as_list(item.get("NotAction", item.get("notAction"))),
            resources=as_list(item.get("Resource", item.get("resource"))),
            not_resources=as_list(item.get("NotResource", item.get("notResource"))),
            principals=principals,
            not_principals=not_principals,
            conditions=item.get("Condition", item.get("condition")) or {},
            sid=item.get("Sid", item.get("sid")),
            anomaly=anomaly,
        ))
    return out, None


def _principals(item: Dict[str, Any]) -> Tuple[List[str], List[str], Optional[str]]:
    """Flatten a Principal block.

    `{"AWS": "*"}`, `{"AWS": ["arn:…", "123456789012"]}`, `{"Service": "…"}`,
    `{"Federated": "…"}` and the bare string `"*"` are all real shapes. The
    type prefix is kept (`Service:lambda.amazonaws.com`) because an external
    AWS account and an AWS service are very different trust findings.
    """
    def flatten(block: Any) -> Tuple[List[str], Optional[str]]:
        if block is None:
            return [], None
        if isinstance(block, str):
            return [block], None
        if isinstance(block, dict):
            vals: List[str] = []
            for kind, entries in block.items():
                for entry in as_list(entries):
                    vals.append(entry if str(kind).upper() == "AWS" else f"{kind}:{entry}")
            return vals, None
        return [], f"Principal was {type(block).__name__}"

    principals, err1 = flatten(item.get("Principal", item.get("principal")))
    not_principals, err2 = flatten(item.get("NotPrincipal", item.get("notPrincipal")))
    return principals, not_principals, err1 or err2


# ── Matching ─────────────────────────────────────────────────────────────────
def match_token(pattern: Optional[str], value: Optional[str]) -> bool:
    """Glob match with the GRANT as the pattern. Case-insensitive.

    Refuses rather than guesses when the pattern carries an unresolved policy
    variable: `arn:aws:s3:::${aws:username}-bucket` may or may not match a
    concrete bucket and claiming either is a fabrication.
    """
    if pattern is None or value is None:
        return False
    if has_variable(pattern):
        return False
    return fnmatch.fnmatchcase(value.lower(), pattern.lower())


def statement_matches_action(stmt: Statement, action: str) -> Tuple[bool, Optional[str]]:
    """Does this statement's action set contain `action`?

    Returns `(matched, matched_pattern)`. `NotAction` is handled as set
    negation — the statement applies when the action does NOT match any listed
    pattern — which is what the AWS evaluation model actually says.
    """
    if stmt.not_actions:
        if any(match_token(p, action) for p in stmt.not_actions):
            return False, None
        return True, f"NotAction ∌ {action}"
    for pattern in stmt.actions:
        if match_token(pattern, action):
            return True, pattern
    return False, None


def statement_matches_resource(stmt: Statement, resource: Optional[str]) -> Tuple[bool, Optional[str]]:
    """Does this statement's resource set contain `resource`?

    A `resource` of None means the caller is asking about the action in
    general. That matches any statement, and the caller is responsible for
    rendering the result as "on the resources this statement names" rather than
    as unconditional access.
    """
    if resource is None:
        if stmt.not_resources:
            return True, "NotResource (resource unspecified)"
        return True, (stmt.resources[0] if stmt.resources else "*")
    if stmt.not_resources:
        if any(match_token(p, resource) for p in stmt.not_resources):
            return False, None
        return True, f"NotResource ∌ {resource}"
    if not stmt.resources:
        # A statement with no Resource is only valid in a resource-based or
        # OCI-style policy, where the resource is implied by attachment.
        return True, "(implied by attachment)"
    for pattern in stmt.resources:
        if match_token(pattern, resource):
            return True, pattern
    return False, None


def statement_matches_principal(stmt: Statement, principal: Optional[str]) -> bool:
    """Whether a resource/trust policy statement applies to this principal."""
    if principal is None:
        return bool(stmt.principals or stmt.not_principals)
    if stmt.not_principals:
        return not any(match_token(p, principal) for p in stmt.not_principals)
    if not stmt.principals:
        return False
    return any(match_token(p, principal) for p in stmt.principals)


def expand_actions(statements: Sequence[Statement], *, effect: str = "Allow") -> List[str]:
    """Every action PATTERN granted (or denied) by these statements.

    Used to feed `capability.capabilities_covered`. A statement expressed with
    `NotAction` returns the UNBOUNDED sentinel, because its true action set is
    the whole namespace minus a few — reporting its listed exclusions as if
    they were its grants would invert the meaning of the most permissive
    statement shape there is.
    """
    want_deny = effect.strip().lower() == "deny"
    out: List[str] = []
    for stmt in statements:
        if stmt.is_deny != want_deny:
            continue
        if stmt.action_set_is_exclusionary:
            if UNBOUNDED not in out:
                out.append(UNBOUNDED)
            continue
        for action in stmt.actions:
            if action not in out:
                out.append(action)
    return out


def condition_summary(conditions: Any) -> Dict[str, Any]:
    """A renderable summary of a Condition block, plus the flags that matter.

    Conditions are NOT evaluated — this platform has no request context to
    evaluate them against — so every matched statement carrying one marks its
    decision `conditional`. What is extracted here is only what changes how a
    finding should be read: an MFA requirement, a source-IP restriction and an
    ExternalId are each the difference between a scoped grant and an open one.
    """
    if not isinstance(conditions, dict) or not conditions:
        return {"present": False}
    keys: List[str] = []
    for operator, block in conditions.items():
        if isinstance(block, dict):
            keys.extend(str(k) for k in block)
        else:
            keys.append(str(operator))
    lowered = [k.lower() for k in keys]
    return {
        "present": True,
        "operators": sorted({str(o) for o in conditions}),
        "keys": sorted(set(keys)),
        "requires_mfa": any("multifactorauthpresent" in k or "mfa" in k for k in lowered),
        "restricts_source_ip": any("sourceip" in k or "sourcevpce" in k
                                   or "vpcsourceip" in k for k in lowered),
        "requires_external_id": any("externalid" in k for k in lowered),
        "restricts_org": any("principalorgid" in k or "resourceorgid" in k
                             or "principalorgpaths" in k for k in lowered),
        "raw": conditions,
    }


def documents_to_statements(documents: Iterable[Any]) -> Tuple[List[Statement], List[str]]:
    """Parse several documents, collecting statements and parse errors.

    Errors are returned, never swallowed. A caller that drops them would turn
    an unreadable policy into an absent one.
    """
    statements: List[Statement] = []
    errors: List[str] = []
    for doc in documents or []:
        parsed, err = parse_document(doc)
        if err:
            errors.append(err)
            continue
        statements.extend(parsed)
    return statements, errors
