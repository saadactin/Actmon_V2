"""Cost service — real billed costs from provider billing APIs only.

Policy: every number returned by this module is either a real value obtained
from the provider's billing API (AWS Cost Explorer / Azure Cost Management /
OCI Usage API) or None, which the UI renders as NA. No synthetic trends, no
hardcoded price tables, no invented savings figures.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.providers import capabilities as provider_caps
from app.repository.resource_repo import ResourceRepository
from app.services import cost_errors, cost_metrics, cost_money, fetch_policy, fx_rate_service

logger = logging.getLogger("cloud_svc.cost")


# Real billing-API lookups are slow (2-10s) and rate-limited, so cache per account.
# Cache entries are (stored_at, rows, errored). A transient failure (timeout,
# throttling, a mid-request service reload) must NOT be cached as confidently
# as a genuine "provider has no cost data" result — otherwise one bad request
# locks in a fake "NA" for the full TTL. Failures get a much shorter TTL so
# they self-heal on the next request instead of hiding real data for 15 min.
_REAL_COST_TTL_SECONDS = 900
_FAILURE_TTL_SECONDS = 20
_real_cost_cache: Dict[str, Tuple[float, List[Dict[str, Any]], bool]] = {}
_daily_cost_cache: Dict[str, Tuple[float, List[Dict[str, Any]], bool]] = {}
_real_cost_by_resource_cache: Dict[str, Tuple[float, Dict[str, Dict[str, Any]], bool]] = {}
# Keyed by (account_id, days) — a 365-day query is far heavier than a 30-day
# one, so it gets its own cache slot rather than colliding with a 30-day entry.
_cost_report_cache: Dict[Tuple[str, int], Tuple[float, List[Dict[str, Any]], bool]] = {}
MAX_REPORT_DAYS = 365

# Which query each cache answers, as recorded in cloud_cost_snapshots. Keyed by
# the cache object itself because that is all `_cached_fetch` is handed.
_SNAPSHOT_KIND = {
    id(_real_cost_cache): "summary",
    id(_daily_cost_cache): "daily",
    id(_real_cost_by_resource_cache): "by_resource",
    id(_cost_report_cache): "report",
}

#: Diagnostic category for a refresh-only provider (AWS) that has nothing saved
#: yet. Not an error: nobody has refreshed the account since the data could be
#: kept, and the page will not call the provider on its own to find out.
AWAITING_REFRESH = "awaiting_refresh"


# Cache entries are (stored_at, rows, errored[, last_good_at]). The fourth
# element is read by index rather than unpacked, so an older 3-tuple written
# before this field existed still works.
def _cache_get(cache: dict, key) -> Any:
    cached = cache.get(key)
    if not cached:
        return None
    stored_at, rows, errored = cached[0], cached[1], cached[2]
    # A fifth element marks an entry for a refresh-only provider (AWS). Its age
    # is not a reason to drop it: nothing but a refresh may replace it, so it
    # stays the answer until one does.
    if len(cached) > 4 and cached[4] and not errored:
        return rows
    ttl = _FAILURE_TTL_SECONDS if errored else _REAL_COST_TTL_SECONDS
    return rows if time.time() - stored_at < ttl else None


def _cache_meta(cache: dict, key) -> Dict[str, Any]:
    """When this cache slot was written, whether it is currently serving a
    stale value after a failure, and when it last held a genuinely good one.

    This is what lets the UI say "Rs.4.52M, last refreshed 8 minutes ago,
    provider currently rate limited" instead of presenting a stale number as
    though it were live — the distinction the freshness panel is built on.
    """
    cached = cache.get(key)
    if not cached:
        return {"cached": False, "retrieved_at": None, "age_seconds": None,
                "stale": False, "last_good_at": None}
    stored_at, errored = cached[0], cached[2]
    last_good = cached[3] if len(cached) > 3 else (None if errored else stored_at)
    now = time.time()
    return {
        "cached": True,
        "retrieved_at": stored_at,
        "age_seconds": int(now - stored_at),
        # Stale = the last attempt failed and we are serving an older value.
        "stale": bool(errored),
        "last_good_at": last_good,
        "last_good_age_seconds": (int(now - last_good) if last_good else None),
    }


# A dropped TLS handshake or reset connection says nothing about the request —
# retrying usually just works. These fire constantly on this network:
#   SSL: UNEXPECTED_EOF_WHILE_READING
#   ConnectionResetError(10054, 'forcibly closed by the remote host')
#   ConnectionAbortedError(10053, 'aborted by the software in your host machine')
# Without a retry each one surfaced as a bare "NA" on the Cost page even though
# the credentials and permissions were fine.
_TRANSIENT_MARKERS = (
    "unexpected_eof", "ssl", "connection aborted", "connection reset",
    "forcibly closed", "10053", "10054", "connectionreseterror",
    "connectionabortederror", "timed out", "timeout",
    "max retries exceeded", "endpointconnectionerror", "remotedisconnected",
)
_TRANSIENT_ATTEMPTS = 3

# Longest the Cost page will wait on billing APIs before rendering with whatever
# is cached. The refresh continues in the background, so a reload picks it up.
#
# Was 12s. Live-tested 2026-09-03 against a genuinely (mildly) throttled Azure
# subscription: get_cost_data() recovered on its 2nd retry in 14.2s — a real,
# successful recovery that the old 12s deadline would have thrown away as
# "still loading, show stale/NA" even though the data was seconds from
# landing. 20s covers that case without materially changing the "provider is
# just slow/down" case, which was already falling back past either deadline.
_ANALYTICS_DEADLINE_SECONDS = 20


def _is_transient(exc: Exception) -> bool:
    low = str(exc).lower()
    return any(m in low for m in _TRANSIENT_MARKERS)


async def _cached_fetch(cache: dict, key, label: str, fetch, empty, account=None):
    """Cache-with-stale-while-error around one slow billing-API call.

    Providers raise on failure (they used to swallow it and return empty, which
    made a transient timeout indistinguishable from "this account genuinely has
    no billing data" — the empty result was then cached as a success for the
    full 15 minutes, so cost would silently vanish from the UI until the TTL
    expired). On failure here we keep serving the last GOOD value instead of
    collapsing to NA, and mark the entry errored so it retries in 20s.

    Transient network failures are retried first, since a killed TLS handshake
    is not an answer about the account. Permission/credential errors are not
    retried — those are real answers and retrying only wastes time.

    Also records WHY it failed (account_id, if given) so the UI can show a real
    diagnostic instead of a bare "NA" — see get_cost_diagnostic().
    """
    entry = cache.get(key)
    provider_name = getattr(account, "provider", None) if account else None

    # AWS bills per call, so it is read only during a refresh (see
    # fetch_policy). Outside one — a page view, a poll — serve what the last
    # refresh saved and never call the provider, however old that is.
    refresh_gated = account is not None and fetch_policy.refresh_only(provider_name)
    if refresh_gated and not fetch_policy.in_refresh():
        return await _serve_saved(cache, key, empty, account)

    # Inside a refresh it is always re-read: the user asked for the latest, and
    # a 10-minute-old cache entry is not that.
    fresh = None if refresh_gated else _cache_get(cache, key)
    if fresh is not None:
        cost_metrics.record(provider_name, "cache_hits")
        return fresh

    cost_metrics.record(provider_name, "cache_misses")

    exc: Exception | None = None
    for attempt in range(_TRANSIENT_ATTEMPTS):
        started = time.monotonic()
        try:
            # Serialise throttle-prone providers (Azure). Three subscriptions
            # refreshing concurrently is exactly the burst that produces a 429
            # and then costs all three a retry; queuing them succeeds instead.
            async with cost_metrics.provider_slot(provider_name or ""):
                cost_metrics.record(provider_name, "billing_api_calls")
                value = await fetch()
            elapsed = time.monotonic() - started
            cost_metrics.observe_duration(provider_name, "billing_api_seconds", elapsed)
            cost_metrics.structured_log(
                provider=provider_name,
                account_id=str(account.id) if account else None,
                operation=label, duration_seconds=elapsed, status="ok",
                record_count=(len(value) if hasattr(value, "__len__") else None),
            )
            now = time.time()
            if refresh_gated:
                cache[key] = (now, value, False, now, True)
                await _save_snapshot(cache, key, value, account, now)
            else:
                cache[key] = (now, value, False, now)
            if account is not None:
                _cost_error_reason.pop(str(account.id), None)
            return value
        except Exception as err:
            exc = err
            if attempt == _TRANSIENT_ATTEMPTS - 1 or not _is_transient(err):
                break
            backoff = 2 ** attempt
            logger.warning(
                "%s hit a transient network error for %s (attempt %d/%d), retrying in %ss: %s",
                label, key, attempt + 1, _TRANSIENT_ATTEMPTS, backoff, str(err)[:120],
            )
            await asyncio.sleep(backoff)

    if exc is not None:
        logger.warning("%s failed for %s: %s", label, key, exc)
        classified = cost_errors.classify(exc, provider=provider_name)
        cost_metrics.record(provider_name, "billing_api_errors")
        if classified.category == cost_errors.RATE_LIMITED:
            cost_metrics.record(provider_name, "billing_api_429")
        cost_metrics.structured_log(
            provider=provider_name,
            account_id=str(account.id) if account else None,
            operation=label, status="failed",
            error_category=classified.category,
        )
        if account is not None:
            _record_error(account, exc)
        stale = entry[1] if entry else None
        # Preserve when the data was last genuinely good across the failure, so
        # a stale value can be labelled with its real age rather than the age of
        # the failed attempt that re-stamped it.
        prior_good = (entry[3] if entry and len(entry) > 3 else None)
        if stale:
            # Serve the previous real numbers rather than a misleading NA.
            cache[key] = (time.time(), stale, True, prior_good or entry[0])
            return stale
        cache[key] = (time.time(), empty, True, prior_good)
        return empty

    # Unreachable: the loop either returns a value or records an exception.
    return empty


# Account IDs with a per-resource cost refresh already in flight, so concurrent
# page loads don't each kick off the same 15s query.
_warming: set = set()
_warm_tasks: set = set()


# The window used to decorate the Resources page and resource detail. The cache
# is keyed by (account, days), so this constant must match what those callers ask
# for or the peek below would always miss.
RESOURCE_DECORATION_DAYS = 30


def peek_costs_by_resource(account) -> Dict[str, Dict[str, Any]]:
    """Whatever per-resource cost data is already cached — never makes a network
    call. The Resources page renders straight from the DB and must not hang on a
    15-50s billing round trip just to decorate rows with cost."""
    entry = _real_cost_by_resource_cache.get((str(account.id), RESOURCE_DECORATION_DAYS))
    return entry[1] if entry else {}


def ensure_costs_by_resource_warm(account) -> None:
    """Kick off a background refresh when the per-resource cost cache is cold or
    stale, so the next load has data. Never blocks the current request."""
    key = (str(account.id), RESOURCE_DECORATION_DAYS)
    if _cache_get(_real_cost_by_resource_cache, key) is not None or key in _warming:
        return
    _warming.add(key)

    async def _run():
        try:
            await fetch_real_costs_by_resource(account, RESOURCE_DECORATION_DAYS)
        except Exception:
            pass
        finally:
            _warming.discard(key)

    try:
        task = asyncio.create_task(_run())
        _warm_tasks.add(task)
        task.add_done_callback(_warm_tasks.discard)
    except RuntimeError:
        _warming.discard(key)  # no running loop (e.g. called from sync context)


def _provider_class(provider: str):
    from app.providers.aws.aws_provider import AWSProvider
    from app.providers.azure.azure_provider import AzureProvider
    from app.providers.oci.oci_provider import OCIProvider

    return {
        "AWS": AWSProvider,
        "AZURE": AzureProvider,
        "ORACLE": OCIProvider,
        "OCI": OCIProvider,
    }.get((provider or "").upper())


# Provider instances, keyed by (account_id, credentials fingerprint).
#
# Building a provider per call was quietly expensive: a fresh AzureProvider makes
# a fresh ClientSecretCredential, which acquires a brand-new OAuth2 token from
# login.microsoftonline.com on first use. With three Azure accounts and the UI
# polling cost, that produced a constant stream of token requests, and Azure
# started resetting the connections outright:
#   ClientSecretCredential.get_token_info failed: ('Connection aborted.',
#   ConnectionResetError(10054, 'An existing connection was forcibly closed...'))
# Re-using the instance lets the SDK's own token cache do its job (it refreshes
# on expiry), and likewise re-uses the boto3 Session / OCI signer.
#
# The fingerprint is the encrypted blob itself, so re-adding an account or
# rotating its credentials naturally produces a new entry rather than a stale one.
_provider_cache: Dict[Tuple[str, int], Any] = {}


def _build_provider(account):
    """The account's provider (cached), or None (logged) if it can't be built."""
    from app.utils.encryption import decrypt_credentials

    cls = _provider_class(account.provider)
    if not cls:
        logger.warning("Unknown provider %r for account %s", account.provider, account.id)
        return None

    key = (str(account.id), hash(account.credentials_enc))
    cached = _provider_cache.get(key)
    if cached is not None:
        return cached

    try:
        creds = decrypt_credentials(account.credentials_enc)
    except Exception as exc:
        logger.error(
            "Cannot decrypt credentials for account %s (%s) — was ACTMON_ENCRYPTION_KEY "
            "changed after this account was added? Re-add the account. Error: %s",
            account.account_name, account.id, exc,
        )
        return None

    provider = cls(creds)
    # Drop any older entry for this account (credentials rotated) before storing.
    for stale in [k for k in _provider_cache if k[0] == str(account.id)]:
        _provider_cache.pop(stale, None)
    _provider_cache[key] = provider
    return provider


class ProviderUnavailableError(RuntimeError):
    """Raised when an account's provider can't even be constructed (unknown
    provider type, or credentials that fail to decrypt) — distinguished from a
    live API call failing so the UI can tell "your credentials are broken"
    apart from "the provider's API errored"."""


def _require_provider(account):
    provider = _build_provider(account)
    if provider is None:
        raise ProviderUnavailableError(
            f"Could not authenticate account '{account.account_name}' — its stored "
            "credentials failed to decrypt or the provider type is unrecognized."
        )
    return provider


# Human-readable "why is this broken" reason per account, refreshed on every
# fetch attempt (cleared on success). Backs the diagnostics popup in the UI —
# without this, a failed billing call just renders as a silent "NA" with no
# way to tell credentials/permissions/network/no-data apart.
_cost_error_reason: Dict[str, Dict[str, str]] = {}


def _categorize_error(exc: Exception, provider: Optional[str] = None) -> Tuple[str, str]:
    """(category, message) for a failed billing call.

    The classification itself now lives in app.services.cost_errors, which
    recognizes four categories this function never could — rate_limited most
    importantly. An Azure HTTP 429 fell through every branch of the old
    implementation and landed in its final `return "unknown"`, so a throttled
    subscription reported "an unexpected error occurred" when the true answer
    was "wait 32 seconds". Kept as a thin wrapper because the tuple shape is
    what the diagnostics payload is built from.
    """
    return cost_errors.categorize(exc, provider=provider)


def _record_error(account, exc: Exception) -> None:
    """Remember why this account's billing call failed, in full.

    Stores the classified error rather than just (category, message) so the
    diagnostics popup can show the things that make a diagnostic actionable:
    how long to wait for a 429, the exact IAM permission to grant for a 403,
    the HTTP status, and whether waiting will help at all.
    """
    err = cost_errors.classify(exc, provider=getattr(account, "provider", None))
    payload = err.to_dict()
    payload["required_permission"] = (
        cost_errors.required_permission(getattr(account, "provider", None))
        if err.category == cost_errors.PERMISSION else None
    )
    payload["explanation"] = cost_errors.describe(err.category)
    payload["occurred_at"] = time.time()
    _cost_error_reason[str(account.id)] = payload


def get_cost_diagnostic(account_id) -> Optional[Dict[str, Any]]:
    """The last known reason this account's cost data isn't available, or None
    if the last attempt succeeded (or none has been made yet)."""
    return _cost_error_reason.get(str(account_id))


# ── Refresh-only providers: serve what the last refresh saved ─────────────────
# For AWS (see fetch_policy) a page view never calls the provider. These are the
# pieces `_cached_fetch` uses instead: the snapshot a refresh saved, and for a
# day-by-day report, the stored billing facts every refresh ingests.

def _snapshot_ident(cache: dict, key) -> Tuple[str, int]:
    """(kind, window_days) naming this cache slot in cloud_cost_snapshots."""
    kind = _SNAPSHOT_KIND.get(id(cache), "other")
    window = int(key[1]) if isinstance(key, tuple) and len(key) > 1 else 0
    return kind, window


async def _save_snapshot(cache: dict, key, value: Any, account, fetched_epoch: float) -> None:
    """Keep a refresh's answer so it survives a restart. Never raises: a failed
    save costs the next restart its data, which must not fail the refresh."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.core.database import AsyncSessionLocal
    from app.models.cost_fact import CloudCostSnapshot

    kind, window = _snapshot_ident(cache, key)
    try:
        payload = json.loads(json.dumps(value, default=str))
        stmt = pg_insert(CloudCostSnapshot).values(
            id=uuid.uuid4(), account_id=account.id, kind=kind, window_days=window,
            payload=payload,
            fetched_at=datetime.fromtimestamp(fetched_epoch, tz=timezone.utc),
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_cost_snapshot_account_kind_window",
            set_={"payload": stmt.excluded.payload,
                  "fetched_at": stmt.excluded.fetched_at},
        )
        async with AsyncSessionLocal() as db:
            await db.execute(stmt)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not save the %s cost snapshot for account %s: %s",
                       kind, getattr(account, "id", "?"), exc)


async def _load_snapshot(account, kind: str, window: int) -> Optional[Tuple[Any, float]]:
    """(payload, fetched_at epoch) of the saved answer, or None if there is none."""
    from sqlalchemy import select

    from app.core.database import AsyncSessionLocal
    from app.models.cost_fact import CloudCostSnapshot

    try:
        async with AsyncSessionLocal() as db:
            row = (await db.execute(
                select(CloudCostSnapshot.payload, CloudCostSnapshot.fetched_at)
                .where(CloudCostSnapshot.account_id == account.id,
                       CloudCostSnapshot.kind == kind,
                       CloudCostSnapshot.window_days == window)
            )).first()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read the %s cost snapshot for account %s: %s",
                       kind, getattr(account, "id", "?"), exc)
        return None
    if row is None:
        return None
    return row[0], row[1].timestamp()


def _fact_to_report_row(billing_date, service, usage_type, region, amount, currency) -> Dict[str, Any]:
    """One stored billing fact in the shape `AWSProvider.get_cost_report` returns,
    which is the shape ingestion stored it from (see normalize_report_rows)."""
    return {
        "date": billing_date.isoformat(),
        "service": service,
        "resource_type": usage_type,
        "region": region,
        "cost": round(float(amount), 4),
        "currency": currency,
    }


async def _report_rows_from_facts(account, days: int) -> List[Dict[str, Any]]:
    """The day-by-day report for [today - days, today) from stored billing facts.

    Same window the live query covers (Cost Explorer's End is exclusive). Every
    refresh re-ingests the last 30 days and a backfill fills older history, so
    this is the report as of the last refresh. A fact with no amount is left
    out rather than shown as zero; AWS ingestion never writes one.
    """
    from datetime import date, timedelta

    from sqlalchemy import select

    from app.core.database import AsyncSessionLocal
    from app.models.cost_fact import CloudCostFact

    today = date.today()
    start = today - timedelta(days=days)
    try:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(
                select(CloudCostFact.billing_date, CloudCostFact.service,
                       CloudCostFact.usage_type, CloudCostFact.region,
                       CloudCostFact.amount, CloudCostFact.currency)
                .where(CloudCostFact.account_id == account.id,
                       CloudCostFact.billing_date >= start,
                       CloudCostFact.billing_date < today,
                       CloudCostFact.amount.isnot(None))
                .order_by(CloudCostFact.billing_date)
            )).all()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read stored cost facts for account %s: %s",
                       getattr(account, "id", "?"), exc)
        return []
    return [_fact_to_report_row(*r) for r in rows]


def _record_awaiting_refresh(account) -> None:
    """Say why a refresh-only account shows no cost, unless something more
    specific is already known -- a permission error from the last refresh is the
    better answer, and this must not paper over it."""
    aid = str(account.id)
    if aid in _cost_error_reason:
        return
    _cost_error_reason[aid] = {
        "category": AWAITING_REFRESH,
        "message": ("AWS cost is read from AWS only when this account is refreshed, "
                    "and no refresh has saved cost data for it yet."),
        "retry_after_seconds": None,
        "http_status": None,
        "provider": getattr(account, "provider", None),
        "terminal": True,
        "retryable": False,
        "required_permission": None,
        "explanation": ("Opening a page never calls AWS, because AWS charges for "
                        "every billing query. Click Refresh, or wait for the "
                        "scheduled refresh."),
        "occurred_at": time.time(),
    }


async def _serve_saved(cache: dict, key, empty, account):
    """What a page view gets for a refresh-only provider. Never calls it.

    In order: for a day-by-day report, the stored billing facts; otherwise the
    value in memory from the last refresh; otherwise the snapshot that refresh
    saved (after a restart); otherwise `empty`, with a diagnostic that says
    "refresh to load this" rather than an error.
    """
    provider_name = getattr(account, "provider", None)
    kind, window = _snapshot_ident(cache, key)

    if kind == "report":
        rows = await _report_rows_from_facts(account, window)
        if rows:
            cost_metrics.record(provider_name, "cache_hits")
            return rows

    entry = cache.get(key)
    if entry is not None and (entry[1] or not entry[2]):
        cost_metrics.record(provider_name, "cache_hits")
        return entry[1]

    saved = await _load_snapshot(account, kind, window)
    if saved is not None:
        payload, fetched_epoch = saved
        # Stamped with when the refresh fetched it, so the freshness panel says
        # "9 hours ago" rather than passing a restored value off as new.
        cache[key] = (fetched_epoch, payload, False, fetched_epoch, True)
        cost_metrics.record(provider_name, "cache_hits")
        return payload

    _record_awaiting_refresh(account)
    return empty


#: Diagnostic category -> what it means for a total that came back empty.
#: Phrased as what happened to the QUERY, because that is what is known. Only
#: the last entry is a statement about the account's actual spend.
_EMPTY_TOTAL_REASON: Dict[str, str] = {
    "rate_limited": (
        "The provider is rate limiting billing queries for this account, so no "
        "spend could be read. This is not a spend of zero — stored history for "
        "this account is unaffected and still shown below."
    ),
    "permission": (
        "The stored credentials are missing the permission needed to read "
        "billing for this account, so its spend is unknown — not zero."
    ),
    "authentication": (
        "The provider rejected the stored credentials for this account, so no "
        "billing could be read."
    ),
    "network": (
        "The billing endpoint could not be reached, so no spend could be read "
        "for this account."
    ),
    "unsupported": (
        "This provider integration cannot report billing for this account."
    ),
    "provider_error": (
        "The provider returned an error for the billing query, so no spend "
        "could be read for this account."
    ),
    AWAITING_REFRESH: (
        "AWS cost is read from AWS only during a refresh, and nothing has been "
        "saved for this account yet. Click Refresh, or wait for the scheduled "
        "refresh. This is not a spend of zero."
    ),
}


def _diagnostic_summary(diagnostics: List[Dict[str, Any]]) -> Optional[str]:
    """One sentence explaining an empty total, from the diagnostics collected.

    Returns None when nothing went wrong, so an account that genuinely has no
    spend is not handed an excuse it does not need.
    """
    if not diagnostics:
        return None
    categories = [d.get("category") for d in diagnostics if d.get("category")]
    if not categories:
        return None
    # One bad account in an ALL view is enough to make the total unsafe to
    # read as complete, and naming it beats a generic apology.
    known = [c for c in categories if c in _EMPTY_TOTAL_REASON]
    if not known:
        return None
    primary = known[0]
    text = _EMPTY_TOTAL_REASON[primary]
    if len(diagnostics) > 1:
        text += f" ({len(diagnostics)} accounts in this scope reported a problem.)"
    return text


def _iso(epoch: Optional[float]) -> Optional[str]:
    """Epoch seconds as a UTC ISO-8601 string, or None. Never 'now' as a
    fallback — an unknown timestamp must stay unknown."""
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def get_cost_freshness(account) -> Dict[str, Any]:
    """Per-dataset ages for one account.

    Billing, per-resource cost and inventory are refreshed on independent
    schedules and are NOT synchronized — reporting one timestamp for all three
    would be a convenient lie. Each dataset reports its own age, and whether
    it is currently serving a stale value after a failed refresh.
    """
    aid = str(account.id)
    billing = _cache_meta(_real_cost_cache, aid)
    daily = _cache_meta(_daily_cost_cache, aid)
    by_resource = _cache_meta(
        _real_cost_by_resource_cache, (aid, RESOURCE_DECORATION_DAYS)
    )
    return {
        "billing": {**billing, "retrieved_at": _iso(billing["retrieved_at"]),
                    "last_good_at": _iso(billing["last_good_at"])},
        "daily_trend": {**daily, "retrieved_at": _iso(daily["retrieved_at"]),
                        "last_good_at": _iso(daily["last_good_at"])},
        "resource_cost": {**by_resource,
                          "retrieved_at": _iso(by_resource["retrieved_at"]),
                          "last_good_at": _iso(by_resource["last_good_at"])},
        "inventory": {
            "retrieved_at": (account.last_discovery.isoformat()
                             if getattr(account, "last_discovery", None) else None),
        },
    }


def get_cost_capabilities(accounts) -> Dict[str, Any]:
    """What the providers in scope can and cannot answer about cost.

    Returns both the per-provider detail and the intersection, because a
    multi-provider view may only offer a dimension every provider in it can
    supply — otherwise a filter silently drops one cloud's spend and the total
    quietly shrinks.
    """
    providers = []
    for a in accounts:
        cap = provider_caps.for_provider(a.provider)
        name = cap.provider if cap else str(a.provider)
        if name not in providers:
            providers.append(name)

    per_provider = {}
    for a in accounts:
        cap = provider_caps.for_provider(a.provider)
        if cap is not None:
            per_provider[cap.provider] = cap.to_dict()

    effective = provider_caps.intersect([a.provider for a in accounts])
    return {
        "providers": providers,
        "per_provider": per_provider,
        # What the CURRENT scope may offer. A dimension False here must be
        # rendered disabled with a reason, never as a zero.
        "effective": effective,
        "blocked_by": {
            dim: provider_caps.unsupported_in_scope([a.provider for a in accounts], dim)
            for dim, available in effective.items() if not available
        },
    }


def assess_cost_quality(accounts) -> Dict[str, Any]:
    """The page-level data-quality badge, derived from what actually happened.

    Deliberately conservative: any account whose billing call failed drags the
    whole scope below GOOD, because a total assembled from some accounts is not
    a total. A capability limit (AWS resource cost) is LIMITED, not a failure —
    nothing is broken, the question just cannot be answered here.
    """
    errors, terminal = [], False
    for a in accounts:
        reason = get_cost_diagnostic(a.id)
        if reason:
            errors.append({"account_id": str(a.id), "account_name": a.account_name,
                           "provider": a.provider, **reason})
            terminal = terminal or bool(reason.get("terminal"))

    effective = provider_caps.intersect([a.provider for a in accounts])
    limited_dimensions = [d for d, available in effective.items() if not available]

    if errors and len(errors) == len(accounts):
        quality, status = "unavailable", "failed"
    elif errors:
        quality, status = "partial", "partial"
    elif limited_dimensions:
        quality, status = "limited", "complete"
    else:
        quality, status = "good", "complete"

    return {
        "quality": quality,
        "status": status,
        "accounts_in_scope": len(accounts),
        "accounts_failing": len(errors),
        "errors": errors,
        "needs_human_action": terminal,
        "limited_dimensions": limited_dimensions,
    }


async def fetch_real_costs(account) -> List[Dict[str, Any]]:
    """Last-30-day actual spend per service from the provider's billing API.

    Returns [] when the provider reports no cost records — e.g. sponsored /
    credit Azure subscriptions, whose spend Microsoft does not expose via
    the Cost Management API — or when the query fails. Callers surface NA
    in that case.
    """
    async def _fetch():
        provider = _require_provider(account)
        return await provider.get_cost_data() or []

    return await _cached_fetch(
        _real_cost_cache, str(account.id), "Billing API query", _fetch, [],
        account=account,
    )


async def fetch_daily_costs(account) -> List[Dict[str, Any]]:
    """Real per-day spend for the last 30 days ([{date, cost, currency}])."""

    async def _fetch():
        provider = _require_provider(account)
        if not hasattr(provider, "get_daily_costs"):
            return []
        return await provider.get_daily_costs() or []

    return await _cached_fetch(
        _daily_cost_cache, str(account.id), "Daily cost query", _fetch, [],
        account=account,
    )


async def fetch_cost_report(account, days: int) -> List[Dict[str, Any]]:
    """Real day-by-day, per-service spend for the given lookback window, when
    the provider supports it (AWS/Azure/OCI all do). Returns [] when
    unsupported or the query fails — never a fabricated row."""
    days = max(1, min(days, MAX_REPORT_DAYS))

    async def _fetch():
        provider = _require_provider(account)
        if not hasattr(provider, "get_cost_report"):
            return []
        return await provider.get_cost_report(days) or []

    return await _cached_fetch(
        _cost_report_cache, (str(account.id), days), "Cost report query", _fetch, [],
        account=account,
    )


async def fetch_real_costs_by_resource(account, days: int = 30) -> Dict[str, Dict[str, Any]]:
    """Real spend over `days` keyed by provider resource ID, when the provider
    supports resource-level cost grouping (OCI + Azure). Returns {} when
    unsupported or the query fails — callers show NA, never a guess.

    An empty result is ambiguous on its own, and the two meanings need
    different words in the UI: AWS will NEVER answer this (Cost Explorer has
    no per-resource dimension; that needs a CUR pipeline), whereas an empty
    OCI result means the query failed or the account really has no billed
    resources. So the unsupported case is recorded as such rather than left to
    look like a failure — `get_cost_diagnostic` then reports category
    'unsupported', which is terminal and must not show a "retrying" spinner.
    """
    days = max(1, min(days, MAX_REPORT_DAYS))

    caps = provider_caps.for_provider(account.provider)
    if caps is not None and not caps.resource:
        # Short-circuit before spending a provider round trip on a question
        # this integration cannot answer. Deliberately NOT recorded in
        # _cost_error_reason: that map is per-ACCOUNT, and an unsupported
        # dimension is not a broken account — writing it there would make the
        # diagnostics popup claim AWS billing is failing when its service-level
        # cost is working perfectly. The "why" is carried by the capability
        # registry instead, which is per-dimension and always available.
        logger.debug(
            "Skipping per-resource cost for %s: %s", account.provider,
            caps.reason("resource"),
        )
        return {}

    async def _fetch():
        provider = _require_provider(account)
        if not hasattr(provider, "get_cost_by_resource"):
            raise cost_errors.NotSupportedError(
                f"{account.provider} per-resource billing is not implemented by "
                "this provider adapter.",
                provider=account.provider, dimension="resource",
            )
        return await provider.get_cost_by_resource(days) or {}

    # Keyed by (account, days): the 30-day map that decorates the Resources page
    # must not be evicted by a 365-day report query.
    return await _cached_fetch(
        _real_cost_by_resource_cache, (str(account.id), days),
        "Per-resource billing query", _fetch, {}, account=account,
    )


# Compute resource types that represent a stoppable server, per provider, and
# the storage types that can be left attached (and billing) after it stops.
_COMPUTE_TYPES = {"EC2Instance", "ComputeInstance", "VirtualMachine"}
_STORAGE_TYPES = {"BlockVolume", "ManagedDisk", "EBSVolume"}


def _stopped_status(resource) -> tuple[bool, Optional[str]]:
    """Whether a compute resource is stopped, and the real status string to
    display for it. Azure VMs report provisioning_state (e.g. 'Succeeded')
    which says nothing about power — use the scanner's power_state field
    instead; AWS/OCI already report the real lifecycle state in .status."""
    cfg = resource.config or {}
    if resource.resource_type == "VirtualMachine":
        power_state = cfg.get("power_state")
        s = (power_state or "").lower()
        return ("stop" in s or "deallocat" in s), power_state
    if resource.resource_type == "EC2Instance":
        return (resource.status or "").lower() == "stopped", resource.status
    if resource.resource_type == "ComputeInstance":
        return (resource.status or "").upper() == "STOPPED", resource.status
    return False, resource.status


async def build_stopped_instances(resources: List[Any], accounts: List[Any]) -> List[Dict[str, Any]]:
    """Stopped compute instances across the given resources, each with its own
    billed cost and any attached storage's billed cost over the last 30 days
    (both real, from the provider's billing API — NA when unsupported, e.g.
    AWS per-resource cost isn't available from Cost Explorer).

    Cost here is a DECORATION on inventory the caller already has, so it reads
    the cache only and never issues a blocking billing call. Awaiting one made
    the Cost page exceed its own deadline: the analytics deadline bounded the
    main fan-out, then this ran afterwards unbounded and re-added 20s+. A cold
    cache simply means cost shows NA on this pass while a refresh runs behind it.
    """
    account_by_id = {str(a.id): a for a in accounts}
    cost_maps: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for a in accounts:
        cost_maps[str(a.id)] = peek_costs_by_resource(a)
        ensure_costs_by_resource_warm(a)

    storage_by_attached_to: Dict[str, List[Any]] = {}
    for r in resources:
        if r.resource_type not in _STORAGE_TYPES:
            continue
        attached_id = (r.config or {}).get("attached_to_id")
        if attached_id:
            storage_by_attached_to.setdefault(attached_id, []).append(r)

    items: List[Dict[str, Any]] = []
    for r in resources:
        if r.resource_type not in _COMPUTE_TYPES:
            continue
        stopped, display_status = _stopped_status(r)
        if not stopped:
            continue

        account = account_by_id.get(str(r.account_id))
        cost_map = cost_maps.get(str(r.account_id), {})
        own_entry = cost_map.get(r.provider_resource_id)
        own_cost = own_entry["monthly_cost"] if own_entry else None
        currency = own_entry.get("currency") if own_entry else None

        attached_storage = []
        attached_total = 0.0
        attached_known = False
        for sr in storage_by_attached_to.get(r.provider_resource_id, []):
            sr_entry = cost_map.get(sr.provider_resource_id)
            sr_cost = sr_entry["monthly_cost"] if sr_entry else None
            if sr_cost is not None:
                attached_total += sr_cost
                attached_known = True
                currency = currency or sr_entry.get("currency")
            attached_storage.append({
                "resource_id": str(sr.id),
                "resource_name": sr.resource_name,
                "resource_type": sr.resource_type,
                "monthly_cost": sr_cost,
            })

        known_parts = [v for v in (own_cost, attached_total if attached_known else None) if v is not None]
        total_cost = round(sum(known_parts), 2) if known_parts else None

        items.append({
            "resource_id": str(r.id),
            "provider_resource_id": r.provider_resource_id,
            "resource_name": r.resource_name,
            "resource_type": r.resource_type,
            "provider": account.provider if account else None,
            "account_id": str(r.account_id),
            "account_name": account.account_name if account else None,
            "region": r.region_or_zone,
            "status": display_status,
            "own_cost_monthly": own_cost,
            "attached_storage": attached_storage,
            "attached_storage_cost_monthly": round(attached_total, 2) if attached_known else None,
            "total_cost_monthly": total_cost,
            "currency": currency,
        })

    items.sort(key=lambda x: -(x["total_cost_monthly"] or 0))
    return items


def _identify_from_provider_id(pid: str) -> Tuple[Optional[str], Optional[str]]:
    """Best-effort (type, name) parsed from a provider resource ID, for billed
    resources that aren't in our inventory.

    Providers bill plenty of things discovery doesn't scan — OCI boot volumes,
    VNICs and volume replicas; sub-resources on the Azure side — and those rows
    would otherwise be anonymous in the report. The ID formats are structured,
    so the type is always recoverable and Azure even carries the real name:

      OCI:   ocid1.<type>.<realm>.<region>.<unique>   → type only
      Azure: /subscriptions/../providers/<NS>/<type>/<name> → type and name
    """
    if not pid:
        return None, None
    s = str(pid)

    if s.startswith("ocid1."):
        parts = s.split(".")
        raw = parts[1] if len(parts) > 1 else None
        if not raw:
            return None, None
        pretty = {
            "bootvolume": "Boot Volume",
            "volume": "Block Volume",
            "blockvolumereplica": "Block Volume Replica",
            "volumebackup": "Volume Backup",
            "bootvolumebackup": "Boot Volume Backup",
            "vnic": "VNIC",
            "instance": "Compute Instance",
            "autonomousdatabase": "Autonomous Database",
            "dbsystem": "DB System",
            "filesystem": "File System",
            "mounttarget": "Mount Target",
            "loadbalancer": "Load Balancer",
            "bucket": "Object Storage Bucket",
            "analyticsinstance": "Analytics Instance",
            "vcn": "VCN",
            "subnet": "Subnet",
            "drg": "Dynamic Routing Gateway",
            "ipsecconnection": "IPSec Connection",
            "cpe": "Customer-Premises Equipment",
            "waaspolicy": "WAF Policy",
            "webappfirewall": "Web App Firewall",
            "key": "Vault Key",
            "vault": "Vault",
            "logGroup": "Log Group",
        }.get(raw, raw.replace("-", " ").title())
        return pretty, None

    if s.startswith("/subscriptions/") and "/providers/" in s:
        tail = s.split("/providers/", 1)[1].split("/")
        # <namespace>/<type>[/<subtype>...]/<name>
        if len(tail) >= 3:
            return f"{tail[0]}/{tail[1]}", tail[-1]
        return (tail[0] if tail else None), None

    return None, None


# ── Cost component classification ───────────────────────────────────────────
# What "Cost Component" means, and what it deliberately does NOT mean:
#
# Verified against 46,804 real OCI usage line items (resourceId × service ×
# day, 30-day window): zero resources were ever billed under more than one
# `service` value. An instance and its attached volume are already separate
# billed rows, each under its own service (Compute vs Block Storage) — there
# is no such thing as "one resource billed 60% Compute / 40% Storage" in the
# data these APIs return. So a cost component is a property of the BILLED ROW
# (== today's `service` field), not a fabricated sub-split of one resource.
# Grouping by component is what lets "Instance A (Compute) / Block Volume A
# (Storage), attached to Instance A" be shown as two independently-filterable
# lines that also happen to be related — exactly matching how the data is
# actually billed, not an invented decomposition.
#
# Each map is keyed on the exact strings the provider's billing API returns
# today (OCI: live-verified; Azure/AWS: each provider's own well-documented,
# stable service-name vocabulary). Anything not listed falls through to a
# same-word substring match, then to "Other" — never guessed into a specific
# bucket, so an unrecognized service is honestly "Other" rather than silently
# misfiled as "Compute".
_COST_COMPONENTS = ("Compute", "Database", "Storage", "Network", "Other")

_OCI_COMPONENT_MAP = {
    "compute": "Compute",
    "database": "Database",
    "block storage": "Storage",
    "object storage": "Storage",
    "file storage": "Storage",
    "load balancer": "Network",
    "virtual cloud network": "Network",
    "virtual private network": "Network",
    "key management": "Other",
    "key management - shard 2": "Other",
    "logging": "Other",
    "analytics": "Other",
    "telemetry": "Other",
    "oracle web application firewall (waf)": "Other",
}

_AWS_COMPONENT_MAP = {
    "amazon elastic compute cloud - compute": "Compute",
    "aws lambda": "Compute",
    "amazon elastic container service": "Compute",
    "amazon elastic kubernetes service": "Compute",
    "amazon relational database service": "Database",
    "amazon dynamodb": "Database",
    "amazon elasticache": "Database",
    "amazon redshift": "Database",
    "amazon documentdb (with mongodb compatibility)": "Database",
    "amazon neptune": "Database",
    "amazon simple storage service": "Storage",
    "amazon elastic block store": "Storage",
    "amazon elastic file system": "Storage",
    "amazon virtual private cloud": "Network",
    "elastic load balancing": "Network",
    "amazon cloudfront": "Network",
    "amazon route 53": "Network",
    "aws data transfer": "Network",
    "tax": "Other",
    "aws key management service": "Other",
    "amazoncloudwatch": "Other",
}

_AZURE_COMPONENT_MAP = {
    "virtual machines": "Compute",
    "azure app service": "Compute",
    "container instances": "Compute",
    "azure kubernetes service": "Compute",
    "storage": "Storage",
    "azure database for postgresql": "Database",
    "azure database for mysql": "Database",
    "sql database": "Database",
    "azure cosmos db": "Database",
    "redis cache": "Database",
    "virtual network": "Network",
    "load balancer": "Network",
    "application gateway": "Network",
    "azure dns": "Network",
    "bandwidth": "Network",
    "key vault": "Other",
    "log analytics": "Other",
    "azure monitor": "Other",
    "backup": "Other",
}

_COMPONENT_MAPS = {"AWS": _AWS_COMPONENT_MAP, "AZURE": _AZURE_COMPONENT_MAP,
                   "OCI": _OCI_COMPONENT_MAP, "ORACLE": _OCI_COMPONENT_MAP}

# Substring fallback for services not in the maps above — the long tail of
# AWS/Azure service names (hundreds of them) isn't worth hardcoding in full.
# Checked in this order so a name containing both words picks the more
# specific bucket (e.g. "network storage" would hit storage first).
_COMPONENT_KEYWORDS = (
    ("database", "Database"), ("db", "Database"), ("cache", "Database"),
    ("storage", "Storage"), ("disk", "Storage"), ("volume", "Storage"),
    ("bucket", "Storage"),
    ("network", "Network"), ("gateway", "Network"), ("dns", "Network"),
    ("vpn", "Network"), ("load balanc", "Network"), ("bandwidth", "Network"),
    ("data transfer", "Network"),
    ("compute", "Compute"), ("lambda", "Compute"), ("function", "Compute"),
    ("kubernetes", "Compute"), ("container", "Compute"),
    ("virtual machine", "Compute"), ("app service", "Compute"),
)


def _normalize_cost_component(provider: str, service: Optional[str]) -> str:
    """A billed service name -> one of _COST_COMPONENTS. Never raises; an
    unrecognized or missing service is honestly "Other"."""
    if not service:
        return "Other"
    key = service.strip().lower()
    mapped = _COMPONENT_MAPS.get((provider or "").upper(), {}).get(key)
    if mapped:
        return mapped
    for needle, bucket in _COMPONENT_KEYWORDS:
        if needle in key:
            return bucket
    return "Other"


async def prewarm_cost_cache(account) -> None:
    """Fire this right after a discovery scan completes so the Cost page's
    first load hits a warm cache instead of a cold 30-50s provider billing
    call. Exceptions are swallowed — the caller doesn't await this to block
    on it, and a failed pre-warm just means the next real request pays the
    normal (now-short, 20s) failure-cache cost instead of the full one.

    Only ever called by a refresh — a discovery scan, Refresh all, or the Cost
    tab's Refresh — so it runs as one: this is the one place AWS cost is read."""
    with fetch_policy.refresh_activity():
        await asyncio.gather(
            fetch_real_costs(account),
            fetch_daily_costs(account),
            fetch_real_costs_by_resource(account),
            return_exceptions=True,
        )


def expire_account_cost_cache(account_id) -> int:
    """Expire this account's cached billing results without discarding them.

    Used by the Cost tab's own refresh, which must re-ask the provider rather
    than re-serve a 14-minute-old answer. The VALUES are kept and only the
    timestamp is zeroed: if the provider then fails (a 429, a dropped TLS
    handshake), `_cached_fetch` still serves the last good numbers as stale,
    exactly as it would at the natural end of the TTL. Deleting the entries
    instead would turn one throttled refresh into an NA page.

    Returns how many cache slots were expired.
    """
    aid = str(account_id)
    expired = 0
    for cache in (_real_cost_cache, _daily_cost_cache,
                  _real_cost_by_resource_cache, _cost_report_cache):
        for key in [k for k in cache
                    if k == aid or (isinstance(k, tuple) and k and k[0] == aid)]:
            entry = cache[key]
            stored_at, rows, errored = entry[0], entry[1], entry[2]
            last_good = entry[3] if len(entry) > 3 else (None if errored else stored_at)
            cache[key] = (0.0, rows, errored, last_good)
            expired += 1
    return expired


#: Where a provider gave us a charge with no region attached. A real label
#: rather than None so it can be rendered, sorted and clicked like any other
#: row — and so nobody mistakes it for a bug in the breakdown.
REGION_NOT_REPORTED = "Not reported"


def _regional_totals(by_service: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Billed spend per region, per currency, from the per-service rows.

    Derived rather than queried separately so the two breakdowns cannot
    disagree. Currencies are kept apart for the same reason they are
    everywhere else in this service: a total spanning USD and INR is a number
    that exists in no currency at all.
    """
    buckets: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for entry in by_service:
        currency = entry.get("currency") or ""
        splits = entry.get("by_region") or []
        if not splits:
            # No region breakdown at all — the whole amount is unregioned.
            splits = [{"region": REGION_NOT_REPORTED,
                       "monthly_cost": entry.get("monthly_cost") or 0.0}]
        for split in splits:
            region = split.get("region") or REGION_NOT_REPORTED
            key = (region, currency)
            bucket = buckets.get(key)
            if bucket is None:
                bucket = buckets[key] = {
                    "region": region,
                    "currency": entry.get("currency"),
                    "monthly_cost": 0.0,
                    "services": 0,
                    "reported": region != REGION_NOT_REPORTED,
                }
            bucket["monthly_cost"] += float(split.get("monthly_cost") or 0.0)
            bucket["services"] += 1

    out = []
    for bucket in buckets.values():
        bucket["monthly_cost"] = round(bucket["monthly_cost"], 2)
        out.append(bucket)
    # Unregioned last, then by spend: it is a footnote, not a finding.
    out.sort(key=lambda b: (not b["reported"], -b["monthly_cost"]))
    return out


def _single_currency(values: List[Optional[str]]) -> Optional[str]:
    """The one real currency present, or None when unknown/mixed (UI shows NA)."""
    currencies = {c for c in values if c}
    if len(currencies) == 1:
        return currencies.pop()
    return None


#: AWS Cost Explorer's own literal value for a charge its REGION dimension
#: cannot place anywhere (global services, data transfer, tax, support) — not
#: this codebase's convention, AWS's. Treated the same as a missing region
#: everywhere a region is matched, below.
_AWS_NO_REGION = "NoRegion"


def _region_matches(row_region: Optional[str], selected: str) -> bool:
    """Whether a billing row belongs to the region someone picked in the UI.

    `selected == "global"` means "resources with no specific region" — the
    same convention `app.utils.regions.GLOBAL` uses for inventory — so it
    matches a row whose region is missing entirely, including AWS's literal
    "NoRegion" GroupBy value. A real region name is matched case-insensitively
    since the three providers are not consistent about casing (OCI/AWS codes
    are lower-case, Azure locations vary).
    """
    code = (row_region or "").strip()
    if selected.strip().lower() == "global":
        return not code or code.lower() == _AWS_NO_REGION.lower()
    return code.lower() == selected.strip().lower()


async def estimate_costs(
    account_id: uuid.UUID, db: AsyncSession, region: Optional[str] = None,
) -> Dict[str, Any]:
    """Account cost summary from the provider billing API (real values or NA).

    Kept under its historical name because the /cost-estimate route and the
    dashboard consume it; it no longer fabricates config-based estimates.

    `region` narrows the total to one region's spend. This is honest to offer
    because every provider's billing row here already carries a real region
    (AWS's REGION GroupBy dimension, Azure's ResourceLocation, OCI's region
    groupBy — see each provider's `get_cost_data()`), unlike the STORED daily
    history behind the cost trend chart, where AWS specifically never
    populates `region` (see `AWSCostProvider.get_cost_report`'s own comment).
    """
    from app.repository.cloud_account_repo import CloudAccountRepository

    account = await CloudAccountRepository(db).get_by_id(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    all_rows = await fetch_real_costs(account)
    # Filtering, not re-querying: every row already carries its own region, so
    # narrowing to one is a sum over a subset, not a different question asked
    # of the provider. A region with no matching row is a real, reportable
    # zero (the provider would have returned a row for it if it had spent
    # anything there) — never NA, which stays reserved for "we don't know".
    rows = (
        [r for r in all_rows if _region_matches(r.get("region"), region)]
        if region else all_rows
    )
    # `all_rows` being non-empty is what "we have an answer" means here — even
    # when the region-filtered `rows` is empty, that is a real zero for that
    # region (a provider that billed anything there would have returned a
    # matching row), never NA, which stays reserved for "we don't know".
    total = round(sum(float(r.get("monthly_cost") or 0) for r in rows), 2) if all_rows else None
    currency = _single_currency([r.get("currency") for r in all_rows]) if all_rows else None

    # This account bills natively in `currency` (one account, one provider, so
    # unlike the multi-account dashboard this is never mixed) — but a USD
    # account and an INR account still show different units on the same
    # Overview page. A live FX rate makes the headline comparable everywhere.
    rate = await fx_rate_service.get_rate_to_inr(db, currency) if currency else None
    total_inr = round(total * rate, 4) if total is not None and rate is not None else None

    by_type: Dict[str, float] = {}
    breakdown: List[Dict[str, Any]] = []
    for r in sorted(rows, key=lambda x: -(x.get("monthly_cost") or 0)):
        svc = r.get("resource_name") or "Unknown"
        by_type[svc] = round(by_type.get(svc, 0) + float(r.get("monthly_cost") or 0), 4)
        row_cost = float(r.get("monthly_cost") or 0)
        breakdown.append({
            "resource_id": None,
            "resource_name": svc,
            "resource_type": r.get("resource_type") or svc,
            "region": r.get("region"),
            "monthly_cost": round(row_cost, 4),
            "currency": r.get("currency"),
            "monthly_cost_inr": round(row_cost * rate, 4) if rate is not None else None,
        })

    note = "NA — the provider billing API returned no cost data for this account."
    if all_rows:
        if region and not rows:
            note = f"No billed spend was reported for “{region}” in the last 30 days."
        elif region:
            note = f"Actual billed spend for “{region}” over the last 30 days, from the provider billing API."
        else:
            note = "Actual billed spend for the last 30 days from the provider billing API."

    return {
        "account_id": str(account_id),
        "total_monthly_cost": total,
        "currency": currency,
        "total_monthly_cost_inr": total_inr,
        "fx_rate_used": rate,
        "fx_as_of": date.today().isoformat() if rate is not None else None,
        "cost_source": "billing_api" if all_rows else None,
        "region": region,
        "by_type": by_type,
        "breakdown": breakdown[:20],
        "note": note,
    }


class CostService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def _accounts_in_scope(self, account_id: uuid.UUID | str) -> List[Any]:
        """The accounts a request covers — every account for "ALL", else one.

        Shared by the capability and quality endpoints so their idea of "the
        current scope" cannot drift from what the cost payloads actually
        aggregated.
        """
        from app.repository.cloud_account_repo import CloudAccountRepository

        repo = CloudAccountRepository(self.db)
        if account_id == "ALL":
            return await repo.list_all()
        try:
            aid = uuid.UUID(str(account_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid account ID")
        acc = await repo.get_by_id(aid)
        if not acc:
            raise HTTPException(status_code=404, detail="Account not found")
        return [acc]

    async def get_capabilities(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        """What cost questions this scope can answer. Never touches a provider
        API — capabilities are a property of the integration, not of whether a
        given request happened to succeed, so this always answers instantly."""
        accounts = await self._accounts_in_scope(account_id)
        payload = get_cost_capabilities(accounts)
        payload["account_id"] = str(account_id)
        payload["accounts_in_scope"] = len(accounts)
        return payload

    async def get_quality(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        """Data quality and per-dataset freshness for this scope.

        Reads only cached state, so the badge renders without waiting on a
        billing round trip. A scope whose cost has never been fetched reports
        quality GOOD with null freshness rather than inventing a problem — the
        absence of an error is not evidence of one.
        """
        accounts = await self._accounts_in_scope(account_id)
        assessment = assess_cost_quality(accounts)
        return {
            "account_id": str(account_id),
            **assessment,
            "capabilities": get_cost_capabilities(accounts),
            "freshness": {
                str(a.id): {
                    "account_name": a.account_name,
                    "provider": a.provider,
                    **get_cost_freshness(a),
                }
                for a in accounts
            },
        }

    # ── Persisted history (cloud_cost_facts) ─────────────────────────────────

    async def get_history(
        self, account_id: uuid.UUID | str, *, days: int = 90,
        group_by: Optional[str] = None,
        start_date: Optional[str] = None, end_date: Optional[str] = None,
        region: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Stored billing history for this scope.

        `start_date`/`end_date` (YYYY-MM-DD) override `days` when both are
        given, so a caller can ask for an arbitrary window rather than only a
        lookback. An incomplete or reversed pair is rejected rather than
        silently falling back to `days` — a report quietly covering a different
        period than the one on screen is worse than an error.

        Always reports `coverage` alongside the series, because a 90-day chart
        drawn from 6 days of stored facts is not a 90-day chart, and the caller
        has no way to tell from the series alone.
        """
        from datetime import date as _date, timedelta as _timedelta

        from app.repository.cost_fact_repo import CostFactRepository

        accounts = await self._accounts_in_scope(account_id)
        ids = [a.id for a in accounts]
        repo = CostFactRepository(self.db)

        custom = bool(start_date or end_date)
        if custom:
            if not (start_date and end_date):
                raise HTTPException(
                    status_code=400,
                    detail="A custom range needs both start_date and end_date.")
            try:
                start = _date.fromisoformat(start_date)
                end = _date.fromisoformat(end_date)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail="start_date and end_date must be YYYY-MM-DD.")
            if start > end:
                raise HTTPException(
                    status_code=400,
                    detail="start_date is after end_date.")
            span = (end - start).days + 1
            if span > MAX_REPORT_DAYS:
                raise HTTPException(
                    status_code=400,
                    detail=(f"That range covers {span} days; the maximum is "
                            f"{MAX_REPORT_DAYS}. Narrow the range."))
            days = span
        else:
            end = _date.today()
            start = end - _timedelta(days=max(1, min(days, MAX_REPORT_DAYS)))

        series = await repo.daily_series(ids, start, end, region=region)

        # AWS never stores a region on its ingested daily facts (see
        # AWSCostProvider.get_cost_report's own comment: Cost Explorer caps
        # GroupBy at two dimensions, and this product spends both on Service
        # and Usage Type rather than Region, to approximate a resource
        # breakdown). A region-filtered query against an AWS account's
        # history therefore always returns zero rows -- which looks exactly
        # like "no spend here" unless the caller is told the real reason.
        region_capability = None
        if region:
            aws_in_scope = [a for a in accounts if (a.provider or "").upper() == "AWS"]
            region_capability = (
                {
                    "supported": False,
                    "reason": (
                        "AWS Cost Explorer's GroupBy is limited to two dimensions per "
                        "request, and this product spends both on Service and Usage "
                        "Type (the closest thing to a resource breakdown AWS offers "
                        "without a separate Cost & Usage Report/Athena pipeline). "
                        "Region is not one of the two, so AWS's stored daily history "
                        "carries no region and cannot be filtered by one. Azure and "
                        "OCI do not have this limitation."
                    ),
                }
                if aws_in_scope else
                {"supported": True, "reason": None}
            )

        payload: Dict[str, Any] = {
            "account_id": str(account_id),
            "period": {"start": start.isoformat(), "end": end.isoformat(),
                       "days": days, "timezone": "UTC", "custom": custom},
            "region": region,
            "region_capability": region_capability,
            "series": series,
            "coverage": await repo.coverage(ids),
            "monthly": await repo.monthly_totals(ids),
            "source": "cloud_cost_facts",
        }
        if group_by:
            try:
                payload["grouped"] = await repo.totals_by(
                    ids, start, end, group_by, region=region)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            payload["group_by"] = group_by
        return payload

    async def get_coverage(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        """What history exists, and what that does and does not support."""
        from app.repository.cost_fact_repo import CostFactRepository

        accounts = await self._accounts_in_scope(account_id)
        repo = CostFactRepository(self.db)
        coverage = await repo.coverage([a.id for a in accounts])

        days = coverage["days_covered"]
        # Thresholds are stated rather than hidden so a caller can see WHY a
        # feature is withheld. Forecasting a month from under two weeks of
        # history, or calling a day anomalous against three samples, produces
        # confident nonsense.
        coverage["supports"] = {
            "daily_trend": days >= 2,
            "run_rate_forecast": days >= 14,
            "anomaly_baseline": days >= 30,
            "month_over_month": days >= 60,
        }
        coverage["account_id"] = str(account_id)
        coverage["accounts_in_scope"] = len(accounts)
        return coverage

    async def start_backfill(self, account_id: uuid.UUID, days: int) -> Dict[str, Any]:
        """Kick off a historical backfill and return its job immediately.

        The work runs detached: a 365-day walk across a throttled provider
        outlives any sane HTTP timeout, and holding the request open would just
        make the browser give up while the work continued anyway.
        """
        from app.core.database import AsyncSessionLocal
        from app.repository.cost_fact_repo import CostFactRepository
        from app.services import cost_ingestion

        accounts = await self._accounts_in_scope(account_id)
        account = accounts[0]
        job = await CostFactRepository(self.db).create_job(account.id, days)

        async def _run():
            # Its own session: the request's session closes when the response
            # is returned, and reusing it from a detached task would fail.
            async with AsyncSessionLocal() as db:
                try:
                    await cost_ingestion.run_backfill(db, account, days, job_id=job.id)
                except Exception as exc:
                    logger.exception("Backfill crashed for %s", account.account_name)
                    err = cost_errors.classify(exc, provider=account.provider)
                    await CostFactRepository(db).update_job(
                        job.id, status="FAILED",
                        finished_at=datetime.now(timezone.utc),
                        error_category=err.category, error_message=err.message[:2000],
                    )

        task = asyncio.create_task(_run())
        _warm_tasks.add(task)
        task.add_done_callback(_warm_tasks.discard)

        return {**job.to_dict(), "started": True}

    async def get_backfill_status(self, account_id: uuid.UUID) -> Dict[str, Any]:
        from app.repository.cost_fact_repo import CostFactRepository

        accounts = await self._accounts_in_scope(account_id)
        repo = CostFactRepository(self.db)
        job = await repo.latest_job(accounts[0].id)
        return {
            "account_id": str(account_id),
            "job": job.to_dict() if job else None,
            "coverage": await repo.coverage([a.id for a in accounts]),
        }

    async def get_resource_context(
        self, resource_id: uuid.UUID, *, days: int = 90,
    ) -> Dict[str, Any]:
        """One resource's cost alongside its config changes and security findings.

        The cross-feature view: it answers "why does this cost what it does" by
        putting three existing datasets next to each other, and is explicit
        that proximity in time is not causation.
        """
        from datetime import date as _date, timedelta as _timedelta

        from app.repository.cost_fact_repo import CostFactRepository
        from app.repository.resource_repo import ResourceRepository
        from app.services import cost_analytics, cost_correlation_service as corr

        res_repo = ResourceRepository(self.db)
        resource = await res_repo.get_by_id(resource_id)
        if resource is None:
            raise HTTPException(status_code=404, detail="Resource not found")

        end = _date.today()
        start = end - _timedelta(days=max(1, min(days, MAX_REPORT_DAYS)))

        # Per-resource daily history is not stored yet (see cost_ingestion on
        # why a window total must not be written as a day), so the series here
        # is the ACCOUNT's, and is labelled as such rather than presented as
        # this resource's own spend.
        repo = CostFactRepository(self.db)
        series = await repo.daily_series([resource.account_id], start, end)
        anomalies = cost_analytics.detect_anomalies(series)
        flagged = [
            item
            for bucket in (anomalies.get("by_currency") or {}).values()
            if bucket.get("available")
            for item in bucket.get("anomalies", [])
        ]

        # Both of these are best-effort. A missing drift history or an
        # unavailable findings table must degrade this view to "cost only"
        # rather than failing the request — the cost half is still useful, and
        # an exception here would make the whole panel disappear.
        changes: List[Any] = []
        findings: List[Any] = []
        try:
            from app.repository.drift_repo import DriftRepository

            changes = await DriftRepository(self.db).timeline_for_resource(
                resource.provider_resource_id, limit=200,
            )
        except Exception as exc:
            logger.debug("Drift history unavailable for %s: %s", resource_id, exc)
        try:
            from app.repository.security_repo import SecurityRepository

            rows, _total = await SecurityRepository(self.db).list_findings(
                account_ids=[resource.account_id], limit=200,
            )
            # The repository filters by account, not by resource, so narrow to
            # this resource here rather than showing the account's whole
            # findings list under one resource's heading.
            findings = [
                f for f in rows
                if getattr(f, "provider_resource_id", None)
                == resource.provider_resource_id
            ]
        except Exception as exc:
            logger.debug("Security findings unavailable for %s: %s", resource_id, exc)

        context = corr.correlate(
            resource=resource, series=series, changes=changes,
            findings=findings, anomalies=flagged,
        )
        context["series_scope"] = (
            "Account-level daily spend. Per-resource daily history is not stored "
            "yet, so this series is the account's, not this resource's alone."
        )
        context["period"] = {"start": start.isoformat(), "end": end.isoformat(),
                             "days": days}
        return context

    # ── Allocation, governance, reports, observability ───────────────────────

    async def get_allocation(
        self, account_id: uuid.UUID | str, *, dimension: str = "environment",
        days: int = RESOURCE_DECORATION_DAYS,
    ) -> Dict[str, Any]:
        """Spend attributed to a business dimension, plus tag coverage.

        Depends on per-resource cost, so an AWS-only scope genuinely cannot be
        allocated. That is reported as `supported: false` with the provider's
        reason rather than as an empty breakdown, which would read as "nothing
        is tagged" when the truth is "we cannot see what anything costs".
        """
        from app.repository.resource_repo import ResourceRepository
        from app.services import cost_allocation_service as alloc

        accounts = await self._accounts_in_scope(account_id)
        caps = get_cost_capabilities(accounts)
        supported = bool(caps["effective"].get("resource"))

        res_repo = ResourceRepository(self.db)
        resources: List[Any] = []
        cost_map: Dict[str, Dict[str, Any]] = {}
        for acc in accounts:
            resources.extend(await res_repo.list_by_account(acc.id))
            if provider_caps.for_provider(acc.provider) and \
                    provider_caps.for_provider(acc.provider).resource:
                cost_map.update(peek_costs_by_resource(acc))
                ensure_costs_by_resource_warm(acc)

        try:
            allocation = alloc.allocate(resources, cost_map, dimension=dimension)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        return {
            "account_id": str(account_id),
            "supported": supported,
            "unsupported_reason": (
                None if supported else caps["blocked_by"].get("resource")
            ),
            "allocation": allocation,
            "tag_coverage": alloc.tag_coverage(resources),
            "dimensions_available": sorted(alloc.DIMENSIONS),
            "source": "billing_api + inventory tags",
        }

    async def _compute_governance(
        self, accounts: Sequence[Any],
    ) -> Dict[str, Any]:
        """Governance findings + FinOps health for a resolved list of
        accounts. Shared by the single-account/ALL path and the per-client
        scorecard — one computation, so the two can never disagree about what
        an account's tagging or budget coverage is worth.
        """
        from app.repository.resource_repo import ResourceRepository
        from app.repository.cost_fact_repo import CostFactRepository
        from app.models.cost_budget import CloudCostBudget
        from app.models.cost_recommendation import STATE_NEW
        from app.repository.cost_reco_repo import CostRecommendationRepository
        from sqlalchemy import func, or_, select as _select
        from app.services import cost_allocation_service as alloc
        from app.services import cost_recommendation_service as reco
        from app.services.intelligence_service import IntelligenceService

        ids = [a.id for a in accounts]

        res_repo = ResourceRepository(self.db)
        resources: List[Any] = []
        for acc in accounts:
            resources.extend(await res_repo.list_by_account(acc.id))

        fact_repo = CostFactRepository(self.db)
        coverage = await fact_repo.coverage(ids)
        tags = alloc.tag_coverage(resources)

        # Budgets whose scope actually covers this account set: scoped to one
        # of these accounts, OR organisation-wide (account_id IS NULL). The
        # previous version counted every enabled budget in the whole database
        # regardless of scope, which inflated budget_coverage for every
        # account by every OTHER account's budgets too.
        budget_count = (await self.db.execute(
            _select(func.count()).select_from(CloudCostBudget).where(
                CloudCostBudget.enabled.is_(True),
                or_(CloudCostBudget.account_id.in_(ids), CloudCostBudget.account_id.is_(None))
                if ids else CloudCostBudget.account_id.is_(None),
            )
        )).scalar() or 0

        cost_map: Dict[str, Dict[str, Any]] = {}
        for acc in accounts:
            cost_map.update(peek_costs_by_resource(acc))
        allocation = alloc.allocate(resources, cost_map, dimension="owner")
        money_coverage = None
        cov_values = [v for v in allocation["coverage_percent_by_currency"].values()
                      if v is not None]
        if cov_values:
            money_coverage = round(sum(cov_values) / len(cov_values), 2)

        priced = allocation["priced_resource_count"]
        unpriced = allocation["unpriced_resource_count"]
        unpriced_ratio = (
            unpriced / (priced + unpriced) if (priced + unpriced) else None
        )

        # The OPTIMIZE signal: of the findings a human could currently see on
        # the Cost tab (open, or resolved BY a human — see on_cost_tab), what
        # share have moved past NEW, i.e. someone has actually looked at them.
        # None of this is invented when nothing has ever been analysed: an
        # estate with zero visible findings scores 100 only if at least one
        # account in scope HAS been analysed; otherwise there is nothing to
        # measure, and None (excluded) is the honest answer, not a free 100.
        engine_view = await IntelligenceService(self.db).cost_findings(accounts, resources)
        cost_tab_findings = [f for f in engine_view["findings"] if reco.on_cost_tab(f)]
        analysed_any = any(s.get("mode") == "analysed" for s in engine_view.get("sources", []))
        reviewed_count: Optional[int] = None
        if cost_tab_findings:
            decisions = await CostRecommendationRepository(self.db).decisions_for(ids)
            reviewed_count = sum(
                1 for f in cost_tab_findings
                if reco.from_finding(f, decisions=decisions).get("state") != STATE_NEW
            )
            optimization_review_rate = reviewed_count / len(cost_tab_findings) * 100
        else:
            optimization_review_rate = 100.0 if analysed_any else None

        finops_health = alloc.finops_health(
            tag_coverage_percent=tags["overall_coverage_percent"],
            allocation_coverage_percent=money_coverage,
            days_of_history=coverage["days_covered"],
            budget_count=budget_count,
            accounts_in_scope=len(accounts),
            anomaly_monitoring_ready=coverage["days_covered"] >= 30,
            unpriced_resource_ratio=unpriced_ratio,
            optimization_review_rate=optimization_review_rate,
        )

        return {
            "governance": alloc.governance_findings(resources),
            "finops_health": finops_health,
            "data_coverage": {
                "historical_days": coverage["days_covered"],
                "billing_facts": coverage["records"],
                "resource_attribution_percent": (
                    round((1 - unpriced_ratio) * 100, 2)
                    if unpriced_ratio is not None else None
                ),
                "tag_allocation_percent": tags["overall_coverage_percent"],
                "forecast_ready": coverage["days_covered"] >= 14,
                "optimization_review": {
                    "visible_findings": len(cost_tab_findings),
                    "reviewed": reviewed_count,
                    "analysed": analysed_any,
                },
            },
        }

    async def _record_scorecard_snapshot(
        self, *, scope_type: str, scope_id: uuid.UUID, accounts: Sequence[Any],
        finops_health: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """Write today's snapshot (at most once) and return the trend so far,
        oldest first. Failure to write never breaks the read — a scorecard
        that cannot be read because its OWN history failed to persist would be
        a worse outcome than a missing day in the trend."""
        from datetime import date as _date

        from app.repository.finops_scorecard_repo import FinopsScorecardRepository

        repo = FinopsScorecardRepository(self.db)
        try:
            await repo.record_if_new(
                scope_type=scope_type, scope_id=scope_id, as_of=_date.today(),
                score=finops_health.get("score"), accounts_in_scope=len(accounts),
                health=finops_health,
            )
            history = await repo.history_for(scope_type=scope_type, scope_id=scope_id)
            return [row.to_dict() for row in history]
        except Exception:  # noqa: BLE001 — history is a bonus, not the answer
            logger.exception(
                "Could not record/read the FinOps scorecard history for %s %s",
                scope_type, scope_id,
            )
            return []

    async def get_governance(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        """Governance gaps and the FinOps health score.

        The health score is returned alongside spend-free governance findings
        and is explicitly labelled a maturity measure — it must never be read
        as a cost.
        """
        from app.models.finops_scorecard import ESTATE_SCOPE_ID, SCOPE_ACCOUNT, SCOPE_ESTATE

        accounts = await self._accounts_in_scope(account_id)
        result = await self._compute_governance(accounts)

        if account_id == "ALL":
            scope_type, scope_id = SCOPE_ESTATE, ESTATE_SCOPE_ID
        else:
            scope_type, scope_id = SCOPE_ACCOUNT, accounts[0].id
        result["history"] = await self._record_scorecard_snapshot(
            scope_type=scope_type, scope_id=scope_id, accounts=accounts,
            finops_health=result["finops_health"],
        )
        result["account_id"] = str(account_id)
        return result

    async def get_client_governance(self, client_id: uuid.UUID) -> Dict[str, Any]:
        """The same FinOps scorecard, for every account under one client.

        Exists because `get_governance` only ever takes a single account or
        every account ("ALL") — there was no scope in between covering
        exactly one customer's estate, which is the natural unit for an MSP
        report. Reuses the identical computation `get_governance` does; the
        only thing that differs is which accounts are in scope.
        """
        from sqlalchemy import select as _select

        from app.models.client import CloudClient
        from app.models.cloud_account import CloudAccount
        from app.models.finops_scorecard import SCOPE_CLIENT

        client = await self.db.get(CloudClient, client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")

        accounts = list((await self.db.execute(
            _select(CloudAccount).where(CloudAccount.client_id == client_id)
        )).scalars().all())

        result = await self._compute_governance(accounts)
        result["history"] = await self._record_scorecard_snapshot(
            scope_type=SCOPE_CLIENT, scope_id=client_id, accounts=accounts,
            finops_health=result["finops_health"],
        )
        result["client_id"] = str(client_id)
        result["client_name"] = client.name
        result["accounts_in_scope"] = [
            {"id": str(a.id), "name": a.account_name, "provider": a.provider}
            for a in accounts
        ]
        return result

    async def get_report_types(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        """Report types, each marked available or blocked with the reason."""
        from app.services import cost_report_service as reports

        accounts = await self._accounts_in_scope(account_id)
        return {
            "account_id": str(account_id),
            "types": reports.available_types(get_cost_capabilities(accounts)),
            "csv_columns": list(reports.CSV_COLUMNS),
        }

    async def get_executive_report(
        self, account_id: uuid.UUID | str, *, days: int = 30,
    ) -> Dict[str, Any]:
        """The one-page executive summary, assembled from the same figures the
        rest of the page shows — never recomputed differently."""
        from app.services import cost_report_service as reports

        analytics = await self.get_cost_analytics(account_id)
        trends = await self.get_trends(account_id, days=days)
        forecast = await self.get_forecast(account_id)
        anomalies = await self.get_anomalies(account_id)

        currency = (analytics.get("totals_by_currency") or {}).get("currency")
        mom = ((trends.get("month_over_month") or {}).get("by_currency") or {})
        change = (mom.get(currency) or {}).get("change") if currency else None

        allocation = None
        try:
            allocation = (await self.get_allocation(account_id))["allocation"]
        except HTTPException:
            allocation = None

        return {
            "account_id": str(account_id),
            "summary": reports.executive_summary(
                totals=analytics.get("totals_by_currency") or {},
                change=change,
                top_drivers=analytics.get("by_service") or [],
                savings=analytics.get("savings_summary"),
                anomaly_count=anomalies.get("total", 0),
                forecast=forecast,
                quality=analytics.get("quality"),
                allocation=allocation,
            ),
        }

    # ── Analytics over stored history ────────────────────────────────────────

    async def _history_series(self, account_ids, days: int):
        """The daily series backing every analytic below."""
        from datetime import date as _date, timedelta as _timedelta

        from app.repository.cost_fact_repo import CostFactRepository

        end = _date.today()
        start = end - _timedelta(days=max(1, min(days, MAX_REPORT_DAYS)))
        repo = CostFactRepository(self.db)
        return repo, start, end, await repo.daily_series(account_ids, start, end)

    async def get_forecast(
        self, account_id: uuid.UUID | str, *, days: int = 90,
    ) -> Dict[str, Any]:
        """Run-rate projection per currency, with its confidence and basis.

        Never a model, and labelled as such everywhere it surfaces. Returns NA
        with a reason when there is too little history rather than projecting a
        straight line through noise.
        """
        from app.services import cost_analytics

        accounts = await self._accounts_in_scope(account_id)
        ids = [a.id for a in accounts]
        repo, start, end, series = await self._history_series(ids, days)
        result = cost_analytics.forecast(series)
        result["account_id"] = str(account_id)
        result["coverage"] = await repo.coverage(ids)
        result["source"] = "cloud_cost_facts"
        return result

    async def get_anomalies(
        self, account_id: uuid.UUID | str, *, days: int = 90,
        percent_threshold: float = None, min_absolute: float = None,
    ) -> Dict[str, Any]:
        """Days whose spend departs from their own trailing baseline."""
        from app.services import cost_analytics

        accounts = await self._accounts_in_scope(account_id)
        ids = [a.id for a in accounts]
        repo, start, end, series = await self._history_series(ids, days)

        kwargs = {}
        if percent_threshold is not None:
            kwargs["percent_threshold"] = percent_threshold
        if min_absolute is not None:
            kwargs["min_absolute"] = min_absolute

        result = cost_analytics.detect_anomalies(series, **kwargs)
        result["account_id"] = str(account_id)
        result["coverage"] = await repo.coverage(ids)
        result["source"] = "cloud_cost_facts"
        return result

    async def get_trends(
        self, account_id: uuid.UUID | str, *, days: int = 30,
        dimension: str = "service",
    ) -> Dict[str, Any]:
        """Change analysis, month-over-month and the spend calendar.

        The comparison period is the SAME LENGTH immediately before the current
        one — comparing 30 days against a 14-day remainder would manufacture a
        decline that never happened.
        """
        from datetime import date as _date, timedelta as _timedelta

        from app.repository.cost_fact_repo import CostFactRepository
        from app.services import cost_analytics

        accounts = await self._accounts_in_scope(account_id)
        ids = [a.id for a in accounts]
        repo = CostFactRepository(self.db)

        days = max(1, min(days, MAX_REPORT_DAYS))
        end = _date.today()
        start = end - _timedelta(days=days)
        prior_start = start - _timedelta(days=days)

        current = await repo.totals_by(ids, start, end, dimension, limit=500)
        previous = await repo.totals_by(ids, prior_start, start, dimension, limit=500)
        series = await repo.daily_series(ids, start, end)

        forecast_result = cost_analytics.forecast(
            await repo.daily_series(ids, end - _timedelta(days=90), end)
        )
        anomalies = cost_analytics.detect_anomalies(
            await repo.daily_series(ids, end - _timedelta(days=90), end)
        )

        return {
            "account_id": str(account_id),
            "period": {"start": start.isoformat(), "end": end.isoformat(),
                       "days": days, "timezone": "UTC"},
            "comparison_period": {"start": prior_start.isoformat(),
                                  "end": start.isoformat(), "days": days},
            "change": cost_analytics.change_analysis(
                current, previous, dimension=dimension
            ),
            "month_over_month": cost_analytics.month_over_month(
                await repo.monthly_totals(ids), forecast_result=forecast_result
            ),
            "calendar": cost_analytics.spend_calendar(series, anomalies=anomalies),
            "coverage": await repo.coverage(ids),
            "source": "cloud_cost_facts",
        }

    async def get_cost_summary(self, account_id: uuid.UUID) -> Dict[str, Any]:
        from app.repository.cloud_account_repo import CloudAccountRepository

        account = await CloudAccountRepository(self.db).get_by_id(account_id)
        if not account:
            raise HTTPException(status_code=404, detail="Account not found")

        rows = await fetch_real_costs(account)
        breakdown = [
            {
                "resource_type": r.get("resource_type") or "Unknown",
                "resource_name": r.get("resource_name") or "Unknown",
                "region": r.get("region"),
                "monthly_cost": round(float(r.get("monthly_cost") or 0), 4),
                "currency": r.get("currency"),
            }
            for r in sorted(rows, key=lambda x: -(x.get("monthly_cost") or 0))
        ]

        return {
            "account_id": str(account_id),
            "provider": account.provider,
            "total_monthly_cost": (
                round(sum(float(r.get("monthly_cost") or 0) for r in rows), 2)
                if rows else None
            ),
            "currency": _single_currency([r.get("currency") for r in rows]) if rows else None,
            "cost_source": "billing_api" if rows else None,
            "breakdown": breakdown,
        }

    async def get_cost_analytics(self, account_id: uuid.UUID | str) -> Dict[str, Any]:
        from app.repository.cloud_account_repo import CloudAccountRepository
        from app.repository.resource_repo import ResourceRepository

        res_repo = ResourceRepository(self.db)
        acc_repo = CloudAccountRepository(self.db)

        if account_id == "ALL":
            resources = await res_repo.list_all()
            accounts = await acc_repo.list_all()
        else:
            try:
                aid = uuid.UUID(str(account_id))
            except ValueError:
                return {"error": "Invalid account ID"}
            resources = await res_repo.list_by_account(aid)
            acc = await acc_repo.get_by_id(aid)
            if not acc:
                raise HTTPException(status_code=404, detail="Account not found")
            accounts = [acc]

        # Every account's real-cost, daily-cost, AND per-resource-cost billing
        # calls are independent of each other — fan them ALL out concurrently
        # instead of awaiting 3×N billing API round-trips one at a time. This
        # is the difference between "as slow as the sum of every call" and "as
        # slow as the single slowest call". The third gather's result isn't
        # used directly here — it just warms fetch_real_costs_by_resource's
        # cache so build_stopped_instances's later call is a cache hit instead
        # of a fourth sequential network wave.
        #
        # Bounded: the fan-out is only as fast as the SLOWEST provider, and a
        # sick one can take a minute (Azure was measured at 52s while its token
        # endpoint kept resetting connections). Blocking on that meant the whole
        # Cost page never rendered. Past the deadline we stop waiting, return
        # whatever is cached, and let the in-flight work keep going so the next
        # load is a cache hit — the same treatment that fixed the Resources page.
        gathered = asyncio.gather(
            asyncio.gather(*(fetch_real_costs(acc) for acc in accounts)),
            asyncio.gather(*(fetch_daily_costs(acc) for acc in accounts)),
            asyncio.gather(*(fetch_real_costs_by_resource(acc) for acc in accounts)),
        )
        partial = False
        try:
            # shield: on timeout the work must continue populating the cache,
            # not be cancelled — otherwise every load restarts from cold.
            real_cost_rows, daily_cost_rows, _ = await asyncio.wait_for(
                asyncio.shield(gathered), _ANALYTICS_DEADLINE_SECONDS
            )
        except asyncio.TimeoutError:
            partial = True
            _warm_tasks.add(gathered)
            gathered.add_done_callback(_warm_tasks.discard)
            real_cost_rows = [_cache_get(_real_cost_cache, str(a.id)) or [] for a in accounts]
            daily_cost_rows = [_cache_get(_daily_cost_cache, str(a.id)) or [] for a in accounts]
            logger.warning(
                "Cost analytics exceeded %ss for %d account(s) — returning cached data and "
                "finishing the refresh in the background.",
                _ANALYTICS_DEADLINE_SECONDS, len(accounts),
            )

        # ── Real billed totals per service ────────────────────────────────────
        # Aggregated by (account, service, currency), NOT one row per provider
        # record. The providers return a row per service PER REGION, so simply
        # appending produced a "top cost drivers" list with the same service
        # listed several times — "Amazon Elastic Compute Cloud - Compute" at
        # both #1 and #3, "EC2 - Other" twice, and so on. Every one of those
        # pairs was the same service in two regions, and splitting it made the
        # biggest cost look smaller than it is and pushed real drivers off the
        # end of the list.
        #
        # Currency is part of the key because amounts in different currencies
        # are never added together. Regions are kept as a breakdown on the
        # entry rather than discarded, so the UI can still answer "where".
        grouped: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
        real_total = 0.0
        real_found = False
        currencies: List[Optional[str]] = []
        for acc, rows in zip(accounts, real_cost_rows):
            if not rows:
                continue
            real_found = True
            real_total += sum(float(r.get("monthly_cost") or 0.0) for r in rows)
            for r in rows:
                currency = r.get("currency")
                currencies.append(currency)
                service = r.get("resource_name") or "Unknown"
                region = r.get("region")
                amount = float(r.get("monthly_cost") or 0.0)
                key = (str(acc.id), service, currency or "")
                entry = grouped.get(key)
                if entry is None:
                    entry = grouped[key] = {
                        "account": acc.account_name,
                        "account_id": str(acc.id),
                        "provider": acc.provider,
                        "service": service,
                        "monthly_cost": 0.0,
                        "currency": currency,
                        "regions": {},
                    }
                entry["monthly_cost"] += amount
                if region:
                    entry["regions"][region] = round(
                        entry["regions"].get(region, 0.0) + amount, 4)

        by_service: List[Dict[str, Any]] = []
        for entry in grouped.values():
            regions = entry.pop("regions")
            entry["monthly_cost"] = round(entry["monthly_cost"], 2)
            # `region` stays a single value when the spend genuinely sits in one
            # place, so existing consumers keep working; `by_region` carries the
            # split when there is one, and `region_count` says so without the
            # caller having to count.
            entry["by_region"] = [
                {"region": name, "monthly_cost": round(value, 2)}
                for name, value in sorted(regions.items(), key=lambda kv: -kv[1])
            ]
            entry["region"] = (entry["by_region"][0]["region"]
                               if len(entry["by_region"]) == 1 else None)
            entry["region_count"] = len(entry["by_region"])
            by_service.append(entry)
        by_service.sort(key=lambda x: -x["monthly_cost"])

        total_monthly_cost = round(real_total, 2) if real_found else None
        currency = _single_currency(currencies) if real_found else None
        cost_source = "billing_api" if real_found else None

        # ── Real daily spend trend (billing API, last 30 days) ────────────────
        trend_by_date: Dict[str, Dict[str, Any]] = {}
        trend_currencies: List[Optional[str]] = []
        for daily_rows in daily_cost_rows:
            for d in daily_rows:
                if not d.get("date"):
                    continue
                entry = trend_by_date.setdefault(d["date"], {"date": d["date"], "cost": 0.0})
                entry["cost"] += float(d.get("cost") or 0)
                trend_currencies.append(d.get("currency"))
        trends = sorted(trend_by_date.values(), key=lambda x: x["date"])
        for t in trends:
            t["cost"] = round(t["cost"], 4)
        trend_currency = _single_currency(trend_currencies) if trends else None

        # ── Optimization recommendations ─────────────────────────────────────
        # Read from the Resource Intelligence engine: the same findings the
        # Intelligence tab lists, with the same evidence, savings and status,
        # so the two tabs can never disagree about a resource. (This block
        # used to derive its own 17 rules inline; each one is now an engine
        # rule, a security-engine control, or was retired for firing on every
        # resource of a type with no evidence.) Savings stay NA unless billing
        # or a provider price list supports a figure.
        from app.models.cost_recommendation import CLOSED_STATES
        from app.optimization import rules as opt_rules
        from app.repository.cost_reco_repo import CostRecommendationRepository
        from app.services import cost_recommendation_service as reco
        from app.services.intelligence_service import IntelligenceService

        decisions = await CostRecommendationRepository(self.db).decisions_for(
            [a.id for a in accounts]
        )
        engine_view = await IntelligenceService(self.db).cost_findings(accounts, resources)
        optimizations = [
            reco.from_finding(
                f, decisions=decisions,
                legacy_rules=getattr(opt_rules.by_id(f.get("rule_id")), "supersedes", ()),
            )
            for f in engine_view["findings"] if reco.on_cost_tab(f)
        ]

        # ── Structure, score and lifecycle ───────────────────────────────────
        # Category, confidence, actionability, a published priority score and
        # the human decision, joined by the finding's fingerprint.
        optimizations = reco.enrich(
            optimizations, account_id=account_id, decisions=decisions,
        )
        savings_breakdown = reco.savings_summary(optimizations)
        savings_by_category = reco.by_category(optimizations)

        # The headline saving is shown in the account's billing currency, so
        # it is only a number when every open priced saving is in that
        # currency. Closed (dismissed/implemented) ones are not counted.
        open_priced = [
            o for o in optimizations
            if o.get("state") not in CLOSED_STATES
            and isinstance(o.get("potential_savings"), (int, float))
        ]
        codes = {o.get("savings_currency") for o in open_priced}
        potential_savings = (
            round(sum(o["potential_savings"] for o in open_priced), 2)
            if open_priced and currency and codes == {currency} else None
        )

        stopped_instances = await build_stopped_instances(resources, accounts)

        # Real reasons for any account that failed above — one bad account in an
        # "ALL" view shouldn't be silently absorbed into a lower total with no
        # explanation of which account is broken or why.
        cost_diagnostics: List[Dict[str, Any]] = []
        for acc in accounts:
            reason = get_cost_diagnostic(acc.id)
            if reason:
                cost_diagnostics.append({
                    "account_id": str(acc.id),
                    "account_name": acc.account_name,
                    "provider": acc.provider,
                    **reason,
                })

        # The real per-currency total, plus the same total converted to INR
        # using a live rate — see `fx_rate_service`/`cost_money.convert_total`.
        # Converting does not replace `by_currency`/`mixed`: a mixed-currency
        # scope still has no single native total, but it now also has one
        # honest INR figure instead of only NA.
        _cost_total = cost_money.total(
            (r.get("monthly_cost"), r.get("currency")) for r in by_service
        ).with_reason(_diagnostic_summary(cost_diagnostics))
        _fx_rates = await fx_rate_service.get_rates_for(self.db, _cost_total.by_currency.keys())

        return {
            "account_id": str(account_id),
            "trends": trends,
            "trend_currency": trend_currency,
            "optimizations": optimizations,
            # Per account: analysed (findings from the latest Resource
            # Intelligence run) or preview (configuration and billing only,
            # before the first analysis).
            "optimizations_source": engine_view["sources"],
            # Split by how well each saving is known (85) and grouped by
            # currency (86) — never one combined number.
            "savings_summary": savings_breakdown,
            "savings_by_category": savings_by_category,
            "stopped_instances": stopped_instances,
            "total_monthly_cost": total_monthly_cost,
            "total_resources": len(resources),
            "potential_savings": potential_savings,
            "net_projected_cost": (
                round(max(0.0, total_monthly_cost - potential_savings), 2)
                if total_monthly_cost is not None and potential_savings is not None
                else None
            ),
            "cost_source": cost_source,
            "currency": currency,
            "by_service": by_service[:20],
            # Billed spend per region, derived from the same per-service rows
            # rather than from a second query — so the region totals and the
            # service totals always add up to the same number. A row the
            # provider gave us with no region lands under "Not reported" and is
            # NOT silently dropped: an unregioned charge is still real money,
            # and omitting it would make the regions fail to reconcile with the
            # account total.
            "by_region": _regional_totals(by_service),
            "cost_diagnostics": cost_diagnostics,
            # True when a provider was still responding at the deadline: the
            # numbers shown are cached, and a refresh is finishing in the
            # background. Lets the UI say "still refreshing" instead of
            # presenting a stale/NA figure as final.
            "partial": partial,

            # ── Contract fields ──────────────────────────────────────────────
            # Added so a caller can tell a complete answer from a partial one,
            # a real zero from an unavailable value, and live data from a stale
            # fallback, WITHOUT inspecting the numbers and guessing.
            #
            # `totals_by_currency` is the honest multi-cloud total: when an ALL
            # view spans USD and INR there is no single number, and the old
            # `total_monthly_cost`/`currency` pair could only answer NA. The
            # per-currency breakdown keeps the real figures visible instead.
            # When the sum is empty, the reason is taken from the diagnostic
            # this request already collected rather than guessed. An Azure
            # subscription being rate-limited used to render as "the provider
            # returned no billing records", which reads as "this account has no
            # spend" — while its stored history held a real 12.6 lakh.
            "totals_by_currency": {
                **_cost_total.to_dict(),
                **cost_money.convert_total(_cost_total, _fx_rates),
                "fx_as_of": date.today().isoformat(),
            },
            "capabilities": get_cost_capabilities(accounts),
            "quality": assess_cost_quality(accounts),
            "freshness": {
                str(a.id): {"account_name": a.account_name, "provider": a.provider,
                            **get_cost_freshness(a)}
                for a in accounts
            },
            # A window is only as authoritative as its worst account: the
            # deadline firing means some of this is cached, so it is PARTIAL,
            # never COMPLETE.
            "data_status": (
                "partial" if partial or cost_diagnostics
                else ("complete" if real_found else "no_data")
            ),
        }

    async def get_cost_report(
        self, account_id: uuid.UUID | str, days: int, group_by: str = "service",
        *,
        region: Optional[str] = None,
        service: Optional[str] = None,
        resource_type: Optional[str] = None,
        cost_component: Optional[str] = None,
        status: Optional[str] = None,
        min_cost: Optional[float] = None,
        max_cost: Optional[float] = None,
        dimensions: Optional[str] = None,
        page: Optional[int] = None,
        page_size: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Real cost ledger for the requested lookback window (clamped to
        MAX_REPORT_DAYS), in one of three shapes:

        group_by="service"  — one row per day per service (the spend timeline).
        group_by="resource" — one row per billed RESOURCE, totalled over the
            window, enriched from our inventory with the resource's name, type,
            size, cost component, and what it is attached to. Per-resource-PER-DAY
            is deliberately not offered: OCI alone returns ~11k rows for 7 days,
            so a year would be ~570k rows — unusable in a browser and pointless
            in a report.
        group_by="summary"  — the SAME per-resource rows reduced to one row per
            unique combination of `dimensions` (comma-separated: provider,
            account_name, region, service, resource_type, cost_component,
            status), each with resource_count and a cost total per component
            plus overall total. This is the drill-down tree's per-node counts
            and the "Group By: X" summary table, computed once server-side
            rather than re-reduced from scratch by the browser on every
            grouping change.

        The `region`/`service`/`resource_type`/`cost_component`/`status`/
        `min_cost`/`max_cost` filters apply to all three shapes (day-rows for
        "service" mode have no resource_type/status, so those two are simply a
        no-op there). `page`/`page_size` are opt-in — omitting both returns
        every matching row exactly as before, so existing callers (the
        Detailed Cost Report panel) are unaffected.
        """
        from app.repository.cloud_account_repo import CloudAccountRepository

        days = max(1, min(days, MAX_REPORT_DAYS))
        acc_repo = CloudAccountRepository(self.db)

        if account_id == "ALL":
            accounts = await acc_repo.list_all()
        else:
            try:
                aid = uuid.UUID(str(account_id))
            except ValueError:
                return {"error": "Invalid account ID"}
            acc = await acc_repo.get_by_id(aid)
            if not acc:
                raise HTTPException(status_code=404, detail="Account not found")
            accounts = [acc]

        rows: List[Dict[str, Any]] = []
        currencies: List[Optional[str]] = []
        needs_resource_rows = group_by in ("resource", "summary")
        # Accounts whose provider has no per-resource billing API (AWS today)
        # never populate `cost_map` below. group_by="summary" still owes them
        # a real answer (it powers the cost-component summary cards), so it
        # falls back to that account's day/service rows instead of going
        # silently empty — group_by="resource" does NOT fall back, preserving
        # the deliberate, honest per-account gap agreed for AWS.
        accounts_without_resource_rows: List[Any] = []

        if needs_resource_rows:
            res_repo = ResourceRepository(self.db)
            for acc in accounts:
                cost_map = await fetch_real_costs_by_resource(acc, days)
                if not cost_map:
                    if group_by == "summary":
                        accounts_without_resource_rows.append(acc)
                    continue
                # Providers report only an ID on billing rows (OCI never sends a
                # name), so join our own inventory for the human-readable detail.
                inventory = await res_repo.list_by_account(acc.id)
                by_pid: Dict[str, Any] = {}
                for r in inventory:
                    if r.provider_resource_id:
                        by_pid[r.provider_resource_id] = r
                        by_pid.setdefault(r.provider_resource_id.lower(), r)

                for pid, entry in cost_map.items():
                    res = by_pid.get(pid) or by_pid.get(str(pid).lower())
                    cfg = (res.config or {}) if res is not None else {}
                    size_gb = (
                        cfg.get("size_gb") or cfg.get("disk_size_gb")
                        or cfg.get("attached_storage_gb")
                    )
                    # Fall back to the ID's own structure when inventory has no
                    # match, so a billed row is never fully anonymous.
                    id_type, id_name = _identify_from_provider_id(pid)
                    in_inventory = res is not None
                    row_service = entry.get("service")
                    currencies.append(entry.get("currency"))
                    rows.append({
                        "provider": acc.provider,
                        "account_id": str(acc.id),
                        "account_name": acc.account_name,
                        "service": row_service,
                        # A billed row's own service IS its cost component —
                        # see the classifier's docstring for why this is the
                        # real granularity, not a fabricated sub-split.
                        "cost_component": _normalize_cost_component(acc.provider, row_service),
                        "region": entry.get("region")
                                  or (res.region_or_zone if in_inventory else None),
                        "resource_name": (res.resource_name if in_inventory else None) or id_name,
                        "resource_type": (res.resource_type if in_inventory else None) or id_type,
                        "status": res.status if in_inventory else None,
                        "provider_resource_id": pid,
                        # Our own DB id (not the provider's), so the UI can link
                        # straight to /cloud/resources/{id} — that route takes
                        # the internal id, never the provider_resource_id above.
                        "resource_id": str(res.id) if in_inventory else None,
                        # Only meaningful when unmatched — OCI's per-resource
                        # billing carries no compartment on rows that DO join
                        # to inventory, since the resource's own record already
                        # has that context. For an unmatched row (id_type is
                        # often None too, e.g. Object Storage's billing-internal
                        # resourceId isn't a parseable OCID) this is the only
                        # location clue available, so surface it instead of a
                        # bare ID with nothing else to go on.
                        "compartment_name": None if in_inventory else entry.get("compartment_name"),
                        # Generalizes the storage->compute attachment link to any
                        # resource type, so "Block Volume A attached to Instance
                        # A" is representable without being folded into one row.
                        "parent_resource_id": cfg.get("attached_to_id"),
                        "size_gb": size_gb,
                        "attachment_status": cfg.get("attachment_status"),
                        "attached_to_name": cfg.get("attached_to_name"),
                        "attached_to_status": cfg.get("attached_to_status"),
                        # False = billed but not in inventory (a type discovery
                        # doesn't scan, or deleted mid-window). Surfaced so the UI
                        # can label it instead of showing a blank name.
                        "in_inventory": in_inventory,
                        "cost": entry.get("monthly_cost"),
                        "currency": entry.get("currency"),
                    })

        if not needs_resource_rows or accounts_without_resource_rows:
            fallback_accounts = accounts if not needs_resource_rows else accounts_without_resource_rows
            for acc in fallback_accounts:
                for r in await fetch_cost_report(acc, days):
                    row_service = r.get("service")
                    currencies.append(r.get("currency"))
                    rows.append({
                        "date": r.get("date"),
                        "provider": acc.provider,
                        "account_id": str(acc.id),
                        "account_name": acc.account_name,
                        "service": row_service,
                        "cost_component": _normalize_cost_component(acc.provider, row_service),
                        # Real for AWS (Cost Explorer's USAGE_TYPE dimension);
                        # None for OCI/Azure, which get resource_type from their
                        # per-resource join in group_by="resource" instead.
                        "resource_type": r.get("resource_type"),
                        "region": r.get("region"),
                        "cost": r.get("cost"),
                        "currency": r.get("currency"),
                    })

        # ── Server-side filters, shared by every group_by shape ─────────────
        def _matches(r: Dict[str, Any]) -> bool:
            if region and r.get("region") != region:
                return False
            if service and r.get("service") != service:
                return False
            if resource_type and r.get("resource_type") != resource_type:
                return False
            if cost_component and r.get("cost_component") != cost_component:
                return False
            if status and r.get("status") != status:
                return False
            cost = r.get("cost") or 0
            if min_cost is not None and cost < min_cost:
                return False
            if max_cost is not None and cost > max_cost:
                return False
            return True

        rows = [r for r in rows if _matches(r)]

        # Per-row INR equivalent, via a live FX rate for that row's own
        # currency. `total_cost`/`total_cost_inr` below both derive from this
        # instead of a raw `sum(r["cost"])`, which used to add USD and INR
        # rows together as if they were the same unit whenever a report
        # spanned providers that bill differently.
        _report_fx_rates = await fx_rate_service.get_rates_for(
            self.db, (r.get("currency") for r in rows)
        )
        for r in rows:
            rate = _report_fx_rates.get((r.get("currency") or "").upper())
            cost = r.get("cost")
            r["cost_inr"] = (
                round(float(cost) * rate, 4)
                if cost is not None and rate is not None else None
            )

        # "in_inventory" only exists on true per-resource rows, never on the
        # day/service fallback rows mixed into group_by="summary" for
        # providers without per-resource billing — `"in_inventory" in r`
        # excludes those instead of miscounting every one of them as unmatched.
        unmatched = sum(1 for r in rows if "in_inventory" in r and not r["in_inventory"])

        if group_by == "summary":
            dims = [d.strip() for d in (dimensions or "service").split(",") if d.strip()]
            valid_dims = {"provider", "account_name", "region", "service",
                          "resource_type", "cost_component", "status"}
            dims = [d for d in dims if d in valid_dims] or ["service"]

            groups: Dict[tuple, Dict[str, Any]] = {}
            group_resources: Dict[tuple, set] = {}
            for r in rows:
                key = tuple(r.get(d) for d in dims)
                g = groups.setdefault(key, {
                    **{d: r.get(d) for d in dims},
                    "resource_count": 0,
                    "compute_cost": 0.0, "database_cost": 0.0, "storage_cost": 0.0,
                    "network_cost": 0.0, "other_cost": 0.0, "total_cost": 0.0,
                    "total_cost_inr": 0.0, "_has_inr": False,
                })
                # Rows with no provider_resource_id are AWS's day/service
                # fallback (see accounts_without_resource_rows above) — AWS
                # has no resource identity at this granularity, so each row
                # counts as its own bucket and resource_count there means
                # "billing line items", not distinct resources.
                group_resources.setdefault(key, set()).add(r.get("provider_resource_id") or id(r))
                cost = float(r.get("cost") or 0)
                g["total_cost"] += cost
                if r.get("cost_inr") is not None:
                    g["total_cost_inr"] += r["cost_inr"]
                    g["_has_inr"] = True
                component_key = f"{r.get('cost_component', 'Other').lower()}_cost"
                if component_key in g:
                    g[component_key] += cost
                else:
                    g["other_cost"] += cost
            for key, g in groups.items():
                g["resource_count"] = len(group_resources[key])
                g["total_cost_inr"] = round(g["total_cost_inr"], 2) if g.pop("_has_inr") else None
                for k in ("compute_cost", "database_cost", "storage_cost", "network_cost",
                          "other_cost", "total_cost"):
                    g[k] = round(g[k], 2)

            summary_rows = sorted(groups.values(), key=lambda x: -x["total_cost"])
            # `total_cost` is honest the same way `currency` is: a report that
            # spans currencies has no single native total (see
            # `cost_money.total`), so it is None rather than a sum across
            # units. `total_cost_inr` exists regardless — see the per-row
            # conversion above — and is what the UI shows as the headline.
            _summary_total = cost_money.total((r.get("cost"), r.get("currency")) for r in rows)
            total_cost = _summary_total.single_amount
            total_cost_inr = (
                round(sum(g["total_cost_inr"] for g in summary_rows if g["total_cost_inr"] is not None), 2)
                if any(g["total_cost_inr"] is not None for g in summary_rows) else None
            )
            return {
                "account_id": str(account_id),
                "days": days,
                "group_by": "summary",
                "dimensions": dims,
                "currency": _single_currency(currencies) if rows else None,
                "total_cost": total_cost,
                "total_cost_inr": total_cost_inr,
                "fx_rates_used": _report_fx_rates or None,
                "fx_as_of": date.today().isoformat(),
                "row_count": len(summary_rows),
                "unmatched_resources": unmatched,
                "rows": summary_rows,
            }

        # Most expensive first for resource rows — that is the question this
        # view answers; day rows read best chronologically.
        if group_by == "resource":
            rows.sort(key=lambda x: -(x["cost"] or 0))
        else:
            rows.sort(key=lambda x: (x["date"] or "", -(x["cost"] or 0)))

        # Same honesty rule as the summary branch above: a raw sum across rows
        # is only a real number when every row bills in the same currency.
        _report_total = cost_money.total((r.get("cost"), r.get("currency")) for r in rows)
        total_cost = _report_total.single_amount
        total_cost_inr = (
            round(sum(r["cost_inr"] for r in rows if r["cost_inr"] is not None), 2)
            if any(r["cost_inr"] is not None for r in rows) else None
        )
        total_row_count = len(rows)

        paginated = rows
        if page is not None or page_size is not None:
            page = max(1, page or 1)
            page_size = max(1, min(page_size or 50, 500))
            start = (page - 1) * page_size
            paginated = rows[start:start + page_size]

        return {
            "account_id": str(account_id),
            "days": days,
            "group_by": group_by,
            "currency": _single_currency(currencies) if rows else None,
            "total_cost": total_cost,
            "total_cost_inr": total_cost_inr,
            "fx_rates_used": _report_fx_rates or None,
            "fx_as_of": date.today().isoformat(),
            # Total matching rows regardless of pagination — unchanged meaning
            # from before pagination existed, so existing callers that read
            # `row_count` (not `rows.length`) keep working.
            "row_count": total_row_count,
            "page": page,
            "page_size": page_size,
            # Billed IDs with no inventory match — usually deleted resources still
            # billed for part of the window, or sub-resources we don't scan.
            "unmatched_resources": unmatched,
            "rows": paginated,
        }
