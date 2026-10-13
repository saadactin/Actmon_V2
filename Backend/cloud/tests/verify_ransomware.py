"""Ransomware resilience posture: the four control states, and the refusal to score.

Run: venv\\Scripts\\python.exe tests\\verify_ransomware.py

The distinction this suite exists to defend is HOLDING vs NOT_ASSESSED. Both
render as "no finding on this resource", and they are opposite facts: one means
a rule checked and the control is configured, the other means nothing looked.
Object Lock, MFA Delete and backup policy are all in the second category on
every provider, and they are the controls that most decide how a ransomware
incident ends — so a posture view that let them read as passing would be
actively dangerous.
"""
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import ransomware as rw
from app.security import registry as reg
from app.security.model import SAFE, UNKNOWN, VULNERABLE

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class R:
    def __init__(self, rtype, name):
        self.id = uuid.uuid4()
        self.resource_type = rtype
        self.resource_name = name
        self.provider_resource_id = f"id::{name}"
        self.region_or_zone = "ap-south-1"
        self.config = {}
        self.tags = {}


class F:
    def __init__(self, rule_id, resource_key, verdict=VULNERABLE, severity="HIGH"):
        self.rule_id = rule_id
        self.resource_key = resource_key
        self.resource_id = None
        self.verdict = verdict
        self.severity = severity
        self.title = rule_id
        self.fingerprint = f"fp-{rule_id}-{resource_key}"


def state_of(result, resource_name, control_id):
    row = next(r for r in result["resources"] if r["resource_name"] == resource_name)
    return row["controls"][control_id]["state"]


# ═════════════════════════════════════════════════════════════════════════════
print("1. The four states are produced, and each is distinguishable")
bucket = R("S3Bucket", "data")
res = rw.posture(
    provider="AWS",
    resources=[bucket],
    findings=[F("AWS_S3_VERSIONING_DISABLED", "id::data", VULNERABLE)],
)
check("a confirmed finding -> FAILING",
      state_of(res, "data", "VERSIONING_ENABLED") == rw.FAILING,
      state_of(res, "data", "VERSIONING_ENABLED"))
check("a rule that applies and did not fire -> HOLDING",
      state_of(res, "data", "PUBLIC_WRITE_PREVENTED") == rw.HOLDING,
      state_of(res, "data", "PUBLIC_WRITE_PREVENTED"))
check("a control no rule covers -> NOT_ASSESSED, never HOLDING",
      state_of(res, "data", "IMMUTABLE_RETENTION") == rw.NOT_ASSESSED,
      state_of(res, "data", "IMMUTABLE_RETENTION"))

undet = rw.posture(
    provider="AWS", resources=[bucket],
    findings=[F("AWS_S3_VERSIONING_DISABLED", "id::data", UNKNOWN)],
)
check("a rule that ran and could not tell -> UNDETERMINED, not HOLDING",
      state_of(undet, "data", "VERSIONING_ENABLED") == rw.UNDETERMINED,
      state_of(undet, "data", "VERSIONING_ENABLED"))

print("\n2. THE LOAD-BEARING DISTINCTION — 'nothing looked' never reads as 'configured'")
for cid in ("IMMUTABLE_RETENTION", "MFA_DELETE", "BACKUP_CONFIGURED",
            "RECOVERY_POINT_VERIFIED"):
    control = rw.CONTROLS_BY_ID[cid]
    check(f"{cid}: declares no assessing rule", control.assessed_by == ())
    check(f"{cid}: states WHY it cannot be assessed",
          bool(control.not_assessable_reason))
    check(f"{cid}: is NOT_ASSESSED on a real bucket",
          state_of(res, "data", cid) == rw.NOT_ASSESSED)
    row = next(r for r in res["resources"] if r["resource_name"] == "data")
    check(f"{cid}: carries its reason onto the resource row",
          bool(row["controls"][cid]["reason"]))

print("\n3. A control with rules that do not reach THIS type is not passing either")
# Versioning rules exist for S3 and OCI buckets, not for an EBS volume.
vol = R("EBSVolume", "vol1")
volres = rw.posture(provider="AWS", resources=[vol], findings=[])
check("versioning on an EBS volume -> NOT_ASSESSED, not HOLDING",
      state_of(volres, "vol1", "VERSIONING_ENABLED") == rw.NOT_ASSESSED,
      state_of(volres, "vol1", "VERSIONING_ENABLED"))
row = next(r for r in volres["resources"] if r["resource_name"] == "vol1")
check("...and says no rule assesses it for that type",
      "No rule assesses" in (row["controls"]["VERSIONING_ENABLED"]["reason"] or ""))

print("\n4. Provider scoping — an AWS rule never satisfies an OCI control")
oci_bucket = R("ObjectStorageBucket", "ocibkt")
ocires = rw.posture(provider="OCI", resources=[oci_bucket], findings=[])
check("OCI bucket versioning is assessed (an OCI rule exists)",
      state_of(ocires, "ocibkt", "VERSIONING_ENABLED") == rw.HOLDING,
      state_of(ocires, "ocibkt", "VERSIONING_ENABLED"))
# The AWS rule must not be what satisfied it.
check("the OCI versioning rule is the one registered for OCI buckets",
      "OCI_BUCKET_VERSIONING_DISABLED" in
      {r.rule_id for r in reg.rules_for("OCI", "ObjectStorageBucket")})
check("the AWS S3 rule does not dispatch to OCI buckets",
      "AWS_S3_VERSIONING_DISABLED" not in
      {r.rule_id for r in reg.rules_for("OCI", "ObjectStorageBucket")})

print("\n5. No score is produced, and the reason is stated")
check("no numeric score anywhere in the payload",
      not any("score" in k for k in res if k != "no_score_note"),
      str([k for k in res if "score" in k]))
check("the refusal is explained", "cannot be assessed" in res["no_score_note"])
check("unassessable controls are counted", res["unassessable_controls"] == 4,
      str(res["unassessable_controls"]))
check("assessable controls are counted", res["assessable_controls"] == 3,
      str(res["assessable_controls"]))

print("\n6. It says what it is — a configuration review, not malware detection")
check("is_configuration_review is true", res["is_configuration_review"] is True)
check("the disclaimer denies malware detection",
      "not malware detection" in res["disclaimer"].lower())
check("...and says nothing inspects files or processes",
      "files" in res["disclaimer"] and "processes" in res["disclaimer"])

print("\n7. Scope and ordering")
many = rw.posture(
    provider="AWS",
    resources=[R("S3Bucket", "bad"), R("S3Bucket", "good"), R("EC2Instance", "vm")],
    findings=[
        F("AWS_S3_VERSIONING_DISABLED", "id::bad"),
        F("AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", "id::bad"),
    ],
)
check("only data stores are included — an EC2 instance is not one",
      [r["resource_name"] for r in many["resources"]] == ["bad", "good"],
      str([r["resource_name"] for r in many["resources"]]))
check("worst first", many["resources"][0]["resource_name"] == "bad")
check("failing count is per resource", many["resources"][0]["failing"] == 2,
      str(many["resources"][0]["failing"]))
check("stores_with_a_failing_control counts resources, not findings",
      many["stores_with_a_failing_control"] == 1,
      str(many["stores_with_a_failing_control"]))
check("control totals add up to the resource count",
      all(sum(v.values()) == many["data_stores"]
          for v in many["control_totals"].values()))

print("\n8. Every cited rule exists, and every control is reachable")
for c in rw.CONTROLS:
    for rid in c.assessed_by:
        check(f"{c.control_id} cites a real rule: {rid}", reg.by_id(rid) is not None)
check("every control appears on every resource row",
      all(set(r["controls"]) == set(rw.CONTROLS_BY_ID) for r in many["resources"]))
check("every state used has a human label",
      all(s in rw.STATE_LABEL for s in rw.STATE_ORDER))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
