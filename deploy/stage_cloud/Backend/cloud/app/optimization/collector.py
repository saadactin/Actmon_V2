"""Telemetry collection: plan, fetch, summarise, persist.

The orchestration half of roadmap item 1.2 (the metrics store). The provider
modules know how each monitoring API wants to be asked; this module knows what
to do with the answers, identically for all three:

* every series goes through `telemetry.summarize()` — one definition of P95,
  one definition of coverage, one rule that a gap is not a zero;
* every planned metric produces exactly one row, whatever happened, so the UI
  can always say "collected", "no datapoints", "not permitted" or "not
  published" rather than showing an empty chart with no sentence behind it;
* a resource created inside the window is measured from its creation, not
  from 30 days ago — otherwise a two-day-old VM reads as 7% "coverage" and a
  rule refuses to analyse it for the wrong reason.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.optimization import CloudResourceTelemetry
from app.optimization import collect_aws, collect_azure, collect_oci
from app.optimization.collect_common import (
    HOUR, WINDOW_DAYS, RawMetric, ResourcePlan,
)
from app.optimization.model import AWS, AZURE, OCI, normalize_provider
from app.optimization.telemetry import (
    ST_ERROR, ST_OK, STATUSES, MetricResult, ResourceTelemetry, summarize,
)

logger = logging.getLogger("cloud_svc.optimization.collector")

_MODULES = {AWS: collect_aws, AZURE: collect_azure, OCI: collect_oci}
_CHUNK = 400   # rows per upsert; 14 columns x 400 stays far below asyncpg's 32,767 binds


@dataclass
class CollectionOutcome:
    provider: Optional[str]
    window_start: Optional[datetime]
    window_end: Optional[datetime]
    telemetry: Dict[str, ResourceTelemetry] = field(default_factory=dict)
    facts: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    rows: List[Dict[str, Any]] = field(default_factory=list)
    stats: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    @property
    def planned_resources(self) -> int:
        return len(self.telemetry)

    def summary(self) -> Dict[str, Any]:
        """Per metric: how many resources returned each status."""
        per: Dict[str, Dict[str, int]] = {}
        for rt in self.telemetry.values():
            for key, res in rt.metrics.items():
                per.setdefault(key, {s: 0 for s in STATUSES})[res.status] += 1
        return {
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "resources": len(self.telemetry),
            "metrics": per,
            # Capacity catalogs are inputs to the rules, not telemetry, and the
            # Azure one lists over a thousand sizes — kept out of the run record.
            "provider_api": {k: v for k, v in self.stats.items()
                             if k not in ("catalogs", "shapes", "instance_types")},
            "error": self.error,
        }


def plan_for(provider: Optional[str], resources: Sequence[Any]) -> List[ResourcePlan]:
    module = _MODULES.get(provider or "")
    if module is None:
        return []
    plans = []
    for r in resources:
        try:
            p = module.plan(r)
        except Exception as exc:  # noqa: BLE001  — one bad row must not stop collection
            logger.warning("Telemetry plan failed for %s: %s", getattr(r, "id", "?"), exc)
            continue
        if p is not None:
            plans.append(p)
    return plans


def _created_at(resource) -> Optional[datetime]:
    meta = getattr(resource, "metadata_", None) or {}
    raw = meta.get("time_created")
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def assemble(plans: Sequence[ResourcePlan], raw: Dict[Any, RawMetric], *,
             start: datetime, end: datetime, collected_at: datetime) -> CollectionOutcome:
    """Raw provider answers → summarised telemetry + rows to persist. Pure."""
    out = CollectionOutcome(provider=None, window_start=start, window_end=end)
    stamp = collected_at.isoformat()
    for rp in plans:
        rid = rp.resource_id
        rt = ResourceTelemetry(collected_at=stamp)
        created = _created_at(rp.resource)
        win_start = max(start, created) if created and created > start else start
        keys = [mp.metric for mp in rp.metrics] + list(rp.skipped) + list(rp.not_collected)
        for key in dict.fromkeys(keys):
            rm = raw.get((rid, key)) or RawMetric(
                ST_ERROR, reason="The collector produced no result for this metric.")
            stats = None
            if rm.status == ST_OK:
                stats = summarize(key, rm.points, window_start=win_start, window_end=end,
                                  granularity_seconds=rm.granularity or HOUR, peaks=rm.peaks)
                if created and created > start:
                    stats["measured_from_creation"] = created.isoformat()
            rt.metrics[key] = MetricResult(metric=key, status=rm.status, stats=stats,
                                           source=rm.source, reason=rm.reason,
                                           collected_at=stamp)
            out.rows.append({
                "resource_id": uuid.UUID(rid),
                "metric": key,
                "status": rm.status,
                "reason": rm.reason,
                "source": rm.source,
                "window_days": WINDOW_DAYS,
                "window_start": win_start,
                "window_end": end,
                "granularity_seconds": rm.granularity or HOUR,
                "samples": (stats or {}).get("samples", 0),
                "stats": stats,
                "series": _compact(rm.points),
                "peak_series": _compact(rm.peaks) if rm.peaks else None,
                "collected_at": collected_at,
            })
        out.telemetry[rid] = rt
        if rp.facts:
            out.facts[rid] = dict(rp.facts)
    return out


def _compact(points: Optional[Iterable]) -> List[List[float]]:
    """[(ts, v)] → [[epoch_seconds, v]]: a quarter of the size of ISO strings,
    and the chart only needs a number on each axis."""
    if not points:
        return []
    out = []
    for ts, v in points:
        if ts is None or v is None:
            continue
        t = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        out.append([int(t.timestamp()), round(float(v), 4)])
    out.sort(key=lambda p: p[0])
    return out


async def collect(account, resources: Sequence[Any], *,
                  now: Optional[datetime] = None) -> CollectionOutcome:
    """Collect 30 days of telemetry for every resource this provider can
    measure. Never raises for a provider failure — that is recorded per metric."""
    from app.utils.encryption import decrypt_credentials

    provider = normalize_provider(getattr(account, "provider", None))
    end = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(days=WINDOW_DAYS)
    plans = plan_for(provider, resources)
    if provider not in _MODULES:
        return CollectionOutcome(provider=provider, window_start=start, window_end=end,
                                 error=f"No telemetry collector for provider {account.provider!r}.")
    if not plans:
        return CollectionOutcome(provider=provider, window_start=start, window_end=end)
    try:
        creds = decrypt_credentials(account.credentials_enc)
    except Exception as exc:  # noqa: BLE001
        raw = {(rp.resource_id, mp.metric): RawMetric(
            ST_ERROR, reason=f"The account's stored credentials could not be decrypted: {exc}")
            for rp in plans for mp in rp.metrics}
        outcome = assemble(plans, raw, start=start, end=end,
                           collected_at=datetime.now(timezone.utc))
        outcome.provider = provider
        outcome.error = "Credentials could not be decrypted."
        return outcome

    raw, stats = await _MODULES[provider].fetch(creds, plans, start=start, end=end)
    outcome = assemble(plans, raw, start=start, end=end,
                       collected_at=datetime.now(timezone.utc))
    outcome.provider = provider
    outcome.stats = stats or {}
    return outcome


async def persist(db: AsyncSession, account_id: uuid.UUID, provider: str,
                  rows: Sequence[Dict[str, Any]]) -> int:
    """Upsert one row per (resource, metric). Flushes; the caller commits."""
    written = 0
    for i in range(0, len(rows), _CHUNK):
        chunk = [{**r, "id": uuid.uuid4(), "account_id": account_id, "provider": provider}
                 for r in rows[i:i + _CHUNK]]
        stmt = pg_insert(CloudResourceTelemetry).values(chunk)
        excluded = stmt.excluded
        stmt = stmt.on_conflict_do_update(
            constraint="uq_resource_telemetry_metric",
            set_={c: getattr(excluded, c) for c in (
                "status", "reason", "source", "window_days", "window_start", "window_end",
                "granularity_seconds", "samples", "stats", "series", "peak_series",
                "collected_at", "account_id", "provider")},
        )
        await db.execute(stmt)
        written += len(chunk)
    await db.flush()
    return written


async def load(db: AsyncSession, account_id: uuid.UUID,
               resource_ids: Optional[Sequence[uuid.UUID]] = None) -> Dict[str, ResourceTelemetry]:
    """Stored telemetry as the rules read it — statistics only, no series."""
    stmt = select(
        CloudResourceTelemetry.resource_id, CloudResourceTelemetry.metric,
        CloudResourceTelemetry.status, CloudResourceTelemetry.stats,
        CloudResourceTelemetry.source, CloudResourceTelemetry.reason,
        CloudResourceTelemetry.collected_at,
    ).where(CloudResourceTelemetry.account_id == account_id)
    if resource_ids:
        stmt = stmt.where(CloudResourceTelemetry.resource_id.in_(list(resource_ids)))
    out: Dict[str, ResourceTelemetry] = {}
    for row in (await db.execute(stmt)).all():
        rid = str(row.resource_id)
        rt = out.setdefault(rid, ResourceTelemetry(
            collected_at=row.collected_at.isoformat() if row.collected_at else None))
        rt.metrics[row.metric] = MetricResult(
            metric=row.metric, status=row.status, stats=row.stats, source=row.source,
            reason=row.reason,
            collected_at=row.collected_at.isoformat() if row.collected_at else None)
    return out


async def load_series(db: AsyncSession, resource_id: uuid.UUID) -> List[Dict[str, Any]]:
    rows = (await db.execute(
        select(CloudResourceTelemetry).where(CloudResourceTelemetry.resource_id == resource_id)
    )).scalars().all()
    return [r.to_dict(include_series=True) for r in rows]
