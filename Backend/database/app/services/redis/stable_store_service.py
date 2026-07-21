"""
Stable-facts store — slowly-changing data, stored ONCE, rewritten only on change.
=================================================================================

Fast metrics (CPU, sessions, QPS) change every sample — they belong to the 15s
pipeline. STABLE facts (version, edition, database list, table count, config
limits …) barely ever change, so re-storing them every cycle is waste. This
service keeps exactly one copy per agent and detects drift:

  actmon:stable:<agent>   JSON of the agent's current stable facts + checksum

`sync()` compares the freshly-collected facts against the stored copy:
  • identical  → nothing written (the common case, every 15s)
  • different  → new copy stored, and the FIELD-LEVEL DIFF is returned so the
                 caller can log it to ClickHouse (version upgraded, DB added, …)

Never raises; Redis absent → no-op (returns None).
"""

import hashlib
import json
import logging

from app.services.redis import redis_store_service as redis_store

logger = logging.getLogger("stable_store")

STABLE_KEY = "actmon:stable:%s"          # % agent → {"facts": {...}, "sha": "..."}


def _canonical(facts):
    return json.dumps(facts, sort_keys=True, default=str)


def _diff(old, new):
    """Field-level changes: [{field, old, new}] — additions, removals, edits."""
    changes = []
    for k in sorted(set(old) | set(new)):
        ov, nv = old.get(k), new.get(k)
        if ov != nv:
            changes.append({"field": k,
                            "old": None if ov is None else str(ov)[:500],
                            "new": None if nv is None else str(nv)[:500]})
    return changes


def get(agent_name):
    """Current stable facts for an agent (or {})."""
    try:
        cli = redis_store.get_client()
        if cli is None:
            return {}
        raw = cli.get(STABLE_KEY % agent_name)
        return json.loads(raw)["facts"] if raw else {}
    except Exception:  # noqa: BLE001
        redis_store.mark_down()
        return {}


def sync(agent_name, facts):
    """Store facts only if they differ from what's already stored.
    Returns: None  → unchanged (nothing written — the normal case)
             list  → field-level diff that WAS a change (now stored); empty list
                     on first-ever store."""
    if not facts:
        return None
    try:
        cli = redis_store.get_client()
        if cli is None:
            return None
        canon = _canonical(facts)
        sha = hashlib.sha1(canon.encode("utf-8")).hexdigest()
        key = STABLE_KEY % agent_name
        raw = cli.get(key)
        if raw:
            stored = json.loads(raw)
            if stored.get("sha") == sha:
                return None                      # identical — store nothing
            changes = _diff(stored.get("facts") or {}, facts)
        else:
            changes = []                         # first store — no diff to log
        cli.set(key, json.dumps({"facts": facts, "sha": sha}, default=str))
        return changes
    except Exception as e:  # noqa: BLE001
        logger.debug("[stable_store] sync: %s", e)
        redis_store.mark_down()
        return None
