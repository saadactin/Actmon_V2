"""Currency conversion to INR — the one place this product is allowed to guess
less and still answer.

`app.services.cost_money` refuses to add amounts across currencies because it
has no exchange rate to do it honestly. This module is that rate, sourced
from a real daily reference rate (Frankfurter, backed by the European Central
Bank) rather than invented.

Three rules, same spirit as `cost_money`:

1.  **A rate is looked up for the day the money was billed, not today.** A
    July cost converts at July's rate. `cloud_fx_rates` caches one row per
    (day, currency) so the same day is never fetched twice.

2.  **A fetch failure falls back to the newest rate this process has ever
    cached for that currency, not to a guess.** Exchange rates move slowly
    day to day, so yesterday's cached rate is a far more honest stand-in for
    an outage than silently refusing to show a number at all would be funny
    — but it never fabricates a rate that was never fetched.

3.  **No cached rate at all means `None`, and `None` means "cannot convert
    today" — never a rate of 1.0 or a dropped amount.** Callers (see
    `cost_money.convert_total`) must keep the figure out of the INR total and
    disclose it, the same way an unknown amount is handled.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Dict, Iterable, Optional, Set

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fx_rate import CloudFxRate

logger = logging.getLogger("cloud_svc.fx_rate")

INR = "INR"

# Currencies this product has actually seen from a provider billing API
# (AWS Cost Explorer, Azure Cost Management, OCI Usage API). A code outside
# this set is still looked up on request -- Frankfurter covers far more than
# this -- but these are the ones worth naming so a reviewer can see at a
# glance which currencies this dashboard expects to encounter.
KNOWN_PROVIDER_CURRENCIES = {"USD", "EUR", "GBP", "AUD", "CAD", "JPY"}

# frankfurter.app 301-redirects to frankfurter.dev as of late 2026; the
# canonical host is used directly so a rate fetch is one request, not two,
# and `follow_redirects` stays explicit rather than relying on httpx's
# default (which does NOT follow redirects) to happen to match this host's
# current behaviour.
_FX_API_BASE = "https://api.frankfurter.dev/v1"
_HTTP_TIMEOUT_SECONDS = 8.0


def _normalize(currency: Optional[str]) -> Optional[str]:
    if not currency:
        return None
    code = currency.strip().upper()
    return code or None


async def _cached_rate(db: AsyncSession, rate_date: date, currency: str) -> Optional[float]:
    row = (await db.execute(
        select(CloudFxRate.rate_to_inr).where(
            CloudFxRate.rate_date == rate_date,
            CloudFxRate.base_currency == currency,
        )
    )).scalar_one_or_none()
    return row


async def _newest_cached_rate(db: AsyncSession, currency: str) -> Optional[float]:
    """The most recent rate ever cached for `currency`, any date.

    The honest fallback when today's/that day's fetch fails: exchange rates
    drift slowly, so a day-old (or older) rate is a far better stand-in than
    refusing to show a figure that was convertible yesterday.
    """
    row = (await db.execute(
        select(CloudFxRate.rate_to_inr)
        .where(CloudFxRate.base_currency == currency)
        .order_by(CloudFxRate.rate_date.desc())
        .limit(1)
    )).scalar_one_or_none()
    return row


async def _fetch_and_cache(
    db: AsyncSession, rate_date: date, currency: str,
) -> Optional[float]:
    """Calls the FX provider for one (date, currency) pair and caches the result.

    Frankfurter has no published rate for days it has no reference rate for
    (weekends, ECB holidays) and instead returns the latest rate at or before
    the requested date -- which is exactly the behaviour wanted here, so no
    extra "nearest business day" logic is needed on this side.
    """
    url = f"{_FX_API_BASE}/{rate_date.isoformat()}"
    try:
        async with httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT_SECONDS, follow_redirects=True,
        ) as client:
            resp = await client.get(url, params={"from": currency, "to": INR})
            resp.raise_for_status()
            payload = resp.json()
        rate = payload.get("rates", {}).get(INR)
        if rate is None:
            logger.warning(
                "fx_rate.no_inr_rate currency=%s date=%s payload_keys=%s",
                currency, rate_date, list(payload.keys()),
            )
            return None
        rate = float(rate)
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.warning(
            "fx_rate.fetch_failed currency=%s date=%s error=%s",
            currency, rate_date, exc,
        )
        return None

    db.add(CloudFxRate(
        rate_date=rate_date,
        base_currency=currency,
        rate_to_inr=rate,
        source="frankfurter.app",
        fetched_at=datetime.now(timezone.utc),
    ))
    try:
        await db.commit()
    except Exception:
        # Another request cached the same (date, currency) between our read
        # and our write -- the unique constraint is the real guard, this is
        # just not treating that race as a fetch failure.
        await db.rollback()
    return rate


async def get_rate_to_inr(
    db: AsyncSession, currency: Optional[str], as_of: Optional[date] = None,
) -> Optional[float]:
    """1 unit of `currency` in INR, on `as_of` (default: today).

    Returns `None` when the currency is unknown/blank, or when it cannot be
    converted today -- callers must treat `None` as "leave unconverted and
    disclose it", exactly as `cost_money` treats an unknown amount.
    """
    code = _normalize(currency)
    if code is None:
        return None
    if code == INR:
        return 1.0

    rate_date = as_of or datetime.now(timezone.utc).date()
    # A future date (e.g. a forecast) has no reference rate yet; today's is
    # the closest honest answer and avoids calling the API with a date it
    # will reject.
    if rate_date > datetime.now(timezone.utc).date():
        rate_date = datetime.now(timezone.utc).date()

    cached = await _cached_rate(db, rate_date, code)
    if cached is not None:
        return cached

    fetched = await _fetch_and_cache(db, rate_date, code)
    if fetched is not None:
        return fetched

    fallback = await _newest_cached_rate(db, code)
    if fallback is not None:
        logger.info("fx_rate.fallback_to_cached currency=%s requested_date=%s", code, rate_date)
        return fallback

    return None


async def get_rates_for(
    db: AsyncSession, currencies: Iterable[Optional[str]], as_of: Optional[date] = None,
) -> Dict[str, float]:
    """`get_rate_to_inr` for a batch of currencies, skipping the ones that fail.

    Returns only the currencies a rate was actually found for -- a currency
    missing from the result means "could not convert", not "equal to 1".
    """
    codes: Set[str] = {c for c in (_normalize(x) for x in currencies) if c}
    rates: Dict[str, float] = {}
    for code in codes:
        rate = await get_rate_to_inr(db, code, as_of=as_of)
        if rate is not None:
            rates[code] = rate
    return rates
