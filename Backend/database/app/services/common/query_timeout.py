"""
Shared request-level timeout guard for any service that talks to a live,
possibly slow/unreachable target database.

A connection layer typically only bounds individual queries (connect/read/
write timeouts, or a per-query agent timeout) — a handful of sequential
queries in one endpoint can still add up to several minutes before the last
one finally times out, which reads to a user as "stuck forever" even though
every individual step was technically bounded. Wrapping the WHOLE call in
run_with_timeout() caps the whole request regardless of how many queries are
inside it.

Same pattern originally built for Oracle (oracle_monitoring_service.py's own
_run_with_timeout, left as-is rather than migrated to avoid touching already
-verified code) — factored out here so MySQL (and any future engine) doesn't
need its own copy.
"""
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeoutError

logger = logging.getLogger("query_timeout")

DEFAULT_TIMEOUT_SECONDS = 30


def timeout_error(message=None, timeout=DEFAULT_TIMEOUT_SECONDS):
    return {
        "status": "error",
        "error": message or (
            f"Timed out after {timeout}s waiting for the database — "
            "the connection or its agent isn't answering right now."
        ),
    }


def run_with_timeout(fn, *args, timeout=DEFAULT_TIMEOUT_SECONDS, default=None, label=None, **kwargs):
    """Run `fn` on a worker thread and give up waiting after `timeout` seconds,
    returning `default` instead of hanging forever. Stamps the result with
    `execution_time_ms` and logs it under `label`, so a slow panel shows up by
    name in the logs instead of as a silent hang.

    Deliberately NOT a `with ThreadPoolExecutor(...)` block — exiting that
    context calls shutdown(wait=True), which blocks until the timed-out
    thread finishes too, silently undoing the timeout. The pool is left to be
    garbage-collected instead; an orphaned thread finishes on its own
    whenever the database/agent eventually responds, without holding this
    request open.

    Also catches any OTHER exception `fn` raises (not just a timeout) and
    degrades to an error result instead of letting it 500 the request."""
    label = label or getattr(fn, "__name__", "query")
    t0 = time.perf_counter()
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(fn, *args, **kwargs)
    try:
        result = future.result(timeout=timeout)
    except FuturesTimeoutError:
        pool.shutdown(wait=False)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        logger.info("[query_timeout] %s: TIMEOUT after %sms (limit %ss)", label, elapsed_ms, timeout)
        return default
    except Exception as exc:  # noqa: BLE001 — one panel's bug must not 500 the page
        pool.shutdown(wait=False)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        logger.info("[query_timeout] %s: ERROR after %sms: %s", label, elapsed_ms, exc)
        return {"status": "error", "error": str(exc), "execution_time_ms": elapsed_ms}
    pool.shutdown(wait=False)
    elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
    logger.info("[query_timeout] %s: OK in %sms", label, elapsed_ms)
    if isinstance(result, dict) and "status" in result:
        result = {**result, "execution_time_ms": elapsed_ms}
    return result
