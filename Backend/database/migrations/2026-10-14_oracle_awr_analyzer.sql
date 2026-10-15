-- Oracle AWR Analyzer: persisted reports + rule-engine findings.
-- Reports are org-scoped; connection_id optionally links one to a monitored
-- Oracle connection (connection_master). An AWR report names its own database,
-- so most uploads need no link at all.

CREATE TABLE IF NOT EXISTS oracle_awr_reports (
    id                  SERIAL PRIMARY KEY,
    org_id              INTEGER NOT NULL DEFAULT 1,
    connection_id       INTEGER REFERENCES connection_master(id),  -- optional: the report names its own DB
    batch_id            VARCHAR(64),
    original_filename   VARCHAR(500) NOT NULL,
    stored_path         VARCHAR(1000) NOT NULL,
    file_size_bytes     INTEGER,
    db_name             VARCHAR(200),
    instance_name       VARCHAR(200),
    instance_number     VARCHAR(20),
    host_name           VARCHAR(300),
    begin_snap          VARCHAR(50),
    end_snap            VARCHAR(50),
    elapsed_minutes     DOUBLE PRECISION,
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    error_message       TEXT,
    high_findings       INTEGER DEFAULT 0,
    medium_findings     INTEGER DEFAULT 0,
    low_findings        INTEGER DEFAULT 0,
    uploaded_by         VARCHAR(200),
    created_at          TIMESTAMP DEFAULT NOW(),
    parsed_at           TIMESTAMP
);

-- Snapshot window read from the report body ("Begin Snap: ... DB Time: ...").
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS begin_time      TIMESTAMP;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS end_time        TIMESTAMP;
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS db_time_minutes DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS ix_oracle_awr_reports_org_id ON oracle_awr_reports (org_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_reports_connection_id ON oracle_awr_reports (connection_id);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_reports_batch_id ON oracle_awr_reports (batch_id);

CREATE TABLE IF NOT EXISTS oracle_awr_findings (
    id              SERIAL PRIMARY KEY,
    report_id       INTEGER NOT NULL REFERENCES oracle_awr_reports(id) ON DELETE CASCADE,
    severity        VARCHAR(20) NOT NULL,
    category        VARCHAR(100) NOT NULL,
    title           VARCHAR(500) NOT NULL,
    evidence        TEXT,
    recommendation  TEXT
);

CREATE INDEX IF NOT EXISTS ix_oracle_awr_findings_report_id ON oracle_awr_findings (report_id);


-- Reports are org-scoped; linking to a monitored connection is optional
-- (an AWR report identifies its own database, often one not registered here).
ALTER TABLE oracle_awr_reports ALTER COLUMN connection_id DROP NOT NULL;

-- Content fingerprint, so re-uploading the same report is refused rather than duplicated.
ALTER TABLE oracle_awr_reports ADD COLUMN IF NOT EXISTS file_sha256 VARCHAR(64);
CREATE INDEX IF NOT EXISTS ix_oracle_awr_reports_file_sha256 ON oracle_awr_reports (file_sha256);
