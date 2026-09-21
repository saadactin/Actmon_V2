"""What else was happening around an alert — without claiming it caused it.

This module answers "what should I look at next", and it is careful about the
difference between that and "what caused this". Everything it returns is a
**co-occurrence**: something recorded on the same account, inside a window
around the alert, and where possible touching the same resource. That is
correlation, and the payload says so in the words it uses:

    "Related"                  — same account, same window. A fact.
    "Possible contributing factor" — same resource as well, so the link is
                                 stronger than coincidence.

There is no "Root cause" anywhere in this file, and no scoring that would let
the UI invent one. A configuration change that made a bucket public and a cost
rise on the same day may be cause and effect or may be two unrelated Tuesdays,
and this system does not have the evidence to tell them apart. Presenting a
guess with a confidence percentage would make it look like it does.

The relationships are drawn from the systems that already own each signal —
Config Drift, the Event Log, Security findings, cost facts, and other alerts —
so nothing here is a second source of truth for any of them.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import STATE_PENDING, CloudAlert

logger = logging.getLogger("cloud_svc.alerts.correlation")

# How far either side of an alert to look. Generous, because a cost change
# shows up in billing a day or more after the configuration change that caused
# it, and a window too tight would systematically hide exactly the link that is
# most worth seeing.
WINDOW_BEFORE = timedelta(hours=24)
WINDOW_AFTER = timedelta(hours=6)
MAX_PER_KIND = 5

# The two strengths this module will assert, and nothing stronger.
RELATED = "related"
CONTRIBUTING = "possible_contributing_factor"


class AlertCorrelation:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def for_alert(self, alert: CloudAlert) -> Dict[str, Any]:
        """Everything recorded near this alert, grouped by where it came from."""
        at = alert.created_at
        if at is None:
            return self._empty("This alert has no detection time, so nothing "
                               "can be correlated against it.")
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        start, end = at - WINDOW_BEFORE, at + WINDOW_AFTER
        resource = (alert.resource_name or "").strip() or None

        groups: List[Dict[str, Any]] = []
        for loader in (self._alerts, self._drift, self._events,
                       self._findings, self._cost):
            try:
                group = await loader(alert, start, end, resource)
            except Exception as exc:  # noqa: BLE001 — one source must not break the rest
                logger.warning("Correlation source failed for alert %s: %s",
                               alert.id, exc)
                group = None
            if group and group.get("items"):
                groups.append(group)

        total = sum(len(g["items"]) for g in groups)
        return {
            "alert_id": str(alert.id),
            "window": {"start": start.isoformat(), "end": end.isoformat(),
                       "anchor": at.isoformat()},
            "groups": groups,
            "total": total,
            # Said in the payload, not just in the UI, so an API consumer
            # cannot mistake this for a causal claim either.
            "disclaimer": (
                "These are signals recorded on the same account within the same "
                "window. They are shown so you can investigate together, not as "
                "a statement that any of them caused this alert. Items marked a "
                "possible contributing factor also touch the same resource, "
                "which makes the link stronger than coincidence — but still not "
                "proof."),
            "empty_note": (
                None if total else
                "Nothing else was recorded on this account in the surrounding "
                "window. That is a real answer, not a missing one — though it "
                "only covers the systems that were collecting at the time."),
        }

    def _empty(self, reason: str) -> Dict[str, Any]:
        return {"groups": [], "total": 0, "disclaimer": reason,
                "empty_note": reason}

    # ── Sources ──────────────────────────────────────────────────────────────
    async def _alerts(self, alert, start, end, resource) -> Dict[str, Any]:
        """Other alerts in the window. The most common real correlation: one
        incident that trips several rules at once."""
        rows = (await self.db.execute(
            select(CloudAlert).where(
                CloudAlert.account_id == alert.account_id,
                CloudAlert.id != alert.id,
                CloudAlert.state != STATE_PENDING,
                CloudAlert.created_at >= start,
                CloudAlert.created_at <= end,
            ).order_by(CloudAlert.created_at.desc()).limit(MAX_PER_KIND)
        )).scalars().all()
        return {
            "kind": "alerts",
            "label": "Other alerts in this window",
            "link_tab": "alerts",
            "items": [{
                "id": str(r.id),
                "title": (r.context or {}).get("rule_name") or r.anomaly_type,
                "detail": (r.details or "")[:220],
                "severity": r.severity,
                "at": r.created_at.isoformat() if r.created_at else None,
                "strength": (CONTRIBUTING
                             if resource and r.resource_name == resource
                             else RELATED),
            } for r in rows],
        }

    async def _drift(self, alert, start, end, resource) -> Dict[str, Any]:
        """Configuration changes. The Config Drift log is the owner; this only
        reads it."""
        from app.models.drift import CloudResourceChange as C

        clauses = [C.account_id == alert.account_id,
                   C.detected_at >= start, C.detected_at <= end]
        rows = (await self.db.execute(
            select(C).where(and_(*clauses))
            .order_by(C.detected_at.desc()).limit(MAX_PER_KIND * 2)
        )).scalars().all()

        # Same-resource changes first: those are the ones worth reading.
        def strength(row):
            return (CONTRIBUTING
                    if resource and (row.resource_name or "") == resource
                    else RELATED)

        rows = sorted(rows, key=lambda r: strength(r) != CONTRIBUTING)[:MAX_PER_KIND]
        return {
            "kind": "drift",
            "label": "Configuration changes",
            "link_tab": "drift",
            "items": [{
                "id": str(r.id),
                "title": r.resource_name or r.provider_resource_id,
                "detail": r.summary,
                "severity": r.severity,
                "at": r.detected_at.isoformat() if r.detected_at else None,
                "strength": strength(r),
            } for r in rows],
        }

    async def _events(self, alert, start, end, resource) -> Dict[str, Any]:
        """Control-plane activity from the provider's own audit trail — who did
        something, from where, and what the provider answered."""
        from app.models.cloud_event import CloudEvent as E

        rows = (await self.db.execute(
            select(E).where(
                E.account_id == alert.account_id,
                E.timestamp >= start, E.timestamp <= end,
                # Read-only calls dwarf everything else in volume and explain
                # nothing; a correlation list full of DescribeInstances is a
                # correlation list nobody reads.
                or_(E.read_only.is_(False), E.read_only.is_(None)),
            ).order_by(E.timestamp.desc()).limit(MAX_PER_KIND * 2)
        )).scalars().all()

        def strength(row):
            return (CONTRIBUTING
                    if resource and (row.resource_name or "") == resource
                    else RELATED)

        rows = sorted(rows, key=lambda r: strength(r) != CONTRIBUTING)[:MAX_PER_KIND]
        return {
            "kind": "events",
            "label": "Cloud activity",
            "link_tab": "events",
            "items": [{
                "id": str(r.id),
                "title": r.event_name,
                "detail": (f"{r.actor_name or r.actor_id or 'Unknown actor'} · "
                           f"{r.status}"
                           + (f" · {r.resource_name}" if r.resource_name else "")),
                "severity": r.risk_level,
                "at": r.timestamp.isoformat() if r.timestamp else None,
                "strength": strength(r),
            } for r in rows],
        }

    async def _findings(self, alert, start, end, resource) -> Dict[str, Any]:
        """Security findings first detected in the window. This is the
        cost↔security bridge: a finding that made something public, beside a
        cost alert, is the pairing worth showing — as a pairing, not a cause."""
        from app.models.security_finding import CloudSecurityFinding as F

        rows = (await self.db.execute(
            select(F).where(
                F.account_id == alert.account_id,
                F.first_detected_at >= start, F.first_detected_at <= end,
                F.verdict == "VULNERABLE",
            ).order_by(F.first_detected_at.desc()).limit(MAX_PER_KIND)
        )).scalars().all()
        return {
            "kind": "security",
            "label": "Security findings first seen in this window",
            "link_tab": "security",
            "items": [{
                "id": str(r.id),
                "title": r.title,
                "detail": (r.resource_name or r.resource_key or "")[:220],
                "severity": r.severity,
                "at": (r.first_detected_at.isoformat()
                       if r.first_detected_at else None),
                "strength": (CONTRIBUTING
                             if resource and r.resource_name == resource
                             else RELATED),
            } for r in rows],
        }

    async def _cost(self, alert, start, end, resource) -> Dict[str, Any]:
        """Whether billed spend moved around the alert.

        Compares the billed days inside the window against the same number of
        days before it, per currency — never across. Reported only when BOTH
        sides have data; a comparison against a window with no billing records
        would present a data gap as a cost movement, which is exactly the
        fabricated correlation this module exists to avoid.
        """
        from app.models.cost_fact import CloudCostFact as CF

        after_start, after_end = start.date(), end.date()
        span_days = max(1, (after_end - after_start).days + 1)
        before_end = after_start - timedelta(days=1)
        before_start = before_end - timedelta(days=span_days - 1)

        async def window(a, b):
            rows = (await self.db.execute(
                select(CF.currency, func.sum(CF.amount),
                       func.count(func.distinct(CF.billing_date)))
                .where(CF.account_id == alert.account_id,
                       CF.billing_date >= a, CF.billing_date <= b)
                .group_by(CF.currency)
            )).all()
            return {c: (float(amt or 0), int(days or 0)) for c, amt, days in rows}

        during, before = await window(after_start, after_end), await window(before_start, before_end)

        items: List[Dict[str, Any]] = []
        for currency, (amount, days) in during.items():
            prior = before.get(currency)
            if not prior or prior[1] == 0 or days == 0:
                # One side has no billed days. Say nothing rather than imply a
                # change that the data cannot support.
                continue
            prior_amount, prior_days = prior
            # Normalized per billed day, so a 7-day window against a 5-day one
            # is not reported as a 40% drop.
            per_day, prior_per_day = amount / days, prior_amount / prior_days
            if prior_per_day <= 0:
                continue
            change = (per_day - prior_per_day) / prior_per_day * 100
            if abs(change) < 10:
                continue
            items.append({
                "id": f"cost-{currency}",
                "title": (f"Daily spend in {currency} "
                          f"{'rose' if change > 0 else 'fell'} "
                          f"{abs(change):.0f}%"),
                "detail": (f"{per_day:,.2f} {currency}/day across "
                           f"{after_start}–{after_end} against "
                           f"{prior_per_day:,.2f} {currency}/day across "
                           f"{before_start}–{before_end}."),
                "severity": "INFO",
                "at": after_end.isoformat(),
                "strength": RELATED,
            })

        return {
            "kind": "cost",
            "label": "Billed spend around this alert",
            "link_tab": "cost",
            "items": items,
        }
