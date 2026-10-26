"""
Tests for oracle_services() — the panel that reported every service offline on
an instance that was serving them.

Run with:  pytest tests/test_oracle_services.py -v

The function talks to Oracle, so `_rows` is replaced with a stub that records
the SQL it is asked for and replays canned view rows. That covers both halves
of the original bug:

  * the SQL assertions catch the wrong column name (GV$ACTIVE_SERVICES has
    NAME, not SERVICE_NAME — V$SESSION is the one with SERVICE_NAME), which is
    what made the query fail on every instance;

  * the behaviour assertions catch what that failure turned into — a swallowed
    exception reported as "offline", which is a statement about the service
    that nothing supports.
"""
import pytest

from app.services.oracle import oracle_monitoring_service as svc


@pytest.fixture
def fake_oracle(monkeypatch):
    """Replay canned rows per view and record every statement issued."""
    state = {"sql": [], "views": {}}

    def rows(engine, sql, params=None):
        state["sql"].append(" ".join(sql.split()))
        low = sql.lower()
        for view, result in state["views"].items():
            if view in low:
                if isinstance(result, Exception):
                    raise result
                return result
        raise Exception('ORA-00942: table or view does not exist')

    monkeypatch.setattr(svc, "_rows", rows)
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda conn_id, db: object())
    monkeypatch.setattr(svc, "_get_engine", lambda conn: object())
    monkeypatch.setattr("app.utils.agent_cache.get_snapshot", lambda *a, **k: None)
    return state


TWO_SERVICES = [
    {"NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"},
    {"NAME": "KPATCH", "NETWORK_NAME": "KPATCH"},
]
TWO_INSTANCES = [
    {"INST_ID": 1, "INSTANCE_NUMBER": 1},
    {"INST_ID": 2, "INSTANCE_NUMBER": 2},
]


def test_queries_the_column_that_actually_exists(fake_oracle):
    """GV$ACTIVE_SERVICES.NAME, never SERVICE_NAME. Selecting the latter is an
    ORA-00904 on every Oracle there is, which is the whole outage."""
    fake_oracle["views"] = {
        "dba_services": TWO_SERVICES,
        "gv$instance": TWO_INSTANCES,
        "gv$active_services": [{"INST_ID": 1, "NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}],
    }
    svc.oracle_services(1, None)
    active_sql = [q for q in fake_oracle["sql"] if "active_services" in q.lower()]
    assert active_sql, "the active-services view was never queried"
    for q in active_sql:
        assert "service_name" not in q.lower(), f"SERVICE_NAME does not exist on that view: {q}"
        assert "name" in q.lower()


def test_service_active_on_every_instance_is_online(fake_oracle):
    fake_oracle["views"] = {
        "dba_services": TWO_SERVICES,
        "gv$instance": TWO_INSTANCES,
        "gv$active_services": [
            {"INST_ID": 1, "NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"},
            {"INST_ID": 2, "NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"},
        ],
    }
    out = svc.oracle_services(1, None)
    by_name = {s["service_name"]: s for s in out["services"]}
    assert by_name["ebs_KPATCH"]["status"] == "online"
    assert [i["status"] for i in by_name["ebs_KPATCH"]["instances"]] == ["online", "online"]
    # The one that genuinely is not running still reads offline.
    assert by_name["KPATCH"]["status"] == "offline"


def test_service_on_one_of_two_instances_is_partial(fake_oracle):
    fake_oracle["views"] = {
        "dba_services": TWO_SERVICES,
        "gv$instance": TWO_INSTANCES,
        "gv$active_services": [{"INST_ID": 2, "NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}],
    }
    out = svc.oracle_services(1, None)
    svc_row = next(s for s in out["services"] if s["service_name"] == "ebs_KPATCH")
    assert svc_row["status"] == "partial"
    assert {i["instance_number"]: i["status"] for i in svc_row["instances"]} == {1: "offline", 2: "online"}


def test_inst_id_is_translated_to_instance_number(fake_oracle):
    """GV$ views are keyed by INST_ID; V$INSTANCE reports INSTANCE_NUMBER. The
    two usually agree and are not required to. Comparing them directly would
    mark a service offline on the very instance running it."""
    fake_oracle["views"] = {
        "dba_services": TWO_SERVICES,
        # Deliberately skewed: inst_id 1 -> instance_number 7, 2 -> 9.
        "gv$instance": [{"INST_ID": 1, "INSTANCE_NUMBER": 7}, {"INST_ID": 2, "INSTANCE_NUMBER": 9}],
        "gv$active_services": [{"INST_ID": 2, "NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}],
    }
    out = svc.oracle_services(1, None)
    svc_row = next(s for s in out["services"] if s["service_name"] == "ebs_KPATCH")
    assert {i["instance_number"]: i["status"] for i in svc_row["instances"]} == {7: "offline", 9: "online"}


def test_matches_on_network_name_too(fake_oracle):
    """A service created with a different NETWORK_NAME is reported by the
    active views under that name; matching only on NAME would miss it."""
    fake_oracle["views"] = {
        "dba_services": [{"NAME": "KCPRD", "NETWORK_NAME": "KCPRD_KIRAN.paas.oracle.com"}],
        "gv$instance": TWO_INSTANCES,
        "gv$active_services": [
            {"INST_ID": 1, "NAME": "KCPRD_KIRAN.paas.oracle.com", "NETWORK_NAME": "KCPRD_KIRAN.paas.oracle.com"},
            {"INST_ID": 2, "NAME": "KCPRD_KIRAN.paas.oracle.com", "NETWORK_NAME": "KCPRD_KIRAN.paas.oracle.com"},
        ],
    }
    out = svc.oracle_services(1, None)
    assert out["services"][0]["status"] == "online"


def test_case_difference_does_not_make_a_service_offline(fake_oracle):
    fake_oracle["views"] = {
        "dba_services": [{"NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}],
        "gv$instance": TWO_INSTANCES,
        "gv$active_services": [
            {"INST_ID": 1, "NAME": "EBS_KPATCH", "NETWORK_NAME": "EBS_KPATCH"},
            {"INST_ID": 2, "NAME": "EBS_KPATCH", "NETWORK_NAME": "EBS_KPATCH"},
        ],
    }
    out = svc.oracle_services(1, None)
    assert out["services"][0]["status"] == "online"


# ── the bug that made this invisible ───────────────────────────────────────

def test_unreadable_active_services_is_unknown_not_offline(fake_oracle):
    """This is the regression that matters. The original code swallowed the
    exception into an empty list, so a failed read became 'every service is
    offline' — stated with total confidence about an instance it had not
    managed to query."""
    fake_oracle["views"] = {
        "dba_services": TWO_SERVICES,
        "gv$instance": TWO_INSTANCES,
        # Both the GV$ and V$ forms refuse.
        "active_services": Exception("ORA-00942: table or view does not exist"),
    }
    out = svc.oracle_services(1, None)
    assert out["active_read"] is False
    for s in out["services"]:
        assert s["status"] == "unknown", f"{s['service_name']} claimed {s['status']} from a failed read"
        assert all(i["status"] == "unknown" for i in s["instances"])
    assert out["errors"], "the Oracle error must be reported, not swallowed"


def test_falls_back_to_v_dollar_when_gv_is_unavailable(fake_oracle):
    """A single-instance deployment may not expose the GV$ form at all."""
    calls = {"n": 0}

    def rows(engine, sql, params=None):
        low = " ".join(sql.split()).lower()
        if "gv$active_services" in low:
            calls["n"] += 1
            raise Exception("ORA-00942: table or view does not exist")
        if "v$active_services" in low:
            return [{"NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}]
        if "dba_services" in low:
            return [{"NAME": "ebs_KPATCH", "NETWORK_NAME": "ebs_KPATCH"}]
        if "gv$instance" in low:
            raise Exception("ORA-00942: table or view does not exist")
        raise Exception("unexpected: " + low)

    import pytest as _pytest  # noqa: F401  (monkeypatch fixture already applied)
    svc._rows, old = rows, svc._rows
    try:
        out = svc.oracle_services(1, None)
    finally:
        svc._rows = old

    assert calls["n"] == 1, "it should try GV$ first"
    assert out["active_read"] is True
    assert out["services"][0]["status"] == "online"
    assert out["services"][0]["instances"][0]["instance_number"] is None


# ── real service-name forms from the KPATCH instance ───────────────────────
#
# lsnrctl on that host registers these, while DBA_SERVICES holds the bare name:
#
#   DBA_SERVICES          listener / GV$ACTIVE_SERVICES
#   --------------------  -----------------------------------------------------
#   APPLSYS.WF_CONTROL    SYS$APPLSYS.WF_CONTROL.KIRAN.EBSDB.PROD.ORACLEVCN.COM
#   KPATCH                kpatch
#
# An exact match still reports APPLSYS.WF_CONTROL offline while it is plainly
# running, so the names are normalised before comparison.

DOMAIN = "KIRAN.EBSDB.PROD.ORACLEVCN.COM"


def test_aq_workflow_service_matches_its_sys_dollar_registration(fake_oracle):
    fake_oracle["views"] = {
        "dba_services": [{"NAME": "APPLSYS.WF_CONTROL", "NETWORK_NAME": "APPLSYS.WF_CONTROL"}],
        "gv$instance": [{"INST_ID": 1, "INSTANCE_NUMBER": 1}],
        "v$parameter": [{"VALUE": DOMAIN}],
        "gv$active_services": [{
            "INST_ID": 1,
            "NAME": f"SYS$APPLSYS.WF_CONTROL.{DOMAIN}",
            "NETWORK_NAME": f"SYS$APPLSYS.WF_CONTROL.{DOMAIN}",
        }],
    }
    out = svc.oracle_services(1, None)
    assert out["services"][0]["status"] == "online"


def test_lowercase_registration_matches(fake_oracle):
    fake_oracle["views"] = {
        "dba_services": [{"NAME": "KPATCH", "NETWORK_NAME": "KPATCH"}],
        "gv$instance": [{"INST_ID": 1, "INSTANCE_NUMBER": 1}],
        "v$parameter": [{"VALUE": DOMAIN}],
        "gv$active_services": [{"INST_ID": 1, "NAME": "kpatch", "NETWORK_NAME": "kpatch"}],
    }
    out = svc.oracle_services(1, None)
    assert out["services"][0]["status"] == "online"


def test_only_the_real_domain_is_stripped(fake_oracle):
    """KCPRD_KIRAN.paas.oracle.com is a service name that genuinely contains
    dots. Chopping at the first dot — or stripping any suffix — would turn it
    into KCPRD_KIRAN and risk a false match against something unrelated. It is
    not registered on this instance, so it must stay offline."""
    fake_oracle["views"] = {
        "dba_services": [
            {"NAME": "KCPRD_KIRAN.paas.oracle.com", "NETWORK_NAME": "KCPRD_KIRAN.paas.oracle.com"},
            {"NAME": "KCPRD_KIRAN_ro.paas.oracle.com", "NETWORK_NAME": "KCPRD_KIRAN_ro.paas.oracle.com"},
        ],
        "gv$instance": [{"INST_ID": 1, "INSTANCE_NUMBER": 1}],
        "v$parameter": [{"VALUE": DOMAIN}],
        # Only an unrelated KCPRD_KIRAN is up; neither dotted service is.
        "gv$active_services": [{"INST_ID": 1, "NAME": "KCPRD_KIRAN", "NETWORK_NAME": "KCPRD_KIRAN"}],
    }
    out = svc.oracle_services(1, None)
    assert [s["status"] for s in out["services"]] == ["offline", "offline"]


def test_missing_db_domain_strips_nothing(fake_oracle):
    """No db_domain reading must not make matching more aggressive."""
    fake_oracle["views"] = {
        "dba_services": [{"NAME": "APPLSYS.WF_CONTROL", "NETWORK_NAME": "APPLSYS.WF_CONTROL"}],
        "gv$instance": [{"INST_ID": 1, "INSTANCE_NUMBER": 1}],
        "v$parameter": [],
        "gv$active_services": [{"INST_ID": 1, "NAME": "SYS$APPLSYS.WF_CONTROL",
                                "NETWORK_NAME": "SYS$APPLSYS.WF_CONTROL"}],
    }
    out = svc.oracle_services(1, None)
    # The SYS$ prefix alone is still handled; only the domain suffix needs the reading.
    assert out["services"][0]["status"] == "online"
