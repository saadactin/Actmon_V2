"""Metric extraction and single-report diagnosis on AWR-shaped input."""
from app.services.oracle import oracle_awr_service as svc
from app.services.oracle.awr.diagnosis import diagnose
from app.services.oracle.awr.metrics import extract
from app.services.oracle.awr.parser import ProductionAWRParser

from tests.awr_fixtures import build_awr


def _run(**kw):
    parser = ProductionAWRParser(build_awr(**kw))
    ex = extract(parser)
    return ex, diagnose(ex, parser.parse_all(), parser.summary_tables())


# ── metrics ────────────────────────────────────────────────────────────────
def test_core_metrics_are_measured_and_normalised():
    ex, _ = _run()
    assert ex.facts.dbid == "1111111111" and ex.facts.release == "19.0.0.0.0" and ex.facts.rac is False
    assert ex.facts.instance_number == "1" and ex.facts.num_cpus == 16
    assert ex.get("aas") == 10.0  # 600 min DB time / 60 min elapsed
    assert ex.get("db_cpu_util_pct") == 4.5 / 16 * 100
    assert ex.get("host_cpu_busy_pct") == 30.0  # 300k / (300k + 700k)
    assert ex.get("wait_class_commit_pct") == 35.0
    assert ex.get("log_file_sync_ms") == 150.0
    assert ex.get("single_block_read_ms") == 0.8  # "800.00us", not 800 ms


def test_every_metric_names_its_source_table():
    ex, _ = _run()
    assert ex.metrics and all(m.source for m in ex.metrics)


def test_missing_section_produces_no_metric_and_is_reported():
    ex, _ = _run(drop=("os", "classes"))
    assert ex.get("host_cpu_busy_pct") is None  # not 0, not estimated
    assert ex.get("wait_class_commit_pct") is None
    assert "Operating system statistics" in ex.data_quality["missing_sections"]
    assert "Foreground wait classes" in ex.data_quality["missing_sections"]
    assert ex.data_quality["level"] != "complete"


# ── diagnosis ──────────────────────────────────────────────────────────────
def test_slow_commits_diagnosed_with_evidence_actions_validation_and_rollback():
    _, findings = _run()
    f = next(f for f in findings if f.rule_id == "commit_latency")
    assert f.severity == "HIGH" and f.finding_type == "diagnosis"
    assert f.observed["log_file_sync_ms"]["value"] == 150.0
    assert any(r["metric_key"] == "log_file_sync_ms" for r in f.refs)
    assert f.causes and all({"action", "validation", "rollback"} <= set(a) for a in f.actions)
    assert "≥ 100 ms" in f.rule  # the threshold it applied is stated


def test_fast_commits_are_not_flagged():
    _, findings = _run(lfs="2.00ms", commit_pct="35.0")
    assert not any(f.rule_id == "commit_latency" for f in findings)


def test_sql_is_judged_by_share_of_db_time_not_absolute_seconds():
    # 3,240 s of 36,000 s DB time = 9% -> MEDIUM, CPU-heavy (95% CPU)
    _, findings = _run()
    f = next(f for f in findings if f.rule_id == "sql:abc123def4567")
    assert f.severity == "MEDIUM" and f.title.startswith("CPU-heavy SQL")
    assert f.observed["share_of_db_time_pct"] == 9.0
    # the 30 s statement is 0.08% of DB time: not a finding
    assert not any(f.rule_id == "sql:zzz999yyy8887" for f in findings)


def test_db_cpu_is_not_reported_as_a_wait_event():
    _, findings = _run()
    assert not any("DB CPU" in f.title for f in findings)


def test_low_soft_parse_ratio_flags_excessive_parsing():
    _, findings = _run(soft="80.00")
    assert any(f.rule_id == "excessive_parsing" for f in findings)


def test_host_cpu_pressure_bands():
    _, findings = _run(busy="900,000", idle="100,000")  # 90% busy
    assert next(f for f in findings if f.rule_id == "cpu_pressure").severity == "HIGH"


# ── ingestion guard ────────────────────────────────────────────────────────
class _Row:
    org_id, id, status, error_message = 1, 1, "PENDING", None


def test_non_awr_html_fails_instead_of_passing_as_healthy():
    row = _Row()
    svc._parse_and_record(row, "<html><body><table><tr><td>hello</td></tr></table></body></html>", db=None)
    assert row.status == "FAILED" and "Not an Oracle AWR" in row.error_message


def test_database_key_separates_rac_instances_only():
    class F:  # minimal facts
        dbid, instance_number, rac = "42", "2", True
    assert svc.database_key(F, "X") == "42:2"
    F.rac = False
    assert svc.database_key(F, "X") == "42"
