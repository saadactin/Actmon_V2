"""Configuration-drift classification rules. No DB, no network.

Covers the two things that decide whether this feature is usable at all:
what counts as a change (noise rejection), and what pillar/severity/direction a
real change gets.
"""
import pathlib
import sys
from enum import Enum

# Run as a plain script, so the project root is not on sys.path by default.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.utils.drift_rules import (
    CHANGE_MODIFIED,
    SECONDARY_LOOKUP_FIELDS,
    UNREADABLE_WHEN_EMPTY_FIELDS,
    DIR_MORE_OPEN,
    DIR_MORE_RESTRICTIVE,
    DIR_SCALE_DOWN,
    DIR_SCALE_UP,
    _is_empty,
    _is_lookup_artifact,
    classify_field_change,
    describe_field_change,
    diff_resource,
    render_value,
)

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class Stored:
    """Stands in for a CloudResource row already on file."""

    def __init__(self, **kw):
        self.resource_type = kw.get("resource_type", "ComputeInstance")
        self.resource_name = kw.get("resource_name", "vm-1")
        self.region_or_zone = kw.get("region_or_zone", "ap-mumbai-1")
        self.status = kw.get("status", "RUNNING")
        self.ip_address = kw.get("ip_address")
        self.config = kw.get("config", {})
        self.tags = kw.get("tags", {})
        self.metadata_ = kw.get("metadata_", {})


def scanned(**kw):
    """Stands in for what a scanner emits for the same resource."""
    out = {
        "resource_type": kw.get("resource_type", "ComputeInstance"),
        "resource_name": kw.get("resource_name", "vm-1"),
        "region_or_zone": kw.get("region_or_zone", "ap-mumbai-1"),
        "status": kw.get("status", "RUNNING"),
        "config": kw.get("config", {}),
        "tags": kw.get("tags", {}),
        "metadata": kw.get("metadata", {}),
    }
    if "ip_address" in kw:
        out["ip_address"] = kw["ip_address"]
    return out


def fields(changes):
    return {c["field_path"] for c in changes}


def one(changes, path):
    for c in changes:
        if c["field_path"] == path:
            return c
    return None


# ── 1. Noise rejection ────────────────────────────────────────────────────────
print("1. what must NOT be reported as drift")

check(
    "identical resource yields nothing",
    diff_resource(Stored(config={"shape": "E4", "ocpus": 2}), scanned(config={"shape": "E4", "ocpus": 2})) == [],
)

# Providers return collections in arbitrary order; a reorder is not a change.
reordered = diff_resource(
    Stored(config={"ingress_rules": [{"a": 1}, {"b": 2}, {"c": 3}]}),
    scanned(config={"ingress_rules": [{"c": 3}, {"a": 1}, {"b": 2}]}),
)
check("reordered rule list is not a change", reordered == [], f"got {fields(reordered)}")

scalar_reorder = diff_resource(
    Stored(config={"nsg_ids": ["b", "a"]}), scanned(config={"nsg_ids": ["a", "b"]})
)
check("reordered scalar list is not a change", scalar_reorder == [])

# Usage counters move on their own and would bury real drift.
counters = diff_resource(
    Stored(config={"item_count": 10, "size_bytes": 100, "available_ips": 250, "total_rules": 3}),
    scanned(config={"item_count": 99, "size_bytes": 999, "available_ips": 12, "total_rules": 9}),
)
check("usage counters are excluded", counters == [], f"got {fields(counters)}")

# A volume mirroring its instance's status would log one instance stop once per
# attached disk.
mirrors = diff_resource(
    Stored(config={"attached_to_status": "RUNNING", "attached_to_name": "vm-a"}),
    scanned(config={"attached_to_status": "STOPPED", "attached_to_name": "vm-b"}),
)
check("derived mirror fields are excluded", mirrors == [], f"got {fields(mirrors)}")

stamps = diff_resource(
    Stored(metadata_={"time_created": "2024-01-01", "last_modified": "2024-01-01"}),
    scanned(metadata={"time_created": "2024-01-02", "last_modified": "2025-09-09"}),
)
check("provider timestamps are excluded", stamps == [], f"got {fields(stamps)}")

# The scanner omitting a key is not the provider clearing it.
omitted = diff_resource(Stored(resource_name="vm-1"), {"resource_type": "ComputeInstance", "status": "RUNNING"})
check("omitted name/region keys are not read as cleared", fields(omitted) <= {"ip_address"}, f"got {fields(omitted)}")

# ── 2. Real changes are reported, once each ───────────────────────────────────
print("\n2. what MUST be reported")

multi = diff_resource(
    Stored(status="RUNNING", config={"ocpus": 2, "shape": "E4"}, tags={"env": "dev"}),
    scanned(status="STOPPED", config={"ocpus": 4, "shape": "E5"}, tags={"env": "prod"}),
)
check("one row per changed field", len(multi) == 4, f"{len(multi)} rows: {sorted(fields(multi))}")
check(
    "paths are container-qualified",
    fields(multi) == {"status", "config.ocpus", "config.shape", "tags.env"},
    str(sorted(fields(multi))),
)
check("every row is MODIFIED", all(c["change_type"] == CHANGE_MODIFIED for c in multi))
check("every row carries a summary", all(c["summary"] for c in multi))

added = diff_resource(Stored(config={}), scanned(config={"shape": "E4"}))
check("a key appearing is a change", fields(added) == {"config.shape"})
removed = diff_resource(Stored(config={"shape": "E4"}), scanned(config={}))
check("a key disappearing is a change", fields(removed) == {"config.shape"})

# ── 3. Pillar classification ──────────────────────────────────────────────────
print("\n3. which pillar a field lands on")

CASES = [
    ("config.ingress_rules", [{"a": 1}], [{"a": 1}, {"b": 2}], "security", "HIGH", None),
    ("config.statements", ["allow all"], ["allow all", "allow more"], "security", "HIGH", None),
    ("config.nsg_ids", ["a"], ["b"], "security", "HIGH", None),
    ("config.shape", "E4", "E5", "cost", "MEDIUM", None),
    ("config.size_gb", 50, 100, "cost", "MEDIUM", DIR_SCALE_UP),
    ("config.ocpus", 4, 2, "cost", "MEDIUM", DIR_SCALE_DOWN),
    ("config.attached_to_id", "ocid-a", None, "topology", "MEDIUM", None),
    ("config.subnet_id", "s-a", "s-b", "topology", "LOW", None),
    ("config.power_state", "running", "deallocated", "availability", "MEDIUM", None),
    ("metadata.compartment_name", "DEV", "PROD", "cost", "MEDIUM", None),
    ("metadata.administrator_login", "sa", "root", "security", "HIGH", None),
    ("tags.owner", "a", "b", "governance", "LOW", None),
]
for path, old, new, pillar, sev, direction in CASES:
    pillars, severity, got_dir = classify_field_change(path, old, new)
    check(
        f"{path} -> {pillar}/{sev}",
        pillar in pillars and severity == sev and got_dir == direction,
        f"got {pillars}/{severity}/{got_dir}",
    )

# status is deliberately both: the compute stops billing, the attached storage
# does not — which is the cost finding this product already reports.
pillars, _, _ = classify_field_change("status", "RUNNING", "STOPPED")
check("status is availability AND cost", set(pillars) == {"availability", "cost"}, str(pillars))

# An unknown field must stay unclassified rather than be guessed into a pillar.
pillars, severity, _ = classify_field_change("config.never_seen_before", 1, 2)
check("unknown field -> config/LOW", pillars == ["config"] and severity == "LOW", f"{pillars}/{severity}")

# ── 4. Direction, only where it is provable ───────────────────────────────────
print("\n4. direction is set only when the transition is unambiguous")

OPENINGS = [
    ("config.public_access_type", "NoPublicAccess", "ObjectRead"),
    ("config.allow_blob_public_access", False, True),
    ("config.public_network_access", "Disabled", "Enabled"),
    ("config.is_public", False, True),
    ("config.public_ip", None, "1.2.3.4"),          # presence-based
    ("config.public_ip_ids", [], ["/pip/1"]),       # presence-based
    ("config.fqdn", None, "app.example.com"),       # presence-based
    ("config.is_private", True, False),             # inverted
    ("config.public_access_block", True, False),    # inverted
]
for path, old, new in OPENINGS:
    pillars, severity, direction = classify_field_change(path, old, new)
    check(
        f"{path} opening -> CRITICAL/MORE_OPEN",
        direction == DIR_MORE_OPEN and severity == "CRITICAL",
        f"got {severity}/{direction}",
    )

for path, old, new in OPENINGS:
    # Closing the same field again is an improvement, not an incident.
    pillars, severity, direction = classify_field_change(path, new, old)
    leaf = path.rsplit(".", 1)[-1]
    # Branch on the actual transition, not on set membership: some fields in
    # SECONDARY_LOOKUP_FIELDS close by emptying out (public_ip -> None) and
    # others by flipping a flag (public_access_block False -> True). Only the
    # emptying case is what a failed follow-up lookup also produces.
    closes_by_emptying = _is_empty(old) and not _is_empty(new)
    if leaf in SECONDARY_LOOKUP_FIELDS and closes_by_emptying:
        # No direction may be claimed — see section 4c.
        check(
            f"{path} closing -> LOW, no direction (lookup could have failed)",
            severity == "LOW" and direction is None,
            f"got {severity}/{direction}",
        )
    else:
        check(
            f"{path} closing -> LOW/MORE_RESTRICTIVE",
            direction == DIR_MORE_RESTRICTIVE and severity == "LOW",
            f"got {severity}/{direction}",
        )

# A rule list growing is NOT evidence of widening — no direction may be claimed.
_, _, direction = classify_field_change("config.ingress_rules", [{"a": 1}], [{"a": 1}, {"b": 2}])
check("rule-count growth claims no direction", direction is None, str(direction))

# Nor may an unrecognised value on an exposure field.
_, _, direction = classify_field_change("config.public_access_type", "SomethingNew", "SomethingElse")
check("unrecognised exposure values claim no direction", direction is None, str(direction))

# ── 4b. "Absent last scan" must never be read as "just changed" ───────────────
# The highest-stakes rule here. Three OCI instances whose VNIC lookup came back
# empty on one sweep and populated on the next would each otherwise report
# "became reachable from the internet" — a CRITICAL alarm caused by a scan gap.
print("\n4b. a first-time-collected field claims no direction")

# `comparable_old` is a stored value the direction rules CAN reason about.
# For size_gb that has to be a number: "capacity increased" is not derivable
# from null -> 100, and claiming it would be the same overreach this guard
# exists to prevent.
for path, comparable_old, new in [
    ("config.public_ip", None, "1.2.3.4"),
    ("config.fqdn", None, "app.example.com"),
    ("config.size_gb", 50, 100),
    ("config.public_access_type", "NoPublicAccess", "ObjectRead"),
]:
    _, severity, direction = classify_field_change(path, None, new, False)
    check(
        f"{path} first-collected -> no direction",
        direction is None and severity != "CRITICAL",
        f"got {severity}/{direction}",
    )
    # The same field WITH a comparable stored value must still classify fully,
    # otherwise the guard would have silenced real findings too.
    _, severity, direction = classify_field_change(path, comparable_old, new, True)
    check(f"{path} with a real predecessor still classifies", direction is not None, f"got {direction}")

# Absent vs empty, end to end through diff_resource.
absent = diff_resource(Stored(config={}), scanned(config={"public_ip": "1.2.3.4"}))
check("absent key -> old_value is null, not a dash",
      len(absent) == 1 and absent[0]["old_value"] is None, str(absent))
check("absent key claims no direction", absent and absent[0]["direction"] is None)
check("absent key summary says it was not collected",
      absent and "not collected by the previous scan" in absent[0]["summary"],
      absent[0]["summary"] if absent else "")

explicit_null = diff_resource(
    Stored(config={"public_ip": None}), scanned(config={"public_ip": "1.2.3.4"})
)
check("explicitly-null key IS a real exposure change",
      len(explicit_null) == 1 and explicit_null[0]["direction"] == DIR_MORE_OPEN
      and explicit_null[0]["severity"] == "CRITICAL",
      f"{explicit_null[0]['severity']}/{explicit_null[0]['direction']}" if explicit_null else "none")
check("explicitly-null key renders a before value",
      explicit_null and explicit_null[0]["old_value"] == "-", str(explicit_null[0]["old_value"]) if explicit_null else "")

# A real column always has a predecessor, so this guard must not swallow it.
col = diff_resource(Stored(status=None), scanned(status="RUNNING"))
check("a table column is never treated as first-collected",
      len(col) == 1 and col[0]["old_value"] == "-", str(col))

# ── 4c. A flaky follow-up lookup must not read as a removal ───────────────────
# Live OCI data showed five instances churning private_ip/subnet_id in ONE sweep
# — four gaining, one losing. That is a failing VNIC lookup, not five people
# re-addressing instances.
print("\n4c. a secondary-lookup field emptying out is not escalated")

for path in ("config.private_ip", "config.public_ip", "config.subnet_id", "config.nsg_ids"):
    old = ["x"] if path.endswith("nsg_ids") else "10.0.0.5"
    new = [] if path.endswith("nsg_ids") else None
    pillars, severity, direction = classify_field_change(path, old, new, True)
    check(f"{path} emptying -> LOW/no direction",
          severity == "LOW" and direction is None, f"got {severity}/{direction}")

# But a genuine re-address (value -> different value) keeps full classification.
readdressed = diff_resource(
    Stored(config={"private_ip": "10.0.0.5"}), scanned(config={"private_ip": "10.0.0.9"})
)
check("a real re-address carries no ambiguity caveat",
      len(readdressed) == 1 and "unreadable this scan" not in readdressed[0]["summary"],
      readdressed[0]["summary"] if readdressed else "no row")
emptied = diff_resource(
    Stored(config={"private_ip": "10.0.0.5"}), scanned(config={"private_ip": None})
)
check("emptying summary states the ambiguity",
      emptied and "may have been unreadable this scan rather than removed" in emptied[0]["summary"],
      emptied[0]["summary"] if emptied else "")

# ip_address duplicates config.private_ip/public_ip from the same VNIC lookup,
# so tracking it too would report every address change twice.
dup = diff_resource(Stored(ip_address="10.0.0.5"), scanned(ip_address="10.0.0.9"))
check("ip_address is not tracked separately", dup == [], str(dup))

# ── 5. Value rendering ────────────────────────────────────────────────────────
print("\n5. rendered values stay short and readable")

check("None renders as a dash", render_value(None) == "-")
check("bool renders lowercase", render_value(True) == "true")
check("scalar list is joined", render_value(["a", "b"]) == "a, b")
check("dict list is counted", render_value([{"a": 1}, {"b": 2}]) == "2 items")
check("single dict list is singular", render_value([{"a": 1}]) == "1 item")
check("empty list is labelled", render_value([]) == "(empty)")
# Provider SDK enums. Azure's models subclass (str, Enum), and since Python 3.11
# str() on such a member yields "DiskState.RESERVED" instead of its value — a
# real disk state change was displayed as "Attached -> DiskState.RESERVED".
class _FakeSdkEnum(str, Enum):
    RESERVED = "Reserved"


check("a str-subclass SDK enum renders as its value",
      render_value(_FakeSdkEnum.RESERVED) == "Reserved",
      repr(render_value(_FakeSdkEnum.RESERVED)))
check("str() on that enum really is the trap being guarded",
      str(_FakeSdkEnum.RESERVED) != "Reserved", repr(str(_FakeSdkEnum.RESERVED)))
check("an enum-valued change reads cleanly end to end",
      describe_field_change("ManagedDisk", "config.disk_state", "Attached",
                            _FakeSdkEnum.RESERVED, None)
      == "ManagedDisk disk_state: Attached -> Reserved",
      describe_field_change("ManagedDisk", "config.disk_state", "Attached",
                            _FakeSdkEnum.RESERVED, None))
# Comparison was never broken, only display — but pin it so a future change to
# _canonical cannot start reporting an unchanged enum as drift.
check("an enum equal to its stored string is NOT a change",
      diff_resource(Stored(config={"disk_state": "Reserved"}),
                    scanned(config={"disk_state": _FakeSdkEnum.RESERVED})) == [])

long_rendered = render_value("x" * 5000)
check("long values are truncated", len(long_rendered) <= 400 and long_rendered.endswith("..."), f"len={len(long_rendered)}")

# ── 6. Fallible follow-up lookups, both directions ───────────────────────────
# Every AWS S3 per-bucket attribute comes from its own API call wrapped in a
# try/except that swallows the failure (aws_scanner._scan_s3), so a value can
# appear or vanish purely because that call failed or recovered. A live scan
# reported a bucket's public_access_block appearing as a HIGH security finding
# when the previous scan had simply been unable to read it.
print("\n6. a lookup failing or recovering is not a configuration change")

# Only the AWS S3 fields, where a stored None cannot be told apart from a call
# that failed. OCI VNIC fields are deliberately NOT here — see below.
RECOVERED = [
    ("config.public_access_block", None, {"BlockPublicAcls": True}),
    ("config.encryption", None, "AES256"),
    ("config.versioning", None, "Enabled"),
    ("config.lifecycle_rules", None, [{"ID": "expire"}]),
]
for path, old, new in RECOVERED:
    pillars, sev, direction = classify_field_change(path, old, new)
    check(f"{path.split('.')[-1]} appearing is LOW, no direction",
          sev == "LOW" and direction is None, f"{sev}/{direction}")
    summary = describe_field_change("S3Bucket", path, old, new, direction)
    check(f"{path.split('.')[-1]} appearing says the earlier scan may not have read it",
          "unable to read it" in summary, summary[:80])

VANISHED = [
    ("config.public_access_block", {"BlockPublicAcls": True}, None),
    ("config.encryption", "AES256", None),
    ("config.private_ip", "10.0.0.5", None),
]
for path, old, new in VANISHED:
    pillars, sev, direction = classify_field_change(path, old, new)
    check(f"{path.split('.')[-1]} vanishing is LOW, no direction",
          sev == "LOW" and direction is None, f"{sev}/{direction}")

# The narrower set must NOT swallow the OCI case. A stored null for a VNIC field
# is a real answer — the scanner only writes it when the lookup succeeded — so an
# instance gaining a public IP stays the CRITICAL exposure finding it is. This is
# the distinction that makes the AWS fix safe rather than a blanket silencer.
for path in ("config.public_ip",):
    _, sev, direction = classify_field_change(path, None, "1.2.3.4")
    check(f"{path} appearing is STILL a real exposure change",
          sev == "CRITICAL" and direction == DIR_MORE_OPEN, f"{sev}/{direction}")
for path, new in (("config.private_ip", "10.0.0.9"), ("config.subnet_id", "ocid1.subnet..a")):
    _, sev, direction = classify_field_change(path, None, new)
    summary = describe_field_change("ComputeInstance", path, None, new, direction)
    check(f"{path} appearing is not labelled a failed lookup",
          "unable to read it" not in summary, summary[:70])
# The invariant that keeps the fix from becoming a blanket silencer: the OCI
# VNIC fields must never be treated as ambiguous-when-appearing, because a
# stored null for them is a real answer and a public IP appearing is a genuine
# CRITICAL finding. The two sets overlap rather than nest — NSG rule fields are
# ambiguous when appearing but are not VNIC fields.
VNIC_FIELDS = {"public_ip", "private_ip", "subnet_id", "nsg_ids"}
check("OCI VNIC fields are never ambiguous-when-appearing",
      not (VNIC_FIELDS & UNREADABLE_WHEN_EMPTY_FIELDS),
      str(sorted(VNIC_FIELDS & UNREADABLE_WHEN_EMPTY_FIELDS)))
check("every VNIC field is still ambiguous-when-vanishing",
      VNIC_FIELDS <= SECONDARY_LOOKUP_FIELDS,
      str(sorted(VNIC_FIELDS - SECONDARY_LOOKUP_FIELDS)))

# lifecycle_rules is the one field _scan_s3 bothers to disambiguate: [] means
# "confirmed zero rules", None means "could not read". Treating [] as unreadable
# would hide a real rule being added.
# Asserted on the predicate itself: lifecycle_rules has a LOW base severity by
# design, so severity cannot tell the two cases apart here.
check("[] is a real answer, not an unreadable one",
      not _is_lookup_artifact("lifecycle_rules", [], [{"ID": "expire"}]))
check("None IS unreadable for the same field",
      _is_lookup_artifact("lifecycle_rules", None, [{"ID": "expire"}]))
check("[] -> rules is not labelled a failed lookup",
      "unable to read it" not in describe_field_change(
          "S3Bucket", "config.lifecycle_rules", [], [{"ID": "x"}], None))

# OCI NSG rules come from a separate per-NSG call that writes None on failure,
# so None on EITHER side is ambiguous. A live scan reported an NSG's rules going
# "1 item -> (empty)" as a HIGH security finding when the call had simply failed.
for old, new in ((None, [{"protocol": "6"}]), ([{"protocol": "6"}], None)):
    _, sev, direction = classify_field_change("config.ingress_rules", old, new)
    check(f"NSG ingress_rules {'appearing' if old is None else 'vanishing'} "
          f"from None is LOW", sev == "LOW" and direction is None, f"{sev}/{direction}")
# But rules genuinely being emptied — a real [] from a call that SUCCEEDED, which
# is what the SecurityList and Azure/AWS scanners emit — must stay HIGH.
_, sev, _ = classify_field_change("config.ingress_rules", [{"protocol": "6"}], [])
check("rules emptied by a SUCCESSFUL read is still HIGH", sev == "HIGH", sev)
_, sev, _ = classify_field_change("config.ingress_rules", [{"protocol": "6"}], [{"protocol": "all"}])
check("rules changing is still HIGH", sev == "HIGH", sev)
check("total_rules None is unreadable, 0 is a real count",
      _is_lookup_artifact("total_rules", None, 3)
      and not _is_lookup_artifact("total_rules", 0, 3))

# The scanner writes "unknown" when get_bucket_location throws. A bucket cannot
# change region, so this transition is only ever a lookup finally answering.
pillars, sev, direction = classify_field_change("region_or_zone", "unknown", "ap-south-1")
check("region unknown -> real is LOW and not a topology/cost event",
      sev == "LOW" and "topology" not in pillars and "cost" not in pillars,
      f"{sev}/{pillars}")
pillars, sev, direction = classify_field_change("region_or_zone", "ap-south-1", "unknown")
check("region real -> unknown is also LOW", sev == "LOW", sev)

# The whole point of restricting this to ONE-SIDED transitions: a real value
# changing to a different real value must keep its full classification.
GENUINE = [
    ("config.public_access_block", {"BlockPublicAcls": True}, {"BlockPublicAcls": False}, "HIGH"),
    ("config.encryption", "AES256", "aws:kms", "MEDIUM"),
    ("config.versioning", "Enabled", "Suspended", "MEDIUM"),
    ("config.private_ip", "10.0.0.5", "10.0.0.9", "LOW"),
    ("region_or_zone", "ap-south-1", "us-east-1", "MEDIUM"),
]
for path, old, new, want in GENUINE:
    pillars, sev, direction = classify_field_change(path, old, new)
    check(f"{path.split('.')[-1]} real -> real keeps severity {want}", sev == want,
          f"got {sev}")
check("region real -> real is still a topology/cost event",
      "topology" in classify_field_change("region_or_zone", "ap-south-1", "us-east-1")[0])

# And a bucket genuinely going public must still be the loudest thing here.
pillars, sev, direction = classify_field_change(
    "config.public_access_type", "NoPublicAccess", "ObjectRead")
check("a bucket going public is still CRITICAL / MORE_OPEN",
      sev == "CRITICAL" and direction == "MORE_OPEN", f"{sev}/{direction}")

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print(f"  FAILED: {f}")
sys.exit(1 if fail else 0)
