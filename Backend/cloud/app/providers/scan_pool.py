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

from concurrent.futures import ThreadPoolExecutor

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
)
_DENIAL_MARKERS = (
    "accessdenied", "not authorized", "unauthorizedoperation",
    "authorizationfailed", "notauthorizedornotfound", "forbidden",
)


def is_denial(exc: BaseException) -> bool:
    """A real answer: the credentials may not read this. Never retry it."""
    low = str(exc).lower()
    return any(m in low for m in _DENIAL_MARKERS)


def is_transient(exc: BaseException) -> bool:
    """A dropped/blocked connection, which says nothing about the account."""
    if is_denial(exc):
        return False
    low = str(exc).lower()
    return any(m in low for m in _TRANSIENT_MARKERS)
