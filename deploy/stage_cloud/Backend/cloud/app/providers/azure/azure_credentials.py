"""Azure certificates, secrets and keys.

Sources, and what each needs:

* **Key Vault — the vaults themselves** (ARM, `Microsoft.KeyVault/vaults/read`,
  in Reader). Gives each vault's URI, soft-delete, purge protection and
  permission model.
* **Key Vault — certificates / secrets / keys** (DATA PLANE). ARM Reader does
  NOT reach inside a vault. An RBAC-model vault needs the Key Vault Reader role;
  an access-policy vault needs "List" on each object type in its policy — and
  the three object types are granted separately, which is why each is its own
  scope. A vault firewall can also refuse this network outright.
* **App Service certificates** (ARM, `Microsoft.Web/certificates/read`).
* **Application Gateway TLS certificates** (ARM). The public part of an uploaded
  certificate comes back as base64 PKCS#7 and is parsed for its dates. A
  certificate referenced from Key Vault has no public data here — it is tracked
  in its vault instead, and counted so the view can say so.

A Cost-Management-Reader-only principal gets HTTP 200 with an EMPTY list from
the ARM listings, not a 403 (see azure_tenant.py). So before an empty vault
listing is believed, the effective permissions are checked; "no vaults" from a
principal that may not see vaults is recorded as PermissionDenied.

Blocking HTTP; callers run this in the executor.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

from app.models.credential_inventory import (
    COLLECT_AUTH_FAILED, COLLECT_BLOCKED, COLLECT_OK, COLLECT_PERMISSION_DENIED,
    COLLECT_UNAVAILABLE, KIND_CERTIFICATE, KIND_KEY, KIND_SECRET,
)
from app.providers.azure import azure_rest as rest
from app.providers.azure.azure_tenant import allowed
from app.providers.credential_common import (
    as_utc, parse_public_certificate, scope_result, unreadable_note,
)

logger = logging.getLogger("cloud_svc.azure.credentials")

SOURCE_VAULTS = "azure:keyvault-vaults"
SOURCE_KV = {
    KIND_CERTIFICATE: "azure:keyvault:certificates",
    KIND_SECRET: "azure:keyvault:secrets",
    KIND_KEY: "azure:keyvault:keys",
}
SOURCE_APP_SERVICE = "azure:app-service-certificates"
SOURCE_APP_GATEWAY = "azure:application-gateway"

_KV_API = "7.4"
_KV_PATH = {KIND_CERTIFICATE: "certificates", KIND_SECRET: "secrets", KIND_KEY: "keys"}
_MAX_CERT_DETAILS_PER_VAULT = 200
_CONCURRENCY = 6


def _classify_arm(exc: rest.AzureRestError, action: str) -> Tuple[str, Optional[str], Optional[str]]:
    if exc.status in (401,) or (exc.code or "").lower() in ("invalidauthenticationtoken",
                                                            "expiredauthenticationtoken"):
        return COLLECT_AUTH_FAILED, None, "The service principal's credentials were rejected."
    if exc.status == 403 or (exc.code or "") == "AuthorizationFailed":
        return (COLLECT_PERMISSION_DENIED, action,
                "Grant the Reader role at subscription scope; it includes this action.")
    return COLLECT_UNAVAILABLE, None, None


def _classify_data_plane(exc: rest.AzureRestError, kind: str,
                         rbac_vault: Optional[bool]) -> Tuple[str, Optional[str], str]:
    inner = (exc.inner_code or "").lower()
    code = (exc.code or "").lower()
    noun = _KV_PATH[kind]
    if exc.status is None:
        return (COLLECT_UNAVAILABLE, None,
                "The vault did not answer from this network. A vault reachable only "
                "through a private endpoint cannot be read from outside its virtual "
                "network.")
    if exc.status == 401:
        return COLLECT_AUTH_FAILED, None, "The service principal's credentials were rejected."
    if inner in ("forbiddenbyfirewall", "forbiddenbyconnection") or "firewall" in \
            (exc.message or "").lower():
        return (COLLECT_BLOCKED, None,
                "The vault's firewall does not allow this network. Add this server's "
                "public IP to the vault's allowed addresses, or read it from inside "
                "its virtual network.")
    if exc.status == 403:
        if inner == "forbiddenbyrbac" or rbac_vault:
            return (COLLECT_PERMISSION_DENIED,
                    f"Microsoft.KeyVault/vaults/{noun}/read (data action)",
                    "Assign the Key Vault Reader role on this vault (or its resource "
                    "group) to the service principal. It reads metadata only — never "
                    "secret values or key material.")
        return (COLLECT_PERMISSION_DENIED, f"'List' on {noun} in the vault access policy",
                f"Add the service principal to this vault's access policy with the "
                f"List permission for {noun}. List returns metadata only.")
    if code:
        return COLLECT_UNAVAILABLE, None, f"The vault answered {exc}."
    return COLLECT_UNAVAILABLE, None, "The vault could not be read."


def _name_from_id(object_id: str) -> str:
    return (object_id or "").rstrip("/").split("/")[-1]


def _kv_list(vault: Dict[str, Any], kind: str, token: str) -> List[Dict[str, Any]]:
    base = vault["uri"].rstrip("/")
    return rest.get_all(f"{base}/{_KV_PATH[kind]}", token,
                        {"api-version": _KV_API, "maxresults": 25})


def _kv_items(vault: Dict[str, Any], kind: str, token: str) -> List[Dict[str, Any]]:
    rows = _kv_list(vault, kind, token)
    items: List[Dict[str, Any]] = []
    details_read = 0
    for row in rows:
        # A certificate's backing secret and key are listed too, flagged
        # `managed`. They are the certificate — counting them again would
        # report one expiring certificate as three expiring objects.
        if kind != KIND_CERTIFICATE and row.get("managed"):
            continue
        attrs = row.get("attributes") or {}
        oid = row.get("id") or row.get("kid") or ""
        spec: Dict[str, Any] = {
            "kind": kind,
            "object_key": oid.lower(),
            "name": _name_from_id(oid),
            "container_name": vault["name"],
            "container_key": vault["id"],
            "region": vault.get("location"),
            "not_before": as_utc(attrs.get("nbf")),
            # `exp` absent means the object has NO expiry set — the analyser's
            # CIS "expiration date set" checks read exactly that.
            "expires_at": as_utc(attrs.get("exp")),
            "enabled": attrs.get("enabled"),
            "details": {"recovery_level": attrs.get("recoveryLevel"),
                        "content_type": row.get("contentType"),
                        "created": as_utc(attrs.get("created")).isoformat()
                        if attrs.get("created") else None},
        }
        if kind == KIND_CERTIFICATE and details_read < _MAX_CERT_DETAILS_PER_VAULT:
            details_read += 1
            try:
                full = rest.get(oid, token, {"api-version": _KV_API})
                parsed = parse_public_certificate(full.get("cer"))
                if parsed:
                    spec.update(subject=parsed["subject"], issuer=parsed["issuer"],
                                dns_names=parsed["dns_names"],
                                key_algorithm=parsed["key_algorithm"])
                    spec["expires_at"] = spec["expires_at"] or parsed["not_after"]
                policy = full.get("policy") or {}
                actions = [((a.get("action") or {}).get("action_type")
                            or (a.get("action") or {}).get("actionType") or "")
                           for a in (policy.get("lifetime_actions")
                                     or policy.get("lifetimeActions") or [])]
                if actions:
                    spec["managed_renewal"] = any(a.lower() == "autorenew" for a in actions)
                issuer = ((policy.get("issuer") or {}).get("name"))
                if issuer:
                    spec["details"]["issuer_name"] = issuer
            except rest.AzureRestError as exc:
                logger.info("Key Vault certificate detail unavailable for %s: %s", oid, exc)
        if kind == KIND_CERTIFICATE and spec["expires_at"] is None:
            continue
        items.append(spec)
    return items


def _resource_group(arm_id: str) -> Optional[str]:
    parts = (arm_id or "").split("/")
    for i, part in enumerate(parts[:-1]):
        if part.lower() == "resourcegroups":
            return parts[i + 1]
    return None


def _site_bindings(sub: str, token: str,
                   groups: List[str]) -> Dict[str, Optional[Dict[str, List[str]]]]:
    """Resource group (lower-cased) -> certificate thumbprint -> the hostnames
    bound to it, across every web app AND deployment slot in the group.

    Per group because an App Service certificate can only be bound by apps in
    its own resource group and region, so a group's apps are the complete set
    that could use it. None for a group that could not be read: its
    certificates' usage is then unknown, never "not in use".
    """
    out: Dict[str, Optional[Dict[str, List[str]]]] = {}
    for rg in groups:
        try:
            sites = rest.get_all(
                f"{rest.ARM}/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/sites",
                token, {"api-version": "2022-09-01", "includeSlots": "true"})
        except rest.AzureRestError as exc:
            logger.info("Web apps in %s unreadable: %s", rg, exc)
            out[rg.lower()] = None
            continue
        bound: Dict[str, List[str]] = {}
        for site in sites:
            for state in (site.get("properties") or {}).get("hostNameSslStates") or []:
                thumb = (state.get("thumbprint") or "").upper()
                if thumb and (state.get("sslState") or "").lower() != "disabled":
                    bound.setdefault(thumb, []).append(f"{site.get('name')}: {state.get('name')}")
        out[rg.lower()] = bound
    return out


def _app_service(sub: str, token: str) -> Dict[str, Any]:
    try:
        rows = rest.get_all(f"{rest.ARM}/subscriptions/{sub}/providers/Microsoft.Web/certificates",
                            token, {"api-version": "2022-09-01"})
    except rest.AzureRestError as exc:
        status, perm, fix = _classify_arm(exc, "Microsoft.Web/certificates/read")
        return scope_result(SOURCE_APP_SERVICE, sub, status, scope_label="App Service",
                            error_detail=str(exc), missing_permission=perm, remediation=fix)
    groups = sorted({g for g in (_resource_group(c.get("id")) for c in rows) if g},
                    key=str.lower)
    bindings = _site_bindings(sub, token, groups) if groups else {}
    items = []
    for c in rows:
        p = c.get("properties") or {}
        expires = as_utc(p.get("expirationDate"))
        if expires is None:
            continue
        rg = _resource_group(c.get("id"))
        group_bindings = bindings.get((rg or "").lower())
        thumb = (p.get("thumbprint") or "").upper()
        if group_bindings is None or not thumb:
            in_use, in_use_by = None, []
        else:
            in_use_by = group_bindings.get(thumb, [])
            in_use = bool(in_use_by)
        items.append({
            "kind": KIND_CERTIFICATE, "object_key": (c.get("id") or "").lower(),
            "name": c.get("name"), "container_name": "App Service",
            "region": c.get("location"), "subject": p.get("subjectName"),
            "issuer": p.get("issuer"), "dns_names": list(p.get("hostNames") or [])[:50],
            "not_before": as_utc(p.get("issueDate")), "expires_at": expires,
            # An App Service Managed Certificate carries its canonical name and
            # is renewed by the platform; an uploaded one is not.
            "managed_renewal": True if p.get("canonicalName") else None,
            "in_use": in_use, "in_use_by": in_use_by[:20],
            "details": {"thumbprint": p.get("thumbprint"),
                        "key_vault_id": p.get("keyVaultId"),
                        "server_farm_id": p.get("serverFarmId"),
                        "resource_group": rg,
                        "usage_source": ("web apps and slots in its resource group"
                                         if in_use is not None else None)},
        })
    return scope_result(SOURCE_APP_SERVICE, sub, COLLECT_OK, items=items,
                        scope_label="App Service")


def _app_gateways(sub: str, token: str) -> Dict[str, Any]:
    try:
        gateways = rest.get_all(
            f"{rest.ARM}/subscriptions/{sub}/providers/Microsoft.Network/applicationGateways",
            token, {"api-version": "2023-09-01"})
    except rest.AzureRestError as exc:
        status, perm, fix = _classify_arm(exc, "Microsoft.Network/applicationGateways/read")
        return scope_result(SOURCE_APP_GATEWAY, sub, status, scope_label="Application Gateway",
                            error_detail=str(exc), missing_permission=perm, remediation=fix)
    items = []
    kv_referenced = 0
    unreadable: List[str] = []
    for gw in gateways:
        p = gw.get("properties") or {}
        used = set()
        for listener in p.get("httpListeners") or []:
            ref = ((listener.get("properties") or {}).get("sslCertificate") or {}).get("id")
            if ref:
                used.add(ref.lower())
        for cert in p.get("sslCertificates") or []:
            cp = cert.get("properties") or {}
            cid = (cert.get("id") or "").lower()
            parsed = parse_public_certificate(cp.get("publicCertData"))
            if parsed is None:
                # A Key Vault reference carries no certificate here (it is
                # read from the vault). Anything else that will not parse is
                # a gap, named on the store — never silently dropped.
                if cp.get("keyVaultSecretId"):
                    kv_referenced += 1
                elif cp.get("publicCertData"):
                    unreadable.append(f"{gw.get('name')}/{cert.get('name')}")
                continue
            items.append({
                "kind": KIND_CERTIFICATE, "object_key": cid,
                "name": cert.get("name"), "container_name": gw.get("name"),
                "container_key": (gw.get("id") or "").lower(), "region": gw.get("location"),
                "subject": parsed["subject"], "issuer": parsed["issuer"],
                "dns_names": parsed["dns_names"], "key_algorithm": parsed["key_algorithm"],
                "not_before": parsed["not_before"], "expires_at": parsed["not_after"],
                "managed_renewal": False, "in_use": cid in used,
                "details": {"store": "Application Gateway"},
            })
    return scope_result(SOURCE_APP_GATEWAY, sub, COLLECT_OK, items=items,
                        scope_label="Application Gateway",
                        container={"key_vault_referenced": kv_referenced,
                                   "unreadable_certificates": len(unreadable)},
                        error_detail=unreadable_note(unreadable))


def collect(credentials: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every Azure scope for this subscription, attempted. Never raises."""
    from azure.identity import ClientSecretCredential

    sub = credentials["subscription_id"]
    cred = ClientSecretCredential(tenant_id=credentials["tenant_id"],
                                  client_id=credentials["client_id"],
                                  client_secret=credentials["client_secret"])
    try:
        arm = rest.bearer(cred)
    except Exception as exc:  # noqa: BLE001
        return [scope_result(SOURCE_VAULTS, sub, COLLECT_AUTH_FAILED, scope_label="Key Vaults",
                             error_detail=str(exc),
                             remediation="The service principal could not sign in.")]

    # Effective permissions, so an empty listing from a principal that may not
    # see the resource type is not mistaken for "there are none".
    perms: Optional[List[Dict[str, Any]]] = None
    try:
        perms = rest.get_all(f"{rest.ARM}/subscriptions/{sub}/providers/"
                             "Microsoft.Authorization/permissions", arm,
                             {"api-version": "2022-04-01"})
    except rest.AzureRestError as exc:
        logger.info("Effective permissions unreadable for %s: %s", sub, exc)

    def _may(action: str) -> Optional[bool]:
        return None if perms is None else allowed(perms, action)

    results: List[Dict[str, Any]] = []

    # ── Vaults ──────────────────────────────────────────────────────────────
    vaults: List[Dict[str, Any]] = []
    if _may("Microsoft.KeyVault/vaults/read") is False:
        results.append(scope_result(
            SOURCE_VAULTS, sub, COLLECT_PERMISSION_DENIED, scope_label="Key Vaults",
            missing_permission="Microsoft.KeyVault/vaults/read",
            error_detail="The principal's effective permissions do not include "
                         "Microsoft.KeyVault/vaults/read, so an empty vault list would "
                         "not mean there are no vaults.",
            remediation="Grant the Reader role at subscription scope."))
    else:
        try:
            raw = rest.get_all(f"{rest.ARM}/subscriptions/{sub}/providers/"
                               "Microsoft.KeyVault/vaults", arm, {"api-version": "2023-07-01"})
            for v in raw:
                p = v.get("properties") or {}
                if not p.get("vaultUri"):
                    continue
                vaults.append({
                    "id": (v.get("id") or "").lower(), "name": v.get("name"),
                    "location": v.get("location"), "uri": p.get("vaultUri"),
                    "properties": {
                        "vault_name": v.get("name"),
                        "vault_id": (v.get("id") or "").lower(),
                        "location": v.get("location"),
                        # Soft delete is mandatory on new vaults, but older ones
                        # may still report false; absent is recorded as None.
                        "soft_delete": p.get("enableSoftDelete"),
                        "soft_delete_retention_days": p.get("softDeleteRetentionInDays"),
                        "purge_protection": p.get("enablePurgeProtection"),
                        "rbac_authorization": p.get("enableRbacAuthorization"),
                        "public_network_access": p.get("publicNetworkAccess"),
                        "network_default_action": (p.get("networkAcls") or {}).get(
                            "defaultAction"),
                    },
                })
            results.append(scope_result(SOURCE_VAULTS, sub, COLLECT_OK, scope_label="Key Vaults",
                                        container={"vaults": len(vaults)}))
        except rest.AzureRestError as exc:
            status, perm, fix = _classify_arm(exc, "Microsoft.KeyVault/vaults/read")
            results.append(scope_result(SOURCE_VAULTS, sub, status, scope_label="Key Vaults",
                                        error_detail=str(exc), missing_permission=perm,
                                        remediation=fix))

    # ── Vault contents (data plane) ─────────────────────────────────────────
    if vaults:
        try:
            vault_token = rest.bearer(cred, rest.VAULT_SCOPE)
        except Exception as exc:  # noqa: BLE001
            vault_token = None
            for v in vaults:
                for kind, source in SOURCE_KV.items():
                    results.append(scope_result(
                        source, v["id"], COLLECT_AUTH_FAILED, scope_label=v["name"],
                        error_detail=f"No Key Vault token: {exc}", container=v["properties"]))
        if vault_token:
            def _one(args):
                v, kind = args
                source = SOURCE_KV[kind]
                try:
                    items = _kv_items(v, kind, vault_token)
                    return scope_result(source, v["id"], COLLECT_OK, items=items,
                                        scope_label=v["name"], container=v["properties"])
                except rest.AzureRestError as exc:
                    status, perm, fix = _classify_data_plane(
                        exc, kind, v["properties"].get("rbac_authorization"))
                    return scope_result(source, v["id"], status, scope_label=v["name"],
                                        error_detail=str(exc), missing_permission=perm,
                                        remediation=fix, container=v["properties"])

            work = [(v, kind) for v in vaults for kind in SOURCE_KV]
            with ThreadPoolExecutor(max_workers=_CONCURRENCY,
                                    thread_name_prefix="azure-kv") as pool:
                results.extend(pool.map(_one, work))

    # ── App Service and Application Gateway ─────────────────────────────────
    if _may("Microsoft.Web/certificates/read") is False:
        results.append(scope_result(
            SOURCE_APP_SERVICE, sub, COLLECT_PERMISSION_DENIED, scope_label="App Service",
            missing_permission="Microsoft.Web/certificates/read",
            remediation="Grant the Reader role at subscription scope."))
    else:
        results.append(_app_service(sub, arm))
    if _may("Microsoft.Network/applicationGateways/read") is False:
        results.append(scope_result(
            SOURCE_APP_GATEWAY, sub, COLLECT_PERMISSION_DENIED,
            scope_label="Application Gateway",
            missing_permission="Microsoft.Network/applicationGateways/read",
            remediation="Grant the Reader role at subscription scope."))
    else:
        results.append(_app_gateways(sub, arm))
    return results
