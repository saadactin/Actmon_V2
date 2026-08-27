"""
ActMon DB provisioning - run by the installer under the backend venv (has psycopg2).

Idempotent. Given an empty PostgreSQL server it will:
  1. CREATE DATABASE <DB_NAME> if it doesn't exist.
  2. Apply schema.sql   (tables, views incl. vw_access_control_page_permission,
     stored procedures, triggers, sequences) - only on a fresh DB.
  3. Apply config_seed.sql (canonical app config: permission bits, modules,
     the full page_master route registry, status_master) - only if unseeded.
  4. Baseline tenant seed: organization #1, the Super Admin role (#1), and grant
     that role FULL permissions on every page. (The admin employee + user are
     created later by the first-run wizard.)

Reads DB config from the backend .env (DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME),
overridable by real environment variables. Prints a step-by-step log and a JSON
summary line prefixed with 'SUMMARY_JSON:' that the orchestrator parses.

Usage:  python install/db_setup.py            (from Backend/database)
Env:    ORG_NAME  - organization #1 display name (default 'Default Organization')
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # Backend/database/install
BACKEND = HERE.parent                            # Backend/database
SCHEMA_SQL = HERE / "schema.sql"
CONFIG_ROOTS_SQL = HERE / "config_roots.sql"   # status_master + permission (no FKs)
CONFIG_PAGES_SQL = HERE / "config_pages.sql"   # module_master + page_master (FK -> org)

SUPER_ADMIN_ROLE_ID = 1
DEFAULT_ORG_ID = 1


def log(step, msg):
    print(f"  [{step}] {msg}", flush=True)


def _load_env():
    """Read Backend/database/.env into a dict (real env vars win)."""
    cfg = {}
    env_file = BACKEND / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    get = lambda k, d: os.getenv(k, cfg.get(k, d))
    return {
        "host": get("DB_HOST", "localhost"),
        "port": get("DB_PORT", "5432"),
        "user": get("DB_USER", "sa"),
        "password": get("DB_PASS", ""),
        "dbname": get("DB_NAME", "actmon"),
        "org_name": get("ORG_NAME", "Default Organization"),
        "admin_email": get("ADMIN_EMAIL", "admin@localhost"),
    }


def _connect(cfg, dbname, autocommit=True):
    import psycopg2
    conn = psycopg2.connect(host=cfg["host"], port=cfg["port"], user=cfg["user"],
                            password=cfg["password"], dbname=dbname, connect_timeout=15)
    conn.autocommit = autocommit
    return conn


def _clean_sql(text):
    """Strip pg_dump 17 psql meta-commands (\\restrict/\\unrestrict) and the
    CREATE EXTENSION line (optional; applied separately & tolerantly)."""
    kept, extensions = [], []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("\\"):                       # psql meta-command
            continue
        if s.upper().startswith("CREATE EXTENSION"):
            extensions.append(line)
            continue
        kept.append(line)
    return "\n".join(kept), extensions


def create_database(cfg):
    import psycopg2
    try:
        conn = _connect(cfg, "postgres")
    except psycopg2.OperationalError as e:
        raise SystemExit(f"ERROR: cannot reach PostgreSQL at {cfg['host']}:{cfg['port']} "
                         f"as user '{cfg['user']}'. Check the server and .env credentials.\n  {e}")
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (cfg["dbname"],))
        exists = cur.fetchone() is not None
        if exists:
            log("db", f"database '{cfg['dbname']}' already exists - reusing")
        else:
            cur.execute(f'CREATE DATABASE "{cfg["dbname"]}"')
            log("db", f"created database '{cfg['dbname']}'")
    conn.close()
    return exists


def _set_public(conn):
    """pg_dump scripts reset search_path to '' for the session - restore it so our
    own unqualified queries resolve against the public schema."""
    with conn.cursor() as cur:
        cur.execute("SET search_path TO public")


def _table_exists(conn, name):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s)", (f"public.{name}",))
        return cur.fetchone()[0] is not None


def _count(conn, name):
    with conn.cursor() as cur:
        cur.execute(f'SELECT COUNT(*) FROM "{name}"')
        return cur.fetchone()[0]


# Idempotent column additions for databases created from OLDER schema.sql versions.
# apply_schema() skips entirely when the schema pre-exists, so new columns the code
# depends on must be patched in here (ADD COLUMN IF NOT EXISTS = safe to run always).
_SCHEMA_PATCHES = [
    # Sales / onboarding registration fields (organization_master)
    """ALTER TABLE organization_master
         ADD COLUMN IF NOT EXISTS cin_number                  VARCHAR(50),
         ADD COLUMN IF NOT EXISTS industry                    VARCHAR(255),
         ADD COLUMN IF NOT EXISTS contact_person_designation  VARCHAR(255),
         ADD COLUMN IF NOT EXISTS contact_person_email        VARCHAR(255),
         ADD COLUMN IF NOT EXISTS contact_person_no           VARCHAR(50)""",
    # Stable-facts store (metrics pipeline) — guaranteed here in case the app's
    # create_all didn't run on this database.
    """CREATE TABLE IF NOT EXISTS agent_stable_facts (
         id          SERIAL PRIMARY KEY,
         agent_name  VARCHAR(255) UNIQUE NOT NULL,
         kind        VARCHAR(20)  DEFAULT 'database',
         tech        VARCHAR(40)  DEFAULT '',
         conn_id     INTEGER      DEFAULT 0,
         facts       TEXT         NOT NULL,
         sha         VARCHAR(40)  NOT NULL,
         updated_at  TIMESTAMPTZ  DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS agent_stable_changes (
         id          SERIAL PRIMARY KEY,
         ts          TIMESTAMPTZ  DEFAULT now(),
         agent_name  VARCHAR(255) NOT NULL,
         kind        VARCHAR(20)  DEFAULT 'database',
         tech        VARCHAR(40)  DEFAULT '',
         conn_id     INTEGER      DEFAULT 0,
         field       VARCHAR(120) NOT NULL,
         old_value   TEXT,
         new_value   TEXT)""",
    """CREATE INDEX IF NOT EXISTS idx_stable_changes_agent_ts
         ON agent_stable_changes (agent_name, ts DESC)""",
    # Per-agent last failure reason — surfaced in the UI when a collection errors.
    """ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_error TEXT""",
    # Oracle Storage Health: approval no longer auto-queues execution — a human
    # must explicitly click Start, recorded here.
    """ALTER TABLE oracle_maintenance_jobs ADD COLUMN IF NOT EXISTS start_requested_at TIMESTAMP""",
    # Oracle Storage Health: schedule-for-later + email notification recipients.
    """ALTER TABLE oracle_maintenance_jobs
         ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP,
         ADD COLUMN IF NOT EXISTS notification_recipients JSONB""",
    # Employee-code generator collision fix: uk_employee_org_code spans soft-deleted
    # rows, but the old generator computed MAX() over live rows only — so a deleted
    # ACTnnn code got regenerated and violated the constraint on insert. Recompute
    # over ALL rows and skip any lingering code.
    r"""CREATE OR REPLACE PROCEDURE public.sp_insertemployee(IN p_json jsonb)
    LANGUAGE plpgsql AS $_$
DECLARE v_org INTEGER; v_code VARCHAR(50); v_name VARCHAR(150); v_by INTEGER; v_cnt INTEGER;
        v_prefix TEXT; v_num INTEGER;
BEGIN
    v_org := COALESCE((p_json->>'org_id')::INTEGER, 1);
    v_code := TRIM(p_json->>'employee_code');
    v_name := TRIM(p_json->>'employee_name');
    v_by := COALESCE((p_json->>'created_by')::INTEGER, 1);
    IF v_name IS NULL OR v_name='' THEN RAISE EXCEPTION 'Employee Name is required'; END IF;
    IF v_code IS NULL OR v_code = '' THEN
        SELECT (regexp_match(employee_code, '^([A-Za-z]+)'))[1] INTO v_prefix
          FROM public.employee_master
         WHERE org_id = v_org AND employee_code ~ '^[A-Za-z]+[0-9]+$'
         ORDER BY created_at DESC NULLS LAST, employee_id DESC LIMIT 1;
        v_prefix := COALESCE(v_prefix, 'ACT');
        SELECT COALESCE(MAX((regexp_match(employee_code, '([0-9]+)$'))[1]::INTEGER), 0) + 1 INTO v_num
          FROM public.employee_master
         WHERE org_id = v_org AND employee_code ~ ('^' || v_prefix || '[0-9]+$');
        v_code := v_prefix || LPAD(v_num::TEXT, 3, '0');
        WHILE EXISTS (SELECT 1 FROM public.employee_master
                       WHERE org_id=v_org AND lower(employee_code)=lower(v_code)) LOOP
            v_num := v_num + 1;
            v_code := v_prefix || LPAD(v_num::TEXT, 3, '0');
        END LOOP;
    END IF;
    SELECT COUNT(*) INTO v_cnt FROM public.employee_master WHERE org_id=v_org AND lower(employee_code)=lower(v_code);
    IF v_cnt>0 THEN RAISE EXCEPTION 'Employee Code already exists'; END IF;
    INSERT INTO public.employee_master
      (org_id, employee_code, employee_name, email_id, mobile_no, department_id, designation_id,
       joining_date, reporting_manager_id, employment_status_id, is_active, created_by, created_at)
    VALUES (v_org, v_code, v_name, p_json->>'email_id', p_json->>'mobile_no',
       (p_json->>'department_id')::INTEGER, (p_json->>'designation_id')::INTEGER,
       (p_json->>'joining_date')::DATE, (p_json->>'reporting_manager_id')::INTEGER,
       COALESCE((p_json->>'employment_status_id')::INTEGER, 1), TRUE, v_by, CURRENT_TIMESTAMP);
END; $_$""",
    # Dashboard Appearance: widened from one row per user to one row per
    # (user, scope) — scope='all' is the global default, a specific tech name
    # (mysql/mssql/oracle/postgresql/mongodb/clickhouse/infra) is a per-tech
    # override. Installs that already ran create_all() with the old single-scope
    # table need these columns + the new composite unique constraint added.
    """ALTER TABLE dashboard_appearance_settings
         ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'all',
         ADD COLUMN IF NOT EXISTS display_mode VARCHAR(10) NOT NULL DEFAULT 'gauge'""",
    """DO $$
       BEGIN
           ALTER TABLE dashboard_appearance_settings DROP CONSTRAINT IF EXISTS uq_dashboard_appearance_user;
           BEGIN
               ALTER TABLE dashboard_appearance_settings
                   ADD CONSTRAINT uq_dashboard_appearance_user_scope UNIQUE (user_id, scope);
           EXCEPTION WHEN duplicate_object THEN NULL;
           END;
       END $$""",
    # Cloud-based databases (Azure Cosmos DB, and future providers) — new
    # columns on the shared connection_master table.
    """ALTER TABLE connection_master
         ADD COLUMN IF NOT EXISTS cloud_provider          VARCHAR(50),
         ADD COLUMN IF NOT EXISTS cloud_api_type           VARCHAR(30),
         ADD COLUMN IF NOT EXISTS cloud_account_name       VARCHAR(255),
         ADD COLUMN IF NOT EXISTS cloud_endpoint           VARCHAR(500),
         ADD COLUMN IF NOT EXISTS cloud_primary_key_enc    TEXT,
         ADD COLUMN IF NOT EXISTS cloud_secondary_key_enc  TEXT,
         ADD COLUMN IF NOT EXISTS cloud_container_name     VARCHAR(255),
         ADD COLUMN IF NOT EXISTS cloud_partition_key      VARCHAR(255),
         ADD COLUMN IF NOT EXISTS cloud_config             JSONB""",
    # Azure Monitor credentials (optional, separate from the Cosmos account key)
    """ALTER TABLE connection_master
         ADD COLUMN IF NOT EXISTS cloud_monitor_client_secret_enc TEXT""",
    # Cosmos DB query log — request charge (RU) + a general numeric result value
    # (e.g. a logged document count, for a real growth-over-time chart) per call.
    """ALTER TABLE cosmos_query_log
         ADD COLUMN IF NOT EXISTS request_charge DOUBLE PRECISION,
         ADD COLUMN IF NOT EXISTS result_value   DOUBLE PRECISION""",
    # Cosmos DB query log — storage-size sample (for a real storage-growth chart),
    # Cosmos's own activity id (support/diagnostics correlation), and structured
    # error fields (exception class + HTTP status) parsed from the SDK exception.
    """ALTER TABLE cosmos_query_log
         ADD COLUMN IF NOT EXISTS storage_bytes     DOUBLE PRECISION,
         ADD COLUMN IF NOT EXISTS activity_id       VARCHAR(64),
         ADD COLUMN IF NOT EXISTS error_type        VARCHAR(120),
         ADD COLUMN IF NOT EXISTS http_status_code  INTEGER""",
    # Digital Experience — Website Availability / Ping / DNS / TCP Port /
    # UDP Port monitors (one shared table across check types) + their
    # time-series probe results.
    """CREATE TABLE IF NOT EXISTS external_check (
         id                     SERIAL PRIMARY KEY,
         org_id                 INTEGER      NOT NULL DEFAULT 1,
         user_id                INTEGER,
         name                   VARCHAR(255) NOT NULL,
         check_type             VARCHAR(30)  NOT NULL,
         target                 VARCHAR(500) NOT NULL,
         port                   INTEGER,
         interval_seconds       INTEGER      NOT NULL DEFAULT 300,
         enabled                BOOLEAN      NOT NULL DEFAULT TRUE,
         config                 JSONB,
         created_at             TIMESTAMP    DEFAULT now(),
         updated_at             TIMESTAMP    DEFAULT now(),
         last_checked_at        TIMESTAMP,
         last_status            VARCHAR(20),
         last_response_time_ms  DOUBLE PRECISION)""",
    """CREATE INDEX IF NOT EXISTS idx_external_check_org ON external_check (org_id)""",
    """CREATE TABLE IF NOT EXISTS external_check_result (
         id                SERIAL PRIMARY KEY,
         check_id          INTEGER NOT NULL REFERENCES external_check(id),
         org_id            INTEGER NOT NULL DEFAULT 1,
         checked_at        TIMESTAMP DEFAULT now(),
         status            VARCHAR(20) NOT NULL,
         response_time_ms  DOUBLE PRECISION,
         status_code       INTEGER,
         error_message     TEXT)""",
    """CREATE INDEX IF NOT EXISTS idx_external_check_result_check_ts
         ON external_check_result (check_id, checked_at DESC)""",
    # Agent version reporting — which build each host actually runs.
    """ALTER TABLE agents
         ADD COLUMN IF NOT EXISTS agent_version          VARCHAR(40),
         ADD COLUMN IF NOT EXISTS agent_version_seen_at  TIMESTAMPTZ""",
    # Agent upgrade ledger — proves an update landed instead of assuming it did.
    """CREATE TABLE IF NOT EXISTS agent_pending_update (
         id                 SERIAL PRIMARY KEY,
         agent_name         VARCHAR(255) NOT NULL,
         expected_version   VARCHAR(40),
         from_version       VARCHAR(40),
         status             VARCHAR(30)  NOT NULL DEFAULT 'pending',
         detail             TEXT,
         issued_at          TIMESTAMPTZ  DEFAULT now(),
         issued_by          INTEGER,
         delivered_at       TIMESTAMPTZ,
         confirmed_at       TIMESTAMPTZ,
         confirmed_version  VARCHAR(40))""",
    """CREATE INDEX IF NOT EXISTS idx_agent_pending_update_agent
         ON agent_pending_update (agent_name, issued_at DESC)""",
    # ── Enterprise Alert Notification System ──────────────────────────────
    # Channel configs (one row per org+channel_type, secrets Fernet-encrypted
    # into secrets_enc — see app/services/common/crypto_service.py), per-rule
    # channel selection, severity-based default routing, persistent firing
    # state (makes alert_rules.duration_seconds/cooldown_seconds actually
    # mean something instead of sitting unused), the dispatch/retry queue,
    # and the append-only delivery history log.
    """ALTER TABLE alert_rules
         ADD COLUMN IF NOT EXISTS notification_channel_types JSONB NOT NULL DEFAULT '[]'::jsonb""",
    """ALTER TABLE alert_rules
         ADD COLUMN IF NOT EXISTS notification_recipients JSONB NOT NULL DEFAULT '[]'::jsonb""",
    """ALTER TABLE alert_rules
         ADD COLUMN IF NOT EXISTS notification_cc JSONB NOT NULL DEFAULT '[]'::jsonb""",
    """ALTER TABLE alert_rules
         ADD COLUMN IF NOT EXISTS notification_bcc JSONB NOT NULL DEFAULT '[]'::jsonb""",
    """CREATE TABLE IF NOT EXISTS notification_channels (
         id               SERIAL PRIMARY KEY,
         org_id           INTEGER      NOT NULL DEFAULT 1,
         channel_type     VARCHAR(30)  NOT NULL,
         enabled          BOOLEAN      NOT NULL DEFAULT FALSE,
         config           JSONB        NOT NULL DEFAULT '{}'::jsonb,
         secrets_enc      TEXT,
         last_test_at     TIMESTAMP,
         last_test_ok     BOOLEAN,
         last_test_msg    VARCHAR(500),
         last_success_at  TIMESTAMP,
         last_failure_at  TIMESTAMP,
         last_error       TEXT,
         created_at       TIMESTAMP DEFAULT now(),
         updated_at       TIMESTAMP,
         UNIQUE (org_id, channel_type))""",
    """CREATE TABLE IF NOT EXISTS severity_channel_routing (
         id            SERIAL PRIMARY KEY,
         org_id        INTEGER      NOT NULL DEFAULT 1,
         severity      VARCHAR(20)  NOT NULL,
         channel_type  VARCHAR(30)  NOT NULL,
         enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
         UNIQUE (org_id, severity, channel_type))""",
    """CREATE TABLE IF NOT EXISTS alert_fired_state (
         id                SERIAL PRIMARY KEY,
         alert_rule_id     INTEGER      NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
         scope_key         VARCHAR(300) NOT NULL,
         first_breach_at   TIMESTAMP    NOT NULL,
         last_breach_at    TIMESTAMP    NOT NULL,
         last_notified_at  TIMESTAMP,
         is_firing         BOOLEAN      NOT NULL DEFAULT FALSE,
         UNIQUE (alert_rule_id, scope_key))""",
    """CREATE TABLE IF NOT EXISTS notification_queue (
         id               SERIAL PRIMARY KEY,
         org_id           INTEGER      NOT NULL DEFAULT 1,
         alert_rule_id    INTEGER      REFERENCES alert_rules(id) ON DELETE SET NULL,
         channel_type     VARCHAR(30)  NOT NULL,
         payload          JSONB        NOT NULL,
         status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
         attempt_count    INTEGER      NOT NULL DEFAULT 0,
         max_attempts     INTEGER      NOT NULL DEFAULT 3,
         next_attempt_at  TIMESTAMP    NOT NULL DEFAULT now(),
         timeout_seconds  INTEGER      NOT NULL DEFAULT 15,
         last_error       TEXT,
         created_at       TIMESTAMP    DEFAULT now(),
         sent_at          TIMESTAMP)""",
    """CREATE INDEX IF NOT EXISTS idx_notification_queue_due
         ON notification_queue (status, next_attempt_at)""",
    """CREATE TABLE IF NOT EXISTS notification_history (
         id                SERIAL PRIMARY KEY,
         org_id            INTEGER      NOT NULL DEFAULT 1,
         sent_at           TIMESTAMP    DEFAULT now(),
         alert_rule_id     INTEGER      REFERENCES alert_rules(id) ON DELETE SET NULL,
         alert_name        VARCHAR(200),
         server_name       VARCHAR(255),
         database_name     VARCHAR(255),
         severity          VARCHAR(20),
         channel_type      VARCHAR(30)  NOT NULL,
         recipient         VARCHAR(500),
         status            VARCHAR(20)  NOT NULL,
         response_code     VARCHAR(20),
         response_time_ms  DOUBLE PRECISION,
         retry_count       INTEGER      NOT NULL DEFAULT 0,
         error_message     TEXT)""",
    """CREATE INDEX IF NOT EXISTS idx_notification_history_org_sent
         ON notification_history (org_id, sent_at DESC)""",
    """CREATE TABLE IF NOT EXISTS notification_templates (
         id                SERIAL PRIMARY KEY,
         org_id            INTEGER      NOT NULL DEFAULT 1,
         channel_type      VARCHAR(30)  NOT NULL,
         subject_template  TEXT,
         body_template     TEXT,
         UNIQUE (org_id, channel_type))""",
    # SMTP password encryption-at-rest (Fernet, same crypto_service used for
    # Cosmos DB keys) — smtp_password stays readable during the transition;
    # new saves populate smtp_password_enc and routes prefer it when present.
    """ALTER TABLE smtp_configs
         ADD COLUMN IF NOT EXISTS smtp_password_enc TEXT""",
    # Per-instance service-down diagnostics — when a status actually
    # transitions (not just re-checked) and the raw check output at that
    # time, so a "Database Service Down" alert can say WHEN and show real
    # systemctl output instead of guessing from the alert's own poll tick.
    """ALTER TABLE database_instances
         ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP""",
    """ALTER TABLE database_instances
         ADD COLUMN IF NOT EXISTS status_detail TEXT""",
    # Org-wide notification preferences — currently just the timezone alert
    # {{Timestamp}}s render in (default IST; everything is stored/evaluated
    # in UTC internally, converted only at send time).
    """CREATE TABLE IF NOT EXISTS notification_settings (
         org_id      INTEGER PRIMARY KEY DEFAULT 1,
         timezone    VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
         updated_at  TIMESTAMP)""",
    # Oracle topology (RAC/Data Guard) — user-selected deployment type +
    # collector-maintained role, used to detect switchover/failover role
    # transitions. See app/models/oracle_topology_model.py for the
    # accompanying oracle_topology_links join table (created via ORM
    # create_all since it's a brand-new table, not an existing one).
    """ALTER TABLE connection_master
         ADD COLUMN IF NOT EXISTS oracle_deployment_type VARCHAR(50),
         ADD COLUMN IF NOT EXISTS oracle_role             VARCHAR(50)""",
    # Patroni's own REST API port for a Patroni-managed PostgreSQL OS server —
    # added to the ORM model (os_server_model.py) without a matching schema.sql/
    # migration entry, so every fresh install's alert-evaluator background
    # loop (which does `SELECT * FROM os_servers`) crashed every tick with
    # "column os_servers.patroni_api_port does not exist" until this patch.
    """ALTER TABLE os_servers
         ADD COLUMN IF NOT EXISTS patroni_api_port INTEGER""",
    # Same class of gap as patroni_api_port above — agent_model.py's
    # AgentMetric grew kind/tech/conn_id/host_disk without a matching
    # schema.sql/migration entry. Every agent host-infra push failed its
    # INSERT on this (rolling back the whole transaction, including the
    # Agent/OsServer row updates in the same commit) until this patch.
    """ALTER TABLE agent_metrics
         ADD COLUMN IF NOT EXISTS kind VARCHAR(32),
         ADD COLUMN IF NOT EXISTS tech VARCHAR(64),
         ADD COLUMN IF NOT EXISTS conn_id INTEGER,
         ADD COLUMN IF NOT EXISTS host_disk DOUBLE PRECISION""",
]


def apply_patches(conn):
    """Run the idempotent upgrade patches (existing installs only get these — a fresh
    schema.sql already contains everything)."""
    applied = 0
    for sql in _SCHEMA_PATCHES:
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
            # Commit each patch on its OWN transaction — otherwise a single failing
            # patch aborts the transaction and every LATER patch is skipped with
            # "current transaction is aborted" (this is what dropped the last_error
            # column and broke the agents API).
            conn.commit()
            applied += 1
        except Exception as e:  # noqa: BLE001 — a failed patch must not break updates
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            log("patch", f"note: patch skipped ({str(e).splitlines()[0]})")
    if applied:
        log("patch", f"{applied} idempotent schema patch(es) ensured")


def apply_schema(conn):
    # apply_patches() ALWAYS runs, on every branch below — schema.sql itself can
    # (and has) lagged behind a model that already grew a new column, so a
    # patch-only column must not depend on a SECOND db_setup.py run to land. A
    # genuinely fresh install used to skip straight past this (this branch
    # returned before ever calling apply_patches()), leaving a real window
    # where e.g. connection_master.oracle_deployment_type/oracle_role existed
    # in the ORM model and in _SCHEMA_PATCHES, but not yet in the database,
    # until whatever NEXT ran db_setup.py — exactly the failure class three
    # other now-fixed columns (os_servers.patroni_api_port, agent_metrics.
    # kind/tech/conn_id/host_disk) hit live before this was caught.
    if _table_exists(conn, "page_master"):
        log("schema", "schema already present - skipping structure apply")
        apply_patches(conn)
        return False
    if not SCHEMA_SQL.is_file():
        raise SystemExit(f"ERROR: missing {SCHEMA_SQL}")
    sql, extensions = _clean_sql(SCHEMA_SQL.read_text(encoding="utf-8", errors="replace"))
    # Extensions first (optional - never fatal).
    for ext in extensions:
        try:
            with conn.cursor() as cur:
                cur.execute(ext)
        except Exception as e:  # noqa: BLE001
            log("schema", f"note: extension skipped ({str(e).splitlines()[0]})")
    with conn.cursor() as cur:
        cur.execute(sql)
    _set_public(conn)
    log("schema", f"applied schema.sql ({_count_objects(conn)} tables, views & functions)")
    apply_patches(conn)
    return True


def _count_objects(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
        return cur.fetchone()[0]


def _apply_file(conn, path):
    if not path.is_file():
        raise SystemExit(f"ERROR: missing {path}")
    sql, _ = _clean_sql(path.read_text(encoding="utf-8", errors="replace"))
    with conn.cursor() as cur:
        cur.execute(sql)
    _set_public(conn)


def seed_roots(conn):
    """status_master + permission - no FKs, seeded before the organization."""
    if _count(conn, "status_master") > 0 and _count(conn, "permission") > 0:
        log("seed", "roots (status, permissions) already present - skipping")
        return False
    _apply_file(conn, CONFIG_ROOTS_SQL)
    log("seed", f"seeded {_count(conn,'status_master')} statuses, {_count(conn,'permission')} permissions")
    return True


def seed_pages(conn):
    """module_master + page_master - FK org_id=1, seeded after the organization."""
    if _count(conn, "page_master") > 0:
        log("seed", "modules & pages already seeded - skipping")
        return False
    _apply_file(conn, CONFIG_PAGES_SQL)
    log("seed", f"seeded {_count(conn,'module_master')} modules, {_count(conn,'page_master')} pages")
    return True


def ensure_org(conn, org_name, admin_email):
    """Organization #1 - created after roots (needs a valid status_id) and before
    the pages seed (module_master/page_master FK org_id=1). Fills every NOT-NULL col."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM organization_master WHERE org_id = %s", (DEFAULT_ORG_ID,))
        if cur.fetchone() is None:
            cur.execute("SELECT status_id FROM status_master ORDER BY status_id LIMIT 1")
            row = cur.fetchone()
            status_id = row[0] if row else None
            cur.execute(
                "INSERT INTO organization_master "
                "(org_id, org_code, org_name, legal_name, contact_no, email_id, "
                " country_name, state_name, city_name, status_id, is_active, created_by, created_at) "
                "OVERRIDING SYSTEM VALUE "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,TRUE,1,NOW())",
                (DEFAULT_ORG_ID, "ORG001", org_name, org_name, "NA", admin_email or "admin@localhost",
                 "NA", "NA", "NA", status_id))
            log("tenant", f"created organization #{DEFAULT_ORG_ID} ('{org_name}')")
        else:
            log("tenant", f"organization #{DEFAULT_ORG_ID} already present")
        cur.execute(
            "SELECT setval(pg_get_serial_sequence('organization_master','org_id'), "
            "GREATEST((SELECT COALESCE(MAX(org_id),1) FROM organization_master), 1))")


def baseline_tenant(conn, org_name):
    """Super Admin role #1 and grant it every page."""
    with conn.cursor() as cur:
        # Super Admin role #1
        cur.execute("SELECT 1 FROM role WHERE role_id = %s", (SUPER_ADMIN_ROLE_ID,))
        if cur.fetchone() is None:
            cur.execute(
                "INSERT INTO role (role_id, org_id, role_name, role_description, is_active, created_by, created_at) "
                "OVERRIDING SYSTEM VALUE "
                "VALUES (%s, %s, 'Super Admin', 'Full access to every page and action', TRUE, 1, NOW())",
                (SUPER_ADMIN_ROLE_ID, DEFAULT_ORG_ID))
            log("tenant", "created role #1 'Super Admin'")
        else:
            log("tenant", "role #1 'Super Admin' already present")

        # Keep the role identity sequence ahead of our fixed ID.
        cur.execute(
            "SELECT setval(pg_get_serial_sequence('role','role_id'), "
            "GREATEST((SELECT COALESCE(MAX(role_id),1) FROM role), 1))")

        # Full permission bitmask = OR of every permission_value in the catalog.
        cur.execute("SELECT COALESCE(bit_or(permission_value), 1) FROM permission WHERE is_active")
        full_mask = cur.fetchone()[0] or 1

        # Grant Super Admin FULL on every page (idempotent upsert on the unique key).
        cur.execute("SELECT page_id FROM page_master WHERE is_active AND deleted_at IS NULL")
        page_ids = [r[0] for r in cur.fetchall()]
        granted = 0
        for pid in page_ids:
            cur.execute(
                "SELECT page_permission_id FROM group_role_page_permission "
                "WHERE org_id=%s AND role_id=%s AND page_id=%s",
                (DEFAULT_ORG_ID, SUPER_ADMIN_ROLE_ID, pid))
            existing = cur.fetchone()
            if existing:
                cur.execute(
                    "UPDATE group_role_page_permission SET permission=%s, is_active=TRUE, "
                    "modified_by=1, modified_at=NOW() WHERE page_permission_id=%s",
                    (full_mask, existing[0]))
            else:
                cur.execute(
                    "INSERT INTO group_role_page_permission "
                    "(org_id, role_id, page_id, permission, permission_description, is_active, created_by, created_at) "
                    "VALUES (%s,%s,%s,%s,'Super Admin full access',TRUE,1,NOW())",
                    (DEFAULT_ORG_ID, SUPER_ADMIN_ROLE_ID, pid, full_mask))
                granted += 1
        log("tenant", f"Super Admin granted full access on {len(page_ids)} pages "
                      f"(mask={full_mask}, {granted} new)")
        return {"pages": len(page_ids), "mask": full_mask}


def main():
    cfg = _load_env()
    print(f"ActMon DB provisioning -> {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']}", flush=True)
    existed = create_database(cfg)
    conn = _connect(cfg, cfg["dbname"])
    _set_public(conn)
    # Seed with audit triggers + FK checks off (avoids the audit trigger writing to
    # audit_log before org #1 exists). Requires a superuser DB role - which install
    # already needs for CREATE DATABASE / CREATE EXTENSION.
    replica = False
    try:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = replica")
        replica = True
    except Exception as e:  # noqa: BLE001
        log("db", f"note: could not suspend triggers ({str(e).splitlines()[0]}); relying on seed order")
    try:
        schema_applied = apply_schema(conn)
        roots_seeded = seed_roots(conn)            # status + permission (no FK)
        ensure_org(conn, cfg["org_name"], cfg["admin_email"])  # org #1 (needs status)
        pages_seeded = seed_pages(conn)            # modules + pages (FK -> org #1)
        grants = baseline_tenant(conn, cfg["org_name"])
        summary = {
            "database": cfg["dbname"],
            "db_pre_existed": existed,
            "schema_applied": schema_applied,
            "config_seeded": bool(roots_seeded or pages_seeded),
            "tables": _count_objects(conn),
            "permissions": _count(conn, "permission"),
            "modules": _count(conn, "module_master"),
            "pages": _count(conn, "page_master"),
            "roles": _count(conn, "role"),
            "grants": _count(conn, "group_role_page_permission"),
            "super_admin_pages": grants["pages"],
            "users": _count(conn, "user_master"),
            "employees": _count(conn, "employee_master"),
        }
    finally:
        if replica:
            try:
                with conn.cursor() as cur:
                    cur.execute("SET session_replication_role = DEFAULT")
            except Exception:  # noqa: BLE001
                pass
        conn.close()
    print("SUMMARY_JSON:" + json.dumps(summary), flush=True)
    print("Database provisioning complete.", flush=True)


if __name__ == "__main__":
    main()
