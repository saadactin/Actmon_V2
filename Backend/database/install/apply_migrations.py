"""Replays Backend/database/migrations/*.sql against the configured Postgres
database, in filename order, fault-isolated — one bad or already-applied
migration is logged and skipped, never aborts the run. Mirrors what the
ActMon-Linux-b1 installer's install.sh already does for a from-scratch
install ("replays migrations/*.sql ... one bad migration is logged and
skipped, never aborts the install").

db_setup.py alone does NOT do this — it only applies schema.sql/config_*.sql
— so a database built straight from schema.sql is missing anything that was
only ever shipped as a dated migration (discovered via a genuinely fresh
`docker compose up`, which surfaced os_servers.agent_token_hash missing;
every existing deployment picked that column up via an ad hoc manual replay
at some point).
"""
import os
import glob
import psycopg2

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "migrations")


def main():
    conn = psycopg2.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=os.environ.get("DB_PORT", "5432"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASS", ""),
        dbname=os.environ.get("DB_NAME", "actmon"),
    )
    conn.autocommit = True
    files = sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql")))
    for path in files:
        name = os.path.basename(path)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            with conn.cursor() as cur:
                cur.execute(sql)
            print(f"[migrations] applied {name}")
        except Exception as exc:  # noqa: BLE001 — one bad migration must never abort the rest
            print(f"[migrations] skipped {name}: {exc}")
            # conn.rollback() is not enough here: under autocommit=True, psycopg2 never
            # tracked an open transaction client-side (it skips its own BEGIN bookkeeping),
            # so it has nothing to roll back — even though the SERVER independently opened
            # one for the multi-statement message and is now stuck aborted. An explicit SQL
            # ROLLBACK, issued directly, is what actually clears it; without this every
            # subsequent migration fails with "current transaction is aborted", masking
            # whether they'd have actually succeeded.
            try:
                with conn.cursor() as cur:
                    cur.execute("ROLLBACK")
            except Exception:  # noqa: BLE001
                pass
    conn.close()


if __name__ == "__main__":
    main()
