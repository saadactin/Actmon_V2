"""Azure list prices from the public Azure Retail Prices API (no auth).

Used only to price a VM rightsizing recommendation: the hourly pay-as-you-go
rate of the current size and of a candidate size, in the account's billing
currency. Same two honesty rules as oci_pricing:

  1. These are PUBLIC PAY-AS-YOU-GO rates. A reservation, savings plan or
     negotiated discount makes the real saving smaller — sometimes zero — and
     the UI must say so. The VM's own billed cost is shown beside it.
  2. When the API is unreachable or returns nothing unambiguous, the answer is
     None and the caller reports NA. No rate is ever inferred from a
     neighbouring size.

"Unambiguous" is enforced, not assumed: the API returns Linux, Windows, Spot,
Low Priority and Cloud Services meters for the same armSkuName, and only one
of them is the VM being priced (measured on Standard_D4as_v5 in centralindia:
8 items, one of which is the Linux pay-as-you-go rate).
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

logger = logging.getLogger("cloud_svc.azure.pricing")

_API = "https://prices.azure.com/api/retail/prices"
_TTL = 24 * 3600
_cache: Dict[Tuple[str, str, str], Tuple[float, Dict[str, Dict[str, Any]]]] = {}


def pick_vm_rate(items: Iterable[Dict[str, Any]], sku: str, os_type: Optional[str]) -> Optional[Dict[str, Any]]:
    """The one pay-as-you-go hourly meter for this size and OS, or None.

    Pure, so the filtering — the part that decides which of eight meters is
    the VM — is tested against the real response shape.
    """
    windows = (os_type or "").strip().lower() == "windows"
    candidates = []
    for it in items:
        if it.get("armSkuName") != sku:
            continue
        if (it.get("type") or "Consumption") != "Consumption":
            continue
        if it.get("serviceName") and it.get("serviceName") != "Virtual Machines":
            continue
        product = it.get("productName") or ""
        sku_name = it.get("skuName") or ""
        if "Cloud Services" in product:
            continue
        if "Spot" in sku_name or "Low Priority" in sku_name:
            continue
        if ("Windows" in product) != windows:
            continue
        if (it.get("unitOfMeasure") or "") != "1 Hour":
            continue
        candidates.append(it)
    if len(candidates) != 1:
        # Zero is "not sold here"; more than one is ambiguous. Neither is priced.
        return None
    it = candidates[0]
    return {
        "sku": sku,
        "hourly": float(it["retailPrice"]),
        "currency": it.get("currencyCode"),
        "product": it.get("productName"),
        "meter": it.get("meterName"),
        "region": it.get("armRegionName"),
        "effective": it.get("effectiveStartDate"),
    }


async def vm_rates(skus: Iterable[str], region: str, os_type: Optional[str],
                   currency: str = "INR") -> Dict[str, Dict[str, Any]]:
    """Hourly PAYG rates for several VM sizes in one region. Missing sizes are
    simply absent from the result."""
    currency = (currency or "INR").upper()
    region = (region or "").lower()
    os_key = "windows" if (os_type or "").lower() == "windows" else "linux"
    wanted = sorted({s for s in skus if s})
    out: Dict[str, Dict[str, Any]] = {}
    need: List[str] = []
    for sku in wanted:
        cached = _cache.get((currency, region, os_key))
        if cached and time.time() - cached[0] < _TTL and sku in cached[1]:
            if cached[1][sku]:
                out[sku] = cached[1][sku]
        else:
            need.append(sku)
    if not need:
        return out
    fetched: Dict[str, Optional[Dict[str, Any]]] = {s: None for s in need}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            for i in range(0, len(need), 8):
                chunk = need[i:i + 8]
                sku_filter = " or ".join(f"armSkuName eq '{s}'" for s in chunk)
                flt = (f"serviceName eq 'Virtual Machines' and armRegionName eq '{region}' "
                       f"and priceType eq 'Consumption' and ({sku_filter})")
                url, params = _API, {"currencyCode": currency, "$filter": flt}
                items: List[Dict[str, Any]] = []
                for _page in range(10):
                    resp = await client.get(url, params=params)
                    resp.raise_for_status()
                    body = resp.json()
                    items.extend(body.get("Items") or [])
                    url, params = body.get("NextPageLink"), None
                    if not url:
                        break
                for sku in chunk:
                    fetched[sku] = pick_vm_rate(items, sku, os_type)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Azure retail price lookup failed (%s, %s): %s", region, need, exc)
        return out   # nothing cached: a failure is retried next time
    entry = _cache.get((currency, region, os_key))
    store = dict(entry[1]) if entry and time.time() - entry[0] < _TTL else {}
    store.update(fetched)
    _cache[(currency, region, os_key)] = (time.time(), store)
    for sku, rate in fetched.items():
        if rate:
            out[sku] = rate
    return out
