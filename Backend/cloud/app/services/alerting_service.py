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

    def trigger_anomaly_alert(self, anomaly_type: str, details: str, severity: str = "HIGH",
                              simulated: bool = False, account_id: str | None = None) -> Dict[str, Any]:
        """Creates a new in-app alert. simulated=True marks test alerts so they
        can never be mistaken for real anomalies. account_id lets the frontend's
        provider/account scope filter (filterByScope) narrow alerts correctly."""
        new_alert = {
            "id": str(uuid.uuid4()),
            "anomaly_type": anomaly_type,
            "details": details,
            "severity": severity,
            "created_at": datetime.datetime.utcnow().isoformat() + "Z",
            "is_read": False,
            "simulated": simulated,
            "account_id": account_id,
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

# Resource types that represent detachable block storage across providers.
_STORAGE_TYPES = {"BlockVolume", "ManagedDisk", "EBSVolume"}

# Resource IDs already alerted for a stopped-instance-with-attached-storage
# condition, so a re-scan of an unchanged, already-flagged resource doesn't
# spam a duplicate alert every discovery cycle. Cleared once the condition
# resolves (volume detached or instance restarted) so a future recurrence
# alerts again.
_alerted_resource_keys: set[str] = set()


def _is_stopped(status: str | None) -> bool:
    s = (status or "").lower()
    return "stop" in s or "deallocat" in s


def check_storage_attachment_alerts(
    account_name: str, resources: List[Dict[str, Any]], account_id: str | None = None
) -> None:
    """Scan freshly-discovered storage resources for a costly attachment state:
    a disk/volume still attached to a stopped compute instance, which keeps
    billing for storage while the compute side is idle."""
    for r in resources:
        if r.get("resource_type") not in _STORAGE_TYPES:
            continue
        cfg = r.get("config") or {}
        pid = r.get("provider_resource_id")
        key = f"STOPPED_INSTANCE_ATTACHED_STORAGE:{pid}"

        problematic = (
            cfg.get("attachment_status") == "Attached"
            and _is_stopped(cfg.get("attached_to_status"))
        )
        if not problematic:
            _alerted_resource_keys.discard(key)
            continue
        if key in _alerted_resource_keys:
            continue
        _alerted_resource_keys.add(key)

        alerting_svc.trigger_anomaly_alert(
            anomaly_type="STOPPED_INSTANCE_ATTACHED_STORAGE",
            details=(
                f"[{account_name}] '{r.get('resource_name')}' ({r.get('resource_type')}) is "
                f"still attached to '{cfg.get('attached_to_name') or cfg.get('attached_to_id')}', "
                f"which is stopped — this storage keeps billing while the instance is idle."
            ),
            severity="HIGH",
            account_id=account_id,
        )
