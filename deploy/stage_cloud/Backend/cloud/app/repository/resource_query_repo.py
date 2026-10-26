"""Server-side resource querying: filter, search, sort, paginate, facet, group.

This replaces "send the browser every row and let React sort it out". That
approach is not merely slow — it is incorrect at scale, because the moment the
browser holds a subset, every count it renders is a count of the subset, and
the page confidently disagrees with itself.

THREE RULES THIS FILE ENFORCES
------------------------------
1. One WHERE clause. The row page, the total, the facet counts, the summary
   cards and the group aggregates are all built from the same filter object.
   That is what makes "476 resources" in the header equal to the number of rows
   you can page through, which is spec §59/§60 and is the failure everyone has
   seen: top card 476, table 474, facet 479.

2. Unknown never sorts as good. A NULL cost is not the cheapest resource, and a
   resource with no security assessment is not a safe one. Both sort last and
   are labelled, never coerced.

3. Nothing is interpolated into SQL. Every user-supplied value arrives as a
   bound parameter, and every field name that can reach an ORDER BY or GROUP BY
   is looked up in an allowlist first (spec §65).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import (
    Text, and_, case, cast, false, func, nulls_last, or_, select, true,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.models.resource_cost import CloudResourceCost
from app.models.security_finding import CloudSecurityFinding
from app.security.model import ACTIVE_FINDING_STATUSES, SEVERITIES
from app.services import resource_model as rm
from app.services import resource_services as svc


class QueryValidationError(ValueError):
    """A filter this layer refuses to guess about.

    Raised rather than silently ignored: a mistyped `sort=cst` that quietly
    falls back to name ordering produces a table the user believes is sorted by
    cost. Being told the parameter is invalid is strictly better.
    """

    def __init__(self, field_name: str, value: Any, allowed: Sequence[str]) -> None:
        self.field_name = field_name
        self.value = value
        self.allowed = list(allowed)
        super().__init__(
            f"{field_name}={value!r} is not valid. Allowed: {', '.join(map(str, allowed))}"
        )


# ── Risk vocabulary ──────────────────────────────────────────────────────────
RISK_NONE = "NONE"
RISK_UNKNOWN = "UNKNOWN"
RISK_LEVELS: Tuple[str, ...] = tuple(SEVERITIES) + (RISK_NONE, RISK_UNKNOWN)

# CRITICAL..INFO occupy 0..4 (matching security.model.SEVERITY_RANK), then:
_RANK_NONE = len(SEVERITIES)          # assessed, and clean
_RANK_UNKNOWN = len(SEVERITIES) + 1   # never assessed — we cannot speak for it
RISK_RANK: Dict[str, int] = {
    **{sev: i for i, sev in enumerate(SEVERITIES)},
    RISK_NONE: _RANK_NONE,
    RISK_UNKNOWN: _RANK_UNKNOWN,
}

MAX_PAGE_SIZE = 250          # spec §64
DEFAULT_PAGE_SIZE = 50
MIN_SEARCH_LENGTH = 2        # spec §13

# Dict key standing in for "this group's value is NULL". A sentinel object
# rather than a magic string, so it cannot collide with a real value.
_UNSET_GROUP = object()

SORT_FIELDS: Tuple[str, ...] = (
    "resource_name", "resource_type", "normalized_type", "region", "status",
    "cost", "risk", "finding_count", "updated_at", "discovered_at",
    "last_seen", "provider", "account", "tag_count", "environment", "owner",
    "service",
)

GROUP_FIELDS: Tuple[str, ...] = (
    "provider", "account", "region", "resource_type", "normalized_type",
    "status", "risk", "environment", "owner", "resource_group", "compartment",
    "service",
)

# Facet dimensions, mapped to the query field each one filters. A facet's own
# filter is excluded from its counts (see `facets`), so the rail always shows
# what selecting a different value would give you rather than a wall of zeros.
#
# `accounts` maps to None deliberately. The account list is the SCOPE, not a
# facet within it: clearing it would count every account in the estate and the
# accounts rail would then sum to more than the table's own total. That is
# precisely the self-disagreement this layer exists to prevent.
FACET_DIMENSIONS: Dict[str, Optional[str]] = {
    "providers": "providers",
    "accounts": None,
    "types": "types",
    "categories": "categories",
    "services": "services",
    "regions": "regions",
    "statuses": "statuses",
    "risk": "risk",
    "environments": "environments",
    "resource_groups": "resource_groups",
    "compartments": "compartments",
}


@dataclass(frozen=True)
class ResourceQuery:
    """A validated query. Immutable so the same object can safely back the row
    page, the total, every facet and the summary without one of them mutating
    it out from under the others."""

    account_ids: Tuple[uuid.UUID, ...] = ()
    q: Optional[str] = None
    providers: Tuple[str, ...] = ()
    types: Tuple[str, ...] = ()
    categories: Tuple[str, ...] = ()
    services: Tuple[str, ...] = ()
    regions: Tuple[str, ...] = ()
    statuses: Tuple[str, ...] = ()
    risk: Tuple[str, ...] = ()
    environments: Tuple[str, ...] = ()
    owners: Tuple[str, ...] = ()
    resource_groups: Tuple[str, ...] = ()
    compartments: Tuple[str, ...] = ()
    attachment: Optional[str] = None
    tagged: Optional[bool] = None
    tag_key: Optional[str] = None
    tag_value: Optional[str] = None
    missing_tag: Optional[str] = None
    has_cost: Optional[bool] = None
    cost_min: Optional[float] = None
    cost_max: Optional[float] = None
    has_findings: Optional[bool] = None
    updated_after: Optional[datetime] = None
    updated_before: Optional[datetime] = None
    stale: Optional[bool] = None
    include_defaults: bool = True
    sort: str = "resource_name"
    direction: str = "asc"
    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE

    # Populated by the service before use: accounts with a completed security
    # assessment. Without it every resource's risk would read NONE, which
    # claims an account is clean when nobody has ever looked.
    assessed_account_ids: Tuple[uuid.UUID, ...] = ()

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size

    def without(self, dimension: str) -> "ResourceQuery":
        """A copy with one dimension's filter cleared, for facet counting."""
        blanks: Dict[str, Any] = {
            "providers": (), "account_ids": (), "types": (), "categories": (),
            "services": (), "regions": (), "statuses": (), "risk": (), "environments": (),
            "owners": (), "resource_groups": (), "compartments": (),
        }
        if dimension not in blanks:
            return self
        return replace_query(self, **{dimension: blanks[dimension]})


def replace_query(query: ResourceQuery, **changes: Any) -> ResourceQuery:
    import dataclasses

    return dataclasses.replace(query, **changes)


def _as_tuple(value: Any) -> Tuple[str, ...]:
    """Accept ?type=A&type=B, ?type=A,B, or a single value, uniformly."""
    if value is None:
        return ()
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        parts = []
        for item in value:
            if item is None:
                continue
            parts.extend(p.strip() for p in str(item).split(","))
    else:
        parts = [str(value).strip()]
    return tuple(dict.fromkeys(p for p in parts if p))


def build_query(
    *,
    account_ids: Sequence[uuid.UUID] = (),
    assessed_account_ids: Sequence[uuid.UUID] = (),
    q: Optional[str] = None,
    provider: Any = None,
    type: Any = None,          # noqa: A002 - matches the query-string name
    category: Any = None,
    service: Any = None,
    region: Any = None,
    status: Any = None,
    risk: Any = None,
    environment: Any = None,
    owner: Any = None,
    resource_group: Any = None,
    compartment: Any = None,
    attachment: Optional[str] = None,
    has_tags: Optional[bool] = None,
    tag_key: Optional[str] = None,
    tag_value: Optional[str] = None,
    missing_tag: Optional[str] = None,
    has_cost: Optional[bool] = None,
    cost_min: Optional[float] = None,
    cost_max: Optional[float] = None,
    has_findings: Optional[bool] = None,
    updated_after: Optional[datetime] = None,
    updated_before: Optional[datetime] = None,
    stale: Optional[bool] = None,
    include_defaults: bool = True,
    sort: Optional[str] = None,
    dir: Optional[str] = None,  # noqa: A002 - matches the query-string name
    page: Optional[int] = None,
    page_size: Optional[int] = None,
) -> ResourceQuery:
    """Validate raw query-string values into a ResourceQuery.

    Everything that can reach SQL structure (sort field, direction) is checked
    against an allowlist here and nowhere else.
    """
    sort_field = (sort or "resource_name").strip().lower()
    if sort_field not in SORT_FIELDS:
        raise QueryValidationError("sort", sort, SORT_FIELDS)

    direction = (dir or "asc").strip().lower()
    if direction not in ("asc", "desc"):
        raise QueryValidationError("dir", dir, ("asc", "desc"))

    statuses = tuple(s.upper() for s in _as_tuple(status))
    for value in statuses:
        if value not in rm.NORMALIZED_STATUSES:
            raise QueryValidationError("status", value, rm.NORMALIZED_STATUSES)

    risks = tuple(r.upper() for r in _as_tuple(risk))
    for value in risks:
        if value not in RISK_LEVELS:
            raise QueryValidationError("risk", value, RISK_LEVELS)

    categories = tuple(c.upper() for c in _as_tuple(category))
    for value in categories:
        if value not in rm.CATEGORIES:
            raise QueryValidationError("category", value, rm.CATEGORIES)

    attach = (attachment or "").strip().upper() or None
    if attach is not None and attach not in (rm.ATTACHED, rm.UNATTACHED):
        raise QueryValidationError("attachment", attachment, (rm.ATTACHED, rm.UNATTACHED))

    if cost_min is not None and cost_max is not None and cost_min > cost_max:
        raise QueryValidationError(
            "cost_min", cost_min, (f"a value <= cost_max ({cost_max})",)
        )

    size = int(page_size or DEFAULT_PAGE_SIZE)
    # Clamped, not rejected: a client asking for too much gets the maximum and
    # a correct `page_size` echoed back, so its own paging arithmetic stays
    # consistent with what it received.
    size = max(1, min(size, MAX_PAGE_SIZE))
    page_no = max(1, int(page or 1))

    search = (q or "").strip() or None
    if search is not None and len(search) < MIN_SEARCH_LENGTH:
        search = None

    return ResourceQuery(
        account_ids=tuple(account_ids),
        assessed_account_ids=tuple(assessed_account_ids),
        q=search,
        providers=tuple(p.upper() for p in _as_tuple(provider)),
        types=_as_tuple(type),
        categories=categories,
        services=tuple(s.lower() for s in _as_tuple(service)),
        regions=_as_tuple(region),
        statuses=statuses,
        risk=risks,
        environments=_as_tuple(environment),
        owners=_as_tuple(owner),
        resource_groups=_as_tuple(resource_group),
        compartments=_as_tuple(compartment),
        attachment=attach,
        tagged=has_tags,
        tag_key=(tag_key or "").strip() or None,
        tag_value=(tag_value or "").strip() or None,
        missing_tag=(missing_tag or "").strip() or None,
        has_cost=has_cost,
        cost_min=cost_min,
        cost_max=cost_max,
        has_findings=has_findings,
        updated_after=updated_after,
        updated_before=updated_before,
        stale=stale,
        include_defaults=include_defaults,
        sort=sort_field,
        direction=direction,
        page=page_no,
        page_size=size,
    )


class ResourceQueryRepository:
    """Every read the Resources workspace performs, sharing one filter."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Shared building blocks ───────────────────────────────────────────────
    def _findings_subquery(self):
        """Active findings per resource, with the severity breakdown.

        Only ACTIVE statuses count. A suppressed finding was a deliberate human
        decision and must not keep colouring a row red; a resolved one is over.
        Both remain in the Security Center, which is where that history belongs.
        """
        sev = CloudSecurityFinding.severity
        rank = case(
            {s: i for i, s in enumerate(SEVERITIES)}, value=sev, else_=len(SEVERITIES)
        )
        return (
            select(
                CloudSecurityFinding.resource_id.label("resource_id"),
                func.count().label("finding_count"),
                func.min(rank).label("worst_rank"),
                *[
                    func.count().filter(sev == s).label(f"count_{s.lower()}")
                    for s in SEVERITIES
                ],
            )
            .where(
                CloudSecurityFinding.resource_id.isnot(None),
                CloudSecurityFinding.status.in_(list(ACTIVE_FINDING_STATUSES)),
            )
            .group_by(CloudSecurityFinding.resource_id)
            .subquery()
        )

    def _risk_rank_expr(self, findings, assessed: Sequence[uuid.UUID]):
        """CRITICAL..INFO, then NONE, then UNKNOWN.

        The UNKNOWN branch is the one that matters. A resource in an account
        that has never been security-assessed has no findings — and reading
        that as "no risk" tells the user the resource is clean when the truth
        is that nobody has looked at it.
        """
        if assessed:
            clean_or_unknown = case(
                (CloudResource.account_id.in_(list(assessed)), _RANK_NONE),
                else_=_RANK_UNKNOWN,
            )
        else:
            clean_or_unknown = _RANK_UNKNOWN
        return func.coalesce(findings.c.worst_rank, clean_or_unknown)

    def _base(self, query: ResourceQuery, findings, costs):
        """The single FROM/WHERE every other method is built on."""
        stmt = (
            select(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
        )
        return stmt.where(*self._conditions(query, findings, costs))

    def _conditions(self, query: ResourceQuery, findings, costs) -> List[Any]:
        where: List[Any] = []

        if query.account_ids:
            where.append(CloudResource.account_id.in_(list(query.account_ids)))
        if query.providers:
            where.append(func.upper(CloudAccount.provider).in_(list(query.providers)))
        if query.types:
            where.append(CloudResource.resource_type.in_(list(query.types)))
        if query.categories:
            where.append(CloudResource.normalized_type.in_(list(query.categories)))
        if query.services:
            where.append(CloudResource.service.in_(list(query.services)))
        if query.regions:
            where.append(CloudResource.region_or_zone.in_(list(query.regions)))
        if query.statuses:
            # A row normalized before this column existed has NULL here and is
            # genuinely unknown, so UNKNOWN must match it too.
            if rm.UNKNOWN in query.statuses:
                where.append(or_(
                    CloudResource.normalized_status.in_(list(query.statuses)),
                    CloudResource.normalized_status.is_(None),
                ))
            else:
                where.append(CloudResource.normalized_status.in_(list(query.statuses)))
        if query.environments:
            where.append(CloudResource.environment.in_(list(query.environments)))
        if query.owners:
            where.append(CloudResource.owner.in_(list(query.owners)))
        if query.resource_groups:
            where.append(CloudResource.resource_group.in_(list(query.resource_groups)))
        if query.compartments:
            where.append(CloudResource.compartment.in_(list(query.compartments)))
        if query.attachment:
            where.append(CloudResource.attachment_state == query.attachment)

        if query.risk:
            where.append(self._risk_condition(query, findings))

        if not query.include_defaults:
            where.append(or_(
                CloudResource.is_default.is_(False),
                CloudResource.is_default.is_(None),
            ))

        # Tags. `tag_count` is the persisted projection; using it keeps this a
        # plain integer comparison instead of a JSONB scan per row.
        if query.tagged is True:
            where.append(CloudResource.tag_count > 0)
        elif query.tagged is False:
            where.append(or_(
                CloudResource.tag_count == 0,
                CloudResource.tag_count.is_(None),
            ))
        if query.tag_key:
            where.append(CloudResource.tags.has_key(query.tag_key))  # noqa: W601
            if query.tag_value:
                where.append(
                    CloudResource.tags[query.tag_key].astext == query.tag_value
                )
        if query.missing_tag:
            where.append(or_(
                CloudResource.tags.is_(None),
                ~CloudResource.tags.has_key(query.missing_tag),  # noqa: W601
            ))

        # Cost. `has_cost=False` means "no cost is known", which includes both
        # a missing row and a row whose amount the provider left null.
        if query.has_cost is True:
            where.append(costs.c.amount.isnot(None))
        elif query.has_cost is False:
            where.append(costs.c.amount.is_(None))
        if query.cost_min is not None:
            where.append(costs.c.amount >= query.cost_min)
        if query.cost_max is not None:
            where.append(costs.c.amount <= query.cost_max)

        if query.has_findings is True:
            where.append(findings.c.finding_count > 0)
        elif query.has_findings is False:
            where.append(findings.c.finding_count.is_(None))

        if query.updated_after:
            where.append(CloudResource.updated_at >= query.updated_after)
        if query.updated_before:
            where.append(CloudResource.updated_at <= query.updated_before)

        if query.stale is not None:
            where.append(self._stale_condition(query.stale))

        if query.q:
            where.append(self._search_condition(query.q))

        return where

    def _risk_condition(self, query: ResourceQuery, findings):
        wanted = set(query.risk)
        clauses: List[Any] = []
        severity_ranks = [
            RISK_RANK[s] for s in wanted if s in SEVERITIES
        ]
        if severity_ranks:
            clauses.append(findings.c.worst_rank.in_(severity_ranks))
        assessed = list(query.assessed_account_ids)
        if RISK_NONE in wanted:
            if assessed:
                clauses.append(and_(
                    findings.c.worst_rank.is_(None),
                    CloudResource.account_id.in_(assessed),
                ))
            else:
                # Nothing in scope has ever been assessed, so nothing in scope
                # can honestly be called clean. Matching zero rows is the
                # correct answer; matching everything would be a lie.
                clauses.append(false())
        if RISK_UNKNOWN in wanted:
            unassessed = [findings.c.worst_rank.is_(None)]
            if assessed:
                unassessed.append(CloudResource.account_id.notin_(assessed))
            clauses.append(and_(*unassessed))
        return or_(*clauses) if clauses else true()

    def _observed_at(self):
        """When this resource was last observed.

        Per-resource tracking (`last_seen_at`) is written by every sweep from
        now on. Rows that predate the column fall back to their account's last
        successful discovery - a real recorded timestamp rather than an
        invented one, since every resource still on file was present at that
        sweep or it would have been pruned. The fallback is labelled wherever
        it reaches the UI, so an account-level date is never mistaken for a
        per-resource observation.
        """
        return func.coalesce(CloudResource.last_seen_at, CloudAccount.last_discovery)

    def _stale_condition(self, stale: bool):
        """Stale is measured from when discovery last SAW the resource.

        A row that has never been observed since the column was added has NULL
        and counts as stale — "we have no record of looking at this" is not a
        fresh state.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(hours=_aging_hours())
        observed = self._observed_at()
        if stale:
            return or_(observed.is_(None), observed < cutoff)
        return observed >= cutoff

    def _search_condition(self, term: str):
        """Case-insensitive contains across the fields a person actually types.

        An exact match on the provider ID is included explicitly so pasting a
        full ARN or OCID finds its resource even when the contains-match would
        also work — it makes the intent legible and lets the planner use the
        index on provider_resource_id.
        """
        like = f"%{term}%"
        return or_(
            CloudResource.provider_resource_id == term,
            CloudResource.resource_name.ilike(like),
            CloudResource.provider_resource_id.ilike(like),
            CloudResource.resource_type.ilike(like),
            CloudResource.region_or_zone.ilike(like),
            CloudResource.ip_address.ilike(like),
            CloudResource.resource_group.ilike(like),
            CloudResource.compartment.ilike(like),
            CloudResource.environment.ilike(like),
            CloudResource.owner.ilike(like),
            CloudAccount.account_name.ilike(like),
            # Tag values, as text. A GIN index would be the answer if this ever
            # becomes the hot path; at this estate's size it is not, and
            # indexing JSONB speculatively is how you get an index nobody uses.
            cast(CloudResource.tags, Text).ilike(like),
        )

    def _order_by(self, query: ResourceQuery, findings, costs):
        descending = query.direction == "desc"

        def apply(column, *, nulls_last_always: bool = False):
            ordered = column.desc() if descending else column.asc()
            if nulls_last_always:
                # Unknown is never "best" and never "worst" - it is unknown, so
                # it sits at the end in BOTH directions. Postgres would
                # otherwise sort NULLs first on DESC, putting every resource
                # whose cost we cannot see at the top of "most expensive".
                return nulls_last(ordered)
            return ordered

        if query.sort == "cost":
            primary = apply(costs.c.amount, nulls_last_always=True)
        elif query.sort == "risk":
            primary = apply(
                self._risk_rank_expr(findings, query.assessed_account_ids)
            )
        elif query.sort == "finding_count":
            primary = apply(
                func.coalesce(findings.c.finding_count, 0)
            )
        elif query.sort == "status":
            # Logical order, not alphabetical (spec §15).
            primary = apply(case(
                rm.STATUS_SORT_ORDER,
                value=func.coalesce(CloudResource.normalized_status, rm.UNKNOWN),
                else_=len(rm.STATUS_SORT_ORDER),
            ))
        elif query.sort == "region":
            primary = apply(CloudResource.region_or_zone)
        elif query.sort == "provider":
            primary = apply(CloudAccount.provider)
        elif query.sort == "account":
            primary = apply(CloudAccount.account_name)
        elif query.sort == "last_seen":
            primary = apply(self._observed_at(), nulls_last_always=True)
        elif query.sort in ("environment", "owner"):
            primary = apply(
                getattr(CloudResource, query.sort), nulls_last_always=True
            )
        elif query.sort == "tag_count":
            primary = apply(func.coalesce(CloudResource.tag_count, 0))
        else:
            primary = apply(getattr(CloudResource, query.sort))

        # A stable tiebreaker. Without one, two rows with equal sort keys can
        # swap between page 1 and page 2 and the same resource appears twice
        # (or never) across a pagination run.
        return [primary, CloudResource.id.asc()]

    # ── Public reads ─────────────────────────────────────────────────────────
    async def query(self, query: ResourceQuery) -> Dict[str, Any]:
        """One page of rows, plus the total the same filter matches."""
        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()

        risk_rank = self._risk_rank_expr(findings, query.assessed_account_ids)
        stmt = (
            select(
                CloudResource,
                CloudAccount.provider.label("provider"),
                CloudAccount.account_name.label("account_name"),
                costs.c.amount.label("cost_amount"),
                costs.c.currency.label("cost_currency"),
                costs.c.period_days.label("cost_period_days"),
                costs.c.source.label("cost_source"),
                costs.c.billed_service.label("cost_service"),
                costs.c.fetched_at.label("cost_fetched_at"),
                self._observed_at().label("observed_at"),
                func.coalesce(findings.c.finding_count, 0).label("finding_count"),
                risk_rank.label("risk_rank"),
                *[
                    func.coalesce(getattr(findings.c, f"count_{s.lower()}"), 0)
                    .label(f"count_{s.lower()}")
                    for s in SEVERITIES
                ],
            )
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*self._conditions(query, findings, costs))
            .order_by(*self._order_by(query, findings, costs))
            .limit(query.page_size)
            .offset(query.offset)
        )

        rows = (await self.db.execute(stmt)).all()
        total = await self.count(query)
        return {"rows": rows, "total": total}

    async def count(self, query: ResourceQuery) -> int:
        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()
        stmt = (
            select(func.count(func.distinct(CloudResource.id)))
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*self._conditions(query, findings, costs))
        )
        return int((await self.db.execute(stmt)).scalar() or 0)

    async def summary(self, query: ResourceQuery) -> Dict[str, Any]:
        """The header strip, computed from the same filter as the rows.

        Every figure here is a `count(*) FILTER (...)` over one scan of the
        same set, which is what makes them reconcile by construction rather
        than by luck (spec §59/§60).
        """
        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()
        cutoff = datetime.now(timezone.utc) - timedelta(hours=_aging_hours())
        risk_rank = self._risk_rank_expr(findings, query.assessed_account_ids)

        stmt = (
            select(
                func.count().label("resource_count"),
                func.count().filter(costs.c.amount.isnot(None)).label("with_cost"),
                func.count().filter(findings.c.finding_count > 0).label("with_findings"),
                func.count().filter(risk_rank <= RISK_RANK["HIGH"]).label("high_risk"),
                func.count().filter(risk_rank == _RANK_UNKNOWN).label("risk_unknown"),
                func.count().filter(
                    CloudResource.normalized_status == rm.STOPPED
                ).label("stopped"),
                func.count().filter(
                    CloudResource.normalized_status == rm.UNATTACHED
                ).label("unattached_status"),
                func.count().filter(
                    CloudResource.attachment_state == rm.UNATTACHED
                ).label("unattached"),
                func.count().filter(or_(
                    CloudResource.tag_count == 0, CloudResource.tag_count.is_(None),
                )).label("untagged"),
                func.count().filter(or_(
                    self._observed_at().is_(None),
                    self._observed_at() < cutoff,
                )).label("stale"),
                func.count().filter(or_(
                    CloudResource.normalized_status == rm.UNKNOWN,
                    CloudResource.normalized_status.is_(None),
                )).label("status_unknown"),
                func.min(self._observed_at()).label("oldest_seen"),
                func.max(self._observed_at()).label("newest_seen"),
            )
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*self._conditions(query, findings, costs))
        )
        row = (await self.db.execute(stmt)).one()

        # Cost is totalled PER CURRENCY and never across them. This estate
        # bills in both INR and USD; a single summed number would be a figure
        # that exists in no currency at all.
        # `period_days` and `fetched_at` travel WITH the figure because without
        # them it cannot be read correctly. This total is the spend the provider
        # attributes to individual resources, over a fixed window, as of a
        # particular fetch -- it is NOT the account's bill, and on OCI the two
        # differ by whatever the provider bills at tenancy level (data transfer,
        # support, licences) plus every resource it prices at all. Reported as
        # "35.03L" with no window and no age, it reads as the bill and is wrong
        # by ~23%.
        totals = (await self.db.execute(
            select(
                costs.c.currency,
                func.sum(costs.c.amount),
                func.count().filter(costs.c.amount.isnot(None)),
                func.max(costs.c.period_days),
                func.max(costs.c.fetched_at),
            )
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*self._conditions(query, findings, costs))
            .where(costs.c.amount.isnot(None))
            .group_by(costs.c.currency)
        )).all()

        return {
            "resource_count": int(row.resource_count or 0),
            "cost_resource_count": int(row.with_cost or 0),
            "risk_resource_count": int(row.with_findings or 0),
            "high_risk_count": int(row.high_risk or 0),
            "risk_unknown_count": int(row.risk_unknown or 0),
            "stopped_count": int(row.stopped or 0),
            "unattached_count": int(row.unattached or 0),
            "untagged_count": int(row.untagged or 0),
            "stale_count": int(row.stale or 0),
            "status_unknown_count": int(row.status_unknown or 0),
            "oldest_seen_at": row.oldest_seen.isoformat() if row.oldest_seen else None,
            "newest_seen_at": row.newest_seen.isoformat() if row.newest_seen else None,
            "cost_by_currency": [
                {
                    "currency": currency,
                    "amount": round(float(amount), 2) if amount is not None else None,
                    "resource_count": int(count or 0),
                    "period_days": int(period_days) if period_days else None,
                    "fetched_at": fetched_at.isoformat() if fetched_at else None,
                }
                for currency, amount, count, period_days, fetched_at in totals
                if currency
            ],
        }

    async def facets(
        self, query: ResourceQuery, *, dimensions: Optional[Sequence[str]] = None,
        limit: int = 40,
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Counts per dimension, in the current filter context.

        A facet's own filter is excluded from its own counts. Selecting
        "Compute" and then seeing every other type at 0 is useless — the rail
        exists to tell you what selecting something else would give you.
        """
        wanted = list(dimensions or FACET_DIMENSIONS.keys())
        out: Dict[str, List[Dict[str, Any]]] = {}
        for name in wanted:
            if name not in FACET_DIMENSIONS:
                continue
            filter_field = FACET_DIMENSIONS[name]
            scoped = query if filter_field is None else query.without(filter_field)
            # Services are a bounded catalogue (one estate of all three clouds
            # is ~50), and a truncated service list would make a whole service
            # unfilterable — so it is never cut at the generic cap.
            cap = max(limit, 300) if name == "services" else limit
            out[name] = await self._facet(name, scoped, limit=cap)
        return out

    async def _facet(
        self, dimension: str, query: ResourceQuery, *, limit: int
    ) -> List[Dict[str, Any]]:
        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()
        conditions = self._conditions(query, findings, costs)

        if dimension == "risk":
            risk_rank = self._risk_rank_expr(findings, query.assessed_account_ids)
            rows = (await self.db.execute(
                select(risk_rank.label("rank"), func.count())
                .select_from(CloudResource)
                .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
                .outerjoin(findings, findings.c.resource_id == CloudResource.id)
                .outerjoin(costs, costs.c.resource_id == CloudResource.id)
                .where(*conditions)
                .group_by("rank")
            )).all()
            by_rank = {int(rank): int(count) for rank, count in rows}
            return [
                {"value": level, "label": level.title() if level != RISK_UNKNOWN
                 else "Not assessed", "count": by_rank.get(RISK_RANK[level], 0)}
                for level in RISK_LEVELS
                if by_rank.get(RISK_RANK[level], 0) > 0
            ]

        if dimension == "accounts":
            # Keyed on the account id, not its name. A facet's `value` is an
            # identifier callers key by — the accounts list on the provider
            # pages uses it to attach a count to an account — and two accounts
            # may legitimately carry the same display name. The name travels as
            # the label, which is what the rail actually renders.
            rows = (await self.db.execute(
                select(
                    CloudAccount.id.label("value"),
                    CloudAccount.account_name.label("label"),
                    func.count().label("n"),
                )
                .select_from(CloudResource)
                .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
                .outerjoin(findings, findings.c.resource_id == CloudResource.id)
                .outerjoin(costs, costs.c.resource_id == CloudResource.id)
                .where(*conditions)
                .group_by(CloudAccount.id, CloudAccount.account_name)
                .order_by(func.count().desc())
                .limit(limit)
            )).all()
            return [
                {"value": str(value), "label": label, "count": int(count)}
                for value, label, count in rows
            ]

        column, labeller = {
            "providers": (CloudAccount.provider, None),
            "types": (CloudResource.resource_type, None),
            "categories": (CloudResource.normalized_type, rm.CATEGORY_LABELS.get),
            "services": (CloudResource.service, svc.label_of),
            "regions": (CloudResource.region_or_zone, None),
            "statuses": (func.coalesce(CloudResource.normalized_status, rm.UNKNOWN), None),
            "environments": (CloudResource.environment, None),
            "resource_groups": (CloudResource.resource_group, None),
            "compartments": (CloudResource.compartment, None),
        }[dimension]

        rows = (await self.db.execute(
            select(column.label("value"), func.count().label("n"))
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*conditions)
            .group_by("value")
            .order_by(func.count().desc())
            .limit(limit)
        )).all()

        out = [
            {
                "value": value,
                "label": (labeller(value) if labeller else None) or value,
                "count": int(count),
            }
            for value, count in rows
            if value is not None
        ]
        if dimension == "services":
            # Which cloud each service is, so the rail can section them.
            for entry in out:
                entry["provider"] = svc.provider_of(entry["value"])
        return out

    async def groups(
        self, query: ResourceQuery, group_by: str, *, limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Server-aggregated groups (spec §35).

        Totals per group are per currency for the same reason the summary's
        are: there is no such thing as a combined INR+USD number.
        """
        if group_by not in GROUP_FIELDS:
            raise QueryValidationError("group_by", group_by, GROUP_FIELDS)

        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()
        conditions = self._conditions(query, findings, costs)
        risk_rank = self._risk_rank_expr(findings, query.assessed_account_ids)

        column = {
            "provider": CloudAccount.provider,
            "account": CloudAccount.account_name,
            "region": CloudResource.region_or_zone,
            "resource_type": CloudResource.resource_type,
            "normalized_type": CloudResource.normalized_type,
            "status": func.coalesce(CloudResource.normalized_status, rm.UNKNOWN),
            "environment": CloudResource.environment,
            "owner": CloudResource.owner,
            "resource_group": CloudResource.resource_group,
            "compartment": CloudResource.compartment,
            "service": CloudResource.service,
            "risk": case(
                {rank: level for level, rank in RISK_RANK.items()},
                value=risk_rank, else_=RISK_UNKNOWN,
            ),
        }[group_by]

        rows = (await self.db.execute(
            select(
                column.label("value"),
                costs.c.currency.label("currency"),
                func.count().label("n"),
                func.sum(costs.c.amount).label("cost"),
                func.count().filter(risk_rank <= RISK_RANK["HIGH"]).label("risky"),
                func.count().filter(
                    CloudResource.normalized_status == rm.STOPPED
                ).label("stopped"),
                func.count().filter(or_(
                    CloudResource.tag_count == 0, CloudResource.tag_count.is_(None),
                )).label("untagged"),
            )
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*conditions)
            .group_by("value", "currency")
        )).all()

        merged: Dict[Any, Dict[str, Any]] = {}
        for value, currency, n, cost, risky, stopped, untagged in rows:
            # None is a real group - resources with no environment tag are a
            # group worth seeing, not rows to drop. The sentinel only keeps
            # them from colliding with a literal string in the dict.
            key = value if value is not None else _UNSET_GROUP
            entry = merged.setdefault(key, {
                "value": value,
                "label": (
                    rm.CATEGORY_LABELS.get(value, value)
                    if group_by == "normalized_type"
                    else svc.label_of(value) if group_by == "service" else value
                ) or "Not set",
                "resource_count": 0,
                "risky_count": 0,
                "stopped_count": 0,
                "untagged_count": 0,
                "cost_by_currency": [],
            })
            entry["resource_count"] += int(n or 0)
            entry["risky_count"] += int(risky or 0)
            entry["stopped_count"] += int(stopped or 0)
            entry["untagged_count"] += int(untagged or 0)
            if currency and cost is not None:
                entry["cost_by_currency"].append(
                    {"currency": currency, "amount": round(float(cost), 2)}
                )

        groups = sorted(
            merged.values(), key=lambda g: -g["resource_count"]
        )[:limit]
        return groups

    async def distinct_values(
        self, query: ResourceQuery, column_name: str, *, limit: int = 500
    ) -> List[str]:
        """Values available for a filter control, within the current scope."""
        allowed = {
            "resource_type": CloudResource.resource_type,
            "region": CloudResource.region_or_zone,
            "environment": CloudResource.environment,
            "owner": CloudResource.owner,
            "resource_group": CloudResource.resource_group,
            "compartment": CloudResource.compartment,
        }
        if column_name not in allowed:
            raise QueryValidationError("column", column_name, tuple(allowed))
        column = allowed[column_name]
        findings = self._findings_subquery()
        costs = select(CloudResourceCost).subquery()
        rows = (await self.db.execute(
            select(column)
            .select_from(CloudResource)
            .join(CloudAccount, CloudAccount.id == CloudResource.account_id)
            .outerjoin(findings, findings.c.resource_id == CloudResource.id)
            .outerjoin(costs, costs.c.resource_id == CloudResource.id)
            .where(*self._conditions(query, findings, costs))
            .where(column.isnot(None))
            .group_by(column)
            .order_by(column)
            .limit(limit)
        )).all()
        return [row[0] for row in rows]

    async def iter_all(self, query: ResourceQuery, *, chunk: int = 500):
        """Every matching row, in pages, for export.

        Export must reflect exactly what the user filtered (spec §55), so it
        runs the same query — it just walks all of it instead of one page.
        """
        page = 1
        while True:
            scoped = replace_query(query, page=page, page_size=chunk)
            result = await self.query(scoped)
            rows = result["rows"]
            if not rows:
                return
            for row in rows:
                yield row
            if len(rows) < chunk:
                return
            page += 1


def _aging_hours() -> int:
    """Where "stale" begins, read through resource_model so there is one
    definition rather than a second threshold hiding in SQL."""
    import os

    return int(os.getenv("CLOUD_RESOURCE_AGING_HOURS", str(7 * 24)))
