"""OCI credential validation and config construction."""
from __future__ import annotations

import io
import logging
from typing import Any, Dict

import oci

logger = logging.getLogger("cloud_svc.oci.auth")


class OCIAuth:
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.tenancy_ocid: str = credentials.get("tenancy_ocid", "")
        self.user_ocid: str = credentials.get("user_ocid", "")
        self.fingerprint: str = credentials.get("fingerprint", "")
        self.private_key: str = credentials.get("private_key", "")
        self.passphrase: str | None = credentials.get("passphrase")
        self.region: str = credentials.get("region", "us-ashburn-1")

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

    async def validate(self) -> bool:
        import asyncio

        def _check():
            identity = oci.identity.IdentityClient(self.get_config())
            tenancy = identity.get_tenancy(self.tenancy_ocid).data
            logger.info("OCI auth OK — Tenancy: %s", tenancy.name)
            return True

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _check)
        except Exception as exc:
            logger.error("OCI auth failed: %s", exc)
            raise ValueError(f"OCI authentication failed: {exc}") from exc
