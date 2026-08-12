"""Service layer for resource retrieval and inventory queries."""
from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository
from app.schemas.resource import CloudResourceDetail, CloudResourceResponse
from app.services.cost_service import (
    ensure_costs_by_resource_warm,
    fetch_real_costs_by_resource,
    peek_costs_by_resource,
)

# Longest a single resource-detail request will wait on the billing API before
# rendering without cost. Lists never wait at all.
_DETAIL_COST_TIMEOUT_S = 8


class ResourceService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = ResourceRepository(db)
        self.account_repo = CloudAccountRepository(db)

    def _apply_real_cost(self, resp: CloudResourceResponse, provider_resource_id: str,
                          cost_map: Dict[str, Dict[str, Any]]) -> None:
        # Azure's Cost Management API returns ResourceId in a different case than
        # ARM's resources.list() does, so an exact-match lookup silently misses
        # every Azure resource. Fall back to a case-insensitive match (OCI/AWS
        # ids are already consistent, so the exact hit short-circuits first).
        entry = cost_map.get(provider_resource_id)
        if entry is None and provider_resource_id:
            entry = cost_map.get(provider_resource_id.lower())
        if entry:
            resp.cost_monthly = entry["monthly_cost"]

    def _decorate(self, responses, resources, cost_map) -> None:
        if not cost_map:
            return
        for resp, r in zip(responses, resources):
            self._apply_real_cost(resp, r.provider_resource_id, cost_map)

    async def list_resources(self, account_id: uuid.UUID) -> List[CloudResourceResponse]:
        resources = await self.repo.list_by_account(account_id)
        responses = [CloudResourceResponse.model_validate(r) for r in resources]
        account = await self.account_repo.get_by_id(account_id)
        if account:
            # Cost is a decoration on top of DB-backed inventory — never let a
            # slow/failing billing API stop the resource list from rendering.
            # Serve whatever is cached now and refresh in the background.
            self._decorate(responses, resources, peek_costs_by_resource(account))
            ensure_costs_by_resource_warm(account)
        return responses

    async def list_all_resources(self) -> List[CloudResourceResponse]:
        resources = await self.repo.list_all()
        responses = [CloudResourceResponse.model_validate(r) for r in resources]

        distinct_ids = list({r.account_id for r in resources})
        accounts = await asyncio.gather(
            *(self.account_repo.get_by_id(aid) for aid in distinct_ids)
        )
        cost_maps_by_account: Dict[uuid.UUID, Dict[str, Dict[str, Any]]] = {}
        for account in accounts:
            if not account:
                continue
            cost_maps_by_account[account.id] = peek_costs_by_resource(account)
            ensure_costs_by_resource_warm(account)

        for resp, r in zip(responses, resources):
            cost_map = cost_maps_by_account.get(r.account_id)
            if cost_map:
                self._apply_real_cost(resp, r.provider_resource_id, cost_map)
        return responses

    async def get_resource_detail(self, resource_id: uuid.UUID) -> CloudResourceDetail | None:
        resource = await self.repo.get_by_id(resource_id)
        if not resource:
            return None
        detail = CloudResourceDetail.model_validate(resource)
        account = await self.account_repo.get_by_id(resource.account_id)
        if account:
            # A drill-in may wait briefly for real cost, but never indefinitely.
            try:
                cost_map = await asyncio.wait_for(
                    fetch_real_costs_by_resource(account), _DETAIL_COST_TIMEOUT_S
                )
            except Exception:  # timeout or provider failure
                cost_map = peek_costs_by_resource(account)
                ensure_costs_by_resource_warm(account)
            self._apply_real_cost(detail, resource.provider_resource_id, cost_map)
        return detail

    async def get_scan_diagnostic(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Why this account's resource inventory looks the way it does — backs
        the "why is this empty / stale" popup, using the real discovery job
        history instead of leaving an empty list unexplained."""
        from app.repository.discovery_repo import DiscoveryRepository

        job = await DiscoveryRepository(self.db).get_latest_for_account(account_id)
        if not job:
            return {
                "status": "never_scanned",
                "message": "This account has never been scanned. Click Refresh or Scan All Accounts to run discovery.",
            }
        if job.status == "FAILED":
            return {
                "status": "failed",
                "message": job.error_detail or "The last discovery scan failed with no further detail recorded.",
                "completed_at": job.completed_at.isoformat() if job.completed_at else None,
            }
        if job.status in ("RUNNING", "PENDING"):
            return {
                "status": "scanning",
                "message": "A discovery scan is currently in progress — resources will appear once it completes.",
            }
        return {
            "status": "ok",
            "resources_found": job.resources_found,
            "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        }

