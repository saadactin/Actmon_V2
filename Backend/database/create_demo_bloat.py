"""
One-off demo script: creates a genuinely bloated table on Oracle conn_id 4,
so the Storage Health page has a real, visible CRITICAL finding to test the
Request -> Approve -> Execute flow against live.

Run this on the SAME machine/venv that already reaches conn_id 4 (i.e. wherever
`main:app` actually runs) — it reuses the app's own connection helpers, the
exact same code path oracle_storage_service.py uses, so if the live dashboard
can see this Oracle instance, this script can too.

What it does:
  1. Creates DEMO_BLOAT_TABLE (id, padding) under the connected schema.
  2. Bulk-inserts ~700,000 rows of ~2KB each (~1.3-1.5GB) via a server-side
     CONNECT BY LEVEL generator — fast, no per-row round trips.
  3. Deletes ~85% of the rows. DELETE does not shrink the segment, so the
     table now occupies ~1.3-1.5GB while only ~15% of it is real data —
     genuine reclaimable space below the high-water mark, not a guess.
  4. Enables row movement and refreshes statistics, so oracle_storage_findings()
     sees accurate num_rows/avg_row_len and can compute the reclaimable
     estimate correctly.

Safe to re-run: drops the table first if it already exists. Nothing else on
the instance is touched.
"""
from app.database.connection import SessionLocal
from app.services.oracle.oracle_monitoring_service import _get_conn_or_404, _oracle_engine
from sqlalchemy import text

CONN_ID = 4
TOTAL_ROWS = 700_000
KEEP_EVERY_NTH = 100   # keep rows where MOD(id, 100) <= KEEP_PCT -> ~KEEP_PCT% survive
KEEP_PCT = 15

db = SessionLocal()
conn = _get_conn_or_404(CONN_ID, db)
print(f"Connection: {conn.connection_name} ({conn.host}:{conn.port})")
# This machine IS the Oracle host — reach it directly instead of through the
# agent-proxy job channel, which this standalone script isn't set up to serve.
engine = _oracle_engine(conn)

with engine.connect() as c:
    who = c.execute(text("SELECT USER FROM DUAL")).fetchone()
    schema = who[0]
    print(f"Connected as schema: {schema}")

    print("Dropping DEMO_BLOAT_TABLE if it already exists...")
    try:
        c.execute(text("DROP TABLE demo_bloat_table PURGE"))
    except Exception:
        pass

    print(f"Creating table and inserting {TOTAL_ROWS:,} rows (~2KB each)...")
    c.execute(text(
        "CREATE TABLE demo_bloat_table (id NUMBER PRIMARY KEY, padding VARCHAR2(2000))"
    ))
    c.execute(text(
        "INSERT INTO demo_bloat_table (id, padding) "
        "SELECT LEVEL, RPAD('X', 2000, 'X') FROM DUAL "
        f"CONNECT BY LEVEL <= {TOTAL_ROWS}"
    ))

    print(f"Deleting ~{100 - KEEP_PCT}% of rows (creates real reclaimable space)...")
    c.execute(text(
        f"DELETE FROM demo_bloat_table WHERE MOD(id, {KEEP_EVERY_NTH}) > {KEEP_PCT}"
    ))

    print("Enabling row movement (lets SHRINK SPACE run, not just MOVE)...")
    c.execute(text("ALTER TABLE demo_bloat_table ENABLE ROW MOVEMENT"))

    print("Refreshing statistics so the reclaimable estimate is accurate...")
    c.execute(text(
        f"BEGIN DBMS_STATS.GATHER_TABLE_STATS('{schema}', 'DEMO_BLOAT_TABLE'); END;"
    ))

    size_row = c.execute(text(
        "SELECT ROUND(bytes/1024/1024,1) AS mb FROM dba_segments "
        "WHERE segment_name = 'DEMO_BLOAT_TABLE' AND owner = :o"
    ), {"o": schema}).fetchone()
    rows_row = c.execute(text(
        "SELECT num_rows FROM dba_tables WHERE table_name = 'DEMO_BLOAT_TABLE' AND owner = :o"
    ), {"o": schema}).fetchone()

    c.commit()

print()
print("Done.")
print(f"  Table: {schema}.DEMO_BLOAT_TABLE")
print(f"  Size on disk: {size_row[0] if size_row else '?'} MB")
print(f"  Live rows (post-delete, post-stats-refresh): {rows_row[0] if rows_row else '?'}")
print()
print("Refresh the Storage Health page (Segments tab) — DEMO_BLOAT_TABLE should")
print("appear as a CRITICAL finding within the next findings poll (~60s).")
db.close()
