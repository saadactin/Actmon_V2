"""Resource actions: the gates, the audit trail, and the refusal.

Run: venv\\Scripts\\python.exe tests\\verify_resource_actions.py

This suite guards a deliberate state: NOTHING can currently mutate a cloud
resource, and the machinery that will one day allow it is already in place and
already closed. The assertions that must never quietly flip:

  2 - every mutating action is refused at the provider-support gate, because no
      adapter in app/providers/ implements a write. If one of these starts
      passing, a capability flag has been enabled and this suite is the alarm.
  4 - UNKNOWN state does not satisfy a state requirement. Starting a resource
      whose state nobody reported is acting on a guess.
  5 - a destructive action on a resource the topology graph does not know
      reports its dependents as UNKNOWN, never as none. "Nothing depends on
      this" is the most dangerous sentence this system could say wrongly.
  6 - the audit row is written even when the action is refused, and secrets in
      the request are masked before they reach the database.
  7 - the same operation_id never performs a second attempt.

Creates and removes its own account, resource and action rows.
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

from app.api import rbac
from app.models.cloud_account import CloudAccount
from app.models.resource import CloudResource
from app.models.resource_action import CloudResourceAction, REFUSED
from app.services import resource_capabilities as caps
from app.services import resource_model as rm
from app.services.resource_action_service import (
    ACTION_SPEC, IMPLEMENTED, ActionError, ResourceActionService, available_actions,
    mask,
)

ok, fail = [], []
PREFIX = "zza-test-"


def check(label, cond, detail=""):
    (ok if cond else fail).append(label)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def principal(role=rbac.ROLE_ADMIN, name="tester"):
    return rbac.Principal(
        name=name, role=role,
        permissions=set(rbac.ROLE_PERMISSIONS.get(role, set())),
        authenticated=True, enforced=True,
    )


async def purge(db):
    rows = (await db.execute(
        select(CloudAccount.id).where(CloudAccount.account_name.like(f"{PREFIX}%"))
    )).all()
    ids = [r[0] for r in rows]
    if ids:
        await db.execute(delete(CloudResourceAction).where(
            CloudResourceAction.account_id.in_(ids)))
        await db.execute(delete(CloudResource).where(
            CloudResource.account_id.in_(ids)))
        await db.execute(delete(CloudAccount).where(CloudAccount.id.in_(ids)))
        await db.commit()
    return len(ids)


async def main():
    async with AsyncSessionLocal() as db:
        await purge(db)
        accounts_before = int((await db.execute(
            select(func.count()).select_from(CloudAccount))).scalar() or 0)
        svc = ResourceActionService(db)

        try:
            account = CloudAccount(
                id=uuid.uuid4(), account_name=f"{PREFIX}oci", provider="OCI",
                credentials_enc="x", tenant_or_region="ap-mumbai-1",
                environment="test",
            )
            db.add(account)
            await db.flush()

            def res(name, rtype, status, **kw):
                return CloudResource(
                    account_id=account.id,
                    provider_resource_id=f"ocid1.{name}",
                    resource_type=rtype, resource_name=name,
                    region_or_zone="ap-mumbai-1", status=status,
                    normalized_status=status, discovered_at=datetime.now(timezone.utc),
                    **kw,
                )

            running = res("running-vm", "ComputeInstance", rm.RUNNING)
            stopped = res("stopped-vm", "ComputeInstance", rm.STOPPED)
            unknown = res("unknown-vm", "ComputeInstance", rm.UNKNOWN)
            db.add_all([running, stopped, unknown])
            await db.commit()

            print("\n1. The action vocabulary is coherent")
            for name, spec in ACTION_SPEC.items():
                check(f"{name} declares a capability", bool(spec["capability"]))
                check(f"{name} declares destructiveness",
                      isinstance(spec["destructive"], bool))
            check("delete is destructive", ACTION_SPEC["delete"]["destructive"])
            check("start is not destructive", not ACTION_SPEC["start"]["destructive"])

            print("\n2. Every mutating action is refused: no adapter implements a write")
            for provider in ("AWS", "Azure", "OCI"):
                for row in available_actions(provider):
                    if row["action"] == "refresh":
                        continue  # a read, not a mutation
                    check(f"{provider} {row['action']} is unsupported",
                          row["supported"] is False)
                    check(f"{provider} {row['action']} says why",
                          bool(row["reason"]))
            check("nothing at all is wired into the action layer",
                  IMPLEMENTED == frozenset(), str(set(IMPLEMENTED)))

            print("\n3. Permission gates")
            viewer = await svc.preview(running.id, "stop", principal=principal(rbac.ROLE_VIEWER))
            check("a viewer is not authorized to stop", viewer["authorized"] is False)
            check("...and is told which permission is missing",
                  "resources:action" in (viewer["reasons"]["authorization"] or ""),
                  str(viewer["reasons"]["authorization"])[:70])
            admin = await svc.preview(running.id, "stop", principal=principal())
            check("an administrator is authorized", admin["authorized"] is True)
            none_p = await svc.preview(running.id, "stop", principal=None)
            check("no principal is never authorized", none_p["authorized"] is False)

            print("\n4. State gates — and UNKNOWN is not a free pass")
            stop_running = await svc.preview(running.id, "stop", principal=principal())
            check("stop applies to a RUNNING resource", stop_running["state_valid"])
            start_running = await svc.preview(running.id, "start", principal=principal())
            check("start does NOT apply to a RUNNING resource",
                  start_running["state_valid"] is False)
            start_stopped = await svc.preview(stopped.id, "start", principal=principal())
            check("start applies to a STOPPED resource", start_stopped["state_valid"])
            start_unknown = await svc.preview(unknown.id, "start", principal=principal())
            check("start does NOT apply when the state is UNKNOWN",
                  start_unknown["state_valid"] is False)
            check("...and says the state is unreported, not wrong",
                  "not reported" in (start_unknown["reasons"]["state"] or "").lower(),
                  str(start_unknown["reasons"]["state"])[:80])
            tag_unknown = await svc.preview(unknown.id, "tag", principal=principal())
            check("a stateless action is unaffected by UNKNOWN",
                  tag_unknown["state_valid"] is True)

            print("\n5. Dependencies: a confirmed none and an unknown read differently")
            delete_preview = await svc.preview(running.id, "delete", principal=principal())
            note = delete_preview["dependency_note"] or ""
            check("a destructive action always reports a dependency note",
                  bool(note), note[:70])
            # The fixture IS in the topology graph (it is a real row in a real
            # account), so this is the confirmed-none branch. The wording has to
            # say the graph was consulted — an empty list with no note would be
            # indistinguishable from the graph being unavailable.
            check("a confirmed none says the graph was consulted",
                  "knows this resource" in note, note[:70])
            check("...and it is not phrased as unknown", "unknown" not in note.lower())
            check("no dependents were invented", delete_preview["dependencies"] == [])
            # The dangerous branch, exercised directly: a resource the graph
            # cannot place must report unknown, never none.
            unknown_deps, unknown_note = await svc._dependencies(  # noqa: SLF001
                res("ghost", "ComputeInstance", rm.RUNNING), destructive=True,
            )
            check("a resource absent from the graph reports UNKNOWN dependents",
                  "unknown" in (unknown_note or "").lower(), str(unknown_note)[:80])
            check("...and still invents no dependents", unknown_deps == [])
            check("a non-destructive action does not run the graph",
                  (await svc.preview(running.id, "tag", principal=principal()))["dependency_note"] is None)

            print("\n6. safe is the conjunction of every gate")
            check("supported=False forces safe=False", stop_running["safe"] is False)
            check("...even though authorization and state passed",
                  stop_running["authorized"] and stop_running["state_valid"])

            print("\n7. Execution is refused, and audited anyway")
            op = f"{PREFIX}op-1"
            result = await svc.execute(
                running.id, "stop", principal=principal(), operation_id=op,
                params={"client_secret": "hunter2", "force": True},
            )
            check("the action is REFUSED", result["status"] == REFUSED, result["status"])
            check("the refusal names the reason", bool(result["refusal_reason"]))
            check("before_state was recorded from stored data",
                  (result["before_state"] or {}).get("status") == rm.RUNNING)
            check("after_state is absent — nothing happened",
                  result["after_state"] is None)
            check("the actor is recorded", result["actor"] == "tester")

            row = (await db.execute(select(CloudResourceAction).where(
                CloudResourceAction.operation_id == op))).scalar_one()
            check("the audit row exists despite the refusal", row is not None)
            check("the secret in the request was masked",
                  row.request["params"]["client_secret"] == "********",
                  str(row.request["params"]))
            check("...while the ordinary parameter survived",
                  row.request["params"]["force"] is True)

            print("\n8. Idempotency: one operation_id, one attempt")
            replay = await svc.execute(
                running.id, "stop", principal=principal(), operation_id=op,
            )
            check("the replay is flagged", replay.get("idempotent_replay") is True)
            check("...and returns the original record", replay["id"] == result["id"])
            count = int((await db.execute(
                select(func.count()).select_from(CloudResourceAction)
                .where(CloudResourceAction.operation_id == op))).scalar() or 0)
            check("only one audit row exists for it", count == 1, str(count))

            print("\n9. Bulk preview counts every bucket separately")
            bulk = await svc.preview_bulk(
                [running.id, stopped.id, unknown.id], "start", principal=principal(),
            )
            check("selected is the full selection", bulk["selected"] == 3)
            check("unsupported counts all three", bulk["unsupported"] == 3)
            check("wrong_state counts the two that cannot start",
                  bulk["wrong_state"] == 2, str(bulk["wrong_state"]))
            check("would_apply is zero", bulk["would_apply"] == 0)
            check("per-resource detail is returned", len(bulk["items"]) == 3)

            try:
                await svc.preview_bulk([], "start", principal=principal())
                check("an empty selection is refused", False, "it was accepted")
            except ActionError:
                check("an empty selection is refused", True)

            print("\n10. Unknown actions and resources are refused cleanly")
            for label, coro in (
                ("an unknown action", svc.preview(running.id, "self_destruct", principal=principal())),
                ("an unknown resource", svc.preview(uuid.uuid4(), "stop", principal=principal())),
            ):
                try:
                    await coro
                    check(f"{label} is refused", False, "it was accepted")
                except ActionError:
                    check(f"{label} is refused", True)

            print("\n11. Masking is recursive and key-based")
            masked = mask({
                "a": {"password": "x", "keep": 1},
                "list": [{"access_key": "AKIA"}],
                "plain": "visible",
            })
            check("nested secrets are masked", masked["a"]["password"] == "********")
            check("siblings survive", masked["a"]["keep"] == 1)
            check("secrets inside lists are masked",
                  masked["list"][0]["access_key"] == "********")
            check("ordinary values survive", masked["plain"] == "visible")

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
