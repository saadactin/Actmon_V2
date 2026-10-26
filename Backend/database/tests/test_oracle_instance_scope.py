# -*- coding: utf-8 -*-
"""Both RAC nodes opened the same dashboard and read the same instance.

A V$ view describes only the instance the session is connected to, and a RAC
cluster has one registered connection, so node 2's Dashboard button landed on
node 1's payload. The collector can now be asked for a specific instance and
reads the cluster-wide GV$ twins instead.

These tests capture the SQL the collector sends, because the mistake this
guards against is silent: a query that forgets its inst_id filter still runs,
still returns rows, and still shows the wrong node.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.oracle.oracle_monitoring_service import _oracle_dashboard_inner


class _Recorder:
    """Stands in for the Oracle engine, remembering every statement sent."""

    def __init__(self):
        self.statements = []
        self.params = []

    def __call__(self, engine, sql, params=None):
        self.statements.append(" ".join(sql.split()))
        self.params.append(params or {})
        return []


@pytest.fixture
def sent(monkeypatch):
    """Run one collection and hand back the SQL it issued."""
    import app.services.oracle.oracle_monitoring_service as svc

    rec = _Recorder()
    monkeypatch.setattr(svc, "_rows", rec)
    class _Conn:
        """Any connection attribute the payload reads; the subject here is the
        SQL, not the connection record."""
        id = 1
        connection_name = "KPATCH"

        def __getattr__(self, name):
            return None

    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: _Conn())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())

    def run(inst_id=None):
        rec.statements.clear()
        rec.params.clear()
        payload = _oracle_dashboard_inner(1, None, inst_id)
        return rec, payload

    return run


def _find(statements, needle):
    return [s for s in statements if needle.lower() in s.lower()]


# ── unscoped: unchanged behaviour ────────────────────────────────────────

def test_without_an_instance_the_queries_are_untouched(sent):
    rec, _ = sent()
    joined = " | ".join(rec.statements)
    assert "gv$" not in joined.lower(), "no GV$ view should be used when no instance is named"
    assert "inst_id" not in joined.lower()
    assert all(p == {} for p in rec.params)


def test_without_an_instance_the_local_views_are_still_read(sent):
    rec, _ = sent()
    assert _find(rec.statements, "from v$instance")
    assert _find(rec.statements, "from v$session")


# ── scoped: every instance-local view is filtered ────────────────────────

LOCAL_VIEWS = [
    "instance", "session", "parameter", "sgainfo", "process",
    "buffer_pool_statistics", "librarycache", "sysmetric", "osstat",
    "system_event", "version",
]


@pytest.mark.parametrize("view", LOCAL_VIEWS)
def test_each_instance_local_view_is_read_from_gv_and_filtered(sent, view):
    rec, _ = sent(inst_id=2)
    hits = _find(rec.statements, "gv$" + view)
    assert hits, "gv$%s was never queried for a specific instance" % view
    for sql in hits:
        assert "inst_id = :inst" in sql, (
            "gv$%s was read cluster-wide with no instance filter: %s" % (view, sql)
        )


def test_the_instance_number_is_bound_not_interpolated(sent):
    rec, _ = sent(inst_id=2)
    scoped = [p for p in rec.params if p]
    assert scoped, "the instance number never reached the driver as a bind parameter"
    assert all(p == {"inst": 2} for p in scoped)


def test_no_v_dollar_local_view_survives_scoping(sent):
    # A view left on V$ would silently report the connected node's numbers
    # under the other node's name — exactly the bug being fixed.
    rec, _ = sent(inst_id=2)
    for view in LOCAL_VIEWS:
        stale = [s for s in rec.statements if (" v$" + view) in s.lower()]
        assert not stale, "v$%s was still read unscoped: %s" % (view, stale)


# ── database-wide facts stay database-wide ───────────────────────────────

def test_shared_storage_facts_are_not_filtered_per_instance(sent):
    """In RAC every instance mounts the same datafiles. Filtering these per
    node would invent a difference the database does not have."""
    rec, _ = sent(inst_id=2)
    for shared in ("v$database", "dba_data_files", "dba_tablespace_usage_metrics", "v$log"):
        hits = _find(rec.statements, shared)
        assert hits, "%s should still be read" % shared
        for sql in hits:
            assert "inst_id" not in sql.lower(), "%s was wrongly scoped to one node" % shared


def test_redo_groups_report_the_thread_that_owns_them(sent):
    rec, _ = sent(inst_id=2)
    log_sql = _find(rec.statements, "from v$log")
    assert log_sql and "thread#" in log_sql[0].lower(), (
        "without THREAD# there is no way to tell which instance a redo group belongs to"
    )


# ── the cached snapshot belongs to one node ──────────────────────────────

def test_a_scoped_request_never_serves_the_agents_cached_snapshot(monkeypatch):
    """The agent sits on one node, so its snapshot describes that node. Serving
    it for a question about another instance answers the wrong question."""
    import app.services.oracle.oracle_monitoring_service as svc
    import app.utils.agent_cache as cache

    monkeypatch.setattr(cache, "get_snapshot",
                        lambda *a, **k: {"health_summary": {"instance_name": "KCDB1"}})
    seen = {}

    def fake_timeout(fn, *args, **kwargs):
        seen["args"] = args
        return {"health_summary": {"instance_name": "KCDB2"}}

    monkeypatch.setattr(svc, "_run_with_timeout", fake_timeout)

    cached = svc.oracle_dashboard(1, None)
    assert cached["health_summary"]["instance_name"] == "KCDB1", "the cache still serves node 1"

    scoped = svc.oracle_dashboard(1, None, 2)
    assert scoped["health_summary"]["instance_name"] == "KCDB2"
    assert seen["args"][-1] == 2, "the instance number must reach the collector"
