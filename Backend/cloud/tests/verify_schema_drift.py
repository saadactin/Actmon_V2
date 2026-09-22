"""Every SQLAlchemy model's declared columns exist in the live database --
for both the cloud service AND the database service.

Run: venv\\Scripts\\python.exe tests\\verify_schema_drift.py

This is the suite that would have caught the Oracle report email storm
before it happened. Root cause, worked out live: `alert_rules.
notification_channel_types` is declared on the ORM model but was missing
from the live database. The first SELECT against that table inside a
shared session aborted the transaction, `_finish_schedule` could never
commit, and four Oracle report schedules stayed permanently "due" --
producing a repeating email send every time the scheduler ticked. Two more
columns are missing the same way: `agents.agent_version` and
`os_servers.patroni_api_port`. All three are declared on their models and
absent from THIS deployment's live database, even though the first two are
already covered by both services' installers (schema.sql + db_setup.py) --
this database predates those patches. That gap between "the installer
would add it to a fresh database" and "it exists in THIS database" is
exactly what this suite checks, because it is exactly what caused the
incident.

THE THREE KNOWN COLUMNS ARE NOT ALLOWLISTED. This suite is expected to FAIL
on a database that is missing them, and turn green only once they are
actually added -- an allowlist here would defeat the entire point.

Cross-service problem and how it's solved: the cloud and database services
both define a top-level `app` package with their own, differently-built
SQLAlchemy Base. Importing both into one interpreter collides on the
package name. So: the cloud half is checked in-process (this interpreter
already has `app` = the cloud service); the database half is collected by
shelling out to Backend/database/tests/collect_model_columns.py, run under
the INTERPRETER THAT SERVICE ACTUALLY USES -- which is NOT
Backend/database/venv/Scripts/python.exe (that venv is missing its Scripts
directory entirely on this machine and cannot run anything) but the system
Python the service is actually started with. One comparison function is
applied to both halves so there is exactly one place "is this really
missing, or just a benign difference" gets decided.

Degrades honestly: if the database service's interpreter can't be found, or
its process can't be run, that half is SKIPPED with a named reason -- never
silently reported as "no drift".
"""
import asyncio
import json
import logging
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

ok, fail, skipped = [], [], []


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def skip(label, why):
    skipped.append(label)
    print(f"  [SKIP] {label}  {why}")


def section(title):
    print(f"\n{title}")
    print("-" * len(title))


# ── Type-family comparison ───────────────────────────────────────────────────
# Deliberately coarse. "VARCHAR(40)" (model) vs "character varying" (live) is
# noise -- Postgres's information_schema and SQLAlchemy's str(Column.type)
# spell the same type differently. What matters is that neither side thinks
# a column is, say, an integer when the other thinks it's text.
_FAMILY_PATTERNS = [
    ("uuid", re.compile(r"uuid", re.I)),
    ("boolean", re.compile(r"bool", re.I)),
    ("jsonb", re.compile(r"json", re.I)),
    ("timestamp", re.compile(r"timestamp|date|\btime\b", re.I)),
    ("numeric", re.compile(r"numeric|decimal|float|double|real", re.I)),
    ("integer", re.compile(r"int|serial", re.I)),
    ("text", re.compile(r"char|text|string|enum", re.I)),
]


def type_family(type_str):
    for family, pattern in _FAMILY_PATTERNS:
        if pattern.search(type_str or ""):
            return family
    return "other"


# ── Cloud half: in-process ───────────────────────────────────────────────────
def collect_cloud_model_columns():
    """Mirrors Backend/database/tests/collect_model_columns.py, but in-process
    -- this interpreter's `app` package already IS the cloud service, so no
    subprocess is needed here."""
    from app.core.database import Base

    # Force every model module main.py imports to actually be imported, the
    # same way main.py itself does -- importing app.main (not just app.models)
    # is what the existing API suites already do (verify_alert_api.py etc.),
    # and it's what guarantees Base.metadata is fully populated rather than
    # depending on whichever models this suite happened to import already.
    import app.main  # noqa: F401

    tables = {}
    for table_name, table in Base.metadata.tables.items():
        columns = {}
        for col in table.columns:
            columns[col.name] = {
                "type": str(col.type),
                "nullable": bool(col.nullable),
                "has_default": col.default is not None or col.server_default is not None,
            }
        tables[table_name] = columns
    return tables


async def collect_cloud_live_columns(db):
    from sqlalchemy import text

    rows = (await db.execute(text(
        "SELECT table_name, column_name, data_type, is_nullable "
        "FROM information_schema.columns WHERE table_schema = 'public'"
    ))).all()
    live = {}
    for table_name, column_name, data_type, is_nullable in rows:
        live.setdefault(table_name, {})[column_name] = {
            "type": data_type, "nullable": is_nullable == "YES",
        }
    return live


async def collect_cloud_live_table_counts(db, table_names):
    """Row counts for the non-empty-table nullability check (assertion 3).
    Bounded to the tables the model half actually declares -- never a
    SELECT COUNT(*) FROM every table in the schema."""
    from sqlalchemy import text

    counts = {}
    for name in table_names:
        try:
            counts[name] = (await db.execute(
                text(f'SELECT COUNT(*) FROM "{name}"')  # noqa: S608 -- name from our own metadata, not user input
            )).scalar_one()
        except Exception:  # noqa: BLE001 -- table genuinely absent; reported elsewhere
            counts[name] = None
    return counts


# ── Database-service half: subprocess, honest degradation ──────────────────
def find_database_service_interpreter():
    """The interpreter Backend/database actually runs under.

    NOT venv\\Scripts\\python.exe -- see dev-environment-quirks: that venv is
    missing its Scripts directory on this machine and cannot run anything.
    Tries the known system interpreter first, then falls back to whatever
    `python` resolves to on PATH, so this suite degrades across machines
    rather than being hardcoded to one developer's box."""
    candidates = [
        pathlib.Path.home() / "AppData/Local/Programs/Python/Python312/python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    import shutil

    found = shutil.which("python") or shutil.which("python3")
    return found


def collect_database_service_columns():
    """Returns (tables_dict, error_message). error_message is None on
    success; on failure it names exactly what went wrong so a human can act
    on it rather than guess."""
    interpreter = find_database_service_interpreter()
    if not interpreter:
        return None, ("no Python interpreter could be found to run the "
                       "database service's model collector (checked the "
                       "known system install and PATH)")

    database_root = pathlib.Path(__file__).resolve().parents[2] / "database"
    collector = database_root / "tests" / "collect_model_columns.py"
    if not collector.exists():
        return None, f"{collector} does not exist"

    try:
        result = subprocess.run(
            [interpreter, "tests/collect_model_columns.py"],
            cwd=str(database_root), capture_output=True, text=True, timeout=60,
        )
    except Exception as exc:  # noqa: BLE001
        return None, f"could not run the database service's collector: {exc}"

    if result.returncode != 0:
        return None, (f"the database service's collector exited "
                       f"{result.returncode}: "
                       f"{(result.stderr or result.stdout).strip()[:300]}")

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return None, f"collector output was not valid JSON: {exc}"

    return payload.get("tables", {}), None


async def collect_database_service_live_columns():
    """The database service points at its own DATABASE_URL, which on this
    deployment is the SAME physical Postgres instance the cloud service
    uses (see notification_bridge.py's module docstring) -- but read it
    independently rather than assuming that, since a comparison against the
    wrong database is worse than no comparison."""
    import os

    from dotenv import load_dotenv
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    database_root = pathlib.Path(__file__).resolve().parents[2] / "database"
    load_dotenv(database_root / ".env")

    raw_url = os.getenv("DATABASE_URL", "")
    if raw_url:
        url = raw_url
    else:
        from urllib.parse import quote_plus

        user = os.getenv("DB_USER", "sa")
        password = quote_plus(os.getenv("DB_PASS", "Actin@#2931"))
        host = os.getenv("DB_HOST", "localhost")
        port = os.getenv("DB_PORT", "5432")
        name = os.getenv("DB_NAME", "actmon")
        url = f"postgresql://{user}:{password}@{host}:{port}/{name}"

    # asyncpg driver for the async engine; the service itself uses the sync
    # psycopg2 driver, but this is a read-only information_schema query and
    # the driver choice does not change what columns exist.
    async_url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(async_url)
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT table_name, column_name, data_type, is_nullable "
                "FROM information_schema.columns WHERE table_schema = 'public'"
            ))).all()
    finally:
        await engine.dispose()

    live = {}
    for table_name, column_name, data_type, is_nullable in rows:
        live.setdefault(table_name, {})[column_name] = {
            "type": data_type, "nullable": is_nullable == "YES",
        }
    return live


# ── The one comparison, applied to both services ────────────────────────────
def compare(service_name, model_tables, live_tables, live_counts=None):
    """Returns (missing, missing_tables, nullability_risks, type_mismatches,
    info_extra_columns). Pure function over plain dicts -- no DB, no
    service-specific import -- so both halves go through the exact same
    logic and cannot silently diverge in what counts as drift."""
    missing = []          # (table, column, model_type, nullable, has_default)
    missing_tables = []
    nullability_risks = []  # (table, column) -- non-null model col, nullable live, non-empty table
    type_mismatches = []    # (table, column, model_family, live_family)
    extra_columns = []      # (table, column) -- live has it, model doesn't (informational)

    for table, model_cols in model_tables.items():
        if table not in live_tables:
            missing_tables.append(table)
            continue
        live_cols = live_tables[table]
        for col_name, model_col in model_cols.items():
            if col_name not in live_cols:
                missing.append((table, col_name, model_col["type"],
                                model_col["nullable"], model_col["has_default"]))
                continue

            live_col = live_cols[col_name]
            model_family = type_family(model_col["type"])
            live_family = type_family(live_col["type"])
            if model_family != "other" and live_family != "other" \
                    and model_family != live_family:
                type_mismatches.append((table, col_name, model_family, live_family))

            if (not model_col["nullable"] and not model_col["has_default"]
                    and live_col["nullable"]):
                count = (live_counts or {}).get(table)
                if count:  # only a real risk once the table actually has rows
                    nullability_risks.append((table, col_name, count))

        for col_name in live_cols:
            if col_name not in model_cols:
                extra_columns.append((table, col_name))

    return missing, missing_tables, nullability_risks, type_mismatches, extra_columns


def report(service_name, missing, missing_tables, nullability_risks,
           type_mismatches, extra_columns):
    check(
        f"{service_name}: every model-declared table exists live",
        not missing_tables,
        f"missing tables: {missing_tables}" if missing_tables else "",
    )

    if missing:
        print(f"  [FAIL] {service_name}: every model-declared column exists live")
        print(f"         {len(missing)} missing column(s). Each one aborts any "
              f"session that touches its table:")
        for table, col, col_type, nullable, has_default in sorted(missing):
            null_sql = "" if nullable else " NOT NULL"
            default_sql = "" if not has_default else " DEFAULT <see model>"
            print(f"           {table}.{col}  ({col_type}{null_sql})")
            print(f"             -> ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "
                  f"{col} {col_type}{null_sql}{default_sql};")
        fail.append(f"{service_name}: every model-declared column exists live")
    else:
        check(f"{service_name}: every model-declared column exists live", True)

    check(
        f"{service_name}: no NOT-NULL-no-default model column is nullable "
        f"live on a non-empty table",
        not nullability_risks,
        (f"{[(t, c) for t, c, _ in nullability_risks]} -- an INSERT that "
         f"omits this column will fail once the ORM stops filling it in "
         f"implicitly") if nullability_risks else "",
    )

    check(
        f"{service_name}: no type-family mismatch between model and live column",
        not type_mismatches,
        str(type_mismatches[:5]) if type_mismatches else "",
    )

    if extra_columns:
        print(f"  [INFO] {service_name}: {len(extra_columns)} live column(s) "
              f"not declared on any model (informational, not a failure -- "
              f"likely owned by raw SQL or another service):")
        for table, col in sorted(extra_columns)[:10]:
            print(f"           {table}.{col}")


# ── Assertion 6/7: DDL <-> model cross-check (cloud only; database service
#    uses a different reconciliation mechanism entirely -- schema.sql +
#    db_setup.py -- checked separately in test_ddl_reconciliation) ─────────
def extract_ddl_columns_from_main():
    """Every `ALTER TABLE x ADD COLUMN IF NOT EXISTS y ...` literal in
    app/main.py's startup reconciliation block, as (table, column) pairs."""
    main_path = pathlib.Path(__file__).resolve().parents[1] / "app" / "main.py"
    source = main_path.read_text(encoding="utf-8")
    pattern = re.compile(
        r'ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)', re.I,
    )
    return set(pattern.findall(source))


def test_ddl_reconciliation(model_tables):
    section("DDL <-> model cross-check (the inverse drift)")

    ddl_pairs = extract_ddl_columns_from_main()
    check(
        "app/main.py's startup ALTER-TABLE block was actually found",
        len(ddl_pairs) > 5,
        f"found {len(ddl_pairs)} ADD COLUMN IF NOT EXISTS statements -- "
        f"expected several dozen; the regex or the file may have changed",
    )

    # Every column main.py adds via DDL must also be declared on the model
    # -- otherwise the DDL is reconciling a column the ORM does not know
    # about, which the ORM will never SELECT/INSERT correctly anyway.
    undeclared = []
    for table, column in ddl_pairs:
        model_cols = model_tables.get(table)
        if model_cols is not None and column not in model_cols:
            undeclared.append((table, column))
    check(
        "every column main.py's startup ALTER-TABLE block adds is declared "
        "on that table's model",
        not undeclared,
        str(undeclared) if undeclared else "",
    )


# ── Main ──────────────────────────────────────────────────────────────────
async def test_cloud():
    section("Cloud service: models vs live database")

    from app.core.database import AsyncSessionLocal

    model_tables = collect_cloud_model_columns()
    check("the cloud model half found a non-trivial number of tables",
          len(model_tables) >= 15, f"found {len(model_tables)}")

    try:
        async with AsyncSessionLocal() as db:
            live_tables = await collect_cloud_live_columns(db)
            live_counts = await collect_cloud_live_table_counts(
                db, [t for t in model_tables if t in live_tables])
    except Exception as exc:  # noqa: BLE001
        skip("cloud service: models vs live database", f"Postgres unreachable: {exc}")
        return model_tables

    check("the cloud live half found a non-trivial number of tables",
          len(live_tables) >= 15, f"found {len(live_tables)}")

    missing, missing_tables, risks, mismatches, extra = compare(
        "cloud", model_tables, live_tables, live_counts)
    report("cloud", missing, missing_tables, risks, mismatches, extra)

    test_ddl_reconciliation(model_tables)
    return model_tables


def test_database_service():
    section("Database service: models vs live database")

    model_tables, collect_err = collect_database_service_columns()
    if collect_err:
        skip("database service: models vs live database", collect_err)
        return

    check("the database-service model half found a non-trivial number of tables",
          len(model_tables) >= 10, f"found {len(model_tables)}")

    try:
        live_tables = asyncio.run(collect_database_service_live_columns())
    except Exception as exc:  # noqa: BLE001
        skip("database service: models vs live database",
             f"could not read the live database schema: {exc}")
        return

    check("the database-service live half found a non-trivial number of tables",
          len(live_tables) >= 10, f"found {len(live_tables)}")

    missing, missing_tables, risks, mismatches, extra = compare(
        "database", model_tables, live_tables, live_counts=None)
    report("database", missing, missing_tables, risks, mismatches, extra)

    # The three columns this suite exists to catch, named explicitly so a
    # green run is legible proof they were fixed, not just "no drift found".
    known = [
        ("alert_rules", "notification_channel_types"),
        ("agents", "agent_version"),
        ("os_servers", "patroni_api_port"),
    ]
    for table, column in known:
        present = column in live_tables.get(table, {})
        label = f"KNOWN ISSUE: {table}.{column} exists in the live database"
        if present:
            check(label, True)
        else:
            # Reported, but not double-counted against the run: it is
            # already inside `missing` above and already failed the
            # blanket assertion. This line exists so the specific incident
            # column is named in the summary, not buried in a list of five.
            print(f"  [FAIL] {label}  still missing -- this is the column "
                  f"that caused the Oracle report email storm")
            fail.append(label)


def main():
    print("Schema drift: ORM models vs the live database, both services")
    print("=" * 78)
    asyncio.run(test_cloud())
    test_database_service()

    print("\n" + "=" * 78)
    print(f"PASS {len(ok)}   FAIL {len(fail)}   SKIP {len(skipped)}")
    if skipped:
        print("\nSkipped -- these are NOT passes:")
        for s in skipped:
            print(f"  - {s}")
    if fail:
        print("\nFailed:")
        for f in fail:
            print(f"  - {f}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
