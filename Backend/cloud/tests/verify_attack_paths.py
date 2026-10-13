"""Contextual risk and attack-path traversal, against the real Graph and the
real Exposure type.

Run: venv\\Scripts\\python.exe tests\\verify_attack_paths.py

Nothing here re-implements the thing it checks. The graph is a real
`app.topology.graph.Graph` with real edge dicts, the exposures are real
`app.security.exposure.Exposure` tuples, and the assertions call
`risk.assess` / `attackpath.find_paths` / `attackpath.score_path` directly.
That is deliberate: twice before in this codebase a test helper re-derived the
rule it was meant to verify and passed over a live bug.

The load-bearing half of this suite is the negative half. A risk model that
amplifies is easy; one that refuses to dampen on missing evidence is the thing
that has to be pinned down, because damping on absence silently converts "we
could not tell" into "this is fine" — which is the exact failure the exposure
analyser's UNKNOWN verdict exists to prevent.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import attackpath as ap
from app.security import ports as portcat
from app.security import risk
from app.security.exposure import Exposure, Hop as ExpHop
from app.security.model import (
    CONF_HIGH, CONF_LOW, CONF_MEDIUM, CRITICAL, EXPOSED, EXPOSURE_UNKNOWN,
    HIGH, INFO, LOW, MEDIUM, PROTECTED,
)
from app.topology.graph import Graph
from app.topology.model import (
    ATTACHED, CATEGORY_COMPUTE, CATEGORY_DATABASE, CATEGORY_IDENTITY,
    CATEGORY_STORAGE, CONTAINS, NETWORK, PERMISSION, ROLE, ROUTES_TO, SECURITY,
)

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


# ── builders ─────────────────────────────────────────────────────────────────

def node(nid, name, rtype, category, **extra):
    n = {
        "id": nid, "name": name, "type": rtype, "category": category,
        "provider": "AWS", "provider_id": f"arn::{nid}", "resource_id": f"arn::{nid}",
        "account_id": "acct-1", "region": "ap-south-1",
    }
    n.update(extra)
    return n


_edge_seq = [0]


def edge(source, target, kind, label="", **evidence):
    _edge_seq[0] += 1
    return {
        "id": f"e{_edge_seq[0]}", "source": source, "target": target,
        "type": kind, "label": label or kind, "direction": "directed",
        "provider": "AWS",
        "evidence": {"field": "test", "value": f"{source}->{target}", **evidence},
    }


def exposure(resource_id, verdict, *, ports=(), addrs=(), controls=(), reason=None):
    return Exposure(
        resource_id=resource_id, resource_key=f"arn::{resource_id}",
        resource_name=resource_id, resource_type="EC2Instance", provider="AWS",
        account_id="acct-1", region="ap-south-1",
        verdict=verdict, confidence=CONF_HIGH,
        public_addresses=list(addrs), open_ports=list(ports),
        port_verdicts=[], path=[ExpHop("public-ip", "1.2.3.4")],
        evaluated_controls=list(controls), unknown_reason=reason,
    )


RDP = portcat.classify_range(3389, 3389)
SSH = portcat.classify_range(22, 22)


# ═════════════════════════════════════════════════════════════════════════════
print("1. Contextual risk — no evidence reproduces the declared severity exactly")
for sev in (CRITICAL, HIGH, MEDIUM, LOW, INFO):
    rc = risk.assess(sev, risk.ResourceContext())
    check(f"{sev}: band unchanged with no context", rc.contextual_band == sev,
          f"{rc.contextual_band} @ {rc.adjusted_points}pts")
rc = risk.assess(HIGH, risk.ResourceContext())
check("determined=False when nothing was confirmed", rc.determined is False)
check("every factor is NEUTRAL and worth 0",
      all(f.direction == risk.NEUTRAL and f.delta == 0 for f in rc.factors))

print("\n2. Contextual risk — confirmed exposure amplifies, with evidence attached")
rc = risk.assess(MEDIUM, risk.ResourceContext(
    exposure=exposure("vm1", EXPOSED, ports=RDP, addrs=["1.2.3.4"], controls=["sg-1"]),
))
check("MEDIUM + internet + RDP -> HIGH or above",
      rc.contextual_band in (HIGH, CRITICAL), f"{rc.contextual_band} @ {rc.adjusted_points}")
amp_ids = {f.factor_id for f in rc.factors if f.direction == risk.AMPLIFIER}
check("INTERNET_REACHABLE amplifier present", risk.F_INTERNET_REACHABLE in amp_ids)
check("MANAGEMENT_PORT amplifier present", risk.F_MANAGEMENT_PORT in amp_ids)
reach = next(f for f in rc.factors if f.factor_id == risk.F_INTERNET_REACHABLE)
check("amplifier carries the resolved path as evidence", bool(reach.evidence.get("path")))
check("arithmetic adds up",
      rc.adjusted_points == rc.base_points + sum(f.delta for f in rc.factors),
      f"{rc.base_points} + deltas = {rc.adjusted_points}")

print("\n3. Contextual risk — the NEGATIVE half: absence must never dampen")
rc_nocontrols = risk.assess(CRITICAL, risk.ResourceContext(
    exposure=exposure("vm2", PROTECTED, controls=[]),       # PROTECTED but nothing consulted
))
check("PROTECTED with no controls consulted does NOT dampen",
      all(f.direction != risk.DAMPENER for f in rc_nocontrols.factors))
check("...and is recorded as undetermined instead",
      any(f.factor_id == risk.F_REACHABILITY_UNKNOWN for f in rc_nocontrols.factors))
check("...so the band stays CRITICAL", rc_nocontrols.contextual_band == CRITICAL,
      rc_nocontrols.contextual_band)

rc_unknown = risk.assess(CRITICAL, risk.ResourceContext(
    exposure=exposure("vm3", EXPOSURE_UNKNOWN, reason="NICs never resolved"),
))
check("UNKNOWN exposure neither amplifies nor dampens",
      all(f.delta == 0 for f in rc_unknown.factors))
check("UNKNOWN band equals base", rc_unknown.contextual_band == CRITICAL)
check("UNKNOWN reason is surfaced",
      any("NICs never resolved" in (f.explanation or "") for f in rc_unknown.factors))

rc_noexp = risk.assess(HIGH, risk.ResourceContext(exposure=None))
check("missing exposure record does not dampen",
      all(f.direction != risk.DAMPENER for f in rc_noexp.factors))

rc_noident = risk.assess(HIGH, risk.ResourceContext(identity_collected=False))
check("identity not collected -> NEUTRAL record, no dampening",
      any(f.factor_id == risk.F_IDENTITY_UNKNOWN and f.delta == 0 for f in rc_noident.factors))

print("\n4. Contextual risk — confirmed-private dampens, but is clamped")
rc_priv = risk.assess(CRITICAL, risk.ResourceContext(
    exposure=exposure("db1", PROTECTED, controls=["sg-private", "nacl-1"]),
    tags={"Environment": "dev"},
))
check("dampeners fired", any(f.direction == risk.DAMPENER for f in rc_priv.factors))
check("CRITICAL clamped at HIGH, never lower", rc_priv.contextual_band == HIGH,
      rc_priv.contextual_band)
check("clamp is explained, not silent", bool(rc_priv.clamp_applied))

print("\n5. Contextual risk — an exposure rule must not count its own evidence twice")
ctx = risk.ResourceContext(exposure=exposure("vm4", EXPOSED, ports=RDP, controls=["sg-1"]))
generic = risk.assess(HIGH, ctx, rule_id="AWS_RDS_ENCRYPTION_DISABLED")
intrinsic = risk.assess(HIGH, ctx, rule_id="EXPOSURE_MANAGEMENT_PORT_WORLD_OPEN")
check("exposure-rule omits the INTERNET_REACHABLE amplifier",
      not any(f.factor_id == risk.F_INTERNET_REACHABLE for f in intrinsic.factors))
check("generic rule keeps it",
      any(f.factor_id == risk.F_INTERNET_REACHABLE for f in generic.factors))
check("so the exposure rule scores strictly lower",
      intrinsic.adjusted_points < generic.adjusted_points,
      f"{intrinsic.adjusted_points} < {generic.adjusted_points}")

print("\n6. Contextual risk — environment is read from tags only, never guessed")
prod = risk.assess(MEDIUM, risk.ResourceContext(tags={"env": "production"}))
check("prod tag amplifies", any(f.factor_id == risk.F_PRODUCTION for f in prod.factors))
weird = risk.assess(MEDIUM, risk.ResourceContext(tags={"Environment": "Core"}))
check("unrecognised tag value -> untagged, not a third environment",
      any(f.factor_id == risk.F_ENVIRONMENT_UNKNOWN for f in weird.factors))
named = risk.assess(MEDIUM, risk.ResourceContext(
    tags={"Name": "prd-db-01"}))          # name says prod; tags do not
check("production is NOT inferred from a resource name",
      any(f.factor_id == risk.F_ENVIRONMENT_UNKNOWN for f in named.factors))

print("\n6b. Contextual risk — privileged-identity evidence survives either input shape")
# The analyser hands this model `IdentityRisk` tuples; the finding-backed path
# in attack_path_service hands it plain dicts. A getattr-only reader returned
# None for every field of a dict, producing an amplifier whose evidence block
# was entirely nulls — counted in the total, unsupported on screen.
class _FakeRisk:
    rule_id = 'AZURE_RBAC_SUBSCRIPTION_OWNER'
    principal_name = 'svc-deploy'
    principal_type = 'ServicePrincipal'
    role_name = 'Owner'
    scope = '/subscriptions/abc'
    detail = 'Owner at subscription scope'

for label, payload, want_key, want_val in (
    ('object', _FakeRisk(), 'rule_id', 'AZURE_RBAC_SUBSCRIPTION_OWNER'),
    ('dict', {'rule_id': 'AWS_IAM_ROLE_FULL_ADMIN', 'title': 'Admin role',
              'severity': 'CRITICAL', 'resource_name': 'web-role'},
     'rule_id', 'AWS_IAM_ROLE_FULL_ADMIN'),
):
    rc = risk.assess(HIGH, risk.ResourceContext(privileged_identities=[payload]))
    f = next((x for x in rc.factors if x.factor_id == risk.F_PRIVILEGED_IDENTITY), None)
    check(f'{label}-shaped identity produces the amplifier', f is not None)
    ev = (f.evidence.get('identities') or [{}])[0] if f else {}
    check(f'{label}-shaped identity carries real evidence, not nulls',
          ev.get(want_key) == want_val, str(ev))
    check(f'{label}-shaped evidence has no all-null record',
          any(v is not None for v in ev.values()), str(ev))

print("\n7. Contextual risk — blast radius exempts structurally-connected types")
vpc = risk.assess(MEDIUM, risk.ResourceContext(resource_type="VPC", blast_radius=80))
vm = risk.assess(MEDIUM, risk.ResourceContext(resource_type="EC2Instance", blast_radius=80))
check("VPC's huge degree is not an amplifier",
      not any(f.factor_id == risk.F_BLAST_RADIUS for f in vpc.factors))
check("an instance's is", any(f.factor_id == risk.F_BLAST_RADIUS for f in vm.factors))


# ═════════════════════════════════════════════════════════════════════════════
print("\n8. Attack paths — a confirmed 3-hop path: internet -> VM -> role -> bucket")
g = Graph()
g.add_node(node("vm", "web-1", "EC2Instance", CATEGORY_COMPUTE))
g.add_node(node("role", "web-role", "IAMRole", CATEGORY_IDENTITY))
g.add_node(node("bucket", "data-bkt", "S3Bucket", CATEGORY_STORAGE))
g.add_edge(edge("vm", "role", ROLE, "Assumes role"))
g.add_edge(edge("role", "bucket", PERMISSION, "s3:GetObject",
                note="Instance profile allows s3:GetObject, s3:ListBucket"))

exposed_vm = exposure("vm", EXPOSED, ports=RDP, addrs=["1.2.3.4"], controls=["sg-1"])
res = ap.find_paths(g, [exposed_vm], account_id="acct-1", provider="AWS")
paths = res["paths"]
check("one path found", len(paths) == 1, str(len(paths)))
if paths:
    p = paths[0]
    check("path ends at the bucket", p.target_node_id == "bucket")
    check("length 2 hops", p.length == 2, str(p.length))
    check("hop 1 is privilege escalation", p.hops[0].stage == ap.PRIVILEGE_ESCALATION)
    check("hop 2 is data access", p.hops[1].stage == ap.DATA_ACCESS)
    check("each hop carries the edge's own evidence",
          all(h.evidence for h in p.hops))
    check("IAM hop explains WHY the edge exists",
          "s3:GetObject" in str(p.hops[1].evidence))
    check("confidence MEDIUM — crosses an unobserved permission edge",
          p.confidence == CONF_MEDIUM, p.confidence)
    check("confidence reason names the capability caveat",
          "capability" in p.confidence_reason.lower())

print("\n9. Attack paths — non-traversable relationships carry no attacker")
g2 = Graph()
g2.add_node(node("vm", "web-1", "EC2Instance", CATEGORY_COMPUTE))
g2.add_node(node("bucket", "data-bkt", "S3Bucket", CATEGORY_STORAGE))
g2.add_edge(edge("vm", "bucket", CONTAINS))       # ownership
g2.add_edge(edge("vm", "bucket", SECURITY))       # a filter
res2 = ap.find_paths(g2, [exposure("vm", EXPOSED, ports=RDP, controls=["sg-1"])],
                     account_id="acct-1", provider="AWS")
check("contains/security produce no path", res2["paths"] == [], str(len(res2["paths"])))
check("the exposed entry is reported as having no path",
      res2["entries_without_path"] == ["vm"])

print("\n10. Attack paths — directed edges are only walked the attacker's way")
g3 = Graph()
g3.add_node(node("lb", "public-lb", "LoadBalancer", CATEGORY_COMPUTE))
g3.add_node(node("db", "orders-db", "RDSInstance", CATEGORY_DATABASE))
g3.add_edge(edge("lb", "db", ROUTES_TO))
fwd = ap.find_paths(g3, [exposure("lb", EXPOSED, ports=SSH, controls=["sg-1"])],
                    account_id="acct-1", provider="AWS")
check("LB -> DB is found from the LB", len(fwd["paths"]) == 1)
rev = ap.find_paths(g3, [exposure("db", EXPOSED, ports=SSH, controls=["sg-1"])],
                    account_id="acct-1", provider="AWS")
check("DB -> LB is NOT walked backwards", rev["paths"] == [], str(len(rev["paths"])))

print("\n11. Attack paths — UNKNOWN exposure is not an entry point")
unknown_entry = ap.find_paths(
    g, [exposure("vm", EXPOSURE_UNKNOWN, reason="no NIC")],
    account_id="acct-1", provider="AWS")
check("UNKNOWN never starts a path", unknown_entry["paths"] == [])
check("...and is not counted as an entry point", unknown_entry["entry_points"] == [])
protected_entry = ap.find_paths(
    g, [exposure("vm", PROTECTED, controls=["sg-1"])],
    account_id="acct-1", provider="AWS")
check("PROTECTED never starts a path", protected_entry["paths"] == [])

print("\n12. Attack paths — cycles terminate, depth is bounded")
g4 = Graph()
for n in ("a", "b", "c"):
    g4.add_node(node(n, n, "EC2Instance", CATEGORY_COMPUTE))
g4.add_node(node("bkt", "bkt", "S3Bucket", CATEGORY_STORAGE))
g4.add_edge(edge("a", "b", NETWORK))
g4.add_edge(edge("b", "c", NETWORK))
g4.add_edge(edge("c", "a", NETWORK))          # cycle
g4.add_edge(edge("c", "bkt", ATTACHED))
cyc = ap.find_paths(g4, [exposure("a", EXPOSED, ports=SSH, controls=["sg-1"])],
                    account_id="acct-1", provider="AWS", max_depth=6)
check("cycle does not hang and a path is still found", len(cyc["paths"]) == 1)
if cyc["paths"]:
    check("co-location path is downgraded to LOW confidence",
          cyc["paths"][0].confidence == CONF_LOW, cyc["paths"][0].confidence)
    check("...and says co-location is not reachability",
          "co-location" in cyc["paths"][0].confidence_reason.lower())
shallow = ap.find_paths(g4, [exposure("a", EXPOSED, ports=SSH, controls=["sg-1"])],
                        account_id="acct-1", provider="AWS", max_depth=1)
check("max_depth=1 cannot reach a 3-hop target", shallow["paths"] == [])

print("\n13. Attack paths — isolated and unknown nodes are handled, not crashed")
iso = ap.find_paths(g, [exposure("ghost", EXPOSED, ports=RDP, controls=["sg-1"])],
                    account_id="acct-1", provider="AWS")
check("an exposure for a node absent from the graph is skipped", iso["paths"] == [])
check("...and is not reported as an entry point", iso["entry_points"] == [])
check("empty graph / no exposures returns an empty result",
      ap.find_paths(Graph(), [], account_id="a", provider="AWS")["paths"] == [])

print("\n14. Attack paths — a fully observed path outranks one that needs a guess")
g5 = Graph()
g5.add_node(node("vm", "web", "EC2Instance", CATEGORY_COMPUTE))
g5.add_node(node("vol", "data-vol", "EBSVolume", CATEGORY_STORAGE))
g5.add_edge(edge("vm", "vol", ATTACHED))
obs = ap.find_paths(g5, [exposure("vm", EXPOSED, ports=RDP, controls=["sg-1"])],
                    account_id="acct-1", provider="AWS")
check("attached path is fully observed -> HIGH confidence",
      obs["paths"] and obs["paths"][0].confidence == CONF_HIGH,
      obs["paths"][0].confidence if obs["paths"] else "none")

print("\n15. Path scoring — components are evidenced and sum to the score")
p = obs["paths"][0]
s = ap.score_path(p, exposure=exposure("vm", EXPOSED, ports=RDP, controls=["sg-1"]),
                  findings_by_node={"vm": [{"severity": "CRITICAL", "rule_id": "X"}]})
check("score sums its components",
      s["points"] == sum(c["points"] for c in s["components"]),
      f"{s['points']} vs {sum(c['points'] for c in s['components'])}")
check("every component carries evidence", all(c["evidence"] for c in s["components"]))
check("every component carries an explanation",
      all(c["explanation"] for c in s["components"]))
ids = {c["component_id"] for c in s["components"]}
check("entry exposure scored", ap.PC_ENTRY_EXPOSURE in ids)
check("management port scored", ap.PC_MANAGEMENT_PORT in ids)
check("data-store target scored", ap.PC_TARGET_DATA in ids)
check("findings on the route scored", ap.PC_FINDINGS in ids)
data_c = next(c for c in s["components"] if c["component_id"] == ap.PC_TARGET_DATA)
check("data-store component states it scores TYPE, not content",
      "content" in data_c["explanation"].lower()
      and data_c["evidence"].get("basis", "").startswith("resource type"))

print("\n16. Path scoring — an unconfirmed hop is penalised, not rewarded")
cyc_path = cyc["paths"][0]
s_guess = ap.score_path(cyc_path, exposure=exposure("a", EXPOSED, ports=SSH, controls=["sg-1"]))
pen = [c for c in s_guess["components"] if c["component_id"] == ap.PC_UNOBSERVED]
check("unconfirmed-hop penalty applied", bool(pen) and pen[0]["points"] < 0,
      str(pen[0]["points"]) if pen else "absent")
check("score never goes negative", s_guess["points"] >= 0, str(s_guess["points"]))

print("\n17. Attack paths — unproven hops are budgeted, not chained")
# A `network` edge joins a resource to its subnet, so one co-location step
# costs two of them. Chaining steps enumerates a flat network instead of
# finding a route: on live data this produced 92 of 159 OCI paths and 87 of
# 109 Azure paths, all of the shape network->network->network->network->...
chain = Graph()
chain.add_node(node("entry", "entry", "EC2Instance", CATEGORY_COMPUTE))
for i in range(4):
    chain.add_node(node(f"sn{i}", f"sn{i}", "Subnet", CATEGORY_COMPUTE))
    chain.add_node(node(f"host{i}", f"host{i}", "EC2Instance", CATEGORY_COMPUTE))
chain.add_node(node("near", "near-bkt", "S3Bucket", CATEGORY_STORAGE))
chain.add_node(node("far", "far-bkt", "S3Bucket", CATEGORY_STORAGE))
chain.add_edge(edge("entry", "sn0", NETWORK))
chain.add_edge(edge("sn0", "host0", NETWORK))       # 2 unobserved: one step
chain.add_edge(edge("host0", "near", ATTACHED))
chain.add_edge(edge("host0", "sn1", NETWORK))
chain.add_edge(edge("sn1", "host1", NETWORK))       # 4 unobserved: two steps
chain.add_edge(edge("host1", "far", ATTACHED))
entry_exp = exposure("entry", EXPOSED, ports=SSH, controls=["sg-1"])
capped = ap.find_paths(chain, [entry_exp], account_id="a", provider="AWS", max_depth=6)
reached = {p.target_node_id for p in capped["paths"]}
check("one co-location step is allowed", "near" in reached, str(reached))
check("two chained co-location steps are not", "far" not in reached, str(reached))
check("the cap is reported so the list is not mistaken for exhaustive",
      capped["limits"]["max_unobserved_hops"] == 2)
loosened = ap.find_paths(chain, [entry_exp], account_id="a", provider="AWS",
                         max_depth=6, max_unobserved_hops=4)
check("raising the budget reaches further (the cap is the only thing stopping it)",
      "far" in {p.target_node_id for p in loosened["paths"]})

print("\n18. Attack paths — routes are classified so the trivial ones can be separated")
own_disk = ap.find_paths(g5, [exposure("vm", EXPOSED, ports=RDP, controls=["sg-1"])],
                         account_id="a", provider="AWS")["paths"][0]
check("entry's own attached storage is classed as such",
      own_disk.path_class == ap.CLASS_ENTRY_STORAGE, own_disk.path_class)
check("...and says it is impact of the entry, not a further move",
      "rather than a further move" in ap.PATH_CLASS_MEANING[ap.CLASS_ENTRY_STORAGE])
ident_path = ap.find_paths(g, [exposed_vm], account_id="a", provider="AWS")["paths"][0]
check("a route through a role is classed as an identity pivot",
      ident_path.path_class == ap.CLASS_IDENTITY_PIVOT, ident_path.path_class)
colo = next(p for p in capped["paths"] if p.target_node_id == "near")
check("a route needing co-location is classed as network lateral",
      colo.path_class == ap.CLASS_NETWORK_LATERAL, colo.path_class)
check("every class has a label and a meaning",
      all(c in ap.PATH_CLASS_LABEL and c in ap.PATH_CLASS_MEANING
          for c in (ap.CLASS_ENTRY_STORAGE, ap.CLASS_IDENTITY_PIVOT,
                    ap.CLASS_NETWORK_LATERAL, ap.CLASS_DIRECT_ROUTE)))
check("path_class survives serialisation",
      own_disk.to_dict()["path_class"] == ap.CLASS_ENTRY_STORAGE)

print("\n19. Traversal model is self-describing and complete")
tm = ap.traversal_model()
kinds_declared = {t["kind"] for t in tm["traversable"]} | {e["kind"] for e in tm["excluded"]}
from app.topology.model import RELATIONSHIPS
check("every relationship kind is classified traversable or excluded",
      kinds_declared == set(RELATIONSHIPS),
      str(set(RELATIONSHIPS) - kinds_declared))
check("each excluded kind states a reason",
      all(e["reason"] for e in tm["excluded"]))
check("permission is declared unobserved",
      any(t["kind"] == PERMISSION and t["observed"] is False for t in tm["traversable"]))
check("network is declared unobserved",
      any(t["kind"] == NETWORK and t["observed"] is False for t in tm["traversable"]))

print("\n20. Performance — a dense 10,000-node estate stays interactive")
# A chain would be a fake stress test: with max_depth=6 the walk stops after
# six nodes and finishes instantly no matter how long the chain is. This is a
# shared-subnet estate — 40 subnets of 250 instances, every instance reachable
# from its subnet peers — so the traversal really does expand across thousands
# of nodes, which is the shape that would actually be slow.
import time
big = Graph()
SUBNETS, PER_SUBNET = 40, 250
for s in range(SUBNETS):
    hub = f"sn{s}"
    big.add_node(node(hub, hub, "Subnet", CATEGORY_COMPUTE))
    for i in range(PER_SUBNET):
        nid = f"n{s}_{i}"
        big.add_node(node(nid, nid, "EC2Instance", CATEGORY_COMPUTE))
        big.add_edge(edge(hub, nid, NETWORK))
    if s:                                   # chain the subnets together
        big.add_edge(edge(f"sn{s-1}", hub, NETWORK))
# 40 buckets, one reachable two hops from the entry.
for s in range(SUBNETS):
    big.add_node(node(f"bkt{s}", f"bkt{s}", "S3Bucket", CATEGORY_STORAGE))
    big.add_edge(edge(f"n{s}_0", f"bkt{s}", ATTACHED))

check("graph really is large", big.node_count >= 10000, str(big.node_count))
t0 = time.time()
rbig = ap.find_paths(big, [exposure("n0_0", EXPOSED, ports=SSH, controls=["sg-1"])],
                     account_id="a", provider="AWS", max_depth=6)
elapsed = time.time() - t0
check("10,000-node traversal under 5s", elapsed < 5.0, f"{elapsed:.3f}s")
check("it actually found paths (the walk was not short-circuited)",
      len(rbig["paths"]) > 0, str(len(rbig["paths"])))
check("depth bound respected", all(p.length <= 6 for p in rbig["paths"]),
      str(max((p.length for p in rbig["paths"]), default=0)))
check("per-entry cap is honoured",
      len(rbig["paths"]) <= rbig["limits"]["max_paths_per_entry"],
      f"{len(rbig['paths'])} <= {rbig['limits']['max_paths_per_entry']}")

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
