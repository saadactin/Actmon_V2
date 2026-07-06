"""actmon_logs.writer.retention — keep the table TTL in sync with config retention_days."""
import warnings
from actmon_logs import core


def apply_retention():
    if not core.ensure_schema():
        return False
    try:
        core.get_client().command(
            f"ALTER TABLE {core.TABLE} MODIFY TTL toDateTime(ts) + INTERVAL {core.CONFIG['retention_days']} DAY"
        )
        return True
    except Exception as e:
        warnings.warn(f"[actmon_logs] retention error: {e}")
        return False
