"""ActMon Logs — ClickHouse-backed per-metric time-series store.

Layout:
  config/retention.json          → ClickHouse target, retention, sample interval
  core.py                        → client + schema
  writer/clickhouse_writer.py    → write_metrics()
  writer/retention.py            → apply_retention()
  reader/clickhouse_reader.py    → query_series(), catalog()
"""
from actmon_logs.core import ensure_schema, status, load_config, CONFIG, TABLE, is_disabled
from actmon_logs.writer.clickhouse_writer import write_metrics
from actmon_logs.writer.retention import apply_retention
from actmon_logs.reader.clickhouse_reader import query_series, catalog, snapshot, history, spikes

__all__ = [
    "ensure_schema", "status", "load_config", "CONFIG", "TABLE", "is_disabled",
    "write_metrics", "apply_retention", "query_series", "catalog", "snapshot", "history", "spikes",
]
