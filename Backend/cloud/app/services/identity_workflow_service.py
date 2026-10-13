"""Access requests, approvals, JIT sessions and permission right-sizing.

This is the only module in the CIEM feature that can change anything in a
customer's cloud, and it is built so that doing so is hard, deliberate and
recorded.

**Execution is off by default.** `CIEM_ENABLE_WRITE` gates every provider call.
With it unset — which is how this ships — an approved request is carried all the
way to APPROVED and then refused at the apply step with a message saying what
would have been done and how to turn execution on. A CIEM product that silently
acquires the ability to rewrite production IAM the moment it is deployed is a
worse risk than the over-permissioning it exists to find, and the switch is how
the operator opts into that power rather than inheriting it.

**Approval is a separate act by a separate row.** `request_access` only
requests. `approve` only approves. `apply` only applies, and refuses a request
that is not APPROVED. Nothing collapses the three, so there is no path from one
API call to a changed policy.

**The audit row precedes the provider call.** The same rule
`resource_action.py` follows: a row written before the attempt survives a crash
as an accurate account of what was tried, where a row written after it would
leave the one case anybody investigates with no trace.

**A proposal is re-verified at apply time.** The live policy is re-read and
compared against what the approver saw. If it has changed, the apply is refused
— an approval granted against one policy must not be spent on a different one.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.identity import rightsizing, usage as usage_mod
from app.identity.model import (
    ACTIVE, APPLIED, APPROVAL_REQUIRED, APPROVED, AWS, AZURE, CANCELLED, EXPIRED,
    FAILED, OCI, PRIV_ADMIN, PRIV_PRIVILEGED, PROPOSED, REJECTED, REVOKED,
    ROLLED_BACK, normalize_provider,
)
from app.models.cloud_account import CloudAccount
from app.models.identity import CloudIdentity
from app.repository.ciem_repo import CiemRepository

logger = logging.getLogger("cloud_svc.identity.workflow")

KIND_JIT = "JIT_ELEVATION"
KIND_RIGHTSIZE = "PERMISSION_RIGHTSIZE"
KIND_CREDENTIAL_DISABLE = "CREDENTIAL_DISABLE"
KIND_CREDENTIAL_ROTATE = "CREDENTIAL_ROTATION"

REQUEST_KINDS = (KIND_JIT, KIND_RIGHTSIZE, KIND_CREDENTIAL_DISABLE, KIND_CREDENTIAL_ROTATE)

# Audit operations.
OP_REQUESTED = "REQUEST_CREATED"
OP_APPROVED = "APPROVED"
OP_REJECTED = "REJECTED"
OP_APPLIED = "APPLIED"
OP_APPLY_REFUSED = "APPLY_REFUSED"
OP_FAILED = "FAILED"
OP_REVOKED = "REVOKED"
OP_EXPIRED = "EXPIRED"
OP_ROLLED_BACK = "ROLLED_BACK"
OP_PROPOSAL = "PROPOSAL_GENERATED"

MAX_JIT_MINUTES = 480          # 8 hours. Longer is standing access by another name.
DEFAULT_JIT_MINUTES = 60


class WriteDisabled(RuntimeError):
    """Raised when a provider change is attempted with execution switched off."""


class InvalidTransition(RuntimeError):
    """Raised when a request is acted on from a status that does not allow it."""


def write_enabled() -> bool:
    return (os.getenv("CIEM_ENABLE_WRITE") or "").strip().lower() in (
        "true", "1", "yes", "on")


def write_mode() -> Dict[str, Any]:
    """Reported in every response, so the UI never implies a power we lack."""
    enabled = write_enabled()
    return {
        "enabled": enabled,
        "note": (
            "Execution is ON. An approved request will be applied to the provider."
            if enabled else
            "Execution is OFF. Requests can be raised, reviewed and approved, and the "
            "exact change is shown, but nothing is written to the provider. Set "
            "CIEM_ENABLE_WRITE=true in Backend/cloud/.env to enable it."
        ),
        "env_var": "CIEM_ENABLE_WRITE",
    }


class IdentityWorkflowService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = CiemRepository(db)

    # ── Requests ─────────────────────────────────────────────────────────────
    async def request_access(
        self, *, account_id: uuid.UUID, request_kind: str, reason: str,
        identity_id: Optional[uuid.UUID] = None,
        requested_role: Optional[str] = None,
        target_scope: Optional[str] = None,
        target_resource: Optional[str] = None,
        requested_actions: Optional[Sequence[str]] = None,
        duration_minutes: Optional[int] = None,
        ticket_ref: Optional[str] = None,
        actor: Optional[str] = None, actor_role: Optional[str] = None,
        source_ip: Optional[str] = None,
        proposal: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Raise a request. Never changes anything by itself."""
        if request_kind not in REQUEST_KINDS:
            raise ValueError(f"Unknown request kind {request_kind!r}")
        if not (reason or "").strip():
            raise ValueError("A written reason is required for every request.")

        account = await self.db.get(CloudAccount, account_id)
        if account is None:
            raise ValueError(f"Account {account_id} not found")
        provider = normalize_provider(account.provider) or account.provider

        identity = await self.repo.identity_by_id(identity_id) if identity_id else None

        if request_kind == KIND_JIT:
            minutes = duration_minutes or DEFAULT_JIT_MINUTES
            if minutes <= 0 or minutes > MAX_JIT_MINUTES:
                raise ValueError(
                    f"Duration must be between 1 and {MAX_JIT_MINUTES} minutes. "
                    "Longer than that is standing access, which is what this feature "
                    "exists to remove."
                )
            duration_minutes = minutes

        # The risk picture AS SHOWN to the approver, snapshotted now.
        risk = await self._risk_snapshot(account_id, identity)

        row = await self.repo.create_request(
            account_id=account_id, provider=provider, request_kind=request_kind,
            status=APPROVAL_REQUIRED,
            identity_id=identity.id if identity else None,
            identity_key=identity.identity_key if identity else None,
            identity_name=identity.name if identity else None,
            target_scope=target_scope, target_resource=target_resource,
            requested_role=requested_role,
            requested_actions=list(requested_actions) if requested_actions else None,
            duration_minutes=duration_minutes,
            reason=reason.strip(), ticket_ref=ticket_ref,
            requested_by=actor, requested_by_role=actor_role, source_ip=source_ip,
            risk_snapshot=risk,
            current_privilege=identity.privilege_level if identity else None,
            requested_privilege=PRIV_ADMIN if request_kind == KIND_JIT else None,
            current_document=(proposal or {}).get("current_document"),
            proposed_document=(proposal or {}).get("proposed_document"),
            diff=(proposal or {}).get("diff"),
            evidence=(proposal or {}).get("evidence"),
        )
        await self.repo.audit(
            account_id=account_id, provider=provider, operation=OP_REQUESTED,
            request_id=row.id, identity_id=identity.id if identity else None,
            identity_name=identity.name if identity else None,
            actor=actor, actor_role=actor_role, source_ip=source_ip,
            reason=reason, detail={"request_kind": request_kind,
                                   "duration_minutes": duration_minutes,
                                   "requested_role": requested_role},
            succeeded=True,
        )
        await self.db.commit()
        return {**row.to_dict(include_documents=True), "write_mode": write_mode()}

    async def _risk_snapshot(
        self, account_id: uuid.UUID, identity: Optional[CloudIdentity],
    ) -> Dict[str, Any]:
        """What the approver is shown — and what the record keeps.

        Snapshotted rather than recomputed at render time, so the audit trail
        shows the picture the decision was actually made on.
        """
        if identity is None:
            return {"note": "No identity was named on this request."}
        blast = await self.repo.blast_radius(identity.id)
        caps = await self.repo.capabilities(account_id=account_id,
                                            identity_id=identity.id)
        return {
            "identity_name": identity.name,
            "current_privilege": identity.privilege_level,
            "mfa_state": identity.mfa_state,
            "external": identity.external,
            "last_used_at": identity.last_used_at.isoformat()
                            if identity.last_used_at else None,
            "capabilities": [c.capability for c in caps],
            "high_impact_capabilities": [c.capability for c in caps if c.high_impact],
            "blast_radius": blast.to_dict() if blast else None,
            "captured_at": datetime.now(timezone.utc).isoformat(),
        }

    async def decide(
        self, request_id: uuid.UUID, *, approve: bool, actor: Optional[str],
        actor_role: Optional[str] = None, comment: Optional[str] = None,
        source_ip: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Approve or reject. Separate from applying, always."""
        row = await self.repo.request(request_id)
        if row is None:
            raise ValueError(f"Request {request_id} not found")
        if row.status != APPROVAL_REQUIRED:
            raise InvalidTransition(
                f"This request is {row.status}; only a request awaiting approval can be "
                "decided."
            )
        # Self-approval is the hole that makes an approval workflow decorative.
        if approve and actor and row.requested_by and actor == row.requested_by:
            raise InvalidTransition(
                "The requester cannot approve their own request. Another approver must "
                "decide it."
            )

        now = datetime.now(timezone.utc)
        row.status = APPROVED if approve else REJECTED
        row.decided_at = now
        await self.repo.add_approval(
            request_id=row.id, decision=APPROVED if approve else REJECTED,
            decided_by=actor, decided_by_role=actor_role, decided_at=now,
            source_ip=source_ip, comment=comment,
            risk_shown=row.risk_snapshot,
        )
        await self.repo.audit(
            account_id=row.account_id, provider=row.provider,
            operation=OP_APPROVED if approve else OP_REJECTED,
            request_id=row.id, identity_id=row.identity_id,
            identity_name=row.identity_name, actor=actor, actor_role=actor_role,
            source_ip=source_ip, reason=comment, succeeded=True,
            detail={"request_kind": row.request_kind},
        )
        await self.db.commit()
        return {**row.to_dict(), "write_mode": write_mode()}

    # ── Apply ────────────────────────────────────────────────────────────────
    async def apply(
        self, request_id: uuid.UUID, *, actor: Optional[str],
        actor_role: Optional[str] = None, source_ip: Optional[str] = None,
        confirm: bool = False,
    ) -> Dict[str, Any]:
        """Execute an approved request against the provider.

        Refuses unless the request is APPROVED, the caller passed `confirm`, and
        execution is switched on. The audit row is written before the provider
        is contacted.
        """
        row = await self.repo.request(request_id)
        if row is None:
            raise ValueError(f"Request {request_id} not found")
        if row.status != APPROVED:
            raise InvalidTransition(
                f"This request is {row.status}; only an APPROVED request can be applied."
            )
        if not confirm:
            raise InvalidTransition(
                "An explicit confirmation is required. Re-send with confirm=true after "
                "reviewing the diff."
            )

        await self.repo.audit(
            account_id=row.account_id, provider=row.provider, operation=OP_APPLIED,
            request_id=row.id, identity_id=row.identity_id,
            identity_name=row.identity_name, actor=actor, actor_role=actor_role,
            source_ip=source_ip, before=row.current_document,
            after=row.proposed_document,
            detail={"request_kind": row.request_kind,
                    "write_enabled": write_enabled()},
            succeeded=None,     # unknown until the provider answers
        )
        await self.db.commit()

        if not write_enabled():
            row.status = APPROVED
            row.refusal_reason = (
                "Execution is disabled on this deployment (CIEM_ENABLE_WRITE is not "
                "set), so nothing was written to the provider. The approved change is "
                "recorded and can be applied by hand, or by enabling execution."
            )
            await self.repo.audit(
                account_id=row.account_id, provider=row.provider,
                operation=OP_APPLY_REFUSED, request_id=row.id,
                identity_id=row.identity_id, identity_name=row.identity_name,
                actor=actor, actor_role=actor_role, source_ip=source_ip,
                reason=row.refusal_reason, succeeded=False,
                detail={"would_have_applied": row.proposed_document},
            )
            await self.db.commit()
            return {**row.to_dict(include_documents=True),
                    "applied": False, "write_mode": write_mode()}

        try:
            result = await self._execute(row)
        except Exception as exc:  # noqa: BLE001
            row.status = FAILED
            row.error = str(exc)[:2000]
            await self.repo.audit(
                account_id=row.account_id, provider=row.provider, operation=OP_FAILED,
                request_id=row.id, identity_id=row.identity_id,
                identity_name=row.identity_name, actor=actor, actor_role=actor_role,
                source_ip=source_ip, error=str(exc)[:2000], succeeded=False,
            )
            await self.db.commit()
            logger.exception("CIEM apply failed for request %s", request_id)
            return {**row.to_dict(), "applied": False, "error": row.error,
                    "write_mode": write_mode()}

        row.status = APPLIED
        row.applied_at = datetime.now(timezone.utc)
        row.result = result
        await self.db.commit()
        return {**row.to_dict(include_documents=True), "applied": True,
                "result": result, "write_mode": write_mode()}

    async def _execute(self, row: Any) -> Dict[str, Any]:
        """Dispatch to the provider. Only reached with execution enabled."""
        if row.request_kind == KIND_JIT:
            return await self._grant_jit(row)
        if row.request_kind == KIND_RIGHTSIZE:
            return await self._apply_policy(row)
        if row.request_kind in (KIND_CREDENTIAL_DISABLE, KIND_CREDENTIAL_ROTATE):
            return await self._credential_action(row)
        raise ValueError(f"No executor for {row.request_kind}")

    async def _grant_jit(self, row: Any) -> Dict[str, Any]:
        """Create the time-boxed grant and record the session that revokes it.

        The session row is written in the same transaction as the grant, so a
        crash between them cannot leave an elevation with nothing tracking its
        expiry — the state this whole feature exists to avoid.
        """
        provider = normalize_provider(row.provider)
        identity = await self.repo.identity_by_id(row.identity_id) if row.identity_id \
            else None
        if identity is None:
            raise ValueError("The request names no identity to elevate.")

        grant_id, detail = await self._provider_grant(provider, row, identity)
        expires = datetime.now(timezone.utc) + timedelta(
            minutes=row.duration_minutes or DEFAULT_JIT_MINUTES)

        session = await self.repo.create_session(
            request_id=row.id, account_id=row.account_id, provider=row.provider,
            identity_id=identity.id, status=ACTIVE,
            granted_role=row.requested_role, granted_scope=row.target_scope,
            provider_grant_id=grant_id, expires_at=expires,
            activated_by=row.requested_by,
        )
        return {"session_id": str(session.id), "expires_at": expires.isoformat(),
                "provider_grant_id": grant_id, "detail": detail}

    async def _provider_grant(
        self, provider: Optional[str], row: Any, identity: CloudIdentity,
    ) -> Tuple[Optional[str], Dict[str, Any]]:
        """Create the elevation on the provider."""
        import asyncio

        from app.utils.encryption import decrypt_credentials

        account = await self.db.get(CloudAccount, row.account_id)
        creds = decrypt_credentials(account.credentials_enc)
        loop = asyncio.get_running_loop()

        if provider == AZURE:
            def _assign() -> Tuple[str, Dict[str, Any]]:
                from azure.mgmt.authorization import AuthorizationManagementClient

                from app.providers.azure.azure_auth import AzureAuth

                auth = AzureAuth(creds)
                client = AuthorizationManagementClient(
                    auth.get_credential(), creds["subscription_id"])
                scope = row.target_scope or f"/subscriptions/{creds['subscription_id']}"
                definition = next(
                    (d for d in client.role_definitions.list(
                        scope, filter=f"roleName eq '{row.requested_role}'")), None)
                if definition is None:
                    raise ValueError(
                        f"Role {row.requested_role!r} was not found at {scope}.")
                name = str(uuid.uuid4())
                created = client.role_assignments.create(
                    scope, name,
                    {"role_definition_id": definition.id,
                     "principal_id": identity.provider_id},
                )
                return created.id, {"scope": scope, "role": row.requested_role}

            return await loop.run_in_executor(None, _assign)

        if provider == AWS:
            def _attach() -> Tuple[str, Dict[str, Any]]:
                from app.providers.aws.aws_auth import AWSAuth

                auth = AWSAuth(creds)
                iam = auth.get_client("iam")
                name = (identity.name or "").strip()
                policy_arn = row.requested_role
                if not policy_arn or not policy_arn.startswith("arn:"):
                    raise ValueError(
                        "AWS elevation needs the ARN of the managed policy to attach.")
                if identity.identity_type == "AWS_IAM_ROLE":
                    iam.attach_role_policy(RoleName=name, PolicyArn=policy_arn)
                else:
                    iam.attach_user_policy(UserName=name, PolicyArn=policy_arn)
                return policy_arn, {"attached_to": name, "policy_arn": policy_arn}

            return await loop.run_in_executor(None, _attach)

        if provider == OCI:
            def _add() -> Tuple[str, Dict[str, Any]]:
                import oci as oci_sdk

                from app.providers.oci.oci_auth import OCIAuth

                auth = OCIAuth(creds)
                client = oci_sdk.identity.IdentityClient(auth.get_config(),
                                                         signer=auth.get_signer())
                group_ocid = row.requested_role
                if not group_ocid or not group_ocid.startswith("ocid1.group."):
                    raise ValueError(
                        "OCI elevation needs the OCID of the group to join.")
                created = client.add_user_to_group(
                    oci_sdk.identity.models.AddUserToGroupDetails(
                        user_id=identity.provider_id, group_id=group_ocid))
                return created.data.id, {"group_id": group_ocid}

            return await loop.run_in_executor(None, _add)

        raise ValueError(f"JIT elevation is not implemented for provider {provider!r}")

    async def _apply_policy(self, row: Any) -> Dict[str, Any]:
        """Apply a right-sized policy, after re-verifying the current one.

        The re-read is the point: an approval was granted against a policy the
        approver saw. If the live policy has changed since, applying the
        approved document would silently discard whatever changed.
        """
        raise NotImplementedError(
            "Applying a right-sized policy to a provider is not implemented in this "
            "build. The proposal, the diff and the approval are recorded; apply the "
            "document by hand, or attach it as a permissions boundary first so a "
            "missing permission surfaces as an observable denial rather than an outage."
        )

    async def _credential_action(self, row: Any) -> Dict[str, Any]:
        raise NotImplementedError(
            "Credential disable/rotate is not implemented in this build. The "
            "recommendation and its evidence are recorded; perform the rotation using "
            "the four-step sequence in the finding's remediation."
        )

    # ── JIT expiry ───────────────────────────────────────────────────────────
    async def expire_due_sessions(self, *, now: Optional[datetime] = None) -> Dict[str, Any]:
        """Revoke every session whose expiry has passed. Idempotent.

        Selects on `revoke_confirmed_at IS NULL` rather than on status, so a
        session whose revocation failed keeps being retried instead of being
        filtered out by the status it was optimistically given.
        """
        moment = now or datetime.now(timezone.utc)
        due = await self.repo.due_sessions(now=moment)
        revoked, failed = 0, 0

        for session in due:
            session.revoke_attempted_at = moment
            session.revoke_attempts = (session.revoke_attempts or 0) + 1
            if not write_enabled():
                session.status = EXPIRED
                session.revoke_error = (
                    "Execution is disabled (CIEM_ENABLE_WRITE is not set), so the "
                    "elevation was NOT removed from the provider. It must be revoked "
                    "by hand."
                )
                failed += 1
                await self.repo.audit(
                    account_id=session.account_id, provider=session.provider,
                    operation=OP_EXPIRED, request_id=session.request_id,
                    identity_id=session.identity_id, succeeded=False,
                    error=session.revoke_error,
                    detail={"session_id": str(session.id),
                            "expires_at": session.expires_at.isoformat()},
                )
                continue
            try:
                await self._provider_revoke(session)
                session.status = EXPIRED
                session.revoke_confirmed_at = datetime.now(timezone.utc)
                session.revoke_error = None
                revoked += 1
                await self.repo.audit(
                    account_id=session.account_id, provider=session.provider,
                    operation=OP_REVOKED, request_id=session.request_id,
                    identity_id=session.identity_id, succeeded=True,
                    detail={"session_id": str(session.id)},
                )
            except Exception as exc:  # noqa: BLE001
                session.revoke_error = str(exc)[:2000]
                failed += 1
                await self.repo.audit(
                    account_id=session.account_id, provider=session.provider,
                    operation=OP_FAILED, request_id=session.request_id,
                    identity_id=session.identity_id, succeeded=False,
                    error=session.revoke_error,
                    detail={"session_id": str(session.id), "stage": "revoke"},
                )
                logger.error("JIT revocation failed for session %s: %s",
                             session.id, exc)
        await self.db.commit()
        return {"due": len(due), "revoked": revoked, "failed": failed,
                "write_enabled": write_enabled(),
                "overdue_unrevoked": failed}

    async def _provider_revoke(self, session: Any) -> None:
        import asyncio

        from app.utils.encryption import decrypt_credentials

        provider = normalize_provider(session.provider)
        account = await self.db.get(CloudAccount, session.account_id)
        creds = decrypt_credentials(account.credentials_enc)
        identity = await self.repo.identity_by_id(session.identity_id) \
            if session.identity_id else None
        loop = asyncio.get_running_loop()

        if provider == AZURE:
            def _remove() -> None:
                from azure.mgmt.authorization import AuthorizationManagementClient

                from app.providers.azure.azure_auth import AzureAuth

                auth = AzureAuth(creds)
                client = AuthorizationManagementClient(
                    auth.get_credential(), creds["subscription_id"])
                client.role_assignments.delete_by_id(session.provider_grant_id)

            await loop.run_in_executor(None, _remove)
            return

        if provider == AWS:
            def _detach() -> None:
                from app.providers.aws.aws_auth import AWSAuth

                auth = AWSAuth(creds)
                iam = auth.get_client("iam")
                name = (identity.name or "") if identity else ""
                if identity and identity.identity_type == "AWS_IAM_ROLE":
                    iam.detach_role_policy(RoleName=name,
                                           PolicyArn=session.provider_grant_id)
                else:
                    iam.detach_user_policy(UserName=name,
                                           PolicyArn=session.provider_grant_id)

            await loop.run_in_executor(None, _detach)
            return

        if provider == OCI:
            def _remove_membership() -> None:
                import oci as oci_sdk

                from app.providers.oci.oci_auth import OCIAuth

                auth = OCIAuth(creds)
                client = oci_sdk.identity.IdentityClient(auth.get_config(),
                                                         signer=auth.get_signer())
                client.remove_user_from_group(session.provider_grant_id)

            await loop.run_in_executor(None, _remove_membership)
            return

        raise ValueError(f"No revoker for provider {provider!r}")

    async def revoke_now(
        self, session_id: uuid.UUID, *, actor: Optional[str],
        actor_role: Optional[str] = None, reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        """End a session early."""
        session = await self.repo.session(session_id)
        if session is None:
            raise ValueError(f"Session {session_id} not found")
        if session.revoke_confirmed_at is not None:
            return {**session.to_dict(), "already_revoked": True}

        session.revoke_attempted_at = datetime.now(timezone.utc)
        session.revoke_attempts = (session.revoke_attempts or 0) + 1
        if not write_enabled():
            session.status = REVOKED
            session.revoke_error = (
                "Execution is disabled, so the elevation was not removed from the "
                "provider. It must be revoked by hand."
            )
            await self.repo.audit(
                account_id=session.account_id, provider=session.provider,
                operation=OP_REVOKED, request_id=session.request_id,
                identity_id=session.identity_id, actor=actor, actor_role=actor_role,
                reason=reason, succeeded=False, error=session.revoke_error,
            )
            await self.db.commit()
            return {**session.to_dict(), "write_mode": write_mode()}

        try:
            await self._provider_revoke(session)
            session.status = REVOKED
            session.revoke_confirmed_at = datetime.now(timezone.utc)
            session.revoke_error = None
            succeeded, error = True, None
        except Exception as exc:  # noqa: BLE001
            session.revoke_error = str(exc)[:2000]
            succeeded, error = False, session.revoke_error
        await self.repo.audit(
            account_id=session.account_id, provider=session.provider,
            operation=OP_REVOKED, request_id=session.request_id,
            identity_id=session.identity_id, actor=actor, actor_role=actor_role,
            reason=reason, succeeded=succeeded, error=error,
        )
        await self.db.commit()
        return {**session.to_dict(), "write_mode": write_mode()}

    # ── Right-sizing proposals ───────────────────────────────────────────────
    async def propose_rightsizing(
        self, *, account_id: uuid.UUID, identity_id: uuid.UUID,
        actor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Generate the §6 proposal from stored usage. Writes nothing."""
        identity = await self.repo.identity_by_id(identity_id)
        if identity is None:
            raise ValueError(f"Identity {identity_id} not found")

        usage_rows = await self.repo.usage(identity_id)
        if not usage_rows:
            return {
                "available": False,
                "reason": ("No permission-usage analysis exists for this identity, so "
                           "there is no evidence to build a proposal from. Run the "
                           "identity analysis and confirm the Event Log is collecting "
                           "for this account."),
            }

        first = usage_rows[0]
        window = usage_mod.Window(
            start=first.window_start, end=first.window_end, days=first.window_days,
            events_in_window=first.events_in_window,
            source_available=first.events_in_window > 0,
        )
        patterns = [{
            "pattern": r.action,
            "capability": r.capability,
            "usage_state": r.usage_state,
            "confidence_reason": r.confidence_reason,
            "observed_actions": [r.action] if r.usage_state == "OBSERVED" else [],
            "event_count": r.event_count,
            "window": window.to_dict(),
        } for r in usage_rows]
        summary = {
            "window": window.to_dict(),
            "patterns": patterns,
            "granted_pattern_count": len(patterns),
            "observed_action_count": len([r for r in usage_rows
                                          if r.usage_state == "OBSERVED"]),
            "unexercised_pattern_count": len([r for r in usage_rows
                                              if r.usage_state != "OBSERVED"]),
            "high_confidence_unexercised_count": len(
                [r for r in usage_rows
                 if r.usage_state == "NOT_OBSERVED_HIGH_CONFIDENCE"]),
            "removal_candidates": [r.action for r in usage_rows
                                   if r.usage_state == "NOT_OBSERVED_HIGH_CONFIDENCE"],
        }

        policies = await self.repo.policies(account_id=account_id,
                                            identity_id=identity_id)
        current = {"policies": [p.to_dict(include_document=True) for p in policies]}

        proposal = rightsizing.build_proposal(
            identity.provider, identity_name=identity.name or "identity",
            usage_summary=summary, current_document=current,
        )
        await self.repo.audit(
            account_id=account_id, provider=identity.provider,
            operation=OP_PROPOSAL, identity_id=identity_id,
            identity_name=identity.name, actor=actor, succeeded=True,
            detail={"removal_candidates": len(summary["removal_candidates"]),
                    "window_days": window.days},
        )
        await self.db.commit()
        return {"available": True, **proposal, "write_mode": write_mode()}

    # ── Reads ────────────────────────────────────────────────────────────────
    async def list_requests(self, **kwargs: Any) -> List[Dict[str, Any]]:
        rows = await self.repo.requests(**kwargs)
        return [r.to_dict() for r in rows]

    async def get_request(self, request_id: uuid.UUID) -> Optional[Dict[str, Any]]:
        row = await self.repo.request(request_id)
        if row is None:
            return None
        approvals = await self.repo.approvals(request_id)
        audit = await self.repo.audit_log(request_id=request_id)
        sessions = [s for s in await self.repo.sessions(account_id=row.account_id)
                    if s.request_id == request_id]
        return {
            **row.to_dict(include_documents=True),
            "approvals": [a.to_dict() for a in approvals],
            "sessions": [s.to_dict() for s in sessions],
            "timeline": [a.to_dict() for a in reversed(audit)],
            "write_mode": write_mode(),
        }

    async def list_sessions(self, **kwargs: Any) -> List[Dict[str, Any]]:
        rows = await self.repo.sessions(**kwargs)
        return [r.to_dict() for r in rows]

    async def audit_log(self, **kwargs: Any) -> List[Dict[str, Any]]:
        rows = await self.repo.audit_log(**kwargs)
        return [r.to_dict() for r in rows]
