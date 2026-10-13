"""The optimization engine: one pure pass over an account.

Takes the stored inventory, the telemetry just collected, the billed costs and
the price book; returns findings plus a record of every decision it made. No
I/O — the service gathers inputs and persists outputs — so the same analysis
runs identically inside the discovery worker, behind the API, and in a test.

What the engine guarantees:

* **Provider-aware dispatch** through `rules.rules_for(provider, type)`.
* **No verdict is lost.** FINDING produces a finding; CLEAR, INSUFFICIENT_DATA
  and NOT_APPLICABLE are counted per rule with their reasons, which is the
  "what could not be analysed, and why" panel.
* **Resolution is earned.** `evaluations` records, per (rule, resource), what
  the rule concluded this run. The repository closes a stored finding only
  when its own rule re-checked the same resource and concluded CLEAR, or when
  a COMPLETE sweep no longer contains the resource. A resource whose
  telemetry failed this time stays open — "could not re-check" is not "fixed".
* **One crashing rule cannot sink the run.** It is recorded as an error on
  that rule, and every other rule still runs.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple

from app.optimization import rules as reg
from app.optimization.model import (
    CLEAR, FINDING, INSUFFICIENT_DATA, NOT_APPLICABLE, RUN_COMPLETE, RUN_FAILED, RUN_PARTIAL,
    OptimizationFinding, fingerprint, no_savings, normalize_provider, severity_rank,
)
from app.optimization.pricebook import PriceBook
from app.optimization.rules.base import THRESHOLDS, Ctx, Outcome
from app.optimization.telemetry import ResourceTelemetry

logger = logging.getLogger("cloud_svc.optimization.engine")

VOLUME_TYPES = ("BlockVolume", "BootVolume", "ManagedDisk", "EBSVolume")


class Analysis(NamedTuple):
    account_id: str
    provider: str
    outcome: str
    findings: List[OptimizationFinding]
    # (rule_id, resource_key lower-cased) -> (verdict, reason)
    evaluations: Dict[Tuple[str, str], Tuple[str, Optional[str]]]
    # rule_id -> {evaluated, FINDING, CLEAR, INSUFFICIENT_DATA, NOT_APPLICABLE, ERROR, reasons}
    coverage: Dict[str, Dict[str, Any]]
    resources_total: int
    resources_analyzed: int
    rules_evaluated: int
    incomplete_reasons: List[str]
    resource_keys: frozenset
    per_resource: Dict[str, Dict[str, str]]   # resource_id -> {rule_id: verdict}
    started_at: datetime
    finished_at: datetime
    # Inventory rows that repeat another row's provider id in a different case
    # (ARM ids are case-insensitive). Only the most detailed copy is analysed.
    duplicates: int = 0

    def summary(self) -> Dict[str, Any]:
        return {
            "outcome": self.outcome,
            "findings": len(self.findings),
            "by_severity": dict(Counter(f.severity for f in self.findings)),
            "by_category": dict(Counter(f.category for f in self.findings)),
            "resources_total": self.resources_total,
            "resources_analyzed": self.resources_analyzed,
            "rules_evaluated": self.rules_evaluated,
            "incomplete_reasons": self.incomplete_reasons,
        }


def _iter(result: Any) -> Iterable[Outcome]:
    if result is None:
        return []
    if isinstance(result, Outcome):
        return [result]
    return [r for r in result if isinstance(r, Outcome)]


def _richness(r) -> tuple:
    cfg = r.config or {}
    return ((getattr(r, "normalized_status", None) or "UNKNOWN") != "UNKNOWN",
            "azure_type" not in cfg, len(cfg))


def dedupe(resources: Sequence[Any]) -> Tuple[List[Any], int]:
    """One row per provider id, compared case-insensitively.

    Azure's generic ARM sweep used to add a second, config-less row for a VM
    the compute scanner had already recorded, differing only in the case of
    the resource group. Evaluating both let the empty copy's "not enough data"
    overwrite the real row's verdict, so a finding could neither update nor
    resolve. The most detailed copy is kept.
    """
    best: Dict[str, Any] = {}
    dup = 0
    for r in resources:
        k = (getattr(r, "provider_resource_id", None) or str(r.id)).lower()
        cur = best.get(k)
        if cur is None:
            best[k] = r
            continue
        dup += 1
        if _richness(r) > _richness(cur):
            best[k] = r
    return list(best.values()), dup


def build_indexes(resources: Sequence[Any]) -> Tuple[Dict[str, Any], Dict[str, List[Any]], Dict[str, List[str]]]:
    """(index by provider id, volumes by what they are attached to, LB backend IP → LB names)."""
    index: Dict[str, Any] = {}
    attached: Dict[str, List[Any]] = {}
    lb_ips: Dict[str, List[str]] = {}
    for r in resources:
        pid = (getattr(r, "provider_resource_id", None) or "").lower()
        if pid:
            index[pid] = r
        cfg = r.config or {}
        if r.resource_type in VOLUME_TYPES and cfg.get("attached_to_id"):
            attached.setdefault(str(cfg["attached_to_id"]).lower(), []).append(r)
        if r.resource_type == "LoadBalancer":
            for ip in cfg.get("backend_ips") or []:
                lb_ips.setdefault(ip, []).append(r.resource_name)
    return index, attached, lb_ips


def analyze(
    *,
    account_id: str,
    provider: str,
    resources: Sequence[Any],
    telemetry: Optional[Dict[str, ResourceTelemetry]] = None,
    facts: Optional[Dict[str, Dict[str, Any]]] = None,
    prices: Optional[PriceBook] = None,
    catalogs: Optional[Dict[str, Any]] = None,
    history: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    sweep_complete: bool = True,
    telemetry_problems: Sequence[str] = (),
    thresholds: Optional[Dict[str, float]] = None,
    now: Optional[datetime] = None,
) -> Analysis:
    started = now or datetime.now(timezone.utc)
    prov = normalize_provider(provider)
    telemetry = telemetry or {}
    facts = facts or {}
    prices = prices or PriceBook()
    history = history or {}
    th = {**THRESHOLDS, **(thresholds or {})}
    if prov is None:
        done = datetime.now(timezone.utc)
        return Analysis(str(account_id), str(provider), RUN_FAILED, [], {}, {}, len(resources), 0,
                        0, [f"Provider {provider!r} is not recognised; no rule set applies."],
                        frozenset(), {}, started, done)

    total_rows = len(resources)
    resources, duplicates = dedupe(resources)
    index, attached, lb_ips = build_indexes(resources)
    cats = {**(catalogs or {}), "lb_backend_ips": lb_ips}
    findings: List[OptimizationFinding] = []
    evaluations: Dict[Tuple[str, str], Tuple[str, Optional[str]]] = {}
    coverage: Dict[str, Dict[str, Any]] = {}
    per_resource: Dict[str, Dict[str, str]] = {}
    analysed = set()
    rules_run = 0
    empty_tm = ResourceTelemetry()

    for resource in resources:
        rules = reg.rules_for(prov, resource.resource_type)
        if not rules:
            continue
        rid = str(resource.id)
        key = (resource.provider_resource_id or rid).lower()
        ctx = Ctx(
            resource=resource, provider=prov,
            config=resource.config or {},
            tags=resource.tags if isinstance(resource.tags, dict) else {},
            meta=getattr(resource, "metadata_", None) or {},
            telemetry=telemetry.get(rid) or empty_tm,
            facts=facts.get(rid) or {},
            billed=prices.billed_for(resource),
            prices=prices, index=index, attached=attached,
            history=history.get(rid) or [],
            now=started, thresholds=th, catalogs=cats,
        )
        for rule in rules:
            rules_run += 1
            cov = coverage.setdefault(rule.rule_id, {
                "evaluated": 0, FINDING: 0, CLEAR: 0, INSUFFICIENT_DATA: 0, NOT_APPLICABLE: 0,
                "ERROR": 0, "reasons": Counter()})
            cov["evaluated"] += 1
            try:
                outcomes = list(_iter(rule.evaluate(ctx)))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Rule %s failed on %s: %s", rule.rule_id, rid, exc, exc_info=True)
                cov["ERROR"] += 1
                cov["reasons"][f"Rule error: {type(exc).__name__}: {str(exc)[:160]}"] += 1
                evaluations[(rule.rule_id, key)] = ("ERROR", str(exc)[:200])
                continue
            if not outcomes:
                outcomes = [Outcome(NOT_APPLICABLE)]
            verdicts = [o.verdict for o in outcomes]
            # One verdict per (rule, resource) for resolution: a finding wins,
            # then CLEAR; INSUFFICIENT_DATA never counts as a re-check.
            decided = (FINDING if FINDING in verdicts else CLEAR if CLEAR in verdicts
                       else INSUFFICIENT_DATA if INSUFFICIENT_DATA in verdicts else NOT_APPLICABLE)
            reason = next((o.reason for o in outcomes if o.reason), None)
            evaluations[(rule.rule_id, key)] = (decided, reason)
            per_resource.setdefault(rid, {})[rule.rule_id] = decided
            if decided in (FINDING, CLEAR):
                analysed.add(rid)
            for o in outcomes:
                cov[o.verdict] = cov.get(o.verdict, 0) + 1
                if o.verdict in (INSUFFICIENT_DATA, NOT_APPLICABLE) and o.reason:
                    cov["reasons"][o.reason[:240]] += 1
                if o.verdict != FINDING:
                    continue
                findings.append(_build(rule, resource, o, prov, str(account_id), started))

    findings.sort(key=lambda f: (severity_rank(f.severity),
                                 -(f.savings.amount or 0.0), f.title, f.fingerprint))
    for cov in coverage.values():
        cov["reasons"] = [{"reason": r, "count": n} for r, n in cov["reasons"].most_common(8)]

    incomplete: List[str] = []
    if not sweep_complete:
        incomplete.append("The last discovery sweep did not read every scope, so resources in the "
                          "scopes it missed are absent. Findings are not resolved from this run.")
    incomplete.extend(telemetry_problems)
    outcome = RUN_COMPLETE if not incomplete else RUN_PARTIAL
    return Analysis(
        account_id=str(account_id), provider=prov, outcome=outcome, findings=findings,
        evaluations=evaluations, coverage=coverage, resources_total=total_rows - duplicates,
        resources_analyzed=len(analysed), rules_evaluated=rules_run,
        incomplete_reasons=incomplete,
        resource_keys=frozenset((getattr(r, "provider_resource_id", None) or str(r.id)).lower()
                                for r in resources),
        per_resource=per_resource, started_at=started, finished_at=datetime.now(timezone.utc),
        duplicates=duplicates,
    )


def _build(rule, resource, o: Outcome, provider: str, account_id: str,
           now: datetime) -> OptimizationFinding:
    savings = o.savings or no_savings("No saving is quantified for this recommendation.")
    return OptimizationFinding(
        rule_id=rule.rule_id, rule_version=rule.version, provider=provider,
        account_id=account_id,
        fingerprint=fingerprint(provider=provider, account_id=account_id, rule_id=rule.rule_id,
                                resource_key=resource.provider_resource_id,
                                discriminator=o.discriminator),
        category=rule.category,
        severity=o.severity or rule.severity,
        title=o.title or rule.title,
        description=o.detail or rule.description,
        rationale=rule.rationale,
        recommendation=o.recommendation or rule.remediation_for(provider) or "",
        remediation=rule.remediation_for(provider),
        resource_key=resource.provider_resource_id,
        resource_id=str(resource.id),
        resource_name=resource.resource_name,
        resource_type=resource.resource_type,
        region=resource.region_or_zone,
        confidence=o.confidence,
        confidence_reasons=list(o.confidence_reasons),
        evidence=list(o.evidence),
        current_configuration={k: v for k, v in (o.current or {}).items() if v not in (None, "")},
        recommended_configuration=({k: v for k, v in o.recommended.items() if v not in (None, "")}
                                   if o.recommended else None),
        savings=savings,
        risk=o.risk or rule.risk,
        risk_notes=list(o.risk_notes),
        impact=dict(o.impact),
        safety=dict(o.safety),
        data_sources=list(o.data_sources),
        metrics_used=list(rule.metrics),
        detected_at=now,
        signal=o.signal or rule.signal,
        effort=rule.effort,
        pricing_request=o.pricing_request,
    )
