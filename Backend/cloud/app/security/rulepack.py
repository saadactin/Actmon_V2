"""Declarative security rules: the ones that are a predicate over a field.

Most of what a CSPM checks is one shape — *read a field, compare it, flag it*.
"Is default encryption on?" "Is public access blocked?" "Is the minimum TLS
version below 1.2?" Those do not need a Python function each; they need a
sentence each. This module lets them be written as YAML and compiled into the
same frozen `SecurityRule` objects `registry.py` builds by hand, so a YAML rule
and a Python rule are indistinguishable everywhere downstream: same dispatch,
same `rule_version`, same control mapping, same alert routing, same
suppression, same self-check.

**This is a hybrid on purpose, and the split is not laziness.** A rule that
walks relationships (a NIC's NSG, a subnet's security lists), does CIDR or port
interval arithmetic, or parses IAM policy statements stays in Python. A DSL
expressive enough for those stops being a DSL and becomes a worse programming
language with no debugger — and `registry.py`'s port-interval and IAM-policy
code is precisely where its hardest live bugs were found and fixed. What YAML
buys is the long tail: the hundreds of single-field checks that are real,
tedious, and currently unwritten because each one costs a function.

**The safety property is inherited, not reimplemented.** Every compiled
evaluator ends in `registry._flag_if`, and every boolean read goes through
`registry._bool_field`. That is deliberate: "an absent field is UNKNOWN, never
SAFE and never VULNERABLE" is the single most important invariant in this
package, and a second implementation of it here would eventually drift from the
first. One of those two copies would then be wrong, and nothing would say
which. So there is one copy, in `registry.py`, and this module calls it.

**Three-valued logic all the way down.** `all_of` is False if any check is
False, UNKNOWN if any is unknown, else True. `any_of` is True if any is True,
UNKNOWN if any is unknown, else False. This is Kleene logic, and getting it
wrong in the obvious way — treating unknown as false — would quietly convert
"we could not read this field" into "this resource is fine", which is the exact
failure mode the verdict vocabulary exists to prevent.

**Load-time validation is strict and fatal.** An unknown operator, a category
outside the closed set, a missing remediation: the pack refuses to load rather
than registering a rule that silently never fires or fires wrongly. That
matches `registry._selfcheck()`, and for the same reason — a broken rule whose
control reports PASS forever is worse than an import error.
"""
from __future__ import annotations

import pathlib
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

# The only import from the package that is safe at module scope: `model` has no
# dependency on `registry`, so this cannot close the import cycle the way
# importing `registry` here would.
from app.security.model import NOT_APPLICABLE

# Where the packs live. One file per provider/service keeps diffs readable and
# makes "which rules exist for S3?" a directory listing.
PACK_DIR = pathlib.Path(__file__).resolve().parent / "rules"

# Resolved once, lazily, at first evaluation — by which time `registry` has
# finished importing. A module-level import here would be circular: registry
# calls `load_all()` during its own import.
_REG = None


def _reg():
    global _REG
    if _REG is None:
        from app.security import registry as _r
        _REG = _r
    return _REG


# ── Path resolution ──────────────────────────────────────────────────────────
# A path is `<root>.<key>[.<key>...]`. Roots are the parts of a resource a rule
# is allowed to read; anything else is rejected at load time rather than
# resolving to None at evaluation time and looking like missing data.
_ROOTS = ("config", "raw", "tags", "metadata", "resource")

# Fields of the ORM row a rule may read directly. Deliberately short: a rule
# that needs more than this is reading infrastructure, not configuration.
_RESOURCE_FIELDS = (
    "status", "resource_name", "resource_type", "region_or_zone",
    "ip_address", "provider_resource_id",
)


def _root_object(ctx, root: str) -> Tuple[Any, bool]:
    if root == "config":
        return ctx.config, True
    if root == "raw":
        return ctx.raw, True
    if root == "tags":
        return ctx.tags, True
    if root == "metadata":
        return getattr(ctx.resource, "metadata_", None) or {}, True
    if root == "resource":
        return ctx.resource, True
    return None, False


def resolve(ctx, path: str) -> Tuple[Any, bool]:
    """(value, present). `present` False means the path does not exist.

    The distinction is the whole point: a field holding `None` and a field that
    was never collected look identical to `dict.get`, and only one of them is
    evidence of anything.
    """
    root, _, rest = path.partition(".")
    obj, ok = _root_object(ctx, root)
    if not ok:
        return None, False

    if root == "resource":
        if rest not in _RESOURCE_FIELDS:
            return None, False
        return getattr(obj, rest, None), hasattr(obj, rest)

    cur: Any = obj
    for part in rest.split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return None, False
            cur = cur[part]
        else:
            return None, False
    return cur, True


# ── Operators ────────────────────────────────────────────────────────────────
# Each returns Optional[bool]: None means "could not decide from this value".
# A closed set, validated at load time.


def _norm(v: Any) -> str:
    return str(v).strip().lower()


def _as_number(v: Any) -> Optional[float]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _needs_value(fn):
    """Wrap an operator so a null reading is UNKNOWN, not a comparison.

    Found by the equivalence test against the hand-written
    `AWS_S3_VERSIONING_DISABLED`, which returns UNKNOWN when `versioning` is
    present but null. Without this guard `not_equals: Enabled` stringified the
    null to "none", compared it to "enabled", and returned VULNERABLE — turning
    "the provider reported nothing" into a confirmed finding on every bucket
    whose versioning state failed to come back. That is the precise failure the
    verdict vocabulary exists to prevent, reintroduced one layer down.

    Operators that ask ABOUT nullness (`present`, `absent`, `is_null`,
    `is_not_null`) are deliberately not wrapped — for them a null is the answer,
    not the absence of one.
    """
    def run(actual, expected, present):
        if not present or actual is None:
            return None
        return fn(actual, expected, present)
    return run


@_needs_value
def _op_equals(actual, expected, present):
    if isinstance(expected, list):
        return any(_norm(actual) == _norm(e) for e in expected)
    return _norm(actual) == _norm(expected)


def _op_not_equals(actual, expected, present):
    r = _op_equals(actual, expected, present)
    return None if r is None else (not r)


def _op_is_true(actual, expected, present):
    # Through the registry's own tri-state reader, so "enabled"/"yes"/"1" are
    # handled exactly as they are for hand-written rules.
    if not present:
        return None
    return _reg()._bool_field({"_": actual}, "_")


def _op_is_false(actual, expected, present):
    r = _op_is_true(actual, expected, present)
    return None if r is None else (not r)


def _op_present(actual, expected, present):
    # Deliberately total: "is this field here at all?" is always answerable,
    # and a missing field is a definite False rather than an unknown.
    return bool(present and actual is not None)


def _op_absent(actual, expected, present):
    return not _op_present(actual, expected, present)


def _op_is_null(actual, expected, present):
    """Key collected, value null — tri-state, unlike `absent`.

    The difference between this and `absent` is the difference between a
    finding and a false positive, and it is worth being pedantic about.

    `absent` is True both when the provider reported "no NSG is attached"
    (null) and when the scanner never collected the field at all. Those look
    identical to `dict.get` and are opposite facts: the first is a real
    control gap, the second is a coverage gap. A rule built on `absent` works
    perfectly against today's scanner and turns into a false-positive
    generator the day that scanner stops writing the key — with nothing to
    say it had.

    So: key missing -> None (UNKNOWN, the engine records a coverage gap);
    key present and null -> True; key present with a value -> False.
    """
    if not present:
        return None
    return actual is None


def _op_is_not_null(actual, expected, present):
    r = _op_is_null(actual, expected, present)
    return None if r is None else (not r)


def _op_empty(actual, expected, present):
    if not present or actual is None:
        return None
    if isinstance(actual, (list, tuple, dict, str)):
        return len(actual) == 0
    return None


def _op_not_empty(actual, expected, present):
    r = _op_empty(actual, expected, present)
    return None if r is None else (not r)


@_needs_value
def _op_in(actual, expected, present):
    values = expected if isinstance(expected, list) else [expected]
    return any(_norm(actual) == _norm(e) for e in values)


def _op_not_in(actual, expected, present):
    r = _op_in(actual, expected, present)
    return None if r is None else (not r)


@_needs_value
def _op_contains(actual, expected, present):
    if isinstance(actual, (list, tuple)):
        return any(_norm(x) == _norm(expected) for x in actual)
    if isinstance(actual, str):
        return _norm(expected) in _norm(actual)
    return None


def _op_not_contains(actual, expected, present):
    r = _op_contains(actual, expected, present)
    return None if r is None else (not r)


def _numeric(cmp: Callable[[float, float], bool]):
    @_needs_value
    def run(actual, expected, present):
        a, b = _as_number(actual), _as_number(expected)
        if a is None or b is None:
            return None
        return cmp(a, b)
    return run


@_needs_value
def _op_matches(actual, expected, present):
    try:
        return re.search(str(expected), str(actual)) is not None
    except re.error:
        return None


def _op_not_matches(actual, expected, present):
    r = _op_matches(actual, expected, present)
    return None if r is None else (not r)


OPS: Dict[str, Callable[[Any, Any, bool], Optional[bool]]] = {
    "equals": _op_equals,
    "not_equals": _op_not_equals,
    "is_true": _op_is_true,
    "is_false": _op_is_false,
    "present": _op_present,
    "absent": _op_absent,
    "is_null": _op_is_null,
    "is_not_null": _op_is_not_null,
    "empty": _op_empty,
    "not_empty": _op_not_empty,
    "in": _op_in,
    "not_in": _op_not_in,
    "contains": _op_contains,
    "not_contains": _op_not_contains,
    "matches": _op_matches,
    "not_matches": _op_not_matches,
    "gt": _numeric(lambda a, b: a > b),
    "gte": _numeric(lambda a, b: a >= b),
    "lt": _numeric(lambda a, b: a < b),
    "lte": _numeric(lambda a, b: a <= b),
}

# Operators that need no `value:` key. Everything else must declare one, or the
# rule is comparing against None and will never fire.
_VALUELESS = frozenset({
    "is_true", "is_false", "present", "absent", "is_null", "is_not_null",
    "empty", "not_empty",
})


# ── Compilation ──────────────────────────────────────────────────────────────

Predicate = Callable[[Any], Optional[bool]]


def _compile_check(node: Dict[str, Any], where: str) -> Predicate:
    path = node.get("path")
    op = node.get("op")
    if not path or not isinstance(path, str):
        raise ValueError(f"{where}: check needs a string 'path'")
    if path.partition(".")[0] not in _ROOTS:
        raise ValueError(
            f"{where}: path {path!r} must start with one of {list(_ROOTS)}"
        )
    if path.partition(".")[0] == "resource" and path.partition(".")[2] not in _RESOURCE_FIELDS:
        raise ValueError(
            f"{where}: resource path {path!r} must be one of {list(_RESOURCE_FIELDS)}"
        )
    if op not in OPS:
        raise ValueError(f"{where}: unknown op {op!r}; known: {sorted(OPS)}")
    if op not in _VALUELESS and "value" not in node:
        raise ValueError(f"{where}: op {op!r} needs a 'value'")

    fn = OPS[op]
    expected = node.get("value")

    def run(ctx) -> Optional[bool]:
        actual, present = resolve(ctx, path)
        return fn(actual, expected, present)

    return run


def _compile_node(node: Any, where: str) -> Predicate:
    """A check, or a boolean combination of them, in three-valued logic."""
    if not isinstance(node, dict):
        raise ValueError(f"{where}: expected a mapping, got {type(node).__name__}")

    combinators = [k for k in ("all_of", "any_of", "none_of") if k in node]
    if len(combinators) > 1:
        raise ValueError(f"{where}: {combinators} are mutually exclusive")

    if not combinators:
        return _compile_check(node, where)

    kind = combinators[0]
    children = node[kind]
    if not isinstance(children, list) or not children:
        raise ValueError(f"{where}: {kind} needs a non-empty list")
    subs = [_compile_node(c, f"{where}.{kind}[{i}]") for i, c in enumerate(children)]

    def run(ctx) -> Optional[bool]:
        results = [s(ctx) for s in subs]
        if kind == "all_of":
            if any(r is False for r in results):
                return False
            return None if any(r is None for r in results) else True
        if kind == "any_of":
            if any(r is True for r in results):
                return True
            return None if any(r is None for r in results) else False
        # none_of: the negation of any_of, with unknown preserved.
        if any(r is True for r in results):
            return False
        return None if any(r is None for r in results) else True

    return run


def _compile_evidence(spec: Optional[Dict[str, str]], where: str):
    """Field paths to attach to the finding, so it quotes what it read."""
    if spec is None:
        return lambda ctx: {}
    if not isinstance(spec, dict):
        raise ValueError(f"{where}: 'evidence' must be a mapping of name -> path")
    for name, path in spec.items():
        if not isinstance(path, str) or path.partition(".")[0] not in _ROOTS:
            raise ValueError(
                f"{where}: evidence {name!r} path {path!r} must start with one of {list(_ROOTS)}"
            )

    def run(ctx) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for name, path in spec.items():
            value, present = resolve(ctx, path)
            # Absent fields are recorded as a marker rather than omitted, so a
            # reader can tell "this was null" from "this was never collected".
            out[name] = value if present else None
            if not present:
                out[f"{name}__collected"] = False
        return out

    return run


def _build_evaluator(doc: Dict[str, Any], rid: str):
    detection = _compile_node(doc["detection"], f"{rid}.detection")
    applies = (
        _compile_node(doc["applies_when"], f"{rid}.applies_when")
        if doc.get("applies_when") else None
    )
    evidence_of = _compile_evidence(doc.get("evidence"), rid)
    unknown_reason = doc.get("unknown_reason") or (
        f"The configuration this rule reads was not collected for this resource."
    )
    detail = doc.get("detail") or ""

    def evaluate(ctx):
        reg = _reg()
        if applies is not None:
            ok = applies(ctx)
            if ok is False:
                return reg.Outcome(verdict=NOT_APPLICABLE)
            if ok is None:
                # Cannot tell whether the rule even applies. Reporting that is
                # honest; assuming it applies would invent a finding and
                # assuming it does not would hide one.
                return reg._unknown(
                    doc.get("applies_unknown_reason")
                    or "Could not determine whether this rule applies to this resource.",
                    **evidence_of(ctx),
                )
        return reg._flag_if(
            detection(ctx),
            unknown_reason=unknown_reason,
            detail=detail,
            **evidence_of(ctx),
        )

    return evaluate


_REQUIRED = ("rule_id", "version", "provider", "resource_types", "title",
             "severity", "category", "description", "rationale", "remediation",
             "detection")


def compile_rule(doc: Dict[str, Any], make_rule, source: str):
    """One YAML mapping -> one `SecurityRule`. Raises on anything malformed."""
    missing = [k for k in _REQUIRED if not doc.get(k)]
    if missing:
        raise ValueError(f"{source}: rule is missing {missing}")

    rid = doc["rule_id"]
    types = doc["resource_types"]
    if not isinstance(types, list) or not types:
        raise ValueError(f"{rid}: resource_types must be a non-empty list")

    extras = set(doc) - {
        *_REQUIRED, "confidence", "coverage", "references", "evidence", "detail",
        "applies_when", "unknown_reason", "applies_unknown_reason", "aggregate",
    }
    if extras:
        # A typo'd key is a rule that does not do what its author wrote.
        raise ValueError(f"{rid}: unknown keys {sorted(extras)}")

    return make_rule(
        rule_id=rid,
        version=str(doc["version"]),
        provider=doc["provider"],
        resource_types=tuple(types),
        title=doc["title"],
        severity=doc["severity"],
        category=doc["category"],
        description=doc["description"],
        rationale=doc["rationale"],
        remediation=doc["remediation"],
        evaluate=_build_evaluator(doc, rid),
        confidence=doc.get("confidence", "HIGH"),
        coverage=doc.get("coverage"),
        aggregate=bool(doc.get("aggregate", False)),
    )


def load_all(make_rule, directory: Optional[pathlib.Path] = None) -> List[Any]:
    """Every rule in every pack, compiled. Order is deterministic by filename.

    A pack that fails to parse or compile raises rather than being skipped:
    silently loading 40 of 41 rules is how a control ends up reporting PASS
    because its rule was never registered.
    """
    directory = directory or PACK_DIR
    if not directory.is_dir():
        return []

    out: List[Any] = []
    seen: Dict[str, str] = {}
    for path in sorted(directory.glob("*.yaml")):
        try:
            docs = yaml.safe_load(path.read_text(encoding="utf-8")) or []
        except yaml.YAMLError as exc:
            raise RuntimeError(f"{path.name}: YAML is not parseable: {exc}") from exc
        if not isinstance(docs, list):
            raise RuntimeError(f"{path.name}: expected a list of rules at the top level")
        for doc in docs:
            if not isinstance(doc, dict):
                raise RuntimeError(f"{path.name}: every entry must be a mapping")
            rid = doc.get("rule_id", "<missing rule_id>")
            if rid in seen:
                raise RuntimeError(
                    f"{path.name}: duplicate rule_id {rid!r} (already in {seen[rid]})"
                )
            try:
                out.append(compile_rule(doc, make_rule, path.name))
            except ValueError as exc:
                raise RuntimeError(f"{path.name}: {exc}") from exc
            seen[rid] = path.name
    return out


def pack_summary() -> Dict[str, Any]:
    """What is declared where — for the rule-catalog endpoint and for tests."""
    directory = PACK_DIR
    files: List[Dict[str, Any]] = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.yaml")):
            docs = yaml.safe_load(path.read_text(encoding="utf-8")) or []
            files.append({
                "file": path.name,
                "rules": [d.get("rule_id") for d in docs if isinstance(d, dict)],
                "count": len(docs),
            })
    return {
        "directory": str(directory),
        "files": files,
        "total": sum(f["count"] for f in files),
        "operators": sorted(OPS),
        "roots": list(_ROOTS),
    }
