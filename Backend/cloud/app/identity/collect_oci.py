"""OCI identity collection: users, groups, dynamic groups, policies, credentials.

The OCI scanner already collects `IAMGroup` and `IAMPolicy` as resources,
because the Security Center's policy rules needed them. CIEM needs the
principals themselves — users, their group memberships, their API signing keys
and auth tokens — and the dynamic groups, which are the mechanism by which a
compute instance becomes a principal.

Three things about OCI shape this module:

**Dynamic groups are workload identities with no credential.** A dynamic group
is a matching rule over instance OCIDs; any instance the rule matches can call
the API as that group. There is no key to rotate and no last-used date on the
group itself, so dormancy for a dynamic group is UNKNOWN by construction — and
the matching rule is carried as evidence, because "which instances are in this
group?" is the question an operator actually asks.

**An API key's secret half never leaves the customer.** OCI publishes only the
key's MD5 fingerprint, which is exactly what §36 asks for — an identifier that
cannot be used to authenticate. That is what is stored.

**MFA is reported, and only for users.** `is_mfa_activated` is a real field on
an OCI user, so unlike Azure this platform can answer the MFA question for OCI
without a second API. Dynamic groups and groups get NOT_APPLICABLE.

Collection is tenancy-scoped: OCI IAM lives in the home region, and listing
users from a non-home region returns an authorization error that reads like a
permission problem. The caller passes the home region; where it is unknown the
error is recorded verbatim rather than being retried blindly across regions.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from app.identity.model import (
    ACTOR_GROUP, ACTOR_HUMAN, ACTOR_WORKLOAD, CRED_OCI_API_KEY, CRED_OCI_AUTH_TOKEN,
    CRED_OCI_SECRET_KEY, MFA_DISABLED, MFA_ENABLED, MFA_NOT_APPLICABLE, MFA_UNKNOWN,
    OCI, OCI_DYNAMIC_GROUP, OCI_FEDERATED_USER, OCI_GROUP, OCI_USER, STATUS_ACTIVE,
    STATUS_DISABLED, STATUS_UNKNOWN, identity_key,
)
from app.models.identity_grant import (
    COLLECT_AUTH_FAILED, COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE,
)

logger = logging.getLogger("cloud_svc.identity.oci")

REQUIRED_POLICY = "Allow group <this-group> to inspect users, groups, dynamic-groups, " \
                  "policies in tenancy"


def _classify_error(exc: BaseException) -> Tuple[str, Optional[str]]:
    status_code = getattr(exc, "status", None)
    message = str(exc)
    if status_code in (401,):
        return COLLECT_AUTH_FAILED, None
    if status_code in (403, 404) or "NotAuthorizedOrNotFound" in message:
        # OCI deliberately conflates "forbidden" and "absent" to avoid
        # disclosing existence. For a tenancy-level list call the realistic
        # cause is always the former.
        return COLLECT_PERMISSION_DENIED, REQUIRED_POLICY
    return COLLECT_UNAVAILABLE, None


def _as_dt(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _paginate(call: Callable, *args: Any, **kwargs: Any) -> List[Any]:
    """Walk an OCI list endpoint. Uses the SDK pagination helper when present."""
    try:
        import oci
        return list(oci.pagination.list_call_get_all_results(call, *args, **kwargs).data)
    except Exception:  # noqa: BLE001 — fall back to a single page
        return list(call(*args, **kwargs).data or [])


def collect(auth, *, tenancy_ocid: str, account_key: str,
            include_credentials: bool = True) -> Dict[str, Any]:
    """Collect the OCI principal estate for one tenancy. Never raises."""
    result: Dict[str, Any] = {
        "provider": OCI,
        "status": COLLECT_OK,
        "identities": [],
        "memberships": [],
        "policies": [],
        "trust": [],
        "errors": [],
        "error_detail": None,
        "missing_permission": None,
        "partial": False,
    }

    try:
        import oci as oci_sdk
        identity = oci_sdk.identity.IdentityClient(auth.get_config(),
                                                   signer=auth.get_signer())
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result.update(status=status, error_detail=str(exc)[:2000],
                      missing_permission=permission)
        return result

    by_key: Dict[str, Dict[str, Any]] = {}
    ocid_to_key: Dict[str, str] = {}

    # ── Users ────────────────────────────────────────────────────────────────
    try:
        for user in _paginate(identity.list_users, tenancy_ocid):
            entry = _identity_from_user(user, account_key=account_key)
            by_key[entry["identity_key"]] = entry
            ocid_to_key[entry["provider_id"]] = entry["identity_key"]
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result["errors"].append({"stage": "list_users", "status": status,
                                 "detail": str(exc)[:1000],
                                 "missing_permission": permission})

    # ── Groups ───────────────────────────────────────────────────────────────
    group_keys: Dict[str, str] = {}
    try:
        for group in _paginate(identity.list_groups, tenancy_ocid):
            entry = _identity_from_group(group, account_key=account_key)
            by_key[entry["identity_key"]] = entry
            ocid_to_key[entry["provider_id"]] = entry["identity_key"]
            group_keys[entry["provider_id"]] = entry["identity_key"]
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result["errors"].append({"stage": "list_groups", "status": status,
                                 "detail": str(exc)[:1000],
                                 "missing_permission": permission})

    # ── Dynamic groups ───────────────────────────────────────────────────────
    try:
        for dgroup in _paginate(identity.list_dynamic_groups, tenancy_ocid):
            entry = _identity_from_dynamic_group(dgroup, account_key=account_key)
            by_key[entry["identity_key"]] = entry
            ocid_to_key[entry["provider_id"]] = entry["identity_key"]
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result["errors"].append({"stage": "list_dynamic_groups", "status": status,
                                 "detail": str(exc)[:1000],
                                 "missing_permission": permission})

    # ── Memberships ──────────────────────────────────────────────────────────
    for group_ocid, container_key in group_keys.items():
        try:
            memberships = _paginate(identity.list_user_group_memberships,
                                    tenancy_ocid, group_id=group_ocid)
        except Exception as exc:  # noqa: BLE001
            status, permission = _classify_error(exc)
            result["errors"].append({"stage": "list_user_group_memberships",
                                     "status": status, "detail": str(exc)[:500],
                                     "missing_permission": permission})
            continue
        for membership in memberships:
            member_key = ocid_to_key.get(getattr(membership, "user_id", "") or "")
            if member_key:
                result["memberships"].append({
                    "member_identity_key": member_key,
                    "container_identity_key": container_key,
                    "membership_kind": "GROUP_MEMBER",
                })

    # ── Credentials ──────────────────────────────────────────────────────────
    if include_credentials:
        for key, entry in by_key.items():
            if entry["identity_type"] != OCI_USER:
                continue
            _collect_user_credentials(identity, entry, result)

    # ── Policies ─────────────────────────────────────────────────────────────
    try:
        for policy in _paginate(identity.list_policies, tenancy_ocid):
            statements = list(getattr(policy, "statements", None) or [])
            result["policies"].append({
                "identity_key": None,   # resolved per-subject by the analyser
                "policy_key": getattr(policy, "id", ""),
                "policy_name": getattr(policy, "name", None),
                "policy_type": "IAMPolicy",
                "policy_stage": "oci_policy_statement",
                "scope": getattr(policy, "compartment_id", None),
                "document": {"statements": statements},
                "compartment_id": getattr(policy, "compartment_id", None),
            })
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result["errors"].append({"stage": "list_policies", "status": status,
                                 "detail": str(exc)[:1000],
                                 "missing_permission": permission})

    # ── Federation ───────────────────────────────────────────────────────────
    try:
        for provider in _paginate(identity.list_identity_providers,
                                  protocol="SAML2", compartment_id=tenancy_ocid):
            result["trust"].append({
                "target_key": tenancy_ocid,
                "target_name": "tenancy",
                "source_principal": getattr(provider, "id", ""),
                "source_type": "identity_provider",
                "trust_kind": "FEDERATION",
                "evidence": {
                    "name": getattr(provider, "name", None),
                    "description": getattr(provider, "description", None),
                    "protocol": getattr(provider, "protocol", None),
                    "product_type": getattr(provider, "product_type", None),
                },
            })
    except Exception as exc:  # noqa: BLE001
        status, permission = _classify_error(exc)
        result["errors"].append({"stage": "list_identity_providers", "status": status,
                                 "detail": str(exc)[:500],
                                 "missing_permission": permission})

    result["identities"] = list(by_key.values())
    if result["errors"] and not result["identities"]:
        worst = result["errors"][0]
        result.update(status=worst["status"], error_detail=worst["detail"],
                      missing_permission=worst.get("missing_permission"))
    elif result["errors"]:
        result["partial"] = True
    return result


def _identity_from_user(user: Any, *, account_key: str) -> Dict[str, Any]:
    ocid = getattr(user, "id", "") or ""
    state = (getattr(user, "lifecycle_state", "") or "").upper()
    mfa = getattr(user, "is_mfa_activated", None)
    # A federated user is identified by its identity-provider link; its
    # credentials live elsewhere, so it is a distinct type.
    external_id = getattr(user, "external_identifier", None)
    identity_type = OCI_FEDERATED_USER if external_id else OCI_USER
    return {
        "identity_type": identity_type,
        "provider_id": ocid,
        "identity_key": identity_key(provider=OCI, account_id=account_key,
                                     identity_type=identity_type, provider_id=ocid),
        "name": getattr(user, "name", None),
        "principal_name": getattr(user, "email", None) or getattr(user, "name", None),
        "description": getattr(user, "description", None),
        "actor_class": ACTOR_HUMAN,
        "status": STATUS_ACTIVE if state == "ACTIVE"
                  else STATUS_DISABLED if state in ("INACTIVE", "DELETED")
                  else STATUS_UNKNOWN,
        "created_at_provider": _as_dt(getattr(user, "time_created", None)),
        # OCI does not publish a last-sign-in time on the user object. Left
        # null and flagged, so dormancy reads UNKNOWN unless the Event Log
        # supplies activity.
        "last_used_at": None,
        "last_used_source": None,
        "mfa_state": MFA_ENABLED if mfa is True
                     else MFA_DISABLED if mfa is False else MFA_UNKNOWN,
        "mfa_detail": {"is_mfa_activated": mfa, "source": "identity.list_users"},
        "credentials": [],
        "compartment_id": getattr(user, "compartment_id", None),
        "provider_detail": {
            "capabilities": _capabilities(getattr(user, "capabilities", None)),
            "identity_provider_id": getattr(user, "identity_provider_id", None),
            "external_identifier": external_id,
            "email_verified": getattr(user, "email_verified", None),
            "is_mfa_activated": mfa,
            "lifecycle_state": state,
            "defined_tags": getattr(user, "defined_tags", None),
        },
        "provider_reports_last_used": False,
        "provider_reports_mfa": True,
    }


def _identity_from_group(group: Any, *, account_key: str) -> Dict[str, Any]:
    ocid = getattr(group, "id", "") or ""
    return {
        "identity_type": OCI_GROUP,
        "provider_id": ocid,
        "identity_key": identity_key(provider=OCI, account_id=account_key,
                                     identity_type=OCI_GROUP, provider_id=ocid),
        "name": getattr(group, "name", None),
        "principal_name": getattr(group, "name", None),
        "description": getattr(group, "description", None),
        "actor_class": ACTOR_GROUP,
        "status": STATUS_ACTIVE,
        "created_at_provider": _as_dt(getattr(group, "time_created", None)),
        "mfa_state": MFA_NOT_APPLICABLE,
        "credentials": [],
        "compartment_id": getattr(group, "compartment_id", None),
        "provider_detail": {"lifecycle_state": getattr(group, "lifecycle_state", None)},
        "provider_reports_last_used": False,
        "provider_reports_mfa": False,
    }


def _identity_from_dynamic_group(group: Any, *, account_key: str) -> Dict[str, Any]:
    ocid = getattr(group, "id", "") or ""
    rule = getattr(group, "matching_rule", None)
    return {
        "identity_type": OCI_DYNAMIC_GROUP,
        "provider_id": ocid,
        "identity_key": identity_key(provider=OCI, account_id=account_key,
                                     identity_type=OCI_DYNAMIC_GROUP, provider_id=ocid),
        "name": getattr(group, "name", None),
        "principal_name": getattr(group, "name", None),
        "description": getattr(group, "description", None),
        "actor_class": ACTOR_WORKLOAD,
        "status": STATUS_ACTIVE,
        "created_at_provider": _as_dt(getattr(group, "time_created", None)),
        "mfa_state": MFA_NOT_APPLICABLE,
        "credentials": [],
        "compartment_id": getattr(group, "compartment_id", None),
        "provider_detail": {
            # The rule IS the membership. Carried verbatim so "which instances
            # are in this group?" has an answer an operator can check.
            "matching_rule": rule,
            "lifecycle_state": getattr(group, "lifecycle_state", None),
        },
        "match_rule": rule,
        "provider_reports_last_used": False,
        "provider_reports_mfa": False,
    }


def _collect_user_credentials(identity_client: Any, entry: Dict[str, Any],
                              result: Dict[str, Any]) -> None:
    """API keys, auth tokens and secret keys for one user.

    Only public identifiers are stored: an API key's fingerprint, a token's
    OCID. No secret material is retrievable from these endpoints and none is
    kept.
    """
    user_ocid = entry["provider_id"]

    for call, kind, ref_attr in (
        (identity_client.list_api_keys, CRED_OCI_API_KEY, "fingerprint"),
        (identity_client.list_auth_tokens, CRED_OCI_AUTH_TOKEN, "id"),
        (identity_client.list_customer_secret_keys, CRED_OCI_SECRET_KEY, "id"),
    ):
        try:
            items = list(call(user_ocid).data or [])
        except Exception as exc:  # noqa: BLE001
            status, permission = _classify_error(exc)
            result["errors"].append({
                "stage": getattr(call, "__name__", "list_credentials"),
                "status": status, "detail": str(exc)[:500],
                "missing_permission": permission,
            })
            continue
        for item in items:
            ref = getattr(item, ref_attr, None) or getattr(item, "id", "")
            state = (getattr(item, "lifecycle_state", "") or "").upper()
            entry["credentials"].append({
                "credential_ref": str(ref),
                "credential_kind": kind,
                "fingerprint": getattr(item, "fingerprint", None),
                "status": STATUS_ACTIVE if state in ("ACTIVE", "") else STATUS_DISABLED,
                "created_at_provider": _as_dt(getattr(item, "time_created", None)),
                "expires_at": _as_dt(getattr(item, "time_expires", None)),
                # OCI publishes no last-used date for any of these. Null, and
                # `never_used` left None — the provider has not said either way,
                # so neither does this platform.
                "last_used_at": None,
                "never_used": None,
                "provider_detail": {
                    "lifecycle_state": state,
                    "display_name": getattr(item, "display_name", None),
                    "inactive_status": getattr(item, "inactive_status", None),
                },
            })


def _capabilities(capabilities: Any) -> Optional[Dict[str, Any]]:
    """An OCI user's capability flags, which decide what credentials it may hold."""
    if capabilities is None:
        return None
    return {
        "can_use_console_password": getattr(capabilities, "can_use_console_password", None),
        "can_use_api_keys": getattr(capabilities, "can_use_api_keys", None),
        "can_use_auth_tokens": getattr(capabilities, "can_use_auth_tokens", None),
        "can_use_smtp_credentials": getattr(capabilities, "can_use_smtp_credentials", None),
        "can_use_customer_secret_keys": getattr(
            capabilities, "can_use_customer_secret_keys", None),
        "can_use_o_auth2_client_credentials": getattr(
            capabilities, "can_use_o_auth2_client_credentials", None),
    }
