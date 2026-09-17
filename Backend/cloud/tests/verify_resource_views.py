"""Saved Resources views, against the real database.

Run: venv\\Scripts\\python.exe tests\\verify_resource_views.py

The load-bearing sections:

  2  - a filter set is validated against the QUERY LAYER, not against a list of
       key names kept here. A view that saves cleanly and then fails when
       applied is worse than one that refuses to save.
  4  - saving over an existing name updates that view. The alternative is a
       menu with three entries called "Untagged production" that differ
       invisibly.
  6  - a stored filter the query layer no longer supports is DROPPED and
       reported, not silently ignored. Silently ignoring it returns more rows
       than the view used to and still looks like it worked.

Creates and removes its own views, and asserts the view count is restored.
"""
import asyncio
import pathlib
import sys
import uuid

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

from app.models.resource_view import SavedResourceView
from app.services.resource_view_service import (
    MAX_NAME, ResourceViewService, ViewValidationError,
)

ok, fail = [], []
PREFIX = "zzv-test-"
OWNER = f"{PREFIX}owner"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


async def purge(db):
    await db.execute(delete(SavedResourceView).where(
        SavedResourceView.name.like(f"{PREFIX}%")))
    await db.execute(delete(SavedResourceView).where(
        SavedResourceView.owner == OWNER))
    await db.commit()


async def main():
    async with AsyncSessionLocal() as db:
        await purge(db)
        before = int((await db.execute(
            select(func.count()).select_from(SavedResourceView))).scalar() or 0)
        svc = ResourceViewService(db)

        try:
            print("\n1. A view round-trips")
            saved = await svc.save(
                owner=OWNER, name=f"{PREFIX}stopped", scope="ALL",
                filters={"status": ["STOPPED"], "has_cost": True},
                sort="cost", direction="DESC", group_by="region",
                columns=["risk", "name", "cost"],
            )
            check("it comes back with an id", bool(saved["id"]))
            check("filters survive", saved["filters"] == {"status": ["STOPPED"], "has_cost": True},
                  str(saved["filters"]))
            check("sort survives", saved["sort"] == "cost")
            check("direction is normalized to lower case", saved["dir"] == "desc", str(saved["dir"]))
            check("group_by survives", saved["group_by"] == "region")
            check("columns survive", saved["columns"] == ["risk", "name", "cost"])
            check("nothing was dropped", saved["dropped_filters"] == [])

            print("\n2. Filters are validated against the query layer itself")
            for label, bad in (
                ("an invalid status", {"status": ["NOT_A_STATUS"]}),
                ("an invalid risk level", {"risk": ["VERY_BAD"]}),
                ("an invalid attachment", {"attachment": "GLUED"}),
            ):
                try:
                    await svc.save(owner=OWNER, name=f"{PREFIX}bad", scope="ALL", filters=bad)
                    check(f"{label} is refused", False, "it saved")
                except ViewValidationError:
                    check(f"{label} is refused", True)

            try:
                await svc.save(owner=OWNER, name=f"{PREFIX}bad", scope="ALL",
                               filters={"definitely_not_a_filter": 1})
                check("an unknown filter key is refused", False, "it saved")
            except ViewValidationError as exc:
                check("an unknown filter key is refused", True)
                check("...and the message names it",
                      "definitely_not_a_filter" in str(exc), str(exc))

            try:
                await svc.save(owner=OWNER, name=f"{PREFIX}bad", scope="ALL",
                               filters={}, sort="; DROP TABLE")
                check("an invalid sort is refused", False, "it saved")
            except ViewValidationError:
                check("an invalid sort is refused", True)

            print("\n3. A name is required and bounded")
            for label, name in (("an empty name", "  "), ("an over-long name", "x" * (MAX_NAME + 1))):
                try:
                    await svc.save(owner=OWNER, name=name, scope="ALL", filters={})
                    check(f"{label} is refused", False, "it saved")
                except ViewValidationError:
                    check(f"{label} is refused", True)

            print("\n4. Saving over a name updates rather than duplicating")
            again = await svc.save(
                owner=OWNER, name=f"{PREFIX}stopped", scope="ALL",
                filters={"status": ["RUNNING"]},
            )
            check("the id is the same view", again["id"] == saved["id"],
                  f"{saved['id']} -> {again['id']}")
            check("the filters were replaced, not merged",
                  again["filters"] == {"status": ["RUNNING"]}, str(again["filters"]))
            mine = await svc.list_views(OWNER)
            check("there is still exactly one", len(mine) == 1, str(len(mine)))

            print("\n5. Scope decides where a view is offered")
            account = str(uuid.uuid4())
            await svc.save(owner=OWNER, name=f"{PREFIX}scoped", scope=account, filters={})
            in_account = [v["name"] for v in await svc.list_views(OWNER, account)]
            in_other = [v["name"] for v in await svc.list_views(OWNER, str(uuid.uuid4()))]
            in_global = [v["name"] for v in await svc.list_views(OWNER, "ALL")]
            check("offered in its own account", f"{PREFIX}scoped" in in_account)
            check("NOT offered in a different account", f"{PREFIX}scoped" not in in_other,
                  str(in_other))
            check("an ALL-scoped view is offered in an account",
                  f"{PREFIX}stopped" in in_account)
            check("and a scoped view is reachable from the global view",
                  f"{PREFIX}scoped" in in_global)

            print("\n6. A filter the query layer no longer supports is dropped, and said so")
            # Written straight to the column, which is what a view saved before
            # a filter was removed would look like on the next deploy.
            row = (await db.execute(select(SavedResourceView).where(
                SavedResourceView.name == f"{PREFIX}scoped"))).scalar_one()
            row.filters = {"status": ["STOPPED"], "retired_filter": "x"}
            await db.commit()
            reread = [v for v in await svc.list_views(OWNER) if v["name"] == f"{PREFIX}scoped"][0]
            check("the supported filter survives",
                  reread["filters"] == {"status": ["STOPPED"]}, str(reread["filters"]))
            check("the retired one is dropped from the usable set",
                  "retired_filter" not in reread["filters"])
            check("...and is REPORTED rather than hidden",
                  reread["dropped_filters"] == ["retired_filter"],
                  str(reread["dropped_filters"]))

            print("\n7. Views belong to their owner")
            others = await svc.list_views("someone-else")
            check("another caller does not see them",
                  not [v for v in others if v["name"].startswith(PREFIX)], str(len(others)))
            try:
                await svc.delete(uuid.UUID(saved["id"]), "someone-else")
                check("another caller cannot delete them", False, "it deleted")
            except ViewValidationError:
                check("another caller cannot delete them", True)

            print("\n8. Delete")
            check("delete returns True", await svc.delete(uuid.UUID(saved["id"]), OWNER))
            check("deleting again returns False, not an error",
                  await svc.delete(uuid.UUID(saved["id"]), OWNER) is False)

        finally:
            await db.rollback()
            await purge(db)

    async with AsyncSessionLocal() as db:
        after = int((await db.execute(
            select(func.count()).select_from(SavedResourceView))).scalar() or 0)
    check("the saved-view table is left as it was found", after == before,
          f"{before} -> {after}")
    await engine.dispose()


asyncio.run(main())

print(f"\n=== {len(ok)} passed, {len(fail)} failed ===")
if fail:
    for f in fail:
        print("  FAILED:", f)
    sys.exit(1)
