"""
AWS Comprehensive Discovery Engine
Deep-dive analysis of ALL AWS resources
"""

import boto3
from botocore.exceptions import ClientError, NoCredentialsError
from typing import Dict, List, Any, Optional
import logging
from cloud.core.base_discovery import BaseCloudDiscovery

logger = logging.getLogger(__name__)


class AWSDiscovery(BaseCloudDiscovery):
    """Comprehensive AWS resource discovery with deep analysis"""

    def __init__(self, account_config: Dict[str, Any]):
        super().__init__(account_config)
        self.aws_access_key = account_config.get("aws_access_key_id")
        self.aws_secret_key = account_config.get("aws_secret_access_key")
        self.aws_session_token = account_config.get("aws_session_token")
        self.session = None
        self.clients = {}

    def authenticate(self) -> bool:
        """Authenticate with AWS and create session"""
        try:
            session_kwargs = {
                "aws_access_key_id": self.aws_access_key,
                "aws_secret_access_key": self.aws_secret_key,
                "region_name": self.region or "us-east-1",
            }

            if self.aws_session_token:
                session_kwargs["aws_session_token"] = self.aws_session_token

            self.session = boto3.Session(**session_kwargs)

            # Test authentication
            sts = self.session.client("sts")
            identity = sts.get_caller_identity()
            logger.info(f"✅ AWS Authentication successful: {identity['Account']}")
            return True

        except (ClientError, NoCredentialsError) as e:
            logger.error(f"❌ AWS Authentication failed: {e}")
            return False

    def get_client(self, service_name: str):
        """Get or create boto3 client for a service"""
        if service_name not in self.clients:
            self.clients[service_name] = self.session.client(service_name)
        return self.clients[service_name]

    def discover_ec2_instances(self) -> List[Dict[str, Any]]:
        """Discover EC2 instances with full details"""
        resources = []
        try:
            ec2 = self.get_client("ec2")
            response = ec2.describe_instances()

            for reservation in response.get("Reservations", []):
                for instance in reservation.get("Instances", []):
                    instance_id = instance.get("InstanceId")
                    instance_name = next(
                        (
                            tag["Value"]
                            for tag in instance.get("Tags", [])
                            if tag["Key"] == "Name"
                        ),
                        instance_id,
                    )

                    private_ip = instance.get("PrivateIpAddress")
                    public_ip = instance.get("PublicIpAddress")
                    ip_address = public_ip or private_ip

                    metadata = {
                        "instance_type": instance.get("InstanceType"),
                        "state": instance.get("State", {}).get("Name"),
                        "launch_time": str(instance.get("LaunchTime")),
                        "availability_zone": instance.get("Placement", {}).get(
                            "AvailabilityZone"
                        ),
                        "vpc_id": instance.get("VpcId"),
                        "subnet_id": instance.get("SubnetId"),
                        "private_ip": private_ip,
                        "public_ip": public_ip,
                        "security_groups": [
                            sg["GroupName"] for sg in instance.get("SecurityGroups", [])
                        ],
                        "tags": instance.get("Tags", []),
                    }

                    resources.append(
                        self.format_resource(
                            resource_id=instance_id,
                            resource_name=instance_name,
                            resource_type="EC2 Instance",
                            region=instance.get("Placement", {}).get(
                                "AvailabilityZone", self.region
                            ),
                            status=instance.get("State", {}).get("Name", "unknown"),
                            ip_address=ip_address,
                            metadata=metadata,
                        )
                    )

            self.log_discovery("EC2 Instances", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering EC2 instances: {e}")

        return resources

    def discover_rds_databases(self) -> List[Dict[str, Any]]:
        """Discover RDS database instances"""
        resources = []
        try:
            rds = self.get_client("rds")
            response = rds.describe_db_instances()

            for db in response.get("DBInstances", []):
                db_identifier = db.get("DBInstanceIdentifier")

                metadata = {
                    "engine": db.get("Engine"),
                    "engine_version": db.get("EngineVersion"),
                    "instance_class": db.get("DBInstanceClass"),
                    "allocated_storage": db.get("AllocatedStorage"),
                    "storage_type": db.get("StorageType"),
                    "multi_az": db.get("MultiAZ"),
                    "availability_zone": db.get("AvailabilityZone"),
                    "endpoint": db.get("Endpoint", {}).get("Address")
                    if db.get("Endpoint")
                    else None,
                    "port": db.get("Endpoint", {}).get("Port")
                    if db.get("Endpoint")
                    else None,
                    "vpc_id": db.get("DBSubnetGroup", {}).get("VpcId")
                    if db.get("DBSubnetGroup")
                    else None,
                    "publicly_accessible": db.get("PubliclyAccessible"),
                    "backup_retention": db.get("BackupRetentionPeriod"),
                }

                resources.append(
                    self.format_resource(
                        resource_id=db.get("DbiResourceId"),
                        resource_name=db_identifier,
                        resource_type=f"RDS {db.get('Engine', 'Database')}",
                        region=db.get("AvailabilityZone", self.region),
                        status=db.get("DBInstanceStatus", "unknown"),
                        ip_address=metadata.get("endpoint"),
                        metadata=metadata,
                    )
                )

            self.log_discovery("RDS Databases", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering RDS databases: {e}")

        return resources

    def discover_dynamodb_tables(self) -> List[Dict[str, Any]]:
        """Discover DynamoDB tables with full analysis"""
        resources = []
        try:
            dynamodb = self.get_client("dynamodb")
            response = dynamodb.list_tables()

            for table_name in response.get("TableNames", []):
                try:
                    # Get detailed table info
                    table_info = dynamodb.describe_table(TableName=table_name)
                    table = table_info.get("Table", {})

                    # Get table size and item count
                    item_count = table.get("ItemCount", 0)
                    table_size_bytes = table.get("TableSizeBytes", 0)
                    table_size_mb = round(table_size_bytes / (1024 * 1024), 2)

                    metadata = {
                        "table_status": table.get("TableStatus"),
                        "creation_date": str(table.get("CreationDateTime")),
                        "item_count": item_count,
                        "table_size_mb": table_size_mb,
                        "table_size_bytes": table_size_bytes,
                        "table_arn": table.get("TableArn"),
                        "table_id": table.get("TableId"),
                        "key_schema": table.get("KeySchema", []),
                        "attribute_definitions": table.get("AttributeDefinitions", []),
                        "provisioned_throughput": table.get("ProvisionedThroughput"),
                        "billing_mode": table.get("BillingModeSummary", {}).get(
                            "BillingMode"
                        ),
                        "global_secondary_indexes": len(
                            table.get("GlobalSecondaryIndexes", [])
                        ),
                        "local_secondary_indexes": len(
                            table.get("LocalSecondaryIndexes", [])
                        ),
                        "stream_enabled": table.get("StreamSpecification", {}).get(
                            "StreamEnabled", False
                        ),
                        "encryption_type": table.get("SSEDescription", {}).get(
                            "SSEType", "None"
                        ),
                    }

                    resources.append(
                        self.format_resource(
                            resource_id=table.get("TableArn"),
                            resource_name=table_name,
                            resource_type="DynamoDB Table",
                            region=self.region,
                            status=table.get("TableStatus", "unknown"),
                            ip_address=None,
                            metadata=metadata,
                        )
                    )

                except ClientError as e:
                    logger.warning(
                        f"Could not get details for DynamoDB table {table_name}: {e}"
                    )

            self.log_discovery("DynamoDB Tables", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering DynamoDB tables: {e}")

        return resources

    def discover_s3_buckets(self) -> List[Dict[str, Any]]:
        """Discover S3 buckets with analysis"""
        resources = []
        try:
            s3 = self.get_client("s3")
            response = s3.list_buckets()

            for bucket in response.get("Buckets", []):
                bucket_name = bucket.get("Name")

                try:
                    # Get bucket location
                    location_response = s3.get_bucket_location(Bucket=bucket_name)
                    bucket_region = location_response.get("LocationConstraint") or "us-east-1"

                    # Get bucket versioning
                    try:
                        versioning = s3.get_bucket_versioning(Bucket=bucket_name)
                        versioning_status = versioning.get("Status", "Disabled")
                    except:
                        versioning_status = "Unknown"

                    # Get bucket encryption
                    try:
                        encryption = s3.get_bucket_encryption(Bucket=bucket_name)
                        encryption_enabled = True
                    except:
                        encryption_enabled = False

                    # Get public access block
                    try:
                        public_access = s3.get_public_access_block(Bucket=bucket_name)
                        is_public = not public_access.get(
                            "PublicAccessBlockConfiguration", {}
                        ).get("BlockPublicAcls", True)
                    except:
                        is_public = "Unknown"

                    metadata = {
                        "creation_date": str(bucket.get("CreationDate")),
                        "bucket_region": bucket_region,
                        "versioning": versioning_status,
                        "encryption_enabled": encryption_enabled,
                        "is_public": is_public,
                    }

                    resources.append(
                        self.format_resource(
                            resource_id=bucket_name,
                            resource_name=bucket_name,
                            resource_type="S3 Bucket",
                            region=bucket_region,
                            status="Active",
                            ip_address=None,
                            metadata=metadata,
                        )
                    )

                except ClientError as e:
                    logger.warning(f"Could not get details for S3 bucket {bucket_name}: {e}")

            self.log_discovery("S3 Buckets", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering S3 buckets: {e}")

        return resources

    def discover_lambda_functions(self) -> List[Dict[str, Any]]:
        """Discover Lambda functions"""
        resources = []
        try:
            lambda_client = self.get_client("lambda")
            response = lambda_client.list_functions()

            for func in response.get("Functions", []):
                function_name = func.get("FunctionName")

                metadata = {
                    "runtime": func.get("Runtime"),
                    "handler": func.get("Handler"),
                    "code_size": func.get("CodeSize"),
                    "memory": func.get("MemorySize"),
                    "timeout": func.get("Timeout"),
                    "last_modified": func.get("LastModified"),
                    "function_arn": func.get("FunctionArn"),
                    "role": func.get("Role"),
                    "environment_variables": len(
                        func.get("Environment", {}).get("Variables", {})
                    ),
                }

                resources.append(
                    self.format_resource(
                        resource_id=func.get("FunctionArn"),
                        resource_name=function_name,
                        resource_type="Lambda Function",
                        region=self.region,
                        status="Active",
                        ip_address=None,
                        metadata=metadata,
                    )
                )

            self.log_discovery("Lambda Functions", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering Lambda functions: {e}")

        return resources

    def discover_elasticache_clusters(self) -> List[Dict[str, Any]]:
        """Discover ElastiCache clusters"""
        resources = []
        try:
            elasticache = self.get_client("elasticache")
            response = elasticache.describe_cache_clusters(ShowCacheNodeInfo=True)

            for cluster in response.get("CacheClusters", []):
                cluster_id = cluster.get("CacheClusterId")

                # Get primary endpoint
                endpoint = None
                if cluster.get("CacheNodes"):
                    endpoint = cluster["CacheNodes"][0].get("Endpoint", {}).get(
                        "Address"
                    )

                metadata = {
                    "engine": cluster.get("Engine"),
                    "engine_version": cluster.get("EngineVersion"),
                    "node_type": cluster.get("CacheNodeType"),
                    "num_cache_nodes": cluster.get("NumCacheNodes"),
                    "endpoint": endpoint,
                    "port": cluster.get("CacheNodes", [{}])[0]
                    .get("Endpoint", {})
                    .get("Port")
                    if cluster.get("CacheNodes")
                    else None,
                }

                resources.append(
                    self.format_resource(
                        resource_id=cluster.get("ARN"),
                        resource_name=cluster_id,
                        resource_type=f"ElastiCache {cluster.get('Engine', 'Cache')}",
                        region=self.region,
                        status=cluster.get("CacheClusterStatus", "unknown"),
                        ip_address=endpoint,
                        metadata=metadata,
                    )
                )

            self.log_discovery("ElastiCache Clusters", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering ElastiCache clusters: {e}")

        return resources

    def discover_elb_load_balancers(self) -> List[Dict[str, Any]]:
        """Discover Elastic Load Balancers (Classic, ALB, NLB)"""
        resources = []

        # Classic Load Balancers
        try:
            elb = self.get_client("elb")
            response = elb.describe_load_balancers()

            for lb in response.get("LoadBalancerDescriptions", []):
                lb_name = lb.get("LoadBalancerName")

                metadata = {
                    "type": "Classic Load Balancer",
                    "dns_name": lb.get("DNSName"),
                    "scheme": lb.get("Scheme"),
                    "availability_zones": lb.get("AvailabilityZones", []),
                    "instances": len(lb.get("Instances", [])),
                }

                resources.append(
                    self.format_resource(
                        resource_id=lb_name,
                        resource_name=lb_name,
                        resource_type="Classic Load Balancer",
                        region=self.region,
                        status="Active",
                        ip_address=metadata.get("dns_name"),
                        metadata=metadata,
                    )
                )

        except ClientError as e:
            logger.error(f"Error discovering Classic Load Balancers: {e}")

        # Application/Network Load Balancers
        try:
            elbv2 = self.get_client("elbv2")
            response = elbv2.describe_load_balancers()

            for lb in response.get("LoadBalancers", []):
                lb_name = lb.get("LoadBalancerName")
                lb_type = lb.get("Type", "").upper()

                metadata = {
                    "type": lb_type,
                    "dns_name": lb.get("DNSName"),
                    "scheme": lb.get("Scheme"),
                    "availability_zones": [
                        az.get("ZoneName") for az in lb.get("AvailabilityZones", [])
                    ],
                    "state": lb.get("State", {}).get("Code"),
                }

                resources.append(
                    self.format_resource(
                        resource_id=lb.get("LoadBalancerArn"),
                        resource_name=lb_name,
                        resource_type=f"{lb_type} Load Balancer",
                        region=self.region,
                        status=lb.get("State", {}).get("Code", "unknown"),
                        ip_address=metadata.get("dns_name"),
                        metadata=metadata,
                    )
                )

            self.log_discovery("Load Balancers", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering ALB/NLB Load Balancers: {e}")

        return resources

    def discover_ecs_clusters(self) -> List[Dict[str, Any]]:
        """Discover ECS clusters and services"""
        resources = []
        try:
            ecs = self.get_client("ecs")
            cluster_arns = ecs.list_clusters().get("clusterArns", [])

            if cluster_arns:
                clusters = ecs.describe_clusters(clusters=cluster_arns).get(
                    "clusters", []
                )

                for cluster in clusters:
                    cluster_name = cluster.get("clusterName")

                    # Get services in cluster
                    service_arns = ecs.list_services(cluster=cluster_name).get(
                        "serviceArns", []
                    )

                    metadata = {
                        "status": cluster.get("status"),
                        "running_tasks": cluster.get("runningTasksCount"),
                        "pending_tasks": cluster.get("pendingTasksCount"),
                        "active_services": cluster.get("activeServicesCount"),
                        "registered_instances": cluster.get(
                            "registeredContainerInstancesCount"
                        ),
                        "services": len(service_arns),
                    }

                    resources.append(
                        self.format_resource(
                            resource_id=cluster.get("clusterArn"),
                            resource_name=cluster_name,
                            resource_type="ECS Cluster",
                            region=self.region,
                            status=cluster.get("status", "unknown"),
                            ip_address=None,
                            metadata=metadata,
                        )
                    )

            self.log_discovery("ECS Clusters", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering ECS clusters: {e}")

        return resources

    def discover_eks_clusters(self) -> List[Dict[str, Any]]:
        """Discover EKS Kubernetes clusters"""
        resources = []
        try:
            eks = self.get_client("eks")
            cluster_names = eks.list_clusters().get("clusters", [])

            for cluster_name in cluster_names:
                cluster = eks.describe_cluster(name=cluster_name).get("cluster", {})

                metadata = {
                    "status": cluster.get("status"),
                    "version": cluster.get("version"),
                    "endpoint": cluster.get("endpoint"),
                    "platform_version": cluster.get("platformVersion"),
                    "role_arn": cluster.get("roleArn"),
                    "vpc_id": cluster.get("resourcesVpcConfig", {}).get("vpcId"),
                    "created_at": str(cluster.get("createdAt")),
                }

                resources.append(
                    self.format_resource(
                        resource_id=cluster.get("arn"),
                        resource_name=cluster_name,
                        resource_type="EKS Cluster",
                        region=self.region,
                        status=cluster.get("status", "unknown"),
                        ip_address=metadata.get("endpoint"),
                        metadata=metadata,
                    )
                )

            self.log_discovery("EKS Clusters", len(resources))
        except ClientError as e:
            logger.error(f"Error discovering EKS clusters: {e}")

        return resources

    def discover_compute(self) -> List[Dict[str, Any]]:
        """Discover all compute resources"""
        resources = []
        resources.extend(self.discover_ec2_instances())
        resources.extend(self.discover_lambda_functions())
        resources.extend(self.discover_ecs_clusters())
        resources.extend(self.discover_eks_clusters())
        return resources

    def discover_storage(self) -> List[Dict[str, Any]]:
        """Discover all storage resources"""
        resources = []
        resources.extend(self.discover_s3_buckets())
        # Can add EBS volumes, EFS, etc.
        return resources

    def discover_databases(self) -> List[Dict[str, Any]]:
        """Discover all database resources"""
        resources = []
        resources.extend(self.discover_rds_databases())
        resources.extend(self.discover_dynamodb_tables())
        resources.extend(self.discover_elasticache_clusters())
        return resources

    def discover_networking(self) -> List[Dict[str, Any]]:
        """Discover all networking resources"""
        resources = []
        resources.extend(self.discover_elb_load_balancers())
        # Can add VPCs, subnets, security groups, etc.
        return resources

    def discover_all(self) -> Dict[str, List[Dict[str, Any]]]:
        """
        Run comprehensive discovery across ALL AWS services

        Returns:
            Dictionary with categorized resources
        """
        if not self.authenticate():
            return {"error": "Authentication failed"}

        logger.info(f"🚀 Starting comprehensive AWS discovery for {self.account_name}")

        all_resources = {
            "compute": self.discover_compute(),
            "storage": self.discover_storage(),
            "databases": self.discover_databases(),
            "networking": self.discover_networking(),
        }

        # Flatten all resources for easy access
        flat_resources = []
        for category, resources in all_resources.items():
            flat_resources.extend(resources)

        all_resources["all"] = flat_resources
        all_resources["summary"] = {
            "total_resources": len(flat_resources),
            "compute_count": len(all_resources["compute"]),
            "storage_count": len(all_resources["storage"]),
            "database_count": len(all_resources["databases"]),
            "networking_count": len(all_resources["networking"]),
            "provider": self.provider,
            "account_name": self.account_name,
            "region": self.region,
        }

        logger.info(
            f"✅ AWS Discovery complete: {len(flat_resources)} total resources found"
        )

        return all_resources
