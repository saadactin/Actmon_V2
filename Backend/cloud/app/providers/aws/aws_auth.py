"""AWS credential validation and session construction."""
from __future__ import annotations

import logging
import threading
from typing import Any, Dict

import boto3

logger = logging.getLogger("cloud_svc.aws.auth")


class AWSAuth:
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.access_key_id: str = credentials["access_key_id"]
        self.secret_access_key: str = credentials["secret_access_key"]
        self.session_token: str | None = credentials.get("session_token")
        self.region: str = credentials.get("region", "us-east-1")
        # One shared Session (holds no sockets — see get_session). Clients are
        # built per call and deliberately not cached (see get_client).
        self._session: boto3.Session | None = None
        self._lock = threading.RLock()

    def get_session(self) -> boto3.Session:
        """One shared Session.

        Building a Session is not free: it creates a botocore session that
        loads and parses service model JSON from disk on first use per service.
        A sweep asks for a client ~200 times, and every fresh Session repeated
        that work and started with an empty connection pool.

        boto3 Sessions are documented as NOT thread-safe to build concurrently,
        so creation is guarded; sharing one afterwards to hand out clients is
        the pattern boto3 itself recommends.
        """
        if self._session is None:
            with self._lock:
                if self._session is None:
                    self._session = boto3.Session(
                        aws_access_key_id=self.access_key_id,
                        aws_secret_access_key=self.secret_access_key,
                        aws_session_token=self.session_token,
                        region_name=self.region,
                    )
        return self._session

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
        """A client per call, from the shared Session.

        The client is NOT cached, deliberately — a client owns a connection
        pool, and sharing one across the scan fan-out was measured (on OCI,
        where a clean before/after was possible) to take a sweep from 57m/468
        resources to 370m/363 with 261 failed scopes. On a network that aborts
        TLS this often, a shared pool spreads dead connections to every caller.
        See oci_scanner._client_for_region.

        The SESSION is shared, because it holds no sockets: it only parses
        service model JSON, which is pure CPU and worth doing once.
        """
        return self.get_session().client(
            service, region_name=region or self.region,
            config=self._config(slow_api), verify=self._ssl_verify(),
        )

    def get_resource(self, service: str, region: str | None = None) -> Any:
        session = self.get_session()
        return session.resource(service, region_name=region or self.region,
                                config=self._config(), verify=self._ssl_verify())

    async def validate(self) -> bool:
        """Call STS GetCallerIdentity to confirm credentials are valid.

        Goes through scan_pool.preflight, which retries dropped connections and
        keeps "unreachable" distinct from "rejected". Previously this ran boto3
        directly on the event loop with no retry, so one cut TLS handshake
        aborted the whole scan and reported a working account as having lost
        access.
        """
        from app.providers.scan_pool import preflight

        def _check() -> bool:
            sts = self.get_client("sts")
            identity = sts.get_caller_identity()
            logger.info(
                "AWS auth OK — Account: %s, ARN: %s",
                identity.get("Account"),
                identity.get("Arn"),
            )
            return True

        return await preflight(
            _check, provider="AWS", endpoint=f"sts.{self.region}.amazonaws.com",
        )
