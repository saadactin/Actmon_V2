"""OCI credential validation and config construction."""
from __future__ import annotations

import logging
import re
from typing import Any, Dict

import oci

logger = logging.getLogger("cloud_svc.oci.auth")


def _normalize_pem(key: str) -> str:
    """Repair PEM keys mangled by copy-paste (CRLF, flattened to one line)."""
    if not key:
        return key
    key = key.replace("\r\n", "\n").replace("\r", "\n").strip()
    if "\n" in key:
        return key
    # Single-line paste: rebuild header/footer and wrap the base64 body
    match = re.match(r"^(-----BEGIN [A-Z ]+-----)(.*?)(-----END [A-Z ]+-----)$", key)
    if not match:
        return key
    header, body, footer = match.groups()
    body = re.sub(r"\s+", "", body)
    lines = [body[i : i + 64] for i in range(0, len(body), 64)]
    return "\n".join([header, *lines, footer]) + "\n"


class OCIAuth:
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.tenancy_ocid: str = (credentials.get("tenancy_ocid") or "").strip()
        self.user_ocid: str = (credentials.get("user_ocid") or "").strip()
        self.fingerprint: str = (credentials.get("fingerprint") or "").strip()
        self.private_key: str = _normalize_pem(credentials.get("private_key") or "")
        self.passphrase: str | None = credentials.get("passphrase") or None
        self.region: str = (credentials.get("region") or "us-ashburn-1").strip()

    def get_config(self) -> Dict[str, Any]:
        return {
            "tenancy": self.tenancy_ocid,
            "user": self.user_ocid,
            "fingerprint": self.fingerprint,
            "key_content": self.private_key,
            "pass_phrase": self.passphrase,
            "region": self.region,
        }

    def get_signer(self) -> oci.signer.Signer:
        return oci.Signer(
            tenancy=self.tenancy_ocid,
            user=self.user_ocid,
            fingerprint=self.fingerprint,
            private_key_content=self.private_key,
            pass_phrase=self.passphrase,
        )

    # Fail fast while validating credentials. The SDK's default retry strategy
    # uses long exponential backoff, so an unroutable endpoint (e.g. a mistyped
    # region) left "Add Account" spinning for minutes before reporting anything.
    _VALIDATE_TIMEOUT = (10, 30)  # (connect, read) seconds

    def _validate_region(self) -> None:
        """Reject an unknown region before any network call.

        The region becomes part of every OCI endpoint hostname, so a bad value
        doesn't produce an auth error — it produces DNS failures against a host
        that cannot exist, which the SDK then retries. Checking the name up
        front turns a multi-minute hang into an instant, actionable message.
        """
        known = set(getattr(oci.regions, "REGIONS", []) or [])
        if not known or self.region in known:
            return
        # Surface a few plausible corrections rather than 85 region names.
        head = self.region.split("-")[0].lower()
        hints = sorted(r for r in known if r.startswith(head))[:6] or sorted(known)[:6]
        raise ValueError(
            f"'{self.region}' is not a valid OCI region. Use the full region "
            f"identifier, e.g. {', '.join(hints)}. "
            "You can find it in the OCI console URL or under Regions in the top bar."
        )

    async def validate(self) -> bool:
        import asyncio

        self._validate_region()

        def _check():
            identity = oci.identity.IdentityClient(
                self.get_config(),
                timeout=self._VALIDATE_TIMEOUT,
                retry_strategy=oci.retry.NoneRetryStrategy(),
            )
            tenancy = identity.get_tenancy(self.tenancy_ocid).data
            logger.info("OCI auth OK — Tenancy: %s", tenancy.name)
            return True

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _check)
        except Exception as exc:
            logger.error("OCI auth failed: %s", exc)
            raise ValueError(f"OCI authentication failed: {exc}") from exc
