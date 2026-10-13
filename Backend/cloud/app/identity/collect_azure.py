"""Azure identity collection: principals, managed identities, deny assignments.

Azure is the provider where honesty about what cannot be collected matters
most, because the control plane and the directory are two different APIs with
two different permission models:

*   **ARM** (what this platform's subscription credential can reach) knows that
    a role is assigned to object id `6f1c…`. It does not know whether that
    object is a person, an application or a group, what it is called, when it
    last signed in, or whether it has MFA.
*   **Microsoft Graph** knows all of that, and needs its own application
    permissions — `Directory.Read.All` at minimum, `AuditLog.Read.All` for
    sign-in activity, `UserAuthenticationMethod.Read.All` for MFA registration.
    Most subscription-scoped service principals have none of them.

So this collector builds the principal inventory from role assignments, which
always work, and ENRICHES it from Graph where Graph is reachable. Where it is
not, names stay null, MFA stays UNKNOWN and last-sign-in stays null — and the
collection state records which Graph permission would fill each gap. The
alternative, inferring a display name from an object id or treating an
unreported MFA state as disabled, would produce an identity list that looks
complete and is wrong in the direction that gets acted on.

`azure_rbac.collect_role_assignments` already collects the assignments and
already records its own refusals; this module calls it rather than
reimplementing it, and adds the three things CIEM needs beyond it: the
principals themselves, deny assignments, and Graph enrichment.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity.model import (
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_UNKNOWN, ACTOR_WORKLOAD, AZURE, AZURE_FOREIGN_PRINCIPAL,
    AZURE_GROUP, AZURE_MANAGED_IDENTITY, AZURE_SERVICE_PRINCIPAL, AZURE_USER,
    CRED_AZURE_SP_CERT, CRED_AZURE_SP_SECRET, IDENTITY_TYPE_UNKNOWN, MFA_NOT_APPLICABLE,
    MFA_UNKNOWN, STATUS_ACTIVE, STATUS_DISABLED, STATUS_UNKNOWN, identity_key,
)
from app.models.identity_grant import (
    COLLECT_AUTH_FAILED, COLLECT_NOT_SUPPORTED, COLLECT_OK, COLLECT_PERMISSION_DENIED,
    COLLECT_UNAVAILABLE,
)

logger = logging.getLogger("cloud_svc.identity.azure")

# How ARM spells a principal type, mapped to our vocabulary. ARM's
# `principalType` is present on most assignments and absent on some older ones,
# which is why IDENTITY_TYPE_UNKNOWN exists rather than a default guess.
PRINCIPAL_TYPE_MAP: Dict[str, Tuple[str, str]] = {
    "user": (AZURE_USER, ACTOR_HUMAN),
    "group": (AZURE_GROUP, ACTOR_GROUP),
    "serviceprincipal": (AZURE_SERVICE_PRINCIPAL, ACTOR_WORKLOAD),
    "manageidentity": (AZURE_MANAGED_IDENTITY, ACTOR_WORKLOAD),
    "managedidentity": (AZURE_MANAGED_IDENTITY, ACTOR_WORKLOAD),
    "foreigngroup": (AZURE_FOREIGN_PRINCIPAL, ACTOR_UNKNOWN),
    "device": (AZURE_SERVICE_PRINCIPAL, ACTOR_WORKLOAD),
}

GRAPH_PERMISSIONS = {
    "names": "Directory.Read.All (Microsoft Graph)",
    "sign_in": "AuditLog.Read.All (Microsoft Graph)",
    "mfa": "UserAuthenticationMethod.Read.All (Microsoft Graph)",
}


def _classify_error(exc: BaseException) -> Tuple[str, Optional[str]]:
    message = str(exc)
    lowered = message.lower()
    if "authorizationfailed" in lowered or "does not have authorization" in lowered:
        action = None
        if "'" in message:
            parts = [p for p in message.split("'") if "/" in p and "Microsoft." in p]
            action = parts[0] if parts else None
        return COLLECT_PERMISSION_DENIED, action
    if "unauthorized" in lowered or "invalid_client" in lowered or "aadsts" in lowered:
        return COLLECT_AUTH_FAILED, None
    return COLLECT_UNAVAILABLE, None


def _as_dt(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def collect(
    auth, *, subscription_id: str, account_key: str,
    tenant_id: Optional[str] = None, graph_client: Any = None,
) -> Dict[str, Any]:
    """Collect the Azure principal estate for one subscription. Never raises."""
    from app.providers.azure import azure_rbac

    result: Dict[str, Any] = {
        "provider": AZURE,
        "status": COLLECT_OK,
        "identities": [],
        "memberships": [],
        "policies": [],
        "trust": [],
        "deny_assignments": [],
        "deny_assignments_collected": False,
        "errors": [],
        "error_detail": None,
        "missing_permission": None,
        "partial": False,
        "graph_available": False,
        "graph_gaps": [],
    }

    # ── Role assignments (the existing collector) ────────────────────────────
    rbac = azure_rbac.collect_role_assignments(auth, subscription_id)
    if rbac.get("status") != COLLECT_OK:
        result.update(
            status=rbac.get("status") or COLLECT_UNAVAILABLE,
            error_detail=rbac.get("error_detail"),
            missing_permission=rbac.get("missing_permission")
            or "Microsoft.Authorization/roleAssignments/read",
        )
        return result

    grants = rbac.get("grants") or []
    result["grants"] = grants

    # ── Principals, derived from the assignments ─────────────────────────────
    by_principal: Dict[str, Dict[str, Any]] = {}
    for grant in grants:
        principal_id = (grant.get("principal_id") or "").strip()
        if not principal_id:
            continue
        raw_type = (grant.get("principal_type") or "").strip().lower().replace(" ", "")
        identity_type, actor = PRINCIPAL_TYPE_MAP.get(
            raw_type, (IDENTITY_TYPE_UNKNOWN, ACTOR_UNKNOWN))
        key = identity_key(provider=AZURE, account_id=account_key,
                           identity_type=identity_type, provider_id=principal_id)
        entry = by_principal.get(key)
        if entry is None:
            entry = by_principal[key] = {
                "identity_type": identity_type,
                "provider_id": principal_id,
                "identity_key": key,
                # Null, not the object id wearing a name's clothes. Graph fills
                # this where it is reachable; where it is not, the UI shows the
                # object id as an id and says the name is unresolved.
                "name": grant.get("principal_name"),
                "principal_name": grant.get("principal_name"),
                "actor_class": actor,
                "status": STATUS_UNKNOWN,
                "mfa_state": MFA_NOT_APPLICABLE if actor in (ACTOR_WORKLOAD, ACTOR_GROUP)
                             else MFA_UNKNOWN,
                "credentials": [],
                "scope": grant.get("scope"),
                "provider_detail": {"principal_type_raw": grant.get("principal_type")},
                "provider_reports_last_used": False,
                "provider_reports_mfa": False,
                "_assignments": [],
            }
        entry["_assignments"].append(grant)

    # ── Deny assignments ─────────────────────────────────────────────────────
    deny = collect_deny_assignments(auth, subscription_id)
    result["deny_assignments"] = deny.get("deny_assignments", [])
    result["deny_assignments_collected"] = deny.get("status") == COLLECT_OK
    if deny.get("status") != COLLECT_OK:
        result["errors"].append({
            "stage": "deny_assignments", "status": deny.get("status"),
            "detail": deny.get("error_detail"),
            "missing_permission": deny.get("missing_permission"),
        })

    # ── Graph enrichment, where it is reachable ──────────────────────────────
    if graph_client is not None:
        enriched = enrich_from_graph(graph_client, by_principal, tenant_id=tenant_id)
        result["graph_available"] = enriched.get("available", False)
        result["graph_gaps"] = enriched.get("gaps", [])
        if enriched.get("errors"):
            result["errors"].extend(enriched["errors"])
    else:
        result["graph_gaps"] = [
            {"gap": "display_name", "permission": GRAPH_PERMISSIONS["names"],
             "effect": "Principals are identified by object id only."},
            {"gap": "last_sign_in", "permission": GRAPH_PERMISSIONS["sign_in"],
             "effect": "Dormancy cannot be assessed for Entra principals."},
            {"gap": "mfa_registration", "permission": GRAPH_PERMISSIONS["mfa"],
             "effect": "MFA state is UNKNOWN for human identities, not 'disabled'."},
        ]

    # ── Role definitions become policy rows ──────────────────────────────────
    # `policy_key` is the ASSIGNMENT id, not the role definition id. One
    # principal holding the same role at two scopes — Reader on two resource
    # groups, say — is two distinct grants, and keying on the role definition
    # collapses them into one, silently under-reporting the principal's access.
    # Live data caught this immediately: TOR2 has one principal with Website
    # Contributor at two different scopes.
    #
    # It is also the more useful id to show an operator: the assignment id is
    # what `az role assignment delete --ids` takes, where the role definition
    # id only names which role it was.
    for key, entry in by_principal.items():
        for grant in entry.pop("_assignments", []):
            permissions = dict(grant.get("permissions") or {})
            # The role definition id travels inside the document so nothing is
            # lost; `RoleAssignment.from_grant` ignores unrecognised keys.
            permissions["role_definition_id"] = grant.get("role_key")
            result["policies"].append({
                "identity_key": key,
                "policy_key": grant.get("grant_key") or grant.get("role_key"),
                "policy_name": grant.get("role_name"),
                "policy_type": grant.get("role_type"),
                "policy_stage": "rbac_assignment",
                "scope": grant.get("scope"),
                "scope_level": grant.get("scope_level"),
                "document": permissions,
            })

    result["identities"] = list(by_principal.values())
    result["partial"] = bool(result["errors"])
    return result


def collect_deny_assignments(auth, subscription_id: str) -> Dict[str, Any]:
    """Deny assignments for a subscription.

    Reported separately because its refusal has a specific consequence: without
    deny assignments every Azure ALLOW this platform computes is
    ALLOWED_UNVERIFIED rather than ALLOWED, and the identity pages say so.
    """
    out: Dict[str, Any] = {"status": COLLECT_UNAVAILABLE, "deny_assignments": [],
                           "error_detail": None, "missing_permission": None}
    try:
        from azure.mgmt.authorization import AuthorizationManagementClient
    except ImportError as exc:
        out.update(status=COLLECT_NOT_SUPPORTED,
                   error_detail=f"azure-mgmt-authorization is not installed: {exc}")
        return out

    try:
        client = AuthorizationManagementClient(auth.get_credential(), subscription_id)
        # `list()` is the subscription-wide listing on this client; there is
        # no `list_for_subscription`. Live data caught the wrong name.
        for item in client.deny_assignments.list():
            permissions = getattr(item, "permissions", None) or []
            actions, not_actions, data_actions, not_data_actions = [], [], [], []
            for block in permissions:
                actions.extend(getattr(block, "actions", None) or [])
                not_actions.extend(getattr(block, "not_actions", None) or [])
                data_actions.extend(getattr(block, "data_actions", None) or [])
                not_data_actions.extend(getattr(block, "not_data_actions", None) or [])
            excluded = [
                getattr(p, "object_id", None)
                for p in (getattr(item, "exclude_principals", None) or [])
            ]
            out["deny_assignments"].append({
                "name": getattr(item, "deny_assignment_name", None) or getattr(item, "name", ""),
                "assignment_id": getattr(item, "id", None),
                "scope": getattr(item, "scope", None) or f"/subscriptions/{subscription_id}",
                "actions": actions,
                "not_actions": not_actions,
                "data_actions": data_actions,
                "not_data_actions": not_data_actions,
                "excluded_principals": [e for e in excluded if e],
                "is_system_protected": getattr(item, "is_system_protected", None),
            })
        out["status"] = COLLECT_OK
    except Exception as exc:  # noqa: BLE001
        status, action = _classify_error(exc)
        out.update(status=status, error_detail=str(exc)[:1500],
                   missing_permission=action or "Microsoft.Authorization/denyAssignments/read")
    return out


def enrich_from_graph(
    graph_client: Any, by_principal: Dict[str, Dict[str, Any]], *,
    tenant_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Fill names, account state, sign-in activity and MFA from Microsoft Graph.

    `graph_client` is any object exposing `get(path)` returning parsed JSON —
    deliberately duck-typed so the caller can pass an authenticated session
    without this module taking a dependency on a particular Graph SDK.

    Every field is filled only where Graph actually returned it. A principal
    Graph does not know about keeps its nulls.
    """
    out: Dict[str, Any] = {"available": False, "gaps": [], "errors": []}
    if graph_client is None:
        return out

    ids = [e["provider_id"] for e in by_principal.values() if e.get("provider_id")]
    if not ids:
        return out

    resolved: Dict[str, Dict[str, Any]] = {}
    try:
        # directoryObjects/getByIds takes up to 1000 ids per call and is the
        # cheapest way to resolve a mixed set of users, groups and service
        # principals in one request.
        for chunk in _chunks(ids, 1000):
            payload = graph_client.post(
                "/directoryObjects/getByIds",
                {"ids": list(chunk),
                 "types": ["user", "group", "servicePrincipal"]},
            )
            for obj in (payload or {}).get("value", []):
                oid = obj.get("id")
                if oid:
                    resolved[oid] = obj
        out["available"] = True
    except Exception as exc:  # noqa: BLE001
        out["errors"].append({
            "stage": "graph_getByIds", "status": COLLECT_PERMISSION_DENIED,
            "detail": str(exc)[:1000], "missing_permission": GRAPH_PERMISSIONS["names"],
        })
        out["gaps"].append({
            "gap": "display_name", "permission": GRAPH_PERMISSIONS["names"],
            "effect": "Principals are identified by object id only.",
        })
        return out

    sign_in_available = True
    for entry in by_principal.values():
        obj = resolved.get(entry.get("provider_id") or "")
        if not obj:
            continue
        entry["name"] = obj.get("displayName") or entry.get("name")
        entry["principal_name"] = (obj.get("userPrincipalName")
                                   or obj.get("appId")
                                   or entry.get("principal_name"))
        enabled = obj.get("accountEnabled")
        if enabled is True:
            entry["status"] = STATUS_ACTIVE
        elif enabled is False:
            entry["status"] = STATUS_DISABLED
        detail = dict(entry.get("provider_detail") or {})
        detail.update({
            "odata_type": obj.get("@odata.type"),
            "servicePrincipalType": obj.get("servicePrincipalType"),
            "appId": obj.get("appId"),
            "createdDateTime": obj.get("createdDateTime"),
            "userType": obj.get("userType"),
        })
        entry["provider_detail"] = detail
        entry["created_at_provider"] = _as_dt(obj.get("createdDateTime"))

        # An external guest is marked by userType, and is a trust fact worth
        # carrying rather than inferring later from the UPN's #EXT# marker.
        if (obj.get("userType") or "").lower() == "guest":
            entry["external"] = "EXTERNAL"
            entry["external_detail"] = {"reason": "Entra userType is Guest",
                                        "upn": obj.get("userPrincipalName")}

        sign_in = (obj.get("signInActivity") or {}).get("lastSignInDateTime")
        if sign_in:
            entry["last_used_at"] = _as_dt(sign_in)
            entry["last_used_source"] = "Microsoft Graph signInActivity"
            entry["provider_reports_last_used"] = True
        else:
            sign_in_available = False

    if not sign_in_available:
        out["gaps"].append({
            "gap": "last_sign_in", "permission": GRAPH_PERMISSIONS["sign_in"],
            "effect": "Sign-in activity was not returned for some principals, so their "
                      "dormancy is UNKNOWN rather than dormant.",
        })
    out["gaps"].append({
        "gap": "mfa_registration", "permission": GRAPH_PERMISSIONS["mfa"],
        "effect": "MFA registration is not read by this collector; human identities "
                  "remain UNKNOWN rather than being reported as having no MFA.",
    })
    return out


def collect_managed_identities(auth, *, subscription_id: str,
                               account_key: str) -> Dict[str, Any]:
    """User-assigned managed identities, from ARM.

    These are reachable without Graph — they are ARM resources — so a
    subscription reader can see them even where the directory is closed. Their
    principal ids are what join them to role assignments.
    """
    out: Dict[str, Any] = {"status": COLLECT_UNAVAILABLE, "identities": [],
                           "error_detail": None, "missing_permission": None}
    try:
        from azure.mgmt.msi import ManagedServiceIdentityClient
    except ImportError as exc:
        out.update(status=COLLECT_NOT_SUPPORTED,
                   error_detail=f"azure-mgmt-msi is not installed: {exc}")
        return out
    try:
        client = ManagedServiceIdentityClient(auth.get_credential(), subscription_id)
        for item in client.user_assigned_identities.list_by_subscription():
            principal_id = getattr(item, "principal_id", None)
            if not principal_id:
                continue
            out["identities"].append({
                "identity_type": AZURE_MANAGED_IDENTITY,
                "provider_id": principal_id,
                "identity_key": identity_key(
                    provider=AZURE, account_id=account_key,
                    identity_type=AZURE_MANAGED_IDENTITY, provider_id=principal_id),
                "name": getattr(item, "name", None),
                "principal_name": getattr(item, "client_id", None),
                "actor_class": ACTOR_WORKLOAD,
                "status": STATUS_ACTIVE,
                "mfa_state": MFA_NOT_APPLICABLE,
                "scope": getattr(item, "id", None),
                "credentials": [],
                "provider_detail": {
                    "resource_id": getattr(item, "id", None),
                    "location": getattr(item, "location", None),
                    "client_id": getattr(item, "client_id", None),
                    "tenant_id": getattr(item, "tenant_id", None),
                },
                "provider_reports_last_used": False,
                "provider_reports_mfa": False,
            })
        out["status"] = COLLECT_OK
    except Exception as exc:  # noqa: BLE001
        status, action = _classify_error(exc)
        out.update(status=status, error_detail=str(exc)[:1000],
                   missing_permission=action
                   or "Microsoft.ManagedIdentity/userAssignedIdentities/read")
    return out


def _chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]
