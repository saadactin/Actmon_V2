"""Security posture scanner — checks AWS, Azure, and OCI resources for security risks."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from app.repository.resource_repo import ResourceRepository

logger = logging.getLogger("cloud_svc.security")

SEVERITY_CRITICAL = "CRITICAL"
SEVERITY_HIGH = "HIGH"
SEVERITY_MEDIUM = "MEDIUM"
SEVERITY_LOW = "LOW"
SEVERITY_INFO = "INFO"


def _score(findings: List[Dict]) -> int:
    """Return 0-100 security score (100 = perfect)."""
    if not findings:
        return 100
    weights = {SEVERITY_CRITICAL: 25, SEVERITY_HIGH: 15, SEVERITY_MEDIUM: 8, SEVERITY_LOW: 3, SEVERITY_INFO: 1}
    penalty = sum(weights.get(f["severity"], 0) for f in findings)
    return max(0, 100 - penalty)


async def run_security_scan(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    """Analyze stored resources for security issues. Returns findings + score."""
    repo = ResourceRepository(db)
    resources = await repo.list_by_account(account_id)

    findings: List[Dict[str, Any]] = []

    for r in resources:
        rtype = r.resource_type
        config = r.config or {}
        tags = r.tags or {}
        name = r.resource_name
        rid = str(r.id)

        # ── Security Group checks ────────────────────────────────────
        if rtype == "SecurityGroup":
            desc = config.get("description", "")
            inbound = config.get("inbound_rules", 0)
            # Flag default SG or ones with many inbound rules
            if name == "default":
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_MEDIUM,
                    "title": "Default Security Group in Use",
                    "description": "The default VPC security group is being used. It's best practice to create purpose-specific security groups.",
                    "recommendation": "Create dedicated security groups for each application tier.",
                    "category": "Networking",
                })
            if inbound >= 3:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "Security Group Has Multiple Inbound Rules",
                    "description": f"Security group '{name}' has {inbound} inbound rules which may include overly permissive access.",
                    "recommendation": "Review and restrict inbound rules to minimum required ports and CIDR ranges.",
                    "category": "Networking",
                })
            
            # Check for open SSH
            raw_sg = r.raw_data or {}
            ip_permissions = raw_sg.get("IpPermissions", [])
            for perm in ip_permissions:
                from_port = perm.get("FromPort")
                to_port = perm.get("ToPort")
                ip_ranges = perm.get("IpRanges", [])
                
                if from_port is not None and to_port is not None:
                    if from_port <= 22 <= to_port:
                        # Check if it's open to the world
                        if any(ip_range.get("CidrIp") == "0.0.0.0/0" for ip_range in ip_ranges):
                            findings.append({
                                "resource_id": rid,
                                "resource_name": name,
                                "resource_type": rtype,
                                "severity": SEVERITY_CRITICAL,
                                "title": "Security Group Allows Public SSH (Port 22)",
                                "description": f"Security group '{name}' allows inbound SSH access from 0.0.0.0/0.",
                                "recommendation": "Remove the 0.0.0.0/0 rule and restrict SSH access to known IP addresses.",
                                "category": "Networking",
                            })
                            break

        # ── RDS Instance checks ──────────────────────────────────────
        if rtype == "RDSInstance":
            encrypted = config.get("storage_encrypted", False)
            if not encrypted:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "Database Encryption at Rest Disabled",
                    "description": f"RDS Instance '{name}' does not have storage encryption enabled.",
                    "recommendation": "Enable storage encryption using AWS KMS to protect data at rest.",
                    "category": "Encryption",
                })

        # ── S3 Bucket checks ─────────────────────────────────────────
        if rtype == "S3Bucket":
            pab = config.get("public_access_block")
            if not pab or not pab.get("BlockPublicAcls") or not pab.get("BlockPublicPolicy"):
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_CRITICAL,
                    "title": "S3 Bucket Public Access Not Blocked",
                    "description": f"S3 Bucket '{name}' is missing Public Access Block configuration or has it disabled.",
                    "recommendation": "Enable 'Block all public access' at the bucket or account level.",
                    "category": "Security",
                })

        # ── IAM Role checks ──────────────────────────────────────────
        if rtype == "IAMRole":
            path = config.get("path", "/")
            max_session = config.get("max_session_duration", 3600)
            if max_session and max_session > 43200:  # > 12 hours
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_MEDIUM,
                    "title": "IAM Role Has Long Session Duration",
                    "description": f"Role '{name}' allows sessions up to {max_session // 3600}h. Long sessions increase risk of credential exposure.",
                    "recommendation": "Reduce max session duration to 1-4 hours for interactive roles.",
                    "category": "Identity & Access",
                })

        # ── Untagged resource check (all types) ──────────────────────
        if rtype not in ("SecurityGroup", "VPC", "IAMRole"):
            missing_tags = []
            for required in ["Name", "Environment", "Owner"]:
                if required not in tags and required.lower() not in {k.lower() for k in tags}:
                    missing_tags.append(required)
            if missing_tags:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_LOW,
                    "title": "Resource Missing Mandatory Tags",
                    "description": f"'{name}' is missing tags: {', '.join(missing_tags)}. Untagged resources are hard to track for cost and ownership.",
                    "recommendation": f"Add tags: {', '.join(missing_tags)} to this resource.",
                    "category": "Governance",
                })

        # ── DynamoDB encryption check ────────────────────────────────
        if rtype == "DynamoDBTable":
            # All DynamoDB tables are encrypted by default in AWS — flag as info
            findings.append({
                "resource_id": rid,
                "resource_name": name,
                "resource_type": rtype,
                "severity": SEVERITY_INFO,
                "title": "DynamoDB Table Uses AWS-Managed Encryption",
                "description": f"Table '{name}' uses AWS-managed encryption (SSE). Consider customer-managed KMS keys for stricter control.",
                "recommendation": "Enable customer-managed KMS key for sensitive data tables.",
                "category": "Encryption",
            })

        # ── Lambda function checks ───────────────────────────────────
        if rtype == "LambdaFunction":
            runtime = config.get("runtime", "")
            deprecated = ["python3.7", "python3.6", "nodejs12.x", "nodejs10.x", "ruby2.5"]
            if any(d in (runtime or "").lower() for d in deprecated):
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "Lambda Using Deprecated Runtime",
                    "description": f"Function '{name}' uses runtime '{runtime}' which is deprecated or end-of-life.",
                    "recommendation": "Upgrade to a supported runtime (python3.11, nodejs20.x, etc.).",
                    "category": "Maintenance",
                })
            memory = config.get("memory_mb", 128)
            if memory and memory < 256:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_INFO,
                    "title": "Lambda Function Has Low Memory Allocation",
                    "description": f"Function '{name}' has only {memory}MB memory which may cause performance issues.",
                    "recommendation": "Consider allocating at least 256MB for better performance and lower latency.",
                    "category": "Performance",
                })

        # ── EC2/Azure Virtual Machine instance checks ─────────────────────────────────────
        if rtype in ("EC2Instance", "VirtualMachine"):
            status = (r.status or "").lower()
            if status in ("stopped", "deallocated"):
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_MEDIUM,
                    "title": f"{rtype} is Stopped/Deallocated",
                    "description": f"Instance '{name}' is stopped but still incurring disk storage costs.",
                    "recommendation": "Terminate unused instances or create an image and terminate to save costs.",
                    "category": "Cost",
                })
            # Public IP check
            ip = r.ip_address or ""
            if ip and not ip.startswith("172.") and not ip.startswith("10.") and not ip.startswith("192.168."):
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": f"{rtype} Has Public IP Address",
                    "description": f"Instance '{name}' ({ip}) is directly reachable from the internet.",
                    "recommendation": "Use a load balancer or NAT gateway instead of a public IP for backend services.",
                    "category": "Networking",
                })

        # ── Azure Storage Account checks ──────────────────────────────
        if rtype == "StorageAccount":
            findings.append({
                "resource_id": rid,
                "resource_name": name,
                "resource_type": rtype,
                "severity": SEVERITY_MEDIUM,
                "title": "Storage Account Public Access Review",
                "description": f"Storage Account '{name}' should be reviewed to ensure 'allowBlobPublicAccess' is disabled if not serving public web content.",
                "recommendation": "Disable public blob access at the account level if not required.",
                "category": "Security",
            })

        # ── Azure SQL checks ──────────────────────────────────────────
        if rtype == "SQLDatabase":
            findings.append({
                "resource_id": rid,
                "resource_name": name,
                "resource_type": rtype,
                "severity": SEVERITY_MEDIUM,
                "title": "Azure SQL Transparent Data Encryption (TDE)",
                "description": f"Ensure Transparent Data Encryption (TDE) is active for database '{name}'.",
                "recommendation": "Verify TDE is enabled in Azure Portal or via Azure CLI to encrypt data at rest.",
                "category": "Encryption",
            })

        # ── OCI Compute Instance checks ───────────────────────────────
        if rtype == "ComputeInstance":
            status = (r.status or "").lower()
            ip = r.ip_address or ""
            if ip and not ip.startswith("172.") and not ip.startswith("10.") and not ip.startswith("192.168."):
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "OCI Compute Instance Has Public IP",
                    "description": f"Instance '{name}' ({ip}) is directly reachable from the internet.",
                    "recommendation": "Use OCI Load Balancer or NAT Gateway instead of direct public IP for backend instances.",
                    "category": "Networking",
                })
            shape = config.get("shape", "")
            ocpus = config.get("ocpus") or 0
            if ocpus and ocpus >= 16:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_INFO,
                    "title": "Large OCI Compute Instance — Review Sizing",
                    "description": f"Instance '{name}' uses {ocpus} OCPUs ({shape}). Verify this is appropriately sized.",
                    "recommendation": "Review CPU utilisation metrics and right-size if consistently below 30%.",
                    "category": "Cost",
                })

        # ── OCI NSG (Network Security Group) checks ───────────────────
        if rtype == "NetworkSecurityGroup":
            ingress = config.get("ingress_rules", 0)
            if ingress >= 5:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "OCI NSG Has Many Ingress Rules",
                    "description": f"NSG '{name}' has {ingress} ingress rules — review for overly permissive access.",
                    "recommendation": "Restrict ingress rules to minimum required ports and trusted CIDR ranges only.",
                    "category": "Networking",
                })

        # ── OCI OKE Cluster checks ─────────────────────────────────────
        if rtype == "OKECluster":
            version = config.get("kubernetes_version", "")
            is_public = config.get("endpoint_config", {}).get("is_public_ip_enabled", True)
            if is_public:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_HIGH,
                    "title": "OKE Cluster API Endpoint Is Public",
                    "description": f"OKE cluster '{name}' has a publicly accessible API endpoint.",
                    "recommendation": "Restrict the Kubernetes API server to private endpoint only and use OCI Bastion for access.",
                    "category": "Networking",
                })

        # ── OCI Function checks ───────────────────────────────────────
        if rtype == "Function":
            memory = config.get("memory_in_mbs", 128)
            timeout = config.get("timeout_in_seconds", 30)
            if timeout and timeout > 300:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_MEDIUM,
                    "title": "OCI Function Has Long Timeout",
                    "description": f"Function '{name}' has a {timeout}s timeout. Long timeouts can mask performance issues.",
                    "recommendation": "Set function timeout to the minimum needed plus a small buffer.",
                    "category": "Performance",
                })

        # ── OCI Object Storage checks ──────────────────────────────────
        if rtype == "ObjectStorageBucket":
            storage_tier = config.get("storage_tier", "Standard")
            findings.append({
                "resource_id": rid,
                "resource_name": name,
                "resource_type": rtype,
                "severity": SEVERITY_MEDIUM,
                "title": "OCI Bucket Public Access Review",
                "description": f"Bucket '{name}' should be reviewed for public access settings and pre-authenticated requests.",
                "recommendation": "Audit bucket visibility and remove any pre-authenticated requests that are no longer needed.",
                "category": "Security",
            })

        # ── OCI Autonomous Database checks ────────────────────────────
        if rtype == "AutonomousDatabase":
            auto_scale = config.get("is_auto_scaling_enabled", False)
            if not auto_scale:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_LOW,
                    "title": "Autonomous Database Auto-Scaling Disabled",
                    "description": f"ADB '{name}' has auto-scaling disabled. It may be unable to handle traffic spikes.",
                    "recommendation": "Enable auto-scaling to allow the database to handle variable workloads efficiently.",
                    "category": "Performance",
                })

        # ── OCI IAM Policy checks ─────────────────────────────────────
        if rtype == "IAMPolicy":
            statements = config.get("statements", [])
            admin_stmts = [s for s in statements if "manage all-resources" in s.lower() or "allow any-user" in s.lower()]
            if admin_stmts:
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_CRITICAL,
                    "title": "OCI IAM Policy Grants Broad Admin Access",
                    "description": f"Policy '{name}' contains overly broad statements: {admin_stmts[:2]}.",
                    "recommendation": "Replace with least-privilege policies scoped to specific compartments and resource types.",
                    "category": "Identity & Access",
                })

        # ── OCI API Gateway checks ────────────────────────────────────
        if rtype == "APIGateway":
            endpoint_type = config.get("endpoint_type", "PUBLIC")
            if endpoint_type == "PUBLIC":
                findings.append({
                    "resource_id": rid,
                    "resource_name": name,
                    "resource_type": rtype,
                    "severity": SEVERITY_MEDIUM,
                    "title": "OCI API Gateway Is Publicly Accessible",
                    "description": f"API Gateway '{name}' is publicly accessible. Ensure authentication is enforced on all deployments.",
                    "recommendation": "Attach authorizers (JWT/OAuth2) to all API deployments and restrict to known consumers.",
                    "category": "Security",
                })

    # Group by category and severity
    by_category: Dict[str, int] = {}
    by_severity: Dict[str, int] = {}
    for f in findings:
        by_category[f["category"]] = by_category.get(f["category"], 0) + 1
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1

    score = _score(findings)
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 40 else "F"

    return {
        "account_id": str(account_id),
        "score": score,
        "grade": grade,
        "total_resources_scanned": len(resources),
        "total_findings": len(findings),
        "by_severity": by_severity,
        "by_category": by_category,
        "findings": findings,
    }
