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


# ── Compute and other tiered parts (Resource Intelligence) ───────────────────
# Flex shapes bill OCPUs and memory separately, per hour. The part numbers were
# confirmed against this same public API on 2026-09-30 (display names below),
# and every lookup re-checks the display name, so a part that is renumbered or
# repurposed yields NA instead of a price for the wrong thing.
FLEX_SHAPE_PARTS: Dict[str, Dict[str, Any]] = {
    # The token is the family as OCI names it — "Standard - X9" and
    # "Optimized - X9" are different price lines, so a bare "X9" would let one
    # family's part verify against the other's.
    "VM.Standard.E3.Flex": {"ocpu": "B92306", "memory": "B92307", "token": "Standard - E3"},
    "VM.Standard.E4.Flex": {"ocpu": "B93113", "memory": "B93114", "token": "Standard - E4"},
    "VM.Standard.E5.Flex": {"ocpu": "B97384", "memory": "B97385", "token": "Standard - E5"},
    "VM.Standard3.Flex": {"ocpu": "B94176", "memory": "B94177", "token": "Standard - X9"},
    "VM.Optimized3.Flex": {"ocpu": "B93311", "memory": "B93312", "token": "Optimized - X9"},
    "VM.Standard.A1.Flex": {"ocpu": "B93297", "memory": "B93298", "token": "Standard - A1"},
}
# Hours in an average month (8,760 / 12). Stated wherever it is used.
HOURS_PER_MONTH = 730

_tier_cache: Dict[Tuple[str, str], Tuple[float, Optional[Dict[str, Any]]]] = {}


async def get_part(part: str, currency: str = "INR") -> Optional[Dict[str, Any]]:
    """One part at its PAID pay-as-you-go rate, with its published name.

    Several parts list a free-tier price of 0 before the paid rate (A1
    compute, Object Storage, the first load balancer). The first-listed price
    — what `_fetch_part` returns, correctly, for the single-rate block storage
    parts — would price those at zero. This returns the highest PAYG rate and
    says a free allowance exists, so a saving is never computed at 0.
    """
    currency = (currency or "INR").upper()
    cached = _tier_cache.get((currency, part))
    if cached and time.time() - cached[0] < _CACHE_TTL_SECONDS:
        return cached[1]
    info: Optional[Dict[str, Any]] = None
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(_PRICE_API, params={"currencyCode": currency,
                                                        "partNumber": part})
            resp.raise_for_status()
            items = resp.json().get("items") or []
        if items:
            item = items[0]
            loc = next((c for c in item.get("currencyCodeLocalizations", [])
                        if c.get("currencyCode") == currency), None)
            payg = [p for p in ((loc or {}).get("prices") or [])
                    if p.get("model") == "PAY_AS_YOU_GO" and p.get("value") is not None]
            if payg:
                paid = max(payg, key=lambda p: float(p["value"]))
                info = {
                    "part": part,
                    "value": float(paid["value"]),
                    "display_name": item.get("displayName"),
                    "metric": item.get("metricName"),
                    "currency": currency,
                    "free_tier": any(float(p["value"]) == 0 for p in payg),
                }
    except Exception as exc:  # noqa: BLE001
        logger.warning("OCI price lookup failed for %s (%s): %s", part, currency, exc)
        return None   # not cached: retried next time
    _tier_cache[(currency, part)] = (time.time(), info)
    return info


async def flex_rates(shape: str, currency: str = "INR") -> Optional[Dict[str, Any]]:
    """OCPU-hour and GB-hour list rates for a Flex shape, verified by name.

    None when the shape is not a known Flex family or a part's published name
    does not match it — never a rate borrowed from a neighbouring family.
    """
    spec = FLEX_SHAPE_PARTS.get(shape)
    if not spec:
        return None
    ocpu = await get_part(spec["ocpu"], currency)
    mem = await get_part(spec["memory"], currency)
    token = spec["token"]

    def verified(info, kind):
        name = (info or {}).get("display_name") or ""
        return bool(info) and token in name and kind in name

    if not (verified(ocpu, "OCPU") and verified(mem, "Memory")):
        return None
    return {"shape": shape, "ocpu": ocpu, "memory": mem, "currency": currency.upper(),
            "hours_per_month": HOURS_PER_MONTH}


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
