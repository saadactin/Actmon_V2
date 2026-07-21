"""
FastAPI application entry point for the Cloud Discovery microservice.

Runs on port 8001 (configurable via CLOUD_SERVICE_PORT in .env).
All routes are prefixed with /api/v1 to match the frontend Axios client
and be compatible with Vite's proxy rules.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import setup_logging

# ── Bootstrap logging ─────────────────────────────────────────────────────────
setup_logging("DEBUG" if settings.DEBUG else "INFO")

# ── Import models so SQLAlchemy registers the tables ──────────────────────────
from app.models.cloud_account import CloudAccount   # noqa: F401
from app.models.resource import CloudResource       # noqa: F401
from app.models.discovery_job import DiscoveryJob   # noqa: F401


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create DB tables on startup (idempotent — skips existing tables)."""
    import asyncio
    import os
    from concurrent.futures import ThreadPoolExecutor

    from app.core.database import engine, Base

    # Cloud SDK calls (boto3 / azure-sdk / oci) are blocking and are run via
    # loop.run_in_executor(None, ...). Python's default executor caps at
    # ~min(32, cpu+4) threads, which serializes the large
    # region × compartment × service fan-out and makes a single scan slow.
    # These calls are I/O-bound (they release the GIL while waiting on the
    # network), so a high thread count is safe and lets the fan-out — and
    # several accounts scanning at once — run truly concurrently.
    try:
        max_workers = int(os.getenv("CLOUD_SCAN_MAX_WORKERS", "64"))
    except ValueError:
        max_workers = 64
    asyncio.get_running_loop().set_default_executor(
        ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="cloud-scan")
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield

    await engine.dispose()


# ── Application ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="ACTMON Cloud Discovery Service",
    version="1.0.0",
    description=(
        "Microservice for cloud account management, background resource discovery, "
        "and inventory across AWS, Azure, and OCI."
    ),
    lifespan=lifespan,
    docs_url="/api/v1/cloud/docs",
    openapi_url="/api/v1/cloud/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api.routes.cloud_accounts import router as accounts_router
from app.api.routes.discovery import router as discovery_router
from app.api.routes.resources import router as resources_router
from app.api.routes.cost import router as cost_router
from app.api.routes.security import router as security_router
from app.api.routes.cost_estimate import router as cost_estimate_router
from app.api.routes.topology import router as topology_router
from app.api.routes.compliance import router as compliance_router
from app.api.routes.alerts import router as alerts_router

# Standard API routes under /api/v1/
for router in [accounts_router, discovery_router, resources_router, cost_router, security_router, cost_estimate_router, topology_router, compliance_router, alerts_router]:
    app.include_router(router, prefix="/api/v1")




# ── Frontend-compatible inventory route ───────────────────────────────────────
# Frontend calls: GET /cloud/{provider}/{account_id}/inventory
# via Axios baseURL = /api/v1, so the full URL is:
#   GET /api/v1/cloud/{provider}/{account_id}/inventory
@app.get("/api/v1/cloud/{provider}/{account_id}/inventory")
async def get_provider_inventory(provider: str, account_id: str):
    """
    Frontend-compatible inventory endpoint.
    Returns normalized resource list from the DB for the given account.
    """
    import uuid
    from fastapi import HTTPException
    from app.core.database import AsyncSessionLocal
    from app.repository.resource_repo import ResourceRepository

    try:
        aid = uuid.UUID(account_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid account_id UUID")

    async with AsyncSessionLocal() as db:
        repo = ResourceRepository(db)
        resources = await repo.list_by_account(aid)

    return [
        {
            "id": str(r.id),
            "resource_name": r.resource_name,
            "resource_type": r.resource_type,
            "region_or_zone": r.region_or_zone,
            "status": r.status,
            "ip_address": r.ip_address,
            "config": r.config,
            "cost_monthly": r.cost_monthly,
            "tags": r.tags,
            "discovered_at": r.discovered_at.isoformat() if r.discovered_at else None,
        }
        for r in resources
    ]


@app.get("/")
def health():
    return {"status": "ok", "service": "ACTMON Cloud Discovery", "version": "1.0.0"}


@app.get("/health")
def health_check():
    return {"status": "healthy"}
