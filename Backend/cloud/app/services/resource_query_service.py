"""The Resources workspace's read surface.

Sits between the HTTP routes and `ResourceQueryRepository`. Its job is scope
resolution, serialization and the honesty rules that are easier to state in
Python than in SQL — chiefly: which accounts have actually been security-
assessed, and what a figure means when it is absent.

Nothing here queries a cloud provider. Inventory is database-backed
(spec §62); costs were materialized by the cost feature; findings by the
security engine; relationships by topology. This module joins what those
systems already know and never becomes a fourth copy of any of them.
"""
from __future__ import annotations

import csv
import io
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.models.security_finding import CloudSecurityAssessment
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_query_repo import (
    FACET_DIMENSIONS,
    GROUP_FIELDS,
    MAX_PAGE_SIZE,
    RISK_LEVELS,
    RISK_RANK,
    RISK_UNKNOWN,
    QueryValidationError,
    ResourceQuery,
    ResourceQueryRepository,
    build_query,
    replace_query,
)
from app.security.model import ASSESS_COMPLETE, ASSESS_PARTIAL, SEVERITIES
from app.services import resource_capabilities as caps
from app.services import resource_model as rm
from app.services import resource_normalizer as normalizer
from app.services import resource_services as svc

logger = logging.getLogger("cloud_svc.resource_query")

ALL_SCOPE = "ALL"

_RANK_TO_RISK = {rank: level for level, rank in RISK_RANK.items()}


class ScopeError(ValueError):
    """The requested account scope does not exist."""


class ResourceQueryService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = ResourceQueryRepository(db)
        self.accounts = CloudAccountRepository(db)

    # ── Scope ────────────────────────────────────────────────────────────────
    async def resolve_scope(self, account_id: str) -> Tuple[List[CloudAccount], bool]:
        """Accounts in scope, and whether this is the cross-account view.

        "ALL" is a real scope, not a convenience: the global search in spec §6
        has to reach an AWS account, an Azure subscription and an OCI tenancy in
        one query, and doing that per-account in the browser is the thing being
        replaced.
        """
        if (account_id or "").strip().upper() == ALL_SCOPE:
            return list(await self.accounts.list_all()), True
        try:
            parsed = uuid.UUID(str(account_id))
        except (ValueError, AttributeError, TypeError):
            raise ScopeError(
                f"{account_id!r} is neither a cloud account id nor 'ALL'."
            )
        account = await self.accounts.get_by_id(parsed)
        if account is None:
            raise ScopeError(f"No cloud account with id {account_id}.")
        return [account], False

    async def assessed_account_ids(
        self, account_ids: Sequence[uuid.UUID]
    ) -> List[uuid.UUID]:
        """Accounts a security assessment has actually completed for.

        This is what separates "this resource has no findings" from "nobody has
        ever checked this resource". Both look identical in the findings table —
        an empty result — and only one of them means the resource is clean.
        Without this, a freshly-added account would render as an estate with
        perfect security posture.
        """
        if not account_ids:
            return []
        rows = (await self.db.execute(
            select(CloudSecurityAssessment.account_id)
            .where(
                CloudSecurityAssessment.account_id.in_(list(account_ids)),
                CloudSecurityAssessment.outcome.in_([ASSESS_COMPLETE, ASSESS_PARTIAL]),
            )
            .group_by(CloudSecurityAssessment.account_id)
        )).all()
        return [row[0] for row in rows]

    # ── The main query ───────────────────────────────────────────────────────
    async def query(
        self,
        account_id: str,
        *,
        include_facets: bool = True,
        include_summary: bool = True,
        group_by: Optional[str] = None,
        **params: Any,
    ) -> Dict[str, Any]:
        accounts, is_global = await self.resolve_scope(account_id)
        account_ids = [a.id for a in accounts]
        query = build_query(
            account_ids=account_ids,
            assessed_account_ids=await self.assessed_account_ids(account_ids),
            **params,
        )

        result = await self.repo.query(query)
        accounts_by_id = {a.id: a for a in accounts}
        rows = [self._serialize(row, accounts_by_id) for row in result["rows"]]

        payload: Dict[str, Any] = {
            "rows": rows,
            "total": result["total"],
            "page": query.page,
            "page_size": query.page_size,
            "page_count": _page_count(result["total"], query.page_size),
            "sort": query.sort,
            "dir": query.direction,
            "scope": {
                "account_id": ALL_SCOPE if is_global else str(account_ids[0]) if account_ids else None,
                "is_global": is_global,
                "accounts": [
                    {"id": str(a.id), "name": a.account_name, "provider": a.provider}
                    for a in accounts
                ],
            },
        }

        if include_summary:
            payload["summary"] = await self.repo.summary(query)
        if include_facets:
            payload["facets"] = await self.repo.facets(query)
        if group_by:
            payload["groups"] = await self.repo.groups(query, group_by)
            payload["group_by"] = group_by

        payload["capabilities"] = caps.scope_summary([a.provider for a in accounts])
        payload["data_quality"] = await self.data_quality(account_ids, query=query)
        return payload

    async def facets(self, account_id: str, **params: Any) -> Dict[str, Any]:
        accounts, _ = await self.resolve_scope(account_id)
        account_ids = [a.id for a in accounts]
        query = build_query(
            account_ids=account_ids,
            assessed_account_ids=await self.assessed_account_ids(account_ids),
            **params,
        )
        return {"facets": await self.repo.facets(query)}

    async def summary(self, account_id: str, **params: Any) -> Dict[str, Any]:
        accounts, _ = await self.resolve_scope(account_id)
        account_ids = [a.id for a in accounts]
        query = build_query(
            account_ids=account_ids,
            assessed_account_ids=await self.assessed_account_ids(account_ids),
            **params,
        )
        return {
            "summary": await self.repo.summary(query),
            "data_quality": await self.data_quality(account_ids, query=query),
        }

    async def groups(self, account_id: str, group_by: str, **params: Any) -> Dict[str, Any]:
        accounts, _ = await self.resolve_scope(account_id)
        account_ids = [a.id for a in accounts]
        query = build_query(
            account_ids=account_ids,
            assessed_account_ids=await self.assessed_account_ids(account_ids),
            **params,
        )
        return {
            "group_by": group_by,
            "groups": await self.repo.groups(query, group_by),
        }

    # ── Serialization ────────────────────────────────────────────────────────
    def _serialize(self, row: Any, accounts_by_id: Dict[uuid.UUID, CloudAccount]) -> Dict[str, Any]:
        """One row in the normalized shape of spec §7/§61.

        `raw_data` is deliberately absent: it was excluded from list responses
        before this rebuild and stays excluded. It is large, it is only useful
        when inspecting one resource, and shipping it 50 rows at a time would
        make every page load carry megabytes nobody reads.
        """
        resource: CloudResource = row[0]
        account = accounts_by_id.get(resource.account_id)
        observed_at = getattr(row, "observed_at", None) or resource.last_seen_at
        fresh = rm.freshness(observed_at)
        # Which of the two possible sources this timestamp came from. A row
        # predating per-resource tracking borrows its account's last discovery,
        # and saying so is the difference between a dated fact and a dated
        # guess.
        observed_source = (
            "resource" if resource.last_seen_at is not None
            else ("account_discovery" if observed_at is not None else None)
        )
        type_info = rm.normalize_type(resource.resource_type)

        risk_rank = int(row.risk_rank) if row.risk_rank is not None else RISK_RANK[RISK_UNKNOWN]
        risk_level = _RANK_TO_RISK.get(risk_rank, RISK_UNKNOWN)
        severity_counts = {
            severity.lower(): int(getattr(row, f"count_{severity.lower()}") or 0)
            for severity in SEVERITIES
        }

        provider = (account.provider if account else None) or row.provider
        provider_caps = caps.for_provider(provider)

        service_info = (
            svc.ServiceInfo(resource.service, svc.label_of(resource.service),
                            svc.provider_of(resource.service) or "", True)
            if resource.service
            else svc.service_of(resource.resource_type, resource.provider_resource_id, provider)
        )
        return {
            "id": str(resource.id),
            "account_id": str(resource.account_id),
            "account_name": account.account_name if account else row.account_name,
            "provider": provider,
            "provider_resource_id": resource.provider_resource_id,
            "resource_name": resource.resource_name,
            "resource_type": resource.resource_type,
            "normalized_type": resource.normalized_type or type_info.category,
            "type_label": type_info.label,
            "type_icon": type_info.icon,
            "category_label": rm.CATEGORY_LABELS.get(
                resource.normalized_type or type_info.category, "Other"
            ),
            # Stored by the normalizer; computed here for a row written before
            # the column existed, so the table never shows a blank service.
            "service": service_info.key,
            "service_label": service_info.label,
            "region": resource.region_or_zone,
            "availability_zone": resource.availability_zone,
            "resource_group": resource.resource_group,
            "compartment": resource.compartment,
            "environment": resource.environment,
            "owner": resource.owner,
            "ip_address": resource.ip_address,

            # Status carries BOTH readings. The raw value is what the provider
            # said; the normalized one is what we make of it; the reason exists
            # only when we could not make anything of it.
            "status": resource.normalized_status or rm.UNKNOWN,
            "raw_status": resource.status,
            "status_reason": resource.status_reason,
            "attachment_state": resource.attachment_state,
            # The attachment TARGET, not just the state. The table this
            # replaces named the instance a volume is attached to and flagged
            # when that instance was stopped, which is the whole point of the
            # column: a stopped instance with an attached volume is still
            # billing for the volume. `attachment_state` alone answers
            # "attached?" but not "to what?", so dropping this would be a
            # straight loss of working behaviour.
            "attached_to": _attached_to(resource),
            "is_default": bool(resource.is_default),

            "tags": resource.tags or {},
            "tag_count": resource.tag_count or 0,
            "missing_required_tags": rm.missing_required_tags(resource.tags),

            # Cost is an object, not a number, because a number without its
            # currency, window and source cannot be checked by anyone.
            "cost": self._cost_block(row, provider_caps),

            "risk": {
                "level": risk_level,
                "assessed": risk_level != RISK_UNKNOWN,
                "finding_count": int(row.finding_count or 0),
                "severity_counts": severity_counts,
                "reason": (
                    "This account has not completed a security assessment, so "
                    "whether this resource has findings is unknown — not zero."
                    if risk_level == RISK_UNKNOWN else None
                ),
            },

            "freshness": {
                "severity": fresh.severity,
                "observed_at": observed_at.isoformat() if observed_at else None,
                "last_seen_at": (
                    resource.last_seen_at.isoformat() if resource.last_seen_at else None
                ),
                "source": observed_source,
                "age_days": fresh.age_days,
                "label": fresh.label,
                "stale": fresh.stale,
                "note": (
                    None if observed_source == "resource"
                    else "Taken from this account's last successful discovery; "
                         "per-resource observation times begin at the next sweep."
                    if observed_source == "account_discovery"
                    else "This account has never completed a discovery sweep."
                ),
            },
            "discovered_at": resource.discovered_at.isoformat() if resource.discovered_at else None,
            "updated_at": resource.updated_at.isoformat() if resource.updated_at else None,

            # What the detail view will be able to answer for this resource,
            # so the UI can disable a tab instead of opening an empty one.
            "available": {
                "configuration": resource.config is not None,
                "metadata": resource.metadata_ is not None,
                "metrics": provider_caps.can(caps.METRICS),
                "raw_data": provider_caps.can(caps.RAW_DATA),
            },
        }

    def _cost_block(self, row: Any, provider_caps: caps.ProviderResourceCapabilities) -> Dict[str, Any]:
        amount = row.cost_amount
        if amount is not None:
            return {
                "available": True,
                "amount": round(float(amount), 2),
                "currency": row.cost_currency,
                "period_days": int(row.cost_period_days or 30),
                "source": row.cost_source,
                "billed_service": row.cost_service,
                "fetched_at": (
                    row.cost_fetched_at.isoformat() if row.cost_fetched_at else None
                ),
                "reason": None,
            }
        # Two different absences, and they need different words. One is a
        # permanent property of the integration; the other is a gap that may
        # fill in on the next billing query.
        if not provider_caps.can(caps.RESOURCE_COST):
            reason = provider_caps.reason(caps.RESOURCE_COST)
        else:
            reason = (
                "The provider's billing data does not include this resource for "
                "the current window. Resources the provider does not bill "
                "individually — networks, security groups, IAM objects — "
                "legitimately have no cost of their own."
            )
        return {
            "available": False,
            "amount": None,
            "currency": None,
            "period_days": None,
            "source": None,
            "billed_service": None,
            "fetched_at": None,
            "reason": reason,
        }

    # ── Data quality ─────────────────────────────────────────────────────────
    async def data_quality(
        self,
        account_ids: Sequence[uuid.UUID],
        *,
        query: Optional[ResourceQuery] = None,
    ) -> Dict[str, Any]:
        """Coverage figures, each computed from real rows (spec §57/§58).

        Percentages are None when there is nothing to divide by. "0% coverage"
        over zero resources is a statement about an empty set, and rendering it
        as a failing metric would send someone looking for a problem that does
        not exist.
        """
        if not account_ids:
            return {"partial": False, "coverage": {}, "freshness": {}, "accounts": []}

        totals = (await self.db.execute(
            select(
                CloudResource.account_id,
                func.count().label("total"),
                func.count().filter(
                    CloudResource.normalized_status.isnot(None),
                    CloudResource.normalized_status != rm.UNKNOWN,
                ).label("with_status"),
                func.count().filter(CloudResource.tag_count > 0).label("with_tags"),
                func.count().filter(CloudResource.config.isnot(None)).label("with_config"),
                func.max(CloudResource.last_seen_at).label("last_seen"),
            )
            .where(CloudResource.account_id.in_(list(account_ids)))
            .group_by(CloudResource.account_id)
        )).all()

        accounts = {a.id: a for a in await self.accounts.list_all()}
        cost = await normalizer.cost_coverage(self.db, account_ids)

        def observed(account_id, last_seen):
            """Same fallback the row query uses.

            Reading this straight off max(last_seen_at) reported an account
            swept two hours ago as never observed, because per-resource
            observation only starts at the next sweep. The account's own
            last_discovery is a real recorded timestamp and is the right answer
            until then.
            """
            account = accounts.get(account_id)
            return last_seen or (account.last_discovery if account else None)

        per_account: List[Dict[str, Any]] = []
        grand_total = grand_status = grand_tags = grand_config = 0
        for account_id, total, with_status, with_tags, with_config, last_seen in totals:
            account = accounts.get(account_id)
            fresh = rm.freshness(observed(account_id, last_seen))
            grand_total += int(total or 0)
            grand_status += int(with_status or 0)
            grand_tags += int(with_tags or 0)
            grand_config += int(with_config or 0)
            per_account.append({
                "account_id": str(account_id),
                "account_name": account.account_name if account else None,
                "provider": account.provider if account else None,
                "resource_count": int(total or 0),
                "status_coverage": _percent(with_status, total),
                "tag_coverage": _percent(with_tags, total),
                "configuration_coverage": _percent(with_config, total),
                "freshness": {
                    "severity": fresh.severity,
                    "observed_at": (
                        observed(account_id, last_seen).isoformat()
                        if observed(account_id, last_seen) else None
                    ),
                    "last_seen_at": last_seen.isoformat() if last_seen else None,
                    "source": (
                        "resource" if last_seen is not None
                        else "account_discovery" if observed(account_id, last_seen)
                        else None
                    ),
                    "label": fresh.label,
                    "stale": fresh.stale,
                    "age_days": fresh.age_days,
                },
                "last_discovery": (
                    account.last_discovery.isoformat()
                    if account and account.last_discovery else None
                ),
            })

        # Accounts in scope with no rows at all are part of the quality picture,
        # not an omission — an empty account is a finding.
        seen = {row[0] for row in totals}
        for account_id in account_ids:
            if account_id in seen:
                continue
            account = accounts.get(account_id)
            per_account.append({
                "account_id": str(account_id),
                "account_name": account.account_name if account else None,
                "provider": account.provider if account else None,
                "resource_count": 0,
                "status_coverage": None,
                "tag_coverage": None,
                "configuration_coverage": None,
                "freshness": _empty_account_freshness(account),
                "last_discovery": (
                    account.last_discovery.isoformat()
                    if account and account.last_discovery else None
                ),
            })

        stale_accounts = [a for a in per_account if a["freshness"]["stale"]]
        return {
            # "Partial" here means: some part of the picture is missing, and
            # the page must say so rather than presenting itself as complete.
            "partial": bool(stale_accounts) or cost["percent"] not in (None, 100.0),
            "coverage": {
                "status": _percent(grand_status, grand_total),
                "tags": _percent(grand_tags, grand_total),
                "configuration": _percent(grand_config, grand_total),
                "cost": cost["percent"],
                "resources": grand_total,
                "with_status": grand_status,
                "with_tags": grand_tags,
                "with_cost": cost["with_cost"],
                "without_status": max(0, grand_total - grand_status),
            },
            "accounts": sorted(per_account, key=lambda a: -(a["resource_count"] or 0)),
            "stale_accounts": len(stale_accounts),
            "required_tag_keys": rm.required_tag_keys(),
        }

    # ── Export ───────────────────────────────────────────────────────────────
    CSV_COLUMNS: Tuple[Tuple[str, str], ...] = (
        ("provider", "Provider"),
        ("account_name", "Account"),
        ("resource_name", "Resource"),
        ("resource_type", "Type"),
        ("category_label", "Category"),
        ("service_label", "Service"),
        ("provider_resource_id", "Provider Resource ID"),
        ("region", "Region"),
        ("availability_zone", "Availability Zone"),
        ("resource_group", "Resource Group"),
        ("compartment", "Compartment"),
        ("status", "Status"),
        ("raw_status", "Provider Status"),
        ("attachment_state", "Attachment"),
        ("environment", "Environment"),
        ("owner", "Owner"),
        ("ip_address", "IP Address"),
        ("cost_amount", "Cost"),
        ("cost_currency", "Currency"),
        ("cost_period_days", "Cost Period (days)"),
        ("cost_source", "Cost Source"),
        ("risk_level", "Risk"),
        ("finding_count", "Findings"),
        ("critical_count", "Critical Findings"),
        ("high_count", "High Findings"),
        ("tag_count", "Tag Count"),
        ("tags", "Tags"),
        ("freshness_severity", "Freshness"),
        ("last_seen_at", "Last Seen"),
        ("discovered_at", "Discovered"),
        ("updated_at", "Last Changed"),
    )

    async def export_csv(self, account_id: str, **params: Any) -> Tuple[str, Dict[str, Any]]:
        """Exactly the filtered set, with a metadata preamble (spec §55/§56).

        The preamble is not decoration. A CSV of 300 rows from a 1,500-resource
        estate is indistinguishable from a broken export unless it says which
        filters produced it — and someone will eventually read it as the whole
        inventory.
        """
        accounts, is_global = await self.resolve_scope(account_id)
        account_ids = [a.id for a in accounts]
        query = build_query(
            account_ids=account_ids,
            assessed_account_ids=await self.assessed_account_ids(account_ids),
            **params,
        )
        accounts_by_id = {a.id: a for a in accounts}

        total = await self.repo.count(query)
        quality = await self.data_quality(account_ids, query=query)
        generated_at = datetime.now(timezone.utc)

        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        # Two real columns, not one string with a comma in it. csv.writer QUOTES
        # a field containing a comma, so the line stops starting with "#" and
        # every reader that skips comment lines reads the preamble as data.
        for label, value in (
            ("# Generated at", generated_at.isoformat()),
            ("# Scope", "All accounts" if is_global else accounts[0].account_name),
            ("# Providers", "/".join(sorted({a.provider for a in accounts}))),
            ("# Filters", _describe_filters(query)),
            ("# Rows", total),
            ("# Cost coverage",
             f"{quality['coverage']['cost']}% of resources have a known cost; "
             f"a blank cost means not reported, never zero"),
            ("# Stale accounts", quality["stale_accounts"]),
        ):
            writer.writerow([label, value])
        writer.writerow([])
        writer.writerow([label for _, label in self.CSV_COLUMNS])

        rows_written = 0
        async for row in self.repo.iter_all(query):
            record = self._serialize(row, accounts_by_id)
            writer.writerow([_csv_value(record, key) for key, _ in self.CSV_COLUMNS])
            rows_written += 1

        return buffer.getvalue(), {
            "rows": rows_written,
            "total": total,
            "generated_at": generated_at.isoformat(),
        }

    # ── Reference data ───────────────────────────────────────────────────────
    async def reference(self, account_id: str) -> Dict[str, Any]:
        """Vocabularies the UI renders: statuses, categories, risk levels, the
        type registry, sortable fields, groupable fields.

        Served from the backend so the frontend does not keep its own copy to
        drift out of sync — which is exactly how the current table ended up
        with a hardcoded map of 60 resource types that the scanners have since
        outgrown.
        """
        accounts, _ = await self.resolve_scope(account_id)
        return {
            "statuses": [
                {"value": status, "label": status.replace("_", " ").title(),
                 "order": rm.STATUS_SORT_ORDER[status]}
                for status in sorted(rm.NORMALIZED_STATUSES,
                                     key=lambda s: rm.STATUS_SORT_ORDER[s])
            ],
            "categories": [
                {"value": category, "label": rm.CATEGORY_LABELS[category],
                 "icon": rm.CATEGORY_ICONS[category]}
                for category in rm.CATEGORIES
            ],
            "risk_levels": [
                {"value": level,
                 "label": "Not assessed" if level == RISK_UNKNOWN else level.title(),
                 "order": RISK_RANK[level]}
                for level in RISK_LEVELS
            ],
            "freshness_levels": [
                {"value": level, "label": level.replace("_", " ").title()}
                for level in (rm.FRESH, rm.AGING, rm.STALE, rm.CRITICALLY_STALE,
                              rm.NEVER_SEEN)
            ],
            "types": rm.type_registry(),
            "services": svc.catalog(),
            "sort_fields": list(_SORTABLE),
            "group_fields": list(GROUP_FIELDS),
            "facet_dimensions": list(FACET_DIMENSIONS),
            "max_page_size": MAX_PAGE_SIZE,
            "required_tag_keys": rm.required_tag_keys(),
            "capabilities": caps.scope_summary([a.provider for a in accounts]),
        }


# Presented to the UI with a label each, so a sort menu does not have to invent
# wording for a field name.
_SORTABLE: Tuple[Dict[str, str], ...] = (
    {"value": "resource_name", "label": "Name"},
    {"value": "resource_type", "label": "Type"},
    {"value": "normalized_type", "label": "Category"},
    {"value": "service", "label": "Service"},
    {"value": "provider", "label": "Provider"},
    {"value": "account", "label": "Account"},
    {"value": "region", "label": "Region"},
    {"value": "status", "label": "Status"},
    {"value": "cost", "label": "Cost"},
    {"value": "risk", "label": "Risk"},
    {"value": "finding_count", "label": "Finding count"},
    {"value": "tag_count", "label": "Tag count"},
    {"value": "environment", "label": "Environment"},
    {"value": "owner", "label": "Owner"},
    {"value": "last_seen", "label": "Last seen"},
    {"value": "updated_at", "label": "Last changed"},
    {"value": "discovered_at", "label": "First discovered"},
)


def _attached_to(resource: CloudResource) -> Optional[Dict[str, Any]]:
    """What this resource is attached to, when the scanners recorded it.

    None — not an empty object — when there is no attachment recorded, so the
    UI renders "not reported" rather than an attachment to nothing. The keys
    are the ones the OCI, Azure and AWS storage scanners already write; this
    reads them, it does not re-derive them.
    """
    config = resource.config if isinstance(resource.config, dict) else {}
    target_id = config.get("attached_to_id")
    target_name = config.get("attached_to_name")
    if not target_id and not target_name:
        return None
    return {
        "id": target_id,
        "name": target_name,
        # The target's own state, which is what makes an attached volume
        # interesting: attached to something stopped is a cost question.
        "status": config.get("attached_to_status"),
    }


def _empty_account_freshness(account: Optional[CloudAccount]) -> Dict[str, Any]:
    """Freshness for an account holding no resources at all.

    "Never scanned" and "scanned, found nothing" are different problems with
    different fixes, and collapsing them into one empty state sends people
    looking in the wrong place.
    """
    last_discovery = account.last_discovery if account else None
    if last_discovery is None:
        return {
            "severity": rm.NEVER_SEEN, "observed_at": None, "last_seen_at": None,
            "source": None, "label": "Never scanned", "stale": True,
            "age_days": None,
            "note": "Discovery has never run for this account.",
        }
    fresh = rm.freshness(last_discovery)
    return {
        "severity": fresh.severity,
        "observed_at": last_discovery.isoformat(),
        "last_seen_at": None,
        "source": "account_discovery",
        "label": fresh.label,
        "stale": fresh.stale,
        "age_days": fresh.age_days,
        "note": "Discovery ran but returned no resources for this account.",
    }


def _page_count(total: int, page_size: int) -> int:
    if page_size <= 0:
        return 0
    return (total + page_size - 1) // page_size


def _percent(numerator: Any, denominator: Any) -> Optional[float]:
    total = int(denominator or 0)
    if total <= 0:
        return None
    return round(int(numerator or 0) * 100.0 / total, 1)


def _describe_filters(query: ResourceQuery) -> str:
    parts: List[str] = []
    if query.q:
        parts.append(f"search={query.q}")
    for name, values in (
        ("provider", query.providers), ("type", query.types),
        ("category", query.categories), ("service", query.services),
        ("region", query.regions),
        ("status", query.statuses), ("risk", query.risk),
        ("environment", query.environments), ("owner", query.owners),
    ):
        if values:
            parts.append(f"{name}={'|'.join(values)}")
    if query.attachment:
        parts.append(f"attachment={query.attachment}")
    if query.tagged is not None:
        parts.append(f"tagged={str(query.tagged).lower()}")
    if query.has_cost is not None:
        parts.append(f"has_cost={str(query.has_cost).lower()}")
    if query.cost_min is not None:
        parts.append(f"cost>={query.cost_min}")
    if query.cost_max is not None:
        parts.append(f"cost<={query.cost_max}")
    if query.stale is not None:
        parts.append(f"stale={str(query.stale).lower()}")
    if not query.include_defaults:
        parts.append("hide_defaults")
    return "; ".join(parts) if parts else "none"


def _csv_value(record: Dict[str, Any], key: str) -> Any:
    """Blank means not reported. It is never filled with 0 or 'Unknown'."""
    if key == "cost_amount":
        return record["cost"]["amount"] if record["cost"]["available"] else ""
    if key == "cost_currency":
        return record["cost"]["currency"] or ""
    if key == "cost_period_days":
        return record["cost"]["period_days"] or ""
    if key == "cost_source":
        return record["cost"]["source"] or ""
    if key == "risk_level":
        # "Not assessed" rather than a blank: the difference between "clean"
        # and "unchecked" must survive the trip into a spreadsheet.
        return "Not assessed" if record["risk"]["level"] == RISK_UNKNOWN else record["risk"]["level"]
    if key == "finding_count":
        return record["risk"]["finding_count"] if record["risk"]["assessed"] else ""
    if key == "critical_count":
        return record["risk"]["severity_counts"].get("critical", 0) if record["risk"]["assessed"] else ""
    if key == "high_count":
        return record["risk"]["severity_counts"].get("high", 0) if record["risk"]["assessed"] else ""
    if key == "tags":
        return "; ".join(f"{k}={v}" for k, v in sorted((record.get("tags") or {}).items()))
    if key == "freshness_severity":
        return record["freshness"]["severity"]
    if key == "last_seen_at":
        return record["freshness"]["last_seen_at"] or ""
    value = record.get(key)
    return "" if value is None else value
