"""The optimization rule registry.

Dispatch is keyed on (provider, resource_type), never on resource_type alone —
the lesson the security registry learned when an OCI rule fired on AWS API
Gateways because both clouds use the name "APIGateway". Every rule is
validated at import: an unknown category, severity, signal or metric refuses
to load rather than producing findings nobody can filter.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

from app.optimization.rules import compute, containers, database, network, serverless, storage
from app.optimization.rules.base import THRESHOLDS, Rule, validate_rule

RULES: Dict[str, Rule] = {}
for _module in (compute, storage, network, database, serverless, containers):
    for _rule in _module.RULES:
        validate_rule(_rule)
        assert _rule.rule_id not in RULES, f"duplicate rule id {_rule.rule_id}"
        RULES[_rule.rule_id] = _rule

# The resource types each provider's scanner actually produces (the names in
# its type map). A rule listing several providers and several types applies
# only where the pair is real: without this, "LoadBalancer" or "Function" — both
# names more than one cloud uses — could hand one cloud's rule another's rows.
PROVIDER_TYPES = {
    "AWS": {"EC2Instance", "EBSVolume", "LambdaFunction", "DynamoDBTable", "S3Bucket",
            "RDSInstance", "EKSCluster", "LoadBalancer", "APIGateway"},
    "AZURE": {"VirtualMachine", "ManagedDisk", "PublicIP", "NetworkInterface", "SQLDatabase",
              "PostgreSQLServer", "AppServicePlan", "StorageAccount", "NATGateway", "AKSCluster"},
    "OCI": {"ComputeInstance", "BlockVolume", "BootVolume", "DbSystem", "AutonomousDatabase",
            "LoadBalancer", "ObjectStorageBucket", "Function", "OKECluster", "APIGateway"},
}

_INDEX: Dict[Tuple[str, str], List[Rule]] = {}
for _rule in RULES.values():
    for _p in _rule.providers:
        for _t in _rule.resource_types:
            if _t in PROVIDER_TYPES.get(_p, ()):
                _INDEX.setdefault((_p, _t), []).append(_rule)
    assert any((_p, _t) in _INDEX for _p in _rule.providers for _t in _rule.resource_types), \
        f"{_rule.rule_id} applies to no real (provider, resource type) pair"

# Old Cost-tab rule name → the rule that now owns the condition. The Cost tab's
# recommendation list is built from this engine's findings, and a decision a
# person recorded against the old name is carried over through this map.
SUPERSEDED_COST_RULES: Dict[str, str] = {
    legacy: r.rule_id for r in RULES.values() for legacy in r.supersedes
}


def rules_for(provider: str, resource_type: str) -> List[Rule]:
    return list(_INDEX.get((provider, resource_type), ()))


def by_id(rule_id: str):
    return RULES.get(rule_id)


def analysable_types() -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = {}
    for (p, t) in _INDEX:
        out.setdefault(p, []).append(t)
    return {p: sorted(ts) for p, ts in out.items()}


__all__ = ["RULES", "THRESHOLDS", "SUPERSEDED_COST_RULES", "rules_for", "by_id", "analysable_types"]
