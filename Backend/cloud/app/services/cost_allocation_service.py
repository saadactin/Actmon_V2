"""Cost allocation, tag coverage, governance and the FinOps health score.

**Allocation requires per-resource cost, and that is a hard boundary.**

A tag lives on a resource, so attributing spend to a tag means knowing what
each resource cost. OCI and Azure report cost per resource ID; AWS, through
Cost Explorer, does not — it reports per service and usage type only. So an
AWS account cannot be allocated by tag through this path at all, and this
module says so explicitly rather than returning an empty breakdown that reads
as "nothing is tagged".

**Untagged spend is never assigned.** It goes to an `unallocated` bucket that
is reported as prominently as the allocated portion. Inferring an owner from a
resource name, a naming convention or a neighbouring resource is exactly the
kind of guess that makes a chargeback report unusable the first time somebody
checks it.

**The FinOps health score is not a cost.** It measures how well this estate is
*managed* — tagging, coverage, budgets, monitoring — and is deliberately kept
apart from spend so a cheap, ungoverned account cannot look healthy and an
expensive, well-run one cannot look sick.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

logger = logging.getLogger("cloud_svc.cost.allocation")

# The business dimensions worth allocating by, and the tag keys commonly used
# for each. Matching is case-insensitive on the key only — a VALUE is never
# normalized, because "Prod" and "production" may genuinely be different teams'
# conventions and silently merging them invents an allocation nobody made.
DIMENSIONS: Dict[str, Sequence[str]] = {
    "owner": ("owner", "Owner", "owned_by", "contact"),
    "environment": ("environment", "env", "Environment", "stage", "tier"),
    "application": ("application", "app", "Application", "service_name"),
    "project": ("project", "Project", "product"),
    "department": ("department", "Department", "dept", "division"),
    "cost_center": ("cost_center", "costcenter", "cost-center", "CostCenter", "billing_code"),
    "team": ("team", "Team", "squad", "group"),
    "business_unit": ("business_unit", "businessunit", "bu", "BusinessUnit"),
}

UNALLOCATED = "Unallocated"


def _tag_value(tags: Optional[Dict[str, Any]], candidates: Sequence[str]) -> Optional[str]:
    """The first matching tag value, matched case-insensitively on the key.

    Returns None when no candidate key is present OR the value is blank — an
    empty tag is not an allocation, and treating `owner=""` as an owner would
    create a phantom cost centre called "".
    """
    if not tags:
        return None
    lowered = {str(k).strip().lower(): v for k, v in tags.items() if k is not None}
    for candidate in candidates:
        value = lowered.get(candidate.strip().lower())
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


def allocate(
    resources: Sequence[Any],
    cost_map: Dict[str, Dict[str, Any]],
    *,
    dimension: str = "environment",
) -> Dict[str, Any]:
    """Attribute per-resource spend to one business dimension.

    `cost_map` is keyed by provider resource ID (what
    `fetch_real_costs_by_resource` returns). Resources with no cost entry
    contribute nothing — their spend is unknown, not zero — and are counted
    separately from resources that cost money but carry no tag.
    """
    candidates = DIMENSIONS.get(dimension)
    if candidates is None:
        raise ValueError(
            f"Unknown allocation dimension {dimension!r}. "
            f"Known: {', '.join(sorted(DIMENSIONS))}"
        )

    by_value: Dict[str, Dict[str, Any]] = {}
    unallocated: Dict[str, float] = {}
    unallocated_resources = 0
    priced_resources = 0
    unpriced_resources = 0

    lookup = {}
    for pid, entry in cost_map.items():
        lookup[pid] = entry
        lookup.setdefault(str(pid).lower(), entry)

    for resource in resources:
        pid = getattr(resource, "provider_resource_id", None)
        entry = lookup.get(pid) or lookup.get(str(pid).lower()) if pid else None
        if not entry:
            unpriced_resources += 1
            continue

        amount = entry.get("monthly_cost")
        currency = entry.get("currency") or "UNKNOWN"
        if amount is None:
            unpriced_resources += 1
            continue
        priced_resources += 1

        value = _tag_value(getattr(resource, "tags", None), candidates)
        if value is None:
            unallocated[currency] = round(unallocated.get(currency, 0.0) + float(amount), 4)
            unallocated_resources += 1
            continue

        bucket = by_value.setdefault(value, {"value": value, "by_currency": {},
                                             "resource_count": 0})
        bucket["by_currency"][currency] = round(
            bucket["by_currency"].get(currency, 0.0) + float(amount), 4
        )
        bucket["resource_count"] += 1

    allocated_total: Dict[str, float] = {}
    for bucket in by_value.values():
        for code, value in bucket["by_currency"].items():
            allocated_total[code] = round(allocated_total.get(code, 0.0) + value, 4)

    # Coverage is money-weighted, not resource-weighted: 90% of resources
    # tagged means little if the untagged 10% is where the spend is.
    coverage: Dict[str, Optional[float]] = {}
    for code in set(allocated_total) | set(unallocated):
        total = allocated_total.get(code, 0.0) + unallocated.get(code, 0.0)
        coverage[code] = round(allocated_total.get(code, 0.0) / total * 100, 2) if total else None

    return {
        "dimension": dimension,
        "tag_keys_considered": list(candidates),
        "allocated": sorted(by_value.values(),
                            key=lambda b: -max(b["by_currency"].values() or [0])),
        "allocated_total_by_currency": allocated_total,
        "unallocated_by_currency": unallocated,
        "unallocated_resource_count": unallocated_resources,
        "priced_resource_count": priced_resources,
        # Resources the billing API did not price. NOT counted as unallocated:
        # we do not know what they cost, which is different from knowing they
        # cost something and not knowing whose it is.
        "unpriced_resource_count": unpriced_resources,
        "coverage_percent_by_currency": coverage,
        "coverage_basis": (
            "Coverage is money-weighted: allocated spend divided by allocated + "
            "unallocated spend, per currency. Resources the billing API did not "
            "price are excluded from both, because their cost is unknown rather "
            "than unattributed."
        ),
    }


def tag_coverage(resources: Sequence[Any]) -> Dict[str, Any]:
    """What fraction of resources carry each business tag.

    Resource-weighted, unlike `allocate`'s money-weighted coverage, and labelled
    as such — the two answer different questions and reporting one as the other
    would overstate governance on an estate whose expensive resources are the
    tagged ones.
    """
    total = len(resources)
    per_dimension: Dict[str, Dict[str, Any]] = {}

    for dimension, candidates in DIMENSIONS.items():
        tagged = sum(
            1 for r in resources
            if _tag_value(getattr(r, "tags", None), candidates) is not None
        )
        per_dimension[dimension] = {
            "tagged": tagged,
            "untagged": total - tagged,
            "coverage_percent": round(tagged / total * 100, 2) if total else None,
        }

    any_tag = sum(
        1 for r in resources
        if any(_tag_value(getattr(r, "tags", None), c) is not None
               for c in DIMENSIONS.values())
    )
    return {
        "total_resources": total,
        "resources_with_any_business_tag": any_tag,
        "overall_coverage_percent": round(any_tag / total * 100, 2) if total else None,
        "by_dimension": per_dimension,
        "basis": (
            "Resource-weighted: the share of discovered resources carrying a "
            "recognised tag key for each dimension. This is NOT the same as the "
            "money-weighted coverage on the allocation view, which is the one "
            "that matters for chargeback."
        ),
    }


def governance_findings(
    resources: Sequence[Any],
    known_services: Optional[Iterable[str]] = None,
    observed_services: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Governance gaps, kept strictly apart from billed values (133).

    Nothing here is a cost figure. These are statements about how the estate is
    managed, and mixing them into a spend total is how a governance dashboard
    starts being read as an invoice.
    """
    missing_owner = [
        {"resource_name": getattr(r, "resource_name", None),
         "resource_type": getattr(r, "resource_type", None),
         "provider_resource_id": getattr(r, "provider_resource_id", None)}
        for r in resources
        if _tag_value(getattr(r, "tags", None), DIMENSIONS["owner"]) is None
    ]
    missing_env = [
        {"resource_name": getattr(r, "resource_name", None),
         "resource_type": getattr(r, "resource_type", None)}
        for r in resources
        if _tag_value(getattr(r, "tags", None), DIMENSIONS["environment"]) is None
    ]

    known = {str(s).strip().lower() for s in (known_services or []) if s}
    new_services = sorted({
        str(s) for s in (observed_services or [])
        if s and str(s).strip().lower() not in known
    }) if known else []

    return {
        "missing_owner_tag": {
            "count": len(missing_owner),
            "sample": missing_owner[:25],
        },
        "missing_environment_tag": {
            "count": len(missing_env),
            "sample": missing_env[:25],
        },
        # A service billed now that was not billed in the comparison window.
        # Reported as "newly observed", not "unexpected" — a new service is
        # usually a deployment, and calling it unexpected cries wolf.
        "newly_observed_services": new_services,
        "note": (
            "These are governance observations, not billed amounts. No figure "
            "here is spend."
        ),
    }


# ── FinOps health score (137) ─────────────────────────────────────────────────
# Deliberately separate from spend. Each component is 0-100 and the score is
# their mean, so the formula can be read off the output rather than reverse
# engineered. A component whose inputs do not exist is EXCLUDED from the mean
# rather than scored zero — penalising an estate for a capability the provider
# does not expose would make the score a measure of which cloud you chose.
HEALTH_FORMULA = (
    "FinOps health is the unweighted mean of the available components below, "
    "each scored 0-100. A component with no data is excluded from the mean "
    "rather than scored zero. The score measures how the estate is MANAGED and "
    "is deliberately independent of how much it costs."
)


def finops_health(
    *,
    tag_coverage_percent: Optional[float],
    allocation_coverage_percent: Optional[float],
    days_of_history: int,
    budget_count: int,
    accounts_in_scope: int,
    anomaly_monitoring_ready: bool,
    unpriced_resource_ratio: Optional[float] = None,
) -> Dict[str, Any]:
    components: Dict[str, Optional[float]] = {}

    components["tagging"] = tag_coverage_percent
    components["allocation"] = allocation_coverage_percent

    # 365 days of stored history is full marks; below that, proportional.
    components["data_coverage"] = (
        round(min(100.0, days_of_history / 365 * 100), 2) if days_of_history else 0.0
    )
    # One budget per account in scope is full marks.
    components["budget_coverage"] = (
        round(min(100.0, budget_count / accounts_in_scope * 100), 2)
        if accounts_in_scope else None
    )
    components["anomaly_monitoring"] = 100.0 if anomaly_monitoring_ready else 0.0
    components["resource_attribution"] = (
        round((1 - unpriced_resource_ratio) * 100, 2)
        if unpriced_resource_ratio is not None else None
    )

    scored = {k: v for k, v in components.items() if v is not None}
    score = round(sum(scored.values()) / len(scored), 1) if scored else None

    return {
        "score": score,
        "components": components,
        "excluded_components": sorted(k for k, v in components.items() if v is None),
        "formula": HEALTH_FORMULA,
        "warning": (
            "This is a FinOps maturity measure, not a cost. A low score does not "
            "mean the estate is expensive, and a high score does not mean it is "
            "cheap."
        ),
    }
