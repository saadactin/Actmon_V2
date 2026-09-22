"""Alert analytics: what fired, what delivered, and which rules are too loud.

Everything here is a database aggregate over rows the engine already wrote.
Nothing is estimated, smoothed, extrapolated or back-filled — a day with no
alerts is a real zero because we have a complete record of that day, whereas a
metric we could not read comes back as `null` and the UI renders NA.

The distinction matters most in `noisy_rules`. A "resolution rate" of 0% means
something very different when a rule has fired twice than when it has fired
1,800 times, so the payload carries the counts the rate was computed from and
refuses to compute a rate at all below a floor. A confident percentage derived
from three data points is how a tuning feature ends up making things worse.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, case, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import (
    ACTIVE_STATES, STATE_ACKNOWLEDGED, STATE_OPEN, STATE_PENDING, STATE_RESOLVED,
    CloudAlert,
)
from app.models.alert_rule import (
    ACT_ALERT_RESOLVED, ACT_ALERT_TRIGGERED, ACT_NOTIFY_QUEUED,
    ACT_NOTIFY_SKIPPED, CloudAlertEvent, CloudAlertRule,
)

logger = logging.getLogger("cloud_svc.alerts.analytics")

SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")

# The categories the rule engine actually has. Imported from the model rather
# than restated, so a new category cannot appear in the engine and be silently
# bucketed as "direct" by this chart.
from app.models.alert_rule import CATEGORIES as _KNOWN_CATEGORIES  # noqa: E402

# Below this many triggers a rule's rates are not reported as percentages.
# Three firings do not establish a 33% resolution rate.
MIN_SAMPLES_FOR_RATE = 5

# A rule producing more than this many notifications a day is flagged. Not a
# law — it is the default bar, and the payload says so, because "too noisy"
# depends entirely on who is reading the mail.
NOISY_NOTIFICATIONS_PER_DAY = 10


class AlertAnalytics:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def overview(self, account_id: uuid.UUID, *, days: int = 30) -> Dict[str, Any]:
        """Everything the charts need, in one round of aggregates."""
        since = datetime.now(timezone.utc) - timedelta(days=days)
        scope = and_(CloudAlert.account_id == account_id,
                     CloudAlert.created_at >= since,
                     # PENDING rows are held breaches, not alerts. Counting them
                     # would inflate every chart with spikes that never became
                     # incidents — which is the opposite of what the
                     # minimum-duration bar exists to achieve.
                     CloudAlert.state != STATE_PENDING)

        return {
            "window_days": days,
            "since": since.isoformat(),
            "over_time": await self._over_time(scope, since, days),
            "by_severity": await self._by_severity(scope),
            "by_category": await self._by_category(scope),
            "by_provider": await self._by_provider(account_id, since),
            "by_state": await self._by_state(scope),
            "notifications": await self._notification_outcomes(account_id, since),
            "top_rules": await self._top_rules(account_id, since, limit=8),
            "mean_time_to_resolve_seconds": await self._mttr(scope),
        }

    async def _over_time(self, scope, since: datetime, days: int) -> List[Dict[str, Any]]:
        """One bucket per day, per severity. Days with nothing are REAL zeros.

        Padded in Python rather than left sparse: a chart that silently omits
        quiet days compresses the x-axis and makes a steady trickle look like a
        burst.
        """
        rows = (await self.db.execute(
            select(
                func.date_trunc("day", CloudAlert.created_at).label("day"),
                CloudAlert.severity,
                func.count().label("n"),
            ).where(scope).group_by("day", CloudAlert.severity).order_by("day")
        )).all()

        buckets: Dict[str, Dict[str, int]] = {}
        for day, severity, n in rows:
            key = day.date().isoformat()
            buckets.setdefault(key, {})[(severity or "INFO").upper()] = int(n)

        out: List[Dict[str, Any]] = []
        start = since.date()
        for offset in range(days + 1):
            key = (start + timedelta(days=offset)).isoformat()
            found = buckets.get(key, {})
            out.append({
                "date": key,
                **{s: found.get(s, 0) for s in SEVERITIES},
                "total": sum(found.values()),
            })
        return out

    async def _by_severity(self, scope) -> Dict[str, int]:
        rows = (await self.db.execute(
            select(CloudAlert.severity, func.count()).where(scope)
            .group_by(CloudAlert.severity)
        )).all()
        found = {(s or "INFO").upper(): int(n) for s, n in rows}
        # Every level present, including zeroes — a bar that vanishes at zero
        # makes the category look unavailable rather than empty.
        return {s: found.get(s, 0) for s in SEVERITIES}

    async def _by_category(self, scope) -> List[Dict[str, Any]]:
        """Alerts grouped by which part of the platform raised them.

        `anomaly_type` is "CATEGORY:condition_type" for rule-raised alerts, but
        alerts raised directly by a feature — the Security Center's own policy
        engine, the stopped-storage check — put a descriptive phrase there
        instead. Splitting on the colon unconditionally produced categories like
        "privilege escalation path" and "tenancy-wide or subscription-wide
        administrator": finding titles masquerading as categories, one bar each,
        and a chart that answered a question nobody asked.

        So the prefix is only trusted when it is a category this system actually
        has. Anything else is bucketed as raised outside the rule engine, which
        is both true and useful — it is exactly the set of alerts that no rule
        controls.
        """
        prefix = func.lower(func.split_part(CloudAlert.anomaly_type, ":", 1))
        category = case(
            (prefix.in_(list(_KNOWN_CATEGORIES)), prefix),
            else_="_direct",
        )
        rows = (await self.db.execute(
            select(category.label("category"), func.count())
            .where(scope).group_by("category").order_by(func.count().desc())
        )).all()
        return [
            {"category": c,
             # Named rather than left as a bare key, because "_direct" in a
             # chart legend is worse than no legend.
             "label": ("Raised outside the rule engine" if c == "_direct" else None),
             "count": int(n)}
            for c, n in rows
        ]

    async def _by_provider(self, account_id: uuid.UUID,
                           since: datetime) -> List[Dict[str, Any]]:
        from app.models.cloud_account import CloudAccount

        rows = (await self.db.execute(
            select(CloudAccount.provider, func.count())
            .select_from(CloudAlert)
            .join(CloudAccount, CloudAccount.id == CloudAlert.account_id)
            .where(CloudAlert.account_id == account_id,
                   CloudAlert.created_at >= since,
                   CloudAlert.state != STATE_PENDING)
            .group_by(CloudAccount.provider)
        )).all()
        return [{"provider": p, "count": int(n)} for p, n in rows]

    async def _by_state(self, scope) -> Dict[str, int]:
        rows = (await self.db.execute(
            select(CloudAlert.state, func.count()).where(scope)
            .group_by(CloudAlert.state)
        )).all()
        found = {s: int(n) for s, n in rows}
        return {s: found.get(s, 0)
                for s in (STATE_OPEN, STATE_ACKNOWLEDGED, STATE_RESOLVED)}

    async def _notification_outcomes(self, account_id: uuid.UUID,
                                     since: datetime) -> Dict[str, Any]:
        """Delivery as the alerting subsystem recorded it, plus the real ledger.

        Two sources on purpose. `notification_status` on the alert is what this
        service DECIDED (queued, suppressed, no recipient); `notification_history`
        is what the mail server actually DID. Reporting only the first would let
        "queued" masquerade as delivered, which is the specific failure this
        feature is built to avoid.
        """
        rows = (await self.db.execute(
            select(CloudAlert.notification_status, func.count())
            .where(CloudAlert.account_id == account_id,
                   CloudAlert.created_at >= since,
                   CloudAlert.state != STATE_PENDING)
            .group_by(CloudAlert.notification_status)
        )).all()
        decided = {(s or "not_attempted"): int(n) for s, n in rows}

        delivered: Optional[Dict[str, Any]] = None
        try:
            ledger = (await self.db.execute(text(
                "SELECT status, COUNT(*) FROM notification_history "
                "WHERE channel_type = 'email' AND sent_at >= :since "
                "GROUP BY status"
            ), {"since": since.replace(tzinfo=None)})).all()
            latency = (await self.db.execute(text(
                "SELECT AVG(response_time_ms), MAX(response_time_ms) "
                "FROM notification_history "
                "WHERE channel_type = 'email' AND sent_at >= :since "
                "  AND response_time_ms IS NOT NULL"
            ), {"since": since.replace(tzinfo=None)})).one()
            delivered = {
                "available": True,
                **{str(s): int(n) for s, n in ledger},
                "avg_latency_ms": (round(float(latency[0]), 1)
                                   if latency[0] is not None else None),
                "max_latency_ms": (round(float(latency[1]), 1)
                                   if latency[1] is not None else None),
            }
        except Exception as exc:  # noqa: BLE001 — another service's table
            logger.debug("Could not read the notification ledger: %s", exc)
            # None, not zero. An unreadable ledger is not a ledger of failures.
            delivered = {"available": False, "reason": str(exc)}

        return {"decided_by_engine": decided, "delivered": delivered}

    async def _mttr(self, scope) -> Optional[float]:
        """Mean seconds from first detection to resolution, or None.

        None when nothing has resolved yet — an estate with no resolutions has
        no mean time to resolve, and reporting 0 would read as instant.
        """
        value = (await self.db.execute(
            select(func.avg(
                func.extract("epoch", CloudAlert.resolved_at - CloudAlert.created_at)
            )).where(and_(scope, CloudAlert.state == STATE_RESOLVED,
                          CloudAlert.resolved_at.isnot(None)))
        )).scalar_one()
        return round(float(value), 1) if value is not None else None

    async def _top_rules(self, account_id: uuid.UUID, since: datetime,
                         *, limit: int) -> List[Dict[str, Any]]:
        rows = (await self.db.execute(
            select(
                CloudAlert.rule_id,
                func.count().label("alerts"),
                func.sum(CloudAlert.occurrence_count).label("occurrences"),
                func.sum(CloudAlert.notification_count).label("notifications"),
            )
            .where(CloudAlert.account_id == account_id,
                   CloudAlert.created_at >= since,
                   CloudAlert.state != STATE_PENDING,
                   CloudAlert.rule_id.isnot(None))
            .group_by(CloudAlert.rule_id)
            .order_by(func.count().desc()).limit(limit)
        )).all()
        names = await self._rule_names([r[0] for r in rows])
        return [
            {"rule_id": str(rid), "rule_name": names.get(rid, "Rule deleted"),
             "alerts": int(a or 0), "occurrences": int(o or 0),
             "notifications": int(n or 0)}
            for rid, a, o, n in rows
        ]

    async def _rule_names(self, rule_ids) -> Dict[uuid.UUID, str]:
        ids = [r for r in rule_ids if r]
        if not ids:
            return {}
        rows = (await self.db.execute(
            select(CloudAlertRule.id, CloudAlertRule.name,
                   CloudAlertRule.deleted_at)
            .where(CloudAlertRule.id.in_(ids))
        )).all()
        return {rid: (f"{name} (deleted)" if deleted else name)
                for rid, name, deleted in rows}

    # ── Alert fatigue ────────────────────────────────────────────────────────
    async def noisy_rules(self, account_id: uuid.UUID, *,
                          days: int = 7) -> Dict[str, Any]:
        """Which rules are producing more noise than signal.

        Four numbers per rule, because "noisy" has four different causes and
        they need different fixes:

          triggers      how often the condition became true — raise the
                        threshold, or add a minimum duration
          notifications how much mail it produced — lengthen the cooldown
          suppressed    how much mail the cooldown already prevented; a high
                        number here means the cooldown is working and the
                        THRESHOLD is the problem
          resolution    how often its alerts actually cleared; a rule that
                        fires constantly and never resolves is usually
                        measuring something that is not an incident

        No rule is auto-disabled and no threshold is auto-changed. This reports;
        the operator decides.
        """
        since = datetime.now(timezone.utc) - timedelta(days=days)

        alert_rows = (await self.db.execute(
            select(
                CloudAlert.rule_id,
                func.count().label("alerts"),
                func.sum(CloudAlert.occurrence_count).label("occurrences"),
                func.sum(CloudAlert.notification_count).label("notifications"),
                func.count().filter(CloudAlert.state == STATE_RESOLVED).label("resolved"),
                func.count().filter(CloudAlert.state.in_(ACTIVE_STATES)).label("active"),
            )
            .where(CloudAlert.account_id == account_id,
                   CloudAlert.created_at >= since,
                   CloudAlert.state != STATE_PENDING,
                   CloudAlert.rule_id.isnot(None))
            .group_by(CloudAlert.rule_id)
        )).all()

        suppressed_rows = dict((await self.db.execute(
            select(CloudAlertEvent.rule_id, func.count())
            .where(CloudAlertEvent.account_id == account_id,
                   CloudAlertEvent.at >= since,
                   CloudAlertEvent.action == ACT_NOTIFY_SKIPPED)
            .group_by(CloudAlertEvent.rule_id)
        )).all())

        names = await self._rule_names([r[0] for r in alert_rows])
        out: List[Dict[str, Any]] = []
        for rid, alerts, occurrences, notifications, resolved, active in alert_rows:
            alerts = int(alerts or 0)
            notifications = int(notifications or 0)
            resolved = int(resolved or 0)
            per_day = notifications / days if days else 0

            # A rate needs enough samples to mean anything. Below the floor it
            # is reported as None and the UI shows NA rather than a confident
            # percentage derived from two alerts.
            resolution_rate = (round(resolved / alerts * 100, 1)
                               if alerts >= MIN_SAMPLES_FOR_RATE else None)

            reasons = []
            if per_day > NOISY_NOTIFICATIONS_PER_DAY:
                reasons.append(
                    f"{notifications} notification(s) in {days} day(s) — about "
                    f"{per_day:.1f} a day.")
            if suppressed_rows.get(rid, 0) > notifications and notifications:
                reasons.append(
                    f"The cooldown suppressed {suppressed_rows[rid]} further "
                    "notification(s), more than it let through. The condition "
                    "is firing far more often than the threshold intends.")
            if resolution_rate is not None and resolution_rate < 20 and alerts > 10:
                reasons.append(
                    f"Only {resolution_rate}% of its alerts have resolved, so it "
                    "may be measuring a steady state rather than an incident.")

            out.append({
                "rule_id": str(rid),
                "rule_name": names.get(rid, "Rule deleted"),
                "alerts": alerts,
                "occurrences": int(occurrences or 0),
                "notifications": notifications,
                "notifications_per_day": round(per_day, 2),
                "suppressed": int(suppressed_rows.get(rid, 0)),
                "resolved": resolved,
                "active": int(active or 0),
                "resolution_rate_pct": resolution_rate,
                "resolution_rate_note": (
                    None if resolution_rate is not None
                    else f"Fewer than {MIN_SAMPLES_FOR_RATE} alerts — too few to "
                         "express as a rate."),
                "noisy": bool(reasons),
                "reasons": reasons,
            })

        out.sort(key=lambda r: (-r["notifications"], -r["alerts"]))
        return {
            "window_days": days,
            "rules": out,
            "noisy_count": sum(1 for r in out if r["noisy"]),
            "threshold_note": (
                f"A rule is flagged above roughly {NOISY_NOTIFICATIONS_PER_DAY} "
                "notifications a day, or when the cooldown is suppressing more "
                "mail than it delivers. That bar is a default, not a rule — what "
                "counts as noisy depends on who reads the mail. Nothing here is "
                "changed automatically."),
        }
