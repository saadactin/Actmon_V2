"""
Live-tunable ClickHouse retention for Patroni cluster-history data.
Mirrors oracle_ch_retention_service.py exactly.

Read by metrics_history_service.py's _ensure_postgres_patroni_table() for the
actmon_postgres_patroni_members / actmon_postgres_patroni_transitions tables.
A settings-read failure must never break the metrics pipeline — falls back to
a 90-day default on any error.
"""
import threading
import time
from dataclasses import dataclass

from app.database.connection import SessionLocal

DEFAULTS = {"events_days": 90}
CACHE_TTL_SEC = 30

_cache = None
_cache_at = 0.0
_lock = threading.Lock()


@dataclass
class Retention:
    events_days: int


def _load_from_db() -> "Retention":
    from app.models.postgres_patroni_ch_retention_settings_model import PostgresPatroniChRetentionSettings
    db = SessionLocal()
    try:
        row = db.query(PostgresPatroniChRetentionSettings).first()
        if not row:
            return Retention(**DEFAULTS)
        return Retention(events_days=max(1, row.events_days or DEFAULTS["events_days"]))
    except Exception:  # noqa: BLE001 — never let a settings-read failure break the pipeline
        return Retention(**DEFAULTS)
    finally:
        db.close()


def get_retention() -> "Retention":
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and (now - _cache_at) < CACHE_TTL_SEC:
        return _cache
    with _lock:
        now = time.monotonic()
        if _cache is not None and (now - _cache_at) < CACHE_TTL_SEC:
            return _cache
        _cache = _load_from_db()
        _cache_at = now
        return _cache


def invalidate_cache():
    global _cache
    with _lock:
        _cache = None
