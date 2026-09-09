"""
Static/low-frequency DB metadata cache.

Separate from agent_cache.py (which caches whole dashboard payloads, live
fields included, backed by the AgentSnapshot table, refreshed ~60s by a
background collector). This module is for per-tab data that is genuinely
static — version strings, config parameters, instance identity, tablespace/
table *names* (not usage %) — with no background refresh: a cache miss just
means the next call executes the existing live query and repopulates it.

Deliberately in-memory (plain dict + lock), mirroring the same pattern already
proven in agent_fs_service.py's _PERM_CACHE: no schema, no new shared
dependency, and the cache lives at the same pre-dispatch point either way
(before engine_for()/agent_fs_service.request() is ever called), so it fully
avoids the agent job queue on a hit regardless of what backs it. A backend
restart simply clears it — the next call is a live query, same as a miss.

Toggle and TTL are env vars so ops can flip STATIC_METADATA_CACHE_ENABLED=false
to fully disable this (every wrapped function falls back to today's always-live
behavior) with no code change.
"""
import os
import threading
import time

_CACHE: dict[tuple, tuple] = {}   # (connection_id, snapshot_type) -> (expires_at, payload)
_LOCK = threading.Lock()

_ENABLED = os.environ.get("STATIC_METADATA_CACHE_ENABLED", "true").strip().lower() != "false"
_TTL_SECONDS = int(os.environ.get("STATIC_METADATA_CACHE_TTL_SECONDS", "1800"))  # 30 min default


def get(connection_id: int, snapshot_type: str):
    """Returns the cached payload, or None on disabled/miss/expired (caller
    should fall back to its normal live query)."""
    if not _ENABLED:
        return None
    key = (connection_id, snapshot_type)
    now = time.time()
    with _LOCK:
        cached = _CACHE.get(key)
        if cached and cached[0] > now:
            return cached[1]
    return None


def store(connection_id: int, snapshot_type: str, payload):
    if not _ENABLED:
        return
    key = (connection_id, snapshot_type)
    with _LOCK:
        _CACHE[key] = (time.time() + _TTL_SECONDS, payload)


def invalidate(connection_id: int, snapshot_type: str | None = None):
    """Drop one entry, or every entry for a connection when snapshot_type is None."""
    with _LOCK:
        if snapshot_type is not None:
            _CACHE.pop((connection_id, snapshot_type), None)
        else:
            for key in [k for k in _CACHE if k[0] == connection_id]:
                _CACHE.pop(key, None)
