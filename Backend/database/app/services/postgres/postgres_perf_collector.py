"""
PostgreSQL performance-counter history collector (background thread).

Every INTERVAL_SECONDS it samples each PostgreSQL connection's CUMULATIVE
pg_stat_database / pg_stat_bgwriter / pg_stat_checkpointer / pg_stat_wal /
pg_stat_archiver counters and persists one raw snapshot row. Nothing here
computes a rate — these are the exact same ever-increasing counters Postgres
itself exposes. Rate/delta math happens once, at READ time, from two rows of
this table (see postgres_perf_history_service.py) — the same "store raw,
derive on read" split the WAL Purge retention-preview code already uses, so
a changed rate formula never requires re-collecting history.

Mirrors postgres_resource_collector.py's exact thread/table/retention shape
(same INTERVAL_SECONDS cadence, same RETAIN_DAYS, same daemon-thread pattern)
so this reads as "the same collector, for a different metric family" rather
than a new architecture — deliberately not folded INTO that collector, since
CPU/RAM/Disk sampling (SSH/agent-based, applies to every engine) and
Postgres-counter sampling (SQL-based, Postgres-only) have nothing in common
except the tick loop shape.
"""
import threading

from sqlalchemy import text

from app.database.connection import SessionLocal, engine
from app.models.connection_model import ConnectionMaster

INTERVAL_SECONDS = 60
RETAIN_DAYS = 7

_started = False
_lock = threading.Lock()

# One row per sample tick per connection. Every counter is nullable — a
# column stays NULL for a given row when its source view doesn't exist on
# that server's PG version (pg_stat_wal needs PG14+, pg_stat_checkpointer
# needs PG17+) or the query failed for any other reason; the reader treats a
# NULL-flanked interval as "can't compute a rate here" rather than a zero.
_DDL = [
    """CREATE TABLE IF NOT EXISTS postgres_perf_samples (
        id                     BIGSERIAL PRIMARY KEY,
        org_id                 INTEGER NOT NULL DEFAULT 1,
        connection_id          INTEGER NOT NULL,
        captured_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        xact_commit            BIGINT,
        xact_rollback          BIGINT,
        blks_read              BIGINT,
        blks_hit               BIGINT,
        tup_fetched             BIGINT,
        tup_inserted            BIGINT,
        tup_updated             BIGINT,
        tup_deleted             BIGINT,
        numbackends             INTEGER,
        buffers_alloc           BIGINT,
        buffers_clean           BIGINT,
        buffers_backend         BIGINT,
        maxwritten_clean        BIGINT,
        buffers_checkpoint      BIGINT,
        checkpoints_timed       BIGINT,
        checkpoints_req         BIGINT,
        checkpoint_write_time   NUMERIC,
        checkpoint_sync_time    NUMERIC,
        wal_bytes               NUMERIC,
        wal_records             BIGINT,
        wal_fpi                 BIGINT,
        wal_write               BIGINT,
        wal_sync                BIGINT,
        wal_write_time          NUMERIC,
        wal_sync_time           NUMERIC,
        archived_count          BIGINT,
        failed_count            BIGINT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_pg_perf_samples_conn_time ON postgres_perf_samples (connection_id, captured_at DESC)",
]

_COLUMNS = [
    "xact_commit", "xact_rollback", "blks_read", "blks_hit",
    "tup_fetched", "tup_inserted", "tup_updated", "tup_deleted", "numbackends",
    "buffers_alloc", "buffers_clean", "buffers_backend", "maxwritten_clean",
    "buffers_checkpoint", "checkpoints_timed", "checkpoints_req",
    "checkpoint_write_time", "checkpoint_sync_time",
    "wal_bytes", "wal_records", "wal_fpi", "wal_write", "wal_sync",
    "wal_write_time", "wal_sync_time", "archived_count", "failed_count",
]


def _ensure_table():
    with engine.begin() as c:
        for stmt in _DDL:
            c.exec_driver_sql(stmt)


def _sample_one(conn, db):
    from app.services.postgres.postgres_monitoring_service import _pg_conn, _rows

    try:
        _, eng = _pg_conn(conn.id, db)
    except Exception:
        return

    row = dict.fromkeys(_COLUMNS)

    try:
        r = _rows(eng, "SELECT sum(xact_commit) AS xc, sum(xact_rollback) AS xr, sum(blks_read) AS br, "
                        "sum(blks_hit) AS bh, sum(tup_fetched) AS tf, sum(tup_inserted) AS ti, "
                        "sum(tup_updated) AS tu, sum(tup_deleted) AS td, sum(numbackends) AS nb "
                        "FROM pg_stat_database")
        if r:
            d = r[0]
            row.update(xact_commit=d.get("xc"), xact_rollback=d.get("xr"), blks_read=d.get("br"),
                       blks_hit=d.get("bh"), tup_fetched=d.get("tf"), tup_inserted=d.get("ti"),
                       tup_updated=d.get("tu"), tup_deleted=d.get("td"), numbackends=d.get("nb"))
    except Exception:
        pass

    try:
        r = _rows(eng, "SELECT * FROM pg_stat_bgwriter")
        if r:
            d = r[0]
            row["buffers_clean"] = d.get("buffers_clean")
            row["buffers_backend"] = d.get("buffers_backend")
            row["maxwritten_clean"] = d.get("maxwritten_clean")
            row["buffers_alloc"] = d.get("buffers_alloc")
            # Pre-PG17: checkpoint stats live on this same view. Overwritten
            # below if pg_stat_checkpointer (PG17+) answers instead.
            row["buffers_checkpoint"] = d.get("buffers_checkpoint")
            row["checkpoints_timed"] = d.get("checkpoints_timed")
            row["checkpoints_req"] = d.get("checkpoints_req")
            row["checkpoint_write_time"] = d.get("checkpoint_write_time")
            row["checkpoint_sync_time"] = d.get("checkpoint_sync_time")
    except Exception:
        pass

    try:
        r = _rows(eng, "SELECT * FROM pg_stat_checkpointer")
        if r:
            d = r[0]
            row["checkpoints_timed"] = d.get("num_timed")
            row["checkpoints_req"] = d.get("num_requested")
            row["buffers_checkpoint"] = d.get("buffers_written")
            row["checkpoint_write_time"] = d.get("write_time")
            row["checkpoint_sync_time"] = d.get("sync_time")
    except Exception:
        pass  # PG < 17 — already covered by pg_stat_bgwriter above

    try:
        r = _rows(eng, "SELECT * FROM pg_stat_wal")
        if r:
            d = r[0]
            row["wal_bytes"] = d.get("wal_bytes")
            row["wal_records"] = d.get("wal_records")
            row["wal_fpi"] = d.get("wal_fpi")
            row["wal_write"] = d.get("wal_write")
            row["wal_sync"] = d.get("wal_sync")
            row["wal_write_time"] = d.get("wal_write_time")
            row["wal_sync_time"] = d.get("wal_sync_time")
    except Exception:
        pass  # PG < 14 — no pg_stat_wal

    try:
        r = _rows(eng, "SELECT archived_count, failed_count FROM pg_stat_archiver")
        if r:
            row["archived_count"] = r[0].get("archived_count")
            row["failed_count"] = r[0].get("failed_count")
    except Exception:
        pass  # archive_mode off, or view unreadable

    placeholders = ", ".join(f":{c}" for c in _COLUMNS)
    colnames = ", ".join(_COLUMNS)
    with engine.begin() as c:
        c.execute(text(
            f"INSERT INTO postgres_perf_samples (org_id, connection_id, {colnames}) "
            f"VALUES (:org_id, :connection_id, {placeholders})"
        ), {**row, "org_id": getattr(conn, "org_id", 1) or 1, "connection_id": conn.id})

    # Same row, also into ClickHouse for long-horizon history — this PG table
    # only ever keeps RETAIN_DAYS. Best-effort: a ClickHouse hiccup must never
    # break the collector's own PG insert above.
    try:
        from app.services.postgres.postgres_perf_history_flush_service import flush_perf_sample
        agent_name = conn.connection_name or f"postgres-{conn.id}"
        flush_perf_sample(agent_name, conn.id, row)
    except Exception:
        pass


def _tick():
    db = SessionLocal()
    try:
        conns = db.query(ConnectionMaster).filter(ConnectionMaster.db_type.ilike("postgresql")).all()
        for conn in conns:
            try:
                _sample_one(conn, db)
            except Exception as e:
                print(f"[PerfColl] conn {conn.id}: {e}")
        with engine.begin() as c:
            c.exec_driver_sql(f"DELETE FROM postgres_perf_samples WHERE captured_at < now() - interval '{RETAIN_DAYS} days'")
    finally:
        db.close()


def start_perf_collector():
    global _started
    with _lock:
        if _started:
            return
        _started = True
    try:
        _ensure_table()
    except Exception as e:
        print(f"[PerfColl] table init failed: {e}")

    def _worker():
        while True:
            try:
                _tick()
            except Exception as e:
                print(f"[PerfColl] tick error: {e}")
            threading.Event().wait(INTERVAL_SECONDS)

    threading.Thread(target=_worker, daemon=True).start()
    print("[PerfColl] PostgreSQL performance history collector started.")
