"""Read-side service for the Event Log.

The repository knows how to query; this decides what the API means. In
particular it owns the three things that stop a page of zeroes from being
mistaken for an answer:

*   **Time-range resolution.** Every read is windowed, the window is always
    resolved to explicit UTC bounds, and those bounds are echoed back in the
    response so the client can label what it is showing rather than assume.

*   **Source availability alongside the data.** Every list and stats response
    carries the collection health of the providers it drew from. An empty table
    with `sources.degraded = true` is a different statement from an empty table
    with everything Connected, and the UI must be able to tell them apart —
    this is the same failure the cost cache had, where a swallowed provider
    error was cached as a successful empty result.

*   **Provider vs application retention.** Reported as two separate numbers,
    always. Implying that a 365-day application retention can retrieve a
    120-day-old AWS event would be a lie the UI would repeat.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.adapters import provider_label, provider_retention_days
from app.events.classification import describe_ruleset
from app.events.redaction import redaction_policy
from app.models.cloud_account import CloudAccount
from app.models.cloud_event import (
    ACCESS_METHODS,
    ACTIONS,
    ACTOR_TYPES,
    CATEGORIES,
    CloudEvent,
    EVENT_STATUSES,
    RISK_LEVELS,
    iso_utc,
)
from app.models.event_admin import (
    ACCESS_QUERY_DELETED,
    ACCESS_QUERY_SAVED,
    ACCESS_SETTINGS_CHANGED,
    CloudEventSavedQuery,
    SYNC_CONNECTED,
    SYNC_DELAYED,
    SYNC_NEVER_RUN,
    SYNC_UNHEALTHY,
)
from app.repository.event_repo import (
    FILTERABLE,
    OPERATORS,
    SEARCHABLE,
    SORTABLE,
    EventRepository,
    FilterError,
)

logger = logging.getLogger("cloud_svc.events.service")

# The named ranges the UI offers, in minutes. "Custom" is not here — it is
# expressed as explicit start/end, which is the only unambiguous form.
NAMED_RANGES: Dict[str, int] = {
    "15m": 15,
    "1h": 60,
    "6h": 360,
    "12h": 720,
    "24h": 1440,
    "7d": 10_080,
    "30d": 43_200,
    "90d": 129_600,
    "365d": 525_600,
}

DEFAULT_RANGE = "24h"

# Page sizes the API accepts. A closed list rather than an upper bound, so a
# client cannot ask for 4,999 and get a response that takes a minute to
# serialize.
PAGE_SIZES = (25, 50, 100, 250, 500)

# Rows a single export will stream. Bounded because an unbounded export is a
# way to hold a database connection open indefinitely; the limit and whether it
# was reached are both reported, so a truncated export never looks complete.
EXPORT_MAX_ROWS = 100_000


class EventService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = EventRepository(db)

    # ── Window resolution ────────────────────────────────────────────────────

    @staticmethod
    def resolve_window(
        *,
        range_key: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Tuple[datetime, datetime, str]:
        """(start, end, label) in UTC.

        Explicit start/end wins over a named range, because a caller who sent
        both means the explicit one. A start with no end means "from then until
        now", which is the reading everyone expects and is stated in the label
        rather than left implicit.
        """
        now = datetime.now(timezone.utc)

        if start or end:
            parsed_start = _parse_iso(start) if start else None
            parsed_end = _parse_iso(end) if end else now
            if parsed_start is None:
                # No usable start with an explicit end: fall back to the default
                # width ending at that point, rather than scanning all history.
                parsed_start = parsed_end - timedelta(minutes=NAMED_RANGES[DEFAULT_RANGE])
            if parsed_end < parsed_start:
                parsed_start, parsed_end = parsed_end, parsed_start
            return parsed_start, parsed_end, "custom"

        key = range_key if range_key in NAMED_RANGES else DEFAULT_RANGE
        return now - timedelta(minutes=NAMED_RANGES[key]), now, key

    # ── List ─────────────────────────────────────────────────────────────────

    async def list_events(
        self,
        *,
        account_id: Optional[str] = None,
        range_key: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        provider: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        search: Optional[str] = None,
        min_risk: Optional[str] = None,
        advanced: Optional[Dict[str, Any]] = None,
        exclude_read_only: bool = False,
        sort: str = "newest",
        page: int = 1,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        window_start, window_end, label = self.resolve_window(
            range_key=range_key, start=start, end=end
        )
        parsed_account = _parse_uuid(account_id)

        query = dict(
            account_id=parsed_account,
            start=window_start,
            end=window_end,
            provider=provider,
            simple=filters or {},
            search=search,
            min_risk=min_risk,
            advanced=advanced,
            exclude_read_only=exclude_read_only,
        )

        total = await self.repo.count(**query)
        rows = await self.repo.list(page=page, page_size=page_size, sort=sort, **query)
        accounts = await self._account_map()

        items = []
        for row in rows:
            item = row.to_row()
            meta = accounts.get(row.account_id) or {}
            item["account_name"] = meta.get("account_name")
            items.append(item)

        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": max(1, -(-total // page_size)),
            "sort": sort,
            "window": self._window_block(window_start, window_end, label),
            # Attached to every list response on purpose: a caller must never be
            # able to render an empty table without also holding the evidence
            # that collection is (or is not) working.
            "sources": await self.source_status(parsed_account),
        }

    async def get_event(
        self, event_id: str, *, include_raw: bool = True
    ) -> Optional[Dict[str, Any]]:
        parsed = _parse_uuid(event_id)
        if parsed is None:
            return None
        event = await self.repo.get(parsed)
        if event is None:
            return None
        detail = event.to_detail(include_raw=include_raw)
        accounts = await self._account_map()
        meta = accounts.get(event.account_id) or {}
        detail["account_name"] = meta.get("account_name")
        detail["provider_retention_days"] = provider_retention_days(event.provider)
        if not include_raw:
            detail["raw_event_withheld"] = (
                "The raw provider payload is not included for your role. Every "
                "normalized field above is unaffected."
            )
        return detail

    async def get_raw(self, event_id: str) -> Optional[Dict[str, Any]]:
        parsed = _parse_uuid(event_id)
        if parsed is None:
            return None
        event = await self.repo.get(parsed)
        if event is None:
            return None
        return {
            "id": str(event.id),
            "provider": event.provider,
            "provider_event_id": event.provider_event_id,
            "raw_event": event.raw_event,
            "provider_metadata": event.provider_metadata or {},
            "redacted": event.redacted,
            "redaction_note": (
                "Credential material was replaced with [REDACTED] before this event was "
                "stored, so the payload below is what remains of the provider's original."
                if event.redacted else
                "Nothing in this payload matched the redaction rules, so it is the "
                "provider's original."
            ),
        }

    # ── Stats ────────────────────────────────────────────────────────────────

    async def stats(
        self,
        *,
        account_id: Optional[str] = None,
        range_key: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        provider: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        search: Optional[str] = None,
        min_risk: Optional[str] = None,
        advanced: Optional[Dict[str, Any]] = None,
        exclude_read_only: bool = False,
    ) -> Dict[str, Any]:
        window_start, window_end, label = self.resolve_window(
            range_key=range_key, start=start, end=end
        )
        parsed_account = _parse_uuid(account_id)
        query = dict(
            account_id=parsed_account,
            start=window_start,
            end=window_end,
            provider=provider,
            simple=filters or {},
            search=search,
            min_risk=min_risk,
            advanced=advanced,
            exclude_read_only=exclude_read_only,
        )

        summary = await self.repo.stats(**query)
        by_provider = dict(await self.repo.counts_by(CloudEvent.provider, **query))
        by_category = dict(await self.repo.counts_by(CloudEvent.event_category, **query))
        by_action = dict(await self.repo.counts_by(CloudEvent.action, **query))
        by_risk = dict(await self.repo.counts_by(CloudEvent.risk_level, **query))
        by_status = dict(await self.repo.counts_by(CloudEvent.status, **query))
        by_actor_type = dict(await self.repo.counts_by(CloudEvent.actor_type, **query))
        by_region = await self.repo.counts_by(CloudEvent.region, limit=12, **query)

        summary.update(
            {
                "window": self._window_block(window_start, window_end, label),
                "by_provider": by_provider,
                # Every level present as a key, including zeroes: a chip that
                # vanishes when its count is zero makes the filter look
                # unavailable rather than empty.
                "by_risk": {level: by_risk.get(level, 0) for level in RISK_LEVELS},
                "by_status": {s: by_status.get(s, 0) for s in EVENT_STATUSES},
                "by_category": by_category,
                "by_action": by_action,
                "by_actor_type": by_actor_type,
                "by_region": [{"region": r, "count": c} for r, c in by_region],
                "top_actors": await self.repo.top_actors(limit=8, **query),
                "top_resources": await self.repo.top_resources(limit=8, **query),
                "sources": await self.source_status(parsed_account),
            }
        )
        return summary

    async def timeline(
        self,
        *,
        account_id: Optional[str] = None,
        range_key: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        provider: Optional[str] = None,
        filters: Optional[Dict[str, Any]] = None,
        search: Optional[str] = None,
        min_risk: Optional[str] = None,
        advanced: Optional[Dict[str, Any]] = None,
        exclude_read_only: bool = False,
    ) -> Dict[str, Any]:
        window_start, window_end, label = self.resolve_window(
            range_key=range_key, start=start, end=end
        )
        # The bucket is derived from the window, not requested. A 30-day window
        # in minute buckets is 43,200 points for a chart that can draw a few
        # hundred; picking it here keeps the response size bounded whatever the
        # client asks for.
        span = window_end - window_start
        if span <= timedelta(hours=2):
            bucket = "minute"
        elif span <= timedelta(days=3):
            bucket = "hour"
        elif span <= timedelta(days=90):
            bucket = "day"
        else:
            bucket = "week"

        buckets = await self.repo.timeline(
            bucket=bucket,
            account_id=_parse_uuid(account_id),
            start=window_start,
            end=window_end,
            provider=provider,
            simple=filters or {},
            search=search,
            min_risk=min_risk,
            advanced=advanced,
            exclude_read_only=exclude_read_only,
        )
        return {
            "bucket": bucket,
            "buckets": _pad_buckets(buckets, bucket, window_start, window_end),
            "window": self._window_block(window_start, window_end, label),
        }

    # ── Facets ───────────────────────────────────────────────────────────────

    async def facets(
        self,
        *,
        account_id: Optional[str] = None,
        range_key: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Filter options, split into "what exists here" and "what is possible".

        The distinction matters: a resource-type dropdown built only from the
        vocabulary would offer 40 options that match nothing, and one built
        only from the data would silently drop a category the moment its last
        event ages out of the window. So the present values drive the
        dropdowns and the full vocabulary is available for validation and for
        the advanced builder.
        """
        window_start, window_end, label = self.resolve_window(
            range_key=range_key, start=start, end=end
        )
        query = dict(
            account_id=_parse_uuid(account_id), start=window_start, end=window_end
        )

        return {
            "window": self._window_block(window_start, window_end, label),
            "present": {
                "providers": await self.repo.distinct_values(CloudEvent.provider, **query),
                "regions": await self.repo.distinct_values(CloudEvent.region, **query),
                "resource_types": await self.repo.distinct_values(
                    CloudEvent.resource_type, **query
                ),
                "event_names": await self.repo.distinct_values(
                    CloudEvent.event_name, limit=400, **query
                ),
                "event_sources": await self.repo.distinct_values(
                    CloudEvent.event_source, **query
                ),
                "categories": await self.repo.distinct_values(
                    CloudEvent.event_category, **query
                ),
                "actions": await self.repo.distinct_values(CloudEvent.action, **query),
                "actor_types": await self.repo.distinct_values(
                    CloudEvent.actor_type, **query
                ),
                "actors": await self.repo.distinct_values(
                    CloudEvent.actor_name, limit=400, **query
                ),
                "accounts": await self.repo.distinct_values(
                    CloudEvent.account_ref, **query
                ),
                "subscriptions": await self.repo.distinct_values(
                    CloudEvent.subscription_id, **query
                ),
                "compartments": await self.repo.distinct_values(
                    CloudEvent.compartment_name, **query
                ),
                "resource_groups": await self.repo.distinct_values(
                    CloudEvent.resource_group, **query
                ),
                "access_methods": await self.repo.distinct_values(
                    CloudEvent.access_method, **query
                ),
                "provider_categories": await self.repo.distinct_values(
                    CloudEvent.provider_category, **query
                ),
            },
            "vocabulary": {
                "categories": list(CATEGORIES),
                "actions": list(ACTIONS),
                "statuses": list(EVENT_STATUSES),
                "risk_levels": list(RISK_LEVELS),
                "actor_types": list(ACTOR_TYPES),
                "access_methods": list(ACCESS_METHODS),
            },
            "query_capabilities": {
                "filterable_fields": sorted(FILTERABLE),
                "operators": list(OPERATORS),
                "sort_options": sorted(SORTABLE),
                "page_sizes": list(PAGE_SIZES),
                "named_ranges": sorted(NAMED_RANGES, key=lambda k: NAMED_RANGES[k]),
                # Stated so the search placeholder and the reality cannot drift.
                "searchable_fields": list(SEARCHABLE),
                "search_note": (
                    "Search is a partial, case-insensitive match across the fields listed. "
                    "The raw provider payload is deliberately NOT searched — scanning every "
                    "stored JSON document would read the whole table."
                ),
            },
        }

    # ── Related, and the drift bridge ────────────────────────────────────────

    async def related(self, event_id: str, *, limit: int = 25) -> Optional[Dict[str, Any]]:
        parsed = _parse_uuid(event_id)
        if parsed is None:
            return None
        event = await self.repo.get(parsed)
        if event is None:
            return None

        groups = await self.repo.related(event, limit=limit)
        drift = await self._related_drift(event)

        return {
            "event_id": str(event.id),
            "groups": groups,
            "related_drift": drift,
            "note": (
                "Relationships come only from identifiers the provider itself assigned, "
                "or from the same resource. Time proximity alone is never treated as a "
                "relationship."
            ),
        }

    async def _related_drift(self, event: CloudEvent) -> List[Dict[str, Any]]:
        """Config-drift rows this event could plausibly explain.

        The link is deliberately narrow: the same resource, and a change
        DETECTED AFTER the event but within a bounded window. That direction is
        the only one that can be causal — drift is detected by the scan
        following a change, so a change log entry recorded before the event
        cannot have been caused by it.

        The window is 48 hours because drift granularity is the scan interval,
        and daily scans are normal here. Anything outside it is not claimed.
        """
        if not event.resource_id and not event.resource_name:
            return []

        from app.models.drift import CloudResourceChange

        window_end = event.timestamp + timedelta(hours=48)
        stmt = (
            select(CloudResourceChange)
            .where(
                CloudResourceChange.account_id == event.account_id,
                CloudResourceChange.detected_at >= event.timestamp,
                CloudResourceChange.detected_at <= window_end,
            )
            .order_by(CloudResourceChange.detected_at.asc())
            .limit(25)
        )
        rows = list((await self.db.execute(stmt)).scalars().all())

        matches: List[Dict[str, Any]] = []
        for row in rows:
            how = self._resource_match(event, row.provider_resource_id, row.resource_name)
            if how is None:
                continue
            item = row.to_dict()
            item["match_basis"] = how
            item["match_note"] = (
                "This configuration change was detected after the event, on the same "
                "resource. The event may have caused it — the scan interval is the "
                "granularity, so this is a correlation, not a provider-asserted link."
            )
            matches.append(item)
        return matches

    @staticmethod
    def _resource_match(
        event: CloudEvent, provider_resource_id: Optional[str], resource_name: Optional[str]
    ) -> Optional[str]:
        """How (and how strongly) an event and a drift row name one resource.

        Returned as a label rather than a boolean so the UI can say which link
        it is relying on. An id match is strong; a name match is weak, because
        two resources in different regions can share a name.
        """
        if event.resource_id and provider_resource_id:
            if event.resource_id == provider_resource_id:
                return "resource_id"
            # An ARN/OCID appearing inside the other is a parent/child
            # relationship, which is a real link worth surfacing. Bounded to
            # ids long enough to be unambiguous.
            if len(provider_resource_id) >= 12 and provider_resource_id in event.resource_id:
                return "resource_id_contains"
            if len(event.resource_id) >= 12 and event.resource_id in provider_resource_id:
                return "resource_id_contained"
        if event.resource_name and resource_name and len(resource_name) >= 3:
            if event.resource_name == resource_name:
                return "resource_name"
        return None

    async def events_for_resource(
        self,
        *,
        account_id: Optional[str],
        resource_id: Optional[str] = None,
        resource_name: Optional[str] = None,
        around: Optional[str] = None,
        hours: int = 72,
        limit: int = 100,
    ) -> Dict[str, Any]:
        """The Config Drift → Event Log entry point.

        Called with a drift finding's resource and detection time; returns the
        events that could explain it. The window straddles the detection time
        because drift is detected by the scan AFTER the change, so the change
        itself is in the past relative to the drift row.
        """
        centre = _parse_iso(around) if around else datetime.now(timezone.utc)
        if centre is None:
            centre = datetime.now(timezone.utc)
        window = timedelta(hours=max(1, hours))

        events = await self.repo.for_resource(
            account_id=_parse_uuid(account_id),
            resource_id=resource_id,
            resource_name=resource_name,
            start=centre - window,
            end=centre + timedelta(hours=1),
            limit=limit,
        )

        return {
            "items": [e.to_row() for e in events],
            "total": len(events),
            "matched_on": (
                "resource_id" if resource_id else "resource_name" if resource_name else None
            ),
            "window": self._window_block(centre - window, centre + timedelta(hours=1), "custom"),
            "sources": await self.source_status(_parse_uuid(account_id)),
            "note": (
                "Events are searched from before the drift was detected, because a "
                "configuration change is observed by the scan that follows it. An empty "
                "result with healthy sources means no matching control-plane event was "
                "recorded — a change made outside the audited control plane (in-guest, or "
                "by a provider-internal process) leaves no event."
            ),
        }

    # ── Collection health ────────────────────────────────────────────────────

    async def source_status(
        self, account_id: Optional[uuid.UUID] = None
    ) -> Dict[str, Any]:
        """Per-provider collection health for the accounts in scope.

        Deliberately conservative: a provider is only reported healthy when no
        scope is failing. `degraded` is the single flag the UI reads to decide
        whether to warn above an empty table.
        """
        states = await self.repo.list_sync_states(account_id)
        accounts = await self._account_map()

        # Which providers SHOULD be reporting, from the registered accounts —
        # not from the sync-state rows. A provider whose first collection has
        # never run has no rows at all, and omitting it would make "never
        # collected" indistinguishable from "not configured".
        expected: Dict[str, List[str]] = {}
        for acc_id, meta in accounts.items():
            if account_id and acc_id != account_id:
                continue
            expected.setdefault(provider_label(meta["provider"]), []).append(
                meta["account_name"]
            )

        by_provider: Dict[str, Dict[str, Any]] = {}
        for provider, account_names in expected.items():
            by_provider[provider] = {
                "provider": provider,
                "accounts": account_names,
                "status": SYNC_NEVER_RUN,
                "scopes": 0,
                "scopes_healthy": 0,
                "scopes_failing": 0,
                "events_stored": 0,
                "last_success_at": None,
                "last_attempt_at": None,
                "last_error": None,
                "provider_retention_days": provider_retention_days(provider),
            }

        for state in states:
            entry = by_provider.setdefault(
                state.provider,
                {
                    "provider": state.provider, "accounts": [],
                    "status": SYNC_NEVER_RUN, "scopes": 0, "scopes_healthy": 0,
                    "scopes_failing": 0, "events_stored": 0,
                    "last_success_at": None, "last_attempt_at": None,
                    "last_error": None,
                    "provider_retention_days": provider_retention_days(state.provider),
                },
            )
            entry["scopes"] += 1
            entry["events_stored"] += state.events_stored or 0
            if state.status in SYNC_UNHEALTHY:
                entry["scopes_failing"] += 1
                # Keep the FIRST error seen rather than the last: they are
                # ordered by scope, so the first is stable across reads instead
                # of flapping between compartments.
                if entry["last_error"] is None:
                    entry["last_error"] = state.last_error
                    entry["status"] = state.status
            elif state.status in (SYNC_CONNECTED, SYNC_DELAYED):
                entry["scopes_healthy"] += 1
            entry["last_success_at"] = _max_iso(
                entry["last_success_at"], iso_utc(state.last_success_at)
            )
            entry["last_attempt_at"] = _max_iso(
                entry["last_attempt_at"], iso_utc(state.last_attempt_at)
            )

        for entry in by_provider.values():
            if entry["scopes_failing"] and entry["scopes_healthy"]:
                # Some scopes work and some do not. Neither "Connected" nor
                # "failed" is true, and picking either misleads.
                entry["status"] = "Partial"
            elif entry["scopes_failing"]:
                pass  # already the specific failure status
            elif entry["scopes_healthy"]:
                entry["status"] = SYNC_CONNECTED
            elif entry["scopes"]:
                entry["status"] = SYNC_DELAYED

        degraded = any(
            e["scopes_failing"] > 0 or e["status"] == SYNC_NEVER_RUN
            for e in by_provider.values()
        )

        return {
            "providers": sorted(by_provider.values(), key=lambda e: e["provider"]),
            "degraded": degraded,
            "all_connected": bool(by_provider) and not degraded,
            "note": (
                "An empty event list means one of two very different things. With every "
                "source Connected it means nothing happened in the window. With a "
                "degraded source it means events may be missing."
            ) if degraded else None,
        }

    async def collection_status(
        self, account_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """The detailed ingestion view: per-scope rows plus the metrics."""
        parsed = _parse_uuid(account_id)
        states = await self.repo.list_sync_states(parsed)
        totals = await self.repo.sync_totals(parsed)
        settings = await self.repo.get_settings()

        return {
            "providers": totals,
            "scopes": [s.to_dict() for s in states],
            "settings": settings.to_dict(),
            "retention": {
                "application_days": settings.retention_days,
                "provider_days": {
                    provider: provider_retention_days(provider)
                    for provider in ("AWS", "Azure", "OCI")
                },
                "note": (
                    "Application retention is how long this system keeps events. Provider "
                    "retention is how far back the provider will serve them at all, and is "
                    "a hard ceiling: raising the application figure above it cannot "
                    "retrieve older events."
                ),
            },
            "metrics": {
                "events_received": sum(t["events_received"] for t in totals),
                "events_stored": sum(t["events_stored"] for t in totals),
                "events_duplicate": sum(t["events_duplicate"] for t in totals),
                "events_failed": sum(t["events_failed"] for t in totals),
                "api_calls": sum(t["api_calls"] for t in totals),
                "api_errors": sum(t["api_errors"] for t in totals),
                "rate_limit_hits": sum(t["rate_limit_hits"] for t in totals),
                "max_ingestion_latency_s": max(
                    [t["max_ingestion_latency_s"] or 0 for t in totals] or [0]
                ) or None,
            },
        }

    # ── Settings ─────────────────────────────────────────────────────────────

    async def get_settings(self) -> Dict[str, Any]:
        settings = await self.repo.get_settings()
        payload = settings.to_dict()
        payload["provider_retention_days"] = {
            provider: provider_retention_days(provider)
            for provider in ("AWS", "Azure", "OCI")
        }
        payload["retention_options"] = [7, 30, 90, 180, 365]
        payload["redaction"] = redaction_policy()
        return payload

    async def update_settings(
        self, changes: Dict[str, Any], *, actor: Optional[str], role: Optional[str],
        source_ip: Optional[str] = None,
    ) -> Dict[str, Any]:
        settings = await self.repo.get_settings()
        before = settings.to_dict()

        allowed = {
            "retention_days", "collection_enabled", "collection_interval_minutes",
            "initial_lookback_hours", "collect_read_only",
        }
        applied: Dict[str, Any] = {}
        for key, value in changes.items():
            if key not in allowed or value is None:
                continue
            setattr(settings, key, value)
            applied[key] = value

        settings.updated_by = actor
        await self.db.flush()

        # Changing retention or collection policy is a privileged act against
        # the audit system, so it is recorded in the audit-of-the-audit log with
        # both the old and the new value.
        await self.repo.record_access(
            ACCESS_SETTINGS_CHANGED,
            actor=actor, role=role, target="settings",
            detail={"before": before, "changed": applied},
            source_ip=source_ip,
        )
        return await self.get_settings()

    # ── Saved queries ────────────────────────────────────────────────────────

    async def list_saved_queries(self, owner: Optional[str]) -> List[Dict[str, Any]]:
        return [q.to_dict() for q in await self.repo.list_saved_queries(owner)]

    async def save_query(
        self,
        *,
        name: str,
        filters: Dict[str, Any],
        description: Optional[str] = None,
        account_id: Optional[str] = None,
        owner: Optional[str] = None,
        role: Optional[str] = None,
        query_id: Optional[str] = None,
        source_ip: Optional[str] = None,
    ) -> Dict[str, Any]:
        existing = await self.repo.get_saved_query(_parse_uuid(query_id)) if query_id else None
        if existing is None:
            existing = CloudEventSavedQuery(
                name=name[:200], owner=owner, account_id=_parse_uuid(account_id)
            )
            self.db.add(existing)
        else:
            existing.name = name[:200]
            existing.account_id = _parse_uuid(account_id)
        existing.description = description
        existing.filters = filters or {}
        await self.db.flush()

        await self.repo.record_access(
            ACCESS_QUERY_SAVED, actor=owner, role=role, target=existing.name,
            detail={"filters": filters}, source_ip=source_ip,
        )
        return existing.to_dict()

    async def delete_saved_query(
        self, query_id: str, *, owner: Optional[str], role: Optional[str],
        source_ip: Optional[str] = None,
    ) -> bool:
        parsed = _parse_uuid(query_id)
        if parsed is None:
            return False
        query = await self.repo.get_saved_query(parsed)
        if query is None:
            return False
        name = query.name
        removed = await self.repo.delete_saved_query(parsed)
        if removed:
            await self.repo.record_access(
                ACCESS_QUERY_DELETED, actor=owner, role=role, target=name,
                source_ip=source_ip,
            )
        return removed

    # ── Introspection ────────────────────────────────────────────────────────

    async def ruleset(self) -> Dict[str, Any]:
        rules = describe_ruleset()
        rules["note"] = (
            "Risk is decided by these rules, not hardcoded in the query layer. Point the "
            "EVENT_RULES_FILE environment variable at a JSON file to override the base "
            "risk per action, the per-category floor, or to add rules of your own; added "
            "rules are evaluated before the built-ins. Existing stored events keep the "
            "classification they were ingested with — the table is append-only, so "
            "re-classifying history would mean rewriting audit records."
        )
        return rules

    # ── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _window_block(start: datetime, end: datetime, label: str) -> Dict[str, Any]:
        """The window, always as explicit UTC, always labelled.

        Returned with every response so the UI can state which timezone it is
        converting from instead of assuming. Timestamps are stored and
        transported in UTC and converted for display only — mixing the two
        silently is how an audit trail ends up an hour wrong.
        """
        return {
            "start_utc": iso_utc(start),
            "end_utc": iso_utc(end),
            "range": label,
            "duration_minutes": int((end - start).total_seconds() // 60),
            "timezone": "UTC",
        }

    async def _account_map(self) -> Dict[uuid.UUID, Dict[str, str]]:
        rows = (
            await self.db.execute(
                select(CloudAccount.id, CloudAccount.account_name, CloudAccount.provider)
            )
        ).all()
        return {
            r[0]: {"account_name": r[1], "provider": r[2]} for r in rows
        }


# ── Module helpers ────────────────────────────────────────────────────────────


_BUCKET_STEP = {
    "minute": timedelta(minutes=1),
    "hour": timedelta(hours=1),
    "day": timedelta(days=1),
    "week": timedelta(weeks=1),
}


def _pad_buckets(
    buckets: List[Dict[str, Any]], bucket: str, start: datetime, end: datetime
) -> List[Dict[str, Any]]:
    """Fill in the empty slots across the whole window.

    `GROUP BY date_trunc` only returns slots that HAVE events, so a 7-day window
    with activity on two days came back as two buckets. The chart gives every
    bucket equal width, so those two rendered as two half-screen-wide blocks
    under a legend reading "one bar = 1 day" — the shape of the window was
    unreadable and the legend was simply false.

    Padding makes bar width mean elapsed time again, and a quiet day render as
    a gap rather than being silently collapsed away.

    Bounded: a minute-bucketed window is at most a couple of hours by the
    caller's own bucket choice, so the worst case here is a few hundred points.
    """
    step = _BUCKET_STEP.get(bucket)
    if step is None:
        return buckets

    existing = {b["bucket"]: b for b in buckets if b.get("bucket")}

    # Align the first slot to the same boundary Postgres' date_trunc used, or
    # the padded keys would never match the real ones.
    cursor = start.astimezone(timezone.utc).replace(second=0, microsecond=0)
    if bucket in ("hour", "day", "week"):
        cursor = cursor.replace(minute=0)
    if bucket in ("day", "week"):
        cursor = cursor.replace(hour=0)
    if bucket == "week":
        # date_trunc('week') is ISO — Monday.
        cursor -= timedelta(days=cursor.weekday())

    out: List[Dict[str, Any]] = []
    guard = 0
    while cursor <= end and guard < 2000:
        key = cursor.isoformat()
        hit = existing.get(key)
        out.append(hit or {"bucket": key, "total": 0, "high_risk": 0, "failed": 0})
        cursor += step
        guard += 1

    # Anything the database returned that did not line up with a padded slot is
    # kept rather than dropped — a real event must never vanish because of a
    # boundary-alignment disagreement.
    padded_keys = {b["bucket"] for b in out}
    for key, value in existing.items():
        if key not in padded_keys:
            out.append(value)
    out.sort(key=lambda b: b["bucket"])
    return out


def _parse_uuid(value: Optional[str]) -> Optional[uuid.UUID]:
    if not value:
        return None
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _max_iso(current: Optional[str], candidate: Optional[str]) -> Optional[str]:
    if candidate is None:
        return current
    if current is None:
        return candidate
    return max(current, candidate)


__all__ = ["EventService", "EXPORT_MAX_ROWS", "NAMED_RANGES", "PAGE_SIZES", "FilterError"]
