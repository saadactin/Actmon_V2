"""Turn IAM policy documents into "what can this role reach" facts.

The topology graph could show that a Lambda assumes a role, but not that the role
lets it write to a DynamoDB table — so 21 tables sat in the graph with no edges
while the functions using them were right there. The permission is the
relationship, and it lives in the policy document.

Two deliberate limits:

* **Wildcards are summarised, never expanded.** `Resource: "*"` is extremely
  common; fanning it out would connect every consumer to every table (23 x 21 =
  483 edges here) and say nothing. Broad grants are reported as
  "dynamodb:write" style strings instead, so the UI can show "broad access"
  without drawing a hairball.
* **A permission is capability, not use.** Everything here answers "is allowed
  to", not "does". Callers should label these edges accordingly; proving actual
  access needs CloudTrail.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set

# Verb prefixes that change state. Checked against the action's own verb, after
# the "service:" prefix, so "dynamodb:PutItem" -> "putitem" -> write.
_WRITE_PREFIXES = (
    "put", "post", "create", "update", "delete", "write", "modify", "set",
    "attach", "detach", "start", "stop", "terminate", "invoke", "send",
    "publish", "tag", "untag", "reboot", "run", "import", "restore", "copy",
    "replicate", "upload", "batchwrite", "add", "remove", "associate",
    "disassociate", "enable", "disable", "purge", "cancel", "register",
    "deregister", "reset", "revoke", "grant",
)
_READ_PREFIXES = (
    "get", "list", "describe", "read", "scan", "query", "head", "batchget",
    "select", "search", "lookup", "check", "view", "estimate", "simulate",
)


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [v for v in value if isinstance(v, str)]
    return []


def classify_actions(actions: Iterable[str]) -> str:
    """'full' | 'write' | 'read' for a statement's action list."""
    level = "read"
    for raw in actions:
        action = raw.strip()
        if action == "*":
            return "full"
        verb = action.split(":", 1)[1].lower() if ":" in action else action.lower()
        if verb.startswith("*"):
            return "full"
        if verb.rstrip("*").lower() in ("", "*"):
            return "full"
        if verb.startswith(_WRITE_PREFIXES):
            level = "write"
        elif not verb.startswith(_READ_PREFIXES) and level != "write":
            # Unrecognised verb — assume it may change state rather than
            # under-reporting a write.
            level = "write"
    return level


def service_of(arn_or_action: str) -> Optional[str]:
    """The AWS service a resource ARN or an action string belongs to."""
    if arn_or_action.startswith("arn:"):
        parts = arn_or_action.split(":")
        return parts[2] if len(parts) > 2 and parts[2] else None
    if ":" in arn_or_action:
        return arn_or_action.split(":", 1)[0]
    return None


def normalize_resource(arn: str) -> Optional[str]:
    """Reduce a policy resource ARN to the identifier the inventory stores.

    The scanners do not all key resources the same way — DynamoDB tables are
    stored by full ARN, S3 buckets by bare bucket name — so a policy ARN has to be
    translated before it can be matched. Returns None for a wildcard, which the
    caller reports as broad access instead of a per-resource edge.
    """
    if not arn or "*" in arn:
        return None
    if not arn.startswith("arn:"):
        return arn

    parts = arn.split(":", 5)
    if len(parts) < 6:
        return arn
    service, resource = parts[2], parts[5]

    if service == "s3":
        # arn:aws:s3:::bucket  /  arn:aws:s3:::bucket/key -> the bucket, stored by name
        return resource.split("/", 1)[0] or None
    if service == "dynamodb":
        # Drop /index/... and /stream/... so an index grant maps to its table.
        if "/index/" in resource or "/stream/" in resource:
            table = resource.split("/index/")[0].split("/stream/")[0]
            return ":".join(parts[:5] + [table])
        return arn
    # Everything else already matches how it is stored (Lambda, SQS, SNS, KMS...).
    return arn


def summarize_policy_documents(documents: Iterable[Any]) -> Dict[str, Any]:
    """Merge policy documents into concrete grants plus wildcard grants.

    Returns:
      accessible_resources: [{"resource": <id>, "access": read|write|full,
                              "service": <svc>}]
      broad_access:         ["dynamodb:write", "s3:read", ...] — sorted, unique
    """
    # Strongest access wins per resource: a role with both read and write to a
    # table has write.
    rank = {"read": 0, "write": 1, "full": 2}
    best: Dict[str, Dict[str, Any]] = {}
    broad: Set[str] = set()

    for doc in documents:
        if not isinstance(doc, dict):
            continue
        for stmt in _as_list_of_statements(doc.get("Statement")):
            if stmt.get("Effect") != "Allow":
                continue
            # NotAction / NotResource invert the meaning; reasoning about them
            # correctly is not worth a wrong edge, so skip those statements.
            if "NotAction" in stmt or "NotResource" in stmt:
                continue
            actions = _as_list(stmt.get("Action"))
            if not actions:
                continue
            access = classify_actions(actions)
            resources = _as_list(stmt.get("Resource"))
            if not resources:
                continue

            for res in resources:
                concrete = normalize_resource(res)
                if concrete is None:
                    # Wildcard — summarise per service instead of expanding.
                    for a in actions:
                        svc = service_of(a) or service_of(res)
                        if svc and svc != "*":
                            broad.add(f"{svc}:{access}")
                    continue
                svc = service_of(res)
                prev = best.get(concrete)
                if prev is None or rank[access] > rank[prev["access"]]:
                    best[concrete] = {
                        "resource": concrete,
                        "access": access,
                        "service": svc,
                    }

    return {
        "accessible_resources": sorted(best.values(), key=lambda g: g["resource"]),
        "broad_access": sorted(broad),
    }


def _as_list_of_statements(stmt: Any) -> List[Dict[str, Any]]:
    if isinstance(stmt, dict):
        return [stmt]
    if isinstance(stmt, list):
        return [s for s in stmt if isinstance(s, dict)]
    return []
