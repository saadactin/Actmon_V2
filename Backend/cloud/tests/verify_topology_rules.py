"""Topology relationship resolution — pure logic, no database, no network.

These are the assertions that decide what the topology CLAIMS is connected.
Two halves, and the second matters more than the first:

*   every provider relationship the rules support actually produces an edge;
*   nothing else does.

The negative half is the load-bearing one. An earlier version of this feature
matched resource names by substring and invented relationships that did not
exist, which is worse than a sparse graph because a wrong edge is
indistinguishable from a real one. Every way that mistake could come back —
similar names, one name containing another, partially matching ids, shared
region, shared resource group, adjacent addresses, matching tags — is pinned
here as a test that NO edge appears.
"""
import pathlib
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.topology.builder import (  # noqa: E402
    arm_parent,
    build_graph,
    extract_resource_group,
    extract_subscription,
    strip_stream_suffix,
)
from app.topology.model import (  # noqa: E402
    IMPACT_FLOW,
    RELATIONSHIPS,
    SYMMETRIC_KINDS,
    category_of,
    health_of,
    reference_class,
)
from app.topology.rules import EXCLUDED_FIELDS, RULES  # noqa: E402

ok, fail = [], []

NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


# ── Fixtures ──────────────────────────────────────────────────────────────────

class Account:
    def __init__(self, provider, name="acct", environment="Production"):
        self.id = uuid.uuid4()
        self.account_name = name
        self.provider = provider
        self.environment = environment
        self.last_discovery = NOW


class Resource:
    """A stand-in for a CloudResource row. Only what the builder reads."""

    def __init__(self, account, rtype, name, pid, *, config=None, metadata=None,
                 region="ap-south-1", status="RUNNING", ip=None, tags=None,
                 raw=None, cost=None):
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
        self.tags = tags or {}
        self.raw_data = raw or {}
        self.cost_monthly = cost
        self.discovered_at = NOW
        self.updated_at = NOW


def graph_of(resources, accounts):
    return build_graph(resources, accounts, scope="test")


def edges_between(graph, source, target):
    """Every edge joining two resources, in either direction."""
    return [
        e for e in graph.edges
        if {e["source"], e["target"]} == {str(source.id), str(target.id)}
    ]


def has_edge(graph, source, target, kind=None):
    for e in edges_between(graph, source, target):
        if kind is None or e["type"] == kind:
            return True
    return False


def edge_between(graph, source, target, kind=None):
    for e in edges_between(graph, source, target):
        if kind is None or e["type"] == kind:
            return e
    return None


# ── 1. Identifier helpers ─────────────────────────────────────────────────────
print("1. identifier helpers")

eq("an Azure resource group is read out of the ARM id",
   extract_resource_group(
       "/subscriptions/abc/resourceGroups/prod-rg/providers/Microsoft.Compute/virtualMachines/vm1"),
   "prod-rg")
eq("resourceGroups matching is case-insensitive",
   extract_resource_group(
       "/subscriptions/abc/RESOURCEGROUPS/Prod-RG/providers/Microsoft.Compute/virtualMachines/vm1"),
   "Prod-RG")
eq("a non-Azure id has no resource group", extract_resource_group("i-0123456789abcdef"), None)
eq("an empty id has no resource group", extract_resource_group(None), None)

eq("the subscription is read out of the ARM id",
   extract_subscription("/subscriptions/1111-2222/resourceGroups/rg/providers/x/y/z"),
   "1111-2222")

eq("an ARM child resolves to its parent",
   arm_parent("/subscriptions/s/resourceGroups/rg/providers/Microsoft.Sql/servers/srv1/databases/db1"),
   "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Sql/servers/srv1")
eq("a nested subnet resolves to its VNet",
   arm_parent("/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vn1/subnets/sn1"),
   "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vn1")
eq("a top-level ARM resource has no parent",
   arm_parent("/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1"),
   None)
eq("a non-ARM id has no parent", arm_parent("ocid1.instance.oc1..aaa"), None)

eq("a DynamoDB Streams ARN is trimmed to its table",
   strip_stream_suffix("arn:aws:dynamodb:ap-south-1:1:table/Orders/stream/2026-08-17T00:00:00.000"),
   "arn:aws:dynamodb:ap-south-1:1:table/Orders")
eq("a plain table ARN is unchanged",
   strip_stream_suffix("arn:aws:dynamodb:ap-south-1:1:table/Orders"),
   "arn:aws:dynamodb:ap-south-1:1:table/Orders")


# ── 2. Vocabulary integrity ───────────────────────────────────────────────────
print("\n2. vocabulary integrity")

check("every relationship kind has an impact direction",
      set(RELATIONSHIPS) == set(IMPACT_FLOW),
      f"missing {set(RELATIONSHIPS) ^ set(IMPACT_FLOW)}")
check("every rule names a relationship kind that exists",
      all(rule.kind in RELATIONSHIPS for rule in RULES),
      [rule.kind for rule in RULES if rule.kind not in RELATIONSHIPS])
check("permission is the only unobserved relationship",
      {k for k, v in RELATIONSHIPS.items() if not v.observed} == {"permission"})
check("symmetric kinds are exactly those declared symmetric",
      SYMMETRIC_KINDS == frozenset(
          k for k, v in RELATIONSHIPS.items() if v.direction == "symmetric"))
check("every rule with a gap reason has a non-empty one",
      all(rule.gap is None or rule.gap.strip() for rule in RULES))
check("excluded fields are documented with a reason",
      all(reason.strip() for reason in EXCLUDED_FIELDS.values()))
eq("a gap naming an uncollected type classifies as unsupported_type",
   reference_class("OCI gateway"), "unsupported_type")
eq("a gap naming a collected type classifies as missing_target",
   reference_class("subnet not discovered"), "missing_target")


# ── 3. Health mapping ─────────────────────────────────────────────────────────
print("\n3. health is never inferred")

eq("RUNNING is healthy", health_of("RUNNING"), "Healthy")
eq("available is healthy", health_of("available"), "Healthy")
eq("Succeeded is healthy", health_of("Succeeded"), "Healthy")
eq("stopped is its own state, not a failure", health_of("stopped"), "Stopped")
eq("deallocated is stopped", health_of("deallocated"), "Stopped")
eq("failed is failed", health_of("FAILED"), "Failed")
eq("provisioning is in transition", health_of("Provisioning"), "Warning")
eq("Azure's PowerState/running compound is understood",
   health_of("PowerState/running"), "Healthy")
# The important one: an absent or unrecognised status must never read as
# healthy. "It exists, so it must be fine" is exactly the inference this
# feature refuses to make.
eq("no status reported -> Unknown", health_of(None), "Unknown")
eq("an empty status -> Unknown", health_of(""), "Unknown")
eq("a status we have never seen -> Unknown", health_of("Zorbulating"), "Unknown")

eq("an EC2 instance is Compute", category_of("EC2Instance"), "Compute")
eq("a security group is Security", category_of("SecurityGroup"), "Security")
eq("an unmapped type is Other, not a guess", category_of("SomeNewService"), "Other")


# ── 4. AWS relationships ──────────────────────────────────────────────────────
print("\n4. AWS relationships")

aws = Account("AWS", "aws-prod")
vpc = Resource(aws, "VPC", "prod-vpc", "vpc-1", config={"cidr_block": "10.0.0.0/16"})
subnet = Resource(aws, "Subnet", "prod-subnet-a", "subnet-1", config={"vpc_id": "vpc-1"})
sg = Resource(aws, "SecurityGroup", "web-sg", "sg-1", config={"vpc_id": "vpc-1"})
role = Resource(aws, "IAMRole", "app-role", "arn:aws:iam::1:role/app-role",
                config={"accessible_resources": [
                    {"resource": "arn:aws:dynamodb:ap-south-1:1:table/Orders", "access": "write"}]})
table = Resource(aws, "DynamoDBTable", "Orders", "arn:aws:dynamodb:ap-south-1:1:table/Orders")
ec2 = Resource(aws, "EC2Instance", "app-server-01", "i-1", config={
    "vpc_id": "vpc-1", "subnet_id": "subnet-1", "security_group_ids": ["sg-1"],
    "role_arn": "arn:aws:iam::1:role/app-role", "private_ip": "10.0.1.5",
})
volume = Resource(aws, "EBSVolume", "app-data", "vol-1", config={
    "attachment_status": "Attached", "attached_to_id": "i-1", "attached_to_status": "running",
})
lb = Resource(aws, "LoadBalancer", "app-lb", "arn:aws:elb:1:lb/app-lb", config={
    "backend_instance_ids": ["i-1"],
})
fn = Resource(aws, "LambdaFunction", "order-processor", "arn:aws:lambda:1:function:order-processor",
              config={
                  "role_arn": "arn:aws:iam::1:role/app-role",
                  "event_source_arns": [
                      "arn:aws:dynamodb:ap-south-1:1:table/Orders/stream/2026-08-17T00:00:00.000"],
                  "environment_variables": {"TABLE_ARN": "arn:aws:dynamodb:ap-south-1:1:table/Orders"},
              })

g = graph_of([vpc, subnet, sg, role, table, ec2, volume, lb, fn], [aws])

check("VPC contains Subnet", has_edge(g, subnet, vpc, "network"))
check("Subnet holds the EC2 instance", has_edge(g, ec2, subnet, "network"))
check("EC2 is guarded by its security group", has_edge(g, ec2, sg, "security"))
check("EC2 assumes its IAM role", has_edge(g, ec2, role, "role"))
check("EBS volume is attached to the instance", has_edge(g, volume, ec2, "attached"))
check("the load balancer forwards to the instance", has_edge(g, lb, ec2, "routes-to"))
check("the role's grant becomes a permission edge from the consumer",
      has_edge(g, ec2, table, "permission"))
check("a DynamoDB stream triggers the function (source -> function)",
      any(e for e in edges_between(g, table, fn)
          if e["type"] == "dataflow" and e["source"] == str(table.id)))

attached = edge_between(g, volume, ec2, "attached")
eq("the attachment edge names the instance state",
   attached["label"], "attached to (running)")
eq("the attachment edge cites the field it came from",
   attached["evidence"]["field"], "config.attached_to_id")
eq("every edge is provider-confirmed",
   {e["evidence"]["confidence"] for e in g.edges}, {"provider-confirmed"})

perm = edge_between(g, ec2, table, "permission")
eq("a permission edge is flagged as not observed", perm["observed"], False)
check("a permission edge says so in its note",
      "NOT mean any access" in (perm["evidence"]["note"] or ""))


# ── 5. AWS wildcard grants are summarised, never expanded ─────────────────────
print("\n5. AWS wildcard IAM grants")

wild_role = Resource(aws, "IAMRole", "broad-role", "arn:aws:iam::1:role/broad-role", config={
    "broad_access": ["dynamodb:*", "s3:GetObject"],
})
t1 = Resource(aws, "DynamoDBTable", "T1", "arn:aws:dynamodb:ap-south-1:1:table/T1")
t2 = Resource(aws, "DynamoDBTable", "T2", "arn:aws:dynamodb:ap-south-1:1:table/T2")
consumer = Resource(aws, "LambdaFunction", "wide", "arn:aws:lambda:1:function:wide",
                    config={"role_arn": "arn:aws:iam::1:role/broad-role"})
g2 = graph_of([wild_role, t1, t2, consumer], [aws])

check("a wildcard grant creates NO permission edge to any table",
      not any(e["type"] == "permission" for e in g2.edges),
      [e["type"] for e in g2.edges])
consumer_node = g2.node(str(consumer.id))
eq("the wildcard is carried onto the consumer as a summary",
   consumer_node.get("broad_access"), ["dynamodb:*", "s3:GetObject"])
check("and onto the role itself",
      g2.node(str(wild_role.id)).get("broad_access") == ["dynamodb:*", "s3:GetObject"])


# ── 6. Azure relationships ────────────────────────────────────────────────────
print("\n6. Azure relationships")

az = Account("Azure", "az-prod")
SUB = "/subscriptions/sub-1/resourceGroups/prod-rg/providers"
vnet = Resource(az, "VirtualNetwork", "prod-vnet", f"{SUB}/Microsoft.Network/virtualNetworks/vn1",
                region="centralindia")
az_subnet = Resource(az, "Subnet", "default",
                     f"{SUB}/Microsoft.Network/virtualNetworks/vn1/subnets/sn1",
                     config={"nat_gateway_id": f"{SUB}/Microsoft.Network/natGateways/nat1",
                             "route_table_id": f"{SUB}/Microsoft.Network/routeTables/rt1"},
                     region="centralindia")
nat = Resource(az, "NatGateways", "nat1", f"{SUB}/Microsoft.Network/natGateways/nat1",
               region="centralindia")
rt = Resource(az, "RouteTable", "rt1", f"{SUB}/Microsoft.Network/routeTables/rt1",
              region="centralindia")
nsg = Resource(az, "NetworkSecurityGroup", "vm-nsg",
               f"{SUB}/Microsoft.Network/networkSecurityGroups/nsg1", region="centralindia")
pip = Resource(az, "PublicIP", "vm-pip", f"{SUB}/Microsoft.Network/publicIPAddresses/pip1",
               config={"attached_to_id":
                       f"{SUB}/Microsoft.Network/networkInterfaces/nic1/ipConfigurations/ipconfig1"},
               ip="20.1.2.3", region="centralindia")
nic = Resource(az, "NetworkInterface", "vm-nic",
               f"{SUB}/Microsoft.Network/networkInterfaces/nic1",
               config={"public_ip_ids": [f"{SUB}/Microsoft.Network/publicIPAddresses/pip1"],
                       "network_security_group_id":
                           f"{SUB}/Microsoft.Network/networkSecurityGroups/nsg1",
                       "subnet_ids": [f"{SUB}/Microsoft.Network/virtualNetworks/vn1/subnets/sn1"]},
               region="centralindia")
disk = Resource(az, "ManagedDisk", "vm-osdisk", f"{SUB}/Microsoft.Compute/disks/disk1",
                config={"managed_by": f"{SUB}/Microsoft.Compute/virtualMachines/vm1"},
                region="centralindia")
vm = Resource(az, "VirtualMachine", "prod-vm", f"{SUB}/Microsoft.Compute/virtualMachines/vm1",
              config={"nic_ids": [f"{SUB}/Microsoft.Network/networkInterfaces/nic1"],
                      "os_disk_id": f"{SUB}/Microsoft.Compute/disks/disk1",
                      "identity_id": "11111111-2222-3333-4444-555555555555"},
              status="PowerState/running", region="centralindia")
sql_srv = Resource(az, "SQLServer", "prod-sql", f"{SUB}/Microsoft.Sql/servers/srv1",
                   region="centralindia")
sql_db = Resource(az, "SQLDatabase", "orders", f"{SUB}/Microsoft.Sql/servers/srv1/databases/db1",
                  metadata={"server": "prod-sql"}, region="centralindia")

g3 = graph_of([vnet, az_subnet, nat, rt, nsg, pip, nic, disk, vm, sql_srv, sql_db], [az])

check("the ARM id nests a subnet inside its VNet", has_edge(g3, az_subnet, vnet, "contains"))
check("the ARM id nests a database inside its server", has_edge(g3, sql_db, sql_srv, "contains"))
check("the VM has its NIC", has_edge(g3, vm, nic, "network"))
check("the VM has its OS disk", has_edge(g3, vm, disk, "attached"))
check("the disk records the VM that manages it", has_edge(g3, disk, vm, "managed-by"))
check("the NIC exposes its public IP", has_edge(g3, nic, pip, "network"))
check("the NIC is guarded by the NSG", has_edge(g3, nic, nsg, "security"))
check("the NIC sits in the subnet", has_edge(g3, nic, az_subnet, "network"))
check("the subnet routes via its route table", has_edge(g3, az_subnet, rt, "network"))
check("the subnet egresses via its NAT gateway", has_edge(g3, az_subnet, nat, "routes-to"))

# The public IP names a NIC ip-configuration, a child path of the NIC.
pip_edge = edge_between(g3, pip, nic, "network")
check("a public IP's ipConfigurations path is trimmed back to the NIC", pip_edge is not None)
check("and the trimming is recorded as evidence",
      "ip-configuration" in (pip_edge["evidence"]["note"] or "")
      if pip_edge else False)

# The Azure managed-identity GUID must never be treated as a resource id.
identity_refs = [
    r for r in g3.unresolved if r["field"] == "config.identity_id"
]
check("Azure's identity_id GUID never registers as an unresolved reference",
      not identity_refs, identity_refs)

vm_node = g3.node(str(vm.id))
eq("the Azure resource group is read onto the node", vm_node["resource_group"], "prod-rg")
eq("the subscription is read onto the node", vm_node["subscription_id"], "sub-1")
eq("PowerState/running maps to Healthy", vm_node["health"], "Healthy")

# Nested resources reach the resource group through their parent, so they are
# not ALSO hung off the hub — that would draw every node twice.
rg_hub = next(n for n in g3.nodes if n["type"] == "ResourceGroup")
hub_children = {e["target"] for e in g3.edges if e["source"] == rg_hub["id"]}
check("the resource-group hub holds top-level resources", str(vm.id) in hub_children)
check("but not resources that reach it through an ARM parent",
      str(sql_db.id) not in hub_children and str(az_subnet.id) not in hub_children)
check("the resource-group hub is flagged synthetic", rg_hub["is_synthetic"] is True)


# ── 7. OCI relationships ──────────────────────────────────────────────────────
print("\n7. OCI relationships")

oci = Account("Oracle", "oci-prod")
COMP = "ocid1.compartment.oc1..prod"
vcn = Resource(oci, "VCN", "prod-vcn", "ocid1.vcn.oc1..v1",
               config={"default_route_table_id": "ocid1.routetable.oc1..rt1",
                       "default_security_list_id": "ocid1.securitylist.oc1..sl1"},
               metadata={"compartment_id": COMP, "compartment_name": "prod"})
oci_rt = Resource(oci, "RouteTable", "Default Route Table", "ocid1.routetable.oc1..rt1",
                  config={"route_rules": [
                      {"destination": "0.0.0.0/0", "destination_type": "CIDR_BLOCK",
                       "network_entity_id": "ocid1.internetgateway.oc1..ig1"}]},
                  metadata={"compartment_id": COMP, "compartment_name": "prod"})
seclist = Resource(oci, "SecurityList", "Default Security List", "ocid1.securitylist.oc1..sl1",
                   metadata={"compartment_id": COMP, "compartment_name": "prod"})
oci_nsg = Resource(oci, "NetworkSecurityGroup", "app-nsg", "ocid1.networksecuritygroup.oc1..nsg1",
                   metadata={"compartment_id": COMP, "compartment_name": "prod"})
oci_subnet = Resource(oci, "Subnet", "app-subnet", "ocid1.subnet.oc1..sn1",
                      config={"vcn_id": "ocid1.vcn.oc1..v1",
                              "security_list_ids": ["ocid1.securitylist.oc1..sl1"],
                              "route_table_id": "ocid1.routetable.oc1..rt1"},
                      metadata={"compartment_id": COMP, "compartment_name": "prod"})
inst = Resource(oci, "ComputeInstance", "app-1", "ocid1.instance.oc1..i1",
                config={"subnet_id": "ocid1.subnet.oc1..sn1",
                        "nsg_ids": ["ocid1.networksecuritygroup.oc1..nsg1"],
                        "private_ip": "10.1.1.10",
                        "availability_domain": "hpAD:AP-MUMBAI-1-AD-1",
                        "image_id": "ocid1.image.oc1..img1"},
                metadata={"compartment_id": COMP, "compartment_name": "prod"})
boot = Resource(oci, "BootVolume", "app-1 (Boot Volume)", "ocid1.bootvolume.oc1..bv1",
                config={"attachment_status": "Attached",
                        "attached_to_id": "ocid1.instance.oc1..i1",
                        "attached_to_status": "RUNNING"},
                metadata={"compartment_id": COMP, "compartment_name": "prod"})
oci_lb = Resource(oci, "LoadBalancer", "app-lb", "ocid1.loadbalancer.oc1..lb1",
                  config={"backend_ips": ["10.1.1.10"]},
                  ip="203.0.113.5",
                  metadata={"compartment_id": COMP, "compartment_name": "prod"})
waf = Resource(oci, "WebAppFirewall", "app-waf", "ocid1.webappfirewall.oc1..w1",
               config={"load_balancer_id": "ocid1.loadbalancer.oc1..lb1",
                       "web_app_firewall_policy_id": "ocid1.webappfirewallpolicy.oc1..p1"},
               metadata={"compartment_id": COMP, "compartment_name": "prod"})
fs = Resource(oci, "FileSystem", "shared-fs", "ocid1.filesystem.oc1..fs1",
              config={"kms_key_id": "ocid1.key.oc1..k1"},
              metadata={"compartment_id": COMP, "compartment_name": "prod"})

g4 = graph_of([vcn, oci_rt, seclist, oci_nsg, oci_subnet, inst, boot, oci_lb, waf, fs], [oci])

check("the VCN holds the subnet", has_edge(g4, oci_subnet, vcn, "network"))
check("the subnet is governed by its Security List", has_edge(g4, oci_subnet, seclist, "security"))
check("the subnet routes via its route table", has_edge(g4, oci_subnet, oci_rt, "network"))
check("the instance sits in the subnet", has_edge(g4, inst, oci_subnet, "network"))
check("the instance is governed by its NSG (nsg_ids, plural)",
      has_edge(g4, inst, oci_nsg, "security"))
check("the boot volume is attached to the instance", has_edge(g4, boot, inst, "attached"))
check("the VCN names its default route table", has_edge(g4, vcn, oci_rt, "network"))
check("the VCN names its default security list", has_edge(g4, vcn, seclist, "security"))
check("the WAF protects the load balancer", has_edge(g4, waf, oci_lb, "protects"))

# The load balancer identifies its backend by IP — the provider's own
# authoritative identifier for a backend, resolved through the address index.
lb_edge = edge_between(g4, oci_lb, inst, "routes-to")
check("the load balancer reaches its backend through the address index",
      lb_edge is not None)
eq("and cites the address it matched on",
   lb_edge["evidence"]["value"] if lb_edge else None, "10.1.1.10")
eq("with the address field as evidence",
   lb_edge["evidence"]["field"] if lb_edge else None, "config.backend_ips")

# A load balancer also has an IP. Mapping an address to the balancer instead of
# the instance would invert the edge, so balancers are excluded from the index.
check("the balancer's own address does not make it its own backend",
      not any(e["source"] == e["target"] for e in g4.edges))

comp_hub = next(n for n in g4.nodes if n["type"] == "Compartment")
eq("the compartment hub is named from the metadata", comp_hub["name"], "prod")
check("the compartment holds the instance",
      any(e["source"] == comp_hub["id"] and e["target"] == str(inst.id) for e in g4.edges))

inst_node = g4.node(str(inst.id))
eq("the availability domain lands in availability_zone, not region",
   inst_node["availability_zone"], "hpAD:AP-MUMBAI-1-AD-1")
eq("and the region stays the region", inst_node["region"], "ap-south-1")

# Machine images are not collected as resources, and image_id has no rule, so
# it must not appear as a gap at all.
image_refs = [r for r in g4.unresolved if "image" in r["field"]]
check("config.image_id never registers as an unresolved reference", not image_refs, image_refs)

# The route rule points at an internet gateway, which no scanner collects.
gateway_refs = [r for r in g4.unresolved if r["gap"] == "OCI gateway"]
eq("a route rule's gateway is reported as one unresolved reference",
   len(gateway_refs), 1)
eq("and classified as a type we do not collect, not as missing data",
   gateway_refs[0]["reference_class"] if gateway_refs else None, "unsupported_type")
key_refs = [r for r in g4.unresolved if r["gap"] == "KMS / Vault key"]
eq("a customer-managed key reference is reported as unsupported, not missing",
   key_refs[0]["reference_class"] if key_refs else None, "unsupported_type")

coverage = g4.coverage()
eq("unsupported references are excluded from the resolved percentage",
   coverage["resolved_pct"], 100.0)
check("but are still counted and reported",
      coverage["unsupported_type"] >= 3, coverage)


# ── 8. NEGATIVE TESTS — the ones that matter most ─────────────────────────────
print("\n8. negative: no relationship is ever invented")

neg = Account("AWS", "neg")

# 8a. Similar names, and one name containing another.
a1 = Resource(neg, "EC2Instance", "prod-api", "i-aaa")
a2 = Resource(neg, "EC2Instance", "prod-api-2", "i-bbb")
a3 = Resource(neg, "S3Bucket", "prod", "arn:aws:s3:::prod")
gn = graph_of([a1, a2, a3], [neg])
eq("similar names produce no edges", len(gn.edges), 0)
check("one name containing another produces no edge", not has_edge(gn, a1, a2))
check("a shorter name inside a longer one produces no edge", not has_edge(gn, a3, a1))

# 8b. Partially matching identifiers.
b1 = Resource(neg, "Subnet", "sn-a", "subnet-123456")
b2 = Resource(neg, "EC2Instance", "host", "i-x", config={"subnet_id": "subnet-1234"})
gn = graph_of([b1, b2], [neg])
eq("a partially matching id resolves to nothing", len(gn.edges), 0)
eq("and is reported as an unresolved reference", len(gn.unresolved), 1)
eq("naming the exact value the provider gave",
   gn.unresolved[0]["value"], "subnet-1234")
eq("and the field it came from", gn.unresolved[0]["field"], "config.subnet_id")

# 8c. Same region.
c1 = Resource(neg, "EC2Instance", "one", "i-1r", region="ap-south-1")
c2 = Resource(neg, "RDSInstance", "two", "db-1r", region="ap-south-1")
eq("sharing a region produces no edge", len(graph_of([c1, c2], [neg]).edges), 0)

# 8d. Same tags.
d1 = Resource(neg, "EC2Instance", "one", "i-1t", tags={"env": "prod", "app": "api"})
d2 = Resource(neg, "S3Bucket", "two", "arn:aws:s3:::two", tags={"env": "prod", "app": "api"})
eq("identical tags produce no edge", len(graph_of([d1, d2], [neg]).edges), 0)

# 8e. Adjacent IP addresses.
e1 = Resource(neg, "EC2Instance", "one", "i-1i", config={"private_ip": "10.0.1.5"})
e2 = Resource(neg, "EC2Instance", "two", "i-2i", config={"private_ip": "10.0.1.6"})
eq("adjacent addresses produce no edge", len(graph_of([e1, e2], [neg]).edges), 0)

# 8f. Same Azure resource group — the hub is a real containment, but the two
#     members must not be joined to each other.
az2 = Account("Azure", "az-neg")
RG = "/subscriptions/s/resourceGroups/shared/providers"
f1 = Resource(az2, "VirtualMachine", "vm-a", f"{RG}/Microsoft.Compute/virtualMachines/a")
f2 = Resource(az2, "StorageAccount", "st-b", f"{RG}/Microsoft.Storage/storageAccounts/b")
gn = graph_of([f1, f2], [az2])
check("sharing a resource group does not join two members to each other",
      not has_edge(gn, f1, f2))
eq("they are both held by the group hub instead",
   len([e for e in gn.edges if e["type"] == "contains"]), 2)

# 8g. An ambiguous name must be refused, not resolved to whichever came first.
g1 = Resource(neg, "SQLServer", "shared", "arn:one")
g2 = Resource(neg, "SQLServer", "shared", "arn:two")
g3r = Resource(neg, "SQLDatabase", "db", "arn:db", metadata={"server": "shared"})
gn = graph_of([g1, g2, g3r], [neg])
check("a name shared by two resources resolves to neither",
      not has_edge(gn, g3r, g1) and not has_edge(gn, g3r, g2))
amb = [r for r in gn.unresolved if r["field"] == "metadata.server"]
check("and the ambiguity is stated as the reason",
      bool(amb) and "ambiguous" in amb[0]["explanation"].lower(),
      amb[0]["explanation"] if amb else None)

# 8h. A detached volume that remembers its last instance is NOT attached.
h1 = Resource(neg, "EC2Instance", "host", "i-h")
h2 = Resource(neg, "EBSVolume", "vol", "vol-h", config={
    "attachment_status": "Detached", "attached_to_id": "i-h",
})
eq("a detached volume draws no attachment edge",
   len(graph_of([h1, h2], [neg]).edges), 0)

# 8i. A Lambda environment variable that is not a resource identifier.
i1 = Resource(neg, "LambdaFunction", "fn", "arn:aws:lambda:1:function:fn", config={
    "environment_variables": {"LOG_LEVEL": "debug", "FEATURE_X": "true", "REGION": "ap-south-1"},
})
i2 = Resource(neg, "DynamoDBTable", "debug", "arn:aws:dynamodb:1:table/debug")
gn = graph_of([i1, i2], [neg])
eq("an environment variable that is not an identifier draws no edge", len(gn.edges), 0)
eq("and is not reported as a gap either (they are mostly not references)",
   len(gn.unresolved), 0)


# ── 9. Duplicate and directional edges ────────────────────────────────────────
print("\n9. symmetric deduplication, directional preservation")

sym = Account("Azure", "sym")
S = "/subscriptions/s/resourceGroups/rg/providers"
# Both ends report the same structural fact: the NIC lists its public IP, and
# the public IP lists the NIC it is attached to.
s_nic = Resource(sym, "NetworkInterface", "nic", f"{S}/Microsoft.Network/networkInterfaces/n1",
                 config={"public_ip_ids": [f"{S}/Microsoft.Network/publicIPAddresses/p1"]})
s_pip = Resource(sym, "PublicIP", "pip", f"{S}/Microsoft.Network/publicIPAddresses/p1",
                 config={"attached_to_id": f"{S}/Microsoft.Network/networkInterfaces/n1"})
gs = graph_of([s_nic, s_pip], [sym])
eq("a symmetric fact reported from both ends is stored once",
   len(edges_between(gs, s_nic, s_pip)), 1)

# A directed pair genuinely means different things each way and must survive.
dir_acct = Account("AWS", "dir")
d_fn = Resource(dir_acct, "LambdaFunction", "fn", "arn:fn", config={
    "environment_variables": {"T": "arn:tbl"},
})
d_tbl = Resource(dir_acct, "DynamoDBTable", "tbl", "arn:tbl", config={
    "event_source_arns": [],
})
gd = graph_of([d_fn, d_tbl], [dir_acct])
eq("a directed relationship is drawn once in its own direction",
   len(edges_between(gd, d_fn, d_tbl)), 1)
eq("and points from the function to the table",
   edges_between(gd, d_fn, d_tbl)[0]["source"], str(d_fn.id))

# Two directed edges of DIFFERENT kinds between the same pair are both real.
both = Account("AWS", "both")
b_role = Resource(both, "IAMRole", "r", "arn:aws:iam::1:role/r", config={
    "accessible_resources": [{"resource": "arn:tbl2", "access": "read"}],
})
b_fn = Resource(both, "LambdaFunction", "fn2", "arn:fn2",
                config={"role_arn": "arn:aws:iam::1:role/r"})
b_tbl = Resource(both, "DynamoDBTable", "tbl2", "arn:tbl2")
gb = graph_of([b_role, b_fn, b_tbl], [both])
kinds = {e["type"] for e in gb.edges}
check("a role edge and a permission edge coexist", {"role", "permission"} <= kinds, kinds)


# ── 10. Isolation is always explained ─────────────────────────────────────────
print("\n10. isolation reasons")

iso = Account("AWS", "iso")
lonely_wild = Resource(iso, "IAMRole", "wild", "arn:aws:iam::1:role/wild",
                       config={"broad_access": ["s3:*"]})
lonely_bare = Resource(iso, "S3Bucket", "bare", "arn:aws:s3:::bare")
lonely_ref = Resource(iso, "EC2Instance", "orphan", "i-orphan",
                      config={"subnet_id": "subnet-gone"})
gi = graph_of([lonely_wild, lonely_bare, lonely_ref], [iso])
report = gi.isolated_report()
by_id = {row["id"]: row for row in report["resources"]}

eq("all three are unconnected", report["total"], 3)
eq("a wildcard grant explains its own isolation",
   by_id[str(lonely_wild.id)]["reason"], "wildcard_permission")
eq("an unresolved reference explains isolation",
   by_id[str(lonely_ref.id)]["reason"], "references_unresolved")
eq("a resource type carrying no relationship field says so",
   by_id[str(lonely_bare.id)]["reason"], "no_relationship_fields")
check("every isolation reason carries an explanation",
      all(row["explanation"].strip() for row in report["resources"]))


# ── 11. Multi-cloud: no cross-provider edge is invented ───────────────────────
print("\n11. multi-cloud")

m_aws = Account("AWS", "m-aws")
m_az = Account("Azure", "m-az")
m_oci = Account("Oracle", "m-oci")
# Deliberately identical names and addresses across three clouds.
x1 = Resource(m_aws, "EC2Instance", "shared-name", "i-m1", config={"private_ip": "10.0.0.5"})
x2 = Resource(m_az, "VirtualMachine", "shared-name",
              "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/m2",
              config={"private_ip": "10.0.0.5"})
x3 = Resource(m_oci, "ComputeInstance", "shared-name", "ocid1.instance.oc1..m3",
              config={"private_ip": "10.0.0.5"})
gm = graph_of([x1, x2, x3], [m_aws, m_az, m_oci])
cross = [
    e for e in gm.edges
    if gm.node(e["source"])["provider"] != gm.node(e["target"])["provider"]
]
eq("identical names and addresses across three clouds create no cross-cloud edge",
   len(cross), 0)
eq("each provider is labelled canonically",
   {n["provider"] for n in gm.nodes if not n["is_synthetic"]},
   {"AWS", "Azure", "OCI"})


# ── Result ────────────────────────────────────────────────────────────────────
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    for name in fail:
        print(f"  ! {name}")
sys.exit(1 if fail else 0)
