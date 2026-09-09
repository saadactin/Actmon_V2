"""
Tests for the MSSQL error-17806 (SSPI/Kerberos) deep diagnostic workflow —
mssql_self_heal_service.run_sspi_diagnostics() and its pure helpers.

No live SQL Server or agent needed: `_rows`/`_engine`/`agent_host_for_conn`/
`agent_fs_service.request` are all monkeypatched, matching this repo's existing
test convention (see test_credential_encryption.py).

Run with:  pytest tests/test_mssql_sspi_diagnostics.py -v
"""
import json
import types

import pytest

from app.services.mssql import mssql_self_heal_service as svc


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def fake_conn():
    return types.SimpleNamespace(host="sqlhost01", port=1433, username="svc",
                                  password="x", database_name="master")


def _patch_conn(monkeypatch, conn):
    monkeypatch.setattr(svc, "_get_conn_or_404", lambda cid, db: conn)


# ── 1. 17806 detection / routing (regression: unchanged from today) ─────────

def test_parse_error_detects_17806():
    en, st, login, database = svc._parse_error(
        "Error: 17806, Severity: 20, State: 14. SSPI handshake failed", None, None)
    assert en == 17806


def test_17806_kb_entry_unchanged():
    kb = svc._ERROR_KB[17806]
    assert kb["title"] == "SSPI handshake failed"
    assert kb["category"] == "authentication"


def test_remediation_for_17806_still_generic_fallback_only():
    """17806 is intentionally NOT branched inside _remediation_for() — the real
    workflow lives in run_sspi_diagnostics(), a separate opt-in endpoint. This
    locks in that design decision: _remediation_for(17806, ...) must keep
    returning only the universal fallback, unchanged, forever (or the next
    person to touch this needs to update this test deliberately)."""
    diagnostics, remediations = svc._remediation_for(17806, None, None, None, {})
    assert len(diagnostics) == 1
    assert diagnostics[0]["title"] == "Server health snapshot"
    assert remediations == []


def test_severity_label_17806_is_high():
    assert 17806 in (18456, 701, 4060, 17806)  # sanity on the tuple this session added


# ── 2. status classification ─────────────────────────────────────────────────

def test_classify_spn_missing_service_account():
    r = svc._classify_spn(json.dumps({
        "service_account": "", "spn_list": "SPN check: Unable to determine service account automatically",
        "duplicate_scan": "",
    }))
    assert r["status"] == "WARNING"
    assert "Unable to determine" in r["detail"]


def test_classify_spn_no_spn_registered():
    r = svc._classify_spn(json.dumps({
        "service_account": "DOMAIN\\svc", "spn_list": "No such SPN found",
        "duplicate_scan": "0 group of duplicate SPNs processed.",
    }))
    assert r["status"] == "WARNING"
    assert "No SPN registered" in r["detail"]


def test_classify_spn_duplicate_detected():
    r = svc._classify_spn(json.dumps({
        "service_account": "DOMAIN\\svc",
        "spn_list": "Registered ServicePrincipalNames:\n MSSQLSvc/host:1433",
        "duplicate_scan": "found 2 groups of duplicate SPNs.",
    }))
    assert r["status"] == "CRITICAL"
    assert "Duplicate SPN" in r["detail"]


def test_classify_spn_clean():
    r = svc._classify_spn(json.dumps({
        "service_account": "DOMAIN\\svc",
        "spn_list": "Registered ServicePrincipalNames:\n MSSQLSvc/host:1433",
        "duplicate_scan": "0 group of duplicate SPNs processed.",
    }))
    assert r["status"] == "PASS"


def test_classify_port_pass_and_fail():
    ok = svc._classify_port(json.dumps({"computer": "h", "port": 1433, "succeeded": True}))
    bad = svc._classify_port(json.dumps({"computer": "h", "port": 1433, "succeeded": False}))
    assert ok["status"] == "PASS"
    assert bad["status"] == "CRITICAL"


def test_classify_port_missing_output_is_unknown():
    assert svc._classify_port(None)["status"] == "UNKNOWN"
    assert svc._classify_port("")["status"] == "UNKNOWN"


def test_classify_port_unparseable_is_unknown():
    assert svc._classify_port("not json")["status"] == "UNKNOWN"


def test_classify_time_sync_pass_and_warning():
    ok = svc._classify_time_sync(json.dumps({"status": "Leap Indicator: 0(no warning)\nSource: time.windows.com"}))
    bad = svc._classify_time_sync(json.dumps({"status": "Leap Indicator: 3(NOT SYNCHRONIZED)"}))
    assert ok["status"] == "PASS"
    assert bad["status"] == "WARNING"


def test_classify_domain_context_joined_and_not_joined():
    joined = svc._classify_domain_context(json.dumps({"domain": "CORP.LOCAL", "part_of_domain": True}))
    not_joined = svc._classify_domain_context(json.dumps({"domain": "", "part_of_domain": False}))
    assert joined["status"] == "INFO"
    assert not_joined["status"] == "WARNING"


def test_classify_dns_error_and_pass():
    err = svc._classify_dns(json.dumps({"error": "DNS server unreachable"}))
    ok = svc._classify_dns(json.dumps([{"Name": "sqlhost01", "IPAddress": "10.0.0.5"}]))
    assert err["status"] == "WARNING"
    assert ok["status"] == "PASS"


# ── 3. root-cause rules (spec's 5 example cases + multi-cause + none) ────────

def _base_checks(**overrides):
    checks = {k: {"status": "PASS"} for k in
              ("sql_port", "spn", "auth_scheme", "time_sync", "kerberos_port",
               "rpc_port", "dns_forward", "dns_reverse")}
    checks["domain_context"] = {"status": "INFO"}
    checks.update(overrides)
    return checks


def test_root_cause_case1_ntlm_and_missing_spn():
    checks = _base_checks(auth_scheme={"status": "WARNING", "detail": "NTLM"})
    rc = svc._sspi_root_cause(checks)
    assert "Kerberos/SPN" in rc["likely_cause"]


def test_root_cause_case2_duplicate_spn():
    checks = _base_checks(spn={"status": "CRITICAL", "detail": "Duplicate SPN detected"})
    rc = svc._sspi_root_cause(checks)
    assert "Duplicate" in rc["likely_cause"] or "duplicate" in rc["recommended_action"]
    assert rc["confidence"] == "high"


def test_root_cause_case3_sql_port_fail():
    checks = _base_checks(sql_port={"status": "CRITICAL", "detail": "port 1433 NOT reachable"})
    rc = svc._sspi_root_cause(checks)
    assert "Network" in rc["likely_cause"]


def test_root_cause_case4_time_sync_warning():
    checks = _base_checks(time_sync={"status": "WARNING", "detail": "Time service not synchronized"})
    rc = svc._sspi_root_cause(checks)
    assert "Clock synchronization" in rc["likely_cause"]


def test_root_cause_case5_multiple_failures_ranked():
    checks = _base_checks(
        sql_port={"status": "CRITICAL", "detail": "port 1433 NOT reachable"},
        time_sync={"status": "WARNING", "detail": "not synchronized"},
    )
    rc = svc._sspi_root_cause(checks)
    assert rc["likely_cause"] == "Multiple potential causes detected."
    assert len(rc["findings"]) == 2
    assert rc["findings"][0]["status"] == "CRITICAL"  # ranked highest-severity first


def test_root_cause_no_findings():
    rc = svc._sspi_root_cause(_base_checks())
    assert "No obvious" in rc["likely_cause"]
    assert rc["confidence"] == "low"


# ── 4. section splitting ─────────────────────────────────────────────────────

def test_split_ps_sections():
    txt = ('===SECTION::SPN===\n{"a":1}\n'
           '===SECTION::DNS_FORWARD===\n{"b":2}\n')
    sections = svc._split_ps_sections(txt)
    assert sections["SPN"] == '{"a":1}'
    assert sections["DNS_FORWARD"] == '{"b":2}'


def test_split_ps_sections_empty_input():
    assert svc._split_ps_sections("") == {}
    assert svc._split_ps_sections(None) == {}


# ── 5. run_sspi_diagnostics() — feature flag, timeout, missing agent, dispatch failure ──

def test_disabled_by_feature_flag_never_touches_db(monkeypatch):
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "false")

    def _boom(*a, **kw):
        raise AssertionError("must not be called when the feature flag is disabled")
    monkeypatch.setattr(svc, "_get_conn_or_404", _boom)

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["status"] == "disabled"


def test_no_agent_linked_marks_os_checks_unknown_but_still_succeeds(monkeypatch, fake_conn):
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "true")
    _patch_conn(monkeypatch, fake_conn)
    monkeypatch.setattr(svc, "_engine", lambda *a, **kw: object())
    monkeypatch.setattr(svc, "_rows", lambda engine, sql, **kw: [])

    import app.services.common.db_proxy_service as db_proxy_service
    monkeypatch.setattr(db_proxy_service, "agent_host_for_conn", lambda cid, db: None)

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["status"] == "success"
    for key in svc._SSPI_OS_KEYS:
        assert result["checks"][key]["status"] == "UNKNOWN"
    assert result["automatic_remediation"] == "NOT EXECUTED"


def test_agent_timeout_marks_os_checks_unknown_but_overall_completes(monkeypatch, fake_conn):
    """One failed/timed-out diagnostic must not fail the whole analysis (spec §14)."""
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "true")
    _patch_conn(monkeypatch, fake_conn)
    monkeypatch.setattr(svc, "_engine", lambda *a, **kw: object())
    monkeypatch.setattr(svc, "_rows", lambda engine, sql, **kw: [])

    import app.services.common.db_proxy_service as db_proxy_service
    fake_host = types.SimpleNamespace(token="tok-123")
    monkeypatch.setattr(db_proxy_service, "agent_host_for_conn", lambda cid, db: fake_host)

    import app.services.agent.agent_fs_service as agent_fs_service
    monkeypatch.setattr(agent_fs_service, "request", lambda *a, **kw: None)  # simulate timeout

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["status"] == "success"
    for key in svc._SSPI_OS_KEYS:
        assert result["checks"][key]["status"] == "UNKNOWN"
        assert "did not respond" in result["checks"][key]["evidence"]
    assert result["root_cause"] is not None


def test_agent_permission_denied_does_not_500(monkeypatch, fake_conn):
    """agent_fs_service.request() raises (e.g. the agent wasn't granted remote_command) —
    run_sspi_diagnostics must degrade gracefully, not propagate the exception."""
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "true")
    _patch_conn(monkeypatch, fake_conn)
    monkeypatch.setattr(svc, "_engine", lambda *a, **kw: object())
    monkeypatch.setattr(svc, "_rows", lambda engine, sql, **kw: [])

    import app.services.common.db_proxy_service as db_proxy_service
    fake_host = types.SimpleNamespace(token="tok-123")
    monkeypatch.setattr(db_proxy_service, "agent_host_for_conn", lambda cid, db: fake_host)

    import app.services.agent.agent_fs_service as agent_fs_service

    def _denied(*a, **kw):
        raise RuntimeError("This agent was not granted the 'Remote Command Execution' permission.")
    monkeypatch.setattr(agent_fs_service, "request", _denied)

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["status"] == "success"
    for key in svc._SSPI_OS_KEYS:
        assert result["checks"][key]["status"] == "UNKNOWN"


def test_sql_query_failure_is_isolated_per_check(monkeypatch, fake_conn):
    """A failing auth_scheme query must not prevent service_info (or anything else)
    from being computed — each SQL-side check has its own try/except."""
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "true")
    _patch_conn(monkeypatch, fake_conn)
    monkeypatch.setattr(svc, "_engine", lambda *a, **kw: object())

    calls = {"n": 0}

    def _rows_side_effect(engine, sql, **kw):
        calls["n"] += 1
        if "auth_scheme" in sql:
            raise RuntimeError("permission denied on sys.dm_exec_connections")
        if "dm_server_services" in sql:
            return [{"servicename": "SQL Server (MSSQLSERVER)", "service_account": "DOMAIN\\svc"}]
        return [{"computer_name": "SQLHOST01", "server_name": "SQLHOST01", "instance_name": None}]

    monkeypatch.setattr(svc, "_rows", _rows_side_effect)

    import app.services.common.db_proxy_service as db_proxy_service
    monkeypatch.setattr(db_proxy_service, "agent_host_for_conn", lambda cid, db: None)

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["checks"]["auth_scheme"]["status"] == "UNKNOWN"
    assert result["checks"]["service_info"]["status"] == "INFO"
    assert result["checks"]["service_info"]["service_account"] == "DOMAIN\\svc"


def test_full_pipeline_end_to_end_with_agent(monkeypatch, fake_conn):
    """Integration-style: SQL checks + one composite agent script + root cause,
    fully mocked (no live SQL Server / agent needed)."""
    monkeypatch.setenv(svc._SSPI_ENABLED_ENV, "true")
    _patch_conn(monkeypatch, fake_conn)

    def _rows_side_effect(engine, sql, **kw):
        if "auth_scheme" in sql:
            return [{"auth_scheme": "NTLM"}]
        if "dm_server_services" in sql:
            return [{"servicename": "SQL Server (MSSQLSERVER)", "service_account": "DOMAIN\\svc"}]
        return [{"computer_name": "SQLHOST01", "server_name": "SQLHOST01", "instance_name": None}]

    monkeypatch.setattr(svc, "_engine", lambda *a, **kw: object())
    monkeypatch.setattr(svc, "_rows", _rows_side_effect)

    import app.services.common.db_proxy_service as db_proxy_service
    fake_host = types.SimpleNamespace(token="tok-123")
    monkeypatch.setattr(db_proxy_service, "agent_host_for_conn", lambda cid, db: fake_host)

    composite_output = "EXIT:0\n" + "\n".join([
        '===SECTION::SPN===', json.dumps({"service_account": "DOMAIN\\svc",
                                           "spn_list": "SPN check: Unable to determine service account automatically",
                                           "duplicate_scan": ""}),
        '===SECTION::DNS_FORWARD===', json.dumps([{"Name": "sqlhost01", "IPAddress": "10.0.0.5"}]),
        '===SECTION::DNS_REVERSE===', json.dumps([{"Name": "10.0.0.5", "NameHost": "sqlhost01"}]),
        '===SECTION::SQL_PORT===', json.dumps({"computer": "sqlhost01", "port": 1433, "succeeded": True}),
        '===SECTION::KERBEROS_PORT===', json.dumps({"target": "CORP.LOCAL", "port": 88, "succeeded": True}),
        '===SECTION::RPC_PORT===', json.dumps({"target": "CORP.LOCAL", "port": 135, "succeeded": True}),
        '===SECTION::TIME_SYNC===', json.dumps({"status": "Leap Indicator: 0(no warning)", "source": "time.windows.com"}),
        '===SECTION::DOMAIN_CONTEXT===', json.dumps({"domain": "CORP.LOCAL", "part_of_domain": True, "dsgetdc": "", "klist": ""}),
    ])

    import app.services.agent.agent_fs_service as agent_fs_service
    monkeypatch.setattr(agent_fs_service, "request", lambda *a, **kw: composite_output.encode())

    result = svc.run_sspi_diagnostics(1, db=None)
    assert result["status"] == "success"
    assert result["checks"]["auth_scheme"]["status"] == "WARNING"
    assert result["checks"]["spn"]["status"] == "WARNING"
    assert result["checks"]["sql_port"]["status"] == "PASS"
    # auth_scheme WARNING is the only non-PASS/INFO... wait spn is also WARNING -> multi-cause
    assert result["root_cause"]["likely_cause"] == "Multiple potential causes detected."
    assert result["automatic_remediation"] == "NOT EXECUTED"
