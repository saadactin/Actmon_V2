"""Observability for the cost feature, and provider-aware rate limiting.

**Metrics** are in-process counters, not a Prometheus client, because this
service has no metrics endpoint and adding a dependency to expose numbers
nobody scrapes yet would be the wrong trade. They are exposed over the existing
diagnostics API instead. The shape matches what a Prometheus exporter would
want, so wiring one up later is a mapping exercise rather than a rewrite.

**The Azure semaphore is the load-bearing part.** Azure Cost Management
throttles hard, and this service fans out across accounts concurrently: three
Azure subscriptions refreshing at once means three simultaneous Cost Management
queries, which is exactly the burst that triggers a 429 and then costs every
one of them a retry. Serialising Azure — and only Azure — turns a burst that
fails into a queue that succeeds slightly later. AWS and OCI are not gated,
because neither throttled in practice and a needless lock would just make a
three-provider refresh as slow as its most serialised member.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

logger = logging.getLogger("cloud_svc.cost.metrics")

# ── Provider concurrency ──────────────────────────────────────────────────────
# 1 for Azure: strictly one Cost Management query in flight at a time across the
# whole process, whatever the subscription. Measured against a real estate with
# three Azure subscriptions, where concurrent refreshes produced 429s on two of
# them and a backfill that failed three of six windows.
_PROVIDER_CONCURRENCY = {"AZURE": 1}
_semaphores: Dict[str, asyncio.Semaphore] = {}
_semaphore_lock: Optional[asyncio.Lock] = None


def _limit_for(provider: str) -> Optional[int]:
    return _PROVIDER_CONCURRENCY.get((provider or "").upper())


async def _get_semaphore(provider: str) -> Optional[asyncio.Semaphore]:
    limit = _limit_for(provider)
    if limit is None:
        return None
    global _semaphore_lock
    if _semaphore_lock is None:
        _semaphore_lock = asyncio.Lock()
    key = provider.upper()
    async with _semaphore_lock:
        if key not in _semaphores:
            _semaphores[key] = asyncio.Semaphore(limit)
        return _semaphores[key]


@asynccontextmanager
async def provider_slot(provider: str):
    """Hold a concurrency slot for a throttle-prone provider.

    A no-op for providers with no configured limit, so the common path adds
    nothing but a dict lookup. Time spent waiting is recorded separately from
    time spent querying — otherwise a queue looks like a slow provider, and the
    fix for those two is completely different.
    """
    semaphore = await _get_semaphore(provider)
    if semaphore is None:
        yield
        return

    waited_from = time.monotonic()
    async with semaphore:
        waited = time.monotonic() - waited_from
        if waited > 0.1:
            record(provider, "queue_wait_seconds", waited)
            logger.debug("Waited %.2fs for a %s cost slot", waited, provider)
        yield


# ── Metrics ───────────────────────────────────────────────────────────────────
# {provider: {metric: value}}. Counters accumulate; *_seconds metrics keep a
# running total plus a count so a mean can be derived without storing samples.
_counters: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

COUNTERS = (
    "billing_api_calls",
    "billing_api_errors",
    "billing_api_429",
    "billing_records_received",
    "billing_records_matched",
    "billing_records_unmatched",
    "cache_hits",
    "cache_misses",
    "ingestion_facts_written",
    "ingestion_facts_updated",
)


def record(provider: Optional[str], metric: str, value: float = 1.0) -> None:
    """Add to a counter. Never raises — an observability failure must not take
    down the thing it is observing."""
    try:
        _counters[(provider or "UNKNOWN").upper()][metric] += float(value)
        if metric.endswith("_seconds"):
            _counters[(provider or "UNKNOWN").upper()][f"{metric}_count"] += 1
    except Exception:  # pragma: no cover - defensive
        logger.debug("Could not record metric %s", metric, exc_info=True)


def observe_duration(provider: Optional[str], metric: str, seconds: float) -> None:
    record(provider, metric, seconds)


def snapshot() -> Dict[str, Any]:
    """Current counters, with derived rates. Safe to call at any time."""
    out: Dict[str, Any] = {}
    for provider, metrics in _counters.items():
        block = {k: round(v, 4) for k, v in metrics.items()}

        calls = metrics.get("billing_api_calls", 0)
        errors = metrics.get("billing_api_errors", 0)
        hits = metrics.get("cache_hits", 0)
        misses = metrics.get("cache_misses", 0)
        matched = metrics.get("billing_records_matched", 0)
        unmatched = metrics.get("billing_records_unmatched", 0)

        # Rates are None, not 0, when the denominator is zero: "0% errors"
        # from zero calls is a claim about nothing.
        block["error_rate_percent"] = (
            round(errors / calls * 100, 2) if calls else None
        )
        block["throttle_rate_percent"] = (
            round(metrics.get("billing_api_429", 0) / calls * 100, 2) if calls else None
        )
        block["cache_hit_rate_percent"] = (
            round(hits / (hits + misses) * 100, 2) if (hits + misses) else None
        )
        block["attribution_percent"] = (
            round(matched / (matched + unmatched) * 100, 2)
            if (matched + unmatched) else None
        )
        for key in list(block):
            if key.endswith("_seconds"):
                count = metrics.get(f"{key}_count", 0)
                block[f"{key}_mean"] = round(block[key] / count, 4) if count else None
        out[provider] = block

    return {
        "providers": out,
        "concurrency_limits": dict(_PROVIDER_CONCURRENCY),
        "note": (
            "In-process counters since this worker started. They reset on "
            "restart and are not aggregated across workers — they are a "
            "diagnostic, not a billing record."
        ),
    }


def reset() -> None:
    """Only for tests."""
    _counters.clear()


def structured_log(
    *,
    provider: Optional[str],
    account_id: Optional[str],
    operation: str,
    duration_seconds: Optional[float] = None,
    status: str = "ok",
    record_count: Optional[int] = None,
    partial: bool = False,
    error_category: Optional[str] = None,
    date_range: Optional[str] = None,
) -> None:
    """One structured line per billing operation (141).

    Deliberately takes named fields rather than a free-form message, so no
    caller can interpolate a credential into it by accident. Nothing here is
    ever a secret: provider, account id, operation, timing and outcome only.
    """
    logger.info(
        "cost_op provider=%s account=%s operation=%s range=%s duration=%.3fs "
        "status=%s records=%s partial=%s error=%s",
        provider, account_id, operation, date_range or "-",
        duration_seconds or 0.0, status,
        record_count if record_count is not None else "-",
        partial, error_category or "-",
    )
