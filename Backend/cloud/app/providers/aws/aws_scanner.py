"""AWS resource scanner — discovers EC2, RDS, S3, Lambda, EKS, ELB."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from app.providers.aws.aws_auth import AWSAuth
from app.providers.scan_pool import scan_pool, is_denial, is_transient

logger = logging.getLogger("cloud_svc.aws.scanner")


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
                                "region_or_zone": inst.get(
                                    "Placement", {}
                                ).get("AvailabilityZone", region),
                                "status": inst.get("State", {}).get("Name"),
                                "ip_address": inst.get("PublicIpAddress")
                                or inst.get("PrivateIpAddress"),
                                "config": {
                                    "instance_type": inst.get("InstanceType"),
                                    "image_id": inst.get("ImageId"),
                                    "key_name": inst.get("KeyName"),
                                    "vpc_id": inst.get("VpcId"),
                                    "subnet_id": inst.get("SubnetId"),
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
                        "region_or_zone": vol.get("AvailabilityZone", region),
                        "status": vol.get("State"),
                        "ip_address": None,
                        "config": {
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
            results = []
            for lb in lbs:
                results.append(
                    {
                        "provider_resource_id": lb["LoadBalancerArn"],
                        "resource_type": "LoadBalancer",
                        "resource_name": lb["LoadBalancerName"],
                        "region_or_zone": region,
                        "status": lb.get("State", {}).get("Code"),
                        "ip_address": lb.get("DNSName"),
                        "config": {
                            "scheme": lb.get("Scheme"),
                            "type": lb.get("Type"),
                            "vpc_id": lb.get("VpcId"),
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
            results = []
            for role in roles:
                if "aws-service-role" in role.get("Path", ""):
                    continue
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
            results = []
            # Bedrock Custom Models
            try:
                bd = self.auth.get_client("bedrock", region)
                models = bd.list_custom_models().get("modelSummaries", [])
                for m in models:
                    results.append(
                        {
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
                            "metadata": {
                                "creation_time": str(m.get("creationTime")),
                            },
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": m,
                        }
                    )
            except Exception as e:
                logger.debug("Bedrock Model scan failed in %s: %s", region, e)

            # Bedrock Agents
            try:
                bda = self.auth.get_client("bedrock-agent", region)
                agents = bda.list_agents().get("agentSummaries", [])
                for a in agents:
                    results.append(
                        {
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
                            "metadata": {
                                "updated_at": str(a.get("updatedAt")),
                            },
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": a,
                        }
                    )
            except Exception as e:
                logger.debug("Bedrock Agent scan failed in %s: %s", region, e)

            # Bedrock Knowledge Bases
            try:
                bda = self.auth.get_client("bedrock-agent", region)
                kbs = bda.list_knowledge_bases().get("knowledgeBaseSummaries", [])
                for kb in kbs:
                    results.append(
                        {
                            "provider_resource_id": kb["knowledgeBaseId"],
                            "resource_type": "BedrockKnowledgeBase",
                            "resource_name": kb["name"],
                            "region_or_zone": region,
                            "status": kb.get("status"),
                            "ip_address": None,
                            "config": {
                                "description": kb.get("description"),
                            },
                            "metadata": {
                                "updated_at": str(kb.get("updatedAt")),
                            },
                            "cost_monthly": None,
                            "tags": {},
                            "raw_data": kb,
                        }
                    )
            except Exception as e:
                logger.debug("Bedrock Knowledge Base scan failed in %s: %s", region, e)

            return results

        return await loop.run_in_executor(scan_pool(), _fetch)

    # ── All regions ───────────────────────────────────────────────────────────
    async def _get_regions(self) -> List[str]:
        loop = asyncio.get_event_loop()

        def _fetch():
            ec2 = self.auth.get_client("ec2")
            resp = ec2.describe_regions(Filters=[{"Name": "opt-in-status", "Values": ["opt-in-not-required", "opted-in"]}])
            return [r["RegionName"] for r in resp.get("Regions", [])]

        try:
            return await loop.run_in_executor(scan_pool(), _fetch)
        except Exception:
            return [self.auth.region]

    async def scan_all(self, on_batch=None) -> List[Dict[str, Any]]:
        """Scan all resource types across all enabled AWS regions in parallel.

        If on_batch is provided, it is awaited with each non-empty batch as it is
        discovered, for incremental persistence / live progress.
        """
        regions = await self._get_regions()
        logger.info("AWS scanning %d regions concurrently: %s", len(regions), regions)

        all_resources: List[Dict[str, Any]] = []
        permission_errors = []
        self.scan_failures = []

        async def _emit(batch):
            if batch and on_batch:
                try:
                    await on_batch(batch)
                except Exception as cb_exc:
                    logger.warning("AWS on_batch callback failed: %s", cb_exc)

        # S3 is global
        try:
            s3_resources = await self._scan_s3()
            all_resources.extend(s3_resources)
            logger.info("AWS S3: found %d buckets", len(s3_resources))
            await _emit(s3_resources)
        except Exception as exc:
            logger.warning("AWS S3 scan failed: %s", exc)
            if "AccessDenied" in str(exc) or "UnauthorizedOperation" in str(exc):
                permission_errors.append(str(exc))

        # IAM Roles are global
        try:
            iam_resources = await self._scan_iam_role()
            all_resources.extend(iam_resources)
            logger.info("AWS IAM: found %d roles", len(iam_resources))
            await _emit(iam_resources)
        except Exception as exc:
            logger.warning("AWS IAM scan failed: %s", exc)
            if "AccessDenied" in str(exc) or "UnauthorizedOperation" in str(exc):
                permission_errors.append(str(exc))

        # Build list of async tasks for per-region scanning
        tasks = []

        # 18 regions x 11 services is ~200 blocking calls. Dispatching them all
        # at once just queues them in the thread pool while flooding DNS/TLS, and
        # each stalled call burns its full connect timeout plus retries. Bounding
        # the in-flight count keeps the pool saturated without the pile-up, and
        # lets results stream out steadily rather than in one late burst.
        sem = asyncio.Semaphore(self._MAX_CONCURRENT_SCANS)

        # A denied IAM action is denied account-wide, not per-region, so once a
        # service comes back AccessDenied there is no point paying for the same
        # call in the other 17 regions. Bedrock and API Gateway alone were
        # burning dozens of slow round trips to re-learn the same denial.
        denied_services: set = set()

        async def run_scanner(scanner_fn, region: str, label: str):
            if label in denied_services:
                return []
            async with sem:
                if label in denied_services:  # denial may have landed while queued
                    return []
                last: Exception | None = None
                for attempt in range(self._TRANSIENT_ATTEMPTS):
                    try:
                        results = await scanner_fn(region)
                        logger.info("AWS %s [%s]: found %d resources", label, region, len(results))
                        await _emit(results)
                        return results
                    except Exception as exc:
                        last = exc
                        if is_denial(exc):
                            break
                        if attempt == self._TRANSIENT_ATTEMPTS - 1 or not is_transient(exc):
                            break
                        backoff = 2 * (attempt + 1)
                        logger.info(
                            "AWS %s [%s] hit a dropped connection (attempt %d/%d) — retrying "
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
                    denied_services.add(label)
                    logger.info(
                        "AWS %s is not permitted for these credentials — skipping it "
                        "in the remaining regions.", label,
                    )
                return []

        for region in regions:
            for scanner_fn, label in [
                (self._scan_ec2, "EC2"),
                (self._scan_ebs, "EBS"),
                (self._scan_rds, "RDS"),
                (self._scan_lambda, "Lambda"),
                (self._scan_eks, "EKS"),
                (self._scan_elb, "ELB"),
                (self._scan_dynamodb, "DynamoDB"),
                (self._scan_vpc, "VPC"),
                (self._scan_security_group, "SecurityGroup"),
                (self._scan_apigateway, "APIGateway"),
                (self._scan_bedrock, "Bedrock"),
            ]:
                tasks.append(run_scanner(scanner_fn, region, label))

        # Execute all scans concurrently
        if tasks:
            results_list = await asyncio.gather(*tasks)
            for results in results_list:
                all_resources.extend(results)

        if len(all_resources) == 0 and len(permission_errors) > 0:
            raise PermissionError("Missing required AWS IAM permissions (ReadOnlyAccess). AWS returned AccessDenied/UnauthorizedOperation during the scan.")

        return all_resources

