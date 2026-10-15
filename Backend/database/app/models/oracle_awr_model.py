from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB

from app.database.base import Base


class OracleAwrReport(Base):
    """One uploaded AWR HTML report, parsed and summarized.

    Scoped to an organisation. AWR data describes a database, not a cloud
    account, so this is not tied to CloudAccount; the link to a monitored
    ConnectionMaster row is optional, because the report names its own
    database and many are pulled from databases not registered here.

    database_key groups reports of the same database (DBID, plus the instance
    number on RAC) — history, trends and forecasts never mix databases.
    """

    __tablename__ = "oracle_awr_reports"

    id = Column(Integer, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, index=True, default=1)
    connection_id = Column(Integer, ForeignKey("connection_master.id"), nullable=True, index=True)  # optional link to a monitored DB

    batch_id = Column(String(64), nullable=True, index=True)  # groups files from one batch upload
    original_filename = Column(String(500), nullable=False)
    stored_path = Column(String(1000), nullable=False)
    file_size_bytes = Column(Integer, nullable=True)
    file_sha256 = Column(String(64), nullable=True, index=True)  # duplicate-upload detection

    database_key = Column(String(120), nullable=True, index=True)
    db_name = Column(String(200), nullable=True)
    dbid = Column(String(40), nullable=True)
    db_release = Column(String(40), nullable=True)
    is_rac = Column(Boolean, nullable=True)
    platform = Column(String(200), nullable=True)
    num_cpus = Column(Float, nullable=True)
    host_mem_gb = Column(Float, nullable=True)
    instance_name = Column(String(200), nullable=True)
    instance_number = Column(String(20), nullable=True)
    host_name = Column(String(300), nullable=True)
    begin_snap = Column(String(50), nullable=True)
    end_snap = Column(String(50), nullable=True)
    begin_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    elapsed_minutes = Column(Float, nullable=True)
    db_time_minutes = Column(Float, nullable=True)

    status = Column(String(20), nullable=False, default="PENDING")  # PENDING|PARSED|FAILED
    error_message = Column(Text, nullable=True)
    data_quality = Column(JSONB, nullable=True)  # sections present/missing, metric count, level
    parser_version = Column(String(40), nullable=True)

    high_findings = Column(Integer, default=0)
    medium_findings = Column(Integer, default=0)
    low_findings = Column(Integer, default=0)

    uploaded_by = Column(String(200), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    parsed_at = Column(DateTime, nullable=True)


class OracleAwrMetric(Base):
    """One normalised measurement from one report (per-second rates, % shares,
    latencies), with the AWR table it was read from. Never estimated."""

    __tablename__ = "oracle_awr_metrics"
    __table_args__ = (UniqueConstraint("report_id", "metric_key", name="uq_awr_metric_per_report"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, index=True, default=1)
    report_id = Column(Integer, ForeignKey("oracle_awr_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    database_key = Column(String(120), nullable=True, index=True)
    metric_key = Column(String(80), nullable=False, index=True)
    value = Column(Float, nullable=False)
    unit = Column(String(30), nullable=True)
    category = Column(String(30), nullable=True)
    label = Column(String(200), nullable=True)
    source_section = Column(String(200), nullable=True)
    interval_start = Column(DateTime, nullable=True)
    interval_end = Column(DateTime, nullable=True)


class OracleAwrFinding(Base):
    """A result about a database: a diagnosis from one report, a trend across
    reports, a forecast, a risk, or a recommended action.

    finding_type says which; report_id anchors it to the report it came from
    (for trend/forecast results, the latest report in the series)."""

    __tablename__ = "oracle_awr_findings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(Integer, ForeignKey("oracle_awr_reports.id"), nullable=True, index=True)
    org_id = Column(Integer, nullable=True, index=True)
    database_key = Column(String(120), nullable=True, index=True)
    rule_id = Column(String(80), nullable=True, index=True)  # stable id of the rule/model that produced it

    finding_type = Column(String(20), nullable=True, default="diagnosis")  # diagnosis|trend|forecast|risk|recommendation
    source = Column(String(20), nullable=True, default="rule")  # rule|statistics|llm
    severity = Column(String(20), nullable=False)  # HIGH|MEDIUM|LOW|INFO
    risk_level = Column(String(20), nullable=True)
    category = Column(String(100), nullable=False)
    title = Column(String(500), nullable=False)
    evidence = Column(Text, nullable=True)
    recommendation = Column(Text, nullable=True)

    snapshot_start = Column(DateTime, nullable=True)
    snapshot_end = Column(DateTime, nullable=True)
    observed_metrics = Column(JSONB, nullable=True)
    baseline_metrics = Column(JSONB, nullable=True)
    evidence_refs = Column(JSONB, nullable=True)  # [{report_id, section, metric_key|sql_id|event}]
    probable_causes = Column(JSONB, nullable=True)
    recommended_actions = Column(JSONB, nullable=True)  # [{action, rationale, validation, rollback, risk}]
    forecast_horizon = Column(String(60), nullable=True)
    predicted_value = Column(Float, nullable=True)
    prediction_interval = Column(JSONB, nullable=True)  # {low, high, level}
    confidence_method = Column(String(200), nullable=True)
    data_quality = Column(String(30), nullable=True)
    model_version = Column(String(60), nullable=True)
    status = Column(String(20), nullable=True, default="open")  # open|acknowledged|resolved
    outcome_note = Column(Text, nullable=True)  # remediation outcome, written by the DBA

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class OracleAwrForecast(Base):
    """A stored forecast for one metric of one database, kept after the fact so
    a later report covering target_time can record the actual value."""

    __tablename__ = "oracle_awr_forecasts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, index=True, default=1)
    database_key = Column(String(120), nullable=False, index=True)
    metric_key = Column(String(80), nullable=False)
    model_version = Column(String(60), nullable=False)
    method = Column(String(200), nullable=False)
    generated_at = Column(DateTime, default=datetime.utcnow)
    based_on_report_id = Column(Integer, ForeignKey("oracle_awr_reports.id", ondelete="SET NULL"), nullable=True)
    horizon = Column(String(60), nullable=False)  # e.g. "next 08:30 window"
    target_time = Column(DateTime, nullable=False)
    predicted_value = Column(Float, nullable=False)
    interval_low = Column(Float, nullable=True)
    interval_high = Column(Float, nullable=True)
    interval_level = Column(Float, nullable=True)  # 0.8 = 80% prediction interval
    train_points = Column(Integer, nullable=True)
    backtest_points = Column(Integer, nullable=True)
    backtest_mae = Column(Float, nullable=True)
    backtest_rmse = Column(Float, nullable=True)
    naive_mae = Column(Float, nullable=True)  # same backtest for a last-value baseline
    status = Column(String(20), nullable=False, default="pending")  # pending|observed|superseded
    actual_value = Column(Float, nullable=True)
    actual_report_id = Column(Integer, ForeignKey("oracle_awr_reports.id", ondelete="SET NULL"), nullable=True)


class OracleAwrSqlStat(Base):
    """One statement's figures in one report, merged across the AWR "SQL ordered
    by …" lists. AWR HTML carries no plan hash values, so plan changes cannot
    be detected from these rows — only elapsed-per-execution regressions."""

    __tablename__ = "oracle_awr_sql_stats"
    __table_args__ = (UniqueConstraint("report_id", "sql_id", name="uq_awr_sql_per_report"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    org_id = Column(Integer, nullable=False, index=True, default=1)
    report_id = Column(Integer, ForeignKey("oracle_awr_reports.id", ondelete="CASCADE"), nullable=False, index=True)
    database_key = Column(String(120), nullable=True, index=True)
    sql_id = Column(String(20), nullable=False, index=True)
    module = Column(String(200), nullable=True)
    text_preview = Column(String(200), nullable=True)  # untrusted; display only, never executed or sent to an LLM
    elapsed_s = Column(Float, nullable=True)
    executions = Column(Float, nullable=True)
    elapsed_per_exec_s = Column(Float, nullable=True)
    pct_db_time = Column(Float, nullable=True)
    cpu_s = Column(Float, nullable=True)
    cpu_pct = Column(Float, nullable=True)
    io_pct = Column(Float, nullable=True)
    buffer_gets = Column(Float, nullable=True)
    gets_per_exec = Column(Float, nullable=True)
    physical_reads = Column(Float, nullable=True)
    reads_per_exec = Column(Float, nullable=True)
    parse_calls = Column(Float, nullable=True)
    rows_processed = Column(Float, nullable=True)
    version_count = Column(Float, nullable=True)
    lists = Column(String(120), nullable=True)  # which AWR lists it appeared in
