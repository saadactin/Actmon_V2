"""OCI certificates and secrets: the Certificates service, Vault secrets, and
certificates uploaded directly to load balancers.

The last one matters more than it looks. OCI load balancers predate the
Certificates service and accept a PEM certificate uploaded straight onto the
balancer; front ends for packaged applications (Oracle EBS among them) very
often still terminate TLS that way, and nothing in OCI warns before such a
certificate lapses. The balancers come from the account's own inventory, so
this collector adds one listing call per balancer and no discovery of its own.

Listing is per region × compartment, exactly like the inventory scanner, and
with its client settings (a fresh client per call, bounded retry, low
concurrency) — those were measured on this network and anything more
aggressive produced incomplete sweeps. A region counts as read only when every
compartment in it answered; otherwise its previous objects are kept.

Blocking SDK calls; callers run this in the executor.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Sequence, Tuple

import oci

from app.models.credential_inventory import (
    COLLECT_AUTH_FAILED, COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE,
    KIND_CERTIFICATE, KIND_SECRET,
)
from app.providers.credential_common import (
    as_utc, parse_public_certificate, scope_result, status_from_text, unreadable_note,
)
from app.providers.oci.oci_auth import OCIAuth

logger = logging.getLogger("cloud_svc.oci.credentials")

SOURCE_CERTIFICATES = "oci:certificates"
SOURCE_SECRETS = "oci:vault-secrets"
SOURCE_LB_CERTS = "oci:load-balancer-certificates"

_CLIENT_TIMEOUT = (10, 60)
_CONCURRENCY = 4
_GONE = {"DELETED", "PENDING_DELETION", "SCHEDULING_DELETION", "DELETING", "FAILED"}

_POLICY = {
    SOURCE_CERTIFICATES: "inspect certificates / read certificate-family",
    SOURCE_SECRETS: "inspect secret-family",
    SOURCE_LB_CERTS: "read load-balancers",
}


def _retry():
    try:
        return (oci.retry.RetryStrategyBuilder().add_max_attempts(max_attempts=2)
                .add_total_elapsed_time(total_elapsed_time_seconds=20).get_retry_strategy())
    except Exception:  # noqa: BLE001
        return oci.retry.NoneRetryStrategy()


def _client(config: Dict[str, Any], cls, region: str):
    cfg = dict(config)
    cfg["region"] = region
    return cls(cfg, timeout=_CLIENT_TIMEOUT, retry_strategy=_retry())


def _classify(source: str, exc: BaseException) -> Tuple[str, Optional[str], Optional[str]]:
    status = getattr(exc, "status", None)
    code = str(getattr(exc, "code", "") or "")
    if status == 401 or code == "NotAuthenticated":
        return COLLECT_AUTH_FAILED, None, "The stored OCI API key was rejected."
    if status in (403, 404) and code in ("NotAuthorizedOrNotFound", "NotAuthorized",
                                         "Forbidden"):
        verb = _POLICY.get(source)
        return (COLLECT_PERMISSION_DENIED, verb,
                f"Allow the Actmon user's group to {verb} in the tenancy — for example "
                f"'Allow group <group> to {verb.split(' / ')[0]} in tenancy'.")
    status_guess = status_from_text(str(exc))
    return status_guess, None, None


def _all(fn, *args, **kwargs) -> List[Any]:
    """Every page of an OCI list call, whether it returns a list or a collection."""
    out: List[Any] = []
    page = None
    for _ in range(500):
        resp = fn(*args, page=page, **kwargs) if page else fn(*args, **kwargs)
        data = resp.data
        items = getattr(data, "items", None) if not isinstance(data, list) else data
        out.extend(items or [])
        page = resp.headers.get("opc-next-page") if hasattr(resp, "headers") else None
        if not page:
            return out
    return out


def _certificate_spec(c, region: str) -> Optional[Dict[str, Any]]:
    if (getattr(c, "lifecycle_state", "") or "").upper() in _GONE:
        return None
    version = getattr(c, "current_version_summary", None)
    validity = getattr(version, "validity", None) if version else None
    expires = as_utc(getattr(validity, "time_of_validity_not_after", None))
    if expires is None:
        return None
    subject = getattr(c, "subject", None)
    config_type = getattr(c, "config_type", None)
    rules = getattr(c, "certificate_rules", None) or []
    renews = any("renewal" in (getattr(r, "rule_type", "") or "").lower() for r in rules)
    return {
        "kind": KIND_CERTIFICATE,
        "object_key": c.id,
        "name": c.name,
        "region": region,
        "subject": getattr(subject, "common_name", None) if subject else None,
        "key_algorithm": getattr(c, "key_algorithm", None),
        "not_before": as_utc(getattr(validity, "time_of_validity_not_before", None)),
        "expires_at": expires,
        "status": getattr(c, "lifecycle_state", None),
        # Only certificates Oracle's own CA issues can renew themselves, and
        # only when a renewal rule is set. An imported one never renews.
        "managed_renewal": (False if config_type == "IMPORTED"
                            else (True if renews else None)),
        "details": {"config_type": config_type,
                    "compartment_id": getattr(c, "compartment_id", None),
                    "stages": list(getattr(version, "stages", None) or []) if version else []},
    }


def _secret_spec(s, region: str) -> Optional[Dict[str, Any]]:
    if (getattr(s, "lifecycle_state", "") or "").upper() in _GONE:
        return None
    rotation = getattr(s, "rotation_config", None)
    interval_days = None
    if rotation is not None:
        interval = str(getattr(rotation, "rotation_interval", "") or "")
        if interval.upper().startswith("P") and interval.upper().endswith("D"):
            try:
                interval_days = int(interval[1:-1])
            except ValueError:
                interval_days = None
    return {
        "kind": KIND_SECRET,
        "object_key": s.id,
        "name": getattr(s, "secret_name", None),
        "container_key": getattr(s, "vault_id", None),
        "region": region,
        "expires_at": as_utc(getattr(s, "time_of_current_version_expiry", None)),
        "status": getattr(s, "lifecycle_state", None),
        "rotation_enabled": (bool(getattr(rotation, "is_scheduled_rotation_enabled", False))
                             if rotation is not None else None),
        "rotation_interval_days": interval_days,
        "last_rotated_at": as_utc(getattr(s, "last_rotation_time", None)),
        "next_rotation_at": as_utc(getattr(s, "next_rotation_time", None)),
        "details": {"compartment_id": getattr(s, "compartment_id", None),
                    "rotation_status": getattr(s, "rotation_status", None)},
    }


def _region_listing(config, region: str, compartments: Sequence[str], source: str
                    ) -> Dict[str, Any]:
    """One (source, region) scope: every compartment, or the scope fails."""
    items: List[Dict[str, Any]] = []
    try:
        if source == SOURCE_CERTIFICATES:
            client = _client(config, oci.certificates_management.CertificatesManagementClient,
                             region)
            for cid in compartments:
                for c in _all(client.list_certificates, compartment_id=cid):
                    spec = _certificate_spec(c, region)
                    if spec:
                        items.append(spec)
        else:
            client = _client(config, oci.vault.VaultsClient, region)
            for cid in compartments:
                for s in _all(client.list_secrets, cid):
                    spec = _secret_spec(s, region)
                    if spec:
                        items.append(spec)
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(source, exc)
        return scope_result(source, region, status, scope_label=region,
                            error_detail=str(exc), missing_permission=perm, remediation=fix)
    return scope_result(source, region, COLLECT_OK, items=items, scope_label=region)


def _lb_usage(client, lb: Dict[str, Any]) -> Optional[Dict[str, List[str]]]:
    """Certificate name -> what on this load balancer serves it, read live
    from its listeners (TLS to clients) and backend sets (TLS to backends).

    Read at collection time rather than taken from the last discovery: the
    stored listener map is only as fresh as the last full scan, and for
    inventory scanned before it existed it is missing altogether, which left
    every KOEL certificate's usage "Unknown". None when the balancer could not
    be read — the caller then falls back to the stored map, or to unknown.
    """
    try:
        data = client.get_load_balancer(lb["ocid"]).data
    except Exception as exc:  # noqa: BLE001 — usage degrades, the listing does not
        logger.info("Listeners of %s unreadable: %s", lb.get("name"), exc)
        return None
    usage: Dict[str, List[str]] = {}
    for name, listener in (getattr(data, "listeners", None) or {}).items():
        ssl = getattr(listener, "ssl_configuration", None)
        cert = getattr(ssl, "certificate_name", None) if ssl else None
        if cert:
            usage.setdefault(cert, []).append(
                f"Listener {name} (port {getattr(listener, 'port', '?')})")
    for name, backend in (getattr(data, "backend_sets", None) or {}).items():
        ssl = getattr(backend, "ssl_configuration", None)
        cert = getattr(ssl, "certificate_name", None) if ssl else None
        if cert:
            usage.setdefault(cert, []).append(f"Backend set {name} (TLS to backends)")
    return usage


def _lb_region(config, region: str, balancers: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    unreadable: List[str] = []
    try:
        client = _client(config, oci.load_balancer.LoadBalancerClient, region)
        for lb in balancers:
            used = set(lb.get("certificate_names_in_use") or [])
            live = _lb_usage(client, lb)
            for cert in _all(client.list_certificates, lb["ocid"]):
                parsed = parse_public_certificate(getattr(cert, "public_certificate", None))
                if parsed is None:
                    # Named on the store below rather than dropped: a
                    # certificate whose expiry cannot be read is a gap.
                    unreadable.append(f"{lb.get('name')}/{cert.certificate_name}")
                    continue
                name = cert.certificate_name
                if live is not None:
                    in_use, in_use_by = name in live, live.get(name, [])
                elif lb.get("listeners_known"):
                    in_use, in_use_by = name in used, []
                else:
                    in_use, in_use_by = None, []
                items.append({
                    "kind": KIND_CERTIFICATE,
                    "object_key": f"{lb['ocid']}/certificates/{name}",
                    "name": name, "container_name": lb.get("name"),
                    "container_key": lb["ocid"], "region": region,
                    "subject": parsed["subject"], "issuer": parsed["issuer"],
                    "dns_names": parsed["dns_names"], "key_algorithm": parsed["key_algorithm"],
                    "not_before": parsed["not_before"], "expires_at": parsed["not_after"],
                    # Uploaded to the balancer: nothing renews it.
                    "managed_renewal": False,
                    "in_use": in_use, "in_use_by": in_use_by,
                    "details": {"store": "Load balancer",
                                "usage_source": ("live" if live is not None else
                                                 "last discovery" if lb.get("listeners_known")
                                                 else None)},
                })
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(SOURCE_LB_CERTS, exc)
        return scope_result(SOURCE_LB_CERTS, region, status, scope_label=region,
                            error_detail=str(exc), missing_permission=perm, remediation=fix)
    return scope_result(SOURCE_LB_CERTS, region, COLLECT_OK, items=items, scope_label=region,
                        container={"load_balancers": len(balancers),
                                   "unreadable_certificates": len(unreadable)},
                        error_detail=unreadable_note(unreadable))


def collect(credentials: Dict[str, Any], *,
            load_balancers: Sequence[Dict[str, Any]] = ()) -> List[Dict[str, Any]]:
    """Every OCI scope, attempted. `load_balancers` come from the inventory:
    `[{ocid, name, region, certificate_names_in_use, listeners_known}]`.
    Never raises."""
    auth = OCIAuth(credentials)
    config = auth.get_config()
    identity = oci.identity.IdentityClient(config, timeout=_CLIENT_TIMEOUT,
                                           retry_strategy=_retry())
    try:
        regions = [s.region_name for s in identity.list_region_subscriptions(
            auth.tenancy_ocid).data if s.status == "READY"]
        compartments = [auth.tenancy_ocid] + [
            c.id for c in _all(identity.list_compartments, auth.tenancy_ocid,
                               compartment_id_in_subtree=True)
            if c.lifecycle_state == "ACTIVE"]
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(SOURCE_CERTIFICATES, exc)
        detail = f"Regions or compartments could not be listed, so nothing was read: {exc}"
        return [scope_result(src, "*", status, scope_label="All regions", error_detail=detail,
                             missing_permission=perm, remediation=fix)
                for src in (SOURCE_CERTIFICATES, SOURCE_SECRETS)]

    work: List[Tuple] = []
    for region in regions:
        work.append((_region_listing, (config, region, compartments, SOURCE_CERTIFICATES)))
        work.append((_region_listing, (config, region, compartments, SOURCE_SECRETS)))
    by_region: Dict[str, List[Dict[str, Any]]] = {}
    for lb in load_balancers:
        if lb.get("ocid") and lb.get("region"):
            by_region.setdefault(lb["region"], []).append(lb)
    for region, lbs in by_region.items():
        work.append((_lb_region, (config, region, lbs)))

    with ThreadPoolExecutor(max_workers=_CONCURRENCY, thread_name_prefix="oci-creds") as pool:
        futures = [pool.submit(fn, *args) for fn, args in work]
        return [f.result() for f in futures]
