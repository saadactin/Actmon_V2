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
]


def apply_patches(conn):
    """Run the idempotent upgrade patches (existing installs only get these — a fresh
    schema.sql already contains everything)."""
    applied = 0
    for sql in _SCHEMA_PATCHES:
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
            applied += 1
        except Exception as e:  # noqa: BLE001 — a failed patch must not break updates
            log("patch", f"note: patch skipped ({str(e).splitlines()[0]})")
    if applied:
        log("patch", f"{applied} idempotent schema patch(es) ensured")


def apply_schema(conn):
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
