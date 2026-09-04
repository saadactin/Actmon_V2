"""Dedicated thread pools for blocking provider SDK calls.

All three provider SDKs (boto3, azure-mgmt-*, oci) are synchronous, so every
call is dispatched with loop.run_in_executor(). Passing None there uses
asyncio's DEFAULT executor, which is small — min(32, cpu_count + 4), so
typically 12-20 threads — and shared by every caller in the process.

That made a discovery scan starve everything else: an AWS sweep queues ~200
blocking calls (18 regions x 11 services), so a Cost page request landing
mid-scan waited behind the whole queue before its billing call even started.
It looked like "cost is slow" when cost was simply never getting a thread.

Two pools keep those workloads apart:

  SCAN_POOL  - wide, for inventory sweeps. Sized for latency-bound work (these
               threads mostly wait on network), not CPU.
  QUERY_POOL - small and reserved for interactive reads (cost, metrics), so a
               page load never queues behind a scan.

Bounded on purpose: unlimited concurrent TLS/DNS is what made OCI scans fail
with getaddrinfo errors and connection resets. Wide enough to parallelise,
narrow enough not to overwhelm the local network stack.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("cloud_svc.scan_pool")

_scan_pool: ThreadPoolExecutor | None = None
_query_pool: ThreadPoolExecutor | None = None

SCAN_POOL_SIZE = 24
QUERY_POOL_SIZE = 8


def scan_pool() -> ThreadPoolExecutor:
    """Pool for discovery/inventory sweeps."""
    global _scan_pool
    if _scan_pool is None:
        _scan_pool = ThreadPoolExecutor(
            max_workers=SCAN_POOL_SIZE, thread_name_prefix="cloud-scan"
        )
    return _scan_pool


def query_pool() -> ThreadPoolExecutor:
    """Pool for interactive reads (cost, metrics) that must not queue behind a scan."""
    global _query_pool
    if _query_pool is None:
        _query_pool = ThreadPoolExecutor(
            max_workers=QUERY_POOL_SIZE, thread_name_prefix="cloud-query"
        )
    return _query_pool


# ── Transient failure detection ───────────────────────────────────────────────
# On this network, TLS handshakes and established connections are dropped
# frequently — Windows 10053/10054 ("aborted by the software in your host
# machine" / "forcibly closed by the remote host") and SSL UNEXPECTED_EOF.
#
# The SDKs' own retries are not enough: a DynamoDB ListTables that needed a few
# attempts to get through was returning empty from the scanner, so 21 real
# tables never appeared in inventory while the account genuinely had them.
# A dropped connection is not an answer about the account, so retry it — but
# never retry a denial, which IS an answer and would only waste time.
_TRANSIENT_MARKERS = (
    "unexpected_eof", "ssl", "connection aborted", "connection reset",
    "forcibly closed", "10053", "10054", "connectionreseterror",
    "connectionabortederror", "connectionclosederror", "timed out", "timeout",
    "readtimeout", "max retries exceeded", "endpointconnectionerror",
    "remotedisconnected", "incompleteread",
    # botocore's ConnectionClosedError wording. Added after a real AWS scan
    # failed on it and was reported as lost access: the class-name markers above
    # never matched, because only str(exc) was being searched and botocore's
    # message does not name its own class. Matching the type name too (see
    # _describe) is the general fix; this covers the message itself.
    "connection was closed",
)
_DENIAL_MARKERS = (
    "accessdenied", "not authorized", "unauthorizedoperation",
    "authorizationfailed", "notauthorizedornotfound", "forbidden",
)


def _describe(exc: BaseException) -> str:
    """Exception class name plus message, lowercased, for marker matching.

    The class name matters: several markers above (connectionclosederror,
    endpointconnectionerror, readtimeout, remotedisconnected) name SDK exception
    *types*, and an SDK message rarely repeats its own class name. Matching only
    str(exc) left those markers dead, which is how a botocore
    ConnectionClosedError — "Connection was closed before we received a valid
    response from endpoint URL" — was classified as a permanent failure and
    aborted a scan on a working account.
    """
    return f"{type(exc).__name__} {exc}".lower()


def is_denial(exc: BaseException) -> bool:
    """A real answer: the credentials may not read this. Never retry it."""
    return any(m in _describe(exc) for m in _DENIAL_MARKERS)


def is_transient(exc: BaseException) -> bool:
    """A dropped/blocked connection, which says nothing about the account."""
    if is_denial(exc):
        return False
    return any(m in _describe(exc) for m in _TRANSIENT_MARKERS)


class ProviderUnreachable(Exception):
    """The provider could not be reached. The credentials were never judged.

    Distinct from a credential rejection on purpose: the two need opposite
    responses from whoever reads the failure, and conflating them sends people
    to rotate keys that were working fine.
    """


# Auth preflight retries. Matches AWSScanner._TRANSIENT_ATTEMPTS, because the
# preflight sits on the same network as the scan it gates and there is no reason
# for it to give up sooner than the calls behind it.
PREFLIGHT_ATTEMPTS = 4


async def preflight(check, *, provider: str, endpoint: str = "") -> bool:
    """Run a credential check on the scan pool, retrying dropped connections.

    Every call inside a sweep already retries transient failures, but the auth
    preflight did not — so one dropped TLS handshake aborted the entire scan
    before it read anything, and surfaced as "authentication failed", which the
    UI renders as "often lost access". A live AWS account was reported as having
    lost access because a single STS handshake was cut:

        Connection was closed before we received a valid response from
        endpoint URL: "https://sts.ap-south-1.amazonaws.com/"

    Nothing about those credentials was wrong. This makes the preflight as
    resilient as the scan behind it, and keeps "unreachable" and "rejected" as
    separate outcomes.

    `check` is a blocking callable; it runs on the scan pool rather than the
    event loop, so a slow handshake cannot stall every other request in the
    process.
    """
    import asyncio

    loop = asyncio.get_event_loop()
    last: BaseException | None = None
    for attempt in range(PREFLIGHT_ATTEMPTS):
        try:
            return await loop.run_in_executor(scan_pool(), check)
        except Exception as exc:
            last = exc
            # A denial IS an answer about the credentials — retrying it only
            # delays telling the user something true.
            if is_denial(exc) or not is_transient(exc):
                logger.error("%s auth failed: %s", provider, exc)
                raise ValueError(f"{provider} authentication failed: {exc}") from exc
            if attempt == PREFLIGHT_ATTEMPTS - 1:
                break
            backoff = 2 * (attempt + 1)
            logger.info(
                "%s auth preflight hit a dropped connection (attempt %d/%d) — "
                "retrying in %ss.", provider, attempt + 1, PREFLIGHT_ATTEMPTS, backoff,
            )
            await asyncio.sleep(backoff)

    where = f" to {endpoint}" if endpoint else ""
    logger.error(
        "%s unreachable after %d attempts%s: %s",
        provider, PREFLIGHT_ATTEMPTS, where, last,
    )
    raise ProviderUnreachable(
        f"{provider} could not be reached{where} after {PREFLIGHT_ATTEMPTS} attempts. "
        f"The connection was dropped before any reply arrived, so the credentials "
        f"were never checked — this is a network/TLS failure, not lost access. "
        f"Last error: {last}"
    ) from last
