"""AWS identity collection: users, roles, groups, credentials and trust.

The existing scanner collects IAM **roles** only, as resources, because that is
what the Security Center's role rules needed. CIEM needs the rest of the
principal estate, and it needs facts the resource shape has nowhere to put —
when a key was last used, whether MFA is registered, which groups a user is in.

**The credential report is the primary source, and that is a deliberate
choice.** `iam:GenerateCredentialReport` produces one CSV covering every user in
the account with password state, MFA registration, per-key creation and
last-used dates, and the root account — all of it in two API calls. Assembling
the same picture from `list_users` + `list_access_keys` + `get_access_key_last_used`
+ `list_mfa_devices` costs roughly 4N calls, and on an account with 400 users
that is 1,600 calls into a throttled API for data the report already has. The
per-user calls remain as a fallback for the case where the report is refused.

**It is also the only way to see the root account.** There is no `GetUser` for
root; the credential report's `<root_account>` row is where its MFA state and
last-used dates live, and root is the one identity in an AWS account that no
policy can constrain — so being unable to report on it would be a serious gap.

Nothing here raises. A refusal is data: which action was denied, so the
identity tab can say "not assessed, and here is the permission to grant"
instead of showing a reassuring empty list. That is the same contract
`azure_rbac.collect_role_assignments` already follows.
"""
from __future__ import annotations

import csv
import io
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from app.identity.model import (
    ACTOR_HUMAN, ACTOR_WORKLOAD, AWS, AWS_IAM_GROUP, AWS_IAM_ROLE, AWS_IAM_USER,
    AWS_ROOT, CRED_AWS_ACCESS_KEY, CRED_AWS_LOGIN_PROFILE, MFA_DISABLED, MFA_ENABLED,
    MFA_NOT_APPLICABLE, MFA_UNKNOWN, STATUS_ACTIVE, STATUS_DISABLED, identity_key,
)
from app.models.identity_grant import (
    COLLECT_AUTH_FAILED, COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE,
)

logger = logging.getLogger("cloud_svc.identity.aws")

# The IAM actions this collector calls, so a denial names the permission to
# grant rather than leaving an operator to guess. Same convention as
# aws_scanner.SERVICE_ACTIONS.
REQUIRED_ACTIONS: Tuple[str, ...] = (
    "iam:GenerateCredentialReport", "iam:GetCredentialReport",
    "iam:ListUsers", "iam:ListRoles", "iam:ListGroups",
    "iam:ListAccessKeys", "iam:GetAccessKeyLastUsed", "iam:ListMFADevices",
    "iam:ListGroupsForUser", "iam:ListAttachedUserPolicies", "iam:ListUserPolicies",
    "iam:ListAttachedRolePolicies", "iam:ListRolePolicies",
    "iam:ListAttachedGroupPolicies", "iam:ListGroupPolicies",
    "iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetRolePolicy",
    "iam:GetUserPolicy", "iam:GetGroupPolicy",
)

_DENIED = ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
           "AuthorizationError")
_AUTH_FAILED = ("InvalidClientTokenId", "SignatureDoesNotMatch", "ExpiredToken",
                "UnrecognizedClientException")

# The credential report's "not supported / not set" sentinels. Every one of
# these must become None, never a date and never a zero.
_NA = {"N/A", "not_supported", "no_information", "NOT_SUPPORTED", ""}


def _classify_error(exc: BaseException) -> Tuple[str, Optional[str]]:
    """`(status, missing_permission)` for a boto exception."""
    code = ""
    message = str(exc)
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = (response.get("Error") or {}).get("Code") or ""
        message = (response.get("Error") or {}).get("Message") or message
    if code in _AUTH_FAILED:
        return COLLECT_AUTH_FAILED, None
    if code in _DENIED or "not authorized" in message.lower():
        # AWS names the action it refused: "... not authorized to perform:
        # iam:ListUsers ...". That is the actionable half.
        action = None
        marker = "not authorized to perform: "
        if marker in message:
            action = message.split(marker, 1)[1].split()[0].strip(" .,")
        return COLLECT_PERMISSION_DENIED, action
    return COLLECT_UNAVAILABLE, None


def _parse_dt(value: Any) -> Optional[datetime]:
    """A timestamp, or None. Never a sentinel date."""
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if text in _NA:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _flag(value: Any) -> Optional[bool]:
    """A credential-report boolean, or None where it says nothing."""
    text = str(value).strip().lower()
    if text in ("true", "yes"):
        return True
    if text in ("false", "no"):
        return False
    return None


def fetch_credential_report(iam, *, timeout_s: float = 30.0) -> Dict[str, Any]:
    """Generate and read the account's credential report.

    Returns `{status, rows, error_detail, missing_permission}`. The report is
    generated asynchronously; AWS answers `ReportInProgress` until it is ready,
    so this polls briefly rather than failing on the first call.
    """
    try:
        deadline = time.monotonic() + timeout_s
        state = iam.generate_credential_report().get("State")
        while state in ("STARTED", "INPROGRESS") and time.monotonic() < deadline:
            time.sleep(1.0)
            state = iam.generate_credential_report().get("State")

        raw = iam.get_credential_report()["Content"]
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        rows = list(csv.DictReader(io.StringIO(text)))
        return {"status": COLLECT_OK, "rows": rows, "error_detail": None,
                "missing_permission": None}
    except Exception as exc:  # noqa: BLE001 — a refusal is data, not a crash
        status, action = _classify_error(exc)
        logger.info("AWS credential report unavailable: %s", exc)
        return {"status": status, "rows": [],
                "error_detail": str(exc)[:2000],
                "missing_permission": action or "iam:GenerateCredentialReport"}


def _identity_from_report_row(
    row: Dict[str, str], *, account_id: str, account_key: str,
) -> Optional[Dict[str, Any]]:
    """One principal (and its credentials) from a credential-report row."""
    user = (row.get("user") or "").strip()
    if not user:
        return None
    arn = (row.get("arn") or "").strip()
    is_root = user == "<root_account>"

    mfa_active = _flag(row.get("mfa_active"))
    password_enabled = _flag(row.get("password_enabled"))

    # Root always has a console login; the report reports password_enabled
    # "not_supported" for it, which must not read as "no password".
    if is_root:
        human = True
    else:
        human = password_enabled is True

    if mfa_active is True:
        mfa_state = MFA_ENABLED
    elif mfa_active is False:
        mfa_state = MFA_DISABLED if human else MFA_NOT_APPLICABLE
    else:
        mfa_state = MFA_UNKNOWN

    password_last_used = _parse_dt(row.get("password_last_used"))
    credentials: List[Dict[str, Any]] = []

    if password_enabled is True or is_root:
        credentials.append({
            "credential_ref": f"{user}:login-profile",
            "credential_kind": CRED_AWS_LOGIN_PROFILE,
            "status": STATUS_ACTIVE,
            "created_at_provider": _parse_dt(row.get("password_last_changed")),
            "last_used_at": password_last_used,
            # The report says "no_information" when the password exists but has
            # never been used; that is a genuine never, distinct from a missing
            # column. Only treat it as never when the password IS enabled.
            "never_used": (password_last_used is None
                           and str(row.get("password_last_used")).strip()
                           in ("no_information", "N/A")
                           and (password_enabled is True or is_root)) or None,
            "provider_detail": {
                "password_next_rotation": row.get("password_next_rotation"),
                "password_last_changed": row.get("password_last_changed"),
            },
        })

    for n in (1, 2):
        active = _flag(row.get(f"access_key_{n}_active"))
        if active is None:
            continue
        created = _parse_dt(row.get(f"access_key_{n}_last_rotated"))
        last_used = _parse_dt(row.get(f"access_key_{n}_last_used_date"))
        raw_last = str(row.get(f"access_key_{n}_last_used_date") or "").strip()
        if not active and created is None:
            continue
        credentials.append({
            # The report does not carry the key id, only its ordinal. The id is
            # filled in by `enrich_access_keys` where ListAccessKeys is
            # permitted; until then the ordinal is a stable, honest reference.
            "credential_ref": f"{user}:access-key-{n}",
            "credential_kind": CRED_AWS_ACCESS_KEY,
            "status": STATUS_ACTIVE if active else STATUS_DISABLED,
            "created_at_provider": created,
            "last_used_at": last_used,
            "never_used": True if raw_last in ("N/A", "no_information") and created
                          else None,
            "last_used_service": (row.get(f"access_key_{n}_last_used_service")
                                  or None) if raw_last not in _NA else None,
            "last_used_region": (row.get(f"access_key_{n}_last_used_region")
                                 or None) if raw_last not in _NA else None,
            "provider_detail": {"ordinal": n},
        })

    identity_type = AWS_ROOT if is_root else AWS_IAM_USER
    provider_id = arn or f"arn:aws:iam::{account_id}:{'root' if is_root else f'user/{user}'}"

    return {
        "identity_type": identity_type,
        "provider_id": provider_id,
        "identity_key": identity_key(provider=AWS, account_id=account_key,
                                     identity_type=identity_type,
                                     provider_id=provider_id),
        "name": "root" if is_root else user,
        "principal_name": user,
        "actor_class": ACTOR_HUMAN if human or is_root else ACTOR_WORKLOAD,
        "status": STATUS_ACTIVE,
        "created_at_provider": _parse_dt(row.get("user_creation_time")),
        "last_used_at": password_last_used,
        "last_used_source": "credential report (password_last_used)"
                            if password_last_used else None,
        "mfa_state": mfa_state,
        "mfa_detail": {
            "mfa_active": mfa_active,
            "password_enabled": password_enabled,
            "source": "iam:GetCredentialReport",
            "note": ("Root MFA is reported by the credential report; there is no "
                     "GetUser call for the root account.") if is_root else None,
        },
        "credentials": credentials,
        "provider_detail": {k: v for k, v in row.items()
                            if k.startswith("cert_") or k in (
                                "user_creation_time", "password_last_changed",
                                "password_next_rotation")},
        "provider_reports_last_used": True,
        "provider_reports_mfa": True,
    }


def collect(auth, *, account_id: str, account_key: str,
            include_policies: bool = True) -> Dict[str, Any]:
    """Collect the AWS principal estate for one account.

    Returns a dict with `status`, `identities`, `memberships`, `policies`,
    `trust`, and the diagnostics a refusal needs. Never raises.
    """
    result: Dict[str, Any] = {
        "provider": AWS,
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
        iam = auth.get_client("iam")
    except Exception as exc:  # noqa: BLE001
        status, action = _classify_error(exc)
        result.update(status=status, error_detail=str(exc)[:2000],
                      missing_permission=action)
        return result

    by_key: Dict[str, Dict[str, Any]] = {}

    # ── Users, credentials and MFA, from the credential report ───────────────
    report = fetch_credential_report(iam)
    if report["status"] == COLLECT_OK:
        for row in report["rows"]:
            identity = _identity_from_report_row(row, account_id=account_id,
                                                 account_key=account_key)
            if identity:
                by_key[identity["identity_key"]] = identity
    else:
        result["partial"] = True
        result["errors"].append({
            "stage": "credential_report", "status": report["status"],
            "detail": report["error_detail"],
            "missing_permission": report["missing_permission"],
        })
        # Fall back to the per-user calls. More expensive, same facts.
        users = _list(iam, "list_users", "Users", result, "list_users")
        for user in users:
            identity = _identity_from_user(user, account_key=account_key)
            by_key[identity["identity_key"]] = identity
        _enrich_users(iam, by_key, result)

    # ── Roles, with their trust policies ─────────────────────────────────────
    roles = _list(iam, "list_roles", "Roles", result, "list_roles")
    for role in roles:
        identity = _identity_from_role(role, account_key=account_key)
        by_key[identity["identity_key"]] = identity
        trust_doc = role.get("AssumeRolePolicyDocument")
        if trust_doc:
            result["trust"].append({
                "target_key": identity["provider_id"],
                "target_name": identity["name"],
                "document": trust_doc,
            })

    # ── Groups ───────────────────────────────────────────────────────────────
    groups = _list(iam, "list_groups", "Groups", result, "list_groups")
    group_by_name: Dict[str, str] = {}
    for group in groups:
        identity = _identity_from_group(group, account_key=account_key)
        by_key[identity["identity_key"]] = identity
        group_by_name[group.get("GroupName", "")] = identity["identity_key"]

    # ── Memberships and policies ─────────────────────────────────────────────
    if include_policies:
        policy_cache: Dict[str, Any] = {}
        for key, identity in list(by_key.items()):
            kind = identity["identity_type"]
            name = identity.get("principal_name") or identity.get("name") or ""
            if kind == AWS_IAM_USER:
                for group_name in _list(iam, "list_groups_for_user", "Groups", result,
                                        "list_groups_for_user", UserName=name):
                    container = group_by_name.get(group_name.get("GroupName", ""))
                    if container:
                        result["memberships"].append({
                            "member_identity_key": key,
                            "container_identity_key": container,
                            "membership_kind": "GROUP_MEMBER",
                        })
                _collect_policies(iam, result, key, name, kind="user",
                                  cache=policy_cache)
            elif kind == AWS_IAM_ROLE:
                _collect_policies(iam, result, key, name, kind="role",
                                  cache=policy_cache)
            elif kind == AWS_IAM_GROUP:
                _collect_policies(iam, result, key, name, kind="group",
                                  cache=policy_cache)

    result["identities"] = list(by_key.values())
    if result["errors"] and not result["identities"]:
        worst = result["errors"][0]
        result.update(status=worst["status"], error_detail=worst["detail"],
                      missing_permission=worst.get("missing_permission"))
    elif result["errors"]:
        result["partial"] = True
    return result


def _list(iam, method: str, key: str, result: Dict[str, Any], label: str,
          **kwargs: Any) -> List[Dict[str, Any]]:
    """Paginate a list call, recording a refusal instead of raising."""
    out: List[Dict[str, Any]] = []
    try:
        paginator = iam.get_paginator(method)
        for page in paginator.paginate(**kwargs):
            out.extend(page.get(key, []))
    except Exception as exc:  # noqa: BLE001
        status, action = _classify_error(exc)
        result["errors"].append({
            "stage": label, "status": status, "detail": str(exc)[:1000],
            "missing_permission": action or f"iam:{method.replace('_', '').title()}",
        })
    return out


def _identity_from_user(user: Dict[str, Any], *, account_key: str) -> Dict[str, Any]:
    arn = user.get("Arn") or ""
    return {
        "identity_type": AWS_IAM_USER,
        "provider_id": arn,
        "identity_key": identity_key(provider=AWS, account_id=account_key,
                                     identity_type=AWS_IAM_USER, provider_id=arn),
        "name": user.get("UserName"),
        "principal_name": user.get("UserName"),
        "actor_class": ACTOR_HUMAN,
        "status": STATUS_ACTIVE,
        "path": user.get("Path"),
        "created_at_provider": _parse_dt(user.get("CreateDate")),
        "last_used_at": _parse_dt(user.get("PasswordLastUsed")),
        "last_used_source": "iam:ListUsers (PasswordLastUsed)"
                            if user.get("PasswordLastUsed") else None,
        "mfa_state": MFA_UNKNOWN,
        "credentials": [],
        "provider_detail": {"PermissionsBoundary": user.get("PermissionsBoundary"),
                            "Tags": user.get("Tags")},
        "provider_reports_last_used": True,
        "provider_reports_mfa": False,
    }


def _identity_from_role(role: Dict[str, Any], *, account_key: str) -> Dict[str, Any]:
    arn = role.get("Arn") or ""
    name = role.get("RoleName") or ""
    last_used = (role.get("RoleLastUsed") or {}).get("LastUsedDate")
    # An SSO permission-set role is assumed by people, not by code. Getting
    # this right decides whether its missing MFA is a finding or a non-sequitur.
    actor = ACTOR_HUMAN if name.startswith("AWSReservedSSO_") else ACTOR_WORKLOAD
    return {
        "identity_type": AWS_IAM_ROLE,
        "provider_id": arn,
        "identity_key": identity_key(provider=AWS, account_id=account_key,
                                     identity_type=AWS_IAM_ROLE, provider_id=arn),
        "name": name,
        "principal_name": name,
        "description": role.get("Description"),
        "actor_class": actor,
        "status": STATUS_ACTIVE,
        "path": role.get("Path"),
        "created_at_provider": _parse_dt(role.get("CreateDate")),
        "last_used_at": _parse_dt(last_used),
        "last_used_source": "iam:ListRoles (RoleLastUsed)" if last_used else None,
        "last_used_region": (role.get("RoleLastUsed") or {}).get("Region"),
        "mfa_state": MFA_NOT_APPLICABLE if actor == ACTOR_WORKLOAD else MFA_UNKNOWN,
        "credentials": [],
        "trust_document": role.get("AssumeRolePolicyDocument"),
        "provider_detail": {
            "MaxSessionDuration": role.get("MaxSessionDuration"),
            "PermissionsBoundary": role.get("PermissionsBoundary"),
            "Tags": role.get("Tags"),
        },
        # RoleLastUsed is populated only for roles used in the last 400 days,
        # and not at all in some regions. Absence is genuinely unknown.
        "provider_reports_last_used": True,
        "provider_reports_mfa": False,
    }


def _identity_from_group(group: Dict[str, Any], *, account_key: str) -> Dict[str, Any]:
    arn = group.get("Arn") or ""
    return {
        "identity_type": AWS_IAM_GROUP,
        "provider_id": arn,
        "identity_key": identity_key(provider=AWS, account_id=account_key,
                                     identity_type=AWS_IAM_GROUP, provider_id=arn),
        "name": group.get("GroupName"),
        "principal_name": group.get("GroupName"),
        "actor_class": "GROUP",
        "status": STATUS_ACTIVE,
        "path": group.get("Path"),
        "created_at_provider": _parse_dt(group.get("CreateDate")),
        "mfa_state": MFA_NOT_APPLICABLE,
        "credentials": [],
        "provider_detail": {},
        "provider_reports_last_used": False,
        "provider_reports_mfa": False,
    }


def _enrich_users(iam, by_key: Dict[str, Dict[str, Any]],
                  result: Dict[str, Any]) -> None:
    """Per-user keys and MFA, for when the credential report was refused."""
    for identity in by_key.values():
        if identity["identity_type"] != AWS_IAM_USER:
            continue
        name = identity.get("principal_name") or ""
        for key in _list(iam, "list_access_keys", "AccessKeyMetadata", result,
                         "list_access_keys", UserName=name):
            key_id = key.get("AccessKeyId") or ""
            entry = {
                "credential_ref": key_id,
                "credential_kind": CRED_AWS_ACCESS_KEY,
                "status": STATUS_ACTIVE if key.get("Status") == "Active"
                          else STATUS_DISABLED,
                "created_at_provider": _parse_dt(key.get("CreateDate")),
                "last_used_at": None,
                "never_used": None,
                "provider_detail": {},
            }
            try:
                used = iam.get_access_key_last_used(AccessKeyId=key_id) \
                          .get("AccessKeyLastUsed", {})
                entry["last_used_at"] = _parse_dt(used.get("LastUsedDate"))
                entry["last_used_service"] = used.get("ServiceName")
                entry["last_used_region"] = used.get("Region")
                # AWS returns ServiceName "N/A" for a key that has never been
                # used. That is a provider assertion of never, not a gap.
                entry["never_used"] = used.get("ServiceName") == "N/A"
            except Exception as exc:  # noqa: BLE001
                status, action = _classify_error(exc)
                result["errors"].append({
                    "stage": "get_access_key_last_used", "status": status,
                    "detail": str(exc)[:500],
                    "missing_permission": action or "iam:GetAccessKeyLastUsed",
                })
            identity["credentials"].append(entry)

        devices = _list(iam, "list_mfa_devices", "MFADevices", result,
                        "list_mfa_devices", UserName=name)
        identity["mfa_state"] = MFA_ENABLED if devices else MFA_DISABLED
        identity["provider_reports_mfa"] = True
        identity["mfa_detail"] = {"device_count": len(devices),
                                  "source": "iam:ListMFADevices"}


def _collect_policies(iam, result: Dict[str, Any], identity_key_value: str,
                      name: str, *, kind: str, cache: Dict[str, Any]) -> None:
    """Attached and inline policy documents for one principal."""
    attached_call = {"user": ("list_attached_user_policies", "UserName"),
                     "role": ("list_attached_role_policies", "RoleName"),
                     "group": ("list_attached_group_policies", "GroupName")}[kind]
    inline_call = {"user": ("list_user_policies", "UserName", "get_user_policy"),
                   "role": ("list_role_policies", "RoleName", "get_role_policy"),
                   "group": ("list_group_policies", "GroupName", "get_group_policy")}[kind]

    method, param = attached_call
    for attached in _list(iam, method, "AttachedPolicies", result, method,
                          **{param: name}):
        arn = attached.get("PolicyArn") or ""
        document = cache.get(arn)
        if document is None:
            try:
                meta = iam.get_policy(PolicyArn=arn)["Policy"]
                version = iam.get_policy_version(
                    PolicyArn=arn, VersionId=meta["DefaultVersionId"])
                document = version["PolicyVersion"]["Document"]
                cache[arn] = document
            except Exception as exc:  # noqa: BLE001
                status, action = _classify_error(exc)
                result["errors"].append({
                    "stage": "get_policy_version", "status": status,
                    "detail": str(exc)[:500],
                    "missing_permission": action or "iam:GetPolicyVersion",
                })
                continue
        result["policies"].append({
            "identity_key": identity_key_value,
            "policy_key": arn,
            "policy_name": attached.get("PolicyName"),
            "policy_type": "AttachedManaged",
            "policy_stage": "group_policy" if kind == "group" else "identity_policy",
            "document": document,
        })

    method, param, getter = inline_call
    for policy_name in _list(iam, method, "PolicyNames", result, method,
                             **{param: name}):
        try:
            response = getattr(iam, getter)(**{param: name, "PolicyName": policy_name})
            document = response.get("PolicyDocument")
        except Exception as exc:  # noqa: BLE001
            status, action = _classify_error(exc)
            result["errors"].append({
                "stage": getter, "status": status, "detail": str(exc)[:500],
                "missing_permission": action or f"iam:{getter.replace('_', '').title()}",
            })
            continue
        result["policies"].append({
            "identity_key": identity_key_value,
            "policy_key": f"{name}/inline/{policy_name}",
            "policy_name": policy_name,
            "policy_type": "Inline",
            "policy_stage": "group_policy" if kind == "group" else "identity_policy",
            "document": document,
        })


def collect_scps(auth, *, account_id: str) -> Dict[str, Any]:
    """Service control policies that apply to this account, if reachable.

    Almost always refused from a member account — reading them needs
    Organizations access on the management account — and the refusal is the
    valuable output: it is what turns every ALLOW in this account from
    "allowed" into "allowed by the policies we can read".
    """
    out: Dict[str, Any] = {"status": COLLECT_UNAVAILABLE, "policies": [],
                           "error_detail": None, "missing_permission": None}
    try:
        org = auth.get_client("organizations")
        targets = org.list_policies_for_target(
            TargetId=account_id, Filter="SERVICE_CONTROL_POLICY").get("Policies", [])
        for policy in targets:
            described = org.describe_policy(PolicyId=policy["Id"])["Policy"]
            out["policies"].append({
                "policy_key": policy["Id"],
                "policy_name": policy.get("Name"),
                "policy_stage": "service_control_policy",
                "policy_type": policy.get("Type"),
                "document": described.get("Content"),
            })
        out["status"] = COLLECT_OK
    except Exception as exc:  # noqa: BLE001
        status, action = _classify_error(exc)
        out.update(status=status, error_detail=str(exc)[:1000],
                   missing_permission=action or "organizations:ListPoliciesForTarget")
    return out
