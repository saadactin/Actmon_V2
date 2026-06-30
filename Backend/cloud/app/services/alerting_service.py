"""Alerting service for In-App Alerts."""
from __future__ import annotations

import logging
from typing import Any, Dict, List
import uuid
import datetime

logger = logging.getLogger("cloud_svc.alerts")

class AlertingService:
    def __init__(self):
        self.alerts: List[Dict[str, Any]] = []

    def get_all_alerts(self) -> List[Dict[str, Any]]:
        """Returns all alerts, newest first."""
        return sorted(self.alerts, key=lambda x: x["created_at"], reverse=True)

    def trigger_anomaly_alert(self, anomaly_type: str, details: str, severity: str = "HIGH") -> Dict[str, Any]:
        """Creates a new in-app alert."""
        new_alert = {
            "id": str(uuid.uuid4()),
            "anomaly_type": anomaly_type,
            "details": details,
            "severity": severity,
            "created_at": datetime.datetime.utcnow().isoformat() + "Z",
            "is_read": False
        }
        self.alerts.append(new_alert)
        logger.info(f"New in-app alert created: {anomaly_type}")
        return new_alert

    def mark_as_read(self, alert_id: str) -> bool:
        for a in self.alerts:
            if a["id"] == alert_id:
                a["is_read"] = True
                return True
        return False

# Global instance for in-memory persistence across requests
alerting_svc = AlertingService()
