"""
Redis store service — the HOT tier of the metrics pipeline.
===========================================================

Holds only the fast-moving edge of the telemetry stream:

  actmon:metrics:latest:<agent>       newest sample (JSON) per agent
  actmon:metrics:ring:<agent>         newest-first capped ring (240 × 15s ≈ 1 hour)
  actmon:metrics:index:<kind>:<tech>  SET of agent names per category
                                      (kind: infra|database · tech: mysql|oracle|…)

`store_sample()` returns the DISPLACED previous-latest so the orchestrator
(metrics_pipeline) can flush it to ClickHouse — the "last-in-first" hand-off.

Degrades gracefully: Redis absent/unreachable → every call is a no-op/empty with a
cooldown before reconnecting. Nothing here ever raises to the caller.

Config (env):
  REDIS_URL           default redis://127.0.0.1:6379/0
  METRICS_RING_SIZE   default 240
"""

import json
import os
import time
import logging

logger = logging.getLogger("redis_store")

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
RING_SIZE = int(os.getenv("METRICS_RING_SIZE", "240") or 240)

LATEST_KEY = "actmon:metrics:latest:%s"        # % agent      → JSON of newest sample
RING_KEY = "actmon:metrics:ring:%s"            # % agent      → LPUSH'd JSON samples
INDEX_KEY = "actmon:metrics:index:%s:%s"       # % kind, tech → SET of agent names

_COOLDOWN = 15.0
_client = None            # cached client (redis-py pools internally; safe to reuse)
_next_retry = 0.0


def get_client():
    """Cached Redis client, or None (with cooldown) when Redis isn't available."""
    global _client, _next_retry
    if _client is not None:
        return _client
    if time.monotonic() < _next_retry:
        return None
    try:
        import redis
        cli = redis.Redis.from_url(REDIS_URL, socket_connect_timeout=1.5,
                                   socket_timeout=1.5, decode_responses=True)
        cli.ping()
        _client = cli
        # REDIS_URL can legitimately be redis://:password@host:port/db — never
        # log it verbatim.
        from app.services.common.credential_encryption_service import credential_encryption
        logger.info("[redis_store] hot tier connected (%s)", credential_encryption.redact(REDIS_URL))
        return _client
    except Exception as e:  # noqa: BLE001 — Redis absent → hot tier off, retry later
        _next_retry = time.monotonic() + _COOLDOWN
        logger.debug("[redis_store] unavailable (%s)", e)
        return None


def mark_down():
    global _client, _next_retry
    _client = None
    _next_retry = time.monotonic() + _COOLDOWN


def is_up():
    return get_client() is not None


def store_sample(agent_name, sample):
    """Store one sample dict: set as latest, push into the ring, index its category.
    Returns the displaced previous-latest as a dict (or None). Never raises."""
    try:
        cli = get_client()
        if cli is None:
            return None
        payload = json.dumps(sample)
        key = LATEST_KEY % agent_name
        prev = cli.getset(key, payload)
        pipe = cli.pipeline()
        pipe.expire(key, 3600)
        pipe.lpush(RING_KEY % agent_name, payload)
        pipe.ltrim(RING_KEY % agent_name, 0, RING_SIZE - 1)
        pipe.expire(RING_KEY % agent_name, 7200)
        pipe.sadd(INDEX_KEY % (sample.get("kind") or "infra", sample.get("tech") or "host"),
                  agent_name)
        pipe.execute()
        return json.loads(prev) if prev else None
    except Exception as e:  # noqa: BLE001
        logger.debug("[redis_store] store_sample: %s", e)
        mark_down()
        return None


def live(agent_name, limit=240):
    """Newest-first samples from the ring. [] when Redis is off."""
    try:
        cli = get_client()
        if cli is None:
            return []
        raw = cli.lrange(RING_KEY % agent_name, 0, max(1, min(int(limit), RING_SIZE)) - 1)
        return [json.loads(r) for r in raw]
    except Exception:  # noqa: BLE001
        mark_down()
        return []


PENDING_KEY = "actmon:metrics:pending_ch"      # displaced samples awaiting ClickHouse
PENDING_MAX = int(os.getenv("METRICS_PENDING_MAX", "100000") or 100000)


def queue_pending(agent_name, sample):
    """Queue a displaced sample for the ClickHouse flusher. Lossless hand-off: the
    sample stays in this Redis list until the flusher confirms the CH insert."""
    try:
        cli = get_client()
        if cli is None:
            return False
        pipe = cli.pipeline()
        pipe.rpush(PENDING_KEY, json.dumps({"agent": agent_name, "sample": sample}))
        pipe.ltrim(PENDING_KEY, -PENDING_MAX, -1)   # bound memory if CH is down for long
        pipe.execute()
        return True
    except Exception:  # noqa: BLE001
        mark_down()
        return False


def queue_pending_typed(item_type, agent_name, row):
    """Queue a TYPED transactional item (top_sql / wait_event) for the CH flusher."""
    try:
        cli = get_client()
        if cli is None:
            return False
        pipe = cli.pipeline()
        pipe.rpush(PENDING_KEY, json.dumps({"type": item_type, "agent": agent_name, "row": row},
                                           default=str))
        pipe.ltrim(PENDING_KEY, -PENDING_MAX, -1)
        pipe.execute()
        return True
    except Exception:  # noqa: BLE001
        mark_down()
        return False


def drain_pending(batch=200):
    """Pop up to `batch` queued samples (oldest first). Returns list of dicts.
    Items are REMOVED — the flusher must requeue_pending() on insert failure."""
    try:
        cli = get_client()
        if cli is None:
            return []
        out = []
        for _ in range(batch):
            raw = cli.lpop(PENDING_KEY)
            if raw is None:
                break
            try:
                out.append(json.loads(raw))
            except Exception:  # noqa: BLE001
                continue
        return out
    except Exception:  # noqa: BLE001
        mark_down()
        return []


def requeue_pending(items):
    """Put failed items back at the FRONT so ordering is preserved."""
    try:
        cli = get_client()
        if cli is None or not items:
            return
        pipe = cli.pipeline()
        for item in reversed(items):
            pipe.lpush(PENDING_KEY, json.dumps(item))
        pipe.execute()
    except Exception:  # noqa: BLE001
        mark_down()


def pending_depth():
    try:
        cli = get_client()
        return cli.llen(PENDING_KEY) if cli else 0
    except Exception:  # noqa: BLE001
        return 0


def browse(kind=None, tech=None):
    """Category view: {kind: {tech: [{agent, latest}, …]}} from the index sets."""
    try:
        cli = get_client()
        if cli is None:
            return {}
        kinds = [kind] if kind else ["infra", "database"]
        out = {}
        for k in kinds:
            pattern = INDEX_KEY % (k, tech or "*")
            for idx_key in cli.scan_iter(match=pattern, count=100):
                t = idx_key.rsplit(":", 1)[-1]
                agents = sorted(cli.smembers(idx_key))
                entries = []
                for a in agents:
                    raw = cli.get(LATEST_KEY % a)
                    entries.append({"agent": a, "latest": json.loads(raw) if raw else None})
                out.setdefault(k, {})[t] = entries
        return out
    except Exception:  # noqa: BLE001
        mark_down()
        return {}
