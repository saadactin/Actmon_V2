"""Unit tests for exposure_service and iam_review_service against synthetic
rule shapes, so provider-format bugs are caught before touching live data.
Run: venv\\Scripts\\python.exe tests\\verify_exposure_logic.py
"""
import pathlib
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services.exposure_service import compute_exposure
from app.services.iam_review_service import compute_iam_review, _parse_oci_statement

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


class R:
    """Minimal stand-in for the ORM CloudResource row."""
    def __init__(self, rtype, name, config=None, raw_data=None, provider_resource_id=None):
        self.id = uuid.uuid4()
        self.account_id = uuid.uuid4()
        self.resource_type = rtype
        self.resource_name = name
        self.config = config or {}
        self.raw_data = raw_data or {}
        self.provider_resource_id = provider_resource_id or name


print("1. AWS — default SG with RDP open to the world (the real test_aw finding)")
sg = R("SecurityGroup", "default", provider_resource_id="sg-open", raw_data={
    "IpPermissions": [
        {"IpProtocol": "tcp", "FromPort": 3389, "ToPort": 3389,
         "IpRanges": [{"CidrIp": "0.0.0.0/0"}]},
        {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
         "IpRanges": [{"CidrIp": "10.0.0.0/8"}]},  # private only — must NOT trigger
    ]
})
inst = R("EC2Instance", "web-1", config={"public_ip": "1.2.3.4", "security_group_ids": ["sg-open"]})
rep = compute_exposure([sg, inst])
check("1 exposed resource found", rep["total_exposed"] == 1, str(rep["total_exposed"]))
if rep["exposed_resources"]:
    e = rep["exposed_resources"][0]
    check("severity CRITICAL (RDP)", e["severity"] == "CRITICAL", e["severity"])
    check("RDP port present", any(h.get("port") == 3389 for h in e["open_ports"]))
    check("private-only SSH rule NOT flagged", not any(h.get("port") == 22 for h in e["open_ports"]))

print("\n2. AWS — instance with public IP but no SG attached -> UNKNOWN, not silently safe")
inst2 = R("EC2Instance", "orphan", config={"public_ip": "5.6.7.8", "security_group_ids": []})
rep2 = compute_exposure([inst2])
check("no SG -> not counted as exposed (nothing to prove exposure)", rep2["total_exposed"] == 0)
check("but flagged as unknown coverage", rep2["unknown_coverage"] == 1, str(rep2["unknown_coverage"]))
check("checked count includes it", rep2["total_checked"] == 1)

print("\n3. AWS — private instance (no public IP) with wide-open SG -> must NOT be exposed")
sg3 = R("SecurityGroup", "wide", provider_resource_id="sg-wide", raw_data={
    "IpPermissions": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]
})
inst3 = R("EC2Instance", "internal-only", config={"security_group_ids": ["sg-wide"]})  # no public_ip
rep3 = compute_exposure([sg3, inst3])
check("no public IP -> not exposed regardless of SG", rep3["total_exposed"] == 0, str(rep3["total_exposed"]))

print("\n4. OCI — NSG with world-open ingress on a DB port")
nsg = R("NetworkSecurityGroup", "app-nsg", provider_resource_id="nsg-1", config={
    "ingress_rules": [
        {"protocol": "6", "source_type": "CIDR_BLOCK", "source": "0.0.0.0/0",
         "port_range": {"min": 3306, "max": 3306}},
        {"protocol": "6", "source_type": "NETWORK_SECURITY_GROUP", "source": "nsg-other",
         "port_range": {"min": 22, "max": 22}},  # NSG-scoped, not CIDR -> ignore
    ]
})
oci_inst = R("ComputeInstance", "db-1", config={"public_ip": "9.9.9.9", "nsg_ids": ["nsg-1"]})
rep4 = compute_exposure([nsg, oci_inst])
check("OCI MySQL exposure found", rep4["total_exposed"] == 1)
if rep4["exposed_resources"]:
    check("severity CRITICAL (MySQL)", rep4["exposed_resources"][0]["severity"] == "CRITICAL")

print("\n5. OCI — instance with no NSG and no resolvable subnet -> unknown")
oci_inst2 = R("ComputeInstance", "no-nsg", config={"public_ip": "1.1.1.1", "nsg_ids": []})
rep5 = compute_exposure([oci_inst2])
check("no NSG, no subnet -> unknown coverage, not silently safe", rep5["unknown_coverage"] == 1)

print("\n5b. OCI — no NSG, but the subnet's Security List has a world-open rule "
      "(the real bastion-host case from the live account)")
seclist = R("SecurityList", "Default Security List for bastion-vcn", provider_resource_id="seclist-1", config={
    "is_default": True,
    "ingress_rules": [
        {"protocol": "6", "source_type": "CIDR_BLOCK", "source": "0.0.0.0/0",
         "port_range": {"min": 22, "max": 22}},
    ],
})
bastion_subnet = R("Subnet", "public-subnet", provider_resource_id="subnet-bastion",
                    config={"security_list_ids": ["seclist-1"]})
bastion = R("ComputeInstance", "bastion-host", config={
    "public_ip": "3.3.3.3", "nsg_ids": [], "subnet_id": "subnet-bastion",
})
rep5b = compute_exposure([seclist, bastion_subnet, bastion])
check("Security-List-only exposure now resolves (was 'unknown' before)",
      rep5b["total_exposed"] == 1 and rep5b["unknown_coverage"] == 0,
      f"exposed={rep5b['total_exposed']} unknown={rep5b['unknown_coverage']}")
if rep5b["exposed_resources"]:
    check("SSH port found via Security List",
          any(h.get("port") == 22 for h in rep5b["exposed_resources"][0]["open_ports"]))
    check("confidence is high, not 'unknown'", rep5b["exposed_resources"][0]["confidence"] == "high")

print("\n5c. OCI — Security List with NO world-open rule -> not exposed, and "
      "correctly high-confidence (not unknown, since it WAS resolved)")
seclist_safe = R("SecurityList", "restricted-sl", provider_resource_id="seclist-2", config={
    "ingress_rules": [
        {"protocol": "6", "source_type": "CIDR_BLOCK", "source": "10.0.0.0/8",
         "port_range": {"min": 22, "max": 22}},
    ],
})
safe_subnet = R("Subnet", "private-subnet", provider_resource_id="subnet-safe",
                 config={"security_list_ids": ["seclist-2"]})
safe_inst = R("ComputeInstance", "safe-host", config={
    "public_ip": "4.4.4.4", "nsg_ids": [], "subnet_id": "subnet-safe",
})
rep5c = compute_exposure([seclist_safe, safe_subnet, safe_inst])
check("restricted Security List -> not exposed", rep5c["total_exposed"] == 0)
check("resolved (not unknown) since the Security List WAS found", rep5c["unknown_coverage"] == 0,
      str(rep5c["unknown_coverage"]))

print("\n6. Azure — Allow-all shadowed by a lower-priority-number Deny (exact match)")
nic_id, subnet_id, nsg_id = "nic-1", "subnet-1", "nsg-az-1"
nsg_az = R("NetworkSecurityGroup", "vm-nsg", provider_resource_id=nsg_id, config={
    "ingress_rules": [
        {"priority": 100, "access": "Deny", "protocol": "Tcp",
         "source_address_prefix": "*", "destination_port_range": "3389"},
        {"priority": 200, "access": "Allow", "protocol": "Tcp",
         "source_address_prefix": "*", "destination_port_range": "3389"},
        {"priority": 150, "access": "Allow", "protocol": "Tcp",
         "source_address_prefix": "Internet", "destination_port_range": "22"},
    ]
})
nic = R("NetworkInterface", "vm-nic", provider_resource_id=nic_id,
        config={"public_ip_ids": ["pip-1"], "network_security_group_id": nsg_id, "subnet_ids": []})
vm = R("VirtualMachine", "vm-1", config={"nic_ids": [nic_id]})
rep6 = compute_exposure([nsg_az, nic, vm])
check("Azure VM flagged (SSH survives, RDP shadowed)", rep6["total_exposed"] == 1)
if rep6["exposed_resources"]:
    ports = [h.get("port") for h in rep6["exposed_resources"][0]["open_ports"]]
    check("RDP (3389) shadowed by lower-priority-number Deny -> absent", 3389 not in ports, str(ports))
    check("SSH (22) survives (no shadowing deny)", 22 in ports, str(ports))

print("\n7. Azure — VM with no public IP on any NIC -> not exposed")
nic7 = R("NetworkInterface", "private-nic", provider_resource_id="nic-7",
         config={"public_ip_ids": [], "network_security_group_id": None, "subnet_ids": []})
vm7 = R("VirtualMachine", "vm-private", config={"nic_ids": ["nic-7"]})
rep7 = compute_exposure([nic7, vm7])
check("no public IP -> not exposed", rep7["total_exposed"] == 0)

print("\n8. Web ports (80/443) are informational, not a loud finding driving severity")
sg8 = R("SecurityGroup", "web", provider_resource_id="sg-web", raw_data={
    "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
                        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]
})
inst8 = R("EC2Instance", "web-2", config={"public_ip": "2.2.2.2", "security_group_ids": ["sg-web"]})
rep8 = compute_exposure([sg8, inst8])
check("HTTPS-only exposure is INFO severity, not CRITICAL",
      rep8["exposed_resources"] and rep8["exposed_resources"][0]["severity"] == "INFO",
      rep8["exposed_resources"][0]["severity"] if rep8["exposed_resources"] else "none")

print("\n9. IAM — AWS role with wildcard dynamodb:full flagged; scoped role is not")
role_bad = R("IAMRole", "LambdaBroad", config={
    "broad_access": ["dynamodb:full", "s3:write"],
    "accessible_resources": [],
})
role_ok = R("IAMRole", "LambdaScoped", config={
    "broad_access": [],
    "accessible_resources": [{"resource": "arn:aws:s3:::my-bucket", "access": "read", "service": "s3"}],
})
iam_rep = compute_iam_review([role_bad, role_ok], "AWS")
check("1 flagged role", iam_rep["total_flagged"] == 1, str(iam_rep["total_flagged"]))
check("scoped role not flagged", all(f["name"] != "LambdaScoped" for f in iam_rep["findings"]))

print("\n10. IAM — AWS role that can write IAM itself -> escalation risk, CRITICAL")
role_esc = R("IAMRole", "CanEscalate", config={"broad_access": ["iam:write"], "accessible_resources": []})
iam_rep2 = compute_iam_review([role_esc], "AWS")
check("escalation flagged", iam_rep2["escalation_risk_count"] == 1)
check("severity CRITICAL", iam_rep2["findings"][0]["severity"] == "CRITICAL")

print("\n11. IAM — OCI policy statement parser")
p = _parse_oci_statement("Allow group Administrators to manage all-resources in tenancy")
check("OCI statement parses", p is not None)
if p:
    check("verb=manage", p["verb"] == "manage")
    check("resource=all-resources", p["resource"] == "all-resources")
    check("scope=tenancy", p["scope"] == "tenancy")

policy_bad = R("IAMPolicy", "AdminPolicy", config={
    "statements": ["Allow group Administrators to manage all-resources in tenancy"]
})
policy_ok = R("IAMPolicy", "ReadOnlyPolicy", config={
    "statements": ["Allow group Auditors to read instances in tenancy"]
})
iam_oci = compute_iam_review([policy_bad, policy_ok], "OCI")
check("admin policy flagged CRITICAL", any(
    f["name"] == "AdminPolicy" and f["severity"] == "CRITICAL" for f in iam_oci["findings"]))
check("read-only policy not flagged", all(f["name"] != "ReadOnlyPolicy" for f in iam_oci["findings"]))

print("\n12. IAM — Azure explicitly reports not_scanned, never a fake clean bill")
iam_az = compute_iam_review([], "AZURE")
check("Azure not_scanned=True", iam_az["not_scanned"] is True)
check("Azure findings empty (honest, not fabricated)", iam_az["findings"] == [])

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
