"""Service layer for Cloud Account operations."""
from __future__ import annotations

import uuid
from typing import List

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.cloud_account_repo import CloudAccountRepository
from app.schemas.cloud_account import CloudAccountCreate, CloudAccountResponse
from app.utils.encryption import encrypt_credentials


class CloudAccountService:
    def __init__(self, db: AsyncSession) -> None:
        self.repo = CloudAccountRepository(db)

    @staticmethod
    async def _validate_credentials(provider: str, credentials: dict) -> None:
        """Authenticate against the provider before persisting the account.

        Raises ValueError with a provider-specific message on failure.
        """
        from app.providers.aws.aws_provider import AWSProvider
        from app.providers.azure.azure_provider import AzureProvider
        from app.providers.oci.oci_provider import OCIProvider

        provider_map = {
            "AWS": AWSProvider,
            "AZURE": AzureProvider,
            "ORACLE": OCIProvider,
            "OCI": OCIProvider,
        }
        cls = provider_map.get((provider or "").upper())
        if not cls:
            raise ValueError(f"Unknown provider: {provider}")
        await cls(credentials).authenticate()

    async def create_account(self, payload: CloudAccountCreate) -> CloudAccountResponse:
        credentials = payload.extract_credentials()
        await self._validate_credentials(payload.provider, credentials)
        encrypted = encrypt_credentials(credentials)

        account = await self.repo.create(
            account_name=payload.account_name,
            provider=payload.provider,
            environment=payload.environment,
            tenant_or_region=payload.tenant_or_region,
            auth_mode=payload.auth_mode,
            auto_discovery=payload.auto_discovery,
            credentials_enc=encrypted,
        )
        return CloudAccountResponse.model_validate(account)

    async def list_accounts(self) -> List[CloudAccountResponse]:
        accounts = await self.repo.list_all()
        return [CloudAccountResponse.model_validate(a) for a in accounts]

    async def get_account(self, account_id: uuid.UUID) -> CloudAccountResponse | None:
        account = await self.repo.get_by_id(account_id)
        if not account:
            return None
        return CloudAccountResponse.model_validate(account)

    async def delete_account(self, account_id: uuid.UUID) -> bool:
        return await self.repo.delete(account_id)
