"""Query Analysis results backend: plan statistics and trend are honest about absence."""
from unittest.mock import patch

from app.services.oracle import oracle_sql_analysis_service as m


def _run(fn, fake, *a):
    with patch.object(m, '_rows', fake), patch.object(m, '_get_conn_or_404', lambda c, d: object()), \
            patch.object(m, '_get_engine', lambda c: object()):
        return fn(1, None, *a)


def test_plan_stats_converts_and_takes_first_child():
    def fake(e, sql, p=None):
        assert ':sid' in sql and p['sid'] == '2u5j3mb3p0bbc'
        return [{'CHILD_NUMBER': 1, 'ID': 0, 'LAST_OUTPUT_ROWS': 9, 'LAST_ELAPSED_TIME': 5000},
                {'CHILD_NUMBER': 0, 'ID': 0, 'LAST_OUTPUT_ROWS': 1, 'LAST_ELAPSED_TIME': 3440000, 'LAST_STARTS': 1},
                {'CHILD_NUMBER': 0, 'ID': 2, 'LAST_OUTPUT_ROWS': 250, 'LAST_ELAPSED_TIME': 3410000}]
    out = _run(m.oracle_sql_plan_stats, fake, '2u5j3mb3p0bbc', None)
    assert out['collected'] and out['child_number'] == 0
    assert [(s['id'], s['actual_rows'], s['elapsed_ms']) for s in out['steps']] == [(0, 1.0, 3440.0), (2, 250.0, 3410.0)]


def test_plan_stats_not_collected_says_so():
    out = _run(m.oracle_sql_plan_stats, lambda e, s, p=None: [], '2u5j3mb3p0bbc', None)
    assert out['collected'] is False and 'STATISTICS_LEVEL=ALL' in out['note'] and out['steps'] == []


def test_plan_stats_error_is_reported():
    def boom(e, s, p=None):
        raise RuntimeError('ORA-00942')
    out = _run(m.oracle_sql_plan_stats, boom, '2u5j3mb3p0bbc', None)
    assert out['status'] == 'error' and 'ORA-00942' in out['error']
