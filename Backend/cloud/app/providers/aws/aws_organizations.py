"""AWS Organizations: list the member accounts one management connection can reach.

How access actually works, because it decides what this module can promise:

* `organizations:ListAccounts` answers only from the **management account** or
  a **delegated administrator**. From any other account it is refused, and a
  standalone account is not in an organisation at all — two different errors,
  reported as two different sentences.
* Listing a member is not access to it. Reading a member account means
  assuming a role there. `OrganizationAccountAccessRole` exists by default only
  in accounts CREATED from the organisation; accounts that were INVITED do not
  have it unless someone made it. So every member is probed with a real
  `sts:AssumeRole` before it is offered, and the refusal text is shown instead
  of letting the user onboard ten accounts that will each fail their first scan.
* The management account itself is read with the supplied keys directly. A
  role of the same name rarely exists there, and assuming into your own
  account is not how these keys are meant to be used.

Every call is blocking boto3; callers run this in the executor.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from app.providers.aws.aws_auth import AWSAuth

logger = logging.getLogger("cloud_svc.aws.organizations")

DEFAULT_MEMBER_ROLE = "OrganizationAccountAccessRole"
# Probing is one STS call per member. Bounded so a 300-account organisation
# neither serialises for minutes nor fires 300 concurrent TLS handshakes over
# a network that is known to cut them.
_PROBE_CONCURRENCY = 8
_MAX_MEMBERS = 1000


def _error_code(exc: BaseException) -> str:
    resp = getattr(exc, "response", None) or {}
    return str((resp.get("Error") or {}).get("Code") or type(exc).__name__)


def _error_message(exc: BaseException) -> str:
    resp = getattr(exc, "response", None) or {}
    return str((resp.get("Error") or {}).get("Message") or exc)[:600]


def role_arn_for(account_id: str, role_name: str) -> str:
    return f"arn:aws:iam::{account_id}:role/{role_name}"


def _probe(base_credentials: Dict[str, Any], account_id: str, role_name: str,
           external_id: Optional[str]) -> Dict[str, Any]:
    """Can the supplied keys assume `role_name` in `account_id`? One real call."""
    auth = AWSAuth(base_credentials)
    try:
        sts = auth.get_client("sts")
        params: Dict[str, Any] = {
            "RoleArn": role_arn_for(account_id, role_name),
            "RoleSessionName": "actmon-onboarding-probe",
            "DurationSeconds": 900,
        }
        if external_id:
            params["ExternalId"] = external_id
        sts.assume_role(**params)
        return {"can_access": True, "access_mode": "assume_role", "detail": None}
    except Exception as exc:  # noqa: BLE001 — every refusal is reported, not raised
        code = _error_code(exc)
        message = _error_message(exc)
        if code == "AccessDenied":
            detail = (f"The role {role_name} cannot be assumed in {account_id}: {message}. "
                      "It is created automatically only in accounts created from the "
                      "organisation; an invited account needs it created, trusting the "
                      "management account.")
        else:
            detail = f"{code}: {message}"
        return {"can_access": False, "access_mode": "assume_role", "detail": detail,
                "error_code": code}


def list_members(credentials: Dict[str, Any], *, role_name: str = DEFAULT_MEMBER_ROLE,
                 external_id: Optional[str] = None, probe: bool = True) -> Dict[str, Any]:
    """The organisation and its member accounts, each probed for access.

    Returns `{status, organization, caller, members, error, missing_permission}`.
    Never raises: a refusal is the useful output here.
    """
    auth = AWSAuth(credentials)
    try:
        identity = auth.get_client("sts").get_caller_identity()
    except Exception as exc:  # noqa: BLE001
        return {"status": "AuthenticationFailed", "members": [],
                "error": f"{_error_code(exc)}: {_error_message(exc)}",
                "missing_permission": None}
    caller_account = identity.get("Account")

    # Organizations is a global service homed in us-east-1.
    org = auth.get_client("organizations", region="us-east-1")
    try:
        described = org.describe_organization().get("Organization") or {}
    except Exception as exc:  # noqa: BLE001
        code = _error_code(exc)
        if code == "AWSOrganizationsNotInUseException":
            return {"status": "NotInOrganization", "members": [],
                    "caller": {"account_id": caller_account, "arn": identity.get("Arn")},
                    "error": ("This account is not a member of an AWS organisation. "
                              "Add it on its own from Add Account instead."),
                    "missing_permission": None}
        if code in ("AccessDeniedException", "AccessDenied"):
            return {"status": "PermissionDenied", "members": [],
                    "caller": {"account_id": caller_account, "arn": identity.get("Arn")},
                    "error": _error_message(exc),
                    "missing_permission": "organizations:DescribeOrganization"}
        return {"status": "Unavailable", "members": [],
                "error": f"{code}: {_error_message(exc)}", "missing_permission": None}

    try:
        accounts: List[Dict[str, Any]] = []
        for page in org.get_paginator("list_accounts").paginate():
            accounts.extend(page.get("Accounts") or [])
            if len(accounts) >= _MAX_MEMBERS:
                break
    except Exception as exc:  # noqa: BLE001
        code = _error_code(exc)
        denied = code in ("AccessDeniedException", "AccessDenied")
        return {
            "status": "PermissionDenied" if denied else "Unavailable",
            "members": [],
            "organization": {"id": described.get("Id"),
                             "management_account_id": described.get("MasterAccountId")},
            "caller": {"account_id": caller_account, "arn": identity.get("Arn")},
            "error": (
                "organizations:ListAccounts is answered only from the management "
                "account or a delegated administrator. " + _error_message(exc)
                if denied else f"{code}: {_error_message(exc)}"),
            "missing_permission": "organizations:ListAccounts" if denied else None,
        }

    management_id = described.get("MasterAccountId")
    members: List[Dict[str, Any]] = []
    for a in accounts[:_MAX_MEMBERS]:
        # `State` replaced the deprecated `Status`; read either.
        state = str(a.get("State") or a.get("Status") or "UNKNOWN").upper()
        members.append({
            "account_id": a.get("Id"),
            "name": a.get("Name"),
            "email": a.get("Email"),
            "state": state,
            "joined_method": a.get("JoinedMethod"),
            "joined_at": (a.get("JoinedTimestamp").isoformat()
                          if hasattr(a.get("JoinedTimestamp"), "isoformat") else None),
            "is_management_account": a.get("Id") == management_id,
            "is_caller_account": a.get("Id") == caller_account,
        })

    if probe:
        def _one(m: Dict[str, Any]) -> Dict[str, Any]:
            if m["state"] != "ACTIVE":
                return {"can_access": False, "access_mode": None,
                        "detail": f"The account is {m['state']}, not ACTIVE."}
            if m["is_caller_account"]:
                return {"can_access": True, "access_mode": "direct_keys",
                        "detail": "The account these keys belong to — read with them "
                                  "directly, no role needed."}
            return _probe(credentials, m["account_id"], role_name, external_id)

        with ThreadPoolExecutor(max_workers=_PROBE_CONCURRENCY,
                                thread_name_prefix="org-probe") as pool:
            for m, result in zip(members, pool.map(_one, members)):
                m["access"] = result

    return {
        "status": "Collected",
        "organization": {
            "id": described.get("Id"),
            "arn": described.get("Arn"),
            "management_account_id": management_id,
            "feature_set": described.get("FeatureSet"),
        },
        "caller": {"account_id": caller_account, "arn": identity.get("Arn"),
                   "is_management_account": caller_account == management_id},
        "role_name": role_name,
        "members": members,
        "truncated": len(accounts) >= _MAX_MEMBERS,
        "error": None,
        "missing_permission": None,
    }


def member_credentials(base: Dict[str, Any], member: Dict[str, Any], *,
                       role_name: str, external_id: Optional[str]) -> Dict[str, Any]:
    """The credentials one member account is stored with.

    The management account keeps the keys as they are; every other member
    gets the same keys plus the role to assume, so it is scanned AS that role
    and never with the management account's own permissions.
    """
    creds = {k: base.get(k) for k in ("access_key_id", "secret_access_key",
                                      "session_token", "region")}
    if not member.get("is_caller_account"):
        creds["role_arn"] = role_arn_for(member["account_id"], role_name)
        if external_id:
            creds["external_id"] = external_id
    return creds
