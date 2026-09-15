"""Graph traversal, impact analysis and scale — pure logic, no database.

The questions this suite pins are the ones an analyst asks of the graph, and
each has an answer that must be exactly right rather than roughly right:

*   is there a confirmed path between these two, and does the walk refuse to
    invent one when there is not;
*   what would break if this went away, following each relationship's own
    dependency direction rather than the direction the provider happened to
    report it from;
*   how complete is the data, stated in a way that cannot be mistaken for a
    security score;
*   and does all of it stay fast at the sizes real multi-cloud estates reach.
"""
import pathlib
import sys
import time
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.topology.builder import build_graph  # noqa: E402
from app.topology.graph import Graph  # noqa: E402
from app.topology.model import kinds_for_view  # noqa: E402

ok, fail = [], []
NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


class Account:
    def __init__(self, provider="AWS", name="acct"):
        self.id = uuid.uuid4()
        self.account_name = name
        self.provider = provider
        self.environment = "Production"
        self.last_discovery = NOW


class Resource:
    def __init__(self, account, rtype, name, pid, *, config=None, metadata=None,
                 region="ap-south-1", status="running", ip=None):
        self.id = uuid.uuid4()
        self.account_id = account.id
        self.resource_type = rtype
        self.resource_name = name
        self.provider_resource_id = pid
        self.config = config or {}
        self.metadata_ = metadata or {}
        self.region_or_zone = region
        self.status = status
        self.ip_address = ip
        self.tags = {}
        self.raw_data = {}
        self.cost_monthly = None
        self.discovered_at = NOW
        self.updated_at = NOW


# ── A realistic AWS stack to traverse ────────────────────────────────────────
acct = Account("AWS", "graph-test")
vpc = Resource(acct, "VPC", "vpc", "vpc-1")
sn_a = Resource(acct, "Subnet", "sn-a", "subnet-a", config={"vpc_id": "vpc-1"})
sn_b = Resource(acct, "Subnet", "sn-b", "subnet-b", config={"vpc_id": "vpc-1"})
sg = Resource(acct, "SecurityGroup", "sg", "sg-1", config={"vpc_id": "vpc-1"})
role = Resource(acct, "IAMRole", "role", "arn:role", config={
    "accessible_resources": [{"resource": "arn:tbl", "access": "write"}],
})
tbl = Resource(acct, "DynamoDBTable", "tbl", "arn:tbl")
ec2_a = Resource(acct, "EC2Instance", "ec2-a", "i-a", config={
    "subnet_id": "subnet-a", "security_group_ids": ["sg-1"], "role_arn": "arn:role",
    "private_ip": "10.0.0.10",
})
ec2_b = Resource(acct, "EC2Instance", "ec2-b", "i-b", config={
    "subnet_id": "subnet-b", "security_group_ids": ["sg-1"],
})
vol_a1 = Resource(acct, "EBSVolume", "vol-a1", "vol-a1", config={
    "attachment_status": "Attached", "attached_to_id": "i-a",
})
vol_a2 = Resource(acct, "EBSVolume", "vol-a2", "vol-a2", config={
    "attachment_status": "Attached", "attached_to_id": "i-a",
})
lb = Resource(acct, "LoadBalancer", "lb", "arn:lb", config={
    "backend_instance_ids": ["i-a", "i-b"],
})
lonely = Resource(acct, "S3Bucket", "lonely", "arn:aws:s3:::lonely")

RESOURCES = [vpc, sn_a, sn_b, sg, role, tbl, ec2_a, ec2_b, vol_a1, vol_a2, lb, lonely]
g = build_graph(RESOURCES, [acct], scope="graph-test")

I = {r.resource_name: str(r.id) for r in RESOURCES}


# ── 1. Neighbourhood ─────────────────────────────────────────────────────────
print("1. neighbourhood")

n1 = g.neighborhood(I["ec2-a"], hops=1)
check("a 1-hop neighbourhood is found", n1["found"])
names = {g.node(n["id"])["name"] for n in n1["nodes"]}
check("1 hop from ec2-a reaches its subnet, sg, role, volumes and balancer",
      {"sn-a", "sg", "role", "vol-a1", "vol-a2", "lb"} <= names, sorted(names))
check("and not the unrelated bucket", "lonely" not in names)
eq("the focus itself is at depth 0", n1["depth"][I["ec2-a"]], 0)

# A subnet does not list the instances inside it - the instances name the
# subnet. A direction-respecting walk from the subnet would therefore find
# nothing, which is the opposite of what "this subnet's neighbours" means.
n_sub = g.neighborhood(I["sn-a"], hops=1)
sub_names = {g.node(n["id"])["name"] for n in n_sub["nodes"]}
check("a subnet's neighbourhood includes the instances that name it",
      "ec2-a" in sub_names, sorted(sub_names))

n2 = g.neighborhood(I["ec2-a"], hops=2)
check("2 hops reaches further than 1", len(n2["nodes"]) > len(n1["nodes"]))
check("every returned edge has both ends inside the returned node set",
      all(e["source"] in {n["id"] for n in n2["nodes"]}
          and e["target"] in {n["id"] for n in n2["nodes"]} for e in n2["edges"]))

bounded = g.neighborhood(I["ec2-a"], hops=5, max_nodes=4)
eq("a bounded neighbourhood stops at the bound", len(bounded["nodes"]), 4)
check("and says it was truncated rather than pretending to be complete",
      bounded["truncated"] is True)

eq("an unknown node is not found", g.neighborhood("nope", hops=1)["found"], False)

# A view mode restricts which relationships are followed.
security_only = g.neighborhood(I["ec2-a"], hops=2, kinds=kinds_for_view("security"))
sec_names = {g.node(n["id"])["name"] for n in security_only["nodes"]}
check("the security view follows only security relationships",
      sec_names == {"ec2-a", "sg", "ec2-b"}, sorted(sec_names))
eq("the infrastructure view applies no restriction", kinds_for_view("infrastructure"), None)


# ── 2. Path finding ──────────────────────────────────────────────────────────
print("\n2. path finding")

p = g.find_path(I["ec2-a"], I["vpc"])
check("a path exists from an instance to its VPC", p["found"])
eq("and it is the shortest one (instance -> subnet -> vpc)", p["length"], 2)
eq("the hops are reported in order",
   [g.node(h["to"])["name"] for h in p["hops"]], ["sn-a", "vpc"])
check("each hop says whether it followed the stored direction",
      all("with_direction" in h for h in p["hops"]))

# Two instances in different subnets are connected through the security group
# they share and through the balancer - both are 2 hops.
p2 = g.find_path(I["ec2-a"], I["ec2-b"])
check("two instances in different subnets are connected", p2["found"])
eq("through a single intermediate", p2["length"], 2)
check("the intermediate is one they genuinely share",
      g.node(p2["hops"][0]["to"])["name"] in {"sg", "lb"},
      g.node(p2["hops"][0]["to"])["name"])

# The important negative: no path must ever be invented.
p3 = g.find_path(I["ec2-a"], I["lonely"])
eq("no path is found to an unconnected resource", p3["found"], False)
eq("and the reason is stated", p3["reason"], "no_confirmed_path")
eq("no nodes are returned for a path that does not exist", p3["nodes"], [])

p4 = g.find_path(I["ec2-a"], I["vpc"], max_depth=1)
eq("a path longer than max_depth is not found", p4["found"], False)
eq("and the depth searched is reported", p4["searched_depth"], 1)

eq("a path to an unknown node reports unknown_node",
   g.find_path(I["ec2-a"], "nope")["reason"], "unknown_node")
eq("a path from a node to itself is zero hops",
   g.find_path(I["ec2-a"], I["ec2-a"])["length"], 0)

# Restricting the relationship kinds can make a path disappear, and that has
# to be reported as no path rather than as a looser one.
p5 = g.find_path(I["ec2-a"], I["vpc"], kinds=frozenset({"security"}))
eq("restricting to security relationships removes the network path",
   p5["found"], False)

# A permission hop is traversable but must be marked unobserved, so an analyst
# does not read a reachability path as an access path.
p6 = g.find_path(I["ec2-a"], I["tbl"])
check("a permission relationship can be traversed", p6["found"])
check("but the hop is flagged as not observed",
      any(h["observed"] is False for h in p6["hops"]),
      [(h["relationship"], h["observed"]) for h in p6["hops"]])


# ── 3. Impact / blast radius ─────────────────────────────────────────────────
print("\n3. impact analysis")

# Removing the subnet affects the instance in it, even though the edge points
# instance -> subnet. Getting this backwards would report zero.
imp_sn = g.impact(I["sn-a"])
check("the subnet's impact is found", imp_sn["found"])
direct = {r["name"] for r in imp_sn["direct_dependents"]}
check("removing a subnet directly affects the instance in it",
      "ec2-a" in direct, sorted(direct))
indirect = {r["name"] for r in imp_sn["indirect_dependents"]}
check("and indirectly the volumes attached to that instance",
      {"vol-a1", "vol-a2"} <= indirect, sorted(indirect))
check("the direct dependent is classified as a network dependency",
      "network" in next(r for r in imp_sn["direct_dependents"]
                        if r["name"] == "ec2-a")["dependency_classes"])
check("a node reached through a dependent is not re-tagged with its class",
      "storage" not in next(r for r in imp_sn["direct_dependents"]
                            if r["name"] == "ec2-a")["dependency_classes"],
      next(r for r in imp_sn["direct_dependents"]
           if r["name"] == "ec2-a")["dependency_classes"])

# Removing the VPC is worse than removing one subnet - that ordering is the
# whole point of a blast radius.
imp_vpc = g.impact(I["vpc"])
check("removing the VPC affects more than removing one subnet",
      imp_vpc["total_affected"] > imp_sn["total_affected"],
      f"vpc {imp_vpc['total_affected']} vs subnet {imp_sn['total_affected']}")

# A security group protecting two instances: both are dependents.
imp_sg = g.impact(I["sg"])
sg_direct = {r["name"] for r in imp_sg["direct_dependents"]}
check("removing a security group affects every instance it guards",
      {"ec2-a", "ec2-b"} <= sg_direct, sorted(sg_direct))

# Removing the table the role grants access to affects the consumer.
imp_tbl = g.impact(I["tbl"])
check("removing a permission target affects the consumer that may reach it",
      "ec2-a" in {r["name"] for r in imp_tbl["direct_dependents"]})

imp_lonely = g.impact(I["lonely"])
eq("an unconnected resource has no blast radius", imp_lonely["total_affected"], 0)
eq("and its level is NONE, not LOW", imp_lonely["impact_level"], "NONE")
check("the level's thresholds are stated in the response",
      "0 = NONE" in imp_lonely["impact_basis"])
eq("an unknown resource is not found", g.impact("nope")["found"], False)

# Dependencies split by reliance, not by the stored edge direction.
deps = g.dependencies_of(I["ec2-a"])
check("the instance depends on its subnet",
      "sn-a" in {d["name"] for d in deps["depends_on"]})
check("and the volumes depend on the instance",
      {"vol-a1", "vol-a2"} <= {d["name"] for d in deps["depended_on_by"]},
      sorted(d["name"] for d in deps["depended_on_by"]))


# ── 4. Connections and evidence ──────────────────────────────────────────────
print("\n4. connections")

conn = g.connections_of(I["ec2-a"])
check("inbound and outbound are reported separately",
      "inbound" in conn and "outbound" in conn)
check("every connection carries the evidence for its relationship",
      all(c.get("evidence") for c in conn["inbound"] + conn["outbound"]))
check("every connection says whether the relationship was observed",
      all("observed" in c for c in conn["inbound"] + conn["outbound"]))
eq("degree matches the connection count",
   g.degree(I["ec2-a"]), len(conn["inbound"]) + len(conn["outbound"]))


# ── 5. Coverage and reporting ────────────────────────────────────────────────
print("\n5. coverage")

cov = g.coverage()
eq("coverage counts the resources", cov["resources"], len(RESOURCES))
eq("and the confirmed relationships", cov["confirmed_relationships"], g.edge_count)
eq("with nothing unresolved in this fixture", cov["unresolved_references"], 0)
eq("so everything resolvable resolved", cov["resolved_pct"], 100.0)
check("the metric names itself as data coverage", cov["metric"] == "data_coverage")
check("and its definition disclaims being a security score",
      "not a security score" in cov["definition"])

# An empty graph has no coverage to report. Calling that 100% would be the
# false confidence section 79 rules out.
empty = Graph()
eq("an empty graph reports no percentage, not 100%", empty.coverage()["resolved_pct"], None)

iso = g.isolated_report()
eq("one resource is unconnected", iso["total"], 1)
eq("and it is the bucket", iso["resources"][0]["name"], "lonely")
check("with a reason and an explanation",
      iso["resources"][0]["reason"] and iso["resources"][0]["explanation"])

sub_nodes, sub_edges = g.subgraph([I["ec2-a"], I["sn-a"]])
eq("a subgraph returns only the nodes asked for", len(sub_nodes), 2)
check("and only edges with both ends inside it",
      all(e["source"] in {n["id"] for n in sub_nodes}
          and e["target"] in {n["id"] for n in sub_nodes} for e in sub_edges))


# ── 6. Scale ─────────────────────────────────────────────────────────────────
print("\n6. scale")


def synthetic_estate(instances_per_subnet, subnets, volumes_per_instance):
    """A shaped estate, not a random graph: one VPC, many subnets, instances in
    each, volumes on each instance. This is the shape real accounts have, and
    it is the shape the traversals have to stay fast on."""
    account = Account("AWS", "scale")
    rows = [Resource(account, "VPC", "vpc", "vpc-s")]
    for s in range(subnets):
        rows.append(Resource(account, "Subnet", f"sn-{s}", f"subnet-{s}",
                             config={"vpc_id": "vpc-s"}))
        for i in range(instances_per_subnet):
            iid = f"i-{s}-{i}"
            rows.append(Resource(account, "EC2Instance", f"ec2-{s}-{i}", iid,
                                 config={"subnet_id": f"subnet-{s}"}))
            for v in range(volumes_per_instance):
                rows.append(Resource(
                    account, "EBSVolume", f"vol-{s}-{i}-{v}", f"vol-{s}-{i}-{v}",
                    config={"attachment_status": "Attached", "attached_to_id": iid},
                ))
    return rows, account


for label, (per_subnet, subnets, per_instance) in {
    "100 nodes": (4, 5, 3),
    "1,000 nodes": (12, 12, 5),
    "10,000 nodes": (30, 30, 10),
}.items():
    rows, account = synthetic_estate(per_subnet, subnets, per_instance)
    started = time.perf_counter()
    big = build_graph(rows, [account], scope="scale")
    build_ms = (time.perf_counter() - started) * 1000

    focus = next(str(r.id) for r in rows if r.resource_type == "EC2Instance")
    subnet_id = next(str(r.id) for r in rows if r.resource_type == "Subnet")
    vpc_id = str(rows[0].id)

    started = time.perf_counter()
    big.neighborhood(focus, hops=2)
    nb_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    path = big.find_path(focus, vpc_id)
    path_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    impact = big.impact(subnet_id)
    impact_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    big.coverage()
    big.isolated_report()
    report_ms = (time.perf_counter() - started) * 1000

    print(f"  {label}: {big.node_count} nodes / {big.edge_count} edges | "
          f"build {build_ms:.0f}ms  neighbours {nb_ms:.1f}ms  path {path_ms:.1f}ms  "
          f"impact {impact_ms:.0f}ms  reports {report_ms:.0f}ms")

    check(f"{label}: the graph builds in under 5s", build_ms < 5000, f"{build_ms:.0f}ms")
    check(f"{label}: a 2-hop neighbourhood is under 100ms", nb_ms < 100, f"{nb_ms:.1f}ms")
    check(f"{label}: path finding is under 500ms", path_ms < 500, f"{path_ms:.1f}ms")
    check(f"{label}: impact analysis is under 2s", impact_ms < 2000, f"{impact_ms:.0f}ms")
    check(f"{label}: coverage and isolation reports are under 1s",
          report_ms < 1000, f"{report_ms:.0f}ms")
    check(f"{label}: the path to the VPC is still found", path["found"])
    check(f"{label}: the subnet's blast radius is non-zero",
          impact["total_affected"] > 0, impact["total_affected"])

# A hub with very high degree is the pathological case for a bounded walk:
# one security group attached to two thousand instances.
hub_account = Account("AWS", "hub")
hub_sg = Resource(hub_account, "SecurityGroup", "hub-sg", "sg-hub")
hub_rows = [hub_sg] + [
    Resource(hub_account, "EC2Instance", f"h-{i}", f"i-h{i}",
             config={"security_group_ids": ["sg-hub"]})
    for i in range(2000)
]
started = time.perf_counter()
hub_graph = build_graph(hub_rows, [hub_account], scope="hub")
hub_build = (time.perf_counter() - started) * 1000
started = time.perf_counter()
hub_nb = hub_graph.neighborhood(str(hub_sg.id), hops=2, max_nodes=500)
hub_ms = (time.perf_counter() - started) * 1000
print(f"  2,000-way hub: build {hub_build:.0f}ms  bounded neighbourhood {hub_ms:.1f}ms")
check("a 2,000-way hub builds in under 5s", hub_build < 5000, f"{hub_build:.0f}ms")
check("and its bounded neighbourhood returns quickly", hub_ms < 200, f"{hub_ms:.1f}ms")
eq("respecting the node bound", len(hub_nb["nodes"]), 500)
check("and reporting the truncation", hub_nb["truncated"] is True)


# ── Result ────────────────────────────────────────────────────────────────────
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    for name in fail:
        print(f"  ! {name}")
sys.exit(1 if fail else 0)
