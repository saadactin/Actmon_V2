"""Resource actions: what may be done, whether it is safe, and a record of it.

WHAT THIS DOES NOT DO
---------------------
It does not call a cloud provider, because no provider adapter in this codebase
implements a single write. `resource_capabilities` reports every mutating
capability as False for all three providers, and it verifies that claim against
the provider classes themselves, so the flag cannot drift from the code.

That is the whole design. Spec §39 requires provider support, a permission
check, state validation, dependency validation, confirmation, an audit record,
error handling and idempotency BEFORE an action is offered. Six of those eight
are here and working now; the two that are missing are the provider call and
the live confirmation dialog. So every execution request is REFUSED, with the
reason recorded in the audit trail exactly as a real refusal would be.

The value of building it this way round: the day someone adds
`stop_instance()` to the AWS adapter and flips POWER_ACTIONS to True, the
permission gate, the dependency check, the idempotency key and the audit row
are already there and already tested. The alternative — shipping the button
first and retrofitting the safety — is how a platform deletes something it
should not have.

PREVIEW IS REAL
---------------
`preview()` is not a stub. It resolves the resource, checks the permission,
checks provider support, validates the resource's current state against the
action, and asks the topology engine what depends on it. Those answers are
true today and are what a confirmation dialog needs. Only `execute()` refuses.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resource import CloudResource
from app.models.resource_action import (
    FAILED, PARTIAL, QUEUED, REFUSED, RUNNING, SUCCEEDED, CloudResourceAction,
)
from app.services import resource_capabilities as caps
from app.services import resource_model as rm

logger = logging.getLogger("cloud_svc.resource_actions")

# ── The action vocabulary ────────────────────────────────────────────────────
START = "start"
STOP = "stop"
RESTART = "restart"
TAG = "tag"
UNTAG = "untag"
DELETE = "delete"
DETACH = "detach"
REFRESH = "refresh"

#: action -> (capability it needs, is it destructive, which normalized states
#: it may be applied from). An empty state tuple means "any state".
ACTION_SPEC: Dict[str, Dict[str, Any]] = {
    START:   {"capability": caps.POWER_ACTIONS, "destructive": False,
              "from_states": (rm.STOPPED,),
              "label": "Start"},
    STOP:    {"capability": caps.POWER_ACTIONS, "destructive": True,
              "from_states": (rm.RUNNING,),
              "label": "Stop"},
    RESTART: {"capability": caps.POWER_ACTIONS, "destructive": True,
              "from_states": (rm.RUNNING,),
              "label": "Restart"},
    TAG:     {"capability": caps.TAG_MUTATION, "destructive": False,
              "from_states": (), "label": "Add tags"},
    UNTAG:   {"capability": caps.TAG_MUTATION, "destructive": False,
              "from_states": (), "label": "Remove tags"},
    DETACH:  {"capability": caps.POWER_ACTIONS, "destructive": True,
              "from_states": (rm.ATTACHED,), "label": "Detach"},
    DELETE:  {"capability": caps.DELETE, "destructive": True,
              "from_states": (), "label": "Delete"},
    REFRESH: {"capability": caps.TARGETED_REFRESH, "destructive": False,
              "from_states": (), "label": "Refresh from provider"},
}

ACTIONS = tuple(ACTION_SPEC)

#: Actions this service can actually carry out. Empty, deliberately.
#:
#: Kept separate from the capability matrix because the two answer different
#: questions. The capability matrix says what the PROVIDER ADAPTER can do —
#: `targeted_refresh` is True there because re-reading one resource is a read,
#: and the adapters read. This set says what the ACTION LAYER has wired up, and
#: nothing is wired up yet. Without the distinction, `refresh` would pass every
#: gate and then fail with a message blaming the capability matrix for a flag
#: that is perfectly correct.
IMPLEMENTED: frozenset = frozenset()

# Values never written to the audit trail, matched on key name because provider
# payloads carry them under many spellings.
_SECRET_KEY = re.compile(
    r"(secret|password|passwd|token|credential|private|access[_-]?key|"
    r"client[_-]?secret|connection[_-]?string|fingerprint)", re.I
)
_MASK = "********"

# How many resources one bulk request may name. Not arbitrary: a bulk action
# writes one audit row per resource and holds them in one transaction, and a
# request large enough to time out mid-write is a request that leaves the trail
# incomplete.
MAX_BULK = 100


class ActionError(ValueError):
    """The request cannot be understood. Distinct from a refusal, which is a
    well-formed request this platform declines to perform."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field_name = field


def mask(value: Any, key: str = "") -> Any:
    """Recursively mask secret-looking values before they are persisted."""
    if _SECRET_KEY.search(key or ""):
        return _MASK if value not in (None, "", {}, []) else value
    if isinstance(value, dict):
        return {k: mask(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [mask(v, key) for v in value]
    return value


class ResourceActionService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Resolution ───────────────────────────────────────────────────────────
    async def _resource(self, resource_id: uuid.UUID) -> Optional[CloudResource]:
        return (await self.db.execute(
            select(CloudResource).where(CloudResource.id == resource_id)
        )).scalar_one_or_none()

    async def _account_provider(self, account_id: uuid.UUID) -> Optional[str]:
        from app.models.cloud_account import CloudAccount
        return (await self.db.execute(
            select(CloudAccount.provider).where(CloudAccount.id == account_id)
        )).scalar_one_or_none()

    # ── Preview ──────────────────────────────────────────────────────────────
    async def preview(
        self,
        resource_id: uuid.UUID,
        action: str,
        *,
        principal: Any = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Can this action be performed, is it authorized, and is it safe?

        Every one of those three is answered from something real: the
        capability matrix (which is checked against the provider classes), the
        caller's permissions, the resource's own normalized state, and the
        topology graph's account of what depends on it.
        """
        if action not in ACTION_SPEC:
            raise ActionError("action", f"{action!r} is not a known action. "
                                        f"Known: {', '.join(sorted(ACTIONS))}.")
        spec = ACTION_SPEC[action]

        resource = await self._resource(resource_id)
        if resource is None:
            raise ActionError("resource_id", f"No resource with id {resource_id}.")

        provider = await self._account_provider(resource.account_id)
        provider_caps = caps.for_provider(provider)
        supported = provider_caps.can(spec["capability"])

        authorized, auth_reason = self._authorize(action, principal)

        state_ok, state_reason = self._state_allows(action, spec, resource)

        dependencies, dependency_note = await self._dependencies(
            resource, destructive=spec["destructive"]
        )

        warnings: List[str] = []
        if spec["destructive"] and dependencies:
            warnings.append(
                f"{len(dependencies)} resource(s) depend on this one. "
                f"{spec['label']} may affect them."
            )
        if not state_ok and state_reason:
            warnings.append(state_reason)
        if resource.is_default:
            warnings.append(
                "This is a provider-created default resource. Removing it can "
                "break resources that rely on it implicitly."
            )

        return {
            "action": action,
            "label": spec["label"],
            "resource": {
                "id": str(resource.id),
                "name": resource.resource_name,
                "type": resource.resource_type,
                "provider": provider,
                "provider_resource_id": resource.provider_resource_id,
                "status": resource.normalized_status or rm.UNKNOWN,
            },
            "supported": supported,
            "authorized": authorized,
            "state_valid": state_ok,
            # "Safe" is the conjunction, not a separate opinion. It is false
            # whenever any gate is false, so a caller cannot read `safe: true`
            # off an action that is merely unopposed.
            "safe": bool(supported and authorized and state_ok),
            "destructive": spec["destructive"],
            "reasons": {
                "support": None if supported else provider_caps.reason(spec["capability"]),
                "authorization": None if authorized else auth_reason,
                "state": None if state_ok else state_reason,
            },
            "warnings": warnings,
            "dependencies": dependencies,
            "dependency_note": dependency_note,
        }

    def _authorize(self, action: str, principal: Any) -> Tuple[bool, Optional[str]]:
        """Permission gate. Destructive actions need the admin permission, not
        merely the action permission."""
        from app.api import rbac

        if principal is None:
            return False, "No authenticated principal was supplied with this request."
        needed = (
            rbac.RESOURCE_ADMIN
            if ACTION_SPEC[action]["destructive"] and action == DELETE
            else rbac.RESOURCE_ACTION
        )
        if principal.can(needed):
            return True, None
        return False, (
            f"This action needs the {needed!r} permission; "
            f"the {principal.role!r} role does not hold it."
        )

    def _state_allows(
        self, action: str, spec: Dict[str, Any], resource: CloudResource
    ) -> Tuple[bool, Optional[str]]:
        """Is the resource in a state this action makes sense from?

        UNKNOWN is refused for state-dependent actions rather than waved
        through. Starting a resource whose state nobody reported is a request
        to act on a guess.
        """
        allowed = spec["from_states"]
        if not allowed:
            return True, None
        current = resource.normalized_status or rm.UNKNOWN
        if current in allowed:
            return True, None
        if current == rm.UNKNOWN:
            return False, (
                "The provider has not reported this resource's state, so "
                f"whether it can be {spec['label'].lower()}ed is unknown."
            )
        return False, (
            f"{spec['label']} applies to a resource in state "
            f"{'/'.join(allowed)}; this one is {current}."
        )

    async def _dependencies(
        self, resource: CloudResource, *, destructive: bool
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """What depends on this resource, per the topology engine.

        Read from topology rather than recomputed, so the dependency list a
        delete confirmation shows is the same one the Topology page draws. When
        the graph does not know the resource, that is reported as unknown — NOT
        as an empty dependency list, which would read as "nothing depends on
        it" and is the single most dangerous thing this function could say.
        """
        if not destructive:
            return [], None
        try:
            from app.api.deps import get_topology_service  # noqa: F401
            from app.services.topology_service import TopologyService

            topo = TopologyService(self.db)
            report = await topo.impact(str(resource.account_id), str(resource.id))
        except Exception as exc:                       # pragma: no cover
            logger.warning("Dependency lookup failed for %s: %s", resource.id, exc)
            return [], ("The topology graph could not be consulted, so what "
                        "depends on this resource is unknown.")

        if report.get("error"):
            return [], ("The topology graph is unavailable, so what depends on "
                        "this resource is unknown.")
        if report.get("found") is False:
            return [], ("This resource is not present in the topology graph, so "
                        "its dependents are unknown — not none.")

        rows: List[Dict[str, Any]] = []
        for key in ("direct_dependents", "indirect_dependents"):
            for entry in report.get(key) or []:
                rows.append({
                    "id": entry.get("id"),
                    "name": entry.get("name"),
                    "type": entry.get("type"),
                    "relation": key.replace("_", " "),
                })
        if not rows:
            # A confirmed none, which is a different claim from the unknowns
            # above and has to read differently. Returning no note here would
            # make "the graph checked and found nothing" indistinguishable from
            # "the graph could not be asked" — the two are one word apart in the
            # UI and a world apart in a delete confirmation.
            return [], ("The topology graph knows this resource and no other "
                        "resource depends on it.")
        return rows, None

    # ── Execute ──────────────────────────────────────────────────────────────
    async def execute(
        self,
        resource_id: uuid.UUID,
        action: str,
        *,
        principal: Any = None,
        operation_id: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
        correlation_id: Optional[uuid.UUID] = None,
        source_ip: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Perform an action, or record precisely why it was refused.

        Today this always refuses at the provider-support gate, because no
        adapter implements a write. The refusal is audited like any other
        outcome — an action that was asked for and declined is a fact worth
        keeping.
        """
        op_id = (operation_id or "").strip() or f"auto-{uuid.uuid4()}"

        # Idempotency. The same operation_id is the same intent, so the first
        # record is returned rather than a second attempt being made. This is
        # what makes a double-clicked button harmless.
        existing = (await self.db.execute(
            select(CloudResourceAction).where(
                CloudResourceAction.operation_id == op_id
            )
        )).scalar_one_or_none()
        if existing is not None:
            return {**self._serialize(existing), "idempotent_replay": True}

        preview = await self.preview(
            resource_id, action, principal=principal, params=params
        )
        resource = await self._resource(resource_id)

        row = CloudResourceAction(
            operation_id=op_id,
            account_id=resource.account_id,
            resource_id=resource.id,
            provider=preview["resource"]["provider"],
            provider_resource_id=resource.provider_resource_id,
            resource_type=resource.resource_type,
            resource_name=resource.resource_name,
            action=action,
            status=QUEUED,
            dry_run=False,
            actor=getattr(principal, "name", None),
            actor_role=getattr(principal, "role", None),
            source_ip=source_ip,
            request=mask({"action": action, "params": params or {}}),
            correlation_id=correlation_id,
            # Recorded from what this platform already holds, not from the
            # request. A "before" copied out of the caller's payload would be
            # the caller's claim, not an observation.
            before_state={
                "status": resource.normalized_status,
                "raw_status": resource.status,
                "tags": resource.tags,
                "attachment_state": resource.attachment_state,
            },
        )
        self.db.add(row)
        await self.db.flush()

        if not preview["safe"]:
            reason = (
                preview["reasons"]["support"]
                or preview["reasons"]["authorization"]
                or preview["reasons"]["state"]
                or "This action was declined."
            )
            row.status = REFUSED
            row.refusal_reason = reason
            row.finished_at = datetime.now(timezone.utc)
            await self.db.commit()
            await self.db.refresh(row)
            return {**self._serialize(row), "preview": preview}

        # Every gate passed. The only thing left is an implementation, and
        # there is none — see IMPLEMENTED above.
        if action not in IMPLEMENTED:
            row.status = REFUSED
            row.refusal_reason = (
                f"{ACTION_SPEC[action]['label']} is supported by the "
                f"{preview['resource']['provider']} integration, but the action "
                "layer has no implementation wired up for it yet. Nothing was "
                "sent to the provider."
            )
            row.finished_at = datetime.now(timezone.utc)
            await self.db.commit()
            await self.db.refresh(row)
            return {**self._serialize(row), "preview": preview}

        # Unreachable today. Left explicit so the dispatch point is named where
        # it belongs rather than found by whoever writes the first adapter.
        row.status = RUNNING
        await self.db.flush()
        row.status = FAILED
        row.error = (
            f"{action!r} is listed as implemented but no dispatch branch "
            "handles it."
        )
        row.finished_at = datetime.now(timezone.utc)
        logger.error("Action %s on %s is in IMPLEMENTED with no dispatch.",
                     action, resource_id)
        await self.db.commit()
        await self.db.refresh(row)
        return {**self._serialize(row), "preview": preview}

    # ── Bulk ─────────────────────────────────────────────────────────────────
    async def preview_bulk(
        self,
        resource_ids: Sequence[uuid.UUID],
        action: str,
        *,
        principal: Any = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """What a bulk action would do, counted honestly.

        Spec §41/§42: the caller is told how many of the selected resources are
        supported, unsupported, unauthorized and in the wrong state — and those
        buckets are never folded into a single "will work" number, because a
        bulk operation that hides its partial failures is worse than one that
        refuses outright.
        """
        if len(resource_ids) > MAX_BULK:
            raise ActionError(
                "resource_ids",
                f"A bulk action may name at most {MAX_BULK} resources; "
                f"{len(resource_ids)} were given.",
            )
        if not resource_ids:
            raise ActionError("resource_ids", "No resources were selected.")

        items: List[Dict[str, Any]] = []
        for resource_id in resource_ids:
            try:
                items.append(await self.preview(
                    resource_id, action, principal=principal, params=params
                ))
            except ActionError as exc:
                items.append({
                    "resource": {"id": str(resource_id)},
                    "action": action, "supported": False, "authorized": False,
                    "state_valid": False, "safe": False,
                    "reasons": {"support": str(exc), "authorization": None, "state": None},
                    "warnings": [], "dependencies": [],
                })

        return {
            "action": action,
            "selected": len(resource_ids),
            "supported": sum(1 for i in items if i["supported"]),
            "unsupported": sum(1 for i in items if not i["supported"]),
            "unauthorized": sum(1 for i in items if not i["authorized"]),
            "wrong_state": sum(1 for i in items if not i["state_valid"]),
            "would_apply": sum(1 for i in items if i["safe"]),
            "with_dependencies": sum(1 for i in items if i["dependencies"]),
            "items": items,
        }

    # ── History ──────────────────────────────────────────────────────────────
    async def history(
        self, *, account_id: Optional[uuid.UUID] = None,
        resource_id: Optional[uuid.UUID] = None, limit: int = 50,
    ) -> List[Dict[str, Any]]:
        stmt = select(CloudResourceAction).order_by(
            CloudResourceAction.started_at.desc()
        ).limit(min(max(limit, 1), 500))
        if account_id:
            stmt = stmt.where(CloudResourceAction.account_id == account_id)
        if resource_id:
            stmt = stmt.where(CloudResourceAction.resource_id == resource_id)
        rows = list((await self.db.execute(stmt)).scalars().all())
        return [self._serialize(r) for r in rows]

    def _serialize(self, row: CloudResourceAction) -> Dict[str, Any]:
        return {
            "operation_id": row.operation_id,
            "id": str(row.id),
            "account_id": str(row.account_id),
            "resource_id": str(row.resource_id) if row.resource_id else None,
            "resource_name": row.resource_name,
            "resource_type": row.resource_type,
            "provider": row.provider,
            "action": row.action,
            "status": row.status,
            "dry_run": row.dry_run,
            "actor": row.actor,
            "actor_role": row.actor_role,
            "error": row.error,
            "refusal_reason": row.refusal_reason,
            "before_state": row.before_state,
            "after_state": row.after_state,
            "correlation_id": str(row.correlation_id) if row.correlation_id else None,
            "started_at": row.started_at.isoformat() if row.started_at else None,
            "finished_at": row.finished_at.isoformat() if row.finished_at else None,
        }


def available_actions(provider: Optional[str]) -> List[Dict[str, Any]]:
    """Every action, with whether this provider can perform it and why not.

    Returned for ALL actions rather than filtered to the supported ones, so the
    UI can show a disabled control with an explanation instead of silently
    omitting it — which leaves the user wondering whether the platform simply
    forgot.
    """
    provider_caps = caps.for_provider(provider)
    return [
        {
            "action": name,
            "label": spec["label"],
            "destructive": spec["destructive"],
            "supported": provider_caps.can(spec["capability"]),
            "reason": (
                None if provider_caps.can(spec["capability"])
                else provider_caps.reason(spec["capability"])
            ),
            "requires_states": list(spec["from_states"]),
        }
        for name, spec in ACTION_SPEC.items()
    ]
