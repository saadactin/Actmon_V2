"""Compliance framework mapping service.

Maps ACTMON's real security findings onto compliance frameworks via an
explicit category/keyword table. It does NOT run a certified framework
assessment, so control totals and percentage scores are returned as None
(the UI shows NA) — a real score requires provider compliance APIs
(AWS Security Hub standards, Azure Defender regulatory compliance,
OCI Cloud Guard). Only the mapped findings themselves are real data.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession
from app.services.security_service import run_security_scan

logger = logging.getLogger("cloud_svc.compliance")

# Explicit finding-category → framework mapping. A finding maps to a framework
# only if its category is listed — no fuzzy text matching.
_FRAMEWORK_CATEGORIES: Dict[str, set] = {
    "SOC2": {"Networking", "Security", "Identity & Access", "Encryption", "Governance"},
    "HIPAA": {"Encryption", "Security"},
    "PCI-DSS": {"Networking", "Encryption", "Security"},
}


async def generate_compliance_report(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    """Group real security findings by compliance framework."""
    security_data = await run_security_scan(account_id, db)
    findings = security_data.get("findings", [])

    frameworks: Dict[str, Dict[str, Any]] = {
        name: {
            # No certified control catalog is evaluated — totals/scores are NA
            "total_controls": None,
            "failed_controls": None,
            "score": None,
            "related_findings": 0,
            "issues": [],
        }
        for name in _FRAMEWORK_CATEGORIES
    }

    for finding in findings:
        finding["rule"] = finding.get("title", "")
        finding["affected_resource"] = (
            f"{finding.get('resource_type', 'Unknown')}: {finding.get('resource_name', 'Unnamed')}"
        )
        category = finding.get("category", "")
        for fw_name, categories in _FRAMEWORK_CATEGORIES.items():
            if category in categories:
                frameworks[fw_name]["related_findings"] += 1
                frameworks[fw_name]["issues"].append(finding)

    return {
        "account_id": str(account_id),
        # A real percentage requires a certified assessment — NA until one is wired up
        "overall_compliance_score": None,
        "frameworks": frameworks,
        "note": (
            "Findings are real results from the security scan, grouped by framework "
            "relevance. Control totals and compliance scores require a certified "
            "assessment (AWS Security Hub / Azure Defender / OCI Cloud Guard) and are "
            "shown as NA until such an integration is connected."
        ),
    }
