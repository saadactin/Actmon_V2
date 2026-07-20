"""OCI list-price lookups from OCI's public Price List API (no auth required).

Used to turn cost-optimization recommendations into *real* monthly savings
estimates. Every number this module returns is a genuine published OCI list
price — never invented. Two honesty rules for callers:

  1. These are PUBLIC LIST prices at the PAY_AS_YOU_GO rate, not the customer's
     negotiated/committed-use rate, so the real saving is "at most" this figure.
     The UI must disclose that.
  2. If the price API is unreachable, functions return None and the caller must
     surface NA rather than guessing.

Prices are cached in-process for a day — OCI list prices change rarely and the
public endpoint is rate-limited.

Reference (verified against OCI's published USD list, FX ≈ ₹95/USD):
  Block volume storage capacity  B91961  ₹2.42256375 /GB-month   ($0.0255)
  Block volume performance unit  B91962  ₹0.16150425 /VPU-GB-mo  ($0.0017)
    → Balanced default = 10 VPU/GB → ₹4.0376 /GB-mo total ($0.0425), matches OCI.
  Autonomous DB storage (DW/ECPU) B95754 ₹2.84057475 /GB-month   ($0.0299)
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger("cloud_svc.oci.pricing")

_PRICE_API = "https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/"

# Part numbers we need for the OCI optimization rules.
BLOCK_VOLUME_STORAGE = "B91961"  # ₹/GB-month  (metric: Gigabyte Storage Capacity Per Month)
BLOCK_VOLUME_PERF = "B91962"     # ₹/VPU per GB-month (metric: Performance Units Per Gigabyte Per Month)
ADB_STORAGE = "B95754"           # ₹/GB-month  (metric: Gigabyte Storage Capacity Per Month)

_PARTS = [BLOCK_VOLUME_STORAGE, BLOCK_VOLUME_PERF, ADB_STORAGE]

# OCI's default Balanced block-volume elastic performance = 10 VPUs/GB.
BALANCED_VPU = 10
# ADB provisions storage in TB; OCI bills the storage metric per GB at 1 TB = 1024 GB.
GB_PER_TB = 1024

_CACHE_TTL_SECONDS = 24 * 3600
_cache: Dict[str, Tuple[float, Dict[str, Dict[str, Any]]]] = {}


async def _fetch_part(client: httpx.AsyncClient, part: str, currency: str) -> Optional[Dict[str, Any]]:
    """Return {'value', 'metric', 'model', 'currency'} for one part, or None."""
    try:
        resp = await client.get(_PRICE_API, params={"currencyCode": currency, "partNumber": part})
        resp.raise_for_status()
        items = resp.json().get("items") or []
        if not items:
            return None
        item = items[0]
        loc = next(
            (c for c in item.get("currencyCodeLocalizations", []) if c.get("currencyCode") == currency),
            None,
        )
        prices = (loc or {}).get("prices") or []
        # Prefer the pay-as-you-go model; fall back to the first listed price.
        payg = next((p for p in prices if p.get("model") == "PAY_AS_YOU_GO"), None) or (prices[0] if prices else None)
        if not payg or payg.get("value") is None:
            return None
        return {
            "value": float(payg["value"]),
            "metric": item.get("metricName"),
            "model": payg.get("model"),
            "currency": currency,
        }
    except Exception as exc:
        logger.warning("OCI price lookup failed for %s (%s): %s", part, currency, exc)
        return None


async def get_prices(currency: str = "INR") -> Dict[str, Dict[str, Any]]:
    """Return {partNumber: {value, metric, model, currency}} for the parts we
    price. Missing parts are simply absent from the dict (callers treat as NA).
    Cached per-currency for a day."""
    currency = (currency or "INR").upper()
    cached = _cache.get(currency)
    if cached and time.time() - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]

    prices: Dict[str, Dict[str, Any]] = {}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            for part in _PARTS:
                info = await _fetch_part(client, part, currency)
                if info:
                    prices[part] = info
    except Exception as exc:
        logger.warning("OCI price API unreachable (%s): %s", currency, exc)

    # Only cache a full result; a partial/empty fetch should be retried next call.
    if len(prices) == len(_PARTS):
        _cache[currency] = (time.time(), prices)
    return prices


# ── Breakdown builders ────────────────────────────────────────────────────────
# Each returns (monthly_total | None, [line-item dicts]). Line items feed the
# "show the math" table in the recommendation detail popup.

def block_volume_breakdown(
    gb: Optional[float],
    prices: Dict[str, Dict[str, Any]],
    *,
    vpu: int = BALANCED_VPU,
    label: str = "Block volume",
) -> Tuple[Optional[float], List[Dict[str, Any]]]:
    """Monthly cost of `gb` of Balanced block/boot volume storage."""
    s = prices.get(BLOCK_VOLUME_STORAGE)
    p = prices.get(BLOCK_VOLUME_PERF)
    if gb is None or gb <= 0 or not s or not p:
        return None, []
    storage_cost = round(gb * s["value"], 2)
    perf_cost = round(gb * vpu * p["value"], 2)
    lines = [
        {
            "component": f"{label} — storage capacity",
            "quantity": round(gb, 2),
            "unit": "GB-month",
            "unit_price": s["value"],
            "monthly_cost": storage_cost,
            "note": f"{round(gb, 2)} GB provisioned",
        },
        {
            "component": f"{label} — performance ({vpu} VPU/GB, Balanced)",
            "quantity": round(gb * vpu, 2),
            "unit": "VPU-GB-month",
            "unit_price": p["value"],
            "monthly_cost": perf_cost,
            "note": f"{round(gb, 2)} GB × {vpu} VPU (OCI Balanced default)",
        },
    ]
    return round(storage_cost + perf_cost, 2), lines


def adb_storage_breakdown(
    tbs: Optional[float],
    prices: Dict[str, Dict[str, Any]],
    *,
    label: str = "Autonomous DB storage",
) -> Tuple[Optional[float], List[Dict[str, Any]]]:
    """Monthly cost of `tbs` TB of Autonomous Database storage."""
    a = prices.get(ADB_STORAGE)
    if tbs is None or tbs <= 0 or not a:
        return None, []
    gb = tbs * GB_PER_TB
    cost = round(gb * a["value"], 2)
    lines = [
        {
            "component": label,
            "quantity": round(gb, 2),
            "unit": "GB-month",
            "unit_price": a["value"],
            "monthly_cost": cost,
            "note": f"{tbs} TB × {GB_PER_TB} GB/TB",
        }
    ]
    return cost, lines
