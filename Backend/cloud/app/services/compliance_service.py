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

# Finding category → the specific control each framework raises for it.
#
# Mapping at framework level alone was useless: the same categories belong to
# SOC2, HIPAA and PCI-DSS, so all three panels rendered an identical list. What
# actually differs between frameworks is WHICH CONTROL a finding violates, so
# the mapping carries control references and a violation is reported once with
# its per-framework citations.
#
# References are informative cross-walks to the published control text (SOC2
# TSC 2017, HIPAA Security Rule 45 CFR §164, PCI-DSS v4.0) — useful for pointing
# an auditor at the right clause. They are NOT a certified assessment; a
# framework absent from a category simply has no applicable control here.
#
# "Governance" (missing-tags), "Performance" and "Cost" are deliberately absent:
# they fire once per resource — 228 of 236 findings on a real tenancy — and are
# cost/ownership hygiene, not control violations.
_CONTROL_MAP: Dict[str, Dict[str, List[str]]] = {
    "Identity & Access": {
        "SOC2": ["CC6.1 Logical access", "CC6.3 Least privilege"],
        "HIPAA": ["§164.308(a)(4) Access management", "§164.312(a)(1) Access control"],
        "PCI-DSS": ["Req 7.2 Least privilege"],
    },
    "Security": {
        "SOC2": ["CC6.6 Boundary protection"],
        "HIPAA": ["§164.312(e)(1) Transmission security"],
        "PCI-DSS": ["Req 1.4 Public network exposure", "Req 2.2 Secure configuration"],
    },
    "Encryption": {
        "SOC2": ["CC6.1 Logical access"],
        "HIPAA": ["§164.312(a)(2)(iv) Encryption at rest",
                  "§164.312(e)(2)(ii) Encryption in transit"],
        "PCI-DSS": ["Req 3.5 Protect stored data"],
    },
    "Networking": {
        "SOC2": ["CC6.6 Boundary protection"],
        "HIPAA": ["§164.312(e)(1) Transmission security"],
        "PCI-DSS": ["Req 1.3 Network segmentation"],
    },
}

FRAMEWORKS: List[str] = ["SOC2", "HIPAA", "PCI-DSS"]

# Only real control violations belong on a compliance page. LOW/INFO findings are
# advisory (sizing hints, tagging, tuning suggestions) — they are counted and
# reported as `advisory_findings` rather than silently discarded.
_COMPLIANCE_SEVERITIES = {"CRITICAL", "HIGH", "MEDIUM"}

_SEVERITY_RANK = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}


async def generate_compliance_report(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    """One deduplicated list of real control violations, each citing the specific
    control it breaches in every framework that covers it."""
    security_data = await run_security_scan(account_id, db)
    findings = security_data.get("findings", [])

    violations: List[Dict[str, Any]] = []
    advisory_findings = 0
    # framework -> {"violations": n, "controls": set(), "by_severity": {...}}
    summary: Dict[str, Dict[str, Any]] = {
        fw: {
            "violations": 0,
            "controls_cited": [],
            "by_severity": {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0},
            # No certified control catalog is evaluated — totals/scores stay NA
            "total_controls": None,
            "failed_controls": None,
            "score": None,
        }
        for fw in FRAMEWORKS
    }

    for finding in findings:
        category = finding.get("category", "")
        severity = (finding.get("severity") or "").upper()
        controls = _CONTROL_MAP.get(category)

        if severity not in _COMPLIANCE_SEVERITIES or not controls:
            advisory_findings += 1
            continue

        violations.append({
            **finding,
            "rule": finding.get("title", ""),
            "affected_resource": (
                f"{finding.get('resource_type', 'Unknown')}: "
                f"{finding.get('resource_name', 'Unnamed')}"
            ),
            # {framework: [control refs]} — drives the per-framework citations
            "controls": controls,
            "frameworks": sorted(controls.keys()),
        })

        for fw, refs in controls.items():
            if fw not in summary:
                continue
            summary[fw]["violations"] += 1
            if severity in summary[fw]["by_severity"]:
                summary[fw]["by_severity"][severity] += 1
            for ref in refs:
                if ref not in summary[fw]["controls_cited"]:
                    summary[fw]["controls_cited"].append(ref)

    # Most severe first — a CRITICAL must never sort below a MEDIUM.
    violations.sort(key=lambda f: _SEVERITY_RANK.get((f.get("severity") or "").upper(), 9))

    severity_totals = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0}
    for v in violations:
        sev = (v.get("severity") or "").upper()
        if sev in severity_totals:
            severity_totals[sev] += 1

    return {
        "account_id": str(account_id),
        # A real percentage requires a certified assessment — NA until one is wired up
        "overall_compliance_score": None,
        "violations": violations,
        "total_violations": len(violations),
        "severity_totals": severity_totals,
        "framework_summary": summary,
        "advisory_findings": advisory_findings,
        "note": (
            f"{len(violations)} real control violation(s), most severe first — each listed "
            "once, with the specific control it breaches in every applicable framework. "
            f"{advisory_findings} advisory finding(s) (untagged resources, sizing and tuning "
            "hints) are housekeeping rather than control violations and stay on the Security "
            "tab. Control references are informative cross-walks to the published control "
            "text, not a certified assessment — overall scores require a provider compliance "
            "integration (AWS Security Hub / Azure Defender / OCI Cloud Guard) and show NA."
        ),
    }
