"""When ActMon may call a provider's API on its own.

AWS bills per call for the data this service reads most: Cost Explorer is
$0.01 a request, CloudWatch GetMetricData is charged per metric with no free
allowance. So for AWS the rule is: **the provider is read only during a refresh**
— "Refresh all", a tab's own Refresh button, Run Discovery, a cost backfill, or
the scheduled daily refresh. Everything else (opening a page, a page re-polling,
a background loop) shows what the last refresh saved and never calls AWS.

Azure and OCI do not charge for these reads (verified against their bills), so
they keep reading live on demand.

`refresh_activity()` marks the code running inside a refresh. It is a context
variable, so it follows the work into every task the refresh spawns
(`asyncio.create_task` and `gather` copy the current context) and never leaks
into an unrelated request running concurrently.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

#: Providers whose APIs are called only during a refresh.
REFRESH_ONLY_PROVIDERS = frozenset({"AWS"})

_in_refresh: ContextVar[bool] = ContextVar("actmon_in_refresh", default=False)


def refresh_only(provider: Optional[str]) -> bool:
    """True when this provider is read only during a refresh."""
    return (provider or "").upper() in REFRESH_ONLY_PROVIDERS


def in_refresh() -> bool:
    """True inside `refresh_activity()`."""
    return _in_refresh.get()


def may_call_provider(provider: Optional[str]) -> bool:
    """May the code running now call this provider's API?"""
    return not refresh_only(provider) or _in_refresh.get()


@contextmanager
def refresh_activity() -> Iterator[None]:
    """Run the enclosed work as part of a refresh, so it may call providers."""
    token = _in_refresh.set(True)
    try:
        yield
    finally:
        _in_refresh.reset(token)
