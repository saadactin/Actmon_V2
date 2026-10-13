"""CIEM vocabulary and the capability mapper: the properties that decide truth.

No database, no network. Each property pinned here is one where getting it
wrong puts a false statement about someone's access in front of an operator.

The headline is **the direction of the glob match**. `security/identity.py`
records what happened when it was backwards: `fnmatch(action, "*")` asks "does
the string `*/read` match the pattern `*`", which is true of every string, and
the built-in **Reader** role was reported as "full control over the entire
subscription" with a privilege-escalation path, on 23 live assignments. Section
A exists so that cannot come back, and it tests the production function rather
than a local re-implementation of it — the lesson already recorded twice in
this codebase, where a test helper re-derived the rule it was checking and
passed over a real bug.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from datetime import datetime, timedelta, timezone  # noqa: E402

from app.identity import capability as cap  # noqa: E402
from app.identity import model as m  # noqa: E402

ok, fail = [], []


def check(label, condition):
    (ok if condition else fail).append(label)
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")


def eq(label, actual, expected):
    condition = actual == expected
    (ok if condition else fail).append(label)
    print(f"  {'PASS' if condition else 'FAIL'}  {label}")
    if not condition:
        print(f"        expected {expected!r}")
        print(f"        actual   {actual!r}")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Glob direction: the grant is the pattern, never the string ===")
# ═════════════════════════════════════════════════════════════════════════════
# The regression. Reader's only action is `*/read`; it must cover nothing
# privileged. Owner is `*`; it must cover everything.
eq("Azure Reader (*/read) confers NO high-impact capability",
   cap.high_impact_covered(m.AZURE, ["*/read"]), [])
check("Azure Owner (*) confers every high-impact capability",
      len(cap.high_impact_covered(m.AZURE, ["*"])) == len(m.HIGH_IMPACT_CAPABILITIES))
check("AWS ReadOnly-shaped grant (s3:Get*) confers no IAM administration",
      m.CAP_IAM_ADMINISTRATION not in cap.capabilities_covered(m.AWS, ["s3:Get*"]))

# The argument order of `covers` IS the guard. Pin it explicitly.
check("covers(grant='s3:*', op='s3:GetObject') is True",
      cap.covers(m.AWS, "s3:*", "s3:GetObject"))
check("covers(grant='s3:GetObject', op='s3:*') is False — the reverse must not hold",
      not cap.covers(m.AWS, "s3:GetObject", "s3:*"))
check("covers(grant='*/read', op='Microsoft.Authorization/roleAssignments/write') "
      "is False",
      not cap.covers(m.AZURE, "*/read",
                     "Microsoft.Authorization/roleAssignments/write"))

# A custom role must be caught by what it DOES, not by a name anyone recognises.
eq("a custom role carrying Microsoft.Authorization/* is caught as IAM administration",
   cap.high_impact_covered(m.AZURE, ["Microsoft.Authorization/*"]),
   [m.CAP_IAM_ADMINISTRATION])
check("a custom role named 'Reader-Plus' with roleAssignments/write is still caught",
      m.CAP_IAM_ADMINISTRATION in cap.capabilities_covered(
          m.AZURE, ["*/read", "Microsoft.Authorization/roleAssignments/write"]))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Full control is matched exactly, never by coverage ===")
# ═════════════════════════════════════════════════════════════════════════════
check("'*' is full control on AWS", cap.is_full_control(m.AWS, ["*"]))
check("'*' is full control on Azure", cap.is_full_control(m.AZURE, ["*"]))
check("'manage all-resources' is full control on OCI",
      cap.is_full_control(m.OCI, ["manage all-resources"]))
check("a grant covering every probe is NOT full control",
      not cap.is_full_control(m.AWS, ["iam:*", "s3:*", "ec2:*", "kms:*"]))
check("Reader is not full control", not cap.is_full_control(m.AZURE, ["*/read"]))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. OCI verbs are ranked, and all-resources is the family wildcard ===")
# ═════════════════════════════════════════════════════════════════════════════
check("manage covers read on the same family",
      cap.covers(m.OCI, "manage:object-family", "read:object-family"))
check("read does NOT cover manage on the same family",
      not cap.covers(m.OCI, "read:object-family", "manage:object-family"))
check("manage all-resources covers any family",
      cap.covers(m.OCI, "manage:all-resources", "manage:database-family"))
check("read all-resources does not cover manage on a family",
      not cap.covers(m.OCI, "read:all-resources", "manage:database-family"))
check("the policy-language spelling parses identically to the colon form",
      cap.covers(m.OCI, "manage object-family", "read:object-family"))
eq("read object-family is storage read, not storage delete",
   sorted(cap.capabilities_covered(m.OCI, ["read object-family"])),
   [m.CAP_STORAGE_READ])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. classify_action answers about CONCRETE actions only ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("s3:DeleteObject classifies as STORAGE_DELETE",
   cap.classify_action(m.AWS, "s3:DeleteObject"), m.CAP_STORAGE_DELETE)
eq("cloudtrail:StopLogging classifies as LOGGING_CONFIGURATION",
   cap.classify_action(m.AWS, "cloudtrail:StopLogging"), m.CAP_LOGGING_CONFIGURATION)
eq("iam:CreateAccessKey classifies as CREDENTIAL_CREATION",
   cap.classify_action(m.AWS, "iam:CreateAccessKey"), m.CAP_CREDENTIAL_CREATION)
# A wildcard is not one capability — it is several, which is covers()'s question.
eq("a wildcard grant returns OTHER rather than claiming one capability",
   cap.classify_action(m.AWS, "s3:*"), m.CAP_OTHER)
eq("an unknown provider classifies as OTHER rather than guessing",
   cap.classify_action("GCP", "storage.objects.delete"), m.CAP_OTHER)
# The long tail still lands somewhere useful via the shape heuristic.
eq("an action outside the probe catalog uses the shape heuristic",
   cap.classify_action(m.AWS, "ec2:DeleteNetworkAclEntry"), m.CAP_NETWORK_ADMINISTRATION)
eq("Azure operations are classified by namespace and verb",
   cap.classify_action(m.AZURE, "Microsoft.KeyVault/vaults/keys/delete/action"),
   m.CAP_KEY_MANAGEMENT)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. Missing data never becomes a reassuring value (§35) ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("worst_privilege of an EMPTY set is UNKNOWN, not READ_ONLY",
   m.worst_privilege([]), m.PRIV_UNKNOWN)
eq("worst_privilege picks the highest of several",
   m.worst_privilege([m.PRIV_READ_ONLY, m.PRIV_ADMIN, m.PRIV_STANDARD]), m.PRIV_ADMIN)
check("PRIV_UNKNOWN is not in the set treated as privileged",
      m.PRIV_UNKNOWN not in (m.PRIV_ADMIN, m.PRIV_PRIVILEGED))
eq("days_between with a missing date is None, not 0",
   m.days_between(None, datetime.now(timezone.utc)), None)
eq("days_between with both dates returns whole days",
   m.days_between(datetime(2026, 1, 1, tzinfo=timezone.utc),
                  datetime(2026, 1, 11, tzinfo=timezone.utc)), 10)

check("MFA_UNKNOWN is NOT in the at-risk set",
      m.MFA_UNKNOWN not in m.MFA_STATES_AT_RISK)
check("MFA_NOT_APPLICABLE is NOT in the at-risk set",
      m.MFA_NOT_APPLICABLE not in m.MFA_STATES_AT_RISK)
eq("MFA_DISABLED is the only at-risk MFA state",
   sorted(m.MFA_STATES_AT_RISK), [m.MFA_DISABLED])

check("ALLOWED_UNVERIFIED counts as permissive for reachability",
      m.ALLOWED_UNVERIFIED in m.DECISIONS_PERMISSIVE)
check("IMPLICIT_DENY is not permissive",
      m.IMPLICIT_DENY not in m.DECISIONS_PERMISSIVE)
check("NOT_DETERMINED is not permissive",
      m.NOT_DETERMINED not in m.DECISIONS_PERMISSIVE)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. Usage states: only one may seed a removal proposal ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("only NOT_OBSERVED_HIGH_CONFIDENCE may be proposed for removal",
   sorted(m.USAGE_SAFE_TO_PROPOSE), [m.USAGE_NOT_OBSERVED_HIGH])
check("USAGE_UNKNOWN may not be proposed for removal",
      m.USAGE_UNKNOWN not in m.USAGE_SAFE_TO_PROPOSE)
check("USAGE_NOT_OBSERVED_LOW may not be proposed for removal",
      m.USAGE_NOT_OBSERVED_LOW not in m.USAGE_SAFE_TO_PROPOSE)
check("every usage state has a meaning sentence for the UI",
      all(m.USAGE_MEANING.get(s) for s in m.USAGE_STATES))
check("no usage state is spelled 'UNUSED'",
      not any("UNUSED" in s for s in m.USAGE_STATES))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. Decision carries what was NOT evaluated ===")
# ═════════════════════════════════════════════════════════════════════════════
certain = m.Decision(decision=m.ALLOWED, action="s3:GetObject")
check("a Decision with no gaps is certain", certain.certain)
uncertain = m.Decision(
    decision=m.ALLOWED_UNVERIFIED, action="s3:GetObject",
    unevaluated=[m.Unevaluated(stage=m.STAGE_SCP, reason=m.UNEVAL_NOT_COLLECTED)])
check("a Decision with an unevaluated stage is NOT certain", not uncertain.certain)
check("both are permissive — reachability must include the unverified case",
      certain.permissive and uncertain.permissive)
payload = uncertain.to_dict()
check("to_dict exposes certain=False so the UI cannot render it as certain",
      payload["certain"] is False)
check("to_dict names the stage that was skipped",
      payload["unevaluated"][0]["stage"] == m.STAGE_SCP)
check("every stage has a human label",
      all(m.STAGE_LABEL.get(s) for s in m.STAGE_LABEL))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== H. Identity keys are stable and provider-scoped ===")
# ═════════════════════════════════════════════════════════════════════════════
k1 = m.identity_key(provider="AWS", account_id="acct-1",
                    identity_type=m.AWS_IAM_ROLE, provider_id="arn:aws:iam::1:role/a")
k2 = m.identity_key(provider="aws", account_id="acct-1",
                    identity_type=m.AWS_IAM_ROLE, provider_id="arn:aws:iam::1:role/a")
eq("the key is stable across provider spelling", k1, k2)
k3 = m.identity_key(provider="AWS", account_id="acct-2",
                    identity_type=m.AWS_IAM_ROLE, provider_id="arn:aws:iam::1:role/a")
check("the same ARN in a different account is a different key", k1 != k3)
k4 = m.identity_key(provider="AWS", account_id="acct-1",
                    identity_type=m.AWS_IAM_USER, provider_id="arn:aws:iam::1:role/a")
check("the same id with a different type is a different key", k1 != k4)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== I. Actor class decides whether MFA is even a question ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("an AWS IAM user defaults to HUMAN",
   m.DEFAULT_ACTOR_CLASS[m.AWS_IAM_USER], m.ACTOR_HUMAN)
eq("an Azure managed identity defaults to WORKLOAD",
   m.DEFAULT_ACTOR_CLASS[m.AZURE_MANAGED_IDENTITY], m.ACTOR_WORKLOAD)
eq("an OCI dynamic group defaults to WORKLOAD (it matches instances, not people)",
   m.DEFAULT_ACTOR_CLASS[m.OCI_DYNAMIC_GROUP], m.ACTOR_WORKLOAD)
eq("a group is its own class, not a human",
   m.DEFAULT_ACTOR_CLASS[m.AWS_IAM_GROUP], m.ACTOR_GROUP)
check("every identity type has a default actor class",
      all(t in m.DEFAULT_ACTOR_CLASS for t in m.IDENTITY_TYPES))
check("every identity type has a human label",
      all(m.IDENTITY_TYPE_LABEL.get(t) for t in m.IDENTITY_TYPES))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== J. The capability vocabulary is complete and self-describing ===")
# ═════════════════════════════════════════════════════════════════════════════
check("every capability has a label",
      all(m.CAPABILITY_LABEL.get(c) for c in m.CAPABILITIES))
check("every high-impact capability explains WHY it is high impact",
      all(m.HIGH_IMPACT_WHY.get(c) for c in m.HIGH_IMPACT_CAPABILITIES))
check("every high-impact capability is in the capability set",
      all(c in m.CAPABILITIES for c in m.HIGH_IMPACT_CAPABILITIES))
for provider in (m.AWS, m.AZURE, m.OCI):
    probes = cap.PROBES_BY_PROVIDER[provider]
    missing = [c for c in m.CAPABILITIES if c != m.CAP_OTHER and c not in probes]
    eq(f"{provider}: every capability has at least one probe operation", missing, [])
    empty = [c for c, ops in probes.items() if not ops]
    eq(f"{provider}: no capability has an empty probe list", empty, [])

# Data-plane blind spots must be declared for every provider, because they are
# the reason LOW confidence exists.
check("every provider declares its data-plane blind spots",
      all(m.DATA_PLANE_BLIND.get(p) for p in (m.AWS, m.AZURE, m.OCI)))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== K. meta() serves the whole vocabulary to the UI ===")
# ═════════════════════════════════════════════════════════════════════════════
meta = m.meta()
for key in ("identity_types", "actor_classes", "mfa_states", "decisions", "stages",
            "capabilities", "privilege_levels", "usage_states", "dormancy_states",
            "credential_kinds", "external_states", "data_plane_blind_spots"):
    check(f"meta() exposes {key}", key in meta and meta[key])
check("meta() marks which usage states may seed a removal proposal",
      any(u["may_propose_removal"] for u in meta["usage_states"]))
check("meta() marks exactly one usage state as proposable",
      len([u for u in meta["usage_states"] if u["may_propose_removal"]]) == 1)
check("meta() flags the high-impact capabilities",
      len([c for c in meta["capabilities"] if c["high_impact"]])
      == len(m.HIGH_IMPACT_CAPABILITIES))

catalog = cap.catalog()
check("the capability catalog covers all three providers",
      set(catalog["providers"]) == {m.AWS, m.AZURE, m.OCI})
check("the catalog states the OCI verb order",
      catalog["oci_verb_order"] == list(cap.OCI_VERBS))

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
