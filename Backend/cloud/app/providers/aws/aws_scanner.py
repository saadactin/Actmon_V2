"""AWS resource scanner — discovers EC2, RDS, S3, Lambda, EKS, ELB."""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from app.providers.aws.aws_auth import AWSAuth
from app.providers.aws.iam_policy import summarize_policy_documents
from app.providers.scan_pool import scan_pool, is_denial, is_transient

logger = logging.getLogger("cloud_svc.aws.scanner")

# What AWS answers when an operation does not exist in a region at all — Bedrock
# custom models in us-east-2 is "UnknownOperationException", in ap-south-2 a
# "ValidationException: Unknown operation". Nothing can live there, so it is
# neither a failure nor a gap in the inventory, and must not be counted as one.
_NOT_OFFERED_CODES = {"UnknownOperationException", "InvalidAction", "UnsupportedOperation"}
_DENIED_ACTION = re.compile(r"perform: ([a-z0-9-]+:[A-Za-z0-9*]+)")

# The IAM actions each scanner calls, from the calls it makes. A denial is
# reported with the whole set, so the permission can be fixed in one change
# instead of one action per scan.
SCANNER_ACTIONS: Dict[str, Tuple[str, ...]] = {
    "EC2": ("ec2:DescribeInstances",),
    "EBS": ("ec2:DescribeVolumes", "ec2:DescribeInstances"),
    "RDS": ("rds:DescribeDBInstances",),
    "DBCluster": ("rds:DescribeDBClusters",),
    "ElastiCache": ("elasticache:DescribeReplicationGroups", "elasticache:DescribeCacheClusters"),
    "Redshift": ("redshift:DescribeClusters",),
    "Lambda": ("lambda:ListFunctions", "lambda:ListEventSourceMappings", "lambda:ListTags"),
    "EKS": ("eks:ListClusters", "eks:DescribeCluster"),
    "ELB": ("elasticloadbalancing:DescribeLoadBalancers",
            "elasticloadbalancing:DescribeTargetGroups",
            "elasticloadbalancing:DescribeTargetHealth"),
    "DynamoDB": ("dynamodb:ListTables", "dynamodb:DescribeTable"),
    "VPC": ("ec2:DescribeVpcs",),
    "Subnet": ("ec2:DescribeSubnets",),
    "SecurityGroup": ("ec2:DescribeSecurityGroups",),
    "APIGateway": ("apigateway:GET",),
    "Bedrock": ("bedrock:ListCustomModels", "bedrock:ListAgents", "bedrock:ListKnowledgeBases"),
    "S3": ("s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetBucketPublicAccessBlock",
           "s3:GetBucketVersioning", "s3:GetEncryptionConfiguration",
           "s3:GetLifecycleConfiguration"),
    "IAM": ("iam:ListRoles", "iam:ListAttachedRolePolicies", "iam:ListRolePolicies",
            "iam:GetRolePolicy", "iam:GetPolicy", "iam:GetPolicyVersion"),
}


def _aws_error(exc: BaseException) -> Tuple[Optional[str], str]:
    err = (getattr(exc, "response", None) or {}).get("Error") or {}
    return err.get("Code"), str(err.get("Message") or exc)


def is_not_offered(exc: BaseException) -> bool:
    """The operation does not exist in this region (see _NOT_OFFERED_CODES)."""
    code, message = _aws_error(exc)
    if code in _NOT_OFFERED_CODES:
        return True
    return code == "ValidationException" and "unknown operation" in message.lower()


def denied_action(exc: BaseException) -> Optional[str]:
    """The IAM action a denial names ("... not authorized to perform:
    redshift:DescribeClusters ..."), or None."""
    m = _DENIED_ACTION.search(str(exc))
    return m.group(1) if m else None


class AWSScanner:
    # Max scanner calls in flight across the region x service fan-out. Sized to
    # keep the scan thread pool busy without building a backlog behind it.
    _MAX_CONCURRENT_SCANS = 20

    # Retries for dropped connections only (never for denials). Enough to get
    # through the TLS aborts on this network: a DynamoDB ListTables that needed
    # several attempts was otherwise being recorded as "no tables" while the
    # account really had 21.
    _TRANSIENT_ATTEMPTS = 4

    def __init__(self, auth: AWSAuth) -> None:
        self.auth = auth
        # Scopes that failed to enumerate this run. Non-empty means the sweep
        # is INCOMPLETE and must not be pruned against (see BaseCloudProvider).
        self.scan_failures: list[str] = []
        # What happened to every (service, region) scope, for coverage: how
        # much of the account was actually read, and why the rest was not.
        self.scope_summary: Optional[Dict[str, Any]] = None
        self._outcomes: Dict[Tuple[str, str], Tuple[str, Optional[str], bool]] = {}
        self._denied_actions: Dict[str, set] = {}
        self._denied_services: set = set()
        self._denied_ops: set = set()
        self._lock = threading.Lock()

    # ── Scope outcomes ────────────────────────────────────────────────────────
    _RANK = {"read": 0, "not_offered": 1, "failed": 2, "denied": 3}

    def _mark(self, label: str, region: str, outcome: str,
              exc: Optional[BaseException] = None, *, skip_service: bool = True) -> None:
        """Record a scope's outcome. The worst wins: a scope read in part and
        denied in part (Bedrock's three calls) counts as denied, not read.

        `skip_service` — a denial of the scanner's one call means the service
        is denied account-wide, so its other regions are skipped. A denial of
        ONE of several calls (Bedrock's agents) says nothing about the others,
        which is why _subcall passes False and skips per operation instead."""
        with self._lock:
            prev = self._outcomes.get((label, region))
            if prev is None or self._RANK[outcome] > self._RANK[prev[0]]:
                self._outcomes[(label, region)] = (
                    outcome, str(exc)[:160] if exc is not None else None,
                    bool(exc is not None and is_transient(exc)))
            if outcome == "denied":
                if skip_service:
                    self._denied_services.add(label)
                action = denied_action(exc) if exc is not None else None
                if action:
                    self._denied_actions.setdefault(label, set()).add(action)

    def _subcall(self, label: str, region: str, fn, op: str):
        """One of several calls inside a scanner (Bedrock's models, agents and
        knowledge bases). Retries a dropped connection; an operation that does
        not exist in the region is simply absent; a denial or any other error
        is RECORDED rather than swallowed — it used to be logged at debug and
        returned as "no resources", so a denied Bedrock read looked like an
        account with no Bedrock at all.

        A denied operation is denied account-wide, so it is not called again in
        the other regions — but the scanner's OTHER operations still are, and
        what they return is kept."""
        with self._lock:
            already = (label, op) in self._denied_ops
        if already:
            self._mark(label, region, "denied", skip_service=False)
            return None
        for attempt in range(self._TRANSIENT_ATTEMPTS):
            try:
                return fn()
            except Exception as exc:  # noqa: BLE001
                if is_not_offered(exc):
                    return None
                if is_transient(exc) and attempt < self._TRANSIENT_ATTEMPTS - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                refused = is_denial(exc)
                self._mark(label, region, "denied" if refused else "failed", exc,
                           skip_service=False)
                with self._lock:
                    if refused:
                        self._denied_ops.add((label, op))
                    self.scan_failures.append(f"{label} [{region}]: {str(exc)[:160]}")
                return None
        return None

    def _build_scope_summary(self, regions: List[str], labels: List[str]) -> Dict[str, Any]:
        """How much of the account this sweep read, and exactly why the rest
        was not — per service, with the IAM actions a denial needs."""
        total = len(regions) * len(labels) + 2          # + S3 and IAM (global)
        read = 0
        not_offered: Dict[str, List[str]] = {}
        denied: Dict[str, Dict[str, Any]] = {}
        failed: List[Dict[str, Any]] = []
        for (label, region), (outcome, detail, transient) in sorted(self._outcomes.items()):
            if outcome == "read":
                read += 1
            elif outcome == "not_offered":
                not_offered.setdefault(label, []).append(region)
            elif outcome == "denied":
                denied.setdefault(label, {"regions": []})["regions"].append(region)
            else:
                failed.append({"scope": f"{label} [{region}]", "error": detail,
                               "transient": transient})
        for label, entry in denied.items():
            observed = self._denied_actions.get(label, set())
            entry["observed_actions"] = sorted(observed)
            entry["actions"] = sorted(set(SCANNER_ACTIONS.get(label, ())) | observed)
        applicable = total - sum(len(v) for v in not_offered.values())
        return {
            "provider": "AWS",
            "regions": len(regions),
            "services": len(labels) + 2,
            "attempted": applicable,
            "read": read,
            "unread": max(0, applicable - read),
            "not_offered": not_offered,
            "denied": denied,
            "failed": failed[:50],
            # The list is capped for size; these count all of them, so a bad
            # sweep is not reported as "50 did not answer".
            "failed_count": len(failed),
            "failed_transient": sum(1 for f in failed if f["transient"]),
            "missing_permissions": sorted({a for e in denied.values() for a in e["actions"]}),
            # One region scanned because the region list itself failed: the
            # ratio above would describe one region, not the account.
            "regions_unknown": bool(getattr(self, "_region_discovery_error", None)),
        }

    # ── EC2 Instances ─────────────────────────────────────────────────────────
    async def _scan_ec2(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2", region)
            pages = ec2.get_paginator("describe_instances").paginate()
            results = []
            for page in pages:
                for reservation in page.get("Reservations", []):
                    for inst in reservation.get("Instances", []):
                        name = next(
                            (t["Value"] for t in inst.get("Tags", []) if t["Key"] == "Name"),
                            inst["InstanceId"],
                        )
                        tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
                        results.append(
                            {
                                "provider_resource_id": inst["InstanceId"],
                                "resource_type": "EC2Instance",
                                "resource_name": name,
                                # Region, not the availability zone. Storing the AZ
                                # here made the region breakdown list ap-south-1a,
                                # ap-south-1b and ap-south-1 as three separate
                                # "regions"; the AZ is kept in config below.
                                "region_or_zone": region,
                                "status": inst.get("State", {}).get("Name"),
                                "ip_address": inst.get("PublicIpAddress")
                                or inst.get("PrivateIpAddress"),
                                "config": {
                                    "availability_zone": inst.get(
                                        "Placement", {}).get("AvailabilityZone"),
                                    "instance_type": inst.get("InstanceType"),
                                    "image_id": inst.get("ImageId"),
                                    "key_name": inst.get("KeyName"),
                                    "vpc_id": inst.get("VpcId"),
                                    "subnet_id": inst.get("SubnetId"),
                                    # Split out because `ip_address` alone can't
                                    # tell a public address from a private one —
                                    # internet-exposure analysis needs that
                                    # distinction, not just "an IP exists".
                                    "public_ip": inst.get("PublicIpAddress"),
                                    "private_ip": inst.get("PrivateIpAddress"),
                                    "platform": inst.get("Platform", "linux"),
                                    "architecture": inst.get("Architecture"),
                                    "security_group_ids": [sg["GroupId"] for sg in inst.get("SecurityGroups", [])],
                                    "role_arn": inst.get("IamInstanceProfile", {}).get("Arn"),
                                },
                                "metadata": {
                                    "launch_time": str(inst.get("LaunchTime")),
                                    "monitoring": inst.get("Monitoring", {}).get("State"),
                                },
                                "cost_monthly": None,
                                "tags": tags,
                                "raw_data": inst,
                            }
                        )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── EBS Volumes ───────────────────────────────────────────────────────────
    async def _scan_ebs(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2", region)
            try:
                volumes = [
                    vol
                    for page in ec2.get_paginator("describe_volumes").paginate()
                    for vol in page.get("Volumes", [])
                ]
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            if not volumes:
                return []

            # Resolve the instance each volume is attached to (name + power
            # state) in one bulk call, so a volume attached to a stopped
            # instance can be flagged without a describe call per volume.
            instance_ids = {
                att["InstanceId"]
                for vol in volumes
                for att in vol.get("Attachments", [])
                if att.get("State") == "attached" and att.get("InstanceId")
            }
            instance_info: Dict[str, Dict[str, Any]] = {}
            if instance_ids:
                try:
                    for page in ec2.get_paginator("describe_instances").paginate(
                        InstanceIds=list(instance_ids)
                    ):
                        for reservation in page.get("Reservations", []):
                            for inst in reservation.get("Instances", []):
                                name = next(
                                    (t["Value"] for t in inst.get("Tags", []) if t["Key"] == "Name"),
                                    inst["InstanceId"],
                                )
                                instance_info[inst["InstanceId"]] = {
                                    "name": name,
                                    "status": inst.get("State", {}).get("Name"),
                                }
                except Exception:
                    pass

            results = []
            for vol in volumes:
                attachment = next(
                    (a for a in vol.get("Attachments", []) if a.get("State") == "attached"), None
                )
                inst_id = attachment.get("InstanceId") if attachment else None
                inst = instance_info.get(inst_id) if inst_id else None
                name = next(
                    (t["Value"] for t in vol.get("Tags", []) if t["Key"] == "Name"),
                    vol["VolumeId"],
                )
                results.append(
                    {
                        "provider_resource_id": vol["VolumeId"],
                        "resource_type": "EBSVolume",
                        "resource_name": name,
                        # Region, not the AZ (kept in config).
                        "region_or_zone": region,
                        "status": vol.get("State"),
                        "ip_address": None,
                        "config": {
                            "availability_zone": vol.get("AvailabilityZone"),
                            "size_gb": vol.get("Size"),
                            "volume_type": vol.get("VolumeType"),
                            "iops": vol.get("Iops"),
                            "encrypted": vol.get("Encrypted"),
                            "attachment_status": "Attached" if inst_id else "Unattached",
                            "attached_to_id": inst_id,
                            "attached_to_name": inst["name"] if inst else None,
                            "attached_to_status": inst["status"] if inst else None,
                        },
                        "metadata": {
                            "create_time": str(vol.get("CreateTime")),
                        },
                        "cost_monthly": None,
                        "tags": {t["Key"]: t["Value"] for t in vol.get("Tags", [])},
                        "raw_data": vol,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── RDS Instances ─────────────────────────────────────────────────────────
    async def _scan_rds(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            rds = self.auth.get_client("rds", region)
            pages = rds.get_paginator("describe_db_instances").paginate()
            results = []
            for page in pages:
                for db in page.get("DBInstances", []):
                    results.append(
                        {
                            "provider_resource_id": db["DBInstanceIdentifier"],
                            "resource_type": "RDSInstance",
                            "resource_name": db["DBInstanceIdentifier"],
                            "region_or_zone": region,
                            "status": db.get("DBInstanceStatus"),
                            "ip_address": db.get("Endpoint", {}).get("Address"),
                            "config": {
                                "engine": db.get("Engine"),
                                "engine_version": db.get("EngineVersion"),
                                "instance_class": db.get("DBInstanceClass"),
                                "storage_gb": db.get("AllocatedStorage"),
                                "multi_az": db.get("MultiAZ"),
                                "publicly_accessible": db.get("PubliclyAccessible"),
                                "storage_encrypted": db.get("StorageEncrypted", False),
                                "vpc_id": db.get("DBSubnetGroup", {}).get("VpcId"),
                                "security_group_ids": [sg["VpcSecurityGroupId"] for sg in db.get("VpcSecurityGroups", [])],
                            },
                            "metadata": {
                                "db_name": db.get("DBName"),
                                "master_username": db.get("MasterUsername"),
                                "port": db.get("Endpoint", {}).get("Port"),
                            },
                            "cost_monthly": None,
                            "tags": {t["Key"]: t["Value"] for t in db.get("TagList", [])},
                            "raw_data": db,
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── RDS / Aurora / DocumentDB / Neptune Clusters ─────────────────────────
    # A DB Cluster is a SEPARATE billed object from its member DB Instances —
    # Aurora storage and I/O bill at the cluster level, not per instance. Only
    # scanning describe_db_instances (as this file did before) means an
    # Aurora/DocumentDB/Neptune cluster's own storage cost has nothing in
    # inventory to match against, the same class of gap OCI's DB Systems had.
    # All three engines share this one API, differentiated by Engine.
    async def _scan_db_clusters(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            rds = self.auth.get_client("rds", region)
            pages = rds.get_paginator("describe_db_clusters").paginate()
            results = []
            for page in pages:
                for c in page.get("DBClusters", []):
                    engine = (c.get("Engine") or "").lower()
                    if "neptune" in engine:
                        rtype = "NeptuneCluster"
                    elif "docdb" in engine:
                        rtype = "DocumentDBCluster"
                    else:
                        rtype = "AuroraCluster"
                    results.append(
                        {
                            "provider_resource_id": c.get("DBClusterArn") or c["DBClusterIdentifier"],
                            "resource_type": rtype,
                            "resource_name": c["DBClusterIdentifier"],
                            "region_or_zone": region,
                            "status": c.get("Status"),
                            "ip_address": c.get("Endpoint"),
                            "config": {
                                "engine": c.get("Engine"),
                                "engine_version": c.get("EngineVersion"),
                                "storage_gb": c.get("AllocatedStorage"),
                                "multi_az": c.get("MultiAZ"),
                                "storage_encrypted": c.get("StorageEncrypted", False),
                                "publicly_accessible": c.get("PubliclyAccessible"),
                                "vpc_id": None,  # not exposed at cluster level; see member instances
                                "security_group_ids": [
                                    sg["VpcSecurityGroupId"] for sg in c.get("VpcSecurityGroups", [])
                                ],
                                "member_instance_count": len(c.get("DBClusterMembers", [])),
                                "reader_endpoint": c.get("ReaderEndpoint"),
                            },
                            "metadata": {
                                "db_name": c.get("DatabaseName"),
                                "master_username": c.get("MasterUsername"),
                                "port": c.get("Port"),
                                "backup_retention_days": c.get("BackupRetentionPeriod"),
                            },
                            "cost_monthly": None,
                            "tags": {t["Key"]: t["Value"] for t in c.get("TagList", [])},
                            "raw_data": {
                                "DBClusterIdentifier": c.get("DBClusterIdentifier"),
                                "Engine": c.get("Engine"),
                                "Status": c.get("Status"),
                            },
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── ElastiCache (Redis / Memcached) ──────────────────────────────────────
    async def _scan_elasticache(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec = self.auth.get_client("elasticache", region)
            results = []

            # Modern Redis: replication groups (covers both single-primary and
            # cluster-mode-enabled deployments) — the unit ElastiCache actually
            # bills and reports on for Redis.
            for page in ec.get_paginator("describe_replication_groups").paginate():
                for rg in page.get("ReplicationGroups", []):
                    endpoint = (rg.get("ConfigurationEndpoint") or {}).get("Address")
                    if not endpoint and rg.get("NodeGroups"):
                        endpoint = (rg["NodeGroups"][0].get("PrimaryEndpoint") or {}).get("Address")
                    results.append(
                        {
                            "provider_resource_id": rg.get("ARN") or rg["ReplicationGroupId"],
                            "resource_type": "ElastiCacheRedis",
                            "resource_name": rg["ReplicationGroupId"],
                            "region_or_zone": region,
                            "status": rg.get("Status"),
                            "ip_address": endpoint,
                            "config": {
                                "engine": "redis",
                                # ReplicationGroup has no EngineVersion field at
                                # all (only individual CacheClusters do) — report
                                # the honest gap rather than substituting the node
                                # type (e.g. "cache.t3.micro") under this label.
                                "engine_version": None,
                                "node_type": rg.get("CacheNodeType"),
                                "cluster_enabled": rg.get("ClusterEnabled", False),
                                "multi_az": rg.get("MultiAZ"),
                                "at_rest_encrypted": rg.get("AtRestEncryptionEnabled", False),
                                "transit_encrypted": rg.get("TransitEncryptionEnabled", False),
                                "node_count": sum(
                                    len(ng.get("NodeGroupMembers", [])) for ng in rg.get("NodeGroups", [])
                                ),
                            },
                            "metadata": {"description": rg.get("Description")},
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": {"ReplicationGroupId": rg.get("ReplicationGroupId"),
                                         "Status": rg.get("Status")},
                        }
                    )

            # Standalone clusters not part of a replication group — this is
            # where Memcached lives (it has no replication-group concept).
            grouped_cluster_ids = set()
            for page in ec.get_paginator("describe_replication_groups").paginate():
                for rg in page.get("ReplicationGroups", []):
                    for ng in rg.get("NodeGroups", []):
                        for m in ng.get("NodeGroupMembers", []):
                            if m.get("CacheClusterId"):
                                grouped_cluster_ids.add(m["CacheClusterId"])

            for page in ec.get_paginator("describe_cache_clusters").paginate(ShowCacheNodeInfo=True):
                for cc in page.get("CacheClusters", []):
                    if cc["CacheClusterId"] in grouped_cluster_ids:
                        continue  # already represented by its replication group
                    endpoint = (cc.get("ConfigurationEndpoint") or {}).get("Address")
                    if not endpoint and cc.get("CacheNodes"):
                        endpoint = (cc["CacheNodes"][0].get("Endpoint") or {}).get("Address")
                    results.append(
                        {
                            "provider_resource_id": cc.get("ARN") or cc["CacheClusterId"],
                            "resource_type": "ElastiCacheMemcached" if (cc.get("Engine") or "").lower() == "memcached" else "ElastiCacheRedis",
                            "resource_name": cc["CacheClusterId"],
                            "region_or_zone": region,
                            "status": cc.get("CacheClusterStatus"),
                            "ip_address": endpoint,
                            "config": {
                                "engine": cc.get("Engine"),
                                "engine_version": cc.get("EngineVersion"),
                                "node_type": cc.get("CacheNodeType"),
                                "node_count": cc.get("NumCacheNodes"),
                                "security_group_ids": [
                                    sg["SecurityGroupId"] for sg in cc.get("SecurityGroups", [])
                                ],
                            },
                            "metadata": {},
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": {"CacheClusterId": cc.get("CacheClusterId"),
                                         "CacheClusterStatus": cc.get("CacheClusterStatus")},
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Redshift ──────────────────────────────────────────────────────────────
    async def _scan_redshift(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            rs = self.auth.get_client("redshift", region)
            results = []
            for page in rs.get_paginator("describe_clusters").paginate():
                for c in page.get("Clusters", []):
                    endpoint = (c.get("Endpoint") or {}).get("Address")
                    results.append(
                        {
                            "provider_resource_id": c["ClusterIdentifier"],
                            "resource_type": "RedshiftCluster",
                            "resource_name": c["ClusterIdentifier"],
                            "region_or_zone": region,
                            "status": c.get("ClusterStatus"),
                            "ip_address": endpoint,
                            "config": {
                                "node_type": c.get("NodeType"),
                                "node_count": c.get("NumberOfNodes"),
                                "publicly_accessible": c.get("PubliclyAccessible"),
                                "encrypted": c.get("Encrypted", False),
                                "vpc_id": c.get("VpcId"),
                                "security_group_ids": [
                                    sg["VpcSecurityGroupId"] for sg in c.get("VpcSecurityGroups", [])
                                ],
                            },
                            "metadata": {
                                "db_name": c.get("DBName"),
                                "master_username": c.get("MasterUsername"),
                                "port": (c.get("Endpoint") or {}).get("Port"),
                            },
                            "cost_monthly": None,
                            "tags": {t["Key"]: t["Value"] for t in c.get("Tags", [])},
                            "raw_data": {"ClusterIdentifier": c.get("ClusterIdentifier"),
                                         "ClusterStatus": c.get("ClusterStatus")},
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── S3 Buckets ────────────────────────────────────────────────────────────
    async def _scan_s3(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            s3 = self.auth.get_client("s3")
            response = s3.list_buckets()
            results = []
            for bucket in response.get("Buckets", []):
                # Get bucket region
                try:
                    location = s3.get_bucket_location(Bucket=bucket["Name"])
                    bucket_region = location.get("LocationConstraint") or "us-east-1"
                except Exception:
                    bucket_region = "unknown"
                try:
                    pab = s3.get_public_access_block(Bucket=bucket["Name"])
                    public_access_block = pab.get("PublicAccessBlockConfiguration", {})
                except Exception:
                    public_access_block = None
                try:
                    versioning = s3.get_bucket_versioning(Bucket=bucket["Name"]).get("Status") or "Disabled"
                except Exception:
                    versioning = None
                try:
                    enc_rules = s3.get_bucket_encryption(Bucket=bucket["Name"])[
                        "ServerSideEncryptionConfiguration"]["Rules"]
                    encryption = (enc_rules[0].get("ApplyServerSideEncryptionByDefault", {})
                                  .get("SSEAlgorithm")) if enc_rules else None
                except Exception:
                    encryption = None
                try:
                    lifecycle_rules = s3.get_bucket_lifecycle_configuration(
                        Bucket=bucket["Name"]).get("Rules", [])
                except Exception as lc_exc:
                    # NoSuchLifecycleConfiguration = confirmed zero rules; anything else = unknown
                    if "NoSuchLifecycleConfiguration" in str(lc_exc):
                        lifecycle_rules = []
                    else:
                        lifecycle_rules = None

                results.append(
                    {
                        "provider_resource_id": bucket["Name"],
                        "resource_type": "S3Bucket",
                        "resource_name": bucket["Name"],
                        "region_or_zone": bucket_region,
                        # S3 buckets have no status concept in the API — report none
                        "status": None,
                        "ip_address": None,
                        "config": {"versioning": versioning, "encryption": encryption,
                                   "public_access_block": public_access_block,
                                   "lifecycle_rules": lifecycle_rules},
                        "metadata": {
                            "creation_date": str(bucket.get("CreationDate"))
                        },
                        "cost_monthly": None,
                        "tags": {},
                        "raw_data": bucket,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Lambda Functions ──────────────────────────────────────────────────────
    async def _scan_lambda(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            lmb = self.auth.get_client("lambda", region)

            # Event source mappings are what actually wire a stream or queue to a
            # function (DynamoDB Streams, SQS, Kinesis, MSK). One account-wide
            # call, grouped by function, rather than one call per function.
            triggers: Dict[str, List[str]] = {}
            try:
                for page in lmb.get_paginator("list_event_source_mappings").paginate():
                    for esm in page.get("EventSourceMappings", []):
                        fn_arn = esm.get("FunctionArn")
                        src = esm.get("EventSourceArn")
                        if fn_arn and src:
                            triggers.setdefault(fn_arn, []).append(src)
            except Exception as exc:
                if is_transient(exc):
                    raise
                logger.debug("list_event_source_mappings failed in %s: %s", region, exc)

            pages = lmb.get_paginator("list_functions").paginate()
            results = []
            for page in pages:
                for fn in page.get("Functions", []):
                    # list_functions doesn't return tags; fetch them per ARN
                    try:
                        fn_tags = lmb.list_tags(Resource=fn["FunctionArn"]).get("Tags", {})
                    except Exception:
                        fn_tags = {}
                    results.append(
                        {
                            "provider_resource_id": fn["FunctionArn"],
                            "resource_type": "LambdaFunction",
                            "resource_name": fn["FunctionName"],
                            "region_or_zone": region,
                            # list_functions does not return State — None means not fetched
                            "status": fn.get("State"),
                            "ip_address": None,
                            "config": {
                                "runtime": fn.get("Runtime"),
                                "handler": fn.get("Handler"),
                                "memory_mb": fn.get("MemorySize"),
                                "timeout_s": fn.get("Timeout"),
                                "vpc_id": fn.get("VpcConfig", {}).get("VpcId"),
                                "security_group_ids": fn.get("VpcConfig", {}).get("SecurityGroupIds", []),
                                "role_arn": fn.get("Role"),
                                "environment_variables": fn.get("Environment", {}).get("Variables", {}),
                                # Streams / queues that invoke this function.
                                "event_source_arns": triggers.get(fn["FunctionArn"], []),
                            },
                            "metadata": {
                                "last_modified": fn.get("LastModified"),
                                "code_size": fn.get("CodeSize"),
                                "description": fn.get("Description"),
                            },
                            "cost_monthly": None,
                            "tags": fn_tags,
                            "raw_data": fn,
                        }
                    )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── EKS Clusters ─────────────────────────────────────────────────────────
    async def _scan_eks(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            eks = self.auth.get_client("eks", region)
            try:
                names = eks.list_clusters().get("clusters", [])
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            results = []
            for name in names:
                try:
                    cluster = eks.describe_cluster(name=name)["cluster"]
                    results.append(
                        {
                            "provider_resource_id": cluster["arn"],
                            "resource_type": "EKSCluster",
                            "resource_name": cluster["name"],
                            "region_or_zone": region,
                            "status": cluster.get("status"),
                            "ip_address": cluster.get("endpoint"),
                            "config": {
                                "version": cluster.get("version"),
                                "role_arn": cluster.get("roleArn"),
                                # A cluster's network placement — otherwise an EKS
                                # cluster floats free of the VPC it runs in.
                                "vpc_id": cluster.get("resourcesVpcConfig", {}).get("vpcId"),
                                "subnet_ids": cluster.get("resourcesVpcConfig", {}).get("subnetIds", []),
                                "security_group_ids": (
                                    cluster.get("resourcesVpcConfig", {}).get("securityGroupIds", [])
                                    or []
                                ) + (
                                    [cluster["resourcesVpcConfig"]["clusterSecurityGroupId"]]
                                    if cluster.get("resourcesVpcConfig", {}).get("clusterSecurityGroupId")
                                    else []
                                ),
                                "endpoint_public_access": cluster.get(
                                    "resourcesVpcConfig", {}).get("endpointPublicAccess"),
                            },
                            "metadata": {
                                "created_at": str(cluster.get("createdAt")),
                                "kubernetes_version": cluster.get("version"),
                            },
                            "cost_monthly": None,
                            "tags": cluster.get("tags", {}),
                            "raw_data": cluster,
                        }
                    )
                except Exception as exc:
                    logger.warning("EKS describe_cluster %s failed: %s", name, exc)
                    if is_transient(exc):
                        raise
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── DynamoDB Tables ───────────────────────────────────────────────────
    async def _scan_dynamodb(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ddb = self.auth.get_client("dynamodb", region)
            try:
                paginator = ddb.get_paginator("list_tables")
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            results = []
            try:
                for page in paginator.paginate():
                    for table_name in page.get("TableNames", []):
                        try:
                            detail = ddb.describe_table(TableName=table_name)["Table"]
                            results.append(
                                {
                                    "provider_resource_id": detail["TableArn"],
                                    "resource_type": "DynamoDBTable",
                                    "resource_name": detail["TableName"],
                                    "region_or_zone": region,
                                    "status": detail.get("TableStatus"),
                                    "ip_address": None,
                                    "config": {
                                        "billing_mode": detail.get("BillingModeSummary", {}).get("BillingMode", "PROVISIONED"),
                                        "read_capacity": detail.get("ProvisionedThroughput", {}).get("ReadCapacityUnits"),
                                        "write_capacity": detail.get("ProvisionedThroughput", {}).get("WriteCapacityUnits"),
                                        "item_count": detail.get("ItemCount"),
                                        "size_bytes": detail.get("TableSizeBytes"),
                                    },
                                    "metadata": {
                                        "creation_date": str(detail.get("CreationDateTime")),
                                        "key_schema": detail.get("KeySchema"),
                                    },
                                    "cost_monthly": None,
                                    "tags": {},
                                    "raw_data": {
                                        "TableName": detail.get("TableName"),
                                        "TableStatus": detail.get("TableStatus"),
                                    },
                                }
                            )
                        except Exception as exc:
                            logger.warning("DynamoDB describe_table %s failed: %s", table_name, exc)
            except Exception as exc:
                logger.warning("DynamoDB list_tables [%s] failed: %s", region, exc)
                if is_transient(exc):
                    raise
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── ELB / ALB ─────────────────────────────────────────────────────────────
    async def _scan_elb(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            elbv2 = self.auth.get_client("elbv2", region)
            try:
                lbs = [
                    lb
                    for page in elbv2.get_paginator("describe_load_balancers").paginate()
                    for lb in page.get("LoadBalancers", [])
                ]
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            # Which instances each load balancer actually forwards to. Target
            # groups are per-LB, so resolve them once here rather than leaving the
            # graph with a load balancer that connects to nothing downstream.
            targets_by_lb: Dict[str, List[str]] = {}
            tg_names_by_lb: Dict[str, List[str]] = {}
            if lbs:
                try:
                    for page in elbv2.get_paginator("describe_target_groups").paginate():
                        for tg in page.get("TargetGroups", []):
                            arns = tg.get("LoadBalancerArns") or []
                            if not arns:
                                continue
                            ids: List[str] = []
                            try:
                                health = elbv2.describe_target_health(
                                    TargetGroupArn=tg["TargetGroupArn"]
                                )
                                ids = [
                                    d["Target"]["Id"]
                                    for d in health.get("TargetHealthDescriptions", [])
                                    if d.get("Target", {}).get("Id")
                                ]
                            except Exception as exc:  # one bad target group is not fatal
                                if is_transient(exc):
                                    raise
                                logger.debug("target health failed for %s: %s",
                                             tg.get("TargetGroupName"), exc)
                            for arn in arns:
                                targets_by_lb.setdefault(arn, []).extend(ids)
                                tg_names_by_lb.setdefault(arn, []).append(
                                    tg.get("TargetGroupName")
                                )
                except Exception as exc:
                    if is_transient(exc):
                        raise
                    logger.debug("describe_target_groups failed in %s: %s", region, exc)

            results = []
            for lb in lbs:
                arn = lb["LoadBalancerArn"]
                results.append(
                    {
                        "provider_resource_id": arn,
                        "resource_type": "LoadBalancer",
                        "resource_name": lb["LoadBalancerName"],
                        "region_or_zone": region,
                        "status": lb.get("State", {}).get("Code"),
                        "ip_address": lb.get("DNSName"),
                        "config": {
                            "scheme": lb.get("Scheme"),
                            "type": lb.get("Type"),
                            "vpc_id": lb.get("VpcId"),
                            # The subnets it is attached to, and the instances it
                            # sends traffic to — both are real edges.
                            "subnet_ids": [
                                az.get("SubnetId")
                                for az in lb.get("AvailabilityZones", [])
                                if az.get("SubnetId")
                            ],
                            "security_group_ids": lb.get("SecurityGroups", []),
                            "backend_instance_ids": sorted(set(targets_by_lb.get(arn, []))),
                            "target_groups": tg_names_by_lb.get(arn, []),
                        },
                        "metadata": {
                            "created_time": str(lb.get("CreatedTime")),
                        },
                        "cost_monthly": None,
                        "tags": {},
                        "raw_data": lb,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── VPCs ──────────────────────────────────────────────────────────────────
    # ── Subnets ───────────────────────────────────────────────────────────────
    async def _scan_subnet(self, region: str) -> List[Dict[str, Any]]:
        """Subnets, so the subnet_id every EC2 / RDS / ELB already reports has
        something to point at. Without these rows the topology showed instances
        hanging off a VPC with the whole subnet tier missing."""
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2", region)
            try:
                subnets = [
                    s
                    for page in ec2.get_paginator("describe_subnets").paginate()
                    for s in page.get("Subnets", [])
                ]
            except Exception as exc:
                if is_transient(exc):
                    raise
                return []
            results = []
            for s in subnets:
                name = next(
                    (t["Value"] for t in s.get("Tags", []) if t["Key"] == "Name"),
                    s["SubnetId"],
                )
                results.append(
                    {
                        "provider_resource_id": s["SubnetId"],
                        "resource_type": "Subnet",
                        "resource_name": name,
                        "region_or_zone": region,
                        "status": s.get("State"),
                        "ip_address": s.get("CidrBlock"),
                        "config": {
                            # A subnet is AZ-scoped, so this is real placement
                            # information — it just isn't the region.
                            "availability_zone": s.get("AvailabilityZone"),
                            "cidr_block": s.get("CidrBlock"),
                            "vpc_id": s.get("VpcId"),
                            "available_ips": s.get("AvailableIpAddressCount"),
                            "public_ip_on_launch": s.get("MapPublicIpOnLaunch"),
                            "is_default": s.get("DefaultForAz"),
                        },
                        "metadata": {"availability_zone_id": s.get("AvailabilityZoneId")},
                        "cost_monthly": None,
                        "tags": {t["Key"]: t["Value"] for t in s.get("Tags", [])},
                        "raw_data": {
                            "SubnetId": s.get("SubnetId"),
                            "VpcId": s.get("VpcId"),
                            "State": s.get("State"),
                        },
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    async def _scan_vpc(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2", region)
            try:
                vpcs = [
                    vpc
                    for page in ec2.get_paginator("describe_vpcs").paginate()
                    for vpc in page.get("Vpcs", [])
                ]
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            results = []
            for vpc in vpcs:
                name = next(
                    (t["Value"] for t in vpc.get("Tags", []) if t["Key"] == "Name"),
                    vpc["VpcId"],
                )
                results.append(
                    {
                        "provider_resource_id": vpc["VpcId"],
                        "resource_type": "VPC",
                        "resource_name": name,
                        "region_or_zone": region,
                        "status": vpc.get("State"),
                        "ip_address": vpc.get("CidrBlock"),
                        "config": {
                            "cidr_block": vpc.get("CidrBlock"),
                            "is_default": vpc.get("IsDefault"),
                        },
                        "metadata": {
                            "dhcp_options_id": vpc.get("DhcpOptionsId"),
                        },
                        "cost_monthly": None,
                        "tags": {t["Key"]: t["Value"] for t in vpc.get("Tags", [])},
                        "raw_data": vpc,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Security Groups ───────────────────────────────────────────────────────
    async def _scan_security_group(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2", region)
            try:
                sgs = [
                    sg
                    for page in ec2.get_paginator("describe_security_groups").paginate()
                    for sg in page.get("SecurityGroups", [])
                ]
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []
            results = []
            for sg in sgs:
                results.append(
                    {
                        "provider_resource_id": sg["GroupId"],
                        "resource_type": "SecurityGroup",
                        "resource_name": sg["GroupName"],
                        "region_or_zone": region,
                        # Security groups have no lifecycle state in the AWS API
                        "status": None,
                        "ip_address": None,
                        "config": {
                            "description": sg.get("Description"),
                            "inbound_rules": len(sg.get("IpPermissions", [])),
                            "outbound_rules": len(sg.get("IpPermissionsEgress", [])),
                            "vpc_id": sg.get("VpcId"),
                        },
                        "metadata": {},
                        "cost_monthly": None,
                        "tags": {t["Key"]: t["Value"] for t in sg.get("Tags", [])},
                        "raw_data": sg,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── IAM Roles ─────────────────────────────────────────────────────────────
    async def _scan_iam_role(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            iam = self.auth.get_client("iam")
            try:
                roles = [
                    role
                    for page in iam.get_paginator("list_roles").paginate()
                    for role in page.get("Roles", [])
                ]
            except Exception as exc:
                # A dropped connection is not an empty account — let it reach
                # run_scanner, which retries transient failures. Swallowing it
                # here is what recorded 21 real DynamoDB tables as "none".
                if is_transient(exc):
                    raise
                return []

            # Managed policy documents are shared across many roles, so fetch each
            # at most once. Without this, 75 roles all attached to the same handful
            # of policies would mean hundreds of duplicate IAM calls.
            doc_cache: Dict[str, Any] = {}
            # Expanding permissions needs iam:ListAttachedRolePolicies /
            # GetPolicyVersion / GetRolePolicy. If those are not granted, degrade to
            # the previous behaviour (identity only) instead of failing the scan.
            policies_denied = [False]

            def _managed_doc(arn: str):
                if arn in doc_cache:
                    return doc_cache[arn]
                doc = None
                try:
                    pol = iam.get_policy(PolicyArn=arn)["Policy"]
                    ver = iam.get_policy_version(
                        PolicyArn=arn, VersionId=pol["DefaultVersionId"]
                    )
                    doc = ver["PolicyVersion"]["Document"]
                except Exception as exc:
                    if is_transient(exc):
                        raise
                    if is_denial(exc):
                        policies_denied[0] = True
                doc_cache[arn] = doc
                return doc

            def _role_permissions(role_name: str) -> Dict[str, Any]:
                """Concrete resources this role can reach, plus wildcard grants."""
                docs = []
                try:
                    for page in iam.get_paginator("list_attached_role_policies").paginate(
                        RoleName=role_name
                    ):
                        for p in page.get("AttachedPolicies", []):
                            d = _managed_doc(p["PolicyArn"])
                            if d:
                                docs.append(d)
                except Exception as exc:
                    if is_transient(exc):
                        raise
                    if is_denial(exc):
                        policies_denied[0] = True
                try:
                    for page in iam.get_paginator("list_role_policies").paginate(
                        RoleName=role_name
                    ):
                        for pname in page.get("PolicyNames", []):
                            try:
                                docs.append(
                                    iam.get_role_policy(
                                        RoleName=role_name, PolicyName=pname
                                    )["PolicyDocument"]
                                )
                            except Exception as exc:
                                if is_transient(exc):
                                    raise
                                if is_denial(exc):
                                    policies_denied[0] = True
                except Exception as exc:
                    if is_transient(exc):
                        raise
                    if is_denial(exc):
                        policies_denied[0] = True
                return summarize_policy_documents(docs)

            results = []
            for role in roles:
                if "aws-service-role" in role.get("Path", ""):
                    continue
                perms = (
                    {"accessible_resources": [], "broad_access": []}
                    if policies_denied[0]
                    else _role_permissions(role["RoleName"])
                )
                results.append(
                    {
                        "provider_resource_id": role["Arn"],
                        "resource_type": "IAMRole",
                        "resource_name": role["RoleName"],
                        "region_or_zone": "global",
                        # IAM roles have no lifecycle state in the AWS API
                        "status": None,
                        "ip_address": None,
                        "config": {
                            "path": role.get("Path"),
                            "max_session_duration": role.get("MaxSessionDuration"),
                            # What this role is actually allowed to touch. This is
                            # the missing link that left Lambdas unconnected from
                            # the DynamoDB tables they write to: the role edge was
                            # recorded, but never what the role grants.
                            "accessible_resources": perms["accessible_resources"],
                            "broad_access": perms["broad_access"],
                        },
                        "metadata": {
                            "create_date": str(role.get("CreateDate")),
                            "role_id": role.get("RoleId"),
                        },
                        "cost_monthly": None,
                        "tags": {t["Key"]: t["Value"] for t in role.get("Tags", [])},
                        "raw_data": role,
                    }
                )
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── API Gateway ───────────────────────────────────────────────────────────
    async def _scan_apigateway(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            results = []
            # 1. REST APIs (v1)
            try:
                apg = self.auth.get_client("apigateway", region)
                apis_v1 = apg.get_rest_apis().get("items", [])
                for api in apis_v1:
                    results.append(
                        {
                            "provider_resource_id": api["id"],
                            "resource_type": "APIGateway",
                            "resource_name": api["name"],
                            "region_or_zone": region,
                            # REST APIs have no status field in the API
                            "status": None,
                            "ip_address": f"https://{api['id']}.execute-api.{region}.amazonaws.com",
                            "config": {
                                "protocol": "REST",
                                "endpoint_configuration": api.get("endpointConfiguration", {}).get("types", []),
                            },
                            "metadata": {
                                "created_date": str(api.get("createdDate")),
                            },
                            "cost_monthly": None,
                            "tags": api.get("tags", {}),
                            "raw_data": api,
                        }
                    )
            except Exception as e:
                logger.debug("REST API Gateway scan failed in %s: %s", region, e)

            # 2. HTTP/WebSocket APIs (v2)
            try:
                apgv2 = self.auth.get_client("apigatewayv2", region)
                apis_v2 = apgv2.get_apis().get("Items", [])
                for api in apis_v2:
                    results.append(
                        {
                            "provider_resource_id": api["ApiId"],
                            "resource_type": "APIGateway",
                            "resource_name": api["Name"],
                            "region_or_zone": region,
                            # HTTP/WebSocket APIs have no status field in the API
                            "status": None,
                            "ip_address": api.get("ApiEndpoint"),
                            "config": {
                                "protocol": api.get("ProtocolType"),
                                "target": api.get("Target"),
                            },
                            "metadata": {
                                "created_date": str(api.get("CreatedDate")),
                            },
                            "cost_monthly": None,
                            "tags": api.get("Tags", {}),
                            "raw_data": api,
                        }
                    )
            except Exception as e:
                logger.debug("HTTP API Gateway scan failed in %s: %s", region, e)

            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── Bedrock ───────────────────────────────────────────────────────────────
    async def _scan_bedrock(self, region: str) -> List[Dict[str, Any]]:
        loop = asyncio.get_event_loop()

        def _fetch():
            # Three calls, each through _subcall: a call that does not exist in
            # the region (custom models outside a few regions) is simply
            # absent, and a denial is RECORDED. They used to be caught and
            # logged at debug, so a denied Bedrock read returned "no resources"
            # and the sweep looked complete.
            results = []
            models = self._subcall("Bedrock", region, lambda: self.auth.get_client(
                "bedrock", region).list_custom_models().get("modelSummaries", []), "ListCustomModels") or []
            for m in models:
                results.append({
                    "provider_resource_id": m["modelArn"],
                    "resource_type": "BedrockModel",
                    "resource_name": m["modelName"],
                    "region_or_zone": region,
                    "status": m.get("status"),
                    "ip_address": None,
                    "config": {
                        "base_model_arn": m.get("baseModelArn"),
                        "hyperparameters": m.get("hyperParameters"),
                    },
                    "metadata": {"creation_time": str(m.get("creationTime"))},
                    "cost_monthly": None,
                    "tags": {},
                    "raw_data": m,
                })

            agents = self._subcall("Bedrock", region, lambda: self.auth.get_client(
                "bedrock-agent", region).list_agents().get("agentSummaries", []), "ListAgents") or []
            for a in agents:
                results.append({
                    "provider_resource_id": a["agentId"],
                    "resource_type": "BedrockAgent",
                    "resource_name": a["agentName"],
                    "region_or_zone": region,
                    "status": a.get("agentStatus"),
                    "ip_address": None,
                    "config": {
                        "description": a.get("description"),
                        "latest_version": a.get("latestAgentVersion"),
                    },
                    "metadata": {"updated_at": str(a.get("updatedAt"))},
                    "cost_monthly": None,
                    "tags": {},
                    "raw_data": a,
                })

            kbs = self._subcall("Bedrock", region, lambda: self.auth.get_client(
                "bedrock-agent", region).list_knowledge_bases().get(
                    "knowledgeBaseSummaries", []), "ListKnowledgeBases") or []
            for kb in kbs:
                results.append({
                    "provider_resource_id": kb["knowledgeBaseId"],
                    "resource_type": "BedrockKnowledgeBase",
                    "resource_name": kb["name"],
                    "region_or_zone": region,
                    "status": kb.get("status"),
                    "ip_address": None,
                    "config": {"description": kb.get("description")},
                    "metadata": {"updated_at": str(kb.get("updatedAt"))},
                    "cost_monthly": None,
                    "tags": {},
                    "raw_data": kb,
                })
            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── All regions ───────────────────────────────────────────────────────────
    async def _get_regions(self) -> List[str]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2")
            resp = ec2.describe_regions(Filters=[{"Name": "opt-in-status", "Values": ["opt-in-not-required", "opted-in"]}])
            return [r["RegionName"] for r in resp.get("Regions", [])]

        self._region_discovery_error = None
        try:
            return await loop.run_in_executor(scan_pool(), _fetch)
        except Exception as exc:
            # One region is a subset of the account. Remembered so scan_all
            # records the sweep as incomplete rather than letting the prune
            # delete everything in the regions that were never listed.
            self._region_discovery_error = str(exc)[:160]
            return [self.auth.region]

    # The regional scanners, in the order they are dispatched.
    def _regional_scanners(self):
        return [
            (self._scan_ec2, "EC2"),
            (self._scan_ebs, "EBS"),
            (self._scan_rds, "RDS"),
            (self._scan_db_clusters, "DBCluster"),
            (self._scan_elasticache, "ElastiCache"),
            (self._scan_redshift, "Redshift"),
            (self._scan_lambda, "Lambda"),
            (self._scan_eks, "EKS"),
            (self._scan_elb, "ELB"),
            (self._scan_dynamodb, "DynamoDB"),
            (self._scan_vpc, "VPC"),
            (self._scan_subnet, "Subnet"),
            (self._scan_security_group, "SecurityGroup"),
            (self._scan_apigateway, "APIGateway"),
            (self._scan_bedrock, "Bedrock"),
        ]

    async def scan_all(self, on_batch=None) -> List[Dict[str, Any]]:
        """Scan all resource types across all enabled AWS regions in parallel.

        If on_batch is provided, it is awaited with each non-empty batch as it is
        discovered, for incremental persistence / live progress.

        Every (service, region) scope ends with a recorded outcome - read,
        denied, failed, or not offered in that region - and `scope_summary`
        says how much of the account was actually read and why the rest was
        not. Coverage is computed from it, rather than dropping to 0% the
        moment one scope of 272 fails.
        """
        regions = await self._get_regions()
        logger.info("AWS scanning %d regions concurrently: %s", len(regions), regions)

        all_resources: List[Dict[str, Any]] = []
        permission_errors = []
        self.scan_failures = []
        self._outcomes = {}
        self._denied_actions = {}
        # A denied IAM action is denied account-wide, not per-region, so once a
        # service comes back AccessDenied there is no point paying for the same
        # call in the other 17 regions. Bedrock and API Gateway alone were
        # burning dozens of slow round trips to re-learn the same denial.
        self._denied_services = set()
        self._denied_ops = set()
        if getattr(self, "_region_discovery_error", None):
            self.scan_failures.append(
                f"Region discovery failed, only {self.auth.region} was scanned: "
                f"{self._region_discovery_error}")

        async def _emit(batch):
            if batch and on_batch:
                try:
                    await on_batch(batch)
                except Exception as cb_exc:
                    logger.warning("AWS on_batch callback failed: %s", cb_exc)

        # S3 and IAM are global.
        for label, scan in (("S3", self._scan_s3), ("IAM", self._scan_iam_role)):
            try:
                found = await scan()
                all_resources.extend(found)
                self._mark(label, "global", "read")
                logger.info("AWS %s: found %d", label, len(found))
                await _emit(found)
            except Exception as exc:
                logger.warning("AWS %s scan failed: %s", label, exc)
                # Recorded as a failed scope like every regional scanner's
                # failure. Without it a dropped connection during list_buckets
                # left the sweep looking complete, and the prune that follows a
                # complete sweep deleted every S3 bucket (or IAM role) from the
                # inventory - the partial-scan prune bug.
                self.scan_failures.append(f"{label} [global]: {str(exc)[:160]}")
                self._mark(label, "global", "denied" if is_denial(exc) else "failed", exc)
                if is_denial(exc):
                    permission_errors.append(str(exc))

        # 18 regions x 15 services is ~270 blocking calls. Dispatching them all
        # at once just queues them in the thread pool while flooding DNS/TLS, and
        # each stalled call burns its full connect timeout plus retries. Bounding
        # the in-flight count keeps the pool saturated without the pile-up, and
        # lets results stream out steadily rather than in one late burst.
        sem = asyncio.Semaphore(self._MAX_CONCURRENT_SCANS)

        async def run_scanner(scanner_fn, region: str, label: str):
            if label in self._denied_services:
                # Not read: skipped because the service is denied account-wide.
                self._mark(label, region, "denied")
                return []
            async with sem:
                if label in self._denied_services:  # denial may have landed while queued
                    self._mark(label, region, "denied")
                    return []
                last: Exception | None = None
                for attempt in range(self._TRANSIENT_ATTEMPTS):
                    try:
                        results = await scanner_fn(region)
                        self._mark(label, region, "read")
                        logger.info("AWS %s [%s]: found %d resources", label, region, len(results))
                        await _emit(results)
                        return results
                    except Exception as exc:
                        last = exc
                        if is_not_offered(exc):
                            # Nothing can exist here: not a failure, not a gap.
                            self._mark(label, region, "not_offered")
                            return []
                        if is_denial(exc):
                            break
                        if attempt == self._TRANSIENT_ATTEMPTS - 1 or not is_transient(exc):
                            break
                        backoff = 2 * (attempt + 1)
                        logger.info(
                            "AWS %s [%s] hit a dropped connection (attempt %d/%d) - retrying "
                            "in %ss so a blocked call is not mistaken for an empty result.",
                            label, region, attempt + 1, self._TRANSIENT_ATTEMPTS, backoff,
                        )
                        await asyncio.sleep(backoff)

                exc = last  # type: ignore[assignment]
                msg = str(exc)
                logger.warning("AWS %s scan [%s] failed: %s", label, region, exc)
                self.scan_failures.append(f"{label} [{region}]: {msg[:160]}")
                if is_denial(exc):
                    permission_errors.append(msg)
                    self._mark(label, region, "denied", exc)
                    logger.info(
                        "AWS %s is not permitted for these credentials - skipping it "
                        "in the remaining regions.", label,
                    )
                else:
                    self._mark(label, region, "failed", exc)
                return []

        scanners = self._regional_scanners()
        tasks = [run_scanner(fn, region, label) for region in regions for fn, label in scanners]
        if tasks:
            for results in await asyncio.gather(*tasks):
                all_resources.extend(results)

        self.scope_summary = self._build_scope_summary(regions, [label for _, label in scanners])
        logger.info("AWS sweep: %d of %d applicable scopes read (%d not offered in their region)",
                    self.scope_summary["read"], self.scope_summary["attempted"],
                    sum(len(v) for v in self.scope_summary["not_offered"].values()))

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required AWS IAM permissions (ReadOnlyAccess). AWS returned AccessDenied/UnauthorizedOperation during the scan.")

        return all_resources
