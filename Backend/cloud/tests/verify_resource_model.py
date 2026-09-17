"""Resource normalization: status, type, freshness, tags, placement. No DB.

Run: venv\\Scripts\\python.exe tests\\verify_resource_model.py

Section 1 is the reason this file exists. Three providers use three different
vocabularies for "what state is this in", and every previous consumer invented
its own reading of them. The rule under test throughout: a missing value is
never upgraded into a good one.
"""
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import resource_model as rm

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


print("1. UNKNOWN IS NEVER UPGRADED INTO HEALTHY")
v = rm.normalize_status("S3Bucket", None, None)
check("a null status is UNKNOWN", v.normalized == rm.UNKNOWN, v.normalized)
check("...not AVAILABLE", v.normalized != rm.AVAILABLE)
check("...and it says why", bool(v.reason) and "did not report" in v.reason)
check("the raw value stays None", v.raw is None)

v = rm.normalize_status("EC2Instance", "", None)
check("an empty-string status is also UNKNOWN", v.normalized == rm.UNKNOWN)

v = rm.normalize_status("ComputeInstance", "Wibbling", None)
check("an UNRECOGNIZED status is UNKNOWN, not guessed", v.normalized == rm.UNKNOWN)
check("...and the provider's own word is preserved", v.raw == "Wibbling")
check("...and quoted back in the reason", "'Wibbling'" in (v.reason or ""))

print("\n2. THE AZURE VM TRAP: 'Succeeded' is not 'running'")
# 57 of this estate's 75 Azure VMs are in exactly this state.
v = rm.normalize_status("VirtualMachine", "Succeeded", {})
check("a VM with no power state is UNKNOWN", v.normalized == rm.UNKNOWN, v.normalized)
check("...specifically NOT RUNNING", v.normalized != rm.RUNNING)
check("...and NOT AVAILABLE either", v.normalized != rm.AVAILABLE)
check("the reason explains provisioning != power",
      "provisioning state" in (v.reason or "") and "power state" in (v.reason or ""))
check("the reason names the permission that would fix it",
      "instanceView" in (v.reason or ""), v.reason or "")
check("the provider's word survives", v.raw == "Succeeded")

v = rm.normalize_status("VirtualMachine", "Succeeded", {"power_state": "VM running"})
check("WITH a power state it resolves to RUNNING", v.normalized == rm.RUNNING)
check("...and raw becomes the power state, not the provisioning state",
      v.raw == "VM running")

v = rm.normalize_status("VirtualMachine", "Succeeded", {"power_state": "VM deallocated"})
check("deallocated is STOPPED", v.normalized == rm.STOPPED)

# A non-VM Azure resource has no separate power state, so Succeeded IS its answer.
v = rm.normalize_status("StorageAccount", "Succeeded", {})
check("a storage account's 'Succeeded' is AVAILABLE", v.normalized == rm.AVAILABLE)
check("...with no reason needed", v.reason is None)

print("\n3. 'ACTIVE' is not 'RUNNING'")
# An OCI VCN, an IAM policy and a queue are all ACTIVE. None of them runs.
check("ACTIVE maps to AVAILABLE",
      rm.normalize_status("VCN", "ACTIVE", None).normalized == rm.AVAILABLE)
check("RUNNING maps to RUNNING",
      rm.normalize_status("ComputeInstance", "RUNNING", None).normalized == rm.RUNNING)
check("the two are distinct", rm.AVAILABLE != rm.RUNNING)

print("\n4. Every provider's real vocabulary resolves")
# Taken verbatim from this estate's status column.
for rtype, raw, expected in [
    ("BlockVolume", "AVAILABLE", rm.AVAILABLE),
    ("IAMPolicy", "ACTIVE", rm.AVAILABLE),
    ("ComputeInstance", "RUNNING", rm.RUNNING),
    ("ComputeInstance", "STOPPED", rm.STOPPED),
    ("BlockVolume", "ATTACHED", rm.ATTACHED),
    ("FileSystem", "PROVISIONED", rm.AVAILABLE),
    ("EBSVolume", "available", rm.AVAILABLE),
    ("DynamoDBTable", "ACTIVE", rm.AVAILABLE),
    ("AppService", "Online", rm.AVAILABLE),
    ("SQLDatabase", "Ready", rm.AVAILABLE),
    ("NetworkInterface", "Succeeded", rm.AVAILABLE),
]:
    got = rm.normalize_status(rtype, raw, None)
    check(f"{rtype}/{raw!r} -> {expected}", got.normalized == expected, got.normalized)

print("\n5. Status sorts by how much you should care, not alphabetically")
order = rm.STATUS_SORT_ORDER
check("FAILED sorts before RUNNING", order[rm.FAILED] < order[rm.RUNNING])
check("RUNNING sorts before STOPPED", order[rm.RUNNING] < order[rm.STOPPED])
check("UNKNOWN sorts last", order[rm.UNKNOWN] == max(order.values()))
check("alphabetical would be wrong: ATTACHED < FAILED alphabetically",
      "ATTACHED" < "FAILED" and order[rm.ATTACHED] > order[rm.FAILED])
check("every normalized status has an order",
      set(order) == set(rm.NORMALIZED_STATUSES))

print("\n6. Type classification never drops a resource")
info = rm.normalize_type("EC2Instance")
check("a known type is COMPUTE", info.category == rm.COMPUTE)
check("...and is marked known", info.known is True)
check("...with a human label", info.label == "EC2 Instance", info.label)

# Azure's ARM type set is open-ended and grows without us.
info = rm.normalize_type("Microsoft.Fabricated/newThingDatabases")
check("an unheard-of type still lands somewhere",
      info.category in rm.CATEGORIES, info.category)
check("...and is marked NOT known, so the UI can say so", info.known is False)
check("...heuristically as a database", info.category == rm.DATABASE)

info = rm.normalize_type("TotallyOpaqueWidget")
check("something with no signal at all becomes OTHER", info.category == rm.OTHER)
check("...but keeps its own name", info.resource_type == "TotallyOpaqueWidget")

check("None does not raise", rm.normalize_type(None).category == rm.OTHER)
check("empty string does not raise", rm.normalize_type("").resource_type == "Unknown")

print("\n7. The specific-before-generic ordering holds")
# 'SecurityGroup' contains 'group', which is an IDENTITY signal. Specificity
# must win, or every security group is filed under Identity.
check("SecurityGroup is SECURITY, not IDENTITY",
      rm.normalize_type("SecurityGroup").category == rm.SECURITY)
check("NetworkSecurityGroup is SECURITY too",
      rm.normalize_type("NetworkSecurityGroup").category == rm.SECURITY)
check("IAMGroup really is IDENTITY",
      rm.normalize_type("IAMGroup").category == rm.IDENTITY)
# 'AuroraCluster' contains 'cluster' (DATABASE) — correct — but 'EKSCluster'
# must not be swept up by it.
check("EKSCluster is CONTAINER, from the registry",
      rm.normalize_type("EKSCluster").category == rm.CONTAINER)

print("\n8. Every registry entry is internally consistent")
registry = rm.type_registry()
check("the registry is non-trivial", len(registry) > 80, str(len(registry)))
bad_category = [e for e in registry if e["category"] not in rm.CATEGORIES]
check("every entry has a real category", not bad_category, str(bad_category[:3]))
missing_label = [e for e in registry if not e["category_label"]]
check("every category has a label", not missing_label)
check("every category is labelled", set(rm.CATEGORY_LABELS) == set(rm.CATEGORIES))
check("every category has an icon", set(rm.CATEGORY_ICONS) == set(rm.CATEGORIES))

print("\n9. Freshness is graded, and 'never' is its own state")
now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
f = rm.freshness(now - timedelta(hours=2), now=now)
check("2 hours old is FRESH", f.severity == rm.FRESH)
check("...and not stale", f.stale is False)
check("...with a readable label", f.label == "2 hours ago", f.label)

check("3 days old is AGING",
      rm.freshness(now - timedelta(days=3), now=now).severity == rm.AGING)
check("14 days old is STALE",
      rm.freshness(now - timedelta(days=14), now=now).severity == rm.STALE)
check("2 months old is CRITICALLY_STALE",
      rm.freshness(now - timedelta(days=60), now=now).severity == rm.CRITICALLY_STALE)

f = rm.freshness(None, now=now)
check("never observed is its own severity", f.severity == rm.NEVER_SEEN)
check("...counts as stale", f.stale is True)
check("...and reports no age rather than 0", f.age_days is None)
check("...which is NOT the same as brand new",
      rm.freshness(now, now=now).severity == rm.FRESH)

f = rm.freshness(datetime(2026, 9, 15, 10, 0), now=now)  # naive input
check("a naive datetime is read as UTC rather than crashing",
      f.severity == rm.FRESH, f.severity)

print("\n10. AGING already counts as stale")
# The threshold is a judgement call, so it is stated once and tested: a week of
# unobserved change is long enough that the view must not present as current.
check("FRESH is not stale", not rm.freshness(now - timedelta(hours=1), now=now).stale)
check("AGING is stale", rm.freshness(now - timedelta(days=3), now=now).stale)
check("the boundary is documented as AGING", rm.STALE_AT == rm.AGING)

print("\n11. Tags are matched case-insensitively, and absence is None")
check("Owner is found", rm.owner_of({"Owner": "platform"}) == "platform")
check("owner (lower) is found too", rm.owner_of({"owner": "platform"}) == "platform")
check("CreatedBy is an owner signal", rm.owner_of({"CreatedBy": "saad"}) == "saad")
check("no owner tag returns None, not 'unknown'", rm.owner_of({"Customer": "x"}) is None)
check("None tags return None", rm.owner_of(None) is None)
check("an empty tag value is not an owner", rm.owner_of({"Owner": ""}) is None)
check("a non-dict does not raise", rm.owner_of("not a dict") is None)

check("Environment is found", rm.environment_of({"Environment": "prod"}) == "prod")
check("env alias works", rm.environment_of({"env": "dev"}) == "dev")
check("no environment tag is None", rm.environment_of({"Type": "vm"}) is None)

check("tag_count counts", rm.tag_count({"a": 1, "b": 2}) == 2)
check("tag_count of None is 0", rm.tag_count(None) == 0)

print("\n12. Required tags default to NOTHING")
# Shipping a default list of Environment/Owner/CostCenter would immediately
# report a governance failure rate this platform invented rather than one the
# organization declared.
os.environ.pop("CLOUD_REQUIRED_TAG_KEYS", None)
check("no required tags are assumed", rm.required_tag_keys() == [])
check("so nothing is ever 'missing'", rm.missing_required_tags({}) == [])

os.environ["CLOUD_REQUIRED_TAG_KEYS"] = "Environment,Owner"
check("configured keys are honoured", rm.required_tag_keys() == ["Environment", "Owner"])
check("both missing are reported",
      rm.missing_required_tags({}) == ["Environment", "Owner"])
check("a present one is not reported",
      rm.missing_required_tags({"Owner": "x"}) == ["Environment"])
check("case-insensitive match counts as present",
      rm.missing_required_tags({"owner": "x", "environment": "p"}) == [])
os.environ.pop("CLOUD_REQUIRED_TAG_KEYS", None)

print("\n13. Placement is read from metadata, where the scanners actually put it")
# Verified against 804/826 Azure rows and 476/476 OCI rows: resource_group and
# compartment_name live in metadata, not config. An earlier reading of this
# looked only in config and would have found neither.
place = rm.placement({"resource_group": "KTL-IOT"}, {})
check("Azure resource group comes from metadata", place["resource_group"] == "KTL-IOT")
place = rm.placement({"compartment_name": "prod"}, {})
check("OCI compartment comes from metadata", place["compartment"] == "prod")
place = rm.placement({}, {"resource_group": "fallback"})
check("config is still searched as a fallback", place["resource_group"] == "fallback")
place = rm.placement(None, None)
check("nothing anywhere gives None, not ''", place["resource_group"] is None)
check("availability zone reads several spellings",
      rm.placement({"availability_domain": "AD-1"}, {})["availability_zone"] == "AD-1")

print("\n14. Attachment applies only where the question makes sense")
check("an unattached disk is UNATTACHED",
      rm.attachment_state("BlockVolume", {"attachment_status": "Unattached"}) == rm.UNATTACHED)
check("an attached disk is ATTACHED",
      rm.attachment_state("ManagedDisk", {"attachment_status": "Attached"}) == rm.ATTACHED)
check("a SUBNET is not an unattached disk",
      rm.attachment_state("Subnet", {"attachment_status": "Unattached"}) is None)
check("a disk with no attachment field is None, not UNATTACHED",
      rm.attachment_state("BlockVolume", {}) is None)
check("None config does not raise", rm.attachment_state("BlockVolume", None) is None)

print("\n15. The 'default resource' definition is shared, not re-derived")
check("a resource named default is default",
      rm.is_default_resource("default", None) is True)
check("case does not matter", rm.is_default_resource("Default", None) is True)
check("the config flag also counts",
      rm.is_default_resource("my-vpc", {"is_default": True}) is True)
check("an ordinary resource is not default",
      rm.is_default_resource("prod-vpc", {}) is False)
check("None name does not raise", rm.is_default_resource(None, None) is False)

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
