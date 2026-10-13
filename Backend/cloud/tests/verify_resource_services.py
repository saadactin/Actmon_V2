"""Which cloud service a resource belongs to — pure, no DB.

Pins the properties that make the Resources "Service" filter trustworthy:

* **Each cloud's own products, never mixed.** A bare "Subnet" is AWS VPC,
  Azure Virtual Network or OCI Networking depending on the account; keys are
  provider-prefixed so the three can never merge into one filter value.
* **Azure is read from the ARM namespace in the id**, so an ARM type the
  collector has never seen still lands in the right service, and one namespace
  holding several products (Microsoft.Insights) is split by its type segment.
* **Nothing falls into a catch-all.** An unclassified type gets a service
  named after itself, marked known=False.
* **Every type the collectors emit today is classified** (the live estate's
  types, listed below), so the fallback is a safety net, not the normal path.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.services import resource_services as s  # noqa: E402

ok, fail = [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def eq(label, got, want):
    check(label, got == want, f"got {got!r}, want {want!r}")


def arm(ns, typ, name="x"):
    return f"/subscriptions/0000/resourceGroups/rg/providers/{ns}/{typ}/{name}"


print("1. AWS: the services people ask for by name")
eq("LambdaFunction -> AWS Lambda", s.service_of("LambdaFunction", None, "AWS").label, "AWS Lambda")
eq("S3Bucket -> Amazon S3", s.service_of("S3Bucket", "my-bucket", "AWS").key, "aws.s3")
eq("DynamoDBTable -> Amazon DynamoDB", s.service_of("DynamoDBTable", None, "AWS").key,
   "aws.dynamodb")
eq("Subnet, SecurityGroup and VPC are all Amazon VPC",
   {s.service_of(t, None, "AWS").key for t in ("Subnet", "SecurityGroup", "VPC")}, {"aws.vpc"})
eq("EBS volumes are their own service, not EC2",
   s.service_of("EBSVolume", "vol-1", "AWS").key, "aws.ebs")

print("\n2. The same type name in three clouds is three services")
keys = {p: s.service_of("Subnet", None, p).key for p in ("AWS", "AZURE", "OCI")}
eq("AWS Subnet", keys["AWS"], "aws.vpc")
eq("OCI Subnet", keys["OCI"], "oci.networking")
azure_subnet = s.service_of("Subnet", arm("Microsoft.Network", "virtualNetworks", "v/subnets/a"),
                            "AZURE")
eq("Azure Subnet (from its ARM id)", azure_subnet.key, "azure.virtual-network")
eq("LoadBalancer: AWS ELB vs OCI Load Balancer",
   (s.service_of("LoadBalancer", None, "AWS").key, s.service_of("LoadBalancer", None, "OCI").key),
   ("aws.elb", "oci.load-balancer"))

print("\n3. Azure: by ARM namespace, refined by type")
eq("Microsoft.Web/sites -> App Service",
   s.service_of("AppService", arm("Microsoft.Web", "sites"), "AZURE").key, "azure.app-service")
eq("...and its plan, slots and certificates are App Service too",
   {s.service_of(t, arm("Microsoft.Web", seg), "AZURE").key
    for t, seg in (("AppServicePlan", "serverfarms"), ("Slots", "sites"),
                   ("Certificates", "certificates"))}, {"azure.app-service"})
eq("Microsoft.Web/connections is Logic Apps, not App Service",
   s.service_of("Connections", arm("Microsoft.Web", "connections"), "AZURE").key,
   "azure.logic-apps")
eq("Microsoft.Insights/components -> Application Insights",
   s.service_of("AppInsights", arm("microsoft.insights", "components"), "AZURE").key,
   "azure.app-insights")
eq("Microsoft.Insights/metricalerts -> Azure Monitor alerts",
   s.service_of("Metricalerts", arm("microsoft.insights", "metricalerts"), "AZURE").key,
   "azure.monitor-alerts")
eq("Managed disks are not Virtual Machines",
   s.service_of("ManagedDisk", arm("Microsoft.Compute", "disks"), "AZURE").key, "azure.disks")
eq("a VM extension belongs to Virtual Machines",
   s.service_of("Extensions", arm("Microsoft.Compute", "virtualMachines", "vm/extensions/e"),
                "AZURE").key, "azure.virtual-machines")
new = s.service_of("Widgets", arm("Microsoft.BrandNew", "widgets"), "AZURE")
eq("an unseen namespace is named after Azure's own namespace", new.label, "BrandNew")
check("...and marked as derived", new.known is False)
eq("a type the collector stores as FunctionApp is Azure Functions",
   s.service_of("FunctionApp", arm("Microsoft.Web", "sites"), "AZURE").key, "azure.functions")

print("\n4. OCI")
eq("Block and boot volumes are Block Volume",
   {s.service_of(t, None, "OCI").key for t in ("BlockVolume", "BootVolume")},
   {"oci.block-volume"})
eq("ObjectStorageBucket -> Object Storage",
   s.service_of("ObjectStorageBucket", "ns/b", "OCI").label, "Object Storage")
eq("DbSystem -> Base Database", s.service_of("DbSystem", None, "OCI").key, "oci.base-database")

print("\n5. Nothing is a catch-all")
u = s.service_of("QuantumThing", None, "AWS")
check("an unknown AWS type gets its own service, not 'Other'",
      u.key == "aws.type-quantumthing" and u.label == "Quantum Thing", f"{u.key} {u.label}")
check("...marked derived", u.known is False)
eq("a derived key still yields a label", s.label_of("aws.type-quantumthing"), "Quantumthing")
eq("...and its cloud", s.provider_of("aws.type-quantumthing"), "AWS")
eq("an empty type never raises", s.service_of(None, None, None).key, "other.type-unknown")

print("\n6. Provider inference when the account is not passed")
eq("ARM id -> Azure", s.service_of("Thing", arm("Microsoft.Storage", "storageAccounts")).key,
   "azure.storage")
eq("OCID -> OCI", s.service_of("Subnet", "ocid1.subnet.oc1..x").key, "oci.networking")
eq("a type only one cloud emits identifies it", s.service_of("LambdaFunction", "f").key,
   "aws.lambda")

print("\n7. Every type in the live estate (2026-10-06) is classified")
LIVE = {
    "AWS": ["APIGateway", "DynamoDBTable", "EBSVolume", "EC2Instance", "IAMRole",
            "LambdaFunction", "S3Bucket", "SecurityGroup", "Subnet", "VPC"],
    "OCI": ["AnalyticsInstance", "AutonomousDatabase", "BlockVolume", "BootVolume",
            "ComputeInstance", "DbSystem", "DhcpOptions", "DrgAttachment", "FileSystem",
            "Function", "IAMGroup", "IAMPolicy", "LoadBalancer", "NetworkSecurityGroup",
            "ObjectStorageBucket", "RouteTable", "SecurityList", "Subnet", "VCN",
            "VirtualCircuit", "WebAppFirewall"],
}
unknown = [f"{p}:{t}" for p, ts in LIVE.items() for t in ts if not s.service_of(t, None, p).known]
eq("no AWS/OCI type falls back", unknown, [])
AZURE_LIVE = [
    ("microsoft.web", "sites"), ("microsoft.web", "serverfarms"), ("microsoft.web", "certificates"),
    ("microsoft.web", "connections"), ("microsoft.compute", "virtualmachines"),
    ("microsoft.compute", "disks"), ("microsoft.compute", "diskaccesses"),
    ("microsoft.compute", "restorepointcollections"), ("microsoft.storage", "storageaccounts"),
    ("microsoft.network", "virtualnetworks"), ("microsoft.network", "networkinterfaces"),
    ("microsoft.network", "publicipaddresses"), ("microsoft.network", "natgateways"),
    ("microsoft.network", "privatednszones"), ("microsoft.network", "networkwatchers"),
    ("microsoft.network", "frontdoorwebapplicationfirewallpolicies"),
    ("microsoft.sql", "servers"), ("microsoft.dbforpostgresql", "flexibleservers"),
    ("microsoft.documentdb", "mongoclusters"), ("microsoft.cache", "redis"),
    ("microsoft.insights", "metricalerts"), ("microsoft.insights", "components"),
    ("microsoft.insights", "workbooks"), ("microsoft.alertsmanagement", "smartdetectoralertrules"),
    ("microsoft.operationalinsights", "workspaces"), ("microsoft.recoveryservices", "vaults"),
    ("microsoft.dataprotection", "backupvaults"), ("microsoft.managedidentity",
                                                   "userassignedidentities"),
    ("microsoft.cognitiveservices", "accounts"), ("microsoft.botservice", "botservices"),
    ("microsoft.portal", "dashboards"), ("microsoft.devtestlab", "schedules"),
    ("microsoft.visualstudio", "account"), ("microsoft.migrate", "movecollections"),
    ("microsoft.saas", "resources"), ("microsoft.operationsmanagement", "solutions"),
]
unknown = [f"{ns}/{t}" for ns, t in AZURE_LIVE
           if not s.service_of("X", arm(ns, t), "AZURE").known]
eq("no live Azure namespace falls back", unknown, [])

print("\n8. Catalogue hygiene")
check("every key is prefixed by its own cloud",
      all(k.split(".", 1)[0].upper() == p for k, (p, _) in s.SERVICES.items()))
for table, prov in ((s._AWS_TYPES, "AWS"), (s._OCI_TYPES, "OCI")):
    bad = [t for t, k in table.items() if k not in s.SERVICES or s.SERVICES[k][0] != prov]
    eq(f"every {prov} type maps to a declared {prov} service", bad, [])
bad = [ns for ns, k in s._AZURE_NAMESPACE.items() if k not in s.SERVICES]
bad += [str(k) for k, v in s._AZURE_NAMESPACE_TYPE.items() if v not in s.SERVICES]
eq("every Azure mapping points at a declared service", bad, [])
labels = [(p, label) for p, label in s.SERVICES.values()]
eq("no two services in one cloud share a label", len(labels), len(set(labels)))
check("the catalogue lists every service once", len(s.catalog()) == len(s.SERVICES))

print(f"\n{len(ok)} passed, {len(fail)} failed")
if fail:
    print("\nFAILURES:")
    for x in fail:
        print(f"  ! {x}")
sys.exit(1 if fail else 0)
