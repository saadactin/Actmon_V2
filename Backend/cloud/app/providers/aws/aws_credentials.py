"""AWS certificates and secrets: ACM, IAM server certificates, Secrets Manager.

Three details that decide whether the result is true:

* **ACM lists only RSA-2048 certificates unless told otherwise.** ListCertificates
  filters to key type RSA_2048 by default, so an account that moved to ECDSA
  (or RSA-4096) certificates would look like it had none. Every key type is
  requested explicitly.
* **An Amazon-issued certificate renews itself — until it doesn't.** ACM starts
  managed renewal 60 days before expiry. A managed certificate inside 30 days is
  therefore not "fine because AWS renews it"; it means renewal is stuck (usually
  DNS validation). RenewalSummary is read for exactly those.
* **Secrets Manager secrets do not expire.** What goes stale is rotation, so that
  is what is recorded: whether it is on, its interval, and when it last ran.

No call here returns a secret value or key material. Blocking boto3 — callers
run this in the executor.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.models.credential_inventory import (
    COLLECT_AUTH_FAILED, COLLECT_OK, COLLECT_PERMISSION_DENIED, COLLECT_UNAVAILABLE,
    KIND_CERTIFICATE, KIND_SECRET,
)
from app.providers.aws.aws_auth import AWSAuth
from app.providers.credential_common import as_utc, scope_result

logger = logging.getLogger("cloud_svc.aws.credentials")

SOURCE_ACM = "aws:acm"
SOURCE_IAM_CERTS = "aws:iam-server-certificates"
SOURCE_SECRETS = "aws:secretsmanager"

ACM_KEY_TYPES = ["RSA_1024", "RSA_2048", "RSA_3072", "RSA_4096",
                 "EC_prime256v1", "EC_secp384r1", "EC_secp521r1"]
# Only certificates this close to expiry get a DescribeCertificate call for
# their renewal status — enough to explain every one the analyser will flag.
_RENEWAL_LOOKUP_DAYS = 60
_MAX_DESCRIBES_PER_REGION = 200
_CONCURRENCY = 8

_PERMISSION = {
    SOURCE_ACM: "acm:ListCertificates",
    SOURCE_IAM_CERTS: "iam:ListServerCertificates",
    SOURCE_SECRETS: "secretsmanager:ListSecrets",
}
_DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
           "AuthorizationError"}
_AUTH = {"UnrecognizedClientException", "InvalidClientTokenId", "SignatureDoesNotMatch",
         "ExpiredToken", "ExpiredTokenException", "InvalidSignatureException"}


def _classify(source: str, exc: BaseException) -> Tuple[str, Optional[str], Optional[str]]:
    resp = getattr(exc, "response", None) or {}
    code = str((resp.get("Error") or {}).get("Code") or "")
    if code in _DENIED:
        perm = _PERMISSION.get(source)
        return (COLLECT_PERMISSION_DENIED, perm,
                f"Grant {perm} to the identity Actmon uses (the ReadOnlyAccess or "
                "SecurityAudit managed policy includes it).")
    if code in _AUTH:
        return (COLLECT_AUTH_FAILED, None,
                "The stored AWS credentials were rejected; update them on the account.")
    return COLLECT_UNAVAILABLE, None, None


def _rotation_days(rules: Dict[str, Any]) -> Optional[int]:
    if not rules:
        return None
    if rules.get("AutomaticallyAfterDays"):
        return int(rules["AutomaticallyAfterDays"])
    m = re.match(r"rate\((\d+)\s+days?\)", str(rules.get("ScheduleExpression") or ""))
    return int(m.group(1)) if m else None


def _regions(auth: AWSAuth) -> List[str]:
    ec2 = auth.get_client("ec2")
    resp = ec2.describe_regions(Filters=[{"Name": "opt-in-status",
                                          "Values": ["opt-in-not-required", "opted-in"]}])
    return sorted(r["RegionName"] for r in resp.get("Regions", []))


def _acm(auth: AWSAuth, region: str, now: datetime) -> Dict[str, Any]:
    try:
        acm = auth.get_client("acm", region=region)
        summaries: List[Dict[str, Any]] = []
        for page in acm.get_paginator("list_certificates").paginate(
                Includes={"keyTypes": ACM_KEY_TYPES}):
            summaries.extend(page.get("CertificateSummaryList") or [])

        items: List[Dict[str, Any]] = []
        describes = 0
        for s in summaries:
            arn = s.get("CertificateArn")
            status = s.get("Status")
            not_after = as_utc(s.get("NotAfter"))
            detail: Dict[str, Any] = {}
            need_describe = not_after is None and status in ("ISSUED", "EXPIRED", "INACTIVE")
            if not_after and not_after - now <= timedelta(days=_RENEWAL_LOOKUP_DAYS):
                need_describe = True
            if need_describe and describes < _MAX_DESCRIBES_PER_REGION:
                describes += 1
                try:
                    detail = acm.describe_certificate(CertificateArn=arn).get("Certificate") or {}
                except Exception as exc:  # noqa: BLE001 — summary data still stands
                    logger.info("ACM describe failed for %s: %s", arn, exc)
            not_after = not_after or as_utc(detail.get("NotAfter"))
            if not_after is None:
                # Pending validation, failed, or timed out: never issued, so it
                # has no validity to expire. Not an expiry concern.
                continue
            ctype = s.get("Type") or detail.get("Type")
            eligibility = s.get("RenewalEligibility") or detail.get("RenewalEligibility")
            managed = None
            if ctype == "IMPORTED":
                managed = False
            elif ctype in ("AMAZON_ISSUED", "PRIVATE") and eligibility:
                managed = eligibility == "ELIGIBLE"
            sans = [x for x in (s.get("SubjectAlternativeNameSummaries")
                                or detail.get("SubjectAlternativeNames") or []) if x]
            items.append({
                "kind": KIND_CERTIFICATE,
                "object_key": arn,
                "name": s.get("DomainName") or detail.get("DomainName") or arn,
                "region": region,
                "subject": s.get("DomainName") or detail.get("Subject"),
                "issuer": detail.get("Issuer") or ("Amazon" if ctype == "AMAZON_ISSUED" else None),
                "dns_names": sans[:50],
                "key_algorithm": s.get("KeyAlgorithm") or detail.get("KeyAlgorithm"),
                "not_before": as_utc(s.get("NotBefore") or detail.get("NotBefore")),
                "expires_at": not_after,
                "status": status,
                "managed_renewal": managed,
                "renewal_status": ((detail.get("RenewalSummary") or {}).get("RenewalStatus")),
                "in_use": s.get("InUse") if s.get("InUse") is not None
                else (bool(detail.get("InUseBy")) if "InUseBy" in detail else None),
                "in_use_by": list(detail.get("InUseBy") or [])[:20],
                "details": {"type": ctype, "renewal_eligibility": eligibility,
                            "exported": s.get("Exported")},
            })
        return scope_result(SOURCE_ACM, region, COLLECT_OK, items=items,
                            scope_label=f"ACM {region}")
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(SOURCE_ACM, exc)
        return scope_result(SOURCE_ACM, region, status, scope_label=f"ACM {region}",
                            error_detail=str(exc), missing_permission=perm, remediation=fix)


def _secrets(auth: AWSAuth, region: str) -> Dict[str, Any]:
    try:
        sm = auth.get_client("secretsmanager", region=region)
        items: List[Dict[str, Any]] = []
        for page in sm.get_paginator("list_secrets").paginate():
            for s in page.get("SecretList") or []:
                if s.get("DeletedDate"):
                    continue  # scheduled for deletion — not a live secret
                owner = s.get("OwningService")
                items.append({
                    "kind": KIND_SECRET,
                    "object_key": s.get("ARN"),
                    "name": s.get("Name"),
                    "region": region,
                    "expires_at": None,   # Secrets Manager has no expiry concept
                    "rotation_enabled": bool(s.get("RotationEnabled")),
                    "rotation_interval_days": _rotation_days(s.get("RotationRules") or {}),
                    "last_rotated_at": as_utc(s.get("LastRotatedDate")),
                    "next_rotation_at": as_utc(s.get("NextRotationDate")),
                    "details": {
                        # A secret owned by a service (an RDS-managed master
                        # password, say) has its rotation run by that service.
                        "owning_service": owner,
                        "last_accessed": (as_utc(s.get("LastAccessedDate")).isoformat()
                                          if s.get("LastAccessedDate") else None),
                        "created": (as_utc(s.get("CreatedDate")).isoformat()
                                    if s.get("CreatedDate") else None),
                        "primary_region": s.get("PrimaryRegion"),
                    },
                })
        return scope_result(SOURCE_SECRETS, region, COLLECT_OK, items=items,
                            scope_label=f"Secrets Manager {region}")
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(SOURCE_SECRETS, exc)
        return scope_result(SOURCE_SECRETS, region, status,
                            scope_label=f"Secrets Manager {region}",
                            error_detail=str(exc), missing_permission=perm, remediation=fix)


def _iam_certificates(auth: AWSAuth) -> Dict[str, Any]:
    try:
        iam = auth.get_client("iam")
        items: List[Dict[str, Any]] = []
        for page in iam.get_paginator("list_server_certificates").paginate():
            for m in page.get("ServerCertificateMetadataList") or []:
                expires = as_utc(m.get("Expiration"))
                if expires is None:
                    continue
                items.append({
                    "kind": KIND_CERTIFICATE,
                    "object_key": m.get("Arn"),
                    "name": m.get("ServerCertificateName"),
                    "region": "global",
                    "expires_at": expires,
                    # IAM-stored certificates are never renewed by AWS.
                    "managed_renewal": False,
                    "details": {"path": m.get("Path"),
                                "uploaded": (as_utc(m.get("UploadDate")).isoformat()
                                             if m.get("UploadDate") else None),
                                "store": "IAM"},
                })
        return scope_result(SOURCE_IAM_CERTS, "global", COLLECT_OK, items=items,
                            scope_label="IAM server certificates")
    except Exception as exc:  # noqa: BLE001
        status, perm, fix = _classify(SOURCE_IAM_CERTS, exc)
        return scope_result(SOURCE_IAM_CERTS, "global", status,
                            scope_label="IAM server certificates",
                            error_detail=str(exc), missing_permission=perm, remediation=fix)


def collect(credentials: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every AWS scope, attempted. Never raises."""
    auth = AWSAuth(credentials)
    now = datetime.now(timezone.utc)
    try:
        regions = _regions(auth)
    except Exception as exc:  # noqa: BLE001
        # Without the region list nothing regional can be attempted, and a
        # home-region-only pass would be reported as the whole account. So say
        # so for both sources rather than collecting a subset.
        status, _, _ = _classify(SOURCE_ACM, exc)
        detail = f"Region discovery failed, so no region was read: {exc}"
        return [
            scope_result(SOURCE_ACM, "*", status, scope_label="ACM (all regions)",
                         error_detail=detail, missing_permission="ec2:DescribeRegions"
                         if status == COLLECT_PERMISSION_DENIED else None),
            scope_result(SOURCE_SECRETS, "*", status,
                         scope_label="Secrets Manager (all regions)", error_detail=detail),
            _iam_certificates(auth),
        ]

    tasks = [(_acm, r) for r in regions] + [(_secrets, r) for r in regions]
    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=_CONCURRENCY, thread_name_prefix="aws-creds") as pool:
        futures = [pool.submit(fn, auth, r, now) if fn is _acm else pool.submit(fn, auth, r)
                   for fn, r in tasks]
        futures.append(pool.submit(_iam_certificates, auth))
        for f in futures:
            results.append(f.result())
    return results
