"""The compliance catalog: nine frameworks, their scope, and their arithmetic.

No database. What this suite pins, and why each matters:

* **A benchmark control fails on ANY confirmed finding.** CIS recommendations
  are pass/fail tests; Oracle-managed volume encryption is an INFO finding
  here and must still FAIL CIS OCI 5.2.1 — while NOT failing SOC 2, where
  Oracle-managed encryption is still encryption.
* **Per-type controls see only their type.** A block-volume finding fails CIS
  OCI 5.2.1, not 5.2.2 (boot volumes), although one rule covers both.
* **Undetermined statistics are never a pass**, even with no finding attached
  — the case certificate stores that refused a listing produce.
* **A benchmark applies to its own cloud only**, and never when the provider is
  unknown.
* **The seven configuration checks added for CIS** give VULNERABLE, SAFE,
  UNKNOWN and NOT_SCANNED where each is true — absent data is never SAFE.
* **`*:*` is visible.** An AdministratorAccess-shaped role used to summarise to
  no grants at all and pass every IAM check.
"""
import pathlib
import sys
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from app.providers.aws.iam_policy import summarize_policy_documents  # noqa: E402
from app.security import compliance as comp  # noqa: E402
from app.security import controls as ctl  # noqa: E402
from app.security import registry as reg  # noqa: E402
from app.security.model import (  # noqa: E402
    CRITICAL, HIGH, INFO, LOW, MEDIUM, NOT_SCANNED, OPEN, SAFE, UNKNOWN, VULNERABLE,
    SecurityFinding,
)

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def finding(rule_id, severity, *, rtype=None, verdict=VULNERABLE, provider="AWS"):
    return SecurityFinding(
        rule_id=rule_id, rule_version="1.0", provider=provider, account_id="a",
        fingerprint=uuid.uuid4().hex, resource_key=uuid.uuid4().hex, resource_type=rtype,
        severity=severity, verdict=verdict, status=OPEN,
        compliance=ctl.mappings_for_rule(rule_id, provider=provider))


def state(out, framework, control_id):
    row = next((c for c in out["controls"]
                if c["framework"] == framework and c["control_id"] == control_id), None)
    return row["state"] if row else None


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Catalog integrity ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("nine frameworks", len(ctl.FRAMEWORKS), 9)
keys = [c.key for c in ctl.CONTROLS]
eq("no control is declared twice", len(keys), len(set(keys)))
for fw in ctl.FRAMEWORKS:
    meta = ctl.FRAMEWORK_META[fw]
    check(f"{fw}: has label, full name and kind",
          all(meta.get(k) for k in ("label", "full_name", "kind")))
    check(f"{fw}: declares at least one control", bool(ctl.BY_FRAMEWORK[fw]))
for fw in (ctl.CIS_AWS, ctl.CIS_AZURE, ctl.CIS_OCI):
    check(f"{fw}: applies to exactly one cloud",
          len(ctl.FRAMEWORK_META[fw]["providers"] or ()) == 1)
    check(f"{fw}: every control is strict", all(c.strict for c in ctl.BY_FRAMEWORK[fw]))
for fw in (ctl.SOC2, ctl.HIPAA, ctl.PCI, ctl.ISO27001, ctl.RBI, ctl.SEBI):
    check(f"{fw}: no control is strict", not any(c.strict for c in ctl.BY_FRAMEWORK[fw]))
    eq(f"{fw}: applies to every cloud", ctl.FRAMEWORK_META[fw]["providers"], None)
text = " ".join(str(v) for m in ctl.FRAMEWORK_META.values() for v in m.values())
text += " ".join(c.title + " " + c.requirement for c in ctl.CONTROLS)
check("the word 'compliant' appears nowhere in the catalog",
      "compliant" not in text.lower())
unknown = sorted(r for r in ctl.all_assessing_rule_ids() if r not in reg.RULES)
eq("every cited rule exists", unknown, [])
summary = ctl.catalog_summary()
check("catalog summary counts match the declarations",
      all(summary[fw]["declared"] == len(ctl.BY_FRAMEWORK[fw]) for fw in ctl.FRAMEWORKS))
# Spot-check verified numbering (2026-09-28 research: Prowler + Tenable + Oracle).
expect = {
    (ctl.CIS_AWS, "2.14"): "AWS_IAM_ROLE_FULL_ADMIN",
    (ctl.CIS_AWS, "2.17"): "AWS_IAM_SERVER_CERT_EXPIRED",
    (ctl.CIS_AWS, "3.2.1"): "AWS_RDS_ENCRYPTION_DISABLED",
    (ctl.CIS_AWS, "6.3"): "AWS_SG_SSH_WORLD_OPEN",
    (ctl.CIS_AWS, "6.5"): "AWS_SG_DEFAULT_ALLOWS_TRAFFIC",
    (ctl.CIS_AWS, "6.7"): "AWS_EC2_IMDSV2_NOT_REQUIRED",
    (ctl.CIS_AZURE, "7.1"): "AZURE_NSG_RDP_WORLD_OPEN",
    (ctl.CIS_AZURE, "8.3.1"): "AZURE_KEYVAULT_RBAC_KEY_NO_EXPIRY",
    (ctl.CIS_AZURE, "8.3.4"): "AZURE_KEYVAULT_POLICY_SECRET_NO_EXPIRY",
    (ctl.CIS_AZURE, "8.3.5"): "AZURE_KEYVAULT_NOT_RECOVERABLE",
    (ctl.CIS_AZURE, "9.3.4"): "AZURE_STORAGE_SECURE_TRANSFER_DISABLED",
    (ctl.CIS_AZURE, "9.3.8"): "AZURE_STORAGE_BLOB_PUBLIC_ACCESS",
    (ctl.CIS_OCI, "1.2"): "OCI_IAM_POLICY_TENANCY_ADMIN",
    (ctl.CIS_OCI, "2.1"): "OCI_SECLIST_SSH_WORLD_OPEN",
    (ctl.CIS_OCI, "3.1"): "OCI_COMPUTE_LEGACY_IMDS_ENABLED",
    (ctl.CIS_OCI, "5.1.1"): "OCI_BUCKET_PUBLIC_ACCESS",
    (ctl.CIS_OCI, "6.2"): "OCI_RESOURCE_IN_ROOT_COMPARTMENT",
}
for (fw, cid), rid in expect.items():
    c = ctl.BY_KEY.get(f"{fw}:{cid}")
    check(f"{fw} {cid} is assessed by {rid}", c is not None and rid in c.rules,
          str(c and c.rules))
check("CIS Azure cites no database control (moved out of Foundations in v4+)",
      not any(r.startswith("AZURE_DB_") for c in ctl.BY_FRAMEWORK[ctl.CIS_AZURE]
              for r in c.rules))
check("CIS OCI 5.2.1 / 5.2.2 / 5.3.1 are scoped to their own resource type",
      [ctl.BY_KEY[f"{ctl.CIS_OCI}:{i}"].resource_types for i in ("5.2.1", "5.2.2", "5.3.1")]
      == [("BlockVolume",), ("BootVolume",), ("FileSystem",)])

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Provider scope ===")
# ═════════════════════════════════════════════════════════════════════════════
check("an AWS account gets CIS AWS and not CIS OCI",
      ctl.CIS_AWS in ctl.frameworks_for("AWS") and ctl.CIS_OCI not in ctl.frameworks_for("AWS"))
check("an account stored as 'Oracle' gets CIS OCI", ctl.CIS_OCI in ctl.frameworks_for("Oracle"))
check("'Azure' (as stored) gets CIS Azure", ctl.CIS_AZURE in ctl.frameworks_for("Azure"))
check("an unknown provider gets no benchmark at all",
      not ({ctl.CIS_AWS, ctl.CIS_AZURE, ctl.CIS_OCI} & set(ctl.frameworks_for(None))))
out = comp.build(findings=[], rule_stats={}, provider="OCI")
check("the OCI compliance view has CIS OCI and no other benchmark",
      ctl.CIS_OCI in out["frameworks"] and ctl.CIS_AWS not in out["frameworks"]
      and ctl.CIS_AZURE not in out["frameworks"], str(sorted(out["frameworks"])))
lost = [fw for fw, s in out["frameworks"].items()
        if s.get("framework_note") != ctl.FRAMEWORK_META[fw]["note"] or not s.get("framework_note")]
check("every framework summary keeps its own caveat ('Not a CIS certification'...) — "
      "the generic note used to overwrite it", not lost, str(lost))
check("...and the generic pass-rate note is still there beside it",
      all("control_pass_rate" in (s.get("note") or "") for s in out["frameworks"].values()))
out = comp.build(findings=[], rule_stats={}, framework=ctl.CIS_AWS, provider="OCI")
eq("asking for CIS AWS on an OCI account returns nothing, not AWS controls",
   out["controls"], [])
check("a cross-cloud rule on OCI carries no AWS/Azure benchmark citation",
      not ({"CIS-AWS", "CIS-AZURE"} & set(
          ctl.mappings_for_rule("EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN", provider="OCI"))))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. Strict benchmark controls vs principle-based controls ===")
# ═════════════════════════════════════════════════════════════════════════════
VOL = "OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED"
f_block = finding(VOL, INFO, rtype="BlockVolume", provider="OCI")
stats = {VOL: {VULNERABLE: 1, SAFE: 3},
         ctl.stat_key(VOL, "BlockVolume"): {VULNERABLE: 1},
         ctl.stat_key(VOL, "BootVolume"): {SAFE: 3}}
out = comp.build(findings=[f_block], rule_stats=stats, provider="OCI")
eq("an INFO Oracle-managed-key finding FAILS strict CIS OCI 5.2.1",
   state(out, ctl.CIS_OCI, "5.2.1"), ctl.FAIL)
eq("...does NOT fail 5.2.2 — boot volumes all used customer keys",
   state(out, ctl.CIS_OCI, "5.2.2"), ctl.PASS)
eq("...and 5.3.1 is NOT_APPLICABLE — no file system was evaluated",
   state(out, ctl.CIS_OCI, "5.3.1"), ctl.NOT_APPLICABLE)
eq("...while SOC 2 CC6.1 PASSES: Oracle-managed encryption is still encryption",
   state(out, ctl.SOC2, "CC6.1"), ctl.PASS)
viol = out["violations"]
check("the INFO finding is listed as a violation (a benchmark failed on it)",
      len(viol) == 1, str(len(viol)))
check("...citing ONLY the benchmark, not SOC 2 which it did not fail",
      viol and viol[0]["frameworks"] == [ctl.CIS_OCI], str(viol and viol[0]["frameworks"]))
f_low = finding("GOVERNANCE_MISSING_OWNERSHIP_TAGS", LOW, provider="AWS")
out = comp.build(findings=[f_low], rule_stats={"GOVERNANCE_MISSING_OWNERSHIP_TAGS":
                                               {VULNERABLE: 1}}, provider="AWS")
eq("a LOW finding with no strict citation is advisory, not a violation",
   out["total_violations"], 0)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. Undetermined statistics are never a pass ===")
# ═════════════════════════════════════════════════════════════════════════════
PCI_TRANSIT = "4.2.1"
out = comp.build(findings=[], rule_stats={"CERT_EXPIRED": {SAFE: 3, NOT_SCANNED: 2}},
                 provider="AZURE", framework=ctl.PCI)
eq("some certificates checked, some stores unread -> PARTIAL, not PASS",
   state(out, ctl.PCI, PCI_TRANSIT), ctl.PARTIAL)
out = comp.build(findings=[], rule_stats={"CERT_EXPIRED": {NOT_SCANNED: 2}},
                 provider="AZURE", framework=ctl.PCI)
eq("every store unread -> UNKNOWN", state(out, ctl.PCI, PCI_TRANSIT), ctl.UNKNOWN)
out = comp.build(findings=[], rule_stats={"CERT_EXPIRED": {SAFE: 3}}, provider="AZURE",
                 framework=ctl.PCI)
eq("every store read, nothing expired -> PASS", state(out, ctl.PCI, PCI_TRANSIT), ctl.PASS)
exp = finding("CERT_EXPIRED", HIGH, rtype="Certificate", provider="AZURE")
out = comp.build(findings=[exp], rule_stats={"CERT_EXPIRED": {VULNERABLE: 1, SAFE: 2}},
                 provider="AZURE", framework=ctl.PCI)
eq("an expired certificate FAILS PCI-DSS 4.2.1", state(out, ctl.PCI, PCI_TRANSIT), ctl.FAIL)
soon = finding("CERT_EXPIRING_SOON", MEDIUM, rtype="Certificate", provider="AZURE")
out = comp.build(findings=[soon], rule_stats={"CERT_EXPIRED": {SAFE: 3},
                                              "CERT_EXPIRING_SOON": {VULNERABLE: 1}},
                 provider="AZURE", framework=ctl.PCI)
eq("a certificate expiring soon (still valid) does NOT fail 4.2.1",
   state(out, ctl.PCI, PCI_TRANSIT), ctl.PASS)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. The configuration checks added for CIS ===")
# ═════════════════════════════════════════════════════════════════════════════
NOW = datetime(2026, 9, 28, tzinfo=timezone.utc)


def run_rule(provider, rtype, rule_id, *, name="r", config=None, raw=None, metadata=None):
    res = SimpleNamespace(id=uuid.uuid4(), provider_resource_id=f"p-{uuid.uuid4().hex[:6]}",
                          resource_type=rtype, resource_name=name, config=config or {},
                          raw_data=raw or {}, tags={}, metadata_=metadata or {},
                          region_or_zone="r1")
    rule = next((r for r in reg.rules_for(provider, rtype) if r.rule_id == rule_id), None)
    if rule is None:
        return "NOT DISPATCHED"
    ctx = reg.Ctx(resource=res, provider=provider, config=res.config, raw=res.raw_data,
                  tags={}, index={}, by_type={})
    result = rule.evaluate(ctx)
    return None if result is None else result.verdict


R = "AWS_SG_DEFAULT_ALLOWS_TRAFFIC"
eq("default SG with an egress rule -> VULNERABLE",
   run_rule("AWS", "SecurityGroup", R, name="default",
            raw={"IpPermissions": [], "IpPermissionsEgress": [{"IpProtocol": "-1"}]}),
   VULNERABLE)
eq("default SG with no rules -> SAFE",
   run_rule("AWS", "SecurityGroup", R, name="default",
            raw={"IpPermissions": [], "IpPermissionsEgress": []}), SAFE)
eq("default SG whose rules were not captured -> UNKNOWN, never SAFE",
   run_rule("AWS", "SecurityGroup", R, name="default", raw={}), UNKNOWN)
eq("a non-default group is not in scope", run_rule("AWS", "SecurityGroup", R, name="web",
                                                   raw={"IpPermissions": []}), None)
R = "AWS_EC2_IMDSV2_NOT_REQUIRED"
eq("HttpTokens optional -> VULNERABLE",
   run_rule("AWS", "EC2Instance", R, raw={"MetadataOptions": {"HttpTokens": "optional",
                                                              "HttpEndpoint": "enabled"}}),
   VULNERABLE)
eq("HttpTokens required -> SAFE",
   run_rule("AWS", "EC2Instance", R, raw={"MetadataOptions": {"HttpTokens": "required"}}), SAFE)
eq("metadata endpoint disabled -> SAFE (stricter than IMDSv2)",
   run_rule("AWS", "EC2Instance", R, raw={"MetadataOptions": {"HttpTokens": "optional",
                                                              "HttpEndpoint": "disabled"}}),
   SAFE)
eq("no metadata options captured -> UNKNOWN", run_rule("AWS", "EC2Instance", R, raw={}), UNKNOWN)
R = "AZURE_STORAGE_SECURE_TRANSFER_DISABLED"
eq("secure transfer off -> VULNERABLE",
   run_rule("AZURE", "StorageAccount", R, config={"enable_https_traffic_only": False}),
   VULNERABLE)
eq("secure transfer on -> SAFE",
   run_rule("AZURE", "StorageAccount", R, config={"enable_https_traffic_only": True}), SAFE)
eq("field present but unreported -> UNKNOWN",
   run_rule("AZURE", "StorageAccount", R, config={"enable_https_traffic_only": None}), UNKNOWN)
eq("row scanned before the field existed -> NOT_SCANNED (arrives next scan)",
   run_rule("AZURE", "StorageAccount", R, config={}), NOT_SCANNED)
R = "AZURE_STORAGE_MIN_TLS_BELOW_1_2"
eq("TLS1_0 floor -> VULNERABLE",
   run_rule("AZURE", "StorageAccount", R, config={"minimum_tls_version": "TLS1_0"}), VULNERABLE)
eq("TLS1_2 floor -> SAFE",
   run_rule("AZURE", "StorageAccount", R, config={"minimum_tls_version": "TLS1_2"}), SAFE)
eq("not yet collected -> NOT_SCANNED", run_rule("AZURE", "StorageAccount", R, config={}),
   NOT_SCANNED)
R = "OCI_COMPUTE_LEGACY_IMDS_ENABLED"
eq("legacy endpoints enabled -> VULNERABLE",
   run_rule("OCI", "ComputeInstance", R, config={"legacy_imds_disabled": False}), VULNERABLE)
eq("legacy endpoints disabled -> SAFE",
   run_rule("OCI", "ComputeInstance", R, config={"legacy_imds_disabled": True}), SAFE)
eq("not yet collected -> NOT_SCANNED", run_rule("OCI", "ComputeInstance", R, config={}),
   NOT_SCANNED)
R = "OCI_DEFAULT_SECLIST_WORLD_OPEN"
eq("default list with TCP from the world -> VULNERABLE",
   run_rule("OCI", "SecurityList", R, config={"is_default": True, "ingress_rules": [
       {"protocol": "6", "source": "0.0.0.0/0", "port_range": {"min": 22, "max": 22}}]}),
   VULNERABLE)
eq("default list with only ICMP from the world -> SAFE ('except ICMP')",
   run_rule("OCI", "SecurityList", R, config={"is_default": True, "ingress_rules": [
       {"protocol": "1", "source": "0.0.0.0/0"}]}), SAFE)
eq("a non-default list is not in scope",
   run_rule("OCI", "SecurityList", R, config={"is_default": False, "ingress_rules": []}), None)
eq("default list with rules not stored -> UNKNOWN",
   run_rule("OCI", "SecurityList", R, config={"is_default": True}), UNKNOWN)
R = "OCI_RESOURCE_IN_ROOT_COMPARTMENT"
eq("an instance in the root compartment -> VULNERABLE",
   run_rule("OCI", "ComputeInstance", R,
            metadata={"compartment_id": "ocid1.tenancy.oc1..aaa"}), VULNERABLE)
eq("an instance in a child compartment -> SAFE",
   run_rule("OCI", "ComputeInstance", R,
            metadata={"compartment_id": "ocid1.compartment.oc1..bbb"}), SAFE)
eq("compartment not recorded -> UNKNOWN", run_rule("OCI", "ComputeInstance", R, metadata={}),
   UNKNOWN)
eq("IAM policies are not in scope (they live in the root by design)",
   run_rule("OCI", "IAMPolicy", R, metadata={"compartment_id": "ocid1.tenancy.oc1..aaa"}),
   "NOT DISPATCHED")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. `*:*` is no longer invisible ===")
# ═════════════════════════════════════════════════════════════════════════════
admin = summarize_policy_documents([{"Statement": [
    {"Effect": "Allow", "Action": "*", "Resource": "*"}]}])
eq("Action * on Resource * summarises to '*:full'", admin["broad_access"], ["*:full"])
s3 = summarize_policy_documents([{"Statement": [
    {"Effect": "Allow", "Action": "s3:*", "Resource": "*"}]}])
eq("a service wildcard still summarises per service", s3["broad_access"], ["s3:full"])


def iam(rule_id, grants):
    return run_rule("AWS", "IAMRole", rule_id,
                    config={"broad_access": grants, "accessible_resources": []})


eq("the full-administrator rule fires on '*:full'", iam("AWS_IAM_ROLE_FULL_ADMIN", ["*:full"]),
   VULNERABLE)
eq("...and is CRITICAL", reg.RULES["AWS_IAM_ROLE_FULL_ADMIN"].severity, CRITICAL)
eq("...the wildcard rule does not report it a second time",
   iam("AWS_IAM_ROLE_WILDCARD_FULL", ["*:full"]), SAFE)
eq("...nor does the escalation rule", iam("AWS_IAM_ROLE_ESCALATION", ["*:full"]), SAFE)
eq("a role with s3:* is not an administrator", iam("AWS_IAM_ROLE_FULL_ADMIN", ["s3:full"]), SAFE)
eq("...but IS a service wildcard", iam("AWS_IAM_ROLE_WILDCARD_FULL", ["s3:full"]), VULNERABLE)
eq("write on every service ('*:write') is escalation",
   iam("AWS_IAM_ROLE_ESCALATION", ["*:write"]), VULNERABLE)
eq("policies never collected -> UNKNOWN, not 'no admin'",
   run_rule("AWS", "IAMRole", "AWS_IAM_ROLE_FULL_ADMIN", config={}), UNKNOWN)

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
