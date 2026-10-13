"""Azure tenant onboarding: the subscriptions one service principal can reach.

Azure has no "organisation account" to connect. A tenant's subscriptions are
reached by granting ONE service principal a role on each of them — directly, or
once at a management group so it inherits downward. So "onboard the whole
organisation" means: list every subscription this principal can see (optionally
only those under one management group), and say for each what the principal
may actually do there.

That last part is the reason this module exists rather than a bare listing.
A subscription appears in `GET /subscriptions` if the principal holds ANY role
on it — including Cost Management Reader, which lets it read the bill and
nothing else. Discovery against such a subscription does not fail: every ARM
list answers HTTP 200 with an empty array, and the account would sit on the
dashboard looking like an empty subscription. The TOR subscriptions onboarded
on 2026-08-04 were in exactly that state. So each subscription is probed with
`Microsoft.Authorization/permissions` — the principal's EFFECTIVE actions at
that scope — and inventory, cost and identity access are reported separately.

Blocking HTTP; callers run this in the executor.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Sequence

from app.providers.azure import azure_rest as rest

logger = logging.getLogger("cloud_svc.azure.tenant")

_PROBE_CONCURRENCY = 6
_MAX_SUBSCRIPTIONS = 1000

# The concrete operations each capability needs. The effective-permission
# ACTIONS are patterns and these are the strings matched against them — the
# direction matters (see azure_rbac / the 2026-09-10 "Reader flagged as Owner"
# bug, where the glob was applied the wrong way round).
PROBES = {
    # Deliberately resources/read, not resourceGroups/read: Cost Management
    # Reader carries resourceGroups/read, so that would report a billing-only
    # principal as able to inventory the subscription.
    "inventory": "Microsoft.Resources/subscriptions/resources/read",
    "cost": "Microsoft.CostManagement/query/read",
    "identity": "Microsoft.Authorization/roleAssignments/read",
}


def _pattern(action: str) -> re.Pattern:
    return re.compile("^" + re.escape(action).replace(r"\*", ".*") + "$", re.IGNORECASE)


def allowed(permissions: Sequence[Dict[str, Any]], operation: str) -> bool:
    """Whether `operation` is granted by an effective-permissions listing.

    Azure evaluates each permission block separately: an operation is allowed
    by a block if one of its `actions` matches and none of its `notActions`
    does. A notAction in one block does not cancel an action in another.
    """
    for block in permissions or ():
        actions = block.get("actions") or []
        not_actions = block.get("notActions") or []
        if any(_pattern(a).match(operation) for a in actions) and not any(
                _pattern(n).match(operation) for n in not_actions):
            return True
    return False


def _credential(creds: Dict[str, Any]):
    from azure.identity import ClientSecretCredential

    return ClientSecretCredential(
        tenant_id=creds["tenant_id"], client_id=creds["client_id"],
        client_secret=creds["client_secret"])


def _probe(token: str, subscription_id: str) -> Dict[str, Any]:
    try:
        perms = rest.get_all(
            f"{rest.ARM}/subscriptions/{subscription_id}/providers/"
            "Microsoft.Authorization/permissions",
            token, {"api-version": "2022-04-01"})
    except rest.AzureRestError as exc:
        return {"probed": False, "detail": f"Effective permissions could not be read: {exc}",
                **{k: None for k in PROBES}}
    result: Dict[str, Any] = {"probed": True}
    for key, op in PROBES.items():
        result[key] = allowed(perms, op)
    missing = [k for k in PROBES if not result[k]]
    if not result["inventory"]:
        result["detail"] = (
            "This principal cannot list resources here (it lacks "
            "Microsoft.Resources/subscriptions/resources/read, which the Reader role "
            "includes). Discovery would return an empty subscription, not an error. "
            "Grant Reader at subscription or management-group scope.")
    elif missing:
        result["detail"] = "Missing: " + ", ".join(
            f"{k} ({PROBES[k]})" for k in missing) + "."
    else:
        result["detail"] = None
    return result


def list_subscriptions(creds: Dict[str, Any], *, management_group_id: Optional[str] = None,
                       probe: bool = True) -> Dict[str, Any]:
    """Every subscription the principal can see, each probed for access.

    Returns `{status, tenant_id, management_groups, management_group_error,
    subscriptions, error}`. Never raises.
    """
    try:
        token = rest.bearer(_credential(creds))
    except Exception as exc:  # noqa: BLE001
        return {"status": "AuthenticationFailed", "subscriptions": [],
                "error": f"The service principal could not sign in: {str(exc)[:600]}"}

    try:
        subs = rest.get_all(f"{rest.ARM}/subscriptions", token,
                            {"api-version": "2022-12-01"})
    except rest.AzureRestError as exc:
        return {"status": "Unavailable", "subscriptions": [], "error": str(exc)}

    # Management groups are optional context. Reading them needs
    # Microsoft.Management/managementGroups/read, which a principal granted only
    # subscription-level roles does not have — that is reported, not fatal.
    groups: Optional[List[Dict[str, Any]]] = None
    group_error: Optional[str] = None
    try:
        raw = rest.get_all(f"{rest.ARM}/providers/Microsoft.Management/managementGroups",
                           token, {"api-version": "2021-04-01"})
        groups = [{"id": g.get("name"),
                   "display_name": (g.get("properties") or {}).get("displayName")
                   or g.get("name")} for g in raw]
    except rest.AzureRestError as exc:
        group_error = (f"Management groups are not readable by this principal ({exc}). "
                       "Every subscription it can see is listed instead.")

    in_group: Optional[set] = None
    if management_group_id:
        try:
            desc = rest.get_all(
                f"{rest.ARM}/providers/Microsoft.Management/managementGroups/"
                f"{management_group_id}/descendants", token, {"api-version": "2020-05-01"})
            in_group = {d.get("name", "").lower() for d in desc
                        if (d.get("type") or "").lower().endswith("/subscriptions")}
        except rest.AzureRestError as exc:
            return {"status": "PermissionDenied" if exc.status == 403 else "Unavailable",
                    "subscriptions": [], "management_groups": groups,
                    "error": (f"The subscriptions under management group "
                              f"{management_group_id!r} could not be listed: {exc}")}

    rows: List[Dict[str, Any]] = []
    for s in subs[:_MAX_SUBSCRIPTIONS]:
        sid = (s.get("subscriptionId") or "").lower()
        if in_group is not None and sid not in in_group:
            continue
        rows.append({
            "subscription_id": sid,
            "display_name": s.get("displayName"),
            "state": s.get("state"),
            "tenant_id": s.get("tenantId") or s.get("homeTenantId"),
        })

    if probe and rows:
        with ThreadPoolExecutor(max_workers=_PROBE_CONCURRENCY,
                                thread_name_prefix="azure-probe") as pool:
            for row, access in zip(rows, pool.map(
                    lambda r: _probe(token, r["subscription_id"]), rows)):
                if (row.get("state") or "").lower() != "enabled":
                    access = {**access, "detail": f"The subscription is {row.get('state')}."}
                row["access"] = access

    return {
        "status": "Collected",
        "tenant_id": creds.get("tenant_id"),
        "management_groups": groups,
        "management_group_error": group_error,
        "management_group_id": management_group_id,
        "subscriptions": rows,
        "truncated": len(subs) > _MAX_SUBSCRIPTIONS,
        "error": None,
    }


def member_credentials(base: Dict[str, Any], subscription_id: str) -> Dict[str, Any]:
    return {"tenant_id": base["tenant_id"], "client_id": base["client_id"],
            "client_secret": base["client_secret"], "subscription_id": subscription_id}
