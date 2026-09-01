"""Azure credential validation."""
from __future__ import annotations

import logging
import threading
from typing import Any, Dict

from azure.identity import ClientSecretCredential
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.subscription import SubscriptionClient


logger = logging.getLogger("cloud_svc.azure.auth")


class AzureAuth:
    def __init__(self, credentials: Dict[str, Any]) -> None:
        self.tenant_id: str = credentials["tenant_id"]
        self.client_id: str = credentials["client_id"]
        self.client_secret: str = credentials["client_secret"]
        self.subscription_id: str = credentials["subscription_id"]
        self._credential: ClientSecretCredential | None = None
        # Guards credential creation only. Clients are deliberately not cached
        # (see get_client); the credential is, because it holds a token rather
        # than sockets.
        self._lock = threading.RLock()

    def get_credential(self) -> ClientSecretCredential:
        # Guarded because scanner calls run on the thread pool: two threads
        # building a credential at once would each start their own token
        # acquisition, and the loser's token would be thrown away.
        if self._credential is None:
            with self._lock:
                if self._credential is None:
                    self._credential = ClientSecretCredential(
                        tenant_id=self.tenant_id,
                        client_id=self.client_id,
                        client_secret=self.client_secret,
                    )
        return self._credential

    def get_client(self, client_class):
        """A management client for this subscription.

        NOT cached, deliberately. Sharing one client (and therefore one
        connection pool) across the scan fan-out is the obvious optimisation and
        was tried; on OCI, where it could be measured end to end, it took a sweep
        from 57m/468 resources to 370m/363 with 261 failed scopes. This network
        aborts TLS often enough that a shared pool fills with dead connections
        that every caller then inherits, while a per-call client lets a broken
        connection die with its owner. Azure was never measured either way, so it
        keeps the same shape as the provider that was — see
        oci_scanner._client_for_region for the numbers.

        The credential IS shared (see get_credential): it holds an OAuth token,
        not sockets, so caching it costs nothing and saves a token fetch per call.
        """
        return client_class(self.get_credential(), self.subscription_id)

    def get_resource_client(self) -> ResourceManagementClient:
        return self.get_client(ResourceManagementClient)

    async def validate(self) -> bool:
        """Confirm the credentials by reading the subscription.

        Retries dropped connections rather than aborting the scan on the first
        one, and keeps "unreachable" distinct from "rejected". See
        scan_pool.preflight.
        """
        from app.providers.scan_pool import preflight

        def _check() -> bool:
            client = SubscriptionClient(self.get_credential())
            sub = client.subscriptions.get(self.subscription_id)
            logger.info(
                "Azure auth OK — Subscription: %s (%s)",
                sub.display_name,
                sub.subscription_id,
            )
            return True

        return await preflight(
            _check, provider="Azure", endpoint="management.azure.com",
        )
