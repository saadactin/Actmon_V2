"""Oracle Performance tab: metric history and "top 5" at a moment.

History is ACTMON's own telemetry first: the metrics pipeline writes every
Oracle connection's samples to ClickHouse (actmon.metrics_db_oracle, 15 s,
kept METRICS_CH_TTL_DAYS) — host/DB CPU, active sessions, connections, cache
hit, QPS/TPS. Metrics the pipeline does not store (PGA, logical/physical
reads, I/O requests, redo, wait ratio) are merged in from GV$SYSMETRIC_HISTORY
for the last hour only (Oracle's own one-minute history, base product), when
the database answers.

Top SQL / top wait events at a past minute come from the agent's stored
snapshots in ClickHouse (actmon.top_sql, actmon.wait_events). Sessions at a
past minute are not stored anywhere ACTMON can read without ASH.

"Top now" comes from GV$SESSMETRIC / GV$SESSION, also base product. What was
running at an EARLIER minute needs Active Session History, which is licensed
with the Diagnostics Pack; this module never queries ASH, and the UI says
that rather than showing current sessions under a past timestamp.

Reads only; every caller value reaches Oracle as a bind.
"""
from __future__ import annotations

import time
from datetime import datetime

from sqlalchemy.orm import Session

from app.services.oracle.oracle_monitoring_service import (
    _get_conn_or_404,
    _get_engine,
    _rows,
    _safe_int,
    _safe_str,
)

ORACLE_HISTORY_MINUTES = 60
MAX_MINUTES = 7 * 24 * 60


def bucket_for(minutes):
    """Bucket width (s) for a range, so a week is ~170 points, an hour 60."""
    if minutes <= 60:
        return 60
    if minutes <= 360:
        return 300
    if minutes <= 1440:
        return 900
    return 3600


def _utc_key(v):
    """ClickHouse ts ('YYYY-MM-DD HH:MM:SS', UTC) -> 'YYYY-MM-DDTHH:MM'."""
    s = str(v or '')
    return s[:16].replace(' ', 'T')


def stored_points(rows):
    """history_bucketed rows (newest first) -> points, oldest first. Pure."""
    out = []
    for r in reversed(rows or []):
        out.append({
            't': _utc_key(r.get('ts')),
            'cpu_pct': _num(r.get('host_cpu')),
            'db_cpu': _num(r.get('db_cpu')),
            'active_sessions': _num(r.get('active_sessions')),
            'connections': _num(r.get('connections_used')),
            'cache_hit_pct': _num(r.get('cache_hit_pct')),
            'qps': _num(r.get('qps')),
            'tps': _num(r.get('tps')),
        })
    return out


def _to_utc_key(local_key, tz):
    """'YYYY-MM-DDTHH:MM' in the database's local time at offset tz ('+05:30')
    -> the same instant as a UTC minute key."""
    from datetime import timedelta
    try:
        dt = datetime.strptime(local_key[:16], '%Y-%m-%dT%H:%M')
        sign = -1 if tz.startswith('-') else 1
        hh, mm = tz.lstrip('+-').split(':')
        return (dt - sign * timedelta(hours=int(hh), minutes=int(mm))).strftime('%Y-%m-%dT%H:%M')
    except Exception:  # noqa: BLE001
        return None


def merge_points(stored, oracle, tz):
    """Add Oracle-only metrics (DB-local minutes) onto stored points (UTC
    minutes). Stored values win where both exist. Pure."""
    by_t = {p['t']: p for p in stored}
    for p in oracle or []:
        k = _to_utc_key(p['t'], tz) if tz else None
        if not k:
            continue
        tgt = by_t.get(k)
        if tgt is None:
            tgt = by_t[k] = {'t': k}
        for key, v in p.items():
            if key != 't' and tgt.get(key) is None:
                tgt[key] = v
    return [by_t[k] for k in sorted(by_t)]

# metric name in V$SYSMETRIC_HISTORY -> (key, how instances combine)
METRICS = {
    'Average Active Sessions': ('aas', 'sum'),
    'Host CPU Utilization (%)': ('cpu_pct', 'avg'),
    'Database Wait Time Ratio': ('wait_ratio', 'avg'),
    'Logical Reads Per Sec': ('logical_blocks_s', 'sum'),
    'Physical Reads Per Sec': ('physical_blocks_s', 'sum'),
    'Physical Read Total IO Requests Per Sec': ('read_iops', 'sum'),
    'Physical Write Total IO Requests Per Sec': ('write_iops', 'sum'),
    'Physical Read Total Bytes Per Sec': ('read_bytes_s', 'sum'),
    'Physical Write Total Bytes Per Sec': ('write_bytes_s', 'sum'),
    'Redo Generated Per Sec': ('redo_bytes_s', 'sum'),
    'Total PGA Allocated': ('pga_alloc_bytes', 'sum'),
    'Total PGA Used by SQL Workareas': ('pga_used_bytes', 'sum'),
    # Reported by V$CON_SYSMETRIC (a PDB connection) instead of the splits.
    'I/O Requests per Second': ('iops_total', 'sum'),
    'I/O Megabytes per Second': ('io_mb_s', 'sum'),
}


def _derive(p):
    """Totals from whichever form the views gave: read+write splits
    (V$SYSMETRIC) or the PDB-level totals (V$CON_SYSMETRIC). In place."""
    if p.get('read_iops') is not None or p.get('write_iops') is not None:
        p['iops'] = (p.get('read_iops') or 0) + (p.get('write_iops') or 0)
    elif p.get('iops_total') is not None:
        p['iops'] = p['iops_total']
    if p.get('read_bytes_s') is not None or p.get('write_bytes_s') is not None:
        p['io_bytes_s'] = (p.get('read_bytes_s') or 0) + (p.get('write_bytes_s') or 0)
    elif p.get('io_mb_s') is not None:
        p['io_bytes_s'] = p['io_mb_s'] * 1048576
    if p.get('sga_bytes') is not None and p.get('pga_alloc_bytes') is not None:
        p['total_mem_bytes'] = p['sga_bytes'] + p['pga_alloc_bytes']
    return p


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _minute(v):
    """Bucket key: the metric interval's end, to the minute."""
    if isinstance(v, datetime):
        return v.replace(second=0, microsecond=0).isoformat()
    s = str(v or '').replace(' ', 'T', 1)
    return s[:16] if len(s) >= 16 else s


def build_series(rows, block_size=None):
    """Rows of (INST_ID, METRIC_NAME, END_TIME, VALUE) -> one point per minute.

    Instances are combined per metric (rates and active sessions summed,
    percentages averaged). Block-based read rates are converted to bytes when
    the block size is known. Pure.
    """
    buckets = {}
    for r in rows or []:
        meta = METRICS.get(_safe_str(r.get('METRIC_NAME')))
        val = _num(r.get('VALUE'))
        if not meta or val is None:
            continue
        key, how = meta
        t = _minute(r.get('END_TIME'))
        b = buckets.setdefault(t, {}).setdefault(key, [])
        b.append((how, val))
    points = []
    for t in sorted(buckets):
        p = {'t': t}
        for key, vals in buckets[t].items():
            how = vals[0][0]
            nums = [v for _, v in vals]
            p[key] = sum(nums) / len(nums) if how == 'avg' else sum(nums)
        if block_size:
            for src, dst in (('logical_blocks_s', 'logical_bytes_s'), ('physical_blocks_s', 'physical_bytes_s')):
                if p.get(src) is not None:
                    p[dst] = p[src] * block_size
        points.append(_derive(p))
    return points


def _sysmetric(engine, inst_id, errors):
    """GV$SYSMETRIC_HISTORY for the last hour -> (points in DB-local minutes, tz)."""
    names = ", ".join("'" + n.replace("'", "''") + "'" for n in METRICS)  # constants, not input
    binds = {'mins': ORACLE_HISTORY_MINUTES}
    inst_clause = ''
    if inst_id is not None:
        inst_clause = ' AND inst_id = :inst'
        binds['inst'] = int(inst_id)
    rows = []
    for view in ('gv$sysmetric_history', 'gv$con_sysmetric_history'):
        try:
            rows = _rows(engine,
                         f"SELECT inst_id, metric_name, end_time, value FROM {view} "
                         f"WHERE group_id = 2 AND end_time > SYSDATE - :mins / 1440 AND metric_name IN ({names}){inst_clause} "
                         "ORDER BY end_time", binds)
        except Exception as e:  # noqa: BLE001
            errors.append(f'{view}: {e}')
            continue
        if rows:
            break
    block_size = None
    try:
        b = _rows(engine, "SELECT value FROM v$parameter WHERE name = 'db_block_size'")
        block_size = _safe_int(b[0].get('VALUE')) if b else None
    except Exception as e:  # noqa: BLE001
        errors.append(f'db_block_size: {e}')
    tz = None
    try:
        z = _rows(engine, "SELECT TO_CHAR(SYSTIMESTAMP, 'TZH:TZM') AS tz FROM dual")
        tz = _safe_str(z[0].get('TZ')) if z else None
    except Exception as e:  # noqa: BLE001
        errors.append(f'timezone: {e}')
    return build_series(rows, block_size), tz


_SESS_PREV = {}  # conn_id -> (unix seconds, {(inst, sid, serial): cpu centiseconds})


def _session_cpu(engine):
    """Every user session's cumulative CPU (GV$SESSTAT 'CPU used by this
    session', centiseconds) with who it is. Base product; works when MMON
    metrics are off, unlike V$SESSMETRIC."""
    rows = _rows(engine,
                 "SELECT s.inst_id, s.sid, s.serial# AS serial_no, s.username, s.program, s.sql_id, s.status, st.value AS cpu_cs "
                 "FROM gv$session s "
                 "JOIN gv$sesstat st ON st.inst_id = s.inst_id AND st.sid = s.sid "
                 "JOIN gv$statname n ON n.inst_id = st.inst_id AND n.statistic# = st.statistic# "
                 "WHERE s.type = 'USER' AND n.name = 'CPU used by this session'")
    out = {}
    for r in rows:
        key = (_safe_int(r.get('INST_ID')), _safe_int(r.get('SID')), _safe_int(r.get('SERIAL_NO')))
        out[key] = {'cpu_cs': _num(r.get('CPU_CS')) or 0.0, 'username': _safe_str(r.get('USERNAME')) or None,
                    'program': _safe_str(r.get('PROGRAM')) or None, 'sql_id': _safe_str(r.get('SQL_ID')) or None,
                    'status': _safe_str(r.get('STATUS')) or None}
    return out


def top_sessions_by_delta(prev, cur, dt, per_instance=5):
    """Sessions ranked by CPU used between two readings. Pure.

    prev/cur: {(inst, sid, serial): {'cpu_cs': .., ...}}; dt seconds. A session
    new since the last reading is measured from zero only if it is that new —
    it has no earlier value, so it is skipped rather than credited with its
    whole lifetime. cpu_pct is CPU seconds per elapsed second (100% = 1 core).
    """
    if not prev or dt <= 0:
        return []
    ranked = []
    for key, c in cur.items():
        p = prev.get(key)
        if p is None:
            continue
        d = c['cpu_cs'] - p['cpu_cs']
        if d <= 0:
            continue
        inst, sid, serial = key
        ranked.append({'inst_id': inst, 'sid': sid, 'serial': serial, 'username': c.get('username'),
                       'program': c.get('program'), 'sql_id': c.get('sql_id'), 'status': c.get('status'),
                       'cpu_pct': round(d / dt, 1)})   # (d/100 s) / dt * 100
    ranked.sort(key=lambda x: -x['cpu_pct'])
    keep, seen = [], {}
    for x in ranked:
        n = seen.get(x['inst_id'], 0)
        if n < per_instance:
            keep.append(x)
            seen[x['inst_id']] = n + 1
    return keep


def _norm(name):
    return ' '.join(str(name or '').split()).lower()


_BY_NORM = {_norm(k): v for k, v in METRICS.items()}


# Cumulative counters, used when V$SYSMETRIC is empty (MMON metrics off — the
# case the dashboard's own host-CPU code already falls back for). Rates are
# the difference between two collector cycles divided by the seconds between
# them, so the first cycle after a restart stores levels only.
SYSSTAT = {
    'session logical reads': 'logical_blocks',
    'physical reads': 'physical_blocks',
    'physical read total IO requests': 'read_io',
    'physical write total IO requests': 'write_io',
    'physical read total bytes': 'read_bytes',
    'physical write total bytes': 'write_bytes',
    'redo size': 'redo_bytes',
}
_PREV = {}  # (conn_id, inst_id) -> (unix seconds, {counter: value})


def counter_rates(prev, cur):
    """Two counter snapshots -> the stored fields. Pure.

    prev/cur: (unix_seconds, {name: value}); prev may be None. A counter that
    went backwards (instance restart) yields no rate rather than a negative.
    """
    t1, c1 = cur
    out = {'pga_alloc_bytes': c1.get('pga_alloc'), 'pga_used_bytes': c1.get('pga_inuse'), 'sga_bytes': c1.get('sga')}
    if not prev:
        return out
    t0, c0 = prev
    dt = t1 - t0
    if dt <= 0:
        return out

    def d(k):
        a, b = c0.get(k), c1.get(k)
        return None if a is None or b is None or b < a else b - a

    for src, dst in (('logical_blocks', 'logical_blocks_s'), ('physical_blocks', 'physical_blocks_s'),
                     ('read_io', 'read_iops'), ('write_io', 'write_iops'),
                     ('read_bytes', 'read_bytes_s'), ('write_bytes', 'write_bytes_s'), ('redo_bytes', 'redo_bytes_s')):
        v = d(src)
        out[dst] = None if v is None else v / dt
    dbt, dbc = d('db_time_us'), d('db_cpu_us')
    if dbt is not None:
        out['aas'] = dbt / 1e6 / dt
        if dbt > 0 and dbc is not None:
            out['wait_ratio'] = max(0.0, min(100.0, (dbt - dbc) / dbt * 100))
    busy, idle = d('busy'), d('idle')
    if busy is not None and idle is not None and (busy + idle) > 0:
        out['cpu_pct'] = busy / (busy + idle) * 100
    return out


def _counters(engine, errors):
    """Per instance: GV$SYSSTAT, GV$SYS_TIME_MODEL, GV$OSSTAT, GV$PGASTAT and
    the GV$SGASTAT total — the views the dashboard already reads."""
    per = {}

    def put(inst, k, v):
        n = _num(v)
        if n is not None:
            per.setdefault(_safe_int(inst) if inst is not None else 1, {})[k] = n

    names = ", ".join("'" + n + "'" for n in SYSSTAT)  # constants
    for label, sql, fn in (
        ('gv$sysstat', f"SELECT inst_id, name, value FROM gv$sysstat WHERE name IN ({names})",
         lambda r: put(r.get('INST_ID'), SYSSTAT.get(_safe_str(r.get('NAME'))), r.get('VALUE')) if SYSSTAT.get(_safe_str(r.get('NAME'))) else None),
        ('gv$sys_time_model', "SELECT inst_id, stat_name, value FROM gv$sys_time_model WHERE stat_name IN ('DB time', 'DB CPU')",
         lambda r: put(r.get('INST_ID'), 'db_time_us' if _safe_str(r.get('STAT_NAME')) == 'DB time' else 'db_cpu_us', r.get('VALUE'))),
        ('gv$osstat', "SELECT inst_id, stat_name, value FROM gv$osstat WHERE stat_name IN ('BUSY_TIME', 'IDLE_TIME')",
         lambda r: put(r.get('INST_ID'), 'busy' if _safe_str(r.get('STAT_NAME')) == 'BUSY_TIME' else 'idle', r.get('VALUE'))),
        ('gv$pgastat', "SELECT inst_id, name, value FROM gv$pgastat WHERE name IN ('total PGA allocated', 'total PGA inuse')",
         lambda r: put(r.get('INST_ID'), 'pga_alloc' if _safe_str(r.get('NAME')) == 'total PGA allocated' else 'pga_inuse', r.get('VALUE'))),
        ('gv$sgastat', "SELECT inst_id, SUM(bytes) AS value FROM gv$sgastat GROUP BY inst_id",
         lambda r: put(r.get('INST_ID'), 'sga', r.get('VALUE'))),
    ):
        try:
            for r in _rows(engine, sql):
                fn(r)
        except Exception as e:  # noqa: BLE001
            errors.append(f'{label}: {e}')
    return per


def _norm(name):
    return ' '.join(str(name or '').split()).lower()


_BY_NORM = {_norm(k): v for k, v in METRICS.items()}


def collect_sysmetric(conn_id: int, db: Session, agent_name: str = ''):
    """One collector cycle -> one stored row per instance.

    V$SYSMETRIC (Oracle's own 60 s rates) when it has rows; otherwise the
    cumulative counters, turned into rates between cycles. The result says
    which source was used and what it read, so a cycle that stores nothing
    explains itself in its snapshot.
    """
    import time
    from app.services.clickhouse import metrics_history_service as mh
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors, rows, view = [], [], None
    for v, cols in (('gv$sysmetric', 'inst_id, metric_name, value, group_id'),
                    ('v$sysmetric', 'metric_name, value, group_id'),
                    ('gv$con_sysmetric', 'inst_id, metric_name, value, group_id'),
                    ('v$con_sysmetric', 'metric_name, value, group_id')):
        try:
            rows = _rows(engine, f"SELECT {cols} FROM {v} WHERE group_id = 2")
            view = v
            if rows:
                break
        except Exception as e:  # noqa: BLE001
            errors.append(f'{v}: {e}')

    per_inst, source = {}, None
    block = None
    try:
        b = _rows(engine, "SELECT value FROM v$parameter WHERE name = 'db_block_size'")
        block = _safe_int(b[0].get('VALUE')) if b else None
    except Exception as e:  # noqa: BLE001
        errors.append(f'db_block_size: {e}')

    if rows:
        source = view
        for r in rows:
            meta = _BY_NORM.get(_norm(r.get('METRIC_NAME')))
            if meta:
                inst = _safe_int(r.get('INST_ID')) if r.get('INST_ID') is not None else 1
                per_inst.setdefault(inst, {})[meta[0]] = _num(r.get('VALUE'))

    # Counters: always read — they carry SGA/PGA levels, and they are the
    # whole source when V$SYSMETRIC is empty.
    counters = _counters(engine, errors)
    now_s = time.time()
    for inst, cur in counters.items():
        key = (int(conn_id), inst)
        rates = counter_rates(_PREV.get(key), (now_s, cur))
        _PREV[key] = (now_s, cur)
        tgt = per_inst.setdefault(inst, {})
        for k, v in rates.items():
            if tgt.get(k) is None and v is not None:
                tgt[k] = v
    if counters and not source:
        source = 'counters (gv$sysstat, gv$sys_time_model, gv$osstat, gv$pgastat, gv$sgastat)'

    # This cycle's top sessions by CPU, per instance, for "Top 5 at a past
    # moment": CPU used since the previous cycle, from cumulative per-session
    # counters. The first cycle after a restart has no previous reading.
    sessions_stored = 0
    try:
        cur_s = _session_cpu(engine)
        prev_t, prev_s = _SESS_PREV.get(int(conn_id), (None, None))
        now_t = time.time()
        _SESS_PREV[int(conn_id)] = (now_t, cur_s)
        sess = top_sessions_by_delta(prev_s, cur_s, (now_t - prev_t) if prev_t else 0)
        stamp = datetime.now()
        rows_s = [{'ts': stamp, 'agent': agent_name, 'conn_id': int(conn_id), 'inst_id': x['inst_id'] or 1,
                   'sid': x['sid'] or 0, 'serial': x['serial'] or 0, 'username': x.get('username') or '',
                   'program': x.get('program') or '', 'sql_id': x.get('sql_id') or '', 'status': x.get('status') or '',
                   'cpu_pct': x.get('cpu_pct')} for x in sess]
        if rows_s:
            mh.flush_oracle_top_sessions(rows_s)
            sessions_stored = len(rows_s)
        session_note = None if prev_t else 'first cycle — sessions are ranked from the next one'
    except Exception as e:  # noqa: BLE001
        errors.append(f'top sessions: {e}')
        session_note = None

    now = datetime.now()
    out = [{'ts': now, 'agent': agent_name, 'conn_id': int(conn_id), 'inst_id': i, 'block_size': block,
            **{f: v.get(f) for f in mh.ORACLE_SYSMETRIC_FIELDS}} for i, v in per_inst.items() if v]
    if out:
        mh.flush_oracle_sysmetric(out)
    return {
        'status': 'success' if out else 'empty',
        'instances': len(out),
        'source': source,
        'sysmetric_rows': len(rows),
        'counter_instances': len(counters),
        'fields_stored': sorted({k for r in out for k, v in r.items() if v is not None and k in mh.ORACLE_SYSMETRIC_FIELDS}),
        'stored': bool(out),
        'top_sessions_stored': sessions_stored,
        'top_sessions_note': session_note,
        'errors': errors,
    }


def stored_sysmetric_points(rows):
    """query_oracle_sysmetric rows -> points keyed by UTC minute, instances
    combined like build_series (rates/sessions summed, ratios averaged). Pure."""
    how = {key: h for _, (key, h) in METRICS.items()}
    how['sga_bytes'] = 'sum'
    buckets = {}
    for r in rows or []:
        b = buckets.setdefault(_utc_key(r.get('ts')), {'_block': r.get('block_size')})
        for key, h in how.items():
            v = _num(r.get(key))
            if v is not None:
                b.setdefault(key, []).append(v)
    out = []
    for t in sorted(buckets):
        vals = buckets[t]
        p = {'t': t}
        for key, h in how.items():
            nums = vals.get(key)
            if nums:
                p[key] = sum(nums) / len(nums) if h == 'avg' else sum(nums)
        blk = vals.get('_block')
        if blk:
            for src, dst in (('logical_blocks_s', 'logical_bytes_s'), ('physical_blocks_s', 'physical_bytes_s')):
                if p.get(src) is not None:
                    p[dst] = p[src] * blk
        out.append(_derive(p))
    return out


def merge_utc(base, extra):
    """Fill missing keys of base points from extra points (both UTC keys). Pure."""
    by_t = {p['t']: dict(p) for p in base}
    for p in extra:
        tgt = by_t.setdefault(p['t'], {'t': p['t']})
        for k, v in p.items():
            if k != 't' and tgt.get(k) is None:
                tgt[k] = v
    return [by_t[k] for k in sorted(by_t)]


def host_cpu_points(samples, bucket_seconds):
    """Drilldown host samples (captured_at with any offset, or naive UTC) ->
    CPU points averaged per bucket, keyed by UTC minute. Pure."""
    from datetime import timezone
    acc = {}
    for smp in samples:
        v = _num(smp.get('cpu_pct'))
        raw = str(smp.get('captured_at') or '').strip().replace(' ', 'T', 1)
        if v is None or not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            continue
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        epoch = int((dt - datetime(1970, 1, 1)).total_seconds())
        start = datetime(1970, 1, 1) + __import__('datetime').timedelta(seconds=epoch - epoch % int(bucket_seconds))
        acc.setdefault(start.strftime('%Y-%m-%dT%H:%M'), []).append(v)
    return [{'t': k, 'cpu_pct': sum(x) / len(x)} for k, x in sorted(acc.items())]


def oracle_perf_history(conn_id: int, db: Session, minutes: int = 60, inst_id: int | None = None):
    from app.services.clickhouse import metrics_history_service as mh

    conn = _get_conn_or_404(conn_id, db)
    errors = []
    requested = int(minutes)
    minutes = max(5, min(MAX_MINUTES, requested))
    bucket = bucket_for(minutes)

    stored, stored_ok = [], False
    if mh.get_client() is None:
        errors.append('ClickHouse is not reachable — stored history unavailable')
    else:
        rows = mh.history_bucketed(minutes=minutes, bucket_seconds=bucket, kind='database', tech='oracle', conn_id=conn_id)
        stored, stored_ok = stored_points(rows), True

    # Host CPU: when the Oracle pipeline's host_cpu carries nothing (all zero
    # or missing), use the same host samples the Overview's CPU & Memory
    # chart draws (drilldown history: SSH / host agent).
    if not any((p.get('cpu_pct') or 0) > 0 for p in stored):
        try:
            from app.services import drilldown_service as dd
            h = dd.history('oracle', conn_id, db, hours=max(1, -(-minutes // 60)))
            host_pts = host_cpu_points(h.get('samples') or [], bucket)
            if host_pts:
                for p in stored:
                    p.pop('cpu_pct', None)
                stored = merge_utc(stored, host_pts)
        except Exception as e:  # noqa: BLE001
            errors.append(f'host samples: {e}')

    # Stored Oracle system metrics (collector, every cycle) for any range.
    sys_rows = mh.query_oracle_sysmetric(conn_id, minutes, bucket, inst_id) if stored_ok else None
    sys_pts = stored_sysmetric_points(sys_rows) if sys_rows else []
    if sys_pts:
        stored = merge_utc(stored, sys_pts)

    oracle_pts, tz = [], None
    # Live fallback only while nothing is stored yet (new install, last hour).
    if not sys_pts and minutes <= ORACLE_HISTORY_MINUTES:
        try:
            oracle_pts, tz = _sysmetric(_get_engine(conn), inst_id, errors)
        except Exception as e:  # noqa: BLE001
            errors.append(f'oracle: {e}')

    points = merge_points(stored, oracle_pts, tz) if oracle_pts else stored
    return {
        'status': 'success' if (points or stored_ok) else 'error',
        'error': None if (points or stored_ok) else '; '.join(errors) or 'No history source answered',
        'points': points,
        'minutes': minutes,
        'requested_minutes': requested,
        'clamped': requested > MAX_MINUTES,
        'max_minutes': MAX_MINUTES,
        'bucket_seconds': bucket,
        'inst_id': inst_id,
        # Every point key is a UTC minute.
        'db_tz': '+00:00',
        'sources': {
            'stored': 'clickhouse actmon.metrics_db_oracle' if stored_ok else None,
            'stored_points': len(stored),
            'stored_sysmetric_points': len(sys_pts),
            'oracle_points': len(oracle_pts),
            'stored_scope': 'connection',  # not split per RAC instance
        },
        'read_at': datetime.utcnow().isoformat() + 'Z',
        'errors': errors,
    }


def _utc_str(v):
    """A ClickHouse DateTime (returned in the server's timezone) as a UTC
    'YYYY-MM-DD HH:MM:SS' — what the page treats every point time as."""
    from datetime import timezone
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            v = v.astimezone(timezone.utc).replace(tzinfo=None)
        return v.strftime('%Y-%m-%d %H:%M:%S')
    return str(v)


def _agent_for(conn_id):
    """The agent whose telemetry rows carry this connection."""
    from app.services.clickhouse import metrics_history_service as mh
    cli = mh.get_client()
    if cli is None:
        return None, None
    r = cli.query(f"SELECT agent FROM {mh.CH_DB}.metrics_db_oracle WHERE conn_id = %(c)s ORDER BY ts DESC LIMIT 1",
                  parameters={'c': int(conn_id)})
    return cli, (r.result_rows[0][0] if r.result_rows else None)


def oracle_perf_top_at(conn_id: int, db: Session, at: str):
    """Top SQL and wait events from the stored snapshot nearest to `at`
    (UTC 'YYYY-MM-DDTHH:MM'), no later than one minute after it."""
    from app.services.clickhouse import metrics_history_service as mh
    _get_conn_or_404(conn_id, db)
    try:
        when = datetime.strptime(at[:16], '%Y-%m-%dT%H:%M')
    except ValueError:
        return {'status': 'error', 'error': 'at must be YYYY-MM-DDTHH:MM (UTC)'}
    cli, agent = _agent_for(conn_id)
    if cli is None:
        return {'status': 'error', 'error': 'ClickHouse is not reachable'}
    if not agent:
        return {'status': 'success', 'as_of': None, 'top_sql': None, 'top_waits': None, 'top_sessions': None,
                'note': 'No stored telemetry for this connection yet.', 'errors': []}
    errors = []
    out = {'status': 'success', 'agent': agent, 'top_sessions': None}
    try:
        sp = {'c': int(conn_id), 't': when.strftime('%Y-%m-%d %H:%M:%S')}
        snap = cli.query(
            f"SELECT max(ts) FROM {mh.CH_DB}.actmon_oracle_top_sessions WHERE conn_id = %(c)s "
            "AND ts <= toDateTime(%(t)s, 'UTC') + INTERVAL 60 SECOND AND ts >= toDateTime(%(t)s, 'UTC') - INTERVAL 30 MINUTE",
            parameters=sp).result_rows
        sts = snap[0][0] if snap and snap[0][0] and str(snap[0][0])[:4] != '1970' else None
        if sts is not None:
            rows = cli.query(
                f"SELECT inst_id, sid, serial, username, program, sql_id, status, cpu_pct FROM {mh.CH_DB}.actmon_oracle_top_sessions "
                "WHERE conn_id = %(c)s AND ts = %(s)s ORDER BY cpu_pct DESC LIMIT 10",
                parameters={'c': int(conn_id), 's': sts}).result_rows
            out['top_sessions'] = [{'inst_id': r[0], 'sid': r[1], 'serial': r[2], 'username': r[3] or None,
                                    'program': r[4] or None, 'sql_id': r[5] or None, 'status': r[6] or None,
                                    'cpu_pct': r[7]} for r in rows]
            out['top_sessions_at'] = _utc_str(sts)
        else:
            out['top_sessions'] = []
    except Exception as e:  # noqa: BLE001
        # Table not created yet (no cycle has stored sessions) reads as "none stored".
        out['top_sessions'] = [] if 'UNKNOWN_TABLE' in str(e) or 'Unknown table' in str(e) else None
        if out['top_sessions'] is None:
            errors_s = f'top sessions: {e}'
            out.setdefault('errors_pre', []).append(errors_s)
    p = {'a': agent, 't': when.strftime('%Y-%m-%d %H:%M:%S')}
    for table, key, order, cols in (
        ('top_sql', 'top_sql', 'total_ms', 'sql_id, any(sql_text), max(executions), avg(avg_elapsed_ms), max(cpu_time_ms), max(buffer_gets), max(total_ms)'),
        ('wait_events', 'top_waits', 'time_waited_ms', 'event_name, any(wait_class), max(time_waited_ms), avg(avg_ms), max(count)'),
    ):
        try:
            snap = cli.query(
                f"SELECT max(ts) FROM {mh.CH_DB}.{table} WHERE agent = %(a)s "
                "AND ts <= toDateTime(%(t)s, 'UTC') + INTERVAL 60 SECOND AND ts >= toDateTime(%(t)s, 'UTC') - INTERVAL 30 MINUTE",
                parameters=p).result_rows
            ts = snap[0][0] if snap and snap[0][0] and str(snap[0][0])[:4] != '1970' else None
            if ts is None:
                out[key] = []
                continue
            first = cols.split(',')[0]
            rows = cli.query(
                f"SELECT {cols} FROM {mh.CH_DB}.{table} WHERE agent = %(a)s AND ts = %(s)s "
                f"GROUP BY {first} ORDER BY max({order}) DESC LIMIT 5",
                parameters={'a': agent, 's': ts}).result_rows
            out[key + '_at'] = _utc_str(ts)
            if table == 'top_sql':
                out[key] = [{'sql_id': r[0], 'sql_text': r[1], 'executions': r[2], 'avg_elapsed_ms': r[3],
                             'cpu_ms': r[4], 'buffer_gets': r[5], 'total_ms': r[6]} for r in rows]
            else:
                out[key] = [{'event': r[0], 'wait_class': r[1], 'time_waited_ms': r[2], 'avg_ms': r[3], 'count': r[4]} for r in rows]
        except Exception as e:  # noqa: BLE001
            errors.append(f'{table}: {e}')
            out[key] = None
    out['as_of'] = at
    out['errors'] = errors + out.pop('errors_pre', [])
    return out


def top_waits_now(sessions, limit=5):
    """Non-idle waits among sessions, by session count. Pure."""
    agg = {}
    for s in sessions:
        if s.get('wait_class') == 'Idle' or not s.get('event'):
            continue
        a = agg.setdefault(s['event'], {'event': s['event'], 'wait_class': s.get('wait_class'), 'sessions': 0})
        a['sessions'] += 1
    return sorted(agg.values(), key=lambda x: -x['sessions'])[:limit]


def top_sql_now(sessions, limit=5):
    """SQL running right now, by active sessions executing it. Pure."""
    agg = {}
    for s in sessions:
        if (s.get('status') or '').upper() != 'ACTIVE' or not s.get('sql_id'):
            continue
        a = agg.setdefault(s['sql_id'], {'sql_id': s['sql_id'], 'sessions': 0, 'username': s.get('username')})
        a['sessions'] += 1
    return sorted(agg.values(), key=lambda x: -x['sessions'])[:limit]


def oracle_perf_top_now(conn_id: int, db: Session, inst_id: int | None = None, per_instance: int | None = None):
    conn = _get_conn_or_404(conn_id, db)
    engine = _get_engine(conn)
    errors = []
    binds = {}
    inst_m = inst_s = ''
    if inst_id is not None:
        binds['inst'] = int(inst_id)
        inst_m, inst_s = ' AND m.inst_id = :inst', ' AND inst_id = :inst'

    top_sessions = None
    try:
        rows = _rows(engine,
                     "SELECT m.inst_id, m.session_id, m.serial_num, m.cpu, m.intsize_csec, m.end_time, "
                     "s.username, s.program, s.sql_id, s.status FROM gv$sessmetric m "
                     "JOIN gv$session s ON s.inst_id = m.inst_id AND s.sid = m.session_id AND s.serial# = m.serial_num "
                     f"WHERE s.type = 'USER'{inst_m} ORDER BY m.cpu DESC FETCH FIRST {int(per_instance) * 8 if per_instance else 5} ROWS ONLY", binds)
        top_sessions = []
        for r in rows:
            cpu, size = _num(r.get('CPU')), _num(r.get('INTSIZE_CSEC'))
            top_sessions.append({
                'inst_id': _safe_int(r.get('INST_ID')),
                'sid': _safe_int(r.get('SESSION_ID')),
                'serial': _safe_int(r.get('SERIAL_NUM')),
                'username': _safe_str(r.get('USERNAME')) or None,
                'program': _safe_str(r.get('PROGRAM')) or None,
                'sql_id': _safe_str(r.get('SQL_ID')) or None,
                'status': _safe_str(r.get('STATUS')) or None,
                # CPU seconds used in the last interval as a share of that
                # interval: 100% = one full core.
                'cpu_pct': round(cpu / size * 100, 1) if cpu is not None and size else None,
                'interval_end': _safe_str(r.get('END_TIME')) or None,
            })
        if per_instance:
            keep, seen = [], {}
            for x in top_sessions:
                n = seen.get(x['inst_id'], 0)
                if n < per_instance:
                    keep.append(x); seen[x['inst_id']] = n + 1
            top_sessions = keep
    except Exception as e:  # noqa: BLE001
        errors.append(f'gv$sessmetric: {e}')

    if not top_sessions:
        try:
            prev_t, prev_s = _SESS_PREV.get(int(conn_id), (None, None))
            if prev_t:
                cur_s = _session_cpu(engine)
                ranked = top_sessions_by_delta(prev_s, cur_s, time.time() - prev_t, per_instance=per_instance or 5)
                if inst_id is not None:
                    ranked = [x for x in ranked if x['inst_id'] == int(inst_id)]
                top_sessions = ranked if per_instance else ranked[:5]
                session_basis = 'CPU since the last collection cycle (GV$SESSTAT)'
            else:
                session_basis = 'waiting for the first collection cycle'
        except Exception as e:  # noqa: BLE001
            errors.append(f'gv$sesstat: {e}')
            session_basis = None
    else:
        session_basis = 'GV$SESSMETRIC (last interval)'

    live = None
    try:
        rows = _rows(engine,
                     "SELECT sql_id, status, event, wait_class, username FROM gv$session "
                     f"WHERE type = 'USER'{inst_s} FETCH FIRST 3000 ROWS ONLY", binds)
        live = [{k.lower(): v for k, v in r.items()} for r in rows]
    except Exception as e:  # noqa: BLE001
        errors.append(f'gv$session: {e}')

    return {
        'status': 'success',
        'as_of': 'now',
        'top_sessions': top_sessions,
        'sessions_basis': session_basis,
        'top_sql': top_sql_now(live) if live is not None else None,
        'top_waits': top_waits_now(live) if live is not None else None,
        'read_at': datetime.utcnow().isoformat() + 'Z',
        'errors': errors,
    }
