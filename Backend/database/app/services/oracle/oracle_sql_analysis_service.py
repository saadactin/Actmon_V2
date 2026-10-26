"""Query Analysis results: runtime plan statistics and a statement's trend.

Both are reads only, and both are keyed by SQL_ID — the captured cursor. No
statement text from the browser is ever executed or explained here.

  * plan_stats  — V$SQL_PLAN_STATISTICS_ALL: actual rows, starts and time per
                  plan step. Base product, but Oracle fills it only when runtime
                  plan statistics were collected (STATISTICS_LEVEL=ALL or the
                  gather_plan_statistics hint); otherwise the response says so.
  * sql_trend   — the agent's stored Top-SQL snapshots in ClickHouse for this
                  SQL_ID over time (executions, average elapsed, CPU, buffer
                  gets). What is shown is what was captured.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404,
    _get_engine,
    _rows,
    _safe_int,
)


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def oracle_sql_plan_stats(conn_id: int, db: Session, sql_id: str, child: int | None = None):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    binds = {'sid': sql_id}
    child_clause = ''
    if child is not None:
        child_clause = ' AND child_number = :ch'
        binds['ch'] = int(child)
    try:
        rows = _rows(engine,
                     "SELECT child_number, id, last_starts, last_output_rows, last_elapsed_time, "
                     "last_cr_buffer_gets, last_disk_reads FROM v$sql_plan_statistics_all "
                     f"WHERE sql_id = :sid{child_clause} ORDER BY child_number, id FETCH FIRST 500 ROWS ONLY", binds)
    except Exception as e:  # noqa: BLE001
        return {'status': 'error', 'error': f'v$sql_plan_statistics_all: {e}', 'steps': []}
    # One child's figures: the lowest child number present (the plan the page
    # shows is read the same way).
    first = min((_safe_int(r.get('CHILD_NUMBER')) for r in rows), default=None)
    steps = []
    for r in rows:
        if _safe_int(r.get('CHILD_NUMBER')) != first:
            continue
        steps.append({
            'id': _safe_int(r.get('ID')),
            'starts': _num(r.get('LAST_STARTS')),
            'actual_rows': _num(r.get('LAST_OUTPUT_ROWS')),
            # Oracle reports elapsed in microseconds.
            'elapsed_ms': (_num(r.get('LAST_ELAPSED_TIME')) or 0) / 1000 if r.get('LAST_ELAPSED_TIME') is not None else None,
            'buffer_gets': _num(r.get('LAST_CR_BUFFER_GETS')),
            'disk_reads': _num(r.get('LAST_DISK_READS')),
        })
    collected = any(s['actual_rows'] is not None or s['elapsed_ms'] is not None for s in steps)
    return {
        'status': 'success',
        'sql_id': sql_id,
        'child_number': first,
        'collected': collected,
        'note': None if collected else (
            'Actual rows and time per step are not collected for this cursor. Oracle records them only with '
            'STATISTICS_LEVEL=ALL or the gather_plan_statistics hint.'),
        'steps': steps,
        'read_at': datetime.utcnow().isoformat() + 'Z',
    }


def oracle_sql_trend(conn_id: int, db: Session, sql_id: str, hours: int = 24):
    from app.services.clickhouse import metrics_history_service as mh
    from app.services.oracle.oracle_perf_service import _agent_for

    _get_conn_or_404(conn_id, db)
    hours = max(1, min(24 * 30, int(hours)))
    cli, agent = _agent_for(conn_id)
    if cli is None:
        return {'status': 'error', 'error': 'ClickHouse is not reachable', 'points': []}
    if not agent:
        return {'status': 'success', 'points': [], 'note': 'No stored telemetry for this connection yet.'}
    try:
        res = cli.query(
            f"SELECT toTimeZone(ts, 'UTC') AS t, max(executions), avg(avg_elapsed_ms), max(cpu_time_ms), max(buffer_gets) "
            f"FROM {mh.CH_DB}.top_sql WHERE agent = %(a)s AND sql_id = %(s)s AND ts > now() - INTERVAL %(h)s HOUR "
            "GROUP BY t ORDER BY t LIMIT 2000",
            parameters={'a': agent, 's': sql_id, 'h': hours}).result_rows
    except Exception as e:  # noqa: BLE001
        return {'status': 'error', 'error': f'top_sql: {e}', 'points': []}
    points = [{'t': str(r[0])[:16].replace(' ', 'T'), 'executions': r[1], 'avg_elapsed_ms': r[2],
               'cpu_ms': r[3], 'buffer_gets': r[4]} for r in res]
    return {
        'status': 'success',
        'sql_id': sql_id,
        'hours': hours,
        'points': points,
        'note': None if points else 'This statement was not among the stored Top-SQL snapshots in this range.',
        'read_at': datetime.utcnow().isoformat() + 'Z',
    }
