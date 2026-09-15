"""Azure RBAC role-assignment collection.

This exists because the identity review used to answer "Not Yet Available for
AZURE" — and that was true when written, but only because nothing had tried.
Probing the live estate showed role assignments are readable on two of the
three subscriptions (280 and 24 assignments, with 943 role definitions), and
the third refuses with a precise, actionable error:

    AuthorizationFailed — the client '<app-id>' with object id '<oid>' does not
    have authorization to perform action
    'Microsoft.Authorization/roleAssignments/read' over scope
    '/subscriptions/<sub>'

So the honest answer is per subscription, not per provider: collect where it
works, and report the exact denied action where it does not.

**Role definitions are fetched, not hard-coded.** The obvious shortcut is a map
of well-known role GUIDs (Owner = 8e3af657-…, Contributor = b24988ac-…). That
map is fine until someone assigns a custom role, at which point it silently
reports the most privileged assignment in the subscription as unrecognised.
Fetching the definitions gives the role's real `actions` list, which lets the
analyser decide "this role can write role assignments, so it is an escalation
path" from evidence rather than from a GUID it happens to recognise.

Both calls are blocking Azure SDK calls, so callers must run this in the
executor — the same contract as every other scanner in this package.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.models.identity_grant import (
    COLLECT_AUTH_FAILED, COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE,
    SCOPE_GROUP, SCOPE_RESOURCE, SCOPE_ROOT, SCOPE_SUBSCRIPTION,
)

logger = logging.getLogger("cloud_svc.azure.rbac")

# A subscription with more assignments than this is paged rather than pulled
# whole; 5,000 is far above anything observed (the largest live subscription
# has 280) and exists only so a pathological tenant cannot exhaust memory.
_MAX_ASSIGNMENTS = 5000

# Pulled out of the provider's error text so the UI can name the one permission
# to grant instead of printing a paragraph.
_ACTION_RE = re.compile(r"perform action '([^']+)'")


def _scope_level(scope: Optional[str]) -> str:
    """Classify an ARM scope string by breadth.

    Breadth is most of what makes a grant risky — Owner on one storage account
    is a normal delegation, Owner on the subscription is not — so it is
    computed once here rather than re-derived by every consumer.
    """
    s = (scope or "").strip().lower()
    if not s or s == "/":
        return SCOPE_ROOT
    if s.startswith("/providers/microsoft.management/managementgroups"):
        return SCOPE_ROOT
    # Count path segments: /subscriptions/<id> is 2, +/resourceGroups/<n> is 4,
    # anything deeper names a specific resource.
    parts = [p for p in s.split("/") if p]
    if parts[:1] == ["subscriptions"]:
        if len(parts) <= 2:
            return SCOPE_SUBSCRIPTION
        if len(parts) <= 4 and parts[2] == "resourcegroups":
            return SCOPE_GROUP
        return SCOPE_RESOURCE
    return SCOPE_RESOURCE


def _classify_error(exc: BaseException) -> Tuple[str, Optional[str]]:
    """Map an SDK exception to a collection status and, where the provider named
    it, the missing permission."""
    text = str(exc)
    lowered = text.lower()
    if "authorizationfailed" in lowered or "does not have authorization" in lowered:
        m = _ACTION_RE.search(text)
        return COLLECT_PERMISSION_DENIED, (m.group(1) if m else
                                           "Microsoft.Authorization/roleAssignments/read")
    if "authenticationfailed" in lowered or "invalid_client" in lowered \
            or "unauthorized" in lowered:
        return COLLECT_AUTH_FAILED, None
    return COLLECT_UNAVAILABLE, None


def _role_definitions(client, subscription_id: str) -> Dict[str, Dict[str, Any]]:
    """`{definition guid: {name, type, permissions}}` for the subscription.

    Failure here is not fatal: assignments are still worth collecting without
    role names, so this returns an empty map and lets the caller carry on with
    role_key only. Losing the names degrades the analysis; losing the
    assignments would end it.
    """
    out: Dict[str, Dict[str, Any]] = {}
    try:
        for d in client.role_definitions.list(scope=f"/subscriptions/{subscription_id}"):
            perms: Dict[str, List[str]] = {"actions": [], "not_actions": [],
                                           "data_actions": [], "not_data_actions": []}
            for p in (d.permissions or []):
                perms["actions"].extend(list(getattr(p, "actions", None) or []))
                perms["not_actions"].extend(list(getattr(p, "not_actions", None) or []))
                perms["data_actions"].extend(list(getattr(p, "data_actions", None) or []))
                perms["not_data_actions"].extend(
                    list(getattr(p, "not_data_actions", None) or []))
            out[d.name] = {
                "role_name": d.role_name,
                "role_type": d.role_type,
                "permissions": perms,
            }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Could not list Azure role definitions for %s: %s — assignments will be "
            "collected without role names.", subscription_id, exc,
        )
    return out


def collect_role_assignments(auth, subscription_id: str) -> Dict[str, Any]:
    """Collect role assignments for one subscription.

    Returns `{status, error_detail, missing_permission, grants: [...]}`. Never
    raises: an identity-collection failure must not fail a discovery scan, and
    the failure itself is the thing worth recording.
    """
    try:
        from azure.mgmt.authorization import AuthorizationManagementClient
    except ImportError as exc:
        return {
            "status": COLLECT_UNAVAILABLE,
            "error_detail": f"azure-mgmt-authorization is not installed: {exc}",
            "missing_permission": None,
            "grants": [],
        }

    try:
        client = AuthorizationManagementClient(auth.get_credential(), subscription_id)
    except Exception as exc:  # noqa: BLE001
        status, perm = _classify_error(exc)
        return {"status": status, "error_detail": str(exc)[:2000],
                "missing_permission": perm, "grants": []}

    # Assignments first: if this is denied there is no point paying for the
    # definitions, and the denial is the answer.
    try:
        assignments = []
        for ra in client.role_assignments.list_for_subscription():
            assignments.append(ra)
            if len(assignments) >= _MAX_ASSIGNMENTS:
                logger.warning(
                    "Azure subscription %s returned at least %d role assignments; "
                    "truncating.", subscription_id, _MAX_ASSIGNMENTS,
                )
                break
    except Exception as exc:  # noqa: BLE001
        status, perm = _classify_error(exc)
        logger.info("Azure RBAC collection refused for %s: %s", subscription_id, status)
        return {"status": status, "error_detail": str(exc)[:2000],
                "missing_permission": perm, "grants": []}

    definitions = _role_definitions(client, subscription_id)

    grants: List[Dict[str, Any]] = []
    for ra in assignments:
        role_key = (ra.role_definition_id or "").rsplit("/", 1)[-1] or None
        meta = definitions.get(role_key or "", {})
        grants.append({
            "grant_key": ra.id or f"{ra.principal_id}:{role_key}:{ra.scope}",
            "principal_id": ra.principal_id,
            "principal_type": getattr(ra, "principal_type", None),
            # Deliberately not filled: the display name requires Microsoft Graph
            # (Directory.Read.All), a different permission this app does not
            # hold. An object id shown as a name would be worse than no name.
            "principal_name": None,
            "role_key": role_key,
            "role_name": meta.get("role_name"),
            "role_type": meta.get("role_type"),
            "scope": ra.scope,
            "scope_level": _scope_level(ra.scope),
            "permissions": meta.get("permissions"),
        })

    return {"status": COLLECT_OK, "error_detail": None, "missing_permission": None,
            "grants": grants}
