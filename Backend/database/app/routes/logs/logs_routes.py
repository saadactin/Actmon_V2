"""ActMon Logs API — /api/v1/logs/*  (ClickHouse-backed metric time-series)."""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database.connection import SessionLocal
from app.services.logs import actmon_logs_service as logs

router = APIRouter(prefix="/api/v1/logs", tags=["Logs"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/status", summary="Log store connectivity")
def log_status():
    return logs.status()


@router.get("/catalog", summary="Available db_types, metrics & sources")
def log_catalog():
    return logs.catalog()


@router.get("/metrics", summary="Fetch a metric time-series")
def log_metrics(
    db_type: str = Query(...),
    metric: str = Query(...),
    connection_id: int | None = Query(None),
    hours: int = Query(6, ge=1, le=720),
):
    return {"db_type": db_type, "metric": metric, "connection_id": connection_id,
            "hours": hours, "points": logs.query_series(db_type, metric, connection_id, hours)}


@router.get("/snapshot", summary="Latest value of every metric per source (live table)")
def log_snapshot(db_type: str | None = Query(None)):
    return {"rows": logs.snapshot(db_type)}


@router.get("/history", summary="Per-source metric history (readable table)")
def log_history(db_type: str = Query(...), connection_id: int = Query(...), hours: int = Query(1, ge=1, le=168)):
    return {"rows": logs.history(db_type, connection_id, hours)}


@router.get("/spikes", summary="Highest-value moments of a metric ('when did it spike')")
def log_spikes(db_type: str = Query(...), metric: str = Query(...),
               connection_id: int | None = Query(None), hours: int = Query(24, ge=1, le=720)):
    return {"spikes": logs.spikes(db_type, metric, connection_id, hours)}


@router.get("/sql", summary="Top / slow SQL captured across time")
def log_sql(connection_id: int | None = Query(None), hours: int = Query(24, ge=1, le=720),
            limit: int = Query(300, ge=1, le=2000), db: Session = Depends(get_db)):
    return {"rows": logs.sql_logs(db, connection_id, hours, limit)}


@router.get("/errors", summary="Error / alert event log")
def log_errors(connection_id: int | None = Query(None), hours: int = Query(72, ge=1, le=720),
               severity: str | None = Query(None), limit: int = Query(400, ge=1, le=2000),
               db: Session = Depends(get_db)):
    return {"rows": logs.error_logs(db, connection_id, hours, severity, limit)}


@router.post("/flush", summary="Force-sample all agents into the log store now")
def log_flush(db: Session = Depends(get_db)):
    return {"written": logs.log_now(db)}


@router.get("/telemetry-table", summary="ALL collected telemetry as one searchable table")
def telemetry_table(minutes: int = Query(60, ge=1, le=10080),
                    agent: str = Query(None), metric: str = Query(None),
                    tech: str = Query(None), search: str = Query(None),
                    limit: int = Query(500, ge=1, le=5000), offset: int = Query(0, ge=0)):
    """Unified tabular view over EVERY telemetry stream (not just CPU/memory):
    the per-metric series (metric_logs) UNION the 15s pipeline tables (metrics_*),
    normalised to rows of (ts, source, tech, agent, metric, value)."""
    from app.services.clickhouse import metrics_history_service as mh
    cli = mh.get_client()
    if cli is None:
        return {"available": False, "rows": [], "total": 0,
                "error": "ClickHouse unavailable"}
    where1, where2, params = ["ts > now() - INTERVAL %(m)s MINUTE"], ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes)}
    if agent:
        where1.append("host = %(a)s"); where2.append("agent = %(a)s"); params["a"] = agent
    if tech:
        where1.append("db_type = %(t)s"); where2.append("tech = %(t)s"); params["t"] = tech
    if metric:
        where1.append("metric = %(mt)s"); where2.append("metric = %(mt)s"); params["mt"] = metric
    if search:
        params["q"] = f"%{search.lower()}%"
        where1.append("(lower(metric) LIKE %(q)s OR lower(host) LIKE %(q)s OR lower(db_type) LIKE %(q)s)")
        where2.append("(lower(metric) LIKE %(q)s OR lower(agent) LIKE %(q)s OR lower(tech) LIKE %(q)s)")
    # metrics_* tables are wide — unpivot the numeric columns into (metric, value).
    unpivot = " UNION ALL ".join(
        f"SELECT toDateTime(ts) AS ts, 'pipeline' AS source, tech, agent, '{f}' AS metric, toFloat64({f}) AS value "
        f"FROM merge('actmon','^metrics_')" for f in mh.FIELDS)
    sql = f"""
        SELECT * FROM (
            SELECT toDateTime(ts) AS ts, 'metric_logs' AS source, db_type AS tech,
                   host AS agent, metric, toFloat64(value) AS value
            FROM actmon.metric_logs WHERE {' AND '.join(where1)}
            UNION ALL
            SELECT ts, source, tech, agent, metric, value FROM ({unpivot})
            WHERE {' AND '.join(where2)}
        ) ORDER BY ts DESC LIMIT %(lim)s OFFSET %(off)s
    """
    params["lim"], params["off"] = int(limit), int(offset)
    try:
        res = cli.query(sql, parameters=params)
        rows = [{"ts": str(r[0]), "source": r[1], "tech": r[2], "agent": r[3],
                 "metric": r[4], "value": r[5]} for r in res.result_rows]
        # distinct metric names for the filter dropdown (cheap, cached by CH)
        cat = cli.query(
            "SELECT DISTINCT metric FROM actmon.metric_logs "
            "WHERE ts > now() - INTERVAL 1 DAY ORDER BY metric LIMIT 200")
        metrics_list = [r[0] for r in cat.result_rows] + list(mh.FIELDS)
        # Row count over the SAME window/filters (not the whole unbounded history) —
        # a cheap headline stat for the Logs hub card, not a pagination total.
        total = len(rows)
        try:
            total_sql = f"""
                SELECT count() FROM (
                    SELECT toDateTime(ts) AS ts FROM actmon.metric_logs WHERE {' AND '.join(where1)}
                    UNION ALL
                    SELECT ts FROM ({unpivot}) WHERE {' AND '.join(where2)}
                )
            """
            total = int(cli.query(total_sql, parameters=params).result_rows[0][0])
        except Exception:  # noqa: BLE001 — headline count is best-effort, never blocks the table
            pass
        return {"available": True, "rows": rows, "count": len(rows), "total": total,
                "metrics": sorted(set(metrics_list)), "limit": limit, "offset": offset}
    except Exception as e:  # noqa: BLE001
        return {"available": False, "rows": [], "total": 0, "error": str(e)[:300]}


@router.get("/telemetry-export", summary="Download telemetry as CSV (per agent / database / filters)")
def telemetry_export(minutes: int = Query(1440, ge=1, le=43200),
                     agent: str = Query(None), conn: int = Query(None),
                     tech: str = Query(None), metric: str = Query(None),
                     limit: int = Query(50000, ge=1, le=200000)):
    """CSV download of the unified telemetry stream. `agent` narrows to one agent's
    logs; `conn` narrows to one database connection — both work with `tech`/`metric`
    and a time window. Used by the Logs UI download buttons."""
    from fastapi.responses import Response
    from app.services.clickhouse import metrics_history_service as mh
    cli = mh.get_client()
    if cli is None:
        return Response("ClickHouse unavailable", media_type="text/plain", status_code=503)
    where1, where2, params = ["ts > now() - INTERVAL %(m)s MINUTE"], ["ts > now() - INTERVAL %(m)s MINUTE"], {"m": int(minutes)}
    if agent:
        where1.append("host = %(a)s"); where2.append("agent = %(a)s"); params["a"] = agent
    if conn is not None:
        where1.append("connection_id = %(c)s"); where2.append("conn_id = %(c)s"); params["c"] = int(conn)
    if tech:
        where1.append("db_type = %(t)s"); where2.append("tech = %(t)s"); params["t"] = tech
    if metric:
        where1.append("metric = %(mt)s"); where2.append("metric = %(mt)s"); params["mt"] = metric
    unpivot = " UNION ALL ".join(
        f"SELECT toDateTime(ts) AS ts, 'pipeline' AS source, tech, agent, conn_id, '{f}' AS metric, toFloat64({f}) AS value "
        f"FROM merge('actmon','^metrics_')" for f in mh.FIELDS)
    sql = f"""
        SELECT * FROM (
            SELECT toDateTime(ts) AS ts, 'metric_logs' AS source, db_type AS tech,
                   host AS agent, connection_id AS conn_id, metric, toFloat64(value) AS value
            FROM actmon.metric_logs WHERE {' AND '.join(where1)}
            UNION ALL
            SELECT ts, source, tech, agent, conn_id, metric, value FROM ({unpivot})
            WHERE {' AND '.join(where2)}
        ) ORDER BY ts DESC LIMIT %(lim)s
    """
    params["lim"] = int(limit)
    try:
        res = cli.query(sql, parameters=params)
        lines = ["time,source,engine,agent,connection_id,metric,value"]
        for r in res.result_rows:
            val = str(r[6])
            agent_s = str(r[3]).replace('"', "'")
            lines.append(f'{r[0]},{r[1]},{r[2]},"{agent_s}",{r[4]},{r[5]},{val}')
        name_bits = [b for b in [agent, (f"conn{conn}" if conn is not None else None), tech, metric] if b]
        fname = "actmon-logs-" + ("-".join(name_bits) or "all") + ".csv"
        return Response("\n".join(lines), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})
    except Exception as e:  # noqa: BLE001
        return Response(f"export failed: {str(e)[:300]}", media_type="text/plain", status_code=500)
