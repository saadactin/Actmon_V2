"""Resource-wise assessment export: category mapping, the NA-vs-clean rule for
anomalies, graceful degradation, and the formula-injection CSV guard.

Run: venv\\Scripts\\python.exe tests\\verify_resource_assessment.py

What must never quietly flip:

  1 - CloudOptimizationFinding buckets correctly into Utilization/Performance/
      Other by signal and category, never guessed.
  2 - a resource with nothing in a category still gets a "No findings"/
      "No data" row for it -- never silently absent.
  3 - a resource id that does not belong to the requested account is reported
      as an error row, not skipped and not raised as an exception that kills
      the whole batch.
  4 - an account with no stored billing history reports anomalies as "Not
      checked", never as "No anomalies" -- conflating "never checked" with
      "checked, clean" is the exact false-all-clear this product's cost
      module exists to prevent elsewhere (cost_money.py).
  5 - more than MAX_RESOURCES_PER_EXPORT resource ids raises, rather than
      silently truncating or running an unbounded fan-out.
  6 - a value that would be read as an Excel formula is escaped in the CSV.

Creates and removes its own account, resources, findings and telemetry rows.
"""
import asyncio
import pathlib
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import logging
for _name in ("sqlalchemy.engine", "sqlalchemy.engine.Engine", "sqlalchemy.pool"):
    _lg = logging.getLogger(_name)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    _lg.disabled = True

from sqlalchemy import delete, func, select

from app.core.database import AsyncSessionLocal, engine
engine.echo = False

from app.models.cloud_account import CloudAccount
from app.models.optimization import CloudOptimizationFinding, CloudResourceTelemetry
from app.models.resource import CloudResource
from app.models.security_finding import CloudSecurityFinding
from app.api.routes.resources import _assessment_csv_cell
from app.services.resource_assessment_service import (
    CATEGORY_ANOMALY, CATEGORY_OTHER_OPT, CATEGORY_PERFORMANCE,
    CATEGORY_SECURITY, CATEGORY_UTILIZATION, MAX_RESOURCES_PER_EXPORT,
    TooManyResourcesError, _optimization_category, build_assessment_rows,
)

ok, fail = [], []
PREFIX = "zzra-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def purge(db):
    rows = (await db.execute(
        select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%"))
    )).all()
    ids = [r[0] for r in rows]
    if ids:
        await db.execute(delete(CloudSecurityFinding).where(CloudSecurityFinding.account_id.in_(ids)))
        await db.execute(delete(CloudOptimizationFinding).where(CloudOptimizationFinding.account_id.in_(ids)))
        await db.execute(delete(CloudResourceTelemetry).where(CloudResourceTelemetry.account_id.in_(ids)))
        await db.execute(delete(CloudResource).where(CloudResource.account_id.in_(ids)))
        await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.commit()
    return len(ids)


class _Signal:
    """A tiny stand-in with just the attributes `_optimization_category` reads,
    so rule 1 is checked without a DB round trip."""

    def __init__(self, category, signal):
        self.category = category
        self.signal = signal


async def main():
    print("\n1. Optimization findings bucket by signal/category, never guessed")
    check("UNUSED -> Utilization",
          _optimization_category(_Signal("COST", "UNUSED")) == CATEGORY_UTILIZATION)
    check("UNDERUTILIZED -> Utilization",
          _optimization_category(_Signal("RIGHTSIZING", "UNDERUTILIZED")) == CATEGORY_UTILIZATION)
    check("category=PERFORMANCE -> Performance",
          _optimization_category(_Signal("PERFORMANCE", "CONFIGURATION")) == CATEGORY_PERFORMANCE)
    check("signal=CONSTRAINED -> Performance",
          _optimization_category(_Signal("DATABASE", "CONSTRAINED")) == CATEGORY_PERFORMANCE)
    check("an unmatched category/signal -> Other, not forced into either",
          _optimization_category(_Signal("NETWORK", "CONFIGURATION")) == CATEGORY_OTHER_OPT)

    print("\n2. The formula-injection CSV guard")
    check("a leading '=' is escaped", _assessment_csv_cell("=cmd|' /C calc'!A1").startswith("'="))
    check("a leading '+' is escaped", _assessment_csv_cell("+1+1").startswith("'+"))
    check("an ordinary value passes through", _assessment_csv_cell("normal-name") == "normal-name")
    check("None becomes an empty string, not the word None", _assessment_csv_cell(None) == "")

    async with AsyncSessionLocal() as db:
        await purge(db)
        accounts_before = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)

        try:
            account = CloudAccount(
                id=uuid.uuid4(), account_name=f"{PREFIX}oci", provider="OCI",
                credentials_enc="x", tenant_or_region="ap-mumbai-1",
                environment="test",
            )
            db.add(account)
            await db.flush()

            def res(name):
                return CloudResource(
                    id=uuid.uuid4(), account_id=account.id,
                    provider_resource_id=f"ocid1.{name}", resource_type="ComputeInstance",
                    resource_name=name, region_or_zone="ap-mumbai-1", status="RUNNING",
                    discovered_at=datetime.now(timezone.utc),
                )

            covered = res("covered-vm")   # has a finding in every section
            clean = res("clean-vm")       # has nothing anywhere
            db.add_all([covered, clean])
            await db.flush()

            db.add(CloudSecurityFinding(
                id=uuid.uuid4(), account_id=account.id, provider="OCI",
                fingerprint=f"{PREFIX}sec-1", rule_id="test.rule", rule_version="1",
                resource_key=covered.provider_resource_id, resource_id=covered.id,
                resource_name=covered.resource_name, resource_type=covered.resource_type,
                title="Public bucket", description="d", severity="HIGH",
                category="Exposure", verdict="VULNERABLE", confidence="HIGH", status="OPEN",
            ))
            db.add(CloudOptimizationFinding(
                id=uuid.uuid4(), account_id=account.id, provider="OCI",
                fingerprint=f"{PREFIX}opt-1", rule_id="test.rightsizing", rule_version="1",
                resource_key=covered.provider_resource_id, resource_id=covered.id,
                resource_name=covered.resource_name, resource_type=covered.resource_type,
                category="RIGHTSIZING", severity="MEDIUM", signal="UNDERUTILIZED",
                title="Oversized shape", description="d", confidence="MEDIUM",
            ))
            db.add(CloudResourceTelemetry(
                id=uuid.uuid4(), account_id=account.id, resource_id=covered.id,
                provider="OCI", metric="cpu_utilization", status="OK",
                stats={"avg": 4.2, "max": 11.0}, samples=720,
            ))
            await db.commit()

            print("\n3. A resource with findings in every section")
            rows = await build_assessment_rows(db, account.id, [covered.id])
            by_cat = {}
            for r in rows:
                by_cat.setdefault(r["assessment_category"], []).append(r)
            check("security row present", any(
                r["title"] == "Public bucket" for r in by_cat.get(CATEGORY_SECURITY, [])))
            check("utilization row present (from the optimization finding)", any(
                r["title"] == "Oversized shape" for r in by_cat.get(CATEGORY_UTILIZATION, [])))
            check("a second utilization row from telemetry is also present", len(
                [r for r in by_cat.get(CATEGORY_UTILIZATION, []) if "cpu" in (r["title"] or "").lower()]) == 1)
            check("no Performance finding exists, so Performance reports 'No findings'", any(
                r["title"] == "No findings" for r in by_cat.get(CATEGORY_PERFORMANCE, [])))
            check("Other Optimization Finding is skipped entirely when empty (not padded)",
                  CATEGORY_OTHER_OPT not in by_cat)
            check("account has no stored billing history -> anomalies read 'Not checked'", any(
                r["title"].startswith("Not checked") for r in by_cat.get(CATEGORY_ANOMALY, [])),
                str([r["title"] for r in by_cat.get(CATEGORY_ANOMALY, [])]))
            check("anomalies are never silently claimed clean with no data", not any(
                r["title"] == "No anomalies" for r in by_cat.get(CATEGORY_ANOMALY, [])))

            print("\n4. A resource with nothing anywhere is still fully represented")
            rows_clean = await build_assessment_rows(db, account.id, [clean.id])
            by_cat_clean = {}
            for r in rows_clean:
                by_cat_clean.setdefault(r["assessment_category"], []).append(r)
            check("security: 'No findings', not absent", any(
                r["title"] == "No findings" for r in by_cat_clean.get(CATEGORY_SECURITY, [])))
            check("utilization: 'No findings'/'No data', not absent", any(
                r["title"] in ("No findings", "No data") for r in by_cat_clean.get(CATEGORY_UTILIZATION, [])))
            check("performance: 'No findings', not absent", any(
                r["title"] == "No findings" for r in by_cat_clean.get(CATEGORY_PERFORMANCE, [])))

            print("\n5. A resource id outside this account is an error row, not a crash")
            foreign_id = uuid.uuid4()
            rows_bad = await build_assessment_rows(db, account.id, [foreign_id])
            check("exactly one row, categorised as an error", len(rows_bad) == 1
                  and rows_bad[0]["assessment_category"] == "Error")
            check("the row names the id that was not found",
                  rows_bad[0]["provider_resource_id"] == str(foreign_id))

            print("\n6. The batch cap is enforced, not silently truncated")
            too_many = [uuid.uuid4() for _ in range(MAX_RESOURCES_PER_EXPORT + 1)]
            try:
                await build_assessment_rows(db, account.id, too_many)
                check(f"{len(too_many)} resource ids is refused", False, "it was accepted")
            except TooManyResourcesError:
                check(f"{len(too_many)} resource ids is refused", True)

            print("\n7. A mixed batch keeps each resource's rows attributed correctly")
            rows_mixed = await build_assessment_rows(db, account.id, [covered.id, clean.id])
            covered_rows = [r for r in rows_mixed if r["provider_resource_id"] == covered.provider_resource_id]
            clean_rows = [r for r in rows_mixed if r["provider_resource_id"] == clean.provider_resource_id]
            check("the covered resource's rows did not leak onto the clean one", not any(
                r["title"] == "Public bucket" for r in clean_rows))
            check("both resources are represented in one batch",
                  len(covered_rows) > 0 and len(clean_rows) > 0)

        finally:
            await db.rollback()
            removed = await purge(db)
            print(f"\n(removed {removed} fixture account(s))")

    async with AsyncSessionLocal() as db:
        after = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)
    check("the account list is left as it was found", after == accounts_before,
          f"{accounts_before} -> {after}")
    await engine.dispose()


asyncio.run(main())

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
