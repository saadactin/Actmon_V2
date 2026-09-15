"""Repository for the cloud audit trail (`cloud_events`) and its side tables.

Everything here is either an append or a read. There is deliberately **no
update path for an event** — not a private one, not a "fix the classification"
one. The only deletion is `prune_older_than`, which announces itself to the
database trigger that otherwise refuses deletes (see app/main.py). If a future
change needs to re-classify stored events, it must write new rows and leave the
originals alone; that is the property that makes this table evidence.

Two performance decisions worth knowing before editing:

*   **Every list query is bounded by a time window.** The window clause comes
    first so Postgres can drive off `ix_cloud_events_account_ts`; a filter
    without one would seq-scan a table designed to hold millions of rows.
*   **Search is a bounded OR over indexed columns**, not a full-text index and
    not a JSONB scan. Searching `raw_event` would mean reading every payload,
    which is the one query that could take the service down. What is searchable
    is stated to the user rather than silently limited.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import Select, String, and_, cast, delete, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.events.adapters import CollectedEvent
from app.models.cloud_event import (
    CloudEvent,
    RISK_LEVELS,
    RISK_ORDER,
    STATUS_DENIED,
    STATUS_FAILED,
)
from app.models.event_admin import (
    CloudEventAccessLog,
    CloudEventSavedQuery,
    CloudEventSettings,
    CloudEventSyncState,
    SYNC_NEVER_RUN,
)

logger = logging.getLogger("cloud_svc.events.repo")


# ── The filterable surface ────────────────────────────────────────────────────
# A whitelist, not `getattr(CloudEvent, field)`. An attribute lookup driven by
# a request parameter would let a caller filter (and therefore probe) any
# column including ones deliberately not exposed, and would raise an
# AttributeError-shaped 500 on a typo instead of a 400 that says what is wrong.
FILTERABLE: Dict[str, Any] = {
    "provider": CloudEvent.provider,
    "event_name": CloudEvent.event_name,
    "event_source": CloudEvent.event_source,
    "api_operation": CloudEvent.api_operation,
    "event_category": CloudEvent.event_category,
    "provider_category": CloudEvent.provider_category,
    "action": CloudEvent.action,
    "status": CloudEvent.status,
    "risk_level": CloudEvent.risk_level,
    "read_only": CloudEvent.read_only,
    "actor_id": CloudEvent.actor_id,
    "actor_name": CloudEvent.actor_name,
    "actor_email": CloudEvent.actor_email,
    "actor_type": CloudEvent.actor_type,
    "actor_role": CloudEvent.actor_role,
    "account_ref": CloudEvent.account_ref,
    "subscription_id": CloudEvent.subscription_id,
    "tenant_id": CloudEvent.tenant_id,
    "tenancy_id": CloudEvent.tenancy_id,
    "compartment_id": CloudEvent.compartment_id,
    "compartment_name": CloudEvent.compartment_name,
    "resource_group": CloudEvent.resource_group,
    "region": CloudEvent.region,
    "resource_id": CloudEvent.resource_id,
    "resource_name": CloudEvent.resource_name,
    "resource_type": CloudEvent.resource_type,
    "source_ip": CloudEvent.source_ip,
    "access_method": CloudEvent.access_method,
    "request_id": CloudEvent.request_id,
    "correlation_id": CloudEvent.correlation_id,
    "error_code": CloudEvent.error_code,
    "timestamp": CloudEvent.timestamp,
    # The provider's own event id. Filterable as well as searchable because
    # "find me event 8f92-..." is how an audit reference from a ticket, an
    # alert or another tool gets resolved, and an exact match on it with an
    # account is index-backed by the dedup unique constraint.
    "provider_event_id": CloudEvent.provider_event_id,
}

# Columns the free-text box searches. Every one is indexed, and the list is
# reported by the /facets endpoint so the placeholder text and the reality
# cannot drift apart.
SEARCHABLE = (
    "actor_name", "actor_email", "actor_id", "event_name", "api_operation",
    "event_source", "resource_id", "resource_name", "resource_type",
    "source_ip", "account_ref", "subscription_id", "tenant_id", "tenancy_id",
    "compartment_id", "compartment_name", "request_id", "correlation_id",
    "region", "error_code",
    # The provider's event id. Pasting one from a ticket, an alert or a
    # colleague's message is the most direct way anyone arrives at a specific
    # audit event, so leaving it unsearchable made the id column decorative.
    "provider_event_id",
)

SORTABLE: Dict[str, Any] = {
    "newest": (CloudEvent.timestamp, "desc"),
    "oldest": (CloudEvent.timestamp, "asc"),
    "risk": (CloudEvent.risk_level, "desc"),
    "actor": (CloudEvent.actor_name, "asc"),
    "resource": (CloudEvent.resource_name, "asc"),
    "provider": (CloudEvent.provider, "asc"),
    "status": (CloudEvent.status, "asc"),
    "event_type": (CloudEvent.event_name, "asc"),
    "category": (CloudEvent.event_category, "asc"),
}

OPERATORS = (
    "eq", "ne", "contains", "not_contains", "starts_with", "ends_with",
    "in", "not_in", "before", "after", "between", "gt", "gte", "lt", "lte",
    "is_null", "is_not_null",
)


class FilterError(ValueError):
    """A malformed advanced filter. Surfaced to the caller as a 400 with the
    reason, never swallowed — a filter that is quietly ignored returns a full
    unfiltered page that looks like a valid answer to the question asked."""


class EventRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Writes: append only ──────────────────────────────────────────────────

    async def insert_events(
        self, account_id: uuid.UUID, events: Sequence[CollectedEvent]
    ) -> Tuple[int, int]:
        """Append events, discarding duplicates. Returns (stored, duplicates).

        `ON CONFLICT DO NOTHING` against the (account_id, provider_event_id)
        unique constraint IS the deduplication. Doing it in the database rather
        than with a pre-flight SELECT matters for two reasons: it is atomic
        against a concurrent collection of the same scope, and it costs one
        round trip for a whole batch instead of one per event.

        Rows are inserted in chunks because Postgres caps a statement at 65535
        bind parameters and these rows have ~50 columns each — a 2,000-event
        batch in one statement would fail on parameter count alone.
        """
        if not events:
            return 0, 0

        stored = 0
        chunk_size = 200
        rows = [self._to_row(account_id, event) for event in events]
        # Two events in ONE batch can carry the same provider id (an overlapping
        # window inside a single run). ON CONFLICT does not protect against a
        # duplicate within the same statement — Postgres raises
        # "ON CONFLICT DO UPDATE command cannot affect row a second time" for
        # DO UPDATE, and for DO NOTHING silently inserts one — so the batch is
        # de-duplicated here first, which also makes the returned counts honest.
        seen: set = set()
        unique_rows = []
        intra_batch_dupes = 0
        for row in rows:
            key = row["provider_event_id"]
            if key in seen:
                intra_batch_dupes += 1
                continue
            seen.add(key)
            unique_rows.append(row)

        for start in range(0, len(unique_rows), chunk_size):
            chunk = unique_rows[start:start + chunk_size]
            stmt = (
                pg_insert(CloudEvent)
                .values(chunk)
                .on_conflict_do_nothing(constraint="uq_cloud_events_provider_id")
                .returning(CloudEvent.id)
            )
            result = await self.db.execute(stmt)
            stored += len(result.fetchall())

        await self.db.flush()
        duplicates = len(events) - stored
        if intra_batch_dupes:
            logger.debug(
                "Dropped %d duplicate event(s) within a single collection batch.",
                intra_batch_dupes,
            )
        return stored, duplicates

    @staticmethod
    def _to_row(account_id: uuid.UUID, event: CollectedEvent) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        latency = None
        if event.timestamp:
            latency = max(0.0, (now - event.timestamp).total_seconds())
        return {
            "id": uuid.uuid4(),
            "account_id": account_id,
            "provider": event.provider,
            "provider_event_id": event.provider_event_id,
            "timestamp": event.timestamp,
            "ingested_at": now,
            "provider_received_at": event.provider_received_at,
            "event_name": event.event_name or "UnknownEvent",
            "event_source": event.event_source,
            "api_operation": event.api_operation,
            "http_method": event.http_method,
            "event_category": event.event_category,
            "action": event.action,
            "status": event.status,
            "risk_level": event.risk_level,
            "risk_reason": event.risk_reason,
            "read_only": event.read_only,
            "provider_category": event.provider_category,
            "actor_id": event.actor_id,
            "actor_name": event.actor_name,
            "actor_email": event.actor_email,
            "actor_type": event.actor_type,
            "actor_role": event.actor_role,
            "actor_auth_method": event.actor_auth_method,
            "actor_chain": event.actor_chain,
            "account_ref": event.account_ref,
            "subscription_id": event.subscription_id,
            "tenant_id": event.tenant_id,
            "tenancy_id": event.tenancy_id,
            "compartment_id": event.compartment_id,
            "compartment_name": event.compartment_name,
            "resource_group": event.resource_group,
            "region": event.region,
            "resource_id": event.resource_id,
            "resource_name": event.resource_name,
            "resource_type": event.resource_type,
            "resources": event.resources,
            "source_ip": event.source_ip,
            "user_agent": event.user_agent,
            "access_method": event.access_method,
            "source_location": event.source_location,
            "request_id": event.request_id,
            "correlation_id": event.correlation_id,
            "session_id": event.session_id,
            "trace_id": event.trace_id,
            "http_status": event.http_status,
            "error_code": event.error_code,
            "error_message": event.error_message,
            "change_before": event.change_before,
            "change_after": event.change_after,
            "changed_fields": event.changed_fields,
            "provider_metadata": event.provider_metadata or None,
            "raw_event": event.raw_event,
            "redacted": event.redacted,
            "ingestion_latency_s": latency,
        }

    async def prune_older_than(self, cutoff: datetime) -> int:
        """The ONLY delete path for events, and it declares itself first.

        `actmon.allow_event_prune` is checked by the append-only trigger; it is
        set with SET LOCAL so it applies to this transaction alone and cannot
        leak to the next request on a pooled connection. Anything else
        attempting a DELETE — a stray script, a mistaken admin endpoint — is
        refused by the database rather than trusted to be well-intentioned.
        """
        await self.db.execute(text("SET LOCAL actmon.allow_event_prune = 'on'"))
        result = await self.db.execute(
            delete(CloudEvent).where(CloudEvent.timestamp < cutoff)
        )
        await self.db.flush()
        return result.rowcount or 0

    # ── Filter construction ──────────────────────────────────────────────────

    def _base_clauses(
        self,
        *,
        account_id: Optional[uuid.UUID] = None,
        account_ids: Optional[Sequence[uuid.UUID]] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        provider: Optional[str] = None,
        simple: Optional[Dict[str, Any]] = None,
        search: Optional[str] = None,
        min_risk: Optional[str] = None,
        advanced: Optional[Dict[str, Any]] = None,
        exclude_read_only: bool = False,
    ) -> List[Any]:
        clauses: List[Any] = []

        # Window first: it is what the composite indexes are built around.
        if start:
            clauses.append(CloudEvent.timestamp >= start)
        if end:
            clauses.append(CloudEvent.timestamp <= end)

        if account_id:
            clauses.append(CloudEvent.account_id == account_id)
        elif account_ids:
            clauses.append(CloudEvent.account_id.in_(list(account_ids)))

        if provider:
            clauses.append(CloudEvent.provider == provider)

        for field, value in (simple or {}).items():
            if value in (None, "", []):
                continue
            column = FILTERABLE.get(field)
            if column is None:
                raise FilterError(f"Unknown filter field {field!r}")
            if isinstance(value, (list, tuple, set)):
                clauses.append(column.in_(list(value)))
            else:
                clauses.append(column == value)

        if min_risk:
            if min_risk not in RISK_ORDER:
                raise FilterError(
                    f"Unknown risk level {min_risk!r}. Expected one of: "
                    f"{', '.join(RISK_LEVELS)}"
                )
            # "risk >= HIGH" as an IN over the levels at or above it. A string
            # comparison would order them alphabetically, which puts CRITICAL
            # below INFO and LOW above HIGH — silently wrong, and exactly the
            # kind of filter bug that hides the events being looked for.
            allowed = [
                level for level in RISK_LEVELS
                if RISK_ORDER[level] >= RISK_ORDER[min_risk]
            ]
            clauses.append(CloudEvent.risk_level.in_(allowed))

        if exclude_read_only:
            # NULL means the provider never said. Those are KEPT: dropping them
            # would silently hide every event from a provider that does not
            # report the flag.
            clauses.append(or_(CloudEvent.read_only.is_(False),
                              CloudEvent.read_only.is_(None)))

        if search:
            clauses.append(self._search_clause(search))

        if advanced:
            clauses.append(self._advanced_clause(advanced))

        return clauses

    @staticmethod
    def _search_clause(term: str):
        """Partial, case-insensitive match across the searchable columns.

        `%` and `_` in the term are escaped: a user pasting a resource path with
        an underscore should match that underscore, not treat it as a
        single-character wildcard. `\\` is escaped first, or escaping the others
        would corrupt a literal backslash.
        """
        cleaned = term.strip().lower()
        cleaned = cleaned.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{cleaned}%"
        return or_(
            *[
                func.lower(FILTERABLE[field]).like(like, escape="\\")
                for field in SEARCHABLE
            ]
        )

    def _advanced_clause(self, node: Dict[str, Any], depth: int = 0):
        """Build a clause from the AND/OR condition tree.

        Shape:

            {"op": "AND", "conditions": [
                {"field": "provider", "operator": "eq", "value": "AWS"},
                {"op": "OR", "conditions": [...]}
            ]}

        Depth-bounded, because the tree comes from a request body and an
        arbitrarily nested one is a cheap way to exhaust the stack.
        """
        if depth > 6:
            raise FilterError("Advanced filter is nested too deeply (limit 6 levels).")
        if not isinstance(node, dict):
            raise FilterError("Each advanced-filter node must be an object.")

        if "conditions" in node:
            op = str(node.get("op", "AND")).upper()
            if op not in ("AND", "OR"):
                raise FilterError(f"Group operator must be AND or OR, got {op!r}")
            conditions = node.get("conditions") or []
            if not isinstance(conditions, list) or not conditions:
                raise FilterError("An advanced-filter group needs at least one condition.")
            built = [self._advanced_clause(child, depth + 1) for child in conditions]
            return and_(*built) if op == "AND" else or_(*built)

        field = node.get("field")
        operator = str(node.get("operator", "eq")).lower()
        value = node.get("value")

        column = FILTERABLE.get(field)
        if column is None:
            raise FilterError(
                f"Unknown filter field {field!r}. Filterable fields: "
                f"{', '.join(sorted(FILTERABLE))}"
            )
        if operator not in OPERATORS:
            raise FilterError(
                f"Unknown operator {operator!r}. Supported: {', '.join(OPERATORS)}"
            )

        return self._condition(field, column, operator, value)

    def _condition(self, field: str, column, operator: str, value: Any):
        if operator == "is_null":
            return column.is_(None)
        if operator == "is_not_null":
            return column.isnot(None)

        if operator in ("in", "not_in"):
            if not isinstance(value, (list, tuple)):
                raise FilterError(f"Operator {operator!r} needs a list value.")
            if not value:
                raise FilterError(f"Operator {operator!r} needs a non-empty list.")
            return column.in_(list(value)) if operator == "in" \
                else column.notin_(list(value))

        if operator == "between":
            if not isinstance(value, (list, tuple)) or len(value) != 2:
                raise FilterError("Operator 'between' needs a two-element [low, high].")
            low, high = value
            if field == "timestamp":
                low, high = _require_time(low, field), _require_time(high, field)
            return and_(column >= low, column <= high)

        if operator in ("before", "lt"):
            return column < (_require_time(value, field) if field == "timestamp" else value)
        if operator in ("after", "gt"):
            return column > (_require_time(value, field) if field == "timestamp" else value)
        if operator == "lte":
            return column <= (_require_time(value, field) if field == "timestamp" else value)
        if operator == "gte":
            # `risk_level` is the one column whose ordering is semantic rather
            # than lexical, so a >= on it becomes a set membership. Without
            # this, "risk >= HIGH" would return INFO and LOW and drop CRITICAL.
            if field == "risk_level":
                if value not in RISK_ORDER:
                    raise FilterError(f"Unknown risk level {value!r}")
                return column.in_([
                    level for level in RISK_LEVELS
                    if RISK_ORDER[level] >= RISK_ORDER[value]
                ])
            return column >= (_require_time(value, field) if field == "timestamp" else value)

        # Text operators. Cast so a non-text column (read_only, timestamp) does
        # not blow up on `lower()`.
        target = func.lower(cast(column, String))
        escaped = str(value).lower().replace("\\", "\\\\") \
            .replace("%", "\\%").replace("_", "\\_")
        if operator == "contains":
            return target.like(f"%{escaped}%", escape="\\")
        if operator == "not_contains":
            return ~target.like(f"%{escaped}%", escape="\\")
        if operator == "starts_with":
            return target.like(f"{escaped}%", escape="\\")
        if operator == "ends_with":
            return target.like(f"%{escaped}", escape="\\")
        if operator == "ne":
            return column != value
        return column == value

    # ── Reads ────────────────────────────────────────────────────────────────

    async def count(self, **filters) -> int:
        clauses = self._base_clauses(**filters)
        stmt = select(func.count()).select_from(CloudEvent)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        return int((await self.db.execute(stmt)).scalar_one())

    async def list(
        self, *, page: int = 1, page_size: int = 50, sort: str = "newest", **filters
    ) -> List[CloudEvent]:
        clauses = self._base_clauses(**filters)
        stmt: Select = select(CloudEvent)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.order_by(*self._order_by(sort))
        stmt = stmt.offset(max(0, (page - 1) * page_size)).limit(page_size)
        return list((await self.db.execute(stmt)).scalars().all())

    @staticmethod
    def _order_by(sort: str) -> List[Any]:
        column, direction = SORTABLE.get(sort, SORTABLE["newest"])
        primary = column.desc() if direction == "desc" else column.asc()

        if sort == "risk":
            # Semantic risk ordering, not alphabetical. A CASE expression puts
            # CRITICAL first; ordering the varchar would put CRITICAL third.
            from sqlalchemy import case

            ranking = case(
                {level: RISK_ORDER[level] for level in RISK_LEVELS},
                value=CloudEvent.risk_level,
                else_=-1,
            )
            primary = ranking.desc()

        # `id` as the final tiebreaker is what makes pagination stable. Without
        # it, two events sharing a timestamp can be ordered differently between
        # two queries, so a row appears on both page 1 and page 2 while another
        # appears on neither — the specification's explicit pagination
        # requirement, and a real defect in any OFFSET pager without it.
        return [primary, CloudEvent.timestamp.desc(), CloudEvent.id.asc()]

    async def get(self, event_id: uuid.UUID) -> Optional[CloudEvent]:
        return (
            await self.db.execute(select(CloudEvent).where(CloudEvent.id == event_id))
        ).scalar_one_or_none()

    async def iter_for_export(
        self, *, sort: str = "newest", batch_size: int = 1000, max_rows: int = 100_000,
        **filters
    ):
        """Yield events in batches for a streamed export.

        Keyset pagination on (timestamp, id) rather than OFFSET: an export of
        100,000 rows through OFFSET re-reads and discards an average of 50,000
        rows per page, so the last page costs a hundred times the first. Keyset
        is a constant-cost index seek per batch — and, unlike OFFSET, it cannot
        skip or repeat a row if events are being inserted while the export
        runs, which they are.
        """
        clauses = self._base_clauses(**filters)
        emitted = 0
        cursor: Optional[Tuple[datetime, uuid.UUID]] = None
        descending = sort != "oldest"

        while emitted < max_rows:
            stmt: Select = select(CloudEvent)
            page_clauses = list(clauses)
            if cursor is not None:
                last_ts, last_id = cursor
                if descending:
                    page_clauses.append(
                        or_(
                            CloudEvent.timestamp < last_ts,
                            and_(CloudEvent.timestamp == last_ts, CloudEvent.id > last_id),
                        )
                    )
                else:
                    page_clauses.append(
                        or_(
                            CloudEvent.timestamp > last_ts,
                            and_(CloudEvent.timestamp == last_ts, CloudEvent.id > last_id),
                        )
                    )
            if page_clauses:
                stmt = stmt.where(and_(*page_clauses))
            order = (
                [CloudEvent.timestamp.desc(), CloudEvent.id.asc()] if descending
                else [CloudEvent.timestamp.asc(), CloudEvent.id.asc()]
            )
            stmt = stmt.order_by(*order).limit(min(batch_size, max_rows - emitted))

            rows = list((await self.db.execute(stmt)).scalars().all())
            if not rows:
                return
            for row in rows:
                yield row
            emitted += len(rows)
            cursor = (rows[-1].timestamp, rows[-1].id)
            if len(rows) < batch_size:
                return

    # ── Aggregates ───────────────────────────────────────────────────────────

    async def stats(self, **filters) -> Dict[str, Any]:
        """The summary cards, in one query.

        Conditional aggregates rather than six separate counts: the window is
        the expensive part of each and running it once instead of six times is
        the difference between a snappy header and a page that stalls.
        """
        clauses = self._base_clauses(**filters)
        stmt = select(
            func.count().label("total"),
            func.count().filter(CloudEvent.status == "Success").label("successful"),
            func.count().filter(CloudEvent.status.in_([STATUS_FAILED, STATUS_DENIED]))
                .label("failed"),
            func.count().filter(CloudEvent.status == STATUS_DENIED).label("denied"),
            # "Administrative changes" — events with POSITIVE evidence that
            # they changed something. Either the provider said so
            # (read_only = false), or the operation name yielded a verb that
            # can only be a write.
            #
            # NOT simply "action != Read". An event whose verb could not be
            # derived at all lands on action = 'Other', and most OCI
            # service-side events also carry read_only = NULL because OCI only
            # reports a request verb for user-initiated calls. Counting those
            # made this figure equal to the total event count on live data —
            # 457 of 457 "administrative changes" — which asserts something
            # about every unclassifiable event that nothing supports.
            # Login/Logout are excluded for the same reason: they are
            # authentication, not configuration change.
            func.count().filter(
                or_(
                    CloudEvent.read_only.is_(False),
                    CloudEvent.action.notin_(["Read", "Login", "Logout", "Other"]),
                )
            ).label("administrative"),
            func.count().filter(CloudEvent.action == "Delete").label("deletes"),
            func.count().filter(CloudEvent.risk_level == "CRITICAL").label("critical"),
            func.count().filter(CloudEvent.risk_level == "HIGH").label("high"),
            func.count(func.distinct(CloudEvent.actor_name)).label("distinct_actors"),
            func.count(func.distinct(CloudEvent.resource_id)).label("distinct_resources"),
            func.min(CloudEvent.timestamp).label("earliest"),
            func.max(CloudEvent.timestamp).label("latest"),
            func.avg(CloudEvent.ingestion_latency_s).label("avg_latency"),
            func.max(CloudEvent.ingestion_latency_s).label("max_latency"),
        ).select_from(CloudEvent)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        row = (await self.db.execute(stmt)).one()

        from app.models.cloud_event import iso_utc

        return {
            "total_events": int(row.total or 0),
            "successful_events": int(row.successful or 0),
            "failed_events": int(row.failed or 0),
            "denied_events": int(row.denied or 0),
            "administrative_changes": int(row.administrative or 0),
            "delete_operations": int(row.deletes or 0),
            "critical_events": int(row.critical or 0),
            "high_risk_events": int(row.high or 0),
            "distinct_actors": int(row.distinct_actors or 0),
            "distinct_resources": int(row.distinct_resources or 0),
            "earliest_event": iso_utc(row.earliest),
            "latest_event": iso_utc(row.latest),
            "avg_ingestion_latency_s": float(row.avg_latency) if row.avg_latency else None,
            "max_ingestion_latency_s": float(row.max_latency) if row.max_latency else None,
        }

    async def counts_by(
        self, column, *, limit: Optional[int] = None, **filters
    ) -> List[Tuple[Any, int]]:
        clauses = self._base_clauses(**filters)
        stmt = select(column, func.count().label("n")).select_from(CloudEvent)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.group_by(column).order_by(func.count().desc())
        if limit:
            stmt = stmt.limit(limit)
        return [(r[0], int(r[1])) for r in (await self.db.execute(stmt)).all()]

    async def timeline(self, *, bucket: str = "hour", **filters) -> List[Dict[str, Any]]:
        """Event counts per time bucket, split by risk.

        The bucket is chosen by the service from the window width, not by the
        caller, so a 30-day window cannot ask for minute buckets and return
        43,200 points to a chart that can draw 200.
        """
        if bucket not in ("minute", "hour", "day", "week"):
            raise FilterError(f"Unsupported timeline bucket {bucket!r}")
        clauses = self._base_clauses(**filters)
        slot = func.date_trunc(bucket, CloudEvent.timestamp).label("slot")
        stmt = select(
            slot,
            func.count().label("total"),
            func.count().filter(CloudEvent.risk_level.in_(["HIGH", "CRITICAL"]))
                .label("high_risk"),
            func.count().filter(CloudEvent.status.in_([STATUS_FAILED, STATUS_DENIED]))
                .label("failed"),
        ).select_from(CloudEvent)
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.group_by(slot).order_by(slot)
        return [
            {
                "bucket": r[0].isoformat() if r[0] else None,
                "total": int(r[1]),
                "high_risk": int(r[2]),
                "failed": int(r[3]),
            }
            for r in (await self.db.execute(stmt)).all()
        ]

    async def top_actors(self, *, limit: int = 10, **filters) -> List[Dict[str, Any]]:
        clauses = self._base_clauses(**filters)
        stmt = select(
            CloudEvent.actor_name,
            func.max(CloudEvent.actor_type).label("actor_type"),
            func.count().label("events"),
            func.count().filter(CloudEvent.risk_level.in_(["HIGH", "CRITICAL"]))
                .label("high_risk"),
            func.count().filter(CloudEvent.status.in_([STATUS_FAILED, STATUS_DENIED]))
                .label("failed"),
            func.max(CloudEvent.timestamp).label("last_seen"),
        ).select_from(CloudEvent).where(CloudEvent.actor_name.isnot(None))
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = (
            stmt.group_by(CloudEvent.actor_name)
            .order_by(func.count().desc())
            .limit(limit)
        )
        from app.models.cloud_event import iso_utc

        return [
            {
                "actor_name": r[0],
                "actor_type": r[1],
                "events": int(r[2]),
                "high_risk": int(r[3]),
                "failed": int(r[4]),
                "last_seen": iso_utc(r[5]),
            }
            for r in (await self.db.execute(stmt)).all()
        ]

    async def top_resources(self, *, limit: int = 10, **filters) -> List[Dict[str, Any]]:
        clauses = self._base_clauses(**filters)
        stmt = select(
            CloudEvent.resource_id,
            func.max(CloudEvent.resource_name).label("resource_name"),
            func.max(CloudEvent.resource_type).label("resource_type"),
            func.count().label("events"),
            func.max(CloudEvent.timestamp).label("last_seen"),
        ).select_from(CloudEvent).where(CloudEvent.resource_id.isnot(None))
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = (
            stmt.group_by(CloudEvent.resource_id)
            .order_by(func.count().desc())
            .limit(limit)
        )
        from app.models.cloud_event import iso_utc

        return [
            {
                "resource_id": r[0],
                "resource_name": r[1],
                "resource_type": r[2],
                "events": int(r[3]),
                "last_seen": iso_utc(r[4]),
            }
            for r in (await self.db.execute(stmt)).all()
        ]

    async def distinct_values(
        self, column, *, limit: int = 300, **filters
    ) -> List[str]:
        """Filter options that are actually present.

        Bounded, because a facet over `resource_name` on a large account is
        unbounded cardinality and would send a 40,000-entry dropdown to the
        browser.
        """
        clauses = self._base_clauses(**filters)
        stmt = select(column).distinct().where(column.isnot(None))
        if clauses:
            stmt = stmt.where(and_(*clauses))
        stmt = stmt.order_by(column).limit(limit)
        return [r[0] for r in (await self.db.execute(stmt)).all() if r[0]]

    # ── Related events ───────────────────────────────────────────────────────

    async def related(
        self, event: CloudEvent, *, limit: int = 25, window_minutes: int = 15
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Events related to this one, grouped by WHY they are related.

        Grouped rather than merged into one list, because the four links have
        very different strengths and presenting them as equally related is the
        false-correlation the specification warns against:

        *   `correlation_id` / `request_id` — the provider's own statement that
            these records belong to one operation. Strong.
        *   same resource — a real relationship, though not necessarily the
            same action. Medium.
        *   same actor in a narrow time window — often the session that did
            this. Weaker, and time-bounded so it stays a session rather than
            "everything this person ever did".
        *   time proximity alone is NOT offered. Two unrelated events a second
            apart are not related, and saying they are would mislead.
        """
        groups: Dict[str, List[Dict[str, Any]]] = {}

        async def fetch(clause, key: str, why: str) -> None:
            stmt = (
                select(CloudEvent)
                .where(and_(CloudEvent.id != event.id, clause))
                .order_by(CloudEvent.timestamp.desc())
                .limit(limit)
            )
            rows = list((await self.db.execute(stmt)).scalars().all())
            if rows:
                groups[key] = {
                    "why": why,
                    "confidence": {
                        "correlation": "high", "request": "high",
                        "resource": "medium", "actor_session": "low",
                    }[key],
                    "events": [r.to_row() for r in rows],
                }

        if event.correlation_id:
            await fetch(
                CloudEvent.correlation_id == event.correlation_id,
                "correlation",
                "The provider assigned these records the same correlation id, so they are "
                "parts of one operation.",
            )
        if event.request_id:
            await fetch(
                and_(CloudEvent.request_id == event.request_id,
                     CloudEvent.account_id == event.account_id),
                "request",
                "Same provider request id — the same API call.",
            )
        if event.resource_id:
            await fetch(
                and_(CloudEvent.resource_id == event.resource_id,
                     CloudEvent.account_id == event.account_id),
                "resource",
                "Other recorded activity against the same resource.",
            )
        if event.actor_name and event.timestamp:
            window = timedelta(minutes=window_minutes)
            await fetch(
                and_(
                    CloudEvent.actor_name == event.actor_name,
                    CloudEvent.account_id == event.account_id,
                    CloudEvent.timestamp >= event.timestamp - window,
                    CloudEvent.timestamp <= event.timestamp + window,
                ),
                "actor_session",
                f"The same principal acted within {window_minutes} minutes either side — "
                f"likely the same working session, but this is a time-proximity link, "
                f"not a provider-asserted one.",
            )

        return groups

    async def for_resource(
        self,
        *,
        account_id: Optional[uuid.UUID],
        resource_id: Optional[str] = None,
        resource_name: Optional[str] = None,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        limit: int = 100,
    ) -> List[CloudEvent]:
        """Events touching one resource — the Config Drift → Event Log link.

        Matches on the resource id when there is one and on the name otherwise,
        because the drift log stores a provider resource id that is an OCID or
        an ARN, and an event's resource id is the same string. Where a drift row
        only has a name, the name match is a weaker link and the caller is told
        which one was used.
        """
        clauses: List[Any] = []
        if account_id:
            clauses.append(CloudEvent.account_id == account_id)
        if start:
            clauses.append(CloudEvent.timestamp >= start)
        if end:
            clauses.append(CloudEvent.timestamp <= end)

        identity: List[Any] = []
        if resource_id:
            identity.append(CloudEvent.resource_id == resource_id)
            # An ARN or OCID often appears as a suffix of a longer id (a child
            # resource, a sub-path), so a containment match catches the event
            # that acted on the parent. Bounded to ids long enough to be
            # unambiguous — a short id would match half the table.
            if len(resource_id) >= 12:
                identity.append(CloudEvent.resource_id.like(f"%{resource_id}%"))
        if resource_name and len(resource_name) >= 3:
            identity.append(CloudEvent.resource_name == resource_name)
        if not identity:
            return []
        clauses.append(or_(*identity))

        stmt = (
            select(CloudEvent)
            .where(and_(*clauses))
            .order_by(CloudEvent.timestamp.desc())
            .limit(limit)
        )
        return list((await self.db.execute(stmt)).scalars().all())

    # ── Sync state ───────────────────────────────────────────────────────────

    async def get_sync_state(
        self, account_id: uuid.UUID, provider: str, scope: str
    ) -> Optional[CloudEventSyncState]:
        return (
            await self.db.execute(
                select(CloudEventSyncState).where(
                    CloudEventSyncState.account_id == account_id,
                    CloudEventSyncState.provider == provider,
                    CloudEventSyncState.scope == scope,
                )
            )
        ).scalar_one_or_none()

    async def upsert_sync_state(
        self, account_id: uuid.UUID, provider: str, scope: str
    ) -> CloudEventSyncState:
        state = await self.get_sync_state(account_id, provider, scope)
        if state:
            return state
        state = CloudEventSyncState(
            account_id=account_id, provider=provider, scope=scope[:512],
            status=SYNC_NEVER_RUN,
        )
        self.db.add(state)
        await self.db.flush()
        return state

    async def list_sync_states(
        self, account_id: Optional[uuid.UUID] = None
    ) -> List[CloudEventSyncState]:
        stmt = select(CloudEventSyncState)
        if account_id:
            stmt = stmt.where(CloudEventSyncState.account_id == account_id)
        stmt = stmt.order_by(
            CloudEventSyncState.provider, CloudEventSyncState.scope
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def stale_scopes(
        self, account_id: uuid.UUID, provider: str, *, limit: int
    ) -> List[str]:
        """Scopes to collect this run, least-recently-attempted first.

        OCI can present hundreds of (region, compartment) scopes and CloudTrail
        nineteen regions. Sweeping all of them every run is what turns a
        15-minute collection interval into a 40-minute one, so each run takes a
        slice and the ordering guarantees every scope comes round. NULLS FIRST
        puts never-attempted scopes at the head, so a newly-added compartment
        is collected on the next run rather than after a full rotation.
        """
        stmt = (
            select(CloudEventSyncState.scope)
            .where(
                CloudEventSyncState.account_id == account_id,
                CloudEventSyncState.provider == provider,
            )
            .order_by(CloudEventSyncState.last_attempt_at.asc().nullsfirst())
            .limit(limit)
        )
        return [r[0] for r in (await self.db.execute(stmt)).all()]

    async def sync_totals(
        self, account_id: Optional[uuid.UUID] = None
    ) -> List[Dict[str, Any]]:
        """Per-provider collection health, rolled up from the scopes.

        The rollup is deliberately pessimistic about health and honest about
        counts: a provider is only "Connected" if no scope is failing, and the
        failing-scope count is reported alongside so "mostly working" is
        visible rather than rounded to either extreme.
        """
        stmt = select(
            CloudEventSyncState.provider,
            func.count().label("scopes"),
            func.sum(CloudEventSyncState.events_stored).label("stored"),
            func.sum(CloudEventSyncState.events_received).label("received"),
            func.sum(CloudEventSyncState.events_duplicate).label("duplicates"),
            func.sum(CloudEventSyncState.events_failed).label("failed"),
            func.sum(CloudEventSyncState.api_calls).label("api_calls"),
            func.sum(CloudEventSyncState.api_errors).label("api_errors"),
            func.sum(CloudEventSyncState.rate_limit_hits).label("rate_limits"),
            func.max(CloudEventSyncState.last_success_at).label("last_success"),
            func.max(CloudEventSyncState.last_attempt_at).label("last_attempt"),
            func.max(CloudEventSyncState.max_latency_s).label("max_latency"),
        ).select_from(CloudEventSyncState).group_by(CloudEventSyncState.provider)
        if account_id:
            stmt = stmt.where(CloudEventSyncState.account_id == account_id)

        from app.models.cloud_event import iso_utc

        return [
            {
                "provider": r[0],
                "scopes": int(r[1] or 0),
                "events_stored": int(r[2] or 0),
                "events_received": int(r[3] or 0),
                "events_duplicate": int(r[4] or 0),
                "events_failed": int(r[5] or 0),
                "api_calls": int(r[6] or 0),
                "api_errors": int(r[7] or 0),
                "rate_limit_hits": int(r[8] or 0),
                "last_success_at": iso_utc(r[9]),
                "last_attempt_at": iso_utc(r[10]),
                "max_ingestion_latency_s": float(r[11]) if r[11] else None,
            }
            for r in (await self.db.execute(stmt)).all()
        ]

    # ── Settings ─────────────────────────────────────────────────────────────

    async def get_settings(self) -> CloudEventSettings:
        settings = (
            await self.db.execute(
                select(CloudEventSettings).where(CloudEventSettings.id == "SINGLETON")
            )
        ).scalar_one_or_none()
        if settings is None:
            settings = CloudEventSettings(id="SINGLETON")
            self.db.add(settings)
            await self.db.flush()
        return settings

    # ── Saved queries ────────────────────────────────────────────────────────

    async def list_saved_queries(
        self, owner: Optional[str] = None
    ) -> List[CloudEventSavedQuery]:
        stmt = select(CloudEventSavedQuery)
        if owner:
            # A caller's own queries plus the shared (unowned) ones. Filtering
            # to the owner alone would hide every query saved before this
            # service started receiving identities.
            stmt = stmt.where(
                or_(CloudEventSavedQuery.owner == owner,
                    CloudEventSavedQuery.owner.is_(None))
            )
        return list(
            (await self.db.execute(stmt.order_by(CloudEventSavedQuery.name))).scalars().all()
        )

    async def get_saved_query(self, query_id: uuid.UUID) -> Optional[CloudEventSavedQuery]:
        return (
            await self.db.execute(
                select(CloudEventSavedQuery).where(CloudEventSavedQuery.id == query_id)
            )
        ).scalar_one_or_none()

    async def delete_saved_query(self, query_id: uuid.UUID) -> bool:
        query = await self.get_saved_query(query_id)
        if not query:
            return False
        await self.db.delete(query)
        await self.db.flush()
        return True

    # ── Access log ───────────────────────────────────────────────────────────

    async def record_access(
        self,
        action: str,
        *,
        actor: Optional[str] = None,
        role: Optional[str] = None,
        target: Optional[str] = None,
        detail: Optional[Dict[str, Any]] = None,
        source_ip: Optional[str] = None,
    ) -> None:
        self.db.add(
            CloudEventAccessLog(
                action=action, actor=actor, role=role,
                target=(target or None) if target is None else str(target)[:512],
                detail=detail, source_ip=source_ip,
            )
        )
        await self.db.flush()

    async def list_access_log(
        self, *, days: int = 30, limit: int = 200, action: Optional[str] = None
    ) -> List[CloudEventAccessLog]:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        stmt = select(CloudEventAccessLog).where(CloudEventAccessLog.at >= since)
        if action:
            stmt = stmt.where(CloudEventAccessLog.action == action)
        stmt = stmt.order_by(CloudEventAccessLog.at.desc()).limit(limit)
        return list((await self.db.execute(stmt)).scalars().all())


def _require_time(value: Any, field: str) -> datetime:
    """Parse a timestamp filter value, or say why it could not be parsed.

    A time filter that silently falls back to a string comparison against a
    timestamptz column raises a database error the caller cannot interpret;
    failing here produces a 400 that names the field and the expected format.
    """
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        text_value = value.strip()
        if text_value.endswith("Z"):
            text_value = text_value[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text_value)
        except ValueError as exc:
            raise FilterError(
                f"{field} needs an ISO-8601 timestamp (e.g. 2026-09-08T14:32:11Z); "
                f"got {value!r}"
            ) from exc
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    raise FilterError(f"{field} needs an ISO-8601 timestamp; got {type(value).__name__}")
