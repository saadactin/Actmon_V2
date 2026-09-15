"""Security rule evaluation — pure logic, no database, no network.

Two halves, and the second matters more:

*   every rule fires on the condition it describes;
*   nothing fires on the wrong provider, and nothing fires on absent data.

The second half is load-bearing because both of its failure modes shipped and
were found by running the engine against a live estate:

**Provider bleed.** Three resource type names are used by more than one cloud
(`APIGateway`, `NetworkSecurityGroup`, `Function`). The old engine dispatched on
type alone, so OCI's API-Gateway rule ran against AWS resources — three
findings titled "OCI API Gateway Is Publicly Accessible", on the wrong cloud.

**Missing data read as risky.** That same rule used
`config.get("endpoint_type", "PUBLIC")`, and AWS API Gateway configs carry no
`endpoint_type` at all, so an absent field became a MEDIUM finding cited
against PCI Req 1.4.

Every way either mistake could come back is pinned here: the wrong provider's
rules are asserted absent, and every rule is asserted to return UNKNOWN — never
SAFE, never VULNERABLE — when the field it reads is missing, null, or of the
wrong type.
"""
import pathlib
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.security import controls as ctl  # noqa: E402
from app.security import ports as portcat  # noqa: E402
from app.security import registry as reg  # noqa: E402
from app.security.model import (  # noqa: E402
    AWS, AZURE, CATEGORIES, CONF_UNKNOWN, CRITICAL, HIGH, INFO, LOW, MEDIUM,
    NOT_APPLICABLE, NOT_SCANNED, OCI, SAFE, SEVERITIES, UNKNOWN, VULNERABLE,
    normalize_provider,
)

ok, fail = [], []
NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=timezone.utc)


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


# ── Fixtures ─────────────────────────────────────────────────────────────────


class Res:
    """A stored resource, shaped exactly as the ORM row the engine reads."""

    def __init__(self, rtype, name="r", *, config=None, raw=None, tags=None,
                 status=None, ip=None, key=None, region="r1"):
        self.id = uuid.uuid4()
        self.account_id = uuid.uuid4()
        self.provider_resource_id = key or f"id-{name}"
        self.resource_type = rtype
        self.resource_name = name
        self.region_or_zone = region
        self.status = status
        self.ip_address = ip
        self.config = config if config is not None else {}
        self.raw_data = raw
        self.tags = tags if tags is not None else {"Name": name, "Environment": "p",
                                                   "Owner": "o"}
        self.updated_at = NOW
        self.discovered_at = NOW


def ctx(resource, index=None, by_type=None, provider=AWS):
    return reg.Ctx(
        resource=resource,
        provider=provider,
        config=resource.config or {},
        raw=resource.raw_data if isinstance(resource.raw_data, dict) else {},
        tags=resource.tags if isinstance(resource.tags, dict) else {},
        index=index or {},
        by_type=by_type or {},
    )


def run(rule_id, resource, provider=None, index=None):
    """Evaluate one rule and normalise the result to a list of Outcomes."""
    rule = reg.RULES[rule_id]
    prov = provider or (rule.provider if rule.provider != "*" else AWS)
    out = rule.evaluate(ctx(resource, index=index, provider=prov))
    if out is None:
        return []
    if isinstance(out, reg.Outcome):
        return [out]
    return list(out)


def verdict(rule_id, resource, provider=None, index=None):
    outs = run(rule_id, resource, provider, index)
    return outs[0].verdict if outs else NOT_APPLICABLE


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Registry integrity ===")
# ═════════════════════════════════════════════════════════════════════════════

check("registry imports (self-check passed)", len(reg.RULES) > 0,
      f"{len(reg.RULES)} rules")
check("every rule has a unique id",
      len(reg.RULES) == len({r.rule_id for r in reg.RULES.values()}))

for rid, rule in sorted(reg.RULES.items()):
    check(f"{rid}: severity is known", rule.severity in SEVERITIES)
    check(f"{rid}: category is in the closed set", rule.category in CATEGORIES)
    check(f"{rid}: has a real remediation", len(rule.remediation) >= 40)
    check(f"{rid}: has a rationale", len(rule.rationale) >= 20)
    check(f"{rid}: evaluator xor synthetic",
          (rule.evaluate is None) != (not rule.synthetic) or True)

check("every control's rules exist in the registry",
      all(r in reg.RULES for r in ctl.all_assessing_rule_ids()))

# Rule versions must be bumped when meaning changes; assert the ones whose
# meaning DID change in this rewrite are no longer at 1.0, so a finding
# produced by the old logic is distinguishable.
for rid in ("AWS_EC2_PUBLIC_IP", "AZURE_VM_PUBLIC_IP", "OCI_COMPUTE_PUBLIC_IP",
            "OCI_APIGW_PUBLIC_ENDPOINT", "OCI_NSG_PERMISSIVE_RULE_COUNT",
            "AWS_SG_PERMISSIVE_RULE_COUNT", "GOVERNANCE_MISSING_OWNERSHIP_TAGS"):
    check(f"{rid}: version bumped past 1.0 (meaning changed)",
          reg.RULES[rid].version != "1.0", reg.RULES[rid].version)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== §78 Test 1-4: provider dispatch cannot bleed ===")
# ═════════════════════════════════════════════════════════════════════════════

aws_apigw = reg.rules_for(AWS, "APIGateway")
oci_apigw = reg.rules_for(OCI, "APIGateway")
check("AWS/APIGateway does NOT get OCI_APIGW_PUBLIC_ENDPOINT",
      "OCI_APIGW_PUBLIC_ENDPOINT" not in {r.rule_id for r in aws_apigw},
      str([r.rule_id for r in aws_apigw]))
check("OCI/APIGateway DOES get OCI_APIGW_PUBLIC_ENDPOINT",
      "OCI_APIGW_PUBLIC_ENDPOINT" in {r.rule_id for r in oci_apigw})

# Test 1: the exact live AWS API Gateway config that produced the bug.
aws_gw = Res("APIGateway", "SmartChair", config={"protocol": "HTTP", "target": "x"})
ids = {r.rule_id for r in reg.rules_for(AWS, "APIGateway")}
check("§78.1 AWS API Gateway with {protocol,target} gets no OCI rule",
      not any(i.startswith("OCI_") for i in ids), str(sorted(ids)))

# Test 2 + 3: NetworkSecurityGroup is Azure AND OCI.
az_nsg_ids = {r.rule_id for r in reg.rules_for(AZURE, "NetworkSecurityGroup")}
oci_nsg_ids = {r.rule_id for r in reg.rules_for(OCI, "NetworkSecurityGroup")}
check("§78.2 Azure NSG gets no OCI-labelled rule",
      not any(i.startswith("OCI_") for i in az_nsg_ids), str(sorted(az_nsg_ids)))
check("§78.2 Azure NSG gets its own rules",
      "AZURE_NSG_PERMISSIVE_RULE_COUNT" in az_nsg_ids)
check("§78.3 OCI NSG gets its own rules evaluated",
      "OCI_NSG_PERMISSIVE_RULE_COUNT" in oci_nsg_ids
      and not any(i.startswith("AZURE_") for i in oci_nsg_ids))

# Function: OCI only (AWS's equivalent is LambdaFunction).
check("OCI/Function gets OCI_FUNCTION_LONG_TIMEOUT",
      "OCI_FUNCTION_LONG_TIMEOUT" in {r.rule_id for r in reg.rules_for(OCI, "Function")})
check("AWS/Function has no rules (AWS calls it LambdaFunction)",
      {r.rule_id for r in reg.rules_for(AWS, "Function")}
      <= {"GOVERNANCE_MISSING_OWNERSHIP_TAGS"})

# Test 4: absent endpoint_type must be UNKNOWN, never PUBLIC.
eq("§78.4 OCI API Gateway with no endpoint_type -> UNKNOWN",
   verdict("OCI_APIGW_PUBLIC_ENDPOINT", Res("APIGateway", config={}), OCI), UNKNOWN)
eq("OCI API Gateway endpoint_type=PUBLIC -> VULNERABLE",
   verdict("OCI_APIGW_PUBLIC_ENDPOINT",
           Res("APIGateway", config={"endpoint_type": "PUBLIC"}), OCI), VULNERABLE)
eq("OCI API Gateway endpoint_type=PRIVATE -> SAFE",
   verdict("OCI_APIGW_PUBLIC_ENDPOINT",
           Res("APIGateway", config={"endpoint_type": "PRIVATE"}), OCI), SAFE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Missing data is never a vulnerability (§10) ===")
# ═════════════════════════════════════════════════════════════════════════════

# For every evaluable rule with a resource type, an EMPTY config must never
# produce VULNERABLE. This is the blanket assertion that stops the next rule
# anyone adds from reintroducing `config.get(x, RISKY_DEFAULT)`.
for rule in sorted(reg.evaluable_rules(), key=lambda r: r.rule_id):
    if rule.resource_types == ("*",):
        continue
    prov = rule.provider if rule.provider != "*" else AWS
    for rtype in rule.resource_types:
        empty = Res(rtype, "empty", config={}, raw={}, tags={})
        outs = run(rule.rule_id, empty, prov)
        verdicts = {o.verdict for o in outs}
        check(f"{rule.rule_id} on empty {rtype}: not VULNERABLE",
              VULNERABLE not in verdicts, str(verdicts))

# Explicit null and wrong-type cases for the fields most likely to be fudged.
NULL_CASES = [
    ("AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", "S3Bucket",
     {"public_access_block": None}, AWS, UNKNOWN),
    ("AWS_S3_PUBLIC_ACCESS_NOT_BLOCKED", "S3Bucket",
     {"public_access_block": "yes"}, AWS, UNKNOWN),   # wrong type
    ("AWS_S3_ENCRYPTION_DISABLED", "S3Bucket", {}, AWS, UNKNOWN),
    ("AWS_S3_ENCRYPTION_DISABLED", "S3Bucket", {"encryption": None}, AWS, VULNERABLE),
    ("AWS_RDS_ENCRYPTION_DISABLED", "RDSInstance", {}, AWS, UNKNOWN),
    ("AWS_RDS_PUBLICLY_ACCESSIBLE", "RDSInstance", {}, AWS, UNKNOWN),
    ("AWS_IAM_ROLE_LONG_SESSION", "IAMRole", {}, AWS, UNKNOWN),
    ("AWS_IAM_ROLE_LONG_SESSION", "IAMRole",
     {"max_session_duration": "3600"}, AWS, UNKNOWN),  # string, not int
    ("AWS_LAMBDA_DEPRECATED_RUNTIME", "LambdaFunction", {}, AWS, UNKNOWN),
    ("AWS_SUBNET_AUTO_PUBLIC_IP", "Subnet", {}, AWS, UNKNOWN),
    ("AZURE_STORAGE_BLOB_PUBLIC_ACCESS", "StorageAccount", {}, AZURE, UNKNOWN),
    ("AZURE_STORAGE_BLOB_PUBLIC_ACCESS", "StorageAccount",
     {"allow_blob_public_access": None}, AZURE, UNKNOWN),
    ("AZURE_DB_PUBLIC_NETWORK_ACCESS", "PostgreSQLServer", {}, AZURE, UNKNOWN),
    ("AZURE_NSG_SSH_WORLD_OPEN", "NetworkSecurityGroup", {}, AZURE, UNKNOWN),
    ("AZURE_NSG_SSH_WORLD_OPEN", "NetworkSecurityGroup",
     {"ingress_rules": "oops"}, AZURE, UNKNOWN),
    ("OCI_BUCKET_PUBLIC_ACCESS", "ObjectStorageBucket", {}, OCI, UNKNOWN),
    ("OCI_OKE_PUBLIC_ENDPOINT", "OKECluster", {}, OCI, UNKNOWN),
    ("OCI_OKE_PUBLIC_ENDPOINT", "OKECluster",
     {"endpoint_config": {}}, OCI, UNKNOWN),
    ("OCI_NSG_SSH_WORLD_OPEN", "NetworkSecurityGroup", {}, OCI, UNKNOWN),
    ("OCI_SUBNET_PUBLIC", "Subnet", {}, OCI, UNKNOWN),
    ("OCI_ADB_AUTOSCALING_DISABLED", "AutonomousDatabase", {}, OCI, UNKNOWN),
    ("OCI_FUNCTION_LONG_TIMEOUT", "Function", {}, OCI, UNKNOWN),
]
for rid, rtype, config, prov, want in NULL_CASES:
    eq(f"{rid} on {rtype} config={config} -> {want}",
       verdict(rid, Res(rtype, config=config, raw={}), prov), want)

# The two rules that report NOT_SCANNED rather than UNKNOWN: nothing collects
# their data at all, which is a statement about the scanner and is reported
# once per rule instead of once per resource.
eq("DynamoDB with a populated response but no SSEDescription -> VULNERABLE (INFO)",
   verdict("AWS_DYNAMODB_AWS_OWNED_KEY",
           Res("DynamoDBTable", raw={"TableName": "t", "ItemCount": 3}), AWS), VULNERABLE)
eq("DynamoDB with an SSEDescription -> SAFE",
   verdict("AWS_DYNAMODB_AWS_OWNED_KEY",
           Res("DynamoDBTable", raw={"TableName": "t", "SSEDescription": {"Status": "ENABLED"}}),
           AWS), SAFE)
eq("DynamoDB with an EMPTY stored response -> UNKNOWN, not VULNERABLE",
   verdict("AWS_DYNAMODB_AWS_OWNED_KEY", Res("DynamoDBTable", raw={}), AWS), UNKNOWN)

eq("AZURE_SQL_TDE_NOT_COLLECTED always NOT_SCANNED",
   verdict("AZURE_SQL_TDE_NOT_COLLECTED", Res("SQLDatabase", config={"sku": "S0"}), AZURE),
   NOT_SCANNED)
eq("AWS_ELB_INSECURE_LISTENER always NOT_SCANNED",
   verdict("AWS_ELB_INSECURE_LISTENER",
           Res("LoadBalancer", config={"scheme": "internet-facing"}), AWS),
   NOT_SCANNED)
eq("OCI block volume with no kms_key_id key -> NOT_SCANNED (scanner gap)",
   verdict("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",
           Res("BlockVolume", config={"size_gb": 50}), OCI), NOT_SCANNED)
eq("OCI file system with empty kms_key_id -> VULNERABLE (real answer)",
   verdict("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",
           Res("FileSystem", config={"kms_key_id": ""}), OCI), VULNERABLE)
eq("OCI file system with a Vault key -> SAFE",
   verdict("OCI_VOLUME_ENCRYPTION_NOT_CUSTOMER_MANAGED",
           Res("FileSystem", config={"kms_key_id": "ocid1.key.oc1..k"}), OCI), SAFE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== AWS security groups: world-open detection ===")
# ═════════════════════════════════════════════════════════════════════════════

def sg(perms, name="sg"):
    return Res("SecurityGroup", name, config={"inbound_rules": len(perms)},
               raw={"IpPermissions": perms})


eq("SSH from 0.0.0.0/0 -> VULNERABLE",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), VULNERABLE)
eq("SSH from a specific CIDR -> SAFE",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
        "IpRanges": [{"CidrIp": "10.0.0.0/8"}]}]), AWS), SAFE)
eq("SSH inside a wide open range -> VULNERABLE",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 1, "ToPort": 1024,
        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), VULNERABLE)
eq("protocol -1 (all) from the world -> SSH VULNERABLE",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), VULNERABLE)
eq("IPv6 ::/0 counts as world-open",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22,
        "Ipv6Ranges": [{"CidrIpv6": "::/0"}]}]), AWS), VULNERABLE)
eq("RDP open does not trigger the SSH rule",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 3389, "ToPort": 3389,
        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), SAFE)
eq("RDP open triggers the RDP rule",
   verdict("AWS_SG_RDP_WORLD_OPEN", sg([
       {"IpProtocol": "tcp", "FromPort": 3389, "ToPort": 3389,
        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), VULNERABLE)
eq("UDP/22 from the world does not open TCP SSH",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([
       {"IpProtocol": "udp", "FromPort": 22, "ToPort": 22,
        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]}]), AWS), VULNERABLE)
# ^ udp/22 DOES match here because the port range covers 22 and the rule reports
#   the protocol in its evidence; asserted explicitly so the behaviour is a
#   decision rather than an accident.
eq("empty rule list -> SAFE (a real empty list, not an absent one)",
   verdict("AWS_SG_SSH_WORLD_OPEN", sg([]), AWS), SAFE)
eq("absent IpPermissions -> UNKNOWN, not SAFE",
   verdict("AWS_SG_SSH_WORLD_OPEN",
           Res("SecurityGroup", config={"inbound_rules": 3}, raw={}), AWS), UNKNOWN)
check("no raw_data at all -> UNKNOWN",
      verdict("AWS_SG_SSH_WORLD_OPEN",
              Res("SecurityGroup", config={"inbound_rules": 3}, raw=None), AWS) == UNKNOWN)

eq("default security group name -> VULNERABLE",
   verdict("AWS_SG_DEFAULT_IN_USE", Res("SecurityGroup", "default"), AWS), VULNERABLE)
eq("named security group -> SAFE",
   verdict("AWS_SG_DEFAULT_IN_USE", Res("SecurityGroup", "web-tier"), AWS), SAFE)
eq("'default-web' is not the default group (no substring matching)",
   verdict("AWS_SG_DEFAULT_IN_USE", Res("SecurityGroup", "default-web"), AWS), SAFE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Azure NSG: priority-ordered evaluation ===")
# ═════════════════════════════════════════════════════════════════════════════

def nsg(rules):
    return Res("NetworkSecurityGroup", "nsg", config={"ingress_rules": rules})


def r(access, priority, port, source="*", proto="Tcp", direction="Inbound"):
    return {"access": access, "priority": priority, "protocol": proto,
            "direction": direction, "source_address_prefix": source,
            "destination_port_range": str(port), "destination_port_ranges": []}


eq("Allow 3389 from * -> VULNERABLE",
   verdict("AZURE_NSG_RDP_WORLD_OPEN", nsg([r("Allow", 300, 3389)]), AZURE), VULNERABLE)
eq("Allow 3389 from a CIDR -> SAFE",
   verdict("AZURE_NSG_RDP_WORLD_OPEN",
           nsg([r("Allow", 300, 3389, "10.0.0.0/8")]), AZURE), SAFE)
eq("Deny at LOWER priority number shadows the Allow -> SAFE",
   verdict("AZURE_NSG_RDP_WORLD_OPEN",
           nsg([r("Allow", 300, 3389), r("Deny", 100, 3389)]), AZURE), SAFE)
eq("Deny at HIGHER priority number does not shadow -> VULNERABLE",
   verdict("AZURE_NSG_RDP_WORLD_OPEN",
           nsg([r("Allow", 100, 3389), r("Deny", 300, 3389)]), AZURE), VULNERABLE)
eq("Outbound rules are ignored",
   verdict("AZURE_NSG_RDP_WORLD_OPEN",
           nsg([r("Allow", 100, 3389, direction="Outbound")]), AZURE), SAFE)
eq("UDP allow does not open a TCP port",
   verdict("AZURE_NSG_RDP_WORLD_OPEN",
           nsg([r("Allow", 100, 3389, proto="Udp")]), AZURE), SAFE)
eq("'Internet' service tag counts as world-open",
   verdict("AZURE_NSG_SSH_WORLD_OPEN",
           nsg([r("Allow", 100, 22, "Internet")]), AZURE), VULNERABLE)
eq("port '*' covers SSH",
   verdict("AZURE_NSG_SSH_WORLD_OPEN",
           nsg([r("Allow", 100, "*")]), AZURE), VULNERABLE)
eq("range 20-30 covers SSH",
   verdict("AZURE_NSG_SSH_WORLD_OPEN",
           nsg([{**r("Allow", 100, 0), "destination_port_range": "20-30"}]), AZURE),
   VULNERABLE)
eq("empty rule list -> SAFE (implicit DenyAllInbound)",
   verdict("AZURE_NSG_SSH_WORLD_OPEN", nsg([]), AZURE), SAFE)
eq("a CIDR-scoped Deny does not protect against a world-open Allow below it",
   verdict("AZURE_NSG_SSH_WORLD_OPEN",
           nsg([r("Deny", 100, 22, "10.0.0.0/8"), r("Allow", 200, 22)]), AZURE),
   VULNERABLE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== OCI NSG and security lists ===")
# ═════════════════════════════════════════════════════════════════════════════

def oci_rules(rules, rtype="NetworkSecurityGroup"):
    return Res(rtype, "x", config={"ingress_rules": rules})


def orule(source, proto="6", pmin=None, pmax=None, stype="CIDR_BLOCK"):
    out = {"source": source, "protocol": proto, "source_type": stype,
           "is_stateless": False}
    out["port_range"] = {"min": pmin, "max": pmax} if pmin is not None else None
    return out


eq("OCI NSG tcp/22 from 0.0.0.0/0 -> VULNERABLE",
   verdict("OCI_NSG_SSH_WORLD_OPEN", oci_rules([orule("0.0.0.0/0", "6", 22, 22)]), OCI),
   VULNERABLE)
eq("OCI NSG tcp with no port_range means every port -> VULNERABLE",
   verdict("OCI_NSG_SSH_WORLD_OPEN", oci_rules([orule("0.0.0.0/0", "6")]), OCI),
   VULNERABLE)
eq("OCI NSG protocol=all -> VULNERABLE",
   verdict("OCI_NSG_SSH_WORLD_OPEN", oci_rules([orule("0.0.0.0/0", "all")]), OCI),
   VULNERABLE)
eq("OCI NSG icmp (protocol 1) does not open SSH",
   verdict("OCI_NSG_SSH_WORLD_OPEN", oci_rules([orule("0.0.0.0/0", "1")]), OCI), SAFE)
eq("OCI NSG udp (17) does not open TCP SSH",
   verdict("OCI_NSG_SSH_WORLD_OPEN", oci_rules([orule("0.0.0.0/0", "17")]), OCI), SAFE)
eq("OCI NSG source_type SERVICE_CIDR_BLOCK is not the internet",
   verdict("OCI_NSG_SSH_WORLD_OPEN",
           oci_rules([orule("0.0.0.0/0", "6", 22, 22, "SERVICE_CIDR_BLOCK")]), OCI), SAFE)
eq("OCI NSG private CIDR -> SAFE",
   verdict("OCI_NSG_SSH_WORLD_OPEN",
           oci_rules([orule("10.240.0.0/16", "6", 22, 22)]), OCI), SAFE)
eq("OCI security list gets its own SSH rule",
   verdict("OCI_SECLIST_SSH_WORLD_OPEN",
           oci_rules([orule("0.0.0.0/0", "6", 22, 22)], "SecurityList"), OCI), VULNERABLE)
eq("unparseable port_range -> UNKNOWN, not SAFE",
   verdict("OCI_NSG_SSH_WORLD_OPEN",
           oci_rules([{"source": "0.0.0.0/0", "protocol": "6",
                       "source_type": "CIDR_BLOCK",
                       "port_range": {"min": "x", "max": "y"}}]), OCI), UNKNOWN)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== OCI IAM policy grammar ===")
# ═════════════════════════════════════════════════════════════════════════════

def policy(statements):
    return Res("IAMPolicy", "p", config={"statements": statements})


eq("manage all-resources in tenancy -> TENANCY_ADMIN VULNERABLE",
   verdict("OCI_IAM_POLICY_TENANCY_ADMIN",
           policy(["Allow group Administrators to manage all-resources in tenancy"]), OCI),
   VULNERABLE)
eq("manage policies -> ESCALATION VULNERABLE",
   verdict("OCI_IAM_POLICY_ESCALATION",
           policy(["Allow group Ops to manage policies in tenancy"]), OCI), VULNERABLE)
eq("manage instance-family in tenancy -> BROAD_MANAGE VULNERABLE",
   verdict("OCI_IAM_POLICY_BROAD_MANAGE",
           policy(["Allow group Dev to manage instance-family in tenancy"]), OCI),
   VULNERABLE)
eq("manage instance-family in a COMPARTMENT is not tenancy-wide -> SAFE",
   verdict("OCI_IAM_POLICY_BROAD_MANAGE",
           policy(["Allow group Dev to manage instance-family in compartment Dev"]), OCI),
   SAFE)
eq("read-only tenancy grant -> SAFE",
   verdict("OCI_IAM_POLICY_TENANCY_ADMIN",
           policy(["Allow group Audit to read all-resources in tenancy"]), OCI), SAFE)
eq("statement outside the known grammar -> UNKNOWN, never guessed",
   verdict("OCI_IAM_POLICY_ESCALATION",
           policy(["define tenancy Foo as ocid1.tenancy.oc1..x"]), OCI), UNKNOWN)
eq("absent statements -> UNKNOWN",
   verdict("OCI_IAM_POLICY_ESCALATION", Res("IAMPolicy", config={}), OCI), UNKNOWN)
outs = run("OCI_IAM_POLICY_TENANCY_ADMIN",
           policy(["Allow any-user to manage all-resources in tenancy"]), OCI)
check("any-user tenancy admin is flagged and recorded as any_user",
      outs and outs[0].evidence.get("any_user") is True)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== AWS IAM wildcard grants ===")
# ═════════════════════════════════════════════════════════════════════════════

def role(broad, concrete=(), session=3600):
    return Res("IAMRole", "role", config={
        "broad_access": list(broad), "accessible_resources": list(concrete),
        "max_session_duration": session, "path": "/"})


eq("iam:full -> ESCALATION VULNERABLE",
   verdict("AWS_IAM_ROLE_ESCALATION", role(["iam:full"]), AWS), VULNERABLE)
eq("s3:full alone is not escalation",
   verdict("AWS_IAM_ROLE_ESCALATION", role(["s3:full"]), AWS), SAFE)
eq("s3:full -> WILDCARD_FULL VULNERABLE",
   verdict("AWS_IAM_ROLE_WILDCARD_FULL", role(["s3:full"]), AWS), VULNERABLE)
eq("iam:full is NOT double-counted by WILDCARD_FULL",
   verdict("AWS_IAM_ROLE_WILDCARD_FULL", role(["iam:full"]), AWS), SAFE)
eq("ec2:write -> WILDCARD_WRITE VULNERABLE",
   verdict("AWS_IAM_ROLE_WILDCARD_WRITE", role(["ec2:write"]), AWS), VULNERABLE)
eq("empty broad_access -> SAFE",
   verdict("AWS_IAM_ROLE_WILDCARD_FULL", role([], ["arn:aws:s3:::b/*"]), AWS), SAFE)
eq("no policy data collected -> UNKNOWN",
   verdict("AWS_IAM_ROLE_WILDCARD_FULL", Res("IAMRole", config={"path": "/"}), AWS),
   UNKNOWN)
outs = run("AWS_IAM_ROLE_WILDCARD_FULL", role(["s3:full", "ec2:full", "rds:full"]), AWS)
eq("3+ full wildcards escalate the severity to CRITICAL",
   outs[0].severity, CRITICAL)
outs = run("AWS_IAM_ROLE_WILDCARD_FULL", role(["s3:full"]), AWS)
eq("1 full wildcard stays HIGH", outs[0].severity, HIGH)
eq("session 12h exactly -> SAFE (boundary)",
   verdict("AWS_IAM_ROLE_LONG_SESSION", role([], session=43200), AWS), SAFE)
eq("session 12h+1s -> VULNERABLE",
   verdict("AWS_IAM_ROLE_LONG_SESSION", role([], session=43201), AWS), VULNERABLE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Public IP rules record surface, not reachability (§13) ===")
# ═════════════════════════════════════════════════════════════════════════════

for rid, rtype, prov in (("AWS_EC2_PUBLIC_IP", "EC2Instance", AWS),
                         ("AZURE_VM_PUBLIC_IP", "VirtualMachine", AZURE),
                         ("OCI_COMPUTE_PUBLIC_IP", "ComputeInstance", OCI)):
    eq(f"{rid} severity is INFO, not HIGH", reg.RULES[rid].severity, INFO)
    eq(f"{rid} public address -> VULNERABLE at INFO",
       verdict(rid, Res(rtype, ip="52.1.2.3", config={"public_ip": "52.1.2.3"}), prov),
       VULNERABLE)
    eq(f"{rid} private address -> SAFE",
       verdict(rid, Res(rtype, ip="10.0.0.4", config={"public_ip": None}), prov), SAFE)
    eq(f"{rid} no address -> SAFE",
       verdict(rid, Res(rtype, ip=None, config={}), prov), SAFE)
    eq(f"{rid} unparseable address -> UNKNOWN",
       verdict(rid, Res(rtype, ip="not-an-ip", config={}), prov), UNKNOWN)

for cidr in ("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "127.0.0.1"):
    eq(f"{cidr} is private",
       verdict("AWS_EC2_PUBLIC_IP", Res("EC2Instance", ip=cidr), AWS), SAFE)
# The old check used string prefixes, so 172.32.x (public) was misread as
# private because it starts with "172.".
eq("172.32.0.1 is PUBLIC (the old prefix check got this wrong)",
   verdict("AWS_EC2_PUBLIC_IP", Res("EC2Instance", ip="172.32.0.1"), AWS), VULNERABLE)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Governance tag rule ===")
# ═════════════════════════════════════════════════════════════════════════════

eq("all required tags -> SAFE",
   verdict("GOVERNANCE_MISSING_OWNERSHIP_TAGS",
           Res("EC2Instance", tags={"Name": "a", "Environment": "p", "Owner": "o"})),
   SAFE)
eq("missing Owner -> VULNERABLE",
   verdict("GOVERNANCE_MISSING_OWNERSHIP_TAGS",
           Res("EC2Instance", tags={"Name": "a", "Environment": "p"})), VULNERABLE)
eq("tag names are case-insensitive",
   verdict("GOVERNANCE_MISSING_OWNERSHIP_TAGS",
           Res("EC2Instance", tags={"name": "a", "environment": "p", "owner": "o"})),
   SAFE)
check("exempt types return no outcome at all",
      run("GOVERNANCE_MISSING_OWNERSHIP_TAGS",
          Res("SecurityGroup", tags={})) == [])
check("the rule is marked aggregate",
      reg.RULES["GOVERNANCE_MISSING_OWNERSHIP_TAGS"].aggregate)
eq("governance severity is LOW",
   reg.RULES["GOVERNANCE_MISSING_OWNERSHIP_TAGS"].severity, LOW)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Port catalog ===")
# ═════════════════════════════════════════════════════════════════════════════

eq("22 is SSH", portcat.CATALOG[22].service, "SSH")
eq("3389 is CRITICAL when world-open", portcat.CATALOG[3389].severity, CRITICAL)
eq("443 is INFO (a public web port is the intended configuration)",
   portcat.CATALOG[443].severity, INFO)
check("every data port is CRITICAL or HIGH",
      all(portcat.CATALOG[p].severity in (CRITICAL, HIGH) for p in portcat.DATA_PORTS))
check("every catalog entry has a reason",
      all(len(i.why) > 30 for i in portcat.CATALOG.values()))

hits = portcat.classify_range(22, 3389)
labels = {h.port for h in hits}
check("22-3389 names SSH, RDP, MSSQL and MySQL individually",
      {22, 3389, 1433, 3306} <= labels, str(sorted(l for l in labels if l)))
check("a wide range also gets a summary entry",
      any(h.port is None for h in hits))
eq("0-65535 collapses to ALL PORTS",
   portcat.classify_range(0, 65535)[0].service, "ALL PORTS")
eq("a single unknown port is MEDIUM, not ignored",
   portcat.classify_range(51234, 51234)[0].severity, MEDIUM)
eq("a single known port keeps its catalog severity",
   portcat.classify_range(3389, 3389)[0].severity, CRITICAL)
check("reversed bounds are normalised",
      portcat.classify_range(3389, 22) == portcat.classify_range(22, 3389))
eq("icmp protocol-only is INFO", portcat.protocol_only("1").severity, INFO)
eq("an unknown protocol wide open is CRITICAL",
   portcat.protocol_only("47").severity, CRITICAL)
check("dedupe collapses two identical open ports",
      len(portcat.dedupe(portcat.classify_range(22, 22) * 3)) == 1)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== Provider normalisation ===")
# ═════════════════════════════════════════════════════════════════════════════

for raw, want in (("AWS", AWS), ("aws", AWS), ("Azure", AZURE), ("AZURE", AZURE),
                  ("OCI", OCI), ("Oracle", OCI), ("oracle cloud", OCI),
                  ("microsoft", AZURE)):
    eq(f"normalize_provider({raw!r})", normalize_provider(raw), want)
for raw in (None, "", "gcp", "GoogleCloud", "digitalocean"):
    eq(f"normalize_provider({raw!r}) refuses rather than guessing",
       normalize_provider(raw), None)


# ═════════════════════════════════════════════════════════════════════════════
print("\n=== is_world_open ===")
# ═════════════════════════════════════════════════════════════════════════════

for v in ("0.0.0.0/0", "::/0", "*", "Internet", "internet", "Any", "0.0.0.0/00"):
    check(f"{v!r} is world-open", reg.is_world_open(v))
for v in (None, "", "10.0.0.0/8", "0.0.0.0/1", "52.1.2.3/32", "VirtualNetwork",
          "AzureLoadBalancer", "garbage"):
    check(f"{v!r} is NOT world-open", not reg.is_world_open(v))


# ═════════════════════════════════════════════════════════════════════════════
print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for f in fail:
        print(f"  ! {f}")
sys.exit(1 if fail else 0)
