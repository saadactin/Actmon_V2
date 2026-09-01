"""FastAPI dependency injectors."""
from __future__ import annotations

from typing import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services.alerting_service import AlertingService
from app.services.cloud_account_service import CloudAccountService
from app.services.discovery_service import DiscoveryService
from app.services.drift_service import DriftService
from app.services.resource_service import ResourceService
from app.services.cost_service import CostService


async def get_account_service(db: AsyncSession = Depends(get_db)) -> CloudAccountService:
    return CloudAccountService(db)


async def get_discovery_service(db: AsyncSession = Depends(get_db)) -> DiscoveryService:
    return DiscoveryService(db)


async def get_resource_service(db: AsyncSession = Depends(get_db)) -> ResourceService:
    return ResourceService(db)


async def get_cost_service(db: AsyncSession = Depends(get_db)) -> CostService:
    return CostService(db)


async def get_alerting_service(db: AsyncSession = Depends(get_db)) -> AlertingService:
    return AlertingService(db)


async def get_drift_service(db: AsyncSession = Depends(get_db)) -> DriftService:
    return DriftService(db)
