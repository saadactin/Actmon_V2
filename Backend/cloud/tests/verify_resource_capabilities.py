"""Provider capability matrix, cross-checked against the real provider classes.

Run: venv\\Scripts\\python.exe tests\\verify_resource_capabilities.py

A capability flag is a claim about code somewhere else. Left unchecked it rots
the first time a provider method is added or removed, and the rot is invisible
until a user clicks something that then fails. Section 1 walks the actual
classes and fails on any disagreement.

Section 2 is the one that must never quietly flip. Nothing in app/providers/
implements a single write call, so every mutating capability is False. The
moment one appears, this suite says so rather than letting a Delete button ship
ahead of the permission check, the dependency check and the audit trail that
spec §39-§44 require around it.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import resource_capabilities as caps

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


print("1. THE REGISTRY AGREES WITH THE CODE IT DESCRIBES")
problems = caps.verify_against_implementation()
check("no capability disagrees with its provider class", not problems,
      "; ".join(problems[:3]))

print("\n2. NO WRITE PATH IS CLAIMED, BECAUSE NONE EXISTS")
for provider in ("AWS", "AZURE", "OCI"):
    c = caps.for_provider(provider)
    for capability in (caps.TAG_MUTATION, caps.POWER_ACTIONS, caps.DELETE):
        check(f"{provider} does not claim {capability}", not c.can(capability))
    check(f"{provider} explains why, naming the missing layer",
          "action layer" in (c.reason(caps.POWER_ACTIONS) or ""),
          c.reason(caps.POWER_ACTIONS) or "")

print("\n3. AWS PER-RESOURCE COST MUST STAY UNAVAILABLE")
# Cost Explorer has no per-resource dimension. Reporting this as "no data"
# would read as "these AWS resources cost nothing".
aws = caps.for_provider("AWS")
check("AWS cannot answer per-resource cost", not aws.can(caps.RESOURCE_COST))
reason = aws.reason(caps.RESOURCE_COST) or ""
check("...the reason names Cost Explorer", "Cost Explorer" in reason)
check("...names what WOULD answer it", "Cost and Usage Report" in reason)
check("...and does not imply AWS cost is broken",
      "service level" in reason, reason)
check("AWS account-level cost IS available", aws.can(caps.ACCOUNT_COST))

for provider in ("AZURE", "OCI"):
    c = caps.for_provider(provider)
    check(f"{provider} CAN answer per-resource cost", c.can(caps.RESOURCE_COST))
    check(f"...so it has no reason attached", c.reason(caps.RESOURCE_COST) is None)

print("\n4. AWS memory metrics are honestly unavailable")
check("AWS has no memory metrics", not aws.can(caps.MEMORY_METRICS))
check("...because the guest agent is not installed, which is stated",
      "CloudWatch agent" in (aws.reason(caps.MEMORY_METRICS) or ""))

print("\n5. A mixed scope intersects to the weakest provider")
shared = caps.intersect(["AWS", "OCI"])
check("per-resource cost is unavailable when AWS is in scope",
      shared[caps.RESOURCE_COST] is False)
shared = caps.intersect(["AZURE", "OCI"])
check("...and available when it is not", shared[caps.RESOURCE_COST] is True)
shared = caps.intersect(["OCI"])
check("a single capable provider keeps its capability",
      shared[caps.RESOURCE_COST] is True)

blocked = caps.unsupported_in_scope(["AWS", "AZURE", "OCI"], caps.RESOURCE_COST)
check("the blocker is named", len(blocked) == 1 and blocked[0]["provider"] == "AWS",
      str(blocked))
check("...with its reason travelling alongside", bool(blocked[0]["reason"]))

print("\n6. An empty or unknown scope claims nothing")
check("an empty scope supports nothing",
      not any(caps.intersect([]).values()))
unknown = caps.for_provider("GoogleCloud")
check("an unrecognized provider supports nothing",
      not any(unknown.supported.values()))
check("...and says it is unrecognized rather than unsupported",
      "not recognized" in (unknown.reason(caps.DISCOVERY) or ""))
check("None does not raise", caps.for_provider(None).provider == "UNKNOWN")
check("case is irrelevant", caps.for_provider("oci").provider == "OCI")

print("\n7. Every capability is renderable")
for provider in ("AWS", "AZURE", "OCI"):
    payload = caps.for_provider(provider).as_dict()
    keys = {c["key"] for c in payload["capabilities"]}
    check(f"{provider} reports every capability", keys == set(caps.CAPABILITY_ORDER))
    unlabelled = [c for c in payload["capabilities"] if not c["label"]]
    check(f"{provider}: every capability has a label", not unlabelled)
    silent = [
        c for c in payload["capabilities"]
        if not c["supported"] and not c["reason"]
    ]
    check(f"{provider}: no capability is refused without a reason", not silent,
          str([c['key'] for c in silent]))

print("\n8. The scope summary is complete")
summary = caps.scope_summary(["AWS", "Azure", "OCI"])
check("one entry per provider", len(summary["providers"]) == 3)
check("providers are normalized and sorted",
      [p["provider"] for p in summary["providers"]] == ["AWS", "AZURE", "OCI"])
check("the shared list covers every capability",
      {c["key"] for c in summary["shared"]} == set(caps.CAPABILITY_ORDER))
resource_cost = next(c for c in summary["shared"] if c["key"] == caps.RESOURCE_COST)
check("a blocked shared capability names who blocks it",
      [b["provider"] for b in resource_cost["blocked_by"]] == ["AWS"],
      str(resource_cost["blocked_by"]))

print("\n9. Duplicate providers do not change the answer")
check("listing OCI twice is the same as once",
      caps.intersect(["OCI", "OCI"]) == caps.intersect(["OCI"]))
check("blank entries are ignored",
      caps.intersect(["OCI", "", None]) == caps.intersect(["OCI"]))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
