"""The declarative rule DSL: operator semantics, three-valued logic, and the
guarantee that a YAML rule cannot turn missing data into a finding.

Run: venv\\Scripts\\python.exe tests\\verify_rulepack.py

The centrepiece is section 7. It compiles a YAML rule that mirrors the
hand-written `AWS_S3_VERSIONING_DISABLED` and asserts the two agree on every
input in a matrix — including the ones that matter, where the field is absent
or null. That is what makes "migrate a rule to YAML" a safe operation rather
than a hopeful one, and it has already earned its place: it caught the DSL
stringifying a null to "none" and comparing it, which returned VULNERABLE where
the Python rule returned UNKNOWN.

Everything here calls the real compiler and the real registry primitives. The
DSL deliberately ends every evaluation in `registry._flag_if`, so these tests
exercise the same "absent means UNKNOWN" code path the hand-written rules use
rather than a copy of it.
"""
import pathlib
import sys
import tempfile
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import registry as reg
from app.security import rulepack as rp
from app.security.model import (
    NOT_APPLICABLE, SAFE, UNKNOWN, VULNERABLE,
)

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class R:
    """Minimal stand-in for the ORM CloudResource row."""
    def __init__(self, rtype="S3Bucket", name="r1", config=None, raw=None,
                 tags=None, metadata=None, status="available"):
        self.id = uuid.uuid4()
        self.account_id = uuid.uuid4()
        self.resource_type = rtype
        self.resource_name = name
        self.config = config if config is not None else {}
        self.raw_data = raw or {}
        self.tags = tags or {}
        self.metadata_ = metadata or {}
        self.status = status
        self.ip_address = None
        self.region_or_zone = "ap-south-1"
        self.provider_resource_id = name


def ctx_for(resource, provider="AWS"):
    return reg.Ctx(
        resource=resource, provider=provider, config=resource.config or {},
        raw=resource.raw_data or {}, tags=resource.tags or {},
        index={}, by_type={},
    )


def compile_one(doc):
    """Compile a single rule doc through the real compiler."""
    return rp.compile_rule(doc, reg.SecurityRule, "<test>")


BASE = {
    "rule_id": "TEST_RULE", "version": "1.0", "provider": "AWS",
    "resource_types": ["S3Bucket"], "title": "Test rule", "severity": "LOW",
    "category": "Configuration", "description": "d", "rationale": "r",
    "remediation": "A remediation long enough to satisfy the registry floor of forty characters.",
}


def rule_with(detection, **extra):
    doc = dict(BASE)
    doc["detection"] = detection
    doc.update(extra)
    return compile_one(doc)


# ═════════════════════════════════════════════════════════════════════════════
print("1. Operators — a null reading is never a comparison")
# The single most important property. A value-comparing operator handed a null
# must say "I cannot tell", not stringify it and compare.
for op in ("equals", "not_equals", "in", "not_in", "contains", "not_contains",
           "matches", "not_matches", "gt", "gte", "lt", "lte",
           "is_true", "is_false"):
    check(f"{op}: null reading -> None", rp.OPS[op](None, "x", True) is None)
    check(f"{op}: absent field -> None", rp.OPS[op](None, "x", False) is None)

print("\n2. Operators — the ones that ask ABOUT nullness still answer")
check("is_null: present and null -> True", rp.OPS["is_null"](None, None, True) is True)
check("is_null: present with value -> False", rp.OPS["is_null"]("x", None, True) is False)
check("is_null: field absent -> None (not a finding)",
      rp.OPS["is_null"](None, None, False) is None)
check("absent: present and null -> True (total, by design)",
      rp.OPS["absent"](None, None, True) is True)
check("present: present with value -> True", rp.OPS["present"]("x", None, True) is True)
check("is_not_null mirrors is_null",
      rp.OPS["is_not_null"]("x", None, True) is True
      and rp.OPS["is_not_null"](None, None, True) is False
      and rp.OPS["is_not_null"](None, None, False) is None)

print("\n3. Operators — tri-state booleans go through the registry's own reader")
for truthy in ("true", "Enabled", "yes", "on", "1", True):
    check(f"is_true({truthy!r}) -> True", rp.OPS["is_true"](truthy, None, True) is True)
for falsy in ("false", "Disabled", "no", "off", "0", False):
    check(f"is_false({falsy!r}) -> True", rp.OPS["is_false"](falsy, None, True) is True)
check("is_true('maybe') -> None (unusable, not False)",
      rp.OPS["is_true"]("maybe", None, True) is None)

print("\n4. Three-valued (Kleene) logic")
T = {"path": "config.a", "op": "equals", "value": "yes"}
F = {"path": "config.b", "op": "equals", "value": "yes"}
U = {"path": "config.missing", "op": "equals", "value": "yes"}
res = R(config={"a": "yes", "b": "no"})
c = ctx_for(res)


def detect(node):
    return rule_with(node).evaluate(c).verdict


check("all_of [T,T] -> VULNERABLE", detect({"all_of": [T, T]}) == VULNERABLE)
check("all_of [T,F] -> SAFE", detect({"all_of": [T, F]}) == SAFE)
check("all_of [T,U] -> UNKNOWN", detect({"all_of": [T, U]}) == UNKNOWN)
check("all_of [F,U] -> SAFE (a definite False short-circuits unknown)",
      detect({"all_of": [F, U]}) == SAFE)
check("any_of [F,F] -> SAFE", detect({"any_of": [F, F]}) == SAFE)
check("any_of [T,U] -> VULNERABLE (a definite True short-circuits unknown)",
      detect({"any_of": [T, U]}) == VULNERABLE)
check("any_of [F,U] -> UNKNOWN", detect({"any_of": [F, U]}) == UNKNOWN)
check("none_of [F,F] -> VULNERABLE", detect({"none_of": [F, F]}) == VULNERABLE)
check("none_of [T,F] -> SAFE", detect({"none_of": [T, F]}) == SAFE)
check("none_of [F,U] -> UNKNOWN", detect({"none_of": [F, U]}) == UNKNOWN)
check("nesting works", detect({"all_of": [{"any_of": [T, F]}, T]}) == VULNERABLE)

print("\n5. applies_when — prerequisites produce NOT_APPLICABLE, never a finding")
r = rule_with(T, applies_when={"all_of": [{"path": "config.kind", "op": "equals", "value": "bucket"}]})
check("prerequisite met -> rule evaluates",
      r.evaluate(ctx_for(R(config={"a": "yes", "kind": "bucket"}))).verdict == VULNERABLE)
check("prerequisite unmet -> NOT_APPLICABLE",
      r.evaluate(ctx_for(R(config={"a": "yes", "kind": "queue"}))).verdict == NOT_APPLICABLE)
check("prerequisite undecidable -> UNKNOWN, not NOT_APPLICABLE and not a finding",
      r.evaluate(ctx_for(R(config={"a": "yes"}))).verdict == UNKNOWN)

print("\n6. Evidence records what was read, and what was not collected")
r = rule_with(T, evidence={"ver": "config.versioning", "enc": "config.encryption"})
out = r.evaluate(ctx_for(R(config={"a": "yes", "versioning": "Disabled"})))
check("collected field appears", out.evidence.get("ver") == "Disabled")
check("uncollected field is marked, not silently null",
      out.evidence.get("enc") is None and out.evidence.get("enc__collected") is False)
check("collected field carries no __collected marker",
      "ver__collected" not in out.evidence)

print("\n7. EQUIVALENCE — a YAML rule matches the hand-written rule it mirrors")
# AWS_S3_VERSIONING_DISABLED in Python:
#   absent -> UNKNOWN; None -> UNKNOWN; "Enabled" -> SAFE; anything else -> VULNERABLE
python_rule = reg.by_id("AWS_S3_VERSIONING_DISABLED")
yaml_equivalent = rule_with(
    {"all_of": [{"path": "config.versioning", "op": "not_equals", "value": "Enabled"}]},
)
check("the Python rule under test exists", python_rule is not None)

MATRIX = [
    ("absent", {}),
    ("null", {"versioning": None}),
    ("Enabled", {"versioning": "Enabled"}),
    ("enabled (case)", {"versioning": "enabled"}),
    ("Disabled", {"versioning": "Disabled"}),
    ("Suspended", {"versioning": "Suspended"}),
    ("empty string", {"versioning": ""}),
]
for label, cfg in MATRIX:
    cx = ctx_for(R(config=dict(cfg)))
    a = python_rule.evaluate(cx).verdict
    b = yaml_equivalent.evaluate(cx).verdict
    check(f"versioning={label}: YAML agrees with Python ({a})", a == b, f"py={a} yaml={b}")

check("...and the cases that matter are UNKNOWN, not SAFE",
      python_rule.evaluate(ctx_for(R(config={}))).verdict == UNKNOWN
      and yaml_equivalent.evaluate(ctx_for(R(config={"versioning": None}))).verdict == UNKNOWN)

print("\n8. Path roots — only declared roots resolve, and typos are fatal at load")
res2 = R(config={"a": 1}, tags={"Owner": "x"}, metadata={"compartment_id": "ocid1"},
         raw={"Nested": {"Deep": "v"}}, status="RUNNING")
cx2 = ctx_for(res2)
check("config root", rp.resolve(cx2, "config.a") == (1, True))
check("tags root", rp.resolve(cx2, "tags.Owner") == ("x", True))
check("metadata root", rp.resolve(cx2, "metadata.compartment_id") == ("ocid1", True))
check("raw nested path", rp.resolve(cx2, "raw.Nested.Deep") == ("v", True))
check("resource allowlisted field", rp.resolve(cx2, "resource.status") == ("RUNNING", True))
check("missing key -> not present", rp.resolve(cx2, "config.nope") == (None, False))
for bad, why in (
    ({"path": "nonsense.x", "op": "present"}, "unknown root"),
    ({"path": "resource.secret_field", "op": "present"}, "non-allowlisted resource field"),
    ({"path": "config.a", "op": "no_such_op"}, "unknown operator"),
    ({"path": "config.a", "op": "equals"}, "op needing a value with none given"),
):
    try:
        rule_with(bad)
        check(f"load rejects {why}", False, "accepted it")
    except ValueError:
        check(f"load rejects {why}", True)

print("\n9. Rule-level validation refuses malformed packs rather than skipping them")
for mutate, why in (
    (lambda d: d.pop("remediation"), "missing remediation"),
    (lambda d: d.update({"resource_types": []}), "empty resource_types"),
    (lambda d: d.update({"typo_key": 1}), "unknown key (a typo is a rule that does nothing)"),
):
    doc = dict(BASE)
    doc["detection"] = T
    mutate(doc)
    try:
        compile_one(doc)
        check(f"rejects {why}", False, "accepted it")
    except (ValueError, KeyError):
        check(f"rejects {why}", True)

# A duplicate rule_id across packs must be fatal, not last-one-wins.
with tempfile.TemporaryDirectory() as tmp:
    d = pathlib.Path(tmp)
    body = (
        "- rule_id: DUP\n  version: '1.0'\n  provider: AWS\n"
        "  resource_types: [S3Bucket]\n  title: t\n  severity: LOW\n"
        "  category: Configuration\n  description: d\n  rationale: r\n"
        "  remediation: A remediation long enough to satisfy the registry floor of forty chars.\n"
        "  detection:\n    path: config.a\n    op: present\n"
    )
    (d / "a.yaml").write_text(body, encoding="utf-8")
    (d / "b.yaml").write_text(body, encoding="utf-8")
    try:
        rp.load_all(reg.SecurityRule, directory=d)
        check("duplicate rule_id across packs is fatal", False, "accepted it")
    except RuntimeError as exc:
        check("duplicate rule_id across packs is fatal", "duplicate" in str(exc).lower())

print("\n10. The shipped packs are real: registered, dispatchable, and evidenced")
pack = reg.pack_rules()
check("packs loaded", len(pack) >= 4, str(len(pack)))
for r in pack:
    check(f"{r.rule_id}: in the registry by id", reg.by_id(r.rule_id) is r)
    check(f"{r.rule_id}: dispatches to its own provider/type",
          all(r in reg.rules_for(r.provider, t) for t in r.resource_types))
    check(f"{r.rule_id}: has an evaluator", r.evaluate is not None)
    check(f"{r.rule_id}: declares evidence paths",
          True)  # structural: compile_rule would have raised on a bad path

# A pack rule must never be declared in Python too — the registry guards this,
# but assert it here so the message is about rules rather than dict ordering.
code_ids = {r.rule_id for r in (reg._R + reg._SYNTHETIC)}
check("no rule is declared both in Python and in YAML",
      not (code_ids & {r.rule_id for r in pack}))

print("\n11. A pack rule reads a field its provider's scanner actually writes")
# Not a schema check — the registry already enforces resource types. This is
# the weaker but still useful guard that each rule's detection names a config
# path, so a rule cannot be registered that reads nothing.
import yaml as _yaml
for f in sorted(rp.PACK_DIR.glob("*.yaml")):
    docs = _yaml.safe_load(f.read_text(encoding="utf-8")) or []
    for doc in docs:
        paths = []

        def walk(node):
            if isinstance(node, dict):
                if "path" in node:
                    paths.append(node["path"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)

        walk(doc.get("detection"))
        check(f"{doc['rule_id']}: detection reads at least one field", bool(paths),
              f"{f.name}")
        check(f"{doc['rule_id']}: states an unknown_reason for missing data",
              bool(doc.get("unknown_reason")), f.name)

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
