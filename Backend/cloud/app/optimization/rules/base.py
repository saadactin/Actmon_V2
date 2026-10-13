"""What an optimization rule receives, returns, and may use to say so.

Kept deliberately narrow, like the security registry's `Ctx`: a rule sees one
resource, the inventory around it, that resource's telemetry, its billed cost
and the price book. It never performs I/O. That is what lets the engine run
inside the discovery worker, in the API, and in a test with synthetic inputs,
and get the same answer each time.

The helpers below exist so the honest thing is the easy thing:

* `telemetry_gate()` refuses to conclude from too little data, and says how
  much there was;
* `metric_evidence()` renders a statistic with its source and sample count, or
  "N/A" with the collector's reason — never a 0 for an unknown;
* `billed_savings()` turns a resource's own billed cost into a saving only when
  the action ends that charge, with the billing source and window attached.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from app.optimization.model import (
    CHECK_FAIL, CHECK_PASS, CHECK_UNKNOWN, CLEAR, CONF_HIGH, CONF_LOW, CONF_MEDIUM,
    EV_BILLING, EV_CONFIGURATION, EV_TELEMETRY, FINDING, INSUFFICIENT_DATA,
    NOT_APPLICABLE, OPTIMIZATION_CATEGORIES, PROVIDERS, RISKS, SAVINGS_BILLED,
    SEVERITIES, Savings, check, data_source, evidence, no_savings,
)
from app.optimization.telemetry import METRICS, ResourceTelemetry, display

# ── Signals: what kind of opportunity a finding is ───────────────────────────
# Orthogonal to category. The summary cards count by these, so "Unused
# resources" is a count of findings that established a resource is unused —
# not a guess from its category.
SIG_UNUSED = "UNUSED"
SIG_UNDERUTILIZED = "UNDERUTILIZED"
SIG_CONSTRAINED = "CONSTRAINED"
SIG_CONFIGURATION = "CONFIGURATION"
SIG_RISK = "RISK"
SIGNALS = (SIG_UNUSED, SIG_UNDERUTILIZED, SIG_CONSTRAINED, SIG_CONFIGURATION, SIG_RISK)

EFFORTS = ("LOW", "MEDIUM", "HIGH")

# ── Published thresholds ─────────────────────────────────────────────────────
# Served by /meta so a reader can see exactly what "underutilized" means here.
THRESHOLDS: Dict[str, float] = {
    # Before any utilization is judged: at least this many days of hourly data…
    "min_observed_days": 14,
    # …covering at least this share of the hours the resource existed.
    "min_coverage_pct": 60,
    "underutilized_cpu_p95": 30.0,
    "underutilized_cpu_peak": 80.0,
    "underutilized_memory_p95": 60.0,
    "idle_cpu_p95": 5.0,
    "constrained_cpu_p95": 90.0,
    "constrained_memory_p95": 90.0,
    # A resize target keeps P95 at or under this after the change…
    "sizing_target_cpu_p95": 60.0,
    "sizing_target_memory_p95": 75.0,
    # …and the busiest hour (P99) at or under this.
    "sizing_target_cpu_p99": 85.0,
    "sizing_target_memory_p99": 90.0,
    # Memory is a hard limit - running out of it kills processes - so a target
    # must also hold the measured PEAK hour (the per-hour maximum) under this.
    # CPU gets no such floor: a CPU-bound hour is slow, not broken, and the
    # projected CPU peak is shown as a safety check instead.
    "sizing_memory_peak_max": 90.0,
    "db_underutilized_cpu_p95": 25.0,
    "db_underutilized_memory_p95": 70.0,
    "storage_nearly_full_pct": 85.0,
    "function_error_rate_pct": 5.0,
    "function_min_invocations": 100,
    "function_timeout_margin_pct": 90.0,
}


class Ctx(NamedTuple):
    resource: Any
    provider: str
    config: Dict[str, Any]
    tags: Dict[str, Any]
    meta: Dict[str, Any]
    telemetry: ResourceTelemetry
    facts: Dict[str, Any]
    billed: Optional[Dict[str, Any]]
    prices: "PriceBook"
    index: Dict[str, Any]          # provider id (lower-cased) -> resource
    attached: Dict[str, List[Any]]  # attached_to id (lower-cased) -> volumes/disks
    history: List[Dict[str, Any]]  # this resource's status / attachment changes
    now: datetime
    thresholds: Dict[str, float]
    catalogs: Dict[str, Any]       # provider capacity catalogs (Azure SKUs, OCI shapes)


class Outcome(NamedTuple):
    verdict: str
    severity: Optional[str] = None
    title: Optional[str] = None
    detail: str = ""
    recommendation: Optional[str] = None
    evidence: List[Dict[str, Any]] = []
    current: Dict[str, Any] = {}
    recommended: Optional[Dict[str, Any]] = None
    savings: Optional[Savings] = None
    confidence: str = CONF_MEDIUM
    confidence_reasons: List[str] = []
    risk: Optional[str] = None
    risk_notes: List[str] = []
    impact: Dict[str, str] = {}
    safety: Dict[str, Any] = {}
    data_sources: List[Dict[str, Any]] = []
    reason: Optional[str] = None       # why INSUFFICIENT_DATA / NOT_APPLICABLE / CLEAR
    discriminator: Optional[str] = None
    signal: Optional[str] = None
    # A saving that needs an async price lookup (Azure retail prices), resolved
    # by the service after the pure run. Rules stay free of I/O.
    pricing_request: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class Rule:
    rule_id: str
    version: str
    providers: Tuple[str, ...]
    resource_types: Tuple[str, ...]
    category: str
    severity: str
    signal: str
    title: str
    description: str
    rationale: str
    remediation: Dict[str, str]
    risk: str
    effort: str
    evaluate: Callable[[Ctx], Any]
    metrics: Tuple[str, ...] = ()
    # Legacy Cost-tab rule names this rule supersedes. The Cost tab's
    # recommendation list is built from these findings, and a decision a
    # person recorded against the old name keeps applying.
    supersedes: Tuple[str, ...] = ()

    def remediation_for(self, provider: str) -> Optional[str]:
        return self.remediation.get(provider) or self.remediation.get("*")


def validate_rule(rule: Rule) -> None:
    """Refuse a malformed rule at import time rather than at 02:00."""
    assert rule.category in OPTIMIZATION_CATEGORIES, f"{rule.rule_id}: bad category {rule.category}"
    assert rule.severity in SEVERITIES, f"{rule.rule_id}: bad severity"
    assert rule.risk in RISKS, f"{rule.rule_id}: bad risk"
    assert rule.effort in EFFORTS, f"{rule.rule_id}: bad effort"
    assert rule.signal in SIGNALS, f"{rule.rule_id}: bad signal"
    assert rule.providers and all(p in PROVIDERS for p in rule.providers), rule.rule_id
    for m in rule.metrics:
        assert m in METRICS, f"{rule.rule_id}: unknown metric {m}"
    assert rule.rationale and rule.description, rule.rule_id


# ── Verdict constructors ─────────────────────────────────────────────────────

def insufficient(reason: str, *, data_sources: Sequence[Dict[str, Any]] = ()) -> Outcome:
    return Outcome(INSUFFICIENT_DATA, reason=reason, data_sources=list(data_sources))


def clear(reason: str = "", *, evidence_items: Sequence[Dict[str, Any]] = ()) -> Outcome:
    return Outcome(CLEAR, reason=reason or None, evidence=list(evidence_items))


def not_applicable(reason: str = "") -> Outcome:
    return Outcome(NOT_APPLICABLE, reason=reason or None)


# ── Telemetry helpers ────────────────────────────────────────────────────────

def telemetry_gate(ctx: Ctx, metric: str) -> Tuple[bool, str]:
    """(enough, reason). Enough = collected, with at least `min_observed_days`
    of hourly samples covering at least `min_coverage_pct` of the window."""
    t = ctx.thresholds
    res = ctx.telemetry.result(metric)
    label = METRICS[metric].label if metric in METRICS else metric
    if not res.ok:
        return False, f"{label}: {ctx.telemetry.reason(metric)}"
    s = res.stats or {}
    days = float(s.get("observed_days") or 0)
    cov = s.get("coverage_pct")
    if days < t["min_observed_days"]:
        return False, (f"{label}: only {days:g} days of datapoints in the last 30 "
                       f"(at least {t['min_observed_days']:g} are needed before utilization is judged).")
    if cov is not None and cov < t["min_coverage_pct"]:
        return False, (f"{label}: datapoints cover {cov:g}% of the window (at least "
                       f"{t['min_coverage_pct']:g}% are needed).")
    return True, ""


def metric_evidence(ctx: Ctx, metric: str, stat: str, label: str) -> Dict[str, Any]:
    res = ctx.telemetry.result(metric)
    unit = METRICS[metric].unit if metric in METRICS else None
    if not res.ok:
        return evidence(label, None, unit=unit, display="N/A", kind=EV_TELEMETRY,
                        source=res.source, detail=ctx.telemetry.reason(metric))
    s = res.stats or {}
    value = s.get(stat)
    detail = (f"{s.get('samples', 0):,} {('hourly' if s.get('granularity_seconds') == 3600 else 'daily')} "
              f"datapoints over {s.get('observed_days', 0):g} days")
    if stat == "peak" and s.get("peak_source") == "highest_period_average":
        detail += " — highest hourly average (no per-hour maximum was published)"
    return evidence(label, value, unit=unit, display=display(value, unit),
                    kind=EV_TELEMETRY, source=res.source, detail=detail)


def metric_source(ctx: Ctx, metric: str, label: str, *, required: bool = True) -> Dict[str, Any]:
    res = ctx.telemetry.result(metric)
    if res.ok:
        s = res.stats or {}
        return data_source(metric, label, True,
                           f"{s.get('samples', 0):,} datapoints, {s.get('coverage_pct')}% coverage",
                           required=required)
    return data_source(metric, label, False, ctx.telemetry.reason(metric), required=required)


def per_second(total_per_hour: Optional[float]) -> Optional[float]:
    return None if total_per_hour is None else total_per_hour / 3600.0


# ── Billing helpers ──────────────────────────────────────────────────────────

def billed_evidence(ctx: Ctx, label: str = "Billed cost, last 30 days") -> Dict[str, Any]:
    b = ctx.billed
    if not b or b.get("amount") is None:
        return evidence(label, None, display="N/A", kind=EV_BILLING,
                        detail=ctx.prices.billing_gap(ctx.provider))
    return evidence(label, b["amount"], unit=b.get("currency"),
                    display=money(b["amount"], b.get("currency")), kind=EV_BILLING,
                    source=b.get("source"),
                    detail=f"{b.get('period_days', 30)} days, fetched {b.get('fetched_at') or 'unknown'}")


def billing_source(ctx: Ctx, *, required: bool = False) -> Dict[str, Any]:
    b = ctx.billed
    if b and b.get("amount") is not None:
        return data_source("billing", "Billed cost (provider billing API)", True,
                           f"{money(b['amount'], b.get('currency'))} over {b.get('period_days', 30)} days",
                           required=required)
    return data_source("billing", "Billed cost (provider billing API)", False,
                       ctx.prices.billing_gap(ctx.provider), required=required)


def monthly_billed(billed: Optional[Dict[str, Any]]) -> Optional[float]:
    if not billed or billed.get("amount") is None:
        return None
    days = billed.get("period_days") or 30
    return float(billed["amount"]) * 30.0 / float(days)


def billed_savings(ctx: Ctx, *, what: str, resources: Sequence[Any] = (),
                   include_self: bool = True) -> Optional[Savings]:
    """The billed cost the action ends: this resource's, plus any `resources`
    (e.g. the volumes a stopped instance keeps billing). None when none of it
    is billed per resource — the caller then tries a list price or says NA."""
    lines, total, currency, sources = [], 0.0, None, set()
    parts = ([ctx.resource] if include_self else []) + list(resources)
    for r in parts:
        b = ctx.prices.billed_for(r)
        amt = monthly_billed(b)
        if amt is None:
            continue
        if currency and b.get("currency") != currency:
            return None   # never sum across currencies
        currency = b.get("currency")
        sources.add(b.get("source") or "provider billing")
        total += amt
        lines.append({"component": f"{r.resource_name} ({r.resource_type})",
                      "monthly_cost": round(amt, 2), "note": "billed, last 30 days"})
    if not lines:
        return None
    return Savings(
        method=SAVINGS_BILLED, amount=round(total, 2), currency=currency,
        basis=(f"What {what} was billed over the last 30 days ({', '.join(sorted(sources))}). "
               "Removing it ends that charge; the figure is the billed amount, not an estimate."),
        breakdown=lines,
    )


def money(amount: Optional[float], currency: Optional[str]) -> str:
    if amount is None:
        return "N/A"
    sym = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£"}.get((currency or "").upper())
    return f"{sym}{amount:,.2f}" if sym else f"{amount:,.2f} {currency or ''}".strip()


# ── Config helpers ───────────────────────────────────────────────────────────

def cfg_num(cfg: Dict[str, Any], key: str) -> Optional[float]:
    v = cfg.get(key)
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def is_running(resource) -> Optional[bool]:
    ns = (getattr(resource, "normalized_status", None) or "").upper()
    if ns == "RUNNING":
        return True
    if ns in ("STOPPED", "TERMINATED", "DEALLOCATED"):
        return False
    return None


def age_days(ctx: Ctx) -> Optional[float]:
    raw = (ctx.meta or {}).get("time_created")
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    ts = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    return max(0.0, (ctx.now - ts).total_seconds() / 86400.0)


def since_change(ctx: Ctx, fields: Sequence[str], to_values: Sequence[str]) -> Optional[Dict[str, Any]]:
    """The most recent logged change of one of `fields` to one of `to_values`
    (case-insensitive) — e.g. when an instance went STOPPED. From the drift
    log, so it is only as old as the log: None means 'not recorded', never
    'just now'."""
    want = {v.lower() for v in to_values}
    hits = [h for h in ctx.history
            if (h.get("field") or "").lower() in fields and str(h.get("new") or "").lower() in want]
    if not hits:
        return None
    return max(hits, key=lambda h: h.get("at") or "")


def ceil_to(value: float, step: float = 1.0) -> float:
    return math.ceil(value / step - 1e-9) * step


def safety(verdict: str, *, checks: Sequence[Dict[str, Any]] = (),
           preconditions: Sequence[str] = (), reversible: Optional[bool] = None) -> Dict[str, Any]:
    from app.optimization.model import SAFETY_LABEL
    return {"verdict": verdict, "label": SAFETY_LABEL.get(verdict, verdict),
            "reversible": reversible, "checks": list(checks),
            "preconditions": list(preconditions)}


__all__ = [
    "CHECK_FAIL", "CHECK_PASS", "CHECK_UNKNOWN", "CLEAR", "CONF_HIGH", "CONF_LOW",
    "CONF_MEDIUM", "EV_CONFIGURATION", "EV_TELEMETRY", "FINDING", "Ctx", "Outcome", "Rule",
    "THRESHOLDS", "billed_evidence", "billed_savings", "billing_source", "check",
    "clear", "data_source", "evidence", "insufficient", "metric_evidence",
    "metric_source", "no_savings", "not_applicable", "telemetry_gate",
]
