"""actmon_logs.writer.clickhouse_writer — batch-insert metric rows into ClickHouse."""
import warnings
from actmon_logs import core


def write_metrics(rows):
    """rows: list of dict {org_id, db_type, connection_id, host, metric, value}.
    `ts` is intentionally omitted so ClickHouse stamps it server-side (DEFAULT now64(3))
    — avoids any client/server timezone skew."""
    if not rows or not core.ensure_schema():
        return 0
    data = []
    for r in rows:
        try:
            v = float(r.get("value"))
        except (TypeError, ValueError):
            continue
        data.append([
            int(r.get("org_id") or 1), str(r.get("db_type") or ""),
            int(r.get("connection_id") or 0), str(r.get("host") or ""),
            str(r.get("metric") or ""), v,
        ])
    if not data:
        return 0
    cli = core.get_client()
    if cli is None:
        return 0
    try:
        cli.insert(
            core.TABLE, data,
            column_names=["org_id", "db_type", "connection_id", "host", "metric", "value"],
        )
        return len(data)
    except Exception as e:
        # No core.mark_down() — an insert failing on this one table is not
        # evidence the connection itself is down (see ensure_schema()'s note
        # in core.py for the full reasoning); it would otherwise poison the
        # same shared cooldown every other ClickHouse caller in the process
        # checks, including the unrelated metrics_history_service pipeline.
        warnings.warn(f"[actmon_logs] insert error: {e}")
        return 0
