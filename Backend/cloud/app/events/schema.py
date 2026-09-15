"""Schema guarantees for `cloud_events` that SQLAlchemy models cannot express.

`Base.metadata.create_all` builds tables, columns and indexes. It cannot build
a trigger — so the append-only guarantee, which is the security property the
whole feature rests on, lives here and is applied explicitly.

Defined in one place and called from both the application's startup and the
test suite, on purpose. When the DDL lived only inside `app/main.py`'s
lifespan, the storage tests created their tables directly, never installed the
trigger, and cheerfully proved that events were immutable while nothing was
stopping an UPDATE. A guarantee that only exists on the path nobody tests is
not a guarantee.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("cloud_svc.events.schema")

# The session variable a caller must set to be allowed to delete. Read with
# `current_setting(..., true)` so it returns NULL rather than raising on a
# connection that never set it, and written with SET LOCAL so the permission
# expires with the transaction and cannot leak to the next request sharing a
# pooled connection.
PRUNE_FLAG = "actmon.allow_event_prune"

# NOTE ON `RETURN OLD`, which is load-bearing and was wrong first time round:
# a BEFORE ... FOR EACH ROW trigger that returns NULL *silently cancels the
# operation for that row*. Returning NULL here therefore did not "fall through
# harmlessly" — it made every permitted DELETE a no-op, so the retention pruner
# reported success while deleting nothing, forever, and a cascade delete of a
# cloud account was cancelled row by row until the parent delete failed on a
# foreign-key violation. Returning OLD is what lets a permitted operation
# proceed. The disallowed cases never reach it: RAISE EXCEPTION aborts first.
_FUNCTION_SQL = f"""
CREATE OR REPLACE FUNCTION actmon_cloud_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION
            'cloud_events is append-only: audit events cannot be modified.';
    END IF;
    IF TG_OP = 'DELETE'
       AND COALESCE(current_setting('{PRUNE_FLAG}', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'cloud_events is append-only: events may only be removed by the retention '
            'pruner, or by deleting the cloud account they belong to.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql
"""

# DROP then CREATE: CREATE TRIGGER has no IF NOT EXISTS, and CREATE OR REPLACE
# TRIGGER only arrived in Postgres 14. Dropping first is idempotent on every
# version this ships against.
_DROP_SQL = "DROP TRIGGER IF EXISTS trg_cloud_events_append_only ON cloud_events"
_TRIGGER_SQL = """
CREATE TRIGGER trg_cloud_events_append_only
BEFORE UPDATE OR DELETE ON cloud_events
FOR EACH ROW EXECUTE FUNCTION actmon_cloud_events_append_only()
"""


async def ensure_append_only(conn) -> bool:
    """Install the append-only trigger on an open async connection.

    Returns True when it is in place. Raises nothing on failure — the caller
    decides whether that is fatal — but always logs, because running without
    it means the immutability guarantee is application convention only.

    `conn` is an AsyncConnection inside a transaction (i.e. from
    `async with engine.begin()`).
    """
    from sqlalchemy import text

    await conn.execute(text(_FUNCTION_SQL))
    await conn.execute(text(_DROP_SQL))
    await conn.execute(text(_TRIGGER_SQL))
    return True


async def is_append_only_installed(conn) -> bool:
    """Whether the trigger is actually present — used by the tests and by the
    diagnostics endpoint, so the claim can be verified rather than assumed."""
    from sqlalchemy import text

    found = (
        await conn.execute(
            text(
                "SELECT 1 FROM pg_trigger WHERE tgname = "
                "'trg_cloud_events_append_only' AND NOT tgisinternal"
            )
        )
    ).first()
    return found is not None
