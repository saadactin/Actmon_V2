-- Bring the live DB up to date with the ORM models. Both sets of columns exist in
-- install/schema.sql (the canonical fresh-install schema) but were never added to
-- databases created before them, so every SELECT on these two tables failed with
-- UndefinedColumn — breaking agent_collector, PGScheduler and ResColl on every tick.
--
-- All columns are nullable and additive: no data is rewritten or dropped.
-- Apply with:
--   psql -h localhost -U migration_user -d actmon -f 2026-07-29_add_agent_last_error_and_cloud_columns.sql

BEGIN;

-- app/models/agent_model.py :: Agent.last_error
ALTER TABLE public.agents
    ADD COLUMN IF NOT EXISTS last_error text;

-- app/models/connection_model.py :: ConnectionMaster cloud-based database fields.
-- cloud_primary_key_enc / cloud_secondary_key_enc / cloud_monitor_client_secret_enc
-- hold values encrypted by app/services/common/crypto_service.py.
ALTER TABLE public.connection_master
    ADD COLUMN IF NOT EXISTS cloud_provider                  character varying(50),
    ADD COLUMN IF NOT EXISTS cloud_api_type                  character varying(30),
    ADD COLUMN IF NOT EXISTS cloud_account_name              character varying(255),
    ADD COLUMN IF NOT EXISTS cloud_endpoint                  character varying(500),
    ADD COLUMN IF NOT EXISTS cloud_primary_key_enc           text,
    ADD COLUMN IF NOT EXISTS cloud_secondary_key_enc         text,
    ADD COLUMN IF NOT EXISTS cloud_container_name            character varying(255),
    ADD COLUMN IF NOT EXISTS cloud_partition_key             character varying(255),
    ADD COLUMN IF NOT EXISTS cloud_config                    jsonb,
    ADD COLUMN IF NOT EXISTS cloud_monitor_client_secret_enc text;

COMMIT;
