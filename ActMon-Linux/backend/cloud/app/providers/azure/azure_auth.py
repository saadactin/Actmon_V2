"""Azure credential validation."""
from __future__ import annotations

import logging
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

    def get_credential(self) -> ClientSecretCredential:
        if self._credential is None:
            self._credential = ClientSecretCredential(
                tenant_id=self.tenant_id,
                client_id=self.client_id,
                client_secret=self.client_secret,
            )
        return self._credential

    def get_resource_client(self) -> ResourceManagementClient:
        return ResourceManagementClient(self.get_credential(), self.subscription_id)

    async def validate(self) -> bool:
        import asyncio

        def _check():
            client = SubscriptionClient(self.get_credential())
            sub = client.subscriptions.get(self.subscription_id)
            logger.info(
                "Azure auth OK — Subscription: %s (%s)",
                sub.display_name,
                sub.subscription_id,
            )
            return True

        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, _check)
        except Exception as exc:
            logger.error("Azure auth failed: %s", exc)
            raise ValueError(f"Azure authentication failed: {exc}") from exc
