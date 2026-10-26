"""Which cloud SERVICE a resource belongs to — Lambda, S3, App Service, OKE…

Category (Compute, Storage…) answers "what kind of thing is this"; resource
type answers "which exact object". Neither answers the question people ask a
console: "show me everything in DynamoDB" or "everything App Service owns".
An App Service app, its plan, its slots and its certificates are four resource
types in two categories, but one service.

The service is the provider's own product, named the way the provider names
it, and keyed `<provider>.<slug>` so two clouds can never collide ("aws.vpc"
and "oci.vcn" are different services even when they do the same job).

How it is decided, per provider:

* **Azure** — from the ARM resource provider namespace in the resource ID
  (`/providers/Microsoft.Web/sites/…` → App Service). The namespace is Azure's
  own grouping and it is in every ID, so an ARM type this product has never
  seen still lands in the right service. Where one namespace holds several
  products (Microsoft.Insights holds alerts, Application Insights and
  autoscale) the first type segment refines it.
* **AWS / OCI** — from the resource type the collector stored, which is
  already product-specific (LambdaFunction, ObjectStorageBucket).

A resource no rule matches is never filed under a catch-all "Other": it gets a
service named after its own type, so the filter still separates it from
everything else and says plainly what it is. That fallback is marked
`known=False` so the UI can tell a classified service from a derived one.

Pure: no I/O. Persisted into `cloud_resources.service` by resource_normalizer.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

AWS, AZURE, OCI = "AWS", "AZURE", "OCI"

# key -> (provider, label)
SERVICES: Dict[str, Tuple[str, str]] = {
    # ── AWS ─────────────────────────────────────────────────────────────────
    "aws.ec2": (AWS, "Amazon EC2"),
    "aws.ebs": (AWS, "Amazon EBS"),
    "aws.vpc": (AWS, "Amazon VPC"),
    "aws.elb": (AWS, "Elastic Load Balancing"),
    "aws.cloudfront": (AWS, "Amazon CloudFront"),
    "aws.apigateway": (AWS, "Amazon API Gateway"),
    "aws.route53": (AWS, "Amazon Route 53"),
    "aws.s3": (AWS, "Amazon S3"),
    "aws.efs": (AWS, "Amazon EFS"),
    "aws.lambda": (AWS, "AWS Lambda"),
    "aws.dynamodb": (AWS, "Amazon DynamoDB"),
    "aws.rds": (AWS, "Amazon RDS"),
    "aws.docdb": (AWS, "Amazon DocumentDB"),
    "aws.neptune": (AWS, "Amazon Neptune"),
    "aws.redshift": (AWS, "Amazon Redshift"),
    "aws.elasticache": (AWS, "Amazon ElastiCache"),
    "aws.iam": (AWS, "AWS IAM"),
    "aws.kms": (AWS, "AWS KMS"),
    "aws.acm": (AWS, "AWS Certificate Manager"),
    "aws.secretsmanager": (AWS, "AWS Secrets Manager"),
    "aws.waf": (AWS, "AWS WAF"),
    "aws.eks": (AWS, "Amazon EKS"),
    "aws.ecs": (AWS, "Amazon ECS"),
    "aws.ecr": (AWS, "Amazon ECR"),
    "aws.autoscaling": (AWS, "EC2 Auto Scaling"),
    "aws.sqs": (AWS, "Amazon SQS"),
    "aws.sns": (AWS, "Amazon SNS"),
    "aws.kinesis": (AWS, "Amazon Kinesis"),
    "aws.cloudwatch": (AWS, "Amazon CloudWatch"),
    "aws.bedrock": (AWS, "Amazon Bedrock"),
    "aws.sagemaker": (AWS, "Amazon SageMaker"),

    # ── Azure ───────────────────────────────────────────────────────────────
    "azure.virtual-machines": (AZURE, "Virtual Machines"),
    "azure.vm-scale-sets": (AZURE, "Virtual Machine Scale Sets"),
    "azure.disks": (AZURE, "Managed Disks"),
    "azure.app-service": (AZURE, "App Service"),
    "azure.functions": (AZURE, "Azure Functions"),
    "azure.logic-apps": (AZURE, "Logic Apps"),
    "azure.storage": (AZURE, "Storage Accounts"),
    "azure.virtual-network": (AZURE, "Virtual Network"),
    "azure.load-balancer": (AZURE, "Load Balancer"),
    "azure.application-gateway": (AZURE, "Application Gateway"),
    "azure.front-door": (AZURE, "Front Door & WAF"),
    "azure.dns": (AZURE, "Azure DNS"),
    "azure.network-watcher": (AZURE, "Network Watcher"),
    "azure.sql": (AZURE, "Azure SQL"),
    "azure.postgresql": (AZURE, "Azure Database for PostgreSQL"),
    "azure.mysql": (AZURE, "Azure Database for MySQL"),
    "azure.cosmos-db": (AZURE, "Azure Cosmos DB"),
    "azure.redis": (AZURE, "Azure Cache for Redis"),
    "azure.key-vault": (AZURE, "Key Vault"),
    "azure.managed-identity": (AZURE, "Managed Identities"),
    "azure.monitor-alerts": (AZURE, "Azure Monitor alerts"),
    "azure.app-insights": (AZURE, "Application Insights"),
    "azure.log-analytics": (AZURE, "Log Analytics"),
    "azure.monitor": (AZURE, "Azure Monitor"),
    "azure.autoscale": (AZURE, "Autoscale"),
    "azure.backup": (AZURE, "Backup & Recovery"),
    "azure.aks": (AZURE, "Azure Kubernetes Service"),
    "azure.container-registry": (AZURE, "Container Registry"),
    "azure.container-instances": (AZURE, "Container Instances"),
    "azure.ai-services": (AZURE, "Azure AI services"),
    "azure.bot-service": (AZURE, "Azure Bot Service"),
    "azure.service-bus": (AZURE, "Service Bus"),
    "azure.event-hubs": (AZURE, "Event Hubs"),
    "azure.event-grid": (AZURE, "Event Grid"),
    "azure.data-factory": (AZURE, "Data Factory"),
    "azure.portal-dashboards": (AZURE, "Dashboards"),
    "azure.devtest-labs": (AZURE, "DevTest Labs"),
    "azure.devops": (AZURE, "Azure DevOps"),
    "azure.resource-mover": (AZURE, "Resource Mover"),
    "azure.saas": (AZURE, "SaaS subscriptions"),

    # ── OCI ─────────────────────────────────────────────────────────────────
    "oci.compute": (OCI, "Compute"),
    "oci.block-volume": (OCI, "Block Volume"),
    "oci.object-storage": (OCI, "Object Storage"),
    "oci.file-storage": (OCI, "File Storage"),
    "oci.networking": (OCI, "Networking (VCN)"),
    "oci.load-balancer": (OCI, "Load Balancer"),
    "oci.fastconnect": (OCI, "FastConnect & DRG"),
    "oci.waf": (OCI, "Web Application Firewall"),
    "oci.base-database": (OCI, "Base Database (DB Systems)"),
    "oci.autonomous-database": (OCI, "Autonomous Database"),
    "oci.mysql": (OCI, "MySQL HeatWave"),
    "oci.nosql": (OCI, "NoSQL Database"),
    "oci.iam": (OCI, "Identity & Access"),
    "oci.vault": (OCI, "Vault"),
    "oci.certificates": (OCI, "Certificates"),
    "oci.functions": (OCI, "Functions"),
    "oci.oke": (OCI, "Kubernetes Engine (OKE)"),
    "oci.container-instances": (OCI, "Container Instances"),
    "oci.analytics": (OCI, "Analytics Cloud"),
    "oci.streaming": (OCI, "Streaming"),
    "oci.notifications": (OCI, "Notifications"),
    "oci.monitoring": (OCI, "Monitoring"),
}

# ── AWS / OCI: by stored resource type ──────────────────────────────────────
_AWS_TYPES: Dict[str, str] = {
    "EC2Instance": "aws.ec2", "ElasticIP": "aws.ec2", "NetworkInterface": "aws.ec2",
    "EBSVolume": "aws.ebs", "EBSSnapshot": "aws.ebs", "Snapshot": "aws.ebs",
    "VPC": "aws.vpc", "Subnet": "aws.vpc", "SecurityGroup": "aws.vpc",
    "RouteTable": "aws.vpc", "InternetGateway": "aws.vpc", "NatGateway": "aws.vpc",
    "DhcpOptions": "aws.vpc", "PrivateEndpoint": "aws.vpc",
    "LoadBalancer": "aws.elb", "NetworkLoadBalancer": "aws.elb",
    "CloudFront": "aws.cloudfront", "APIGateway": "aws.apigateway",
    "DnsZone": "aws.route53",
    "S3Bucket": "aws.s3", "EFSFileSystem": "aws.efs", "FileSystem": "aws.efs",
    "LambdaFunction": "aws.lambda",
    "DynamoDBTable": "aws.dynamodb",
    "RDSInstance": "aws.rds", "AuroraCluster": "aws.rds",
    "DocumentDBCluster": "aws.docdb", "NeptuneCluster": "aws.neptune",
    "RedshiftCluster": "aws.redshift",
    "ElastiCacheRedis": "aws.elasticache", "ElastiCacheMemcached": "aws.elasticache",
    "IAMRole": "aws.iam", "IAMUser": "aws.iam", "IAMGroup": "aws.iam",
    "IAMPolicy": "aws.iam",
    "KMSKey": "aws.kms", "Certificate": "aws.acm", "Certificates": "aws.acm",
    "Secret": "aws.secretsmanager", "WAF": "aws.waf", "WebAppFirewall": "aws.waf",
    "EKSCluster": "aws.eks", "ECSCluster": "aws.ecs", "ContainerRegistry": "aws.ecr",
    "AutoScalingGroup": "aws.autoscaling",
    "SQSQueue": "aws.sqs", "SNSTopic": "aws.sns", "KinesisStream": "aws.kinesis",
    "CloudWatchAlarm": "aws.cloudwatch", "Alarm": "aws.cloudwatch",
    "BedrockModel": "aws.bedrock", "BedrockAgent": "aws.bedrock",
    "BedrockKnowledgeBase": "aws.bedrock", "SageMakerEndpoint": "aws.sagemaker",
}

_OCI_TYPES: Dict[str, str] = {
    "ComputeInstance": "oci.compute", "InstancePool": "oci.compute",
    "Vnic": "oci.compute",
    "BlockVolume": "oci.block-volume", "BootVolume": "oci.block-volume",
    "VolumeBackup": "oci.block-volume", "BootVolumeBackup": "oci.block-volume",
    "VolumeGroup": "oci.block-volume",
    "ObjectStorageBucket": "oci.object-storage", "Bucket": "oci.object-storage",
    "FileSystem": "oci.file-storage", "MountTarget": "oci.file-storage",
    "VCN": "oci.networking", "Subnet": "oci.networking", "RouteTable": "oci.networking",
    "SecurityList": "oci.networking", "NetworkSecurityGroup": "oci.networking",
    "DhcpOptions": "oci.networking", "InternetGateway": "oci.networking",
    "NatGateway": "oci.networking", "ServiceGateway": "oci.networking",
    "LocalPeeringGateway": "oci.networking", "PublicIP": "oci.networking",
    "LoadBalancer": "oci.load-balancer", "NetworkLoadBalancer": "oci.load-balancer",
    "Drg": "oci.fastconnect", "DrgAttachment": "oci.fastconnect",
    "VirtualCircuit": "oci.fastconnect",
    "WebAppFirewall": "oci.waf", "WAF": "oci.waf",
    "DbSystem": "oci.base-database", "Database": "oci.base-database",
    "AutonomousDatabase": "oci.autonomous-database",
    "MySQLDbSystem": "oci.mysql", "NoSQLTable": "oci.nosql",
    "IAMGroup": "oci.iam", "IAMPolicy": "oci.iam", "IAMUser": "oci.iam",
    "DynamicGroup": "oci.iam", "Compartment": "oci.iam",
    "Vault": "oci.vault", "KMSKey": "oci.vault", "Secret": "oci.vault",
    "Certificate": "oci.certificates", "Certificates": "oci.certificates",
    "Function": "oci.functions", "OCIFunction": "oci.functions",
    "FunctionApplication": "oci.functions",
    "OKECluster": "oci.oke", "ContainerInstance": "oci.container-instances",
    "AnalyticsInstance": "oci.analytics", "Stream": "oci.streaming",
    "NotificationTopic": "oci.notifications", "Alarm": "oci.monitoring",
}

# ── Azure: by ARM namespace, refined by the first type segment ──────────────
_AZURE_NAMESPACE_TYPE: Dict[Tuple[str, str], str] = {
    ("microsoft.compute", "virtualmachinescalesets"): "azure.vm-scale-sets",
    ("microsoft.compute", "disks"): "azure.disks",
    ("microsoft.compute", "snapshots"): "azure.disks",
    ("microsoft.compute", "diskaccesses"): "azure.disks",
    ("microsoft.compute", "diskencryptionsets"): "azure.disks",
    ("microsoft.web", "connections"): "azure.logic-apps",
    ("microsoft.network", "loadbalancers"): "azure.load-balancer",
    ("microsoft.network", "applicationgateways"): "azure.application-gateway",
    ("microsoft.network", "applicationgatewaywebapplicationfirewallpolicies"):
        "azure.application-gateway",
    ("microsoft.network", "frontdoors"): "azure.front-door",
    ("microsoft.network", "frontdoorwebapplicationfirewallpolicies"): "azure.front-door",
    ("microsoft.network", "dnszones"): "azure.dns",
    ("microsoft.network", "privatednszones"): "azure.dns",
    ("microsoft.network", "networkwatchers"): "azure.network-watcher",
    ("microsoft.insights", "components"): "azure.app-insights",
    ("microsoft.insights", "autoscalesettings"): "azure.autoscale",
    ("microsoft.insights", "metricalerts"): "azure.monitor-alerts",
    ("microsoft.insights", "activitylogalerts"): "azure.monitor-alerts",
    ("microsoft.insights", "scheduledqueryrules"): "azure.monitor-alerts",
    ("microsoft.insights", "actiongroups"): "azure.monitor-alerts",
    ("microsoft.documentdb", "mongoclusters"): "azure.cosmos-db",
}

_AZURE_NAMESPACE: Dict[str, str] = {
    "microsoft.compute": "azure.virtual-machines",
    "microsoft.web": "azure.app-service",
    "microsoft.logic": "azure.logic-apps",
    "microsoft.storage": "azure.storage",
    "microsoft.network": "azure.virtual-network",
    "microsoft.sql": "azure.sql",
    "microsoft.dbforpostgresql": "azure.postgresql",
    "microsoft.dbformysql": "azure.mysql",
    "microsoft.documentdb": "azure.cosmos-db",
    "microsoft.cache": "azure.redis",
    "microsoft.keyvault": "azure.key-vault",
    "microsoft.managedidentity": "azure.managed-identity",
    "microsoft.alertsmanagement": "azure.monitor-alerts",
    "microsoft.insights": "azure.monitor",
    "microsoft.operationalinsights": "azure.log-analytics",
    "microsoft.operationsmanagement": "azure.log-analytics",
    "microsoft.recoveryservices": "azure.backup",
    "microsoft.dataprotection": "azure.backup",
    "microsoft.containerservice": "azure.aks",
    "microsoft.containerregistry": "azure.container-registry",
    "microsoft.containerinstance": "azure.container-instances",
    "microsoft.cognitiveservices": "azure.ai-services",
    "microsoft.botservice": "azure.bot-service",
    "microsoft.servicebus": "azure.service-bus",
    "microsoft.eventhub": "azure.event-hubs",
    "microsoft.eventgrid": "azure.event-grid",
    "microsoft.datafactory": "azure.data-factory",
    "microsoft.portal": "azure.portal-dashboards",
    "microsoft.dashboard": "azure.portal-dashboards",
    "microsoft.devtestlab": "azure.devtest-labs",
    "microsoft.visualstudio": "azure.devops",
    "microsoft.migrate": "azure.resource-mover",
    "microsoft.saas": "azure.saas",
}

# Azure function apps live under Microsoft.Web/sites with kind "functionapp";
# the collector stores them as FunctionApp, which is the only signal we have.
_AZURE_TYPES: Dict[str, str] = {
    "FunctionApp": "azure.functions",
    "LogicApp": "azure.logic-apps",
}

_ARM_PROVIDER = re.compile(r"/providers/([^/]+)/([^/]+)", re.IGNORECASE)


@dataclass(frozen=True)
class ServiceInfo:
    key: str
    label: str
    provider: str
    known: bool


def _infer_provider(resource_id: str) -> Optional[str]:
    rid = (resource_id or "").strip().lower()
    if rid.startswith("/subscriptions/"):
        return AZURE
    if rid.startswith("ocid1."):
        return OCI
    if rid.startswith("arn:aws"):
        return AWS
    return None


def _humanize(rtype: str) -> str:
    out: List[str] = []
    for i, ch in enumerate(rtype):
        if i and ch.isupper() and (rtype[i - 1].islower()
                                   or (i + 1 < len(rtype) and rtype[i + 1].islower())):
            out.append(" ")
        out.append(ch)
    return "".join(out).strip() or "Unknown"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "unknown"


def service_of(resource_type: Optional[str], resource_id: Optional[str] = None,
               provider: Optional[str] = None) -> ServiceInfo:
    """The service one resource belongs to. Never raises, never returns None."""
    rtype = (resource_type or "").strip() or "Unknown"
    prov = (provider or "").upper() or _infer_provider(resource_id or "")
    if prov is None:
        # Types that only one collector emits identify their cloud on their own.
        in_aws, in_oci = rtype in _AWS_TYPES, rtype in _OCI_TYPES
        prov = AWS if in_aws and not in_oci else OCI if in_oci and not in_aws else None

    key: Optional[str] = None
    if prov == AZURE:
        key = _AZURE_TYPES.get(rtype)
        match = _ARM_PROVIDER.search(resource_id or "")
        if key is None and match:
            ns, first = match.group(1).lower(), match.group(2).lower()
            key = _AZURE_NAMESPACE_TYPE.get((ns, first)) or _AZURE_NAMESPACE.get(ns)
            if key is None:
                # A namespace nobody has classified: name it after Azure's own
                # namespace, which is what the portal groups it under.
                label = match.group(1).split(".", 1)[-1]
                return ServiceInfo(f"azure.ns-{_slug(label)}", label, AZURE, False)
    elif prov == AWS:
        key = _AWS_TYPES.get(rtype)
    elif prov == OCI:
        key = _OCI_TYPES.get(rtype)

    if key:
        return ServiceInfo(key, SERVICES[key][1], SERVICES[key][0], True)
    label = _humanize(rtype)
    return ServiceInfo(f"{(prov or 'other').lower()}.type-{_slug(rtype)}", label,
                       prov or "", False)


def label_of(key: Optional[str]) -> Optional[str]:
    """A stored service key's label; derived keys fall back to their slug."""
    if not key:
        return None
    if key in SERVICES:
        return SERVICES[key][1]
    slug = key.split(".", 1)[-1]
    for prefix in ("type-", "ns-"):
        if slug.startswith(prefix):
            slug = slug[len(prefix):]
    return slug.replace("-", " ").title()


def provider_of(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    if key in SERVICES:
        return SERVICES[key][0]
    head = key.split(".", 1)[0].upper()
    return head if head in (AWS, AZURE, OCI) else None


def catalog() -> List[Dict[str, str]]:
    """The known services, for the reference endpoint."""
    return [{"value": k, "label": label, "provider": prov}
            for k, (prov, label) in sorted(SERVICES.items(), key=lambda kv: (kv[1][0], kv[1][1]))]
