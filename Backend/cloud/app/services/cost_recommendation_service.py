"""Turn the rule engine's findings into structured, rankable recommendations.

The rules themselves stay in `cost_service` where they already read real
provider configuration and price real savings from OCI's public Price List
API. This module does not re-derive them and does not invent new ones. It adds
the four things a raw finding lacks:

1.  **Category and actionability.** Why it matters, what to change, what the
    risk is, how to do it. A finding that says "this is idle" without saying
    what to do about it is an observation, not a recommendation.
2.  **Confidence, graded on evidence.** HIGH only where the provider's own data
    proves the condition (a stopped instance with billed storage attached).
    LOW where the answer depends on workload behaviour we cannot see.
3.  **A priority score with a published formula.** Sorting by severity alone
    puts a CRITICAL finding worth nothing above a MEDIUM one worth thousands.
4.  **Lifecycle.** A human decision, joined back by fingerprint so it survives
    re-derivation.

**Utilization is never inferred.** Several of these rules detect a *state*
(stopped, zero node pools, no backend sets) which the provider reports as fact.
None of them observe CPU, memory or request rates, because this product does
not collect them. So every recommendation reports `utilization: not_available`
rather than implying a resource is idle in the usage sense — the distinction
section 41 insists on.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

from app.models.cost_recommendation import (
    CLOSED_STATES, STATE_NEW, recommendation_fingerprint,
)

logger = logging.getLogger("cloud_svc.cost.reco")

# ── Categories (36) ───────────────────────────────────────────────────────────
STOPPED_RESOURCES = "Stopped resources"
IDLE_RESOURCES = "Idle resources"
RIGHTSIZING = "Rightsizing"
STORAGE_OPT = "Storage optimization"
DATABASE_OPT = "Database optimization"
LIFECYCLE = "Lifecycle policies"
ARCHITECTURE = "Architecture optimization"
GOVERNANCE = "Tagging/allocation"

# ── Confidence (38) ───────────────────────────────────────────────────────────
HIGH, MEDIUM, LOW = "HIGH", "MEDIUM", "LOW"

# Per-rule metadata. Keyed on the `rule` string the engine already emits, so
# adding a rule there without describing it here degrades to a safe default
# rather than crashing — but it is reported by `unclassified_rules()` so the
# gap is visible instead of silent.
#
# `confidence` is graded on what the provider actually proves:
#   HIGH   - the provider reports the state AND the billing consequence is
#            certain (a stopped instance's volumes keep billing).
#   MEDIUM - the state is certain but the saving depends on a choice
#            (is this non-prod database really allowed to lose Multi-AZ?).
#   LOW    - the benefit depends on workload behaviour we do not measure.
RULES: Dict[str, Dict[str, Any]] = {
    # ── AWS ──────────────────────────────────────────────────────────────────
    "Terminate Stopped EC2 Instance": {
        "category": STOPPED_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": HIGH,
        "why": "The instance is stopped, so it bills no compute — but its EBS volumes keep billing for as long as they exist.",
        "action": "If the instance is no longer needed, snapshot its volumes and terminate it.",
        "impact": "Ends the ongoing EBS storage charge for its attached volumes.",
        "risk_note": "Terminating destroys the instance and, unless preserved, its volumes. Take a snapshot first.",
        "how": "EC2 console -> Instances -> select -> Instance state -> Terminate, after creating snapshots of each attached volume.",
    },
    "Upgrade Legacy EC2 Generation": {
        "category": RIGHTSIZING, "confidence": LOW,
        "effort": MEDIUM, "risk": MEDIUM,
        "why": "The instance runs a previous-generation type. Current generations generally offer better price/performance for the same workload.",
        "action": "Migrate the instance to the current-generation equivalent of its type.",
        "impact": "Typically a lower hourly rate for equivalent capacity. The actual difference depends on the specific types and region and is not priced here.",
        "risk_note": "Requires a stop/start and may need an AMI or driver change. Verify application compatibility first.",
        "how": "Stop the instance, change the instance type, start it, then verify the workload.",
    },
    "Enable S3 Bucket Versioning": {
        "category": GOVERNANCE, "confidence": HIGH,
        "effort": LOW, "risk": LOW,
        "why": "Versioning is disabled, so an accidental overwrite or delete is unrecoverable.",
        "action": "Enable bucket versioning.",
        "impact": "Protects against accidental loss. Note this INCREASES storage cost — it is a durability recommendation, not a saving.",
        "risk_note": "Versioning retains old object versions, which adds storage cost until a lifecycle rule expires them.",
        "how": "S3 console -> bucket -> Properties -> Bucket Versioning -> Enable.",
    },
    "Missing S3 Lifecycle Policies": {
        "category": LIFECYCLE, "confidence": MEDIUM,
        "effort": LOW, "risk": MEDIUM,
        "why": "The bucket has no lifecycle rules, so objects stay in their original storage class indefinitely regardless of age.",
        "action": "Add a lifecycle rule transitioning older objects to a cheaper class, or expiring them.",
        "impact": "Reduces storage cost for data that is no longer accessed. The size of the saving depends on the object age distribution, which is not measured here.",
        "risk_note": "Transitioned objects have retrieval costs and minimum storage durations; expiry is irreversible.",
        "how": "S3 console -> bucket -> Management -> Lifecycle rules -> Create rule.",
    },
    "Convert DynamoDB to On-Demand Billing": {
        "category": DATABASE_OPT, "confidence": MEDIUM,
        "effort": LOW, "risk": LOW,
        "why": "The table uses provisioned throughput but holds very few items, so it is likely paying for capacity it does not use.",
        "action": "Switch the table's billing mode to PAY_PER_REQUEST.",
        "impact": "On-demand usually costs less for low or bursty traffic. Actual savings depend on the request pattern, which is not measured here.",
        "risk_note": "On-demand can cost more under sustained high traffic. AWS limits how often billing mode may be changed.",
        "how": "DynamoDB console -> table -> Additional settings -> Read/write capacity -> On-demand.",
    },
    "Review Lambda Memory Size": {
        "category": RIGHTSIZING, "confidence": LOW,
        "effort": MEDIUM, "risk": MEDIUM,
        "why": "The function is configured with a large memory allocation, and Lambda bills on memory x duration.",
        "action": "Profile the function and reduce its memory to the smallest size that meets its latency target.",
        "impact": "Lower per-invocation cost. Cannot be quantified without invocation and duration metrics, which are not collected.",
        "risk_note": "Lambda scales CPU with memory, so reducing memory can increase duration and may cost MORE. Measure before and after.",
        "how": "Lambda console -> function -> Configuration -> General configuration -> Memory.",
    },
    "Upgrade Deprecated Runtime": {
        "category": ARCHITECTURE, "confidence": HIGH,
        "effort": HIGH, "risk": MEDIUM,
        "why": "The runtime no longer receives security patches and AWS will eventually block invocations on it.",
        "action": "Upgrade the function to a supported runtime.",
        "impact": "This is a security and continuity fix, not a cost saving.",
        "risk_note": "Requires code changes and testing against the newer runtime.",
        "how": "Update the deployment package for the target runtime, then change the runtime in the function configuration.",
    },
    "Review Stopped RDS Database": {
        "category": STOPPED_RESOURCES, "confidence": HIGH,
        "effort": MEDIUM, "risk": HIGH,
        "why": "The instance is stopped, so it bills no instance hours — but its provisioned storage continues to bill, and RDS restarts a stopped instance automatically after 7 days.",
        "action": "Take a final snapshot and delete the instance if it is no longer needed.",
        "impact": "Ends the provisioned-storage charge, and prevents the automatic restart re-starting instance billing.",
        "risk_note": "Deleting removes the database. The final snapshot is what makes this recoverable — verify it completes before deleting.",
        "how": "RDS console -> database -> Actions -> Delete, with 'create final snapshot' selected.",
    },
    "Disable Multi-AZ on Non-Prod RDS": {
        "category": DATABASE_OPT, "confidence": MEDIUM,
        "effort": LOW, "risk": MEDIUM,
        "why": "Multi-AZ roughly doubles instance and storage charges, and this database carries no production tag.",
        "action": "Convert the instance to Single-AZ if high availability is not required for it.",
        "impact": "Approximately halves the instance and storage charge for this database.",
        "risk_note": "Removes automatic failover. Confirm the environment really is non-production — the tag may simply be missing.",
        "how": "RDS console -> database -> Modify -> Multi-AZ deployment -> No.",
    },
    "Review EKS Control Plane Utilization": {
        "category": IDLE_RESOURCES, "confidence": MEDIUM,
        "effort": HIGH, "risk": HIGH,
        "why": "EKS bills a flat hourly control-plane charge per cluster regardless of how much workload runs on it.",
        "action": "Delete the cluster if it was left over from testing; use a local tool such as kind or minikube for development.",
        "impact": "Ends the per-cluster control-plane charge.",
        "risk_note": "Deleting a cluster destroys everything running on it.",
        "how": "Confirm no workloads depend on it, then delete the cluster and its node groups.",
    },
    # ── OCI ──────────────────────────────────────────────────────────────────
    "Stopped OCI Compute Instance": {
        "category": STOPPED_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": HIGH,
        "why": "A stopped instance is not billed for OCPUs or memory, but its boot volume and any attached block volumes keep billing until they are deleted.",
        "action": "If the instance is no longer needed, back it up and terminate it together with its volumes.",
        "impact": "Ends the block and boot volume storage charge. The figure shown is priced from OCI's public list rates.",
        "risk_note": "Terminating permanently deletes the boot volume. Attached block volumes are only deleted if explicitly selected.",
        "how": "OCI console -> Compute -> Instances -> select -> Terminate, ticking 'permanently delete the attached boot volume' once a backup exists.",
    },
    "Stopped Autonomous Database": {
        "category": STOPPED_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": HIGH,
        "why": "A stopped Autonomous Database stops CPU billing but continues to bill its provisioned storage until the database is terminated.",
        "action": "Take a manual backup and terminate the database if it is no longer needed.",
        "impact": "Ends the provisioned storage charge, priced from OCI's public list rates.",
        "risk_note": "Termination is irreversible. Automatic backups are removed with the database — take a manual backup first.",
        "how": "OCI console -> Autonomous Database -> select -> More actions -> Terminate, after creating a manual backup.",
    },
    "Enable Autonomous Database Auto-Scaling": {
        "category": DATABASE_OPT, "confidence": LOW,
        "effort": LOW, "risk": LOW,
        "why": "Auto-scaling is disabled, so the database always bills its full base ECPU/OCPU count even when idle.",
        "action": "Enable auto-scaling, and only then consider lowering the base CPU count.",
        "impact": "No fixed saving. Auto-scaling adds burst capacity and can RAISE cost at peak; the saving only materialises if the base count is subsequently reduced, which needs usage metrics this product does not collect.",
        "risk_note": "Enabling auto-scaling alone may increase spend. Reducing base capacity may affect performance.",
        "how": "OCI console -> Autonomous Database -> Manage scaling -> enable auto-scaling.",
    },
    "Idle OKE Cluster (No Node Pools)": {
        "category": IDLE_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": MEDIUM,
        "why": "The cluster has no node pools, so it runs no workloads, yet can still incur cluster management charges.",
        "action": "Delete the cluster if it was left over from testing.",
        "impact": "Ends any cluster management charge.",
        "risk_note": "Deleting the cluster removes its configuration. With no node pools there are no running workloads to lose.",
        "how": "OCI console -> Kubernetes Clusters -> select -> Delete.",
    },
    "Idle OCI Load Balancer (No Backend Sets)": {
        "category": IDLE_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": MEDIUM,
        "why": "The load balancer has no backend sets, so it can serve no traffic, but it bills per hour for its provisioned shape regardless.",
        "action": "Delete the load balancer if it is unused.",
        "impact": "Ends the hourly shape charge.",
        "risk_note": "Its IP address is released and cannot be reclaimed. Confirm no DNS record still points at it.",
        "how": "OCI console -> Load Balancers -> select -> Delete.",
    },
    "Idle OCI API Gateway (No Deployments)": {
        "category": IDLE_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": MEDIUM,
        "why": "The gateway has no deployments, so it routes no APIs, but is billed while it exists.",
        "action": "Delete the gateway if it is no longer used.",
        "impact": "Ends the gateway charge.",
        "risk_note": "Its hostname is released. Confirm no client still targets it.",
        "how": "OCI console -> API Management -> Gateways -> select -> Delete.",
    },
    # ── Azure ────────────────────────────────────────────────────────────────
    "Idle AKS Cluster (No Nodes)": {
        "category": IDLE_RESOURCES, "confidence": HIGH,
        "effort": LOW, "risk": MEDIUM,
        "why": "The cluster has zero nodes across its node pools, so it runs no workloads, but can still incur control-plane or management charges depending on its tier.",
        "action": "Delete the cluster if it was left over from testing.",
        "impact": "Ends any control-plane charge. On the Free tier this may be zero — Azure does not bill the Free tier control plane.",
        "risk_note": "Deleting removes the cluster configuration. With no nodes there are no running workloads to lose.",
        "how": "Azure portal -> Kubernetes services -> select -> Delete.",
    },
}

_DEFAULT_META = {
    "category": ARCHITECTURE, "confidence": LOW, "effort": MEDIUM, "risk": MEDIUM,
    "why": None, "action": None, "impact": None, "risk_note": None, "how": None,
}

# ── Priority score (83, 84) ───────────────────────────────────────────────────
# Published, not hidden, because a ranking nobody can interrogate is a ranking
# nobody should trust. Maximum 100.
#
#   impact      0-40   share of the largest priced saving IN THE SAME CURRENCY.
#                      Unpriced findings score 10 — not 0, because "we cannot
#                      price it" is not the same as "it is worth nothing", and
#                      not high, because we genuinely do not know.
#   confidence  0-25   HIGH 25 / MEDIUM 15 / LOW 5
#   effort      0-15   LOW 15 / MEDIUM 8 / HIGH 2   (cheaper to do ranks higher)
#   risk        0-15   LOW 15 / MEDIUM 8 / HIGH 2   (safer ranks higher)
#   severity    0-5    CRITICAL 5 / HIGH 4 / MEDIUM 2 / LOW 1
PRIORITY_FORMULA = (
    "priority = impact(0-40) + confidence(0-25) + effort(0-15) + risk(0-15) "
    "+ severity(0-5), maximum 100. Impact is the saving's share of the largest "
    "priced saving in the same currency; savings in different currencies are "
    "ranked within their own currency and never compared across. An unpriced "
    "recommendation scores 10 for impact — unknown, not worthless."
)

_CONFIDENCE_POINTS = {HIGH: 25, MEDIUM: 15, LOW: 5}
_EFFORT_POINTS = {LOW: 15, MEDIUM: 8, HIGH: 2}
_RISK_POINTS = {LOW: 15, MEDIUM: 8, HIGH: 2}
_SEVERITY_POINTS = {"CRITICAL": 5, "HIGH": 4, "MEDIUM": 2, "LOW": 1}


def unclassified_rules(optimizations: Sequence[Dict[str, Any]]) -> List[str]:
    """Rules the engine emitted that this module has no metadata for.

    Surfaced rather than silently defaulted, so a new rule added to
    cost_service shows up as an explicit gap.
    """
    return sorted({
        o.get("rule") for o in optimizations
        if o.get("rule") and o["rule"] not in RULES
    })


def _impact_points(amount: Optional[float], best_in_currency: Optional[float]) -> int:
    if amount is None or not best_in_currency:
        return 10
    try:
        return int(round(40 * min(1.0, float(amount) / float(best_in_currency))))
    except (TypeError, ValueError, ZeroDivisionError):
        return 10


def enrich(
    optimizations: Sequence[Dict[str, Any]],
    *,
    account_id,
    decisions: Optional[Dict[str, Any]] = None,
    verified_at: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Add category, confidence, actionability, priority and lifecycle state.

    Pure: takes the engine's findings and returns enriched copies. Does not
    re-derive, re-price, or drop anything.
    """
    verified_at = verified_at or datetime.now(timezone.utc)
    decisions = decisions or {}

    # The best priced saving PER CURRENCY. Ranking impact against a global
    # maximum would let a large INR figure crush every USD recommendation to
    # near-zero impact purely because the numbers are bigger.
    best: Dict[str, float] = {}
    for o in optimizations:
        amount = o.get("potential_savings")
        if isinstance(amount, (int, float)):
            code = o.get("savings_currency") or "UNKNOWN"
            best[code] = max(best.get(code, 0.0), float(amount))

    out: List[Dict[str, Any]] = []
    for o in optimizations:
        rule = o.get("rule") or "Unknown"
        meta = RULES.get(rule, _DEFAULT_META)
        amount = o.get("potential_savings")
        currency = o.get("savings_currency")
        priced = isinstance(amount, (int, float))

        fingerprint = recommendation_fingerprint(
            account_id=o.get("account_id") or account_id,
            rule=rule,
            resource_id=o.get("resource_id"),
        )
        decision = decisions.get(fingerprint)

        priority = (
            _impact_points(amount if priced else None,
                           best.get(currency or "UNKNOWN"))
            + _CONFIDENCE_POINTS.get(meta["confidence"], 5)
            + _EFFORT_POINTS.get(o.get("effort") or meta["effort"], 8)
            + _RISK_POINTS.get(meta["risk"], 8)
            + _SEVERITY_POINTS.get((o.get("severity") or "LOW").upper(), 1)
        )

        out.append({
            **o,
            "recommendation_id": fingerprint,
            "fingerprint": fingerprint,
            "title": rule,
            "category": meta["category"],
            "confidence": meta["confidence"],
            "risk": meta["risk"],
            "effort": o.get("effort") or meta["effort"],
            # Actionability (39). Nulls where a rule has no metadata yet —
            # an empty field is honest; invented guidance is not.
            "actionability": {
                "why": meta["why"],
                "action": meta["action"],
                "expected_impact": meta["impact"],
                "risk": meta["risk_note"],
                "how": meta["how"],
            },
            # Savings provenance (104). `priced` distinguishes a real
            # list-price calculation from an opportunity we cannot quantify.
            "savings_priced": priced,
            "savings_source": o.get("savings_basis"),
            "priority_score": priority,
            "priority_formula": PRIORITY_FORMULA,
            # Utilization is never claimed (41): none of these rules observe
            # CPU, memory or request rates.
            "utilization": {
                "available": False,
                "reason": (
                    "This finding is based on the resource's reported STATE "
                    "(from the provider's own API), not on utilization metrics. "
                    "CPU, memory, network and request-rate data are not collected "
                    "by this product, so idleness in the usage sense is neither "
                    "measured nor claimed."
                ),
            },
            # Freshness (102): derived fresh on every analytics run, so this is
            # genuinely now rather than a stored timestamp.
            "last_verified": verified_at.isoformat(),
            "state": (decision or {}).get("state", STATE_NEW),
            "decision": decision,
        })

    out.sort(key=lambda r: (-r["priority_score"], r["title"]))
    return out


def savings_summary(recommendations: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Savings split by how well they are known, per currency (85, 86).

    Three buckets, never one number:
      verified     - priced from a provider price-list API.
      estimated    - priced by some other means. Currently always empty; the
                     bucket exists so an estimate can never be quietly counted
                     as verified when one is added.
      unquantified - a real opportunity whose value we cannot establish.
                     Counted, never valued.
    """
    verified: Dict[str, float] = {}
    estimated: Dict[str, float] = {}
    unquantified = 0
    closed = 0

    for r in recommendations:
        if r.get("state") in CLOSED_STATES:
            closed += 1
            continue
        amount = r.get("potential_savings")
        if not isinstance(amount, (int, float)):
            unquantified += 1
            continue
        code = r.get("savings_currency") or "UNKNOWN"
        basis = (r.get("savings_basis") or "").lower()
        bucket = verified if "price list" in basis else estimated
        bucket[code] = round(bucket.get(code, 0.0) + float(amount), 2)

    return {
        "verified_by_currency": verified,
        "estimated_by_currency": estimated,
        "unquantified_count": unquantified,
        "closed_count": closed,
        "open_count": len([
            r for r in recommendations if r.get("state") not in CLOSED_STATES
        ]),
        "note": (
            "Savings are grouped by currency and never summed across them. "
            "Unquantified opportunities are counted, not valued — a saving "
            "that cannot be priced from a provider price list is reported as "
            "NA rather than guessed."
        ),
    }


def by_category(recommendations: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Counts and priced savings per category, for the savings-by-category chart."""
    groups: Dict[str, Dict[str, Any]] = {}
    for r in recommendations:
        key = r.get("category") or "Other"
        entry = groups.setdefault(key, {
            "category": key, "count": 0, "savings_by_currency": {},
        })
        entry["count"] += 1
        amount = r.get("potential_savings")
        if isinstance(amount, (int, float)):
            code = r.get("savings_currency") or "UNKNOWN"
            entry["savings_by_currency"][code] = round(
                entry["savings_by_currency"].get(code, 0.0) + float(amount), 2
            )
    return sorted(groups.values(), key=lambda g: -g["count"])
