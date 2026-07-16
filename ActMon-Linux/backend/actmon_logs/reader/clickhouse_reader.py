"""actmon_logs.reader.clickhouse_reader — read metric time-series back out of ClickHouse."""
import warnings
from actmon_logs import core


def query_series(db_type, metric, connection_id=None, hours=6, limit=6000):
    if not core.ensure_schema():
        return []
    sql = (f"SELECT toString(ts), value FROM {core.TABLE} "
           f"WHERE ts >= now() - INTERVAL {int(hours)} HOUR "
           f"AND db_type = {{dt:String}} AND metric = {{m:String}}")
    if connection_id:
        sql += f" AND connection_id = {int(connection_id)}"
    sql += f" ORDER BY ts LIMIT {int(limit)}"
    try:
        res = core.get_client().query(sql, parameters={"dt": (db_type or "").lower(), "m": metric})
        return [{"ts": r[0], "value": r[1]} for r in res.result_rows]
    except Exception as e:
        warnings.warn(f"[actmon_logs] query error: {e}")
        core.mark_down()
        return []


def snapshot(db_type=None):
    """Latest value of every metric for every source → one row per (source, metric)."""
    if not core.ensure_schema():
        return []
    where = "WHERE db_type = {dt:String}" if db_type else ""
    sql = (f"SELECT connection_id, any(host) AS host, db_type, metric, "
           f"argMax(value, ts) AS val, max(ts) AS last_ts "
           f"FROM {core.TABLE} {where} GROUP BY connection_id, db_type, metric "
           f"ORDER BY db_type, connection_id")
    try:
        res = core.get_client().query(sql, parameters=({"dt": db_type.lower()} if db_type else {}))
        return [{"connection_id": r[0], "host": r[1], "db_type": r[2], "metric": r[3], "value": r[4], "ts": str(r[5])}
                for r in res.result_rows]
    except Exception as e:
        warnings.warn(f"[actmon_logs] snapshot error: {e}")
        core.mark_down()
        return []


def history(db_type, connection_id, hours=1, limit=500):
    """Per-source metric history, bucketed to the second (all metrics per sample share a second)."""
    if not core.ensure_schema():
        return []
    sql = (f"SELECT toString(toStartOfSecond(ts)) AS sec, metric, argMax(value, ts) AS val "
           f"FROM {core.TABLE} WHERE db_type = {{dt:String}} AND connection_id = {int(connection_id)} "
           f"AND ts >= now() - INTERVAL {int(hours)} HOUR "
           f"GROUP BY sec, metric ORDER BY sec DESC LIMIT {int(limit)}")
    try:
        res = core.get_client().query(sql, parameters={"dt": (db_type or "").lower()})
        return [{"ts": r[0], "metric": r[1], "value": r[2]} for r in res.result_rows]
    except Exception as e:
        warnings.warn(f"[actmon_logs] history error: {e}")
        core.mark_down()
        return []


def spikes(db_type, metric, connection_id=None, hours=24, top=20):
    """Highest-value moments for a metric — 'when did it spike'."""
    if not core.ensure_schema():
        return []
    sql = (f"SELECT toString(ts) AS t, value, connection_id, any(host) OVER () AS h "
           f"FROM {core.TABLE} WHERE db_type = {{dt:String}} AND metric = {{m:String}} "
           f"AND ts >= now() - INTERVAL {int(hours)} HOUR")
    if connection_id:
        sql += f" AND connection_id = {int(connection_id)}"
    sql += f" ORDER BY value DESC LIMIT {int(top)}"
    try:
        res = core.get_client().query(sql, parameters={"dt": (db_type or "").lower(), "m": metric})
        return [{"ts": r[0], "value": r[1], "connection_id": r[2]} for r in res.result_rows]
    except Exception as e:
        warnings.warn(f"[actmon_logs] spikes error: {e}")
        core.mark_down()
        return []


def catalog():
    if not core.ensure_schema():
        return {"enabled": False, "db_types": [], "metrics": [], "sources": []}
    try:
        cl, T = core.get_client(), core.TABLE
        dts = [r[0] for r in cl.query(f"SELECT DISTINCT db_type FROM {T} ORDER BY db_type").result_rows]
        mts = [r[0] for r in cl.query(f"SELECT DISTINCT metric FROM {T} ORDER BY metric").result_rows]
        src = [{"connection_id": r[0], "host": r[1], "db_type": r[2]}
               for r in cl.query(f"SELECT DISTINCT connection_id, host, db_type FROM {T} ORDER BY db_type, host").result_rows]
        return {"enabled": True, "db_types": dts, "metrics": mts, "sources": src}
    except Exception as e:
        warnings.warn(f"[actmon_logs] catalog error: {e}")
        return {"enabled": False, "db_types": [], "metrics": [], "sources": []}
