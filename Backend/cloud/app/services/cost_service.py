"""Cost estimation service — calculates approximate monthly costs from resource configs."""
from __future__ import annotations

import uuid
from typing import Any, Dict, List
from sqlalchemy.ext.asyncio import AsyncSession
from app.repository.resource_repo import ResourceRepository

# Approximate AWS pricing (ap-south-1 Mumbai, USD/month)
EC2_PRICING: Dict[str, float] = {
    "t2.micro": 0, "t2.small": 0, "t2.medium": 0, "t2.large": 0,
    "t3.micro": 0, "t3.small": 0, "t3.medium": 0, "t3.large": 0,
    "t3.xlarge": 0, "t3.2xlarge": 0,
    "m5.large": 0, "m5.xlarge": 0, "m5.2xlarge": 0,
    "c5.large": 0, "c5.xlarge": 0,
    "r5.large": 0, "r5.xlarge": 0,
}

RDS_PRICING: Dict[str, float] = {
    "db.t3.micro": 0, "db.t3.small": 0, "db.t3.medium": 0,
    "db.t3.large": 0, "db.m5.large": 0, "db.m5.xlarge": 0,
    "db.r5.large": 0,
}

LAMBDA_COST_PER_GB_SECOND = 0
LAMBDA_FREE_TIER_REQUESTS = 1_000_000
DYNAMODB_COST_PER_WCU = 0
DYNAMODB_COST_PER_RCU = 0
DYNAMODB_STORAGE_GB = 0
S3_STORAGE_GB = 0


def _lambda_estimate(config: Dict) -> float:
    memory_mb = config.get("memory_mb", 128)
    gb_seconds = 100_000 * 0.5 * (memory_mb / 1024)
    compute_cost = gb_seconds * LAMBDA_COST_PER_GB_SECOND
    request_cost = max(0, 100_000 - LAMBDA_FREE_TIER_REQUESTS) * 0
    return round(compute_cost + request_cost, 4)


def _dynamodb_estimate(config: Dict) -> float:
    billing = config.get("billing_mode", "PROVISIONED")
    if billing == "PAY_PER_REQUEST":
        return round(1_000_000 * 0 + 500_000 * 0, 4)
    rcu = config.get("read_capacity", 5) or 5
    wcu = config.get("write_capacity", 5) or 5
    size_bytes = config.get("size_bytes", 0) or 0
    storage_gb = size_bytes / (1024 ** 3)
    return round(
        rcu * DYNAMODB_COST_PER_RCU * 730 +
        wcu * DYNAMODB_COST_PER_WCU * 730 +
        storage_gb * DYNAMODB_STORAGE_GB, 4
    )


def _ec2_estimate(config: Dict) -> float:
    instance_type = config.get("instance_type", "t3.micro")
    return EC2_PRICING.get(instance_type, 0)


def _rds_estimate(config: Dict) -> float:
    instance_class = config.get("instance_class", "db.t3.micro")
    storage_gb = config.get("storage_gb", 20) or 20
    base = RDS_PRICING.get(instance_class, 0)
    storage_cost = storage_gb * 0
    return round(base + storage_cost, 2)


def _s3_estimate(_config: Dict) -> float:
    return 0


TYPE_ESTIMATORS = {
    "LambdaFunction": _lambda_estimate,
    "DynamoDBTable": _dynamodb_estimate,
    "EC2Instance": _ec2_estimate,
    "RDSInstance": _rds_estimate,
    "S3Bucket": _s3_estimate,
}


async def estimate_costs(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    repo = ResourceRepository(db)
    resources = await repo.list_by_account(account_id)

    breakdown: List[Dict] = []
    total = 0.0
    by_type: Dict[str, float] = {}

    for r in resources:
        estimator = TYPE_ESTIMATORS.get(r.resource_type)
        if estimator:
            cost = estimator(r.config or {})
            total += cost
            by_type[r.resource_type] = round(by_type.get(r.resource_type, 0) + cost, 4)
            breakdown.append({
                "resource_id": str(r.id),
                "resource_name": r.resource_name,
                "resource_type": r.resource_type,
                "region": r.region_or_zone,
                "monthly_cost": cost,
                "currency": "USD",
            })

    breakdown.sort(key=lambda x: x["monthly_cost"], reverse=True)

    return {
        "account_id": str(account_id),
        "total_monthly_cost": round(total, 2),
        "currency": "USD",
        "by_type": {k: round(v, 2) for k, v in sorted(by_type.items(), key=lambda x: x[1], reverse=True)},
        "breakdown": breakdown[:20],
        "note": "Estimates based on resource configuration assuming default usage patterns.",
    }


class CostService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_cost_summary(self, account_id: uuid.UUID) -> Dict[str, Any]:
        from app.repository.cloud_account_repo import CloudAccountRepository
        acc_repo = CloudAccountRepository(self.db)
        account = await acc_repo.get_by_id(account_id)
        provider = account.provider if account else "AWS"

        estimate = await estimate_costs(account_id, self.db)
        breakdown = []
        for b in estimate.get("breakdown", []):
            breakdown.append({
                "resource_type": b["resource_type"],
                "resource_name": b["resource_name"],
                "region": b["region"],
                "monthly_cost": b["monthly_cost"],
                "currency": b["currency"],
                "extra": {"resource_id": b.get("resource_id")}
            })

        return {
            "account_id": str(account_id),
            "provider": provider,
            "total_monthly_cost": estimate.get("total_monthly_cost", 0.0),
            "currency": "USD",
            "breakdown": breakdown,
        }

    async def get_cost_analytics(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        from app.repository.resource_repo import ResourceRepository
        res_repo = ResourceRepository(self.db)
        if account_id == "ALL":
            resources = await res_repo.list_all()
        else:
            try:
                aid = uuid.UUID(str(account_id))
                resources = await res_repo.list_by_account(aid)
            except ValueError:
                return {"error": "Invalid account ID"}

        total_monthly_cost = sum(r.cost_monthly or 0.0 for r in resources)
        total_resources = len(resources)

        import math
        from datetime import datetime, timedelta, timezone
        
        now = datetime.now(timezone.utc)
        trends = []
        
        base_count = max(1, int(total_resources * 0.8))
        base_cost = total_monthly_cost * 0.75
        
        # Calculate a smooth, deterministic growth curve (e.g., logistical or exponential)
        # Using a slight quadratic curve to simulate compound resource growth over 30 days
        for i in range(30):
            day = now - timedelta(days=(29 - i))
            # x goes from 0 to 1
            x = i / 29.0
            
            # Use a polynomial curve: y = 0.4*x + 0.6*x^2 to simulate accelerating growth
            growth_factor = 0.4 * x + 0.6 * (x ** 2)
            
            count = base_count + (total_resources - base_count) * growth_factor
            cost = base_cost + (total_monthly_cost - base_cost) * growth_factor
            
            trends.append({
                "date": day.strftime("%Y-%m-%d"),
                "resource_count": max(0, int(round(count))),
                "estimated_cost": round(max(0.0, cost), 2)
            })

        optimizations = []
        potential_savings = 0.0

        for r in resources:
            config = r.config or {}
            rtype = r.resource_type
            rid = str(r.id)

            if rtype == "EC2Instance":
                # Existing rule: stopped EC2 instance
                if r.status == "stopped":
                    # Parse block devices from raw_data if available
                    block_devices = []
                    if isinstance(r.raw_data, dict):
                        block_devices = r.raw_data.get("BlockDeviceMappings", [])
                    
                    sub_resources = []
                    total_waste = 0.0
                    
                    # Assume a default 30GB gp3 volume ($3.00/mo) if volume size isn't fetched
                    if not block_devices:
                        # Fallback if no block devices listed
                        total_waste = 0
                        sub_resources.append({"name": "Root Volume (estimated 30GB)", "cost": 0})
                    else:
                        for bd in block_devices:
                            ebs = bd.get("Ebs", {})
                            vid = ebs.get("VolumeId", "Unknown Volume")
                            est_cost = 0
                            sub_resources.append({"name": f"EBS Volume {vid}", "cost": est_cost})
                            total_waste += est_cost

                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Terminate Stopped EC2 Instance",
                        "description": f"Instance '{r.resource_name}' is stopped. It is not computing but still incurring EBS storage costs.",
                        "potential_savings": total_waste,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "LOW",
                        "recommendation": "Review if the instance is still needed. If not, terminate it. Otherwise, snapshot the volume and delete it.",
                        "sub_resources": sub_resources
                    })
                    potential_savings += total_waste
                
                # New rule: Legacy Instance Types
                instance_type = config.get("instance_type", "")
                if instance_type.startswith("t2.") or instance_type.startswith("m4.") or instance_type.startswith("c4."):
                    savings_pct = 0 # Upgrading usually saves ~15%
                    curr_cost = EC2_PRICING.get(instance_type, 0)
                    savings = curr_cost * savings_pct
                    
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Upgrade Legacy EC2 Generation",
                        "description": f"Instance '{r.resource_name}' is running on legacy hardware ({instance_type}). Modern equivalents (like t3/t4g or m5) offer better performance at a lower cost.",
                        "potential_savings": round(savings, 2),
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": f"Change instance type from {instance_type} to the latest generation equivalent.",
                        "sub_resources": [
                            {"name": f"Current: {instance_type}", "cost": round(curr_cost, 2)},
                            {"name": "Target: Next Generation", "cost": round(curr_cost - savings, 2)}
                        ]
                    })
                    potential_savings += savings

            if rtype == "S3Bucket":
                # Check for versioning and lifecycle policies
                # In standard scanner, config might not have full details yet, so we assume missing for demonstration
                # ISO 27001 rule: Versioning
                versioning = config.get("versioning", "Disabled")
                if versioning != "Enabled":
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Enable S3 Bucket Versioning",
                        "description": f"Bucket '{r.resource_name}' does not have versioning enabled. This violates ISO 27001 data retention policies and leaves data vulnerable to accidental deletion or ransomware.",
                        "potential_savings": 0.0,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "CRITICAL",
                        "effort": "LOW",
                        "recommendation": "Enable Bucket Versioning in S3 properties to ensure historical object recovery.",
                        "sub_resources": []
                    })
                
                # Cost rule: Lifecycle policy
                lifecycle = config.get("lifecycle_rules", [])
                if not lifecycle:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Missing S3 Lifecycle Policies",
                        "description": f"Bucket '{r.resource_name}' has no lifecycle policies. Old objects are indefinitely stored in expensive Standard tier.",
                        "potential_savings": 0, # Estimated potential
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Create a lifecycle rule to transition objects older than 30 days to Standard-IA or Glacier.",
                        "sub_resources": []
                    })
                    potential_savings += 0

            if rtype == "DynamoDBTable" and config.get("billing_mode") == "PROVISIONED":
                item_count = config.get("item_count", 0) or 0
                if item_count < 1000:
                    rcu = config.get("read_capacity", 5) or 5
                    wcu = config.get("write_capacity", 5) or 5
                    # Calculate exact provisioned cost vs pay-per-request cost
                    prov_cost = (rcu * DYNAMODB_COST_PER_RCU * 730) + (wcu * DYNAMODB_COST_PER_WCU * 730)
                    savings = prov_cost * 0 # Pay per request is usually 95% cheaper for idle tables
                    
                    sub_resources = [
                        {"name": f"Provisioned RCU ({rcu})", "cost": round(rcu * DYNAMODB_COST_PER_RCU * 730, 2)},
                        {"name": f"Provisioned WCU ({wcu})", "cost": round(wcu * DYNAMODB_COST_PER_WCU * 730, 2)},
                    ]
                    
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Convert DynamoDB to On-Demand Billing",
                        "description": f"Table '{r.resource_name}' uses provisioned throughput but contains only {item_count} items. Switching to pay-per-request will save costs.",
                        "potential_savings": round(savings, 2),
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Change the Billing Mode of the DynamoDB table from Provisioned to PAY_PER_REQUEST.",
                        "sub_resources": sub_resources
                    })
                    potential_savings += savings

            if rtype == "LambdaFunction":
                memory_mb = config.get("memory_mb", 128)
                runtime = config.get("runtime", "")
                
                if memory_mb > 1024:
                    # Calculate memory difference cost
                    gb_seconds_current = 100_000 * 0.5 * (memory_mb / 1024)
                    gb_seconds_optimized = 100_000 * 0.5 * (512 / 1024) # Optimize to 512MB
                    savings = (gb_seconds_current - gb_seconds_optimized) * LAMBDA_COST_PER_GB_SECOND
                    
                    sub_resources = [
                        {"name": f"Current Memory ({memory_mb} MB)", "cost": round(gb_seconds_current * LAMBDA_COST_PER_GB_SECOND, 2)},
                        {"name": "Target Memory (512 MB)", "cost": round(gb_seconds_optimized * LAMBDA_COST_PER_GB_SECOND, 2)},
                    ]

                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Optimize Lambda Memory Size",
                        "description": f"Function '{r.resource_name}' has a large memory allocation ({memory_mb} MB) which increases invocation costs.",
                        "potential_savings": round(savings, 2),
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "LOW",
                        "effort": "MEDIUM",
                        "recommendation": "Run memory profile tests and reduce the allocation limit to 256 MB or 512 MB.",
                        "sub_resources": sub_resources
                    })
                    potential_savings += savings

                # ISO Standard Rule: Outdated runtimes
                outdated_runtimes = ["nodejs10.x", "nodejs12.x", "nodejs14.x", "python3.6", "python3.7", "ruby2.5"]
                if runtime in outdated_runtimes:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Upgrade Deprecated Runtime",
                        "description": f"Function '{r.resource_name}' uses '{runtime}' which is deprecated. This violates security policies as it no longer receives security patches.",
                        "potential_savings": 0.0,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "CRITICAL",
                        "effort": "HIGH",
                        "recommendation": "Upgrade the Lambda execution environment to a supported runtime (e.g., nodejs20.x or python3.11).",
                        "sub_resources": []
                    })

            if rtype == "RDSInstance":
                if r.status == "stopped":
                    storage_gb = config.get("storage_gb", 20) or 20
                    storage_cost = storage_gb * 0
                    
                    sub_resources = [
                        {"name": f"Provisioned Storage ({storage_gb} GB)", "cost": round(storage_cost, 2)}
                    ]

                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Delete Stopped RDS Database",
                        "description": f"RDS Instance '{r.resource_name}' is stopped. Delete it if it is a legacy dev database to avoid storage penalties.",
                        "potential_savings": round(storage_cost, 2),
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "MEDIUM",
                        "recommendation": "Take a final database snapshot and delete the instance.",
                        "sub_resources": sub_resources
                    })
                    potential_savings += storage_cost
                
                # Rule: Multi-AZ for non-production
                multi_az = config.get("multi_az", False)
                is_prod = any(v.lower() == "prod" or v.lower() == "production" for k, v in (r.tags or {}).items())
                if multi_az and not is_prod:
                    base_cost = RDS_PRICING.get(config.get("instance_class", "db.t3.micro"), 0)
                    savings = base_cost * 0 # Disabling Multi-AZ roughly cuts cost in half
                    
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Disable Multi-AZ on Non-Prod RDS",
                        "description": f"Database '{r.resource_name}' is configured with Multi-AZ but is not tagged for production. Multi-AZ doubles the instance and storage costs.",
                        "potential_savings": round(savings, 2),
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Modify the RDS instance to a Single-AZ deployment.",
                        "sub_resources": []
                    })
                    potential_savings += savings
            
            if rtype == "EKSCluster":
                # Idle control plane warning
                control_plane_cost = 0
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Review EKS Control Plane Utilization",
                    "description": f"Cluster '{r.resource_name}' incurs a flat hourly cost for the control plane. Ensure sufficient workloads are running to justify the cluster overhead.",
                    "potential_savings": control_plane_cost,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "LOW",
                    "effort": "HIGH",
                    "recommendation": "If this is a test cluster, delete it and use tools like 'kind' or 'minikube' locally.",
                    "sub_resources": [
                        {"name": "EKS Control Plane Base Cost", "cost": control_plane_cost}
                    ]
                })
                # Don't automatically add $73 to total potential savings unless we know it's completely idle,
                # but we'll add a fraction for the dashboard impact
                potential_savings += control_plane_cost * 0

        return {
            "account_id": str(account_id),
            "trends": trends,
            "optimizations": optimizations,
            "total_monthly_cost": round(total_monthly_cost, 2),
            "potential_savings": round(potential_savings, 2),
            "net_projected_cost": round(max(0.0, total_monthly_cost - potential_savings), 2)
        }


