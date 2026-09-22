"""
Cloud Dashboard — RBAC-gated aggregation endpoint for Cloud Engineers. Every
request must hold View on the CLOUD_DASHBOARD page (see
migrations/2026-09-18_cloud_dashboard_page.sql) via the same
permission_guard.require_permission() dependency every other governed route
in this app uses — never bypassed, never left to frontend route-hiding alone.
Denied requests get a real 403, not an empty/filtered response.
"""
from fastapi import APIRouter, Depends

from app.services.auth.permission_guard import require_permission
from app.services.cloud.cloud_dashboard_service import svc_cloud_dashboard_overview

router = APIRouter(prefix="/api/v1/cloud-dashboard", tags=["Cloud Dashboard"])

CLOUD_DASHBOARD_PAGE = "/cloud-dashboard"


@router.get("/overview")
def route_cloud_dashboard_overview(claims: dict = Depends(require_permission(CLOUD_DASHBOARD_PAGE, "view"))):
    return svc_cloud_dashboard_overview()
