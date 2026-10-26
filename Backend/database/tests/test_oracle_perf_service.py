"""Performance tab backend: series building and honest limits."""
from datetime import datetime
from datetime import datetime
from unittest.mock import patch

from app.services.oracle import oracle_perf_service as m


def test_build_series_combines_instances_and_converts_blocks():
    t = datetime(2026, 10, 15, 5, 35, 42)
    rows = [
        {'INST_ID': 1, 'METRIC_NAME': 'Host CPU Utilization (%)', 'END_TIME': t, 'VALUE': 60},
        {'INST_ID': 2, 'METRIC_NAME': 'Host CPU Utilization (%)', 'END_TIME': t, 'VALUE': 80},
        {'INST_ID': 1, 'METRIC_NAME': 'Average Active Sessions', 'END_TIME': t, 'VALUE': 1.0},
        {'INST_ID': 2, 'METRIC_NAME': 'Average Active Sessions', 'END_TIME': t, 'VALUE': 0.5},
        {'INST_ID': 1, 'METRIC_NAME': 'Logical Reads Per Sec', 'END_TIME': t, 'VALUE': 100},
        {'INST_ID': 1, 'METRIC_NAME': 'Physical Read Total IO Requests Per Sec', 'END_TIME': t, 'VALUE': 10},
        {'INST_ID': 1, 'METRIC_NAME': 'Physical Write Total IO Requests Per Sec', 'END_TIME': t, 'VALUE': 5},
        {'INST_ID': 1, 'METRIC_NAME': 'Not A Metric', 'END_TIME': t, 'VALUE': 9},
    ]
    [p] = m.build_series(rows, block_size=8192)
    assert p['t'] == '2026-10-15T05:35:00'
    assert p['cpu_pct'] == 70          # percentages averaged across instances
    assert p['aas'] == 1.5             # active sessions summed
    assert p['logical_bytes_s'] == 100 * 8192
    assert p['iops'] == 15
    assert 'Not A Metric' not in p


def test_missing_values_are_absent_not_zero():
    [p] = m.build_series([{'METRIC_NAME': 'Host CPU Utilization (%)', 'END_TIME': '2026-10-15 05:35:10', 'VALUE': None},
                          {'METRIC_NAME': 'Average Active Sessions', 'END_TIME': '2026-10-15 05:35:10', 'VALUE': 2}])
    assert 'cpu_pct' not in p and p['aas'] == 2


def _run(fn, fake, *a):
    with patch.object(m, '_rows', fake), patch.object(m, '_get_conn_or_404', lambda c, d: object()), \
            patch.object(m, '_get_engine', lambda c: object()):
        return fn(1, None, *a)


class FakeMH:
    CH_DB = 'actmon'
    def __init__(self, rows=None, up=True):
        self.rows, self.up, self.calls = rows or [], up, []
    def get_client(self):
        return object() if self.up else None
    def history_bucketed(self, **kw):
        self.calls.append(kw)
        return self.rows
    def query_oracle_sysmetric(self, *a, **kw):
        return getattr(self, 'sys', None)


def _hist(fake_rows, mh, minutes, inst=None):
    import app.services.clickhouse.metrics_history_service as real
    with patch.object(real, 'get_client', mh.get_client), patch.object(real, 'history_bucketed', mh.history_bucketed),             patch.object(real, 'query_oracle_sysmetric', mh.query_oracle_sysmetric):
        return _run(m.oracle_perf_history, fake_rows, minutes, inst)


def test_stored_history_is_primary_and_ranges_reach_a_week():
    mh = FakeMH(rows=[{'ts': '2026-10-15 05:36:00', 'host_cpu': 40, 'active_sessions': 7},
                      {'ts': '2026-10-15 05:35:00', 'host_cpu': 30, 'active_sessions': 5}])
    out = _hist(lambda e, sql, p=None: [], mh, 10080)
    assert out['status'] == 'success' and out['minutes'] == 10080 and out['bucket_seconds'] == 3600
    assert [p['t'] for p in out['points']] == ['2026-10-15T05:35', '2026-10-15T05:36']   # oldest first
    assert out['points'][1]['cpu_pct'] == 40 and out['points'][0]['active_sessions'] == 5
    assert mh.calls[0]['tech'] == 'oracle' and mh.calls[0]['conn_id'] == 1


def test_oracle_metrics_merge_in_utc_for_the_last_hour():
    mh = FakeMH(rows=[{'ts': '2026-10-15 00:05:00', 'host_cpu': 40}])
    def fake(e, sql, p=None):
        if 'sysmetric_history' in sql:
            return [{'METRIC_NAME': 'Logical Reads Per Sec', 'END_TIME': '2026-10-15 05:35:10', 'VALUE': 10}]
        if 'db_block_size' in sql:
            return [{'VALUE': 8192}]
        if 'TZH' in sql:
            return [{'TZ': '+05:30'}]
        return []
    out = _hist(fake, mh, 60, 2)
    [p] = out['points']                         # 05:35 IST == 00:05 UTC: one point
    assert p['t'] == '2026-10-15T00:05' and p['cpu_pct'] == 40 and p['logical_bytes_s'] == 10 * 8192


def test_no_oracle_query_beyond_an_hour():
    seen = []
    _hist(lambda e, sql, p=None: seen.append(sql) or [], FakeMH(), 1440)
    assert not any('sysmetric' in q for q in seen)


def test_clickhouse_down_and_oracle_silent_is_an_error_not_empty_success():
    out = _hist(lambda e, sql, p=None: (_ for _ in ()).throw(RuntimeError('agent did not answer')), FakeMH(up=False), 60)
    assert out['status'] == 'error' and 'ClickHouse' in out['error']


def test_instance_filter_is_a_bind():
    calls = []
    def fake(e, sql, p=None):
        calls.append((sql, p))
        return []
    _hist(fake, FakeMH(), 60, 2)
    sql, p = next(c for c in calls if 'sysmetric_history' in c[0])
    assert ':inst' in sql and p['inst'] == 2


def test_utc_key_conversion():
    assert m._to_utc_key('2026-10-15T05:35', '+05:30') == '2026-10-15T00:05'
    assert m._to_utc_key('2026-10-15T01:00', '-04:00') == '2026-10-15T05:00'


def test_top_now_never_reads_ash():
    calls = []
    def fake(e, sql, p=None):
        calls.append(sql.lower())
        return []
    out = _run(m.oracle_perf_top_now, fake, None)
    assert out['as_of'] == 'now'
    assert not any('active_session_history' in c or 'dba_hist' in c for c in calls)


def test_top_sql_and_waits_now():
    s = [{'status': 'ACTIVE', 'sql_id': 'a', 'event': 'db file sequential read', 'wait_class': 'User I/O'},
         {'status': 'ACTIVE', 'sql_id': 'a', 'event': 'SQL*Net message from client', 'wait_class': 'Idle'},
         {'status': 'INACTIVE', 'sql_id': 'b', 'event': 'x', 'wait_class': 'Other'}]
    assert m.top_sql_now(s) == [{'sql_id': 'a', 'sessions': 2, 'username': None}]
    assert [w['event'] for w in m.top_waits_now(s)] == ['db file sequential read', 'x']


def test_stored_sysmetric_fills_every_range_and_skips_live_query():
    mh = FakeMH(rows=[{'ts': '2026-10-15 05:00:00', 'host_cpu': 40}])
    mh.sys = [{'ts': '2026-10-15 05:00:00', 'inst_id': 1, 'block_size': 8192, 'logical_blocks_s': 10, 'read_iops': 3, 'cpu_pct': 50},
              {'ts': '2026-10-15 05:00:00', 'inst_id': 2, 'block_size': 8192, 'logical_blocks_s': 20, 'read_iops': 4, 'cpu_pct': 70}]
    seen = []
    out = _hist(lambda e, sql, p=None: seen.append(sql) or [], mh, 1440)
    [p] = out['points']
    assert p['cpu_pct'] == 40                         # stored host CPU wins
    assert p['logical_bytes_s'] == 30 * 8192 and p['iops'] == 7   # instances summed
    assert out['sources']['stored_sysmetric_points'] == 1
    assert not any('sysmetric_history' in q for q in seen)


def test_collect_sysmetric_stores_one_row_per_instance():
    import app.services.clickhouse.metrics_history_service as real
    stored = []
    def fake(e, sql, p=None):
        if 'gv$sysmetric' in sql:
            return [{'INST_ID': 1, 'METRIC_NAME': 'host cpu  utilization (%)', 'VALUE': 12},
                    {'INST_ID': 1, 'METRIC_NAME': 'Something Else', 'VALUE': 1},
                    {'INST_ID': 2, 'METRIC_NAME': 'Host CPU Utilization (%)', 'VALUE': 14},
                    {'INST_ID': 2, 'METRIC_NAME': 'Total PGA Allocated', 'VALUE': 1024}]
        return [{'VALUE': 8192}]
    with patch.object(real, 'flush_oracle_sysmetric', stored.extend):
        out = _run(m.collect_sysmetric, fake, 'agent-x')
    assert out['instances'] == 2 and out['sysmetric_rows'] == 4
    by = {r['inst_id']: r for r in stored}
    assert by[1]['cpu_pct'] == 12 and by[2]['pga_alloc_bytes'] == 1024 and by[1]['pga_alloc_bytes'] is None
    assert by[2]['agent'] == 'agent-x' and by[2]['block_size'] == 8192


def test_collect_sysmetric_reports_why_nothing_was_stored():
    import app.services.clickhouse.metrics_history_service as real
    stored = []
    with patch.object(real, 'flush_oracle_sysmetric', stored.extend):
        out = _run(m.collect_sysmetric, lambda e, sql, p=None: [], 'a')
    assert out['status'] == 'empty' and out['sysmetric_rows'] == 0 and out['stored'] is False and stored == []


def test_pdb_connection_falls_back_to_con_sysmetric():
    import app.services.clickhouse.metrics_history_service as real
    stored = []
    def fake(e, sql, p=None):
        if 'con_sysmetric' in sql:
            return [{'INST_ID': 1, 'METRIC_NAME': 'I/O Requests per Second', 'VALUE': 900},
                    {'INST_ID': 1, 'METRIC_NAME': 'Average Active Sessions', 'VALUE': 2.5}]
        if 'sysmetric' in sql:
            return []                      # CDB-level views are empty inside a PDB
        return [{'VALUE': 8192}]
    with patch.object(real, 'flush_oracle_sysmetric', stored.extend):
        out = _run(m.collect_sysmetric, fake, 'a')
    assert out['source'] == 'gv$con_sysmetric' and out['instances'] == 1
    assert stored[0]['iops_total'] == 900 and stored[0]['aas'] == 2.5
    [p] = m.stored_sysmetric_points([{'ts': '2026-10-16 05:00:00', 'inst_id': 1, 'iops_total': 900, 'io_mb_s': 2}])
    assert p['iops'] == 900 and p['io_bytes_s'] == 2 * 1048576


def test_host_cpu_points_convert_offsets_and_bucket():
    pts = m.host_cpu_points([
        {'captured_at': '2026-10-16 10:31:10+05:30', 'cpu_pct': 20},
        {'captured_at': '2026-10-16 10:33:50+05:30', 'cpu_pct': 40},
        {'captured_at': '2026-10-16T05:36:00', 'cpu_pct': 60},     # naive = UTC
        {'captured_at': 'bad', 'cpu_pct': 1},
    ], 300)
    assert pts == [{'t': '2026-10-16T05:00', 'cpu_pct': 30.0}, {'t': '2026-10-16T05:35', 'cpu_pct': 60.0}]


def test_counter_rates_between_cycles():
    prev = (100.0, {'logical_blocks': 1000, 'read_io': 50, 'write_io': 10, 'redo_bytes': 0,
                    'db_time_us': 0, 'db_cpu_us': 0, 'busy': 100, 'idle': 300, 'pga_alloc': 1, 'sga': 5})
    cur = (160.0, {'logical_blocks': 7000, 'read_io': 110, 'write_io': 70, 'redo_bytes': 6000,
                   'db_time_us': 120_000_000, 'db_cpu_us': 30_000_000, 'busy': 160, 'idle': 340, 'pga_alloc': 2, 'sga': 5})
    r = m.counter_rates(prev, cur)
    assert r['logical_blocks_s'] == 100 and r['read_iops'] == 1 and r['write_iops'] == 1 and r['redo_bytes_s'] == 100
    assert r['aas'] == 2.0 and r['wait_ratio'] == 75.0          # 120 s DB time in 60 s; 90 of 120 waiting
    assert r['cpu_pct'] == 60.0 and r['pga_alloc_bytes'] == 2 and r['sga_bytes'] == 5
    assert m.counter_rates(None, cur)['sga_bytes'] == 5 and 'aas' not in m.counter_rates(None, cur)


def test_counter_restart_gives_no_negative_rate():
    r = m.counter_rates((0.0, {'logical_blocks': 9000}), (60.0, {'logical_blocks': 10}))
    assert r['logical_blocks_s'] is None


def test_mmon_off_uses_counters_and_second_cycle_has_rates():
    import app.services.clickhouse.metrics_history_service as real
    m._PREV.clear()
    state = {'reads': 1000}
    def fake(e, sql, p=None):
        if 'sysmetric' in sql:
            return []                                 # MMON metrics off
        if 'gv$sysstat' in sql:
            return [{'INST_ID': 1, 'NAME': 'session logical reads', 'VALUE': state['reads']}]
        if 'gv$sgastat' in sql:
            return [{'INST_ID': 1, 'VALUE': 11 * 2 ** 30}]
        if 'gv$pgastat' in sql:
            return [{'INST_ID': 1, 'NAME': 'total PGA allocated', 'VALUE': 2 ** 30}]
        if 'db_block_size' in sql:
            return [{'VALUE': 8192}]
        return []
    stored = []
    with patch.object(real, 'flush_oracle_sysmetric', stored.extend):
        first = _run(m.collect_sysmetric, fake, 'a')
        k = (1, 1); t, c = m._PREV[k]; m._PREV[k] = (t - 60, c)   # pretend a minute passed
        state['reads'] = 7000
        second = _run(m.collect_sysmetric, fake, 'a')
    assert first['source'].startswith('counters') and first['stored'] is True
    assert stored[0]['sga_bytes'] == 11 * 2 ** 30 and stored[0]['logical_blocks_s'] is None   # no rate yet
    assert abs(stored[1]['logical_blocks_s'] - 100) < 1 and stored[1]['pga_alloc_bytes'] == 2 ** 30
    assert 'logical_blocks_s' in second['fields_stored']


def test_top_sessions_by_delta():
    prev = {(1, 10, 1): {'cpu_cs': 100}, (1, 11, 1): {'cpu_cs': 500}, (2, 20, 3): {'cpu_cs': 0}}
    cur = {(1, 10, 1): {'cpu_cs': 700, 'username': 'APPS'},     # 600 cs in 60 s = 10 % of a core
           (1, 11, 1): {'cpu_cs': 500},                         # idle: no CPU
           (2, 20, 3): {'cpu_cs': 3000, 'program': 'JDBC'},     # 50 %
           (2, 21, 9): {'cpu_cs': 99999}}                       # new session: no earlier reading
    out = m.top_sessions_by_delta(prev, cur, 60)
    assert [(x['inst_id'], x['sid'], x['cpu_pct']) for x in out] == [(2, 20, 50.0), (1, 10, 10.0)]
    assert m.top_sessions_by_delta(None, cur, 60) == []


def test_collector_stores_top_sessions_from_counters():
    import app.services.clickhouse.metrics_history_service as real
    m._PREV.clear(); m._SESS_PREV.clear()
    state = {'cpu': 0}
    def fake(e, sql, p=None):
        if 'gv$sesstat' in sql:
            return [{'INST_ID': i, 'SID': 100 + k, 'SERIAL_NO': 7, 'USERNAME': 'APPS', 'PROGRAM': 'JDBC',
                     'SQL_ID': 'x', 'STATUS': 'ACTIVE', 'CPU_CS': state['cpu'] * (k + 1)}
                    for i in (1, 2) for k in range(7)]
        if 'gv$sgastat' in sql:
            return [{'INST_ID': 1, 'VALUE': 5}]
        return []
    sess = []
    with patch.object(real, 'flush_oracle_top_sessions', sess.extend), patch.object(real, 'flush_oracle_sysmetric', lambda r: None):
        first = _run(m.collect_sysmetric, fake, 'a')
        t0, c0 = m._SESS_PREV[1]; m._SESS_PREV[1] = (t0 - 60, c0)
        state['cpu'] = 600
        second = _run(m.collect_sysmetric, fake, 'a')
    assert first['top_sessions_stored'] == 0 and 'first cycle' in first['top_sessions_note']
    assert second['top_sessions_stored'] == 10                 # 5 per instance
    assert {r['inst_id'] for r in sess} == {1, 2} and sess[0]['sid'] == 106 and abs(sess[0]['cpu_pct'] - 70.0) < 0.5


def test_snapshot_times_are_returned_in_utc():
    from datetime import timedelta, timezone
    ist = timezone(timedelta(hours=5, minutes=30))
    assert m._utc_str(datetime(2026, 10, 16, 13, 29, tzinfo=ist)) == '2026-10-16 07:59:00'
    assert m._utc_str(datetime(2026, 10, 16, 7, 59)) == '2026-10-16 07:59:00'
