"""actmon_logs.core — ClickHouse client, config and schema for the metric log store."""
import os
import json
import time
import threading
import warnings

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(_HERE, "config", "retention.json")


def load_config():
    cfg = {}
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            txt = f.read().strip()
            if txt:
                cfg = json.loads(txt)
    except Exception:
        cfg = {}
    ch = cfg.get("clickhouse", {}) or {}
    return {
        "host":     os.getenv("ACTMON_LOGS_CH_HOST", ch.get("host", "localhost")),
        "port":     int(os.getenv("ACTMON_LOGS_CH_PORT", ch.get("port", 8123))),
        "username": os.getenv("ACTMON_LOGS_CH_USER", ch.get("username", "default")),
        "password": os.getenv("ACTMON_LOGS_CH_PASSWORD", ch.get("password", "")),
        "database": os.getenv("ACTMON_LOGS_CH_DB", ch.get("database", "actmon")),
        "table":    cfg.get("table", "metric_logs"),
        "retention_days":     int(os.getenv("ACTMON_LOGS_RETENTION_DAYS", cfg.get("retention_days", 30))),
        "sample_interval_sec": int(os.getenv("ACTMON_LOGS_INTERVAL_SEC", cfg.get("sample_interval_sec", 10))),
        "metrics":  cfg.get("metrics", ["cpu", "host_cpu", "memory", "connections", "sessions", "cache_hit", "qps", "tps"]),
    }


CONFIG = load_config()
CH_DB = CONFIG["database"]
TABLE = f'{CH_DB}.{CONFIG["table"]}'

_schema_ready = False
_next_retry = 0.0            # cooldown: don't retry connecting before this monotonic time
_RETRY_COOLDOWN = 10.0

# Master switch. Set ACTMON_LOGS_ENABLED=false (env) to turn ClickHouse logging OFF
# completely — no client is ever created, so no connection attempts, no retry spam,
# and no file-descriptor leak when ClickHouse isn't running. Use on hosts without a
# healthy ClickHouse. Default: enabled (backward compatible).
_LOGS_ENABLED = os.getenv("ACTMON_LOGS_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")


def logs_enabled():
    return _LOGS_ENABLED


def mark_down():
    """ClickHouse call failed — back off briefly; the next call reconnects fresh."""
    global _schema_ready, _next_retry
    _schema_ready = False
    _next_retry = time.monotonic() + _RETRY_COOLDOWN


def get_client():
    """A FRESH client per call — avoids stale pooled HTTP connections (WSL2 port
    forwarding drops idle sockets, which makes a cached client time out even when
    ClickHouse is healthy). Cheap enough at our call volume."""
    if not _LOGS_ENABLED:                    # ClickHouse logging turned off entirely
        return None
    if time.monotonic() < _next_retry:      # still in back-off window
        return None
    try:
        import clickhouse_connect
        return clickhouse_connect.get_client(
            host=CONFIG["host"], port=CONFIG["port"],
            username=CONFIG["username"], password=CONFIG["password"],
            connect_timeout=2, send_receive_timeout=6, query_retries=1,
        )
    except Exception as e:
        warnings.warn(f"[actmon_logs] ClickHouse unavailable ({e}); retrying in {int(_RETRY_COOLDOWN)}s.")
        mark_down()
        return None


def ensure_schema():
    global _schema_ready
    if _schema_ready:
        return True
    cl = get_client()
    if not cl:
        return False
    try:
        cl.command(f"CREATE DATABASE IF NOT EXISTS {CH_DB}")
        cl.command(f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                ts            DateTime64(3) DEFAULT now64(3),
                org_id        UInt32,
                db_type       LowCardinality(String),
                connection_id UInt32,
                host          String,
                metric        LowCardinality(String),
                value         Float64
            ) ENGINE = MergeTree
            PARTITION BY toYYYYMMDD(ts)
            ORDER BY (db_type, connection_id, metric, ts)
            TTL toDateTime(ts) + INTERVAL {CONFIG['retention_days']} DAY
        """)
        _schema_ready = True
        return True
    except Exception as e:
        warnings.warn(f"[actmon_logs] schema error: {e}")
        mark_down()
        return False


def is_disabled():
    return get_client() is None


def status():
    cl = get_client()
    return {
        "enabled": cl is not None,
        "host": CONFIG["host"], "port": CONFIG["port"],
        "database": CH_DB, "table": TABLE,
        "retention_days": CONFIG["retention_days"],
        "sample_interval_sec": CONFIG["sample_interval_sec"],
    }
