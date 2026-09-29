"""Columns added to tables that already existed when a feature shipped.

`create_all` builds missing TABLES and never alters an existing one, so every
column added to a table that is already deployed has to be stated out loud.
The older features do that inline in `main.py`'s lifespan; these live here so
the startup path and the test suites apply the identical statements — the
lesson of `app/events/schema.py`, where a test that built its own tables
"proved" behaviour the real database was not enforcing.

**Check first, then alter.** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` takes an
ACCESS EXCLUSIVE lock on the table BEFORE it discovers the column is already
there. On a hot table (cloud_accounts, discovery_jobs) that means a startup or
a test suite waits behind any open transaction — a running discovery holds
one — and every other query on the table queues behind the waiting ALTER,
stalling the live service for as long as the scan runs. So each patch runs only
when the catalog says the column or index is missing, and under a lock timeout,
so even a needed patch fails fast rather than freezing the table.
"""
from __future__ import annotations

import logging

from sqlalchemy import text

logger = logging.getLogger("cloud_svc.schema")

# (table, kind, name, ddl). kind is "column" or "index".
# cloud_clients is created by create_all before these run (the model is
# imported by cloud_account.py), so the foreign key always has a target.
CLIENT_PATCHES = (
    ("cloud_accounts", "column", "client_id",
     "ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS client_id UUID "
     "REFERENCES cloud_clients(id) ON DELETE SET NULL"),
    ("cloud_accounts", "index", "ix_cloud_accounts_client_id",
     "CREATE INDEX IF NOT EXISTS ix_cloud_accounts_client_id ON cloud_accounts (client_id)"),
    ("cloud_accounts", "column", "provider_account_id",
     "ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS provider_account_id VARCHAR(255)"),
    ("cloud_accounts", "index", "ix_cloud_accounts_provider_account_id",
     "CREATE INDEX IF NOT EXISTS ix_cloud_accounts_provider_account_id "
     "ON cloud_accounts (provider_account_id)"),
    ("cloud_accounts", "column", "onboarding_source",
     "ALTER TABLE cloud_accounts ADD COLUMN IF NOT EXISTS onboarding_source JSONB"),
)

# What each sweep actually read — scopes attempted / read, and per service why
# the rest was not (denied with the IAM actions to grant, failed, or not
# offered in a region). Coverage and every later assessment read it from here.
DISCOVERY_PATCHES = (
    ("discovery_jobs", "column", "scope_summary",
     "ALTER TABLE discovery_jobs ADD COLUMN IF NOT EXISTS scope_summary JSONB"),
)

ALL_PATCHES = CLIENT_PATCHES + DISCOVERY_PATCHES

_EXISTS = {
    "column": ("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() "
               "AND table_name = :table AND column_name = :name"),
    "index": ("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() "
              "AND tablename = :table AND indexname = :name"),
}


async def missing(conn):
    """The patches whose column or index is not there yet. Catalog reads
    only — no table lock is taken."""
    out = []
    for table, kind, name, ddl in ALL_PATCHES:
        found = (await conn.execute(text(_EXISTS[kind]), {"table": table, "name": name})).first()
        if not found:
            out.append((table, kind, name, ddl))
    return out


async def apply(conn) -> int:
    """Run the patches that are actually needed on `conn` (an AsyncConnection
    inside a transaction). Returns how many ran — 0 on an up-to-date database,
    which then took no lock at all."""
    needed = await missing(conn)
    if not needed:
        return 0
    # A needed patch still must not sit in the lock queue indefinitely.
    await conn.execute(text("SET LOCAL lock_timeout = '15s'"))
    for table, kind, name, ddl in needed:
        logger.info("Schema patch: adding %s %s.%s", kind, table, name)
        await conn.execute(text(ddl))
    return len(needed)


async def apply_standalone() -> int:
    """Create the new tables and apply the patches, for scripts and tests that
    run without the service's lifespan."""
    from app.core.database import Base, engine
    import app.models.client  # noqa: F401
    import app.models.cloud_account  # noqa: F401
    import app.models.credential_inventory  # noqa: F401
    import app.models.discovery_job  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        return await apply(conn)
