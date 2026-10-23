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

# Budget guardrails (feature 4): a forecast breach and an actual breach are
# different facts and must dedupe independently (see cost_budget.py's
# CloudCostBudgetNotification docstring). Every row this table already held
# was an ACTUAL notification, so backfilling the column with that default is
# correct, not a guess. The old 3-column unique constraint is replaced by a
# unique INDEX over the 4 columns -- a unique index enforces exactly the same
# thing a unique constraint does for a plain `INSERT` (there is no
# `ON CONFLICT ON CONSTRAINT` anywhere in this codepath to care about the
# difference), and `CREATE UNIQUE INDEX IF NOT EXISTS` is idempotent the same
# way the column patches above are, whereas `ADD CONSTRAINT` has no such
# clause in Postgres.
BUDGET_PATCHES = (
    ("cloud_cost_budget_notifications", "column", "kind",
     "ALTER TABLE cloud_cost_budget_notifications ADD COLUMN IF NOT EXISTS "
     "kind VARCHAR(16) NOT NULL DEFAULT 'ACTUAL'"),
    ("cloud_cost_budget_notifications", "drop_constraint", "uq_budget_period_threshold",
     "ALTER TABLE cloud_cost_budget_notifications "
     "DROP CONSTRAINT IF EXISTS uq_budget_period_threshold"),
    ("cloud_cost_budget_notifications", "index", "uq_budget_period_threshold_kind",
     "CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_period_threshold_kind "
     "ON cloud_cost_budget_notifications (budget_id, period_key, threshold, kind)"),
)

# Risk acceptances with an owner and a review date (security_finding.py). Both
# nullable: findings muted before this existed keep working and are listed as
# having no review date rather than lapsing all at once.
SECURITY_EXCEPTION_PATCHES = (
    ("cloud_security_findings", "column", "exception_expires_at",
     "ALTER TABLE cloud_security_findings ADD COLUMN IF NOT EXISTS "
     "exception_expires_at TIMESTAMP WITH TIME ZONE"),
    ("cloud_security_findings", "column", "exception",
     "ALTER TABLE cloud_security_findings ADD COLUMN IF NOT EXISTS exception JSONB"),
    ("cloud_security_findings", "index", "ix_cloud_security_findings_exception_expires_at",
     "CREATE INDEX IF NOT EXISTS ix_cloud_security_findings_exception_expires_at "
     "ON cloud_security_findings (exception_expires_at)"),
)

ALL_PATCHES = (CLIENT_PATCHES + DISCOVERY_PATCHES + BUDGET_PATCHES
               + SECURITY_EXCEPTION_PATCHES)

_EXISTS = {
    "column": ("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() "
               "AND table_name = :table AND column_name = :name"),
    "index": ("SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() "
              "AND tablename = :table AND indexname = :name"),
    # to_regclass(), not `:table::regclass` -- SQLAlchemy's text() bind-param
    # syntax collides visually with Postgres's `::` cast operator.
    "drop_constraint": ("SELECT 1 FROM pg_constraint WHERE conname = :name "
                         "AND conrelid = to_regclass(:table)"),
}

# For every other kind, "missing" means the thing is ABSENT and needs adding.
# A "drop_constraint" patch inverts that: it is needed while the constraint is
# still PRESENT, and becomes a no-op (correctly) once it has been dropped —
# so its row in _EXISTS is read as "found = still needs dropping", not
# "found = already there".
_INVERTED_KINDS = frozenset({"drop_constraint"})


async def missing(conn):
    """The patches that still need to run. Catalog reads only — no table lock
    is taken."""
    out = []
    for table, kind, name, ddl in ALL_PATCHES:
        found = (await conn.execute(text(_EXISTS[kind]), {"table": table, "name": name})).first()
        needed = bool(found) if kind in _INVERTED_KINDS else not found
        if needed:
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
