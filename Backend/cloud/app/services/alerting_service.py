"""Alerting service — database-backed.

Alerts were previously a Python list on a module-level singleton, which meant
the whole history vanished on every restart and nothing could be acknowledged
or resolved. They now live in cloud_alerts with a real lifecycle
(OPEN → ACKNOWLEDGED → RESOLVED) and survive restarts.

Two behaviours worth knowing:

* Recurrence is deduplicated by `dedupe_key`, so a condition seen on every
  discovery cycle updates one alert (bumping last_seen_at / occurrence_count)
  instead of appending an identical row each time.
* A condition that stops appearing is auto-resolved, so a fixed problem clears
  itself rather than lingering until someone dismisses it by hand.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import STATE_ACKNOWLEDGED, STATE_OPEN, STATE_RESOLVED
from app.repository.alert_repo import AlertRepository

logger = logging.getLogger("cloud_svc.alerts")

# Resource types that represent detachable block storage across providers.
_STORAGE_TYPES = {"BlockVolume", "ManagedDisk", "EBSVolume"}

# Rule identifier, also used as the dedupe-key prefix so auto-resolve can find
# exactly the alerts this rule owns and leave every other rule's alone.
RULE_STOPPED_INSTANCE_STORAGE = "STOPPED_INSTANCE_ATTACHED_STORAGE"


def _as_uuid(value) -> Optional[uuid.UUID]:
    """Accept a UUID or its string form; None for anything unparseable, since a
    bad id should not stop an alert from being recorded."""
    if value is None or isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def _is_stopped(status: Optional[str]) -> bool:
    s = (status or "").lower()
    return "stop" in s or "deallocat" in s


class AlertingService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = AlertRepository(db)

    async def get_all_alerts(
        self,
        account_id=None,
        states: Optional[List[str]] = None,
        include_resolved: bool = False,
    ) -> List[Dict[str, Any]]:
        """Newest first. Resolved alerts are excluded by default — the feed is
        meant to show what still needs attention, with history available on
        request."""
        if states is None:
            states = (
                [STATE_OPEN, STATE_ACKNOWLEDGED, STATE_RESOLVED]
                if include_resolved
                else [STATE_OPEN, STATE_ACKNOWLEDGED]
            )
        rows = await self.repo.list_alerts(
            account_id=_as_uuid(account_id), states=states
        )
        return [r.to_dict() for r in rows]

    async def trigger_anomaly_alert(
        self,
        anomaly_type: str,
        details: str,
        severity: str = "HIGH",
        simulated: bool = False,
        account_id=None,
        dedupe_key: Optional[str] = None,
        resource_id=None,
        resource_name: Optional[str] = None,
        resource_type: Optional[str] = None,
        context: Optional[dict] = None,
    ) -> Dict[str, Any]:
        """Record an alert, deduplicating on dedupe_key when given."""
        alert = await self.repo.upsert(
            anomaly_type=anomaly_type,
            details=details,
            severity=severity,
            dedupe_key=dedupe_key,
            account_id=_as_uuid(account_id),
            resource_id=_as_uuid(resource_id),
            resource_name=resource_name,
            resource_type=resource_type,
            context=context,
            simulated=simulated,
        )
        await self.db.commit()
        logger.info(
            "Alert recorded: %s (severity=%s, occurrence=%s)",
            anomaly_type, severity, alert.occurrence_count,
        )
        return alert.to_dict()

    async def acknowledge(self, alert_id: str) -> Optional[Dict[str, Any]]:
        parsed = _as_uuid(alert_id)
        if parsed is None:
            return None
        alert = await self.repo.acknowledge(parsed)
        if alert is None:
            return None
        await self.db.commit()
        return alert.to_dict()

    async def resolve(self, alert_id: str) -> Optional[Dict[str, Any]]:
        parsed = _as_uuid(alert_id)
        if parsed is None:
            return None
        alert = await self.repo.resolve(parsed)
        if alert is None:
            return None
        await self.db.commit()
        return alert.to_dict()

    async def counts(self, account_id=None) -> Dict[str, int]:
        return await self.repo.counts_by_state(_as_uuid(account_id))


async def check_storage_attachment_alerts(
    db: AsyncSession,
    account_name: str,
    resources: List[Dict[str, Any]],
    account_id=None,
    sweep_complete: bool = True,
) -> int:
    """Storage still attached to a stopped compute instance — it keeps billing
    while the compute side is idle.

    Returns the number of currently-offending resources. Anything previously
    flagged that no longer offends is auto-resolved, so detaching a volume or
    restarting its instance closes the alert without manual cleanup.

    `sweep_complete=False` means the scan could not enumerate every scope, so
    `resources` is a subset of reality. Auto-resolve is then skipped for the same
    reason the inventory prune is: "absent from this list" would mean "failed to
    list", and closing a still-broken alert is worse than leaving it open one
    cycle longer. New alerts are still recorded from whatever did enumerate.
    """
    repo = AlertRepository(db)
    svc = AlertingService(db)
    seen_keys: List[str] = []

    for r in resources:
        if r.get("resource_type") not in _STORAGE_TYPES:
            continue
        cfg = r.get("config") or {}
        if not (
            cfg.get("attachment_status") == "Attached"
            and _is_stopped(cfg.get("attached_to_status"))
        ):
            continue

        pid = r.get("provider_resource_id")
        key = f"{RULE_STOPPED_INSTANCE_STORAGE}:{pid}"
        seen_keys.append(key)
        attached_to = cfg.get("attached_to_name") or cfg.get("attached_to_id")

        await svc.trigger_anomaly_alert(
            anomaly_type=RULE_STOPPED_INSTANCE_STORAGE,
            details=(
                f"[{account_name}] '{r.get('resource_name')}' ({r.get('resource_type')}) is "
                f"still attached to '{attached_to}', which is stopped — this storage keeps "
                "billing while the instance is idle."
            ),
            severity="HIGH",
            account_id=account_id,
            dedupe_key=key,
            resource_name=r.get("resource_name"),
            resource_type=r.get("resource_type"),
            context={
                "provider_resource_id": pid,
                "attached_to": attached_to,
                "attached_to_status": cfg.get("attached_to_status"),
                "size_gb": cfg.get("size_gb") or cfg.get("disk_size_gb"),
            },
        )

    parsed_account = _as_uuid(account_id)
    if not sweep_complete:
        logger.info(
            "Skipping storage-alert auto-resolve for %s — incomplete sweep, so an "
            "absent resource may just have failed to enumerate.", account_name,
        )
        return len(seen_keys)
    if parsed_account is None:
        # Without an account to scope by, auto-resolve would test this one
        # account's findings against every account's alerts and close the rest.
        logger.warning(
            "Skipping storage-alert auto-resolve for %s — no usable account_id to "
            "scope it to.", account_name,
        )
        return len(seen_keys)

    closed = await repo.auto_resolve_missing(
        seen_keys, f"{RULE_STOPPED_INSTANCE_STORAGE}:", account_id=parsed_account
    )
    if closed:
        await db.commit()
        logger.info("Auto-resolved %d storage-attachment alert(s) no longer offending", closed)
    return len(seen_keys)
