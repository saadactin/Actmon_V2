"""Everything a rule may price with, fetched before the rules run.

The engine is pure, so prices are gathered up front by the service and handed
in here. Three sources, and only three:

1. **Billed cost per resource** — `cloud_resource_costs`, materialized from the
   provider's billing API by `resource_normalizer.sync_resource_costs`. OCI
   and Azure report it; AWS Cost Explorer cannot (it has no per-resource
   dimension without a Cost and Usage Report), and the reason says so.
2. **OCI public list prices** — `app.pricing.oci_pricing`, verified by part
   name.
3. **Azure retail prices** — `app.pricing.azure_pricing`, resolved after the
   run for the few VM sizes a rightsizing finding names.

A rule that needs anything else reports the saving as NA with a reason.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from app.optimization.model import AWS, AZURE, OCI
from app.pricing import oci_pricing

_BILLING_GAP = {
    AWS: ("AWS Cost Explorer does not report cost per resource. Per-resource cost "
          "needs a Cost and Usage Report export, which this account does not "
          "provide to ACTMON."),
    AZURE: ("Azure Cost Management reported no cost for this resource in the last "
            "30 days, or per-resource cost has not been fetched for this account yet."),
    OCI: ("The OCI Usage API reported no cost for this resource in the last 30 days, "
          "or per-resource cost has not been fetched for this account yet."),
}


class PriceBook:
    def __init__(
        self,
        *,
        currency: Optional[str] = None,
        billed: Optional[Dict[str, Dict[str, Any]]] = None,
        billing_note: Optional[str] = None,
        oci_block: Optional[Dict[str, Dict[str, Any]]] = None,
        oci_flex: Optional[Dict[str, Dict[str, Any]]] = None,
        oci_parts: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> None:
        self.currency = currency
        self._billed = billed or {}
        self._billing_note = billing_note
        self.oci_block = oci_block or {}
        self.oci_flex = oci_flex or {}
        self.oci_parts = oci_parts or {}

    # ── Billing ──────────────────────────────────────────────────────────
    def billed_for(self, resource) -> Optional[Dict[str, Any]]:
        return self._billed.get(str(getattr(resource, "id", "")))

    def billing_gap(self, provider: str) -> str:
        base = _BILLING_GAP.get(provider, "No per-resource billing source for this provider.")
        return f"{base} {self._billing_note}" if self._billing_note and provider != AWS else base

    @property
    def billed_count(self) -> int:
        return sum(1 for b in self._billed.values() if b.get("amount") is not None)

    # ── OCI list prices ──────────────────────────────────────────────────
    def oci_volume_monthly(self, gb: Optional[float], vpu: Optional[float],
                           label: str) -> Tuple[Optional[float], List[Dict[str, Any]]]:
        """Storage + performance units for one block/boot volume, at list."""
        if gb is None or vpu is None:
            return None, []
        return oci_pricing.block_volume_breakdown(gb, self.oci_block, vpu=int(vpu), label=label)

    def oci_perf_monthly(self, gb: float, vpu_delta: float) -> Optional[float]:
        p = self.oci_block.get(oci_pricing.BLOCK_VOLUME_PERF)
        if not p or gb is None:
            return None
        return round(gb * vpu_delta * p["value"], 2)

    def oci_flex_hourly(self, shape: str, ocpus: float, memory_gb: float
                        ) -> Optional[Tuple[float, List[Dict[str, Any]]]]:
        rates = self.oci_flex.get(shape)
        if not rates:
            return None
        o, m = rates["ocpu"], rates["memory"]
        lines = [
            {"component": f"{o['display_name']} ({o['part']})", "quantity": ocpus,
             "unit": "OCPU-hour", "unit_price": o["value"],
             "hourly_cost": round(ocpus * o["value"], 4)},
            {"component": f"{m['display_name'].replace('  ', ' ')} ({m['part']})",
             "quantity": memory_gb, "unit": "GB-hour", "unit_price": m["value"],
             "hourly_cost": round(memory_gb * m["value"], 4)},
        ]
        return round(ocpus * o["value"] + memory_gb * m["value"], 6), lines

    def oci_part(self, part: str) -> Optional[Dict[str, Any]]:
        return self.oci_parts.get(part)


def commitment_gap(billed: Optional[Dict[str, Any]], hourly_list: Optional[float],
                   currency: Optional[str], running_hours: Optional[float]) -> Optional[str]:
    """Why a list-price saving would not materialise, when the billing says so.

    A resource covered by a reservation, savings plan or negotiated discount is
    billed far below its pay-as-you-go list rate — measured on TOR, a D4as_v5
    billed 21.97 INR in 30 days against about 7,600 INR at list. Resizing it
    saves nothing until the commitment ends, so claiming the list-price
    difference would be the most misleading number on the page. The comparison
    uses the hours the resource actually ran (its hourly telemetry samples),
    so an instance that was stopped for part of the month is not mistaken for
    a discounted one. Returns None when the evidence to decide is missing.
    """
    ratio = effective_rate(billed, hourly_list, currency, running_hours)
    if ratio is None or ratio >= 0.5:
        return None
    expected = hourly_list * running_hours
    sym = {"INR": "₹", "USD": "$"}.get((currency or "").upper(), "")
    return (f"Billed {sym}{billed['amount']:,.2f} over the last {billed.get('period_days') or 30} days, "
            f"against {sym}{expected:,.2f} at the pay-as-you-go list rate for the "
            f"{running_hours:,.0f} hours it ran: it is covered by a reservation, savings plan or "
            "discount, so resizing would not save the list-price difference. Revisit it when the "
            "commitment is renewed.")


def effective_rate(billed: Optional[Dict[str, Any]], hourly_list: Optional[float],
                   currency: Optional[str], running_hours: Optional[float]) -> Optional[float]:
    """Billed cost / list cost for the hours the resource ran - the account's
    effective rate on it. None when the evidence is missing: no billed row, a
    different currency, or under a week of running hours."""
    if not billed or billed.get("amount") is None or not hourly_list or not running_hours:
        return None
    if currency and billed.get("currency") and billed["currency"] != currency:
        return None
    if running_hours < 168:
        return None
    expected = hourly_list * running_hours
    return float(billed["amount"]) / expected if expected > 0 else None
