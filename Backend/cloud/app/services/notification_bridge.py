"""Bridges cloud alerts into the notification system that already ships for
DB-monitoring alerts (`Backend/database/app/services/notifications/...`).

The cloud service and the database service are separate processes with
separate SQLAlchemy metadata, but they point at the same physical Postgres
database (see Backend/cloud/.env and Backend/database/.env — same
DB_HOST/DB_PORT/DB_NAME). So instead of duplicating the channel adapters,
crypto, and retry/dispatch worker on the cloud side, this module writes
directly into the `notification_channels`, `severity_channel_routing`, and
`notification_queue` tables the database service already owns and already
polls (notification_queue_service.py, ticking every 10s). A cloud alert
becomes a queued notification the same way a firing DB alert rule does; the
existing dispatcher delivers it with zero changes on that side.

Deliberately raw SQL, not an ORM mirror model: declaring these as models
under cloud's own `Base` would register them in `Base.metadata` and make
`create_all` (run on every cloud service startup) responsible for them too —
harmless once the database service has created the real tables, but a race
on a from-scratch install could have the cloud service create a
narrower version of a table the database service also owns. Raw SQL against
tables this service doesn't own sidesteps that entirely.

This deployment is single-tenant per instance — cloud has no org concept at
all (no org_id anywhere in its models) — so org_id is always 1, matching the
default every DB-side model already falls back to.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("cloud_svc.notification_bridge")

ORG_ID = 1

# The Severity Routing UI only offers these three buckets (see
# frontend/src/config/notificationChannels.js SEVERITIES); cloud alerts use a
# finer CRITICAL/HIGH/MEDIUM/LOW/INFO scale (app/utils/drift_rules.py,
# app/services/exposure_service.py), so collapse onto the routing buckets.
_ROUTING_BUCKET = {
    "CRITICAL": "critical",
    "HIGH": "critical",
    "MEDIUM": "warning",
    "LOW": "information",
    "INFO": "information",
}


def _routing_bucket(severity: str) -> str:
    return _ROUTING_BUCKET.get((severity or "").upper(), "warning")


def _build_context(*, alert, account_name: Optional[str]) -> dict:
    """Same {{Variable}} shape template_service.build_context() produces on
    the DB side, so the built-in default templates (and any org override)
    render a cloud alert sensibly with no template changes needed. Fields
    with no cloud equivalent (Metric/CurrentValue/Threshold/IPAddress) are
    left blank rather than guessed."""
    when = alert.last_seen_at or alert.created_at
    return {
        "Organization": "ActMon Cloud",
        "AlertName": alert.anomaly_type.replace("_", " ").title(),
        "Severity": (alert.severity or "").title(),
        "ServerName": account_name or "—",
        "Hostname": alert.resource_name or "—",
        "DatabaseName": alert.resource_type or "—",
        "DatabaseType": alert.resource_type or "—",
        "Metric": "",
        "CurrentValue": "",
        "Threshold": "",
        "Error": "",
        "IPAddress": "",
        "Timestamp": when.isoformat() if when else "",
        "AlertDescription": alert.details or "",
    }


async def queue_notifications_for_alert(
    db: AsyncSession, alert, account_name: Optional[str] = None
) -> int:
    """Queue a notification_queue row per channel configured for this alert's
    severity bucket. Returns how many were queued. Never raises — a broken
    notification config must not stop an alert from being recorded, so
    callers can invoke this fire-and-forget."""
    try:
        bucket = _routing_bucket(alert.severity)

        wanted = (
            await db.execute(
                text(
                    "SELECT channel_type FROM severity_channel_routing "
                    "WHERE org_id = :org_id AND severity = :bucket AND enabled = true"
                ),
                {"org_id": ORG_ID, "bucket": bucket},
            )
        ).scalars().all()
        if not wanted:
            return 0

        # Email has no recipient concept for a cloud alert (no
        # notification_recipients/cc/bcc the way an AlertRule has) — routing
        # it would only ever produce a guaranteed-fail queue row, retried
        # three times, forever. Drop it here the same way the DB-side
        # evaluator drops email when no recipient is configured.
        wanted = [c for c in wanted if c != "email"]
        if not wanted:
            return 0

        enabled = (
            await db.execute(
                text(
                    "SELECT channel_type FROM notification_channels "
                    "WHERE org_id = :org_id AND channel_type = ANY(:wanted) AND enabled = true"
                ),
                {"org_id": ORG_ID, "wanted": wanted},
            )
        ).scalars().all()
        if not enabled:
            return 0

        context = _build_context(alert=alert, account_name=account_name)
        # notification_queue.next_attempt_at/created_at are naive DateTime
        # columns on the database service's side (default=datetime.utcnow) —
        # a tz-aware value here makes asyncpg refuse the bind ("can't
        # subtract offset-naive and offset-aware datetimes").
        now = datetime.utcnow()
        for channel_type in enabled:
            await db.execute(
                text(
                    "INSERT INTO notification_queue "
                    "(org_id, alert_rule_id, channel_type, payload, status, "
                    " attempt_count, max_attempts, next_attempt_at, timeout_seconds, created_at) "
                    "VALUES "
                    "(:org_id, NULL, :channel_type, CAST(:payload AS JSONB), 'pending', "
                    " 0, 3, :next_attempt_at, 15, :created_at)"
                ),
                {
                    "org_id": ORG_ID,
                    "channel_type": channel_type,
                    "payload": json.dumps({"context": context}),
                    "next_attempt_at": now,
                    "created_at": now,
                },
            )
        return len(enabled)
    except Exception:  # noqa: BLE001 — notification delivery must never break alerting
        logger.exception("Failed to queue notifications for alert %s", getattr(alert, "id", "?"))
        return 0
