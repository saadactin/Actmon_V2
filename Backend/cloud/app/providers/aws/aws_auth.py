"""AWS credential validation and session construction."""
from __future__ import annotations

import logging
from typing import Any, Dict

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger("cloud_svc.aws.auth")


class AWSAuth:
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.access_key_id: str = credentials["access_key_id"]
        self.secret_access_key: str = credentials["secret_access_key"]
        self.session_token: str | None = credentials.get("session_token")
        self.region: str = credentials.get("region", "us-east-1")

    def get_session(self) -> boto3.Session:
        return boto3.Session(
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            aws_session_token=self.session_token,
            region_name=self.region,
        )

    @staticmethod
    def _ssl_verify() -> bool | str:
        """SSL verification for AWS endpoints.

        Default: verify. Behind an SSL-intercepting corporate proxy either set
        AWS_CA_BUNDLE to the proxy CA path (preferred) or CLOUD_SSL_VERIFY=false
        in Backend/cloud/.env as a last resort.
        """
        import os
        if os.getenv("CLOUD_SSL_VERIFY", "true").strip().lower() in ("false", "0", "no"):
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            return False
        return os.getenv("AWS_CA_BUNDLE") or True

    def _config(self, slow_api: bool = False):
        from botocore.config import Config
        # Cost Explorer and other slow APIs need generous read timeouts and
        # retries; throttling (ThrottlingException) is routine on describe_* too.
        if slow_api:
            return Config(connect_timeout=10, read_timeout=60,
                          retries={"max_attempts": 4, "mode": "adaptive"})
        return Config(connect_timeout=10, read_timeout=30,
                      retries={"max_attempts": 3, "mode": "adaptive"})

    def get_client(self, service: str, region: str | None = None, slow_api: bool = False) -> Any:
        session = self.get_session()
        return session.client(service, region_name=region or self.region,
                              config=self._config(slow_api), verify=self._ssl_verify())

    def get_resource(self, service: str, region: str | None = None) -> Any:
        session = self.get_session()
        return session.resource(service, region_name=region or self.region,
                                config=self._config(), verify=self._ssl_verify())

    async def validate(self) -> bool:
        """Call STS GetCallerIdentity to confirm credentials are valid."""
        try:
            sts = self.get_client("sts")
            identity = sts.get_caller_identity()
            logger.info(
                "AWS auth OK — Account: %s, ARN: %s",
                identity.get("Account"),
                identity.get("Arn"),
            )
            return True
        except (BotoCoreError, ClientError) as exc:
            logger.error("AWS auth failed: %s", exc)
            raise ValueError(f"AWS authentication failed: {exc}") from exc
