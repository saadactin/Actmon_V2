"""
Live-tunable ClickHouse retention for MySQL historical data — Super Admin
configurable from the Settings page instead of a hardcoded env var. Mirrors
monitoring_settings_service.py's cached-reader pattern.

Read by metrics_history_service.py's ensure_table()/_ensure_extra() for the
actmon_mysql_slow_queries / actmon_mysql_error_logs / actmon_mysql_binlog_history /
actmon_mysql_replication_history tables. A settings-read failure must never break
the metrics pipeline — falls back to METRICS_CH_TTL_DAYS (default 90) on any error.
"""
import threading
import time
from dataclasses import dataclass

from app.database.connection import SessionLocal

DEFAULTS = {"metrics_days": 90, "events_days": 90}
CACHE_TTL_SEC = 30

_cache = None
_cache_at = 0.0
_lock = threading.Lock()


@dataclass
class Retention:
    metrics_days: int
    events_days: int


def _load_from_db() -> "Retention":
    from app.models.mysql_ch_retention_settings_model import MysqlChRetentionSettings
    db = SessionLocal()
    try:
        row = db.query(MysqlChRetentionSettings).first()
        if not row:
            return Retention(**DEFAULTS)
        return Retention(
            metrics_days=max(1, row.metrics_days or DEFAULTS["metrics_days"]),
            events_days=max(1, row.events_days or DEFAULTS["events_days"]),
        )
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
