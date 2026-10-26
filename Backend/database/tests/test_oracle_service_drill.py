"""Service drill-down: membership, honesty about unreadable data, bind safety."""
from unittest.mock import patch

import pytest

from app.services.oracle import oracle_service_drill_service as m

SVC = "APPLSYS.WF_CONTROL"


class FakeOracle:
    """Answers by matching a fragment of the SQL. `fail` lists fragments
    that raise, like a missing grant would."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    def __call__(self, engine, sql, params=None):
        self.calls.append((sql, params or {}))
        for f in self.fail:
            if f in sql:
                raise RuntimeError(f"ORA-00942: table or view does not exist ({f})")
        if "FROM dba_services WHERE UPPER(name)" in sql:
            return [{"NAME": SVC, "NETWORK_NAME": SVC, "CREATION_DATE": None}]
        if "FROM dba_services WHERE name" in sql:
            return [{"GOAL": "NONE", "CLB_GOAL": "LONG", "ENABLED": "YES"}]
        if "db_domain" in sql:
            return [{"VALUE": "ebs.local"}]
        if "FROM gv$instance" in sql:
            return [
                {"INST_ID": 1, "INSTANCE_NUMBER": 1, "INSTANCE_NAME": "KCDB1", "HOST_NAME": "n1", "STATUS": "OPEN"},
                {"INST_ID": 2, "INSTANCE_NUMBER": 2, "INSTANCE_NAME": "KCDB2", "HOST_NAME": "n2", "STATUS": "OPEN"},
            ]
        if "FROM v$database" in sql:
            return [{"NAME": "KPATCH", "DATABASE_ROLE": "PRIMARY"}]
        if "gv$active_services" in sql:
            # EBS registers the service with SYS$ and the domain.
            return [{"INST_ID": 1, "NAME": f"SYS${SVC}.EBS.LOCAL", "NETWORK_NAME": f"SYS${SVC}.EBS.LOCAL"}]
        if "FROM gv$session WHERE type" in sql:
            rows = [
                {"INST_ID": 1, "SID": 1345, "SERIAL_NO": 22111, "STATUS": "ACTIVE",
                 "SERVICE_NAME": f"SYS${SVC}.EBS.LOCAL", "EVENT": "db file sequential read",
                 "WAIT_CLASS": "User I/O", "SECONDS_IN_WAIT": 3},
                {"INST_ID": 1, "SID": 1456, "SERIAL_NO": 33221, "STATUS": "INACTIVE",
                 "SERVICE_NAME": SVC, "EVENT": "SQL*Net message from client", "WAIT_CLASS": "Idle"},
                # Matched by the LIKE pre-filter ('_' wildcard) but not this service.
                {"INST_ID": 1, "SID": 9, "SERIAL_NO": 1, "STATUS": "ACTIVE", "SERVICE_NAME": "APPLSYSXWFXCONTROL"},
            ]
            inst = (params or {}).get("inst")
            return [r for r in rows if inst is None or r["INST_ID"] == inst]
        if "gv$servicemetric" in sql:
            return []
        if "dba_outstanding_alerts" in sql:
            return []
        if "gv$sysmetric" in sql:
            return [{"METRIC_NAME": "Host CPU Utilization (%)", "VALUE": 32.0, "METRIC_UNIT": "%"}]
        if "gv$sgastat" in sql:
            return [{"B": 1048576 * 2048}]
        if "gv$pgastat" in sql:
            return []
        return []


def run(fn, fake, *args):
    with patch.object(m, "_rows", fake), patch.object(m, "_get_conn_or_404", lambda c, d: object()), \
            patch.object(m, "_get_engine", lambda c: object()):
        return fn(1, None, *args)


def test_service_detail_matches_ebs_spellings_and_reports_partial():
    out = run(m.oracle_service_detail, FakeOracle(), SVC)
    assert out["status"] == "success"
    assert out["overall"] == "partial"  # registered on 1 of 2 instances
    by = {i["inst_id"]: i for i in out["instances"]}
    assert by[1]["service_status"] == "active" and by[2]["service_status"] == "not_active"
    # SYS$...EBS.LOCAL and the bare name both count; the look-alike does not.
    assert out["sessions"]["total"] == 2 and out["sessions"]["active"] == 1


def test_unreadable_sections_are_none_not_zero():
    out = run(m.oracle_service_detail, FakeOracle(fail={"FROM gv$session", "active_services"}), SVC)
    assert out["status"] == "success"
    assert out["sessions"]["total"] is None
    assert out["overall"] == "unknown"
    assert all(i["service_status"] is None and i["sessions"] is None for i in out["instances"])
    assert any("gv$session" in e for e in out["errors"])


def test_unknown_service_is_not_found():
    fake = FakeOracle()
    fake.__class__ = type("F", (FakeOracle,), {})
    with patch.object(m, "_rows", lambda e, sql, p=None: [] if "dba_services" in sql else fake(e, sql, p)), \
            patch.object(m, "_get_conn_or_404", lambda c, d: object()), patch.object(m, "_get_engine", lambda c: object()):
        out = m.oracle_service_detail(1, None, "NOPE")
    assert out["status"] == "not_found"


def test_user_input_only_reaches_oracle_as_binds():
    evil = "X' OR 1=1 --"
    fake = FakeOracle()
    run(m.oracle_service_detail, fake, evil)
    for sql, _ in fake.calls:
        assert evil not in sql


def test_instance_level_scopes_to_the_instance():
    out = run(m.oracle_service_instance, FakeOracle(), SVC, 1)
    assert out["instance"]["instance_name"] == "KCDB1"
    assert out["service_status"] == "active"
    assert out["sessions"] == {"total": 2, "active": 1, "truncated": False}
    assert [w["event"] for w in out["waits"]] == ["db file sequential read"]  # idle wait excluded
    assert out["memory"]["sga_mb"] == 2048
    assert out["sysmetrics"]["Host CPU Utilization (%)"]["value"] == 32.0


def test_instance_not_in_cluster():
    out = run(m.oracle_service_instance, FakeOracle(), SVC, 7)
    assert out["status"] == "not_found"


def test_sessions_list():
    out = run(m.oracle_service_sessions, FakeOracle(), SVC, 1)
    assert [s["sid"] for s in out["sessions"]] == [1345, 1456]


def test_session_detail_ended():
    out = run(m.oracle_session_detail, FakeOracle(), 1, 1345, 99)
    assert out["status"] == "ended"


def test_sql_detail_aged_out():
    out = run(m.oracle_sql_detail, FakeOracle(), "8x3k2m1nq4abc", 1)
    assert out["status"] == "not_found"


def test_sql_detail_aggregates_children():
    def fake(e, sql, p=None):
        if "FROM gv$sql WHERE sql_id" in sql:
            return [
                {"INST_ID": 1, "CHILD_NUMBER": 0, "PLAN_HASH_VALUE": 111, "EXECUTIONS": 10,
                 "ELAPSED_TIME": 2_000_000, "CPU_TIME": 1_000_000, "BUFFER_GETS": 500},
                {"INST_ID": 1, "CHILD_NUMBER": 1, "PLAN_HASH_VALUE": 222, "EXECUTIONS": 30,
                 "ELAPSED_TIME": 6_000_000, "CPU_TIME": 3_000_000, "BUFFER_GETS": 1500},
            ]
        if "sql_fulltext" in sql:
            return [{"SQL_FULLTEXT": "SELECT 1 FROM dual", "SQL_TEXT": "SELECT 1"}]
        return []
    out = run(m.oracle_sql_detail, fake, "8x3k2m1nq4abc", None)
    s = out["summary"]
    assert s["executions"] == 40 and s["elapsed_s"] == 8.0
    assert s["elapsed_ms_per_exec"] == 200.0
    assert s["plan_hash_values"] == ["111", "222"]
    assert out["text"] == "SELECT 1 FROM dual"


@pytest.mark.parametrize("active,ids,want", [
    (None, [1, 2], "unknown"), ({1, 2}, [1, 2], "online"), ({1}, [1, 2], "partial"),
    (set(), [1, 2], "offline"), ({None}, [], "online"),
])
def test_overall_rule(active, ids, want):
    assert m.service_overall(active, ids) == want


def test_session_activity_waits_blocking_and_binds():
    calls = []
    def fake(e, sql, p=None):
        calls.append((sql, p))
        if 'gv$session_event' in sql:
            return [{'EVENT': 'db file scattered read', 'WAIT_CLASS': 'User I/O', 'TOTAL_WAITS': 120, 'TIME_WAITED_MICRO': 8_200_000}]
        if '(blocker)' in str(p) or 'b.serial#' in sql:
            return [{'INST_ID': 2, 'SID': 77, 'SERIAL_NO': 5, 'USERNAME': 'APPS', 'STATUS': 'ACTIVE', 'EVENT': 'SQL*Net message from client'}]
        if 'blocking_session = :sid' in sql:
            return []
        return []
    out = run(m.oracle_session_activity, fake, 1, 5062, 53131)
    assert out['waits'][0]['time_waited_s'] == 8.2 and out['waits'][0]['total_waits'] == 120
    assert out['blocker'][0]['sid'] == 77 and out['blocked'] == []
    for sql, p in calls:
        assert '5062' not in sql and '53131' not in sql      # ids only as binds
    assert out['timeline'] is None or isinstance(out['timeline'], list)   # None = history store unreachable
