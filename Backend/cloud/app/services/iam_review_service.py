"""IAM over-permission review — which identities can reach the most, on the
least evidence that they need to.

Two independent data sources, one per provider that actually has one scanned:

* **AWS** — `IAMRole.config.broad_access` / `accessible_resources`, already
  computed by `app.providers.aws.iam_policy` during discovery from the role's
  attached + inline policy documents.
* **OCI** — `IAMPolicy.config.statements`, the tenancy's policy statements in
  OCI's own grammar (`allow <subject> to <verb> <resource-type> in <scope>`),
  parsed here.

Azure RBAC role assignments are not scanned by any provider today, so Azure is
reported with an explicit `not_scanned: true` rather than silently showing zero
findings, which would read as "Azure has no over-permissioned roles" — a claim
this service has no basis for.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List

SEVERITY_CRITICAL = "CRITICAL"
SEVERITY_HIGH = "HIGH"
SEVERITY_MEDIUM = "MEDIUM"

# Verbs/resources whose combination is a privilege-escalation vector: a role
# able to rewrite IAM/policy can grant itself anything else, regardless of what
# else it was scoped to.
_ESCALATION_SERVICES = {"iam"}
_ESCALATION_OCI_RESOURCES = {"policies", "groups", "users", "dynamic-groups", "all-resources"}


def _aws_role_risk(role) -> Dict[str, Any] | None:
    config = role.config or {}
    broad = list(config.get("broad_access") or [])
    concrete = list(config.get("accessible_resources") or [])
    if not broad and not concrete:
        return None

    full_wildcards = [g for g in broad if g.endswith(":full")]
    write_wildcards = [g for g in broad if g.endswith(":write") and not g.endswith(":full")]
    can_escalate = any(g.split(":")[0] in _ESCALATION_SERVICES for g in broad)

    if can_escalate:
        severity, reason = SEVERITY_CRITICAL, "can modify IAM itself (privilege escalation risk)"
    elif full_wildcards:
        severity = SEVERITY_CRITICAL if len(full_wildcards) >= 3 else SEVERITY_HIGH
        reason = f"full (read+write+delete) access to {len(full_wildcards)} service(s) tenancy-wide"
    elif write_wildcards:
        severity, reason = SEVERITY_MEDIUM, f"write access to {len(write_wildcards)} service(s) tenancy-wide"
    else:
        return None  # read-only or fully scoped to named resources — not a finding

    return {
        "id": str(role.id),
        "name": role.resource_name,
        "account_id": str(role.account_id),
        "severity": severity,
        "reason": reason,
        "wildcard_grants": sorted(broad),
        "concrete_grant_count": len(concrete),
        "can_escalate_privileges": can_escalate,
    }


# OCI statement grammar: "[allow] <subject-kind> <subject> to <verb> <resource> in <scope> [where ...]"
_OCI_STMT = re.compile(
    r"^\s*allow\s+"
    r"(?P<subject_kind>group|dynamic-group|any-user|service)\s+"
    r"(?P<subject>[\w'\-,{} ]+?)\s+to\s+"
    r"(?P<verb>manage|use|read|inspect|\{[^}]*\})\s+"
    r"(?P<resource>[\w-]+)\s+"
    r"in\s+(?P<scope>tenancy|compartment\s+[\w'\"-]+)",
    re.IGNORECASE,
)


def _parse_oci_statement(stmt: str) -> Dict[str, Any] | None:
    m = _OCI_STMT.match(stmt.strip())
    if not m:
        return None
    return {
        "subject_kind": m.group("subject_kind").lower(),
        "subject": m.group("subject").strip(),
        "verb": m.group("verb").lower().strip("{}"),
        "resource": m.group("resource").lower(),
        "scope": "tenancy" if m.group("scope").lower() == "tenancy" else "compartment",
        "raw": stmt,
    }


def _oci_policy_risk(policy) -> Dict[str, Any] | None:
    config = policy.config or {}
    parsed = [p for p in (_parse_oci_statement(s) for s in config.get("statements") or []) if p]
    if not parsed:
        return None  # statement didn't match the known grammar — not silently guessed at

    findings = []
    for p in parsed:
        is_manage = p["verb"] == "manage"
        is_broad_resource = p["resource"] in ("all-resources",) or p["resource"].endswith("-family")
        can_escalate = p["resource"] in _ESCALATION_OCI_RESOURCES and is_manage

        if can_escalate:
            sev = SEVERITY_CRITICAL
            reason = f"can manage {p['resource']} (privilege escalation risk)"
        elif is_manage and p["resource"] == "all-resources" and p["scope"] == "tenancy":
            sev, reason = SEVERITY_CRITICAL, "full manage access to ALL resources, tenancy-wide"
        elif is_manage and is_broad_resource and p["scope"] == "tenancy":
            sev, reason = SEVERITY_HIGH, f"manage access to {p['resource']}, tenancy-wide"
        else:
            continue
        findings.append({**p, "severity": sev, "reason": reason})

    if not findings:
        return None
    worst = min(findings, key=lambda f: {SEVERITY_CRITICAL: 0, SEVERITY_HIGH: 1}[f["severity"]])
    return {
        "id": str(policy.id),
        "name": policy.resource_name,
        "account_id": str(policy.account_id),
        "severity": worst["severity"],
        "reason": worst["reason"],
        "statements": findings,
        "can_escalate_privileges": any(f["resource"] in _ESCALATION_OCI_RESOURCES for f in findings),
    }


_SEVERITY_RANK = {SEVERITY_CRITICAL: 0, SEVERITY_HIGH: 1, SEVERITY_MEDIUM: 2}


def compute_iam_review(resources: List[Any], provider: str) -> Dict[str, Any]:
    provider = (provider or "").upper()

    if provider == "AZURE":
        # RBAC role assignments are not scanned anywhere today — say so rather
        # than silently returning an empty, falsely-reassuring list.
        return {
            "provider": provider, "not_scanned": True,
            "reason": "Azure RBAC role assignments are not yet collected by the discovery scanner.",
            "findings": [], "total_identities_reviewed": 0,
        }

    if provider in ("OCI", "ORACLE"):
        policies = [r for r in resources if r.resource_type == "IAMPolicy"]
        findings = [f for f in (_oci_policy_risk(p) for p in policies) if f]
        reviewed = len(policies)
    else:  # AWS
        roles = [r for r in resources if r.resource_type == "IAMRole"]
        findings = [f for f in (_aws_role_risk(r) for r in roles) if f]
        reviewed = len(roles)

    findings.sort(key=lambda f: _SEVERITY_RANK.get(f["severity"], 9))
    return {
        "provider": provider,
        "not_scanned": False,
        "findings": findings,
        "total_identities_reviewed": reviewed,
        "total_flagged": len(findings),
        "escalation_risk_count": sum(1 for f in findings if f.get("can_escalate_privileges")),
        "by_severity": {
            sev: sum(1 for f in findings if f["severity"] == sev)
            for sev in (SEVERITY_CRITICAL, SEVERITY_HIGH, SEVERITY_MEDIUM)
        },
    }
