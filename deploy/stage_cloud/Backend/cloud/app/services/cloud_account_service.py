"""Service layer for Cloud Account operations."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.client import CloudClient
from app.models.cloud_account import CloudAccount
from app.models.discovery_job import DiscoveryJob
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.discovery_repo import DiscoveryRepository
from app.schemas.cloud_account import CloudAccountCreate, CloudAccountResponse
from app.utils.encryption import decrypt_credentials, encrypt_credentials

logger = logging.getLogger("cloud_svc.accounts")


def _classify_discovery_status(job: DiscoveryJob | None) -> str:
    """Same classification as ResourceService.get_scan_diagnostic, reduced to
    just the status label — real state from the job row, never guessed."""
    if not job:
        return "never_scanned"
    if job.status == "FAILED":
        return "failed"
    if job.status in ("RUNNING", "PENDING"):
        return "scanning"
    return "ok"


def identity_from_credentials(provider: str, credentials: Dict[str, Any]) -> Optional[str]:
    """The provider's own id for an account, where it can be read off the
    credentials without a network call.

    Azure and OCI carry it (subscription id, tenancy OCID). AWS does not — an
    access key says nothing about which account it belongs to, and a role ARN
    only names the account it would assume into — so AWS is learned from STS
    at connect time instead and this returns the role's account at most.
    """
    p = (provider or "").upper()
    if p == "AZURE":
        return (credentials.get("subscription_id") or "").strip().lower() or None
    if p in ("OCI", "ORACLE"):
        return (credentials.get("tenancy_ocid") or "").strip() or None
    if p == "AWS":
        arn = (credentials.get("role_arn") or "").strip()
        parts = arn.split(":")
        if len(parts) >= 5 and parts[4].isdigit():
            return parts[4]
    return None


class CloudAccountService:
    def __init__(self, db: AsyncSession) -> None:
        self.repo = CloudAccountRepository(db)
        self.db = db

    @staticmethod
    async def _validate_credentials(provider: str, credentials: dict) -> Optional[str]:
        """Authenticate against the provider before persisting the account.

        Returns the provider's own id for the account the credentials reach
        (for an assumed AWS role, the TARGET account). Raises ValueError with a
        provider-specific message on failure.
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
        instance = cls(credentials)
        await instance.authenticate()
        auth = getattr(instance, "auth", None)
        return (getattr(auth, "account_id", None)
                or identity_from_credentials(provider, credentials))

    async def _require_client(self, client_id: Optional[uuid.UUID]) -> None:
        if client_id is None:
            return
        if await self.db.get(CloudClient, client_id) is None:
            raise ValueError(f"Client {client_id} does not exist.")

    async def create_account(self, payload: CloudAccountCreate) -> CloudAccountResponse:
        credentials = payload.extract_credentials()
        await self._require_client(payload.target_client_id)
        provider_account_id = await self._validate_credentials(payload.provider, credentials)
        encrypted = encrypt_credentials(credentials)

        auth_mode = payload.auth_mode
        if (payload.provider or "").upper() == "AWS" and credentials.get("role_arn"):
            auth_mode = "AssumeRole"

        account = await self.repo.create(
            account_name=payload.account_name,
            provider=payload.provider,
            environment=payload.environment,
            tenant_or_region=payload.tenant_or_region,
            auth_mode=auth_mode,
            auto_discovery=payload.auto_discovery,
            credentials_enc=encrypted,
            client_id=payload.target_client_id,
            provider_account_id=provider_account_id,
        )
        return await self._response(account)

    async def _client_names(self) -> Dict[uuid.UUID, str]:
        rows = (await self.db.execute(select(CloudClient.id, CloudClient.name))).all()
        return {cid: name for cid, name in rows}

    async def _response(self, account: CloudAccount,
                        names: Optional[Dict[uuid.UUID, str]] = None) -> CloudAccountResponse:
        resp = CloudAccountResponse.model_validate(account)
        if account.client_id:
            names = names if names is not None else await self._client_names()
            resp.client_name = names.get(account.client_id)
        return resp

    async def list_accounts(self) -> List[CloudAccountResponse]:
        accounts = await self.repo.list_all()
        disco_repo = DiscoveryRepository(self.repo.db)
        names = await self._client_names()
        results = []
        for account in accounts:
            resp = await self._response(account, names)
            job = await disco_repo.get_latest_for_account(account.id)
            resp.last_discovery_status = _classify_discovery_status(job)
            results.append(resp)
        return results

    async def get_account(self, account_id: uuid.UUID) -> CloudAccountResponse | None:
        account = await self.repo.get_by_id(account_id)
        if not account:
            return None
        return await self._response(account)

    async def delete_account(self, account_id: uuid.UUID) -> bool:
        return await self.repo.delete(account_id)


async def backfill_provider_account_ids(db: AsyncSession) -> Tuple[int, int]:
    """Fill `provider_account_id` for accounts created before it existed.

    Local only: decrypts stored credentials and reads the id off them, which
    works for Azure and OCI. AWS accounts connected with plain keys are filled
    by the next discovery instead (STS names the account there). An account
    whose credentials cannot be decrypted is skipped, never guessed at — see
    the cloud-encryption-key note on why a clone's key may not match.
    """
    rows = (await db.execute(
        select(CloudAccount).where(CloudAccount.provider_account_id.is_(None))
    )).scalars().all()
    filled = skipped = 0
    for account in rows:
        try:
            creds = decrypt_credentials(account.credentials_enc)
        except Exception:  # noqa: BLE001 — undecryptable is skipped, not fatal
            skipped += 1
            continue
        ident = identity_from_credentials(account.provider, creds)
        if ident:
            account.provider_account_id = ident
            filled += 1
        else:
            skipped += 1
    if filled:
        await db.flush()
    return filled, skipped
