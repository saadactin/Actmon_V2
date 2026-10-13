"""Behavioural detection and incident correlation.

Run: venv\\Scripts\\python.exe tests\\verify_threat.py

Two properties carry this suite.

Section 6: a detector whose required field is never populated must report
UNAVAILABLE, not "nothing detected". On live data `source_location` is empty on
all 18,935 events, so impossible-travel can never fire — and a product that
renders that as a clean result is lying by omission.

Section 8: an incident must require two DIFFERENT kinds of signal. Grouping
three findings about one bucket and calling it an incident is the findings list
with extra ceremony, and it is how a correlation feature becomes noise.
"""
import pathlib
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import incident as inc
from app.security import threat
from app.security.model import CRITICAL, HIGH, MEDIUM

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


T0 = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)


class E:
    """Minimal stand-in for the CloudEvent ORM row."""
    def __init__(self, name="Op", minute=0, actor="alice", action="Other",
                 status="Success", risk="LOW", actor_type="Human",
                 resource_id=None, source_ip="1.2.3.4", source_location=None,
                 category="Other"):
        self.id = uuid.uuid4()
        self.event_name = name
        self.timestamp = T0 + timedelta(minutes=minute)
        self.actor_id = actor
        self.actor_name = actor
        self.actor_type = actor_type
        self.action = action
        self.status = status
        self.risk_level = risk
        self.event_category = category
        self.resource_id = resource_id
        self.resource_name = resource_id
        self.source_ip = source_ip
        self.source_location = source_location
        self.region = "ap-south-1"


def ids(result):
    return {d["detector_id"] for d in result["detections"]}


# ═════════════════════════════════════════════════════════════════════════════
print("1. Threshold detectors fire at the threshold, not before")
d = threat.DETECTORS_BY_ID["REPEATED_AUTH_FAILURE"]
under = threat.detect([E(status="Denied", minute=i) for i in range(d.threshold - 1)])
over = threat.detect([E(status="Denied", minute=i) for i in range(d.threshold)])
check("below threshold -> no detection", "REPEATED_AUTH_FAILURE" not in ids(under))
check("at threshold -> detection", "REPEATED_AUTH_FAILURE" in ids(over))
check("the detection carries every contributing event",
      over["detections"][0]["event_count"] == d.threshold,
      str(over["detections"][0]["event_count"]))

print("\n2. The window is real — the same events spread out do not fire")
spread = threat.detect([
    E(status="Denied", minute=i * (d.window_minutes + 5)) for i in range(d.threshold)
])
check("events outside the window do not accumulate",
      "REPEATED_AUTH_FAILURE" not in ids(spread), str(ids(spread)))

print("\n3. Grouping is per principal — two actors do not add up")
split = threat.detect(
    [E(status="Denied", minute=i, actor="alice") for i in range(d.threshold - 1)]
    + [E(status="Denied", minute=i, actor="bob") for i in range(d.threshold - 1)]
)
check("two principals below threshold stay below", "REPEATED_AUTH_FAILURE" not in ids(split))

print("\n4. Events with no actor are excluded and counted, never pooled")
anon = threat.detect([E(status="Denied", minute=i, actor=None) for i in range(50)])
check("unattributed events raise no detection", anon["total"] == 0, str(anon["total"]))
check("...and are counted", anon["events_without_actor"] == 50)
check("...with an explanation", bool(anon["events_without_actor_note"]))

print("\n5. Sequence detection requires the stages IN ORDER")
seq_events = [
    E(name="CreateUser", minute=0, action="Create"),
    E(name="CreateAccessKey", minute=10, action="Create"),
    E(name="AttachUserPolicy", minute=20, action="Update"),
]
check("the escalation sequence is detected in order",
      "PRIVILEGE_ESCALATION_SEQUENCE" in ids(threat.detect(seq_events)))
reordered = [
    E(name="AttachUserPolicy", minute=0, action="Update"),
    E(name="CreateAccessKey", minute=10, action="Create"),
]
check("a grant before an identity creation is not an escalation sequence",
      "PRIVILEGE_ESCALATION_SEQUENCE" not in ids(threat.detect(reordered)))
far_apart = [
    E(name="CreateUser", minute=0, action="Create"),
    E(name="CreateAccessKey", minute=10, action="Create"),
    E(name="AttachUserPolicy", minute=60 * 48, action="Update"),
]
check("stages beyond the window do not complete the sequence",
      "PRIVILEGE_ESCALATION_SEQUENCE" not in ids(threat.detect(far_apart)))
got = threat.detect(seq_events)["detections"][0]
check("the detection names each matched stage",
      [s["key"] for s in got["evidence"]["stages"]] == ["identity", "credential", "grant"])
check("...and reports elapsed time", got["evidence"]["elapsed_minutes"] == 20.0)

print("\n6. UNAVAILABLE is not the same as 'nothing detected'")
res = threat.detect([E(minute=i) for i in range(5)])
avail = res["availability"]["IMPOSSIBLE_TRAVEL"]
check("impossible-travel is unavailable when source_location is never populated",
      avail["available"] is False)
check("...the missing field is named", "source_location" in avail["missing_fields"])
check("...and the reason says empty means 'not detectable'",
      "not detectable" in (avail["reason"] or ""))
check("it appears in unavailable_detectors",
      "IMPOSSIBLE_TRAVEL" in res["unavailable_detectors"])
check("empty_means distinguishes 'no match' from 'could not run'",
      "could not run" in res["empty_means"])
check("a detector whose fields ARE present is available",
      res["availability"]["REPEATED_AUTH_FAILURE"]["available"] is True)
with_loc = threat.detect([E(minute=i, source_location="IN-MH") for i in range(3)])
check("populating the field makes the detector available again",
      with_loc["availability"]["IMPOSSIBLE_TRAVEL"]["available"] is True)

print("\n7. Collapsing — one row per principal per detector, nothing lost")
bursts = []
for day in range(4):
    bursts += [E(status="Denied", minute=day * 2000 + i) for i in range(d.threshold)]
coll = threat.detect(bursts)
rows = [x for x in coll["detections"] if x["detector_id"] == "REPEATED_AUTH_FAILURE"]
check("four separate bursts collapse to one row", len(rows) == 1, str(len(rows)))
check("...recording how many occurrences", rows[0]["occurrences"] == 4,
      str(rows[0]["occurrences"]))
check("...and the total events across them",
      rows[0]["event_count"] == 4 * d.threshold, str(rows[0]["event_count"]))
check("...keeping each window as evidence",
      len(rows[0]["evidence"]["occurrence_windows"]) == 4)
check("raw window count is still reported", coll["total_windows"] == 4,
      str(coll["total_windows"]))

print("\n8. A detection states that it is not an accusation")
check("every detection carries the disclaimer, and it denies judging intent",
      all("not a judgement about intent" in x["not_an_accusation"].lower()
          and "read the events" in x["not_an_accusation"].lower()
          for x in coll["detections"]))
check("the escalation detector's rationale says so explicitly",
      "NOT because it is" in threat.DETECTORS_BY_ID[
          "PRIVILEGE_ESCALATION_SEQUENCE"].rationale)
check("every detector declares a recommended action",
      all(dd.recommended_action for dd in threat.DETECTORS))

print("\n9. Incidents need two DIFFERENT kinds of signal")


class F:
    def __init__(self, rid, key, sev=HIGH, title=None):
        self.rule_id = rid
        self.fingerprint = f"fp-{rid}-{key}"
        self.resource_key = key
        self.resource_id = key
        self.severity = sev
        self.title = title or rid
        self.category = "Networking"
        self.verdict = "VULNERABLE"
        self.status = "OPEN"
        self.first_detected_at = T0


class Res:
    def __init__(self, key, name, rtype="EC2Instance"):
        self.id = key
        self.resource_key = key
        self.provider_resource_id = key
        self.resource_name = name
        self.resource_type = rtype


only_findings = inc.correlate(
    findings=[F("R1", "vm-1"), F("R2", "vm-1"), F("R3", "vm-1")],
    resources=[Res("vm-1", "web")],
)
check("three findings on one resource are NOT an incident",
      only_findings["total"] == 0, str(only_findings["total"]))

detection = {
    "detection_id": "d1", "detector_id": "MASS_DELETION", "title": "Bulk deletion",
    "severity": CRITICAL, "first_seen": T0.isoformat(), "actor_id": "mallory",
    "actor_name": "mallory", "event_count": 20, "occurrences": 1,
    "events": [{"resource_id": "vm-1", "event_name": "DeleteObject"}],
}
mixed = inc.correlate(
    findings=[F("R1", "vm-1")],
    detections=[detection],
    resources=[Res("vm-1", "web")],
)
check("a finding plus a detection IS an incident", mixed["total"] >= 1,
      str(mixed["total"]))
res_inc = next(i for i in mixed["incidents"] if i["subject_kind"] == "resource")
check("severity is the WORST signal, not a sum", res_inc["severity"] == CRITICAL,
      res_inc["severity"])
check("both signal kinds are listed",
      set(res_inc["signal_kinds"]) == {"finding", "detection"},
      str(res_inc["signal_kinds"]))
check("the subject is named from the resource", res_inc["subject_name"] == "web")

print("\n10. Correlation states its basis and refuses to claim causation")
check("the join field is named", res_inc["correlation_basis"] == "resource")
check("...with what that join means", "matched on the provider" in res_inc["correlation_meaning"])
check("every incident says it is not causal",
      "inference this product does not make" in res_inc["not_causal"])
check("the method explains the two-kind rule",
      "DIFFERENT kinds" in mixed["method"])
check("an actor-basis join is labelled as the weaker one",
      "ordinary for an administrator" in inc.BASIS_MEANING[inc.BASIS_ACTOR])
check("a timeline is built from signals that have timestamps",
      res_inc["timeline_available"] is True)
check("the summary is descriptive, not accusatory",
      "concern" in res_inc["summary"] and "attack" not in res_inc["summary"].lower(),
      res_inc["summary"])

print("\n11. One resource is ONE subject, whichever identifier a signal used")
# The bug this pins: a finding carries `resource_key` (the provider's id) while
# an attack path node carries the inventory row id. Without an alias map the
# same VM became two incidents — it appeared twice in the live Azure list, once
# under its ARM id and once under its row id, double-counting the worst hosts.
class OrmRes:
    """Shaped like the real CloudResource row: id + provider_resource_id."""
    def __init__(self, row_id, provider_id, name):
        self.id = row_id
        self.provider_resource_id = provider_id
        self.resource_name = name
        self.resource_type = "VirtualMachine"


ARM = "/subscriptions/x/resourceGroups/DEV/providers/Microsoft.Compute/virtualMachines/vm1"
finding_on_arm = F("R1", ARM, sev=CRITICAL)
path_on_rowid = {
    "path_id": "p1", "length": 2, "confidence": "HIGH",
    "path_class_label": "Direct routed path",
    "risk": {"band": HIGH, "points": 70},
    "target": {"name": "disk"},
    "nodes": [{"id": "row-1"}, {"id": "disk-1"}],
}
joined = inc.correlate(
    findings=[finding_on_arm],
    attack_paths=[path_on_rowid],
    resources=[OrmRes("row-1", ARM, "vm1")],
)
vm_incidents = [i for i in joined["incidents"] if i["subject_name"] == "vm1"]
check("the two identifiers collapse to one incident", len(vm_incidents) == 1,
      str([i["subject_id"] for i in joined["incidents"]]))
check("...carrying both signal kinds",
      vm_incidents and set(vm_incidents[0]["signal_kinds"]) == {"finding", "attack_path"},
      str(vm_incidents[0]["signal_kinds"]) if vm_incidents else "none")
check("...named from inventory rather than shown as a raw ARM id",
      vm_incidents and vm_incidents[0]["subject_name"] == "vm1")
check("no incident is keyed on the raw provider id once the row is known",
      ARM not in {i["subject_id"] for i in joined["incidents"]},
      str({i["subject_id"] for i in joined["incidents"]}))
unknown = inc.correlate(
    findings=[F("R1", "ghost"), ],
    detections=[{**detection, "events": [{"resource_id": "ghost"}]}],
    resources=[],
)
check("a resource absent from inventory is still a subject, not dropped",
      any(i["subject_id"] == "ghost" for i in unknown["incidents"]),
      str([i["subject_id"] for i in unknown["incidents"]]))

print("\n12. Incidents never invent inputs they were not given")
empty = inc.correlate()
check("no inputs -> no incidents", empty["total"] == 0)
check("...and empty_means says that is a good result",
      "normal and good" in empty["empty_means"])
check("input counts are reported honestly",
      empty["inputs"] == {"findings": 0, "detections": 0, "attack_paths": 0,
                          "exposed_resources": 0},
      str(empty["inputs"]))

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
