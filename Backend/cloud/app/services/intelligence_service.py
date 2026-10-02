"""Cloud Resource Intelligence: the analysis write path and the unified read path.

WRITE: `analyze()` collects telemetry from the provider's monitoring API,
refreshes per-resource billed cost through the existing materialization
(`resource_normalizer.sync_resource_costs`), prices what can be priced, runs
the pure optimization engine and reconciles its findings. It runs as the last
stage of every discovery sweep (and so of every Refresh all), and on the
Intelligence tab's own "Refresh intelligence".

READ: one list over TWO engines. Security findings are read from the Security
Center's own table — never re-evaluated here — and shown beside optimization
findings under a unified category. The two are never merged into one row, and
each keeps its own status vocabulary underneath the shared filter. The one
thing deliberately left out is the security engine's own Cost and Performance
categories: its model calls them "not security risk at all", and this engine
evaluates the same conditions with telemetry and billing evidence, so showing
both would list the same instance twice with two different answers.

Paging, filtering and facet counts all happen in SQL over a UNION ALL of the
two tables, so the list stays one query however many findings an estate has.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import Float, String, and_, case, cast, func, literal, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.optimization import (
    CloudOptimizationFinding, CloudOptimizationRun, CloudResourceTelemetry,
)
from app.models.resource import CloudResource
from app.models.resource_cost import CloudResourceCost
from app.models.security_finding import CloudSecurityAssessment, CloudSecurityFinding
from app.optimization import collector, engine, health
from app.optimization import rules as reg
from app.optimization.model import (
    ACKNOWLEDGED, ACTIVE_STATUSES, CATEGORIES, CATEGORY_LABEL, CATEGORY_MEANING, COMPLIANCE,
    CONFIDENCE_LABEL, OPEN, OPTIMIZATION_CATEGORIES, RESOLVED, SAFETY_LABEL, SAVINGS_LIST_PRICE,
    SAVINGS_METHODS, SECURITY, SECURITY_CATEGORY_MAP, SECURITY_STATUS_GROUP, SEVERITIES,
    STATUS_GROUP_TO_SECURITY, STATUS_LABEL, STATUS_REQUIRES_REASON, STATUSES, SUPERSEDED_SECURITY_CATEGORIES,
    SUPPRESSED, Savings, normalize_provider, unified_security_category,
)
from app.optimization.pricebook import PriceBook, commitment_gap, effective_rate
from app.optimization.rules.base import SIGNALS, THRESHOLDS
from app.optimization.telemetry import METRICS, ST_DENIED, ST_ERROR
from app.pricing import azure_pricing, oci_pricing
from app.repository.cloud_account_repo import CloudAccountRepository
from app.repository.optimization_repo import OptimizationRepository
from app.repository.resource_repo import ResourceRepository

logger = logging.getLogger("cloud_svc.intelligence")

SOURCE_OPT = "optimization"
SOURCE_SEC = "security"
SOURCES = (SOURCE_OPT, SOURCE_SEC)

_BILLING_LABEL = {"OCI": "OCI Usage API", "AZURE": "Azure Cost Management"}
_HISTORY_FIELDS = {"status", "normalized_status", "power_state", "attached_to_id",
                   "attached_to_name", "attachment_status", "shape", "vm_size", "instance_type",
                   "ocpus", "memory_gb", "vpus_per_gb", "size_gb", "license_model"}
_DEFAULT_CURRENCY = {"AWS": "USD"}

# One analysis per account at a time, in this process. A sweep's analysis and a
# manual one overlapping would race the upsert of the same fingerprints.
_locks: Dict[str, asyncio.Lock] = {}


class AnalysisRunning(Exception):
    """An analysis of this account is already in progress."""


def _lock(account_id) -> asyncio.Lock:
    return _locks.setdefault(str(account_id), asyncio.Lock())


def is_running(account_id) -> bool:
    lock = _locks.get(str(account_id))
    return bool(lock and lock.locked())


def _iso(dt) -> Optional[str]:
    return dt.isoformat() if dt else None


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _norm_value(v):
    if v is None:
        return None
    s = str(v).strip()
    return None if s in ("", "-", "None", "null") else s


class IntelligenceService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = OptimizationRepository(db)
        self.accounts = CloudAccountRepository(db)
        self.resources = ResourceRepository(db)

    # ═════════════════════════════════════════════════════════════════════════
    # Write path
    # ═════════════════════════════════════════════════════════════════════════

    async def analyze(self, account_id: uuid.UUID, *, triggered_by: str = "manual",
                      sweep_complete: Optional[bool] = None,
                      discovery_scan_id: Optional[uuid.UUID] = None) -> Dict[str, Any]:
        lock = _lock(account_id)
        if lock.locked():
            raise AnalysisRunning(str(account_id))
        async with lock:
            return await self._analyze(account_id, triggered_by=triggered_by,
                                       sweep_complete=sweep_complete,
                                       discovery_scan_id=discovery_scan_id)

    async def _analyze(self, account_id, *, triggered_by, sweep_complete, discovery_scan_id):
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider)
        if sweep_complete is None:
            sweep_complete = await self._last_sweep_complete(account_id)
        resources = await self.resources.list_by_account(account_id)

        # 1. Telemetry, from the provider's monitoring API. Persisted even when
        #    the analysis below fails, so the charts are never older than this.
        outcome = await collector.collect(account, resources)
        try:
            await collector.persist(self.db, account.id, provider or account.provider, outcome.rows)
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001
            await self.db.rollback()
            logger.warning("Telemetry persist failed for %s: %s", account_id, exc)
        tel_summary = outcome.summary()
        problems = self._telemetry_problems(tel_summary)

        # 2. Billed cost per resource, through the existing materialization.
        cost_report: Dict[str, Any] = {}
        try:
            from app.services.resource_normalizer import sync_resource_costs
            cost_report = await sync_resource_costs(self.db, account, days=30, wait=True)
            await self.db.commit()
        except Exception as exc:  # noqa: BLE001
            await self.db.rollback()
            cost_report = {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}
        billed, currency = await self._billed_map(account)

        # 3. Prices the rules may use.
        prices = await self._price_book(account, provider, resources, billed, currency, cost_report)

        # 4. The analysis itself — pure.
        history = await self._history(account_id)
        catalogs = {
            "azure_skus": (outcome.stats or {}).get("catalogs") or {},
            "oci_shapes": (outcome.stats or {}).get("shapes") or {},
            "aws_instance_types": (outcome.stats or {}).get("instance_types") or {},
        }
        analysis = engine.analyze(
            account_id=str(account_id), provider=account.provider, resources=resources,
            telemetry=outcome.telemetry, facts=outcome.facts, prices=prices,
            catalogs=catalogs, history=history, sweep_complete=sweep_complete,
            telemetry_problems=problems,
        )
        await self._resolve_pricing(analysis.findings, currency)

        # 5. Reconcile and record.
        run_id = uuid.uuid4()
        stats = await self.repo.persist(account_id=account_id, analysis=analysis, run_id=run_id,
                                        sweep_complete=sweep_complete)
        open_rows = await self.repo.for_accounts([account_id], statuses=list(ACTIVE_STATUSES))
        savings: Dict[str, float] = defaultdict(float)
        for r in open_rows:
            if r.estimated_savings is not None and r.savings_currency:
                savings[r.savings_currency] += r.estimated_savings
        inputs = {
            "sweep_complete": sweep_complete,
            "billing": {k: v for k, v in cost_report.items() if k in (
                "supported", "written", "matched", "unmatched", "reason", "error", "fetched_at")},
            "billed_resources": prices.billed_count,
            "currency": currency,
            "oci_prices": bool(prices.oci_block),
            "oci_flex_shapes_priced": sorted(prices.oci_flex),
            "duplicate_inventory_rows": analysis.duplicates,
        }
        await self.repo.record_run(
            run_id=run_id, account_id=account_id, analysis=analysis, persist_stats=stats,
            triggered_by=triggered_by, discovery_scan_id=discovery_scan_id,
            telemetry=tel_summary, inputs=inputs,
            savings_by_currency={k: round(v, 2) for k, v in savings.items()},
            findings_open=len(open_rows))
        await self.repo.prune_runs(account_id)
        await self.db.commit()
        return {
            "account_id": str(account_id), "run_id": str(run_id),
            "outcome": analysis.outcome, "findings": stats,
            "open": len(open_rows),
            "resources_analyzed": analysis.resources_analyzed,
            "resources_total": analysis.resources_total,
            "telemetry": {"resources": tel_summary.get("resources"), "error": tel_summary.get("error")},
            "incomplete_reasons": analysis.incomplete_reasons,
        }

    async def _last_sweep_complete(self, account_id) -> bool:
        from app.models.discovery_job import DiscoveryJob
        last = (await self.db.execute(
            select(DiscoveryJob).where(DiscoveryJob.account_id == account_id,
                                       DiscoveryJob.status.in_(["COMPLETED", "FAILED"]))
            .order_by(DiscoveryJob.started_at.desc()).limit(1))).scalar_one_or_none()
        if last is None:
            return True
        return last.status == "COMPLETED" and not last.error_detail

    @staticmethod
    def _telemetry_problems(summary: Dict[str, Any]) -> List[str]:
        out = []
        if summary.get("error"):
            out.append(f"Telemetry collection failed: {summary['error']}")
        for metric, counts in (summary.get("metrics") or {}).items():
            bad = counts.get(ST_ERROR, 0) + counts.get(ST_DENIED, 0)
            if bad:
                label = METRICS[metric].label if metric in METRICS else metric
                out.append(f"{label}: {bad} resource(s) could not be read "
                           f"({counts.get(ST_DENIED, 0)} not permitted, {counts.get(ST_ERROR, 0)} "
                           "provider errors). Findings that need it were neither raised nor "
                           "resolved for those resources.")
        return out

    async def _billed_map(self, account) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
        rows = (await self.db.execute(select(CloudResourceCost).where(
            CloudResourceCost.account_id == account.id))).scalars().all()
        label = _BILLING_LABEL.get((normalize_provider(account.provider) or ""), "provider billing")
        billed = {str(r.resource_id): {
            "amount": r.amount, "currency": r.currency, "period_days": r.period_days,
            "fetched_at": _iso(r.fetched_at), "source": label,
            "service": r.billed_service} for r in rows}
        currencies = Counter(r.currency for r in rows if r.currency)
        currency = currencies.most_common(1)[0][0] if currencies else None
        if currency is None:
            from app.models.cost_fact import CloudCostFact
            currency = (await self.db.execute(
                select(CloudCostFact.currency).where(CloudCostFact.account_id == account.id,
                                                     CloudCostFact.currency.isnot(None))
                .order_by(CloudCostFact.billing_date.desc()).limit(1))).scalar()
        return billed, currency or _DEFAULT_CURRENCY.get(normalize_provider(account.provider) or "")

    async def _price_book(self, account, provider, resources, billed, currency, cost_report):
        note = None
        if cost_report.get("error"):
            note = f"The last per-resource billing refresh failed ({cost_report['error'][:120]})."
        elif cost_report.get("reason"):
            note = cost_report["reason"]
        book = PriceBook(currency=currency, billed=billed, billing_note=note)
        if provider == "OCI" and currency:
            try:
                book.oci_block = await oci_pricing.get_prices(currency)
                shapes = {(r.config or {}).get("shape") for r in resources
                          if r.resource_type == "ComputeInstance"}
                if any((s or "").upper().startswith("VM.STANDARD2.") for s in shapes):
                    shapes.add("VM.Standard.E4.Flex")
                    part = await oci_pricing.get_part("B88514", currency)
                    if part:
                        book.oci_parts["B88514"] = part
                if any(r.resource_type == "ObjectStorageBucket" for r in resources):
                    # Object Storage (Standard) capacity, per GB-month — prices
                    # the incomplete multipart uploads a bucket still stores.
                    from app.optimization.rules.storage import OCI_OBJECT_STORAGE_PART
                    part = await oci_pricing.get_part(OCI_OBJECT_STORAGE_PART, currency)
                    if part:
                        book.oci_parts[OCI_OBJECT_STORAGE_PART] = part
                for shape in sorted(s for s in shapes if s in oci_pricing.FLEX_SHAPE_PARTS):
                    rates = await oci_pricing.flex_rates(shape, currency)
                    if rates:
                        book.oci_flex[shape] = rates
            except Exception as exc:  # noqa: BLE001
                logger.warning("OCI price lookup failed: %s", exc)
        return book

    async def _resolve_pricing(self, findings, currency: Optional[str]) -> None:
        """Price Azure VM resizes from the public retail price list."""
        wanted: Dict[Tuple[str, str], set] = defaultdict(set)
        for f in findings:
            req = f.pricing_request or {}
            if req.get("kind") == "azure_vm":
                wanted[(req["region"], (req.get("os") or "linux").lower())].update(
                    {req["current"], req["target"]})
        rates: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for (region, os_type), skus in wanted.items():
            try:
                rates[(region, os_type)] = await azure_pricing.vm_rates(
                    skus, region, os_type, currency or "USD")
            except Exception as exc:  # noqa: BLE001
                logger.warning("Azure price lookup failed: %s", exc)
                rates[(region, os_type)] = {}
        for f in findings:
            req = f.pricing_request or {}
            if req.get("kind") != "azure_vm":
                continue
            table = rates.get((req["region"], (req.get("os") or "linux").lower()), {})
            cur, new = table.get(req["current"]), table.get(req["target"])
            if not (cur and new):
                missing = [s for s, r in ((req["current"], cur), (req["target"], new)) if not r]
                f.savings = Savings(reason=(
                    "The Azure Retail Prices API returned no unambiguous pay-as-you-go rate for "
                    f"{', '.join(missing)} in {req['region']}, so the resize is not priced."))
                continue
            gap = commitment_gap(req.get("billed"), cur["hourly"], cur.get("currency"),
                                 req.get("running_hours"))
            if gap:
                f.savings = Savings(reason=gap)
                continue
            diff = cur["hourly"] - new["hourly"]
            monthly = round(diff * oci_pricing.HOURS_PER_MONTH, 2)
            if monthly <= 0:
                f.savings = Savings(reason="At list price the recommended size costs the same or more.")
                continue
            rate = effective_rate(req.get("billed"), cur["hourly"], cur.get("currency"),
                                  req.get("running_hours"))
            rate_note = ([f"At this VM's effective rate (its billed cost is {rate * 100:.0f}% of list "
                          f"for the hours it ran) the saving would be about {monthly * rate:,.2f} "
                          f"{cur.get('currency')} a month."]
                         if rate is not None and rate < 0.97 else [])
            f.savings = Savings(
                method=SAVINGS_LIST_PRICE, amount=monthly, currency=cur.get("currency"),
                basis=("Azure Retail Prices API, pay-as-you-go hourly rates in "
                       f"{req['region']} ({req.get('os') or 'Linux'}), × "
                       f"{oci_pricing.HOURS_PER_MONTH} hours. A reservation or savings plan makes "
                       "the real saving smaller — compare with the VM's billed cost."),
                breakdown=[
                    {"component": f"Current · {cur['meter']} ({cur['product']})",
                     "unit": "hour", "unit_price": cur["hourly"], "hourly_cost": cur["hourly"]},
                    {"component": f"Recommended · {new['meter']} ({new['product']})",
                     "unit": "hour", "unit_price": new["hourly"], "hourly_cost": new["hourly"]},
                    {"component": "Difference per hour", "hourly_cost": round(diff, 4)},
                    {"component": f"× {oci_pricing.HOURS_PER_MONTH} hours", "monthly_cost": monthly},
                ],
                assumptions=[f"{oci_pricing.HOURS_PER_MONTH} hours per month, running continuously."]
                + rate_note)

    async def _history(self, account_id) -> Dict[str, List[Dict[str, Any]]]:
        from app.models.drift import CloudResourceChange
        since = datetime.now(timezone.utc) - timedelta(days=180)
        rows = (await self.db.execute(
            select(CloudResourceChange.resource_id, CloudResourceChange.field_path,
                   CloudResourceChange.old_value, CloudResourceChange.new_value,
                   CloudResourceChange.detected_at)
            .where(CloudResourceChange.account_id == account_id,
                   CloudResourceChange.detected_at >= since)
            .order_by(CloudResourceChange.detected_at))).all()
        out: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for r in rows:
            field = (r.field_path or "").split(".")[-1]
            if not r.resource_id or field not in _HISTORY_FIELDS:
                continue
            out[str(r.resource_id)].append({"field": field, "old": _norm_value(r.old_value),
                                            "new": _norm_value(r.new_value),
                                            "at": _iso(r.detected_at)})
        return out

    # ═════════════════════════════════════════════════════════════════════════
    # The Cost tab's recommendations
    # ═════════════════════════════════════════════════════════════════════════

    async def cost_findings(self, accounts: Sequence[Any],
                            resources: Sequence[Any]) -> Dict[str, Any]:
        """Optimization findings for the Cost tab, as finding dicts.

        An analysed account's findings are read from the table the analysis
        writes — the same rows the Intelligence tab lists. An account never
        analysed gets a PREVIEW: the pure engine over its inventory and billed
        cost, with no telemetry, so the configuration rules still speak while
        the utilization rules stay silent (never "fine") until the first
        analysis. Nothing about a preview is stored.
        """
        by_account: Dict[str, List[Any]] = defaultdict(list)
        for r in resources:
            by_account[str(r.account_id)].append(r)
        findings: List[Dict[str, Any]] = []
        sources: List[Dict[str, Any]] = []
        for account in accounts:
            run = await self.repo.latest_run(account.id)
            if run is not None:
                # Active, suppressed, and resolved-by-a-person; a finding the
                # analysis resolved is history, not a recommendation.
                F = CloudOptimizationFinding
                rows = (await self.db.execute(select(F).where(
                    F.account_id == account.id,
                    or_(F.status.in_([OPEN, ACKNOWLEDGED, SUPPRESSED]),
                        and_(F.status == RESOLVED,
                             F.resolution["kind"].astext == "marked_by_user"))))).scalars().all()
                findings.extend(r.to_dict() for r in rows)
                sources.append({"account_id": str(account.id), "account_name": account.account_name,
                                "mode": "analysed", "analysed_at": _iso(run.finished_at),
                                "outcome": run.outcome})
                continue
            try:
                preview = await self._preview(account, by_account.get(str(account.id), []))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Cost-tab preview failed for %s: %s", account.id, exc)
                sources.append({"account_id": str(account.id), "account_name": account.account_name,
                                "mode": "unavailable",
                                "reason": f"The preview analysis failed: {type(exc).__name__}."})
                continue
            findings.extend(preview)
            sources.append({"account_id": str(account.id), "account_name": account.account_name,
                            "mode": "preview",
                            "reason": ("Not analysed yet: recommendations come from configuration "
                                       "and billing only. Utilization findings appear after the "
                                       "first analysis (Refresh all, or Refresh intelligence).")})
        return {"findings": findings, "sources": sources}

    async def _preview(self, account, resources: Sequence[Any]) -> List[Dict[str, Any]]:
        provider = normalize_provider(account.provider)
        billed, currency = await self._billed_map(account)
        prices = await self._price_book(account, provider, resources, billed, currency, {})
        analysis = engine.analyze(
            account_id=str(account.id), provider=account.provider, resources=resources,
            telemetry={}, facts={}, prices=prices, history=await self._history(account.id),
            sweep_complete=False,
            telemetry_problems=["This account has not been analysed yet, so no telemetry was "
                                "read; findings that need utilization are not raised."])
        await self._resolve_pricing(analysis.findings, currency)
        now = datetime.now(timezone.utc)
        return [{**f.to_dict(), "status": OPEN, "analysed": False, "last_verified_at": _iso(now)}
                for f in analysis.findings]

    # ═════════════════════════════════════════════════════════════════════════
    # The unified list
    # ═════════════════════════════════════════════════════════════════════════

    def _union(self, account_id: uuid.UUID):
        O, S = CloudOptimizationFinding, CloudSecurityFinding
        opt = select(
            literal(SOURCE_OPT).label("source"), O.fingerprint.label("key"),
            O.provider.label("provider"), O.title.label("title"), O.severity.label("severity"),
            O.category.label("category"), O.signal.label("signal"), O.status.label("status"),
            O.status.label("status_group"), O.resource_id.label("resource_id"),
            O.resource_name.label("resource_name"), O.resource_type.label("resource_type"),
            O.resource_key.label("resource_key"), O.region.label("region"),
            O.rule_id.label("rule_id"), O.first_detected_at.label("first_detected_at"),
            O.last_detected_at.label("last_detected_at"),
            O.estimated_savings.label("savings"), O.savings_currency.label("currency"),
            O.confidence.label("confidence"), O.description.label("description"),
            literal(False).label("has_compliance"),
            cast(literal(None), String).label("verdict"),
        ).where(O.account_id == account_id)
        sec_cat = case(*((S.category == k, literal(v)) for k, v in SECURITY_CATEGORY_MAP.items()),
                       else_=literal(SECURITY))
        sec_group = case(*((S.status == k, literal(v)) for k, v in SECURITY_STATUS_GROUP.items()),
                         else_=literal(OPEN))
        has_comp = case((and_(S.compliance.isnot(None),
                              cast(S.compliance, String).notin_(["{}", "null"])), True), else_=False)
        sec = select(
            literal(SOURCE_SEC).label("source"), S.fingerprint.label("key"),
            S.provider.label("provider"), S.title.label("title"), S.severity.label("severity"),
            sec_cat.label("category"), cast(literal(None), String).label("signal"),
            S.status.label("status"), sec_group.label("status_group"),
            S.resource_id.label("resource_id"), S.resource_name.label("resource_name"),
            S.resource_type.label("resource_type"), S.resource_key.label("resource_key"),
            S.region.label("region"), S.rule_id.label("rule_id"),
            S.first_detected_at.label("first_detected_at"),
            S.last_detected_at.label("last_detected_at"),
            cast(literal(None), Float).label("savings"), cast(literal(None), String).label("currency"),
            S.confidence.label("confidence"), S.description.label("description"),
            has_comp.label("has_compliance"), S.verdict.label("verdict"),
        ).where(S.account_id == account_id,
                S.category.notin_(list(SUPERSEDED_SECURITY_CATEGORIES)))
        return union_all(opt, sec).subquery("u")

    @staticmethod
    def _conds(u, f: Dict[str, Any], *, skip: Optional[str] = None) -> List[Any]:
        conds = []
        if skip != "source" and f.get("source"):
            conds.append(u.c.source.in_(f["source"]))
        if skip != "category" and f.get("category"):
            cats = list(f["category"])
            parts = []
            if COMPLIANCE in cats:
                parts.append(u.c.has_compliance.is_(True))
            plain = [c for c in cats if c != COMPLIANCE]
            if plain:
                parts.append(u.c.category.in_(plain))
            conds.append(or_(*parts))
        if skip != "severity" and f.get("severity"):
            conds.append(u.c.severity.in_(f["severity"]))
        if skip != "provider" and f.get("provider"):
            conds.append(u.c.provider.in_([normalize_provider(p) or p for p in f["provider"]]))
        if skip != "status" and f.get("status"):
            conds.append(u.c.status_group.in_(f["status"]))
        if skip != "signal" and f.get("signal"):
            conds.append(u.c.signal.in_(f["signal"]))
        if f.get("resource_id"):
            conds.append(u.c.resource_id == f["resource_id"])
        if f.get("resource_type"):
            conds.append(u.c.resource_type.in_(f["resource_type"]))
        if f.get("rule_id"):
            conds.append(u.c.rule_id.in_(f["rule_id"]))
        if f.get("has_savings"):
            conds.append(u.c.savings.isnot(None))
        if not f.get("include_undetermined"):
            # Undetermined security checks describe a gap in the data, not a
            # problem in the estate; they live on the Security Center's
            # Coverage tab and would bury real findings here.
            conds.append(or_(u.c.verdict.is_(None), u.c.verdict == "VULNERABLE"))
        if f.get("search"):
            like = f"%{f['search'].strip()}%"
            conds.append(or_(u.c.title.ilike(like), u.c.resource_name.ilike(like),
                             u.c.resource_key.ilike(like), u.c.rule_id.ilike(like),
                             u.c.description.ilike(like), u.c.resource_type.ilike(like)))
        return conds

    async def findings(self, account_id: uuid.UUID, filters: Dict[str, Any], *,
                       limit: int = 50, offset: int = 0, sort: str = "severity",
                       can_view_raw: bool = True) -> Dict[str, Any]:
        u = self._union(account_id)
        conds = self._conds(u, filters)
        sev = case({s: i for i, s in enumerate(SEVERITIES)}, value=u.c.severity, else_=9)
        order = {
            "savings": [u.c.savings.desc().nullslast(), sev, u.c.last_detected_at.desc()],
            "newest": [u.c.first_detected_at.desc(), sev],
            "resource": [u.c.resource_name.asc().nullslast(), sev],
        }.get(sort, [sev, u.c.savings.desc().nullslast(), u.c.last_detected_at.desc()])
        base = select(u).where(*conds)
        total = int((await self.db.execute(select(func.count()).select_from(base.subquery()))).scalar() or 0)
        rows = (await self.db.execute(
            base.order_by(*order, u.c.source, u.c.key)
            .limit(max(1, min(limit, 200))).offset(max(0, offset)))).mappings().all()
        cards = await self._cards(account_id, rows, can_view_raw=can_view_raw)
        return {"findings": cards, "total": total, "limit": limit, "offset": offset,
                "has_more": offset + len(rows) < total,
                "facets": await self._facets(u, filters)}

    async def _facets(self, u, filters) -> Dict[str, List[Dict[str, Any]]]:
        out: Dict[str, List[Dict[str, Any]]] = {}
        for name, col in (("category", u.c.category), ("severity", u.c.severity),
                          ("provider", u.c.provider), ("status", u.c.status_group),
                          ("source", u.c.source), ("signal", u.c.signal)):
            conds = self._conds(u, filters, skip=name)
            rows = (await self.db.execute(select(col, func.count()).where(*conds)
                                          .group_by(col))).all()
            out[name] = [{"value": r[0], "count": int(r[1])} for r in rows if r[0] is not None]
            if name == "category":
                comp = int((await self.db.execute(select(func.count()).select_from(u).where(
                    *conds, u.c.has_compliance.is_(True)))).scalar() or 0)
                if comp:
                    out[name].append({"value": COMPLIANCE, "count": comp})
                order = {c: i for i, c in enumerate(CATEGORIES)}
                out[name].sort(key=lambda d: order.get(d["value"], 99))
            elif name == "severity":
                order = {s: i for i, s in enumerate(SEVERITIES)}
                out[name].sort(key=lambda d: order.get(d["value"], 99))
            else:
                out[name].sort(key=lambda d: -d["count"])
        return out

    async def _cards(self, account_id, rows, *, can_view_raw: bool) -> List[Dict[str, Any]]:
        opt_keys = [r["key"] for r in rows if r["source"] == SOURCE_OPT]
        sec_keys = [r["key"] for r in rows if r["source"] == SOURCE_SEC]
        opt = {}
        if opt_keys:
            opt = {o.fingerprint: o for o in (await self.db.execute(
                select(CloudOptimizationFinding).where(
                    CloudOptimizationFinding.account_id == account_id,
                    CloudOptimizationFinding.fingerprint.in_(opt_keys)))).scalars().all()}
        sec = {}
        if sec_keys:
            sec = {s.fingerprint: s for s in (await self.db.execute(
                select(CloudSecurityFinding).where(
                    CloudSecurityFinding.account_id == account_id,
                    CloudSecurityFinding.fingerprint.in_(sec_keys)))).scalars().all()}
        out = []
        for r in rows:
            if r["source"] == SOURCE_OPT and r["key"] in opt:
                out.append(opt_card(opt[r["key"]]))
            elif r["source"] == SOURCE_SEC and r["key"] in sec:
                out.append(security_card(sec[r["key"]], can_view_raw=can_view_raw))
        return out

    # ═════════════════════════════════════════════════════════════════════════
    # Summary
    # ═════════════════════════════════════════════════════════════════════════

    async def summary(self, account_id: uuid.UUID) -> Dict[str, Any]:
        account = await self.accounts.get_by_id(account_id)
        if account is None:
            raise ValueError("Account not found")
        u = self._union(account_id)
        active = [u.c.status_group.in_(list(ACTIVE_STATUSES)),
                  or_(u.c.verdict.is_(None), u.c.verdict == "VULNERABLE")]

        async def count(*extra) -> int:
            return int((await self.db.execute(select(func.count()).select_from(u)
                                              .where(*active, *extra))).scalar() or 0)

        async def distinct_resources(signal: str) -> int:
            return int((await self.db.execute(
                select(func.count(func.distinct(u.c.resource_id))).select_from(u)
                .where(*active, u.c.source == SOURCE_OPT, u.c.signal == signal))).scalar() or 0)

        savings_rows = (await self.db.execute(
            select(u.c.currency, func.sum(u.c.savings), func.count()).select_from(u)
            .where(*active, u.c.source == SOURCE_OPT, u.c.savings.isnot(None))
            .group_by(u.c.currency))).all()
        unpriced = await count(u.c.source == SOURCE_OPT, u.c.savings.is_(None))
        undetermined = int((await self.db.execute(select(func.count()).select_from(
            CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id,
            CloudSecurityFinding.status.in_(["OPEN", "IN_PROGRESS"]),
            CloudSecurityFinding.verdict != "VULNERABLE",
            CloudSecurityFinding.category.notin_(list(SUPERSEDED_SECURITY_CATEGORIES))))).scalar() or 0)
        run = await self.repo.latest_run(account_id)
        assessment = (await self.db.execute(
            select(CloudSecurityAssessment).where(CloudSecurityAssessment.account_id == account_id)
            .order_by(CloudSecurityAssessment.finished_at.desc()).limit(1))).scalars().first()
        scan = await self._last_scan(account_id)
        regions = (await self.db.execute(
            select(CloudResource.region_or_zone, func.count()).where(
                CloudResource.account_id == account_id).group_by(CloudResource.region_or_zone)
            .order_by(func.count().desc()))).all()
        telemetry_at = (await self.db.execute(select(func.max(CloudResourceTelemetry.collected_at))
                                              .where(CloudResourceTelemetry.account_id == account_id))).scalar()

        cards = [
            {"id": "critical", "label": "Critical findings", "value": await count(u.c.severity == "CRITICAL"),
             "filter": {"severity": ["CRITICAL"]}},
            {"id": "high", "label": "High findings", "value": await count(u.c.severity == "HIGH"),
             "filter": {"severity": ["HIGH"]}},
            {"id": "optimization", "label": "Optimization opportunities",
             "value": await count(u.c.source == SOURCE_OPT), "filter": {"source": [SOURCE_OPT]}},
            {"id": "savings", "label": "Potential monthly savings",
             "value": None,
             "by_currency": {c: round(float(s), 2) for c, s, _ in savings_rows if c},
             "priced": sum(int(n) for _, _, n in savings_rows), "unpriced": unpriced,
             "filter": {"has_savings": True},
             "note": ("Sum of open findings whose saving is the resource's own billed cost or a "
                      "provider price-list calculation. Kept per currency; unpriced opportunities "
                      "are counted, never valued.")},
            {"id": "underutilized", "label": "Underutilized resources",
             "value": await distinct_resources("UNDERUTILIZED"), "filter": {"signal": ["UNDERUTILIZED"]}},
            {"id": "unused", "label": "Unused resources",
             "value": await distinct_resources("UNUSED"), "filter": {"signal": ["UNUSED"]}},
            {"id": "security", "label": "Security findings",
             "value": await count(u.c.source == SOURCE_SEC), "filter": {"source": [SOURCE_SEC]},
             "undetermined": undetermined},
            {"id": "analyzed", "label": "Resources analyzed",
             "value": run.resources_analyzed if run else None,
             "of": run.resources_total if run else None, "filter": None},
        ]
        return {
            "account": {"id": str(account.id), "name": account.account_name,
                        "provider": normalize_provider(account.provider) or account.provider,
                        "environment": account.environment},
            "regions": [{"region": r[0], "resources": int(r[1])} for r in regions if r[0]][:8],
            "last_scan": scan,
            "last_analysis": _run_view(run),
            "last_assessment": ({"at": _iso(assessment.finished_at), "outcome": assessment.outcome,
                                 "score": assessment.score, "grade": assessment.grade}
                                if assessment else None),
            "telemetry_collected_at": _iso(telemetry_at),
            "analysis_running": is_running(account_id),
            "cards": cards,
        }

    async def _last_scan(self, account_id) -> Optional[Dict[str, Any]]:
        from app.models.discovery_job import DiscoveryJob
        job = (await self.db.execute(
            select(DiscoveryJob).where(DiscoveryJob.account_id == account_id,
                                       DiscoveryJob.status.in_(["COMPLETED", "FAILED"]))
            .order_by(DiscoveryJob.completed_at.desc().nullslast()).limit(1))).scalars().first()
        if job is None:
            return None
        return {"at": _iso(job.completed_at), "status": job.status,
                "partial": bool(job.status == "COMPLETED" and job.error_detail),
                "resources": job.resources_found}

    # ═════════════════════════════════════════════════════════════════════════
    # One finding
    # ═════════════════════════════════════════════════════════════════════════

    async def finding_detail(self, account_id: uuid.UUID, source: str, key: str, *,
                             can_view_raw: bool = True) -> Optional[Dict[str, Any]]:
        if source == SOURCE_OPT:
            row = await self.repo.get(account_id, key)
            if row is None:
                return None
            out = opt_card(row, full=True)
            resource_id = row.resource_id
        elif source == SOURCE_SEC:
            from app.services.security_center_service import SecurityCenterService
            detail = await SecurityCenterService(self.db).finding_detail(account_id, key)
            if detail is None:
                return None
            row = (await self.db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id,
                CloudSecurityFinding.fingerprint == detail["fingerprint"]))).scalar_one()
            out = security_card(row, can_view_raw=can_view_raw, full=True)
            out["security"] = {k: detail.get(k) for k in (
                "compliance", "alerts", "timeline", "rule", "verdict_label", "affected_sample",
                "affected_count")}
            if not can_view_raw:
                out["security"]["affected_sample"] = [
                    {k: v for k, v in (s or {}).items() if k != "evidence"}
                    for s in (detail.get("affected_sample") or [])]
            resource_id = row.resource_id
        else:
            return None

        resource = await self.resources.get_by_id(resource_id) if resource_id else None
        out["resource_now"] = _resource_view(resource)
        out["telemetry"] = (await collector.load_series(self.db, resource.id)) if resource else []
        out["cost"] = await self._cost_view(resource)
        out["health"] = (await self.resource_health(account_id, resource.id)) if resource else None
        out["links"] = _links(resource, out)
        if source == SOURCE_OPT:
            out["outcome"] = await self._outcome_view(row, resource)
            out["rule"] = _rule_view(row.rule_id, row.rule_version)
        return out

    async def _cost_view(self, resource) -> Dict[str, Any]:
        if resource is None:
            return {"billed": None, "reason": "The resource is no longer in the inventory."}
        row = (await self.db.execute(select(CloudResourceCost).where(
            CloudResourceCost.resource_id == resource.id))).scalar_one_or_none()
        provider = None
        acc = await self.accounts.get_by_id(resource.account_id)
        if acc:
            provider = normalize_provider(acc.provider)
        billed = ({"amount": row.amount, "currency": row.currency, "period_days": row.period_days,
                   "fetched_at": _iso(row.fetched_at), "service": row.billed_service,
                   "source": _BILLING_LABEL.get(provider or "", "provider billing")}
                  if row and row.amount is not None else None)
        return {
            "billed": billed,
            "reason": None if billed else PriceBook().billing_gap(provider or ""),
            "daily": None,
            "daily_reason": ("A per-resource daily cost series is not stored: billing history "
                             "is kept per service, so only this resource's billed 30-day total "
                             "is known."),
        }

    async def _outcome_view(self, row: CloudOptimizationFinding, resource) -> Optional[Dict[str, Any]]:
        """What happened after — only from recorded facts."""
        res = row.resolution
        if row.status != RESOLVED or not res:
            return None
        from app.models.drift import CloudResourceChange
        changes = []
        if row.resource_id:
            start = _aware(row.first_detected_at) or datetime.now(timezone.utc) - timedelta(days=30)
            rows = (await self.db.execute(
                select(CloudResourceChange).where(
                    CloudResourceChange.resource_id == row.resource_id,
                    CloudResourceChange.detected_at >= start)
                .order_by(CloudResourceChange.detected_at).limit(25))).scalars().all()
            changes = [{"at": _iso(c.detected_at), "field": c.field_path,
                        "old": _norm_value(c.old_value), "new": _norm_value(c.new_value),
                        "summary": c.summary} for c in rows]
        cost = await self._cost_view(resource)
        before = (res.get("before") or {}).get("savings") or {}
        if res.get("kind") == "resource_removed":
            realized = (
                "The resource no longer exists, so its charge has stopped accruing."
                + (f" The saving it was expected to realise was {before['amount']:,.2f} "
                   f"{before.get('currency') or ''} a month ({before.get('method', '').lower().replace('_', ' ')})."
                   if before.get("amount") is not None else "")
                + " A billing window that starts after the removal confirms it; until then no "
                  "realized figure is claimed.")
        elif cost.get("billed"):
            realized = ("Billed cost over the last 30 days is now "
                        f"{cost['billed']['amount']:,.2f} {cost['billed']['currency']} (fetched "
                        f"{cost['billed']['fetched_at']}). That window still includes days before "
                        "the change, so it is not yet a like-for-like comparison.")
        else:
            realized = "No billed figure is available to compare against."
        return {
            "kind": res.get("kind"), "at": res.get("at"), "by": res.get("by"),
            "detail": res.get("detail"), "previous_status": res.get("previous_status"),
            "before": res.get("before"), "config_changes": changes,
            "resource_state": ("removed" if resource is None else resource.status),
            "cost_now": cost.get("billed"), "realized": realized, "note": res.get("note"),
        }

    # ═════════════════════════════════════════════════════════════════════════
    # Status
    # ═════════════════════════════════════════════════════════════════════════

    async def set_status(self, account_id: uuid.UUID, source: str, key: str, status: str,
                         reason: Optional[str], actor: Optional[str]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        if status not in STATUSES:
            return None, f"Unknown status {status!r}. Valid: {', '.join(STATUSES)}"
        if status in STATUS_REQUIRES_REASON and not (reason or "").strip():
            return None, "A reason is required to suppress a finding: it records why it was left in place."
        if source == SOURCE_OPT:
            row = await self.repo.set_status(account_id=account_id, key=key, status=status,
                                             reason=reason, actor=actor)
            if row is None:
                return None, "Finding not found"
            await self.db.commit()
            return opt_card(row), None
        if source == SOURCE_SEC:
            from app.services.security_center_service import SecurityCenterService
            native = {OPEN: "OPEN", ACKNOWLEDGED: "IN_PROGRESS", RESOLVED: "RESOLVED",
                      SUPPRESSED: "SUPPRESSED"}[status]
            row, err = await SecurityCenterService(self.db).set_finding_status(
                account_id=account_id, key=key, status=native, reason=reason, actor=actor)
            if err:
                return None, err
            fresh = (await self.db.execute(select(CloudSecurityFinding).where(
                CloudSecurityFinding.account_id == account_id,
                CloudSecurityFinding.fingerprint == row["fingerprint"]))).scalar_one()
            return security_card(fresh), None
        return None, f"Unknown source {source!r}"

    # ═════════════════════════════════════════════════════════════════════════
    # Health, coverage, runs, meta
    # ═════════════════════════════════════════════════════════════════════════

    async def resource_health(self, account_id: uuid.UUID, resource_id: uuid.UUID) -> Dict[str, Any]:
        resource = await self.resources.get_by_id(resource_id)
        if resource is None or resource.account_id != account_id:
            raise ValueError("Resource not found")
        opt_rows = await self.repo.for_resource(account_id, resource_id)
        sec_rows = (await self.db.execute(select(CloudSecurityFinding).where(
            CloudSecurityFinding.account_id == account_id,
            CloudSecurityFinding.resource_id == resource_id,
            CloudSecurityFinding.status.in_(["OPEN", "IN_PROGRESS"]),
            CloudSecurityFinding.category.notin_(list(SUPERSEDED_SECURITY_CATEGORIES))))).scalars().all()
        run = await self.repo.latest_run(account_id)
        evaluations = ((run.evaluations or {}).get(str(resource_id)) if run else None) or {}
        from app.security import registry as sec_reg
        from app.security.model import normalize_provider as sec_norm
        acc = await self.accounts.get_by_id(account_id)
        has_assessment = (await self.db.execute(select(func.count()).select_from(
            CloudSecurityAssessment).where(CloudSecurityAssessment.account_id == account_id))).scalar()
        sec_rules = sec_reg.rules_for(sec_norm(acc.provider) if acc else None, resource.resource_type) \
            if acc else []
        assessed = bool(has_assessment) and bool(sec_rules)
        out = health.score_resource(
            optimization_findings=[{"category": r.category, "signal": r.signal,
                                    "severity": r.severity, "rule_id": r.rule_id} for r in opt_rows],
            security_findings=[{"verdict": r.verdict, "severity": r.severity, "rule_id": r.rule_id,
                                "unified_category": unified_security_category(r.category)}
                               for r in sec_rows],
            evaluations=evaluations, security_assessed=assessed,
            security_reason=(None if assessed else
                             "No security check applies to this resource type."
                             if has_assessment else "No security assessment has run for this account."),
        )
        out["resource_id"] = str(resource_id)
        out["as_of"] = _iso(run.finished_at) if run else None
        return out

    async def coverage(self, account_id: uuid.UUID) -> Dict[str, Any]:
        run = await self.repo.latest_run(account_id)
        rules_out = []
        for rule in sorted(reg.RULES.values(), key=lambda r: (r.category, r.rule_id)):
            cov = ((run.coverage or {}).get(rule.rule_id) if run else None) or {}
            rules_out.append({
                "rule_id": rule.rule_id, "title": rule.title, "category": rule.category,
                "category_label": CATEGORY_LABEL.get(rule.category, rule.category),
                "providers": list(rule.providers), "resource_types": list(rule.resource_types),
                "evaluated": cov.get("evaluated", 0), "findings": cov.get("FINDING", 0),
                "clear": cov.get("CLEAR", 0), "insufficient": cov.get("INSUFFICIENT_DATA", 0),
                "not_applicable": cov.get("NOT_APPLICABLE", 0), "errors": cov.get("ERROR", 0),
                "reasons": cov.get("reasons", []),
            })
        return {
            "run": _run_view(run),
            "rules": rules_out,
            "telemetry": (run.telemetry if run else None),
            "inputs": (run.inputs if run else None),
            "not_measurable": NOT_MEASURABLE,
        }

    async def runs(self, account_id: uuid.UUID, limit: int = 20) -> Dict[str, Any]:
        return {"runs": [_run_view(r) for r in await self.repo.runs(account_id, limit=limit)]}

    async def telemetry(self, account_id: uuid.UUID, resource_id: uuid.UUID) -> Dict[str, Any]:
        resource = await self.resources.get_by_id(resource_id)
        if resource is None or resource.account_id != account_id:
            raise ValueError("Resource not found")
        return {"resource_id": str(resource_id), "metrics": await collector.load_series(self.db, resource_id)}


# ── Views ─────────────────────────────────────────────────────────────────────

# Things the spec asks about that no provider API publishes without an agent.
# Listed so the coverage panel says so, rather than leaving an empty space.
NOT_MEASURABLE = [
    {"what": "Guest filesystem usage (how full a volume is)",
     "why": "Block-storage services report provisioned size and I/O, not used space; that needs "
            "an agent inside the instance."},
    {"what": "Memory utilization on AWS EC2",
     "why": "Published only by the CloudWatch agent (CWAgent namespace)."},
    {"what": "GPU utilization",
     "why": "Needs the provider agent's GPU plugin on all three clouds."},
    {"what": "Lambda memory actually used",
     "why": "Reported per invocation in REPORT log lines or by Lambda Insights, not as a metric."},
    {"what": "Per-resource daily cost series",
     "why": "Billing history is stored per service; per-resource cost is a 30-day total."},
    {"what": "AWS per-resource cost",
     "why": "Cost Explorer has no per-resource dimension; it needs a Cost and Usage Report."},
    {"what": "Object access frequency on OCI buckets",
     "why": "OCI Object Storage publishes no request-count metric per bucket."},
    {"what": "Kubernetes pod requests and limits",
     "why": "Read from the cluster API, which is not collected."},
]


def _highlights(evidence: Sequence[Dict[str, Any]], limit: int = 6) -> List[Dict[str, Any]]:
    out = []
    for e in evidence or []:
        if len(out) >= limit:
            break
        out.append({"label": e.get("label"), "display": e.get("display")
                    or (str(e.get("value")) if e.get("value") is not None else "N/A"),
                    "detail": e.get("detail"), "kind": e.get("kind")})
    return out


def opt_card(row: CloudOptimizationFinding, *, full: bool = False) -> Dict[str, Any]:
    d = row.to_dict()
    card = {
        "source": SOURCE_OPT, "key": row.fingerprint, "id": d["id"],
        "title": row.title, "description": row.description, "severity": row.severity,
        "category": row.category, "category_label": CATEGORY_LABEL.get(row.category, row.category),
        "signal": row.signal, "status": row.status, "status_group": row.status,
        "status_label": STATUS_LABEL.get(row.status, row.status),
        "provider": row.provider, "rule_id": row.rule_id,
        "resource": {"id": d["resource_id"], "name": row.resource_name, "type": row.resource_type,
                     "region": row.region, "key": row.resource_key},
        "first_detected_at": d["first_detected_at"], "last_detected_at": d["last_detected_at"],
        "confidence": row.confidence,
        "confidence_label": CONFIDENCE_LABEL.get(row.confidence, row.confidence),
        "recommendation": row.recommendation,
        "savings": d["savings"],
        "current": row.current_configuration or {},
        "highlights": _highlights(row.evidence),
        "risk": row.risk, "effort": row.effort,
        "safety_verdict": (row.safety or {}).get("verdict"),
        "last_check": row.last_check,
    }
    if full:
        card.update({k: d[k] for k in (
            "rationale", "remediation", "confidence_reasons", "evidence", "current_configuration",
            "recommended_configuration", "data_sources", "metrics_used", "risk_notes", "impact",
            "safety", "status_reason", "status_changed_by", "status_changed_at",
            "last_verified_at", "resolved_at", "resolution", "detection_count", "previous_severity",
            "severity_changed_at", "history", "rule_version", "analysis_run_id")})
        if card["safety"]:
            card["safety"] = {**card["safety"], "label": SAFETY_LABEL.get(card["safety"].get("verdict"))}
    return card


def security_card(row: CloudSecurityFinding, *, can_view_raw: bool = True,
                  full: bool = False) -> Dict[str, Any]:
    group = SECURITY_STATUS_GROUP.get(row.status, OPEN)
    from app.security.model import STATUS_LABEL as SEC_STATUS_LABEL, VERDICT_LABEL
    cat = unified_security_category(row.category)
    card = {
        "source": SOURCE_SEC, "key": row.fingerprint, "id": str(row.id),
        "title": row.title, "description": row.description, "severity": row.severity,
        "category": cat, "category_label": CATEGORY_LABEL.get(cat, cat),
        "subcategory": row.category, "signal": None,
        "status": row.status, "status_group": group,
        "status_label": SEC_STATUS_LABEL.get(row.status, row.status),
        "provider": row.provider, "rule_id": row.rule_id,
        "resource": {"id": str(row.resource_id) if row.resource_id else None,
                     "name": row.resource_name, "type": row.resource_type, "region": row.region,
                     "key": row.resource_key},
        "first_detected_at": _iso(row.first_detected_at),
        "last_detected_at": _iso(row.last_detected_at),
        "confidence": row.confidence, "verdict": row.verdict,
        "verdict_label": VERDICT_LABEL.get(row.verdict, row.verdict),
        "recommendation": row.remediation,
        "savings": {"amount": None, "currency": None, "method": "NONE", "priced": False,
                    "reason": "A security finding; its value is risk reduction, not a saving."},
        "compliance_frameworks": sorted((row.compliance or {}).keys()),
        "affected_count": row.affected_count,
    }
    if full:
        card.update({
            "rationale": row.rationale, "remediation": row.remediation,
            "evidence_raw": (row.evidence if can_view_raw
                             else {"_withheld": "Requires the security:view_raw permission."}),
            "status_reason": row.status_reason, "status_changed_by": row.status_changed_by,
            "status_changed_at": _iso(row.status_changed_at),
            "detection_count": row.detection_count, "resolved_at": _iso(row.resolved_at),
            "rule_version": row.rule_version,
        })
    return card


def _resource_view(resource) -> Optional[Dict[str, Any]]:
    if resource is None:
        return None
    return {"id": str(resource.id), "name": resource.resource_name, "type": resource.resource_type,
            "status": resource.status, "normalized_status": resource.normalized_status,
            "region": resource.region_or_zone, "provider_resource_id": resource.provider_resource_id,
            "environment": resource.environment, "owner": resource.owner,
            "last_seen_at": _iso(resource.last_seen_at), "discovered_at": _iso(resource.discovered_at),
            "tag_count": resource.tag_count}


def _links(resource, card) -> Dict[str, Any]:
    """Hand-offs to the tabs that own each view — query strings only."""
    if resource is None:
        return {}
    rid, name = str(resource.id), resource.resource_name or ""
    q = f"?resource={rid}&resourceName={name}&range=30d"
    alert = ({"condition": "security_finding_count",
              "config": {"severity_filter": card.get("severity") or "ANY", "operator": "greater_than",
                         "threshold": 0}}
             if card.get("source") == SOURCE_SEC else
             {"condition": "intelligence_finding_count",
              "config": {"category_filter": card.get("category") or "ANY",
                         "severity_filter": card.get("severity") or "ANY",
                         "operator": "greater_than", "threshold": 0}})
    return {
        "resource": f"/cloud/resources/{rid}",
        "monitoring": f"/cloud/resources/{rid}/metrics",
        "cost": {"tab": "cost", "query": f"?resource={rid}"},
        "drift": {"tab": "drift", "query": q},
        "events": {"tab": "events", "query": q},
        "topology": {"tab": "topology", "query": f"?focus={rid}"},
        "alert": alert,
    }


def _rule_view(rule_id: str, version: str) -> Optional[Dict[str, Any]]:
    rule = reg.by_id(rule_id)
    if rule is None:
        return {"rule_id": rule_id, "finding_version": version, "current_version": None,
                "retired": True}
    return {"rule_id": rule_id, "finding_version": version, "current_version": rule.version,
            "version_changed_since": rule.version != version, "title": rule.title,
            "description": rule.description, "rationale": rule.rationale,
            "metrics": list(rule.metrics),
            "thresholds": THRESHOLDS}


def _run_view(run: Optional[CloudOptimizationRun]) -> Optional[Dict[str, Any]]:
    if run is None:
        return None
    return {"id": str(run.id), "at": _iso(run.finished_at), "started_at": _iso(run.started_at),
            "outcome": run.outcome, "triggered_by": run.triggered_by,
            "duration_ms": run.duration_ms, "resources_total": run.resources_total,
            "resources_analyzed": run.resources_analyzed, "rules_evaluated": run.rules_evaluated,
            "findings_open": run.findings_open, "findings_new": run.findings_new,
            "findings_resolved": run.findings_resolved,
            "savings_by_currency": run.savings_by_currency or {},
            "incomplete_reasons": run.incomplete_reasons or []}


def meta() -> Dict[str, Any]:
    from app.optimization.health import METHODOLOGY
    return {
        "categories": [{"id": c, "label": CATEGORY_LABEL[c], "meaning": CATEGORY_MEANING[c],
                        "source": "security" if c in (SECURITY, COMPLIANCE) else "optimization"}
                       for c in CATEGORIES],
        "security_category_map": SECURITY_CATEGORY_MAP,
        "superseded_security_categories": sorted(SUPERSEDED_SECURITY_CATEGORIES),
        "severities": list(SEVERITIES),
        "statuses": [{"id": s, "label": STATUS_LABEL[s]} for s in STATUSES],
        "signals": list(SIGNALS),
        "savings_methods": list(SAVINGS_METHODS),
        "thresholds": THRESHOLDS,
        "health_methodology": METHODOLOGY,
        "rules": [{"rule_id": r.rule_id, "version": r.version, "title": r.title,
                   "category": r.category, "signal": r.signal, "severity": r.severity,
                   "providers": list(r.providers), "resource_types": list(r.resource_types),
                   "metrics": list(r.metrics), "description": r.description,
                   "rationale": r.rationale, "supersedes": list(r.supersedes)}
                  for r in sorted(reg.RULES.values(), key=lambda x: x.rule_id)],
        "not_measurable": NOT_MEASURABLE,
    }
