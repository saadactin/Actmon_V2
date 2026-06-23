-- ─────────────────────────────────────────────────────────────────────────────
--  Multi-tenancy: add org_id to every table that lacks it.
--  DEFAULT 1 backfills existing rows and stamps org 1 when not supplied.
--  Safe / idempotent (ADD COLUMN IF NOT EXISTS). Applied 2026-06-23.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE public.agent_metrics            ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agent_notifications      ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agent_oracle_snapshots   ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agent_snapshots          ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agent_top_sql            ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agent_wait_events        ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.agents                   ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.backup_jobs              ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.backup_schedules         ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.connection_master        ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.database_instances       ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.mysql_report_schedules   ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.oracle_report_schedules  ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.os_servers               ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.password_history         ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.permission               ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.postgres_report_schedules ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.smtp_configs             ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.status_master            ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.user_session             ADD COLUMN IF NOT EXISTS org_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_os_servers_org_id        ON public.os_servers (org_id);
CREATE INDEX IF NOT EXISTS idx_connection_master_org_id ON public.connection_master (org_id);
CREATE INDEX IF NOT EXISTS idx_database_instances_org_id ON public.database_instances (org_id);
CREATE INDEX IF NOT EXISTS idx_agents_org_id            ON public.agents (org_id);

COMMIT;
