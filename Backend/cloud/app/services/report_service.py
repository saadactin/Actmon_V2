"""Resource assessment report builder: scope resolution + dataset assembly.

This is the generalization of `resource_assessment_service.py` (which still
exists and still backs the simpler "Export Assessment" button) into a real
report pipeline with section toggles, three scope modes, and a date range.
It does not re-implement Security, Utilization, Performance or cost-anomaly
detection — it calls the same per-resource row builders that module already
has, just conditionally, so a disabled section never even queries its table.

**What each section actually is, honestly stated:**

  Executive summary -- arithmetic over the rows this request already built
                        (counts by category/severity). No new query.
  Inventory          -- a snapshot of `cloud_resources` as of now. NOT a
                        historical view -- the date range does not apply to
                        it, and `build_report_dataset` says so in its output
                        rather than pretending otherwise.
  Security           -- CloudSecurityFinding, via resource_assessment_service.
  Utilization        -- CloudResourceTelemetry, via resource_assessment_service.
                        Its window is whatever `optimization.collector` keeps,
                        not the report's own date range -- the telemetry
                        store does not support an arbitrary custom window, so
                        asking for one would silently do nothing. Disclosed
                        in the dataset's `data_quality.notes`, not hidden.
  Performance        -- the PERFORMANCE/CONSTRAINED slice of the same
                        optimization findings used for Utilization.
  Recommendations    -- the remaining optimization findings (COST, STORAGE,
                        NETWORK, DATABASE, RELIABILITY, ...) -- i.e. advisory
                        findings, kept separate from Security/Utilization/
                        Performance's observed-defect rows.
  Anomalies          -- there is no per-resource anomaly engine in this
                        product (see resource_assessment_service's own
                        docstring). This section reuses its account-wide
                        cost-spend anomaly detection, labelled as account-
                        wide, never presented as resource-specific.
  Cost               -- `CloudResource.cost_monthly`, a stored actual value,
                        never an estimate. `None` means "not available", not
                        zero.
  Data quality       -- derived from the "Unavailable"/"No data"/"Not
                        checked" rows already produced above, plus the date
                        range disclosure for Utilization noted above.
"""
from __future__ import annotations

import uuid
from typing import Any, Dict, List, Tuple

from sqlalchemy.ext.asyncio import AsyncSession

from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.resource_repo import ResourceRepository
from app.schemas.reports import (
    SCOPE_ACCOUNT, SCOPE_FILTERED, SCOPE_RESOURCES,
    ReportDateRange, ReportScope, ReportSections,
)
from app.services import resource_assessment_service as ras
from app.services.resource_assessment_service import TooManyResourcesError

REPORT_MAX_RESOURCES = 1000

_UTILIZATION_NOTE = (
    "Utilization reflects the telemetry store's own retention window, not "
    "this report's date range -- a custom window for utilization is not "
    "supported by the collected data."
)
_INVENTORY_NOTE = (
    "Resource inventory is a snapshot taken at generation time, not a "
    "historical view for the selected date range."
)


async def resolve_report_scope(
    db: AsyncSession, account_id: uuid.UUID, scope: ReportScope,
) -> Tuple[List[uuid.UUID], int]:
    """(resource_ids, total_matching). Raises TooManyResourcesError rather
    than silently truncating -- the caller must narrow the scope."""
    if scope.mode == SCOPE_RESOURCES:
        ids = list(dict.fromkeys(scope.resource_ids))
        if len(ids) > REPORT_MAX_RESOURCES:
            raise TooManyResourcesError(len(ids))
        return ids, len(ids)

    from app.repository.resource_query_repo import build_query
    from app.services.resource_query_service import ResourceQueryService

    svc = ResourceQueryService(db)
    accounts, _is_global = await svc.resolve_scope(str(account_id))
    account_ids = [a.id for a in accounts]
    params: Dict[str, Any] = dict(scope.filters) if scope.mode == SCOPE_FILTERED else {}
    # `ResourceQueryService.query()` always paginates (DEFAULT_PAGE_SIZE=50,
    # capped at MAX_PAGE_SIZE=250) -- it is built for the on-screen page, not
    # "every matching row". `export_csv` reaches for `repo.iter_all(query)`
    # instead for exactly that reason, so the report does the same rather
    # than silently capping "whole account" scope at 50 resources.
    query = build_query(
        account_ids=account_ids,
        assessed_account_ids=await svc.assessed_account_ids(account_ids),
        **params,
    )
    total = await svc.repo.count(query)
    if total > REPORT_MAX_RESOURCES:
        raise TooManyResourcesError(total)
    ids = [row[0].id async for row in svc.repo.iter_all(query)]
    return ids, total


def _inventory_row(resource) -> Dict[str, Any]:
    return {
        "resource_name": resource.resource_name,
        "provider_resource_id": resource.provider_resource_id,
        "resource_type": resource.resource_type,
        "region": resource.region_or_zone,
        "status": resource.normalized_status or resource.status,
        "environment": resource.environment,
        "owner": resource.owner,
        "resource_group": resource.resource_group,
        "compartment": resource.compartment,
        "tags": resource.tags or {},
        "discovered_at": ras._iso(resource.discovered_at),
        "last_seen_at": ras._iso(resource.last_seen_at),
    }


def _cost_row(resource) -> Dict[str, Any]:
    if resource.cost_monthly is None:
        return {
            "resource_name": resource.resource_name,
            "provider_resource_id": resource.provider_resource_id,
            "cost_monthly": None,
            "status": "Not available",
        }
    return {
        "resource_name": resource.resource_name,
        "provider_resource_id": resource.provider_resource_id,
        "cost_monthly": float(resource.cost_monthly),
        "status": "Actual (stored billing fact)",
    }


async def build_report_dataset(
    db: AsyncSession,
    account_id: uuid.UUID,
    resource_ids: List[uuid.UUID],
    sections: ReportSections,
    date_range: ReportDateRange,
) -> Dict[str, Any]:
    """The single normalized dataset every renderer (CSV/JSON/PDF/XLSX)
    consumes. Only queries what `sections` actually asks for."""
    account = await CloudAccountRepository(db).get_by_id(account_id)
    account_name = account.account_name if account else str(account_id)
    provider = account.provider if account else "Unknown"

    resource_repo = ResourceRepository(db)
    resources = []
    missing_ids: List[uuid.UUID] = []
    for rid in resource_ids:
        resource = await resource_repo.get_by_id(rid)
        if resource is None or resource.account_id != account_id:
            missing_ids.append(rid)
        else:
            resources.append(resource)

    out: Dict[str, Any] = {
        "schema_version": 1,
        "account": {"id": str(account_id), "name": account_name, "provider": provider},
        "resources_requested": len(resource_ids),
        "resources_resolved": len(resources),
        "resources_missing": [str(i) for i in missing_ids],
        "sections": {},
        "notes": [],
    }

    inventory_rows = [_inventory_row(r) for r in resources] if sections.inventory else []
    if sections.inventory:
        out["sections"]["inventory"] = inventory_rows
        out["notes"].append(_INVENTORY_NOTE)

    security_rows: List[Dict[str, Any]] = []
    utilization_rows: List[Dict[str, Any]] = []
    performance_rows: List[Dict[str, Any]] = []
    recommendation_rows: List[Dict[str, Any]] = []
    cost_rows: List[Dict[str, Any]] = []

    need_optimization = sections.utilization or sections.performance or sections.recommendations
    for resource in resources:
        base = ras._base_row(resource, account_name, provider)
        if sections.security:
            security_rows.extend(await ras._security_rows(db, account_id, resource, base))
        if need_optimization:
            opt_rows = await ras._optimization_rows(db, account_id, resource, base)
            for row in opt_rows:
                cat = row.get("assessment_category")
                if cat == ras.CATEGORY_UTILIZATION and sections.utilization:
                    utilization_rows.append(row)
                elif cat == ras.CATEGORY_PERFORMANCE and sections.performance:
                    performance_rows.append(row)
                elif cat == ras.CATEGORY_OTHER_OPT and sections.recommendations:
                    recommendation_rows.append(row)
        if sections.utilization:
            utilization_rows.extend(await ras._utilization_telemetry_rows(db, resource, base))
        if sections.cost:
            cost_rows.append({**base, **_cost_row(resource)})

    if sections.security:
        out["sections"]["security"] = security_rows
    if sections.utilization:
        out["sections"]["utilization"] = utilization_rows
        out["notes"].append(_UTILIZATION_NOTE)
    if sections.performance:
        out["sections"]["performance"] = performance_rows
    if sections.recommendations:
        out["sections"]["recommendations"] = recommendation_rows
    if sections.cost:
        out["sections"]["cost"] = cost_rows
    if sections.anomalies:
        out["sections"]["anomalies"] = await ras._account_anomaly_rows(db, account_id)

    if sections.executive_summary:
        out["sections"]["executive_summary"] = _executive_summary(out)
    if sections.data_quality:
        out["sections"]["data_quality"] = _data_quality(out, missing_ids)

    return out


_NA_TITLES = {"Unavailable", "No findings", "No data", "Not checked", "No anomalies"}


def _executive_summary(dataset: Dict[str, Any]) -> Dict[str, Any]:
    sec_rows = dataset["sections"].get("security", [])
    by_severity: Dict[str, int] = {}
    for row in sec_rows:
        sev = row.get("severity")
        if sev and row.get("title") not in _NA_TITLES:
            by_severity[sev] = by_severity.get(sev, 0) + 1
    return {
        "resources_in_scope": dataset["resources_resolved"],
        "security_findings_by_severity": by_severity,
        "critical_or_high": by_severity.get("CRITICAL", 0) + by_severity.get("HIGH", 0),
        "sections_included": sorted(dataset["sections"].keys()),
    }


def _data_quality(dataset: Dict[str, Any], missing_ids: List[uuid.UUID]) -> Dict[str, Any]:
    counts = {"available": 0, "unavailable": 0, "no_data": 0}
    for section_name, rows in dataset["sections"].items():
        if section_name in ("executive_summary", "data_quality") or not isinstance(rows, list):
            continue
        for row in rows:
            title = row.get("title") if isinstance(row, dict) else None
            if title == "Unavailable":
                counts["unavailable"] += 1
            elif title in _NA_TITLES:
                counts["no_data"] += 1
            elif title is not None:
                counts["available"] += 1
    return {
        **counts,
        "resources_not_found": len(missing_ids),
        "notes": list(dataset.get("notes", [])),
    }
