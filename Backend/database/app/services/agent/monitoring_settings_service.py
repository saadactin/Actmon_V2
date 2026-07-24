"""
Live-tunable monitoring thresholds — Super Admin configurable from the Settings
page instead of environment variables + a redeploy.

Read by agent_collector_service.py (error_streak, collector_interval_sec) and
agent_reaper_service.py (offline_after_sec). Cached briefly so the collector/reaper
don't hit the DB on every tick; a save from the Settings UI calls invalidate_cache()
so the change is picked up immediately rather than waiting out the TTL.

If the settings row/table is ever unreadable (DB hiccup, fresh install before the
table exists), callers get the same hardcoded defaults ActMon always shipped with —
a settings-read failure must never be able to break monitoring itself.
"""
import threading
import time
from dataclasses import dataclass

from app.database.connection import SessionLocal

DEFAULTS = {"error_streak": 3, "collector_interval_sec": 15, "offline_after_sec": 180}
CACHE_TTL_SEC = 20

_cache = None
_cache_at = 0.0
_lock = threading.Lock()


@dataclass
class Settings:
    error_streak: int
    collector_interval_sec: int
    offline_after_sec: int


def _load_from_db() -> "Settings":
    from app.models.monitoring_settings_model import MonitoringSettings
    db = SessionLocal()
    try:
        row = db.query(MonitoringSettings).first()
        if not row:
            return Settings(**DEFAULTS)
        return Settings(
            error_streak=max(1, row.error_streak or DEFAULTS["error_streak"]),
            collector_interval_sec=max(5, row.collector_interval_sec or DEFAULTS["collector_interval_sec"]),
            offline_after_sec=max(30, row.offline_after_sec or DEFAULTS["offline_after_sec"]),
        )
    except Exception:  # noqa: BLE001 — never let a settings-read failure break monitoring
        return Settings(**DEFAULTS)
    finally:
        db.close()


def get_settings() -> "Settings":
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
    """Call right after a settings save so the next read reflects it immediately."""
    global _cache
    with _lock:
        _cache = None
