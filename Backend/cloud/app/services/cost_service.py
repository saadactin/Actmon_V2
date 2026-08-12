"""Cost service — real billed costs from provider billing APIs only.

Policy: every number returned by this module is either a real value obtained
from the provider's billing API (AWS Cost Explorer / Azure Cost Management /
OCI Usage API) or None, which the UI renders as NA. No synthetic trends, no
hardcoded price tables, no invented savings figures.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.pricing import oci_pricing
from app.repository.resource_repo import ResourceRepository

logger = logging.getLogger("cloud_svc.cost")


def _attach_oci_savings(opt: Dict[str, Any], resource, prices, currency: str) -> None:
    """Enrich one OCI optimization with a real monthly-savings estimate and the
    math behind it (from OCI's public list prices). Leaves potential_savings as
    None (NA) whenever we cannot price it honestly — never guesses."""
    opt.setdefault("savings_currency", None)
    opt.setdefault("savings_breakdown", [])
    opt.setdefault("savings_assumptions", [])
    opt.setdefault("savings_basis", None)

    if resource is None:
        return
    cfg = resource.config or {}
    rule = opt.get("rule")
    total: Optional[float] = None
    lines: List[Dict[str, Any]] = []
    assumptions: List[str] = []

    if rule == "Stopped OCI Compute Instance":
        gb = cfg.get("attached_storage_gb")
        total, lines = oci_pricing.block_volume_breakdown(gb, prices, label="Attached storage")
        if total is not None:
            boot = cfg.get("boot_volume_gb")
            blk = cfg.get("block_volume_gb")
            detail = []
            if boot is not None:
                detail.append(f"boot volume {boot} GB")
            if blk is not None:
                detail.append(f"block volumes {blk} GB")
            assumptions = [
                "Stopping the instance already ends OCPU and RAM billing; the remaining "
                "waste is its boot + block-volume storage, which keeps billing until the "
                "volumes are deleted (terminating the instance deletes the boot volume).",
                "Balanced performance tier (10 VPU/GB) assumed — OCI's default for boot "
                "and most block volumes.",
            ]
            if detail:
                assumptions.append("Provisioned storage measured from the OCI Block "
                                   "Storage API: " + ", ".join(detail) + ".")
        else:
            assumptions = [
                "Volume sizes were not captured for this instance (older scan), so the "
                "storage saving cannot be quantified yet — re-run discovery to populate it.",
            ]

    elif rule == "Stopped Autonomous Database":
        tbs = cfg.get("data_storage_size_tbs")
        total, lines = oci_pricing.adb_storage_breakdown(tbs, prices, label="Autonomous DB storage")
        if total is not None:
            assumptions = [
                "A stopped Autonomous Database stops CPU billing but keeps billing its "
                "provisioned storage until the database is terminated.",
                "Storage billed at 1 TB = 1024 GB.",
            ]

    elif rule == "Enable Autonomous Database Auto-Scaling":
        # Honesty: enabling auto-scaling does NOT yield a fixed monthly saving — it adds
        # burst capacity and can raise cost at peak. The saving only exists if the BASE
        # capacity is lowered, which needs usage data we don't collect. So: NA.
        assumptions = [
            "No fixed monthly saving. Auto-scaling matches capacity to demand and can "
            "increase cost during peaks — the cost win only comes from reducing the BASE "
            "ECPU/OCPU count if the database is over-provisioned, which requires usage "
            "metrics this tool does not yet collect.",
        ]

    opt["potential_savings"] = total
    opt["savings_breakdown"] = lines
    opt["savings_assumptions"] = assumptions
    if total is not None:
        opt["savings_currency"] = currency
        opt["savings_basis"] = (
            "OCI public Price List API — PAY_AS_YOU_GO list price. This is the public "
            "list rate, not your account's negotiated or committed-use discount, so the "
            "actual saving may be lower."
        )

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


def _cache_get(cache: dict, key) -> Any:
    cached = cache.get(key)
    if not cached:
        return None
    stored_at, rows, errored = cached
    ttl = _FAILURE_TTL_SECONDS if errored else _REAL_COST_TTL_SECONDS
    return rows if time.time() - stored_at < ttl else None


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
_ANALYTICS_DEADLINE_SECONDS = 12


def _is_transient(exc: Exception) -> bool:
    low = str(exc).lower()
    return any(m in low for m in _TRANSIENT_MARKERS)


async def _cached_fetch(cache: dict, key, label: str, fetch, empty, account_id=None):
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
    fresh = _cache_get(cache, key)
    if fresh is not None:
        return fresh

    exc: Exception | None = None
    for attempt in range(_TRANSIENT_ATTEMPTS):
        try:
            value = await fetch()
            cache[key] = (time.time(), value, False)
            if account_id is not None:
                _cost_error_reason.pop(str(account_id), None)
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
        if account_id is not None:
            category, message = _categorize_error(exc)
            _cost_error_reason[str(account_id)] = {"category": category, "message": message}
        stale = entry[1] if entry else None
        if stale:
            # Serve the previous real numbers rather than a misleading NA.
            cache[key] = (time.time(), stale, True)
            return stale
        cache[key] = (time.time(), empty, True)
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
            "Cannot decrypt credentials for account %s (%s) — was FERNET_KEY changed "
            "after this account was added? Re-add the account. Error: %s",
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


def _categorize_error(exc: Exception) -> Tuple[str, str]:
    if isinstance(exc, ProviderUnavailableError):
        return "credentials", str(exc)
    msg = str(exc)
    low = msg.lower()
    if any(k in msg for k in (
        "AuthorizationFailed", "AccessDenied", "Forbidden", "NotAuthorizedOrNotFound",
        "UnauthorizedOperation", "AuthorizationError",
    )) or " 403" in msg or msg.startswith("403"):
        return "permission", (
            "The account's credentials don't have permission to read billing data "
            f"from the provider's API. Raw error: {msg[:400]}"
        )
    if any(k in low for k in (
        "expired", "invalidclienttokenid", "signaturedoesnotmatch",
        "invalid_client", "invalid_grant", "unauthorized_client",
    )):
        return "credentials", f"The account's credentials appear to be invalid or expired. Raw error: {msg[:400]}"
    if any(k in low for k in (
        "timeout", "timed out", "connection", "network", "resolve host",
        "unreachable", "connectionerror", "max retries exceeded",
    )):
        return "network", f"A network error occurred while contacting the provider's billing API. Raw error: {msg[:400]}"
    return "unknown", f"An unexpected error occurred while fetching billing data. Raw error: {msg[:400]}"


def get_cost_diagnostic(account_id) -> Optional[Dict[str, str]]:
    """The last known reason this account's cost data isn't available, or None
    if the last attempt succeeded (or none has been made yet)."""
    return _cost_error_reason.get(str(account_id))


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
        account_id=account.id,
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
        account_id=account.id,
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
        account_id=account.id,
    )


async def fetch_real_costs_by_resource(account, days: int = 30) -> Dict[str, Dict[str, Any]]:
    """Real spend over `days` keyed by provider resource ID, when the provider
    supports resource-level cost grouping (OCI + Azure). Returns {} when
    unsupported or the query fails — callers show NA, never a guess."""
    days = max(1, min(days, MAX_REPORT_DAYS))

    async def _fetch():
        provider = _require_provider(account)
        if not hasattr(provider, "get_cost_by_resource"):
            return {}
        return await provider.get_cost_by_resource(days) or {}

    # Keyed by (account, days): the 30-day map that decorates the Resources page
    # must not be evicted by a 365-day report query.
    return await _cached_fetch(
        _real_cost_by_resource_cache, (str(account.id), days),
        "Per-resource billing query", _fetch, {}, account_id=account.id,
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


async def prewarm_cost_cache(account) -> None:
    """Fire this right after a discovery scan completes so the Cost page's
    first load hits a warm cache instead of a cold 30-50s provider billing
    call. Exceptions are swallowed — the caller doesn't await this to block
    on it, and a failed pre-warm just means the next real request pays the
    normal (now-short, 20s) failure-cache cost instead of the full one."""
    await asyncio.gather(
        fetch_real_costs(account),
        fetch_daily_costs(account),
        fetch_real_costs_by_resource(account),
        return_exceptions=True,
    )


def _single_currency(values: List[Optional[str]]) -> Optional[str]:
    """The one real currency present, or None when unknown/mixed (UI shows NA)."""
    currencies = {c for c in values if c}
    if len(currencies) == 1:
        return currencies.pop()
    return None


async def estimate_costs(account_id: uuid.UUID, db: AsyncSession) -> Dict[str, Any]:
    """Account cost summary from the provider billing API (real values or NA).

    Kept under its historical name because the /cost-estimate route and the
    dashboard consume it; it no longer fabricates config-based estimates.
    """
    from app.repository.cloud_account_repo import CloudAccountRepository

    account = await CloudAccountRepository(db).get_by_id(account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    rows = await fetch_real_costs(account)
    total = round(sum(float(r.get("monthly_cost") or 0) for r in rows), 2) if rows else None
    currency = _single_currency([r.get("currency") for r in rows]) if rows else None

    by_type: Dict[str, float] = {}
    breakdown: List[Dict[str, Any]] = []
    for r in sorted(rows, key=lambda x: -(x.get("monthly_cost") or 0)):
        svc = r.get("resource_name") or "Unknown"
        by_type[svc] = round(by_type.get(svc, 0) + float(r.get("monthly_cost") or 0), 4)
        breakdown.append({
            "resource_id": None,
            "resource_name": svc,
            "resource_type": r.get("resource_type") or svc,
            "region": r.get("region"),
            "monthly_cost": round(float(r.get("monthly_cost") or 0), 4),
            "currency": r.get("currency"),
        })

    return {
        "account_id": str(account_id),
        "total_monthly_cost": total,
        "currency": currency,
        "cost_source": "billing_api" if rows else None,
        "by_type": by_type,
        "breakdown": breakdown[:20],
        "note": (
            "Actual billed spend for the last 30 days from the provider billing API."
            if rows else
            "NA — the provider billing API returned no cost data for this account."
        ),
    }


class CostService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

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
        by_service: List[Dict[str, Any]] = []
        real_total = 0.0
        real_found = False
        currencies: List[Optional[str]] = []
        for acc, rows in zip(accounts, real_cost_rows):
            if rows:
                real_found = True
                real_total += sum(float(r.get("monthly_cost") or 0.0) for r in rows)
                for r in rows:
                    currencies.append(r.get("currency"))
                    by_service.append({
                        "account": acc.account_name,
                        "provider": acc.provider,
                        "service": r.get("resource_name", "Unknown"),
                        "region": r.get("region"),
                        "monthly_cost": round(float(r.get("monthly_cost") or 0.0), 2),
                        "currency": r.get("currency"),
                    })
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

        # ── Optimization recommendations from real scanned configuration ─────
        # potential_savings is None (NA) — no real pricing source is wired up,
        # so no dollar figure is ever invented.
        optimizations: List[Dict[str, Any]] = []

        for r in resources:
            config = r.config or {}
            rtype = r.resource_type
            rid = str(r.id)

            if rtype == "EC2Instance":
                if r.status == "stopped":
                    sub_resources = []
                    if isinstance(r.raw_data, dict):
                        for bd in r.raw_data.get("BlockDeviceMappings", []):
                            vid = bd.get("Ebs", {}).get("VolumeId")
                            if vid:
                                sub_resources.append({"name": f"EBS Volume {vid}", "cost": None})
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Terminate Stopped EC2 Instance",
                        "description": (
                            f"Instance '{r.resource_name}' is stopped (state from the EC2 API). "
                            "Stopped instances keep incurring EBS storage charges."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "LOW",
                        "recommendation": "If no longer needed, snapshot the volumes and terminate the instance.",
                        "sub_resources": sub_resources,
                    })

                instance_type = config.get("instance_type") or ""
                if instance_type.startswith(("t2.", "m4.", "c4.")):
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Upgrade Legacy EC2 Generation",
                        "description": (
                            f"Instance '{r.resource_name}' runs a previous-generation type "
                            f"({instance_type}). Current generations (t3/t4g, m5/m6, c5/c6) offer "
                            "better price/performance."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": f"Migrate {instance_type} to its current-generation equivalent.",
                        "sub_resources": [],
                    })

            if rtype == "S3Bucket":
                # Only when the S3 API explicitly reported versioning state
                versioning = config.get("versioning")
                if versioning in ("Disabled", "Suspended"):
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Enable S3 Bucket Versioning",
                        "description": (
                            f"Bucket '{r.resource_name}' has versioning '{versioning}' "
                            "(from get_bucket_versioning). Versioning protects against "
                            "accidental deletion and overwrites."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "LOW",
                        "recommendation": "Enable bucket versioning in the S3 console or via the API.",
                        "sub_resources": [],
                    })

                # Only when the S3 API explicitly confirmed there are zero rules
                if config.get("lifecycle_rules") == []:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Missing S3 Lifecycle Policies",
                        "description": (
                            f"Bucket '{r.resource_name}' has no lifecycle rules "
                            "(confirmed via get_bucket_lifecycle_configuration). Objects stay "
                            "in their original storage class indefinitely."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Add a lifecycle rule to transition or expire old objects.",
                        "sub_resources": [],
                    })

            if rtype == "DynamoDBTable" and config.get("billing_mode") == "PROVISIONED":
                item_count = config.get("item_count")
                if item_count is not None and item_count < 1000:
                    rcu = config.get("read_capacity")
                    wcu = config.get("write_capacity")
                    sub_resources = []
                    if rcu is not None:
                        sub_resources.append({"name": f"Provisioned RCU ({rcu})", "cost": None})
                    if wcu is not None:
                        sub_resources.append({"name": f"Provisioned WCU ({wcu})", "cost": None})
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Convert DynamoDB to On-Demand Billing",
                        "description": (
                            f"Table '{r.resource_name}' uses provisioned throughput but holds only "
                            f"{item_count} items (from DescribeTable). On-demand billing usually "
                            "costs less for low-traffic tables."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Switch the table's billing mode to PAY_PER_REQUEST.",
                        "sub_resources": sub_resources,
                    })

            if rtype == "LambdaFunction":
                memory_mb = config.get("memory_mb")
                runtime = config.get("runtime") or ""

                if memory_mb is not None and memory_mb > 1024:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Review Lambda Memory Size",
                        "description": (
                            f"Function '{r.resource_name}' is configured with {memory_mb} MB "
                            "(from the Lambda API). Oversized memory increases per-invocation cost."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "LOW",
                        "effort": "MEDIUM",
                        "recommendation": "Profile the function and right-size its memory allocation.",
                        "sub_resources": [],
                    })

                outdated_runtimes = ["nodejs10.x", "nodejs12.x", "nodejs14.x",
                                     "python3.6", "python3.7", "ruby2.5"]
                if runtime in outdated_runtimes:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Upgrade Deprecated Runtime",
                        "description": (
                            f"Function '{r.resource_name}' uses runtime '{runtime}' (from the "
                            "Lambda API), which no longer receives security patches."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "CRITICAL",
                        "effort": "HIGH",
                        "recommendation": "Upgrade to a supported runtime (e.g. nodejs20.x, python3.12).",
                        "sub_resources": [],
                    })

            if rtype == "RDSInstance":
                if r.status == "stopped":
                    storage_gb = config.get("storage_gb")
                    sub_resources = (
                        [{"name": f"Provisioned Storage ({storage_gb} GB)", "cost": None}]
                        if storage_gb is not None else []
                    )
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Review Stopped RDS Database",
                        "description": (
                            f"RDS instance '{r.resource_name}' is stopped (state from the RDS "
                            "API) but its provisioned storage continues to be billed."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "MEDIUM",
                        "recommendation": "Take a final snapshot and delete the instance if unused.",
                        "sub_resources": sub_resources,
                    })

                is_prod = any(
                    str(v).lower() in ("prod", "production")
                    for v in (r.tags or {}).values()
                )
                if config.get("multi_az") is True and not is_prod:
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Disable Multi-AZ on Non-Prod RDS",
                        "description": (
                            f"Database '{r.resource_name}' has Multi-AZ enabled (from the RDS "
                            "API) but carries no production tag. Multi-AZ roughly doubles "
                            "instance and storage charges."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Convert to Single-AZ if high availability is not required.",
                        "sub_resources": [],
                    })

            if rtype == "EKSCluster":
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Review EKS Control Plane Utilization",
                    "description": (
                        f"Cluster '{r.resource_name}' incurs AWS's flat hourly control-plane "
                        "charge regardless of workload. Verify the cluster is still needed."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "LOW",
                    "effort": "HIGH",
                    "recommendation": "Delete test clusters; use kind/minikube for local development.",
                    "sub_resources": [],
                })

            # ── OCI (Oracle Cloud) ────────────────────────────────────────────
            if rtype == "ComputeInstance" and (r.status or "").upper() == "STOPPED":
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Stopped OCI Compute Instance",
                    "description": (
                        f"Instance '{r.resource_name}' is STOPPED (lifecycle state from the "
                        "OCI Compute API). A stopped instance is not billed for OCPUs, but its "
                        "boot volume and any attached block volumes keep incurring storage charges."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "HIGH",
                    "effort": "LOW",
                    "recommendation": "If the instance is no longer needed, back up and terminate it (with its volumes) to stop the ongoing storage charges.",
                    "sub_resources": [],
                })

            if rtype == "AutonomousDatabase":
                if (r.status or "").upper() == "STOPPED":
                    storage_tb = config.get("data_storage_size_tbs")
                    sub = (
                        [{"name": f"Provisioned Storage ({storage_tb} TB)", "cost": None}]
                        if storage_tb is not None else []
                    )
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Stopped Autonomous Database",
                        "description": (
                            f"Autonomous Database '{r.resource_name}' is STOPPED (from the OCI "
                            "Database API). A stopped ADB is not billed for CPU, but its "
                            "provisioned storage continues to be billed."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "HIGH",
                        "effort": "LOW",
                        "recommendation": "If it is no longer needed, take a manual backup and terminate the database to stop storage charges.",
                        "sub_resources": sub,
                    })
                elif config.get("is_auto_scaling_enabled") is False:
                    # ECPU-model ADBs report cpu_core_count=0; the real capacity is
                    # compute_count. Use whichever matches the billing model so the
                    # message never shows a misleading "0".
                    is_ecpu = config.get("compute_model") == "ECPU"
                    cores = config.get("compute_count") if is_ecpu else config.get("cpu_core_count")
                    unit = "ECPU" if is_ecpu else "OCPU"
                    optimizations.append({
                        "id": str(uuid.uuid4()),
                        "rule": "Enable Autonomous Database Auto-Scaling",
                        "description": (
                            f"Autonomous Database '{r.resource_name}' has auto-scaling disabled"
                            + (f" (base {unit} count = {cores})" if cores is not None else "")
                            + " (from the OCI Database API). Without auto-scaling it always bills "
                            f"for its full base {unit}s even when idle."
                        ),
                        "potential_savings": None,
                        "affected_resource": r.resource_name,
                        "resource_id": rid,
                        "severity": "MEDIUM",
                        "effort": "LOW",
                        "recommendation": "Enable auto-scaling so the database matches OCPUs to demand instead of paying for peak capacity continuously.",
                        "sub_resources": [],
                    })

            if rtype == "OKECluster" and config.get("node_pool_count") == 0:
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Idle OKE Cluster (No Node Pools)",
                    "description": (
                        f"Kubernetes cluster '{r.resource_name}' has no node pools "
                        "(node_pool_count=0, from the OCI Container Engine API). An empty cluster "
                        "runs no workloads yet can still incur cluster management charges."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "MEDIUM",
                    "effort": "LOW",
                    "recommendation": "Confirm the cluster is still needed; if it was left over from testing, delete it.",
                    "sub_resources": [],
                })

            # OCI classic Load Balancer — disambiguate from AWS 'LoadBalancer' via lb_type
            if (rtype == "LoadBalancer"
                    and config.get("lb_type") == "LoadBalancer"
                    and config.get("backend_sets") == []):
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Idle OCI Load Balancer (No Backend Sets)",
                    "description": (
                        f"Load balancer '{r.resource_name}' has no backend sets configured "
                        "(from the OCI Load Balancer API). A load balancer with no backends serves "
                        "no traffic but is still billed per hour for its provisioned shape."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "MEDIUM",
                    "effort": "LOW",
                    "recommendation": "If this load balancer is unused, delete it to stop the hourly shape charge.",
                    "sub_resources": [],
                })

            # OCI API Gateway — disambiguate from AWS 'APIGateway' via endpoint_type
            if (rtype == "APIGateway"
                    and "endpoint_type" in config
                    and config.get("deployment_count") == 0):
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Idle OCI API Gateway (No Deployments)",
                    "description": (
                        f"API Gateway '{r.resource_name}' has no deployments (deployment_count=0, "
                        "from the OCI API Gateway service). A gateway with no deployments routes no "
                        "APIs but is still billed while it exists."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "MEDIUM",
                    "effort": "LOW",
                    "recommendation": "If this gateway is no longer used, delete it to stop its charges.",
                    "sub_resources": [],
                })

            # ── Azure ─────────────────────────────────────────────────────────
            if rtype == "AKSCluster" and config.get("node_count") == 0:
                optimizations.append({
                    "id": str(uuid.uuid4()),
                    "rule": "Idle AKS Cluster (No Nodes)",
                    "description": (
                        f"AKS cluster '{r.resource_name}' has 0 nodes across its node pools "
                        "(from the Azure Container Service API). An empty cluster runs no workloads "
                        "but can still incur control-plane / management charges."
                    ),
                    "potential_savings": None,
                    "affected_resource": r.resource_name,
                    "resource_id": rid,
                    "severity": "MEDIUM",
                    "effort": "LOW",
                    "recommendation": "Confirm the cluster is still needed; if it was left over from testing, delete it.",
                    "sub_resources": [],
                })

        # ── Attach real list-price savings to OCI recommendations ────────────
        # Fetch OCI public list prices once (cached ~24h) and price each rec from
        # the resource's real config. Only done when an OCI account is in view.
        has_oci = any((a.provider or "").upper() in ("ORACLE", "OCI") for a in accounts)
        if has_oci:
            price_currency = currency or "INR"
            prices = await oci_pricing.get_prices(price_currency)
            res_by_id = {str(r.id): r for r in resources}
            for o in optimizations:
                _attach_oci_savings(o, res_by_id.get(o.get("resource_id")), prices, price_currency)

        # Sum the real savings figures we were able to price (all same currency).
        known_savings = [
            o["potential_savings"] for o in optimizations
            if isinstance(o.get("potential_savings"), (int, float))
        ]
        potential_savings = round(sum(known_savings), 2) if known_savings else None

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

        return {
            "account_id": str(account_id),
            "trends": trends,
            "trend_currency": trend_currency,
            "optimizations": optimizations,
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
            "cost_diagnostics": cost_diagnostics,
            # True when a provider was still responding at the deadline: the
            # numbers shown are cached, and a refresh is finishing in the
            # background. Lets the UI say "still refreshing" instead of
            # presenting a stale/NA figure as final.
            "partial": partial,
        }

    async def get_cost_report(
        self, account_id: uuid.UUID | str, days: int, group_by: str = "service",
    ) -> Dict[str, Any]:
        """Real cost ledger for the requested lookback window (clamped to
        MAX_REPORT_DAYS), in one of two shapes:

        group_by="service"  — one row per day per service (the spend timeline).
        group_by="resource" — one row per billed RESOURCE, totalled over the
            window, enriched from our inventory with the resource's name, type,
            size and what it is attached to. Per-resource-PER-DAY is deliberately
            not offered: OCI alone returns ~11k rows for 7 days, so a year would
            be ~570k rows — unusable in a browser and pointless in a report.
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

        if group_by == "resource":
            res_repo = ResourceRepository(self.db)
            for acc in accounts:
                cost_map = await fetch_real_costs_by_resource(acc, days)
                if not cost_map:
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
                    currencies.append(entry.get("currency"))
                    rows.append({
                        "provider": acc.provider,
                        "account_id": str(acc.id),
                        "account_name": acc.account_name,
                        "service": entry.get("service"),
                        "region": entry.get("region")
                                  or (res.region_or_zone if in_inventory else None),
                        "resource_name": (res.resource_name if in_inventory else None) or id_name,
                        "resource_type": (res.resource_type if in_inventory else None) or id_type,
                        "status": res.status if in_inventory else None,
                        "provider_resource_id": pid,
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
            # Most expensive first — that is the question this view answers.
            rows.sort(key=lambda x: -(x["cost"] or 0))
        else:
            for acc in accounts:
                for r in await fetch_cost_report(acc, days):
                    currencies.append(r.get("currency"))
                    rows.append({
                        "date": r.get("date"),
                        "provider": acc.provider,
                        "account_id": str(acc.id),
                        "account_name": acc.account_name,
                        "service": r.get("service"),
                        "region": r.get("region"),
                        "cost": r.get("cost"),
                        "currency": r.get("currency"),
                    })
            rows.sort(key=lambda x: (x["date"] or "", -(x["cost"] or 0)))

        total_cost = round(sum(float(r["cost"] or 0) for r in rows), 2) if rows else None
        unmatched = sum(
            1 for r in rows if group_by == "resource" and not r.get("in_inventory")
        )

        return {
            "account_id": str(account_id),
            "days": days,
            "group_by": group_by,
            "currency": _single_currency(currencies) if rows else None,
            "total_cost": total_cost,
            "row_count": len(rows),
            # Billed IDs with no inventory match — usually deleted resources still
            # billed for part of the window, or sub-resources we don't scan.
            "unmatched_resources": unmatched,
            "rows": rows,
        }
