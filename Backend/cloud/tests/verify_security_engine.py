"""The unified engine: scoring, compliance mapping, exposure, thresholds, scale.

No database, no network. Everything here is a pure function of a resource list,
which is what makes these assertions cheap enough to be exhaustive.

The four properties this file exists to pin down, each because its absence was
a real defect:

**The score must discriminate.** The old model was `100 - Σweights`, uncapped.
On the live estate every populated account scored 0/F and the only A was the
account with zero resources. So: bounds, per-category caps, and an explicit
assertion that 1000 LOW governance findings cannot outrank one CRITICAL.

**Missing data must not score well.** The first run of this engine gave the
Azure Production Account 100/A at 26.8% coverage, because all 154 of its
findings were UNKNOWN and UNKNOWN correctly scores nothing. Coverage now
withholds the score, and that is asserted here.

**One finding, many citations.** Compliance must never duplicate a finding per
framework — the original bug that made all three framework tiles show identical
counts.

**A threshold must actually threshold.** 4 findings against a threshold of 5
produces no alert; 5 produces one; 6 produces the same one.
"""
import pathlib
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.models.security_finding import (  # noqa: E402
    THRESHOLD_ANY_NEW, THRESHOLD_CONSECUTIVE, THRESHOLD_DURATION,
    THRESHOLD_FINDING_COUNT, THRESHOLD_PERCENTAGE, THRESHOLD_RESOURCE_COUNT,
    THRESHOLD_SCORE_BELOW,
)
from app.security import compliance as comp  # noqa: E402
from app.security import controls as ctl  # noqa: E402
from app.security import engine  # noqa: E402
from app.security import exposure as exp  # noqa: E402
from app.security import identity as ident  # noqa: E402
from app.security import policies as pol  # noqa: E402
from app.security import scoring  # noqa: E402
from app.security.model import (  # noqa: E402
    ACTIVE_FINDING_STATUSES, ASSESS_COMPLETE, ASSESS_PARTIAL, AWS, AZURE,
    CAT_EXPOSURE, CAT_GOVERNANCE, CAT_IAM, CONF_HIGH, CONF_LOW, CONF_UNKNOWN,
    CRITICAL, EXPOSED, EXPOSURE_UNKNOWN, HIGH, INFO, LOW, MEDIUM, OCI, OPEN,
    PROTECTED, SecurityFinding, SUPPRESSED, UNKNOWN, VULNERABLE, fingerprint,
)

ok, fail = [], []
NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


# ── Fixtures ─────────────────────────────────────────────────────────────────

ACCOUNT = str(uuid.uuid4())


class Res:
    def __init__(self, rtype, name="r", *, config=None, raw=None, tags=None,
                 status=None, ip=None, key=None):
        self.id = uuid.uuid4()
        self.account_id = uuid.UUID(ACCOUNT)
        self.provider_resource_id = key or f"id-{name}-{rtype}"
        self.resource_type = rtype
        self.resource_name = name
        self.region_or_zone = "r1"
        self.status = status
        self.ip_address = ip
        self.config = config if config is not None else {}
        self.raw_data = raw
        self.tags = tags if tags is not None else {"Name": name, "Environment": "p",
                                                   "Owner": "o"}
        self.updated_at = NOW
        self.discovered_at = NOW


def finding(severity=HIGH, category=CAT_EXPOSURE, *, verdict=VULNERABLE,
            confidence=CONF_HIGH, rule_id="EXPOSURE_PORT_WORLD_OPEN",
            status=OPEN, count=1, first=None, detections=1, evidence=None,
            resource="res"):
    return SecurityFinding(
        rule_id=rule_id, rule_version="1.0", provider=AWS, account_id=ACCOUNT,
        fingerprint=fingerprint(provider=AWS, account_id=ACCOUNT, rule_id=rule_id,
                                resource_key=resource,
                                discriminator=str(uuid.uuid4())),
        resource_key=resource, resource_name=resource, resource_type="EC2Instance",
        title=f"{rule_id} on {resource}", description="d", rationale="r",
        remediation="m", severity=severity, category=category, verdict=verdict,
        confidence=confidence, status=status, affected_count=count,
        first_detected_at=first or NOW, last_detected_at=NOW,
        evidence=evidence or {},
    )


class Row:
    """A stored finding row, for the policy engine (which reads detection_count
    and first_detected_at from the persisted row, not the in-memory finding)."""

    def __init__(self, f, detections=1, first=None):
        for k in ("fingerprint", "rule_id", "rule_version", "provider", "severity",
                  "category", "verdict", "confidence", "status", "title",
                  "description", "resource_key", "resource_name", "resource_type",
                  "evidence", "compliance", "affected_count"):
            setattr(self, k, getattr(f, k, None))
        self.resource_id = None
        self.detection_count = detections
        self.first_detected_at = first or NOW


class Policy:
    def __init__(self, **kw):
        self.id = uuid.uuid4()
        self.policy_key = kw.get("policy_key")
        self.name = kw.get("name", "p")
        self.enabled = kw.get("enabled", True)
        self.builtin = False
        self.account_id = kw.get("account_id")
        self.providers = kw.get("providers")
        self.rule_ids = kw.get("rule_ids")
        self.categories = kw.get("categories")
        self.resource_types = kw.get("resource_types")
        self.min_severity = kw.get("min_severity")
        self.ports = kw.get("ports")
        self.match_verdicts = kw.get("match_verdicts")
        self.threshold_kind = kw.get("threshold_kind", THRESHOLD_ANY_NEW)
        self.threshold_value = kw.get("threshold_value", 1)
        self.alert_severity = kw.get("alert_severity")
        self.cooldown_minutes = kw.get("cooldown_minutes", 60)
        self.notify = kw.get("notify", True)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §80 Score is always bounded ===")
# ═════════════════════════════════════════════════════════════════════════════

cases = {
    "no findings": [],
    "1 critical": [finding(CRITICAL)],
    "10 critical": [finding(CRITICAL, resource=f"r{i}") for i in range(10)],
    "100 critical": [finding(CRITICAL, resource=f"r{i}") for i in range(100)],
    "1000 low governance": [
        finding(LOW, CAT_GOVERNANCE, rule_id="GOVERNANCE_MISSING_OWNERSHIP_TAGS",
                resource=f"g{i}") for i in range(1000)
    ],
    "mixed": ([finding(CRITICAL)] * 3 + [finding(HIGH)] * 10
              + [finding(MEDIUM)] * 25 + [finding(LOW)] * 50),
    "everything at once": [
        finding(sev, cat, resource=f"{sev}{cat}{i}")
        for sev in (CRITICAL, HIGH, MEDIUM, LOW, INFO)
        for cat in (CAT_EXPOSURE, CAT_IAM, CAT_GOVERNANCE)
        for i in range(20)
    ],
}
for label, findings in cases.items():
    s = scoring.compute(findings, coverage_pct=100.0, resources_evaluated=100)
    check(f"{label}: 0 <= score <= 100",
          s.score is not None and 0 <= s.score <= 100, f"score={s.score}")
    check(f"{label}: total deduction never exceeds 100",
          s.total_deduction <= 100.0001, f"{s.total_deduction}")

eq("no findings -> 100", scoring.compute([], coverage_pct=100.0,
                                         resources_evaluated=10).score, 100)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §5 The score must discriminate ===")
# ═════════════════════════════════════════════════════════════════════════════

a = scoring.compute([finding(CRITICAL, resource=f"c{i}") for i in range(11)]
                    + [finding(HIGH, resource=f"h{i}") for i in range(10)],
                    coverage_pct=100.0, resources_evaluated=200)
b = scoring.compute([finding(MEDIUM, resource=f"m{i}") for i in range(25)],
                    coverage_pct=100.0, resources_evaluated=200)
check("Account A (11 CRITICAL + 10 HIGH) and Account B (25 MEDIUM) differ",
      a.score != b.score, f"A={a.score}/{a.grade} B={b.score}/{b.grade}")
check("the account with 11 CRITICAL scores worse",
      a.score < b.score, f"A={a.score} B={b.score}")
check("neither is 0/F (the old model gave both 0/F)",
      not (a.score == 0 and b.score == 0), f"A={a.score} B={b.score}")

gov = scoring.compute(
    [finding(LOW, CAT_GOVERNANCE, rule_id="GOVERNANCE_MISSING_OWNERSHIP_TAGS",
             resource=f"g{i}") for i in range(550)],
    coverage_pct=100.0, resources_evaluated=550)
one_crit = scoring.compute([finding(CRITICAL, CAT_EXPOSURE)],
                           coverage_pct=100.0, resources_evaluated=550)
check("550 missing tags score better than ONE critical exposure",
      gov.score > one_crit.score, f"tags={gov.score} crit={one_crit.score}")
gov_line = next((c for c in gov.breakdown if c.category == CAT_GOVERNANCE), None)
check("governance is capped at its 5-point budget",
      gov_line and gov_line.deduction <= 5.0001, str(gov_line))


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Score exclusions ===")
# ═════════════════════════════════════════════════════════════════════════════

s = scoring.compute([finding(CRITICAL, verdict=UNKNOWN, confidence=CONF_UNKNOWN)],
                    coverage_pct=100.0, resources_evaluated=10)
eq("an UNKNOWN CRITICAL does not move the score", s.score, 100)
eq("...and is counted as excluded", s.unscored.get("undetermined"), 1)

s = scoring.compute([finding(CRITICAL, confidence=CONF_LOW)],
                    coverage_pct=100.0, resources_evaluated=10)
eq("a LOW-confidence CRITICAL does not move the score", s.score, 100)
eq("...and is counted as excluded", s.unscored.get("low_confidence"), 1)

s = scoring.compute([finding(CRITICAL, "Cost")], coverage_pct=100.0,
                    resources_evaluated=10)
eq("a Cost finding does not move the score", s.score, 100)
eq("...and is counted as excluded", s.unscored.get("non_security_category"), 1)

s = scoring.compute([finding(INFO)], coverage_pct=100.0, resources_evaluated=10)
eq("an INFO finding does not move the score", s.score, 100)

s = scoring.compute([finding(CRITICAL, status=SUPPRESSED)], coverage_pct=100.0,
                    resources_evaluated=10)
eq("a SUPPRESSED CRITICAL does not move the score", s.score, 100)
eq("...and is counted as excluded",
   s.unscored.get("suppressed_or_accepted"), 1)

# The breakdown must add up, or it teaches the reader the number is arbitrary.
s = scoring.compute([finding(CRITICAL, CAT_EXPOSURE), finding(HIGH, CAT_IAM),
                     finding(MEDIUM, CAT_GOVERNANCE)],
                    coverage_pct=100.0, resources_evaluated=10)
summed = sum(c.deduction for c in s.breakdown)
check("the breakdown lines sum to the reported total",
      abs(summed - s.total_deduction) < 0.01, f"{summed} vs {s.total_deduction}")
eq("100 - total == score", 100 - round(s.total_deduction), s.score)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §87 Missing data must never score well ===")
# ═════════════════════════════════════════════════════════════════════════════

# The Azure Production Account case: many findings, all undetermined, low
# coverage. The first version of this engine gave it 100/A.
undetermined = [finding(MEDIUM, verdict=UNKNOWN, confidence=CONF_UNKNOWN,
                        resource=f"u{i}") for i in range(50)]
s = scoring.compute(undetermined, coverage_pct=26.8, resources_evaluated=275)
eq("26.8% coverage -> no score is reported", s.score, None)
eq("...and the grade says why, not 'A'", s.grade, scoring.GRADE_INSUFFICIENT)
check("...and it is marked unreliable", s.reliable is False)
check("...with a reason naming the coverage", "26.8" in (s.grade_capped_by or ""))

s = scoring.compute([], coverage_pct=None, resources_evaluated=0)
eq("zero resources -> no score", s.score, None)
eq("...and the grade is 'Not assessed', not 'A'", s.grade, scoring.GRADE_NOT_ASSESSED)

# A subject count above zero is enough to score, even with no inventory: the
# never-scanned TOR2 subscription has 24 collected role assignments.
s = scoring.compute([finding(CRITICAL, CAT_IAM)], coverage_pct=50.0,
                    resources_evaluated=24)
check("identity-only account does get a score", s.score is not None, str(s.score))
eq("...but the grade is capped by coverage", s.grade, "C")

s = scoring.compute([], coverage_pct=75.0, resources_evaluated=100)
eq("75% coverage with no findings caps the grade at B", s.grade, "B")
check("...and marks it unreliable", s.reliable is False)
s = scoring.compute([], coverage_pct=95.0, resources_evaluated=100)
eq("95% coverage with no findings is a clean A", s.grade, "A")
check("...and is reliable", s.reliable is True)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Grade ceilings ===")
# ═════════════════════════════════════════════════════════════════════════════

s = scoring.compute([finding(CRITICAL, CAT_GOVERNANCE)], coverage_pct=100.0,
                    resources_evaluated=1000)
check("one CRITICAL caps the grade at C however high the number",
      s.grade == "C" and s.score > 70, f"{s.score}/{s.grade}")
check("...and says why", "CRITICAL" in (s.grade_capped_by or ""))
s = scoring.compute([finding(HIGH, CAT_GOVERNANCE)], coverage_pct=100.0,
                    resources_evaluated=1000)
eq("one HIGH caps the grade at B", s.grade, "B")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §79 Compliance: one finding, many citations ===")
# ═════════════════════════════════════════════════════════════════════════════

mapping = ctl.mappings_for_rule("AWS_SG_SSH_WORLD_OPEN", provider="AWS")
SG_FRAMEWORKS = ["CIS-AWS", "GDPR", "HIPAA", "ISO27001", "PCI-DSS", "RBI", "SEBI-CSCRF", "SOC2"]
check("a security-group rule maps to every framework covering boundary protection",
      sorted(mapping) == SG_FRAMEWORKS, str(sorted(mapping)))
check("...including its own cloud's CIS benchmark, cited by recommendation number",
      any(ref.startswith("6.3 ") for ref in mapping.get("CIS-AWS", [])),
      str(mapping.get("CIS-AWS")))

f = finding(CRITICAL, rule_id="AWS_SG_SSH_WORLD_OPEN")
f.compliance = mapping
out = comp.build(findings=[f], rule_stats={"AWS_SG_SSH_WORLD_OPEN": {VULNERABLE: 1}},
                 provider="AWS")
eq("one finding breaching eight frameworks appears ONCE",
   out["total_violations"], 1)
eq("...carrying every framework citation",
   sorted(out["violations"][0]["frameworks"]), SG_FRAMEWORKS)

# A cross-cloud rule's finding on OCI must not carry another cloud's benchmark.
oci_map = ctl.mappings_for_rule("EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN", provider="OCI")
check("a cross-cloud finding on OCI carries no CIS AWS or CIS Azure citation",
      "CIS-AWS" not in oci_map and "CIS-AZURE" not in oci_map, str(sorted(oci_map)))

# Categories deliberately outside the control map produce no violation.
f2 = finding(LOW, CAT_GOVERNANCE, rule_id="GOVERNANCE_MISSING_OWNERSHIP_TAGS")
f2.compliance = ctl.mappings_for_rule("GOVERNANCE_MISSING_OWNERSHIP_TAGS")
out = comp.build(findings=[f2], rule_stats={})
eq("a LOW governance finding is advisory, not a violation",
   out["total_violations"], 0)
eq("...and is counted as advisory", out["advisory_findings"], 1)

perf = finding(MEDIUM, "Performance", rule_id="OCI_FUNCTION_LONG_TIMEOUT")
perf.compliance = ctl.mappings_for_rule("OCI_FUNCTION_LONG_TIMEOUT")
out = comp.build(findings=[perf], rule_stats={})
eq("a performance finding is never a control violation",
   out["total_violations"], 0)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §24 Control states ===")
# ═════════════════════════════════════════════════════════════════════════════

ENC = "AWS_RDS_ENCRYPTION_DISABLED"
HIPAA_ENC = "164.312(a)(2)(iv)"


def control_state(rule_stats, findings=()):
    out = comp.build(findings=list(findings), rule_stats=rule_stats, framework="HIPAA")
    row = next(c for c in out["controls"] if c["control_id"] == HIPAA_ENC)
    return row["state"]


eq("a rule that ran and found nothing -> PASS",
   control_state({ENC: {"SAFE": 5}}), ctl.PASS)
vf = finding(HIGH, "Encryption", rule_id=ENC)
eq("a confirmed violation -> FAIL",
   control_state({ENC: {VULNERABLE: 1, "SAFE": 4}}, [vf]), ctl.FAIL)
uf = finding(MEDIUM, "Encryption", rule_id=ENC, verdict=UNKNOWN,
             confidence=CONF_UNKNOWN)
eq("some evidence, some undetermined -> PARTIAL",
   control_state({ENC: {"SAFE": 3, UNKNOWN: 2}}, [uf]), ctl.PARTIAL)
eq("all undetermined -> UNKNOWN, never PASS",
   control_state({ENC: {UNKNOWN: 5}}, [uf]), ctl.UNKNOWN)
eq("no rule ran -> NOT_APPLICABLE", control_state({}), ctl.NOT_APPLICABLE)

# A control the build declares but does not assess.
out = comp.build(findings=[], rule_stats={}, framework="PCI-DSS")
audit = next(c for c in out["controls"] if c["control_id"] == "10.2.1")
eq("a declared-but-unassessed control -> NOT_EVALUATED", audit["state"],
   ctl.NOT_EVALUATED)
check("...and is never counted as passed",
      out["frameworks"]["PCI-DSS"]["controls_passed"] == 0)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §23 Compliance arithmetic is correct ===")
# ═════════════════════════════════════════════════════════════════════════════

stats = {
    "AWS_RDS_ENCRYPTION_DISABLED": {"SAFE": 3},
    "AWS_S3_ENCRYPTION_DISABLED": {"SAFE": 2},
    "AWS_SG_SSH_WORLD_OPEN": {VULNERABLE: 1},
    "AWS_IAM_ROLE_WILDCARD_FULL": {"SAFE": 8},
}
f = finding(CRITICAL, rule_id="AWS_SG_SSH_WORLD_OPEN")
f.compliance = ctl.mappings_for_rule("AWS_SG_SSH_WORLD_OPEN")
out = comp.build(findings=[f], rule_stats=stats)

for fw, summary in out["frameworks"].items():
    rated = (summary["controls_passed"] + summary["controls_failed"]
             + summary["controls_partial"] + summary["controls_unknown"])
    eq(f"{fw}: controls_assessed equals the rated states", summary["controls_assessed"],
       rated)
    total = rated + summary["controls_not_applicable"] + summary["controls_not_evaluated"]
    eq(f"{fw}: every declared control has exactly one state",
       total, summary["controls_declared"])
    if rated:
        expected = round(100.0 * summary["controls_passed"] / rated, 1)
        eq(f"{fw}: pass rate is passed/assessed", summary["control_pass_rate"], expected)
    check(f"{fw}: NOT_EVALUATED is excluded from the pass rate",
          summary["controls_not_evaluated"] == 0
          or summary["control_pass_rate"] != round(
              100.0 * summary["controls_passed"]
              / (rated + summary["controls_not_evaluated"]), 1))

# A framework where nothing was rated must report None, not 0 or 100.
out = comp.build(findings=[], rule_stats={})
for fw, summary in out["frameworks"].items():
    if summary["controls_assessed"] == 0:
        eq(f"{fw}: pass rate with no assessed controls is None",
           summary["control_pass_rate"], None)

check("the word 'compliant' appears nowhere in the output",
      "compliant" not in str(out).lower(),
      "found it — the wording rule (§89) is broken")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §15 Azure interval arithmetic ===")
# ═════════════════════════════════════════════════════════════════════════════

def ar(access, priority, ports, source="*", proto="Tcp"):
    return {"access": access, "priority": priority, "protocol": proto,
            "direction": "Inbound", "source_address_prefix": source,
            "destination_port_range": ports, "destination_port_ranges": []}


# The spec's worked example: Allow 22-3389, Deny 100-200 at a lower priority.
allowed, denied = exp._effective_intervals(
    [ar("Deny", 100, "100-200"), ar("Allow", 300, "22-3389")], "Tcp")
def is_open(port):
    return any(lo <= port <= hi for lo, hi in allowed)
def is_denied(port):
    return any(lo <= port <= hi for lo, hi in denied)


eq("§15  22 EXPOSED", is_open(22), True)
eq("§15  80 EXPOSED", is_open(80), True)
eq("§15 443 EXPOSED", is_open(443), True)
eq("§15 150 PROTECTED (inside the deny range)", is_open(150), False)
eq("§15 150 is explicitly denied, not merely absent", is_denied(150), True)
eq("§15 3389 EXPOSED", is_open(3389), True)
eq("§15 3390 not opened (outside the allow range)", is_open(3390), False)
eq("§15  21 not opened (below the allow range)", is_open(21), False)
check("the allow set is split around the deny, not discarded",
      len(allowed) == 2, str(allowed))

# The exact-match case the OLD implementation handled, still correct.
allowed, _ = exp._effective_intervals(
    [ar("Deny", 100, "3389"), ar("Allow", 300, "3389")], "Tcp")
eq("exact-match deny shadows the allow", any(lo <= 3389 <= hi for lo, hi in allowed),
   False)
# Priority order matters in both directions.
allowed, _ = exp._effective_intervals(
    [ar("Allow", 100, "3389"), ar("Deny", 300, "3389")], "Tcp")
eq("a deny at a HIGHER priority number does not shadow",
   any(lo <= 3389 <= hi for lo, hi in allowed), True)
# A CIDR-scoped rule must not consume the interval.
allowed, _ = exp._effective_intervals(
    [ar("Deny", 100, "22", "10.0.0.0/8"), ar("Allow", 200, "22")], "Tcp")
eq("a CIDR-scoped deny does not protect against the internet",
   any(lo <= 22 <= hi for lo, hi in allowed), True)
# Protocols are independent.
allowed, _ = exp._effective_intervals(
    [ar("Deny", 100, "22", proto="Udp"), ar("Allow", 200, "22", proto="Tcp")], "Tcp")
eq("a UDP deny does not shadow a TCP allow",
   any(lo <= 22 <= hi for lo, hi in allowed), True)
allowed, _ = exp._effective_intervals([ar("Allow", 100, "*")], "Tcp")
eq("port '*' opens the whole range", allowed, [(0, 65535)])
allowed, _ = exp._effective_intervals([], "Tcp")
eq("no rules -> nothing open (implicit DenyAllInbound)", allowed, [])

# Interval algebra edge cases.
eq("subtracting a middle slice yields two intervals",
   exp._subtract((0, 100), (40, 50)), [(0, 39), (51, 100)])
eq("subtracting a prefix yields one", exp._subtract((0, 100), (0, 50)), [(51, 100)])
eq("subtracting everything yields none", exp._subtract((0, 100), (0, 100)), [])
eq("subtracting a disjoint range is a no-op",
   exp._subtract((0, 10), (50, 60)), [(0, 10)])
eq("adjacent intervals merge", exp._merge([(0, 10), (11, 20)]), [(0, 20)])
eq("overlapping intervals merge", exp._merge([(0, 15), (10, 20)]), [(0, 20)])
eq("disjoint intervals do not merge",
   exp._merge([(0, 10), (20, 30)]), [(0, 10), (20, 30)])


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §14 / §78.5 Every internet-facing resource gets a verdict ===")
# ═════════════════════════════════════════════════════════════════════════════

# The live Azure Production case: VMs with a public address but no NIC
# relationship recorded. The old code skipped them entirely and reported
# "No internet exposure found".
vms = [Res("VirtualMachine", f"vm{i}", config={"azure_type": "x"}, ip=f"20.1.1.{i}")
       for i in range(25)]
vms += [Res("VirtualMachine", f"priv{i}", config={"azure_type": "x"})
        for i in range(24)]
results = exp.analyse(vms, AZURE)
unknown = [r for r in results if r.verdict == EXPOSURE_UNKNOWN]
eq("§78.5 all 49 VMs get a verdict, none is skipped", len(results), 49)
eq("...and every one is UNKNOWN, not PROTECTED", len(unknown), 49)
check("...each with a reason naming the gap",
      all("network interface" in (r.unknown_reason or "").lower() for r in unknown))
summary = exp.summarise(results)
eq("summary counts them as unknown", summary["unknown"], 49)
eq("summary reports 0 exposed", summary["exposed"], 0)
check("...but the clean result is NOT trustworthy",
      summary["clean_result_trustworthy"] is False)

# A properly-collected Azure VM resolves to EXPOSED with a path.
nsg = Res("NetworkSecurityGroup", "nsg", key="nsg1",
          config={"ingress_rules": [ar("Allow", 300, "3389")]})
pip = Res("PublicIP", "pip", key="pip1")
pip.ip_address = "20.9.9.9"
nic = Res("NetworkInterface", "nic", key="nic1", config={
    "public_ip_ids": ["pip1"], "network_security_group_id": "nsg1",
    "private_ip": "10.0.0.4", "subnet_ids": []})
vm = Res("VirtualMachine", "prod-vm01", config={"nic_ids": ["nic1"]})
results = exp.analyse([vm, nic, pip, nsg], AZURE)
eq("a fully-collected Azure VM resolves to EXPOSED", results[0].verdict, EXPOSED)
eq("...with the public address resolved", results[0].public_addresses, ["20.9.9.9"])
eq("...at CRITICAL (RDP)", results[0].severity, CRITICAL)
check("...with a path through the public IP, NIC and NSG",
      {h.kind for h in results[0].path} >= {"public-ip", "nic", "nsg"},
      str([h.kind for h in results[0].path]))
check("...naming the NSG it consulted", "nsg" in results[0].evaluated_controls)
eq("...at HIGH confidence (exact interval arithmetic)",
   results[0].confidence, CONF_HIGH)

# NSG present but closed -> PROTECTED, and the clean result IS trustworthy.
closed = Res("NetworkSecurityGroup", "closed", key="nsg1",
             config={"ingress_rules": [ar("Allow", 300, "3389", "10.0.0.0/8")]})
results = exp.analyse([vm, nic, pip, closed], AZURE)
eq("a closed NSG resolves to PROTECTED", results[0].verdict, PROTECTED)
check("a genuinely clean result IS trustworthy",
      exp.summarise(results)["clean_result_trustworthy"] is True)

# A VM whose NSG reference cannot be resolved is UNKNOWN, not PROTECTED.
results = exp.analyse([vm, nic, pip], AZURE)
eq("an unresolvable NSG reference -> UNKNOWN", results[0].verdict, EXPOSURE_UNKNOWN)

# AWS
sg = Res("SecurityGroup", "sg", key="sg1", config={"inbound_rules": 1}, raw={
    "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
                       "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]})
ec2 = Res("EC2Instance", "db", config={"public_ip": "52.1.1.1",
                                       "security_group_ids": ["sg1"]})
results = exp.analyse([ec2, sg], AWS)
eq("AWS instance with world-open Postgres -> EXPOSED", results[0].verdict, EXPOSED)
eq("...at CRITICAL (a data port)", results[0].severity, CRITICAL)
ec2_nosg = Res("EC2Instance", "orphan", config={"public_ip": "52.1.1.2"})
results = exp.analyse([ec2_nosg], AWS)
eq("AWS instance with no security group -> UNKNOWN", results[0].verdict,
   EXPOSURE_UNKNOWN)
private = Res("EC2Instance", "internal", config={"security_group_ids": ["sg1"]})
results = exp.analyse([private, sg], AWS)
eq("an instance with no public IP is omitted (NOT_APPLICABLE)", len(results), 0)

# OCI: NSGs and security lists are merged.
seclist = Res("SecurityList", "sl", key="sl1", config={"ingress_rules": [
    {"source": "0.0.0.0/0", "protocol": "6", "source_type": "CIDR_BLOCK",
     "port_range": {"min": 22, "max": 22}}]})
subnet = Res("Subnet", "sn", key="sn1", config={"security_list_ids": ["sl1"]})
inst = Res("ComputeInstance", "oci-vm", config={"public_ip": "140.1.1.1",
                                                "subnet_id": "sn1", "nsg_ids": []})
results = exp.analyse([inst, subnet, seclist], OCI)
eq("OCI instance governed only by a security list -> EXPOSED",
   results[0].verdict, EXPOSED)
check("...and the security list appears in the path",
      any(h.kind == "security-list" for h in results[0].path))
lone = Res("ComputeInstance", "lonely", config={"public_ip": "140.1.1.2"})
results = exp.analyse([lone], OCI)
eq("OCI instance with neither NSG nor security list -> UNKNOWN",
   results[0].verdict, EXPOSURE_UNKNOWN)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §20 Identity: broad access is not escalation ===")
# ═════════════════════════════════════════════════════════════════════════════

ROLES = {
    "Owner": {"actions": ["*"], "not_actions": []},
    "Contributor": {"actions": ["*"], "not_actions": [
        "Microsoft.Authorization/*/write",
        "Microsoft.Authorization/elevateAccess/Action"]},
    "Reader": {"actions": ["*/read"], "not_actions": []},
    "User Access Administrator": {"actions": ["*/read", "Microsoft.Authorization/*"],
                                  "not_actions": []},
    "VM Contributor": {"actions": ["Microsoft.Compute/*", "Microsoft.Network/*"],
                       "not_actions": []},
    "Custom escalator": {"actions": ["Microsoft.Authorization/roleAssignments/write"],
                         "not_actions": []},
}
expect = {
    "Owner": (True, True, True),
    "Contributor": (False, False, True),
    "Reader": (False, False, False),
    "User Access Administrator": (False, True, False),
    "VM Contributor": (False, False, True),
    "Custom escalator": (False, True, False),
}
for name, perms in ROLES.items():
    p = ident._role_powers(perms)
    got = (p.full_control, p.can_escalate, p.broad_write)
    eq(f"{name}: (full, escalate, write)", got, expect[name])

check("a role definition that was never fetched returns None, not 'harmless'",
      ident._role_powers(None) is None)


class Grant:
    def __init__(self, role, scope_level, perms, ptype="User", key=None):
        self.grant_key = key or str(uuid.uuid4())
        self.principal_id = "p1"
        self.principal_type = ptype
        self.principal_name = None
        self.role_key = "rk"
        self.role_name = role
        self.role_type = "BuiltInRole"
        self.scope = f"/{scope_level}"
        self.scope_level = scope_level
        self.permissions = perms


risks = ident.analyse_azure_grants([Grant("Reader", "subscription", ROLES["Reader"])])
eq("Reader at subscription scope produces NO finding", len(risks), 0)

risks = ident.analyse_azure_grants([Grant("Owner", "subscription", ROLES["Owner"])])
kinds = {r.rule_id for r in risks}
check("Owner at subscription scope -> owner AND escalation findings",
      kinds == {"AZURE_RBAC_SUBSCRIPTION_OWNER", "AZURE_RBAC_ESCALATION"}, str(kinds))
check("...both CRITICAL", all(r.severity == CRITICAL for r in risks))

risks = ident.analyse_azure_grants([Grant("Owner", "resource", ROLES["Owner"])])
kinds = {r.rule_id for r in risks}
eq("Owner on ONE resource is escalation only, not subscription-owner",
   kinds, {"AZURE_RBAC_ESCALATION"})
eq("...and at MEDIUM, not CRITICAL", risks[0].severity, MEDIUM)

risks = ident.analyse_azure_grants(
    [Grant("Contributor", "subscription", ROLES["Contributor"])])
kinds = {r.rule_id for r in risks}
eq("Contributor at subscription scope is broad write, not escalation",
   kinds, {"AZURE_RBAC_BROAD_WRITE"})

risks = ident.analyse_azure_grants(
    [Grant("Owner", "subscription", ROLES["Owner"], ptype="ForeignGroup")])
check("an external principal with Owner also raises the external finding",
      "AZURE_RBAC_EXTERNAL_PRINCIPAL_PRIVILEGED" in {r.rule_id for r in risks})

risks = ident.analyse_azure_grants([Grant("Mystery", "subscription", None)])
eq("a grant whose role definition is unknown is reported, not ignored", len(risks), 1)
check("...at MEDIUM with a stated uncertainty",
      risks[0].severity == MEDIUM
      and risks[0].evidence.get("role_definition_retrieved") is False)
risks = ident.analyse_azure_grants([Grant("Mystery", "resource", None)])
eq("...but not at resource scope, where it would be noise", len(risks), 0)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §81 Alert thresholds ===")
# ═════════════════════════════════════════════════════════════════════════════

def evaluate(policies, findings, **kw):
    return pol.evaluate(policies=policies, findings=findings, account_id=ACCOUNT,
                        account_name="acct", **kw)


def rows(n, **kw):
    return [Row(finding(resource=f"r{i}", **kw)) for i in range(n)]


for threshold in (1, 5, 10):
    p = Policy(threshold_kind=THRESHOLD_FINDING_COUNT, threshold_value=threshold,
               policy_key=f"t{threshold}")
    for n in (threshold - 1, threshold, threshold + 1):
        intents = evaluate([p], rows(max(0, n)))
        want = 0 if n < threshold else 1
        eq(f"threshold {threshold} with {n} findings -> {want} alert",
           len(intents), want)

p = Policy(threshold_kind=THRESHOLD_FINDING_COUNT, threshold_value=5, policy_key="k")
a5 = evaluate([p], rows(5))
a6 = evaluate([p], rows(6))
eq("5 and 6 findings produce the SAME dedupe key (one alert, not two)",
   a5[0].dedupe_key, a6[0].dedupe_key)

p = Policy(threshold_kind=THRESHOLD_RESOURCE_COUNT, threshold_value=3,
           policy_key="rc")
same = [Row(finding(resource="one")) for _ in range(5)]
eq("5 findings on ONE resource do not meet a 3-resource threshold",
   len(evaluate([p], same)), 0)
eq("3 findings on 3 resources do", len(evaluate([p], rows(3))), 1)

p = Policy(threshold_kind=THRESHOLD_PERCENTAGE, threshold_value=10,
           resource_types=["EC2Instance"], policy_key="pc")
eq("2 of 100 instances is under a 10% threshold",
   len(evaluate([p], rows(2), resource_counts={"EC2Instance": 100})), 0)
eq("15 of 100 is over it",
   len(evaluate([p], rows(15), resource_counts={"EC2Instance": 100})), 1)
eq("a percentage with no denominator produces nothing, not 100%",
   len(evaluate([p], rows(15), resource_counts={})), 0)

p = Policy(threshold_kind=THRESHOLD_CONSECUTIVE, threshold_value=3, policy_key="cd")
eq("a finding seen twice does not meet a 3-scan threshold",
   len(evaluate([p], [Row(finding(), detections=2)])), 0)
eq("seen three times, it does",
   len(evaluate([p], [Row(finding(), detections=3)])), 1)

p = Policy(threshold_kind=THRESHOLD_DURATION, threshold_value=24, policy_key="du")
eq("a 2-hour-old finding does not meet a 24-hour threshold",
   len(evaluate([p], [Row(finding(), first=NOW - timedelta(hours=2))], now=NOW)), 0)
eq("a 25-hour-old finding does",
   len(evaluate([p], [Row(finding(), first=NOW - timedelta(hours=25))], now=NOW)), 1)

p = Policy(threshold_kind=THRESHOLD_SCORE_BELOW, threshold_value=70, policy_key="sc")
eq("score 80 does not trip a below-70 policy", len(evaluate([p], [], score=80)), 0)
eq("score 65 does", len(evaluate([p], [], score=65)), 1)
eq("a withheld score (None) never trips it — that would be alerting on a "
   "scanner problem", len(evaluate([p], [], score=None)), 0)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Policy matching and precedence ===")
# ═════════════════════════════════════════════════════════════════════════════

p = Policy(min_severity=HIGH, policy_key="sev")
eq("min_severity HIGH matches a CRITICAL finding",
   len(evaluate([p], [Row(finding(CRITICAL))])), 1)
eq("...and a HIGH finding", len(evaluate([p], [Row(finding(HIGH))])), 1)
eq("...but not a MEDIUM one", len(evaluate([p], [Row(finding(MEDIUM))])), 0)

p = Policy(ports=[3389], categories=[CAT_EXPOSURE], policy_key="rdp")
rdp = Row(finding(CRITICAL, CAT_EXPOSURE, evidence={"port": {"port": 3389}}))
ssh = Row(finding(HIGH, CAT_EXPOSURE, evidence={"port": {"port": 22}}))
eq("a port-scoped policy matches its port", len(evaluate([p], [rdp])), 1)
eq("...and not another", len(evaluate([p], [ssh])), 0)

p = Policy(match_verdicts=[VULNERABLE], policy_key="v")
eq("policies match confirmed findings by default",
   len(evaluate([p], [Row(finding(CRITICAL))])), 1)
eq("...and not undetermined ones",
   len(evaluate([p], [Row(finding(CRITICAL, verdict=UNKNOWN))])), 0)
p = Policy(match_verdicts=[UNKNOWN], policy_key="u")
eq("a policy can opt into undetermined findings",
   len(evaluate([p], [Row(finding(CRITICAL, verdict=UNKNOWN))])), 1)

p = Policy(policy_key="dis", enabled=False)
eq("a disabled policy never fires", len(evaluate([p], rows(5))), 0)

other = uuid.uuid4()
p = Policy(policy_key="scoped", account_id=other)
eq("a policy scoped to another account does not fire", len(evaluate([p], rows(5))), 0)

# Precedence: the catch-all and the specific policy both match, one alert wins.
catch_all = Policy(min_severity=CRITICAL, policy_key="critical_finding",
                   name="New critical finding")
specific = Policy(ports=[3389], categories=[CAT_EXPOSURE], policy_key="public_rdp",
                  name="Internet-reachable RDP")
intents = evaluate([catch_all, specific], [rdp])
eq("two policies matching one finding produce ONE alert", len(intents), 1)
eq("...from the more specific policy", intents[0].policy_name,
   "Internet-reachable RDP")
check("specificity ranks the specific policy above the catch-all",
      pol.specificity(specific) > pol.specificity(catch_all),
      f"{pol.specificity(specific)} vs {pol.specificity(catch_all)}")

# Aggregate intents are never collapsed — they are about the account.
agg = Policy(threshold_kind=THRESHOLD_FINDING_COUNT, threshold_value=1,
             policy_key="agg")
intents = evaluate([agg, specific], [rdp])
eq("an aggregate policy and a per-finding policy both fire", len(intents), 2)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §34 Notification deduplication ===")
# ═════════════════════════════════════════════════════════════════════════════

class Alert:
    def __init__(self, severity=HIGH, last_notified=None, created=None):
        self.severity = severity
        self.last_notified_at = last_notified
        self.created_at = created or NOW


intent = pol.AlertIntent(
    dedupe_key="k", policy_id="p", policy_name="n", severity=HIGH, title="t",
    details="d", finding_fingerprint="f", resource_name=None, resource_type=None,
    resource_id=None, context={}, notify=True, cooldown_minutes=60)

check("a newly opened alert notifies",
      pol.should_notify(Alert(), intent, just_opened=True, now=NOW))
check("a recurrence inside the cooldown does not",
      not pol.should_notify(Alert(last_notified=NOW - timedelta(minutes=10)),
                            intent, just_opened=False, now=NOW))
check("a recurrence after the cooldown does",
      pol.should_notify(Alert(last_notified=NOW - timedelta(minutes=61)),
                        intent, just_opened=False, now=NOW))
escalated = intent._replace(severity=CRITICAL)
check("a severity escalation notifies even inside the cooldown",
      pol.should_notify(Alert(severity=HIGH, last_notified=NOW),
                        escalated, just_opened=False, now=NOW))
check("a de-escalation does not notify",
      not pol.should_notify(Alert(severity=CRITICAL, last_notified=NOW),
                            intent, just_opened=False, now=NOW))
check("notify=False never notifies, even when newly opened",
      not pol.should_notify(Alert(), intent._replace(notify=False),
                            just_opened=True, now=NOW))

# The regression this whole section guards: 100 scans must not send 100 emails.
alert = Alert(last_notified=None, created=NOW - timedelta(days=1))
sends = 0
clock = NOW
for _ in range(100):
    if pol.should_notify(alert, intent, just_opened=False, now=clock):
        sends += 1
        alert.last_notified_at = clock
    clock += timedelta(minutes=5)
check("100 assessments over 8 hours send ~8 notifications, not 100",
      2 <= sends <= 10, f"{sends} notifications")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Engine: end to end ===")
# ═════════════════════════════════════════════════════════════════════════════

resources = [
    Res("SecurityGroup", "default", config={"inbound_rules": 4}, raw={
        "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
                           "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]}),
    Res("S3Bucket", "bucket", config={
        "public_access_block": {"BlockPublicAcls": False, "IgnorePublicAcls": False,
                                "BlockPublicPolicy": False,
                                "RestrictPublicBuckets": False},
        "encryption": "AES256", "versioning": "Enabled"}),
    Res("IAMRole", "admin", config={"broad_access": ["iam:full", "s3:full"],
                                    "accessible_resources": [],
                                    "max_session_duration": 3600}),
    Res("EC2Instance", "web", config={"public_ip": "52.1.1.1"}, tags={}),
]
a = engine.assess(account_id=ACCOUNT, provider="AWS", resources=resources)

eq("assessment outcome is COMPLETE for a clean sweep", a.outcome, ASSESS_COMPLETE)
check("it may resolve findings", a.may_resolve is True)
check("findings were produced", len(a.findings) > 0, f"{len(a.findings)}")
rule_ids = {f.rule_id for f in a.findings}
for expected in ("AWS_SG_SSH_WORLD_OPEN", "AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED",
                 "AWS_IAM_ROLE_ESCALATION", "GOVERNANCE_MISSING_OWNERSHIP_TAGS"):
    check(f"engine produced {expected}", expected in rule_ids)
check("every finding carries compliance citations or is uncited by design",
      all(isinstance(f.compliance, dict) for f in a.findings))
check("every finding has a fingerprint",
      all(f.fingerprint for f in a.findings))
check("fingerprints are unique",
      len({f.fingerprint for f in a.findings}) == len(a.findings))

# Determinism: the same input must produce the same identities, or history and
# alert dedupe both break.
b = engine.assess(account_id=ACCOUNT, provider="AWS", resources=resources)
eq("the same inventory yields the same fingerprints",
   sorted(f.fingerprint for f in a.findings),
   sorted(f.fingerprint for f in b.findings))

# An unrecognised provider must not fall through to another cloud's rules.
c = engine.assess(account_id=ACCOUNT, provider="GCP", resources=resources)
eq("an unknown provider produces no findings", len(c.findings), 0)
check("...and reports FAILED with a reason",
      c.outcome == "FAILED" and c.incomplete_reasons)

# An incomplete sweep must never permit resolution.
d = engine.assess(account_id=ACCOUNT, provider="AWS", resources=resources,
                  sweep_complete=False, failed_scopes=21)
eq("an incomplete sweep is PARTIAL", d.outcome, ASSESS_PARTIAL)
check("...and must not resolve findings", d.may_resolve is False)
check("...and says why", any("scope" in r for r in d.incomplete_reasons))

# Zero resources is not a pass.
e = engine.assess(account_id=ACCOUNT, provider="AWS", resources=[])
check("an empty account is PARTIAL, not COMPLETE", e.outcome == ASSESS_PARTIAL)
check("...and inventory coverage is not 100%",
      next(x.pct for x in e.coverage if x.dimension == "inventory") != 100.0)

# Aggregation
tag_findings = [f for f in a.findings
                if f.rule_id == "GOVERNANCE_MISSING_OWNERSHIP_TAGS"]
eq("the tag rule produces exactly one aggregated finding", len(tag_findings), 1)
check("...carrying an affected count", tag_findings[0].affected_count >= 1)

many = [Res("StorageAccount", f"sa{i}", config={"kind": "v2"}) for i in range(30)]
agg = engine.assess(account_id=ACCOUNT, provider="AZURE", resources=many)
blob = [f for f in agg.findings if f.rule_id == "AZURE_STORAGE_BLOB_PUBLIC_ACCESS"]
eq("30 identical UNKNOWNs collapse into one grouped finding", len(blob), 1)
eq("...reporting all 30", blob[0].affected_count, 30)
eq("...as UNKNOWN, never VULNERABLE", blob[0].verdict, UNKNOWN)
eq("...at MEDIUM, not the rule's own severity", blob[0].severity, MEDIUM)

one = engine.assess(account_id=ACCOUNT, provider="AZURE",
                    resources=[Res("StorageAccount", "solo", config={"kind": "v2"})])
solo = [f for f in one.findings if f.rule_id == "AZURE_STORAGE_BLOB_PUBLIC_ACCESS"]
check("a single UNKNOWN stays per-resource, not grouped",
      len(solo) == 1 and solo[0].resource_name == "solo")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §82/§83 Scale ===")
# ═════════════════════════════════════════════════════════════════════════════

def synth(n):
    out = []
    for i in range(n):
        kind = i % 5
        if kind == 0:
            out.append(Res("EC2Instance", f"i{i}", config={
                "public_ip": f"52.{i % 250}.1.1", "security_group_ids": [f"sg{i % 50}"]}))
        elif kind == 1:
            out.append(Res("SecurityGroup", f"sg{i}", key=f"sg{i}",
                           config={"inbound_rules": i % 6}, raw={"IpPermissions": []}))
        elif kind == 2:
            out.append(Res("S3Bucket", f"b{i}", config={
                "public_access_block": {"BlockPublicAcls": True,
                                        "IgnorePublicAcls": True,
                                        "BlockPublicPolicy": True,
                                        "RestrictPublicBuckets": True},
                "encryption": "AES256", "versioning": "Enabled"}))
        elif kind == 3:
            out.append(Res("IAMRole", f"r{i}", config={
                "broad_access": ["s3:write"] if i % 7 == 0 else [],
                "accessible_resources": [], "max_session_duration": 3600}))
        else:
            out.append(Res("LambdaFunction", f"f{i}", config={
                "runtime": "python3.12", "memory_mb": 512}))
    return out


for n in (100, 1_000, 10_000):
    res = synth(n)
    t0 = time.perf_counter()
    a = engine.assess(account_id=ACCOUNT, provider="AWS", resources=res)
    build_ms = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter()
    s = scoring.compute(a.findings, coverage_pct=a.coverage_pct,
                        resources_evaluated=n)
    score_ms = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter()
    comp.build(findings=a.findings, rule_stats=a.rule_stats)
    comp_ms = (time.perf_counter() - t0) * 1000
    print(f"    {n:>6} resources: assess {build_ms:7.1f} ms  "
          f"score {score_ms:6.1f} ms  compliance {comp_ms:6.1f} ms  "
          f"findings {len(a.findings):>5}  score {s.score}")
    check(f"{n} resources assess in under 15 s", build_ms < 15_000, f"{build_ms:.0f} ms")
    check(f"{n} resources score in under 2 s", score_ms < 2_000, f"{score_ms:.0f} ms")
    check(f"{n} resources: score stays bounded",
          s.score is None or 0 <= s.score <= 100, str(s.score))
    check(f"{n} resources: findings stay bounded by aggregation",
          len(a.findings) < n, f"{len(a.findings)} findings for {n} resources")


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Stable identity, port catalog, exception policy ===")
# ═════════════════════════════════════════════════════════════════════════════
import os as _os  # noqa: E402
import subprocess as _sp  # noqa: E402

from app.security import ports as _ports  # noqa: E402
from app.security import model as _model  # noqa: E402

# The bug was hash(), salted per process — so the only honest test runs the
# production function in two processes with different seeds.
_snippet = ("import sys; sys.path.insert(0, '.'); from app.security import engine; "
            "print(engine._gap_discriminator('kms_key_id not collected'))")
_digests = set()
for _seed in ("1", "2", "3"):
    _out = _sp.run([sys.executable, "-c", _snippet], capture_output=True, text=True,
                   cwd=str(pathlib.Path(__file__).resolve().parents[1]),
                   env={**_os.environ, "PYTHONHASHSEED": _seed})
    _digests.add(_out.stdout.strip())
check("a not-assessed finding's identity is the same in every process",
      len(_digests) == 1 and "" not in _digests, str(_digests))

_rpc = _ports.classify_range(49152, 65535)
eq("49152-65535 decomposes to one named range finding", len(_rpc), 1)
check("...named for what it is", "dynamic RPC" in (_rpc[0].service or ""), _rpc[0].service)
check("...whose rationale gives the actual fix (stateful rules / domain ranges)",
      "stateful" in _rpc[0].why, _rpc[0].why[:120])
check("...and does not claim a WireGuard endpoint inside it",
      not any(p.port == 51820 for p in _rpc))
_title = engine._exposure_title(engine.reg.RULES["EXPOSURE_ALL_PORTS_WORLD_OPEN"], _rpc[0])
check("a partial range is not titled 'Every port'", not _title.startswith("Every port"),
      _title)
check("...and states how many ports it is", "16,384 ports" in _title, _title)
_all = _ports.classify_range(0, 65535)
check("0-65535 is still titled 'Every port'",
      engine._exposure_title(engine.reg.RULES["EXPOSURE_ALL_PORTS_WORLD_OPEN"],
                             _all[0]).startswith("Every port"))
eq("a range still names the dangerous ports inside it",
   [p.port for p in _ports.classify_range(3380, 3400) if p.port], [3389])

for _p, _sev in ((464, HIGH), (137, HIGH), (138, HIGH), (3268, HIGH), (1723, HIGH),
                 (500, "LOW"), (4500, "LOW"), (51820, "LOW")):
    _info = _ports.describe(_p)
    eq(f"port {_p} is catalogued at {_sev}", _info.severity if _info else None, _sev)
for _p in (137, 138, 464, 3268, 500):
    check(f"port {_p} stays outside the management/data sets (identity unchanged)",
          _p not in _ports.MANAGEMENT_PORTS and _p not in _ports.DATA_PORTS)

eq("network exposure exceptions cap at 180 days (PCI DSS 1.2.7)",
   _model.exception_max_days(_model.CAT_EXPOSURE), 180)
eq("...networking too", _model.exception_max_days(_model.CAT_NETWORKING), 180)
eq("...other categories at a year", _model.exception_max_days(_model.CAT_ENCRYPTION), 365)
_now = datetime.now(timezone.utc)
eq("an open finding has no exception state",
   _model.exception_state("OPEN", None, _now), None)
eq("a muted finding with no review date says so",
   _model.exception_state("ACCEPTED_RISK", None, _now), "NO_REVIEW_DATE")
eq("one due within the window reads EXPIRING",
   _model.exception_state("ACCEPTED_RISK", _now + timedelta(days=3), _now), "EXPIRING")
eq("one further out reads ACTIVE",
   _model.exception_state("SUPPRESSED", _now + timedelta(days=60), _now), "ACTIVE")


# ═════════════════════════════════════════════════════════════════════════════
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for f in fail:
        print(f"  ! {f}")
sys.exit(1 if fail else 0)
