from typing import Any, Dict, List
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, status
from app.services.alerting_service import alerting_svc

router = APIRouter(prefix="/cloud/alerts", tags=["Alerts"])

class AnomalySimulation(BaseModel):
    anomaly_type: str = "Unusual GPU Instance Sprawl"
    details: str = "A massive p4d.24xlarge ($2,000/mo) instance was just spun up in us-east-1 outside of approved infrastructure provisioning windows."
    severity: str = "CRITICAL"

@router.get("", response_model=List[Dict[str, Any]])
async def get_alerts():
    """Retrieve all in-app alerts."""
    return alerting_svc.get_all_alerts()

@router.post("/simulate", response_model=Dict[str, Any])
async def simulate_anomaly(sim: AnomalySimulation):
    """Trigger a mock anomaly."""
    new_alert = alerting_svc.trigger_anomaly_alert(
        anomaly_type=sim.anomaly_type,
        details=sim.details,
        severity=sim.severity
    )
    return {"status": "success", "alert": new_alert}

@router.post("/{alert_id}/read", response_model=Dict[str, Any])
async def mark_alert_read(alert_id: str):
    success = alerting_svc.mark_as_read(alert_id)
    if success:
        return {"status": "success"}
    raise HTTPException(status_code=404, detail="Alert not found")
