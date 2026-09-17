"""
Bridges postgres_perf_collector.py's already-sampled raw counters into the
historical ClickHouse table (metrics_history_service.py's
postgres_perf_samples table) — mirrors postgres_patroni_history_flush_service.py.

No new Postgres queries here: takes the SAME row _sample_one() already built
for the PG-side postgres_perf_samples insert (7-day in-flight buffer) and
copies it into ClickHouse (long-horizon store) too. A ClickHouse write
failure must never break the collector's own PG insert/tick — best-effort,
logged at debug only, same discipline as every other *_history_flush_service
in this codebase.
"""
import logging

logger = logging.getLogger("postgres_perf_history_flush")


def flush_perf_sample(agent_name: str, conn_id: int, row: dict):
    try:
        from app.services.clickhouse import metrics_history_service as ch
        ch.flush_postgres_perf([{**row, "agent": agent_name, "conn_id": conn_id}])
    except Exception as e:  # noqa: BLE001 — historical flush must never break live collection
        print(f"[postgres_perf_history_flush] conn={conn_id}: {e!r}")
        logger.debug("[postgres_perf_history_flush] conn=%s: %s", conn_id, e)
