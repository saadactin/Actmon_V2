"""Configuration-drift queries and cross-pillar correlation.

The change log itself (written during discovery) answers "what changed". This
service answers the two questions that make it actionable:

*   *Which pillar does it land on* - every change carries the pillars its field
    belongs to, so security-affecting drift can be read separately from a
    capacity change that only moves the bill.
*   *What else is true about that resource right now* - open alerts, current
    status, and monthly cost on file. This is the correlation: the change log
    supplies the "when and what", the live inventory and alert tables supply
    the "and here is the state it left behind".

Nothing here estimates money. A capacity change reports its direction
(SCALE_UP / SCALE_DOWN), which is provable from the two values; turning that
into a rupee figure would need per-SKU rate cards this service does not have,
and a made-up number is worse than an honest direction.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.alert import STATE_OPEN, STATE_ACKNOWLEDGED, CloudAlert
from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.repository.drift_repo import DriftRepository
from app.utils.drift_rules import (
    ALL_PILLARS,
    CHANGE_CREATED,
    CHANGE_DELETED,
    CHANGE_MODIFIED,
    DIR_MORE_OPEN,
    DIR_SCALE_UP,
)

CHANGE_TYPES = (CHANGE_CREATED, CHANGE_MODIFIED, CHANGE_DELETED)
SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW")

# Alert states that mean "still a live problem" — matches the Alerts tab, where
# acknowledging does not make a finding disappear.
ACTIVE_ALERT_STATES = (STATE_OPEN, STATE_ACKNOWLEDGED)


class DriftService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = DriftRepository(db)

    # -- helpers --------------------------------------------------------------

    async def _account_names(self) -> Dict[uuid.UUID, Dict[str, str]]:
        rows = (
            await self.db.execute(
                select(CloudAccount.id, CloudAccount.account_name, CloudAccount.provider)
            )
        ).all()
        return {r[0]: {"account_name": r[1], "provider": r[2]} for r in rows}

    @staticmethod
    def _parse_account(account_id: Optional[str]) -> Optional[uuid.UUID]:
        if not account_id:
            return None
        try:
            return uuid.UUID(account_id)
        except (ValueError, TypeError):
            return None

    # -- list -----------------------------------------------------------------

    async def list_changes(
        self,
        *,
        account_id: Optional[str] = None,
        days: int = 30,
        change_type: Optional[str] = None,
        impact: Optional[str] = None,
        severity: Optional[str] = None,
        resource_type: Optional[str] = None,
        provider_resource_id: Optional[str] = None,
        direction: Optional[str] = None,
        search: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        filters = dict(
            account_id=self._parse_account(account_id),
            days=days,
            change_type=change_type,
            impact=impact,
            severity=severity,
            resource_type=resource_type,
            provider_resource_id=provider_resource_id,
            direction=direction,
            search=search,
        )
        total = await self.repo.count(**filters)
        rows = await self.repo.list(page=page, page_size=page_size, **filters)
        accounts = await self._account_names()

        items = []
        for row in rows:
            item = row.to_dict()
            meta = accounts.get(row.account_id) or {}
            item["account_name"] = meta.get("account_name")
            item["provider"] = meta.get("provider")
            items.append(item)

        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "window_days": days,
        }

    # -- summary --------------------------------------------------------------

    async def summary(
        self, *, account_id: Optional[str] = None, days: int = 30
    ) -> Dict[str, Any]:
        acct = self._parse_account(account_id)
        filters = dict(account_id=acct, days=days)

        from app.models.drift import CloudResourceChange as C

        total = await self.repo.count(**filters)
        by_type_rows = dict(await self.repo.counts_by(C.change_type, **filters))
        by_sev_rows = dict(await self.repo.counts_by(C.severity, **filters))
        by_impact = await self.repo.counts_by_impact(**filters)
        by_resource_type = [
            {"resource_type": v, "count": n}
            for v, n in await self.repo.counts_by(C.resource_type, limit=12, **filters)
        ]
        by_day = await self.repo.counts_by_day(**filters)
        top_resources = await self.repo.top_resources(limit=8, **filters)

        # The two transitions worth surfacing on their own: something became
        # internet-reachable, and something grew. Both are provable from the
        # values themselves rather than inferred.
        newly_exposed = await self.repo.count(direction=DIR_MORE_OPEN, **filters)
        scaled_up = await self.repo.count(direction=DIR_SCALE_UP, **filters)

        # Whether this account has ANY history at all, so the UI can tell
        # "nothing changed" apart from "no baseline yet, come back after the
        # next scan" — two very different messages.
        has_history = (
            await self.repo.account_has_history(acct) if acct else total > 0
        )

        return {
            "window_days": days,
            "total_changes": total,
            "has_history": has_history,
            "by_change_type": {t: int(by_type_rows.get(t, 0)) for t in CHANGE_TYPES},
            "by_severity": {s: int(by_sev_rows.get(s, 0)) for s in SEVERITIES},
            "by_impact": {p: int(by_impact.get(p, 0)) for p in ALL_PILLARS},
            "by_resource_type": by_resource_type,
            "by_day": by_day,
            "top_resources": top_resources,
            "newly_exposed": newly_exposed,
            "scaled_up": scaled_up,
            "correlation": await self._correlation(acct, days),
        }

    async def _correlation(self, account_id: Optional[uuid.UUID], days: int) -> Dict[str, Any]:
        """How this window's drift lines up with the other pillars.

        Deliberately a small number of joins on data we already store, not a
        re-run of the security/cost engines: the point is to say "these N
        resources both changed and have an open finding", which is exactly the
        list worth looking at first.
        """
        from app.models.drift import CloudResourceChange as C

        since = datetime.now(timezone.utc) - timedelta(days=days)

        changed_q = select(C.resource_id).where(
            C.detected_at >= since, C.resource_id.isnot(None)
        )
        if account_id:
            changed_q = changed_q.where(C.account_id == account_id)
        changed_ids = {r[0] for r in (await self.db.execute(changed_q.distinct())).all()}

        if not changed_ids:
            return {
                "changed_resources": 0,
                "with_active_alerts": 0,
                "alerted_resources": [],
            }

        alert_q = (
            select(
                CloudAlert.resource_id,
                func.count().label("n"),
                func.max(CloudAlert.resource_name).label("resource_name"),
                func.max(CloudAlert.resource_type).label("resource_type"),
                func.max(CloudAlert.severity).label("severity"),
            )
            .where(
                CloudAlert.resource_id.in_(changed_ids),
                CloudAlert.state.in_(ACTIVE_ALERT_STATES),
            )
            .group_by(CloudAlert.resource_id)
            .order_by(func.count().desc())
            .limit(10)
        )
        if account_id:
            alert_q = alert_q.where(CloudAlert.account_id == account_id)
        alert_rows = (await self.db.execute(alert_q)).all()

        return {
            "changed_resources": len(changed_ids),
            "with_active_alerts": len(alert_rows),
            "alerted_resources": [
                {
                    "resource_id": str(r[0]),
                    "alert_count": int(r[1]),
                    "resource_name": r[2],
                    "resource_type": r[3],
                    "severity": r[4],
                }
                for r in alert_rows
            ],
        }

    # -- one resource ---------------------------------------------------------

    async def resource_timeline(
        self, resource_id: str, *, limit: int = 200
    ) -> Optional[Dict[str, Any]]:
        """Everything that ever changed on one resource, plus its state now.

        Keyed through the resource's provider id rather than our row id, so the
        history survives the row being pruned and re-created by later scans -
        which is the whole point of a timeline.
        """
        try:
            rid = uuid.UUID(resource_id)
        except (ValueError, TypeError):
            return None

        resource = await self.db.get(CloudResource, rid)
        if resource is None:
            return None

        rows = await self.repo.timeline_for_resource(
            resource.provider_resource_id, limit=limit
        )

        alerts = (
            await self.db.execute(
                select(CloudAlert)
                .where(
                    CloudAlert.resource_id == rid,
                    CloudAlert.state.in_(ACTIVE_ALERT_STATES),
                )
                .order_by(CloudAlert.created_at.desc())
                .limit(20)
            )
        ).scalars().all()

        accounts = await self._account_names()
        meta = accounts.get(resource.account_id) or {}

        return {
            "resource": {
                "id": str(resource.id),
                "provider_resource_id": resource.provider_resource_id,
                "resource_name": resource.resource_name,
                "resource_type": resource.resource_type,
                "region_or_zone": resource.region_or_zone,
                "status": resource.status,
                "cost_monthly": resource.cost_monthly,
                "account_id": str(resource.account_id),
                "account_name": meta.get("account_name"),
                "provider": meta.get("provider"),
                "updated_at": resource.updated_at.isoformat() if resource.updated_at else None,
            },
            "changes": [r.to_dict() for r in rows],
            "active_alerts": [a.to_dict() for a in alerts],
        }

    # -- inventory history ----------------------------------------------------

    # Keys each provider uses for its OWN creation timestamp, in preference
    # order. These are authoritative in a way discovered_at is not: they say
    # when the resource came into existence in the cloud, not when this system
    # first happened to look. Verified present on 476/476 OCI and 109/223 AWS
    # resources on file; Azure Resource Graph returns none at all, which the
    # response reports rather than papers over.
    _CREATED_KEYS = (
        "time_created",     # OCI
        "created_date",     # AWS IAM
        "creation_date",    # AWS S3
        "create_date",      # AWS (misc)
        "created_at",
    )

    @staticmethod
    def _parse_timestamp(value: Any) -> Optional[datetime]:
        """Tolerant ISO-ish parse. Returns None rather than raising.

        Done in Python, not as a SQL ::timestamptz cast, because one malformed
        string among thousands would abort the whole query — and provider
        payloads are not ours to trust that far.
        """
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        text = str(value).strip()
        if not text:
            return None
        # Stored forms vary: 'T' or ' ' separator, optional microseconds,
        # '+00:00' or 'Z' suffix.
        text = text.replace(" ", "T", 1) if "T" not in text else text
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    @classmethod
    def _created_at_of(cls, metadata: Any) -> tuple[Optional[datetime], Optional[str]]:
        """(provider-reported creation time, which key it came from)."""
        if not isinstance(metadata, dict):
            return None, None
        for key in cls._CREATED_KEYS:
            if metadata.get(key):
                parsed = cls._parse_timestamp(metadata[key])
                if parsed:
                    return parsed, key
        return None, None

    async def inventory_history(
        self,
        *,
        account_id: Optional[str] = None,
        resource_type: Optional[str] = None,
        search: Optional[str] = None,
        sort: str = "created",
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        """When each resource came into existence, and when we first saw it.

        This exists because the change log can only ever start from the day
        drift capture was switched on — every earlier value was overwritten by
        the scan that followed it and is simply gone. But two facts about the
        past ARE still on file, and together they answer most of "what changed
        and when" for resources that were created rather than modified:

          created_at   the provider's own timestamp. Authoritative, and it
                       reaches back years. Not available for every provider.
          first_seen   discovered_at — when this system first recorded the row.
                       Always present, but it moves when scanner coverage
                       improves, so a cluster of identical first_seen dates
                       usually means "we started looking here", not "these were
                       all built that day". Reported as its own field, never
                       merged into created_at.
        """
        acct = self._parse_account(account_id)

        stmt = select(CloudResource)
        if acct:
            stmt = stmt.where(CloudResource.account_id == acct)
        if resource_type:
            stmt = stmt.where(CloudResource.resource_type == resource_type)
        resources = list((await self.db.execute(stmt)).scalars().all())

        accounts = await self._account_names()
        needle = (search or "").strip().lower()

        rows: List[Dict[str, Any]] = []
        with_ts = 0
        for res in resources:
            created, source_key = self._created_at_of(res.metadata_)
            if created:
                with_ts += 1
            if needle and needle not in (
                f"{res.resource_name or ''} {res.provider_resource_id or ''} "
                f"{res.resource_type or ''}"
            ).lower():
                continue
            meta = accounts.get(res.account_id) or {}
            rows.append({
                "resource_id": str(res.id),
                "provider_resource_id": res.provider_resource_id,
                "resource_name": res.resource_name,
                "resource_type": res.resource_type,
                "region_or_zone": res.region_or_zone,
                "status": res.status,
                "cost_monthly": res.cost_monthly,
                "account_name": meta.get("account_name"),
                "provider": meta.get("provider"),
                "created_at": created.isoformat() if created else None,
                "created_at_source": source_key,
                "first_seen": res.discovered_at.isoformat() if res.discovered_at else None,
            })

        # Newest first, and rows with no provider timestamp sort last rather
        # than being dropped — they are still real resources.
        far_past = datetime(1970, 1, 1, tzinfo=timezone.utc)
        key = "created_at" if sort != "first_seen" else "first_seen"
        rows.sort(
            key=lambda r: self._parse_timestamp(r[key]) or far_past, reverse=True
        )

        # Month buckets for both dates, so "when were things built" and "when
        # did we start seeing them" can be compared side by side.
        by_month: Dict[str, Dict[str, int]] = {}
        for r in rows:
            for field, label in (("created_at", "created"), ("first_seen", "first_seen")):
                parsed = self._parse_timestamp(r[field])
                if not parsed:
                    continue
                bucket = by_month.setdefault(
                    parsed.strftime("%Y-%m"), {"created": 0, "first_seen": 0}
                )
                bucket[label] += 1

        total = len(rows)
        start = max(0, (page - 1) * page_size)
        return {
            "items": rows[start:start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "sort": key,
            # So the UI can say plainly that a provider reports no creation
            # times, instead of showing a column of blanks with no explanation.
            "coverage": {
                "with_provider_timestamp": with_ts,
                "without_provider_timestamp": len(resources) - with_ts,
                "total_resources": len(resources),
            },
            "by_month": [
                {"month": m, **counts} for m, counts in sorted(by_month.items())
            ],
        }

    async def facets(
        self, *, account_id: Optional[str] = None, days: int = 30
    ) -> Dict[str, Any]:
        """Filter options derived from what is actually in the log, so the UI
        never offers a resource type with nothing behind it."""
        return {
            "resource_types": await self.repo.distinct_resource_types(
                account_id=self._parse_account(account_id), days=days
            ),
            "impacts": list(ALL_PILLARS),
            "change_types": list(CHANGE_TYPES),
            "severities": list(SEVERITIES),
        }
