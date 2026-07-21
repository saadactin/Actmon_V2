"""Compliance Framework Mapping Service."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession
from app.services.security_service import run_security_scan

logger = logging.getLogger("cloud_svc.compliance")

async def generate_compliance_report(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    """Generates a compliance matrix by analyzing security findings."""
    security_data = await run_security_scan(account_id, db)
    findings = security_data.get("findings", [])
    
    # Base control mapping dictionaries
    frameworks = {
        "SOC2": {"total_controls": 15, "failed_controls": 0, "score": 100, "issues": []},
        "HIPAA": {"total_controls": 12, "failed_controls": 0, "score": 100, "issues": []},
        "PCI-DSS": {"total_controls": 10, "failed_controls": 0, "score": 100, "issues": []}
    }

    # Map findings to frameworks
    for finding in findings:
        title = finding.get("title", "")
        desc = finding.get("description", "")
        text_to_check = f"{title} {desc}"
        severity = finding.get("severity", "LOW")
        
        # Add affected_resource for the UI
        finding["rule"] = title
        finding["affected_resource"] = f"{finding.get('resource_type', 'Unknown')}: {finding.get('resource_name', 'Unnamed')}"
        
        # Determine framework overlap
        text_lower = text_to_check.lower()
        
        is_soc2 = any(k.lower() in text_lower for k in ["Security Group", "IAM", "Encryption", "S3", "Public", "Access", "Storage", "Network", "NSG", "VPC", "VCN"])
        is_hipaa = any(k.lower() in text_lower for k in ["Encryption", "Database", "S3", "KMS", "RDS", "Storage", "SQL", "TDE", "Data", "Cluster"])
        is_pci = any(k.lower() in text_lower for k in ["Security Group", "Port", "Public", "Encryption", "HTTP", "Inbound", "IP", "Ingress", "Network", "NSG"])
        
        if is_soc2:
            frameworks["SOC2"]["failed_controls"] += 1
            frameworks["SOC2"]["issues"].append(finding)
        if is_hipaa:
            frameworks["HIPAA"]["failed_controls"] += 1
            frameworks["HIPAA"]["issues"].append(finding)
        if is_pci:
            frameworks["PCI-DSS"]["failed_controls"] += 1
            frameworks["PCI-DSS"]["issues"].append(finding)

    # Calculate scores
    for fw, data in frameworks.items():
        penalty = sum(25 if f.get("severity") == "CRITICAL" else 15 if f.get("severity") == "HIGH" else 5 for f in data["issues"])
        data["score"] = max(0, 100 - penalty)
        
    return {
        "account_id": str(account_id),
        "overall_compliance_score": int((frameworks["SOC2"]["score"] + frameworks["HIPAA"]["score"] + frameworks["PCI-DSS"]["score"]) / 3),
        "frameworks": frameworks
    }
