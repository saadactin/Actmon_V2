"""
AWS Resource Deep Analysis
Comprehensive drill-down analysis for all AWS resources
"""

import boto3
from botocore.exceptions import ClientError
from typing import Dict, Any, Optional, List
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


class AWSResourceAnalyzer:
    """Deep analysis for AWS resources with cost, metrics, and utilization"""

    def __init__(self, session: boto3.Session, region: str):
        self.session = session
        self.region = region
        self.clients = {}

    def get_client(self, service_name: str):
        """Get or create boto3 client"""
        if service_name not in self.clients:
            self.clients[service_name] = self.session.client(service_name)
        return self.clients[service_name]

    def analyze_ec2_instance(self, instance_id: str) -> Dict[str, Any]:
        """
        Complete EC2 instance analysis:
        - CPU utilization
        - Memory metrics
        - Network I/O
        - Disk I/O
        - Cost estimation
        - Security groups
        - Volume details
        """
        try:
            ec2 = self.get_client("ec2")
            cloudwatch = self.get_client("cloudwatch")

            # Get instance details
            response = ec2.describe_instances(InstanceIds=[instance_id])
            instance = response["Reservations"][0]["Instances"][0]

            # Get volumes
            volumes = []
            for vol in instance.get("BlockDeviceMappings", []):
                if "Ebs" in vol:
                    vol_id = vol["Ebs"]["VolumeId"]
                    vol_info = ec2.describe_volumes(VolumeIds=[vol_id])["Volumes"][0]
                    volumes.append({
                        "volume_id": vol_id,
                        "size_gb": vol_info["Size"],
                        "type": vol_info["VolumeType"],
                        "iops": vol_info.get("Iops"),
                        "encrypted": vol_info["Encrypted"],
                        "state": vol_info["State"],
                        "device_name": vol["DeviceName"],
                    })

            # Get CloudWatch metrics (last 24 hours)
            end_time = datetime.utcnow()
            start_time = end_time - timedelta(hours=24)

            metrics = {}

            # CPU Utilization
            try:
                cpu_stats = cloudwatch.get_metric_statistics(
                    Namespace="AWS/EC2",
                    MetricName="CPUUtilization",
                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Average", "Maximum"],
                )
                if cpu_stats["Datapoints"]:
                    cpu_data = sorted(cpu_stats["Datapoints"], key=lambda x: x["Timestamp"])
                    metrics["cpu_utilization"] = {
                        "current_avg": cpu_data[-1]["Average"] if cpu_data else 0,
                        "max_24h": max([d["Maximum"] for d in cpu_data]) if cpu_data else 0,
                        "avg_24h": sum([d["Average"] for d in cpu_data]) / len(cpu_data) if cpu_data else 0,
                        "datapoints": len(cpu_data),
                    }
                else:
                    metrics["cpu_utilization"] = {"message": "No data available (instance might be stopped)"}
            except ClientError as e:
                metrics["cpu_utilization"] = {"error": str(e)}

            # Network In/Out
            try:
                network_in = cloudwatch.get_metric_statistics(
                    Namespace="AWS/EC2",
                    MetricName="NetworkIn",
                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Sum"],
                )
                network_out = cloudwatch.get_metric_statistics(
                    Namespace="AWS/EC2",
                    MetricName="NetworkOut",
                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Sum"],
                )

                total_in = sum([d["Sum"] for d in network_in["Datapoints"]]) / (1024**3)  # GB
                total_out = sum([d["Sum"] for d in network_out["Datapoints"]]) / (1024**3)  # GB

                metrics["network"] = {
                    "data_in_gb_24h": round(total_in, 3),
                    "data_out_gb_24h": round(total_out, 3),
                    "total_gb_24h": round(total_in + total_out, 3),
                }
            except ClientError as e:
                metrics["network"] = {"error": str(e)}

            # Disk I/O
            try:
                disk_read = cloudwatch.get_metric_statistics(
                    Namespace="AWS/EC2",
                    MetricName="DiskReadBytes",
                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Sum"],
                )
                disk_write = cloudwatch.get_metric_statistics(
                    Namespace="AWS/EC2",
                    MetricName="DiskWriteBytes",
                    Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Sum"],
                )

                total_read = sum([d["Sum"] for d in disk_read["Datapoints"]]) / (1024**3)  # GB
                total_write = sum([d["Sum"] for d in disk_write["Datapoints"]]) / (1024**3)  # GB

                metrics["disk_io"] = {
                    "read_gb_24h": round(total_read, 3),
                    "write_gb_24h": round(total_write, 3),
                    "total_gb_24h": round(total_read + total_write, 3),
                }
            except ClientError as e:
                metrics["disk_io"] = {"error": str(e)}

            # Cost estimation
            instance_type = instance["InstanceType"]
            cost_estimate = self._estimate_ec2_cost(instance_type, instance["State"]["Name"], volumes)

            # Security groups
            security_groups = []
            for sg in instance.get("SecurityGroups", []):
                sg_details = ec2.describe_security_groups(GroupIds=[sg["GroupId"]])["SecurityGroups"][0]
                security_groups.append({
                    "id": sg["GroupId"],
                    "name": sg["GroupName"],
                    "inbound_rules": len(sg_details.get("IpPermissions", [])),
                    "outbound_rules": len(sg_details.get("IpPermissionsEgress", [])),
                })

            return {
                "instance_id": instance_id,
                "instance_type": instance_type,
                "state": instance["State"]["Name"],
                "launch_time": str(instance["LaunchTime"]),
                "platform": instance.get("Platform", "Linux/Unix"),
                "public_ip": instance.get("PublicIpAddress"),
                "private_ip": instance.get("PrivateIpAddress"),
                "vpc_id": instance.get("VpcId"),
                "subnet_id": instance.get("SubnetId"),
                "availability_zone": instance["Placement"]["AvailabilityZone"],
                "tenancy": instance["Placement"]["Tenancy"],
                "monitoring": instance["Monitoring"]["State"],
                "volumes": volumes,
                "total_storage_gb": sum([v["size_gb"] for v in volumes]),
                "security_groups": security_groups,
                "metrics": metrics,
                "cost_estimate": cost_estimate,
                "tags": instance.get("Tags", []),
            }

        except ClientError as e:
            logger.error(f"Error analyzing EC2 instance {instance_id}: {e}")
            return {"error": str(e)}

    def analyze_lambda_function(self, function_name: str) -> Dict[str, Any]:
        """
        Complete Lambda function analysis:
        - Invocation count
        - Duration metrics
        - Error rate
        - Memory usage
        - Throttles
        - Cost estimation
        - Concurrent executions
        """
        try:
            lambda_client = self.get_client("lambda")
            cloudwatch = self.get_client("cloudwatch")
            logs = self.get_client("logs")

            # Get function configuration
            func = lambda_client.get_function(FunctionName=function_name)
            config = func["Configuration"]
            code = func.get("Code", {})

            # Get CloudWatch metrics (last 7 days for better Lambda insights)
            end_time = datetime.utcnow()
            start_time = end_time - timedelta(days=7)

            metrics = {}

            # Invocations
            try:
                invocations = cloudwatch.get_metric_statistics(
                    Namespace="AWS/Lambda",
                    MetricName="Invocations",
                    Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,  # Daily
                    Statistics=["Sum"],
                )
                total_invocations = sum([d["Sum"] for d in invocations["Datapoints"]])
                metrics["invocations"] = {
                    "total_7d": int(total_invocations),
                    "avg_per_day": int(total_invocations / 7) if total_invocations > 0 else 0,
                }
            except ClientError:
                metrics["invocations"] = {"total_7d": 0, "avg_per_day": 0}

            # Duration
            try:
                duration = cloudwatch.get_metric_statistics(
                    Namespace="AWS/Lambda",
                    MetricName="Duration",
                    Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Average", "Maximum"],
                )
                if duration["Datapoints"]:
                    metrics["duration"] = {
                        "avg_ms": round(sum([d["Average"] for d in duration["Datapoints"]]) / len(duration["Datapoints"]), 2),
                        "max_ms": round(max([d["Maximum"] for d in duration["Datapoints"]]), 2),
                    }
                else:
                    metrics["duration"] = {"avg_ms": 0, "max_ms": 0}
            except ClientError:
                metrics["duration"] = {"avg_ms": 0, "max_ms": 0}

            # Errors
            try:
                errors = cloudwatch.get_metric_statistics(
                    Namespace="AWS/Lambda",
                    MetricName="Errors",
                    Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum"],
                )
                total_errors = sum([d["Sum"] for d in errors["Datapoints"]])
                error_rate = (total_errors / total_invocations * 100) if total_invocations > 0 else 0
                metrics["errors"] = {
                    "total_7d": int(total_errors),
                    "error_rate_percent": round(error_rate, 2),
                }
            except ClientError:
                metrics["errors"] = {"total_7d": 0, "error_rate_percent": 0}

            # Throttles
            try:
                throttles = cloudwatch.get_metric_statistics(
                    Namespace="AWS/Lambda",
                    MetricName="Throttles",
                    Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum"],
                )
                total_throttles = sum([d["Sum"] for d in throttles["Datapoints"]])
                metrics["throttles"] = {"total_7d": int(total_throttles)}
            except ClientError:
                metrics["throttles"] = {"total_7d": 0}

            # Concurrent executions
            try:
                concurrent = cloudwatch.get_metric_statistics(
                    Namespace="AWS/Lambda",
                    MetricName="ConcurrentExecutions",
                    Dimensions=[{"Name": "FunctionName", "Value": function_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=3600,
                    Statistics=["Maximum"],
                )
                if concurrent["Datapoints"]:
                    metrics["concurrent_executions"] = {
                        "max_concurrent": int(max([d["Maximum"] for d in concurrent["Datapoints"]])),
                    }
                else:
                    metrics["concurrent_executions"] = {"max_concurrent": 0}
            except ClientError:
                metrics["concurrent_executions"] = {"max_concurrent": 0}

            # Cost estimation
            gb_seconds = (metrics["invocations"]["total_7d"] *
                         (metrics["duration"]["avg_ms"] / 1000) *
                         (config["MemorySize"] / 1024))

            # Lambda pricing: $0.0000166667 per GB-second, $0.20 per 1M requests
            compute_cost = gb_seconds * 0.0000166667
            request_cost = (metrics["invocations"]["total_7d"] / 1_000_000) * 0.20
            total_cost_7d = compute_cost + request_cost

            cost_estimate = {
                "cost_7d": round(total_cost_7d, 4),
                "cost_monthly_estimate": round(total_cost_7d * 4.3, 2),
                "gb_seconds_7d": round(gb_seconds, 2),
            }

            # Recent log streams
            log_group_name = f"/aws/lambda/{function_name}"
            recent_logs = []
            try:
                log_streams = logs.describe_log_streams(
                    logGroupName=log_group_name,
                    orderBy="LastEventTime",
                    descending=True,
                    limit=5,
                )
                for stream in log_streams.get("logStreams", []):
                    last_event = None
                    if "lastEventTime" in stream:
                        last_event = datetime.fromtimestamp(stream["lastEventTime"] / 1000).isoformat()
                    recent_logs.append({
                        "stream_name": stream["logStreamName"],
                        "last_event": last_event,
                        "stored_bytes": stream.get("storedBytes", 0),
                    })
            except ClientError:
                recent_logs = []

            return {
                "function_name": function_name,
                "function_arn": config["FunctionArn"],
                "runtime": config["Runtime"],
                "handler": config["Handler"],
                "code_size_bytes": config["CodeSize"],
                "code_size_mb": round(config["CodeSize"] / (1024**2), 2),
                "memory_mb": config["MemorySize"],
                "timeout_seconds": config["Timeout"],
                "last_modified": config["LastModified"],
                "role": config["Role"],
                "layers": len(config.get("Layers", [])),
                "environment_variables": len(config.get("Environment", {}).get("Variables", {})),
                "code_location": code.get("Location"),
                "repository_type": code.get("RepositoryType"),
                "metrics": metrics,
                "cost_estimate": cost_estimate,
                "recent_logs": recent_logs,
                "vpc_config": config.get("VpcConfig"),
                "architectures": config.get("Architectures", []),
                "ephemeral_storage_mb": config.get("EphemeralStorage", {}).get("Size", 512),
            }

        except ClientError as e:
            logger.error(f"Error analyzing Lambda function {function_name}: {e}")
            return {"error": str(e)}

    def analyze_s3_bucket(self, bucket_name: str) -> Dict[str, Any]:
        """
        Complete S3 bucket analysis:
        - Storage size and object count
        - Storage class breakdown
        - Cost estimation
        - Versioning status
        - Lifecycle policies
        - Public access analysis
        - Encryption details
        - Recent access patterns
        """
        try:
            s3 = self.get_client("s3")
            cloudwatch = self.get_client("cloudwatch")

            # Get bucket location
            try:
                location = s3.get_bucket_location(Bucket=bucket_name)
                bucket_region = location["LocationConstraint"] or "us-east-1"
            except:
                bucket_region = self.region

            # Get bucket size and object count from CloudWatch
            end_time = datetime.utcnow()
            start_time = end_time - timedelta(days=1)

            metrics = {}

            # Bucket size
            try:
                size_metrics = cloudwatch.get_metric_statistics(
                    Namespace="AWS/S3",
                    MetricName="BucketSizeBytes",
                    Dimensions=[
                        {"Name": "BucketName", "Value": bucket_name},
                        {"Name": "StorageType", "Value": "StandardStorage"}
                    ],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Average"],
                )
                if size_metrics["Datapoints"]:
                    size_bytes = size_metrics["Datapoints"][0]["Average"]
                    metrics["storage"] = {
                        "size_bytes": int(size_bytes),
                        "size_mb": round(size_bytes / (1024**2), 2),
                        "size_gb": round(size_bytes / (1024**3), 2),
                    }
                else:
                    metrics["storage"] = {"size_bytes": 0, "size_mb": 0, "size_gb": 0}
            except ClientError:
                metrics["storage"] = {"size_bytes": 0, "size_mb": 0, "size_gb": 0}

            # Number of objects
            try:
                object_metrics = cloudwatch.get_metric_statistics(
                    Namespace="AWS/S3",
                    MetricName="NumberOfObjects",
                    Dimensions=[
                        {"Name": "BucketName", "Value": bucket_name},
                        {"Name": "StorageType", "Value": "AllStorageTypes"}
                    ],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Average"],
                )
                if object_metrics["Datapoints"]:
                    metrics["objects"] = {
                        "count": int(object_metrics["Datapoints"][0]["Average"]),
                    }
                else:
                    metrics["objects"] = {"count": 0}
            except ClientError:
                metrics["objects"] = {"count": 0}

            # Versioning
            try:
                versioning = s3.get_bucket_versioning(Bucket=bucket_name)
                versioning_status = versioning.get("Status", "Disabled")
            except:
                versioning_status = "Unknown"

            # Encryption
            try:
                encryption = s3.get_bucket_encryption(Bucket=bucket_name)
                encryption_config = {
                    "enabled": True,
                    "rules": encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
                }
            except:
                encryption_config = {"enabled": False}

            # Public access block
            try:
                public_access = s3.get_public_access_block(Bucket=bucket_name)
                public_config = public_access.get("PublicAccessBlockConfiguration", {})
            except:
                public_config = {}

            # Lifecycle rules
            try:
                lifecycle = s3.get_bucket_lifecycle_configuration(Bucket=bucket_name)
                lifecycle_rules = len(lifecycle.get("Rules", []))
            except:
                lifecycle_rules = 0

            # Replication
            try:
                replication = s3.get_bucket_replication(Bucket=bucket_name)
                replication_enabled = True
                replication_rules = len(replication.get("ReplicationConfiguration", {}).get("Rules", []))
            except:
                replication_enabled = False
                replication_rules = 0

            # Cost estimation (S3 Standard storage: $0.023 per GB/month)
            storage_gb = metrics["storage"]["size_gb"]
            storage_cost_monthly = storage_gb * 0.023

            # Request costs (estimated based on typical usage)
            request_cost_monthly = 0.05  # Estimated

            cost_estimate = {
                "storage_cost_monthly": round(storage_cost_monthly, 2),
                "request_cost_monthly_estimate": request_cost_monthly,
                "total_monthly_estimate": round(storage_cost_monthly + request_cost_monthly, 2),
            }

            # Storage utilization
            avg_object_size_mb = (metrics["storage"]["size_mb"] / metrics["objects"]["count"]) if metrics["objects"]["count"] > 0 else 0

            return {
                "bucket_name": bucket_name,
                "region": bucket_region,
                "versioning": versioning_status,
                "encryption": encryption_config,
                "public_access_block": public_config,
                "lifecycle_rules": lifecycle_rules,
                "replication": {
                    "enabled": replication_enabled,
                    "rules": replication_rules,
                },
                "metrics": metrics,
                "utilization": {
                    "avg_object_size_mb": round(avg_object_size_mb, 3),
                    "storage_efficiency": "Good" if avg_object_size_mb > 0.1 else "Many small files",
                },
                "cost_estimate": cost_estimate,
                "security_score": self._calculate_s3_security_score(
                    encryption_config["enabled"],
                    versioning_status == "Enabled",
                    public_config
                ),
            }

        except ClientError as e:
            logger.error(f"Error analyzing S3 bucket {bucket_name}: {e}")
            return {"error": str(e)}

    def analyze_dynamodb_table(self, table_name: str) -> Dict[str, Any]:
        """
        Complete DynamoDB table analysis:
        - Item count and size
        - Read/Write capacity usage
        - Consumed capacity
        - Throttled requests
        - Cost estimation
        - GSI/LSI details
        - Performance metrics
        """
        try:
            dynamodb = self.get_client("dynamodb")
            cloudwatch = self.get_client("cloudwatch")

            # Get table details
            table = dynamodb.describe_table(TableName=table_name)["Table"]

            # CloudWatch metrics (last 7 days)
            end_time = datetime.utcnow()
            start_time = end_time - timedelta(days=7)

            metrics = {}

            # Consumed Read Capacity
            try:
                read_capacity = cloudwatch.get_metric_statistics(
                    Namespace="AWS/DynamoDB",
                    MetricName="ConsumedReadCapacityUnits",
                    Dimensions=[{"Name": "TableName", "Value": table_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum", "Average"],
                )
                if read_capacity["Datapoints"]:
                    metrics["read_capacity"] = {
                        "total_7d": sum([d["Sum"] for d in read_capacity["Datapoints"]]),
                        "avg_per_day": sum([d["Average"] for d in read_capacity["Datapoints"]]) / len(read_capacity["Datapoints"]),
                    }
                else:
                    metrics["read_capacity"] = {"total_7d": 0, "avg_per_day": 0}
            except ClientError:
                metrics["read_capacity"] = {"total_7d": 0, "avg_per_day": 0}

            # Consumed Write Capacity
            try:
                write_capacity = cloudwatch.get_metric_statistics(
                    Namespace="AWS/DynamoDB",
                    MetricName="ConsumedWriteCapacityUnits",
                    Dimensions=[{"Name": "TableName", "Value": table_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum", "Average"],
                )
                if write_capacity["Datapoints"]:
                    metrics["write_capacity"] = {
                        "total_7d": sum([d["Sum"] for d in write_capacity["Datapoints"]]),
                        "avg_per_day": sum([d["Average"] for d in write_capacity["Datapoints"]]) / len(write_capacity["Datapoints"]),
                    }
                else:
                    metrics["write_capacity"] = {"total_7d": 0, "avg_per_day": 0}
            except ClientError:
                metrics["write_capacity"] = {"total_7d": 0, "avg_per_day": 0}

            # Throttled Requests
            try:
                throttled_read = cloudwatch.get_metric_statistics(
                    Namespace="AWS/DynamoDB",
                    MetricName="ReadThrottleEvents",
                    Dimensions=[{"Name": "TableName", "Value": table_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum"],
                )
                throttled_write = cloudwatch.get_metric_statistics(
                    Namespace="AWS/DynamoDB",
                    MetricName="WriteThrottleEvents",
                    Dimensions=[{"Name": "TableName", "Value": table_name}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=86400,
                    Statistics=["Sum"],
                )
                metrics["throttles"] = {
                    "read_throttles_7d": sum([d["Sum"] for d in throttled_read["Datapoints"]]),
                    "write_throttles_7d": sum([d["Sum"] for d in throttled_write["Datapoints"]]),
                }
            except ClientError:
                metrics["throttles"] = {"read_throttles_7d": 0, "write_throttles_7d": 0}

            # Cost estimation (On-Demand pricing)
            # Read: $0.25 per million, Write: $1.25 per million
            read_cost = (metrics["read_capacity"]["total_7d"] / 1_000_000) * 0.25
            write_cost = (metrics["write_capacity"]["total_7d"] / 1_000_000) * 1.25
            storage_cost = (table["TableSizeBytes"] / (1024**3)) * 0.25  # $0.25 per GB/month

            cost_estimate = {
                "read_cost_7d": round(read_cost, 4),
                "write_cost_7d": round(write_cost, 4),
                "storage_cost_monthly": round(storage_cost, 2),
                "total_monthly_estimate": round((read_cost + write_cost) * 4.3 + storage_cost, 2),
            }

            # GSI/LSI details
            gsi_list = []
            for gsi in table.get("GlobalSecondaryIndexes", []):
                gsi_list.append({
                    "name": gsi["IndexName"],
                    "key_schema": gsi["KeySchema"],
                    "projection": gsi["Projection"]["ProjectionType"],
                    "status": gsi["IndexStatus"],
                    "size_bytes": gsi.get("IndexSizeBytes", 0),
                    "item_count": gsi.get("ItemCount", 0),
                })

            lsi_list = []
            for lsi in table.get("LocalSecondaryIndexes", []):
                lsi_list.append({
                    "name": lsi["IndexName"],
                    "key_schema": lsi["KeySchema"],
                    "projection": lsi["Projection"]["ProjectionType"],
                    "size_bytes": lsi.get("IndexSizeBytes", 0),
                    "item_count": lsi.get("ItemCount", 0),
                })

            return {
                "table_name": table_name,
                "table_arn": table["TableArn"],
                "table_id": table["TableId"],
                "status": table["TableStatus"],
                "creation_date": str(table["CreationDateTime"]),
                "item_count": table["ItemCount"],
                "size_bytes": table["TableSizeBytes"],
                "size_mb": round(table["TableSizeBytes"] / (1024**2), 2),
                "size_gb": round(table["TableSizeBytes"] / (1024**3), 2),
                "billing_mode": table.get("BillingModeSummary", {}).get("BillingMode", "PROVISIONED"),
                "key_schema": table["KeySchema"],
                "attribute_definitions": table["AttributeDefinitions"],
                "global_secondary_indexes": gsi_list,
                "local_secondary_indexes": lsi_list,
                "stream_specification": table.get("StreamSpecification"),
                "sse_description": table.get("SSEDescription"),
                "metrics": metrics,
                "cost_estimate": cost_estimate,
                "utilization": {
                    "avg_item_size_bytes": table["TableSizeBytes"] // table["ItemCount"] if table["ItemCount"] > 0 else 0,
                    "read_write_ratio": metrics["read_capacity"]["total_7d"] / metrics["write_capacity"]["total_7d"] if metrics["write_capacity"]["total_7d"] > 0 else 0,
                    "is_active": metrics["read_capacity"]["total_7d"] + metrics["write_capacity"]["total_7d"] > 0,
                },
            }

        except ClientError as e:
            logger.error(f"Error analyzing DynamoDB table {table_name}: {e}")
            return {"error": str(e)}

    def _estimate_ec2_cost(self, instance_type: str, state: str, volumes: List) -> Dict[str, Any]:
        """Estimate EC2 costs (simplified)"""
        # Simplified pricing (actual pricing varies by region)
        # This is a rough estimate - use AWS Cost Explorer for accurate costs

        base_costs = {
            "t2.micro": 0.0116,
            "t2.small": 0.023,
            "t2.medium": 0.0464,
            "t3.micro": 0.0104,
            "t3.small": 0.0208,
            "t3.medium": 0.0416,
            "c6a.xlarge": 0.153,  # Your instance type
        }

        hourly_rate = base_costs.get(instance_type, 0.10)  # Default rate

        if state == "stopped":
            compute_cost = 0
        else:
            compute_cost = hourly_rate * 24 * 30  # Monthly

        # EBS costs ($0.08 per GB-month for gp2)
        total_storage = sum([v["size_gb"] for v in volumes])
        storage_cost = total_storage * 0.08

        return {
            "compute_monthly": round(compute_cost, 2),
            "storage_monthly": round(storage_cost, 2),
            "total_monthly": round(compute_cost + storage_cost, 2),
            "note": "Estimated - use AWS Cost Explorer for accurate costs",
        }

    def _calculate_s3_security_score(self, encrypted: bool, versioned: bool, public_config: dict) -> Dict[str, Any]:
        """Calculate security score for S3 bucket"""
        score = 0
        max_score = 100
        issues = []

        # Encryption (30 points)
        if encrypted:
            score += 30
        else:
            issues.append("Encryption not enabled")

        # Versioning (20 points)
        if versioned:
            score += 20
        else:
            issues.append("Versioning not enabled")

        # Public access (50 points)
        if public_config.get("BlockPublicAcls", False):
            score += 15
        else:
            issues.append("Public ACLs not blocked")

        if public_config.get("BlockPublicPolicy", False):
            score += 15
        else:
            issues.append("Public policies not blocked")

        if public_config.get("IgnorePublicAcls", False):
            score += 10
        else:
            issues.append("Public ACLs not ignored")

        if public_config.get("RestrictPublicBuckets", False):
            score += 10
        else:
            issues.append("Public buckets not restricted")

        rating = "Excellent" if score >= 90 else "Good" if score >= 70 else "Fair" if score >= 50 else "Poor"

        return {
            "score": score,
            "max_score": max_score,
            "rating": rating,
            "issues": issues,
        }
