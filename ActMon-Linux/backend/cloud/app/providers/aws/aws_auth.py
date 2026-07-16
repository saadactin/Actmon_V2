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

    def get_client(self, service: str, region: str | None = None) -> Any:
        from botocore.config import Config
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        config = Config(connect_timeout=5, read_timeout=5, retries={'max_attempts': 1})
        session = self.get_session()
        return session.client(service, region_name=region or self.region, config=config, verify=False)

    def get_resource(self, service: str, region: str | None = None) -> Any:
        from botocore.config import Config
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        config = Config(connect_timeout=5, read_timeout=5, retries={'max_attempts': 1})
        session = self.get_session()
        return session.resource(service, region_name=region or self.region, config=config, verify=False)

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
