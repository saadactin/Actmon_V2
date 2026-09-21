"""Persistence for alert rules, their activity log, and account recipients.

Two things this repository deliberately does not offer:

*   **No hard delete of a rule.** `soft_delete` stamps `deleted_at`. Alert
    history outlives its rule, and a DELETE would either orphan or cascade away
    what the rule already told people — both of which make "why did I get this
    email in March" unanswerable.

*   **No update or delete of an activity row.** `cloud_alert_events` is
    append-only by construction: `record()` inserts, and nothing else touches
    it. An audit trail with an edit path is a log, not an audit trail.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert_rule import (
    CloudAlertEvent, CloudAlertRecipient, CloudAlertRule,
)


class AlertRuleRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Rules ────────────────────────────────────────────────────────────────
    async def get(self, rule_id: uuid.UUID,
                  *, include_deleted: bool = False) -> Optional[CloudAlertRule]:
        rule = await self.db.get(CloudAlertRule, rule_id)
        if rule is None:
            return None
        if rule.deleted_at is not None and not include_deleted:
            return None
        return rule

    async def list_for_account(
        self, account_id: uuid.UUID, *,
        category: Optional[str] = None,
        enabled: Optional[bool] = None,
        severity: Optional[str] = None,
        condition_type: Optional[str] = None,
        search: Optional[str] = None,
        include_deleted: bool = False,
    ) -> List[CloudAlertRule]:
        stmt = select(CloudAlertRule).where(CloudAlertRule.account_id == account_id)
        if not include_deleted:
            stmt = stmt.where(CloudAlertRule.deleted_at.is_(None))
        if category:
            stmt = stmt.where(CloudAlertRule.category == category)
        if enabled is not None:
            stmt = stmt.where(CloudAlertRule.enabled.is_(enabled))
        if severity:
            stmt = stmt.where(CloudAlertRule.severity == severity.upper())
        if condition_type:
            stmt = stmt.where(CloudAlertRule.condition_type == condition_type)
        if search and search.strip():
            # Name and description only. The generated condition sentence is
            # assembled in Python and has no column to match against, so
            # pretending to search it would silently miss rules.
            like = f"%{search.strip().lower()}%"
            stmt = stmt.where(or_(
                func.lower(CloudAlertRule.name).like(like),
                func.lower(func.coalesce(CloudAlertRule.description, "")).like(like),
            ))
        stmt = stmt.order_by(CloudAlertRule.created_at.desc())
        return list((await self.db.execute(stmt)).scalars().all())

    async def rule_facets(self, account_id: uuid.UUID) -> Dict[str, Any]:
        """Counts per filter dimension, so the UI can offer only what exists.

        Deliberately NOT filtered by the current selection: a filter row that
        hides every other option once you pick one tells you nothing about what
        picking something else would give you.
        """
        live = [CloudAlertRule.account_id == account_id,
                CloudAlertRule.deleted_at.is_(None)]

        async def counts(column):
            rows = (await self.db.execute(
                select(column, func.count()).where(and_(*live)).group_by(column)
            )).all()
            return [{"value": v, "count": int(n)} for v, n in rows if v]

        return {
            "categories": await counts(CloudAlertRule.category),
            "severities": await counts(CloudAlertRule.severity),
            "condition_types": await counts(CloudAlertRule.condition_type),
        }

    async def name_taken(self, account_id: uuid.UUID, name: str,
                         *, exclude: Optional[uuid.UUID] = None) -> bool:
        stmt = select(func.count()).select_from(CloudAlertRule).where(
            CloudAlertRule.account_id == account_id,
            func.lower(CloudAlertRule.name) == name.strip().lower(),
            CloudAlertRule.deleted_at.is_(None),
        )
        if exclude is not None:
            stmt = stmt.where(CloudAlertRule.id != exclude)
        return bool((await self.db.execute(stmt)).scalar_one())

    async def add(self, rule: CloudAlertRule) -> CloudAlertRule:
        self.db.add(rule)
        await self.db.flush()
        await self.db.refresh(rule)
        return rule

    async def soft_delete(self, rule: CloudAlertRule, actor: Optional[str]) -> None:
        rule.deleted_at = datetime.now(timezone.utc)
        rule.deleted_by = actor
        # A deleted rule must also stop being evaluated. Relying on the
        # deleted_at filter alone would leave `enabled` true, and any future
        # query that forgets the filter would quietly resume evaluating it.
        rule.enabled = False
        await self.db.flush()

    async def due_rules(self, *, limit: int = 200,
                        now: Optional[datetime] = None) -> List[CloudAlertRule]:
        """Enabled, undeleted rules whose interval has elapsed.

        The interval is compared in SQL against each rule's OWN interval rather
        than a global tick, so a 5-minute rule and an hourly rule genuinely run
        at their own cadence instead of all of them running whenever the loop
        wakes.
        """
        now = now or datetime.now(timezone.utc)
        stmt = (
            select(CloudAlertRule)
            .where(
                CloudAlertRule.enabled.is_(True),
                CloudAlertRule.deleted_at.is_(None),
                or_(
                    CloudAlertRule.last_evaluated_at.is_(None),
                    CloudAlertRule.last_evaluated_at
                    <= now - func.make_interval(
                        0, 0, 0, 0, 0, 0,
                        CloudAlertRule.evaluation_interval_seconds,
                    ),
                ),
            )
            # Never-evaluated rules first, then the longest-overdue. A new rule
            # that reports nothing for its first interval looks broken.
            .order_by(CloudAlertRule.last_evaluated_at.asc().nullsfirst())
            .limit(limit)
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def counts_for_account(self, account_id: uuid.UUID) -> Dict[str, int]:
        total, enabled = (await self.db.execute(
            select(
                func.count(),
                func.count().filter(CloudAlertRule.enabled.is_(True)),
            ).where(
                CloudAlertRule.account_id == account_id,
                CloudAlertRule.deleted_at.is_(None),
            )
        )).one()
        return {"total": int(total or 0), "enabled": int(enabled or 0),
                "disabled": int((total or 0) - (enabled or 0))}

    # ── Activity ─────────────────────────────────────────────────────────────
    async def record(
        self, *, action: str, summary: str,
        account_id: Optional[uuid.UUID] = None,
        rule: Optional[CloudAlertRule] = None,
        rule_id: Optional[uuid.UUID] = None,
        rule_name: Optional[str] = None,
        alert_id: Optional[uuid.UUID] = None,
        severity: Optional[str] = None,
        actor: Optional[str] = None,
        actor_role: Optional[str] = None,
        detail: Optional[dict] = None,
    ) -> CloudAlertEvent:
        """Append one activity row. Insert only — there is no update path."""
        event = CloudAlertEvent(
            account_id=account_id or (rule.account_id if rule else None),
            rule_id=rule_id or (rule.id if rule else None),
            rule_name=rule_name or (rule.name if rule else None),
            alert_id=alert_id,
            action=action,
            severity=severity or (rule.severity if rule else None),
            summary=summary,
            actor=actor,
            actor_role=actor_role,
            detail=detail,
        )
        self.db.add(event)
        await self.db.flush()
        return event

    async def activity(
        self, account_id: Optional[uuid.UUID], *,
        rule_id: Optional[uuid.UUID] = None,
        alert_id: Optional[uuid.UUID] = None,
        actions: Optional[Sequence[str]] = None,
        days: int = 30,
        limit: int = 100,
    ) -> List[CloudAlertEvent]:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        clauses = [CloudAlertEvent.at >= since]
        if account_id is not None:
            clauses.append(CloudAlertEvent.account_id == account_id)
        if rule_id is not None:
            clauses.append(CloudAlertEvent.rule_id == rule_id)
        if alert_id is not None:
            clauses.append(CloudAlertEvent.alert_id == alert_id)
        if actions:
            clauses.append(CloudAlertEvent.action.in_(list(actions)))
        stmt = (select(CloudAlertEvent).where(and_(*clauses))
                .order_by(CloudAlertEvent.at.desc()).limit(limit))
        return list((await self.db.execute(stmt)).scalars().all())

    async def activity_counts(self, account_id: uuid.UUID,
                              *, days: int = 7) -> Dict[str, int]:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        rows = (await self.db.execute(
            select(CloudAlertEvent.action, func.count())
            .where(CloudAlertEvent.account_id == account_id,
                   CloudAlertEvent.at >= since)
            .group_by(CloudAlertEvent.action)
        )).all()
        return {action: int(count) for action, count in rows}

    # ── Recipients ───────────────────────────────────────────────────────────
    async def recipients(self, account_id: uuid.UUID,
                         *, enabled_only: bool = False) -> List[CloudAlertRecipient]:
        stmt = select(CloudAlertRecipient).where(
            CloudAlertRecipient.account_id == account_id)
        if enabled_only:
            stmt = stmt.where(CloudAlertRecipient.enabled.is_(True))
        stmt = stmt.order_by(CloudAlertRecipient.kind, CloudAlertRecipient.email)
        return list((await self.db.execute(stmt)).scalars().all())

    async def get_recipient(self, recipient_id: uuid.UUID,
                            account_id: uuid.UUID) -> Optional[CloudAlertRecipient]:
        row = await self.db.get(CloudAlertRecipient, recipient_id)
        # The account check is not belt-and-braces: without it, a recipient id
        # from another account could be toggled or deleted through this
        # account's endpoint.
        if row is None or row.account_id != account_id:
            return None
        return row

    async def add_recipient(self, recipient: CloudAlertRecipient) -> CloudAlertRecipient:
        self.db.add(recipient)
        await self.db.flush()
        await self.db.refresh(recipient)
        return recipient

    async def recipient_exists(self, account_id: uuid.UUID, email: str,
                               kind: str) -> bool:
        found = (await self.db.execute(
            select(CloudAlertRecipient.id).where(
                CloudAlertRecipient.account_id == account_id,
                func.lower(CloudAlertRecipient.email) == email.strip().lower(),
                CloudAlertRecipient.kind == kind,
            ).limit(1)
        )).first()
        return found is not None
