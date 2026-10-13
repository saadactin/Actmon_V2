"""Money arithmetic that refuses to lie.

Three rules are enforced here rather than left to each call site, because each
of them has exactly one safe answer and every call site was free to get it
wrong:

1.  **Never add across currencies.** ``$251.93 + Rs.13,22,788`` is not a number.
    A multi-cloud estate genuinely bills in different currencies, so the only
    honest total for a mixed scope is a total *per currency*, plus an explicit
    "mixed" signal the UI renders as NA with a reason.

2.  **Never turn an unknown into a zero.** ``None`` means the provider did not
    tell us. Summing it as 0 silently understates spend and makes a broken
    integration look like a cheap account. Unknowns are counted and reported
    separately, never folded into the total.

3.  **Never divide by zero and call it infinity.** A service that went from no
    spend to some spend has not increased by an infinite percentage; it is
    new. ``percent_change`` returns a labelled outcome, not a float that the
    formatter has to guess about.

The existing ``cost_service._single_currency`` already implements the safe half
of rule 1 (it returns None when currencies differ). This module keeps that
behaviour and adds the part that was missing: the per-currency breakdown, so a
mixed scope can still show real numbers instead of only NA.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

# The bucket key used for amounts the provider returned without a currency.
# Deliberately not a real currency code so it can never be mistaken for one.
UNKNOWN_CURRENCY = "UNKNOWN"


@dataclass(frozen=True)
class MoneyTotal:
    """The result of summing amounts that may span currencies.

    ``by_currency`` holds one real total per currency actually present. It is
    never empty-but-meaningful: an empty dict means nothing summable was found,
    which is NA, not zero.
    """

    by_currency: Dict[str, float] = field(default_factory=dict)
    # How many values contributed, and how many were unusable and why.
    counted: int = 0
    skipped_no_amount: int = 0
    skipped_no_currency: int = 0

    # Why there was nothing to total, when the caller knows and this object
    # cannot. Summing an empty list looks identical whether the provider was
    # asked and answered "nothing", was throttled, or was never reached — and
    # those are three different facts that need three different sentences. The
    # caller holds the diagnostic; see `with_reason`.
    unavailable_reason: Optional[str] = None

    @property
    def currencies(self) -> List[str]:
        return sorted(self.by_currency)

    @property
    def is_mixed(self) -> bool:
        """True when more than one currency is present, so no single total exists."""
        return len(self.by_currency) > 1

    @property
    def is_empty(self) -> bool:
        return not self.by_currency

    @property
    def single_amount(self) -> Optional[float]:
        """The one total, or None when there is no single answer.

        None here means NA and must be rendered as NA -- never as 0.
        """
        if len(self.by_currency) != 1:
            return None
        return next(iter(self.by_currency.values()))

    @property
    def single_currency(self) -> Optional[str]:
        if len(self.by_currency) != 1:
            return None
        return next(iter(self.by_currency))

    def with_reason(self, reason: Optional[str]) -> "MoneyTotal":
        """A copy carrying the caller's explanation for an empty total.

        Only meaningful when empty — a total that exists needs no excuse.
        """
        if not reason or not self.is_empty:
            return self
        return MoneyTotal(
            by_currency=dict(self.by_currency),
            counted=self.counted,
            skipped_no_amount=self.skipped_no_amount,
            skipped_no_currency=self.skipped_no_currency,
            unavailable_reason=reason,
        )

    def na_reason(self) -> Optional[str]:
        """Why there is no single total, or None when there is one."""
        if len(self.by_currency) == 1:
            return None
        if self.is_empty:
            # The caller's diagnosis wins: it knows whether the provider was
            # throttled, refused us, or genuinely had nothing.
            if self.unavailable_reason:
                return self.unavailable_reason
            if self.skipped_no_amount:
                return (
                    f"No amount was available to total. {self.skipped_no_amount} "
                    "record(s) carried no cost value from the provider."
                )
            # Deliberately a statement about THIS SUM, not about the provider.
            # The previous wording — "the provider returned no billing records"
            # — asserted a cause this object cannot observe, and on a
            # rate-limited Azure subscription it reported a throttled query as
            # an account with no spend.
            return (
                "No billing records were counted for this scope. This can mean "
                "the provider reported no spend, or that the billing data could "
                "not be retrieved — see the cost diagnostics for this account."
            )
        return (
            "Multiple billing currencies detected: "
            + ", ".join(self.currencies)
            + ". Amounts in different currencies are never added together; "
            "see the per-currency breakdown."
        )

    def to_dict(self) -> dict:
        return {
            "by_currency": {c: round(v, 4) for c, v in self.by_currency.items()},
            "currencies": self.currencies,
            "mixed": self.is_mixed,
            # None = NA. The UI must not coerce this to 0.
            "amount": (round(self.single_amount, 4)
                       if self.single_amount is not None else None),
            "currency": self.single_currency,
            "na_reason": self.na_reason(),
            # Whether the reason is a diagnosis from the caller or this
            # object's own fallback, so the UI can link to the diagnostic.
            "reason_is_diagnostic": bool(self.unavailable_reason),
            "counted": self.counted,
            "skipped_no_amount": self.skipped_no_amount,
            "skipped_no_currency": self.skipped_no_currency,
        }


def total(values: Iterable[Tuple[Optional[float], Optional[str]]]) -> MoneyTotal:
    """Sum (amount, currency) pairs into per-currency totals.

    An amount of None is counted as unknown and never contributes 0. A missing
    currency does not discard the amount -- it goes to the UNKNOWN bucket, so
    the money stays visible and the gap stays obvious.
    """
    buckets: Dict[str, float] = {}
    counted = skipped_no_amount = skipped_no_currency = 0

    for amount, currency in values:
        if amount is None:
            skipped_no_amount += 1
            continue
        try:
            numeric = float(amount)
        except (TypeError, ValueError):
            skipped_no_amount += 1
            continue

        code = (currency or "").strip().upper()
        if not code:
            code = UNKNOWN_CURRENCY
            skipped_no_currency += 1

        buckets[code] = buckets.get(code, 0.0) + numeric
        counted += 1

    return MoneyTotal(
        by_currency={c: round(v, 6) for c, v in buckets.items()},
        counted=counted,
        skipped_no_amount=skipped_no_amount,
        skipped_no_currency=skipped_no_currency,
    )


def total_from_rows(
    rows: Iterable[dict],
    amount_key: str = "cost",
    currency_key: str = "currency",
) -> MoneyTotal:
    """``total()`` over a list of billing-row dicts."""
    return total((r.get(amount_key), r.get(currency_key)) for r in rows)


def single_currency(values: Iterable[Optional[str]]) -> Optional[str]:
    """The one real currency present, or None when unknown or mixed.

    Behaviourally identical to ``cost_service._single_currency``; kept here so
    the rule lives in one place.
    """
    codes = {c.strip().upper() for c in values if c and str(c).strip()}
    return codes.pop() if len(codes) == 1 else None


def convert_total(total: "MoneyTotal", rates: Dict[str, float]) -> dict:
    """Fold a per-currency total into one INR figure, using pre-fetched rates.

    This does not relax rule 1 above -- it is still true that
    ``$251.93 + Rs.13,22,788`` is not a number. What changed is that a real
    exchange rate (fetched by ``app.services.fx_rate_service``, never invented
    here) turns both into the same unit first, so *that* sum is honest.

    Only buckets with a known rate are summed. A currency ``rates`` has no
    entry for is left out of the total and reported in ``fx_unconverted``
    rather than silently dropped -- the same treatment rule 2 gives an unknown
    amount. This function does no I/O: the caller fetches rates first (see
    ``fx_rate_service.get_rates_for``) and passes them in, so this stays
    synchronous and testable like the rest of this module.
    """
    converted = 0.0
    any_converted = False
    unconverted: Dict[str, float] = {}
    rates_used: Dict[str, float] = {}

    for code, amount in total.by_currency.items():
        if code == "INR":
            converted += amount
            any_converted = True
            continue
        rate = rates.get(code)
        if rate is None:
            unconverted[code] = amount
            continue
        converted += amount * rate
        rates_used[code] = rate
        any_converted = True

    return {
        # None here means NA, same rule as everywhere else in this module --
        # it must not render as 0 when nothing was convertible.
        "amount_inr": round(converted, 4) if any_converted else None,
        "fx_rates_used": rates_used or None,
        "fx_unconverted": unconverted or None,
    }


# ── Change between two periods ────────────────────────────────────────────────

NEW = "new"                 # previous was zero/absent, current has spend
ENDED = "ended"             # previous had spend, current is zero
NO_CHANGE = "no_change"
CHANGED = "changed"
NOT_COMPARABLE = "not_comparable"   # different currencies, or data missing


@dataclass(frozen=True)
class Change:
    """A period-over-period comparison that never renders as an infinity."""

    kind: str
    percent: Optional[float] = None
    absolute: Optional[float] = None
    currency: Optional[str] = None
    reason: Optional[str] = None

    @property
    def label(self) -> str:
        """What the UI shows when `percent` is None."""
        return {
            NEW: "New",
            ENDED: "Ended",
            NO_CHANGE: "No change",
            NOT_COMPARABLE: "NA",
        }.get(self.kind, "")

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "percent": (round(self.percent, 2) if self.percent is not None else None),
            "absolute": (round(self.absolute, 4) if self.absolute is not None else None),
            "currency": self.currency,
            "label": self.label,
            "reason": self.reason,
        }


def percent_change(
    current: Optional[float],
    previous: Optional[float],
    *,
    current_currency: Optional[str] = None,
    previous_currency: Optional[str] = None,
) -> Change:
    """Compare two amounts without ever producing an infinite percentage.

    Refuses outright when the two periods are billed in different currencies:
    a percentage between USD and INR is meaningless, not merely imprecise.
    """
    cur_code = (current_currency or "").strip().upper() or None
    prev_code = (previous_currency or "").strip().upper() or None
    if cur_code and prev_code and cur_code != prev_code:
        return Change(
            NOT_COMPARABLE,
            reason=(
                f"The two periods are billed in different currencies "
                f"({prev_code} then {cur_code}), so a percentage change cannot "
                "be calculated."
            ),
        )

    currency = cur_code or prev_code

    if current is None or previous is None:
        return Change(
            NOT_COMPARABLE,
            currency=currency,
            reason=(
                "One of the two periods has no billing data, so there is nothing "
                "to compare against."
            ),
        )

    absolute = current - previous

    if previous == 0:
        if current == 0:
            return Change(NO_CHANGE, percent=0.0, absolute=0.0, currency=currency)
        # A jump from zero is new spend, not an infinite increase.
        return Change(
            NEW, percent=None, absolute=absolute, currency=currency,
            reason="There was no spend in the previous period, so a percentage "
                   "change is undefined. This is new spend.",
        )

    if current == 0:
        return Change(
            ENDED, percent=-100.0, absolute=absolute, currency=currency,
            reason="Spend in this scope stopped entirely.",
        )

    return Change(
        CHANGED,
        percent=(absolute / abs(previous)) * 100.0,
        absolute=absolute,
        currency=currency,
    )
