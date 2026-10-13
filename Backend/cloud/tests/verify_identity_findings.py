"""CIEM findings, their registry declarations, and the authorization boundary.

No database, no network. Three things are pinned here, each guarding a failure
this codebase has already seen a version of:

**One finding engine, not two.** The Cloud Overview once carried a second,
independent security engine that scored the same account 0/F while the real one
said 35/F. CIEM findings therefore use the Security Center's canonical model,
its fingerprinting and its registry — and section B checks that the analyser's
rule ids and the registry's declarations agree in BOTH directions, so neither a
rule nobody declared nor a declaration nothing emits can ship.

**A partial producer must not resolve a whole account.** `persist_findings`
resolves anything it does not see. The identity analyser emits only
`IDENTITY_*` rules, so calling it without a rule scope would close every
storage, network and encryption finding on the account — the same shape as the
partial scan that once pruned 62 live OCI resources. Section D pins the scope
parameter that prevents it.

**Missing data is never a clean result.** An identity whose policies could not
be read produces an UNKNOWN-verdict coverage finding, and an unreported MFA
state produces a coverage finding rather than an MFA failure.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import inspect  # noqa: E402
import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from datetime import datetime, timedelta, timezone  # noqa: E402

from app.api import rbac  # noqa: E402
from app.identity import findings as cf  # noqa: E402
from app.identity.model import (  # noqa: E402
    ACTOR_HUMAN, ACTOR_WORKLOAD, AWS, DORMANCY_DORMANT, EXTERNAL_ANONYMOUS,
    EXTERNAL_YES, MFA_DISABLED, MFA_ENABLED, MFA_NOT_APPLICABLE, MFA_UNKNOWN,
    PRIV_ADMIN, PRIV_PRIVILEGED, PRIV_READ_ONLY, PRIV_UNKNOWN,
)
from app.security import controls as ctl  # noqa: E402
from app.security import registry as reg  # noqa: E402
from app.security.model import (  # noqa: E402
    CAT_GOVERNANCE, CAT_IAM, CATEGORIES, CRITICAL, HIGH, LOW, MEDIUM, SEVERITIES,
    UNKNOWN, VULNERABLE,
)

ok, fail = [], []
NOW = datetime(2026, 10, 3, tzinfo=timezone.utc)
ACCOUNT = "11111111-1111-1111-1111-111111111111"


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


def identity(**overrides):
    base = {
        "identity_key": "key-1", "provider_id": "arn:aws:iam::1:user/alice",
        "name": "alice", "principal_name": "alice",
        "identity_type": "AWS_IAM_USER", "actor_class": ACTOR_HUMAN,
        "privilege_level": PRIV_READ_ONLY, "mfa_state": MFA_ENABLED,
        "standing_admin": False, "potential_break_glass": False,
        "external": "INTERNAL", "last_used_at": None, "scope": None,
        "broadest_scope_level": None, "active_credential_count": 0,
    }
    base.update(overrides)
    return base


def rule_ids(result):
    return sorted({f.rule_id for f in result})


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Every CIEM rule is declared, and every declaration is emitted ===")
# ═════════════════════════════════════════════════════════════════════════════
missing = [r for r in cf.RULE_IDS if r not in reg.RULES]
eq("every analyser rule id exists in the registry", missing, [])

declared = [r for r in reg.RULES if r.startswith("IDENTITY_")]
orphaned = [r for r in declared if r not in cf.RULE_IDS]
eq("every IDENTITY_* registry rule is one the analyser can emit", orphaned, [])

eq("the counts match", len(cf.RULE_IDS), len(declared))
check("rule ids are unique", len(set(cf.RULE_IDS)) == len(cf.RULE_IDS))

for rid in cf.RULE_IDS:
    rule = reg.RULES[rid]
    check(f"{rid}: is synthetic (produced by an analyser, not a per-resource rule)",
          rule.synthetic)
    check(f"{rid}: has no evaluator", rule.evaluate is None)
    check(f"{rid}: severity is in the closed set", rule.severity in SEVERITIES)
    check(f"{rid}: category is in the closed set", rule.category in CATEGORIES)
    check(f"{rid}: has a real remediation", len(rule.remediation or "") >= 40)
    check(f"{rid}: has a rationale", bool((rule.rationale or "").strip()))
    check(f"{rid}: counts toward a coverage dimension", bool(rule.coverage))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Findings carry the registry's rationale and remediation ===")
# ═════════════════════════════════════════════════════════════════════════════
result = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(privilege_level=PRIV_ADMIN, mfa_state=MFA_DISABLED)],
)
mfa_finding = next(f for f in result
                   if f.rule_id == cf.PRIVILEGED_IDENTITY_WITHOUT_MFA)
check("the finding carries a rationale from the registry",
      len(mfa_finding.rationale) > 40)
check("and a remediation from the registry", len(mfa_finding.remediation) > 40)
eq("it matches the registry text exactly",
   mfa_finding.remediation, reg.RULES[cf.PRIVILEGED_IDENTITY_WITHOUT_MFA].remediation)
check("the fingerprint is set", bool(mfa_finding.fingerprint))
check("the evidence names the privilege level and MFA state",
      mfa_finding.evidence.get("privilege_level") == PRIV_ADMIN
      and mfa_finding.evidence.get("mfa_state") == MFA_DISABLED)

# Fingerprints are stable across runs and distinct per identity.
again = cf.analyse(provider=AWS, account_id=ACCOUNT,
                   identities=[identity(privilege_level=PRIV_ADMIN,
                                        mfa_state=MFA_DISABLED)])
eq("the fingerprint is stable across runs",
   mfa_finding.fingerprint,
   next(f for f in again
        if f.rule_id == cf.PRIVILEGED_IDENTITY_WITHOUT_MFA).fingerprint)
other = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(identity_key="key-2",
                         provider_id="arn:aws:iam::1:user/bob", name="bob",
                         privilege_level=PRIV_ADMIN, mfa_state=MFA_DISABLED)])
check("a different identity gets a different fingerprint",
      mfa_finding.fingerprint !=
      next(f for f in other
           if f.rule_id == cf.PRIVILEGED_IDENTITY_WITHOUT_MFA).fingerprint)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. MFA findings respect actor class and the unknown state ===")
# ═════════════════════════════════════════════════════════════════════════════
workload = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(actor_class=ACTOR_WORKLOAD, mfa_state=MFA_NOT_APPLICABLE,
                         privilege_level=PRIV_PRIVILEGED)])
check("a workload with N/A MFA produces NO MFA finding",
      cf.PRIVILEGED_IDENTITY_WITHOUT_MFA not in rule_ids(workload))

unknown_mfa = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(mfa_state=MFA_UNKNOWN, privilege_level=PRIV_ADMIN)])
check("an UNKNOWN MFA state produces NO MFA failure finding",
      cf.PRIVILEGED_IDENTITY_WITHOUT_MFA not in rule_ids(unknown_mfa))
check("it produces a COVERAGE finding instead",
      cf.MFA_STATE_UNKNOWN in rule_ids(unknown_mfa))
coverage = next(f for f in unknown_mfa if f.rule_id == cf.MFA_STATE_UNKNOWN)
eq("the coverage finding's verdict is UNKNOWN, not VULNERABLE",
   coverage.verdict, UNKNOWN)

unprivileged = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(mfa_state=MFA_DISABLED, privilege_level=PRIV_READ_ONLY)])
check("a read-only human without MFA is not a PRIVILEGED-without-MFA finding",
      cf.PRIVILEGED_IDENTITY_WITHOUT_MFA not in rule_ids(unprivileged))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. An unassessable identity is a coverage gap, never a clean row ===")
# ═════════════════════════════════════════════════════════════════════════════
unassessed = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(privilege_level=PRIV_UNKNOWN, mfa_state=MFA_DISABLED)])
check("an unassessable identity produces the coverage finding",
      cf.POLICIES_NOT_EVALUATED in rule_ids(unassessed))
gap = next(f for f in unassessed if f.rule_id == cf.POLICIES_NOT_EVALUATED)
eq("its verdict is UNKNOWN", gap.verdict, UNKNOWN)
check("it names the identities it could not assess",
      gap.evidence.get("count") == 1)
check("an unassessable identity produces NO privilege findings",
      not any(r in rule_ids(unassessed) for r in
              (cf.STANDING_ADMIN_ACCESS, cf.OVERLY_BROAD_ROLE,
               cf.PRIVILEGED_IDENTITY_WITHOUT_MFA)))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. The remaining rules fire on the conditions they describe ===")
# ═════════════════════════════════════════════════════════════════════════════
standing = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(privilege_level=PRIV_ADMIN, standing_admin=True)])
check("standing admin access is reported",
      cf.STANDING_ADMIN_ACCESS in rule_ids(standing))

broad = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(actor_class=ACTOR_WORKLOAD, privilege_level=PRIV_ADMIN,
                         mfa_state=MFA_NOT_APPLICABLE)])
check("an administrative workload is reported as overly broad",
      cf.OVERLY_BROAD_ROLE in rule_ids(broad))

dormant = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(privilege_level=PRIV_ADMIN)],
    dormancy_by_identity={"key-1": {"state": DORMANCY_DORMANT,
                                    "days_since_use": 174, "threshold_days": 90}},
)
check("a dormant privileged identity is reported",
      cf.DORMANT_PRIVILEGED_IDENTITY in rule_ids(dormant))
dormant_finding = next(f for f in dormant
                       if f.rule_id == cf.DORMANT_PRIVILEGED_IDENTITY)
check("the evidence carries the threshold that was applied",
      dormant_finding.evidence.get("threshold_days") == 90)

creds = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[identity()],
    credentials_by_identity={"key-1": [
        {"credential_ref": "AKIA1", "credential_kind": "AWS_ACCESS_KEY",
         "signals": ["UNUSED_90D", "OLD_CREDENTIAL"], "recommendation": "DISABLE",
         "recommendation_reason": "Not used in 120 days."},
    ]},
)
check("a stale credential is reported", cf.STALE_ACCESS_KEY in rule_ids(creds))

never_cred = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[identity()],
    credentials_by_identity={"key-1": [
        {"credential_ref": "AKIA2", "credential_kind": "AWS_ACCESS_KEY",
         "signals": ["NEVER_USED"], "recommendation": "DELETE"},
    ]},
)
check("a never-used credential gets its own rule",
      cf.NEVER_USED_CREDENTIAL in rule_ids(never_cred))

unused = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[identity()],
    usage_by_identity={"key-1": {
        "removal_candidates": ["ec2:TerminateInstances"],
        "window": {"days": 90, "events_in_window": 500000},
        "granted_pattern_count": 12, "observed_action_count": 3,
        "unexercised_pattern_count": 9, "high_confidence_unexercised_count": 1,
    }},
)
check("unused permissions are reported", cf.UNUSED_PERMISSION in rule_ids(unused))
unused_finding = next(f for f in unused if f.rule_id == cf.UNUSED_PERMISSION)
check("the finding carries its observation window",
      unused_finding.evidence["window"]["days"] == 90)
check("and the number of events analysed",
      unused_finding.evidence["window"]["events_in_window"] == 500000)
check("and states that only high-confidence grants are listed",
      "insufficient" in (unused_finding.evidence.get("note") or "").lower())

blast = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[identity()],
    blast_by_identity={"key-1": {"score": 82.0, "score_band": "CRITICAL",
                                 "direct_resources": 120, "indirect_resources": 30,
                                 "inventory_complete": True}},
)
check("a high blast radius is reported",
      cf.HIGH_BLAST_RADIUS_IDENTITY in rule_ids(blast))

withheld = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[identity()],
    blast_by_identity={"key-1": {"score": None, "score_band": None,
                                 "direct_resources": 3,
                                 "inventory_complete": False}},
)
check("a WITHHELD blast score produces no finding — it is not a small one",
      cf.HIGH_BLAST_RADIUS_IDENTITY not in rule_ids(withheld))

bg = cf.analyse(
    provider=AWS, account_id=ACCOUNT,
    identities=[identity(potential_break_glass=True,
                         break_glass_signals=[{"signal": "NAME", "detail": "x"}])])
bg_finding = next(f for f in bg if f.rule_id == cf.UNMONITORED_BREAK_GLASS)
check("a break-glass finding says POTENTIAL in its evidence",
      "POTENTIAL" in (bg_finding.evidence.get("note") or ""))
check("and its title does not assert the designation",
      "looks like" in bg_finding.title.lower())

trust = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[],
    trust_edges=[{"external": EXTERNAL_ANONYMOUS, "target_key": "arn:role/X",
                  "target_name": "X", "source_principal": "*",
                  "risk_factors": [{"factor": "ANY_PRINCIPAL"}]}],
)
check("a wildcard trust is CRITICAL",
      any(f.severity == CRITICAL and f.rule_id == cf.ANONYMOUS_TRUST for f in trust))

ext = cf.analyse(
    provider=AWS, account_id=ACCOUNT, identities=[],
    trust_edges=[{"external": EXTERNAL_YES, "target_key": "arn:role/Y",
                  "target_name": "Y", "source_principal": "arn:aws:iam::999:root",
                  "target_privilege": PRIV_ADMIN,
                  "risk_factors": [{"factor": "NO_EXTERNAL_ID"}]}],
)
check("an external principal reaching a privileged role is reported",
      cf.EXTERNAL_PRIVILEGED_PRINCIPAL in rule_ids(ext))
check("a missing ExternalId gets its own finding",
      cf.CROSS_ACCOUNT_TRUST_NO_EXTERNAL_ID in rule_ids(ext))

clean = cf.analyse(provider=AWS, account_id=ACCOUNT, identities=[identity()])
eq("a clean, fully-assessed identity produces no findings", clean, [])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. Persistence is scoped so a partial producer cannot resolve "
      "another analyser's findings ===")
# ═════════════════════════════════════════════════════════════════════════════
from app.repository.security_repo import SecurityRepository  # noqa: E402

sig = inspect.signature(SecurityRepository.persist_findings)
check("persist_findings accepts a rule_scope", "rule_scope" in sig.parameters)
eq("and it defaults to None (whole-account reconciliation) for existing callers",
   sig.parameters["rule_scope"].default, None)

from app.services.identity_service import IdentityService  # noqa: E402

source = inspect.getsource(IdentityService._persist_findings)
check("the identity analyser passes a rule_scope", "rule_scope=" in source)
check("and scopes it to the CIEM rule ids", "RULE_IDS" in source)
check("it gates resolution on whether the analysis was complete",
      "ASSESS_COMPLETE" in source and "ASSESS_PARTIAL" in source)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. Authorization: the identity surface is graduated ===")
# ═════════════════════════════════════════════════════════════════════════════
viewer = rbac.ROLE_PERMISSIONS[rbac.ROLE_VIEWER]
analyst = rbac.ROLE_PERMISSIONS[rbac.ROLE_ANALYST]
admin = rbac.ROLE_PERMISSIONS[rbac.ROLE_ADMIN]
audit = rbac.ROLE_PERMISSIONS[rbac.ROLE_AUDIT_ADMIN]

check("a viewer can see the identity picture", rbac.IDENTITY_VIEW in viewer)
check("a viewer can raise a request", rbac.IDENTITY_REQUEST in viewer)
check("a viewer CANNOT read policy documents", rbac.IDENTITY_VIEW_RAW not in viewer)
check("a viewer CANNOT run a reverse query", rbac.IDENTITY_QUERY not in viewer)
check("a viewer CANNOT approve", rbac.IDENTITY_APPROVE not in viewer)
check("a viewer CANNOT apply", rbac.IDENTITY_APPLY not in viewer)
check("a viewer CANNOT run collection", rbac.IDENTITY_ANALYZE not in viewer)

check("an analyst can read policy documents", rbac.IDENTITY_VIEW_RAW in analyst)
check("an analyst can run the permission explorer", rbac.IDENTITY_QUERY in analyst)
check("an analyst CANNOT approve", rbac.IDENTITY_APPROVE not in analyst)
check("an analyst CANNOT apply", rbac.IDENTITY_APPLY not in analyst)

for permission in (rbac.IDENTITY_VIEW, rbac.IDENTITY_VIEW_RAW, rbac.IDENTITY_QUERY,
                   rbac.IDENTITY_ANALYZE, rbac.IDENTITY_REQUEST,
                   rbac.IDENTITY_APPROVE, rbac.IDENTITY_APPLY, rbac.IDENTITY_AUDIT):
    check(f"an administrator holds {permission}", permission in admin)
    check(f"an audit admin holds {permission}", permission in audit)

# Approving and applying are separate grants, so no single permission can both
# bless and execute a privilege change.
check("approve and apply are distinct permissions",
      rbac.IDENTITY_APPROVE != rbac.IDENTITY_APPLY)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== H. Writing to a provider is off by default ===")
# ═════════════════════════════════════════════════════════════════════════════
import os  # noqa: E402

from app.services import identity_workflow_service as wf  # noqa: E402

saved = os.environ.pop("CIEM_ENABLE_WRITE", None)
try:
    check("execution is disabled when the switch is unset", not wf.write_enabled())
    mode = wf.write_mode()
    check("the mode is reported to the UI", mode["enabled"] is False)
    check("and names the switch that would enable it",
          mode["env_var"] == "CIEM_ENABLE_WRITE")
    os.environ["CIEM_ENABLE_WRITE"] = "true"
    check("it can be switched on explicitly", wf.write_enabled())
    os.environ["CIEM_ENABLE_WRITE"] = "false"
    check("and off again", not wf.write_enabled())
finally:
    os.environ.pop("CIEM_ENABLE_WRITE", None)
    if saved is not None:
        os.environ["CIEM_ENABLE_WRITE"] = saved

from app.services import jit_expiry_scheduler as jit  # noqa: E402

saved_jit = os.environ.pop("CIEM_JIT_EXPIRY_ENABLED", None)
try:
    check("the JIT expiry loop is ON by default — its job is to REMOVE access",
          jit.scheduler_enabled())
finally:
    if saved_jit is not None:
        os.environ["CIEM_JIT_EXPIRY_ENABLED"] = saved_jit

check("a JIT duration cap exists", wf.MAX_JIT_MINUTES <= 8 * 60)
source_apply = inspect.getsource(wf.IdentityWorkflowService.apply)
check("apply refuses without an explicit confirmation", "confirm" in source_apply)
check("apply refuses a request that is not APPROVED", "APPROVED" in source_apply)
source_decide = inspect.getsource(wf.IdentityWorkflowService.decide)
check("a requester cannot approve their own request",
      "requested_by" in source_decide)

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
