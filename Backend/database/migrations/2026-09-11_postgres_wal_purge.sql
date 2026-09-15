-- Purge WAL Archive feature — postgres_wal_purge_config / postgres_wal_purge_history.
-- Idempotent (IF NOT EXISTS throughout); see install/schema.sql for the same
-- blocks kept in sync for fresh installs.

CREATE TABLE IF NOT EXISTS public.postgres_wal_purge_config (
    id                        SERIAL PRIMARY KEY,
    org_id                    INTEGER      NOT NULL DEFAULT 1,
    conn_id                   INTEGER      NOT NULL REFERENCES public.connection_master(id),
    os_server_id              INTEGER      REFERENCES public.os_servers(id),

    archive_dir               VARCHAR(500) NOT NULL,
    cleanup_binary            VARCHAR(500) DEFAULT 'pg_archivecleanup',
    cleanup_method            VARCHAR(30)  NOT NULL DEFAULT 'pg_archivecleanup',

    retention_preset          VARCHAR(20)  NOT NULL DEFAULT '7d',
    retention_days            INTEGER      NOT NULL DEFAULT 7,
    require_standby_ok        BOOLEAN      NOT NULL DEFAULT true,
    max_standby_lag_mb        INTEGER      NOT NULL DEFAULT 1024,

    frequency                 VARCHAR(20)  NOT NULL DEFAULT 'daily',
    hour                      INTEGER      NOT NULL DEFAULT 2,
    minute                    INTEGER      NOT NULL DEFAULT 30,
    day_of_week               INTEGER      NOT NULL DEFAULT 0,
    day_of_month              INTEGER      NOT NULL DEFAULT 1,

    enabled                   BOOLEAN      NOT NULL DEFAULT false,
    scheduler_type            VARCHAR(20),
    scheduler_entry_name      VARCHAR(120),
    callback_base_url         VARCHAR(300),
    missed_grace_minutes      INTEGER      NOT NULL DEFAULT 15,

    trigger_token_hash        VARCHAR(64),
    trigger_token_created_at  TIMESTAMP,

    schedule_present          BOOLEAN,
    schedule_verified_at      TIMESTAMP,

    next_run_at               TIMESTAMP,
    last_run_at               TIMESTAMP,
    last_status               VARCHAR(20),
    last_error                TEXT,
    last_files_purged         INTEGER,
    last_space_reclaimed_bytes BIGINT,
    last_safety_state         VARCHAR(20),

    created_by                INTEGER,
    created_at                TIMESTAMP DEFAULT now(),
    updated_by                INTEGER,
    updated_at                TIMESTAMP DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_wal_purge_cfg_conn ON public.postgres_wal_purge_config (conn_id);
CREATE INDEX IF NOT EXISTS idx_pg_wal_purge_cfg_org ON public.postgres_wal_purge_config (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_wal_purge_cfg_token
    ON public.postgres_wal_purge_config (trigger_token_hash) WHERE trigger_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pg_wal_purge_cfg_due
    ON public.postgres_wal_purge_config (next_run_at) WHERE enabled;


CREATE TABLE IF NOT EXISTS public.postgres_wal_purge_history (
    id                     BIGSERIAL PRIMARY KEY,
    org_id                 INTEGER      NOT NULL DEFAULT 1,
    conn_id                INTEGER      NOT NULL REFERENCES public.connection_master(id),
    config_id              INTEGER      REFERENCES public.postgres_wal_purge_config(id),

    run_type               VARCHAR(20)  NOT NULL,
    trigger_source         VARCHAR(30),
    status                 VARCHAR(20)  NOT NULL DEFAULT 'running',

    safety_state           VARCHAR(20),
    safe_boundary_wal      VARCHAR(24),
    retention_cutoff_wal   VARCHAR(24),
    replication_cutoff_wal VARCHAR(24),
    binding_cutoff         VARCHAR(20),
    retention_days         INTEGER,
    archive_dir            VARCHAR(500),

    files_before           INTEGER,
    files_after            INTEGER,
    files_purged           INTEGER,
    files_matched          INTEGER,

    bytes_before           BIGINT,
    bytes_after            BIGINT,
    space_reclaimed_bytes  BIGINT,
    estimated_bytes        BIGINT,

    exit_code              INTEGER,
    command_text           TEXT,

    started_at             TIMESTAMP NOT NULL DEFAULT now(),
    finished_at            TIMESTAMP,
    duration_ms            INTEGER,
    error_message          TEXT,
    details                JSONB,

    user_id                INTEGER,
    created_at             TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pg_wal_purge_hist_conn_started
    ON public.postgres_wal_purge_history (conn_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pg_wal_purge_hist_status ON public.postgres_wal_purge_history (status);
CREATE INDEX IF NOT EXISTS idx_pg_wal_purge_hist_org ON public.postgres_wal_purge_history (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pg_wal_purge_running
    ON public.postgres_wal_purge_history (conn_id) WHERE status = 'running';
