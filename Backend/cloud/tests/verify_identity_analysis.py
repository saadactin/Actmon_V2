"""Usage, dormancy, credentials, MFA, trust, blast radius, right-sizing, anomaly.

No database, no network. The through-line of this suite is §35 — never convert
missing data into a reassuring value — because every analyser here has a
tempting shortcut that produces a confident, actionable, wrong answer:

* usage: calling a permission "unused" when the audit log simply does not
  record it, and proposing its removal;
* dormancy: calling an identity dormant when the provider publishes no
  last-used date at all, which on Azure is most service principals;
* credentials: treating "no last-used date" as "never used", which turns a data
  gap into a deletion recommendation;
* MFA: counting workload identities as MFA failures, which buries the one human
  admin who actually has none;
* blast radius: reporting a small number over a failed inventory sweep, where
  the small number reads as good news;
* anomaly: calling a second data point a behavioural change.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging  # noqa: E402

logging.disable(logging.CRITICAL)

from datetime import datetime, timedelta, timezone  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from app.identity import anomaly, blast_radius as br, dormancy, rightsizing  # noqa: E402
from app.identity import trust as trust_mod  # noqa: E402
from app.identity import usage as usage_mod  # noqa: E402
from app.identity.model import (  # noqa: E402
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_WORKLOAD, AWS, AZURE, DORMANCY_ACTIVE,
    DORMANCY_DORMANT, DORMANCY_NEVER_USED, DORMANCY_UNKNOWN, EXTERNAL_ANONYMOUS,
    EXTERNAL_NO, EXTERNAL_UNKNOWN, EXTERNAL_YES, MFA_DISABLED, MFA_ENABLED,
    MFA_NOT_APPLICABLE, MFA_UNKNOWN, OCI, PRIV_ADMIN, PRIV_PRIVILEGED, RECO_DELETE,
    RECO_DISABLE, RECO_INVESTIGATE, RECO_NONE, RECO_ROTATE, USAGE_NOT_OBSERVED_HIGH,
    USAGE_NOT_OBSERVED_LOW, USAGE_OBSERVED, USAGE_UNKNOWN,
)

ok, fail = [], []
NOW = datetime(2026, 10, 3, 12, 0, 0, tzinfo=timezone.utc)


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


def event(action, source="s3.amazonaws.com", when=None, status="SUCCESS",
          region="us-east-1", resource="bucket-1", ip="10.1.2.3"):
    return SimpleNamespace(
        api_operation=f"{source}:{action}", event_name=action, event_source=source,
        timestamp=when or NOW - timedelta(days=1), status=status, region=region,
        resource_id=resource, resource_name=resource, source_ip=ip,
    )


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== A. Event actions normalise to the permission a policy names ===")
# ═════════════════════════════════════════════════════════════════════════════
eq("CloudTrail source+name becomes an IAM action",
   usage_mod.normalize_event_action(
       AWS, api_operation="s3.amazonaws.com:GetObject"), "s3:GetObject")
eq("Azure operationName is already the RBAC operation",
   usage_mod.normalize_event_action(
       AZURE, api_operation="Microsoft.Compute/virtualMachines/write"),
   "Microsoft.Compute/virtualMachines/write")
# OCI: a cloud-event type carries the service but NOT the policy verb.
eq("an OCI event maps to a resource family with the verb left unknown",
   usage_mod.normalize_event_action(
       OCI, api_operation="com.oraclecloud.virtualnetwork.createvcn"),
   "?:virtual-network-family")
eq("an unmappable OCI event returns None rather than a guess",
   usage_mod.normalize_event_action(
       OCI, api_operation="com.oraclecloud.somethingnew.dosomething"), None)
eq("an empty event returns None", usage_mod.normalize_event_action(AWS), None)

observations, total, unmappable = usage_mod.aggregate_events(
    AWS, [event("GetObject"), event("GetObject"), event("PutObject")])
eq("events aggregate per action", sorted(observations), ["s3:GetObject", "s3:PutObject"])
eq("counts are per action", observations["s3:GetObject"].event_count, 2)
eq("the total is reported", total, 3)
eq("unmappable events are counted separately", unmappable, 0)

_, _, unmappable2 = usage_mod.aggregate_events(
    OCI, [SimpleNamespace(api_operation="garbage", event_name=None, event_source=None,
                          timestamp=NOW, status="SUCCESS", region=None,
                          resource_id=None, resource_name=None, source_ip=None)])
eq("an event that cannot be mapped is reported, not silently dropped", unmappable2, 1)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== B. Usage never says 'unused' — and knows when it knows nothing ===")
# ═════════════════════════════════════════════════════════════════════════════
good_window = usage_mod.Window.trailing(90, end=NOW)
good_window.events_in_window = 500_000

state, reason = usage_mod.classify_usage(AWS, "ec2:TerminateInstances",
                                         observed=False, window=good_window)
eq("a control-plane action unseen over a long busy window is HIGH confidence",
   state, USAGE_NOT_OBSERVED_HIGH)
check("and the reason names the window", "90" in (reason or ""))

state2, reason2 = usage_mod.classify_usage(AWS, "s3:GetObject", observed=False,
                                           window=good_window)
eq("a DATA-PLANE action unseen is only LOW confidence", state2,
   USAGE_NOT_OBSERVED_LOW)
check("and the reason explains that it is not recorded by default",
      "data-plane" in (reason2 or "").lower())

short = usage_mod.Window.trailing(7, end=NOW)
short.events_in_window = 500_000
state3, reason3 = usage_mod.classify_usage(AWS, "ec2:TerminateInstances",
                                           observed=False, window=short)
eq("a short window downgrades confidence", state3, USAGE_NOT_OBSERVED_LOW)
check("and says the window is too short", "7 days" in (reason3 or ""))

quiet = usage_mod.Window.trailing(90, end=NOW)
quiet.events_in_window = 11
state4, reason4 = usage_mod.classify_usage(AWS, "ec2:TerminateInstances",
                                           observed=False, window=quiet)
eq("a window with too few events downgrades confidence", state4,
   USAGE_NOT_OBSERVED_LOW)
check("and says how few", "11" in (reason4 or ""))

no_source = usage_mod.Window.trailing(90, end=NOW)
no_source.source_available = False
state5, _ = usage_mod.classify_usage(AWS, "ec2:TerminateInstances", observed=False,
                                     window=no_source)
eq("with no audit source at all the answer is UNKNOWN", state5, USAGE_UNKNOWN)

state6, reason6 = usage_mod.classify_usage(OCI, "manage:object-family", observed=False,
                                           window=good_window)
eq("OCI is always UNKNOWN — its events do not name a policy verb", state6,
   USAGE_UNKNOWN)
check("and says why", "verb" in (reason6 or "").lower())

eq("an observed action is OBSERVED",
   usage_mod.classify_usage(AWS, "s3:GetObject", observed=True,
                            window=good_window)[0], USAGE_OBSERVED)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== C. correlate() ties grants to evidence and names removal candidates ===")
# ═════════════════════════════════════════════════════════════════════════════
obs, total, unmapped = usage_mod.aggregate_events(
    AWS, [event("GetObject"), event("PutObject")])
window = usage_mod.Window.trailing(90, end=NOW)
window.events_in_window = 500_000
summary = usage_mod.correlate(
    AWS, granted_patterns=["s3:*", "ec2:TerminateInstances", "iam:PassRole"],
    observations=obs, window=window, unmappable_events=unmapped)

eq("every granted pattern is accounted for", summary["granted_pattern_count"], 3)
eq("the exercised pattern is counted", summary["exercised_pattern_count"], 1)
eq("the unexercised ones are counted", summary["unexercised_pattern_count"], 2)
check("the window travels with the summary", summary["window"]["days"] == 90)
check("s3:* is exercised because GetObject falls under it",
      any(p["pattern"] == "s3:*" and p["usage_state"] == USAGE_OBSERVED
          for p in summary["patterns"]))
check("unexercised control-plane grants become removal candidates",
      "ec2:TerminateInstances" in summary["removal_candidates"])
check("every removal candidate is HIGH confidence",
      all(p["usage_state"] == USAGE_NOT_OBSERVED_HIGH
          for p in summary["patterns"]
          if p["pattern"] in summary["removal_candidates"]))
check("the summary states why no granted-action total is shown",
      "catalog" in (summary.get("utilization_note") or ""))
check("utilization is a real percentage when there is evidence",
      usage_mod.utilization_percent(summary) is not None)

blind_summary = usage_mod.correlate(
    AWS, granted_patterns=["s3:GetObject"], observations={}, window=window)
eq("a data-plane grant with no events is NOT a removal candidate",
   blind_summary["removal_candidates"], [])

no_src = usage_mod.Window.trailing(90, end=NOW)
no_src.source_available = False
dark = usage_mod.correlate(AWS, granted_patterns=["ec2:TerminateInstances"],
                           observations={}, window=no_src)
eq("with no audit source nothing is proposed for removal",
   dark["removal_candidates"], [])
eq("and utilization is withheld rather than reported as 0%",
   usage_mod.utilization_percent(dark), None)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== D. Dormancy: UNKNOWN when the provider does not say ===")
# ═════════════════════════════════════════════════════════════════════════════
v = dormancy.assess_identity(
    actor_class=ACTOR_HUMAN, last_used_at=NOW - timedelta(days=174),
    last_used_source="provider", provider_reports_last_used=True, now=NOW)
eq("an identity unused past the threshold is DORMANT", v.state, DORMANCY_DORMANT)
eq("and the day count is exact", v.days_since_use, 174)

v2 = dormancy.assess_identity(
    actor_class=ACTOR_HUMAN, last_used_at=NOW - timedelta(days=3),
    last_used_source="provider", provider_reports_last_used=True, now=NOW)
eq("a recently used identity is ACTIVE", v2.state, DORMANCY_ACTIVE)

v3 = dormancy.assess_identity(
    actor_class=ACTOR_WORKLOAD, last_used_at=None, last_used_source=None,
    provider_reports_last_used=False, event_log_covers_identity=True, now=NOW)
eq("no provider last-used data means UNKNOWN, NOT dormant", v3.state, DORMANCY_UNKNOWN)
check("and the reason names the gap", "does not report" in v3.reason)

v4 = dormancy.assess_identity(
    actor_class=ACTOR_HUMAN, last_used_at=None, last_used_source=None,
    provider_reports_last_used=True, event_log_covers_identity=True, now=NOW)
eq("both sources working and neither seeing use is NEVER_USED", v4.state,
   DORMANCY_NEVER_USED)

v5 = dormancy.assess_identity(
    actor_class=ACTOR_HUMAN, last_used_at=None, last_used_source=None,
    provider_reports_last_used=True, event_log_covers_identity=False, now=NOW)
eq("a missing audit trail makes it UNKNOWN rather than never-used", v5.state,
   DORMANCY_UNKNOWN)

v6 = dormancy.assess_identity(
    actor_class=ACTOR_GROUP, last_used_at=None, last_used_source=None,
    provider_reports_last_used=False, now=NOW)
eq("a group has no meaningful dormancy of its own", v6.state, DORMANCY_UNKNOWN)

v7 = dormancy.assess_identity(
    actor_class=ACTOR_HUMAN, last_used_at=NOW - timedelta(days=100),
    last_used_source="provider", provider_reports_last_used=True,
    event_last_seen=NOW - timedelta(days=2), now=NOW)
eq("event-log activity overrides a staler provider date", v7.state, DORMANCY_ACTIVE)
eq("and the source says where the newer date came from", v7.source, "event log")

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== E. Credentials: age, staleness and 'never' as a provider assertion ===")
# ═════════════════════════════════════════════════════════════════════════════
never = dormancy.assess_credential(
    credential_kind="AWS_ACCESS_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=200), last_used_at=None, never_used=True, now=NOW)
check("a never-used key is flagged NEVER_USED", "NEVER_USED" in never["signals"])
eq("and is recommended for deletion", never["recommendation"], RECO_DELETE)

unknown = dormancy.assess_credential(
    credential_kind="OCI_API_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=200), last_used_at=None, never_used=None, now=NOW)
check("a key with NO last-used data is not called never-used",
      "NEVER_USED" not in unknown["signals"])
check("it is flagged as unknown instead", "LAST_USE_UNKNOWN" in unknown["signals"])
eq("and the recommendation is to investigate, not delete",
   unknown["recommendation"], RECO_INVESTIGATE)
check("the row states that last use is not known", unknown["last_use_known"] is False)

stale = dormancy.assess_credential(
    credential_kind="AWS_ACCESS_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=400), last_used_at=NOW - timedelta(days=120),
    never_used=False, now=NOW)
eq("a key unused for 120 days is recommended for disabling",
   stale["recommendation"], RECO_DISABLE)
eq("its age is exact", stale["age_days"], 400)
eq("its unused days are exact", stale["unused_days"], 120)

old_but_used = dormancy.assess_credential(
    credential_kind="AWS_ACCESS_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=400), last_used_at=NOW - timedelta(days=1),
    never_used=False, now=NOW)
eq("an old but actively used key is recommended for rotation, not disabling",
   old_but_used["recommendation"], RECO_ROTATE)

fresh = dormancy.assess_credential(
    credential_kind="AWS_ACCESS_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=10), last_used_at=NOW - timedelta(days=1),
    never_used=False, now=NOW)
eq("a fresh, used key needs nothing", fresh["recommendation"], RECO_NONE)

multi = dormancy.assess_credential(
    credential_kind="AWS_ACCESS_KEY", status="ACTIVE",
    created_at=NOW - timedelta(days=10), last_used_at=NOW - timedelta(days=1),
    never_used=False, sibling_active_count=2, now=NOW)
check("two active keys are flagged", "MULTIPLE_ACTIVE_KEYS" in multi["signals"])

no_age = dormancy.assess_credential(
    credential_kind="AZURE_CLIENT_SECRET", status="ACTIVE", created_at=None,
    last_used_at=None, never_used=None, now=NOW)
eq("an unknown creation date yields no age, not 0", no_age["age_days"], None)
check("and the row says the age is not known", no_age["age_known"] is False)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== F. MFA: a workload is never an MFA failure ===")
# ═════════════════════════════════════════════════════════════════════════════
state, detail = dormancy.assess_mfa(actor_class=ACTOR_WORKLOAD,
                                    provider_reports_mfa=True, mfa_enabled=False)
eq("a workload is NOT_APPLICABLE even when the provider says no device",
   state, MFA_NOT_APPLICABLE)
check("and says why", "workload" in detail["reason"].lower())

eq("a group is NOT_APPLICABLE",
   dormancy.assess_mfa(actor_class=ACTOR_GROUP, provider_reports_mfa=True)[0],
   MFA_NOT_APPLICABLE)
eq("a human with a device is ENABLED",
   dormancy.assess_mfa(actor_class=ACTOR_HUMAN, provider_reports_mfa=True,
                       mfa_devices=["dev"])[0], MFA_ENABLED)
eq("a human the provider says has none is DISABLED",
   dormancy.assess_mfa(actor_class=ACTOR_HUMAN, provider_reports_mfa=True,
                       mfa_enabled=False)[0], MFA_DISABLED)
state_u, detail_u = dormancy.assess_mfa(actor_class=ACTOR_HUMAN,
                                        provider_reports_mfa=False)
eq("a human whose MFA the provider does not report is UNKNOWN", state_u, MFA_UNKNOWN)
check("and the reason calls it a data gap", "gap" in detail_u["reason"].lower())

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== G. Break-glass is a SHAPE, reported as potential ===")
# ═════════════════════════════════════════════════════════════════════════════
potential, signals = dormancy.break_glass_signals(
    name="breakglass-admin", privilege_level=PRIV_ADMIN, dormancy=DORMANCY_DORMANT,
    mfa_state=MFA_DISABLED, actor_class=ACTOR_HUMAN, credential_count=1)
check("an admin account named break-glass and dormant is potential", potential)
check("the name signal is recorded",
      any(s["signal"] == "NAME" for s in signals))
check("the missing MFA is called out", any(s["signal"] == "NO_MFA" for s in signals))

not_bg, _ = dormancy.break_glass_signals(
    name="emergency-deploy", privilege_level="STANDARD", dormancy=DORMANCY_ACTIVE,
    mfa_state=MFA_ENABLED, actor_class=ACTOR_WORKLOAD)
check("a busy non-admin with an emergency-ish name is NOT flagged", not not_bg)
check("recommended controls are offered",
      len(dormancy.recommended_break_glass_controls()) >= 5)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== H. Trust: external is a fact, dangerous is a judgement ===")
# ═════════════════════════════════════════════════════════════════════════════
known = {"111122223333"}
eq("our own account is internal",
   trust_mod.classify_principal(AWS, "arn:aws:iam::111122223333:root",
                                known_accounts=known)[0], EXTERNAL_NO)
eq("another account is external",
   trust_mod.classify_principal(AWS, "arn:aws:iam::999988887777:root",
                                known_accounts=known)[0], EXTERNAL_YES)
eq("a wildcard is ANONYMOUS, not merely external",
   trust_mod.classify_principal(AWS, "*", known_accounts=known)[0], EXTERNAL_ANONYMOUS)
eq("an AWS service principal is not external",
   trust_mod.classify_principal(AWS, "Service:lambda.amazonaws.com",
                                known_accounts=known)[0], EXTERNAL_NO)
eq("an unresolvable principal is UNKNOWN, never assumed internal",
   trust_mod.classify_principal(AWS, "something-odd", known_accounts=known)[0],
   EXTERNAL_UNKNOWN)

edges = trust_mod.build_edges(
    AWS, target_key="arn:aws:iam::111122223333:role/Prod", target_name="Prod",
    principals=[{"principal": "arn:aws:iam::999988887777:root",
                 "has_external_id": False, "has_mfa_condition": False}],
    known_accounts=known, target_privilege=PRIV_ADMIN)
eq("one edge is built", len(edges), 1)
factors = [f["factor"] for f in edges[0].risk_factors]
check("a missing ExternalId is a stated risk factor", "NO_EXTERNAL_ID" in factors)
check("a privileged target is a stated risk factor", "PRIVILEGED_TARGET" in factors)
check("the edge is not labelled malicious anywhere",
      not any("malicious" in str(f).lower() for f in edges[0].risk_factors))

anon = trust_mod.build_edges(
    AWS, target_key="r", target_name="r",
    principals=[{"principal": "*"}], known_accounts=known)
check("a wildcard principal is flagged ANY_PRINCIPAL",
      "ANY_PRINCIPAL" in [f["factor"] for f in anon[0].risk_factors])

summary = trust_mod.summarize(edges + anon)
eq("the summary counts external edges", summary["external"], 1)
eq("and counts anonymous separately", summary["anonymous"], 1)
graph = trust_mod.graph(edges + anon)
check("the graph has nodes and links", graph["nodes"] and graph["links"])
check("every node carries an id the UI can click",
      all(n.get("id") for n in graph["nodes"]))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== I. Blast radius is derived, and withheld over a failed sweep ===")
# ═════════════════════════════════════════════════════════════════════════════
resources = [
    br.ResourceRef(key="arn:aws:s3:::prod-data", name="prod-data",
                   resource_type="S3Bucket", region="us-east-1"),
    br.ResourceRef(key="arn:aws:s3:::logs", name="logs",
                   resource_type="S3Bucket", region="us-east-1"),
    br.ResourceRef(key="arn:aws:ec2:us-east-1:1:instance/i-1", name="web",
                   resource_type="EC2Instance", region="us-east-1"),
]
perms = [{"action_pattern": "s3:*", "resource_pattern": "arn:aws:s3:::prod-*",
          "capability": "STORAGE_DELETE"}]
reach = br.compute(AWS, permissions=perms, resources=resources,
                   capabilities=["STORAGE_DELETE"], inventory_complete=True)
eq("only matching resources are reachable", reach["direct_resources"], 1)
check("a score is produced when the inventory is complete",
      reach["score"] is not None)
check("the data-deletion capability flag is set",
      reach["capabilities"]["can_delete_data"])
check("the sensitive resource is counted", reach["sensitive_resources"] >= 1)

incomplete = br.compute(AWS, permissions=perms, resources=resources,
                        capabilities=["STORAGE_DELETE"], inventory_complete=False)
eq("the score is WITHHELD when the inventory is incomplete",
   incomplete["score"], None)
check("and the reason is stated", bool(incomplete["coverage_note"]))
check("the counts are still reported as a floor",
      incomplete["direct_resources"] == 1)

wildcard = br.compute(
    AWS, permissions=[{"action_pattern": "*", "resource_pattern": "*",
                       "capability": "IAM_ADMINISTRATION"}],
    resources=resources, capabilities=["IAM_ADMINISTRATION"], inventory_complete=True)
eq("a wildcard resource reaches the whole inventory",
   wildcard["direct_resources"], 3)
check("IAM modification is flagged", wildcard["capabilities"]["can_modify_iam"])

no_topology = br.compute(AWS, permissions=perms, resources=resources,
                         capabilities=["STORAGE_DELETE"], inventory_complete=True,
                         topology_edges=[])
check("with no topology, indirect reach is reported as unknown rather than 0",
      no_topology["topology_note"] is not None)

with_topology = br.compute(
    AWS, permissions=perms, resources=resources, capabilities=["STORAGE_DELETE"],
    inventory_complete=True,
    topology_edges=[{"source": "arn:aws:s3:::prod-data",
                     "target": "arn:aws:ec2:us-east-1:1:instance/i-1",
                     "kind": "feeds"}])
check("topology adds indirect reach", with_topology["indirect_resources"] >= 1)
check("and the path records why the node is reachable",
      all(p.get("through") for p in with_topology["paths"]))

explanation = br.explain(incomplete)
check("the explanation states that counts are a floor",
      any("floor" in e["claim"].lower() for e in explanation))

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== J. Right-sizing keeps what it cannot prove is unused ===")
# ═════════════════════════════════════════════════════════════════════════════
usage_summary = usage_mod.correlate(
    AWS, granted_patterns=["s3:GetObject", "s3:PutObject", "ec2:TerminateInstances",
                           "iam:PassRole"],
    observations=usage_mod.aggregate_events(
        AWS, [event("GetObject"), event("PutObject")])[0],
    window=window)
diff = rightsizing.build_diff(AWS, usage_summary=usage_summary)
verdicts = {e.pattern: e.verdict for e in diff}
eq("an observed grant is kept", verdicts["s3:GetObject"], rightsizing.KEEP)
eq("an unobserved control-plane grant is removed",
   verdicts["ec2:TerminateInstances"], rightsizing.REMOVE)
eq("every granted pattern appears in the diff exactly once", len(diff), 4)
check("every diff entry carries a reason", all(e.reason for e in diff))

blind_diff = rightsizing.build_diff(
    AWS, usage_summary=usage_mod.correlate(
        AWS, granted_patterns=["s3:DeleteObject"], observations={}, window=window))
eq("a data-plane grant with no events is RETAINED, not removed",
   blind_diff[0].verdict, rightsizing.RETAIN_INSUFFICIENT)
check("and the reason explains the insufficiency", bool(blind_diff[0].reason))

policy = rightsizing.generate_policy(AWS, diff=diff)
eq("the generated policy is labelled PROPOSED", policy["status"], "PROPOSED")
check("and explicitly not applied", policy["applied"] is False)
check("the caveats warn about work that did not run in the window",
      any("quarterly" in c or "window" in c for c in policy["caveats"]))
check("the retained-for-insufficient-evidence grants are explained in the caveats",
      any("insufficient" in c.lower() for c in
          rightsizing.generate_policy(AWS, diff=blind_diff)["caveats"]))
removed_actions = [s["Action"] for s in policy["document"]["Statement"]]
check("the removed grant is absent from the proposed document",
      "ec2:TerminateInstances" not in removed_actions)
check("the kept grants are present", "s3:GetObject" in removed_actions)

proposal = rightsizing.build_proposal(AWS, identity_name="app-role",
                                      usage_summary=usage_summary)
check("the proposal carries its evidence window",
      proposal["evidence"]["window"]["days"] == 90)
check("and the number of events analysed",
      proposal["evidence"]["events_in_window"] is not None)
eq("the proposal is not applied", proposal["applied"], False)

summary_counts = rightsizing.summarize(diff)
# Both unobserved grants are control-plane actions CloudTrail records, so both
# are high-confidence candidates. Two is the correct answer here, and asserting
# one would be pinning a bug.
eq("both unobserved control-plane grants are counted for removal",
   summary_counts["remove"], 2)
eq("both observed grants are kept", summary_counts["keep"], 2)
check("and a reduction percentage is reported",
      summary_counts["reduction_percent"] == 50.0)

# ═════════════════════════════════════════════════════════════════════════════
print("\n=== K. Anomaly: a second data point is not a behaviour change ===")
# ═════════════════════════════════════════════════════════════════════════════
base_start = NOW - timedelta(days=60)
base_end = NOW - timedelta(days=7)
thin = anomaly.build_baseline(AWS, [event("GetObject")], start=base_start,
                              end=base_end)
check("a baseline with too few events is insufficient", not thin.sufficient)
check("and says why", bool(thin.insufficient_reason))

many = [event("GetObject", when=base_start + timedelta(days=i % 50))
        for i in range(120)]
rich = anomaly.build_baseline(AWS, many, start=base_start, end=base_end)
check("a baseline with enough events is sufficient", rich.sufficient)
check("it records the services seen", "s3.amazonaws.com" in rich.services)
check("it records the regions seen", "us-east-1" in rich.regions)

current = anomaly.build_baseline(
    AWS, [event("PutRolePolicy", source="iam.amazonaws.com",
                when=NOW - timedelta(days=1), region="eu-west-1")],
    start=NOW - timedelta(days=7), end=NOW)
signals = anomaly.compare(AWS, baseline=rich, current=current)
kinds = {s["signal"] for s in signals}
check("a new region is reported", anomaly.SIG_NEW_REGION in kinds)
check("a new service is reported", anomaly.SIG_NEW_SERVICE in kinds)
check("a first high-impact capability is reported",
      anomaly.SIG_NEW_HIGH_IMPACT in kinds)
check("every signal names the baseline it differs from",
      all(s.get("baseline") for s in signals))
check("no signal asserts intent or calls the activity malicious",
      not any(any(w in str(s).lower() for w in
                  ("malicious", "attacker", "compromis", "threat", "suspicious"))
              for s in signals))

thin_signals = anomaly.compare(AWS, baseline=thin, current=current)
eq("an insufficient baseline produces no deviation claims", thin_signals, [])

dormant_signals = anomaly.compare(AWS, baseline=thin, current=current,
                                  was_dormant=True, dormant_days=200)
check("but a dormant identity becoming active is still reported",
      any(s["signal"] == anomaly.SIG_DORMANT_REACTIVATED for s in dormant_signals))
check("and that signal is phrased neutrally",
      "dormant" in dormant_signals[0]["label"].lower())

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
