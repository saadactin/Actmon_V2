-- Oracle AWR Performance Intelligence: normalised metric history, the full
-- findings contract (diagnosis / trend / forecast / risk / recommendation),
-- and stored forecasts with backtest error and later-observed actuals.
-- Additive only — safe to run on a database that already holds reports.

-- Report identity & quality -------------------------------------------------
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS database_key   VARCHAR(120);
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS dbid           VARCHAR(40);
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS db_release     VARCHAR(40);
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS is_rac         BOOLEAN;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS platform       VARCHAR(200);
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS num_cpus       DOUBLE PRECISION;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS host_mem_gb    DOUBLE PRECISION;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS data_quality   JSONB;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS parser_version VARCHAR(40);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_reports_database_key ON oracle_awr_reports (database_key);

-- Findings: the full data contract --------------------------------------------
ALTER TABLE oracle_awr_findings ALTER COLUMN report_id DROP NOT NULL;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS org_id              INTEGER;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS database_key        VARCHAR(120);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS rule_id             VARCHAR(80);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS finding_type        VARCHAR(20) DEFAULT 'diagnosis';
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS source              VARCHAR(20) DEFAULT 'rule';
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS risk_level          VARCHAR(20);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS snapshot_start      TIMESTAMP;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS snapshot_end        TIMESTAMP;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS observed_metrics    JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS baseline_metrics    JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS evidence_refs       JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS probable_causes     JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS recommended_actions JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS forecast_horizon    VARCHAR(60);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS predicted_value     DOUBLE PRECISION;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS prediction_interval JSONB;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS confidence_method   VARCHAR(200);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS data_quality        VARCHAR(30);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS model_version       VARCHAR(60);
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS status              VARCHAR(20) DEFAULT 'open';
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS outcome_note        TEXT;
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS created_at          TIMESTAMP DEFAULT NOW();
ALTER TABLE oracle_awr_findings ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMP DEFAULT NOW();
CREATE INDEX IF NOT EXISTS ix_oracle_awr_findings_org_id       ON oracle_awr_findings (org_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_findings_database_key ON oracle_awr_findings (database_key);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_findings_rule_id      ON oracle_awr_findings (rule_id);

-- Metric history ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oracle_awr_metrics (
    id             SERIAL PRIMARY KEY,
    org_id         INTEGER NOT NULL DEFAULT 1,
    report_id      INTEGER NOT NULL REFERENCES oracle_awr_reports(id) ON DELETE CASCADE,
    database_key   VARCHAR(120),
    metric_key     VARCHAR(80) NOT NULL,
    value          DOUBLE PRECISION NOT NULL,
    unit           VARCHAR(30),
    category       VARCHAR(30),
    label          VARCHAR(200),
    source_section VARCHAR(200),
    interval_start TIMESTAMP,
    interval_end   TIMESTAMP,
    CONSTRAINT uq_awr_metric_per_report UNIQUE (report_id, metric_key)
);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_metrics_org_id       ON oracle_awr_metrics (org_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_metrics_report_id    ON oracle_awr_metrics (report_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_metrics_database_key ON oracle_awr_metrics (database_key);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_metrics_metric_key   ON oracle_awr_metrics (metric_key);

-- Forecasts, kept so later reports can score them -------------------------------
CREATE TABLE IF NOT EXISTS oracle_awr_forecasts (
    id                 SERIAL PRIMARY KEY,
    org_id             INTEGER NOT NULL DEFAULT 1,
    database_key       VARCHAR(120) NOT NULL,
    metric_key         VARCHAR(80) NOT NULL,
    model_version      VARCHAR(60) NOT NULL,
    method             VARCHAR(200) NOT NULL,
    generated_at       TIMESTAMP DEFAULT NOW(),
    based_on_report_id INTEGER REFERENCES oracle_awr_reports(id) ON DELETE SET NULL,
    horizon            VARCHAR(60) NOT NULL,
    target_time        TIMESTAMP NOT NULL,
    predicted_value    DOUBLE PRECISION NOT NULL,
    interval_low       DOUBLE PRECISION,
    interval_high      DOUBLE PRECISION,
    interval_level     DOUBLE PRECISION,
    train_points       INTEGER,
    backtest_points    INTEGER,
    backtest_mae       DOUBLE PRECISION,
    backtest_rmse      DOUBLE PRECISION,
    naive_mae          DOUBLE PRECISION,
    status             VARCHAR(20) NOT NULL DEFAULT 'pending',
    actual_value       DOUBLE PRECISION,
    actual_report_id   INTEGER REFERENCES oracle_awr_reports(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_forecasts_org_id       ON oracle_awr_forecasts (org_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_forecasts_database_key ON oracle_awr_forecasts (database_key);

-- Per-report SQL statistics, merged across the "SQL ordered by …" lists ---------
CREATE TABLE IF NOT EXISTS oracle_awr_sql_stats (
    id                 SERIAL PRIMARY KEY,
    org_id             INTEGER NOT NULL DEFAULT 1,
    report_id          INTEGER NOT NULL REFERENCES oracle_awr_reports(id) ON DELETE CASCADE,
    database_key       VARCHAR(120),
    sql_id             VARCHAR(20) NOT NULL,
    module             VARCHAR(200),
    text_preview       VARCHAR(200),
    elapsed_s          DOUBLE PRECISION,
    executions         DOUBLE PRECISION,
    elapsed_per_exec_s DOUBLE PRECISION,
    pct_db_time        DOUBLE PRECISION,
    cpu_s              DOUBLE PRECISION,
    cpu_pct            DOUBLE PRECISION,
    io_pct             DOUBLE PRECISION,
    buffer_gets        DOUBLE PRECISION,
    gets_per_exec      DOUBLE PRECISION,
    physical_reads     DOUBLE PRECISION,
    reads_per_exec     DOUBLE PRECISION,
    parse_calls        DOUBLE PRECISION,
    rows_processed     DOUBLE PRECISION,
    version_count      DOUBLE PRECISION,
    lists              VARCHAR(120),
    CONSTRAINT uq_awr_sql_per_report UNIQUE (report_id, sql_id)
);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_sql_stats_org_id       ON oracle_awr_sql_stats (org_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_sql_stats_report_id    ON oracle_awr_sql_stats (report_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_sql_stats_database_key ON oracle_awr_sql_stats (database_key);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_sql_stats_sql_id       ON oracle_awr_sql_stats (sql_id);
