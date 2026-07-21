from typing import Any, Dict, List
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, status
from app.core.config import settings
from app.services.alerting_service import alerting_svc

router = APIRouter(prefix="/cloud/alerts", tags=["Alerts"])


class AnomalySimulation(BaseModel):
    anomaly_type: str
    details: str
    severity: str = "HIGH"


@router.get("", response_model=List[Dict[str, Any]])
async def get_alerts():
    """Retrieve all in-app alerts. Real alerts only — simulated test alerts
    (DEBUG mode) carry simulated=true so the UI can label or exclude them."""
    return alerting_svc.get_all_alerts()


@router.post("/simulate", response_model=Dict[str, Any])
async def simulate_anomaly(sim: AnomalySimulation):
    """DEBUG-only test hook. Creates an alert explicitly tagged simulated=true.
    Disabled entirely outside DEBUG mode — production alert feeds must never
    contain fabricated entries."""
    if not settings.DEBUG:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Alert simulation is disabled outside DEBUG mode.",
        )
    new_alert = alerting_svc.trigger_anomaly_alert(
        anomaly_type=sim.anomaly_type,
        details=sim.details,
        severity=sim.severity,
        simulated=True,
    )
    return {"status": "success", "alert": new_alert}


@router.post("/{alert_id}/read", response_model=Dict[str, Any])
async def mark_alert_read(alert_id: str):
    success = alerting_svc.mark_as_read(alert_id)
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Alert not found")
