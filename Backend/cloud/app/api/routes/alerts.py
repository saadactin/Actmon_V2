from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.api.deps import get_alerting_service
from app.core.config import settings
from app.services.alerting_service import AlertingService

router = APIRouter(prefix="/cloud/alerts", tags=["Alerts"])


class AnomalySimulation(BaseModel):
    anomaly_type: str
    details: str
    severity: str = "HIGH"


@router.get("", response_model=List[Dict[str, Any]])
async def get_alerts(
    account_id: Optional[str] = Query(
        None, description="Limit to one cloud account."
    ),
    include_resolved: bool = Query(
        False, description="Include alerts whose condition has cleared."
    ),
    svc: AlertingService = Depends(get_alerting_service),
):
    """Alerts, newest first. Resolved ones are hidden unless asked for, so the
    default feed is only what still needs attention.

    Simulated test alerts (DEBUG mode) carry simulated=true so the UI can label
    or exclude them.
    """
    return await svc.get_all_alerts(
        account_id=account_id, include_resolved=include_resolved
    )


@router.get("/counts", response_model=Dict[str, int])
async def get_alert_counts(
    account_id: Optional[str] = Query(None),
    svc: AlertingService = Depends(get_alerting_service),
):
    """Per-state totals, for a badge or summary without pulling the whole feed."""
    return await svc.counts(account_id=account_id)


@router.post("/simulate", response_model=Dict[str, Any])
async def simulate_anomaly(
    sim: AnomalySimulation,
    svc: AlertingService = Depends(get_alerting_service),
):
    """DEBUG-only test hook. Creates an alert explicitly tagged simulated=true.
    Disabled entirely outside DEBUG mode — production alert feeds must never
    contain fabricated entries."""
    if not settings.DEBUG:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Alert simulation is disabled outside DEBUG mode.",
        )
    new_alert = await svc.trigger_anomaly_alert(
        anomaly_type=sim.anomaly_type,
        details=sim.details,
        severity=sim.severity,
        simulated=True,
    )
    return {"status": "success", "alert": new_alert}


@router.post("/{alert_id}/acknowledge", response_model=Dict[str, Any])
async def acknowledge_alert(
    alert_id: str, svc: AlertingService = Depends(get_alerting_service)
):
    """Someone has seen it and owns it. Stays in the feed until resolved."""
    alert = await svc.acknowledge(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"status": "success", "alert": alert}


@router.post("/{alert_id}/resolve", response_model=Dict[str, Any])
async def resolve_alert(
    alert_id: str, svc: AlertingService = Depends(get_alerting_service)
):
    """The condition is fixed. Drops out of the default feed but is kept as
    history, and re-opens automatically if the condition comes back."""
    alert = await svc.resolve(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"status": "success", "alert": alert}


@router.post("/{alert_id}/read", response_model=Dict[str, Any])
async def mark_alert_read(
    alert_id: str, svc: AlertingService = Depends(get_alerting_service)
):
    """Kept for the existing UI's "Mark as read" button, which is an
    acknowledgement in everything but name."""
    alert = await svc.acknowledge(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"status": "success", "alert": alert}
